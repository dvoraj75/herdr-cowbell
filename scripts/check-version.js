// Checks that herdr-plugin.toml, package.json and the top released CHANGELOG
// heading carry the same version, and optionally a release tag. The release
// workflow (#22) passes the pushed tag as the first argument so a mismatched
// tag fails before anything is published.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+$/;
const CHANGELOG_HEADING = /^## (\d+\.\d+\.\d+) — \d{4}-\d{2}-\d{2}\s*$/;

class ManifestSyntaxError extends Error {
  constructor(line, reason) {
    super(reason);
    this.line = line;
  }
}

const BARE_KEY = "[A-Za-z0-9_-]+";
const TABLE_HEADER = new RegExp(`^(\\[\\[${BARE_KEY}(\\.${BARE_KEY})*\\]\\]|\\[${BARE_KEY}(\\.${BARE_KEY})*\\])\\s*(#.*)?$`);
const KEY_PREFIX = new RegExp(`^(${BARE_KEY})\\s*=\\s*`);
const ESCAPES = { '"': '"', "\\": "\\", n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };

// Moves past whitespace, and (inside arrays) comments and line breaks.
// Returns false at the end of input.
function skipFiller(cursor, multiline) {
  for (;;) {
    const line = cursor.lines[cursor.row];
    if (line === undefined) return false;
    while (cursor.col < line.length && /\s/.test(line[cursor.col])) cursor.col += 1;
    const atEnd = cursor.col >= line.length || line[cursor.col] === "#";
    if (!atEnd || !multiline) return true;
    cursor.row += 1;
    cursor.col = 0;
  }
}

function parseString(cursor) {
  const line = cursor.lines[cursor.row];
  const quote = line[cursor.col];
  let out = "";
  let col = cursor.col + 1;
  while (col < line.length) {
    const char = line[col];
    if (char === quote) {
      cursor.col = col + 1;
      return out;
    }
    if (char !== "\\" || quote === "'") {
      out += char;
      col += 1;
      continue;
    }
    const next = line[col + 1];
    if (next in ESCAPES) {
      out += ESCAPES[next];
      col += 2;
    } else if (next === "u" || next === "U") {
      const length = next === "u" ? 4 : 8;
      const hex = line.slice(col + 2, col + 2 + length);
      const codePoint = parseInt(hex, 16);
      if (hex.length !== length || !/^[0-9A-Fa-f]+$/.test(hex) || codePoint > 0x10ffff) {
        throw new ManifestSyntaxError(cursor.row + 1, "invalid unicode escape");
      }
      out += String.fromCodePoint(codePoint);
      col += 2 + length;
    } else {
      throw new ManifestSyntaxError(cursor.row + 1, "invalid escape in string");
    }
  }
  throw new ManifestSyntaxError(cursor.row + 1, "unterminated string");
}

function parseArray(cursor) {
  const startRow = cursor.row;
  const unterminated = new ManifestSyntaxError(startRow + 1, "unterminated array");
  const items = [];
  cursor.col += 1;
  for (;;) {
    if (!skipFiller(cursor, true)) throw unterminated;
    if (cursor.lines[cursor.row][cursor.col] === "]") {
      cursor.col += 1;
      return items;
    }
    items.push(parseValue(cursor));
    if (!skipFiller(cursor, true)) throw unterminated;
    const char = cursor.lines[cursor.row][cursor.col];
    if (char === ",") {
      cursor.col += 1;
    } else if (char !== "]") {
      throw new ManifestSyntaxError(cursor.row + 1, "unsupported or invalid value");
    }
  }
}

function parseValue(cursor) {
  const line = cursor.lines[cursor.row];
  const char = line[cursor.col];
  if (char === '"' || char === "'") {
    if (line.startsWith(char.repeat(3), cursor.col)) {
      throw new ManifestSyntaxError(cursor.row + 1, "unsupported or invalid value");
    }
    return parseString(cursor);
  }
  if (char === "[") return parseArray(cursor);
  const match = line.slice(cursor.col).match(/^(true|false|[+-]?\d+(\.\d+)?)(?![\w.:-])/);
  if (!match) throw new ManifestSyntaxError(cursor.row + 1, "unsupported or invalid value");
  cursor.col += match[0].length;
  if (match[0] === "true") return true;
  if (match[0] === "false") return false;
  return Number(match[0]);
}

