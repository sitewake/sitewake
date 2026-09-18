import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

process.env.CAPABILITY_V2_AUTO_DISPATCH = "0";
process.env.SITEWAKE_PAGE_AGENT_RUNTIME_V2 = "all";
process.env.SITEWAKE_PAGE_AGENT_EVIDENCE_V2 = "all";
process.env.SITEWAKE_CAPABILITY_EXPERIENCE_OUTBOX = "all";
process.env.OPENAI_API_KEY = "outbox-test-key";
process.env.OPENAI_BASE_URL = "https://model.outbox.test/v1";
process.env.OPENAI_MODEL = "outbox-test-model";

async function bundledStores() {
  const result = await build({
    stdin: {
      contents: `
        export * as outbox from "../db/capability-experience-outbox-store";
        export * as runs from "../db/agent-run-store";
        export * as sites from "../db/site-agent-store";
        export * as observations from "../db/page-observation-store";
        export * as observationHash from "../lib/capability-center-v2/page-observation";
        export * as capabilities from "../db/capability-center-v2-store";
        export * as modules from "../db/capability-center-v2-module-store";
      `,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      sourcefile: "capability-experience-outbox-test-entry.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const store = await bundledStores();
const abstraction = {
  name: "搜索目录商品",
  description: "按用户提供的关键词搜索目录并展示最终结果",
  aliases: ["查找目录商品"],
  intent: "使用指定关键词搜索目录并展示匹配结果",
  parameters: [{ name: "query", type: "string", description: "目录搜索关键词", required: true, exampleValue: "cushion" }],
};

function modelResponse() {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(abstraction) } }],
  }), { headers: { "content-type": "application/json" } });
}

function installModelFixture(delayMs = 0) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return modelResponse();
  };
  return () => { globalThis.fetch = original; };
}

let fixtureSequence = 0;

function uniqueId(prefix) {
  fixtureSequence += 1;
  return `${prefix}-${fixtureSequence}`;
}

async function pageObservation(context, input) {
  const capturedAt = new Date().toISOString();
  const value = {
    schemaVersion: "page-agent-observation.v1",
    id: input.id,
    siteAgentId: context.siteAgentId,
    runId: context.run.id,
    episodeId: context.episodeId,
    browserSessionId: context.browserSessionId,
    documentId: context.documentId,
    pageEpoch: context.run.pageEpoch,
    turnIndex: input.turnIndex,
    kind: input.turnIndex === 0 ? "full" : "delta",
    ...(input.turnIndex > 0 ? { baseObservationId: input.baseObservationId } : {}),
    state: {
      url: "https://shop.outbox.test/catalog",
      title: input.title,
      header: "Catalog",
      content: input.content,
      footer: "",
    },
    targets: input.targets.map((target) => ({ ...target, observationId: input.id })),
    sha256: "0".repeat(64),
    producer: {
      controller: "@page-agent/page-controller",
      controllerVersion: "1.12.1",
      projection: "user-agent-adaptive",
      projectionVersion: 1,
    },
    capturedAt,
    expiresAt: new Date(Date.parse(capturedAt) + 14 * 86_400_000).toISOString(),
  };
  value.sha256 = await store.observationHash.pageObservationSha256(value);
  return value;
}

function observationRef(observation) {
  return {
    id: observation.id,
    pageEpoch: observation.pageEpoch,
    documentId: observation.documentId,
    turnIndex: observation.turnIndex,
    kind: observation.kind,
    sha256: observation.sha256,
  };
}

function snapshot(context, observation, sequence) {
  return {
    id: uniqueId("snapshot"),
    sessionId: context.run.id,
    documentId: context.documentId,
    sequence,
    url: observation.state.url,
    title: observation.state.title,
    heading: observation.state.header,
    visibleText: observation.state.content,
    links: [],
    capturedAt: observation.capturedAt,
  };
}

