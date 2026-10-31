# How it works

## Label model

A tab label is the icon, the separator and the base. When the tab's state shows no icon, the label is just the base.

The base is the tab's real name. cowbell keeps it in `state.json` in the plugin state directory, together with the last label it wrote for each tab.

cowbell strips a leading icon and separator before it composes a label. It strips the icons of every preset, your custom icons and the spinner frames. Stripping is idempotent, so icons never double.

When a tab is renamed and the rename is not cowbell's own echo, the new label (stripped) becomes the base.

Tabs that herdr named automatically are skipped, unless `include_auto_named` is true. herdr's automatic name is the tab's 1-based position. With the option on, cowbell detects such a tab by that position and keeps its base equal to the current position on every resync. If you rename the tab, it becomes a custom tab and its base is your name.

When a tab is closed, cowbell drops its entry.

## Which status a tab shows

herdr rolls the state of a tab's panes up to the tab. The priority is blocked, then done, then working, then idle, then unknown.

A done tab keeps its icon until you look at it. Focusing the tab marks it as seen, and the icon clears.

## The daemon

One detached daemon runs per herdr server. A singleton pidfile lock in the plugin state directory makes sure only one runs.

The daemon starts in three ways:

- The startup hook runs on every server start. It replaces an old daemon, so icons come back about a second after a restart.
- The `pane.agent_detected` hook is a watchdog. It starts the daemon if it died, and does nothing while it runs.
- The actions can start it.

The daemon holds two socket subscriptions: one for lifecycle events, one for per-pane agent status. Events are debounced for about 100 ms, then it resyncs. It ignores the rename events that cowbell caused itself.

If the connection drops, it reconnects with a backoff from 0.5 s up to 30 s. It exits after 120 s without a server. The next server start brings it back through the startup hook.

A 60 s heartbeat resyncs while the server is quiet. It also checks that the plugin is still enabled and installed. If not, the daemon restores the tab names and exits.

*Cowbell: off and remove icons* and SIGTERM restore every tab name before the daemon exits.

## Resync

A resync makes one `tab.list` call and computes the wanted label of every tab. It renames a tab only when the label differs from the current one. It also drops the state of tabs that are gone.

These events trigger a resync: a tab is created, closed, moved, renamed or focused; a pane changes; a workspace gets focus or is closed. When the set of panes changes, the per-pane subscriptions are rebuilt.

## When renamers fight

Other plugins also rename tabs, for example herdr-auto-title, herdr-automatic-rename, herdr-tab-smart-rename and herdr-bar. cowbell treats a rename by another plugin, or by you, as the tab's new name and puts the icon in front. It strips a leading icon of any preset first, so icons do not double.

Another plugin may rename the same tabs. If it renames a tab back after every cowbell rename, the two would loop forever. cowbell watches for this per tab.

- A foreign rename within 30 s of cowbell's own rename of that tab counts as a fight.
- Three fights within 120 s start a cool-down. cowbell leaves that tab alone for 60 s, then the icon comes back.
- Each repeat doubles the cool-down, up to 15 min.

A renamer that answers more than about 30 s later is not detected. It costs at most one rename pair per 30 s.

Renaming one tab by hand four times within about 90 s looks the same as a fight. cowbell then pauses that tab's icon for 60 s.

Let only one plugin rename a given tab. Every rename sends a `tab.renamed` event, so listeners such as herdr-radar wake on each change.
