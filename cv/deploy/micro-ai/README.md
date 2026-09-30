# micro-ai

A small local model for small tasks, on a CPU-only ARM board (Raspberry Pi 4,
the Freebox VM): classify a line, find the equivalents of a term in a list,
answer a basic question from a simple web search. Everything else (the CV,
the score, the layout) is fixed code; the model only reads text and compares.

| Piece | What |
|---|---|
| `llm` | `ghcr.io/ggml-org/llama.cpp:server`, OpenAI-compatible, one slot; `127.0.0.1:8096` |
| `ask` | `gateway/ask.py`, Python standard library, on `python:3.13-alpine`; `127.0.0.1:8095` |
| model | `Qwen2.5-1.5B-Instruct` in `Q4_0` (1.0 GB): Q4_0 is repacked by llama.cpp for NEON, the fastest on a Cortex-A72 without dot-product instructions |

```sh
mkdir -p models && curl -L -o models/model.gguf \
  https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_0.gguf
THREADS=4 docker compose up -d
sh bench.sh
```

Guarantees, from the gateway, not the model:
- the model has no tool; the web search is done by the gateway, by keywords
  (the question's proper nouns, or `search`), from Wikipedia's summary and the
  French company register's open API, and handed over as fenced data;
- `/equivalences` and `/classify` answers are constrained by a JSON schema to
  the given candidates and labels, then checked again: nothing outside them;
- requests are bounded (question 500 characters, 100 candidates, 10 labels,
  64 KB); nothing listens beyond 127.0.0.1.

The router can use `llm` as an `lm-studio` backend (`base_url =
"http://127.0.0.1:8096/v1"`). Measured throughput: `bench.txt` on each
machine, and ARCHITECTURE ADR-9.
