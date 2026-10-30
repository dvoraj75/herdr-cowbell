// Pure rename-fight bookkeeping: no fs, net, process, timers or console. The
// caller passes `now`. A "fight" is somebody else renaming a tab within
// `followMs` of our last rename of it (the caller checks that); another plugin
// that renames the tab back on every `tab.renamed` would otherwise ping-pong
// with us forever. After `limit` fights within `windowMs` the tab cools down:
// we leave it alone for `coolMs`, twice as long for every further strike (up to
// `maxCoolMs`). Strikes are forgotten after `quietMs` without a fight.
//
// `windowMs` must be well over `limit - 1` times `followMs`: a renamer that
// answers each of our renames just inside `followMs` produces one fight per
// `followMs` or so, and those must still add up to `limit` inside the window.

/**
 * @typedef {object} ChurnOptions
 * @property {number} limit Fights within `windowMs` that start a cool-down.
 * @property {number} followMs A foreign rename counts as a fight only this
 *   soon after our last rename of the tab.
 * @property {number} windowMs Fights are counted over this window.
 * @property {number} coolMs First cool-down; doubles with every strike.
 * @property {number} maxCoolMs Longest cool-down.
 * @property {number} quietMs Time without a fight after which strikes are forgotten.
 */

/**
 * @typedef {object} ChurnRecord Per-tab fight history.
 * @property {number[]} fights Times of the fights since the last cool-down started, oldest first.
 * @property {number} strikes Cool-downs so far.
 * @property {number | null} coolUntil End of the current or last cool-down.
 * @property {number | null} lastFight
 */

/** @type {Readonly<ChurnOptions>} */
export const CHURN_DEFAULTS = Object.freeze({
  limit: 3,
  followMs: 30000,
  windowMs: 120000,
  coolMs: 60000,
  maxCoolMs: 900000,
  quietMs: 3600000,
});

/** @returns {ChurnRecord} */
function emptyRecord() {
  return { fights: [], strikes: 0, coolUntil: null, lastFight: null };
}

/**
 * @param {ChurnRecord | null | undefined} record
 * @param {number} now
 * @returns {boolean} True while the tab must be left alone.
 */
export function isCooling(record, now) {
  return Boolean(record && record.coolUntil !== null && now < record.coolUntil);
}

/**
 * Count one fight. Does not mutate its inputs. A fight while the tab is
 * already cooling (a late event) changes nothing.
 * @param {ChurnRecord | null | undefined} record
 * @param {number} now
 * @param {Partial<ChurnOptions>} [options] Defaults: `CHURN_DEFAULTS`.
 * @returns {{record: ChurnRecord, coolMs: number | null}} `coolMs` is the
 *   length of the cool-down this fight starts, null when it starts none.
 */
export function noteFight(record, now, options = {}) {
  const limits = { ...CHURN_DEFAULTS, ...options };
  const prev = record || emptyRecord();
  if (isCooling(prev, now)) return { record: prev, coolMs: null };

  const quiet = prev.lastFight !== null && now - prev.lastFight >= limits.quietMs;
  const strikes = quiet ? 0 : prev.strikes;
  const fights = [...prev.fights.filter((at) => now - at < limits.windowMs), now];
  if (fights.length < limits.limit) {
    return { record: { fights, strikes, coolUntil: prev.coolUntil, lastFight: now }, coolMs: null };
  }
  const coolMs = Math.min(limits.maxCoolMs, limits.coolMs * 2 ** strikes);
  return {
    record: { fights: [], strikes: strikes + 1, coolUntil: now + coolMs, lastFight: now },
    coolMs,
  };
}
