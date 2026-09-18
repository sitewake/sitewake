import {
  DEFAULT_RUNNER_POOL_ID,
  projectPublicRunnerInstance,
  projectRunnerControl,
  runnerLeaseDisplayId,
  type BeginRunnerLeaseCompletionResult,
  type ClaimRunnerLeaseInput,
  type CompleteRunnerLeaseInput,
  type HeartbeatRunnerInstanceInput,
  type HeartbeatRunnerInstanceResult,
  type RegisterRunnerInstanceInput,
  type RegisterRunnerInstanceResult,
  type RenewRunnerLeaseInput,
  type RunnerControlProjection,
  type RunnerDesiredState,
  type RunnerInstance,
  type RunnerLeaseGrant,
  type RunnerLeaseRecord,
  type RunnerLastError,
  type RunnerPlacementBinding,
  type RunnerProjectionMode,
  type RunnerQueueHealth,
  type RunnerRole,
  type RunnerTaskProjection,
  type RunnerTaskAttemptProjection,
  type RunnerTaskBrowserRunProjection,
  type RunnerTaskStatus,
  type RunnerVisibilityProvider,
  type RunnerWorkKind,
} from "../lib/runner-control";
import { getD1Binding, type D1DatabaseLike, type D1PreparedStatementLike } from "./index";
import { ensureSiteAgentV2Schema } from "./site-agent-schema";

const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TTL_MS = 20_000;
const OFFLINE_AFTER_MS = 60_000;
const DEFAULT_LEASE_TTL_MS = 120_000;
const MAX_LEASE_TTL_MS = 120_000;
const LEGACY_LEASE_TTL_MS = 15 * 60_000;
const ACTIVE_LEASE_STATUSES = ["active", "completing"] as const;
const TERMINAL_LEASE_STATUSES = ["completed", "failed", "released", "expired"] as const;
const RUNNER_WORK_KINDS: RunnerWorkKind[] = ["execute", "author", "validate"];
const RUNNER_ROLES: RunnerRole[] = ["any", "interactive", "background", "author", "validate"];
const RUNNER_INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUNNER_REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const RUNNER_COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const MAX_ACTIVITY_ARTIFACTS = 20;
const MAX_TOKEN_COUNT = 1_000_000_000;
const COMPLETION_LOCK_MS = 5_000;
const COMPLETION_RECOVERY_WAIT_MS = 20_000;
let runnerVisibilityProvider: RunnerVisibilityProvider | undefined;

type StoredRunnerInstance = {
  instance: RunnerInstance;
  sessionTokenHash: string;
  desiredState: RunnerDesiredState;
};
type StoredRunnerLease = { lease: RunnerLeaseRecord; tokenHash: string };
type RunnerControlMemory = {
  instances: Map<string, StoredRunnerInstance>;
  bindings: Map<string, RunnerPlacementBinding>;
  leases: Map<string, StoredRunnerLease>;
};
type RunnerControlMemoryRoot = typeof globalThis & { __SITEWAKE_RUNNER_CONTROL__?: RunnerControlMemory };
type RunnerInstanceRow = {
  instanceJson: string;
  sessionTokenHash: string;
  desiredState: RunnerDesiredState;
};
type RunnerBindingRow = { bindingJson: string };
type RunnerLeaseRow = { leaseJson: string; tokenHash: string };

function memoryRunnerControl() {
  const root = globalThis as RunnerControlMemoryRoot;
  root.__SITEWAKE_RUNNER_CONTROL__ ||= {
    instances: new Map(),
    bindings: new Map(),
    leases: new Map(),
  };
  return root.__SITEWAKE_RUNNER_CONTROL__;
}

function changes(result: { meta?: Record<string, unknown> }) {
  return Number(result.meta?.changes || 0);
}

async function all<T>(database: D1DatabaseLike, sql: string, values: unknown[] = []) {
  const result = await database.prepare(sql).bind(...values).all<T>();
  if (!result.success) throw new Error(result.error || "runner_control_query_failed");
  return result.results || [];
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  const numeric = Number.isFinite(value) ? Math.floor(value!) : fallback;
  return Math.max(minimum, Math.min(maximum, numeric));
}

function leaseTtl(value: number | undefined, legacy = false) {
  const fallback = legacy ? LEGACY_LEASE_TTL_MS : DEFAULT_LEASE_TTL_MS;
  const maximum = legacy ? LEGACY_LEASE_TTL_MS : MAX_LEASE_TTL_MS;
  return clampInteger(value, fallback, 30_000, maximum);
}

function normalizedRunnerRole(role: RegisterRunnerInstanceInput["role"] | undefined): RunnerRole {
  return RUNNER_ROLES.includes(role as RunnerRole) ? role as RunnerRole : "any";
}

function roleWorkKinds(role: RunnerRole): RunnerWorkKind[] {
  if (role === "interactive") return ["execute"];
  if (role === "background") return ["author", "validate"];
  if (role === "author") return ["author"];
  if (role === "validate") return ["validate"];
  return RUNNER_WORK_KINDS;
}

function validatedBindingWorkKinds(
  value: unknown,
  emptyError: "runner_binding_work_kind_required" | "runner_binding_work_kind_invalid",
) {
  if (value === undefined || (Array.isArray(value) && !value.length)) throw new Error(emptyError);
  if (!Array.isArray(value)
    || value.some((kind) => typeof kind !== "string" || !RUNNER_WORK_KINDS.includes(kind as RunnerWorkKind))) {
    throw new Error("runner_binding_work_kind_invalid");
  }
  return [...new Set(value as RunnerWorkKind[])];
}

function normalizedWorkKinds(input: RegisterRunnerInstanceInput, role: RunnerRole, current?: RunnerInstance) {
  const requested = input.workKinds?.filter((kind): kind is RunnerWorkKind => RUNNER_WORK_KINDS.includes(kind))
    || (!input.role && current?.workKinds?.length ? current.workKinds : roleWorkKinds(role));
  return [...new Set(requested.length ? requested : RUNNER_WORK_KINDS)];
}

