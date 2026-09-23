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
| `every_request_appends_one_json_line_naming_the_answering_backend` | `tests/journal.rs` | Each request appends exactly one parseable JSON line with outcome, answering backend, failed attempts, lengths, duration and a UTC timestamp | — |
| `stopped_and_exhausted_requests_are_journaled_too` | `tests/journal.rs` | Failed requests are journaled as `stopped` (with the stopping backend) or `exhausted` (no backend) | — |
| `the_prompt_and_answer_text_are_never_written_to_the_journal` | `tests/journal.rs` | Sentinel prompt, system prompt and answer never appear in the journal file | Journal keeps the prompt out |
| `error_messages_are_truncated_in_the_journal` | `tests/journal.rs` | A 1,000-character error message is cut to 200 characters plus `…` | Journal truncates error messages |
| `an_unwritable_journal_does_not_lose_the_answer` | `tests/journal.rs` | When the journal cannot be written the answer is still returned **and** the failure is reported | Router reports a journal it could not write |
| `a_successful_run_is_an_answer` | `tests/claude_classify.rs` | `is_error: false` with a `result` string is the answer | — |
| `the_observed_not_logged_in_output_is_other` | `tests/claude_classify.rs` | The **observed** not-logged-in output (`subtype: success`, `is_error: true`) is `Other`, message kept | Claude: is_error decides, not subtype; Claude: unknown wording stops |
| `the_observed_api_key_run_trips_the_billing_wire` | `tests/claude_classify.rs` | The **observed** run with `ANTHROPIC_API_KEY` set is refused, naming the billing source | Claude: billing tripwire |
| `a_successful_answer_billed_to_an_api_key_is_refused` | `tests/claude_classify.rs` | A *successful* answer whose `apiKeySource` is `ANTHROPIC_API_KEY`, `apiKeyHelper` or `/login managed key` is refused | Claude: billing tripwire |
| `output_without_an_init_message_is_refused` | `tests/claude_classify.rs` | Without `system/init` the billing source cannot be checked, so the output is refused (fail closed) | Claude: init message required |
| `a_successful_answer_with_tools_enabled_is_refused` | `tests/claude_classify.rs` | An answer produced with tools enabled is refused (prompt-injection guard) | Claude: tool tripwire |
| `the_synthetic_usage_limit_is_quota_exceeded` | `tests/claude_classify.rs` | The synthetic usage-limit output (429) is `QuotaExceeded` — **hypothesis** | Claude: HTTP 429 is quota |
| `status_429_is_quota_exceeded_whatever_the_message` | `tests/claude_classify.rs` | HTTP 429 alone makes `QuotaExceeded` | Claude: HTTP 429 is quota |
| `usage_limit_wordings_without_a_status_are_quota_exceeded` | `tests/claude_classify.rs` | Known plan-limit wordings without a status are `QuotaExceeded` — **hypothesis**, not observed | Claude: wording 'usage limit' / 'limit reached' / 'hit your ... limit' |
| `context_and_login_errors_are_not_mistaken_for_quota` | `tests/claude_classify.rs` | Context-length and login errors mentioning a limit stay `Other` | Claude: context errors are not quota |
| `server_side_failures_are_unreachable` | `tests/claude_classify.rs` | HTTP 500–504 and 529 are `Unreachable` | Claude: 5xx and 529 are unreachable |
| `connection_errors_without_a_status_are_unreachable` | `tests/claude_classify.rs` | Connection-failure wordings without a status are `Unreachable` — **hypothesis** | Claude: connection wordings are unreachable |
| `unrecognised_errors_are_other` | `tests/claude_classify.rs` | 400, 401 and unknown wordings are `Other` (stop loudly) | Claude: other statuses stop; Claude: unknown wording stops |
| `output_that_is_not_the_expected_json_is_other` | `tests/claude_classify.rs` | Empty, non-JSON, object-shaped or result-less output is `Other` | — |
