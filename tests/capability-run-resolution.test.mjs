import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";
import { Miniflare } from "miniflare";

const NOW = "2026-07-30T01:00:00.000Z";
const VALIDATED_START_URL = "https://run-resolution.test/validated-entry";
const MODULE_HASH = "a".repeat(64);
let databaseSequence = 0;

async function isolatedD1Database() {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `capability-run-resolution-${databaseSequence += 1}` },
  });
  return {
    database: await miniflare.getD1Database("DB"),
    dispose: () => miniflare.dispose(),
  };
}

async function bundledStore(database) {
  const databaseKey = `__CAPABILITY_RUN_RESOLUTION_D1_${databaseSequence += 1}`;
  globalThis[databaseKey] = database;
  try {
    const result = await build({
      entryPoints: [
        fileURLToPath(new URL("../db/site-agent-store.ts", import.meta.url)),
      ],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      plugins: [{
        name: "capability-run-resolution-d1",
        setup(builder) {
          builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
            contents: `
              const database = globalThis[${JSON.stringify(databaseKey)}];
              export function getD1Binding() { return database; }
              export function getArtifactBinding() { return null; }
              export class D1UnavailableError extends Error {}
            `,
            loader: "ts",
          }));
        },
      }],
    });
    return await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
    );
  } finally {
    delete globalThis[databaseKey];
  }
}