function redactedPublicText(value: unknown, maximum: number, firstLine = false) {
  let text = String(value ?? "");
  if (firstLine) text = text.split(/\r?\n/, 1)[0];
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\bhttps?:\/\/[^\s<>"')\]]+/gi, "[redacted-url]")
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s<>"']+/g, "[redacted-path]")
    .replace(/(^|[\s([])\/(?:[^/\s<>"']+\/)+[^/\s<>"']*/g, "$1[redacted-path]")
    .replace(/\b(?:[A-Z][A-Z0-9_]{2,}|(?:api|access|secret|session|auth|password|token)[_-]?[a-z0-9_]*)\s*=\s*[^\s,;]+/gi, "[redacted-env]")
    .replace(/\[[0-9a-f:]+\](?::\d+)?/gi, "[redacted-host]")
    .replace(/(^|[^a-z0-9])([0-9a-f:]{2,})(?=$|[^a-z0-9])/gi,
      (match, prefix: string, candidate: string) =>
        candidate.split(":").length >= 3 ? `${prefix}[redacted-host]` : match)
    .replace(/\b[a-z][a-z0-9-]{0,62}:\d{2,5}\b/gi, "[redacted-host]")
    .replace(/\b(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?\b/gi, "[redacted-host]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function safeComponent(value: unknown, maximum = 64) {
  const text = String(value ?? "").trim().slice(0, maximum);
  return RUNNER_COMPONENT_PATTERN.test(text) ? text : undefined;
}

function safeReferenceId(value: unknown) {
  const text = String(value ?? "").trim();
  return RUNNER_REFERENCE_ID_PATTERN.test(text) ? text : undefined;
}

function sanitizedRunnerActivity(activity: RunnerInstance["activity"]) {
  if (!activity || typeof activity !== "object") return undefined;
  const stage = redactedPublicText(activity.stage, 80) || undefined;
  const phase = redactedPublicText(activity.phase, 80) || undefined;
  const message = redactedPublicText(activity.message, 500) || undefined;
  const learningJobId = safeReferenceId(activity.learningJobId);
  const artifactIds = Array.isArray(activity.artifactIds)
    ? [...new Set(activity.artifactIds.flatMap((id) => {
      const safe = safeReferenceId(id);
      return safe ? [safe] : [];
    }))].slice(0, MAX_ACTIVITY_ARTIFACTS)
    : undefined;
  const usage = activity.tokenUsage && typeof activity.tokenUsage === "object"
    ? {
      input: clampInteger(activity.tokenUsage.input, 0, 0, MAX_TOKEN_COUNT),
      output: clampInteger(activity.tokenUsage.output, 0, 0, MAX_TOKEN_COUNT),
      ...(activity.tokenUsage.cached === undefined
        ? {}
        : { cached: clampInteger(activity.tokenUsage.cached, 0, 0, MAX_TOKEN_COUNT) }),
    }
    : undefined;
  if (!stage && !phase && !message && !learningJobId && !artifactIds?.length && !usage) return undefined;
  return {
    stage,
    phase,
    message,
    learningJobId,
    artifactIds,
    tokenUsage: usage,
  };
}

function sanitizedReportedLastError(
  reported: Omit<RunnerLastError, "at">,
  at: string,
): RunnerLastError {
  const code = safeComponent(reported.code, 80);
  const phase = redactedPublicText(reported.phase, 80) || undefined;
  const message = redactedPublicText(reported.message, 500, true) || "Runner reported an error.";
  return { code, message, at, phase };
}

function sameRunnerLastError(left: RunnerLastError | undefined, right: RunnerLastError) {
  return Boolean(left
    && left.code === right.code
    && left.message === right.message
    && left.phase === right.phase);
}

function nextRunnerLastError(
  input: HeartbeatRunnerInstanceInput,
  activity: RunnerInstance["activity"],
  previous: RunnerLastError | undefined,
  at: string,
) {
  const reported = input.lastError || (activity?.phase === "failed"
    ? { code: "runner_activity_failed", message: activity.message || "Runner reported an error.", phase: activity.phase }
    : undefined);
  if (!reported) return previous;
  const next = sanitizedReportedLastError(reported, at);
  return sameRunnerLastError(previous, next) ? previous : next;
}

function packedSessionToken(runnerId: string, sessionId: string, rawToken: string) {
  return `${runnerId}.${sessionId}.${rawToken}`;
}

function unpackSessionToken(runnerId: string, sessionId: string, packedToken: string) {
  const prefix = `${runnerId}.${sessionId}.`;
  if (!packedToken.startsWith(prefix) || packedToken.length <= prefix.length) throw new Error("runner_session_token_invalid");
  return packedToken.slice(prefix.length);
}

function bindingId(runnerId: string, siteAgentId: string, workKind: RunnerWorkKind) {
  const part = (value: string) => `${value.length}:${value}`;
  return `runner_binding:${part(runnerId)}:${part(siteAgentId)}:${part(workKind)}`;
}

function activeWorkKey(kind: RunnerLeaseRecord["workload"]["kind"], workloadId: string) {
  return `${kind}:${workloadId}`;
}

function activeSlotKey(runnerId: string, sessionId: string, slot: number) {
  return `${DEFAULT_RUNNER_POOL_ID}:${runnerId}:${sessionId}:${slot}`;
}

function observedInstance(instance: RunnerInstance, activeLeaseCount: number, nowMs = Date.now()): RunnerInstance {
  const heartbeatExpiresAt = Date.parse(instance.heartbeatExpiresAt);
  const lastHeartbeatAt = Date.parse(instance.lastHeartbeatAt);
  const maxConcurrency = instance.capabilities.maxConcurrency;
  let observedState: RunnerInstance["observedState"];
  if (!Number.isFinite(lastHeartbeatAt) || nowMs - lastHeartbeatAt >= OFFLINE_AFTER_MS) observedState = "offline";
  else if (!Number.isFinite(heartbeatExpiresAt) || heartbeatExpiresAt <= nowMs) observedState = "stale";
  else if (instance.activity?.phase === "failed"
    || (instance.observedState === "error" && instance.lastError?.at === instance.updatedAt)) observedState = "error";
  else if (instance.observedState === "starting" && nowMs - Date.parse(instance.updatedAt) < HEARTBEAT_INTERVAL_MS * 2) observedState = "starting";
  else if (activeLeaseCount === 0) observedState = "idle";
  else if (activeLeaseCount >= maxConcurrency) observedState = "busy";
  else observedState = "partial";
  return {
    ...instance,
    role: normalizedRunnerRole(instance.role),
    observedState,
    activeLeaseCount,
    availableSlots: instance.desiredState === "active" && !["stale", "offline", "error"].includes(observedState)
      ? Math.max(0, maxConcurrency - activeLeaseCount)
      : 0,
  };
}

function sanitizedRunnerInstance(instance: RunnerInstance): RunnerInstance {
  const maxConcurrency = clampInteger(instance.capabilities?.maxConcurrency, 1, 1, 32);
  const activity = sanitizedRunnerActivity(instance.activity);
  const browsers = [...new Set((instance.capabilities?.browsers || []).flatMap((browser) => {
    const safe = safeComponent(browser, 40);
    return safe ? [safe] : [];
  }))].slice(0, 8);
  const lastError = instance.lastError
    ? sanitizedReportedLastError(
      instance.lastError,
      Number.isFinite(Date.parse(instance.lastError.at)) ? instance.lastError.at : instance.updatedAt,
    )
    : undefined;
  return {
    ...instance,
    name: redactedPublicText(instance.name, 120) || "SiteWake Browser Runner",
    version: safeComponent(instance.version),
    capabilities: {
      browsers: browsers.length ? browsers : ["chromium"],
      maxConcurrency,
      recording: instance.capabilities?.recording !== false,
      prewarmCapacity: clampInteger(instance.capabilities?.prewarmCapacity, 0, 0, maxConcurrency),
      readySlots: clampInteger(instance.capabilities?.readySlots, 0, 0, maxConcurrency),
    },
    activity,
    lastError,
  };
}

async function ensureDefaultRunnerPool(database: D1DatabaseLike) {
  const now = new Date().toISOString();
  const pool = {
    id: DEFAULT_RUNNER_POOL_ID,
    name: "Default shared runners",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const result = await database.prepare(`INSERT OR IGNORE INTO site_agent_v2_runner_pools
    (id,name,status,pool_json,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
    .bind(pool.id, pool.name, pool.status, JSON.stringify(pool), now, now).run();
  if (!result.success) throw new Error(result.error || "runner_default_pool_create_failed");
}

async function runnerDatabase() {
  const database = getD1Binding();
  if (database) {
    await ensureSiteAgentV2Schema(database);
    await ensureDefaultRunnerPool(database);
  }
  return database;
}

async function activeLeaseCount(database: D1DatabaseLike | null, runnerId: string) {
  if (!database) {
    return [...memoryRunnerControl().leases.values()].filter(({ lease }) =>
      lease.runnerId === runnerId && ACTIVE_LEASE_STATUSES.includes(lease.status as (typeof ACTIVE_LEASE_STATUSES)[number])).length;
  }
  const rows = await all<{ count: number }>(database, `SELECT COUNT(*) AS count FROM site_agent_v2_runner_leases
    WHERE runner_id=? AND status IN ('active','completing')`, [runnerId]);
  return Number(rows[0]?.count || 0);
}

async function readStoredInstance(database: D1DatabaseLike | null, runnerId: string): Promise<StoredRunnerInstance | undefined> {
  if (!database) {
    const stored = memoryRunnerControl().instances.get(runnerId);
    if (!stored) return undefined;
    const desiredState = stored.desiredState || stored.instance.desiredState;
    return {
      ...stored,
      desiredState,
      instance: { ...stored.instance, desiredState },
    };
  }
  const rows = await all<RunnerInstanceRow>(database, `SELECT instance_json AS instanceJson,
    session_token_hash AS sessionTokenHash,desired_state AS desiredState
    FROM site_agent_v2_runner_instances WHERE id=? LIMIT 1`, [runnerId]);
  if (!rows[0]) return undefined;
  return {
    instance: {
      ...JSON.parse(rows[0].instanceJson) as RunnerInstance,
      desiredState: rows[0].desiredState,
    },
    sessionTokenHash: rows[0].sessionTokenHash,
    desiredState: rows[0].desiredState,
  };
}

async function publicInstance(database: D1DatabaseLike | null, instance: RunnerInstance) {
  return observedInstance(sanitizedRunnerInstance(instance), await activeLeaseCount(database, instance.id));
}

type BusinessLeaseMirror = {
  lease?: {
    leaseId?: string;
    runnerSessionId?: string;
    expiresAt?: string;
  };
};

export async function synchronizeBusinessLeaseMirrorExpiry(
  database: D1DatabaseLike,
  lease: RunnerLeaseRecord,
  expiresAt: string,
) {
  const workload = lease.workload;
  if (workload.kind === "capability-task") {
    const result = await database.prepare(`UPDATE site_agent_v2_capability_tasks
      SET runner_lease_expires_at=?,updated_at=? WHERE id=?
      AND runner_lease_id=? AND runner_session_id=? AND runner_lease_fence=?`)
      .bind(expiresAt, lease.updatedAt, workload.id, lease.id, lease.runnerSessionId, lease.fence).run();
    if (!result.success) throw new Error(result.error || "runner_capability_task_lease_expiry_failed");
    return;
  }
  const source = workload.kind === "capability-run"
    ? { table: "site_agent_v2_capability_runs", jsonColumn: "run_json", expiryColumn: "lease_expires_at" }
    : workload.kind === "learning-job"
      ? { table: "site_agent_v2_learning_jobs", jsonColumn: "result_json" }
      : { table: "site_agent_v2_validation_jobs", jsonColumn: "job_json", expiryColumn: "lease_expires_at" };
  const rows = await all<{ mirrorJson: string }>(database,
    `SELECT ${source.jsonColumn} AS mirrorJson FROM ${source.table} WHERE id=? LIMIT 1`,
    [workload.id]);
  if (!rows[0]) return;
  const mirror = JSON.parse(rows[0].mirrorJson) as BusinessLeaseMirror;
  if (mirror.lease?.leaseId !== lease.id || mirror.lease.runnerSessionId !== lease.runnerSessionId) return;
  const updated = {
    ...mirror,
    lease: { ...mirror.lease, expiresAt },
    updatedAt: lease.updatedAt,
  };
  const expiryAssignment = source.expiryColumn ? `${source.expiryColumn}=?,` : "";
  const values = source.expiryColumn
    ? [expiresAt, JSON.stringify(updated), lease.updatedAt, workload.id, lease.id, lease.runnerSessionId]
    : [JSON.stringify(updated), lease.updatedAt, workload.id, lease.id, lease.runnerSessionId];
  const result = await database.prepare(`UPDATE ${source.table}
    SET ${expiryAssignment}${source.jsonColumn}=?,updated_at=? WHERE id=?
    AND json_extract(${source.jsonColumn},'$.lease.leaseId')=?
    AND json_extract(${source.jsonColumn},'$.lease.runnerSessionId')=?`)
    .bind(...values).run();
  if (!result.success) throw new Error(result.error || "runner_business_lease_expiry_failed");
}

async function releaseSupersededSessionLeases(
  database: D1DatabaseLike | null,
  runnerId: string,
  currentSessionId: string,
  now: string,
) {
  const candidates = (await listStoredLeases(database)).filter(({ lease }) =>
    lease.runnerId === runnerId
    && lease.runnerSessionId !== currentSessionId
    && ACTIVE_LEASE_STATUSES.includes(lease.status as (typeof ACTIVE_LEASE_STATUSES)[number]));
  const current = await readStoredInstance(database, runnerId);
  if (current?.instance.sessionId !== currentSessionId) return;
  const released = candidates.map(({ lease, tokenHash }) => ({
    tokenHash,
    lease: {
      ...lease,
      status: "expired" as const,
      activeWorkKey: undefined,
      activeSlotKey: undefined,
      expiresAt: now,
      updatedAt: now,
      completion: {
        status: "released" as const,
        completedAt: now,
        result: { reason: "runner_session_superseded" },
      },
    },
  }));
  if (!released.length) return;
  if (!database) {
    for (const item of released) {
      const latest = memoryRunnerControl().leases.get(item.lease.id);
      if (!latest
        || latest.lease.runnerSessionId === currentSessionId
        || !ACTIVE_LEASE_STATUSES.includes(latest.lease.status as (typeof ACTIVE_LEASE_STATUSES)[number])) continue;
      memoryRunnerControl().leases.set(item.lease.id, item);
    }
    return;
  }
  const results = await database.batch(released.map(({ lease }) => database.prepare(`UPDATE site_agent_v2_runner_leases
    SET status='expired',active_work_key=NULL,active_slot_key=NULL,lease_json=?,expires_at=?,completed_at=?,updated_at=?
    WHERE id=? AND runner_id=? AND runner_session_id=? AND status IN ('active','completing')
      AND EXISTS (SELECT 1 FROM site_agent_v2_runner_instances
        WHERE id=? AND session_id=?)`)
    .bind(JSON.stringify(lease), now, now, now, lease.id, runnerId, lease.runnerSessionId, runnerId, currentSessionId)));
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "runner_superseded_lease_release_failed");
  await Promise.all(released.flatMap((item, index) =>
    changes(results[index]) > 0 ? [synchronizeBusinessLeaseMirrorExpiry(database, item.lease, now)] : []));
}

async function authorizeInstance(
  database: D1DatabaseLike | null,
  runnerId: string,
  sessionId?: string,
  sessionToken?: string,
  options: { allowLegacy?: boolean } = {},
) {
  const stored = await readStoredInstance(database, runnerId);
  if (!stored) throw new Error("runner_instance_not_found");
  if ((!sessionId || !sessionToken) && !options.allowLegacy) throw new Error("runner_session_required");
  if (sessionId && stored.instance.sessionId !== sessionId) throw new Error("runner_session_superseded");
  if (sessionToken) {
    const tokenSessionId = sessionId || stored.instance.sessionId;
    const rawToken = unpackSessionToken(runnerId, tokenSessionId, sessionToken);
    if (await sha256Hex(rawToken) !== stored.sessionTokenHash) throw new Error("runner_session_token_rejected");
  }
  return stored;
}

/** Validates that a control-plane request belongs to the runner's live session. */
export async function authorizeRunnerInstanceSession(
  runnerId: string,
  input: {
    sessionId?: string;
    sessionToken?: string;
    legacy?: boolean;
  },
) {
  const database = await runnerDatabase();
  const stored = await authorizeInstance(
    database,
    runnerId,
    input.sessionId,
    input.sessionToken,
    { allowLegacy: input.legacy === true },
  );
  return {
    instance: projectPublicRunnerInstance(await publicInstance(
      database,
      stored.instance,
    )),
    persistence: database ? "d1" as const : "memory" as const,
  };
}

export async function registerRunnerInstance(input: RegisterRunnerInstanceInput): Promise<RegisterRunnerInstanceResult> {
  const database = await runnerDatabase();
  const requestedId = input.id?.trim();
  if (requestedId && !RUNNER_INSTANCE_ID_PATTERN.test(requestedId)) throw new Error("runner_instance_id_invalid");
  const runnerId = requestedId || `runner_${crypto.randomUUID()}`;
  const maxConcurrency = clampInteger(input.maxConcurrency, 1, 1, 32);
  const requestedBrowsers = input.browsers?.flatMap((browser) => {
    const safe = safeComponent(browser, 40);
    return safe ? [safe] : [];
  });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await readStoredInstance(database, runnerId);
    const now = new Date();
    const sessionId = `runner_session_${crypto.randomUUID()}`;
    const rawToken = crypto.randomUUID().replaceAll("-", "");
    const sessionTokenHash = await sha256Hex(rawToken);
    const role = normalizedRunnerRole(input.role || current?.instance.role);
    const workKinds = normalizedWorkKinds(input, role, current?.instance);
    const currentBrowsers = current?.instance.capabilities.browsers.flatMap((browser) => {
      const safe = safeComponent(browser, 40);
      return safe ? [safe] : [];
    });
    const instance: RunnerInstance = {
      id: runnerId,
      ephemeral: !requestedId,
      poolId: DEFAULT_RUNNER_POOL_ID,
      sessionId,
      generation: (current?.instance.generation || 0) + 1,
      name: redactedPublicText(input.name, 120)
        || redactedPublicText(current?.instance.name, 120)
        || "SiteWake Browser Runner",
      version: safeComponent(input.version) || safeComponent(current?.instance.version),
      role,
      desiredState: current?.instance.desiredState || "active",
      observedState: "starting",
      workKinds,
      capabilities: {
        browsers: [...new Set((requestedBrowsers?.length ? requestedBrowsers : currentBrowsers?.length ? currentBrowsers : ["chromium"]))].slice(0, 8),
        maxConcurrency,
        recording: input.recording !== false,
        prewarmCapacity: clampInteger(input.prewarmCapacity, 0, 0, maxConcurrency),
        readySlots: clampInteger(input.readySlots, 0, 0, maxConcurrency),
      },
      activeLeaseCount: 0,
      availableSlots: 0,
      lastHeartbeatAt: now.toISOString(),
      heartbeatExpiresAt: new Date(now.getTime() + HEARTBEAT_TTL_MS).toISOString(),
      createdAt: current?.instance.createdAt || now.toISOString(),
      updatedAt: now.toISOString(),
      lastError: current?.instance.lastError
        ? sanitizedReportedLastError(
          current.instance.lastError,
          Number.isFinite(Date.parse(current.instance.lastError.at))
            ? current.instance.lastError.at
            : current.instance.updatedAt,
        )
        : undefined,
    };
    let registered = false;
    if (!database) {
      const latest = memoryRunnerControl().instances.get(runnerId);
      if (latest?.instance.sessionId !== current?.instance.sessionId) continue;
      memoryRunnerControl().instances.set(runnerId, {
        instance,
        sessionTokenHash,
        desiredState: instance.desiredState,
      });
      registered = true;
    } else if (current) {
      const result = await database.prepare(`UPDATE site_agent_v2_runner_instances SET
        pool_id=?,session_id=?,generation=?,desired_state=?,work_kinds_json=?,max_concurrency=?,
        session_token_hash=?,instance_json=?,last_heartbeat_at=?,heartbeat_expires_at=?,created_at=?,updated_at=?
        WHERE id=? AND session_id=? AND generation=?`)
        .bind(instance.poolId, instance.sessionId, instance.generation, instance.desiredState, JSON.stringify(instance.workKinds),
          instance.capabilities.maxConcurrency, sessionTokenHash, JSON.stringify(instance), instance.lastHeartbeatAt,
          instance.heartbeatExpiresAt, instance.createdAt, instance.updatedAt, instance.id,
          current.instance.sessionId, current.instance.generation).run();
      if (!result.success) throw new Error(result.error || "runner_instance_registration_failed");
      registered = changes(result) > 0;
    } else {
      const result = await database.prepare(`INSERT OR IGNORE INTO site_agent_v2_runner_instances
        (id,pool_id,session_id,generation,desired_state,work_kinds_json,max_concurrency,session_token_hash,instance_json,last_heartbeat_at,heartbeat_expires_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(instance.id, instance.poolId, instance.sessionId, instance.generation, instance.desiredState, JSON.stringify(instance.workKinds),
          instance.capabilities.maxConcurrency, sessionTokenHash, JSON.stringify(instance), instance.lastHeartbeatAt,
          instance.heartbeatExpiresAt, instance.createdAt, instance.updatedAt).run();
      if (!result.success) throw new Error(result.error || "runner_instance_registration_failed");
      registered = changes(result) > 0;
    }
    if (!registered) continue;
    await releaseSupersededSessionLeases(database, runnerId, sessionId, now.toISOString());
    return {
      instance: await publicInstance(database, instance),
      sessionToken: packedSessionToken(runnerId, sessionId, rawToken),
      persistence: database ? "d1" : "memory",
    };
  }
  throw new Error("runner_instance_registration_conflict");
}

export async function heartbeatRunnerInstance(
  runnerId: string,
  input: HeartbeatRunnerInstanceInput = {},
): Promise<HeartbeatRunnerInstanceResult> {
  const database = await runnerDatabase();
  const stored = await authorizeInstance(database, runnerId, input.sessionId, input.sessionToken, { allowLegacy: input.legacy === true });
  const now = new Date();
  const activity = input.activity === null
    ? undefined
    : sanitizedRunnerActivity(input.activity === undefined ? stored.instance.activity : input.activity);
  const previousLastError = stored.instance.lastError
    ? sanitizedReportedLastError(
      stored.instance.lastError,
      Number.isFinite(Date.parse(stored.instance.lastError.at))
        ? stored.instance.lastError.at
        : stored.instance.updatedAt,
    )
    : undefined;
  const lastError = nextRunnerLastError(input, activity, previousLastError, now.toISOString());
  const currentError = activity?.phase === "failed";
  const maxConcurrency = clampInteger(stored.instance.capabilities.maxConcurrency, 1, 1, 32);
  const instance: RunnerInstance = {
    ...stored.instance,
    observedState: currentError
      ? "error"
      : stored.instance.observedState === "starting" || stored.instance.observedState === "error"
        ? "idle"
        : stored.instance.observedState,
    capabilities: {
      ...stored.instance.capabilities,
      maxConcurrency,
      prewarmCapacity: clampInteger(stored.instance.capabilities.prewarmCapacity, 0, 0, maxConcurrency),
      readySlots: input.readySlots === undefined
        ? clampInteger(stored.instance.capabilities.readySlots, 0, 0, maxConcurrency)
        : clampInteger(input.readySlots, 0, 0, maxConcurrency),
    },
    activity,
    lastError,
    lastHeartbeatAt: now.toISOString(),
    heartbeatExpiresAt: new Date(now.getTime() + HEARTBEAT_TTL_MS).toISOString(),
    updatedAt: now.toISOString(),
  };
  if (!database) {
    const authoritative = memoryRunnerControl().instances.get(runnerId)?.desiredState
      || stored.desiredState
      || stored.instance.desiredState;
    instance.desiredState = authoritative;
    memoryRunnerControl().instances.set(runnerId, {
      ...stored,
      instance,
      desiredState: authoritative,
    });
  } else {
    const result = await database.prepare(`UPDATE site_agent_v2_runner_instances
      SET instance_json=?,last_heartbeat_at=?,heartbeat_expires_at=?,updated_at=?
      WHERE id=? AND session_id=?`)
      .bind(JSON.stringify(instance), instance.lastHeartbeatAt, instance.heartbeatExpiresAt, instance.updatedAt, runnerId, stored.instance.sessionId).run();
    if (!result.success) throw new Error(result.error || "runner_instance_heartbeat_failed");
    if (!changes(result)) throw new Error("runner_session_superseded");
  }
  const authoritativeStored = await readStoredInstance(database, runnerId);
  const authoritativeInstance = authoritativeStored?.instance || instance;
  return {
    instance: await publicInstance(database, authoritativeInstance),
    desiredState: authoritativeInstance.desiredState,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    persistence: database ? "d1" : "memory",
  };
}

export async function setRunnerDesiredState(runnerId: string, desiredState: RunnerDesiredState) {
  const database = await runnerDatabase();
  const stored = await authorizeInstance(database, runnerId, undefined, undefined, { allowLegacy: true });
  const now = new Date().toISOString();
  const instance = { ...stored.instance, desiredState, updatedAt: now };
  if (!database) memoryRunnerControl().instances.set(runnerId, {
    ...stored,
    instance,
    desiredState,
  });
  else {
    const result = await database.prepare(`UPDATE site_agent_v2_runner_instances SET desired_state=?,instance_json=?,updated_at=? WHERE id=?`)
      .bind(desiredState, JSON.stringify(instance), now, runnerId).run();
    if (!result.success) throw new Error(result.error || "runner_desired_state_update_failed");
    if (!changes(result)) throw new Error("runner_instance_not_found");
  }
  return {
    instance: projectPublicRunnerInstance(await publicInstance(database, instance)),
    persistence: database ? "d1" as const : "memory" as const,
  };
}

async function listBindings(database: D1DatabaseLike | null) {
  if (!database) return [...memoryRunnerControl().bindings.values()];
  const rows = await all<RunnerBindingRow>(database, `SELECT binding_json AS bindingJson
    FROM site_agent_v2_runner_placement_bindings ORDER BY created_at`);
  return rows.map((row) => JSON.parse(row.bindingJson) as RunnerPlacementBinding);
}

export async function putRunnerPlacementBinding(input: { runnerId: string; siteAgentId: string; workKind: RunnerWorkKind }) {
  const result = await upsertRunnerPlacementBinding({
    runnerId: input.runnerId,
    siteAgentId: input.siteAgentId,
    workKinds: [input.workKind],
  });
  return {
    binding: result.bindings[0],
    persistence: result.persistence,
  };
}

export async function upsertRunnerPlacementBinding(input: { runnerId: string; siteAgentId: string; workKinds: RunnerWorkKind[] }) {
  const workKinds = validatedBindingWorkKinds(input.workKinds, "runner_binding_work_kind_required");
  const database = await runnerDatabase();
  const stored = await authorizeInstance(database, input.runnerId, undefined, undefined, { allowLegacy: true });
  if (stored.instance.ephemeral) throw new Error("runner_binding_ephemeral_instance");
  if (workKinds.some((workKind) => !stored.instance.workKinds.includes(workKind))) {
    throw new Error("runner_binding_work_kind_unsupported");
  }
  const now = new Date().toISOString();
  const existing = new Map((await listBindings(database)).map((binding) => [binding.id, binding]));
  const bindings = workKinds.map((workKind): RunnerPlacementBinding => {
    const id = bindingId(input.runnerId, input.siteAgentId, workKind);
    return {
      id,
      poolId: DEFAULT_RUNNER_POOL_ID,
      siteAgentId: input.siteAgentId,
      workKind,
      target: { kind: "runner", runnerId: input.runnerId },
      exclusive: true,
      createdAt: existing.get(id)?.createdAt || now,
      updatedAt: now,
    };
  });
  if (!database) {
    for (const binding of bindings) memoryRunnerControl().bindings.set(binding.id, binding);
  } else {
    const results = await database.batch(bindings.map((binding) => database.prepare(`INSERT OR REPLACE INTO site_agent_v2_runner_placement_bindings
      (id,pool_id,site_agent_id,work_kind,target_kind,target_id,binding_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(binding.id, binding.poolId, binding.siteAgentId, binding.workKind, binding.target.kind, input.runnerId,
        JSON.stringify(binding), binding.createdAt, binding.updatedAt)));
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "runner_binding_write_failed");
  }
  return {
    bindings,
    persistence: database ? "d1" as const : "memory" as const,
  };
}

export async function deleteRunnerPlacementBinding(input: { runnerId: string; siteAgentId: string; workKinds?: RunnerWorkKind[] }) {
  const suppliedWorkKinds = input.workKinds !== undefined;
  const workKinds = suppliedWorkKinds
    ? validatedBindingWorkKinds(input.workKinds, "runner_binding_work_kind_invalid")
    : RUNNER_WORK_KINDS;
  const database = await runnerDatabase();
  if (!database) {
    for (const workKind of workKinds) memoryRunnerControl().bindings.delete(bindingId(input.runnerId, input.siteAgentId, workKind));
  } else {
    const placeholders = workKinds.map(() => "?").join(",");
    const result = await database.prepare(`DELETE FROM site_agent_v2_runner_placement_bindings
      WHERE target_kind='runner' AND target_id=? AND site_agent_id=? AND work_kind IN (${placeholders})`)
      .bind(input.runnerId, input.siteAgentId, ...workKinds).run();
    if (!result.success) throw new Error(result.error || "runner_binding_delete_failed");
  }
  return { removed: true, persistence: database ? "d1" as const : "memory" as const };
}

async function placementFor(
  database: D1DatabaseLike | null,
  runnerId: string,
  siteAgentId: string,
  workKind: RunnerWorkKind,
) {
  const bindings = await listBindings(database);
  const runnerBindings = bindings.filter((binding) =>
    binding.workKind === workKind && binding.target.kind === "runner" && binding.target.runnerId === runnerId);
  const siteBindings = bindings.filter((binding) => binding.workKind === workKind && binding.siteAgentId === siteAgentId);
  const exact = runnerBindings.some((binding) => binding.siteAgentId === siteAgentId);
  if (runnerBindings.length && !exact) throw new Error("runner_placement_runner_exclusive");
  if (!runnerBindings.length && siteBindings.length) throw new Error("runner_placement_site_exclusive");
  return exact ? "explicit-binding" as const : "default" as const;
}

async function listStoredLeases(database: D1DatabaseLike | null) {
  if (!database) return [...memoryRunnerControl().leases.values()];
  const rows = await all<RunnerLeaseRow>(database, `SELECT lease_json AS leaseJson,token_hash AS tokenHash
    FROM site_agent_v2_runner_leases ORDER BY created_at DESC`);
  return rows.map((row) => ({ lease: JSON.parse(row.leaseJson) as RunnerLeaseRecord, tokenHash: row.tokenHash }));
}

async function readStoredLease(database: D1DatabaseLike | null, leaseId: string): Promise<StoredRunnerLease | undefined> {
  if (!database) return memoryRunnerControl().leases.get(leaseId);
  const rows = await all<RunnerLeaseRow>(database, `SELECT lease_json AS leaseJson,token_hash AS tokenHash
    FROM site_agent_v2_runner_leases WHERE id=? LIMIT 1`, [leaseId]);
  return rows[0] ? { lease: JSON.parse(rows[0].leaseJson) as RunnerLeaseRecord, tokenHash: rows[0].tokenHash } : undefined;
}

export async function expireRunnerLeases(now = new Date()) {
  const database = await runnerDatabase();
  const expired = (await listStoredLeases(database)).filter(({ lease }) =>
    ACTIVE_LEASE_STATUSES.includes(lease.status as (typeof ACTIVE_LEASE_STATUSES)[number]) && lease.expiresAt <= now.toISOString());
  if (!expired.length) return { expired: 0, persistence: database ? "d1" as const : "memory" as const };
  const updated = expired.map(({ lease, tokenHash }) => ({
    tokenHash,
    lease: {
      ...lease,
      status: "expired" as const,
      activeWorkKey: undefined,
      activeSlotKey: undefined,
      updatedAt: now.toISOString(),
      completion: { status: "released" as const, completedAt: now.toISOString(), result: { reason: "lease_expired" } },
    },
  }));
  if (!database) {
    for (const item of updated) memoryRunnerControl().leases.set(item.lease.id, item);
  } else {
    const results = await database.batch(updated.map(({ lease }) => database.prepare(`UPDATE site_agent_v2_runner_leases
      SET status='expired',active_work_key=NULL,active_slot_key=NULL,lease_json=?,completed_at=?,updated_at=?
      WHERE id=? AND status IN ('active','completing') AND expires_at<=?`)
      .bind(JSON.stringify(lease), now.toISOString(), now.toISOString(), lease.id, now.toISOString())));
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "runner_lease_expiry_failed");
  }
  return { expired: updated.length, persistence: database ? "d1" as const : "memory" as const };
}

async function nextFence(database: D1DatabaseLike | null, workload: RunnerLeaseRecord["workload"]) {
  if (!database) {
    return Math.max(0, ...[...memoryRunnerControl().leases.values()]
      .filter(({ lease }) => lease.workload.kind === workload.kind && lease.workload.id === workload.id)
      .map(({ lease }) => lease.fence)) + 1;
  }
  const rows = await all<{ fence: number }>(database, `SELECT COALESCE(MAX(fence),0) AS fence
    FROM site_agent_v2_runner_leases WHERE workload_kind=? AND workload_id=?`, [workload.kind, workload.id]);
  return Number(rows[0]?.fence || 0) + 1;
}

export async function claimRunnerLease<TWork>(input: ClaimRunnerLeaseInput<TWork>): Promise<RunnerLeaseGrant<TWork>> {
  const database = await runnerDatabase();
  await expireRunnerLeases();
  const stored = await authorizeInstance(database, input.runnerId, input.runnerSessionId, input.sessionToken, { allowLegacy: input.legacy === true });
  const instance = await publicInstance(database, stored.instance);
  if (instance.sessionId !== (input.runnerSessionId || instance.sessionId)) throw new Error("runner_session_superseded");
  if (instance.desiredState !== "active") throw new Error("runner_instance_draining");
  if (["stale", "offline", "error"].includes(instance.observedState)) throw new Error("runner_instance_unavailable");
  if (!instance.workKinds.includes(input.workKind)) throw new Error("runner_work_kind_unsupported");
  const routing = await placementFor(database, input.runnerId, input.workload.siteAgentId, input.workKind);
  const workKey = activeWorkKey(input.workload.kind, input.workload.id);
  const ttlMs = leaseTtl(input.ttlMs, input.legacy === true);

  for (let attempt = 0; attempt < Math.max(2, instance.capabilities.maxConcurrency + 1); attempt += 1) {
    const active = (await listStoredLeases(database)).filter(({ lease }) =>
      lease.runnerId === input.runnerId && ACTIVE_LEASE_STATUSES.includes(lease.status as (typeof ACTIVE_LEASE_STATUSES)[number]));
    if (active.some(({ lease }) => lease.activeWorkKey === workKey)) throw new Error("runner_work_already_leased");
    const usedSlots = new Set(active.map(({ lease }) => lease.slot));
    const slot = Array.from({ length: instance.capabilities.maxConcurrency }, (_, index) => index).find((index) => !usedSlots.has(index));
    if (slot === undefined) throw new Error("runner_instance_capacity_exhausted");
    const now = new Date();
    const id = `runner_lease_${crypto.randomUUID()}`;
    const rawToken = crypto.randomUUID().replaceAll("-", "");
    const token = `${id}.${rawToken}`;
    const tokenHash = await sha256Hex(rawToken);
    const lease: RunnerLeaseRecord = {
      id,
      poolId: DEFAULT_RUNNER_POOL_ID,
      workload: input.workload,
      workKind: input.workKind,
      runnerId: input.runnerId,
      runnerSessionId: instance.sessionId,
      status: "active",
      fence: await nextFence(database, input.workload),
      slot,
      activeWorkKey: workKey,
      activeSlotKey: activeSlotKey(input.runnerId, instance.sessionId, slot),
      routing,
      leasedAt: now.toISOString(),
      renewedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    if (!database) {
      const memory = memoryRunnerControl();
      const collision = [...memory.leases.values()].some(({ lease: current }) =>
        current.activeWorkKey === lease.activeWorkKey || current.activeSlotKey === lease.activeSlotKey);
      if (collision) continue;
      memory.leases.set(id, { lease, tokenHash });
      return { lease, token, work: input.work };
    }
    const result = await database.prepare(`INSERT OR IGNORE INTO site_agent_v2_runner_leases
      (id,pool_id,active_work_key,active_slot_key,workload_kind,workload_id,site_agent_id,work_kind,runner_id,runner_session_id,status,fence,slot,token_hash,lease_json,leased_at,renewed_at,expires_at,completed_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(lease.id, lease.poolId, lease.activeWorkKey, lease.activeSlotKey, lease.workload.kind, lease.workload.id,
        lease.workload.siteAgentId, lease.workKind, lease.runnerId, lease.runnerSessionId, lease.status, lease.fence, lease.slot,
        tokenHash, JSON.stringify(lease), lease.leasedAt, lease.renewedAt, lease.expiresAt, null, lease.createdAt, lease.updatedAt).run();
    if (!result.success) throw new Error(result.error || "runner_lease_claim_failed");
    if (changes(result)) return { lease, token, work: input.work };
  }
  throw new Error("runner_lease_claim_conflict");
}

function unpackLeaseToken(leaseId: string, token: string) {
  const prefix = `${leaseId}.`;
  if (!token.startsWith(prefix) || token.length <= prefix.length) throw new Error("runner_lease_token_invalid");
  return token.slice(prefix.length);
}

async function authorizeLease(
  database: D1DatabaseLike | null,
  input: Pick<RenewRunnerLeaseInput, "runnerId" | "runnerSessionId" | "sessionToken" | "legacy" | "leaseId" | "token" | "fence">,
) {
  if (input.sessionToken || input.runnerSessionId || !input.legacy) {
    await authorizeInstance(database, input.runnerId, input.runnerSessionId, input.sessionToken, { allowLegacy: input.legacy === true });
  }
  const stored = await readStoredLease(database, input.leaseId);
  if (!stored) throw new Error("runner_lease_not_found");
  if (stored.lease.runnerId !== input.runnerId) throw new Error("runner_lease_runner_rejected");
  if (input.runnerSessionId && stored.lease.runnerSessionId !== input.runnerSessionId) throw new Error("runner_lease_session_rejected");
  if (stored.lease.fence !== input.fence) throw new Error("runner_lease_fence_rejected");
  if (await sha256Hex(unpackLeaseToken(input.leaseId, input.token)) !== stored.tokenHash) throw new Error("runner_lease_token_rejected");
  return stored;
}

export async function getRunnerLeaseMirror(
  input: Pick<RenewRunnerLeaseInput, "runnerId" | "runnerSessionId" | "sessionToken" | "legacy" | "leaseId" | "token" | "fence">,
) {
  const database = await runnerDatabase();
  const stored = await authorizeLease(database, input);
  return {
    lease: stored.lease,
    persistence: database ? "d1" as const : "memory" as const,
  };
}

export async function renewRunnerLease(input: RenewRunnerLeaseInput) {
  const database = await runnerDatabase();
  const stored = await authorizeLease(database, input);
  if (stored.lease.status !== "active") throw new Error(`runner_lease_not_renewable:${stored.lease.status}`);
  if (stored.lease.expiresAt <= new Date().toISOString()) throw new Error("runner_lease_expired");
  const now = new Date();
  const lease: RunnerLeaseRecord = {
    ...stored.lease,
    renewedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + leaseTtl(input.ttlMs, input.legacy === true)).toISOString(),
    updatedAt: now.toISOString(),
  };
  if (!database) memoryRunnerControl().leases.set(lease.id, { ...stored, lease });
  else {
    const result = await database.prepare(`UPDATE site_agent_v2_runner_leases
      SET lease_json=?,renewed_at=?,expires_at=?,updated_at=?
      WHERE id=? AND runner_id=? AND runner_session_id=? AND status='active' AND fence=? AND token_hash=? AND expires_at>?`)
      .bind(JSON.stringify(lease), lease.renewedAt, lease.expiresAt, lease.updatedAt, lease.id, lease.runnerId,
        lease.runnerSessionId, lease.fence, stored.tokenHash, now.toISOString()).run();
    if (!result.success) throw new Error(result.error || "runner_lease_renew_failed");
    if (!changes(result)) throw new Error("runner_lease_renew_conflict");
    await synchronizeBusinessLeaseMirrorExpiry(database, lease, lease.expiresAt);
  }
  return { lease, persistence: database ? "d1" as const : "memory" as const };
}

export async function beginRunnerLeaseCompletion(
  input: Omit<CompleteRunnerLeaseInput, "status" | "result">,
  options: { now?: Date } = {},
): Promise<BeginRunnerLeaseCompletionResult> {
  const database = await runnerDatabase();
  const stored = await authorizeLease(database, input);
  if (TERMINAL_LEASE_STATUSES.includes(stored.lease.status as (typeof TERMINAL_LEASE_STATUSES)[number])) {
    return { lease: stored.lease, duplicate: true, inProgress: false, persistence: database ? "d1" as const : "memory" as const };
  }
  const now = options.now || new Date();
  const nowIso = now.toISOString();
  if (stored.lease.expiresAt <= nowIso) throw new Error("runner_lease_expired");
  const currentLockExpiresAt = stored.lease.completionLockExpiresAt
    || new Date(Date.parse(stored.lease.updatedAt) + COMPLETION_LOCK_MS).toISOString();
  if (stored.lease.status === "completing" && currentLockExpiresAt > nowIso) {
    return {
      lease: stored.lease,
      duplicate: true,
      inProgress: true,
      retryAfterMs: Math.max(1, Date.parse(currentLockExpiresAt) - now.getTime()),
      persistence: database ? "d1" as const : "memory" as const,
    };
  }
  if (stored.lease.status !== "active" && stored.lease.status !== "completing") {
    throw new Error("runner_lease_completion_conflict");
  }
  const resumed = stored.lease.status === "completing";
  const lease: RunnerLeaseRecord = {
    ...stored.lease,
    status: "completing",
    completionLockExpiresAt: new Date(now.getTime() + COMPLETION_LOCK_MS).toISOString(),
    expiresAt: new Date(now.getTime() + DEFAULT_LEASE_TTL_MS).toISOString(),
    updatedAt: nowIso,
  };
  if (!database) {
    const latest = memoryRunnerControl().leases.get(lease.id);
    if (latest && TERMINAL_LEASE_STATUSES.includes(latest.lease.status as (typeof TERMINAL_LEASE_STATUSES)[number])) {
      return {
        lease: latest.lease,
        duplicate: true,
        inProgress: false,
        persistence: "memory" as const,
      };
    }
    if (!latest || (latest.lease.status !== "active" && latest.lease.status !== "completing")) {
      throw new Error("runner_lease_completion_conflict");
    }
    const sameVersion = latest.lease.status === stored.lease.status
      && latest.lease.updatedAt === stored.lease.updatedAt
      && latest.lease.completionLockExpiresAt === stored.lease.completionLockExpiresAt;
    if (!sameVersion) {
      const latestLock = latest.lease.completionLockExpiresAt
        || new Date(Date.parse(latest.lease.updatedAt) + COMPLETION_LOCK_MS).toISOString();
      return {
        lease: latest.lease,
        duplicate: true,
        inProgress: latest.lease.status === "completing",
        retryAfterMs: latest.lease.status === "completing"
          ? Math.max(1, Date.parse(latestLock) - now.getTime())
          : undefined,
        persistence: "memory" as const,
      };
    }
    memoryRunnerControl().leases.set(lease.id, { ...stored, lease });
  }
  else {
    const result = await database.prepare(`UPDATE site_agent_v2_runner_leases
      SET status='completing',lease_json=?,expires_at=?,updated_at=?
      WHERE id=? AND status=? AND fence=? AND token_hash=? AND expires_at>? AND updated_at=?`)
      .bind(JSON.stringify(lease), lease.expiresAt, nowIso, lease.id, stored.lease.status,
        lease.fence, stored.tokenHash, nowIso, stored.lease.updatedAt).run();
    if (!result.success) throw new Error(result.error || "runner_lease_completion_begin_failed");
    if (!changes(result)) {
      const latest = await readStoredLease(database, lease.id);
      if (latest && (latest.lease.status === "completing" || TERMINAL_LEASE_STATUSES.includes(latest.lease.status as (typeof TERMINAL_LEASE_STATUSES)[number]))) {
        return {
          lease: latest.lease,
          duplicate: true,
          inProgress: latest.lease.status === "completing",
          retryAfterMs: latest.lease.status === "completing"
            ? Math.max(1, Date.parse(latest.lease.completionLockExpiresAt || latest.lease.updatedAt) - now.getTime())
            : undefined,
          persistence: "d1" as const,
        };
      }
      throw new Error("runner_lease_completion_conflict");
    }
    await synchronizeBusinessLeaseMirrorExpiry(database, lease, lease.expiresAt);
  }
  return {
    lease,
    duplicate: false,
    inProgress: false,
    resumed,
    persistence: database ? "d1" as const : "memory" as const,
  };
}

export async function acquireRunnerLeaseCompletion(
  input: Omit<CompleteRunnerLeaseInput, "status" | "result">,
) {
  const deadline = Date.now() + COMPLETION_RECOVERY_WAIT_MS;
  while (true) {
    const result = await beginRunnerLeaseCompletion(input);
    if (!result.inProgress) return result;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("runner_lease_completion_busy");
    await new Promise((resolve) => setTimeout(
      resolve,
      Math.min(remaining, Math.max(1, result.retryAfterMs || COMPLETION_LOCK_MS)),
    ));
  }
}

/**
 * Releases a completion lock when the business Run was not durably committed.
 *
 * This is deliberately a CAS back to `active`, not a terminal failure. A
 * transport/database fault while recording the Run must remain retryable by
 * the same fenced runner.
 */
export async function abortRunnerLeaseCompletion(
  input: Omit<CompleteRunnerLeaseInput, "status" | "result">,
) {
  const database = await runnerDatabase();
  const stored = await authorizeLease(database, input);
  if (stored.lease.status !== "completing") {
    return {
      lease: stored.lease,
      duplicate: true,
      persistence: database ? "d1" as const : "memory" as const,
    };
  }
  const now = new Date().toISOString();
  const lease: RunnerLeaseRecord = {
    ...stored.lease,
    status: "active",
    completionLockExpiresAt: undefined,
    updatedAt: now,
  };
  if (!database) {
    const latest = memoryRunnerControl().leases.get(lease.id);
    if (!latest
      || latest.lease.status !== "completing"
      || latest.lease.updatedAt !== stored.lease.updatedAt
      || latest.lease.completionLockExpiresAt !== stored.lease.completionLockExpiresAt) {
      throw new Error("runner_lease_completion_abort_conflict");
    }
    memoryRunnerControl().leases.set(lease.id, { ...stored, lease });
  } else {
    const result = await database.prepare(`UPDATE site_agent_v2_runner_leases
      SET status='active',lease_json=?,updated_at=?
      WHERE id=? AND status='completing' AND fence=? AND token_hash=?
        AND updated_at=?`)
      .bind(
        JSON.stringify(lease),
        now,
        lease.id,
        lease.fence,
        stored.tokenHash,
        stored.lease.updatedAt,
      ).run();
    if (!result.success) {
      throw new Error(result.error || "runner_lease_completion_abort_failed");
    }
    if (!changes(result)) {
      throw new Error("runner_lease_completion_abort_conflict");
    }
    await synchronizeBusinessLeaseMirrorExpiry(database, lease, lease.expiresAt);
  }
  return {
    lease,
    duplicate: false,
    persistence: database ? "d1" as const : "memory" as const,
  };
}

export async function completeRunnerLease(input: CompleteRunnerLeaseInput) {
  const database = await runnerDatabase();
  const stored = await authorizeLease(database, input);
  if (TERMINAL_LEASE_STATUSES.includes(stored.lease.status as (typeof TERMINAL_LEASE_STATUSES)[number])) {
    return { lease: stored.lease, duplicate: true, persistence: database ? "d1" as const : "memory" as const };
  }
  if (stored.lease.expiresAt <= new Date().toISOString()) throw new Error("runner_lease_expired");
  const now = new Date().toISOString();
  const lease: RunnerLeaseRecord = {
    ...stored.lease,
    status: input.status,
    activeWorkKey: undefined,
    activeSlotKey: undefined,
    completionLockExpiresAt: undefined,
    updatedAt: now,
    completion: { status: input.status, result: input.result, completedAt: now },
  };
  if (!database) {
    const latest = memoryRunnerControl().leases.get(lease.id);
    if (latest && TERMINAL_LEASE_STATUSES.includes(latest.lease.status as (typeof TERMINAL_LEASE_STATUSES)[number])) {
      return { lease: latest.lease, duplicate: true, persistence: "memory" as const };
    }
    if (!latest || !ACTIVE_LEASE_STATUSES.includes(latest.lease.status as (typeof ACTIVE_LEASE_STATUSES)[number])) {
      throw new Error("runner_lease_completion_conflict");
    }
    memoryRunnerControl().leases.set(lease.id, { ...stored, lease });
  }
  else {
    const result = await database.prepare(`UPDATE site_agent_v2_runner_leases
      SET status=?,active_work_key=NULL,active_slot_key=NULL,lease_json=?,completed_at=?,updated_at=?
      WHERE id=? AND status IN ('active','completing') AND fence=? AND token_hash=?`)
      .bind(lease.status, JSON.stringify(lease), now, now, lease.id, lease.fence, stored.tokenHash).run();
    if (!result.success) throw new Error(result.error || "runner_lease_complete_failed");
    if (!changes(result)) {
      const latest = await readStoredLease(database, lease.id);
      if (latest && TERMINAL_LEASE_STATUSES.includes(latest.lease.status as (typeof TERMINAL_LEASE_STATUSES)[number])) {
        return { lease: latest.lease, duplicate: true, persistence: "d1" as const };
      }
      throw new Error("runner_lease_completion_conflict");
    }
  }
  return { lease, duplicate: false, persistence: database ? "d1" as const : "memory" as const };
}

export async function releaseRunnerLease(
  input: Omit<CompleteRunnerLeaseInput, "status"> & { result?: unknown },
) {
  return completeRunnerLease({ ...input, status: "released" });
}

/** Administrative cancellation path used by the owning business workflow. */
export async function releaseRunnerLeasesForWorkload(
  workload: { kind: RunnerLeaseRecord["workload"]["kind"]; id: string; siteAgentId: string },
  result: unknown = { code: "user_cancelled", summary: "Task cancelled by an administrator." },
) {
  const database = await runnerDatabase();
  const active = (await listStoredLeases(database)).filter(({ lease }) =>
    lease.workload.kind === workload.kind
    && lease.workload.id === workload.id
    && lease.workload.siteAgentId === workload.siteAgentId
    && ACTIVE_LEASE_STATUSES.includes(lease.status as (typeof ACTIVE_LEASE_STATUSES)[number]));
  if (!active.length) return { released: 0, persistence: database ? "d1" as const : "memory" as const };
  const now = new Date().toISOString();
  const released = active.map(({ lease, tokenHash }) => ({
    tokenHash,
    lease: {
      ...lease,
      status: "released" as const,
      activeWorkKey: undefined,
      activeSlotKey: undefined,
      completionLockExpiresAt: undefined,
      completion: { status: "released" as const, result, completedAt: now },
      updatedAt: now,
    },
  }));
  if (!database) {
    for (const item of released) memoryRunnerControl().leases.set(item.lease.id, item);
    return { released: released.length, persistence: "memory" as const };
  }
  const results = await database.batch(released.map(({ lease }) => database.prepare(`UPDATE site_agent_v2_runner_leases
    SET status='released',active_work_key=NULL,active_slot_key=NULL,lease_json=?,completed_at=?,updated_at=?
    WHERE id=? AND workload_kind=? AND workload_id=? AND site_agent_id=? AND status IN ('active','completing') AND fence=?`)
    .bind(JSON.stringify(lease), now, now, lease.id, workload.kind, workload.id, workload.siteAgentId, lease.fence)));
  const failure = results.find((item) => !item.success);
  if (failure) throw new Error(failure.error || "runner_lease_cancel_failed");
  const count = results.reduce((total, item) => total + changes(item), 0);
  if (count !== released.length) throw new Error("runner_lease_cancel_conflict");
  return { released: count, persistence: "d1" as const };
}

async function listInstances(database: D1DatabaseLike | null) {
  const instances = !database
    ? [...memoryRunnerControl().instances.values()].map((stored) => ({
      ...stored.instance,
      desiredState: stored.desiredState || stored.instance.desiredState,
    }))
    : (await all<Pick<RunnerInstanceRow, "instanceJson" | "desiredState">>(database, `SELECT
      instance_json AS instanceJson,desired_state AS desiredState
      FROM site_agent_v2_runner_instances ORDER BY created_at`)).map((row) => ({
      ...JSON.parse(row.instanceJson) as RunnerInstance,
      desiredState: row.desiredState,
    }));
  return Promise.all(instances.map((instance) => publicInstance(database, instance)));
}

async function runnerQueueHealth(database: D1DatabaseLike | null, siteAgentId?: string): Promise<RunnerQueueHealth[]> {
  if (!database) return RUNNER_WORK_KINDS.map((workKind) => ({ workKind, queuedWorkCount: 0 }));
  const now = new Date().toISOString();
  const siteFilter = siteAgentId ? " AND site_agent_id=?" : "";
  const values = siteAgentId ? [now, siteAgentId] : [now];
  const [executeRows, authorRows, validationRows, capabilityAuthorRows, capabilityValidationRows] = await Promise.all([
    all<{ queuedWorkCount: number; oldestQueuedAt?: string }>(database, `SELECT COUNT(*) AS queuedWorkCount,MIN(created_at) AS oldestQueuedAt
      FROM site_agent_v2_capability_runs WHERE environment_kind='cloud-browser'
      AND (status='queued' OR (status='running' AND lease_expires_at<=?))${siteFilter}`, values),
    all<{ queuedWorkCount: number; oldestQueuedAt?: string }>(database, `SELECT COUNT(*) AS queuedWorkCount,MIN(created_at) AS oldestQueuedAt
      FROM site_agent_v2_learning_jobs WHERE json_extract(result_json,'$.phase')='author'
      AND (status='queued' OR (status IN ('leased','running') AND json_extract(result_json,'$.lease.expiresAt')<=?))${siteFilter}`, values),
    all<{ queuedWorkCount: number; oldestQueuedAt?: string }>(database, `SELECT COUNT(*) AS queuedWorkCount,MIN(created_at) AS oldestQueuedAt
      FROM site_agent_v2_validation_jobs WHERE
      (status='queued' OR (status IN ('leased','running') AND lease_expires_at<=?))${siteFilter}`, values),
    all<{ queuedWorkCount: number; oldestQueuedAt?: string }>(database, `SELECT COUNT(*) AS queuedWorkCount,MIN(created_at) AS oldestQueuedAt
      FROM site_agent_v2_capability_tasks WHERE type IN ('generate','repair') AND stage IN ('queued','author')
      AND (status='queued' OR (status='running' AND runner_lease_expires_at<=?))${siteFilter}`, values),
    all<{ queuedWorkCount: number; oldestQueuedAt?: string }>(database, `SELECT COUNT(*) AS queuedWorkCount,MIN(created_at) AS oldestQueuedAt
      FROM site_agent_v2_capability_tasks WHERE (stage='validate' OR (type='validate' AND stage='queued'))
      AND (status='queued' OR (status='running' AND runner_lease_expires_at<=?))${siteFilter}`, values),
  ]);
  const authorCount = Number(authorRows[0]?.queuedWorkCount || 0) + Number(capabilityAuthorRows[0]?.queuedWorkCount || 0);
  const validationCount = Number(validationRows[0]?.queuedWorkCount || 0) + Number(capabilityValidationRows[0]?.queuedWorkCount || 0);
  const oldest = (...values: Array<string | undefined>) => values.filter((value): value is string => Boolean(value)).sort()[0];
  return [
    { workKind: "execute", queuedWorkCount: Number(executeRows[0]?.queuedWorkCount || 0), oldestQueuedAt: executeRows[0]?.oldestQueuedAt || undefined },
    { workKind: "author", queuedWorkCount: authorCount, oldestQueuedAt: oldest(authorRows[0]?.oldestQueuedAt, capabilityAuthorRows[0]?.oldestQueuedAt) },
    { workKind: "validate", queuedWorkCount: validationCount, oldestQueuedAt: oldest(validationRows[0]?.oldestQueuedAt, capabilityValidationRows[0]?.oldestQueuedAt) },
  ];
}

type QueuedRunnerTaskRow = {
  id: string;
  siteAgentId: string;
  createdAt: string;
  updatedAt: string;
};

async function listQueuedRunnerTasks(database: D1DatabaseLike | null): Promise<RunnerTaskProjection[]> {
  if (!database) return [];
  const now = new Date().toISOString();
  const [executeRows, authorRows, validationRows, capabilityRows] = await Promise.all([
    all<QueuedRunnerTaskRow>(database, `SELECT id,site_agent_id AS siteAgentId,created_at AS createdAt,updated_at AS updatedAt
      FROM site_agent_v2_capability_runs WHERE environment_kind='cloud-browser'
      AND (status='queued' OR (status='running' AND lease_expires_at<=?))
      ORDER BY created_at`, [now]),
    all<QueuedRunnerTaskRow>(database, `SELECT id,site_agent_id AS siteAgentId,created_at AS createdAt,updated_at AS updatedAt
      FROM site_agent_v2_learning_jobs WHERE json_extract(result_json,'$.phase')='author'
      AND (status='queued' OR (status IN ('leased','running') AND json_extract(result_json,'$.lease.expiresAt')<=?))
      ORDER BY created_at`, [now]),
    all<QueuedRunnerTaskRow>(database, `SELECT id,site_agent_id AS siteAgentId,created_at AS createdAt,updated_at AS updatedAt
      FROM site_agent_v2_validation_jobs
      WHERE status='queued' OR (status IN ('leased','running') AND lease_expires_at<=?)
      ORDER BY created_at`, [now]),
    all<QueuedRunnerTaskRow & { type: string; stage: string }>(database, `SELECT id,site_agent_id AS siteAgentId,
      type,stage,created_at AS createdAt,updated_at AS updatedAt
      FROM site_agent_v2_capability_tasks WHERE
      (status='queued' OR (status='running' AND runner_lease_expires_at<=?))
      AND ((type IN ('generate','repair') AND stage IN ('queued','author'))
        OR stage='validate' OR (type='validate' AND stage='queued'))
      ORDER BY created_at`, [now]),
  ]);
  const project = (
    row: QueuedRunnerTaskRow,
    workloadKind: RunnerLeaseRecord["workload"]["kind"],
    workKind: RunnerWorkKind,
  ): RunnerTaskProjection => ({
    id: `runner_task:${workloadKind}:${row.id}`,
    workload: { kind: workloadKind, id: row.id, siteAgentId: row.siteAgentId },
    siteAgentId: row.siteAgentId,
    workKind,
    status: "queued",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    attempts: [],
  });
  return [
    ...executeRows.map((row) => project(row, "capability-run", "execute")),
    ...authorRows.map((row) => project(row, "learning-job", "author")),
    ...validationRows.map((row) => project(row, "validation-job", "validate")),
    ...capabilityRows.map((row) => project(
      row,
      "capability-task",
      row.stage === "validate" || row.type === "validate" ? "validate" : "author",
    )),
  ];
}

type RunnerTaskBrowserRunSource = RunnerTaskBrowserRunProjection & {
  learningJobId: string;
  validationJobId?: string;
  runnerId: string;
};

async function listRunnerTaskBrowserRuns(database: D1DatabaseLike | null): Promise<RunnerTaskBrowserRunSource[]> {
  if (!database) return [];
  const rows = await all<{ runJson: string }>(database, `SELECT run_json AS runJson
    FROM site_agent_v2_browser_runs ORDER BY started_at DESC LIMIT 500`);
  return rows.flatMap((row) => {
    const run = JSON.parse(row.runJson) as RunnerTaskBrowserRunSource;
    if (!run.id || !run.runnerId || !run.learningJobId || !run.startedAt) return [];
    return [{
      id: run.id,
      learningJobId: run.learningJobId,
      validationJobId: run.validationJobId,
      runnerId: run.runnerId,
      mode: run.mode,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    }];
  });
}

function taskStatusForLease(lease: RunnerLeaseRecord): RunnerTaskStatus {
  return lease.status === "active" || lease.status === "completing" ? lease.status : "terminal";
}

function browserRunMatchesWorkload(run: RunnerTaskBrowserRunSource, lease: RunnerLeaseRecord) {
  if (run.runnerId !== lease.runnerId) return false;
  if (lease.workload.kind === "capability-run") {
    return run.learningJobId === `capability_run:${lease.workload.id}`
      && (run.mode === "execute" || run.mode === "debug");
  }
  if (lease.workload.kind === "learning-job") {
    return run.learningJobId === lease.workload.id && run.mode === "author";
  }
  if (lease.workload.kind === "validation-job") return run.validationJobId === lease.workload.id;
  if (lease.workload.kind === "capability-task") {
    return run.learningJobId === lease.workload.id
      && run.mode === lease.workKind;
  }
  return false;
}

function runnerTaskFailure(lease: RunnerLeaseRecord) {
  if (lease.status !== "failed") return undefined;
  const result = lease.completion?.result;
  const resultRecord = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : undefined;
  const run = resultRecord?.run && typeof resultRecord.run === "object" && !Array.isArray(resultRecord.run)
    ? resultRecord.run as Record<string, unknown>
    : undefined;
  const error = run?.error && typeof run.error === "object" && !Array.isArray(run.error)
    ? run.error as Record<string, unknown>
    : undefined;
  const outcome = run?.outcome && typeof run.outcome === "object" && !Array.isArray(run.outcome)
    ? run.outcome as Record<string, unknown>
    : undefined;
  const rawCode = typeof error?.code === "string"
    ? error.code
    : typeof outcome?.code === "string"
      ? outcome.code
      : "runner_task_failed";
  const rawMessage = typeof error?.summary === "string"
    ? error.summary
    : typeof error?.message === "string"
      ? error.message
      : typeof outcome?.summary === "string"
        ? outcome.summary
        : rawCode;
  const code = safeComponent(rawCode, 80) || "runner_task_failed";
  const message = redactedPublicText(rawMessage, 500, true) || code;
  return { code, message };
}

function leaseAttemptProjection(
  lease: RunnerLeaseRecord,
  nextLease: RunnerLeaseRecord | undefined,
  browserRuns: RunnerTaskBrowserRunSource[],
  attemptNumber: number,
): RunnerTaskAttemptProjection {
  const status: RunnerTaskStatus = lease.status === "active" || lease.status === "completing"
    ? lease.status
    : "terminal";
  return {
    // The timestamp-based public lease id can collide when a retry is claimed
    // in the same millisecond. The workload-local ordinal keeps the display id
    // stable and unique without exposing the central lease id or fence.
    displayId: `${runnerLeaseDisplayId(lease)}:attempt:${attemptNumber}`,
    runnerId: lease.runnerId,
    status: status as RunnerTaskAttemptProjection["status"],
    terminalStatus: status === "terminal" ? lease.status as RunnerTaskProjection["terminalStatus"] : undefined,
    leasedAt: lease.leasedAt,
    renewedAt: lease.renewedAt,
    expiresAt: lease.expiresAt,
    completedAt: lease.completion?.completedAt,
    failure: runnerTaskFailure(lease),
    browserRuns: browserRuns
      .filter((run) => browserRunMatchesWorkload(run, lease))
      .filter((run) => run.startedAt >= lease.leasedAt && (!nextLease || run.startedAt < nextLease.leasedAt))
      .map((run) => ({
        id: run.id,
        mode: run.mode,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
      }))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
  };
}

export function projectRunnerControlTasks(input: {
  leases: RunnerLeaseRecord[];
  queued: RunnerTaskProjection[];
  browserRuns?: RunnerTaskBrowserRunSource[];
}) {
  const browserRuns = input.browserRuns || [];
  const grouped = new Map<string, { leases: RunnerLeaseRecord[]; queued?: RunnerTaskProjection }>();
  for (const lease of input.leases) {
    const key = activeWorkKey(lease.workload.kind, lease.workload.id);
    const current = grouped.get(key) || { leases: [] };
    current.leases.push(lease);
    grouped.set(key, current);
  }
  for (const task of input.queued) {
    const key = activeWorkKey(task.workload.kind, task.workload.id);
    const current = grouped.get(key) || { leases: [] };
    current.queued = task;
    grouped.set(key, current);
  }
  return [...grouped.entries()].map(([key, group]): RunnerTaskProjection => {
    const timeline = group.leases.toSorted((left, right) =>
      left.fence - right.fence
      || left.leasedAt.localeCompare(right.leasedAt)
      || left.createdAt.localeCompare(right.createdAt));
    const latest = timeline.at(-1);
    const attempts = timeline.map((lease, index) =>
      leaseAttemptProjection(lease, timeline[index + 1], browserRuns, index + 1));
    if (!latest) return group.queued!;
    const status = taskStatusForLease(latest);
    const createdAt = [group.queued?.createdAt, ...timeline.map((lease) => lease.createdAt)]
      .filter((value): value is string => Boolean(value))
      .sort()[0]!;
    const updatedAt = [group.queued?.updatedAt, ...timeline.map((lease) => lease.updatedAt)]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1)!;
    if (group.queued && status === "terminal") {
      return {
        ...group.queued,
        id: `runner_task:${key}`,
        createdAt,
        updatedAt,
        attempts,
      };
    }
    return {
      id: `runner_task:${key}`,
      workload: latest.workload,
      siteAgentId: latest.workload.siteAgentId,
      workKind: latest.workKind,
      status,
      terminalStatus: status === "terminal" ? latest.status as RunnerTaskProjection["terminalStatus"] : undefined,
      runnerId: latest.runnerId,
      createdAt,
      updatedAt,
      leasedAt: latest.leasedAt,
      renewedAt: latest.renewedAt,
      expiresAt: latest.expiresAt,
      completedAt: latest.completion?.completedAt,
      failure: runnerTaskFailure(latest),
      attempts,
    };
  });
}

export function installRunnerVisibilityProvider(provider?: RunnerVisibilityProvider) {
  runnerVisibilityProvider = provider;
}

export function configuredRunnerLeaseAuthority(): "central" | "legacy" {
  return process.env.SITEWAKE_RUNNER_LEASE_AUTHORITY?.trim().toLowerCase() === "legacy"
    ? "legacy"
    : "central";
}

export function configuredRunnerProjectionMode(context: { siteAgentId?: string } = {}): RunnerProjectionMode {
  const provided = runnerVisibilityProvider?.projectionMode(context);
  if (provided === "full" || provided === "aggregate" || provided === "hidden") return provided;
  const configured = process.env.SITEWAKE_RUNNER_VISIBILITY?.trim().toLowerCase();
  return configured === "aggregate" || configured === "hidden" ? configured : "full";
}

function siteScopedRunnerInstance(instance: RunnerInstance, activeLeaseCount: number): RunnerInstance {
  const maxConcurrency = instance.capabilities.maxConcurrency;
  const observedState = ["starting", "stale", "offline", "error"].includes(instance.observedState)
    ? instance.observedState
    : activeLeaseCount === 0
      ? "idle"
      : activeLeaseCount >= maxConcurrency
        ? "busy"
        : "partial";
  return {
    ...instance,
    observedState,
    activeLeaseCount,
    availableSlots: instance.desiredState === "active" && !["stale", "offline", "error"].includes(observedState)
      ? Math.max(0, maxConcurrency - activeLeaseCount)
      : 0,
    activity: undefined,
    lastError: undefined,
  };
}

export async function getRunnerControlProjection(
  options: { siteAgentId?: string; mode?: RunnerProjectionMode } = {},
): Promise<RunnerControlProjection> {
  const database = await runnerDatabase();
  await expireRunnerLeases();
  const [loadedInstances, loadedBindings, loadedLeases, queueHealth, platformQueueHealth] = await Promise.all([
    listInstances(database),
    listBindings(database),
    listStoredLeases(database).then((items) => items.map(({ lease }) => lease)),
    runnerQueueHealth(database, options.siteAgentId),
    options.siteAgentId ? runnerQueueHealth(database) : Promise.resolve(undefined),
  ]);
  let instances = loadedInstances;
  let bindings = loadedBindings;
  let leases = loadedLeases;
  if (options.siteAgentId) {
    const siteAgentId = options.siteAgentId;
    const allBindings = bindings;
    instances = instances.filter((instance) => instance.workKinds.some((workKind) => {
      const runnerBindings = allBindings.filter((binding) =>
        binding.workKind === workKind && binding.target.kind === "runner" && binding.target.runnerId === instance.id);
      const siteBindings = allBindings.filter((binding) => binding.workKind === workKind && binding.siteAgentId === siteAgentId);
      return runnerBindings.some((binding) => binding.siteAgentId === siteAgentId)
        || (!runnerBindings.length && !siteBindings.length);
    }));
    const instanceIds = new Set(instances.map((instance) => instance.id));
    bindings = bindings.filter((binding) => binding.siteAgentId === siteAgentId);
    leases = leases.filter((lease) => lease.workload.siteAgentId === siteAgentId && instanceIds.has(lease.runnerId));
    const activeLeaseCounts = new Map<string, number>();
    for (const lease of leases) {
      if (lease.status !== "active" && lease.status !== "completing") continue;
      activeLeaseCounts.set(lease.runnerId, (activeLeaseCounts.get(lease.runnerId) || 0) + 1);
    }
    instances = instances.map((instance) =>
      siteScopedRunnerInstance(instance, activeLeaseCounts.get(instance.id) || 0));
  }
  return projectRunnerControl({
    mode: options.mode || configuredRunnerProjectionMode({ siteAgentId: options.siteAgentId }),
    instances,
    bindings,
    leases,
    queueHealth,
    scope: options.siteAgentId ? { kind: "site", siteAgentId: options.siteAgentId } : undefined,
    platformPoolState: options.siteAgentId
      ? { instances: loadedInstances, leases: loadedLeases, queueHealth: platformQueueHealth }
      : undefined,
  });
}

export async function listRunnerControlTasks(filters: {
  runnerId?: string;
  siteAgentId?: string;
  workKind?: RunnerWorkKind;
  status?: RunnerTaskStatus;
  activeOnly?: boolean;
  limit?: number;
  page?: number;
  pageSize?: number;
} = {}) {
  const database = await runnerDatabase();
  await expireRunnerLeases();
  const page = clampInteger(filters.page, 1, 1, 10_000);
  const pageSize = clampInteger(filters.pageSize ?? filters.limit, 100, 1, 500);
  const [storedLeases, queued, browserRuns] = await Promise.all([
    listStoredLeases(database),
    listQueuedRunnerTasks(database),
    listRunnerTaskBrowserRuns(database),
  ]);
  const leases = storedLeases.map(({ lease }) => lease);
  const activeWorkKeys = new Set(leases
    .filter((lease) => ACTIVE_LEASE_STATUSES.includes(lease.status as (typeof ACTIVE_LEASE_STATUSES)[number]))
    .map((lease) => activeWorkKey(lease.workload.kind, lease.workload.id)));
  const eligibleQueued = queued.filter((task) =>
    !activeWorkKeys.has(activeWorkKey(task.workload.kind, task.workload.id)));
  const tasks = projectRunnerControlTasks({ leases, queued: eligibleQueued, browserRuns });
  const filtered = tasks
    .filter((task) => !filters.runnerId
      || task.runnerId === filters.runnerId
      || task.attempts.some((attempt) => attempt.runnerId === filters.runnerId))
    .filter((task) => !filters.siteAgentId || task.siteAgentId === filters.siteAgentId)
    .filter((task) => !filters.workKind || task.workKind === filters.workKind)
    .filter((task) => !filters.status || task.status === filters.status)
    .filter((task) => !filters.activeOnly || task.status === "active" || task.status === "completing")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt));
  const offset = (page - 1) * pageSize;
  return {
    tasks: filtered.slice(offset, offset + pageSize),
    total: filtered.length,
    page,
    pageSize,
    persistence: database ? "d1" as const : "memory" as const,
  };
}

export function resetMemoryRunnerControlStore() {
  const root = globalThis as RunnerControlMemoryRoot;
  delete root.__SITEWAKE_RUNNER_CONTROL__;
}

/**
 * On site deletion: the site's runner leases and placement bindings. Runner instances
 * and pools are org-level resources and stay. The lease table stores the workload as a
 * JSON column; the site id is in `workload.siteAgentId`.
 */
export function runnerControlDeletionStatements(database: D1DatabaseLike, siteAgentId: string): D1PreparedStatementLike[] {
  return [
    database.prepare(`DELETE FROM site_agent_v2_runner_leases WHERE site_agent_id=?`).bind(siteAgentId),
    database.prepare(`DELETE FROM site_agent_v2_runner_placement_bindings WHERE site_agent_id=?`).bind(siteAgentId),
  ];
}

export function deleteMemoryRunnerControlData(siteAgentId: string) {
  const control = memoryRunnerControl();
  for (const [key, binding] of control.bindings) if (binding.siteAgentId === siteAgentId) control.bindings.delete(key);
  for (const [key, stored] of control.leases) if (stored.lease.workload.siteAgentId === siteAgentId) control.leases.delete(key);
}
