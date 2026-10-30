import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDaemon, restoreTabs, LIFECYCLE_EVENTS, isTransportError } from "../lib/daemon.js";
import { HerdrError } from "../lib/socket.js";
import { defaultConfig } from "../lib/icons.js";

// ---- test doubles: no real herdr, no sockets, no real timers ----

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() {
  for (let i = 0; i < 20; i += 1) await tick();
}

const unhandled = [];
process.on("unhandledRejection", (err) => unhandled.push(err));

/** Hand-written clock: timers fire only through `advance`. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      seq += 1;
      pending.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    now: () => now,
    pending,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of pending) {
          if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        }
        if (!next) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

const transportError = (code = "ECONNREFUSED") => Object.assign(new Error("x"), { code });

function tabOf(id, label, status = "idle", workspace = "w1") {
  return { tab_id: id, workspace_id: workspace, number: 99, label, focused: false, pane_count: 1, agent_status: status };
}

/** A fake of `createClient()`: a scripted herdr server plus recording. */
function fakeClient({ tabs, panes }) {
  const c = {
    up: true,
    manualStart: false,
    tabs,
    panes,
    calls: [],
    renames: [],
    subs: [],
    trace: [],
    paneNotFound: 0,
    renameError: null,
    renameErrors: {},
    renameGate: null,
    plugins: [],
    pluginError: null,
    onRename: null,
    gate: null,
    listInFlight: 0,
    maxListInFlight: 0,
    closed: false,
    count: (method) => c.calls.filter(([m]) => m === method).length,
    async request(method, params) {
      c.calls.push([method, params]);
      if (!c.up) throw transportError();
      if (method === "tab.list") {
        c.listInFlight += 1;
        c.maxListInFlight = Math.max(c.maxListInFlight, c.listInFlight);
        try {
          if (c.gate) await c.gate;
          return { type: "tab_list", tabs: c.tabs.map((t) => ({ ...t })) };
        } finally {
          c.listInFlight -= 1;
        }
      }
      if (method === "pane.list") return { type: "pane_list", panes: c.panes.map((p) => ({ ...p })) };
      if (method === "plugin.list") {
        if (c.pluginError) throw c.pluginError;
        return { type: "plugin_list", plugins: c.plugins.map((p) => ({ ...p })) };
      }
      if (method === "tab.rename") {
        if (c.renameGate) await c.renameGate;
        if (c.renameError) throw c.renameError;
        if (c.renameErrors[params.tab_id]) throw c.renameErrors[params.tab_id];
        const tab = c.tabs.find((t) => t.tab_id === params.tab_id);
        if (!tab) throw new HerdrError("tab_not_found", "no such tab", method);
        c.renames.push(params);
        if (c.onRename) c.onRename(params);
        tab.label = params.label;
        // herdr's event reaches conn 1 before the reply reaches us.
        c.emit("tab.renamed", { tab_id: tab.tab_id, workspace_id: tab.workspace_id, label: params.label });
        return { type: "ok" };
      }
      throw new Error(`unexpected request ${method}`);
    },
    subscribe(list, cb) {
      const n = c.subs.length + 1;
      const sub = {
        n,
        list,
        cb,
        closed: false,
        started: false,
        close() {
          if (sub.closed) return;
          sub.closed = true;
          c.trace.push(`close:${n}`);
          if (cb.onClose) cb.onClose();
        },
        start() {
          if (sub.closed) return;
          if (!c.up) {
            cb.onError(transportError());
            sub.close();
            return;
          }
          if (list[0].pane_id && c.paneNotFound > 0) {
            c.paneNotFound -= 1;
            cb.onError(new HerdrError("pane_not_found", "pane gone", "events.subscribe"));
            sub.close();
            return;
          }
          sub.started = true;
          c.trace.push(`start:${n}`);
          cb.onStarted();
        },
      };
      c.subs.push(sub);
      if (!c.manualStart) queueMicrotask(() => sub.start());
      return sub;
    },
    close() {
      c.closed = true;
      for (const sub of c.subs) sub.close();
    },
    open: () => c.subs.filter((s) => !s.closed),
    lifecycle: () => c.open().find((s) => !s.list[0].pane_id),
    statusSub: () => c.open().find((s) => s.list[0].pane_id),
    emit(type, data = {}) {
      const sub = c.lifecycle();
      if (sub) sub.cb.onEvent({ type, data });
    },
    emitStatus(paneId, status = "working") {
      const sub = c.open().find((s) => s.list.some((x) => x.pane_id === paneId));
      if (sub) sub.cb.onEvent({ type: "pane.agent_status_changed", data: { pane_id: paneId, agent_status: status } });
    },
  };
  return c;
}

/**
 * Run `body` against a daemon on fakes, with a fresh state dir that is
 * removed afterwards, and fail when anything rejected without a handler.
 */
