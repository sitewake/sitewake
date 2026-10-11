import { getD1Binding, type D1DatabaseLike } from "./index";
import { ensureSiteAgentV2Schema } from "./site-agent-schema";
import {
  claimRunnerLease,
  completeRunnerLease,
  getRunnerLeaseMirror,
} from "./runner-control-store";
import {
  SITE_AGENT_SCHEMA_VERSION,
  stableHash,
  type BrowserRun,
  type CapabilityRevision,
  type CapabilityRevisionImplementation,
  type JsonSchema,
  type JsonValue,
  type KnowledgeCandidate,
  type LearningJob,
  type LegacyRunnerLeaseRef,
  type OutcomeReceipt,
  type PageSnapshot,
  type ProgramModuleRef,
  type RunnerLease,
  type SiteAgentReleaseV2,
  type TaskEpisode,
  type ValidationJob,
} from "../lib/site-knowledge/protocol";
import {
  knowledgeRevisionOf,
  rehydrateReleaseKnowledge,
  releaseEmbedsKnowledge,
  type SiteKnowledge,
} from "../lib/site-knowledge/knowledge-model";
import type {
  CompleteRunnerLeaseInput,
  RunnerLeaseRecord,
  RunnerWorkKind,
} from "../lib/runner-control/protocol";

export type CapabilityTaskRunnerQueue = "any" | "interactive" | "background" | "author" | "validate" | "crawl";

type CapabilityTaskType = "generate" | "repair" | "validate";
type CapabilityTaskStage = "queued" | "author" | "validate" | "review" | "publish" | "complete";

type TaskRow = {
  id: string;
  siteAgentId: string;
  proposalId: string | null;
  capabilityId: string | null;
  capabilityVersionId: string | null;
  type: CapabilityTaskType;
  status: string;
  stage: CapabilityTaskStage;
  taskJson: string;
  resultJson: string;
  evidenceJson: string;
  errorJson: string | null;
  runnerId: string | null;
  runnerSessionId: string | null;
  runnerLeaseId: string | null;
  runnerLeaseFence: number | string | null;
  runnerLeaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type CapabilityRow = {
  id: string;
  siteAgentId: string;
  intentKey: string;
  name: string;
  description: string;
  goalTemplate: string;
  contractJson: string;
  capabilityJson: string;
  updatedAt: string;
};

type VersionRow = {
  id: string;
  siteAgentId: string;
  capabilityId: string;
  version: number | string;
  implementationJson: string;
  validationJson: string;
  versionJson: string;
  createdAt: string;
  updatedAt: string;
};

type TaskBundle = {
  task: TaskRow;
  capability: CapabilityRow;
  version: VersionRow;
  release: SiteAgentReleaseV2;
};

type RunnerCompletionReceipt = {
  payloadHash: string;
  response: CapabilityTaskCompletionResult;
};

export type CapabilityTaskCompletionResult = {
  taskId: string;
  status: string;
  stage: CapabilityTaskStage;
  runId: string;
  leaseStatus: "completed" | "failed";
};

type CapabilityTaskControl = Omit<CompleteRunnerLeaseInput, "status" | "result">;

function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; }
  catch { return fallback; }
}

function record(value: unknown): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function changes(result: { meta?: Record<string, unknown> }) {
  return Number(result.meta?.changes || 0);
}

async function all<T>(database: D1DatabaseLike, sql: string, values: unknown[] = []) {
  const result = await database.prepare(sql).bind(...values).all<T>();
  if (!result.success) throw new Error(result.error || "capability_task_runner_query_failed");
  return result.results || [];
}

async function taskById(database: D1DatabaseLike, taskId: string) {
  const rows = await all<TaskRow>(database, `SELECT id,site_agent_id AS siteAgentId,proposal_id AS proposalId,
    capability_id AS capabilityId,capability_version_id AS capabilityVersionId,type,status,stage,
    task_json AS taskJson,result_json AS resultJson,evidence_json AS evidenceJson,error_json AS errorJson,
    runner_id AS runnerId,runner_session_id AS runnerSessionId,runner_lease_id AS runnerLeaseId,
    runner_lease_fence AS runnerLeaseFence,runner_lease_expires_at AS runnerLeaseExpiresAt,
    created_at AS createdAt,updated_at AS updatedAt
    FROM site_agent_v2_capability_tasks WHERE id=? LIMIT 1`, [taskId]);
  return rows[0];
}

export function capabilityTaskWorkKind(
  task: Pick<TaskRow, "type" | "stage">,
): Extract<RunnerWorkKind, "author" | "validate"> | undefined {
  if (task.stage === "validate" || (task.type === "validate" && task.stage === "queued")) return "validate";
  if ((task.type === "generate" || task.type === "repair")
    && (task.stage === "queued" || task.stage === "author")) return "author";
  return undefined;
}

