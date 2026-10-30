# Contributing

Thanks for helping. Questions go to [SUPPORT](../SUPPORT.md); everyone taking part follows the [Code of Conduct](../CODE_OF_CONDUCT.md).

## Development setup

Clone the repository. You need Node 18 or newer. There is no install step: no npm dependencies and no build step.

- Run the tests with `node --test`. Run the full suite as `timeout 300 node --test`.
- `node --test` runs every `.js` file under `test/`, so keep nothing there except `*.test.js`. Helpers go in `fixtures/` (a helper under `test/` once hung the suite for hours).
- CI runs the tests on Node 18, 20 and 22 on Linux and macOS for every push to `main` and every pull request.
- `node scripts/check-version.js [tag]` checks that `herdr-plugin.toml`, `package.json` and the top CHANGELOG heading carry the same version.

## The sandbox rule

**Never run `herdr` against your live session.** Your dev shell usually sits in a herdr pane where `HERDR_SOCKET_PATH` points at your real server, so any `herdr …` command acts on it. Use the sandbox procedure in [PLAN.md → Testing](../PLAN.md#testing-always-on-a-sandbox-server). Before linking the plugin, confirm `herdr plugin list` in the sandbox shows no plugins. Link or install into your real herdr only on purpose.

## Smoke test

`scripts/smoke.sh /tmp/cbsmoke` (or `HERDR_BIN=/path/to/herdr scripts/smoke.sh /tmp/cbsmoke`) starts its own headless herdr server in that directory, links a copy of the plugin and checks the tab labels: working `◐`, blocked `?`, done `✓`, the focused tab plain; focusing a tab clears its `✓`; the `off` action restores every name. It unsets every `HERDR_*` variable first, so it never touches your session.

- Prerequisites: herdr, node 18 or newer, perl; Linux or macOS.
- Exit codes: 0 pass, 1 failure (logs are dumped), 2 usage error or missing prerequisite.
- A run takes under 120 s.
- CI runs it against the minimum herdr (`min_herdr_version` in `herdr-plugin.toml`) and the latest herdr on Linux and macOS. A weekly canary runs it against the latest herdr.

## Project layout

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

Herdr socket calls stay in `lib/socket.js`. Label and icon logic stays pure and covered by unit tests.

## Branches and commits

- Branch names are `{type}/{issue}-{slug}`, for example `fix/23-toggle-starts-daemon` or `docs/24-readme-community`.
- Commits are conventional: `type(scope): subject (#issue)`, with a type of `feat`, `fix`, `docs`, `ci`, `test`, `refactor` or `chore`.

## Changelog

Every user-visible change adds one bullet under `## Unreleased` in `CHANGELOG.md`, in `### Added`, `### Changed` or `### Fixed`, ending in `(#N)`.

## Pull requests

Open the PR against `main`. The [PR template](PULL_REQUEST_TEMPLATE.md) checklist covers the linked issue, tests, the sandbox check and the CHANGELOG. CI must be green: tests, versions, docs and smoke.

## Releasing

1. Bump `version` in `herdr-plugin.toml` and `package.json`.
2. Rename `## Unreleased` in `CHANGELOG.md` to `## X.Y.Z — YYYY-MM-DD` (with an em dash, as check-version.js expects).
3. Run `node scripts/check-version.js vX.Y.Z`.
4. Open a PR, let CI pass, merge.
5. `git switch main && git pull`, then `git tag vX.Y.Z && git push origin vX.Y.Z`.
6. The Release workflow checks the versions against the tag, runs the tests and publishes the GitHub release with that CHANGELOG section as the notes plus the install line.

To preview, run `gh workflow run release.yml -f tag=vX.Y.Z -f dry_run=true`. A dry run checks the versions on main against the tag, runs the tests and prints the notes without creating anything, and the tag does not need to exist yet.
