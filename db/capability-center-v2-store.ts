import { getArtifactBinding, getD1Binding, type D1DatabaseLike, type D1PreparedStatementLike } from "./index";
import { ensureCapabilityCenterV2Schema } from "./capability-center-v2-schema";
import {
  EMPTY_TASK_INPUT,
  isTerminalTaskStatus,
  type Capability,
  type CapabilityArtifact,
  type CapabilityCenterSetting,
  type CapabilityContract,
  type CapabilityProgram,
  type CapabilityStatus,
  type CapabilityTask,
  type CapabilityTaskEvent,
  type CapabilityTaskError,
  type CapabilityTaskInput,
  type CapabilityTaskResult,
  type CapabilityTaskStatus,
  type CapabilityTaskType,
  type CapabilityVersion,
  type CapabilityVersionSource,
  type CapabilityVersionStatus,
  type CapabilityBuildResult,
  type CapabilityCandidateArtifact,
  type C2CaseGenerationOutput,
  type CandidateValidationTask,
  type CapabilityPublishInput,
  type CapabilityPublishResult,
  type ValidatedCapabilityPackage,
  type JsonObject,
  type JsonValue,
  type Review,
  type RunSpec,
  type RunnerInstance,
  type RunnerStatus,
  type TaskInteraction,
} from "../lib/capability-center-v2/model";
import {
  capabilityCandidateHash,
  capabilityValidationSuiteHash,
  decodeC1AuthoringOutput,
  decodeC2CaseGenerationOutput,
  parseCapabilityCaseDiscoveryEvidenceSidecar,
} from "../lib/capability-center-v2/case-generation";
import { resolveCapabilityInputDefaults } from "../lib/capability-center-v2/input-template";
import { normalizeCapabilityExperience } from "../lib/capability-center-v2/experience";
import { demonstrationParametersOf, inspectCapabilityQuality } from "../lib/capability-center-v2/quality";
import {
  inspectCapabilityJavaScriptProgram,
  normalizeCapabilityJavaScriptProgram,
} from "../lib/capability-center-v2/javascript-runtime";
import { getCapabilityV2Module } from "./capability-center-v2-module-store";
import {
  compareCapabilityExpectedOutput,
  type ExpectedOutputDrift,
} from "../lib/capability-center-v2/expected-output";
import { debugEventFromTaskEvent } from "../lib/capability-center-v2/debug-trace";

type Store = {
  capabilities: Map<string, Capability>;
  versions: Map<string, CapabilityVersion>;
  tasks: Map<string, CapabilityTask>;
  settings: Map<string, CapabilityCenterSetting>;
  runners: Map<string, RunnerInstance>;
  idempotency: Map<
    string,
    { requestHash: string; response?: JsonObject; expiresAt: string }
  >;
  artifacts: Map<string, { artifact: CapabilityArtifact; bytes: Uint8Array }>;
  events: Map<
    string,
    Array<{
      id: string;
      sequence: number;
      eventType: string;
      payload: JsonObject;
      createdAt: string;
    }>
  >;
  candidateArtifacts: Map<string, CapabilityCandidateArtifact>;
  classificationReservations: Map<
    string,
    {
      siteId: string;
      generationTaskId: string;
      candidateName: string;
      reservationHash: string;
      status: "Active" | "Consumed" | "Superseded";
      capabilityId?: string;
      createdAt: string;
      updatedAt: string;
    }
  >;
};

const memory: Store = {
  capabilities: new Map(),
  versions: new Map(),
  tasks: new Map(),
  settings: new Map(),
  runners: new Map(),
  idempotency: new Map(),
  artifacts: new Map(),
  events: new Map(),
  candidateArtifacts: new Map(),
  classificationReservations: new Map(),
};

export class CapabilityCenterV2Error extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message = code, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "CapabilityCenterV2Error";
  }
}

function uid() {
  return crypto.randomUUID();
}
function now() {
  return new Date().toISOString();
}
function normalize(value: string) {
  return value.trim().toLocaleLowerCase("zh-CN");
}
function text(value: unknown) {
  return typeof value === "string" ? value : "";
}
function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

/** Historical task-result projection. New formal results use C2's suite. */
function legacyValidationCases(result: CapabilityTaskResult) {
  const value = (result as CapabilityTaskResult & { validationCases?: unknown }).validationCases;
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, JsonValue> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}
function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
function db() {
  return getD1Binding();
}
async function ready(database: D1DatabaseLike) {
  await ensureCapabilityCenterV2Schema(database);
}
async function all<T>(
  database: D1DatabaseLike,
  sql: string,
  values: unknown[] = [],
) {
  const result = await database
    .prepare(sql)
    .bind(...values)
    .all<T>();
  if (!result.success)
    throw new Error(result.error || "capability_center_v2_query_failed");
  return result.results || [];
}
async function run(
  database: D1DatabaseLike,
  sql: string,
  values: unknown[] = [],
) {
  const result = await database
    .prepare(sql)
    .bind(...values)
    .run();
  if (!result.success)
    throw new Error(result.error || "capability_center_v2_write_failed");
  return result;
}

function defaultContract(
  input?: Partial<CapabilityContract>,
): CapabilityContract {
  return {
    intent: text(input?.intent),
    inputSchema: object(input?.inputSchema),
    outputSchema: object(input?.outputSchema),
    preconditions: Array.isArray(input?.preconditions)
      ? input.preconditions
      : [],
    successConditions: Array.isArray(input?.successConditions)
      ? input.successConditions
      : [],
  };
}

function normalizeProgram(value: unknown): CapabilityProgram {
  const program = normalizeCapabilityJavaScriptProgram(value);
  const inspected = inspectCapabilityJavaScriptProgram(program);
  if (!inspected.valid)
    throw new CapabilityCenterV2Error(
      "capability_program_invalid",
      inspected.issues.join(","),
      409,
    );
  return program;
}

function normalizeInput(input: unknown): CapabilityTaskInput {
  const raw = object(input);
  const context = object(raw.context);
  const trigger = object(raw.trigger);
  const interactions = Array.isArray(raw.interactions) ? raw.interactions : [];
  return {
    parameters: object(raw.parameters),
    context: context as CapabilityTaskInput["context"],
    interactions: interactions.filter(
      (item) => item && typeof item === "object",
    ) as TaskInteraction[],
    trigger: {
      triggerTaskId:
        typeof trigger.triggerTaskId === "string"
          ? trigger.triggerTaskId
          : null,
      baseVersionId:
        typeof trigger.baseVersionId === "string"
          ? trigger.baseVersionId
          : null,
      errorCode:
        typeof trigger.errorCode === "string" ? trigger.errorCode : null,
    },
    candidateSummary:
      raw.candidateSummary && typeof raw.candidateSummary === "object"
        ? (raw.candidateSummary as CapabilityTaskInput["candidateSummary"])
        : undefined,
    experience:
      raw.experience && typeof raw.experience === "object"
        ? normalizeCapabilityExperience(raw.experience)
        : undefined,
    program: raw.program ? normalizeProgram(raw.program) : undefined,
  };
}

function capabilityFromRow(row: Record<string, unknown>): Capability {
  return {
    id: text(row.id),
    siteId: text(row.site_id),
    name: text(row.name),
    description: text(row.description),
    aliases: json<string[]>(text(row.aliases_json), []),
    searchText: text(row.search_text),
    contract: json<CapabilityContract>(
      text(row.contract_json),
      defaultContract(),
    ),
    status: text(row.status) as CapabilityStatus,
    currentVersionId: text(row.current_version_id) || undefined,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    deletedAt: text(row.deleted_at) || undefined,
  };
}
function versionFromRow(row: Record<string, unknown>): CapabilityVersion {
  return {
    id: text(row.id),
    siteId: text(row.site_id),
    capabilityId: text(row.capability_id),
    source: text(row.source) as CapabilityVersionSource,
    program: normalizeProgram(json(text(row.program_json), {})),
    status: text(row.status) as CapabilityVersionStatus,
    review: row.review_json
      ? json<Review>(text(row.review_json), {})
      : undefined,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    publishedAt: text(row.published_at) || undefined,
    deletedAt: text(row.deleted_at) || undefined,
  };
}
function taskFromRow(row: Record<string, unknown>): CapabilityTask {
  return {
    id: text(row.id),
    siteId: text(row.site_id),
    versionId: text(row.version_id),
    type: text(row.type) as CapabilityTaskType,
    status: text(row.status) as CapabilityTaskStatus,
    goal: text(row.goal),
    guidance: text(row.guidance) || undefined,
    input: normalizeInput(json(text(row.input_json), EMPTY_TASK_INPUT)),
    runSpec: row.run_spec_json
      ? json<RunSpec>(text(row.run_spec_json), undefined as never)
      : undefined,
    runnerId: text(row.runner_id) || undefined,
    result: row.result_json
      ? json<CapabilityTaskResult>(text(row.result_json), undefined as never)
      : undefined,
    error: row.error_json
      ? json<CapabilityTaskError>(text(row.error_json), undefined as never)
      : undefined,
    sourceAgentRunId: text(row.source_agent_run_id) || undefined,
    rerunOfTaskId: text(row.rerun_of_task_id) || undefined,
    createdAt: text(row.created_at),
    startedAt: text(row.started_at) || undefined,
    updatedAt: text(row.updated_at),
    finishedAt: text(row.finished_at) || undefined,
    archivedAt: text(row.archived_at) || undefined,
    deletedAt: text(row.deleted_at) || undefined,
  };
}
function runnerFromRow(row: Record<string, unknown>): RunnerInstance {
  return {
    id: text(row.id),
    siteId: text(row.site_id),
    taskId: text(row.task_id) || undefined,
    runtimeType: text(row.runtime_type) as RunnerInstance["runtimeType"],
    runtimeProvider: text(row.runtime_provider),
    runtimeVersion: text(row.runtime_version),
    status: text(row.status) as RunnerStatus,
    heartbeatAt: text(row.heartbeat_at),
    heartbeatExpiresAt: text(row.heartbeat_expires_at),
    lastError: text(row.last_error) || undefined,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    terminatedAt: text(row.terminated_at) || undefined,
  };
}

function capabilitySearchText(
  name: string,
  description: string,
  aliases: string[],
) {
  return normalize([name, description, ...aliases].join(" "));
}

function taskStatusForInput(input: CapabilityTaskInput): CapabilityTaskStatus {
  return input.interactions.some((item) => item.status === "Requested")
    ? "WaitingInput"
    : "Pending";
}

function versionSourceFromTask(task: CapabilityTask): CapabilityVersionSource {
  const requested = task.input.context.versionSource;
  return requested === "Knowledge" ||
    requested === "Admin" ||
    requested === "User"
    ? requested
    : task.sourceAgentRunId
      ? "User"
      : "Admin";
}

function buildRunSpec(
  task: Pick<
    CapabilityTask,
    "id" | "siteId" | "input" | "versionId" | "type" | "goal" | "guidance"
  >,
  version?: CapabilityVersion,
  capability?: Capability,
): RunSpec {
  const startUrl =
    typeof task.input.context.startUrl === "string"
      ? task.input.context.startUrl
      : undefined;
  const plan: RunSpec["plan"] = [];
  if (version) plan.push({ type: "Replay", program: version.program });
  else if (task.input.program)
    plan.push({ type: "Replay", program: task.input.program });
  else plan.push({ type: "Explore" });
  const contract =
    capability?.contract || task.input.candidateSummary?.contract;
  plan.push({
    type: "Evaluate",
    conditions: contract?.successConditions || [],
  });
  return {
    protocolVersion: "2.0",
    id: uid(),
    taskId: task.id,
    siteId: task.siteId,
    goal: task.goal,
    guidance: task.guidance,
    browser: { startUrl, recording: true },
    input: task.input,
    contract,
    plan,
  };
}

