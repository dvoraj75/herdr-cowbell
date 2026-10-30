// The daemon loop: subscribe to herdr events, resync on a debounced batch,
// rename tabs. All herdr I/O goes through the injected client (lib/socket.js
// in production, a fake in tests) and every timer through the injected
// `timers`, so tests control debounce and backoff completely.
//
// Two subscriptions: conn 1 carries lifecycle events (no filters), conn 2
// carries `pane.agent_status_changed`, which herdr only delivers with one
// `pane_id` filter per pane. herdr replays nothing, so every (re)connect ends
// in a full resync.
//
// Gone for good: when no connect has succeeded for `backoff.giveUpMs`
// (default 120 s) since the first failure of the current outage, the daemon
// logs "server gone, exiting" and calls `onExit(0)`. A connect succeeds once
// both subscriptions are started and the first resync finished. The startup
// hook brings the daemon back with the next server.
//
// Off for good: `stop({restore: true})` (SIGTERM, `ctl off`) puts every tab
// back to its base before closing. The daemon also checks now and then that
// herdr still lists its plugin as enabled (see `pluginGone`); disabling or
// removing the plugin in herdr restores the names and exits.

import { HerdrError } from "./socket.js";
import { loadState, saveState } from "./state.js";
import { decide, positions, pruneState, renamed, restoreLabel } from "./label.js";

/** @typedef {import("./label.js").TabEntry} TabEntry */

/**
 * @typedef {object} Client The subset of `createClient()` the daemon uses.
 * @property {(method: string, params?: object) => Promise<any>} request
 * @property {(subscriptions: object[], callbacks: {
 *   onStarted?: () => void,
 *   onEvent?: (event: {type: string, data: any}) => void,
 *   onError?: (err: Error) => void,
 *   onClose?: () => void,
 * }) => {close: () => void}} subscribe
 * @property {() => void} close
 */

/**
 * @typedef {object} Timers
 * @property {(callback: () => void, ms: number) => any} setTimeout
 * @property {(handle: any) => void} clearTimeout
 * @property {() => number} now Milliseconds, like `Date.now()`.
 */

/**
 * @typedef {object} Backoff
 * @property {number} baseMs First retry delay.
 * @property {number} capMs Longest retry delay.
 * @property {number} giveUpMs Outage length after which the daemon exits.
 */

/**
 * Lifecycle events of conn 1. Focus events are here because focusing a done
 * tab marks it seen; the per-pane `idle` event that follows may not arrive.
 * @type {readonly string[]}
 */
export const LIFECYCLE_EVENTS = Object.freeze([
  "pane.created",
  "pane.closed",
  "pane.moved",
  "pane.exited",
  "pane.focused",
  "tab.created",
  "tab.closed",
  "tab.renamed",
  "tab.moved",
  "tab.focused",
  "workspace.focused",
  "workspace.closed",
]);

// Events after which the pane set may differ, so conn 2 is rebuilt. herdr
// sends no `pane.closed` for the panes of a closed tab or workspace.
// `tab.created` is included because a new tab brings a new pane; the rebuild
// is a no-op when the pane set did not change.
const PANE_SET_EVENTS = new Set([
  "pane.created",
  "pane.closed",
  "pane.moved",
  "tab.created",
  "tab.closed",
  "workspace.closed",
]);

const TRANSPORT_CODES = new Set(["ENOENT", "ECONNREFUSED", "ECLOSED", "ETIMEDOUT", "EPIPE", "ECONNRESET", "EPROTO"]);

// Enough for every rename of one resync burst to still be recognised as ours.
const MAX_ECHOES = 8;

// `pane_not_found` means a pane closed between pane.list and subscribe.
const PANE_SUBSCRIBE_RETRIES = 3;

/** @type {Timers} */
const DEFAULT_TIMERS = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  now: () => Date.now(),
};

/** @type {Backoff} */
const DEFAULT_BACKOFF = { baseMs: 500, capMs: 30000, giveUpMs: 120000 };

