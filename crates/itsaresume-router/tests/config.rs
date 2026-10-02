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
                ..
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

/// Bionic serves one request at a time: an `lm-studio` backend takes one
/// completion at a time unless `max_concurrent` says otherwise; `claude-code`
/// has no such limit (each request is its own process).
#[test]
fn lm_studio_takes_one_completion_at_a_time_by_default() {
    let config = Config::parse(
        "journal = \"j.jsonl\"
[[backend]]
kind = \"lm-studio\"
base_url = \"http://h/v1\"
model = \"m\"
[[backend]]
kind = \"lm-studio\"
base_url = \"http://h/v1\"
model = \"m\"
max_concurrent = 3
[[backend]]
kind = \"claude-code\"
program = \"claude\"
",
    )
    .expect("valid");
    assert_eq!(config.backends[0].max_concurrent(), Some(1));
    assert_eq!(config.backends[1].max_concurrent(), Some(3));
    assert_eq!(config.backends[2].max_concurrent(), None);
}

#[test]
fn max_concurrent_zero_or_on_claude_code_is_refused() {
    let zero = Config::parse(
        "journal = \"j.jsonl\"
[[backend]]
kind = \"lm-studio\"
base_url = \"http://h/v1\"
model = \"m\"
max_concurrent = 0
",
    )
    .expect("parses");
    let Err(error) = zero.router() else {
        panic!("zero slots would never answer")
    };
    assert!(error.to_string().contains("max_concurrent"), "{error}");

    let claude = "journal = \"j.jsonl\"
[[backend]]
kind = \"claude-code\"
program = \"claude\"
max_concurrent = 1
";
    assert!(Config::parse(claude).is_err());
}

/// A `base_url` with userinfo would be sent as Basic auth (a credential) and
/// echoed in every error and journal line: refused, without echoing it.
#[test]
fn userinfo_in_a_base_url_is_refused_without_echoing_it() {
    for url in ["http://alice:s3cret@h:1234/v1", "http://alice@h:1234/v1"] {
        let text = format!(
            "journal = \"j.jsonl\"\n[[backend]]\nkind = \"lm-studio\"\nbase_url = \"{url}\"\nmodel = \"m\"\n"
        );
        let config = Config::parse(&text).expect("parses");
        let Err(error) = config.router() else {
            panic!("{url}: userinfo must not build a router")
        };
        let message = error.to_string();
        assert!(message.contains("base_url"), "{message}");
        assert!(
            !message.contains("alice") && !message.contains("s3cret"),
            "{message}"
        );
    }
    for url in ["http://h:1234/v1", "http://h:1234/v1/@x"] {
        let text = format!(
            "journal = \"j.jsonl\"\n[[backend]]\nkind = \"lm-studio\"\nbase_url = \"{url}\"\nmodel = \"m\"\n"
        );
        assert!(
            Config::parse(&text).expect("parses").router().is_ok(),
            "{url}"
        );
    }
}

/// 8.22: a backend may carry a `name` (two local models side by side); the
/// journal and the answers use it, and names are unique.
#[test]
fn a_backend_may_be_named_and_names_are_unique() {
    let dir = tempfile::tempdir().expect("temp dir");
    let journal = dir.path().join("j.jsonl");
    let two = |second: &str| {
        format!(
            "journal = {journal:?}\n[[backend]]\nkind = \"lm-studio\"\nname = \"qwen\"\nbase_url = \"http://127.0.0.1:1/v1\"\nmodel = \"m\"\ntimeout_secs = 2\n[[backend]]\nkind = \"lm-studio\"\nname = \"{second}\"\nbase_url = \"http://127.0.0.1:1/v1\"\nmodel = \"m\"\ntimeout_secs = 2\n"
        )
    };
    let router = Config::parse(&two("gemma"))
        .expect("valid")
        .router()
        .expect("builds");
    let outcome = router
        .complete_on(&itsaresume_router::Request::new("p"), Some("gemma"))
        .expect("gemma is configured");
    assert_eq!(outcome.attempts.len(), 1);
    assert_eq!(outcome.attempts[0].backend, "gemma");

    let Err(error) = Config::parse(&two("qwen")).expect("parses").router() else {
        panic!("two backends named qwen")
    };
    assert!(error.to_string().contains("qwen"), "{error}");
}

/// 8.34: `serves` declares the kinds a backend takes; none is refused.
#[test]
fn serves_declares_the_kinds_and_none_is_refused() {
    let dir = tempfile::tempdir().expect("temp dir");
    let text = |serves: &str| {
        format!(
            "journal = {:?}\n[[backend]]\nkind = \"lm-studio\"\nname = \"small\"\nbase_url = \"http://127.0.0.1:1/v1\"\nmodel = \"m\"\ntimeout_secs = 1\n{serves}\n",
            dir.path().join("j.jsonl")
        )
    };
    let router = Config::parse(&text("serves = [\"classify\"]"))
        .expect("valid")
        .router()
        .expect("builds");
    let outcome = router.complete(&itsaresume_router::Request::new("p"));
    assert!(
        outcome.attempts.is_empty(),
        "a generation was sent to a classify-only backend"
    );
    let Err(error) = Config::parse(&text("serves = []"))
        .expect("parses")
        .router()
    else {
        panic!("a backend serving nothing")
    };
    assert!(error.to_string().contains("serves"), "{error}");
}

/// `Instant::now() + Duration::from_secs(u64::MAX)` panics: a timeout that
/// large is a configuration error naming `timeout_secs`, for either kind.
#[test]
fn a_timeout_too_large_for_a_deadline_is_refused() {
    let text = |kind_lines: &str, secs: &str| {
        format!("journal = \"j.jsonl\"\n[[backend]]\n{kind_lines}\ntimeout_secs = {secs}\n")
    };
    let lm = "kind = \"lm-studio\"\nbase_url = \"http://h/v1\"\nmodel = \"m\"";
    let claude = "kind = \"claude-code\"\nprogram = \"claude\"";
    for kind_lines in [lm, claude] {
        let config = Config::parse(&text(kind_lines, "18446744073709551615")).expect("parses");
        let Err(error) = config.router() else {
            panic!("u64::MAX seconds cannot be a deadline")
        };
        assert!(error.to_string().contains("timeout_secs"), "{error}");
        let config = Config::parse(&text(kind_lines, "86400")).expect("parses");
        assert!(config.router().is_ok());
    }
}

/// A request may name a backend by its kind as well as by its configured
/// name: the generator asks for `lm-studio` whether the owner called it
/// `bionic` (the VM) or left the default (the laptop).
#[test]
fn a_named_backend_is_found_by_its_kind_too() {
    let dir = tempfile::tempdir().expect("temp dir");
    let journal = dir.path().join("journal.jsonl");
    let config = Config::parse(&format!(
        r#"journal = {journal:?}

[[backend]]
kind = "lm-studio"
name = "bionic"
base_url = "http://127.0.0.1:9/v1"
model = "m"
timeout_secs = 2
"#
    ))
    .expect("valid");
    let router = config.router().expect("router");
    let request = itsaresume_router::Request::new("p");
    assert!(router.complete_on(&request, Some("bionic")).is_ok());
    assert!(
        router.complete_on(&request, Some("lm-studio")).is_ok(),
        "found by kind"
    );
    assert!(router.complete_on(&request, Some("claude-code")).is_err());
}
