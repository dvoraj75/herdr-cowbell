import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { checkVersions, readRepoFiles } from "../scripts/check-version.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Pass `null` for a field to omit it. `extra` is appended verbatim.
function manifestText({ id = "x.y", name = "Y", version = "1.2.3", min_herdr_version = "0.9.2", extra = "" } = {}) {
  const fields = { id, name, version, min_herdr_version };
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key} = "${value}"`);
  return `${lines.join("\n")}\n${extra}`;
}

function pkgText(version = "1.2.3") {
  return JSON.stringify(version === null ? { name: "p" } : { name: "p", version });
}

function changelogText(heading = "## 1.2.3 — 2026-10-30", unreleased = false) {
  return `# Changelog\n\n${unreleased ? "## Unreleased\n\n- thing\n\n" : ""}${heading}\n\nFirst release.\n`;
}

function inputs(overrides = {}) {
  return { manifest: manifestText(), pkg: pkgText(), changelog: changelogText(), ...overrides };
}

test("consistent inputs are ok and report the version", () => {
  assert.deepEqual(checkVersions(inputs()), { ok: true, version: "1.2.3", problems: [] });
});

test("an Unreleased heading above the release heading is accepted", () => {
  const result = checkVersions(inputs({ changelog: changelogText("## 1.2.3 — 2026-10-30", true) }));
  assert.deepEqual(result, { ok: true, version: "1.2.3", problems: [] });
});

