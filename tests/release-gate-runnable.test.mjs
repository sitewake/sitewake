/**
 * The release gate can be run.
 *
 * `verify:release` ended with `npm run architecture:check` for weeks after that
 * script was deliberately removed — the architecture model lives under `docs/`,
 * which is never exported, so it could not stay in the public `package.json`.
 * Whoever moved it took the script out and left the step in. The gate therefore
 * could not reach its own last step, which nobody noticed because a green CI
 * build was being read as the gate passing.
 *
 * A step naming a script that does not exist is a typo that only shows up when
 * someone runs the whole gate, which is exactly when there is no time for it.
 * This checks the names instead.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scripts = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")).scripts;

/** The npm scripts a composite script chains together, in order. */
export function referencedScripts(command) {
  return command.split("&&")
    .map((step) => /^\s*npm run ([a-zA-Z0-9:_-]+)\s*$/.exec(step)?.[1])
    .filter(Boolean);
}

const COMPOSITE = ["verify:release", "test", "test:public"];

test("every script the release gate chains together is defined", () => {
  const missing = [];
  for (const name of COMPOSITE) {
    if (!scripts[name]) continue;
    for (const referenced of referencedScripts(scripts[name])) {
      if (!scripts[referenced]) missing.push(`${name} -> ${referenced}`);
    }
  }
  assert.deepEqual(missing, [],
    `这些步骤引用了 package.json 里不存在的脚本，门禁跑到那一步才会发现：\n  ${missing.join("\n  ")}`);
});

test("the gate still has the steps that make it a gate", () => {
  // Removing a dangling step is the fix; quietly removing a real one is not.
  const steps = referencedScripts(scripts["verify:release"]);
  for (const required of ["audit:runtime", "typecheck:production", "build"]) {
    assert.ok(steps.includes(required), `verify:release 不再包含 ${required}`);
  }
  assert.ok(steps.some((step) => step.startsWith("test:")), "verify:release 不再运行任何测试");
});

test("the dependency audit is the one that reads the acceptance list", () => {
  // A bare `npm audit` fails on every advisory, which is what made the gate
  // unpassable and therefore skippable.
  assert.match(scripts["audit:runtime"], /scripts\/audit-runtime\.mjs/,
    "audit:runtime 必须走会读风险接受清单的那个脚本，而不是裸的 npm audit");
});

test("the architecture check is not referenced from an exported script", () => {
  // It validates docs/, which is never exported, so it cannot live in the public
  // package.json. Its internal entry point is documented under docs/.
  for (const [name, command] of Object.entries(scripts)) {
    assert.doesNotMatch(command, /architecture:check/,
      `${name} 引用了 architecture:check，而它已不是 npm 脚本`);
  }
});

test("no suite is skipped: the public gate has no debt register to hide behind", async () => {
  const { KNOWN_FAILING, NEEDS_TSX } = await import("../scripts/test-public.mjs");
  // A skip list is the only way a red suite can survive this gate, because the
  // gate otherwise runs everything in tests/. Keeping the list empty is what
  // makes "the gate passed" mean "every suite passed".
  assert.deepEqual(KNOWN_FAILING, [], "fix or delete a failing suite; do not list it");
  // NEEDS_TSX is not a debt register — those suites run, under the loader that
  // can read them — so it stays non-empty on purpose.
  assert.ok(NEEDS_TSX.length > 0);
  assert.ok(NEEDS_TSX.every((path) => path.startsWith("tests/") && path.endsWith(".test.mjs")));
});