/**
 * True for an error that means the connection to herdr is gone, as opposed
 * to an error reply from herdr.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransportError(err) {
  if (!err || typeof err !== "object" || err instanceof HerdrError) return false;
  return TRANSPORT_CODES.has(/** @type {{code?: unknown}} */ (err).code);
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
function codedError(code, message) {
  const err = /** @type {Error & {code: string}} */ (new Error(message));
  err.code = code;
  return err;
}

/**
 * Short reason for a log line.
 * @param {unknown} err
 * @returns {string}
 */
function reason(err) {
  if (err && typeof err === "object") {
    const { code, message } = /** @type {{code?: unknown, message?: unknown}} */ (err);
    if (code) return String(code);
    if (message) return String(message).split("\n")[0];
  }
  return String(err);
}

/**
 * @param {unknown} result A `tab.list` reply.
 * @returns {{tab_id: string, workspace_id: string, label: string, agent_status: string}[]}
 */
function listedTabs(result) {
  return (result && Array.isArray(result.tabs) ? result.tabs : []).filter(
    (tab) => tab && typeof tab.tab_id === "string",
  );
}

/**
 * Put every tab back to the label it should have with cowbell off (see
 * `restoreLabel`). Sequential, like the resync. Used by the daemon on stop
 * and by `ctl off` when no daemon runs.
 * @param {object} options
 * @param {Client} options.client
 * @param {Record<string, TabEntry>} options.tabs State entries keyed by tab id; not mutated.
 * @param {object} options.config Parsed config (see icons.js).
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<Record<string, TabEntry>>} The entries of the tabs that
 *   still exist, with `lastWritten` set to the restored label for every tab
 *   that now shows it. Untracked tabs stay untracked.
 * @throws {Error} A transport error (or anything that is not a herdr error
 *   reply) aborts the restore; a herdr error on one tab is logged and skipped.
 */
export async function restoreTabs({ client, tabs, config, log = () => {} }) {
  const listed = listedTabs(await client.request("tab.list", {}));
  const where = positions(listed);
  const entries = pruneState(tabs || {}, new Set(listed.map((tab) => tab.tab_id)));
  for (const tab of listed) {
    const id = tab.tab_id;
    const label = restoreLabel(tab, entries[id], config, { position: where.get(id) });
    if (label !== tab.label) {
      try {
        await client.request("tab.rename", { tab_id: id, label });
      } catch (err) {
        if (!(err instanceof HerdrError)) throw err;
        // tab_not_found: closed meanwhile, nothing left to restore.
        if (err.code !== "tab_not_found") log(`restore ${id} failed (${reason(err)})`);
        continue;
      }
    }
    if (entries[id]) entries[id] = { ...entries[id], lastWritten: label };
  }
  return entries;
}

/**
 * @returns {{dirty: boolean, paneSetDirty: boolean, renames: {tabId: string, label: string}[]}}
 */
function emptyBatch() {
  return { dirty: false, paneSetDirty: false, renames: [] };
}

/**
 * @typedef {object} Sub One subscription connection.
 * @property {{close: () => void} | null} handle
 * @property {boolean} started
 * @property {boolean} closing Set once we closed it or it failed; later callbacks are ignored.
 * @property {Promise<void>} ready Resolves on `subscription_started`, rejects if it ends first or the start times out.
 * @property {(err: unknown) => void} abort Rejects `ready`; a no-op once it settled.
 * @property {any} startTimer Pending start timeout, null once `ready` settled or the sub closed.
 */

/**
 * @param {object} options
 * @param {Client} options.client
 * @param {string} options.stateDir
 * @param {object} options.config Parsed config (see icons.js).
 * @param {(message: string) => void} [options.log]
 * @param {Partial<Timers>} [options.timers]
 * @param {number} [options.debounceMs]
 * @param {Partial<Backoff>} [options.backoff]
 * @param {number} [options.startTimeoutMs] Longest wait for `subscription_started`.
 * @param {(code: number) => void} [options.onExit]
 * @param {string | null} [options.pluginId] herdr's id of this plugin; null turns the self-check off.
 * @param {number} [options.selfCheckMs] Shortest interval between two self-checks.
 * @returns {{
 *   start: () => Promise<void>,
 *   stop: (options?: {restore?: boolean}) => Promise<boolean>,
 *   refresh: () => Promise<void>,
 *   setConfig: (config: object) => Promise<void>,
 * }}
 */
