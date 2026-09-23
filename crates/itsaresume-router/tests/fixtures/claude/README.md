# Claude Code CLI output fixtures

What `claude -p … --output-format json` prints, used as test input for the
classifier in `src/claude_code.rs`. Two kinds, and the name says which:

- **`observed-*`** — captured on 2026-09-23 on Nicolas's laptop (Windows 11,
  Claude Code **2.1.162**). Real output, redacted before commit: `cwd`,
  `memory_paths`, `agents`, `plugins`, `skills` and `slash_commands` removed
  (they carry local paths and plugin names); `session_id`, `uuid` and message
  `id` replaced by `REDACTED`. Nothing else was changed.
- **`synthetic-*`** — **built by hand** from an observed file, changing only
  the fields named below. They encode a *hypothesis* about output nobody has
  seen yet on this machine, and each one is to be replaced by an observed
  capture as soon as one exists (docs/HANDOVER.md §4, §9).

| File | Command | What it shows |
|---|---|---|
| `observed-not-logged-in.json` | `claude -p test --output-format json` | CLI not logged in: exit 1, **`subtype: "success"` with `is_error: true`**, `api_error_status: null` |
| `observed-not-logged-in.verbose.json` | the backend's real flag set, prompt on stdin | Same failure, as an array: `system/init` (with `apiKeySource: "none"`, `tools: []`, `mcp_servers: []`), a synthetic assistant message, then `result` |
| `observed-api-key-invalid.verbose.json` | `ANTHROPIC_API_KEY=<bogus>`, verbose, **default tools** | `apiKeySource: "ANTHROPIC_API_KEY"`, 32 tools, ten `system/api_retry` (401) over 183 s, then `api_error_status: 401` |
| `synthetic-success.verbose.json` | — | From `observed-not-logged-in.verbose.json`: `is_error: false`, `result` text, assistant content, usage counts |
| `synthetic-usage-limit.verbose.json` | — | Same base: `is_error: true`, `api_error_status: 429`, a limit message |
| `synthetic-overloaded.verbose.json` | — | Same base: `is_error: true`, `api_error_status: 529` |
