import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

async function bundledModule(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    external: ["cloudflare:workers"],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

async function bundledBindingRoute() {
  const stubs = new Map([
    ["@/db/runner-control-store", `
      export const configuredRunnerProjectionMode = () => "full";
      export const upsertRunnerPlacementBinding = async (input) => {
        globalThis.__runnerBindingMutationCalls = (globalThis.__runnerBindingMutationCalls || 0) + 1;
        return { input };
      };
      export const deleteRunnerPlacementBinding = async (input) => {
        globalThis.__runnerBindingMutationCalls = (globalThis.__runnerBindingMutationCalls || 0) + 1;
        return { input };
      };
    `],
    ["@/db/site-agent-store", `
      export const listSiteAgents = async () => ({ agents: [{ id: "site-binding-validation" }] });
    `],
    ["../../../../http", `
      export const runnerManagementAuthorized = async () => true;
      export const runnerManagementJson = (body, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    `],
  ]);
  const result = await build({
    entryPoints: [
      fileURLToPath(new URL(
        "../app/api/runner-management/runners/[runnerId]/bindings/[siteAgentId]/route.ts",
        import.meta.url,
      )),
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "runner-binding-route-stubs",
      setup(buildContext) {
        buildContext.onResolve({ filter: /.*/ }, (args) =>
          stubs.has(args.path) ? { path: args.path, namespace: "runner-binding-test" } : undefined);
        buildContext.onLoad({ filter: /.*/, namespace: "runner-binding-test" }, (args) => ({
          contents: stubs.get(args.path),
          loader: "js",
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

async function freshStore() {
  const databaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const store = await bundledModule("../db/runner-control-store.ts");
    store.resetMemoryRunnerControlStore();
    return store;
  } finally {
    if (databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = databaseUrl;
  }
}

test("runner sessions, slots, fences and completion are enforced by the central lease store", async () => {
  const store = await freshStore();
  const registered = await store.registerRunnerInstance({
    id: "runner-a",
    workKinds: ["execute"],
    maxConcurrency: 1,
  });
  assert.equal(registered.instance.poolId, "default");
  assert.equal(registered.instance.ephemeral, false);
  assert.equal(JSON.stringify(registered.instance).includes(registered.sessionToken), false);

  await store.heartbeatRunnerInstance("runner-a", {
    sessionId: registered.instance.sessionId,
    sessionToken: registered.sessionToken,
  });
  const first = await store.claimRunnerLease({
    runnerId: "runner-a",
    runnerSessionId: registered.instance.sessionId,
    sessionToken: registered.sessionToken,
    workload: { kind: "capability-run", id: "run-1", siteAgentId: "site-a" },
    workKind: "execute",
    work: { id: "run-1" },
  });
  assert.equal(first.lease.fence, 1);
  assert.equal(first.lease.slot, 0);
  assert.match(first.lease.activeSlotKey, new RegExp(registered.instance.sessionId));

  await assert.rejects(
    store.claimRunnerLease({
      runnerId: "runner-a",
      runnerSessionId: registered.instance.sessionId,
      sessionToken: registered.sessionToken,
      workload: { kind: "capability-run", id: "run-2", siteAgentId: "site-a" },
      workKind: "execute",
      work: { id: "run-2" },
    }),
    /runner_instance_capacity_exhausted/,
  );
  await assert.rejects(
    store.renewRunnerLease({
      runnerId: "runner-a",
      runnerSessionId: registered.instance.sessionId,
      sessionToken: registered.sessionToken,
      leaseId: first.lease.id,
      token: first.token,
      fence: first.lease.fence + 1,
    }),
    /runner_lease_fence_rejected/,
  );

  const drainingMutation = await store.setRunnerDesiredState("runner-a", "draining");
  assert.equal("sessionId" in drainingMutation.instance, false);
  assert.equal("heartbeatExpiresAt" in drainingMutation.instance, false);
  const drainingProjection = await store.getRunnerControlProjection({ mode: "aggregate" });
  assert.equal(drainingProjection.serviceStatus, "unavailable");
  const drainingFullProjection = await store.getRunnerControlProjection({ mode: "full" });
  assert.equal(drainingFullProjection.pool.observedState, "unavailable");
  assert.equal("sessionId" in drainingFullProjection.instances[0], false);
  assert.equal("heartbeatExpiresAt" in drainingFullProjection.instances[0], false);
  assert.equal("runnerSessionId" in drainingFullProjection.activeLeases[0], false);
  assert.equal("id" in drainingFullProjection.activeLeases[0], false);
  assert.equal("displayId" in drainingFullProjection.activeLeases[0], true);
  assert.equal("fence" in drainingFullProjection.activeLeases[0], false);
  assert.equal("activeWorkKey" in drainingFullProjection.activeLeases[0], false);
  assert.equal("activeSlotKey" in drainingFullProjection.activeLeases[0], false);
  assert.doesNotMatch(JSON.stringify(drainingFullProjection), new RegExp(first.lease.id));
  const renewed = await store.renewRunnerLease({
    runnerId: "runner-a",
    runnerSessionId: registered.instance.sessionId,
    sessionToken: registered.sessionToken,
    leaseId: first.lease.id,
    token: first.token,
    fence: first.lease.fence,
  });
  assert.equal(renewed.lease.status, "active");
  await assert.rejects(
    store.claimRunnerLease({
      runnerId: "runner-a",
      runnerSessionId: registered.instance.sessionId,
      sessionToken: registered.sessionToken,
      workload: { kind: "capability-run", id: "run-3", siteAgentId: "site-a" },
      workKind: "execute",
      work: { id: "run-3" },
    }),
    /runner_instance_draining/,
  );

  await store.beginRunnerLeaseCompletion({
    runnerId: "runner-a",
    runnerSessionId: registered.instance.sessionId,
    sessionToken: registered.sessionToken,
    leaseId: first.lease.id,
    token: first.token,
    fence: first.lease.fence,
  });
  const completed = await store.completeRunnerLease({
    runnerId: "runner-a",
    runnerSessionId: registered.instance.sessionId,
    sessionToken: registered.sessionToken,
    leaseId: first.lease.id,
    token: first.token,
    fence: first.lease.fence,
    status: "completed",
  });
  assert.equal(completed.lease.status, "completed");
  const duplicate = await store.completeRunnerLease({
    runnerId: "runner-a",
    runnerSessionId: registered.instance.sessionId,
    sessionToken: registered.sessionToken,
    leaseId: first.lease.id,
    token: first.token,
    fence: first.lease.fence,
    status: "completed",
  });
  assert.equal(duplicate.duplicate, true);
  const history = await store.listRunnerControlTasks({ status: "terminal" });
  assert.equal(history.total, 1);
  assert.equal(history.tasks[0].status, "terminal");
  assert.equal(history.tasks[0].terminalStatus, "completed");
  assert.equal(history.tasks[0].runnerId, "runner-a");
  assert.equal("leaseId" in history.tasks[0], false);
  assert.equal("id" in history.tasks[0].attempts[0], false);
  assert.equal("displayId" in history.tasks[0].attempts[0], true);
  assert.equal("runnerSessionId" in history.tasks[0], false);
  assert.equal("activeSlotKey" in history.tasks[0], false);
  assert.equal("token" in history.tasks[0], false);
  assert.doesNotMatch(JSON.stringify(history.tasks[0]), new RegExp(first.lease.id));
  assert.doesNotMatch(
    JSON.stringify(history.tasks[0]),
    /"leaseId"|"fence"|"runnerSessionId"|"activeWorkKey"|"activeSlotKey"/,
  );
});

test("administrative task cancellation releases its central Runner lease and capacity", async () => {
  const store = await freshStore();
  const runner = await store.registerRunnerInstance({
    id: "runner-admin-cancel",
    workKinds: ["author"],
    maxConcurrency: 1,
  });
  const grant = await store.claimRunnerLease({
    runnerId: runner.instance.id,
    runnerSessionId: runner.instance.sessionId,
    sessionToken: runner.sessionToken,
    workload: { kind: "capability-task", id: "task-admin-cancel", siteAgentId: "site-cancel" },
    workKind: "author",
    work: { id: "task-admin-cancel" },
  });

  const released = await store.releaseRunnerLeasesForWorkload({
    kind: "capability-task",
    id: "task-admin-cancel",
    siteAgentId: "site-cancel",
  });
  assert.equal(released.released, 1);
  const history = await store.listRunnerControlTasks({ status: "terminal" });
  assert.equal(history.tasks[0].terminalStatus, "released");

  const next = await store.claimRunnerLease({
    runnerId: runner.instance.id,
    runnerSessionId: runner.instance.sessionId,
    sessionToken: runner.sessionToken,
    workload: { kind: "capability-task", id: "task-after-cancel", siteAgentId: "site-cancel" },
    workKind: "author",
    work: { id: "task-after-cancel" },
  });
  assert.equal(next.lease.slot, grant.lease.slot);
});

test("a restarted runner rejects its previous session and late lease updates", async () => {
  const store = await freshStore();
  const original = await store.registerRunnerInstance({
    id: "runner-restart",
    workKinds: ["execute"],
  });
  const lease = await store.claimRunnerLease({
    runnerId: original.instance.id,
    runnerSessionId: original.instance.sessionId,
    sessionToken: original.sessionToken,
    workload: { kind: "capability-run", id: "run-restart", siteAgentId: "site-a" },
    workKind: "execute",
    work: {},
  });
  const restarted = await store.registerRunnerInstance({
    id: "runner-restart",
    workKinds: ["execute"],
  });
  assert.equal(restarted.instance.generation, original.instance.generation + 1);
  assert.notEqual(restarted.instance.sessionId, original.instance.sessionId);
  await assert.rejects(
    store.heartbeatRunnerInstance(original.instance.id, {
      sessionId: original.instance.sessionId,
      sessionToken: original.sessionToken,
    }),
    /runner_session_superseded/,
  );
  await assert.rejects(
    store.completeRunnerLease({
      runnerId: original.instance.id,
      runnerSessionId: original.instance.sessionId,
      sessionToken: original.sessionToken,
      leaseId: lease.lease.id,
      token: lease.token,
      fence: lease.lease.fence,
      status: "completed",
    }),
    /runner_session_superseded/,
  );
  const history = await store.listRunnerControlTasks({ status: "terminal" });
  assert.equal(history.tasks[0].terminalStatus, "expired");
  assert.equal(history.tasks[0].workload.id, "run-restart");
  const reclaimed = await store.claimRunnerLease({
    runnerId: restarted.instance.id,
    runnerSessionId: restarted.instance.sessionId,
    sessionToken: restarted.sessionToken,
    workload: { kind: "capability-run", id: "run-restart", siteAgentId: "site-a" },
    workKind: "execute",
    work: {},
  });
  assert.equal(reclaimed.lease.fence, lease.lease.fence + 1);
  const aggregated = await store.listRunnerControlTasks();
  assert.equal(aggregated.total, 1);
  assert.equal(aggregated.tasks[0].status, "active");
  assert.equal("leaseId" in aggregated.tasks[0], false);
  assert.equal(aggregated.tasks[0].attempts.length, 2);
  assert.equal(new Set(aggregated.tasks[0].attempts.map((attempt) => attempt.displayId)).size, 2);
  assert.doesNotMatch(
    JSON.stringify(aggregated.tasks[0]),
    new RegExp(`${lease.lease.id}|${reclaimed.lease.id}`),
  );
});

test("concurrent stable-id registrations advance generation without leaving both sessions current", async () => {
  const store = await freshStore();
  const original = await store.registerRunnerInstance({
    id: "runner-concurrent-register",
    workKinds: ["execute"],
  });
  const registrations = await Promise.all([
    store.registerRunnerInstance({ id: original.instance.id, workKinds: ["execute"] }),
    store.registerRunnerInstance({ id: original.instance.id, workKinds: ["execute"] }),
  ]);
  const ordered = registrations.toSorted((left, right) => left.instance.generation - right.instance.generation);
  assert.deepEqual(
    ordered.map((registration) => registration.instance.generation),
    [original.instance.generation + 1, original.instance.generation + 2],
  );
  await assert.rejects(
    store.heartbeatRunnerInstance(ordered[0].instance.id, {
      sessionId: ordered[0].instance.sessionId,
      sessionToken: ordered[0].sessionToken,
    }),
    /runner_session_superseded/,
  );
  const current = await store.heartbeatRunnerInstance(ordered[1].instance.id, {
    sessionId: ordered[1].instance.sessionId,
    sessionToken: ordered[1].sessionToken,
  });
  assert.equal(current.instance.generation, ordered[1].instance.generation);
});

test("queued retry state supersedes an expired attempt while preserving safe attempt history", async () => {
  const store = await freshStore();
  const leasedAt = "2026-01-01T00:00:00.000Z";
  const expiredAt = "2026-01-01T00:02:00.000Z";
  const lease = {
    id: "lease-expired",
    poolId: "default",
    workload: { kind: "learning-job", id: "learning-retry", siteAgentId: "site-a" },
    workKind: "author",
    runnerId: "runner-retry",
    runnerSessionId: "private-session",
    status: "expired",
    fence: 4,
    slot: 0,
    routing: "default",
    leasedAt,
    renewedAt: leasedAt,
    expiresAt: expiredAt,
    createdAt: leasedAt,
    updatedAt: expiredAt,
    completion: { status: "released", completedAt: expiredAt },
  };
  const queued = {
    id: "runner_task:learning-job:learning-retry",
    workload: lease.workload,
    siteAgentId: "site-a",
    workKind: "author",
    status: "queued",
    createdAt: leasedAt,
    updatedAt: "2026-01-01T00:03:00.000Z",
    attempts: [],
  };
  const tasks = store.projectRunnerControlTasks({
    leases: [lease],
    queued: [queued],
    browserRuns: [{
      id: "browser-attempt",
      learningJobId: "learning-retry",
      runnerId: "runner-retry",
      mode: "author",
      status: "failed",
      startedAt: "2026-01-01T00:01:00.000Z",
      endedAt: "2026-01-01T00:01:30.000Z",
    }],
  });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "queued");
  assert.equal(tasks[0].runnerId, undefined);
  assert.equal("leaseId" in tasks[0], false);
  assert.equal(tasks[0].expiresAt, undefined);
  assert.equal(tasks[0].attempts.length, 1);
  assert.equal(tasks[0].attempts[0].terminalStatus, "expired");
  assert.deepEqual(tasks[0].attempts[0].browserRuns.map((run) => run.id), ["browser-attempt"]);
  assert.doesNotMatch(JSON.stringify(tasks[0]), /private-session|activeSlotKey|token/);
});

test("execute BrowserRuns stay nested under their lease attempt", async () => {
  const store = await freshStore();
  const lease = {
    id: "lease-execute-browser",
    poolId: "default",
    workload: { kind: "capability-run", id: "capability-execute", siteAgentId: "site-a" },
    workKind: "execute",
    runnerId: "runner-execute",
    runnerSessionId: "private-session",
    status: "completed",
    fence: 1,
    slot: 0,
    routing: "default",
    leasedAt: "2026-01-01T00:00:00.000Z",
    renewedAt: "2026-01-01T00:01:00.000Z",
    expiresAt: "2026-01-01T00:02:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:30.000Z",
    completion: { status: "completed", completedAt: "2026-01-01T00:01:30.000Z" },
  };
  const tasks = store.projectRunnerControlTasks({
    leases: [lease],
    queued: [],
    browserRuns: [{
      id: "browser-execute",
      learningJobId: "capability_run:capability-execute",
      runnerId: "runner-execute",
      mode: "execute",
      status: "passed",
      startedAt: "2026-01-01T00:00:30.000Z",
      endedAt: "2026-01-01T00:01:20.000Z",
    }],
  });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].workload.kind, "capability-run");
  assert.deepEqual(tasks[0].attempts[0].browserRuns.map((run) => run.id), ["browser-execute"]);
});

test("failed capability tasks expose the real execution error without leaking lease authority", async () => {
  const store = await freshStore();
  const lease = {
    id: "private-lease-failed-execute",
    poolId: "default",
    workload: { kind: "capability-run", id: "capability-failed", siteAgentId: "site-a" },
    workKind: "execute",
    runnerId: "runner-execute",
    runnerSessionId: "private-session",
    status: "failed",
    fence: 1,
    slot: 0,
    routing: "default",
    leasedAt: "2026-01-01T00:00:00.000Z",
    renewedAt: "2026-01-01T00:00:01.000Z",
    expiresAt: "2026-01-01T00:02:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:02.000Z",
    completion: {
      status: "failed",
      completedAt: "2026-01-01T00:00:02.000Z",
      result: {
        run: {
          error: {
            code: "capability module/../../secret",
            summary: "failed at https://private.example/run C:\\workspace\\secret.txt TOKEN=super-secret\n    at private stack",
          },
        },
      },
    },
  };
  const [task] = store.projectRunnerControlTasks({ leases: [lease], queued: [] });
  assert.equal(task.failure.code, "runner_task_failed");
  assert.match(task.failure.message, /\[redacted-url\]/);
  assert.match(task.failure.message, /\[redacted-path\]/);
  assert.match(task.failure.message, /\[redacted-env\]/);
  assert.doesNotMatch(task.failure.message, /private\.example|workspace|super-secret|private stack/);
  assert.deepEqual(task.attempts[0].failure, task.failure);
  assert.doesNotMatch(JSON.stringify(task), /private-lease-failed-execute|private-session/);
});

test("concurrent completion retries converge on one transition and one duplicate", async () => {
  const store = await freshStore();
  const runner = await store.registerRunnerInstance({
    id: "runner-idempotent",
    workKinds: ["execute"],
  });
  const grant = await store.claimRunnerLease({
    runnerId: runner.instance.id,
    runnerSessionId: runner.instance.sessionId,
    sessionToken: runner.sessionToken,
    workload: { kind: "capability-run", id: "run-idempotent", siteAgentId: "site-a" },
    workKind: "execute",
    work: {},
  });
  const identity = {
    runnerId: runner.instance.id,
    runnerSessionId: runner.instance.sessionId,
    sessionToken: runner.sessionToken,
    leaseId: grant.lease.id,
    token: grant.token,
    fence: grant.lease.fence,
  };
  const begun = await Promise.all([
    store.beginRunnerLeaseCompletion(identity),
    store.beginRunnerLeaseCompletion(identity),
  ]);
  assert.deepEqual(begun.map((result) => result.duplicate).sort(), [false, true]);
  assert.deepEqual(begun.map((result) => result.inProgress).sort(), [false, true]);

  const completed = await Promise.all([
    store.completeRunnerLease({ ...identity, status: "completed" }),
    store.completeRunnerLease({ ...identity, status: "completed" }),
  ]);
  assert.deepEqual(completed.map((result) => result.duplicate).sort(), [false, true]);
  assert.ok(completed.every((result) => result.lease.status === "completed"));
});

test("begin completion grants a bounded finishing window before the business write", async () => {
  const store = await freshStore();
  const runner = await store.registerRunnerInstance({ id: "runner-completion-grace", workKinds: ["execute"] });
  const grant = await store.claimRunnerLease({
    runnerId: runner.instance.id,
    runnerSessionId: runner.instance.sessionId,
    sessionToken: runner.sessionToken,
    workload: { kind: "capability-run", id: "run-completion-grace", siteAgentId: "site-a" },
    workKind: "execute",
    work: {},
    ttlMs: 30_000,
  });
  const identity = {
    runnerId: runner.instance.id,
    runnerSessionId: runner.instance.sessionId,
    sessionToken: runner.sessionToken,
    leaseId: grant.lease.id,
    token: grant.token,
    fence: grant.lease.fence,
  };
  const beginning = await store.beginRunnerLeaseCompletion(identity);
  const grace = Date.parse(beginning.lease.expiresAt) - Date.now();
  assert.ok(grace >= 119_000 && grace <= 121_000);
  const completed = await store.completeRunnerLease({ ...identity, status: "completed" });
  assert.equal(completed.lease.status, "completed");
});

test("a stale completion lock is taken over and can finish the original attempt", async () => {
  const store = await freshStore();
  const runner = await store.registerRunnerInstance({
    id: "runner-completion-recovery",
    workKinds: ["execute"],
  });
  const grant = await store.claimRunnerLease({
    runnerId: runner.instance.id,
    runnerSessionId: runner.instance.sessionId,
    sessionToken: runner.sessionToken,
    workload: { kind: "capability-run", id: "run-completion-recovery", siteAgentId: "site-a" },
    workKind: "execute",
    work: {},
  });
  const identity = {
    runnerId: runner.instance.id,
    runnerSessionId: runner.instance.sessionId,
    sessionToken: runner.sessionToken,
    leaseId: grant.lease.id,
    token: grant.token,
    fence: grant.lease.fence,
  };
  const first = await store.beginRunnerLeaseCompletion(identity);
  const pending = await store.beginRunnerLeaseCompletion(identity, {
    now: new Date(Date.parse(first.lease.completionLockExpiresAt) - 1),
  });
  assert.equal(pending.duplicate, true);
  assert.equal(pending.inProgress, true);

  const resumed = await store.beginRunnerLeaseCompletion(identity, {
    now: new Date(Date.parse(first.lease.completionLockExpiresAt) + 1),
  });
  assert.equal(resumed.duplicate, false);
  assert.equal(resumed.inProgress, false);
  assert.equal(resumed.resumed, true);
  assert.ok(Date.parse(resumed.lease.completionLockExpiresAt) > Date.parse(first.lease.completionLockExpiresAt));

  const completed = await store.completeRunnerLease({ ...identity, status: "completed" });
  assert.equal(completed.lease.status, "completed");
  assert.equal(completed.lease.completionLockExpiresAt, undefined);
});

test("runner heartbeats preserve the separately authoritative desired state", async () => {
  const store = await freshStore();
  const runner = await store.registerRunnerInstance({
    id: "runner-desired-state",
    workKinds: ["execute"],
  });
  await store.setRunnerDesiredState(runner.instance.id, "draining");
  const heartbeat = await store.heartbeatRunnerInstance(runner.instance.id, {
    sessionId: runner.instance.sessionId,
    sessionToken: runner.sessionToken,
    readySlots: 1,
  });
  assert.equal(heartbeat.desiredState, "draining");
  assert.equal(heartbeat.instance.desiredState, "draining");

  const projection = await store.getRunnerControlProjection({ mode: "full" });
  assert.equal(projection.instances[0].desiredState, "draining");
  await assert.rejects(
    store.claimRunnerLease({
      runnerId: runner.instance.id,
      runnerSessionId: runner.instance.sessionId,
      sessionToken: runner.sessionToken,
      workload: { kind: "capability-run", id: "desired-state-work", siteAgentId: "site-a" },
      workKind: "execute",
      work: {},
    }),
    /runner_instance_draining/,
  );
});

test("central lease expiry synchronization updates the matching business mirror", async () => {
  const store = await freshStore();
  const statements = [];
  const lease = {
    id: "central-lease",
    poolId: "default",
    workload: { kind: "capability-run", id: "business-run", siteAgentId: "site-a" },
    workKind: "execute",
    runnerId: "runner-mirror",
    runnerSessionId: "runner-session",
    status: "active",
    fence: 1,
    slot: 0,
    leasedAt: "2026-01-01T00:00:00.000Z",
    renewedAt: "2026-01-01T00:01:00.000Z",
    expiresAt: "2026-01-01T00:03:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
  };
  const mirror = {
    id: "business-run",
    lease: {
      leaseId: lease.id,
      runnerSessionId: lease.runnerSessionId,
      expiresAt: "2026-01-01T00:02:00.000Z",
    },
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const database = {
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async all() {
          statements.push(this);
          return { success: true, results: [{ mirrorJson: JSON.stringify(mirror) }] };
        },
        async run() {
          statements.push(this);
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch() {
      throw new Error("unexpected_batch");
    },
  };

  await store.synchronizeBusinessLeaseMirrorExpiry(database, lease, lease.expiresAt);
  assert.equal(statements.length, 2);
  const update = statements[1];
  assert.match(update.sql, /lease_expires_at=\?/);
  assert.match(update.sql, /json_extract\(run_json,'\$\.lease\.leaseId'\)=\?/);
  assert.equal(update.values[0], lease.expiresAt);
  assert.equal(JSON.parse(update.values[1]).lease.expiresAt, lease.expiresAt);
  assert.deepEqual(update.values.slice(-2), [lease.id, lease.runnerSessionId]);

  const source = await readFile(new URL("../db/runner-control-store.ts", import.meta.url), "utf8");
  const renewBody = source.slice(
    source.indexOf("export async function renewRunnerLease"),
    source.indexOf("export async function beginRunnerLeaseCompletion"),
  );
  assert.match(renewBody, /synchronizeBusinessLeaseMirrorExpiry\(database, lease, lease\.expiresAt\)/);
});

test("runner candidate scanning reaches eligible work beyond two full pages", async () => {
  const store = await bundledModule("../db/site-agent-store.ts");
  const candidates = Array.from({ length: 250 }, (_, index) => ({
    id: `candidate-${String(index).padStart(3, "0")}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
  const loadedCursors = [];
  const visited = [];
  const result = await store.scanRunnerCandidates(
    async (cursor, pageSize) => {
      loadedCursors.push(cursor);
      const start = cursor
        ? candidates.findIndex((candidate) =>
          candidate.id === cursor.id && candidate.createdAt === cursor.createdAt) + 1
        : 0;
      return candidates.slice(start, start + pageSize);
    },
    async (candidate) => {
      visited.push(candidate.id);
      return candidate.id === "candidate-224" ? candidate : undefined;
    },
  );
  assert.equal(result.id, "candidate-224");
  assert.equal(visited.length, 225);
  assert.equal(loadedCursors.length, 3);
  assert.deepEqual(loadedCursors[2], candidates[199]);
});

test("concurrent claims cannot duplicate a workload or overbook a runner slot", async () => {
  const store = await freshStore();
  const firstRunner = await store.registerRunnerInstance({
    id: "runner-concurrent-a",
    workKinds: ["execute"],
    maxConcurrency: 1,
  });
  const secondRunner = await store.registerRunnerInstance({
    id: "runner-concurrent-b",
    workKinds: ["execute"],
    maxConcurrency: 1,
  });
  const claim = (registration, workloadId) => store.claimRunnerLease({
    runnerId: registration.instance.id,
    runnerSessionId: registration.instance.sessionId,
    sessionToken: registration.sessionToken,
    workload: { kind: "capability-run", id: workloadId, siteAgentId: "site-a" },
    workKind: "execute",
    work: {},
  });

  const sameWork = await Promise.allSettled([
    claim(firstRunner, "same-work"),
    claim(secondRunner, "same-work"),
  ]);
  assert.equal(sameWork.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(sameWork.filter((result) => result.status === "rejected").length, 1);

  const occupied = sameWork.find((result) => result.status === "fulfilled").value;
  const occupiedRegistration = occupied.lease.runnerId === firstRunner.instance.id
    ? firstRunner
    : secondRunner;
  await store.completeRunnerLease({
    runnerId: occupiedRegistration.instance.id,
    runnerSessionId: occupiedRegistration.instance.sessionId,
    sessionToken: occupiedRegistration.sessionToken,
    leaseId: occupied.lease.id,
    token: occupied.token,
    fence: occupied.lease.fence,
    status: "completed",
  });
  const slotRace = await Promise.allSettled([
    claim(occupiedRegistration, "slot-race-a"),
    claim(occupiedRegistration, "slot-race-b"),
  ]);
  assert.equal(slotRace.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(slotRace.filter((result) => result.status === "rejected").length, 1);
});

test("exclusive site bindings are many-to-many, work-kind scoped and never fall back", async () => {
  const store = await freshStore();
  const boundA = await store.registerRunnerInstance({
    id: "runner-bound-a",
    workKinds: ["execute", "author"],
  });
  const boundB = await store.registerRunnerInstance({
    id: "runner-bound-b",
    workKinds: ["execute"],
  });
  const shared = await store.registerRunnerInstance({
    id: "runner-shared",
    workKinds: ["execute"],
  });
  await store.putRunnerPlacementBinding({
    runnerId: boundA.instance.id,
    siteAgentId: "site-exclusive",
    workKind: "execute",
  });
  await store.putRunnerPlacementBinding({
    runnerId: boundB.instance.id,
    siteAgentId: "site-exclusive",
    workKind: "execute",
  });

  await assert.rejects(
    store.claimRunnerLease({
      runnerId: shared.instance.id,
      runnerSessionId: shared.instance.sessionId,
      sessionToken: shared.sessionToken,
      workload: { kind: "capability-run", id: "shared-no-fallback", siteAgentId: "site-exclusive" },
      workKind: "execute",
      work: {},
    }),
    /runner_placement_site_exclusive/,
  );
  await assert.rejects(
    store.claimRunnerLease({
      runnerId: boundA.instance.id,
      runnerSessionId: boundA.instance.sessionId,
      sessionToken: boundA.sessionToken,
      workload: { kind: "capability-run", id: "bound-no-cross-site", siteAgentId: "site-shared" },
      workKind: "execute",
      work: {},
    }),
    /runner_placement_runner_exclusive/,
  );
  const author = await store.claimRunnerLease({
    runnerId: boundA.instance.id,
    runnerSessionId: boundA.instance.sessionId,
    sessionToken: boundA.sessionToken,
    workload: { kind: "learning-job", id: "author-other-site", siteAgentId: "site-shared" },
    workKind: "author",
    work: {},
  });
  assert.equal(author.lease.routing, "default");
  const explicit = await store.claimRunnerLease({
    runnerId: boundB.instance.id,
    runnerSessionId: boundB.instance.sessionId,
    sessionToken: boundB.sessionToken,
    workload: { kind: "capability-run", id: "bound-site", siteAgentId: "site-exclusive" },
    workKind: "execute",
    work: {},
  });
  assert.equal(explicit.lease.routing, "explicit-binding");
});

test("site projections share one platform pool snapshot while bindings and leases stay isolated", async () => {
  const store = await freshStore();
  const siteA = await store.registerRunnerInstance({
    id: "runner-platform-site-a",
    workKinds: ["execute"],
  });
  const siteB = await store.registerRunnerInstance({
    id: "runner-platform-site-b",
    workKinds: ["execute"],
  });
  await store.putRunnerPlacementBinding({
    runnerId: siteA.instance.id,
    siteAgentId: "site-platform-a",
    workKind: "execute",
  });
  await store.putRunnerPlacementBinding({
    runnerId: siteB.instance.id,
    siteAgentId: "site-platform-b",
    workKind: "execute",
  });
  await store.claimRunnerLease({
    runnerId: siteA.instance.id,
    runnerSessionId: siteA.instance.sessionId,
    sessionToken: siteA.sessionToken,
    workload: { kind: "capability-run", id: "work-platform-a", siteAgentId: "site-platform-a" },
    workKind: "execute",
    work: {},
  });
  await store.claimRunnerLease({
    runnerId: siteB.instance.id,
    runnerSessionId: siteB.instance.sessionId,
    sessionToken: siteB.sessionToken,
    workload: { kind: "capability-run", id: "work-platform-b", siteAgentId: "site-platform-b" },
    workKind: "execute",
    work: {},
  });

  const projectionA = await store.getRunnerControlProjection({ siteAgentId: "site-platform-a", mode: "full" });
  const projectionB = await store.getRunnerControlProjection({ siteAgentId: "site-platform-b", mode: "full" });
  assert.deepEqual(projectionA.scope, { kind: "site", siteAgentId: "site-platform-a" });
  assert.deepEqual(projectionB.scope, { kind: "site", siteAgentId: "site-platform-b" });
  assert.deepEqual(projectionA.platformPool, projectionB.platformPool);
  assert.equal(projectionA.platformPool.instanceCount, 2);
  assert.equal(projectionA.platformPool.activeLeaseCount, 2);

  assert.deepEqual(projectionA.instances.map((instance) => instance.id), [siteA.instance.id]);
  assert.deepEqual(projectionB.instances.map((instance) => instance.id), [siteB.instance.id]);
  assert.deepEqual(projectionA.bindings.map((binding) => binding.siteAgentId), ["site-platform-a"]);
  assert.deepEqual(projectionB.bindings.map((binding) => binding.siteAgentId), ["site-platform-b"]);
  assert.deepEqual(projectionA.activeLeases.map((lease) => lease.workload.id), ["work-platform-a"]);
  assert.deepEqual(projectionB.activeLeases.map((lease) => lease.workload.id), ["work-platform-b"]);

  const globalProjection = await store.getRunnerControlProjection({ mode: "full" });
  assert.equal("scope" in globalProjection, false);
  assert.equal("platformPool" in globalProjection, false);
  const aggregate = await store.getRunnerControlProjection({ siteAgentId: "site-platform-a", mode: "aggregate" });
  assert.deepEqual(Object.keys(aggregate).sort(), ["generatedAt", "mode", "queueBand", "serviceStatus"]);
  const hidden = await store.getRunnerControlProjection({ siteAgentId: "site-platform-a", mode: "hidden" });
  assert.deepEqual(Object.keys(hidden).sort(), ["generatedAt", "mode"]);
});

test("site projections do not expose another site's shared-runner task state", async () => {
  const store = await freshStore();
  const shared = await store.registerRunnerInstance({
    id: "runner-site-task-isolation",
    workKinds: ["execute"],
    maxConcurrency: 2,
  });
  await store.heartbeatRunnerInstance(shared.instance.id, {
    sessionId: shared.instance.sessionId,
    sessionToken: shared.sessionToken,
    activity: {
      stage: "execute",
      phase: "running",
      message: "private site A activity",
      learningJobId: "private-learning-site-a",
    },
    lastError: {
      code: "private_site_a_error",
      message: "private site A previous failure",
      phase: "execute",
    },
  });
  await store.claimRunnerLease({
    runnerId: shared.instance.id,
    runnerSessionId: shared.instance.sessionId,
    sessionToken: shared.sessionToken,
    workload: { kind: "capability-run", id: "private-work-site-a", siteAgentId: "site-private-a" },
    workKind: "execute",
    work: {},
  });

  const siteA = await store.getRunnerControlProjection({ siteAgentId: "site-private-a", mode: "full" });
  const siteB = await store.getRunnerControlProjection({ siteAgentId: "site-private-b", mode: "full" });
  const globalProjection = await store.getRunnerControlProjection({ mode: "full" });
  assert.equal(siteA.instances[0].activeLeaseCount, 1);
  assert.equal(siteA.instances[0].availableSlots, 1);
  assert.equal(siteB.instances[0].activeLeaseCount, 0);
  assert.equal(siteB.instances[0].availableSlots, 2);
  assert.equal(siteB.summary.activeLeaseCount, 0);
  assert.equal(siteB.summary.availableSlots, 2);
  assert.equal(siteB.instances[0].activity, undefined);
  assert.equal(siteB.instances[0].lastError, undefined);
  assert.doesNotMatch(
    JSON.stringify(siteB),
    /private site A|private-learning-site-a|private_site_a_error|private-work-site-a/,
  );

  assert.equal(globalProjection.instances[0].activeLeaseCount, 1);
  assert.equal(globalProjection.instances[0].availableSlots, 1);
  assert.equal(globalProjection.instances[0].activity.learningJobId, "private-learning-site-a");
  assert.equal(globalProjection.instances[0].lastError.code, "private_site_a_error");
});

test("binding work-kind arrays are validated atomically before upsert or delete", async () => {
  const store = await freshStore();
  const runner = await store.registerRunnerInstance({
    id: "runner-binding-validation",
    workKinds: ["execute", "author", "validate"],
  });
  const bindingInput = {
    runnerId: runner.instance.id,
    siteAgentId: "site-binding-validation",
  };
  await store.upsertRunnerPlacementBinding({
    ...bindingInput,
    workKinds: ["validate"],
  });

  await assert.rejects(
    store.upsertRunnerPlacementBinding({
      ...bindingInput,
      workKinds: ["execute", "unknown"],
    }),
    /runner_binding_work_kind_invalid/,
  );
  let projection = await store.getRunnerControlProjection({ mode: "full" });
  assert.deepEqual(
    projection.bindings.map((binding) => binding.workKind),
    ["validate"],
  );

  await store.upsertRunnerPlacementBinding({
    ...bindingInput,
    workKinds: ["execute", "author"],
  });
  await assert.rejects(
    store.deleteRunnerPlacementBinding({
      ...bindingInput,
      workKinds: ["execute", "unknown"],
    }),
    /runner_binding_work_kind_invalid/,
  );
  await assert.rejects(
    store.deleteRunnerPlacementBinding({
      ...bindingInput,
      workKinds: [],
    }),
    /runner_binding_work_kind_invalid/,
  );
  projection = await store.getRunnerControlProjection({ mode: "full" });
  assert.deepEqual(
    projection.bindings.map((binding) => binding.workKind).sort(),
    ["author", "execute", "validate"],
  );

  await store.deleteRunnerPlacementBinding(bindingInput);
  projection = await store.getRunnerControlProjection({ mode: "full" });
  assert.deepEqual(projection.bindings, []);
});

test("runner binding routes reject mixed invalid work-kind arrays before calling the store", async () => {
  const route = await bundledBindingRoute();
  globalThis.__runnerBindingMutationCalls = 0;
  const context = {
    params: {
      runnerId: "runner-binding-validation",
      siteAgentId: "site-binding-validation",
    },
  };
  const request = (method, body) => new Request("https://example.test/runner-binding", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  for (const [handler, method] of [[route.PUT, "PUT"], [route.DELETE, "DELETE"]]) {
    const response = await handler(request(method, { workKinds: ["execute", "unknown"] }), context);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "runner_binding_work_kind_invalid");
  }
  const emptyDelete = await route.DELETE(request("DELETE", { workKinds: [] }), context);
  assert.equal(emptyDelete.status, 400);
  const malformedDelete = await route.DELETE(new Request("https://example.test/runner-binding", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: "{\"workKinds\":[\"execute\"",
  }), context);
  assert.equal(malformedDelete.status, 400);
  assert.equal((await malformedDelete.json()).error, "runner_binding_request_invalid");
  assert.equal(globalThis.__runnerBindingMutationCalls, 0);
  const deleteAll = await route.DELETE(request("DELETE", {}), context);
  assert.equal(deleteAll.status, 200);
  assert.equal((await deleteAll.json()).input.workKinds, undefined);
  assert.equal(globalThis.__runnerBindingMutationCalls, 1);
  delete globalThis.__runnerBindingMutationCalls;
});

test("ephemeral runners cannot receive persistent placement bindings", async () => {
  const store = await freshStore();
  const ephemeral = await store.registerRunnerInstance({ workKinds: ["execute"] });
  assert.equal(ephemeral.instance.ephemeral, true);
  await assert.rejects(
    store.putRunnerPlacementBinding({
      runnerId: ephemeral.instance.id,
      siteAgentId: "site-a",
      workKind: "execute",
    }),
    /runner_binding_ephemeral_instance/,
  );
});

test("runner roles are persisted and legacy mixed roles normalize to any", async () => {
  const store = await freshStore();
  const mixed = await store.registerRunnerInstance({
    id: "runner-mixed",
    role: "mixed",
  });
  assert.equal(mixed.instance.role, "any");
  assert.deepEqual(mixed.instance.workKinds, ["execute", "author", "validate"]);

  const background = await store.registerRunnerInstance({
    id: "runner-background",
    role: "background",
  });
  assert.equal(background.instance.role, "background");
  assert.deepEqual(background.instance.workKinds, ["author", "validate"]);
  const projected = await store.getRunnerControlProjection({ mode: "full" });
  assert.equal(projected.instances.find((instance) => instance.id === background.instance.id)?.role, "background");
});

test("runner registration and heartbeat normalize untrusted diagnostics without making history current", async () => {
  const store = await freshStore();
  await assert.rejects(
    store.registerRunnerInstance({ id: "../../invalid-runner" }),
    /runner_instance_id_invalid/,
  );
  const runner = await store.registerRunnerInstance({
    id: "runner-last-error",
    name: "Private https://runner.private.example C:\\secret\\runner HOME=/root/private\u0000",
    version: "https://version.private.example",
    browsers: ["chromium", "https://browser.private.example", "firefox", "bad/path"],
    workKinds: ["execute"],
    maxConcurrency: 2,
    prewarmCapacity: 99,
    readySlots: 99,
  });
  assert.equal(runner.instance.version, undefined);
  assert.deepEqual(runner.instance.capabilities.browsers, ["chromium", "firefox"]);
  assert.equal(runner.instance.capabilities.prewarmCapacity, 2);
  assert.equal(runner.instance.capabilities.readySlots, 2);
  assert.doesNotMatch(JSON.stringify(runner.instance), /https:\/\/runner\.private\.example|C:\\\\secret|HOME=|\\u0000/);

  const artifactIds = Array.from({ length: 25 }, (_, index) => `artifact_${index}`);
  const failed = await store.heartbeatRunnerInstance(runner.instance.id, {
    sessionId: runner.instance.sessionId,
    sessionToken: runner.sessionToken,
    readySlots: 999,
    activity: {
      stage: "author https://stage.private.example",
      phase: "failed",
      message: "See C:\\secret\\trace.log HOST=private.internal.example\u0007",
      learningJobId: "../../private-learning-job",
      artifactIds: [...artifactIds, "../../private-artifact"],
      tokenUsage: { input: -42, output: 9_999_999_999, cached: Number.POSITIVE_INFINITY },
    },
    lastError: {
      code: "browser_launch_failed",
      message: "Chromium could not start at https://error.private.example C:\\secret\\runner.ts TOKEN=private-token\nprivate stack",
      phase: "launch",
    },
  });
  assert.equal(failed.instance.observedState, "error");
  assert.equal(failed.instance.lastError.code, "browser_launch_failed");
  assert.equal(failed.instance.lastError.phase, "launch");
  assert.ok(Date.parse(failed.instance.lastError.at) > 0);
  assert.equal(failed.instance.activity.learningJobId, undefined);
  assert.equal(failed.instance.activity.artifactIds.length, 20);
  assert.deepEqual(failed.instance.activity.tokenUsage, {
    input: 0,
    output: 1_000_000_000,
    cached: 0,
  });
  assert.equal(failed.instance.capabilities.readySlots, 2);
  const errorAt = failed.instance.lastError.at;
  const unavailable = await store.getRunnerControlProjection({ mode: "aggregate" });
  assert.equal(unavailable.serviceStatus, "unavailable");

  const recovered = await store.heartbeatRunnerInstance(runner.instance.id, {
    sessionId: runner.instance.sessionId,
    sessionToken: runner.sessionToken,
    activity: null,
    lastError: {
      code: "browser_launch_failed",
      message: "Chromium could not start at https://error.private.example C:\\secret\\runner.ts TOKEN=private-token\nprivate stack",
      phase: "launch",
    },
  });
  assert.equal(recovered.instance.observedState, "idle");
  assert.equal(recovered.instance.availableSlots, 2);
  assert.deepEqual(recovered.instance.lastError, failed.instance.lastError);
  assert.equal(recovered.instance.lastError.at, errorAt);
  const serialized = JSON.stringify(recovered.instance);
  assert.doesNotMatch(serialized, /https:\/\/error\.private\.example|C:\\\\secret|TOKEN=|private-token|private stack|\\u0007/);
  const aggregate = await store.getRunnerControlProjection({ mode: "aggregate" });
  assert.equal(aggregate.serviceStatus, "available");
  assert.doesNotMatch(JSON.stringify(aggregate), /Chromium could not start|runner-last-error/);
});

test("public business projections strip only runner lease control identity", async () => {
  const store = await bundledModule("../db/site-agent-store.ts");
  const projected = store.projectPublicRunnerLeasedRecord({
    id: "public-work",
    lease: {
      runnerId: "runner-public",
      leasedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:02:00.000Z",
      token: "private-lease-token",
      tokenHash: "private-lease-hash",
      leaseId: "private-lease-id",
      runnerSessionId: "private-runner-session",
      fence: 12,
    },
  });
  assert.deepEqual(Object.keys(projected.lease).sort(), ["expiresAt", "leasedAt", "runnerId"]);
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /private-lease-token|private-lease-hash|private-lease-id|private-runner-session|fence|tokenHash/);
});

test("explicit legacy leases retain fifteen minutes while modern sessions stay at two minutes", async () => {
  const store = await freshStore();
  const legacy = await store.registerRunnerInstance({ id: "runner-legacy-ttl", workKinds: ["execute"] });
  const modern = await store.registerRunnerInstance({ id: "runner-modern-ttl", workKinds: ["execute"] });
  const startedAt = Date.now();
  const legacyGrant = await store.claimRunnerLease({
    runnerId: legacy.instance.id,
    legacy: true,
    workload: { kind: "capability-run", id: "legacy-ttl-work", siteAgentId: "site-a" },
    workKind: "execute",
    work: {},
  });
  const modernGrant = await store.claimRunnerLease({
    runnerId: modern.instance.id,
    runnerSessionId: modern.instance.sessionId,
    sessionToken: modern.sessionToken,
    workload: { kind: "capability-run", id: "modern-ttl-work", siteAgentId: "site-a" },
    workKind: "execute",
    work: {},
  });
  const legacyTtl = Date.parse(legacyGrant.lease.expiresAt) - startedAt;
  const modernTtl = Date.parse(modernGrant.lease.expiresAt) - startedAt;
  assert.ok(legacyTtl >= 899_000 && legacyTtl <= 901_000);
  assert.ok(modernTtl >= 119_000 && modernTtl <= 121_000);

  const renewedLegacy = await store.renewRunnerLease({
    runnerId: legacy.instance.id,
    legacy: true,
    leaseId: legacyGrant.lease.id,
    token: legacyGrant.token,
    fence: legacyGrant.lease.fence,
  });
  assert.ok(Date.parse(renewedLegacy.lease.expiresAt) - Date.now() >= 899_000);
});

test("lease authority defaults to central and only the server environment can roll back to business leases", async () => {
  const controlStore = await freshStore();
  const siteStore = await bundledModule("../db/site-agent-store.ts");
  const previous = process.env.SITEWAKE_RUNNER_LEASE_AUTHORITY;
  try {
    delete process.env.SITEWAKE_RUNNER_LEASE_AUTHORITY;
    assert.equal(controlStore.configuredRunnerLeaseAuthority(), "central");
    assert.equal(controlStore.configuredRunnerLeaseAuthority({ authority: "legacy" }), "central");
    const runner = await controlStore.registerRunnerInstance({
      id: "runner-authority-switch",
      workKinds: ["execute"],
    });
    const central = await siteStore.claimRunnerAuthorityLease({
      runnerId: runner.instance.id,
      runnerSessionId: runner.instance.sessionId,
      sessionToken: runner.sessionToken,
      workloadKind: "capability-run",
      workloadId: "central-authority-work",
      siteAgentId: "site-a",
      workKind: "execute",
      authority: "legacy",
    });
    assert.equal(central.authority, "central");
    const centralBusinessLease = siteStore.projectRunnerAuthorityBusinessLease(central);
    assert.ok(centralBusinessLease.leaseId);
    assert.ok(centralBusinessLease.runnerSessionId);
    assert.ok(Number.isInteger(centralBusinessLease.fence));
    await controlStore.completeRunnerLease({
      runnerId: runner.instance.id,
      runnerSessionId: runner.instance.sessionId,
      sessionToken: runner.sessionToken,
      leaseId: central.grant.lease.id,
      token: central.grant.token,
      fence: central.grant.lease.fence,
      status: "completed",
    });
    const centralTaskCount = (await controlStore.listRunnerControlTasks()).total;

    process.env.SITEWAKE_RUNNER_LEASE_AUTHORITY = "legacy";
    assert.equal(controlStore.configuredRunnerLeaseAuthority(), "legacy");
    const legacy = await siteStore.claimRunnerAuthorityLease({
      runnerId: runner.instance.id,
      runnerSessionId: runner.instance.sessionId,
      sessionToken: runner.sessionToken,
      workloadKind: "capability-run",
      workloadId: "legacy-authority-work",
      siteAgentId: "site-a",
      workKind: "execute",
    });
    assert.equal(legacy.authority, "legacy");
    const legacyBusinessLease = siteStore.projectRunnerAuthorityBusinessLease(legacy);
    assert.deepEqual(
      Object.keys(legacyBusinessLease).sort(),
      ["expiresAt", "leasedAt", "runnerId", "token"],
    );
    assert.equal((await controlStore.listRunnerControlTasks()).total, centralTaskCount);

    process.env.SITEWAKE_RUNNER_LEASE_AUTHORITY = "client-supplied-legacy";
    assert.equal(controlStore.configuredRunnerLeaseAuthority(), "central");
  } finally {
    if (previous === undefined) delete process.env.SITEWAKE_RUNNER_LEASE_AUTHORITY;
    else process.env.SITEWAKE_RUNNER_LEASE_AUTHORITY = previous;
  }
});

test("aggregate and hidden projections never expose exact runner data", async () => {
  const store = await freshStore();
  const runner = await store.registerRunnerInstance({
    id: "sensitive-runner-id",
    name: "private-runner-name",
    workKinds: ["execute"],
    maxConcurrency: 7,
  });
  await store.putRunnerPlacementBinding({
    runnerId: runner.instance.id,
    siteAgentId: "private-site-id",
    workKind: "execute",
  });

  const aggregate = await store.getRunnerControlProjection({ mode: "aggregate" });
  const serialized = JSON.stringify(aggregate);
  assert.equal(aggregate.mode, "aggregate");
  assert.deepEqual(Object.keys(aggregate).sort(), ["generatedAt", "mode", "queueBand", "serviceStatus"]);
  assert.doesNotMatch(serialized, /sensitive-runner-id|private-runner-name|private-site-id|maxConcurrency|instanceCount/);

  const hidden = await store.getRunnerControlProjection({ mode: "hidden" });
  assert.deepEqual(Object.keys(hidden).sort(), ["generatedAt", "mode"]);
});

test("a server visibility provider takes precedence over the environment without an HTTP setter", async () => {
  const store = await freshStore();
  const previous = process.env.SITEWAKE_RUNNER_VISIBILITY;
  process.env.SITEWAKE_RUNNER_VISIBILITY = "hidden";
  try {
    store.installRunnerVisibilityProvider({
      projectionMode: ({ siteAgentId }) => siteAgentId === "site-visible" ? "aggregate" : "full",
    });
    assert.equal(store.configuredRunnerProjectionMode({ siteAgentId: "site-visible" }), "aggregate");
    assert.equal(store.configuredRunnerProjectionMode({ siteAgentId: "other-site" }), "full");
    store.installRunnerVisibilityProvider(undefined);
    assert.equal(store.configuredRunnerProjectionMode(), "hidden");
  } finally {
    store.installRunnerVisibilityProvider(undefined);
    if (previous === undefined) delete process.env.SITEWAKE_RUNNER_VISIBILITY;
    else process.env.SITEWAKE_RUNNER_VISIBILITY = previous;
  }
});

test("site overviews expose only a site-filtered aggregate or hidden runner projection", async () => {
  const store = await bundledModule("../db/site-agent-store.ts");
  const previous = process.env.SITEWAKE_RUNNER_VISIBILITY;
  try {
    process.env.SITEWAKE_RUNNER_VISIBILITY = "full";
    const registration = await store.registerValidationRunner({
      id: `private-overview-runner-${Date.now()}`,
      role: "interactive",
    });
    await store.createSiteAgent({ id: "overview-site", url: "https://overview.test/" });
    const aggregate = (await store.getSiteAgentOverview("overview-site")).overview;
    assert.deepEqual(aggregate.runners, []);
    assert.equal(aggregate.runnerService.mode, "aggregate");
    assert.doesNotMatch(JSON.stringify(aggregate.runnerService), new RegExp(registration.runner.id));

    process.env.SITEWAKE_RUNNER_VISIBILITY = "hidden";
    const hidden = (await store.getSiteAgentOverview("overview-site")).overview;
    assert.equal(hidden.runnerService.mode, "hidden");
    assert.deepEqual(Object.keys(hidden.runnerService).sort(), ["generatedAt", "mode"]);
  } finally {
    if (previous === undefined) delete process.env.SITEWAKE_RUNNER_VISIBILITY;
    else process.env.SITEWAKE_RUNNER_VISIBILITY = previous;
  }
});

test("runner page guidance stays inline, closable and keyboard accessible", async () => {
  const [consoleSource, styles] = await Promise.all([
    readFile(new URL("../components/runner-management.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(consoleSource, /页面说明/);
  assert.match(consoleSource, /aria-expanded=\{guideOpen\}/);
  assert.match(consoleSource, /aria-controls="runner-page-guide"/);
  assert.match(consoleSource, /id="runner-page-guide"/);
  assert.match(consoleSource, /aria-label="关闭页面说明"/);
  assert.match(consoleSource, /event\.key !== "Escape"/);
  assert.match(consoleSource, /guideButtonRef\.current\?\.focus\(\)/);
  for (const term of [
    "共享池",
    "预热槽位",
    "execute、author、validate",
    "显式站点绑定",
    "任务、Lease 与 Attempt",
    "浏览器运行与证据",
    "实例可接单",
    "任务等待或执行",
    "管理员判断顺序",
  ]) {
    assert.match(consoleSource, new RegExp(term));
  }
  assert.match(consoleSource, /持续大于 0 时检查容量和实例状态/);
  assert.match(consoleSource, /每次分配或重试各一条/);
  assert.match(styles, /\.rm-page-guide\{/);
  assert.match(styles, /@media\(max-width:760px\)[\s\S]*\.rm-guide-concepts\{grid-template-columns:1fr/);
  assert.match(styles, /\.rm-instance-list>header>span:not\(\.rm-instance-list-hint\)\{display:none\}/);
});

test("site runner management separates organization capacity from site-directed resources", async () => {
  const [consoleSource, styles] = await Promise.all([
    readFile(new URL("../components/runner-management.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(consoleSource, /siteAgentId\?: string/);
  assert.match(consoleSource, /siteAgentId: siteAgentId \|\| siteAgentIdFilter/);
  assert.match(consoleSource, /scope: full\.scope/);
  assert.match(consoleSource, /platformPool: full\.platformPool/);
  assert.match(consoleSource, /platformPool \|\| pool/);
  assert.match(consoleSource, /组织公共池 · 所有 Site 一致/);
  assert.match(consoleSource, /组织公共实例/);
  assert.match(consoleSource, /组织公共池容量/);
  assert.match(consoleSource, /本站运行任务/);
  assert.match(consoleSource, /本站等待任务/);
  assert.match(consoleSource, /本站有效资源 \/ 本站调度视图/);
  assert.match(consoleSource, /本站定向资源/);
  assert.match(consoleSource, /execute、author、validate/);
  assert.match(consoleSource, /className="rm-binding-site-lock" aria-label="当前网站"/);
  assert.match(consoleSource, /className="rm-task-site-lock" aria-label="当前网站任务范围"/);
  assert.match(
    consoleSource,
    /siteAgentId: fixedSiteAgentId \|\| ""/,
  );
  assert.match(consoleSource, /会影响全部网站/);
  assert.match(consoleSource, /window\.confirm/);
  assert.match(styles, /\.rm-binding-site-lock\{/);
  assert.match(styles, /\.rm-task-filters>\.rm-task-site-lock\{/);
});

test("runner management routes are console-authorized, server-projected and avoid wildcard CORS", async () => {
  const [
    helper,
    capabilities,
    overview,
    tasks,
    instanceAction,
    bindingAction,
    runnerHttp,
    schema,
    consoleSource,
  ] = await Promise.all([
    readFile(new URL("../app/api/runner-management/http.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/runner-management/capabilities/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/runner-management/overview/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/runner-management/tasks/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/runner-management/runners/[runnerId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/runner-management/runners/[runnerId]/bindings/[siteAgentId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/validation/runners/http.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/site-agent-schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/runner-management.tsx", import.meta.url), "utf8"),
  ]);
  for (const route of [capabilities, overview, tasks, instanceAction, bindingAction]) {
    assert.match(route, /runnerManagementAuthorized/);
    assert.doesNotMatch(route, /access-control-allow-origin/i);
    assert.doesNotMatch(route, /message\s*:\s*(?:error instanceof Error|error\.message|String\(error\))/);
  }
  assert.match(helper, /resolveAccessGate/);
  assert.match(overview, /getRunnerControlProjection/);
  assert.doesNotMatch(overview, /searchParams\.get\(["']mode/);
  assert.doesNotMatch(runnerHttp, /access-control-allow-origin/i);
  assert.match(schema, /site_agent_v2_runner_pools/);
  assert.match(schema, /site_agent_v2_runner_instances/);
  assert.match(schema, /site_agent_v2_runner_placement_bindings/);
  assert.match(schema, /site_agent_v2_runner_leases/);
  assert.match(schema, /INSERT OR IGNORE INTO site_agent_v2_runner_pools/);
  assert.match(await readFile(new URL("../db/runner-control-store.ts", import.meta.url), "utf8"), /status: "queued"/);
  const storeSource = await readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8");
  assert.match(storeSource, /synchronizedBusinessLeaseExpiry/);
  assert.match(storeSource, /resolveCapabilityRunLeaseControl/);
  assert.match(storeSource, /resolveBrowserRunLeaseControl/);
  assert.doesNotMatch(storeSource, /expiresAt: new Date\(Date\.now\(\) \+ 10 \* 60_000\)/);
  assert.doesNotMatch(consoleSource, /\/api\/runner-control/);
  assert.match(consoleSource, /\/api\/runner-management\/overview/);
  assert.match(consoleSource, /workKinds/);
  assert.match(consoleSource, /capability_module_required/);
  assert.match(consoleSource, /能力缺少可执行程序/);
});
