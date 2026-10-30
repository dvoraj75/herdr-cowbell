// Singleton lock: a pidfile in the plugin state directory. Sync fs so the
// daemon can take it before anything else runs and bin/ctl.js can read it
// without async plumbing.
//
// The pidfile is never written in place: the pid goes to a private temp file
// first and is hard-linked to `cowbell.pid`. link() fails with EEXIST when the
// name exists, so creating the lock is atomic and a reader never sees a torn
// or empty file. A pidfile whose holder is dead (or whose content is garbage)
// is removed under a short-lived takeover lock, and only when it still holds
// the same content, so two processes cleaning up the same stale file cannot
// delete the pidfile a third one just created.
import fs from "node:fs";
import path from "node:path";

export const PIDFILE = "cowbell.pid";
const TAKEOVER_FILE = `${PIDFILE}.takeover`;
// A takeover only re-reads and unlinks one file; one this old belongs to a
// process that died in between and would otherwise block every later start.
const TAKEOVER_STALE_MS = 10000;
const ACQUIRE_ATTEMPTS = 50;
const RETRY_SLEEP_MS = 20;

/**
 * @param {string} dir The plugin state directory.
 * @returns {string}
 */
export function pidfilePath(dir) {
  return path.join(dir, PIDFILE);
}

/**
 * Block the thread for a short while. Used only between lock attempts, which
 * happen before the daemon has anything else to do.
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {string} text
 * @returns {number | null} A positive integer pid, else null.
 */
function parsePid(text) {
  const trimmed = text.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) ? pid : null;
}

/**
 * @param {string} file
 * @returns {string | null} The content, or null when the file does not exist.
 * @throws {Error} For any other read error.
 */
function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * @param {string} file
 * @returns {boolean} True when this call removed it.
 * @throws {Error} For any error other than the file being gone already.
 */
function unlinkIfExists(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

/**
 * The pid recorded in the pidfile.
 * @param {string} dir The plugin state directory.
 * @returns {number | null} null when the file is missing, unreadable or not a pid.
 */
export function readPid(dir) {
  try {
    return parsePid(fs.readFileSync(pidfilePath(dir), "utf8"));
  } catch {
    // Callers only ask "is there a holder"; an unreadable file names none.
    return null;
  }
}

/**
 * Whether a process with this pid exists. Signal 0 checks without sending.
 * @param {number} pid
 * @returns {boolean} EPERM counts as alive: the process exists, it is just
 *   not ours to signal.
 */
export function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

/**
 * Whether the pid is a running cowbell daemon. A pid alone can be reused by
 * an unrelated process after a crash or reboot, so where `/proc` tells us the
 * command line, it must mention `cowbell.js`. Without `/proc` (macOS) the pid
 * check is all there is.
 * @param {number} pid
 * @param {{procRoot?: string}} [options]
 * @returns {boolean}
 */
export function isDaemonAlive(pid, { procRoot = "/proc" } = {}) {
  if (!pidExists(pid)) return false;
  let cmdline;
  try {
    cmdline = fs.readFileSync(path.join(procRoot, String(pid), "cmdline"), "utf8");
  } catch {
    return true;
  }
  return cmdline.includes("cowbell.js");
}

/**
 * @param {string} dir The plugin state directory.
 * @param {{isAlive?: (pid: number) => boolean}} [options]
 * @returns {number | null} The pid of the live daemon holding the lock, if any.
 */
export function livePid(dir, { isAlive = isDaemonAlive } = {}) {
  const pid = readPid(dir);
  return pid !== null && isAlive(pid) ? pid : null;
}

/**
 * Remove a stale pidfile, holding the takeover lock while doing so.
 * @param {string} dir
 * @param {string} staleText The pidfile content that was judged stale.
 * @returns {boolean} False when another process holds the takeover lock;
 *   the caller should wait a little before trying again.
 */
function removeStale(dir, staleText) {
  const takeover = path.join(dir, TAKEOVER_FILE);
  let fd;
  try {
    fd = fs.openSync(takeover, "wx");
  } catch (err) {
    if (!err || err.code !== "EEXIST") throw err;
    let stat = null;
    try {
      stat = fs.statSync(takeover);
    } catch (statErr) {
      if (!statErr || statErr.code !== "ENOENT") throw statErr;
    }
    if (stat && Date.now() - stat.mtimeMs > TAKEOVER_STALE_MS) unlinkIfExists(takeover);
    return false;
  }
  try {
    fs.closeSync(fd);
    // Someone may have replaced the stale file with a live one since we read
    // it; that one must survive.
    if (readTextIfExists(pidfilePath(dir)) === staleText) unlinkIfExists(pidfilePath(dir));
    return true;
  } finally {
    unlinkIfExists(takeover);
  }
}

/**
 * Take the singleton lock. Holding it means the pidfile contains `pid`.
 * @param {string} dir The plugin state directory; created if missing.
 * @param {{pid?: number, isAlive?: (pid: number) => boolean}} [options]
 * @returns {{acquired: true} | {acquired: false, pid: number}} `pid` is the live holder.
 * @throws {Error} When the directory cannot be written, or the lock stays
 *   contended past the retry limit.
 */
export function acquire(dir, { pid = process.pid, isAlive = isDaemonAlive } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const target = pidfilePath(dir);
  const temp = path.join(dir, `${PIDFILE}.${pid}.tmp`);
  fs.writeFileSync(temp, `${pid}\n`);
  try {
    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
      try {
        fs.linkSync(temp, target);
        return { acquired: true };
      } catch (err) {
        if (!err || err.code !== "EEXIST") throw err;
      }
      const text = readTextIfExists(target);
      // Released between our link and our read: just try again.
      if (text === null) continue;
      const holder = parsePid(text);
      // A pidfile with our pid is ours, e.g. left by an earlier process
      // that had the same pid.
      if (holder === pid) return { acquired: true };
      if (holder !== null && isAlive(holder)) return { acquired: false, pid: holder };
      if (!removeStale(dir, text)) sleepSync(RETRY_SLEEP_MS);
    }
  } finally {
    unlinkIfExists(temp);
  }
  throw new Error(`${PIDFILE}: still contended after ${ACQUIRE_ATTEMPTS} attempts`);
}

/**
 * Give the lock up. Only our own pidfile is removed: after a takeover, the
 * file may belong to another daemon.
 * @param {string} dir The plugin state directory.
 * @param {{pid?: number}} [options]
 * @returns {boolean} True when the pidfile was ours and is gone now; false
 *   when it was not ours, or could not be read or removed (this runs from an
 *   exit handler, where a throw has nowhere to go).
 */
export function release(dir, { pid = process.pid } = {}) {
  const target = pidfilePath(dir);
  let text;
  try {
    text = readTextIfExists(target);
  } catch {
    return false;
  }
  if (text === null || parsePid(text) !== pid) return false;
  try {
    return unlinkIfExists(target);
  } catch {
    return false;
  }
}
