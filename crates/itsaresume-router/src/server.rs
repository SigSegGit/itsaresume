//! `itsaresume serve`: the router behind a small HTTP endpoint.
//!
//! `POST /v1/complete` `{"prompt": "…", "system": "…"}` → 200 with the text,
//! 502 when a backend stopped the request, 503 when every backend failed with
//! a fallback kind; `GET /healthz` → 200 (docs/ARCHITECTURE.md, HTTP endpoint).

use crate::backend::Request as Inference;
use crate::router::{Attempt, RouteError, Router};
use serde_json::{Value, json};
use std::io::Read;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tiny_http::{Header, Method, Response};

/// Where `serve` listens unless told otherwise: loopback only, because the
/// endpoint has no authentication and spends Nicolas's plan.
pub const DEFAULT_LISTEN: &str = "127.0.0.1:8787";

/// The largest request body accepted, in bytes.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

/// Above this declared body size, the body is not even read (see
/// `refuse_unread`); between `MAX_BODY_BYTES` and this, tiny_http drains it.
pub const MAX_DRAIN_BYTES: usize = 64 * 1024 * 1024;

/// A bound, not yet running, HTTP endpoint.
pub struct Server {
    http: tiny_http::Server,
    router: Arc<Router>,
    address: SocketAddr,
    running: Arc<AtomicUsize>,
}

impl Server {
    /// Bind `address` (e.g. `127.0.0.1:8787`, or port 0 for any free port).
    pub fn bind(router: Router, address: &str) -> Result<Self, String> {
        let http = tiny_http::Server::http(address)
            .map_err(|error| format!("cannot listen on {address}: {error}"))?;
        let bound = http
            .server_addr()
            .to_ip()
            .ok_or_else(|| format!("{address} is not an IP address"))?;
        Ok(Self {
            http,
            router: Arc::new(router),
            address: bound,
            running: Arc::new(AtomicUsize::new(0)),
        })
    }

    /// The address actually bound.
    pub fn local_addr(&self) -> SocketAddr {
        self.address
    }

    /// Serve requests until the process ends, one thread per request: a
    /// Claude answer can take minutes and must not hold up health checks.
    /// tiny_http stops accepting after its first `accept()` error, so that
    /// error ends the loop and is returned for `serve` to report.
    pub fn run(self) -> Result<(), String> {
        let error = drive(
            || self.http.recv(),
            |request| {
                let router = Arc::clone(&self.router);
                let running = Arc::clone(&self.running);
                std::thread::spawn(move || respond(&router, &running, request));
            },
        );
        Err(format!("stopped serving: {error}"))
    }
}

fn respond(router: &Router, running: &AtomicUsize, mut request: tiny_http::Request) {
    // Up to MAX_DRAIN_BYTES, tiny_http's own drain on drop is affordable and
    // lets a client still sending its body read the 413.
    if request
        .body_length()
        .is_some_and(|length| length > MAX_DRAIN_BYTES)
    {
        return refuse_unread(request);
    }
    let (status, body) = route(router, running, &mut request);
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
        .expect("a constant, valid header");
    let response = Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(header);
    // The client may have gone away; there is nobody left to tell.
    let _ = request.respond(response);
}

/// Answer 413 without ever dropping the unread body: tiny_http drains it on
/// drop into one buffer the size the client declared, and a huge declared
/// length aborts the process. `upgrade` hands the connection over; it is
/// leaked on purpose (one socket per such request, on a loopback endpoint).
fn refuse_unread(request: tiny_http::Request) {
    let (status, body) = too_large();
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
        .expect("a constant, valid header");
    let response = Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(header);
    std::mem::forget(request.upgrade("close", response));
}

/// Only loopback names: a page that rebinds its own name to 127.0.0.1 still
/// sends that name.
fn loopback_host(request: &tiny_http::Request) -> bool {
    let Some(host) = header(request, "Host") else {
        return false;
    };
    let (name, port) = match host.strip_prefix("[::1]") {
        Some(port) => ("[::1]", port),
        None => host.find(':').map_or((host, ""), |at| host.split_at(at)),
    };
    let port_ok = port.is_empty()
        || port
            .strip_prefix(':')
            .is_some_and(|number| number.parse::<u16>().is_ok());
    port_ok && (name == "[::1]" || name == "127.0.0.1" || name.eq_ignore_ascii_case("localhost"))
}

fn header<'a>(request: &'a tiny_http::Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str().trim())
}

fn route(router: &Router, running: &AtomicUsize, request: &mut tiny_http::Request) -> (u16, Value) {
    if !loopback_host(request) {
        return error(403, "forbidden", "only loopback host names are served");
    }
    let path = request
        .url()
        .split('?')
        .next()
        .unwrap_or_default()
        .to_owned();
    match (request.method(), path.as_str()) {
        (Method::Get, "/healthz") => (200, json!({"status": "ok"})),
        (Method::Post, "/v1/complete") => guarded(router, running, request),
        (_, "/healthz" | "/v1/complete") => error(405, "method_not_allowed", "wrong method"),
        _ => error(404, "not_found", "no such path"),
    }
}

