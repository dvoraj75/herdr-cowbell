import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ctl = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "ctl.js");

test("ctl status exits 0 without an EPIPE stack when stdout's reader is gone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-"));
  const child = spawn(process.execPath, [ctl, "status"], {
    env: { PATH: process.env.PATH, HERDR_PLUGIN_STATE_DIR: dir, HERDR_PLUGIN_CONFIG_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  // Close our end of stdout before the child gets to write.
  child.stdout.destroy();
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (c, s) => resolve([c, s]));
    });
    assert.equal(signal, null);
    assert.doesNotMatch(stderr, /EPIPE|\n\s+at /);
    assert.equal(code, 0, stderr);
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
