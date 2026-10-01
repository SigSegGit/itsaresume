#!/usr/bin/env bash
# ADR-11: lend the laptop's local model (Bionic, 127.0.0.1:54321) to the
# router on the VM, as the VM's 127.0.0.1:54321, while the laptop is on;
# and the laptop's own router (127.0.0.1:8789: Claude, logged in here, then
# Bionic) as the VM's 127.0.0.1:18789, for the VM generator to use until the
# VM has its own Claude token (ROUTER_URL in the VM's .env).
# Reopened whenever it drops; nothing listens on the laptop beyond
# 127.0.0.1. Settings: ~/.itsaresume/public.env (VM_SSH, VM_KEY).
#
#   deploy/laptop/bionic-tunnel.sh
set -euo pipefail
settings=${ITSACV_PUBLIC_ENV:-$HOME/.itsaresume/public.env}
# shellcheck disable=SC1090
. "$settings"
: "${VM_SSH:?}" "${VM_KEY:?}"
while true; do
  # shellcheck disable=SC2086
  ssh -i "$VM_KEY" -o BatchMode=yes -o ConnectTimeout=10 $VM_SSH 'fuser -k -n tcp 54321 18789 >/dev/null 2>&1 || true' || true
  # shellcheck disable=SC2086
  ssh -N -i "$VM_KEY" -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 -R "127.0.0.1:54321:127.0.0.1:54321" -R "127.0.0.1:18789:127.0.0.1:8789" $VM_SSH \
    || echo "tunnel down ($(date +%H:%M:%S)), retrying in 15 s" >&2
  sleep 15
done
