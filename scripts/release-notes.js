// Extracts the CHANGELOG.md section for a release tag and appends install
// instructions, so the release workflow (#22) can publish it as the GitHub
// release body. A tag with no matching dated section fails before publishing.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "dvoraj75/herdr-cowbell";
const SEMVER = /^\d+\.\d+\.\d+$/;
const DATED_HEADING = /^## (\d+\.\d+\.\d+) — \d{4}-\d{2}-\d{2}\s*$/;
const ANY_VERSION_HEADING = /^## \[?(\d+\.\d+\.\d+)(?![\d.])/;
const UNRELEASED_TAG = /^v?\[?unreleased\]?$/i;

// Marks lines inside (or opening/closing) a fenced code block, so headings
// quoted in code samples are not mistaken for changelog structure.
function fencedLines(lines) {
  let marker = null;
  return lines.map((line) => {
    const fence = line.trimStart().match(/^(```|~~~)/)?.[1];
    if (marker === null) {
      if (fence) marker = fence;
      return fence !== undefined;
    }
    if (fence === marker) marker = null;
    return true;
  });
}

export function releaseNotes(changelog, tag) {
  if (UNRELEASED_TAG.test(tag)) {
    return {
      ok: false,
      problem: 'Unreleased has no release; rename "## Unreleased" to "## X.Y.Z — YYYY-MM-DD" first',
    };
  }
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!SEMVER.test(version)) return { ok: false, problem: `tag "${tag}" is not vX.Y.Z` };
  if (changelog == null) return { ok: false, problem: "CHANGELOG.md: not found" };

  const lines = changelog.split(/\r?\n/);
  const dated = [];
  let undated = null;
  const fenced = fencedLines(lines);
  lines.forEach((line, index) => {
    if (fenced[index]) return;
    const match = line.match(DATED_HEADING);
    if (match) {
      if (match[1] === version) dated.push(index);
    } else if (undated === null && line.match(ANY_VERSION_HEADING)?.[1] === version) {
      undated = line;
    }
  });

  const expected = `## ${version} — YYYY-MM-DD`;
  if (dated.length === 0) {
    if (undated !== null) {
      return { ok: false, problem: `CHANGELOG.md: heading "${undated.trimEnd()}" is not "${expected}"` };
    }
    return { ok: false, problem: `CHANGELOG.md: no "${expected}" section` };
  }
  if (dated.length > 1) {
    return { ok: false, problem: `CHANGELOG.md: section ${version} appears ${dated.length} times` };
  }

  const rest = lines.slice(dated[0] + 1);
  const restFenced = fenced.slice(dated[0] + 1);
  const next = rest.findIndex((line, index) => !restFenced[index] && line.startsWith("## "));
  const body = (next === -1 ? rest : rest.slice(0, next)).join("\n").trim();
  if (body === "") return { ok: false, problem: `CHANGELOG.md: section ${version} is empty` };

  const install = `## Install\n\n\`\`\`sh\nherdr plugin install ${REPO} --ref v${version}\n\`\`\``;
  return { ok: true, version, notes: `${body}\n\n${install}\n` };
}

function readOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    // Node's own resolver maps "release-notes", "release-notes.js" and symlinked
    // paths to the file it loaded as the entry point.
    return createRequire(import.meta.url).resolve(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    // argv[1] is not a module path (e.g. `node -e ... arg`), so this is an import.
    return false;
  }
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error("usage: node scripts/release-notes.js <tag>");
    process.exitCode = 2;
  } else {
    const rootDir = fileURLToPath(new URL("..", import.meta.url));
    const result = releaseNotes(readOrNull(resolve(rootDir, "CHANGELOG.md")), args[0]);
    if (result.ok) {
      process.stdout.write(result.notes);
    } else {
      console.error(result.problem);
      process.exitCode = 1;
    }
  }
}
