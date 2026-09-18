import { getD1Binding, type D1DatabaseLike, type D1PreparedStatementLike } from "./index";
import { ensureSiteAgentV3Schema } from "./site-agent-schema";
import { effectActorKey, persistEffectRun } from "./effect-store";
import { createTaskSession, getSiteAgentOverview, getTaskEpisodeById, siteAgentExists } from "./site-agent-store";
import { getPageAgentObservations } from "./page-observation-store";
import { getCapability } from "./capability-center-v2-store";
import {
  normalizeGoal,
  uid,
  type AgentRun,
  type AgentRunActivity,
  type AgentRunCheckpoint,
  type AgentRunEvent,
  type AgentRunStatus,
  type AgentRunToolCall,
  type BrowserPortLease,
  type ExecutionReceipt,
  type JsonValue,
  type ModelInvocationStage,
  type OutcomeReceipt,
  type PageAgentObservation,
  type PageObservationRef,
  type TaskEpisode,
  type TaskSession,
} from "../lib/site-knowledge/protocol";
import type { CapabilityExperience } from "../lib/capability-center-v2/model";
import { capabilityExperienceAuthority, legacyCapabilityExperienceAuthority } from "../lib/capability-center-v2/experience-authority";
import { siteAgentRuntimeFeatures } from "../lib/site-knowledge/runtime-features";
import { redactSensitiveJson, redactSensitiveText, sanitizeAgentRunCheckpoint } from "../lib/site-knowledge/sensitive-data";
import {
  capabilityIdFromRun,
  makeDebugEvent,
  usageTraceId,
  versionIdFromRun,
  type CapabilityDebugEvent,
} from "../lib/capability-center-v2/debug-trace";

type StoredRun = { run: AgentRun; resumeTokenHash: string; handoffTokenHash?: string; handoffExpiresAt?: string };
type MemoryRoot = typeof globalThis & { __SITEWAKE_AGENT_RUN_V3__?: Map<string, StoredRun>; __SITEWAKE_AGENT_RUN_EVENTS_V3__?: Map<string, AgentRunEvent[]> };
type RunRow = { runJson: string; resumeTokenHash: string; handoffTokenHash?: string; handoffExpiresAt?: string };

// A destination page may need to load the storefront bundle and restore the
// persisted checkpoint before it can claim a navigation handoff. Ten seconds
// was too short for a real model turn plus a local page reload (the browser
// could visibly complete the action while the AgentRun stayed awaiting-page).
// Keep the normal port lease at 10s, but give the one-shot handoff token a
// bounded 60s window. The token remains single-use and is revoked on claim or
// terminal completion.
const AGENT_RUN_HANDOFF_WINDOW_MS = 60_000;

function canonicalJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalJson(item)]));
}

function sameJson(left: Record<string, JsonValue>, right: Record<string, JsonValue>) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function memoryRuns() {
  const root = globalThis as MemoryRoot;
  root.__SITEWAKE_AGENT_RUN_V3__ ||= new Map();
  return root.__SITEWAKE_AGENT_RUN_V3__;
}

