//! `LmStudioBackend` over real HTTP, against a one-shot fake server on
//! 127.0.0.1 that serves the bodies LM Studio was observed to return
//! (`tests/fixtures/lm-studio/`) and records the request it received.

use itsaresume_router::lm_studio::LmStudioBackend;
use itsaresume_router::{Backend, BackendError, Completion, Request};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::mpsc::{Receiver, channel};
use std::thread;
use std::time::{Duration, Instant};

const SUCCESS: &str = include_str!("fixtures/lm-studio/observed-success.json");
const NO_MODELS_LOADED: &str = include_str!("fixtures/lm-studio/observed-no-models-loaded.json");
const INVALID_JSON: &str = include_str!("fixtures/lm-studio/observed-invalid-json.json");

/// What the fake server received.
struct Received {
    request_line: String,
    headers: Vec<(String, String)>,
    body: Value,
}

/// Serve one request with `status` and `body`; return the base URL.
fn serve(status: u16, body: &str) -> (String, Receiver<Received>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind a free port");
    let base_url = format!("http://{}/v1", listener.local_addr().expect("address"));
    let body = body.to_owned();
    let (sender, receiver) = channel();
    thread::spawn(move || {
        let (stream, _) = listener.accept().expect("one connection");
        let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
        let mut request_line = String::new();
        reader.read_line(&mut request_line).expect("request line");
        let mut headers = Vec::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).expect("header line");
            let line = line.trim_end();
            if line.is_empty() {
                break;
            }
            let (name, value) = line.split_once(':').expect("a header");
            headers.push((name.trim().to_lowercase(), value.trim().to_owned()));
        }
        let length: usize = headers
            .iter()
            .find(|(name, _)| name == "content-length")
            .map(|(_, value)| value.parse().expect("a length"))
            .unwrap_or(0);
        let mut raw = vec![0; length];
        reader.read_exact(&mut raw).expect("body");
        let _ = sender.send(Received {
            request_line: request_line.trim_end().to_owned(),
            headers,
            body: serde_json::from_slice(&raw).unwrap_or(Value::Null),
        });
        let mut stream = stream;
        let response = format!(
            "HTTP/1.1 {status} Status\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).expect("respond");
    });
    (base_url, receiver)
}

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
            text: "Hello!".into()
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
