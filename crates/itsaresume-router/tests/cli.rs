//! The `itsaresume complete` command, run as a real process against the fake
//! `claude` binary and a fake LM Studio server: the whole chain, end to end.

mod support;

use serde_json::Value;
use std::io::{ErrorKind, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const CLI: &str = env!("CARGO_BIN_EXE_itsaresume");
const FAKE_CLAUDE: &str = env!("CARGO_BIN_EXE_itsaresume-fake-claude");
const LM_SUCCESS: &str = include_str!("fixtures/lm-studio/observed-success.json");

fn claude_fixture(name: &str) -> String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/claude")
        .join(name)
        .to_string_lossy()
        .into_owned()
}

/// A config in `dir` with the fake claude first and LM Studio at `lm_url`.
fn config(dir: &Path, claude_program: &str, lm_url: &str) -> PathBuf {
    let toml_string = |text: &str| Value::String(text.to_owned()).to_string();
    let text = format!(
        "journal = {}\n\n[[backend]]\nkind = \"claude-code\"\nprogram = {}\nworkdir = {}\ntimeout_secs = 30\n\n[[backend]]\nkind = \"lm-studio\"\nbase_url = {}\nmodel = \"example-model\"\ntimeout_secs = 10\n",
        toml_string(&dir.join("journal.jsonl").to_string_lossy()),
        toml_string(claude_program),
        toml_string(&dir.join("claude-workdir").to_string_lossy()),
        toml_string(lm_url),
    );
    let path = dir.join("config.toml");
    std::fs::write(&path, text).expect("write config");
    path
}

fn run(args: &[&str], stdin: &str, env: &[(&str, String)]) -> Output {
    run_in(Path::new("."), args, stdin, env)
}

