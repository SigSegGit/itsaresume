//! The Claude Code backend: the `claude` CLI, paid for by a subscription.
//!
//! The output shapes this module relies on were observed before it was
//! written (docs/HANDOVER.md §4; fixtures in `tests/fixtures/claude/`).

use crate::backend::{Backend, BackendError, Completion, Request};
use serde_json::Value;
use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;

/// The only billing source accepted: the subscription (OAuth) path. Observed
/// values: `"none"` logged out or on OAuth, `"ANTHROPIC_API_KEY"` when that
/// variable is set. Claude Code also knows `"apiKeyHelper"` and
/// `"/login managed key"`; both are metered and refused.
pub const SUBSCRIPTION_BILLING_SOURCE: &str = "none";

/// Classify what `claude -p --output-format json --verbose` printed.
///
/// Order matters: the billing and tool tripwires are checked before the
/// result, so an answer that was billed per token is refused even when it
/// succeeded (docs/ARCHITECTURE.md, "Billing guards").
pub fn classify(stdout: &str) -> Result<Completion, BackendError> {
    let messages: Vec<Value> = serde_json::from_str(stdout.trim()).map_err(|error| {
        BackendError::Other(format!(
            "claude output is not the expected JSON array ({error}): {}",
            excerpt(stdout)
        ))
    })?;

    let init = messages
        .iter()
        .find(|message| message["type"] == "system" && message["subtype"] == "init")
        .ok_or_else(|| {
            BackendError::Other(
                "claude output has no system/init message, so its billing source cannot be \
                 verified; refusing"
                    .into(),
            )
        })?;

    let billing = init["apiKeySource"].as_str().unwrap_or("<missing>");
    if billing != SUBSCRIPTION_BILLING_SOURCE {
        return Err(BackendError::Other(format!(
            "billing tripwire: claude reports apiKeySource={billing}, which is billed per \
             token; itsaresume only uses the subscription (docs/HANDOVER.md §1). Remove that \
             credential from the environment or settings of the process running claude"
        )));
    }

    let tools_empty = init["tools"].as_array().is_some_and(Vec::is_empty);
    if !tools_empty {
        return Err(BackendError::Other(format!(
            "tool tripwire: claude started with tools {}; prompts may carry injected \
             instructions and must find no tool to call",
            init["tools"]
        )));
    }

    let result = messages
        .iter()
        .rev()
        .find(|message| message["type"] == "result")
        .ok_or_else(|| BackendError::Other("claude output has no result message".into()))?;

    let text = result["result"].as_str();
    match (result["is_error"].as_bool(), text) {
        (Some(false), Some(text)) => Ok(Completion {
            text: text.to_owned(),
        }),
        (Some(true), text) => Err(classify_error(
            result["api_error_status"].as_u64(),
            text.unwrap_or(""),
        )),
        _ => Err(BackendError::Other(format!(
            "claude result message is not understood: {}",
            excerpt(&result.to_string())
        ))),
    }
}

/// An `is_error: true` result, by HTTP status first, then by wording.
fn classify_error(status: Option<u64>, message: &str) -> BackendError {
    let detail = match status {
        Some(status) => format!("claude error (HTTP {status}): {message}"),
        None => format!("claude error: {message}"),
    };
    match status {
        Some(429) => BackendError::QuotaExceeded(detail),
        Some(500..=504 | 529) => BackendError::Unreachable(detail),
        Some(_) => BackendError::Other(detail),
        None if looks_like_usage_limit(message) => BackendError::QuotaExceeded(detail),
        None if looks_like_connection_failure(message) => BackendError::Unreachable(detail),
        None => BackendError::Other(detail),
    }
}

/// Hypothesis, not observed (docs/HANDOVER.md §9): the wordings Claude Code
/// has used for plan limits. A limit message that matches none of them is
/// classified `Other` and stops loudly, which is the safe direction.
fn looks_like_usage_limit(message: &str) -> bool {
    let message = message.to_lowercase();
    if message.contains("context") || message.contains("too long") {
        return false;
    }
    message.contains("usage limit")
        || message.contains("limit reached")
        || (message.contains("hit your") && message.contains("limit"))
}

/// Hypothesis, not observed: how a network failure reads without a status.
fn looks_like_connection_failure(message: &str) -> bool {
    let message = message.to_lowercase();
    [
        "connection error",
        "unable to connect",
        "econnrefused",
        "etimedout",
        "timed out",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

/// The start of an output, for error messages.
fn excerpt(text: &str) -> String {
    let mut chars = text.chars();
    let kept: String = chars.by_ref().take(160).collect();
    if chars.next().is_some() {
        kept + "…"
    } else {
        kept
    }
}

/// Environment variables that switch the `claude` CLI to per-token billing or
/// to a metered provider. They are removed from the child's environment.
/// `CLAUDE_CODE_OAUTH_TOKEN` (the subscription token) is deliberately absent.
pub const METERED_ENV: &[&str] = &[];

/// The Claude Code backend: `claude -p` in a child process.
#[derive(Debug, Clone)]
pub struct ClaudeCodeBackend {
    program: PathBuf,
    model: Option<String>,
    timeout: Duration,
    workdir: PathBuf,
}

impl ClaudeCodeBackend {
    /// A backend running `program` (a path, or a name looked up on `PATH`).
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            model: None,
            timeout: Duration::from_secs(300),
            workdir: std::env::temp_dir().join("itsaresume-claude"),
        }
    }

    /// Pass `--model <model>` to the CLI.
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    /// Kill the CLI and report `Unreachable` after this long.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// The directory the CLI runs in (created if missing).
    pub fn with_workdir(mut self, workdir: impl Into<PathBuf>) -> Self {
        self.workdir = workdir.into();
        self
    }

    /// Run one request with `env` as the environment the child would inherit.
    pub fn complete_with_env(
        &self,
        request: &Request,
        env: impl IntoIterator<Item = (OsString, OsString)>,
    ) -> Result<Completion, BackendError> {
        let _ = (
            request,
            env.into_iter().count(),
            &self.program,
            &self.model,
            self.timeout,
            &self.workdir,
        );
        Err(BackendError::Other("not written yet".into()))
    }
}

impl Backend for ClaudeCodeBackend {
    fn name(&self) -> &str {
        "claude-code"
    }

    fn complete(&self, request: &Request) -> Result<Completion, BackendError> {
        self.complete_with_env(request, std::env::vars_os())
    }
}
