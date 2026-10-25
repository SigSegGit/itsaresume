<!-- ITSACV-STATE
NEXT: 2.28b-iii
TITLE: 2.28b-ii done (ports 8773-8872 reserved, use 18789/18790; quality rows validate); 2.28b-iii (a) honest, (b) waits for the owner: lift categories marked no to yes or SQL only; then (c) full compare
WRITTEN-AT: 2026-10-25
-->

# Handover — the CV generator (`cv/`)

Read §0 and §1 only, then act. The router is the repository root (its own
`docs/HANDOVER.md`). The owner's private notes — his runs, his applications,
the decisions waiting for him, how to reach his machines — are in
`~/.itsaresume/HANDOVER-prive.md`, never in the repository.

## 0. Where things stand (2026-10-06)

- **MVP works end to end**: an offer pasted in the local page → the router
  (Claude on the owner's subscription, a local model as fallback; never
  billed per token, ADR-8) → a one-page CV (docx + PDF, ATS-checked) and a
  qualification report, in about 2 minutes. The public instance
  (cv.<domain>) generates on the always-on VM, Claude first, the laptop's
  Bionic through a tunnel when the laptop is on (ADR-11); the VM follows
  `main` by itself (3.5, timer installed 2026-10-05).
- **2.24 done 2026-10-13** (browser fill 0.95-1.00 on the 26 runs).
- **2.25 batch done 2026-10-13** (one PR): owner-ruled and mined links
  (`src/links.js`), the shortlist and a compact catalogue **behind
  `ITSACV_PROMPT`** (off until 2.25c's real A/B), 2.22d measured, 5.1
  coverage matrix in code (Spearman 0.62 vs the pipeline's score).
- **Order set by the owner (2026-10-06)**: 2.24 (the A4 page laid out and
  printed by the browser, docx kept as an option), then 2.25 (a shorter
  prompt through standard profiles), then 2.22c. A local model on the Pi
  or the VM is not wanted now: Claude then Bionic is enough.
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
  what code cannot settle) is step 2.3b-ii; a skill's term no longer
  settles a requirement (2.3b-i). The analysis call's schema
  (closed ids) was measured (2.3a): no gain on Sonnet, a loss on the local
  model, so it is not sent.
- **Measured limit**: real offers are few (three distinct ones). Since
  2.1a, a labelled corpus (`corpus/*.json`: 8 synthetic offers, 75
  requirements labelled must/nice by a human reader, names the offer
  excludes) measures the code. After 2.1b `importanceIn` is right on 39,
  silent on 36 (no cue: the model decides), wrong on 0; a label it gets
  wrong must say so (`known`), `test/corpus.test.js` holds the code to
  exactly that list. The listing model (Bionic) finds 84-88 % of the labels
  and dropped whole "Nice to have" lists (2.1c); with the floor of 2.1e,
  92 % (69/75). Sonnet lists 75/75 (100 %), 5-16 s an offer.
- 2026-10-04: tokens per job in `qa-log.jsonl`, Claude and local apart
  (2.13); a public job readable by its own visitor only (2.14); favicon
  and link preview (2.15). Later, written as steps: another profile (4.x),
  matchmaking (5.x).
- 2026-10-05/06 (2.18-2.21, router 8.42-8.44): the model menu follows the
  router's `/status` (Claude by default while its use is light; the local
  model greyed when the laptop is off, offered "en veille" when it is on,
  then woken by `deploy/laptop/wake-watcher.sh` and the job waits); one
  tunnel at a time; two lanes (Claude, local) with the queue place shown.
  Verified live: a sleeping local model woken from the public page, a CV in
  434 s. The laptop runs its scripts from `~/.itsaresume/bin/` (a copy).
- The router contract is 1.1 (router 8.37, 8.43): `src/llm.js` refuses
  another major and reads no `contract` as 1.0; `serve()` checks it at
  start.
- `complete({kind})` marks a call `classify` (router 8.36); none is marked:
  `scripts/measure-split.mjs` gives the split Sonnet 14/14, the local model
  7/14.
