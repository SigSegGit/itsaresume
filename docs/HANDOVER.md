# Handover

<!-- ITSARESUME-STATE
NEXT: 8.11
TITLE: Get CI running on the new repository, then merge the stacked PRs in order
WRITTEN-AT: 2026-09-23
BASE: 5a852f6
-->

Where to resume itsaresume without asking Nicolas anything. Read §0, then §8.
The block above names the next step and `scripts/check-handover.py` keeps it
honest. Whether CI is green or a PR is open are facts for `git` and `gh`,
never for this file: re-derive them.

## 0. Real state

**2026-09-23, end of the first session.** All of M1 is built and verified
**locally**; nothing is merged, because **GitHub Actions never started on the
new repository** — the one blocker, and the first job of the next session.

Published at `github.com/SigSegGit/itsaresume` (public). Branches, stacked in
this order and pushed: `m0-scaffold` (PR #1, open) → `m1-router` →
`m1-claude` → `m1-lmstudio` → `m1-cli` → `m1-docker`. `main` holds the root
commit only. Merge them in that order, one PR each, base `main`, with
`scripts/merge-when-green.sh` (merge commits: no rebase needed).

**The CI blocker, as far as it was taken.** `ci.yml` is valid YAML and present
on every branch, Actions is enabled (`actions/permissions`: enabled, all),
GitHub status was green, `SigSegGit/itsanas` ran PR checks two days ago — yet
this repository has **0 registered workflows and 0 runs**. Tried, without
effect: closing/reopening PR #1; an empty commit on `m0-scaffold` (twice);
making `m0-scaffold` the default branch during a push (restored to `main`).
Not tried: waiting longer; a workflow file added through the GitHub web UI;
the repository's Actions settings page as Nicolas sees it. **Never merge
without CI.**

**Verified locally** (Windows, 2026-09-23): 71 tests, 42 sabotage defences
(`RUSTFLAGS="-D warnings" python scripts/sabotage.py`), fmt, clippy and doc
under `-D warnings`, `check-handover.py`. `bash scripts/docker-smoke.sh`
green: the image holds `claude` 2.1.162 and not the test double; a real
request through the real CLI with a bogus `ANTHROPIC_API_KEY` on the container
returns 502 "Not logged in". **Real runs**: the real `claude` stops (not
logged in, exit 3, LM Studio untouched); the real LM Studio
(`qwen2.5-7b-instruct-1m`) answers in 5.3 s through the CLI and in **2.0 s
through the container** (`host.docker.internal:54321` reaches LM Studio bound
to `127.0.0.1`).

**A read-only adversarial review** (3 lenses + 1 refuting verifier) found 14
confirmed defects, none triggered today; the serious ones — settings files
able to re-route Claude to a paid gateway, a tripwire that does not latch, an
endpoint any web page can drive — are steps 8.13–8.16, in that order after
8.11. Two Docker ones are already fixed on `m1-docker` (config mode in the
smoke test, `init: true`).

Traps met, one line each:
- `cargo test` stops at the first red test binary: sabotage plans use
  `--no-fail-fast` (enforced by `sabotage.py`).
- A sabotage that leaves something unused does not build under `-D warnings`:
  sabotage *inside* the expression.
- Git Bash heredocs eat backslashes in Python edit scripts; Git Bash `curl -d`
  sends non-ASCII as cp1252 (use `--data-binary @file.json`); `docker exec`
  paths need `MSYS_NO_PATHCONV=1`.
- Docker Desktop would not start (unreadable AF_UNIX sockets): §2 and §9.
- `itsworkstation` is in early commits' history; it is already public in
  `SigSegGit/itsanas`, so history was not rewritten. Current files are clean.

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
   Pi 4B or the Freebox Delta VM. The micro-model does light
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
- Docker Desktop 4.63 (engine 29.2.1). It crashed at start on unreadable
  AF_UNIX sockets (`%LOCALAPPDATA%\Docker\run\dockerInference`,
  `%LOCALAPPDATA%\docker-secrets-engine\engine.sock`). Reversible fix used:
  quit it, rename both directories to `*.stale-2026-09-23[b]`, recreate them
  empty, restart. Nothing was deleted.
- LM Studio is on this laptop (the XPS): `~/.lmstudio/bin/lms`, server on
  **`127.0.0.1:54321`** (not 1234). `lms server start`, `lms load
  qwen2.5-7b-instruct-1m -y` (4.7 GB, fits the 8 GB RTX 4070) were used for
  the observations; other models are listed by `lms ls`.
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
  when logged out — the logged-in subscription value is **not yet observed**;
  `"ANTHROPIC_API_KEY"` when that variable is set),
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
- [x] **8.5** `src/claude_code.rs`: pure `classify(stdout) -> Result<Completion,
  BackendError>` per the ARCHITECTURE table, tested on every fixture; unknown
  shapes → `Other`; tripwires `apiKeySource != "none"` and non-empty `tools`.
