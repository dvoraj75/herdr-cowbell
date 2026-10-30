// Checks that herdr-plugin.toml, package.json and the top released CHANGELOG
// heading carry the same version, and optionally a release tag. The release
// workflow (#22) passes the pushed tag as the first argument so a mismatched
// tag fails before anything is published.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+$/;
const CHANGELOG_HEADING = /^## (\d+\.\d+\.\d+) — \d{4}-\d{2}-\d{2}\s*$/;

// Manifest fields are only read above the first table header, so a same-named
// key inside a [table] cannot shadow the top-level one.
function manifestField(topLevel, name) {
  const match = topLevel.match(new RegExp(`^${name} = "(.*)"\\s*$`, "m"));
  return match && match[1] !== "" ? match[1] : null;
}

function checkManifest(manifest, problems) {
  if (manifest == null) {
    problems.push("herdr-plugin.toml: not found");
    return null;
  }
  const topLevel = manifest.split(/^\[/m)[0];
  for (const name of ["id", "name", "version", "min_herdr_version"]) {
    const value = manifestField(topLevel, name);
    if (value === null) {
      problems.push(`herdr-plugin.toml: missing ${name}`);
    } else if ((name === "version" || name === "min_herdr_version") && !SEMVER.test(value)) {
      problems.push(`herdr-plugin.toml: ${name} "${value}" is not X.Y.Z`);
    }
  }
  const version = manifestField(topLevel, "version");
  return version !== null && SEMVER.test(version) ? version : null;
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
    .find((line) => line.startsWith("## ") && !/^## Unreleased\s*$/.test(line));
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
