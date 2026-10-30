#!/usr/bin/env bash
# Record the README media from a sandbox herdr server with a real herdr TUI
# client: docs/assets/hero.gif, docs/assets/preset-<name>.png and
# docs/assets/social-preview.png.
#
# Usage: scripts/record-demo.sh [SB]      (default SB=/tmp/cb20)
#
# SB is a short absolute directory the script creates (or one it created on
# an earlier run, marked by SB/.cowbell-demo). It starts its own herdr server
# there, links a copy of the plugin, records, renders, then stops the daemon
# and the server. It never talks to the herdr server of the session it runs
# in: the HERDR_* session variables are unset first, and every herdr call
# runs with XDG_CONFIG_HOME/XDG_STATE_HOME inside SB.
#
# Prerequisites (versions used for the committed assets):
#   herdr 0.9.3              on PATH (https://herdr.dev)
#   node >= 18               on PATH as node (also runs the plugin)
#   asciinema 2.4.0          uv tool install asciinema
#   agg 1.9.0                https://github.com/asciinema/agg/releases
#                            (agg-x86_64-unknown-linux-gnu, on PATH as agg)
#   ffmpeg + ffprobe n8.1    built with libfreetype (drawtext), e.g. the
#                            static BtbN/FFmpeg-Builds
#                            ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz
#   JetBrainsMono Nerd Font Mono  nerd-fonts v3.5.1 JetBrainsMono.tar.xz:
#                            JetBrainsMonoNerdFontMono-{Regular,Bold}.ttf in
#                            FONT_DIR (default ~/.local/share/fonts)
#   DejaVu Sans Mono         fallback for glyphs JetBrains Mono lacks (◐);
#                            Ubuntu package fonts-dejavu-core
#   Noto Color Emoji         emoji preset; Ubuntu package fonts-noto-color-emoji
#   setsid, timeout, awk,    util-linux, coreutils, gawk/mawk,
#   fc-match                 fontconfig
# VHS is not used: its Chromium needs unprivileged user namespaces, which
# Ubuntu 24.04's AppArmor default blocks.
set -euo pipefail

SB=${1:-/tmp/cb20}
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEMO=$REPO/scripts/demo
ASSETS=$REPO/docs/assets
FONT_DIR=${FONT_DIR:-$HOME/.local/share/fonts}
FONT_FAMILY="JetBrainsMono Nerd Font Mono,DejaVu Sans Mono"
BOLD_FONT=$FONT_DIR/JetBrainsMonoNerdFontMono-Bold.ttf
REGULAR_FONT=$FONT_DIR/JetBrainsMonoNerdFontMono-Regular.ttf
COLS=80
ROWS=6
FONT_SIZE=20
THEME=github-dark
PRESETS=(ask symbols emoji nerd custom)
MARKER=.cowbell-demo

# shellcheck source=scripts/demo/lib.sh
source "$DEMO/lib.sh"
drop_herdr_env

# --- argument and sandbox checks -------------------------------------------
[[ "$SB" == /* ]] || die "SB must be an absolute path: $SB"
SB=${SB%/}
SOCK=$SB/c/herdr/herdr.sock
sock_bytes=$(printf '%s' "$SOCK" | wc -c)
((sock_bytes < 108)) || die "socket path $SOCK is $sock_bytes bytes; use a shorter SB"
# sb_pids matches sandbox processes by this variable: what this script forks
# outside sb_env must not carry it.
[[ "${XDG_CONFIG_HOME:-}" != "$SB/c" ]] || die "XDG_CONFIG_HOME is already $SB/c; run from a shell outside the sandbox"

for tool in herdr node asciinema agg ffmpeg ffprobe fc-match setsid timeout awk; do
  command -v "$tool" > /dev/null || die "missing prerequisite: $tool"
done
[[ -f "$BOLD_FONT" && -f "$REGULAR_FONT" ]] || die "JetBrainsMono Nerd Font Mono not found in $FONT_DIR"
DEJAVU_FONT=$(fc-match -f '%{file}' 'DejaVu Sans Mono')
[[ "$DEJAVU_FONT" == */DejaVuSansMono.ttf ]] || die "DejaVu Sans Mono not found (fc-match gave $DEJAVU_FONT)"

