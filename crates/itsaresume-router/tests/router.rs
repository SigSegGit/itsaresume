//! The fallback rules of `Router`, against scripted backends that count calls.

use itsaresume_router::{
    Answer, Backend, BackendError, Completion, Journal, NoBackends, Request, RouteError, Router,
};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

/// A backend that always gives the same reply and counts how often it was asked.
struct Scripted {
    name: &'static str,
    reply: Result<Completion, BackendError>,
    calls: Arc<AtomicUsize>,
}

fn scripted(
    name: &'static str,
    reply: Result<&str, BackendError>,
) -> (Box<dyn Backend>, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let backend = Scripted {
        name,
        reply: reply.map(|text| Completion {
            text: text.into(),
            rate_limit: None,
            usage: None,
        }),
        calls: Arc::clone(&calls),
    };
    (Box::new(backend), calls)
}

impl Backend for Scripted {
    fn name(&self) -> &str {
        self.name
    }

    fn complete(&self, _request: &Request) -> Result<Completion, BackendError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.reply.clone()
    }
}

fn request() -> Request {
    Request::new("write a summary")
}

/// A router journaling into a throwaway directory, kept alive with it.
fn router(backends: Vec<Box<dyn Backend>>) -> (Router, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("temp dir");
    let journal = Journal::new(dir.path().join("journal.jsonl"));
    (Router::new(backends, journal).expect("backends"), dir)
}

#[test]
fn first_backend_answers_and_the_next_is_not_called() {
    let (a, a_calls) = scripted("a", Ok("from a"));
    let (b, b_calls) = scripted("b", Ok("from b"));
    let (router, _dir) = router(vec![a, b]);
    let outcome = router.complete(&request());

    assert_eq!(
        outcome.result,
        Ok(Answer {
            backend: "a".into(),
            text: "from a".into(),
            rate_limit: None,
            usage: None,
        })
    );
    assert!(outcome.attempts.is_empty());
    assert_eq!(a_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        b_calls.load(Ordering::SeqCst),
        0,
        "a later backend must not be asked once one has answered"
    );
}

#[test]
fn quota_exceeded_falls_back_to_the_next_backend() {
    let (a, _) = scripted("a", Err(BackendError::QuotaExceeded("plan limit".into())));
    let (b, b_calls) = scripted("b", Ok("from b"));
    let (router, _dir) = router(vec![a, b]);
    let outcome = router.complete(&request());

    assert_eq!(outcome.result.map(|answer| answer.backend), Ok("b".into()));
    assert_eq!(b_calls.load(Ordering::SeqCst), 1);
    assert_eq!(outcome.attempts.len(), 1);
    assert_eq!(outcome.attempts[0].backend, "a");
    assert_eq!(outcome.attempts[0].error.kind(), "quota_exceeded");
}

#[test]
fn unreachable_falls_back_to_the_next_backend() {
    let (a, _) = scripted("a", Err(BackendError::Unreachable("refused".into())));
    let (b, b_calls) = scripted("b", Ok("from b"));
    let (router, _dir) = router(vec![a, b]);
    let outcome = router.complete(&request());

    assert_eq!(outcome.result.map(|answer| answer.backend), Ok("b".into()));
    assert_eq!(b_calls.load(Ordering::SeqCst), 1);
}

/// The deliberate rule: an `Other` error is returned, and the next backend is
/// never asked — not asked and ignored, never asked.
#[test]
fn other_error_stops_without_trying_the_next_backend() {
    let (a, _) = scripted("a", Err(BackendError::Other("not logged in".into())));
    let (b, b_calls) = scripted("b", Ok("from b"));
    let (router, _dir) = router(vec![a, b]);
    let outcome = router.complete(&request());

    assert_eq!(
        outcome.result,
        Err(RouteError::Stopped {
            backend: "a".into(),
            error: BackendError::Other("not logged in".into()),
        })
    );
    assert_eq!(
        b_calls.load(Ordering::SeqCst),
        0,
        "Other must not fall back: the next backend would silently hide it"
    );
    assert_eq!(outcome.attempts.len(), 1);
}

#[test]
fn every_backend_failing_with_fallback_kinds_is_exhausted_with_attempts_in_order() {
    let (a, _) = scripted("a", Err(BackendError::QuotaExceeded("limit".into())));
    let (b, _) = scripted("b", Err(BackendError::Unreachable("timeout".into())));
    let (router, _dir) = router(vec![a, b]);
    let outcome = router.complete(&request());

    assert_eq!(outcome.result, Err(RouteError::Exhausted));
    let tried: Vec<(&str, &str)> = outcome
        .attempts
        .iter()
        .map(|attempt| (attempt.backend.as_str(), attempt.error.kind()))
        .collect();
    assert_eq!(tried, vec![("a", "quota_exceeded"), ("b", "unreachable")]);
}

#[test]
fn an_empty_router_is_refused() {
    assert!(matches!(
        Router::new(Vec::new(), Journal::new("unused.jsonl")),
        Err(NoBackends)
    ));
}

/// 8.22: a request naming a backend is answered by that backend alone: the
/// caller asked for it, so there is no fallback (a measure per model).
#[test]
fn a_named_backend_is_the_only_one_tried() {
    let (a, a_calls) = scripted("a", Err(BackendError::QuotaExceeded("spent".into())));
    let (b, b_calls) = scripted("b", Ok("from b"));
    let dir = tempfile::tempdir().expect("temp dir");
    let router =
        Router::new(vec![a, b], Journal::new(dir.path().join("j.jsonl"))).expect("backends");

    let outcome = router
        .complete_on(&request(), Some("b"))
        .expect("b is configured");
    assert_eq!(outcome.result.expect("b answers").backend, "b");
    assert_eq!(a_calls.load(Ordering::SeqCst), 0, "a was tried");

    let outcome = router
        .complete_on(&request(), Some("a"))
        .expect("a is configured");
    assert_eq!(
        outcome.result.expect_err("a is spent"),
        RouteError::Exhausted
    );
    assert_eq!(
        b_calls.load(Ordering::SeqCst),
        1,
        "b was tried after a named a"
    );
}

