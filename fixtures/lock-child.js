// Child process for the lock race test (test/lock.test.js). Lives outside
// test/ so `node --test` never runs it as a test file. Protocol over stdio:
//   child -> "ready"          once the module is loaded
//   parent -> "go\n"          start acquiring (all children at the same moment)
//   child -> JSON result      the return value of acquire(), or {error}
// The child then stays alive, so a loser sees the winner as a live holder,
// until stdin closes or the safety timer fires.
import readline from "node:readline";
import { acquire, pidExists } from "../lib/lock.js";

const dir = process.argv[2];
if (!dir) process.exit(0);

// Plain (ref'd) timer: an open stdin would keep the loop alive anyway, so this
// is what guarantees a mis-run child cannot outlive its parent's test.
setTimeout(() => process.exit(0), 30000);

const rl = readline.createInterface({ input: process.stdin });
rl.once("line", () => {
  let result;
  try {
    result = acquire(dir, { isAlive: pidExists });
  } catch (err) {
    result = { error: String(err && err.message) };
  }
  process.stdout.write(`${JSON.stringify({ self: process.pid, ...result })}\n`);
});
rl.on("close", () => process.exit(0));
process.stdout.write("ready\n");
