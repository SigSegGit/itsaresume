//! The LM Studio backend: its OpenAI-compatible HTTP API, on the XPS.
//!
//! Plain HTTP: across machines the link is Tailscale, which already encrypts
//! it, and on the same machine it is loopback. The response shapes were
//! observed first (`tests/fixtures/lm-studio/`).

use crate::backend::{Backend, BackendError, Completion, Request, excerpt};
use serde_json::{Value, json};
use std::time::Duration;

/// LM Studio's `/v1/chat/completions`, with no credential of any kind.
///
/// There is deliberately no API-key field: pointed at a paid
/// OpenAI-compatible service, this backend gets a 401 (`Other`, the request
/// stops), never a bill (docs/HANDOVER.md §1, decision 1).
#[derive(Debug, Clone)]
pub struct LmStudioBackend {
    base_url: String,
    model: String,
    timeout: Duration,
}

impl LmStudioBackend {
    /// A backend for the server at `base_url` (ending in `/v1`) and `model`.
    pub fn new(base_url: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            model: model.into(),
            timeout: Duration::from_secs(300),
        }
    }

    /// Give up (as `Unreachable`) after this long.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    fn body(&self, request: &Request) -> String {
        let mut messages = Vec::new();
        if let Some(system) = &request.system {
            messages.push(json!({"role": "system", "content": system}));
        }
        messages.push(json!({"role": "user", "content": request.prompt}));
        json!({"model": self.model, "messages": messages, "stream": false}).to_string()
    }
}

impl Backend for LmStudioBackend {
    fn name(&self) -> &str {
        "lm-studio"
    }

    fn complete(&self, request: &Request) -> Result<Completion, BackendError> {
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(self.timeout))
            // Statuses are classified below, with the server's own message.
            .http_status_as_error(false)
            .build()
            .into();

        let mut response = agent
            .post(&url)
            .header("Content-Type", "application/json")
            .send(self.body(request))
            .map_err(|error| transport(&url, error))?;
        let status = response.status().as_u16();
        let body = response
            .body_mut()
            .read_to_string()
            .map_err(|error| transport(&url, error))?;
        classify(status, &body)
    }
}

/// A request that got no HTTP answer at all.
fn transport(url: &str, error: ureq::Error) -> BackendError {
    let detail = format!("LM Studio at {url}: {error}");
    match error {
        ureq::Error::Timeout(_)
        | ureq::Error::HostNotFound
        | ureq::Error::ConnectionFailed
        | ureq::Error::Io(_) => BackendError::Unreachable(detail),
        _ => BackendError::Other(detail),
    }
}

/// An HTTP answer, by status first (docs/ARCHITECTURE.md, LM Studio table).
fn classify(status: u16, body: &str) -> Result<Completion, BackendError> {
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if (200..300).contains(&status) {
        return match parsed["choices"][0]["message"]["content"].as_str() {
            Some(text) => Ok(Completion {
                text: text.to_owned(),
            }),
            None => Err(BackendError::Other(format!(
                "LM Studio answered {status} without choices[0].message.content: {}",
                excerpt(body, 160)
            ))),
        };
    }

    let message = parsed["error"]["message"]
        .as_str()
        .map_or_else(|| excerpt(body, 160), str::to_owned);
    let detail = format!("LM Studio HTTP {status}: {message}");
    // Observed: nothing loaded is a 400. It is the server's state, not the
    // request's, so the next backend may answer.
    if status == 400 && message.contains("No models loaded") {
        return Err(BackendError::Unreachable(detail));
    }
    Err(match status {
        429 => BackendError::QuotaExceeded(detail),
        502..=504 => BackendError::Unreachable(detail),
        _ => BackendError::Other(detail),
    })
}
