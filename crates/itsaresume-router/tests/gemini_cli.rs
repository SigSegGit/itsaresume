//! The `gemini` CLI backend: its output classified, its billing guards, and
//! the prompt that keeps its answers in the same shape as Claude's.
//! Output shapes are hypotheses on Gemini CLI 0.11 (`--output-format json`)
//! until a logged-in capture replaces them.

use itsaresume_router::gemini_cli::{
    GeminiCliBackend, auth_guard, classify, extract_json, is_metered, prompt_for,
};
use itsaresume_router::{BackendError, Request, Usage};
use serde_json::json;

const SUCCESS: &str = r#"{"response":"Bonjour.","stats":{"models":{"gemini-2.5-pro":{"tokens":{"prompt":120,"candidates":7,"cached":30}}}}}"#;

#[test]
fn a_response_is_the_answer_with_its_tokens() {
    let completion = classify(SUCCESS, "", false).expect("success");
    assert_eq!(completion.text, "Bonjour.");
    assert_eq!(
        completion.usage,
        Some(Usage {
            input: 90,
            output: 7,
            cache_read: 30,
            cache_creation: 0
        })
    );
}

#[test]
fn a_quota_error_falls_back() {
    for stderr in [
        "Error: 429 RESOURCE_EXHAUSTED",
        "Quota exceeded for quota metric 'Gemini 2.5 Pro Requests'",
        r#"{"error":{"type":"Error","message":"You have exhausted your daily quota on this model.","code":429}}"#,
    ] {
        assert!(
            matches!(
                classify("", stderr, false),
                Err(BackendError::QuotaExceeded(_))
            ),
            "{stderr}"
        );
    }
}

#[test]
fn a_network_failure_falls_back_and_anything_else_stops() {
    assert!(matches!(
        classify("", "fetch failed: ECONNREFUSED", false),
        Err(BackendError::Unreachable(_))
    ));
    assert!(matches!(
        classify("", "Please set an Auth method", false),
        Err(BackendError::Other(_))
    ));
    assert!(matches!(
        classify("not json", "", false),
        Err(BackendError::Other(_))
    ));
}

#[test]
fn a_schema_answer_must_be_json_even_inside_a_fence() {
    let fenced = json!({"response": "Voici :\n```json\n{\"a\": 1}\n```"}).to_string();
    let completion = classify(&fenced, "", true).expect("json in a fence");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&completion.text).expect("json"),
        json!({"a": 1})
    );
    let prose = json!({"response": "Je ne sais pas."}).to_string();
    assert!(matches!(
        classify(&prose, "", true),
        Err(BackendError::Other(_))
    ));
}

#[test]
fn extract_json_takes_the_outermost_object() {
    assert_eq!(
        extract_json("x {\"a\": {\"b\": [1]}} y"),
        Some(json!({"a": {"b": [1]}}))
    );
    assert_eq!(extract_json("[1, 2]"), Some(json!([1, 2])));
    assert_eq!(extract_json("rien"), None);
}

#[test]
fn only_a_google_account_login_is_accepted() {
    let oauth = r#"{"security":{"auth":{"selectedType":"oauth-personal"}}}"#;
    assert!(auth_guard(Some(oauth)).is_ok());
    for refused in [
        r#"{"security":{"auth":{"selectedType":"gemini-api-key"}}}"#,
        r#"{"security":{"auth":{"selectedType":"vertex-ai"}}}"#,
        "{}",
        "not json",
    ] {
        assert!(
            matches!(auth_guard(Some(refused)), Err(BackendError::Other(_))),
            "{refused}"
        );
    }
    assert!(matches!(auth_guard(None), Err(BackendError::Other(_))));
}

#[test]
fn api_keys_and_vertex_switches_are_scrubbed() {
    for name in [
        "GEMINI_API_KEY",
        "google_api_key",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_GEMINI_BASE_URL",
        "OPENAI_API_KEY",
    ] {
        assert!(is_metered(name), "{name}");
    }
    assert!(!is_metered("PATH"));
}

#[test]
fn a_schema_request_carries_the_schema_and_the_json_only_rule() {
    let schema = json!({"type": "object", "required": ["score"]});
    let prompt = prompt_for(&Request::new("Note cette offre.").with_schema(schema.clone()));
    assert!(prompt.starts_with("Note cette offre."));
    assert!(prompt.contains(&schema.to_string()));
    assert!(prompt.contains("only"));
    assert_eq!(prompt_for(&Request::new("Bonjour")), "Bonjour");
}