- [x] **8.6** `ClaudeCodeBackend`: spawn with the flag set of ARCHITECTURE,
  prompt on stdin, dedicated empty working directory, timeout → kill →
  `Unreachable`, missing binary → `Unreachable`, metered env variables removed
  from the child. Tested against a fake `claude` binary built from this crate
  that records its argv, stdin and environment variable names.
- [x] **8.7** `src/lm_studio.rs`: `LmStudioBackend` over HTTP (`ureq`), tested
  against a fake server on `127.0.0.1` that records the request: no
  `Authorization` header, body shape, and the ARCHITECTURE status table. If
  LM Studio's server runs on this laptop, observe its real error for "no
  model loaded" first.
- [x] **8.8** `src/config.rs` + `src/main.rs`: TOML config (closed list of
  kinds: `claude-code`, `lm-studio`; unknown kind rejected), CLI reading stdin,
  exit codes 0/2/3/4.
- [x] **8.9** `itsaresume serve` (`tiny_http`): `POST /v1/complete`
  `{prompt, system?}` → 200 `{backend, text, attempts}`, 502 stopped, 503
  exhausted, 400 bad body; `GET /healthz`. Default bind `127.0.0.1` — the
  endpoint has no authentication and spends Nicolas's plan.
- [x] **8.10** Docker: multi-stage `Dockerfile` (Rust build → Node runtime with
  the `claude` CLI pinned), `compose.yaml` publishing on `127.0.0.1` only,
  `.env.example` with `CLAUDE_CODE_OAUTH_TOKEN` (subscription token from
  `claude setup-token`), `docker/config.example.toml` pointing LM Studio at
  `host.docker.internal:1234`. CI job builds the image.
- [ ] **8.11** Publish and merge. Done: the public repository exists and
  every branch up to `m1-docker` is pushed; PR #1 (`m0-scaffold`) is open.
  Left: (a) make GitHub Actions run on this repository (§0 lists what was
  tried; next: look at Settings → Actions on the web as Nicolas, or add the
  workflow file through the web UI on a branch, and wait/recheck
  `gh api repos/SigSegGit/itsaresume/actions/workflows`); (b) then merge, in
  order and one at a time, `m0-scaffold` (7 jobs: `merge-when-green.sh 1 7`),
  `m1-router`, `m1-claude`, `m1-lmstudio`, `m1-cli` (7 jobs each),
  `m1-docker` (8 jobs, its `ci.yml` adds `docker`). Rewrite this pointer in
  the last PR.
- [ ] **8.12** Real run in Docker with Claude. The LM Studio half is done
  (2.0 s through the container, §0). Left, once Nicolas has put his token in
  `.env` (⏸ §10): `docker compose up -d` with `docker/config.local.toml`
  (Claude first), one request answered by `claude-code`; capture that real
  success output and replace `synthetic-success.verbose.json`; later, a real
  usage-limit output replaces `synthetic-usage-limit.verbose.json`.