function memoryCapabilities(siteId: string, includeDeleted = false) {
  return [...memory.capabilities.values()].filter(
    (item) =>
      item.siteId === siteId && (includeDeleted || item.status !== "Deleted"),
  );
}
function memoryVersions(
  siteId: string,
  capabilityId: string,
  includeDeleted = false,
) {
  return [...memory.versions.values()]
    .filter(
      (item) =>
        item.siteId === siteId &&
        item.capabilityId === capabilityId &&
        (includeDeleted || item.status !== "Deleted"),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
type ListTaskOptions = {
  status?: CapabilityTaskStatus;
  type?: CapabilityTaskType;
  versionId?: string;
  includeDeleted?: boolean;
  includeArchived?: boolean;
};

function memoryTasks(siteId: string, options: ListTaskOptions = {}) {
  return [...memory.tasks.values()]
    .filter(
      (item) =>
        item.siteId === siteId &&
        (!options.status || item.status === options.status) &&
        (!options.type || item.type === options.type) &&
        (!options.versionId || item.versionId === options.versionId) &&
        (options.includeDeleted || item.status !== "Deleted") &&
        (options.includeArchived || !item.archivedAt),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function resetCapabilityCenterV2ForTests() {
  memory.capabilities.clear();
  memory.versions.clear();
  memory.tasks.clear();
  memory.settings.clear();
  memory.runners.clear();
  memory.idempotency.clear();
  memory.artifacts.clear();
  memory.events.clear();
  memory.candidateArtifacts.clear();
  memory.classificationReservations.clear();
}

export async function appendTaskEvent(
  siteId: string,
  taskId: string,
  input: { id?: string; eventType: string; payload?: JsonObject },
) {
  const task = await getTask(siteId, taskId, true);
  if (!task)
    throw new CapabilityCenterV2Error("task_not_found", "task_not_found", 404);
  let rootTask = task;
  const visited = new Set([task.id]);
  // Validation is a child phase of its Discovery/Repair automation. Other
  // reruns are new automations and therefore keep their own Trace root.
  while (
    rootTask.type === "Validation" &&
    rootTask.rerunOfTaskId &&
    visited.size < 8 &&
    !visited.has(rootTask.rerunOfTaskId)
  ) {
    visited.add(rootTask.rerunOfTaskId);
    const parent = await getTask(siteId, rootTask.rerunOfTaskId, true);
    if (!parent) break;
    rootTask = parent;
  }
  const id = input.id || uid();
  const createdAt = now();
  const database = db();
  const rawPayload = input.payload || {};
  const payload: JsonObject = rawPayload.debugEvent
    ? rawPayload
    : {
        ...rawPayload,
        debugEvent: debugEventFromTaskEvent(
          task,
          { id, eventType: input.eventType, payload: rawPayload, createdAt },
          rootTask.id,
        ) as unknown as JsonValue,
      };
  if (!database) {
    const key = `${siteId}:${taskId}`;
    const events = memory.events.get(key) || [];
    const duplicate = events.find((event) => event.id === id);
    if (duplicate) return duplicate;
    const event = {
      id,
      sequence: (events.at(-1)?.sequence || 0) + 1,
      eventType: input.eventType,
      payload,
      createdAt,
    };
    memory.events.set(key, [...events, event]);
    return event;
  }
  await ready(database);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const duplicateRows = await all<Record<string, unknown>>(
      database,
      `SELECT * FROM ccv2_task_events WHERE id=? AND site_id=? AND task_id=? LIMIT 1`,
      [id, siteId, taskId],
    );
    if (duplicateRows[0]) {
      const row = duplicateRows[0];
      return {
        id: text(row.id),
        sequence: Number(row.sequence),
        eventType: text(row.event_type),
        payload: json<JsonObject>(text(row.payload_json), {}),
        createdAt: text(row.created_at),
      };
    }
    // Sequence allocation and INSERT are one database statement. SQLite/D1
    // serializes the write; PostgreSQL may still observe an MVCC collision, in
    // which case INSERT OR IGNORE/ON CONFLICT and the bounded retry advance to
    // the next sequence without silently dropping the event.
    const inserted = await database
      .prepare(
        `INSERT OR IGNORE INTO ccv2_task_events (id,site_id,task_id,sequence,event_type,payload_json,created_at) SELECT ?,?,?,COALESCE(MAX(sequence),0)+1,?,?,? FROM ccv2_task_events WHERE site_id=? AND task_id=?`,
      )
      .bind(
        id,
        siteId,
        taskId,
        input.eventType,
        JSON.stringify(payload),
        createdAt,
        siteId,
        taskId,
      )
      .run();
    if (
      inserted.success &&
      (inserted.meta?.changes === undefined ||
        Number(inserted.meta.changes) === 1)
    ) {
      const saved = await all<{ sequence: number }>(
        database,
        `SELECT sequence FROM ccv2_task_events WHERE id=? AND site_id=? AND task_id=? LIMIT 1`,
        [id, siteId, taskId],
      );
      if (saved[0])
        return {
          id,
          sequence: Number(saved[0].sequence),
          eventType: input.eventType,
          payload,
          createdAt,
        };
    }
    const conflict = String(inserted.error || "").toLocaleLowerCase();
    if (!inserted.success && !/(?:unique|constraint|duplicate)/u.test(conflict))
      throw new Error(inserted.error || "task_event_save_failed");
    if (attempt === 63)
      throw new Error(inserted.error || "task_event_sequence_conflict");
  }
  throw new Error("task_event_sequence_conflict");
}

/** Read only the latest business gate event, independent of verbose browser traces. */
export async function getLatestTaskPublicationEvent(siteId: string, taskId: string): Promise<CapabilityTaskEvent | undefined> {
  const types = ["ReviewStarted", "ReviewCompleted", "ReviewFailed", "PublicationStarted", "PublicationFailed", "PublicationSuperseded"];
  const database = db();
  if (!database) return [...(memory.events.get(`${siteId}:${taskId}`) || [])].reverse().find(event => types.includes(event.eventType));
  await ready(database);
  const rows = await all<Record<string, unknown>>(database,
    `SELECT * FROM ccv2_task_events WHERE site_id=? AND task_id=? AND event_type IN (?,?,?,?,?,?) ORDER BY sequence DESC LIMIT 1`,
    [siteId, taskId, ...types]);
  const row = rows[0];
  return row ? { id: text(row.id), sequence: Number(row.sequence), eventType: text(row.event_type), payload: json<JsonObject>(text(row.payload_json), {}), createdAt: text(row.created_at) } : undefined;
}

export async function listTaskEventPage(
  siteId: string,
  taskId: string,
  afterSequence = 0,
  requestedLimit = 200,
) {
  const limit = Math.max(1, Math.min(1_000, Math.floor(requestedLimit || 200)));
  const database = db();
  const key = `${siteId}:${taskId}`;
  if (!database) {
    const matched = (memory.events.get(key) || []).filter(
      (event) => event.sequence > afterSequence,
    );
    return { events: matched.slice(0, limit), hasMore: matched.length > limit };
  }
  await ready(database);
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ccv2_task_events WHERE site_id=? AND task_id=? AND sequence>? ORDER BY sequence LIMIT ?`,
    [siteId, taskId, afterSequence, limit + 1],
  );
  const events = rows.map((row) => ({
    id: text(row.id),
    sequence: Number(row.sequence),
    eventType: text(row.event_type),
    payload: json<JsonObject>(text(row.payload_json), {}),
    createdAt: text(row.created_at),
  }));
  return { events: events.slice(0, limit), hasMore: events.length > limit };
}

export async function listTaskEvents(
  siteId: string,
  taskId: string,
  afterSequence = 0,
  limit = 200,
) {
  return (await listTaskEventPage(siteId, taskId, afterSequence, limit)).events;
}

export async function saveTaskArtifact(
  siteId: string,
  taskId: string,
  input: {
    kind: CapabilityArtifact["kind"];
    contentType: string;
    bytes: Uint8Array;
  },
) {
  const task = await getTask(siteId, taskId, true);
  if (!task)
    throw new CapabilityCenterV2Error("task_not_found", "task_not_found", 404);
  if (input.bytes.byteLength > 8 * 1024 * 1024)
    throw new CapabilityCenterV2Error(
      "artifact_too_large",
      "artifact_too_large",
      413,
    );
  const id = uid();
  const createdAt = now();
  const extension =
    input.contentType === "image/png"
      ? "png"
      : input.contentType === "video/webm"
        ? "webm"
        : "bin";
  const storageKey = `ccv2/${siteId}/${taskId}/${id}.${extension}`;
  const artifact: CapabilityArtifact = {
    id,
    siteId,
    taskId,
    kind: input.kind,
    storageKey,
    contentType: input.contentType,
    size: input.bytes.byteLength,
    createdAt,
  };
  const binding = getArtifactBinding();
  if (binding) {
    const artifactBuffer = new ArrayBuffer(input.bytes.byteLength);
    new Uint8Array(artifactBuffer).set(input.bytes);
    await binding.put(storageKey, artifactBuffer, {
      httpMetadata: { contentType: input.contentType },
    });
  } else memory.artifacts.set(id, { artifact, bytes: input.bytes });
  const database = db();
  if (database) {
    await ready(database);
    await run(
      database,
      `INSERT INTO ccv2_artifacts (id,site_id,task_id,kind,storage_key,content_type,size,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [
        id,
        siteId,
        taskId,
        artifact.kind,
        storageKey,
        artifact.contentType,
        artifact.size,
        createdAt,
      ],
    );
  }
  return {
    artifact,
    persistence: binding ? ("object-storage" as const) : ("memory" as const),
  };
}

export async function getTaskArtifact(siteId: string, artifactId: string) {
  const memoryArtifact = memory.artifacts.get(artifactId);
  if (memoryArtifact?.artifact.siteId === siteId) return memoryArtifact;
  const database = db();
  if (!database) return undefined;
  await ready(database);
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ccv2_artifacts WHERE id=? AND site_id=? LIMIT 1`,
    [artifactId, siteId],
  );
  const row = rows[0];
  if (!row) return undefined;
  const artifact: CapabilityArtifact = {
    id: text(row.id),
    siteId: text(row.site_id),
    taskId: text(row.task_id),
    kind: text(row.kind) as CapabilityArtifact["kind"],
    storageKey: text(row.storage_key),
    contentType: text(row.content_type),
    size: Number(row.size || 0),
    createdAt: text(row.created_at),
  };
  const stored = await getArtifactBinding()?.get(artifact.storageKey);
  if (!stored) return undefined;
  return { artifact, stream: stored.body };
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalJsonValue(item)]),
    );
  return value;
}

async function sha256Json(value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonicalJsonValue(value))),
  );
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function deterministicPublishId(
  kind: "capability" | "version",
  siteId: string,
  generationTaskId: string,
) {
  const hex = (await sha256Json({ kind, siteId, generationTaskId })).slice(7);
  const variant = ((Number.parseInt(hex[16] || "0", 16) & 0x3) | 0x8).toString(
    16,
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function deterministicCondition(value: JsonValue) {
  const type =
    value && typeof value === "object" && !Array.isArray(value)
      ? String((value as JsonObject).type || "")
      : "text";
  return [
    "urlIncludes",
    "urlTemplate",
    "textIncludes",
    "textTemplate",
    "inputExists",
    "outputExists",
    "outputEquals",
  ].includes(type);
}

/** Normalize C2's model-produced cases through its internal commit boundary. */
export function createCapabilityValidationSuite(
  validationCases: Array<Record<string, JsonValue>> | undefined,
) {
  const cases = (validationCases || []).map((input, index) => ({
    caseId: `case_${index + 1}`,
    input,
    expected: {},
  }));
  if (!cases.length)
    throw new CapabilityCenterV2Error(
      "validation_cases_required",
      "validation_cases_required",
      409,
    );
  return { cases };
}

async function candidateArtifactForGenerationTask(
  siteId: string,
  generationTaskId: string,
) {
  const memoryArtifact = [...memory.candidateArtifacts.values()].find(
    (item) => item.generationTaskId === generationTaskId,
  );
  if (memoryArtifact) return memoryArtifact;
  const database = db();
  if (!database) return undefined;
  await ready(database);
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT artifact_json FROM ccv2_candidate_artifacts WHERE site_id=? AND generation_task_id=? LIMIT 1`,
    [siteId, generationTaskId],
  );
  return rows[0]
    ? json<CapabilityCandidateArtifact>(
        text(rows[0].artifact_json),
        undefined as never,
      )
    : undefined;
}

function sameFrozenCandidate(
  existing: CapabilityCandidateArtifact,
  candidate: CapabilityCandidateArtifact["candidate"],
  contractHash: string,
  programHash: string,
  validationSuite: C2CaseGenerationOutput["validationSuite"],
  validationSuiteHash: string,
  caseDiscoveryEvidenceRef: C2CaseGenerationOutput["caseDiscoveryEvidenceRef"],
) {
  return (
    existing.contractHash === contractHash &&
    existing.programHash === programHash &&
    (existing.validationSuiteHash ||
      capabilityValidationSuiteHash(existing.validationSuite)) ===
      validationSuiteHash &&
    JSON.stringify(canonicalJsonValue(existing.validationSuite)) ===
      JSON.stringify(canonicalJsonValue(validationSuite)) &&
    JSON.stringify(canonicalJsonValue(existing.caseDiscoveryEvidenceRef)) ===
      JSON.stringify(canonicalJsonValue(caseDiscoveryEvidenceRef)) &&
    JSON.stringify(canonicalJsonValue(existing.candidate)) ===
      JSON.stringify(canonicalJsonValue(candidate))
  );
}

type CaseDiscoveryArtifactRecord = {
  artifact: Pick<
    CapabilityArtifact,
    "id" | "siteId" | "taskId" | "kind" | "size"
  >;
  bytes: Uint8Array;
};

type C2CaseGenerationCommitDependencies = {
  loadCaseDiscoveryArtifact?: (
    artifactId: string,
  ) => Promise<CaseDiscoveryArtifactRecord | undefined>;
};

function caseDiscoveryArtifactId(artifactRef: string) {
  const match = /^artifact:\/\/([^/?#]+)$/u.exec(artifactRef);
  if (!match)
    throw new CapabilityCenterV2Error(
      "case_discovery_artifact_ref_invalid",
      "case_discovery_artifact_ref_invalid",
      409,
    );
  return match[1];
}

async function storedArtifactRecord(
  siteId: string,
  artifactId: string,
): Promise<CaseDiscoveryArtifactRecord | undefined> {
  const stored = await getTaskArtifact(siteId, artifactId);
  if (!stored) return undefined;
  const bytes =
    "bytes" in stored
      ? new Uint8Array(stored.bytes)
      : new Uint8Array(
          await new Response(stored.stream as BodyInit).arrayBuffer(),
        );
  return { artifact: stored.artifact, bytes };
}

function jsonLeafEntries(
  value: JsonObject,
  prefix = "",
): Array<[string, JsonValue]> {
  const entries: Array<[string, JsonValue]> = [];
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === "object" && !Array.isArray(item))
      entries.push(...jsonLeafEntries(item as JsonObject, path));
    else entries.push([path, item]);
  }
  return entries;
}

function evidenceValueMatches(left: JsonValue, right: JsonValue) {
  if (typeof left === "string" && typeof right === "string") {
    return (
      left.normalize("NFKC").trim().toLocaleLowerCase() ===
      right.normalize("NFKC").trim().toLocaleLowerCase()
    );
  }
  return (
    JSON.stringify(canonicalJsonValue(left)) ===
    JSON.stringify(canonicalJsonValue(right))
  );
}

async function verifyCaseDiscoveryArtifact(
  siteId: string,
  task: CapabilityTask,
  c2: C2CaseGenerationOutput,
  dependencies: C2CaseGenerationCommitDependencies,
) {
  const artifactId = caseDiscoveryArtifactId(
    c2.caseDiscoveryEvidenceRef.artifactRef,
  );
  const stored = dependencies.loadCaseDiscoveryArtifact
    ? await dependencies.loadCaseDiscoveryArtifact(artifactId)
    : await storedArtifactRecord(siteId, artifactId);
  if (
    !stored ||
    stored.artifact.id !== artifactId ||
    stored.artifact.siteId !== siteId ||
    stored.artifact.taskId !== task.id ||
    stored.artifact.kind !== "CaseDiscoveryEvidence" ||
    stored.artifact.size !== stored.bytes.byteLength
  ) {
    throw new CapabilityCenterV2Error(
      "case_discovery_artifact_invalid",
      "case_discovery_artifact_invalid",
      409,
    );
  }
  const parsed = parseCapabilityCaseDiscoveryEvidenceSidecar(
    stored.bytes,
    c2.caseDiscoveryEvidenceRef,
  );
  const evidence = parsed.value;
  if (
    evidence.generationTaskId !== task.id ||
    evidence.siteId !== siteId ||
    evidence.candidateHash !== capabilityCandidateHash(c2.candidate) ||
    evidence.cases.length !== c2.validationSuite.cases.length
  ) {
    throw new CapabilityCenterV2Error(
      "case_discovery_artifact_binding_mismatch",
      "case_discovery_artifact_binding_mismatch",
      409,
    );
  }
  for (let index = 0; index < c2.validationSuite.cases.length; index += 1) {
    const frozen = c2.validationSuite.cases[index];
    const mapped = evidence.cases[index];
    const inputEntries = jsonLeafEntries(frozen.input);
    if (
      mapped.caseId !== frozen.caseId ||
      mapped.parameters.length !== inputEntries.length
    ) {
      throw new CapabilityCenterV2Error(
        "case_discovery_artifact_case_mismatch",
        "case_discovery_artifact_case_mismatch",
        409,
      );
    }
    for (const [inputPath, inputValue] of inputEntries) {
      const parameter = mapped.parameters.find(
        (item) => item.inputPath === inputPath,
      );
      if (
        !parameter ||
        !evidenceValueMatches(parameter.observedValue, inputValue)
      ) {
        throw new CapabilityCenterV2Error(
          "case_discovery_artifact_case_mismatch",
          "case_discovery_artifact_case_mismatch",
          409,
        );
      }
    }
  }
  return parsed.value;
}

/**
 * Persist the authoritative C2 candidate as an immutable artifact.
 *
 * This is deliberately an internal C2 implementation detail.  Candidate
 * artifacts are only committed through `completeC2CaseGeneration`, after C2
 * has passed its case/evidence gates; there is no standalone Freeze module
 * boundary anymore.
 */
async function persistC2CandidateArtifact(
  siteId: string,
  task: CapabilityTask,
  c2Value: C2CaseGenerationOutput,
  dependencies: C2CaseGenerationCommitDependencies = {},
) {
  if (task.type !== "Discovery" && task.type !== "Repair")
    throw new CapabilityCenterV2Error(
      "candidate_task_type_invalid",
      "candidate_task_type_invalid",
      409,
    );
  const c2 = decodeC2CaseGenerationOutput(c2Value);
  if (c2.generationTaskId !== task.id)
    throw new CapabilityCenterV2Error(
      "candidate_generation_task_mismatch",
      "candidate_generation_task_mismatch",
      409,
    );
  await verifyCaseDiscoveryArtifact(siteId, task, c2, dependencies);
  // Validate the executable through the production normalizer, but preserve
  // the exact C2 Candidate value in the Artifact.  Reordering stage I/O here
  // would change the Candidate hash after C2 had already bound its evidence
  // sidecar to that Candidate.
  normalizeProgram(c2.candidate.program);
  const candidateProgram = c2.candidate.program;
  const contract = c2.candidate.contract;
  const conditions = [...contract.preconditions, ...contract.successConditions];
  if (
    !conditions.length ||
    conditions.some((condition) => !deterministicCondition(condition))
  ) {
    throw new CapabilityCenterV2Error(
      "candidate_deterministic_contract_required",
      "candidate_deterministic_contract_required",
      409,
    );
  }
  const storedModule = await getCapabilityV2Module(
    siteId,
    candidateProgram.module.contentHash,
  );
  if (!storedModule)
    throw new CapabilityCenterV2Error(
      "candidate_module_missing",
      "candidate_module_missing",
      409,
    );
  const validationSuite = c2.validationSuite;
  const candidate: CapabilityCandidateArtifact["candidate"] = {
    name: c2.candidate.name,
    description: c2.candidate.description,
    aliases: c2.candidate.aliases,
    contract,
    program: candidateProgram,
    ...(c2.candidate.replacementPlan
      ? { replacementPlan: c2.candidate.replacementPlan }
      : {}),
  };
  // The caller passes the generation task with its result attached; the
  // demonstration values come from it and from nothing else.
  const quality = inspectCapabilityQuality(contract, candidateProgram, {
    demonstrationParameters: demonstrationParametersOf(task),
    validationCases: validationSuite.cases.map((item) => item.input),
    requireIndependentCases: true,
    source: storedModule.source,
    ...(typeof task.input.context?.startUrl === "string" ? { entryUrl: task.input.context.startUrl } : {}),
    summary: {
      name: candidate.name,
      description: candidate.description,
      aliases: candidate.aliases,
    },
  });
  if (!quality.valid)
    throw new CapabilityCenterV2Error(
      "candidate_quality_gate_failed",
      `candidate_quality_gate_failed:${quality.issues.map((issue) => issue.code).join(",")}`,
      409,
    );
  const contractHash = await sha256Json(contract);
  const programHash = await sha256Json(candidateProgram);
  const existing = await candidateArtifactForGenerationTask(siteId, task.id);
  if (existing) {
    if (
      !sameFrozenCandidate(
        existing,
        candidate,
        contractHash,
        programHash,
        c2.validationSuite,
        c2.validationSuiteHash,
        c2.caseDiscoveryEvidenceRef,
      )
    )
      throw new CapabilityCenterV2Error(
        "candidate_freeze_conflict",
        "candidate_freeze_conflict",
        409,
      );
    return {
      artifact:
        existing.validationSuiteHash && existing.caseDiscoveryEvidenceRef
          ? existing
          : {
              ...existing,
              validationSuiteHash: c2.validationSuiteHash,
              caseDiscoveryEvidenceRef: c2.caseDiscoveryEvidenceRef,
            },
      created: false,
    };
  }
  const artifact: CapabilityCandidateArtifact = {
    candidateId: uid(),
    generationTaskId: task.id,
    candidate,
    validationSuite,
    contractHash,
    programHash,
    caseDiscoveryEvidenceRef: c2.caseDiscoveryEvidenceRef,
    validationSuiteHash: c2.validationSuiteHash,
  };
  const database = db();
  if (!database) memory.candidateArtifacts.set(artifact.candidateId, artifact);
  else {
    await ready(database);
    try {
      await run(
        database,
        `INSERT INTO ccv2_candidate_artifacts (candidate_id,site_id,generation_task_id,artifact_json,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
        [
          artifact.candidateId,
          siteId,
          task.id,
          JSON.stringify(artifact),
          now(),
          now(),
        ],
      );
    } catch (error) {
      const raced = await candidateArtifactForGenerationTask(siteId, task.id);
      if (
        raced &&
        sameFrozenCandidate(
          raced,
          candidate,
          contractHash,
          programHash,
          c2.validationSuite,
          c2.validationSuiteHash,
          c2.caseDiscoveryEvidenceRef,
        )
      )
        return { artifact: raced, created: false };
      throw error;
    }
  }
  return { artifact, created: true };
}

async function deleteC2CandidateArtifact(
  siteId: string,
  generationTaskId: string,
  candidateId: string,
) {
  const database = db();
  if (!database) {
    const existing = memory.candidateArtifacts.get(candidateId);
    if (existing?.generationTaskId === generationTaskId)
      memory.candidateArtifacts.delete(candidateId);
    return;
  }
  await ready(database);
  await run(
    database,
    `DELETE FROM ccv2_candidate_artifacts WHERE site_id=? AND generation_task_id=? AND candidate_id=?`,
    [siteId, generationTaskId, candidateId],
  );
}

async function deleteC2ValidationTask(siteId: string, taskId: string) {
  const database = db();
  if (!database) {
    memory.tasks.delete(taskId);
    memory.events.delete(taskId);
    return;
  }
  await ready(database);
  await run(
    database,
    `DELETE FROM ccv2_capability_tasks WHERE site_id=? AND id=? AND type='Validation' AND status='Pending'`,
    [siteId, taskId],
  );
  await run(
    database,
    `DELETE FROM ccv2_task_events WHERE site_id=? AND task_id=?`,
    [siteId, taskId],
  );
}

/**
 * Complete the C2 boundary: commit the frozen CandidateArtifact and create
 * the existing C3 Validation Task from that exact artifact.  The operation
 * is idempotent for the same generation task/content and rolls back newly
 * created records if the internal commit cannot finish.
 */
export async function completeC2CaseGeneration(
  siteId: string,
  task: CapabilityTask,
  c2Value: C2CaseGenerationOutput,
  dependencies: C2CaseGenerationCommitDependencies = {},
) {
  const existingBefore = await candidateArtifactForGenerationTask(
    siteId,
    task.id,
  );
  const persisted = await persistC2CandidateArtifact(
    siteId,
    task,
    c2Value,
    dependencies,
  );
  const artifact = persisted.artifact;
  let validationTaskId: string | undefined;
  let validationCreated = false;
  try {
    // The unified B entry normally creates this reservation before the
    // Runner starts. Keep the legacy Admin Task compatibility route safe as
    // well, without adding another public task type or boundary.
    if (!(await getCapabilityClassificationReservation(siteId, task.id))) {
      const maintenance = maintenanceDescriptor(task.input);
      const reservationHash = await sha256Json({
        candidateName: artifact.candidate.name,
        operation: task.type === "Repair" ? "repair" : "create",
        capabilityId: maintenance?.capabilityId,
        contract: artifact.candidate.contract,
      });
      await reserveCapabilityClassification(
        siteId,
        task.id,
        artifact.candidate.name,
        reservationHash,
      );
    }

    const existingValidation = (
      await listTasks(siteId, {
        includeArchived: true,
        includeDeleted: true,
      })
    ).tasks.find(
      (item) =>
        item.type === "Validation" &&
        item.rerunOfTaskId === task.id &&
        item.input.context.__candidateValidation === true,
    );
    let validation: { task: CapabilityTask };
    if (existingValidation) {
      validation = { task: existingValidation };
    } else {
      validationCreated = true;
      validation = await createCapabilityTask(siteId, {
        type: "Validation",
        goal: task.goal,
        input: {
          parameters: artifact.validationSuite.cases[0]?.input || {},
          context: {
            ...task.input.context,
            startUrl:
              artifact.candidate.program.entry.url ||
              task.input.context.startUrl,
          },
          interactions: [],
          trigger: {},
        },
        candidateArtifact: artifact,
        rerunOfTaskId: task.id,
      });
    }
    validationTaskId = validation.task.id;

    // Standalone C2 fixtures use an in-memory task projection rather than a
    // second production API. Persisted Runner tasks still receive the same
    // audit event as before.
    if (await getTask(siteId, task.id, true)) {
      await appendTaskEvent(siteId, task.id, {
        eventType: "CandidateFrozen",
        payload: {
          phase: "CandidateArtifact",
          candidateId: artifact.candidateId,
          contractHash: artifact.contractHash,
          programHash: artifact.programHash,
          validationSuiteHash: artifact.validationSuiteHash || null,
          validationTaskId,
        },
      });
    }
    return { artifact, validationTask: validation.task };
  } catch (error) {
    if (!existingBefore && persisted.created)
      await deleteC2CandidateArtifact(siteId, task.id, artifact.candidateId);
    if (validationTaskId && validationCreated)
      await deleteC2ValidationTask(siteId, validationTaskId);
    throw error;
  }
}

export async function getCapabilityCandidateArtifact(
  siteId: string,
  candidateId: string,
) {
  const memoryArtifact = memory.candidateArtifacts.get(candidateId);
  if (memoryArtifact)
    return memoryArtifact.generationTaskId ? memoryArtifact : undefined;
  const database = db();
  if (!database) return undefined;
  await ready(database);
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT artifact_json FROM ccv2_candidate_artifacts WHERE site_id=? AND candidate_id=? LIMIT 1`,
    [siteId, candidateId],
  );
  return rows[0]
    ? json<CapabilityCandidateArtifact>(
        text(rows[0].artifact_json),
        undefined as never,
      )
    : undefined;
}

/** Load the exact frozen C3 input and re-verify its C2 evidence bytes. */
export async function getCandidateValidationBundle(
  siteId: string,
  validationTaskId: string,
) {
  const validationTask = await getTask(siteId, validationTaskId, true);
  if (
    !validationTask ||
    validationTask.type !== "Validation" ||
    !validationTask.runSpec?.candidateValidation
  ) {
    throw new CapabilityCenterV2Error(
      "candidate_validation_task_invalid",
      "candidate_validation_task_invalid",
      409,
    );
  }
  const artifact = await getCapabilityCandidateArtifact(
    siteId,
    validationTask.versionId,
  );
  if (!artifact?.caseDiscoveryEvidenceRef || !artifact.validationSuiteHash) {
    throw new CapabilityCenterV2Error(
      "candidate_validation_artifact_incomplete",
      "candidate_validation_artifact_incomplete",
      409,
    );
  }
  const generationTask = await getTask(siteId, artifact.generationTaskId, true);
  if (!generationTask)
    throw new CapabilityCenterV2Error(
      "candidate_generation_task_not_found",
      "candidate_generation_task_not_found",
      404,
    );
  const evidence = await verifyCaseDiscoveryArtifact(
    siteId,
    generationTask,
    {
      generationTaskId: artifact.generationTaskId,
      candidate: artifact.candidate,
      validationSuite: artifact.validationSuite,
      validationSuiteHash: artifact.validationSuiteHash,
      caseDiscoveryEvidenceRef: artifact.caseDiscoveryEvidenceRef,
    },
    {},
  );
  return { artifact, evidence };
}

export async function reserveCapabilityClassification(
  siteId: string,
  generationTaskId: string,
  candidateName: string,
  reservationHash: string,
) {
  const timestamp = now();
  const item = {
    siteId,
    generationTaskId,
    candidateName,
    reservationHash,
    status: "Active" as const,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const database = db();
  if (!database) {
    const key = `${siteId}:${generationTaskId}`;
    const existing = memory.classificationReservations.get(key);
    if (
      existing &&
      (existing.reservationHash !== reservationHash ||
        existing.candidateName !== candidateName)
    )
      throw new CapabilityCenterV2Error(
        "classification_reservation_conflict",
        "classification_reservation_conflict",
        409,
      );
    memory.classificationReservations.set(key, existing || item);
    return existing || item;
  }
  await ready(database);
  await run(
    database,
    `INSERT INTO ccv2_classification_reservations (site_id,generation_task_id,candidate_name,reservation_hash,status,capability_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(site_id,generation_task_id) DO NOTHING`,
    [
      siteId,
      generationTaskId,
      candidateName,
      reservationHash,
      item.status,
      null,
      timestamp,
      timestamp,
    ],
  );
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ccv2_classification_reservations WHERE site_id=? AND generation_task_id=? LIMIT 1`,
    [siteId, generationTaskId],
  );
  const row = rows[0];
  if (!row || text(row.reservation_hash) !== reservationHash)
    throw new CapabilityCenterV2Error(
      "classification_reservation_conflict",
      "classification_reservation_conflict",
      409,
    );
  return {
    siteId,
    generationTaskId,
    candidateName: text(row.candidate_name),
    reservationHash: text(row.reservation_hash),
    status: text(row.status) as "Active" | "Consumed" | "Superseded",
    capabilityId: text(row.capability_id) || undefined,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

export async function getCapabilityClassificationReservation(
  siteId: string,
  generationTaskId: string,
) {
  const memoryItem = memory.classificationReservations.get(
    `${siteId}:${generationTaskId}`,
  );
  if (memoryItem) return memoryItem;
  const database = db();
  if (!database) return undefined;
  await ready(database);
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ccv2_classification_reservations WHERE site_id=? AND generation_task_id=? LIMIT 1`,
    [siteId, generationTaskId],
  );
  const row = rows[0];
  return row
    ? {
        siteId,
        generationTaskId,
        candidateName: text(row.candidate_name),
        reservationHash: text(row.reservation_hash),
        status: text(row.status) as "Active" | "Consumed" | "Superseded",
        capabilityId: text(row.capability_id) || undefined,
        createdAt: text(row.created_at),
        updatedAt: text(row.updated_at),
      }
    : undefined;
}

/**
 * Find an in-flight B classification for the same semantic reservation. This
 * is deliberately a read-only logical projection; it does not expose the
 * physical reservation table to the generation boundary.
 */
export async function findActiveCapabilityClassificationReservation(
  siteId: string,
  reservationHash: string,
) {
  const database = db();
  if (!database) {
    return [...memory.classificationReservations.values()].find(
      (item) =>
        item.siteId === siteId &&
        item.status === "Active" &&
        item.reservationHash === reservationHash,
    );
  }
  await ready(database);
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ccv2_classification_reservations WHERE site_id=? AND reservation_hash=? AND status='Active' ORDER BY created_at LIMIT 1`,
    [siteId, reservationHash],
  );
  const row = rows[0];
  return row
    ? {
        siteId,
        generationTaskId: text(row.generation_task_id),
        candidateName: text(row.candidate_name),
        reservationHash: text(row.reservation_hash),
        status: "Active" as const,
        capabilityId: text(row.capability_id) || undefined,
        createdAt: text(row.created_at),
        updatedAt: text(row.updated_at),
      }
    : undefined;
}

export async function beginIdempotentRequest(
  siteId: string,
  scope: string,
  key: string,
  requestHash: string,
) {
  if (!key || key.length > 200)
    throw new CapabilityCenterV2Error(
      "idempotency_key_invalid",
      "idempotency_key_invalid",
      400,
    );
  const memoryKey = `${siteId}:${scope}:${key}`;
  const timestamp = now();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const database = db();
  if (!database) {
    const existing = memory.idempotency.get(memoryKey);
    if (existing && existing.expiresAt > timestamp) {
      if (existing.requestHash !== requestHash)
        throw new CapabilityCenterV2Error(
          "idempotency_key_reused",
          "idempotency_key_reused",
          409,
        );
      if (!existing.response)
        throw new CapabilityCenterV2Error(
          "idempotency_request_in_progress",
          "idempotency_request_in_progress",
          409,
        );
      return { replay: existing.response };
    }
    memory.idempotency.set(memoryKey, { requestHash, expiresAt });
    return { replay: undefined };
  }
  await ready(database);
  await run(database, `DELETE FROM ccv2_idempotency WHERE expires_at<=?`, [
    timestamp,
  ]);
  const inserted = await database
    .prepare(
      `INSERT OR IGNORE INTO ccv2_idempotency (site_id,scope,idempotency_key,request_hash,response_json,created_at,expires_at) VALUES (?,?,?,?,NULL,?,?)`,
    )
    .bind(siteId, scope, key, requestHash, timestamp, expiresAt)
    .run();
  if (inserted.success && Number(inserted.meta?.changes || 0) === 1)
    return { replay: undefined };
  const rows = await all<{
    request_hash: string;
    response_json: string | null;
  }>(
    database,
    `SELECT request_hash,response_json FROM ccv2_idempotency WHERE site_id=? AND scope=? AND idempotency_key=? LIMIT 1`,
    [siteId, scope, key],
  );
  const existing = rows[0];
  if (!existing || existing.request_hash !== requestHash)
    throw new CapabilityCenterV2Error(
      "idempotency_key_reused",
      "idempotency_key_reused",
      409,
    );
  if (!existing.response_json)
    throw new CapabilityCenterV2Error(
      "idempotency_request_in_progress",
      "idempotency_request_in_progress",
      409,
    );
  return { replay: json<JsonObject>(existing.response_json, {}) };
}

export async function completeIdempotentRequest(
  siteId: string,
  scope: string,
  key: string,
  response: JsonObject,
) {
  const memoryKey = `${siteId}:${scope}:${key}`;
  const database = db();
  if (!database) {
    const existing = memory.idempotency.get(memoryKey);
    if (existing) memory.idempotency.set(memoryKey, { ...existing, response });
    return;
  }
  await ready(database);
  await run(
    database,
    `UPDATE ccv2_idempotency SET response_json=? WHERE site_id=? AND scope=? AND idempotency_key=?`,
    [JSON.stringify(response), siteId, scope, key],
  );
}

export async function abandonIdempotentRequest(
  siteId: string,
  scope: string,
  key: string,
) {
  const memoryKey = `${siteId}:${scope}:${key}`;
  const database = db();
  if (!database) {
    memory.idempotency.delete(memoryKey);
    return;
  }
  await ready(database);
  await run(
    database,
    `DELETE FROM ccv2_idempotency WHERE site_id=? AND scope=? AND idempotency_key=? AND response_json IS NULL`,
    [siteId, scope, key],
  );
}

export async function listCapabilities(
  siteId: string,
  options: { status?: CapabilityStatus; includeDeleted?: boolean } = {},
) {
  const database = db();
  if (!database)
    return {
      capabilities: memoryCapabilities(siteId, options.includeDeleted).filter(
        (item) => !options.status || item.status === options.status,
      ),
      persistence: "memory" as const,
    };
  await ready(database);
  const clauses = ["site_id=?"];
  const values: unknown[] = [siteId];
  if (!options.includeDeleted) clauses.push("status<>'Deleted'");
  if (options.status) {
    clauses.push("status=?");
    values.push(options.status);
  }
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ccv2_capabilities WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC`,
    values,
  );
  return {
    capabilities: rows.map(capabilityFromRow),
    persistence: "database" as const,
  };
}

export async function getCapability(
  siteId: string,
  capabilityId: string,
  includeDeleted = false,
) {
  const database = db();
  if (!database) {
    const item = memory.capabilities.get(capabilityId);
    return item?.siteId === siteId &&
      (includeDeleted || item.status !== "Deleted")
      ? item
      : undefined;
  }
  await ready(database);
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ccv2_capabilities WHERE id=? AND site_id=? ${includeDeleted ? "" : "AND status<>'Deleted'"} LIMIT 1`,
    [capabilityId, siteId],
  );
  return rows[0] ? capabilityFromRow(rows[0]) : undefined;
}

export async function listVersions(
  siteId: string,
  capabilityId: string,
  includeDeleted = false,
) {
  const database = db();
  if (!database)
    return {
      versions: memoryVersions(siteId, capabilityId, includeDeleted),
      persistence: "memory" as const,
    };
  await ready(database);
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ccv2_capability_versions WHERE site_id=? AND capability_id=? ${includeDeleted ? "" : "AND status<>'Deleted'"} ORDER BY created_at DESC`,
    [siteId, capabilityId],
  );
  return {
    versions: rows.map(versionFromRow),
    persistence: "database" as const,
  };
}

export async function getVersion(
  siteId: string,
  versionId: string,
  includeDeleted = false,
) {
  const database = db();
  if (!database) {
    const item = memory.versions.get(versionId);
    return item?.siteId === siteId &&
      (includeDeleted || item.status !== "Deleted")
      ? item
      : undefined;
  }
  await ready(database);
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ccv2_capability_versions WHERE id=? AND site_id=? ${includeDeleted ? "" : "AND status<>'Deleted'"} LIMIT 1`,
    [versionId, siteId],
  );
  return rows[0] ? versionFromRow(rows[0]) : undefined;
}

export async function getCapabilityDetail(
  siteId: string,
  capabilityId: string,
) {
  const capability = await getCapability(siteId, capabilityId, true);
  if (!capability) return undefined;
  const [{ versions }, { tasks }] = await Promise.all([
    listVersions(siteId, capabilityId, true),
    listTasks(siteId, { includeDeleted: true }),
  ]);
  return {
    capability,
    versions,
    tasks: tasks.filter(
      (task) =>
        task.versionId === capability.currentVersionId ||
        versions.some((version) => version.id === task.versionId),
    ),
  };
}

export async function listTasks(siteId: string, options: ListTaskOptions = {}) {
  const database = db();
  if (!database)
    return {
      tasks: memoryTasks(siteId, options),
      persistence: "memory" as const,
    };
  await ready(database);
  const clauses = ["site_id=?"];
  const values: unknown[] = [siteId];
  if (!options.includeDeleted) clauses.push("status<>'Deleted'");
  if (!options.includeArchived) clauses.push("archived_at IS NULL");
  if (options.status) {
    clauses.push("status=?");
    values.push(options.status);
  }
  if (options.type) {
    clauses.push("type=?");
    values.push(options.type);
  }
  if (options.versionId) {
    clauses.push("version_id=?");
    values.push(options.versionId);
  }
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ccv2_capability_tasks WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC`,
    values,
  );
  return { tasks: rows.map(taskFromRow), persistence: "database" as const };
}

