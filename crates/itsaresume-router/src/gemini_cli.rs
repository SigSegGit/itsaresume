//! The Gemini CLI backend: `gemini -p` on a Google account login (the free
//! tier or a Google AI subscription), never an API key (docs/HANDOVER.md §1).

use crate::backend::{Backend, BackendError, Completion, Request};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Environment variables that switch the CLI to an API key, Vertex AI or a
/// gateway. Removed from the child's environment.
pub const METERED_ENV: &[&str] = &[];

/// Whether `name` is one of [`METERED_ENV`].
pub fn is_metered(name: &str) -> bool {
    let _ = name;
    todo!()
}

/// Refuse unless the CLI's settings select a Google account login.
pub fn auth_guard(settings: Option<&str>) -> Result<(), BackendError> {
    let _ = settings;
    todo!()
}

/// The first JSON value in `text`.
pub fn extract_json(text: &str) -> Option<serde_json::Value> {
    let _ = text;
    todo!()
}

/// The prompt sent: the request's, plus the schema rule when it has one.
pub fn prompt_for(request: &Request) -> String {
    let _ = request;
    todo!()
}

/// Classify one run of the CLI.
pub fn classify(stdout: &str, stderr: &str, schema: bool) -> Result<Completion, BackendError> {
    let _ = (stdout, stderr, schema);
    todo!()
}

/// The Gemini CLI backend.
#[derive(Debug, Clone)]
pub struct GeminiCliBackend {
    program: PathBuf,
    settings_file: Option<PathBuf>,
    timeout: Duration,
}

impl GeminiCliBackend {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self { program: program.into(), settings_file: None, timeout: Duration::from_secs(1) }
    }

    pub fn with_settings_file(mut self, file: impl AsRef<Path>) -> Self {
        self.settings_file = Some(file.as_ref().to_path_buf());
        self
    }

    pub fn complete_with_env(
        &self,
        request: &Request,
        env: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
    ) -> Result<Completion, BackendError> {
        let _ = (request, env.into_iter().count(), &self.program, self.timeout);
        todo!()
    }
}

impl Backend for GeminiCliBackend {
    fn name(&self) -> &str {
        "gemini-cli"
    }

    fn complete(&self, request: &Request) -> Result<Completion, BackendError> {
        self.complete_with_env(request, std::env::vars_os())
    }
}
