//! `itsaresume`: the command line.

use itsaresume_router::config::Config;
use itsaresume_router::server::{DEFAULT_LISTEN, Server};
use itsaresume_router::{Request, RouteError};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "\
usage:
  itsaresume complete [--config FILE] [--system TEXT]
      prompt on stdin, answer on stdout, the answering backend on stderr
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
}

fn parse(args: &[String]) -> Result<(String, Options), String> {
    let (command, rest) = args.split_first().ok_or("no command given")?;
    if command != "complete" && command != "serve" {
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
    if command == "serve" {
        serve(&config, options.listen.as_deref().unwrap_or(DEFAULT_LISTEN))
    } else {
        complete(&config, options.system)
    }
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
    server.run();
    ExitCode::SUCCESS
}

fn complete(config: &Config, system: Option<String>) -> ExitCode {
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

    let outcome = router.complete(&Request { prompt, system });
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
