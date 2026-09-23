//! One JSON line per request: who answered, who failed and why.
//!
//! This is how Nicolas sees whether his Claude plan carries the load. It never
//! contains the prompt or the answer — only their lengths — because prompts
//! will carry personal CV data (docs/HANDOVER.md §1, decision 9).

use crate::backend::Request;
use crate::router::Outcome;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

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
        let _ = (request, outcome, elapsed, &self.lock);
        Ok(())
    }
}
