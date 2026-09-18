import { assertCapabilityStartUrl } from "../lib/capability-center-v2/site-entry-policy";
import type { CapabilityExperienceIntake } from "../lib/capability-center-v2/experience-intake";
import { redactSensitiveText } from "../lib/site-knowledge/sensitive-data";
import { getD1Binding, type D1DatabaseLike, type D1PreparedStatementLike } from "./index";
import { ensureSiteAgentV3Schema } from "./site-agent-schema";
import { getAgentRunInternal } from "./agent-run-store";
import { getTaskEpisodeById } from "./site-agent-store";
import {
  extendPageAgentObservationRetention,
  getPageAgentObservations,
  purgeExpiredPageAgentObservations,
} from "./page-observation-store";
import { legacyCapabilityExperienceAuthority, capabilityExperienceAuthority, type CapabilityExperienceAuthority } from "../lib/capability-center-v2/experience-authority";
import { capabilityExperienceFromEpisode, capabilityHandoffForEpisode } from "../lib/capability-center-v2/experience";
import { createCapabilityFromAuthorizedExperience } from "../lib/capability-center-v2/experience-service";
import { siteAgentRuntimeFeatures } from "../lib/site-knowledge/runtime-features";
import type { AgentRun, PageObservationRef, TaskEpisode } from "../lib/site-knowledge/protocol";

type OutboxStatus = "pending" | "evidence-pending" | "processing" | "completed" | "failed";

// Retention policy: the three non-terminal states pin their Episode evidence.
// A permanently failed item is not a pin and expires on the original 14-day
// schedule; a Created result is extended to 90 days before it becomes completed.

