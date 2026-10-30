import test from "node:test";
import assert from "node:assert/strict";
import {
  STATES,
  PRESET_NAMES,
  PRESETS,
  DEFAULT_CONFIG,
  defaultConfig,
  resolveIcons,
  iconFor,
  knownIcons,
  parseConfig,
} from "../lib/icons.js";

const NERD = { working: "\uF110", blocked: "\uF059", done: "\uF00C" };

test("PRESET_NAMES lists presets in cycle order and ask is the default preset", () => {
  assert.deepEqual([...PRESET_NAMES], ["ask", "symbols", "emoji", "nerd", "custom"]);
  assert.equal(DEFAULT_CONFIG.preset, "ask");
  assert.equal(defaultConfig().preset, "ask");
});

test("STATES lists the five agent states", () => {
  assert.deepEqual([...STATES], ["working", "blocked", "done", "idle", "unknown"]);
});

const presetTable = {
  ask: ["◐", "?", "✓"],
  symbols: ["◐", "×", "✓"],
  emoji: ["⏳", "❓", "✅"],
  nerd: [NERD.working, NERD.blocked, NERD.done],
  custom: ["", "", ""],
};
for (const [name, [working, blocked, done]] of Object.entries(presetTable)) {
  test(`preset ${name} has the documented icons and no icon for idle and unknown`, () => {
    assert.deepEqual({ ...PRESETS[name] }, { working, blocked, done, idle: "", unknown: "" });
  });
}

test("DEFAULT_CONFIG and PRESETS are deeply frozen", () => {
  assert.ok(Object.isFrozen(DEFAULT_CONFIG));
  assert.ok(Object.isFrozen(DEFAULT_CONFIG.icons));
  assert.ok(Object.isFrozen(DEFAULT_CONFIG.spinner));
  assert.ok(Object.isFrozen(DEFAULT_CONFIG.spinner.frames));
  assert.ok(Object.isFrozen(PRESETS));
  assert.ok(Object.isFrozen(PRESETS.ask));
});

test("DEFAULT_CONFIG has the documented values", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), {
    preset: "ask",
    icons: {},
    separator: " ",
    include_auto_named: false,
    spinner: { enabled: false, frames: ["◐", "◓", "◑", "◒"], interval_ms: 1000 },
  });
});

test("defaultConfig returns a fresh mutable copy that never touches DEFAULT_CONFIG", () => {
  const a = defaultConfig();
  a.icons.done = "X";
  a.spinner.frames.push("Z");
  a.spinner.enabled = true;
  const b = defaultConfig();
  assert.notEqual(a, b);
  assert.deepEqual(b.icons, {});
  assert.equal(b.spinner.frames.length, 4);
  assert.equal(DEFAULT_CONFIG.spinner.frames.length, 4);
  assert.equal(DEFAULT_CONFIG.spinner.enabled, false);
});

for (const name of PRESET_NAMES) {
  test(`iconFor under preset ${name} returns that preset's icon per state`, () => {
    for (const state of STATES) {
      assert.equal(iconFor(state, { preset: name, icons: {} }), PRESETS[name][state]);
    }
  });
}

test("iconFor returns an empty string for an unknown status", () => {
  assert.equal(iconFor("sleeping", defaultConfig()), "");
  assert.equal(iconFor(undefined, defaultConfig()), "");
  assert.equal(iconFor("", defaultConfig()), "");
});

test("custom preset takes icons only from config and has no icon for missing states", () => {
  const config = { preset: "custom", icons: { working: "W", done: "D" } };
  assert.equal(iconFor("working", config), "W");
  assert.equal(iconFor("done", config), "D");
  assert.equal(iconFor("blocked", config), "");
  assert.equal(iconFor("idle", config), "");
  assert.equal(iconFor("unknown", config), "");
});

test("a per-state override replaces only that state of the preset", () => {
  const config = { preset: "ask", icons: { done: "★" } };
  assert.equal(iconFor("done", config), "★");
  assert.equal(iconFor("working", config), "◐");
  assert.equal(iconFor("blocked", config), "?");
});

