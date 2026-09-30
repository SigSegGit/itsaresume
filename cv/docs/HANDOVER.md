<!-- ITSACV-STATE
NEXT: 2.3
TITLE: measure the analysis call with a JSON schema (closed skill ids) on the corpus, both models, before any use
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
- **Measured limit**: real offers are few (three distinct ones). Since
  2.1a, a labelled corpus (`corpus/*.json`: 8 synthetic offers, 75
  requirements labelled must/nice by a human reader, names the offer
  excludes) measures the code. After 2.1b `importanceIn` is right on 39,
  silent on 36 (no cue: the model decides), wrong on 0; a label it gets
  wrong must say so (`known`), `test/corpus.test.js` holds the code to
  exactly that list. The listing model (Bionic) finds 84-88 % of the labels
  and dropped whole "Nice to have" lists (2.1c); with the floor of 2.1e,
  92 % (69/75). Sonnet lists 75/75 (100 %), 5-16 s an offer.
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
- [~] **2.1** Measure quality: a labelled corpus of offers, recall of
  requirements, false refusals, per model; a deterministic requirement
  floor.
  - [x] **2.1a** (2026-09-30) The corpus (`corpus/`, written by hand, not
    by a model: labels a model wrote would measure the model against
    itself) and `src/measure.js` (`corpusProblems`, `measureImportance`,
    `recall`); 7 tests, 4 defences (`scripts/sabotage/corpus.json`).
  - [x] **2.1b** Fix the three misses `importanceIn` shows on the corpus,
    red first from the corpus lines: (1) negation, "n'est pas obligatoire
    mais sera appréciée" and "Kubernetes is not required" read as musts (a
    negated must cue is no must; "pas obligatoire mais appréciée" is nice);
    (2) "Une certification AWS est un atout" makes AWS itself nice while a
    mission needs it (a cue on "certification X" applies to the
    certification, not to X); (3) "would be a big plus" is silent (the NICE
    alternation misses "be a big plus"). Drop each `known` it fixes; add a
    corpus offer for each new phrase; replay the rules on real runs
    (`~/.itsaresume/migrations/rules-replay.mjs`) before shipping.
    Done 2026-09-30: `NEGATED` before every must cue, `onlyCertified`,
    "a big/real/huge plus"; 7 cases, 3 new defences; the replay of the real
    runs is unchanged (the replay scripts now take `CV_SRC`, default
    `D:/GitHub/itsaresume/cv/src`: they pointed at the archived repository).
  - [x] **2.1c** Listing recall per model: `scripts/measure-listing.mjs
    --url <router>` sends each corpus offer through `listRequirements` and
    prints recall and misses. **Bionic (`qwen3-coder-next`), 2026-09-30,
    two runs: 66/75 (88 %) then 63/75 (84 %)**, 10-108 s per offer. Missed
    in both runs: the whole "Nice to have:" list of `en-platform-startup`
    (Rust, Datadog, SOC 2, open source), GCP, the languages (Anglais,
    Spanish), OpenShift, Rigueur; it also listed the excluded "Kubernetes is
    not required" once. **Sonnet, 2026-09-30, one run: 75/75 (100 %)**,
    5-16 s an offer, 87 items listed; it also listed the excluded
    Kubernetes. Measured from one router with named backends (router 8.22,
    `measure-listing.mjs --backend sonnet|qwen`, cv 8.23: `complete()` sends
    `backend` only when asked).
  - [x] **2.1f** A name the offer only denies ("Kubernetes is not required
    for this role", "n'est pas requis") leaves the listing: both models list
    it, and the analysis would then count it. Code, after the listing: drop
    a listed name whose every mention in the offer sits in a clause with a
    negated must cue (`NEGATED` in `importance.js`) or "ne ... pas"; keep it
    if any mention is plain. Red test from the corpus's `excluded` names:
    the listing that holds them loses them; a plain mention keeps them.
    Done 2026-09-30: `onlyDenied` in `src/listing.js` (sentence level; a
    nice cue in the sentence keeps it); 2 tests, 2 defences. Replayed on the
    owner's real offers: it drops nothing; the floor adds only names the
    offers put under a must/nice header.
  - [x] **2.1e** A deterministic listing floor, from 2.1c's stable misses:
    the items of a list under a header (`Nice to have:`, `Must have:`,
    `Atouts :`, `Pré-requis :`...) and of a header line's own enumeration
    are requirements even when the model's listing drops them; added with
    the header's importance, named by the offer's own words. Red test: the
    corpus's `en-platform-startup` listing without its nice list gets it
    back. Measure again with 2.1c: recall must rise, excluded names stay
    out (a negated line adds nothing).
    Done 2026-09-30: `floorItems` and `withFloor` in `src/listing.js` (at
    most 6 words an item; also when the listing cannot be read); 7 tests, 7
    defences (`scripts/sabotage/floor.json`). Bionic with the floor: 69/75
    (92 %), `en-platform-startup` 12/13; still missed: GCP, the languages
    (Anglais, Spanish, permis B: language.js handles languages later),
    Rigueur, "open source".
  - [x] **2.1h** (2026-09-30) The eight corpus offers end to end on the
    owner's profile through the local model alone (Bionic): 8/8 valid at
    the first attempt, 132-205 s each, 0.83-0.91 page, ATS ok. The low
    scores (15-47 on SRE/platform offers) come from the profile (Kubernetes
    "never claimed", DNS/TCP/IP waiting for the owner), not from the code.
  - [ ] **2.1d** (deferred: no ground truth to measure it against; label
    the expected grounding of the corpus first, or drop it) The equivalents of 2.7 (`relate()`) measured on the
    corpus: grounding of each label against the synthetic profile.
- [x] **2.2** Sonnet measured (ADR-2). The local model alone, 2026-09-30:
  one synthetic offer (`corpus/fr-sre-banque.json`) end to end through a
  Bionic-only router (`qwen3-coder-next`): 239 s, first attempt valid,
  0.91 page, ATS ok, `raw.json` holding the two calls. The fallback is
  usable, at about the time Sonnet took per offer.
- [~] **2.3** Router contract: structured output, a model per call (router
  M3). A model per call: done (router 8.22, cv 8.23). Structured output:
  the router takes a schema (8.24) and the client sends one when asked
  (8.25, `complete({schema})`, `listRequirements({structured})`,
  `measure-listing.mjs --schema`). **Measured, 2026-09-30, three runs
  each: with the listing schema the local model finds 61-66/75, without
  68-70/75; Sonnet 75/75 either way. So the listing does not send it by
  default.** The analysis call's schema (closed skill ids) is the next
  measure: send it only if it does not cost recall or verdicts. Carries 2.7's step (5): the code settles each requirement it can
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
- [x] **2.8** Keep the model's raw answer in the run directory
  (`raw.json`), so a replay can test rules acting on it (found 2026-09-29).
  Done 2026-09-30: `analyse()` records every call (`step`, `backend`,
  `text`, in order), `tailorOffer` writes `raw.json`; 1 test, 3 defences.
  Rejected runs still keep only `rejected-attempt-N.txt`.
- [x] **2.1g** (2026-09-30, found on a real offer) Languages an offer lists
  together ("trilingual (English, Spanish, and French or Italian)") were
  merged as examples into one row no longer read as a language, and the run
  was refused twice. Fixed: a language the profile names is never merged
  (`mergeExamples`); the rerun passed first time (126 s, 0.94 page, ATS
  ok); replays of past runs unchanged; one test, one defence.
- [x] **2.10** Near-duplicate rows count a must twice, seen on the same
  real run: (a) "IIS web server" and "Apache web server" stay beside the
  merged "NGINX / Tomcat / IIS / Apache" (a row naming a group member plus
  generic words is not folded into the group); (b) the listing's "Customer
  meetings" is added as an unmet must beside the analysed "Customer-facing
  meetings" (`mergeListed` matches exact names only). Fold (a) into the
  group when the row names one member and nothing but generic words
  ("web server"); for (b) match a listed name to an analysed one when
  either `statedIn` the other by content words. Red tests from those
  names; replay the real runs; rerun the offer and compare the score.
  Done 2026-09-30: (a) a row is read in an enumeration without its
  category words (`core()` in normalize.js); (b) a listed name whose every
  content-word stem one analysed row holds is not added (`mergeListed`).
  Three tests, three defences. The real run replayed from its `raw.json`
  (no model call, 2.8's purpose): 36 → 42, the web servers one gap, the
  duplicate "Customer meetings" gone; past runs' replays unchanged. Replay
  script: `~/.itsaresume/migrations/raw-replay.mjs <run dir>`.
- [x] **2.9** The crude stem (`stem = word.slice(0, 6)` in `src/text.js`,
  copied in `src/evidence.js`) makes "product" and "production", "config"
  and "configuration", "develop" and "developer" one word: a requirement
  "Product ownership" is then "stated" by "production" (`statedIn`), and a
  bullet quoting "production" backs "product" (`evidence.js`). A stem that
  strips known endings (FR/EN: -s, -es, -tion(s), -ment(s), -er, -ing,
  -ed, -é(e)(s)...) and never shortens a word below its root. Red tests:
  "product"/"production" differ; "déploiement"/"déploiements",
  "deploy"/"deployed"/"deploying" stay one; replay the real runs
  (`runs-replay.mjs`, `rules-replay.mjs`) and list every changed verdict
  before shipping. Done 2026-09-30: `stem()` in `src/text.js` strips a
  plural then one ending of a table (`-ation`/`-ated`/`-ateur`/`-ator` meet
  at `-at`; roots keep 4 letters), `evidence.js` uses it; 19 cases, 4
  defences (`scripts/sabotage/stem.json`). Replay of the real runs: one
  verdict changed, the intended one ("product engineering" is no longer
  grounded by prod-ops: 20 → 17 on a run already not qualified); the first
  try also broke "Architectes"/architecture and "expérimenté"/expérience,
  kept since with their endings and tests. Profile provenance: 0 errors.
  The replay scripts' static imports were fixed (`CV_SRC`, dynamic).

Open from the 2026-09-27 audit, by value (split dropping lines silently:
fixed 2026-09-30, every non-empty line in no range is named in a repair,
shown by the CLI and the page; the page's message no longer claims "kept as
one offer" for it, untested: the browser script has no harness; the report
listing the model's bullet picks instead of the rendered ones: fixed the
same day, "Experiences on the CV" counts what `buildModel` rendered; the
6-letter stem: fixed in 2.9; 413 as a cut socket: fixed, a declared
oversize is refused unread, a streamed one drained up to 4 × MAX_BODY then
answered 413, `Connection: close`; no elapsed time on the page: fixed, the
job view carries `elapsed_ms` from the server's clock, the page shows it in
the status chip). The audit list is closed. One rare flake seen once in
three full runs on 2026-09-30, none in six more: name it when it shows.

## 9. Open on purpose

- The honesty checks cannot judge a plausible sentence made of the profile's
  own words; the owner reads the report, and the tool sends nothing.
- A judged match ("à vérifier") trusts the model at half weight; an injected
  offer could raise the score by at most that, never the qualification.

## 10. Waiting for the owner

In `~/.itsaresume/HANDOVER-prive.md` (private).