export function capabilityTaskCompletionState(
  type: CapabilityTaskType,
  workKind: Extract<RunnerWorkKind, "author" | "validate">,
  passed: boolean,
): { status: string; stage: CapabilityTaskStage } {
  if (!passed) return { status: "failed", stage: workKind };
  if (workKind === "author") return { status: "queued", stage: "validate" };
  if (type === "validate") return { status: "completed", stage: "complete" };
  return { status: "awaiting-review", stage: "review" };
}

function queueAccepts(queue: CapabilityTaskRunnerQueue, workKind: RunnerWorkKind) {
  if (queue === "interactive" || queue === "crawl") return false;
  if (queue === "author") return workKind === "author";
  if (queue === "validate") return workKind === "validate";
  return workKind === "author" || workKind === "validate";
}

function inputSchema(contract: Record<string, JsonValue>, key: "inputSchema" | "outputSchema") {
  const value = contract[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonSchema
    : { type: "object", properties: {}, required: [] } satisfies JsonSchema;
}

function moduleRef(implementation: CapabilityRevisionImplementation | undefined): ProgramModuleRef | undefined {
  if (!implementation) return undefined;
  if (implementation.kind === "module") return implementation.module;
  if (implementation.kind === "program") return implementation.moduleRef;
  return undefined;
}

function schemaFields(schema: JsonSchema, input: Record<string, JsonValue>) {
  return Object.entries(schema.properties || {}).flatMap(([id, property]) => {
    if (!property || !["string", "number", "boolean"].includes(property.type || "")) return [];
    return [{
      id,
      name: id,
      type: property.type as "string" | "number" | "boolean",
      value: input[id],
    }];
  });
}

function outputFields(schema: JsonSchema) {
  return Object.entries(schema.properties || {}).map(([id, property]) => ({
    id,
    name: id,
    type: (["string", "number", "boolean", "object", "array"].includes(property.type || "")
      ? property.type
      : "string") as "string" | "number" | "boolean" | "object" | "array",
    description: property.description,
    source: "extracted" as const,
    importance: (schema.required || []).includes(id) ? "core" as const : "optional" as const,
  }));
}

function startUrlFor(bundle: Omit<TaskBundle, "release"> & { release: SiteAgentReleaseV2 }) {
  const result = record(json<unknown>(bundle.task.resultJson, {}));
  const evidence = record(json<unknown>(bundle.task.evidenceJson, {}));
  const validation = record(json<unknown>(bundle.version.validationJson, {}));
  const candidates = [
    result.authoringStartUrl,
    result.startUrl,
    evidence.startUrl,
    validation.startUrl,
    bundle.release.profile.entryUrl,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
    } catch { /* try the next explicit entry point */ }
  }
  throw new Error("capability_task_start_url_missing");
}

function syntheticSnapshot(taskId: string, url: string, at: string): PageSnapshot {
  return {
    id: `${taskId}:snapshot`,
    sessionId: `${taskId}:session`,
    documentId: `${taskId}:document`,
    sequence: 1,
    url,
    title: "",
    heading: "",
    visibleText: "",
    links: [],
    capturedAt: at,
  };
}

function candidateFor(bundle: TaskBundle): KnowledgeCandidate {
  const result = record(json<unknown>(bundle.task.resultJson, {}));
  const authored = result.authoredCandidate;
  if (authored && typeof authored === "object" && !Array.isArray(authored)) {
    return authored as unknown as KnowledgeCandidate;
  }
  const contract = record(json<unknown>(bundle.capability.contractJson, {}));
  const metadata = record(json<unknown>(bundle.capability.capabilityJson, {}));
  const implementation = json<CapabilityRevisionImplementation | undefined>(bundle.version.implementationJson, undefined);
  const input = record(result.input);
  const goal = typeof result.requestedGoal === "string" ? result.requestedGoal : bundle.capability.goalTemplate;
  const inputs = inputSchema(contract, "inputSchema");
  const outputs = inputSchema(contract, "outputSchema");
  const releasedCapability = bundle.release.capabilities.find((item) => item.id === bundle.capability.id);
  return {
    id: `${bundle.task.id}:candidate`,
    siteAgentId: bundle.task.siteAgentId,
    normalizedGoal: goal.normalize("NFKC").trim().toLowerCase(),
    baseReleaseVersion: bundle.release.version,
    scenes: bundle.release.scenes,
    targets: bundle.release.targets,
    operations: bundle.release.operations,
    capability: {
      ...releasedCapability,
      id: bundle.capability.id,
      kind: metadata.kind === "navigation" ? "navigation" : "task",
      resultKind: metadata.resultKind === "data" || metadata.resultKind === "action" ? metadata.resultKind : "page",
      exposure: metadata.exposure === "internal" ? "internal" : "public",
      name: bundle.capability.name,
      description: bundle.capability.description,
      normalizedGoal: goal.normalize("NFKC").trim().toLowerCase(),
      goalTemplate: bundle.capability.goalTemplate,
      aliases: releasedCapability?.aliases || [],
      inputs,
      outputs,
      module: moduleRef(implementation) || releasedCapability?.module,
      outcomes: releasedCapability?.outcomes || [],
      plans: releasedCapability?.plans || [],
      sourceEpisodeIds: releasedCapability?.sourceEpisodeIds || [],
      confidence: 1,
      status: "learning",
      updatedAt: bundle.capability.updatedAt,
    },
    validation: { status: "pending", attempts: 0, successfulReplays: 0, requiredReplays: 1 },
    authoring: {
      stage: moduleRef(implementation) ? "authored" : "designed",
      reusableTrace: false,
      intentKey: bundle.capability.intentKey,
      capabilityKind: metadata.kind === "navigation" ? "navigation" : "task",
      reason: typeof result.analysis === "string" ? result.analysis : undefined,
      goalTemplate: bundle.capability.goalTemplate,
      requiredInputs: schemaFields(inputs, input),
      resultFields: outputFields(outputs),
    },
    sourceEpisodeIds: [],
    createdAt: bundle.task.createdAt,
    updatedAt: bundle.task.updatedAt,
  };
}

