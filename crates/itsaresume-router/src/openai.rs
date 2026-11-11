//! The OpenAI backend: the owner's free-tier service-account key (decision
//! of 2026-10-14: no overage possible on that account), read from
//! `OPENAI_API_KEY` in the router's environment, never from a file in a
//! repository or the configuration. The chat-completions client is
//! [`LmStudioBackend`]'s; a 429 (`insufficient_quota` included) falls back.

use crate::backend::{Backend, BackendError, Completion, Probe, Request};
use crate::lm_studio::LmStudioBackend;
use std::time::Duration;

/// The variable the key is read from.
pub const KEY_ENV: &str = "OPENAI_API_KEY";

/// 2.36: Groq's OpenAI-compatible API, its free tier (no payment method on
/// the owner's account, so nothing can be billed): a fixed address and its
/// own key variable, so a configuration never sends a key elsewhere.
pub const GROQ_URL: &str = "https://api.groq.com/openai/v1";
/// The variable Groq's key is read from.
pub const GROQ_KEY_ENV: &str = "GROQ_API_KEY";

/// The OpenAI backend (and Groq's, the same protocol).
#[derive(Debug, Clone)]
pub struct OpenAiBackend {
    inner: LmStudioBackend,
    kind: &'static str,
    key_env: &'static str,
}

impl OpenAiBackend {
    /// A backend for `base_url` (ending in `/v1`) and `model`, with `key`
    /// (`None`: every request stops, nothing is sent).
    pub fn new(base_url: impl Into<String>, model: impl Into<String>, key: Option<String>) -> Self {
        let mut inner = LmStudioBackend::new(base_url, model).with_max_concurrent(4);
        inner.bearer = key.filter(|k| !k.is_empty());
        inner.schema_as_rule = true;
        inner.label = "openai";
        Self {
            inner,
            kind: "openai",
            key_env: KEY_ENV,
        }
    }

    /// Groq's backend for `model`, with `key` (`None`: every request stops).
    pub fn groq(model: impl Into<String>, key: Option<String>) -> Self {
        Self::groq_at(GROQ_URL, model, key)
    }

    /// Groq's backend at `base_url`: for tests only, a configuration has
    /// no address for Groq (see [`OpenAiBackend::groq`]).
    #[doc(hidden)]
    pub fn groq_at(base_url: &str, model: impl Into<String>, key: Option<String>) -> Self {
        let mut backend = Self::new(base_url, model, key);
        backend.inner.label = "groq";
        backend.inner.reasoning_effort = Some("low");
        backend.inner.wait_rate_limit = true;
        backend.kind = "groq";
        backend.key_env = GROQ_KEY_ENV;
        backend
    }

    /// Give up (as `Unreachable`) after this long.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.inner = self.inner.with_timeout(timeout);
        self
    }
}

impl Backend for OpenAiBackend {
    fn name(&self) -> &str {
        self.kind
    }

    fn probe(&self) -> Option<Probe> {
        None
    }

    fn complete(&self, request: &Request) -> Result<Completion, BackendError> {
        if self.inner.bearer.is_none() {
            return Err(BackendError::Other(format!(
                "{}: {} is not in the router's environment",
                self.kind, self.key_env
            )));
        }
        self.inner.complete(request)
    }
}
