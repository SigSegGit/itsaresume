# itsaresume-cv

Tailor a CV to a job offer — and prove it does not lie.

Paste an offer (or an agency email holding several), get for each one a CV in
the owner's own two-column design, filled to exactly one page, exported to a
tagged PDF an ATS can read, and a fit report: qualified or not, which
requirement each skill covers, what backs every claim, and what is missing.

It runs on the owner's machine. The language model is reached through
[itsaresume](https://github.com/SigSegGit/itsaresume), a Rust router that is
never billed per token: Claude through the Claude Code subscription first, a
local model on the owner's laptop (any OpenAI-compatible server; today Bionic
serving `qwen3-coder-next`) when that is unavailable.

## Why it can be trusted

A model that writes CVs will happily invent. Here **the model selects, the code
decides**:

- The model only picks ids from the profile; every id is checked. When the
  profile lists titles and hooks (the owner's does), even the headline and
  the summary are chosen by id among them: the CV then holds no word the
  model wrote.
- Every line the CV can show traces, word for word, to the owner's own profile
  document; the tool refuses to run otherwise.
- Tools stay attached to the mission where they were used; lab skills stay in
  R&D and say so; what the owner never claims is never written and always
  counted as a gap.
- The score and the qualification are computed from the requirements, not
  taken from the model.
- The offer is treated as hostile: its text is fenced, and the model's free
  text is refused if it carries a link, contact details, markup, the offer's
  own sentences or names, or a number the profile does not hold.
- Each of those rules has a test proven to fail when the rule is broken
  (sabotage verification). That proves the tests bite, not that no other
  attack exists: two red-team passes found and fixed 13 traceable attacks
  (issues #6–#13, and five more in commit 44f289f), and the known residual
  risks are listed in the architecture document. What is not measured yet:
  requirement-extraction recall on a labelled corpus of offers.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Where things are

```
bin/itsacv.js      the command line: tailor, split, serve
src/               the generator, one module per concern (table in docs/ARCHITECTURE.md)
  run.js             one offer end to end: model calls, checks, CV, report
  llm.js             the only model client: HTTP to the itsaresume router
  split.js           one email holding several offers → one text per offer
  listing.js, prompt.js   the two prompts: list the offer's requirements, then analyse
  pipeline.js        listing → analysis → normalisation → validation, one retry
  normalize.js       what the code decides after the model: matches, qualities, examples
  score.js           the score and the qualification, from the requirement table
  text.js, language.js   canonical text and word matching; the offer's language
  lexicon.js         offer words ↔ the owner's skills through shared concepts (ESCO), FR and EN
  guard.js, evidence.js, analysis.js   what the model may not say, and the proofs
  profile.js         the profile's shape and the owner's v4 rules
  tailor.js, render.js, fit.js, word.js, ats.js   the CV: placement, docx, one page, PDF, ATS check
  report.js          the fit report
  server.js, serve.js, view.js, intake.js   the web page, local or public
web/               the page itself: index.html, app.js, style.css (no build)
data/esco.json     ESCO concepts (ICT, computers, transversal), FR/EN labels, built by tools/esco.py
templates/         the owner's two-column Word design, holding tags only
tools/             word.ps1 (Word through COM), pdftext.py (PDF read-back), esco.py (data/esco.json),
                   templatize.py (made the template once, from the owner's CV)
test/              node:test suites; fixtures/ holds a fictitious profile and a fake page
scripts/           catalogue.py (writes docs/TESTING.md), sabotage.py and sabotage/*.json
deploy/vm/         the public front: Caddy in Docker, one block per sub-domain
deploy/laptop/     public.sh: the public instance and its SSH tunnel to the front
deploy/micro-ai/   a small local model and its gateway, for small tasks (Pi, VM)
docs/              ARCHITECTURE (design, decisions), HANDOVER (state, next step), TESTING
```

Private data never enters the repository: the profile, offers, runs and
settings live in `~/.itsaresume/`.

To change a rule by hand: write the test first and see it fail (`npm test`),
change the code, add the rule's line to a `scripts/sabotage/*.json` plan
(the line to break and the tests that must then fail), run
`python scripts/sabotage.py scripts/sabotage/<plan>.json`, then
`python scripts/catalogue.py`. CI runs the same.

## Use

Requirements: Node.js 22+, a running itsaresume router, and for the PDF and
page filling, Microsoft Word on Windows (without it, the `.docx` is still
produced).

```bash
npm ci
node bin/itsacv.js serve                      # the web page on http://127.0.0.1:8790
node bin/itsacv.js tailor offer1.txt offer2.txt
node bin/itsacv.js tailor agency-email.txt --split
```

The profile is read from `~/.itsaresume/profile.json` (or `--profile`); runs
are written to `./out` (or `--out`). Nothing personal lives in this
repository: tests use a fictitious profile.

## Public page

`itsacv serve --public-host cv.example.org` serves anyone behind a reverse
proxy: job offers only, capped per visitor and per day, the same offer
answered from its best-rated run (rate a run by renaming its directory
`<name>.q0` … `.q5`; below 3 it is never reused), the owner's notes never
shown. `deploy/vm` is the Docker front (Caddy, one block per sub-domain),
`deploy/laptop/public.sh` the tunnel from the laptop. Why and what it costs:
[ADR-7](docs/ARCHITECTURE.md#adr-7--public-on-a-sub-domain-through-an-always-on-front).

Each job leaves one line in `<out>/qa-log.jsonl`, with the tokens it took
per backend (Claude and the local model apart). To know which ESN spent
them, give each one its own link:

```bash
itsacv invite "Alten" --out <out> --public-host cv.example.org   # prints https://cv.example.org/?i=<code>
itsacv invite --list --out <out>
itsacv invite --usage --out <out>                                  # per ESN: jobs, tokens per backend
itsacv invite --revoke "Alten" --out <out>                         # at once, no restart
```

A page opened from a link names its label in every log line (a reload keeps
it); `serve --invite-only` lets only such a page generate. On the VM:
`docker compose exec generator node bin/itsacv.js invite "Alten" --out
/data/out --public-host "$CV_HOST"`, and `CV_FLAGS=--invite-only` in the
data directory's `.env` turns invite-only on.

## Stack

| Layer | Choice |
|---|---|
| Inference routing | Rust ([itsaresume](https://github.com/SigSegGit/itsaresume)): Claude Code CLI on a subscription, then a local OpenAI-compatible server, fallback only on quota or outage |
| Models | Claude Sonnet (subscription); `qwen3-coder-next` locally (Bionic, 32k context) |
| Generator | Node.js 22, ES modules, `docxtemplater` + `pizzip` |
| Layout and PDF | Microsoft Word through PowerShell COM; PyMuPDF to read the PDF back |
| Web page | `node:http`, vanilla JavaScript and CSS, no build |
| Tests | `node:test`, sabotage verification (`scripts/sabotage.py`) |

No LangChain, on purpose: [ADR-1](docs/ARCHITECTURE.md#adr-1--rust-router-and-a-small-nodejs-generator-no-langchain).

## Licence

AGPL-3.0-or-later.
