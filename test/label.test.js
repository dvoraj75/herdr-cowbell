import test from "node:test";
import assert from "node:assert/strict";
import { PRESETS, PRESET_NAMES, knownIcons, defaultConfig, parseConfig } from "../lib/icons.js";
import { strip, compose, isAutoNamed, decide, pruneState } from "../lib/label.js";

const ICONS = knownIcons(defaultConfig());
const VS16 = "\uFE0F";
const ZWJ_ICON = "\u{1F9D1}\u200D\u{1F4BB}";

function cfg(over) {
  const result = parseConfig(over || {});
  assert.equal(result.error, null);
  return result.config;
}

function tab(label, number, status) {
  return { label, number, agent_status: status };
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

test("isAutoNamed is true for the bare number and for the number behind an icon", () => {
  assert.equal(isAutoNamed(tab("2", 2, "idle"), ICONS), true);
  assert.equal(isAutoNamed(tab("◐ 2", 2, "working"), ICONS), true);
});

test("isAutoNamed is false for a custom name or a different number", () => {
  assert.equal(isAutoNamed(tab("x", 2, "idle"), ICONS), false);
  assert.equal(isAutoNamed(tab("◐ x", 2, "working"), ICONS), false);
  assert.equal(isAutoNamed(tab("3", 2, "idle"), ICONS), false);
});

// ---- decide ----

test("decide on first sight of a plain tab renames it to icon plus name", () => {
  const d = decide(tab("foo", 1, "working"), undefined, cfg());
  assert.deepEqual(d, {
    action: "rename",
    label: "◐ foo",
    entry: { base: "foo", lastWritten: "◐ foo", autoNamed: false },
  });
});

test("decide accepts null as the previous entry", () => {
  assert.equal(decide(tab("foo", 1, "working"), null, cfg()).label, "◐ foo");
});

test("decide uses the icon of the tab's status under the configured preset", () => {
  const config = cfg({ preset: "emoji" });
  assert.equal(decide(tab("foo", 1, "blocked"), undefined, config).label, "❓ foo");
  assert.equal(decide(tab("foo", 1, "done"), undefined, config).label, "✅ foo");
});

test("decide keeps the label when it is already right", () => {
  const prev = { base: "foo", lastWritten: "◐ foo", autoNamed: false };
  const d = decide(tab("◐ foo", 1, "working"), prev, cfg());
  assert.equal(d.action, "keep");
  assert.equal(d.label, "◐ foo");
  assert.deepEqual(d.entry, prev);
});

test("decide keeps a first-seen label that is already right", () => {
  const d = decide(tab("◐ foo", 1, "working"), undefined, cfg());
  assert.equal(d.action, "keep");
  assert.equal(d.entry.base, "foo");
});

test("decide on first sight of a stale icon label takes the stripped name as base", () => {
  const d = decide(tab("◐ foo", 1, "idle"), undefined, cfg());
  assert.equal(d.entry.base, "foo");
  assert.equal(d.label, "foo");
  assert.equal(d.action, "rename");
});

test("decide changes the icon when the status changes", () => {
  const prev = { base: "foo", lastWritten: "◐ foo", autoNamed: false };
  const d = decide(tab("◐ foo", 1, "done"), prev, cfg());
  assert.equal(d.action, "rename");
  assert.equal(d.label, "✓ foo");
  assert.deepEqual(d.entry, { base: "foo", lastWritten: "✓ foo", autoNamed: false });
});

test("decide removes the icon when the state has no icon (idle)", () => {
  const prev = { base: "foo", lastWritten: "◐ foo", autoNamed: false };
  const d = decide(tab("◐ foo", 1, "idle"), prev, cfg());
  assert.equal(d.action, "rename");
  assert.equal(d.label, "foo");
  assert.equal(d.entry.lastWritten, "foo");
});

test("decide keeps an idle tab that already has no icon", () => {
  const prev = { base: "foo", lastWritten: "foo", autoNamed: false };
  assert.equal(decide(tab("foo", 1, "idle"), prev, cfg()).action, "keep");
});

test("decide treats a user rename while an icon is shown as the new base (icon kept)", () => {
  const prev = { base: "grundza", lastWritten: "◐ grundza", autoNamed: false };
  const d = decide(tab("◐ newname", 1, "working"), prev, cfg());
  assert.equal(d.entry.base, "newname");
  assert.equal(d.entry.autoNamed, false);
  assert.equal(d.action, "keep");
  assert.equal(d.label, "◐ newname");
});

test("decide treats a user rename while an icon is shown as the new base (icon dropped)", () => {
  const prev = { base: "grundza", lastWritten: "◐ grundza", autoNamed: false };
  const d = decide(tab("newname", 1, "working"), prev, cfg());
  assert.equal(d.entry.base, "newname");
  assert.equal(d.action, "rename");
  assert.equal(d.label, "◐ newname");
  assert.equal(d.entry.lastWritten, "◐ newname");
});

test("decide suppresses the echo of its own write even when strip would give another name", () => {
  // The user really named the tab "? foo"; with the idle state no icon is written.
  const prev = { base: "? foo", lastWritten: "? foo", autoNamed: false };
  const d = decide(tab("? foo", 1, "idle"), prev, cfg());
  assert.equal(d.action, "keep");
  assert.equal(d.entry.base, "? foo");
  assert.equal(d.label, "? foo");
});

test("decide keeps the base of an echo while the status changes", () => {
  const prev = { base: "? foo", lastWritten: "? foo", autoNamed: false };
  const d = decide(tab("? foo", 1, "working"), prev, cfg());
  assert.equal(d.entry.base, "? foo");
  assert.equal(d.label, "◐ ? foo");
});

test("decide makes an auto-named tab follow herdr's renumbering", () => {
  const prev = { base: "2", lastWritten: "◐ 2", autoNamed: true };
  const d = decide(tab("◐ 2", 3, "working"), prev, cfg());
  assert.equal(d.action, "rename");
  assert.equal(d.label, "◐ 3");
  assert.deepEqual(d.entry, { base: "3", lastWritten: "◐ 3", autoNamed: true });
});

test("decide follows an untouched idle auto-named tab whose herdr label changed from 2 to 1", () => {
  const prev = { base: "2", lastWritten: "2", autoNamed: true };
  const d = decide(tab("1", 1, "idle"), prev, cfg());
  assert.equal(d.action, "keep");
  assert.deepEqual(d.entry, { base: "1", lastWritten: "1", autoNamed: true });
});

test("decide renumbers an idle auto-named tab whose label is still the old echo", () => {
  const prev = { base: "2", lastWritten: "2", autoNamed: true };
  const d = decide(tab("2", 1, "idle"), prev, cfg());
  assert.equal(d.action, "rename");
  assert.equal(d.label, "1");
  assert.equal(d.entry.autoNamed, true);
});

test("decide turns an auto-named tab renamed by the user into a custom one", () => {
  const prev = { base: "2", lastWritten: "◐ 2", autoNamed: true };
  const first = decide(tab("◐ work", 2, "working"), prev, cfg());
  assert.equal(first.entry.autoNamed, false);
  assert.equal(first.entry.base, "work");
  assert.equal(first.action, "keep");

  const later = decide(tab("◐ work", 5, "working"), first.entry, cfg());
  assert.equal(later.action, "keep");
  assert.equal(later.entry.base, "work");
  assert.equal(later.entry.autoNamed, false);
});

test("decide detects an auto-named tab on first sight, with or without a stale icon", () => {
  const plain = decide(tab("4", 4, "working"), undefined, cfg());
  assert.equal(plain.entry.autoNamed, true);
  assert.equal(plain.label, "◐ 4");
  const stale = decide(tab("◐ 4", 4, "idle"), undefined, cfg());
  assert.equal(stale.entry.autoNamed, true);
  assert.equal(stale.label, "4");
});

test("decide skips an auto-named tab when include_auto_named is false", () => {
  const config = cfg({ include_auto_named: false });
  const d = decide(tab("2", 2, "working"), undefined, config);
  assert.deepEqual(d, { action: "skip", label: "2", entry: null });
});

test("decide resets a stale icon to the bare number when include_auto_named is false", () => {
  const config = cfg({ include_auto_named: false });
  const prev = { base: "3", lastWritten: "\u25D0 3", autoNamed: true };
  const d = decide(tab("\u25D0 3", 3, "done"), prev, config);
  assert.deepEqual(d, {
    action: "rename",
    label: "3",
    entry: { base: "3", lastWritten: "3", autoNamed: true },
  });
  const next = decide(tab("3", 3, "done"), d.entry, config);
  assert.deepEqual(next, {
    action: "skip",
    label: "3",
    entry: { base: "3", lastWritten: "3", autoNamed: true },
  });
});

test("decide keeps an untracked bare-number tab untracked when include_auto_named is false", () => {
  const config = cfg({ include_auto_named: false });
  const d = decide(tab("3", 3, "done"), null, config);
  assert.deepEqual(d, { action: "skip", label: "3", entry: null });
});

test("decide follows renumbering after a reset when include_auto_named is false", () => {
  const config = cfg({ include_auto_named: false });
  const prev = { base: "3", lastWritten: "\u25D0 3", autoNamed: true };
  const first = decide(tab("\u25D0 3", 3, "done"), prev, config);
  assert.equal(first.action, "rename");
  assert.equal(first.label, "3");
  assert.notEqual(first.entry, null);
  const second = decide(tab("3", 2, "working"), first.entry, config);
  assert.equal(second.action, "rename");
  assert.equal(second.label, "2");
  assert.deepEqual(second.entry, { base: "2", lastWritten: "2", autoNamed: true });
  const third = decide(tab("2", 2, "working"), second.entry, config);
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
    const d = decide(tab(label, 1, "working"), null, config);
    action = d.action;
    label = d.label;
    if (action === "keep") break;
  }
  assert.equal(action, "keep");
});

