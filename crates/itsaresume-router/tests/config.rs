//! The configuration file: what it accepts, and what it refuses on purpose.

use itsaresume_router::config::{BackendConfig, Config};
use std::path::PathBuf;
use std::time::Duration;

const EXAMPLE: &str = include_str!("../../../config.example.toml");
const DOCKER_EXAMPLE: &str = include_str!("../../../docker/config.example.toml");

/// The committed example must stay a valid configuration.
#[test]
fn the_committed_example_parses() {
    let config = Config::parse(EXAMPLE).expect("config.example.toml is valid");
    assert_eq!(config.journal, PathBuf::from("itsaresume-journal.jsonl"));
    assert!(matches!(
        config.backends.as_slice(),
        [
            BackendConfig::ClaudeCode { .. },
            BackendConfig::LmStudio { .. }
        ]
    ));
}

/// The configuration the container starts from must stay valid too.
#[test]
fn the_committed_docker_example_parses() {
    let config = Config::parse(DOCKER_EXAMPLE).expect("docker/config.example.toml is valid");
    assert!(config.journal.starts_with("/home/node/journal"));
    assert!(config.router().is_ok());
}

#[test]
fn backends_keep_their_order_and_settings() {
    let config = Config::parse(
        r#"
        journal = "j.jsonl"
        [[backend]]
        kind = "lm-studio"
        base_url = "http://127.0.0.1:1/v1"
        model = "m"
        [[backend]]
        kind = "claude-code"
        program = "claude"
        model = "sonnet"
        timeout_secs = 42
        "#,
    )
    .expect("valid");

    match &config.backends[..] {
        [
            BackendConfig::LmStudio {
                base_url,
                model,
                timeout_secs,
            },
            BackendConfig::ClaudeCode {
                program,
                model: claude_model,
                timeout_secs: claude_timeout,
                ..
            },
        ] => {
            assert_eq!(base_url, "http://127.0.0.1:1/v1");
            assert_eq!(model, "m");
            assert_eq!(*timeout_secs, None);
            assert_eq!(program, &PathBuf::from("claude"));
            assert_eq!(claude_model.as_deref(), Some("sonnet"));
            assert_eq!(*claude_timeout, Some(42));
        }
        other => panic!("unexpected backends: {other:?}"),
    }
    assert_eq!(config.backends[0].timeout(), Duration::from_secs(300));
    assert_eq!(config.backends[1].timeout(), Duration::from_secs(42));
}

/// The set of backends is closed: no configuration can add a metered one.
#[test]
fn an_unknown_backend_kind_is_refused() {
    let error = Config::parse(
        r#"
        journal = "j.jsonl"
        [[backend]]
        kind = "anthropic-api"
        "#,
    )
    .expect_err("an unknown kind must not parse");
    assert!(error.to_string().contains("anthropic-api"), "{error}");
}

/// No backend has a credential field, and none can be smuggled in.
#[test]
fn a_credential_field_is_refused() {
    for field in ["api_key = \"sk-x\"", "authorization = \"Bearer x\""] {
        let text = format!(
            "journal = \"j.jsonl\"\n[[backend]]\nkind = \"lm-studio\"\nbase_url = \"http://h/v1\"\nmodel = \"m\"\n{field}\n"
        );
        let error = Config::parse(&text).expect_err("a credential field must not parse");
        assert!(
            error.to_string().contains("unknown field"),
            "{field}: {error}"
        );
    }
    let claude = "journal = \"j.jsonl\"\n[[backend]]\nkind = \"claude-code\"\nprogram = \"claude\"\napi_key = \"sk-x\"\n";
    assert!(Config::parse(claude).is_err());
}

#[test]
fn a_configuration_without_backends_cannot_build_a_router() {
    let config = Config::parse("journal = \"j.jsonl\"\nbackend = []\n").expect("parses");
    assert!(config.router().is_err());
}

#[test]
fn a_valid_configuration_builds_a_router() {
    let config = Config::parse(EXAMPLE).expect("valid");
    assert!(config.router().is_ok());
}
