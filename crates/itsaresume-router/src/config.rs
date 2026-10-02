//! The configuration file (`config.local.toml`; `config.example.toml` shows it).

use crate::backend::{Backend, Kind};
use crate::claude_code::ClaudeCodeBackend;
use crate::journal::Journal;
use crate::lm_studio::LmStudioBackend;
use crate::router::Router;
use serde::Deserialize;
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long a backend may take when the file does not say.
pub const DEFAULT_TIMEOUT_SECS: u64 = 300;

/// The longest `timeout_secs` accepted (one day): a deadline is `now +
/// timeout`, which panics on overflow for a huge value.
pub const MAX_TIMEOUT_SECS: u64 = 86_400;

/// The whole file.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// Where the JSONL journal is appended.
    pub journal: PathBuf,
    /// Backends, in the order they are tried.
    #[serde(rename = "backend", default)]
    pub backends: Vec<BackendConfig>,
}

/// One backend. The list of kinds is closed, and no kind has a credential.
#[derive(Debug, Clone, Deserialize)]
// `deny_unknown_fields` is the credential guard: an `api_key` line is an
// error, not a silently ignored setting (docs/HANDOVER.md §1, decision 1).
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum BackendConfig {
    /// The `claude` CLI on the subscription.
    ClaudeCode {
        /// The name requests and the journal use (default: the kind).
        name: Option<String>,
        /// The request kinds it takes (default: all).
        serves: Option<Vec<Kind>>,
        /// The executable (a path, or a name looked up on `PATH`).
        program: PathBuf,
        /// A model alias for `claude --model`.
        model: Option<String>,
        /// Seconds before the CLI is killed.
        timeout_secs: Option<u64>,
        /// The directory the CLI runs in.
        workdir: Option<PathBuf>,
    },
    /// LM Studio's OpenAI-compatible server.
    LmStudio {
        /// The name requests and the journal use (default: the kind).
        name: Option<String>,
        /// The request kinds it takes (default: all; a small model:
        /// `["classify"]`).
        serves: Option<Vec<Kind>>,
        /// The endpoint, ending in `/v1`.
        base_url: String,
        /// The model id as LM Studio lists it.
        model: String,
        /// Seconds before giving up, waiting for a slot included.
        timeout_secs: Option<u64>,
        /// Completions on the server at once; 1 when absent (Bionic has one slot).
        max_concurrent: Option<usize>,
    },
}

impl BackendConfig {
    /// The configured timeout, or [`DEFAULT_TIMEOUT_SECS`].
    pub fn timeout(&self) -> Duration {
        let seconds = match self {
            Self::ClaudeCode { timeout_secs, .. } | Self::LmStudio { timeout_secs, .. } => {
                timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS)
            }
        };
        Duration::from_secs(seconds)
    }

    /// The name a request may give (`backend`) and the journal records:
    /// the configured `name`, else the kind.
    pub fn name(&self) -> String {
        match self {
            Self::ClaudeCode { name, .. } => name.clone().unwrap_or_else(|| "claude-code".into()),
            Self::LmStudio { name, .. } => name.clone().unwrap_or_else(|| "lm-studio".into()),
        }
    }

    /// The request kinds this backend takes: its `serves`, else all.
    pub fn serves(&self) -> Vec<Kind> {
        let (Self::ClaudeCode { serves, .. } | Self::LmStudio { serves, .. }) = self;
        serves
            .clone()
            .unwrap_or_else(|| vec![Kind::Generate, Kind::Classify])
    }

    /// How many completions may reach the backend at once (`None`: no limit).
    pub fn max_concurrent(&self) -> Option<usize> {
        match self {
            Self::ClaudeCode { .. } => None,
            Self::LmStudio { max_concurrent, .. } => Some(max_concurrent.unwrap_or(1)),
        }
    }

    /// Whether an `lm-studio` `base_url` has `user@` before its host, which
    /// would be sent as Basic auth.
    fn has_userinfo(&self) -> bool {
        let Self::LmStudio { base_url, .. } = self else {
            return false;
        };
        let rest = base_url
            .split_once("://")
            .map_or(base_url.as_str(), |(_, r)| r);
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        authority.contains('@')
    }

    /// The backend; `journal` is where the Claude Code billing latch goes, beside it.
    fn build(&self, journal: &Path) -> Box<dyn Backend> {
        match self {
            Self::ClaudeCode {
                program,
                model,
                workdir,
                ..
            } => {
                let mut backend = ClaudeCodeBackend::new(program)
                    .with_timeout(self.timeout())
                    .with_latch_file(journal.with_extension("billing-tripped"));
                if let Some(model) = model {
                    backend = backend.with_model(model);
                }
                if let Some(workdir) = workdir {
                    backend = backend.with_workdir(workdir);
                }
                Box::new(backend)
            }
            Self::LmStudio {
                base_url, model, ..
            } => Box::new(
                LmStudioBackend::new(base_url, model)
                    .with_timeout(self.timeout())
                    .with_max_concurrent(self.max_concurrent().unwrap_or(1)),
            ),
        }
    }
}

