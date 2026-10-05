#!/usr/bin/env bash
# auto-deploy.sh against a real git repository (a bare "origin" and its
# clone, as on the VM) and a fake `docker` on PATH that records its calls.
#
#   bash cv/deploy/vm-generator/test-auto-deploy.sh

set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# The fake: records each call, fails when $FAKE_DIR/docker-fails exists.
cat > "$work/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_DIR/docker-calls"
[ -f "$FAKE_DIR/docker-fails" ] && exit 1
exit 0
FAKE
chmod +x "$work/bin/docker"
export FAKE_DIR=$work PATH="$work/bin:$PATH"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.org GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.org

# Output in cargo's shape so that scripts/sabotage.py can name a red case.
failures=0
case_ok=1
fail() { echo "  $1"; case_ok=0; }
report() {
    if [ "$case_ok" -eq 1 ]; then echo "test $1 ... ok"; else echo "test $1 ... FAILED"; failures=$((failures + 1)); fi
    case_ok=1
}

# A fresh origin with one commit, cloned as the VM's checkout; the script
# under test runs from the clone, as the timer would run it.
fresh() {
    rm -rf "$work/origin.git" "$work/seed" "$work/vm" "$work/docker-calls" "$work/docker-fails"
    git init -q --bare -b main "$work/origin.git"
    git clone -q "$work/origin.git" "$work/seed" 2>/dev/null
    mkdir -p "$work/seed/cv/deploy/vm-generator"
    cp "$here/auto-deploy.sh" "$work/seed/cv/deploy/vm-generator/"
    echo one > "$work/seed/file"
    echo kept > "$work/seed/config"
    git -C "$work/seed" add -A && git -C "$work/seed" commit -qm one && git -C "$work/seed" push -q origin main
    git clone -q "$work/origin.git" "$work/vm"
}
upstream() {
    echo "$1" > "$work/seed/file"
    git -C "$work/seed" commit -qam "$1" && git -C "$work/seed" push -q origin main
}
deploy() { bash "$work/vm/cv/deploy/vm-generator/auto-deploy.sh" >"$work/out" 2>&1; }
calls() { [ -f "$work/docker-calls" ] && wc -l < "$work/docker-calls" || echo 0; }

# 1. A new commit on origin/main: fast-forwarded, then built and started.
fresh; deploy; rm -f "$work/docker-calls"; upstream two
deploy || fail "a new commit did not deploy: $(cat "$work/out")"
[ "$(git -C "$work/vm" rev-parse HEAD)" = "$(git -C "$work/seed" rev-parse HEAD)" ] || fail "the checkout is not at origin/main"
grep -q -- "compose -f .*cv/deploy/vm-generator/compose.yaml up -d --build" "$work/docker-calls" 2>/dev/null \
    || fail "compose was not run: $(cat "$work/docker-calls" 2>/dev/null)"
report a_new_commit_is_pulled_and_deployed

# 2. Nothing new since the last deploy: docker is not called.
fresh; deploy; rm -f "$work/docker-calls"
deploy || fail "an up-to-date checkout is an error: $(cat "$work/out")"
[ "$(calls)" -eq 0 ] || fail "docker ran with nothing to deploy"
report nothing_new_deploys_nothing

# 3. A failed build is tried again at the next run.
fresh; upstream two; touch "$work/docker-fails"
deploy && fail "a failed compose was reported as success"
rm -f "$work/docker-fails" "$work/docker-calls"
deploy || fail "the retry failed: $(cat "$work/out")"
[ "$(calls)" -eq 1 ] || fail "the failed deploy was not retried"
report a_failed_build_is_retried

# 4. Local changes on the VM, even in a file origin did not touch (git would
# fast-forward over it): refused, untouched, no docker.
fresh; deploy; rm -f "$work/docker-calls"; upstream two; echo mine > "$work/vm/config"
deploy && fail "a dirty checkout was deployed"
[ "$(cat "$work/vm/config")" = mine ] || fail "the local change was lost"
[ "$(calls)" -eq 0 ] || fail "docker ran on a dirty checkout"
report local_changes_stop_the_deploy

# 5. A local commit origin does not have: refused, never merged.
fresh; deploy; rm -f "$work/docker-calls"; upstream two
echo local > "$work/vm/other" && git -C "$work/vm" add other && git -C "$work/vm" commit -qm local
deploy && fail "a diverged checkout was deployed"
[ "$(calls)" -eq 0 ] || fail "docker ran on a diverged checkout"
report a_diverged_checkout_is_not_merged

# 6. A checkout on another branch: refused.
fresh; deploy; rm -f "$work/docker-calls"; upstream two; git -C "$work/vm" checkout -qb elsewhere
deploy && fail "a checkout on another branch was deployed"
[ "$(calls)" -eq 0 ] || fail "docker ran on another branch"
report another_branch_is_not_deployed

[ "$failures" -eq 0 ] && echo "test result: ok" || { echo "test result: FAILED ($failures)"; exit 1; }
