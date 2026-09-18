import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
let sequence = 0;

async function bundleDebugTrace() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../lib/capability-center-v2/debug-trace.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

async function bundleDebugStore() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../db/capability-debug-store.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

async function d1StoreFixture() {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `capability-debug-${++sequence}` },
  });
  const database = await miniflare.getD1Database("DB");
  const key = `__CAPABILITY_DEBUG_D1_${sequence}`;
  globalThis[key] = database;
  const result = await build({
    stdin: {
      contents: `export * from "./db/capability-center-v2-store.ts";`,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "debug-d1",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
          contents: `
            const database = globalThis[${JSON.stringify(key)}];
            export function getD1Binding() { return database; }
            export function getArtifactBinding() { return null; }
            export class D1UnavailableError extends Error {}
          `,
          loader: "ts",
        }));
      },
    }],
  });
  const store = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  return {
    store,
    database,
    dispose: async () => { delete globalThis[key]; await miniflare.dispose(); },
  };
}

test("capability-debug.v1 registry exposes concrete input and output schemas for every required module", async () => {
  const debug = await bundleDebugTrace();
  const ids = new Set(debug.CAPABILITY_DEBUG_MODULES.map((module) => module.id));
  for (const required of [
    "agent-run.authorize",
    "experience.compact",
    "experience.validate",
    "experience.abstract",
    "capability.dedupe",
    "runspec.build",
    "runner.dispatch",
    "browser.authenticate",
    "contract.design",
    "program.author",
    "module.persist",
    "quality.gate",
    "validation.replay",
    "validation.judge",
    "review.ai",
    "version.publish",
    "runtime.integrity",
    "runtime.stage",
    "runtime.handoff",
    "effect.project",
  ]) assert.equal(ids.has(required), true, `missing module ${required}`);
  assert.equal(debug.CAPABILITY_DEBUG_MODULES.every((module) => module.inputSchema.type === "object" && module.outputSchema.type === "object"), true);
  assert.equal(new Set(debug.CAPABILITY_DEBUG_MODULES.map((module) => module.id)).size, debug.CAPABILITY_DEBUG_MODULES.length);
});

test("debug envelope applies allowlist redaction, strips URL queries and summarizes oversized values", async () => {
  const debug = await bundleDebugTrace();
  const event = debug.makeDebugEvent({
    traceId: "usage:run-1:cap-1",
    traceKind: "usage",
    moduleId: "runtime.stage",
    lifecycle: "completed",
    siteId: "site-1",
    input: {
      urlBefore: "https://shop.test/orders?access_token=secret&account=alice",
      input: {
        password: "secret-password",
        authorization: "Bearer abc.def.ghi",
        note: "OTP: 123456",
        nested: { cookie: "sid=secret" },
      },
      unexpectedDebugField: "must-not-pass-the-module-allowlist",
    },
    message: "failed at https://shop.test/orders?access_token=secret token=abc123",
    error: { code: "runtime_failed", message: "password=hunter2 at https://shop.test/private?cookie=sid", retryable: false },
    evidence: { urlBefore: "https://shop.test/orders?session=secret", artifactIds: ["artifact-1"] },
  });
  const value = event.io.input.value;
  assert.equal(value.urlBefore, "https://shop.test/orders");
  assert.equal(value.input.password, "[redacted]");
  assert.equal(value.input.authorization, "[redacted]");
  assert.equal(value.input.nested.cookie, "[redacted]");
  assert.match(value.input.note, /redacted/i);
  assert.equal(value.unexpectedDebugField, undefined);
  assert.equal(event.message.includes("access_token"), false);
  assert.equal(event.message.includes("abc123"), false);
  assert.equal(event.error.message.includes("hunter2"), false);
  assert.equal(event.evidence.urlBefore, "https://shop.test/orders");
  for (const path of ["input.authorization", "input.nested.cookie", "input.note", "input.password", "message", "error.message", "evidence.urlBefore"]) {
    assert.equal(event.redaction.redactedPaths.includes(path), true, `missing redaction marker ${path}`);
  }

  const oversized = debug.debugValue("test.large", { rows: Array.from({ length: 20 }, (_, index) => ({ index, value: "x".repeat(1000) })) });
  assert.equal(oversized.value.value, undefined);
  assert.equal(oversized.value.omittedReason, "oversize");
  assert.match(oversized.value.hash, /^fnv1a:/);
  assert.ok(oversized.value.bytes > 16 * 1024);

  const authExperience = debug.debugValue("experience", {
    schemaVersion: "1.0",
    episodeId: "episode-auth",
    agentRunId: "run-auth",
    browserSessionId: "browser-secret",
    originalGoal: "登录账户",
    outcome: "Success",
    outcomeSummary: "alice@example.test 已登录",
    startPage: { url: "https://shop.test/login?next=/orders", title: "alice@example.test 登录" },
    endPage: { url: "https://shop.test/orders", title: "Orders" },
    actions: [{ action: "fill", input: { email: "alice@example.test" }, element: { label: "Account" }, page: { url: "https://shop.test/login" } }],
    output: { account: "alice@example.test" },
  });
  assert.equal(authExperience.value.value.browserSessionId, "[redacted]");
  assert.equal(authExperience.value.value.outcomeSummary, "[authentication-page-content-redacted]");
  assert.deepEqual(authExperience.value.value.actions, []);
  assert.deepEqual(authExperience.value.value.output, {});
  assert.equal(authExperience.value.value.startPage.title, undefined);
  assert.equal(authExperience.value.value.startPage.url, "https://shop.test/login");
});

