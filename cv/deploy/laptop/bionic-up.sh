#!/usr/bin/env bash
# 2026-10-31: a session on the laptop wakes Bionic itself, for its tests and
# benches: its server on 54321 (the port the router and the tunnel use; `lms
# server start` alone reuses the port it last ran on), then waits until its
# models answer. Exit 1, naming the port, if they never do.
# Settings: ~/.itsaresume/public.env (BIONIC_LMS).
#
#   deploy/laptop/bionic-up.sh
set -euo pipefail
settings=${ITSACV_PUBLIC_ENV:-$HOME/.itsaresume/public.env}
# shellcheck disable=SC1090
. "$settings"
: "${BIONIC_LMS:?}"
port=54321
wait=${BIONIC_WAIT:-60}   # tries, one per pause
pause=${BIONIC_PAUSE:-2}
"$BIONIC_LMS" server start --port "$port" >/dev/null 2>&1 \
  || echo "Bionic's server did not start" >&2
for _ in $(seq 1 "$wait"); do
  if curl -sf -m 5 "http://127.0.0.1:$port/v1/models" >/dev/null; then exit 0; fi
  sleep "$pause"
done
echo "Bionic does not answer on 127.0.0.1:$port" >&2
exit 1
