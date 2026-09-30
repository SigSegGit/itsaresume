//! How the `claude` CLI's JSON output is classified, on the captures of
//! `tests/fixtures/claude/` (observed ones where they exist, synthetic ones
//! marked as hypotheses — see that directory's README).

use itsaresume_router::claude_code::{classify, classify_for};
use itsaresume_router::{BackendError, Completion};
use serde_json::{Value, json};

const OBSERVED_NOT_LOGGED_IN: &str =
    include_str!("fixtures/claude/observed-not-logged-in.verbose.json");
const OBSERVED_NOT_LOGGED_IN_PLAIN: &str =
    include_str!("fixtures/claude/observed-not-logged-in.json");
const OBSERVED_API_KEY: &str =
    include_str!("fixtures/claude/observed-api-key-invalid.verbose.json");
const SYNTHETIC_SUCCESS: &str = include_str!("fixtures/claude/synthetic-success.verbose.json");
const SYNTHETIC_USAGE_LIMIT: &str =
    include_str!("fixtures/claude/synthetic-usage-limit.verbose.json");
const OBSERVED_SUCCESS: &str = include_str!("fixtures/claude/observed-success.verbose.json");
const OBSERVED_STRUCTURED: &str =
    include_str!("fixtures/claude/observed-structured-output.verbose.json");
const SYNTHETIC_STRUCTURED: &str =
    include_str!("fixtures/claude/synthetic-structured-output.verbose.json");
const SYNTHETIC_OVERLOADED: &str =
    include_str!("fixtures/claude/synthetic-overloaded.verbose.json");

/// A fixture with its first (`system/init`) and last (`result`) messages edited.
fn edited(fixture: &str, edit: impl FnOnce(&mut Value, &mut Value)) -> String {
    let mut messages: Vec<Value> = serde_json::from_str(fixture).expect("fixture is a JSON array");
    let mut init = messages.remove(0);
    let mut result = messages.pop().expect("fixture has a result");
    edit(&mut init, &mut result);
    messages.insert(0, init);
    messages.push(result);
    Value::Array(messages).to_string()
}

/// The not-logged-in capture, turned into an error with this status and text.
fn failure(status: Value, message: &str) -> String {
    edited(OBSERVED_NOT_LOGGED_IN, |_, result| {
        result["api_error_status"] = status;
        result["result"] = json!(message);
    })
}

fn kind(outcome: &Result<Completion, BackendError>) -> &'static str {
    match outcome {
        Ok(_) => "success",
        Err(error) => error.kind(),
    }
}

#[test]
fn a_successful_run_is_an_answer() {
    assert_eq!(
        classify(SYNTHETIC_SUCCESS),
        Ok(Completion {
            text: "Synthetic answer.".into()
        })
    );
}

/// Observed: exit 1, `subtype: "success"`, `is_error: true`. `is_error` wins,
/// and "not logged in" is for a human to fix, so it stops the request.
#[test]
fn the_observed_not_logged_in_output_is_other() {
    let outcome = classify(OBSERVED_NOT_LOGGED_IN);
    assert_eq!(kind(&outcome), "other", "{outcome:?}");
    assert!(format!("{outcome:?}").contains("Not logged in"));
}

/// Observed with a bogus `ANTHROPIC_API_KEY`: the billing source is named in
/// `system/init`, and that alone must stop the request.
#[test]
fn the_observed_api_key_run_trips_the_billing_wire() {
    let outcome = classify(OBSERVED_API_KEY);
    assert_eq!(kind(&outcome), "other", "{outcome:?}");
    assert!(
        format!("{outcome:?}").contains("ANTHROPIC_API_KEY"),
        "the error must name the billing source: {outcome:?}"
    );
}