test("node projection keeps the earliest failure as root cause and makes missing historical evidence explicit", async () => {
  const debug = await bundleDebugTrace();
  const base = { traceId: "generation:episode-1", traceKind: "generation", siteId: "site-1" };
  const events = [
    debug.makeDebugEvent({ ...base, eventId: "e1", occurredAt: "2026-08-13T01:00:00.000Z", moduleId: "request.receive", lifecycle: "completed", output: { accepted: true } }),
    debug.makeDebugEvent({ ...base, eventId: "e2", occurredAt: "2026-08-13T01:00:01.000Z", moduleId: "experience.abstract", lifecycle: "failed", error: { code: "model_timeout", message: "abstraction timed out", retryable: true } }),
    debug.makeDebugEvent({ ...base, eventId: "e3", occurredAt: "2026-08-13T01:00:02.000Z", moduleId: "effect.project", lifecycle: "failed", error: { code: "projection_failed", message: "secondary failure", retryable: true } }),
  ];
  const nodes = debug.projectDebugNodes(events, { expectedModuleIds: ["request.receive", "experience.abstract", "capability.dedupe"], terminal: true });
  assert.equal(nodes.find((node) => node.moduleId === "experience.abstract").error.rootCause, true);
  assert.equal(nodes.find((node) => node.moduleId === "effect.project").error.rootCause, false);
  assert.equal(nodes.find((node) => node.moduleId === "capability.dedupe").state, "unavailable");
  assert.equal(nodes.find((node) => node.moduleId === "capability.dedupe").dataQuality, "legacy");
  assert.deepEqual(debug.firstDebugFailure(events), { moduleId: "experience.abstract", code: "model_timeout", message: "abstraction timed out", eventId: "e2" });
});

