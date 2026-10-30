#!/usr/bin/env node
// Control entry: wires real process dependencies into lib/control.js. This
// is the only place that spawns a process (the detached daemon).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../lib/control.js";
import { createClient } from "../lib/socket.js";

const MAX_LOG_BYTES = 1024 * 1024;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Open `<stateDir>/daemon.log` for appending, moving a log above 1 MiB to
 * `daemon.log.1` first so it cannot grow without bound.
 * @param {string} stateDir
 * @returns {number} File descriptor.
 */
function openLog(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  const logPath = path.join(stateDir, "daemon.log");
  try {
    if (fs.statSync(logPath).size > MAX_LOG_BYTES) fs.renameSync(logPath, `${logPath}.1`);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  return fs.openSync(logPath, "a");
}

/**
 * Start the daemon detached, so it outlives this short-lived command.
 * @returns {number | undefined} Pid of the spawned child.
 */
function spawnDaemon() {
  const logFd = openLog(String(process.env.HERDR_PLUGIN_STATE_DIR));
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

const realDeps = {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`cowbell: ${line}\n`),
  spawnDaemon,
  createClient,
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

try {
  process.exitCode = await run(process.argv.slice(2), realDeps);
} catch (error) {
  process.stderr.write(`cowbell: ${error && error.message}\n`);
  process.exitCode = 1;
}