test("manifest and package.json mismatch lists both values", () => {
  const result = checkVersions(inputs({ pkg: pkgText("1.2.4") }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [
    "versions disagree:",
    "herdr-plugin.toml: version 1.2.3",
    "package.json: version 1.2.4",
    "CHANGELOG.md: ## 1.2.3",
  ]);
});

test("CHANGELOG mismatch names CHANGELOG.md and its version", () => {
  const result = checkVersions(inputs({ changelog: changelogText("## 1.2.2 — 2026-10-30") }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [
    "versions disagree:",
    "herdr-plugin.toml: version 1.2.3",
    "package.json: version 1.2.3",
    "CHANGELOG.md: ## 1.2.2",
  ]);
});

test("a matching tag is accepted with and without the v prefix", () => {
  for (const tag of ["v1.2.3", "1.2.3"]) {
    assert.deepEqual(checkVersions(inputs({ tag })), { ok: true, version: "1.2.3", problems: [] }, tag);
  }
});

test("empty and null tags are ignored", () => {
  for (const tag of [undefined, null, ""]) {
    assert.equal(checkVersions(inputs({ tag })).ok, true);
  }
});

test("a mismatching tag fails and is listed with its raw text", () => {
  const result = checkVersions(inputs({ tag: "v1.2.4" }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [
    "versions disagree:",
    "herdr-plugin.toml: version 1.2.3",
    "package.json: version 1.2.3",
    "CHANGELOG.md: ## 1.2.3",
    "tag: v1.2.4",
  ]);
});

test("a malformed tag is reported as not vX.Y.Z", () => {
  for (const tag of ["vfoo", "v1.2", "vv1.2.3"]) {
    const result = checkVersions(inputs({ tag }));
    assert.equal(result.ok, false, tag);
    assert.deepEqual(result.problems, [`tag: "${tag}" is not vX.Y.Z`], tag);
  }
});

test("each required manifest field is reported when missing", () => {
  for (const name of ["id", "name", "version", "min_herdr_version"]) {
    const result = checkVersions(inputs({ manifest: manifestText({ [name]: null }) }));
    assert.equal(result.ok, false, name);
    assert.ok(result.problems.includes(`herdr-plugin.toml: missing ${name}`), name);
  }
});

test("missing min_herdr_version is the only problem when the rest is consistent", () => {
  const result = checkVersions(inputs({ manifest: manifestText({ min_herdr_version: null }) }));
  assert.deepEqual(result, {
    ok: false,
    version: "1.2.3",
    problems: ["herdr-plugin.toml: missing min_herdr_version"],
  });
});

test("a field present only inside a table counts as missing", () => {
  const manifest = manifestText({ min_herdr_version: null, extra: '\n[[startup]]\nmin_herdr_version = "0.9.2"\n' });
  assert.deepEqual(checkVersions(inputs({ manifest })).problems, ["herdr-plugin.toml: missing min_herdr_version"]);
});

test("a table version does not shadow a missing top-level version", () => {
  const manifest = manifestText({ version: null, extra: '\n[[startup]]\nversion = "1.2.3"\n' });
  const result = checkVersions(inputs({ manifest }));
  assert.equal(result.version, null);
  assert.deepEqual(result.problems, ["herdr-plugin.toml: missing version"]);
});

test("an empty manifest field counts as missing", () => {
  const result = checkVersions(inputs({ manifest: manifestText({ id: "" }) }));
  assert.deepEqual(result.problems, ["herdr-plugin.toml: missing id"]);
});

test("a non-semver manifest version is reported and yields no version", () => {
  const result = checkVersions(inputs({ manifest: manifestText({ version: "1.2" }) }));
  assert.equal(result.ok, false);
  assert.equal(result.version, null);
  assert.deepEqual(result.problems, ['herdr-plugin.toml: version "1.2" is not X.Y.Z']);
});

test("a non-semver min_herdr_version is reported", () => {
  const result = checkVersions(inputs({ manifest: manifestText({ min_herdr_version: "0.9" }) }));
  assert.deepEqual(result.problems, ['herdr-plugin.toml: min_herdr_version "0.9" is not X.Y.Z']);
});

test("CHANGELOG headings that are not '## X.Y.Z — YYYY-MM-DD' quote the heading", () => {
  const headings = [
    "## v1.2.3 — 2026-10-30",
    "## 1.2 — 2026-10-30",
    "## 1.2.3 - 2026-10-30",
    "## 1.2.3 — 2026-10",
    "## 1.2.3",
  ];
  for (const heading of headings) {
    const result = checkVersions(inputs({ changelog: changelogText(heading) }));
    assert.equal(result.ok, false, heading);
    assert.deepEqual(
      result.problems,
      [`CHANGELOG.md: heading "${heading}" is not "## X.Y.Z — YYYY-MM-DD"`],
      heading,
    );
  }
});

test("CRLF line endings in the CHANGELOG are accepted", () => {
  const changelog = changelogText("## 1.2.3 — 2026-10-30", true).replace(/\n/g, "\r\n");
  assert.equal(checkVersions(inputs({ changelog })).ok, true);
});

test("a CHANGELOG with only an Unreleased heading has no released version", () => {
  const changelog = "# Changelog\n\n## Unreleased\n\n- thing\n";
  const result = checkVersions(inputs({ changelog }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, ["CHANGELOG.md: no released version heading found"]);
});

test("invalid package.json JSON is reported", () => {
  const result = checkVersions(inputs({ pkg: "{not json" }));
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /^package\.json: invalid JSON \(.+\)$/);
});

test("package.json without a string semver version is reported", () => {
  assert.deepEqual(checkVersions(inputs({ pkg: pkgText(null) })).problems, [
    "package.json: version undefined is not X.Y.Z",
  ]);
  assert.deepEqual(checkVersions(inputs({ pkg: '{"version": 1}' })).problems, [
    "package.json: version 1 is not X.Y.Z",
  ]);
  assert.deepEqual(checkVersions(inputs({ pkg: "null" })).problems, [
    "package.json: version undefined is not X.Y.Z",
  ]);
});

test("null texts are reported as not found", () => {
  const result = checkVersions({ manifest: null, pkg: null, changelog: null });
  assert.equal(result.ok, false);
  assert.equal(result.version, null);
  assert.deepEqual(result.problems, [
    "herdr-plugin.toml: not found",
    "package.json: not found",
    "CHANGELOG.md: not found",
  ]);
});

test("readRepoFiles returns null for files that do not exist", () => {
  const missing = fileURLToPath(new URL("./does-not-exist-dir/", import.meta.url));
  assert.deepEqual(readRepoFiles(missing), { manifest: null, pkg: null, changelog: null });
});

test("the real repository files carry consistent versions", () => {
  const result = checkVersions(readRepoFiles(repoRoot));
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(result.version, pkg.version);
});
