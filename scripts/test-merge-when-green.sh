#!/usr/bin/env bash
# merge-when-green.sh against a fake `gh` on PATH: it merges only when every
# check passed, and only the head it counted the checks for.
#
#   bash scripts/test-merge-when-green.sh

set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# The fake: `gh pr view` prints the head sha from $work/head, `gh pr checks`
# prints $work/checks (then moves the head to $work/head-after if that exists,
# as a push while counting would), `gh pr merge` records its arguments.
cat > "$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
case "$1 $2" in
  "pr view") cat "$FAKE_DIR/head"; exit 0 ;;
  "pr checks") cat "$FAKE_DIR/checks"
               [ -f "$FAKE_DIR/head-after" ] && cp "$FAKE_DIR/head-after" "$FAKE_DIR/head"
               exit 0 ;;
  "pr merge") echo "$*" > "$FAKE_DIR/merged"; exit 0 ;;
esac
exit 1
FAKE
chmod +x "$work/bin/gh"
export FAKE_DIR=$work PATH="$work/bin:$PATH"

# Output in cargo's shape (`test <name> ... ok|FAILED`) so that
# scripts/sabotage.py can name the case a sabotage turned red.
failures=0
case_ok=1
fail() { echo "  $1"; case_ok=0; }
report() {
    if [ "$case_ok" -eq 1 ]; then echo "test $1 ... ok"; else echo "test $1 ... FAILED"; failures=$((failures + 1)); fi
    case_ok=1
}

green() {
    : > "$work/checks"
    for i in $(seq 1 12); do printf 'job%s\tpass\t1m\thttps://x\n' "$i" >> "$work/checks"; done
}

# 1. All green: merges, pinned to the head it saw.
green; echo aaa111 > "$work/head"; rm -f "$work/merged" "$work/head-after"
bash "$here/merge-when-green.sh" 7 >/dev/null
grep -q -- "--match-head-commit aaa111" "$work/merged" 2>/dev/null \
    || fail "a green merge is not pinned to the counted head: $(cat "$work/merged" 2>/dev/null)"
report a_green_pr_is_merged_pinned_to_its_head

# 2. One pending: no merge.
green; printf 'job13\tpending\t0\thttps://x\n' >> "$work/checks"; rm -f "$work/merged"
bash "$here/merge-when-green.sh" 7 >/dev/null && fail "a pending check did not stop the merge"
[ -f "$work/merged" ] && fail "merged with a pending check"
report a_pending_check_stops_the_merge

# 3. Too few checks: no merge.
: > "$work/checks"; printf 'job1\tpass\t1m\thttps://x\n' > "$work/checks"; rm -f "$work/merged"
bash "$here/merge-when-green.sh" 7 >/dev/null && fail "one check out of twelve was enough"
[ -f "$work/merged" ] && fail "merged with too few checks"
report too_few_checks_stop_the_merge

# 4. The head is read before the checks: a push in between is not merged
#    under the old head's green (the merge names the counted sha, gh refuses).
green; echo bbb222 > "$work/head"; echo ccc333 > "$work/head-after"; rm -f "$work/merged"
bash "$here/merge-when-green.sh" 7 >/dev/null
grep -q -- "--match-head-commit bbb222" "$work/merged" 2>/dev/null \
    || fail "the merge did not name the head read before the checks: $(cat "$work/merged" 2>/dev/null)"
report the_head_is_read_before_the_checks

[ "$failures" -eq 0 ] && echo "merge-when-green: 4 cases pass" || exit 1