export async function getTask(
  siteId: string,
  taskId: string,
  includeDeleted = false,
) {
  const database = db();
  if (!database) {
    const item = memory.tasks.get(taskId);
    return item?.siteId === siteId &&
      (includeDeleted || item.status !== "Deleted")
      ? item
      : undefined;
  }
  await ready(database);
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ccv2_capability_tasks WHERE id=? AND site_id=? ${includeDeleted ? "" : "AND status<>'Deleted'"} LIMIT 1`,
    [taskId, siteId],
  );
  return rows[0] ? taskFromRow(rows[0]) : undefined;
}

export async function createCapability(
  siteId: string,
  input: {
    name: string;
    description?: string;
    aliases?: string[];
    contract?: CapabilityContract;
  },
) {
  const name = text(input.name).trim();
  if (!name)
    throw new CapabilityCenterV2Error(
      "capability_name_required",
      "capability_name_required",
      400,
    );
  const existing = (await listCapabilities(siteId)).capabilities.find(
    (item) => normalize(item.name) === normalize(name),
  );
  if (existing)
    throw new CapabilityCenterV2Error(
      "capability_duplicate",
      "capability_duplicate",
      409,
    );
  const createdAt = now();
  const item: Capability = {
    id: uid(),
    siteId,
    name,
    description: text(input.description),
    aliases: input.aliases || [],
    searchText: capabilitySearchText(
      name,
      text(input.description),
      input.aliases || [],
    ),
    contract: defaultContract(input.contract),
    status: "Building",
    createdAt,
    updatedAt: createdAt,
  };
  const database = db();
  if (!database) {
    memory.capabilities.set(item.id, item);
    return { capability: item, persistence: "memory" as const };
  }
  await ready(database);
  await run(
    database,
    `INSERT INTO ccv2_capabilities (id,site_id,name,description,aliases_json,search_text,contract_json,status,current_version_id,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      item.id,
      item.siteId,
      item.name,
      item.description,
      JSON.stringify(item.aliases),
      item.searchText,
      JSON.stringify(item.contract),
      item.status,
      null,
      item.createdAt,
      item.updatedAt,
      null,
    ],
  );
  return { capability: item, persistence: "database" as const };
}

export async function updateCapability(
  siteId: string,
  capabilityId: string,
  input: {
    name?: string;
    description?: string;
    aliases?: string[];
    searchText?: string;
  },
) {
  const capability = await getCapability(siteId, capabilityId, true);
  if (!capability)
    throw new CapabilityCenterV2Error(
      "capability_not_found",
      "capability_not_found",
      404,
    );
  if (capability.status === "Deleted")
    throw new CapabilityCenterV2Error(
      "capability_deleted",
      "capability_deleted",
      409,
    );
  const name = input.name?.trim() || capability.name;
  if (
    normalize(name) !== normalize(capability.name) &&
    (await listCapabilities(siteId)).capabilities.some(
      (item) =>
        item.id !== capability.id && normalize(item.name) === normalize(name),
    )
  )
    throw new CapabilityCenterV2Error(
      "capability_duplicate",
      "capability_duplicate",
      409,
    );
  const aliases = input.aliases || capability.aliases;
  const updated: Capability = {
    ...capability,
    name,
    description: input.description ?? capability.description,
    aliases,
    searchText:
      input.searchText?.trim() ||
      capabilitySearchText(
        name,
        input.description ?? capability.description,
        aliases,
      ),
    updatedAt: now(),
  };
  return saveCapability(updated);
}