# Pids of the herdr server of this sandbox: "herdr server" with SB as cwd.
server_pids() {
  local d
  for d in /proc/[0-9]*; do
    [[ "$(readlink "$d/cwd" 2> /dev/null)" == "$SB" ]] || continue
    [[ "$(tr '\0' ' ' 2> /dev/null < "$d/cmdline")" == "herdr server " ]] || continue
    printf '%s\n' "${d#/proc/}"
  done
}

# Pids of this script and its ancestors: never sandbox processes, whatever
# their command line or environment says.
self_and_ancestors() {
  local p=$$ key val
  while [[ "$p" =~ ^[1-9][0-9]*$ ]]; do
    printf '%s\n' "$p"
    val=
    # A vanished ancestor ends the walk.
    { while read -r key val; do
      if [[ "$key" == PPid: ]]; then break; fi
      val=
    done < "/proc/$p/status"; } 2> /dev/null || break
    p=$val
  done
}

# Pids of every process that belongs to this sandbox, each once: started
# with its XDG_CONFIG_HOME (server, pane shells and their sleeps, client,
# daemon), the daemon of the linked copy by its exact argv (node
# SB/plugin/bin/cowbell.js, as bin/ctl.js spawns it), or the server itself.
sb_pids() {
  local d pid
  local -a argv
  local -A skip=() seen=()
  for pid in $(self_and_ancestors); do skip[$pid]=1; done
  for d in /proc/[0-9]*; do
    pid=${d#/proc/}
    [[ -z "${skip[$pid]:-}" ]] || continue
    if grep -qzxF -- "XDG_CONFIG_HOME=$SB/c" "$d/environ" 2> /dev/null; then
      seen[$pid]=1
      continue
    fi
    # Unreadable or vanished: not a daemon this user started.
    mapfile -d '' -t argv 2> /dev/null < "$d/cmdline" || continue
    ((${#argv[@]} == 2)) || continue
    [[ "${argv[1]}" == "$SB/plugin/bin/cowbell.js" ]] || continue
    [[ "${argv[0]##*/}" == node || "${argv[0]##*/}" == nodejs ]] || continue
    seen[$pid]=1
  done
  for pid in $(server_pids); do
    if [[ -z "${skip[$pid]:-}" ]]; then seen[$pid]=1; fi
  done
  if ((${#seen[@]})); then printf '%s\n' "${!seen[@]}"; fi
}

if [[ -e "$SB" ]]; then
  [[ -d "$SB" ]] || die "$SB exists and is not a directory"
  if [[ -n "$(ls -A "$SB")" ]]; then
    [[ -f "$SB/$MARKER" ]] || die "$SB is not empty and was not created by this script (no $MARKER); pick another SB"
    [[ -z "$(sb_pids)" ]] || die "processes of an earlier run are still alive in $SB: $(sb_pids | tr '\n' ' ')"
    # Only what an earlier run of this script created.
    rm -rf -- "$SB/c" "$SB/s" "$SB/plugin" "$SB/out" "$SB/transcript.log" \
      "$SB/server.log" "$SB/demo-shell" "$SB/demo-bashrc"
  fi
fi
mkdir -p "$SB"
touch "$SB/$MARKER"
mkdir -p "$SB/c/herdr" "$SB/s" "$SB/out"
: > "$SB/transcript.log"
log "# record-demo $(date -Iseconds) SB=$SB"
log "# $(sb_env herdr --version) / node $(node --version) / $(asciinema --version) / $(agg --version) / $(ffmpeg -hide_banner -version | head -1 | cut -d' ' -f1-3)"

# A plain bash for the panes, so the user's own prompt and rc files stay out.
cat > "$SB/demo-bashrc" << 'EOF'
PS1='\[\e[32m\]$\[\e[0m\] '
EOF
cat > "$SB/demo-shell" << EOF
#!/usr/bin/env bash
exec bash --noprofile --rcfile "$SB/demo-bashrc" -i
EOF
chmod +x "$SB/demo-shell"
cp "$DEMO/config.toml" "$SB/c/herdr/config.toml"

# --- server lifecycle ------------------------------------------------------
SERVER_STARTED=0
DRIVER_PID=

start_server() {
  log "\$ (cd $SB && setsid nohup herdr server > $SB/server.log 2>&1 &)"
  (cd "$SB" && setsid nohup env -u HERDR_SOCKET_PATH -u HERDR_BIN_PATH -u HERDR_PANE_ID \
    -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID -u HERDR_ENV -u HERDR_STARTUP_CWD -u SSH_AUTH_SOCK \
    XDG_CONFIG_HOME="$SB/c" XDG_STATE_HOME="$SB/s" SHELL="$SB/demo-shell" \
    herdr server >> "$SB/server.log" 2>&1 &)
  SERVER_STARTED=1
  local i
  for ((i = 0; i < 100; i++)); do
    [[ -S "$SOCK" ]] && return 0
    sleep 0.1
  done
  die "sandbox server did not create $SOCK; see $SB/server.log"
}

stop_server() {
  h server stop > /dev/null
  local i
  for ((i = 0; i < 100; i++)); do
    [[ -z "$(server_pids)" && ! -S "$SOCK" ]] && return 0
    sleep 0.1
  done
  die "sandbox server did not stop"
}

cleanup() {
  local rc=$? i
  local -a left
  set +e
  if [[ -n "$DRIVER_PID" ]] && kill -0 "$DRIVER_PID" 2> /dev/null; then
    kill -TERM "$DRIVER_PID"
    wait "$DRIVER_PID"
  fi
  if ((SERVER_STARTED)); then
    if [[ -S "$SOCK" ]]; then
      [[ -f "$SB/plugin/bin/ctl.js" ]] && ctl stop > /dev/null
      h server stop > /dev/null
    fi
    for ((i = 0; i < 100; i++)); do
      [[ -z "$(sb_pids)" ]] && break
      sleep 0.1
    done
  fi
  mapfile -t left < <(sb_pids)
  if ((${#left[@]})); then
    # Every pid here belongs to this sandbox: its XDG_CONFIG_HOME, the exact
    # daemon argv or the server in SB, never this script or its callers.
    printf 'record-demo: still running after stop, sending TERM:\n' >&2
    ps -o pid,args -p "$(IFS=,; printf '%s' "${left[*]}")" >&2
    kill -TERM "${left[@]}"
    rc=1
  fi
  log "# cleanup: pgrep -af 'herdr server'"
  pgrep -af "herdr server" >> "$SB/transcript.log"
  log "# cleanup: processes of this sandbox (daemon, server, panes, client) still running:"
  mapfile -t left < <(sb_pids)
  if ((${#left[@]})); then
    ps -o pid,args -p "$(IFS=,; printf '%s' "${left[*]}")" >> "$SB/transcript.log"
  else
    log "(none)"
  fi
  log "# exit $rc"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# Value at a dotted path in the JSON on stdin, e.g. json result.tab.tab_id.
json() {
  node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let v = JSON.parse(s);
      for (const k of process.argv[1].split(".")) v = v == null ? undefined : v[k];
      if (v === undefined) { process.stderr.write(`json: no ${process.argv[1]}\n`); process.exit(1); }
      console.log(v);
    });' "$1"
}

# --- 1. server, empty plugin registry, link a copy -------------------------
start_server
plugins=$(h plugin list)
[[ "$plugins" == "No plugins installed." ]] || die "sandbox plugin list is not empty: $plugins"

mkdir "$SB/plugin"
cp -r "$REPO/bin" "$REPO/lib" "$REPO/herdr-plugin.toml" "$REPO/package.json" "$SB/plugin/"
log "\$ cp -r bin lib herdr-plugin.toml package.json $SB/plugin/"
h plugin link "$SB/plugin" > /dev/null
h plugin list > /dev/null

# The [[startup]] hook starts the daemon: restart the server to run it.
stop_server
start_server
DAEMON_LOG=$SB/s/herdr/plugins/$PLUGIN_ID/daemon.log
for ((i = 0; i < 100; i++)); do
  grep -q "connected" "$DAEMON_LOG" 2> /dev/null && break
  sleep 0.1
done
grep -q "connected" "$DAEMON_LOG" 2> /dev/null || die "daemon did not connect; see $DAEMON_LOG"
h plugin log list --plugin "$PLUGIN_ID" > /dev/null
ctl status > /dev/null
log "# daemon.log:"
cat "$DAEMON_LOG" >> "$SB/transcript.log"

# --- 2. workspace and tabs -------------------------------------------------
created=$(h workspace create --label demo)
WS=$(json result.workspace.workspace_id <<< "$created")
T_API=$(json result.tab.tab_id <<< "$created")
P_API=$(json result.root_pane.pane_id <<< "$created")
h tab rename "$T_API" api > /dev/null

new_tab() { # <label> [--focus]; prints "tab_id pane_id"
  local out
  out=$(h tab create --workspace "$WS" --label "$@")
  printf '%s %s\n' "$(json result.tab.tab_id <<< "$out")" "$(json result.root_pane.pane_id <<< "$out")"
}
read -r _ P_REVIEW < <(new_tab review)
read -r T_TESTS P_TESTS < <(new_tab tests)
read -r T_NOTES P_NOTES < <(new_tab notes)
read -r T_SHELL P_SHELL < <(new_tab shell --focus)
[[ -n "$P_REVIEW" && -n "$P_TESTS" && -n "$P_NOTES" && -n "$P_SHELL" ]] || die "could not read tab/pane ids"

# A foreground process per agent pane, else a custom report is released.
for p in "$P_API" "$P_REVIEW" "$P_TESTS" "$P_NOTES"; do
  h pane run "$p" "sleep 100000" > /dev/null
done
sleep 1
for p in "$P_API" "$P_REVIEW" "$P_TESTS" "$P_NOTES"; do report "$p" idle; done
wait_tabs '"api"	idle' '"review"	idle' '"tests"	idle' '"notes"	idle' '"shell"	unknown	focused'

# --- recording helpers -----------------------------------------------------
# record <name> <seconds>: a herdr client in asciinema, ended by timeout.
# --foreground keeps herdr in the pty's foreground process group; without
# it the client is stopped by SIGTTOU when it switches the tty to raw mode.
# -k 5: KILL if the client ignores TERM.
record() {
  local cast=$SB/out/$1.cast rc=0
  log "\$ asciinema rec --cols $COLS --rows $ROWS -c 'timeout --foreground -k 5 -s TERM $2 herdr' $cast < /dev/null"
  sb_env TERM=xterm-256color asciinema rec -q --overwrite --cols "$COLS" --rows "$ROWS" \
    -c "timeout --foreground -k 5 -s TERM $2 herdr" "$cast" < /dev/null >> "$SB/out/asciinema.log" 2>&1 || rc=$?
  ((rc == 0)) || die "asciinema rec $1 exited $rc; see $SB/out/asciinema.log"
  node "$DEMO/trim-cast.js" "$cast" "$SB/out/$1.trim.cast" >> "$SB/transcript.log"
}

# render <cast> <gif> [agg options]
render() {
  local cast=$1 gif=$2
  shift 2
  sb_env agg -q --font-dir "$FONT_DIR" --text-font-family "$FONT_FAMILY" \
    --font-size "$FONT_SIZE" --theme "$THEME" "$@" "$cast" "$gif"
}

# Last frame of a GIF as PNG.
last_frame() {
  ffmpeg -hide_banner -loglevel error -y -i "$1" -update 1 "$2"
}

# --- 3. hero ---------------------------------------------------------------
log "# hero: driver + client"
P_API=$P_API P_REVIEW=$P_REVIEW P_TESTS=$P_TESTS P_NOTES=$P_NOTES T_TESTS=$T_TESTS \
  "$DEMO/drive.sh" "$SB" &
DRIVER_PID=$!
record hero 12
wait "$DRIVER_PID" || die "driver failed"
DRIVER_PID=
wait_tabs '"◐ api"	working' '"? review"	blocked' '"tests"	idle	focused' '"✓ notes"	done'
render "$SB/out/hero.trim.cast" "$SB/out/hero.gif" --last-frame-duration 3
cp "$SB/out/hero.gif" "$ASSETS/hero.gif"

# --- 4. presets ------------------------------------------------------------
# State for the stills: api working, review blocked, tests done, notes idle
# and seen, shell focused.
h tab focus "$T_NOTES" > /dev/null
sleep 0.5
h tab focus "$T_SHELL" > /dev/null
report "$P_TESTS" working
sleep 0.5
report "$P_TESTS" idle
wait_tabs '"◐ api"	working' '"? review"	blocked' '"✓ tests"	done' '"notes"	idle' '"shell"	unknown	focused'

CONFIG_DIR=$SB/c/herdr/plugins/config/$PLUGIN_ID
# Nerd glyphs as UTF-8 bytes: U+F110, U+F059, U+F00C.
declare -A WORKING=([ask]="◐" [symbols]="◐" [emoji]="⏳" [nerd]=$'\xef\x84\x90' [custom]="»")
declare -A BLOCKED=([ask]="?" [symbols]="×" [emoji]="❓" [nerd]=$'\xef\x81\x99' [custom]="!")
declare -A DONE=([ask]="✓" [symbols]="✓" [emoji]="✅" [nerd]=$'\xef\x80\x8c' [custom]="*")
mkdir -p "$CONFIG_DIR"
for preset in "${PRESETS[@]}"; do
  log "# preset $preset"
  cp "$DEMO/presets/$preset.json" "$CONFIG_DIR/config.json"
  log "\$ cp scripts/demo/presets/$preset.json $CONFIG_DIR/config.json"
  # refresh does not re-read config.json; a daemon restart does.
  h plugin action invoke toggle --plugin "$PLUGIN_ID" > /dev/null
  wait_tabs '"api"	working' '"review"	blocked' '"tests"	done'
  h plugin action invoke toggle --plugin "$PLUGIN_ID" > /dev/null
  wait_tabs "\"${WORKING[$preset]} api\"	working" "\"${BLOCKED[$preset]} review\"	blocked" \
    "\"${DONE[$preset]} tests\"	done" '"notes"	idle' '"shell"	unknown	focused'
  record "preset-$preset" 3
  render "$SB/out/preset-$preset.trim.cast" "$SB/out/preset-$preset.gif"
  last_frame "$SB/out/preset-$preset.gif" "$ASSETS/preset-$preset.png"
done
h plugin log list --plugin "$PLUGIN_ID" > /dev/null

# --- 5. social preview -----------------------------------------------------
# 1280x640: title, tagline, the top two rows of the ask still (tab bar and
# prompt) and a legend. The legend uses DejaVu Sans Mono for the ◐. Crop
# height 84 px = 14 px padding + two 28 px rows (FONT_SIZE 20, line height 1.4).
printf '%s' "◐ working    ? waiting for you    ✓ done" > "$SB/out/legend.txt"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=0x0d1117:s=1280x640" -i "$ASSETS/preset-ask.png" \
  -filter_complex "[1:v]crop=iw:84:0:0,scale=1160:-1:flags=lanczos[shot];
    [0:v][shot]overlay=(W-w)/2:320,
    drawtext=fontfile=$BOLD_FONT:text='herdr-cowbell':fontsize=84:fontcolor=0xe6edf3:x=(w-tw)/2:y=100,
    drawtext=fontfile=$REGULAR_FONT:text='agent status icons in your herdr tab bar':fontsize=36:fontcolor=0x8b949e:x=(w-tw)/2:y=220,
    drawtext=fontfile=$DEJAVU_FONT:textfile=$SB/out/legend.txt:fontsize=32:fontcolor=0xc9d1d9:x=(w-tw)/2:y=490" \
  -frames:v 1 "$ASSETS/social-preview.png"

# --- 6. checks -------------------------------------------------------------
hero_bytes=$(stat -c %s "$ASSETS/hero.gif")
((hero_bytes < 2000000)) || die "hero.gif is $hero_bytes bytes (limit 2 MB)"
size=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$ASSETS/social-preview.png")
[[ "$size" == "1280x640" ]] || die "social-preview.png is $size, not 1280x640"
for f in hero.gif preset-{ask,symbols,emoji,nerd,custom}.png social-preview.png; do
  printf '%-20s %s %s bytes\n' "$f" \
    "$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$ASSETS/$f")" \
    "$(stat -c %s "$ASSETS/$f")" | tee -a "$SB/transcript.log"
done

# --- 7. stop the daemon and the server (the EXIT trap checks for leftovers)
ctl stop > /dev/null
stop_server
SERVER_STARTED=0
echo "record-demo: done; transcript in $SB/transcript.log"
