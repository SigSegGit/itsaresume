//! Tries backends in order; falls back on quota or outage, stops on anything else.

use crate::backend::{Backend, BackendError, Probe, Request};
use crate::journal::Journal;
use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

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
    /// The backend's report on the plan's limits, if any (8.32).
    pub rate_limit: Option<serde_json::Value>,
    /// The tokens the answering backend reported (8.38).
    pub usage: Option<crate::backend::Usage>,
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
    /// No configured backend serves the request's kind (8.34).
    Unserved {
        /// The kind asked for.
        kind: crate::backend::Kind,
    },
}

impl fmt::Display for RouteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Stopped { backend, error } => write!(f, "stopped by {backend}: {error}"),
            Self::Exhausted => write!(f, "every backend failed with a quota or an outage"),
            Self::Unserved { kind } => write!(f, "no configured backend serves {kind:?} requests"),
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

/// A request named a backend the router does not have.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownBackend {
    /// The name asked for.
    pub name: String,
    /// The names the router has, in order.
    pub configured: Vec<String>,
}

impl fmt::Display for UnknownBackend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "unknown backend \"{}\"; configured: {}",
            self.name,
            self.configured.join(", ")
        )
    }
}

impl std::error::Error for UnknownBackend {}

/// Sends each request to the first backend able to answer it.
pub struct Router {
    backends: Vec<Box<dyn Backend>>,
    journal: Journal,
    /// Each backend's last answer, by name: what `status` says of a backend
    /// that has no probe (8.43). In memory: a restart forgets it.
    seen: Mutex<HashMap<String, Seen>>,
}

/// A backend's last answer: when (Unix seconds), and its error if it failed.
#[derive(Debug, Clone)]
struct Seen {
    at: u64,
    error: Option<BackendError>,
    /// The rate limit's `status` of a successful answer (`allowed`,
    /// `allowed_warning`), when the backend reported one (8.44).
    usage: Option<String>,
}

/// One backend's state for `GET /status` (8.43).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendStatus {
    /// Its configured name.
    pub name: String,
    /// What it is (`claude-code`, `lm-studio`).
    pub kind: String,
    /// `up`, `down`, `limited` (a quota), `stopped` (an error that is not an
    /// outage: logged out, a tripwire), or `unknown` (no probe, never asked).
    pub state: &'static str,
    /// Why it is not up, when known.
    pub reason: Option<String>,
    /// Whether its model is in memory, when its probe tells.
    pub loaded: Option<bool>,
    /// When the state was last seen (Unix seconds); none for a probe.
    pub since: Option<u64>,
    /// How spent its allowance was at its last answer (`allowed`,
    /// `allowed_warning`), when it said (8.44).
    pub usage: Option<String>,
}

impl Router {
    /// A router over `backends`, tried in this order, recording every
    /// request in `journal`.
    pub fn new(backends: Vec<Box<dyn Backend>>, journal: Journal) -> Result<Self, NoBackends> {
        if backends.is_empty() {
            return Err(NoBackends);
        }
        Ok(Self {
            backends,
            journal,
            seen: Mutex::new(HashMap::new()),
        })
    }

    /// Each backend's state, from its probe when it has one, else from its
    /// last answer; no request is spent (8.43).
    pub fn status(&self) -> Vec<BackendStatus> {
        let seen = self
            .seen
            .lock()
            .map(|seen| seen.clone())
            .unwrap_or_default();
        self.backends
            .iter()
            .map(|backend| {
                let (state, reason, loaded, since) = match backend.probe() {
                    Some(Probe::Up { loaded }) => ("up", None, loaded, None),
                    Some(Probe::Down(why)) => ("down", Some(why), None, None),
                    None => match seen.get(backend.name()) {
                        None => ("unknown", None, None, None),
                        Some(Seen {
                            at, error: None, ..
                        }) => ("up", None, None, Some(*at)),
                        Some(Seen {
                            at,
                            error: Some(error),
                            ..
                        }) => {
                            let state = match error {
                                BackendError::QuotaExceeded(_) => "limited",
                                BackendError::Unreachable(_) => "down",
                                BackendError::Other(_) => "stopped",
                            };
                            (state, Some(error.to_string()), None, Some(*at))
                        }
                    },
                };
                BackendStatus {
                    name: backend.name().to_owned(),
                    kind: backend.kind().to_owned(),
                    state,
                    reason,
                    loaded,
                    since,
                    usage: seen.get(backend.name()).and_then(|seen| seen.usage.clone()),
                }
            })
            .collect()
    }

