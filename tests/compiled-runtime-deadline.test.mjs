import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

async function bundledPortModule() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../client/user-agent-port.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    return await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

const {
  compiledRuntimeBudgetEvidence,
  compiledRuntimeRemainingMs,
  establishCompiledRuntimeWindow,
  withinCompiledRuntimeDeadline,
} = await bundledPortModule();

test("compiled runtime establishes one absolute 180 second and 100 request window", () => {
  const now = Date.parse("2026-08-13T00:00:00.000Z");
  const window = establishCompiledRuntimeWindow(undefined, undefined, now);
  assert.deepEqual(window, {
    startedAt: "2026-08-13T00:00:00.000Z",
    deadlineAt: "2026-08-13T00:03:00.000Z",
    activeLimitMs: 180_000,
    modelRequestLimit: 100,
    inheritedModelRequests: 0,
    noProgressCount: 0,
    exhaustedReason: undefined,
  });
  assert.equal(compiledRuntimeRemainingMs(window, now + 12_345), 167_655);
});

test("compiled runtime inherits a smaller PageAgent budget and never resets it on restore", () => {
  const now = Date.parse("2026-08-13T00:00:20.000Z");
  const inherited = {
    activeLimitMs: 30_000,
    modelRequestLimit: 2,
    activeElapsedMs: 12_000,
    modelRequests: 1,
    noProgressCount: 1,
  };
  const initial = establishCompiledRuntimeWindow(inherited, undefined, now);
  const restored = establishCompiledRuntimeWindow(undefined, initial, now + 5_000);
  assert.equal(restored.startedAt, "2026-08-13T00:00:08.000Z");
  assert.equal(restored.deadlineAt, "2026-08-13T00:00:38.000Z");
  assert.equal(restored.activeLimitMs, 30_000);
  assert.equal(compiledRuntimeRemainingMs(restored, now + 5_000), 13_000);
  assert.deepEqual(compiledRuntimeBudgetEvidence(restored, { requestCount: 2, pageExecutionRequests: 1 }, now + 5_000), {
    activeLimitMs: 30_000,
    modelRequestLimit: 2,
    activeElapsedMs: 17_000,
    modelRequests: 1,
    noProgressCount: 1,
    exhaustedReason: undefined,
  });
});

test("compiled repair evidence rejects a regressed server ledger instead of amplifying it", () => {
  const now = Date.parse("2026-08-13T00:00:00.000Z");
  const window = establishCompiledRuntimeWindow({
    activeLimitMs: 90_000,
    modelRequestLimit: 5,
    activeElapsedMs: 4_000,
    modelRequests: 3,
    noProgressCount: 0,
  }, undefined, now);
  assert.throws(
    () => compiledRuntimeBudgetEvidence(window, { requestCount: 4, pageExecutionRequests: 2 }, now),
    /compiled_runtime_budget_ledger_regressed/,
  );
  const forged = { ...window, deadlineAt: "2026-08-13T00:02:56.000Z" };
  const restored = establishCompiledRuntimeWindow(undefined, forged, now);
  assert.equal(restored.deadlineAt, "2026-08-13T00:01:26.000Z");
});

test("compiled awaits abort at the remaining absolute deadline", async () => {
  const started = Date.now();
  const window = establishCompiledRuntimeWindow({
    activeLimitMs: 25,
    modelRequestLimit: 10,
    activeElapsedMs: 0,
    modelRequests: 0,
    noProgressCount: 0,
  }, undefined, started);
  let observedAbort = false;
  await assert.rejects(
    withinCompiledRuntimeDeadline(window, (signal) => new Promise(() => {
      signal.addEventListener("abort", () => { observedAbort = true; }, { once: true });
    })),
    /page_agent_budget_exhausted:active-time/,
  );
  assert.equal(observedAbort, true);
  assert.ok(Date.now() - started < 500);
});

test("V2 runtime fetch, module, stage, judge, checkpoint and repair ledger share the window", async () => {
  const source = await readFile(fileURLToPath(new URL("../client/user-agent-port.ts", import.meta.url)), "utf8");
  assert.match(source, /const runtimeWindow = establishCompiledRuntimeWindow\(\);[\s\S]*getCapabilityV2Runtime\(capabilityId, input, runtimeWindow\)/);
  assert.match(source, /v2StageEvidence: stageEvidence,\s*compiledRuntimeWindow: runtimeWindow/);
  assert.match(source, /moduleSource = await this\.measureRuntime\("module.fetch", \(\) => this\.compiledAwait\(runtimeWindow, async \(signal\)/);
  assert.match(source, /loaded = await this\.measureRuntime\("module.import", \(\) => this\.compiledAwait\(runtimeWindow, async \(\) => import/);
  assert.match(source, /rawResult = await this\.measureRuntime\(`stage\.\$\{stage.id\}`, \(\) => this\.compiledAwait\(stageWindow, async \(signal\) => executeBrowserCapabilityStage/);
  assert.match(source, /const stageDeadlineAt = Number\.isFinite\(compiledDeadlineAt\)[\s\S]*Math\.min\(capabilityDeadlineAt, compiledDeadlineAt\)/);
  assert.match(source, /assertCompiledModelRequestAvailable\(session\.id, runtimeWindow\);\s*const decision = await this\.compiledAwait/);
  assert.match(source, /const ledger = await this\.runtimeModelLedger\(session\.id, runtimeWindow\);\s*driftBudget = compiledRuntimeBudgetEvidence\(runtimeWindow, ledger\)/);
  assert.doesNotMatch(source, /boundedInheritedPageExecutionBudget/);
});
