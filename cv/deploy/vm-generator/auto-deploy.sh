#!/usr/bin/env bash
# Pull-based deploy for the VM (cv HANDOVER 3.5): run by a systemd timer on
# the VM itself, so no key or address of the VM ever leaves it. When
# origin/main has moved, fast-forward the checkout and rebuild the stack;
# refuse, loudly, whatever cannot be fast-forwarded (local edits, local
# commits, another branch): those are a person's, never overwritten.
#
#   cv/deploy/vm-generator/auto-deploy.sh      # DATA= as for compose
set -euo pipefail

repo=$(cd "$(dirname "$0")/../../.." && pwd)
compose="$repo/cv/deploy/vm-generator/compose.yaml"
# The last commit built and started, so a failed build is tried again.
state="$repo/.git/itsacv-deployed"
cd "$repo"

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != main ]; then
    echo "auto-deploy: $repo is on $branch, not main: not deploying" >&2
    exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "auto-deploy: $repo has local changes: not deploying" >&2
    exit 1
fi
git fetch --quiet origin main
# A commit origin/main lacks is a person's: never built, ahead or diverged.
if [ -n "$(git rev-list origin/main..HEAD)" ]; then
    echo "auto-deploy: main has commits origin/main does not: not deploying" >&2
    exit 1
fi
if ! git merge --ff-only --quiet origin/main; then
    echo "auto-deploy: cannot fast-forward to origin/main (see above): not deploying" >&2
    exit 1
fi

head=$(git rev-parse HEAD)
if [ "$(cat "$state" 2>/dev/null)" = "$head" ]; then
    exit 0
fi
# A rebuild restarts the generator and kills a CV being made: wait for an
# idle one ("busy": jobs running or queued). Unreachable: deploy anyway.
status=$(curl -fsS --max-time 5 "${ITSACV_STATUS_URL:-http://127.0.0.1:18790/api/status}" 2>/dev/null || true)
if printf '%s' "$status" | grep -Eq '"busy":[1-9]'; then
    echo "auto-deploy: $head waits: a CV is being generated"
    exit 0
fi
# 2.44: a failed build waits before the next try, 5 minutes doubled at
# each failure of the same commit (6 hours at most); a new commit is built
# at once. The record: "<commit> <failures> <unix time of the last one>".
failed="$state.failed"
now=${ITSACV_NOW:-$(date +%s)}
read -r failed_head failures failed_at < "$failed" 2>/dev/null || true
if [ "${failed_head:-}" = "$head" ]; then
    wait=$((300 << (failures - 1)))
    [ "$wait" -gt 21600 ] && wait=21600
    if [ "$now" -lt $((failed_at + wait)) ]; then
        echo "auto-deploy: $head failed $failures time(s): next try in $((failed_at + wait - now)) s"
        exit 0
    fi
else
    failures=0
fi
if ! docker compose -f "$compose" up -d --build; then
    echo "$head $((failures + 1)) $now" > "$failed"
    echo "auto-deploy: building $head failed (failure $((failures + 1)))" >&2
    exit 1
fi
rm -f "$failed"
echo "$head" > "$state"
echo "auto-deploy: deployed $head"
# The layers of replaced images (dangling) only fill the disk.
docker image prune -f > /dev/null || echo "auto-deploy: the image prune failed" >&2
