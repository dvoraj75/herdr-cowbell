#!/usr/bin/env node
// Daemon entry: wires the herdr client, state dir and config into the loop in
// lib/daemon.js. All logic lives in lib/ so it can be tested without herdr.
import { createClient, socketPathFromEnv } from "../lib/socket.js";
import { loadConfig } from "../lib/state.js";
import { createDaemon } from "../lib/daemon.js";

/** @param {string} message */
function log(message) {
  process.stderr.write(`cowbell: ${message}\n`);
}

if (socketPathFromEnv() === null) {
  log("no herdr socket in the environment; run me from herdr");
  process.exit(1);
}

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
if (!stateDir) {
  log("HERDR_PLUGIN_STATE_DIR is not set; run me from herdr");
  process.exit(1);
}

const config = loadConfig(process.env.HERDR_PLUGIN_CONFIG_DIR, log);
const daemon = createDaemon({
  client: createClient(),
  stateDir,
  config,
  log,
  onExit: (code) => process.exit(code),
});

/** @param {string} signal */
function shutdown(signal) {
  daemon.stop().then(
    () => process.exit(0),
    (err) => {
      log(`${signal}: stop failed (${err && err.message})`);
      process.exit(1);
    },
  );
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

daemon.start().catch((err) => {
  log(`start failed (${err && err.message})`);
  process.exit(1);
});
