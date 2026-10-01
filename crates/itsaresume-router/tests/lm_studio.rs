//! `LmStudioBackend` over real HTTP, against a one-shot fake server on
//! 127.0.0.1 that serves the bodies LM Studio was observed to return
//! (`tests/fixtures/lm-studio/`) and records the request it received.

mod support;

use itsaresume_router::lm_studio::LmStudioBackend;
use itsaresume_router::{Backend, BackendError, Completion, Request};
use std::net::TcpListener;
use std::thread;
use std::time::{Duration, Instant};
use support::serve;

const SUCCESS: &str = include_str!("fixtures/lm-studio/observed-success.json");
const NO_MODELS_LOADED: &str = include_str!("fixtures/lm-studio/observed-no-models-loaded.json");
const INVALID_JSON: &str = include_str!("fixtures/lm-studio/observed-invalid-json.json");

fn backend(base_url: &str) -> LmStudioBackend {
    LmStudioBackend::new(base_url, "example-model").with_timeout(Duration::from_secs(10))
}

fn kind(outcome: &Result<Completion, BackendError>) -> &'static str {
    match outcome {
        Ok(_) => "success",
        Err(error) => error.kind(),
    }
}

#[test]
fn the_observed_success_is_an_answer() {
    let (base_url, _) = serve(200, SUCCESS);
    assert_eq!(
        backend(&base_url).complete(&Request::new("hi")),
        Ok(Completion {
            text: "Hello!".into(),
            rate_limit: None,
        })
    );
}

/// An OpenAI-compatible call with **no credential**: pointing this backend at
/// a paid provider can only produce a 401, never a bill.
#[test]
fn the_request_is_a_chat_completion_without_any_credential() {
    let (base_url, received) = serve(200, SUCCESS);
    let request = Request {
        prompt: "Write a summary.".into(),
        system: Some("You write CVs.".into()),
        schema: None,
        kind: Default::default(),
    };

    backend(&base_url)
        .complete(&request)
        .expect("the fake answers");

    let received = received.recv().expect("the server saw the request");
    assert_eq!(received.request_line, "POST /v1/chat/completions HTTP/1.1");
    for (name, _) in &received.headers {
        assert!(
            name != "authorization" && name != "x-api-key" && name != "api-key",
            "a credential header was sent: {name}"
        );
    }
    assert_eq!(received.body["model"], "example-model");
    assert_eq!(received.body["stream"], false);
    assert_eq!(received.body["messages"][0]["role"], "system");
    assert_eq!(received.body["messages"][0]["content"], "You write CVs.");
    assert_eq!(received.body["messages"][1]["role"], "user");
    assert_eq!(received.body["messages"][1]["content"], "Write a summary.");
}

#[test]
fn without_a_system_prompt_only_the_user_message_is_sent() {
    let (base_url, received) = serve(200, SUCCESS);

    backend(&base_url)
        .complete(&Request::new("hi"))
        .expect("the fake answers");

    let body = received.recv().expect("request").body;
    let messages = body["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["role"], "user");
}

/// Observed: a server with no model loaded answers 400. That is the
/// backend's state (the XPS rebooted, nothing loaded), not the request's.
#[test]
fn the_observed_no_models_loaded_is_unreachable() {
    let (base_url, _) = serve(400, NO_MODELS_LOADED);
    let outcome = backend(&base_url).complete(&Request::new("hi"));
    assert_eq!(kind(&outcome), "unreachable", "{outcome:?}");
}

#[test]
fn a_refused_connection_is_unreachable() {
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.local_addr().expect("address").port()
    };
    let outcome = backend(&format!("http://127.0.0.1:{port}/v1")).complete(&Request::new("hi"));
    assert_eq!(kind(&outcome), "unreachable", "{outcome:?}");
}

#[test]
fn a_server_that_does_not_answer_in_time_is_unreachable() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let base_url = format!("http://{}/v1", listener.local_addr().expect("address"));
    thread::spawn(move || {
        let (_stream, _) = listener.accept().expect("one connection");
        thread::sleep(Duration::from_secs(10));
    });
    let started = Instant::now();

    let outcome = LmStudioBackend::new(&base_url, "example-model")
        .with_timeout(Duration::from_millis(300))
        .complete(&Request::new("hi"));

    assert_eq!(kind(&outcome), "unreachable", "{outcome:?}");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "waited {:?}",
        started.elapsed()
    );
}

