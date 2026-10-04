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
if ! git merge --ff-only --quiet origin/main 2>/dev/null; then
    echo "auto-deploy: main has commits origin/main does not: not deploying" >&2
    exit 1
fi

head=$(git rev-parse HEAD)
if [ "$(cat "$state" 2>/dev/null)" = "$head" ]; then
    exit 0
fi
docker compose -f "$compose" up -d --build
echo "$head" > "$state"
echo "auto-deploy: deployed $head"