- 2.22 (the owner, 2026-10-06): refining the profile from the app. A
  requirement no profile skill meets becomes a question; his "yes" (level,
  one sentence) joins the profile through `answers.json` (2.22a done);
  `itsacv questions` lists them (2.22b done: 36 on the 26 real runs); the local form (2.22c done 2026-10-13, ahead of 2.25 in the owner's order; its links are 2.22c-link), the measure (2.22d)
  follow. 2.3b-ii's shortlist then comes, as a hint, never a lock.
- 471 tests; every defence is sabotage-verified (`scripts/sabotage/*.json`,
  one plan per attack surface since router 8.46: injection, guard, public,
  http, billing, laptop, deploy, content; CI job `cv-sabotage` runs the
  plans whose `files` a PR touches, all of them on `main`).
- `test/hostile.test.js` (router 8.46b): hostile offers through the real
  pipeline and the public page with an obedient model; five leaks found
  and closed (#89-#93). A new attack goes there as a single-field variant.
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
`python scripts/catalogue.py` then `--check`. A new defence goes into the
plan of its surface, then `python scripts/sabotage-select.py --check`
(from the repository root). A branch and a PR per change.

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
  default.**
  - [x] **2.3a** (2026-10-06) The analysis call's schema: `analysisSchema()`
    (src/prompt.js) closes skill, bullet, experience, group, title and
    fact ids to the catalogue; `analyse({structured})` sends it, off by
    default (2 tests, 5 defences). Measured with
    `scripts/measure-analysis.mjs` on the corpus, real profile: Sonnet
    74/75 labels, 0 retry, 0 refusal with or without it; verdicts
    unchanged on 80/83 with it against 82/85 between two plain runs (noise);
    scores move as much between two plain runs. The local model: without,
    65/75, 8/8 passed, 1 retry, 47 min; with, of the 6 offers run while the
    router was up, 3 passed (each on its second attempt; labels 4/7, 7/9,
    9/9 against 5/7, 7/9, 9/9 without), 1 refused invalid, 2 lost to Bionic
    (peer disconnected, global timeout; whether the schema caused them is
    not shown). **Verdict: not sent, for either model**: no gain on Sonnet,
    a loss on the local model. The measure stays for a later model.
  - [ ] **2.3b** Carries 2.7's step (5): the code settles each requirement
    it can *before* the model, and only the rest goes to a narrow question
    with a shortlist ("which of these skills, or none"), maybe read as
    option probabilities (ADR-10). `relate()` in `src/lexicon.js` is its
    building block and has no production caller yet. Start from §9's
    wrong-skill matches (2026-10-06: "stockage" through `p2p`, "AI" through
    `alerting`, "SRE" through `devops`): red tests on those names with the
    synthetic profile, then the code rule; replay the real runs
    (`~/.itsaresume/migrations/rules-replay.mjs`) before shipping.
    - [x] **2.3b-i** (2026-10-06) Cause of "stockage"/"AI": the whole-name
      rule in `normalize.js` read a skill's *terms* as names, settled the
      requirement with that skill alone and dropped the model's. Now names
      and aliases only (one map, `byIdentity`, for whole names and parts).
      Replayed on the 26 real runs, old code vs new, on the raw answers
      (`raw.json` + `offer.txt`): 3 rows change; both 2026-10-06 runs keep
      Prometheus, Grafana, ELK… beside alerting; an old run's "Conteneurs"
      goes yes → adjacent (a docker term; grounding decides). "SRE" →
      `devops` is unchanged: SRE is an alias the v4 gives (a profile
      question, §10, not code).
    - [x] **2.3b-ii** (code 2026-10-13, opt-in `ITSACV_PROMPT=shortlist`
      until 2.25c) The shortlist: for a requirement no name settles,
      `relate()` gives the candidate skills and they are offered to the
      model first ("which of these, or none"). **Not a lock** (the owner,
      2026-10-06: "pas un matching artificiellement bas à cause d'un
      verrouillage"): a pick outside the shortlist is kept when the
      existing grounding keeps it (yes / adjacent as today); the shortlist
      adds candidates, never removes one. Red tests first on the synthetic
      profile, including a pick outside the shortlist that stays met;
      replay as in 2.3b-i before shipping, and the replay must show, row by
      row, no yes → no without a named reason. What stays "no" for want of
      a profile skill feeds 2.22's questions, not a lower bar.
- [x] **2.4** Public go-live (2026-09-28). Not checked by an agent: one
  offer end to end from a phone on 4G (the owner).
- [x] **2.4b** Manual QA (2026-10-02): the page picks the model per run
  (auto = the router's order, Claude alone, the local AI alone; `src/qa.js`
  maps them to the router's backend names), a hand-picked model is never
  answered from a reused run, and every run (reused ones too) appends one
  JSON line to `<out>/qa-log.jsonl`: offer, model, entry point (`vm` when
  the public name was used, else `laptop`), backend, attempts, step times,
  outcome, fit and the model's analysis. The entry point is the URL opened,
  not a choice: both run on the laptop. The owner reads the log; a study of
  it comes before any change of model or prompt.
- [x] **2.4c** (2026-10-04) A requirement whose every part, before any
  parenthesis, is a profile skill's name or alias ("Fortinet / FortiGate",
  "HA (haute disponibilité réseau)") is met by those skills; a term is too
  loose ("Sécurité (IA)" is not SecOps), one unnamed part leaves it. Measured
  on the 27 real runs: one change ("Prometheus / Grafana" gains Grafana).
  Same day: soft skills (pair work) are qualities and administrative
  conditions are to confirm, never "non" (#65).
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
- [x] **2.12** (2026-10-01) Red team of the 2026-09-30 work, every finding
  reproduced then fixed red/green with a defence: a denial judged per clause
  ("Terraform est obligatoire, Kubernetes n'est pas requis" no longer drops
  Terraform); a nice header ends at a blank or plain line; certifications
  never merged as examples; a listed must not absorbed by a longer or a nice
  row (SQL / SQL Server); "ASP.NET" a name, not a link; `pending` validated;
  public mode hides the evidence verdicts, the truth document, repairs and
  raw errors. Also the flaky server test (1 in 30): a declared oversize up
  to the drain limit is drained before its 413 (0 in 40 since).
- [x] **2.11** (2026-10-01) A gap the owner has not settled yet is a profile
  question, not a proved lack: the profile may carry `pending` (names that
  wait for his confirmation; compiled privately by
  `~/.itsaresume/migrations/2026-10-01-pending.py`, run after the v4 and
  addendum scripts), and the report marks such a gap "waiting for your
  confirmation" and counts them. Two tests, two defences. On the real Palo
  Alto run: "Windows Server administration" marked.
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

- [ ] **3.x** Generation on the VM, Claude first (ADR-11, the owner's
  decision of 2026-10-01; ADR-7 kept the pipeline on the laptop). Steps:
  - [x] **3.1** A LibreOffice layout engine (`src/libre.js`, same
    interface as `word.js`: `measure(docx, pdf?) -> {pages}`), used when
    Word is absent and `soffice` is present: docx -> PDF headless, page
    count and fill read from the PDF (PyMuPDF or pdf text). Red tests with
    a fake `soffice`; then measure on the corpus against Word (same CVs:
    pages and fill within 3 %?) before trusting it. Linux side checked in
    WSL (install libreoffice there) and on the VM.
  - [x] **3.2** An image for the generator (Node + LibreOffice + fonts of
    the template), and a compose on the VM: router (existing image, the
    `claude` CLI, `CLAUDE_CODE_OAUTH_TOKEN` from the owner's `claude
    setup-token`, never committed) + generator `--public-host`; Caddy
    points `cv.<domain>` at it instead of the laptop tunnel. The private
    profile (`~/.itsaresume/profile.json` and its truth document) copied to
    the VM by a script, never in the image.
  - [x] **3.3** The local model as a second backend when the laptop is on:
    the laptop opens a tunnel that exposes Bionic (54321) to the VM, the
    VM's router lists it after Claude (`timeout_secs` below the
    generator's); laptop off and Claude spent: the page says "réessaie plus
    tard" (an `Exhausted` mapped to a clear message), never a crash.
  - [x] **3.5** (2026-10-04, the owner: a merged change must reach the VM
    without him typing) The VM follows `main` by itself:
    `deploy/vm-generator/auto-deploy.sh` (fast-forward only, then `docker
    compose up -d --build`; refuses local edits, local commits, another
    branch; a failed build is retried at the next run) under a systemd
    user timer (`deploy/vm-generator/systemd/`, every 5 min). Pull, not
    push: no key or address of the VM leaves it, nothing in CI or a
    cloud session. Six cases in `test-auto-deploy.sh` (real git, fake
    docker; CI job `handover`), five defences
    (`scripts/sabotage/auto-deploy.json`). Waits on the owner: the
    one-time install (`compose.yaml`'s header).
  - [x] **3.4** Real check from outside, laptop OFF: one new offer on
    cv.<domain>, a CV served by Claude from the VM; then the Bionic path
    with the laptop on.
  Done 2026-10-01: `src/libre.js` + `tools/pdfmeasure.py` (5 tests);
  measured on the VM against Word on 14 CVs: LibreOffice reads 1-2 % shorter
  every time (never longer: no overflow), about 3 s a measure. `cv/Dockerfile`
  (1.05 GB on aarch64), `deploy/vm-generator/compose.yaml` (router and
  generator, host network, the generator on 127.0.0.1:18790 where Caddy
  already proxies), `deploy/laptop/bionic-tunnel.sh`; private data in
  `~/itsacv-data` on the VM (0700). Real check from outside: a new offer on
  cv.ngas.fr generated ON THE VM through Bionic (tunnel), 173 s, 0.90 page,
  ATS ok, PDF and Word served. The public intake refused a 286-character
  offer as "not an offer": look at its rule with real short offers.
  Waits on the owner: `claude setup-token`, the token in the VM's
  `~/itsacv-data/.env`; then router.toml takes the claude block first
  (router.example.toml) and `docker compose up -d router`.
  3.4 done 2026-10-01: the owner's token on the VM, router.toml Claude
  then Bionic; with the laptop tunnel cut, a new offer on cv.ngas.fr was
  served by Claude from the VM (108 s, 0.92 page, PDF and Word). Found on
  the way and fixed: the CLI lost output past 128 KiB written into a pipe
  (router #54); a reload lost the visitor's jobs (cookie, #53); CI's newer
  stable deprecated fetch_update (#55). The intake refusing a short real
  offer stays to look at.
- [x] **2.13** (2026-10-04, asked by the owner) Tokens traced on the
  server, Claude and the local model apart. The router journals each
  answer's `usage` and `stats` sums it per backend (router 8.38); its HTTP
  answer carries it (8.39); the client keeps it, the server counts every
  answer of a job (`addTokens`, `counted` in `src/llm.js`) into
  `qa-log.jsonl` as `tokens` per backend (`calls`, `input`, `output`,
  `cache_read`, `cache_creation`), a failed job's included, never in the
  page. `scripts/sabotage/tokens.json`. `/api/split` (owner only) is not
  counted per job: its tokens are in the router's journal only.
- [x] **2.14** (2026-10-04, asked by the owner: an ESN must not see what
  another tested) In public mode a job's detail and files were served to
  anyone holding its id (the list was already per visitor). Now only to
  its visitor: the page's header, or the cookie alone for a download link;
  404 to anyone else. Left as is: the same offer pasted by another visitor
  is answered from the earlier run (`reuse`), which tells them only that
  this offer was seen before, with the owner's CV they would get anyway.
- [x] **2.15** (2026-10-04, the owner: "a site with no favicon or banner")
  `web/favicon.svg`, `/favicon.ico` and the touch icon (PNG), Open Graph
  and Twitter tags whose image is `https://<public host>/banner.png`
  (1200×630). Rendered from `tools/brand/` by `tools/brand/render.sh`
  (`chromium-headless-shell`; a full Chromium in headless mode crops the
  viewport). Not checked: how LinkedIn or WhatsApp actually render the
  preview (needs the public instance up: the owner pastes the link once).
- [x] **2.16** (Rodin, 2026-10-04) **Name who consumes.** 2.13 traces
  tokens per *visitor*, a random token: the log cannot say which ESN spent
  what. Proposed in session, not yet answered by the owner: invitation
  links, one per ESN, made by the owner (`itsacv invite <label>` prints
  `https://<host>/?i=<code>`; codes in `<out>/invites.json`, owner only).
  A page opened with a valid code binds its visitor to the label; the QA
  log line gets `invite: <label>`; with `--invite-only`, a page without a
  valid code can read but not generate (403 on `POST /api/jobs`). No
  password, no account. Red tests in `test/server.test.js`: a code binds
  the label into the log line; an unknown or revoked code is no
  invitation; two invitees still see only their own jobs (2.14 holds);
  `--invite-only` refuses a job without one. Sabotage: the label dropped
  from the log; the invite-only check bypassed. Done 2026-10-04 without
  settling the owner's question: invite-only is a flag (`--invite-only`,
  on the VM `CV_FLAGS=--invite-only` in the data `.env`), off by default,
  so the anonymous page stays as today until the owner turns it on.
  `src/invites.js`, `itsacv invite` (`--list`, `--revoke`), the code read
  again at each job (a revocation holds at once, no restart). Rodin: the
  label was worth nothing without a reader, so `itsacv invite --usage`
  prints, per label, the jobs (reused, failed) and the tokens per backend
  from `qa-log.jsonl`. Ten tests, eleven defences
  (`scripts/sabotage/invitations.json`). Not done: the page does not say
  "on invitation" before a refused click.
- [~] **4.x** (the owner, 2026-10-04: "later") **Another profile than the
  owner's.** Today one profile is loaded at start (`--profile`,
  `loadProfile`), compiled privately with its truth document and verdicts.
  Before any code, settle with the owner (closed questions):
  (a) what is uploaded: the compiled `profile.json` (schema of
  `src/profile.js`, only someone with the tooling can make one) or a CV
  (docx/PDF) the tool compiles (a model call, and every honesty check
  rests on a profile nobody verified); (b) who may: the owner only (local
  page, `--profile-dir`), or public visitors (their personal data on the
  owner's machine and in the owner's Claude quota: GDPR, retention,
  deletion); (c) where it lives: memory only for the visitor's session, or
  disk. Recommended first step, whatever (b) says: **4.1** the server
  takes a profile per job, not per process: `deps.tailor({ profile })`,
  `POST /api/jobs` with a `profile` id from a closed list of files in a
  directory the owner fills (`--profiles DIR`); the job, its log line and
  its run directory name the profile; reuse (`findReusable`) keys on
  (offer, profile), never the offer alone. Red tests in
  `test/server.test.js`: two profiles, one offer, two different CVs; an
  unknown profile id 400; a reuse never crosses profiles; in public mode
  the profile list is the owner's choice (`--public-profiles`), never the
  directory. Sabotage: the reuse key without the profile.
  **4.1 done 2026-10-04** (`cv/profile-per-job`): `src/profiles.js`,
  `serve --profiles DIR`, the page's profile choice (shown only with
  several), `run.json` records the profile, reuse matches it, public mode
  knows `default` alone and lists none (`publicStatus` drops `profiles`:
  other people's names). Eight tests, thirteen defences
  (`scripts/sabotage/profiles.json`). Not done, waiting on the owner's
  answers to (a)-(c): an upload, a public choice, retention. `itsacv
  tailor` has no `--profiles` (use `--profile FILE`). Next: 5.1, the
  code-only matrix, now unblocked.
- [x] **2.17** (2026-10-05, the owner, laptop off, public page on the VM)
  Two bugs. (1) A recruiter's LinkedIn approach (SRE senior) was refused
  as "not an offer": `looksLikeOffer` matched words exactly, so "rôle",
  "techniques", "postes" missed "role", "technique", "poste"; one hit, not
  four. Offer words are now compared stem to stem, accents removed, and
  the list holds the hiring verbs (recruter, rejoindre, opportunité,
  hiring, join). (2) The public page showed an empty "Profil" select:
  `.model { display: block }` beat the `hidden` attribute; a global
  `[hidden] { display: none !important; }` now wins. Two tests, two new
  defences, one rewritten (`intake.json`, `web.json`). Not done on
  purpose: a visitor's own profile upload on the public page is 4.1's
  question (a), still the owner's.
- [x] **2.18** (2026-10-05, the owner: "the menu must follow what is
  available") The model menu follows the router's `GET /status` (router
  8.43): `src/models.js` (`modelMenu`) greys a model that cannot answer
  with its own French note, never a router reason; the local model, when
  it can answer, is the default (loaded, or "chargé à la demande, 1 à 2
  min de plus"), else auto, else nothing and no generation; Claude after
  a limit is off for an hour, then offered again with the time it was
  seen; router down: "routeur injoignable"; a router without `/status`
  leaves the menu as it was. The page refreshes it every 30 s and when
  the menu is opened. Also: the VM compose health-checks the router on
  8789 (the image asks 8787: Docker called it unhealthy), and
  `deploy/laptop/bionic-tunnel.sh` starts Bionic's server before each
  round (`BIONIC_LMS` in `~/.itsaresume/public.env`). Owner's decision
  (A): a public generation may wake the local model; never at page load,
  never when Claude alone is chosen; Bionic unloads it after an idle
  hour. 10 tests, 9 defences (`models.json`, `runtime.json`); the tunnel
  test runs on Linux only (POSIX fakes; verified under WSL and in CI).
- [x] **2.19** (2026-10-05, the owner after Rodin: "Claude by default
  while my use is light; no Bionic at boot, wake it on demand; tell the
  visitor what was done, never make them retype the offer") The default
  is Claude while its last answer said `allowed` (router 8.44), else the
  local model when it can answer, else auto. The laptop runs only
  `deploy/laptop/wake-watcher.sh` at logon (`wake-watcher.vbs`, no
  window): one SSH call a minute marks it seen in `<out>/wake/` and takes
  a wake request. A laptop seen within 3 min whose model sleeps is offered
  ("en veille : réveil à l'envoi"); a job for it leaves the request,
  shows the step "Réveil de l'IA locale" with what was done, waits up to
  6 min (`src/wake.js`), then runs: the offer is never typed again. Not
  seen: "portable éteint ou hors ligne". 8 tests, 10 defences
  (`models.json`, `runtime.json`; watcher ones verified under WSL and in
  CI, POSIX fakes).
- [x] **2.20** (2026-10-06, seen live) **One tunnel at a time.** Four
  `bionic-tunnel.sh` ran at once (session tasks whose shells were stopped,
  not their scripts; an orphan `ssh` kept the forward): each round freed
  the VM's ports (`fuser -k`, which works since `psmisc` was installed on
  the VM), cutting the others and restarting Bionic, and the owner's local
  jobs failed "Peer disconnected". The tunnel now writes
  `~/.itsaresume/bionic-tunnel.pid` (the watcher's file) and a second one
  leaves at once while the first is alive. The laptop runs the scripts
  from `~/.itsaresume/bin/` (a copy), never from the checkout: a branch
  switch once removed the running watcher's file. 1 test, 1 defence
  (`runtime.json`, verified under WSL).
- [x] **2.21** (2026-10-06, the owner: "two visitors on my local model?")
  Two lanes in `src/server.js`, Claude (and auto) and the local model,
  each one job at a time: a Claude job never waits behind a slow local one
  (a real local run took 434 s), and the local model keeps its one slot
  (the router's `max_concurrent` 1 holds it too). A queued job carries
  `position` in its lane; the page shows "en attente : prochain / Ne dans
  la file", refreshed by the poll. The public cap counts both lanes; so
  does `busy`, which the auto-deploy waits on. Each job starts its own
  LibreOffice with its own profile, so two layouts never share one.
  Measured live the same night: a sleeping local model woken from the
  public page (watcher, Bionic, tunnel) and a CV in 434 s.
- [ ] **2.22** (the owner, 2026-10-06: "je n'ai pas forcément mis toutes
  mes compétences en avant… des questions pour savoir si j'ai telle ou
  telle compétence et enrichir le profil petit à petit") **Refining the
  profile from the app.** A requirement the profile cannot meet is a
  question to the owner, not only a lower score. ADR-6 holds: the owner's
  own words are a source; a model never writes an answer, and the public
  host can neither read nor write them.
  - [x] **2.22a** (2026-10-06, 6 tests, 11 defences; checked on the real
    profile with a throwaway answer: merged, and a duplicate of a profile
    skill refused by name) Answers into the profile. `src/answers.js`: an
    `answers.json` beside `profile.json` (private), a list of
    `{id, asked, answer: "yes"|"no", name, level, group, said, at}`;
    `said` is the owner's sentence, kept as the skill's quote.
    `loadProfile` merges each "yes" as a skill (id `answer-<id>`, the
    owner's level, never raised; `provenance: {answer: id}`), so the
    pipeline, grounding and score use it like any other. Refused, named
    in the load error: a level outside LEVELS, an empty `said`, an unknown
    group, a name an existing skill already carries (the answer adds
    nothing; the v4 wins), a skill the evidence says is contradicted. A
    "no" adds nothing and is remembered (never asked again). Red tests on
    the synthetic profile; a defence per refusal.
  - [x] **2.22b** (2026-10-06, 9 tests, 22 defences; real runs: 36
    questions, counted per distinct offer) `src/questions.js`; older runs are
    re-read with today's kinds (`settledKind()` in normalize.js), a run
    without offer.txt is its slug's offer; what the profile now meets is not
    asked. Left: listing errors (roles such as "Architectes", "QA") are
    asked, the owner answers no. The questions. From one run (the report's requirement
    table) and from all runs in `out/`: each requirement met by no profile
    skill (verdict no, not adjacent), grouped by its concept (`lookup()`
    in `src/lexicon.js`, else its text), minus what `answers.json`
    already answers, ranked by how many offers ask it. `itsacv questions`
    prints them.
  - [x] **2.22c** (2026-10-13) `/questions.html` + `web/questions.js`,
    `GET /api/questions` (`pageQuestions()`), `POST /api/answers`
    (`addAnswer()`: mergeAnswers must take it, an id once, stamped by the
    server, written atomically); all four 404 on the public host
    (`LOCAL_ONLY`). Checked on the real profile read-only: 36 questions,
    10 groups; a refusal shows in the page; nothing written.
  - [x] **2.22c-link** (2026-10-13) Link `/questions.html` from the local home page
    (the status says it is local; hidden in public) and, per finished
    job, its unmet requirements (`/questions.html?job=<id>` filtering to
    `runs` containing that run). Test in web.test.js.
  - [x] **2.22d** Measure: the 26 real runs replayed with the answers the
    owner gave; the score moves only through his answers. **2026-10-13**
    (`~/.itsaresume/migrations/answers-replay.mjs`, code only): 2 answers;
    6 runs keep raw.json, 2 moved (Active Directory no -> yes, score
    33->37, 38->42), 0 changes not through an answer. To redo when he has
    answered more of the 36 questions.
- [x] **2.23** (a tester, 2026-10-06: "ton front spam pour récup les
  status") The page asks `/api/jobs` every 5 s, not 1.5 s (measured on his
  capture: ~20 calls per 30 s, not 30/s), and a hidden tab asks nothing.
  SSE (one stream per job) stays possible; low value while the VM's load
  is 0.00. PR #100.
- [ ] **2.24** (the owner, 2026-10-06, before 2.22c) **The A4 page in the
  browser.** Some CVs fill less than 80 % of the page. The browser lays out
  a fixed A4 template (thin margins, our fonts served locally, no remote
  asset) and fills it exactly; the PDF is the browser's print (`@page`
  A4, an "Exporter en PDF" button). The docx stays, as an option, without
  the full-page promise. The split keeps "the model selects, the code
  decides": the server sends only what the honesty checks allow, ranked;
  the browser only chooses how many of them fit. Steps:
  - [x] **2.24a** (2026-10-12) The server's ranked content: `GET /api/jobs/:id/page`
    returns the CV as data (header, summary, sections, items each with a
    rank and a "must" flag: main missions always), no layout. Red tests:
    nothing the docx would refuse appears; the order is the docx's.
    Done: `pageData` (src/tailor.js), stored as `result.page` by serve.js
    (fresh and reused runs), `GET /api/jobs/:id/page` (404 when absent,
    same visitor check as files); items `{id, text, rank, must}`, rank 0 =
    a main mission's floor bullet not ranked; 3 defences (public.json).
    **For 2.24b**: the docx caps every other experience at the reference
    experience's bullet count (`most` in buildModel); the fill must keep
    that cap when it adds by rank, or the page shows what the docx would not.
    Known: the "Invite 0600" defence stays green on Windows (chmod is a
    no-op there); Linux CI verifies it.
  - [x] **2.24b** (2026-10-13) Done: `web/cv.html` + `cv.css` + `cv.js`,
    served at `/cv.html?job=<id>` (STATIC, same CSP). `fill(page, sheet)`:
    musts first (spacing shrinks 1.15 → 1.0 if they overflow, said in
    `#notice`), then items by rank under the docx cap (an experience waits
    until the reference has as many), stop at the first overflow; then
    spacing widens by 0.05 up to 1.5 while under 95 %. `pageData` now gives
    each experience `reference` and `when_empty` (null: a short mission is
    dropped; `{title, env: ''}`: an R&D project goes sober). Tested in
    `test/a4.test.js` over a fake sheet (heights given), not the page.js
    DOM; 5 defences (public.json). **Not yet seen in a real browser**: no
    link to it from the job page, fonts are installed ones (Calibri,
    Carlito fallback), not served.
    The spec: the A4 template (`web/cv.html` + `cv.css`, served by
    `serve`, same CSP: no inline script or style) and the fill in
    `web/cv.js`: add items by rank while the page does not overflow
    (`scrollHeight` against the A4 box), then widen the line spacing
    within fixed bounds until the fill reaches >= 95 % or the bound.
    Must items never dropped; if they overflow, shrink within bounds and
    say so. Tested over the fake DOM of `test/fixtures/page.js` with
    item heights given.
  - [x] **2.24c** A link « Page A4 » per done job (web/app.js, new tab);
    a button « Imprimer / PDF » calls `window.print()`; `@page` A4 margin 0
    and `@media print` hide all but the sheet. 3 defences (http.json).
  - [x] **2.24d** (2026-10-13) Measured on the 26 real runs (bench:
    `~/.itsaresume/migrations/a4-fill-bench.mjs`): the browser fills
    0.95-1.00, spacing 1.15-1.35, no overflow; the Word/LibreOffice PDFs
    fill 0.67-1.03 (11 under 0.95). Two bugs of 2.24b found and fixed:
    the fill was read on the fixed A4 box (scrollHeight >= clientHeight,
    so 1.00 everywhere and the spacing never widened), now on an inner
    block; the float:right dates came out before every title in Chrome's
    PDF text, now a flex head (title, org, dates). Chrome headless
    print: one page, text selectable, button hidden. **Left to the
    owner**: the same print by hand in Firefox.
  - Lost, said in the page: the server's ATS check of the PDF (the server
    no longer sees the printed PDF).
- [ ] **2.25** (the owner, 2026-10-06) **A shorter prompt, same
  quality.** Today the whole profile goes into every prompt (<= 14.5k
  tokens at worst). Standard profiles built on **ESCO** (the EU's
  skills/occupations taxonomy, free, in French, SKOS: stable URIs,
  broader/narrower/related links, essential/optional skills per
  occupation). The v4 compilation maps each skill to its ESCO URI (by
  code and a reviewed table, never invented; unmapped skills stay, flagged);
  the offer's requirements map to ESCO concepts, code picks the closest
  occupation(s), and the prompt carries only the profile's skills and
  experiences linked to them. ESCO's links may also replace or feed the
  home lexicon (`src/lexicon.js`). The owner's reason (2026-10-06): the
  site will later test an offer against other profiles, do matchmaking
  (5.x) and help write a profile; ESCO is the common language for all
  three, so the mapping is written profile-agnostic. First
  measure (prompt tokens per section on the 26 runs, from the QA log),
  then replay (`rules-replay.mjs`, `guard-replay.mjs`): the subset ships
  only if no run loses a matched requirement it had.
  - **Measured 2026-10-13** (`~/.itsaresume/migrations/prompt-sections.mjs`,
    the 7 runs that kept offer.txt; tokens ~ chars/4): the analysis
    prompt is 4.9-5.1k tokens, not 14.5k: skills 2.2k, experiences 1.1k,
    system 0.8k, facts 0.4k, offer 0.1-0.4k. The ceiling of the saving is
    ~3k tokens per analysis call.
  - **ESCO, measured 2026-10-13** (search API, French; private
    `~/.itsaresume/esco/skills-candidates.json`): 9 of the 84 profile
    skills have an exact ESCO title (PostgreSQL, Ansible, C++, C#, DevOps,
    Cisco, HTML/JS, two languages); 18 have nothing (Prometheus, Grafana,
    Terraform, Vault, ELK, PagerDuty, ServiceNow...); the 57 others get
    hints, mostly wrong ("GitLab CI" -> "inspirer de l'enthousiasme pour
    la nature"). **Waiting on the owner**: ESCO as the common vocabulary
    covers occupations and soft skills, not this profile's tools. Options:
    (a) ESCO for occupations and generic skills + the home lexicon
    (`src/lexicon.js`) for tools; (b) the home lexicon alone for the
    prompt subset, ESCO deferred to 5.x.
  - **Option (b) chosen (owner, 2026-10-13), replayed offline the same
    day** (`~/.itsaresume/migrations/subset-replay.mjs`, no model call: the
    skills each past run's requirements pick through `relate()` and names,
    against the skills the model matched and put in the CV's groups).
    Per skill: subset median 6 of 84, **23 of 26 runs lose a matched
    skill** (gitlab-ci, architecture, prod-ops, puppet...: the model links
    "CI/CD" to GitLab CI, the lexicon does not), 26 of 26 lose CV-group
    skills. Per group (keep every group touched): median 32, still **16 of
    26** and 25 of 26. The gate fails; nothing shipped. The skills
    section also feeds the CV's skill groups, so a requirement-driven
    subset cannot hold that role. **Waiting on the owner**: drop 2.25 (the
    prompt is ~5k tokens, ceiling ~3k saved), or a format-only shrink
    (same skills, fewer tokens: measure first).
  - **The owner's decision (2026-10-13)**: links + compact format; no
    prompt filtering until the leave-one-out replay loses 0 runs. Measured
    first (`~/.itsaresume/migrations/links-loo.mjs`): links mined from the
    model's past matches (requirement words -> skills), learnt on 25 runs
    and tested on the 26th: kept median 41 of 84, 10 of 26 runs lose a
    matched skill, 53 of 277 matches missed (lexicon alone: 23 of 26).
  - **Batch of 2026-10-13** (the owner asked for several steps in one PR):
    2.25a, 2.25b, 2.3b-ii (opt-in), 2.22d, 5.1 below.
  - [x] **2.25a** Mined links in the lexicon. A link seen in >= 3 distinct
    offers is accepted by code; below that it waits in a small private
    index the owner fills now and then (`~/.itsaresume/links.json`:
    `{words, skill, verdict: same|near|no}`), never in the repository
    (his skills). `relate()` reads both. Also the owner's ruling: AD CS and
    ADFS are near Active Directory (adjacent, never yes, never no). Test on
    the synthetic profile; replay `links-loo.mjs` and the score replays.
    **Done 2026-10-13**: `src/links.js` (mine, merge, read, `linkedSkills`,
    `shortlist`); `loadProfile` reads `links.json` beside the profile.
    Mined links only shortlist (the model's past readings never ground a
    match); the owner's verdicts act in `normalize()`: same grounds, near
    holds a yes at adjacent and lifts a no to adjacent, no drops the pick.
    Private file written by `~/.itsaresume/migrations/mine-links.mjs`
    (runs grouped by offer.txt): **only 8 distinct offers** behind the 26
    runs, so 5 links reach 3 offers and 929 wait; AD CS / ADFS ruled near
    the answered Active Directory skill. Reviewing 929 by hand is not
    realistic: see §10.
  - [x] **2.25b** A compact prompt format, same skills: measure tokens
    first (aliases, terms, level words, ids), then `rules-replay.mjs`;
    ships only if no run loses a matched requirement.
    **Done as an opt-in 2026-10-13**: `buildPrompt(..., {compact: true})`,
    skills under their group, one letter per level, alike terms once;
    -2.1k chars (~525 tokens, 13 %) on the real profile. Every id, name,
    alias and term kept (tested). Not on by default: the gate needs the
    model (rules-replay cannot see a prompt change) -> 2.25c.
  - [ ] **2.25c** The real A/B: `ITSACV_PROMPT=compact,shortlist` vs off on
    the 6 runs that kept offer.txt and raw.json (~24 calls on the Pro
    quota, the owner's go first); compare matched requirements row by row
    (2.3b-ii's rule: no yes -> no without a named reason); switch the
    default on only if none is lost.
- [ ] **2.26** (the owner, 2026-10-13) **Run-to-run variance, framed.**
  Temperature: `claude -p` takes none (router `claude_code.rs`), Bionic's
  API would (not sent today). **Measured 2026-10-13 on Sonnet**
  (`~/.itsaresume/migrations/variance.mjs`, 5 listings + 5 analyses on a
  frozen listing, same prompt; Bionic was off): SRE offer, listing 13 of 14
  rows in 5/5, scores 75 x4 / 69 (one row, "Go", adjacent 4x, no 1x).
  CLM offer: listing 24 rows stable, the rest varies by **grouping** ("AWS,
  Azure or GCP" one row 4/5, three rows 1/5), optional rows (web servers
  2/5, load balancers 3/5) and French must/nice; analysis scores 58 x3 /
  55, one attempt cut (no JSON, the retry covers it); the skills picked
  per row vary (CV, not score); AD CS adjacent 4/4 (2.25a live).
  **Reading**: the past swings (one offer 5 to 100) came from code and
  profile changes between runs, not the model; the model's own spread is
  ~6 points, mostly from the listing.
  - [x] **2.26a** (2026-10-13) Cache the listing per offer (sha256 of the
    offer text, `<out>/.listings/`, `fileListingCache` in
    `src/listing.js`): one offer is listed once. A cache that cannot be
    read or written is skipped, never fatal. To re-list an offer: delete
    its file there. Sabotaged (content.json).
  - [x] **2.27** (the owner, 2026-10-14) **Gemini and OpenAI in the menu,
    only what can answer shown.** `MODELS` gains `gemini` (`gemini-cli`)
    and `openai`; `modelMenu` judges them like Claude from the router's
    `/status`, which the router's 15-min checks keep fresh (router 8.49);
    unavailable options are hidden, not just greyed. Default: Claude while
    light, then Gemini, then OpenAI, then the slow local model. Sabotaged
    (billing.json, http.json).
  - [x] **2.28a** (the owner, 2026-10-24: "OPS work comes out 'proche'
    instead of OK; 3/h too tight; a comparative run over all models").
    `--per-hour` default 3 → 10 (bin, VM compose, laptop `public.sh`).
    `data/tech.json` gains `tech:operations` (exploitation, MCO, run,
    astreinte, gestion des incidents, support N2/N3, ITIL, on-call…): a
    "yes" through a profile skill of that concept is no longer demoted by
    `grounded()` to "adjacent, to verify". `scripts/compare.mjs` (logic in
    `src/compare.js`): one offer through every backend `/status` says is
    not down (or `--backends a,b`), one table of verdicts, `DIFF` rows
    first, each demotion's reason under its row. Sabotaged (content.json).
    Not verified on a real run: the cloud session had neither the laptop,
    its `qa-log.jsonl` nor the private profile.
  - [x] **2.28c** (2026-10-25) A well-held skill the requirement's own
    concept holds meets it, by code: the model's "adjacent" becomes "yes"
    when the requirement's whole name is a concept label (ESCO or
    `tech.json`) that holds a picked skill at expert, proficient or
    working level, not ruled `near` (`normalize.js`, `STRONG_LEVELS`).
    "SQL" through an expert PostgreSQL: yes (router §9, 8.51 drop);
    "Oracle tuning" through Oracle stays adjacent (an extra word is
    depth); a lab skill stays adjacent. Synthetic tests only; replay on
    the real runs (`rules-replay.mjs`) in 2.28b. Sabotaged (content.json).
  - [x] **2.28b-i** (2026-10-25, cloud) `scripts/replay.mjs --profile
    <profile.json> --out <runs dir>` (logic `src/replay.js`): each stored
    run's own model answers (`raw.json`) fed again to `analyse` with the
    current code, no model call; prints each verdict that changes and the
    score before -> after. Public replacement for the private
    `rules-replay.mjs`. Sabotaged (content.json).
  - [x] **2.28b-ii** (2026-10-25, laptop) The local breakage, found:
    (1) Windows reserves TCP 8773-8872 on the laptop (`netsh interface
    ipv4 show excludedportrange protocol=tcp`, Hyper-V/WSL), so the router
    on 8789 and the page on 8790 fail with os error 10013; use 18789 and
    18790 there. (2) every claude-code run of an offer with a personal
    quality ("Travail avec les DBA") failed: normalize settles a quality
    yes with no skill, `validateAnalysis` refused it. Fixed (analysis.js,
    test in equivalent.test.js, sabotaged in guard.json); the real offer
    now passes on Claude through the local router. Replay: 6 runs, 2
    changed (SRE Paris 69 -> 78, Python / Go merged; deeptech AI 70 -> 67,
    "AI" now adjacent); the two CLM runs are not replayable (the current
    code asks more calls).
  - [x] **2.28b-iii (a)** (2026-10-25) deeptech "AI: adjacent" is honest:
    the profile's AI skills are all `lab`. **(b) waits for the owner**: a
    "SQL" the model marks no goes through the category rule (normalize.js,
    "marked no, the profile holds ...: adjacent"), which runs after the
    2.28c lift, so an expert PostgreSQL never makes it yes. Extending the
    lift to that rule turned 11 tests red: "Cloud public" via AWS, "CI/CD"
    via Jenkins, "IaC" via Terraform, "Observabilité" via Prometheus... all
    would become yes. Owner's call (§10): lift for every category whose
    member is held at working+, or keep categories adjacent and lift only
    when the requirement's name is the skill's own concept (SQL).
  - [ ] **2.28b-iii** On the laptop, router on 127.0.0.1:18789: (a) the
    deeptech run's new "AI: adjacent" (70 -> 67): honest or a missing
    `tech.json` word? (b) Bionic marked "SQL" no on the 2026-10-14 offer,
    code made it adjacent, not yes, although 2.28c should lift an expert
    PostgreSQL: check the profile's PostgreSQL level and the `judged`
    flag; (c) a full `compare.mjs` with claude-code + lm-studio (Gemini
    needs `GEMINI_API_KEY` in the router's environment, router 8.50).
  - [ ] **2.28b** (remaining parts above) Needs a session running ON the laptop (Claude Desktop
    on `D:\GitHub\itsaresume`, or `claude remote-control` there): a cloud
    session sees neither the router, Bionic, the runs nor the profile.
    First `node scripts/replay.mjs --profile <profile.json> --out <runs
    dir>` (2.26b, 2.27b, 2.28a, 2.28c on the real runs), then
    `node scripts/compare.mjs` on a recent OPS offer, then the router
    journal's last `failed` lines. On the laptop: `node scripts/compare.mjs --url
    http://127.0.0.1:8789 --profile <profile.json> --offer <a recent OPS
    offer.txt> --save compare.json`. For each row still "adjacent" with
    "no profile skill names it, the model's reading only", either add the
    word to the right `tech.json` concept (a red test in
    `test/redteam.test.js` naming it, then green) or rule it `same` in
    `links.json` (owner-only). Also: the owner's "doesn't work locally"
    was not reproduced (537 cv tests and the router build green in the
    cloud); first suspects, newest first: #119 `MAX_THINKING_TOKENS=0` on
    the Windows CLI, #117 the schema in the prompt (`extract_json` refusing
    a fenced or prose answer: "claude was asked for JSON and answered").
    Read the router journal's last `failed` lines before guessing.
  - [x] **2.26b** (2026-10-24) Alternatives as one row by code:
    `alternatives()` in `src/text.js` finds, per clause, short items joined
    by commas and at least one "ou"/"or" ("AWS, Azure ou GCP"); "et"/"and"
    and a comma after the "ou" end a run. `mergeExamples` (normalize.js)
    merges them like parenthesised examples, met by the best. Synthetic
    test only (scoring.test.js); the CLM offer itself is private, so its
    rows were not replayed. Sabotaged (content.json, 3 defences).
  - [x] **2.26c** (2026-10-24, router) `temperature` on an `lm-studio`
    backend (`config.rs`, `LmStudioBackend::with_temperature`): sent as
    set, none sent when absent. Sabotaged (router-billing.json). Left for
    the owner: `temperature = 0` in `bionic.local.toml` /
    `sonnet-qwen.local.toml`, then the variance measure (2.26) on Bionic.
    Same PR: the gemini classifier read "429"/"503" inside any number (a
    report file `t4297.json`) as quota/outage; now whole numbers only
    (`has_status`, router-gemini.json). It flaked CI and could have put a
    working Gemini or Claude-relayed error in the wrong bucket.
- [x] **2.27a** (2026-10-14, #120) Done another way, by the owner's ruling
  ("collaboration, communication, pédagogie, travail d'équipe … dynamisme,
  rigueur, sérieux, ponctualité, autonomie … ne peuvent sortir qu'en OK"):
  collaboration and soft-skill words are qualities, a quality is met (yes)
  and stays unscored; an all-caps acronym (DBA) is a team, not a product.
  Replayed on 26 real runs: only the DBA row changes. Open: the page fill
  and the "Profil expérimenté" line below; the Bionic run of the same offer
  scored 90 — its report sits on the VM, not read yet (the auto-mode
  classifier refused the VM read): find which rows cost the 3 more points.
- [ ] **2.27** (the owner, 2026-10-14: "analyser les 10 % manquants") **A
  collaboration requirement met by a profile fact, not a skill.** Real run
  (offer known to be a near-perfect fit, interview passed): 93/100; the 7
  points are one must, "Capacité à travailler avec les DBA", capped to
  adjacent by `src/normalize.js` (`grounded` finds no skill naming "DBA")
  although a profile fact says "collaboration directe avec l'équipe DBA"
  (the model's note and the CV summary quote it). Same cap makes the
  qualification "partially qualified", which is false. Fix: a requirement
  of the form "travailler avec / en lien avec X" is met (yes) when a
  profile fact (bullet or summary fact, by id) contains X's content words;
  the model picks the fact id, the code checks the words. Red test on a
  fictional profile; sabotage: drop the fact check → the test stays red.
  Replay on the real runs (`rules-replay.mjs`) before shipping: list every
  row that changes. Secondary, same run: content fills 84 % of the page
  (goal: full page, see 2.24); "Profil expérimenté" (must, yes) is not on
  the page because no title names it — print the years in the headline or
  summary when such a must is met.
  - [x] **2.27b** (2026-10-25) The secondary point, by code: a must met
    (`yes` or `adjacent`) whose name asks for experience or seniority
    (`ASKS_EXPERIENCE` in `normalize.js`: expérimenté, senior, séniorité,
    "N ans", "N years") puts the profile's first `fact` stating years
    (`STATES_YEARS`) in the summary's supporting place, unless the hook
    already states years; said in the repairs. Verbatim profile text
    only. Sabotaged (guard.json). Owner: a `fact` like "15 ans en
    production." must exist in `profile_facts` for it to act. The page
    fill (84 %) is left to 2.24's measure.
- [ ] **5.x** (the owner, 2026-10-04: "further still") **Matchmaking, N
  offers × M profiles.** Needs 4.1 and the ESCO mapping of 2.25 (offers
  and profiles compared on ESCO concepts). The cost is the model calls: the
  listing is per offer (N calls, cacheable), the analysis per pair (N×M).
  So: **5.1** code first, no model: for every pair, the share of the
  offer's listed requirements the profile's skills name (`relate()` in
  `src/lexicon.js`, ESCO), a matrix written as CSV/Markdown; red tests on
  two synthetic profiles and three corpus offers with a hand-made expected
  ranking. **5.2** the model only on the top K pairs per offer (K set by
  the owner), through the existing pipeline; each pair's tokens from 2.13
  summed, so the bill of a matchmaking run is known before it is run
  (estimate) and after (measure). Measure first: does 5.1's ranking agree
  with the full pipeline's qualification on the corpus? If not, 5.2 is
  not worth its tokens.
  - [x] **5.1** (code, 2026-10-13) `src/matrix.js`: `coverage` (name or
    same concept or same link whole, near half, theme nothing), `matrix`,
    `toCsv`, `toMarkdown`; tested on two synthetic profiles, hand ranking.
    No CLI yet. **Measured** (`matrix-agree.mjs`): Spearman 0.62 between
    coverage and the pipeline's score on the 26 runs; the pipeline itself
    scored one offer 5 to 100 across runs. A pre-filter, not a verdict.

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

- **Seen 2026-10-06 on a real offer (both models, private run in
  `~/.itsaresume/out`): requirements matched to the wrong profile skill by
  name.** "stockage" became yes through the skill `p2p` (both runs), "AI"
  through `alerting` (Sonnet), "SRE" through `devops` (the local model);
  each "named like the profile skill" repair keeps that one skill and drops
  the right ones (PostgreSQL, Prometheus...). The local model also scored
  88 where Sonnet scored 70, and a misspelt requirement ("scalarment")
  passed the stated-in-the-offer rule. Not caused by router 8.46: no
  refusal, no leak (links and the recruiter's name absent from both PDFs).
  2.3b-i closed the terms ("stockage", "AI": a term no longer settles a
  requirement); the shortlist is 2.3b-ii.
- **The owner's own Bionic use** (2026-10-06, not tested): a visitor's
  local job loads qwen3-coder-next (48 GB) at its first request; if the
  owner is using another model in Bionic then, Bionic's JIT eviction may
  unload his, or memory may run short. Measure before calling it safe.
- **From the 2026-10-05 redteam, fixed then** (`cv/redteam-fixes`): the
  auto-deploy built unpushed local commits (a fast-forward to an older
  origin/main succeeds as a no-op); it rebuilt while a CV was being made
  (now waits for `busy: 0` in `/api/status`); a flood of free page loads
  evicted the visitors who owned CVs (empty ones go first now); an
  unreadable `invites.json` was a 500 (fails closed now); two live
  invitations could share a label; a backend named `constructor` reached
  a prototype in the token sums. **Left open:** a failed build is retried
  every 5 minutes with no backoff and no image prune (disk); finished
  jobs are never dropped from memory (`jobs` grows with reused offers);
  the visitors, caps and bans live in memory, so every deploy resets the
  daily cap and loses visitors' lists; `createInvite`/`revokeInvite` run
  at the same time can lose one update (no lock: the owner runs one at a
  time); calls that fail before an answer count no tokens.

- The VM deploys whatever `main` holds (3.5): the gate is the CI that a
  merge needs, nothing after it. No rollback but a revert on `main`; a
  failed build leaves the running containers as they were.

- An invitation code rides in the URL (`?i=`): it stays in the visitor's
  history and address bar and in the VM's Caddy access log. 96 random
  bits, revocable at once (2.16); not hidden further on purpose.

- The honesty checks cannot judge a plausible sentence made of the profile's
  own words; the owner reads the report, and the tool sends nothing.
- A judged match ("à vérifier") trusts the model at half weight; an injected
  offer could raise the score by at most that, never the qualification.

## 10. Waiting for the owner

In `~/.itsaresume/HANDOVER-prive.md` (private).
