//! The Claude Code backend: the `claude` CLI, paid for by a subscription.
//!
//! The output shapes this module relies on were observed before it was
//! written (docs/HANDOVER.md §4; fixtures in `tests/fixtures/claude/`).

use crate::backend::{Backend, BackendError, Completion, Request, Usage, excerpt};
use serde_json::Value;
use std::ffi::{OsStr, OsString};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::Duration;
use wait_timeout::ChildExt;

/// The only billing source accepted: the subscription (OAuth) path. Observed
/// values: `"none"` logged out (2026-09-23) and logged in on OAuth
/// (2026-09-29, `pro`), `"ANTHROPIC_API_KEY"` when that
/// variable is set. Claude Code also knows `"apiKeyHelper"` and
/// `"/login managed key"`; both are metered and refused.
pub const SUBSCRIPTION_BILLING_SOURCE: &str = "none";

/// Classify what `claude -p --output-format json --verbose` printed.
///
/// Order matters: the billing and tool tripwires are checked before the
/// result, so an answer that was billed per token is refused even when it
/// succeeded (docs/ARCHITECTURE.md, "Billing guards").
pub fn classify(stdout: &str) -> Result<Completion, BackendError> {
    classify_for(stdout, false)
}

/// The keys of a `rate_limit_info` the journal keeps (8.32).
const RATE_LIMIT_KEYS: [&str; 4] = ["status", "rateLimitType", "isUsingOverage", "overageStatus"];

/// [`classify`], for a request that asked (`schema`) for structured output.
pub fn classify_for(stdout: &str, schema: bool) -> Result<Completion, BackendError> {
    let messages: Vec<Value> = serde_json::from_str(stdout.trim()).map_err(|error| {
        BackendError::Other(format!(
            "claude output is not the expected JSON array ({error}; {} characters)",
            stdout.chars().count()
        ))
    })?;

    let init = messages
        .iter()
        .find(|message| message["type"] == "system" && message["subtype"] == "init")
        .ok_or_else(|| {
            BackendError::Other(
                "claude output has no system/init message, so its billing source cannot be \
                 verified; refusing"
                    .into(),
            )
        })?;

    let billing = init["apiKeySource"].as_str().unwrap_or("<missing>");
    if billing != SUBSCRIPTION_BILLING_SOURCE {
        return Err(BackendError::Other(format!(
            "billing tripwire: claude reports apiKeySource={billing}, which is billed per \
             token; itsaresume only uses the subscription (docs/HANDOVER.md §1). Remove that \
             credential from the environment or settings of the process running claude"
        )));
    }

    // With a schema, the CLI answers through its `StructuredOutput` tool,
    // which returns data and acts on nothing (8.24): that one, alone, and
    // only when a schema was asked for.
    let tools = init["tools"].as_array();
    let tools_allowed = tools.is_some_and(Vec::is_empty)
        || (schema && tools.is_some_and(|t| t.len() == 1 && t[0] == "StructuredOutput"));
    if !tools_allowed {
        return Err(BackendError::Other(format!(
            "tool tripwire: claude started with tools {}; prompts may carry injected \
             instructions and must find no tool to call",
            init["tools"]
        )));
    }

    // Extra usage is billed per token (§1, decision 1), and the CLI says so
    // in its rate-limit event (observed on 2.1.162, 8.28). This answer was
    // already billed: refusing it latches the backend (the message prefix),
    // so the next request does not spend more.
    let overage = messages.iter().any(|message| {
        message["type"] == "rate_limit_event"
            && message["rate_limit_info"]["isUsingOverage"] == true
    });
    if overage {
        return Err(BackendError::Other(
            "billing tripwire: claude reports this answer as extra usage (overage, \
             isUsingOverage), which is billed per token; itsaresume only uses the \
             subscription (docs/HANDOVER.md §1). Turn extra usage off for the account"
                .into(),
        ));
    }

    // The plan's limits as reported with this answer, for the journal
    // (M4, 8.32): only what says which limit and whether it held.
    let rate_limit = messages
        .iter()
        .rev()
        .find(|message| message["type"] == "rate_limit_event")
        .map(|message| {
            let info = &message["rate_limit_info"];
            let kept: serde_json::Map<String, Value> = RATE_LIMIT_KEYS
                .iter()
                .filter_map(|key| {
                    info.get(*key)
                        .map(|value| ((*key).to_owned(), value.clone()))
                })
                .collect();
            Value::Object(kept)
        });

    let result = messages
        .iter()
        .rev()
        .find(|message| message["type"] == "result")
        .ok_or_else(|| BackendError::Other("claude output has no result message".into()))?;
    let usage = usage_of(result);

    if schema && result["is_error"] == false {
        return match result.get("structured_output") {
            Some(object) if !object.is_null() => Ok(Completion {
                text: object.to_string(),
                rate_limit: rate_limit.clone(),
                usage,
            }),
            _ => Err(BackendError::Other(
                "claude answered a schema request without structured_output".into(),
            )),
        };
    }

    let text = result["result"].as_str();
    match (result["is_error"].as_bool(), text) {
        (Some(false), Some(text)) => Ok(Completion {
            text: text.to_owned(),
            rate_limit,
            usage,
        }),
        (Some(true), text) => Err(classify_error(
            result["api_error_status"].as_u64(),
            text.unwrap_or(""),
        )),
        _ => Err(BackendError::Other(format!(
            "claude result message is not understood: {}",
            excerpt(&result.to_string(), 160)
        ))),
    }
}

