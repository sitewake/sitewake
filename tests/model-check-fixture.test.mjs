/**
 * The committed page-execution request must be what `@page-agent/core`
 * builds today. The wizard replays this file before `npm install`; if the
 * library changes its request shape and nobody regenerates the fixture, the
 * wizard would keep proving compatibility with a request production no longer
 * sends. This test is the only thing standing between those two.
 *
 * Normalization: the library stamps the wall clock into the user message.
 * `normalizeVolatile` pins that line on both sides (see
 * check-model-compatibility.mjs); `model` and `stream` are set per request at
 * replay time and are compared away here. Nothing else is masked — any other
 * difference is real drift.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { capturePageExecutionRequest, normalizeVolatile, serializeFixture, FIXTURE_PATH } from "../scripts/check-model-compatibility.mjs";

const REGENERATE = "npm run check:model-compat -- --write-fixture";

test("the committed fixture matches a fresh capture from @page-agent/core", async () => {
  const committed = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  const { captured } = await capturePageExecutionRequest();
  const { stream: _s1, model: _m1, ...fresh } = normalizeVolatile(captured);
  const { stream: _s2, model: _m2, ...stored } = committed;
  assert.deepStrictEqual(stored, fresh, `scripts/fixtures/page-execution-request.json is out of date. Regenerate it with: ${REGENERATE}`);
});

test("the fixture is a forced tool call, which is what the page stage must prove", async () => {
  const committed = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  assert.equal(committed.tool_choice?.type, "function");
  assert.ok(Array.isArray(committed.tools) && committed.tools.length > 0);
  assert.equal("stream" in committed, false, "stream is decided at replay time");
  assert.equal(committed.model, "capture");
});

test("serializeFixture is byte-stable across captures taken at different times", async () => {
  const { captured } = await capturePageExecutionRequest();
  const later = { ...captured, messages: captured.messages.map((message) => (
    typeof message.content === "string"
      ? { ...message, content: message.content.replace(/Current time: [^\n]*/, "Current time: 1/1/2030, 12:00:00 AM") }
      : message
  )) };
  assert.equal(serializeFixture(later), serializeFixture(captured));
  assert.match(serializeFixture(captured), /Current time: <pinned>/);
});

/**
 * The wizard's whole import chain must resolve without node_modules. A static
 * check on specifiers is cheap and catches the regression at review time,
 * before anyone tries a fresh clone.
 */
const ZERO_DEPENDENCY = [
  "scripts/setup.mjs",
  "scripts/model-check-core.mjs",
  "lib/model-check/core.mjs",
  "scripts/cli-copy.mjs",
];

test("the wizard's import chain uses only node: modules and relative files", async () => {
  const root = new URL("../", import.meta.url);
  const seen = {};
  for (const file of ZERO_DEPENDENCY) {
    const source = await readFile(fileURLToPath(new URL(file, root)), "utf8");
    const specifiers = [
      ...[...source.matchAll(/^\s*import\b[^"']*["']([^"']+)["']/gm)].map((match) => match[1]),
      ...[...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]),
    ];
    seen[file] = specifiers.length;
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../"), `${file} imports "${specifier}", which needs node_modules`);
    }
  }
  // The scan must actually see imports where they exist; cli-copy.mjs is the leaf and has none.
  assert.ok(seen["scripts/setup.mjs"] >= 8, `the import scan found only ${seen["scripts/setup.mjs"]} specifiers in setup.mjs`);
  assert.ok(seen["scripts/model-check-core.mjs"] >= 1);
});
