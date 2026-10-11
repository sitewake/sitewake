import { getD1Binding, type D1ResultLike, type D1DatabaseLike, type D1PreparedStatementLike } from "./index";
import { ensureSiteAgentV3Schema, SITE_AGENT_V3_PAGE_OBSERVATION_MAX_PER_RUN } from "./site-agent-schema";
import { pageObservationSha256 } from "../lib/capability-center-v2/page-observation";
import { redactSensitivePageText, redactSensitiveUrl } from "../lib/site-knowledge/sensitive-data";
import type { AgentRun, PageAgentObservation, PageObservationRef } from "../lib/site-knowledge/protocol";

export const PAGE_OBSERVATION_MAX_BYTES = 96 * 1024;
export const PAGE_OBSERVATION_MAX_BATCH = 4;
export const PAGE_OBSERVATION_MAX_REQUEST_BYTES = 512 * 1024;
// Ten model responses may each return an action. The initial observation plus
// the terminal after-observation therefore requires eleven durable records.
export const PAGE_OBSERVATION_MAX_PER_RUN = SITE_AGENT_V3_PAGE_OBSERVATION_MAX_PER_RUN;
export const PAGE_OBSERVATION_MIN_RETENTION_DAYS = 14;
export const PAGE_OBSERVATION_MAX_RETENTION_DAYS = 90;

export type PageObservationTombstone = {
  schemaVersion: "page-agent-observation.tombstone.v1";
  id: string;
  siteAgentId: string;
  runId: string;
  episodeId: string;
  browserSessionId: string;
  documentId: string;
  pageEpoch: number;
  turnIndex: number;
  kind: "full" | "delta";
  baseObservationId?: string;
  sha256: string;
  producer: PageAgentObservation["producer"];
  capturedAt: string;
  expiresAt: string;
  purgedAt: string;
  cleanupReason: "retention-expired";
  omissionReason?: string;
};
type MemoryRoot = typeof globalThis & {
  __SITEWAKE_PAGE_OBSERVATIONS_V3__?: Map<string, PageAgentObservation>;
  __SITEWAKE_PAGE_OBSERVATION_TOMBSTONES_V3__?: Map<string, PageObservationTombstone>;
  __SITEWAKE_CAPABILITY_EXPERIENCE_OUTBOX_V3__?: Map<string, {
    siteAgentId: string;
    runId: string;
    episodeId: string;
    status: string;
  }>;
};
type ObservationRow = {
  id: string;
  siteAgentId: string;
  runId: string;
  episodeId: string;
  browserSessionId: string;
  documentId: string;
  pageEpoch: number;
  turnIndex: number;
  kind: PageAgentObservation["kind"];
  sha256: string;
  observationJson: string;
  purgedAt?: string;
};

const ACTIVE_OUTBOX_STATUSES = new Set(["pending", "evidence-pending", "processing"]);

function memoryObservations() {
  const root = globalThis as MemoryRoot;
  root.__SITEWAKE_PAGE_OBSERVATIONS_V3__ ||= new Map();
  return root.__SITEWAKE_PAGE_OBSERVATIONS_V3__;
}

function memoryTombstones() {
  const root = globalThis as MemoryRoot;
  root.__SITEWAKE_PAGE_OBSERVATION_TOMBSTONES_V3__ ||= new Map();
  return root.__SITEWAKE_PAGE_OBSERVATION_TOMBSTONES_V3__;
}

function hasActiveMemoryOutboxPin(observation: PageAgentObservation) {
  const outbox = (globalThis as MemoryRoot).__SITEWAKE_CAPABILITY_EXPERIENCE_OUTBOX_V3__;
  return outbox ? [...outbox.values()].some((item) => ACTIVE_OUTBOX_STATUSES.has(item.status)
    && item.siteAgentId === observation.siteAgentId
    && item.runId === observation.runId
    && item.episodeId === observation.episodeId) : false;
}

function bytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function validDate(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function safeUrl(value: string, run: AgentRun) {
  try { return run.scope.allowedOrigins.includes(new URL(value).origin); }
  catch { return false; }
}

function sanitizedObservationEvidence(observation: PageAgentObservation) {
  const cleanTarget = (target: PageAgentObservation["targets"][number]) => ({
    ...target,
    role: target.role === undefined ? undefined : redactSensitivePageText(target.role),
    accessibleName: target.accessibleName === undefined ? undefined : redactSensitivePageText(target.accessibleName),
    controlType: target.controlType === undefined ? undefined : redactSensitivePageText(target.controlType),
    formSignature: target.formSignature === undefined ? undefined : redactSensitivePageText(target.formSignature),
    hrefPath: target.hrefPath === undefined ? undefined : redactSensitiveUrl(target.hrefPath),
    nearbyText: target.nearbyText === undefined ? undefined : redactSensitivePageText(target.nearbyText),
  });
  return {
    ...observation,
    state: {
      url: redactSensitiveUrl(observation.state.url),
      title: redactSensitivePageText(observation.state.title),
      header: redactSensitivePageText(observation.state.header),
      content: redactSensitivePageText(observation.state.content),
      footer: redactSensitivePageText(observation.state.footer),
    },
    targets: observation.targets.map(cleanTarget),
  };
}

function validateShape(observation: PageAgentObservation) {
  const requiredValues = [observation.id, observation.siteAgentId, observation.runId, observation.episodeId,
    observation.browserSessionId, observation.documentId, observation.sha256, observation.capturedAt,
    observation.expiresAt, observation.state?.url, observation.producer?.controllerVersion];
  const stateValues = [observation.state?.title, observation.state?.header,
    observation.state?.content, observation.state?.footer];
  if (observation.schemaVersion !== "page-agent-observation.v1"
    || requiredValues.some((value) => typeof value !== "string" || !value || value.length > 200_000)
    || stateValues.some((value) => typeof value !== "string" || value.length > 200_000)
    || observation.producer.controller !== "@page-agent/page-controller"
    || observation.producer.projection !== "user-agent-adaptive"
    || !Number.isSafeInteger(observation.producer.projectionVersion) || observation.producer.projectionVersion < 1
    || !Number.isSafeInteger(observation.pageEpoch) || observation.pageEpoch < 1
    || !Number.isSafeInteger(observation.turnIndex) || observation.turnIndex < 0
    || !["full", "delta"].includes(observation.kind)
    || (observation.kind === "full" && observation.baseObservationId !== undefined)
    || (observation.kind === "delta" && !observation.baseObservationId)
    || !Array.isArray(observation.targets) || observation.targets.length > 500
    || new Set(observation.targets.map((target) => target.index)).size !== observation.targets.length
    || observation.targets.some((target) => !target || typeof target !== "object"
      || target.observationId !== observation.id
      || !Number.isSafeInteger(target.index) || target.index < 0
      || typeof target.semanticId !== "string" || !target.semanticId || target.semanticId.length > 500
      || [target.role, target.accessibleName, target.controlType, target.formSignature,
        target.hrefPath, target.nearbyText].some((value) => value !== undefined
          && (typeof value !== "string" || value.length > 2_000)))
    || (observation.omissionReason !== undefined
      && (typeof observation.omissionReason !== "string" || observation.omissionReason.length > 1_000))
    || !/^[a-f0-9]{64}$/u.test(observation.sha256)) throw new Error("page_observation_invalid");
}

async function validateObservation(run: AgentRun, observation: PageAgentObservation, nowMs = Date.now()) {
  validateShape(observation);
  if (bytes(observation) > PAGE_OBSERVATION_MAX_BYTES) throw new Error("page_observation_too_large");
  // Evidence hashes must describe the exact already-sanitized model input.
  // Never rewrite here: doing so would detach the durable bytes from the hash
  // and selector receipts. A non-idempotent sanitizer result is rejected.
  if (JSON.stringify(sanitizedObservationEvidence(observation)) !== JSON.stringify(observation)) {
    throw new Error("page_observation_sensitive_data");
  }
  if (run.controller !== "page-agent" || run.scope.kind !== "site"
    || run.scope.siteAgentId !== observation.siteAgentId || run.id !== observation.runId
    || run.activePort?.browserSessionId !== observation.browserSessionId
    || observation.pageEpoch !== run.pageEpoch
    || run.activePort?.documentId !== observation.documentId
    || !safeUrl(observation.state.url, run)) throw new Error("page_observation_authority_rejected");
  const captured = validDate(observation.capturedAt);
  const requestedExpires = validDate(observation.expiresAt);
  const runStartedAt = validDate(run.createdAt);
  if (captured === undefined || requestedExpires === undefined
    || captured > nowMs + 5 * 60_000
    || (runStartedAt !== undefined && captured < runStartedAt - 5 * 60_000)) throw new Error("page_observation_time_invalid");
  if (await pageObservationSha256(observation) !== observation.sha256) throw new Error("page_observation_hash_mismatch");
  // Retention is server-owned metadata (and excluded from the digest). This
  // avoids rejecting capturedAt+14d clients merely because upload took time.
  // Initial evidence retention is exactly server-now + 14 days. A browser may
  // propose neither a shorter diagnostic window nor the 90-day accepted-
  // experience extension; only the server-side authority path may extend it.
  const expiresAt = new Date(nowMs + PAGE_OBSERVATION_MIN_RETENTION_DAYS * 86_400_000).toISOString();
  return { ...observation, expiresAt };
}

function sameStoredObservation(row: ObservationRow, observation: PageAgentObservation) {
  return row.id === observation.id
    && row.siteAgentId === observation.siteAgentId
    && row.runId === observation.runId
    && row.episodeId === observation.episodeId
    && row.browserSessionId === observation.browserSessionId
    && row.documentId === observation.documentId
    && Number(row.pageEpoch) === observation.pageEpoch
    && Number(row.turnIndex) === observation.turnIndex
    && row.kind === observation.kind
    && row.sha256 === observation.sha256;
}

function pageObservationWriteError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("page_observation_conflict")) return new Error("page_observation_conflict");
  if (message.includes("page_observation_run_limit")) return new Error("page_observation_run_limit");
  return new Error(message || "page_observation_write_failed");
}

