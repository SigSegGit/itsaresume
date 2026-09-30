#!/usr/bin/env bash
# The whole sabotage plan under WSL, from Git Bash on Windows: the
# `unix_only` defences (tests under #[cfg(unix)]) cannot go red on Windows,
# and `sabotage.py` skips them there. Run this before pushing a change that
# touches one; the Linux CI job verifies them too.
#
#   bash scripts/sabotage-wsl.sh [plan.json ...]   (plans relative to the root)
#
# It runs on the committed HEAD, in a detached worktree of its own, removed
# at the end: a run that hangs or is killed leaves a sabotaged file there,
# never in the tree being worked on (seen 2026-09-30: a hung run held a
# sabotaged server.rs, then rewrote files after a branch switch). Commit
# first.
#
# Needs cargo and python3 inside the default WSL distribution. The build goes
# to a Linux-side target directory: the Windows one holds .exe files, and
# /mnt/<drive> is slow.

set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/itsaresume-sabotage-XXXXXX")
rmdir "$work"
git -C "$root" worktree add -q --detach "$work" HEAD
cleanup() { git -C "$root" worktree remove --force "$work" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# Plans given as files not in HEAD (a partial plan in target/) are copied in.
plans=()
for plan in "$@"; do
    mkdir -p "$work/$(dirname "$plan")"
    cp "$root/$plan" "$work/$plan"
    plans+=("$plan")
done
win_work=$(cd "$work" && pwd -W 2>/dev/null || pwd)
linux_work=$(wsl -e wslpath -a "$win_work")
# -D warnings as in CI: a dead line that leaves a variable unused must fail
# here, not 16 minutes into the CI job (seen 2026-09-30).
wsl -e bash -lc "cd '$linux_work' && RUSTFLAGS='-D warnings' CARGO_TARGET_DIR=\$HOME/.cache/itsaresume-target python3 scripts/sabotage.py ${plans[*]:-}"
