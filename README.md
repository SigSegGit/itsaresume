# itsaresume

An inference router written in Rust. It sends a prompt to the first backend
that can answer it, among backends that are **never billed per token**:

1. **Claude Code**, driven as a subprocess and paid for by a Claude Pro/Max
   subscription — never by an API key.
2. **LM Studio** on a local GPU machine, reached over Tailscale through its
   OpenAI-compatible API.
3. **A small local model** on a Raspberry Pi or a small VM, for light sorting
   and classification only — never for long text *(milestone M2, not built)*.

It exists to feed a separate CV generator (Node.js). itsaresume produces text
and nothing else: it never builds a document.

Status, plan and design live in [`docs/`](docs/):

| Document | What it answers |
|---|---|
| [ROADMAP.md](docs/ROADMAP.md) | What is done, what is next, in which order |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How a request flows and why a failure falls back or stops |
| [TESTING.md](docs/TESTING.md) | Every test, and the property it proves |
| [HANDOVER.md](docs/HANDOVER.md) | Where to resume work, and the decisions that must not move |

Licence: [AGPL-3.0-or-later](LICENSE).
