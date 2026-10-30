# Actions & key bindings

Cowbell registers four plugin actions. The full id of each is `dvoraj75.cowbell.<id>`.

| id | Title | What it does |
| --- | --- | --- |
| `toggle` | Cowbell: on/off | Turns cowbell off (like `off`) if its daemon runs. Otherwise switches it on and starts a daemon. |
| `off` | Cowbell: off and remove icons | Stops the daemon, restores every tab name and stays off across restarts. |
| `refresh` | Cowbell: refresh now | Resyncs now. Starts a daemon if none runs. Does nothing while cowbell is off. |
| `cycle-preset` | Cowbell: next icon preset | Switches to the next preset, writes it to `config.json` and applies it at once. |

Run them from herdr's plugin actions, using the titles above.

## Key binding

Add a binding to herdr's `config.toml`:

```toml
[[keys.command]]
key = "prefix+shift+b"
type = "plugin_action"
command = "dvoraj75.cowbell.toggle"
description = "cowbell on/off"
```

`herdr server reload-config` applies it without a restart.

To bind another action, use its full id in `command`. Pick a key of your own; `prefix+shift+b` is the only one this page recommends.

!!! warning "Why not prefix+b"
    In herdr 0.9.3 `prefix+b` is the default sidebar toggle. A plugin binding on it silently replaces that toggle. `herdr config check` does not warn about it.

## Control CLI

The actions call `bin/ctl.js`. Its commands are `start`, `stop`, `on`, `off`, `toggle`, `refresh`, `cycle-preset` and `status`. `status` is useful for diagnosis; see [Limitations & troubleshooting](troubleshooting.md).
