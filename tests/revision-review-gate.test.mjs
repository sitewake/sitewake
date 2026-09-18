import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const NOW = "2026-07-29T02:00:00.000Z";
const LEASE_EXPIRES_AT = "2099-01-01T00:00:00.000Z";
let databaseSequence = 0;

function hookableDatabase(rawDatabase) {
  let beforeNextBatch;
  const database = new Proxy(rawDatabase, {
    get(target, property) {
      if (property === "batch") {
        return async (statements) => {
          const hook = beforeNextBatch;
          beforeNextBatch = undefined;
          if (hook) await hook(rawDatabase);
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    database,
    beforeBatch(hook) {
      assert.equal(beforeNextBatch, undefined, "only one D1 batch hook may be armed at a time");
      beforeNextBatch = hook;
    },
  };
}

async function isolatedD1Database() {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `revision-review-test-${databaseSequence += 1}` },
  });
  const rawDatabase = await miniflare.getD1Database("DB");
  const hooked = hookableDatabase(rawDatabase);
  return {
    ...hooked,
    rawDatabase,
    dispose: () => miniflare.dispose(),
  };
}

async function bundledModule(entry, database) {
  const databaseKey = database ? `__REVISION_REVIEW_D1_${databaseSequence += 1}` : undefined;
  if (databaseKey) globalThis[databaseKey] = database;
  try {
    const result = await build({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      plugins: databaseKey ? [{
        name: "revision-review-isolated-d1",
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
    return await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  } finally {
    if (databaseKey) delete globalThis[databaseKey];
  }
}

async function bundledManagementHttp() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../app/api/site-agents/http.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "revision-review-management-auth",
      setup(builder) {
        builder.onResolve({ filter: /^next\/server$/ }, () => ({
          path: "next/server",
          namespace: "revision-review-auth-stub",
        }));
        builder.onLoad({ filter: /.*/, namespace: "revision-review-auth-stub" }, () => ({
          contents: `
            export class NextResponse {
              constructor(body, init = {}) {
                this.body = body;
                this.status = init.status || 200;
                this.headers = init.headers || {};
              }
              static json(body, init = {}) {
                return new NextResponse(JSON.stringify(body), init);
              }
            }
          `,
          loader: "js",
        }));
        builder.onLoad({ filter: /[\\/]lib[\\/]access-control[\\/]index\.ts$/ }, () => ({
          contents: `
            export const ACCESS_COOKIE_NAME = "sr_access";
            export async function authorizeManagementSession(value) {
              return value === "valid-management-cookie";
            }
          `,
          loader: "ts",
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
const compiler = await bundledModule("../lib/site-knowledge/compiler.ts");
const capabilityIdentity = await bundledModule("../lib/site-knowledge/capability-identity.ts");

async function first(database, sql, values = []) {
  return database.prepare(sql).bind(...values).first();
}

async function all(database, sql, values = []) {
  return (await database.prepare(sql).bind(...values).all()).results;
}

async function activeReleaseRow(database, siteAgentId) {
  return first(database, `
    SELECT r.id,r.version,r.content_hash AS contentHash,r.release_json AS releaseJson
      FROM site_agent_v2_agents a
      JOIN site_agent_v2_releases r ON r.id=a.active_release_id
     WHERE a.id=? LIMIT 1
  `, [siteAgentId]);
}

function operationFixture(suffix) {
  const verifier = {
    success: [{ kind: "url", value: "/done" }],
    noResult: [],
    businessRejection: [],
  };
  const program = {
    version: 2,
    steps: [{
      id: `wait-${suffix}`,
      op: "waitForCondition",
      urlPattern: "/done",
      timeoutMs: 8_000,
    }],
  };
  const proof = {
    version: 1,
    iterationId: `iteration-${suffix}`,
    author: "ai-program-author",
    rationale: "Wait for the independently verifiable destination.",
    alternativeIds: [],
    verifier,
    groundedTargetIds: [],
    createdAt: NOW,
  };
  return {
    id: `operation-${suffix}`,
    name: `Complete ${suffix}`,
    description: "Reach the completion page.",
    kind: "task",
    evidenceSource: "ai-authored",
    applicability: { scope: "any-scene", evidenceSceneIds: [] },
    fromSceneId: "*",
    inputs: { type: "object", properties: {} },
    outputs: {
      type: "object",
      properties: {
        pageUrl: { type: "string" },
        pageTitle: { type: "string" },
      },
      required: ["pageUrl", "pageTitle"],
    },
    preconditions: [],
    effects: [`completed:${suffix}`],
    implementations: [{
      id: `implementation-${suffix}`,
      program,
      authored: { kind: "page-program", program, proof },
      conditions: [],
      successes: 1,
      failures: 0,
      sourceEpisodeIds: [`episode-${suffix}`],
    }],
    verification: { textIncludes: ["Done"] },
    status: "verified",
    updatedAt: NOW,
  };
}

function capabilityFixture(suffix, operation) {
  return {
    id: `capability-review-${suffix}`,
    kind: "task",
    resultKind: "page",
    exposure: "public",
    name: `Review gate ${suffix}`,
    description: "A capability that must pass independent validation and human review.",
    normalizedGoal: protocol.normalizeGoal(`Review gate ${suffix}`),
    goalTemplate: `Review gate ${suffix}`,
    aliases: [],
    inputs: operation.inputs,
    outputs: operation.outputs,
    outcomes: [{
      id: `outcome-${suffix}`,
      status: "success",
      code: "success",
      description: "The completion page is visible.",
      classifiers: [],
    }],
    plans: [{
      id: `plan-${suffix}`,
      entrySceneIds: ["*"],
      steps: [{ operationId: operation.id, bindings: {} }],
      outputBindings: {
        pageUrl: { source: "state", path: "__pageUrl" },
        pageTitle: { source: "state", path: "__pageTitle" },
      },
    }],
    sourceEpisodeIds: [`episode-${suffix}`],
    confidence: 0.9,
    status: "learning",
    origin: "administrator",
    module: {
      contentHash: "a".repeat(64),
      moduleUrl: `/programs/capability-review-${suffix}.js`,
      exportName: "capability",
    },
    updatedAt: NOW,
  };
}

function candidateFixture(siteAgentId, suffix, baseReleaseVersion, operation, capability) {
  return {
    id: `candidate-${suffix}`,
    siteAgentId,
    normalizedGoal: capability.normalizedGoal,
    baseReleaseVersion,
    scenes: [],
    targets: [],
    operations: [operation],
    capability,
    validation: {
      status: "pending",
      attempts: 0,
      successfulReplays: 0,
      requiredReplays: 1,
    },
    authoring: {
      stage: "authored",
      reusableTrace: false,
      intentKey: `intent-${suffix}`,
      capabilityKind: "task",
      goalTemplate: capability.goalTemplate,
      requiredInputs: [],
      resultFields: [
        { id: "pageUrl", name: "Page URL", type: "string", source: "page-url", importance: "metadata" },
        { id: "pageTitle", name: "Page title", type: "string", source: "page-title", importance: "metadata" },
      ],
      resultArchetype: "navigation",
      selectedImplementationId: operation.implementations[0].id,
      alternatives: [{
        id: operation.implementations[0].id,
        kind: "page-program",
        label: "Page program",
        rationale: "The implementation has an independent URL verifier.",
        selected: true,
      }],
    },
    sourceEpisodeIds: capability.sourceEpisodeIds,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function episodeFixture(siteAgentId, suffix, releaseId) {
  const snapshot = (url, heading) => ({
    id: `snapshot-${suffix}-${heading}`,
    sessionId: `browser-${suffix}`,
    documentId: `document-${suffix}`,
    sequence: 0,
    url,
    title: heading,
    heading,
    visibleText: heading,
    links: [],
    capturedAt: NOW,
  });
  return {
    schemaVersion: protocol.SITE_AGENT_SCHEMA_VERSION,
    id: `episode-${suffix}`,
    siteAgentId,
    taskSessionId: `session-${suffix}`,
    browserSessionId: `browser-${suffix}`,
    documentId: `document-${suffix}`,
    mode: "demonstration",
    goal: `Review gate ${suffix}`,
    normalizedGoal: protocol.normalizeGoal(`Review gate ${suffix}`),
    input: {},
    startedAt: NOW,
    endedAt: NOW,
    releaseId,
    startSnapshot: snapshot("https://review.test/", "Start"),
    endSnapshot: snapshot("https://review.test/done", "Done"),
    transitions: [],
    outcome: {
      status: "success",
      code: "success",
      summary: "Reached Done.",
      evaluatedAt: NOW,
      evidence: {},
    },
    experience: {
      version: 1,
      actions: [],
      actorSummary: "Reached Done.",
      judgeEvidence: ["URL matched /done"],
    },
  };
}

function projectFixture(siteAgentId, suffix, capability, revisionId, activeRevisionId) {
  const kind = capability.kind;
  const resultKind = capability.resultKind;
  const contractFingerprint = capabilityIdentity.capabilityContractFingerprint({
    kind,
    resultKind,
    structure: "atomic",
    operation: "read",
    inputs: capability.inputs,
    outputs: capability.outputs,
  });
  return {
    id: `project-${suffix}`,
    siteAgentId,
    stableKey: `stable-${suffix}`,
    contractFingerprint,
    intentKey: `intent-${suffix}`,
    name: capability.name,
    description: capability.description,
    goalTemplate: capability.goalTemplate,
    requestedGoal: capability.goalTemplate,
    origin: "administrator",
    triggeredBy: "administrator",
    generatedBy: "ai",
    status: "building",
    stage: "validate",
    kind,
    structure: "atomic",
    operation: "read",
    exposure: capability.exposure,
    resultKind,
    activeCapabilityId: capability.id,
    activeRevisionId,
    latestRevisionId: revisionId,
    inputSchema: capability.inputs,
    outputSchema: capability.outputs,
    executionRequirements: {
      authentication: "unknown",
      supportedEnvironments: {
        connectedBrowser: "supported",
        cloudBrowser: "unverified",
        managedProfile: "blocked",
      },
      checkpoints: [],
      evidenceRefs: capability.sourceEpisodeIds,
    },
    health: { recentRuns: 0, recentSuccesses: 0 },
    revisionCount: activeRevisionId ? 2 : 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function revisionFixture(siteAgentId, projectId, suffix, number, baseReleaseVersion, candidate, learningJobId) {
  const authored = candidate.operations[0].implementations[0].authored;
  return {
    id: `revision-${suffix}`,
    projectId,
    siteAgentId,
    number,
    status: "building",
    stage: "validate",
    baseReleaseVersion,
    candidateId: candidate.id,
    learningJobId,
    parameterizationDecisions: [],
    implementation: {
      kind: "program",
      moduleRef: candidate.capability.module,
      pageProgram: authored.program,
      proof: authored.proof,
    },
    verifier: authored.proof.verifier,
    validation: { status: "running" },
    guidanceIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function learningJobFixture(siteAgentId, suffix, candidateId) {
  return {
    id: `learning-${suffix}`,
    siteAgentId,
    taskSessionId: `session-${suffix}`,
    sourceEpisodeId: `episode-${suffix}`,
    candidateId,
    origin: "administrator",
    phase: "validate",
    status: "running",
    attempts: 1,
    intentKey: `intent-${suffix}`,
    goalTemplate: `Review gate ${suffix}`,
    receipts: [
      {
        id: `receipt-evidence-${suffix}`,
        stage: "evidence",
        actor: "program",
        status: "passed",
        title: "Evidence collected",
        summary: "A successful demonstration was recorded.",
        startedAt: NOW,
        endedAt: NOW,
      },
      {
        id: `receipt-author-${suffix}`,
        stage: "author",
        actor: "ai",
        status: "passed",
        title: "Implementation authored",
        summary: "An executable program and proof were produced.",
        startedAt: NOW,
        endedAt: NOW,
      },
      {
        id: `receipt-validate-${suffix}`,
        stage: "validate",
        actor: "browser-runner",
        status: "running",
        title: "Independent validation",
        summary: "The validator is replaying the program.",
        startedAt: NOW,
      },
      {
        id: `receipt-publish-${suffix}`,
        stage: "publish",
        actor: "release-gate",
        status: "queued",
        title: "Awaiting release gate",
        summary: "Validation and review must both pass.",
        startedAt: NOW,
      },
    ],
    result: { source: "revision-review-test", projectId: `project-${suffix}` },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function validationJobFixture(siteAgentId, suffix, candidate, learningJobId, runnerId, leaseToken, baseReleaseVersion) {
  return {
    id: `validation-${suffix}`,
    learningJobId,
    siteAgentId,
    candidateId: candidate.id,
    capabilityId: candidate.capability.id,
    baseReleaseVersion,
    status: "leased",
    validationCase: {
      id: `case-${suffix}`,
      name: "Independent completion replay",
      input: {},
      inputSource: "observed",
      startUrl: "https://review.test/",
      expectedStatuses: ["success"],
      effect: "read-only",
    },
    attempt: 0,
    maxAttempts: 2,
    lease: {
      runnerId,
      token: leaseToken,
      leasedAt: NOW,
      expiresAt: LEASE_EXPIRES_AT,
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function browserRunFixture(siteAgentId, suffix, candidateId, learningJobId, validationJobId, runnerId) {
  return {
    id: `run-${suffix}`,
    learningJobId,
    validationJobId,
    siteAgentId,
    candidateId,
    runnerId,
    mode: "validate",
    status: "passed",
    browser: { name: "chromium", version: "1", headless: true },
    startedAt: NOW,
    endedAt: "2026-07-29T02:01:00.000Z",
    startUrl: "https://review.test/",
    endUrl: "https://review.test/done",
    steps: [{
      stepId: `step-${suffix}`,
      op: "waitForCondition",
      status: "passed",
      startedAt: NOW,
      endedAt: "2026-07-29T02:01:00.000Z",
    }],
    outcome: {
      status: "success",
      code: "success",
      summary: "Independent replay reached Done.",
      evaluatedAt: "2026-07-29T02:01:00.000Z",
      evidence: {},
    },
  };
}

async function insertWorkingRevision(context, suffix, number, activeRevisionId) {
  const {
    database,
    siteAgentId,
    baseRelease,
    runnerId,
    leaseToken,
  } = context;
  const operation = operationFixture(suffix);
  const capability = capabilityFixture(suffix, operation);
  if (context.capabilityId) capability.id = context.capabilityId;
  const candidate = candidateFixture(siteAgentId, suffix, baseRelease.version, operation, capability);
  const revisionId = `revision-${suffix}`;
  const project = projectFixture(siteAgentId, context.projectSuffix || suffix, capability, revisionId, activeRevisionId);
  if (context.projectId) {
    project.id = context.projectId;
    project.intentKey = context.intentKey;
    project.stableKey = context.stableKey;
    project.contractFingerprint = context.contractFingerprint;
    project.createdAt = context.projectCreatedAt;
  }
  project.latestRevisionId = revisionId;
  project.activeRevisionId = activeRevisionId;
  project.revisionCount = number;
  const learning = learningJobFixture(siteAgentId, suffix, candidate.id);
  learning.result.projectId = project.id;
  const revision = revisionFixture(
    siteAgentId,
    project.id,
    suffix,
    number,
    baseRelease.version,
    candidate,
    learning.id,
  );
  const validation = validationJobFixture(
    siteAgentId,
    suffix,
    candidate,
    learning.id,
    runnerId,
    leaseToken,
    baseRelease.version,
  );
  const episode = episodeFixture(siteAgentId, suffix, baseRelease.id);
  const run = browserRunFixture(
    siteAgentId,
    suffix,
    candidate.id,
    learning.id,
    validation.id,
    runnerId,
  );
  const statements = [
    database.prepare(`
      INSERT INTO site_agent_v2_episodes
        (id,site_agent_id,task_session_id,mode,normalized_goal,outcome_status,episode_json,started_at,ended_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).bind(
      episode.id,
      siteAgentId,
      episode.taskSessionId,
      episode.mode,
      episode.normalizedGoal,
      episode.outcome.status,
      JSON.stringify(episode),
      episode.startedAt,
      episode.endedAt,
    ),
    database.prepare(`
      INSERT INTO site_agent_v2_candidates
        (id,site_agent_id,normalized_goal,status,base_release_version,candidate_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).bind(
      candidate.id,
      siteAgentId,
      candidate.normalizedGoal,
      "pending",
      candidate.baseReleaseVersion,
      JSON.stringify(candidate),
      candidate.createdAt,
      candidate.updatedAt,
    ),
    database.prepare(`
      INSERT INTO site_agent_v2_learning_jobs
        (id,site_agent_id,task_session_id,status,result_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)
    `).bind(
      learning.id,
      siteAgentId,
      learning.taskSessionId,
      learning.status,
      JSON.stringify(learning),
      learning.createdAt,
      learning.updatedAt,
    ),
    database.prepare(`
      INSERT INTO site_agent_v2_validation_jobs
        (id,learning_job_id,site_agent_id,candidate_id,status,lease_expires_at,job_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).bind(
      validation.id,
      learning.id,
      siteAgentId,
      candidate.id,
      validation.status,
      validation.lease.expiresAt,
      JSON.stringify(validation),
      validation.createdAt,
      validation.updatedAt,
    ),
    database.prepare(`
      INSERT INTO site_agent_v2_capability_revisions
        (id,project_id,site_agent_id,revision_number,status,revision_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).bind(
      revision.id,
      project.id,
      siteAgentId,
      revision.number,
      revision.status,
      JSON.stringify(revision),
      revision.createdAt,
      revision.updatedAt,
    ),
  ];
  if (context.projectId) {
    statements.push(database.prepare(`
      UPDATE site_agent_v2_capability_projects
         SET latest_revision_id=?,status=?,project_json=?,updated_at=?
       WHERE id=? AND site_agent_id=?
    `).bind(
      revision.id,
      project.status,
      JSON.stringify(project),
      NOW,
      project.id,
      siteAgentId,
    ));
  } else {
    statements.push(database.prepare(`
      INSERT INTO site_agent_v2_capability_projects
        (id,site_agent_id,intent_key,stable_key,contract_fingerprint,active_revision_id,latest_revision_id,status,project_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      project.id,
      siteAgentId,
      project.intentKey,
      project.stableKey,
      project.contractFingerprint,
      project.activeRevisionId || null,
      project.latestRevisionId,
      project.status,
      JSON.stringify(project),
      project.createdAt,
      project.updatedAt,
    ));
  }
  const results = await database.batch(statements);
  assert.equal(results.every((result) => result.success), true);
  Object.assign(context, {
    projectId: project.id,
    projectSuffix: context.projectSuffix || suffix,
    projectCreatedAt: project.createdAt,
    intentKey: project.intentKey,
    stableKey: project.stableKey,
    contractFingerprint: project.contractFingerprint,
    capabilityId: capability.id,
    operation,
    capability,
    candidate,
    project,
    revision,
    learning,
    validation,
    episode,
    run,
  });
  return context;
}

async function scenario(t, suffix) {
  const isolated = await isolatedD1Database();
  t.after(isolated.dispose);
  const store = await bundledModule("../db/site-agent-store.ts", isolated.database);
  const siteAgentId = `review-gate-${suffix}`;
  await store.createSiteAgent({
    id: siteAgentId,
    name: `Review Gate ${suffix}`,
    url: "https://review.test/",
  });
  // Establish the executable-asset epoch before inserting canonical fixtures;
  // otherwise a later runtime read would correctly retire the test's rows.
  // Seed the marker directly so this fixture remains based on Release v0—the
  // review-gate tests exercise publication, not the separate reset migration.
  const epoch = await isolated.database.prepare(
    "INSERT OR REPLACE INTO site_agent_v2_meta (key,value,updated_at) VALUES (?,?,?)",
  ).bind(
    `executable_asset_epoch:${siteAgentId}`,
    "sitewake-runtime-v1",
    NOW,
  ).run();
  assert.equal(epoch.success, true);
  // This fixture exercises the review gate rather than catalog migration.
  // Seed the current catalog epoch directly so canonicalization cannot publish
  // a migration Release and silently change the v0 baseline under test.
  const catalogEpoch = await isolated.database.prepare(
    "INSERT OR REPLACE INTO site_agent_v2_meta (key,value,updated_at) VALUES (?,?,?)",
  ).bind(
    `capability_model_epoch:${siteAgentId}`,
    "canonical-capability-roots-v3",
    NOW,
  ).run();
  assert.equal(catalogEpoch.success, true);
  const baseReleaseRow = await activeReleaseRow(isolated.database, siteAgentId);
  const baseRelease = JSON.parse(baseReleaseRow.releaseJson);
  const runnerId = `runner-${suffix}`;
  const leaseToken = `lease-token-${suffix}`;
  await store.registerValidationRunner({
    id: runnerId,
    name: `Validator ${suffix}`,
    role: "validate",
    workKinds: ["validate"],
    browsers: ["chromium"],
    maxConcurrency: 1,
  });
  const context = {
    ...isolated,
    store,
    siteAgentId,
    baseRelease,
    baseReleaseRow,
    runnerId,
    leaseToken,
  };
  await insertWorkingRevision(context, suffix, 1, undefined);
  return context;
}

async function passValidation(context) {
  const before = await activeReleaseRow(context.database, context.siteAgentId);
  await context.store.completeValidation(
    context.runnerId,
    context.leaseToken,
    context.run,
  );
  const after = await activeReleaseRow(context.database, context.siteAgentId);
  assert.equal(after.id, before.id, "validation success cannot activate a Release before human approval");
  assert.equal(after.releaseJson, before.releaseJson, "validation success leaves the active Release bytes unchanged");

  const candidateRow = await first(
    context.database,
    "SELECT candidate_json AS candidateJson FROM site_agent_v2_candidates WHERE id=? LIMIT 1",
    [context.candidate.id],
  );
  assert.ok(candidateRow, "the validated Candidate remains available for human review");

  const detail = (await context.store.getCapabilityProjectDetail(
    context.siteAgentId,
    context.projectId,
  )).detail;
  const revision = detail.revisions.find((item) => item.id === context.revision.id);
  assert.equal(revision.status, "awaiting-review");
  assert.equal(revision.validation.status, "passed");
  assert.equal(revision.validation.runId, context.run.id);
  assert.ok(revision.validation.validatedContentHash);
  const review = detail.reviews?.find((item) => item.revisionId === revision.id);
  assert.equal(review?.status, "awaiting-review");
  assert.equal(review?.validationRunId, context.run.id);
  assert.equal(review?.validatedContentHash, revision.validation.validatedContentHash);
  const learningRow = await first(
    context.database,
    "SELECT status,result_json AS jobJson FROM site_agent_v2_learning_jobs WHERE id=? LIMIT 1",
    [context.learning.id],
  );
  assert.equal(learningRow.status, "awaiting-review");
  assert.equal(JSON.parse(learningRow.jobJson).latestRunId, context.run.id);
  context.validatedRevision = revision;
  context.awaitingReview = review;
  return { before, after, detail, revision, review, candidateRow };
}

async function approve(context) {
  return context.store.actOnCapabilityProject(
    context.siteAgentId,
    context.projectId,
    {
      action: "approve-revision",
      revisionId: context.validatedRevision.id,
      validationRunId: context.awaitingReview.validationRunId,
      validatedContentHash: context.awaitingReview.validatedContentHash,
    },
  );
}

async function reject(context, text) {
  return context.store.actOnCapabilityProject(
    context.siteAgentId,
    context.projectId,
    {
      action: "reject-revision",
      revisionId: context.validatedRevision.id,
      validationRunId: context.awaitingReview.validationRunId,
      validatedContentHash: context.awaitingReview.validatedContentHash,
      text,
    },
  );
}

async function publishedScenario(t, suffix) {
  const context = await scenario(t, suffix);
  await passValidation(context);
  await approve(context);
  const activeRelease = await activeReleaseRow(context.database, context.siteAgentId);
  const detail = (await context.store.getCapabilityProjectDetail(
    context.siteAgentId,
    context.projectId,
  )).detail;
  assert.equal(detail.activeRevision.status, "published");
  return {
    ...context,
    publishedReleaseRow: activeRelease,
    publishedProject: detail.project,
    publishedRevision: detail.activeRevision,
  };
}

test("an orphaned legacy authoring job is terminalized instead of poisoning the Runner lease queue", async (t) => {
  const context = await scenario(t, "orphaned-authoring-job");
  const queued = {
    ...context.learning,
    phase: "author",
    status: "queued",
    lease: undefined,
    updatedAt: "2026-07-29T02:02:00.000Z",
  };
  const prepared = await context.database.batch([
    context.database.prepare("DELETE FROM site_agent_v2_candidates WHERE id=? AND site_agent_id=?")
      .bind(context.candidate.id, context.siteAgentId),
    context.database.prepare(`UPDATE site_agent_v2_learning_jobs
      SET status='queued',result_json=?,updated_at=? WHERE id=? AND site_agent_id=?`)
      .bind(JSON.stringify(queued), queued.updatedAt, queued.id, queued.siteAgentId),
  ]);
  assert.equal(prepared.every((result) => result.success), true);

  const runnerId = "runner-orphaned-authoring-job";
  await context.store.registerValidationRunner({
    id: runnerId,
    name: "Orphan cleanup author",
    role: "author",
    workKinds: ["author"],
    browsers: ["chromium"],
    maxConcurrency: 1,
  });

  const result = await context.store.leaseRunnerWork(runnerId, "author");
  assert.equal(result.lease, undefined);
  const row = await first(
    context.database,
    "SELECT status,result_json AS jobJson FROM site_agent_v2_learning_jobs WHERE id=? LIMIT 1",
    [queued.id],
  );
  const failed = JSON.parse(row.jobJson);
  assert.equal(row.status, "failed");
  assert.equal(failed.failure.code, "learning_job_knowledge_missing");
  assert.equal(failed.lease, undefined);
  assert.equal(failed.receipts.findLast((receipt) => receipt.stage === "author").status, "failed");
});

async function queueExplicitRebuild(context) {
  const beforeIds = new Set((await all(
    context.database,
    "SELECT id FROM site_agent_v2_learning_jobs WHERE site_agent_id=?",
    [context.siteAgentId],
  )).map((row) => row.id));
  await context.store.actOnCapabilityProject(
    context.siteAgentId,
    context.projectId,
    { action: "re-explore" },
  );
  const queuedRows = await all(
    context.database,
    "SELECT result_json AS jobJson FROM site_agent_v2_learning_jobs WHERE site_agent_id=?",
    [context.siteAgentId],
  );
  const queuedJobs = queuedRows
    .map((row) => JSON.parse(row.jobJson))
    .filter((job) => !beforeIds.has(job.id));
  assert.equal(queuedJobs.length, 1);
  assert.equal(queuedJobs[0].result.source, "capability-control");
  assert.equal(queuedJobs[0].result.rawExperienceOnly, true);
  assert.equal(queuedJobs[0].result.projectId, context.projectId);
  assert.ok(queuedJobs[0].result.revisionId);
  return queuedJobs[0];
}

async function leaseExplicitAuthor(context, suffix) {
  const queuedJob = await queueExplicitRebuild(context);
  const runnerId = `runner-${suffix}-author`;
  await context.store.registerValidationRunner({
    id: runnerId,
    name: `Explicit author ${suffix}`,
    role: "author",
    workKinds: ["author"],
    browsers: ["chromium"],
    maxConcurrency: 1,
  });
  const leased = await context.store.leaseRunnerWork(runnerId, "author");
  assert.equal(leased.lease.kind, "author");
  assert.equal(leased.lease.job.id, queuedJob.id);
  assert.equal(leased.lease.candidate.id, queuedJob.candidateId);
  assert.ok(leased.lease.job.lease?.token);
  return {
    queuedJob,
    runnerId,
    leaseToken: leased.lease.job.lease.token,
    authorLease: leased.lease,
  };
}

function authorCompletionRun(context, suffix, authorLease, runnerId, status) {
  const endedAt = "2026-07-29T02:01:30.000Z";
  return {
    id: `run-${suffix}-author`,
    learningJobId: authorLease.job.id,
    siteAgentId: context.siteAgentId,
    candidateId: authorLease.candidate.id,
    runnerId,
    mode: "author",
    status,
    browser: { name: "chromium", version: "1", headless: true },
    startedAt: NOW,
    endedAt,
    startUrl: authorLease.job.result.authoringStartUrl || "https://review.test/",
    endUrl: status === "passed" ? "https://review.test/done" : "https://review.test/",
    steps: [],
    outcome: {
      status: status === "passed" ? "success" : "execution-fault",
      code: status === "passed" ? "success" : "authoring_runtime_failure",
      summary: status === "passed"
        ? "The browser author produced an executable implementation."
        : "The browser author stopped before producing an executable implementation.",
      evaluatedAt: endedAt,
      evidence: {},
    },
  };
}

async function failExplicitAuthoring(context, suffix) {
  const leased = await leaseExplicitAuthor(context, suffix);
  const run = authorCompletionRun(
    context,
    suffix,
    leased.authorLease,
    leased.runnerId,
    "failed",
  );
  await context.store.completeAuthoring(
    leased.runnerId,
    leased.leaseToken,
    run,
    leased.authorLease.candidate,
  );
  return { ...leased, run };
}

async function reviewGatePersistenceSnapshot(context) {
  return {
    reviews: await all(
      context.database,
      "SELECT * FROM site_agent_v2_revision_reviews WHERE revision_id=? ORDER BY id",
      [context.revision.id],
    ),
    revision: await first(
      context.database,
      "SELECT * FROM site_agent_v2_capability_revisions WHERE id=? LIMIT 1",
      [context.revision.id],
    ),
    project: await first(
      context.database,
      "SELECT * FROM site_agent_v2_capability_projects WHERE id=? LIMIT 1",
      [context.projectId],
    ),
    learningJob: await first(
      context.database,
      "SELECT * FROM site_agent_v2_learning_jobs WHERE id=? LIMIT 1",
      [context.learning.id],
    ),
    validationJob: await first(
      context.database,
      "SELECT * FROM site_agent_v2_validation_jobs WHERE id=? LIMIT 1",
      [context.validation.id],
    ),
    candidate: await first(
      context.database,
      "SELECT * FROM site_agent_v2_candidates WHERE id=? LIMIT 1",
      [context.candidate.id],
    ),
    agent: await first(
      context.database,
      "SELECT * FROM site_agent_v2_agents WHERE id=? LIMIT 1",
      [context.siteAgentId],
    ),
    releases: await all(
      context.database,
      "SELECT * FROM site_agent_v2_releases WHERE site_agent_id=? ORDER BY version,id",
      [context.siteAgentId],
    ),
  };
}

async function advanceActiveRelease(context, suffix) {
  const createdAt = "2026-07-29T02:02:00.000Z";
  const next = {
    ...context.baseRelease,
    id: `${context.siteAgentId}:release:${context.baseRelease.version + 1}:${suffix}`,
    version: context.baseRelease.version + 1,
    createdAt,
    profile: {
      ...context.baseRelease.profile,
      description: `Concurrent control-plane update: ${suffix}`,
    },
    evalSummary: {
      ...context.baseRelease.evalSummary,
      generatedAt: createdAt,
    },
  };
  const hashable = {
    ...next,
    contentHash: undefined,
    knowledgeRevision: undefined,
  };
  const release = {
    ...next,
    contentHash: protocol.stableHash(JSON.stringify(hashable)),
  };
  assert.equal(release.version, context.baseRelease.version + 1);
  const results = await context.database.batch([
    context.database.prepare(`
      INSERT INTO site_agent_v2_releases
        (id,site_agent_id,version,content_hash,release_json,created_at)
      VALUES (?,?,?,?,?,?)
    `).bind(
      release.id,
      context.siteAgentId,
      release.version,
      release.contentHash,
      JSON.stringify(release),
      release.createdAt,
    ),
    context.database.prepare(`
      UPDATE site_agent_v2_agents SET active_release_id=?,profile_json=?,updated_at=?
       WHERE id=? AND active_release_id=?
    `).bind(
      release.id,
      JSON.stringify(release.profile),
      release.createdAt,
      context.siteAgentId,
      context.baseRelease.id,
    ),
  ]);
  assert.equal(results.every((result) => result.success), true);
  assert.equal((await activeReleaseRow(
    context.database,
    context.siteAgentId,
  )).id, release.id);
  return release;
}

test("memory approval enables cloud debugging for the published module without replacing other execution evidence", async () => {
  const store = await bundledModule("../db/site-agent-store.ts");
  store.resetMemorySiteAgentStore();
  const suffix = "memory-cloud-debug";
  const siteAgentId = `review-gate-${suffix}`;
  await store.createSiteAgent({
    id: siteAgentId,
    name: "Memory cloud debug review",
    url: "https://review.test/",
  });
  const agent = globalThis.__SITEWAKE_SITE_AGENT_V2__.get(siteAgentId);
  assert.ok(agent);

  const operation = operationFixture(suffix);
  const capability = capabilityFixture(suffix, operation);
  const candidate = candidateFixture(
    siteAgentId,
    suffix,
    agent.release.version,
    operation,
    capability,
  );
  const run = browserRunFixture(
    siteAgentId,
    suffix,
    candidate.id,
    `learning-${suffix}`,
    `validation-${suffix}`,
    `runner-${suffix}`,
  );
  const validatedContentHash = protocol.stableHash(JSON.stringify(candidate));
  const revision = {
    ...revisionFixture(
      siteAgentId,
      `project-${suffix}`,
      suffix,
      1,
      agent.release.version,
      candidate,
      `learning-${suffix}`,
    ),
    status: "awaiting-review",
    stage: "publish",
    validation: {
      status: "passed",
      input: {},
      runId: run.id,
      validatedContentHash,
      summary: run.outcome.summary,
    },
  };
  const project = {
    ...projectFixture(siteAgentId, suffix, capability, revision.id, undefined),
    status: "awaiting-review",
    stage: "publish",
  };
  const learning = {
    ...learningJobFixture(siteAgentId, suffix, candidate.id),
    phase: "publish",
    status: "awaiting-review",
    latestRunId: run.id,
    result: {
      source: "revision-review-test",
      projectId: project.id,
      revisionId: revision.id,
    },
  };
  const validation = {
    ...validationJobFixture(
      siteAgentId,
      suffix,
      candidate,
      learning.id,
      `runner-${suffix}`,
      `lease-token-${suffix}`,
      agent.release.version,
    ),
    status: "passed",
    latestRunId: run.id,
    lease: undefined,
  };
  const awaitingReview = {
    id: `review-awaiting-${suffix}`,
    siteAgentId,
    projectId: project.id,
    revisionId: revision.id,
    validationRunId: run.id,
    validatedContentHash,
    status: "awaiting-review",
    reviewer: "release-gate",
    createdAt: NOW,
  };
  Object.assign(agent, {
    candidates: [candidate],
    learningJobs: [learning],
    validationJobs: [validation],
    browserRuns: [run],
    capabilityProjects: [project],
    capabilityCatalogMigrated: true,
    capabilityRevisions: [revision],
    revisionReviews: [awaitingReview],
  });

  await assert.rejects(
    () => store.actOnCapabilityProject(siteAgentId, project.id, {
      action: "patch-contract",
      patch: { name: "Mutated stable contract" },
    }),
    /capability_contract_patch_not_supported/,
  );
  project.structure = "composite";
  await assert.rejects(
    () => store.actOnCapabilityProject(siteAgentId, project.id, {
      action: "approve-revision",
      revisionId: revision.id,
      validationRunId: run.id,
      validatedContentHash,
    }),
    /composite_publication_not_implemented/,
  );
  assert.equal(agent.revisionReviews.length, 1);
  project.structure = "atomic";

  // A publication-time exception must not consume the immutable Review
  // decision. Keep this probe after every eligibility check but before the
  // successful approval below: an invalid merge shape makes materialization
  // throw after the decision object has been constructed.
  const reviewCountBeforeFailedApproval = agent.revisionReviews.length;
  const originalSourceEpisodeIds = candidate.sourceEpisodeIds;
  candidate.sourceEpisodeIds = undefined;
  const invalidValidatedContentHash = protocol.stableHash(JSON.stringify(candidate));
  revision.validation.validatedContentHash = invalidValidatedContentHash;
  awaitingReview.validatedContentHash = invalidValidatedContentHash;
  await assert.rejects(
    () => store.actOnCapabilityProject(siteAgentId, project.id, {
      action: "approve-revision",
      revisionId: revision.id,
      validationRunId: run.id,
      validatedContentHash: invalidValidatedContentHash,
    }),
    TypeError,
  );
  assert.equal(
    agent.revisionReviews.length,
    reviewCountBeforeFailedApproval,
    "a failed memory publication cannot append a terminal Review",
  );
  candidate.sourceEpisodeIds = originalSourceEpisodeIds;
  revision.validation.validatedContentHash = validatedContentHash;
  awaitingReview.validatedContentHash = validatedContentHash;

  const ready = (await store.getCapabilityProjectDetail(siteAgentId, project.id)).detail;
  const expectedExecutionRequirements = structuredClone(ready.project.executionRequirements);
  assert.equal(
    expectedExecutionRequirements.supportedEnvironments.cloudBrowser,
    "unverified",
  );
  const approved = await store.actOnCapabilityProject(siteAgentId, project.id, {
    action: "approve-revision",
    revisionId: revision.id,
    validationRunId: run.id,
    validatedContentHash,
  });
  const publishedExecutionRequirements = {
    ...expectedExecutionRequirements,
    supportedEnvironments: {
      ...expectedExecutionRequirements.supportedEnvironments,
      cloudBrowser: "supported",
    },
  };
  assert.equal(approved.persistence, "memory");
  assert.ok(approved.release.capabilities.some((item) =>
    item.id === capability.id && item.module?.moduleUrl === capability.module.moduleUrl));
  assert.deepEqual(approved.project.executionRequirements, publishedExecutionRequirements);
  assert.deepEqual(
    globalThis.__SITEWAKE_SITE_AGENT_V2__.get(siteAgentId)
      .capabilityProjects.find((item) => item.id === project.id)
      .executionRequirements,
    publishedExecutionRequirements,
  );
});

test("validation pass creates an awaiting Review without publishing or consuming the Candidate", async (t) => {
  const context = await scenario(t, "validation-pass");
  await passValidation(context);
  const releaseCount = await first(
    context.database,
    "SELECT COUNT(*) AS count FROM site_agent_v2_releases WHERE site_agent_id=?",
    [context.siteAgentId],
  );
  assert.equal(Number(releaseCount.count), 1);
});

test("D1 rejects contract patching without creating a new Revision or job", async (t) => {
  const context = await scenario(t, "patch-contract-rejected");
  const before = {
    revisions: Number((await first(
      context.database,
      "SELECT COUNT(*) AS count FROM site_agent_v2_capability_revisions WHERE site_agent_id=?",
      [context.siteAgentId],
    )).count),
    jobs: Number((await first(
      context.database,
      "SELECT COUNT(*) AS count FROM site_agent_v2_learning_jobs WHERE site_agent_id=?",
      [context.siteAgentId],
    )).count),
  };
  await assert.rejects(
    () => context.store.actOnCapabilityProject(
      context.siteAgentId,
      context.projectId,
      {
        action: "patch-contract",
        patch: { description: "Mutated stable contract" },
      },
    ),
    /capability_contract_patch_not_supported/,
  );
  const after = {
    revisions: Number((await first(
      context.database,
      "SELECT COUNT(*) AS count FROM site_agent_v2_capability_revisions WHERE site_agent_id=?",
      [context.siteAgentId],
    )).count),
    jobs: Number((await first(
      context.database,
      "SELECT COUNT(*) AS count FROM site_agent_v2_learning_jobs WHERE site_agent_id=?",
      [context.siteAgentId],
    )).count),
  };
  assert.deepEqual(after, before);
});

test("D1 refuses to publish a composite Revision until orchestration execution exists", async (t) => {
  const context = await scenario(t, "composite-publication-blocked");
  await passValidation(context);
  const row = await first(
    context.database,
    "SELECT project_json AS projectJson FROM site_agent_v2_capability_projects WHERE id=?",
    [context.projectId],
  );
  const project = {
    ...JSON.parse(row.projectJson),
    structure: "composite",
  };
  const updated = await context.database.prepare(`
    UPDATE site_agent_v2_capability_projects
       SET project_json=?,updated_at=?
     WHERE id=? AND site_agent_id=?
  `).bind(
    JSON.stringify(project),
    project.updatedAt,
    context.projectId,
    context.siteAgentId,
  ).run();
  assert.equal(updated.success, true);
  const releaseBefore = await activeReleaseRow(
    context.database,
    context.siteAgentId,
  );

  await assert.rejects(
    () => approve(context),
    /composite_publication_not_implemented/,
  );
  const releaseAfter = await activeReleaseRow(
    context.database,
    context.siteAgentId,
  );
  assert.deepEqual(releaseAfter, releaseBefore);
  const reviews = await all(
    context.database,
    "SELECT status FROM site_agent_v2_revision_reviews WHERE revision_id=?",
    [context.validatedRevision.id],
  );
  assert.deepEqual(reviews.map((review) => review.status), ["awaiting-review"]);
});

test("validation atomically rebases a v0 Candidate, Revision, and ValidationJob onto active Release v1", async (t) => {
  const context = await scenario(t, "validation-rebase");
  const candidateAtV0 = await first(
    context.database,
    "SELECT base_release_version AS baseReleaseVersion,candidate_json AS candidateJson FROM site_agent_v2_candidates WHERE id=? LIMIT 1",
    [context.candidate.id],
  );
  const revisionAtV0 = JSON.parse((await first(
    context.database,
    "SELECT revision_json AS revisionJson FROM site_agent_v2_capability_revisions WHERE id=? LIMIT 1",
    [context.revision.id],
  )).revisionJson);
  const validationAtV0 = JSON.parse((await first(
    context.database,
    "SELECT job_json AS jobJson FROM site_agent_v2_validation_jobs WHERE id=? LIMIT 1",
    [context.validation.id],
  )).jobJson);
  assert.equal(Number(candidateAtV0.baseReleaseVersion), 0);
  assert.equal(JSON.parse(candidateAtV0.candidateJson).baseReleaseVersion, 0);
  assert.equal(revisionAtV0.baseReleaseVersion, 0);
  assert.equal(validationAtV0.baseReleaseVersion, 0);

  const advancedRelease = await advanceActiveRelease(context, "validation-rebase");
  assert.equal(advancedRelease.version, 1);
  const completion = await context.store.completeValidation(
    context.runnerId,
    context.leaseToken,
    context.run,
  );
  assert.equal(completion.decision, "awaiting-review");

  const candidateRow = await first(
    context.database,
    `SELECT status,base_release_version AS baseReleaseVersion,
            candidate_json AS candidateJson
       FROM site_agent_v2_candidates WHERE id=? LIMIT 1`,
    [context.candidate.id],
  );
  const revisionRow = await first(
    context.database,
    `SELECT status,revision_json AS revisionJson
       FROM site_agent_v2_capability_revisions WHERE id=? LIMIT 1`,
    [context.revision.id],
  );
  const validationRow = await first(
    context.database,
    `SELECT status,job_json AS jobJson
       FROM site_agent_v2_validation_jobs WHERE id=? LIMIT 1`,
    [context.validation.id],
  );
  const candidate = JSON.parse(candidateRow.candidateJson);
  const revision = JSON.parse(revisionRow.revisionJson);
  const validation = JSON.parse(validationRow.jobJson);
  assert.equal(candidateRow.status, "awaiting-review");
  assert.equal(revisionRow.status, "awaiting-review");
  assert.equal(validationRow.status, "passed");
  assert.equal(Number(candidateRow.baseReleaseVersion), 1);
  assert.equal(candidate.baseReleaseVersion, 1);
  assert.equal(revision.baseReleaseVersion, 1);
  assert.equal(validation.baseReleaseVersion, 1);

  const validatedContentHash = protocol.stableHash(JSON.stringify(candidate));
  assert.equal(revision.validation.status, "passed");
  assert.equal(revision.validation.runId, context.run.id);
  assert.equal(revision.validation.validatedContentHash, validatedContentHash);
  const detail = (await context.store.getCapabilityProjectDetail(
    context.siteAgentId,
    context.projectId,
  )).detail;
  const review = detail.reviews.find((item) => item.revisionId === revision.id);
  assert.equal(review.status, "awaiting-review");
  assert.equal(review.validationRunId, context.run.id);
  assert.equal(review.validatedContentHash, validatedContentHash);
  assert.equal(
    (await activeReleaseRow(context.database, context.siteAgentId)).id,
    advancedRelease.id,
    "validation records review state without publishing over active Release v1",
  );

  const reviewTriple = {
    action: "approve-revision",
    revisionId: revision.id,
    validationRunId: review.validationRunId,
    validatedContentHash: review.validatedContentHash,
  };
  await context.store.actOnCapabilityProject(
    context.siteAgentId,
    context.projectId,
    reviewTriple,
  );
  const published = await activeReleaseRow(context.database, context.siteAgentId);
  assert.equal(published.version, 2);
  assert.ok(
    JSON.parse(published.releaseJson).capabilities.some((item) => item.id === context.capability.id),
    "the exact triple validated against Release v1 can publish while v1 remains active",
  );
});

test("validation executes a pinned implementation Release while rebasing review state onto the newer active Release", async (t) => {
  const context = await scenario(t, "validation-pinned-release-rebase");
  const pinnedRevision = {
    ...context.revision,
    implementationReleaseId: context.baseRelease.id,
    implementationReleaseVersion: context.baseRelease.version,
  };
  const revisionUpdate = await context.database.prepare(`
    UPDATE site_agent_v2_capability_revisions
       SET revision_json=?,updated_at=?
     WHERE id=? AND site_agent_id=?
  `).bind(
    JSON.stringify(pinnedRevision),
    NOW,
    pinnedRevision.id,
    context.siteAgentId,
  ).run();
  assert.equal(revisionUpdate.success, true);

  const advancedRelease = await advanceActiveRelease(
    context,
    "validation-pinned-release-rebase",
  );
  const completion = await context.store.completeValidation(
    context.runnerId,
    context.leaseToken,
    context.run,
  );
  assert.equal(completion.decision, "awaiting-review");

  const candidateRow = await first(
    context.database,
    `SELECT status,base_release_version AS baseReleaseVersion,
            candidate_json AS candidateJson
       FROM site_agent_v2_candidates WHERE id=? LIMIT 1`,
    [context.candidate.id],
  );
  const revisionRow = await first(
    context.database,
    `SELECT status,revision_json AS revisionJson
       FROM site_agent_v2_capability_revisions WHERE id=? LIMIT 1`,
    [context.revision.id],
  );
  const validationRow = await first(
    context.database,
    `SELECT status,job_json AS jobJson
       FROM site_agent_v2_validation_jobs WHERE id=? LIMIT 1`,
    [context.validation.id],
  );
  const candidate = JSON.parse(candidateRow.candidateJson);
  const revision = JSON.parse(revisionRow.revisionJson);
  const validation = JSON.parse(validationRow.jobJson);
  assert.equal(candidateRow.status, "awaiting-review");
  assert.equal(revisionRow.status, "awaiting-review");
  assert.equal(validationRow.status, "passed");
  assert.equal(Number(candidateRow.baseReleaseVersion), advancedRelease.version);
  assert.equal(candidate.baseReleaseVersion, advancedRelease.version);
  assert.equal(revision.baseReleaseVersion, advancedRelease.version);
  assert.equal(validation.baseReleaseVersion, advancedRelease.version);
  assert.equal(revision.implementationReleaseId, context.baseRelease.id);
  assert.equal(
    revision.implementationReleaseVersion,
    context.baseRelease.version,
  );
});

test("validation completion rejects a concurrent active Release change without partial review writes", async (t) => {
  const context = await scenario(t, "validation-active-release-race");
  const pinnedRevision = {
    ...context.revision,
    implementationReleaseId: context.baseRelease.id,
    implementationReleaseVersion: context.baseRelease.version,
  };
  await context.database.prepare(`
    UPDATE site_agent_v2_capability_revisions
       SET revision_json=?,updated_at=?
     WHERE id=? AND site_agent_id=?
  `).bind(
    JSON.stringify(pinnedRevision),
    NOW,
    pinnedRevision.id,
    context.siteAgentId,
  ).run();
  const expectedActive = await advanceActiveRelease(
    context,
    "validation-active-release-race-expected",
  );
  const racedAt = "2026-07-29T02:03:00.000Z";
  const racedBase = {
    ...expectedActive,
    id: `${context.siteAgentId}:release:${expectedActive.version + 1}:validation-race`,
    version: expectedActive.version + 1,
    createdAt: racedAt,
    profile: {
      ...expectedActive.profile,
      description: "Concurrent release published during validation completion.",
    },
    evalSummary: {
      ...expectedActive.evalSummary,
      generatedAt: racedAt,
    },
  };
  const racedHashable = {
    ...racedBase,
    contentHash: undefined,
    knowledgeRevision: undefined,
  };
  const racedRelease = {
    ...racedBase,
    contentHash: protocol.stableHash(JSON.stringify(racedHashable)),
  };
  const inserted = await context.database.prepare(`
    INSERT INTO site_agent_v2_releases
      (id,site_agent_id,version,content_hash,release_json,created_at)
    VALUES (?,?,?,?,?,?)
  `).bind(
    racedRelease.id,
    context.siteAgentId,
    racedRelease.version,
    racedRelease.contentHash,
    JSON.stringify(racedRelease),
    racedRelease.createdAt,
  ).run();
  assert.equal(inserted.success, true);

  context.beforeBatch(async (rawDatabase) => {
    const raced = await rawDatabase.prepare(`
      UPDATE site_agent_v2_agents
         SET active_release_id=?,profile_json=?,updated_at=?
       WHERE id=? AND active_release_id=?
    `).bind(
      racedRelease.id,
      JSON.stringify(racedRelease.profile),
      racedRelease.createdAt,
      context.siteAgentId,
      expectedActive.id,
    ).run();
    assert.equal(Number(raced.meta?.changes || 0), 1);
  });
  await assert.rejects(
    () => context.store.completeValidation(
      context.runnerId,
      context.leaseToken,
      context.run,
    ),
    /site_agent_v2_meta\.value|validation_complete_failed/,
  );

  const active = await activeReleaseRow(context.database, context.siteAgentId);
  assert.equal(active.id, racedRelease.id);
  assert.equal(
    Number((await first(
      context.database,
      "SELECT COUNT(*) AS count FROM site_agent_v2_revision_reviews WHERE revision_id=?",
      [context.revision.id],
    )).count),
    0,
  );
  assert.equal(
    (await first(
      context.database,
      "SELECT status FROM site_agent_v2_validation_jobs WHERE id=?",
      [context.validation.id],
    )).status,
    "leased",
  );
  assert.equal(
    (await first(
      context.database,
      "SELECT status FROM site_agent_v2_capability_revisions WHERE id=?",
      [context.revision.id],
    )).status,
    "building",
  );
});

test("approve publishes exactly once and a terminal Review cannot be decided twice", async (t) => {
  const context = await scenario(t, "approve-once");
  await passValidation(context);
  const reviewReadyProjectRow = await first(
    context.database,
    "SELECT project_json AS projectJson FROM site_agent_v2_capability_projects WHERE id=? LIMIT 1",
    [context.projectId],
  );
  const reviewReadyProject = JSON.parse(reviewReadyProjectRow.projectJson);
  reviewReadyProject.executionRequirements = {
    ...reviewReadyProject.executionRequirements,
    authentication: "required",
    checkpoints: ["login"],
    evidenceRefs: [context.episode.id, context.run.id],
  };
  await context.database.prepare(
    "UPDATE site_agent_v2_capability_projects SET project_json=? WHERE id=?",
  ).bind(JSON.stringify(reviewReadyProject), context.projectId).run();
  const expectedExecutionRequirements = structuredClone(
    reviewReadyProject.executionRequirements,
  );
  assert.equal(
    expectedExecutionRequirements.supportedEnvironments.cloudBrowser,
    "unverified",
  );
  const beforeCount = Number((await first(
    context.database,
    "SELECT COUNT(*) AS count FROM site_agent_v2_releases WHERE site_agent_id=?",
    [context.siteAgentId],
  )).count);

  const approved = await approve(context);
  const publishedExecutionRequirements = {
    ...expectedExecutionRequirements,
    supportedEnvironments: {
      ...expectedExecutionRequirements.supportedEnvironments,
      cloudBrowser: "supported",
    },
  };
  assert.deepEqual(approved.project.executionRequirements, publishedExecutionRequirements);
  const active = await activeReleaseRow(context.database, context.siteAgentId);
  assert.notEqual(active.id, context.baseReleaseRow.id);
  assert.ok(JSON.parse(active.releaseJson).capabilities.some((item) => item.id === context.capability.id));
  const afterCount = Number((await first(
    context.database,
    "SELECT COUNT(*) AS count FROM site_agent_v2_releases WHERE site_agent_id=?",
    [context.siteAgentId],
  )).count);
  assert.equal(afterCount, beforeCount + 1, "one approval creates one immutable Release");

  const detail = (await context.store.getCapabilityProjectDetail(context.siteAgentId, context.projectId)).detail;
  assert.equal(detail.project.activeRevisionId, context.revision.id);
  assert.equal(detail.activeRevision.id, context.revision.id);
  assert.equal(detail.activeRevision.status, "published");
  assert.equal(detail.reviews.find((item) => item.revisionId === context.revision.id).status, "approved");
  assert.deepEqual(detail.project.executionRequirements, publishedExecutionRequirements);
  const rereadRelease = await context.store.getActiveSiteAgentRelease(context.siteAgentId);
  const afterRead = await first(
    context.database,
    `SELECT id,version,content_hash AS contentHash,release_json AS releaseJson
       FROM site_agent_v2_releases WHERE id=? AND site_agent_id=? LIMIT 1`,
    [active.id, context.siteAgentId],
  );
  assert.equal(afterRead.contentHash, active.contentHash);
  assert.equal(afterRead.releaseJson, active.releaseJson, "reading cannot rewrite an immutable Release");
  assert.ok(
    rereadRelease.release.capabilities.some((item) =>
      item.id === context.capability.id && item.module?.contentHash === context.capability.module.contentHash),
    JSON.stringify(rereadRelease.release.capabilities),
  );
  assert.equal(
    detail.activeRevision.implementation?.moduleRef?.contentHash,
    context.capability.module.contentHash,
    JSON.stringify(detail.activeRevision.implementation),
  );
  const debugRun = await context.store.createCapabilityRun({
    siteAgentId: context.siteAgentId,
    projectId: context.projectId,
    capabilityId: context.capability.id,
    mode: "debug",
    environment: { kind: "cloud-browser" },
    input: {},
  });
  assert.equal(debugRun.run.releaseId, rereadRelease.release.id);
  assert.equal(debugRun.run.revisionId, context.revision.id);
  const persistedProject = JSON.parse((await first(
    context.database,
    "SELECT project_json AS projectJson FROM site_agent_v2_capability_projects WHERE id=? LIMIT 1",
    [context.projectId],
  )).projectJson);
  assert.deepEqual(
    persistedProject.executionRequirements,
    publishedExecutionRequirements,
    "the D1 approval batch persists cloud debug support with the published project",
  );

  await assert.rejects(approve(context), /revision_review_already_decided/);
  const retryCount = Number((await first(
    context.database,
    "SELECT COUNT(*) AS count FROM site_agent_v2_releases WHERE site_agent_id=?",
    [context.siteAgentId],
  )).count);
  assert.equal(retryCount, afterCount, "a duplicate approval never creates another Release");
  assert.equal((await activeReleaseRow(context.database, context.siteAgentId)).id, active.id);
});

test("approve rejects a stale Candidate hash without partial publication", async (t) => {
  const context = await scenario(t, "stale-hash");
  await passValidation(context);
  const candidateRow = await first(
    context.database,
    "SELECT candidate_json AS candidateJson FROM site_agent_v2_candidates WHERE id=? LIMIT 1",
    [context.candidate.id],
  );
  const changedCandidate = JSON.parse(candidateRow.candidateJson);
  changedCandidate.authoring.reason = "mutated after validation";
  await context.database.prepare(
    "UPDATE site_agent_v2_candidates SET candidate_json=?,updated_at=? WHERE id=?",
  ).bind(JSON.stringify(changedCandidate), "2026-07-29T02:02:00.000Z", context.candidate.id).run();
  const before = await activeReleaseRow(context.database, context.siteAgentId);
  const releaseCount = Number((await first(
    context.database,
    "SELECT COUNT(*) AS count FROM site_agent_v2_releases WHERE site_agent_id=?",
    [context.siteAgentId],
  )).count);

  await assert.rejects(approve(context), /revision_review_state_drifted/);
  assert.equal((await activeReleaseRow(context.database, context.siteAgentId)).id, before.id);
  assert.equal(Number((await first(
    context.database,
    "SELECT COUNT(*) AS count FROM site_agent_v2_releases WHERE site_agent_id=?",
    [context.siteAgentId],
  )).count), releaseCount);
  const detail = (await context.store.getCapabilityProjectDetail(context.siteAgentId, context.projectId)).detail;
  assert.equal(detail.activeRevision, undefined);
  assert.equal(detail.reviews[0].status, "awaiting-review");
});

test("approve rebases a validated Revision onto the latest Release without losing concurrent knowledge", async (t) => {
  const context = await scenario(t, "base-release-drift");
  await passValidation(context);

  const candidateBeforeAdvance = JSON.parse((await first(
    context.database,
    "SELECT candidate_json AS candidateJson FROM site_agent_v2_candidates WHERE id=? LIMIT 1",
    [context.candidate.id],
  )).candidateJson);
  const validationBeforeAdvance = JSON.parse((await first(
    context.database,
    "SELECT job_json AS jobJson FROM site_agent_v2_validation_jobs WHERE id=? LIMIT 1",
    [context.validation.id],
  )).jobJson);
  assert.equal(context.validatedRevision.baseReleaseVersion, 0);
  assert.equal(candidateBeforeAdvance.baseReleaseVersion, 0);
  assert.equal(validationBeforeAdvance.baseReleaseVersion, 0);

  const advancedRelease = await advanceActiveRelease(context, "base-release-drift");
  assert.equal(
    (await activeReleaseRow(context.database, context.siteAgentId)).id,
    advancedRelease.id,
    "the approval request begins only after another writer has activated Release v1",
  );

  const approved = await approve(context);
  assert.equal(approved.release.version, advancedRelease.version + 1);
  assert.equal(
    approved.release.profile.description,
    advancedRelease.profile.description,
    "the approval Release keeps the control-plane update that won before review",
  );
  assert.ok(
    approved.release.capabilities.some((capability) =>
      capability.id === context.capability.id
      && capability.module?.contentHash === context.capability.module.contentHash),
  );
  const afterApproval = await reviewGatePersistenceSnapshot(context);
  assert.equal(
    JSON.parse(afterApproval.releases.find((release) => release.version === 0).release_json).id,
    context.baseRelease.id,
    "the immutable Release v0 remains present and unchanged",
  );
  assert.equal(
    afterApproval.agent.active_release_id,
    approved.release.id,
    "the validated Capability is atomically materialized on top of Release v1",
  );
  const retainedAdvancedRelease = JSON.parse(
    afterApproval.releases.find((release) => release.id === advancedRelease.id).release_json,
  );
  assert.equal(retainedAdvancedRelease.contentHash, advancedRelease.contentHash);
  assert.equal(afterApproval.revision.status, "published");
  assert.equal(afterApproval.project.status, "available");
  assert.equal(afterApproval.learningJob.status, "completed");
  assert.equal(afterApproval.candidate, null);
  assert.ok(afterApproval.reviews.some((review) => review.status === "approved"));
});

test("approve rejects a stale validation run without partial publication", async (t) => {
  const context = await scenario(t, "stale-run");
  await passValidation(context);
  const validationRow = await first(
    context.database,
    "SELECT job_json AS jobJson FROM site_agent_v2_validation_jobs WHERE id=? LIMIT 1",
    [context.validation.id],
  );
  const stale = JSON.parse(validationRow.jobJson);
  stale.latestRunId = "run-that-did-not-produce-this-review";
  await context.database.prepare(
    "UPDATE site_agent_v2_validation_jobs SET job_json=?,updated_at=? WHERE id=?",
  ).bind(JSON.stringify(stale), "2026-07-29T02:02:00.000Z", context.validation.id).run();
  const before = await activeReleaseRow(context.database, context.siteAgentId);
  const releaseCount = Number((await first(
    context.database,
    "SELECT COUNT(*) AS count FROM site_agent_v2_releases WHERE site_agent_id=?",
    [context.siteAgentId],
  )).count);

  await assert.rejects(approve(context), /revision_review_state_drifted/);
  assert.equal((await activeReleaseRow(context.database, context.siteAgentId)).id, before.id);
  assert.equal(Number((await first(
    context.database,
    "SELECT COUNT(*) AS count FROM site_agent_v2_releases WHERE site_agent_id=?",
    [context.siteAgentId],
  )).count), releaseCount);
  const terminalReviews = await all(
    context.database,
    "SELECT status FROM site_agent_v2_revision_reviews WHERE revision_id=? AND status IN ('approved','rejected')",
    [context.revision.id],
  );
  assert.equal(terminalReviews.length, 0);
});

test("approve CAS conflict rolls back every approval write", async (t) => {
  const context = await scenario(t, "cas-conflict");
  await passValidation(context);
  const current = await activeReleaseRow(context.database, context.siteAgentId);
  const competingRelease = {
    ...JSON.parse(current.releaseJson),
    id: `${context.siteAgentId}:release:competing`,
    version: current.version + 50,
    contentHash: "competing-release-hash",
    createdAt: "2026-07-29T02:02:00.000Z",
  };
  await context.database.prepare(`
    INSERT INTO site_agent_v2_releases
      (id,site_agent_id,version,content_hash,release_json,created_at)
    VALUES (?,?,?,?,?,?)
  `).bind(
    competingRelease.id,
    context.siteAgentId,
    competingRelease.version,
    competingRelease.contentHash,
    JSON.stringify(competingRelease),
    competingRelease.createdAt,
  ).run();
  const countBefore = Number((await first(
    context.database,
    "SELECT COUNT(*) AS count FROM site_agent_v2_releases WHERE site_agent_id=?",
    [context.siteAgentId],
  )).count);
  context.beforeBatch(async (rawDatabase) => {
    await rawDatabase.prepare(
      "UPDATE site_agent_v2_agents SET active_release_id=?,updated_at=? WHERE id=?",
    ).bind(
      competingRelease.id,
      "2026-07-29T02:02:01.000Z",
      context.siteAgentId,
    ).run();
  });

  await assert.rejects(approve(context), /revision_approval_conflict/);
  const active = await activeReleaseRow(context.database, context.siteAgentId);
  assert.equal(active.id, competingRelease.id, "the concurrent writer remains authoritative");
  assert.equal(Number((await first(
    context.database,
    "SELECT COUNT(*) AS count FROM site_agent_v2_releases WHERE site_agent_id=?",
    [context.siteAgentId],
  )).count), countBefore, "the losing approval leaves no orphan Release");
  const detail = (await context.store.getCapabilityProjectDetail(context.siteAgentId, context.projectId)).detail;
  assert.equal(detail.activeRevision, undefined);
  assert.equal(detail.revisions.find((item) => item.id === context.revision.id).status, "awaiting-review");
  assert.equal(detail.reviews.find((item) => item.revisionId === context.revision.id).status, "awaiting-review");
  assert.ok(await first(
    context.database,
    "SELECT id FROM site_agent_v2_candidates WHERE id=? LIMIT 1",
    [context.candidate.id],
  ));
});

test("reject keeps the same Revision and LearningJob, preserves Last Good, and carries feedback through author retries", async (t) => {
  const context = await scenario(t, "reject-r1");
  await passValidation(context);
  await approve(context);
  const lastGoodRelease = await activeReleaseRow(context.database, context.siteAgentId);
  const lastGoodRevisionId = context.revision.id;
  const projectIdentity = {
    projectId: context.projectId,
    projectSuffix: context.projectSuffix,
    projectCreatedAt: context.projectCreatedAt,
    intentKey: context.intentKey,
    stableKey: context.stableKey,
    contractFingerprint: context.contractFingerprint,
    capabilityId: context.capabilityId,
  };

  context.baseRelease = JSON.parse(lastGoodRelease.releaseJson);
  context.baseReleaseRow = lastGoodRelease;
  Object.assign(context, projectIdentity);
  await insertWorkingRevision(context, "reject-r2", 2, lastGoodRevisionId);
  await passValidation(context);
  const rejectedRevisionId = context.revision.id;
  const rejectedLearningJobId = context.learning.id;
  const feedback = "The submit control is ambiguous; use the labelled primary action and verify the confirmation heading.";

  await reject(context, feedback);
  assert.equal((await activeReleaseRow(context.database, context.siteAgentId)).id, lastGoodRelease.id);
  const detail = (await context.store.getCapabilityProjectDetail(context.siteAgentId, context.projectId)).detail;
  assert.equal(detail.project.activeRevisionId, lastGoodRevisionId);
  assert.equal(detail.project.latestRevisionId, rejectedRevisionId);
  assert.equal(detail.activeRevision.id, lastGoodRevisionId);
  assert.equal(detail.workingRevision.id, rejectedRevisionId);
  assert.equal(detail.reviews.find((item) => item.revisionId === rejectedRevisionId).status, "rejected");
  assert.equal(detail.reviews.find((item) => item.revisionId === rejectedRevisionId).feedback, feedback);
  const learningRow = await first(
    context.database,
    "SELECT status,result_json AS jobJson FROM site_agent_v2_learning_jobs WHERE id=? LIMIT 1",
    [rejectedLearningJobId],
  );
  const queuedLearning = JSON.parse(learningRow.jobJson);
  assert.equal(learningRow.status, "queued");
  assert.equal(queuedLearning.id, rejectedLearningJobId);
  assert.equal(queuedLearning.phase, "author");
  assert.deepEqual(queuedLearning.reviewFeedback, {
    reviewId: detail.reviews.find((item) => item.revisionId === rejectedRevisionId).id,
    text: feedback,
  });
  const candidateRow = await first(
    context.database,
    "SELECT candidate_json AS candidateJson FROM site_agent_v2_candidates WHERE id=? LIMIT 1",
    [context.candidate.id],
  );
  assert.equal(JSON.parse(candidateRow.candidateJson).authoring.reason, feedback);
  const invalidatedValidation = JSON.parse((await first(
    context.database,
    "SELECT job_json AS jobJson FROM site_agent_v2_validation_jobs WHERE id=? LIMIT 1",
    [context.validation.id],
  )).jobJson);
  assert.ok(invalidatedValidation.invalidatedAt);
  assert.equal(invalidatedValidation.invalidatedByReviewId, queuedLearning.reviewFeedback.reviewId);
  assert.equal(invalidatedValidation.invalidatedReason, feedback);

  const authorRunnerId = "runner-reject-author";
  await context.store.registerValidationRunner({
    id: authorRunnerId,
    name: "Reject feedback author",
    role: "author",
    workKinds: ["author"],
    browsers: ["chromium"],
    maxConcurrency: 1,
  });
  const firstLease = await context.store.leaseRunnerWork(authorRunnerId, "author");
  assert.equal(firstLease.lease.kind, "author");
  assert.equal(firstLease.lease.job.id, rejectedLearningJobId);
  assert.equal(firstLease.lease.candidate.id, context.candidate.id);
  assert.deepEqual(firstLease.lease.reviewFeedback, queuedLearning.reviewFeedback);

  const leasedJobRow = await first(
    context.database,
    "SELECT result_json AS jobJson FROM site_agent_v2_learning_jobs WHERE id=? LIMIT 1",
    [rejectedLearningJobId],
  );
  const retryJob = JSON.parse(leasedJobRow.jobJson);
  retryJob.status = "queued";
  retryJob.lease = undefined;
  retryJob.updatedAt = "2026-07-29T02:03:00.000Z";
  await context.database.prepare(`
    UPDATE site_agent_v2_learning_jobs SET status='queued',result_json=?,updated_at=? WHERE id=?
  `).bind(JSON.stringify(retryJob), retryJob.updatedAt, rejectedLearningJobId).run();
  await context.database.prepare(`
    UPDATE site_agent_v2_runner_leases
       SET status='expired',active_work_key=NULL,active_slot_key=NULL,
           expires_at=?,updated_at=?
     WHERE workload_kind='learning-job' AND workload_id=? AND status='active'
  `).bind("2026-07-29T02:02:59.000Z", retryJob.updatedAt, rejectedLearningJobId).run();

  const retryRunnerId = "runner-reject-author-retry";
  await context.store.registerValidationRunner({
    id: retryRunnerId,
    name: "Reject feedback retry author",
    role: "author",
    workKinds: ["author"],
    browsers: ["chromium"],
    maxConcurrency: 1,
  });
  const retryLease = await context.store.leaseRunnerWork(retryRunnerId, "author");
  assert.equal(retryLease.lease.kind, "author");
  assert.equal(retryLease.lease.job.id, rejectedLearningJobId);
  assert.deepEqual(retryLease.lease.reviewFeedback, queuedLearning.reviewFeedback);
});

test("historical published Revision without a Review remains readable", async (t) => {
  const context = await scenario(t, "legacy-published");
  const validatedCandidate = {
    ...context.candidate,
    capability: { ...context.candidate.capability, status: "available" },
    validation: {
      ...context.candidate.validation,
      status: "passed",
      attempts: 1,
      successfulReplays: 1,
    },
  };
  const publishedRelease = compiler.materializeCandidateRelease(
    context.baseRelease,
    { id: "legacy-release-evidence", endedAt: NOW },
    validatedCandidate,
  );
  const publishedRevision = {
    ...context.revision,
    status: "published",
    stage: "publish",
    validation: {
      status: "passed",
      runId: context.run.id,
      validatedContentHash: "legacy-revision-without-review",
    },
  };
  const publishedProject = {
    ...context.project,
    status: "available",
    stage: "publish",
    activeRevisionId: publishedRevision.id,
    latestRevisionId: publishedRevision.id,
  };
  const results = await context.database.batch([
    context.database.prepare(`
      INSERT INTO site_agent_v2_releases
        (id,site_agent_id,version,content_hash,release_json,created_at)
      VALUES (?,?,?,?,?,?)
    `).bind(
      publishedRelease.id,
      context.siteAgentId,
      publishedRelease.version,
      publishedRelease.contentHash,
      JSON.stringify(publishedRelease),
      publishedRelease.createdAt,
    ),
    context.database.prepare(
      "UPDATE site_agent_v2_agents SET active_release_id=?,updated_at=? WHERE id=?",
    ).bind(publishedRelease.id, NOW, context.siteAgentId),
    context.database.prepare(`
      UPDATE site_agent_v2_capability_revisions
         SET status='published',revision_json=?,updated_at=? WHERE id=?
    `).bind(JSON.stringify(publishedRevision), NOW, publishedRevision.id),
    context.database.prepare(`
      UPDATE site_agent_v2_capability_projects
         SET active_revision_id=?,latest_revision_id=?,status='available',project_json=?,updated_at=?
       WHERE id=?
    `).bind(
      publishedRevision.id,
      publishedRevision.id,
      JSON.stringify(publishedProject),
      NOW,
      publishedProject.id,
    ),
    context.database.prepare("DELETE FROM site_agent_v2_revision_reviews WHERE revision_id=?")
      .bind(publishedRevision.id),
  ]);
  assert.equal(results.every((result) => result.success), true);

  const detail = (await context.store.getCapabilityProjectDetail(
    context.siteAgentId,
    context.projectId,
  )).detail;
  assert.equal(detail.project.activeRevisionId, publishedRevision.id);
  assert.equal(detail.activeRevision.id, publishedRevision.id);
  assert.equal(detail.activeRevision.status, "published");
  assert.deepEqual(detail.reviews || [], []);
  const active = await activeReleaseRow(context.database, context.siteAgentId);
  assert.ok(JSON.parse(active.releaseJson).capabilities.some((item) => item.id === context.capability.id));
});

test("explicit rebuild queues the next Working Revision without replacing its Capability root or Last Good", async (t) => {
  const context = await publishedScenario(t, "explicit-rebuild");
  const projectCountBefore = Number((await first(
    context.database,
    "SELECT COUNT(*) AS count FROM site_agent_v2_capability_projects WHERE site_agent_id=?",
    [context.siteAgentId],
  )).count);
  const revisionCountBefore = Number((await first(
    context.database,
    "SELECT COUNT(*) AS count FROM site_agent_v2_capability_revisions WHERE site_agent_id=? AND project_id=?",
    [context.siteAgentId, context.projectId],
  )).count);
  const releaseCountBefore = Number((await first(
    context.database,
    "SELECT COUNT(*) AS count FROM site_agent_v2_releases WHERE site_agent_id=?",
    [context.siteAgentId],
  )).count);
  const queuedJob = await queueExplicitRebuild(context);
  assert.equal(queuedJob.phase, "author");
  assert.equal(queuedJob.status, "queued");
  assert.equal(
    queuedJob.receipts.find((receipt) => receipt.stage === "design").status,
    "passed",
  );

  const projectRows = await all(
    context.database,
    `SELECT active_revision_id AS activeRevisionId,
            latest_revision_id AS latestRevisionId,
            project_json AS projectJson
       FROM site_agent_v2_capability_projects
      WHERE site_agent_id=?`,
    [context.siteAgentId],
  );
  assert.equal(projectRows.length, projectCountBefore);
  const storedProject = JSON.parse(
    projectRows.find((row) => row.activeRevisionId === context.publishedRevision.id).projectJson,
  );
  assert.equal(storedProject.id, context.projectId);
  assert.equal(storedProject.activeCapabilityId, context.publishedProject.activeCapabilityId);
  assert.equal(storedProject.activeRevisionId, context.publishedRevision.id);
  assert.equal(storedProject.stableKey, context.publishedProject.stableKey);
  assert.equal(storedProject.contractFingerprint, context.publishedProject.contractFingerprint);
  assert.notEqual(storedProject.latestRevisionId, context.publishedRevision.id);

  const revisionRows = await all(
    context.database,
    `SELECT revision_number AS revisionNumber,status,
            revision_json AS revisionJson
       FROM site_agent_v2_capability_revisions
      WHERE site_agent_id=? AND project_id=?
      ORDER BY revision_number`,
    [context.siteAgentId, context.projectId],
  );
  assert.equal(revisionRows.length, revisionCountBefore + 1);
  const workingRevision = JSON.parse(revisionRows.at(-1).revisionJson);
  assert.equal(workingRevision.id, storedProject.latestRevisionId);
  assert.equal(workingRevision.number, context.publishedRevision.number + 1);
  assert.equal(workingRevision.status, "building");
  assert.equal(workingRevision.stage, "author");
  assert.equal(workingRevision.learningJobId, queuedJob.id);
  assert.equal(workingRevision.candidateId, queuedJob.candidateId);
  assert.equal(workingRevision.id, queuedJob.result.revisionId);
  assert.equal(
    revisionRows.find((row) => Number(row.revisionNumber) === context.publishedRevision.number).status,
    "published",
  );

  const releaseAfter = await activeReleaseRow(context.database, context.siteAgentId);
  assert.equal(releaseAfter.id, context.publishedReleaseRow.id);
  assert.equal(releaseAfter.version, context.publishedReleaseRow.version);
  assert.equal(releaseAfter.releaseJson, context.publishedReleaseRow.releaseJson);
  assert.equal(Number((await first(
    context.database,
    "SELECT COUNT(*) AS count FROM site_agent_v2_releases WHERE site_agent_id=?",
    [context.siteAgentId],
  )).count), releaseCountBefore);
});

test("explicit navigation rebuild leases a trusted verified non-target authoring start URL", async (t) => {
  const context = await publishedScenario(t, "navigation-authoring-start");
  const homeUrl = "https://review.test/";
  const cartUrl = "https://review.test/cart";
  const untrustedUrl = "https://untrusted.example.test/";
  const scene = (id, name, url, directEntry = "verified") => {
    const parsed = new URL(url);
    return {
      id,
      name,
      semanticSource: "program",
      evidenceStatus: directEntry === "verified" ? "entry-verified" : "observed",
      evidence: {
        linkLabels: [],
        observedUrls: [url],
        titles: [name],
        headings: [name],
      },
      urlTemplates: [{
        id: `url-${id}`,
        originPattern: parsed.origin,
        pathnamePattern: parsed.pathname,
        query: {},
      }],
      parameters: [],
      verifier: {},
      directEntry,
      sourceObservationIds: [`observation-${id}`],
      updatedAt: NOW,
    };
  };
  const release = JSON.parse(context.publishedReleaseRow.releaseJson);
  const activeCapability = release.capabilities.find((item) =>
    item.id === context.publishedProject.activeCapabilityId);
  assert.ok(activeCapability);
  Object.assign(activeCapability, {
    kind: "navigation",
    resultKind: "page",
    name: "Open shopping cart",
    description: "Open the shopping cart page.",
    normalizedGoal: protocol.normalizeGoal("Open shopping cart"),
    goalTemplate: "Open shopping cart",
    outcomes: [{
      id: "outcome-open-cart",
      status: "success",
      code: "success",
      description: "The shopping cart page is open.",
      classifiers: [{ kind: "url", value: cartUrl }],
    }],
  });
  release.profile = {
    ...release.profile,
    entryUrl: homeUrl,
    allowedOrigins: [new URL(homeUrl).origin],
  };
  release.scenes = [
    scene("scene-cart", "Shopping cart", cartUrl),
    scene("scene-untrusted", "Untrusted external page", untrustedUrl),
    scene("scene-home", "Home", homeUrl),
  ];
  const hashableRelease = {
    ...release,
    contentHash: undefined,
    knowledgeRevision: undefined,
  };
  release.contentHash = protocol.stableHash(JSON.stringify(hashableRelease));

  const storedProjectRow = await first(
    context.database,
    "SELECT project_json AS projectJson FROM site_agent_v2_capability_projects WHERE id=?",
    [context.projectId],
  );
  const storedProject = JSON.parse(storedProjectRow.projectJson);
  const navigationProject = {
    ...storedProject,
    kind: "navigation",
    operation: "read",
    name: activeCapability.name,
    description: activeCapability.description,
    goalTemplate: activeCapability.goalTemplate,
    inputSchema: activeCapability.inputs,
    outputSchema: activeCapability.outputs,
  };
  navigationProject.contractFingerprint = capabilityIdentity.capabilityContractFingerprint({
    kind: navigationProject.kind,
    resultKind: navigationProject.resultKind,
    structure: navigationProject.structure,
    operation: navigationProject.operation,
    inputs: navigationProject.inputSchema,
    outputs: navigationProject.outputSchema,
  });
  navigationProject.stableKey = capabilityIdentity.capabilityProjectStableKey(
    navigationProject,
  );

  const storedEpisodeRow = await first(
    context.database,
    "SELECT episode_json AS episodeJson FROM site_agent_v2_episodes WHERE id=?",
    [context.episode.id],
  );
  const navigationEpisode = {
    ...JSON.parse(storedEpisodeRow.episodeJson),
    goal: activeCapability.goalTemplate,
    normalizedGoal: activeCapability.normalizedGoal,
    startSnapshot: {
      ...context.episode.startSnapshot,
      url: homeUrl,
      title: "Home",
      heading: "Home",
    },
    endSnapshot: {
      ...context.episode.endSnapshot,
      url: cartUrl,
      title: "Shopping cart",
      heading: "Shopping cart",
    },
  };
  const seeded = await context.database.batch([
    context.database.prepare(`
      UPDATE site_agent_v2_releases
         SET content_hash=?,release_json=?
       WHERE id=? AND site_agent_id=?
    `).bind(
      release.contentHash,
      JSON.stringify(release),
      release.id,
      context.siteAgentId,
    ),
    context.database.prepare(`
      UPDATE site_agent_v2_capability_projects
         SET intent_key=?,stable_key=?,contract_fingerprint=?,project_json=?,updated_at=?
       WHERE id=? AND site_agent_id=?
    `).bind(
      navigationProject.intentKey,
      navigationProject.stableKey,
      navigationProject.contractFingerprint,
      JSON.stringify(navigationProject),
      NOW,
      context.projectId,
      context.siteAgentId,
    ),
    context.database.prepare(`
      UPDATE site_agent_v2_episodes
         SET normalized_goal=?,episode_json=?
       WHERE id=? AND site_agent_id=?
    `).bind(
      navigationEpisode.normalizedGoal,
      JSON.stringify(navigationEpisode),
      navigationEpisode.id,
      context.siteAgentId,
    ),
  ]);
  assert.equal(seeded.every((result) => result.success), true);

  const queuedJob = await queueExplicitRebuild(context);
  assert.equal(queuedJob.result.authoringStartUrl, homeUrl);
  assert.notEqual(queuedJob.result.authoringStartUrl, cartUrl);
  assert.notEqual(queuedJob.result.authoringStartUrl, untrustedUrl);
  assert.equal(
    new URL(queuedJob.result.authoringStartUrl).origin,
    release.profile.allowedOrigins[0],
  );

  const authorRunnerId = "runner-navigation-authoring-start";
  await context.store.registerValidationRunner({
    id: authorRunnerId,
    name: "Navigation authoring start runner",
    role: "author",
    workKinds: ["author"],
    browsers: ["chromium"],
    maxConcurrency: 1,
  });
  const leased = await context.store.leaseRunnerWork(authorRunnerId, "author");
  assert.equal(leased.lease.kind, "author");
  assert.equal(leased.lease.job.id, queuedJob.id);
  assert.equal(leased.lease.job.result.authoringStartUrl, homeUrl);
});

test("rawExperienceOnly rebuild leases its fresh Candidate instead of an older authored Candidate", async (t) => {
  const context = await publishedScenario(t, "raw-experience-candidate");
  const legacyCandidate = structuredClone(context.candidate);
  legacyCandidate.id = "candidate-raw-experience-legacy";
  legacyCandidate.baseReleaseVersion = context.publishedReleaseRow.version;
  legacyCandidate.authoring = {
    ...legacyCandidate.authoring,
    stage: "authored",
    intentKey: context.publishedProject.intentKey,
  };
  legacyCandidate.createdAt = "2026-07-29T02:02:00.000Z";
  legacyCandidate.updatedAt = legacyCandidate.createdAt;
  const inserted = await context.database.prepare(`
    INSERT INTO site_agent_v2_candidates
      (id,site_agent_id,normalized_goal,status,base_release_version,candidate_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).bind(
    legacyCandidate.id,
    context.siteAgentId,
    legacyCandidate.normalizedGoal,
    "pending",
    legacyCandidate.baseReleaseVersion,
    JSON.stringify(legacyCandidate),
    legacyCandidate.createdAt,
    legacyCandidate.updatedAt,
  ).run();
  assert.equal(inserted.success, true);

  const queuedJob = await queueExplicitRebuild(context);
  assert.notEqual(queuedJob.candidateId, legacyCandidate.id);
  const authorRunnerId = "runner-raw-experience-candidate-author";
  await context.store.registerValidationRunner({
    id: authorRunnerId,
    name: "Raw experience author",
    role: "author",
    workKinds: ["author"],
    browsers: ["chromium"],
    maxConcurrency: 1,
  });
  const leased = await context.store.leaseRunnerWork(authorRunnerId, "author");
  assert.equal(leased.lease.kind, "author");
  assert.equal(leased.lease.job.id, queuedJob.id);
  assert.equal(leased.lease.candidate.id, queuedJob.candidateId);

  const job = JSON.parse((await first(
    context.database,
    "SELECT result_json AS jobJson FROM site_agent_v2_learning_jobs WHERE id=?",
    [queuedJob.id],
  )).jobJson);
  const workingRevision = JSON.parse((await first(
    context.database,
    `SELECT revision_json AS revisionJson
       FROM site_agent_v2_capability_revisions
      WHERE site_agent_id=? AND project_id=? AND status='building'
      ORDER BY revision_number DESC LIMIT 1`,
    [context.siteAgentId, context.projectId],
  )).revisionJson);
  assert.equal(job.candidateId, queuedJob.candidateId);
  assert.equal(workingRevision.candidateId, queuedJob.candidateId);
  assert.notEqual(workingRevision.candidateId, legacyCandidate.id);
  assert.ok(await first(
    context.database,
    "SELECT id FROM site_agent_v2_candidates WHERE id=? AND site_agent_id=?",
    [queuedJob.candidateId, context.siteAgentId],
  ));
});

test("explicit capability-control author failure immediately fails its Working Revision without replacing Last Good", async (t) => {
  const context = await publishedScenario(t, "explicit-author-failure");
  const releaseBefore = await activeReleaseRow(context.database, context.siteAgentId);
  const releaseCountBefore = Number((await first(
    context.database,
    "SELECT COUNT(*) AS count FROM site_agent_v2_releases WHERE site_agent_id=?",
    [context.siteAgentId],
  )).count);

  const failed = await failExplicitAuthoring(context, "explicit-author-failure");

  const revisionRow = await first(
    context.database,
    `SELECT status,revision_json AS revisionJson
       FROM site_agent_v2_capability_revisions
      WHERE id=? AND project_id=? AND site_agent_id=?`,
    [failed.queuedJob.result.revisionId, context.projectId, context.siteAgentId],
  );
  const failedRevision = JSON.parse(revisionRow.revisionJson);
  assert.equal(revisionRow.status, "failed");
  assert.equal(failedRevision.status, "failed");
  assert.equal(failedRevision.stage, "author");
  assert.equal(failedRevision.validation.status, "failed");
  assert.equal(failedRevision.learningJobId, failed.queuedJob.id);
  assert.equal(failedRevision.candidateId, failed.queuedJob.candidateId);

  const projectRow = await first(
    context.database,
    `SELECT active_revision_id AS activeRevisionId,
            latest_revision_id AS latestRevisionId,
            project_json AS projectJson
       FROM site_agent_v2_capability_projects
      WHERE id=? AND site_agent_id=?`,
    [context.projectId, context.siteAgentId],
  );
  const project = JSON.parse(projectRow.projectJson);
  assert.equal(projectRow.activeRevisionId, context.publishedRevision.id);
  assert.equal(project.activeRevisionId, context.publishedRevision.id);
  assert.equal(project.activeCapabilityId, context.publishedProject.activeCapabilityId);
  assert.equal(projectRow.latestRevisionId, failedRevision.id);
  assert.equal((await first(
    context.database,
    "SELECT status FROM site_agent_v2_capability_revisions WHERE id=?",
    [context.publishedRevision.id],
  )).status, "published");

  const releaseAfter = await activeReleaseRow(context.database, context.siteAgentId);
  assert.deepEqual(releaseAfter, releaseBefore);
  assert.equal(Number((await first(
    context.database,
    "SELECT COUNT(*) AS count FROM site_agent_v2_releases WHERE site_agent_id=?",
    [context.siteAgentId],
  )).count), releaseCountBefore);
});

test("re-explore after explicit author failure retries the same Revision, Job, and Candidate in place", async (t) => {
  const context = await publishedScenario(t, "explicit-author-retry");
  const failed = await failExplicitAuthoring(context, "explicit-author-retry");
  const countsBeforeRetry = {
    revisions: Number((await first(
      context.database,
      "SELECT COUNT(*) AS count FROM site_agent_v2_capability_revisions WHERE site_agent_id=? AND project_id=?",
      [context.siteAgentId, context.projectId],
    )).count),
    jobs: Number((await first(
      context.database,
      "SELECT COUNT(*) AS count FROM site_agent_v2_learning_jobs WHERE site_agent_id=?",
      [context.siteAgentId],
    )).count),
    candidates: Number((await first(
      context.database,
      "SELECT COUNT(*) AS count FROM site_agent_v2_candidates WHERE site_agent_id=?",
      [context.siteAgentId],
    )).count),
  };
  const releaseBeforeRetry = await activeReleaseRow(context.database, context.siteAgentId);

  const retried = await context.store.actOnCapabilityProject(
    context.siteAgentId,
    context.projectId,
    { action: "re-explore" },
  );

  assert.equal(retried.revision.id, failed.queuedJob.result.revisionId);
  assert.equal(retried.revision.learningJobId, failed.queuedJob.id);
  assert.equal(retried.revision.candidateId, failed.queuedJob.candidateId);
  assert.equal(retried.revision.status, "building");
  assert.equal(retried.revision.stage, "author");

  const retriedJob = JSON.parse((await first(
    context.database,
    "SELECT status,result_json AS jobJson FROM site_agent_v2_learning_jobs WHERE id=?",
    [failed.queuedJob.id],
  )).jobJson);
  const retriedCandidate = JSON.parse((await first(
    context.database,
    "SELECT status,candidate_json AS candidateJson FROM site_agent_v2_candidates WHERE id=?",
    [failed.queuedJob.candidateId],
  )).candidateJson);
  assert.equal(retriedJob.id, failed.queuedJob.id);
  assert.equal(retriedJob.status, "queued");
  assert.equal(retriedJob.phase, "author");
  assert.equal(retriedJob.latestRunId, undefined);
  assert.equal(retriedJob.failure, undefined);
  assert.equal(retriedCandidate.id, failed.queuedJob.candidateId);
  assert.equal(retriedCandidate.validation.status, "pending");
  assert.equal(retriedCandidate.authoring.stage, "designed");

  const countsAfterRetry = {
    revisions: Number((await first(
      context.database,
      "SELECT COUNT(*) AS count FROM site_agent_v2_capability_revisions WHERE site_agent_id=? AND project_id=?",
      [context.siteAgentId, context.projectId],
    )).count),
    jobs: Number((await first(
      context.database,
      "SELECT COUNT(*) AS count FROM site_agent_v2_learning_jobs WHERE site_agent_id=?",
      [context.siteAgentId],
    )).count),
    candidates: Number((await first(
      context.database,
      "SELECT COUNT(*) AS count FROM site_agent_v2_candidates WHERE site_agent_id=?",
      [context.siteAgentId],
    )).count),
  };
  assert.deepEqual(countsAfterRetry, countsBeforeRetry);
  assert.deepEqual(
    await activeReleaseRow(context.database, context.siteAgentId),
    releaseBeforeRetry,
  );
});

test("successful author completion cannot drift the Candidate result kind or output schema", async (t) => {
  const context = await publishedScenario(t, "explicit-author-contract");
  const leased = await leaseExplicitAuthor(context, "explicit-author-contract");
  const stableResultKind = leased.authorLease.candidate.capability.resultKind;
  const stableOutputs = structuredClone(leased.authorLease.candidate.capability.outputs);
  const authored = structuredClone(context.candidate);
  authored.capability.resultKind = "data";
  authored.capability.outputs = {
    type: "object",
    properties: { inventedResult: { type: "number" } },
    required: ["inventedResult"],
  };
  const run = authorCompletionRun(
    context,
    "explicit-author-contract",
    leased.authorLease,
    leased.runnerId,
    "passed",
  );

  const completion = await context.store.completeAuthoring(
    leased.runnerId,
    leased.leaseToken,
    run,
    authored,
  );
  assert.equal(completion.job.phase, "validate");
  assert.equal(completion.job.status, "queued");

  const storedCandidate = JSON.parse((await first(
    context.database,
    "SELECT candidate_json AS candidateJson FROM site_agent_v2_candidates WHERE id=?",
    [leased.queuedJob.candidateId],
  )).candidateJson);
  assert.equal(storedCandidate.capability.resultKind, stableResultKind);
  assert.deepEqual(storedCandidate.capability.outputs, stableOutputs);
  assert.notDeepEqual(storedCandidate.capability.outputs, authored.capability.outputs);
});

test("failed authoring retries the same mutable Revision, Job, and Candidate without a new Release", async (t) => {
  const context = await scenario(t, "author-retry");
  const failedAt = "2026-07-29T02:01:30.000Z";
  const failedRunId = "run-author-retry-failed";
  const failedCandidate = {
    ...context.candidate,
    validation: { ...context.candidate.validation, status: "failed" },
    authoring: {
      ...context.candidate.authoring,
      stage: "designed",
      iterations: [{
        id: "iteration-author-retry-failed",
        status: "failed",
        summary: "The old runner failed before authoring could finish.",
        startedAt: NOW,
        endedAt: failedAt,
      }],
    },
    updatedAt: failedAt,
  };
  const failedAuthorReceipt = {
    id: "receipt-author-retry-failed",
    stage: "author",
    actor: "ai",
    status: "failed",
    title: "AI program authoring failed",
    summary: "Cannot read properties of undefined (reading 'assertActive')",
    startedAt: NOW,
    endedAt: failedAt,
    evidence: { code: "authoring_runtime_failure" },
  };
  const failedLearning = {
    ...context.learning,
    phase: "author",
    status: "failed",
    attempts: 1,
    latestRunId: failedRunId,
    receipts: [context.learning.receipts[0], failedAuthorReceipt],
    failure: {
      code: "authoring_runtime_failure",
      summary: failedAuthorReceipt.summary,
    },
    updatedAt: failedAt,
  };
  const failedRevision = {
    ...context.revision,
    status: "failed",
    stage: "author",
    implementation: undefined,
    verifier: undefined,
    validation: { status: "failed", summary: failedAuthorReceipt.summary },
    updatedAt: failedAt,
  };
  const failedProject = {
    ...context.project,
    status: "needs-guidance",
    stage: "author",
    activeCapabilityId: undefined,
    activeRevisionId: undefined,
    health: {
      ...context.project.health,
      failureClass: "transient-runtime",
      recommendedAction: "re-explore",
    },
    updatedAt: failedAt,
  };
  const seeded = await context.database.batch([
    context.database.prepare(`
      UPDATE site_agent_v2_candidates
         SET status='failed',candidate_json=?,updated_at=?
       WHERE id=? AND site_agent_id=?
    `).bind(
      JSON.stringify(failedCandidate),
      failedAt,
      failedCandidate.id,
      context.siteAgentId,
    ),
    context.database.prepare(`
      UPDATE site_agent_v2_learning_jobs
         SET status='failed',result_json=?,updated_at=?
       WHERE id=? AND site_agent_id=?
    `).bind(
      JSON.stringify(failedLearning),
      failedAt,
      failedLearning.id,
      context.siteAgentId,
    ),
    context.database.prepare(`
      UPDATE site_agent_v2_capability_revisions
         SET status='failed',revision_json=?,updated_at=?
       WHERE id=? AND project_id=? AND site_agent_id=?
    `).bind(
      JSON.stringify(failedRevision),
      failedAt,
      failedRevision.id,
      failedProject.id,
      context.siteAgentId,
    ),
    context.database.prepare(`
      UPDATE site_agent_v2_capability_projects
         SET active_revision_id=NULL,status='needs-guidance',project_json=?,updated_at=?
       WHERE id=? AND site_agent_id=?
    `).bind(
      JSON.stringify(failedProject),
      failedAt,
      failedProject.id,
      context.siteAgentId,
    ),
    context.database.prepare(`
      DELETE FROM site_agent_v2_validation_jobs WHERE learning_job_id=?
    `).bind(failedLearning.id),
  ]);
  assert.equal(seeded.every((result) => result.success), true);

  const tables = [
    "site_agent_v2_capability_projects",
    "site_agent_v2_capability_revisions",
    "site_agent_v2_candidates",
    "site_agent_v2_learning_jobs",
    "site_agent_v2_releases",
  ];
  const counts = async () => Object.fromEntries(await Promise.all(
    tables.map(async (table) => [
      table,
      Number((await first(
        context.database,
        `SELECT COUNT(*) AS count FROM ${table} WHERE site_agent_id=?`,
        [context.siteAgentId],
      )).count),
    ]),
  ));
  const countsBefore = await counts();
  const releaseBefore = await activeReleaseRow(context.database, context.siteAgentId);
  const eventCount = async () => Number((await first(
    context.database,
    "SELECT COUNT(*) AS count FROM site_agent_v2_capability_events WHERE project_id=?",
    [context.projectId],
  )).count);
  const eventCountBefore = await eventCount();

  const result = await context.store.actOnCapabilityProject(
    context.siteAgentId,
    context.projectId,
    { action: "re-explore" },
  );
  assert.equal(result.project.id, failedProject.id);
  assert.equal(result.revision.id, failedRevision.id);

  const readRetryRows = async () => ({
    candidate: await first(
      context.database,
      "SELECT status,candidate_json AS candidateJson FROM site_agent_v2_candidates WHERE id=?",
      [failedCandidate.id],
    ),
    job: await first(
      context.database,
      "SELECT status,result_json AS jobJson FROM site_agent_v2_learning_jobs WHERE id=?",
      [failedLearning.id],
    ),
    revision: await first(
      context.database,
      "SELECT status,revision_json AS revisionJson FROM site_agent_v2_capability_revisions WHERE id=?",
      [failedRevision.id],
    ),
    project: await first(
      context.database,
      "SELECT status,project_json AS projectJson FROM site_agent_v2_capability_projects WHERE id=?",
      [failedProject.id],
    ),
  });
  const rows = await readRetryRows();
  const retriedCandidate = JSON.parse(rows.candidate.candidateJson);
  const retriedJob = JSON.parse(rows.job.jobJson);
  const retriedRevision = JSON.parse(rows.revision.revisionJson);
  const retriedProject = JSON.parse(rows.project.projectJson);
  assert.equal(rows.candidate.status, "pending");
  assert.equal(retriedCandidate.id, failedCandidate.id);
  assert.equal(retriedCandidate.validation.status, "pending");
  assert.equal(retriedCandidate.authoring.stage, "designed");
  assert.doesNotMatch(retriedCandidate.authoring.reason, /assertActive/);
  assert.deepEqual(retriedCandidate.sourceEpisodeIds, failedCandidate.sourceEpisodeIds);
  assert.equal(rows.job.status, "queued");
  assert.equal(retriedJob.id, failedLearning.id);
  assert.equal(retriedJob.phase, "author");
  assert.equal(retriedJob.attempts, failedLearning.attempts);
  assert.equal(retriedJob.latestRunId, undefined);
  assert.equal(retriedJob.failure, undefined);
  assert.equal(retriedJob.receipts.some((receipt) =>
    receipt.id === failedAuthorReceipt.id && receipt.status === "failed"), true);
  assert.equal(retriedJob.receipts.at(-1).stage, "author");
  assert.equal(retriedJob.receipts.at(-1).status, "queued");
  assert.equal(rows.revision.status, "building");
  assert.equal(retriedRevision.id, failedRevision.id);
  assert.equal(retriedRevision.stage, "author");
  assert.equal(retriedRevision.validation.status, "pending");
  assert.equal(rows.project.status, "building");
  assert.equal(retriedProject.id, failedProject.id);
  assert.equal(retriedProject.latestRevisionId, failedRevision.id);
  assert.deepEqual(await counts(), countsBefore);
  const releaseAfter = await activeReleaseRow(context.database, context.siteAgentId);
  assert.equal(releaseAfter.id, releaseBefore.id);
  assert.equal(releaseAfter.releaseJson, releaseBefore.releaseJson);
  assert.equal(await eventCount(), eventCountBefore + 1);

  const serializedAfterFirstRetry = {
    candidate: rows.candidate.candidateJson,
    job: rows.job.jobJson,
    revision: rows.revision.revisionJson,
    project: rows.project.projectJson,
  };
  await context.store.actOnCapabilityProject(
    context.siteAgentId,
    context.projectId,
    { action: "re-explore" },
  );
  const rowsAfterDoubleClick = await readRetryRows();
  assert.deepEqual({
    candidate: rowsAfterDoubleClick.candidate.candidateJson,
    job: rowsAfterDoubleClick.job.jobJson,
    revision: rowsAfterDoubleClick.revision.revisionJson,
    project: rowsAfterDoubleClick.project.projectJson,
  }, serializedAfterFirstRetry);
  assert.equal(await eventCount(), eventCountBefore + 1);
});

test("Revision review actions require exact-origin mutation authorization before parsing a body", async () => {
  const source = await readFile(
    new URL("../app/api/site-agents/[siteAgentId]/capability-projects/[projectId]/actions/route.ts", import.meta.url),
    "utf8",
  );
  const http = await readFile(
    new URL("../app/api/site-agents/http.ts", import.meta.url),
    "utf8",
  );
  const authorization = source.indexOf("managementMutationAuthorized(request)");
  const parseBody = source.indexOf("request.json()");
  const mutation = source.indexOf("actOnCapabilityProject(siteAgentId, projectId");
  assert.ok(authorization >= 0);
  assert.ok(parseBody > authorization, "unauthorized requests are rejected before their mutation body is parsed");
  assert.ok(mutation > authorization, "all capability actions, including approve/reject, share the mutation auth gate");
  assert.match(http, /const originHeader = request\.headers\.get\("origin"\)\?\.trim\(\)/);
  assert.match(http, /if \(!originHeader\) return false/);
  assert.match(http, /requestOrigin !== controlPlaneOrigin/);
  assert.match(http, /return managementAuthorized\(request\)/);
});

test("management mutation authorization requires the exact control-plane Origin even with a valid cookie", async () => {
  const previousEnvironment = {
    NODE_ENV: process.env.NODE_ENV,
    SITEWAKE_LOCAL_DEV: process.env.SITEWAKE_LOCAL_DEV,
    SITEWAKE_PUBLIC_ORIGIN: process.env.SITEWAKE_PUBLIC_ORIGIN,
    SITEWAKE_PUBLIC_HOSTNAME: process.env.SITEWAKE_PUBLIC_HOSTNAME,
    CLOUDFLARE_ROUTE_HOSTNAME: process.env.CLOUDFLARE_ROUTE_HOSTNAME,
  };
  process.env.NODE_ENV = "production";
  delete process.env.SITEWAKE_LOCAL_DEV;
  process.env.SITEWAKE_PUBLIC_ORIGIN = "https://control.example.com";
  delete process.env.SITEWAKE_PUBLIC_HOSTNAME;
  delete process.env.CLOUDFLARE_ROUTE_HOSTNAME;
  try {
    const http = await bundledManagementHttp();
    const url = "https://control.example.com/api/site-agents/review/capability-projects/project/actions";
    const cookie = "sr_access=valid-management-cookie";
    assert.equal(
      await http.managementMutationAuthorized(new Request(url, {
        method: "POST",
        headers: { cookie },
      })),
      false,
      "a valid management cookie is insufficient when Origin is absent",
    );
    assert.equal(
      await http.managementMutationAuthorized(new Request(url, {
        method: "POST",
        headers: {
          cookie,
          origin: "https://evil.control.example.com",
        },
      })),
      false,
      "a sibling hostname cannot inherit management authority",
    );
    assert.equal(
      await http.managementMutationAuthorized(new Request(url, {
        method: "POST",
        headers: {
          cookie,
          origin: "https://control.example.com",
        },
      })),
      true,
      "the valid cookie is accepted only from the exact control-plane Origin",
    );
  } finally {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