test("a per-state override of the empty string removes the icon", () => {
  const config = { preset: "ask", icons: { done: "" } };
  assert.equal(iconFor("done", config), "");
  assert.equal(resolveIcons(config).done, "");
  assert.equal(resolveIcons(config).working, "◐");
});

test("resolveIcons does not mutate the preset or the config", () => {
  const config = { preset: "ask", icons: { done: "X" } };
  resolveIcons(config);
  assert.equal(PRESETS.ask.done, "✓");
  assert.deepEqual(config, { preset: "ask", icons: { done: "X" } });
});

test("resolveIcons falls back to the custom preset for an unknown preset name", () => {
  assert.deepEqual(resolveIcons({ preset: "nope" }), { ...PRESETS.custom });
});

test("knownIcons is unique, has no empty strings and is sorted longest first", () => {
  const config = defaultConfig();
  config.icons = { working: "⏳", done: "ab", blocked: "abc" };
  config.spinner.frames = ["◐", "abcd"];
  const icons = knownIcons(config);
  assert.equal(new Set(icons).size, icons.length);
  assert.ok(icons.length > 0);
  assert.ok(icons.every((i) => typeof i === "string" && i !== ""));
  for (let i = 1; i < icons.length; i++) assert.ok(icons[i - 1].length >= icons[i].length);
  assert.equal(icons[0], "abcd");
});

test("knownIcons includes every preset icon, config icons and spinner frames", () => {
  const config = defaultConfig();
  config.icons = { working: "\u{1F9D1}\u200D\u{1F4BB}" };
  config.spinner.frames = ["a1", "b2"];
  const icons = knownIcons(config);
  for (const preset of Object.values(PRESETS)) {
    for (const icon of Object.values(preset)) if (icon) assert.ok(icons.includes(icon), icon);
  }
  for (const icon of ["\u{1F9D1}\u200D\u{1F4BB}", "a1", "b2", "◓", "◑", "◒"]) {
    assert.ok(icons.includes(icon), icon);
  }
});

test("knownIcons includes the nerd glyphs", () => {
  const icons = knownIcons(defaultConfig());
  for (const glyph of Object.values(NERD)) assert.ok(icons.includes(glyph));
});

test("knownIcons tolerates a config without icons or spinner", () => {
  assert.ok(knownIcons({}).includes("?"));
});

test("parseConfig(undefined) returns the defaults and no error", () => {
  const { config, error } = parseConfig(undefined);
  assert.equal(error, null);
  assert.deepEqual(config, defaultConfig());
});

test("parseConfig of an empty object returns the defaults", () => {
  const { config, error } = parseConfig("{}");
  assert.equal(error, null);
  assert.deepEqual(config, defaultConfig());
});

test("parseConfig merges a partial config over the defaults", () => {
  const { config, error } = parseConfig(
    JSON.stringify({
      preset: "emoji",
      icons: { done: "★" },
      separator: " | ",
      spinner: { enabled: true, interval_ms: 2500 },
      unknown_key: 1,
    }),
  );
  assert.equal(error, null);
  assert.equal(config.preset, "emoji");
  assert.deepEqual(config.icons, { done: "★" });
  assert.equal(config.separator, " | ");
  assert.equal(config.include_auto_named, false);
  assert.equal(config.spinner.enabled, true);
  assert.equal(config.spinner.interval_ms, 2500);
  assert.deepEqual(config.spinner.frames, ["◐", "◓", "◑", "◒"]);
});

test("parseConfig accepts an already-parsed object", () => {
  const { config, error } = parseConfig({ preset: "nerd", include_auto_named: true });
  assert.equal(error, null);
  assert.equal(config.preset, "nerd");
  assert.equal(config.include_auto_named, true);
});

