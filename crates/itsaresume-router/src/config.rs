//! The configuration file (`config.local.toml`; `config.example.toml` shows it).

use crate::backend::Backend;
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
        /// The endpoint, ending in `/v1`.
        base_url: String,
        /// The model id as LM Studio lists it.
        model: String,
        /// Seconds before giving up.
        timeout_secs: Option<u64>,
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

    fn build(&self) -> Box<dyn Backend> {
        match self {
            Self::ClaudeCode {
                program,
                model,
                workdir,
                ..
            } => {
                let mut backend = ClaudeCodeBackend::new(program).with_timeout(self.timeout());
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
            } => Box::new(LmStudioBackend::new(base_url, model).with_timeout(self.timeout())),
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
        let backends = self.backends.iter().map(BackendConfig::build).collect();
        Router::new(backends, Journal::new(&self.journal))
            .map_err(|error| ConfigError(format!("invalid configuration: {error}")))
    }
}