async function withDaemon(options, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-daemon-"));
  const timers = fakeTimers();
  const client = fakeClient({
    tabs: options.tabs || [],
    panes: options.panes === undefined ? [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" }] : options.panes,
  });
  const logs = [];
  const exits = [];
  const daemon = createDaemon({
    client,
    stateDir: dir,
    config: options.config || defaultConfig(),
    log: (m) => logs.push(m),
    timers,
    backoff: options.backoff,
    onExit: (code) => exits.push(code),
    pluginId: options.pluginId || null,
    selfCheckMs: options.selfCheckMs,
  });
  const stateFile = path.join(dir, "state.json");
  const h = {
    dir,
    timers,
    client,
    daemon,
    logs,
    exits,
    stateFile,
    readState: () => JSON.parse(fs.readFileSync(stateFile, "utf8")),
    async boot() {
      await daemon.start();
      await settle();
    },
  };
  unhandled.length = 0;
  try {
    if (options.before) options.before(h);
    await body(h);
    await settle();
    assert.deepEqual(unhandled, [], "no unhandled rejections");
  } finally {
    await daemon.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const labels = (h) => h.client.tabs.map((t) => t.label);
const withAuto = () => ({ ...defaultConfig(), include_auto_named: true });
const retryDelays = (logs) =>
  logs
    .map((l) => /retry in (\d+) ms/.exec(l))
    .filter(Boolean)
    .map((m) => Number(m[1]));

// ---- start ----

test("start opens the lifecycle subscription and one status filter per pane, then resyncs", async () => {
  const panes = [
    { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1" },
    { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" },
  ];
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "working")], panes }, async (h) => {
    await h.boot();
    const [conn1, conn2] = h.client.subs;
    assert.equal(h.client.subs.length, 2);
    assert.deepEqual(
      conn1.list,
      LIFECYCLE_EVENTS.map((type) => ({ type })),
    );
    assert.deepEqual(conn2.list, [
      { type: "pane.agent_status_changed", pane_id: "w1:p1" },
      { type: "pane.agent_status_changed", pane_id: "w1:p2" },
    ]);
    assert.deepEqual(h.client.trace.slice(0, 2), ["start:1", "start:2"]);
    assert.deepEqual(
      h.client.calls.map(([m]) => m),
      ["pane.list", "tab.list", "tab.rename"],
    );
    assert.deepEqual(labels(h), ["◐ api"]);
    assert.deepEqual(h.logs, ["started", "connected, 1 tabs"]);
  });
});

test("start waits for both subscriptions before the first tab.list", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "working")] }, async (h) => {
    h.client.manualStart = true;
    const started = h.daemon.start();
    await settle();
    assert.equal(h.client.subs.length, 1, "conn 2 waits for conn 1");
    h.client.subs[0].start();
    await settle();
    assert.equal(h.client.subs.length, 2);
    assert.equal(h.client.count("tab.list"), 0, "conn 2 not started yet");
    h.client.subs[1].start();
    await started;
    assert.equal(h.client.count("tab.list"), 1);
  });
});

test("start opens no status subscription when there are no panes", async () => {
  await withDaemon({ tabs: [], panes: [] }, async (h) => {
    await h.boot();
    assert.equal(h.client.subs.length, 1);
    assert.deepEqual(h.logs, ["started", "connected, 0 tabs"]);
  });
});

test("a second resync with nothing changed sends no tab.rename", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "working")] }, async (h) => {
    await h.boot();
    assert.equal(h.client.renames.length, 1);
    h.client.emit("tab.focused", { tab_id: "w1:t1" });
    await h.timers.advance(100);
    assert.equal(h.client.count("tab.list"), 2);
    assert.equal(h.client.renames.length, 1);
  });
});

// ---- auto-named tabs ----

test("an auto-named tab is left alone with the default config", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "a"), tabOf("w1:t2", "2", "working")] }, async (h) => {
    await h.boot();
    assert.deepEqual(labels(h), ["a", "2"]);
    assert.equal(h.client.renames.length, 0);
  });
});

test("with include_auto_named an auto-named working tab gets an icon on its position", async () => {
  await withDaemon({ config: withAuto(), tabs: [tabOf("w1:t1", "a"), tabOf("w1:t2", "2", "working")] }, async (h) => {
    await h.boot();
    assert.deepEqual(labels(h), ["a", "◐ 2"]);
  });
});

test("an auto-named tab follows a move to another position", async () => {
  await withDaemon({ config: withAuto(), tabs: [tabOf("w1:t1", "a"), tabOf("w1:t2", "2", "working")] }, async (h) => {
    await h.boot();
    // herdr keeps "◐ 2" because it treats a renamed tab as custom.
    h.client.tabs.reverse();
    h.client.emit("tab.moved", { tab_id: "w1:t2" });
    await h.timers.advance(100);
    assert.deepEqual(labels(h), ["◐ 1", "a"]);
  });
});

test("an auto-named tab follows the close of an earlier tab", async () => {
  await withDaemon({ config: withAuto(), tabs: [tabOf("w1:t1", "a"), tabOf("w1:t2", "2", "working")] }, async (h) => {
    await h.boot();
    h.client.tabs.shift();
    h.client.emit("tab.closed", { tab_id: "w1:t1" });
    await h.timers.advance(100);
    assert.deepEqual(labels(h), ["◐ 1"]);
  });
});

test("an auto-named tab follows the creation of a tab before it", async () => {
  await withDaemon({ config: withAuto(), tabs: [tabOf("w1:t2", "1", "working")] }, async (h) => {
    await h.boot();
    assert.deepEqual(labels(h), ["◐ 1"]);
    h.client.tabs.unshift(tabOf("w1:t9", "1"));
    h.client.emit("tab.created", { tab_id: "w1:t9" });
    await h.timers.advance(100);
    assert.deepEqual(labels(h), ["1", "◐ 2"]);
  });
});

test("positions count per workspace, not over all tabs", async () => {
  const tabs = [tabOf("w1:t1", "1", "working", "w1"), tabOf("w2:t5", "1", "working", "w2")];
  await withDaemon({ config: withAuto(), tabs }, async (h) => {
    await h.boot();
    assert.deepEqual(labels(h), ["◐ 1", "◐ 1"]);
  });
});

// ---- echo and foreign renames ----

test("our own tab.renamed echo does not arm the debounce or cause a resync", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "working")] }, async (h) => {
    await h.boot();
    assert.equal(h.timers.pending.size, 0);
    await h.timers.advance(1000);
    assert.equal(h.client.count("tab.list"), 1);
  });
});

test("a foreign rename becomes the new base and the icon is re-applied", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "old", "working")] }, async (h) => {
    await h.boot();
    assert.deepEqual(labels(h), ["◐ old"]);
    h.client.tabs[0].label = "api";
    h.client.emit("tab.renamed", { tab_id: "w1:t1", label: "api" });
    assert.equal(h.timers.pending.size, 1);
    await h.timers.advance(100);
    assert.deepEqual(labels(h), ["◐ api"]);
    assert.equal(h.readState().tabs["w1:t1"].base, "api");
  });
});

