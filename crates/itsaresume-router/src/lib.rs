//! Routes an inference request to the first backend able to answer it.
//!
//! Every backend is billed one known way ([`Billing`]): a Claude subscription
//! driven through the `claude` CLI, a free tier, a local LM Studio server, or
//! (2026-11-24, the owner) Anthropic's API for customers. Each request is the
//! owner's or a customer's ([`Audience`]); a customer's never reaches a
//! billing the configuration does not allow it (`customer_billing`, the API
//! alone by default). The set of backends stays closed on purpose — see
//! `docs/HANDOVER.md` §1.

pub mod backend;
pub mod claude_code;
pub mod config;
pub mod gemini_cli;
pub mod journal;
pub mod lm_studio;
pub mod openai;
pub mod router;
pub mod server;
pub mod stats;

pub use backend::{
    Audience, Backend, BackendError, Billing, Completion, Kind, Probe, Request, Usage,
};
pub use journal::Journal;
pub use router::{
    Answer, Attempt, BackendStatus, CustomerBudget, NoBackends, Outcome, RouteError, Router,
};
