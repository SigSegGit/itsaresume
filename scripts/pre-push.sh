#!/usr/bin/env bash
# The fast gates, before a push: the ones that failed a CI run on 2026-09-30
# after a command chain went on past them (a stale TESTING.md, a sabotage
# anchor edited away). Seconds here, 16 to 35 minutes in CI.
#
# Install once per clone:  cp scripts/pre-push.sh .git/hooks/pre-push
# (a worktree shares the clone's hooks).

set -u
root=$(git rev-parse --show-toplevel)
cd "$root" || exit 1
failed=0
run() {
    if ! out=$("$@" 2>&1); then
        echo "pre-push: $* failed:"
        printf '%s\n' "$out" | tail -5
        failed=1
    fi
}
run python scripts/check-testing.py
run python scripts/check-handover.py
if [ -d cv ]; then
    cd cv && run python scripts/catalogue.py --check; cd "$root"
fi
[ "$failed" -eq 0 ] || { echo "pre-push: refused; fix the above, then push."; exit 1; }