test("decide still renames a custom-named tab when include_auto_named is false", () => {
  const config = cfg({ include_auto_named: false });
  const d = decide(tab("foo", 2, "working"), undefined, config);
  assert.equal(d.action, "rename");
  assert.equal(d.label, "◐ foo");
});

test("decide with a custom preset writes only configured icons", () => {
  const config = cfg({ preset: "custom", icons: { working: "W" } });
  assert.equal(decide(tab("foo", 1, "working"), undefined, config).label, "W foo");
  const none = decide(tab("foo", 1, "blocked"), undefined, config);
  assert.equal(none.label, "foo");
  assert.equal(none.action, "keep");
});

test("decide applies a per-state override and an empty override removes the icon", () => {
  const config = cfg({ icons: { done: "★", blocked: "" } });
  assert.equal(decide(tab("foo", 1, "done"), undefined, config).label, "★ foo");
  assert.equal(decide(tab("foo", 1, "blocked"), undefined, config).label, "foo");
});

test("decide strips icons of a previous preset after the user switched presets", () => {
  const prev = { base: "foo", lastWritten: "◐ foo", autoNamed: false };
  const d = decide(tab("⏳ foo", 1, "working"), prev, cfg({ preset: "emoji" }));
  assert.equal(d.entry.base, "foo");
  assert.equal(d.action, "keep");
});