test("terminal projection normalizes recovered progress without hiding the root-cause error", async () => {
  const debug = await bundleDebugTrace();
  const base = { traceId: "generation:episode-recovery", traceKind: "generation", siteId: "site-1" };
  const successful = [
    debug.makeDebugEvent({ ...base, eventId: "s1", occurredAt: "2026-08-13T01:00:00.000Z", moduleId: "runner.dispatch", lifecycle: "progress", input: { taskId: "task-1" } }),
    debug.makeDebugEvent({ ...base, eventId: "s2", occurredAt: "2026-08-13T01:00:01.000Z", moduleId: "runner.dispatch", lifecycle: "progress", output: { lease: "recovered" } }),
  ];
  const successfulNode = debug.projectDebugNodes(successful, { terminal: true, terminalStatus: "succeeded" }).find((node) => node.moduleId === "runner.dispatch");
  assert.equal(successfulNode.state, "succeeded");
  assert.equal(successfulNode.output.schemaRef, "runner.dispatch.output");

  const recovered = [
    debug.makeDebugEvent({ ...base, eventId: "r1", occurredAt: "2026-08-13T01:00:00.000Z", moduleId: "runner.dispatch", lifecycle: "progress" }),
    debug.makeDebugEvent({ ...base, eventId: "r2", occurredAt: "2026-08-13T01:00:02.000Z", moduleId: "runner.dispatch", lifecycle: "failed", error: { code: "runner_lost", message: "lease expired", retryable: true } }),
    debug.makeDebugEvent({ ...base, eventId: "r3", occurredAt: "2026-08-13T01:00:03.000Z", moduleId: "runner.dispatch", lifecycle: "completed", output: { lease: "reacquired" } }),
  ];
  const recoveredNode = debug.projectDebugNodes(recovered, { terminal: true, terminalStatus: "succeeded" }).find((node) => node.moduleId === "runner.dispatch");
  assert.equal(recoveredNode.state, "succeeded");
  assert.equal(recoveredNode.error.code, "runner_lost");
  assert.equal(recoveredNode.error.rootCause, true);
  assert.equal(recoveredNode.output.value.lease, "reacquired");
});

test("generation and usage traces remain separate and stage nodes keep their receipt identity", async () => {
  const debug = await bundleDebugTrace();
  const task = {
    id: "task-1", siteId: "site-1", versionId: "version-1", type: "Discovery", status: "Succeeded", goal: "查询订单",
    input: { parameters: {}, context: {}, interactions: [], trigger: {}, experience: { episodeId: "episode-1" } },
  };
  assert.equal(debug.taskTraceId(task), "generation:episode-1");
  const run = { id: "run-1", scope: { kind: "site", siteAgentId: "site-1" }, outcome: { evidence: { capabilityId: "cap-1", versionId: "version-1" } }, activityTimeline: [] };
  assert.equal(debug.usageTraceId(run), "usage:run-1:cap-1");
  assert.notEqual(debug.taskTraceId(task), debug.usageTraceId(run));
  const events = ["open", "submit"].map((stageId, index) => debug.makeDebugEvent({
    traceId: "usage:run-1:cap-1", traceKind: "usage", siteId: "site-1", moduleId: "runtime.stage", lifecycle: "completed",
    eventId: `stage-${index}`, correlation: { stageId }, output: { outcome: index ? "Success" : "Continue" },
  }));
  assert.deepEqual(debug.projectDebugNodes(events).map((node) => node.id), ["runtime.stage:open", "runtime.stage:submit"]);
});

