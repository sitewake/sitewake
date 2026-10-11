import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const NOW = "2026-07-30T08:00:00.000Z";
let databaseSequence = 0;

function projectFixture(siteAgentId, id, intentKey = "shared-intent") {
  return {
    id,
    siteAgentId,
    stableKey: `stable:${id}`,
    contractFingerprint: `contract:${id}`,
    intentKey,
    name: `Capability ${id}`,
    description: "An otherwise empty capability root.",
    goalTemplate: `Use ${id}`,
    origin: "ai-exploration",
    triggeredBy: "administrator",
    generatedBy: "ai",
    status: "building",
    stage: "design",
    kind: "task",
    structure: "atomic",
    operation: "read",
    exposure: "public",
    resultKind: "data",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: {} },
    executionRequirements: {
      authentication: "none",
      supportedEnvironments: {
        connectedBrowser: "supported",
        cloudBrowser: "supported",
        managedProfile: "unverified",
      },
      checkpoints: [],
      evidenceRefs: [],
    },
    health: {
      recentRuns: 0,
      recentSuccesses: 0,
    },
    revisionCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function bundledStore(database) {
  const databaseKey = database
    ? `__CAPABILITY_PROJECT_DELETE_D1_${databaseSequence += 1}`
    : undefined;
  if (databaseKey) globalThis[databaseKey] = database;
  try {
    const result = await build({
      entryPoints: [
        fileURLToPath(new URL("../db/site-agent-store.ts", import.meta.url)),
      ],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      plugins: databaseKey ? [{
        name: "capability-project-delete-d1",
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
      }] : [],
    });
    return await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`,
    );
  } finally {
    if (databaseKey) delete globalThis[databaseKey];
  }
}

async function memoryProject(store, suffix, intentKey) {
  const requestedSiteAgentId = `delete-memory-${suffix}`;
  const created = await store.createSiteAgent({
    id: requestedSiteAgentId,
    url: `https://${requestedSiteAgentId.toLowerCase()}.test`,
  });
  const siteAgentId = created.siteAgentId;
  const agent = globalThis.__SITEWAKE_SITE_AGENT_V2__.get(siteAgentId);
  assert.ok(agent, `memory SiteAgent ${siteAgentId} must be initialized`);
  const project = projectFixture(siteAgentId, `project-${suffix}`, intentKey);
  agent.capabilityProjects.push(project);
  return { agent, project, siteAgentId };
}