test("decide strips custom spinner frames from a foreign-renamed label", () => {
  const config = cfg({ spinner: { frames: ["a1", "b2"] } });
  const d = decide(tab("b2 foo", 1, "idle"), undefined, config);
  assert.equal(d.entry.base, "foo");
  assert.equal(d.label, "foo");
});

test("decide honours a custom separator", () => {
  const config = cfg({ separator: " | " });
  const d = decide(tab("foo", 1, "working"), undefined, config);
  assert.equal(d.label, "◐ | foo");
  const again = decide(tab("◐ | foo", 1, "working"), d.entry, config);
  assert.equal(again.action, "keep");
});

test("decide handles emoji with a variation selector the server might add", () => {
  const config = cfg({ preset: "emoji" });
  const d = decide(tab(`⏳${VS16} foo`, 1, "working"), undefined, config);
  assert.equal(d.entry.base, "foo");
});

test("decide does not mutate tab, prev or config", () => {
  const t = deepFreeze(tab("◐ grundza", 3, "done"));
  const prev = deepFreeze({ base: "2", lastWritten: "◐ 2", autoNamed: true });
  const config = deepFreeze(cfg({ icons: { done: "★" } }));
  const snapshot = JSON.stringify([t, prev, config]);
  decide(t, prev, config);
  decide(t, undefined, config);
  assert.equal(JSON.stringify([t, prev, config]), snapshot);
});

test("decide returns a new entry object, not the previous one", () => {
  const prev = { base: "foo", lastWritten: "◐ foo", autoNamed: false };
  const d = decide(tab("◐ foo", 1, "working"), prev, cfg());
  assert.notEqual(d.entry, prev);
});

test("decide reaches a fixed point: a second pass over its own write is a keep", () => {
  const config = cfg();
  for (const status of ["working", "blocked", "done", "idle", "unknown"]) {
    for (const [label, number] of [["foo", 1], ["3", 3], ["? x", 1]]) {
      const first = decide(tab(label, number, status), undefined, config);
      const second = decide(tab(first.label, number, status), first.entry, config);
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
