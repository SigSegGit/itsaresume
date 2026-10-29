//! Seen on the VM (8.56): after `docker restart` the router came back with
//! the same pid, met `system-7-2.txt` left by its previous run, and gemini
//! stopped on "File exists". A taken name is skipped, never reopened.
//! Its own test binary: the file counter starts at 0 here, so the names
//! made below are the ones the backend tries first.

use itsaresume_router::Request;
use itsaresume_router::claude_code::ClaudeCodeBackend;
use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

const FAKE: &str = env!("CARGO_BIN_EXE_itsaresume-fake-claude");

#[test]
fn a_name_left_by_an_earlier_run_is_skipped_and_left_alone() {
    let root = tempfile::tempdir().expect("temp dir");
    let workdir = root.path().join("claude-workdir");
    std::fs::create_dir(&workdir).expect("workdir");
    let pid = std::process::id();
    let left: Vec<_> = (0..4)
        .flat_map(|n| {
            ["system", "answer"].map(|stem| workdir.join(format!("{stem}-{pid}-{n}.txt")))
        })
        .collect();
    for file in &left {
        std::fs::write(file, "an earlier run's").expect("left file");
    }
    let stdout = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/claude/synthetic-success.verbose.json");
    let mut env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    env.push(("FAKE_CLAUDE_STDOUT".into(), stdout.into_os_string()));

    let outcome = ClaudeCodeBackend::new(FAKE)
        .with_workdir(&workdir)
        .with_timeout(Duration::from_secs(30))
        .complete_with_env(&Request::new("hi"), env);

    assert!(outcome.is_ok(), "{outcome:?}");
    for file in &left {
        assert_eq!(
            std::fs::read_to_string(file).expect("still there"),
            "an earlier run's",
            "{}",
            file.display()
        );
    }
}
