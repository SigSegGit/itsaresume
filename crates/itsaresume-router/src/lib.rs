//! Routes an inference request to the first backend able to answer it.
//!
//! Every backend this crate knows is free at the point of use: a Claude
//! subscription driven through the `claude` CLI, a local LM Studio server, and
//! (later) a small local model. No backend is billed per token, and the set of
//! backends is closed on purpose — see `docs/HANDOVER.md` §1.

pub mod backend;
pub mod claude_code;
pub mod config;
pub mod journal;
pub mod lm_studio;
pub mod router;
pub mod server;

pub use backend::{Backend, BackendError, Completion, Request};
pub use journal::Journal;
pub use router::{Answer, Attempt, NoBackends, Outcome, RouteError, Router};
