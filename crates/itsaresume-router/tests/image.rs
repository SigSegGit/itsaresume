//! An image with the prompt (2026-11-24): a job offer sent as a phone
//! screenshot. Only a backend that reads images gets it (the `claude` CLI,
//! through a stream-json user message, tools still off); the router never
//! hands it to a text-only one, and says so when none reads images.

use itsaresume_router::claude_code::ClaudeCodeBackend;
use itsaresume_router::server::{MAX_BODY_BYTES, Server};
use itsaresume_router::{
    Backend, BackendError, Completion, Image, Journal, Request, RouteError, Router,
};
use serde_json::{Value, json};
use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::Duration;

const FAKE: &str = env!("CARGO_BIN_EXE_itsaresume-fake-claude");

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/claude")
        .join(name)
}

fn image() -> Image {
    Image {
        media_type: "image/png".into(),
        base64: "iVBORw0KGgo=".into(),
    }
}

fn image_request() -> Request {
    Request::new("Transcribe the text of this image.").with_image(image())
}

/// The fake `claude`, answering with the observed stream-json capture.
fn run_fake(request: &Request) -> (Result<Completion, BackendError>, Vec<String>, String) {
    let root = tempfile::tempdir().expect("temp dir");
    let record = root.path().join("record");
    std::fs::create_dir(&record).expect("record dir");
    let stdout = fixture("observed-image-stream.verbose.jsonl");
    let mut env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    env.push(("FAKE_CLAUDE_RECORD".into(), record.clone().into()));
    env.push(("FAKE_CLAUDE_STDOUT".into(), stdout.into()));
    let outcome = ClaudeCodeBackend::new(FAKE)
        .with_workdir(root.path().join("work"))
        .with_timeout(Duration::from_secs(30))
        .complete_with_env(request, env);
    let args: Vec<String> = serde_json::from_str(
        &std::fs::read_to_string(record.join("args.json")).expect("args recorded"),
    )
    .expect("a JSON list");
    let stdin = std::fs::read_to_string(record.join("stdin.txt")).expect("stdin recorded");
    (outcome, args, stdin)
}

#[test]
fn claude_gets_the_image_in_a_stream_json_message_with_tools_still_off() {
    let (outcome, args, stdin) = run_fake(&image_request());
    let has_pair = |a: &str, b: &str| args.windows(2).any(|w| w[0] == a && w[1] == b);
    assert!(has_pair("--input-format", "stream-json"), "{args:?}");
    assert!(has_pair("--output-format", "stream-json"), "{args:?}");
    assert!(has_pair("--tools", ""), "tools must stay disabled: {args:?}");
    assert!(has_pair("--setting-sources", ""), "{args:?}");

    let lines: Vec<&str> = stdin.lines().filter(|l| !l.trim().is_empty()).collect();
    assert_eq!(lines.len(), 1, "one user message: {stdin}");
    let message: Value = serde_json::from_str(lines[0]).expect("a JSON line");
    assert_eq!(message["type"], "user");
    let content = message["message"]["content"].as_array().expect("blocks");
    assert_eq!(content[0]["type"], "image");
    assert_eq!(content[0]["source"]["type"], "base64");
    assert_eq!(content[0]["source"]["media_type"], "image/png");
    assert_eq!(content[0]["source"]["data"], "iVBORw0KGgo=");
    assert_eq!(content[1]["type"], "text");
    assert_eq!(content[1]["text"], "Transcribe the text of this image.");

    let completion = outcome.expect("the observed stream is understood");
    assert_eq!(completion.text, "Offre : Ingenieur Test\n\nPython, Docker, Lyon");
    assert_eq!(completion.usage.expect("usage").output, 26);
}

#[test]
fn without_an_image_the_flags_and_stdin_are_unchanged() {
    let root = tempfile::tempdir().expect("temp dir");
    let record = root.path().join("record");
    std::fs::create_dir(&record).expect("record dir");
    let mut env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    env.push(("FAKE_CLAUDE_RECORD".into(), record.clone().into()));
    env.push((
        "FAKE_CLAUDE_STDOUT".into(),
        fixture("synthetic-success.verbose.json").into(),
    ));
    ClaudeCodeBackend::new(FAKE)
        .with_workdir(root.path().join("work"))
        .complete_with_env(&Request::new("plain"), env)
        .expect("the fake answers");
    let args = std::fs::read_to_string(record.join("args.json")).expect("args");
    assert!(!args.contains("stream-json"), "{args}");
    let stdin = std::fs::read_to_string(record.join("stdin.txt")).expect("stdin");
    assert_eq!(stdin, "plain");
}

