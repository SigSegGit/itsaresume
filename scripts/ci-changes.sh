#!/usr/bin/env bash
# Which job groups of the one CI workflow a change needs (2026-10-06), for
# GITHUB_OUTPUT: `rust=true|false` and `cv=true|false`.
#
#   scripts/ci-changes.sh <base sha>     # the PR's base, or the push's "before"
#
# cv/ is the generator; everything else but docs is the router. A change to
# a workflow runs both. Never narrower than sure: no base, a new branch
# (all zeros) or a base git cannot diff against runs both.
set -u
base=${1:-}
both() { echo "rust=true"; echo "cv=true"; exit 0; }
# An empty base would diff HEAD with itself: nothing, so nothing would run.
[ -n "$base" ] || both
files=$(git diff --name-only "$base"...HEAD 2>/dev/null) || both
rust=false
cv=false
while IFS= read -r file; do
    case "$file" in
        '') ;;
        .github/workflows/*) both ;;
        cv/*) cv=true ;;
        docs/*|*.md) ;;
        *) rust=true ;;
    esac
done <<< "$files"
echo "rust=$rust"
echo "cv=$cv"