test("a foreign rename is applied before the resync even after other events in the batch", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "old", "working")] }, async (h) => {
    await h.boot();
    // The tab still shows our label, so only the event can tell the new base.
    h.client.emitStatus("w1:p1", "working");
    h.client.emit("tab.renamed", { tab_id: "w1:t1", label: "api" });
    await h.timers.advance(100);
    assert.deepEqual(labels(h), ["◐ api"]);
  });
});

test("a foreign rename followed by the echo of our in-flight rename keeps the foreign base", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "old", "working")] }, async (h) => {
    await h.boot();
    h.client.tabs[0].agent_status = "done";
    // The user renames while our rename is in flight; ours lands last.
    h.client.onRename = () => {
      h.client.onRename = null;
      h.client.emit("tab.renamed", { tab_id: "w1:t1", label: "api" });
    };
    h.client.emitStatus("w1:p1", "done");
    await h.timers.advance(100);
    assert.deepEqual(labels(h), ["✓ old"]);
    await h.timers.advance(100);
    assert.deepEqual(labels(h), ["✓ api"]);
  });
});

test("a user rename to the position number keeps its custom name after a move", async () => {
  const tabs = [tabOf("w1:t1", "a"), tabOf("w1:t3", "c"), tabOf("w1:t2", "x", "working")];
  await withDaemon({ tabs }, async (h) => {
    await h.boot();
    assert.deepEqual(labels(h), ["a", "c", "◐ x"]);
    // The user names the third tab "3", its own position.
    h.client.tabs[2].label = "3";
    h.client.emit("tab.renamed", { tab_id: "w1:t2", label: "3" });
    await h.timers.advance(100);
    assert.deepEqual(labels(h), ["a", "c", "◐ 3"]);
    h.client.tabs.unshift(h.client.tabs.pop());
    h.client.emit("tab.moved", { tab_id: "w1:t2" });
    await h.timers.advance(100);
    assert.deepEqual(labels(h), ["◐ 3", "a", "c"]);
    assert.deepEqual(h.readState().tabs["w1:t2"], { base: "3", lastWritten: "◐ 3", autoNamed: false });
  });
});

test("an echo lost with the old connection does not swallow a later foreign rename", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
    await h.boot();
    // We write "◐ api"; events_lost arrives before its echo, so the echo never comes.
    h.client.onRename = () => {
      h.client.onRename = null;
      h.client.lifecycle().cb.onError(new HerdrError("events_lost", "lagged", "events.subscribe"));
    };
    h.client.tabs[0].agent_status = "working";
    h.client.emitStatus("w1:p1", "working");
    await h.timers.advance(100);
    assert.match(h.logs.at(-1), /^disconnected \(events_lost\)/);
    // While we were away the user renamed it back and the agent went idle.
    h.client.tabs[0].label = "api";
    h.client.tabs[0].agent_status = "idle";
    await h.timers.advance(500);
    assert.equal(h.logs.at(-1), "connected, 1 tabs");
    assert.equal(h.client.renames.length, 1, "no write to the tab since the reconnect");
    h.client.tabs[0].label = "◐ api";
    h.client.emit("tab.renamed", { tab_id: "w1:t1", label: "◐ api" });
    assert.equal(h.timers.pending.size, 1, "treated as foreign, resync armed");
  });
});

// ---- debounce ----

test("events in the window produce one resync after 100 ms from the first event", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
    await h.boot();
    h.client.emit("tab.focused");
    await h.timers.advance(60);
    h.client.emit("tab.focused");
    assert.equal(h.timers.pending.size, 1, "second event arms no new timer");
    await h.timers.advance(39);
    assert.equal(h.client.count("tab.list"), 1, "not yet");
    await h.timers.advance(1);
    assert.equal(h.client.count("tab.list"), 2);
    await h.timers.advance(1000);
    assert.equal(h.client.count("tab.list"), 2);
  });
});

test("a storm of events does not postpone the resync", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
    await h.boot();
    for (let i = 0; i < 9; i += 1) {
      h.client.emit("tab.focused");
      await h.timers.advance(10);
    }
    h.client.emit("tab.focused");
    await h.timers.advance(10);
    assert.equal(h.client.count("tab.list"), 2);
  });
});

// ---- serialised flushes ----

test("an event during a resync causes exactly one more resync after it", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
    await h.boot();
    let release;
    h.client.gate = new Promise((resolve) => {
      release = resolve;
    });
    h.client.emit("tab.focused");
    await h.timers.advance(100);
    assert.equal(h.client.count("tab.list"), 2, "second resync is in flight");
    h.client.emit("tab.focused");
    h.client.emit("tab.focused");
    await h.timers.advance(100);
    assert.equal(h.client.count("tab.list"), 2, "no overlapping resync");
    h.client.gate = null;
    release();
    await settle();
    assert.equal(h.client.count("tab.list"), 3);
    assert.equal(h.client.maxListInFlight, 1);
    await h.timers.advance(1000);
    assert.equal(h.client.count("tab.list"), 3);
  });
});

// ---- seen ----

test("a done tab shows a check mark and loses it once focused and idle", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "done")] }, async (h) => {
    await h.boot();
    assert.deepEqual(labels(h), ["✓ api"]);
    h.client.tabs[0].agent_status = "idle";
    h.client.emit("tab.focused", { tab_id: "w1:t1" });
    await h.timers.advance(100);
    assert.deepEqual(labels(h), ["api"]);
  });
});

test("a status event to idle on the status connection clears the check mark", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "done")] }, async (h) => {
    await h.boot();
    h.client.tabs[0].agent_status = "idle";
    h.client.emitStatus("w1:p1", "idle");
    await h.timers.advance(100);
    assert.deepEqual(labels(h), ["api"]);
  });
});

// ---- pane set ----

