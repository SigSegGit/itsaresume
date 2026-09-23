//! `ClaudeCodeBackend` driving a real child process: the fake `claude` built
//! from `src/bin/itsaresume-fake-claude.rs`, which records what it received.

use itsaresume_router::claude_code::{ClaudeCodeBackend, METERED_ENV};
use itsaresume_router::{BackendError, Completion, Request};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const FAKE: &str = env!("CARGO_BIN_EXE_itsaresume-fake-claude");

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/claude")
        .join(name)
}

/// A scratch area: where the fake records, and the backend's working directory.
struct Scene {
    _root: tempfile::TempDir,
    record: PathBuf,
    workdir: PathBuf,
}

fn scene() -> Scene {
    let root = tempfile::tempdir().expect("temp dir");
    let record = root.path().join("record");
    std::fs::create_dir(&record).expect("record dir");
    let workdir = root.path().join("claude-workdir");
    Scene {
        record,
        workdir,
        _root: root,
    }
}

/// The real environment plus `extra`, the way the backend would inherit it.
fn env_with(extra: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    env.extend(
        extra
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value))),
    );
    env
}

fn backend(scene: &Scene) -> ClaudeCodeBackend {
    ClaudeCodeBackend::new(FAKE)
        .with_workdir(&scene.workdir)
        .with_timeout(Duration::from_secs(30))
}

fn recorded_args(scene: &Scene) -> Vec<String> {
    let raw = std::fs::read_to_string(scene.record.join("args.json")).expect("args recorded");
    serde_json::from_str(&raw).expect("args are a JSON list")
}

fn success_env(scene: &Scene) -> Vec<(OsString, OsString)> {
    let stdout = fixture("synthetic-success.verbose.json");
    env_with(&[
        (
            "FAKE_CLAUDE_RECORD",
            scene.record.to_str().expect("utf-8 path"),
        ),
        ("FAKE_CLAUDE_STDOUT", stdout.to_str().expect("utf-8 path")),
    ])
}

#[test]
fn the_prompt_goes_on_stdin_and_the_answer_comes_back() {
    let scene = scene();
    let request = Request::new("Résumé d'une expérience de 3 ans en SRE.");

    let outcome = backend(&scene).complete_with_env(&request, success_env(&scene));

    assert_eq!(
        outcome,
        Ok(Completion {
            text: "Synthetic answer.".into()
        })
    );
    let stdin = std::fs::read_to_string(scene.record.join("stdin.txt")).expect("stdin recorded");
    assert_eq!(stdin, request.prompt, "the prompt travels on stdin, whole");
    assert!(
        !recorded_args(&scene).contains(&request.prompt),
        "the prompt must not be on the command line"
    );
}

#[test]
fn the_cli_runs_with_json_output_and_no_tools() {
    let scene = scene();
    let request = Request {
        prompt: "p".into(),
        system: Some("You write CVs.".into()),
    };

    backend(&scene)
        .with_model("sonnet")
        .complete_with_env(&request, success_env(&scene))
        .expect("the fake answers");

    let args = recorded_args(&scene);
    let has_pair = |a: &str, b: &str| args.windows(2).any(|w| w[0] == a && w[1] == b);
    assert!(args.contains(&"-p".to_owned()), "{args:?}");
    assert!(has_pair("--output-format", "json"), "{args:?}");
    assert!(args.contains(&"--verbose".to_owned()), "{args:?}");
    assert!(has_pair("--tools", ""), "tools must be disabled: {args:?}");
    assert!(args.contains(&"--strict-mcp-config".to_owned()), "{args:?}");
    assert!(
        args.contains(&"--disable-slash-commands".to_owned()),
        "{args:?}"
    );
    assert!(
        args.contains(&"--no-session-persistence".to_owned()),
        "{args:?}"
    );
    assert!(has_pair("--system-prompt", "You write CVs."), "{args:?}");
    assert!(has_pair("--model", "sonnet"), "{args:?}");
    assert!(
        !args.contains(&"--bare".to_owned()),
        "--bare forces API-key billing: {args:?}"
    );
}

#[test]
fn without_a_system_prompt_a_neutral_one_replaces_claude_codes_own() {
    let scene = scene();

    backend(&scene)
        .complete_with_env(&Request::new("p"), success_env(&scene))
        .expect("the fake answers");

    let args = recorded_args(&scene);
    let position = args
        .iter()
        .position(|arg| arg == "--system-prompt")
        .expect("a system prompt is always passed");
    assert!(!args[position + 1].is_empty());
    assert!(
        !args.contains(&"--model".to_owned()),
        "no model unless configured"
    );
}

