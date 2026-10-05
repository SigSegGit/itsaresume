#!/usr/bin/env bash
# scripts/ci-changes.sh against a throwaway git repository: which job groups
# of the one CI workflow a change needs (2026-10-06). Never narrower than
# sure: an unknown base, or a change to the workflow itself, runs all.
set -u
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work" && git init -q && git config user.email t@t && git config user.name t
mkdir -p cv/src crates/r/src docs .github/workflows
echo a > cv/src/a.js; echo b > crates/r/src/lib.rs; echo c > docs/HANDOVER.md; echo d > .github/workflows/ci.yml
git add -A && git commit -qm base
base=$(git rev-parse HEAD)
failures=0
check() {  # name, files to change, expected output
    git checkout -q "$base" 2>/dev/null
    for f in $2; do echo x >> "$f"; done
    git commit -qam change
    got=$(bash "$here/ci-changes.sh" "$base" | tr '\n' ' ')
    if [ "$got" = "$3" ]; then echo "test $1 ... ok"; else echo "test $1 ... FAILED (got: $got)"; failures=$((failures + 1)); fi
}
check a_cv_change_runs_only_cv "cv/src/a.js" "rust=false cv=true "
check a_crate_change_runs_only_rust "crates/r/src/lib.rs" "rust=true cv=false "
check a_docs_change_runs_neither "docs/HANDOVER.md" "rust=false cv=false "
check a_workflow_change_runs_both "cv/src/a.js .github/workflows/ci.yml" "rust=true cv=true "
got=$(bash "$here/ci-changes.sh" "" | tr '\n' ' ')
[ "$got" = "rust=true cv=true " ] && echo "test an_unknown_base_runs_both ... ok" || { echo "test an_unknown_base_runs_both ... FAILED (got: $got)"; failures=$((failures + 1)); }
got=$(bash "$here/ci-changes.sh" 0000000000000000000000000000000000000000 | tr '\n' ' ')
[ "$got" = "rust=true cv=true " ] && echo "test a_new_branch_runs_both ... ok" || { echo "test a_new_branch_runs_both ... FAILED (got: $got)"; failures=$((failures + 1)); }
[ "$failures" -eq 0 ] && echo "ci-changes: 6 cases pass" || exit 1
