//! `itsaresume`: the command line.

use itsaresume_router::config::Config;
use itsaresume_router::server::{DEFAULT_LISTEN, Server};
use itsaresume_router::{Request, RouteError};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "\
usage:
  itsaresume complete [--config FILE] [--system TEXT] [--backend NAME]
                      [--schema FILE]
      prompt on stdin, answer on stdout, the answering backend on stderr;
      --backend tries that configured backend alone (no fallback);
      --schema asks for an answer following that JSON Schema
  itsaresume stats [--config FILE] [--by-day]
      the journal summed up: per backend and outcome, fallbacks, structured;
      --by-day: per UTC day, who answered and when the plan ran out
  itsaresume serve [--config FILE] [--listen ADDRESS]
      HTTP endpoint (POST /v1/complete, GET /healthz), on 127.0.0.1:8787
      unless told otherwise: it has no authentication and spends the plan

The configuration is --config FILE, else $ITSARESUME_CONFIG, else
./config.local.toml (see config.example.toml).

Exit codes: 0 answered; 2 configuration or usage error; 3 stopped by an error
that must not fall back (see docs/ARCHITECTURE.md); 4 every backend failed
with a quota or an outage.";

const EXIT_USAGE: u8 = 2;
const EXIT_STOPPED: u8 = 3;
const EXIT_EXHAUSTED: u8 = 4;

#[derive(Default)]
struct Options {
    config: Option<PathBuf>,
    system: Option<String>,
    listen: Option<String>,
    backend: Option<String>,
    schema: Option<PathBuf>,
    by_day: bool,
}

fn parse(args: &[String]) -> Result<(String, Options), String> {
    let (command, rest) = args.split_first().ok_or("no command given")?;
    if command != "complete" && command != "serve" && command != "stats" {
        return Err(format!("unknown command {command:?}"));
    }
    let mut options = Options::default();
    let mut rest = rest.iter();
    while let Some(flag) = rest.next() {
        let mut value = || {
            rest.next()
                .cloned()
                .ok_or_else(|| format!("{flag} needs a value"))
        };
        match flag.as_str() {
            "--config" => options.config = Some(PathBuf::from(value()?)),
            "--system" if command == "complete" => options.system = Some(value()?),
            "--backend" if command == "complete" => options.backend = Some(value()?),
            "--by-day" if command == "stats" => {
                options.by_day = true;
                continue;
            }
            "--schema" if command == "complete" => options.schema = Some(PathBuf::from(value()?)),
            "--listen" if command == "serve" => options.listen = Some(value()?),
            other => return Err(format!("unknown option {other:?}")),
        }
    }
    Ok((command.clone(), options))
}

fn config_path(options: &Options) -> PathBuf {
    options
        .config
        .clone()
        .or_else(|| std::env::var_os("ITSARESUME_CONFIG").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("config.local.toml"))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (command, options) = match parse(&args) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("itsaresume: {message}\n\n{USAGE}");
            return ExitCode::from(EXIT_USAGE);
        }
    };
    let config = match Config::load(&config_path(&options)) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("itsaresume: {error}");
            return ExitCode::from(EXIT_USAGE);
        }
    };
    if command == "stats" {
        return stats(&config, options.by_day);
    }
    if command == "serve" {
        serve(&config, options.listen.as_deref().unwrap_or(DEFAULT_LISTEN))
    } else {
        complete(
            &config,
            options.system,
            options.backend.as_deref(),
            options.schema.as_deref(),
        )
    }
}

/// The journal summed up on stdout; a missing journal is an empty one.
fn stats(config: &Config, by_day: bool) -> ExitCode {
    let text = match std::fs::read_to_string(&config.journal) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            eprintln!(
                "itsaresume: cannot read the journal {}: {error}",
                config.journal.display()
            );
            return ExitCode::FAILURE;
        }
    };
    let summary = if by_day {
        itsaresume_router::stats::summarize_by_day(&text)
    } else {
        itsaresume_router::stats::summarize(&text)
    };
    let mut stdout = std::io::stdout().lock();
    if stdout
        .write_all(summary.as_bytes())
        .and_then(|()| stdout.flush())
        .is_err()
    {
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

fn serve(config: &Config, listen: &str) -> ExitCode {
    let router = match config.router() {
        Ok(router) => router,
        Err(error) => {
            eprintln!("itsaresume: {error}");
            return ExitCode::from(EXIT_USAGE);
        }
    };
    let server = match Server::bind(router, listen) {
        Ok(server) => server,
        Err(error) => {
            eprintln!("itsaresume: {error}");
            return ExitCode::from(EXIT_USAGE);
        }
    };
    eprintln!("itsaresume: listening on http://{}", server.local_addr());
    match server.run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("itsaresume: {error}");
            ExitCode::FAILURE
        }
    }
}

/// The JSON Schema object in `path`, or why it cannot be one.
fn read_schema(path: &std::path::Path) -> Result<serde_json::Value, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| format!("cannot read the schema {}: {error}", path.display()))?;
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(schema) if schema.is_object() => Ok(schema),
        Ok(_) => Err(format!(
            "the schema {} is not a JSON object",
            path.display()
        )),
        Err(error) => Err(format!(
            "the schema {} is not JSON: {error}",
            path.display()
        )),
    }
}

fn complete(
    config: &Config,
    system: Option<String>,
    only: Option<&str>,
    schema_file: Option<&std::path::Path>,
) -> ExitCode {
    // Before anything else: a bad schema file is a usage error, no backend
    // is called for it.
    let schema = match schema_file.map(read_schema).transpose() {
        Ok(schema) => schema,
        Err(problem) => {
            eprintln!("itsaresume: {problem}");
            return ExitCode::from(EXIT_USAGE);
        }
    };
    let router = match config.router() {
        Ok(router) => router,
        Err(error) => {
            eprintln!("itsaresume: {error}");
            return ExitCode::from(EXIT_USAGE);
        }
    };
    let mut prompt = String::new();
    if let Err(error) = std::io::stdin().read_to_string(&mut prompt) {
        eprintln!("itsaresume: cannot read the prompt on stdin: {error}");
        return ExitCode::from(EXIT_USAGE);
    }
    if prompt.trim().is_empty() {
        eprintln!("itsaresume: the prompt on stdin is empty");
        return ExitCode::from(EXIT_USAGE);
    }

    let outcome = match router.complete_on(
        &Request {
            prompt,
            system,
            schema,
        },
        only,
    ) {
        Ok(outcome) => outcome,
        Err(unknown) => {
            eprintln!("itsaresume: {unknown}");
            return ExitCode::from(EXIT_USAGE);
        }
    };
    for attempt in &outcome.attempts {
        eprintln!("itsaresume: {} failed: {}", attempt.backend, attempt.error);
    }
    if let Some(problem) = &outcome.journal_error {
        eprintln!("itsaresume: warning: {problem}");
    }
    match outcome.result {
        Ok(answer) => {
            eprintln!("itsaresume: answered by {}", answer.backend);
            let mut stdout = std::io::stdout().lock();
            if stdout
                .write_all(answer.text.as_bytes())
                .and_then(|()| stdout.flush())
                .is_err()
            {
                return ExitCode::FAILURE;
            }
            ExitCode::SUCCESS
        }
        Err(RouteError::Stopped { backend, error }) => {
            eprintln!("itsaresume: stopped by {backend}, not falling back: {error}");
            ExitCode::from(EXIT_STOPPED)
        }
        Err(RouteError::Exhausted) => {
            eprintln!("itsaresume: every backend failed with a quota or an outage");
            ExitCode::from(EXIT_EXHAUSTED)
        }
    }
}