function minimalLearningJob(siteAgentId, projectId, candidateId) {
  return {
    id: `job-${projectId}`,
    siteAgentId,
    taskSessionId: `session-${projectId}`,
    sourceEpisodeId: `episode-${projectId}`,
    candidateId,
    phase: "design",
    status: "queued",
    attempts: 0,
    intentKey: "shared-intent",
    receipts: [],
    result: { projectId },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

test("memory hard delete removes only the selected empty root, never same-intent history", async () => {
  const store = await bundledStore();
  const { agent, project: retained, siteAgentId } = await memoryProject(
    store,
    "same-intent",
    "one-intent-two-contracts",
  );
  const deleted = projectFixture(
    siteAgentId,
    "project-same-intent-empty",
    retained.intentKey,
  );
  agent.capabilityProjects.push(deleted);
  agent.capabilityEvents.push({
    id: "event-retained",
    siteAgentId,
    projectId: retained.id,
    type: "design",
    actor: "ai",
    status: "info",
    title: "Retained evidence",
    summary: "Belongs only to the other strict capability root.",
    createdAt: NOW,
  });

  const retainedDetail = (
    await store.getCapabilityProjectDetail(siteAgentId, retained.id)
  ).detail;
  const deletedDetail = (
    await store.getCapabilityProjectDetail(siteAgentId, deleted.id)
  ).detail;
  assert.equal(retainedDetail.deletion.allowed, false);
  assert.equal(retainedDetail.deletion.counts.events, 1);
  assert.equal(deletedDetail.deletion.allowed, true);

  await store.actOnCapabilityProject(
    siteAgentId,
    deleted.id,
    { action: "delete" },
  );
  assert.deepEqual(
    agent.capabilityProjects.map((project) => project.id),
    [retained.id],
  );
  assert.deepEqual(
    agent.capabilityEvents.map((event) => event.id),
    ["event-retained"],
  );
  await assert.rejects(
    () => store.actOnCapabilityProject(
      siteAgentId,
      retained.id,
      { action: "delete" },
    ),
    /capability_project_delete_requires_draft/,
  );
  assert.equal(agent.capabilityEvents.length, 1);
});

test("memory deletion facts protect direct history omitted or truncated by detail projections", async () => {
  const store = await bundledStore();
  const cases = [
    {
      kind: "events",
      add(agent, project) {
        agent.capabilityEvents.push({
          id: "event-only",
          siteAgentId: project.siteAgentId,
          projectId: project.id,
          createdAt: NOW,
        });
      },
    },
    {
      kind: "capabilityRuns",
      add(agent, project) {
        agent.capabilityRuns.push({
          id: "run-only",
          siteAgentId: project.siteAgentId,
          projectId: project.id,
          capabilityId: "capability-run-only",
          createdAt: NOW,
        });
      },
    },
    {
      kind: "taskLaunches",
      add(agent, project) {
        agent.taskLaunches.push({
          id: "launch-only",
          siteAgentId: project.siteAgentId,
          projectId: project.id,
          tokenHash: "not-a-real-token",
          createdAt: NOW,
        });
      },
    },
    {
      kind: "specDocs",
      add(agent, project) {
        agent.specDocs.push({
          id: "spec-only",
          siteAgentId: project.siteAgentId,
          projectId: project.id,
          version: 1,
          createdAt: NOW,
        });
      },
    },
    {
      kind: "authoringWorkspaces",
      add(agent, project) {
        agent.authoringWorkspaces.push({
          id: "workspace-only",
          siteAgentId: project.siteAgentId,
          projectId: project.id,
          hash: "workspace-hash",
          files: [],
          createdAt: NOW,
        });
      },
    },
    {
      kind: "authoringGuidance",
      add(agent, project) {
        agent.authoringGuidance.push({
          id: "guidance-only",
          siteAgentId: project.siteAgentId,
          projectId: project.id,
          text: "Keep this history.",
          createdAt: NOW,
        });
      },
    },
    {
      kind: "suppressions",
      add(agent, project) {
        agent.capabilitySuppressions.push({
          id: "suppression-only",
          siteAgentId: project.siteAgentId,
          projectId: project.id,
          intentKey: project.intentKey,
          status: "active",
          createdAt: NOW,
        });
      },
    },
  ];

  for (const item of cases) {
    const { agent, project, siteAgentId } = await memoryProject(
      store,
      item.kind,
    );
    item.add(agent, project);
    const detail = (
      await store.getCapabilityProjectDetail(siteAgentId, project.id)
    ).detail;
    assert.equal(detail.deletion.allowed, false, item.kind);
    assert.equal(detail.deletion.counts[item.kind], 1, item.kind);
    await assert.rejects(
      () => store.actOnCapabilityProject(
        siteAgentId,
        project.id,
        { action: "delete" },
      ),
      /capability_project_delete_requires_draft/,
      item.kind,
    );
    assert.equal(
      agent.capabilityProjects.some((candidate) =>
        candidate.id === project.id),
      true,
      item.kind,
    );
  }
});

test("memory deletion facts follow exact Job ownership to candidates and execution evidence", async () => {
  const store = await bundledStore();
  const { agent, project, siteAgentId } = await memoryProject(
    store,
    "job-chain",
  );
  const candidateId = `candidate-${project.id}`;
  const job = minimalLearningJob(siteAgentId, project.id, candidateId);
  agent.learningJobs.push(job);
  agent.candidates.push({
    id: candidateId,
    siteAgentId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  agent.validationJobs.push({
    id: "validation-job-chain",
    siteAgentId,
    learningJobId: job.id,
    candidateId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  agent.browserRuns.push({
    id: "browser-run-chain",
    siteAgentId,
    learningJobId: job.id,
    candidateId,
    startedAt: NOW,
  });
  agent.artifacts.push({
    id: "artifact-chain",
    siteAgentId,
    learningJobId: job.id,
    runId: "browser-run-chain",
    createdAt: NOW,
  });
  agent.modelCalls.push({
    id: "model-chain",
    siteAgentId,
    learningJobId: job.id,
    startedAt: NOW,
  });
  agent.domReplayChunks.push({
    id: "replay-chain",
    siteAgentId,
    runId: "browser-run-chain",
    seqStart: 0,
    createdAt: NOW,
  });

  const detail = (
    await store.getCapabilityProjectDetail(siteAgentId, project.id)
  ).detail;
  for (const kind of [
    "learningJobs",
    "candidates",
    "validationJobs",
    "browserRuns",
    "artifacts",
    "modelInvocations",
    "domReplayChunks",
  ]) {
    assert.equal(detail.deletion.counts[kind], 1, kind);
  }
  await assert.rejects(
    () => store.actOnCapabilityProject(
      siteAgentId,
      project.id,
      { action: "delete" },
    ),
    /capability_project_delete_requires_draft/,
  );
  assert.equal(agent.learningJobs.length, 1);
  assert.equal(agent.candidates.length, 1);
  assert.equal(agent.browserRuns.length, 1);
});

test("archive is a reversible overlay that restores every prior capability state", async () => {
  const store = await bundledStore();
  const statuses = [
    "building",
    "awaiting-review",
    "available",
    "duplicate",
    "needs-guidance",
    "degraded",
    "unpublished",
  ];
  for (const status of statuses) {
    const { agent, project, siteAgentId } = await memoryProject(
      store,
      `archive-${status}`,
    );
    project.status = status;
    if (status === "available") {
      project.activeCapabilityId = `capability-${status}`;
    }
    const archived = await store.actOnCapabilityProject(
      siteAgentId,
      project.id,
      { action: "archive" },
    );
    assert.equal(archived.project.status, "archived", status);
    assert.equal(archived.project.archivedFromStatus, status, status);

    const restored = await store.actOnCapabilityProject(
      siteAgentId,
      project.id,
      { action: "restore" },
    );
    assert.equal(restored.project.status, status, status);
    assert.equal(restored.project.archivedFromStatus, undefined, status);
    assert.equal(
      agent.capabilityEvents.filter((event) =>
        event.projectId === project.id).length,
      2,
      status,
    );
  }
});

function hookableDatabase(rawDatabase) {
  let beforeProjectDelete;
  let beforeProjectTransition;
  function wrapStatement(statement, sql) {
    return new Proxy(statement, {
      get(target, property) {
        if (property === "__sql") return sql;
        if (property === "bind") {
          return (...values) => wrapStatement(target.bind(...values), sql);
        }
        if (property === "run") {
          return async () => {
            const hook = /^\s*DELETE FROM site_agent_v2_capability_projects/i
              .test(sql)
              ? beforeProjectDelete
              : undefined;
            beforeProjectDelete = hook ? undefined : beforeProjectDelete;
            if (hook) await hook(rawDatabase);
            return target.run();
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  const database = new Proxy(rawDatabase, {
    get(target, property) {
      if (property === "prepare") {
        return (sql) => wrapStatement(target.prepare(sql), sql);
      }
      if (property === "batch") {
        return async (statements) => {
          const transition = statements.some((statement) =>
            /UPDATE site_agent_v2_capability_projects\s+SET status=\?,project_json=\?,updated_at=\?/i
              .test(statement.__sql || ""));
          const hook = transition ? beforeProjectTransition : undefined;
          beforeProjectTransition = hook ? undefined : beforeProjectTransition;
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
    beforeDelete(hook) {
      assert.equal(beforeProjectDelete, undefined);
      beforeProjectDelete = hook;
    },
    beforeTransition(hook) {
      assert.equal(beforeProjectTransition, undefined);
      beforeProjectTransition = hook;
    },
  };
}

async function isolatedD1Database() {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: {
      DB: `capability-project-delete-${databaseSequence += 1}`,
    },
  });
  const rawDatabase = await miniflare.getD1Database("DB");
  return {
    rawDatabase,
    ...hookableDatabase(rawDatabase),
    dispose: () => miniflare.dispose(),
  };
}

async function insertD1Project(database, project) {
  const result = await database.prepare(`
    INSERT INTO site_agent_v2_capability_projects
      (id,site_agent_id,intent_key,stable_key,contract_fingerprint,
       active_revision_id,latest_revision_id,status,project_json,
       created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    project.id,
    project.siteAgentId,
    project.intentKey,
    project.stableKey,
    project.contractFingerprint,
    null,
    null,
    project.status,
    JSON.stringify(project),
    project.createdAt,
    project.updatedAt,
  ).run();
  assert.equal(result.success, true);
}

test("D1 dismisses only duplicate failures and preserves the LearningJob audit payload", async (t) => {
  const isolated = await isolatedD1Database();
  t.after(isolated.dispose);
  const store = await bundledStore(isolated.database);
  const siteAgentId = "dismiss-d1-duplicate-request";
  await store.createSiteAgent({
    id: siteAgentId,
    url: "https://dismiss-d1-duplicate-request.test",
  });
  const job = {
    id: "job-d1-duplicate-request",
    siteAgentId,
    taskSessionId: "session-d1-duplicate-request",
    sourceEpisodeId: "episode-d1-duplicate-request",
    candidateId: "candidate-d1-duplicate-request",
    phase: "design",
    status: "failed",
    attempts: 1,
    receipts: [{
      phase: "design",
      status: "failed",
      title: "Duplicate capability",
      summary: "The stable contract already exists.",
      startedAt: NOW,
      endedAt: NOW,
    }],
    failure: {
      code: "duplicate_capability",
      summary: "The stable contract already exists.",
    },
    result: {
      requestedGoal: "Read report",
      projectId: "project-existing-report",
      duplicateOf: {
        projectId: "project-existing-report",
        capabilityId: "capability-existing-report",
        name: "Read report",
      },
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
  await isolated.rawDatabase.prepare(`INSERT INTO site_agent_v2_learning_jobs
    (id,site_agent_id,task_session_id,status,result_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).bind(
    job.id,
    job.siteAgentId,
    job.taskSessionId,
    job.status,
    JSON.stringify(job),
    job.createdAt,
    job.updatedAt,
  ).run();

  const result = await store.dismissDuplicateCapabilityBuildRequest(
    siteAgentId,
    `build-request:${job.id}`,
  );
  assert.equal(result.dismissed, true);
  const stored = await isolated.rawDatabase.prepare(`SELECT status,result_json AS jobJson
    FROM site_agent_v2_learning_jobs WHERE id=?`).bind(job.id).first();
  const audit = JSON.parse(stored.jobJson);
  assert.equal(stored.status, "cancelled");
  assert.equal(audit.status, "cancelled");
  assert.deepEqual(audit.failure, job.failure);
  assert.deepEqual(audit.receipts, job.receipts);
  assert.deepEqual(audit.result, job.result);
  await assert.rejects(
    () => store.dismissDuplicateCapabilityBuildRequest(siteAgentId, `build-request:${job.id}`),
    /capability_build_request_dismiss_not_allowed/,
  );
});

test("D1 hard delete removes one empty root without touching same-intent history", async (t) => {
  const isolated = await isolatedD1Database();
  t.after(isolated.dispose);
  const store = await bundledStore(isolated.database);
  const siteAgentId = "delete-d1-same-intent";
  await store.createSiteAgent({
    id: siteAgentId,
    url: "https://delete-d1-same-intent.test",
  });
  const retained = projectFixture(
    siteAgentId,
    "project-d1-retained",
    "same-intent",
  );
  const deleted = projectFixture(
    siteAgentId,
    "project-d1-deleted",
    retained.intentKey,
  );
  await insertD1Project(isolated.rawDatabase, retained);
  await insertD1Project(isolated.rawDatabase, deleted);
  const event = {
    id: "event-d1-retained",
    siteAgentId,
    projectId: retained.id,
    type: "design",
    status: "info",
    createdAt: NOW,
  };
  const eventInsert = await isolated.rawDatabase.prepare(`
    INSERT INTO site_agent_v2_capability_events
      (id,project_id,revision_id,site_agent_id,type,status,event_json,created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).bind(
    event.id,
    retained.id,
    null,
    siteAgentId,
    event.type,
    event.status,
    JSON.stringify(event),
    NOW,
  ).run();
  assert.equal(eventInsert.success, true);

  await store.actOnCapabilityProject(
    siteAgentId,
    deleted.id,
    { action: "delete" },
  );
  const [projects, events] = await Promise.all([
    isolated.rawDatabase.prepare(`
      SELECT id FROM site_agent_v2_capability_projects
       WHERE site_agent_id=? ORDER BY id
    `).bind(siteAgentId).all(),
    isolated.rawDatabase.prepare(`
      SELECT id,project_id AS projectId FROM site_agent_v2_capability_events
       WHERE site_agent_id=?
    `).bind(siteAgentId).all(),
  ]);
  assert.deepEqual(
    projects.results.map((row) => row.id),
    [retained.id],
  );
  assert.deepEqual(events.results, [{
    id: event.id,
    projectId: retained.id,
  }]);
});

test("D1 root delete rechecks all history atomically and preserves a concurrent event", async (t) => {
  const isolated = await isolatedD1Database();
  t.after(isolated.dispose);
  const store = await bundledStore(isolated.database);
  const siteAgentId = "delete-d1-race";
  await store.createSiteAgent({
    id: siteAgentId,
    url: "https://delete-d1-race.test",
  });
  const project = projectFixture(siteAgentId, "project-d1-race");
  await insertD1Project(isolated.rawDatabase, project);
  const preflight = (
    await store.getCapabilityProjectDetail(siteAgentId, project.id)
  ).detail;
  assert.equal(preflight.deletion.allowed, true);

  isolated.beforeDelete(async (database) => {
    const event = {
      id: "event-concurrent",
      siteAgentId,
      projectId: project.id,
      type: "design",
      actor: "ai",
      status: "info",
      title: "Arrived after preflight",
      summary: "Must fence root deletion.",
      createdAt: NOW,
    };
    const inserted = await database.prepare(`
      INSERT INTO site_agent_v2_capability_events
        (id,project_id,revision_id,site_agent_id,type,status,event_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).bind(
      event.id,
      project.id,
      null,
      siteAgentId,
      event.type,
      event.status,
      JSON.stringify(event),
      NOW,
    ).run();
    assert.equal(inserted.success, true);
  });

  await assert.rejects(
    () => store.actOnCapabilityProject(
      siteAgentId,
      project.id,
      { action: "delete" },
    ),
    /capability_project_delete_requires_draft/,
  );
  const [projectRow, eventRow] = await Promise.all([
    isolated.rawDatabase.prepare(`
      SELECT id FROM site_agent_v2_capability_projects WHERE id=?
    `).bind(project.id).first(),
    isolated.rawDatabase.prepare(`
      SELECT id FROM site_agent_v2_capability_events WHERE id=?
    `).bind("event-concurrent").first(),
  ]);
  assert.equal(projectRow.id, project.id);
  assert.equal(eventRow.id, "event-concurrent");
});

test("D1 RFC and proposal history block without being deleted by intent", async (t) => {
  const isolated = await isolatedD1Database();
  t.after(isolated.dispose);
  const store = await bundledStore(isolated.database);
  const siteAgentId = "delete-d1-proposal";
  await store.createSiteAgent({
    id: siteAgentId,
    url: "https://delete-d1-proposal.test",
  });
  const project = projectFixture(siteAgentId, "project-d1-proposal");
  await insertD1Project(isolated.rawDatabase, project);
  const rfc = {
    id: "rfc-delete-history",
    siteAgentId,
    intentKey: project.intentKey,
    version: 1,
    createdAt: NOW,
  };
  const proposal = {
    id: "proposal-delete-history",
    rfcId: rfc.id,
    status: "proposed",
    createdAt: NOW,
  };
  const inserted = await isolated.rawDatabase.batch([
    isolated.rawDatabase.prepare(`
      INSERT INTO site_agent_v2_capability_rfcs
        (id,site_agent_id,intent_key,version,rfc_json,created_at)
      VALUES (?,?,?,?,?,?)
    `).bind(
      rfc.id,
      siteAgentId,
      project.intentKey,
      rfc.version,
      JSON.stringify(rfc),
      NOW,
    ),
    isolated.rawDatabase.prepare(`
      INSERT INTO site_agent_v2_contract_proposals
        (id,site_agent_id,rfc_id,status,proposal_json,created_at)
      VALUES (?,?,?,?,?,?)
    `).bind(
      proposal.id,
      siteAgentId,
      rfc.id,
      proposal.status,
      JSON.stringify(proposal),
      NOW,
    ),
  ]);
  assert.equal(inserted.every((result) => result.success), true);

  const detail = (
    await store.getCapabilityProjectDetail(siteAgentId, project.id)
  ).detail;
  assert.equal(detail.deletion.counts.rfcs, 1);
  assert.equal(detail.deletion.counts.contractProposals, 1);
  assert.equal(detail.deletion.allowed, false);
  await assert.rejects(
    () => store.actOnCapabilityProject(
      siteAgentId,
      project.id,
      { action: "delete" },
    ),
    /capability_project_delete_requires_draft/,
  );
  const counts = await Promise.all([
    isolated.rawDatabase.prepare(`
      SELECT COUNT(*) AS total FROM site_agent_v2_capability_rfcs
    `).first(),
    isolated.rawDatabase.prepare(`
      SELECT COUNT(*) AS total FROM site_agent_v2_contract_proposals
    `).first(),
  ]);
  assert.deepEqual(counts.map((row) => Number(row.total)), [1, 1]);
});

test("D1 archive and restore use project snapshot CAS and never emit an event for a lost race", async (t) => {
  const isolated = await isolatedD1Database();
  t.after(isolated.dispose);
  const store = await bundledStore(isolated.database);
  const siteAgentId = "archive-d1-race";
  await store.createSiteAgent({
    id: siteAgentId,
    url: "https://archive-d1-race.test",
  });
  const project = projectFixture(siteAgentId, "project-archive-d1-race");
  await insertD1Project(isolated.rawDatabase, project);

  async function concurrentEdit(label) {
    const row = await isolated.rawDatabase.prepare(`
      SELECT project_json AS projectJson
        FROM site_agent_v2_capability_projects
       WHERE id=? AND site_agent_id=?
    `).bind(project.id, siteAgentId).first();
    const current = JSON.parse(row.projectJson);
    const updatedAt = label === "archive"
      ? "2026-07-30T08:01:00.000Z"
      : "2026-07-30T08:02:00.000Z";
    const changed = {
      ...current,
      description: `Concurrent ${label} edit`,
      updatedAt,
    };
    const result = await isolated.rawDatabase.prepare(`
      UPDATE site_agent_v2_capability_projects
         SET project_json=?,updated_at=?
       WHERE id=? AND site_agent_id=?
    `).bind(
      JSON.stringify(changed),
      updatedAt,
      project.id,
      siteAgentId,
    ).run();
    assert.equal(result.success, true);
  }

  isolated.beforeTransition(() => concurrentEdit("archive"));
  await assert.rejects(
    () => store.actOnCapabilityProject(
      siteAgentId,
      project.id,
      { action: "archive" },
    ),
    /capability_project_conflict/,
  );
  let row = await isolated.rawDatabase.prepare(`
    SELECT status,project_json AS projectJson
      FROM site_agent_v2_capability_projects
     WHERE id=? AND site_agent_id=?
  `).bind(project.id, siteAgentId).first();
  assert.equal(row.status, "building");
  assert.equal(JSON.parse(row.projectJson).description, "Concurrent archive edit");
  let events = await isolated.rawDatabase.prepare(`
    SELECT COUNT(*) AS total FROM site_agent_v2_capability_events
     WHERE project_id=? AND site_agent_id=?
  `).bind(project.id, siteAgentId).first();
  assert.equal(Number(events.total), 0);

  const archived = await store.actOnCapabilityProject(
    siteAgentId,
    project.id,
    { action: "archive" },
  );
  assert.equal(archived.project.status, "archived");

  isolated.beforeTransition(() => concurrentEdit("restore"));
  await assert.rejects(
    () => store.actOnCapabilityProject(
      siteAgentId,
      project.id,
      { action: "restore" },
    ),
    /capability_project_conflict/,
  );
  row = await isolated.rawDatabase.prepare(`
    SELECT status,project_json AS projectJson
      FROM site_agent_v2_capability_projects
     WHERE id=? AND site_agent_id=?
  `).bind(project.id, siteAgentId).first();
  assert.equal(row.status, "archived");
  assert.equal(JSON.parse(row.projectJson).description, "Concurrent restore edit");
  events = await isolated.rawDatabase.prepare(`
    SELECT COUNT(*) AS total FROM site_agent_v2_capability_events
     WHERE project_id=? AND site_agent_id=?
  `).bind(project.id, siteAgentId).first();
  assert.equal(Number(events.total), 1, "only the successful archive event exists");

  const restored = await store.actOnCapabilityProject(
    siteAgentId,
    project.id,
    { action: "restore" },
  );
  assert.equal(restored.project.status, "building");
  events = await isolated.rawDatabase.prepare(`
    SELECT COUNT(*) AS total FROM site_agent_v2_capability_events
     WHERE project_id=? AND site_agent_id=?
  `).bind(project.id, siteAgentId).first();
  assert.equal(Number(events.total), 2);
});
