#!/usr/bin/env bash
# scripts/sabotage-select.py against a throwaway git repository (8.46): which
# sabotage plans a change needs, and the check that every plan names the
# files its defences depend on. Never narrower than sure: a file no plan
# names, the sabotage script, a workflow or an unknown base runs all.
set -u
here=$(cd "$(dirname "$0")" && pwd)
py=python3
"$py" -c '' 2>/dev/null || py=python
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work" && git init -q && git config user.email t@t && git config user.name t
mkdir -p scripts/sabotage crates/r/src crates/r/tests cv/scripts/sabotage cv/src cv/test/fixtures docs .github/workflows
plan() {  # path, surface, command (json), files (json), defences (json)
    printf '{"surface": "%s", "command": %s, "files": %s, "defences": %s}\n' "$2" "$3" "$4" "$5" > "$1"
}
cargo='["cargo", "test", "--no-fail-fast"]'
node='["node", "--test"]'
plan scripts/sabotage/r1.json billing "$cargo" '["crates/r/src/a.rs", "crates/r/tests/a.rs"]' \
    '{"a": {"file": "crates/r/src/a.rs", "live": "x", "dead": "y", "expect": ["t_a"]}}'
plan scripts/sabotage/r2.json http "$cargo" '["crates/r/src/b.rs", "crates/r/tests/a.rs"]' \
    '{"b": {"file": "crates/r/src/b.rs", "live": "x", "dead": "y", "expect": ["t_b"]}}'
plan cv/scripts/sabotage/c1.json guard "$node" '["src/g.js", "test/g.test.js"]' \
    '{"g": {"file": "src/g.js", "live": "x", "dead": "y", "expect": ["g holds"]}}'
plan cv/scripts/sabotage/c2.json injection "$node" '["src/p.js", "test/g.test.js"]' \
    '{"p": {"file": "src/p.js", "live": "x", "dead": "y", "expect": ["p holds"]}}'
echo 'fn t_a() {} fn t_b() {}' > crates/r/tests/a.rs
printf "test('g holds', () => {});\ntest('p holds', () => {});\n" > cv/test/g.test.js
for f in crates/r/src/a.rs crates/r/src/b.rs crates/r/src/other.rs scripts/sabotage.py \
         cv/scripts/sabotage.py cv/src/g.js cv/src/p.js cv/src/other.js \
         cv/test/fixtures/offer.md docs/X.md .github/workflows/ci.yml; do echo x > "$f"; done
git add -A && git commit -qm base
base=$(git rev-parse HEAD)
failures=0
report() {  # name, got, expected
    if [ "$2" = "$3" ]; then echo "test $1 ... ok"; else echo "  got: $2"; echo "test $1 ... FAILED"; failures=$((failures + 1)); fi
}
select_() { "$py" "$here/sabotage-select.py" "$@" 2>&1 | tr -d '\r' | tr '\n' ' '; }
check() {  # name, files to change, expected output
    git checkout -q "$base" 2>/dev/null
    for f in $2; do echo y >> "$f"; done
    git commit -qam change
    report "$1" "$(select_ "$base")" "$3"
}
all_root="sabotage_root=scripts/sabotage/r1.json scripts/sabotage/r2.json"
all_cv="sabotage_cv=scripts/sabotage/c1.json scripts/sabotage/c2.json"
check a_named_file_selects_only_its_plan "crates/r/src/a.rs" "sabotage_root=scripts/sabotage/r1.json sabotage_cv= "
check a_test_file_selects_every_plan_naming_it "cv/test/g.test.js" "sabotage_root= $all_cv "
check a_cv_source_selects_its_cv_plan "cv/src/p.js" "sabotage_root= sabotage_cv=scripts/sabotage/c2.json "
check a_file_no_plan_names_runs_its_whole_tree "crates/r/src/other.rs" "$all_root sabotage_cv= "
check a_cv_file_no_plan_names_runs_all_cv "cv/src/other.js" "sabotage_root= $all_cv "
check docs_run_no_plan "docs/X.md" "sabotage_root= sabotage_cv= "
check a_test_fixture_in_markdown_is_not_docs "cv/test/fixtures/offer.md" "sabotage_root= $all_cv "
check a_changed_plan_runs_itself "scripts/sabotage/r2.json" "sabotage_root=scripts/sabotage/r2.json sabotage_cv= "
check the_sabotage_script_runs_its_whole_tree "cv/scripts/sabotage.py" "sabotage_root= $all_cv "
check a_workflow_change_runs_every_plan ".github/workflows/ci.yml" "$all_root $all_cv "
git checkout -q "$base" 2>/dev/null
report an_unknown_base_runs_every_plan "$(select_ "")" "$all_root $all_cv "
report a_new_branch_runs_every_plan "$(select_ 0000000000000000000000000000000000000000)" "$all_root $all_cv "
report a_base_git_cannot_diff_runs_every_plan "$(select_ 1234567890123456789012345678901234567890)" "$all_root $all_cv "

# --check: a plan must name the file each defence breaks and the test files
# that hold its named tests, or a change to them would skip the plan.
"$py" "$here/sabotage-select.py" --check >/dev/null 2>&1
report complete_plans_pass_the_check "$?" "0"
plan scripts/sabotage/r2.json http "$cargo" '["crates/r/tests/a.rs"]' \
    '{"b": {"file": "crates/r/src/b.rs", "live": "x", "dead": "y", "expect": ["t_b"]}}'
out=$("$py" "$here/sabotage-select.py" --check 2>&1); code=$?
report a_plan_missing_its_broken_file_fails_the_check "$code $(echo "$out" | grep -c 'crates/r/src/b.rs')" "1 1"
git checkout -q -- scripts/sabotage/r2.json
plan cv/scripts/sabotage/c2.json injection "$node" '["src/p.js"]' \
    '{"p": {"file": "src/p.js", "live": "x", "dead": "y", "expect": ["p holds"]}}'
out=$("$py" "$here/sabotage-select.py" --check 2>&1); code=$?
report a_plan_missing_its_test_file_fails_the_check "$code $(echo "$out" | grep -c 'test/g.test.js')" "1 1"
git checkout -q -- cv/scripts/sabotage/c2.json
plan cv/scripts/sabotage/c2.json injection "$node" '["src/p.js", "test/g.test.js"]' \
    '{"p": {"file": "src/p.js", "live": "x", "dead": "y", "expect": ["no such test"]}}'
out=$("$py" "$here/sabotage-select.py" --check 2>&1); code=$?
report a_test_found_nowhere_fails_the_check "$code $(echo "$out" | grep -c 'no such test')" "1 1"
git checkout -q -- cv/scripts/sabotage/c2.json
plan cv/scripts/sabotage/c2.json "" "$node" '["src/p.js", "test/g.test.js"]' \
    '{"p": {"file": "src/p.js", "live": "x", "dead": "y", "expect": ["p holds"]}}'
"$py" "$here/sabotage-select.py" --check >/dev/null 2>&1
report a_plan_without_a_surface_fails_the_check "$?" "1"
git checkout -q -- cv/scripts/sabotage/c2.json
[ "$failures" -eq 0 ] && echo "sabotage-select: 18 cases pass" || exit 1