for (const type of ["pane.created", "pane.closed", "pane.moved", "tab.created", "tab.closed", "workspace.closed"]) {
  test(`${type} lists panes again`, async () => {
    await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
      await h.boot();
      assert.equal(h.client.count("pane.list"), 1);
      h.client.emit(type, {});
      await h.timers.advance(100);
      assert.equal(h.client.count("pane.list"), 2);
    });
  });
}

test("a focus event does not list panes again", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
    await h.boot();
    h.client.emit("tab.focused", {});
    await h.timers.advance(100);
    assert.equal(h.client.count("pane.list"), 1);
  });
});

test("a changed pane set opens a new status connection and closes the old one after it started", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "working")] }, async (h) => {
    await h.boot();
    h.client.panes = [{ pane_id: "w1:p1" }, { pane_id: "w1:p3" }];
    h.client.emit("pane.created", { pane_id: "w1:p3" });
    await h.timers.advance(100);
    assert.equal(h.client.subs.length, 3);
    assert.deepEqual(
      h.client.subs[2].list.map((s) => s.pane_id),
      ["w1:p1", "w1:p3"],
    );
    assert.deepEqual(h.client.trace.slice(2), ["start:3", "close:2"]);
    assert.deepEqual(
      h.client.open().map((s) => s.n),
      [1, 3],
    );
    // The new connection delivers status events.
    h.client.tabs[0].agent_status = "blocked";
    h.client.emitStatus("w1:p3", "blocked");
    await h.timers.advance(100);
    assert.deepEqual(labels(h), ["? api"]);
  });
});

test("an unchanged pane set keeps the status connection", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
    await h.boot();
    h.client.emit("pane.created", {});
    await h.timers.advance(100);
    assert.equal(h.client.subs.length, 2);
    assert.deepEqual(
      h.client.open().map((s) => s.n),
      [1, 2],
    );
  });
});

test("pane_not_found on the new status connection retries with a fresh pane list", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
    await h.boot();
    h.client.panes = [{ pane_id: "w1:p1" }, { pane_id: "w1:p3" }];
    h.client.paneNotFound = 3;
    h.client.emit("pane.created", {});
    await h.timers.advance(100);
    assert.equal(h.client.count("pane.list"), 5, "initial + 4 attempts");
    assert.deepEqual(
      h.client.open().map((s) => s.n),
      [1, 6],
    );
    assert.equal(h.logs.filter((l) => l.startsWith("disconnected")).length, 0);
  });
});

test("pane_not_found four times in a row disconnects into backoff", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
    await h.boot();
    h.client.panes = [{ pane_id: "w1:p1" }, { pane_id: "w1:p3" }];
    h.client.paneNotFound = 4;
    h.client.emit("pane.created", {});
    await h.timers.advance(100);
    assert.equal(h.client.count("pane.list"), 5);
    assert.match(h.logs.at(-1), /^disconnected \(pane_not_found\), retry in 500 ms$/);
    assert.equal(h.client.open().length, 0);
  });
});

// ---- state file ----

test("a closed tab is pruned from the state and from state.json", async () => {
  const tabs = [tabOf("w1:t1", "api", "working"), tabOf("w1:t2", "web", "working")];
  await withDaemon({ tabs }, async (h) => {
    await h.boot();
    assert.deepEqual(Object.keys(h.readState().tabs).sort(), ["w1:t1", "w1:t2"]);
    h.client.tabs.pop();
    h.client.emit("tab.closed", { tab_id: "w1:t2" });
    await h.timers.advance(100);
    assert.deepEqual(Object.keys(h.readState().tabs), ["w1:t1"]);
  });
});

test("state.json is written only when the state changed", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "working")] }, async (h) => {
    await h.boot();
    fs.rmSync(h.stateFile);
    h.client.emit("tab.focused", {});
    await h.timers.advance(100);
    assert.equal(h.client.count("tab.list"), 2);
    assert.equal(fs.existsSync(h.stateFile), false, "nothing changed, nothing written");
    h.client.tabs[0].agent_status = "done";
    h.client.emitStatus("w1:p1", "done");
    await h.timers.advance(100);
    assert.equal(h.readState().tabs["w1:t1"].lastWritten, "✓ api");
  });
});

test("a state.json from a previous run is used by the first resync", async () => {
  const stored = { version: 1, tabs: { "w1:t1": { base: "api", lastWritten: "◐ api", autoNamed: false } } };
  await withDaemon(
    {
      tabs: [tabOf("w1:t1", "◐ api", "idle")],
      before: (h) => fs.writeFileSync(h.stateFile, JSON.stringify(stored)),
    },
    async (h) => {
      await h.boot();
      assert.deepEqual(labels(h), ["api"]);
    },
  );
});

// ---- rename errors ----

test("tab_not_found on rename is skipped silently", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "working")] }, async (h) => {
    h.client.renameError = new HerdrError("tab_not_found", "gone", "tab.rename");
    await h.boot();
    assert.deepEqual(h.logs, ["started", "connected, 1 tabs"]);
    assert.equal(h.client.open().length, 2);
    assert.deepEqual(labels(h), ["api"]);
  });
});

test("another HerdrError on rename is logged, keeps the previous entry and does not disconnect", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
    await h.boot();
    assert.equal(h.readState().tabs["w1:t1"].lastWritten, "api");
    h.client.renameError = new HerdrError("weird", "odd", "tab.rename");
    h.client.tabs[0].agent_status = "working";
    h.client.emitStatus("w1:p1", "working");
    await h.timers.advance(100);
    assert.ok(h.logs.includes("rename w1:t1 failed (weird)"));
    assert.equal(h.client.open().length, 2);
    assert.equal(h.readState().tabs["w1:t1"].lastWritten, "api");
    h.client.renameError = null;
    h.client.emitStatus("w1:p1", "working");
    await h.timers.advance(100);
    assert.deepEqual(labels(h), ["◐ api"]);
  });
});

