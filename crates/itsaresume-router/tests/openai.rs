//! The `openai` backend: the owner's free-tier service-account key
//! (2026-10-14, no overage), read from `OPENAI_API_KEY` only, sent as a
//! bearer to the configured endpoint; schemas through the shared JSON rule.

mod support;

use itsaresume_router::openai::OpenAiBackend;
use itsaresume_router::{Backend, BackendError, Request};
use serde_json::json;
use std::time::Duration;
use support::serve;

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
