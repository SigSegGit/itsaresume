# Handover

<!-- ITSARESUME-STATE
NEXT: 8.37
TITLE: Freeze the generator/router contract: a version and contract tests on both sides
WRITTEN-AT: 2026-10-04
BASE: 4328d8d
-->

Where to resume itsaresume without asking Nicolas anything. Read §0, then §8.
The block above names the next step and `scripts/check-handover.py` keeps it
honest. Whether CI is green or a PR is open are facts for `git` and `gh`,
never for this file: re-derive them.

## 0. Real state

**2026-09-27.** M0 and M1 merged (PR #1, #2). Fixed then, each red then
green: a flaky usage test (`BrokenPipe`, not a stale artefact: issue #3),
`sabotage.py` now prints the failed test's own output (`why_red`), a cut or
empty 2xx answer is no success, and `ureq` ignores proxy variables.

**Claude Code answers** since 2026-09-27 (`claude auth status`: logged in,
`pro`): `sonnet-qwen.local.toml` served both real offers through
`claude-code` in 288 s, first attempt each. The Pro quota is the one the
owner's own Claude sessions use.

**The local model is now "Bionic"**, an OpenAI-compatible server on the same
`127.0.0.1:54321/v1`, serving `qwen/qwen3-coder-next` (Q4_K_M, 32k context,
**one request at a time**, slow on this laptop; off when the laptop is).
The `lm-studio` backend speaks to it unchanged (no `/api/v0` endpoint is
used). Configs, git-ignored: `bionic.local.toml` (Bionic only) and
`sonnet-qwen.local.toml` (Claude, then Bionic). Nothing in CI may depend on
it. Keep each backend's `timeout_secs` **below** the generator's client
timeout: the router never cancels a call, and an abandoned one keeps
Bionic's single slot busy.

**The generator** that uses this router is `cv/` in this repository
(Node.js; moved here from the private `itsaresume-cv` on 2026-09-30): its
own `cv/docs/HANDOVER.md`; the `/itsaresume` skill covers both. The owner's
private notes are in `~/.itsaresume/HANDOVER-prive.md`, never here.

**2026-09-29.** 8.14 (endpoint hardening) and 8.15 (system prompt through
`--system-prompt-file`, a private file per request) merged; details in §8.
Trap: `sabotage.py` needs its plan on the repository's drive (`relpath`);
put a partial plan in `target/`.

**2026-09-30.** 8.16 done on `m1/test-doc-honesty`:
`scripts/check-testing.py` (CI job with `check-handover.py`) holds every
TESTING.md row to the sabotage plan's `expect` lists, both ways (it found 25
gaps, all closed: wrong citations removed, 11 missing rows added). The
timeout test now proves the child dead: the fake creates a file if it
outlives its sleep, and the defence that drops `child.kill()` turns it red.
`check-handover.py`'s BASE check is no longer vacuous (`main` has merges).

**2026-09-30.** 8.17: one completion at a time per local backend
(`max_concurrent`; the wait counts against `timeout_secs`). 8.18: a `base_url` with
userinfo is refused (never echoed). 8.19: `merge-when-green.sh` merges only
the head it counted (`--match-head-commit`), tested with a fake `gh`.
8.20: the Claude workdir is a private directory of ours, not a link (Unix
tests, verified under WSL: `cargo` is installed there).

**2026-10-04.** 8.34-8.36 (`kind`, `serves`; no call marked `classify`:
the local model already loses quality on both calls that only choose).
Same day, asked by the owner (branch `router/token-usage`): tokens traced,
Claude and local apart, in the journal and `stats` (8.38, by day 8.40), in the HTTP
answer (8.39), per job in the generator's QA log (cv 2.13); a public job
readable by its own visitor only (cv 2.14); favicon and link preview (cv
2.15); another profile and matchmaking written as cv 4.x and 5.x. Done in
a cloud session (Linux, no Claude, no Bionic): nothing measured on a real
call; the token counts are read from the observed fixtures. Next: M3's
frozen contract (8.37), after cv 2.3 (needs the laptop's models).

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
RUSTFLAGS="-D warnings" python scripts/sabotage.py   # as CI: a sabotage that leaves dead code must still compile
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
- [x] **8.11** Publish and merge (PR #1, PR #2, 2026-09-24). Done: the public repository exists and
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

- [x] **8.13** Billing hardening (2026-09-28, branch `m1/billing-hardening`).
  (a) `--setting-sources ""` (observed on 2.1.162: accepted, OAuth answers;
  a hostile project `settings.json` did not reroute `-p` even without it, so
  it is defence in depth for user settings too), `CLAUDE_CONFIG_DIR`
  scrubbed. (b) The tripwire latches in memory and in
  `<journal>.billing-tripped`; a restarted process refuses too. (c)
  ARCHITECTURE "Billing guards" says what the tripwire does not see.
  Red then green, 6 defences. CI's sabotage job was first red: three
  `dead` snippets left an unused binding, a compile error under CI's
  `RUSTFLAGS=-D warnings` (locally run without it); each now keeps the
  binding used (`let _ = …`), verified with the CI flags.
- [x] **8.14** Endpoint hardening (`src/server.rs`, all confirmed): (a) a web
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
- [x] **8.15** System prompt off the command line (`claude_code.rs`
  `arguments()`): a long or NUL-containing `system` fails to spawn (`Other`),
  and argv is visible in process listings. Observe `--system-prompt-file` on
  2.1.162, write the prompt to a private file in the workdir, pass the path;
  red test: a 100 KB system prompt reaches the fake intact. Done: `SystemFile`
  in `claude_code.rs` (`create_new`, 0600 on Unix, pid + counter, absolute
  path, removed on drop); six tests, four sabotage defences.
- [x] **8.16** Test and doc honesty (all confirmed, low): TESTING.md cites
  defences whose `expect` lists do not name those tests — make each row match
  `scripts/sabotage/itsaresume-router.json` exactly (a small gate script can
  check it); the timeout test must prove the child is dead (fake writes its
  pid; assert the process is gone); (the `apiKeySource: "none"` comment
  is now true: observed on OAuth on 2026-09-29, done in 8.15); `check-handover.py`'s BASE check is vacuous while `main`
  is the root commit (it becomes meaningful after the first merge — note it).
  TESTING.md must also gain the six 8.14 defences (`Endpoint …`, `Serve loop
  returns the error that ends it`).
- [x] **8.17** One completion at a time per `lm-studio` backend: the local
  server (Bionic) has one slot; today the router sends it every request and
  lets them queue there, past the generator's timeout. A per-backend limit
  (`max_concurrent`, default 1 for `lm-studio`, none for `claude-code`) that
  makes a second request wait in the router, bounded by the backend's
  `timeout_secs`, then fall back as an outage. Red test: two slow requests
  to a scripted one-slot backend, the second never overlaps the first.
  Done: `Slots` in `lm_studio.rs`, `max_concurrent` in `config.rs`; seven
  tests, six defences.
- [x] **8.18** Reject userinfo in an `lm-studio` `base_url` (from the
  2026-09-23 review, §9): `http://user:pass@host/v1` would be sent as Basic
  auth (a credential, against decision 1) and echoed in every error and
  journal line. `Config::router()` refuses a `base_url` with `@` in its
  authority, naming the field but never echoing the value. Red test: two
  URLs (`user:pass@`, `user@`) refused, the message holds neither `pass`
  nor `user`; a normal URL and one with `@` only in the path still build.
  Done: `has_userinfo` in `config.rs`; one test, two defences.
- [x] **8.19** `scripts/merge-when-green.sh` pins the head sha it counted
  checks for (§9, 2026-09-23 review): a push between the count and the merge
  must abort the merge (`gh pr merge --match-head-commit <sha>`).
  Done: `scripts/test-merge-when-green.sh` (fake `gh`, four cases, CI job
  `handover`), plan `scripts/sabotage/merge-when-green.json` (three
  defences); `check-testing.py` now reads every plan.
- [x] **8.20** The default Claude working directory is checked before use
  (§9, 2026-09-23 review, and the 8.15 system-prompt-file note): today it is
  a fixed name under the temp directory (`itsaresume-claude`), created if
  missing and used as found. On Unix, refuse it unless it is a directory (not
  a symlink) owned by us with mode 0700 (create it 0700); on Windows `%TEMP%`
  is per user, keep the check to "a directory, not a link". Red tests (Unix
  only for the mode/owner; the link test on both): a pre-created 0777
  directory and a symlink are refused as `Other` naming the path.
  Done: `private_workdir` in `claude_code.rs` (a 0755 dir of ours is
  tightened, `chmod` fails on someone else's); four Unix tests; defences
  marked `unix_only` (`sabotage.py` skips them on Windows, loudly), verified
  under WSL; the 8.15 0600 file gained its defence the same way.
- [x] **8.21** `scripts/sabotage-wsl.sh` runs the whole plan under WSL
  (`unix_only` defences verified before a push; first run 2026-09-30: 76 of
  77, the 77th a real anchor break, fixed on PR #14; the "huge declared
  body" defence Windows cannot verify passes there). The Linux CI job never
  skips `unix_only` (`os.name == 'nt'` only), so no guard was needed.
  `check-testing.py` (fast CI job `handover`) now also fails when a
  defence's `live` anchor is not exactly once in its file: the anchor break
  above took 16 minutes of the sabotage job to show.
- [x] **8.22** A request may name its backend (M3's first step, the
  generator's 2.1c/2.3 need it): `POST /v1/complete` and `complete` take an
  optional `backend` (a configured backend's `name`, a new optional config
  field, unique; default the kind); named, only that backend is tried (no
  fallback: the caller asked for it) and an unknown name is 400 / exit 2
  listing the names. Red tests: two lm-studio backends named `a` and `b`
  (scripted servers), a request naming `b` reaches only `b`; unknown `c` is
  400 with `a, b`; without a name the order and fallback are unchanged.
  Done: `Router::complete_on`, `UnknownBackend`, config `name` (unique,
  wrapped as `Named`), `"backend"` in the endpoint, `--backend` on the CLI;
  five tests, six defences (verified with `-D warnings`).
- [x] **8.23** The generator side (in `cv/`): `complete()` in
  `cv/src/llm.js` sends an optional `backend`; `measure-listing.mjs` takes
  `--backend`, so one router (`sonnet-qwen.local.toml` with names
  `sonnet` and `qwen`) measures both models (cv 2.1c). Red test: the fake
  router in the cv tests receives `"backend": "qwen"`. Done (PR #24):
  Sonnet lists 75/75 of the cv corpus, Bionic 69/75 with the floor.
- [x] **8.24** Structured output (M3, the generator's 2.3): `POST
  /v1/complete` takes an optional `schema` (a JSON Schema object); the
  `lm-studio` backend sends it as `response_format: {type: "json_schema",
  json_schema: {name, schema, strict: true}}` (observe Bionic's answer
  first, record the fixture); the `claude-code` backend has no schema flag
  observed yet: it appends the schema to the system prompt file, and the
  router checks the answer parses as JSON either way (an answer that does
  not parse is `Other`, never a success). Red tests: the scripted
  lm-studio server receives the `response_format`; a non-JSON answer to a
  schema request is `Other`; no schema, no change. Done: observed first
  (Bionic honours `json_schema`; `claude --json-schema` answers in
  `structured_output` through a `StructuredOutput` tool, which the
  tripwire now allows only for a schema request and only alone:
  docs/ARCHITECTURE.md); eight tests, eight defences; a real request
  through each backend returned the JSON document. Also: `scripts/pre-push.sh`
  (install: `cp scripts/pre-push.sh .git/hooks/pre-push`) runs
  check-testing, check-handover and the cv catalogue check before a push:
  three CI runs were lost on 2026-09-30 to a command chain that went on
  past a failed gate.
  Same day, a WSL sabotage run hung for 90 minutes: a test panicked before
  killing its `serve` child, the orphan held the run's pipes, the working
  tree kept a sabotaged `server.rs`, and the run resumed rewriting files
  after a branch switch. Fixed: `Serving` (kill on drop, no inherited
  stdout) in `tests/server.rs`; `sabotage-wsl.sh` runs in a detached
  worktree at HEAD (commit first).
- [x] **8.25** The generator side of structured output (cv 2.3's first
  step): `listRequirements` sends the listing schema (`{requirements:
  [{name, importance: must|nice}]}`) through `complete({schema})`, so no
  answer is lost to `extractJson`; measure the corpus recall again with
  `measure-listing.mjs` for both backends (it must not drop). Then the
  analysis call, whose schema is larger (a closed list of skill ids).
  Done (PR #27), measured: with the schema the local model listed 61-66/75
  against 68-70/75 without (three runs each), Sonnet 75/75 either way; so
  the listing sends it only when asked (`structured`). See cv §8, 2.3.
- [x] **8.26** The journal says how a request was asked: `backend_asked`
  (the name, when the request named one) and `schema: true` when it
  carried a schema, so the cost and failure rate of structured calls can
  be read from the journal later. Never the schema itself (it may be
  large) and never the prompt (§1). Red test: two journaled requests, one
  named and structured, one plain; the lines differ exactly by those two
  fields. Done: `Journal::record_asked`; one test, three defences.
- [x] **8.27** `itsaresume complete --schema FILE`: the CLI reads a JSON
  Schema object from FILE and asks for structured output, as the endpoint
  does (8.24). A file that is not a JSON object is a usage error (exit 2,
  naming the file, before any backend is called). Red tests in
  `tests/cli.rs`: with the fake claude and `--backend claude-code`, the
  recorded args hold `--json-schema` with the file's schema; a file holding
  `[1]` exits 2 and the fake is never run. (8.12, the Docker run with
  Claude, still waits on the owner's `claude setup-token`, §10.) Done:
  `read_schema` in `main.rs`; two tests, three defences.
- [x] **8.28** Observed success fixtures (§9 says no successful CLI output
  was ever observed; on 2026-09-30 several were, through the router): run
  `claude -p` once plain and once with `--json-schema` (the router's own
  flags, a trivial synthetic prompt), save both `--verbose` arrays under
  `tests/fixtures/claude/observed-success*.verbose.json` with every id,
  path, session and machine-specific value replaced by `REDACTED`, and
  make `classify` / `classify_for` tests run on them next to the
  synthetic ones. Then drop the §9 item. Done: `observed-success` and
  `observed-structured-output` (redacted: ids, paths, the skill/agent/plugin
  lists, thinking signatures, account details of the rate-limit event); two
  tests, one new defence. Found on the way: `rate_limit_event` carries
  `rate_limit_info.isUsingOverage` (false here) and `overageStatus`.
- [x] **8.29** Overage tripwire: extra usage is billed per token (decision
  1). When a `rate_limit_event` says `isUsingOverage: true`, the answer is
  refused as `Other` and the billing latch is set (as for `apiKeySource`),
  so the next request does not spend more; the journal says why. Red tests
  from `observed-success.verbose.json` edited to `isUsingOverage: true`:
  `Other` with "overage" in the message, latch file written; `false` or no
  event: unchanged. Note it can only stop the *next* call (the one that
  reported it was already billed): say so in §9. Done: the check in
  `classify_for` (its message starts "billing tripwire", so the existing
  latch applies); a classify test and an end-to-end CLI test (exit 3, latch
  written, next process stopped); two defences. The Docker image pins the
  CLI version observed (2.1.162), so `--json-schema` and the rate-limit
  event are there too.
- [x] **8.30** `itsaresume stats [--config FILE]`: read the journal and
  print, per backend and outcome, the count and the median `duration_ms`;
  the share of requests with `schema: true`; the fallbacks (answered after
  a failed attempt). Plain text on stdout, nothing written; a journal line
  that is not JSON is counted as unreadable, never fatal. Red tests in
  `tests/cli.rs` on a hand-written journal of five lines. Done:
  `src/stats.rs`; three tests, five defences; on the owner's own journal
  (56 requests) it read 40 answered by the local model (median 48 s), 13
  by Claude (26 s). README documents `--backend`, `--schema`, `stats`.
- [x] **8.31** `docs/ROADMAP.md` says what is done and what is next: bring
  it up to 8.17-8.30 (one slot per local backend, named backends,
  structured output, the tripwires, stats), close M1 if nothing of it is
  left but 8.12 (the owner's token), and write M3's next items from cv
  2.3 (the analysis schema, measured before it is sent). Done: M1 row
  and contents, M3 and M4 marked started, M3's "own repository" corrected.
- [x] **8.32** M4's second half starts in the journal: a Claude answer's
  `rate_limit_event` (`status`, `rateLimitType`, `isUsingOverage`, never
  `resetsAt` precision beyond the minute) goes into its journal line as
  `rate_limit`, so `stats` can later say when the plan ran out. The
  `Completion` gains an optional `meta` the Claude backend fills; the
  journal writes it. Red tests: the observed success journaled with its
  `rate_limit`; an LM Studio answer without one. Done: `rate_limit` on
  `Completion` and `Answer` (status, rateLimitType, isUsingOverage,
  overageStatus only); two tests, three defences.
- [x] **8.33** `itsaresume stats --by-day`: one block per UTC day (from
  `ts`): the share Claude answered, the quota hits (attempts of kind
  `quota_exceeded`, and answers whose `rate_limit.status` is not
  `allowed`), and the time of the first one that day ("ran out at 14:02").
  That is M4's exit criterion (ROADMAP). Red tests on a hand-written
  two-day journal. Done: `summarize_by_day` in `src/stats.rs`, `--by-day`;
  two tests, four defences; on the owner's journal, five days, no quota hit
  yet. M4's exit criterion is met (ROADMAP).
- [x] **8.34** M2's first step, no hardware choice needed: a request has a
  `kind`, `generate` (default) or `classify`; a backend's config may say
  `serves = ["classify"]` (default: both); the router skips a backend that
  does not serve the request's kind (not an attempt, not a failure), and a
  request no backend serves is a usage error (400 / exit 2). Red tests: a
  classify-only backend first, a generate request goes past it to the
  next; a classify request is answered by it; `serves = []` is refused at
  load. M2's exit criterion (ROADMAP): "the router refuses to send a
  generation request to it", proved by a sabotage-verified test. Done:
  `Kind`, `Backend::serves`, `RouteError::Unserved` (400 / exit 2 /
  journal "unserved"), config `serves` through `Named`, `"kind"` on the
  endpoint; four tests, five defences. The runtime and the model on the Pi
  or the VM stay open (§9, the owner's choice).
- [x] **8.35** `itsaresume complete --kind classify` (the CLI parity of
  `"kind"`), an unknown kind a usage error; `serves` shown, commented, in
  `config.example.toml` and README. Red test in `tests/cli.rs`: a config
  whose only backend serves classify: `--kind classify` answers, no flag
  exits 2 naming the kind. Done: one test, two defences (one anchor moved).
- [x] **8.36** The generator side of M2 (in `cv/`): `complete()` sends
  `kind` when asked, none otherwise (one test, two defences); the CLI
  passes it through. **Measured, 2026-10-04, before marking any call:**
  `cv/scripts/measure-split.mjs` (each corpus offer alone, and six
  agency emails of two or three offers) gives the split Sonnet 14/14, the
  local model 7/14 (it leaves requirement lines out and merges offers);
  the listing was already 75/75 against 69/75 (cv 2.1e). **So no call is
  marked `classify` yet**: a small model, weaker than the local one, would
  lose more. Mark a call only when a candidate small model measures equal
  to Sonnet on its `measure-*` script (`--backend <name>` alone).
- [ ] **8.37** M3's exit: freeze the contract between `cv/` and the
  router. After cv 2.3 (the analysis schema measured, whatever it
  decides). A `contract` version the router returns in every answer of
  `POST /v1/complete` (and `GET /health`); the request fields
  (`prompt`, `system`, `backend`, `schema`, `kind`) and the answer fields
  (`text`, `backend`, `attempts`, `error.kind`, `error.attempts`) written
  once in `docs/ARCHITECTURE.md`. Red tests: in `tests/` a request with
  every field and the answer's exact key set; in `cv/test/` the client
  refuses an answer whose `contract` major is not the one it speaks
  (clear error naming both), and accepts one without `contract` only from
  a router older than the field (decide and write which, in ADR form).
  The answer's optional `usage` (8.39) is part of the frozen set.
- [x] **8.38** (2026-10-04, asked by the owner: tokens traced on the
  server, Claude and the local model apart) `Completion` and `Answer` gain
  `usage: Option<Usage>` (`input`, `output`, `cache_read`,
  `cache_creation`): Claude's from the result message's `usage`
  (observed: a real call reads almost all its input from the cache, 3
  uncached against 6914 read and 7109 written), the local model's from
  the OpenAI-compatible `usage` (`prompt_tokens`, `completion_tokens`).
  The journal writes it; `stats` prints `tokens by <backend>: N read (M
  from cache), K written, over A answers`. Five tests, ten defences.
  `total_cost_usd` is not journaled (notional on a plan; ROADMAP M4).
- [x] **8.39** The HTTP answer carries `usage` when the backend reported
  it, so the generator counts tokens per run (cv 2.13). One test, one
  defence.
- [x] **8.40** (Rodin) `stats --by-day` adds, per day and backend, the
  tokens read and written (`; tokens claude-code 14119 read 200 written,
  …`), so the day the plan ran out says what it went on. One test, three
  defences.

## 9. Deliberately open

- **Usage-limit output format unknown.** Classified by `api_error_status`
  429 or a message pattern; an unrecognised limit message is `Other` and stops
  loudly, with the raw message in the error and the journal. Add its fixture
  when seen.
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
  (overage) billed per token on the OAuth path: detectable after all, the
  `rate_limit_event` message carries `isUsingOverage` and `overageStatus`
  (observed 2026-09-30, 8.28; 8.29 refuses such an answer and latches,
  but the answer that reported it was already billed: the tripwire saves
  the next calls, not that one); the default Claude workdir in the temp directory is predictable and
  never checked (fixed in 8.20). Fixed since: the truncated answer (2026-09-27),
  userinfo in `base_url` (8.18), the unpinned merge (8.19).
- **The system prompt file on disk** (8.15): a crash mid-request leaves it
  in the working directory; its 0600 test runs on Unix only (its
  defence is `unix_only`, verified under WSL and in CI). It sharpens the item above:
  on a shared Unix `/tmp`, another user could own `itsaresume-claude` and swap
  the file before `claude` reads it: closed by 8.20 (the working directory
  must be ours and 0700). `itsaresume complete --system` still takes the text on the
  router's own command line (the caller's choice; `serve` does not).
- **Local sabotage on Windows**: "Endpoint never drains a huge declared
  body" stays green there (seen 2026-09-29, 60 of 61 verified); the Linux CI
  verifies it (PR #10). Not investigated: tiny_http's drain probably does not
  abort on Windows. Trust the CI's sabotage job for that defence.
- **Error texts still quoted into the journal** (red team, 2026-10-01): the
  non-JSON cases now give a length, not the text; four excerpts remain
  (LM Studio "without choices[0].message.content" and HTTP bodies with no
  `error.message`; Claude "result message is not understood"; the Claude
  stderr excerpt). They are server or CLI texts, but can carry model-shaped
  text: give lengths there too.
- **Tokens of a refused answer are not counted** (8.38): an answer the
  router refuses (the billing tripwire, LM Studio's `finish_reason:
  length`) took tokens no journal line reports. Small next to the rest;
  count them if the plan runs out unexplained.
- **Micro-model runtime** (llama.cpp or Ollama, which model) — M2.
- **Contract with the Node.js generator** — M3.

## 10. Waiting on Nicolas

Nothing blocks M1 code, and LM Studio runs on this laptop (the XPS), so the
LM Studio half of 8.12 needs nobody. One action only Nicolas can do, because
it is an interactive login to his account:

- **Merges**: settled. Since 2026-09-30 the session merges its own green
  PRs through `scripts/merge-when-green.sh` (26 merged that day).
- `claude setup-token` in a terminal, then put the printed token in `.env` as
  `CLAUDE_CODE_OAUTH_TOKEN=…` (git-ignored). That is the subscription path;
  it is not an API key and is not billed per token.
- A manual check of the generator on five new real offers, every bullet
  read against the profile (Rodin, 2026-10-01): the honesty of a plausible
  sentence is measured by no test; what he finds becomes corpus cases.
- After the first week of real use: a look at the account's billing page
  (the overage tripwire detects extra usage after the call it billed).
- When the router runs on another machine than the XPS: the XPS's Tailscale
  name in that machine's `config.local.toml` (never committed).
