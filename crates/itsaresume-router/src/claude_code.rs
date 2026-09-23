//! The Claude Code backend: the `claude` CLI, paid for by a subscription.
//!
//! The output shapes this module relies on were observed before it was
//! written (docs/HANDOVER.md §4; fixtures in `tests/fixtures/claude/`).

use crate::backend::{BackendError, Completion};

/// Classify what `claude -p --output-format json --verbose` printed.
pub fn classify(stdout: &str) -> Result<Completion, BackendError> {
    let _ = stdout;
    Err(BackendError::Unreachable("not written yet".into()))
}