#[test]
fn a_missing_program_is_unreachable() {
    let settings =
        std::env::temp_dir().join(format!("gemini-settings-{}.json", std::process::id()));
    std::fs::write(
        &settings,
        r#"{"security":{"auth":{"selectedType":"oauth-personal"}}}"#,
    )
    .expect("temp settings");
    let backend = GeminiCliBackend::new("definitely-not-gemini-xyz").with_settings_file(&settings);
    let outcome = backend.complete_with_env(&Request::new("x"), Vec::new());
    let _ = std::fs::remove_file(&settings);
    assert!(
        matches!(outcome, Err(BackendError::Unreachable(_))),
        "{outcome:?}"
    );
}

#[test]
fn an_api_key_login_never_starts_the_cli() {
    let settings = std::env::temp_dir().join(format!("gemini-key-{}.json", std::process::id()));
    std::fs::write(
        &settings,
        r#"{"security":{"auth":{"selectedType":"gemini-api-key"}}}"#,
    )
    .expect("temp settings");
    // A program that does not exist: Unreachable would prove it was started.
    let backend = GeminiCliBackend::new("definitely-not-gemini-xyz").with_settings_file(&settings);
    let outcome = backend.complete_with_env(&Request::new("x"), Vec::new());
    let _ = std::fs::remove_file(&settings);
    assert!(
        matches!(outcome, Err(BackendError::Other(_))),
        "{outcome:?}"
    );
}

/// The owner's free-tier key (no billing on its project, 2026-10-14): the
/// key is passed through, every other switch is still scrubbed.
#[test]
fn a_free_tier_key_passes_only_the_key() {
    use itsaresume_router::gemini_cli::{Login, scrubbed};
    assert!(!scrubbed(Login::FreeTierKey, "GEMINI_API_KEY"));
    assert!(scrubbed(Login::Account, "GEMINI_API_KEY"));
    for name in [
        "GOOGLE_API_KEY",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_GEMINI_BASE_URL",
    ] {
        assert!(scrubbed(Login::FreeTierKey, name), "{name}");
    }
}

#[test]
fn a_free_tier_login_without_a_key_never_starts_the_cli() {
    use itsaresume_router::gemini_cli::Login;
    let backend = GeminiCliBackend::new("definitely-not-gemini-xyz").with_login(Login::FreeTierKey);
    let outcome = backend.complete_with_env(&Request::new("x"), Vec::new());
    assert!(
        matches!(outcome, Err(BackendError::Other(_))),
        "{outcome:?}"
    );
    let keyed = vec![("GEMINI_API_KEY".into(), "k".into())];
    let outcome = backend.complete_with_env(&Request::new("x"), keyed);
    assert!(
        matches!(outcome, Err(BackendError::Unreachable(_))),
        "{outcome:?}"
    );
}

/// Observed on CLI 0.11 (2026-10-14, a retired model): an API error is an
/// empty `response`, `totalErrors` in the stats, and the cause only in the
/// report file that stderr names.
const OBSERVED_EMPTY: &str = r#"{"response":"","stats":{"models":{"gemini-2.5-flash":{"api":{"totalRequests":1,"totalErrors":1},"tokens":{"prompt":0,"candidates":0,"cached":0}}}}}"#;

#[test]
fn an_empty_response_is_an_error_read_from_the_report() {
    let report = std::env::temp_dir().join(format!("gemini-client-error-t{}.json", std::process::id()));
    let stderr = format!("Error when talking to Gemini API Full report available at: {}", report.display());
    std::fs::write(&report, r#"{"error":{"message":"{\"error\":{\"code\":429,\"status\":\"RESOURCE_EXHAUSTED\"}}"}}"#)
        .expect("report");
    let quota = classify(OBSERVED_EMPTY, &stderr, false);
    std::fs::write(&report, r#"{"error":{"message":"{\"error\":{\"code\":404,\"message\":\"no longer available\"}}"}}"#)
        .expect("report");
    let retired = classify(OBSERVED_EMPTY, &stderr, false);
    let _ = std::fs::remove_file(&report);
    assert!(matches!(quota, Err(BackendError::QuotaExceeded(_))), "{quota:?}");
    match retired {
        Err(BackendError::Other(m)) => assert!(m.contains("no longer available"), "{m}"),
        other => panic!("{other:?}"),
    }
    assert!(matches!(classify(OBSERVED_EMPTY, "", false), Err(BackendError::Other(_))));
}
