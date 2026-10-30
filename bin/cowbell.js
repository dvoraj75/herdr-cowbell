#!/usr/bin/env node
// Daemon entry: takes the singleton lock, wires the herdr client, state dir
// and config into the loop in lib/daemon.js and maps signals onto it. All
// logic lives in lib/ so it can be tested without herdr.
//
// Signals: SIGTERM/SIGINT restore every tab name and exit, SIGUSR1 resyncs
// now, SIGUSR2 reloads config.json (bin/ctl.js sends these).
import { createClient, socketPathFromEnv } from "../lib/socket.js";
import { isEnabled } from "../lib/state.js";
import { loadConfig } from "../lib/config.js";
import { createDaemon } from "../lib/daemon.js";
import { acquire, release } from "../lib/lock.js";

/** @param {string} message */
function log(message) {
  process.stderr.write(`cowbell: ${message}\n`);
}

/** @type {ReturnType<typeof createDaemon> | null} */
let daemon = null;
let exiting = false;

/**
 * @param {string} signal
 */
function shutdown(signal) {
  // A second signal while the restore runs must not cut it short.
  if (exiting) return;
  exiting = true;
  if (!daemon) {
    exitWith(0);
    return;
  }
  daemon.stop({ restore: true }).then(
    (restored) => {
      // On failure the daemon already logged why the names stayed.
      log(restored ? `${signal}: stopped, names restored` : `${signal}: stopped`);
      exitWith(0);
    },
    (err) => {
      log(`${signal}: stop failed (${err && err.message})`);
      exitWith(0);
    },
  );
}

function refresh() {
  if (exiting || !daemon) return;
  daemon.refresh().catch((err) => log(`refresh failed (${err && err.message})`));
}

function reloadConfig() {
  if (exiting || !daemon) return;
  // A broken config.json keeps the config that is in use.
  config = loadConfig(configDir, log, config);
  daemon.setConfig(config).catch((err) => log(`config reload failed (${err && err.message})`));
}

// Before the lock: SIGUSR1/SIGUSR2 kill a Node process that has no handler,
// and bin/ctl.js may signal a daemon the moment its pid is in the pidfile.
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGUSR1", refresh);
process.on("SIGUSR2", reloadConfig);

if (socketPathFromEnv() === null) {
  log("no herdr socket in the environment; run me from herdr");
  process.exit(1);
}

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
if (!stateDir) {
  log("HERDR_PLUGIN_STATE_DIR is not set; run me from herdr");
  process.exit(1);
}
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR;

/** @param {number} code */
function exitWith(code) {
  release(stateDir);
  process.exit(code);
}

let lock;
try {
  lock = acquire(stateDir);
} catch (err) {
  log(`cannot take the lock (${err && err.message})`);
  process.exit(1);
}
if (!lock.acquired) {
  log(`already running (pid ${lock.pid})`);
  process.exit(0);
}
// Safety net for every other way out (an uncaught exception included);
// release only removes a pidfile that still holds our pid.
process.on("exit", () => release(stateDir));

// Checked after the lock, so an `off` that raced with this start either sees
// our pid (and signals us) or we see its flag here.
if (!isEnabled(stateDir)) {
  log("cowbell is off, exiting");
  exitWith(0);
}

let config = loadConfig(configDir, log);
daemon = createDaemon({
  client: createClient(),
  stateDir,
  config,
  log,
  pluginId: process.env.HERDR_PLUGIN_ID || null,
  onExit: (code) => exitWith(code),
});

daemon.start().catch((err) => {
  log(`start failed (${err && err.message})`);
  exitWith(1);
});
