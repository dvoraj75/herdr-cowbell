# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/).

## 0.1.0 — 2026-10-30

First release.

### Added

- Sandbox spike (#3): the herdr facts the design depends on were verified against a sandbox server. Decided there that auto-named tabs are left alone unless `include_auto_named` is set. Minimum herdr version is 0.9.2.
- Plugin manifest and pure label and icon logic (#4):
  - Icon presets `ask`, `symbols`, `emoji`, `nerd` and `custom`.
  - A leading icon of any preset is stripped before a new one is added.
  - Per-state `icons` overrides, `separator` and `include_auto_named` in `config.json`.
  - An invalid `config.json` keeps the last good config (defaults if there is none).
- Socket client and daemon (#5):
  - Two event subscriptions and a full resync.
  - 100 ms debounce, and suppression of cowbell's own rename events.
  - Done clears when the tab has been seen.
  - Reconnect backoff from 0.5 s to 30 s; the daemon exits after 120 s without a server.
  - Atomic `state.json`.
  - Auto-named tabs detected by 1-based position; `include_auto_named` defaults to false.
- Control actions (#6):
  - Actions `toggle`, `off`, `refresh` and `cycle-preset`; `bin/ctl.js` also has `start`, `stop`, `on` and `status`.
  - Singleton pidfile lock.
  - `off` and SIGTERM restore the tab names; a startup hook starts the daemon and strips stale icons.
  - `cycle-preset` writes `preset` into `config.json`.
- Edge-case hardening (#7):
  - The startup hook replaces an old daemon.
  - Rename-fight cool-down: a tab that another plugin keeps renaming is left alone for 60 s, doubling per repeat up to 15 min.
  - A 60 s heartbeat self-check restores the tab names and exits when the plugin is disabled or removed.

### Known limitations

See the Known limitations section in the README. The `spinner` options are validated but have no effect in this release.
