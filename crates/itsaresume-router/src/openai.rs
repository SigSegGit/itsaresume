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

/// The OpenAI backend.
#[derive(Debug, Clone)]
pub struct OpenAiBackend {
    inner: LmStudioBackend,
}

impl OpenAiBackend {
    /// A backend for `base_url` (ending in `/v1`) and `model`, with `key`
    /// (`None`: every request stops, nothing is sent).
    pub fn new(base_url: impl Into<String>, model: impl Into<String>, key: Option<String>) -> Self {
        let mut inner = LmStudioBackend::new(base_url, model).with_max_concurrent(4);
        inner.bearer = key.filter(|k| !k.is_empty());
        inner.schema_as_rule = true;
        inner.label = "openai";
        Self { inner }
    }

    /// Give up (as `Unreachable`) after this long.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.inner = self.inner.with_timeout(timeout);
        self
    }
}

impl Backend for OpenAiBackend {
    fn name(&self) -> &str {
        "openai"
    }

    fn probe(&self) -> Option<Probe> {
        None
    }

    fn complete(&self, request: &Request) -> Result<Completion, BackendError> {
        if self.inner.bearer.is_none() {
            return Err(BackendError::Other(format!(
                "openai: {KEY_ENV} is not in the router's environment"
            )));
        }
        self.inner.complete(request)
    }
}