test("a failed rename leaves no echo behind that would swallow a later user rename", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
    await h.boot();
    h.client.renameError = new HerdrError("weird", "odd", "tab.rename");
    h.client.tabs[0].agent_status = "working";
    h.client.emitStatus("w1:p1", "working");
    await h.timers.advance(100);
    h.client.renameError = null;
    // The user types the very label we failed to write.
    h.client.tabs[0].label = "◐ api";
    h.client.emit("tab.renamed", { tab_id: "w1:t1", label: "◐ api" });
    assert.equal(h.timers.pending.size, 1, "treated as foreign, resync armed");
  });
});

// ---- disconnect and backoff ----

test("the lifecycle connection closing closes both and retries with growing delays", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")], backoff: { giveUpMs: 1e9 } }, async (h) => {
    await h.boot();
    h.client.up = false;
    h.client.lifecycle().close();
    await settle();
    assert.equal(h.client.open().length, 0);
    assert.equal(h.logs.filter((l) => l.startsWith("disconnected")).length, 1);
    for (let i = 0; i < 7; i += 1) {
      const [delay] = retryDelays(h.logs).slice(-1);
      await h.timers.advance(delay);
    }
    assert.deepEqual(retryDelays(h.logs), [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    assert.match(h.logs.at(-1), /^disconnected \(ECONNREFUSED\)/);
  });
});

test("a successful reconnect resyncs everything and resets the delay", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "working")], backoff: { giveUpMs: 1e9 } }, async (h) => {
    await h.boot();
    h.client.up = false;
    h.client.lifecycle().close();
    await settle();
    await h.timers.advance(500);
    await h.timers.advance(1000);
    assert.deepEqual(retryDelays(h.logs), [500, 1000, 2000]);
    // Changed while we were away.
    h.client.tabs[0].agent_status = "done";
    h.client.up = true;
    await h.timers.advance(2000);
    assert.equal(h.logs.at(-1), "connected, 1 tabs");
    assert.deepEqual(labels(h), ["✓ api"]);
    assert.equal(h.client.open().length, 2);
    // Next outage starts at the base delay again.
    h.client.up = false;
    h.client.lifecycle().close();
    await settle();
    assert.equal(retryDelays(h.logs).at(-1), 500);
  });
});

for (const which of ["lifecycle", "status"]) {
  test(`events_lost on the ${which} connection disconnects`, async () => {
    await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
      await h.boot();
      const sub = which === "lifecycle" ? h.client.lifecycle() : h.client.statusSub();
      sub.cb.onError(new HerdrError("events_lost", "lagged", "events.subscribe"));
      await settle();
      assert.equal(h.client.open().length, 0);
      assert.match(h.logs.at(-1), /^disconnected \(events_lost\), retry in 500 ms$/);
      assert.equal(h.logs.filter((l) => l.startsWith("disconnected")).length, 1);
    });
  });
}

test("a transport error from a request disconnects", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
    await h.boot();
    h.client.up = false;
    h.client.emit("tab.focused", {});
    await h.timers.advance(100);
    assert.equal(h.client.open().length, 0);
    assert.match(h.logs.at(-1), /^disconnected \(ECONNREFUSED\), retry in 500 ms$/);
  });
});

test("isTransportError accepts EPROTO but not a HerdrError", () => {
  assert.equal(isTransportError(transportError("EPROTO")), true);
  assert.equal(isTransportError(new HerdrError("ECONNRESET", "x")), false);
  assert.equal(isTransportError(new Error("plain")), false);
});

test("a late onClose or onError of an old subscription does not start another backoff", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
    await h.boot();
    const old = h.client.subs.slice();
    h.client.lifecycle().close();
    await settle();
    await h.timers.advance(500);
    assert.equal(h.logs.at(-1), "connected, 1 tabs");
    const logCount = h.logs.length;
    for (const sub of old) {
      sub.cb.onClose();
      sub.cb.onError(new HerdrError("events_lost", "x"));
    }
    await settle();
    assert.equal(h.logs.length, logCount);
    assert.equal(h.timers.pending.size, 0);
    assert.equal(h.client.open().length, 2);
  });
});

test("a lifecycle subscription that never starts times out into backoff", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
    h.client.manualStart = true;
    let settled = false;
    h.daemon.start().then(() => {
      settled = true;
    });
    await h.timers.advance(4999);
    assert.equal(h.logs.filter((l) => l.startsWith("disconnected")).length, 0);
    await h.timers.advance(1);
    assert.equal(settled, true, "start settles after the first attempt");
    assert.match(h.logs.at(-1), /^disconnected \(ETIMEDOUT\), retry in 500 ms$/);
    assert.equal(h.client.subs[0].closed, true);
    assert.equal(h.client.open().length, 0);
    // A server that stays wedged ends in the give-up rule.
    await h.timers.advance(600000);
    assert.deepEqual(h.exits, [0]);
    assert.equal(h.logs.filter((l) => l === "server gone, exiting").length, 1);
    assert.equal(h.timers.pending.size, 0);
    assert.equal(h.client.count("tab.list"), 0);
  });
});

test("a status subscription that never starts during a flush disconnects, and resyncs run again after reconnect", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")], backoff: { giveUpMs: 1e9 } }, async (h) => {
    await h.boot();
    h.client.manualStart = true;
    h.client.panes = [{ pane_id: "w1:p1" }, { pane_id: "w1:p3" }];
    h.client.emit("pane.created", {});
    await h.timers.advance(100);
    assert.equal(h.client.subs.length, 3);
    // Events during the stuck flush only ask for another one.
    h.client.emit("tab.focused", {});
    await h.timers.advance(4999);
    assert.equal(h.logs.filter((l) => l.startsWith("disconnected")).length, 0);
    await h.timers.advance(1);
    assert.match(h.logs.at(-1), /^disconnected \(ETIMEDOUT\), retry in 500 ms$/);
    assert.equal(h.client.open().length, 0);
    h.client.manualStart = false;
    await h.timers.advance(500);
    assert.equal(h.logs.at(-1), "connected, 1 tabs");
    assert.equal(h.timers.pending.size, 0, "no start timeout left behind");
    const lists = h.client.count("tab.list");
    h.client.emit("tab.focused", {});
    await h.timers.advance(100);
    assert.equal(h.client.count("tab.list"), lists + 1);
  });
});

