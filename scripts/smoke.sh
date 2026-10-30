#!/usr/bin/env bash
# End-to-end smoke test of the plugin against a real, isolated herdr server.
#
# Usage: scripts/smoke.sh [SB]            (default SB=/tmp/cbsmoke)
#   HERDR_BIN=/path/to/herdr scripts/smoke.sh /tmp/cbsmoke
#
# SB is a short absolute directory the script creates (or one it created on
# an earlier run, marked by SB/.cowbell-smoke). The script starts its own
# headless herdr server there, links a copy of the plugin, lets the
# [[startup]] hook start the daemon, drives agent states with
# `pane report-agent` and checks the tab labels:
#   working -> "◐ A", blocked -> "? B", done -> "✓ C", focused tab plain;
#   focusing C clears its ✓; the `off` action restores every name.
# It never talks to the herdr server of the session it runs in: every HERDR_*
# variable and SSH_AUTH_SOCK are unset first, and every herdr call runs with
# XDG_CONFIG_HOME/XDG_STATE_HOME inside SB.
#
# Exit codes: 0 PASS (last line "smoke: PASS ..."), 1 any failure (after a
# dump of the plugin log, daemon.log and server logs), 2 usage or missing
# prerequisite (bad SB, no herdr, no node >= 18, no perl).
#
# Prerequisites: bash >= 3.2 (no bash 4 features, for macOS /bin/bash),
# herdr (HERDR_BIN or on PATH), node >= 18, perl, ps, awk. Linux or macOS.
# Every herdr and node call is time-bounded and the whole run stays under
# 120 s, so CI cannot hang.
# The sandbox files stay in SB for inspection; the next run removes them.
set -eEuo pipefail

# --- 0. herdr binary, then drop the session environment --------------------
# HERDR_BIN is itself a HERDR_* variable: read it before the unset loop.
HERDR=${HERDR_BIN:-herdr}

prereq() {
  printf 'smoke: error: %s\n' "$*" >&2
  exit 2
}

# ${!HERDR_*} expands to the names of all set variables starting with HERDR_
# (bash >= 2). Inside a herdr pane they point at the live server.
for v in ${!HERDR_*}; do
  unset "$v" 2> /dev/null || prereq "cannot unset $v (readonly?); run from a plain shell"
done
unset v
# Inside a herdr pane this is the live server's agent link.
unset SSH_AUTH_SOCK 2> /dev/null || prereq "cannot unset SSH_AUTH_SOCK"
[[ -z "${HERDR_SOCKET_PATH+x}" ]] || prereq "HERDR_SOCKET_PATH is still set; refusing to run"

PLUGIN_ID=dvoraj75.cowbell
MARKER=.cowbell-smoke
# What a run creates in SB; only these are removed before the next run.
CREATED="c s plugin sh server.log smoke.pids herdr.err"
# Time limits, in seconds. Worst case: the budget watchdog fires (BUDGET),
# the shell finishes the call it is in (CALL_LIMIT), then the EXIT trap runs
# its bounded steps (about 40 s: dump 2x5, ctl stop 12, server stop 5, wait
# for the server 8, TERM/KILL leftovers 3). 65 + 10 + 40 = 115 <= 120.
BUDGET=65
CALL_LIMIT=10
WAIT_LIMIT=20

usage() {
  printf 'usage: %s [SB]   (SB: short absolute sandbox directory, default /tmp/cbsmoke)\n' "$0" >&2
  exit 2
}

case "${1:-}" in
  # The header comment above `set` is the help text.
  -h | --help)
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
    exit 0
    ;;
