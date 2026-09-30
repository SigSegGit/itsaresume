//! 8.30: `itsaresume stats`, on a hand-written journal.

use itsaresume_router::stats::summarize;

const JOURNAL: &str = r#"{"outcome":"answered","backend":"lm-studio","attempts":[{"backend":"claude-code","kind":"quota_exceeded"}],"duration_ms":3000}
{"outcome":"answered","backend":"lm-studio","attempts":[],"duration_ms":1000,"schema":true,"backend_asked":"lm-studio"}
{"outcome":"answered","backend":"claude-code","attempts":[],"duration_ms":200}
this line is not JSON
{"outcome":"stopped","backend":"claude-code","attempts":[{"backend":"claude-code","kind":"other"}],"duration_ms":50,"schema":true}
{"outcome":"exhausted","backend":null,"attempts":[{"backend":"claude-code","kind":"quota_exceeded"},{"backend":"lm-studio","kind":"unreachable"}],"duration_ms":9000}
"#;

#[test]
fn the_journal_is_summed_up_per_backend_and_outcome() {
    let text = summarize(JOURNAL);
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(
        lines,
        [
            "requests: 5 (1 unreadable line skipped)",
            "answered by claude-code: 1, median 200 ms",
            "answered by lm-studio: 2, median 2000 ms",
            "stopped by claude-code: 1, median 50 ms",
            "exhausted: 1, median 9000 ms",
            "fallbacks: 1 answered after a failed attempt",
            "structured: 2 of 5",
        ],
        "{text}"
    );
}

#[test]
fn an_empty_journal_says_so() {
    assert_eq!(summarize(""), "requests: 0\n");
}