/// No browser, JSON only, and at most `MAX_CONCURRENT_COMPLETIONS` at once.
fn guarded(
    router: &Router,
    running: &AtomicUsize,
    request: &mut tiny_http::Request,
) -> (u16, Value) {
    if header(request, "Origin").is_some() {
        return error(403, "forbidden", "browser requests are not served");
    }
    let json = header(request, "Content-Type").is_some_and(|value| {
        value
            .split(';')
            .next()
            .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("application/json"))
    });
    if !json {
        return error(
            415,
            "unsupported_media_type",
            "Content-Type must be application/json",
        );
    }
    let Some(_slot) = Slot::take(running) else {
        return error(503, "busy", "too many completions at once; retry later");
    };
    complete(router, request)
}

/// One of the `MAX_CONCURRENT_COMPLETIONS` slots, given back on drop.
struct Slot<'a>(&'a AtomicUsize);

impl<'a> Slot<'a> {
    fn take(running: &'a AtomicUsize) -> Option<Self> {
        running
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < MAX_CONCURRENT_COMPLETIONS).then_some(n + 1)
            })
            .ok()
            .map(|_| Self(running))
    }
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn complete(router: &Router, request: &mut tiny_http::Request) -> (u16, Value) {
    if request
        .body_length()
        .is_some_and(|length| length > MAX_BODY_BYTES)
    {
        return too_large();
    }
    let mut raw = Vec::new();
    let limit = u64::try_from(MAX_BODY_BYTES).unwrap_or(u64::MAX) + 1;
    if let Err(problem) = request.as_reader().take(limit).read_to_end(&mut raw) {
        return error(
            400,
            "bad_request",
            &format!("cannot read the body: {problem}"),
        );
    }
    if raw.len() > MAX_BODY_BYTES {
        return too_large();
    }
    let (inference, only) = match parse(&raw) {
        Ok(parsed) => parsed,
        Err(message) => return error(400, "bad_request", &message),
    };

    let outcome = match router.complete_on(&inference, only.as_deref()) {
        Ok(outcome) => outcome,
        Err(unknown) => return error(400, "bad_request", &unknown.to_string()),
    };
    let attempts = attempts_json(&outcome.attempts);
    let (status, mut body) = match outcome.result {
        Ok(answer) => (
            200,
            json!({"backend": answer.backend, "text": answer.text, "attempts": attempts}),
        ),
        Err(RouteError::Stopped { backend, error }) => (
            502,
            json!({"error": {
                "kind": "stopped",
                "backend": backend,
                "message": error.to_string(),
                "attempts": attempts,
            }}),
        ),
        Err(RouteError::Exhausted) => (
            503,
            json!({"error": {
                "kind": "exhausted",
                "message": "every backend failed with a quota or an outage",
                "attempts": attempts,
            }}),
        ),
    };
    if let Some(problem) = outcome.journal_error {
        body["journal_error"] = json!(problem);
    }
    (status, body)
}

fn parse(raw: &[u8]) -> Result<(Inference, Option<String>), String> {
    let value: Value = serde_json::from_slice(raw)
        .map_err(|problem| format!("the body is not JSON: {problem}"))?;
    let prompt = value["prompt"]
        .as_str()
        .ok_or("\"prompt\" must be a string")?;
    if prompt.trim().is_empty() {
        return Err("\"prompt\" is empty".into());
    }
    let system = match &value["system"] {
        Value::Null => None,
        Value::String(system) => Some(system.clone()),
        _ => return Err("\"system\" must be a string".into()),
    };
    let only = match &value["backend"] {
        Value::Null => None,
        Value::String(name) => Some(name.clone()),
        _ => return Err("\"backend\" must be a string".into()),
    };
    Ok((
        Inference {
            prompt: prompt.to_owned(),
            system,
        },
        only,
    ))
}

fn attempts_json(attempts: &[Attempt]) -> Value {
    attempts
        .iter()
        .map(|attempt| {
            json!({
                "backend": attempt.backend,
                "kind": attempt.error.kind(),
                "message": attempt.error.message(),
            })
        })
        .collect()
}

fn too_large() -> (u16, Value) {
    error(
        413,
        "too_large",
        &format!("the body exceeds {MAX_BODY_BYTES} bytes"),
    )
}

fn error(status: u16, kind: &str, message: &str) -> (u16, Value) {
    (status, json!({"error": {"kind": kind, "message": message}}))
}

/// The most completions running at once (8.14(d)).
pub const MAX_CONCURRENT_COMPLETIONS: usize = 4;

/// Take items from `next` and hand each to `handle` until `next` fails;
/// return that error (8.14(c)).
pub fn drive<T>(
    mut next: impl FnMut() -> std::io::Result<T>,
    mut handle: impl FnMut(T),
) -> std::io::Error {
    loop {
        match next() {
            Ok(item) => handle(item),
            Err(error) => return error,
        }
    }
}