esac
(($# <= 1)) || usage
SB=${1:-/tmp/cbsmoke}

# --- 1. prerequisites and sandbox directory --------------------------------
[[ "$SB" == /* ]] || prereq "SB must be an absolute path: $SB"
# Strip trailing slashes; "/" alone would end up empty and is refused.
while [[ "$SB" == */ ]]; do SB=${SB%/}; done
[[ -n "$SB" ]] || prereq "SB must not be /"
# Use the physical path (macOS: /tmp -> /private/tmp). node reports the real
# path of the daemon script, and the daemon is recognised by it below.
SB_PARENT=$(dirname "$SB")
[[ -d "$SB_PARENT" ]] || prereq "parent directory of SB does not exist: $SB_PARENT"
SB_PARENT=$(cd "$SB_PARENT" && pwd -P)
SB=${SB_PARENT%/}/$(basename "$SB")
SOCK=$SB/c/herdr/herdr.sock
# macOS sun_path holds 104 bytes including the terminating NUL. wc -c counts
# bytes (not characters); tr drops the padding macOS wc adds.
sock_bytes=$(printf '%s' "$SOCK" | wc -c | tr -d ' ')
((sock_bytes < 104)) || prereq "socket path $SOCK is $sock_bytes bytes (limit 103); use a shorter SB"

command -v perl > /dev/null || prereq "perl not found (needed for time limits)"
command -v ps > /dev/null || prereq "ps not found"
command -v awk > /dev/null || prereq "awk not found"
NODE=$(command -v node) || prereq "node not found on PATH"
# A relative HERDR_BIN would resolve against the server's cwd (SB): make it
# absolute. A bare name is looked up on PATH.
case "$HERDR" in
  /*) ;;
  */*) HERDR=$PWD/$HERDR ;;
  *) HERDR=$(command -v -- "$HERDR") || prereq "herdr not found on PATH (set HERDR_BIN)" ;;
esac
[[ -f "$HERDR" && -x "$HERDR" ]] || prereq "herdr binary not executable: $HERDR"
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
STATE_DIR=$SB/s/herdr/plugins/$PLUGIN_ID
CONFIG_DIR=$SB/c/herdr/plugins/config/$PLUGIN_ID
DAEMON_LOG=$STATE_DIR/daemon.log
PIDS=$SB/smoke.pids

# bounded <seconds> <command...>: run the command with an alarm. When it
# fires the command dies of SIGALRM (exit 142). GNU timeout is missing on
# macOS; perl is on every Linux and macOS runner, and an alarm survives
# exec. SIGALRM is reset to default first, in case it was inherited ignored.
# exec { $ARGV[0] } @ARGV never goes through a shell.
bounded() {
  perl -e '$SIG{ALRM} = "DEFAULT"; alarm shift; exec { $ARGV[0] } @ARGV or die "smoke: cannot run $ARGV[0]: $!\n"' "$@"
}

# The environment of every herdr call: the sandbox's config and state dirs
# and a minimal pane shell. The -u flags repeat the unset above as a guard.
SB_ENV=(env -u HERDR_SOCKET_PATH -u SSH_AUTH_SOCK
  XDG_CONFIG_HOME="$SB/c" XDG_STATE_HOME="$SB/s" SHELL="$SB/sh")

HERDR_VERSION_LINE=$(bounded "$CALL_LIMIT" "${SB_ENV[@]}" "$HERDR" --version) ||
  prereq "$HERDR --version failed"
NODE_VERSION=$(bounded "$CALL_LIMIT" "$NODE" --version) || prereq "node --version failed"
printf 'smoke: %s (%s)\n' "$HERDR_VERSION_LINE" "$HERDR"
printf 'smoke: node %s (%s)\n' "$NODE_VERSION" "$NODE"
printf 'smoke: bash %s, SB %s\n' "$BASH_VERSION" "$SB"
bounded "$CALL_LIMIT" "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' ||
  prereq "node >= 18 required, found $NODE_VERSION"

# args of a live process, as ps prints them; fails when the pid is gone.
# Used to recognise our own processes again without /proc.
proc_args() {
  ps -o args= -p "$1"
}

# Is a pid from SB/smoke.pids still the same process? ("pid<TAB>args")
still_same() {
  local now
  now=$(proc_args "$1" 2> /dev/null) || return 1
  [[ "$now" == "$2" ]]
}