test("stop while a subscription waits for its start leaves no start timeout", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
    h.client.manualStart = true;
    const started = h.daemon.start();
    await settle();
    assert.equal(h.timers.pending.size, 1);
    await h.daemon.stop();
    await started;
    assert.equal(h.timers.pending.size, 0);
    await h.timers.advance(600000);
    assert.deepEqual(h.exits, []);
    assert.equal(h.logs.filter((l) => l.startsWith("disconnected")).length, 0);
  });
});

// ---- gone for good ----

test("the daemon exits with 0 once no connect succeeded for giveUpMs", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
    h.client.up = false;
    await h.daemon.start();
    await settle();
    await h.timers.advance(91500);
    assert.deepEqual(h.exits, [], "still retrying before 120 s");
    await h.timers.advance(30000);
    assert.deepEqual(h.exits, [0]);
    assert.equal(h.logs.filter((l) => l === "server gone, exiting").length, 1);
    assert.equal(h.timers.pending.size, 0);
    await h.timers.advance(600000);
    assert.deepEqual(h.exits, [0]);
    assert.equal(h.client.closed, true);
  });
});

// ---- stop ----

test("stop is idempotent, closes everything, saves state and leaves no timers", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "working")] }, async (h) => {
    await h.boot();
    h.client.emit("tab.focused", {});
    assert.equal(h.timers.pending.size, 1);
    fs.rmSync(h.stateFile);
    await h.daemon.stop();
    await h.daemon.stop();
    assert.equal(h.client.open().length, 0);
    assert.equal(h.client.closed, true);
    assert.equal(h.timers.pending.size, 0);
    assert.equal(h.readState().tabs["w1:t1"].lastWritten, "◐ api");
    const lists = h.client.count("tab.list");
    await h.timers.advance(600000);
    assert.equal(h.client.count("tab.list"), lists);
    assert.deepEqual(h.exits, []);
  });
});

test("stop during backoff cancels the retry", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
    h.client.up = false;
    await h.daemon.start();
    assert.equal(h.timers.pending.size, 1);
    await h.daemon.stop();
    assert.equal(h.timers.pending.size, 0);
    const subs = h.client.subs.length;
    await h.timers.advance(600000);
    assert.equal(h.client.subs.length, subs);
  });
});

test("stop during connect lets start settle", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
    h.client.manualStart = true;
    const started = h.daemon.start();
    await settle();
    await h.daemon.stop();
    await started;
    assert.equal(h.client.count("tab.list"), 0);
    assert.equal(h.timers.pending.size, 0);
    assert.equal(h.client.open().length, 0);
    assert.deepEqual(h.exits, []);
  });
});

test("stop during the second subscription start lets start settle", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
    h.client.manualStart = true;
    const started = h.daemon.start();
    await settle();
    h.client.subs[0].start();
    await settle();
    assert.equal(h.client.subs.length, 2);
    await h.daemon.stop();
    await started;
    assert.equal(h.client.count("tab.list"), 0);
    assert.equal(h.client.open().length, 0);
  });
});

// ---- startup strip ----

test("startup strips leftover icons from tabs without state and keeps a correct one", async () => {
  const tabs = [
    tabOf("w1:t1", "✓ api", "idle"),
    tabOf("w1:t2", "⏳ docs", "unknown"),
    tabOf("w1:t3", "? ? build", "unknown"),
    tabOf("w1:t4", "◐ web", "working"),
  ];
  await withDaemon({ tabs }, async (h) => {
    assert.equal(fs.existsSync(h.stateFile), false, "no state.json before start");
    await h.boot();
    assert.deepEqual(labels(h), ["api", "docs", "build", "◐ web"]);
    assert.deepEqual(
      h.client.renames.map((r) => r.tab_id),
      ["w1:t1", "w1:t2", "w1:t3"],
      "the correct tab is not renamed",
    );
  });
});

// ---- restoreTabs ----

test("restoreTabs renames only tabs whose label changes, in order, and keeps untracked tabs untracked", async () => {
  const client = fakeClient({
    tabs: [tabOf("w1:t1", "◐ api", "working"), tabOf("w1:t2", "build"), tabOf("w1:t3", "✓ docs", "done")],
    panes: [],
  });
  const tabs = {
    "w1:t1": { base: "api", lastWritten: "◐ api", autoNamed: false },
    "w1:t2": { base: "build", lastWritten: "build", autoNamed: false },
  };
  const result = await restoreTabs({ client, tabs, config: defaultConfig() });
  assert.deepEqual(client.renames, [
    { tab_id: "w1:t1", label: "api" },
    { tab_id: "w1:t3", label: "docs" },
  ]);
  assert.deepEqual(result, {
    "w1:t1": { base: "api", lastWritten: "api", autoNamed: false },
    "w1:t2": { base: "build", lastWritten: "build", autoNamed: false },
  });
  assert.equal(tabs["w1:t1"].lastWritten, "◐ api", "input not mutated");
});

test("restoreTabs gives a tracked auto-named tab its current position", async () => {
  const client = fakeClient({ tabs: [tabOf("w1:t1", "x"), tabOf("w1:t2", "✓ 2", "done")], panes: [] });
  const tabs = { "w1:t2": { base: "5", lastWritten: "✓ 2", autoNamed: true } };
  const result = await restoreTabs({ client, tabs, config: defaultConfig() });
  assert.deepEqual(client.renames, [{ tab_id: "w1:t2", label: "2" }]);
  assert.equal(result["w1:t2"].lastWritten, "2");
});

