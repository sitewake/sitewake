import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
let d1Sequence = 0;

async function bundledStore() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../db/capability-task-runner-store.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    external: ["cloudflare:workers"],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

async function bundledCompletionRoute() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../app/api/validation/runners/[runnerId]/runs/complete/route.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "terminal-run-route-fixtures",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]db[\\/]site-agent-store\.ts$/ }, () => ({
          contents: `export const completeAuthoring=async()=>{throw new Error("business_store_called")}; export const completeValidation=completeAuthoring; export const resolveBrowserRunLeaseControl=completeAuthoring;`,
          loader: "ts",
        }));
        builder.onLoad({ filter: /[\\/]db[\\/]capability-task-runner-store\.ts$/ }, () => ({
          contents: `export const completeCapabilityTaskBrowserRun=async()=>{throw new Error("business_store_called")};`,
          loader: "ts",
        }));
        builder.onLoad({ filter: /[\\/]db[\\/]runner-control-store\.ts$/ }, () => ({
          contents: `export const abortRunnerLeaseCompletion=async()=>{}; export const acquireRunnerLeaseCompletion=async()=>{throw new Error("business_store_called")}; export const authorizeRunnerInstanceSession=async()=>{}; export const completeRunnerLease=async()=>{};`,
          loader: "ts",
        }));
        builder.onLoad({ filter: /[\\/]lib[\\/]capability-center[\\/]auto-approval\.ts$/ }, () => ({
          contents: `export const maybeAutoApproveCapabilityTask=async()=>{throw new Error("business_store_called")};`,
          loader: "ts",
        }));
        builder.onLoad({ filter: /[\\/]app[\\/]api[\\/]validation[\\/]runners[\\/]http\.ts$/ }, () => ({
          contents: `export const legacyRunnerProtocolEnabled=()=>false; export const runnerControlErrorStatus=()=>500; export const runnerControlHeadersPlausible=()=>true; export const runnerLeaseControlInput=()=>undefined; export const runnerOptions=()=>new Response(null,{status:204}); export const runnerSessionToken=()=>"session-token"; export const runnerJson=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});`,
          loader: "ts",
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

async function d1RunnerFixture() {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `capability-task-runner-${++d1Sequence}` },
  });
  const database = await miniflare.getD1Database("DB");
  const key = `__CAPABILITY_TASK_RUNNER_D1_${d1Sequence}`;
  globalThis[key] = database;
  const result = await build({
    stdin: {
      contents: `
        export { createSiteAgent, putBrowserArtifact } from "./db/site-agent-store.ts";
        export { createCapabilityTask, getCapabilityTaskDetail, updateCapabilityTaskProgress } from "./db/capability-center-store.ts";
        export { registerRunnerInstance, heartbeatRunnerInstance } from "./db/runner-control-store.ts";
        export { leaseCapabilityTaskWork, startCapabilityTaskBrowserRun, completeCapabilityTaskBrowserRun } from "./db/capability-task-runner-store.ts";
      `,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "capability-task-runner-d1",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
          contents: `const database=globalThis[${JSON.stringify(key)}]; export function getD1Binding(){return database;} export function getArtifactBinding(){return null;} export class D1UnavailableError extends Error {}`,
          loader: "ts",
        }));
      },
    }],
  });
  const api = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  return { api, database, dispose: async () => { delete globalThis[key]; await miniflare.dispose(); } };
}

test("capability task stages map to Runner author and validate work without creating split jobs", async () => {
  const store = await bundledStore();
  assert.equal(store.capabilityTaskWorkKind({ type: "generate", stage: "queued" }), "author");
  assert.equal(store.capabilityTaskWorkKind({ type: "repair", stage: "author" }), "author");
  assert.equal(store.capabilityTaskWorkKind({ type: "generate", stage: "validate" }), "validate");
  assert.equal(store.capabilityTaskWorkKind({ type: "validate", stage: "queued" }), "validate");
  assert.equal(store.capabilityTaskWorkKind({ type: "validate", stage: "review" }), undefined);

  assert.deepEqual(
    store.capabilityTaskCompletionState("generate", "author", true),
    { status: "queued", stage: "validate" },
  );
  assert.deepEqual(
    store.capabilityTaskCompletionState("repair", "validate", true),
    { status: "awaiting-review", stage: "review" },
  );
  assert.deepEqual(
    store.capabilityTaskCompletionState("validate", "validate", true),
    { status: "completed", stage: "complete" },
  );
  assert.deepEqual(
    store.capabilityTaskCompletionState("generate", "author", false),
    { status: "failed", stage: "author" },
  );
});