function validationRelease(bundle: TaskBundle, candidate: KnowledgeCandidate) {
  const merge = <T extends { id: string }>(base: T[], additions: T[]) => {
    const ids = new Set(additions.map((item) => item.id));
    return [...base.filter((item) => !ids.has(item.id)), ...additions];
  };
  const operations = candidate.operations.map((operation) => ({
    ...operation,
    status: "verified" as const,
  }));
  const release = {
    ...bundle.release,
    scenes: merge(bundle.release.scenes, candidate.scenes),
    targets: merge(bundle.release.targets, candidate.targets),
    operations: merge(bundle.release.operations, operations),
    capabilities: merge(bundle.release.capabilities, [candidate.capability]),
    outcomes: merge(bundle.release.outcomes, candidate.capability.outcomes),
  };
  return { ...release, contentHash: stableHash(JSON.stringify(release)) };
}

function legacyLease(grant: { lease: RunnerLeaseRecord; token: string }): LegacyRunnerLeaseRef {
  return {
    runnerId: grant.lease.runnerId,
    token: grant.token,
    leasedAt: grant.lease.leasedAt,
    expiresAt: grant.lease.expiresAt,
    leaseId: grant.lease.id,
    fence: grant.lease.fence,
    runnerSessionId: grant.lease.runnerSessionId,
  };
}

function authorLease(bundle: TaskBundle, candidate: KnowledgeCandidate, owned: LegacyRunnerLeaseRef): RunnerLease {
  const result = record(json<unknown>(bundle.task.resultJson, {}));
  const input = record(result.input);
  const goal = typeof result.requestedGoal === "string" ? result.requestedGoal : bundle.capability.goalTemplate;
  const at = new Date().toISOString();
  const startUrl = startUrlFor(bundle);
  const snapshot = syntheticSnapshot(bundle.task.id, startUrl, at);
  const outcome: OutcomeReceipt = {
    status: "success",
    code: "capability_task_authoring_evidence",
    summary: "Capability Task authoring evidence",
    evaluatedAt: at,
    evidence: { source: "capability-task" },
  };
  const episode: TaskEpisode = {
    schemaVersion: SITE_AGENT_SCHEMA_VERSION,
    id: `${bundle.task.id}:episode`,
    siteAgentId: bundle.task.siteAgentId,
    taskSessionId: `${bundle.task.id}:session`,
    browserSessionId: `${bundle.task.id}:browser`,
    documentId: snapshot.documentId,
    mode: "author-request",
    goal,
    normalizedGoal: candidate.normalizedGoal,
    input,
    startedAt: bundle.task.createdAt,
    endedAt: at,
    releaseId: bundle.release.id,
    capabilityId: bundle.capability.id,
    candidateId: candidate.id,
    startSnapshot: snapshot,
    endSnapshot: snapshot,
    transitions: [],
    outcome,
  };
  const job: LearningJob = {
    id: bundle.task.id,
    siteAgentId: bundle.task.siteAgentId,
    taskSessionId: episode.taskSessionId,
    sourceEpisodeId: episode.id,
    candidateId: candidate.id,
    phase: "author",
    status: "leased",
    attempts: json<{ attempts?: unknown[] }>(bundle.task.taskJson, {}).attempts?.length || 1,
    intentKey: bundle.capability.intentKey,
    goalTemplate: bundle.capability.goalTemplate,
    receipts: [],
    lease: owned,
    result: {
      ...result,
      source: "capability-task",
      capabilityTaskId: bundle.task.id,
      authoringStartUrl: startUrl,
    },
    createdAt: bundle.task.createdAt,
    updatedAt: at,
  };
  return { kind: "author", job, candidate, episode, release: bundle.release };
}

