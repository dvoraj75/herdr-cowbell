import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PIDFILE, pidfilePath, readPid, pidExists, isDaemonAlive, livePid, acquire, release } from "../lib/lock.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHILD = path.join(ROOT, "fixtures", "lock-child.js");
const COWBELL = path.join(ROOT, "bin", "cowbell.js");

const tempDirs = [];
const children = new Set();

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-lock-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const child of children) child.kill("SIGKILL");
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** The pid of a process that has exited, so it is dead (and not reused within a test run). */
function deadPid() {
  const result = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(result.pid > 0);
  return result.pid;
}

const alwaysAlive = () => true;
const neverAlive = () => false;
const write = (dir, text) => fs.writeFileSync(pidfilePath(dir), text);

// ---- acquire and release ----

test("acquire on an empty dir takes the lock, writes the pid and leaves no temp file", () => {
  const dir = path.join(tempDir(), "nested", "state");
  assert.deepEqual(acquire(dir, { pid: 4242 }), { acquired: true });
  assert.equal(fs.readFileSync(pidfilePath(dir), "utf8").trim(), "4242");
  assert.deepEqual(fs.readdirSync(dir), [PIDFILE]);
  assert.equal(readPid(dir), 4242);
});

test("acquire defaults to the current pid", () => {
  const dir = tempDir();
  assert.deepEqual(acquire(dir), { acquired: true });
  assert.equal(readPid(dir), process.pid);
});

test("acquire reports the holder when another live process holds the lock, and keeps the file", () => {
  const dir = tempDir();
  write(dir, "222\n");
  assert.deepEqual(acquire(dir, { pid: 111, isAlive: (pid) => pid === 222 }), { acquired: false, pid: 222 });
  assert.equal(readPid(dir), 222);
  assert.deepEqual(fs.readdirSync(dir), [PIDFILE], "no temp file left behind");
});

test("acquire takes over the pidfile of a dead process", () => {
  const dir = tempDir();
  write(dir, "222\n");
  assert.deepEqual(acquire(dir, { pid: 111, isAlive: neverAlive }), { acquired: true });
  assert.equal(readPid(dir), 111);
  assert.deepEqual(fs.readdirSync(dir), [PIDFILE]);
});

test("acquire takes over a pidfile of a really dead pid with the default liveness check", () => {
  const dir = tempDir();
  write(dir, `${deadPid()}\n`);
  assert.deepEqual(acquire(dir, { pid: 111 }), { acquired: true });
  assert.equal(readPid(dir), 111);
});

for (const [name, text] of [
  ["garbage", "not a pid"],
  ["empty", ""],
  ["zero", "0\n"],
  ["negative", "-5\n"],
  ["a pid with trailing text", "12 abc\n"],
]) {
  test(`acquire takes over a pidfile with ${name} content, even if everything looks alive`, () => {
    const dir = tempDir();
    write(dir, text);
    assert.deepEqual(acquire(dir, { pid: 111, isAlive: alwaysAlive }), { acquired: true });
    assert.equal(readPid(dir), 111);
  });
}

test("acquire with our own pid already in the file succeeds, even if the liveness check says alive", () => {
  const dir = tempDir();
  write(dir, "111\n");
  assert.deepEqual(acquire(dir, { pid: 111, isAlive: alwaysAlive }), { acquired: true });
  assert.equal(readPid(dir), 111);
  assert.deepEqual(fs.readdirSync(dir), [PIDFILE]);
});

test("a takeover file older than 10 s does not block acquire", () => {
  const dir = tempDir();
  write(dir, "222\n");
  const takeover = path.join(dir, `${PIDFILE}.takeover`);
  fs.writeFileSync(takeover, "");
  const old = new Date(Date.now() - 30000);
  fs.utimesSync(takeover, old, old);
  assert.deepEqual(acquire(dir, { pid: 111, isAlive: neverAlive }), { acquired: true });
  assert.equal(readPid(dir), 111);
  assert.equal(fs.existsSync(takeover), false, "the stale takeover file is removed");
});

