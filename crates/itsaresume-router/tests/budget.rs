//! 2026-11-24 (the owner, red team of the free trials): whatever gets
//! through on the customer side, a day's spend on customers has a ceiling.
//! `customer_daily_tokens` and `customer_daily_requests` cap the customer
//! requests answered in a UTC day; past either, a customer's request is
//! refused before any backend is asked. The owner's requests never count.
//! A restart reads the day's spend back from the journal.

use itsaresume_router::config::Config;
use itsaresume_router::{
    Audience, Backend, BackendError, Billing, Completion, Journal, Request, RouteError, Router,
    Usage,
};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Api {
    calls: Arc<AtomicUsize>,
    tokens: u64,
}

impl Backend for Api {
    fn name(&self) -> &str {
        "anthropic-api"
    }

    fn billing(&self) -> Billing {
        Billing::Api
    }

    fn complete(&self, _request: &Request) -> Result<Completion, BackendError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(Completion {
            text: "ok".into(),
            rate_limit: None,
            usage: Some(Usage {
                input: self.tokens / 2,
                output: self.tokens / 2,
                cache_read: 0,
                cache_creation: 0,
            }),
        })
    }
}

fn api(tokens: u64) -> (Box<dyn Backend>, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    (
        Box::new(Api {
            calls: Arc::clone(&calls),
            tokens,
        }),
        calls,
    )
}

fn ask(router: &Router, audience: Audience) -> Result<(), RouteError> {
    router
        .complete_as(&Request::new("a CV"), None, audience)
        .expect("known")
        .result
        .map(|_| ())
}

#[test]
fn past_the_day_s_tokens_a_customer_is_refused_before_any_backend_the_owner_is_not() {
    let dir = tempfile::tempdir().expect("temp dir");
    let (backend, calls) = api(600);
    let router = Router::new(vec![backend], Journal::new(dir.path().join("j.jsonl")))
        .expect("backends")
        .with_customer_budget(Some(1000), None);
    assert!(ask(&router, Audience::Customer).is_ok());
    assert!(ask(&router, Audience::Customer).is_ok(), "600 spent, under 1000: asked");
    assert!(matches!(
        ask(&router, Audience::Customer),
        Err(RouteError::OverBudget { .. })
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 2, "refused before the backend");
    assert!(ask(&router, Audience::Owner).is_ok(), "the owner's own use is never capped");
    let budget = router.customer_budget();
    assert_eq!((budget.tokens, budget.requests), (1200, 2));
    let journal = std::fs::read_to_string(dir.path().join("j.jsonl")).expect("journal");
    assert!(journal.contains("\"outcome\":\"over_budget\""), "{journal}");
}

#[test]
fn a_request_cap_holds_even_when_no_tokens_are_reported() {
    let dir = tempfile::tempdir().expect("temp dir");
    let (backend, calls) = api(0);
    let router = Router::new(vec![backend], Journal::new(dir.path().join("j.jsonl")))
        .expect("backends")
        .with_customer_budget(Some(1000), Some(2));
    assert!(ask(&router, Audience::Customer).is_ok());
    assert!(ask(&router, Audience::Customer).is_ok());
    assert!(matches!(
        ask(&router, Audience::Customer),
        Err(RouteError::OverBudget { .. })
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn a_restart_reads_the_day_s_customer_spend_back_from_the_journal() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("j.jsonl");
    {
        let (backend, _) = api(600);
        let router = Router::new(vec![backend], Journal::new(&path))
            .expect("backends")
            .with_customer_budget(Some(1000), None);
        assert!(ask(&router, Audience::Customer).is_ok());
        assert!(ask(&router, Audience::Owner).is_ok());
    }
    // An older day's line counts for nothing.
    let mut text = std::fs::read_to_string(&path).expect("journal");
    text.push_str("{\"ts\":\"2020-01-01T00:00:00.000Z\",\"outcome\":\"answered\",\"audience\":\"customer\",\"usage\":{\"input\":99999,\"output\":0,\"cache_read\":0,\"cache_creation\":0}}\n");
    std::fs::write(&path, text).expect("write");
    let (backend, _) = api(600);
    let router = Router::new(vec![backend], Journal::new(&path))
        .expect("backends")
        .with_customer_budget(Some(1000), None);
    let budget = router.customer_budget();
    assert_eq!((budget.tokens, budget.requests), (600, 1), "the owner's line and the old day left out");
}

#[test]
fn the_budget_is_configured_and_shown() {
    let config = Config::parse(
        "journal = \"j\"\ncustomer_daily_tokens = 2000000\ncustomer_daily_requests = 500\n",
    )
    .expect("parses");
    assert_eq!(config.customer_daily_tokens, Some(2_000_000));
    assert_eq!(config.customer_daily_requests, Some(500));
    let dir = tempfile::tempdir().expect("temp dir");
    let (backend, _) = api(10);
    let router = Router::new(vec![backend], Journal::new(dir.path().join("j.jsonl")))
        .expect("backends")
        .with_customer_budget(Some(100), Some(5));
    let budget = router.customer_budget();
    assert_eq!((budget.tokens_limit, budget.requests_limit), (Some(100), Some(5)));
}
