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
| `a_named_backend_is_the_only_one_tried` | `tests/router.rs` | A request naming a backend is answered by it alone; its quota is the answer, no fallback | Named backend: only that one is tried; Named backend: found by its name |
| `an_unknown_backend_name_is_refused_with_the_configured_names` | `tests/router.rs` | An unknown name tries nothing and lists the configured names; no name keeps the order | Named backend: found by its name |
| `a_generation_request_goes_past_a_classify_only_backend` | `tests/router.rs` | M2's exit criterion: a generation never reaches a classify-only backend (not an attempt either); a classification does | M2: a backend is tried only for the kinds it serves |
| `a_request_no_backend_serves_is_unserved` | `tests/router.rs` | A request no backend serves is `Unserved`, and nothing is called | M2: a request no backend serves is unserved |
| `every_backend_failing_with_fallback_kinds_is_exhausted_with_attempts_in_order` | `tests/router.rs` | When all fail with fallback kinds the result is `Exhausted` and attempts keep the order tried | Router falls back on quota and outage |
| `an_empty_router_is_refused` | `tests/router.rs` | A router with no backend cannot be built | Router refuses an empty backend list |
| `every_request_appends_one_json_line_naming_the_answering_backend` | `tests/journal.rs` | Each request appends exactly one parseable JSON line with outcome, answering backend, failed attempts, lengths, duration and a UTC timestamp | — |
| `stopped_and_exhausted_requests_are_journaled_too` | `tests/journal.rs` | Failed requests are journaled as `stopped` (with the stopping backend) or `exhausted` (no backend) | — |
| `the_prompt_and_answer_text_are_never_written_to_the_journal` | `tests/journal.rs` | Sentinel prompt, system prompt and answer never appear in the journal file | Journal keeps the prompt out |
| `a_named_structured_request_is_journaled_as_such` | `tests/journal.rs` | A line says `backend_asked` and `schema: true` when the request named a backend and carried a schema, neither otherwise, and never holds the schema | Journal: the backend asked for; Journal: a schema request is marked; Router: the journal hears the name asked |
| `the_rate_limit_of_an_answer_is_journaled` | `tests/journal.rs` | An answer's rate limit goes into its journal line; an answer without one writes none | Router: the answer keeps its rate limit; Journal: the rate limit is written |
| `the_token_usage_of_an_answer_is_journaled` | `tests/journal.rs` | 8.38: an answer's tokens go, through the router, into its journal line as `usage` (each count under its own name); a backend reporting none writes none | Tokens: the router hands the usage on; Tokens: the journal writes each count under its own name |
| `tokens_are_summed_per_backend` | `tests/stats.rs` | 8.38: `stats` sums tokens per backend (Claude and the local model apart): read (cache included, what the cache served said apart, omitted when none), written, over the answers that reported them | Tokens: stats counts cache writes as read; Tokens: stats says no cache when there was none; Tokens: stats says one answer, not one answers |
| `the_journal_by_day_sums_the_tokens_per_backend` | `tests/stats.rs` | 8.40: `--by-day` adds, per day and backend, the tokens read (cache included) and written; a day without `usage` says nothing | Tokens: stats counts cache writes as read; Tokens: by day, each answer's tokens are added; Tokens: by day, a day without usage says nothing |
| `the_journal_is_summed_up_per_backend_and_outcome` | `tests/stats.rs` | A journal of five lines and a garbage one: counts and medians per backend and outcome, fallbacks, structured share, the garbage line skipped | Stats: a fallback is an answer after a failed attempt; Stats: structured requests counted; Stats: an unreadable line is skipped, not counted; Stats: the median is the middle |
| `an_empty_journal_says_so` | `tests/stats.rs` | No journal line: one line, `requests: 0` | — |
| `the_journal_by_day_says_when_the_plan_ran_out` | `tests/stats.rs` | Per UTC day: requests, answers per backend, quota hits (a `quota_exceeded` attempt or a limit not `allowed`) and the time of the first | Stats by day: a limit not allowed is a hit; Stats by day: the first hit stays; Stats by day: a quota attempt is a hit |
| `a_timestamp_of_multibyte_characters_is_skipped_not_fatal` | `tests/stats.rs` | A `ts` of multi-byte characters (long in bytes, no char boundary at 10) is skipped by `stats --by-day`, never a panic, and the other lines are still summed | Stats by day: a multi-byte ts is skipped |
| `a_timeout_too_large_for_a_deadline_is_refused` | `tests/config.rs` | A `timeout_secs` above 86400 (u64::MAX would panic the deadline) cannot build a router and the error names `timeout_secs`; 86400 still builds, for both kinds | Config: a timeout above a day is refused |
| `a_non_json_answer_to_a_schema_request_is_not_quoted_in_the_error` | `tests/lm_studio.rs` | A schema request answered with text that is not JSON fails with the text's length, never the text (the journal keeps lengths only) | LM Studio: a non-JSON schema answer is counted, not quoted |
| `a_result_message_not_understood_is_counted_not_quoted` | `tests/claude_classify.rs` | 8.41: a result message with no boolean `is_error` is given as a length, never quoted (its `result` is model text) | Journal: a result not understood is counted, not quoted |
| `stdout_that_is_not_json_is_not_quoted_in_the_error` | `tests/claude_classify.rs` | `claude` stdout that is not the JSON array fails with its length, never the text | Claude: non-JSON stdout is counted, not quoted |
| `error_messages_are_truncated_in_the_journal` | `tests/journal.rs` | A 1,000-character error message is cut to 200 characters plus `…` | Journal truncates error messages |
| `an_unwritable_journal_does_not_lose_the_answer` | `tests/journal.rs` | When the journal cannot be written the answer is still returned **and** the failure is reported | Router reports a journal it could not write |
| `a_successful_run_is_an_answer` | `tests/claude_classify.rs` | `is_error: false` with a `result` string is the answer, with its `usage` tokens | Claude: a success is its result text; Tokens: a Claude answer carries its usage; Tokens: Claude's cache reads are counted apart |
| `the_observed_not_logged_in_output_is_other` | `tests/claude_classify.rs` | The **observed** not-logged-in output (`subtype: success`, `is_error: true`) is `Other`, message kept | Claude: is_error decides, not subtype; Claude: unknown wording stops |
| `the_observed_api_key_run_trips_the_billing_wire` | `tests/claude_classify.rs` | The **observed** run with `ANTHROPIC_API_KEY` set is refused, naming the billing source | Claude: billing tripwire |
| `a_successful_answer_billed_to_an_api_key_is_refused` | `tests/claude_classify.rs` | A *successful* answer whose `apiKeySource` is `ANTHROPIC_API_KEY`, `apiKeyHelper` or `/login managed key` is refused | Claude: billing tripwire |
| `output_without_an_init_message_is_refused` | `tests/claude_classify.rs` | Without `system/init` the billing source cannot be checked, so the output is refused (fail closed) | Claude: init message required |
| `a_successful_answer_with_tools_enabled_is_refused` | `tests/claude_classify.rs` | An answer produced with tools enabled is refused (prompt-injection guard) | Claude: tool tripwire |
| `a_schema_answer_is_its_structured_output` | `tests/claude_classify.rs` | With a schema, the answer is `structured_output` (observed on 2.1.162: `result` is empty) | Schema: claude's answer is structured_output |
| `the_success_observed_in_docker_is_an_answer_on_the_subscription` | `tests/claude_classify.rs` | 8.12: the success captured on 2026-10-06 inside the VM's router container (2.1.162, Linux, backend flags) is an answer "OK" through the subscription (`apiKeySource: "none"`, no tools), its rate limit (`allowed`) and usage kept | Claude: the rate-limit event is kept |
| `the_observed_success_is_an_answer` | `tests/claude_classify.rs` | A plain success observed on 2.1.162 (redacted) is its `result` text | Claude: a success is its result text |
| `the_observed_structured_output_is_its_json` | `tests/claude_classify.rs` | A structured success observed on 2.1.162 is its `structured_output`; unasked, its tool trips the wire | Schema: claude's answer is structured_output; Schema: StructuredOutput only with a schema |
| `an_answer_billed_as_overage_trips_the_billing_wire` | `tests/claude_classify.rs` | A rate-limit event with `isUsingOverage: true` refuses the answer as the billing tripwire; `false` is an answer | Claude: overage trips the billing wire; Claude: overage refusal latches |
| `a_claude_answer_carries_its_token_usage` | `tests/claude_classify.rs` | 8.38: the observed structured answer carries its `usage` (3 read, 179 written, 6914 from cache, 7109 to cache); a result without `usage` carries none | Tokens: a Claude answer carries its usage; Tokens: Claude's cache reads are counted apart; Tokens: a Claude result without usage reports none |
| `a_claude_answer_carries_its_rate_limit_event` | `tests/claude_classify.rs` | A Claude answer carries its `rate_limit_event` (status, type, overage); a run without one carries none | Claude: the rate-limit event is kept |
| `the_structured_output_tool_without_a_schema_is_refused` | `tests/claude_classify.rs` | `StructuredOutput` in init without a schema asked for trips the tool tripwire | Schema: StructuredOutput only with a schema; Claude: tool tripwire |
| `another_tool_beside_structured_output_is_refused` | `tests/claude_classify.rs` | With a schema, any tool beside `StructuredOutput` still trips it | Schema: StructuredOutput alone; Claude: tool tripwire |
| `a_schema_answer_without_structured_output_is_other` | `tests/claude_classify.rs` | A schema request answered without `structured_output` is `Other` | Schema: claude's answer is structured_output |
| `the_synthetic_usage_limit_is_quota_exceeded` | `tests/claude_classify.rs` | The synthetic usage-limit output (429) is `QuotaExceeded` — **hypothesis** | Claude: HTTP 429 is quota |
| `status_429_is_quota_exceeded_whatever_the_message` | `tests/claude_classify.rs` | HTTP 429 alone makes `QuotaExceeded` | Claude: HTTP 429 is quota |
| `usage_limit_wordings_without_a_status_are_quota_exceeded` | `tests/claude_classify.rs` | Known plan-limit wordings without a status are `QuotaExceeded` — **hypothesis**, not observed | Claude: wording 'usage limit'; Claude: wording 'limit reached'; Claude: wording 'hit your ... limit' |
| `context_and_login_errors_are_not_mistaken_for_quota` | `tests/claude_classify.rs` | Context-length and login errors mentioning a limit stay `Other` | Claude: context errors are not quota |
| `server_side_failures_are_unreachable` | `tests/claude_classify.rs` | HTTP 500–504 and 529 are `Unreachable` | Claude: 5xx and 529 are unreachable |
| `connection_errors_without_a_status_are_unreachable` | `tests/claude_classify.rs` | Connection-failure wordings without a status are `Unreachable` — **hypothesis** | Claude: connection wordings are unreachable |
| `unrecognised_errors_are_other` | `tests/claude_classify.rs` | 400, 401 and unknown wordings are `Other` (stop loudly) | Claude: other statuses stop; Claude: unknown wording stops |
| `output_that_is_not_the_expected_json_is_other` | `tests/claude_classify.rs` | Empty, non-JSON, object-shaped or result-less output is `Other` | — |
| `the_prompt_goes_on_stdin_and_the_answer_comes_back` | `tests/claude_process.rs` | The prompt reaches the child on stdin, whole and never on the command line; the classified answer comes back, tokens included | Claude process: prompt on stdin; Tokens: a Claude answer carries its usage; Tokens: Claude's cache reads are counted apart |
| `the_cli_runs_with_json_output_and_no_tools` | `tests/claude_process.rs` | The child gets `-p`, JSON verbose output, `--tools ""`, no MCP, no slash commands, no session persistence, the request's system prompt (through its file) and the model — and never `--bare` | Claude process: tools disabled; No user or project settings in the child |
| `a_schema_reaches_the_cli_as_json_schema` | `tests/claude_process.rs` | A schema reaches the CLI as `--json-schema`, and only then | Schema: claude gets --json-schema |
| `without_a_system_prompt_a_neutral_one_replaces_claude_codes_own` | `tests/claude_process.rs` | A system prompt is always passed, so Claude Code's agentic one is never used; no `--model` unless configured | — |
| `a_long_system_prompt_reaches_the_cli_whole_and_off_the_command_line` | `tests/claude_process.rs` | A 100 KB system prompt holding a NUL reaches the child whole through `--system-prompt-file`, and no part of it is on the command line (it failed the spawn as `Other`) | Claude process: system prompt whole in its file; Tokens: a Claude answer carries its usage; Tokens: Claude's cache reads are counted apart |
| `the_system_prompt_file_is_removed_once_the_cli_has_answered` | `tests/claude_process.rs` | The system prompt file is gone once the call returns | Claude process: system prompt file removed |
| `the_system_prompt_file_is_removed_when_the_cli_is_killed` | `tests/claude_process.rs` | The system prompt file is gone after a timeout kill too | Claude process: system prompt file removed |
| `concurrent_requests_each_get_their_own_system_prompt` | `tests/claude_process.rs` | Two overlapping requests in one working directory each get their own file and system prompt | Claude process: one system prompt file per request |
| `the_system_prompt_file_is_readable_by_its_owner_only` | `tests/claude_process.rs` | Unix only: the file is 0600 | System prompt file: owner only |
| `metered_credentials_never_reach_the_child` | `tests/claude_process.rs` | None of `METERED_ENV` reaches the child (checked by the child itself); `CLAUDE_CODE_OAUTH_TOKEN` and `PATH` do | Claude process: metered env removed |
| `the_metered_list_names_the_known_metered_switches` | `tests/claude_process.rs` | `METERED_ENV` names the API-key, auth-token, Bedrock and Vertex switches and not the subscription token | CLAUDE_CONFIG_DIR is scrubbed |
| `the_child_runs_in_the_dedicated_working_directory` | `tests/claude_process.rs` | The child's working directory is the dedicated one, created if missing | Claude process: dedicated workdir |
| `the_cli_writes_its_answer_into_a_file_not_a_pipe` | `tests/claude_process.rs` (Linux) | The CLI's stdout is a private file, never a pipe (the real CLI loses what it wrote past 128 KiB into a pipe on exit) | Claude: the answer goes to a file, not a pipe |
| `a_large_answer_arrives_whole` | `tests/claude_process.rs` | A 300 KB answer arrives whole | — |
| `a_missing_working_directory_is_created_private` | `tests/claude_process.rs` (Unix) | A missing working directory is created 0700 | — (the tightening step covers a looser create) |
| `a_working_directory_others_could_write_into_is_refused` | `tests/claude_process.rs` (Unix) | A 0777 working directory is `Other`, naming it, and the CLI never runs | Claude workdir: others cannot write into it |
| `a_working_directory_that_is_a_link_is_refused` | `tests/claude_process.rs` (Unix) | A symlink as working directory is `Other`, naming it, and the CLI never runs | Claude workdir: not a link |
| `a_readable_working_directory_of_ours_is_made_private` | `tests/claude_process.rs` (Unix) | A 0755 working directory of ours is tightened to 0700 | Claude workdir: left 0700 |
| `a_missing_binary_is_unreachable` | `tests/claude_process.rs` | A `claude` that does not exist is `Unreachable` (falls back) | Claude process: missing binary is unreachable |
| `a_cli_that_does_not_answer_in_time_is_killed_and_unreachable` | `tests/claude_process.rs` | A child still running at the timeout is killed within seconds and reported `Unreachable` | Claude process: timeout kills |
| `a_timed_out_cli_is_dead_not_abandoned` | `tests/claude_process.rs` | The timed-out child is dead: the fake never outlives its sleep to create its marker file | Claude process: the timed-out child is killed, not abandoned |
| `an_error_printed_by_the_cli_is_classified_like_the_captured_one` | `tests/claude_process.rs` | The observed not-logged-in output, printed by a child exiting 1, is `Other` with its message | — |
| `a_cli_that_prints_nothing_reports_its_stderr` | `tests/claude_process.rs` | A child that prints nothing on stdout yields `Other` carrying its stderr | Claude process: stderr reported |
| `a_fired_billing_tripwire_latches_even_across_a_restart` | `tests/claude_process.rs` | Once the billing tripwire fires, the backend never starts `claude` again, even after a restart | Billing latch: a latched backend does not start claude; Billing latch: set in memory when the tripwire fires; Billing latch: written down for a restart |
| `the_probe_says_up_and_whether_the_model_is_in_memory` | `tests/lm_studio.rs` | 8.43: the probe GETs `/v1/models` then `/api/v0/models`: listed and `loaded` is up and in memory, listed and `not-loaded` loads on demand, no `/api/v0` is up with memory unknown | Probe: loaded is the server's loaded state |
| `the_probe_says_down_and_why` | `tests/lm_studio.rs` | 8.43: a server that does not list the model, or no server at all, is down, naming the model | Probe: an unlisted model is down |
| `the_observed_success_is_an_answer` | `tests/lm_studio.rs` | The **observed** 200 body yields `choices[0].message.content` and its `usage` (`prompt_tokens` read, `completion_tokens` written) | Tokens: an LM Studio answer carries its usage; Tokens: LM Studio's output is completion_tokens |
| `the_request_is_a_chat_completion_without_any_credential` | `tests/lm_studio.rs` | `POST /v1/chat/completions` with model, `stream: false`, system then user messages, and **no** `Authorization`/`x-api-key`/`api-key` header | LM Studio: no credential header |
| `without_a_system_prompt_only_the_user_message_is_sent` | `tests/lm_studio.rs` | No system message is invented | — |
| `the_observed_no_models_loaded_is_unreachable` | `tests/lm_studio.rs` | The **observed** 400 "No models loaded" is `Unreachable` (server state, falls back) | LM Studio: no model loaded is unreachable |
| `a_refused_connection_is_unreachable` | `tests/lm_studio.rs` | Connection refused is `Unreachable` | LM Studio: transport failures are unreachable |
| `a_server_that_does_not_answer_in_time_is_unreachable` | `tests/lm_studio.rs` | A server silent past the timeout is `Unreachable` within seconds | LM Studio: timeout honoured; LM Studio: transport failures are unreachable |
| `status_429_is_quota_exceeded` | `tests/lm_studio.rs` | 429 is `QuotaExceeded` | LM Studio: 429 is quota |
| `gateway_statuses_are_unreachable` | `tests/lm_studio.rs` | 502, 503, 504 are `Unreachable` | LM Studio: gateway statuses are unreachable |
| `other_error_statuses_stop_with_the_servers_message` | `tests/lm_studio.rs` | 400 (other than no model), 401, 404, 500 are `Other` carrying LM Studio's message | LM Studio: other statuses stop |
| `a_success_without_an_answer_is_other` | `tests/lm_studio.rs` | A 2xx without an answer (empty choices, not JSON, no content) is `Other` | — |
| `a_success_without_an_answer_is_counted_not_quoted` | `tests/lm_studio.rs` | 8.41: a 2xx body without `choices[0].message.content` is given as a length in the error, never quoted | Journal: a 2xx without content is counted, not quoted |
| `an_error_body_without_a_message_is_counted_not_quoted` | `tests/lm_studio.rs` | 8.41: an error body without `error.message` is given as a length, never quoted | Journal: an error body without a message is counted, not quoted |
| `a_truncated_or_empty_answer_is_other` | `tests/lm_studio.rs` | An answer cut by the length limit, or empty, is `Other`, never a success | A truncated answer is not a success; An empty answer is not a success |
| `a_schema_request_sends_response_format_and_needs_json` | `tests/lm_studio.rs` | A schema goes as strict `json_schema` `response_format`; a non-JSON answer to it is `Other`; no schema, no `response_format` | Schema: lm-studio sends response_format; Schema: lm-studio's answer must be JSON |
| `two_requests_never_overlap_on_a_one_slot_backend` | `tests/lm_studio.rs` | Two slow requests at once: the second waits in the router, never on the one-slot server | LM Studio: one completion at a time on the server |
| `waiting_for_the_slot_past_the_timeout_is_unreachable` | `tests/lm_studio.rs` | A request still waiting for the slot at its timeout is `Unreachable` (falls back) and never reaches the server | LM Studio: one completion at a time on the server; LM Studio: waiting for the slot counts against the timeout |
| `a_two_slot_backend_lets_two_requests_overlap` | `tests/lm_studio.rs` | `max_concurrent = 2` lets two completions overlap | LM Studio: max_concurrent sets the slots |
| `a_configured_lm_studio_backend_keeps_one_slot` | `tests/lm_studio.rs` | A router built from a file without `max_concurrent` keeps one completion on the server | LM Studio: one completion at a time on the server; Config: lm-studio defaults to one slot; Config: the slot limit reaches the backend |
| `the_committed_example_parses` | `tests/config.rs` | `config.example.toml` stays a valid configuration | — |
| `backends_keep_their_order_and_settings` | `tests/config.rs` | Backends keep file order; settings and the 300 s default timeout are applied | — |
| `an_unknown_backend_kind_is_refused` | `tests/config.rs` | A kind outside `claude-code`/`lm-studio` (e.g. `anthropic-api`) is refused, naming it | — (closed enum: nothing to remove) |
| `a_credential_field_is_refused` | `tests/config.rs` | `api_key` or `authorization` in a backend is an error, not an ignored line | Config: credential fields refused |
| `a_configuration_without_backends_cannot_build_a_router` | `tests/config.rs` | An empty backend list is refused when building the router | — |
| `a_valid_configuration_builds_a_router` | `tests/config.rs` | The example configuration builds a router | — |
| `lm_studio_takes_one_completion_at_a_time_by_default` | `tests/config.rs` | `lm-studio` defaults to one slot, `max_concurrent` overrides it, `claude-code` has no limit | Config: lm-studio defaults to one slot |
| `max_concurrent_zero_or_on_claude_code_is_refused` | `tests/config.rs` | `max_concurrent = 0` cannot build a router; the field is unknown on `claude-code` | Config: max_concurrent = 0 is refused |
| `userinfo_in_a_base_url_is_refused_without_echoing_it` | `tests/config.rs` | A `base_url` with `user@` or `user:pass@` cannot build a router, and the error echoes neither; `@` in the path is fine | Config: userinfo in base_url is refused; Config: only the authority is checked for userinfo |
| `a_backend_may_be_named_and_names_are_unique` | `tests/config.rs` | A configured `name` is what requests and the journal use; two backends with one name cannot build a router | Config: backend names are unique; Config: a backend runs under its configured name |
| `serves_declares_the_kinds_and_none_is_refused` | `tests/config.rs` | `serves = ["classify"]` keeps generations away from a backend; `serves = []` cannot build a router | M2: a backend is tried only for the kinds it serves; M2: serves = [] is refused; M2: a configured backend declares its kinds |
| `complete_prints_the_answer_on_stdout_and_exits_0` | `tests/cli.rs` | The answer alone goes to stdout, the backend name to stderr, exit 0, one journal line | — |
| `a_spent_claude_plan_falls_back_to_lm_studio` | `tests/cli.rs` | **End to end**: Claude reports a usage limit, LM Studio answers, the journal records both | — |
| `a_stopped_request_exits_3_and_never_reaches_lm_studio` | `tests/cli.rs` | **End to end**: not logged in exits 3 and LM Studio's listener sees no connection | CLI: stopped exits 3 |
| `every_backend_down_exits_4` | `tests/cli.rs` | Missing `claude` and refused LM Studio exit 4, journaled `exhausted` | — |
| `the_system_option_reaches_the_backend` | `tests/cli.rs` | `--system` reaches `claude` through its system prompt file | — |
| `a_relative_workdir_still_hands_claude_its_system_prompt` | `tests/cli.rs` | With a relative `workdir`, the file's path stays valid inside the child's working directory (passed absolute) | Claude process: system prompt file path absolute |
| `the_config_path_can_come_from_the_environment` | `tests/cli.rs` | `ITSARESUME_CONFIG` names the configuration | — |
| `a_bad_configuration_or_usage_exits_2` | `tests/cli.rs` | An invalid configuration or command line exits 2 with the reason | — |
| `the_backend_option_picks_one_backend` | `tests/cli.rs` | `--backend` tries that backend alone; an unknown name exits 2 listing the names | Named backend: only that one is tried; Named backend: found by its name; CLI: --backend is read |
| `the_schema_option_reaches_the_cli_as_json_schema` | `tests/cli.rs` | `--schema FILE` reaches the CLI as `--json-schema`; the answer is the structured JSON | CLI: --schema is read; CLI: the schema reaches the request |
| `the_stats_command_sums_up_the_journal` | `tests/cli.rs` | `itsaresume stats` prints the summary of the configured journal and appends nothing | CLI: stats reads the journal |
| `the_stats_by_day_option_prints_one_line_per_day` | `tests/cli.rs` | `stats --by-day` prints one line per day | CLI: --by-day is read |
| `the_kind_option_reaches_a_classify_only_backend` | `tests/cli.rs` | `--kind classify` reaches a classify-only backend; no flag (a generation) exits 2 naming the kind; an unknown kind exits 2 | CLI: --kind classify is read; CLI: the kind reaches the request |
| `a_schema_file_that_is_not_an_object_is_a_usage_error` | `tests/cli.rs` | A schema file that is not a JSON object exits 2 naming it, before any backend runs | CLI: a schema file must hold an object |
| `an_empty_prompt_is_a_usage_error` | `tests/cli.rs` | A blank prompt exits 2 without calling any backend | CLI: empty prompt refused |
| `a_fired_billing_tripwire_stops_the_next_process_too` | `tests/cli.rs` | A tripwire fired in one `itsaresume` process stops the next one (latch file beside the journal) | Billing latch: a latched backend does not start claude; Billing latch: beside the journal; Billing latch: written down for a restart |
| `an_overage_answer_latches_the_next_process_too` | `tests/cli.rs` | An overage answer exits 3 saying so, writes the latch, and the next process stops before claude runs | Claude: overage trips the billing wire; Claude: overage refusal latches |
| `a_proxy_in_the_environment_is_never_used` | `tests/cli.rs` | `HTTP(S)_PROXY` in the environment never carries a request to LM Studio | No proxy from the environment |
| `a_completion_returns_the_text_the_backend_and_the_failed_attempts` | `tests/server.rs` | 200 carries the text, the answering backend and the failed attempts | — |
| `an_answer_reports_its_tokens` | `tests/server.rs` | 8.39: 200 carries the backend's `usage`, each count under its own name; a backend reporting none, no `usage` key | Tokens: the HTTP answer reports them; Tokens: the journal writes each count under its own name; Tokens: the router hands the usage on |
| `a_stopped_request_is_502_with_the_reason` | `tests/server.rs` | A stop (`Other`) is 502 with kind `stopped`, the backend and its message | Server: stopped is 502 |
| `an_exhausted_request_is_503` | `tests/server.rs` | Every backend failing with a fallback kind is 503 `exhausted` with the attempts | — |
| `a_malformed_request_is_400` | `tests/server.rs` | Non-JSON, missing/blank/non-string prompt, non-string system are 400 | Server: blank prompt is 400 |
| `a_request_may_name_its_backend` | `tests/server.rs` | `"backend"` picks the one backend; unknown is 400 listing the names; a non-string is 400 | Named backend: only that one is tried; Named backend: found by its name; Server: the request's backend is read |
| `a_schema_must_be_an_object` | `tests/server.rs` | `"schema"` that is not an object is 400; an object is served | Schema: the endpoint refuses a non-object |
| `the_schema_reaches_the_backend` | `tests/server.rs` | The endpoint passes the schema to the backend, and none when absent | Schema: the endpoint passes it on |
| `the_contract_answer_has_exactly_the_frozen_keys` | `tests/server.rs` | 8.37: a request with every contract field is served, and the 200 answer has exactly the frozen keys, `contract` "1.0" | Contract: every answer is stamped; Contract: a completion carries no unfrozen key |
| `the_contract_stamps_every_answer` | `tests/server.rs` | 8.37: a 502, a 400 and `/healthz` carry `contract` "1.0"; a stop has exactly `contract` and `error` | Contract: every answer is stamped |
| `the_status_says_each_backend_state_without_spending_a_request` | `tests/server.rs` | 8.43: `GET /status` names each backend with its kind and state: `unknown` before any request, `limited` after a quota (with `since`), `up` after an answer, `stopped` after another error, and a probe's `down` with its reason, before the last answer | Status: a probe's down is down; Status: a quota is limited; Status: a success is remembered |
| `the_status_carries_the_usage_level_of_the_last_answer` | `tests/server.rs` | 8.44: after an answer whose rate limit says `allowed_warning`, `/status` gives that backend `usage` "allowed_warning"; a backend that reported none has no `usage` | Status: the usage level is the rate limit's status |
| `the_contract_freezes_the_keys_of_every_refusal` | `tests/server.rs` | 8.42: the 503 `exhausted`, 400 `bad_request` and 400 `unserved` refusals have exactly `contract` and `error`, and their `error` exactly its frozen keys | Contract: an exhausted refusal carries no unfrozen key; Contract: a bad request carries no unfrozen key |
| `a_request_kind_is_generate_or_classify` | `tests/server.rs` | `"kind"` is `generate` or `classify`; anything else is 400 | M2: the endpoint reads the kind |
| `an_oversized_request_is_413` | `tests/server.rs` | A body over 1 MiB is 413 | Server: oversized is 413 |
| `health_and_unknown_paths` | `tests/server.rs` | `/healthz` 200, unknown path 404, wrong method 405 | — |
| `a_slow_completion_does_not_block_other_requests` | `tests/server.rs` | A health check answers in under 1 s while a 3 s completion runs | Server: one thread per request |
| `completions_beyond_the_cap_are_503_busy` | `tests/server.rs` | Completions beyond the concurrency cap are refused 503 `busy` at once | Endpoint caps concurrent completions |
| `a_huge_declared_body_is_413_and_the_server_lives` | `tests/server.rs` | A huge declared `Content-Length` is 413 without being read, and the server still answers | Endpoint never drains a huge declared body |
| `a_completion_from_a_browser_origin_is_403` | `tests/server.rs` | A completion carrying an `Origin` header is 403 | Endpoint refuses browser origins |
| `a_foreign_host_is_403_and_loopback_names_are_served` | `tests/server.rs` | A `Host` other than a loopback name is 403 (DNS rebinding) | Endpoint serves loopback host names only |
| `a_completion_that_is_not_json_is_415` | `tests/server.rs` | A completion whose `Content-Type` is not JSON is 415 | Endpoint takes JSON only |
| `the_serve_loop_returns_the_error_that_ended_it` | `tests/server.rs` | The serve loop returns the error that ends it instead of returning as if all went well | Serve loop returns the error that ends it |
| `the_default_listen_address_is_loopback` | `tests/server.rs` | The default listen address is loopback (no authentication on the endpoint) | Server: loopback by default |
| `the_serve_command_answers_on_the_given_address` | `tests/server.rs` | `itsaresume serve --listen` as a process answers `/healthz` | — |
| `a_named_backend_is_found_by_its_kind_too` | `tests/config.rs` | A backend configured as `bionic` is also found as `lm-studio`: the cv page asks by kind, the VM names its backends | Named backend: found by its kind too; Named backend: a configured name keeps its kind |
| `the_committed_docker_example_parses` | `tests/config.rs` | `docker/config.example.toml` stays valid and journals into the mounted directory | — |
| `scripts/docker-smoke.sh` (CI job `docker`) | — | The image holds the pinned `claude` CLI and not the test double; `/healthz` answers; a real request through the **real** CLI with a bogus `ANTHROPIC_API_KEY` on the container returns 502 "Not logged in" — proving the key is stripped and the stop does not fall back | — (the script states what each other outcome would mean) |
| `a_green_pr_is_merged_pinned_to_its_head` | `scripts/test-merge-when-green.sh` | Twelve passing checks: the merge names the head it counted (`--match-head-commit`) | Merge: pinned to the counted head |
| `a_pending_check_stops_the_merge` | `scripts/test-merge-when-green.sh` | One pending check among passing ones: no merge | Merge: every check must pass |
| `too_few_checks_stop_the_merge` | `scripts/test-merge-when-green.sh` | One passing check out of a suite of twelve: no merge | Merge: the suite's minimum of checks |
| `the_head_is_read_before_the_checks` | `scripts/test-merge-when-green.sh` | A push while the checks are counted: the merge names the head read before, so GitHub refuses it | Merge: pinned to the counted head |
| `a_job_skipped_by_the_changes_job_is_no_failure` | `scripts/test-merge-when-green.sh` | One workflow filtered by path (2026-10-06): jobs skipped once `changes` passed do not stop the merge | Merge: a decided skip is no failure |
| `a_skip_without_the_changes_job_stops_the_merge` | `scripts/test-merge-when-green.sh` | A skip with no passing `changes` job is still not green: no merge | Merge: a skip counts only once changes passed |
| `a_cv_change_runs_only_cv` | `scripts/test-ci-changes.sh` | A change under `cv/` runs the generator group only | CI changes: the generator is cv/ |
| `a_crate_change_runs_only_rust` | `scripts/test-ci-changes.sh` | A change to the router runs the router group only | CI changes: the rest is the router |
| `a_docs_change_runs_neither` | `scripts/test-ci-changes.sh` | A change to `docs/` or a top-level `.md` runs neither group (the handover job always runs) | CI changes: docs run neither group |
| `a_workflow_change_runs_both` | `scripts/test-ci-changes.sh` | A change to a workflow runs both groups | CI changes: a workflow change runs both |
| `an_unknown_base_runs_both` | `scripts/test-ci-changes.sh` | No base sha: both groups (an empty base would diff HEAD with itself) | CI changes: an empty base runs both |
| `a_new_branch_runs_both` | `scripts/test-ci-changes.sh` | A new branch (base all zeros): both groups | CI changes: a base git cannot diff runs both |
| `a_base_git_cannot_diff_runs_both` | `scripts/test-ci-changes.sh` | A base git does not know: both groups | CI changes: a base git cannot diff runs both |
| `a_matrix_job_skipped_at_job_level_is_refused` | `scripts/test-check-workflow.sh` | A matrix job with a job-level `if` is refused: skipped, it reports one unexpanded name and the required per-OS checks never come (#85) | Workflow: a matrix job is never skipped at job level |
| `step_conditions_and_plain_job_skips_pass` | `scripts/test-check-workflow.sh` | The same job with the condition on its steps, and a plain job skipped at job level, pass | Workflow: only a job-level if counts |
| `a_new_commit_is_pulled_and_deployed` | `cv/deploy/vm-generator/test-auto-deploy.sh` | cv 3.5: a new commit on origin/main is fast-forwarded on the VM's checkout, then `docker compose ... up -d --build` runs | Auto-deploy: a new commit is deployed |
| `nothing_new_deploys_nothing` | `cv/deploy/vm-generator/test-auto-deploy.sh` | Nothing new since the last deploy: docker is not called | — |
| `a_failed_build_is_retried` | `cv/deploy/vm-generator/test-auto-deploy.sh` | A failed compose is an error and is not recorded: the next run builds again | Auto-deploy: a new commit is deployed; Auto-deploy: a failed build is not recorded as deployed |
| `local_changes_stop_the_deploy` | `cv/deploy/vm-generator/test-auto-deploy.sh` | A local edit on the VM, even in a file origin did not touch: refused, kept, no docker | Auto-deploy: local changes stop it |
| `a_diverged_checkout_is_not_merged` | `cv/deploy/vm-generator/test-auto-deploy.sh` | A local commit origin does not have: never merged, no docker (held twice: the ahead check and `--ff-only`, so no single sabotage turns it red) | — |
| `an_unpushed_commit_is_not_deployed` | `cv/deploy/vm-generator/test-auto-deploy.sh` | Redteam: a local commit and nothing new upstream (a fast-forward that succeeds as a no-op): never built | Auto-deploy: a commit origin lacks is never built |
| `a_busy_generator_defers_the_deploy` | `cv/deploy/vm-generator/test-auto-deploy.sh` | Redteam: the generator's status says `busy` > 0: the deploy waits (exit 0, no docker); idle, it deploys | Auto-deploy: a busy generator defers it |
| `another_branch_is_not_deployed` | `cv/deploy/vm-generator/test-auto-deploy.sh` | A checkout on another branch than main: refused | Auto-deploy: main only |