test("a fresh takeover file blocks the takeover of a stale pidfile until the retries run out", () => {
  const dir = tempDir();
  write(dir, "222\n");
  fs.writeFileSync(path.join(dir, `${PIDFILE}.takeover`), "");
  assert.throws(() => acquire(dir, { pid: 111, isAlive: neverAlive }), /contended/);
  assert.equal(readPid(dir), 222, "the pidfile was not touched");
  assert.equal(
    fs.readdirSync(dir).some((name) => name.endsWith(".tmp")),
    false,
    "no temp file left behind",
  );
});

test("release with our own pid removes the pidfile", () => {
  const dir = tempDir();
  acquire(dir, { pid: 111 });
  assert.equal(release(dir, { pid: 111 }), true);
  assert.equal(fs.existsSync(pidfilePath(dir)), false);
});

test("release with a foreign pid leaves the pidfile alone", () => {
  const dir = tempDir();
  acquire(dir, { pid: 222 });
  assert.equal(release(dir, { pid: 111 }), false);
  assert.equal(readPid(dir), 222);
});

test("release without a pidfile or with garbage in it does nothing", () => {
  const dir = tempDir();
  assert.equal(release(dir, { pid: 111 }), false);
  write(dir, "garbage");
  assert.equal(release(dir, { pid: 111 }), false);
  assert.equal(fs.readFileSync(pidfilePath(dir), "utf8"), "garbage");
});

// ---- readPid, livePid, liveness ----

test("readPid is null for a missing, empty or garbage file and a pid for a good one", () => {
  const dir = tempDir();
  assert.equal(readPid(dir), null);
  assert.equal(readPid(path.join(dir, "does-not-exist")), null);
  write(dir, "");
  assert.equal(readPid(dir), null);
  write(dir, "abc");
  assert.equal(readPid(dir), null);
  write(dir, "  77\n");
  assert.equal(readPid(dir), 77);
});

test("livePid is null for a missing or garbage file, a dead holder, and the pid for a live one", () => {
  const dir = tempDir();
  assert.equal(livePid(dir, { isAlive: alwaysAlive }), null);
  write(dir, "abc");
  assert.equal(livePid(dir, { isAlive: alwaysAlive }), null);
  write(dir, "77\n");
  assert.equal(livePid(dir, { isAlive: neverAlive }), null);
  assert.equal(livePid(dir, { isAlive: (pid) => pid === 77 }), 77);
});

// ---- pidfiles from before the current boot ----

/** Write a pidfile with process.pid (a live pid) and set its mtime. */
function writeLivePidfile(dir, mtimeMs) {
  write(dir, `${process.pid}\n`);
  const when = new Date(mtimeMs);
  fs.utimesSync(pidfilePath(dir), when, when);
}

const BOOT = Date.now() - 3600 * 1000;

test("livePid ignores a pidfile written before the boot, even when its pid is alive", () => {
  const dir = tempDir();
  writeLivePidfile(dir, BOOT - 60000);
  assert.equal(livePid(dir, { isAlive: alwaysAlive, bootTimeMs: BOOT }), null);
});

test("livePid keeps a pidfile written after the boot, or a moment before it (clock granularity)", () => {
  const dir = tempDir();
  writeLivePidfile(dir, BOOT + 60000);
  assert.equal(livePid(dir, { isAlive: alwaysAlive, bootTimeMs: BOOT }), process.pid);
  writeLivePidfile(dir, BOOT - 1000);
  assert.equal(livePid(dir, { isAlive: alwaysAlive, bootTimeMs: BOOT }), process.pid);
});