/// An `is_error: true` result, by HTTP status first, then by wording.
fn classify_error(status: Option<u64>, message: &str) -> BackendError {
    let detail = match status {
        Some(status) => format!("claude error (HTTP {status}): {message}"),
        None => format!("claude error: {message}"),
    };
    match status {
        Some(429) => BackendError::QuotaExceeded(detail),
        Some(500..=504 | 529) => BackendError::Unreachable(detail),
        Some(_) => BackendError::Other(detail),
        None if looks_like_usage_limit(message) => BackendError::QuotaExceeded(detail),
        None if looks_like_connection_failure(message) => BackendError::Unreachable(detail),
        None => BackendError::Other(detail),
    }
}

/// Hypothesis, not observed (docs/HANDOVER.md §9): the wordings Claude Code
/// has used for plan limits. A limit message that matches none of them is
/// classified `Other` and stops loudly, which is the safe direction.
/// The tokens of a result message's `usage` (8.38); `None` when it has none.
fn usage_of(result: &Value) -> Option<Usage> {
    let usage = result.get("usage").filter(|usage| usage.is_object())?;
    let count = |key: &str| usage[key].as_u64().unwrap_or(0);
    Some(Usage {
        input: count("input_tokens"),
        output: count("output_tokens"),
        cache_read: count("cache_read_input_tokens"),
        cache_creation: count("cache_creation_input_tokens"),
    })
}

fn looks_like_usage_limit(message: &str) -> bool {
    let message = message.to_lowercase();
    if message.contains("context") || message.contains("too long") {
        return false;
    }
    message.contains("usage limit")
        || message.contains("limit reached")
        || (message.contains("hit your") && message.contains("limit"))
}

