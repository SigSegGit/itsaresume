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

/// `itsaresume serve` itself, as a process, once it answers `/healthz`
/// (None if it never did within 10 s).
/// A `serve` child, killed and reaped when dropped, even when the test
/// panics first: an orphan kept the sabotage run's pipes open and hung it
/// (seen under WSL, 2026-09-30).
struct Serving(std::process::Child);

impl Drop for Serving {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn serve_process(dir: &std::path::Path) -> (Serving, SocketAddr, Option<u16>) {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .expect("bind")
        .local_addr()
        .expect("address")
        .port();
    let config = dir.join("config.toml");
    std::fs::write(
        &config,
        format!(
            "journal = {}\n[[backend]]\nkind = \"lm-studio\"\nbase_url = \"http://127.0.0.1:9/v1\"\nmodel = \"m\"\n",
            Value::String(dir.join("j.jsonl").to_string_lossy().into_owned())
        ),
    )
    .expect("write config");
    let child = std::process::Command::new(env!("CARGO_BIN_EXE_itsaresume"))
        .args([
            "serve",
            "--config",
            config.to_str().expect("utf-8"),
            "--listen",
            &format!("127.0.0.1:{port}"),
        ])
        // Nothing inherited: an orphan must hold none of the test's pipes.
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(Serving)
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
    (child, address, status)
}

#[test]
fn the_serve_command_answers_on_the_given_address() {
    let dir = tempfile::tempdir().expect("temp dir");
    let (child, _, status) = serve_process(dir.path());
    drop(child);
    assert_eq!(status, Some(200));
}

/// Send `head` (request line and headers, no final blank line) and `body`
/// over a raw socket; the status of the answer, or None if none came.
fn raw(address: SocketAddr, head: &str, body: &[u8]) -> Option<u16> {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(address).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .expect("timeout");
    stream
        .write_all(format!("{head}\r\n\r\n").as_bytes())
        .expect("write head");
    let _ = stream.write_all(body);
    let mut answer = [0u8; 12];
    stream.read_exact(&mut answer).ok()?;
    std::str::from_utf8(&answer[9..12]).ok()?.parse().ok()
}

fn complete_head(host: &str, extra: &str, length: usize) -> String {
    format!("POST /v1/complete HTTP/1.1\r\nHost: {host}\r\nContent-Length: {length}{extra}")
}

/// 8.14(a): a web page can POST `text/plain` without a CORS preflight; the
/// endpoint only takes JSON.
#[test]
fn a_completion_that_is_not_json_is_415() {
    let (address, _dir) = start(vec![answers("lm-studio", "x")]);
    let body = br#"{"prompt": "hi"}"#;
    let head = complete_head("127.0.0.1", "\r\nContent-Type: text/plain", body.len());
    assert_eq!(raw(address, &head, body), Some(415));
    let head = complete_head("127.0.0.1", "", body.len());
    assert_eq!(raw(address, &head, body), Some(415), "no Content-Type");
    let head = complete_head(
        "127.0.0.1",
        "\r\nContent-Type: application/json; charset=utf-8",
        body.len(),
    );
    assert_eq!(raw(address, &head, body), Some(200), "JSON with a charset");
}

/// 8.14(a): no browser page may drive the endpoint, whatever its origin.
#[test]
fn a_completion_from_a_browser_origin_is_403() {
    let (address, _dir) = start(vec![answers("lm-studio", "x")]);
    let body = br#"{"prompt": "hi"}"#;
    for origin in ["http://evil.example", "null", "http://127.0.0.1:8787"] {
        let extra = format!("\r\nContent-Type: application/json\r\nOrigin: {origin}");
        let head = complete_head("127.0.0.1", &extra, body.len());
        assert_eq!(raw(address, &head, body), Some(403), "{origin}");
    }
}

/// 8.14(a): DNS rebinding reaches the loopback under a foreign name; only
/// loopback names are served, on any port.
#[test]
fn a_foreign_host_is_403_and_loopback_names_are_served() {
    let (address, _dir) = start(vec![answers("lm-studio", "x")]);
    let body = br#"{"prompt": "hi"}"#;
    let extra = "\r\nContent-Type: application/json";
    for host in [
        "evil.example",
        "evil.example:8787",
        "127.0.0.1.evil.example",
        "localhost.evil",
    ] {
        assert_eq!(
            raw(address, &complete_head(host, extra, body.len()), body),
            Some(403),
            "{host}"
        );
        let health = format!("GET /healthz HTTP/1.1\r\nHost: {host}");
        assert_eq!(raw(address, &health, b""), Some(403), "healthz {host}");
    }
    for host in [
        "127.0.0.1",
        "127.0.0.1:1",
        "localhost",
        "LOCALHOST:8787",
        "[::1]",
        "[::1]:8787",
    ] {
        assert_eq!(
            raw(address, &complete_head(host, extra, body.len()), body),
            Some(200),
            "{host}"
        );
    }
}

/// 8.14(b): a huge declared body is refused without the process allocating
/// it, and the server keeps serving.
#[test]
fn a_huge_declared_body_is_413_and_the_server_lives() {
    // A process of its own: the failure this guards against is an abort,
    // which would take the whole test binary down with it.
    let dir = tempfile::tempdir().expect("temp dir");
    let (mut child, address, status) = serve_process(dir.path());
    assert_eq!(status, Some(200));
    let head = complete_head(
        "127.0.0.1",
        "\r\nContent-Type: application/json",
        usize::MAX / 2,
    );
    let refused = raw(address, &head, b"{");
    thread::sleep(Duration::from_millis(300));
    let alive = child.0.try_wait().expect("child status").is_none();
    drop(child);
    assert_eq!(refused, Some(413));
    assert!(alive, "the server died on a huge declared body");
}

/// 8.14(c): the serve loop reports the error that ends it instead of
/// returning as if all went well.
#[test]
fn the_serve_loop_returns_the_error_that_ended_it() {
    use itsaresume_router::server::drive;
    let mut left = vec![Ok(1), Ok(2), Err(std::io::Error::other("accept failed"))];
    left.reverse();
    let mut seen = Vec::new();
    let error = drive(
        || left.pop().expect("drive stops at the error"),
        |n| seen.push(n),
    );
    assert_eq!(seen, [1, 2]);
    assert_eq!(error.to_string(), "accept failed");
}

/// 8.14(d): completions beyond the cap are refused at once, not queued on
/// an unbounded number of threads; health checks are not counted.
#[test]
fn completions_beyond_the_cap_are_503_busy() {
    use itsaresume_router::server::MAX_CONCURRENT_COMPLETIONS;
    let (address, _dir) = start(vec![Box::new(Scripted {
        name: "claude-code",
        reply: Ok(Completion {
            text: "slow".into(),
        }),
        delay: Duration::from_secs(3),
    })]);
    let slow: Vec<_> = (0..MAX_CONCURRENT_COMPLETIONS)
        .map(|_| thread::spawn(move || post(address, r#"{"prompt": "hi"}"#).0))
        .collect();
    thread::sleep(Duration::from_millis(500));
    let started = Instant::now();
    let (status, body) = post(address, r#"{"prompt": "hi"}"#);
    assert_eq!(status, 503);
    assert_eq!(body["error"]["kind"], "busy");
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(get(address, "/healthz"), 200);
    for handle in slow {
        assert_eq!(handle.join().expect("slow request"), 200);
    }
    assert_eq!(
        post(address, r#"{"prompt": "hi"}"#).0,
        200,
        "the slots come back"
    );
}

/// 8.22: `"backend"` names the one backend to try; an unknown name is 400
/// listing the configured ones.
#[test]
fn a_request_may_name_its_backend() {
    let (address, _dir) = start(vec![
        answers("claude-code", "from claude"),
        answers("lm-studio", "from the local model"),
    ]);
    let (status, body) = post(address, r#"{"prompt": "p", "backend": "lm-studio"}"#);
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["backend"], "lm-studio");
    assert_eq!(body["text"], "from the local model");

    let (status, body) = post(address, r#"{"prompt": "p", "backend": "gpt"}"#);
    assert_eq!(status, 400, "{body}");
    let message = body["error"]["message"].as_str().unwrap_or_default();
    assert!(message.contains("claude-code, lm-studio"), "{body}");

    let (status, _) = post(address, r#"{"prompt": "p", "backend": 3}"#);
    assert_eq!(status, 400);
}

/// 8.24: `"schema"` is a JSON Schema object, or the request is 400.
#[test]
fn a_schema_must_be_an_object() {
    let (address, _dir) = start(vec![answers("lm-studio", "{\"a\": 1}")]);
    let (status, body) = post(address, r#"{"prompt": "p", "schema": "not a schema"}"#);
    assert_eq!(status, 400, "{body}");
    let (status, body) = post(address, r#"{"prompt": "p", "schema": {"type": "object"}}"#);
    assert_eq!(status, 200, "{body}");
}

/// A backend that answers with the schema it was given (or "none").
struct EchoSchema;

impl Backend for EchoSchema {
    fn name(&self) -> &str {
        "echo"
    }

    fn complete(&self, request: &Request) -> Result<Completion, BackendError> {
        Ok(Completion {
            text: request
                .schema
                .as_ref()
                .map_or_else(|| "none".to_owned(), ToString::to_string),
        })
    }
}

#[test]
fn the_schema_reaches_the_backend() {
    let (address, _dir) = start(vec![Box::new(EchoSchema)]);
    let (status, body) = post(address, r#"{"prompt": "p", "schema": {"type": "object"}}"#);
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["text"], r#"{"type":"object"}"#);
    let (_, body) = post(address, r#"{"prompt": "p"}"#);
    assert_eq!(body["text"], "none");
}