async function createRunContext(siteAgentId = uniqueId("site")) {
  await store.sites.createSiteAgent({ id: siteAgentId, name: "Outbox Shop", url: "https://shop.outbox.test/catalog" });
  const browserSessionId = uniqueId("browser");
  const documentId = uniqueId("document");
  const created = await store.runs.createAgentRun({
    siteAgentId,
    origin: "https://shop.outbox.test",
    url: "https://shop.outbox.test/catalog",
    goal: "search for cushion",
    taskInput: { query: "cushion" },
    documentId,
    browserSessionId,
    controller: "page-agent",
    requestOrigin: "https://shop.outbox.test",
  });
  return { siteAgentId, browserSessionId, documentId, ...created };
}

async function evidenceFor(context, outcomeStatus = "success") {
  const searchButton = { index: 1, semanticId: "catalog-search-submit", role: "button", accessibleName: "Search catalog" };
  const first = await pageObservation(context, {
    id: uniqueId("observation"), turnIndex: 0, title: "Catalog", content: "Search form",
    targets: [searchButton],
  });
  const terminalContent = outcomeStatus === "no-result"
    ? "No results were found"
    : "Search results: 1 result for cushion";
  const terminalTargets = outcomeStatus === "no-result"
    ? [searchButton]
    : [searchButton, { index: 2, semanticId: "catalog-result", role: "link", accessibleName: "Cushion product" }];
  const terminal = await pageObservation(context, {
    id: uniqueId("observation"), turnIndex: 1, baseObservationId: first.id, title: "Search results", content: terminalContent,
    targets: terminalTargets,
  });
  const now = new Date().toISOString();
  const receipts = [{
    id: uniqueId("receipt"), turnIndex: 0, action: "click", target: first.targets[0], input: { query: "cushion" },
    beforeObservationId: first.id, afterObservationId: terminal.id, dispatched: true, effect: "changed", effectSignals: {}, startedAt: now, endedAt: now,
  }];
  return { observations: [first, terminal], receipts };
}

async function searchEvidenceWithSyntheticEnter(context) {
  const searchField = {
    index: 1,
    semanticId: "catalog-search-query",
    role: "searchbox",
    controlType: "search",
    accessibleName: "Search catalog",
    formSignature: "catalog-search",
  };
  const first = await pageObservation(context, {
    id: uniqueId("observation"), turnIndex: 0, title: "Catalog", content: "Search form. Featured Cushion product",
    targets: [searchField, { index: 2, semanticId: "catalog-result-cushion", role: "link", accessibleName: "Cushion product" }],
  });
  const afterInput = await pageObservation(context, {
    id: uniqueId("observation"), turnIndex: 1, baseObservationId: first.id, title: "Catalog", content: "Search form. Search field has a value. Featured Cushion product",
    targets: [searchField, { index: 2, semanticId: "catalog-result-cushion", role: "link", accessibleName: "Cushion product" }],
  });
  const afterPress = await pageObservation(context, {
    id: uniqueId("observation"), turnIndex: 2, baseObservationId: afterInput.id, title: "Catalog", content: "Search form. Search field has a value. Featured Cushion product",
    targets: [searchField, { index: 2, semanticId: "catalog-result-cushion", role: "link", accessibleName: "Cushion product" }],
  });
  const terminal = await pageObservation(context, {
    id: uniqueId("observation"), turnIndex: 3, baseObservationId: afterPress.id, title: "Search results for cushion", content: "There are 3 products.",
    targets: [searchField, { index: 2, semanticId: "catalog-result-cushion", role: "link", accessibleName: "Cushion product" }],
  });
  const now = new Date().toISOString();
  const receipts = [
    {
      id: uniqueId("receipt"), turnIndex: 0, action: "set-text", target: first.targets[0], input: { index: 1, text: "cushion" },
      beforeObservationId: first.id, afterObservationId: afterInput.id, dispatched: true, effect: "changed", effectSignals: {}, startedAt: now, endedAt: now,
    },
    {
      id: uniqueId("receipt"), turnIndex: 1, action: "press", target: afterInput.targets[0], input: { index: 1, key: "Enter" },
      beforeObservationId: afterInput.id, afterObservationId: afterPress.id, dispatched: true, effect: "unknown",
      effectSignals: { synthetic: true, isTrusted: false, handling: "unknown", observedStateChanged: false }, startedAt: now, endedAt: now,
    },
    {
      id: uniqueId("receipt"), turnIndex: 2, action: "submit", target: afterPress.targets[0], input: { index: 1 },
      beforeObservationId: afterPress.id, afterObservationId: terminal.id, dispatched: true, effect: "changed", effectSignals: {}, startedAt: now, endedAt: now,
    },
  ];
  return { observations: [first, afterInput, afterPress, terminal], receipts };
}

