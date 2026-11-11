//! The `openai` backend: the owner's free-tier service-account key
//! (2026-10-14, no overage), read from `OPENAI_API_KEY` only, sent as a
//! bearer to the configured endpoint; schemas through the shared JSON rule.

mod support;

use itsaresume_router::openai::OpenAiBackend;
use itsaresume_router::{Backend, BackendError, Request};
use serde_json::json;
use std::time::{Duration, Instant};
use support::{serve, serve_sequence};

const SUCCESS: &str = include_str!("fixtures/lm-studio/observed-success.json");

fn backend(base_url: &str, key: Option<&str>) -> OpenAiBackend {
    OpenAiBackend::new(base_url, "gpt-5-mini", key.map(str::to_owned))
        .with_timeout(Duration::from_secs(10))
}

#[test]
fn the_key_goes_as_a_bearer_and_never_in_the_body() {
    let (base_url, received) = serve(200, SUCCESS);
    let answer = backend(&base_url, Some("sk-test"))
        .complete(&Request::new("hi"))
        .expect("answer");
    assert_eq!(answer.text, "Hello!");
    let request = received.recv().expect("request");
    let auth = request
        .headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case("authorization"))
        .map(|(_, v)| v.clone());
    assert_eq!(auth.as_deref(), Some("Bearer sk-test"));
    assert!(!request.body.to_string().contains("sk-test"));
}

#[test]
fn no_key_is_other_and_sends_nothing() {
    let outcome = backend("http://127.0.0.1:9/v1", None).complete(&Request::new("hi"));
    assert!(
        matches!(outcome, Err(BackendError::Other(_))),
        "{outcome:?}"
    );
}

#[test]
fn insufficient_quota_falls_back() {
    let body = r#"{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}"#;
    let (base_url, _) = serve(429, body);
    let outcome = backend(&base_url, Some("k")).complete(&Request::new("hi"));
    assert!(
        matches!(outcome, Err(BackendError::QuotaExceeded(_))),
        "{outcome:?}"
    );
}

/// Observed on the VM (8.53): openai's 429 read "LM Studio HTTP 429: …".
#[test]
fn an_openai_error_names_openai_never_lm_studio() {
    let body = r#"{"error":{"message":"You have no credits remaining."}}"#;
    let (base_url, _) = serve(429, body);
    let http = backend(&base_url, Some("k")).complete(&Request::new("hi"));
    let unreachable = backend("http://127.0.0.1:9/v1", Some("k")).complete(&Request::new("hi"));
    for outcome in [http, unreachable] {
        let detail = format!("{outcome:?}");
        assert!(detail.contains("openai"), "{detail}");
        assert!(!detail.contains("LM Studio"), "{detail}");
    }
}

#[test]
fn a_schema_uses_the_shared_rule_and_json_object_mode() {
    let (base_url, received) = serve(200, SUCCESS);
    let schema = json!({"type": "object", "required": ["score"]});
    let _ =
        backend(&base_url, Some("k")).complete(&Request::new("Note.").with_schema(schema.clone()));
    let body = received.recv().expect("request").body;
    assert_eq!(body["response_format"], json!({"type": "json_object"}));
    let user = body["messages"]
        .as_array()
        .and_then(|m| m.last())
        .expect("a message");
    assert!(
        user["content"]
            .as_str()
            .is_some_and(|c| c.contains(&schema.to_string()))
    );
}

#[test]
fn its_name_is_openai() {
    assert_eq!(backend("http://127.0.0.1:9/v1", None).name(), "openai");
}

/// 2.36 (the owner, 2026-11-11): Groq's free tier, no payment method on the
/// account, so nothing can be billed. Its own kind, its own key variable,
/// its fixed address: a configuration never sends a key elsewhere.
#[test]
fn groq_is_its_own_backend_with_its_own_key_and_address() {
    let groq = OpenAiBackend::groq("openai/gpt-oss-120b", None);
    assert_eq!(groq.name(), "groq");
    assert_eq!(
        itsaresume_router::openai::GROQ_URL,
        "https://api.groq.com/openai/v1"
    );
    match groq.complete(&Request::new("hi")) {
        Err(BackendError::Other(message)) => assert!(message.contains("GROQ_API_KEY"), "{message}"),
        other => panic!("expected the missing key, got {other:?}"),
    }
}