function validateLease(bundle: TaskBundle, candidate: KnowledgeCandidate, owned: LegacyRunnerLeaseRef): RunnerLease {
  const result = record(json<unknown>(bundle.task.resultJson, {}));
  const validation = record(json<unknown>(bundle.version.validationJson, {}));
  const input = Object.keys(record(validation.input)).length ? record(validation.input) : record(result.input);
  const at = new Date().toISOString();
  const release = validationRelease(bundle, candidate);
  const job: ValidationJob = {
    id: bundle.task.id,
    learningJobId: bundle.task.id,
    siteAgentId: bundle.task.siteAgentId,
    candidateId: candidate.id,
    capabilityId: bundle.capability.id,
    baseReleaseVersion: release.version,
    status: "leased",
    validationCase: {
      id: `${bundle.task.id}:validation-case`,
      name: `Validate ${bundle.capability.name}`,
      input,
      inputSource: "human",
      startUrl: startUrlFor(bundle),
      expectedStatuses: ["success"],
      effect: "read-only",
    },
    attempt: json<{ attempts?: unknown[] }>(bundle.task.taskJson, {}).attempts?.length || 1,
    maxAttempts: 3,
    lease: owned,
    createdAt: bundle.task.createdAt,
    updatedAt: at,
  };
  const learningJob: LearningJob = {
    id: bundle.task.id,
    siteAgentId: bundle.task.siteAgentId,
    taskSessionId: `${bundle.task.id}:session`,
    sourceEpisodeId: `${bundle.task.id}:episode`,
    candidateId: candidate.id,
    phase: "validate",
    status: "running",
    attempts: job.attempt,
    receipts: [],
    lease: owned,
    result: { ...result, source: "capability-task", capabilityTaskId: bundle.task.id },
    createdAt: bundle.task.createdAt,
    updatedAt: at,
  };
  const implementation = json<CapabilityRevisionImplementation | undefined>(bundle.version.implementationJson, undefined);
  const revision: CapabilityRevision = {
    id: bundle.version.id,
    projectId: `capability-task:${bundle.task.id}`,
    siteAgentId: bundle.task.siteAgentId,
    number: Number(bundle.version.version),
    status: "building",
    stage: "validate",
    baseReleaseVersion: release.version,
    implementationReleaseId: release.id,
    implementationReleaseVersion: release.version,
    candidateId: candidate.id,
    learningJobId: bundle.task.id,
    parameterizationDecisions: [],
    implementation,
    validation: { status: "running", input, startUrl: job.validationCase.startUrl },
    guidanceIds: [],
    createdAt: bundle.version.createdAt,
    updatedAt: at,
  };
  return { kind: "validate", job, learningJob, candidate, release, revision };
}

async function releaseForTask(database: D1DatabaseLike, task: TaskRow, version: VersionRow) {
  const result = record(json<unknown>(task.resultJson, {}));
  const evidence = record(json<unknown>(task.evidenceJson, {}));
  const versionMeta = record(json<unknown>(version.versionJson, {}));
  const requestedId = [result.baseReleaseId, evidence.baseReleaseId, versionMeta.sourceReleaseId]
    .find((value): value is string => typeof value === "string" && Boolean(value));
  const requestedVersion = [result.baseReleaseVersion, evidence.baseReleaseVersion, versionMeta.sourceReleaseVersion]
    .find((value): value is number => typeof value === "number" && Number.isSafeInteger(value));
  const rows = requestedId
    ? await all<{ releaseJson: string }>(database, `SELECT release_json AS releaseJson
        FROM site_agent_v2_releases WHERE site_agent_id=? AND id=? LIMIT 1`, [task.siteAgentId, requestedId])
    : requestedVersion !== undefined
      ? await all<{ releaseJson: string }>(database, `SELECT release_json AS releaseJson
          FROM site_agent_v2_releases WHERE site_agent_id=? AND version=? LIMIT 1`, [task.siteAgentId, requestedVersion])
      : await all<{ releaseJson: string }>(database, `SELECT releases.release_json AS releaseJson
          FROM site_agent_v2_agents agents JOIN site_agent_v2_releases releases
            ON releases.id=agents.active_release_id AND releases.site_agent_id=agents.id
          WHERE agents.id=? LIMIT 1`, [task.siteAgentId]);
  if (!rows[0]) throw new Error("capability_task_release_missing");
  const release = json<SiteAgentReleaseV2 | undefined>(rows[0].releaseJson, undefined);
  if (!release || release.siteAgentId !== task.siteAgentId) throw new Error("capability_task_release_invalid");
  if (requestedVersion !== undefined && release.version !== requestedVersion) throw new Error("capability_task_release_version_mismatch");
  // Phase C: releases may be stored slim (scenes/links in site_agent_v2_knowledge,
  // release keeps only knowledgeRevision). The capability task bundle reads
  // release.scenes, so rehydrate structure here at the load boundary. No-op for an
  // embedded release. This is the sole capability-center touch: a load-boundary
  // rehydrate only — no capability logic changes.
  return hydrateTaskRelease(database, task.siteAgentId, release);
}