/// `run`, from the working directory `cwd`.
fn run_in(cwd: &Path, args: &[&str], stdin: &str, env: &[(&str, String)]) -> Output {
    let mut child = Command::new(CLI)
        .current_dir(cwd)
        .args(args)
        .envs(env.iter().map(|(name, value)| (*name, value.as_str())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the CLI starts");
    // A CLI that stops before reading stdin (bad configuration, usage error)
    // closes the pipe, and whether it has already done so when this write
    // happens is up to the scheduler: BrokenPipe is not a failure here. The
    // exit code and stderr are what the tests check.
    let written = child
        .stdin
        .take()
        .expect("stdin")
        .write_all(stdin.as_bytes());
    if let Err(error) = written {
        assert_eq!(
            error.kind(),
            ErrorKind::BrokenPipe,
            "write the prompt: {error}"
        );
    }
    child.wait_with_output().expect("the CLI finishes")
}

fn journal(dir: &Path) -> Vec<Value> {
    std::fs::read_to_string(dir.join("journal.jsonl"))
        .expect("journal written")
        .lines()
        .map(|line| serde_json::from_str(line).expect("JSON line"))
        .collect()
}

/// A port nothing listens on.
fn refused_url() -> String {
    let port = TcpListener::bind("127.0.0.1:0")
        .expect("bind")
        .local_addr()
        .expect("address")
        .port();
    format!("http://127.0.0.1:{port}/v1")
}

#[test]
fn complete_prints_the_answer_on_stdout_and_exits_0() {
    let dir = tempfile::tempdir().expect("temp dir");
    let config = config(dir.path(), FAKE_CLAUDE, &refused_url());

    let output = run(
        &["complete", "--config", config.to_str().expect("utf-8")],
        "a prompt",
        &[(
            "FAKE_CLAUDE_STDOUT",
            claude_fixture("synthetic-success.verbose.json"),
        )],
    );

    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert_eq!(String::from_utf8_lossy(&output.stdout), "Synthetic answer.");
    assert!(String::from_utf8_lossy(&output.stderr).contains("claude-code"));
    assert_eq!(journal(dir.path())[0]["backend"], "claude-code");
}

/// The chain the project exists for: the plan is spent, LM Studio answers,
/// and the journal says so.
#[test]
fn a_spent_claude_plan_falls_back_to_lm_studio() {
    let dir = tempfile::tempdir().expect("temp dir");
    let (lm_url, _) = support::serve(200, LM_SUCCESS);
    let config = config(dir.path(), FAKE_CLAUDE, &lm_url);

    let output = run(
        &["complete", "--config", config.to_str().expect("utf-8")],
        "a prompt",
        &[(
            "FAKE_CLAUDE_STDOUT",
            claude_fixture("synthetic-usage-limit.verbose.json"),
        )],
    );

    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert_eq!(String::from_utf8_lossy(&output.stdout), "Hello!");
    let line = &journal(dir.path())[0];
    assert_eq!(line["backend"], "lm-studio");
    assert_eq!(line["attempts"][0]["backend"], "claude-code");
    assert_eq!(line["attempts"][0]["kind"], "quota_exceeded");
}

/// The prompts hold a whole CV: a proxy set in the environment must never
/// see them. Nothing listens on port 1, so a request sent through it fails.
#[test]
fn a_proxy_in_the_environment_is_never_used() {
    let dir = tempfile::tempdir().expect("temp dir");
    let (lm_url, _) = support::serve(200, LM_SUCCESS);
    let config = config(dir.path(), FAKE_CLAUDE, &lm_url);
    let dead = String::from("http://127.0.0.1:1");

    let output = run(
        &["complete", "--config", config.to_str().expect("utf-8")],
        "a prompt",
        &[
            (
                "FAKE_CLAUDE_STDOUT",
                claude_fixture("synthetic-usage-limit.verbose.json"),
            ),
            ("HTTP_PROXY", dead.clone()),
            ("http_proxy", dead.clone()),
            ("HTTPS_PROXY", dead.clone()),
            ("ALL_PROXY", dead),
        ],
    );

    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert_eq!(String::from_utf8_lossy(&output.stdout), "Hello!");
}

/// Not logged in is for a human to fix: exit 3, and LM Studio is never
/// contacted (its listener must see no connection).
#[test]
fn a_stopped_request_exits_3_and_never_reaches_lm_studio() {
    let dir = tempfile::tempdir().expect("temp dir");
    let lm_studio = TcpListener::bind("127.0.0.1:0").expect("bind");
    let lm_url = format!("http://{}/v1", lm_studio.local_addr().expect("address"));
    let config = config(dir.path(), FAKE_CLAUDE, &lm_url);

    let output = run(
        &["complete", "--config", config.to_str().expect("utf-8")],
        "a prompt",
        &[
            (
                "FAKE_CLAUDE_STDOUT",
                claude_fixture("observed-not-logged-in.verbose.json"),
            ),
            ("FAKE_CLAUDE_EXIT", "1".into()),
        ],
    );

    assert_eq!(output.status.code(), Some(3), "{output:?}");
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Not logged in"));
    lm_studio.set_nonblocking(true).expect("nonblocking");
    assert!(
        lm_studio.accept().is_err(),
        "LM Studio was contacted after an Other error"
    );
}

#[test]
fn every_backend_down_exits_4() {
    let dir = tempfile::tempdir().expect("temp dir");
    let missing = dir.path().join("no-such-claude");
    let config = config(dir.path(), &missing.to_string_lossy(), &refused_url());

    let output = run(
        &["complete", "--config", config.to_str().expect("utf-8")],
        "a prompt",
        &[],
    );

    assert_eq!(output.status.code(), Some(4), "{output:?}");
    assert_eq!(journal(dir.path())[0]["outcome"], "exhausted");
}

#[test]
fn the_system_option_reaches_the_backend() {
    let dir = tempfile::tempdir().expect("temp dir");
    let record = dir.path().join("record");
    std::fs::create_dir(&record).expect("record dir");
    let config = config(dir.path(), FAKE_CLAUDE, &refused_url());

    let output = run(
        &[
            "complete",
            "--config",
            config.to_str().expect("utf-8"),
            "--system",
            "You write CVs.",
        ],
        "a prompt",
        &[
            (
                "FAKE_CLAUDE_STDOUT",
                claude_fixture("synthetic-success.verbose.json"),
            ),
            ("FAKE_CLAUDE_RECORD", record.to_string_lossy().into_owned()),
        ],
    );

    assert_eq!(output.status.code(), Some(0), "{output:?}");
    // Through the system prompt file, never the child's command line.
    let system = std::fs::read_to_string(record.join("system.txt")).expect("system recorded");
    assert_eq!(system, "You write CVs.");
}

/// The child runs inside `workdir`: a relative `workdir` in the configuration
/// must not make the system prompt file's path relative to it a second time.
#[test]
fn a_relative_workdir_still_hands_claude_its_system_prompt() {
    let dir = tempfile::tempdir().expect("temp dir");
    let record = dir.path().join("record");
    std::fs::create_dir(&record).expect("record dir");
    let config = config(dir.path(), FAKE_CLAUDE, &refused_url());
    let absolute = std::fs::read_to_string(&config).expect("config");
    let workdir = Value::String(
        dir.path()
            .join("claude-workdir")
            .to_string_lossy()
            .into_owned(),
    );
    let relative = absolute.replace(
        &format!("workdir = {workdir}"),
        "workdir = \"claude-workdir\"",
    );
    assert_ne!(
        relative, absolute,
        "the configuration names a relative workdir"
    );
    std::fs::write(&config, relative).expect("rewrite config");

    let output = run_in(
        dir.path(),
        &[
            "complete",
            "--config",
            config.to_str().expect("utf-8"),
            "--system",
            "You write CVs.",
        ],
        "a prompt",
        &[
            (
                "FAKE_CLAUDE_STDOUT",
                claude_fixture("synthetic-success.verbose.json"),
            ),
            ("FAKE_CLAUDE_RECORD", record.to_string_lossy().into_owned()),
        ],
    );

    assert_eq!(output.status.code(), Some(0), "{output:?}");
    let system = std::fs::read_to_string(record.join("system.txt")).expect("system recorded");
    assert_eq!(system, "You write CVs.");
}

#[test]
fn the_config_path_can_come_from_the_environment() {
    let dir = tempfile::tempdir().expect("temp dir");
    let config = config(dir.path(), FAKE_CLAUDE, &refused_url());

    let output = run(
        &["complete"],
        "a prompt",
        &[
            ("ITSARESUME_CONFIG", config.to_string_lossy().into_owned()),
            (
                "FAKE_CLAUDE_STDOUT",
                claude_fixture("synthetic-success.verbose.json"),
            ),
        ],
    );

    assert_eq!(output.status.code(), Some(0), "{output:?}");
}

#[test]
fn a_bad_configuration_or_usage_exits_2() {
    let dir = tempfile::tempdir().expect("temp dir");
    let bad = dir.path().join("bad.toml");
    std::fs::write(
        &bad,
        "journal = \"j.jsonl\"\n[[backend]]\nkind = \"anthropic-api\"\n",
    )
    .expect("write");

    let output = run(
        &["complete", "--config", bad.to_str().expect("utf-8")],
        "p",
        &[],
    );
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("anthropic-api"));

    for args in [&[][..], &["frobnicate"][..], &["complete", "--config"][..]] {
        let output = run(args, "", &[]);
        assert_eq!(output.status.code(), Some(2), "{args:?}: {output:?}");
    }
}

#[test]
fn an_empty_prompt_is_a_usage_error() {
    let dir = tempfile::tempdir().expect("temp dir");
    let config = config(dir.path(), FAKE_CLAUDE, &refused_url());

    let output = run(
        &["complete", "--config", config.to_str().expect("utf-8")],
        "  \n",
        &[],
    );

    assert_eq!(output.status.code(), Some(2), "{output:?}");
}

/// The billing latch is written next to the journal, so a new process (the
/// next CLI call, a restarted server) refuses before starting claude.
#[test]
fn a_fired_billing_tripwire_stops_the_next_process_too() {
    let dir = tempfile::tempdir().expect("temp dir");
    let config = config(dir.path(), FAKE_CLAUDE, &refused_url());
    let args = ["complete", "--config", config.to_str().expect("utf-8")];

    let first = run(
        &args,
        "a prompt",
        &[(
            "FAKE_CLAUDE_STDOUT",
            claude_fixture("observed-api-key-invalid.verbose.json"),
        )],
    );
    assert_eq!(first.status.code(), Some(3), "{first:?}");
    assert!(dir.path().join("journal.billing-tripped").exists());

    let second = run(
        &args,
        "a prompt",
        &[(
            "FAKE_CLAUDE_STDOUT",
            claude_fixture("synthetic-success.verbose.json"),
        )],
    );
    assert_eq!(second.status.code(), Some(3), "{second:?}");
    assert!(String::from_utf8_lossy(&second.stderr).contains("latched"));
}

/// 8.22: `--backend` names the one backend to try; an unknown name is a
/// usage error (exit 2) listing the configured names.
#[test]
fn the_backend_option_picks_one_backend() {
    let dir = tempfile::tempdir().expect("temp dir");
    let (lm_url, _) = support::serve(200, LM_SUCCESS);
    let config = config(dir.path(), FAKE_CLAUDE, &lm_url);
    let config = config.to_str().expect("utf-8");

    // A Claude that would answer: named, lm-studio answers alone.
    let claude = [(
        "FAKE_CLAUDE_STDOUT",
        claude_fixture("synthetic-success.verbose.json"),
    )];
    let output = run(
        &["complete", "--config", config, "--backend", "lm-studio"],
        "p",
        &claude,
    );
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert_eq!(String::from_utf8_lossy(&output.stdout), "Hello!");
    assert!(
        journal(dir.path())[0]["attempts"]
            .as_array()
            .is_none_or(Vec::is_empty)
    );

    let output = run(
        &["complete", "--config", config, "--backend", "gpt"],
        "p",
        &claude,
    );
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("claude-code, lm-studio"),
        "{output:?}"
    );
}

