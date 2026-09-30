//! What a backend is, and the three ways it can fail.

use std::fmt;

/// One inference request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    /// The user prompt. Never logged (docs/HANDOVER.md §1, decision 9).
    pub prompt: String,
    /// An optional system prompt.
    pub system: Option<String>,
    /// An optional JSON Schema the answer must follow (structured output):
    /// the answer is then a JSON document, or the request fails as `Other`.
    pub schema: Option<serde_json::Value>,
    /// What is asked (M2): a generation, or a classification a small model
    /// can serve. Generation by default.
    pub kind: Kind,
}

/// The kind of a request (M2): a backend serves the kinds it declares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// A document or an answer of any length: the default.
    #[default]
    Generate,
    /// A short choice among given options.
    Classify,
}

impl Request {
    /// A request with a prompt and no system prompt.
    pub fn new(prompt: impl Into<String>) -> Self {
        Self {
            prompt: prompt.into(),
            system: None,
            schema: None,
            kind: Kind::Generate,
        }
    }

    /// The same request, of `kind`.
    pub fn with_kind(mut self, kind: Kind) -> Self {
        self.kind = kind;
        self
    }

    /// The same request, asking for an answer that follows `schema`.
    pub fn with_schema(mut self, schema: serde_json::Value) -> Self {
        self.schema = Some(schema);
        self
    }
}

/// A backend's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Completion {
    /// The generated text.
    pub text: String,
    /// What the backend reported about the plan's limits with this answer
    /// (Claude's `rate_limit_event`), for the journal (M4); `None` when it
    /// reports nothing.
    pub rate_limit: Option<serde_json::Value>,
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

/// The first `max_chars` characters of `text`, with `…` when something was cut.
pub(crate) fn excerpt(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let kept: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        kept + "…"
    } else {
        kept
    }
}

/// An inference backend. The set of implementations is closed: every one of
/// them is free at the point of use (docs/HANDOVER.md §1, decision 1).
pub trait Backend: Send + Sync {
    /// A short stable name, as written in the journal (`claude-code`, …).
    fn name(&self) -> &str;

    /// Whether this backend serves requests of `kind` (all, by default).
    fn serves(&self, kind: Kind) -> bool {
        let _ = kind;
        true
    }

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