export function createDaemon({
  client,
  stateDir,
  config,
  log = () => {},
  timers,
  debounceMs = 100,
  backoff,
  startTimeoutMs = 5000,
  onExit = () => {},
  pluginId = null,
  selfCheckMs = 10000,
}) {
  const clock = { ...DEFAULT_TIMERS, ...(timers || {}) };
  const limits = { ...DEFAULT_BACKOFF, ...(backoff || {}) };

  /** @type {{tabs: Record<string, TabEntry>}} */
  let state = { tabs: {} };
  let lastSaved = "";
  /** @type {Map<string, string[]>} Labels we wrote whose `tab.renamed` has not arrived yet, oldest first. */
  const echoes = new Map();

  // Every connect and every disconnect bumps the generation. Callbacks and
  // flushes of an older generation see the mismatch and do nothing, so a
  // stale subscription closing after a reconnect cannot start another backoff.
  let generation = 0;
  let started = false;
  let stopped = false;
  /** @type {Promise<void> | null} */
  let stopping = null;
  let connected = false;
  let attempt = 0;
  /** @type {number | null} */
  let outageStart = null;
  let retryTimer = null;
  let debounceTimer = null;

  let batch = emptyBatch();
  let flushRunning = false;
  let flushPending = false;
  /** @type {Set<Promise<void>>} Flush loops still running, including those of older generations. */
  const flushLoops = new Set();

  // Off without a plugin id (not started by herdr) and, for good, once herdr
  // answers the check with an error (e.g. a herdr without `plugin.list`).
  let selfCheckOn = typeof pluginId === "string" && pluginId !== "";
  /** @type {number | null} */
  let lastSelfCheck = null;

  /** @type {Set<Sub>} */
  const openSubs = new Set();
  /** @type {Sub | null} */
  let statusSub = null;
  /** @type {string | null} Sorted pane ids conn 2 is subscribed to; null forces a rebuild. */
  let paneKey = null;
  let tabCount = 0;

  /**
   * @param {number} gen
   * @returns {boolean}
   */
  const alive = (gen) => gen === generation && !stopped;

  // ---- subscriptions ----

  /**
   * Close a subscription we no longer want. One still waiting for its start
   * rejects its `ready`, so nobody awaits it forever.
   * @param {Sub | null} sub
   */
  function closeSub(sub) {
    if (!sub) return;
    sub.closing = true;
    clearStartTimer(sub);
    sub.abort(codedError("ECLOSED", "subscription closed"));
    openSubs.delete(sub);
    if (!sub.handle) return;
    const { handle } = sub;
    sub.handle = null;
    try {
      handle.close();
    } catch (err) {
      log(`closing a subscription failed (${reason(err)})`);
    }
  }

  /** @param {Sub} sub */
  function clearStartTimer(sub) {
    if (sub.startTimer === null) return;
    clock.clearTimeout(sub.startTimer);
    sub.startTimer = null;
  }

  function closeAllSubs() {
    for (const sub of Array.from(openSubs)) closeSub(sub);
    statusSub = null;
    paneKey = null;
  }

  /**
   * Open one subscription connection. Until it is started, an error, a close
   * or the start timeout rejects `ready` (the caller decides); afterwards it
   * is a disconnect.
   * @param {object[]} subscriptions
   * @param {number} gen
   * @returns {Sub}
   */
  function openSub(subscriptions, gen) {
    /** @type {() => void} */
    let resolveReady = () => {};
    /** @type {(err: unknown) => void} */
    let rejectReady = () => {};
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // A sub that fails after its caller stopped waiting must not leave an
    // unhandled rejection behind; the caller still sees it through `await`.
    ready.catch(() => {});
    /** @type {Sub} */
    const sub = { handle: null, started: false, closing: false, ready, abort: rejectReady, startTimer: null };
    openSubs.add(sub);

    /** @param {unknown} err */
    const fail = (err) => {
      if (sub.closing) return;
      // Reject with the real reason (e.g. pane_not_found) before closeSub
      // would reject with a generic one.
      sub.abort(err);
      closeSub(sub);
      if (sub.started && alive(gen)) disconnect(err);
    };

    try {
      sub.handle = client.subscribe(subscriptions, {
        onStarted: () => {
          if (sub.closing || sub.started) return;
          sub.started = true;
          clearStartTimer(sub);
          resolveReady();
        },
        onEvent: (event) => {
          if (!sub.closing) handleEvent(event, gen);
        },
        onError: (err) => fail(err),
        onClose: () => fail(codedError("ECLOSED", "subscription closed")),
      });
    } catch (err) {
      fail(err);
    }
    // onClose may have run before subscribe() returned.
    if (sub.closing && sub.handle) closeSub(sub);
    // A wedged herdr may accept the connection and never answer. Without a
    // limit, connect() would wait forever (the give-up rule never runs) or a
    // flush would keep flushRunning set and block every later resync.
    // ETIMEDOUT is a transport code, so the caller turns it into a disconnect.
    if (!sub.closing && !sub.started) {
      sub.startTimer = clock.setTimeout(() => {
        sub.startTimer = null;
        fail(codedError("ETIMEDOUT", "subscription did not start"));
      }, startTimeoutMs);
    }
    return sub;
  }

  /**
   * Make conn 2 match the current pane set: list panes, open the new
   * subscription, wait until it is started, then close the old one, so no
   * status change falls into a gap.
   * @param {number} gen
   * @returns {Promise<void>}
   */
  async function syncStatusSub(gen) {
    for (let retry = 0; ; retry += 1) {
      const result = await client.request("pane.list", {});
      if (!alive(gen)) return;
      const panes = result && Array.isArray(result.panes) ? result.panes : [];
      const ids = panes
        .map((pane) => pane && pane.pane_id)
        .filter((id) => typeof id === "string")
        .sort();
      const key = JSON.stringify(ids);
      if (key === paneKey) return;

      if (ids.length === 0) {
        closeSub(statusSub);
        statusSub = null;
        paneKey = key;
        return;
      }

      const next = openSub(
        ids.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
        gen,
      );
      try {
        await next.ready;
      } catch (err) {
        if (!alive(gen)) return;
        const paneGone = err instanceof HerdrError && err.code === "pane_not_found";
        if (paneGone && retry < PANE_SUBSCRIBE_RETRIES) continue;
        throw err;
      }
      if (!alive(gen)) {
        closeSub(next);
        return;
      }
      closeSub(statusSub);
      statusSub = next;
      paneKey = key;
      return;
    }
  }

  // ---- events and batching ----

  /**
   * Our own rename coming back: drop it and every older label of that tab.
   * @param {string} tabId
   * @param {string} label
   * @returns {boolean} True when the label was one of ours.
   */
  function consumeEcho(tabId, label) {
    const list = echoes.get(tabId);
    if (!list) return false;
    const index = list.indexOf(label);
    if (index < 0) return false;
    list.splice(0, index + 1);
    if (list.length === 0) echoes.delete(tabId);
    return true;
  }

  /**
   * @param {string} tabId
   * @param {string} label
   */
  function rememberEcho(tabId, label) {
    const list = echoes.get(tabId) || [];
    list.push(label);
    if (list.length > MAX_ECHOES) list.splice(0, list.length - MAX_ECHOES);
    echoes.set(tabId, list);
  }

  /**
   * Undo `rememberEcho` for a rename that failed, so it sends no echo.
   * @param {string} tabId
   * @param {string} label
   */
  function forgetEcho(tabId, label) {
    const list = echoes.get(tabId);
    if (!list) return;
    const index = list.lastIndexOf(label);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) echoes.delete(tabId);
  }

  /**
   * @param {{type: string, data: any}} event
   * @param {number} gen
   */
  function handleEvent(event, gen) {
    if (!alive(gen) || !event) return;
    const data = event.data && typeof event.data === "object" ? event.data : {};
    if (event.type === "tab.renamed") {
      const { tab_id: tabId, label } = data;
      if (typeof tabId === "string" && typeof label === "string") {
        // Our echo needs no resync. Echoes are remembered before the rename
        // is sent, so this check at arrival cannot miss one.
        if (consumeEcho(tabId, label)) return;
        batch.renames.push({ tabId, label });
      }
    }
    if (PANE_SET_EVENTS.has(event.type)) batch.paneSetDirty = true;
    markDirty();
  }

  // Trailing debounce counted from the first event of the batch and never
  // extended, so a steady event storm cannot postpone the resync forever.
  function markDirty() {
    batch.dirty = true;
    if (!connected || debounceTimer !== null) return;
    debounceTimer = clock.setTimeout(onDebounce, debounceMs);
  }

  function cancelDebounce() {
    if (debounceTimer === null) return;
    clock.clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  function onDebounce() {
    debounceTimer = null;
    if (stopped || !connected) return;
    runFlushes(generation).catch((err) => log(`flush failed (${reason(err)})`));
  }

  /**
   * Run flushes one at a time. A debounce that fires during a flush asks for
   * one more flush after it instead of starting a second one.
   * @param {number} gen
   * @returns {Promise<void>} Never rejects; failures become a disconnect.
   */
  async function runFlushes(gen) {
    if (flushRunning) {
      flushPending = true;
      return;
    }
    flushRunning = true;
    flushPending = true;
    // Tracked so stop({restore}) can wait until no rename of ours is still
    // on its way to herdr: one landing after the restore would put an icon
    // back. An older generation's loop counts too, it may still be awaiting
    // its last request.
    const loop = flushLoop(gen);
    flushLoops.add(loop);
    try {
      await loop;
    } finally {
      flushLoops.delete(loop);
    }
  }

  /**
   * The body of `runFlushes`.
   * @param {number} gen
   * @returns {Promise<void>} Never rejects.
   */
  async function flushLoop(gen) {
    try {
      while (flushPending && batch.dirty && alive(gen)) {
        flushPending = false;
        const current = batch;
        batch = emptyBatch();
        await flush(current, gen);
      }
    } catch (err) {
      if (alive(gen)) disconnect(err);
    } finally {
      // A disconnect already reset the flag for the next generation.
      if (gen === generation) flushRunning = false;
    }
  }

  /**
   * @param {{paneSetDirty: boolean, renames: {tabId: string, label: string}[]}} current
   * @param {number} gen
   * @returns {Promise<void>}
   */
  async function flush(current, gen) {
    // Foreign renames first, so the resync below composes on the new base.
    for (const { tabId, label } of current.renames) {
      const prev = state.tabs[tabId];
      if (prev) state.tabs[tabId] = /** @type {TabEntry} */ (renamed(prev, label, config));
    }
    if (current.paneSetDirty) {
      await syncStatusSub(gen);
      if (!alive(gen)) return;
    }
    await resync(gen);
  }

  /**
   * One pass over every tab: decide, rename where needed, prune, save.
   * @param {number} gen
   * @returns {Promise<void>}
   */
  async function resync(gen) {
    if (await pluginGone(gen)) return;
    if (!alive(gen)) return;
    const result = await client.request("tab.list", {});
    if (!alive(gen)) return;
    const tabs = listedTabs(result);
    const where = positions(tabs);

    // Sequential on purpose: herdr answers one request per connection and
    // ordered renames keep the echo list in step with the events.
    for (const tab of tabs) {
      const id = tab.tab_id;
      const decision = decide(tab, state.tabs[id], config, { position: where.get(id) });
      if (decision.action === "rename") {
        // Remembered before sending: herdr's tab.renamed on conn 1 often
        // arrives before the reply, and must not count as a foreign rename.
        rememberEcho(id, decision.label);
        try {
          await client.request("tab.rename", { tab_id: id, label: decision.label });
        } catch (err) {
          forgetEcho(id, decision.label);
          if (isTransportError(err)) throw err;
          if (!alive(gen)) return;
          // tab_not_found: closed meanwhile; the tab.closed resync prunes it.
          if (!(err instanceof HerdrError && err.code === "tab_not_found")) {
            log(`rename ${id} failed (${reason(err)})`);
          }
          continue;
        }
        if (!alive(gen)) return;
      }
      if (decision.entry) state.tabs[id] = decision.entry;
      else delete state.tabs[id];
    }

    const liveIds = new Set(tabs.map((tab) => tab.tab_id));
    state.tabs = pruneState(state.tabs, liveIds);
    for (const id of Array.from(echoes.keys())) {
      if (!liveIds.has(id)) echoes.delete(id);
    }
    tabCount = tabs.length;
    persist();
  }

  // ---- self-check ----

  /**
   * Ask herdr whether this plugin is still installed and enabled, at most
   * once per `selfCheckMs`, piggy-backed on a resync. When it is not, start
   * the restoring stop without awaiting it (it waits for this very flush to
   * end) and report true so the resync renames nothing.
   * @param {number} gen
   * @returns {Promise<boolean>} True when the daemon is shutting down because of it.
   */
  async function pluginGone(gen) {
    if (!selfCheckOn) return false;
    const now = clock.now();
    if (lastSelfCheck !== null && now - lastSelfCheck < selfCheckMs) return false;
    lastSelfCheck = now;
    let result;
    try {
      result = await client.request("plugin.list", { plugin_id: pluginId });
    } catch (err) {
      if (err instanceof HerdrError) {
        selfCheckOn = false;
        log(`self-check off (${reason(err)})`);
      }
      // Anything else: the tab.list right after hits the same problem and
      // takes the normal disconnect path.
      return false;
    }
    if (!alive(gen)) return false;
    const plugins = result && Array.isArray(result.plugins) ? result.plugins : [];
    const entry = plugins.find((plugin) => plugin && plugin.plugin_id === pluginId);
    if (entry && entry.enabled !== false) return false;
    log(`plugin ${entry ? "disabled" : "removed"}, restoring names and exiting`);
    stop({ restore: true }).then(
      () => onExit(0),
      (stopErr) => {
        log(`stop failed (${reason(stopErr)})`);
        onExit(0);
      },
    );
    return true;
  }

  // ---- state file ----

  /** @param {boolean} [force] Save even when nothing changed. */
  function persist(force = false) {
    const serialised = JSON.stringify(state.tabs);
    if (!force && serialised === lastSaved) return;
    try {
      saveState(stateDir, state);
      lastSaved = serialised;
    } catch (err) {
      log(`state not saved (${reason(err)})`);
    }
  }

  // ---- connection lifecycle ----

  /**
   * Open both subscriptions, then run the full resync.
   * @returns {Promise<void>} Never rejects; failures become a disconnect.
   */
  async function connect() {
    retryTimer = null;
    if (stopped) return;
    generation += 1;
    const gen = generation;
    connected = false;
    try {
      const lifecycle = openSub(
        LIFECYCLE_EVENTS.map((type) => ({ type })),
        gen,
      );
      await lifecycle.ready;
      if (!alive(gen)) return;
      await syncStatusSub(gen);
      if (!alive(gen)) return;
    } catch (err) {
      if (alive(gen)) disconnect(err);
      return;
    }

    // herdr replays nothing: resync everything, including what happened
    // while the subscriptions were starting. On the first connect this is
    // also the startup strip: decide() composes every label on its base
    // (the stored one, or strip(label) for a label we did not write), so
    // icons left behind by an unclean exit are replaced or removed here.
    connected = true;
    batch.dirty = true;
    await runFlushes(gen);
    if (!alive(gen)) return;
    attempt = 0;
    outageStart = null;
    log(`connected, ${tabCount} tabs`);
  }

  /**
   * Drop both connections and the pending batch, then retry with backoff or
   * give up (see the module comment).
   * @param {unknown} err
   */
  function disconnect(err) {
    if (stopped) return;
    generation += 1;
    connected = false;
    flushRunning = false;
    flushPending = false;
    closeAllSubs();
    cancelDebounce();
    batch = emptyBatch();
    // The tab.renamed events still owed for these went down with the old
    // connection, so a later foreign rename to the same label must not be
    // swallowed as our echo.
    echoes.clear();

    const now = clock.now();
    if (outageStart === null) outageStart = now;
    if (now - outageStart >= limits.giveUpMs) {
      log("server gone, exiting");
      stop().then(
        () => onExit(0),
        (stopErr) => {
          log(`stop failed (${reason(stopErr)})`);
          onExit(0);
        },
      );
      return;
    }
    const delay = Math.min(limits.capMs, limits.baseMs * 2 ** attempt);
    attempt += 1;
    log(`disconnected (${reason(err)}), retry in ${delay} ms`);
    retryTimer = clock.setTimeout(() => {
      retryTimer = null;
      connect().catch((connectErr) => log(`connect failed (${reason(connectErr)})`));
    }, delay);
  }

  /**
   * Load state and connect. Resolves after the first connect attempt
   * finished, successful or not; later attempts run on their own.
   * @returns {Promise<void>}
   */
  async function start() {
    if (started || stopped) return;
    started = true;
    state = loadState(stateDir, log);
    lastSaved = JSON.stringify(state.tabs);
    log("started");
    await connect();
  }

  /**
   * Idempotent: every later call returns the first call's promise, whatever
   * its options. Nothing is scheduled after it resolves.
   *
   * With `restore`, every tab is put back to its base before the client
   * closes (see `restoreTabs`). It first waits for the flushes still running,
   * so a late rename of ours cannot re-add an icon after the restore. A
   * restore that fails (herdr already gone) logs one line and the stop goes
   * on. A daemon that never started has no state to restore from and skips it.
   * @param {{restore?: boolean}} [options]
   * @returns {Promise<boolean>} Never rejects; true when the names were restored.
   */
  function stop({ restore = false } = {}) {
    if (stopping) return stopping;
    stopped = true;
    generation += 1;
    connected = false;
    cancelDebounce();
    if (retryTimer !== null) {
      clock.clearTimeout(retryTimer);
      retryTimer = null;
    }
    closeAllSubs();
    stopping = restore && started ? restoreAndClose() : Promise.resolve(close());
    return stopping;
  }

  /**
   * @returns {Promise<boolean>} True when the names were restored.
   */
  async function restoreAndClose() {
    let restored = false;
    // flushLoop never rejects, so Promise.all only waits.
    await Promise.all(Array.from(flushLoops));
    try {
      state.tabs = await restoreTabs({ client, tabs: state.tabs, config, log });
      restored = true;
    } catch (err) {
      log(`restore failed (${reason(err)}), names left as they are`);
    }
    close();
    return restored;
  }

  /**
   * Close the client and save the state.
   * @returns {false} Nothing was restored.
   */
  function close() {
    try {
      client.close();
    } catch (err) {
      log(`closing the client failed (${reason(err)})`);
    }
    if (started) persist(true);
    return false;
  }

  /**
   * Resync now instead of waiting for an event. Connected: a full resync
   * (pane set included) through the normal flush serialisation. In backoff:
   * reconnect now, which ends in a full resync. While a connect is under way,
   * nothing: its own first resync covers this request.
   * @returns {Promise<void>} Never rejects; resolves when the resync or
   *   connect it started finished, or at once when it only queued one more
   *   flush behind a running one.
   */
  function refresh() {
    if (!started || stopped) return Promise.resolve();
    if (connected) {
      cancelDebounce();
      batch.dirty = true;
      batch.paneSetDirty = true;
      return runFlushes(generation);
    }
    if (retryTimer !== null) {
      clock.clearTimeout(retryTimer);
      retryTimer = null;
      return connect().catch((err) => log(`connect failed (${reason(err)})`));
    }
    return Promise.resolve();
  }

  /**
   * Use a new config from now on, then refresh. A new preset shows at once:
   * decide() composes on the stored base, never on the old icon.
   * @param {object} next Parsed config (see icons.js).
   * @returns {Promise<void>} As `refresh`.
   */
  function setConfig(next) {
    config = next;
    return refresh();
  }

  return { start, stop, refresh, setConfig };
}
