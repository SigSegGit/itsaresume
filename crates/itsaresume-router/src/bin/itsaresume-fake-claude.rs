//! A stand-in for the `claude` CLI, for the tests of `ClaudeCodeBackend` only.
//!
//! It is a real child process, so the tests exercise the real spawn, stdin,
//! environment, working directory and timeout — only the model is fake.
//! Driven by environment variables (which the backend passes through, since
//! they are not metered credentials):
//!
//! - `FAKE_CLAUDE_RECORD=<dir>`: write `args.json`, `stdin.txt`,
//!   `env-names.txt` (one name per line) and `cwd.txt` there;
//! - `FAKE_CLAUDE_SLEEP_MS=<n>`: sleep before answering;
//! - `FAKE_CLAUDE_STDOUT=<file>`: print that file on stdout;
//! - `FAKE_CLAUDE_STDERR=<text>`: print that text on stderr;
//! - `FAKE_CLAUDE_EXIT=<code>`: exit with that code (default 0).

use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

fn main() {
    let mut stdin = String::new();
    // A closed or absent stdin is fine: the test that cares checks the record.
    let _ = std::io::stdin().read_to_string(&mut stdin);

    if let Ok(dir) = std::env::var("FAKE_CLAUDE_RECORD") {
        record(Path::new(&dir), &stdin);
    }
    if let Some(ms) = number("FAKE_CLAUDE_SLEEP_MS") {
        std::thread::sleep(Duration::from_millis(ms));
    }
    if let Ok(file) = std::env::var("FAKE_CLAUDE_STDOUT") {
        let content = std::fs::read(file).expect("FAKE_CLAUDE_STDOUT names a readable file");
        std::io::stdout()
            .write_all(&content)
            .expect("stdout is writable");
    }
    if let Ok(text) = std::env::var("FAKE_CLAUDE_STDERR") {
        std::io::stderr()
            .write_all(text.as_bytes())
            .expect("stderr is writable");
    }
    let code = number("FAKE_CLAUDE_EXIT").unwrap_or(0);
    std::process::exit(i32::try_from(code).unwrap_or(1));
}

fn number(name: &str) -> Option<u64> {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
}

fn record(dir: &Path, stdin: &str) {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args = serde_json::to_string(&args).expect("argv serialises");
    let mut names: Vec<String> = std::env::vars_os()
        .map(|(name, _)| name.to_string_lossy().into_owned())
        .collect();
    names.sort();
    let cwd = std::env::current_dir().expect("a working directory");
    std::fs::write(dir.join("args.json"), args).expect("record args");
    std::fs::write(dir.join("stdin.txt"), stdin).expect("record stdin");
    std::fs::write(dir.join("env-names.txt"), names.join("\n")).expect("record env");
    std::fs::write(dir.join("cwd.txt"), cwd.to_string_lossy().as_bytes()).expect("record cwd");
}