if [[ -e "$SB" || -L "$SB" ]]; then
  [[ -d "$SB" && ! -L "$SB" ]] || prereq "$SB exists and is not a directory"
  if [[ -n "$(ls -A "$SB")" ]]; then
    [[ -f "$SB/$MARKER" ]] || prereq "$SB is not empty and was not created by this script (no $MARKER); pick another SB"
    if [[ -f "$PIDS" ]]; then
      while IFS=$'\t' read -r pid args; do
        if still_same "$pid" "$args"; then
          prereq "process $pid of an earlier run is still alive ($args); stop it first"
        fi
      done < "$PIDS"
    fi
    for f in $CREATED; do rm -rf -- "${SB:?}/$f"; done
  fi
fi
mkdir -p "$SB"
touch "$SB/$MARKER"
mkdir -p "$SB/c/herdr" "$SB/s"
: > "$PIDS"
: > "$SB/server.log"

# A pane shell without rc files: /bin/sh, interactive, ENV unset. herdr's
# arguments (e.g. a login flag) are ignored on purpose.
cat > "$SB/sh" << 'EOF'
#!/bin/sh
unset ENV
exec /bin/sh -i
EOF
chmod +x "$SB/sh"

# --- helpers ----------------------------------------------------------------
SECONDS=0
SERVER_PID=
WATCHDOG_PID=
IN_CLEANUP=0

fail() {
  printf 'smoke: FAIL: %s\n' "$*" >&2
  exit 1
}

# Remember a process this script started, with its args, for cleanup and for
# the next run's leftover check.
track() {
  local args
  args=$(proc_args "$1") || return 0
  printf '%s\t%s\n' "$1" "$args" >> "$PIDS"
}

# herdr in the sandbox, bounded. stdout passes through, stderr goes to
# SB/herdr.err. Returns herdr's exit code (142 on timeout).
herdr_raw() {
  bounded "$CALL_LIMIT" "${SB_ENV[@]}" "$HERDR" "$@" 2> "$SB/herdr.err"
}

# herdr in the sandbox; on failure print the command, its stderr and the
# exit code, and return that code (set -e then ends the run).
h() {
  local rc=0
  herdr_raw "$@" || rc=$?
  if ((rc == 142)); then
    printf 'smoke: herdr %s: timed out after %ss\n' "$*" "$CALL_LIMIT" >&2
  elif ((rc != 0)); then
    printf 'smoke: herdr %s: exit %s\n' "$*" "$rc" >&2
  fi
  if ((rc != 0)); then cat "$SB/herdr.err" >&2; fi
  return "$rc"
}

# Value at a dotted path of the JSON on stdin, e.g. json result.tab.tab_id.
json() {
  # shellcheck disable=SC2016 # ${...} below is a JavaScript template literal
  bounded "$CALL_LIMIT" "$NODE" -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let v = JSON.parse(s);
      for (const k of process.argv[1].split(".")) v = v == null ? undefined : v[k];
      if (v === undefined) { process.stderr.write(`json: no ${process.argv[1]} in ${s}\n`); process.exit(1); }
      console.log(v);
    });' "$1"
}

# `herdr tab list` JSON on stdin -> one line, every tab in list order:
#   labels: "A | B | C | D"
#   full:   "◐ A/working | ? B/blocked | ✓ C/done | D/unknown/focused"
TABS_JS='
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const tabs = JSON.parse(s).result.tabs;
  const full = process.argv[1] === "full";
  console.log(tabs.map((t) => full
    ? [t.label, t.agent_status].concat(t.focused ? ["focused"] : []).join("/")
    : t.label).join(" | "));
});'