function episodeFor(context, evidence, options = {}) {
  const first = evidence.observations[0];
  const terminal = evidence.observations.at(-1);
  const now = new Date().toISOString();
  const outcomeStatus = options.outcomeStatus || "success";
  return {
    schemaVersion: "2.0",
    id: context.episodeId,
    siteAgentId: context.siteAgentId,
    taskSessionId: context.run.id,
    browserSessionId: context.browserSessionId,
    documentId: context.documentId,
    mode: options.mode || "adaptive",
    goal: context.run.goal,
    normalizedGoal: context.run.goal,
    input: context.run.input,
    startedAt: first.capturedAt,
    endedAt: terminal.capturedAt,
    ...(options.capabilityId ? { capabilityId: options.capabilityId } : {}),
    ...(options.sourceCapabilityId ? { sourceCapabilityId: options.sourceCapabilityId } : {}),
    ...(options.repairKind ? { repairKind: options.repairKind } : {}),
    ...(options.compiledExecutionGrantId ? { compiledExecutionGrantId: options.compiledExecutionGrantId } : {}),
    pageExecutionBrief: {
      objective: context.run.goal,
      normalizedGoal: context.run.goal,
      entities: { query: "cushion" },
      effect: "read",
      completionCriteria: [
        `Complete the user's original objective: ${context.run.goal}`,
        "Observe the page state after the requested page action.",
      ],
      relevantSceneIds: [], relevantCapabilityIds: [], rejectedCapabilityReasons: [], knowledgeReceiptRefs: [],
    },
    startSnapshot: snapshot(context, first, 0),
    endSnapshot: snapshot(context, terminal, 1),
    transitions: [],
    outcome: {
      status: outcomeStatus,
      code: outcomeStatus === "no-result" ? "no_results" : outcomeStatus === "unknown" ? "budget_timeout" : "completed",
      summary: outcomeStatus === "no-result" ? "No matching products" : outcomeStatus === "unknown" ? "Execution timed out" : "Search completed",
      evaluatedAt: now,
      evidence: {},
    },
    experience: {
      version: 1,
      actions: [],
      actorSummary: "Searched the catalog",
      judgeEvidence: [],
      observationRefs: evidence.observations.map(observationRef),
      actionReceiptsV2: options.receipts || evidence.receipts,
      budgetEvidence: { activeLimitMs: 180_000, modelRequestLimit: 10, activeElapsedMs: 1_000, modelRequests: 1, noProgressCount: 0 },
    },
  };
}

async function queueAdaptiveEpisode(outcomeStatus = "success", siteAgentId, evidenceFactory = evidenceFor) {
  const context = await createRunContext(siteAgentId);
  context.run = (await store.runs.consumeAgentRunRuntimeModelRequest(context.run.id, {
    token: context.resumeToken,
    stage: "runtime-page-agent",
  })).run;
  context.episodeId = uniqueId("episode");
  const evidence = await evidenceFactory(context, outcomeStatus);
  await store.observations.appendPageAgentObservations(context.run, evidence.observations);
  const episode = episodeFor(context, evidence, { outcomeStatus });
  const authorized = await store.runs.authorizeAgentRunEpisode(context.run.id, context.resumeToken, episode);
  assert.equal(authorized.experienceAuthority?.kind, "create");
  const accepted = await store.sites.appendTaskEpisode(context.siteAgentId, episode, { experienceAuthority: authorized.experienceAuthority });
  assert.equal(accepted.accepted, true);
  return { context, evidence, episode, authority: authorized.experienceAuthority };
}