/**
 * Fill a loaded release's `scenes`/`linkReferences` back from the knowledge table
 * when it was stored slim. Embedded releases (or an un-migrated DB with no
 * knowledge row) are returned untouched — we never invent empty structure.
 */
async function hydrateTaskRelease(
  database: D1DatabaseLike,
  siteAgentId: string,
  release: SiteAgentReleaseV2,
): Promise<SiteAgentReleaseV2> {
  if (releaseEmbedsKnowledge(release)) return release;
  const revision = knowledgeRevisionOf(release);
  const rows = await all<{ knowledgeJson: string }>(
    database,
    `SELECT knowledge_json AS knowledgeJson FROM site_agent_v2_knowledge WHERE site_agent_id=? AND version=? LIMIT 1`,
    [siteAgentId, revision],
  );
  const knowledge = rows[0] ? json<SiteKnowledge | undefined>(rows[0].knowledgeJson, undefined) : undefined;
  if (!knowledge) return release;
  return rehydrateReleaseKnowledge({ ...release, knowledgeRevision: revision }, knowledge);
}

async function loadBundle(database: D1DatabaseLike, task: TaskRow): Promise<TaskBundle> {
  if (!task.capabilityId || !task.capabilityVersionId) throw new Error("capability_task_materialization_missing");
  const [capabilities, versions] = await Promise.all([
    all<CapabilityRow>(database, `SELECT id,site_agent_id AS siteAgentId,intent_key AS intentKey,name,description,
      goal_template AS goalTemplate,contract_json AS contractJson,capability_json AS capabilityJson,updated_at AS updatedAt
      FROM site_agent_v2_capabilities WHERE id=? AND site_agent_id=? AND deleted_at IS NULL LIMIT 1`,
    [task.capabilityId, task.siteAgentId]),
    all<VersionRow>(database, `SELECT id,site_agent_id AS siteAgentId,capability_id AS capabilityId,version,
      implementation_json AS implementationJson,validation_json AS validationJson,version_json AS versionJson,
      created_at AS createdAt,updated_at AS updatedAt FROM site_agent_v2_capability_versions
      WHERE id=? AND site_agent_id=? AND capability_id=? LIMIT 1`,
    [task.capabilityVersionId, task.siteAgentId, task.capabilityId]),
  ]);
  if (!capabilities[0] || !versions[0]) throw new Error("capability_task_materialization_missing");
  return {
    task,
    capability: capabilities[0],
    version: versions[0],
    release: await releaseForTask(database, task, versions[0]),
  };
}

function claimableTaskRows(database: D1DatabaseLike, now: string) {
  return all<TaskRow>(database, `SELECT id,site_agent_id AS siteAgentId,proposal_id AS proposalId,
    capability_id AS capabilityId,capability_version_id AS capabilityVersionId,type,status,stage,
    task_json AS taskJson,result_json AS resultJson,evidence_json AS evidenceJson,error_json AS errorJson,
    runner_id AS runnerId,runner_session_id AS runnerSessionId,runner_lease_id AS runnerLeaseId,
    runner_lease_fence AS runnerLeaseFence,runner_lease_expires_at AS runnerLeaseExpiresAt,
    created_at AS createdAt,updated_at AS updatedAt FROM site_agent_v2_capability_tasks
    WHERE (status='queued' OR (status='running' AND runner_lease_expires_at<=?))
      AND ((type IN ('generate','repair') AND stage IN ('queued','author'))
        OR stage='validate' OR (type='validate' AND stage='queued'))
    ORDER BY created_at,id LIMIT 100`, [now]);
}

function placementMiss(error: unknown) {
  return /runner_(?:placement_|work_already_leased)/.test(error instanceof Error ? error.message : String(error));
}

async function releaseClaim(
  control: { runnerId: string; runnerSessionId?: string; sessionToken?: string },
  grant: { lease: RunnerLeaseRecord; token: string },
  reason: string,
) {
  await completeRunnerLease({
    runnerId: control.runnerId,
    runnerSessionId: control.runnerSessionId,
    sessionToken: control.sessionToken,
    legacy: !control.sessionToken,
    leaseId: grant.lease.id,
    token: grant.token,
    fence: grant.lease.fence,
    status: "released",
    result: { reason },
  }).catch(() => undefined);
}

