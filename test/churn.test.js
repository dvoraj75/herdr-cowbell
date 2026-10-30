import test from "node:test";
import assert from "node:assert/strict";
import { CHURN_DEFAULTS, isCooling, noteFight } from "../lib/churn.js";

/**
 * Note one fight at each of `times`, threading the record through.
 * @returns {{record: object, coolMs: (number | null)[]}}
 */
function fightsAt(times, options, start = null) {
  let record = start;
  const coolMs = [];
  for (const now of times) {
    const result = noteFight(record, now, options);
    record = result.record;
    coolMs.push(result.coolMs);
  }
  return { record, coolMs };
}

test("defaults: 3 fights in 2 min, each within 30 s of ours, 60 s doubling up to 15 min, strikes forgotten after an hour", () => {
  assert.deepEqual(CHURN_DEFAULTS, {
    limit: 3,
    followMs: 30000,
    windowMs: 120000,
    coolMs: 60000,
    maxCoolMs: 900000,
    quietMs: 3600000,
  });
  assert.equal(Object.isFrozen(CHURN_DEFAULTS), true);
});

test("the third fight within the window starts a 60 s cool-down", () => {
  const { record, coolMs } = fightsAt([1000, 1100, 1200]);
  assert.deepEqual(coolMs, [null, null, 60000]);
  assert.deepEqual(record, { fights: [], strikes: 1, coolUntil: 61200, lastFight: 1200 });
});

test("a missing record counts as a fresh one", () => {
  assert.deepEqual(noteFight(undefined, 5).record, { fights: [5], strikes: 0, coolUntil: null, lastFight: 5 });
  assert.deepEqual(noteFight(null, 5).coolMs, null);
});

test("fights further apart than half the window never start a cool-down", () => {
  const { record, coolMs } = fightsAt([0, 60000, 120000, 180000, 240000]);
  assert.deepEqual(coolMs, [null, null, null, null, null]);
  assert.deepEqual(record.fights, [180000, 240000]);
  assert.equal(record.strikes, 0);
});

test("only fights inside the window count towards the limit", () => {
  // 0 has left the window by 120500, so 120500 is only the second recent fight.
  const { coolMs } = fightsAt([0, 100000, 120500, 121000]);
  assert.deepEqual(coolMs, [null, null, null, 60000]);
});

test("window boundary: a fight exactly windowMs old no longer counts, one just younger does", () => {
  assert.deepEqual(fightsAt([0, 60000, 120000]).coolMs, [null, null, null]);
  assert.deepEqual(fightsAt([0, 60000, 119999]).coolMs, [null, null, 60000]);
});

test("fights one followMs apart, a renamer answering just inside followMs, still add up to a cool-down", () => {
  const step = CHURN_DEFAULTS.followMs + 100; // its answer plus our debounce
  assert.deepEqual(fightsAt([0, step, 2 * step]).coolMs, [null, null, 60000]);
});

test("isCooling is true until coolUntil and false for no record", () => {
  const { record } = fightsAt([0, 1, 2]);
  assert.equal(isCooling(record, 2), true);
  assert.equal(isCooling(record, 60001), true);
  assert.equal(isCooling(record, 60002), false);
  assert.equal(isCooling(null, 0), false);
  assert.equal(isCooling(undefined, 0), false);
  assert.equal(isCooling({ fights: [], strikes: 0, coolUntil: null, lastFight: null }, 0), false);
});

test("a fight while cooling changes nothing", () => {
  const { record } = fightsAt([0, 1, 2]);
  const result = noteFight(record, 30000);
  assert.equal(result.record, record);
  assert.equal(result.coolMs, null);
});

test("every further strike doubles the cool-down, capped at maxCoolMs", () => {
  let record = null;
  let now = 0;
  const lengths = [];
  for (let strike = 0; strike < 6; strike += 1) {
    const round = fightsAt([now, now + 1, now + 2], {}, record);
    record = round.record;
    lengths.push(round.coolMs[2]);
    now = record.coolUntil;
  }
  assert.deepEqual(lengths, [60000, 120000, 240000, 480000, 900000, 900000]);
});

test("strikes are forgotten after quietMs without a fight", () => {
  const first = fightsAt([0, 1, 2]).record;
  // Just under an hour after the last fight: still the second strike.
  const soon = fightsAt([3600001, 3600001, 3600001], {}, first);
  assert.equal(soon.coolMs[2], 120000);
  // An hour after the last fight: back to the first cool-down.
  const later = fightsAt([3600002, 3600003, 3600004], {}, first);
  assert.equal(later.coolMs[2], 60000);
  assert.equal(later.record.strikes, 1);
});

test("options override the defaults", () => {
  const options = { limit: 2, windowMs: 100, coolMs: 1000, maxCoolMs: 1500 };
  const { record, coolMs } = fightsAt([0, 50], options);
  assert.deepEqual(coolMs, [null, 1000]);
  const next = fightsAt([1050, 1100], options, record);
  assert.deepEqual(next.coolMs, [null, 1500]);
});

test("noteFight does not mutate the record it is given", () => {
  const record = { fights: [0, 1], strikes: 1, coolUntil: null, lastFight: 1 };
  const copy = structuredClone(record);
  noteFight(record, 2);
  assert.deepEqual(record, copy);
});