test("by default the boot-time check runs only where /proc is missing", () => {
  const dir = tempDir();
  const hasProc = fs.existsSync("/proc/self/cmdline");
  const realBoot = Date.now() - os.uptime() * 1000;
  writeLivePidfile(dir, realBoot - 60000);
  // With /proc the cmdline check rejects a reused pid, and a clock stepped
  // forward after boot (no hardware clock) must not orphan a live daemon.
  assert.equal(livePid(dir, { isAlive: alwaysAlive }), hasProc ? process.pid : null);

  writeLivePidfile(dir, Date.now());
  assert.equal(livePid(dir, { isAlive: alwaysAlive }), process.pid);
  assert.deepEqual(acquire(dir, { pid: 111, isAlive: alwaysAlive }), { acquired: false, pid: process.pid });
});

test("acquire takes over a pidfile written before the boot, even when its pid is alive", () => {
  const dir = tempDir();
  writeLivePidfile(dir, BOOT - 60000);
  assert.deepEqual(acquire(dir, { pid: 111, isAlive: alwaysAlive, bootTimeMs: BOOT }), { acquired: true });
  assert.equal(readPid(dir), 111);
  assert.deepEqual(fs.readdirSync(dir), [PIDFILE]);
});

test("acquire leaves a live holder's pidfile from this boot alone", () => {
  const dir = tempDir();
  writeLivePidfile(dir, BOOT + 60000);
  assert.deepEqual(acquire(dir, { pid: 111, isAlive: alwaysAlive, bootTimeMs: BOOT }), {
    acquired: false,
    pid: process.pid,
  });
  assert.equal(readPid(dir), process.pid);
});

test("acquire rewrites a pidfile from before the boot that holds our own pid, so the new daemon counts as live", () => {
  // A daemon died before a reboot and the new one got the same pid: the old
  // mtime must not survive, or livePid would call the new daemon absent.
  const dir = tempDir();
  write(dir, "4242\n");
  const beforeBoot = new Date(BOOT - 60000);
  fs.utimesSync(pidfilePath(dir), beforeBoot, beforeBoot);
  assert.deepEqual(acquire(dir, { pid: 4242, isAlive: alwaysAlive, bootTimeMs: BOOT }), { acquired: true });
  assert.equal(livePid(dir, { isAlive: alwaysAlive, bootTimeMs: BOOT }), 4242);
  assert.deepEqual(acquire(dir, { pid: 111, isAlive: alwaysAlive, bootTimeMs: BOOT }), { acquired: false, pid: 4242 });
  assert.deepEqual(fs.readdirSync(dir), [PIDFILE]);
});

test("pidExists is true for this process and false for a dead pid", () => {
  assert.equal(pidExists(process.pid), true);
  assert.equal(pidExists(deadPid()), false);
});

test("isDaemonAlive reads /proc/<pid>/cmdline through procRoot", () => {
  const procRoot = tempDir();
  const pid = process.pid;
  fs.mkdirSync(path.join(procRoot, String(pid)));
  const cmdline = path.join(procRoot, String(pid), "cmdline");

  fs.writeFileSync(cmdline, ["node", "/opt/herdr-cowbell/bin/cowbell.js"].join("\0"));
  assert.equal(isDaemonAlive(pid, { procRoot }), true, "a cowbell.js command line");

  fs.writeFileSync(cmdline, ["node", "/usr/bin/other.js"].join("\0"));
  assert.equal(isDaemonAlive(pid, { procRoot }), false, "a reused pid running something else");

  fs.rmSync(cmdline);
  assert.equal(isDaemonAlive(pid, { procRoot }), true, "no cmdline to read: the pid check decides");
  assert.equal(isDaemonAlive(pid, { procRoot: path.join(procRoot, "missing") }), true);
});

test("isDaemonAlive is false for a dead pid whatever /proc says", () => {
  const procRoot = tempDir();
  const pid = deadPid();
  fs.mkdirSync(path.join(procRoot, String(pid)));
  fs.writeFileSync(path.join(procRoot, String(pid), "cmdline"), "node\0cowbell.js");
  assert.equal(isDaemonAlive(pid, { procRoot }), false);
});