- [ ] **8.13** Billing hardening — **high**, found by the 2026-09-23 review
  (confirmed by reading the code; nothing triggers it today). (a) The child
  still loads user/project settings: an `env` block in
  `~/.claude/settings.json` or `<workdir>/.claude/settings.json` can set
  `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (a paid gateway) or
  `CLAUDE_CODE_USE_BEDROCK` **after** the env scrub, and `apiKeySource` still
  says `"none"`. Observe first which `--setting-sources` value loads no user
  or project settings on 2.1.162 while OAuth still works (`""`? `local`?),
  then pass it in `arguments()`; add `CLAUDE_CONFIG_DIR` to `METERED_ENV`;
  red test in `tests/claude_process.rs` on argv and env. (b) The tripwire
  does not latch: under `serve` every request is billed again. Add a latch in
  `ClaudeCodeBackend` (an `AtomicBool`, plus a marker file next to the
  journal so a restart keeps it); red test: two requests against a fake
  reporting `apiKeySource=ANTHROPIC_API_KEY` spawn the fake once (count via
  `FAKE_CLAUDE_RECORD`). (c) Correct ARCHITECTURE "Billing guards" 3–4: the
  tripwire covers API-key sources only, not base-URL/auth-token/Bedrock/
  Vertex routing. Each fix gets its sabotage defence.
- [ ] **8.14** Endpoint hardening (`src/server.rs`, all confirmed): (a) a web
  page can POST `text/plain` to `127.0.0.1:8787` with no CORS preflight, and
  read answers through DNS rebinding → require `Content-Type:
  application/json`, reject any `Origin` header, accept only a `Host` whose
  name is `127.0.0.1`, `localhost` or `[::1]` (any port: compose may remap
  it); (b) a huge declared `Content-Length` answered 413 makes tiny_http
  drain it into one zero-filled buffer and abort the process → read and
  discard in bounded chunks, or answer and close the connection; (c) one
  `accept()` error ends `serve` with exit 0 and no message → log it and keep
  serving, exit non-zero only on a fatal error; (d) cap concurrent
  completions (thread per request is unbounded). Red tests in
  `tests/server.rs` for each.
- [ ] **8.15** System prompt off the command line (`claude_code.rs`
  `arguments()`): a long or NUL-containing `system` fails to spawn (`Other`),
  and argv is visible in process listings. Observe `--system-prompt-file` on
  2.1.162, write the prompt to a private file in the workdir, pass the path;
  red test: a 100 KB system prompt reaches the fake intact.
- [ ] **8.16** Test and doc honesty (all confirmed, low): TESTING.md cites
  defences whose `expect` lists do not name those tests — make each row match
  `scripts/sabotage/itsaresume-router.json` exactly (a small gate script can
  check it); the timeout test must prove the child is dead (fake writes its
  pid; assert the process is gone); `claude_code.rs` says `apiKeySource:
  "none"` was observed on the OAuth path — it was observed logged-out only,
  fix the comment; `check-handover.py`'s BASE check is vacuous while `main`
  is the root commit (it becomes meaningful after the first merge — note it).

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
- **Docker Desktop sockets on this laptop.** Probable cause, not proved:
  HKCU `Shell Folders\Local AppData` still says `C:\Users\_\AppData\Local`
  (the symlink left by the profile rename) while `User Shell Folders` says
  `C:\Users\SigSeg`; sockets created through the link cannot be reopened.
  Fixing the registry is Nicolas's call (his profile-rename work); until
  then, the §2 workaround may be needed after each Docker restart.
- **`docker-smoke.sh` check 4 is not sabotage-verified**: its discrimination
  (key not stripped → tripwire message or 503 timeout) is argued in the
  script, not demonstrated by breaking the image.
- **From the 2026-09-23 review, not confirmed (uncertain):** extra usage
  (overage) billed per token on the OAuth path is not detectable from the CLI
  output; a `base_url` with `user:pass@` would be sent as Basic auth and
  echoed in errors (reject userinfo in config); the default Claude workdir in
  the temp directory is predictable and never checked; `merge-when-green.sh`
  does not pin the head sha it counted checks for; a truncated answer
  (`finish_reason: "length"`, empty content) counts as success.
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
