//! Tries backends in order; falls back on quota or outage, stops on anything else.

use crate::backend::{Backend, BackendError, Request};
use crate::journal::Journal;
use std::fmt;
use std::time::Instant;

/// One backend that failed, in the order it was tried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attempt {
    /// The backend's name.
    pub backend: String,
    /// How it failed.
    pub error: BackendError,
}

/// A successful answer and who gave it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    /// The name of the backend that answered.
    pub backend: String,
    /// The generated text.
    pub text: String,
}

/// Why no answer came back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteError {
    /// A backend failed with an error that does not allow fallback
    /// ([`BackendError::Other`]); the backends after it were not tried.
    Stopped {
        /// The backend that stopped the request.
        backend: String,
        /// Its error.
        error: BackendError,
    },
    /// Every backend failed with an error that allows fallback.
    Exhausted,
}

impl fmt::Display for RouteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Stopped { backend, error } => write!(f, "stopped by {backend}: {error}"),
            Self::Exhausted => write!(f, "every backend failed with a quota or an outage"),
        }
    }
}

impl std::error::Error for RouteError {}

/// Everything the router knows about one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    /// The answer, or why there is none.
    pub result: Result<Answer, RouteError>,
    /// Every backend that failed, in order (the one that stopped included).
    pub attempts: Vec<Attempt>,
    /// Set when the journal line could not be written. The answer is still
    /// returned: it has already been paid for in plan usage or GPU time.
    pub journal_error: Option<String>,
}

/// A router was built with no backend at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoBackends;

impl fmt::Display for NoBackends {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "a router needs at least one backend")
    }
}

impl std::error::Error for NoBackends {}

/// Sends each request to the first backend able to answer it.
pub struct Router {
    backends: Vec<Box<dyn Backend>>,
    journal: Journal,
}

impl Router {
    /// A router over `backends`, tried in this order, recording every
    /// request in `journal`.
    pub fn new(backends: Vec<Box<dyn Backend>>, journal: Journal) -> Result<Self, NoBackends> {
        if backends.is_empty() {
            return Err(NoBackends);
        }
        Ok(Self { backends, journal })
    }

    /// Answer `request` from the first backend that can, and journal it.
    pub fn complete(&self, request: &Request) -> Outcome {
        let started = Instant::now();
        let mut outcome = self.route(request);
        if let Err(error) = self.journal.record(request, &outcome, started.elapsed()) {
            outcome.journal_error = Some(format!(
                "could not append to {}: {error}",
                self.journal.path().display()
            ));
        }
        outcome
    }

    fn route(&self, request: &Request) -> Outcome {
        let mut attempts = Vec::new();
        for backend in &self.backends {
            let error = match backend.complete(request) {
                Ok(completion) => {
                    let answer = Answer {
                        backend: backend.name().to_owned(),
                        text: completion.text,
                    };
                    return Outcome {
                        result: Ok(answer),
                        attempts,
                        journal_error: None,
                    };
                }
                Err(error) => error,
            };
            let stop = !error.allows_fallback();
            attempts.push(Attempt {
                backend: backend.name().to_owned(),
                error: error.clone(),
            });
            if stop {
                let stopped = RouteError::Stopped {
                    backend: backend.name().to_owned(),
                    error,
                };
                return Outcome {
                    result: Err(stopped),
                    attempts,
                    journal_error: None,
                };
            }
        }
        Outcome {
            result: Err(RouteError::Exhausted),
            attempts,
            journal_error: None,
        }
    }
}
