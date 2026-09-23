//! The LM Studio backend: its OpenAI-compatible HTTP API, on the XPS.

use crate::backend::{Backend, BackendError, Completion, Request};
use std::time::Duration;

/// LM Studio's `/v1/chat/completions`, with no credential of any kind.
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
}

impl Backend for LmStudioBackend {
    fn name(&self) -> &str {
        "lm-studio"
    }

    fn complete(&self, request: &Request) -> Result<Completion, BackendError> {
        let _ = (request, &self.base_url, &self.model, self.timeout);
        Err(BackendError::QuotaExceeded("not written yet".into()))
    }
}
