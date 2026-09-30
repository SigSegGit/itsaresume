#!/usr/bin/env bash
# Serve the CV generator publicly, from this laptop, through the VM's front
# (deploy/vm): the public itsacv instance on 127.0.0.1:$PUBLIC_PORT, and an SSH
# tunnel that makes it the VM's 127.0.0.1:18790, reopened whenever it drops.
# Nothing listens on this laptop beyond 127.0.0.1.
#
#   deploy/laptop/public.sh          # Ctrl+C stops the tunnel and the server
#
# Settings, private, in ~/.itsaresume/public.env (never committed):
#   CV_HOST=cv.example.org           the public name (as in the VM's .env)
#   VM_SSH="-p 2222 user@example.org"    how to reach the VM (the public name works from anywhere)
#   VM_KEY=~/.ssh/some_key           the SSH key for it
#   ROUTER_URL=http://127.0.0.1:8789 the itsaresume router to use (already running)
#   PER_DAY=20 PER_HOUR=3            the caps (itsacv serve --help)
set -euo pipefail
here=$(cd "$(dirname "$0")/../.." && pwd)
settings=${ITSACV_PUBLIC_ENV:-$HOME/.itsaresume/public.env}
[ -f "$settings" ] || { echo "no $settings (see the header of $0)" >&2; exit 2; }
# shellcheck disable=SC1090
. "$settings"
: "${CV_HOST:?}" "${VM_SSH:?}" "${VM_KEY:?}"
ROUTER_URL=${ROUTER_URL:-http://127.0.0.1:8789}
PUBLIC_PORT=${PUBLIC_PORT:-8791}

[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$ROUTER_URL/")" != 000 ] \
  || { echo "the router does not answer at $ROUTER_URL: start it first (docs/HANDOVER.md §2)" >&2; exit 3; }

node "$here/bin/itsacv.js" serve --port "$PUBLIC_PORT" --url "$ROUTER_URL" --timeout 1800 \
  --out "$HOME/.itsaresume/out" --public-host "$CV_HOST" \
  --per-day "${PER_DAY:-20}" --per-hour "${PER_HOUR:-3}" --max-queued "${MAX_QUEUED:-3}" &
server=$!
trap 'kill $server 2>/dev/null; exit 0' INT TERM EXIT

while kill -0 $server 2>/dev/null; do
  # A tunnel that died on this side can still hold the VM's port until the
  # server notices: free it first (seen when the laptop changed networks).
  # shellcheck disable=SC2086
  ssh -i "$VM_KEY" -o BatchMode=yes -o ConnectTimeout=10 $VM_SSH 'fuser -k -n tcp 18790 >/dev/null 2>&1 || true' || true
  # shellcheck disable=SC2086
  ssh -N -i "$VM_KEY" -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 -R "127.0.0.1:18790:127.0.0.1:$PUBLIC_PORT" $VM_SSH \
    || echo "tunnel down ($(date +%H:%M:%S)), retrying in 15 s" >&2
  sleep 15
done
