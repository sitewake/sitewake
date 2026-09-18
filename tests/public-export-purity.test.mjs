import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { INTERNAL_MARKERS, isIgnoredPath, partitionByExport, scanForMarkers } from "../scripts/public-boundary.mjs";

// The public boundary: everything `git archive` exports must be free of the
// maintainers' internal references, and nothing shared may point at a path the
// archive leaves out. Both questions are answered from `.gitattributes`
// export-ignore — the same attribute `git archive` reads — so the guard can
// never disagree with the export.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { exported, ignored } = partitionByExport(root);
const exportedSet = new Set(exported);
const ignoredSet = new Set(ignored);

const ENTRY_DOCS = ["README.md", "README.zh-CN.md", "CONTRIBUTING.md", "SECURITY.md"];

/** True when `path` is an exported file or a directory holding exported files. */
function isExported(path) {
  const clean = path.replace(/\/$/, "");
  if (exportedSet.has(clean)) return true;
  const prefix = `${clean}/`;
  return exported.some((file) => file.startsWith(prefix));
}

test("the boundary is declared: .gitattributes marks the internal paths export-ignore", () => {
  assert.ok(exportedSet.has(".gitattributes"), ".gitattributes must exist and be exported");
  for (const path of ["docs", "AGENTS.md", ".cnb.yml", ".cnb", ".agents", ".openai", "demos", "demo", "scripts/internal"]) {
    assert.ok(!isExported(path), `${path} is exported; it must be export-ignored`);
  }
  // A public checkout has no ignored files at all — the boundary paths are
  // simply not there — so only the exported side is required to be non-empty.
  assert.ok(exported.length > 0, "expected exported files");
});

test("exported files contain no internal markers", (t) => {
  if (!INTERNAL_MARKERS.length) {
    t.skip("no marker list in this checkout (scripts/internal/markers.json is not exported)");
    return;
  }
  const hits = scanForMarkers(root, exported);
  const report = hits.map(({ path, marker, line }) => `${path}:${line}: ${marker}`).join("\n");
  assert.equal(hits.length, 0, `internal references in files that git archive exports:\n${report}`);
});

test("package.json scripts reference only exported paths", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const topLevel = new Set([...exported, ...ignored].map((file) => file.split("/")[0]).filter((dir) => !dir.includes(".")));
  const problems = [];
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    // Repo paths in a command look like `scripts/foo.mjs`, `tests/*.test.mjs`
    // or `docs/architecture/model`; URLs and flags never start with a top-level
    // directory of this repository.
    for (const match of command.matchAll(/(?<![\w@./-])([\w.-]+\/[\w./\-\[\]*]+)/g)) {
      const token = match[1];
      if (!topLevel.has(token.split("/")[0])) continue;
      // A glob is checked at its fixed directory: `tests/*.test.mjs` → tests,
      // `tests/unit/**/*.test.mjs` → tests/unit, `scripts/foo-*.mjs` → scripts.
      let path = token;
      if (token.includes("*")) {
        path = token.slice(0, token.indexOf("*"));
        if (!path.endsWith("/")) path = posix.dirname(path);
        path = path.replace(/\/$/, "");
      }
      if (isIgnoredPath(path, ignoredSet)) problems.push(`scripts.${name} → ${token} (export-ignored)`);
      else if (!isExported(path)) problems.push(`scripts.${name} → ${token} (missing)`);
    }
  }
  assert.deepEqual(problems, []);
});

test("entry documents link only to exported files", () => {
  const problems = [];
  for (const doc of ENTRY_DOCS) {
    const text = readFileSync(join(root, doc), "utf8");
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      const targets = [
        ...[...line.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]),
        ...[...line.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]),
      ];
      for (const raw of targets) {
        if (/^(https?:|mailto:|tel:|#|data:)/i.test(raw)) continue;
        const target = raw.replace(/[?#].*$/, "");
        if (!target) continue;
        const path = posix.normalize(posix.join(posix.dirname(doc), target));
        if (isIgnoredPath(path, ignoredSet)) problems.push(`${doc}:${index + 1} link → ${path} (export-ignored)`);
        else if (!isExported(path)) problems.push(`${doc}:${index + 1} link → ${path} (missing)`);
      }
    });
  }
  assert.deepEqual(problems, []);
});

test("the marker list is private and, where present, non-empty", (t) => {
  assert.ok(!isExported("scripts/internal/markers.json"), "the marker list must never be exported");
  if (!INTERNAL_MARKERS.length) {
    t.skip("no marker list in this checkout");
    return;
  }
  assert.ok(INTERNAL_MARKERS.length >= 6);
  // The guard scans itself too: no test or script may hold the literals.
  const here = readFileSync(fileURLToPath(import.meta.url), "utf8");
  for (const marker of INTERNAL_MARKERS) assert.ok(!here.toLowerCase().includes(marker.toLowerCase()), `test file contains marker ${marker}`);
});
