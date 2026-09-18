import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

async function load(entry, options = {}) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: options.plugins || [],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

let databaseSequence = 0;
async function loadWithDatabase(entry, database) {
  const key = `__FOLLOWUP_LINEAGE_D1_${databaseSequence += 1}`;
  globalThis[key] = database;
  try {
    return await load(entry, {
      plugins: [{
        name: "followup-lineage-d1",
        setup(builder) {
          builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
            loader: "ts",
            contents: `const database = globalThis[${JSON.stringify(key)}] || null;
              export function getD1Binding() { return database; }
              export function getArtifactBinding() { return null; }
              export class D1UnavailableError extends Error {}`,
          }));
        },
      }],
    });
  } finally {
    delete globalThis[key];
  }
}

const runStore = await load("../db/agent-run-store.ts");
const siteStore = await load("../db/site-agent-store.ts");
const observationStore = await load("../db/page-observation-store.ts");
const observationHash = await load("../lib/capability-center-v2/page-observation.ts");
let sequence = 0;

async function createRun(goal = "add Mug to cart", input = { product: "Mug" }) {
  sequence += 1;
  const siteAgentId = `followup-lineage-${sequence}`;
  const origin = `https://followup-${sequence}.test`;
  const documentId = `document-${sequence}`;
  const browserSessionId = `browser-${sequence}`;
  await siteStore.createSiteAgent({ id: siteAgentId, url: `${origin}/` });
  const created = await runStore.createAgentRun({
    siteAgentId,
    origin,
    url: `${origin}/checkout`,
    goal,
    taskInput: input,
    documentId,
    browserSessionId,
    controller: "page-agent",
    requestOrigin: origin,
    controlPlaneOrigin: origin,
  });
  return { ...created, siteAgentId, origin, documentId, browserSessionId, goal, input };
}

async function finish(source, outcome, status = "failed") {
  return runStore.finishAgentRun(source.run.id, {
    token: source.resumeToken,
    expectedRevision: source.run.revision,
    pageEpoch: source.run.pageEpoch,
    status,
    outcome,
  });
}

function uncertainOutcome(code = "adaptive_timeout") {
  return {
    status: "unknown",
    code,
    summary: "The write result is uncertain",
    evaluatedAt: new Date().toISOString(),
    evidence: { source: "runtime" },
  };
}

function childInput(source, intent, sourceToken = source.resumeToken, overrides = {}) {
  return {
    siteAgentId: source.siteAgentId,
    origin: source.origin,
    url: `${source.origin}/checkout`,
    goal: source.goal,
    taskInput: source.input,
    documentId: source.documentId,
    browserSessionId: source.browserSessionId,
    controller: "page-agent",
    requestOrigin: source.origin,
    controlPlaneOrigin: source.origin,
    followup: { sourceTaskId: source.run.id, intent, sourceToken },
    ...overrides,
  };
}

