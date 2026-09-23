//! What a backend is, and the three ways it can fail.

use std::fmt;

/// One inference request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    /// The user prompt. Never logged (docs/HANDOVER.md §1, decision 9).
    pub prompt: String,
    /// An optional system prompt.
    pub system: Option<String>,
}

impl Request {
    /// A request with a prompt and no system prompt.
    pub fn new(prompt: impl Into<String>) -> Self {
        Self {
            prompt: prompt.into(),
            system: None,
        }
    }
}

/// A backend's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Completion {
    /// The generated text.
    pub text: String,
}

/// Why a backend did not answer. The kind decides whether the router tries
/// the next backend: see [`BackendError::allows_fallback`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendError {
    /// A usage allowance is spent (a Claude plan limit, an HTTP 429).
    QuotaExceeded(String),
    /// The backend could not be reached or did not answer in time.
    Unreachable(String),
    /// Anything else: a refused request, an output nobody understood, a
    /// misconfiguration, a billing tripwire.
    Other(String),
}

impl BackendError {
    /// Whether the router may hand this request to the next backend.
    ///
    /// Only a quota or an outage does: those describe the *backend's* state,
    /// which the next backend does not share. [`BackendError::Other`] never
    /// does, on purpose — it is either about the request (the next backend
    /// would fail the same way) or a condition a human must fix (not logged
    /// in, API-key billing, a changed output format). Falling back on it would
    /// turn a loud, fixable error into a silent, permanent downgrade.
    pub fn allows_fallback(&self) -> bool {
        match self {
            Self::QuotaExceeded(_) | Self::Unreachable(_) => true,
            Self::Other(_) => false,
        }
    }

    /// A stable machine name for the kind, as written in the journal.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::QuotaExceeded(_) => "quota_exceeded",
            Self::Unreachable(_) => "unreachable",
            Self::Other(_) => "other",
        }
    }

    /// The human-readable detail.
    pub fn message(&self) -> &str {
        match self {
            Self::QuotaExceeded(m) | Self::Unreachable(m) | Self::Other(m) => m,
        }
    }
}

impl fmt::Display for BackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind(), self.message())
    }
}

impl std::error::Error for BackendError {}

/// An inference backend. The set of implementations is closed: every one of
/// them is free at the point of use (docs/HANDOVER.md §1, decision 1).
pub trait Backend: Send + Sync {
    /// A short stable name, as written in the journal (`claude-code`, …).
    fn name(&self) -> &str;

    /// Answer one request, or say which of the three ways it failed.
    fn complete(&self, request: &Request) -> Result<Completion, BackendError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rule the whole router rests on: quota and outage fall back, and
    /// nothing else does.
    #[test]
    fn only_quota_and_unreachable_allow_fallback() {
        assert!(BackendError::QuotaExceeded("limit".into()).allows_fallback());
        assert!(BackendError::Unreachable("down".into()).allows_fallback());
        assert!(
            !BackendError::Other("bad request".into()).allows_fallback(),
            "Other must never fall back: it would hide a fixable error behind the next backend"
        );
    }

    /// The journal and the HTTP error bodies depend on these exact strings.
    #[test]
    fn kinds_have_stable_names() {
        assert_eq!(
            BackendError::QuotaExceeded(String::new()).kind(),
            "quota_exceeded"
        );
        assert_eq!(
            BackendError::Unreachable(String::new()).kind(),
            "unreachable"
        );
        assert_eq!(BackendError::Other(String::new()).kind(), "other");
    }
}
