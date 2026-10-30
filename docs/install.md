# Install & update

## Requirements

- herdr 0.9.2 or newer
- Node 18 or newer, on the `PATH` as `node`
- Linux or macOS

## Install

```sh
herdr plugin install dvoraj75/herdr-cowbell
```

Interactively, herdr shows a preview and asks for confirmation. In a non-interactive shell add `--yes` (`-y`).

Without `--ref`, herdr installs the repository's default branch, `main`, not the latest release tag. The cowbell plugin id is `dvoraj75.cowbell`. The herdr marketplace also lists cowbell.

## Pin a release with --ref

To install a tagged release, or to stay on one version while `main` moves, pass `--ref`. It takes any git ref: a tag, a branch or a commit.

```sh
herdr plugin install dvoraj75/herdr-cowbell --ref v0.1.0
```

The releases are listed at <https://github.com/dvoraj75/herdr-cowbell/releases>.

## Check what is installed

```sh
herdr plugin list
```

The entry shows `@v0.1.0` for a pinned install and `@<commit sha>` for an unpinned one. The `version` field is not enough: it is the manifest version, and `main` and the `v0.1.0` tag both report 0.1.0.

## Update

=== "herdr 0.9.4 or newer"

    ```sh
    herdr plugin update dvoraj75.cowbell
    ```

    Without a plugin id, `herdr plugin update` updates all GitHub plugins. Add `--yes` in a non-interactive shell. Update refetches the ref recorded at install and skips unchanged commits:

    - An unpinned install moves to the newest `main`.
    - A tag or commit pin stays on its ref and reports "already up to date". A branch pin moves to that branch's newest commit. Update cannot drop a pin; run `install` again for that.

=== "herdr 0.9.2 or 0.9.3"

    `herdr plugin update` does not exist. Re-run `install`; it replaces the existing install in place:

    ```sh
    herdr plugin install dvoraj75/herdr-cowbell
    ```

To switch between a pin and `main`, re-run `install` with or without `--ref`.

herdr does not restart running processes. After an update the running cowbell daemon keeps the old code until it restarts. Restart the herdr server, or run *Cowbell: on/off* twice (off, then on). See [When changes apply](configuration.md#when-changes-apply).

## After installing: start the daemon

Install does not start the daemon. It starts at the next herdr server start, or when herdr detects an agent in a pane. To start it right away, run *Cowbell: refresh now*. If cowbell was switched off before an uninstall or disable, run *Cowbell: on/off* instead. By default, auto-named tabs are left alone; see [Configuration](configuration.md).

## Where files live

On Linux with default XDG paths:

| What | Path |
| --- | --- |
| Plugin checkout | `~/.config/herdr/plugins/github/dvoraj75.cowbell-<hash>/` |
| Config | `~/.config/herdr/plugins/config/dvoraj75.cowbell/` |
| State | `~/.local/state/herdr/plugins/dvoraj75.cowbell/` |

`$XDG_CONFIG_HOME` and `$XDG_STATE_HOME` change the prefixes. Other systems may differ; `herdr plugin list` shows the paths. The config and state directories survive reinstall and uninstall.

## Uninstall

Run *Cowbell: off and remove icons* first, then:

```sh
herdr plugin uninstall dvoraj75.cowbell
```

See [Uninstalling](troubleshooting.md#uninstalling).

!!! note
    Install and `--ref` behaviour was verified on a herdr 0.9.3 sandbox on 2026-10-30. `plugin update` behaviour is from herdr's documentation.
