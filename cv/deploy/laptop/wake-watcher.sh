#!/usr/bin/env bash
# 8.44: the laptop's watcher, started at logon (wake-watcher.vbs). The owner
# keeps a light boot: no Bionic, no model, only this loop. Each round, one
# SSH call to the VM marks the laptop seen in the generator's wake
# directory and takes a wake request left there by a job for the local
# model; a request starts Bionic's server (BIONIC_LMS, its own `lms`) and,
# once, the tunnel (bionic-tunnel.sh). The model loads at the first request
# and Bionic unloads it after an idle hour. Nothing listens on the laptop.
# Settings: ~/.itsaresume/public.env (VM_SSH, VM_KEY, BIONIC_LMS).
#
#   deploy/laptop/wake-watcher.sh
set -euo pipefail
settings=${ITSACV_PUBLIC_ENV:-$HOME/.itsaresume/public.env}
# shellcheck disable=SC1090
. "$settings"
: "${VM_SSH:?}" "${VM_KEY:?}"
here=$(cd "$(dirname "$0")" && pwd)
# The generator's <out>/wake on the VM (compose: ~/itsacv-data/out).
wake=${VM_WAKE_DIR:-itsacv-data/out/wake}
tunnel=${ITSACV_TUNNEL_CMD:-$here/bionic-tunnel.sh}
pidfile=${ITSACV_TUNNEL_PIDFILE:-$HOME/.itsaresume/bionic-tunnel.pid}
rounds=${ITSACV_WATCH_ROUNDS:-0}   # 0: forever (tests set a count)
pause=${ITSACV_WATCH_PAUSE:-60}
round=0
while [ "$rounds" -eq 0 ] || [ "$round" -lt "$rounds" ]; do
  round=$((round + 1))
  # shellcheck disable=SC2086
  said=$(ssh -i "$VM_KEY" -o BatchMode=yes -o ConnectTimeout=10 $VM_SSH \
    "mkdir -p $wake && touch $wake/laptop-seen && if [ -f $wake/local ]; then rm -f $wake/local; echo wake; fi" \
    2>/dev/null || true)
  if [ "$said" = wake ]; then
    if [ -n "${BIONIC_LMS:-}" ]; then
      "$BIONIC_LMS" server start >/dev/null 2>&1 \
        || echo "Bionic's server did not start ($(date +%H:%M:%S))" >&2
    fi
    if ! { [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; }; then
      nohup "$tunnel" >/dev/null 2>&1 &
      echo $! > "$pidfile"
    fi
  fi
  sleep "$pause"
done