/// The stream's tripwires are the array's: a metered billing source is
/// refused even when the image was read.
#[test]
fn the_billing_tripwire_holds_on_the_stream() {
    let root = tempfile::tempdir().expect("temp dir");
    let metered = root.path().join("metered.jsonl");
    let observed =
        std::fs::read_to_string(fixture("observed-image-stream.verbose.jsonl")).expect("fixture");
    std::fs::write(
        &metered,
        observed.replace("\"apiKeySource\": \"none\"", "\"apiKeySource\": \"ANTHROPIC_API_KEY\""),
    )
    .expect("write");
    let mut env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    env.push(("FAKE_CLAUDE_STDOUT".into(), metered.into()));
    let outcome = ClaudeCodeBackend::new(FAKE)
        .with_workdir(root.path().join("work"))
        .complete_with_env(&image_request(), env);
    match outcome {
        Err(BackendError::Other(message)) => assert!(message.contains("billing tripwire"), "{message}"),
        other => panic!("expected the billing tripwire, got {other:?}"),
    }
}

#[test]
fn only_claude_code_says_it_reads_images() {
    assert!(ClaudeCodeBackend::new(FAKE).sees_images());
}

/// A text-only backend that counts what reaches it.
struct Blind {
    calls: Arc<AtomicUsize>,
}

impl Backend for Blind {
    fn name(&self) -> &str {
        "lm-studio"
    }

    fn complete(&self, _request: &Request) -> Result<Completion, BackendError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(Completion {
            text: "made up".into(),
            rate_limit: None,
            usage: None,
        })
    }
}

/// A backend that reads images and echoes whether it got one.
struct Seeing;

impl Backend for Seeing {
    fn name(&self) -> &str {
        "claude-code"
    }

    fn sees_images(&self) -> bool {
        true
    }

    fn complete(&self, request: &Request) -> Result<Completion, BackendError> {
        Ok(Completion {
            text: format!("seen: {}", request.image.is_some()),
            rate_limit: None,
            usage: None,
        })
    }
}

fn router(backends: Vec<Box<dyn Backend>>, dir: &Path) -> Router {
    Router::new(backends, Journal::new(dir.join("journal.jsonl"))).expect("backends")
}

#[test]
fn a_text_only_backend_never_gets_an_image() {
    let dir = tempfile::tempdir().expect("temp dir");
    let calls = Arc::new(AtomicUsize::new(0));
    let router = router(
        vec![
            Box::new(Blind {
                calls: Arc::clone(&calls),
            }),
            Box::new(Seeing),
        ],
        dir.path(),
    );
    let outcome = router.complete(&image_request());
    assert_eq!(outcome.result.expect("served").text, "seen: true");
    assert_eq!(calls.load(Ordering::SeqCst), 0, "the blind backend was asked");
}

#[test]
fn with_no_backend_that_reads_images_the_request_is_refused_unasked() {
    let dir = tempfile::tempdir().expect("temp dir");
    let calls = Arc::new(AtomicUsize::new(0));
    let router = router(
        vec![Box::new(Blind {
            calls: Arc::clone(&calls),
        })],
        dir.path(),
    );
    let outcome = router.complete(&image_request());
    assert!(
        matches!(outcome.result, Err(RouteError::NoVision)),
        "{:?}",
        outcome.result
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

fn start(backends: Vec<Box<dyn Backend>>) -> (SocketAddr, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("temp dir");
    let server = Server::bind(router(backends, dir.path()), "127.0.0.1:0").expect("bind");
    let address = server.local_addr();
    thread::spawn(move || server.run());
    (address, dir)
}

fn post(address: SocketAddr, body: &Value) -> (u16, Value) {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .into();
    let mut response = agent
        .post(&format!("http://{address}/v1/complete"))
        .header("Content-Type", "application/json")
        .send(body.to_string())
        .expect("the server answers");
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().expect("a body");
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

#[test]
fn the_http_api_takes_an_image_and_a_phone_screenshot_fits() {
    let (address, _dir) = start(vec![Box::new(Seeing)]);
    let (status, body) = post(
        address,
        &json!({"prompt": "Transcribe.", "image": {"media_type": "image/jpeg", "base64": "/9j/4AAQ"}}),
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["text"], "seen: true");
    // A 1080x2340 phone screenshot is ~0.6 MB of JPEG, a few MB of PNG.
    assert!(MAX_BODY_BYTES >= 8 * 1024 * 1024, "{MAX_BODY_BYTES}");
}

#[test]
fn the_http_api_refuses_a_malformed_image_or_a_type_it_does_not_know() {
    let (address, _dir) = start(vec![Box::new(Seeing)]);
    for image in [
        json!("abc"),
        json!({"media_type": "image/png"}),
        json!({"media_type": "image/svg+xml", "base64": "PHN2Zz4="}),
        json!({"media_type": "text/html", "base64": "PGh0bWw+"}),
        json!({"media_type": "image/png", "base64": "not base64!"}),
    ] {
        let (status, body) = post(address, &json!({"prompt": "Transcribe.", "image": image}));
        assert_eq!(status, 400, "{image} -> {body}");
    }
}

#[test]
fn the_http_api_says_when_no_backend_reads_images() {
    let calls = Arc::new(AtomicUsize::new(0));
    let (address, _dir) = start(vec![Box::new(Blind {
        calls: Arc::clone(&calls),
    })]);
    let (status, body) = post(
        address,
        &json!({"prompt": "Transcribe.", "image": {"media_type": "image/png", "base64": "iVBORw0KGgo="}}),
    );
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"]["kind"], "no_vision");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}