export async function leaseCapabilityTaskWork(
  runnerId: string,
  queue: CapabilityTaskRunnerQueue,
  control: { sessionId?: string; sessionToken?: string },
): Promise<{ lease?: RunnerLease; persistence: "memory" | "d1" }> {
  if (queue === "interactive" || queue === "crawl") return { persistence: "d1" };
  const database = getD1Binding();
  if (!database) return { persistence: "memory" };
  await ensureSiteAgentV2Schema(database);
  const now = new Date().toISOString();
  for (const task of await claimableTaskRows(database, now)) {
    const workKind = capabilityTaskWorkKind(task);
    if (!workKind || !queueAccepts(queue, workKind)) continue;
    let bundle: TaskBundle;
    try { bundle = await loadBundle(database, task); }
    catch { continue; }
    let grant: Awaited<ReturnType<typeof claimRunnerLease<{ taskId: string }>>>;
    try {
      grant = await claimRunnerLease({
        runnerId,
        runnerSessionId: control.sessionId,
        sessionToken: control.sessionToken,
        legacy: !control.sessionToken,
        workload: { kind: "capability-task", id: task.id, siteAgentId: task.siteAgentId },
        workKind,
        work: { taskId: task.id },
        ttlMs: control.sessionToken ? 120_000 : 15 * 60_000,
      });
    } catch (error) {
      if (placementMiss(error)) continue;
      throw error;
    }
    const taskMeta = json<{ attempts?: Array<Record<string, unknown>> }>(task.taskJson, {});
    const attempts = [...(Array.isArray(taskMeta.attempts) ? taskMeta.attempts : [])];
    const previous = attempts.at(-1);
    if (previous?.status === "running") {
      attempts[attempts.length - 1] = {
        ...previous,
        status: "failed",
        endedAt: now,
        error: { code: "runner_lease_expired", summary: "Previous Runner lease expired." },
      };
    }
    attempts.push({
      number: attempts.length + 1,
      startedAt: grant.lease.leasedAt,
      status: "running",
      runnerId,
      workKind,
      leaseFence: grant.lease.fence,
    });
    const taskJson = JSON.stringify({ ...taskMeta, attempts });
    const claimed = await database.prepare(`UPDATE site_agent_v2_capability_tasks SET
      status='running',stage=?,task_json=?,runner_id=?,runner_session_id=?,runner_lease_id=?,
      runner_lease_fence=?,runner_lease_expires_at=?,updated_at=? WHERE id=? AND site_agent_id=?
      AND stage=? AND updated_at=? AND (status='queued' OR (status='running' AND runner_lease_expires_at<=?))`)
      .bind(workKind, taskJson, runnerId, grant.lease.runnerSessionId, grant.lease.id, grant.lease.fence,
        grant.lease.expiresAt, grant.lease.updatedAt, task.id, task.siteAgentId, task.stage, task.updatedAt, now).run();
    if (!claimed.success || !changes(claimed)) {
      await releaseClaim({ runnerId, runnerSessionId: control.sessionId, sessionToken: control.sessionToken }, grant, "capability_task_claim_lost");
      continue;
    }
    bundle = { ...bundle, task: { ...task, status: "running", stage: workKind, taskJson, updatedAt: grant.lease.updatedAt } };
    const candidate = candidateFor(bundle);
    const owned = legacyLease(grant);
    return {
      lease: workKind === "author"
        ? authorLease(bundle, candidate, owned)
        : validateLease(bundle, candidate, owned),
      persistence: "d1",
    };
  }
  return { persistence: "d1" };
}

async function capabilityTaskLease(control: CapabilityTaskControl) {
  const mirror = await getRunnerLeaseMirror(control);
  if (mirror.lease.workload.kind !== "capability-task") throw new Error("capability_task_lease_required");
  return mirror.lease;
}

function assertRunMatchesLease(run: BrowserRun, lease: RunnerLeaseRecord) {
  if (run.learningJobId !== lease.workload.id) throw new Error("capability_task_browser_run_mismatch");
  if (lease.workKind === "author" && (run.mode !== "author" || run.validationJobId)) {
    throw new Error("capability_task_browser_run_mode_mismatch");
  }
  if (lease.workKind === "validate" && (run.mode !== "validate" || run.validationJobId !== lease.workload.id)) {
    throw new Error("capability_task_browser_run_mode_mismatch");
  }
}

