# herdr-cowbell

A [herdr](https://herdr.dev) plugin that shows your agents' status as an icon in front of the tab name:

```
 promptator │ ◐ grundza 1 │ ? grundza 2 │ ✓ cervenak │ grundza 3 │ term
```

This line is schematic. Captures of a real client are under [Presets](#presets).

`◐` working · `?` waiting for you (blocked) · `✓` done and not seen yet. Idle and unknown agents show nothing. Cowbell renames the tabs because herdr's tab bar has no per-tab icon slot.

## Install

```sh
herdr plugin install dvoraj75/herdr-cowbell
```

Requirements: herdr 0.9.2 or newer, Node 18 or newer on `PATH` as `node`, Linux or macOS.

herdr runs no hook on install, link or enable. The daemon starts at the next herdr server start (startup hook), when the next agent is detected in a pane (`pane.agent_detected` watchdog), or right away with *Cowbell: refresh now* (if you switched cowbell off before an uninstall or disable, use *Cowbell: on/off* instead; see [Known limitations](#known-limitations)). By default cowbell leaves tabs you never named (auto-named tabs) alone; see [Configuration](#configuration).

## Presets

| Preset | working | blocked | done | Notes |
| --- | --- | --- | --- | --- |
| `ask` (default) | `◐` | `?` | `✓` | |
| `symbols` | `◐` | `×` | `✓` | Like herdr's `status_indicators = "symbols"`. |
| `emoji` | `⏳` | `❓` | `✅` | The only one with colour; two cells wide. |
| `nerd` | `` (U+F110) | `` (U+F059) | `` (U+F00C) | Needs a Nerd Font; the glyphs vanish in many fonts. |
| `custom` | from `config.json` | | | No icons of its own. |

The captures below come from a sandbox herdr 0.9.3 server on 2026-10-30, with one agent per tab: `api` working, `review` blocked, `tests` done and not seen yet, `notes` idle; `shell` has no agent and is focused. The tab bar row is the screen of a real client, rebuilt as text.

### ask

Tab bar of a herdr 0.9.3 client (focused tab: `shell`), then the condensed `tab.list` reply ([docs/captures/ask.txt](docs/captures/ask.txt)):

```
  ◐ api     ? review     ✓ tests     notes     shell    +

w1:t1   label="◐ api"        status=working
w1:t2   label="? review"     status=blocked
w1:t3   label="✓ tests"      status=done
w1:t4   label="notes"        status=idle
w1:t5   label="shell"        status=unknown  focused
```

<!-- TODO(user): screenshot ask -->

### symbols

Tab bar of a herdr 0.9.3 client (focused tab: `shell`), then the condensed `tab.list` reply ([docs/captures/symbols.txt](docs/captures/symbols.txt)):

```
  ◐ api     × review     ✓ tests     notes     shell    +

w1:t1   label="◐ api"        status=working
w1:t2   label="× review"     status=blocked
w1:t3   label="✓ tests"      status=done
w1:t4   label="notes"        status=idle
w1:t5   label="shell"        status=unknown  focused
```

<!-- TODO(user): screenshot symbols -->

### emoji

Tab bar of a herdr 0.9.3 client (focused tab: `shell`), then the condensed `tab.list` reply ([docs/captures/emoji.txt](docs/captures/emoji.txt)):

```
  ⏳ api     ❓ review     ✅ tests     notes     shell    +

w1:t1   label="⏳ api"        status=working
w1:t2   label="❓ review"     status=blocked
w1:t3   label="✅ tests"      status=done
w1:t4   label="notes"        status=idle
w1:t5   label="shell"        status=unknown  focused
```

<!-- TODO(user): screenshot emoji -->

### nerd

Tab bar of a herdr 0.9.3 client (focused tab: `shell`), then the condensed `tab.list` reply ([docs/captures/nerd.txt](docs/captures/nerd.txt)):

```
   api      review      tests     notes     shell    +

w1:t1   label=" api"        status=working
w1:t2   label=" review"     status=blocked
w1:t3   label=" tests"      status=done
w1:t4   label="notes"        status=idle
w1:t5   label="shell"        status=unknown  focused
```

<!-- TODO(user): screenshot nerd -->

### custom

```json
{"preset": "custom", "icons": {"working": "»", "blocked": "!", "done": "*"}}
```

Tab bar of a herdr 0.9.3 client (focused tab: `shell`), then the condensed `tab.list` reply ([docs/captures/custom.txt](docs/captures/custom.txt)):

```
  » api     ! review     * tests     notes     shell    +

w1:t1   label="» api"        status=working
w1:t2   label="! review"     status=blocked
w1:t3   label="* tests"      status=done
w1:t4   label="notes"        status=idle
w1:t5   label="shell"        status=unknown  focused
```

<!-- TODO(user): screenshot custom -->

*Cowbell: next icon preset* cycles ask → symbols → emoji → nerd → custom → ask and writes `preset` into `config.json`. `custom` is skipped unless `icons` sets at least one non-empty icon.

## Actions and key binding

Full action ids are `dvoraj75.cowbell.<id>`.

| id | Title | What it does |
| --- | --- | --- |
| `toggle` | Cowbell: on/off | Turns cowbell off if it is on, otherwise on. |
| `off` | Cowbell: off and remove icons | Stops the daemon, restores every tab name and stays off across restarts. |
| `refresh` | Cowbell: refresh now | Resyncs now. Starts a daemon if none runs. Does nothing while cowbell is off. |
| `cycle-preset` | Cowbell: next icon preset | Switches to the next preset, writes it to `config.json` and applies it at once. |

Key binding example for herdr's `config.toml`:

```toml
[[keys.command]]
key = "prefix+shift+b"
type = "plugin_action"
command = "dvoraj75.cowbell.toggle"
description = "cowbell on/off"
```

`herdr server reload-config` applies it without a restart. Avoid `prefix+b`: in herdr 0.9.3 it is the default sidebar toggle, and a plugin binding on it silently replaces that toggle (`herdr config check` does not warn).

## Configuration

The file is `config.json` in the plugin's config directory. `herdr plugin list` shows it; normally it is `~/.config/herdr/plugins/config/dvoraj75.cowbell/config.json`.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `preset` | string | `"ask"` | One of `ask`, `symbols`, `emoji`, `nerd`, `custom`. |
| `icons` | object | `{}` | Overrides single states of the preset. Keys: `working`, `blocked`, `done`, `idle`, `unknown`; values are strings. `""` removes that state's icon. |
| `separator` | string | `" "` | Placed between icon and name. |
| `include_auto_named` | boolean | `false` | Also put icons on auto-named tabs; see below. |
| `spinner.enabled` | boolean | `false` | Reserved, no effect in 0.1.0. |
| `spinner.frames` | array of strings | `["◐","◓","◑","◒"]` | Reserved, no effect in 0.1.0. Non-empty array of non-empty strings. |
| `spinner.interval_ms` | number | `1000` | Reserved, no effect in 0.1.0. Must be at least 1000. |

The `spinner` options are validated but unused; they are reserved for an optional spinner planned later. Their frames are still stripped from labels.

A missing file means defaults. An invalid file (bad JSON, unknown preset or state, wrong type) logs one line and keeps the last good config, or the defaults if there is none.

**When changes apply.** *Next icon preset* signals the daemon to reload `config.json` (SIGUSR2). *Refresh now* (SIGUSR1) does not reload it. A hand edit therefore applies on the next daemon start: while cowbell is on, run *Cowbell: on/off* twice (off restores the names, on starts a fresh daemon that reads the file) or restart the herdr server.

**`include_auto_named`.** An auto-named tab is one whose label is still herdr's automatic name, its 1-based position in the workspace. herdr has no way to turn a renamed tab back into an auto-named one, so once cowbell adds an icon the tab keeps a fixed name for good. With the option on, cowbell keeps the number in sync with the tab's position while it runs; after *off* the tab keeps its last number as a fixed name. That is why it is opt-in.

## Conflicts with other tab renamers

Other plugins also rename tabs (herdr-auto-title, herdr-automatic-rename, herdr-tab-smart-rename, herdr-bar). Cowbell treats a rename by another plugin, or by you, as the tab's new name and puts the icon in front. It strips a leading icon of any preset first, so icons do not double.

If another renamer keeps undoing the icon (3 foreign renames of a tab within 120 s, each within 30 s of cowbell's own rename), cowbell leaves that tab alone for 60 s, then tries again. Each repeat doubles the pause, up to 15 min. On such a tab the icon shows only between pauses. A renamer that answers more than about 30 s later is not detected; it costs at most one rename pair per 30 s. Renaming one tab yourself four times within about 90 s counts the same way and pauses its icon for 60 s.

Plugins that listen to `tab.renamed` (for example herdr-radar) wake on each icon change. Cowbell renames a tab only when the label it wants differs from the current one. Let only one plugin rename a given tab.

## Known limitations

- **Other tab renamers.** See the section above. Short version: a tab that another plugin keeps renaming loses its icon for 60 s at a time, up to 15 min.
- **Disabling or uninstalling.** herdr runs no plugin hook for either, so icons can stay in tab names; run *Cowbell: off and remove icons* first. See [Uninstalling](#uninstalling).
- **On/off after install.** *Cowbell: on/off* switches by the saved on/off setting, not by whether a daemon runs. Right after install cowbell is on but no daemon runs yet, so the first press switches it off. Use *Cowbell: refresh now* to start it; if you already pressed *Cowbell: on/off*, press it once more. herdr keeps the plugin's state directory across disable and uninstall, so if you switched cowbell off before that, it stays off after you enable or reinstall it: press *Cowbell: on/off* once to switch it on.
- **Auto-named tabs.** herdr stops numbering a tab once it has been renamed and cannot restore an automatic name. With `include_auto_named: true`, cowbell keeps the number in sync itself. When cowbell is switched off, such a tab keeps its current number as a fixed name and no longer follows later moves or closes. A tab you named with just its position number (for example `3`) looks the same as an auto-named tab and may be treated as one.
- **Server restart and live handoff.** The startup hook replaces the running daemon, so icons are back within about a second. Agent states that herdr itself resets on a handoff show as the reset state.
- **Rare lock races.** If *Cowbell: next icon preset* crashes while holding its lock file, two presses right after the lock goes stale (10 s) can lose one preset step. A daemon start that crashes during a lock takeover can, with three starts at the same moment, briefly let two of them clean up the same stale lock; only one daemon keeps running. Neither needs any action.
- **Refresh while off.** *Cowbell: refresh now* does nothing while cowbell is off.
- **Config edits.** A hand edit of `config.json` needs a daemon restart; see [Configuration](#configuration).
- **Spinner.** Not implemented in 0.1.0; see [Configuration](#configuration).

## Uninstalling

herdr runs no plugin hook on disable or uninstall. While the daemon runs, a heartbeat self-check every 60 s notices within about a minute that the plugin is disabled or removed, restores the tab names and exits. A daemon that is not running cannot restore anything, and the icons stay in the names. That happens, for example, when the plugin is removed while the herdr server is down, or after a server restart once the plugin is already gone.

So run *Cowbell: off and remove icons* first. Then disable or uninstall it with herdr's plugin commands.

## Development

No build step and no dependencies. Run the tests with `node --test`.

Never run `herdr` commands against your live session while developing. Use a sandbox server as described in [PLAN.md](PLAN.md) under "Testing".

- `bin/cowbell.js`: the daemon entry point.
- `bin/ctl.js`: the control CLI behind the actions and hooks (start, stop, on, off, toggle, refresh, cycle-preset, status).
- `lib/churn.js`: rename-fight bookkeeping.
- `lib/config.js`: reading, writing and cycling `config.json`.
- `lib/control.js`: the control commands.
- `lib/daemon.js`: the event loop: subscribe, resync, rename, reconnect.
- `lib/icons.js`: presets, defaults and config validation.
- `lib/label.js`: pure tab-label logic.
- `lib/lock.js`: singleton pidfile lock.
- `lib/socket.js`: the herdr socket client.
- `lib/state.js`: `state.json` and the state directory.

## License

MIT, see [LICENSE](LICENSE).