async function publishSourceCapability(siteAgentId) {
  const source = `export const capability={version:2,stages:[{id:"complete",async run({input}){void input;return {outcome:"Success",output:{ok:true}}}}]};`;
  const stored = await store.modules.putCapabilityV2Module(siteAgentId, source);
  const program = {
    schemaVersion: "2.0",
    runtime: "BrowserJavaScriptStage",
    module: stored.module,
    entry: { mode: "CurrentPage" },
    stages: [{ id: "complete", title: "Complete", purpose: "Complete the requested browser operation", effect: "read", resumePolicy: "skip-completed", io: { reads: { input: [], state: [] }, writes: { state: [], output: ["ok"] } }, navigation: "none" }],
    parameterRoles: [],
    targetBindings: [],
    promptProvenance: [],
  };
  const contract = {
    intent: "Open the current catalog",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    outputSchema: { type: "object", additionalProperties: true },
    preconditions: [],
    successConditions: [{ type: "urlIncludes", value: "shop.outbox.test" }],
  };
  const discovery = await store.capabilities.createCapabilityTask(siteAgentId, {
    type: "Discovery",
    goal: "Search catalog",
    input: {
      candidateSummary: { name: "Published catalog search", description: "Search the product catalog", aliases: [], contract },
      program, parameters: {}, context: { startUrl: "https://shop.outbox.test/catalog" }, interactions: [], trigger: {},
    },
  });
  await store.capabilities.claimTask(siteAgentId, discovery.task.id, "source-discovery-runner");
  const discovered = await store.capabilities.submitTaskResult(siteAgentId, discovery.task.id, "source-discovery-runner", {
    outcome: "Success", candidateProgram: program, candidateSource: source, output: {},
  });
  const capabilityId = discovered.task.result.capabilityId;
  const versionId = discovered.task.result.versionId;
  const validation = await store.capabilities.createCapabilityTask(siteAgentId, {
    type: "Validation", versionId, goal: "Validate catalog search",
    input: { parameters: {}, context: { startUrl: "https://shop.outbox.test/catalog" }, interactions: [], trigger: {} },
  });
  await store.capabilities.claimTask(siteAgentId, validation.task.id, "source-validation-runner");
  await store.capabilities.submitTaskResult(siteAgentId, validation.task.id, "source-validation-runner", { outcome: "Success", output: {} });
  await store.capabilities.reviewVersion(siteAgentId, versionId, { decision: "Approved", model: "outbox-test-model" });
  const capability = await store.capabilities.getCapability(siteAgentId, capabilityId);
  assert.equal(capability.currentVersionId, versionId);
  assert.equal(capability.status, "Active");
  return { capabilityId, versionId };
}

async function repairEpisode(source) {
  const context = await createRunContext(source.siteAgentId);
  const grant = await store.runs.grantCompiledCapabilityExecution(context.run.id, {
    token: context.resumeToken,
    capabilityId: source.capabilityId,
    versionId: source.versionId,
  });
  context.run = grant.run;
  const failedEpisodeId = uniqueId("compiled-failure");
  const failedContext = { ...context, episodeId: failedEpisodeId };
  const failedEvidence = await evidenceFor(failedContext, "success");
  const failed = episodeFor(failedContext, failedEvidence, {
    mode: "compiled",
    outcomeStatus: "unknown",
    capabilityId: source.capabilityId,
    sourceCapabilityId: source.capabilityId,
    repairKind: "compiled-capability-drift",
    compiledExecutionGrantId: grant.executionGrantId,
    receipts: [],
  });
  failed.outcome = { status: "execution-fault", code: "target_not_found", summary: "Compiled target drifted", evaluatedAt: new Date().toISOString(), evidence: {} };
  failed.experience = undefined;
  const marked = await store.runs.authorizeAgentRunEpisode(context.run.id, context.resumeToken, failed);
  assert.equal(marked.compiledRepairSourceCapabilityId, source.capabilityId);

  context.run = marked.run;
  context.run = (await store.runs.consumeAgentRunRuntimeModelRequest(context.run.id, {
    token: context.resumeToken,
    stage: "runtime-page-agent",
  })).run;
  context.episodeId = uniqueId("repair-episode");
  const evidence = await evidenceFor(context, "success");
  await store.observations.appendPageAgentObservations(context.run, evidence.observations);
  const episode = episodeFor(context, evidence, {
    mode: "repair",
    capabilityId: source.capabilityId,
    sourceCapabilityId: source.capabilityId,
    repairKind: "compiled-capability-drift",
  });
  const authorized = await store.runs.authorizeAgentRunEpisode(context.run.id, context.resumeToken, episode);
  assert.equal(authorized.experienceAuthority?.kind, "strengthen");
  assert.equal(authorized.experienceAuthority?.sourceVersionId, source.versionId);
  const accepted = await store.sites.appendTaskEpisode(context.siteAgentId, episode, { experienceAuthority: authorized.experienceAuthority });
  assert.equal(accepted.accepted, true);
  return { context, evidence, episode, authority: authorized.experienceAuthority };
}