test("capability task Runner schema keeps materialization pins nullable and adds fenced lease mirrors", async () => {
  const schema = await readFile(new URL("../db/site-agent-schema.ts", import.meta.url), "utf8");
  const table = schema.slice(
    schema.indexOf("CREATE TABLE IF NOT EXISTS site_agent_v2_capability_tasks"),
    schema.indexOf("CREATE INDEX IF NOT EXISTS site_agent_v2_capability_tasks_queue_idx"),
  );
  assert.match(table, /capability_id text,/);
  assert.match(table, /capability_version_id text,/);
  assert.doesNotMatch(table, /capability_(?:version_)?id text NOT NULL/);
  for (const column of ["runner_id", "runner_session_id", "runner_lease_id", "runner_lease_fence", "runner_lease_expires_at"]) {
    assert.match(table, new RegExp(`${column} (?:text|integer)`));
  }
  assert.match(schema, /ensureCapabilityTaskRunnerSchema/);
  assert.match(schema, /site_agent_v2_capability_tasks_runner_queue_idx/);
});

test("capability task Runner storage uses central fences and never writes legacy production jobs", async () => {
  const source = await readFile(new URL("../db/capability-task-runner-store.ts", import.meta.url), "utf8");
  assert.match(source, /workload: \{ kind: "capability-task"/);
  assert.match(source, /runner_lease_id=\?/);
  assert.match(source, /runner_lease_fence=\?/);
  assert.match(source, /runner_lease_expires_at>\?/);
  assert.match(source, /runnerCompletions/);
  assert.match(source, /body\.run\.status !== "passed" && body\.run\.status !== "failed"/);
  assert.match(source, /const passed = body\.run\.status === "passed"/);
  assert.match(source, /startUrl: run\.startUrl/);
  assert.match(source, /endUrl: run\.endUrl/);
  assert.doesNotMatch(source, /site_agent_v2_(?:learning_jobs|validation_jobs|capability_projects|capability_revisions)/);

  const leaseRoute = await readFile(new URL("../app/api/validation/runners/[runnerId]/lease/route.ts", import.meta.url), "utf8");
  assert.ok(leaseRoute.indexOf("leaseCapabilityTaskWork") < leaseRoute.indexOf("leaseRunnerWork(decodedRunnerId"));
  const completionRoute = await readFile(new URL("../app/api/validation/runners/[runnerId]/runs/complete/route.ts", import.meta.url), "utf8");
  assert.match(completionRoute, /completeCapabilityTaskBrowserRun/);
  assert.match(completionRoute, /abortRunnerLeaseCompletion/);
  assert.match(completionRoute, /browser_run_not_terminal/);
});

test("Runner persists actual page state, output and verifier assertions for capability acceptance", async () => {
  const source = await readFile(new URL("../runner/browser-runner.ts", import.meta.url), "utf8");
  const validation = source.slice(source.indexOf("async function runValidation("), source.indexOf("async function updateExecution("));
  assert.match(validation, /validationOutput = result\.output/);
  assert.match(validation, /beforeEvidence = \{ url: before\.url, title: before\.title, heading: before\.heading \}/);
  assert.match(validation, /afterEvidence = \{ url: after\.url, title: after\.title, heading: after\.heading \}/);
  assert.match(validation, /assertions/);
  assert.match(validation, /lease\.revision\.verifier\?\.success/);
  assert.match(validation, /implementationProof\?\.verifier\.success/);
  assert.doesNotMatch(validation, /lease\.candidate\.operations[\s\S]*flatMap\(\(implementation\) => implementation\.authored\?\.proof\.verifier\.success/);
  assert.match(validation, /expected: rule\.value/);
  assert.match(validation, /actual: after\.url/);
});

test("Runner evidence presentation force-hides the site Agent host from screenshots", async () => {
  const source = await readFile(new URL("../runner/browser-runner.ts", import.meta.url), "utf8");
  assert.match(source, /style\[data-sitewake-validation-style\]/);
  assert.match(source, /\[data-sitewake-agent\]\{display:none!important;visibility:hidden!important\}/);
  assert.match(source, /element\.style\.setProperty\("display", "none", "important"\)/);
  assert.match(source, /querySelectorAll\("\[data-sitewake-agent\]\"\)\) element\.remove\(\)/);
});

test("a completed future Runner validation round-trips structured proof through D1 task evidence", async () => {
  const { api, dispose } = await d1RunnerFixture();
  try {
    const siteAgentId = "runner-proof-round-trip";
    await api.createSiteAgent({ id: siteAgentId, name: "Runner proof", url: "https://proof.test/" });
    const created = await api.createCapabilityTask(siteAgentId, {
      type: "generate",
      capability: {
        name: "Navigate home",
        description: "Return to the home page",
        goalTemplate: "Return home",
        kind: "navigation",
        structure: "atomic",
        operation: "read",
        exposure: "public",
        resultKind: "page",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { pageUrl: { type: "string" } }, required: ["pageUrl"] },
      },
      implementation: {
        kind: "module",
        module: { contentHash: "b".repeat(64), moduleUrl: "/modules/home.js", exportName: "capability" },
        proof: {
          version: 1,
          iterationId: "iteration-round-trip",
          author: "ai-program-author",
          rationale: "Return home",
          alternativeIds: [],
          verifier: { success: [{ kind: "url", value: "https://proof.test/home" }], noResult: [], businessRejection: [] },
          groundedTargetIds: [],
          createdAt: "2026-08-02T00:00:00.000Z",
        },
      },
      validation: { status: "pending", startUrl: "https://proof.test/products/1" },
      result: { input: {} },
    });
    await api.updateCapabilityTaskProgress(siteAgentId, created.task.id, { status: "queued", stage: "validate" });

    const registration = await api.registerRunnerInstance({
      id: "runner-proof",
      name: "Proof runner",
      role: "validate",
      workKinds: ["validate"],
      browsers: ["chromium"],
      maxConcurrency: 1,
      readySlots: 1,
      recording: true,
    });
    await api.heartbeatRunnerInstance(registration.instance.id, {
      sessionId: registration.instance.sessionId,
      sessionToken: registration.sessionToken,
      readySlots: 1,
    });
    const leased = await api.leaseCapabilityTaskWork(registration.instance.id, "validate", {
      sessionId: registration.instance.sessionId,
      sessionToken: registration.sessionToken,
    });
    assert.equal(leased.lease.kind, "validate");
    const leaseRef = leased.lease.job.lease;
    const control = {
      runnerId: registration.instance.id,
      runnerSessionId: registration.instance.sessionId,
      sessionToken: registration.sessionToken,
      legacy: false,
      leaseId: leaseRef.leaseId,
      token: leaseRef.token,
      fence: leaseRef.fence,
    };
    const now = "2026-08-02T01:00:00.000Z";
    const running = {
      id: "run-round-trip",
      learningJobId: created.task.id,
      validationJobId: created.task.id,
      siteAgentId,
      candidateId: leased.lease.candidate.id,
      runnerId: registration.instance.id,
      mode: "validate",
      status: "running",
      browser: { name: "chromium", version: "1", headless: true },
      startedAt: now,
      startUrl: "https://proof.test/products/1",
      steps: [],
      artifactIds: [],
    };
    await api.startCapabilityTaskBrowserRun(control, running);
    const artifactInputs = [
      { kind: "screenshot", role: "before-screenshot", label: "[before-screenshot] Before", contentType: "image/png" },
      { kind: "screenshot", role: "after-screenshot", label: "[after-screenshot] After", contentType: "image/png" },
      { kind: "video", role: "validation-video", label: "[validation-video] Recording", contentType: "video/webm" },
    ];
    const artifacts = [];
    for (const artifact of artifactInputs) artifacts.push(await api.putBrowserArtifact({
      siteAgentId,
      learningJobId: created.task.id,
      runId: running.id,
      ...artifact,
      bytes: new Uint8Array([1, 2, 3]).buffer,
    }));
    const passed = {
      ...running,
      status: "passed",
      endedAt: now,
      endUrl: "https://proof.test/home",
      steps: [{ stepId: "navigate", op: "adaptive", status: "passed", startedAt: now, endedAt: now }],
      outcome: {
        status: "success",
        code: "module_smoke_passed",
        summary: "Independent validation passed",
        evaluatedAt: now,
        evidence: {
          before: { url: running.startUrl, title: "Product", heading: "Product" },
          after: { url: "https://proof.test/home", title: "Home", heading: "Welcome" },
          output: { pageUrl: "https://proof.test/home" },
          assertions: [{ kind: "url", expected: "https://proof.test/home", actual: "https://proof.test/home", passed: true }],
        },
      },
      artifactIds: artifacts.map((artifact) => artifact.id),
    };
    await api.completeCapabilityTaskBrowserRun(control, { run: passed });

    const detail = await api.getCapabilityTaskDetail(siteAgentId, created.task.id);
    assert.equal(detail.verification.source, "task-runner");
    assert.equal(detail.verification.status, "passed");
    assert.equal(detail.verification.startUrl, running.startUrl);
    assert.equal(detail.verification.endUrl, passed.endUrl);
    assert.deepEqual(detail.verification.evidenceArtifactIds, artifacts.map((artifact) => artifact.id));
    assert.deepEqual(detail.verification.evidenceRoles["before-screenshot"], [artifacts[0].id]);
    assert.deepEqual(detail.verification.evidenceRoles["after-screenshot"], [artifacts[1].id]);
    assert.deepEqual(detail.verification.evidenceRoles["validation-video"], [artifacts[2].id]);
    assert.equal(detail.verification.checks.find((check) => check.id === "verifier-1").actual, "https://proof.test/home");
    assert.equal(detail.verification.checks.find((check) => check.id === "required-output").actual, 'pageUrl="https://proof.test/home"');
  } finally { await dispose(); }
});

test("an authoring run cannot masquerade as the authoritative independent validation", async () => {
  const { api, dispose } = await d1RunnerFixture();
  try {
    const siteAgentId = "runner-author-not-validation";
    await api.createSiteAgent({ id: siteAgentId, name: "Author proof", url: "https://author.test/" });
    const created = await api.createCapabilityTask(siteAgentId, {
      type: "generate",
      capability: {
        name: "Draft capability",
        description: "Draft capability",
        goalTemplate: "Draft capability",
        kind: "task",
        structure: "atomic",
        operation: "read",
        exposure: "public",
        resultKind: "data",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      },
      validation: { status: "pending", startUrl: "https://author.test/" },
      result: { input: {}, startUrl: "https://author.test/" },
    });
    const registration = await api.registerRunnerInstance({
      id: "runner-author-proof",
      name: "Author runner",
      role: "author",
      workKinds: ["author"],
      browsers: ["chromium"],
      maxConcurrency: 1,
      readySlots: 1,
    });
    await api.heartbeatRunnerInstance(registration.instance.id, {
      sessionId: registration.instance.sessionId,
      sessionToken: registration.sessionToken,
      readySlots: 1,
    });
    const leased = await api.leaseCapabilityTaskWork(registration.instance.id, "author", {
      sessionId: registration.instance.sessionId,
      sessionToken: registration.sessionToken,
    });
    assert.equal(leased.lease.kind, "author");
    const leaseRef = leased.lease.job.lease;
    const control = {
      runnerId: registration.instance.id,
      runnerSessionId: registration.instance.sessionId,
      sessionToken: registration.sessionToken,
      legacy: false,
      leaseId: leaseRef.leaseId,
      token: leaseRef.token,
      fence: leaseRef.fence,
    };
    const now = "2026-08-02T02:00:00.000Z";
    const run = {
      id: "run-author-only",
      learningJobId: created.task.id,
      siteAgentId,
      candidateId: leased.lease.candidate.id,
      runnerId: registration.instance.id,
      mode: "author",
      status: "passed",
      browser: { name: "chromium", version: "1", headless: true },
      startedAt: now,
      endedAt: now,
      startUrl: "https://author.test/",
      endUrl: "https://author.test/done",
      steps: [],
      outcome: { status: "success", code: "author_passed", summary: "Authoring passed", evaluatedAt: now },
      artifactIds: [],
    };
    await api.completeCapabilityTaskBrowserRun(control, { run, candidate: leased.lease.candidate });
    const detail = await api.getCapabilityTaskDetail(siteAgentId, created.task.id);
    assert.equal(detail.version.validation.status, "pending");
    assert.equal(detail.version.validation.runId, undefined);
    assert.equal(detail.verification.status, "incomplete");
    assert.equal(detail.verification.source, "version-only");
  } finally { await dispose(); }
});

test("Runner completion rejects a non-terminal BrowserRun before touching lease or business state", async () => {
  const route = await bundledCompletionRoute();
  const response = await route.POST(new Request("http://localhost/api/validation/runners/runner-1/runs/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ run: { id: "run-1", status: "running" } }),
  }), { params: Promise.resolve({ runnerId: "runner-1" }) });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "browser_run_not_terminal" });
});
