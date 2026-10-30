#!/usr/bin/env bash
# Timed agent-state changes for the hero recording. record-demo.sh starts it
# in the background right before the herdr client; nothing is typed into the
# client. Usage: drive.sh <SB>, with P_API P_REVIEW P_TESTS P_NOTES (pane ids)
# and T_TESTS (tab id) in the environment.
set -euo pipefail

SB=$1
# shellcheck source=scripts/demo/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
drop_herdr_env
: "${P_API:?}" "${P_REVIEW:?}" "${P_TESTS:?}" "${P_NOTES:?}" "${T_TESTS:?}"

start=$EPOCHREALTIME
# Sleep until $1 seconds after the driver started.
at() {
  local wait
  wait=$(awk -v t="$1" -v s="$start" -v n="$EPOCHREALTIME" 'BEGIN { w = s + t - n; print (w > 0 ? w : 0) }')
  sleep "$wait"
  log "# drive t=$1"
}

at 1.5; report "$P_API" working
at 2.3; report "$P_REVIEW" working
at 3.1; report "$P_TESTS" working
at 3.9; report "$P_NOTES" working
at 5.5; report "$P_REVIEW" blocked
at 7.0; report "$P_TESTS" idle # unfocused tab: working -> idle is done
at 8.0; report "$P_NOTES" idle
at 9.8; h tab focus "$T_TESTS" > /dev/null # seen: its done icon clears
at 10.6; tab_list >> "$SB/transcript.log"
