Closes #

## What changed

<!-- A short description of the change and why. -->

## Checklist

- [ ] Linked issue (`Closes #...`)
- [ ] Tests: `timeout 300 node --test` passes
- [ ] Smoke test `scripts/smoke.sh /tmp/cbsmoke` run (if the daemon, control or socket code changed)
- [ ] Sandbox check: every `herdr` command ran against a sandbox server, never against the live session (see CONTRIBUTING / PLAN.md, "Testing")
- [ ] `CHANGELOG.md` updated under `## Unreleased` (one bullet ending in `(#N)`)
