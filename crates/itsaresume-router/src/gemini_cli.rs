//! The Gemini CLI backend: `gemini -p` on a Google account login (the free
//! tier or a Google AI subscription), never an API key (docs/HANDOVER.md §1).
//!
//! Two guards keep it off per-token billing: the CLI is not started unless
//! its settings select `oauth-personal`, and every variable that would switch
//! it to an API key, Vertex AI or a gateway is removed from its environment.
//! Output shapes are hypotheses on Gemini CLI 0.11 (`--output-format json`)
//! until a logged-in capture confirms them (tests/gemini_cli.rs).

use crate::backend::{Backend, BackendError, Completion, Request, Usage, excerpt};
use crate::claude_code::{DEFAULT_SYSTEM_PROMPT, SystemFile, drain, private_workdir};
use serde_json::Value;
use std::ffi::OsString;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;
use wait_timeout::ChildExt;

/// Environment variables that switch the CLI to an API key, Vertex AI or a
/// gateway (or would hand another provider's key to it). Removed from the
/// child's environment, names compared without case.
pub const METERED_ENV: &[&str] = &[
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_GENAI_USE_GCA",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_GEMINI_BASE_URL",
    "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
];

/// The only login accepted: a Google account (free tier or subscription).
pub const ACCOUNT_LOGIN: &str = "oauth-personal";

/// Whether `name` is one of [`METERED_ENV`].
pub fn is_metered(name: &str) -> bool {
    METERED_ENV.iter().any(|m| name.eq_ignore_ascii_case(m))
}

/// Refuse unless the CLI's settings (`~/.gemini/settings.json`) select a
/// Google account login. Absent or unreadable settings are refused too: the
/// CLI would then fall back to whatever key it finds.
pub fn auth_guard(settings: Option<&str>) -> Result<(), BackendError> {
    let selected = settings
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|v| {
            v["security"]["auth"]["selectedType"]
                .as_str()
                .map(str::to_owned)
        });
    match selected.as_deref() {
        Some(ACCOUNT_LOGIN) => Ok(()),
        other => Err(BackendError::Other(format!(
            "gemini billing guard: the CLI's auth is {}, not {ACCOUNT_LOGIN}; run `gemini` once \
             and choose \"Login with Google\"",
            other.unwrap_or("<not set>")
        ))),
    }
}

/// The first JSON object or array in `text` (a fenced block, or prose
/// around it, is tolerated), or `None`.
pub fn extract_json(text: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(text.trim()) {
        if value.is_object() || value.is_array() {
            return Some(value);
        }
    }
    for (start, _) in text.match_indices(['{', '[']) {
        let mut stream = serde_json::Deserializer::from_str(&text[start..]).into_iter::<Value>();
        if let Some(Ok(value)) = stream.next() {
            return Some(value);
        }
    }
    None
}

/// The rule appended to a request with a schema. Every backend without a
/// native schema option uses it, so that providers answer in one shape.
pub fn schema_rule(schema: &Value) -> String {
    format!(
        "\n\nAnswer with one JSON value only, no prose and no code fence, valid against \
         this JSON Schema:\n{schema}"
    )
}

/// The prompt sent: the request's, plus [`schema_rule`] when it has a schema.
pub fn prompt_for(request: &Request) -> String {
    match &request.schema {
        Some(schema) => format!("{}{}", request.prompt, schema_rule(schema)),
        None => request.prompt.clone(),
    }
}

fn looks_like_quota(text: &str) -> bool {
    let text = text.to_lowercase();
    [
        "429",
        "resource_exhausted",
        "quota",
        "rate limit",
        "ratelimit",
    ]
    .iter()
    .any(|n| text.contains(n))
}

fn looks_like_network(text: &str) -> bool {
    let text = text.to_lowercase();
    [
        "econnrefused",
        "enotfound",
        "etimedout",
        "econnreset",
        "fetch failed",
        "network",
    ]
    .iter()
    .any(|n| text.contains(n))
}

/// The tokens of every model the run used, summed.
fn usage_of(stats: &Value) -> Option<Usage> {
    let models = stats["models"].as_object()?;
    let mut usage = Usage::default();
    for model in models.values() {
        let tokens = &model["tokens"];
        let cached = tokens["cached"].as_u64().unwrap_or(0);
        usage.input += tokens["prompt"]
            .as_u64()
            .unwrap_or(0)
            .saturating_sub(cached);
        usage.output += tokens["candidates"].as_u64().unwrap_or(0);
        usage.cache_read += cached;
    }
    Some(usage)
}

