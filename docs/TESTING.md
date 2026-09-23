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

*No tests yet — the scaffold (M0) holds none. Each M1 step adds its rows.*

| Test | File | Property | Sabotage |
|---|---|---|---|