async function bundledTrustedReleaseStartUrl() {
  const source = await readFile(
    new URL("../runner/browser-runner.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function trustedReleaseOrigins(");
  const end = source.indexOf("\nasync function runCrawl(", start);
  assert.notEqual(start, -1, "trustedReleaseStartUrl must remain executable runner code");
  assert.notEqual(end, -1, "trustedReleaseStartUrl must have a stable function boundary");
  const result = await transform(
    `${source.slice(start, end)}
export { trustedReleaseStartUrl };`,
    {
      loader: "ts",
      format: "esm",
      target: "es2022",
    },
  );
  return import(
    `data:text/javascript;base64,${Buffer.from(result.code).toString("base64")}`
  );
}

function moduleRef(contentHash = MODULE_HASH) {
  return {
    contentHash,
    moduleUrl: "/programs/pinned-capability.js",
    exportName: "capability",
  };
}

function authoringProof(suffix) {
  return {
    version: 1,
    iterationId: `iteration-${suffix}`,
    author: "ai-program-author",
    rationale: "Exercise the independently validated implementation.",
    alternativeIds: [],
    verifier: {
      success: [{ kind: "url", value: "/done" }],
      noResult: [],
      businessRejection: [],
    },
    groundedTargetIds: [],
    createdAt: NOW,
  };
}

function operationFixture(suffix) {
  const program = {
    version: 2,
    steps: [{
      id: `wait-${suffix}`,
      op: "waitForCondition",
      urlPattern: "/done",
      timeoutMs: 8_000,
    }],
  };
  return {
    id: `operation-${suffix}`,
    name: "Execute pinned capability",
    description: "Reach the independently verified result page.",
    kind: "task",
    evidenceSource: "ai-authored",
    applicability: { scope: "any-scene", evidenceSceneIds: [] },
    fromSceneId: "*",
    inputs: { type: "object", properties: {} },
    outputs: {
      type: "object",
      properties: { pageUrl: { type: "string" } },
      required: ["pageUrl"],
    },
    preconditions: [],
    effects: ["result:available"],
    implementations: [{
      id: `implementation-${suffix}`,
      program,
      authored: {
        kind: "page-program",
        program,
        proof: authoringProof(suffix),
      },
      conditions: [],
      successes: 1,
      failures: 0,
      sourceEpisodeIds: [],
    }],
    verification: { textIncludes: ["Done"] },
    status: "verified",
    updatedAt: NOW,
  };
}

function capabilityFixture(suffix, operation) {
  return {
    id: `capability-${suffix}`,
    kind: "task",
    resultKind: "page",
    exposure: "public",
    name: "Pinned capability",
    description: "A capability with immutable execution resolution.",
    normalizedGoal: "execute pinned capability",
    goalTemplate: "Execute pinned capability",
    aliases: [],
    inputs: operation.inputs,
    outputs: operation.outputs,
    outcomes: [{
      id: `outcome-${suffix}`,
      status: "success",
      code: "success",
      description: "The result page is available.",
      classifiers: [],
    }],
    plans: [{
      id: `plan-${suffix}`,
      entrySceneIds: ["*"],
      steps: [{ operationId: operation.id, bindings: {} }],
      outputBindings: {
        pageUrl: { source: "state", path: "__pageUrl" },
      },
    }],
    sourceEpisodeIds: [],
    confidence: 1,
    status: "available",
    origin: "administrator",
    module: moduleRef(),
    updatedAt: NOW,
  };
}

function projectFixture({
  siteAgentId,
  suffix,
  capability,
  revisionId,
  activeCapabilityId = capability.id,
}) {
  return {
    id: `project-${suffix}`,
    siteAgentId,
    intentKey: `intent-${suffix}`,
    name: capability.name,
    description: capability.description,
    goalTemplate: capability.goalTemplate,
    origin: "administrator",
    triggeredBy: "administrator",
    generatedBy: "ai",
    status: "available",
    stage: "publish",
    kind: capability.kind,
    structure: "atomic",
    operation: "read",
    exposure: "public",
    resultKind: "page",
    canonicalCapabilityId: capability.id,
    activeCapabilityId,
    activeRevisionId: revisionId,
    latestRevisionId: revisionId,
    inputSchema: capability.inputs,
    outputSchema: capability.outputs,
    executionRequirements: {
      authentication: "unknown",
      supportedEnvironments: {
        connectedBrowser: "supported",
        cloudBrowser: "supported",
        managedProfile: "blocked",
      },
      checkpoints: [],
      evidenceRefs: [],
    },
    health: { recentRuns: 0, recentSuccesses: 0 },
    revisionCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function revisionFixture({
  siteAgentId,
  projectId,
  suffix,
  releaseId,
  releaseVersion,
  status = "published",
  validationStatus = "passed",
  implementationHash = MODULE_HASH,
  navigationTool,
}) {
  return {
    id: `revision-${suffix}`,
    projectId,
    siteAgentId,
    number: 1,
    status,
    stage: status === "published" ? "publish" : "validate",
    baseReleaseVersion: releaseVersion,
    implementationReleaseId: releaseId,
    implementationReleaseVersion: releaseVersion,
    publishedReleaseId: status === "published" ? releaseId : undefined,
    publishedReleaseVersion: status === "published" ? releaseVersion : undefined,
    publicationProvenance: status === "published" ? "human-reviewed" : undefined,
    learningJobId: `learning-${suffix}`,
    parameterizationDecisions: [],
    implementation: navigationTool
      ? {
          kind: "navigation-tool",
          toolRef: {
            toolId: navigationTool.id,
            knowledgeRevision: navigationTool.source.knowledgeRevision,
            dependencyHash: navigationTool.source.dependencyHash,
          },
        }
      : {
          kind: "module",
          module: moduleRef(implementationHash),
          proof: authoringProof(`revision-${suffix}`),
        },
    verifier: {
      success: [{ kind: "url", value: "/done" }],
      noResult: [],
      businessRejection: [],
    },
    validation: {
      status: validationStatus,
      runId: `validation-run-${suffix}`,
      validatedContentHash: `validated-${suffix}`,
    },
    guidanceIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function browserRunFixture({
  id,
  siteAgentId,
  learningJobId,
  capabilityId,
  startUrl,
  startedAt = NOW,
  status = "passed",
}) {
  return {
    id,
    learningJobId,
    validationJobId: `validation-job-${id}`,
    siteAgentId,
    candidateId: capabilityId,
    runnerId: "validation-runner",
    mode: "validate",
    status,
    browser: { name: "chromium", version: "1", headless: true },
    startedAt,
    endedAt: startedAt,
    startUrl,
    endUrl: "https://run-resolution.test/done",
    steps: [],
    outcome: {
      status: "success",
      code: "verified",
      summary: "Independent validation passed.",
      evaluatedAt: startedAt,
      evidence: {},
    },
  };
}

async function seedScenario(t, suffix, options = {}) {
  const isolated = await isolatedD1Database();
  t.after(isolated.dispose);
  const store = await bundledStore(isolated.database);
  const siteAgentId = `run-resolution-${suffix}`;

  await store.createSiteAgent({
    id: siteAgentId,
    name: `Run Resolution ${suffix}`,
    url: "https://run-resolution.test/",
  });

  // Establish the executable-asset epoch before inserting the fixture rows.
  const active = await store.getActiveSiteAgentRelease(siteAgentId);
  const operation = operationFixture(suffix);
  const baseCapability = capabilityFixture(suffix, operation);
  const capability = options.navigationTool
    ? {
        ...baseCapability,
        kind: "navigation",
        module: undefined,
      }
    : baseCapability;
  const navigationTool = options.navigationTool
    ? {
        id: `navigation-tool-${suffix}`,
        siteAgentId,
        intentKey: `intent-navigation-${suffix}`,
        name: "Open the pinned page",
        description: "Reach the pinned target Scene.",
        aliases: [],
        targetSceneId: `scene-${suffix}`,
        inputs: capability.inputs,
        outputs: capability.outputs,
        applicability: { scope: "any-scene", evidenceSceneIds: [] },
        strategies: [{
          kind: "scene-program",
          operationId: operation.id,
        }],
        verifier: { sceneId: `scene-${suffix}` },
        source: {
          kind: "knowledge-compiled",
          knowledgeRevision: 7,
          dependencyHash: `dependency-${suffix}`,
          evidenceRefs: [],
        },
        status: "verified",
        usedByCapabilityIds: [capability.id],
        updatedAt: NOW,
      }
    : undefined;
  if (navigationTool && options.navigationDependencyHash) {
    navigationTool.source.dependencyHash = options.navigationDependencyHash;
  }
  const release = {
    ...active.release,
    profile: {
      ...active.release.profile,
      entryUrl: "https://run-resolution.test/",
      allowedOrigins: ["https://run-resolution.test"],
    },
    scenes: navigationTool
      ? [{
          id: navigationTool.targetSceneId,
          name: "Pinned target",
          evidenceStatus: "observed",
          lifecycle: "observed",
          urlTemplates: [{
            id: `url-${suffix}`,
            originPattern: "https://run-resolution.test",
            pathnamePattern: "/done",
            query: {},
          }],
          parameters: [],
          verifier: { urlPattern: "/done" },
          directEntry: "verified",
          sourceObservationIds: [],
          updatedAt: NOW,
        }]
      : active.release.scenes,
    operations: [operation],
    navigationTools: navigationTool ? [navigationTool] : active.release.navigationTools,
    capabilities: [capability],
    contentHash: `release-hash-${suffix}`,
  };
  const revisionId = `revision-${suffix}`;
  const project = projectFixture({
    siteAgentId,
    suffix,
    capability,
    revisionId,
    activeCapabilityId: options.activeCapabilityId,
  });
  const revision = revisionFixture({
    siteAgentId,
    projectId: project.id,
    suffix,
    releaseId: release.id,
    releaseVersion: release.version,
    status: options.revisionStatus,
    validationStatus: options.validationStatus,
    implementationHash: options.implementationHash,
    navigationTool,
  });
  if (navigationTool && options.revisionNavigationDependencyHash) {
    revision.implementation.toolRef.dependencyHash =
      options.revisionNavigationDependencyHash;
  }
  const validatedRun = browserRunFixture({
    id: revision.validation.runId,
    siteAgentId,
    learningJobId: revision.learningJobId,
    capabilityId: capability.id,
    startUrl: options.validatedStartUrl ?? VALIDATED_START_URL,
  });
  const unrelatedPassedRun = browserRunFixture({
    id: `unrelated-passed-run-${suffix}`,
    siteAgentId,
    learningJobId: revision.learningJobId,
    capabilityId: capability.id,
    startUrl: "https://run-resolution.test/unrelated-newer-run",
    startedAt: "2026-07-30T01:01:00.000Z",
  });

  const results = await isolated.database.batch([
    isolated.database.prepare(`
      UPDATE site_agent_v2_releases
         SET content_hash=?,release_json=?
       WHERE id=? AND site_agent_id=?
    `).bind(
      release.contentHash,
      JSON.stringify(release),
      release.id,
      siteAgentId,
    ),
    isolated.database.prepare(`
      INSERT INTO site_agent_v2_capability_projects
        (id,site_agent_id,intent_key,active_revision_id,latest_revision_id,status,project_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).bind(
      project.id,
      siteAgentId,
      project.intentKey,
      project.activeRevisionId,
      project.latestRevisionId,
      project.status,
      JSON.stringify(project),
      project.createdAt,
      project.updatedAt,
    ),
    isolated.database.prepare(`
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
    ...[validatedRun, unrelatedPassedRun].map((run) =>
      isolated.database.prepare(`
        INSERT INTO site_agent_v2_browser_runs
          (id,learning_job_id,validation_job_id,site_agent_id,candidate_id,status,run_json,started_at,ended_at)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).bind(
        run.id,
        run.learningJobId,
        run.validationJobId,
        run.siteAgentId,
        run.candidateId,
        run.status,
        JSON.stringify(run),
        run.startedAt,
        run.endedAt,
      )),
  ]);
  assert.equal(results.every((result) => result.success), true);

  let scenarioRelease = release;
  let scenarioCapability = capability;
  let scenarioProject = project;
  let scenarioRevision = revision;
  let scenarioNavigationTool = navigationTool;
  if (options.navigationTool) {
    const compiled = await store.getActiveSiteAgentRelease(siteAgentId);
    const compiledTool = compiled.release.navigationTools[0];
    assert.ok(compiledTool, "the seeded target Scene must compile a NavigationTool");
    const compiledOperationId = compiledTool.strategies[0]?.operationId;
    assert.ok(compiledOperationId, "the compiled NavigationTool must own an Operation");
    scenarioCapability = {
      ...capability,
      plans: capability.plans.map((plan) => ({
        ...plan,
        steps: [{ operationId: compiledOperationId, bindings: {} }],
      })),
    };
    scenarioRevision = {
      ...revision,
      implementation: {
        kind: "navigation-tool",
        toolRef: {
          toolId: compiledTool.id,
          knowledgeRevision: compiledTool.source.knowledgeRevision,
          dependencyHash: options.revisionNavigationDependencyHash
            || compiledTool.source.dependencyHash,
        },
      },
    };
    scenarioProject = {
      ...project,
      kind: "navigation",
      inputSchema: scenarioCapability.inputs,
      outputSchema: scenarioCapability.outputs,
    };
    scenarioRelease = {
      ...compiled.release,
      capabilities: [scenarioCapability],
      contentHash: `release-hash-${suffix}-compiled-navigation`,
    };
    scenarioNavigationTool = compiledTool;
    const aligned = await isolated.database.batch([
      isolated.database.prepare(`
        UPDATE site_agent_v2_releases
           SET content_hash=?,release_json=?
         WHERE id=? AND site_agent_id=?
      `).bind(
        scenarioRelease.contentHash,
        JSON.stringify(scenarioRelease),
        scenarioRelease.id,
        siteAgentId,
      ),
      isolated.database.prepare(`
        UPDATE site_agent_v2_capability_projects
           SET project_json=?,updated_at=?
         WHERE id=? AND site_agent_id=?
      `).bind(
        JSON.stringify(scenarioProject),
        scenarioProject.updatedAt,
        scenarioProject.id,
        siteAgentId,
      ),
      isolated.database.prepare(`
        UPDATE site_agent_v2_capability_revisions
           SET revision_json=?,updated_at=?
         WHERE id=? AND site_agent_id=?
      `).bind(
        JSON.stringify(scenarioRevision),
        scenarioRevision.updatedAt,
        scenarioRevision.id,
        siteAgentId,
      ),
    ]);
    assert.equal(aligned.every((result) => result.success), true);
  }

  return {
    ...isolated,
    store,
    siteAgentId,
    release: scenarioRelease,
    capability: scenarioCapability,
    project: scenarioProject,
    revision: scenarioRevision,
    navigationTool: scenarioNavigationTool,
  };
}

function createCloudRun(context) {
  return context.store.createCapabilityRun({
    siteAgentId: context.siteAgentId,
    projectId: context.project.id,
    capabilityId: context.capability.id,
    mode: "run",
    environment: { kind: "cloud-browser" },
    input: {},
  });
}

function createCloudRunWithoutProject(context) {
  return context.store.createCapabilityRun({
    siteAgentId: context.siteAgentId,
    capabilityId: context.capability.id,
    mode: "run",
    environment: { kind: "cloud-browser" },
    input: {},
  });
}

function createConnectedRun(context) {
  return context.store.createCapabilityRun({
    siteAgentId: context.siteAgentId,
    capabilityId: context.capability.id,
    mode: "run",
    environment: { kind: "connected-browser" },
    input: {},
  });
}

async function leaseCloudRun(context, suffix) {
  const registration = await context.store.registerValidationRunner({
    id: `execution-runner-${suffix}-${databaseSequence}`,
    name: "Capability execution runner",
    role: "interactive",
    workKinds: ["execute"],
    browsers: ["chromium"],
    maxConcurrency: 1,
  });
  return context.store.leaseRunnerWork(
    registration.runner.id,
    "interactive",
    {
      sessionId: registration.instance.sessionId,
      sessionToken: registration.sessionToken,
    },
  );
}

function cloudCompletionPatch(context, run, overrides = {}) {
  const completedAt = "2026-07-30T01:05:00.000Z";
  const patch = {
    status: "completed",
    steps: [],
    timings: { executionMs: 250, totalMs: 500 },
    artifactIds: ["artifact-cloud-result"],
    progress: {
      stage: "complete",
      message: "Evidence saved.",
      updatedAt: completedAt,
    },
    output: { pageUrl: "https://run-resolution.test/done" },
    outcome: {
      status: "success",
      code: "capability_run_completed",
      summary: "Pinned capability completed.",
      evaluatedAt: completedAt,
      evidence: { source: "cloud-capability-run" },
    },
    resultUrl: "https://run-resolution.test/done",
    startedAt: run.startedAt || NOW,
    completedAt,
    browserRun: {
      id: `browser-${run.id}`,
      learningJobId: `capability_run:${run.id}`,
      siteAgentId: context.siteAgentId,
      candidateId: context.capability.id,
      runnerId: run.lease.runnerId,
      mode: "execute",
      status: "passed",
      browser: { name: "chromium", version: "1", headless: true },
      startedAt: run.startedAt || NOW,
      endedAt: completedAt,
      startUrl: run.startUrl,
      endUrl: "https://run-resolution.test/done",
      steps: [],
      artifactIds: ["artifact-cloud-result"],
    },
  };
  return {
    ...patch,
    ...overrides,
    browserRun: overrides.browserRun === undefined
      ? patch.browserRun
      : overrides.browserRun,
  };
}

test("reading an embedded Release never mutates its immutable JSON or hash", async (t) => {
  const context = await seedScenario(t, "immutable-release-read");
  const before = await context.database.prepare(`
    SELECT content_hash AS contentHash,release_json AS releaseJson
      FROM site_agent_v2_releases
     WHERE id=? AND site_agent_id=?
  `).bind(context.release.id, context.siteAgentId).first();

  const active = await context.store.getActiveSiteAgentRelease(context.siteAgentId);

  const after = await context.database.prepare(`
    SELECT content_hash AS contentHash,release_json AS releaseJson
      FROM site_agent_v2_releases
     WHERE id=? AND site_agent_id=?
  `).bind(context.release.id, context.siteAgentId).first();
  assert.deepEqual(after, before);
  assert.ok(active.release.capabilities.some(
    (item) => item.id === context.capability.id && item.module?.contentHash === MODULE_HASH,
  ));
});

test("ordinary capability reads preserve every persisted project, Revision, and evidence row", async (t) => {
  const context = await seedScenario(t, "read-preserves-history");
  const snapshot = async () => {
    const [projects, revisions, runs] = await Promise.all([
      context.database.prepare(`
        SELECT id,project_json AS json
          FROM site_agent_v2_capability_projects
         WHERE site_agent_id=? ORDER BY id
      `).bind(context.siteAgentId).all(),
      context.database.prepare(`
        SELECT id,revision_json AS json
          FROM site_agent_v2_capability_revisions
         WHERE site_agent_id=? ORDER BY id
      `).bind(context.siteAgentId).all(),
      context.database.prepare(`
        SELECT id,run_json AS json
          FROM site_agent_v2_browser_runs
         WHERE site_agent_id=? ORDER BY id
      `).bind(context.siteAgentId).all(),
    ]);
    return {
      projects: projects.results,
      revisions: revisions.results,
      runs: runs.results,
    };
  };
  const before = await snapshot();

  await context.store.getSiteAgentOverview(context.siteAgentId);
  await context.store.getActiveSiteAgentRelease(context.siteAgentId);
  await context.store.listCapabilityProjects(context.siteAgentId);
  await context.store.getCapabilityProjectDetail(
    context.siteAgentId,
    context.project.id,
  );
  await context.store.listCapabilityRuns(context.siteAgentId);

  assert.deepEqual(await snapshot(), before);
});

test("creating a cloud CapabilityRun persists its Release, Revision, and validated start URL pins", async (t) => {
  const context = await seedScenario(t, "pins");
  const created = await createCloudRun(context);
  const storedRow = await context.database.prepare(
    "SELECT run_json AS runJson FROM site_agent_v2_capability_runs WHERE id=?"
  ).bind(created.run.id).first();
  const stored = JSON.parse(storedRow.runJson);
  const expectedPins = {
    releaseId: context.release.id,
    releaseVersion: context.release.version,
    revisionId: context.revision.id,
    startUrl: VALIDATED_START_URL,
  };

  assert.deepEqual({
    releaseId: created.run.releaseId,
    releaseVersion: created.run.releaseVersion,
    revisionId: created.run.revisionId,
    startUrl: created.run.startUrl,
  }, expectedPins);
  assert.deepEqual({
    releaseId: stored.releaseId,
    releaseVersion: stored.releaseVersion,
    revisionId: stored.revisionId,
    startUrl: stored.startUrl,
  }, expectedPins);
});

test("a published module-less NavigationTool Revision can create and lease a cloud CapabilityRun", async (t) => {
  const context = await seedScenario(t, "navigation-tool-run", {
    navigationTool: true,
  });
  const created = await createCloudRun(context);
  const leased = await leaseCloudRun(context, "navigation-tool-run");

  assert.equal(created.run.releaseId, context.release.id);
  assert.equal(created.run.revisionId, context.revision.id);
  assert.equal(created.run.startUrl, VALIDATED_START_URL);
  assert.equal(context.capability.module, undefined);
  assert.equal(leased.lease?.kind, "execute");
  assert.equal(leased.lease?.revision.id, context.revision.id);
  assert.deepEqual(
    leased.lease?.revision.implementation,
    context.revision.implementation,
  );
  assert.equal(
    leased.lease?.release.navigationTools[0].source.dependencyHash,
    context.navigationTool.source.dependencyHash,
  );
});

test("cloud completion stays running while recording and commits one immutable terminal Run with evidence", async (t) => {
  const context = await seedScenario(t, "cloud-terminal-atomic");
  const created = await createCloudRun(context);
  const leased = await leaseCloudRun(context, "cloud-terminal-atomic");
  assert.equal(leased.lease?.kind, "execute");
  const leasedRun = leased.lease.job;
  const runnerId = leasedRun.lease.runnerId;
  const leaseToken = leasedRun.lease.token;

  const runningPatch = {
    status: "running",
    steps: [],
    timings: { executionMs: 250 },
    artifactIds: [],
    progress: {
      stage: "recording",
      message: "Saving evidence.",
      updatedAt: "2026-07-30T01:04:00.000Z",
    },
  };
  await assert.rejects(
    context.store.updateCapabilityRunFromRunner(
      runnerId,
      leaseToken,
      leasedRun.id,
      {
        ...runningPatch,
        output: { pageUrl: "https://run-resolution.test/forged-before-terminal" },
      },
    ),
    /capability_run_nonterminal_result_rejected/,
  );
  const recording = await context.store.updateCapabilityRunFromRunner(
    runnerId,
    leaseToken,
    leasedRun.id,
    runningPatch,
  );
  assert.equal(recording.run.status, "running");
  assert.ok(recording.run.lease);
  const beforeTerminalEvidence = await context.database.prepare(`
    SELECT COUNT(*) AS count
      FROM site_agent_v2_browser_runs
     WHERE learning_job_id=?
  `).bind(`capability_run:${created.run.id}`).first();
  assert.equal(Number(beforeTerminalEvidence.count), 0);

  const completion = cloudCompletionPatch(context, recording.run);
  const completed = await context.store.updateCapabilityRunFromRunner(
    runnerId,
    leaseToken,
    leasedRun.id,
    completion,
  );
  assert.equal(completed.run.status, "completed");
  assert.equal(completed.run.lease, undefined);
  assert.equal(completed.run.output.pageUrl, "https://run-resolution.test/done");
  assert.equal(completed.run.completionReceipt.runnerId, runnerId);
  assert.equal(completed.run.completionReceipt.browserRunId, completion.browserRun.id);

  const evidence = await context.database.prepare(`
    SELECT run_json AS runJson
      FROM site_agent_v2_browser_runs
     WHERE id=?
  `).bind(completion.browserRun.id).first();
  assert.ok(evidence);
  assert.equal(JSON.parse(evidence.runJson).status, "passed");
  const detail = await context.store.getCapabilityProjectDetail(
    context.siteAgentId,
    context.project.id,
  );
  assert.ok(detail.detail.capabilityRuns.some((item) =>
    item.id === completed.run.id));
  assert.ok(detail.detail.browserRuns.some((item) =>
    item.id === completion.browserRun.id),
  "accepted execution BrowserRun must remain visible in its Capability history");

  await new Promise((resolve) => setTimeout(resolve, 5));
  const replay = await context.store.updateCapabilityRunFromRunner(
    runnerId,
    leaseToken,
    leasedRun.id,
    completion,
    { allowCompletedRetry: true },
  );
  assert.equal(replay.duplicate, true);
  assert.equal(replay.run.updatedAt, completed.run.updatedAt);

  await assert.rejects(
    () => context.store.updateCapabilityRunFromRunner(
      runnerId,
      leaseToken,
      leasedRun.id,
      {
        ...completion,
        output: { pageUrl: "https://run-resolution.test/other" },
      },
      { allowCompletedRetry: true },
    ),
    /invalid_runner_lease/,
  );
});

test("cloud completion converts invalid pinned output into a canonical terminal failure", async (t) => {
  const context = await seedScenario(t, "cloud-output-server-gate");
  await createCloudRun(context);
  const leased = await leaseCloudRun(context, "cloud-output-server-gate");
  const leasedRun = leased.lease.job;
  const completion = cloudCompletionPatch(context, leasedRun, { output: {} });
  const failed = await context.store.updateCapabilityRunFromRunner(
    leasedRun.lease.runnerId,
    leasedRun.lease.token,
    leasedRun.id,
    completion,
  );

  assert.equal(failed.run.status, "failed");
  assert.equal(failed.run.error.code, "capability_output_required");
  assert.equal(failed.run.outcome.status, "execution-fault");
  assert.equal(failed.run.outcome.code, "capability_output_required");
  assert.deepEqual(failed.run.output, {});
  const evidence = await context.database.prepare(`
    SELECT run_json AS runJson
      FROM site_agent_v2_browser_runs
     WHERE id=?
  `).bind(completion.browserRun.id).first();
  assert.equal(JSON.parse(evidence.runJson).status, "failed");
});

test("cloud completion rejects evidence outside the pinned Revision start URL and keeps the lease retryable", async (t) => {
  const context = await seedScenario(t, "cloud-evidence-pin");
  await createCloudRun(context);
  const leased = await leaseCloudRun(context, "cloud-evidence-pin");
  const leasedRun = leased.lease.job;
  const completion = cloudCompletionPatch(context, leasedRun, {
    browserRun: {
      ...cloudCompletionPatch(context, leasedRun).browserRun,
      startUrl: "https://run-resolution.test/unvalidated-entry",
    },
  });

  await assert.rejects(
    () => context.store.updateCapabilityRunFromRunner(
      leasedRun.lease.runnerId,
      leasedRun.lease.token,
      leasedRun.id,
      completion,
    ),
    /capability_browser_run_start_url_mismatch/,
  );
  const stored = await context.store.getCapabilityRun(
    context.siteAgentId,
    leasedRun.id,
  );
  assert.equal(stored.run.status, "running");
  assert.ok(stored.run.lease);
  const evidence = await context.database.prepare(`
    SELECT COUNT(*) AS count
      FROM site_agent_v2_browser_runs
     WHERE id=?
  `).bind(completion.browserRun.id).first();
  assert.equal(Number(evidence.count), 0);
});

test("competing cloud terminal callbacks commit only one Run and its matching BrowserRun", async (t) => {
  const context = await seedScenario(t, "cloud-terminal-cas");
  await createCloudRun(context);
  const leased = await leaseCloudRun(context, "cloud-terminal-cas");
  const leasedRun = leased.lease.job;
  const first = cloudCompletionPatch(context, leasedRun);
  const second = cloudCompletionPatch(context, leasedRun, {
    output: { pageUrl: "https://run-resolution.test/alternate" },
    resultUrl: "https://run-resolution.test/alternate",
    browserRun: {
      ...cloudCompletionPatch(context, leasedRun).browserRun,
      id: `browser-alternate-${leasedRun.id}`,
      endUrl: "https://run-resolution.test/alternate",
    },
  });
  const settled = await Promise.allSettled([
    context.store.updateCapabilityRunFromRunner(
      leasedRun.lease.runnerId,
      leasedRun.lease.token,
      leasedRun.id,
      first,
    ),
    context.store.updateCapabilityRunFromRunner(
      leasedRun.lease.runnerId,
      leasedRun.lease.token,
      leasedRun.id,
      second,
    ),
  ]);
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(settled.filter((item) => item.status === "rejected").length, 1);

  const stored = await context.store.getCapabilityRun(
    context.siteAgentId,
    leasedRun.id,
  );
  const evidenceRows = await context.database.prepare(`
    SELECT id,run_json AS runJson
      FROM site_agent_v2_browser_runs
     WHERE learning_job_id=?
  `).bind(`capability_run:${leasedRun.id}`).all();
  assert.equal(evidenceRows.results.length, 1);
  const evidence = JSON.parse(evidenceRows.results[0].runJson);
  assert.equal(evidence.id, stored.run.completionReceipt.browserRunId);
  assert.equal(evidence.endUrl, stored.run.resultUrl);
});

test("a connected-browser CapabilityRun and TaskLaunch share one exact Release and Revision pin", async (t) => {
  const context = await seedScenario(t, "connected-browser-pin", {
    navigationTool: true,
  });
  const driftedConnection = await context.database.prepare(`
    INSERT INTO site_agent_v2_connections
      (site_agent_id,origin,url,title,heading,connected_at,last_seen_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(site_agent_id) DO UPDATE SET
      origin=excluded.origin,url=excluded.url,last_seen_at=excluded.last_seen_at
  `).bind(
    context.siteAgentId,
    "https://current-connection.invalid",
    "https://current-connection.invalid/unvalidated-page",
    "Drifted connection",
    "Drifted connection",
    NOW,
    NOW,
  ).run();
  assert.equal(driftedConnection.success, true);
  const created = await createConnectedRun(context);
  const launchRow = await context.database.prepare(`
    SELECT project_id AS projectId,launch_json AS launchJson
      FROM site_agent_v2_task_launches
     WHERE id=? AND site_agent_id=?
  `).bind(created.run.taskLaunchId, context.siteAgentId).first();
  const launch = JSON.parse(launchRow.launchJson);

  assert.equal(created.run.status, "waiting-for-browser");
  assert.equal(created.run.projectId, context.project.id);
  assert.equal(created.run.releaseId, context.revision.publishedReleaseId);
  assert.equal(created.run.releaseVersion, context.revision.publishedReleaseVersion);
  assert.equal(created.run.revisionId, context.revision.id);
  assert.equal(launch.projectId, context.project.id);
  assert.equal(launchRow.projectId, context.project.id);
  assert.equal(launch.capabilityRunId, created.run.id);
  assert.equal(launch.releaseId, created.run.releaseId);
  assert.equal(launch.releaseVersion, created.run.releaseVersion);
  assert.equal(launch.revisionId, created.run.revisionId);
  assert.equal(launch.startUrl, VALIDATED_START_URL);
  assert.equal(launch.allowedOrigin, new URL(VALIDATED_START_URL).origin);
  const launchUrl = new URL(created.launchUrl);
  assert.equal(launchUrl.origin, new URL(VALIDATED_START_URL).origin);
  assert.equal(launchUrl.pathname, new URL(VALIDATED_START_URL).pathname);
  assert.notEqual(launchUrl.origin, "https://current-connection.invalid");
  assert.ok(
    new URLSearchParams(launchUrl.hash.slice(1)).get("sitewake-launch"),
  );
});

test("a pinned hash-router start URL survives TaskLaunch token transport", async (t) => {
  const validatedStartUrl = "https://run-resolution.test/#/cart";
  const context = await seedScenario(t, "connected-browser-hash-pin", {
    navigationTool: true,
    validatedStartUrl,
  });
  const created = await createConnectedRun(context);
  const launchRow = await context.database.prepare(`
    SELECT launch_json AS launchJson
      FROM site_agent_v2_task_launches
     WHERE id=? AND site_agent_id=?
  `).bind(created.run.taskLaunchId, context.siteAgentId).first();
  const launch = JSON.parse(launchRow.launchJson);
  const launchUrl = new URL(created.launchUrl);
  const launchHash = new URLSearchParams(launchUrl.hash.slice(1));

  assert.equal(launch.startUrl, validatedStartUrl);
  assert.equal(launchUrl.origin, "https://run-resolution.test");
  assert.equal(launchUrl.pathname, "/");
  assert.equal(launchHash.get("sitewake-return-hash"), "/cart");
  assert.ok(launchHash.get("sitewake-launch"));

  const client = await readFile(
    new URL("../client/user-agent-client.ts", import.meta.url),
    "utf8",
  );
  assert.match(client, /capturedReturnHash[\s\S]*history\.replaceState/);
});

test("D1 rejects a claimed connected Run completion whose output violates the pinned schema", async (t) => {
  const context = await seedScenario(t, "connected-output-server-gate");
  const created = await createConnectedRun(context);
  const launchUrl = new URL(created.launchUrl);
  const token = new URLSearchParams(launchUrl.hash.slice(1)).get(
    "sitewake-launch",
  );
  assert.ok(token);
  const claimed = await context.store.claimTaskLaunch(
    context.siteAgentId,
    created.run.taskLaunchId,
    { token, origin: launchUrl.origin, claimKey: "claim_resolution_test_01" },
  );
  const invalidCompletion = {
    claimKey: claimed.claimKey,
    origin: launchUrl.origin,
    status: "completed",
    output: {},
    outcome: {
      status: "success",
      code: "success",
      summary: "client claimed success",
      evidence: {},
      evaluatedAt: NOW,
    },
  };
  const failed = await context.store.updateTaskLaunch(
    context.siteAgentId,
    created.run.taskLaunchId,
    invalidCompletion,
  );
  assert.equal(failed.launch.status, "failed");
  assert.equal(failed.launch.outcome.status, "execution-fault");
  assert.equal(failed.launch.outcome.code, "capability_output_required");
  assert.equal(failed.launch.error.code, "capability_output_required");
  assert.deepEqual(failed.launch.output, {});

  const replay = await context.store.updateTaskLaunch(
    context.siteAgentId,
    created.run.taskLaunchId,
    invalidCompletion,
  );
  assert.equal(replay.launch.status, "failed");
  assert.equal(replay.launch.outcome.code, "capability_output_required");

  const storedBeforeRead = await context.database.prepare(`
    SELECT status,run_json AS runJson
      FROM site_agent_v2_capability_runs
     WHERE id=?
  `).bind(created.run.id).first();
  const projected = await context.store.getCapabilityRun(
    context.siteAgentId,
    created.run.id,
  );
  const storedAfterRead = await context.database.prepare(`
    SELECT status,run_json AS runJson
      FROM site_agent_v2_capability_runs
     WHERE id=?
  `).bind(created.run.id).first();
  assert.equal(projected.run.status, "failed");
  assert.deepEqual(storedAfterRead, storedBeforeRead);
  assert.equal(storedAfterRead.status, "failed");
  assert.equal(JSON.parse(storedAfterRead.runJson).outcome.code, "capability_output_required");
  const listed = await context.store.listCapabilityRuns(
    context.siteAgentId,
    { capabilityId: context.capability.id },
  );
  assert.equal(listed.runs[0].status, "failed");
  assert.equal(listed.runs[0].outcome.code, "capability_output_required");
});

test("creating a module-less cloud CapabilityRun rejects a mismatched NavigationTool Revision pin", async (t) => {
  const context = await seedScenario(t, "navigation-tool-create-mismatch", {
    navigationTool: true,
    revisionNavigationDependencyHash: "stale-revision-dependency",
  });

  await assert.rejects(
    () => createCloudRun(context),
    /capability_run_navigation_tool_mismatch/,
  );
  const count = await context.database.prepare(
    "SELECT COUNT(*) AS count FROM site_agent_v2_capability_runs WHERE site_agent_id=?",
  ).bind(context.siteAgentId).first();
  assert.equal(Number(count.count), 0);
});

test("leasing revalidates the exact published NavigationTool Revision pin", async (t) => {
  const context = await seedScenario(t, "navigation-tool-lease-mismatch", {
    navigationTool: true,
  });
  const created = await createCloudRun(context);
  const staleRevision = structuredClone(context.revision);
  staleRevision.implementation.toolRef.dependencyHash =
    "tampered-after-run-creation";
  const tampered = await context.database.prepare(`
    UPDATE site_agent_v2_capability_revisions
       SET revision_json=?,updated_at=?
     WHERE id=? AND site_agent_id=?
  `).bind(
    JSON.stringify(staleRevision),
    staleRevision.updatedAt,
    staleRevision.id,
    context.siteAgentId,
  ).run();
  assert.equal(tampered.success, true);

  const leased = await leaseCloudRun(context, "navigation-tool-lease-mismatch");
  const stored = await context.store.getCapabilityRun(
    context.siteAgentId,
    created.run.id,
  );
  assert.equal(leased.lease, undefined);
  assert.equal(stored.run?.status, "failed");
  assert.equal(
    stored.run?.error?.code,
    "capability_run_navigation_tool_mismatch",
  );
});

test("creating a cloud CapabilityRun without projectId resolves the unique published Revision", async (t) => {
  const context = await seedScenario(t, "implicit-project");
  const created = await createCloudRunWithoutProject(context);

  assert.equal(created.run.projectId, context.project.id);
  assert.equal(created.run.revisionId, context.revision.id);
  assert.equal(created.run.releaseId, context.release.id);
  assert.equal(created.run.startUrl, VALIDATED_START_URL);
});

test("creating a cloud CapabilityRun without projectId fails closed when no project owns the Capability", async (t) => {
  const context = await seedScenario(t, "implicit-project-missing");
  await context.store.listCapabilityProjects(context.siteAgentId);
  const detachedProject = {
    ...context.project,
    activeCapabilityId: "capability-detached-from-release",
  };
  const updated = await context.database.prepare(`
    UPDATE site_agent_v2_capability_projects
       SET project_json=?,updated_at=?
     WHERE id=? AND site_agent_id=?
  `).bind(
    JSON.stringify(detachedProject),
    detachedProject.updatedAt,
    detachedProject.id,
    context.siteAgentId,
  ).run();
  assert.equal(updated.success, true);

  await assert.rejects(
    () => createCloudRunWithoutProject(context),
    /capability_run_project_not_found/,
  );
  const runCount = await context.database.prepare(
    "SELECT COUNT(*) AS count FROM site_agent_v2_capability_runs WHERE site_agent_id=?",
  ).bind(context.siteAgentId).first();
  assert.equal(Number(runCount.count), 0);
});

test("creating a cloud CapabilityRun without projectId rejects ambiguous project ownership", async (t) => {
  const context = await seedScenario(t, "implicit-project-ambiguous");
  await context.store.listCapabilityProjects(context.siteAgentId);
  const duplicate = {
    ...context.project,
    id: `${context.project.id}-duplicate`,
    intentKey: `${context.project.intentKey}-duplicate`,
  };
  const inserted = await context.database.prepare(`
    INSERT INTO site_agent_v2_capability_projects
      (id,site_agent_id,intent_key,stable_key,contract_fingerprint,active_revision_id,latest_revision_id,status,project_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    duplicate.id,
    context.siteAgentId,
    duplicate.intentKey,
    null,
    null,
    duplicate.activeRevisionId,
    duplicate.latestRevisionId,
    duplicate.status,
    JSON.stringify(duplicate),
    duplicate.createdAt,
    duplicate.updatedAt,
  ).run();
  assert.equal(inserted.success, true);

  await assert.rejects(
    () => createCloudRunWithoutProject(context),
    /capability_run_project_ambiguous/,
  );
  const runCount = await context.database.prepare(
    "SELECT COUNT(*) AS count FROM site_agent_v2_capability_runs WHERE site_agent_id=?",
  ).bind(context.siteAgentId).first();
  assert.equal(Number(runCount.count), 0);
});

test("creating a cloud CapabilityRun rejects a project owned by another capability", async (t) => {
  const context = await seedScenario(t, "project-mismatch", {
    activeCapabilityId: "capability-owned-by-another-project",
  });

  await assert.rejects(
    () => createCloudRun(context),
    /capability_run_project_mismatch/,
  );
});

test("creating a cloud CapabilityRun rejects an unpublished active Revision", async (t) => {
  const context = await seedScenario(t, "revision-mismatch", {
    revisionStatus: "awaiting-review",
    validationStatus: "passed",
  });

  await assert.rejects(
    () => createCloudRun(context),
    /capability_run_revision_not_published/,
  );
});

test("creating a cloud CapabilityRun rejects a Revision module outside the active Release", async (t) => {
  const context = await seedScenario(t, "module-mismatch", {
    implementationHash: "b".repeat(64),
  });

  await assert.rejects(
    () => createCloudRun(context),
    /capability_run_revision_release_mismatch/,
  );
});

test("creating a cloud CapabilityRun fails closed when its exact validation Run has no start URL evidence", async (t) => {
  const context = await seedScenario(t, "start-url-missing", {
    validatedStartUrl: "",
  });

  await assert.rejects(
    () => createCloudRun(context),
    /capability_run_start_url_missing/,
  );
});

test("relisting projects the executable module from the published Revision", async (t) => {
  const context = await seedScenario(t, "revision-owned-relist");
  const activeAfterPublication = {
    ...context.release,
    id: `${context.siteAgentId}:release:${context.release.version + 1}:active-after-publication`,
    version: context.release.version + 1,
    contentHash: "active-release-after-publication",
  };
  const advanced = await context.database.batch([
    context.database.prepare(`
      INSERT INTO site_agent_v2_releases
        (id,site_agent_id,version,content_hash,release_json,created_at)
      VALUES (?,?,?,?,?,?)
    `).bind(
      activeAfterPublication.id,
      context.siteAgentId,
      activeAfterPublication.version,
      activeAfterPublication.contentHash,
      JSON.stringify(activeAfterPublication),
      activeAfterPublication.createdAt,
    ),
    context.database.prepare(`
      UPDATE site_agent_v2_agents
         SET active_release_id=?,profile_json=?,updated_at=?
       WHERE id=? AND active_release_id=?
    `).bind(
      activeAfterPublication.id,
      JSON.stringify(activeAfterPublication.profile),
      activeAfterPublication.createdAt,
      context.siteAgentId,
      context.release.id,
    ),
  ]);
  assert.equal(advanced.every((result) => result.success), true);

  await context.store.actOnCapabilityProject(
    context.siteAgentId,
    context.project.id,
    { action: "unpublish" },
  );
  const relisted = await context.store.actOnCapabilityProject(
    context.siteAgentId,
    context.project.id,
    { action: "relist" },
  );
  const restored = relisted.release.capabilities.find(
    (item) => item.module?.contentHash === context.revision.implementation.module.contentHash,
  );

  assert.ok(restored, JSON.stringify(relisted.release.capabilities));
  assert.equal(restored?.module?.contentHash, context.revision.implementation.module.contentHash);
  assert.equal(relisted.project.id, context.project.id);
  assert.equal(relisted.project.activeCapabilityId, restored.id);
  assert.deepEqual(restored?.plans, []);
});

test("runner start resolution fails closed when a pinned CapabilityRun has a cross-origin start URL", async (t) => {
  const crossOriginStartUrl = "https://attacker.invalid/phishing";
  const context = await seedScenario(t, "start-url-cross-origin", {
    validatedStartUrl: crossOriginStartUrl,
  });
  const created = await createCloudRun(context);
  const { trustedReleaseStartUrl } = await bundledTrustedReleaseStartUrl();

  assert.equal(created.run.revisionId, context.revision.id);
  assert.equal(created.run.startUrl, crossOriginStartUrl);
  assert.throws(
    () => trustedReleaseStartUrl(
      context.release,
      created.run.startUrl,
      Boolean(created.run.revisionId),
    ),
    /capability_run_start_url_untrusted/,
  );
});

test("connected-browser launch rejects a Revision start URL outside its pinned Release origins", async (t) => {
  const context = await seedScenario(t, "connected-start-url-cross-origin", {
    navigationTool: true,
    validatedStartUrl: "https://attacker.invalid/phishing",
  });
  await assert.rejects(
    () => createConnectedRun(context),
    /capability_run_start_url_untrusted/,
  );
  const runCount = await context.database.prepare(
    "SELECT COUNT(*) AS count FROM site_agent_v2_capability_runs WHERE site_agent_id=?",
  ).bind(context.siteAgentId).first();
  const launchCount = await context.database.prepare(
    "SELECT COUNT(*) AS count FROM site_agent_v2_task_launches WHERE site_agent_id=?",
  ).bind(context.siteAgentId).first();
  assert.equal(Number(runCount.count), 0);
  assert.equal(Number(launchCount.count), 0);
});

test("leasing a CapabilityRun returns its pinned historical Release after the active Release changes", async (t) => {
  const context = await seedScenario(t, "historical-lease");
  const created = await createCloudRun(context);
  const nextRelease = {
    ...context.release,
    id: `${context.siteAgentId}:release:${context.release.version + 1}:new-active`,
    version: context.release.version + 1,
    contentHash: "next-release-hash",
    createdAt: "2026-07-30T01:02:00.000Z",
    capabilities: [{
      ...context.capability,
      name: "Capability from the new active Release",
    }],
  };
  const advanced = await context.database.batch([
    context.database.prepare(`
      INSERT INTO site_agent_v2_releases
        (id,site_agent_id,version,content_hash,release_json,created_at)
      VALUES (?,?,?,?,?,?)
    `).bind(
      nextRelease.id,
      context.siteAgentId,
      nextRelease.version,
      nextRelease.contentHash,
      JSON.stringify(nextRelease),
      nextRelease.createdAt,
    ),
    context.database.prepare(`
      UPDATE site_agent_v2_agents
         SET active_release_id=?,profile_json=?,updated_at=?
       WHERE id=?
    `).bind(
      nextRelease.id,
      JSON.stringify(nextRelease.profile),
      nextRelease.createdAt,
      context.siteAgentId,
    ),
  ]);
  assert.equal(advanced.every((result) => result.success), true);
  const activeAfterAdvance = await context.store.getActiveSiteAgentRelease(
    context.siteAgentId,
  );
  assert.equal(activeAfterAdvance.release.id, nextRelease.id);

  const registration = await context.store.registerValidationRunner({
    id: `execution-runner-${databaseSequence}`,
    name: "Capability execution runner",
    role: "interactive",
    workKinds: ["execute"],
    browsers: ["chromium"],
    maxConcurrency: 1,
  });
  const leased = await context.store.leaseRunnerWork(
    registration.runner.id,
    "interactive",
    {
      sessionId: registration.instance.sessionId,
      sessionToken: registration.sessionToken,
    },
  );

  assert.equal(leased.lease?.kind, "execute");
  assert.equal(leased.lease?.job.id, created.run.id);
  const storedHistoricalRelease = JSON.parse(JSON.stringify(context.release));
  assert.equal(leased.lease?.release.id, context.release.id);
  assert.equal(leased.lease?.release.version, context.release.version);
  assert.equal(leased.lease?.release.contentHash, context.release.contentHash);
  assert.deepEqual(leased.lease?.release.profile, storedHistoricalRelease.profile);
  assert.deepEqual(leased.lease?.release.agentConfig, storedHistoricalRelease.agentConfig);
  assert.deepEqual(leased.lease?.release.scenes, storedHistoricalRelease.scenes);
  assert.deepEqual(leased.lease?.release.operations, storedHistoricalRelease.operations);
  assert.deepEqual(leased.lease?.release.capabilities, storedHistoricalRelease.capabilities);
  assert.deepEqual(leased.lease?.capability, storedHistoricalRelease.capabilities[0]);
  assert.notEqual(leased.lease?.release.id, nextRelease.id);
});

test("leasing fails legacy cloud Runs that lack immutable execution resolution", async (t) => {
  const context = await seedScenario(t, "legacy-run-resolution");
  const run = {
    id: "capability-run-legacy-unpinned",
    siteAgentId: context.siteAgentId,
    projectId: context.project.id,
    capabilityId: context.capability.id,
    capabilityName: context.capability.name,
    mode: "run",
    environment: { kind: "cloud-browser" },
    releaseId: context.release.id,
    releaseVersion: context.release.version,
    status: "queued",
    input: {},
    steps: [],
    artifactIds: [],
    timings: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
  const inserted = await context.database.prepare(`
    INSERT INTO site_agent_v2_capability_runs
      (id,site_agent_id,project_id,capability_id,status,environment_kind,lease_expires_at,run_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).bind(
    run.id,
    run.siteAgentId,
    run.projectId,
    run.capabilityId,
    run.status,
    run.environment.kind,
    null,
    JSON.stringify(run),
    run.createdAt,
    run.updatedAt,
  ).run();
  assert.equal(inserted.success, true);
  const registration = await context.store.registerValidationRunner({
    id: `legacy-execution-runner-${databaseSequence}`,
    name: "Legacy execution guard runner",
    role: "interactive",
    workKinds: ["execute"],
    browsers: ["chromium"],
    maxConcurrency: 1,
  });

  const leased = await context.store.leaseRunnerWork(
    registration.runner.id,
    "interactive",
    {
      sessionId: registration.instance.sessionId,
      sessionToken: registration.sessionToken,
    },
  );
  const stored = await context.store.getCapabilityRun(context.siteAgentId, run.id);

  assert.equal(leased.lease, undefined);
  assert.equal(stored.run?.status, "failed");
  assert.equal(stored.run?.error?.code, "capability_run_resolution_missing");
  assert.equal(stored.run?.outcome?.code, "capability_run_resolution_missing");
});