test("restoreTabs prunes the entries of closed tabs", async () => {
  const client = fakeClient({ tabs: [tabOf("w1:t1", "api")], panes: [] });
  const tabs = {
    "w1:t1": { base: "api", lastWritten: "api", autoNamed: false },
    "w1:t9": { base: "gone", lastWritten: "gone", autoNamed: false },
  };
  const result = await restoreTabs({ client, tabs, config: defaultConfig() });
  assert.deepEqual(Object.keys(result), ["w1:t1"]);
});

test("restoreTabs skips a tab that errors and carries on, logging all but tab_not_found", async () => {
  const client = fakeClient({
    tabs: [tabOf("w1:t1", "✓ a", "done"), tabOf("w1:t2", "✓ b", "done"), tabOf("w1:t3", "✓ c", "done")],
    panes: [],
  });
  client.renameErrors["w1:t1"] = new HerdrError("tab_not_found", "gone", "tab.rename");
  client.renameErrors["w1:t2"] = new HerdrError("internal", "boom", "tab.rename");
  const logs = [];
  const tabs = {
    "w1:t2": { base: "b", lastWritten: "✓ b", autoNamed: false },
    "w1:t3": { base: "c", lastWritten: "✓ c", autoNamed: false },
  };
  const result = await restoreTabs({ client, tabs, config: defaultConfig(), log: (m) => logs.push(m) });
  assert.deepEqual(client.renames, [{ tab_id: "w1:t3", label: "c" }]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /w1:t2/);
  assert.equal(result["w1:t2"].lastWritten, "✓ b", "a failed tab keeps its entry as it was");
  assert.equal(result["w1:t3"].lastWritten, "c");
});

test("restoreTabs rejects on a transport error and stops renaming", async () => {
  const client = fakeClient({ tabs: [tabOf("w1:t1", "✓ a", "done"), tabOf("w1:t2", "✓ b", "done")], panes: [] });
  client.renameError = transportError("EPIPE");
  await assert.rejects(restoreTabs({ client, tabs: {}, config: defaultConfig() }), { code: "EPIPE" });
  assert.equal(client.count("tab.rename"), 1);
});

// ---- stop({restore}) ----

test("stop with restore puts every tab back to its base and resolves true", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "working"), tabOf("w1:t2", "docs", "done")] }, async (h) => {
    await h.boot();
    assert.deepEqual(labels(h), ["◐ api", "✓ docs"]);
    assert.equal(await h.daemon.stop({ restore: true }), true);
    assert.deepEqual(labels(h), ["api", "docs"]);
    assert.equal(h.client.closed, true);
    assert.equal(h.readState().tabs["w1:t1"].lastWritten, "api");
    assert.deepEqual(h.exits, []);
  });
});

test("stop with restore waits for a rename in flight, then restores on top of it", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "idle")] }, async (h) => {
    await h.boot();
    let release;
    h.client.renameGate = new Promise((resolve) => {
      release = resolve;
    });
    h.client.tabs[0].agent_status = "working";
    h.client.emitStatus("w1:p1");
    await h.timers.advance(100);
    const stopping = h.daemon.stop({ restore: true });
    await settle();
    assert.deepEqual(h.client.renames, [], "the first rename is still blocked");
    assert.equal(h.client.count("tab.list"), 2, "the restore has not listed tabs yet");
    release();
    assert.equal(await stopping, true);
    assert.deepEqual(
      h.client.renames.map((r) => r.label),
      ["◐ api", "api"],
    );
    assert.deepEqual(labels(h), ["api"]);
  });
});

test("stop with restore on a dead socket logs one line, still closes and saves, and resolves false", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "working")] }, async (h) => {
    await h.boot();
    fs.rmSync(h.stateFile);
    h.logs.length = 0;
    h.client.up = false;
    assert.equal(await h.daemon.stop({ restore: true }), false);
    assert.equal(h.logs.length, 1);
    assert.match(h.logs[0], /restore failed/);
    assert.equal(h.client.closed, true);
    assert.equal(fs.existsSync(h.stateFile), true, "state saved");
    assert.deepEqual(labels(h), ["◐ api"]);
  });
});

test("stop with restore is idempotent and restores once", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "working")] }, async (h) => {
    await h.boot();
    const first = h.daemon.stop({ restore: true });
    const second = h.daemon.stop({ restore: true });
    const third = h.daemon.stop();
    assert.equal(first, second);
    assert.equal(first, third);
    assert.equal(await first, true);
    assert.equal(await h.daemon.stop({ restore: true }), true);
    assert.equal(h.client.renames.filter((r) => r.label === "api").length, 1);
    assert.equal(h.client.count("tab.list"), 2);
  });
});

test("stop with restore on a daemon that never started does nothing", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "✓ api", "done")] }, async (h) => {
    assert.equal(await h.daemon.stop({ restore: true }), false);
    assert.deepEqual(h.client.calls, []);
    assert.deepEqual(labels(h), ["✓ api"]);
  });
});

test("stop without restore leaves the names alone and resolves false", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "working")] }, async (h) => {
    await h.boot();
    assert.equal(await h.daemon.stop(), false);
    assert.deepEqual(labels(h), ["◐ api"]);
    assert.equal(h.client.count("tab.list"), 1);
  });
});

// ---- refresh ----

test("refresh while connected runs a resync", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "idle")] }, async (h) => {
    await h.boot();
    h.client.tabs[0].agent_status = "working"; // no event: only a refresh can notice
    await h.daemon.refresh();
    await settle();
    assert.deepEqual(labels(h), ["◐ api"]);
    assert.equal(h.client.count("tab.list"), 2);
  });
});

test("refresh during backoff cancels the retry timer and connects now", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "working")] }, async (h) => {
    h.client.up = false;
    await h.boot();
    assert.equal(h.timers.pending.size, 1, "retry timer waiting");
    assert.equal(h.client.count("tab.list"), 0);
    h.client.up = true;
    await h.daemon.refresh();
    await settle();
    assert.equal(h.timers.pending.size, 0, "retry timer cancelled");
    assert.deepEqual(labels(h), ["◐ api"]);
    assert.ok(h.logs.some((l) => l.startsWith("connected")));
  });
});

