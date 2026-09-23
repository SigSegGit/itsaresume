//! The fallback rules of `Router`, against scripted backends that count calls.

use itsaresume_router::{
    Answer, Backend, BackendError, Completion, NoBackends, Request, RouteError, Router,
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
        reply: reply.map(|text| Completion { text: text.into() }),
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

#[test]
fn first_backend_answers_and_the_next_is_not_called() {
    let (a, a_calls) = scripted("a", Ok("from a"));
    let (b, b_calls) = scripted("b", Ok("from b"));
    let outcome = Router::new(vec![a, b])
        .expect("two backends")
        .complete(&request());

    assert_eq!(
        outcome.result,
        Ok(Answer {
            backend: "a".into(),
            text: "from a".into()
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
    let outcome = Router::new(vec![a, b])
        .expect("two backends")
        .complete(&request());

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
    let outcome = Router::new(vec![a, b])
        .expect("two backends")
        .complete(&request());

    assert_eq!(outcome.result.map(|answer| answer.backend), Ok("b".into()));
    assert_eq!(b_calls.load(Ordering::SeqCst), 1);
}

/// The deliberate rule: an `Other` error is returned, and the next backend is
/// never asked — not asked and ignored, never asked.
#[test]
fn other_error_stops_without_trying_the_next_backend() {
    let (a, _) = scripted("a", Err(BackendError::Other("not logged in".into())));
    let (b, b_calls) = scripted("b", Ok("from b"));
    let outcome = Router::new(vec![a, b])
        .expect("two backends")
        .complete(&request());

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
    let outcome = Router::new(vec![a, b])
        .expect("two backends")
        .complete(&request());

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
    assert!(matches!(Router::new(Vec::new()), Err(NoBackends)));
}