    fn remember(&self, backend: &str, error: Option<BackendError>, usage: Option<String>) {
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs());
        if let Ok(mut seen) = self.seen.lock() {
            seen.insert(backend.to_owned(), Seen { at, error, usage });
        }
    }

    /// Answer `request` from the first backend that can, and journal it.
    pub fn complete(&self, request: &Request) -> Outcome {
        let all: Vec<&dyn Backend> = self.backends.iter().map(AsRef::as_ref).collect();
        self.journaled(request, None, &all)
    }

    fn journaled(
        &self,
        request: &Request,
        asked: Option<&str>,
        backends: &[&dyn Backend],
    ) -> Outcome {
        let started = Instant::now();
        let mut outcome = self.route(request, backends);
        if let Err(error) = self
            .journal
            .record_asked(request, asked, &outcome, started.elapsed())
        {
            outcome.journal_error = Some(format!(
                "could not append to {}: {error}",
                self.journal.path().display()
            ));
        }
        outcome
    }

    /// Answer `request`, from the backend named `only` alone when given.
    ///
    /// Named, there is no fallback: the caller asked for that backend (to
    /// measure one model, say), so its quota or outage is the answer.
    pub fn complete_on(
        &self,
        request: &Request,
        only: Option<&str>,
    ) -> Result<Outcome, UnknownBackend> {
        let chosen: Vec<&dyn Backend> = match only {
            None => self.backends.iter().map(AsRef::as_ref).collect(),
            // The configured name first, else the first backend of that kind.
            Some(name) => match (self.backends.iter().find(|b| b.name() == name))
                .or_else(|| self.backends.iter().find(|b| b.kind() == name))
            {
                Some(backend) => vec![backend.as_ref()],
                None => {
                    return Err(UnknownBackend {
                        name: name.to_owned(),
                        configured: self.backends.iter().map(|b| b.name().to_owned()).collect(),
                    });
                }
            },
        };
        Ok(self.journaled(request, only, &chosen))
    }

    fn route(&self, request: &Request, backends: &[&dyn Backend]) -> Outcome {
        let mut attempts = Vec::new();
        // M2: a backend that does not serve the request's kind is not tried
        // at all: not an attempt, not a failure (a small model never gets
        // a generation).
        let serving: Vec<&dyn Backend> = backends
            .iter()
            .copied()
            .filter(|backend| backend.serves(request.kind))
            .collect();
        if serving.is_empty() {
            return Outcome {
                result: Err(RouteError::Unserved { kind: request.kind }),
                attempts,
                journal_error: None,
            };
        }
        for backend in serving {
            let error = match backend.complete(request) {
                Ok(completion) => {
                    let usage = completion
                        .rate_limit
                        .as_ref()
                        .and_then(|limit| limit["status"].as_str())
                        .map(str::to_owned);
                    self.remember(backend.name(), None, usage);
                    let answer = Answer {
                        backend: backend.name().to_owned(),
                        text: completion.text,
                        rate_limit: completion.rate_limit,
                        usage: completion.usage,
                    };
                    return Outcome {
                        result: Ok(answer),
                        attempts,
                        journal_error: None,
                    };
                }
                Err(error) => error,
            };
            self.remember(backend.name(), Some(error.clone()), None);
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
