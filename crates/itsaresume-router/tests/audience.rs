//! 2026-11-24 (the owner): who may spend what is the router's call, not a
//! feature's. Every backend is billed one way (subscription, API, free tier,
//! local); every request is the owner's or a customer's. A customer's
//! request never reaches a backend whose billing the configuration does not
//! allow for customers (the API only, by default): the owner's Claude
//! subscription stays his own use, as Anthropic's terms want.

use itsaresume_router::config::{Config, FAKE_API_KEY, anthropic_api_backend};
use itsaresume_router::{
    Audience, Backend, BackendError, Billing, Completion, Journal, Request, RouteError, Router,
};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Billed {
    name: &'static str,
    billing: Billing,
    calls: Arc<AtomicUsize>,
}

fn billed(name: &'static str, billing: Billing) -> (Box<dyn Backend>, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    (
        Box::new(Billed {
            name,
            billing,
            calls: Arc::clone(&calls),
        }),
        calls,
    )
}

impl Backend for Billed {
    fn name(&self) -> &str {
        self.name
    }

    fn billing(&self) -> Billing {
        self.billing
    }

    fn complete(&self, _request: &Request) -> Result<Completion, BackendError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(Completion {
            text: format!("from {}", self.name),
            rate_limit: None,
            usage: None,
        })
    }
}

fn router(backends: Vec<Box<dyn Backend>>) -> (Router, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("temp dir");
    let journal = Journal::new(dir.path().join("journal.jsonl"));
    (Router::new(backends, journal).expect("backends"), dir)
}

#[test]
fn a_customer_request_skips_the_subscription_the_owner_keeps_it() {
    let (subscription, sub_calls) = billed("claude-code", Billing::Subscription);
    let (api, api_calls) = billed("anthropic-api", Billing::Api);
    let (router, _dir) = router(vec![subscription, api]);
    let request = Request::new("a CV");

    let owner = router
        .complete_as(&request, None, Audience::Owner)
        .expect("known")
        .result
        .expect("answered");
    assert_eq!(
        owner.backend, "claude-code",
        "the owner's request takes the first backend"
    );

    let customer = router
        .complete_as(&request, None, Audience::Customer)
        .expect("known")
        .result
        .expect("answered");
    assert_eq!(customer.backend, "anthropic-api");
    assert_eq!(
        sub_calls.load(Ordering::SeqCst),
        1,
        "never asked for the customer"
    );
    assert_eq!(api_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn a_customer_request_with_no_allowed_backend_is_refused_and_nothing_is_called() {
    let (subscription, calls) = billed("claude-code", Billing::Subscription);
    let (local, local_calls) = billed("lm-studio", Billing::Local);
    let (router, dir) = router(vec![subscription, local]);
    let outcome = router
        .complete_as(&Request::new("a CV"), None, Audience::Customer)
        .expect("known");
    assert!(matches!(outcome.result, Err(RouteError::NotAllowed { .. })));
    assert_eq!(
        calls.load(Ordering::SeqCst) + local_calls.load(Ordering::SeqCst),
        0
    );
    let journal = std::fs::read_to_string(dir.path().join("journal.jsonl")).expect("journal");
    assert!(journal.contains("\"outcome\":\"not_allowed\""), "{journal}");
    assert!(journal.contains("\"audience\":\"customer\""), "{journal}");
}

#[test]
fn naming_a_subscription_backend_does_not_get_a_customer_through() {
    let (subscription, calls) = billed("claude-code", Billing::Subscription);
    let (api, _) = billed("anthropic-api", Billing::Api);
    let (router, _dir) = router(vec![subscription, api]);
    let outcome = router
        .complete_as(
            &Request::new("a CV"),
            Some("claude-code"),
            Audience::Customer,
        )
        .expect("known");
    assert!(matches!(outcome.result, Err(RouteError::NotAllowed { .. })));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn the_billings_allowed_to_customers_are_configurable() {
    let (subscription, _) = billed("claude-code", Billing::Subscription);
    let (local, _) = billed("lm-studio", Billing::Local);
    let (router, _dir) = router(vec![subscription, local]);
    let router = router.with_customer_billing(vec![Billing::Api, Billing::Local]);
    let answer = router
        .complete_as(&Request::new("a CV"), None, Audience::Customer)
        .expect("known")
        .result
        .expect("answered");
    assert_eq!(answer.backend, "lm-studio");
}

#[test]
fn each_kind_is_billed_its_way_and_customer_billing_parses() {
    let config = Config::parse(
        r#"
journal = "journal.jsonl"
customer_billing = ["api", "local"]

[[backend]]
kind = "claude-code"
program = "claude"

[[backend]]
kind = "anthropic-api"
model = "claude-haiku-5-5"

[[backend]]
kind = "lm-studio"
base_url = "http://127.0.0.1:1234/v1"
model = "qwen"

[[backend]]
kind = "groq"
model = "llama"
"#,
    )
    .expect("parses");
    let billings: Vec<Billing> = config.backends.iter().map(|b| b.billing()).collect();
    assert_eq!(
        billings,
        vec![
            Billing::Subscription,
            Billing::Api,
            Billing::Local,
            Billing::Free
        ]
    );
    assert_eq!(
        config.customer_billing(),
        vec![Billing::Api, Billing::Local]
    );
    assert_eq!(
        Config::parse("journal = \"j\"\n")
            .expect("parses")
            .customer_billing(),
        vec![Billing::Api],
        "absent: the API alone"
    );
    assert!(
        Config::parse("journal = \"j\"\ncustomer_billing = [\"subscription\"]\n").is_ok(),
        "the owner may allow it, knowingly"
    );
    assert!(
        Config::parse("journal = \"j\"\ncustomer_billing = [\"anything\"]\n").is_err(),
        "an unknown billing is refused"
    );
}

#[test]
fn an_api_key_never_sits_in_the_configuration() {
    assert!(
        Config::parse(
            "journal = \"j\"\n[[backend]]\nkind = \"anthropic-api\"\nmodel = \"m\"\napi_key = \"sk-ant-x\"\n"
        )
        .is_err()
    );
}

#[test]
fn the_fake_key_runs_on_the_subscription_but_is_billed_as_the_api() {
    let fake = anthropic_api_backend(
        "claude-haiku-5-5",
        Some(FAKE_API_KEY.into()),
        None,
        std::time::Duration::from_secs(5),
    );
    assert_eq!(
        fake.kind(),
        "claude-code",
        "the fake key leads to the subscription (test only)"
    );
    let real = anthropic_api_backend(
        "claude-haiku-5-5",
        Some("sk-ant-real".into()),
        None,
        std::time::Duration::from_secs(5),
    );
    assert_eq!(real.kind(), "anthropic-api");
    let none = anthropic_api_backend(
        "claude-haiku-5-5",
        None,
        None,
        std::time::Duration::from_secs(5),
    );
    let refused = none
        .complete(&Request::new("x"))
        .expect_err("no key, nothing sent");
    assert!(
        refused.message().contains("ANTHROPIC_API_KEY"),
        "{}",
        refused.message()
    );
}