#[test]
fn status_429_is_quota_exceeded() {
    let (base_url, _) = serve(429, r#"{"error":{"message":"busy"}}"#);
    let outcome = backend(&base_url).complete(&Request::new("hi"));
    assert_eq!(kind(&outcome), "quota_exceeded", "{outcome:?}");
}

#[test]
fn gateway_statuses_are_unreachable() {
    for status in [502, 503, 504] {
        let (base_url, _) = serve(status, "{}");
        let outcome = backend(&base_url).complete(&Request::new("hi"));
        assert_eq!(kind(&outcome), "unreachable", "{status}: {outcome:?}");
    }
}

/// Request errors and misconfiguration stop, with LM Studio's own message.
#[test]
fn other_error_statuses_stop_with_the_servers_message() {
    for (status, body, needle) in [
        (400, INVALID_JSON, "Invalid body"),
        (
            401,
            r#"{"error":{"message":"Incorrect API key"}}"#,
            "Incorrect API key",
        ),
        (
            404,
            r#"{"error":{"message":"model not found"}}"#,
            "model not found",
        ),
        (500, r#"{"error":{"message":"crashed"}}"#, "crashed"),
    ] {
        let (base_url, _) = serve(status, body);
        let outcome = backend(&base_url).complete(&Request::new("hi"));
        match &outcome {
            Err(BackendError::Other(message)) => {
                assert!(message.contains(needle), "{status}: {message}")
            }
            other => panic!("{status}: expected Other, got {other:?}"),
        }
    }
}

#[test]
fn a_success_without_an_answer_is_other() {
    for body in [
        r#"{"choices":[]}"#,
        "not json",
        r#"{"choices":[{"message":{}}]}"#,
    ] {
        let (base_url, _) = serve(200, body);
        let outcome = backend(&base_url).complete(&Request::new("hi"));
        assert_eq!(kind(&outcome), "other", "{body}: {outcome:?}");
    }
}

/// A 2xx answer cut at the token or context limit (`finish_reason: length`)
/// is half a JSON document, and an empty answer is none: neither may reach
/// the caller as a success.
#[test]
fn a_truncated_or_empty_answer_is_other() {
    for body in [
        r#"{"choices":[{"message":{"content":"{\"cv\": \"half"},"finish_reason":"length"}]}"#,
        r#"{"choices":[{"message":{"content":""},"finish_reason":"stop"}]}"#,
    ] {
        let (base_url, _) = serve(200, body);
        let outcome = backend(&base_url).complete(&Request::new("hi"));
        assert_eq!(kind(&outcome), "other", "{body}: {outcome:?}");
    }
}

/// The local server has one slot (Bionic): two requests at once must not
/// both reach it. The second waits in the router, not on the server.
#[test]
fn two_requests_never_overlap_on_a_one_slot_backend() {
    let (base_url, overlap) = support::serve_slow(Duration::from_millis(400), SUCCESS);
    let backend = backend(&base_url);
    let other = backend.clone();
    let first = thread::spawn(move || other.complete(&Request::new("one")));
    let second = backend.complete(&Request::new("two"));
    let first = first.join().expect("first thread");

    assert_eq!(kind(&first), "success", "{first:?}");
    assert_eq!(kind(&second), "success", "{second:?}");
    let overlap = overlap.lock().expect("lock");
    assert_eq!(overlap.received, 2);
    assert_eq!(overlap.most, 1, "both requests were on the server at once");
}

/// Waiting for the slot counts against the backend's timeout: past it, the
/// waiting request is an outage (it falls back) and never reaches the server.
#[test]
fn waiting_for_the_slot_past_the_timeout_is_unreachable() {
    let (base_url, overlap) = support::serve_slow(Duration::from_secs(3), SUCCESS);
    let backend =
        LmStudioBackend::new(&base_url, "example-model").with_timeout(Duration::from_secs(1));
    // A clone shares the slot, whatever its own timeout.
    let holder = backend.clone().with_timeout(Duration::from_secs(10));
    let first = thread::spawn(move || holder.complete(&Request::new("one")));
    thread::sleep(Duration::from_millis(200));

    let started = Instant::now();
    let second = backend.complete(&Request::new("two"));
    let waited = started.elapsed();

    assert_eq!(kind(&second), "unreachable", "{second:?}");
    assert!(waited < Duration::from_millis(2500), "waited {waited:?}");
    assert_eq!(
        overlap.lock().expect("lock").received,
        1,
        "the second reached the server"
    );
    let _ = first.join();
}

/// `max_concurrent` lifts the limit when the server has more slots.
#[test]
fn a_two_slot_backend_lets_two_requests_overlap() {
    let (base_url, overlap) = support::serve_slow(Duration::from_millis(400), SUCCESS);
    let backend = backend(&base_url).with_max_concurrent(2);
    let other = backend.clone();
    let first = thread::spawn(move || other.complete(&Request::new("one")));
    let second = backend.complete(&Request::new("two"));
    let first = first.join().expect("first thread");

    assert_eq!(kind(&first), "success", "{first:?}");
    assert_eq!(kind(&second), "success", "{second:?}");
    assert_eq!(overlap.lock().expect("lock").most, 2);
}

/// The configuration wires the limit: an `lm-studio` backend built from a
/// file without `max_concurrent` keeps one completion on the server.
#[test]
fn a_configured_lm_studio_backend_keeps_one_slot() {
    let (base_url, overlap) = support::serve_slow(Duration::from_millis(400), SUCCESS);
    let dir = tempfile::tempdir().expect("temp dir");
    let text = format!(
        "journal = {:?}\n[[backend]]\nkind = \"lm-studio\"\nbase_url = \"{base_url}\"\nmodel = \"m\"\ntimeout_secs = 10\n",
        dir.path().join("journal.jsonl")
    );
    let router = std::sync::Arc::new(
        itsaresume_router::config::Config::parse(&text)
            .expect("valid")
            .router()
            .expect("builds"),
    );
    let other = std::sync::Arc::clone(&router);
    let first = thread::spawn(move || other.complete(&Request::new("one")).result.is_ok());
    let second = router.complete(&Request::new("two")).result.is_ok();

    assert!(first.join().expect("first thread") && second);
    assert_eq!(overlap.lock().expect("lock").most, 1);
}

/// 8.24: a schema goes to the server as `response_format` (json_schema,
/// strict; observed honoured by Bionic on 2026-09-30), and an answer that is
/// not JSON is `Other`, never a success.
#[test]
fn a_schema_request_sends_response_format_and_needs_json() {
    let schema = serde_json::json!({"type": "object", "properties": {"a": {"type": "string"}}});
    let (base_url, received) = serve(
        200,
        r#"{"choices":[{"message":{"content":"{\"a\": \"x\"}"},"finish_reason":"stop"}]}"#,
    );
    let outcome = backend(&base_url).complete(&Request::new("p").with_schema(schema.clone()));
    assert_eq!(kind(&outcome), "success", "{outcome:?}");
    let body = received.recv().expect("the server saw the request").body;
    assert_eq!(body["response_format"]["type"], "json_schema");
    assert_eq!(body["response_format"]["json_schema"]["schema"], schema);
    assert_eq!(body["response_format"]["json_schema"]["strict"], true);

    let (base_url, _) = serve(200, SUCCESS);
    let outcome = backend(&base_url).complete(&Request::new("p").with_schema(schema));
    assert_eq!(kind(&outcome), "other", "{outcome:?}");

    let (base_url, received) = serve(200, SUCCESS);
    let _ = backend(&base_url).complete(&Request::new("p"));
    assert!(
        received
            .recv()
            .expect("seen")
            .body
            .get("response_format")
            .is_none()
    );
}

/// The journal promises lengths only, and an attempt's message goes into it:
/// the text of an answer that is not JSON is counted, never quoted.
#[test]
fn a_non_json_answer_to_a_schema_request_is_not_quoted_in_the_error() {
    let schema = serde_json::json!({"type": "object"});
    let (base_url, _) = serve(
        200,
        r#"{"choices":[{"message":{"content":"Jane Doe, 12 rue X"},"finish_reason":"stop"}]}"#,
    );
    let outcome = backend(&base_url).complete(&Request::new("p").with_schema(schema));
    let Err(error) = outcome else {
        panic!("text that is not JSON is no answer to a schema request")
    };
    assert_eq!(error.kind(), "other");
    assert!(!error.message().contains("Jane Doe"), "{error}");
    assert!(error.message().contains("18 characters"), "{error}");
}