/// 8.27: `--schema FILE` asks for structured output from the command line,
/// as `"schema"` does on the endpoint.
#[test]
fn the_schema_option_reaches_the_cli_as_json_schema() {
    let dir = tempfile::tempdir().expect("temp dir");
    let record = dir.path().join("record");
    std::fs::create_dir(&record).expect("record dir");
    let config = config(dir.path(), FAKE_CLAUDE, &refused_url());
    let schema = dir.path().join("schema.json");
    std::fs::write(&schema, r#"{"type": "object"}"#).expect("schema");

    let output = run(
        &[
            "complete",
            "--config",
            config.to_str().expect("utf-8"),
            "--backend",
            "claude-code",
            "--schema",
            schema.to_str().expect("utf-8"),
        ],
        "a prompt",
        &[
            (
                "FAKE_CLAUDE_STDOUT",
                claude_fixture("synthetic-structured-output.verbose.json"),
            ),
            ("FAKE_CLAUDE_RECORD", record.to_string_lossy().into_owned()),
        ],
    );

    assert_eq!(output.status.code(), Some(0), "{output:?}");
    let args: Vec<String> =
        serde_json::from_str(&std::fs::read_to_string(record.join("args.json")).expect("args"))
            .expect("list");
    let at = args
        .iter()
        .position(|a| a == "--json-schema")
        .expect("--json-schema given");
    assert_eq!(
        serde_json::from_str::<Value>(&args[at + 1]).expect("json"),
        serde_json::json!({"type": "object"})
    );
    let answer: Value =
        serde_json::from_slice(&output.stdout).expect("the answer is the structured JSON");
    assert_eq!(answer["requirements"][0]["name"], "Kubernetes");
}

#[test]
fn a_schema_file_that_is_not_an_object_is_a_usage_error() {
    let dir = tempfile::tempdir().expect("temp dir");
    let record = dir.path().join("record");
    std::fs::create_dir(&record).expect("record dir");
    let config = config(dir.path(), FAKE_CLAUDE, &refused_url());
    let schema = dir.path().join("schema.json");
    std::fs::write(&schema, "[1]").expect("schema");

    let output = run(
        &[
            "complete",
            "--config",
            config.to_str().expect("utf-8"),
            "--schema",
            schema.to_str().expect("utf-8"),
        ],
        "a prompt",
        &[("FAKE_CLAUDE_RECORD", record.to_string_lossy().into_owned())],
    );

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("schema.json"),
        "{output:?}"
    );
    assert!(!record.join("args.json").exists(), "the backend was called");
}

