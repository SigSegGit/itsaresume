#!/usr/bin/env bash
# The sabotage plans of one tree in N shards side by side, each in a detached
# worktree of HEAD (2026-11-23: one sequential pass of the generator's plans
# took 45 minutes on the laptop). The tree being worked on is never
# sabotaged: a killed run leaves a sabotaged file only in a temporary
# worktree, removed here. Commit first.
#
#   bash scripts/sabotage-parallel.sh cv [plan.json ...]     (plans relative to cv/; default 6 shards)
#   bash scripts/sabotage-parallel.sh root [plan.json ...]   (plans relative to the root; default 3 shards,
#                                                             each with its own cargo target)
#   SABOTAGE_JOBS=8 bash scripts/sabotage-parallel.sh cv
set -u
root=$(git rev-parse --show-toplevel)
py=$(command -v python3 || command -v python)
tree=${1:-}
case "$tree" in
    cv) sub=cv; jobs=${SABOTAGE_JOBS:-6} ;;
    root) sub=.; jobs=${SABOTAGE_JOBS:-3} ;;
    *) echo "usage: sabotage-parallel.sh cv|root [plan.json ...]"; exit 2 ;;
esac
shift
[ "$tree" = root ] || [ -d "$root/cv/node_modules" ] || { echo "sabotage-parallel: run npm ci in cv/ first"; exit 2; }
work=$(mktemp -d)
cleanup() {
    for dir in "$work"/w*; do
        [ -d "$dir" ] || continue
        if [ -e "$dir/cv/node_modules" ]; then
            if [ "${OS:-}" = Windows_NT ]; then
                MSYS2_ARG_CONV_EXCL="*" cmd /c rmdir "$(cygpath -w "$dir/cv/node_modules")" >/dev/null 2>&1
            else
                rm -f "$dir/cv/node_modules"
            fi
        fi
        git -C "$root" worktree remove --force "$dir" >/dev/null 2>&1
    done
    git -C "$root" worktree prune >/dev/null 2>&1
    rm -rf "$work"
}
trap cleanup EXIT INT TERM

link_modules() {  # the worktree's cv/node_modules is the clone's (a junction on Windows)
    if [ "${OS:-}" = Windows_NT ]; then
        MSYS2_ARG_CONV_EXCL="*" cmd /c mklink /J "$(cygpath -w "$1/cv/node_modules")" "$(cygpath -w "$root/cv/node_modules")" >/dev/null
    else
        ln -s "$root/cv/node_modules" "$1/cv/node_modules"
    fi
}

pids=()
for i in $(seq 0 $((jobs - 1))); do
    dir="$work/w$i"
    git -C "$root" worktree add --detach -q "$dir" HEAD || { echo "sabotage-parallel: worktree $i failed"; exit 1; }
    if [ "$tree" = cv ]; then
        link_modules "$dir" || { echo "sabotage-parallel: node_modules link $i failed"; exit 1; }
    fi
    (cd "$dir/$sub" && CARGO_TARGET_DIR="$work/target$i" "$py" scripts/sabotage.py --shard "$i/$jobs" "$@" > "$work/out$i.txt" 2>&1; echo $? > "$work/code$i") &
    pids+=($!)
done
wait "${pids[@]}"

failed=0
verified=0
for i in $(seq 0 $((jobs - 1))); do
    code=$(cat "$work/code$i" 2>/dev/null || echo 1)
    grep -E "^(FAIL|skip|REFUSED|BASELINE|AFTER RESTORE)" "$work/out$i.txt" | sed "s/^/[$tree $i] /"
    n=$(sed -n 's/^\([0-9]*\) defence(s) verified.*/\1/p' "$work/out$i.txt")
    verified=$((verified + ${n:-0}))
    if [ "$code" != 0 ]; then
        failed=1
        grep -q "^FAIL" "$work/out$i.txt" || tail -15 "$work/out$i.txt" | sed "s/^/[$tree $i] /"
    fi
done
if [ "$failed" -ne 0 ]; then
    echo "sabotage-parallel: a $tree shard failed (above)."
    exit 1
fi
echo "sabotage-parallel: $verified $tree defence(s) verified in $jobs shards."
