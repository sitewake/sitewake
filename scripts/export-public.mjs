#!/usr/bin/env node
// Turns one tagged commit of this repository into the working tree of the
// public repository, without carrying any history or any file that
// `.gitattributes` marks export-ignore.
//
//   SITEWAKE_PUBLIC_CLONE=/path/to/public/clone node scripts/export-public.mjs public/v1.2.0
//   node scripts/export-public.mjs public/v1.2.0 --target /path/to/public/clone [--dry-run]
//
// The script writes the public clone and verifies the result there (marker scan,
// `npm ci`, then `npm run test:public`, which typechecks, builds and runs the
// public release gate). It never commits, tags or pushes: those commands are
// printed at the end for a person to run.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INTERNAL_MARKERS, partitionByExport, scanForMarkers } from "./public-boundary.mjs";

const PUBLIC_REMOTE = "github.com/sitewake/sitewake";
const TAG_PATTERN = /^public\/v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export class ExportError extends Error {}

function git(cwd, args, options = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
}

function parseArgs(argv) {
  const options = { tag: undefined, target: process.env.SITEWAKE_PUBLIC_CLONE?.trim() || undefined, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--target") options.target = argv[++i];
    else if (arg.startsWith("--target=")) options.target = arg.slice("--target=".length);
    else if (arg.startsWith("-")) throw new ExportError(`unknown option ${arg}`);
    else if (options.tag === undefined) options.tag = arg;
    else throw new ExportError(`unexpected argument ${arg}`);
  }
  return options;
}

/** The version a `public/vX.Y.Z` tag names, or an error naming the expected form. */
export function versionOfTag(tag) {
  const match = TAG_PATTERN.exec(String(tag ?? ""));
  if (!match) throw new ExportError(`expected a tag of the form public/vX.Y.Z (optionally -rc.N), got ${JSON.stringify(tag ?? "")}`);
  return match[1];
}

function assertCleanWorktree(cwd, label) {
  const status = git(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status.trim()) throw new ExportError(`${label} has uncommitted changes or untracked files:\n${status}`);
}

/** Everything that must hold before the public clone is touched. */
export function precheck({ source, tag, target }) {
  const version = versionOfTag(tag);

  let tagCommit;
  try {
    tagCommit = git(source, ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]).trim();
  } catch {
    throw new ExportError(`tag ${tag} does not exist in ${source}`);
  }
  const head = git(source, ["rev-parse", "HEAD"]).trim();
  if (tagCommit !== head) throw new ExportError(`tag ${tag} points at ${tagCommit.slice(0, 12)} but HEAD is ${head.slice(0, 12)}; check the tag out first`);
  assertCleanWorktree(source, "the source repository");

  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (pkg.version !== version) throw new ExportError(`package.json version is ${pkg.version} but the tag names ${version}`);

  const changelog = existsSync(join(source, "CHANGELOG.md")) ? readFileSync(join(source, "CHANGELOG.md"), "utf8") : "";
  const heading = new RegExp(`^## \\[?${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]?(\\s|$)`, "m");
  if (!heading.test(changelog)) throw new ExportError(`CHANGELOG.md has no entry for ${version} (expected a line starting with "## ${version}")`);

  if (!target) throw new ExportError("no public clone given: pass --target <dir> or set SITEWAKE_PUBLIC_CLONE");
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new ExportError(`public clone ${target} is not a directory`);
  if (!existsSync(join(target, ".git"))) throw new ExportError(`public clone ${target} is not a git repository`);
  const remotes = git(target, ["remote", "-v"]);
  if (!remotes.includes(PUBLIC_REMOTE)) throw new ExportError(`public clone ${target} has no remote pointing at ${PUBLIC_REMOTE}`);
  assertCleanWorktree(target, "the public clone");

  return { version, commit: tagCommit };
}