export async function appendPageAgentObservations(run: AgentRun, observations: PageAgentObservation[]) {
  if (!Array.isArray(observations) || !observations.length || observations.length > PAGE_OBSERVATION_MAX_BATCH) throw new Error("page_observation_batch_invalid");
  if (bytes({ siteAgentId: run.scope.kind === "site" ? run.scope.siteAgentId : "", observations }) > PAGE_OBSERVATION_MAX_REQUEST_BYTES) throw new Error("page_observation_request_too_large");
  const normalizedObservations: PageAgentObservation[] = [];
  for (const observation of observations) normalizedObservations.push(await validateObservation(run, observation));
  if (new Set(observations.map((observation) => observation.id)).size !== observations.length
    || new Set(observations.map((observation) => `${observation.pageEpoch}:${observation.turnIndex}`)).size !== observations.length) throw new Error("page_observation_batch_conflict");
  const database = getD1Binding();
  if (!database) {
    const store = memoryObservations();
    const existing = [...store.values()].filter((observation) => observation.runId === run.id);
    const tombstones = [...memoryTombstones().values()].filter((observation) => observation.runId === run.id);
    for (const observation of normalizedObservations) {
      const byId = store.get(observation.id);
      const tombstone = memoryTombstones().get(observation.id);
      const byTurn = [...existing, ...tombstones].find((item) => item.pageEpoch === observation.pageEpoch && item.turnIndex === observation.turnIndex);
      if ((byId && byId.sha256 !== observation.sha256) || (tombstone && tombstone.sha256 !== observation.sha256)
        || (byTurn && byTurn.id !== observation.id)) throw new Error("page_observation_conflict");
    }
    const newItems = normalizedObservations.filter((observation) => !store.has(observation.id) && !memoryTombstones().has(observation.id));
    if (existing.length + tombstones.length + newItems.length > PAGE_OBSERVATION_MAX_PER_RUN) throw new Error("page_observation_run_limit");
    newItems.forEach((observation) => store.set(observation.id, structuredClone(observation)));
    return { accepted: newItems.length, duplicates: normalizedObservations.length - newItems.length, persistence: "memory" as const };
  }

  await ensureSiteAgentV3Schema(database);
  const createdAt = new Date().toISOString();
  const statements = normalizedObservations.map((observation) => database.prepare(`INSERT OR IGNORE INTO site_agent_v3_page_observations
      (id,site_agent_id,run_id,episode_id,browser_session_id,document_id,page_epoch,turn_index,kind,sha256,observation_json,captured_at,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(observation.id, observation.siteAgentId, observation.runId, observation.episodeId,
    observation.browserSessionId, observation.documentId, observation.pageEpoch, observation.turnIndex, observation.kind,
    observation.sha256, JSON.stringify(observation), observation.capturedAt, observation.expiresAt, createdAt));
  // The insert guard performs conflict/count checks while holding the same-run
  // database lock. Keeping this read in the same batch prevents acknowledging
  // an ignored or rolled-back insert as accepted.
  statements.push(database.prepare(`SELECT id,site_agent_id AS siteAgentId,run_id AS runId,episode_id AS episodeId,
    browser_session_id AS browserSessionId,document_id AS documentId,page_epoch AS pageEpoch,turn_index AS turnIndex,
    kind,sha256,observation_json AS observationJson,purged_at AS purgedAt
    FROM site_agent_v3_page_observations WHERE run_id=? ORDER BY page_epoch,turn_index`).bind(run.id));
  let results: D1ResultLike<ObservationRow>[];
  try {
    results = await database.batch<ObservationRow>(statements);
  } catch (error) {
    throw pageObservationWriteError(error);
  }
  const failure = results.find((result) => !result.success);
  if (failure) throw pageObservationWriteError(failure.error || "page_observation_write_failed");
  const storedRows = results.at(-1)?.results || [];
  if (storedRows.length > PAGE_OBSERVATION_MAX_PER_RUN
    || normalizedObservations.some((observation) => {
      const stored = storedRows.find((row) => row.id === observation.id);
      return !stored || !sameStoredObservation(stored, observation);
    })) throw new Error("page_observation_write_failed");
  const accepted = results.slice(0, -1).reduce((total, result) => total + Number(result.meta?.changes || 0), 0);
  if (accepted < 0 || accepted > normalizedObservations.length) throw new Error("page_observation_write_failed");
  return { accepted, duplicates: normalizedObservations.length - accepted, persistence: "d1" as const };
}

export async function getPageAgentObservations(runId: string, options: { siteAgentId?: string; episodeId?: string; includeExpired?: boolean } = {}) {
  const now = new Date().toISOString();
  const database = getD1Binding();
  if (!database) return [...memoryObservations().values()]
    .filter((observation) => observation.runId === runId
      && (!options.siteAgentId || observation.siteAgentId === options.siteAgentId)
      && (!options.episodeId || observation.episodeId === options.episodeId)
      && (options.includeExpired || observation.expiresAt > now))
    .sort((left, right) => left.pageEpoch - right.pageEpoch || left.turnIndex - right.turnIndex);
  await ensureSiteAgentV3Schema(database);
  const clauses = ["run_id=?"]; const values: unknown[] = [runId];
  if (options.siteAgentId) { clauses.push("site_agent_id=?"); values.push(options.siteAgentId); }
  if (options.episodeId) { clauses.push("episode_id=?"); values.push(options.episodeId); }
  if (!options.includeExpired) { clauses.push("expires_at>?"); values.push(now); }
  clauses.push("purged_at IS NULL");
  const result = await database.prepare(`SELECT observation_json AS observationJson FROM site_agent_v3_page_observations WHERE ${clauses.join(" AND ")} ORDER BY page_epoch,turn_index LIMIT ${PAGE_OBSERVATION_MAX_PER_RUN}`).bind(...values).all<{ observationJson: string }>();
  if (!result.success) throw new Error(result.error || "page_observation_read_failed");
  return (result.results || []).map((row) => JSON.parse(row.observationJson) as PageAgentObservation);
}

export async function resolvePageObservationRefs(siteAgentId: string, runId: string, episodeId: string, refs: PageObservationRef[]) {
  const observations = await getPageAgentObservations(runId, { siteAgentId, episodeId });
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  return refs.map((ref) => byId.get(ref.id)).filter((observation): observation is PageAgentObservation => Boolean(observation));
}

export async function extendPageAgentObservationRetention(runId: string, episodeId: string, requestedExpiresAt: string) {
  const requested = validDate(requestedExpiresAt); if (requested === undefined) throw new Error("page_observation_retention_invalid");
  const now = Date.now();
  if (requested <= now) throw new Error("page_observation_retention_invalid");
  const expiresAt = new Date(Math.min(requested, now + PAGE_OBSERVATION_MAX_RETENTION_DAYS * 86_400_000)).toISOString();
  const database = getD1Binding();
  if (!database) {
    let extended = 0;
    for (const [id, observation] of memoryObservations()) if (observation.runId === runId && observation.episodeId === episodeId) {
      if (observation.expiresAt >= expiresAt) continue;
      memoryObservations().set(id, { ...observation, expiresAt }); extended += 1;
    }
    return { extended, persistence: "memory" as const };
  }
  await ensureSiteAgentV3Schema(database);
  const rows = await database.prepare(`SELECT id,observation_json AS observationJson FROM site_agent_v3_page_observations WHERE run_id=? AND episode_id=? AND purged_at IS NULL AND expires_at<?`).bind(runId, episodeId, expiresAt).all<{ id: string; observationJson: string }>();
  if (!rows.success) throw new Error(rows.error || "page_observation_extend_failed");
  if (!rows.results?.length) return { extended: 0, persistence: "d1" as const };
  const results = await database.batch((rows.results || []).map((row) => {
    const observation = { ...JSON.parse(row.observationJson) as PageAgentObservation, expiresAt };
    return database.prepare(`UPDATE site_agent_v3_page_observations SET expires_at=?,observation_json=? WHERE id=? AND expires_at<?`).bind(expiresAt, JSON.stringify(observation), row.id, expiresAt);
  }));
  const failure = results.find((result) => !result.success); if (failure) throw new Error(failure.error || "page_observation_extend_failed");
  return { extended: results.length, persistence: "d1" as const };
}

export async function purgeExpiredPageAgentObservations(now = new Date().toISOString()) {
  if (validDate(now) === undefined) throw new Error("page_observation_time_invalid");
  const database = getD1Binding();
  if (!database) {
    let purged = 0;
    for (const [id, observation] of memoryObservations()) if (observation.expiresAt <= now
      && !hasActiveMemoryOutboxPin(observation)) {
      const { state, targets, ...provenance } = observation;
      void state;
      void targets;
      memoryTombstones().set(id, {
        ...provenance,
        schemaVersion: "page-agent-observation.tombstone.v1",
        purgedAt: now,
        cleanupReason: "retention-expired",
      });
      memoryObservations().delete(id); purged += 1;
    }
    return { purged, persistence: "memory" as const };
  }
  await ensureSiteAgentV3Schema(database);
  const expired = await database.prepare(`SELECT id,site_agent_id AS siteAgentId,run_id AS runId,episode_id AS episodeId,
    browser_session_id AS browserSessionId,document_id AS documentId,page_epoch AS pageEpoch,turn_index AS turnIndex,
    kind,sha256,observation_json AS observationJson,captured_at AS capturedAt,expires_at AS expiresAt
    FROM site_agent_v3_page_observations observation
    WHERE observation.purged_at IS NULL AND observation.expires_at<=?
      -- Active work owns a retention pin for its whole Episode. Terminal
      -- failed/completed work is intentionally unpinned: failed evidence keeps
      -- only its original 14-day window, while Created extends before complete.
      AND NOT EXISTS (
        SELECT 1 FROM site_agent_v3_capability_experience_outbox outbox
        WHERE outbox.site_agent_id=observation.site_agent_id AND outbox.run_id=observation.run_id
          AND outbox.episode_id=observation.episode_id
          AND outbox.status IN ('pending','evidence-pending','processing')
      )
    ORDER BY observation.expires_at LIMIT 500`)
    .bind(now).all<{
      id: string; siteAgentId: string; runId: string; episodeId: string; browserSessionId: string;
      documentId: string; pageEpoch: number; turnIndex: number; kind: "full" | "delta"; sha256: string;
      observationJson: string; capturedAt: string; expiresAt: string;
  }>();
  if (!expired.success) throw new Error(expired.error || "page_observation_purge_failed");
  const expiredRows = expired.results || [];
  if (!expiredRows.length) return { purged: 0, persistence: "d1" as const };
  const results = await database.batch(expiredRows.map((row) => {
    let producer: PageAgentObservation["producer"] | undefined;
    try { producer = (JSON.parse(row.observationJson) as PageAgentObservation).producer; }
    catch { producer = undefined; }
    return database.prepare(`UPDATE site_agent_v3_page_observations
      SET observation_json=?,purged_at=?,cleanup_reason='retention-expired'
      WHERE id=? AND purged_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM site_agent_v3_capability_experience_outbox outbox
          WHERE outbox.site_agent_id=site_agent_v3_page_observations.site_agent_id
            AND outbox.run_id=site_agent_v3_page_observations.run_id
            AND outbox.episode_id=site_agent_v3_page_observations.episode_id
            AND outbox.status IN ('pending','evidence-pending','processing')
        )`).bind(JSON.stringify({
        schemaVersion: "page-agent-observation.tombstone.v1",
        id: row.id,
        siteAgentId: row.siteAgentId,
        runId: row.runId,
        episodeId: row.episodeId,
        browserSessionId: row.browserSessionId,
        documentId: row.documentId,
        pageEpoch: row.pageEpoch,
        turnIndex: row.turnIndex,
        kind: row.kind,
        baseObservationId: (JSON.parse(row.observationJson) as PageAgentObservation).baseObservationId,
        sha256: row.sha256,
        producer,
        capturedAt: row.capturedAt,
        expiresAt: row.expiresAt,
        purgedAt: now,
        cleanupReason: "retention-expired",
        omissionReason: (JSON.parse(row.observationJson) as PageAgentObservation).omissionReason,
      }), now, row.id);
  }));
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "page_observation_purge_failed");
  return { purged: results.reduce((total, result) => total + Number(result.meta?.changes || 0), 0), persistence: "d1" as const };
}

export function resetMemoryPageObservationStore() { memoryObservations().clear(); memoryTombstones().clear(); }

/** On site deletion: page observations and their tombstones. */
export function pageObservationDeletionStatements(database: D1DatabaseLike, siteAgentId: string): D1PreparedStatementLike[] {
  return [database.prepare(`DELETE FROM site_agent_v3_page_observations WHERE site_agent_id=?`).bind(siteAgentId)];
}

export function deleteMemoryPageObservationData(siteAgentId: string) {
  for (const [key, observation] of memoryObservations()) if (observation.siteAgentId === siteAgentId) memoryObservations().delete(key);
  for (const [key, tombstone] of memoryTombstones()) if (tombstone.siteAgentId === siteAgentId) memoryTombstones().delete(key);
}
