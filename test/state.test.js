import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadState, saveState, loadConfig } from "../lib/state.js";
import { defaultConfig } from "../lib/icons.js";

/**
 * Run `body` with a fresh temp dir that is removed afterwards.
 * @param {(dir: string) => void} body
 */
function withTempDir(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-"));
  try {
    body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** @returns {{log: (message: string) => void, lines: string[]}} */
function recorder() {
  const lines = [];
  return { log: (message) => lines.push(message), lines };
}

const TABS = {
  "w1:t2": { base: "api", lastWritten: "◐ api", autoNamed: false },
  "w1:t3": { base: "3", lastWritten: "✓ 3", autoNamed: true },
};

test("saveState creates the dir, writes atomically and round-trips", () => {
  withTempDir((root) => {
    const dir = path.join(root, "nested", "state");
    saveState(dir, { tabs: TABS });
    assert.deepEqual(fs.readdirSync(dir), ["state.json"]);
    const text = fs.readFileSync(path.join(dir, "state.json"), "utf8");
    assert.ok(text.endsWith("\n"));
    assert.deepEqual(JSON.parse(text), { version: 1, tabs: TABS });

    const { log, lines } = recorder();
    assert.deepEqual(loadState(dir, log).tabs, TABS);
    assert.deepEqual(lines, []);
  });
});

test("saveState replaces state.json by rename instead of rewriting it in place", () => {
  withTempDir((dir) => {
    saveState(dir, { tabs: TABS });
    // A hard link keeps pointing at the old file; an in-place rewrite would change it too.
    const oldLink = path.join(dir, "old.json");
    fs.linkSync(path.join(dir, "state.json"), oldLink);
    const next = { "w2:t1": { base: "web", lastWritten: "web", autoNamed: false } };
    saveState(dir, { version: 1, tabs: next });

    assert.deepEqual(JSON.parse(fs.readFileSync(oldLink, "utf8")).tabs, TABS);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).tabs, next);
    assert.ok(!fs.existsSync(path.join(dir, "state.json.tmp")));
  });
});

test("saveState throws when the dir cannot be created", () => {
  withTempDir((root) => {
    const blocker = path.join(root, "file");
    fs.writeFileSync(blocker, "");
    assert.throws(() => saveState(path.join(blocker, "state"), { tabs: {} }));
  });
});

test("saveState throws and removes the temp file when the rename fails", () => {
  withTempDir((dir) => {
    // A directory named state.json makes the rename fail after the temp write.
    fs.mkdirSync(path.join(dir, "state.json"));
    fs.writeFileSync(path.join(dir, "state.json", "keep"), "");
    assert.throws(() => saveState(dir, { tabs: TABS }));
    assert.ok(!fs.existsSync(path.join(dir, "state.json.tmp")));
  });
});

test("loadState: missing file or dir is empty and silent", () => {
  withTempDir((dir) => {
    const { log, lines } = recorder();
    assert.deepEqual(loadState(dir, log).tabs, {});
    assert.deepEqual(loadState(path.join(dir, "absent"), log).tabs, {});
    assert.deepEqual(loadState(undefined, log).tabs, {});
    assert.deepEqual(lines, []);
  });
});

test("loadState: corrupt or wrongly shaped file is empty with exactly one log line", () => {
  const cases = ["{not json", "[]", "null", '{"version":1}', '{"version":1,"tabs":[]}', '{"version":2,"tabs":{}}'];
  for (const content of cases) {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, "state.json"), content);
      const { log, lines } = recorder();
      assert.deepEqual(loadState(dir, log).tabs, {}, content);
      assert.equal(lines.length, 1, content);
      assert.match(lines[0], /^state\.json: /);
    });
  }
});

test("loadState: an unreadable state.json is empty with one log line", () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, "state.json"));
    const { log, lines } = recorder();
    assert.deepEqual(loadState(dir, log).tabs, {});
    assert.equal(lines.length, 1);
  });
});

test("loadState drops malformed tab entries and keeps the rest", () => {
  withTempDir((dir) => {
    const tabs = {
      ...TABS,
      "w1:t4": { base: 4, lastWritten: "4", autoNamed: true },
      "w1:t5": { base: "x", lastWritten: "x" },
      "w1:t6": { base: "x", lastWritten: null, autoNamed: false },
      "w1:t7": "api",
      "w1:t8": null,
    };
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ version: 1, tabs }));
    const { log, lines } = recorder();
    assert.deepEqual(loadState(dir, log).tabs, TABS);
    assert.equal(lines.length, 1);
  });
});

test("loadState keeps only the known fields of an entry", () => {
  withTempDir((dir) => {
    const tabs = { "w1:t2": { ...TABS["w1:t2"], extra: true } };
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ version: 1, tabs }));
    const { log } = recorder();
    assert.deepEqual(loadState(dir, log).tabs, { "w1:t2": TABS["w1:t2"] });
  });
});

test("loadConfig: no dir or no config.json gives the defaults silently", () => {
  withTempDir((dir) => {
    const { log, lines } = recorder();
    assert.deepEqual(loadConfig(undefined, log), defaultConfig());
    assert.deepEqual(loadConfig(dir, log), defaultConfig());
    assert.deepEqual(loadConfig(path.join(dir, "absent"), log), defaultConfig());
    assert.deepEqual(lines, []);
  });
});

test("loadConfig merges a valid config.json over the defaults", () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ preset: "emoji", separator: "|" }));
    const { log, lines } = recorder();
    const config = loadConfig(dir, log);
    assert.deepEqual(config, { ...defaultConfig(), preset: "emoji", separator: "|" });
    assert.deepEqual(lines, []);
  });
});

test("loadConfig: an invalid config.json gives the defaults and one log line", () => {
  for (const content of ["{oops", JSON.stringify({ preset: "nope" })]) {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, "config.json"), content);
      const { log, lines } = recorder();
      assert.deepEqual(loadConfig(dir, log), defaultConfig());
      assert.equal(lines.length, 1);
      assert.match(lines[0], /^config\.json: /);
    });
  }
});
