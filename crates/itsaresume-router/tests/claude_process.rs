//! `ClaudeCodeBackend` driving a real child process: the fake `claude` built
//! from `src/bin/itsaresume-fake-claude.rs`, which records what it received.

use itsaresume_router::claude_code::{ClaudeCodeBackend, DEFAULT_SYSTEM_PROMPT, METERED_ENV};
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

/// The system prompt as the fake read it from `--system-prompt-file`.
fn recorded_system(scene: &Scene) -> String {
    std::fs::read_to_string(scene.record.join("system.txt"))
        .expect("the fake read a --system-prompt-file")
}

fn system_file_arg(args: &[String]) -> PathBuf {
    let position = args
        .iter()
        .position(|arg| arg == "--system-prompt-file")
        .expect("--system-prompt-file is passed");
    PathBuf::from(&args[position + 1])
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
    assert_eq!(recorded_system(&scene), "You write CVs.");
    assert!(has_pair("--model", "sonnet"), "{args:?}");
    // No user or project settings: an `env` block there could route the child
    // to a paid gateway after the environment scrub. Observed on 2.1.162: the
    // empty list is accepted and OAuth still answers.
    assert!(has_pair("--setting-sources", ""), "{args:?}");
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
    assert_eq!(recorded_system(&scene), DEFAULT_SYSTEM_PROMPT);
    assert!(
        !args.contains(&"--model".to_owned()),
        "no model unless configured"
    );
}

/// The system prompt goes through a file, never argv (observed on 2.1.162:
/// `--system-prompt-file` is read as UTF-8). On the command line, a long one
/// (a whole profile) or one holding a NUL failed the spawn as `Other`, and
/// argv is readable by every local process.
#[test]
fn a_long_system_prompt_reaches_the_cli_whole_and_off_the_command_line() {
    let scene = scene();
    let system = format!(
        "Profil : {}\0fin — é",
        "ingénieur SRE, 25 ans. ".repeat(4_500)
    );
    assert!(system.len() > 100_000);
    let request = Request {
        prompt: "p".into(),
        system: Some(system.clone()),
    };

    let outcome = backend(&scene).complete_with_env(&request, success_env(&scene));

    assert_eq!(
        outcome,
        Ok(Completion {
            text: "Synthetic answer.".into()
        })
    );
    assert!(
        recorded_system(&scene) == system,
        "the system prompt arrives whole"
    );
    let args = recorded_args(&scene);
    assert!(!args.contains(&"--system-prompt".to_owned()), "{args:?}");
    assert!(
        args.iter().all(|arg| !arg.contains("ingénieur SRE")),
        "the system prompt must not be on the command line"
    );
}

#[test]
fn the_system_prompt_file_is_removed_once_the_cli_has_answered() {
    let scene = scene();

    backend(&scene)
        .complete_with_env(&Request::new("p"), success_env(&scene))
        .expect("the fake answers");

    let file = system_file_arg(&recorded_args(&scene));
    assert!(!file.exists(), "left behind: {file:?}");
}

#[test]
fn the_system_prompt_file_is_removed_when_the_cli_is_killed() {
    let scene = scene();
    let mut env = success_env(&scene);
    env.push(("FAKE_CLAUDE_SLEEP_MS".into(), "5000".into()));

    let outcome = backend(&scene)
        .with_timeout(Duration::from_millis(500))
        .complete_with_env(&Request::new("p"), env);

    assert!(
        matches!(outcome, Err(BackendError::Unreachable(_))),
        "{outcome:?}"
    );
    let file = system_file_arg(&recorded_args(&scene));
    assert!(!file.exists(), "left behind: {file:?}");
}

/// The server runs up to four completions at once, in one working directory:
/// each must get its own file.
#[test]
fn concurrent_requests_each_get_their_own_system_prompt() {
    let workdir = tempfile::tempdir().expect("temp dir");
    let calls: Vec<_> = ["System A.", "System B."]
        .into_iter()
        .map(|system| {
            let scene = scene();
            let workdir = workdir.path().to_owned();
            std::thread::spawn(move || {
                let mut env = success_env(&scene);
                env.push(("FAKE_CLAUDE_SLEEP_MS".into(), "300".into()));
                let request = Request {
                    prompt: "p".into(),
                    system: Some(system.into()),
                };
                let outcome = backend(&scene)
                    .with_workdir(workdir)
                    .complete_with_env(&request, env);
                (outcome, recorded_system(&scene), system)
            })
        })
        .collect();

    for call in calls {
        let (outcome, received, sent) = call.join().expect("no panic");
        assert!(outcome.is_ok(), "{outcome:?}");
        assert_eq!(received, sent);
    }
}

