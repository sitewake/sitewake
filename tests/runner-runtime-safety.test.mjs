import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
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

const safety = await load("../runner/runtime-safety.ts");

test("RunnerLeaseGuard aborts and awaits cleanup when the known lease expiry passes", async () => {
  const guard = new safety.RunnerLeaseGuard(new Date(Date.now() + 40).toISOString());
  let cleaned = false;
  guard.onInvalidate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    cleaned = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(guard.signal.aborted, true);
  assert.equal(guard.signal.reason.code, "runner_lease_expired_locally");
  assert.throws(() => guard.assertActive(), /expired before it could be renewed/);
  await guard.dispose();
  assert.equal(cleaned, true);
});

test("RunnerLeaseGuard renewal moves the local fail-closed deadline", async () => {
  const guard = new safety.RunnerLeaseGuard(new Date(Date.now() + 50).toISOString());
  assert.equal(guard.updateExpiry(new Date(Date.now() + 250).toISOString()), true);

  await new Promise((resolve) => setTimeout(resolve, 90));

  assert.equal(guard.signal.aborted, false);
  guard.assertActive();
  await guard.dispose();
});

test("coalescing async queue is serial, bounded, keeps the latest event and drains on close", async () => {
  const consumed = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const queue = safety.createCoalescingAsyncQueue(async (value) => {
    consumed.push(value);
    if (value === "first") await firstGate;
  });

  assert.equal(queue.push("first"), true);
  assert.equal(queue.push("superseded"), true);
  assert.equal(queue.push("latest"), true);
  assert.equal(queue.buffered, 2);

  const closing = queue.close();
  releaseFirst();
  await closing;

  assert.deepEqual(consumed, ["first", "latest"]);
  assert.equal(queue.buffered, 0);
  assert.equal(queue.push("too-late"), false);
});

test("terminal completion retries recover failures before and after the business commit", async () => {
  const beforeCommit = { attempts: 0, committed: false };
  const beforeResult = await safety.retryRunnerCompletion(async () => {
    beforeCommit.attempts += 1;
    if (beforeCommit.attempts === 1) throw new TypeError("network failed before write");
    beforeCommit.committed = true;
    return { duplicate: false };
  }, { retryDelaysMs: [0] });
  assert.deepEqual(beforeResult, { duplicate: false });
  assert.equal(beforeCommit.committed, true);
  assert.equal(beforeCommit.attempts, 2);

  const afterBusinessWrite = { attempts: 0, businessCommitted: false, leaseCompleted: false };
  const resumedResult = await safety.retryRunnerCompletion(async () => {
    afterBusinessWrite.attempts += 1;
    if (afterBusinessWrite.attempts === 1) {
      afterBusinessWrite.businessCommitted = true;
      throw new TypeError("response lost before central completion");
    }
    assert.equal(afterBusinessWrite.businessCommitted, true);
    afterBusinessWrite.leaseCompleted = true;
    return { duplicate: false, resumed: true };
  }, { retryDelaysMs: [0] });
  assert.deepEqual(resumedResult, { duplicate: false, resumed: true });
  assert.equal(afterBusinessWrite.leaseCompleted, true);

  const afterCentralCommit = { attempts: 0, completed: false };
  const duplicateResult = await safety.retryRunnerCompletion(async () => {
    afterCentralCommit.attempts += 1;
    if (afterCentralCommit.attempts === 1) {
      afterCentralCommit.completed = true;
      throw new TypeError("response lost after central completion");
    }
    assert.equal(afterCentralCommit.completed, true);
    return { duplicate: true };
  }, { retryDelaysMs: [0] });
  assert.deepEqual(duplicateResult, { duplicate: true });
  assert.equal(afterCentralCommit.attempts, 2);
});

test("terminal completion retry is bounded, classified and abortable", async () => {
  let nonRetryableAttempts = 0;
  await assert.rejects(
    safety.retryRunnerCompletion(async () => {
      nonRetryableAttempts += 1;
      throw new Error("fence rejected");
    }, {
      retryDelaysMs: [0, 0],
      shouldRetry: () => false,
    }),
    /fence rejected/,
  );
  assert.equal(nonRetryableAttempts, 1);

  const controller = new AbortController();
  let abortableAttempts = 0;
  const retrying = safety.retryRunnerCompletion(async () => {
    abortableAttempts += 1;
    throw new TypeError("network failed");
  }, {
    signal: controller.signal,
    retryDelaysMs: [1_000, 1_000],
  });
  controller.abort(new safety.RunnerLeaseLostError("runner_lease_lost_for_test"));
  await assert.rejects(retrying, /runner_lease_lost_for_test/);
  assert.equal(abortableAttempts, 1);
});

test("runner sanitizer redacts service host ports and IPv6 without exposing network identity", () => {
  const sanitized = safety.sanitizeRunnerMessage(
    "connect control-plane:3000, [2001:db8::1]:8443, 2001:db8::2 and api.internal.example:443 failed",
  );

  assert.equal(sanitized.includes("control-plane"), false);
  assert.equal(sanitized.includes("2001:db8"), false);
  assert.equal(sanitized.includes("api.internal.example"), false);
  assert.match(sanitized, /\[host\]/);
});

test("Playwright navigation network failures use the release-gate retry code", async () => {
  const runner = await readFile(new URL("../runner/browser-runner.ts", import.meta.url), "utf8");
  const implementation = runner.match(/function errorCode\(error: unknown\) \{([\s\S]*?)\n\}/);
  assert.ok(implementation, "runner error classification must remain directly testable");
  const classify = Function("error", implementation[1]);

  assert.equal(
    classify(new Error("page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3200/")),
    "network_error",
  );
  assert.equal(classify(new Error("page.goto: net::ERR_NAME_NOT_RESOLVED")), "network_error");

  const releaseGate = await readFile(new URL("../lib/site-knowledge/release-gate.ts", import.meta.url), "utf8");
  assert.match(releaseGate, /transient = new Set\(\[[^\]]*"network_error"/);
});

test("browser Runner wires lease loss into contexts, Codex, publication and bounded progress", async () => {
  const runner = await readFile(new URL("../runner/browser-runner.ts", import.meta.url), "utf8");

  assert.match(runner, /new RunnerLeaseGuard\(identity\.expiresAt\)/);
  assert.match(runner, /\[401, 403, 409\]\.includes\(error\.status\)/);
  assert.match(runner, /guard\.onInvalidate\(\(\) => closeRecordedContext\(context\)\)/);
  assert.match(runner, /signal: leaseGuard\.signal/);
  assert.match(runner, /leaseGuard\.assertActive\(\);\s*await completeRun/);
  assert.match(runner, /await leaseGuard\.beginCompletion\(\);\s*return retryRunnerCompletion/);
  assert.match(runner, /shouldComplete\s*\?\s*await retryRunnerCompletion/);
  assert.match(runner, /error\.status === 408 \|\| error\.status === 429 \|\| error\.status >= 500/);
  assert.match(runner, /createCoalescingAsyncQueue<HarnessEvent>/);
  assert.match(runner, /finally \{\s*await progressEvents\.close\(\);\s*\}/);
  assert.doesNotMatch(runner, /onEvent: \(event\) => \{ void reportProgress/);
});
