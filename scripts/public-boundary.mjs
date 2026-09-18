import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Strings that identify the maintainers' own deployments, hosts and tooling.
 * A file that `git archive` would export must not contain any of them. The
 * list itself is private — it would otherwise publish exactly the names it
 * exists to keep out — so it lives in scripts/internal/markers.json, which the
 * export omits. A public checkout therefore scans against an empty list, and
 * the guard test skips the marker check there; the guard does its work in the
 * maintainers' repository and in the export script, where the list exists.
 * Matching is case-insensitive. Add a marker to that file, never a second copy.
 */
export const INTERNAL_MARKERS = loadMarkers();

function loadMarkers() {
  try {
    const parsed = JSON.parse(readFileSync(new URL("./internal/markers.json", import.meta.url), "utf8"));
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string" && entry.trim())) {
      throw new Error("scripts/internal/markers.json must be a JSON array of non-empty strings");
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

const git = (root, args, input) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });

/** Every tracked path in the repository at `root`, as git stores it (forward slashes). */
export function trackedFiles(root) {
  return git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
}

/**
 * Splits tracked paths into the ones `git archive` exports and the ones it
 * omits. `git archive` prunes a subtree as soon as a directory entry carries
 * `export-ignore`, so every file is checked together with its ancestor
 * directories — the attribute is asked from git, the same source `git archive`
 * reads, so the two can never disagree.
 */
export function partitionByExport(root, files = trackedFiles(root)) {
  const exported = [];
  const ignored = [];
  if (!files.length) return { exported, ignored };
  const candidates = new Set();
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i <= parts.length; i += 1) candidates.add(parts.slice(0, i).join("/"));
  }
  const output = git(root, ["check-attr", "--stdin", "-z", "export-ignore"], `${[...candidates].join("\0")}\0`);
  // Output is NUL-separated triples: path, attribute, value.
  const marked = new Set();
  const fields = output.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 2] === "set") marked.add(fields[i]);
  }
  for (const file of files) (isIgnoredPath(file, marked) ? ignored : exported).push(file);
  return { exported, ignored };
}

/** True when a path, or any of its parent directories, is export-ignored. */
export function isIgnoredPath(path, ignored) {
  const set = ignored instanceof Set ? ignored : new Set(ignored);
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i += 1) {
    const prefix = parts.slice(0, i).join("/");
    if (set.has(prefix) || set.has(`${prefix}/`)) return true;
  }
  return false;
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

/**
 * Scans the given files (paths relative to `root`) for internal markers.
 * Returns one `{ path, marker, line }` per hit; an empty array means clean.
 */
export function scanForMarkers(root, files) {
  const hits = [];
  const patterns = INTERNAL_MARKERS.map((marker) => ({ marker, regex: new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }));
  for (const path of files) {
    let buffer;
    try {
      buffer = readFileSync(join(root, path));
    } catch {
      continue; // e.g. a path that exists in the index but not in the working tree
    }
    if (looksBinary(buffer)) continue;
    const lines = buffer.toString("utf8").split("\n");
    for (const { marker, regex } of patterns) {
      const index = lines.findIndex((line) => regex.test(line));
      if (index !== -1) hits.push({ path, marker, line: index + 1 });
    }
  }
  return hits;
}
