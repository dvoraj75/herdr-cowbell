// Plugin state (state.json) and the on/off flag. Sync fs: these
// run at daemon startup and for small writes after a resync.
import fs from "node:fs";
import path from "node:path";

/** @typedef {import("./label.js").TabEntry} TabEntry */

/**
 * @typedef {object} State
 * @property {number} version Always 1.
 * @property {Record<string, TabEntry>} tabs Keyed by herdr tab id.
 */

const STATE_FILE = "state.json";
const DISABLED_FLAG = "disabled";
const STATE_VERSION = 1;

/**
 * @param {unknown} value
 * @returns {boolean} True for a non-null, non-array object.
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} entry
 * @returns {boolean}
 */
function isTabEntry(entry) {
  return (
    isPlainObject(entry) &&
    typeof entry.base === "string" &&
    typeof entry.lastWritten === "string" &&
    typeof entry.autoNamed === "boolean"
  );
}

/**
 * @returns {State}
 */
function emptyState() {
  return { version: STATE_VERSION, tabs: {} };
}

/**
 * Read state.json. A missing file is the normal first run and is silent;
 * anything else that prevents using it starts empty and logs one line, so a
 * damaged file never stops the daemon.
 * @param {string | null | undefined} dir The plugin state directory.
 * @param {(message: string) => void} log
 * @returns {State}
 */
export function loadState(dir, log) {
  if (!dir) return emptyState();
  let text;
  try {
    text = fs.readFileSync(path.join(dir, STATE_FILE), "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return emptyState();
    log(`${STATE_FILE}: ${err && err.message}`);
    return emptyState();
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    log(`${STATE_FILE}: invalid JSON (${String(err && err.message).split("\n")[0]}), starting empty`);
    return emptyState();
  }
  if (!isPlainObject(data) || data.version !== STATE_VERSION || !isPlainObject(data.tabs)) {
    log(`${STATE_FILE}: unexpected shape, starting empty`);
    return emptyState();
  }

  const entries = [];
  let dropped = 0;
  for (const [tabId, entry] of Object.entries(data.tabs)) {
    if (!isTabEntry(entry)) {
      dropped += 1;
      continue;
    }
    entries.push([tabId, { base: entry.base, lastWritten: entry.lastWritten, autoNamed: entry.autoNamed }]);
  }
  if (dropped > 0) log(`${STATE_FILE}: dropped ${dropped} malformed tab ${dropped === 1 ? "entry" : "entries"}`);
  // fromEntries defines own properties, so a tab id like "__proto__" stays data.
  return { version: STATE_VERSION, tabs: Object.fromEntries(entries) };
}

/**
 * Write state.json atomically: a temp file in the same directory, then a
 * rename over the old file, so a crash mid-write never leaves a torn file.
 * @param {string} dir The plugin state directory; created if missing.
 * @param {{tabs?: Record<string, TabEntry>}} state
 * @returns {void}
 * @throws {Error} When the directory or file cannot be written.
 */
export function saveState(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, STATE_FILE);
  const temp = `${target}.tmp`;
  const text = `${JSON.stringify({ version: STATE_VERSION, tabs: (state && state.tabs) || {} }, null, 2)}\n`;
  try {
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, target);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Best-effort cleanup; the original error below is the one that matters.
    }
    throw err;
  }
}

/**
 * Whether cowbell is switched on. The off switch is a flag file so it
 * survives restarts and is shared by the daemon and the control commands.
 * @param {string} dir The plugin state directory.
 * @returns {boolean} True unless `<dir>/disabled` exists.
 */
export function isEnabled(dir) {
  return !fs.existsSync(path.join(dir, DISABLED_FLAG));
}

/**
 * Switch cowbell on or off by removing or creating the flag file.
 * @param {string} dir The plugin state directory; created if missing.
 * @param {boolean} on
 * @returns {void}
 */
export function setEnabled(dir, on) {
  const flag = path.join(dir, DISABLED_FLAG);
  if (on) {
    fs.rmSync(flag, { force: true });
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(flag, "");
}