test("capability experience outbox closes accepted Episode evidence exactly once", async (t) => {
  store.outbox.resetMemoryCapabilityExperienceOutbox();
  store.observations.resetMemoryPageObservationStore();
  store.sites.resetMemorySiteAgentStore();
  store.capabilities.resetCapabilityCenterV2ForTests();
  store.modules.resetCapabilityV2ModulesForTests();

  await t.test("adaptive success and no-result each create one linked Discovery and retain evidence for 90 days", async () => {
    const restoreFetch = installModelFixture();
    try {
      for (const outcomeStatus of ["success", "no-result"]) {
        const queued = await queueAdaptiveEpisode(outcomeStatus);
        const first = await store.outbox.processCapabilityExperienceOutbox(2);
        assert.equal(first.processed, 1);
        const duplicate = await store.sites.appendTaskEpisode(queued.context.siteAgentId, queued.episode, { experienceAuthority: queued.authority });
        assert.equal(duplicate.accepted, false);
        await store.outbox.processCapabilityExperienceOutbox(2);

        const tasks = (await store.capabilities.listTasks(queued.context.siteAgentId, { includeArchived: true, includeDeleted: true })).tasks
          .filter((task) => task.type === "Discovery" && task.sourceAgentRunId === queued.context.run.id);
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0].input.experience.episodeId, queued.episode.id);
        assert.equal(tasks[0].input.experience.outcome, outcomeStatus === "no-result" ? "NoResult" : "Success");

        const item = await store.outbox.getCapabilityExperienceOutboxItem(queued.context.siteAgentId, queued.episode.id, "create");
        assert.equal(item.status, "completed");
        assert.deepEqual(item.result, {
          siteAgentId: queued.context.siteAgentId,
          runId: queued.context.run.id,
          episodeId: queued.episode.id,
          authority: "create",
          disposition: "Created",
          taskId: tasks[0].id,
        });
        const retained = await store.observations.getPageAgentObservations(queued.context.run.id, { siteAgentId: queued.context.siteAgentId, episodeId: queued.episode.id, includeExpired: true });
        assert.equal(retained.length, queued.evidence.observations.length);
        assert.ok(retained.every((observation) => Date.parse(observation.expiresAt) >= Date.now() + 90 * 86_400_000 - 2_000));
      }
    } finally {
      restoreFetch();
    }
  });

  await t.test("AI-success search binds receipt input when the initial page already mentions the entity", async () => {
    const restoreFetch = installModelFixture();
    try {
      const queued = await queueAdaptiveEpisode("success", uniqueId("enter-search-site"), searchEvidenceWithSyntheticEnter);
      assert.equal(queued.episode.outcome.evidence.humanConfirmation, undefined);
      const processed = await store.outbox.processCapabilityExperienceOutbox(2);
      assert.equal(processed.processed, 1);
      const tasks = (await store.capabilities.listTasks(queued.context.siteAgentId, { includeArchived: true, includeDeleted: true })).tasks
        .filter((task) => task.type === "Discovery" && task.sourceAgentRunId === queued.context.run.id);
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].input.experience.episodeId, queued.episode.id);
      assert.deepEqual(queued.evidence.receipts.map((receipt) => receipt.action), ["set-text", "press", "submit"]);
    } finally {
      restoreFetch();
    }
  });

  await t.test("compiled drift creates one Repair bound to the exact source version", async () => {
    const restoreFetch = installModelFixture();
    try {
      const siteAgentId = uniqueId("repair-site");
      await store.sites.createSiteAgent({ id: siteAgentId, name: "Repair Shop", url: "https://shop.outbox.test/catalog" });
      const source = { siteAgentId, ...(await publishSourceCapability(siteAgentId)) };
      const queued = await repairEpisode(source);
      await Promise.all([
        store.outbox.processCapabilityExperienceOutbox(1),
        store.outbox.processCapabilityExperienceOutbox(1),
      ]);
      const repairs = (await store.capabilities.listTasks(siteAgentId, { includeArchived: true, includeDeleted: true })).tasks
        .filter((task) => task.type === "Repair" && task.sourceAgentRunId === queued.context.run.id);
      assert.equal(repairs.length, 1);
      assert.equal(repairs[0].input.trigger.baseVersionId, source.versionId);
      assert.deepEqual(store.capabilities.getTaskMaintenance(repairs[0]), { mode: "Repair", capabilityId: source.capabilityId });
      const item = await store.outbox.getCapabilityExperienceOutboxItem(siteAgentId, queued.episode.id, "strengthen");
      assert.equal(item.result.runId, queued.context.run.id);
      assert.equal(item.result.episodeId, queued.episode.id);
      assert.equal(item.result.taskId, repairs[0].id);
      assert.equal(item.result.sourceCapabilityId, source.capabilityId);
      assert.equal(item.result.sourceVersionId, source.versionId);
    } finally {
      restoreFetch();
    }
  });

  await t.test("concurrent stale reclaim claims once and creates no duplicate task", async () => {
    const restoreFetch = installModelFixture(20);
    try {
      const queued = await queueAdaptiveEpisode("success", uniqueId("stale-site"));
      const item = await store.outbox.getCapabilityExperienceOutboxItem(queued.context.siteAgentId, queued.episode.id, "create");
      item.status = "processing";
      item.attempts = 1;
      item.updatedAt = new Date(Date.now() - 11 * 60_000).toISOString();
      const results = await Promise.all([
        store.outbox.processCapabilityExperienceOutbox(1),
        store.outbox.processCapabilityExperienceOutbox(1),
      ]);
      assert.equal(results.reduce((sum, result) => sum + result.processed, 0), 1);
      const tasks = (await store.capabilities.listTasks(queued.context.siteAgentId, { includeArchived: true, includeDeleted: true })).tasks
        .filter((task) => task.type === "Discovery" && task.sourceAgentRunId === queued.context.run.id);
      assert.equal(tasks.length, 1);
      const completed = await store.outbox.getCapabilityExperienceOutboxItem(queued.context.siteAgentId, queued.episode.id, "create");
      assert.equal(completed.status, "completed");
      assert.equal(completed.attempts, 2);
    } finally {
      restoreFetch();
    }
  });

  await t.test("timeout and incomplete evidence are accepted as Episodes but enqueue zero capability tasks", async () => {
    for (const kind of ["timeout", "incomplete"]) {
      const context = await createRunContext(uniqueId(`${kind}-site`));
      context.episodeId = uniqueId(`${kind}-episode`);
      const evidence = await evidenceFor(context, "success");
      if (kind === "incomplete") await store.observations.appendPageAgentObservations(context.run, evidence.observations);
      const episode = episodeFor(context, evidence, kind === "timeout"
        ? { outcomeStatus: "unknown", receipts: [] }
        : { receipts: [{ ...evidence.receipts[0], afterObservationId: undefined }] });
      if (kind === "timeout") episode.experience = undefined;
      const authorized = await store.runs.authorizeAgentRunEpisode(context.run.id, context.resumeToken, episode);
      assert.equal(authorized.experienceAuthority, undefined);
      const accepted = await store.sites.appendTaskEpisode(context.siteAgentId, episode);
      assert.equal(accepted.accepted, true);
      await store.outbox.processCapabilityExperienceOutbox(2);
      assert.equal(await store.outbox.getCapabilityExperienceOutboxItem(context.siteAgentId, episode.id, "create"), undefined);
      const tasks = (await store.capabilities.listTasks(context.siteAgentId, { includeArchived: true, includeDeleted: true })).tasks
        .filter((task) => task.sourceAgentRunId === context.run.id);
      assert.equal(tasks.length, 0);
    }
  });
});
