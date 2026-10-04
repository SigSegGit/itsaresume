# itsaresume

An inference router written in Rust. It sends a prompt to the first backend
that can answer it, among backends that are **never billed per token**:

1. **Claude Code**, driven as a subprocess and paid for by a Claude Pro/Max
   subscription — never by an API key.
2. **LM Studio** on a local GPU machine, reached over Tailscale through its
   OpenAI-compatible API.
3. **A small local model** on a Raspberry Pi or a small VM, for light sorting
   and classification only — never for long text *(M2: the router side is
   built, `kind` and `serves`; the runtime and model are not chosen)*.

"Never billed per token" is enforced, not assumed: no backend has a
credential field, metered variables are removed before `claude` runs, and
tripwires refuse an answer the CLI reports as API-key billed or as extra
usage (overage), then latch so no further request is sent. The overage
tripwire acts **after** the call that reported it: that one was already
billed. Keep extra usage off on the account; the tripwire is a detector,
not a prevention.

It exists to feed the CV generator in [`cv/`](cv/README.md) (Node.js): an
offer in, a one-page CV and an honest qualification report out, every
decision that data can settle taken by code rather than by the model. The
router produces text and nothing else: it never builds a document.

## Run it

With Docker (the router and the `claude` CLI in one image):

```
cp docker/config.example.toml docker/config.local.toml   # LM Studio URL, model id
cp .env.example .env                                      # CLAUDE_CODE_OAUTH_TOKEN
mkdir -p journal                                          # before Docker creates it root-owned
docker compose up -d
curl -s http://127.0.0.1:8787/v1/complete -H 'Content-Type: application/json' \
     -d '{"prompt": "Write a one-line profile summary for a senior SRE."}'
```

`CLAUDE_CODE_OAUTH_TOKEN` is the subscription token printed by
`claude setup-token` — not an API key. Without it, requests stop with
"Not logged in" (HTTP 502) rather than silently going to LM Studio: see
[why](docs/ARCHITECTURE.md#error-kinds-and-why-other-never-falls-back-).

Without Docker: `cargo build --release`, copy `config.example.toml` to
`config.local.toml`, then `echo "prompt" | target/release/itsaresume complete`
or `target/release/itsaresume serve`.

A request may name one configured backend (`--backend NAME`, or `"backend"`
in `POST /v1/complete`): only that one is tried, no fallback. It may ask for
structured output (`--schema FILE`, or `"schema"`: a JSON Schema object):
the answer is then a JSON document following it, or the request fails.
A request has a kind (`--kind`, or `"kind"`: `generate` by default, or
`classify`), and a backend may serve only some kinds (`serves` in the
configuration): a small model never gets a generation.
`itsaresume stats` sums the journal up: per backend and outcome, the
fallbacks, the share of structured requests, and the tokens each backend
reported (read, from cache, written), so Claude's and the local model's are
read apart.

The endpoint has no authentication and spends the plan of whoever's token it
holds: it listens on `127.0.0.1` only, in and out of Docker.

Status, plan and design live in [`docs/`](docs/):

| Document | What it answers |
|---|---|
| [ROADMAP.md](docs/ROADMAP.md) | What is done, what is next, in which order |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How a request flows and why a failure falls back or stops |
| [TESTING.md](docs/TESTING.md) | Every test, and the property it proves |
| [HANDOVER.md](docs/HANDOVER.md) | Where to resume work, and the decisions that must not move |

Licence: [AGPL-3.0-or-later](LICENSE).