#[cfg(unix)]
#[test]
fn the_system_prompt_file_is_readable_by_its_owner_only() {
    let scene = scene();

    backend(&scene)
        .complete_with_env(&Request::new("p"), success_env(&scene))
        .expect("the fake answers");

    let mode =
        std::fs::read_to_string(scene.record.join("system-mode.txt")).expect("mode recorded");
    assert_eq!(mode, "600");
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
        // Another configuration directory brings its own settings file.
        "CLAUDE_CONFIG_DIR",
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

/// Returning in time is not proof of a kill: an abandoned child would still
/// run, and a real one would still spend the plan. The fake creates a file
/// once its sleep is over; a killed child never gets there.
#[test]
fn a_timed_out_cli_is_dead_not_abandoned() {
    let scene = scene();
    let survived = scene.record.join("survived");
    let survived_text = survived.to_string_lossy().into_owned();
    let env = env_with(&[
        ("FAKE_CLAUDE_SLEEP_MS", "1000"),
        ("FAKE_CLAUDE_SURVIVED", &survived_text),
    ]);

    let outcome = backend(&scene)
        .with_timeout(Duration::from_millis(200))
        .complete_with_env(&Request::new("p"), env);
    assert!(
        matches!(outcome, Err(BackendError::Unreachable(_))),
        "{outcome:?}"
    );

    std::thread::sleep(Duration::from_millis(2500));
    assert!(
        !survived.exists(),
        "the timed-out child outlived its sleep: it was abandoned, not killed"
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

fn metered_env(scene: &Scene) -> Vec<(OsString, OsString)> {
    let stdout = fixture("observed-api-key-invalid.verbose.json");
    env_with(&[
        (
            "FAKE_CLAUDE_RECORD",
            scene.record.to_str().expect("utf-8 path"),
        ),
        ("FAKE_CLAUDE_STDOUT", stdout.to_str().expect("utf-8 path")),
    ])
}

/// Once the billing tripwire has fired, no later request starts claude again:
/// under `serve`, each one would be billed per token too. The latch survives
/// a restart through a marker file.
#[test]
fn a_fired_billing_tripwire_latches_even_across_a_restart() {
    let scene = scene();
    let marker = scene.workdir.with_file_name("billing-tripped");
    let latched = backend(&scene).with_latch_file(&marker);

    let first = latched.complete_with_env(&Request::new("p"), metered_env(&scene));
    assert!(
        matches!(&first, Err(BackendError::Other(m)) if m.starts_with("billing tripwire")),
        "{first:?}"
    );
    assert!(marker.exists(), "the latch is written down");

    std::fs::remove_file(scene.record.join("args.json")).expect("spawned once");
    let second = latched.complete_with_env(&Request::new("p"), success_env(&scene));
    assert!(
        matches!(&second, Err(BackendError::Other(m)) if m.contains("latched")),
        "{second:?}"
    );
    let restarted = backend(&scene).with_latch_file(&marker);
    let third = restarted.complete_with_env(&Request::new("p"), success_env(&scene));
    assert!(
        matches!(&third, Err(BackendError::Other(m)) if m.contains("latched")),
        "{third:?}"
    );
    assert!(
        !scene.record.join("args.json").exists(),
        "claude was never started again"
    );

    // Without a marker file, the latch still holds for this process.
    let in_memory = backend(&scene);
    let _ = in_memory.complete_with_env(&Request::new("p"), metered_env(&scene));
    std::fs::remove_file(scene.record.join("args.json")).expect("spawned once");
    let again = in_memory.complete_with_env(&Request::new("p"), success_env(&scene));
    assert!(
        matches!(&again, Err(BackendError::Other(m)) if m.contains("latched")),
        "{again:?}"
    );
    assert!(!scene.record.join("args.json").exists());
}
