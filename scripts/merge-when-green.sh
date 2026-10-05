#!/usr/bin/env bash
# Merge a pull request only when *every* CI check has passed; refuse otherwise.
#
# Why this exists
# ---------------
# Inherited from ITSaNAS, where a PR was merged with two checks still running
# because of this shell:
#
#     gh pr checks 59 | grep -civ pass && gh pr merge 59 ...
#
# `grep -c` exits 0 when it *finds* matches, so finding non-passing lines ran
# the merge. A gate has to say "all of them passed", never "I did not see a
# failure". So this counts what passed, counts what exists, and merges only if
# the two are equal and there are at least as many as the real suite has.
#
# Merge commits, not squash: the red-then-green commit pairs are the record
# that each test was written before the code it drives (docs/HANDOVER.md §1).
#
#   bash scripts/merge-when-green.sh <pr-number> [minimum-checks]

set -uo pipefail

PR=${1:-}
# The jobs in .github/workflows/ci.yml: changes, fmt, clippy, test (ubuntu),
# test (windows), doc, sabotage, docker, handover, cv-test (ubuntu), cv-test
# (windows), cv-catalogue, cv-sabotage. Change this with the workflow.
MINIMUM=${2:-13}

[ -n "$PR" ] || { echo "usage: merge-when-green.sh <pr-number> [minimum-checks]"; exit 2; }

# The head is read *before* the checks are counted, and the merge names it:
# a push in between makes GitHub refuse the merge instead of merging a head
# whose checks were never counted.
head=$(gh pr view "$PR" --json headRefOid --jq .headRefOid 2>/dev/null) || true
[ -n "$head" ] || { echo "PR $PR: could not read its head commit."; exit 1; }

checks=$(gh pr checks "$PR" 2>&1) || true

if printf '%s' "$checks" | grep -q "no checks reported"; then
    echo "PR $PR: no checks have reported yet. Nothing has been verified."
    exit 1
fi

total=$(printf '%s\n' "$checks" | grep -c .)
passing=$(printf '%s\n' "$checks" | grep -c $'\tpass\t')
# One workflow, filtered by path (2026-10-06): a job the `changes` job
# skipped did not need to run. A skip counts only when `changes` passed.
if printf '%s\n' "$checks" | grep -q $'^changes\tpass\t'; then
    passing=$((passing + $(printf '%s\n' "$checks" | grep -c $'\tskipping\t')))
fi

if [ "$total" -lt "$MINIMUM" ]; then
    echo "PR $PR: only $total checks are reporting, and the suite has $MINIMUM."
    echo "Some have not started. Waiting is the answer; merging is not."
    exit 1
fi

if [ "$passing" -ne "$total" ]; then
    echo "PR $PR: $passing of $total checks passed. These are not green:"
    printf '%s\n' "$checks" | grep -v $'\tpass\t' | sed 's/^/  /'
    echo "Red, pending and skipped are all 'not green'. Fix or wait."
    exit 1
fi

echo "PR $PR: $passing of $total checks passed. Merging $head."
gh pr merge "$PR" --merge --delete-branch --match-head-commit "$head"
