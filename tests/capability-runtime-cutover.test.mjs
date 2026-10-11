import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const NOW = "2026-08-01T01:00:00.000Z";

let runtimePromise;
function runtime() {
  runtimePromise ||= build({
    stdin: {
      contents: `
        export * from "./db/site-agent-store.ts";
        export {
          publishCapabilityRuntimeRelease,
          unpublishCapabilityRuntimeRelease,
          relistCapabilityRuntimeRelease,
          deleteCapabilityRuntimeRelease,
        } from "./lib/capability-center/release.ts";
      `,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "memory-runtime",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
          contents: `
            export function getD1Binding() { return null; }
            export function getArtifactBinding() { return null; }
            export class D1UnavailableError extends Error {}
          `,
          loader: "ts",
        }));
      },
    }],
  }).then((result) => import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  ));
  return runtimePromise;
}

function contract(siteAgentId) {
  return {
    id: "capability-new-runtime",
    siteAgentId,
    stableKey: "new-runtime",
    intentKey: "new-runtime",
    name: "Read account summary",
    description: "Read a stable account summary.",
    goalTemplate: "Read account summary",
    kind: "task",
    structure: "atomic",
    operation: "read",
    exposure: "public",
    resultKind: "data",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    },
    executionRequirements: {
      authentication: "unknown",
      supportedEnvironments: {
        connectedBrowser: "verified",
        cloudBrowser: "verified",
        managedProfile: "blocked",
      },
      checkpoints: [],
      evidenceRefs: [],
    },
    status: "active",
    currentVersionId: "capability-version-1",
    latestVersionId: "capability-version-1",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function version(siteAgentId) {
  return {
    id: "capability-version-1",
    siteAgentId,
    capabilityId: "capability-new-runtime",
    version: 1,
    status: "published",
    implementation: {
      kind: "module",
      module: {
        contentHash: "a".repeat(64),
        moduleUrl: "/programs/account-summary.js",
        exportName: "capability",
      },
      proof: {
        version: 1,
        iterationId: "iteration-1",
        author: "ai-program-author",
        rationale: "Validated independently.",
        alternativeIds: [],
        verifier: { success: [], noResult: [], businessRejection: [], executionFault: [] },
        extraction: { fields: [] },
        determinism: { forbiddenApis: [], boundedLoops: true, boundedCollections: true },
        createdAt: NOW,
      },
    },
    validation: {
      status: "passed",
      startUrl: "https://runtime-cutover.test/account",
      validatedContentHash: "a".repeat(64),
    },
    createdAt: NOW,
    updatedAt: NOW,
    publishedAt: NOW,
  };
}

test("new CapabilityRuns pin CapabilityVersion and never require Project/Revision", async () => {
  const api = await runtime();
  api.resetMemorySiteAgentStore();
  globalThis.__SITEWAKE_CAPABILITY_CENTER_V2__ = new Map();
  const siteAgentId = "runtime-cutover";
  await api.createSiteAgent({
    id: siteAgentId,
    name: "Runtime cutover",
    url: "https://runtime-cutover.test/",
  });
  const active = await api.getActiveSiteAgentRelease(siteAgentId);
  const capability = contract(siteAgentId);
  const published = api.publishCapabilityRuntimeRelease(
    {
      ...active.release,
      profile: {
        ...active.release.profile,
        entryUrl: "https://runtime-cutover.test/",
        allowedOrigins: ["https://runtime-cutover.test"],
      },
    },
    capability,
    version(siteAgentId),
    NOW,
  );
  globalThis.__SITEWAKE_CAPABILITY_CENTER_V2__.set(siteAgentId, {
    capabilities: [capability],
    versions: [published.version],
    proposals: [],
    tasks: [],
  });
  const agent = globalThis.__SITEWAKE_SITE_AGENT_V2__.get(siteAgentId);
  agent.releaseHistory.push(published.release);
  agent.release = published.release;

  const created = await api.createCapabilityRun({
    siteAgentId,
    capabilityId: capability.id,
    mode: "run",
    environment: { kind: "cloud-browser" },
    input: {},
  });
  assert.equal(created.run.capabilityVersionId, published.version.id);
  assert.equal(created.run.releaseId, published.release.id);
  assert.equal(created.run.releaseVersion, published.release.version);
  assert.equal(created.run.startUrl, "https://runtime-cutover.test/account");
  assert.equal(created.run.projectId, undefined);
  assert.equal(created.run.revisionId, undefined);

  assert.deepEqual(version(siteAgentId).inputSchema, undefined,
    "Version does not copy the stable contract");
  assert.deepEqual(
    published.release.capabilities[0].outputs,
    capability.outputSchema,
    "the runtime definition gets its contract from Capability",
  );
  assert.equal(
    api.unpublishCapabilityRuntimeRelease(published.release, capability.id, NOW)
      .capabilities.length,
    0,
  );
  assert.equal(
    api.deleteCapabilityRuntimeRelease(published.release, capability.id, NOW)
      .capabilities.length,
    0,
  );
});

test("terminal user gaps wait in durable signals until server AI classifies real experience", async () => {
  const api = await runtime();
  api.resetMemorySiteAgentStore();
  globalThis.__SITEWAKE_CAPABILITY_CENTER_V2__ = new Map();
  const siteAgentId = "terminal-gap-cutover";
  await api.createSiteAgent({
    id: siteAgentId,
    name: "Terminal gap",
    url: "https://terminal-gap.test/",
  });
  const session = {
    id: "session-1",
    siteAgentId,
    browserSessionId: "browser-1",
    goal: "Export invoices",
    input: {},
    conversation: [],
    nextStepIndex: 0,
    bindings: {},
    status: "running",
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: "2026-08-02T01:00:00.000Z",
  };
  await api.createTaskSession(session);
  const result = await api.appendTaskEpisode(siteAgentId, {
    schemaVersion: "site-agent.v2",
    id: "episode-terminal-gap",
    siteAgentId,
    taskSessionId: session.id,
    browserSessionId: session.browserSessionId,
    documentId: "document-1",
    mode: "adaptive",
    goal: "Export invoices",
    normalizedGoal: "export invoices",
    input: {},
    startedAt: NOW,
    endedAt: NOW,
    releaseId: `${siteAgentId}:release:0`,
    startSnapshot: { url: "https://terminal-gap.test/", title: "Terminal gap", capturedAt: NOW },
    endSnapshot: { url: "https://terminal-gap.test/invoices", title: "Invoices", capturedAt: NOW },
    transitions: [],
    outcome: {
      status: "success",
      code: "completed",
      summary: "Invoices exported.",
      evaluatedAt: NOW,
      evidence: {},
    },
    experience: {
      version: 1,
      actions: [{
        id: "action-export",
        action: "click",
        rawAction: "click export",
        input: {},
        page: { url: "https://terminal-gap.test/invoices", title: "Invoices", heading: "Invoices" },
        observedAt: NOW,
      }],
      actorSummary: "Exported invoices from the live page.",
      judgeEvidence: ["https://terminal-gap.test/invoices"],
    },
  }, { triggerAuthority: "terminal-user-gap" });
  assert.equal(result.directive.type, "recorded");
  const agent = globalThis.__SITEWAKE_SITE_AGENT_V2__.get(siteAgentId);
  assert.equal(globalThis.__SITEWAKE_CAPABILITY_CENTER_V2__.get(siteAgentId), undefined);
  assert.equal(agent.capabilitySignals.length, 1);
  assert.deepEqual(agent.capabilitySignals[0].episodeIds, ["episode-terminal-gap"]);
  assert.equal(agent.learningJobs.length, 0);
  assert.equal(agent.capabilityProjects.length, 0);
  assert.equal(agent.capabilityRevisions.length, 0);

  const recorded = agent.episodes[0];
  await api.appendTaskEpisode(siteAgentId, {
    ...recorded,
    id: "episode-terminal-gap-pending-aggregate",
  }, { triggerAuthority: "terminal-user-gap" });
  assert.equal(agent.capabilitySignals.length, 1, "same-intent pending Episodes share one active signal");
  assert.deepEqual(agent.capabilitySignals[0].episodeIds, ["episode-terminal-gap", "episode-terminal-gap-pending-aggregate"]);

  agent.capabilitySignals[0].status = "processing";
  await api.appendTaskEpisode(siteAgentId, {
    ...recorded,
    id: "episode-terminal-gap-processing-aggregate",
  }, { triggerAuthority: "terminal-user-gap" });
  assert.equal(agent.capabilitySignals.length, 1, "same-intent Episodes arriving during analysis do not create another signal");
  assert.equal(agent.capabilitySignals[0].status, "processing");
  assert.deepEqual(agent.capabilitySignals[0].episodeIds, [
    "episode-terminal-gap",
    "episode-terminal-gap-pending-aggregate",
    "episode-terminal-gap-processing-aggregate",
  ]);
  agent.capabilitySignals[0].status = "pending";

  const { experience: _experience, ...withoutExperience } = recorded;
  await api.appendTaskEpisode(siteAgentId, {
    ...withoutExperience,
    id: "episode-conversation-only",
    goal: "Explain invoice exports",
    normalizedGoal: "explain invoice exports",
  }, { triggerAuthority: "terminal-user-gap" });
  await api.appendTaskEpisode(siteAgentId, {
    ...recorded,
    id: "episode-capability-call",
    goal: "Use the existing export capability",
    normalizedGoal: "use existing export capability",
    experience: {
      ...recorded.experience,
      toolReceipts: [{
        kind: "capability",
        name: "Export invoices",
        capabilityId: "capability-export",
        status: "completed",
        summary: "Existing capability completed.",
        observedAt: NOW,
      }],
    },
  }, { triggerAuthority: "terminal-user-gap" });
  await api.appendTaskEpisode(siteAgentId, {
    ...recorded,
    id: "episode-failed-gap",
    goal: "Failed invoice export",
    normalizedGoal: "failed invoice export",
    outcome: { ...recorded.outcome, status: "execution-fault", code: "page_failed" },
  }, { triggerAuthority: "terminal-user-gap" });
  assert.equal(agent.capabilitySignals.length, 1,
    "conversation-only, failed, and completed capability-call Episodes do not create signals");
  assert.equal(agent.learningJobs.length, 0, "terminal completions never fall through to legacy learning jobs");

  const dispatched = await api.processQueuedCapabilitySignals(siteAgentId, 1);
  assert.equal(dispatched.retried, 1, "an unavailable model keeps the signal retryable");
  assert.equal(agent.capabilitySignals[0].status, "pending");
  assert.equal(agent.capabilitySignals[0].attempts, 1);
  assert.equal(agent.capabilitySignals[0].lastError.code, "model_not_configured");
  assert.match(agent.capabilitySignals[0].lastError.summary, /模型|model/i);
  assert.ok(agent.capabilitySignals[0].nextAttemptAt, "the UI receives the next retry time");
  assert.equal(globalThis.__SITEWAKE_CAPABILITY_CENTER_V2__.get(siteAgentId).proposals.length, 0,
    "deterministic fallback must not create a Proposal before AI classifies it");
});
