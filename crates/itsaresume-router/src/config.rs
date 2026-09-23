//! The configuration file (`config.local.toml`; `config.example.toml` shows it).

use crate::router::Router;
use serde::Deserialize;
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long a backend may take when the file does not say.
pub const DEFAULT_TIMEOUT_SECS: u64 = 300;

/// The whole file.
#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    /// Where the JSONL journal is appended.
    pub journal: PathBuf,
    /// Backends, in the order they are tried.
    #[serde(rename = "backend", default)]
    pub backends: Vec<BackendConfig>,
}

/// One backend. The list of kinds is closed, and no kind has a credential.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
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
        let _ = self;
        Duration::ZERO
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
        let _ = text;
        Err(ConfigError("not written yet".into()))
    }

    /// Read and parse a configuration file.
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let text = std::fs::read_to_string(path)
            .map_err(|error| ConfigError(format!("cannot read {}: {error}", path.display())))?;
        Self::parse(&text)
    }

    /// The router this configuration describes.
    pub fn router(&self) -> Result<Router, ConfigError> {
        Err(ConfigError("not written yet".into()))
    }
}
