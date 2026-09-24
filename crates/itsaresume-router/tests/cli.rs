//! The `itsaresume complete` command, run as a real process against the fake
//! `claude` binary and a fake LM Studio server: the whole chain, end to end.

mod support;

use serde_json::Value;
use std::io::Write;
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
    let mut child = Command::new(CLI)
        .args(args)
        .envs(env.iter().map(|(name, value)| (*name, value.as_str())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the CLI starts");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(stdin.as_bytes())
        .expect("write the prompt");
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
    let args = std::fs::read_to_string(record.join("args.json")).expect("args");
    assert!(args.contains("You write CVs."), "{args}");
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