#[test]
fn an_unknown_backend_name_is_refused_with_the_configured_names() {
    let (a, a_calls) = scripted("a", Ok("from a"));
    let (b, _) = scripted("b", Ok("from b"));
    let dir = tempfile::tempdir().expect("temp dir");
    let router =
        Router::new(vec![a, b], Journal::new(dir.path().join("j.jsonl"))).expect("backends");

    let error = router
        .complete_on(&request(), Some("c"))
        .expect_err("c is not configured");
    assert!(
        error.to_string().contains("\"c\"") && error.to_string().contains("a, b"),
        "{error}"
    );
    assert_eq!(a_calls.load(Ordering::SeqCst), 0);
    let unnamed = router.complete_on(&request(), None).expect("no name");
    assert_eq!(unnamed.result.expect("a answers").backend, "a");
}

/// A backend that serves classification only (a small model, M2).
struct ClassifyOnly(Box<dyn Backend>);

impl Backend for ClassifyOnly {
    fn name(&self) -> &str {
        self.0.name()
    }
    fn serves(&self, kind: itsaresume_router::Kind) -> bool {
        kind == itsaresume_router::Kind::Classify
    }
    fn complete(&self, request: &Request) -> Result<Completion, BackendError> {
        self.0.complete(request)
    }
}

/// 8.34, M2's exit criterion: a generation request never reaches a backend
/// that serves classification only; it goes past it, as if absent.
#[test]
fn a_generation_request_goes_past_a_classify_only_backend() {
    let (small, small_calls) = scripted("small", Ok("yes"));
    let (big, _) = scripted("big", Ok("a whole CV"));
    let dir = tempfile::tempdir().expect("temp dir");
    let router = Router::new(
        vec![Box::new(ClassifyOnly(small)), big],
        Journal::new(dir.path().join("j.jsonl")),
    )
    .expect("backends");

    let generated = router.complete(&request());
    assert_eq!(generated.result.expect("big answers").backend, "big");
    assert!(generated.attempts.is_empty(), "skipping is not a failure");
    assert_eq!(
        small_calls.load(Ordering::SeqCst),
        0,
        "a generation reached the small model"
    );

    let classified = router.complete(&request().with_kind(itsaresume_router::Kind::Classify));
    assert_eq!(classified.result.expect("small answers").backend, "small");
}

#[test]
fn a_request_no_backend_serves_is_unserved() {
    let (small, small_calls) = scripted("small", Ok("yes"));
    let dir = tempfile::tempdir().expect("temp dir");
    let router = Router::new(
        vec![Box::new(ClassifyOnly(small))],
        Journal::new(dir.path().join("j.jsonl")),
    )
    .expect("backends");
    let outcome = router.complete(&request());
    assert!(
        matches!(outcome.result, Err(RouteError::Unserved { .. })),
        "{:?}",
        outcome.result
    );
    assert_eq!(small_calls.load(Ordering::SeqCst), 0);
}

/// 8.49 (the owner, 2026-10-14): every ~15 min each backend that cannot
/// probe itself gets one tiny request, so the page offers only what can
/// answer; one that answered real traffic within the period is not asked.
#[test]
fn a_check_asks_each_backend_once_and_records_its_state() {
    let (ok, ok_calls) = scripted("ok", Ok("ok"));
    let (spent, spent_calls) = scripted("spent", Err(BackendError::QuotaExceeded("429".into())));
    let (off, _) = scripted("off", Err(BackendError::Unreachable("down".into())));
    let (router, _dir) = router(vec![ok, spent, off]);
    let checked = router.check(std::time::Duration::from_secs(900));
    assert_eq!(checked, vec!["ok", "spent", "off"]);
    assert_eq!(
        (
            ok_calls.load(Ordering::SeqCst),
            spent_calls.load(Ordering::SeqCst)
        ),
        (1, 1)
    );
    let states: Vec<_> = router.status().into_iter().map(|s| s.state).collect();
    assert_eq!(states, vec!["up", "limited", "down"]);
}

#[test]
fn a_backend_seen_within_the_period_is_not_checked_again() {
    let (ok, calls) = scripted("ok", Ok("ok"));
    let (router, _dir) = router(vec![ok]);
    let _ = router.complete(&request());
    assert!(router.check(std::time::Duration::from_secs(900)).is_empty());
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "real traffic counts as a check"
    );
    assert_eq!(router.check(std::time::Duration::ZERO), vec!["ok"]);
}

/// 2026-10-29: a check every 15 min is ~96 requests a day, more than a
/// free-tier Gemini key allows (seen on the VM: 429 after one real CV). A
/// backend can be given its own, longer period.
#[test]
fn a_backend_with_its_own_period_is_checked_less_often() {
    let (fast, fast_calls) = scripted("fast", Ok("ok"));
    let (slow, slow_calls) = scripted("slow", Ok("ok"));
    let (router, _dir) = router(vec![fast, slow]);
    let router = router.with_check_period("slow", std::time::Duration::from_secs(21_600));
    assert_eq!(
        router.check(std::time::Duration::ZERO),
        vec!["fast", "slow"]
    );
    assert_eq!(router.check(std::time::Duration::ZERO), vec!["fast"]);
    assert_eq!(
        (
            fast_calls.load(Ordering::SeqCst),
            slow_calls.load(Ordering::SeqCst)
        ),
        (2, 1)
    );
}
