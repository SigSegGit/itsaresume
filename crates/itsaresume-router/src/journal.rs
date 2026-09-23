//! One JSON line per request: who answered, who failed and why.
//!
//! This is how Nicolas sees whether his Claude plan carries the load. It never
//! contains the prompt or the answer — only their lengths — because prompts
//! will carry personal CV data (docs/HANDOVER.md §1, decision 9).

use crate::backend::Request;
use crate::router::{Outcome, RouteError};
use serde_json::{Value, json};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

/// How many characters of an error message the journal keeps.
pub const MESSAGE_CHARS: usize = 200;

/// An append-only JSONL file.
#[derive(Debug)]
pub struct Journal {
    path: PathBuf,
    // One writer at a time within this process, so two server threads never
    // interleave half-lines.
    lock: Mutex<()>,
}

impl Journal {
    /// A journal appending to `path` (created on first write).
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            lock: Mutex::new(()),
        }
    }

    /// The file this journal appends to.
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    /// Append one line describing `outcome` for `request`.
    pub fn record(
        &self,
        request: &Request,
        outcome: &Outcome,
        elapsed: Duration,
    ) -> std::io::Result<()> {
        let (label, backend, answer_chars) = match &outcome.result {
            Ok(answer) => (
                "answered",
                Some(answer.backend.as_str()),
                Some(answer.text.chars().count()),
            ),
            Err(RouteError::Stopped { backend, .. }) => ("stopped", Some(backend.as_str()), None),
            Err(RouteError::Exhausted) => ("exhausted", None, None),
        };
        let attempts: Vec<Value> = outcome
            .attempts
            .iter()
            .map(|attempt| {
                json!({
                    "backend": attempt.backend,
                    "kind": attempt.error.kind(),
                    "message": truncate(attempt.error.message()),
                })
            })
            .collect();
        // Lengths only: the prompt, the system prompt and the answer are
        // never written (module documentation).
        let entry = json!({
            "ts": humantime::format_rfc3339_millis(SystemTime::now()).to_string(),
            "outcome": label,
            "backend": backend,
            "attempts": attempts,
            "duration_ms": u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
            "prompt_chars": request.prompt.chars().count(),
            "answer_chars": answer_chars,
        });
        let mut line = entry.to_string();
        line.push('\n');

        let _guard = self
            .lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        // One write call per line, so concurrent appenders cannot interleave
        // inside a line.
        file.write_all(line.as_bytes())
    }
}

/// At most [`MESSAGE_CHARS`] characters, with `…` when something was cut.
fn truncate(message: &str) -> String {
    let mut chars = message.chars();
    let kept: String = chars.by_ref().take(MESSAGE_CHARS).collect();
    if chars.next().is_some() {
        kept + "…"
    } else {
        kept
    }
}