function memoryEvents() {
  const root = globalThis as MemoryRoot;
  root.__SITEWAKE_AGENT_RUN_EVENTS_V3__ ||= new Map();
  return root.__SITEWAKE_AGENT_RUN_EVENTS_V3__;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unpackToken(runId: string, packed: string) {
  const [tokenRunId, token] = packed.split(".", 2);
  if (!token || tokenRunId !== runId) throw new Error("agent_run_token_invalid");
  return token;
}

function originOf(value: string) {
  try { return new URL(value).origin; }
  catch { throw new Error("agent_run_origin_invalid"); }
}

export function siteExecutionOrigins(input: {
  allowedOrigins?: string[];
  reportedOrigin: string;
  requestOrigin?: string;
  controlPlaneOrigin?: string;
  allowOriginless?: boolean;
}) {
  const configured = (input.allowedOrigins || []).flatMap((value) => {
    try { return [new URL(value).origin]; }
    catch { return []; }
  });
  const reported = originOf(input.reportedOrigin);
  const browser = input.requestOrigin ? originOf(input.requestOrigin) : undefined;
  if ((!browser && !input.allowOriginless) || (browser && browser !== reported)) {
    throw new Error("agent_run_origin_rejected");
  }
  const requested = browser || reported;
  const controlPlane = input.controlPlaneOrigin ? originOf(input.controlPlaneOrigin) : undefined;
  // A page hosted by this deployment is intrinsically same-Origin with its
  // control plane. External websites must be explicitly enrolled by an
  // administrator; observed connections and AI-authored profile fields are
  // intentionally absent from this decision.
  if (requested !== controlPlane && !configured.includes(requested)) {
    throw new Error("agent_run_origin_rejected");
  }
  // A Run receives the least authority it needs. Scene navigation is rebased
  // to the live page Origin, so unrelated configured aliases are not handoff
  // destinations for this Run.
  return [requested];
}

function changes(result: { meta?: Record<string, unknown> }) {
  return Number(result.meta?.changes || 0);
}

function eventPayload(payload: Record<string, JsonValue>) {
  return payload;
}

function debugRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function runtimeCheckpoint(checkpoint: AgentRunCheckpoint | undefined) {
  const adaptive = debugRecord(checkpoint?.adaptiveState);
  const runtime = debugRecord(adaptive.v2Runtime);
  const receipts = Array.isArray(adaptive.v2StageReceipts) ? adaptive.v2StageReceipts.map(debugRecord) : [];
  return { adaptive, runtime, receipts };
}

function runtimeFailureModule(outcome: OutcomeReceipt | undefined) {
  const evidence = debugRecord(outcome?.evidence);
  const error = `${outcome?.code || ""} ${evidence.technicalError || ""}`.toLocaleLowerCase();
  if (error.includes("module_unavailable") || error.includes("http_")) return "runtime.fetch";
  if (error.includes("integrity") || error.includes("manifest") || error.includes("import")) return "runtime.integrity";
  if (error.includes("input") || error.includes("schema")) return "runtime.input";
  if (error.includes("precondition") || error.includes("navigation_origin")) return "runtime.preconditions";
  if (error.includes("output") || error.includes("success_") || error.includes("unverified")) return "runtime.output";
  return "runtime.stage";
}

function checkpointDebugEvents(current: AgentRun, checkpoint: AgentRunCheckpoint) {
  const next = runtimeCheckpoint(checkpoint);
  if (!Object.keys(next.runtime).length) return [];
  const previous = runtimeCheckpoint(current.checkpoint);
  const capabilityId = typeof next.runtime.capabilityId === "string" ? next.runtime.capabilityId : checkpoint.capabilityId;
  if (!capabilityId) return [];
  const versionId = typeof next.runtime.versionId === "string" ? next.runtime.versionId : undefined;
  const traceId = usageTraceId(current, capabilityId);
  const base = { traceId, traceKind: "usage" as const, siteId: current.scope.siteAgentId, correlation: { agentRunId: current.id, capabilityId, versionId, pageEpoch: current.pageEpoch } };
  const events: CapabilityDebugEvent[] = [];
  if (!Object.keys(previous.runtime).length) {
    events.push(makeDebugEvent({
      ...base,
      moduleId: "request.receive",
      lifecycle: "completed",
      occurredAt: current.createdAt,
      input: { goal: current.goal, input: current.input, conversation: current.conversation.map((turn) => ({ role: turn.role, at: turn.at })) },
      output: { agentRunId: current.id, accepted: true },
    }));
    const searchActivities = (checkpoint.activityTimeline || current.activityTimeline || []).filter((activity) => activity.kind === "capability-search");
    events.push(makeDebugEvent({
      ...base,
      moduleId: "capability.search",
      lifecycle: "completed",
      occurredAt: searchActivities[0]?.createdAt || checkpoint.savedAt,
      input: { queries: [current.goal], limit: 30 },
      output: { capabilityId, versionId, candidates: searchActivities.map((activity) => activity.output || {}) },
    }));
    events.push(makeDebugEvent({ ...base, moduleId: "runtime.fetch", lifecycle: "completed", input: { capabilityId }, output: { capabilityId, versionId, contract: next.runtime.contract, program: next.runtime.program } }));
    events.push(makeDebugEvent({ ...base, moduleId: "runtime.input", lifecycle: "completed", input: { schema: debugRecord(next.runtime.contract).inputSchema, value: checkpoint.input }, output: { valid: true, missing: [] } }));
  }
  if (next.receipts.length && !previous.receipts.length) {
    const program = debugRecord(next.runtime.program);
    const moduleRef = debugRecord(program.module);
    events.push(makeDebugEvent({ ...base, moduleId: "runtime.integrity", lifecycle: "completed", input: { moduleUrl: moduleRef.moduleUrl, expectedHash: moduleRef.contentHash, manifest: program.stages }, output: { actualHash: moduleRef.contentHash, valid: true } }));
    events.push(makeDebugEvent({ ...base, moduleId: "runtime.preconditions", lifecycle: "completed", input: { entry: program.entry, conditions: debugRecord(next.runtime.contract).preconditions }, output: { valid: true, pageEpoch: current.pageEpoch } }));
  }
  const priorKeys = new Set(previous.receipts.map((receipt) => JSON.stringify([receipt.stageId, receipt.stageIndex, receipt.status, receipt.urlBefore, receipt.urlAfter, receipt.outcome])));
  for (const receipt of next.receipts) {
    const key = JSON.stringify([receipt.stageId, receipt.stageIndex, receipt.status, receipt.urlBefore, receipt.urlAfter, receipt.outcome]);
    if (priorKeys.has(key)) continue;
    const stageId = typeof receipt.stageId === "string" ? receipt.stageId : `stage-${String(receipt.stageIndex ?? events.length)}`;
    events.push(makeDebugEvent({
      ...base,
      moduleId: "runtime.stage",
      lifecycle: receipt.status === "Completed" ? "completed" : "started",
      occurredAt: typeof receipt.completedAt === "string" ? receipt.completedAt : checkpoint.savedAt,
      correlation: { ...base.correlation, stageId },
      input: { stage: { id: stageId, index: receipt.stageIndex }, input: checkpoint.input, state: checkpoint.output, urlBefore: receipt.urlBefore },
      output: receipt.status === "Completed" ? { outcome: receipt.outcome, output: checkpoint.output, evidence: receipt.evidence, urlAfter: receipt.urlAfter } : undefined,
      evidence: { replayRunId: current.id, urlBefore: typeof receipt.urlBefore === "string" ? receipt.urlBefore : undefined, urlAfter: typeof receipt.urlAfter === "string" ? receipt.urlAfter : undefined },
    }));
  }
  return events;
}

function finishDebugEvents(current: AgentRun, input: { status: "completed" | "failed" | "cancelled"; output?: Record<string, JsonValue>; outcome?: OutcomeReceipt }) {
  const projected = { ...current, status: input.status, output: input.output, outcome: input.outcome } satisfies AgentRun;
  const capabilityId = capabilityIdFromRun(projected);
  if (!capabilityId) return [];
  const versionId = versionIdFromRun(projected);
  const traceId = usageTraceId(projected, capabilityId);
  const base = { traceId, traceKind: "usage" as const, siteId: current.scope.siteAgentId, correlation: { agentRunId: current.id, capabilityId, versionId, pageEpoch: current.pageEpoch } };
  const events: CapabilityDebugEvent[] = [];
  const handled = input.outcome && ["no-result", "business-rejection"].includes(input.outcome.status);
  if (input.outcome) events.push(makeDebugEvent({
    ...base,
    moduleId: "runtime.output",
    lifecycle: input.status === "failed" && runtimeFailureModule(input.outcome) === "runtime.output" ? "failed" : handled ? "handled" : "completed",
    input: { output: input.output, conditions: debugRecord(runtimeCheckpoint(current.checkpoint).runtime.contract).successConditions },
    output: { valid: input.status !== "failed", outcome: input.outcome.status },
    error: input.status === "failed" && runtimeFailureModule(input.outcome) === "runtime.output" ? { code: input.outcome.code, message: input.outcome.summary, retryable: false } : undefined,
  }));
  if (input.status === "failed" && runtimeFailureModule(input.outcome) !== "runtime.output") {
    const evidence = debugRecord(input.outcome?.evidence);
    events.push(makeDebugEvent({
      ...base,
      moduleId: runtimeFailureModule(input.outcome),
      lifecycle: "failed",
      correlation: { ...base.correlation, stageId: typeof evidence.stepId === "string" ? evidence.stepId : undefined },
      input: { input: current.input, checkpoint: current.checkpoint ? { mode: current.checkpoint.mode, phase: current.checkpoint.phase, cursor: current.checkpoint.cursor } : undefined },
      output: { output: input.output, evidence: input.outcome?.evidence },
      error: { code: input.outcome?.code || "capability_runtime_failed", message: input.outcome?.summary || "能力运行失败", retryable: false, sideEffectStarted: evidence.sideEffectStarted === true },
    }));
  }
  events.push(makeDebugEvent({
    ...base,
    moduleId: "run.finish",
    lifecycle: "completed",
    input: { outcome: input.outcome, output: input.output },
    output: { status: input.status, persisted: true },
  }));
  return events;
}

function terminalRunStatus(status: AgentRunStatus) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export type AgentRunFollowupIntent = "reconciliation" | "confirmed-continuation";

type CreateAgentRunFollowup = {
  sourceTaskId: string;
  intent: AgentRunFollowupIntent;
  sourceToken: string;
};

type AgentRunFollowupLineage = {
  sourceRunId: string;
  rootRunId: string;
  executionIntent: AgentRunFollowupIntent;
  lineageDepth: 1 | 2;
};

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function trustedReconciliationMarker(run: AgentRun) {
  const marker = jsonRecord(run.agentState.reconciliationEpisodeAuthority);
  return marker
    && marker.status === "not-completed"
    && typeof marker.episodeId === "string"
    && typeof marker.acceptedAt === "string"
    ? marker
    : undefined;
}

function explicitPageExecutionUncertainty(run: AgentRun) {
  const outcome = run.outcome;
  if (!outcome) return false;
  const code = outcome.code.toLowerCase().replaceAll("-", "_");
  return outcome.status === "unknown"
    || [
      "adaptive_timeout",
      "page_agent_budget_exhausted",
      "agent_incomplete",
      "side_effect_unknown",
      "action_effect_unknown",
      "cancelled",
    ].includes(code)
    || code.includes("timeout")
    || code.includes("budget_exhausted")
    || code.includes("no_progress")
    || code.includes("side_effect_unknown");
}

function followupLineageFor(source: AgentRun, intent: AgentRunFollowupIntent): AgentRunFollowupLineage {
  if (!terminalRunStatus(source.status)) throw new Error(`agent_run_followup_source_not_terminal:${source.status}`);
  const state = source.agentState;
  const depth = Number(state.lineageDepth || 0);
  if (intent === "reconciliation") {
    if (depth !== 0 || state.executionIntent || state.sourceRunId || state.rootRunId) {
      throw new Error("agent_run_followup_lineage_rejected");
    }
    if (!explicitPageExecutionUncertainty(source)) {
      throw new Error("agent_run_followup_source_not_uncertain");
    }
    return { sourceRunId: source.id, rootRunId: source.id, executionIntent: intent, lineageDepth: 1 };
  }

  if (depth !== 1
    || state.executionIntent !== "reconciliation"
    || typeof state.sourceRunId !== "string"
    || typeof state.rootRunId !== "string"
    || !trustedReconciliationMarker(source)) {
    throw new Error("agent_run_followup_confirmation_rejected");
  }
  return {
    sourceRunId: source.id,
    rootRunId: state.rootRunId,
    executionIntent: intent,
    lineageDepth: 2,
  };
}

async function readStored(database: D1DatabaseLike | null, runId: string): Promise<StoredRun | undefined> {
  if (!database) return memoryRuns().get(runId);
  await ensureSiteAgentV3Schema(database);
  const result = await database.prepare(`SELECT run_json AS runJson,resume_token_hash AS resumeTokenHash,
    handoff_token_hash AS handoffTokenHash,handoff_expires_at AS handoffExpiresAt
    FROM site_agent_v3_agent_runs WHERE id=? LIMIT 1`).bind(runId).all<RunRow>();
  if (!result.success) throw new Error(result.error || "agent_run_read_failed");
  const row = result.results?.[0];
  return row ? { run: JSON.parse(row.runJson) as AgentRun, resumeTokenHash: row.resumeTokenHash, handoffTokenHash: row.handoffTokenHash || undefined, handoffExpiresAt: row.handoffExpiresAt || undefined } : undefined;
}

async function authorize(stored: StoredRun, runId: string, packedToken: string, allowHandoff = false) {
  const tokenHash = await sha256Hex(unpackToken(runId, packedToken));
  if (tokenHash === stored.resumeTokenHash) return "resume" as const;
  if (allowHandoff && tokenHash === stored.handoffTokenHash && stored.handoffExpiresAt && stored.handoffExpiresAt > new Date().toISOString()) return "handoff" as const;
  throw new Error("agent_run_token_rejected");
}

function eventFor(run: AgentRun, type: AgentRunEvent["type"], payload: Record<string, JsonValue>): AgentRunEvent {
  return { id: uid("run_event"), runId: run.id, sequence: run.eventSequence, type, payload, createdAt: run.updatedAt };
}

async function persistEvent(database: D1DatabaseLike | null, event: AgentRunEvent) {
  if (!database) {
    const events = memoryEvents().get(event.runId) || [];
    if (!events.some((item) => item.sequence === event.sequence)) memoryEvents().set(event.runId, [...events, event].slice(-500));
    return;
  }
  const result = await database.prepare(`INSERT OR IGNORE INTO site_agent_v3_run_events
    (id,run_id,sequence,type,event_json,created_at) VALUES (?,?,?,?,?,?)`)
    .bind(event.id, event.runId, event.sequence, event.type, JSON.stringify(event), event.createdAt).run();
  if (!result.success) throw new Error(result.error || "agent_run_event_write_failed");
}

/**
 * Compare-and-swap on `eventSequence`, not on `revision`.
 *
 * The two counters answer different questions and only one of them may be the
 * storage guard. `eventSequence` advances on every mutation without exception,
 * so it always detects a concurrent write. `revision` is the token the browser
 * echoes back as `expectedRevision`, which means it must only move when the
 * browser could have learned the new value — server-owned bookkeeping such as
 * the model budget ledger must not consume it.
 */
async function replaceStored(database: D1DatabaseLike | null, previous: StoredRun, next: StoredRun) {
  if (!database) {
    const current = memoryRuns().get(next.run.id);
    if (!current || current.run.eventSequence !== previous.run.eventSequence) throw new Error("agent_run_revision_conflict");
    memoryRuns().set(next.run.id, next);
    return;
  }
  const result = await database.prepare(`UPDATE site_agent_v3_agent_runs SET status=?,revision=?,page_epoch=?,event_sequence=?,
    resume_token_hash=?,handoff_token_hash=?,handoff_expires_at=?,run_json=?,updated_at=?,expires_at=? WHERE id=? AND event_sequence=?`)
    .bind(next.run.status, next.run.revision, next.run.pageEpoch, next.run.eventSequence, next.resumeTokenHash, next.handoffTokenHash || null,
      next.handoffExpiresAt || null, JSON.stringify(next.run), next.run.updatedAt, next.run.expiresAt, next.run.id, previous.run.eventSequence).run();
  if (!result.success) throw new Error(result.error || "agent_run_update_failed");
  if (!changes(result)) throw new Error("agent_run_revision_conflict");
}

async function mutateRun(
  runId: string,
  token: string,
  mutation: (run: AgentRun, stored: StoredRun, tokenKind: "resume" | "handoff") => { run: AgentRun; eventType: AgentRunEvent["type"]; eventPayload?: Record<string, JsonValue>; resumeTokenHash?: string; handoffTokenHash?: string; handoffExpiresAt?: string },
  options: { allowHandoff?: boolean; serverBookkeeping?: boolean } = {},
) {
  const database = getD1Binding();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stored = await readStored(database, runId);
    if (!stored) throw new Error("agent_run_not_found");
    const tokenKind = await authorize(stored, runId, token, options.allowHandoff);
    const changed = mutation(stored.run, stored, tokenKind);
    // Run status is monotonic once terminal. This is a storage invariant, not
    // merely a BrowserPort convention: delayed checkpoints, tool receipts, or
    // user-response requests from a superseded document must never resurrect
    // a completed/failed/cancelled Run.
    if (terminalRunStatus(stored.run.status) && changed.run.status !== stored.run.status) {
      throw new Error(`agent_run_already_terminal:${stored.run.status}`);
    }
    const now = new Date().toISOString();
    // A server-owned write is invisible to the browser: it never receives the
    // new run, so bumping `revision` would silently invalidate the
    // `expectedRevision` it is holding and reject its next checkpoint.
    const revision = options.serverBookkeeping ? stored.run.revision : stored.run.revision + 1;
    const run = { ...changed.run, id: runId, revision, eventSequence: stored.run.eventSequence + 1, updatedAt: now };
    const revokeHandoff = tokenKind === "handoff" || terminalRunStatus(run.status);
    const next: StoredRun = {
      run,
      resumeTokenHash: changed.resumeTokenHash || stored.resumeTokenHash,
      // The source document can still flush its final checkpoint/activity
      // after issuing a one-shot handoff. Ordinary resume-token mutations must
      // not revoke that grant before the destination document claims it.
      handoffTokenHash: revokeHandoff
        ? undefined
        : changed.handoffTokenHash ?? stored.handoffTokenHash,
      handoffExpiresAt: revokeHandoff
        ? undefined
        : changed.handoffExpiresAt ?? stored.handoffExpiresAt,
    };
    try {
      await replaceStored(database, stored, next);
      await persistEvent(database, eventFor(run, changed.eventType, changed.eventPayload || {}));
      if (terminalRunStatus(run.status)) {
        // The runtime write remains authoritative. Effect facts are a
        // rebuildable read model, so a projection failure must never turn a
        // completed user task into an HTTP failure.
        await persistEffectRun(run).catch(() => undefined);
      }
      return { run, tokenKind };
    } catch (error) {
      if (String(error).includes("revision_conflict") && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error("agent_run_revision_conflict");
}

async function discardFailedFollowupChild(runId: string, siteAgentId: string) {
  const database = getD1Binding();
  if (!database) {
    memoryRuns().delete(runId);
    memoryEvents().delete(runId);
    return;
  }
  const results = await database.batch([
    database.prepare("DELETE FROM site_agent_v3_browser_ports WHERE run_id=?").bind(runId),
    database.prepare("DELETE FROM site_agent_v3_run_events WHERE run_id=?").bind(runId),
    database.prepare("DELETE FROM site_agent_v3_agent_runs WHERE id=? AND site_agent_id=?").bind(runId, siteAgentId),
    database.prepare("DELETE FROM site_agent_v2_sessions WHERE id=? AND site_agent_id=?").bind(runId, siteAgentId),
  ]);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "agent_run_followup_child_cleanup_failed");
}

async function releaseFailedFollowupClaim(
  followup: CreateAgentRunFollowup,
  childRunId: string,
) {
  const current = await getAgentRun(followup.sourceTaskId, followup.sourceToken);
  const currentClaims = current.run
    ? jsonRecord(current.run.agentState.pageExecutionFollowupClaims)
    : undefined;
  if (jsonRecord(currentClaims?.[followup.intent])?.childRunId !== childRunId) return;
  await mutateRun(followup.sourceTaskId, followup.sourceToken, (source) => {
    const claims = { ...(jsonRecord(source.agentState.pageExecutionFollowupClaims) || {}) };
    const claim = jsonRecord(claims[followup.intent]);
    if (claim?.childRunId !== childRunId) throw new Error("agent_run_followup_compensation_conflict");
    delete claims[followup.intent];
    return {
      run: {
        ...source,
        agentState: { ...source.agentState, pageExecutionFollowupClaims: claims },
      },
      eventType: "status",
      eventPayload: { followupIntent: followup.intent, childRunId, compensated: true },
    };
  });
}

export async function createAgentRun(input: {
  siteAgentId: string;
  origin: string;
  url: string;
  goal: string;
  taskInput: Record<string, JsonValue>;
  conversation?: AgentRun["conversation"];
  documentId?: string;
  browserSessionId?: string;
  controller?: "page-agent" | "script";
  requestOrigin?: string;
  controlPlaneOrigin?: string;
  followup?: CreateAgentRunFollowup;
}) {
  const safeGoal = redactSensitiveText(input.goal);
  const safeTaskInput = redactSensitiveJson(input.taskInput) as Record<string, JsonValue>;
  if (!(await siteAgentExists(input.siteAgentId))) throw new Error("site_agent_not_found");
  const overview = await getSiteAgentOverview(input.siteAgentId);
  const origin = originOf(input.origin);
  if (originOf(input.url) !== origin) throw new Error("agent_run_origin_rejected");
  const allowedOrigins = siteExecutionOrigins({
    allowedOrigins: overview.overview.activeRelease.profile.allowedOrigins,
    reportedOrigin: origin,
    requestOrigin: input.requestOrigin,
    controlPlaneOrigin: input.controlPlaneOrigin,
    allowOriginless: input.controller === "script",
  });
  const now = new Date();
  const id = uid("run");
  const rawToken = crypto.randomUUID().replaceAll("-", "");
  const packedToken = `${id}.${rawToken}`;
  const controller = input.controller || "page-agent";
  if (controller === "page-agent" && (!input.documentId || !input.browserSessionId)) throw new Error("agent_run_browser_fields_required");
  const createClaimedRun = async () => {
  let followupLineage: AgentRunFollowupLineage | undefined;
  if (input.followup) {
    const sourceTaskId = input.followup.sourceTaskId.trim();
    if (!sourceTaskId || !input.followup.sourceToken) throw new Error("agent_run_followup_fields_required");
    const claimedAt = now.toISOString();
    const claimed = await mutateRun(sourceTaskId, input.followup.sourceToken, (source) => {
      if (Date.parse(source.expiresAt) <= now.getTime()) throw new Error("agent_run_token_expired");
      if (source.controller !== "page-agent"
        || source.scope.kind !== "site"
        || source.scope.siteAgentId !== input.siteAgentId) {
        throw new Error("agent_run_followup_source_rejected");
      }
      const sourcePort = source.activePort;
      if (!source.scope.allowedOrigins.includes(origin)
        || !sourcePort
        || sourcePort.documentId !== input.documentId
        || sourcePort.browserSessionId !== input.browserSessionId) {
        throw new Error("agent_run_followup_context_rejected");
      }
      if (normalizeGoal(source.goal) !== normalizeGoal(safeGoal) || !sameJson(source.input, safeTaskInput)) {
        throw new Error("agent_run_followup_task_rejected");
      }
      followupLineageFor(source, input.followup!.intent);
      const claims = { ...(jsonRecord(source.agentState.pageExecutionFollowupClaims) || {}) };
      if (claims[input.followup!.intent]) throw new Error("agent_run_followup_already_claimed");
      claims[input.followup!.intent] = {
        childRunId: id,
        claimedAt,
      };
      return {
        run: {
          ...source,
          agentState: { ...source.agentState, pageExecutionFollowupClaims: claims },
        },
        eventType: "status",
        eventPayload: { followupIntent: input.followup!.intent, childRunId: id },
      };
    });
    followupLineage = followupLineageFor(claimed.run, input.followup.intent);
  }
  const port: BrowserPortLease | undefined = controller === "page-agent" ? {
    id: uid("port"), documentId: input.documentId!, browserSessionId: input.browserSessionId!, origin, url: input.url,
    pageEpoch: 1, claimedAt: now.toISOString(), lastSeenAt: now.toISOString(), leaseExpiresAt: new Date(now.getTime() + 10_000).toISOString(), state: "active",
  } : undefined;
  const conversation = (input.conversation || []).slice(-30)
    .map((turn) => ({ ...turn, content: redactSensitiveText(turn.content) }));
  if (conversation.at(-1)?.role !== "user" || conversation.at(-1)?.content !== safeGoal) conversation.push({ role: "user", content: safeGoal, at: now.toISOString() });
  const analyticsActorKey = await effectActorKey(input.siteAgentId, input.browserSessionId);
  const run: AgentRun = {
    id, revision: 1, controller, scope: { kind: "site", siteAgentId: input.siteAgentId, allowedOrigins, knowledgeNamespaceIds: [input.siteAgentId] },
    status: "running", goal: safeGoal, input: safeTaskInput, conversation,
    agentState: {
      effectActorKey: analyticsActorKey,
      effectReleaseId: overview.overview.activeRelease.id,
      effectReleaseVersion: overview.overview.activeRelease.version,
      effectStartUrl: input.url,
      ...(followupLineage || {}),
    },
    activityTimeline: [], bindings: {}, activePort: port,
    pageEpoch: port ? 1 : 0, eventSequence: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
  };
  const stored: StoredRun = { run, resumeTokenHash: await sha256Hex(rawToken) };
  const database = getD1Binding();
  if (!database) memoryRuns().set(id, stored);
  else {
    await ensureSiteAgentV3Schema(database);
    const result = await database.prepare(`INSERT INTO site_agent_v3_agent_runs
      (id,site_agent_id,origin,status,revision,page_epoch,event_sequence,resume_token_hash,handoff_token_hash,handoff_expires_at,run_json,created_at,updated_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, input.siteAgentId, origin, run.status, run.revision, run.pageEpoch, run.eventSequence, stored.resumeTokenHash, null, null, JSON.stringify(run), run.createdAt, run.updatedAt, run.expiresAt).run();
    if (!result.success) throw new Error(result.error || "agent_run_create_failed");
    if (port) {
      const portResult = await database.prepare(`INSERT INTO site_agent_v3_browser_ports (id,run_id,page_epoch,state,port_json,claimed_at,last_seen_at,lease_expires_at) VALUES (?,?,?,?,?,?,?,?)`)
        .bind(port.id, id, port.pageEpoch, port.state, JSON.stringify(port), port.claimedAt, port.lastSeenAt, port.leaseExpiresAt).run();
      if (!portResult.success) throw new Error(portResult.error || "agent_run_port_create_failed");
    }
  }
  await persistEvent(database, eventFor(run, "run-created", {
    goal: safeGoal,
    origin,
    ...(followupLineage ? {
      sourceRunId: followupLineage.sourceRunId,
      rootRunId: followupLineage.rootRunId,
      executionIntent: followupLineage.executionIntent,
      lineageDepth: followupLineage.lineageDepth,
    } : {}),
  }));
  // TaskEpisode compilation still consumes the v2 evidence projection. It is
  // deliberately a shadow record: AgentRun is the only runtime authority.
  const evidenceSession: TaskSession = {
    id, siteAgentId: input.siteAgentId, browserSessionId: input.browserSessionId || "script-host", goal: safeGoal, input: safeTaskInput,
    conversation: conversation.filter((turn) => turn.role !== "tool").map((turn) => ({ role: turn.role as "user" | "assistant" | "system", content: turn.content, at: turn.at })),
    nextStepIndex: 0, bindings: {}, status: "running", createdAt: run.createdAt, updatedAt: run.updatedAt, expiresAt: run.expiresAt,
  };
  await createTaskSession(evidenceSession);
  // Sweep this site's abandoned Runs while we are already here. Creating a Run
  // is the most frequent per-site write, so it keeps leaked records from
  // accumulating without adding a scheduler. Fire-and-forget: a failed sweep
  // must never block the user's task from starting.
  void sweepExpiredRunsForSite(database, input.siteAgentId).catch(() => undefined);
  return { run, resumeToken: packedToken, persistence: database ? "d1" as const : "memory" as const };
  };
  try {
    return await createClaimedRun();
  } catch (error) {
    if (input.followup) {
      try {
        // Delete only the newly generated child. Release the source claim only
        // after cleanup succeeds; an ambiguous cleanup remains consumed and
        // therefore fails closed instead of permitting a duplicate child.
        await discardFailedFollowupChild(id, input.siteAgentId);
        await releaseFailedFollowupClaim(input.followup, id);
      } catch { /* Preserve the original failure; any uncertain claim stays closed. */ }
    }
    throw error;
  }
}

export async function claimAgentRun(runId: string, input: { token: string; origin: string; url: string; documentId: string; browserSessionId: string; checkpoint?: AgentRunCheckpoint }) {
  const origin = originOf(input.origin);
  if (originOf(input.url) !== origin) throw new Error("agent_run_origin_rejected");
  if (!input.documentId || input.documentId.length > 200
    || !input.browserSessionId || input.browserSessionId.length > 200) {
    throw new Error("agent_run_browser_fields_required");
  }
  let previousPortId: string | undefined;
  const freshResumeRaw = crypto.randomUUID().replaceAll("-", "");
  const freshResumeToken = `${runId}.${freshResumeRaw}`;
  const freshResumeTokenHash = await sha256Hex(freshResumeRaw);
  const safeCheckpoint = input.checkpoint ? sanitizeAgentRunCheckpoint(input.checkpoint) : undefined;
  const result = await mutateRun(runId, input.token, (current, _stored, tokenKind) => {
    if (!current.scope.allowedOrigins.includes(origin)) throw new Error("agent_run_origin_rejected");
    if (!["running", "awaiting-page", "awaiting-user"].includes(current.status)) throw new Error(`agent_run_not_claimable:${current.status}`);
    const now = new Date();
    if (current.controller === "page-agent" && tokenKind !== "handoff") {
      throw new Error("agent_run_handoff_token_required");
    }
    if (current.controller === "script" && tokenKind !== "handoff" && current.activePort) {
      throw new Error("agent_run_handoff_token_required");
    }
    if (tokenKind === "handoff") {
      if (current.status !== "awaiting-page") {
        throw new Error("agent_run_handoff_not_pending");
      }
      if (current.activePort?.browserSessionId !== input.browserSessionId) {
        throw new Error("agent_run_browser_session_rejected");
      }
      if (now.getTime() - Date.parse(current.updatedAt) > AGENT_RUN_HANDOFF_WINDOW_MS) {
        throw new Error("agent_run_handoff_expired");
      }
    }
    const pageEpoch = current.pageEpoch + 1;
    previousPortId = current.activePort?.id;
    const port: BrowserPortLease = {
      id: uid("port"), documentId: input.documentId, browserSessionId: input.browserSessionId, origin, url: input.url,
      pageEpoch, claimedAt: now.toISOString(), lastSeenAt: now.toISOString(), leaseExpiresAt: new Date(now.getTime() + 10_000).toISOString(), state: "active",
    };
    return {
      run: {
        ...current,
        status: current.status === "awaiting-page" ? "running" : current.status,
        pageEpoch,
        activePort: port,
        checkpoint: safeCheckpoint || current.checkpoint,
        activityTimeline: safeCheckpoint?.activityTimeline || current.activityTimeline || [],
        programCursor: safeCheckpoint?.cursor || current.programCursor,
        bindings: { ...current.bindings, ...(safeCheckpoint?.output || {}) },
      },
      // A script-controlled Run keeps one stable controller token for its
      // entire lifetime. The handoff token only authorizes the destination
      // page claim; it must never revoke the backend script host.
      resumeTokenHash: current.controller === "script"
        ? undefined
        : freshResumeTokenHash,
      eventType: "port-claimed",
      eventPayload: { portId: port.id, pageEpoch, url: input.url, checkpointTransferred: Boolean(input.checkpoint) },
    };
  }, { allowHandoff: true });
  const database = getD1Binding();
  const port = result.run.activePort!;
  if (database) {
    if (previousPortId) await database.prepare(`UPDATE site_agent_v3_browser_ports SET state='superseded' WHERE id=? AND run_id=?`).bind(previousPortId, runId).run();
    await database.prepare(`INSERT OR REPLACE INTO site_agent_v3_browser_ports (id,run_id,page_epoch,state,port_json,claimed_at,last_seen_at,lease_expires_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(port.id, runId, port.pageEpoch, port.state, JSON.stringify(port), port.claimedAt, port.lastSeenAt, port.leaseExpiresAt).run();
  }
  return {
    run: result.run,
    resumeToken: result.run.controller === "page-agent"
      ? freshResumeToken
      : input.token,
    persistence: database ? "d1" as const : "memory" as const,
  };
}

export async function getAgentRun(runId: string, token: string) {
  const database = getD1Binding();
  const stored = await readStored(database, runId);
  if (!stored) return { run: undefined, persistence: database ? "d1" as const : "memory" as const };
  await authorize(stored, runId, token);
  return { run: stored.run, persistence: database ? "d1" as const : "memory" as const };
}

/** Server-only loader. Public routes must keep using getAgentRun with a token. */
export async function getAgentRunInternal(runId: string) {
  const database = getD1Binding();
  const stored = await readStored(database, runId);
  return { run: stored?.run, persistence: database ? "d1" as const : "memory" as const };
}

/**
 * Authenticate a public SiteAgent request from the packed AgentRun token
 * alone. Keeping token unpacking in this store prevents public routes from
 * growing a second, subtly different authorization scheme.
 */
export async function getSiteAgentRunByToken(siteAgentId: string, token: string, requestOrigin?: string | null) {
  const runId = token.split(".", 1)[0]?.trim();
  if (!runId || !token.includes(".")) throw new Error("agent_run_token_invalid");
  const current = await getAgentRun(runId, token);
  if (!current.run) throw new Error("agent_run_not_found");
  if (current.run.scope.kind !== "site" || current.run.scope.siteAgentId !== siteAgentId) {
    throw new Error("agent_run_token_rejected");
  }
  if (Date.parse(current.run.expiresAt) <= Date.now()) throw new Error("agent_run_token_expired");
  if (requestOrigin && !current.run.scope.allowedOrigins.includes(originOf(requestOrigin))) {
    throw new Error("agent_run_origin_rejected");
  }
  return current;
}

// One AgentRun may reserve at most 100 real provider attempts. This is the
// durable, server-owned total cap shared by router, PageAgent, and follow-up
// stages; callers cannot raise it through their request payload.
export const AGENT_RUN_RUNTIME_MODEL_REQUEST_LIMIT = 100;

export type AgentRunRuntimeModelBudgetLedger = {
  requestCount: number;
  firstRequestedAt?: string;
  lastRequestedAt?: string;
  stageCounts: Partial<Record<ModelInvocationStage, number>>;
  stageFirstRequestedAt: Partial<Record<ModelInvocationStage, string>>;
  stageLastRequestedAt: Partial<Record<ModelInvocationStage, string>>;
};

/**
 * Read the server-owned model-attempt ledger from an AgentRun. Invalid legacy
 * or client-supplied state is projected as an empty ledger; callers never need
 * to trust the raw JSON shape.
 */
export function readAgentRunRuntimeModelBudget(run: Pick<AgentRun, "agentState">): AgentRunRuntimeModelBudgetLedger {
  const raw = run.agentState.runtimeModelBudget;
  const value = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, JsonValue>
    : {};
  const rawStages = value.stageCounts && typeof value.stageCounts === "object" && !Array.isArray(value.stageCounts)
    ? value.stageCounts as Record<string, JsonValue>
    : {};
  const rawStageFirst = value.stageFirstRequestedAt && typeof value.stageFirstRequestedAt === "object" && !Array.isArray(value.stageFirstRequestedAt)
    ? value.stageFirstRequestedAt as Record<string, JsonValue>
    : {};
  const rawStageLast = value.stageLastRequestedAt && typeof value.stageLastRequestedAt === "object" && !Array.isArray(value.stageLastRequestedAt)
    ? value.stageLastRequestedAt as Record<string, JsonValue>
    : {};
  const count = (candidate: JsonValue | undefined) => Number.isSafeInteger(candidate) && Number(candidate) >= 0
    ? Number(candidate)
    : 0;
  return {
    requestCount: count(value.requestCount),
    ...(typeof value.firstRequestedAt === "string" ? { firstRequestedAt: value.firstRequestedAt } : {}),
    ...(typeof value.lastRequestedAt === "string" ? { lastRequestedAt: value.lastRequestedAt } : {}),
    stageCounts: Object.fromEntries(Object.entries(rawStages)
      .map(([stage, value]) => [stage, count(value)])) as Partial<Record<ModelInvocationStage, number>>,
    stageFirstRequestedAt: Object.fromEntries(Object.entries(rawStageFirst)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && Number.isFinite(Date.parse(entry[1])))) as Partial<Record<ModelInvocationStage, string>>,
    stageLastRequestedAt: Object.fromEntries(Object.entries(rawStageLast)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && Number.isFinite(Date.parse(entry[1])))) as Partial<Record<ModelInvocationStage, string>>,
  };
}

/**
 * Atomically reserve one real provider HTTP attempt. The durable CAS happens
 * before the caller may contact the provider; any authorization, terminal,
 * limit, or persistence failure therefore fails closed.
 */
export async function consumeAgentRunRuntimeModelRequest(runId: string, input: {
  token: string;
  stage: ModelInvocationStage;
}) {
  const result = await mutateRun(runId, input.token, (run) => {
    if (terminalRunStatus(run.status)) throw new Error(`agent_run_model_budget_terminal:${run.status}`);
    const current = readAgentRunRuntimeModelBudget(run);
    if (current.requestCount >= AGENT_RUN_RUNTIME_MODEL_REQUEST_LIMIT) {
      throw new Error("agent_run_model_budget_exhausted");
    }
    const requestedAt = new Date().toISOString();
    const ledger: AgentRunRuntimeModelBudgetLedger = {
      requestCount: current.requestCount + 1,
      firstRequestedAt: current.firstRequestedAt || requestedAt,
      lastRequestedAt: requestedAt,
      stageCounts: {
        ...current.stageCounts,
        [input.stage]: (current.stageCounts[input.stage] || 0) + 1,
      },
      stageFirstRequestedAt: {
        ...current.stageFirstRequestedAt,
        [input.stage]: current.stageFirstRequestedAt[input.stage] || requestedAt,
      },
      stageLastRequestedAt: {
        ...current.stageLastRequestedAt,
        [input.stage]: requestedAt,
      },
    };
    return {
      run: {
        ...run,
        agentState: {
          ...run.agentState,
          runtimeModelBudget: ledger as unknown as JsonValue,
        },
      },
      eventType: "status",
      eventPayload: {
        runtimeModelStage: input.stage,
        runtimeModelRequestCount: ledger.requestCount,
        runtimeModelRequestLimit: AGENT_RUN_RUNTIME_MODEL_REQUEST_LIMIT,
      },
    };
  // The browser never sees this write — the model endpoint answers with the
  // provider's payload, not the run — so it must not spend the run's
  // `revision`. Without this the first model request invalidates the
  // `expectedRevision` the SDK is holding and every later checkpoint is
  // rejected, which in turn leaves a cross-document handoff unable to reclaim
  // the run at all.
  }, { serverBookkeeping: true });
  return { run: result.run, ledger: readAgentRunRuntimeModelBudget(result.run) };
}

type CompiledExecutionGrant = {
  id: string;
  capabilityId: string;
  versionId: string;
  status: "issued" | "succeeded" | "failed";
  issuedAt: string;
  terminalEpisodeId?: string;
};

function compiledExecutionGrant(run: AgentRun): CompiledExecutionGrant | undefined {
  const value = run.agentState.compiledExecutionGrant;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const grant = value as Record<string, JsonValue>;
  if (typeof grant.id !== "string" || typeof grant.capabilityId !== "string"
    || typeof grant.versionId !== "string"
    || !["issued", "succeeded", "failed"].includes(String(grant.status || ""))
    || typeof grant.issuedAt !== "string") return undefined;
  return grant as unknown as CompiledExecutionGrant;
}

/** Pin the exact published capability before browser code receives it. The
 * subsequent drift Episode may consume this grant once; an Episode cannot
 * establish its own repair source. */
export async function grantCompiledCapabilityExecution(runId: string, input: {
  token: string;
  capabilityId: string;
  versionId: string;
}) {
  const source = await getCapability((await getAgentRun(runId, input.token)).run?.scope.kind === "site"
    ? (await getAgentRun(runId, input.token)).run!.scope.siteAgentId
    : "", input.capabilityId);
  const result = await mutateRun(runId, input.token, (run) => {
    if (run.controller !== "page-agent" || run.scope.kind !== "site" || run.status !== "running") {
      throw new Error("compiled_execution_grant_run_rejected");
    }
    if (!source || source.status !== "Active" || source.currentVersionId !== input.versionId) {
      throw new Error("compiled_execution_grant_capability_rejected");
    }
    const existing = compiledExecutionGrant(run);
    if (existing?.status === "issued") {
      if (existing.capabilityId !== input.capabilityId || existing.versionId !== input.versionId) {
        throw new Error("compiled_execution_grant_in_progress");
      }
      return { run, eventType: "status", eventPayload: eventPayload({ compiledExecutionGrantId: existing.id, idempotent: true }) };
    }
    const grant: CompiledExecutionGrant = {
      id: uid("compiled_grant"),
      capabilityId: input.capabilityId,
      versionId: input.versionId,
      status: "issued",
      issuedAt: new Date().toISOString(),
    };
    return {
      run: { ...run, agentState: { ...run.agentState, compiledExecutionGrant: grant as unknown as JsonValue } },
      eventType: "status",
      eventPayload: eventPayload({ compiledExecutionGrantId: grant.id, capabilityId: grant.capabilityId, versionId: grant.versionId }),
    };
  });
  return { run: result.run, executionGrantId: compiledExecutionGrant(result.run)!.id };
}

function assertEpisodeMatchesAgentRun(run: AgentRun, episode: TaskEpisode) {
  if (run.controller !== "page-agent"
    || run.scope.kind !== "site"
    || run.scope.siteAgentId !== episode.siteAgentId
    || run.id !== episode.taskSessionId
    || normalizeGoal(run.goal) !== normalizeGoal(episode.goal)
    || !sameJson(run.input, episode.input)
    || run.activePort?.browserSessionId !== episode.browserSessionId) {
    throw new Error("agent_run_episode_rejected");
  }
}

const RECONCILIATION_READ_ONLY_ACTIONS = new Set(["focus", "scroll"]);

function sameObservationRef(ref: PageObservationRef, observation: PageAgentObservation) {
  return ref.id === observation.id
    && ref.pageEpoch === observation.pageEpoch
    && ref.documentId === observation.documentId
    && ref.turnIndex === observation.turnIndex
    && ref.kind === observation.kind
    && ref.sha256 === observation.sha256;
}

function reconciliationObservationCorpus(observations: PageAgentObservation[]) {
  return normalizeGoal(observations.flatMap((observation) => [
    observation.state.url,
    observation.state.title,
    observation.state.header,
    observation.state.content,
    observation.state.footer,
    ...observation.targets.flatMap((target) => [
      target.role || "",
      target.accessibleName || "",
      target.controlType || "",
      target.nearbyText || "",
    ]),
  ]).join("\n"));
}

function reconciliationEntityValues(value: JsonValue, depth = 0): string[] {
  if (depth > 2 || value === null) return [];
  if (typeof value === "string") {
    const normalized = normalizeGoal(value);
    return normalized.length >= 2 ? [normalized] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => reconciliationEntityValues(item, depth + 1));
  if (typeof value === "object") return Object.values(value).flatMap((item) => reconciliationEntityValues(item, depth + 1));
  return [];
}

function reconciliationObservationSegments(observation: PageAgentObservation) {
  const fields = [
    observation.state.title,
    observation.state.header,
    observation.state.content,
    observation.state.footer,
    ...observation.targets.flatMap((target) => [target.accessibleName || "", target.nearbyText || ""]),
  ];
  return fields.flatMap((field) => String(field).split(/[\r\n.!?;\u3002\uff01\uff1f\uff1b]+/u))
    .map((segment) => normalizeGoal(segment))
    .filter(Boolean);
}

function regexLiteral(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Code-owned add-to-cart negative predicate. Each relationship is evaluated
 * inside one sentence so unrelated negative and positive statements can never
 * be joined by a bounded wildcard.
 */
function typedReconciliationNotCompleted(run: AgentRun, observations: PageAgentObservation[]) {
  const goal = normalizeGoal(run.goal);
  const terminal = observations.at(-1);
  if (!terminal || !/(?:add|put).{0,40}(?:cart|basket)|(?:\u52a0\u5165|\u6dfb\u52a0).{0,20}\u8d2d\u7269\u8f66/iu.test(goal)) return false;
  const corpus = reconciliationObservationCorpus([terminal]);
  const entities = [...new Set(reconciliationEntityValues(run.input))];
  if (!entities.length || !entities.some((entity) => corpus.includes(entity))) return false;

  const segments = reconciliationObservationSegments(terminal);
  const cart = "(?:cart|basket|\\u8d2d\\u7269\\u8f66)";
  const explicitPositive = segments.some((segment) => {
    if (new RegExp(`(?:was|has\\s+been|successfully|just)\\s+added\\s+to\\s+(?:your\\s+)?${cart}`, "iu").test(segment)
      || /(?:\u5df2\u6210\u529f|\u5df2\u7ecf|\u5df2).{0,4}(?:\u52a0\u5165|\u6dfb\u52a0).{0,8}\u8d2d\u7269\u8f66/u.test(segment)) return true;
    return entities.some((entity) => {
      const escaped = regexLiteral(entity);
      return new RegExp(`${escaped}.{0,24}(?:is\\s+(?:now\\s+|already\\s+)?|now\\s+|already\\s+)(?:in|inside).{0,10}${cart}`, "iu").test(segment)
        || new RegExp(`${cart}.{0,30}(?:contains?|includes?).{0,20}${escaped}`, "iu").test(segment);
    });
  });
  if (explicitPositive) return false;

  const exactlyEmpty = segments.some((segment) => new RegExp(
    `${cart}.{0,24}(?:is\\s+)?empty\\b|${cart}.{0,24}(?:count\\s*(?:is|=|:)?\\s*)?0\\s*(?:items?|products?)\\b|0\\s*(?:items?|products?)\\b.{0,24}${cart}|\\u8d2d\\u7269\\u8f66.{0,20}(?:\\u4e3a\\u7a7a|\\u662f\\u7a7a\\u7684|0\\s*\\u4ef6)`,
    "iu",
  ).test(segment));
  if (exactlyEmpty) return true;

  return segments.some((segment) => entities.some((entity) => {
    if (!segment.includes(entity)) return false;
    const escaped = regexLiteral(entity);
    return new RegExp(`${escaped}.{0,24}(?:is\\s+)?(?:not\\s+(?:in|inside|present\\s+in)|absent\\s+from|not\\s+added\\s+to).{0,12}${cart}`, "iu").test(segment)
      || new RegExp(`${cart}.{0,24}(?:does\\s+not|doesn't|doesnt)\\s+(?:contain|include).{0,20}${escaped}`, "iu").test(segment)
      || new RegExp(`${escaped}.{0,20}(?:\\u672a\\u52a0\\u5165|\\u4e0d\\u5728|\\u4e0d\\u5305\\u542b).{0,12}\\u8d2d\\u7269\\u8f66`, "u").test(segment);
  }));
}

function assertTrustedReconciliationEpisode(
  run: AgentRun,
  episode: TaskEpisode,
  observations: PageAgentObservation[],
) {
  assertEpisodeMatchesAgentRun(run, episode);
  const evidence = jsonRecord(episode.outcome.evidence);
  const structuredOutput = jsonRecord(evidence?.structuredOutput);
  const state = run.agentState;
  if (state.executionIntent !== "reconciliation"
    || Number(state.lineageDepth) !== 1
    || typeof state.sourceRunId !== "string"
    || typeof state.rootRunId !== "string"
    || episode.mode !== "adaptive"
    || episode.capabilityId
    || episode.sourceCapabilityId
    || episode.repairKind
    || episode.outcome.status !== "no-result"
    || episode.outcome.code !== "reconciliation_not_completed"
    || evidence?.executionIntent !== "reconciliation"
    || evidence.reconciliationStatus !== "not-completed"
    || structuredOutput?.reconciliationStatus !== "not-completed"
    || episode.pageExecutionBrief?.effect !== "read"
    || episode.pageExecutionBrief.normalizedGoal !== normalizeGoal(run.goal)) {
    throw new Error("agent_run_reconciliation_episode_rejected");
  }

  const refs = episode.experience?.observationRefs || [];
  const receipts = episode.experience?.actionReceiptsV2 || [];
  const legacyActions = episode.experience?.actions || [];
  const toolReceipts = episode.experience?.toolReceipts || [];
  if (!refs.length
    || refs.length !== observations.length
    || new Set(refs.map((ref) => ref.id)).size !== refs.length
    || receipts.some((receipt) => !receipt.dispatched || !RECONCILIATION_READ_ONLY_ACTIONS.has(receipt.action))
    || legacyActions.some((action) => !["scroll"].includes(action.action))
    || toolReceipts.some((receipt) => receipt.kind === "capability" || receipt.kind === "page")) {
    throw new Error("agent_run_reconciliation_read_only_evidence_rejected");
  }

  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const ordered = refs.map((ref) => {
    const observation = byId.get(ref.id);
    if (!observation || !sameObservationRef(ref, observation)
      || observation.runId !== run.id
      || observation.siteAgentId !== episode.siteAgentId
      || observation.episodeId !== episode.id
      || observation.browserSessionId !== episode.browserSessionId
      || observation.pageEpoch !== run.pageEpoch
      || observation.documentId !== run.activePort?.documentId) {
      throw new Error("agent_run_reconciliation_observation_rejected");
    }
    return observation;
  }).sort((left, right) => left.turnIndex - right.turnIndex || left.id.localeCompare(right.id));
  if (ordered[0]?.kind !== "full" || ordered[0].baseObservationId
    || ordered.some((observation, index) => index > 0
      && (observation.kind !== "delta" || observation.baseObservationId !== ordered[index - 1]!.id))
    || ordered.some((observation) => observation.state.url !== ordered[0]!.state.url)
    || episode.startSnapshot.url !== episode.endSnapshot.url
    || episode.endSnapshot.url !== ordered.at(-1)!.state.url
    || episode.endSnapshot.documentId !== ordered.at(-1)!.documentId) {
    throw new Error("agent_run_reconciliation_navigation_evidence_rejected");
  }

  if ((!receipts.length && (ordered.length !== 1 || ordered[0].kind !== "full"))
    || (receipts.length > 0 && (receipts.length !== ordered.length - 1
      || receipts.some((receipt, index) => receipt.beforeObservationId !== ordered[index]!.id
        || receipt.afterObservationId !== ordered[index + 1]!.id
        || receipt.turnIndex !== ordered[index]!.turnIndex)))) {
    throw new Error("agent_run_reconciliation_receipt_chain_rejected");
  }

  const budget = episode.experience?.budgetEvidence;
  const ledger = readAgentRunRuntimeModelBudget(run);
  if (!typedReconciliationNotCompleted(run, ordered)
    || !budget
    || budget.activeLimitMs > 30_000
    || budget.modelRequestLimit > 2
    || budget.modelRequests !== ledger.requestCount
    || ledger.requestCount < 1
    || ledger.requestCount > 2) {
    throw new Error("agent_run_reconciliation_evidence_rejected");
  }
}

/**
 * Pin a continuation-authorizing reconciliation result only after its exact
 * Episode is durable. Browser PATCH outcome fields are deliberately ignored:
 * this server marker is the sole authority consumed by follow-up creation.
 */
export async function recordAgentRunReconciliationEpisode(
  runId: string,
  token: string,
  episodeId: string,
) {
  const authenticated = await getAgentRun(runId, token);
  const run = authenticated.run;
  if (!run) throw new Error("agent_run_not_found");
  const storedEpisode = await getTaskEpisodeById(
    run.scope.kind === "site" ? run.scope.siteAgentId : "",
    episodeId,
  );
  if (!storedEpisode.episode || storedEpisode.episode.taskSessionId !== runId) {
    throw new Error("agent_run_reconciliation_episode_not_persisted");
  }
  const observations = await getPageAgentObservations(runId, {
    siteAgentId: storedEpisode.episode.siteAgentId,
    episodeId,
  });
  assertTrustedReconciliationEpisode(run, storedEpisode.episode, observations);
  const result = await mutateRun(runId, token, (current) => {
    const existing = trustedReconciliationMarker(current);
    if (existing?.episodeId === episodeId) {
      return {
        run: current,
        eventType: "status",
        eventPayload: eventPayload({ reconciliationEpisodeId: episodeId, idempotent: true }),
      };
    }
    if (existing) throw new Error("agent_run_reconciliation_episode_already_recorded");
    assertTrustedReconciliationEpisode(current, storedEpisode.episode!, observations);
    const acceptedAt = new Date().toISOString();
    return {
      run: {
        ...current,
        agentState: {
          ...current.agentState,
          reconciliationEpisodeAuthority: {
            status: "not-completed",
            episodeId,
            acceptedAt,
            observationIds: observations.map((observation) => observation.id),
          },
        },
      },
      eventType: "status",
      eventPayload: eventPayload({ reconciliationEpisodeId: episodeId, reconciliationStatus: "not-completed" }),
    };
  });
  return { ...result, persistence: getD1Binding() ? "d1" as const : "memory" as const };
}

/**
 * Converts an authenticated terminal PageAgent receipt into the only
 * server-trusted automatic capability trigger. Client-supplied Episode fields
 * alone never grant production authority, and one AgentRun can consume at
 * most one terminal capability-gap receipt.
 */
export async function authorizeAgentRunEpisode(runId: string, token: string, episode: TaskEpisode) {
  const current = await getAgentRun(runId, token);
  if (!current.run) throw new Error("agent_run_not_found");
  assertEpisodeMatchesAgentRun(current.run, episode);
  const runtimeFeatures = siteAgentRuntimeFeatures(episode.siteAgentId);
  const strictV2 = runtimeFeatures.pageAgentRuntimeV2
    && runtimeFeatures.pageAgentEvidenceV2
    && runtimeFeatures.capabilityExperienceOutbox;
  const v2EvidenceAttempted = Boolean(episode.experience?.observationRefs?.length
    || episode.experience?.actionReceiptsV2?.length);
  const executionGrant = compiledExecutionGrant(current.run);
  let compiledRepairSourceCapabilityId: string | undefined;
  const compiledDriftSource = current.run.status === "running"
    && episode.mode === "compiled"
    && episode.repairKind === "compiled-capability-drift"
    && episode.sourceCapabilityId
    && episode.capabilityId === episode.sourceCapabilityId
    && episode.compiledExecutionGrantId === executionGrant?.id
    && executionGrant?.status === "issued"
    && executionGrant?.capabilityId === episode.sourceCapabilityId
    && ["target_not_found", "operation_not_found", "operation_implementation_not_found", "capability_plan_not_found",
      "postcondition_failed", "operation_verification_failed", "program_verification_failed", "scene_not_found", "scene_binding_missing"]
      .includes(episode.outcome.code)
    ? episode.sourceCapabilityId
    : undefined;
  if (compiledDriftSource && executionGrant) {
    const source = await getCapability(episode.siteAgentId, compiledDriftSource);
    if (source?.currentVersionId === executionGrant.versionId) {
      const marked = await mutateRun(runId, token, (run) => {
        assertEpisodeMatchesAgentRun(run, episode);
        const currentGrant = compiledExecutionGrant(run);
        if (!currentGrant || currentGrant.id !== episode.compiledExecutionGrantId
          || currentGrant.status !== "issued") throw new Error("compiled_execution_grant_rejected");
        return {
          run: {
            ...run,
            agentState: {
              ...run.agentState,
              compiledRepairSourceCapabilityId: compiledDriftSource,
              compiledRepairSourceVersionId: currentGrant.versionId,
              compiledRepairFailureCode: episode.outcome.code,
              compiledExecutionGrant: {
                ...currentGrant,
                status: "failed",
                terminalEpisodeId: episode.id,
              },
            },
          },
          eventType: "status",
          eventPayload: { compiledRepairSourceCapabilityId: compiledDriftSource, failureCode: episode.outcome.code },
        };
      });
      current.run = marked.run;
      compiledRepairSourceCapabilityId = compiledDriftSource;
    }
  }
  if (!compiledRepairSourceCapabilityId) {
    // A client may retry after the first response was lost. Re-project the
    // source only when this exact Episode previously consumed the same pinned
    // grant and the pinned capability version is still current.
    const markedGrant = compiledExecutionGrant(current.run);
    const markedSource = current.run.agentState.compiledRepairSourceCapabilityId;
    const markedVersion = current.run.agentState.compiledRepairSourceVersionId;
    if (episode.mode === "compiled"
      && episode.repairKind === "compiled-capability-drift"
      && typeof markedSource === "string"
      && typeof markedVersion === "string"
      && episode.sourceCapabilityId === markedSource
      && episode.capabilityId === markedSource
      && episode.compiledExecutionGrantId === markedGrant?.id
      && markedGrant?.status === "failed"
      && markedGrant.terminalEpisodeId === episode.id
      && markedGrant.capabilityId === markedSource
      && markedGrant.versionId === markedVersion) {
      const source = await getCapability(episode.siteAgentId, markedSource);
      if (source?.currentVersionId === markedVersion) compiledRepairSourceCapabilityId = markedSource;
    }
  }
  let experienceAuthority = runtimeFeatures.capabilityExperienceOutbox && v2EvidenceAttempted
    ? capabilityExperienceAuthority(
      current.run,
      episode,
      await getPageAgentObservations(current.run.id, {
        siteAgentId: episode.siteAgentId,
        episodeId: episode.id,
      }),
    )
    : undefined;
  if (experienceAuthority?.kind === "strengthen") {
    const source = experienceAuthority.sourceCapabilityId
      ? await getCapability(episode.siteAgentId, experienceAuthority.sourceCapabilityId)
      : undefined;
    if (!source?.currentVersionId
      || current.run.agentState.compiledRepairSourceVersionId !== source.currentVersionId) experienceAuthority = undefined;
  }
  const reusableOutcome = episode.outcome.status === "success" || episode.outcome.status === "no-result";
  const hasPageEvidence = Boolean(episode.experience?.actions.some((item) =>
    ["click", "fill", "select", "scroll", "wait"].includes(item.action)));
  // A demonstration is the visitor showing the path by hand after the agent
  // could not; it is as much capability-generation material as an adaptive run.
  const legacyTerminalGap = !strictV2 && (!runtimeFeatures.capabilityExperienceOutbox || !v2EvidenceAttempted)
    && (episode.mode === "adaptive" || episode.mode === "demonstration")
    && reusableOutcome
    && hasPageEvidence
    && !episode.capabilityId;
  if (!legacyTerminalGap && !experienceAuthority) {
    return {
      run: current.run,
      triggerAuthority: undefined,
      experienceAuthority: undefined,
      compiledRepairSourceCapabilityId,
      persistence: current.persistence,
    };
  }
  const existingEpisodeId = current.run.agentState.capabilityGapEpisodeId;
  if (existingEpisodeId === episode.id) {
    return {
      run: current.run,
      triggerAuthority: legacyTerminalGap ? "terminal-user-gap" as const : undefined,
      experienceAuthority: experienceAuthority || (legacyTerminalGap ? legacyCapabilityExperienceAuthority(current.run, episode) : undefined),
      compiledRepairSourceCapabilityId,
      persistence: current.persistence,
    };
  }
  if (typeof existingEpisodeId === "string" && existingEpisodeId) throw new Error("agent_run_episode_already_consumed");

  const result = await mutateRun(runId, token, (run) => {
    assertEpisodeMatchesAgentRun(run, episode);
    const consumedEpisodeId = run.agentState.capabilityGapEpisodeId;
    if (consumedEpisodeId === episode.id) {
      return {
        run,
        eventType: "completed",
        eventPayload: {
          episodeId: episode.id,
          capabilityGap: true,
          capabilityExperienceAuthority: experienceAuthority?.kind || "legacy",
          idempotent: true,
        },
      };
    }
    if (typeof consumedEpisodeId === "string" && consumedEpisodeId) throw new Error("agent_run_episode_already_consumed");
    // A same-document navigation can legitimately leave the Run in
    // `awaiting-page` for a short handoff window even though the terminal
    // Episode has already proved the action and its observation chain.  The
    // V2 authority above (or the legacy terminal-gap predicate when V2
    // evidence was not emitted) is bound to this authenticated AgentRun, so
    // accepting this exact terminal Episode prevents a successful browser
    // action from being stranded behind a stale handoff state.  An
    // `awaiting-page` Run with neither terminal predicate still fails closed.
    if (run.status !== "running" && run.status !== "completed"
      && !(run.status === "awaiting-page" && (experienceAuthority || legacyTerminalGap))) {
      throw new Error(`agent_run_not_claimable:${run.status}`);
    }
    if (run.status === "completed" && run.outcome
      && run.outcome.status !== "success" && run.outcome.status !== "no-result") throw new Error("agent_run_outcome_rejected");
    return {
      run: {
        ...run,
        status: "completed",
        outcome: episode.outcome,
        agentState: {
          ...run.agentState,
          capabilityGapEpisodeId: episode.id,
          ...(experienceAuthority ? { capabilityExperienceAuthorityKind: experienceAuthority.kind } : {}),
          ...(experienceAuthority?.kind === "strengthen" ? {
            compiledRepairConsumedEpisodeId: episode.id,
          } : {}),
        },
        activePort: run.activePort ? { ...run.activePort, state: "released" as const } : undefined,
      },
      eventType: "completed",
      eventPayload: {
        episodeId: episode.id,
        capabilityGap: true,
        capabilityExperienceAuthority: experienceAuthority?.kind || "legacy",
        idempotent: false,
      },
    };
  });
  return {
    run: result.run,
    triggerAuthority: legacyTerminalGap ? "terminal-user-gap" as const : undefined,
    experienceAuthority: experienceAuthority || (legacyTerminalGap ? legacyCapabilityExperienceAuthority(result.run, episode) : undefined),
    compiledRepairSourceCapabilityId,
    persistence: getD1Binding() ? "d1" as const : "memory" as const,
  };
}

/**
 * Authorizes the second, compact V2 experience submission after the full
 * Episode has already consumed this AgentRun's one automatic-build receipt.
 * The browser cannot invent a different goal, episode, site or session.
 */
export async function authorizeAgentRunCapabilityExperience(runId: string, token: string, experience: CapabilityExperience, siteAgentId: string) {
  const current = await getAgentRun(runId, token);
  const run = current.run;
  if (!run
    || run.controller !== "page-agent"
    || run.scope.kind !== "site"
    || run.scope.siteAgentId !== siteAgentId
    || run.id !== experience.agentRunId
    || run.activePort?.browserSessionId !== experience.browserSessionId
    || normalizeGoal(run.goal) !== normalizeGoal(experience.originalGoal)
    || typeof run.agentState.capabilityExperienceAuthorityKind === "string"
    || run.agentState.capabilityGapEpisodeId !== experience.episodeId) {
    throw new Error("agent_run_capability_experience_rejected");
  }
  const expectedOutcome = experience.outcome === "NoResult" ? "no-result" : "success";
  if (run.outcome && run.outcome.status !== expectedOutcome) throw new Error("agent_run_capability_experience_outcome_rejected");
  return { run, persistence: current.persistence };
}

export async function checkpointAgentRun(runId: string, input: { token: string; expectedRevision: number; pageEpoch: number; checkpoint: AgentRunCheckpoint; bindings?: Record<string, JsonValue>; status?: AgentRunStatus; conversation?: AgentRun["conversation"] }) {
  const safeCheckpoint = sanitizeAgentRunCheckpoint(input.checkpoint);
  const safeBindings = redactSensitiveJson(input.bindings || {}) as Record<string, JsonValue>;
  const safeConversation = input.conversation?.map((turn) => ({ ...turn, content: redactSensitiveText(turn.content) }));
  return mutateRun(runId, input.token, (current) => {
    if (terminalRunStatus(current.status)) {
      return {
        run: current,
        eventType: "checkpoint",
        eventPayload: eventPayload({ ignored: "terminal-run", status: current.status, pageEpoch: current.pageEpoch }),
      };
    }
    if (current.revision !== input.expectedRevision) throw new Error("agent_run_revision_conflict");
    if (current.pageEpoch !== input.pageEpoch) throw new Error("agent_run_page_superseded");
    const now = new Date();
    const activePort = current.activePort ? { ...current.activePort, lastSeenAt: now.toISOString(), leaseExpiresAt: new Date(now.getTime() + 10_000).toISOString() } : undefined;
    const debugEvents = checkpointDebugEvents(current, safeCheckpoint);
    return { run: { ...current, status: input.status || current.status, checkpoint: safeCheckpoint, activityTimeline: safeCheckpoint.activityTimeline || current.activityTimeline || [], programCursor: safeCheckpoint.cursor, bindings: { ...current.bindings, ...safeBindings }, conversation: safeConversation || current.conversation, activePort }, eventType: "checkpoint", eventPayload: eventPayload({ phase: safeCheckpoint.phase, mode: safeCheckpoint.mode, pageEpoch: input.pageEpoch, activityCount: safeCheckpoint.activityTimeline?.length || 0, ...(debugEvents.length ? { debugEvents: debugEvents as unknown as JsonValue } : {}) }) };
  });
}

export async function issueAgentRunHandoff(runId: string, input: {
  token: string;
  expectedRevision: number;
  pageEpoch: number;
  portId?: string;
  documentId?: string;
  browserSessionId?: string;
  destinationUrl: string;
  checkpoint?: AgentRunCheckpoint;
}) {
  const destination = new URL(input.destinationUrl);
  const rawToken = crypto.randomUUID().replaceAll("-", "");
  const handoffTokenHash = await sha256Hex(rawToken);
  const handoffExpiresAt = new Date(Date.now() + AGENT_RUN_HANDOFF_WINDOW_MS).toISOString();
  const safeCheckpoint = input.checkpoint ? sanitizeAgentRunCheckpoint(input.checkpoint) : undefined;
  const result = await mutateRun(runId, input.token, (current) => {
    if (current.revision !== input.expectedRevision) throw new Error("agent_run_revision_conflict");
    if (current.pageEpoch !== input.pageEpoch) throw new Error("agent_run_page_superseded");
    if (current.controller === "page-agent"
      && (!current.activePort
        || current.activePort.id !== input.portId
        || current.activePort.documentId !== input.documentId
        || current.activePort.browserSessionId !== input.browserSessionId
        || current.activePort.pageEpoch !== input.pageEpoch)) {
      throw new Error("agent_run_page_superseded");
    }
    if (!current.scope.allowedOrigins.includes(destination.origin)) throw new Error("agent_run_origin_rejected");
    const checkpoint = safeCheckpoint || current.checkpoint;
    const runtime = runtimeCheckpoint(checkpoint).runtime;
    const capabilityId = typeof runtime.capabilityId === "string" ? runtime.capabilityId : checkpoint?.capabilityId;
    const debugEvents = capabilityId ? [makeDebugEvent({
      traceId: usageTraceId(current, capabilityId),
      traceKind: "usage",
      siteId: current.scope.siteAgentId,
      moduleId: "runtime.handoff",
      lifecycle: "progress",
      correlation: { agentRunId: current.id, capabilityId, versionId: typeof runtime.versionId === "string" ? runtime.versionId : undefined, pageEpoch: current.pageEpoch },
      input: { pageEpoch: current.pageEpoch, cursor: checkpoint?.cursor, destinationUrl: destination.toString() },
      output: { resumed: false, pageEpoch: current.pageEpoch },
    })] : [];
    return { run: { ...current, status: "awaiting-page", checkpoint, programCursor: checkpoint?.cursor || current.programCursor }, eventType: "status", eventPayload: { status: "awaiting-page", destinationUrl: destination.toString(), ...(debugEvents.length ? { debugEvents: debugEvents as unknown as JsonValue } : {}) }, handoffTokenHash, handoffExpiresAt };
  });
  return { run: result.run, handoffToken: `${runId}.${rawToken}`, expiresAt: handoffExpiresAt };
}

export async function enqueueAgentRunCommand(runId: string, input: { token: string; name: string; commandInput?: Record<string, JsonValue> }) {
  const allowed = ["observe", "query", "act", "navigate", "wait"];
  if (!allowed.includes(input.name)) throw new Error("agent_run_command_invalid");
  const result = await mutateRun(runId, input.token, (current) => {
    if (current.controller !== "script") throw new Error("agent_run_command_controller_invalid");
    if (!current.activePort) throw new Error("agent_run_page_not_connected");
    if (current.activeToolCall && ["pending", "running"].includes(current.activeToolCall.status)) throw new Error("agent_run_command_in_progress");
    const command: AgentRunToolCall = {
      id: uid("command"), kind: "page", name: input.name, input: input.commandInput || {}, status: "pending", startedAt: new Date().toISOString(),
    };
    return { run: { ...current, activeToolCall: command }, eventType: "tool-call", eventPayload: { commandId: command.id, name: command.name } };
  });
  return { run: result.run, command: result.run.activeToolCall! };
}

export async function claimAgentRunCommand(runId: string, input: { token: string; portId: string; pageEpoch: number }) {
  const current = await getAgentRun(runId, input.token);
  const command = current.run?.activeToolCall;
  if (!current.run || !command || command.status !== "pending") return { run: current.run, command: undefined };
  const result = await mutateRun(runId, input.token, (run) => {
    if (run.activePort?.id !== input.portId || run.pageEpoch !== input.pageEpoch) throw new Error("agent_run_page_superseded");
    if (run.activeToolCall?.id !== command.id || run.activeToolCall.status !== "pending") throw new Error("agent_run_command_changed");
    return { run: { ...run, activeToolCall: { ...run.activeToolCall, status: "running" } }, eventType: "status", eventPayload: { commandId: command.id, status: "running" } };
  });
  return { run: result.run, command: result.run.activeToolCall };
}

export async function completeAgentRunCommand(runId: string, input: { token: string; portId: string; pageEpoch: number; commandId: string; output?: Record<string, JsonValue>; error?: string }) {
  const result = await mutateRun(runId, input.token, (current) => {
    if (current.activePort?.id !== input.portId || current.pageEpoch !== input.pageEpoch) throw new Error("agent_run_page_superseded");
    if (current.activeToolCall?.id !== input.commandId || current.activeToolCall.status !== "running") throw new Error("agent_run_command_changed");
    const failed = Boolean(input.error);
    const call: AgentRunToolCall = {
      ...current.activeToolCall,
      status: failed ? "failed" : "completed",
      output: failed ? { error: input.error! } : input.output || {},
      endedAt: new Date().toISOString(),
    };
    return { run: { ...current, activeToolCall: call }, eventType: "tool-receipt", eventPayload: { commandId: call.id, status: call.status } };
  });
  return { run: result.run, command: result.run.activeToolCall! };
}

export async function appendExecutionReceipt(runId: string, input: { token: string; expectedRevision: number; receipt: ExecutionReceipt }) {
  const database = getD1Binding();
  if (database) {
    await ensureSiteAgentV3Schema(database);
    const found = await database.prepare(`SELECT receipt_json AS receiptJson FROM site_agent_v3_execution_receipts WHERE run_id=? AND slice_id=? LIMIT 1`).bind(runId, input.receipt.sliceId).all<{ receiptJson: string }>();
    if (found.results?.[0]) return { run: (await getAgentRun(runId, input.token)).run, receipt: JSON.parse(found.results[0].receiptJson) as ExecutionReceipt, duplicate: true };
  }
  const result = await mutateRun(runId, input.token, (current) => {
    if (current.revision !== input.expectedRevision) throw new Error("agent_run_revision_conflict");
    if (current.pageEpoch !== input.receipt.pageEpoch) throw new Error("agent_run_page_superseded");
    const status = input.receipt.status === "transitioning" ? "awaiting-page" : current.status;
    return { run: { ...current, status, bindings: { ...current.bindings, ...input.receipt.outputBindings } }, eventType: "tool-receipt", eventPayload: { sliceId: input.receipt.sliceId, status: input.receipt.status } };
  });
  if (database) {
    const receiptId = uid("receipt");
    const saved = await database.prepare(`INSERT OR IGNORE INTO site_agent_v3_execution_receipts (id,run_id,slice_id,page_epoch,status,receipt_json,created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(receiptId, runId, input.receipt.sliceId, input.receipt.pageEpoch, input.receipt.status, JSON.stringify(input.receipt), input.receipt.createdAt).run();
    if (!saved.success) throw new Error(saved.error || "execution_receipt_write_failed");
  }
  return { run: result.run, receipt: input.receipt, duplicate: false };
}

export async function updateAgentRunConversation(runId: string, input: { token: string; expectedRevision: number; pageEpoch: number; content: string }) {
  const content = redactSensitiveText(input.content).trim().slice(0, 4_000);
  if (!content) throw new Error("agent_run_response_required");
  return mutateRun(runId, input.token, (current) => {
    if (current.revision !== input.expectedRevision) throw new Error("agent_run_revision_conflict");
    if (current.pageEpoch !== input.pageEpoch) throw new Error("agent_run_page_superseded");
    const turn = { role: "user" as const, content, at: new Date().toISOString() };
    return { run: { ...current, status: "running", conversation: [...current.conversation, turn].slice(-40) }, eventType: "conversation", eventPayload: { role: "user", content } };
  });
}

export async function finishAgentRun(runId: string, input: { token: string; expectedRevision: number; pageEpoch: number; status: "completed" | "failed" | "cancelled"; output?: Record<string, JsonValue>; outcome?: OutcomeReceipt; assistantText?: string; activityTimeline?: AgentRunActivity[] }) {
  const safeOutput = input.output ? redactSensitiveJson(input.output) as Record<string, JsonValue> : undefined;
  const safeOutcome = input.outcome ? redactSensitiveJson(input.outcome) as unknown as OutcomeReceipt : undefined;
  const safeAssistantText = input.assistantText ? redactSensitiveText(input.assistantText) : undefined;
  const safeActivity = input.activityTimeline ? redactSensitiveJson(input.activityTimeline) as unknown as AgentRunActivity[] : undefined;
  return mutateRun(runId, input.token, (current) => {
    if (current.revision !== input.expectedRevision) throw new Error("agent_run_revision_conflict");
    if (current.pageEpoch !== input.pageEpoch) throw new Error("agent_run_page_superseded");
    const conversation = safeAssistantText ? [...current.conversation, { role: "assistant" as const, content: safeAssistantText.slice(0, 8_000), at: new Date().toISOString() }] : current.conversation;
    const debugEvents = finishDebugEvents(current, { status: input.status, output: safeOutput, outcome: safeOutcome });
    return { run: { ...current, status: input.status, conversation, activityTimeline: safeActivity || current.activityTimeline || [], output: safeOutput, outcome: safeOutcome, activePort: current.activePort ? { ...current.activePort, state: "released" } : undefined }, eventType: input.status, eventPayload: { status: input.status, summary: safeOutcome?.summary || safeAssistantText || "", activityCount: safeActivity?.length || current.activityTimeline?.length || 0, ...(debugEvents.length ? { debugEvents: debugEvents as unknown as JsonValue } : {}) } };
  });
}

/**
 * Cancellation is an explicit user boundary, not an optimistic update from a
 * BrowserPort. A navigation may have incremented revision/pageEpoch between
 * the click on “stop” and this request, so cancellation must win that race and
 * revoke any outstanding continuation token.
 */
export async function cancelAgentRun(runId: string, token: string) {
  return mutateRun(runId, token, (current) => {
    if (["completed", "failed", "cancelled"].includes(current.status)) {
      return { run: current, eventType: "cancelled", eventPayload: { alreadyTerminal: true } as Record<string, JsonValue>, handoffTokenHash: undefined, handoffExpiresAt: undefined };
    }
    const conversation = [...current.conversation, { role: "assistant" as const, content: "任务已取消。", at: new Date().toISOString() }];
    return {
      run: { ...current, status: "cancelled", conversation, activePort: current.activePort ? { ...current.activePort, state: "released" } : undefined },
      eventType: "cancelled", eventPayload: { explicitUserCancellation: true } as Record<string, JsonValue>, handoffTokenHash: undefined, handoffExpiresAt: undefined,
    };
  });
}

export async function listAgentRunEvents(runId: string, token: string, after = 0, requestedLimit = 200) {
  const database = getD1Binding();
  const limit = Math.max(1, Math.min(1_000, Math.floor(requestedLimit || 200)));
  await getAgentRun(runId, token);
  if (!database) {
    const matched = (memoryEvents().get(runId) || []).filter((item) => item.sequence > after);
    return { events: matched.slice(0, limit), hasMore: matched.length > limit, persistence: "memory" as const };
  }
  const result = await database.prepare(`SELECT event_json AS eventJson FROM site_agent_v3_run_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?`).bind(runId, after, limit + 1).all<{ eventJson: string }>();
  if (!result.success) throw new Error(result.error || "agent_run_events_read_failed");
  const events = (result.results || []).map((row) => JSON.parse(row.eventJson) as AgentRunEvent);
  return { events: events.slice(0, limit), hasMore: events.length > limit, persistence: "d1" as const };
}

/**
 * Appends already-redacted observability events without introducing another
 * authority or storage table. The packed AgentRun token remains the only
 * public write authority; a batch is stored inside one normal Run event so
 * eventSequence stays monotonic under the existing optimistic update loop.
 */
export async function appendAgentRunDebugEvents(runId: string, token: string, events: CapabilityDebugEvent[]) {
  const bounded = events.slice(0, 20);
  const serialized = JSON.stringify(bounded);
  if (!bounded.length) return { run: (await getAgentRun(runId, token)).run, accepted: 0 };
  if (new TextEncoder().encode(serialized).byteLength > 64 * 1024) throw new Error("agent_run_debug_events_too_large");
  const result = await mutateRun(runId, token, (current) => ({
    run: current,
    eventType: "checkpoint",
    eventPayload: { debugEvents: bounded as unknown as JsonValue },
  }));
  return { run: result.run, accepted: bounded.length };
}

const RECLAIMABLE_STATUSES: AgentRunStatus[] = ["running", "awaiting-page", "awaiting-user"];
const EXPIRED_RUN_SWEEP_LIMIT = 50;

/**
 * Close out Runs for one site whose client never reported a terminal state.
 * Bounded so a site with a long tail of leaked records cannot turn one task
 * start into an unbounded write.
 */
export async function sweepExpiredRunsForSite(database: D1DatabaseLike | null, siteAgentId: string) {
  const now = new Date().toISOString();
  if (!database) {
    const stale = [...memoryRuns().values()]
      .map((item) => item.run)
      .filter((run) => run.scope.kind === "site" && run.scope.siteAgentId === siteAgentId && run.expiresAt <= now)
      .slice(0, EXPIRED_RUN_SWEEP_LIMIT);
    await reclaimExpiredRuns(null, stale);
    return stale.length;
  }
  const result = await database.prepare(
    `SELECT run_json AS runJson FROM site_agent_v3_agent_runs
     WHERE site_agent_id=? AND expires_at<=? AND status IN ('running','awaiting-page','awaiting-user') LIMIT ?`)
    .bind(siteAgentId, now, EXPIRED_RUN_SWEEP_LIMIT).all<{ runJson: string }>();
  if (!result.success) return 0;
  const stale = (result.results || []).map((row) => JSON.parse(row.runJson) as AgentRun);
  await reclaimExpiredRuns(database, stale);
  return stale.length;
}

/**
 * A Run whose client never reported a terminal state. Reclaimed lazily on read
 * rather than by a scheduler: a leaked Run only distorts anything at the moment
 * something looks at it, and adding a scheduler would mean a new dependency,
 * failure surface and deployment knob for a purely cosmetic gain.
 */
export function reclaimExpiredRun(run: AgentRun, now = Date.now()): AgentRun | undefined {
  if (!RECLAIMABLE_STATUSES.includes(run.status)) return undefined;
  const expiresAt = Date.parse(run.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt > now) return undefined;
  const evaluatedAt = new Date(now).toISOString();
  return {
    ...run,
    status: "failed",
    updatedAt: evaluatedAt,
    outcome: run.outcome || {
      status: "unknown",
      code: "agent_run_expired_reclaimed",
      summary: "运行记录已过期，服务端将其收尾；客户端从未上报终态。",
      evaluatedAt,
      evidence: { source: "server-reclaim", reclaimedFrom: run.status },
    },
  };
}

async function reclaimExpiredRuns(database: D1DatabaseLike | null, runs: AgentRun[]) {
  const reclaimed = runs.map((run) => ({ run, next: reclaimExpiredRun(run) }));
  if (!reclaimed.some((item) => item.next)) return runs;
  if (database) {
    // Best effort: a failed sweep must never break the read that triggered it.
    await Promise.allSettled(reclaimed.filter((item) => item.next).map((item) => database
      .prepare("UPDATE site_agent_v3_agent_runs SET status=?,run_json=?,updated_at=? WHERE id=? AND status=?")
      .bind(item.next!.status, JSON.stringify(item.next), item.next!.updatedAt, item.run.id, item.run.status)
      .run()));
  } else {
    for (const item of reclaimed) {
      if (!item.next) continue;
      const stored = memoryRuns().get(item.run.id);
      if (stored) memoryRuns().set(item.run.id, { ...stored, run: item.next });
    }
  }
  return reclaimed.map((item) => item.next || item.run);
}

/** Management-only read projections. They intentionally return no token
 * hashes and are consumed behind capabilityReadAuthorized admin routes. */
export async function listAgentRunsForAdmin(siteAgentId: string, options: { before?: string; since?: string; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit || 200)));
  const database = getD1Binding();
  if (!database) {
    const runs = [...memoryRuns().values()]
      .map((item) => item.run)
      .filter((run) => run.scope.kind === "site" && run.scope.siteAgentId === siteAgentId)
      .filter((run) => !options.before || run.updatedAt < options.before)
      .filter((run) => !options.since || run.updatedAt >= options.since)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
    return { runs: await reclaimExpiredRuns(null, runs), persistence: "memory" as const };
  }
  await ensureSiteAgentV3Schema(database);
  const clauses = ["site_agent_id=?"];
  const values: unknown[] = [siteAgentId];
  if (options.before) { clauses.push("updated_at<?"); values.push(options.before); }
  if (options.since) { clauses.push("updated_at>=?"); values.push(options.since); }
  values.push(limit);
  const result = await database.prepare(`SELECT run_json AS runJson FROM site_agent_v3_agent_runs WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`).bind(...values).all<{ runJson: string }>();
  if (!result.success) throw new Error(result.error || "agent_run_admin_list_failed");
  const runs = (result.results || []).map((row) => JSON.parse(row.runJson) as AgentRun);
  return { runs: await reclaimExpiredRuns(database, runs), persistence: "d1" as const };
}

export async function getAgentRunForAdmin(siteAgentId: string, runId: string) {
  const database = getD1Binding();
  if (!database) {
    const run = memoryRuns().get(runId)?.run;
    return run?.scope.kind === "site" && run.scope.siteAgentId === siteAgentId ? run : undefined;
  }
  await ensureSiteAgentV3Schema(database);
  const result = await database.prepare(`SELECT run_json AS runJson FROM site_agent_v3_agent_runs WHERE id=? AND site_agent_id=? LIMIT 1`).bind(runId, siteAgentId).all<{ runJson: string }>();
  if (!result.success) throw new Error(result.error || "agent_run_admin_read_failed");
  return result.results?.[0] ? JSON.parse(result.results[0].runJson) as AgentRun : undefined;
}

export async function listAgentRunEventsForAdmin(siteAgentId: string, runId: string, options: { after?: number; limit?: number } = {}) {
  const run = await getAgentRunForAdmin(siteAgentId, runId);
  if (!run) return { events: [] as AgentRunEvent[], hasMore: false };
  const after = Math.max(0, Math.floor(options.after || 0));
  const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit || 300)));
  const database = getD1Binding();
  if (!database) {
    const matched = (memoryEvents().get(runId) || []).filter((event) => event.sequence > after);
    return { events: matched.slice(0, limit), hasMore: matched.length > limit };
  }
  const result = await database.prepare(`SELECT event_json AS eventJson FROM site_agent_v3_run_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?`).bind(runId, after, limit + 1).all<{ eventJson: string }>();
  if (!result.success) throw new Error(result.error || "agent_run_admin_events_failed");
  const events = (result.results || []).map((row) => JSON.parse(row.eventJson) as AgentRunEvent);
  return { events: events.slice(0, limit), hasMore: events.length > limit };
}

/** Reads only normalized debug envelopes across runs for the management
 * workbench. This is the no-new-table bridge for traces that fail before a
 * CapabilityTask can be created (for example Experience abstraction). */
export async function listAgentRunDebugEventsForAdmin(siteAgentId: string, options: { since?: string; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(5_000, Math.floor(options.limit || 2_000)));
  const include = (run: AgentRun, event: AgentRunEvent) => {
    const single = event.payload.debugEvent;
    const many = event.payload.debugEvents;
    const debugEvents = [
      ...(single && typeof single === "object" && !Array.isArray(single) ? [single] : []),
      ...(Array.isArray(many) ? many : []),
    ].filter((value): value is CapabilityDebugEvent => Boolean(value && typeof value === "object" && !Array.isArray(value) && value.schemaVersion === "capability-debug.v1"));
    return debugEvents.length ? { run, event, debugEvents } : undefined;
  };
  const database = getD1Binding();
  if (!database) {
    const values = [...memoryRuns().values()].flatMap(({ run }) => (memoryEvents().get(run.id) || [])
      .filter((event) => !options.since || event.createdAt >= options.since)
      .map((event) => include(run, event))
      .filter((value): value is NonNullable<typeof value> => Boolean(value)));
    return { records: values.sort((left, right) => left.event.createdAt.localeCompare(right.event.createdAt)).slice(-limit), persistence: "memory" as const };
  }
  await ensureSiteAgentV3Schema(database);
  const clauses = ["r.site_agent_id=?", "e.type='checkpoint'"];
  const values: unknown[] = [siteAgentId];
  if (options.since) { clauses.push("e.created_at>=?"); values.push(options.since); }
  values.push(limit);
  const result = await database.prepare(`SELECT r.run_json AS runJson,e.event_json AS eventJson FROM site_agent_v3_run_events e JOIN site_agent_v3_agent_runs r ON r.id=e.run_id WHERE ${clauses.join(" AND ")} ORDER BY e.created_at DESC LIMIT ?`).bind(...values).all<{ runJson: string; eventJson: string }>();
  if (!result.success) throw new Error(result.error || "agent_run_debug_events_failed");
  const records = (result.results || []).map((row) => {
    const run = JSON.parse(row.runJson) as AgentRun;
    const event = JSON.parse(row.eventJson) as AgentRunEvent;
    return include(run, event);
  }).filter((value): value is NonNullable<typeof value> => Boolean(value)).reverse();
  return { records, persistence: "d1" as const };
}

/**
 * On site deletion: the site's AgentRuns and every run-keyed child record (events, tool
 * calls, execution receipts, browser ports). Child tables first, the run table last.
 */
export const AGENT_RUN_CHILD_TABLES = [
  "site_agent_v3_run_events",
  "site_agent_v3_tool_calls",
  "site_agent_v3_execution_receipts",
  "site_agent_v3_browser_ports",
] as const;

export function agentRunDeletionStatements(database: D1DatabaseLike, siteAgentId: string): D1PreparedStatementLike[] {
  return [
    ...AGENT_RUN_CHILD_TABLES.map((table) => database.prepare(`DELETE FROM ${table} WHERE run_id IN (SELECT id FROM site_agent_v3_agent_runs WHERE site_agent_id=?)`).bind(siteAgentId)),
    database.prepare(`DELETE FROM site_agent_v3_agent_runs WHERE site_agent_id=?`).bind(siteAgentId),
  ];
}

export function deleteMemoryAgentRunData(siteAgentId: string) {
  const runs = memoryRuns();
  const events = memoryEvents();
  for (const [id, stored] of runs) {
    if (stored.run.scope.siteAgentId !== siteAgentId) continue;
    runs.delete(id);
    events.delete(id);
  }
}