# wait_tabs <labels|full> <want> <what>: poll `tab list` until it reads
# exactly <want> (every tab, see TABS_JS), or fail after WAIT_LIMIT seconds.
# The daemon renames asynchronously, so this polls instead of sleeping.
wait_tabs() {
  local mode=$1 want=$2 what=$3 raw got="" deadline=$((SECONDS + WAIT_LIMIT))
  while :; do
    if raw=$(herdr_raw tab list); then
      got=$(printf '%s' "$raw" | bounded "$CALL_LIMIT" "$NODE" -e "$TABS_JS" "$mode") ||
        got="(unreadable tab list: $raw)"
      if [[ "$got" == "$want" ]]; then
        printf 'smoke: ok: %s: %s\n' "$what" "$got"
        return 0
      fi
    else
      # $? here is the status of the failed condition (142: timed out).
      got="(herdr tab list failed: exit $?)"
    fi
    ((SECONDS < deadline)) || break
    sleep 0.2
  done
  fail "$what: tab list did not match within ${WAIT_LIMIT}s
  want: $want
  got:  $got"
}

# Descendants of a pid, one "pid<TAB>args" line each (ps works on Linux and
# macOS; there is no /proc on macOS). awk walks the parent links.
descendants() {
  ps -A -o pid= -o ppid= -o args= | awk -v root="$1" '
    {
      pid[NR] = $1; ppid[NR] = $2; line = $0
      sub(/^[ \t]*[0-9]+[ \t]+[0-9]+[ \t]+/, "", line)
      args[NR] = line
    }
    END {
      want[root] = 1
      changed = 1
      while (changed) {
        changed = 0
        for (i = 1; i <= NR; i++) {
          if ((ppid[i] in want) && !(pid[i] in want)) { want[pid[i]] = 1; changed = 1; print pid[i] "\t" args[i] }
        }
      }
    }'
}

# Report an agent state for a pane, like an integration would.
report() {
  h pane report-agent "$1" --source custom:smoke --agent smoke --state "$2" > /dev/null
}

# The plugin's control CLI with the variables herdr gives a plugin command
# (pointed at this sandbox only).
# shellcheck disable=SC2329 # called from cleanup, which runs from the EXIT trap
ctl() {
  bounded 12 env -i PATH="$PATH" HOME="$HOME" \
    HERDR_SOCKET_PATH="$SOCK" HERDR_PLUGIN_STATE_DIR="$STATE_DIR" \
    HERDR_PLUGIN_CONFIG_DIR="$CONFIG_DIR" HERDR_PLUGIN_ID="$PLUGIN_ID" \
    "$NODE" "$SB/plugin/bin/ctl.js" "$@"
}

# Track the daemon named by the pidfile if it is this sandbox's copy; set
# DAEMON_PID and DAEMON_ARGS. Fails when there is no such live daemon.
DAEMON_PID=
DAEMON_ARGS=
track_daemon() {
  local pid args
  pid=$(cat "$STATE_DIR/cowbell.pid" 2> /dev/null) || return 1
  args=$(proc_args "$pid" 2> /dev/null) || return 1
  [[ "$args" == *" $SB/plugin/bin/cowbell.js" ]] || return 1
  DAEMON_PID=$pid
  DAEMON_ARGS=$args
  awk -F'\t' -v p="$pid" '$1 == p { found = 1 } END { exit !found }' "$PIDS" || track "$pid"
}

