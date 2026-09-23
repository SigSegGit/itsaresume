# Handover

<!-- ITSARESUME-STATE
NEXT: 8.5
TITLE: Claude Code backend, part 1 - classify the CLI output
WRITTEN-AT: 2026-09-23
BASE: 5a852f6
-->

Where to resume itsaresume without asking Nicolas anything. Read §0, then §8.
The block above names the next step and `scripts/check-handover.py` keeps it
honest. Whether CI is green or a PR is open are facts for `git` and `gh`,
never for this file: re-derive them.

## 0. Real state

**2026-09-23.** Local repository `D:\GitHub\itsaresume`, not yet on GitHub
(created at 8.11, once M1 builds and passes locally — Nicolas's instruction).
Branches, stacked in this order, each ending with this pointer rewritten:

- `main`: root commit only (licence, README, ignore rules).
- `m0-scaffold`: workspace, docs, CI, guard scripts, observed CLI fixtures.
- `m1-router`: 8.2–8.4 — `Backend`/`BackendError`, `Router`, JSONL journal.
  13 tests, 7 sabotage defences, all verified locally.

Nicolas then asked (same day) for autonomy to an MVP as fast as possible,
ideally in Docker, with no decision handed back to him: M1 also covers an
HTTP endpoint and a Docker image (§8, 8.9–8.10).

The `claude` CLI was observed before any parser (§4): not logged in on this
laptop; its first JSON message reports the billing source (`apiKeySource`),
which the backend will check. CI is written but has never run (no remote).

Traps met, one line each:
- `cargo test` stops at the first red test binary: sabotage plans must use
  `--no-fail-fast` (now enforced by `sabotage.py`).
- A sabotage that leaves a function unused does not build under
  `-D warnings`: sabotage *inside* the function instead.
- Git Bash heredocs eat backslash escapes in Python edit scripts: use the
  Edit tool for lines holding backslashes.

Truth order when documents disagree: code and tests, then `docs/TESTING.md`,
then this file.

## 1. Decisions never to reverse silently

Changing any of these is a closed question to Nicolas — two options and their
consequences — before any code. Never a quiet decision.

1. **Zero pay-per-use.** No backend is billed per token, now or as a future
   fallback: no Anthropic or OpenAI API key, no paid OpenAI-compatible
   provider, no credential field in any backend. If the idea comes up, ask.
2. **Backends and their order**: Claude Code on Nicolas's Pro/Max plan →
   LM Studio on the XPS 15 (RTX 4070) over Tailscale → a micro-model on the
   Pi 4B or the Freebox VM (`itsworkstation`). The micro-model does light
   sorting/classification only, **never long text generation**.
3. **`Other` never triggers a fallback.** Only `QuotaExceeded` and
   `Unreachable` hand over to the next backend (ARCHITECTURE explains why).
4. **Rust** for all orchestration and routing logic.
5. **Strict TDD**: a red test committed before the code that turns it green;
   every fallback/error test sabotage-verified, in CI.
6. **Public repository** `SigSegGit/itsaresume`, **AGPL-3.0-or-later**.
7. **No secret, machine name or Tailscale address committed**: real values
   live in `config.local.toml` (ignored); `config.example.toml` has
   placeholders only.
8. **itsaresume only provides inference.** The CV (docx) generator is a
   separate Node.js project; no document generation here, ever.
9. **The journal never contains prompt or answer text**, only lengths. Prompts
   will carry personal CV data.

## 2. Where things are

- Working tree: `D:\GitHub\itsaresume`. Remote (from 8.11):
  `https://github.com/SigSegGit/itsaresume`, default branch `main`.
- `gh` is logged in as `SigSegGit` (scopes include `repo`, `workflow`).
- `claude` CLI: `C:\Users\SigSeg\.local\bin\claude.exe` — on PowerShell's PATH,
  **not** on Git Bash's. Version 2.1.162 when observed.
- LM Studio is installed on this laptop (`~/.lmstudio/bin` on PATH).
- Skill to resume: `~/.claude/skills/itsaresume/SKILL.md`.

## 3. Verify a clean tree

```
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets
RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps --all-features
python scripts/sabotage.py
python scripts/check-handover.py
```

## 4. What the `claude` CLI actually prints (observed 2026-09-23)

Captured with Claude Code 2.1.162 on this laptop; redacted copies are the test
fixtures in `crates/itsaresume-router/tests/fixtures/claude/` (its README says
what was redacted). Findings, each one a trap for a naive parser:

- **Not logged in**: exit code **1**, JSON still on stdout, `"subtype":
  "success"` **and** `"is_error": true`, `api_error_status: null`, `result:
  "Not logged in · Please run /login"`. So `is_error` decides; `subtype` lies.
- `--verbose` turns the output into an **array**: `system/init`, then
  messages, then `result`. `system/init` carries **`apiKeySource`** (`"none"`
  on the subscription path, `"ANTHROPIC_API_KEY"` when that variable is set),
  `tools`, `mcp_servers`, `model`.
- With a bogus `ANTHROPIC_API_KEY`: ten `system/api_retry` messages
  (`error_status: 401`) over **183 s**, then `api_error_status: 401`. A hung
  or retrying CLI is real; the backend needs a timeout.
- `--tools ""` → `tools: []`; `--strict-mcp-config` → `mcp_servers: []`. The
  prompt is accepted on **stdin**.
- `--help`: `--bare` makes auth "strictly ANTHROPIC_API_KEY or apiKeyHelper"
  — i.e. metered. Never use it.
- **Not observed**: a successful answer (not logged in) and a **usage-limit**
  error (would require exhausting Nicolas's plan). The synthetic fixtures
  stand in for both and are hypotheses (§9).

## 5. Working rules

- One branch per step or group of steps; never commit on `main`.
- Each feature: `red:` commit (failing test) then `green:` commit.
- PRs merged with **merge commits** (`scripts/merge-when-green.sh`), so the
  red→green order survives in `main`'s history.
- Each fallback/error test gets a defence in `scripts/sabotage/*.json` naming
  the tests that must go red; CI runs them all.
- Before freezing a step: audit with the `rodin` skill if available.
- Docs change in the same commit as the code they describe.

## 8. Ordered steps to the MVP

Tick a step only when it is merged on `main` or, before 8.11, committed on its
branch with the local gates of §3 green.

- [x] **8.0** Scaffold (M0): workspace, crate, docs, CI, guard scripts.
- [x] **8.1** Observe the `claude` CLI output before writing a parser (§4).
- [x] **8.2** `src/backend.rs`: `Request { prompt, system: Option }`,
  `Completion { text }`, `trait Backend { name(); complete(&Request) }`,
  `BackendError::{QuotaExceeded, Unreachable, Other}(String)` with
  `allows_fallback()` (true only for the first two) and `kind()`
  (`quota_exceeded` / `unreachable` / `other`). Test: the truth table of
  `allows_fallback`. Sabotage: make `Other` allow fallback.
- [x] **8.3** `src/router.rs`: `Router::new(backends)` refuses an empty list;
  `complete` tries backends in order, falls back only when
  `allows_fallback()`, returns the answer with the answering backend's name
  and the failed attempts; `Other` stops (the next backend is **never
  called** — assert on a call counter); all failing → `Exhausted` with
  attempts in order. Test doubles: scripted fake backends counting calls.
- [x] **8.4** `src/journal.rs` + wire into `Router::new(backends, journal)`:
  one JSONL line per request (`ts`, `outcome`, `backend`, `attempts`,
  `duration_ms`, `prompt_chars`, `answer_chars`); prompt text never written
  (test with a sentinel prompt); messages truncated to 200 chars; a journal
  that cannot be written does not lose the answer.
- [ ] **8.5** `src/claude_code.rs`: pure `classify(stdout) -> Result<Completion,
  BackendError>` per the ARCHITECTURE table, tested on every fixture; unknown
  shapes → `Other`; tripwires `apiKeySource != "none"` and non-empty `tools`.
- [ ] **8.6** `ClaudeCodeBackend`: spawn with the flag set of ARCHITECTURE,
  prompt on stdin, dedicated empty working directory, timeout → kill →
  `Unreachable`, missing binary → `Unreachable`, metered env variables removed
  from the child. Tested against a fake `claude` binary built from this crate
  that records its argv, stdin and environment variable names.
- [ ] **8.7** `src/lm_studio.rs`: `LmStudioBackend` over HTTP (`ureq`), tested
  against a fake server on `127.0.0.1` that records the request: no
  `Authorization` header, body shape, and the ARCHITECTURE status table. If
  LM Studio's server runs on this laptop, observe its real error for "no
  model loaded" first.
- [ ] **8.8** `src/config.rs` + `src/main.rs`: TOML config (closed list of
  kinds: `claude-code`, `lm-studio`; unknown kind rejected), CLI reading stdin,
  exit codes 0/2/3/4.
- [ ] **8.9** `itsaresume serve` (`tiny_http`): `POST /v1/complete`
  `{prompt, system?}` → 200 `{backend, text, attempts}`, 502 stopped, 503
  exhausted, 400 bad body; `GET /healthz`. Default bind `127.0.0.1` — the
  endpoint has no authentication and spends Nicolas's plan.
- [ ] **8.10** Docker: multi-stage `Dockerfile` (Rust build → Node runtime with
  the `claude` CLI pinned), `compose.yaml` publishing on `127.0.0.1` only,
  `.env.example` with `CLAUDE_CODE_OAUTH_TOKEN` (subscription token from
  `claude setup-token`), `docker/config.example.toml` pointing LM Studio at
  `host.docker.internal:1234`. CI job builds the image.
- [ ] **8.11** Publish: `gh repo create SigSegGit/itsaresume --public
  --source=. --remote=origin`, push `main`, then one PR per branch in order,
  each merged by `scripts/merge-when-green.sh` once every check is green.
  Set `merge-when-green.sh` MINIMUM to the real job count if it differs.
- [ ] **8.12** Real run in Docker on this laptop: LM Studio answering through
  the container (no human needed); Claude once Nicolas has put his token in
  `.env` (⏸ §10). Capture a real success and, when it happens, a real
  usage-limit output; replace the synthetic fixtures.

## 9. Deliberately open

- **Usage-limit output format unknown.** Classified by `api_error_status`
  429 or a message pattern; an unrecognised limit message is `Other` and stops
  loudly, with the raw message in the error and the journal. Add its fixture
  when seen.
- **Successful CLI output never observed** here; `synthetic-success` is
  built from the observed error shape.
- **Tripwires fire after the call.** A metered call can happen once before
  `apiKeySource` is read. Removing the variables before the spawn is the
  prevention; the tripwire only stops it from repeating.
- **`CLAUDE.md` in parent directories** of the Claude working directory would
  be loaded; none exist today (`C:\Users\SigSeg`, `C:\Users` checked).
- **Micro-model runtime** (llama.cpp or Ollama, which model) — M2.
- **Contract with the Node.js generator** — M3.

## 10. Waiting on Nicolas

Nothing blocks M1 code, and LM Studio runs on this laptop (the XPS), so the
LM Studio half of 8.12 needs nobody. One action only Nicolas can do, because
it is an interactive login to his account:

- `claude setup-token` in a terminal, then put the printed token in `.env` as
  `CLAUDE_CODE_OAUTH_TOKEN=…` (git-ignored). That is the subscription path;
  it is not an API key and is not billed per token.
- When the router runs on another machine than the XPS: the XPS's Tailscale
  name in that machine's `config.local.toml` (never committed).
