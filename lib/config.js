// config.json: loading, and the preset cycling used by the control CLI.
// Sync fs, like lib/state.js: small files, read at startup or on a command.
import fs from "node:fs";
import path from "node:path";
import { defaultConfig, parseConfig, PRESET_NAMES } from "./icons.js";

export const CONFIG_FILE = "config.json";

const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 10;

/**
 * @param {unknown} value
 * @returns {boolean} True for a non-null, non-array object.
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read config.json. No directory or no file means defaults; an unreadable
 * or invalid file logs one line and yields `lastGood` (or the defaults), so
 * a typo made while the daemon runs keeps the previous working config.
 * @param {string | null | undefined} dir The plugin config directory.
 * @param {(message: string) => void} log
 * @param {object | null} [lastGood] Config to keep when the file is bad.
 * @returns {object} A config as returned by `parseConfig`.
 */
export function loadConfig(dir, log, lastGood = null) {
  if (!dir) return defaultConfig();
  let text;
  try {
    text = fs.readFileSync(path.join(dir, CONFIG_FILE), "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return defaultConfig();
    log(`${CONFIG_FILE}: ${err && err.message}`);
    return lastGood == null ? defaultConfig() : lastGood;
  }
  const { config, error } = parseConfig(text, lastGood);
  if (error) log(`${CONFIG_FILE}: ${error}`);
  return config;
}

/**
 * The preset after `current` in `PRESET_NAMES`, wrapping around. `custom`
 * is skipped unless `config.icons` defines at least one non-empty icon,
 * because without icons it would show nothing.
 * @param {unknown} current The preset now in the file; unknown or absent
 *   counts as the default, `ask`.
 * @param {{icons?: Record<string, string>}} config
 * @returns {string}
 */
export function nextPreset(current, config) {
  const hasCustom = Object.values((config && config.icons) || {}).some(
    (icon) => typeof icon === "string" && icon !== "",
  );
  const known = PRESET_NAMES.indexOf(typeof current === "string" ? current : "ask");
  const start = known === -1 ? PRESET_NAMES.indexOf("ask") : known;
  // Walk the full list from `current`, so a skipped `custom` as the current
  // value still moves on to the following preset instead of restarting.
  for (let step = 1; step <= PRESET_NAMES.length; step += 1) {
    const name = PRESET_NAMES[(start + step) % PRESET_NAMES.length];
    if (name !== "custom" || hasCustom) return name;
  }
  return PRESET_NAMES[start];
}

/**
 * Advance `preset` in config.json to the next one, keeping every other key.
 * A missing file is created. A file that is not a JSON object is never
 * overwritten: the user may be editing it.
 * @param {string} dir The plugin config directory; created if missing.
 * @returns {{preset: string}}
 * @throws {Error} When config.json is invalid JSON, not an object, fails
 *   validation with the new preset, or cannot be written.
 */
export function cyclePreset(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, `${CONFIG_FILE}.lock`);
  acquireLock(lockPath);
  try {
    return cyclePresetLocked(dir);
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

/**
 * Take an exclusive lock file, waiting briefly for another holder. Herdr runs
 * plugin actions concurrently, so quick key presses overlap. A lock older
 * than LOCK_STALE_MS belongs to a crashed process and is removed.
 * @param {string} lockPath
 * @throws {Error} When the lock stays held for LOCK_WAIT_MS.
 */
function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx"));
      return;
    } catch (err) {
      if (!(err && err.code === "EEXIST")) throw err;
    }
    let stat = null;
    try {
      stat = fs.statSync(lockPath);
    } catch {
      continue; // Released between open and stat: try again at once.
    }
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      fs.rmSync(lockPath, { force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`${CONFIG_FILE} is busy; try again`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
  }
}

/**
 * The read-modify-write of `cyclePreset`; the caller holds the lock.
 * @param {string} dir
 * @returns {{preset: string}}
 */
function cyclePresetLocked(dir) {
  const target = path.join(dir, CONFIG_FILE);
  let data = {};
  let text;
  try {
    text = fs.readFileSync(target, "utf8");
  } catch (err) {
    if (!(err && err.code === "ENOENT")) throw err;
  }
  if (text !== undefined) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      const reason = String(err && err.message).split("\n")[0];
      throw new Error(`${CONFIG_FILE} is not valid JSON (${reason}); fix it by hand, not changed`);
    }
    if (!isPlainObject(data)) {
      throw new Error(`${CONFIG_FILE} is not a JSON object; fix it by hand, not changed`);
    }
  }

  const { config } = parseConfig(data);
  const preset = nextPreset(data.preset, config);
  // The daemon rejects a config.json that fails validation as a whole, so
  // writing the new preset into one would report a change that never applies.
  const { error } = parseConfig({ ...data, preset });
  if (error) throw new Error(`${CONFIG_FILE}: ${error}; fix it by hand, not changed`);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ ...data, preset }, null, 2)}\n`);
    fs.renameSync(temp, target);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Best-effort cleanup; the original error below is the one that matters.
    }
    throw err;
  }
  return { preset };
}
