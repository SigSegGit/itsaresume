# Handover

<!-- ITSARESUME-STATE
NEXT: 8.23
TITLE: The generator names its backend per call (cv --backend), measuring Sonnet and Bionic from one router
WRITTEN-AT: 2026-09-30
BASE: 14a09c2
-->

Where to resume itsaresume without asking Nicolas anything. Read §0, then §8.
The block above names the next step and `scripts/check-handover.py` keeps it
honest. Whether CI is green or a PR is open are facts for `git` and `gh`,
never for this file: re-derive them.

## 0. Real state

**2026-09-27.** M0 and M1 are merged on `main` (PR #1, PR #2). `main` was
**red** after the two M1 merges (sabotage job, `tests/cli.rs` at baseline):
`a_bad_configuration_or_usage_exits_2` was flaky, because the CLI exits 2
before reading stdin and the test's write of the prompt raised `BrokenPipe`
depending on scheduling (reproduced 70/200 under WSL, 0/200 after the fix).
The earlier "stale artefact" guess (issue #3) was wrong. `scripts/sabotage.py`
hid the cause: it printed the stderr tail, never the failed test's own output;
it now does (`why_red`).

Also fixed on 2026-09-27, each red then green, sabotage-verified: a 2xx answer
cut at the token limit (`finish_reason: length`) or empty was taken as a
success; `ureq` sent the prompts (a whole CV) through any proxy set in
`HTTP_PROXY`/`ALL_PROXY` (now `.proxy(None)`).

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

**2026-09-30.** 8.17 done on `m1/lm-studio-one-slot`: an `lm-studio`
backend lets `max_concurrent` completions reach the server (1 when absent;
`0` refused; unknown on `claude-code`). A second request waits in the router
(a `Condvar` slot shared by clones), the wait counts against `timeout_secs`,
and past it the request is `Unreachable` (falls back) without ever reaching
Bionic. Seven tests, six sabotage defences. 8.18: a `base_url` with
userinfo is refused (never echoed). 8.19: `merge-when-green.sh` merges only
the head it counted (`--match-head-commit`), tested with a fake `gh`.
8.20: the Claude workdir is a private directory of ours, not a link (Unix
tests, verified under WSL: `cargo` is installed there).

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
- [ ] **8.23** The generator side (in `cv/`): `complete()` in
  `cv/src/llm.js` sends an optional `backend`; `measure-listing.mjs` takes
  `--backend`, so one router (`sonnet-qwen.local.toml` with names
  `sonnet` and `qwen`) measures both models (cv 2.1c). Red test: the fake
  router in the cv tests receives `"backend": "qwen"`.

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
  output; the default Claude workdir in the temp directory is predictable and
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
- **Micro-model runtime** (llama.cpp or Ollama, which model) — M2.
- **Contract with the Node.js generator** — M3.

## 10. Waiting on Nicolas

Nothing blocks M1 code, and LM Studio runs on this laptop (the XPS), so the
LM Studio half of 8.12 needs nobody. One action only Nicolas can do, because
it is an interactive login to his account:

- **Merges** (2026-09-28): the auto-mode classifier refuses `gh pr merge`
  ("merge without review"). The rule that lets the session merge its own
  green PRs is `Bash(gh pr merge:*)` in his Claude Code permissions; until
  then they stay open (PR #7).
- `claude setup-token` in a terminal, then put the printed token in `.env` as
  `CLAUDE_CODE_OAUTH_TOKEN=…` (git-ignored). That is the subscription path;
  it is not an API key and is not billed per token.
- When the router runs on another machine than the XPS: the XPS's Tailscale
  name in that machine's `config.local.toml` (never committed).
