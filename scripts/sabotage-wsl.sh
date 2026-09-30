#!/usr/bin/env bash
# The whole sabotage plan under WSL, from Git Bash on Windows: the
# `unix_only` defences (tests under #[cfg(unix)]) cannot go red on Windows,
# and `sabotage.py` skips them there. Run this before pushing a change that
# touches one; the Linux CI job verifies them too.
#
#   bash scripts/sabotage-wsl.sh [plan.json ...]
#
# Needs cargo and python3 inside the default WSL distribution. The build goes
# to a Linux-side target directory: the Windows one holds .exe files, and
# /mnt/<drive> is slow.

set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd -W 2>/dev/null || pwd)
linux_root=$(wsl -e wslpath -a "$root")
# -D warnings as in CI: a dead line that leaves a variable unused must fail
# here, not 16 minutes into the CI job (seen 2026-09-30).
exec wsl -e bash -lc "cd '$linux_root' && RUSTFLAGS='-D warnings' CARGO_TARGET_DIR=\$HOME/.cache/itsaresume-target python3 scripts/sabotage.py $*"