async function persistTrustedNotCompletedReconciliation(source, options = {}) {
  const charged = await runStore.consumeAgentRunRuntimeModelRequest(source.run.id, {
    token: source.resumeToken,
    stage: "runtime-page-agent",
  });
  source.run = charged.run;
  const episodeId = `episode-${source.run.id}`;
  const capturedAt = new Date().toISOString();
  const observation = {
    schemaVersion: "page-agent-observation.v1",
    id: `observation-${source.run.id}`,
    siteAgentId: source.siteAgentId,
    runId: source.run.id,
    episodeId,
    browserSessionId: source.browserSessionId,
    documentId: source.documentId,
    pageEpoch: source.run.pageEpoch,
    turnIndex: 0,
    kind: "full",
    state: {
      url: `${source.origin}/checkout`,
      title: "Shopping cart",
      header: "Shopping cart",
      content: options.observationContent || "Mug is not in your cart. Your cart is empty with 0 items.",
      footer: "",
    },
    targets: [],
    sha256: "0".repeat(64),
    producer: {
      controller: "@page-agent/page-controller",
      controllerVersion: "test",
      projection: "user-agent-adaptive",
      projectionVersion: 1,
    },
    capturedAt,
    expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  };
  observation.sha256 = await observationHash.pageObservationSha256(observation);
  await observationStore.appendPageAgentObservations(source.run, [observation]);
  const snapshot = {
    id: `snapshot-${source.run.id}`,
    sessionId: source.browserSessionId,
    documentId: source.documentId,
    sequence: 1,
    url: observation.state.url,
    title: observation.state.title,
    heading: observation.state.header,
    visibleText: observation.state.content,
    links: [],
    elements: [],
    capturedAt,
  };
  const episode = {
    schemaVersion: "site-agent.v2",
    id: episodeId,
    siteAgentId: source.siteAgentId,
    taskSessionId: source.run.id,
    browserSessionId: source.browserSessionId,
    documentId: source.documentId,
    mode: "adaptive",
    goal: source.goal,
    normalizedGoal: source.goal.toLowerCase(),
    input: source.input,
    startedAt: capturedAt,
    endedAt: capturedAt,
    releaseId: "test-release",
    pageExecutionBrief: {
      objective: `Read-only reconciliation for ${source.goal}`,
      normalizedGoal: source.goal.toLowerCase(),
      entities: source.input,
      effect: "read",
      completionCriteria: ["Report current cart status"],
      relevantSceneIds: [],
      relevantCapabilityIds: [],
      rejectedCapabilityReasons: [],
      knowledgeReceiptRefs: [],
    },
    startSnapshot: snapshot,
    endSnapshot: snapshot,
    transitions: [],
    outcome: {
      status: "no-result",
      code: "reconciliation_not_completed",
      summary: "The page proves the product is not in the cart",
      evaluatedAt: capturedAt,
      evidence: {
        executionIntent: "reconciliation",
        reconciliationStatus: "not-completed",
        structuredOutput: { reconciliationStatus: "not-completed" },
        completionEvidence: [{ criterion: "Report current cart status", evidence: "Mug is not in your cart" }],
      },
    },
    experience: {
      version: 1,
      actions: [],
      actorSummary: "Mug is not in your cart",
      judgeEvidence: [observation.state.url, observation.state.header],
      actionReceiptsV2: [],
      observationRefs: [{
        id: observation.id,
        pageEpoch: observation.pageEpoch,
        documentId: observation.documentId,
        turnIndex: observation.turnIndex,
        kind: observation.kind,
        sha256: observation.sha256,
      }],
      budgetEvidence: {
        activeLimitMs: 30_000,
        modelRequestLimit: 2,
        activeElapsedMs: 100,
        modelRequests: 1,
        noProgressCount: 0,
      },
      runtimeMetrics: [],
      toolReceipts: [],
    },
  };
  const storedEpisode = options.transformEpisode ? options.transformEpisode(structuredClone(episode)) : episode;
  await siteStore.appendTaskEpisode(source.siteAgentId, storedEpisode);
  if (options.record === false) return { source, episode: storedEpisode };
  const marked = await runStore.recordAgentRunReconciliationEpisode(source.run.id, source.resumeToken, storedEpisode.id);
  source.run = marked.run;
  return { source, episode: storedEpisode };
}

test("legal reconciliation and confirmed-continuation form one server-owned two-step lineage", async () => {
  const root = await createRun();
  const terminalRoot = await finish(root, uncertainOutcome());
  root.run = terminalRoot.run;

  const reconciliation = await runStore.createAgentRun(childInput(root, "reconciliation"));
  assert.deepEqual({
    sourceRunId: reconciliation.run.agentState.sourceRunId,
    rootRunId: reconciliation.run.agentState.rootRunId,
    executionIntent: reconciliation.run.agentState.executionIntent,
    lineageDepth: reconciliation.run.agentState.lineageDepth,
  }, {
    sourceRunId: root.run.id,
    rootRunId: root.run.id,
    executionIntent: "reconciliation",
    lineageDepth: 1,
  });

  const reconciliationSource = {
    ...root,
    run: reconciliation.run,
    resumeToken: reconciliation.resumeToken,
  };
  await persistTrustedNotCompletedReconciliation(reconciliationSource);
  const reconciled = await runStore.finishAgentRun(reconciliationSource.run.id, {
    token: reconciliationSource.resumeToken,
    expectedRevision: reconciliationSource.run.revision,
    pageEpoch: reconciliationSource.run.pageEpoch,
    status: "completed",
    outcome: {
      status: "no-result",
      code: "reconciliation_not_completed",
      summary: "The page proves the action did not complete",
      evaluatedAt: new Date().toISOString(),
      evidence: { executionIntent: "reconciliation", reconciliationStatus: "not-completed" },
    },
  });
  reconciliationSource.run = reconciled.run;
  const continuation = await runStore.createAgentRun(childInput(reconciliationSource, "confirmed-continuation"));
  assert.deepEqual({
    sourceRunId: continuation.run.agentState.sourceRunId,
    rootRunId: continuation.run.agentState.rootRunId,
    executionIntent: continuation.run.agentState.executionIntent,
    lineageDepth: continuation.run.agentState.lineageDepth,
  }, {
    sourceRunId: reconciliation.run.id,
    rootRunId: root.run.id,
    executionIntent: "confirmed-continuation",
    lineageDepth: 2,
  });

  const terminalContinuation = await runStore.finishAgentRun(continuation.run.id, {
    token: continuation.resumeToken,
    expectedRevision: continuation.run.revision,
    pageEpoch: continuation.run.pageEpoch,
    status: "failed",
    outcome: uncertainOutcome("side_effect_unknown"),
  });
  const thirdSource = { ...root, run: terminalContinuation.run, resumeToken: continuation.resumeToken };
  await assert.rejects(
    runStore.createAgentRun(childInput(thirdSource, "reconciliation")),
    /agent_run_followup_lineage_rejected/,
  );
  await assert.rejects(
    runStore.createAgentRun(childInput(thirdSource, "confirmed-continuation")),
    /agent_run_followup_confirmation_rejected/,
  );
});

