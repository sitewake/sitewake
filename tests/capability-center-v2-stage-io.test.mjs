import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

async function load(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const stageIO = await load("../lib/capability-center-v2/stage-io.ts");

const manifest = (overrides = {}) => ({
  id: "stage_test",
  title: "Test",
  purpose: "Test",
  effect: "write",
  resumePolicy: "reconcile-before-retry",
  io: { reads: { input: ["query"], state: ["targets.query"] }, writes: { state: ["targets.query"], output: ["result"] } },
  navigation: "optional",
  ...overrides,
});

test("Stage I/O normalization is deterministic and deduplicated", () => {
  assert.deepEqual(stageIO.normalizeCapabilityStageIO({
    reads: { input: [" query", "query", "targets"], state: ["targets.query"] },
    writes: { state: ["targets.query", "targets.query"], output: ["z", "a"] },
  }), {
    reads: { input: ["query", "targets"], state: ["targets.query"] },
    writes: { state: ["targets.query"], output: ["a", "z"] },
  });
});

test("undeclared state/output writes are rejected at the Stage boundary", () => {
  assert.throws(
    () => stageIO.assertCapabilityStageResultIO(manifest(), { outcome: "Continue", state: { secret: true } }, "stage_test"),
    /capability_stage_state_write_undeclared:stage_test:secret/,
  );
  assert.throws(
    () => stageIO.assertCapabilityStageResultIO(manifest(), { outcome: "Success", output: { result: { ok: true }, extra: true } }, "stage_test"),
    /capability_stage_output_write_undeclared:stage_test:extra/,
  );
});

test("empty output is a zero-write payload for Contracts without output fields", () => {
  assert.doesNotThrow(() => stageIO.assertCapabilityStageResultIO(
    manifest({ io: { reads: { input: [], state: [] }, writes: { state: [], output: [] } } }),
    { outcome: "Success", output: {} },
    "stage_test",
  ));
});

test("undeclared input/state reads fail instead of becoming silent undefined values", () => {
  const input = stageIO.capabilityScopedJson({ query: "notebook", hidden: "must-not-read" }, ["query"], "input", "stage_test");
  assert.equal(input.query, "notebook");
  assert.throws(() => input.hidden, /capability_stage_input_read_undeclared:stage_test:hidden/);

  const state = stageIO.capabilityScopedJson({ targets: { query: "notebook", secret: "must-not-read" } }, ["targets.query"], "state", "stage_test");
  assert.equal(state.targets.query, "notebook");
  assert.throws(() => state.targets.secret, /capability_stage_state_read_undeclared:stage_test:targets.secret/);
});

test("navigation is optional/required by manifest and only same-origin _self intents are valid", () => {
  assert.throws(
    () => stageIO.assertCapabilityStageResultIO(manifest({ navigation: "none" }), { outcome: "Continue", navigation: { url: "/next", target: "_self" } }, "stage_test"),
    /capability_stage_navigation_forbidden:stage_test/,
  );
  assert.throws(
    () => stageIO.assertCapabilityStageResultIO(manifest({ navigation: "required" }), { outcome: "Continue" }, "stage_test"),
    /capability_stage_navigation_required:stage_test/,
  );
  assert.throws(
    () => stageIO.assertCapabilityStageResultIO(manifest(), { outcome: "Success", output: { result: true }, navigation: { url: "/done", target: "_self" } }, "stage_test"),
    /capability_navigation_terminal_outcome:stage_test/,
  );
  assert.equal(stageIO.assertCapabilityNavigationUrl("https://target.test/start", { url: "/next", target: "_self" }, "stage_test"), "https://target.test/next");
  assert.throws(
    () => stageIO.assertCapabilityNavigationUrl("https://target.test/start", { url: "https://other.test/next", target: "_self" }, "stage_test"),
    /capability_navigation_origin_invalid:stage_test/,
  );
});