/// A configuration that could not be read, parsed or turned into a router.
#[derive(Debug)]
pub struct ConfigError(String);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

impl Config {
    /// Parse the TOML text of a configuration.
    pub fn parse(text: &str) -> Result<Self, ConfigError> {
        toml::from_str(text).map_err(|error| ConfigError(format!("invalid configuration: {error}")))
    }

    /// Read and parse a configuration file.
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let text = std::fs::read_to_string(path)
            .map_err(|error| ConfigError(format!("cannot read {}: {error}", path.display())))?;
        Self::parse(&text)
    }

    /// The router this configuration describes.
    pub fn router(&self) -> Result<Router, ConfigError> {
        if self
            .backends
            .iter()
            .any(|b| b.timeout() > Duration::from_secs(MAX_TIMEOUT_SECS))
        {
            return Err(ConfigError(format!(
                "invalid configuration: timeout_secs above {MAX_TIMEOUT_SECS} (one day) is refused"
            )));
        }
        if self.backends.iter().any(|b| b.max_concurrent() == Some(0)) {
            return Err(ConfigError(
                "invalid configuration: max_concurrent = 0 would never answer".into(),
            ));
        }
        if self.backends.iter().any(BackendConfig::has_userinfo) {
            // Never echo the URL: its userinfo is a credential.
            return Err(ConfigError(
                "invalid configuration: an lm-studio base_url holds userinfo (user@ or user:password@); no credential goes in this file".into(),
            ));
        }
        if let Some(backend) = self.backends.iter().find(|b| b.serves().is_empty()) {
            return Err(ConfigError(format!(
                "invalid configuration: backend \"{}\" serves nothing (serves = [])",
                backend.name()
            )));
        }
        let mut seen = std::collections::HashSet::new();
        for backend in &self.backends {
            if !seen.insert(backend.name()) {
                return Err(ConfigError(format!(
                    "invalid configuration: two backends are named \"{}\" (give each a unique `name`)",
                    backend.name()
                )));
            }
        }
        let backends = self
            .backends
            .iter()
            .map(|backend| -> Box<dyn Backend> {
                Box::new(Named {
                    name: backend.name(),
                    serves: backend.serves(),
                    inner: backend.build(&self.journal),
                })
            })
            .collect();
        Router::new(backends, Journal::new(&self.journal))
            .map_err(|error| ConfigError(format!("invalid configuration: {error}")))
    }
}

/// A backend under its configured name (the kind when none is given).
struct Named {
    name: String,
    serves: Vec<Kind>,
    inner: Box<dyn Backend>,
}

impl Backend for Named {
    fn name(&self) -> &str {
        &self.name
    }

    fn kind(&self) -> &str {
        self.inner.name()
    }

    fn serves(&self, kind: Kind) -> bool {
        self.serves.contains(&kind)
    }

    fn complete(
        &self,
        request: &crate::backend::Request,
    ) -> Result<crate::backend::Completion, crate::backend::BackendError> {
        self.inner.complete(request)
    }
}