test("parseConfig accepts custom spinner frames and interval_ms of exactly 1000", () => {
  const { config, error } = parseConfig({ spinner: { frames: ["a", "b"], interval_ms: 1000 } });
  assert.equal(error, null);
  assert.deepEqual(config.spinner.frames, ["a", "b"]);
});

test("parseConfig returns a fresh object that can be mutated without touching DEFAULT_CONFIG", () => {
  const { config } = parseConfig({});
  assert.notEqual(config, DEFAULT_CONFIG);
  config.icons.done = "X";
  config.spinner.frames.push("Z");
  config.preset = "emoji";
  assert.deepEqual(DEFAULT_CONFIG.icons, {});
  assert.equal(DEFAULT_CONFIG.spinner.frames.length, 4);
  assert.equal(DEFAULT_CONFIG.preset, "ask");
});

test("parseConfig does not alias the caller's frames array", () => {
  const frames = ["a", "b"];
  const { config } = parseConfig({ spinner: { frames } });
  config.spinner.frames.push("c");
  assert.deepEqual(frames, ["a", "b"]);
});

const invalidCases = [
  ["bad JSON", "{not json", /JSON/],
  ["an array", "[]", /object/],
  ["null as text", "null", /object/],
  ["a null value", null, /object/],
  ["a number", 5, /object/],
  ["an unknown preset", { preset: "fancy" }, /preset/],
  ["a non-string preset", { preset: 3 }, /preset/],
  ["icons that is an array", { icons: [] }, /icons/],
  ["a non-string icon", { icons: { done: 1 } }, /icons\.done/],
  ["an unknown icon state", { icons: { sleeping: "z" } }, /icons.*sleeping/],
  ["a non-string separator", { separator: 5 }, /separator/],
  ["a non-boolean include_auto_named", { include_auto_named: "yes" }, /include_auto_named/],
  ["a non-object spinner", { spinner: true }, /spinner/],
  ["a non-boolean spinner.enabled", { spinner: { enabled: 1 } }, /spinner\.enabled/],
  ["spinner.interval_ms below 1000", { spinner: { interval_ms: 999 } }, /spinner\.interval_ms/],
  ["a non-number spinner.interval_ms", { spinner: { interval_ms: "2000" } }, /spinner\.interval_ms/],
  ["a non-finite spinner.interval_ms", { spinner: { interval_ms: Infinity } }, /spinner\.interval_ms/],
  ["empty spinner.frames", { spinner: { frames: [] } }, /spinner\.frames/],
  ["spinner.frames with an empty string", { spinner: { frames: ["a", ""] } }, /spinner\.frames/],
  ["spinner.frames with a non-string", { spinner: { frames: ["a", 2] } }, /spinner\.frames/],
];
for (const [name, input, pattern] of invalidCases) {
  test(`parseConfig with ${name} keeps the last good config and names the problem`, () => {
    const lastGood = parseConfig({ preset: "emoji" }).config;
    const result = parseConfig(input, lastGood);
    assert.equal(result.config, lastGood);
    assert.equal(typeof result.error, "string");
    assert.ok(result.error.length > 0);
    assert.ok(!result.error.includes("\n"));
    assert.match(result.error, pattern);
  });

  test(`parseConfig with ${name} and no last good config falls back to the defaults`, () => {
    const result = parseConfig(input);
    assert.deepEqual(result.config, defaultConfig());
    assert.ok(result.error);
  });
}

test("parseConfig does not return a partially merged config on error", () => {
  const lastGood = defaultConfig();
  const result = parseConfig({ preset: "emoji", separator: 5 }, lastGood);
  assert.equal(result.config, lastGood);
  assert.equal(result.config.preset, "ask");
});

test("parseConfig returns lastGood without throwing on hostile parsed input", () => {
  const lastGood = defaultConfig();
  const inputs = [{ preset: 1n }, { get preset() { throw new Error("boom"); } }];
  for (const input of inputs) {
    const result = parseConfig(input, lastGood);
    assert.equal(result.config, lastGood);
    assert.ok(result.error);
  }
});