test("refresh before start and after stop does nothing", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "working")] }, async (h) => {
    await h.daemon.refresh();
    assert.deepEqual(h.client.calls, []);
    await h.boot();
    await h.daemon.stop();
    const calls = h.client.calls.length;
    await h.daemon.refresh();
    assert.equal(h.client.calls.length, calls);
    assert.equal(h.timers.pending.size, 0);
  });
});

// ---- setConfig ----

test("setConfig with another preset renames tabs at once on the same base", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "working")] }, async (h) => {
    await h.boot();
    assert.deepEqual(labels(h), ["◐ api"]);
    await h.daemon.setConfig({ ...defaultConfig(), preset: "emoji" });
    await settle();
    assert.deepEqual(labels(h), ["⏳ api"]);
    assert.equal(h.readState().tabs["w1:t1"].base, "api");
  });
});

test("restore after setConfig strips with the new config's icons", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api", "working")] }, async (h) => {
    await h.boot();
    await h.daemon.setConfig({ ...defaultConfig(), icons: { working: "@@" } });
    await settle();
    assert.deepEqual(labels(h), ["@@ api"]);
    // Somebody changed the name without an event we saw: not our echo any more.
    h.client.tabs[0].label = "@@ web";
    assert.equal(await h.daemon.stop({ restore: true }), true);
    assert.deepEqual(labels(h), ["web"]);
  });
});

// ---- self-check ----

const SELF = { pluginId: "cowbell", selfCheckMs: 10000 };
const listed = (h) => h.client.calls.filter(([m]) => m === "plugin.list");
const enabledPlugin = { plugin_id: "cowbell", enabled: true };
const withPlugins = (plugins) => (h) => {
  h.client.plugins = plugins;
};

test("self-check asks herdr about its own plugin id", async () => {
  await withDaemon({ ...SELF, tabs: [tabOf("w1:t1", "api")], before: withPlugins([enabledPlugin]) }, async (h) => {
    await h.boot();
    assert.deepEqual(listed(h), [["plugin.list", { plugin_id: "cowbell" }]]);
    assert.deepEqual(h.exits, []);
  });
});

test("self-check runs at most once per interval", async () => {
  await withDaemon({ ...SELF, tabs: [tabOf("w1:t1", "api")], before: withPlugins([enabledPlugin]) }, async (h) => {
    await h.boot();
    await h.daemon.refresh();
    await h.daemon.refresh();
    await h.timers.advance(9999);
    await h.daemon.refresh();
    assert.equal(listed(h).length, 1);
    await h.timers.advance(1);
    await h.daemon.refresh();
    assert.equal(listed(h).length, 2);
    await h.daemon.refresh();
    assert.equal(listed(h).length, 2);
  });
});

test("self-check never runs without a plugin id", async () => {
  await withDaemon({ tabs: [tabOf("w1:t1", "api")] }, async (h) => {
    await h.boot();
    await h.timers.advance(60000);
    await h.daemon.refresh();
    assert.equal(listed(h).length, 0);
  });
});

for (const [name, plugins, word] of [
  ["disabled", [{ plugin_id: "cowbell", enabled: false }], "disabled"],
  ["removed", [], "removed"],
  ["another plugin only", [{ plugin_id: "other", enabled: true }], "removed"],
]) {
  test(`self-check: plugin ${name} restores the names and exits 0`, async () => {
    const options = { ...SELF, tabs: [tabOf("w1:t1", "✓ api", "idle")], before: withPlugins(plugins) };
    await withDaemon(options, async (h) => {
      await h.boot();
      assert.ok(
        h.logs.some((l) => l.includes(word) && l.includes("restoring")),
        `log mentions ${word}: ${h.logs.join(" | ")}`,
      );
      assert.deepEqual(labels(h), ["api"]);
      assert.deepEqual(h.exits, [0]);
      assert.equal(h.client.closed, true);
    });
  });
}

test("self-check: a plugin disabled later restores tabs the daemon had already renamed", async () => {
  await withDaemon({ ...SELF, tabs: [tabOf("w1:t1", "api", "working")], before: withPlugins([enabledPlugin]) }, async (h) => {
    await h.boot();
    assert.deepEqual(labels(h), ["◐ api"]);
    h.client.plugins = [{ plugin_id: "cowbell", enabled: false }];
    await h.timers.advance(10000);
    await h.daemon.refresh();
    await settle();
    assert.deepEqual(labels(h), ["api"]);
    assert.deepEqual(h.exits, [0]);
  });
});

test("self-check: an error reply from herdr switches the check off and the daemon keeps running", async () => {
  await withDaemon({ ...SELF, tabs: [tabOf("w1:t1", "api", "idle")] }, async (h) => {
    h.client.pluginError = new HerdrError("unknown_method", "no plugin.list", "plugin.list");
    await h.boot();
    assert.equal(listed(h).length, 1);
    h.client.tabs[0].agent_status = "working";
    await h.timers.advance(60000);
    await h.daemon.refresh();
    assert.equal(listed(h).length, 1, "asked once, never again");
    assert.deepEqual(labels(h), ["◐ api"], "still resyncing");
    assert.deepEqual(h.exits, []);
  });
});

test("self-check: a transport error is ignored and the check is tried again later", async () => {
  await withDaemon({ ...SELF, tabs: [tabOf("w1:t1", "api", "idle")] }, async (h) => {
    h.client.pluginError = transportError("EPIPE");
    await h.boot();
    assert.equal(listed(h).length, 1);
    assert.deepEqual(h.exits, []);
    assert.deepEqual(h.client.renames, []);
    h.client.pluginError = null;
    h.client.plugins = [enabledPlugin];
    await h.timers.advance(10000);
    await h.daemon.refresh();
    assert.equal(listed(h).length, 2);
    assert.deepEqual(h.exits, []);
  });
});
