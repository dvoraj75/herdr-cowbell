# Security policy

## Supported versions

Only the latest 0.x release gets security fixes. Older releases get none.

## Reporting a vulnerability

Report privately through GitHub: open the repository's Security tab and choose "Report a vulnerability", or go to https://github.com/dvoraj75/herdr-cowbell/security/advisories/new. Do not open a public issue for a vulnerability.

Please include:

- the affected versions (cowbell and herdr) and your OS
- steps to reproduce, or a proof of concept
- the impact

You get a first reply within a week. There are no other promises.

## Scope

Cowbell runs as your user, talks only to the local herdr Unix socket, renames tabs and writes its own state and config files. It makes no network connections.
