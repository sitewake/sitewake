#!/usr/bin/env node
// The public release gate: `npm run test:public`.
//
// Runs every suite under tests/*.test.mjs, then the unit suite.
//
// Two loaders, because one of them cannot read everything. Most suites run under
// --experimental-strip-types, which is faster and also tells us something worth
// knowing: that the exported tree can be loaded by node alone. The suites in
// NEEDS_TSX reach TypeScript that strip-only mode refuses — extensionless
// imports, constructor parameter properties — so they run under tsx, the way
// `test:unit` and `test:quickstart` already do.
//
// Running everything under one loader is how 15 working suites came to sit in a
// skip list: they failed with `Cannot find module` and
// `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, which reads like a broken suite, and the
// list made the question go away instead of answering it.
//
// KNOWN_FAILING was the list of suites that failed under either loader. It is
// empty, and the gate below refuses to let it grow again: a suite that fails is
// a suite to fix or delete, not one to list. The gate runs every suite in
// tests/, so a skip list is the only way to hide a red one, and there isn't one.
// The export script (scripts/export-public.mjs) runs this gate in the exported
// tree, so a release always has a real, green verification behind it.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NEEDS_TSX = [
  "tests/capability-center-v2-progressive-modules.test.mjs",
  "tests/capability-center-v2-notebook-mock.test.mjs",
  "tests/agent-style-presets.test.mjs",
  "tests/capability-business-result.test.mjs",
  // Reads the copy dictionary through lib/site-knowledge/errors.ts, whose chain uses
  // extensionless specifiers.
  "tests/site-agent-overview-errors.test.mjs",
  "tests/capability-center-v2-c1-mock.test.mjs",
  "tests/capability-center-v2-c2-mock.test.mjs",
  "tests/capability-center-v2-c2.test.mjs",
  "tests/capability-center-v2-recovery.test.mjs",
  "tests/capability-exploration-convergence.test.mjs",
  "tests/capability-sdk-execution.test.mjs",
  "tests/capability-v2-auth-bootstrap.test.mjs",
  "tests/capability-v2-experience-replay.test.mjs",
  "tests/capability-v2-javascript-author.test.mjs",
  "tests/capability-v2-javascript-stage-runner.test.mjs",
  "tests/capability-workspace-checkpoint.test.mjs",
  "tests/capability-workspace.test.mjs",
  "tests/console-navigation.test.mjs",
];

export const KNOWN_FAILING = [];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every suite the gate runs, split by the loader it needs. */
export function publicSuites(base = root) {
  const skipped = new Set(KNOWN_FAILING);
  const tsx = new Set(NEEDS_TSX);
  const all = readdirSync(join(base, "tests"))
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `tests/${name}`)
    .filter((path) => !skipped.has(path))
    .sort();
  return { strip: all.filter((path) => !tsx.has(path)), tsx: all.filter((path) => tsx.has(path)) };
}

function run(args) {
  console.log(`\n$ ${args.join(" ")}`);
  const result = spawnSync(args[0], args.slice(1), { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main() {
  // A listed file that no longer exists would silently shrink the debt register
  // instead of retiring it; in a public checkout the file is simply absent.
  const stale = KNOWN_FAILING.filter((path) => !existsSync(join(root, path)));
  if (stale.length && existsSync(join(root, "docs"))) {
    console.error(`test-public: remove from KNOWN_FAILING, the files no longer exist:\n  ${stale.join("\n  ")}`);
    process.exit(1);
  }
  // A suite in both lists would be skipped and claimed to run.
  const both = NEEDS_TSX.filter((path) => KNOWN_FAILING.includes(path));
  if (both.length) {
    console.error(`test-public: a suite cannot be both skipped and run under tsx:\n  ${both.join("\n  ")}`);
    process.exit(1);
  }
  // The register is empty and stays empty. Adding a line here is how a red
  // suite becomes invisible: the release would then be verified by a gate that
  // had been told to look away. Fix the suite, or delete it and say why.
  if (KNOWN_FAILING.length) {
    console.error(`test-public: KNOWN_FAILING must stay empty; fix or delete these suites instead of skipping them:\n  ${KNOWN_FAILING.join("\n  ")}`);
    process.exit(1);
  }
  const suites = publicSuites();
  console.log(`public gate: ${suites.strip.length + suites.tsx.length} suites (${suites.tsx.length} under tsx, ${KNOWN_FAILING.length - stale.length} known-failing suites skipped)`);
  // One suite at a time: several suites assert on wall-clock budgets and flake
  // under the CPU contention of node's default parallel run. A deterministic
  // gate is worth the extra couple of minutes.
  run([process.execPath, "--experimental-strip-types", "--test", "--test-concurrency=1", ...suites.strip]);
  if (suites.tsx.length) run([process.execPath, "--import", "tsx", "--test", "--test-concurrency=1", ...suites.tsx]);
  run(["npm", "run", "test:unit"]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