/** What `git archive <tag>` would emit: exported files and the top-level paths it leaves out. */
export function exportPlan(source, tag) {
  const { exported, ignored } = partitionByExport(source, git(source, ["ls-tree", "-r", "--name-only", "-z", tag]).split("\0").filter(Boolean));
  const ignoredTopLevel = [...new Set(ignored.map((path) => path.split("/")[0]))].sort();
  return { exported, ignored, ignoredTopLevel };
}

/** Replaces the public clone's tracked files with the archive of `tag`. */
export function writeExport({ source, tag, target }) {
  const tracked = git(target, ["ls-files", "-z"]).split("\0").filter(Boolean);
  if (tracked.length) {
    // Only tracked files go: .git, ignored and untracked files in the clone stay.
    const chunk = 500;
    for (let i = 0; i < tracked.length; i += chunk) {
      git(target, ["rm", "-q", "--force", "--", ...tracked.slice(i, i + chunk)]);
    }
  }
  const archive = execFileSync("git", ["archive", "--format=tar", tag], { cwd: source, maxBuffer: 1024 * 1024 * 1024 });
  const untar = spawnSync("tar", ["-x", "-C", target], { input: archive, stdio: ["pipe", "inherit", "inherit"] });
  if (untar.status !== 0) throw new ExportError(`tar exited with ${untar.status}`);
  // Staged, not committed: tests that read the tracked tree (`git ls-files`,
  // the executable bit on `setup`) must see the exported files, and the
  // commit itself stays a human action.
  git(target, ["add", "-A"]);
}

function run(cwd, command, args) {
  console.log(`\n$ ${command} ${args.join(" ")}   (in ${cwd})`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, CI: process.env.CI ?? "1" } });
  if (result.status !== 0) throw new ExportError(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}

/** Marker scan plus a standalone install, build and the public gate in the exported tree. */
export function verifyExport(target, { skipChecks = false } = {}) {
  const files = git(target, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const hits = scanForMarkers(target, files);
  if (hits.length) {
    const report = hits.map(({ path, marker, line }) => `  ${path}:${line}: ${marker}`).join("\n");
    throw new ExportError(`internal markers in the exported tree (${INTERNAL_MARKERS.join(", ")} must not appear):\n${report}`);
  }
  if (skipChecks) return;
  run(target, "npm", ["ci"]);
  run(target, "npm", ["run", "test:public"]);
}

export function nextCommands(version) {
  return [
    "git add -A",
    `git commit -m "Release v${version}"`,
    `git tag -a v${version} -m "SiteWake v${version}"`,
    `git push origin main v${version}`,
  ];
}

export async function main(argv = process.argv.slice(2), { source = resolve(dirname(fileURLToPath(import.meta.url)), ".."), skipChecks = false } = {}) {
  const options = parseArgs(argv);
  if (!options.tag) throw new ExportError("usage: export-public.mjs public/vX.Y.Z [--target <public clone>] [--dry-run]");
  const target = options.target ? resolve(options.target) : undefined;
  const { version, commit } = precheck({ source, tag: options.tag, target });
  const plan = exportPlan(source, options.tag);
  console.log(`${options.tag} → ${commit.slice(0, 12)}: ${plan.exported.length} files to export, ${plan.ignored.length} kept private`);
  console.log(`private top-level paths: ${plan.ignoredTopLevel.join(", ")}`);
  if (options.dryRun) {
    console.log("dry run: the public clone was not touched");
    return { version, dryRun: true, plan };
  }
  writeExport({ source, tag: options.tag, target });
  console.log(`wrote ${plan.exported.length} files into ${target}`);
  verifyExport(target, { skipChecks });
  console.log(`\nexport verified. In ${target}, run:\n`);
  for (const command of nextCommands(version)) console.log(`  ${command}`);
  console.log("");
  return { version, dryRun: false, plan };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`export-public: ${error instanceof ExportError ? error.message : error?.stack || error}`);
    process.exitCode = 1;
  });
}
