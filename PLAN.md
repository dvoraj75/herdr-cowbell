# herdr-cowbell — implementation plan

Status: **phase 0 done; facts checked on herdr 0.9.3 sandbox 2026-10-29.**
Nothing implemented yet. The facts table below cites the spike (issue #3) and
the herdr source/docs at 0.9.5.

## Goal

Show each tab's agent state in the herdr TUI tab bar, the way the sidebar does
for agents:

```
 promptator │ ◐ grundza 1 │ ? grundza 2 │ ✓ cervenak │ grundza 3 │ term
```

- `◐` an agent in the tab is working
- `?` an agent is waiting for you (blocked)
- `✓` an agent finished and you haven't looked yet (done)
- nothing when idle / unknown (configurable)

Plugin id `dvoraj75.cowbell`, installed with
`herdr plugin install dvoraj75/herdr-cowbell`.

## What herdr gives us (and doesn't)

Terms: **workspace** (a "Space" in the sidebar) → **tabs** → **panes**
(terminals). An agent runs in a pane; herdr rolls pane state up to the tab.

| Fact | Source | Consequence |
|---|---|---|
| The tab bar draws only the tab label (plus ` Z` when zoomed). There are no tokens, styles or per-tab icons. | `src/client/shell/tabs.rs` (`tab_label`) | The icon **has to be part of the label**, so we rename tabs. No colour except what emoji carry themselves. |
| `tab.list` returns `agent_status` per tab, already rolled up: blocked > done (idle and unseen) > working > idle > unknown. | `src/app/creation.rs` `tab_info`, `src/app/api_helpers.rs` `tab_attention_priority` | We don't compute the rollup ourselves; one `tab.list` call gives the full picture. |
| `tab.rename {tab_id, label}` sets a custom name. There is **no way back** to the automatic name: renaming to `""` stores a literal empty label, the TUI rename prompt ignores empty input, and no API field marks a name as custom. | sandbox 0.9.3 (#3); `src/workspace/tab.rs` `set_custom_name` | Auto-named tabs are skipped unless the user opts in (see Label model). Once we rename a tab it is custom for good. |
| `number` is a stable per-workspace id (`tab_id` = `w<N>:t<number>`). It is never recomputed on move, close or create, and survives a server restart. The automatic label is the **1-based position** in the workspace, not `number`. herdr emits no `tab.renamed` when it shifts. | sandbox 0.9.3 (#3); `src/workspace.rs` `tab_display_name` | After `tab.move`, `w1:t4` had `number:4, label:"1"`. Auto-name detection and sync use position, never `number`. Resync on `tab.moved`, `tab.closed`, `tab.created`. |
| `tab.list` returns `{type:"tab_list", tabs:[{tab_id, workspace_id, number, label, focused, pane_count, agent_status}]}`. `agent_status` is `idle`, `working`, `blocked`, `done` or `unknown`. `tab.move {tab_id, insert_index}` has no CLI command, only the socket. | sandbox 0.9.3 (#3); `herdr api schema --json` | Order in `tab.list` is the position order. |
| `events.subscribe` takes the lifecycle types we use (`tab.*`, `pane.*`, `workspace.*`) without filters; `pane.agent_status_changed`, `pane.output_matched` and `pane.scroll_changed` need a `pane_id`. A `pane.agent_status_changed` subscription without one fails the request with `invalid_request`, and one unknown pane id fails the whole request with `pane_not_found`. Newline-delimited JSON over the socket at `$HERDR_SOCKET_PATH`. | sandbox 0.9.3 (#3); `herdr api schema --json`, `src/api/schema/events.rs` | Two connections: lifecycle events, and per-pane agent status (see Daemon loop). |
| Wire envelopes differ. Lifecycle events: `{"event":"tab_focused","data":{"type":"tab_focused",…}}` (underscore names). Agent status: `{"event":"pane.agent_status_changed","data":{pane_id, workspace_id, agent_status, agent}}` (dotted name, no `data.type`). | sandbox 0.9.3 (#3) | The event parser handles both. |
| `events_lost` is **not an event type**. If the subscriber falls behind, herdr sends an error response `{"id":…,"error":{"code":"events_lost",…}}` on the subscription connection and closes it. | docs/socket-api "Event subscriptions"; CHANGELOG 0.9.2 | On any disconnect: reconnect, then resync everything with `tab.list`. |
| Focusing a done tab marks it seen: `tab.focus`, `pane.focus` (and the TUI), even with no client. herdr sends `workspace_focused`, `tab_focused`, `pane_focused`, then 20–35 ms later `pane.agent_status_changed` `idle`, only to per-pane subscribers and plugin hooks. `tab.get` and `tab.list` do not mark seen. An agent that finishes on the focused tab goes working → idle, never done. Not tested: a TUI client whose outer terminal is unfocused. | sandbox 0.9.3 (#3); `src/app/actions.rs` `mark_active_tab_seen`, `src/workspace.rs` `switch_tab` | Also resync on `tab.focused`, `pane.focused` and `workspace.focused`, in case the per-pane event is missing. |
| Closing a tab emits `tab_closed` but no `pane_closed` for its panes, and no `tab_focused` for the tab that becomes active. | sandbox 0.9.3 (#3) | Rebuild the per-pane subscriptions on `tab.closed` too. |
| `[[startup]]` hooks are one-shot and unsupervised. They run once per server start (and live handoff), with `HERDR_PLUGIN_EVENT=startup`. They do **not** run on plugin link, on enable, or on config reload. | sandbox 0.9.3 (#3); docs/plugins "Startup hooks" | The startup hook launches a **detached daemon** and exits. The daemon must be a singleton (pidfile or lock in `$HERDR_PLUGIN_STATE_DIR`). After `link` or `enable`, the daemon is not running until the next server start, the next `pane.agent_detected` (watchdog hook), or until the user runs *Cowbell: on/off* (toggle). |
| Disable and uninstall deliver no hook or event to the plugin. A detached daemon keeps running and its socket stays open. `[[events]]` hooks stop on disable/uninstall and resume on enable. Config and state dirs are kept. | sandbox 0.9.3 (#3); `src/app/api/plugins/mod.rs` | herdr has no cleanup path. See Risks: uninstall leaves icons. |
| Plugin commands: argv only, cwd = plugin root, no timeout, max 32 at once. Env: `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH`, `HERDR_ENV=1`, `HERDR_PLUGIN_ID`, `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_STATE_DIR`, `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_CONTEXT_JSON`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID`, plus `HERDR_PLUGIN_EVENT` (hooks and startup), `HERDR_PLUGIN_EVENT_JSON` (`[[events]]` hooks only) or `HERDR_PLUGIN_ACTION_ID` (actions). | sandbox 0.9.3 (#3); docs/plugins, `src/app/api/plugins/runtime.rs` | Fine for a daemon plus short control actions. |
| `[[events]] on` accepts `workspace.*`, `worktree.*`, `tab.*` and `pane.*` names, including `pane.agent_detected` and `pane.agent_status_changed`. The latter needs no pane filter there. `agent_detected` fires on the first report in a pane, not on later state changes. An unknown name is a warning, not an error. | sandbox 0.9.3 (#3); `src/api/schema/events.rs` `PLUGIN_HOOK_EVENT_KINDS` | Fallback for per-pane subscriptions (Daemon loop). |
| herdr-radar (installed) subscribes to `tab.renamed`, so every rename wakes it. | `lib/subscribe.js` in herdr-radar | Rename **only when the icon actually changes**. A spinner would mean a rename per frame, so keep it off by default. |
| Other plugins also rename tabs (`herdr-auto-title`, `herdr-automatic-rename`, `herdr-tab-smart-rename`, `herdr-bar`). | marketplace, 2026-10-29 | Our model of the tab's real name must handle someone else renaming it (below). Document the conflict in the README. |

## Design

### Label model

```
label = icon + separator + base        (separator default " ")
label = base                           (when the state shows no icon)
```

- `base` is the tab's real name, stored per `tab_id` in
  `$HERDR_PLUGIN_STATE_DIR/state.json` together with the last label **we**
  wrote.
- `strip(label)` removes a leading icon from **any** preset (plus custom icons
  and spinner frames) followed by the separator. Running strip more than once is
  safe, so we never end up with `? ? grundza`.
- On `tab.renamed`: if the new label equals the label we last wrote, it's our
  own echo, so ignore it. Otherwise the user or another plugin renamed the tab:
  `base = strip(new label)`, then re-apply the icon.
- Auto-named tabs are skipped unless `include_auto_named` is on. It defaults to
  **false (opt-in)**: the planned default-true gate ("`number` is recomputed
  and the automatic label is exactly that number") failed in the spike.
  When it is on:
  - A tab is auto-named when `label === String(position)` (1-based index in
    its workspace, from `tab.list` order) the first time we see it. We store
    `auto: true` for it in state.json.
  - On every resync, an `auto` tab gets `base = String(current position)`,
    not `number`.
  - A rename by the user or another plugin makes the tab custom: `auto`
    becomes false and `base = strip(new label)`.
  - Limits: a custom name equal to its position number looks like an auto
    name. Once we rename an auto-named tab it is custom in herdr for good, so
    after Cowbell is off or removed its label freezes at the number it had and
    stops following moves and closes. herdr sends no `tab.renamed` when auto
    labels shift, so resync must run on `tab.moved`, `tab.closed` and
    `tab.created`.
- Tab closed → drop its state entry.

### Icon presets

| preset | working | blocked | done | idle | unknown |
|---|---|---|---|---|---|
| `ask` (default) | `◐` | `?` | `✓` | — | — |
| `symbols` (same as herdr's `status_indicators = "symbols"`) | `◐` | `×` | `✓` | — | — |
| `emoji` (the only preset with colour) | `⏳` | `❓` | `✅` | — | — |
| `nerd` (needs a Nerd Font) | `` | `` | `` | — | — |
| `custom` | from config | | | | |

The optional spinner applies only to `working`: frames `◐◓◑◒`, interval at
least 1000 ms, off by default.

### Config: `$HERDR_PLUGIN_CONFIG_DIR/config.json`

```json
{
  "preset": "ask",
  "icons": { "working": "◐", "blocked": "?", "done": "✓", "idle": "", "unknown": "" },
  "separator": " ",
  "include_auto_named": false,
  "spinner": { "enabled": false, "frames": ["◐", "◓", "◑", "◒"], "interval_ms": 1000 }
}
```

`include_auto_named` is opt-in because herdr cannot turn a renamed tab back
into an auto-named one (see Label model).

`icons` overrides single states of the chosen preset. If the file is missing,
use the defaults. If it's invalid, log the error and keep the last good config.

### Components

```
herdr-plugin.toml
bin/cowbell.js      daemon: subscribe → resync → rename; singleton; exits when the socket closes for good
bin/ctl.js          control: start | stop | on | off | refresh | cycle-preset | status
lib/socket.js       NDJSON client for $HERDR_SOCKET_PATH (request/response + subscription stream)
lib/label.js        strip / compose / skip rules  (pure, unit-tested)
lib/icons.js        presets + config merge         (pure, unit-tested)
lib/state.js        state.json read/write (atomic: write tmp file, then rename)
test/*.test.js      node:test, no dependencies
```

Runtime: **Node ≥ 18, no npm dependencies, no build step.** Confirmed
(decision 2026-10-29). Talk to herdr through the raw socket
(`net.connect(HERDR_SOCKET_PATH)`, which also accepts a Windows named pipe)
rather than spawning `herdr` for every rename.

### Daemon loop

```
start:
  take the lock (pidfile in STATE_DIR); exit if another live daemon holds it
  load config + state
connect (two connections):
  conn 1: events.subscribe [pane.created, pane.closed, pane.moved, pane.exited,
                            pane.focused, tab.created, tab.closed, tab.renamed,
                            tab.moved, tab.focused, workspace.focused,
                            workspace.closed]                  (no filters)
  conn 2: events.subscribe pane.agent_status_changed once per pane,
          built from pane.list
  resync() after both subscriptions are started (no replay: events from
          before `subscription_started` are not delivered)
on event:   debounce ~100 ms, then resync()
            (tab.renamed is handled first, to update base)
            focus events resync too: they clear ✓ even if conn 2 misses the
            idle event that follows them
pane set changes (pane.created, pane.closed, pane.moved, tab.closed,
  workspace.closed): close conn 2 and reopen it from a fresh pane.list.
  Then resync() once conn 2 gets `subscription_started`, so a status change
  during the rebuild is not lost.
  On pane_not_found: re-list panes and retry.
  (tab.closed emits no pane.closed for its panes.)
resync():
  tabs = tab.list
  for each tab: want = compose(base(tab), icon(tab.agent_status))
                (auto tab: base = String(position in its workspace))
                if tab.label != want: tab.rename(tab.id, want); remember want
  drop state for tabs that no longer exist
on disconnect / events_lost error: back off 0.5 s → 30 s and retry; give up
  and exit when the server is gone (startup hook brings us back)
on "off" / SIGTERM: restore every tab to its base, delete pidfile, exit
```

Fallback if per-pane subscriptions prove fragile: a plugin
`[[events]] on = "pane.agent_status_changed"` hook (needs no pane id) running
`bin/ctl.js refresh`. The implementer of the daemon (issue #5) decides after
trying.

### Manifest (draft)

```toml
id = "dvoraj75.cowbell"
name = "Cowbell"
version = "0.1.0"
# Hard floor is 0.7.5 ([[startup]]). The daemon relies on live-start
# subscriptions (0.9.0) and on events_lost on overrun (0.9.2).
min_herdr_version = "0.9.2"
description = "Agent status on your tabs: ◐ working, ? waiting for you, ✓ done."
platforms = ["linux", "macos"]   # windows later

[[startup]]
command = ["node", "bin/ctl.js", "start"]

[[events]]                       # watchdog: restart the daemon if it died (herdr-radar pattern)
on = "pane.agent_detected"
command = ["node", "bin/ctl.js", "start"]

[[actions]]
id = "toggle"
title = "Cowbell: on/off"
command = ["node", "bin/ctl.js", "toggle"]

[[actions]]
id = "off"
title = "Cowbell: off and remove icons"
command = ["node", "bin/ctl.js", "off"]

[[actions]]
id = "refresh"
title = "Cowbell: refresh now"
command = ["node", "bin/ctl.js", "refresh"]

[[actions]]
id = "cycle-preset"
title = "Cowbell: next icon preset"
command = ["node", "bin/ctl.js", "cycle-preset"]
```

Users bind keys in their `config.toml`:

```toml
[[keys.command]]
key = "prefix+b"
type = "plugin_action"
command = "dvoraj75.cowbell.toggle"
description = "cowbell on/off"
```

## Phases

0. **Sandbox spike** (done 2026-10-29, issue #3): checked tab numbers,
   disable/uninstall, seen, the event set and the version floor on a 0.9.3
   sandbox. Results are in the facts table and the Decisions.
1. **Scaffold**: manifest, `package.json` (`"type": "module"`, `node --test`),
   `.gitignore`, empty modules.
2. **Pure logic + tests**: `label.js` and `icons.js`. Cases: strip any
   preset's icon, strip repeated icons, user rename while an icon is shown,
   auto-named tab skipped, emoji (2-cell) icons, empty `base`.
3. **Socket client + daemon** against the sandbox server (see Testing): resync,
   rename, echo suppression, reconnect.
4. **Control actions**: start/stop/toggle/off/refresh, the singleton lock, and
   off restoring every tab name.
5. **Presets + config**: `cycle-preset`, `config.json`, custom icons.
6. **Edge cases** (reproduce each in the sandbox): done → seen clears `✓`;
   server restart (startup hook reruns, daemon replaced); live handoff; a pane
   moved across tabs; a tab closed while a rename is in flight; two daemons
   racing.
7. **Optional spinner** (≥ 1 s, off by default).
8. **Release**: README with screenshots of each preset, CHANGELOG, tag
   `v0.1.0`. The repo already has the `herdr-plugin` topic, so the marketplace
   lists it once `herdr-plugin.toml` is on the default branch.

## Testing: always on a sandbox server

The dev session usually runs **inside a herdr pane**. `HERDR_SOCKET_PATH` is
set there and points at the **live** server. Any `herdr …` call, even with
`XDG_CONFIG_HOME` overridden, then changes your real tabs and plugin registry.
Use an isolated server:

```sh
SB=<short dir>            # keep it short: the socket path must fit in 108 bytes
mkdir -p "$SB/c" "$SB/s" && cd "$SB"
clean() { env -u HERDR_SOCKET_PATH -u HERDR_BIN_PATH -u HERDR_PANE_ID -u HERDR_TAB_ID \
              -u HERDR_WORKSPACE_ID -u HERDR_ENV -u HERDR_STARTUP_CWD \
              XDG_CONFIG_HOME=c XDG_STATE_HOME=s "$@"; }
clean herdr server &                 # headless server, its own socket at c/herdr/herdr.sock
clean herdr plugin list              # must say "No plugins installed" before you link anything
```

- With relative `XDG_*` paths, plugin commands get relative socket and state
  paths too, and those resolve from the plugin root. So link a copy of the
  plugin that lives in `$SB` itself, or use a short absolute `$SB`.
- Make agent states without a real agent:
  `clean herdr pane report-agent <pane> --source custom:test --agent test --state blocked`
  (states: `idle | working | blocked | unknown`; checked on 0.9.3). `done`
  can't be reported: it is `idle` on a pane you haven't looked at. Get it by
  going working → idle on a tab that isn't focused.
- On a pane whose foreground is an idle shell, a custom report is released
  within ~0.4 s and reads `unknown`. First run a foreground process:
  `clean herdr pane run <pane> sleep 100000`.
- `tab.move` has no CLI command. Send it over the socket.
- Check what happened: `clean herdr tab list`,
  `clean herdr plugin log list --plugin dvoraj75.cowbell`.
- Stop the server: `clean herdr server stop`.
- Link into the real herdr only when the user says so.

## Decisions (2026-10-29)

1. Default preset is `ask` (`◐ ? ✓`). Single-cell glyphs render the same in
   every font; emoji are 2 cells wide, so `emoji` is opt-in.
2. `done` gets `✓`: it is the most actionable signal, and it clears when the
   tab is seen.
3. Runtime is Node ≥ 18 with no dependencies. A long-lived socket client in
   Bash + jq would be fragile.
4. Linux and macOS only in v1 (manifest `platforms = ["linux", "macos"]`).
   Windows later: daemon detach and pidfile differ.
5. No tab-bar-right summary mode in v1 (herdr-radar uses that area). Possible
   v2 mode.
6. `include_auto_named` was planned as default true, gated on the spike. The
   gate failed, so it is opt-in (see Label model).

## Risks

- **Uninstall leaves icons**: disable and uninstall run no hook, and the
  detached daemon keeps running. Renamed tabs stay custom in herdr. The README
  must say to run *Cowbell: off* before uninstalling or disabling. Untested
  idea (issues #6/#7): the daemon checks `plugin.list` for its own id and
  `enabled` on resync, and runs off plus exit when it is disabled or gone.
- **Stale icons**: names are saved in the session, so if the daemon dies
  uncleanly the icons stay. Mitigation: strip on startup, the `off` action,
  and running strip more than once is safe.
- **Fighting other renamers**: two plugins renaming the same tab can loop.
  Mitigation: echo suppression, and treat foreign renames as the new base
  (don't re-fight them). If renames ping-pong, back off.
- **Waking other plugins / CPU**: rename only on icon changes; spinner off by
  default.
- **herdr API is v1 and young**: pin `min_herdr_version`, keep socket calls in
  `lib/socket.js`, re-check the changelog on upgrades.

## References

- Plugins: https://herdr.dev/tui/docs/plugins/
- Socket API: https://herdr.dev/tui/docs/socket-api/ (and
  `herdr api schema --json` for the exact shapes in your version)
- CLI: https://herdr.dev/tui/docs/cli-reference/
- herdr source: https://github.com/herdrdev/herdr (`src/app/api/plugins/`)
- Examples: https://github.com/ogulcancelik/herdr-plugin-examples
- A daemon-style plugin to learn from: https://github.com/hhdebb/herdr-radar
  (`lib/subscribe.js`, `bin/agent-state.js`)
