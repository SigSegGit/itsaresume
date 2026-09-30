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
| `a_schema_answer_is_its_structured_output` | `tests/claude_classify.rs` | With a schema, the answer is `structured_output` (observed on 2.1.162: `result` is empty) | Schema: claude's answer is structured_output |
| `the_structured_output_tool_without_a_schema_is_refused` | `tests/claude_classify.rs` | `StructuredOutput` in init without a schema asked for trips the tool tripwire | Schema: StructuredOutput only with a schema |
| `another_tool_beside_structured_output_is_refused` | `tests/claude_classify.rs` | With a schema, any tool beside `StructuredOutput` still trips it | Schema: StructuredOutput alone |
| `a_schema_answer_without_structured_output_is_other` | `tests/claude_classify.rs` | A schema request answered without `structured_output` is `Other` | Schema: claude's answer is structured_output |
| `the_synthetic_usage_limit_is_quota_exceeded` | `tests/claude_classify.rs` | The synthetic usage-limit output (429) is `QuotaExceeded` — **hypothesis** | Claude: HTTP 429 is quota |
| `status_429_is_quota_exceeded_whatever_the_message` | `tests/claude_classify.rs` | HTTP 429 alone makes `QuotaExceeded` | Claude: HTTP 429 is quota |
| `usage_limit_wordings_without_a_status_are_quota_exceeded` | `tests/claude_classify.rs` | Known plan-limit wordings without a status are `QuotaExceeded` — **hypothesis**, not observed | Claude: wording 'usage limit'; Claude: wording 'limit reached'; Claude: wording 'hit your ... limit' |
| `context_and_login_errors_are_not_mistaken_for_quota` | `tests/claude_classify.rs` | Context-length and login errors mentioning a limit stay `Other` | Claude: context errors are not quota |
| `server_side_failures_are_unreachable` | `tests/claude_classify.rs` | HTTP 500–504 and 529 are `Unreachable` | Claude: 5xx and 529 are unreachable |
| `connection_errors_without_a_status_are_unreachable` | `tests/claude_classify.rs` | Connection-failure wordings without a status are `Unreachable` — **hypothesis** | Claude: connection wordings are unreachable |
| `unrecognised_errors_are_other` | `tests/claude_classify.rs` | 400, 401 and unknown wordings are `Other` (stop loudly) | Claude: other statuses stop; Claude: unknown wording stops |
| `output_that_is_not_the_expected_json_is_other` | `tests/claude_classify.rs` | Empty, non-JSON, object-shaped or result-less output is `Other` | — |
| `the_prompt_goes_on_stdin_and_the_answer_comes_back` | `tests/claude_process.rs` | The prompt reaches the child on stdin, whole and never on the command line; the classified answer comes back | Claude process: prompt on stdin |
| `the_cli_runs_with_json_output_and_no_tools` | `tests/claude_process.rs` | The child gets `-p`, JSON verbose output, `--tools ""`, no MCP, no slash commands, no session persistence, the request's system prompt (through its file) and the model — and never `--bare` | Claude process: tools disabled; No user or project settings in the child |
| `a_schema_reaches_the_cli_as_json_schema` | `tests/claude_process.rs` | A schema reaches the CLI as `--json-schema`, and only then | Schema: claude gets --json-schema |
| `without_a_system_prompt_a_neutral_one_replaces_claude_codes_own` | `tests/claude_process.rs` | A system prompt is always passed, so Claude Code's agentic one is never used; no `--model` unless configured | — |
| `a_long_system_prompt_reaches_the_cli_whole_and_off_the_command_line` | `tests/claude_process.rs` | A 100 KB system prompt holding a NUL reaches the child whole through `--system-prompt-file`, and no part of it is on the command line (it failed the spawn as `Other`) | Claude process: system prompt whole in its file |
| `the_system_prompt_file_is_removed_once_the_cli_has_answered` | `tests/claude_process.rs` | The system prompt file is gone once the call returns | Claude process: system prompt file removed |
| `the_system_prompt_file_is_removed_when_the_cli_is_killed` | `tests/claude_process.rs` | The system prompt file is gone after a timeout kill too | Claude process: system prompt file removed |
| `concurrent_requests_each_get_their_own_system_prompt` | `tests/claude_process.rs` | Two overlapping requests in one working directory each get their own file and system prompt | Claude process: one system prompt file per request |
| `the_system_prompt_file_is_readable_by_its_owner_only` | `tests/claude_process.rs` | Unix only: the file is 0600 | System prompt file: owner only |
| `metered_credentials_never_reach_the_child` | `tests/claude_process.rs` | None of `METERED_ENV` reaches the child (checked by the child itself); `CLAUDE_CODE_OAUTH_TOKEN` and `PATH` do | Claude process: metered env removed |
| `the_metered_list_names_the_known_metered_switches` | `tests/claude_process.rs` | `METERED_ENV` names the API-key, auth-token, Bedrock and Vertex switches and not the subscription token | CLAUDE_CONFIG_DIR is scrubbed |
| `the_child_runs_in_the_dedicated_working_directory` | `tests/claude_process.rs` | The child's working directory is the dedicated one, created if missing | Claude process: dedicated workdir |
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
| `the_observed_success_is_an_answer` | `tests/lm_studio.rs` | The **observed** 200 body yields `choices[0].message.content` | — |
| `the_request_is_a_chat_completion_without_any_credential` | `tests/lm_studio.rs` | `POST /v1/chat/completions` with model, `stream: false`, system then user messages, and **no** `Authorization`/`x-api-key`/`api-key` header | LM Studio: no credential header |
| `without_a_system_prompt_only_the_user_message_is_sent` | `tests/lm_studio.rs` | No system message is invented | — |
| `the_observed_no_models_loaded_is_unreachable` | `tests/lm_studio.rs` | The **observed** 400 "No models loaded" is `Unreachable` (server state, falls back) | LM Studio: no model loaded is unreachable |
| `a_refused_connection_is_unreachable` | `tests/lm_studio.rs` | Connection refused is `Unreachable` | LM Studio: transport failures are unreachable |
| `a_server_that_does_not_answer_in_time_is_unreachable` | `tests/lm_studio.rs` | A server silent past the timeout is `Unreachable` within seconds | LM Studio: timeout honoured; LM Studio: transport failures are unreachable |
| `status_429_is_quota_exceeded` | `tests/lm_studio.rs` | 429 is `QuotaExceeded` | LM Studio: 429 is quota |
| `gateway_statuses_are_unreachable` | `tests/lm_studio.rs` | 502, 503, 504 are `Unreachable` | LM Studio: gateway statuses are unreachable |
| `other_error_statuses_stop_with_the_servers_message` | `tests/lm_studio.rs` | 400 (other than no model), 401, 404, 500 are `Other` carrying LM Studio's message | LM Studio: other statuses stop |
| `a_success_without_an_answer_is_other` | `tests/lm_studio.rs` | A 2xx without an answer (empty choices, not JSON, no content) is `Other` | — |
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
| `complete_prints_the_answer_on_stdout_and_exits_0` | `tests/cli.rs` | The answer alone goes to stdout, the backend name to stderr, exit 0, one journal line | — |
| `a_spent_claude_plan_falls_back_to_lm_studio` | `tests/cli.rs` | **End to end**: Claude reports a usage limit, LM Studio answers, the journal records both | — |
| `a_stopped_request_exits_3_and_never_reaches_lm_studio` | `tests/cli.rs` | **End to end**: not logged in exits 3 and LM Studio's listener sees no connection | CLI: stopped exits 3 |
| `every_backend_down_exits_4` | `tests/cli.rs` | Missing `claude` and refused LM Studio exit 4, journaled `exhausted` | — |
| `the_system_option_reaches_the_backend` | `tests/cli.rs` | `--system` reaches `claude` through its system prompt file | — |
| `a_relative_workdir_still_hands_claude_its_system_prompt` | `tests/cli.rs` | With a relative `workdir`, the file's path stays valid inside the child's working directory (passed absolute) | Claude process: system prompt file path absolute |
| `the_config_path_can_come_from_the_environment` | `tests/cli.rs` | `ITSARESUME_CONFIG` names the configuration | — |
| `a_bad_configuration_or_usage_exits_2` | `tests/cli.rs` | An invalid configuration or command line exits 2 with the reason | — |
| `the_backend_option_picks_one_backend` | `tests/cli.rs` | `--backend` tries that backend alone; an unknown name exits 2 listing the names | Named backend: only that one is tried; Named backend: found by its name; CLI: --backend is read |
| `an_empty_prompt_is_a_usage_error` | `tests/cli.rs` | A blank prompt exits 2 without calling any backend | CLI: empty prompt refused |
| `a_fired_billing_tripwire_stops_the_next_process_too` | `tests/cli.rs` | A tripwire fired in one `itsaresume` process stops the next one (latch file beside the journal) | Billing latch: a latched backend does not start claude; Billing latch: beside the journal; Billing latch: written down for a restart |
| `a_proxy_in_the_environment_is_never_used` | `tests/cli.rs` | `HTTP(S)_PROXY` in the environment never carries a request to LM Studio | No proxy from the environment |
| `a_completion_returns_the_text_the_backend_and_the_failed_attempts` | `tests/server.rs` | 200 carries the text, the answering backend and the failed attempts | — |
| `a_stopped_request_is_502_with_the_reason` | `tests/server.rs` | A stop (`Other`) is 502 with kind `stopped`, the backend and its message | Server: stopped is 502 |
| `an_exhausted_request_is_503` | `tests/server.rs` | Every backend failing with a fallback kind is 503 `exhausted` with the attempts | — |
| `a_malformed_request_is_400` | `tests/server.rs` | Non-JSON, missing/blank/non-string prompt, non-string system are 400 | Server: blank prompt is 400 |
| `a_request_may_name_its_backend` | `tests/server.rs` | `"backend"` picks the one backend; unknown is 400 listing the names; a non-string is 400 | Named backend: only that one is tried; Named backend: found by its name; Server: the request's backend is read |
| `a_schema_must_be_an_object` | `tests/server.rs` | `"schema"` that is not an object is 400; an object is served | Schema: the endpoint refuses a non-object |
| `the_schema_reaches_the_backend` | `tests/server.rs` | The endpoint passes the schema to the backend, and none when absent | Schema: the endpoint passes it on |
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
| `the_committed_docker_example_parses` | `tests/config.rs` | `docker/config.example.toml` stays valid and journals into the mounted directory | — |
| `scripts/docker-smoke.sh` (CI job `docker`) | — | The image holds the pinned `claude` CLI and not the test double; `/healthz` answers; a real request through the **real** CLI with a bogus `ANTHROPIC_API_KEY` on the container returns 502 "Not logged in" — proving the key is stripped and the stop does not fall back | — (the script states what each other outcome would mean) |
| `a_green_pr_is_merged_pinned_to_its_head` | `scripts/test-merge-when-green.sh` | Twelve passing checks: the merge names the head it counted (`--match-head-commit`) | Merge: pinned to the counted head |
| `a_pending_check_stops_the_merge` | `scripts/test-merge-when-green.sh` | One pending check among passing ones: no merge | Merge: every check must pass |
| `too_few_checks_stop_the_merge` | `scripts/test-merge-when-green.sh` | One passing check out of a suite of twelve: no merge | Merge: the suite's minimum of checks |
| `the_head_is_read_before_the_checks` | `scripts/test-merge-when-green.sh` | A push while the checks are counted: the merge names the head read before, so GitHub refuses it | Merge: pinned to the counted head |
