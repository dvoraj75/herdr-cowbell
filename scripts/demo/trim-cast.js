#!/usr/bin/env node
// Usage: trim-cast.js <in.cast> <out.cast>
// Drops the end of an asciicast v2 recording from the first output event
// that leaves the alternate screen (the herdr client tearing down after the
// timeout), so the last rendered frame is the herdr UI, not an empty shell.
import fs from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  process.stderr.write("usage: trim-cast.js <in.cast> <out.cast>\n");
  process.exit(2);
}

const lines = fs.readFileSync(input, "utf8").split("\n").filter((line) => line !== "");
const header = JSON.parse(lines[0]);
if (header.version !== 2) {
  process.stderr.write(`trim-cast: expected asciicast v2, got version ${header.version}\n`);
  process.exit(1);
}

const kept = [lines[0]];
let cut = false;
for (const line of lines.slice(1)) {
  const [, type, data] = JSON.parse(line);
  if (type === "o" && data.includes("\u001b[?1049l")) {
    cut = true;
    break;
  }
  kept.push(line);
}
if (!cut) {
  process.stderr.write("trim-cast: no alternate-screen exit found; is this a herdr client recording?\n");
  process.exit(1);
}
fs.writeFileSync(output, `${kept.join("\n")}\n`);
process.stdout.write(`trim-cast: kept ${kept.length - 1} of ${lines.length - 1} events\n`);
