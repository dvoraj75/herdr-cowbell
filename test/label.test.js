import test from "node:test";
import assert from "node:assert/strict";
import { PRESETS, PRESET_NAMES, knownIcons, defaultConfig, parseConfig } from "../lib/icons.js";
import { strip, compose, isAutoNamed, positions, decide, renamed, pruneState } from "../lib/label.js";

const ICONS = knownIcons(defaultConfig());
const VS16 = "\uFE0F";
const ZWJ_ICON = "\u{1F9D1}\u200D\u{1F4BB}";

function cfg(over) {
  const result = parseConfig(over || {});
  assert.equal(result.error, null);
  return result.config;
}

// include_auto_named is off by default; tests about auto-named tabs opt in.
const AUTO = { include_auto_named: true };

function tab(label, status) {
  return { label, agent_status: status };
}

function at(position) {
  return { position };
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// ---- strip ----

test("strip removes the working, blocked and done icon of every preset", () => {
  for (const name of PRESET_NAMES) {
    for (const state of ["working", "blocked", "done"]) {
      const icon = PRESETS[name][state];
      if (!icon) continue;
      assert.equal(strip(`${icon} grundza`, ICONS), "grundza", `${name}.${state}`);
    }
  }
});

test("strip removes repeated icons", () => {
  assert.equal(strip("? ? grundza", ICONS), "grundza");
  assert.equal(strip("✓ ◐ x", ICONS), "x");
  assert.equal(strip("◐ ⏳ ✅ x", ICONS), "x");
});

test("strip leaves a plain label alone", () => {
  assert.equal(strip("grundza", ICONS), "grundza");
  assert.equal(strip("", ICONS), "");
});

test("strip of an icon-only label gives an empty base", () => {
  assert.equal(strip("◐ ", ICONS), "");
  assert.equal(strip("◐", ICONS), "");
  assert.equal(strip("? ? ", ICONS), "");
});

for (const icon of ["⏳", "❓", "✅"]) {
  const code = icon.codePointAt(0).toString(16);
  test(`strip removes emoji ${code} with or without a trailing variation selector in the label`, () => {
    assert.equal(strip(`${icon} foo`, ICONS), "foo");
    assert.equal(strip(`${icon}${VS16} foo`, ICONS), "foo");
    assert.equal(strip(`${icon}${VS16}`, ICONS), "");
  });

  test(`strip removes emoji ${code} when the known icon carries the variation selector`, () => {
    assert.equal(strip(`${icon} foo`, [`${icon}${VS16}`]), "foo");
    assert.equal(strip(`${icon}${VS16} foo`, [`${icon}${VS16}`]), "foo");
  });

  test(`compose uses emoji ${code} with or without a variation selector in the icon`, () => {
    assert.equal(compose("foo", icon), `${icon} foo`);
    assert.equal(compose("foo", `${icon}${VS16}`), `${icon}${VS16} foo`);
    assert.equal(strip(compose("foo", `${icon}${VS16}`), ICONS), "foo");
  });
}

test("strip removes spinner frames, default and custom", () => {
  for (const frame of ["◐", "◓", "◑", "◒"]) {
    assert.equal(strip(`${frame} foo`, knownIcons(defaultConfig())), "foo");
  }
  const config = cfg({ spinner: { frames: ["|", "/", "-", "\\"] } });
  const icons = knownIcons(config);
  assert.equal(strip("/ foo", icons), "foo");
  assert.equal(strip("\\ foo", icons), "foo");
});

test("strip removes nerd font glyphs", () => {
  for (const glyph of ["\uF110", "\uF059", "\uF00C"]) {
    assert.equal(strip(`${glyph} foo`, ICONS), "foo");
  }
});

test("strip removes a ZWJ sequence icon as a whole", () => {
  const icons = knownIcons(cfg({ icons: { working: ZWJ_ICON } }));
  assert.equal(strip(`${ZWJ_ICON} foo`, icons), "foo");
  assert.equal(strip(`${ZWJ_ICON}${VS16} foo`, icons), "foo");
});

test("strip prefers the longer icon when one icon is a prefix of another", () => {
  assert.equal(strip(`${ZWJ_ICON} foo`, ["\u{1F9D1}", ZWJ_ICON]), "foo");
});

test("strip does not remove an icon that is not followed by the separator", () => {
  assert.equal(strip("?x", ICONS), "?x");
  assert.equal(strip("✓done", ICONS), "✓done");
  assert.equal(strip("◐foo", ICONS), "◐foo");
});

test("strip does not touch an icon in the middle of the label", () => {
  assert.equal(strip("foo ◐", ICONS), "foo ◐");
  assert.equal(strip("foo ◐ bar", ICONS), "foo ◐ bar");
});

test("strip honours a custom separator", () => {
  assert.equal(strip("◐ | foo", ICONS, " | "), "foo");
  assert.equal(strip("? | ✓ | foo", ICONS, " | "), "foo");
  assert.equal(strip("◐ foo", ICONS, " | "), "◐ foo");
});

test("strip with an empty separator removes the icon directly before the name", () => {
  assert.equal(strip("◐foo", ICONS, ""), "foo");
  assert.equal(strip("◐", ICONS, ""), "");
});

test("strip does not mutate the icon array", () => {
  const icons = ["a", "bcd", "⏳" + VS16, "bc"];
  const copy = icons.slice();
  strip("bcd a foo", icons);
  assert.deepEqual(icons, copy);
  const frozen = Object.freeze(icons.slice());
  assert.equal(strip("a foo", frozen), "foo");
});

test("strip of a non-string label gives an empty string", () => {
  for (const value of [undefined, null, 5, {}, []]) assert.equal(strip(value, ICONS), "");
});

test("strip ignores empty icons", () => {
  assert.equal(strip("foo", ["", "x"]), "foo");
  assert.equal(strip(" foo", [""]), " foo");
});

test("strip is idempotent", () => {
  const labels = [
    "", " ", "foo", "? ? foo", "◐", "◐ ", "◐ ◐", "?x", "✓ ◐ x",
    "⏳ foo", `⏳${VS16} foo`, `⏳${VS16}`, "\uF110 foo", `${ZWJ_ICON} foo`,
    "foo ◐", "1", "◐ 2", "? ", "?  foo", "✅✅ foo",
  ];
  const icons = knownIcons(cfg({ icons: { idle: ZWJ_ICON } }));
  for (const separator of [" ", " | ", ""]) {
    for (const label of labels) {
      const once = strip(label, icons, separator);
      assert.equal(strip(once, icons, separator), once, JSON.stringify([label, separator]));
    }
  }
});

// ---- compose ----

test("compose joins icon, separator and base", () => {
  assert.equal(compose("foo", "◐"), "◐ foo");
  assert.equal(compose("foo", "◐", " | "), "◐ | foo");
  assert.equal(compose("foo", "◐", ""), "◐foo");
});

test("compose with no icon returns the base", () => {
  assert.equal(compose("foo", ""), "foo");
});

test("compose with an empty base returns just the icon without a separator", () => {
  assert.equal(compose("", "◐"), "◐");
});

test("compose with an empty base and no icon returns an empty string", () => {
  assert.equal(compose("", ""), "");
});

test("compose then strip round-trips a name", () => {
  for (const base of ["foo", "a b", "2", "x ◐"]) {
    for (const icon of ["◐", "⏳", "\uF110"]) {
      assert.equal(strip(compose(base, icon), ICONS), base);
    }
  }
  assert.equal(strip(compose("", "◐"), ICONS), "");
});

// ---- isAutoNamed ----

test("isAutoNamed is true for the bare position and for the position behind an icon", () => {
  assert.equal(isAutoNamed("2", 2, ICONS), true);
  assert.equal(isAutoNamed("◐ 2", 2, ICONS), true);
  assert.equal(isAutoNamed("◐ | 2", 2, ICONS, " | "), true);
});

test("isAutoNamed is false for a custom name or a different position", () => {
  assert.equal(isAutoNamed("x", 2, ICONS), false);
  assert.equal(isAutoNamed("◐ x", 2, ICONS), false);
  assert.equal(isAutoNamed("3", 2, ICONS), false);
});

// ---- positions ----

test("positions numbers the tabs of one workspace from 1 in list order", () => {
  const result = positions([
    { tab_id: "w1:t4", workspace_id: "w1" },
    { tab_id: "w1:t1", workspace_id: "w1" },
    { tab_id: "w1:t2", workspace_id: "w1" },
  ]);
  assert.deepEqual([...result], [["w1:t4", 1], ["w1:t1", 2], ["w1:t2", 3]]);
});

test("positions counts each workspace on its own, consecutive or interleaved", () => {
  const consecutive = positions([
    { tab_id: "w1:t1", workspace_id: "w1" },
    { tab_id: "w1:t3", workspace_id: "w1" },
    { tab_id: "w2:t1", workspace_id: "w2" },
    { tab_id: "w2:t2", workspace_id: "w2" },
  ]);
  assert.deepEqual(Object.fromEntries(consecutive), {
    "w1:t1": 1,
    "w1:t3": 2,
    "w2:t1": 1,
    "w2:t2": 2,
  });
  const interleaved = positions([
    { tab_id: "w1:t1", workspace_id: "w1" },
    { tab_id: "w2:t5", workspace_id: "w2" },
    { tab_id: "w1:t3", workspace_id: "w1" },
    { tab_id: "w2:t2", workspace_id: "w2" },
  ]);
  assert.deepEqual(Object.fromEntries(interleaved), {
    "w1:t1": 1,
    "w2:t5": 1,
    "w1:t3": 2,
    "w2:t2": 2,
  });
});

test("positions of an empty or missing list is an empty map", () => {
  assert.equal(positions([]).size, 0);
  assert.equal(positions(undefined).size, 0);
});

// ---- renamed ----

test("renamed takes the foreign label without icons as a custom base and keeps lastWritten", () => {
  const prev = { base: "foo", lastWritten: "◐ foo", autoNamed: false };
  assert.deepEqual(renamed(prev, "◐ bar", cfg()), {
    base: "bar",
    lastWritten: "◐ foo",
    autoNamed: false,
  });
  assert.deepEqual(renamed(prev, "bar", cfg()).base, "bar");
});

test("renamed turns an auto-named entry into a custom one", () => {
  const prev = { base: "2", lastWritten: "◐ 2", autoNamed: true };
  assert.deepEqual(renamed(prev, "work", cfg(AUTO)), {
    base: "work",
    lastWritten: "◐ 2",
    autoNamed: false,
  });
});

test("renamed honours a custom separator", () => {
  const prev = { base: "foo", lastWritten: "◐ | foo", autoNamed: false };
  assert.equal(renamed(prev, "✓ | bar", cfg({ separator: " | " })).base, "bar");
});

test("renamed of an untracked tab is null", () => {
  assert.equal(renamed(undefined, "bar", cfg()), null);
  assert.equal(renamed(null, "bar", cfg()), null);
});

test("renamed does not mutate prev", () => {
  const prev = deepFreeze({ base: "foo", lastWritten: "◐ foo", autoNamed: false });
  const next = renamed(prev, "bar", cfg());
  assert.notEqual(next, prev);
  assert.deepEqual(prev, { base: "foo", lastWritten: "◐ foo", autoNamed: false });
});

test("an in-flight rename landing after a foreign one re-applies the icon on the new base", () => {
  // We wrote "◐ foo"; the user renamed to "bar"; then our older write landed again.
  const prev = { base: "foo", lastWritten: "◐ foo", autoNamed: false };
  const entry = renamed(prev, "bar", cfg());
  const d = decide(tab("◐ foo", "working"), entry, cfg(), at(1));
  assert.equal(d.action, "rename");
  assert.equal(d.label, "◐ bar");
  assert.deepEqual(d.entry, { base: "bar", lastWritten: "◐ bar", autoNamed: false });
});

test("a user rename to the position number stays custom after a move (include_auto_named on)", () => {
  const config = cfg(AUTO);
  // We wrote "◐ x" on the third tab; the user renamed it to "3".
  const prev = { base: "x", lastWritten: "◐ x", autoNamed: false };
  const entry = renamed(prev, "3", config);
  const first = decide(tab("3", "working"), entry, config, at(3));
  assert.equal(first.label, "◐ 3");
  assert.equal(first.entry.autoNamed, false);
  // Moved to the front: still the user's "3", not the new position.
  const moved = decide(tab(first.label, "working"), first.entry, config, at(1));
  assert.equal(moved.action, "keep");
  assert.deepEqual(moved.entry, { base: "3", lastWritten: "◐ 3", autoNamed: false });
});

test("a user rename to the position number stays custom after a move (include_auto_named off)", () => {
  const config = cfg({ include_auto_named: false });
  const prev = { base: "x", lastWritten: "◐ x", autoNamed: false };
  const entry = renamed(prev, "3", config);
  const first = decide(tab("3", "working"), entry, config, at(3));
  assert.equal(first.action, "rename");
  assert.equal(first.label, "◐ 3", "icons like any custom tab");
  assert.deepEqual(first.entry, { base: "3", lastWritten: "◐ 3", autoNamed: false });
  const moved = decide(tab(first.label, "working"), first.entry, config, at(1));
  assert.equal(moved.action, "keep");
  assert.equal(moved.label, "◐ 3");
});

test("an untouched tracked auto-named tab whose herdr label shifted still counts as auto", () => {
  const prev = { base: "3", lastWritten: "3", autoNamed: true };
  const d = decide(tab("2", "working"), prev, cfg(AUTO), at(2));
  assert.deepEqual(d, { action: "rename", label: "◐ 2", entry: { base: "2", lastWritten: "◐ 2", autoNamed: true } });
});

// ---- decide ----

test("decide on first sight of a plain tab renames it to icon plus name", () => {
  const d = decide(tab("foo", "working"), undefined, cfg(), at(1));
  assert.deepEqual(d, {
    action: "rename",
    label: "◐ foo",
    entry: { base: "foo", lastWritten: "◐ foo", autoNamed: false },
  });
});

test("decide accepts null as the previous entry", () => {
  assert.equal(decide(tab("foo", "working"), null, cfg(), at(1)).label, "◐ foo");
});

test("decide uses the icon of the tab's status under the configured preset", () => {
  const config = cfg({ preset: "emoji" });
  assert.equal(decide(tab("foo", "blocked"), undefined, config, at(1)).label, "❓ foo");
  assert.equal(decide(tab("foo", "done"), undefined, config, at(1)).label, "✅ foo");
});

test("decide keeps the label when it is already right", () => {
  const prev = { base: "foo", lastWritten: "◐ foo", autoNamed: false };
  const d = decide(tab("◐ foo", "working"), prev, cfg(), at(1));
  assert.equal(d.action, "keep");
  assert.equal(d.label, "◐ foo");
  assert.deepEqual(d.entry, prev);
});

test("decide keeps a first-seen label that is already right", () => {
  const d = decide(tab("◐ foo", "working"), undefined, cfg(), at(1));
  assert.equal(d.action, "keep");
  assert.equal(d.entry.base, "foo");
});

test("decide on first sight of a stale icon label takes the stripped name as base", () => {
  const d = decide(tab("◐ foo", "idle"), undefined, cfg(), at(1));
  assert.equal(d.entry.base, "foo");
  assert.equal(d.label, "foo");
  assert.equal(d.action, "rename");
});

test("decide changes the icon when the status changes", () => {
  const prev = { base: "foo", lastWritten: "◐ foo", autoNamed: false };
  const d = decide(tab("◐ foo", "done"), prev, cfg(), at(1));
  assert.equal(d.action, "rename");
  assert.equal(d.label, "✓ foo");
  assert.deepEqual(d.entry, { base: "foo", lastWritten: "✓ foo", autoNamed: false });
});

test("decide removes the icon when the state has no icon (idle)", () => {
  const prev = { base: "foo", lastWritten: "◐ foo", autoNamed: false };
  const d = decide(tab("◐ foo", "idle"), prev, cfg(), at(1));
  assert.equal(d.action, "rename");
  assert.equal(d.label, "foo");
  assert.equal(d.entry.lastWritten, "foo");
});

test("decide keeps an idle tab that already has no icon", () => {
  const prev = { base: "foo", lastWritten: "foo", autoNamed: false };
  assert.equal(decide(tab("foo", "idle"), prev, cfg(), at(1)).action, "keep");
});

test("decide treats a user rename while an icon is shown as the new base (icon kept)", () => {
  const prev = { base: "grundza", lastWritten: "◐ grundza", autoNamed: false };
  const d = decide(tab("◐ newname", "working"), prev, cfg(), at(1));
  assert.equal(d.entry.base, "newname");
  assert.equal(d.entry.autoNamed, false);
  assert.equal(d.action, "keep");
  assert.equal(d.label, "◐ newname");
});

test("decide treats a user rename while an icon is shown as the new base (icon dropped)", () => {
  const prev = { base: "grundza", lastWritten: "◐ grundza", autoNamed: false };
  const d = decide(tab("newname", "working"), prev, cfg(), at(1));
  assert.equal(d.entry.base, "newname");
  assert.equal(d.action, "rename");
  assert.equal(d.label, "◐ newname");
  assert.equal(d.entry.lastWritten, "◐ newname");
});

test("decide suppresses the echo of its own write even when strip would give another name", () => {
  // The user really named the tab "? foo"; with the idle state no icon is written.
  const prev = { base: "? foo", lastWritten: "? foo", autoNamed: false };
  const d = decide(tab("? foo", "idle"), prev, cfg(), at(1));
  assert.equal(d.action, "keep");
  assert.equal(d.entry.base, "? foo");
  assert.equal(d.label, "? foo");
});

test("decide keeps the base of an echo while the status changes", () => {
  const prev = { base: "? foo", lastWritten: "? foo", autoNamed: false };
  const d = decide(tab("? foo", "working"), prev, cfg(), at(1));
  assert.equal(d.entry.base, "? foo");
  assert.equal(d.label, "◐ ? foo");
});

test("decide makes a tracked auto-named tab follow a move through the echo path", () => {
  // We renamed it, so herdr keeps showing "◐ 2" although the tab is now third.
  const prev = { base: "2", lastWritten: "◐ 2", autoNamed: true };
  const d = decide(tab("◐ 2", "working"), prev, cfg(AUTO), at(3));
  assert.equal(d.action, "rename");
  assert.equal(d.label, "◐ 3");
  assert.deepEqual(d.entry, { base: "3", lastWritten: "◐ 3", autoNamed: true });
});

test("decide follows an untouched idle auto-named tab whose herdr label changed from 2 to 1", () => {
  const prev = { base: "2", lastWritten: "2", autoNamed: true };
  const d = decide(tab("1", "idle"), prev, cfg(AUTO), at(1));
  assert.equal(d.action, "keep");
  assert.deepEqual(d.entry, { base: "1", lastWritten: "1", autoNamed: true });
});

test("decide moves an idle auto-named tab whose label is still the old echo to its new position", () => {
  const prev = { base: "2", lastWritten: "2", autoNamed: true };
  const d = decide(tab("2", "idle"), prev, cfg(AUTO), at(1));
  assert.equal(d.action, "rename");
  assert.equal(d.label, "1");
  assert.equal(d.entry.autoNamed, true);
});

test("decide turns an auto-named tab renamed by the user into a custom one", () => {
  const prev = { base: "2", lastWritten: "◐ 2", autoNamed: true };
  const first = decide(tab("◐ work", "working"), prev, cfg(AUTO), at(2));
  assert.equal(first.entry.autoNamed, false);
  assert.equal(first.entry.base, "work");
  assert.equal(first.action, "keep");

  const later = decide(tab("◐ work", "working"), first.entry, cfg(AUTO), at(5));
  assert.equal(later.action, "keep");
  assert.equal(later.entry.base, "work");
  assert.equal(later.entry.autoNamed, false);
});

test("decide detects an auto-named tab on first sight, with or without a stale icon", () => {
  const plain = decide(tab("4", "working"), undefined, cfg(AUTO), at(4));
  assert.equal(plain.entry.autoNamed, true);
  assert.equal(plain.label, "◐ 4");
  const stale = decide(tab("◐ 4", "idle"), undefined, cfg(AUTO), at(4));
  assert.equal(stale.entry.autoNamed, true);
  assert.equal(stale.label, "4");
});

test("decide uses the position, never the tab number, for a moved tab", () => {
  // After tab.move herdr showed w1:t4 first: number 4, automatic label "1".
  const moved = { tab_id: "w1:t4", number: 4, label: "1", agent_status: "working" };
  const d = decide(moved, undefined, cfg(AUTO), at(1));
  assert.equal(d.entry.autoNamed, true);
  assert.equal(d.label, "◐ 1");
  const custom = { tab_id: "w1:t1", number: 1, label: "4", agent_status: "working" };
  const other = decide(custom, undefined, cfg(AUTO), at(2));
  assert.equal(other.entry.autoNamed, false);
  assert.equal(other.entry.base, "4");
});

test("decide follows a tracked auto-named tab through a close and a move by position", () => {
  const config = cfg(AUTO);
  // Third tab, working.
  const first = decide(tab("3", "working"), undefined, config, at(3));
  assert.equal(first.label, "◐ 3");
  // The first tab was closed: herdr still shows our "◐ 3", the tab is now second.
  const second = decide(tab(first.label, "working"), first.entry, config, at(2));
  assert.equal(second.label, "◐ 2");
  // Moved to the front and done.
  const third = decide(tab(second.label, "done"), second.entry, config, at(1));
  assert.equal(third.label, "✓ 1");
  assert.deepEqual(third.entry, { base: "1", lastWritten: "✓ 1", autoNamed: true });
});

test("decide leaves an untracked auto-named tab alone under the default config", () => {
  const d = decide(tab("2", "working"), undefined, cfg(), at(2));
  assert.deepEqual(d, { action: "skip", label: "2", entry: null });
});

test("decide skips an auto-named tab when include_auto_named is false", () => {
  const config = cfg({ include_auto_named: false });
  const d = decide(tab("2", "working"), undefined, config, at(2));
  assert.deepEqual(d, { action: "skip", label: "2", entry: null });
});

test("decide resets a stale icon to the bare position when include_auto_named is false", () => {
  const config = cfg({ include_auto_named: false });
  const prev = { base: "3", lastWritten: "\u25D0 3", autoNamed: true };
  const d = decide(tab("\u25D0 3", "done"), prev, config, at(3));
  assert.deepEqual(d, {
    action: "rename",
    label: "3",
    entry: { base: "3", lastWritten: "3", autoNamed: true },
  });
  const next = decide(tab("3", "done"), d.entry, config, at(3));
  assert.deepEqual(next, {
    action: "skip",
    label: "3",
    entry: { base: "3", lastWritten: "3", autoNamed: true },
  });
});

test("decide treats a stale custom entry with another base as auto-named (include_auto_named off)", () => {
  const stale = { base: "foo", lastWritten: "\u25D0 foo", autoNamed: false };
  const d = decide(tab("1", "working"), stale, cfg({ include_auto_named: false }), at(1));
  assert.equal(d.action, "skip");
  assert.equal(d.label, "1");
  assert.equal(d.entry.autoNamed, true);
});

test("decide treats a stale custom entry with another base as auto-named (include_auto_named on)", () => {
  const stale = { base: "foo", lastWritten: "\u25D0 foo", autoNamed: false };
  const d = decide(tab("1", "idle"), stale, cfg({ include_auto_named: true }), at(1));
  assert.equal(d.entry.base, "1");
  assert.equal(d.entry.autoNamed, true);
});

test("decide keeps an untracked bare-position tab untracked when include_auto_named is false", () => {
  const config = cfg({ include_auto_named: false });
  const d = decide(tab("3", "done"), null, config, at(3));
  assert.deepEqual(d, { action: "skip", label: "3", entry: null });
});

test("decide follows a move after a reset when include_auto_named is false", () => {
  const config = cfg({ include_auto_named: false });
  const prev = { base: "3", lastWritten: "\u25D0 3", autoNamed: true };
  const first = decide(tab("\u25D0 3", "done"), prev, config, at(3));
  assert.equal(first.action, "rename");
  assert.equal(first.label, "3");
  assert.notEqual(first.entry, null);
  const second = decide(tab("3", "working"), first.entry, config, at(2));
  assert.equal(second.action, "rename");
  assert.equal(second.label, "2");
  assert.deepEqual(second.entry, { base: "2", lastWritten: "2", autoNamed: true });
  const third = decide(tab("2", "working"), second.entry, config, at(2));
  assert.equal(third.action, "skip");
  assert.deepEqual(third.entry, second.entry);
});

test("strip removes an icon followed directly by a selector-like separator", () => {
  const sep = "\uFE0F";
  assert.equal(strip("\u25D0\uFE0Ffoo", ["\u25D0"], sep), "foo");
});

test("decide with a selector separator and no state reaches keep within 2 calls", () => {
  const config = cfg({ separator: "\uFE0F" });
  let label = "\u25D0\uFE0Ffoo";
  let action;
  for (let n = 0; n < 2; n++) {
    const d = decide(tab(label, "working"), null, config, at(1));
    action = d.action;
    label = d.label;
    if (action === "keep") break;
  }
  assert.equal(action, "keep");
});

test("decide still renames a custom-named tab when include_auto_named is false", () => {
  const config = cfg({ include_auto_named: false });
  const d = decide(tab("foo", "working"), undefined, config, at(2));
  assert.equal(d.action, "rename");
  assert.equal(d.label, "◐ foo");
});

test("decide with a custom preset writes only configured icons", () => {
  const config = cfg({ preset: "custom", icons: { working: "W" } });
  assert.equal(decide(tab("foo", "working"), undefined, config, at(1)).label, "W foo");
  const none = decide(tab("foo", "blocked"), undefined, config, at(1));
  assert.equal(none.label, "foo");
  assert.equal(none.action, "keep");
});

test("decide applies a per-state override and an empty override removes the icon", () => {
  const config = cfg({ icons: { done: "★", blocked: "" } });
  assert.equal(decide(tab("foo", "done"), undefined, config, at(1)).label, "★ foo");
  assert.equal(decide(tab("foo", "blocked"), undefined, config, at(1)).label, "foo");
});

test("decide strips icons of a previous preset after the user switched presets", () => {
  const prev = { base: "foo", lastWritten: "◐ foo", autoNamed: false };
  const d = decide(tab("⏳ foo", "working"), prev, cfg({ preset: "emoji" }), at(1));
  assert.equal(d.entry.base, "foo");
  assert.equal(d.action, "keep");
});

test("decide strips custom spinner frames from a foreign-renamed label", () => {
  const config = cfg({ spinner: { frames: ["a1", "b2"] } });
  const d = decide(tab("b2 foo", "idle"), undefined, config, at(1));
  assert.equal(d.entry.base, "foo");
  assert.equal(d.label, "foo");
});

test("decide honours a custom separator", () => {
  const config = cfg({ separator: " | " });
  const d = decide(tab("foo", "working"), undefined, config, at(1));
  assert.equal(d.label, "◐ | foo");
  const again = decide(tab("◐ | foo", "working"), d.entry, config, at(1));
  assert.equal(again.action, "keep");
});

test("decide handles emoji with a variation selector the server might add", () => {
  const config = cfg({ preset: "emoji" });
  const d = decide(tab(`⏳${VS16} foo`, "working"), undefined, config, at(1));
  assert.equal(d.entry.base, "foo");
});

test("decide does not mutate tab, prev or config", () => {
  const t = deepFreeze(tab("◐ grundza", "done"));
  const prev = deepFreeze({ base: "2", lastWritten: "◐ 2", autoNamed: true });
  const config = deepFreeze(cfg({ icons: { done: "★" } }));
  const snapshot = JSON.stringify([t, prev, config]);
  decide(t, prev, config, at(3));
  decide(t, undefined, config, at(3));
  assert.equal(JSON.stringify([t, prev, config]), snapshot);
});

test("decide returns a new entry object, not the previous one", () => {
  const prev = { base: "foo", lastWritten: "◐ foo", autoNamed: false };
  const d = decide(tab("◐ foo", "working"), prev, cfg(), at(1));
  assert.notEqual(d.entry, prev);
});

test("decide reaches a fixed point: a second pass over its own write is a keep", () => {
  const config = cfg(AUTO);
  for (const status of ["working", "blocked", "done", "idle", "unknown"]) {
    for (const [label, position] of [["foo", 1], ["3", 3], ["? x", 1]]) {
      const first = decide(tab(label, status), undefined, config, at(position));
      const second = decide(tab(first.label, status), first.entry, config, at(position));
      assert.equal(second.action, "keep", JSON.stringify([status, label]));
      assert.deepEqual(second.entry, first.entry);
    }
  }
});

// ---- pruneState ----

const STATE = {
  1: { base: "a", lastWritten: "a", autoNamed: false },
  2: { base: "b", lastWritten: "b", autoNamed: false },
  "w-3": { base: "c", lastWritten: "c", autoNamed: false },
};

test("pruneState keeps only live ids given as a Set", () => {
  const pruned = pruneState(STATE, new Set(["1", "w-3"]));
  assert.deepEqual(Object.keys(pruned).sort(), ["1", "w-3"]);
});

test("pruneState keeps only live ids given as an array", () => {
  assert.deepEqual(Object.keys(pruneState(STATE, ["2"])), ["2"]);
});

test("pruneState matches numeric ids against string keys", () => {
  assert.deepEqual(Object.keys(pruneState(STATE, [1, 2])).sort(), ["1", "2"]);
  assert.deepEqual(Object.keys(pruneState(STATE, new Set([2]))), ["2"]);
});

test("pruneState returns a new object and does not mutate the input", () => {
  const input = JSON.parse(JSON.stringify(STATE));
  const pruned = pruneState(input, ["1"]);
  assert.notEqual(pruned, input);
  assert.deepEqual(input, STATE);
  const all = pruneState(input, ["1", "2", "w-3"]);
  assert.notEqual(all, input);
  assert.deepEqual(all, STATE);
});

test("pruneState with no live ids or empty state gives an empty object", () => {
  assert.deepEqual(pruneState(STATE, []), {});
  assert.deepEqual(pruneState({}, ["1"]), {});
  assert.deepEqual(pruneState(undefined, ["1"]), {});
});