// herdr manifests are TOML, but no dependencies are allowed, so this parses
// only the subset a manifest uses (tables, bare keys, strings, numbers,
// booleans, arrays). It rejects other TOML features rather than guessing, so a
// manifest edit that breaks syntax fails CI instead of passing a regex.
function parseManifest(text) {
  const lines = text.split(/\r?\n/);
  const topLevel = {};
  let seen = new Set();
  let inTable = false;
  try {
    const cursor = { lines, row: 0, col: 0 };
    while (cursor.row < lines.length) {
      const trimmed = lines[cursor.row].trim();
      const lineNumber = cursor.row + 1;
      if (trimmed === "" || trimmed.startsWith("#")) {
        cursor.row += 1;
      } else if (trimmed.startsWith("[")) {
        if (!TABLE_HEADER.test(trimmed)) throw new ManifestSyntaxError(lineNumber, "invalid table header");
        seen = new Set();
        inTable = true;
        cursor.row += 1;
      } else {
        const prefix = lines[cursor.row].match(KEY_PREFIX);
        if (!prefix) throw new ManifestSyntaxError(lineNumber, "expected key = value");
        if (seen.has(prefix[1])) throw new ManifestSyntaxError(lineNumber, `duplicate key "${prefix[1]}"`);
        seen.add(prefix[1]);
        cursor.col = prefix[0].length;
        const value = parseValue(cursor);
        skipFiller(cursor, false);
        const rest = lines[cursor.row][cursor.col];
        if (rest !== undefined && rest !== "#") {
          throw new ManifestSyntaxError(cursor.row + 1, "unsupported or invalid value");
        }
        if (!inTable) topLevel[prefix[1]] = value;
        cursor.row += 1;
        cursor.col = 0;
      }
    }
  } catch (error) {
    if (error instanceof ManifestSyntaxError) return { ok: false, line: error.line, reason: error.message };
    throw error;
  }
  return { ok: true, topLevel };
}

function checkManifest(manifest, problems) {
  if (manifest == null) {
    problems.push("herdr-plugin.toml: not found");
    return null;
  }
  const parsed = parseManifest(manifest);
  if (!parsed.ok) {
    problems.push(`herdr-plugin.toml: line ${parsed.line}: ${parsed.reason}`);
    return null;
  }
  let version = null;
  for (const name of ["id", "name", "version", "min_herdr_version"]) {
    const value = parsed.topLevel[name];
    if (value === undefined || value === "") {
      problems.push(`herdr-plugin.toml: missing ${name}`);
    } else if (typeof value !== "string") {
      problems.push(`herdr-plugin.toml: ${name} must be a string`);
    } else if ((name === "version" || name === "min_herdr_version") && !SEMVER.test(value)) {
      problems.push(`herdr-plugin.toml: ${name} "${value}" is not X.Y.Z`);
    } else if (name === "version") {
      version = value;
    }
  }
  return version;
}

function checkPackage(pkg, problems) {
  if (pkg == null) {
    problems.push("package.json: not found");
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(pkg);
  } catch (error) {
    problems.push(`package.json: invalid JSON (${error.message})`);
    return null;
  }
  const version = parsed !== null && typeof parsed === "object" ? parsed.version : undefined;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    problems.push(`package.json: version ${JSON.stringify(version)} is not X.Y.Z`);
    return null;
  }
  return version;
}

function checkChangelog(changelog, problems) {
  if (changelog == null) {
    problems.push("CHANGELOG.md: not found");
    return null;
  }
  const heading = changelog
    .split(/\r?\n/)
    .find((line) => line.startsWith("## ") && !/^## \[?Unreleased\]?\s*$/.test(line));
  if (heading === undefined) {
    problems.push("CHANGELOG.md: no released version heading found");
    return null;
  }
  const match = heading.match(CHANGELOG_HEADING);
  if (!match) {
    problems.push(`CHANGELOG.md: heading "${heading}" is not "## X.Y.Z — YYYY-MM-DD"`);
    return null;
  }
  return match[1];
}

function checkTag(tag, problems) {
  if (tag === undefined || tag === null || tag === "") return null;
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!SEMVER.test(version)) {
    problems.push(`tag: "${tag}" is not vX.Y.Z`);
    return null;
  }
  return version;
}

export function checkVersions({ manifest, pkg, changelog, tag }) {
  const problems = [];
  const manifestVersion = checkManifest(manifest, problems);
  const packageVersion = checkPackage(pkg, problems);
  const changelogVersion = checkChangelog(changelog, problems);
  const tagVersion = checkTag(tag, problems);

  const found = [
    ["herdr-plugin.toml", manifestVersion, `version ${manifestVersion}`],
    ["package.json", packageVersion, `version ${packageVersion}`],
    ["CHANGELOG.md", changelogVersion, `## ${changelogVersion}`],
    ["tag", tagVersion, tag],
  ].filter(([, version]) => version !== null);

  if (new Set(found.map(([, version]) => version)).size > 1) {
    problems.push("versions disagree:");
    for (const [source, , shown] of found) problems.push(`${source}: ${shown}`);
  }

  return { ok: problems.length === 0, version: manifestVersion, problems };
}

function readOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function readRepoFiles(rootDir) {
  return {
    manifest: readOrNull(join(rootDir, "herdr-plugin.toml")),
    pkg: readOrNull(join(rootDir, "package.json")),
    changelog: readOrNull(join(rootDir, "CHANGELOG.md")),
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  if (args.length > 1) {
    console.error("usage: node scripts/check-version.js [tag]");
    process.exitCode = 2;
  } else {
    const rootDir = fileURLToPath(new URL("..", import.meta.url));
    const result = checkVersions({ ...readRepoFiles(rootDir), tag: args[0] });
    if (result.ok) {
      console.log(`version ${result.version} consistent`);
    } else {
      for (const problem of result.problems) console.error(problem);
      process.exitCode = 1;
    }
  }
}
