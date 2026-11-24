#!/usr/bin/env bash
# 6.4g: the premium database's snapshots copied off the VM by ITSaNAS, under
# an ITSaNAS account of their own ("itsaresume"), never the live premium.db.
#
#   bash ~/itsaresume/cv/deploy/vm-generator/itsanas-premium.sh
#
# Runs on the VM, after the ITSaNAS fleet (~/itsanas, its client image and its
# coordinator: scripts/fleet-docker.sh in the ITSaNAS repository). The
# account's passphrase and its 24 words are typed and kept by the owner: this
# script never writes the words anywhere, and keeps the passphrase only in a
# mode-600 env file, as fleet-docker.sh does for every account.
#
# Safe to run again: an existing node is only brought up. ITSANAS_INVITE=<code>
# if the coordinator is invite-only (`itsanas invite` from a member's node).
set -u

ACCT=itsaresume
PORT="${ITSANAS_PREMIUM_PORT:-9800}"
# The fleet's coordinator, as the fleet script on this VM names it (no host
# name in this repository).
FLEET="${ITSANAS_FLEET_SCRIPT:-$HOME/fleet-docker.sh}"
COORD="${ITSANAS_COORD:-$(sed -n 's/^COORD=//p' "$FLEET" 2>/dev/null | head -1)}"
COORD_ID="${ITSANAS_COORD_ID:-$(sed -n 's/^COORD_ID=//p' "$FLEET" 2>/dev/null | head -1)}"
CHECKOUT="$HOME/itsanas"
DATA="$HOME/itsanas-data"
SNAPSHOTS="${ITSACV_DATA:-$HOME/itsacv-data}/premium/snapshots"

say() { printf '%s\n' "$*"; }
fail() { say "FAILED: $*"; exit 1; }

[ -f "$CHECKOUT/install/docker/compose.client.yml" ] || fail "no ITSaNAS checkout in $CHECKOUT (run fleet-docker.sh vm first)"
[ -n "$COORD" ] && [ -n "$COORD_ID" ] || fail "no coordinator in $FLEET (or set ITSANAS_COORD and ITSANAS_COORD_ID)"
[ -d "$SNAPSHOTS" ] || fail "no snapshots in $SNAPSHOTS (is the premium container running?)"
if docker info >/dev/null 2>&1; then SUDO=""; else SUDO="sudo"; fi
$SUDO docker image inspect itsanas-client:local >/dev/null 2>&1 || fail "no itsanas-client:local image (run fleet-docker.sh vm first)"

home="$DATA/$ACCT/home"
envf="$DATA/$ACCT/client.env"
mkdir -p "$home" "$DATA/pledges"
dc() {
    $SUDO env ITSANAS_DATA="$home" ITSANAS_FOLDER="$SNAPSHOTS" ITSANAS_PLEDGES="$DATA/pledges" \
        ITSANAS_ENV_FILE="$envf" ITSANAS_UID="$(id -u)" ITSANAS_GID="$(id -g)" \
        ITSANAS_CLIENT_MEMORY=256m ITSANAS_CLIENT_CPUS=0.5 \
        docker compose -f "$CHECKOUT/install/docker/compose.client.yml" -p "itsanas-$ACCT" "$@"
}

if command -v ufw >/dev/null && sudo ufw status 2>/dev/null | grep -q "Status: active"; then
    sudo ufw allow "$PORT/tcp" comment "itsanas $ACCT" >/dev/null && say "ufw: $PORT/tcp open for the members"
fi

if [ -f "$home/keystore.bin" ]; then
    say "The '$ACCT' node exists; leaving it as it is."
else
    while :; do
        read -r -s -p "Passphrase for the ITSaNAS account '$ACCT' on this VM: " pass; echo
        read -r -s -p "Again: " pass2; echo
        [ -n "$pass" ] && [ "$pass" = "$pass2" ] && break
        say "They differ or are empty; again."
    done
    (umask 077; printf 'ITSANAS_PASSPHRASE=%s\n' "$pass" > "$envf")
    unset pass pass2
    say "The account's 24 words come next: write them on paper or in your password manager,"
    say "nowhere on this VM. They are the only way back to these backups if the VM is lost."
    dc run --rm -it client init --username "$ACCT" || fail "init $ACCT"
    dc run --rm client listen "0.0.0.0:$PORT" || fail "listen"
    dc run --rm client folder /data/folder || fail "folder"
    dc run --rm client coordinator "$COORD" --device "$COORD_ID" || fail "coordinator"
    if [ -n "${ITSANAS_INVITE:-}" ]; then
        dc run --rm client register --invite "$ITSANAS_INVITE" || fail "register with the invite"
    else
        dc run --rm client register || fail "register (invite-only coordinator? ITSANAS_INVITE=<code> bash $0)"
    fi
fi
# Like any app that keeps its base on ITSaNAS: it offers space so others hold
# its copies (2G, as every account of the fleet; the snapshots weigh a few MB).
if grep -q '^pledge=0$' "$home/pledge.state" 2>/dev/null || [ ! -f "$home/pledge.state" ]; then
    dc stop >/dev/null 2>&1
    dc run --rm client pledge "${ITSANAS_PREMIUM_PLEDGE:-2G}" || fail "pledge"
fi
# A node registered while the coordinator lost its claim (seen 2026-11-24,
# after an interrupted first run) is registered again; register is idempotent.
if $SUDO docker logs "itsanas-$ACCT-client-1" 2>&1 | tail -50 | grep -q "is not claimed by any registered account"; then
    dc stop >/dev/null 2>&1
    dc run --rm client register || fail "register again"
fi
dc up -d || fail "start $ACCT"
sleep 3
say "Account id: $($SUDO docker logs "itsanas-$ACCT-client-1" 2>&1 | sed -n 's/^ *user id *//p' | head -1)"
say "Synced folder: $SNAPSHOTS ($(ls "$SNAPSHOTS" | grep -c '^premium-.*\.db$') snapshot(s))."
say "Another machine of the account: itsanas login --username $ACCT, then"
say "node premium/restore-check.js <a synced premium-*.db> to prove it restores."