/// The case the tripwire exists for: an answer that *succeeded* but was billed
/// per token. The text is discarded.
#[test]
fn a_successful_answer_billed_to_an_api_key_is_refused() {
    for source in ["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"] {
        let output = edited(SYNTHETIC_SUCCESS, |init, _| {
            init["apiKeySource"] = json!(source);
        });
        let outcome = classify(&output);
        assert_eq!(kind(&outcome), "other", "{source}: {outcome:?}");
    }
}

/// No init message means the billing source cannot be checked: refuse.
#[test]
fn output_without_an_init_message_is_refused() {
    let outcome = classify(OBSERVED_NOT_LOGGED_IN_PLAIN);
    assert_eq!(kind(&outcome), "other", "{outcome:?}");
    let without_init = edited(SYNTHETIC_SUCCESS, |init, _| {
        init["subtype"] = json!("not-init");
    });
    assert_eq!(kind(&classify(&without_init)), "other");
}

/// CV prompts carry text copied from the web; a prompt-injected instruction
/// must find no tool to call.
#[test]
fn a_successful_answer_with_tools_enabled_is_refused() {
    let output = edited(SYNTHETIC_SUCCESS, |init, _| {
        init["tools"] = json!(["Bash"]);
    });
    let outcome = classify(&output);
    assert_eq!(kind(&outcome), "other", "{outcome:?}");
}

#[test]
fn the_synthetic_usage_limit_is_quota_exceeded() {
    let outcome = classify(SYNTHETIC_USAGE_LIMIT);
    assert_eq!(kind(&outcome), "quota_exceeded", "{outcome:?}");
}

/// HTTP 429 alone decides, whatever the wording.
#[test]
fn status_429_is_quota_exceeded_whatever_the_message() {
    let outcome = classify(&failure(json!(429), "Too many requests"));
    assert_eq!(kind(&outcome), "quota_exceeded", "{outcome:?}");
}

/// Hypothesis (not observed, HANDOVER §9): the wordings Claude Code has used
/// for plan limits, with no HTTP status attached.
#[test]
fn usage_limit_wordings_without_a_status_are_quota_exceeded() {
    for message in [
        "Claude AI usage limit reached|1759000000",
        "5-hour limit reached ∙ resets 3pm",
        "Weekly limit reached ∙ resets Mon 9am",
        "You've hit your limit · resets 5pm (Europe/Paris)",
        "You've hit your session limit",
        "You've reached your usage limit",
    ] {
        let outcome = classify(&failure(Value::Null, message));
        assert_eq!(kind(&outcome), "quota_exceeded", "{message}: {outcome:?}");
    }
}

/// The patterns above must not swallow request errors that mention a limit.
#[test]
fn context_and_login_errors_are_not_mistaken_for_quota() {
    for message in [
        "Not logged in · Please run /login",
        "Prompt is too long",
        "Input length exceeds the context limit",
        "Context limit reached",
    ] {
        let outcome = classify(&failure(Value::Null, message));
        assert_eq!(kind(&outcome), "other", "{message}: {outcome:?}");
    }
}

#[test]
fn server_side_failures_are_unreachable() {
    assert_eq!(kind(&classify(SYNTHETIC_OVERLOADED)), "unreachable");
    for status in [500, 502, 503, 504, 529] {
        let outcome = classify(&failure(json!(status), "API Error"));
        assert_eq!(kind(&outcome), "unreachable", "{status}: {outcome:?}");
    }
}

/// Hypothesis: network failures surface as text without a status.
#[test]
fn connection_errors_without_a_status_are_unreachable() {
    for message in [
        "API Error: Connection error.",
        "Unable to connect to API (ECONNREFUSED)",
        "Request timed out (ETIMEDOUT)",
    ] {
        let outcome = classify(&failure(Value::Null, message));
        assert_eq!(kind(&outcome), "unreachable", "{message}: {outcome:?}");
    }
}

