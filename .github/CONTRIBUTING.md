# Contributing

Development setup and tests are in the README's [Development](../README.md#development) section. Never run `herdr` against your live server while developing; use the sandbox described in [PLAN.md → Testing](../PLAN.md#testing-always-on-a-sandbox-server).

## Releasing

1. Bump `version` in `herdr-plugin.toml` and `package.json`.
2. Rename `## Unreleased` in `CHANGELOG.md` to `## X.Y.Z — YYYY-MM-DD` (with an em dash, as check-version.js expects).
3. Run `node scripts/check-version.js vX.Y.Z`.
4. Open a PR, let CI pass, merge.
5. `git switch main && git pull`, then `git tag vX.Y.Z && git push origin vX.Y.Z`.
6. The Release workflow checks the versions against the tag, runs the tests and publishes the GitHub release with that CHANGELOG section as the notes plus the install line.

To preview, run `gh workflow run release.yml -f tag=vX.Y.Z -f dry_run=true`. A dry run checks the versions on main against the tag, runs the tests and prints the notes without creating anything, and the tag does not need to exist yet.
