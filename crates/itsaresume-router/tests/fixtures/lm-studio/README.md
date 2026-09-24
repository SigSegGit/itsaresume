# LM Studio fixtures

Response bodies of LM Studio's OpenAI-compatible server, **observed** on
2026-09-23 on Nicolas's laptop (LM Studio server on `127.0.0.1:54321`, model
`qwen2.5-7b-instruct-1m`). Redacted: the completion `id`, and the answer text
replaced by `Hello!`.

| File | Request | Status |
|---|---|---|
| `observed-success.json` | chat completion, model loaded | 200 |
| `observed-no-models-loaded.json` | chat completion, server up, no model loaded (any `model`, or none) | **400** `invalid_request_error` |
| `observed-invalid-json.json` | a body that is not JSON | 400 `invalid_json` |

Also observed, not captured as a file: with a model loaded, a **nonexistent**
model id is ignored and the loaded model answers; an id that exists but is not
loaded makes LM Studio load it first (over 60 s for a 30B model).
