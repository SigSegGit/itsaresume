# Test catalogue

Every automated test, and the one property it proves. A test whose property
cannot be stated in one sentence does not belong here — or in the code.

## Rules

- **Red before green.** Each test is committed failing (`red:` commit) before
  the code that makes it pass (`green:` commit). Pull requests are merged with
  merge commits so that order stays visible in `git log`.
- **Sabotage-verified.** Every fallback and error test is listed in a plan
  under `scripts/sabotage/`, which names the line to break and the tests that
  must go red. CI runs `scripts/sabotage.py` on every change: the column
  *Sabotage* below names the defence in that plan. A test that passes with its
  behaviour removed is decoration and is removed.
- **Real data where it exists.** The Claude classifier is tested on CLI output
  captured on the real machine (`tests/fixtures/claude/observed-*`); the
  synthetic fixtures are marked as such and are hypotheses.
- **No mock of the thing under test.** The LM Studio client talks real HTTP to
  a fake server on `127.0.0.1`; the Claude backend spawns a real child process
  (a fake `claude` binary built from this crate).

## Catalogue

| Test | File | Property | Sabotage |
|---|---|---|---|
| `only_quota_and_unreachable_allow_fallback` | `src/backend.rs` | `QuotaExceeded` and `Unreachable` allow fallback; `Other` never does | Other never allows fallback |
| `kinds_have_stable_names` | `src/backend.rs` | The kind names written to the journal and HTTP errors are `quota_exceeded`, `unreachable`, `other` | — (a rename is caught, nothing to sabotage) |
| `first_backend_answers_and_the_next_is_not_called` | `tests/router.rs` | The first answer is returned and later backends are never called | — |
| `quota_exceeded_falls_back_to_the_next_backend` | `tests/router.rs` | A quota error hands the request to the next backend and is recorded as an attempt | Router falls back on quota and outage |
| `unreachable_falls_back_to_the_next_backend` | `tests/router.rs` | An outage hands the request to the next backend | Router falls back on quota and outage |
| `other_error_stops_without_trying_the_next_backend` | `tests/router.rs` | An `Other` error is returned as `Stopped` and the next backend is **never called** (call counter at 0) | Router stops on Other |
| `every_backend_failing_with_fallback_kinds_is_exhausted_with_attempts_in_order` | `tests/router.rs` | When all fail with fallback kinds the result is `Exhausted` and attempts keep the order tried | Router falls back on quota and outage |
| `an_empty_router_is_refused` | `tests/router.rs` | A router with no backend cannot be built | Router refuses an empty backend list |
