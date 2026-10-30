# herdr-cowbell

<!-- The herdr badge is updated together with min_herdr_version in herdr-plugin.toml. -->

[![CI](https://github.com/dvoraj75/herdr-cowbell/actions/workflows/ci.yml/badge.svg)](https://github.com/dvoraj75/herdr-cowbell/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/dvoraj75/herdr-cowbell)](https://github.com/dvoraj75/herdr-cowbell/releases)
[![License](https://img.shields.io/github/license/dvoraj75/herdr-cowbell)](LICENSE)
[![herdr 0.9.2 or newer](https://img.shields.io/badge/herdr-%E2%89%A5%200.9.2-blue)](https://herdr.dev)
[![Node 18 or newer](https://img.shields.io/badge/node-%E2%89%A5%2018-brightgreen)](https://nodejs.org)
[![Docs](https://img.shields.io/badge/docs-online-informational)](https://dvoraj75.github.io/herdr-cowbell/)

![Tab bar with agent status icons in front of the tab names](docs/assets/hero.gif)

A [herdr](https://herdr.dev) plugin that shows each tab's agent status as an icon in front of the tab name. herdr's tab bar draws only the tab label and has no per-tab icon slot, so cowbell renames the tabs.

- Three states in the default preset: `◐` working, `?` blocked (waiting for you), `✓` done and not seen yet. Idle and unknown agents show nothing.
- Five presets: `ask`, `symbols`, `emoji`, `nerd` and `custom` (your own icons).
- Actions for on/off, off and remove icons, refresh and next preset, which you can bind to a key.
- An optional spinner (off by default). No dependencies: Node 18 or newer only, no npm packages, no build step.

## Install

```sh
herdr plugin install dvoraj75/herdr-cowbell
```

Requirements: herdr 0.9.2 or newer, Node 18 or newer on `PATH` as `node`, Linux or macOS.

Install does not start the daemon. It starts at the next herdr server start or when an agent is detected in a pane. The Quickstart below starts it right away. For pinning a version and updating, see [Install & update](https://dvoraj75.github.io/herdr-cowbell/install/).

## Quickstart

The first press of *Cowbell: on/off* starts cowbell. If cowbell already runs (for example after herdr detected an agent), a press switches it off; press again to turn it back on. Bind it to a key in your herdr `config.toml`:

```toml
[[keys.command]]
key = "prefix+shift+b"
type = "plugin_action"
command = "dvoraj75.cowbell.toggle"
description = "cowbell on/off"
```

Then run `herdr server reload-config`. It applies the binding without a restart. Avoid `prefix+b`: it is herdr's default sidebar toggle, and a plugin binding on it silently replaces that toggle (see [Actions & key bindings](https://dvoraj75.github.io/herdr-cowbell/actions/)).

The default preset `ask` shows `◐ ? ✓`. *Cowbell: next icon preset* cycles through the others. See [Configuration & presets](https://dvoraj75.github.io/herdr-cowbell/configuration/).

Tabs you never named (auto-named tabs) are left alone unless `include_auto_named` is true; see [Configuration & presets](https://dvoraj75.github.io/herdr-cowbell/configuration/#include_auto_named).

Before you uninstall or disable cowbell, run *Cowbell: off and remove icons*; see [Uninstalling](https://dvoraj75.github.io/herdr-cowbell/troubleshooting/#uninstalling).

## Documentation

- [Install & update](https://dvoraj75.github.io/herdr-cowbell/install/)
- [Configuration & presets](https://dvoraj75.github.io/herdr-cowbell/configuration/)
- [Actions & key bindings](https://dvoraj75.github.io/herdr-cowbell/actions/)
- [How it works](https://dvoraj75.github.io/herdr-cowbell/how-it-works/)
- [Limitations & troubleshooting](https://dvoraj75.github.io/herdr-cowbell/troubleshooting/)
- [Changelog](https://dvoraj75.github.io/herdr-cowbell/changelog/) (also [CHANGELOG.md](CHANGELOG.md))

## Contributing, security, support

- Contributing: see [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Security: report vulnerabilities as described in [SECURITY.md](SECURITY.md).
- Support: see [SUPPORT.md](SUPPORT.md).

## License

MIT, see [LICENSE](LICENSE).
