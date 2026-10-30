// The control commands behind bin/ctl.js: start, stop, on, off, toggle,
// refresh, cycle-preset, status. Everything that touches a process or the
// herdr socket arrives through `deps`, so tests drive it with fakes.
import fs from "node:fs";
import path from "node:path";
import { cyclePreset, loadConfig } from "./config.js";
import { restoreTabs } from "./daemon.js";
import { isDaemonAlive, livePid, release } from "./lock.js";
import { socketPathFromEnv } from "./socket.js";
import { isEnabled, loadState, saveState, setEnabled } from "./state.js";

const POLL_MS = 100;
const START_WAIT_POLLS = 30; // 3 s
const STOP_WAIT_POLLS = 100; // 10 s

const MAX_LOG_BYTES = 1024 * 1024;

const USAGE = "usage: ctl.js <start|stop|on|off|toggle|refresh|cycle-preset|status>";

/**
 * Open `<stateDir>/daemon.log` for appending, moving a log above 1 MiB to
 * `daemon.log.1` first so it cannot grow without bound.
 * @param {string} stateDir Created if missing.
 * @returns {number} File descriptor; the caller closes it.
 */
export function openDaemonLog(stateDir) {
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
 * @typedef {object} ControlDeps
 * @property {Record<string, string | undefined>} env
 * @property {(line: string) => void} out
 * @property {(line: string) => void} err
 * @property {() => number | void} spawnDaemon Start a detached daemon; may
 *   return its pid.
 * @property {() => import("./socket.js").HerdrClient} createClient
 * @property {(pid: number, signal: string | number) => void} kill Like `process.kill`.
 * @property {(ms: number) => Promise<void>} sleep
 * @property {(pid: number) => boolean} [isAlive] Defaults to `isDaemonAlive`.
 */

/**
 * Run one control command.
 * @param {string[]} argv Arguments after the script name.
 * @param {ControlDeps} deps
 * @returns {Promise<number>} The process exit code.
 */
export async function run(argv, deps) {
  const command = argv[0];
  const handler = COMMANDS[command];
  if (!handler) {
    deps.err(USAGE);
    return 2;
  }
  const ctx = {
    ...deps,
    isAlive: deps.isAlive || isDaemonAlive,
    stateDir: deps.env.HERDR_PLUGIN_STATE_DIR || "",
    configDir: deps.env.HERDR_PLUGIN_CONFIG_DIR || "",
  };
  try {
    return await handler(ctx);
  } catch (error) {
    deps.err(`${command}: ${error && error.message}`);
    return 1;
  }
}

/**
 * @typedef {ControlDeps & {isAlive: (pid: number) => boolean,
 *   stateDir: string, configDir: string}} Context
 */

/**
 * @param {Context} ctx
 * @returns {number | null} Pid of the live daemon, if any.
 */
function daemonPid(ctx) {
  return livePid(ctx.stateDir, { isAlive: ctx.isAlive });
}

/**
 * @param {Context} ctx
 * @returns {boolean} False (after printing why) when the state dir is unset.
 */
function requireStateDir(ctx) {
  if (ctx.stateDir) return true;
  ctx.err("HERDR_PLUGIN_STATE_DIR is not set; run me from herdr");
  return false;
}

/**
 * Wait for the daemon to write its pidfile after spawning it.
 * @param {Context} ctx
 * @returns {Promise<number | null>}
 */
async function waitForPid(ctx) {
  for (let poll = 0; poll < START_WAIT_POLLS; poll += 1) {
    const pid = daemonPid(ctx);
    if (pid !== null) return pid;
    await ctx.sleep(POLL_MS);
  }
  return daemonPid(ctx);
}

/** @param {Context} ctx */
async function start(ctx) {
  if (!requireStateDir(ctx)) return 1;
  if (socketPathFromEnv(ctx.env) === null) {
    ctx.err("no herdr socket in the environment; run me from herdr");
    return 1;
  }
  if (!isEnabled(ctx.stateDir)) {
    ctx.out("cowbell is off");
    return 0;
  }
  const running = daemonPid(ctx);
  if (running !== null) {
    ctx.out(`already running (pid ${running})`);
    return 0;
  }
  const spawned = ctx.spawnDaemon();
  const pid = await waitForPid(ctx);
  if (pid === null) {
    ctx.err(`daemon did not start; see ${path.join(ctx.stateDir, "daemon.log")}`);
    return 1;
  }
  // A second `start` may have won the lock; our child then exited at once.
  if (typeof spawned === "number" && spawned !== pid) ctx.out(`already running (pid ${pid})`);
  else ctx.out(`started (pid ${pid})`);
  return 0;
}

/** @param {Context} ctx */
async function stop(ctx) {
  if (!requireStateDir(ctx)) return 1;
  const pid = daemonPid(ctx);
  if (pid === null) {
    ctx.out("not running");
    return 0;
  }
  ctx.kill(pid, "SIGTERM");
  for (let poll = 0; poll < STOP_WAIT_POLLS; poll += 1) {
    if (!ctx.isAlive(pid)) {
      ctx.out("stopped");
      return 0;
    }
    await ctx.sleep(POLL_MS);
  }
  // Re-check: the pid may have exited and been reused during the last wait.
  if (ctx.isAlive(pid)) ctx.kill(pid, "SIGKILL");
  // Not rmSync: the watchdog may already have started a new daemon whose
  // pidfile this must not delete.
  release(ctx.stateDir, { pid });
  ctx.err(`daemon (pid ${pid}) did not stop in 10 s; killed`);
  return 1;
}

/** @param {Context} ctx */
async function on(ctx) {
  if (!requireStateDir(ctx)) return 1;
  setEnabled(ctx.stateDir, true);
  return start(ctx);
}

/** @param {Context} ctx */
async function off(ctx) {
  if (!requireStateDir(ctx)) return 1;
  setEnabled(ctx.stateDir, false);
  if (daemonPid(ctx) !== null) return stop(ctx);

  // No daemon to restore the names, so do it here from the saved state.
  const log = (message) => ctx.err(message);
  const client = ctx.createClient();
  try {
    const tabs = await restoreTabs({
      client,
      tabs: loadState(ctx.stateDir, log).tabs,
      config: loadConfig(ctx.configDir, log),
      log,
    });
    saveState(ctx.stateDir, { tabs });
  } catch (error) {
    ctx.err(`could not restore tab names (${error && error.message}); cowbell stays off`);
    return 1;
  } finally {
    client.close();
  }
  ctx.out("off; tab names restored");
  return 0;
}

/** @param {Context} ctx */
async function toggle(ctx) {
  if (!requireStateDir(ctx)) return 1;
  return isEnabled(ctx.stateDir) ? off(ctx) : on(ctx);
}

/** @param {Context} ctx */
async function refresh(ctx) {
  if (!requireStateDir(ctx)) return 1;
  const pid = daemonPid(ctx);
  if (pid !== null) {
    ctx.kill(pid, "SIGUSR1");
    ctx.out("refresh requested");
    return 0;
  }
  // A fresh daemon starts with a full resync, which is the refresh.
  return start(ctx);
}

/** @param {Context} ctx */
async function cycle(ctx) {
  if (!ctx.configDir) {
    ctx.err("HERDR_PLUGIN_CONFIG_DIR is not set; run me from herdr");
    return 1;
  }
  const { preset } = cyclePreset(ctx.configDir);
  ctx.out(`preset: ${preset}`);
  const pid = ctx.stateDir ? daemonPid(ctx) : null;
  if (pid !== null) ctx.kill(pid, "SIGUSR2");
  return 0;
}

/** @param {Context} ctx */
async function status(ctx) {
  if (!requireStateDir(ctx)) return 1;
  const pid = daemonPid(ctx);
  const problems = [];
  const config = loadConfig(ctx.configDir, (message) => problems.push(message));
  ctx.out(`daemon: ${pid === null ? "stopped" : `running (pid ${pid})`}`);
  ctx.out(`enabled: ${isEnabled(ctx.stateDir) ? "yes" : "no"}`);
  ctx.out(`preset: ${problems.length > 0 ? problems[0] : config.preset}`);
  ctx.out(`state dir: ${ctx.stateDir}`);
  ctx.out(`config dir: ${ctx.configDir || "(unset)"}`);
  return 0;
}

const COMMANDS = Object.assign(Object.create(null), {
  start,
  stop,
  on,
  off,
  toggle,
  refresh,
  "cycle-preset": cycle,
  status,
});