/// Hypothesis, not observed: how a network failure reads without a status.
fn looks_like_connection_failure(message: &str) -> bool {
    let message = message.to_lowercase();
    [
        "connection error",
        "unable to connect",
        "econnrefused",
        "etimedout",
        "timed out",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

/// Environment variables that switch the `claude` CLI to per-token billing or
/// to a metered provider. They are removed from the child's environment.
/// `CLAUDE_CODE_OAUTH_TOKEN` (the subscription token) is deliberately absent.
pub const METERED_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    // A gateway or proxy is how a metered endpoint would slip in unseen.
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "AWS_BEARER_TOKEN_BEDROCK",
    // Another configuration directory brings its own settings file.
    "CLAUDE_CONFIG_DIR",
];

/// Used when a request has no system prompt, so that Claude Code's own
/// (agentic, long) system prompt is never sent.
pub const DEFAULT_SYSTEM_PROMPT: &str =
    "You are a careful writing assistant. Reply with the requested text only.";

/// The Claude Code backend: `claude -p` in a child process.
#[derive(Debug, Clone)]
pub struct ClaudeCodeBackend {
    program: PathBuf,
    model: Option<String>,
    timeout: Duration,
    workdir: PathBuf,
    /// Set when the billing tripwire fires: no request starts claude again.
    tripped: Arc<AtomicBool>,
    /// Where the latch is written down, so that a restart keeps it.
    latch_file: Option<PathBuf>,
}

impl ClaudeCodeBackend {
    /// A backend running `program` (a path, or a name looked up on `PATH`).
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            model: None,
            timeout: Duration::from_secs(300),
            workdir: std::env::temp_dir().join("itsaresume-claude"),
            tripped: Arc::new(AtomicBool::new(false)),
            latch_file: None,
        }
    }

    /// Write the billing latch to `file` (and honour it at start).
    pub fn with_latch_file(mut self, file: impl Into<PathBuf>) -> Self {
        self.latch_file = Some(file.into());
        self
    }

    /// Pass `--model <model>` to the CLI.
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    /// Kill the CLI and report `Unreachable` after this long.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// The directory the CLI runs in (created if missing).
    pub fn with_workdir(mut self, workdir: impl Into<PathBuf>) -> Self {
        self.workdir = workdir.into();
        self
    }

    /// The command-line arguments, `system_file` holding the system prompt.
    /// No request text is among them: the prompt goes on stdin and the system
    /// prompt in that file, since argv is length-limited, cannot hold a NUL,
    /// and is readable by every local process.
    pub fn arguments_for(
        &self,
        system_file: &Path,
        schema: Option<&serde_json::Value>,
    ) -> Vec<String> {
        let mut arguments = self.arguments(system_file);
        if let Some(schema) = schema {
            // Observed on 2.1.162: the answer then comes in `structured_output`.
            // The schema is no secret: argv is fine for it.
            arguments.push("--json-schema".into());
            arguments.push(schema.to_string());
        }
        arguments
    }

    /// The arguments without a schema.
    pub fn arguments(&self, system_file: &Path) -> Vec<String> {
        let mut arguments: Vec<String> = vec![
            "-p".into(),
            "--output-format".into(),
            "json".into(),
            // The array form: its system/init message carries apiKeySource.
            "--verbose".into(),
            "--no-session-persistence".into(),
            // An empty list disables every tool (observed: tools: []).
            "--tools".into(),
            String::new(),
            "--strict-mcp-config".into(),
            "--disable-slash-commands".into(),
            // No user or project settings: their `env` block could route the
            // child to a paid gateway after the scrub (observed on 2.1.162:
            // the empty list is accepted and OAuth still answers).
            "--setting-sources".into(),
            String::new(),
            // Replaces Claude Code's agentic system prompt (observed on
            // 2.1.162: read as UTF-8; a missing file exits 1 with "System
            // prompt file not found" on stderr and nothing on stdout).
            "--system-prompt-file".into(),
            system_file.to_string_lossy().into_owned(),
        ];
        if let Some(model) = &self.model {
            arguments.push("--model".into());
            arguments.push(model.clone());
        }
        arguments
    }

    /// Run one request with `env` as the environment the child would inherit.
    ///
    /// [`Backend::complete`] passes the process environment; tests pass their
    /// own, which is how the removal of [`METERED_ENV`] is proved without
    /// touching the test process's global environment.
    pub fn complete_with_env(
        &self,
        request: &Request,
        env: impl IntoIterator<Item = (OsString, OsString)>,
    ) -> Result<Completion, BackendError> {
        if let Some(error) = self.latched() {
            return Err(error);
        }
        private_workdir(&self.workdir)?;
        let system = request.system.as_deref().unwrap_or(DEFAULT_SYSTEM_PROMPT);
        // Removed when this function returns, whatever the outcome.
        let system_file = SystemFile::write(&self.workdir, system)?;
        // The answer goes into a private file, not a pipe: the CLI (Node)
        // loses what it wrote past 128 KiB into a pipe when it exits (seen on
        // the Linux VM, 2026-10-01: an analysis cut, refused as not JSON).
        let (answer_file, answer_handle) = SystemFile::create(&self.workdir, "answer")?;

        let mut command = Command::new(&self.program);
        command
            .args(self.arguments_for(&system_file.path, request.schema.as_ref()))
            .current_dir(&self.workdir)
            .env_clear()
            .envs(env.into_iter().filter(|(name, _)| !is_metered(name)))
            .stdin(Stdio::piped())
            .stdout(Stdio::from(answer_handle))
            .stderr(Stdio::piped());

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Err(BackendError::Unreachable(format!(
                    "claude CLI not found at {}: {error}",
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

        // Write and read on threads: a large prompt and a large answer would
        // otherwise deadlock on full pipes.
        let stdin = child.stdin.take();
        let prompt = request.prompt.clone();
        let writer = thread::spawn(move || {
            if let Some(mut stdin) = stdin {
                let _ = stdin.write_all(prompt.as_bytes());
            }
        });
        let stderr = drain(child.stderr.take());

        let status = match child.wait_timeout(self.timeout) {
            Ok(Some(status)) => status,
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(BackendError::Unreachable(format!(
                    "claude did not answer within {} s and was killed",
                    self.timeout.as_secs_f32()
                )));
            }
            Err(error) => {
                let _ = child.kill();
                return Err(BackendError::Other(format!(
                    "cannot wait for claude: {error}"
                )));
            }
        };
        let _ = writer.join();
        let stdout = std::fs::read_to_string(&answer_file.path).unwrap_or_default();
        let stderr = stderr.join().unwrap_or_default();

        if stdout.trim().is_empty() {
            return Err(BackendError::Other(format!(
                "claude exited with {status} and printed nothing on stdout; stderr: {}",
                excerpt(stderr.trim(), 160)
            )));
        }
        let outcome = classify_for(&stdout, request.schema.is_some());
        if matches!(&outcome, Err(BackendError::Other(message)) if message.starts_with("billing tripwire"))
        {
            self.tripped.store(true, Ordering::SeqCst);
            if let Some(file) = &self.latch_file {
                let _ = std::fs::write(file, "the billing tripwire fired; see the journal\n");
            }
        }
        outcome
    }

    /// Latched: the billing tripwire fired, in this process or before a restart.
    fn latched(&self) -> Option<BackendError> {
        let marked = self.latch_file.as_ref().is_some_and(|file| file.exists());
        (self.tripped.load(Ordering::SeqCst) || marked).then(|| {
            BackendError::Other(format!(
                "billing tripwire latched: claude reported a per-token billing source earlier, \
                 so it is not started again; fix the billing source, then delete {} and restart",
                self.latch_file
                    .as_ref()
                    .map_or_else(|| "nothing".into(), |file| file.display().to_string())
            ))
        })
    }
}

/// Whether an environment variable is one of [`METERED_ENV`] (names compared
/// without case: Windows environment names are case-insensitive).
/// Tells apart the system prompt files of one process's concurrent requests.
static SYSTEM_FILES: AtomicU64 = AtomicU64::new(0);

/// Create `workdir` if missing, then make sure it is fit to hold the system
/// prompt file and to start `claude` in.
///
/// On Unix: a directory, not a link, that no other user can write into, left
/// 0700 (a 0755 one of ours is tightened; `chmod` fails on someone else's).
/// On Windows the temp directory is per user: a directory, not a link.
fn private_workdir(workdir: &Path) -> Result<(), BackendError> {
    let refuse = |why: String| {
        BackendError::Other(format!(
            "the claude working directory {} {why}",
            workdir.display()
        ))
    };
    #[cfg(unix)]
    let created = {
        use std::os::unix::fs::DirBuilderExt;
        if let Some(parent) = workdir.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| refuse(format!("cannot be created: {error}")))?;
        }
        std::fs::DirBuilder::new().mode(0o700).create(workdir)
    };
    #[cfg(not(unix))]
    let created = std::fs::create_dir_all(workdir);
    if let Err(error) = created {
        if error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(refuse(format!("cannot be created: {error}")));
        }
    }
    let metadata = std::fs::symlink_metadata(workdir)
        .map_err(|error| refuse(format!("cannot be read: {error}")))?;
    // Not followed: a link's own metadata is never a directory's.
    if !metadata.is_dir() {
        return Err(refuse("is not a plain directory (a link or a file)".into()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode() & 0o777;
        if mode & 0o022 != 0 {
            return Err(refuse(format!(
                "is writable by other users (mode {mode:o}); remove it or chmod 700"
            )));
        }
        if mode != 0o700 {
            std::fs::set_permissions(workdir, std::fs::Permissions::from_mode(0o700))
                .map_err(|error| refuse(format!("cannot be made private: {error}")))?;
        }
    }
    Ok(())
}

/// The system prompt of one request, in a file of the working directory that
/// only its owner can read (0600 on Unix; on Windows the default working
/// directory is in the user's own temp folder). Deleted on drop; a crash
/// mid-request leaves it behind (docs/HANDOVER.md §9).
struct SystemFile {
    path: PathBuf,
}

impl SystemFile {
    fn write(workdir: &Path, system: &str) -> Result<Self, BackendError> {
        let (file, mut handle) = Self::create(workdir, "system")?;
        handle.write_all(system.as_bytes()).map_err(|error| {
            BackendError::Other(format!(
                "cannot write the system prompt file {}: {error}",
                file.path.display()
            ))
        })?;
        Ok(file)
    }

    /// A new private file in `workdir` (removed on drop) and its handle.
    fn create(workdir: &Path, stem: &str) -> Result<(Self, std::fs::File), BackendError> {
        let name = format!(
            "{stem}-{}-{}.txt",
            std::process::id(),
            SYSTEM_FILES.fetch_add(1, Ordering::Relaxed)
        );
        // Absolute: the child runs in `workdir`, so a relative path would be
        // resolved twice.
        let path = std::path::absolute(workdir.join(name)).map_err(|error| {
            BackendError::Other(format!(
                "cannot resolve the claude working directory: {error}"
            ))
        })?;
        let mut options = std::fs::OpenOptions::new();
        // A new file: never one someone put there first.
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let handle = options.open(&path).map_err(|error| {
            BackendError::Other(format!("cannot create {}: {error}", path.display()))
        })?;
        // Ours from here on, so removed on drop even if a write fails.
        Ok((Self { path }, handle))
    }
}

impl Drop for SystemFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn is_metered(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    METERED_ENV
        .iter()
        .any(|metered| name.eq_ignore_ascii_case(metered))
}

/// Read a pipe to the end on its own thread.
fn drain(pipe: Option<impl Read + Send + 'static>) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_string(&mut text);
        }
        text
    })
}

impl Backend for ClaudeCodeBackend {
    fn name(&self) -> &str {
        "claude-code"
    }

    fn complete(&self, request: &Request) -> Result<Completion, BackendError> {
        self.complete_with_env(request, std::env::vars_os())
    }
}
