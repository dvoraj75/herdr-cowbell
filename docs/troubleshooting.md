# Limitations & troubleshooting

## Known limitations

- **Other tab renamers.** A tab that another plugin keeps renaming loses its icon for 60 s at a time, up to 15 min. See [When renamers fight](how-it-works.md#when-renamers-fight).
- **Disable and uninstall can leave icons.** herdr runs no plugin hook for either. Run *Cowbell: off and remove icons* first. See [Uninstalling](#uninstalling).
- **Off survives reinstall.** herdr keeps the state directory. If you switched cowbell off before, it stays off after you enable or reinstall it. Press *Cowbell: on/off* once.
- **Auto-named tabs.** herdr cannot turn a renamed tab back into an auto-named one. With `include_auto_named` on, cowbell keeps the number in sync itself. After you switch cowbell off, such a tab keeps its current number as a fixed name and no longer follows later moves or closes. A tab you named with only its position number may be treated as auto-named.
- **Server restart and live handoff.** The startup hook replaces the daemon, so icons return within about a second. Agent states that herdr resets on a handoff show as the reset state.
- **Rare lock races.** After a crash while a lock is held, two presses of *Cowbell: next icon preset* right after the lock goes stale (10 s) can lose one preset step. A daemon start that crashes during a lock takeover can, with three starts at the same moment, briefly let two of them clean up the same stale lock. Neither this nor a doubled daemon start needs action; only one daemon keeps running.
- **Refresh while off.** *Cowbell: refresh now* does nothing while cowbell is off.
- **Config edits.** A hand edit of `config.json` needs a daemon restart. See [When changes apply](configuration.md#when-changes-apply).

## Troubleshooting

### No icons appear

- herdr runs no hook on install, link or enable, so the daemon may not have started yet. Press *Cowbell: refresh now*. If you switched cowbell off earlier, press *Cowbell: on/off* instead.
- Check that Node 18 or newer is on the `PATH` as `node`. The hooks and actions run `node`.
- Tabs you never named (auto-named tabs) are skipped unless `include_auto_named` is true.
- Check that cowbell is not off: run `ctl.js status` (below).

### Icons stay after uninstall

The daemon was not running, or you did not switch cowbell off first. Rename the tabs by hand, or reinstall cowbell and run *Cowbell: off and remove icons*.

### Icons flicker or disappear for a minute

Probably a cool-down: another plugin renames the same tab. See [When renamers fight](how-it-works.md#when-renamers-fight). Four hand renames of one tab within about 90 s cause the same pause.

### Config edit has no effect

A hand edit of `config.json` needs a daemon restart. See [When changes apply](configuration.md#when-changes-apply).

## Logs

`herdr plugin log list --plugin dvoraj75.cowbell` lists the logs herdr keeps for the plugin's hooks and actions.

When a control command starts the daemon, it writes the daemon's stdout and stderr to `daemon.log` in the plugin state directory. A log above 1 MiB is moved to `daemon.log.1` at the next start. If the daemon does not start within the wait time, the command prints the path of this file.

## Checking status with ctl.js

`bin/ctl.js` is in the plugin root, the directory where herdr installed the plugin. herdr sets the plugin environment only for its own hooks and actions, so when you run the command by hand, set the two directories yourself:

```sh
cd "<managed_path>"   # source.managed_path from: herdr plugin list --plugin dvoraj75.cowbell --json
HERDR_PLUGIN_STATE_DIR=~/.local/state/herdr/plugins/dvoraj75.cowbell \
HERDR_PLUGIN_CONFIG_DIR=~/.config/herdr/plugins/config/dvoraj75.cowbell \
node bin/ctl.js status
```

These paths are the Linux defaults. `herdr plugin list` shows the real ones on your system. `HERDR_PLUGIN_STATE_DIR` is required: without it the command prints an error and exits with 1. `HERDR_PLUGIN_CONFIG_DIR` is optional; without it the preset shown is the default and the config dir reads `(unset)`. `status` does not contact the herdr server, so `HERDR_SOCKET_PATH` is not needed.

Example output (the values are made up):

```text
daemon: running (pid 12345)
enabled: yes
preset: ask
state dir: /home/me/.local/state/herdr/plugins/dvoraj75.cowbell
config dir: /home/me/.config/herdr/plugins/config/dvoraj75.cowbell
```

`daemon` is `stopped` when no daemon runs. If `config.json` has a problem, the `preset` line shows the first problem message instead.

## Uninstalling

Run *Cowbell: off and remove icons* first. Then disable or uninstall the plugin with herdr's plugin commands.

herdr runs no hook on disable or uninstall. While the daemon runs, its 60 s heartbeat notices that the plugin is gone, restores the names and exits. A daemon that is not running cannot do that, and the icons stay. Examples: the plugin is removed while the herdr server is down, or after a server restart once the plugin is already gone.

herdr keeps the config and state directories across uninstall. If cowbell was off, it stays off after a reinstall.

## Reporting bugs

Open an issue at <https://github.com/dvoraj75/herdr-cowbell/issues>.
