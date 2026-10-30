import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDaemonLog, run } from "../lib/control.js";
import { isEnabled, setEnabled } from "../lib/state.js";

const FAKE_PID = 4242;

/**
 * Build a control world over fresh temp dirs: fake env, process table and
 * herdr client. Nothing here touches the inherited environment.
 * @param {object} [options]
 * @param {boolean} [options.withEnv] Set the plugin dirs and socket path.
 * @returns {object}
 */
function makeWorld({ withEnv = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-ctl-"));
  const stateDir = path.join(root, "state");
  const configDir = path.join(root, "config");
  const world = {
    root,
    stateDir,
    configDir,
    out: [],
    err: [],
    kills: [],
    sleeps: 0,
    spawns: 0,
    live: new Set(),
    // What the next spawnDaemon call does: write a pidfile for this pid (or
    // none), and return `spawnReturns` (default: the pid it wrote).
    spawnWrites: FAKE_PID,
    spawnReturns: undefined,
    // Whether SIGTERM makes the fake pid exit.
    dieOnTerm: true,
    client: null,
    clientCreated: 0,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    pidfile: () => path.join(stateDir, "cowbell.pid"),
    writePidfile(pid) {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(world.pidfile(), `${pid}\n`);
      world.live.add(pid);
    },
  };
  const env = withEnv
    ? {
        HERDR_PLUGIN_STATE_DIR: stateDir,
        HERDR_PLUGIN_CONFIG_DIR: configDir,
        HERDR_SOCKET_PATH: path.join(root, "herdr.sock"),
      }
    : {};
  world.deps = {
    env,
    out: (line) => world.out.push(line),
    err: (line) => world.err.push(line),
    spawnDaemon() {
      world.spawns += 1;
      if (world.spawnWrites !== null) world.writePidfile(world.spawnWrites);
      return world.spawnReturns === undefined ? world.spawnWrites ?? undefined : world.spawnReturns;
    },
    kill(pid, signal) {
      world.kills.push([pid, signal]);
      if (signal === "SIGKILL" || (signal === "SIGTERM" && world.dieOnTerm)) world.live.delete(pid);
    },
    sleep: async () => {
      world.sleeps += 1;
    },
    isAlive: (pid) => world.live.has(pid),
    createClient() {
      world.clientCreated += 1;
      return world.client;
    },
  };
  return world;
}

/**
 * Run `body` with a world and remove its temp dirs afterwards.
 * @param {(world: ReturnType<typeof makeWorld>) => Promise<void>} body
 * @param {object} [options]
 * @returns {() => Promise<void>}
 */
function inWorld(body, options) {
  return async () => {
    const world = makeWorld(options);
    try {
      await body(world);
    } finally {
      world.cleanup();
    }
  };
}

/**
 * A scripted tab.list / tab.rename client.
 * @param {object[]} tabs
 * @param {Error | null} [failWith] Rejects every request when set.
 */
function fakeClient(tabs, failWith = null) {
  const client = {
    calls: [],
    closed: 0,
    async request(method, params) {
      client.calls.push([method, params]);
      if (failWith) throw failWith;
      if (method === "tab.list") return { type: "tab_list", tabs: tabs.map((t) => ({ ...t })) };
      if (method === "tab.rename") return { type: "ok" };
      throw new Error(`unexpected request ${method}`);
    },
    close() {
      client.closed += 1;
    },
  };
  return client;
}

const USAGE = /^usage: ctl\.js /;

test("an unknown command prints usage on err and exits 2", inWorld(async (w) => {
  assert.equal(await run(["frobnicate"], w.deps), 2);
  assert.equal(w.err.length, 1);
  assert.match(w.err[0], USAGE);
  assert.deepEqual(w.out, []);
}));

test("no command prints usage on err and exits 2", inWorld(async (w) => {
  assert.equal(await run([], w.deps), 2);
  assert.match(w.err[0], USAGE);
}));

test("an inherited object key is not a command", inWorld(async (w) => {
  assert.equal(await run(["toString"], w.deps), 2);
  assert.equal(await run(["constructor"], w.deps), 2);
}));

test("start without a state dir or socket path reports and exits 1", async () => {
  const noEnv = makeWorld({ withEnv: false });
  try {
    assert.equal(await run(["start"], noEnv.deps), 1);
    assert.equal(noEnv.err.length, 1);
    assert.equal(noEnv.spawns, 0);
  } finally {
    noEnv.cleanup();
  }
  const noSocket = makeWorld();
  try {
    delete noSocket.deps.env.HERDR_SOCKET_PATH;
    assert.equal(await run(["start"], noSocket.deps), 1);
    assert.match(noSocket.err[0], /socket/);
    assert.equal(noSocket.spawns, 0);
  } finally {
    noSocket.cleanup();
  }
});

test("start while disabled says cowbell is off and does not spawn", inWorld(async (w) => {
  setEnabled(w.stateDir, false);
  assert.equal(await run(["start"], w.deps), 0);
  assert.deepEqual(w.out, ["cowbell is off"]);
  assert.equal(w.spawns, 0);
}));

test("start with a live pidfile says already running and does not spawn", inWorld(async (w) => {
  w.writePidfile(777);
  assert.equal(await run(["start"], w.deps), 0);
  assert.deepEqual(w.out, ["already running (pid 777)"]);
  assert.equal(w.spawns, 0);
}));

test("start with a stale pidfile spawns", inWorld(async (w) => {
  fs.mkdirSync(w.stateDir, { recursive: true });
  fs.writeFileSync(w.pidfile(), "999\n"); // not in the live set
  assert.equal(await run(["start"], w.deps), 0);
  assert.equal(w.spawns, 1);
  assert.deepEqual(w.out, [`started (pid ${FAKE_PID})`]);
}));

test("start spawns once and reports the pid", inWorld(async (w) => {
  assert.equal(await run(["start"], w.deps), 0);
  assert.equal(w.spawns, 1);
  assert.deepEqual(w.out, [`started (pid ${FAKE_PID})`]);
  assert.deepEqual(w.err, []);
}));

test("start whose daemon never writes a pidfile fails after 30 polls", inWorld(async (w) => {
  w.spawnWrites = null;
  assert.equal(await run(["start"], w.deps), 1);
  assert.equal(w.spawns, 1);
  assert.equal(w.sleeps, 30);
  assert.equal(w.err.length, 1);
  assert.match(w.err[0], /daemon did not start/);
  assert.deepEqual(w.out, []);
}));

test("start whose spawned pid lost to another live daemon says already running", inWorld(async (w) => {
  w.spawnWrites = 555; // the winner's pidfile
  w.spawnReturns = 556; // our child, which exited
  assert.equal(await run(["start"], w.deps), 0);
  assert.deepEqual(w.out, ["already running (pid 555)"]);
}));

test("stop with no daemon says not running", inWorld(async (w) => {
  assert.equal(await run(["stop"], w.deps), 0);
  assert.deepEqual(w.out, ["not running"]);
  assert.deepEqual(w.kills, []);
}));

test("stop sends SIGTERM and reports stopped once the daemon is gone", inWorld(async (w) => {
  w.writePidfile(321);
  assert.equal(await run(["stop"], w.deps), 0);
  assert.deepEqual(w.kills, [[321, "SIGTERM"]]);
  assert.deepEqual(w.out, ["stopped"]);
}));

test("stop waits while the daemon lives, then reports stopped", inWorld(async (w) => {
  w.writePidfile(321);
  w.dieOnTerm = false;
  w.deps.sleep = async () => {
    w.sleeps += 1;
    if (w.sleeps === 3) w.live.delete(321);
  };
  assert.equal(await run(["stop"], w.deps), 0);
  assert.equal(w.sleeps, 3);
  assert.deepEqual(w.kills, [[321, "SIGTERM"]]);
  assert.deepEqual(w.out, ["stopped"]);
}));

test("stop on a daemon that never dies sends SIGKILL, removes the pidfile and exits 1", inWorld(async (w) => {
  w.writePidfile(321);
  w.dieOnTerm = false;
  assert.equal(await run(["stop"], w.deps), 1);
  assert.equal(w.sleeps, 100);
  assert.deepEqual(w.kills, [[321, "SIGTERM"], [321, "SIGKILL"]]);
  assert.equal(fs.existsSync(w.pidfile()), false);
  assert.equal(w.err.length, 1);
  assert.deepEqual(w.out, []);
}));

test("stop's SIGKILL path leaves a pidfile that now holds another pid", inWorld(async (w) => {
  w.writePidfile(321);
  w.dieOnTerm = false;
  w.deps.kill = (pid, signal) => {
    w.kills.push([pid, signal]);
    if (signal === "SIGKILL") {
      w.live.delete(pid);
      w.writePidfile(654);
    }
  };
  assert.equal(await run(["stop"], w.deps), 1);
  assert.equal(fs.readFileSync(w.pidfile(), "utf8").trim(), "654");
}));

test("on clears the disabled flag and starts the daemon", inWorld(async (w) => {
  setEnabled(w.stateDir, false);
  assert.equal(await run(["on"], w.deps), 0);
  assert.equal(isEnabled(w.stateDir), true);
  assert.equal(w.spawns, 1);
  assert.deepEqual(w.out, [`started (pid ${FAKE_PID})`]);
}));

test("off with a live daemon sets the flag and sends SIGTERM", inWorld(async (w) => {
  w.writePidfile(321);
  assert.equal(await run(["off"], w.deps), 0);
  assert.equal(isEnabled(w.stateDir), false);
  assert.deepEqual(w.kills, [[321, "SIGTERM"]]);
  assert.equal(w.clientCreated, 0);
  assert.deepEqual(w.out, ["stopped"]);
}));

test("off without a daemon restores tab names itself, saves state and closes the client", inWorld(async (w) => {
  fs.mkdirSync(w.stateDir, { recursive: true });
  const entry = { base: "api", lastWritten: "◐ api", autoNamed: false };
  fs.writeFileSync(path.join(w.stateDir, "state.json"), JSON.stringify({ version: 1, tabs: { "w1:t2": entry } }));
  w.client = fakeClient([{ tab_id: "w1:t2", workspace_id: "w1", label: "◐ api" }]);

  assert.equal(await run(["off"], w.deps), 0);

  assert.equal(isEnabled(w.stateDir), false);
  assert.deepEqual(w.client.calls, [
    ["tab.list", {}],
    ["tab.rename", { tab_id: "w1:t2", label: "api" }],
  ]);
  assert.equal(w.client.closed, 1);
  assert.deepEqual(w.out, ["off; tab names restored"]);
  const saved = JSON.parse(fs.readFileSync(path.join(w.stateDir, "state.json"), "utf8"));
  assert.deepEqual(saved.tabs, { "w1:t2": { ...entry, lastWritten: "api" } });
  assert.deepEqual(w.kills, []);
}));

test("off with an unreachable herdr exits 1 but the flag stays written", inWorld(async (w) => {
  const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  w.client = fakeClient([], refused);
  assert.equal(await run(["off"], w.deps), 1);
  assert.equal(isEnabled(w.stateDir), false);
  assert.equal(w.client.closed, 1);
  assert.equal(w.err.length, 1);
  assert.match(w.err[0], /ECONNREFUSED/);
  assert.deepEqual(w.out, []);
}));

test("toggle flips between off and on", inWorld(async (w) => {
  w.client = fakeClient([]);
  assert.equal(await run(["toggle"], w.deps), 0);
  assert.equal(isEnabled(w.stateDir), false);
  assert.equal(w.spawns, 0);

  assert.equal(await run(["toggle"], w.deps), 0);
  assert.equal(isEnabled(w.stateDir), true);
  assert.equal(w.spawns, 1);
}));

test("start after off does not spawn (watchdog stays quiet)", inWorld(async (w) => {
  w.client = fakeClient([]);
  assert.equal(await run(["off"], w.deps), 0);
  w.out.length = 0;
  assert.equal(await run(["start"], w.deps), 0);
  assert.deepEqual(w.out, ["cowbell is off"]);
  assert.equal(w.spawns, 0);
}));

test("refresh with a live daemon sends SIGUSR1", inWorld(async (w) => {
  w.writePidfile(321);
  assert.equal(await run(["refresh"], w.deps), 0);
  assert.deepEqual(w.kills, [[321, "SIGUSR1"]]);
  assert.equal(w.spawns, 0);
}));

test("refresh without a daemon spawns one when enabled", inWorld(async (w) => {
  assert.equal(await run(["refresh"], w.deps), 0);
  assert.equal(w.spawns, 1);
  assert.deepEqual(w.kills, []);
  assert.deepEqual(w.out, [`started (pid ${FAKE_PID})`]);
}));

test("refresh without a daemon while disabled says cowbell is off", inWorld(async (w) => {
  setEnabled(w.stateDir, false);
  assert.equal(await run(["refresh"], w.deps), 0);
  assert.deepEqual(w.out, ["cowbell is off"]);
  assert.equal(w.spawns, 0);
}));

test("cycle-preset on a fresh dir prints symbols, writes config.json and signals nobody", inWorld(async (w) => {
  assert.equal(await run(["cycle-preset"], w.deps), 0);
  assert.deepEqual(w.out, ["preset: symbols"]);
  const file = path.join(w.configDir, "config.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { preset: "symbols" });
  assert.deepEqual(w.kills, []);
}));

test("cycle-preset sends SIGUSR2 to a live daemon", inWorld(async (w) => {
  w.writePidfile(321);
  assert.equal(await run(["cycle-preset"], w.deps), 0);
  assert.deepEqual(w.kills, [[321, "SIGUSR2"]]);
}));

test("cycle-preset with an invalid config.json exits 1 and leaves it unchanged", inWorld(async (w) => {
  fs.mkdirSync(w.configDir, { recursive: true });
  const file = path.join(w.configDir, "config.json");
  fs.writeFileSync(file, "{oops");
  w.writePidfile(321);
  assert.equal(await run(["cycle-preset"], w.deps), 1);
  assert.equal(fs.readFileSync(file, "utf8"), "{oops");
  assert.equal(w.err.length, 1);
  assert.deepEqual(w.kills, []);
  assert.deepEqual(w.out, []);
}));

test("cycle-preset with a semantically invalid config.json exits 1, unchanged, no SIGUSR2", inWorld(async (w) => {
  fs.mkdirSync(w.configDir, { recursive: true });
  const file = path.join(w.configDir, "config.json");
  const content = '{"preset":"ask","separator":1}';
  fs.writeFileSync(file, content);
  w.writePidfile(321);
  assert.equal(await run(["cycle-preset"], w.deps), 1);
  assert.equal(fs.readFileSync(file, "utf8"), content);
  assert.equal(w.err.length, 1);
  assert.deepEqual(w.kills, []);
  assert.deepEqual(w.out, []);
}));

/**
 * Run `body` with a fresh temp dir that is removed afterwards.
 * @param {(dir: string) => void} body
 */
function withLogDir(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-log-"));
  try {
    body(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("openDaemonLog creates the dir and opens daemon.log for appending", () => {
  withLogDir((root) => {
    const dir = path.join(root, "a", "state");
    const fd = openDaemonLog(dir);
    fs.writeSync(fd, "hello\n");
    fs.closeSync(fd);
    assert.equal(fs.readFileSync(path.join(dir, "daemon.log"), "utf8"), "hello\n");
  });
});

test("openDaemonLog appends to a small log without rotating it", () => {
  withLogDir((root) => {
    fs.writeFileSync(path.join(root, "daemon.log"), "old\n");
    const fd = openDaemonLog(root);
    fs.writeSync(fd, "new\n");
    fs.closeSync(fd);
    assert.equal(fs.readFileSync(path.join(root, "daemon.log"), "utf8"), "old\nnew\n");
    assert.equal(fs.existsSync(path.join(root, "daemon.log.1")), false);
  });
});

test("openDaemonLog moves a log above 1 MiB to daemon.log.1, replacing an older one", () => {
  withLogDir((root) => {
    const big = "x".repeat(1024 * 1024 + 1);
    fs.writeFileSync(path.join(root, "daemon.log"), big);
    fs.writeFileSync(path.join(root, "daemon.log.1"), "older");
    const fd = openDaemonLog(root);
    fs.writeSync(fd, "fresh\n");
    fs.closeSync(fd);
    assert.equal(fs.readFileSync(path.join(root, "daemon.log.1"), "utf8"), big);
    assert.equal(fs.readFileSync(path.join(root, "daemon.log"), "utf8"), "fresh\n");
  });
});

test("cycle-preset without a config dir in the env exits 1", inWorld(async (w) => {
  delete w.deps.env.HERDR_PLUGIN_CONFIG_DIR;
  assert.equal(await run(["cycle-preset"], w.deps), 1);
  assert.equal(w.err.length, 1);
  assert.deepEqual(w.out, []);
}));

test("status reports a stopped daemon, enabled, preset and both dirs", inWorld(async (w) => {
  assert.equal(await run(["status"], w.deps), 0);
  assert.deepEqual(w.out, [
    "daemon: stopped",
    "enabled: yes",
    "preset: ask",
    `state dir: ${w.stateDir}`,
    `config dir: ${w.configDir}`,
  ]);
}));

test("status reports a running daemon, disabled and the configured preset", inWorld(async (w) => {
  w.writePidfile(321);
  setEnabled(w.stateDir, false);
  fs.mkdirSync(w.configDir, { recursive: true });
  fs.writeFileSync(path.join(w.configDir, "config.json"), JSON.stringify({ preset: "emoji" }));
  assert.equal(await run(["status"], w.deps), 0);
  assert.equal(w.out[0], "daemon: running (pid 321)");
  assert.equal(w.out[1], "enabled: no");
  assert.equal(w.out[2], "preset: emoji");
}));

test("status shows the config error instead of a preset", inWorld(async (w) => {
  fs.mkdirSync(w.configDir, { recursive: true });
  fs.writeFileSync(path.join(w.configDir, "config.json"), "{oops");
  assert.equal(await run(["status"], w.deps), 0);
  assert.match(w.out[2], /^preset: config\.json: /);
  assert.doesNotMatch(w.out[2], /preset: ask/);
}));

test("manifest declares the startup, watchdog event and four actions", () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "herdr-plugin.toml");
  const text = fs.readFileSync(file, "utf8");
  const blocks = (header) =>
    text
      .split(/^(?=\[\[)/m)
      .filter((block) => block.startsWith(`[[${header}]]`));
  const command = (block) => JSON.stringify(JSON.parse(block.match(/^command = (\[.*\])$/m)[1]));
  const start = JSON.stringify(["node", "bin/ctl.js", "start"]);

  assert.match(text, /^version = "0\.0\.1"$/m);

  const startup = blocks("startup");
  assert.equal(startup.length, 1);
  assert.equal(command(startup[0]), start);

  const events = blocks("events");
  assert.equal(events.length, 1);
  assert.match(events[0], /^on = "pane\.agent_detected"$/m);
  assert.equal(command(events[0]), start);

  const expected = [
    ["toggle", "Cowbell: on/off"],
    ["off", "Cowbell: off and remove icons"],
    ["refresh", "Cowbell: refresh now"],
    ["cycle-preset", "Cowbell: next icon preset"],
  ];
  const actions = blocks("actions");
  assert.equal(actions.length, expected.length);
  expected.forEach(([id, title], i) => {
    assert.match(actions[i], new RegExp(`^id = "${id}"$`, "m"));
    assert.match(actions[i], new RegExp(`^title = "${title}"$`, "m"));
    assert.equal(command(actions[i]), JSON.stringify(["node", "bin/ctl.js", id]));
  });
});
