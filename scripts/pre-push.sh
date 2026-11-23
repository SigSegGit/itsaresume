#!/usr/bin/env bash
# The CI's gates before a push, for the parts this branch touches: of the 14
# CI failures from 2026-10-13 to 2026-11-20, every one was a gate this hook
# skipped (a sabotage defence gone decorative or a test renamed under it, 6;
# the handover job's consistency checks, 4; the tests, 3; the catalogue, 1).
# Minutes here, 16 to 35 minutes per CI round there.
#
# Install once per clone (it then follows this file):
#   printf '#!/bin/sh\nexec bash scripts/pre-push.sh\n' > .git/hooks/pre-push
#
# SKIP_SABOTAGE=1 git push   skips only the sabotage plans (say so in the PR).
# PREPUSH_BASE=<sha>         compares with that instead of origin/main.

set -u
root=$(git rev-parse --show-toplevel)
cd "$root" || exit 1
py=$(command -v python3 || command -v python)
failed=0
step() { printf 'pre-push: %s\n' "$*"; }
run() {
    if ! out=$("$@" 2>&1); then
        step "FAILED: $*"
        printf '%s\n' "$out" | tail -12
        failed=1
    fi
}

base=${PREPUSH_BASE:-$(git merge-base HEAD origin/main 2>/dev/null)}
changes=$(bash scripts/ci-changes.sh "$base" 2>/dev/null)
rust=$(printf '%s\n' "$changes" | sed -n 's/^rust=//p')
cv=$(printf '%s\n' "$changes" | sed -n 's/^cv=//p')
step "base ${base:0:10}: rust=${rust:-true} cv=${cv:-true}"

# The handover job, always (seconds).
run "$py" scripts/check-handover.py
run "$py" scripts/check-testing.py
run "$py" scripts/sabotage-select.py --check
run "$py" scripts/check-workflow.py

if [ "${cv:-true}" = true ] && [ -d cv ]; then
    run sh -c "cd cv && $py scripts/catalogue.py --check"
    run sh -c "cd cv/deploy/micro-ai/gateway && $py -m unittest -q"
    step "cv: npm test"
    if ! out=$(cd cv && npm test 2>&1); then
        step "FAILED: npm test (cv)"
        printf '%s\n' "$out" | grep -E "^✖|^not ok|AssertionError" | head -15
        failed=1
    fi
fi
if [ "${rust:-true}" = true ]; then
    run cargo fmt --all --check
fi
[ "$failed" -eq 0 ] || { step "refused; fix the above, then push."; exit 1; }

# The sabotage plans the CI will select for this branch.
if [ "${SKIP_SABOTAGE:-0}" = 1 ]; then
    step "sabotage SKIPPED (SKIP_SABOTAGE=1): the CI will run it."
    exit 0
fi
plans=$("$py" scripts/sabotage-select.py "$base")
cv_plans=$(printf '%s\n' "$plans" | sed -n 's/^sabotage_cv=//p')
root_plans=$(printf '%s\n' "$plans" | sed -n 's/^sabotage_root=//p')
if [ -n "$root_plans" ]; then
    step "sabotage (router): $root_plans"
    # shellcheck disable=SC2086
    out=$("$py" scripts/sabotage.py $root_plans 2>&1) || { printf '%s\n' "$out" | grep -E "^(FAIL|DECORATIVE|REFUSED)|NOT verified" | head -10; failed=1; }
fi
if [ -n "$cv_plans" ]; then
    step "sabotage (cv): $cv_plans"
    # shellcheck disable=SC2086
    out=$(cd cv && "$py" scripts/sabotage.py $cv_plans 2>&1) || { printf '%s\n' "$out" | grep -E "^(FAIL|DECORATIVE|REFUSED)|NOT verified" | head -10; failed=1; }
fi
[ "$failed" -eq 0 ] || { step "refused: a sabotage defence is not verified (above)."; exit 1; }
step "ok"