test("task event normalization keeps authoring, validation creation, judge, and nested failure codes distinct", async () => {
  const debug = await bundleDebugTrace();
  const baseTask = {
    id: "task-1", siteId: "site-1", versionId: "version-1", type: "Discovery", status: "Running", goal: "生成能力",
    input: { parameters: {}, context: {}, interactions: [], trigger: {} },
  };
  const authoring = debug.debugEventFromTaskEvent(baseTask, { id: "author", eventType: "PhaseChanged", payload: { phase: "Authoring", message: "model turn" }, createdAt: "2026-08-13T01:00:00.000Z" });
  assert.equal(authoring.module.id, "program.author");

  const validation = { ...baseTask, id: "validation-1", type: "Validation", status: "Succeeded" };
  const created = debug.debugEventFromTaskEvent(validation, { id: "created", eventType: "TaskCreated", payload: {}, createdAt: "2026-08-13T01:00:01.000Z" });
  const completed = debug.debugEventFromTaskEvent(validation, { id: "completed", eventType: "TaskCompleted", payload: { phase: "ValidationCompleted" }, createdAt: "2026-08-13T01:00:02.000Z" });
  assert.equal(created.module.id, "validation.create");
  assert.equal(completed.module.id, "validation.judge");

  const failed = debug.debugEventFromTaskEvent(baseTask, {
    id: "failed", eventType: "RunnerFailed",
    payload: { phase: "Failed", message: "目标不唯一", payload: { errorCode: "target_ambiguous", retryable: false } },
    createdAt: "2026-08-13T01:00:03.000Z",
  });
  assert.equal(failed.error.code, "target_ambiguous");
  assert.equal(failed.error.retryable, false);

  const rejected = debug.debugEventFromTaskEvent(validation, {
    id: "rejected", eventType: "ReviewDecisionStored",
    payload: { phase: "Reviewing", decision: "Rejected", reason: "证据不足" },
    createdAt: "2026-08-13T01:00:04.000Z",
  });
  assert.equal(rejected.module.id, "review.ai");
  assert.equal(rejected.lifecycle, "handled");
});

test("Case × Stage projection locates an evidenced failure and never invents a Stage for legacy gaps", async () => {
  const debugStore = await bundleDebugStore();
  const validation = {
    id: "validation-1", siteId: "site-1", versionId: "version-1", type: "Validation", status: "Failed", goal: "验证能力",
    input: { parameters: {}, context: { validationCases: [{ product: "A" }, { product: "B" }] }, interactions: [], trigger: {} },
    error: { code: "stage_failed", message: "submit failed", retryable: false, stepId: "submit" },
    createdAt: "2026-08-13T01:00:00.000Z", updatedAt: "2026-08-13T01:00:03.000Z",
  };
  const version = { program: { stages: [{ id: "open", title: "Open" }, { id: "submit", title: "Submit" }] } };
  const events = new Map([[validation.id, [
    { id: "case-1", eventType: "PhaseChanged", sequence: 1, createdAt: "2026-08-13T01:00:01.000Z", payload: { phase: "Validating", message: "验证样例 1 已通过", payload: { caseIndex: 1 } } },
    { id: "case-2", eventType: "PhaseChanged", sequence: 2, createdAt: "2026-08-13T01:00:02.000Z", payload: { phase: "Validating", message: "正在回放验证样例 2", payload: { caseIndex: 2 } } },
  ]] ]);
  const matrix = debugStore.projectValidationMatrix([validation], version, events);
  const state = (caseId, stageId) => matrix.cells.find((cell) => cell.caseId === caseId && cell.stageId === stageId)?.state;
  assert.equal(state("case-1", "open"), "succeeded");
  assert.equal(state("case-1", "submit"), "succeeded");
  assert.equal(state("case-2", "open"), "succeeded");
  assert.equal(state("case-2", "submit"), "failed");

  const unknown = debugStore.projectValidationMatrix([{ ...validation, error: { code: "runner_execution_failed", message: "unknown", retryable: true } }], version, events);
  assert.equal(unknown.cells.filter((cell) => cell.caseId === "case-2").every((cell) => cell.state === "unavailable"), true);
});

