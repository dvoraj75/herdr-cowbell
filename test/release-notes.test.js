import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { releaseNotes } from "../scripts/release-notes.js";

const INSTALL = (version) =>
  `## Install\n\n\`\`\`sh\nherdr plugin install dvoraj75/herdr-cowbell --ref v${version}\n\`\`\`\n`;

const CHANGELOG = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "- pending",
  "",
  "## 0.2.0 — 2026-11-01",
  "",
  "Second.",
  "",
  "### Fixed",
  "",
  "- a bug",
  "",
  "## 0.1.0 — 2026-10-30",
  "",
  "First.",
  "",
].join("\n");

test("finds a section and appends the install block", () => {
  const result = releaseNotes(CHANGELOG, "v0.1.0");
  assert.deepEqual(result, { ok: true, version: "0.1.0", notes: `First.\n\n${INSTALL("0.1.0")}` });
});

test("first of several sections stops before the next heading", () => {
  const result = releaseNotes(CHANGELOG, "v0.2.0");
  assert.equal(result.ok, true);
  assert.equal(result.notes, `Second.\n\n### Fixed\n\n- a bug\n\n${INSTALL("0.2.0")}`);
  assert.ok(!result.notes.includes("First."));
});

test("last section runs to the end of the file", () => {
  const result = releaseNotes("## 0.1.0 — 2026-10-30\n\nLine one.\nLine two.\n\n\n", "v0.1.0");
  assert.equal(result.notes, `Line one.\nLine two.\n\n${INSTALL("0.1.0")}`);
});

test("keeps ### subheadings in the body", () => {
  const result = releaseNotes(CHANGELOG, "0.2.0");
  assert.ok(result.notes.includes("### Fixed"));
});

test("reports a missing section", () => {
  assert.deepEqual(releaseNotes(CHANGELOG, "v0.3.0"), {
    ok: false,
    problem: 'CHANGELOG.md: no "## 0.3.0 — YYYY-MM-DD" section',
  });
});

test("rejects Unreleased in any spelling", () => {
  for (const tag of ["Unreleased", "unreleased", "vUnreleased", "[Unreleased]", "v[unreleased]"]) {
    const result = releaseNotes(CHANGELOG, tag);
    assert.equal(result.ok, false, tag);
    assert.match(result.problem, /Unreleased has no release/);
    assert.match(result.problem, /## X\.Y\.Z — YYYY-MM-DD/);
  }
});

test("tag with and without v give identical notes", () => {
  const withV = releaseNotes(CHANGELOG, "v0.1.0");
  const without = releaseNotes(CHANGELOG, "0.1.0");
  assert.deepEqual(withV, without);
  assert.ok(without.notes.includes("--ref v0.1.0\n"));
});

test("rejects tags that are not semver", () => {
  for (const tag of ["", "v1.2", "vv1.2.3", "1.2.3-rc1", "latest", "v1.2.3.4"]) {
    assert.deepEqual(releaseNotes(CHANGELOG, tag), { ok: false, problem: `tag "${tag}" is not vX.Y.Z` }, tag);
  }
});

test("rejects an empty section", () => {
  const result = releaseNotes("## 0.1.0 — 2026-10-30\n\n\n## 0.0.9 — 2026-10-01\n\nOld.\n", "v0.1.0");
  assert.deepEqual(result, { ok: false, problem: "CHANGELOG.md: section 0.1.0 is empty" });
});

test("rejects a heading that is not dated", () => {
  for (const heading of ["## 0.2.0", "## [0.2.0] - 2026-01-01", "## 0.2.0 - 2026-01-01"]) {
    const result = releaseNotes(`${heading}\n\nBody.\n`, "v0.2.0");
    assert.equal(result.ok, false, heading);
    assert.ok(result.problem.includes(`"${heading}"`), heading);
    assert.ok(result.problem.includes('"## 0.2.0 — YYYY-MM-DD"'), heading);
  }
});

test("ignores a version-like heading with extra digits", () => {
  for (const heading of ["## 0.1.0.1 — 2026-01-01", "## 0.1.01 — 2026-01-01"]) {
    assert.deepEqual(releaseNotes(`${heading}\n\nBody.\n`, "v0.1.0"), {
      ok: false,
      problem: 'CHANGELOG.md: no "## 0.1.0 — YYYY-MM-DD" section',
    }, heading);
  }
});

test("a ## line inside a fenced block stays in the body", () => {
  const text = "## 0.1.0 — 2026-10-30\n\nSample:\n\n```md\n## not a heading\n```\n\nAfter.\n\n## 0.0.9 — 2026-10-01\n\nOld.\n";
  const result = releaseNotes(text, "v0.1.0");
  assert.equal(result.ok, true);
  assert.equal(result.notes, `Sample:\n\n\`\`\`md\n## not a heading\n\`\`\`\n\nAfter.\n\n${INSTALL("0.1.0")}`);
});

test("a heading-shaped line inside a fence is not a duplicate", () => {
  const text = "## 0.2.0 — 2026-11-01\n\n~~~\n## 0.1.0 — 2026-10-30\n~~~\n\n## 0.1.0 — 2026-10-30\n\nReal.\n";
  const result = releaseNotes(text, "v0.1.0");
  assert.equal(result.ok, true);
  assert.equal(result.notes, `Real.\n\n${INSTALL("0.1.0")}`);
});

test("rejects a duplicate section", () => {
  const text = "## 0.1.0 — 2026-10-30\n\nOne.\n\n## 0.1.0 — 2026-10-31\n\nTwo.\n";
  const result = releaseNotes(text, "v0.1.0");
  assert.equal(result.ok, false);
  assert.match(result.problem, /section 0\.1\.0 appears 2 times/);
});

test("handles CRLF input", () => {
  const result = releaseNotes(CHANGELOG.replace(/\n/g, "\r\n"), "v0.2.0");
  assert.equal(result.ok, true);
  assert.equal(result.notes, `Second.\n\n### Fixed\n\n- a bug\n\n${INSTALL("0.2.0")}`);
});

test("reports a missing changelog", () => {
  assert.deepEqual(releaseNotes(null, "v0.1.0"), { ok: false, problem: "CHANGELOG.md: not found" });
  assert.deepEqual(releaseNotes(undefined, "v0.1.0"), { ok: false, problem: "CHANGELOG.md: not found" });
});

test("the real CHANGELOG.md yields notes for 0.1.0", () => {
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const result = releaseNotes(changelog, "0.1.0");
  assert.equal(result.ok, true);
  assert.ok(result.notes.startsWith("First release."));
  assert.ok(result.notes.includes("### Added"));
  assert.ok(result.notes.includes("### Known limitations"));
  assert.ok(!result.notes.includes("## Unreleased"));
  assert.ok(!result.notes.includes("## 0.1.0"));
  assert.ok(result.notes.endsWith(`\n\n${INSTALL("0.1.0")}`));
});
