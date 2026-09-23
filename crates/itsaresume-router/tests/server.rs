//! The HTTP endpoint, over real sockets, in front of scripted backends.

use itsaresume_router::server::{DEFAULT_LISTEN, MAX_BODY_BYTES, Server};
use itsaresume_router::{Backend, BackendError, Completion, Journal, Request, Router};
use serde_json::{Value, json};
use std::net::SocketAddr;
use std::thread;
use std::time::{Duration, Instant};

struct Scripted {
    name: &'static str,
    reply: Result<Completion, BackendError>,
    delay: Duration,
}

impl Backend for Scripted {
    fn name(&self) -> &str {
        self.name
    }

    fn complete(&self, _request: &Request) -> Result<Completion, BackendError> {
        thread::sleep(self.delay);
        self.reply.clone()
    }
}

fn answers(name: &'static str, text: &str) -> Box<dyn Backend> {
    Box::new(Scripted {
        name,
        reply: Ok(Completion { text: text.into() }),
        delay: Duration::ZERO,
    })
}

fn fails(name: &'static str, error: BackendError) -> Box<dyn Backend> {
    Box::new(Scripted {
        name,
        reply: Err(error),
        delay: Duration::ZERO,
    })
}

/// A server on a free loopback port, running on its own thread.
fn start(backends: Vec<Box<dyn Backend>>) -> (SocketAddr, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("temp dir");
    let router =
        Router::new(backends, Journal::new(dir.path().join("journal.jsonl"))).expect("backends");
    let server = Server::bind(router, "127.0.0.1:0").expect("bind");
    let address = server.local_addr();
    thread::spawn(move || server.run());
    (address, dir)
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .into()
}

fn post(address: SocketAddr, body: &str) -> (u16, Value) {
    let mut response = agent()
        .post(&format!("http://{address}/v1/complete"))
        .header("Content-Type", "application/json")
        .send(body)
        .expect("the server answers");
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().expect("a body");
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

fn get(address: SocketAddr, path: &str) -> u16 {
    agent()
        .get(&format!("http://{address}{path}"))
        .call()
        .expect("the server answers")
        .status()
        .as_u16()
}

#[test]
fn a_completion_returns_the_text_the_backend_and_the_failed_attempts() {
    let (address, _dir) = start(vec![
        fails(
            "claude-code",
            BackendError::QuotaExceeded("plan limit".into()),
        ),
        answers("lm-studio", "Bonjour."),
    ]);

    let (status, body) = post(address, r#"{"prompt": "hi", "system": "be brief"}"#);

    assert_eq!(status, 200, "{body}");
    assert_eq!(body["text"], "Bonjour.");
    assert_eq!(body["backend"], "lm-studio");
    assert_eq!(body["attempts"][0]["backend"], "claude-code");
    assert_eq!(body["attempts"][0]["kind"], "quota_exceeded");
}

/// An `Other` error is the caller's to see: 502, with the reason.
#[test]
fn a_stopped_request_is_502_with_the_reason() {
    let (address, _dir) = start(vec![
        fails("claude-code", BackendError::Other("not logged in".into())),
        answers("lm-studio", "never"),
    ]);

    let (status, body) = post(address, r#"{"prompt": "hi"}"#);

    assert_eq!(status, 502, "{body}");
    assert_eq!(body["error"]["kind"], "stopped");
    assert_eq!(body["error"]["backend"], "claude-code");
    assert!(
        body["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("not logged in")),
        "{body}"
    );
}

#[test]
fn an_exhausted_request_is_503() {
    let (address, _dir) = start(vec![fails(
        "lm-studio",
        BackendError::Unreachable("refused".into()),
    )]);

    let (status, body) = post(address, r#"{"prompt": "hi"}"#);

    assert_eq!(status, 503, "{body}");
    assert_eq!(body["error"]["kind"], "exhausted");
    assert_eq!(body["error"]["attempts"][0]["kind"], "unreachable");
}

#[test]
fn a_malformed_request_is_400() {
    let (address, _dir) = start(vec![answers("lm-studio", "x")]);
    for body in [
        "not json",
        "{}",
        r#"{"prompt": 3}"#,
        r#"{"prompt": "   "}"#,
        r#"{"prompt": "hi", "system": 3}"#,
    ] {
        let (status, _) = post(address, body);
        assert_eq!(status, 400, "{body}");
    }
}

#[test]
fn an_oversized_request_is_413() {
    let (address, _dir) = start(vec![answers("lm-studio", "x")]);
    let prompt = "x".repeat(MAX_BODY_BYTES + 1);
    let (status, _) = post(address, &json!({ "prompt": prompt }).to_string());
    assert_eq!(status, 413);
}

#[test]
fn health_and_unknown_paths() {
    let (address, _dir) = start(vec![answers("lm-studio", "x")]);
    assert_eq!(get(address, "/healthz"), 200);
    assert_eq!(get(address, "/nope"), 404);
    assert_eq!(get(address, "/v1/complete"), 405);
}

/// A Claude answer can take minutes; health checks must not queue behind it.
#[test]
fn a_slow_completion_does_not_block_other_requests() {
    let (address, _dir) = start(vec![Box::new(Scripted {
        name: "claude-code",
        reply: Ok(Completion {
            text: "slow".into(),
        }),
        delay: Duration::from_secs(3),
    })]);
    let slow = thread::spawn(move || post(address, r#"{"prompt": "hi"}"#));
    thread::sleep(Duration::from_millis(200));

    let started = Instant::now();
    assert_eq!(get(address, "/healthz"), 200);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "healthz waited {:?} behind a completion",
        started.elapsed()
    );
    assert_eq!(slow.join().expect("slow request").0, 200);
}

/// The endpoint has no authentication and spends Nicolas's plan: it must
/// listen on loopback unless told otherwise.
#[test]
fn the_default_listen_address_is_loopback() {
    let address: SocketAddr = DEFAULT_LISTEN.parse().expect("a socket address");
    assert!(address.ip().is_loopback(), "{DEFAULT_LISTEN}");
}

/// `itsaresume serve` itself, as a process.
#[test]
fn the_serve_command_answers_on_the_given_address() {
    let dir = tempfile::tempdir().expect("temp dir");
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .expect("bind")
        .local_addr()
        .expect("address")
        .port();
    let config = dir.path().join("config.toml");
    std::fs::write(
        &config,
        format!(
            "journal = {}\n[[backend]]\nkind = \"lm-studio\"\nbase_url = \"http://127.0.0.1:9/v1\"\nmodel = \"m\"\n",
            Value::String(dir.path().join("j.jsonl").to_string_lossy().into_owned())
        ),
    )
    .expect("write config");
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_itsaresume"))
        .args([
            "serve",
            "--config",
            config.to_str().expect("utf-8"),
            "--listen",
            &format!("127.0.0.1:{port}"),
        ])
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("serve starts");
    let address: SocketAddr = format!("127.0.0.1:{port}").parse().expect("address");

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut status = None;
    while Instant::now() < deadline {
        if let Ok(response) = agent().get(&format!("http://{address}/healthz")).call() {
            status = Some(response.status().as_u16());
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
    assert_eq!(status, Some(200));
}