// ---- two processes ----

/**
 * Start `count` children that wait for a "go" line, then acquire the lock in
 * `dir` and stay alive. Resolves with their results once all have answered.
 */
async function race(dir, count) {
  const running = [];
  for (let i = 0; i < count; i += 1) {
    const child = spawn(process.execPath, [CHILD, dir], { stdio: ["pipe", "pipe", "inherit"] });
    children.add(child);
    const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const exited = new Promise((resolve) => child.once("exit", resolve));
    running.push({ child, lines, exited });
  }
  try {
    for (const { lines } of running) assert.equal((await lines.next()).value, "ready");
    for (const { child } of running) child.stdin.write("go\n");
    const results = [];
    for (const { lines } of running) results.push(JSON.parse((await lines.next()).value));
    return results;
  } finally {
    for (const { child } of running) child.stdin.end();
    // Bounded: a child that ignores the closed stdin is killed after 2 s.
    const timer = setTimeout(() => {
      for (const { child } of running) child.kill("SIGKILL");
    }, 2000);
    await Promise.all(running.map(({ exited }) => exited));
    clearTimeout(timer);
    for (const { child } of running) children.delete(child);
  }
}

test("two processes racing for the lock: exactly one wins, every round", async () => {
  for (let round = 0; round < 5; round += 1) {
    const dir = tempDir();
    const results = await race(dir, 3);
    const winners = results.filter((r) => r.acquired === true);
    assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify(results)}`);
    for (const loser of results.filter((r) => r.acquired === false)) {
      assert.equal(loser.pid, winners[0].self, "losers name the winner");
    }
    assert.equal(results.filter((r) => r.error).length, 0, JSON.stringify(results));
    assert.equal(readPid(dir), winners[0].self);
    assert.deepEqual(fs.readdirSync(dir), [PIDFILE]);
  }
});

test("two processes racing to take over a stale pidfile: exactly one wins, every round", async () => {
  for (let round = 0; round < 5; round += 1) {
    const dir = tempDir();
    write(dir, `${deadPid()}\n`);
    const results = await race(dir, 3);
    const winners = results.filter((r) => r.acquired === true);
    assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify(results)}`);
    assert.equal(results.filter((r) => r.error).length, 0, JSON.stringify(results));
    assert.equal(readPid(dir), winners[0].self);
    assert.deepEqual(fs.readdirSync(dir), [PIDFILE]);
  }
});

// ---- bin/cowbell.js ----

/** An environment for the daemon entry that cannot reach the user's herdr. */
function scrubbedEnv(dir, socketPath) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("HERDR_")) delete env[key];
  env.HERDR_SOCKET_PATH = socketPath || path.join(dir, "no-such-socket");
  env.HERDR_PLUGIN_STATE_DIR = dir;
  env.HERDR_PLUGIN_CONFIG_DIR = path.join(dir, "config");
  return env;
}

/**
 * Spawn bin/cowbell.js; `done` resolves with {code, signal, stderr}.
 * @param {string} dir The state directory.
 * @param {string} [socketPath] A fake herdr socket; default: one that does not exist.
 */
function runDaemon(dir, socketPath) {
  const child = spawn(process.execPath, [COWBELL], {
    env: scrubbedEnv(dir, socketPath),
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.add(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  // Bounded: whatever a test does or fails to do, the daemon dies after 10 s.
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 10000);
  const done = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      clearTimeout(killTimer);
      children.delete(child);
      resolve({ code, signal, stderr });
    });
  });
  return { child, done };
}

