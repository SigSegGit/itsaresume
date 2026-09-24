//! What the router writes to the journal, read back from the real file.

use itsaresume_router::{Backend, BackendError, Completion, Journal, Request, Router};
use serde_json::Value;
use std::path::Path;

struct Fixed {
    name: &'static str,
    reply: Result<Completion, BackendError>,
}

impl Backend for Fixed {
    fn name(&self) -> &str {
        self.name
    }

    fn complete(&self, _request: &Request) -> Result<Completion, BackendError> {
        self.reply.clone()
    }
}

fn answers(name: &'static str, text: &str) -> Box<dyn Backend> {
    Box::new(Fixed {
        name,
        reply: Ok(Completion { text: text.into() }),
    })
}

fn fails(name: &'static str, error: BackendError) -> Box<dyn Backend> {
    Box::new(Fixed {
        name,
        reply: Err(error),
    })
}

fn lines(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .expect("journal file exists")
        .lines()
        .map(|line| serde_json::from_str(line).expect("each line is one JSON object"))
        .collect()
}

#[test]
fn every_request_appends_one_json_line_naming_the_answering_backend() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("journal.jsonl");
    let router = Router::new(
        vec![
            fails("claude-code", BackendError::QuotaExceeded("limit".into())),
            answers("lm-studio", "hello"),
        ],
        Journal::new(&path),
    )
    .expect("two backends");

    router.complete(&Request::new("one"));
    router.complete(&Request::new("two"));

    let lines = lines(&path);
    assert_eq!(lines.len(), 2, "one line per request, appended");
    let line = &lines[1];
    assert_eq!(line["outcome"], "answered");
    assert_eq!(line["backend"], "lm-studio");
    assert_eq!(line["attempts"][0]["backend"], "claude-code");
    assert_eq!(line["attempts"][0]["kind"], "quota_exceeded");
    assert_eq!(line["prompt_chars"], 3);
    assert_eq!(line["answer_chars"], 5);
    assert!(line["duration_ms"].is_u64());
    assert!(
        line["ts"].as_str().is_some_and(|ts| ts.ends_with('Z')),
        "timestamp is RFC 3339 UTC: {}",
        line["ts"]
    );
}

#[test]
fn stopped_and_exhausted_requests_are_journaled_too() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("journal.jsonl");
    let stopped = Router::new(
        vec![fails(
            "claude-code",
            BackendError::Other("not logged in".into()),
        )],
        Journal::new(&path),
    )
    .expect("one backend");
    let exhausted = Router::new(
        vec![fails(
            "lm-studio",
            BackendError::Unreachable("refused".into()),
        )],
        Journal::new(&path),
    )
    .expect("one backend");

    stopped.complete(&Request::new("x"));
    exhausted.complete(&Request::new("y"));

    let lines = lines(&path);
    assert_eq!(lines[0]["outcome"], "stopped");
    assert_eq!(lines[0]["backend"], "claude-code");
    assert_eq!(lines[0]["attempts"][0]["kind"], "other");
    assert_eq!(lines[0]["attempts"][0]["message"], "not logged in");
    assert_eq!(lines[1]["outcome"], "exhausted");
    assert!(lines[1]["backend"].is_null());
    assert!(lines[1]["answer_chars"].is_null());
}

/// Prompts will carry CV data: the journal must hold lengths, never text.
#[test]
fn the_prompt_and_answer_text_are_never_written_to_the_journal() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("journal.jsonl");
    let router = Router::new(
        vec![answers("lm-studio", "SENTINEL-ANSWER-91c4")],
        Journal::new(&path),
    )
    .expect("one backend");
    let request = Request {
        prompt: "SENTINEL-PROMPT-7f3a".into(),
        system: Some("SENTINEL-SYSTEM-2b8e".into()),
    };

    router.complete(&request);

    let written = std::fs::read_to_string(&path).expect("journal file exists");
    assert!(!written.is_empty(), "the request must have been journaled");
    for sentinel in [
        "SENTINEL-PROMPT-7f3a",
        "SENTINEL-SYSTEM-2b8e",
        "SENTINEL-ANSWER-91c4",
    ] {
        assert!(
            !written.contains(sentinel),
            "{sentinel} leaked into the journal"
        );
    }
}

#[test]
fn error_messages_are_truncated_in_the_journal() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("journal.jsonl");
    let router = Router::new(
        vec![fails("lm-studio", BackendError::Other("é".repeat(1000)))],
        Journal::new(&path),
    )
    .expect("one backend");

    router.complete(&Request::new("x"));

    let message = lines(&path)[0]["attempts"][0]["message"]
        .as_str()
        .expect("message is a string")
        .to_owned();
    assert!(
        message.chars().count() <= itsaresume_router::journal::MESSAGE_CHARS + 1,
        "message kept {} chars",
        message.chars().count()
    );
    assert!(message.ends_with('…'));
}

/// Losing the log is bad; losing the answer the plan already paid for is worse.
#[test]
fn an_unwritable_journal_does_not_lose_the_answer() {
    let dir = tempfile::tempdir().expect("temp dir");
    // A directory cannot be opened for appending.
    let router = Router::new(vec![answers("lm-studio", "kept")], Journal::new(dir.path()))
        .expect("one backend");

    let outcome = router.complete(&Request::new("x"));

    assert_eq!(outcome.result.map(|answer| answer.text), Ok("kept".into()));
    assert!(
        outcome.journal_error.is_some(),
        "the failure to journal must be reported, not swallowed"
    );
}
