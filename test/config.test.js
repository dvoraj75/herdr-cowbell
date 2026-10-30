import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cyclePreset, loadConfig, nextPreset } from "../lib/config.js";
import { defaultConfig } from "../lib/icons.js";
import { spawn } from "node:child_process";

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
      assert.match(lines[0], /^config\.json: (invalid JSON|preset: )/);
      assert.ok(!lines[0].includes("config: "), lines[0]);
    });
  }
});

test("loadConfig: a bad file keeps lastGood and logs one line", () => {
  const lastGood = { ...defaultConfig(), preset: "emoji" };
  for (const content of ["{oops", JSON.stringify({ preset: "nope" })]) {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, "config.json"), content);
      const { log, lines } = recorder();
      assert.deepEqual(loadConfig(dir, log, lastGood), lastGood);
      assert.equal(lines.length, 1);
    });
  }
});

test("loadConfig: a missing file means the defaults even with lastGood", () => {
  withTempDir((dir) => {
    const { log, lines } = recorder();
    const lastGood = { ...defaultConfig(), preset: "emoji" };
    assert.deepEqual(loadConfig(dir, log, lastGood), defaultConfig());
    assert.deepEqual(loadConfig(undefined, log, lastGood), defaultConfig());
    assert.deepEqual(lines, []);
  });
});

test("nextPreset cycles ask, symbols, emoji, nerd, ask when custom has no icons", () => {
  const order = ["ask", "symbols", "emoji", "nerd", "ask"];
  for (let i = 0; i < order.length - 1; i += 1) {
    assert.equal(nextPreset(order[i], {}), order[i + 1]);
  }
  assert.equal(nextPreset("nerd", { icons: { working: "" } }), "ask");
});

test("nextPreset includes custom when config.icons has a non-empty icon, then wraps to ask", () => {
  const config = { icons: { working: "W" } };
  assert.equal(nextPreset("nerd", config), "custom");
  assert.equal(nextPreset("custom", config), "ask");
});

test("nextPreset moves on from custom even when custom has no icons", () => {
  assert.equal(nextPreset("custom", {}), "ask");
});

test("nextPreset treats unknown or missing current as ask", () => {
  for (const current of [undefined, null, "bogus", 5]) {
    assert.equal(nextPreset(current, {}), "symbols");
  }
});

test("cyclePreset creates the dir and config.json with the next preset", () => {
  withTempDir((root) => {
    const dir = path.join(root, "nested", "cfg");
    assert.deepEqual(cyclePreset(dir), { preset: "symbols" });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")), { preset: "symbols" });
    assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
  });
});

test("cyclePreset keeps other keys and advances from the stored preset", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ preset: "symbols", separator: "|", icons: { working: "W" } }));
    assert.deepEqual(cyclePreset(dir), { preset: "emoji" });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
      preset: "emoji",
      separator: "|",
      icons: { working: "W" },
    });
    assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
  });
});

test("cyclePreset throws and leaves the file byte-identical when the rest of the config is invalid", () => {
  const contents = [
    '{"preset":"ask","separator":1}',
    '{"preset":"ask","icons":{"bogus":"x"}}',
  ];
  for (const content of contents) {
    withTempDir((dir) => {
      const file = path.join(dir, "config.json");
      fs.writeFileSync(file, content);
      assert.throws(() => cyclePreset(dir), /config\.json: .*fix it by hand, not changed/);
      assert.equal(fs.readFileSync(file, "utf8"), content);
      assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
    });
  }
});

test("cyclePreset throws and leaves the file byte-identical for invalid JSON or a non-object", () => {
  for (const content of ["{oops", "[1,2]", "null", '"text"', '{\n  "preset": "emoji",\n']) {
    withTempDir((dir) => {
      const file = path.join(dir, "config.json");
      fs.writeFileSync(file, content);
      assert.throws(() => cyclePreset(dir), /config\.json/);
      assert.equal(fs.readFileSync(file, "utf8"), content);
      assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
    });
  }
});

/**
 * Run `count` processes that each call cyclePreset(dir) once, released at the
 * same moment, and wait for all of them.
 * @param {string} dir
 * @param {number} count
 * @returns {Promise<{code: number | null, stderr: string}[]>}
 */
function cycleConcurrently(dir, count) {
  const module = new URL("../lib/config.js", import.meta.url).href;
  // Children spin until the shared start time so their calls overlap.
  const startAt = Date.now() + 600;
  const source = `
    import { cyclePreset } from ${JSON.stringify(module)};
    while (Date.now() < ${startAt}) {}
    try { cyclePreset(${JSON.stringify(dir)}); }
    catch (err) { console.error(err && err.message); process.exit(1); }
  `;
  const runs = [];
  for (let i = 0; i < count; i += 1) {
    runs.push(
      new Promise((resolve) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, stderr });
        });
      }),
    );
  }
  return Promise.all(runs);
}

test("concurrent cyclePreset calls each advance the preset once, with no failures", async () => {
  for (let round = 0; round < 3; round += 1) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-"));
    try {
      fs.writeFileSync(path.join(dir, "config.json"), '{"preset":"symbols"}');
      const results = await cycleConcurrently(dir, 3);
      assert.deepEqual(results.map((r) => [r.code, r.stderr]), [[0, ""], [0, ""], [0, ""]]);
      // symbols -> emoji -> nerd -> ask
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).preset, "ask");
      assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("cyclePreset takes over a stale lock file", () => {
  withTempDir((dir) => {
    const lock = path.join(dir, "config.json.lock");
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    assert.deepEqual(cyclePreset(dir), { preset: "symbols" });
    assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
  });
});

test("cyclePreset throws a busy error when a fresh lock stays held", () => {
  withTempDir((dir) => {
    const lock = path.join(dir, "config.json.lock");
    fs.writeFileSync(lock, "");
    assert.throws(() => cyclePreset(dir), /config\.json is busy; try again/);
    assert.equal(fs.existsSync(lock), true, "someone else's lock is left alone");
    assert.equal(fs.existsSync(path.join(dir, "config.json")), false);
  });
});

test("cyclePreset leaves no lock or temp file after success or a validation failure", () => {
  withTempDir((dir) => {
    cyclePreset(dir);
    assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
    fs.writeFileSync(path.join(dir, "config.json"), '{"preset":"ask","separator":1}');
    assert.throws(() => cyclePreset(dir), /fix it by hand/);
    assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
  });
});

test("loadConfig: the logged line has exactly one config.json prefix", () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, "config.json"), "[1]");
    const { log, lines } = recorder();
    loadConfig(dir, log);
    assert.deepEqual(lines, ["config.json: must be a JSON object"]);
    fs.writeFileSync(path.join(dir, "config.json"), "{oops");
    loadConfig(dir, log);
    assert.match(lines[1], /^config\.json: invalid JSON \(/);
  });
});

test("cyclePreset removes config.json.<pid>.tmp orphans and leaves other files alone", () => {
  withTempDir((dir) => {
    for (const name of ["config.json.99999.tmp", "config.json.bak", "config.json.x.tmp"]) {
      fs.writeFileSync(path.join(dir, name), "x");
    }
    assert.deepEqual(cyclePreset(dir), { preset: "symbols" });
    assert.deepEqual(fs.readdirSync(dir).sort(), ["config.json", "config.json.bak", "config.json.x.tmp"]);
  });
});
