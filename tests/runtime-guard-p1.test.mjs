import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
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

const [policy, lifecycle, stateEvents] = await Promise.all([
  load("../lib/site-knowledge/runtime-policy.ts"),
  load("../lib/http/stream-lifecycle.ts"),
  load("../client/user-agent-state.ts"),
]);

test("read-only runtime policy rejects browser mutations and teaching at the final boundary", () => {
  for (const action of ["click", "fill", "type", "select", "check", "press", "upload", "submit", "drag", "drop"]) {
    assert.throws(
      () => policy.assertRuntimeActionAllowed("read-only", action),
      new RegExp(`runtime_read_only_${action}_forbidden`),
    );
    assert.doesNotThrow(() => policy.assertRuntimeActionAllowed("full", action));
  }
  for (const action of ["observe", "query", "wait", "scroll", "navigate", "waitFor", "extract", "hover"]) {
    assert.doesNotThrow(() => policy.assertRuntimeActionAllowed("read-only", action));
  }
  assert.throws(() => policy.assertRuntimeTeachingAllowed("read-only"), /runtime_read_only_teach_forbidden/);
  assert.doesNotThrow(() => policy.assertRuntimeNavigationAllowed("read-only", "/search?q=agent", "https://example.org/"));
  assert.throws(
    () => policy.assertRuntimeNavigationAllowed("read-only", "https://example.com/", "https://example.org/"),
    /runtime_read_only_cross_origin_navigation_forbidden/,
  );
});

test("read-only readiness rejects a missing authoritative Release while full offline mode may use cache", async () => {
  await assert.rejects(
    policy.enforceRuntimeReleaseReadiness("read-only", false, Promise.reject(new Error("runtime_release_404"))),
    /runtime_release_404/,
  );
  await assert.rejects(
    policy.enforceRuntimeReleaseReadiness("full", true, Promise.reject(new Error("runtime_release_invalid"))),
    /runtime_release_invalid/,
  );
  await assert.doesNotReject(
    policy.enforceRuntimeReleaseReadiness("full", false, Promise.reject(new Error("runtime_release_timeout"))),
  );
  await assert.doesNotReject(
    policy.enforceRuntimeReleaseReadiness("read-only", false, Promise.resolve({ id: "authoritative-release" })),
  );
});

test("stream lifecycle settles only after consumption ends and settles once", async () => {
  let upstream;
  const settlements = [];
  const source = new ReadableStream({ start(controller) { upstream = controller; } });
  const stream = lifecycle.withStreamLifecycle(source, (value) => settlements.push(value));
  assert.deepEqual(settlements, []);
  const reader = stream.getReader();
  upstream.enqueue(new Uint8Array([1, 2, 3]));
  assert.deepEqual(await reader.read(), { done: false, value: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(settlements, []);
  upstream.close();
  assert.deepEqual(await reader.read(), { done: true, value: undefined });
  assert.deepEqual(settlements, [{ status: "completed", bytes: 3, reason: undefined }]);
  await reader.cancel("late-cancel");
  assert.equal(settlements.length, 1);
});

test("stream cancellation propagates upstream before releasing its lifecycle", async () => {
  let upstream;
  let cancelReason;
  const settlements = [];
  const source = new ReadableStream({
    start(controller) { upstream = controller; },
    cancel(reason) { cancelReason = reason; },
  });
  const reader = lifecycle.withStreamLifecycle(source, (value) => settlements.push(value)).getReader();
  upstream.enqueue(new Uint8Array([4, 5]));
  await reader.read();
  await reader.cancel("consumer-left");
  assert.equal(cancelReason, "consumer-left");
  assert.deepEqual(settlements, [{ status: "cancelled", bytes: 2, reason: "consumer-left" }]);
});

test("stream read errors settle once as errors", async () => {
  let upstream;
  const settlements = [];
  const reader = lifecycle.withStreamLifecycle(
    new ReadableStream({ start(controller) { upstream = controller; } }),
    (value) => settlements.push(value),
  ).getReader();
  const failure = new Error("upstream-failed");
  upstream.error(failure);
  await assert.rejects(reader.read(), /upstream-failed/);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].status, "errored");
  assert.equal(settlements[0].bytes, 0);
  assert.equal(settlements[0].reason, failure);
});

