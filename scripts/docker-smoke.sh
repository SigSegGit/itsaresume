#!/usr/bin/env bash
# Smoke-test the Docker image with the *real* claude CLI inside it.
#
#   bash scripts/docker-smoke.sh [image]      (default: builds itsaresume:smoke)
#
# What each check proves, and why it would fail if the property were broken:
#
# 1. `claude --version` is the pinned version: the parser was written against
#    that version's observed output (docs/HANDOVER.md §4).
# 2. The test double `itsaresume-fake-claude` is not in the image.
# 3. /healthz answers: the router starts from the mounted configuration.
# 4. A real request goes through the real claude CLI with a bogus
#    ANTHROPIC_API_KEY set on the container. The CLI in CI is not logged in,
#    so the only correct answer is 502 "Not logged in":
#      - if the router did not strip the key, the CLI would report
#        apiKeySource=ANTHROPIC_API_KEY (billing tripwire, a different
#        message) or retry for minutes (timeout, 503);
#      - if "not logged in" fell back, LM Studio (refused here) would make it
#        a 503 instead of a 502.

set -euo pipefail

IMAGE=${1:-}
PINNED=2.1.162
NAME=itsaresume-smoke-$$
PORT=18787

if [ -z "$IMAGE" ]; then
    IMAGE=itsaresume:smoke
    docker build -t "$IMAGE" .
fi

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== 1. pinned claude CLI"
version=$(docker run --rm --entrypoint claude "$IMAGE" --version)
echo "   $version"
case "$version" in *"$PINNED"*) ;; *) echo "FAIL: expected $PINNED"; exit 1 ;; esac

echo "== 2. no test double in the image"
if docker run --rm --entrypoint sh "$IMAGE" -c 'command -v itsaresume-fake-claude'; then
    echo "FAIL: the fake claude binary is in the image"; exit 1
fi

echo "== 3. the endpoint starts"
config=$(mktemp)
cat > "$config" <<'EOF'
journal = "/home/node/journal/itsaresume-journal.jsonl"

[[backend]]
kind = "claude-code"
program = "claude"
timeout_secs = 90

[[backend]]
kind = "lm-studio"
base_url = "http://127.0.0.1:9/v1"
model = "none"
timeout_secs = 5
EOF
# mktemp makes the file 0600; docker cp keeps the mode and makes it
# root-owned, so the non-root router could not read it on a Linux host.
chmod 644 "$config"
docker create --init --name "$NAME" -p "127.0.0.1:$PORT:8787" \
    -e ANTHROPIC_API_KEY=sk-ant-api03-bogus-smoke-test "$IMAGE" >/dev/null
docker cp "$config" "$NAME:/etc/itsaresume/config.toml"
rm -f "$config"
docker start "$NAME" >/dev/null
for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
    sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || { docker logs "$NAME"; echo "FAIL: no /healthz"; exit 1; }
echo "   /healthz answered"

echo "== 4. a real request through the real claude CLI"
body=$(mktemp)
status=$(curl -sS -o "$body" -w '%{http_code}' --max-time 150 \
    -H 'Content-Type: application/json' -d '{"prompt":"hi"}' \
    "http://127.0.0.1:$PORT/v1/complete")
echo "   HTTP $status: $(head -c 300 "$body")"
if [ "$status" != 502 ] || ! grep -q 'Not logged in' "$body" || grep -q 'tripwire' "$body"; then
    docker logs "$NAME" | tail -20
    echo "FAIL: expected 502 'Not logged in' (key stripped, no fallback)"
    exit 1
fi
rm -f "$body"
echo "OK: image smoke test passed"
