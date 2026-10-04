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

use itsaresume_router::stats::summarize_by_day;

const TWO_DAYS: &str = r#"{"ts":"2026-09-29T09:00:00.000Z","outcome":"answered","backend":"claude-code","attempts":[],"duration_ms":10}
{"ts":"2026-09-29T14:02:31.000Z","outcome":"answered","backend":"lm-studio","attempts":[{"backend":"claude-code","kind":"quota_exceeded"}],"duration_ms":10}
{"ts":"2026-09-29T15:00:00.000Z","outcome":"answered","backend":"lm-studio","attempts":[{"backend":"claude-code","kind":"quota_exceeded"}],"duration_ms":10}
{"ts":"2026-09-30T08:00:00.000Z","outcome":"answered","backend":"claude-code","attempts":[],"duration_ms":10,"rate_limit":{"status":"allowed_warning"}}
{"ts":"2026-09-30T09:00:00.000Z","outcome":"answered","backend":"claude-code","attempts":[],"duration_ms":10,"rate_limit":{"status":"allowed"}}
"#;

/// 8.33, M4's exit criterion: per day, who answered, and when the plan
/// ran out (a quota failure, or an answer whose limit was not "allowed").
#[test]
fn the_journal_by_day_says_when_the_plan_ran_out() {
    assert_eq!(
        summarize_by_day(TWO_DAYS),
        "2026-09-29: 3 requests; answered by claude-code 1, lm-studio 2; 2 quota hits, first at 14:02 UTC\n\
         2026-09-30: 2 requests; answered by claude-code 2; 1 quota hit, first at 08:00 UTC\n"
    );
    assert_eq!(
        summarize_by_day(
            r#"{"ts":"2026-09-30T08:00:00Z","outcome":"answered","backend":"lm-studio","attempts":[]}"#
        ),
        "2026-09-30: 1 request; answered by lm-studio 1; no quota hit\n"
    );
}

/// A `ts` of multi-byte characters is long enough in bytes but cannot be cut
/// at byte 10: the line is skipped, nothing panics, the others are summed.
#[test]
fn a_timestamp_of_multibyte_characters_is_skipped_not_fatal() {
    let journal = "{\"ts\":\"€€€€€€\",\"outcome\":\"answered\",\"backend\":\"claude-code\"}\n\
{\"ts\":\"2026-09-29T09:00:00.000Z\",\"outcome\":\"answered\",\"backend\":\"claude-code\"}\n";
    let text = summarize_by_day(journal);
    assert_eq!(
        text,
        "2026-09-29: 1 request; answered by claude-code 1; no quota hit\n"
    );
}

/// 8.38: the tokens are summed per backend, Claude and the local model apart:
/// read (the cache included: what it served is said apart), and written, over the answers
/// that reported them. A journal without any `usage` prints no token line
/// (the first test).
#[test]
fn tokens_are_summed_per_backend() {
    let journal = r#"{"outcome":"answered","backend":"claude-code","attempts":[],"duration_ms":10,"usage":{"input":3,"output":179,"cache_read":6914,"cache_creation":7109}}
{"outcome":"answered","backend":"claude-code","attempts":[],"duration_ms":10,"usage":{"input":7,"output":21,"cache_read":86,"cache_creation":0}}
{"outcome":"answered","backend":"claude-code","attempts":[],"duration_ms":10}
{"outcome":"answered","backend":"lm-studio","attempts":[],"duration_ms":10,"usage":{"input":24,"output":5}}
"#;
    let text = summarize(journal);
    let tokens: Vec<&str> = text
        .lines()
        .filter(|line| line.starts_with("tokens"))
        .collect();
    assert_eq!(
        tokens,
        [
            "tokens by claude-code: 14119 read (7000 from cache), 200 written, over 2 answers",
            "tokens by lm-studio: 24 read, 5 written, over 1 answer",
        ],
        "{text}"
    );
}