/// 8.29: an answer billed as extra usage latches like any billing tripwire:
/// the next process stops before claude runs.
#[test]
fn an_overage_answer_latches_the_next_process_too() {
    let dir = tempfile::tempdir().expect("temp dir");
    let config = config(dir.path(), FAKE_CLAUDE, &refused_url());
    let args = ["complete", "--config", config.to_str().expect("utf-8")];
    let observed =
        std::fs::read_to_string(claude_fixture("observed-success.verbose.json")).expect("fixture");
    let mut messages: Vec<Value> = serde_json::from_str(&observed).expect("array");
    for message in &mut messages {
        if message["type"] == "rate_limit_event" {
            message["rate_limit_info"]["isUsingOverage"] = Value::Bool(true);
        }
    }
    let overage = dir.path().join("overage.json");
    std::fs::write(&overage, Value::Array(messages).to_string()).expect("write");

    let first = run(
        &args,
        "a prompt",
        &[("FAKE_CLAUDE_STDOUT", overage.to_string_lossy().into_owned())],
    );
    assert_eq!(first.status.code(), Some(3), "{first:?}");
    assert!(
        String::from_utf8_lossy(&first.stderr).contains("overage"),
        "{first:?}"
    );
    assert!(dir.path().join("journal.billing-tripped").exists());

    let second = run(
        &args,
        "a prompt",
        &[(
            "FAKE_CLAUDE_STDOUT",
            claude_fixture("observed-success.verbose.json"),
        )],
    );
    assert_eq!(second.status.code(), Some(3), "{second:?}");
    assert!(String::from_utf8_lossy(&second.stderr).contains("latched"));
}

/// 8.30: `stats` reads the configured journal and writes nothing.
#[test]
fn the_stats_command_sums_up_the_journal() {
    let dir = tempfile::tempdir().expect("temp dir");
    let config = config(dir.path(), FAKE_CLAUDE, &refused_url());
    let journal = dir.path().join("journal.jsonl");
    std::fs::write(
        &journal,
        "{\"outcome\":\"answered\",\"backend\":\"lm-studio\",\"attempts\":[],\"duration_ms\":10}\n",
    )
    .expect("journal");

    let output = run(
        &["stats", "--config", config.to_str().expect("utf-8")],
        "",
        &[],
    );
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stdout).starts_with("requests: 1\n"),
        "{output:?}"
    );
    assert_eq!(
        std::fs::read_to_string(&journal)
            .expect("journal")
            .lines()
            .count(),
        1,
        "nothing appended"
    );
}
