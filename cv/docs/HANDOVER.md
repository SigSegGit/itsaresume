<!-- ITSACV-STATE
NEXT: 2.1
TITLE: measure quality on a labelled corpus (synthetic offers from known requirement lists), since real offers are too few to discriminate
WRITTEN-AT: 2026-09-30
-->

# Handover — the CV generator (`cv/`)

Read §0 and §1 only, then act. The router is the repository root (its own
`docs/HANDOVER.md`). The owner's private notes — his runs, his applications,
the decisions waiting for him, how to reach his machines — are in
`~/.itsaresume/HANDOVER-prive.md`, never in the repository.

## 0. Where things stand (2026-09-30)

- **MVP works end to end**: an offer pasted in the local page → the router
  (Claude on the owner's subscription, a local model as fallback; never
  billed per token, ADR-8) → a one-page CV (docx + PDF, ATS-checked) and a
  qualification report, in about 2 minutes. A public instance runs behind a
  reverse proxy on an always-on VM, reached through a tunnel from the laptop
  (ADR-7).
- **Moved on 2026-09-30** from the private `itsaresume-cv` repository into
  `cv/` of the public `itsaresume` repository, as a fresh history (the
  private repository, archived, keeps the past; the owner's data never was
  in either).
- **The model reads, the code decides** (ADR-3). After the model's reading,
  code settles: the score and the qualification (`score.js`); each match's
  grounding in the profile's names and concepts (ESCO + `data/tech.json`: a
  pick the requirement's concept holds is grounded, a "no" whose concept
  holds profile skills is adjacent, skills are placed on whole labels);
  certifications (the profile's own lines, never a skill), languages and
  their level, migrations (the target only), personal qualities; must or
  nice where the offer gives a cue (`importance.js`); the skills column
  (every met visible skill); the headline (a must the page would not show
  brings the profile title naming it); short missions (only what the main
  missions leave open). "Before any model" (a shortlist to the model for
  what code cannot settle) is step 2.3.
- **Measured limit**: real offers are few (three distinct ones). The rules
  are tested on synthetic phrases; replaying past runs could not
  discriminate most of them. Hence 2.1 next.
- 290 tests; every defence is sabotage-verified (`scripts/sabotage/*.json`,
  run by the CI job `cv / sabotage`).
- Open PRs and CI are facts for `gh`, never for this file: re-derive them.

## 1. Resume cheaply (the owner pays every token)

- Read §0–§1 and the step named in the pointer; nothing else first.
- Tests: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"`; on a failure,
  `grep -A10 "failing tests"`. Sabotage: `grep -E "defence\(s\)|^FAIL"`.
  Never read a whole test, CI or sabotage log.
- CI: the app's PR status tool, not `gh run view --log`. The repository is
  public: CI minutes are not counted, but push when a step is whole, not
  sooner.
- No workflow / multi-agent unless the owner asks.
- Edit source with the Edit/Write tools; Git Bash heredocs eat backslashes.
- The session log lives in `~/.itsaresume/SESSIONS.md` (private), written
  only by `~/.claude/skills/itsaresume/sessions.py`.

## 2. How to run

From the repository root (copy the router binary first: a running one
blocks `cargo test`):

```bash
cp target/debug/itsaresume.exe target/itsaresume-run.exe && ./target/itsaresume-run.exe serve --config sonnet-qwen.local.toml --listen 127.0.0.1:8789
cd cv && node bin/itsacv.js serve --url http://127.0.0.1:8789 --timeout 1800 --out ~/.itsaresume/out
cd cv && bash deploy/laptop/public.sh    # public instance on 8791 + tunnel; settings in ~/.itsaresume/public.env
```

`--timeout` must exceed the sum of the router backends' `timeout_secs`
(sonnet-qwen: 600 + 1100). How to reach the VM front: the private handover.

## 3. Gates before a commit

`npm test` (includes hygiene: no CRLF, no invisible character, every
sabotage anchor present once), `python scripts/sabotage.py <plan>` for new
defences (the plan file must sit on the same drive as the repository),
`python scripts/catalogue.py` then `--check`. A branch and a PR per change.

Traps met, each cost time once:
- Git Bash heredocs eat backslashes: edit such lines with the Edit tool.
- Python on Windows writing in text mode turns LF into CRLF: `newline=""`.
- Literal bidi/invisible characters: build them from code points.
- A new test must be able to fail: run its sabotage before believing it.
- A test name holding a backslash (a `\n` from `JSON.stringify`) is escaped
  by TAP and no sabotage `expect` matches it: keep names free of them.
- A replay (`~/.itsaresume/migrations/runs-replay.mjs`) re-normalizes the
  stored, already normalized analysis: a rule acting on the model's own
  answer cannot show there (the raw answer is not kept; see 2.8).

## 8. Steps

- [x] **1.1** Publish, CI, issues (private, 2026-09-24); moved public
  2026-09-30 (§0).
- [ ] **2.1** Measure quality: a labelled corpus of offers, recall of
  requirements, false refusals, per model; a deterministic requirement
  floor. Cheap corpus: synthetic offers generated from known requirement
  lists by the local model (text only, no tools), recall measured against
  the list; the must/nice cues of 2.6 and the equivalents of 2.7 measured
  on it too.
- [~] **2.2** Sonnet measured (ADR-2); the local model alone still to time.
- [ ] **2.3** Router contract: structured output, a model per call (router
  M3). Carries 2.7's step (5): the code settles each requirement it can
  *before* the model, and only the rest goes to a narrow question with a
  shortlist ("which of these skills, or none"), maybe read as option
  probabilities (ADR-10). `relate()` in `src/lexicon.js` is its building
  block and has no production caller yet.
- [x] **2.4** Public go-live (2026-09-28). Not checked by an agent: one
  offer end to end from a phone on 4G (the owner).
- [ ] **2.5** The owner's profile edits, recompiled (private data).
- [x] **2.6** must/nice decided by code from the offer's cues (2026-09-29;
  `src/importance.js`, 9 defences). No real offer changed: the ones at hand
  hold almost no cue.
- [x] **2.7** Closed 2026-09-29 under what it delivered — deterministic
  checks and repairs after the model's reading — with 2.7a–h: concept
  membership grounds a pick and skills sit on whole labels (c), the
  must-stay-no set: certifications, migrations, NoSQL (d), language level
  (e), short missions and an unshown must (f), the skills column (g), the
  check under its name (h); a–b were private data.
- [ ] **2.8** Keep the model's raw answer in the run directory
  (`raw.json`), so a replay can test rules acting on it (found 2026-09-29).

Open from the 2026-09-27 audit, by value: split may drop lines silently;
the report lists the model's bullet picks, not the rendered ones; no
elapsed time on the page; 413 as a cut socket; the 6-letter stem
("product" vs "production").

## 9. Open on purpose

- The honesty checks cannot judge a plausible sentence made of the profile's
  own words; the owner reads the report, and the tool sends nothing.
- A judged match ("à vérifier") trusts the model at half weight; an injected
  offer could raise the score by at most that, never the qualification.

## 10. Waiting for the owner

In `~/.itsaresume/HANDOVER-prive.md` (private).