/// Claude Code prefers `ANTHROPIC_API_KEY` over the subscription when it is
/// set (observed). None of the variables that switch it to metered billing
/// may reach the child; the subscription token must.
#[test]
fn metered_credentials_never_reach_the_child() {
    let scene = scene();
    let mut env = success_env(&scene);
    for name in METERED_ENV {
        env.push((OsString::from(name), OsString::from("metered-value")));
    }
    env.push((
        OsString::from("CLAUDE_CODE_OAUTH_TOKEN"),
        OsString::from("subscription-token"),
    ));

    backend(&scene)
        .complete_with_env(&Request::new("p"), env)
        .expect("the fake answers");

    let names = std::fs::read_to_string(scene.record.join("env-names.txt")).expect("env recorded");
    let names: Vec<&str> = names.lines().collect();
    for metered in METERED_ENV {
        assert!(
            !names.iter().any(|name| name.eq_ignore_ascii_case(metered)),
            "{metered} reached the claude process"
        );
    }
    assert!(
        names.contains(&"CLAUDE_CODE_OAUTH_TOKEN"),
        "the subscription token is kept"
    );
    assert!(
        names.iter().any(|name| name.eq_ignore_ascii_case("PATH")),
        "ordinary variables are kept"
    );
}

/// The list itself is part of the guarantee.
#[test]
fn the_metered_list_names_the_known_metered_switches() {
    for name in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
    ] {
        assert!(METERED_ENV.contains(&name), "{name} missing");
    }
    assert!(!METERED_ENV.contains(&"CLAUDE_CODE_OAUTH_TOKEN"));
}

/// No `CLAUDE.md` or project memory from wherever the router runs.
#[test]
fn the_child_runs_in_the_dedicated_working_directory() {
    let scene = scene();

    backend(&scene)
        .complete_with_env(&Request::new("p"), success_env(&scene))
        .expect("the fake answers");

    let cwd = std::fs::read_to_string(scene.record.join("cwd.txt")).expect("cwd recorded");
    assert_eq!(
        Path::new(&cwd).canonicalize().expect("cwd exists"),
        scene.workdir.canonicalize().expect("workdir was created")
    );
}

#[test]
fn a_missing_binary_is_unreachable() {
    let scene = scene();
    let missing = scene.workdir.join("no-such-claude");

    let outcome = ClaudeCodeBackend::new(&missing)
        .with_workdir(&scene.workdir)
        .complete_with_env(&Request::new("p"), env_with(&[]));

    assert!(
        matches!(outcome, Err(BackendError::Unreachable(_))),
        "{outcome:?}"
    );
}

/// Observed: with a bad credential the CLI retried for 183 s. A CLI that
/// does not answer in time is killed and counts as an outage.
#[test]
fn a_cli_that_does_not_answer_in_time_is_killed_and_unreachable() {
    let scene = scene();
    let env = env_with(&[("FAKE_CLAUDE_SLEEP_MS", "10000")]);
    let started = Instant::now();

    let outcome = backend(&scene)
        .with_timeout(Duration::from_millis(300))
        .complete_with_env(&Request::new("p"), env);

    assert!(
        matches!(outcome, Err(BackendError::Unreachable(_))),
        "{outcome:?}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the child must be killed, not waited for: {:?}",
        started.elapsed()
    );
}

#[test]
fn an_error_printed_by_the_cli_is_classified_like_the_captured_one() {
    let scene = scene();
    let stdout = fixture("observed-not-logged-in.verbose.json");
    let env = env_with(&[
        ("FAKE_CLAUDE_STDOUT", stdout.to_str().expect("utf-8 path")),
        ("FAKE_CLAUDE_EXIT", "1"),
    ]);

    let outcome = backend(&scene).complete_with_env(&Request::new("p"), env);

    match outcome {
        Err(BackendError::Other(message)) => assert!(message.contains("Not logged in")),
        other => panic!("expected Other(not logged in), got {other:?}"),
    }
}

#[test]
fn a_cli_that_prints_nothing_reports_its_stderr() {
    let scene = scene();
    let env = env_with(&[
        ("FAKE_CLAUDE_STDERR", "boom: config unreadable"),
        ("FAKE_CLAUDE_EXIT", "2"),
    ]);

    let outcome = backend(&scene).complete_with_env(&Request::new("p"), env);

    match outcome {
        Err(BackendError::Other(message)) => {
            assert!(message.contains("boom: config unreadable"), "{message}")
        }
        other => panic!("expected Other with stderr, got {other:?}"),
    }
}