/// Anything not recognised stops loudly rather than falling back quietly.
#[test]
fn unrecognised_errors_are_other() {
    for (status, message) in [
        (json!(400), "Invalid request"),
        (json!(401), "Failed to authenticate"),
        (Value::Null, "something new"),
    ] {
        let outcome = classify(&failure(status.clone(), message));
        assert_eq!(kind(&outcome), "other", "{status} {message}: {outcome:?}");
    }
}

#[test]
fn output_that_is_not_the_expected_json_is_other() {
    for output in [
        "",
        "not json",
        "{}",
        "[]",
        r#"[{"type":"system","subtype":"init","apiKeySource":"none","tools":[]}]"#,
    ] {
        let outcome = classify(output);
        assert_eq!(kind(&outcome), "other", "{output:?}: {outcome:?}");
    }
}

/// 8.24: with `--json-schema` (observed on 2.1.162) the answer is in
/// `structured_output`, `result` is empty, and init lists the one tool the
/// CLI answers through, `StructuredOutput`: it returns data and acts on
/// nothing, so it is allowed then, and only then, and alone.
#[test]
fn a_schema_answer_is_its_structured_output() {
    let answer = classify_for(SYNTHETIC_STRUCTURED, true).expect("a structured answer");
    let value: Value = serde_json::from_str(&answer.text).expect("the answer is JSON");
    assert_eq!(value["requirements"][1]["name"], "Kafka");
}

#[test]
fn the_structured_output_tool_without_a_schema_is_refused() {
    assert_eq!(kind(&classify(SYNTHETIC_STRUCTURED)), "other");
}

#[test]
fn another_tool_beside_structured_output_is_refused() {
    let with_bash = edited(SYNTHETIC_STRUCTURED, |init, _| {
        init["tools"] = json!(["StructuredOutput", "Bash"]);
    });
    assert_eq!(kind(&classify_for(&with_bash, true)), "other");
}

#[test]
fn a_schema_answer_without_structured_output_is_other() {
    let missing = edited(SYNTHETIC_STRUCTURED, |_, result| {
        result
            .as_object_mut()
            .expect("object")
            .remove("structured_output");
    });
    assert_eq!(kind(&classify_for(&missing, true)), "other");
}

/// 8.28: successes observed on 2.1.162 through the router's own flags
/// (2026-09-30, redacted), next to the synthetic ones built before any was.
#[test]
fn the_observed_success_is_an_answer() {
    assert_eq!(
        classify(OBSERVED_SUCCESS),
        Ok(Completion {
            text: "Hello".into()
        })
    );
}

#[test]
fn the_observed_structured_output_is_its_json() {
    let answer = classify_for(OBSERVED_STRUCTURED, true).expect("a structured answer");
    let value: Value = serde_json::from_str(&answer.text).expect("the answer is JSON");
    assert_eq!(value["requirements"][2]["name"], "Kafka");
    assert_eq!(kind(&classify(OBSERVED_STRUCTURED)), "other", "unasked, its tool trips the wire");
}

/// The observed success with its rate-limit event's `isUsingOverage` set.
fn with_overage(flag: Value) -> String {
    let mut messages: Vec<Value> = serde_json::from_str(OBSERVED_SUCCESS).expect("array");
    for message in &mut messages {
        if message["type"] == "rate_limit_event" {
            message["rate_limit_info"]["isUsingOverage"] = flag.clone();
        }
    }
    Value::Array(messages).to_string()
}

/// 8.29: extra usage is billed per token (decision 1). An answer the CLI
/// reports as overage is refused, and the message starts the billing
/// latch, so the next request does not spend more.
#[test]
fn an_answer_billed_as_overage_trips_the_billing_wire() {
    match classify(&with_overage(json!(true))) {
        Err(BackendError::Other(message)) => {
            assert!(message.starts_with("billing tripwire"), "{message}");
            assert!(message.contains("overage"), "{message}");
        }
        other => panic!("expected the billing tripwire, got {other:?}"),
    }
    assert_eq!(kind(&classify(&with_overage(json!(false)))), "success");
}
