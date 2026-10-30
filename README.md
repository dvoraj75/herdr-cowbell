# herdr-cowbell

A [herdr](https://herdr.dev) plugin that shows your agents' status on your tabs:

```
 promptator │ ◐ grundza 1 │ ? grundza 2 │ ✓ cervenak │ term
```

`◐` working · `?` waiting for you · `✓` done, not seen yet. You can choose from several icon sets.

**Status: in planning, not usable yet.** See [PLAN.md](PLAN.md).

```sh
herdr plugin install dvoraj75/herdr-cowbell   # once released
```

## Known limitations

- **Other tab renamers** (for example herdr-auto-title). Cowbell takes another plugin's rename, or your own, as the tab's new name and puts its icon in front. If another renamer keeps undoing the icon (3 times within 2 minutes, each within 30 s of cowbell's rename), cowbell leaves that tab alone for 60 s, then tries again; each repeat doubles the pause, up to 15 min. On such a tab the icon shows only between pauses. A renamer that answers more than about 30 s later is not detected; it costs at most one rename pair per 30 s. Renaming one tab yourself four times within about a minute and a half counts the same way and pauses its icon for 60 s. Let only one plugin rename a given tab.
- **Disabling or uninstalling.** herdr runs no plugin hook on disable or uninstall. A running daemon notices within about a minute, restores the tab names and exits. If herdr is not running the daemon at that moment (for example the plugin is removed while the server is down), the icons stay in the names. Run `Cowbell: off and remove icons` before you disable or uninstall.
- **Auto-named tabs** (`include_auto_named: true` in the plugin's `config.json`, off by default). herdr stops numbering a tab once it has been renamed, so cowbell keeps the number in sync itself. When cowbell is switched off, such a tab keeps its current number as a fixed name and no longer follows later moves or closes. A tab you named with just its position number (for example `3`) looks the same as an auto-named tab and may be treated as one.
- **Server restart and live handoff.** The startup hook replaces the running daemon, so icons are back within about a second. Agent states that herdr itself resets on a handoff show as the reset state.
- **Rare lock races.** If `Cowbell: next icon preset` crashes while holding its lock file, two presses right after the lock goes stale (10 s) can lose one preset step. A daemon start that crashes during a lock takeover can, with three starts at the same moment, briefly let two of them clean up the same stale lock; only one daemon keeps running. Neither needs any action.

## License

MIT
