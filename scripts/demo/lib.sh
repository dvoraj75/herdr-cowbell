# shellcheck shell=bash
# Helpers shared by record-demo.sh and drive.sh. Source with SB set to the
# absolute sandbox directory. Every herdr call goes through sb_env, which
# drops the variables that would point herdr at the live server, and
# SSH_AUTH_SOCK, which inside a herdr pane is the live server's agent link.

HERDR_VARS=(HERDR_SOCKET_PATH HERDR_BIN_PATH HERDR_PANE_ID HERDR_TAB_ID
  HERDR_WORKSPACE_ID HERDR_ENV HERDR_STARTUP_CWD)
PLUGIN_ID=dvoraj75.cowbell

die() {
  printf 'record-demo: %s\n' "$*" >&2
  exit 1
}

# Unset the herdr session variables in this shell and refuse to go on if
# that did not work (a readonly variable would make unset fail under -e).
drop_herdr_env() {
  local v
  for v in "${HERDR_VARS[@]}"; do unset "$v"; done
  [[ -z "${HERDR_SOCKET_PATH+x}" ]] || die "HERDR_SOCKET_PATH is still set; refusing to run"
}

# Run a command in the sandbox environment.
sb_env() {
  env -u HERDR_SOCKET_PATH -u HERDR_BIN_PATH -u HERDR_PANE_ID -u HERDR_TAB_ID \
    -u HERDR_WORKSPACE_ID -u HERDR_ENV -u HERDR_STARTUP_CWD -u SSH_AUTH_SOCK \
    XDG_CONFIG_HOME="$SB/c" XDG_STATE_HOME="$SB/s" SHELL="$SB/demo-shell" "$@"
}

log() {
  printf '%s\n' "$*" >> "$SB/transcript.log"
}

# herdr in the sandbox; command and output go to the transcript. The output
# is also printed for callers that parse it. A failing call fails the caller.
h() {
  local out rc=0
  log "\$ herdr $*"
  out=$(sb_env herdr "$@" 2>&1) || rc=$?
  [[ -z "$out" ]] || printf '%s\n' "$out" >> "$SB/transcript.log"
  if ((rc != 0)); then
    log "(exit $rc)"
    printf '%s\n' "$out" >&2
    return "$rc"
  fi
  [[ -z "$out" ]] || printf '%s\n' "$out"
}

# The plugin's control CLI with the variables herdr gives a plugin command.
ctl() {
  log "\$ ctl $*"
  local out rc=0
  out=$(env -i PATH="$PATH" HOME="$HOME" \
    HERDR_SOCKET_PATH="$SB/c/herdr/herdr.sock" \
    HERDR_PLUGIN_STATE_DIR="$SB/s/herdr/plugins/$PLUGIN_ID" \
    HERDR_PLUGIN_CONFIG_DIR="$SB/c/herdr/plugins/config/$PLUGIN_ID" \
    HERDR_PLUGIN_ID="$PLUGIN_ID" \
    node "$SB/plugin/bin/ctl.js" "$@" 2>&1) || rc=$?
  [[ -z "$out" ]] || printf '%s\n' "$out" >> "$SB/transcript.log"
  if ((rc != 0)); then
    log "(exit $rc)"
    printf '%s\n' "$out" >&2
    return "$rc"
  fi
  [[ -z "$out" ]] || printf '%s\n' "$out"
}

# Condensed `herdr tab list`: one "id label status [focused]" line per tab.
# The full JSON goes to the transcript through h.
tab_list() {
  h tab list | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const j = JSON.parse(s);
      const tabs = (j.result && j.result.tabs) || j.tabs || [];
      for (const t of tabs) {
        console.log([t.tab_id, JSON.stringify(t.label), t.agent_status, t.focused ? "focused" : ""].join("\t").trimEnd());
      }
    });'
}

# Wait until every argument is a substring of some line of the condensed
# tab list (fixed strings, e.g. '"? review"<TAB>blocked'); log the list.
wait_tabs() {
  local i list="" want ok
  for ((i = 0; i < 50; i++)); do
    list=$(tab_list)
    ok=1
    for want in "$@"; do
      grep -qF -- "$want" <<< "$list" || { ok=0; break; }
    done
    if ((ok)); then
      log "# tab list:"
      log "$list"
      return 0
    fi
    sleep 0.2
  done
  printf '%s\n' "$list" >&2
  die "timed out waiting for the tab list to contain: $*"
}

# Report an agent state for a pane (custom source, like an integration would).
report() {
  h pane report-agent "$1" --source custom:test --agent test --state "$2" > /dev/null
}