async function waitFor(predicate, what) {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("bin/cowbell.js: a second instance says it is already running and exits 0; SIGTERM frees the lock", async () => {
  const dir = tempDir();
  const first = runDaemon(dir);
  await waitFor(() => readPid(dir) === first.child.pid, "the first instance to take the lock");

  const second = await runDaemon(dir).done;
  assert.equal(second.code, 0);
  assert.match(second.stderr, new RegExp(`already running \\(pid ${first.child.pid}\\)`));
  assert.equal(readPid(dir), first.child.pid, "the holder keeps the lock");

  first.child.kill("SIGTERM");
  const result = await first.done;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(fs.existsSync(pidfilePath(dir)), false, "pidfile removed");
});

test("bin/cowbell.js: the disabled flag makes it exit 0 and leave no pidfile", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "disabled"), "");
  const result = await runDaemon(dir).done;
  assert.equal(result.code, 0);
  assert.match(result.stderr, /off/);
  assert.equal(fs.existsSync(pidfilePath(dir)), false);
});

test("bin/cowbell.js: SIGUSR1 and SIGUSR2 do not kill it", async () => {
  const dir = tempDir();
  const daemon = runDaemon(dir);
  await waitFor(() => readPid(dir) === daemon.child.pid, "the instance to take the lock");
  daemon.child.kill("SIGUSR1");
  daemon.child.kill("SIGUSR2");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(daemon.child.exitCode, null, "still running");
  assert.equal(pidExists(daemon.child.pid), true);
  daemon.child.kill("SIGTERM");
  assert.equal((await daemon.done).code, 0);
});

/**
 * A fake herdr on a unix socket in `dir`. Like herdr, it answers one request
 * per connection and closes it, except `events.subscribe`, whose connection
 * stays open. `tab.rename` changes the label later `tab.list` calls return.
 * @param {string} dir
 * @param {object[]} tabs The tabs `tab.list` returns; renamed in place.
 */
async function startFakeHerdr(dir, tabs) {
  const socketPath = path.join(dir, "h.sock");
  // sun_path holds about 104 bytes on macOS, 108 on Linux.
  assert.ok(Buffer.byteLength(socketPath) < 100, `socket path too long: ${socketPath}`);
  const renames = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        const reply = (body) => `${JSON.stringify({ id: request.id, ...body })}\n`;
        if (request.method === "events.subscribe") {
          socket.write(reply({ result: { type: "subscription_started" } }));
          continue;
        }
        let body;
        if (request.method === "pane.list") {
          body = { result: { panes: [{ pane_id: "p1" }] } };
        } else if (request.method === "tab.list") {
          body = { result: { tabs: tabs.map((tab) => ({ ...tab })) } };
        } else if (request.method === "tab.rename") {
          const { tab_id: tabId, label } = request.params;
          renames.push({ tab_id: tabId, label });
          const tab = tabs.find((candidate) => candidate.tab_id === tabId);
          if (tab) tab.label = label;
          body = tab ? { result: { type: "tab_info" } } : { error: { code: "tab_not_found", message: tabId } };
        } else {
          body = { error: { code: "unknown_method", message: request.method } };
        }
        socket.end(reply(body));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    path: socketPath,
    renames,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("bin/cowbell.js: SIGTERM puts the tab names back before it exits", async () => {
  const dir = tempDir();
  const tabs = [
    {
      tab_id: "t1",
      workspace_id: "w1",
      number: 1,
      label: "api",
      focused: true,
      pane_count: 1,
      agent_status: "working",
    },
  ];
  const herdr = await startFakeHerdr(dir, tabs);
  try {
    const daemon = runDaemon(dir, herdr.path);
    await waitFor(() => tabs[0].label === "◐ api", "the daemon to add the icon");

    daemon.child.kill("SIGTERM");
    const result = await daemon.done;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.deepEqual(herdr.renames.at(-1), { tab_id: "t1", label: "api" }, JSON.stringify(herdr.renames));
    assert.equal(tabs[0].label, "api");
    assert.equal(fs.existsSync(pidfilePath(dir)), false, "pidfile removed");
  } finally {
    await herdr.stop();
  }
});