export async function startCapabilityTaskBrowserRun(control: CapabilityTaskControl, run: BrowserRun) {
  const database = getD1Binding();
  if (!database) throw new Error("capability_task_storage_unavailable");
  await ensureSiteAgentV2Schema(database);
  const lease = await capabilityTaskLease(control);
  assertRunMatchesLease(run, lease);
  const task = await taskById(database, lease.workload.id);
  if (!task) throw new Error("capability_task_not_found");
  const evidence = record(json<unknown>(task.evidenceJson, {}));
  const updatedEvidence = {
    ...evidence,
    runner: {
      runId: run.id,
      mode: run.mode,
      status: run.status,
      progress: run.progress,
      startedAt: run.startedAt,
      artifactIds: run.artifactIds || [],
    },
  };
  const result = await database.prepare(`UPDATE site_agent_v2_capability_tasks
    SET evidence_json=?,updated_at=? WHERE id=? AND site_agent_id=? AND status='running' AND stage=?
      AND runner_id=? AND runner_session_id=? AND runner_lease_id=? AND runner_lease_fence=?
      AND runner_lease_expires_at>?`)
    .bind(JSON.stringify(updatedEvidence), lease.updatedAt, task.id, task.siteAgentId, lease.workKind,
      lease.runnerId, lease.runnerSessionId, lease.id, lease.fence, new Date().toISOString()).run();
  if (!result.success) throw new Error(result.error || "capability_task_browser_run_start_failed");
  if (!changes(result)) throw new Error("capability_task_browser_run_conflict");
  return { taskId: task.id, runId: run.id, status: "running" as const, stage: lease.workKind };
}

function closeAttempt(taskJson: string, run: BrowserRun) {
  const meta = json<{ attempts?: Array<Record<string, unknown>> }>(taskJson, {});
  const attempts = [...(Array.isArray(meta.attempts) ? meta.attempts : [])];
  const current = attempts.at(-1);
  if (current?.status === "running") {
    attempts[attempts.length - 1] = {
      ...current,
      status: run.status === "failed" ? "failed" : "passed",
      endedAt: run.endedAt || new Date().toISOString(),
      ...(run.status === "failed" ? { error: { code: run.outcome?.code || "runner_task_failed", summary: run.outcome?.summary || "Runner task failed." } } : {}),
    };
  }
  return JSON.stringify({ ...meta, attempts });
}

function completionEvidence(task: TaskRow, run: BrowserRun) {
  const evidence = record(json<unknown>(task.evidenceJson, {}));
  return JSON.stringify({
    ...evidence,
    runner: {
      runId: run.id,
      mode: run.mode,
      status: run.status,
      outcome: run.outcome,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      startUrl: run.startUrl,
      endUrl: run.endUrl,
      artifactIds: run.artifactIds || [],
      steps: run.steps,
    },
  });
}

function receiptKey(lease: RunnerLeaseRecord) {
  return `${lease.id}:${lease.fence}`;
}