test("stream lifecycle deadline cancels a stalled upstream body", async () => {
  let cancelReason;
  const settlements = [];
  const reader = lifecycle.withStreamLifecycle(new ReadableStream({
    cancel(reason) { cancelReason = reason; },
  }), (value) => settlements.push(value), { timeoutMs: 10 }).getReader();
  await assert.rejects(reader.read(), /stream_timeout_after_10ms/);
  assert.equal(cancelReason?.name, "TimeoutError");
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].status, "errored");
});

test("SiteWake state handshake uses one typed window event", () => {
  const target = new EventTarget();
  const received = [];
  const others = [];
  target.addEventListener("sitewake:state", (event) => received.push(event.detail));
  // No second event name is dispatched under any earlier product spelling.
  for (const name of ["otherbrand:state", "oldname:state"]) target.addEventListener(name, (event) => others.push(event.detail));
  stateEvents.dispatchSiteWakeState(target, { state: "booting", siteAgentId: "acme" });
  stateEvents.dispatchSiteWakeState(target, { state: "ready", siteAgentId: "acme", releaseVersion: 12 });
  const expected = [
    { state: "booting", siteAgentId: "acme" },
    { state: "ready", siteAgentId: "acme", releaseVersion: 12 },
  ];
  assert.deepEqual(received, expected);
  assert.deepEqual(others, []);
});

test("runtime source contracts keep guards, privacy, streaming budget, and readiness at their real boundaries", async () => {
  const [port, client, modelRoute] = await Promise.all([
    readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8"),
    readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/site-agents/[siteAgentId]/model/v2/chat/completions/route.ts", import.meta.url), "utf8"),
  ]);

  const remote = port.slice(port.indexOf("private async executeRemoteCommand"), port.indexOf("private async restoreRun"));
  assert.match(remote, /assertRuntimeActionAllowed\(this\.options\.runtimeMode, op\)/);
  assert.match(remote, /assertRuntimeNavigationAllowed\(this\.options\.runtimeMode/);
  const standalone = port.slice(port.indexOf("private async executeCapabilityV2JavaScriptRuntime"), port.indexOf("private async executeCapabilityV2ById"));
  assert.match(standalone, /this\.options\.runtimeMode === "read-only"/);
  assert.match(standalone, /runtime_read_only_module_forbidden/);
  assert.match(port, /async teach\(goal: string\) \{\s*assertRuntimeTeachingAllowed/);
  assert.match(port, /async finishTeaching\(\) \{\s*assertRuntimeTeachingAllowed/);
  assert.match(port, /const connectionPromise = this\.options\.runtimeMode === "read-only"\s*\? Promise\.resolve\(\)/);
  assert.match(port, /await enforceRuntimeReleaseReadiness\(\s*this\.options\.runtimeMode,\s*Boolean\(bootExecutionPin\),\s*releasePromise/);
  assert.ok((port.match(/if \(!this\.passiveObservationAllowed\(\)\) return;/g) || []).length >= 4);
  assert.match(port, /if \(this\.passiveObservationAllowed\(\)\) void this\.submitObservation\(pending, snapshot\)/);

  assert.match(client, /dispatchState\("booting"\)/);
  assert.match(client, /dispatchState\("error"/);
  const initialApiAssignment = client.indexOf("\n  window.SiteWake = publicApi;", client.indexOf("const publicApi:"));
  const initialReady = client.indexOf("void activePort.ready().then", initialApiAssignment);
  assert.ok(initialApiAssignment >= 0 && initialReady > initialApiAssignment);
  assert.ok(client.indexOf("window.SiteWake = publicApi", initialApiAssignment) < initialReady);
  const readyBlock = client.slice(initialReady, client.indexOf("const beginLaunch", initialReady));
  assert.ok(readyBlock.indexOf("applyAgentConfig()") < readyBlock.indexOf('dispatchState("ready"'));
  assert.match(client, /config\.runtimeMode === "full" && activeAgentConfig\.features\.showTeachAfterFailure/);

  assert.match(modelRoute, /withStreamLifecycle\(response\.body/);
  assert.match(modelRoute, /budgetOwnedByStream = true/);
  assert.match(modelRoute, /if \(!budgetOwnedByStream\) budget\.release\(\)/);
  assert.doesNotMatch(modelRoute, /response\.clone\(\)\.text\(\)/);
});