server_alive() {
  [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2> /dev/null
}

start_server() {
  local launch deadline
  launch=("${SB_ENV[@]}" "$HERDR" server)
  # setsid (Linux) keeps terminal signals away from the server. A background
  # child of a non-interactive bash is no process group leader, so setsid
  # execs in place and $! stays the server's pid. macOS has no setsid.
  if command -v setsid > /dev/null; then launch=(setsid "${launch[@]}"); fi
  printf 'smoke: starting herdr server in %s\n' "$SB"
  (cd "$SB" && exec "${launch[@]}") >> "$SB/server.log" 2>&1 < /dev/null &
  SERVER_PID=$!
  deadline=$((SECONDS + WAIT_LIMIT))
  until [[ -S "$SOCK" ]] && herdr_raw plugin list > /dev/null; do
    server_alive || fail "herdr server (pid $SERVER_PID) exited during startup"
    ((SECONDS < deadline)) || fail "herdr server did not answer on $SOCK within ${WAIT_LIMIT}s"
    sleep 0.2
  done
  track "$SERVER_PID"
  [[ "$(proc_args "$SERVER_PID")" == *" server" ]] ||
    fail "pid $SERVER_PID is not the herdr server: $(proc_args "$SERVER_PID")"
}

# Stop the server: `server stop`, then wait for its pid. With "force", kill
# it if it does not exit (cleanup); without, a slow stop is a failure.
stop_server() {
  local deadline
  # Pane shells and their sleeps: remembered so cleanup can catch any the
  # server leaves behind.
  if server_alive; then
    descendants "$SERVER_PID" >> "$PIDS"
  fi
  if [[ -S "$SOCK" ]] || server_alive; then
    if [[ "${1:-}" == force ]]; then
      CALL_LIMIT=5 h server stop > /dev/null || true # cleanup: kill below if this failed
    else
      h server stop > /dev/null
    fi
  fi
  deadline=$((SECONDS + 8))
  while server_alive && ((SECONDS < deadline)); do sleep 0.1; done
  if server_alive; then
    [[ "${1:-}" == force ]] || fail "herdr server (pid $SERVER_PID) did not exit after server stop"
    printf 'smoke: herdr server (pid %s) did not stop; sending TERM\n' "$SERVER_PID" >&2
    kill -TERM "$SERVER_PID" 2> /dev/null || true # it may exit right now
  fi
  # Reap it; its exit status is not part of the result.
  if [[ -n "$SERVER_PID" ]] && ! server_alive; then wait "$SERVER_PID" 2> /dev/null || true; fi
}

# Kill every tracked process that is still the same process: TERM, then
# KILL after 2 s. Returns 1 if the server or a daemon was among them; other
# leftovers (pane shells, a helper the server spawned) are killed and
# reported, but they are herdr's to reap and do not fail the run.
# shellcheck disable=SC2329 # called from cleanup, which runs from the EXIT trap
kill_leftovers() {
  local pid args left="" bad=0 deadline
  while IFS=$'\t' read -r pid args; do
    if still_same "$pid" "$args"; then
      printf 'smoke: still running, sending TERM: %s %s\n' "$pid" "$args" >&2
      kill -TERM "$pid" 2> /dev/null || true # it may exit right now
      left=1
      if [[ "$pid" == "$SERVER_PID" || "$args" == *" $SB/plugin/bin/cowbell.js" ]]; then bad=1; fi
    fi
  done < "$PIDS"
  [[ -n "$left" ]] || return 0
  deadline=$((SECONDS + 2))
  while ((SECONDS < deadline)); do sleep 0.2; done
  while IFS=$'\t' read -r pid args; do
    if still_same "$pid" "$args"; then
      printf 'smoke: still running, sending KILL: %s %s\n' "$pid" "$args" >&2
      kill -KILL "$pid" 2> /dev/null || true # it may exit right now
    fi
  done < "$PIDS"
  return "$bad"
}

# shellcheck disable=SC2329 # called from cleanup, which runs from the EXIT trap
dump_logs() {
  printf '\n===== smoke: diagnostics =====\n'
  # cleanup runs with set +e: a failing call here prints its error (h) and
  # the dump goes on.
  if [[ -S "$SOCK" ]]; then
    printf -- '--- herdr tab list\n'
    CALL_LIMIT=5 h tab list
    printf -- '--- herdr plugin log list --plugin %s\n' "$PLUGIN_ID"
    CALL_LIMIT=5 h plugin log list --plugin "$PLUGIN_ID"
  else
    printf -- '--- (no server socket: tab list and plugin log unavailable)\n'
  fi
  printf -- '--- %s\n' "$DAEMON_LOG"
  cat "$DAEMON_LOG" 2> /dev/null || printf '(missing)\n'
  printf -- '--- tail -n 40 %s\n' "$SB/server.log"
  tail -n 40 "$SB/server.log" 2> /dev/null || printf '(missing)\n'
  printf -- '--- tail -n 40 %s\n' "$SB/c/herdr/herdr-server.log"
  tail -n 40 "$SB/c/herdr/herdr-server.log" 2> /dev/null || printf '(missing)\n'
  printf '===== end of diagnostics =====\n\n'
}

# EXIT trap: diagnostics on failure, then stop the daemon and the server and
# kill whatever this run started that is still alive. Every step is bounded.
# shellcheck disable=SC2329 # the EXIT trap handler
cleanup() {
  local rc=$?
  # Command substitutions are subshells; only the main shell cleans up.
  ((BASH_SUBSHELL == 0)) || return 0
  IN_CLEANUP=1
  set +eE
  trap - ERR
  # A handler, not '': ignored signals would be inherited by the children
  # started below. The handler does nothing, so cleanup runs to the end.
  trap ':' INT TERM HUP USR1
  if [[ -n "$WATCHDOG_PID" ]]; then
    kill -TERM "$WATCHDOG_PID" 2> /dev/null # it exits on its own when we do
    wait "$WATCHDOG_PID" 2> /dev/null
  fi
  ((rc == 0)) || dump_logs
  if [[ -f "$SB/plugin/bin/ctl.js" ]] && track_daemon; then
    ctl stop > /dev/null || printf 'smoke: ctl stop failed\n' >&2
  fi
  stop_server force
  kill_leftovers || rc=1
  if ((rc == 0)); then
    printf 'smoke: PASS herdr %s, node %s, %ss\n' "${HERDR_VERSION_LINE#herdr }" "$NODE_VERSION" "$SECONDS"
  else
    printf 'smoke: FAIL after %ss (sandbox kept in %s)\n' "$SECONDS" "$SB" >&2
    rc=1
  fi
  exit "$rc"
}

# shellcheck disable=SC2329 # the INT/HUP/TERM/USR1 trap handler
on_signal() {
  ((IN_CLEANUP == 0)) || return 0
  fail "$1"
}

# ERR fires for a failing command that set -e is about to exit on; with -E
# also inside functions. Only the main shell reports (BASH_SUBSHELL 0).
# shellcheck disable=SC2329 # the ERR trap handler
on_err() {
  ((BASH_SUBSHELL == 0)) || return 0
  printf 'smoke: FAIL: command exited %s at line %s\n' "$1" "$2" >&2
}

trap cleanup EXIT
trap 'on_err $? $LINENO' ERR
trap 'on_signal "interrupted"' INT HUP
trap 'on_signal "terminated"' TERM
trap 'on_signal "run exceeded the ${BUDGET}s budget"' USR1

# Watchdog: after BUDGET seconds, USR1 to this script; its trap fails the
# run and the EXIT trap cleans up. It checks every second that this script
# is still its parent and exits once it is not, so it never signals a
# reused pid.
perl -e '($t, $p) = @ARGV; while ($t-- > 0) { sleep 1; exit 0 if getppid() != $p } kill "USR1", $p' "$BUDGET" "$$" &
WATCHDOG_PID=$!

# --- 2. server, empty plugin registry, link a copy -------------------------
start_server
plugins=$(h plugin list)
[[ "$plugins" == "No plugins installed." ]] || fail "sandbox plugin list is not empty: $plugins"
printf 'smoke: ok: sandbox plugin list: %s\n' "$plugins"

mkdir "$SB/plugin"
cp -R "$REPO/bin" "$REPO/lib" "$REPO/herdr-plugin.toml" "$REPO/package.json" "$SB/plugin/"
linked=$(h plugin link "$SB/plugin")
printf 'smoke: ok: linked %s from %s\n' "$(json result.plugin.plugin_id <<< "$linked")" \
  "$(json result.plugin.plugin_root <<< "$linked")"

# The [[startup]] hook starts the daemon; it runs on server start, not on
# link. Restart the server to run it.
stop_server
start_server
deadline=$((SECONDS + WAIT_LIMIT))
until grep -q "connected" "$DAEMON_LOG" 2> /dev/null; do
  ((SECONDS < deadline)) || fail "daemon did not log 'connected' within ${WAIT_LIMIT}s"
  sleep 0.2
done
track_daemon || fail "no live daemon of this sandbox in $STATE_DIR/cowbell.pid"
printf 'smoke: ok: daemon (pid %s) started by the startup hook: %s\n' "$DAEMON_PID" \
  "$(grep "connected" "$DAEMON_LOG" | tail -n 1)"

# --- 3. workspace and tabs A, B, C, D (D focused) --------------------------
created=$(h workspace create --label smoke)
WS=$(json result.workspace.workspace_id <<< "$created")
T_A=$(json result.tab.tab_id <<< "$created")
P_A=$(json result.root_pane.pane_id <<< "$created")
h tab rename "$T_A" A > /dev/null
created=$(h tab create --workspace "$WS" --label B)
P_B=$(json result.root_pane.pane_id <<< "$created")
created=$(h tab create --workspace "$WS" --label C)
T_C=$(json result.tab.tab_id <<< "$created")
P_C=$(json result.root_pane.pane_id <<< "$created")
h tab create --workspace "$WS" --label D --focus > /dev/null
wait_tabs full "A/unknown | B/unknown | C/unknown | D/unknown/focused" "tabs created"

# A custom report on a pane whose foreground is an idle shell is released
# and reads unknown: give A, B and C a foreground process first, and wait
# until the three sleeps run under the server.
for p in "$P_A" "$P_B" "$P_C"; do
  h pane run "$p" "sleep 100000" > /dev/null
done
deadline=$((SECONDS + WAIT_LIMIT))
until [[ "$(descendants "$SERVER_PID" | awk -F'\t' '$2 == "sleep 100000"' | wc -l | tr -d ' ')" == 3 ]]; do
  ((SECONDS < deadline)) || fail "the three 'sleep 100000' did not start within ${WAIT_LIMIT}s"
  sleep 0.2
done
descendants "$SERVER_PID" >> "$PIDS"

# --- 4. agent states and icons ---------------------------------------------
for p in "$P_A" "$P_B" "$P_C"; do report "$p" idle; done
wait_tabs full "A/idle | B/idle | C/idle | D/unknown/focused" "all idle, no icons"

report "$P_A" working
report "$P_B" blocked
report "$P_C" working
wait_tabs full "◐ A/working | ? B/blocked | ◐ C/working | D/unknown/focused" "working and blocked"

# C is not focused, so working -> idle is done.
report "$P_C" idle
wait_tabs full "◐ A/working | ? B/blocked | ✓ C/done | D/unknown/focused" "icons ◐ ? ✓, focused D plain"

# Focusing C marks it seen: done -> idle, the ✓ goes away.
h tab focus "$T_C" > /dev/null
wait_tabs full "◐ A/working | ? B/blocked | C/idle/focused | D/unknown" "focused C plain again"

# --- 5. off restores every name --------------------------------------------
h plugin action invoke off --plugin "$PLUGIN_ID" > /dev/null
wait_tabs labels "A | B | C | D" "off restored all names"
# off also stops the daemon.
deadline=$((SECONDS + WAIT_LIMIT))
while still_same "$DAEMON_PID" "$DAEMON_ARGS"; do
  ((SECONDS < deadline)) || fail "daemon (pid $DAEMON_PID) still running ${WAIT_LIMIT}s after off"
  sleep 0.2
done
printf 'smoke: ok: daemon (pid %s) exited after off\n' "$DAEMON_PID"

# The EXIT trap stops everything and prints the PASS line.
exit 0
