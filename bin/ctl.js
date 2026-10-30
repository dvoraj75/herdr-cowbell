#!/usr/bin/env node
// Control entry: wires real process dependencies into lib/control.js. This
// is the only place that spawns a process (the detached daemon).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDaemonLog, run } from "../lib/control.js";
import { createClient } from "../lib/socket.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Start the daemon detached, so it outlives this short-lived command.
 * @returns {number | undefined} Pid of the spawned child.
 */
function spawnDaemon() {
  const logFd = openDaemonLog(String(process.env.HERDR_PLUGIN_STATE_DIR));
  try {
    const child = spawn(process.execPath, [path.join(root, "bin", "cowbell.js")], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: root,
      env: process.env,
    });
    child.unref();
    return child.pid;
  } finally {
    // The child has its own copy of the descriptor.
    fs.closeSync(logFd);
  }
}

/** @type {import("../lib/control.js").ControlDeps} */
const realDeps = {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`cowbell: ${line}\n`),
  spawnDaemon,
  createClient,
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// A reader that closes early (`status | head -1`) makes stdout emit EPIPE.
// That is a normal end of output, not a failure.
process.stdout.on("error", (error) => {
  if (error && error.code === "EPIPE") process.exit();
  process.stderr.write(`cowbell: ${error && error.message}\n`);
  process.exit(1);
});

try {
  process.exitCode = await run(process.argv.slice(2), realDeps);
} catch (error) {
  process.stderr.write(`cowbell: ${error && error.message}\n`);
  process.exitCode = 1;
}
