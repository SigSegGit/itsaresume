#!/usr/bin/env bash
# sabotage.py --shard I/N (2026-11-23), in a throwaway git repository, for both
# trees' copies of the script: the N shards run every defence exactly once,
# a shard skips the plans it has nothing of, and a bad I/N is refused.
set -u
here=$(cd "$(dirname "$0")" && pwd)
py=python3
"$py" -c '' 2>/dev/null || py=python
fails=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got [$2], wanted [$3]"; fails=$((fails + 1)); fi; }

for script in "$here/sabotage.py" "$here/../cv/scripts/sabotage.py"; do
    work=$(mktemp -d)
    (
        cd "$work" && git init -q
        mkdir -p scripts/sabotage
        # The script's tree is its parent folder: a copy runs on this one.
        cp "$script" scripts/sabotage.py
        # A command that is always green: every defence comes out FAIL, named.
        cmd='["'"$py"'", "-c", "pass"]'
        printf 'x1 x2 x3 x4 x5\n' > a.txt
        printf '{"surface": "s", "command": %s, "files": ["a.txt"], "defences": {"d1": {"file": "a.txt", "live": "x1", "dead": "y", "expect": ["t"]}, "d2": {"file": "a.txt", "live": "x2", "dead": "y", "expect": ["t"]}, "d3": {"file": "a.txt", "live": "x3", "dead": "y", "expect": ["t"]}}}\n' "$cmd" > scripts/sabotage/p1.json
        printf '{"surface": "s", "command": %s, "files": ["a.txt"], "defences": {"d4": {"file": "a.txt", "live": "x4", "dead": "y", "expect": ["t"]}, "d5": {"file": "a.txt", "live": "x5", "dead": "y", "expect": ["t"]}}}\n' "$cmd" > scripts/sabotage/p2.json
    )
    names() { (cd "$work" && "$py" scripts/sabotage.py "$@" scripts/sabotage/p1.json scripts/sabotage/p2.json 2>&1) | sed -n 's/^FAIL \(d[0-9]\)$/\1/p' | sort | tr '\n' ' '; }
    all=$(names)
    s0=$(names --shard 0/2)
    s1=$(names --shard 1/2)
    tag=$(basename "$(dirname "$(dirname "$script")")")
    check "$tag: without a shard every defence runs" "$all" "d1 d2 d3 d4 d5 "
    check "$tag: shard 0/2" "$s0" "d1 d3 d5 "
    check "$tag: shard 1/2" "$s1" "d2 d4 "
    check "$tag: SABOTAGE_SHARD as well" "$(SABOTAGE_SHARD=1/2 names)" "d2 d4 "
    out=$(cd "$work" && "$py" scripts/sabotage.py --shard 2/2 scripts/sabotage/p1.json 2>&1); code=$?
    check "$tag: I must be below N" "$code $(printf '%s' "$out" | grep -c REFUSED)" "2 1"
    check "$tag: the file is restored" "$(cat "$work/a.txt")" "x1 x2 x3 x4 x5"
    rm -rf "$work"
done
[ "$fails" -eq 0 ] && echo "sabotage shards: all cases pass" || { echo "$fails case(s) failed"; exit 1; }