export type CapabilityExperienceOutboxItem = {
  id: string;
  siteAgentId: string;
  runId: string;
  episodeId: string;
  authority: CapabilityExperienceAuthority["kind"];
  sourceCapabilityId?: string;
  sourceVersionId?: string;
  observationRefs: PageObservationRef[];
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt?: string;
  result?: Record<string, unknown>;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

type MemoryRoot = typeof globalThis & {
  __SITEWAKE_CAPABILITY_EXPERIENCE_OUTBOX_V3__?: Map<string, CapabilityExperienceOutboxItem>;
};

type OutboxRow = {
  id: string;
  siteAgentId: string;
  runId: string;
  episodeId: string;
  authority: CapabilityExperienceAuthority["kind"];
  sourceCapabilityId?: string;
  sourceVersionId?: string;
  observationRefsJson: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt?: string;
  resultJson?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

function memoryOutbox() {
  const root = globalThis as MemoryRoot;
  root.__SITEWAKE_CAPABILITY_EXPERIENCE_OUTBOX_V3__ ||= new Map();
  return root.__SITEWAKE_CAPABILITY_EXPERIENCE_OUTBOX_V3__;
}

function itemId(authority: CapabilityExperienceAuthority) {
  return `capability_experience:${authority.siteAgentId}:${authority.episodeId}:${authority.kind}`;
}

function itemIdFromParts(siteAgentId: string, episodeId: string, authority: CapabilityExperienceAuthority["kind"]) {
  return `capability_experience:${siteAgentId}:${episodeId}:${authority}`;
}

function rowItem(row: OutboxRow): CapabilityExperienceOutboxItem {
  return {
    id: row.id,
    siteAgentId: row.siteAgentId,
    runId: row.runId,
    episodeId: row.episodeId,
    authority: row.authority,
    sourceCapabilityId: row.sourceCapabilityId || undefined,
    sourceVersionId: row.sourceVersionId || undefined,
    observationRefs: JSON.parse(row.observationRefsJson) as PageObservationRef[],
    status: row.status,
    attempts: Number(row.attempts || 0),
    nextAttemptAt: row.nextAttemptAt || undefined,
    result: row.resultJson ? JSON.parse(row.resultJson) as Record<string, unknown> : undefined,
    lastError: row.lastError || undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function sameAuthority(item: CapabilityExperienceOutboxItem, authority: CapabilityExperienceAuthority) {
  return item.siteAgentId === authority.siteAgentId
    && item.runId === authority.runId
    && item.episodeId === authority.episodeId
    && item.authority === authority.kind
    && item.sourceCapabilityId === authority.sourceCapabilityId
    && item.sourceVersionId === authority.sourceVersionId
    && JSON.stringify(item.observationRefs) === JSON.stringify(authority.observationRefs);
}

async function readItem(database: D1DatabaseLike, id: string) {
  const result = await database.prepare(`SELECT id,site_agent_id AS siteAgentId,run_id AS runId,episode_id AS episodeId,
    authority_kind AS authority,source_capability_id AS sourceCapabilityId,source_version_id AS sourceVersionId,observation_refs_json AS observationRefsJson,status,attempts,
    next_attempt_at AS nextAttemptAt,result_json AS resultJson,last_error AS lastError,created_at AS createdAt,updated_at AS updatedAt
    FROM site_agent_v3_capability_experience_outbox WHERE id=? LIMIT 1`).bind(id).all<OutboxRow>();
  if (!result.success) throw new Error(result.error || "capability_experience_outbox_read_failed");
  return result.results?.[0] ? rowItem(result.results[0]) : undefined;
}

/** Operational lookup for tracing an accepted Episode through task creation. */
export async function getCapabilityExperienceOutboxItem(
  siteAgentId: string,
  episodeId: string,
  authority: CapabilityExperienceAuthority["kind"],
) {
  const id = itemIdFromParts(siteAgentId, episodeId, authority);
  const database = getD1Binding();
  if (!database) return memoryOutbox().get(id);
  await ensureSiteAgentV3Schema(database);
  return readItem(database, id);
}

export async function enqueueCapabilityExperience(authority: CapabilityExperienceAuthority) {
  if (authority.kind !== "legacy-create" && !siteAgentRuntimeFeatures(authority.siteAgentId).capabilityExperienceOutbox) {
    throw new Error("capability_experience_outbox_disabled");
  }
  const id = itemId(authority);
  const now = new Date().toISOString();
  const item: CapabilityExperienceOutboxItem = {
    id,
    siteAgentId: authority.siteAgentId,
    runId: authority.runId,
    episodeId: authority.episodeId,
    authority: authority.kind,
    sourceCapabilityId: authority.sourceCapabilityId,
    sourceVersionId: authority.sourceVersionId,
    observationRefs: authority.observationRefs,
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  const database = getD1Binding();
  if (!database) {
    const existing = memoryOutbox().get(id);
    if (existing && !sameAuthority(existing, authority)) throw new Error("capability_experience_outbox_conflict");
    if (!existing) memoryOutbox().set(id, item);
    return { item: existing || item, duplicate: Boolean(existing), persistence: "memory" as const };
  }
  await ensureSiteAgentV3Schema(database);
  const inserted = await database.prepare(`INSERT OR IGNORE INTO site_agent_v3_capability_experience_outbox
    (id,site_agent_id,run_id,episode_id,authority_kind,authority,source_capability_id,source_version_id,observation_refs_json,status,attempts,next_attempt_at,result_json,last_error,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, authority.siteAgentId, authority.runId, authority.episodeId,
      authority.kind, authority.kind, authority.sourceCapabilityId || null, authority.sourceVersionId || null, JSON.stringify(authority.observationRefs), "pending", 0, null, null, null, now, now).run();
  if (!inserted.success) throw new Error(inserted.error || "capability_experience_outbox_write_failed");
  const stored = await readItem(database, id);
  if (!stored || !sameAuthority(stored, authority)) throw new Error("capability_experience_outbox_conflict");
  return { item: stored, duplicate: Number(inserted.meta?.changes || 0) === 0, persistence: "d1" as const };
}

async function claimMemoryItem(now: string) {
  const stale = new Date(Date.parse(now) - 10 * 60_000).toISOString();
  const item = [...memoryOutbox().values()].find((candidate) =>
    ((candidate.status === "pending" || candidate.status === "evidence-pending") && (!candidate.nextAttemptAt || candidate.nextAttemptAt <= now))
    || (candidate.status === "processing" && candidate.updatedAt <= stale));
  if (!item) return undefined;
  const claimed = { ...item, status: "processing" as const, attempts: item.attempts + 1, updatedAt: now };
  memoryOutbox().set(item.id, claimed);
  return claimed;
}

async function claimDatabaseItem(database: D1DatabaseLike, now: string) {
  const stale = new Date(Date.parse(now) - 10 * 60_000).toISOString();
  const due = await database.prepare(`SELECT id,site_agent_id AS siteAgentId,run_id AS runId,episode_id AS episodeId,
    authority_kind AS authority,source_capability_id AS sourceCapabilityId,source_version_id AS sourceVersionId,observation_refs_json AS observationRefsJson,status,attempts,
    next_attempt_at AS nextAttemptAt,result_json AS resultJson,last_error AS lastError,created_at AS createdAt,updated_at AS updatedAt
    FROM site_agent_v3_capability_experience_outbox
    WHERE (status IN ('pending','evidence-pending') AND (next_attempt_at IS NULL OR next_attempt_at<=?)) OR (status='processing' AND updated_at<=?)
    ORDER BY created_at LIMIT 1`).bind(now, stale).all<OutboxRow>();
  if (!due.success) throw new Error(due.error || "capability_experience_outbox_claim_failed");
  const row = due.results?.[0];
  if (!row) return undefined;
  const claimed = await database.prepare(`UPDATE site_agent_v3_capability_experience_outbox
    SET status='processing',attempts=attempts+1,updated_at=?
    WHERE id=? AND ((status IN ('pending','evidence-pending') AND (next_attempt_at IS NULL OR next_attempt_at<=?)) OR (status='processing' AND updated_at<=?))`)
    .bind(now, row.id, now, stale).run();
  if (!claimed.success) throw new Error(claimed.error || "capability_experience_outbox_claim_failed");
  if (!Number(claimed.meta?.changes || 0)) return undefined;
  return readItem(database, row.id);
}

async function completeItem(item: CapabilityExperienceOutboxItem, result: Record<string, unknown>) {
  const now = new Date().toISOString();
  const database = getD1Binding();
  if (!database) {
    const current = memoryOutbox().get(item.id);
    if (current?.status === "processing" && current.attempts === item.attempts) memoryOutbox().set(item.id, { ...current, status: "completed", result, nextAttemptAt: undefined, lastError: undefined, updatedAt: now });
    return;
  }
  const saved = await database.prepare(`UPDATE site_agent_v3_capability_experience_outbox
    SET status='completed',result_json=?,next_attempt_at=NULL,last_error=NULL,updated_at=? WHERE id=? AND status='processing' AND attempts=?`)
    .bind(JSON.stringify(result), now, item.id, item.attempts).run();
  if (!saved.success) throw new Error(saved.error || "capability_experience_outbox_complete_failed");
}

async function retryItem(item: CapabilityExperienceOutboxItem, error: unknown) {
  const now = new Date();
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
  const evidencePending = message.includes("capability_experience_evidence_pending");
  const terminal = item.attempts >= 8;
  const nextAttemptAt = terminal ? undefined : new Date(now.getTime() + Math.min(60, 2 ** item.attempts) * 60_000).toISOString();
  const status: OutboxStatus = terminal ? "failed" : evidencePending ? "evidence-pending" : "pending";
  const database = getD1Binding();
  if (!database) {
    const current = memoryOutbox().get(item.id);
    if (current?.status === "processing" && current.attempts === item.attempts) memoryOutbox().set(item.id, { ...current, status, nextAttemptAt, lastError: message, updatedAt: now.toISOString() });
    return;
  }
  const saved = await database.prepare(`UPDATE site_agent_v3_capability_experience_outbox
    SET status=?,next_attempt_at=?,last_error=?,updated_at=? WHERE id=? AND status='processing' AND attempts=?`)
    .bind(status, nextAttemptAt || null, message, now.toISOString(), item.id, item.attempts).run();
  if (!saved.success) throw new Error(saved.error || "capability_experience_outbox_retry_failed");
}

function resultProjection(
  item: CapabilityExperienceOutboxItem,
  result: Awaited<ReturnType<typeof createCapabilityFromAuthorizedExperience>>,
) {
  return {
    siteAgentId: item.siteAgentId,
    runId: item.runId,
    episodeId: item.episodeId,
    authority: item.authority,
    ...(item.sourceCapabilityId ? { sourceCapabilityId: item.sourceCapabilityId } : {}),
    ...(item.sourceVersionId ? { sourceVersionId: item.sourceVersionId } : {}),
    disposition: result.disposition,
    ...(result.disposition === "Created" ? { taskId: result.task.id } : {}),
    ...(result.disposition !== "Created" && result.match.capabilityId ? { capabilityId: result.match.capabilityId } : {}),
    ...(result.disposition !== "Created" ? { reason: result.match.reason } : {}),
  };
}

async function processItem(item: CapabilityExperienceOutboxItem) {
  // Rollout gates admission only. Once an Episode is durably accepted, flag
  // changes must not abandon its exactly-once capability task.
  const [{ run }, { episode }] = await Promise.all([
    getAgentRunInternal(item.runId),
    getTaskEpisodeById(item.siteAgentId, item.episodeId),
  ]);
  if (!run || !episode) throw new Error("capability_experience_evidence_pending");
  const observations = await getPageAgentObservations(item.runId, { siteAgentId: item.siteAgentId, episodeId: item.episodeId });
  if (observations.length !== item.observationRefs.length) throw new Error("capability_experience_evidence_pending");
  const authority = item.authority === "legacy-create"
    ? legacyCapabilityExperienceAuthority(run, episode)
    : capabilityExperienceAuthority(run, episode, observations);
  if (!authority || !sameAuthority(item, authority)) throw new Error("capability_experience_authority_rejected");
  const legacy = item.authority === "legacy-create" ? capabilityHandoffForEpisode(episode, {}) : undefined;
  const experience = legacy?.delivered ? legacy.experience : capabilityExperienceFromEpisode(episode, observations, run);
  if (item.authority === "legacy-create") await Promise.all([
    assertCapabilityStartUrl(item.siteAgentId, experience.startPage.url),
    assertCapabilityStartUrl(item.siteAgentId, experience.endPage.url),
  ]);
  const result = await createCapabilityFromAuthorizedExperience(item.siteAgentId, experience, authority);
  if (result.disposition === "Created" && item.observationRefs.length) {
    await extendPageAgentObservationRetention(item.runId, item.episodeId, new Date(Date.now() + 90 * 86_400_000).toISOString());
  }
  await completeItem(item, resultProjection(item, result));
}

/** Recover recently accepted receipts from pre-outbox releases or interrupted persistence. */
export async function reconcileCapabilityExperienceOutbox(limit = 100) {
  const database = getD1Binding();
  if (!database) return { enqueued: 0, persistence: "memory" as const };
  await ensureSiteAgentV3Schema(database);
  const candidates = await database.prepare(`SELECT e.episode_json AS episodeJson,r.run_json AS runJson
    FROM site_agent_v2_episodes e
    JOIN site_agent_v3_agent_runs r ON r.id=e.task_session_id AND r.site_agent_id=e.site_agent_id
    LEFT JOIN site_agent_v3_capability_experience_outbox o ON o.site_agent_id=e.site_agent_id AND o.episode_id=e.id
    WHERE o.id IS NULL AND e.mode IN ('adaptive','repair') AND e.outcome_status IN ('success','no-result')
      AND e.ended_at>=? AND ${database.dialect === "postgres" ? "r.run_json::jsonb->'agentState'->>'capabilityGapEpisodeId'" : "json_extract(r.run_json,'$.agentState.capabilityGapEpisodeId')"}=e.id ORDER BY e.ended_at DESC LIMIT ${Math.max(1, Math.min(500, limit))}`)
    .bind(new Date(Date.now() - 14 * 86_400_000).toISOString()).all<{ episodeJson: string; runJson: string }>();
  if (!candidates.success) throw new Error(candidates.error || "capability_experience_outbox_reconcile_failed");
  let enqueued = 0;
  for (const row of candidates.results || []) {
    const episode = JSON.parse(row.episodeJson) as TaskEpisode;
    const run = JSON.parse(row.runJson) as AgentRun;
    const legacy = legacyCapabilityExperienceAuthority(run, episode);
    if (!legacy && (!siteAgentRuntimeFeatures(episode.siteAgentId).capabilityExperienceOutbox
      || !episode.experience?.observationRefs?.length)) continue;
    const observations = legacy ? [] : await getPageAgentObservations(run.id, { siteAgentId: episode.siteAgentId, episodeId: episode.id });
    const authority = legacy || capabilityExperienceAuthority(run, episode, observations);
    if (!authority) continue;
    const result = await enqueueCapabilityExperience(authority);
    if (!result.duplicate) enqueued += 1;
  }
  return { enqueued, persistence: "d1" as const };
}

export async function processCapabilityExperienceOutbox(limit = 2) {
  await reconcileCapabilityExperienceOutbox();
  const database = getD1Binding();
  if (database) await ensureSiteAgentV3Schema(database);
  let processed = 0;
  let failed = 0;
  for (let index = 0; index < Math.max(0, Math.min(20, limit)); index += 1) {
    const item = database
      ? await claimDatabaseItem(database, new Date().toISOString())
      : await claimMemoryItem(new Date().toISOString());
    if (!item) break;
    try { await processItem(item); processed += 1; }
    catch (error) { await retryItem(item, error); failed += 1; }
  }
  const cleanup = await purgeExpiredPageAgentObservations();
  return { processed, failed, purged: cleanup.purged, persistence: database ? "d1" as const : "memory" as const };
}

export function resetMemoryCapabilityExperienceOutbox() { memoryOutbox().clear(); }

/** Latest receipts, with unfinished work first so failures cannot disappear. */
export async function listCapabilityExperienceIntakes(siteAgentId: string, runId?: string): Promise<CapabilityExperienceIntake[]> {
  const database = getD1Binding();
  let items: CapabilityExperienceOutboxItem[];
  const goals = new Map<string, string>();
  if (!database) items = [...memoryOutbox().values()].filter(item => item.siteAgentId === siteAgentId && (!runId || item.runId === runId));
  else {
    await ensureSiteAgentV3Schema(database);
    const goalSql = database.dialect === "postgres" ? "e.episode_json::jsonb->>'goal'" : "json_extract(e.episode_json,'$.goal')";
    const rows = await database.prepare(`SELECT o.id,o.site_agent_id AS siteAgentId,o.run_id AS runId,o.episode_id AS episodeId,
      o.authority_kind AS authority,o.source_capability_id AS sourceCapabilityId,o.source_version_id AS sourceVersionId,
      o.observation_refs_json AS observationRefsJson,o.status,o.attempts,o.next_attempt_at AS nextAttemptAt,
      o.result_json AS resultJson,o.last_error AS lastError,o.created_at AS createdAt,o.updated_at AS updatedAt,${goalSql} AS goal
      FROM site_agent_v3_capability_experience_outbox o LEFT JOIN site_agent_v2_episodes e ON e.id=o.episode_id AND e.site_agent_id=o.site_agent_id
      WHERE o.site_agent_id=? ${runId ? "AND o.run_id=?" : ""}
      ORDER BY CASE WHEN o.status='completed' THEN 1 ELSE 0 END,o.created_at DESC LIMIT 100`)
      .bind(siteAgentId, ...(runId ? [runId] : [])).all<OutboxRow & { goal?: string }>();
    if (!rows.success) throw new Error(rows.error || "capability_experience_outbox_read_failed");
    items = (rows.results || []).map(rowItem);
    for (const row of rows.results || []) if (row.goal) goals.set(row.id, row.goal);
  }
  items.sort((a,b) => Number(a.status === "completed") - Number(b.status === "completed") || b.createdAt.localeCompare(a.createdAt));
  return Promise.all(items.slice(0, 100).map(async item => {
    const goal = database ? goals.get(item.id) : (await getTaskEpisodeById(siteAgentId, item.episodeId)).episode?.goal;
    const text = (value: unknown) => typeof value === "string" ? redactSensitiveText(value).slice(0, 1000) : undefined;
    return { id: item.id, episodeId: item.episodeId, runId: item.runId,
      goal: text(goal) || "执行记录已不可用", status: item.status, attempts: item.attempts,
      createdAt: item.createdAt, updatedAt: item.updatedAt, nextAttemptAt: item.nextAttemptAt,
      lastError: text(item.lastError), disposition: text(item.result?.disposition),
      taskId: typeof item.result?.taskId === "string" ? item.result.taskId : undefined, capabilityId: typeof item.result?.capabilityId === "string" ? item.result.capabilityId : undefined, reason: text(item.result?.reason) };
  }));
}

/** Explicit operator retry preserves identity and total attempts (no duplicate tasks). */
export async function retryCapabilityExperienceIntake(siteAgentId: string, id: string) {
  const database = getD1Binding();
  const now = new Date().toISOString();
  if (!database) {
    const item = memoryOutbox().get(id);
    if (!item || item.siteAgentId !== siteAgentId || !["pending", "evidence-pending", "failed"].includes(item.status)) return false;
    memoryOutbox().set(id, { ...item, status: "pending", nextAttemptAt: undefined, updatedAt: now });
    return true;
  }
  await ensureSiteAgentV3Schema(database);
  const updated = await database.prepare(`UPDATE site_agent_v3_capability_experience_outbox
    SET status='pending',next_attempt_at=NULL,updated_at=? WHERE id=? AND site_agent_id=? AND status IN ('pending','evidence-pending','failed')`)
    .bind(now, id, siteAgentId).run();
  if (!updated.success) throw new Error(updated.error || "capability_experience_outbox_retry_failed");
  return Number(updated.meta?.changes || 0) > 0;
}

/** On site deletion: the experience outbox queue. */
export function capabilityExperienceOutboxDeletionStatements(database: D1DatabaseLike, siteAgentId: string): D1PreparedStatementLike[] {
  return [database.prepare(`DELETE FROM site_agent_v3_capability_experience_outbox WHERE site_agent_id=?`).bind(siteAgentId)];
}

export function deleteMemoryCapabilityExperienceOutbox(siteAgentId: string) {
  for (const [key, item] of memoryOutbox()) if (item.siteAgentId === siteAgentId) memoryOutbox().delete(key);
}