/// Classify one run of the CLI from what it printed.
pub fn classify(stdout: &str, stderr: &str, schema: bool) -> Result<Completion, BackendError> {
    let parsed = serde_json::from_str::<Value>(stdout.trim()).ok();
    let error_text = match &parsed {
        Some(v) if !v["error"].is_null() => format!("{} {stderr}", v["error"]),
        Some(_) => String::new(),
        None => format!("{stdout} {stderr}"),
    };
    let answer = parsed.as_ref().and_then(|v| v["response"].as_str());
    let Some(answer) = answer.filter(|_| error_text.trim().is_empty()) else {
        let detail = excerpt(error_text.trim(), 200);
        return Err(if looks_like_quota(&error_text) {
            BackendError::QuotaExceeded(format!("gemini: {detail}"))
        } else if looks_like_network(&error_text) {
            BackendError::Unreachable(format!("gemini: {detail}"))
        } else {
            BackendError::Other(format!("gemini gave no answer: {detail}"))
        });
    };
    let usage = parsed.as_ref().and_then(|v| usage_of(&v["stats"]));
    let text = if schema {
        extract_json(answer).map(|v| v.to_string()).ok_or_else(|| {
            BackendError::Other(format!(
                "gemini was asked for JSON and answered: {}",
                excerpt(answer, 160)
            ))
        })?
    } else {
        answer.to_owned()
    };
    Ok(Completion {
        text,
        rate_limit: None,
        usage,
    })
}

/// The Gemini CLI backend: `gemini -p` in a child process.
#[derive(Debug, Clone)]
pub struct GeminiCliBackend {
    program: PathBuf,
    model: Option<String>,
    timeout: Duration,
    workdir: PathBuf,
    /// The CLI's settings file; `~/.gemini/settings.json` when unset.
    settings_file: Option<PathBuf>,
}

impl GeminiCliBackend {
    /// A backend running `program`, with the defaults.
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            model: None,
            timeout: Duration::from_secs(crate::config::DEFAULT_TIMEOUT_SECS),
            workdir: std::env::temp_dir().join("itsaresume-gemini"),
            settings_file: None,
        }
    }

    /// The model for `-m`.
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    /// Seconds before the CLI is killed.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// The directory the CLI runs in.
    pub fn with_workdir(mut self, workdir: impl Into<PathBuf>) -> Self {
        self.workdir = workdir.into();
        self
    }

    /// The CLI's settings file, read by the billing guard.
    pub fn with_settings_file(mut self, file: impl AsRef<Path>) -> Self {
        self.settings_file = Some(file.as_ref().to_path_buf());
        self
    }

    fn settings_path(&self) -> Option<PathBuf> {
        self.settings_file.clone().or_else(|| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(|home| PathBuf::from(home).join(".gemini").join("settings.json"))
        })
    }

    /// The arguments: the prompt comes on stdin.
    pub fn arguments(&self) -> Vec<String> {
        let mut arguments: Vec<String> = vec![
            "-p".into(),
            String::new(),
            "--output-format".into(),
            "json".into(),
        ];
        if let Some(model) = &self.model {
            arguments.push("-m".into());
            arguments.push(model.clone());
        }
        arguments
    }

    /// Run one request with `env` as the environment the child would inherit.
    pub fn complete_with_env(
        &self,
        request: &Request,
        env: impl IntoIterator<Item = (OsString, OsString)>,
    ) -> Result<Completion, BackendError> {
        let settings = self
            .settings_path()
            .and_then(|p| std::fs::read_to_string(p).ok());
        auth_guard(settings.as_deref())?;
        private_workdir(&self.workdir)?;
        let system = request.system.as_deref().unwrap_or(DEFAULT_SYSTEM_PROMPT);
        // GEMINI_SYSTEM_MD replaces the CLI's agentic system prompt.
        let system_file = SystemFile::write(&self.workdir, system)?;

        let mut command = Command::new(&self.program);
        command
            .args(self.arguments())
            .current_dir(&self.workdir)
            .env_clear()
            .envs(
                env.into_iter()
                    .filter(|(n, _)| !is_metered(&n.to_string_lossy())),
            )
            .env("GEMINI_SYSTEM_MD", &system_file.path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Err(BackendError::Unreachable(format!(
                    "gemini CLI not found at {}: {error}",
                    self.program.display()
                )));
            }
            Err(error) => {
                return Err(BackendError::Other(format!(
                    "cannot start {}: {error}",
                    self.program.display()
                )));
            }
        };
        let stdin = child.stdin.take();
        let prompt = prompt_for(request);
        let writer = thread::spawn(move || {
            if let Some(mut stdin) = stdin {
                let _ = stdin.write_all(prompt.as_bytes());
            }
        });
        let stdout = drain(child.stdout.take());
        let stderr = drain(child.stderr.take());
        match child.wait_timeout(self.timeout) {
            Ok(Some(_)) => {}
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(BackendError::Unreachable(format!(
                    "gemini did not answer within {} s and was killed",
                    self.timeout.as_secs()
                )));
            }
            Err(error) => {
                let _ = child.kill();
                return Err(BackendError::Other(format!(
                    "cannot wait for gemini: {error}"
                )));
            }
        }
        let _ = writer.join();
        let stdout = stdout.join().unwrap_or_default();
        let stderr = stderr.join().unwrap_or_default();
        classify(&stdout, &stderr, request.schema.is_some())
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