test("source+intent claim is CAS single-use under concurrent create requests", async () => {
  const root = await createRun();
  const terminal = await finish(root, uncertainOutcome("no_progress"));
  root.run = terminal.run;
  const results = await Promise.allSettled([
    runStore.createAgentRun(childInput(root, "reconciliation")),
    runStore.createAgentRun(childInput(root, "reconciliation")),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  assert.match(String(results.find((item) => item.status === "rejected")?.reason), /agent_run_followup_already_claimed/);
  const stored = (await runStore.getAgentRun(root.run.id, root.resumeToken)).run;
  assert.ok(stored.agentState.pageExecutionFollowupClaims.reconciliation.childRunId);
});

test("browser PATCH cannot forge a trusted not-completed reconciliation marker", async () => {
  const root = await createRun();
  const terminal = await finish(root, uncertainOutcome());
  root.run = terminal.run;
  const reconciliation = await runStore.createAgentRun(childInput(root, "reconciliation"));
  const forgedTerminal = await runStore.finishAgentRun(reconciliation.run.id, {
    token: reconciliation.resumeToken,
    expectedRevision: reconciliation.run.revision,
    pageEpoch: reconciliation.run.pageEpoch,
    status: "completed",
    outcome: {
      status: "no-result",
      code: "reconciliation_not_completed",
      summary: "client assertion only",
      evaluatedAt: new Date().toISOString(),
      evidence: { executionIntent: "reconciliation", reconciliationStatus: "not-completed" },
    },
  });
  const forgedSource = { ...root, run: forgedTerminal.run, resumeToken: reconciliation.resumeToken };
  assert.equal(forgedTerminal.run.agentState.reconciliationEpisodeAuthority, undefined);
  await assert.rejects(
    runStore.createAgentRun(childInput(forgedSource, "confirmed-continuation")),
    /agent_run_followup_confirmation_rejected/,
  );
});

test("free-form negative citations and unclosed read actions cannot mint the server marker", async () => {
  const prepare = async (goal, input) => {
    const root = await createRun(goal, input);
    const terminal = await finish(root, uncertainOutcome());
    root.run = terminal.run;
    const reconciliation = await runStore.createAgentRun(childInput(root, "reconciliation"));
    return { ...root, run: reconciliation.run, resumeToken: reconciliation.resumeToken };
  };

  const citationOnly = await prepare("inspect Mug details", { product: "Mug" });
  const citationEvidence = await persistTrustedNotCompletedReconciliation(citationOnly, {
    record: false,
    transformEpisode(episode) {
      episode.outcome.evidence.completionEvidence = [{
        criterion: "Report current cart status",
        evidence: "Mug is not in your cart",
      }];
      // The durable observation itself has no typed cart-negative fact.
      return episode;
    },
  });
  await assert.rejects(
    runStore.recordAgentRunReconciliationEpisode(citationOnly.run.id, citationOnly.resumeToken, citationEvidence.episode.id),
    /agent_run_reconciliation_evidence_rejected|agent_run_reconciliation_episode_rejected/,
  );

  const unclosedAction = await prepare();
  const unclosedEvidence = await persistTrustedNotCompletedReconciliation(unclosedAction, {
    record: false,
    transformEpisode(episode) {
      const ref = episode.experience.observationRefs[0];
      episode.experience.actionReceiptsV2 = [{
        id: "focus-without-after-observation",
        turnIndex: ref.turnIndex,
        action: "focus",
        input: {},
        beforeObservationId: ref.id,
        dispatched: true,
        effect: "unchanged",
        effectSignals: {},
        startedAt: episode.startedAt,
        endedAt: episode.endedAt,
      }];
      return episode;
    },
  });
  await assert.rejects(
    runStore.recordAgentRunReconciliationEpisode(unclosedAction.run.id, unclosedAction.resumeToken, unclosedEvidence.episode.id),
    /agent_run_reconciliation_receipt_chain_rejected/,
  );
});

test("an explicit added-to-cart receipt defeats an unrelated negative sentence", async () => {
  const root = await createRun();
  const terminal = await finish(root, uncertainOutcome());
  root.run = terminal.run;
  const reconciliation = await runStore.createAgentRun(childInput(root, "reconciliation"));
  const source = { ...root, run: reconciliation.run, resumeToken: reconciliation.resumeToken };
  const evidence = await persistTrustedNotCompletedReconciliation(source, {
    record: false,
    observationContent: "Mug is not in wishlist. It was added to cart.",
  });
  await assert.rejects(
    runStore.recordAgentRunReconciliationEpisode(source.run.id, source.resumeToken, evidence.episode.id),
    /agent_run_reconciliation_evidence_rejected/,
  );
  const stored = (await runStore.getAgentRun(source.run.id, source.resumeToken)).run;
  assert.equal(stored.agentState.reconciliationEpisodeAuthority, undefined);
});

test("forged bearer, copied document, altered task, running source, and successful source fail closed", async () => {
  const running = await createRun();
  await assert.rejects(
    runStore.createAgentRun(childInput(running, "reconciliation")),
    /agent_run_followup_source_not_terminal/,
  );

  const successful = await createRun();
  const successfulTerminal = await finish(successful, {
    status: "success",
    code: "completed",
    summary: "done",
    evaluatedAt: new Date().toISOString(),
    evidence: {},
  }, "completed");
  successful.run = successfulTerminal.run;
  await assert.rejects(
    runStore.createAgentRun(childInput(successful, "reconciliation")),
    /agent_run_followup_source_not_uncertain/,
  );

  const root = await createRun();
  const terminal = await finish(root, uncertainOutcome());
  root.run = terminal.run;
  await assert.rejects(
    runStore.createAgentRun(childInput(root, "reconciliation", `${root.run.id}.forged`)),
    /agent_run_token_rejected/,
  );
  await assert.rejects(
    runStore.createAgentRun(childInput(root, "reconciliation", root.resumeToken, { documentId: "copied-document" })),
    /agent_run_followup_context_rejected/,
  );
  await assert.rejects(
    runStore.createAgentRun(childInput(root, "reconciliation", root.resumeToken, { goal: "transfer all funds" })),
    /agent_run_followup_task_rejected/,
  );
  await assert.rejects(
    runStore.createAgentRun(childInput(root, "confirmed-continuation")),
    /agent_run_followup_confirmation_rejected/,
  );
});

test("failed child persistence compensates its source claim before a safe retry", async (t) => {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `followup-compensation-${databaseSequence += 1}` },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB");
  let failPortInsert = false;
  const failingDatabase = {
    dialect: "d1",
    prepare(sql) {
      if (!/INSERT INTO site_agent_v3_browser_ports/i.test(sql)) return database.prepare(sql);
      let values = [];
      return {
        bind(...next) { values = next; return this; },
        async run() {
          if (failPortInsert) {
            failPortInsert = false;
            return { success: false, error: "injected_child_port_failure" };
          }
          return database.prepare(sql).bind(...values).run();
        },
        async all() { return database.prepare(sql).bind(...values).all(); },
      };
    },
    batch(statements) { return database.batch(statements); },
  };
  const d1SiteStore = await loadWithDatabase("../db/site-agent-store.ts", failingDatabase);
  const d1RunStore = await loadWithDatabase("../db/agent-run-store.ts", failingDatabase);
  const siteAgentId = `followup-compensation-site-${databaseSequence}`;
  const origin = "https://followup-compensation.test";
  await d1SiteStore.createSiteAgent({ id: siteAgentId, url: `${origin}/` });
  const root = await d1RunStore.createAgentRun({
    siteAgentId,
    origin,
    url: `${origin}/cart`,
    goal: "add Mug to cart",
    taskInput: { product: "Mug" },
    documentId: "compensation-document",
    browserSessionId: "compensation-browser",
    controller: "page-agent",
    requestOrigin: origin,
    controlPlaneOrigin: origin,
  });
  const terminal = await d1RunStore.finishAgentRun(root.run.id, {
    token: root.resumeToken,
    expectedRevision: root.run.revision,
    pageEpoch: root.run.pageEpoch,
    status: "failed",
    outcome: uncertainOutcome(),
  });
  const input = {
    siteAgentId,
    origin,
    url: `${origin}/cart`,
    goal: "add Mug to cart",
    taskInput: { product: "Mug" },
    documentId: "compensation-document",
    browserSessionId: "compensation-browser",
    controller: "page-agent",
    requestOrigin: origin,
    controlPlaneOrigin: origin,
    followup: {
      sourceTaskId: root.run.id,
      intent: "reconciliation",
      sourceToken: root.resumeToken,
    },
  };
  failPortInsert = true;
  await assert.rejects(d1RunStore.createAgentRun(input), /injected_child_port_failure/);
  const afterFailure = (await d1RunStore.getAgentRun(root.run.id, root.resumeToken)).run;
  assert.equal(afterFailure.agentState.pageExecutionFollowupClaims?.reconciliation, undefined);
  const rowsAfterFailure = await database.prepare("SELECT id FROM site_agent_v3_agent_runs WHERE site_agent_id=? ORDER BY id")
    .bind(siteAgentId).all();
  assert.deepEqual(rowsAfterFailure.results.map((row) => row.id), [root.run.id]);
  const retried = await d1RunStore.createAgentRun(input);
  assert.equal(retried.run.agentState.executionIntent, "reconciliation");
  assert.equal(retried.run.agentState.lineageDepth, 1);
  assert.ok(terminal.run.revision < afterFailure.revision);
});

test("follow-up API and client send lineage only with the source Run bearer", async () => {
  const route = await readFile(new URL("../app/api/agent-runs/route.ts", import.meta.url), "utf8");
  const client = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  assert.match(route, /const sourceToken = hasFollowupFields \? runToken\(request\) : ""/);
  assert.match(route, /followup: hasFollowupFields \? \{ sourceTaskId, intent: intent!, sourceToken \} : undefined/);
  assert.match(client, /authorization: `Bearer \$\{followup\.sourceToken\}`/);
  assert.match(client, /\{ sourceTaskId: followup\.sourceTaskId, intent: followup\.intent \}/);
  assert.match(client, /const sourceToken = this\.requireAgentRunToken\(sourceTaskId\)/);
});

test("POST /api/agent-runs requires the source bearer and exposes CAS conflicts", async () => {
  const route = await load("../app/api/agent-runs/route.ts", {
    plugins: [{
      name: "next-server-followup-stub",
      setup(builder) {
        builder.onResolve({ filter: /^next\/server$/ }, () => ({ path: "next-server", namespace: "followup-test" }));
        builder.onLoad({ filter: /.*/, namespace: "followup-test" }, () => ({
          loader: "js",
          contents: `export class NextRequest extends Request {}
            export class NextResponse extends Response {
              static json(value, init = {}) {
                const headers = new Headers(init.headers || {});
                headers.set("content-type", "application/json");
                return new NextResponse(JSON.stringify(value), { ...init, headers });
              }
            }`,
        }));
      },
    }],
  });
  const root = await createRun();
  const terminal = await finish(root, uncertainOutcome());
  root.run = terminal.run;
  const body = {
    siteAgentId: root.siteAgentId,
    origin: root.origin,
    url: `${root.origin}/checkout`,
    goal: root.goal,
    input: root.input,
    documentId: root.documentId,
    browserSessionId: root.browserSessionId,
    sourceTaskId: root.run.id,
    intent: "reconciliation",
  };
  const request = (authorization) => new Request(`${root.origin}/api/agent-runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: root.origin,
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });

  const missing = await route.POST(request());
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error, "agent_run_followup_token_required");
  const forged = await route.POST(request(`Bearer ${root.run.id}.forged`));
  assert.equal(forged.status, 403);
  const accepted = await route.POST(request(`Bearer ${root.resumeToken}`));
  const acceptedBody = await accepted.json();
  assert.equal(accepted.status, 201, JSON.stringify(acceptedBody));
  assert.equal(acceptedBody.run.agentState.executionIntent, "reconciliation");
  assert.equal(acceptedBody.run.agentState.lineageDepth, 1);
  const duplicate = await route.POST(request(`Bearer ${root.resumeToken}`));
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error, "agent_run_followup_already_claimed");
});