export async function createDraftVersion(
  siteId: string,
  capabilityId: string,
  input: { program: CapabilityProgram; source?: CapabilityVersionSource },
) {
  const capability = await getCapability(siteId, capabilityId, true);
  if (!capability || capability.status === "Deleted")
    throw new CapabilityCenterV2Error(
      "capability_not_found",
      "capability_not_found",
      404,
    );
  const timestamp = now();
  const version: CapabilityVersion = {
    id: uid(),
    siteId,
    capabilityId,
    source: input.source || "Admin",
    program: normalizeProgram(input.program),
    status: "Draft",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return saveVersion(version);
}

export type CapabilityMaintenanceMode = "Rebuild" | "Repair";

type CapabilityMaintenanceDescriptor = {
  mode: CapabilityMaintenanceMode;
  capabilityId: string;
};

const MAINTENANCE_CAPABILITY_KEY = "__maintenanceCapabilityId";
const MAINTENANCE_MODE_KEY = "__maintenanceMode";
const ACTIVE_MAINTENANCE_STATUSES = new Set<CapabilityTaskStatus>([
  "Pending",
  "Running",
  "WaitingInput",
]);

export type CreateTaskInput = {
  type: CapabilityTaskType;
  /** Internal C3 handoff. It is never accepted from the public task API. */
  candidateArtifact?: CapabilityCandidateArtifact;
  versionId?: string;
  capabilityId?: string;
  goal: string;
  guidance?: string;
  input?: Partial<CapabilityTaskInput>;
  sourceAgentRunId?: string;
  rerunOfTaskId?: string;
  /** Control-plane only. Public task creation never forwards this field. */
  maintenance?: CapabilityMaintenanceDescriptor;
};

function maintenanceDescriptor(
  input: CapabilityTaskInput,
): CapabilityMaintenanceDescriptor | undefined {
  const capabilityId = input.context[MAINTENANCE_CAPABILITY_KEY];
  const mode = input.context[MAINTENANCE_MODE_KEY];
  return typeof capabilityId === "string" &&
    (mode === "Rebuild" || mode === "Repair")
    ? { capabilityId, mode }
    : undefined;
}

export async function listTaskArtifacts(siteId: string, taskId: string) {
  const task = await getTask(siteId, taskId, true);
  if (!task)
    throw new CapabilityCenterV2Error("task_not_found", "task_not_found", 404);
  const database = db();
  if (!database) {
    return [...memory.artifacts.values()]
      .map((item) => item.artifact)
      .filter(
        (artifact) => artifact.siteId === siteId && artifact.taskId === taskId,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  await ready(database);
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ccv2_artifacts WHERE site_id=? AND task_id=? ORDER BY created_at`,
    [siteId, taskId],
  );
  return rows.map((row): CapabilityArtifact => ({
    id: text(row.id),
    siteId: text(row.site_id),
    taskId: text(row.task_id),
    kind: text(row.kind) as CapabilityArtifact["kind"],
    storageKey: text(row.storage_key),
    contentType: text(row.content_type),
    size: Number(row.size || 0),
    createdAt: text(row.created_at),
  }));
}

export function getTaskMaintenance(task: Pick<CapabilityTask, "input">) {
  return maintenanceDescriptor(task.input);
}

function withoutReservedMaintenanceContext(
  context: CapabilityTaskInput["context"],
) {
  const rest = { ...context };
  delete rest[MAINTENANCE_CAPABILITY_KEY];
  delete rest[MAINTENANCE_MODE_KEY];
  return rest;
}

function withoutDerivedMaintenanceContext(
  context: CapabilityTaskInput["context"],
) {
  const rest = withoutReservedMaintenanceContext(context);
  delete rest.validationCases;
  return rest;
}

function schemaRequiredInputs(contract: CapabilityContract) {
  return Array.isArray(contract.inputSchema.required)
    ? contract.inputSchema.required.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
}

function schemaProperties(contract: CapabilityContract) {
  return object(contract.inputSchema.properties);
}

async function successfulSourceTask(siteId: string, versionId: string) {
  return (
    await listTasks(siteId, {
      versionId,
      includeDeleted: true,
      includeArchived: true,
    })
  ).tasks.find(
    (task) =>
      (task.type === "Discovery" || task.type === "Repair") &&
      task.status === "Succeeded" &&
      task.result?.outcome === "Success",
  );
}

async function activeMaintenanceTask(siteId: string, capabilityId: string) {
  const versionIds = new Set(
    (await listVersions(siteId, capabilityId, true)).versions.map(
      (version) => version.id,
    ),
  );
  return (
    await listTasks(siteId, { includeDeleted: true, includeArchived: true })
  ).tasks.find((task) => {
    if (!ACTIVE_MAINTENANCE_STATUSES.has(task.status)) return false;
    const descriptor = maintenanceDescriptor(task.input);
    if (descriptor?.capabilityId === capabilityId) return true;
    return (
      task.type === "Repair" &&
      typeof task.input.trigger.baseVersionId === "string" &&
      versionIds.has(task.input.trigger.baseVersionId)
    );
  });
}

export async function getCapabilityMaintenanceDefaults(
  siteId: string,
  capabilityId: string,
  requestedBaseVersionId?: string,
) {
  const capability = await getCapability(siteId, capabilityId, true);
  if (!capability || capability.status === "Deleted")
    throw new CapabilityCenterV2Error(
      "capability_not_found",
      "capability_not_found",
      404,
    );
  const baseVersionId = requestedBaseVersionId || capability.currentVersionId;
  if (!baseVersionId)
    throw new CapabilityCenterV2Error(
      "maintenance_base_version_required",
      "maintenance_base_version_required",
      409,
    );
  const baseVersion = await getVersion(siteId, baseVersionId);
  if (
    !baseVersion ||
    baseVersion.capabilityId !== capability.id ||
    (baseVersion.status !== "Published" && baseVersion.status !== "Disabled")
  )
    throw new CapabilityCenterV2Error(
      "maintenance_base_version_invalid",
      "maintenance_base_version_invalid",
      409,
    );
  const sourceTask = await successfulSourceTask(siteId, baseVersion.id);
  const properties = schemaProperties(capability.contract);
  const parameters = Object.fromEntries(
    Object.keys(properties).flatMap((key) =>
      sourceTask?.input.parameters[key] === undefined
        ? []
        : [[key, sourceTask.input.parameters[key]]],
    ),
  );
  const sourceContext = sourceTask
    ? withoutDerivedMaintenanceContext(sourceTask.input.context)
    : {};
  const startUrl =
    typeof sourceContext.startUrl === "string"
      ? sourceContext.startUrl
      : baseVersion.program.entry.mode === "Navigate" &&
          typeof baseVersion.program.entry.url === "string"
        ? baseVersion.program.entry.url
        : undefined;
  return {
    capabilityId: capability.id,
    baseVersionId: baseVersion.id,
    goal: sourceTask?.goal || capability.contract.intent || capability.name,
    guidance: sourceTask?.guidance,
    parameters,
    startUrl,
    sourceTaskId: sourceTask?.id,
    requiredInputs: schemaRequiredInputs(capability.contract),
    activeTaskId: (await activeMaintenanceTask(siteId, capability.id))?.id,
  };
}

export async function createCapabilityMaintenanceTask(
  siteId: string,
  capabilityId: string,
  input: {
    mode: CapabilityMaintenanceMode;
    baseVersionId?: string;
    sourceAgentRunId?: string;
    goal?: string;
    guidance?: string;
    parameters?: Record<string, JsonValue>;
    context?: CapabilityTaskInput["context"];
    rerunOfTaskId?: string;
  },
) {
  const defaults = await getCapabilityMaintenanceDefaults(
    siteId,
    capabilityId,
    input.baseVersionId,
  );
  if (defaults.activeTaskId)
    throw new CapabilityCenterV2Error(
      "capability_maintenance_in_progress",
      defaults.activeTaskId,
      409,
    );
  const capability = await getCapability(siteId, capabilityId, true);
  const baseVersion = await getVersion(siteId, defaults.baseVersionId);
  if (!capability || !baseVersion)
    throw new CapabilityCenterV2Error(
      "capability_not_found",
      "capability_not_found",
      404,
    );
  const sourceTask = await successfulSourceTask(siteId, baseVersion.id);
  const parameters = {
    ...(sourceTask?.input.parameters || {}),
    ...(input.parameters || {}),
  };
  const missing = schemaRequiredInputs(capability.contract).filter(
    (key) =>
      parameters[key] === undefined ||
      parameters[key] === null ||
      parameters[key] === "",
  );
  if (missing.length)
    throw new CapabilityCenterV2Error(
      "maintenance_input_required",
      `maintenance_input_required:${missing.join(",")}`,
      400,
    );
  const sourceContext = sourceTask
    ? withoutDerivedMaintenanceContext(sourceTask.input.context)
    : {};
  const fallbackStartUrl =
    baseVersion.program.entry.mode === "Navigate" &&
    typeof baseVersion.program.entry.url === "string"
      ? baseVersion.program.entry.url
      : undefined;
  const context: CapabilityTaskInput["context"] = {
    ...sourceContext,
    ...(fallbackStartUrl && typeof sourceContext.startUrl !== "string"
      ? { startUrl: fallbackStartUrl }
      : {}),
    // A rebuild runs the pipeline the capability was built with. A caller
    // that starts one with a bare context — the admin API, as opposed to the
    // console's rerun, which passes the original context — must not drop it:
    // one did, the v2 runner ran the task, and the legacy branch advanced it.
    ...(typeof sourceContext.__pipelineVersion === "string" ? { __pipelineVersion: sourceContext.__pipelineVersion } : {}),
    ...(input.context || {}),
    versionSource: "Admin",
  };
  return createCapabilityTask(siteId, {
    type: input.mode === "Repair" ? "Repair" : "Discovery",
    goal: input.goal?.trim() || defaults.goal,
    guidance:
      input.guidance?.trim() ||
      (input.mode === "Repair"
        ? "An administrator confirmed the page structure or business flow changed; explore the path again."
        : "An administrator asked for a new version of this capability to be built."),
    input: {
      parameters,
      context,
      interactions: [],
      trigger: {
        baseVersionId: baseVersion.id,
        errorCode:
          input.mode === "Repair"
            ? "admin_confirmed_page_change"
            : "admin_rebuild",
      },
      candidateSummary: {
        name: capability.name,
        description: capability.description,
        aliases: capability.aliases,
        contract: capability.contract,
      },
    },
    rerunOfTaskId: input.rerunOfTaskId,
    sourceAgentRunId: input.sourceAgentRunId,
    maintenance: { mode: input.mode, capabilityId: capability.id },
  });
}

function candidateSearchText(input: CreateTaskInput) {
  const candidate = input.input?.candidateSummary;
  return normalize(
    [
      input.goal,
      candidate?.name,
      candidate?.description,
      ...(candidate?.aliases || []),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

async function findById(siteId: string, capabilityId: string) {
  return getCapability(siteId, capabilityId, true);
}

export async function createCapabilityTask(
  siteId: string,
  input: CreateTaskInput,
) {
  const type = input.type;
  if (!type || !["Discovery", "Validation", "Repair"].includes(type))
    throw new CapabilityCenterV2Error("task_type_invalid");
  if (input.sourceAgentRunId && !input.rerunOfTaskId) {
    const existing = (
      await listTasks(siteId, { includeArchived: true, includeDeleted: true })
    ).tasks.find(
      (task) =>
        task.sourceAgentRunId === input.sourceAgentRunId &&
        task.type === type &&
        !task.rerunOfTaskId,
    );
    if (existing)
      return {
        task: existing,
        persistence: db() ? ("database" as const) : ("memory" as const),
      };
  }
  let rawTaskInput = input.input;
  if (type === "Validation" && input.versionId) {
    const source = (
      await listTasks(siteId, {
        versionId: input.versionId,
        includeDeleted: true,
        includeArchived: true,
      })
    ).tasks.find(
      (task) =>
        (task.type === "Discovery" || task.type === "Repair") &&
        task.status === "Succeeded",
    );
    if (source)
      rawTaskInput = {
        ...source.input,
        ...(input.input || {}),
        parameters: {
          ...source.input.parameters,
          ...(input.input?.parameters || {}),
        },
        context: { ...source.input.context, ...(input.input?.context || {}) },
        interactions: input.input?.interactions?.length
          ? input.input.interactions
          : source.input.interactions,
      };
  }
  let taskInput = normalizeInput({
    ...EMPTY_TASK_INPUT,
    ...(rawTaskInput || {}),
  });
  if (input.maintenance) {
    taskInput = {
      ...taskInput,
      context: {
        ...withoutReservedMaintenanceContext(taskInput.context),
        [MAINTENANCE_CAPABILITY_KEY]: input.maintenance.capabilityId,
        [MAINTENANCE_MODE_KEY]: input.maintenance.mode,
      },
    };
  } else if (type !== "Validation") {
    // Discovery is exposed to the Site SDK. Reserved control-plane markers must
    // never be accepted from its arbitrary JSON input.
    taskInput = {
      ...taskInput,
      context: withoutReservedMaintenanceContext(taskInput.context),
    };
  }
  let versionId = input.versionId || taskInput.trigger.baseVersionId || uid();
  let capability: Capability | undefined;
  let version: CapabilityVersion | undefined;
  let candidateValidationSpec: CandidateValidationTask["runSpec"] | undefined;
  if (type === "Validation" && input.candidateArtifact) {
    const artifact = input.candidateArtifact;
    versionId = artifact.candidateId;
    taskInput = normalizeInput({
      ...taskInput,
      parameters:
        artifact.validationSuite.cases[0]?.input || taskInput.parameters,
      context: {
        ...taskInput.context,
        startUrl:
          artifact.candidate.program.entry.url || taskInput.context.startUrl,
        __pipelineVersion: "2.0",
        __candidateValidation: true,
        validationCases: artifact.validationSuite.cases.map(
          (testCase) => testCase.input,
        ),
      },
      candidateSummary: {
        name: artifact.candidate.name,
        description: artifact.candidate.description,
        aliases: artifact.candidate.aliases,
        contract: artifact.candidate.contract,
      },
      program: artifact.candidate.program,
    });
    candidateValidationSpec = {
      protocolVersion: "2.0",
      candidateId: artifact.candidateId,
      artifactRef: `candidate-artifact://${siteId}/${artifact.candidateId}`,
      contractHash: artifact.contractHash,
      programHash: artifact.programHash,
      ...(artifact.validationSuiteHash
        ? { validationSuiteHash: artifact.validationSuiteHash }
        : {}),
      ...(artifact.caseDiscoveryEvidenceRef
        ? { caseDiscoveryEvidenceRef: artifact.caseDiscoveryEvidenceRef }
        : {}),
      contract: artifact.candidate.contract,
      program: artifact.candidate.program,
      cases: artifact.validationSuite.cases,
      browser: { isolation: "FreshContextPerCase", recording: true },
    };
  } else if (type === "Validation") {
    version = await getVersion(siteId, versionId);
    if (!version || version.status !== "Draft")
      throw new CapabilityCenterV2Error(
        "validation_version_invalid",
        "validation_version_invalid",
        409,
      );
    capability = await findById(siteId, version.capabilityId);
  } else if (type === "Repair") {
    const baseVersionId = taskInput.trigger.baseVersionId;
    if (!baseVersionId)
      throw new CapabilityCenterV2Error("repair_base_version_required");
    const base = await getVersion(siteId, baseVersionId);
    if (!base)
      throw new CapabilityCenterV2Error(
        "base_version_not_found",
        "base_version_not_found",
        404,
      );
    capability = await findById(siteId, base.capabilityId);
    versionId = input.versionId || uid();
  } else if (input.maintenance?.mode === "Rebuild") {
    capability = await findById(siteId, input.maintenance.capabilityId);
    const baseVersionId = taskInput.trigger.baseVersionId;
    const base = baseVersionId
      ? await getVersion(siteId, baseVersionId)
      : undefined;
    if (!capability || capability.status === "Deleted")
      throw new CapabilityCenterV2Error(
        "capability_not_found",
        "capability_not_found",
        404,
      );
    if (
      !base ||
      base.capabilityId !== capability.id ||
      (base.status !== "Published" && base.status !== "Disabled")
    )
      throw new CapabilityCenterV2Error(
        "maintenance_base_version_invalid",
        "maintenance_base_version_invalid",
        409,
      );
    versionId = input.versionId || uid();
  } else {
    const search = candidateSearchText(input);
    const replacementIds = Array.isArray(
      taskInput.context.__replacementCapabilityIds,
    )
      ? taskInput.context.__replacementCapabilityIds.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const candidates = (
      await listCapabilities(siteId, { includeDeleted: false })
    // Disabling a capability is the operator saying "do not use this one". It
    // used to also mean "never make one of these again": the goal was blocked
    // and the only way to generate it was to delete the capability outright.
    // A disabled capability answers no caller, so a new one does not duplicate
    // it.
    ).capabilities.filter(
      (item) => item.status === "Active" || item.status === "Building",
    );
    const duplicate = candidates.find((item) => {
      if (replacementIds.includes(item.id)) return false;
      const parts = search.split(/\s+/).filter(Boolean);
      return (
        parts.length > 0 &&
        parts.every((part) => item.searchText.includes(part))
      );
    });
    if (duplicate)
      throw new CapabilityCenterV2Error("capability_duplicate", "capability_duplicate", 409);
  }
  const createdAt = now();
  const task: CapabilityTask = {
    id: uid(),
    siteId,
    versionId,
    type,
    status: taskStatusForInput(taskInput),
    goal: text(input.goal).trim(),
    guidance: text(input.guidance) || undefined,
    input: taskInput,
    sourceAgentRunId: text(input.sourceAgentRunId) || undefined,
    rerunOfTaskId: text(input.rerunOfTaskId) || undefined,
    createdAt,
    updatedAt: createdAt,
  };
  if (!task.goal) throw new CapabilityCenterV2Error("task_goal_required");
  if (task.status === "Pending") {
    task.runSpec = candidateValidationSpec
      ? {
          protocolVersion: "2.0",
          id: uid(),
          taskId: task.id,
          siteId: task.siteId,
          goal: task.goal,
          browser: candidateValidationSpec.browser,
          input: task.input,
          contract: candidateValidationSpec.contract,
          plan: [{ type: "Replay", program: candidateValidationSpec.program }],
          candidateValidation: candidateValidationSpec,
        }
      : buildRunSpec(task, version, capability);
  }
  const database = db();
  if (!database) {
    const duplicate =
      input.sourceAgentRunId && !input.rerunOfTaskId
        ? [...memory.tasks.values()].find(
            (item) =>
              item.siteId === siteId &&
              item.sourceAgentRunId === input.sourceAgentRunId &&
              item.type === type &&
              !item.rerunOfTaskId,
          )
        : undefined;
    if (duplicate) return { task: duplicate, persistence: "memory" as const };
    memory.tasks.set(task.id, task);
  } else {
    await ready(database);
    try {
      await run(
        database,
        `INSERT INTO ccv2_capability_tasks (id,site_id,version_id,type,status,goal,guidance,input_json,run_spec_json,runner_id,result_json,error_json,source_agent_run_id,rerun_of_task_id,created_at,started_at,updated_at,finished_at,archived_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          task.id,
          task.siteId,
          task.versionId,
          task.type,
          task.status,
          task.goal,
          task.guidance || null,
          JSON.stringify(task.input),
          task.runSpec ? JSON.stringify(task.runSpec) : null,
          null,
          null,
          null,
          task.sourceAgentRunId || null,
          task.rerunOfTaskId || null,
          task.createdAt,
          null,
          task.updatedAt,
          null,
          null,
          null,
        ],
      );
    } catch (error) {
      if (input.sourceAgentRunId && !input.rerunOfTaskId) {
        const existing = (
          await listTasks(siteId, {
            includeArchived: true,
            includeDeleted: true,
          })
        ).tasks.find(
          (item) =>
            item.sourceAgentRunId === input.sourceAgentRunId &&
            item.type === type &&
            !item.rerunOfTaskId,
        );
        if (existing)
          return { task: existing, persistence: "database" as const };
      }
      throw error;
    }
  }
  await appendTaskEvent(siteId, task.id, {
    eventType: "TaskCreated",
    payload: {
      type: task.type,
      status: task.status,
      versionId: task.versionId,
      rerunOfTaskId: task.rerunOfTaskId || null,
    },
  }).catch((error) =>
    console.warn("[capability-debug] TaskCreated event failed", {
      taskId: task.id,
      error,
    }),
  );
  if (task.runSpec)
    await appendTaskEvent(siteId, task.id, {
      eventType: "RunSpecBuilt",
      payload: {
        phase: "RunSpec",
        runSpecId: task.runSpec.id,
        plan: task.runSpec.plan.map((item) => item.type),
      },
    }).catch((error) =>
      console.warn("[capability-debug] RunSpecBuilt event failed", {
        taskId: task.id,
        error,
      }),
    );
  return {
    task,
    persistence: database ? ("database" as const) : ("memory" as const),
  };
}

export async function patchPendingTask(
  siteId: string,
  taskId: string,
  patch: {
    goal?: string;
    guidance?: string;
    input?: Partial<CapabilityTaskInput>;
  },
) {
  const task = await getTask(siteId, taskId);
  if (!task)
    throw new CapabilityCenterV2Error("task_not_found", "task_not_found", 404);
  if (task.status !== "Pending")
    throw new CapabilityCenterV2Error(
      "task_not_pending",
      "task_not_pending",
      409,
    );
  const updatedInput = patch.input
    ? normalizeInput({ ...task.input, ...patch.input })
    : task.input;
  const updated: CapabilityTask = {
    ...task,
    goal: patch.goal?.trim() || task.goal,
    guidance: patch.guidance ?? task.guidance,
    input: updatedInput,
    updatedAt: now(),
  };
  updated.runSpec = buildRunSpec(
    updated,
    await getVersion(siteId, updated.versionId),
    await getCapabilityForVersion(siteId, updated.versionId),
  );
  return saveTask(updated);
}

function interactionSecret() {
  const configured =
    typeof process !== "undefined"
      ? process.env.CAPABILITY_V2_INPUT_KEY?.trim()
      : undefined;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production")
    throw new CapabilityCenterV2Error(
      "capability_input_key_missing",
      "capability_input_key_missing",
      503,
    );
  return "capability-center-v2-development-key";
}

async function interactionKey(usages: KeyUsage[]) {
  const secret = interactionSecret();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, usages);
}

async function encryptInteraction(values: Record<string, unknown>) {
  const key = await interactionKey(["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(values)),
    ),
  );
  const bytes = new Uint8Array(iv.length + encrypted.length);
  bytes.set(iv);
  bytes.set(encrypted, iv.length);
  let encoded = "";
  for (const byte of bytes) encoded += String.fromCharCode(byte);
  return `aes256gcm:v1:${btoa(encoded)}`;
}

async function decryptInteraction(payload: string) {
  const encoded = payload.split(":")[2];
  if (!encoded)
    throw new CapabilityCenterV2Error(
      "interaction_payload_invalid",
      "interaction_payload_invalid",
      400,
    );
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const iv = bytes.slice(0, 12);
  const encrypted = bytes.slice(12);
  const key = await interactionKey(["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    encrypted,
  );
  return JSON.parse(new TextDecoder().decode(plain)) as Record<
    string,
    JsonValue
  >;
}

function sanitizedTaskInput(input: CapabilityTaskInput) {
  return {
    ...input,
    interactions: input.interactions.map((interaction) => ({
      ...interaction,
      response: interaction.response
        ? {
            values: {},
            keyVersion: interaction.response.keyVersion,
            expiresAt: interaction.response.expiresAt,
          }
        : undefined,
    })),
  } satisfies CapabilityTaskInput;
}

export function sanitizeTaskForClient(task: CapabilityTask) {
  return {
    ...task,
    input: sanitizedTaskInput(task.input),
    runSpec: undefined,
  } satisfies CapabilityTask;
}

export function sanitizeTaskForAdmin(task: CapabilityTask) {
  return {
    ...task,
    input: sanitizedTaskInput(task.input),
    runSpec: task.runSpec
      ? { ...task.runSpec, input: sanitizedTaskInput(task.runSpec.input) }
      : undefined,
  } satisfies CapabilityTask;
}

export async function getRunnerRunSpec(
  siteId: string,
  taskId: string,
  runnerId: string,
) {
  const task = await getTask(siteId, taskId, true);
  if (!task)
    throw new CapabilityCenterV2Error("task_not_found", "task_not_found", 404);
  if (!runnerId || task.runnerId !== runnerId)
    throw new CapabilityCenterV2Error(
      "runner_mismatch",
      "runner_mismatch",
      409,
    );
  if (!task.runSpec)
    throw new CapabilityCenterV2Error(
      "run_spec_not_ready",
      "run_spec_not_ready",
      409,
    );
  const parameters: Record<string, JsonValue> = {
    ...task.runSpec.input.parameters,
  };
  const resolvedSecrets: JsonObject = {};
  for (const interaction of task.input.interactions) {
    const response = interaction.response;
    if (interaction.status !== "Provided" || !response?.encryptedPayload)
      continue;
    if (response.expiresAt && Date.parse(response.expiresAt) <= Date.now()) {
      const interactions = task.input.interactions.map((item) =>
        item.id === interaction.id
          ? { ...item, status: "Requested" as const, response: undefined }
          : item,
      );
      await saveTask({
        ...task,
        status: "WaitingInput",
        input: { ...task.input, interactions },
        runnerId: undefined,
        updatedAt: now(),
      });
      throw new CapabilityCenterV2Error(
        "interaction_expired",
        "interaction_expired",
        409,
      );
    }
    const values = await decryptInteraction(response.encryptedPayload);
    const sensitive = new Set(
      interaction.fields
        .filter((field) => field.sensitive)
        .map((field) => field.key),
    );
    for (const [key, value] of Object.entries(values)) {
      if (sensitive.has(key)) resolvedSecrets[key] = value;
      else parameters[key] = value;
    }
  }
  return {
    ...task.runSpec,
    input: { ...task.runSpec.input, parameters },
    ...(Object.keys(resolvedSecrets).length ? { resolvedSecrets } : {}),
  } satisfies RunSpec;
}

export async function requestTaskInteraction(
  siteId: string,
  taskId: string,
  runnerId: string,
  interaction: TaskInteraction,
) {
  const task = await getTask(siteId, taskId, true);
  if (!task)
    throw new CapabilityCenterV2Error("task_not_found", "task_not_found", 404);
  if (task.runnerId !== runnerId || task.status !== "Running")
    throw new CapabilityCenterV2Error(
      "runner_mismatch",
      "runner_mismatch",
      409,
    );
  const existing = task.input.interactions.find(
    (item) => item.id === interaction.id,
  );
  const interactions = existing
    ? task.input.interactions.map((item) =>
        item.id === interaction.id ? interaction : item,
      )
    : [...task.input.interactions, interaction];
  return saveTask({
    ...task,
    status: "WaitingInput",
    input: { ...task.input, interactions },
    updatedAt: now(),
  });
}

export async function respondTaskInteraction(
  siteId: string,
  taskId: string,
  interactionId: string,
  values: Record<string, unknown>,
) {
  const task = await getTask(siteId, taskId);
  if (!task)
    throw new CapabilityCenterV2Error("task_not_found", "task_not_found", 404);
  if (task.status !== "WaitingInput")
    throw new CapabilityCenterV2Error(
      "task_not_waiting_input",
      "task_not_waiting_input",
      409,
    );
  const interaction = task.input.interactions.find(
    (item) => item.id === interactionId,
  );
  if (!interaction || interaction.status !== "Requested")
    throw new CapabilityCenterV2Error(
      "interaction_not_requested",
      "interaction_not_requested",
      409,
    );
  const required = interaction.fields
    .filter((field) => field.required)
    .map((field) => field.key);
  if (
    required.some(
      (key) =>
        values[key] === undefined || values[key] === null || values[key] === "",
    )
  )
    throw new CapabilityCenterV2Error(
      "interaction_fields_required",
      "interaction_fields_required",
      400,
    );
  const encryptedPayload = await encryptInteraction(values);
  const updatedInteractions = task.input.interactions.map((item) =>
    item.id === interactionId
      ? {
          ...item,
          status: "Provided" as const,
          response: {
            values: {},
            encryptedPayload,
            keyVersion: "v1",
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          },
        }
      : item,
  );
  const input = { ...task.input, interactions: updatedInteractions };
  const resumeStatus: CapabilityTaskStatus =
    interaction.resumeMode === "Continue" && task.runnerId
      ? "Running"
      : "Pending";
  const updated: CapabilityTask = {
    ...task,
    input,
    status: resumeStatus,
    runnerId: resumeStatus === "Pending" ? undefined : task.runnerId,
    updatedAt: now(),
  };
  if (resumeStatus === "Pending")
    updated.runSpec = buildRunSpec(
      updated,
      await getVersion(siteId, task.versionId),
      await getCapabilityForVersion(siteId, task.versionId),
    );
  return saveTask(updated);
}

async function getCapabilityForVersion(siteId: string, versionId: string) {
  const version = await getVersion(siteId, versionId, true);
  return version
    ? getCapability(siteId, version.capabilityId, true)
    : undefined;
}

async function saveTask(task: CapabilityTask) {
  const database = db();
  if (!database) {
    memory.tasks.set(task.id, task);
    return { task, persistence: "memory" as const };
  }
  await ready(database);
  await run(
    database,
    `UPDATE ccv2_capability_tasks SET status=?,goal=?,guidance=?,input_json=?,run_spec_json=?,runner_id=?,updated_at=? WHERE id=? AND site_id=?`,
    [
      task.status,
      task.goal,
      task.guidance || null,
      JSON.stringify(task.input),
      task.runSpec ? JSON.stringify(task.runSpec) : null,
      task.runnerId || null,
      task.updatedAt,
      task.id,
      task.siteId,
    ],
  );
  return { task, persistence: "database" as const };
}

export async function claimTask(
  siteId: string,
  taskId: string,
  runnerId: string,
) {
  const task = await getTask(siteId, taskId);
  if (!task)
    throw new CapabilityCenterV2Error("task_not_found", "task_not_found", 404);
  if (task.status !== "Pending" || task.runnerId)
    throw new CapabilityCenterV2Error(
      "task_not_claimable",
      "task_not_claimable",
      409,
    );
  const updated: CapabilityTask = {
    ...task,
    status: "Running",
    runnerId,
    error: undefined,
    startedAt: task.startedAt || now(),
    updatedAt: now(),
  };
  const database = db();
  if (!database) {
    memory.tasks.set(task.id, updated);
    return { task: updated, persistence: "memory" as const };
  }
  await ready(database);
  const result = await database
    .prepare(
      `UPDATE ccv2_capability_tasks SET status='Running',runner_id=?,error_json=NULL,started_at=?,updated_at=? WHERE id=? AND site_id=? AND status='Pending' AND runner_id IS NULL`,
    )
    .bind(runnerId, updated.startedAt, updated.updatedAt, taskId, siteId)
    .run();
  if (
    !result.success ||
    (result.meta && Number(result.meta.changes || 0) !== 1)
  )
    throw new CapabilityCenterV2Error(
      "task_not_claimable",
      "task_not_claimable",
      409,
    );
  return { task: updated, persistence: "database" as const };
}

export async function releaseTaskClaim(
  siteId: string,
  taskId: string,
  runnerId: string,
  reason = "runner_launch_failed",
) {
  const task = await getTask(siteId, taskId, true);
  if (!task || task.runnerId !== runnerId || isTerminalTaskStatus(task.status))
    return task;
  const updated = {
    ...task,
    status: "Pending" as const,
    runnerId: undefined,
    error: { code: reason, message: reason, retryable: true },
    updatedAt: now(),
  };
  return (await saveTaskFull(updated)).task;
}

/** Build C3's immutable output package from the exact frozen artifact and Runner result. */
export function createValidatedCapabilityPackage(
  artifact: CapabilityCandidateArtifact,
  validationTaskId: string,
  result: CapabilityTaskResult,
): ValidatedCapabilityPackage {
  if (!Array.isArray(result.validationResults)) {
    throw new CapabilityCenterV2Error(
      "validation_results_required",
      "validation_results_required",
      409,
    );
  }
  const cases = result.validationResults;
  if (cases.length !== artifact.validationSuite.cases.length) {
    throw new CapabilityCenterV2Error(
      "validation_case_count_mismatch",
      "validation_case_count_mismatch",
      409,
    );
  }
  const suiteHash = capabilityValidationSuiteHash(artifact.validationSuite);
  if (
    artifact.validationSuiteHash &&
    artifact.validationSuiteHash !== suiteHash
  ) {
    throw new CapabilityCenterV2Error(
      "validation_suite_hash_mismatch",
      "validation_suite_hash_mismatch",
      409,
    );
  }
  const drifts = new Map<string, ExpectedOutputDrift[]>();
  for (
    let index = 0;
    index < artifact.validationSuite.cases.length;
    index += 1
  ) {
    const frozen = artifact.validationSuite.cases[index];
    const actual = cases[index];
    const expectedResolvedInput = resolveCapabilityInputDefaults(
      artifact.candidate.contract,
      frozen.input,
    );
    if (
      actual.caseId !== frozen.caseId ||
      JSON.stringify(canonicalJsonValue(actual.resolvedInput)) !==
        JSON.stringify(canonicalJsonValue(expectedResolvedInput))
    ) {
      throw new CapabilityCenterV2Error(
        "validation_case_identity_mismatch",
        "validation_case_identity_mismatch",
        409,
      );
    }
    if (
      !actual.output ||
      typeof actual.output !== "object" ||
      Array.isArray(actual.output)
    ) {
      throw new CapabilityCenterV2Error(
        "validation_case_output_invalid",
        "validation_case_output_invalid",
        409,
      );
    }
    // A case the capability answered with "this input has nothing to show"
    // carries no success receipt and no evidence, because there was nothing to
    // evidence. Neither does one that did not work. Both are recorded as what
    // they are; the review turn reads them beside the cases that did work.
    if (actual.noResultReason || actual.failureReason) continue;
    const declaredStageIds = new Set(
      artifact.candidate.program.stages.map((stage) => stage.id),
    );
    if (
      !Array.isArray(actual.stageReceipts) ||
      actual.stageReceipts.length === 0 ||
      actual.stageReceipts.some(
        (receipt) =>
          !declaredStageIds.has(receipt.stageId) ||
          receipt.outcome !== "Success",
      )
    ) {
      throw new CapabilityCenterV2Error(
        "validation_stage_receipts_invalid",
        "validation_stage_receipts_invalid",
        409,
      );
    }
    if (
      !Array.isArray(actual.evidenceRefs) ||
      actual.evidenceRefs.length === 0
    ) {
      throw new CapabilityCenterV2Error(
        "validation_case_evidence_required",
        "validation_case_evidence_required",
        409,
      );
    }
    const caseEvidenceRefs = new Set(actual.evidenceRefs);
    if (
      actual.stageReceipts.some(
        (receipt) =>
          !Array.isArray(receipt.evidenceRefs) ||
          receipt.evidenceRefs.length === 0 ||
          receipt.evidenceRefs.some((ref) => !caseEvidenceRefs.has(ref)),
      )
    ) {
      throw new CapabilityCenterV2Error(
        "validation_receipt_evidence_mismatch",
        "validation_receipt_evidence_mismatch",
        409,
      );
    }
    // The same graded rule C3 applied, re-derived here from the frozen suite
    // and the reported output: what C3 called drift must really be drift.
    const comparison = compareCapabilityExpectedOutput({
      expected: frozen.expected,
      actual: actual.output,
      input: expectedResolvedInput,
    });
    drifts.set(frozen.caseId, comparison.drift);
  }
  return {
    artifact,
    validationTaskId,
    validation: {
      candidateId: artifact.candidateId,
      contractHash: artifact.contractHash,
      programHash: artifact.programHash,
      cases: cases.map((item) => {
        const outputDrift = drifts.get(item.caseId) || [];
        const { outputDrift: _reported, ...rest } = item;
        if (item.noResultReason) return { ...rest, outcome: "NoResult" as const };
        if (item.failureReason) return { ...rest, outcome: "Failed" as const };
        return { ...rest, outcome: "Passed" as const, ...(outputDrift.length ? { outputDrift } : {}) };
      }),
    },
  };
}

export async function submitTaskResult(
  siteId: string,
  taskId: string,
  runnerId: string,
  result: CapabilityTaskResult,
  error?: CapabilityTaskError,
) {
  const task = await getTask(siteId, taskId, true);
  if (!task)
    throw new CapabilityCenterV2Error("task_not_found", "task_not_found", 404);
  if (task.runnerId !== runnerId)
    throw new CapabilityCenterV2Error(
      "runner_mismatch",
      "runner_mismatch",
      409,
    );
  if (isTerminalTaskStatus(task.status)) {
    if (JSON.stringify(task.result) === JSON.stringify(result))
      return {
        task,
        persistence: db() ? ("database" as const) : ("memory" as const),
      };
    throw new CapabilityCenterV2Error(
      "task_already_terminal",
      "task_already_terminal",
      409,
    );
  }
  const succeeded =
    result.outcome === "Success" || result.outcome === "Duplicate";
  const finishedAt = now();
  const moduleV2 =
    task.input.context.__pipelineVersion === "2.0" ||
    Boolean(result.c2CaseGenerationOutput);
  const completedInput: CapabilityTaskInput =
    (task.type === "Discovery" || task.type === "Repair") &&
    result.outcome === "Success"
      ? {
          ...task.input,
          parameters: result.demonstrationParameters || task.input.parameters,
          context: {
            ...task.input.context,
            ...(!moduleV2 && legacyValidationCases(result).length
              ? { validationCases: legacyValidationCases(result) }
              : {}),
          },
        }
      : task.input;
  let updated: CapabilityTask = {
    ...task,
    input: completedInput,
    status: succeeded ? "Succeeded" : "Failed",
    result,
    error:
      error ||
      (!succeeded
        ? {
            code: result.outcome.toLowerCase(),
            message: result.outcome,
            retryable: result.outcome === "ExecutionFailure",
          }
        : undefined),
    updatedAt: finishedAt,
    finishedAt,
  };
  // A formal C2 output is itself authoritative proof that this result belongs
  // to the C1 → C2 pipeline. The private marker also makes downgrade
  // attempts fail closed instead of falling back to historical validationCases.
  if (
    moduleV2 &&
    (task.type === "Discovery" || task.type === "Repair") &&
    result.outcome === "Success"
  ) {
    const {
      c1AuthoringOutput: _rawC1,
      c2CaseGenerationOutput: _rawC2,
      ...boundarySafeResult
    } = result;
    const failBoundary = (
      stage: "Authoring" | "CaseGeneration",
      code: string,
    ) =>
      saveTaskFull({
        ...updated,
        status: "Failed",
        result: {
          ...boundarySafeResult,
          outcome: "BusinessRejection",
          buildResult: {
            outcome: "Failed",
            stage,
            code,
            reason: code,
            evidenceRefs: [],
          },
        },
        error: { code, message: code, retryable: false },
      });
    if (!result.c1AuthoringOutput)
      return failBoundary("Authoring", "c1_authoring_output_required");
    if (!result.c2CaseGenerationOutput)
      return failBoundary(
        "CaseGeneration",
        "c2_case_generation_output_required",
      );
    let c1AuthoringOutput;
    let c2CaseGenerationOutput;
    try {
      c1AuthoringOutput = decodeC1AuthoringOutput(result.c1AuthoringOutput);
    } catch {
      return failBoundary("Authoring", "c1_authoring_output_invalid");
    }
    try {
      c2CaseGenerationOutput = decodeC2CaseGenerationOutput(
        result.c2CaseGenerationOutput,
      );
    } catch {
      return failBoundary(
        "CaseGeneration",
        "c2_case_generation_output_invalid",
      );
    }
    updated = {
      ...updated,
      result: { ...result, c1AuthoringOutput, c2CaseGenerationOutput },
    };
    if (
      c1AuthoringOutput.generationTaskId !== task.id ||
      c2CaseGenerationOutput.generationTaskId !== task.id
    ) {
      return failBoundary("CaseGeneration", "case_generation_task_mismatch");
    }
    const c1Candidate = {
      name: c1AuthoringOutput.name,
      description: c1AuthoringOutput.description,
      aliases: c1AuthoringOutput.aliases,
      contract: c1AuthoringOutput.contract,
      program: c1AuthoringOutput.program,
      ...(c1AuthoringOutput.replacementPlan
        ? { replacementPlan: c1AuthoringOutput.replacementPlan }
        : {}),
    };
    if (
      JSON.stringify(canonicalJsonValue(c1Candidate)) !==
      JSON.stringify(canonicalJsonValue(c2CaseGenerationOutput.candidate))
    ) {
      return failBoundary(
        "CaseGeneration",
        "case_generation_candidate_mutated",
      );
    }
    try {
      // `updated.input.parameters` already carries the runner's demonstration
      // values; the candidate gate reads them from the task it is given.
      const committed = await completeC2CaseGeneration(
        siteId,
        updated,
        c2CaseGenerationOutput,
      );
      const artifact = committed.artifact;
      updated = {
        ...updated,
        result: {
          ...result,
          candidateArtifact: artifact,
          validationTaskId: committed.validationTask.id,
        },
      };
      return saveTaskFull(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return saveTaskFull({
        ...updated,
        status: "Failed",
        result: { ...result, outcome: "BusinessRejection" },
        error: {
          code: "candidate_artifact_gate_failed",
          // Regenerating re-authors: the checkpoint is held to these same
          // gates before it is reused, so the model is asked to repair what
          // was refused here instead of being handed the refused code again.
          // Marking this un-retryable left the reader with a dead record and
          // no way forward.
          message,
          retryable: true,
        },
      });
    }
  }
  if (moduleV2 && task.type === "Validation" && result.outcome === "Success") {
    try {
      const artifact = await getCapabilityCandidateArtifact(
        siteId,
        task.versionId,
      );
      if (!artifact)
        throw new CapabilityCenterV2Error(
          "candidate_artifact_not_found",
          "candidate_artifact_not_found",
          404,
        );
      const validatedPackage = createValidatedCapabilityPackage(
        artifact,
        task.id,
        result,
      );
      const buildResult: CapabilityBuildResult = {
        outcome: "Validated",
        package: validatedPackage,
      };
      return saveTaskFull({
        ...updated,
        result: { ...result, candidateArtifact: artifact, buildResult },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return saveTaskFull({
        ...updated,
        status: "Failed",
        result: { ...result, outcome: "BusinessRejection" },
        error: {
          code: "candidate_validation_result_invalid",
          message,
          retryable: false,
        },
      });
    }
  }
  if (task.type === "Discovery" && result.outcome === "Success") {
    if (!result.candidateProgram && !task.input.program)
      throw new CapabilityCenterV2Error(
        "candidate_program_required",
        "candidate_program_required",
        409,
      );
    if (!result.candidateSource?.trim())
      throw new CapabilityCenterV2Error(
        "candidate_source_required",
        "candidate_source_required",
        409,
      );
    const candidate = result.candidateSummary ||
      task.input.candidateSummary || {
        name: task.goal,
        description: task.goal,
        aliases: [],
      };
    const maintenance = maintenanceDescriptor(task.input);
    const targetCapability =
      maintenance?.mode === "Rebuild"
        ? await getCapability(siteId, maintenance.capabilityId, true)
        : undefined;
    if (
      maintenance?.mode === "Rebuild" &&
      (!targetCapability || targetCapability.status === "Deleted")
    )
      throw new CapabilityCenterV2Error(
        "capability_not_found",
        "capability_not_found",
        404,
      );
    const contract =
      targetCapability?.contract || defaultContract(candidate.contract);
    const program = normalizeProgram(
      result.candidateProgram || task.input.program,
    );
    if (!(await getCapabilityV2Module(siteId, program.module.contentHash)))
      throw new CapabilityCenterV2Error(
        "candidate_module_missing",
        "candidate_module_missing",
        409,
      );
    const quality = inspectCapabilityQuality(contract, program, {
      demonstrationParameters: demonstrationParametersOf({ ...task, result }),
      validationCases: legacyValidationCases(result),
      requireIndependentCases: true,
      source: result.candidateSource,
      summary: targetCapability
        ? {
            name: targetCapability.name,
            description: targetCapability.description,
            aliases: targetCapability.aliases,
          }
        : {
            name: candidate.name,
            description: candidate.description,
            aliases: candidate.aliases,
          },
    });
    if (!quality.valid) {
      const message = `capability_quality_rejected:${quality.issues.map((issue) => issue.code).join(",")}`;
      return saveTaskFull({
        ...updated,
        status: "Failed",
        result: { ...result, outcome: "BusinessRejection" },
        error: {
          code: "capability_quality_rejected",
          message,
          retryable: false,
        },
      });
    }
    if (targetCapability) {
      const version: CapabilityVersion = {
        id: task.versionId,
        siteId,
        capabilityId: targetCapability.id,
        source: versionSourceFromTask(task),
        program,
        status: "Draft",
        createdAt: finishedAt,
        updatedAt: finishedAt,
      };
      await saveVersion(version);
      updated = {
        ...updated,
        versionId: version.id,
        result: {
          ...result,
          capabilityId: targetCapability.id,
          versionId: version.id,
        },
      };
    } else {
      const duplicate = (
        await listCapabilities(siteId, { includeDeleted: false })
      ).capabilities.find(
        (item) =>
          normalize(item.name) === normalize(candidate.name || task.goal),
      );
      if (duplicate) {
        updated = {
          ...updated,
          result: {
            ...result,
            outcome: "Duplicate",
            existingCapabilityId: duplicate.id,
            capabilityId: duplicate.id,
            candidateProgram: undefined,
          },
        };
      } else {
        const capability = (
          await createCapability(siteId, {
            name: candidate.name || task.goal,
            description: candidate.description || task.goal,
            aliases: candidate.aliases || [],
            contract,
          })
        ).capability;
        const version: CapabilityVersion = {
          id: task.versionId,
          siteId,
          capabilityId: capability.id,
          source: versionSourceFromTask(task),
          program,
          status: "Draft",
          createdAt: finishedAt,
          updatedAt: finishedAt,
        };
        await saveVersion(version);
        updated = {
          ...updated,
          versionId: version.id,
          result: {
            ...result,
            capabilityId: capability.id,
            versionId: version.id,
          },
        };
      }
    }
  }
  if (task.type === "Repair" && result.outcome === "Success") {
    const base = task.input.trigger.baseVersionId
      ? await getVersion(siteId, task.input.trigger.baseVersionId)
      : undefined;
    if (base) {
      if (!result.candidateProgram && !task.input.program)
        throw new CapabilityCenterV2Error(
          "candidate_program_required",
          "candidate_program_required",
          409,
        );
      if (!result.candidateSource?.trim())
        throw new CapabilityCenterV2Error(
          "candidate_source_required",
          "candidate_source_required",
          409,
        );
      const capability = await getCapability(siteId, base.capabilityId, true);
      if (!capability)
        throw new CapabilityCenterV2Error(
          "capability_not_found",
          "capability_not_found",
          404,
        );
      const program = normalizeProgram(
        result.candidateProgram || task.input.program,
      );
      if (!(await getCapabilityV2Module(siteId, program.module.contentHash)))
        throw new CapabilityCenterV2Error(
          "candidate_module_missing",
          "candidate_module_missing",
          409,
        );
      const quality = inspectCapabilityQuality(capability.contract, program, {
        demonstrationParameters: demonstrationParametersOf({ ...task, result }),
        validationCases: legacyValidationCases(result),
        requireIndependentCases: true,
        source: result.candidateSource,
        summary: {
          name: capability.name,
          description: capability.description,
          aliases: capability.aliases,
        },
      });
      if (!quality.valid) {
        const message = `capability_quality_rejected:${quality.issues.map((issue) => issue.code).join(",")}`;
        return saveTaskFull({
          ...updated,
          status: "Failed",
          result: { ...result, outcome: "BusinessRejection" },
          error: {
            code: "capability_quality_rejected",
            message,
            retryable: false,
          },
        });
      }
      const version: CapabilityVersion = {
        id: task.versionId,
        siteId,
        capabilityId: base.capabilityId,
        source: versionSourceFromTask(task),
        program,
        status: "Draft",
        createdAt: finishedAt,
        updatedAt: finishedAt,
      };
      await saveVersion(version);
      updated = {
        ...updated,
        result: {
          ...result,
          capabilityId: base.capabilityId,
          versionId: version.id,
        },
      };
    }
  }
  if (task.type === "Validation" && result.outcome === "Success") {
    const version = await getVersion(siteId, task.versionId, true);
    const capability = version
      ? await getCapability(siteId, version.capabilityId, true)
      : undefined;
    if (version && capability) {
      const validationCases = Array.isArray(task.input.context.validationCases)
        ? task.input.context.validationCases.filter(
            (value): value is Record<string, JsonValue> =>
              Boolean(value) &&
              typeof value === "object" &&
              !Array.isArray(value),
          )
        : [];
      const rerunSourceTask = task.rerunOfTaskId
        ? await getTask(siteId, task.rerunOfTaskId, true)
        : undefined;
      const sourceTask = rerunSourceTask?.result?.candidateSource
        ? rerunSourceTask
        : await successfulSourceTask(siteId, version.id);
      const quality = inspectCapabilityQuality(
        capability.contract,
        version.program,
        {
          demonstrationParameters: demonstrationParametersOf(sourceTask),
          validationCases,
          requireIndependentCases: true,
          requireTargetEvidence: version.program.targetBindings.length > 0,
          targetEvidence: result.targetEvidence,
          source: sourceTask?.result?.candidateSource,
          summary: {
            name: capability.name,
            description: capability.description,
            aliases: capability.aliases,
          },
        },
      );
      if (
        !quality.valid ||
        (validationCases.length &&
          result.validationCaseCount !== validationCases.length)
      ) {
        const codes = [
          ...quality.issues.map((issue) => issue.code),
          ...(validationCases.length &&
          result.validationCaseCount !== validationCases.length
            ? ["validation_case_count_mismatch"]
            : []),
        ];
        return saveTaskFull({
          ...updated,
          status: "Failed",
          result: { ...result, outcome: "BusinessRejection" },
          error: {
            code: "capability_quality_rejected",
            message: `capability_quality_rejected:${codes.join(",")}`,
            retryable: false,
          },
        });
      }
      await saveVersion({
        ...version,
        review: { ...(version.review || {}), ai: { status: "Pending" } },
        updatedAt: finishedAt,
      });
    }
  }
  return saveTaskFull(updated);
}

/**
 * Attach the immutable D publication receipt to the task chain after Review
 * has approved a validated Candidate.  This is a projection update only: D
 * already performed the single transactional Capability/Version write, and
 * these identifiers let the task/debug read models resolve the published
 * version without changing any public task schema.
 */
export async function recordCapabilityTaskPublication(
  siteId: string,
  taskId: string,
  publication: { capabilityId: string; versionId: string },
) {
  const task = await getTask(siteId, taskId, true);
  if (!task || !task.result)
    return {
      task,
      persistence: db() ? ("database" as const) : ("memory" as const),
    };
  return saveTaskFull({
    ...task,
    result: {
      ...task.result,
      capabilityId: publication.capabilityId,
      versionId: publication.versionId,
    },
    updatedAt: now(),
  });
}

async function saveTaskFull(task: CapabilityTask) {
  const database = db();
  if (!database) {
    memory.tasks.set(task.id, task);
    return { task, persistence: "memory" as const };
  }
  await ready(database);
  await run(
    database,
    `UPDATE ccv2_capability_tasks SET status=?,input_json=?,run_spec_json=?,result_json=?,error_json=?,runner_id=?,updated_at=?,finished_at=?,archived_at=?,deleted_at=? WHERE id=? AND site_id=?`,
    [
      task.status,
      JSON.stringify(task.input),
      task.runSpec ? JSON.stringify(task.runSpec) : null,
      task.result ? JSON.stringify(task.result) : null,
      task.error ? JSON.stringify(task.error) : null,
      task.runnerId || null,
      task.updatedAt,
      task.finishedAt || null,
      task.archivedAt || null,
      task.deletedAt || null,
      task.id,
      task.siteId,
    ],
  );
  return { task, persistence: "database" as const };
}

async function saveVersion(version: CapabilityVersion) {
  const database = db();
  if (!database) {
    memory.versions.set(version.id, version);
    return { version, persistence: "memory" as const };
  }
  await ready(database);
  const existing = await getVersion(version.siteId, version.id, true);
  if (existing)
    await run(
      database,
      `UPDATE ccv2_capability_versions SET program_json=?,status=?,review_json=?,updated_at=?,published_at=?,deleted_at=? WHERE id=? AND site_id=?`,
      [
        JSON.stringify(version.program),
        version.status,
        version.review ? JSON.stringify(version.review) : null,
        version.updatedAt,
        version.publishedAt || null,
        version.deletedAt || null,
        version.id,
        version.siteId,
      ],
    );
  else
    await run(
      database,
      `INSERT INTO ccv2_capability_versions (id,site_id,capability_id,source,program_json,status,review_json,created_at,updated_at,published_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        version.id,
        version.siteId,
        version.capabilityId,
        version.source,
        JSON.stringify(version.program),
        version.status,
        version.review ? JSON.stringify(version.review) : null,
        version.createdAt,
        version.updatedAt,
        version.publishedAt || null,
        version.deletedAt || null,
      ],
    );
  return { version, persistence: "database" as const };
}

export async function beginVersionReview(
  siteId: string,
  versionId: string,
  input: {
    promptKey: string;
    promptVersion: string;
    promptHash: string;
    model: string;
  },
) {
  const version = await getVersion(siteId, versionId);
  if (!version)
    throw new CapabilityCenterV2Error(
      "version_not_found",
      "version_not_found",
      404,
    );
  if (version.status !== "Draft")
    throw new CapabilityCenterV2Error(
      "version_not_draft",
      "version_not_draft",
      409,
    );
  const timestamp = now();
  const reviewing: CapabilityVersion = {
    ...version,
    review: {
      ...(version.review || {}),
      ai: {
        status: "Reviewing",
        promptKey: input.promptKey,
        promptVersion: input.promptVersion,
        promptHash: input.promptHash,
        model: input.model,
      },
    },
    updatedAt: timestamp,
  };
  return saveVersion(reviewing);
}

export async function reviewVersion(
  siteId: string,
  versionId: string,
  input: {
    decision: "Approved" | "Rejected" | "Error";
    reason?: string;
    model?: string;
    promptKey?: string;
    promptVersion?: string;
    promptHash?: string;
  },
) {
  if (!["Approved", "Rejected", "Error"].includes(input.decision))
    throw new CapabilityCenterV2Error(
      "review_decision_invalid",
      "review_decision_invalid",
      400,
    );
  const version = await getVersion(siteId, versionId);
  if (!version)
    throw new CapabilityCenterV2Error(
      "version_not_found",
      "version_not_found",
      404,
    );
  if (version.status !== "Draft")
    throw new CapabilityCenterV2Error(
      "version_not_draft",
      "version_not_draft",
      409,
    );
  const validation = (
    await listTasks(siteId, {
      type: "Validation",
      versionId: version.id,
      includeDeleted: true,
      includeArchived: true,
    })
  ).tasks.find((task) => task.status === "Succeeded");
  if (!validation)
    throw new CapabilityCenterV2Error(
      "validation_required",
      "validation_required",
      409,
    );
  const timestamp = now();
  const reviewed: CapabilityVersion = {
    ...version,
    review: {
      ...(version.review || {}),
      ai: {
        status: input.decision,
        reason: input.reason,
        model: input.model || version.review?.ai?.model,
        reviewedAt: timestamp,
        promptKey:
          input.promptKey || version.review?.ai?.promptKey || "review.prompt",
        promptVersion:
          input.promptVersion ||
          version.review?.ai?.promptVersion ||
          "unversioned",
        promptHash: input.promptHash || version.review?.ai?.promptHash,
      },
    },
    updatedAt: timestamp,
  };
  await saveVersion(reviewed);
  await appendTaskEvent(siteId, validation.id, {
    eventType: "ReviewDecisionStored",
    payload: {
      phase: "Reviewing",
      decision: input.decision,
      reason: input.reason || "",
      model: input.model || reviewed.review?.ai?.model || "",
    },
  }).catch((error) =>
    console.warn("[capability-debug] review event failed", {
      versionId,
      error,
    }),
  );
  if (input.decision === "Approved")
    return publishVersion(siteId, versionId, {
      adminId: "ai-review",
      reason: "AI review approved",
    });
  return {
    version: reviewed,
    persistence: db() ? ("database" as const) : ("memory" as const),
  };
}

export async function publishVersion(
  siteId: string,
  versionId: string,
  input: { adminId: string; reason?: string },
) {
  const version = await getVersion(siteId, versionId);
  if (!version)
    throw new CapabilityCenterV2Error(
      "version_not_found",
      "version_not_found",
      404,
    );
  if (version.status !== "Draft")
    throw new CapabilityCenterV2Error(
      "version_not_draft",
      "version_not_draft",
      409,
    );
  const validation = (
    await listTasks(siteId, {
      type: "Validation",
      versionId,
      includeDeleted: true,
      includeArchived: true,
    })
  ).tasks.find((task) => task.status === "Succeeded");
  if (!validation)
    throw new CapabilityCenterV2Error(
      "validation_required",
      "validation_required",
      409,
    );
  if (
    !(await getCapabilityV2Module(siteId, version.program.module.contentHash))
  )
    throw new CapabilityCenterV2Error(
      "capability_module_missing",
      "capability_module_missing",
      409,
    );
  const ai = version.review?.ai?.status;
  if (ai !== "Approved") {
    if (!input.reason)
      throw new CapabilityCenterV2Error(
        "admin_override_reason_required",
        "admin_override_reason_required",
        400,
      );
  }
  const timestamp = now();
  const reviewed: Review = {
    ...(version.review || {}),
    ...(ai !== "Approved"
      ? {
          adminOverride: {
            approved: true,
            reason: input.reason || "",
            adminId: input.adminId,
            moduleHash: version.program.module.contentHash,
            createdAt: timestamp,
          },
        }
      : {}),
  };
  const published: CapabilityVersion = {
    ...version,
    status: "Published",
    review: reviewed,
    publishedAt: version.publishedAt || timestamp,
    updatedAt: timestamp,
  };
  const capability = await getCapability(siteId, version.capabilityId, true);
  if (!capability)
    throw new CapabilityCenterV2Error(
      "capability_not_found",
      "capability_not_found",
      404,
    );
  const activated = {
    ...capability,
    currentVersionId: version.id,
    status:
      capability.status === "Disabled"
        ? ("Disabled" as const)
        : ("Active" as const),
    updatedAt: timestamp,
  };
  const database = db();
  if (!database) {
    memory.versions.set(published.id, published);
    memory.capabilities.set(activated.id, activated);
  } else {
    await ready(database);
    const results = await database.batch([
      database
        .prepare(
          `UPDATE ccv2_capability_versions SET status='Published',review_json=?,updated_at=?,published_at=? WHERE id=? AND site_id=? AND status='Draft'`,
        )
        .bind(
          JSON.stringify(published.review),
          published.updatedAt,
          published.publishedAt,
          published.id,
          siteId,
        ),
      database
        .prepare(
          `UPDATE ccv2_capabilities SET status=?,current_version_id=?,updated_at=? WHERE id=? AND site_id=? AND status<>'Deleted'`,
        )
        .bind(activated.status, published.id, timestamp, activated.id, siteId),
    ]);
    if (
      results.some(
        (result) => !result.success || Number(result.meta?.changes || 0) !== 1,
      )
    )
      throw new CapabilityCenterV2Error(
        "publish_conflict",
        "publish_conflict",
        409,
      );
  }
  await appendTaskEvent(siteId, validation.id, {
    eventType: "Published",
    payload: {
      phase: "Published",
      capabilityId: activated.id,
      versionId: published.id,
      status: published.status,
      review: published.review || {},
    },
  }).catch((error) =>
    console.warn("[capability-debug] publish event failed", {
      versionId,
      error,
    }),
  );
  return {
    version: published,
    persistence: db() ? ("database" as const) : ("memory" as const),
  };
}

/** Recover publication from D's transaction even if task projection updates were interrupted. */
export async function getGenerationPublication(siteId: string, generationTaskId: string): Promise<Extract<CapabilityPublishResult, { outcome: "Published" | "AlreadyPublished" }> | undefined> {
  const reservation = await getCapabilityClassificationReservation(siteId, generationTaskId);
  if (!reservation?.capabilityId) return undefined;
  if (reservation.status === "Superseded") return alreadyPublishedResult(siteId, reservation.capabilityId);
  if (reservation.status !== "Consumed") return undefined;
  const capability = await getCapability(siteId, reservation.capabilityId, true);
  const version = await getVersion(siteId, await deterministicPublishId("version", siteId, generationTaskId), true);
  return capability && version && version.capabilityId === capability.id ? { outcome: "Published", capability, version } : undefined;
}

/** The live capability (not deleted) that already carries this name, if any. */
export async function findLiveCapabilityByName(siteId: string, name: string) {
  return (await listCapabilities(siteId)).capabilities.find(
    (item) => normalize(item.name) === normalize(name),
  );
}

async function alreadyPublishedResult(siteId: string, capabilityId: string): Promise<Extract<CapabilityPublishResult, { outcome: "AlreadyPublished" }> | undefined> {
  const capability = await getCapability(siteId, capabilityId, true);
  const version = capability?.currentVersionId ? await getVersion(siteId, capability.currentVersionId, true) : undefined;
  if (!capability || !version) return undefined;
  return {
    outcome: "AlreadyPublished",
    capability,
    version,
    reason: `capability "${capability.name}" was already published by another generation`,
  };
}

/**
 * Two generations of the same capability raced to D; the later one yields.
 * Its reservation is marked Superseded and points at the winner, so every
 * later look at this generation resolves to the published capability
 * without another review or publish attempt.
 */
export async function supersedeGeneration(siteId: string, generationTaskId: string, winner: Capability): Promise<Extract<CapabilityPublishResult, { outcome: "AlreadyPublished" }> | undefined> {
  const timestamp = now();
  const database = db();
  if (!database) {
    const key = `${siteId}:${generationTaskId}`;
    const current = memory.classificationReservations.get(key);
    if (current) memory.classificationReservations.set(key, { ...current, status: "Superseded", capabilityId: winner.id, updatedAt: timestamp });
  } else {
    await ready(database);
    await database
      .prepare(`UPDATE ccv2_classification_reservations SET status='Superseded',capability_id=?,updated_at=? WHERE site_id=? AND generation_task_id=? AND status='Active'`)
      .bind(winner.id, timestamp, siteId, generationTaskId)
      .run();
  }
  return alreadyPublishedResult(siteId, winner.id);
}

/**
 * D's only publish command.  It consumes a validated CandidateArtifact and
 * writes the production Capability + Published Version exactly once.  No
 * semantic duplicate search or model call is allowed here.
 */
export async function publishValidatedCapability(
  siteId: string,
  input: CapabilityPublishInput,
): Promise<CapabilityPublishResult> {
  if (
    !input.authorization ||
    (input.authorization.mode !== "AIApproved" &&
      input.authorization.mode !== "AdminOverride")
  ) {
    throw new CapabilityCenterV2Error(
      "publish_authorization_required",
      "publish_authorization_required",
      409,
    );
  }
  const requestedArtifact = input.validated.artifact;
  if (requestedArtifact.generationTaskId !== input.generationTaskId) {
    return {
      outcome: "WriteConflict",
      code: "PUBLISH_COMMAND_MISMATCH",
      reason: "validated artifact does not belong to generation task",
    };
  }
  const reservation = await getCapabilityClassificationReservation(
    siteId,
    input.generationTaskId,
  );
  if (!reservation || reservation.status !== "Active") {
    if (reservation?.status === "Superseded" && reservation.capabilityId) {
      const superseded = await alreadyPublishedResult(siteId, reservation.capabilityId);
      if (superseded) return superseded;
    }
    if (reservation?.status === "Consumed") {
      const previous = await getGenerationPublication(siteId, input.generationTaskId);
      const frozen = await candidateArtifactForGenerationTask(siteId, input.generationTaskId);
      if (previous && frozen && JSON.stringify(canonicalJsonValue(frozen)) === JSON.stringify(canonicalJsonValue(requestedArtifact))) return previous;
    }
    return {
      outcome: "WriteConflict",
      code: "CLASSIFICATION_RESERVATION_LOST",
      reason: "classification reservation is missing or already consumed",
    };
  }
  const task = await getTask(siteId, input.generationTaskId, true);
  if (!task)
    return {
      outcome: "WriteConflict",
      code: "PUBLISH_COMMAND_MISMATCH",
      reason: "generation task not found",
    };
  const validationTask = await getTask(
    siteId,
    input.validated.validationTaskId,
    true,
  );
  const storedBuild = validationTask?.result?.buildResult;
  if (
    !validationTask ||
    validationTask.type !== "Validation" ||
    validationTask.status !== "Succeeded" ||
    validationTask.rerunOfTaskId !== task.id ||
    storedBuild?.outcome !== "Validated" ||
    JSON.stringify(canonicalJsonValue(storedBuild.package)) !==
      JSON.stringify(canonicalJsonValue(input.validated))
  ) {
    return {
      outcome: "WriteConflict",
      code: "PUBLISH_COMMAND_MISMATCH",
      reason: "validated package is not the persisted C3 result",
    };
  }
  const artifact = storedBuild.package.artifact;
  const formalPipeline =
    task.input.context.__pipelineVersion === "2.0" ||
    (Boolean(task.result?.c2CaseGenerationOutput) &&
      task.result?.candidateArtifact?.candidateId === artifact.candidateId &&
      task.result.candidateArtifact.validationSuiteHash ===
        artifact.validationSuiteHash &&
      JSON.stringify(canonicalJsonValue(task.result.candidateArtifact)) ===
        JSON.stringify(canonicalJsonValue(artifact)));
  if (!formalPipeline)
    return {
      outcome: "WriteConflict",
      code: "PUBLISH_COMMAND_MISMATCH",
      reason: "legacy task cannot call module-v2 publish",
    };
  if (
    !(await getCapabilityV2Module(
      siteId,
      artifact.candidate.program.module.contentHash,
    ))
  ) {
    return {
      outcome: "WriteConflict",
      code: "PUBLISH_COMMAND_MISMATCH",
      reason: "candidate module is not available",
    };
  }
  const existingBase = task.input.trigger.baseVersionId
    ? await getVersion(siteId, task.input.trigger.baseVersionId, true)
    : undefined;
  const capabilityId =
    existingBase?.capabilityId ||
    (await deterministicPublishId(
      "capability",
      siteId,
      input.generationTaskId,
    ));
  const versionId = await deterministicPublishId(
    "version",
    siteId,
    input.generationTaskId,
  );
  const capabilityExisting = existingBase
    ? await getCapability(siteId, existingBase.capabilityId, true)
    : undefined;
  if (
    existingBase &&
    (!capabilityExisting || capabilityExisting.currentVersionId !== existingBase.id || capabilityExisting.status === "Deleted" ||
      (existingBase.status !== "Published" &&
        existingBase.status !== "Disabled"))
  ) {
    return {
      outcome: "WriteConflict",
      code: "BASE_VERSION_CHANGED",
      reason: "repair base version is no longer a publishable baseline",
    };
  }
  const timestamp = now();
  const capability: Capability = capabilityExisting
    ? {
        ...capabilityExisting,
        name: artifact.candidate.name,
        description: artifact.candidate.description,
        aliases: artifact.candidate.aliases,
        searchText: capabilitySearchText(
          artifact.candidate.name,
          artifact.candidate.description,
          artifact.candidate.aliases,
        ),
        contract: artifact.candidate.contract,
        status: "Active",
        currentVersionId: versionId,
        updatedAt: timestamp,
      }
    : {
        id: capabilityId,
        siteId,
        name: artifact.candidate.name,
        description: artifact.candidate.description,
        aliases: artifact.candidate.aliases,
        searchText: capabilitySearchText(
          artifact.candidate.name,
          artifact.candidate.description,
          artifact.candidate.aliases,
        ),
        contract: artifact.candidate.contract,
        status: "Active",
        currentVersionId: versionId,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
  const replacementIds = artifact.candidate.replacementPlan?.disableAfterPublish
    ? [
        ...new Set(artifact.candidate.replacementPlan.replacesCapabilityIds),
      ].filter((id) => id !== capability.id)
    : [];
  const replacementCapabilities = await Promise.all(
    replacementIds.map((id) => getCapability(siteId, id, true)),
  );
  if (
    replacementCapabilities.some((item) => !item || item.status === "Deleted")
  ) {
    return {
      outcome: "WriteConflict",
      code: "PUBLISH_COMMAND_MISMATCH",
      reason: "replacement capability target is missing or deleted",
    };
  }
  if (!capabilityExisting) {
    const sameName = await findLiveCapabilityByName(siteId, capability.name);
    if (sameName && sameName.id !== capability.id) {
      const superseded = await supersedeGeneration(siteId, input.generationTaskId, sameName);
      if (superseded) return superseded;
    }
  }
  const version: CapabilityVersion = {
    id: capability.currentVersionId!,
    siteId,
    capabilityId: capability.id,
    source: task.sourceAgentRunId ? "User" : "Admin",
    program: artifact.candidate.program,
    status: "Published",
    review:
      input.authorization.mode === "AIApproved"
        ? {
            ai: {
              status: "Approved",
              reviewedAt: timestamp,
              model: input.authorization.reviewId,
            },
          }
        : {
            adminOverride: {
              approved: true,
              reason: input.authorization.reason,
              adminId: input.authorization.adminId,
              moduleHash: artifact.candidate.program.module.contentHash,
              createdAt: timestamp,
            },
          },
    createdAt: timestamp,
    updatedAt: timestamp,
    publishedAt: timestamp,
  };
  const database = db();
  if (!database) {
    const reservationKey = `${siteId}:${input.generationTaskId}`;
    const currentReservation =
      memory.classificationReservations.get(reservationKey);
    if (!currentReservation || currentReservation.status !== "Active") {
      if (currentReservation?.capabilityId) {
        const existingCapability = memory.capabilities.get(
          currentReservation.capabilityId,
        );
        const existingVersion = memory.versions.get(versionId);
        if (existingCapability && existingVersion) {
          return {
            outcome: "Published",
            capability: existingCapability,
            version: existingVersion,
          };
        }
      }
      return {
        outcome: "WriteConflict",
        code: "CLASSIFICATION_RESERVATION_LOST",
        reason: "classification reservation is missing or already consumed",
      };
    }
    if (existingBase && memory.capabilities.get(capability.id)?.currentVersionId !== existingBase.id) return { outcome: "WriteConflict", code: "BASE_VERSION_CHANGED", reason: "current version changed before publication" };
    memory.classificationReservations.set(reservationKey, {
      ...currentReservation,
      status: "Consumed",
      capabilityId: capability.id,
      updatedAt: timestamp,
    });
    memory.capabilities.set(capability.id, capability);
    memory.versions.set(version.id, version);
    for (const replacement of replacementCapabilities) {
      if (replacement)
        memory.capabilities.set(replacement.id, {
          ...replacement,
          status: "Disabled",
          updatedAt: timestamp,
        });
    }
  } else {
    await ready(database);
    const statements = capabilityExisting
      ? [
          database
            .prepare(
              `UPDATE ccv2_capabilities SET name=?,description=?,aliases_json=?,search_text=?,contract_json=?,status='Active',current_version_id=?,updated_at=? WHERE id=? AND site_id=? AND current_version_id=? AND status<>'Deleted'`,
            )
            .bind(
              capability.name,
              capability.description,
              JSON.stringify(capability.aliases),
              capability.searchText,
              JSON.stringify(capability.contract),
              capability.currentVersionId,
              timestamp,
              capability.id,
              siteId,
              existingBase!.id,
            ),
          database
            .prepare(
              `INSERT INTO ccv2_capability_versions (id,site_id,capability_id,source,program_json,status,review_json,created_at,updated_at,published_at,deleted_at) VALUES (?,?,(SELECT id FROM ccv2_capabilities WHERE id=? AND site_id=? AND current_version_id=?),?,?,?,?,?,?,?,?)`,
            )
            .bind(
              version.id,
              siteId,
              capability.id,
              siteId,
              version.id,
              version.source,
              JSON.stringify(version.program),
              "Published",
              JSON.stringify(version.review),
              timestamp,
              timestamp,
              timestamp,
              null,
            ),
        ]
      : [
          database
            .prepare(
              `INSERT INTO ccv2_capabilities (id,site_id,name,description,aliases_json,search_text,contract_json,status,current_version_id,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .bind(
              capability.id,
              siteId,
              capability.name,
              capability.description,
              JSON.stringify(capability.aliases),
              capability.searchText,
              JSON.stringify(capability.contract),
              "Active",
              capability.currentVersionId,
              timestamp,
              timestamp,
              null,
            ),
          database
            .prepare(
              `INSERT INTO ccv2_capability_versions (id,site_id,capability_id,source,program_json,status,review_json,created_at,updated_at,published_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .bind(
              version.id,
              siteId,
              capability.id,
              version.source,
              JSON.stringify(version.program),
              "Published",
              JSON.stringify(version.review),
              timestamp,
              timestamp,
              timestamp,
              null,
            ),
        ];
    for (const replacement of replacementCapabilities) {
      if (replacement)
        statements.push(
          database
            .prepare(
              `UPDATE ccv2_capabilities SET status='Disabled',updated_at=? WHERE id=? AND site_id=? AND status<>'Deleted'`,
            )
            .bind(timestamp, replacement.id, siteId),
        );
    }
    statements.push(
      database
        .prepare(
          `UPDATE ccv2_classification_reservations SET status='Consumed',capability_id=?,updated_at=? WHERE site_id=? AND generation_task_id=? AND status='Active'`,
        )
        .bind(capability.id, timestamp, siteId, input.generationTaskId),
    );
    let results: Awaited<ReturnType<D1DatabaseLike["batch"]>>;
    try {
      results = await database.batch(statements);
    } catch {
      if (!capabilityExisting) {
        const sameName = await findLiveCapabilityByName(siteId, capability.name);
        if (sameName && sameName.id !== capability.id) {
          const superseded = await supersedeGeneration(siteId, input.generationTaskId, sameName);
          if (superseded) return superseded;
        }
      }
      const current = existingBase ? await getCapability(siteId, capability.id, true) : undefined;
      return {
        outcome: "WriteConflict",
        code: existingBase && current?.currentVersionId !== existingBase.id ? "BASE_VERSION_CHANGED" : "PUBLISH_COMMAND_MISMATCH",
        reason: existingBase && current?.currentVersionId !== existingBase.id ? "current version changed before publication" : "publish transaction failed",
      };
    }
    const reservationResult = results.at(-1);
    if (
      results.some((result) => !result.success) ||
      Number(reservationResult?.meta?.changes || 0) !== 1
    ) {
      return {
        outcome: "WriteConflict",
        code: "PUBLISH_COMMAND_MISMATCH",
        reason: "publish transaction failed",
      };
    }
  }
  await appendTaskEvent(siteId, input.generationTaskId, {
    eventType: "CapabilityPublished",
    payload: {
      phase: "Published",
      capabilityId: capability.id,
      versionId: version.id,
      status: version.status,
    },
  }).catch(() => undefined);
  return { outcome: "Published", capability, version };
}

async function saveCapability(capability: Capability) {
  const database = db();
  if (!database) {
    memory.capabilities.set(capability.id, capability);
    return { capability, persistence: "memory" as const };
  }
  await ready(database);
  await run(
    database,
    `UPDATE ccv2_capabilities SET name=?,description=?,aliases_json=?,search_text=?,contract_json=?,status=?,current_version_id=?,updated_at=?,deleted_at=? WHERE id=? AND site_id=?`,
    [
      capability.name,
      capability.description,
      JSON.stringify(capability.aliases),
      capability.searchText,
      JSON.stringify(capability.contract),
      capability.status,
      capability.currentVersionId || null,
      capability.updatedAt,
      capability.deletedAt || null,
      capability.id,
      capability.siteId,
    ],
  );
  return { capability, persistence: "database" as const };
}

export async function actOnCapability(
  siteId: string,
  capabilityId: string,
  action: "disable" | "enable" | "delete" | "switch-version",
  input: { versionId?: string } = {},
) {
  const capability = await getCapability(siteId, capabilityId, true);
  if (!capability)
    throw new CapabilityCenterV2Error(
      "capability_not_found",
      "capability_not_found",
      404,
    );
  const timestamp = now();
  if (action === "disable")
    return saveCapability({
      ...capability,
      status: "Disabled",
      updatedAt: timestamp,
    });
  if (action === "delete") {
    if (capability.status === "Active")
      throw new CapabilityCenterV2Error(
        "active_capability_must_be_disabled",
        "active_capability_must_be_disabled",
        409,
      );
    const versions = (await listVersions(siteId, capabilityId, true)).versions;
    await Promise.all(
      versions
        .filter((version) => version.status !== "Deleted")
        .map((version) =>
          saveVersion({
            ...version,
            status: "Deleted",
            deletedAt: timestamp,
            updatedAt: timestamp,
          }),
        ),
    );
    return saveCapability({
      ...capability,
      status: "Deleted",
      deletedAt: timestamp,
      updatedAt: timestamp,
    });
  }
  if (action === "enable") {
    const version = capability.currentVersionId
      ? await getVersion(siteId, capability.currentVersionId)
      : undefined;
    if (!version || version.status !== "Published")
      throw new CapabilityCenterV2Error(
        "published_version_required",
        "published_version_required",
        409,
      );
    return saveCapability({
      ...capability,
      status: "Active",
      updatedAt: timestamp,
      deletedAt: undefined,
    });
  }
  const versionId = input.versionId;
  if (!versionId) throw new CapabilityCenterV2Error("version_id_required");
  const version = await getVersion(siteId, versionId);
  if (
    !version ||
    version.capabilityId !== capability.id ||
    version.status !== "Published"
  )
    throw new CapabilityCenterV2Error(
      "published_version_required",
      "published_version_required",
      409,
    );
  return saveCapability({
    ...capability,
    currentVersionId: version.id,
    updatedAt: timestamp,
  });
}

export async function actOnVersion(
  siteId: string,
  versionId: string,
  action: "disable" | "enable" | "delete",
  input: { replacementVersionId?: string; disableCapability?: boolean } = {},
) {
  const version = await getVersion(siteId, versionId, true);
  if (!version)
    throw new CapabilityCenterV2Error(
      "version_not_found",
      "version_not_found",
      404,
    );
  const capability = await getCapability(siteId, version.capabilityId, true);
  if (!capability)
    throw new CapabilityCenterV2Error(
      "capability_not_found",
      "capability_not_found",
      404,
    );
  const timestamp = now();
  if (action === "delete") {
    if (
      capability.currentVersionId === version.id ||
      version.status === "Published"
    )
      throw new CapabilityCenterV2Error(
        "current_version_cannot_delete",
        "current_version_cannot_delete",
        409,
      );
    return saveVersion({
      ...version,
      status: "Deleted",
      deletedAt: timestamp,
      updatedAt: timestamp,
    });
  }
  if (action === "disable") {
    if (
      capability.currentVersionId === version.id &&
      !input.replacementVersionId &&
      !input.disableCapability
    )
      throw new CapabilityCenterV2Error(
        "replacement_version_required",
        "replacement_version_required",
        409,
      );
    if (input.replacementVersionId === version.id)
      throw new CapabilityCenterV2Error(
        "replacement_version_must_differ",
        "replacement_version_must_differ",
        409,
      );
    if (input.replacementVersionId)
      await actOnCapability(siteId, capability.id, "switch-version", {
        versionId: input.replacementVersionId,
      });
    if (input.disableCapability)
      await actOnCapability(siteId, capability.id, "disable");
    return saveVersion({
      ...version,
      status: "Disabled",
      updatedAt: timestamp,
    });
  }
  if (version.status !== "Disabled")
    throw new CapabilityCenterV2Error(
      "version_not_disabled",
      "version_not_disabled",
      409,
    );
  const validation = (
    await listTasks(siteId, {
      type: "Validation",
      versionId: version.id,
      includeDeleted: true,
      includeArchived: true,
    })
  ).tasks.find((task) => task.status === "Succeeded");
  if (!validation)
    throw new CapabilityCenterV2Error(
      "validation_required",
      "validation_required",
      409,
    );
  return saveVersion({
    ...version,
    status: "Published",
    updatedAt: timestamp,
    publishedAt: version.publishedAt || timestamp,
  });
}

export async function deleteTask(siteId: string, taskId: string) {
  const task = await getTask(siteId, taskId, true);
  if (!task)
    throw new CapabilityCenterV2Error("task_not_found", "task_not_found", 404);
  if (!isTerminalTaskStatus(task.status) || task.status === "Deleted")
    throw new CapabilityCenterV2Error(
      "task_not_terminal",
      "task_not_terminal",
      409,
    );
  return saveTaskFull({
    ...task,
    status: "Deleted",
    deletedAt: now(),
    updatedAt: now(),
  });
}

export async function setTaskArchived(
  siteId: string,
  taskId: string,
  archived: boolean,
) {
  const task = await getTask(siteId, taskId, true);
  if (!task)
    throw new CapabilityCenterV2Error("task_not_found", "task_not_found", 404);
  if (task.status === "Deleted")
    throw new CapabilityCenterV2Error("task_deleted", "task_deleted", 409);
  if (archived && !isTerminalTaskStatus(task.status))
    throw new CapabilityCenterV2Error(
      "task_not_terminal",
      "task_not_terminal",
      409,
    );
  if (Boolean(task.archivedAt) === archived)
    return {
      task,
      persistence: db() ? ("database" as const) : ("memory" as const),
    };
  const timestamp = now();
  return saveTaskFull({
    ...task,
    archivedAt: archived ? timestamp : undefined,
    updatedAt: timestamp,
  });
}

export async function cancelTask(siteId: string, taskId: string) {
  const task = await getTask(siteId, taskId, true);
  if (!task)
    throw new CapabilityCenterV2Error("task_not_found", "task_not_found", 404);
  if (isTerminalTaskStatus(task.status))
    throw new CapabilityCenterV2Error(
      "task_already_terminal",
      "task_already_terminal",
      409,
    );
  return saveTaskFull({
    ...task,
    status: "Cancelled",
    updatedAt: now(),
    finishedAt: now(),
    runnerId: undefined,
  });
}

export async function failTaskDispatch(
  siteId: string,
  taskId: string,
  reason: string,
) {
  const task = await getTask(siteId, taskId, true);
  if (!task)
    throw new CapabilityCenterV2Error("task_not_found", "task_not_found", 404);
  if (task.status !== "Pending" || task.runnerId)
    return {
      task,
      persistence: db() ? ("database" as const) : ("memory" as const),
    };
  const timestamp = now();
  const updated = {
    ...task,
    status: "Failed" as const,
    error: {
      code: "runner_start_retry_exhausted",
      message: reason,
      retryable: true,
    },
    updatedAt: timestamp,
    finishedAt: timestamp,
  };
  await appendTaskEvent(siteId, taskId, {
    eventType: "RunnerDispatchFailed",
    payload: { phase: "Runner", message: "runner start retries exhausted", reason },
  });
  return saveTaskFull(updated);
}

async function settingFromRow(
  row: Record<string, unknown>,
): Promise<CapabilityCenterSetting> {
  return {
    id: text(row.id),
    siteId: text(row.site_id),
    settingKey: text(row.setting_key),
    settingValue: json<JsonObject>(text(row.setting_value_json), {}),
    updatedBy: text(row.updated_by),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

export async function listSettings(siteId: string) {
  const database = db();
  if (!database)
    return {
      settings: [...memory.settings.values()].filter(
        (item) => item.siteId === siteId,
      ),
      persistence: "memory" as const,
    };
  await ready(database);
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ccv2_settings WHERE site_id=? ORDER BY setting_key`,
    [siteId],
  );
  return {
    settings: await Promise.all(rows.map(settingFromRow)),
    persistence: "database" as const,
  };
}

export async function getSetting(siteId: string, key: string) {
  const database = db();
  if (!database)
    return [...memory.settings.values()].find(
      (item) => item.siteId === siteId && item.settingKey === key,
    );
  await ready(database);
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ccv2_settings WHERE site_id=? AND setting_key=? LIMIT 1`,
    [siteId, key],
  );
  return rows[0] ? settingFromRow(rows[0]) : undefined;
}

export async function upsertSetting(
  siteId: string,
  key: string,
  value: JsonObject,
  updatedBy: string,
) {
  if (!key || key.length > 100)
    throw new CapabilityCenterV2Error("setting_key_invalid");
  const timestamp = now();
  const existing = await getSetting(siteId, key);
  const item: CapabilityCenterSetting = {
    id: existing?.id || uid(),
    siteId,
    settingKey: key,
    settingValue: value,
    updatedBy,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };
  const database = db();
  if (!database) {
    memory.settings.set(`${siteId}:${key}`, item);
    return { setting: item, persistence: "memory" as const };
  }
  await ready(database);
  await run(
    database,
    `INSERT INTO ccv2_settings (id,site_id,setting_key,setting_value_json,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(site_id,setting_key) DO UPDATE SET setting_value_json=excluded.setting_value_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
    [
      item.id,
      item.siteId,
      item.settingKey,
      JSON.stringify(item.settingValue),
      item.updatedBy,
      item.createdAt,
      item.updatedAt,
    ],
  );
  return { setting: item, persistence: "database" as const };
}

export async function deleteSetting(siteId: string, key: string) {
  const database = db();
  if (!database) {
    memory.settings.delete(`${siteId}:${key}`);
    return { persistence: "memory" as const };
  }
  await ready(database);
  await run(
    database,
    `DELETE FROM ccv2_settings WHERE site_id=? AND setting_key=?`,
    [siteId, key],
  );
  return { persistence: "database" as const };
}

export async function listRunners(
  siteId: string,
  options: { status?: RunnerStatus; taskId?: string } = {},
) {
  const database = db();
  if (!database)
    return {
      runners: [...memory.runners.values()].filter(
        (item) =>
          item.siteId === siteId &&
          (!options.status || item.status === options.status) &&
          (!options.taskId || item.taskId === options.taskId),
      ),
      persistence: "memory" as const,
    };
  await ready(database);
  const clauses = ["site_id=?"];
  const values: unknown[] = [siteId];
  if (options.status) {
    clauses.push("status=?");
    values.push(options.status);
  }
  if (options.taskId) {
    clauses.push("task_id=?");
    values.push(options.taskId);
  }
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ccv2_runner_instances WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC`,
    values,
  );
  return { runners: rows.map(runnerFromRow), persistence: "database" as const };
}

export async function listPendingTaskSites() {
  const database = db();
  if (!database)
    return [
      ...new Set(
        [...memory.tasks.values()]
          .filter((task) => task.status === "Pending" && !task.runnerId)
          .map((task) => task.siteId),
      ),
    ];
  await ready(database);
  const rows = await all<{ site_id: string }>(
    database,
    "SELECT DISTINCT site_id FROM ccv2_capability_tasks WHERE status='Pending' AND runner_id IS NULL ORDER BY site_id",
  );
  return rows.map((row) => row.site_id);
}

export async function getRunner(siteId: string, runnerId: string) {
  const database = db();
  if (!database) {
    const item = memory.runners.get(runnerId);
    return item?.siteId === siteId ? item : undefined;
  }
  await ready(database);
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ccv2_runner_instances WHERE id=? AND site_id=? LIMIT 1`,
    [runnerId, siteId],
  );
  return rows[0] ? runnerFromRow(rows[0]) : undefined;
}

export async function registerRunner(
  siteId: string,
  input: {
    id?: string;
    taskId: string;
    runtimeType?: RunnerInstance["runtimeType"];
    runtimeProvider?: string;
    runtimeVersion?: string;
  },
) {
  const task = await getTask(siteId, input.taskId);
  if (!task)
    throw new CapabilityCenterV2Error("task_not_found", "task_not_found", 404);
  const createdAt = now();
  const heartbeatAt = createdAt;
  const item: RunnerInstance = {
    id: input.id || uid(),
    siteId,
    taskId: task.id,
    runtimeType: input.runtimeType || "Process",
    runtimeProvider: input.runtimeProvider || "Local",
    runtimeVersion: input.runtimeVersion || "1.0.0",
    status: "Starting",
    heartbeatAt,
    heartbeatExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    createdAt,
    updatedAt: createdAt,
  };
  const database = db();
  if (!database) {
    memory.runners.set(item.id, item);
    return { runner: item, persistence: "memory" as const };
  }
  await ready(database);
  await run(
    database,
    `INSERT INTO ccv2_runner_instances (id,site_id,task_id,runtime_type,runtime_provider,runtime_version,status,heartbeat_at,heartbeat_expires_at,last_error,created_at,updated_at,terminated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      item.id,
      item.siteId,
      item.taskId,
      item.runtimeType,
      item.runtimeProvider,
      item.runtimeVersion,
      item.status,
      item.heartbeatAt,
      item.heartbeatExpiresAt,
      null,
      item.createdAt,
      item.updatedAt,
      null,
    ],
  );
  return { runner: item, persistence: "database" as const };
}

export async function heartbeatRunner(
  siteId: string,
  runnerId: string,
  patch: { status?: RunnerStatus; lastError?: string },
) {
  const runner = await getRunner(siteId, runnerId);
  if (!runner)
    throw new CapabilityCenterV2Error(
      "runner_not_found",
      "runner_not_found",
      404,
    );
  if (runner.status === "Lost" || runner.status === "Terminated")
    throw new CapabilityCenterV2Error(
      "runner_not_active",
      "runner_not_active",
      409,
    );
  const timestamp = now();
  const updated = {
    ...runner,
    status: patch.status || "Running",
    lastError: patch.lastError,
    heartbeatAt: timestamp,
    heartbeatExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    updatedAt: timestamp,
  } satisfies RunnerInstance;
  const database = db();
  if (!database) {
    memory.runners.set(runnerId, updated);
    return { runner: updated, persistence: "memory" as const };
  }
  await ready(database);
  await run(
    database,
    `UPDATE ccv2_runner_instances SET status=?,heartbeat_at=?,heartbeat_expires_at=?,last_error=?,updated_at=? WHERE id=? AND site_id=?`,
    [
      updated.status,
      updated.heartbeatAt,
      updated.heartbeatExpiresAt,
      updated.lastError || null,
      updated.updatedAt,
      runnerId,
      siteId,
    ],
  );
  return { runner: updated, persistence: "database" as const };
}

export async function terminateRunner(
  siteId: string,
  runnerId: string,
  status: "Disposing" | "Terminated" = "Terminated",
) {
  const runner = await getRunner(siteId, runnerId);
  if (!runner)
    throw new CapabilityCenterV2Error(
      "runner_not_found",
      "runner_not_found",
      404,
    );
  const timestamp = now();
  const updated = {
    ...runner,
    status,
    updatedAt: timestamp,
    terminatedAt: status === "Terminated" ? timestamp : undefined,
  } satisfies RunnerInstance;
  const database = db();
  if (!database) {
    memory.runners.set(runnerId, updated);
    return { runner: updated, persistence: "memory" as const };
  }
  await ready(database);
  await run(
    database,
    `UPDATE ccv2_runner_instances SET status=?,updated_at=?,terminated_at=? WHERE id=? AND site_id=?`,
    [
      updated.status,
      updated.updatedAt,
      updated.terminatedAt || null,
      runnerId,
      siteId,
    ],
  );
  return { runner: updated, persistence: "database" as const };
}

export async function markRunnerLost(
  siteId: string,
  runnerId: string,
  reason = "runner_lost",
) {
  const runner = await getRunner(siteId, runnerId);
  if (!runner)
    throw new CapabilityCenterV2Error(
      "runner_not_found",
      "runner_not_found",
      404,
    );
  // A normal or task-failure shutdown reports `terminated` before the child
  // process emits its final close event. Do not rewrite that terminal runner
  // state to Lost when the launcher observes the non-zero exit afterwards.
  if (runner.status === "Terminated")
    return {
      runner,
      persistence: db() ? ("database" as const) : ("memory" as const),
    };
  if (runner.taskId) {
    const task = await getTask(siteId, runner.taskId, true);
    if (
      task &&
      task.runnerId === runnerId &&
      !isTerminalTaskStatus(task.status)
    ) {
      // Every runtime slot being busy is not a failure of this task: it goes
      // back in the queue and starts when one frees. Recording it as an error
      // made the console tell a person their capability had not been made —
      // 「本次制作未完成」 — while the same page said it was queued.
      const waitingForCapacity = /capacity_exhausted/.test(reason);
      await saveTaskFull({
        ...task,
        runnerId: undefined,
        status: "Pending",
        ...(waitingForCapacity
          ? { error: undefined }
          : {
              error: {
                code: reason.split(":")[0] || "runner_lost",
                message: reason,
                retryable: true,
              },
            }),
        updatedAt: now(),
      });
      await appendTaskEvent(siteId, task.id, {
        eventType: "RunnerLost",
        // A marker for the feed and the code for the record; the console words
        // both, and the launcher's own detail stays in the code's suffix.
        payload: {
          phase: "Runner",
          runnerId,
          message: waitingForCapacity
            ? "waiting for runner capacity"
            : reason.startsWith("runner_launch_failed")
              ? "runner launch failed; retrying"
              : "runner lost; retrying",
        },
      });
    }
  }
  const timestamp = now();
  const updated = {
    ...runner,
    status: "Lost" as const,
    lastError: reason,
    updatedAt: timestamp,
  };
  const database = db();
  if (!database) {
    memory.runners.set(runnerId, updated);
    return { runner: updated, persistence: "memory" as const };
  }
  await ready(database);
  await run(
    database,
    `UPDATE ccv2_runner_instances SET status='Lost',last_error=?,updated_at=? WHERE id=? AND site_id=?`,
    [reason, timestamp, runnerId, siteId],
  );
  return { runner: updated, persistence: "database" as const };
}

export async function markExpiredRunnersLost(siteId?: string) {
  const sites = siteId
    ? [siteId]
    : [...new Set([...memory.runners.values()].map((runner) => runner.siteId))];
  const database = db();
  if (database && !siteId) {
    await ready(database);
    const rows = await all<{ site_id: string }>(
      database,
      `SELECT DISTINCT site_id FROM ccv2_runner_instances WHERE status NOT IN ('Lost','Terminated') AND heartbeat_expires_at<?`,
      [now()],
    );
    sites.push(...rows.map((row) => row.site_id));
  }
  const lost: RunnerInstance[] = [];
  for (const currentSiteId of [...new Set(sites)]) {
    const runners = (await listRunners(currentSiteId)).runners.filter(
      (runner) =>
        !["Lost", "Terminated"].includes(runner.status) &&
        Date.parse(runner.heartbeatExpiresAt) <= Date.now(),
    );
    for (const runner of runners)
      lost.push(
        (
          await markRunnerLost(
            currentSiteId,
            runner.id,
            "runner_heartbeat_expired",
          )
        ).runner,
      );
  }
  return { runners: lost };
}

/**
 * On site deletion, the `ccv2_*` tables keyed by `site_id`. `ccv2_runner_instances` is
 * among them: it records runtime instances started per site/task, not the org-level
 * runner registry (that is `site_agent_v2_runner_instances`). Children before parents.
 */
export const CAPABILITY_CENTER_V2_DELETION_TABLES = [
  "ccv2_runner_instances",
  "ccv2_task_events",
  "ccv2_artifacts",
  "ccv2_candidate_artifacts",
  "ccv2_classification_reservations",
  "ccv2_idempotency",
  "ccv2_settings",
  "ccv2_capability_tasks",
  "ccv2_capability_versions",
  "ccv2_capabilities",
] as const;

export function capabilityCenterV2DeletionStatements(database: D1DatabaseLike, siteId: string): D1PreparedStatementLike[] {
  return CAPABILITY_CENTER_V2_DELETION_TABLES.map((table) => database.prepare(`DELETE FROM ${table} WHERE site_id=?`).bind(siteId));
}

/** Object-storage keys of this site's capability artifacts (screenshots, traces, logs…). */
export async function capabilityCenterV2ObjectKeys(database: D1DatabaseLike, siteId: string): Promise<string[]> {
  const rows = await database.prepare(`SELECT storage_key AS storageKey FROM ccv2_artifacts WHERE site_id=?`).bind(siteId).all<{ storageKey: string }>();
  return (rows.results || []).map((row) => row.storageKey).filter(Boolean);
}

export function deleteMemoryCapabilityCenterV2Data(siteId: string) {
  // Candidate artifact rows carry no siteId, only the generating task id: match them while the tasks still exist.
  const siteTaskIds = new Set([...memory.tasks.values()].filter((task) => task.siteId === siteId).map((task) => task.id));
  for (const [id, item] of memory.candidateArtifacts) if (siteTaskIds.has(item.generationTaskId)) memory.candidateArtifacts.delete(id);
  for (const [id, item] of memory.capabilities) if (item.siteId === siteId) memory.capabilities.delete(id);
  for (const [id, item] of memory.versions) if (item.siteId === siteId) memory.versions.delete(id);
  for (const [id, item] of memory.tasks) if (item.siteId === siteId) memory.tasks.delete(id);
  for (const [key, item] of memory.settings) if (item.siteId === siteId) memory.settings.delete(key);
  for (const [id, item] of memory.runners) if (item.siteId === siteId) memory.runners.delete(id);
  for (const [key] of memory.idempotency) if (key.startsWith(`${siteId}:`)) memory.idempotency.delete(key);
  for (const [id, item] of memory.artifacts) if (item.artifact.siteId === siteId) memory.artifacts.delete(id);
  for (const [key] of memory.events) if (key.startsWith(`${siteId}:`)) memory.events.delete(key);
  for (const [key, item] of memory.classificationReservations) if (item.siteId === siteId) memory.classificationReservations.delete(key);
}
