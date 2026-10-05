//! The LM Studio backend: its OpenAI-compatible HTTP API, on the XPS.
//!
//! Plain HTTP: across machines the link is Tailscale, which already encrypts
//! it, and on the same machine it is loopback. The response shapes were
//! observed first (`tests/fixtures/lm-studio/`).

use crate::backend::{Backend, BackendError, Completion, Probe, Request, Usage};
use serde_json::{Value, json};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

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
    /// Shared by clones: the server's slots, not this value's.
    slots: Arc<Slots>,
}

/// How many completions may be on the server at once, and how many are.
#[derive(Debug)]
struct Slots {
    free: Mutex<usize>,
    freed: Condvar,
}

impl Slots {
    fn new(count: usize) -> Arc<Self> {
        Arc::new(Self {
            free: Mutex::new(count),
            freed: Condvar::new(),
        })
    }

    /// Take a slot before `deadline`, or `None` once it has passed.
    fn take(self: &Arc<Self>, deadline: Instant) -> Option<Slot> {
        let mut free = self
            .free
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        while *free == 0 {
            let left = deadline.checked_duration_since(Instant::now())?;
            free = self
                .freed
                .wait_timeout(free, left)
                .unwrap_or_else(|poison| poison.into_inner())
                .0;
        }
        *free -= 1;
        Some(Slot(Arc::clone(self)))
    }
}

/// A slot taken; given back on drop, whatever the outcome.
struct Slot(Arc<Slots>);

impl Drop for Slot {
    fn drop(&mut self) {
        *self
            .0
            .free
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) += 1;
        self.0.freed.notify_one();
    }
}

impl LmStudioBackend {
    /// A backend for the server at `base_url` (ending in `/v1`) and `model`.
    pub fn new(base_url: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            model: model.into(),
            timeout: Duration::from_secs(300),
            slots: Slots::new(1),
        }
    }

    /// Give up (as `Unreachable`) after this long.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Let `slots` completions reach the server at once (1 by default: the
    /// local server has one slot, and a request queued there outlives the
    /// caller's timeout). Clones made before this call keep the old slots.
    pub fn with_max_concurrent(mut self, slots: usize) -> Self {
        self.slots = Slots::new(slots);
        self
    }

    fn body(&self, request: &Request) -> String {
        let mut messages = Vec::new();
        if let Some(system) = &request.system {
            messages.push(json!({"role": "system", "content": system}));
        }
        messages.push(json!({"role": "user", "content": request.prompt}));
        let mut body = json!({"model": self.model, "messages": messages, "stream": false});
        if let Some(schema) = &request.schema {
            // Observed honoured by Bionic (2026-09-30): the content is the
            // JSON document alone.
            body["response_format"] = json!({
                "type": "json_schema",
                "json_schema": {"name": "answer", "schema": schema, "strict": true},
            });
        }
        body.to_string()
    }
}

impl Backend for LmStudioBackend {
    fn name(&self) -> &str {
        "lm-studio"
    }

    /// Two GETs, a few seconds at most: is the server there, does it list
    /// the model, and is the model in memory (LM Studio's `/api/v0`, which
    /// an OpenAI-compatible server without it simply lacks).
    fn probe(&self) -> Option<Probe> {
        let base = self.base_url.trim_end_matches('/');
        let listed = match get_json(&format!("{base}/models")) {
            Ok(body) => body,
            Err(why) => return Some(Probe::Down(why)),
        };
        let has = |body: &Value| {
            body["data"]
                .as_array()
                .and_then(|models| models.iter().find(|m| m["id"] == self.model.as_str()))
                .cloned()
        };
        if has(&listed).is_none() {
            return Some(Probe::Down(format!(
                "the server does not list {}",
                self.model
            )));
        }
        let root = base.strip_suffix("/v1").unwrap_or(base);
        let loaded = get_json(&format!("{root}/api/v0/models"))
            .ok()
            .and_then(|body| has(&body))
            .and_then(|model| model["state"].as_str().map(|state| state == "loaded"));
        Some(Probe::Up { loaded })
    }

    fn complete(&self, request: &Request) -> Result<Completion, BackendError> {
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        // Waiting for the slot counts against the timeout: past it, this is
        // an outage (the router falls back) and the server never sees it.
        let deadline = Instant::now() + self.timeout;
        let Some(_slot) = self.slots.take(deadline) else {
            return Err(BackendError::Unreachable(format!(
                "LM Studio at {url}: no free slot within {:?} (another completion holds it)",
                self.timeout
            )));
        };
        let left = deadline.saturating_duration_since(Instant::now());
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(left))
            // The prompts hold a whole CV: never through a proxy taken from
            // the environment (ureq reads HTTP_PROXY and ALL_PROXY by default).
            .proxy(None)
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
        let completion = classify(status, &body)?;
        if request.schema.is_some() && serde_json::from_str::<Value>(&completion.text).is_err() {
            return Err(BackendError::Other(format!(
                "LM Studio answered a schema request with text that is not JSON ({} characters)",
                completion.text.chars().count()
            )));
        }
        Ok(completion)
    }
}

/// A short GET for [`LmStudioBackend::probe`]: the JSON of a 2xx, else why not.
fn get_json(url: &str) -> Result<Value, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(PROBE_TIMEOUT))
        // A probe sends nothing private; no proxy all the same.
        .proxy(None::<ureq::Proxy>)
        .http_status_as_error(false)
        .build()
        .into();
    let mut response = agent
        .get(url)
        .call()
        .map_err(|error| format!("unreachable: {error}"))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("answered {status}"));
    }
    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|error| format!("unreachable: {error}"))?;
    serde_json::from_str(&body).map_err(|_| format!("answered {status} without JSON"))
}

/// How long a probe waits: the status page must not hang on a dead tunnel.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

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

/// The tokens of an OpenAI-compatible `usage` (8.38); `None` when absent.
fn usage_of(parsed: &Value) -> Option<Usage> {
    let usage = parsed.get("usage").filter(|usage| usage.is_object())?;
    let count = |key: &str| usage[key].as_u64().unwrap_or(0);
    Some(Usage {
        input: count("prompt_tokens"),
        output: count("completion_tokens"),
        ..Usage::default()
    })
}

/// An HTTP answer, by status first (docs/ARCHITECTURE.md, LM Studio table).
fn classify(status: u16, body: &str) -> Result<Completion, BackendError> {
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if (200..300).contains(&status) {
        // Cut at the token or context limit, the answer is half a document;
        // empty, it is none. Both would pass for a success otherwise.
        if parsed["choices"][0]["finish_reason"] == "length" {
            return Err(BackendError::Other(format!(
                "LM Studio answer truncated at the token or context limit (finish_reason length, {status})"
            )));
        }
        return match parsed["choices"][0]["message"]["content"].as_str() {
            Some("") => Err(BackendError::Other(format!(
                "LM Studio answered {status} with an empty answer"
            ))),
            Some(text) => Ok(Completion {
                text: text.to_owned(),
                rate_limit: None,
                usage: usage_of(&parsed),
            }),
            None => Err(BackendError::Other(format!(
                "LM Studio answered {status} without choices[0].message.content ({} characters)",
                body.chars().count()
            ))),
        };
    }

    let message = parsed["error"]["message"].as_str().map_or_else(
        || format!("{} characters", body.chars().count()),
        str::to_owned,
    );
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