test("Repair and Rebuild stay independent Trace roots while Validation remains their child phase", async () => {
  const debugStore = await bundleDebugStore();
  const task = (id, type, rerunOfTaskId, mode) => ({
    id, type, rerunOfTaskId, siteId: "site-1", versionId: `version-${id}`, status: "Pending", goal: id,
    input: { parameters: {}, context: mode ? { __maintenanceMode: mode, __maintenanceCapabilityId: "cap-1" } : {}, interactions: [], trigger: {} },
    createdAt: "2026-08-13T01:00:00.000Z", updatedAt: "2026-08-13T01:00:00.000Z",
  });
  const generation = task("generation", "Discovery");
  const repair = task("repair", "Repair", generation.id, "Repair");
  const validation = task("validation", "Validation", repair.id, "Repair");
  const validationRetry = task("validation-retry", "Validation", validation.id, "Repair");
  const rebuild = task("rebuild", "Discovery", generation.id, "Rebuild");
  const tasks = new Map([generation, repair, validation, validationRetry, rebuild].map((item) => [item.id, item]));
  assert.equal(debugStore.debugTraceRootTaskFor(repair, tasks).id, repair.id);
  assert.equal(debugStore.debugTraceRootTaskFor(validation, tasks).id, repair.id);
  assert.equal(debugStore.debugTraceRootTaskFor(validationRetry, tasks).id, repair.id);
  assert.equal(debugStore.debugTraceRootTaskFor(rebuild, tasks).id, rebuild.id);
});

test("ccv2 task event sequencing is lossless under concurrency and paginates beyond 200", async () => {
  const { store, database, dispose } = await d1StoreFixture();
  try {
    const created = await store.createCapabilityTask("debug-sequence", {
      type: "Discovery",
      goal: "并发事件验证",
      input: { parameters: {}, context: {}, interactions: [], trigger: {}, candidateSummary: { name: "并发事件验证", description: "验证事件序号并发写入", aliases: [] } },
    });
    const count = 240;
    await Promise.all(Array.from({ length: count }, (_, index) => store.appendTaskEvent("debug-sequence", created.task.id, {
      id: `concurrent-${index}`,
      eventType: "PhaseChanged",
      payload: { phase: "Explore", message: `event-${index}` },
    })));
    const persisted = await database.prepare("SELECT sequence,id FROM ccv2_task_events WHERE site_id=? AND task_id=? ORDER BY sequence").bind("debug-sequence", created.task.id).all();
    assert.equal(persisted.results.length, count + 2, "TaskCreated and RunSpecBuilt plus every concurrent event must persist");
    assert.deepEqual(persisted.results.map((row) => Number(row.sequence)), Array.from({ length: count + 2 }, (_, index) => index + 1));
    assert.equal(new Set(persisted.results.map((row) => row.id)).size, count + 2);

    const first = await store.listTaskEventPage("debug-sequence", created.task.id, 0, 200);
    assert.equal(first.events.length, 200);
    assert.equal(first.hasMore, true);
    const second = await store.listTaskEventPage("debug-sequence", created.task.id, first.events.at(-1).sequence, 200);
    assert.equal(second.events.length, 42);
    assert.equal(second.hasMore, false);

    const duplicateA = await store.appendTaskEvent("debug-sequence", created.task.id, { id: "same-debug-event", eventType: "PhaseChanged", payload: { phase: "Review" } });
    const duplicateB = await store.appendTaskEvent("debug-sequence", created.task.id, { id: "same-debug-event", eventType: "PhaseChanged", payload: { phase: "Publish" } });
    assert.equal(duplicateA.sequence, duplicateB.sequence);
    const duplicateRows = await database.prepare("SELECT COUNT(*) AS count FROM ccv2_task_events WHERE id='same-debug-event'").all();
    assert.equal(Number(duplicateRows.results[0].count), 1);
  } finally { await dispose(); }
});

test("debug SSE contract resumes from Last-Event-ID and emits opaque event ids", async () => {
  const source = await readFile(fileURLToPath(new URL("../app/api/admin/capability-v2/debug/[...path]/route.ts", import.meta.url)), "utf8");
  const store = await readFile(fileURLToPath(new URL("../db/capability-debug-store.ts", import.meta.url)), "utf8");
  assert.match(source, /request\.headers\.get\("last-event-id"\)/);
  assert.match(source, /id: \$\{cursor\}/);
  assert.match(source, /event: trace/);
  assert.match(source, /searchParams\.get\("cursor"\)/);
  assert.match(source, /heartbeat/);
  assert.match(store, /toString\("base64url"\)/);
  assert.doesNotMatch(store, /nextCursor:\s*\d+/);
});