export async function completeCapabilityTaskBrowserRun(
  control: CapabilityTaskControl,
  body: { run: BrowserRun; candidate?: KnowledgeCandidate },
): Promise<CapabilityTaskCompletionResult> {
  const database = getD1Binding();
  if (!database) throw new Error("capability_task_storage_unavailable");
  await ensureSiteAgentV2Schema(database);
  const lease = await capabilityTaskLease(control);
  assertRunMatchesLease(body.run, lease);
  if (body.run.status !== "passed" && body.run.status !== "failed") {
    throw new Error("capability_task_run_not_terminal");
  }
  const task = await taskById(database, lease.workload.id);
  if (!task) throw new Error("capability_task_not_found");
  const payloadHash = stableHash(JSON.stringify(body));
  const taskResult = record(json<unknown>(task.resultJson, {}));
  const completions = record(taskResult.runnerCompletions);
  const storedReceipt = completions[receiptKey(lease)] as unknown as RunnerCompletionReceipt | undefined;
  if (storedReceipt) {
    if (storedReceipt.payloadHash !== payloadHash) throw new Error("capability_task_completion_conflict");
    return storedReceipt.response;
  }
  if (task.runnerLeaseId !== lease.id
    || Number(task.runnerLeaseFence) !== lease.fence
    || task.runnerSessionId !== lease.runnerSessionId
    || task.runnerId !== lease.runnerId
    || task.status !== "running"
    || task.stage !== lease.workKind) {
    throw new Error("capability_task_completion_fence_rejected");
  }
  const passed = body.run.status === "passed";
  const isAuthor = lease.workKind === "author";
  if (isAuthor && passed && !body.candidate) throw new Error("authored_candidate_missing");
  const versionRows = !isAuthor && task.capabilityVersionId
    ? await all<VersionRow>(database, `SELECT id,site_agent_id AS siteAgentId,capability_id AS capabilityId,version,
        implementation_json AS implementationJson,validation_json AS validationJson,version_json AS versionJson,
        created_at AS createdAt,updated_at AS updatedAt
      FROM site_agent_v2_capability_versions WHERE id=? AND site_agent_id=? AND capability_id=? LIMIT 1`,
    [task.capabilityVersionId, task.siteAgentId, task.capabilityId])
    : [];
  const { status, stage } = capabilityTaskCompletionState(task.type, lease.workKind, passed);
  const response: CapabilityTaskCompletionResult = {
    taskId: task.id,
    status,
    stage,
    runId: body.run.id,
    leaseStatus: passed ? "completed" : "failed",
  };
  const nextResult = {
    ...taskResult,
    ...(isAuthor && body.candidate ? { authoredCandidate: body.candidate as unknown as JsonValue } : {}),
    runnerCompletions: {
      ...completions,
      [receiptKey(lease)]: { payloadHash, response },
    },
  };
  const error = passed ? null : JSON.stringify({
    code: body.run.outcome?.code || "runner_task_failed",
    summary: body.run.outcome?.summary || "Runner task failed.",
  });
  const taskUpdate = database.prepare(`UPDATE site_agent_v2_capability_tasks SET
    status=?,stage=?,task_json=?,result_json=?,evidence_json=?,error_json=?,
    runner_id=NULL,runner_session_id=NULL,runner_lease_id=NULL,runner_lease_fence=NULL,
    runner_lease_expires_at=NULL,updated_at=? WHERE id=? AND site_agent_id=? AND status='running'
    AND stage=? AND runner_id=? AND runner_session_id=? AND runner_lease_id=? AND runner_lease_fence=?`)
    .bind(status, stage, closeAttempt(task.taskJson, body.run), JSON.stringify(nextResult), completionEvidence(task, body.run),
      error, new Date().toISOString(), task.id, task.siteAgentId, lease.workKind, lease.runnerId,
      lease.runnerSessionId, lease.id, lease.fence);
  const versionValidation = JSON.stringify(isAuthor
    ? {
      status: passed ? "pending" : "failed",
      summary: passed ? "实现已生成，等待独立验证。" : body.run.outcome?.summary,
      ...(passed ? {} : { failureClass: body.run.outcome?.code || "runner-task-failed" }),
    }
    : {
      status: passed ? "passed" : "failed",
      input: record(taskResult.input),
      runId: body.run.id,
      startUrl: body.run.startUrl,
      ...(passed && versionRows[0]
        ? { validatedContentHash: stableHash(versionRows[0].implementationJson) }
        : {}),
      summary: body.run.outcome?.summary,
      ...(passed ? {} : { failureClass: body.run.outcome?.code || "runner-task-failed" }),
    });
  let versionUpdate;
  if (isAuthor && passed) {
    const candidate = body.candidate!;
    const implementation: CapabilityRevisionImplementation = candidate.capability.module
      ? { kind: "program", moduleRef: candidate.capability.module }
      : (candidate.operations[0]?.implementations[0]?.authored || { kind: "program" });
    versionUpdate = database.prepare(`UPDATE site_agent_v2_capability_versions SET
      implementation_json=?,validation_json=?,updated_at=? WHERE id=? AND site_agent_id=? AND capability_id=?
      AND EXISTS (SELECT 1 FROM site_agent_v2_capability_tasks WHERE id=? AND site_agent_id=?
        AND status='running' AND stage='author' AND runner_lease_id=? AND runner_lease_fence=?)`)
      .bind(JSON.stringify(implementation), versionValidation, new Date().toISOString(), task.capabilityVersionId,
        task.siteAgentId, task.capabilityId, task.id, task.siteAgentId, lease.id, lease.fence);
  } else {
    const statusAssignment = task.type === "validate"
      ? ""
      : passed && !isAuthor
        ? "status='awaiting-review',"
        : "status='failed',";
    versionUpdate = database.prepare(`UPDATE site_agent_v2_capability_versions SET
      ${statusAssignment}validation_json=?,updated_at=? WHERE id=? AND site_agent_id=? AND capability_id=?
      AND EXISTS (SELECT 1 FROM site_agent_v2_capability_tasks WHERE id=? AND site_agent_id=?
        AND status='running' AND stage=? AND runner_lease_id=? AND runner_lease_fence=?)`)
      .bind(versionValidation, new Date().toISOString(), task.capabilityVersionId, task.siteAgentId,
        task.capabilityId, task.id, task.siteAgentId, lease.workKind, lease.id, lease.fence);
  }
  const results = await database.batch([versionUpdate, taskUpdate]);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "capability_task_completion_failed");
  if (!changes(results[1])) throw new Error("capability_task_completion_conflict");
  return response;
}

export async function capabilityTaskLeaseKind(control: CapabilityTaskControl) {
  return (await getRunnerLeaseMirror(control)).lease.workload.kind;
}