/// 2.37: Groq's free tier allows 8 000 tokens a minute. A 429 that says
/// when to come back (`retry-after`, seconds) is waited out and asked again,
/// within the timeout: one analysis in two calls fits, the second waiting.
#[test]
fn groq_waits_out_a_rate_limit_and_asks_again() {
    let limited = r#"{"error":{"message":"Rate limit reached for model on tokens per minute (TPM): Limit 8000","type":"tokens","code":"rate_limit_exceeded"}}"#;
    let (base_url, received) =
        serve_sequence(&[(429, "retry-after: 1\r\n", limited), (200, "", SUCCESS)]);
    let groq = OpenAiBackend::groq_at(&base_url, "openai/gpt-oss-120b", Some("k".into()))
        .with_timeout(Duration::from_secs(10));
    let started = Instant::now();
    let answer = groq
        .complete(&Request::new("hi"))
        .expect("answered after the wait");
    assert_eq!(answer.text, "Hello!");
    assert!(started.elapsed() >= Duration::from_millis(900), "it waited");
    assert_eq!(received.iter().take(2).count(), 2, "asked twice");
}

/// A wait longer than the time left is no wait: the router falls back now.
#[test]
fn groq_does_not_wait_past_its_timeout() {
    let limited = r#"{"error":{"message":"Rate limit reached","code":"rate_limit_exceeded"}}"#;
    let (base_url, _) = serve_sequence(&[(429, "retry-after: 30\r\n", limited)]);
    let groq = OpenAiBackend::groq_at(&base_url, "openai/gpt-oss-120b", Some("k".into()))
        .with_timeout(Duration::from_secs(2));
    let started = Instant::now();
    let outcome = groq.complete(&Request::new("hi"));
    assert!(
        matches!(outcome, Err(BackendError::QuotaExceeded(_))),
        "{outcome:?}"
    );
    assert!(started.elapsed() < Duration::from_secs(2));
}

/// Plain OpenAI never waits: its 429 is a quota, not a minute's budget.
#[test]
fn openai_does_not_wait_out_a_429() {
    let limited = r#"{"error":{"message":"Rate limit reached"}}"#;
    let (base_url, _) = serve_sequence(&[(429, "retry-after: 1\r\n", limited), (200, "", SUCCESS)]);
    let outcome = backend(&base_url, Some("k")).complete(&Request::new("hi"));
    assert!(
        matches!(outcome, Err(BackendError::QuotaExceeded(_))),
        "{outcome:?}"
    );
}

/// A request bigger than the minute's budget (observed: 413, "Request too
/// large ... tokens per minute (TPM): Limit 8000, Requested 9083") is that
/// backend's limit, not a broken request: `auto` goes on to the next one.
#[test]
fn groq_request_too_large_falls_back() {
    let body = r#"{"error":{"message":"Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Requested 9083, please reduce your message size and try again.","type":"tokens","code":"rate_limit_exceeded"}}"#;
    let (base_url, _) = serve(413, body);
    let groq = OpenAiBackend::groq_at(&base_url, "openai/gpt-oss-120b", Some("k".into()))
        .with_timeout(Duration::from_secs(5));
    let outcome = groq.complete(&Request::new("hi"));
    assert!(
        matches!(outcome, Err(BackendError::QuotaExceeded(_))),
        "{outcome:?}"
    );
}

/// gpt-oss thinks before it answers, and its thinking counts in the
/// minute's tokens: Groq is asked to keep it short.
#[test]
fn groq_asks_for_low_reasoning_and_openai_does_not() {
    let (base_url, received) = serve(200, SUCCESS);
    let groq = OpenAiBackend::groq_at(&base_url, "openai/gpt-oss-120b", Some("k".into()));
    groq.complete(&Request::new("hi")).expect("answer");
    assert_eq!(
        received.recv().expect("request").body["reasoning_effort"],
        "low"
    );
    let (base_url, received) = serve(200, SUCCESS);
    backend(&base_url, Some("k"))
        .complete(&Request::new("hi"))
        .expect("answer");
    assert!(
        received
            .recv()
            .expect("request")
            .body
            .get("reasoning_effort")
            .is_none()
    );
}
