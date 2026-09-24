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
use tiny_http::{Header, Method, Response};

/// Where `serve` listens unless told otherwise: loopback only, because the
/// endpoint has no authentication and spends Nicolas's plan.
pub const DEFAULT_LISTEN: &str = "127.0.0.1:8787";

/// The largest request body accepted, in bytes.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

/// A bound, not yet running, HTTP endpoint.
pub struct Server {
    http: tiny_http::Server,
    router: Arc<Router>,
    address: SocketAddr,
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
        })
    }

    /// The address actually bound.
    pub fn local_addr(&self) -> SocketAddr {
        self.address
    }

    /// Serve requests until the process ends, one thread per request: a
    /// Claude answer can take minutes and must not hold up health checks.
    pub fn run(self) {
        for request in self.http.incoming_requests() {
            let router = Arc::clone(&self.router);
            std::thread::spawn(move || respond(&router, request));
        }
    }
}

fn respond(router: &Router, mut request: tiny_http::Request) {
    let (status, body) = route(router, &mut request);
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
        .expect("a constant, valid header");
    let response = Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(header);
    // The client may have gone away; there is nobody left to tell.
    let _ = request.respond(response);
}

fn route(router: &Router, request: &mut tiny_http::Request) -> (u16, Value) {
    let path = request
        .url()
        .split('?')
        .next()
        .unwrap_or_default()
        .to_owned();
    match (request.method(), path.as_str()) {
        (Method::Get, "/healthz") => (200, json!({"status": "ok"})),
        (Method::Post, "/v1/complete") => complete(router, request),
        (_, "/healthz" | "/v1/complete") => error(405, "method_not_allowed", "wrong method"),
        _ => error(404, "not_found", "no such path"),
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
    let inference = match parse(&raw) {
        Ok(inference) => inference,
        Err(message) => return error(400, "bad_request", &message),
    };

    let outcome = router.complete(&inference);
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

fn parse(raw: &[u8]) -> Result<Inference, String> {
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
    Ok(Inference {
        prompt: prompt.to_owned(),
        system,
    })
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
