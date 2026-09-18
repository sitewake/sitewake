import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let isolatedDatabaseSequence = 0;

async function isolatedD1Database() {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: {
      DB: `agent-run-v3-test-${isolatedDatabaseSequence += 1}`,
    },
  });
  return {
    database: await miniflare.getD1Database("DB"),
    dispose: () => miniflare.dispose(),
  };
}

async function bundledModule(entry, options = {}) {
  const databaseKey = options.database
    ? `__SITEWAKE_AGENT_RUN_TEST_D1_${isolatedDatabaseSequence += 1}`
    : undefined;
  if (databaseKey) globalThis[databaseKey] = options.database;
  try {
    const result = await build({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      plugins: databaseKey ? [{
        name: "isolated-agent-run-d1-binding",
        setup(builder) {
          builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
            contents: `
              const database = globalThis[${JSON.stringify(databaseKey)}] || null;
              export function getD1Binding() { return database; }
              export function getArtifactBinding() { return null; }
              export class D1UnavailableError extends Error {}
            `,
            loader: "ts",
          }));
        },
      }] : [],
    });
    return await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`,
    );
  } finally {
    if (databaseKey) delete globalThis[databaseKey];
  }
}

const now = "2026-07-18T00:00:00.000Z";

function fixture() {
  const search = {
    id: "operation-search", name: "提交搜索", description: "在当前页面提交搜索", kind: "task", evidenceSource: "ai-authored",
    applicability: { scope: "scene-set", sceneIds: ["scene-home"], evidenceSceneIds: ["scene-home"] },
    fromSceneId: "scene-home", toSceneId: "scene-results",
    inputs: { type: "object", properties: { keyword: { type: "string" } } }, outputs: { type: "object", properties: {} },
    preconditions: [], effects: ["scene:scene-results"],
    implementations: [{
      id: "implementation-search", conditions: [], successes: 1, failures: 0, sourceEpisodeIds: [],
      program: { version: 2, steps: [
        { id: "fill", op: "fill", targetId: "search-input", value: { source: "input", path: "keyword" }, timeoutMs: 8_000 },
        { id: "submit", op: "click", targetId: "search-submit", timeoutMs: 8_000, transition: { kind: "document", expectedSceneIds: ["scene-results"], expectedOrigin: "https://atlas.test" } },
        { id: "extract", op: "extract", targetId: "result-count", schema: { type: "number" }, saveAs: "count", timeoutMs: 8_000 },
      ] },
    }], verification: { sceneId: "scene-results" }, status: "verified", updatedAt: now,
  };
  const capability = {
    id: "capability-search", name: "搜索", description: "搜索", normalizedGoal: "搜索", aliases: [],
    inputs: search.inputs, outputs: { type: "object", properties: { count: { type: "number" } } }, outcomes: [],
    plans: [{ id: "plan-search", entrySceneIds: ["scene-home"], steps: [{ operationId: search.id, bindings: { keyword: { source: "input", path: "keyword" } } }], outputBindings: { count: { source: "state", path: "count" } } }],
    sourceEpisodeIds: [], confidence: 1, status: "available", updatedAt: now,
  };
  return {
    capability,
    release: { id: "release", siteAgentId: "atlas", version: 1, profile: { entryUrl: "https://atlas.test/" }, scenes: [], targets: [], operations: [search], capabilities: [capability], outcomes: [], createdAt: now },
  };
}

test("v3 storage is isolated from v2 and contains every run authority table", async () => {
  const schema = await readFile(new URL("../db/site-agent-schema.ts", import.meta.url), "utf8");
  for (const table of ["agent_runs", "run_events", "browser_ports", "tool_calls", "execution_receipts", "capability_programs"]) {
    assert.match(schema, new RegExp(`site_agent_v3_${table}`));
  }
  assert.match(schema, /ensureSiteAgentV3Schema/);
});

test("Run origin policy trusts same-origin deployments and explicit external enrollment only", async () => {
  const store = await bundledModule("../db/agent-run-store.ts");
  assert.deepEqual(store.siteExecutionOrigins({
    reportedOrigin: "http://10.31.0.80:3000",
    requestOrigin: "http://10.31.0.80:3000",
    controlPlaneOrigin: "http://10.31.0.80:3000",
  }), ["http://10.31.0.80:3000"]);
  assert.deepEqual(store.siteExecutionOrigins({
    allowedOrigins: ["https://shop.example.com"],
    reportedOrigin: "https://shop.example.com",
    requestOrigin: "https://shop.example.com",
    controlPlaneOrigin: "https://control.example.com",
  }), ["https://shop.example.com"]);
  assert.throws(() => store.siteExecutionOrigins({
    reportedOrigin: "https://attacker.example.com",
    requestOrigin: "https://attacker.example.com",
    controlPlaneOrigin: "https://control.example.com",
  }), /agent_run_origin_rejected/);
  assert.throws(() => store.siteExecutionOrigins({
    reportedOrigin: "https://forged-host.example.com",
    requestOrigin: "https://forged-host.example.com",
  }), /agent_run_origin_rejected/);
  assert.throws(() => store.siteExecutionOrigins({
    allowedOrigins: ["https://shop.example.com"],
    reportedOrigin: "https://shop.example.com",
    requestOrigin: "https://attacker.example.com",
    controlPlaneOrigin: "https://control.example.com",
  }), /agent_run_origin_rejected/);
  assert.throws(() => store.siteExecutionOrigins({
    allowedOrigins: ["https://shop.example.com"],
    reportedOrigin: "https://shop.example.com",
    controlPlaneOrigin: "https://control.example.com",
  }), /agent_run_origin_rejected/);
});

test("packed AgentRun bearer authority is confined to its SiteAgent", async () => {
  const siteStore = await bundledModule("../db/site-agent-store.ts");
  const runStore = await bundledModule("../db/agent-run-store.ts");
  siteStore.resetMemorySiteAgentStore();
  await siteStore.createSiteAgent({ id: "runtime-token-owner" });
  await siteStore.getSiteAgentOverview("runtime-token-owner");
  const created = await runStore.createAgentRun({
    siteAgentId: "runtime-token-owner",
    origin: "https://runtime-token.test",
    url: "https://runtime-token.test/",
    goal: "inspect current page",
    taskInput: {},
    documentId: "document-runtime-token",
    browserSessionId: "browser-runtime-token",
    controller: "page-agent",
    requestOrigin: "https://runtime-token.test",
    controlPlaneOrigin: "https://runtime-token.test",
  });

  const authorized = await runStore.getSiteAgentRunByToken(
    "runtime-token-owner",
    created.resumeToken,
    "https://runtime-token.test",
  );
  assert.equal(authorized.run.id, created.run.id);
  await assert.rejects(
    runStore.getSiteAgentRunByToken("another-site-agent", created.resumeToken),
    /agent_run_token_rejected/,
  );
  await assert.rejects(
    runStore.getSiteAgentRunByToken("runtime-token-owner", `${created.run.id}.forged`),
    /agent_run_token_rejected/,
  );
  await assert.rejects(
    runStore.getSiteAgentRunByToken("runtime-token-owner", created.resumeToken, "https://other-origin.test"),
    /agent_run_origin_rejected/,
  );
  await assert.rejects(
    runStore.getSiteAgentRunByToken("runtime-token-owner", "not-packed"),
    /agent_run_token_invalid/,
  );
});

test("administrator-created origin policy survives untrusted connection observations", async () => {
  const store = await bundledModule("../db/site-agent-store.ts");
  const siteAgentId = `origin-policy-${Date.now()}`;
  const placeholder = await store.createSiteAgent({ id: siteAgentId });
  assert.deepEqual(placeholder.profile.allowedOrigins, []);
  const created = await store.createSiteAgent({ id: siteAgentId, url: "https://shop.example.com/catalog" });
  assert.deepEqual(created.profile.allowedOrigins, ["https://shop.example.com"]);
  const capturedAt = new Date().toISOString();
  await store.recordSiteAgentConnection(siteAgentId, {
    origin: "https://attacker.example.com",
    url: "https://attacker.example.com/",
    title: "untrusted observation",
    heading: "untrusted observation",
    snapshot: {
      id: "snapshot-origin-policy",
      sessionId: "browser-origin-policy",
      documentId: "document-origin-policy",
      sequence: 1,
      url: "https://attacker.example.com/",
      title: "untrusted observation",
      heading: "untrusted observation",
      visibleText: "untrusted observation",
      links: [],
      elements: [],
      capturedAt,
    },
  });
  const release = await store.getActiveSiteAgentRelease(siteAgentId);
  assert.deepEqual(release.release.profile.allowedOrigins, ["https://shop.example.com"]);
});

test("page AgentRun handoff is single-use, concurrent-safe, and rotates its resume secret", async () => {
  const siteStore = await bundledModule("../db/site-agent-store.ts");
  const runStore = await bundledModule("../db/agent-run-store.ts");
  siteStore.resetMemorySiteAgentStore();
  await siteStore.createSiteAgent({ id: "handoff-single-use" });
  await siteStore.getSiteAgentOverview("handoff-single-use");
  const created = await runStore.createAgentRun({
    siteAgentId: "handoff-single-use",
    origin: "https://handoff.test",
    url: "https://handoff.test/",
    goal: "open cart",
    taskInput: {},
    documentId: "document-source",
    browserSessionId: "browser-one",
    controller: "page-agent",
    requestOrigin: "https://handoff.test",
    controlPlaneOrigin: "https://handoff.test",
  });

  await assert.rejects(
    runStore.claimAgentRun(created.run.id, {
      token: created.resumeToken,
      origin: "https://handoff.test",
      url: "https://handoff.test/copied",
      documentId: "document-copy",
      browserSessionId: "browser-one",
    }),
    /agent_run_handoff_token_required/,
  );

  const pending = await runStore.issueAgentRunHandoff(created.run.id, {
    token: created.resumeToken,
    expectedRevision: created.run.revision,
    pageEpoch: created.run.pageEpoch,
    portId: created.run.activePort.id,
    documentId: created.run.activePort.documentId,
    browserSessionId: created.run.activePort.browserSessionId,
    destinationUrl: "https://handoff.test/cart",
  });
  await runStore.checkpointAgentRun(created.run.id, {
    token: created.resumeToken,
    expectedRevision: pending.run.revision,
    pageEpoch: pending.run.pageEpoch,
    checkpoint: {
      mode: "compiled",
      phase: "waiting-page-restore",
      input: {},
      cursor: { operationIndex: 0, programStepIndex: 1 },
      output: {},
      savedAt: new Date().toISOString(),
    },
  });
  const claims = await Promise.allSettled([
    runStore.claimAgentRun(created.run.id, {
      token: pending.handoffToken,
      origin: "https://handoff.test",
      url: "https://handoff.test/cart",
      documentId: "document-destination-a",
      browserSessionId: "browser-one",
    }),
    runStore.claimAgentRun(created.run.id, {
      token: pending.handoffToken,
      origin: "https://handoff.test",
      url: "https://handoff.test/cart",
      documentId: "document-destination-b",
      browserSessionId: "browser-one",
    }),
  ]);
  const winners = claims.filter((result) => result.status === "fulfilled");
  const losers = claims.filter((result) => result.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  const winner = winners[0].value;
  assert.notEqual(winner.resumeToken, pending.handoffToken);
  assert.notEqual(winner.resumeToken, created.resumeToken);
  assert.equal(winner.run.pageEpoch, created.run.pageEpoch + 1);
  assert.equal((await runStore.getAgentRun(created.run.id, winner.resumeToken)).run.id, created.run.id);
  await assert.rejects(
    runStore.getAgentRun(created.run.id, pending.handoffToken),
    /agent_run_token_rejected/,
  );
  await assert.rejects(
    runStore.getAgentRun(created.run.id, created.resumeToken),
    /agent_run_token_rejected/,
  );
  await assert.rejects(
    runStore.claimAgentRun(created.run.id, {
      token: pending.handoffToken,
      origin: "https://handoff.test",
      url: "https://handoff.test/cart",
      documentId: "document-replay",
      browserSessionId: "browser-one",
    }),
    /agent_run_token_rejected/,
  );
});

test("D1 atomically consumes one handoff grant under concurrent claims", async (t) => {
  const isolated = await isolatedD1Database();
  t.after(isolated.dispose);
  const siteStore = await bundledModule("../db/site-agent-store.ts", {
    database: isolated.database,
  });
  const runStore = await bundledModule("../db/agent-run-store.ts", {
    database: isolated.database,
  });
  await siteStore.createSiteAgent({
    id: "d1-handoff-single-use",
    url: "https://d1-handoff.test/",
  });
  const created = await runStore.createAgentRun({
    siteAgentId: "d1-handoff-single-use",
    origin: "https://d1-handoff.test",
    url: "https://d1-handoff.test/",
    goal: "open cart",
    taskInput: {},
    documentId: "document-source",
    browserSessionId: "browser-one",
    controller: "page-agent",
    requestOrigin: "https://d1-handoff.test",
    controlPlaneOrigin: "https://d1-handoff.test",
  });
  const pending = await runStore.issueAgentRunHandoff(created.run.id, {
    token: created.resumeToken,
    expectedRevision: created.run.revision,
    pageEpoch: created.run.pageEpoch,
    portId: created.run.activePort.id,
    documentId: created.run.activePort.documentId,
    browserSessionId: created.run.activePort.browserSessionId,
    destinationUrl: "https://d1-handoff.test/cart",
  });
  await runStore.checkpointAgentRun(created.run.id, {
    token: created.resumeToken,
    expectedRevision: pending.run.revision,
    pageEpoch: pending.run.pageEpoch,
    checkpoint: {
      mode: "compiled",
      phase: "waiting-page-restore",
      input: {},
      cursor: { operationIndex: 0, programStepIndex: 1 },
      output: {},
      savedAt: new Date().toISOString(),
    },
  });

  const claims = await Promise.allSettled([
    runStore.claimAgentRun(created.run.id, {
      token: pending.handoffToken,
      origin: "https://d1-handoff.test",
      url: "https://d1-handoff.test/cart",
      documentId: "document-destination-a",
      browserSessionId: "browser-one",
    }),
    runStore.claimAgentRun(created.run.id, {
      token: pending.handoffToken,
      origin: "https://d1-handoff.test",
      url: "https://d1-handoff.test/cart",
      documentId: "document-destination-b",
      browserSessionId: "browser-one",
    }),
  ]);
  const fulfilled = claims.filter((result) => result.status === "fulfilled");
  const rejected = claims.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);

  const winner = fulfilled[0].value;
  assert.notEqual(winner.resumeToken, created.resumeToken);
  assert.notEqual(winner.resumeToken, pending.handoffToken);
  assert.equal(
    (await runStore.getAgentRun(created.run.id, winner.resumeToken)).run.id,
    created.run.id,
    "the winning document receives the only live resume secret",
  );
  await assert.rejects(
    runStore.getAgentRun(created.run.id, created.resumeToken),
    /agent_run_token_rejected/,
  );
  await assert.rejects(
    runStore.claimAgentRun(created.run.id, {
      token: pending.handoffToken,
      origin: "https://d1-handoff.test",
      url: "https://d1-handoff.test/cart",
      documentId: "document-replay",
      browserSessionId: "browser-one",
    }),
    /agent_run_token_rejected/,
  );
});

test("invalid handoff claims do not consume the valid one-shot grant", async () => {
  const siteStore = await bundledModule("../db/site-agent-store.ts");
  const runStore = await bundledModule("../db/agent-run-store.ts");
  siteStore.resetMemorySiteAgentStore();
  await siteStore.createSiteAgent({ id: "handoff-invalid-claim" });
  await siteStore.getSiteAgentOverview("handoff-invalid-claim");
  const created = await runStore.createAgentRun({
    siteAgentId: "handoff-invalid-claim",
    origin: "https://handoff-invalid.test",
    url: "https://handoff-invalid.test/",
    goal: "open cart",
    taskInput: {},
    documentId: "document-source",
    browserSessionId: "browser-one",
    controller: "page-agent",
    requestOrigin: "https://handoff-invalid.test",
    controlPlaneOrigin: "https://handoff-invalid.test",
  });
  const pending = await runStore.issueAgentRunHandoff(created.run.id, {
    token: created.resumeToken,
    expectedRevision: created.run.revision,
    pageEpoch: created.run.pageEpoch,
    portId: created.run.activePort.id,
    documentId: created.run.activePort.documentId,
    browserSessionId: created.run.activePort.browserSessionId,
    destinationUrl: "https://handoff-invalid.test/cart",
  });
  await assert.rejects(
    runStore.claimAgentRun(created.run.id, {
      token: pending.handoffToken,
      origin: "https://handoff-invalid.test",
      url: "https://handoff-invalid.test/cart",
      documentId: "document-wrong-browser",
      browserSessionId: "browser-two",
    }),
    /agent_run_browser_session_rejected/,
  );
  const claimed = await runStore.claimAgentRun(created.run.id, {
    token: pending.handoffToken,
    origin: "https://handoff-invalid.test",
    url: "https://handoff-invalid.test/cart",
    documentId: "document-destination",
    browserSessionId: "browser-one",
  });
  assert.equal(claimed.run.activePort.documentId, "document-destination");
});

test("issuing a second handoff revokes the first grant", async () => {
  const siteStore = await bundledModule("../db/site-agent-store.ts");
  const runStore = await bundledModule("../db/agent-run-store.ts");
  siteStore.resetMemorySiteAgentStore();
  await siteStore.createSiteAgent({ id: "handoff-replaced" });
  await siteStore.getSiteAgentOverview("handoff-replaced");
  const created = await runStore.createAgentRun({
    siteAgentId: "handoff-replaced",
    origin: "https://handoff-replaced.test",
    url: "https://handoff-replaced.test/",
    goal: "open cart",
    taskInput: {},
    documentId: "document-source",
    browserSessionId: "browser-one",
    controller: "page-agent",
    requestOrigin: "https://handoff-replaced.test",
    controlPlaneOrigin: "https://handoff-replaced.test",
  });
  const input = {
    token: created.resumeToken,
    expectedRevision: created.run.revision,
    pageEpoch: created.run.pageEpoch,
    portId: created.run.activePort.id,
    documentId: created.run.activePort.documentId,
    browserSessionId: created.run.activePort.browserSessionId,
    destinationUrl: "https://handoff-replaced.test/cart",
  };
  const first = await runStore.issueAgentRunHandoff(created.run.id, input);
  const second = await runStore.issueAgentRunHandoff(created.run.id, {
    ...input,
    expectedRevision: first.run.revision,
  });
  await assert.rejects(
    runStore.claimAgentRun(created.run.id, {
      token: first.handoffToken,
      origin: "https://handoff-replaced.test",
      url: "https://handoff-replaced.test/cart",
      documentId: "document-old-grant",
      browserSessionId: "browser-one",
    }),
    /agent_run_token_rejected/,
  );
  const claimed = await runStore.claimAgentRun(created.run.id, {
    token: second.handoffToken,
    origin: "https://handoff-replaced.test",
    url: "https://handoff-replaced.test/cart",
    documentId: "document-new-grant",
    browserSessionId: "browser-one",
  });
  assert.equal(claimed.run.activePort.documentId, "document-new-grant");
});

test("a Capability remains one program while a document transition terminates the current slice", async () => {
  const runtime = await bundledModule("../lib/site-knowledge/runtime-program.ts");
  const { capability, release } = fixture();
  const scope = runtime.exactOriginScope("atlas", "https://atlas.test/search?q=x");
  const program = runtime.capabilityProgramFromDefinition(capability, scope, "revision-1");
  assert.equal(program.plan.length, 1);
  assert.equal(program.scope.allowedOrigins[0], "https://atlas.test");
  const slice = runtime.executionSliceForCursor({
    runId: "run-1", toolCallId: "tool-1", release, capability, scope,
    cursor: { capabilityProgramId: program.id, operationIndex: 0, programStepIndex: 0 }, origin: "https://atlas.test",
  });
  assert.deepEqual(slice.steps.map((step) => step.id), ["fill", "submit"]);
  assert.equal(slice.expectedTransition.kind, "document");
  assert.deepEqual(slice.expectedTransition.expectedSceneIds, ["scene-results"]);
  assert.equal(slice.steps.some((step) => step.id === "extract"), false, "destination DOM steps must not execute in the source document");
});

test("SDK startup captures handoff before application code and restores server conversation", async () => {
  const [client, port, adaptive, shared, store] = await Promise.all([
    readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8"),
    readFile(new URL("../client/user-agent-adaptive.ts", import.meta.url), "utf8"),
    readFile(new URL("../client/user-agent-shared.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/agent-run-store.ts", import.meta.url), "utf8"),
  ]);
  assert.match(client, /startupHash\.get\("sitewake-run"\)/);
  assert.match(client, /detail\?\.conversation/);
  assert.match(client, /restoredTimeline/);
  assert.match(client, /renderActivityTimeline/);
  assert.match(client, /message\.taskId === taskId && message\.kind === kind && message\.text === text/);
  assert.match(port, /prepareRunHandoff/);
  assert.match(port, /\/ports\/claim/);
  assert.match(port, /waiting-page-restore/);
  assert.match(port, /const trustedHandoffToken = pointer\?\.runId === handoffRunId/);
  assert.match(port, /const continuationToken = trustedHandoffToken/);
  assert.match(store, /agent_run_handoff_token_required/);
  assert.match(store, /freshResumeTokenHash/);
  assert.match(store, /AGENT_RUN_HANDOFF_WINDOW_MS\s*=\s*60_000/);
  const claimRoute = await readFile(new URL("../app/api/agent-runs/[runId]/ports/claim/route.ts", import.meta.url), "utf8");
  assert.match(claimRoute, /request\.headers\.get\("origin"\)/);
  assert.match(claimRoute, /requestOrigin !== reportedOrigin/);
  assert.match(port, /cancelInterruptedRun/);
  assert.match(port, /consumeNavigationIntent/);
  assert.match(port, /navigation\?\.type === "reload"/);
  assert.match(port, /navigationIntent && pointer && navigationIntent\.runId === pointer\.runId/);
  assert.match(port, /armNavigationIntent/);
  assert.match(port, /onBeforeNavigationAction: async \(\) => \{[\s\S]*await drainObservations\(\);[\s\S]*await this\.armNavigationIntent\(\)/);
  assert.match(port, /onNavigateAction: async \(url, target\) =>/);
  assert.match(port, /(?:await this\.navigateWithRun\(url, target\)|return this\.navigateWithRun\(url, target\))/);
  const checkpointSync = port.slice(port.indexOf("private async syncCheckpoint"), port.indexOf("private async flushCheckpoint"));
  assert.doesNotMatch(checkpointSync, /keepalive:\s*true/);
  assert.match(checkpointSync, /64 KiB body limit/);
  assert.match(adaptive, /element\.closest<HTMLAnchorElement>\("a\[href\]"\)/);
  assert.match(adaptive, /await drainEvidence\(\);[\s\S]*accepted = await options\.onNavigateAction\(destination\.toString\(\), anchor\.target \|\| "_self"\)/);
  // After an accepted handover this document must stop deciding — but with a
  // deadline. Parking forever hid a run in `running` for thirteen minutes with
  // every budget blind to it, because budgets are only checked inside the loop.
  assert.match(adaptive, /return awaitPageHandoff\(\);/);
  assert.match(port, /\/cancel/);
  assert.match(port, /Cancellation deliberately has no optimistic revision precondition/);
  assert.match(port, /this\.clearNavigationIntent\(true\);\r?\n    this\.saveCheckpoint\(\);\r?\n    this\.saveRunPointer\(\);/);
  assert.match(port, /goal: session\.goal, input: session\.input/,
    "TaskEpisode identity must keep the immutable AgentRun goal while the execution brief remains internal guidance");
  assert.match(shared, /__SiteWakeNavigate/);
  assert.match(store, /expectedRevision/);
  assert.match(store, /export async function cancelAgentRun/);
  assert.match(store, /agent_run_page_superseded/);
  assert.match(store, /resume_token_hash=\?/);
  assert.match(store, /checkpointTransferred/);
  assert.match(port, /checkpoint: transferredCheckpoint \? this\.checkpointForRun/);
  assert.match(port, /activityTimeline: checkpoint\.activityTimeline \|\| this\.activityTimeline/);
  assert.match(port, /await enforceRuntimeReleaseReadiness\([\s\S]*releasePromise,[\s\S]*\);[\s\S]*const pointer = this\.readRunPointer\(\)/);
  assert.match(port, /executable capability[\s\S]*must never start from that cache/);
  const runtimeReleaseLoad = port.slice(
    port.indexOf("const releasePromise = this.runtimeReleaseClient.read"),
    port.indexOf("// The cache makes the widget paint immediately", port.indexOf("const releasePromise = this.runtimeReleaseClient.read")),
  );
  assert.match(runtimeReleaseLoad, /this\.saveRelease\(remote\.release\)/);
  assert.doesNotMatch(
    runtimeReleaseLoad,
    /remote\.release\.version >= this\.release\.version/,
    "the authoritative runtime Release must replace a higher-version cache after a restore or clean reset",
  );
  assert.match(port, /onStatus: \(next\) => this\.status\(next\.phase, next\.message, next\.detail\)/);
  assert.match(store, /activityTimeline: safeCheckpoint\?\.activityTimeline \|\| current\.activityTimeline/);
  assert.match(store, /activeRelease\.profile\.allowedOrigins/);
  assert.doesNotMatch(store, /overview\.overview\.connection\?\.origin/);
  assert.doesNotMatch(store, /SITEWAKE_LOCAL_DEV/);
  const runRoute = await readFile(new URL("../app/api/agent-runs/route.ts", import.meta.url), "utf8");
  assert.match(runRoute, /request\.headers\.get\("origin"\)/);
  assert.match(runRoute, /controlPlaneOriginForRequest\(request\)/);
  assert.match(runRoute, /controller === "script" && !strictRunnerAuthorized\(request\)/);
  const runHttp = await readFile(new URL("../app/api/agent-runs/http.ts", import.meta.url), "utf8");
  assert.match(runHttp, /browser_session_rejected/);
  const siteAgentRoute = await readFile(new URL("../app/api/site-agents/route.ts", import.meta.url), "utf8");
  assert.match(siteAgentRoute, /if \(!\(await managementMutationAuthorized\(request\)\)\)/);
  const connectionRoute = await readFile(new URL("../app/api/site-agents/[siteAgentId]/connection/route.ts", import.meta.url), "utf8");
  assert.match(connectionRoute, /await siteAgentExists\(siteAgentId\)/);
  assert.match(connectionRoute, /await managementAuthorized\(request\)/);
  assert.match(connectionRoute, /requestOrigin !== controlPlaneOrigin/);
  assert.match(connectionRoute, /configuredOrigins\.includes\(requestOrigin\)/);
  const releaseRoute = await readFile(new URL("../app/api/site-agents/[siteAgentId]/release/route.ts", import.meta.url), "utf8");
  assert.match(releaseRoute, /await siteAgentExists\(siteAgentId\)/);
  const overviewRoute = await readFile(new URL("../app/api/site-agents/[siteAgentId]/route.ts", import.meta.url), "utf8");
  assert.match(overviewRoute, /await siteAgentExists\(siteAgentId\)/);
  assert.match(overviewRoute, /await managementMutationAuthorized\(request\)/);
  const siteHttp = await readFile(new URL("../app/api/site-agents/http.ts", import.meta.url), "utf8");
  assert.match(siteHttp, /strictRunnerAuthorized/);
  assert.match(siteHttp, /runnerTokenAuthorized\(request, false\)/);
  assert.match(siteHttp, /brandedEnv\("LOCAL_DEV"\) === "1" && process\.env\.NODE_ENV !== "production"/);
  assert.match(siteHttp, /return process\.env\[`SITEWAKE_\$\{suffix\}`\]\?\.trim\(\)/);
  assert.match(siteHttp, /configuredPublicOrigins\(\)\.includes\(requestOrigin\)/);
  assert.match(siteHttp, /const originHeader = request\.headers\.get\("origin"\)\?\.trim\(\)/);
  assert.match(siteHttp, /requestOrigin !== controlPlaneOrigin/);
  assert.match(siteHttp, /return managementAuthorized\(request\)/);
  const viteConfig = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(viteConfig, /"SITEWAKE_LOCAL_DEV"/);
  assert.match(viteConfig, /"SITEWAKE_LOCAL_DEV"/);
  const deployPrepare = await readFile(new URL("../scripts/prepare-cloudflare-deploy.mjs", import.meta.url), "utf8");
  assert.match(deployPrepare, /SITEWAKE_PUBLIC_ORIGIN: `https:\/\/\$\{process\.env\.CLOUDFLARE_ROUTE_HOSTNAME\.trim\(\)\}`/);
  const finishRun = port.slice(port.indexOf("private async finishRun"), port.indexOf("private async initialize"));
  assert.match(finishRun, /clearTimeout\(this\.checkpointSyncTimer\)/);
  assert.match(finishRun, /this\.pendingServerCheckpoint = undefined;[\s\S]*await this\.settleRunSync\(\)/);
  assert.match(store, /terminalRunStatus\(stored\.run\.status\)[\s\S]*agent_run_already_terminal/);
  assert.match(store, /ignored: "terminal-run"/);
  assert.match(port, /expectedRunId && latest\.runId !== expectedRunId/);
  assert.match(port, /async resetConversation\(\)/);
  assert.match(client, /resettingConversation/);
  assert.match(client, /if \(!isVisibleTool \|\| activity\?\.state !== "running"\) progress\.classList\.remove/);
  assert.match(client, /run-trace-head/);
  // The copy is in the widget dictionary; the two literals are gone from source. The
  // assertion is now two parts: the component wires the right key, and the dictionary
  // still has the sentence. Nothing weakened — changing copy does not false-alarm,
  // deleting a key or breaking the wiring does.
  assert.match(client, /renderOperationTrace\(target, entries \|\| \[\], locale === "en", turnInFlight\(taskId\)\)/, "操作过程使用同一个支持中英文的会话组件，并知道这一轮是否还在跑");
  // A stop has no terminal status, so the widget closes the running row itself; all three cancel paths must go through this one.
  assert.match(client, /function stopActiveRun\(\)[\s\S]*?item\.state === "running" \? \{ \.\.\.item, state: "failed" \}/, "停止后不能留下永远转圈的操作行");
  assert.doesNotMatch(client, /cancelActiveTaskLaunch\(\); activePort\.cancel\(\); setMode/, "取消入口不能绕过 stopActiveRun");
  assert.match(client, /copy\.(status|progress)\.generating/, "生成回答的状态必须来自词表");
  const widgetCopy = await readFile(new URL("../client/user-agent-copy.ts", import.meta.url), "utf8");
  assert.match(widgetCopy, /label: "操作记录"/);
  assert.match(widgetCopy, /generating: "正在生成回答"/);
  assert.match(client, /message\.id === streamingMessageId \? " streaming"/);
});

test("the adaptive Agent consumes the same terminal capability catalog as the main Agent", async () => {
  const adaptive = await readFile(new URL("../client/user-agent-adaptive.ts", import.meta.url), "utf8");
  assert.match(adaptive, /userInvocableCapabilities\(release\)/);
  assert.doesNotMatch(adaptive, /capability\.exposure === "internal"/);
  assert.match(adaptive, /const unique = new Map/);
});

test("the single main Agent receives typed capability tools while direct calls stay model-free", async () => {
  const [port, client] = await Promise.all([
    readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8"),
    readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8"),
  ]);
  assert.match(port, /runMainAgent/);
  assert.match(port, /capabilityToolbox/);
  assert.match(port, /search_capabilities/);
  assert.doesNotMatch(port, /only tool that reads the live page/);
  assert.match(port, /Published capabilities also read and operate the live page/);
  const toolbox = port.slice(port.indexOf("private capabilityToolbox"), port.indexOf("private directNavigationCapability"));
  assert.match(toolbox, /userInvocableCapabilities\(this\.release\)/);
  assert.match(toolbox, /invocableIds\.has\(capability\.id\)/, "every ranked formal Capability obeys the deduplicated terminal allowlist");
  assert.match(toolbox, /rankPublishedCapabilities\(invocableRelease, goal, 20\)/, "ranking truncates only after the terminal allowlist is applied");
  assert.match(toolbox, /capability\.kind !== "navigation"/, "NavigationTools remain knowledge assets instead of model business tools");
  const directNavigation = port.slice(port.indexOf("private directNavigationCapability"), port.indexOf("private searchKnowledge"));
  assert.match(directNavigation, /const invocable = userInvocableCapabilities\(this\.release\)/);
  assert.match(directNavigation, /strategyOperationIds/, "a shadowed adapter resolves to its managed capability through shared execution structure");
  assert.match(directNavigation, /sceneRequiresLiveEntityClick/, "dynamic product destinations cannot become zero-input navigation shortcuts");
  assert.doesNotMatch(directNavigation, /return this\.release\.capabilities\.find/, "the fast path cannot bypass the terminal allowlist");
  const mainAgent = port.slice(port.indexOf("private async runMainAgent"), port.indexOf("private async loadAdaptive"));
  assert.match(mainAgent, /exactCandidate && invocableIds\.has\(exactCandidate\.id\)/, "the exact fast path obeys the terminal allowlist");
  assert.doesNotMatch(mainAgent, /!navigationIntent|navigationIntent \? \[\]/, "goal categories cannot hide published capabilities");
  assert.match(mainAgent, /const deterministicV2Candidate = exactV2/, "a single fuzzy hit is not execution authority");
  assert.match(mainAgent, /const discovered = invocable\.find/, "searched capability calls obey the same allowlist");
  const adaptiveRun = port.slice(port.indexOf("private async runAdaptive"), port.indexOf("private async runExecutionFollowup"));
  assert.match(adaptiveRun, /release: \{ \.\.\.this\.release, capabilities: userInvocableCapabilities\(this\.release\) \}/);
  assert.match(adaptiveRun, /const capability = userInvocableCapabilities\(this\.release\)/, "PageAgent capability callbacks revalidate the terminal allowlist");
  const submitGoal = client.slice(client.indexOf("async function submitGoal"), client.indexOf("async function beginTeaching"));
  assert.match(submitGoal, /userInvocableCapabilities\(activePort\.getRelease\(\)\)/, "client-side exact suggestions cannot bypass the terminal allowlist");
  assert.doesNotMatch(submitGoal, /activePort\.getCapabilities\(\)/);
  const runEntry = port.slice(port.indexOf("async run(goal"), port.indexOf("async call(capabilityId"));
  assert.doesNotMatch(runEntry, /selectPublishedCapability/);
  assert.match(runEntry, /await this\.refresh\(\)/, "a long-lived tab refreshes executable capabilities before every task");
  const callEntry = port.slice(port.indexOf("private async callCapability"), port.indexOf("async teach(goal"));
  assert.match(callEntry, /await this\.refresh\(trustedExecutionPin\?\.releaseId\)/, "direct calls refresh active while claimed calls load their exact Release");
  assert.match(callEntry, /trustedTaskLaunch \? this\.release\.capabilities : userInvocableCapabilities\(this\.release\)/);
  assert.match(callEntry, /return this\.callCapability\(capabilityId, input, false\)/, "the public call API cannot invoke hidden capabilities");
  assert.match(port, /trustedTaskLaunchCalls\.set\(this,[\s\S]*this\.callCapability\(capabilityId, input, true, executionPin\)/, "trusted TaskLaunch execution remains module-private and pinned");
  assert.doesNotMatch(port, /async callFromTaskLaunch/);
  assert.match(client, /claimed\.capabilityId\) await callFromClaimedTaskLaunch\(activePort, claimed\.capabilityId, claimed\.input, executionPin!\)/);
  assert.match(port, /directCall = false/);
  assert.match(port, /directCall\r?\n\s*\? \(episode\.outcome\.status === "success"/);
  assert.match(port, /undefined, true\);/);
});

test("the four-table Capability contract persists Public and Internal exposure", async () => {
  const [model, store] = await Promise.all([
    readFile(new URL("../lib/capability-center/model.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/capability-center-store.ts", import.meta.url), "utf8"),
  ]);
  assert.match(model, /exposure:\s*"public"\s*\|\s*"internal"/);
  assert.match(store, /exposure:\s*metadata\.exposure\s*\|\|\s*"public"/);
  assert.match(store, /exposure:\s*capability\.exposure/);
});

test("a navigation handoff is one atomic write and ordinary reads never reset executable history", async () => {
  const [port, store] = await Promise.all([
    readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8"),
  ]);
  const handoff = port.slice(port.indexOf("private async prepareRunHandoff"), port.indexOf("private async navigateWithRun"));
  assert.doesNotMatch(handoff, /flushCheckpoint\(navigating\)/);
  assert.match(handoff, /atomic checkpoint \+ continuation-token write/);
  assert.match(port, /handoffCommitted/);
  assert.match(port, /this\.handoffCommitted = true/);
  assert.doesNotMatch(store, /resetExecutableAssetsIfRequired/);
  const capabilityReads = store.slice(
    store.indexOf("export async function listCapabilityProjects"),
    store.indexOf("export async function createAutonomousCapabilityGoal"),
  );
  assert.doesNotMatch(capabilityReads, /\bDELETE\s+FROM\b/);
});

test("an authored module resumes the same operation after a document navigation", async () => {
  const port = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  const executeModule = port.slice(port.indexOf("private async executeModule"), port.indexOf("private async executeProgram"));
  assert.match(executeModule, /loaded\.capability/);
  assert.match(executeModule, /capability\.stages/);
  assert.match(executeModule, /await this\.compiledAwait\(runtimeWindow, \(\) => this\.armNavigationIntent\(\)\)/);
  assert.match(executeModule, /phase: "waiting-page-restore" as const, operationIndex/);
  assert.match(executeModule, /programStepIndex: stageIndex \+ 1/);
  assert.doesNotMatch(executeModule, /nextOperationIndex/);
  assert.match(port, /this\.executeModule\([^\n]+operationIndex, operationIndex === startOperation/);
  const executeCapability = port.slice(port.indexOf("private async executeCapability"), port.indexOf("private async executeCandidate"));
  assert.match(executeCapability, /if \(!moduleImplementation\)/);
  assert.match(executeCapability, /await this\.compiledAwait\(runtimeWindow, \(\) => this\.verifyOperation\(operation, candidate\)\)/);
  assert.match(executeCapability, /const value = input\[parameter\.id\]/);
  assert.doesNotMatch(executeCapability, /input\[parameter\.id\] \?\? parameter\.examples\[0\]/, "runtime navigation must never execute an authoring example as user input");
  assert.match(executeCapability, /selection\.score === 0 && !moduleOwnsNavigation/, "a staged module owns its navigation without a generic pre-hop");
});
