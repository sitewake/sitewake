import { capabilityManagementReleaseId, compileEpisode, materializeCandidateRelease } from "../lib/site-knowledge/compiler";
import { analyzeSiteProfile, deriveValidationInputFromEvidence, designCapabilityContract, designCapabilitySpec, explicitlyRequestsStructuredResult, inferResultArchetype, reviewSceneSemantics, sceneNeedsSemanticReview, siteProfileEvidenceHash, siteProfileNeedsSemanticReview } from "../lib/site-knowledge/model-analyzer";
import { evaluateBrowserRun } from "../lib/site-knowledge/release-gate";
import { validateProgramModuleSource } from "../lib/site-knowledge/authoring-bundler";
import { browserArtifactContentType } from "../lib/site-knowledge/browser-artifact-policy";
import {
  assertCapabilityInput,
  assertCapabilityOutput,
  assertSafeCapabilitySchema,
} from "../lib/site-knowledge/capability-output";
import {
  emptyRelease,
  normalizeAgentConfigForRelease,
  normalizeGoal,
  stableHash,
  uid,
  withAgentConfigDefaults,
  type AgentConfig,
  type AgentConfigPatch,
  type BrowserArtifact,
  type BrowserRun,
  type CapabilityBuildTask,
  type CapabilityRun,
  type CapabilityDefinition,
  type CapabilitySignal,
  type CapabilityRFC,
  type CapabilityEvent,
  type CapabilityFailureClass,
  type CapabilityProject,
  type CapabilityProjectDeletion,
  type CapabilityProjectDeletionHistoryKind,
  type CapabilityProjectDetail,
  type CapabilityRevision,
  type CapabilityRevisionImplementation,
  type RevisionReview,
  type CapabilitySpecDoc,
  type CapabilitySuppression,
  type PersistedAuthoringWorkspace,
  type DomReplayChunk,
  type ExecutionEnvironment,
  type ExecutionMode,
  type ClientDirective,
  type KnowledgeCandidate,
  type LegacyRunnerLeaseRef,
  type LearningJob,
  type LearningStageReceipt,
  type JsonValue,
  type LinkReference,
  type ModelInvocation,
  type NavigationTool,
  type NavigationToolDependencyPin,
  type OperationDefinition,
  type PageSnapshot,
  type ProgramModuleRef,
  type SiteAgentOverview,
  type SiteAgentReleaseV2,
  type SiteAgentSummary,
  type SiteConnection,
  type SiteProfile,
  type SitePreviewJob,
  type SitePreviewJobSummary,
  type SitePreviewMode,
  type SitePreviewResult,
  type SceneDefinition,
  type TaskEpisode,
  type TaskEpisodeSummary,
  type TaskSession,
  type TargetSpec,
  type TransitionObservation,
  type RunnerLease,
  type RunnerRegistration,
  type AuthoringGuidance,
  type CodexAuthoringEvent,
  type ContractChangeProposal,
  type TaskLaunch,
  type TaskLaunchMode,
  type ValidationJob,
} from "../lib/site-knowledge/protocol";
import { discoverInitialKnowledge, discoverTransitionKnowledge, mergeSceneEvidence } from "../lib/site-knowledge/discovery";
import {
  assertValidSiteKnowledgeDocument,
  countNewScenes,
  crawlReviewSnapshot,
  siteKnowledgeDocumentToRelease,
  type SiteKnowledgeDocument,
} from "../lib/site-knowledge/crawl-knowledge";
import { validateCrawlJobLimits } from "../lib/site-knowledge/crawl-limits";
import { applyEntryFeedback, verifyEntry } from "../lib/site-knowledge/entry-verification";
import { matchUrlTemplate } from "../lib/site-knowledge/url-scene";
import { knowledgeRevisionOf, rehydrateReleaseKnowledge, releaseEmbedsKnowledge, siteKnowledgeFromRelease, stripReleaseKnowledge, stripVolatile, type SiteKnowledge } from "../lib/site-knowledge/knowledge-model";
import { aggregateKnowledgeLinks } from "../lib/site-knowledge/link-aggregation";
import type {
  CrawlJob,
  CrawlJobLimits,
  CrawlJobSummary,
} from "../lib/site-knowledge/protocol";
import { canonicalizeReleaseKnowledge } from "../lib/site-knowledge/canonicalize";
import {
  classifyCapabilityFailure as classifyCapabilityFailureBase,
  isFormalCapability,
  pinCapabilityContract,
  pinStrengthenedCapabilityContract,
  projectCapabilityControl as projectCapabilityControlBase,
} from "../lib/site-knowledge/capability-control";
import { canonicalReleaseCapabilityProject } from "../lib/site-knowledge/capability-projection";
import { projectNavigationBuildTasks } from "../lib/site-knowledge/build-tasks";
import { classifyGoal } from "../lib/site-knowledge/navigation-tools";
import { exactCapabilityForGoal } from "../lib/site-knowledge/planner";
import { matchingCapabilitySuppression } from "../lib/site-knowledge/capability-suppression";
import { deriveCapabilityTaskTemplates } from "../lib/site-knowledge/site-knowledge";
import {
  capabilityContractFingerprint,
  capabilityProjectStableKey,
} from "../lib/site-knowledge/capability-identity";
import { buildContentPage, grepSiteContent, queryTermsAppear, stripSharedChrome, type ContentChunkRow, type ContentCoverage, type ContentPage, type ContentSource, type GrepResult } from "../lib/site-knowledge/content-index";
import type { PageObservation } from "../lib/site-knowledge/content-comparison";
import { siteHealth } from "../lib/site-knowledge/content-filter";
import { SiteAgentDataError, siteAgentDiagnosticFromError } from "../lib/site-knowledge/errors";

const CAPABILITY_FAILURE_CLASSES = new Set<CapabilityFailureClass>([
  "contract-incomplete",
  "target-grounding-failed",
  "extractor-mismatch",
  "verifier-mismatch",
  "transient-runtime",
  "duplicate-or-superseded",
  "runtime-regression",
  "insufficient-evidence",
]);

export function classifyCapabilityFailure(code = "", summary = ""): CapabilityFailureClass {
  const value = `${code} ${summary}`;
  if (/\b(?:net::ERR_[A-Z0-9_]+|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN)\b/i.test(value)) return "transient-runtime";
  if (CAPABILITY_FAILURE_CLASSES.has(code as CapabilityFailureClass)) return code as CapabilityFailureClass;
  return classifyCapabilityFailureBase(code, summary);
}

export function projectCapabilityControl(input: Parameters<typeof projectCapabilityControlBase>[0]) {
  const projected = projectCapabilityControlBase(input);
  const revisions = projected.revisions.map((revision) => {
    if (!revision.validation?.failureClass && !revision.validation?.summary) return revision;
    const failureClass = classifyCapabilityFailure(
      revision.validation.failureClass || "",
      revision.validation.summary || "",
    );
    return failureClass === revision.validation.failureClass
      ? revision
      : { ...revision, validation: { ...revision.validation, failureClass } };
  });
  const revisionById = new Map(revisions.map((revision) => [revision.id, revision] as const));
  return {
    ...projected,
    revisions,
    projects: projected.projects.map((project) => {
      const revision = project.latestRevisionId
        ? revisionById.get(project.latestRevisionId)
        : undefined;
      const failureClass = revision?.validation?.status === "failed"
        ? revision.validation.failureClass
        : project.health.failureClass;
      const retryValidation = revision?.stage === "validate"
        && revision.validation?.status === "failed"
        && (failureClass === "transient-runtime" || failureClass === "verifier-mismatch");
      if (!retryValidation && failureClass === project.health.failureClass) return project;
      return {
        ...project,
        status: project.status === "needs-guidance" && failureClass === "transient-runtime"
          ? "degraded" as const
          : project.status,
        health: {
          ...project.health,
          failureClass,
          recommendedAction: retryValidation
            ? "retry-validation" as const
            : project.health.recommendedAction,
        },
      };
    }),
  };
}
import { getArtifactBinding, getD1Binding, type D1DatabaseLike, type D1PreparedStatementLike } from "./index";
import { ensureSiteAgentV2Schema, ensureSiteAgentV3Schema } from "./site-agent-schema";
import type { CapabilityExperienceAuthority } from "../lib/capability-center-v2/experience-authority";
import {
  assertPinnedCapabilityVersion,
  resolveCurrentCapabilityVersion,
} from "./capability-runtime-store";
import {
  claimRunnerLease,
  completeRunnerLease,
  configuredRunnerLeaseAuthority,
  configuredRunnerProjectionMode,
  getRunnerLeaseMirror,
  getRunnerControlProjection,
  heartbeatRunnerInstance,
  registerRunnerInstance,
} from "./runner-control-store";
import {
  DEFAULT_RUNNER_POOL_ID,
  type RunnerLastError,
  type RunnerLeaseGrant,
  type RunnerRole,
  type RunnerWorkKind,
  type RunnerWorkloadKind,
} from "../lib/runner-control";

type MemoryAgent = {
  release: SiteAgentReleaseV2;
  /** Immutable Release snapshots retained for exact Revision execution in tests/local mode. */
  releaseHistory: SiteAgentReleaseV2[];
  connection?: SiteConnection;
  sessions: TaskSession[];
  observations: TransitionObservation[];
  episodes: TaskEpisode[];
  capabilitySignals: CapabilitySignal[];
  candidates: KnowledgeCandidate[];
  learningJobs: LearningJob[];
  validationJobs: ValidationJob[];
  browserRuns: BrowserRun[];
  artifacts: BrowserArtifact[];
  previewJobs: SitePreviewJob[];
  domReplayChunks: DomReplayChunk[];
  specDocs: CapabilitySpecDoc[];
  authoringWorkspaces: PersistedAuthoringWorkspace[];
  capabilityProjects: CapabilityProject[];
  capabilityCatalogMigrated: boolean;
  capabilityRevisions: CapabilityRevision[];
  revisionReviews: RevisionReview[];
  capabilityEvents: CapabilityEvent[];
  capabilitySuppressions: CapabilitySuppression[];
  authoringGuidance: AuthoringGuidance[];
  taskLaunches: Array<TaskLaunch & { tokenHash: string; claimKeyHash?: string }>;
  navigationBuildHeads: Map<string, string>;
  capabilityRuns: CapabilityRun[];
  capabilityRunRequests: Map<string, {
    requestHash: string;
    result: {
      run: CapabilityRun;
      launchUrl?: string;
      persistence: "memory";
    };
  }>;
  modelCalls: ModelInvocation[];
  /**
   * Widget presentation config, held beside the Release rather than inside it
   * so that recolouring the widget cannot mint a knowledge version. Undefined
   * on fixtures created before the split; reads fall back to the Release.
   */
  agentConfig?: AgentConfig;
  createdAt: string;
  updatedAt: string;
};

type MemoryRoot = typeof globalThis & {
  __SITEWAKE_SITE_AGENT_V2__?: Map<string, MemoryAgent>;
  __SITEWAKE_CAPABILITY_EXPERIENCE_OUTBOX_V3__?: Map<string, Record<string, unknown>>;
};
type SiteAgentListResult = { agents: SiteAgentSummary[]; persistence: "memory" | "d1" };

let siteAgentListCache: { value: SiteAgentListResult; expiresAt: number } | undefined;
let siteAgentListPending: Promise<SiteAgentListResult> | undefined;
let lastTaskLaunchSequence = 0;
let lastTaskLaunchSweepAt = 0;
const TASK_LAUNCH_PENDING_TTL_MS = 10 * 60_000;
// Keep the server lease longer than the SDK's 15-minute terminal-delivery
// retry budget. A control-plane outage must not let the watchdog discard a
// completed result before the browser can deliver its immutable receipt.
const TASK_LAUNCH_LEASE_TTL_MS = 20 * 60_000;
const memoryCapabilityRunLocks = new Map<string, Promise<void>>();
const memoryTaskLaunchLocks = new Map<string, Promise<void>>();

async function maybeExpireStaleTaskLaunches(database?: D1DatabaseLike) {
  const now = Date.now();
  if (now - lastTaskLaunchSweepAt < 30_000) return;
  lastTaskLaunchSweepAt = now;
  await expireStaleTaskLaunches({ database }).catch(() => undefined);
}

function nextTaskLaunchSequence() {
  const highResolutionNow = typeof performance === "undefined"
    ? Date.now() * 1_000
    : Math.floor((performance.timeOrigin + performance.now()) * 1_000);
  lastTaskLaunchSequence = Math.max(lastTaskLaunchSequence + 1, highResolutionNow);
  return lastTaskLaunchSequence;
}

/**
 * Console/read APIs may identify the runner and show lease freshness, but
 * runner data-plane credentials and fencing identity never leave this layer.
 * Keep this projection targeted so private runner responses still receive the
 * token they need to execute their leased work.
 */
export function projectPublicRunnerLeasedRecord<T extends { lease?: LegacyRunnerLeaseRef }>(record: T): T {
  if (!record.lease) return record;
  const { runnerId, leasedAt, expiresAt } = record.lease;
  return {
    ...record,
    lease: { runnerId, leasedAt, expiresAt },
  } as T;
}

function projectPublicCapabilityDetail(detail: CapabilityProjectDetail): CapabilityProjectDetail {
  return {
    ...detail,
    activeJob: detail.activeJob ? projectPublicRunnerLeasedRecord(detail.activeJob) : undefined,
    validationJobs: detail.validationJobs?.map(projectPublicRunnerLeasedRecord),
  };
}

function invalidateSiteAgentListCache() {
  siteAgentListCache = undefined;
}

function memoryStore() {
  const root = globalThis as MemoryRoot;
  root.__SITEWAKE_SITE_AGENT_V2__ ||= new Map();
  return root.__SITEWAKE_SITE_AGENT_V2__;
}

type ContentMemoryRoot = typeof globalThis & {
  __SITEWAKE_SITE_AGENT_V2_CONTENT__?: Map<string, Map<string, { contentHash: string; rows: ContentChunkRow[] }>>;
};

/**
 * The content index in memory mode. Every other store here already has this
 * branch; without it a database-less runtime (local module runs, tests) sees an
 * empty index and the agent can never answer from indexed page text — which
 * looks like a knowledge gap rather than a missing backend.
 */
function memoryContent(siteAgentId: string) {
  const root = globalThis as ContentMemoryRoot;
  root.__SITEWAKE_SITE_AGENT_V2_CONTENT__ ||= new Map();
  const store = root.__SITEWAKE_SITE_AGENT_V2_CONTENT__;
  const existing = store.get(siteAgentId);
  if (existing) return existing;
  const created = new Map<string, { contentHash: string; rows: ContentChunkRow[] }>();
  store.set(siteAgentId, created);
  return created;
}

function memoryContentChunks(siteAgentId: string) {
  return [...memoryContent(siteAgentId).values()].flatMap((page) => page.rows);
}

function initialAgent(siteAgentId: string, profile?: Partial<SiteProfile>): MemoryAgent {
  const now = new Date().toISOString();
  const release = emptyRelease(siteAgentId, now);
  release.profile = {
    ...release.profile,
    ...profile,
    vocabulary: profile?.vocabulary || {},
    suggestedGoals: profile?.suggestedGoals || [],
  };
  return { release, releaseHistory: [release], sessions: [], observations: [], episodes: [], capabilitySignals: [], candidates: [], learningJobs: [], validationJobs: [], browserRuns: [], artifacts: [], previewJobs: [], domReplayChunks: [], specDocs: [], authoringWorkspaces: [], capabilityProjects: [], capabilityCatalogMigrated: false, capabilityRevisions: [], revisionReviews: [], capabilityEvents: [], capabilitySuppressions: [], authoringGuidance: [], taskLaunches: [], navigationBuildHeads: new Map(), capabilityRuns: [], capabilityRunRequests: new Map(), modelCalls: [], createdAt: now, updatedAt: now };
}

type RunnerMemoryRoot = typeof globalThis & { __SITEWAKE_SITE_AGENT_RUNNERS__?: Map<string, RunnerRegistration> };
function runnerMemoryStore() {
  const root = globalThis as RunnerMemoryRoot;
  root.__SITEWAKE_SITE_AGENT_RUNNERS__ ||= new Map();
  return root.__SITEWAKE_SITE_AGENT_RUNNERS__;
}

function siteAgentNotFound(siteAgentId: string) {
  // message equals code: many catch blocks in this repo branch on `error.message` as the error code.
  return new SiteAgentDataError(
    "site_agent_not_found",
    "site_agent_not_found",
    "site_agent_lookup",
    { status: 404, retryable: false, cause: siteAgentId },
  );
}

/**
 * A site is born in exactly one place: `createSiteAgent`. Every other read/write
 * throws `site_agent_not_found` for an unknown site instead of creating an empty
 * one — otherwise a stale script still embedded after deletion would resurrect the
 * site as an empty shell the moment it reports an observation.
 */
function memoryAgent(siteAgentId: string) {
  const found = memoryStore().get(siteAgentId);
  if (!found) throw siteAgentNotFound(siteAgentId);
  // Hot-reload/process fixtures created before Release history existed still
  // need an immutable snapshot registry.
  found.releaseHistory ||= [found.release];
  found.previewJobs ||= [];
  found.capabilityRunRequests ||= new Map();
  if (!found.releaseHistory.some((release) => release.id === found.release.id)) {
    found.releaseHistory.push(found.release);
  }
  return found;
}

/** Only `createSiteAgent` may bring a memory-mode site into existence. */
function memoryAgentOrCreate(siteAgentId: string, profile?: Partial<SiteProfile>) {
  const store = memoryStore();
  const found = store.get(siteAgentId);
  if (found) return memoryAgent(siteAgentId);
  const created = initialAgent(siteAgentId, profile);
  store.set(siteAgentId, created);
  return created;
}

function setMemoryRelease(agent: MemoryAgent, release: SiteAgentReleaseV2) {
  agent.releaseHistory ||= [];
  for (const snapshot of [agent.release, release]) {
    const existing = agent.releaseHistory.find((candidate) => candidate.id === snapshot.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(snapshot)) {
      throw new Error("memory_release_immutable_conflict");
    }
    if (!existing) agent.releaseHistory.push(snapshot);
  }
  agent.release = release;
  return release;
}

/**
 * Activates a Capability Center prepared Release in the in-memory runtime.
 * D1 callers include the Release switch in their own multi-table batch so the
 * Capability, Version, Task and active Release change as one publication unit.
 */
export function activatePreparedSiteAgentReleaseInMemory(
  siteAgentId: string,
  expectedReleaseId: string,
  release: SiteAgentReleaseV2,
) {
  if (getD1Binding()) throw new Error("prepared_release_memory_only");
  const agent = memoryAgent(siteAgentId);
  if (agent.release.id !== expectedReleaseId) throw new Error("site_agent_release_conflict");
  setMemoryRelease(agent, release);
  agent.updatedAt = release.createdAt;
  return release;
}

function memoryReleaseById(agent: MemoryAgent, releaseId: string) {
  if (agent.release.id === releaseId) return agent.release;
  return (agent.releaseHistory || []).find((release) => release.id === releaseId);
}

function safeId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

async function all<T>(database: D1DatabaseLike, sql: string, values: unknown[] = []) {
  const result = await database.prepare(sql).bind(...values).all<T>();
  if (!result.success) throw new Error(result.error || "site_agent_v2_query_failed");
  return result.results || [];
}

/** Only `createSiteAgent` may bring a D1 site into existence. See `memoryAgent`. */
async function createD1AgentIfMissing(database: D1DatabaseLike, siteAgentId: string, profile?: Partial<SiteProfile>) {
  const now = new Date().toISOString();
  const release = emptyRelease(siteAgentId, now);
  release.profile = {
    ...release.profile,
    ...profile,
    vocabulary: profile?.vocabulary || {},
    suggestedGoals: profile?.suggestedGoals || [],
  };
  const results = await database.batch([
    database.prepare(`INSERT OR IGNORE INTO site_agent_v2_agents
      (id, profile_json, active_release_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(siteAgentId, JSON.stringify(release.profile), release.id, now, now),
    database.prepare(`INSERT OR IGNORE INTO site_agent_v2_releases
      (id, site_agent_id, version, content_hash, release_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(release.id, siteAgentId, 0, release.contentHash, JSON.stringify(release), now),
  ]);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "site_agent_v2_bootstrap_failed");
}

async function requireD1Agent(database: D1DatabaseLike, siteAgentId: string) {
  const rows = await all<{ id: string }>(database, `SELECT id FROM site_agent_v2_agents WHERE id=? LIMIT 1`, [siteAgentId]);
  if (!rows[0]) throw siteAgentNotFound(siteAgentId);
}

export async function createSiteAgent(input: {
  id?: string;
  name?: string;
  description?: string;
  url?: string;
  visibility?: SiteProfile["visibility"];
  profile?: Partial<SiteProfile>;
}) {
  const rawUrl = input.url?.trim();
  const entryUrl = rawUrl ? new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`).toString() : undefined;
  const allowedOrigins = entryUrl ? [new URL(entryUrl).origin] : [];
  const host = entryUrl ? new URL(entryUrl).hostname.replace(/^www\./, "") : "";
  const id = safeId(input.id || host || input.name || `site-${Date.now().toString(36)}`) || `site-${Date.now().toString(36)}`;
  const profile: SiteProfile = {
    name: input.name?.trim() || host || id,
    // Left empty rather than seeded with a sentence: the console already renders a
    // localised placeholder for a blank description, and a stored default in one
    // language shadowed it for every reader of the other.
    description: input.description?.trim() || "",
    semanticSource: "program",
    visibility: input.visibility || "production",
    entryUrl,
    allowedOrigins,
    vocabulary: {},
    suggestedGoals: [],
    fieldEvidence: {
      name: { source: "program", confidence: 0.35, evidence: entryUrl ? [entryUrl] : [], updatedAt: new Date().toISOString() },
      description: { source: "program", confidence: 0.2, evidence: [], updatedAt: new Date().toISOString() },
    },
    ...input.profile,
  };
  const registeredRelease = (current: SiteAgentReleaseV2) => {
    const nextProfile: SiteProfile = {
      ...current.profile,
      ...input.profile,
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      ...(entryUrl ? { entryUrl, allowedOrigins } : {}),
      ...(input.visibility ? { visibility: input.visibility } : {}),
    };
    if (JSON.stringify(nextProfile) === JSON.stringify(current.profile)) return current;
    const createdAt = new Date().toISOString();
    const next = {
      ...current,
      id: `${id}:release:${current.version + 1}`,
      version: current.version + 1,
      createdAt,
      profile: nextProfile,
    };
    const hashable = { ...next, contentHash: undefined, knowledgeRevision: undefined };
    return { ...next, contentHash: stableHash(JSON.stringify(hashable)) };
  };
  const database = getD1Binding();
  if (!database) {
    const existing = memoryStore().get(id);
    if (!existing) memoryAgentOrCreate(id, profile);
    else {
      setMemoryRelease(existing, registeredRelease(existing.release));
      existing.updatedAt = existing.release.createdAt;
    }
    const persisted = memoryStore().get(id)!;
    return { siteAgentId: id, profile: persisted.release.profile, persistence: "memory" as const };
  }
  await ensureSiteAgentV2Schema(database);
  const current = await d1Release(database, id);
  if (!current) await createD1AgentIfMissing(database, id, profile);
  else {
    const release = registeredRelease(current);
    if (release.id !== current.id) {
      const results = await database.batch([
        database.prepare(`INSERT INTO site_agent_v2_releases (id,site_agent_id,version,content_hash,release_json,created_at) VALUES (?,?,?,?,?,?)`)
          .bind(release.id, id, release.version, release.contentHash, JSON.stringify(release), release.createdAt),
        database.prepare(`UPDATE site_agent_v2_agents SET profile_json=?,active_release_id=?,updated_at=? WHERE id=? AND active_release_id=?`)
          .bind(JSON.stringify(release.profile), release.id, release.createdAt, id, current.id),
      ]);
      const failure = results.find((result) => !result.success);
      if (failure) throw new Error(failure.error || "site_agent_registration_update_failed");
    }
  }
  invalidateSiteAgentListCache();
  const persisted = await d1Release(database, id);
  return { siteAgentId: id, profile: persisted?.profile || profile, persistence: "d1" as const };
}

export async function siteAgentExists(siteAgentId: string) {
  const id = siteAgentId.trim();
  if (!id) return false;
  const database = getD1Binding();
  if (!database) return memoryStore().has(id);
  try {
    await ensureSiteAgentV2Schema(database);
    const rows = await all<{ id: string }>(database, `SELECT id FROM site_agent_v2_agents WHERE id=? LIMIT 1`, [id]);
    return rows.length > 0;
  } catch (error) {
    throw new SiteAgentDataError(
      "site_agent_database_failed",
      "Site Agent lookup failed.",
      "site_agent_lookup",
      { cause: error },
    );
  }
}

/**
 * Management-console visibility is a resource policy, separate from the
 * session check.  Only production agents are exposed by the management list;
 * sandbox/system agents remain addressable by their own runtime paths but are
 * forbidden from this production overview surface.
 */
export async function siteAgentAccess(siteAgentId: string): Promise<"allowed" | "forbidden" | "not_found"> {
  const id = siteAgentId.trim();
  if (!id) return "not_found";
  const database = getD1Binding();
  if (!database) {
    const agent = memoryStore().get(id);
    if (!agent) return "not_found";
    return (agent.release.profile.visibility || "production") === "production" ? "allowed" : "forbidden";
  }
  try {
    await ensureSiteAgentV2Schema(database);
    const rows = await all<{ profileJson: string }>(database, `SELECT profile_json AS profileJson FROM site_agent_v2_agents WHERE id=? LIMIT 1`, [id]);
    if (!rows[0]) return "not_found";
    const profile = JSON.parse(rows[0].profileJson) as SiteProfile;
    return (profile.visibility || "production") === "production" ? "allowed" : "forbidden";
  } catch (error) {
    throw new SiteAgentDataError(
      "site_agent_database_failed",
      "Site Agent access lookup failed.",
      "site_agent_lookup",
      { cause: error },
    );
  }
}

type ReleaseRow = { releaseJson: string };

function canonicalRelease(release: SiteAgentReleaseV2) {
  const normalized = canonicalizeReleaseKnowledge(release);
  if (JSON.stringify(normalized) === JSON.stringify(release)) return normalized;
  const hashable = { ...normalized, contentHash: undefined, knowledgeRevision: undefined };
  return { ...normalized, contentHash: stableHash(JSON.stringify(hashable)) };
}

/**
 * Widget config lives on the agent row, so a read that hands a Release to a
 * caller has to pick it up from there. `null` means this site predates the
 * backfill: the value still embedded in the Release JSON is used instead.
 */
function storedAgentConfig(row: { agentConfigJson?: string | null } | undefined) {
  if (!row?.agentConfigJson) return undefined;
  try { return JSON.parse(row.agentConfigJson) as unknown; } catch { return undefined; }
}

/**
 * Attaches the live widget config to an already-hashed Release.
 *
 * Order matters: the content hash is computed while the Release still carries
 * only its own embedded config, so the hash covers knowledge alone and a
 * recolour cannot change it. Existing rows keep hashing exactly as they did
 * before the split, which is what keeps the stored `content_hash` column and a
 * recomputed hash in agreement.
 */
function withLiveAgentConfig(hashed: SiteAgentReleaseV2, stored: unknown) {
  if (stored === undefined) return hashed;
  return { ...hashed, agentConfig: normalizeAgentConfigForRelease(hashed, stored) };
}

async function d1Release(database: D1DatabaseLike, siteAgentId: string) {
  const rows = await all<ReleaseRow & { agentConfigJson?: string | null }>(database, `SELECT r.release_json AS releaseJson, a.agent_config_json AS agentConfigJson
    FROM site_agent_v2_agents a JOIN site_agent_v2_releases r ON r.id = a.active_release_id
    WHERE a.id = ? LIMIT 1`, [siteAgentId]);
  if (!rows[0]) return null;
  const release = withAgentConfigDefaults(JSON.parse(rows[0].releaseJson) as SiteAgentReleaseV2);
  const hashed = canonicalRelease(await rehydrateRelease(database, siteAgentId, release));
  return withLiveAgentConfig(hashed, storedAgentConfig(rows[0]));
}

async function d1ReleaseById(database: D1DatabaseLike, siteAgentId: string, releaseId: string) {
  // The config join is deliberate: presentation is no longer part of the
  // versioned snapshot, so even a historical Release reports the config that
  // is in effect now rather than whatever was current when it was published.
  const rows = await all<ReleaseRow & { agentConfigJson?: string | null }>(database, `SELECT r.release_json AS releaseJson, a.agent_config_json AS agentConfigJson
    FROM site_agent_v2_releases r LEFT JOIN site_agent_v2_agents a ON a.id = r.site_agent_id
    WHERE r.id=? AND r.site_agent_id=? LIMIT 1`, [releaseId, siteAgentId]);
  if (!rows[0]) return null;
  const release = withAgentConfigDefaults(JSON.parse(rows[0].releaseJson) as SiteAgentReleaseV2);
  const hydrated = await rehydrateRelease(database, siteAgentId, release, {
    canonicalizeEmbedded: false,
  });
  return withLiveAgentConfig(hydrated, storedAgentConfig(rows[0]));
}

/**
 * A Revision may only pin bytes that can be loaded again by Release id.
 *
 * Active-release reads intentionally canonicalize older storage shapes in
 * memory. That compatibility projection must never be pinned directly: the
 * immutable row can still contain the pre-compiler graph. At every Revision
 * authoring boundary, publish the canonical graph as a fresh Release first.
 */
async function immutableActiveReleaseForRevision(
  database: D1DatabaseLike,
  siteAgentId: string,
): Promise<SiteAgentReleaseV2> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const rows = await all<{ releaseId: string; releaseJson: string }>(
      database,
      `SELECT r.id AS releaseId,r.release_json AS releaseJson
         FROM site_agent_v2_agents a
         JOIN site_agent_v2_releases r ON r.id=a.active_release_id
        WHERE a.id=? LIMIT 1`,
      [siteAgentId],
    );
    const row = rows[0];
    if (!row) throw new Error("site_agent_release_missing");
    const stored = withAgentConfigDefaults(
      JSON.parse(row.releaseJson) as SiteAgentReleaseV2,
    );
    const hydrated = await rehydrateRelease(
      database,
      siteAgentId,
      stored,
    );
    const initiallyCanonical = canonicalRelease(hydrated);
    const knowledgeRevision = await persistKnowledgeRevision(
      database,
      siteAgentId,
      siteKnowledgeFromRelease(initiallyCanonical),
    );
    const canonical = canonicalRelease({
      ...initiallyCanonical,
      knowledgeRevision,
    });
    const exact = await d1ReleaseById(database, siteAgentId, row.releaseId);
    if (exact && JSON.stringify(exact) === JSON.stringify(canonical)) {
      return exact;
    }

    const maxRows = await all<{ maxVersion: number | string | null }>(
      database,
      `SELECT MAX(version) AS maxVersion
         FROM site_agent_v2_releases
        WHERE site_agent_id=?`,
      [siteAgentId],
    );
    const version = Number(maxRows[0]?.maxVersion ?? canonical.version) + 1;
    const createdAt = new Date().toISOString();
    const identityHash = stableHash(JSON.stringify({
      sourceReleaseId: row.releaseId,
      sourceContentHash: canonical.contentHash,
      knowledgeRevision,
    }));
    const snapshotBase = canonicalRelease({
      ...canonical,
      id: `${siteAgentId}:release:${version}:canonical-${identityHash}`,
      version,
      createdAt,
      knowledgeRevision,
    });
    const hashable = {
      ...snapshotBase,
      contentHash: undefined,
      knowledgeRevision: undefined,
    };
    const snapshot: SiteAgentReleaseV2 = {
      ...snapshotBase,
      contentHash: stableHash(JSON.stringify(hashable)),
    };
    const results = await database.batch([
      database.prepare(`INSERT OR IGNORE INTO site_agent_v2_releases
        (id,site_agent_id,version,content_hash,release_json,created_at)
        VALUES (?,?,?,?,?,?)`)
        .bind(
          snapshot.id,
          siteAgentId,
          snapshot.version,
          snapshot.contentHash,
          JSON.stringify(snapshot),
          snapshot.createdAt,
        ),
      database.prepare(`UPDATE site_agent_v2_agents
        SET profile_json=?,active_release_id=?,updated_at=?
        WHERE id=? AND active_release_id=?
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_releases
             WHERE id=? AND site_agent_id=? AND version=? AND content_hash=?
          )`)
        .bind(
          JSON.stringify(snapshot.profile),
          snapshot.id,
          snapshot.createdAt,
          siteAgentId,
          row.releaseId,
          snapshot.id,
          siteAgentId,
          snapshot.version,
          snapshot.contentHash,
        ),
    ]);
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "canonical_release_snapshot_failed");
    if (Number(results[1]?.meta?.changes || 0) === 1) {
      invalidateSiteAgentListCache();
      return snapshot;
    }
  }
  throw new Error("canonical_release_snapshot_contended");
}

/**
 * Phase C: the knowledge table is the single source of truth for scenes/links.
 * A stored release may be slim; here we rehydrate it. An older release may
 * still embed knowledge, so reads derive and index it without rewriting the
 * immutable Release row.
 */
async function rehydrateRelease(
  database: D1DatabaseLike,
  siteAgentId: string,
  release: SiteAgentReleaseV2,
  options: { canonicalizeEmbedded?: boolean } = {},
): Promise<SiteAgentReleaseV2> {
  // Reads index embedded knowledge and, on the canonicalizing (active) path, may
  // compact an already-canonical row IN PLACE to slim form via slimStoredRelease —
  // a byte-safe rewrite (strip→rehydrate reproduces the served object, content_hash
  // unchanged). Pinned reads (canonicalizeEmbedded:false) never compact, so a Run's
  // pinned bytes stay byte-for-byte.
  const embeds = releaseEmbedsKnowledge(release);
  try {
    if (embeds) {
      if (options.canonicalizeEmbedded === false) {
        // A Run pinned this historical Release, so its execution graph is the
        // published snapshot—not an input to today's compiler. Indexing the
        // embedded knowledge is safe, but the object handed to the Runner must
        // preserve the stored operations/capabilities/hash byte-for-byte.
        try {
          await persistKnowledgeRevision(
            database,
            siteAgentId,
            siteKnowledgeFromRelease(release),
          );
        } catch {
          // The embedded snapshot is self-contained and remains executable.
        }
        return release;
      }
      // Canonicalize the embedded release ONCE so scenes AND the execution graph
      // (operations/targets/capabilities) are remapped into one canonical scene-id
      // space. Deriving knowledge from canonical scenes while keeping raw operations
      // would leave the ops pointing at pre-cluster ids the second canonicalize can
      // no longer remap — dangling refs + a diverged contentHash.
      const canonical = canonicalizeReleaseKnowledge(release);
      const derived = siteKnowledgeFromRelease(canonical);
      let revision: number;
      // Persist under its KnowledgeRevision (reused when the material content is
      // unchanged, so a config/capability-only publish never mints a new revision).
      // If indexing fails, the embedded release remains fully readable.
      try { revision = await persistKnowledgeRevision(database, siteAgentId, derived); }
      catch { return rehydrateReleaseKnowledge(canonical, derived); }
      const knowledge = { ...derived, version: revision };
      const resolved = { ...canonical, knowledgeRevision: revision };
      // Lazy Phase C compaction: now that knowledge is durable, rewrite THIS row to
      // slim form — but ONLY when it is already canonical, so a pinned (byte-preserving)
      // read of this id keeps seeing identical bytes and content_hash stays valid.
      // slimStoredRelease double-checks with a strip→rehydrate round-trip and is a
      // no-op on any risk or write failure.
      if (JSON.stringify(canonical) === JSON.stringify(release)) {
        await slimStoredRelease(database, siteAgentId, resolved, knowledge);
      }
      return rehydrateReleaseKnowledge(resolved, knowledge);
    }
    // Slim release: read its knowledge by the revision pointer, not release.version
    // (a config-only release points at an EARLIER revision that has the row).
    const revision = knowledgeRevisionOf(release);
    const knowledge = await readSiteKnowledgeRow(database, siteAgentId, revision);
    // No stored row (un-migrated DB, or a lost row): return the slim release as-is —
    // never invent/persist empty knowledge over a real (elsewhere) revision.
    if (!knowledge) return release;
    return rehydrateReleaseKnowledge({ ...release, knowledgeRevision: revision }, knowledge);
  } catch {
    // Knowledge table unavailable (e.g. an un-migrated DB). An embedded release is
    // fully usable as-is; a slim release keeps whatever it has — we never invent scenes.
    return release;
  }
}

/**
 * Phase C lazy compaction: rewrite an embedded Release row to slim form in place —
 * scenes/links now live in the knowledge table (persisted by the caller), so the row
 * keeps only a knowledgeRevision pointer plus execution/config. Byte-safe: writes only
 * when strip→rehydrate reproduces `release` exactly, and `stripReleaseKnowledge`
 * preserves contentHash so the row's content_hash column stays valid without touching
 * it. A no-op on any mismatch or write failure — the embedded row stays fully readable.
 * Pinned reads never call this (they take the canonicalizeEmbedded:false branch), so
 * their bytes are untouched.
 */
async function slimStoredRelease(
  database: D1DatabaseLike,
  siteAgentId: string,
  release: SiteAgentReleaseV2,
  knowledge: SiteKnowledge,
): Promise<void> {
  const stripped = stripReleaseKnowledge(release, knowledge);
  if (JSON.stringify(rehydrateReleaseKnowledge(stripped, knowledge)) !== JSON.stringify(release)) return;
  try {
    await database.prepare(
      `UPDATE site_agent_v2_releases SET release_json=? WHERE id=? AND site_agent_id=?`,
    ).bind(JSON.stringify(stripped), release.id, siteAgentId).run();
  } catch {
    // Best-effort compaction; the embedded row remains valid if the write fails.
  }
}

/**
 * Compatibility indexer for older embedded Releases. It persists their
 * knowledge rows without rewriting immutable Release records. The legacy
 * function name and response shape remain for rolling-upgrade callers.
 */
/**
 * Copies each site's widget config out of its active Release and into the
 * agent row.
 *
 * Reads already fall back to the embedded value, so this is not what makes the
 * split correct — it is what stops every future read from depending on that
 * fallback. Idempotent: a site whose column is already populated is skipped,
 * so the job can be re-run safely.
 */
export async function backfillAgentConfigColumns(database?: D1DatabaseLike): Promise<{ scanned: number; migrated: number; skipped: number }> {
  const db = database || getD1Binding();
  if (!db) return { scanned: 0, migrated: 0, skipped: 0 };
  await ensureSiteAgentV2Schema(db);
  const rows = await all<{ id: string; releaseJson: string; agentConfigJson?: string | null }>(db, `
    SELECT a.id AS id, r.release_json AS releaseJson, a.agent_config_json AS agentConfigJson
      FROM site_agent_v2_agents a
      JOIN site_agent_v2_releases r ON r.id = a.active_release_id`);
  let migrated = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.agentConfigJson) { skipped += 1; continue; }
    let agentConfig;
    try {
      const release = JSON.parse(row.releaseJson) as SiteAgentReleaseV2;
      agentConfig = normalizeAgentConfigForRelease(release, (release as Partial<SiteAgentReleaseV2>).agentConfig);
    } catch { skipped += 1; continue; }
    const result = await db
      .prepare(`UPDATE site_agent_v2_agents SET agent_config_json=?,agent_config_updated_at=? WHERE id=? AND agent_config_json IS NULL`)
      .bind(JSON.stringify(agentConfig), new Date().toISOString(), row.id)
      .run();
    if (!result.success) throw new Error(result.error || "agent_config_backfill_failed");
    migrated += 1;
  }
  if (migrated) invalidateSiteAgentListCache();
  return { scanned: rows.length, migrated, skipped };
}

export async function batchSlimReleases(database?: D1DatabaseLike): Promise<{ scanned: number; migrated: number; skipped: number; failed: number }> {
  // Kept as a compatibility entry point: this now indexes embedded knowledge
  // only. It intentionally does not mutate historical Release JSON.
  const db = database || getD1Binding();
  if (!db) return { scanned: 0, migrated: 0, skipped: 0, failed: 0 };
  await ensureSiteAgentV2Schema(db);
  // Ordered by version so revisions are assigned in publish order (deterministic +
  // dense): the earliest material state of a site takes the lower revision.
  // Keep the scan memory-bounded: release_json may contain multi-megabyte DOM
  // evidence, so loading every Release payload at once can exhaust the control
  // plane during a production migration. Identities are small; each payload is
  // fetched, processed, and released before the next row.
  const identities = await all<{ id: string; siteAgentId: string }>(db,
    `SELECT id, site_agent_id AS siteAgentId FROM site_agent_v2_releases ORDER BY site_agent_id, version, id`);
  let migrated = 0, skipped = 0, failed = 0;
  for (const identity of identities) {
    const rows = await all<{ releaseJson: string }>(db,
      `SELECT release_json AS releaseJson FROM site_agent_v2_releases WHERE id=? AND site_agent_id=? LIMIT 1`,
      [identity.id, identity.siteAgentId]);
    const row = rows[0];
    if (!row) { failed++; continue; }
    let release: SiteAgentReleaseV2;
    try { release = withAgentConfigDefaults(JSON.parse(row.releaseJson) as SiteAgentReleaseV2); } catch { failed++; continue; }
    if (!releaseEmbedsKnowledge(release)) { skipped++; continue; }
    try {
      const canonical = canonicalizeReleaseKnowledge(release);
      const derived = siteKnowledgeFromRelease(canonical);
      // Dedup by material content: releases with identical scenes/links (e.g. a
      // config publish) collapse onto ONE shared revision instead of a row each.
      await persistKnowledgeRevision(db, identity.siteAgentId, derived); // persist FIRST — never slim an unstored release
      migrated++;
    } catch { failed++; }
  }
  return { scanned: identities.length, migrated, skipped, failed };
}

/**
 * Explicit, idempotent upgrade for legacy Capability catalogs.
 *
 * This deliberately stays outside every read path. Operators invoke the
 * maintenance endpoint once after an upgrade; ordinary list/detail/overview
 * requests remain observational even when a legacy database has no epoch
 * marker yet.
 */
export async function batchCanonicalizeCapabilityCatalogs(
  database?: D1DatabaseLike,
): Promise<{ scanned: number; migrated: number; failed: number }> {
  const db = database || getD1Binding();
  if (!db) {
    const siteAgentIds = [...memoryStore().keys()];
    let migrated = 0;
    let failed = 0;
    for (const siteAgentId of siteAgentIds) {
      try {
        ensureMemoryCanonicalCapabilityCatalog(siteAgentId);
        migrated += 1;
      } catch {
        failed += 1;
      }
    }
    return { scanned: siteAgentIds.length, migrated, failed };
  }
  await ensureSiteAgentV2Schema(db);
  const rows = await all<{ id: string }>(
    db,
    "SELECT id FROM site_agent_v2_agents ORDER BY id",
  );
  let migrated = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await ensureCanonicalCapabilityCatalog(db, row.id);
      migrated += 1;
    } catch {
      failed += 1;
    }
  }
  return { scanned: rows.length, migrated, failed };
}

export async function getActiveSiteAgentRelease(siteAgentId: string) {
  const database = getD1Binding();
  if (!database) {
    const agent = memoryAgent(siteAgentId);
    // Hash the knowledge first, attach the live config after — same ordering as
    // the D1 path, so a recolour cannot move the content hash here either.
    return { release: withLiveAgentConfig(canonicalRelease(agent.release), agent.agentConfig), persistence: "memory" as const };
  }
  await ensureSiteAgentV2Schema(database);
  let release = await d1Release(database, siteAgentId);
  if (!release) {
    await requireD1Agent(database, siteAgentId);
    release = emptyRelease(siteAgentId);
  }
  return { release: release || emptyRelease(siteAgentId), persistence: "d1" as const };
}

export async function getSiteAgentReleaseById(siteAgentId: string, releaseId: string) {
  const normalizedReleaseId = releaseId.trim();
  if (!normalizedReleaseId) throw new Error("site_agent_release_id_required");
  const database = getD1Binding();
  if (!database) {
    const agent = memoryAgent(siteAgentId);
    const release = memoryReleaseById(agent, normalizedReleaseId);
    if (!release) throw new Error("site_agent_release_not_found");
    return { release: withLiveAgentConfig(release, agent.agentConfig), persistence: "memory" as const };
  }
  await ensureSiteAgentV2Schema(database);
  const release = await d1ReleaseById(database, siteAgentId, normalizedReleaseId);
  if (!release) throw new Error("site_agent_release_not_found");
  return { release, persistence: "d1" as const };
}

/**
 * Updates widget presentation config in place.
 *
 * This deliberately does NOT publish a Release. Presentation is not knowledge:
 * a Release is an immutable snapshot whose id derives from `version`, so the
 * old "insert a new Release to change a colour" path made every recolour mint
 * a knowledge version — which then failed the execution pin a queued task had
 * already taken. Only the current value is kept; there is no config history.
 */
export async function updateSiteAgent(siteAgentId: string, patch: { agentConfig?: AgentConfigPatch | Partial<AgentConfig> }) {
  const now = new Date().toISOString();
  const database = getD1Binding();
  if (!database) {
    const agent = memoryAgent(siteAgentId);
    // Normalize against the release so generated defaults still resolve, then
    // keep the result beside the release instead of inside it.
    agent.agentConfig = normalizeAgentConfigForRelease(
      withAgentConfigDefaults(agent.release, agent.agentConfig),
      patch.agentConfig,
    );
    agent.updatedAt = now;
    return { release: withAgentConfigDefaults(agent.release, agent.agentConfig), persistence: "memory" as const };
  }
  await ensureSiteAgentV2Schema(database);
  await requireD1Agent(database, siteAgentId);
  const current = await d1Release(database, siteAgentId) || emptyRelease(siteAgentId);
  const agentConfig = normalizeAgentConfigForRelease(current, patch.agentConfig);
  const result = await database
    .prepare(`UPDATE site_agent_v2_agents SET agent_config_json=?,agent_config_updated_at=?,updated_at=? WHERE id=?`)
    .bind(JSON.stringify(agentConfig), now, now, siteAgentId)
    .run();
  if (!result.success) throw new Error(result.error || "site_agent_v2_update_failed");
  invalidateSiteAgentListCache();
  return { release: { ...current, agentConfig }, persistence: "d1" as const };
}

type ConnectionRow = { siteAgentId: string; origin: string; url: string; title: string; heading: string; connectedAt: string; lastSeenAt: string };
type EpisodeSummaryRow = {
  id: string; taskSessionId: string; mode: TaskEpisode["mode"]; goal: string; capabilityId?: string; inputJson: string;
  outcomeJson: string; startedAt: string; endedAt: string; startUrl: string; startTitle: string; startHeading: string;
  endUrl: string; endTitle: string; endHeading: string;
};
type PostgresEpisodeRow = {
  id: string; taskSessionId: string; mode: TaskEpisode["mode"]; episodeJson: string;
  startedAt: string; endedAt: string;
};
type OverviewEpisodeRow = EpisodeSummaryRow | PostgresEpisodeRow;
type SessionRow = { sessionJson: string };
type CandidateRow = { candidateJson: string };
type LearningJobRow = { jobJson: string };
type ValidationJobRow = { jobJson: string };
type RevisionReviewRow = { reviewJson: string };
type BrowserRunRow = { runJson: string };
type ArtifactRow = { artifactJson: string };
type RunnerRow = { runnerJson: string };
type ModelInvocationRow = { invocationJson: string };

export async function recordModelInvocation(invocation: ModelInvocation) {
  const database = getD1Binding();
  if (!database) {
    const agent = memoryAgent(invocation.siteAgentId);
    agent.modelCalls = [...agent.modelCalls.filter((item) => item.id !== invocation.id), invocation].slice(-500);
    return invocation;
  }
  await ensureSiteAgentV2Schema(database);
  const result = await database.prepare(`INSERT OR REPLACE INTO site_agent_v2_model_invocations
    (id,site_agent_id,learning_job_id,stage,status,invocation_json,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(invocation.id, invocation.siteAgentId, invocation.learningJobId || null, invocation.stage, invocation.status, JSON.stringify(invocation), invocation.startedAt, invocation.endedAt || null).run();
  if (!result.success) throw new Error(result.error || "model_invocation_save_failed");
  return invocation;
}

function activeFormalCapabilityCount(capabilities: CapabilityDefinition[]) {
  return capabilities.filter((capability) =>
    capability.status === "available" && isFormalCapability(capability)).length;
}

function summary(agent: MemoryAgent, id: string): SiteAgentSummary {
  return {
    id,
    profile: agent.release.profile,
    connection: agent.connection,
    activeReleaseVersion: agent.release.version,
    sceneCount: agent.release.scenes.length,
    capabilityCount: activeFormalCapabilityCount(agent.release.capabilities),
    taskCount: new Set(agent.episodes.map((episode) => episode.taskSessionId)).size,
    episodeCount: agent.episodes.length,
    updatedAt: agent.updatedAt,
  };
}

function presentCandidates(candidates: KnowledgeCandidate[]) {
  const current = candidates.filter((candidate) => Boolean(candidate.authoring) && candidate.authoring?.reuseDecision !== "conversation-only");
  const byIntent = new Map<string, KnowledgeCandidate>();
  for (const candidate of current.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const key = candidate.authoring?.intentKey || candidate.normalizedGoal;
    if (!byIntent.has(key)) byIntent.set(key, candidate);
  }
  return [...byIntent.values()];
}

function episodeSummary(episode: TaskEpisode): TaskEpisodeSummary {
  return {
    id: episode.id, taskSessionId: episode.taskSessionId, mode: episode.mode, goal: episode.goal, capabilityId: episode.capabilityId, input: episode.input,
    startedAt: episode.startedAt, endedAt: episode.endedAt, outcome: episode.outcome,
    startSnapshot: { url: episode.startSnapshot.url, title: episode.startSnapshot.title, heading: episode.startSnapshot.heading },
    endSnapshot: { url: episode.endSnapshot.url, title: episode.endSnapshot.title, heading: episode.endSnapshot.heading },
  };
}

function episodeSummaryFromRow(row: EpisodeSummaryRow): TaskEpisodeSummary {
  return {
    id: row.id, taskSessionId: row.taskSessionId, mode: row.mode, goal: row.goal, capabilityId: row.capabilityId || undefined,
    input: JSON.parse(row.inputJson || "{}") as Record<string, JsonValue>,
    startedAt: row.startedAt, endedAt: row.endedAt,
    outcome: JSON.parse(row.outcomeJson) as TaskEpisode["outcome"],
    startSnapshot: { url: row.startUrl, title: row.startTitle || "", heading: row.startHeading || "" },
    endSnapshot: { url: row.endUrl, title: row.endTitle || "", heading: row.endHeading || "" },
  };
}

function episodeSummaryFromPostgresRow(row: PostgresEpisodeRow): TaskEpisodeSummary {
  // Keep the raw JSON out of the SQL projection. A legacy row may contain
  // malformed Unicode that PostgreSQL rejects during a `::jsonb` cast; parsing
  // here lets the overview skip only that row and retain a diagnostic.
  const episode = JSON.parse(row.episodeJson) as TaskEpisode;
  return {
    id: row.id,
    taskSessionId: row.taskSessionId,
    mode: row.mode,
    goal: episode.goal,
    capabilityId: episode.capabilityId,
    input: episode.input,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    outcome: episode.outcome,
    startSnapshot: { url: episode.startSnapshot.url, title: episode.startSnapshot.title, heading: episode.startSnapshot.heading },
    endSnapshot: { url: episode.endSnapshot.url, title: episode.endSnapshot.title, heading: episode.endSnapshot.heading },
  };
}

function mergeScenes(current: SceneDefinition[], incoming: SceneDefinition[]) {
  const result = new Map(current.map((scene) => [scene.id, scene]));
  for (const scene of incoming) result.set(scene.id, result.has(scene.id) ? mergeSceneEvidence(result.get(scene.id)!, scene) : scene);
  return [...result.values()];
}

/**
 * After a complete crawl, retire scenes that were **never verified and did not
 * reappear this time**.
 *
 * Scenes used to only grow: redirect aliases, soft-404 link targets and duplicates
 * left by early versions stayed "unverified" forever; after 43 releases the coverage
 * always looked incomplete, and the console promised "confirmed after re-crawl" —
 * which a re-crawl never actually did.
 *
 * Only `referenced` scenes (never actually visited) are retired. **Verified and
 * observed scenes are always kept**: a single crawl may have missed them because of
 * budget, throttling or a transient failure, and deleting them would lose real knowledge.
 */
export function retireUnseenReferencedScenes(
  current: SceneDefinition[],
  incoming: SceneDefinition[],
  deadUrls: string[] = [],
  unreachableUrls: string[] = [],
): SceneDefinition[] {
  const incomingIds = new Set(incoming.map((scene) => scene.id));
  const dead = new Set(deadUrls);
  const unreachable = [...unreachableUrls];
  return current.filter((scene) => {
    // Link targets that were fetched but never came back. The "did not reappear"
    // rule above cannot catch them: they reappear as links every time, so they stay
    // `referenced` forever and the console keeps saying "pending verification" while a
    // re-crawl changes nothing. A production site's /security and /visitor were
    // exactly this — two links on an anti-bot page that never resolve.
    //
    // Positive evidence like deadUrls, so likewise only `referenced` is retired:
    // verified and observed scenes are kept, one failed fetch may just be a timeout.
    const referencedOnly = (scene.evidenceStatus || scene.lifecycle) === "referenced"
      && scene.directEntry !== "verified"
      && !(scene.evidence?.observedUrls || []).length;
    if (referencedOnly && unreachable.length && scene.urlTemplates.length) {
      const everyTemplateUnreachable = scene.urlTemplates.every((template) =>
        unreachable.some((url) => matchUrlTemplate(template, url) !== null));
      if (everyTemplateUnreachable) return false;
    }
    // URLs actually visited this time and confirmed as error pages — **positive
    // evidence**, so even scenes long marked "verified" are retired. /topic in
    // production was left this way: it returns 404 but was promoted to verified before
    // status-code error detection existed, and nobody cleaned it up. Positive evidence
    // cannot over-delete: an incomplete crawl only leaves URLs off this list, it never
    // adds them wrongly.
    const observed = scene.evidence?.observedUrls || [];
    if (observed.length && observed.every((url) => dead.has(url))) return false;
    const status = scene.evidenceStatus || scene.lifecycle;
    const neverVerified = status === "referenced" && scene.directEntry !== "verified"
      && !observed.length;
    return !(neverVerified && !incomingIds.has(scene.id));
  });
}

function mergeLinkReferences(current: LinkReference[], incoming: LinkReference[]) {
  const result = new Map(current.map((reference) => [reference.id, reference]));
  for (const reference of incoming) {
    const previous = result.get(reference.id);
    result.set(reference.id, previous ? {
      ...previous,
      landmark: previous.landmark === "unknown" ? reference.landmark : previous.landmark,
      observations: Math.max(previous.observations, reference.observations),
      firstSeenAt: previous.firstSeenAt < reference.firstSeenAt ? previous.firstSeenAt : reference.firstSeenAt,
      lastSeenAt: previous.lastSeenAt > reference.lastSeenAt ? previous.lastSeenAt : reference.lastSeenAt,
    } : reference);
  }
  return [...result.values()];
}

function mergeOperations(current: OperationDefinition[], incoming: OperationDefinition[]) {
  const result = new Map(current.map((operation) => [operation.id, operation]));
  for (const operation of incoming) {
    const previous = result.get(operation.id);
    if (!previous) { result.set(operation.id, operation); continue; }
    const implementations = new Map(previous.implementations.map((implementation) => [implementation.id, implementation]));
    for (const implementation of operation.implementations) {
      const known = implementations.get(implementation.id);
      implementations.set(implementation.id, known ? {
        ...known,
        successes: Math.max(known.successes, implementation.successes),
        failures: Math.max(known.failures, implementation.failures),
        sourceEpisodeIds: [...new Set([...known.sourceEpisodeIds, ...implementation.sourceEpisodeIds])],
      } : implementation);
    }
    result.set(operation.id, {
      ...previous,
      ...operation,
      status: previous.status === "published" || operation.status === "published" ? "published" : previous.status === "verified" || operation.status === "verified" ? "verified" : "candidate",
      implementations: [...implementations.values()],
    });
  }
  return [...result.values()];
}

function mergeCapabilities(current: CapabilityDefinition[], incoming: CapabilityDefinition[]) {
  const result = new Map(current.map((capability) => [capability.id, capability]));
  for (const capability of incoming) {
    const previous = result.get(capability.id);
    result.set(capability.id, previous ? {
      ...previous,
      ...capability,
      aliases: [...new Set([...previous.aliases, ...capability.aliases])],
      status: previous.status === "available" || capability.status === "available" ? "available" : previous.status === "improving" || capability.status === "improving" ? "improving" : capability.status,
      confidence: Math.max(previous.confidence, capability.confidence),
    } : capability);
  }
  return [...result.values()];
}

function mergeTargets(current: TargetSpec[], incoming: TargetSpec[]) {
  const result = new Map(current.map((target) => [target.id, target]));
  for (const target of incoming) {
    const previous = result.get(target.id);
    result.set(target.id, previous ? {
      ...previous,
      ...target,
      sceneIds: [...new Set([...previous.sceneIds, ...target.sceneIds])],
      accessibleNames: [...new Set([...previous.accessibleNames, ...target.accessibleNames])],
      locatorVariants: [...new Map([...previous.locatorVariants, ...target.locatorVariants].map((locator) => [locator.id, locator])).values()],
    } : target);
  }
  return [...result.values()];
}

function isLegacyLinkOperation(operation: OperationDefinition) {
  return !operation.evidenceSource && operation.status === "candidate" && operation.implementations.every((implementation) => implementation.successes === 0 && implementation.sourceEpisodeIds.length === 0);
}

function migrateLegacyLinkReferences(operations: OperationDefinition[]): LinkReference[] {
  return operations.filter((operation) => isLegacyLinkOperation(operation) && operation.fromSceneId !== "*" && operation.toSceneId).map((operation) => ({
    id: `legacy_link_${operation.id}`,
    fromSceneId: operation.fromSceneId,
    toSceneId: operation.toSceneId!,
    label: operation.name.replace(/^(打开|前往|进入)/, ""),
    href: "",
    landmark: "unknown",
    observations: 1,
    firstSeenAt: operation.updatedAt,
    lastSeenAt: operation.updatedAt,
  }));
}

export async function listSiteAgents(): Promise<SiteAgentListResult> {
  const database = getD1Binding();
  if (!database) return { agents: [...memoryStore()].filter(([, agent]) => (agent.release.profile.visibility || "production") === "production").map(([id, agent]) => summary(agent, id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), persistence: "memory" };
  if (siteAgentListCache && siteAgentListCache.expiresAt > Date.now()) return siteAgentListCache.value;
  if (siteAgentListPending) return siteAgentListPending;
  siteAgentListPending = loadD1SiteAgentList(database);
  try {
    const value = await siteAgentListPending;
    siteAgentListCache = { value, expiresAt: Date.now() + 10_000 };
    return value;
  } finally {
    siteAgentListPending = undefined;
  }
}

async function loadD1SiteAgentList(database: D1DatabaseLike): Promise<SiteAgentListResult> {
  const reader = database.withSession?.() || database;
  type ListRow = { id: string; profileJson: string; updatedAt: string; releaseVersion: number; sceneCount: number; capabilityCount: number; origin?: string; url?: string; title?: string; heading?: string; connectedAt?: string; lastSeenAt?: string; episodeCount: number; taskCount: number };
  if (database.dialect === "postgres") {
    await ensureSiteAgentV2Schema(database);
    const rows = await all<{ id: string; profileJson: string; releaseJson: string; updatedAt: string; origin?: string; url?: string; title?: string; heading?: string; connectedAt?: string; lastSeenAt?: string; episodeCount: number; taskCount: number }>(reader, `
      SELECT a.id,a.profile_json AS "profileJson",r.release_json AS "releaseJson",a.updated_at AS "updatedAt",
        c.origin,c.url,c.title,c.heading,c.connected_at AS "connectedAt",c.last_seen_at AS "lastSeenAt",
        (SELECT COUNT(*) FROM site_agent_v2_episodes e WHERE e.site_agent_id=a.id) AS "episodeCount",
        (SELECT COUNT(DISTINCT e.task_session_id) FROM site_agent_v2_episodes e WHERE e.site_agent_id=a.id) AS "taskCount"
      FROM site_agent_v2_agents a JOIN site_agent_v2_releases r ON r.id=a.active_release_id
      LEFT JOIN site_agent_v2_connections c ON c.site_agent_id=a.id ORDER BY a.updated_at DESC`);
    return { agents: rows.flatMap((row) => {
      // Read the stored fields directly. Re-canonicalizing here would misbehave on
      // a slim (scene-stripped) row: canonicalize's scene-dependent operation filter
      // sees no scenes and mis-counts capabilities. The stored capabilities are
      // already canonical (slimmed from the canonical release), so count them as-is —
      // scene-independent, matching the SQLite branch.
      const raw = JSON.parse(row.releaseJson) as SiteAgentReleaseV2 & { sceneCount?: number };
      const profile = raw.profile;
      if ((profile.visibility || "production") !== "production") return [];
      return [{ id: row.id, profile, connection: row.origin ? { siteAgentId: row.id, origin: row.origin, url: row.url!, title: row.title!, heading: row.heading!, connectedAt: row.connectedAt!, lastSeenAt: row.lastSeenAt! } : undefined, activeReleaseVersion: raw.version, sceneCount: raw.sceneCount ?? raw.scenes.length, capabilityCount: activeFormalCapabilityCount(raw.capabilities), taskCount: Number(row.taskCount || 0), episodeCount: Number(row.episodeCount || 0), updatedAt: row.updatedAt }];
    }), persistence: "d1" };
  }
  const query = (source: D1DatabaseLike) => all<ListRow>(source, `
    SELECT a.id, a.profile_json AS profileJson, a.updated_at AS updatedAt,
      json_extract(r.release_json, '$.version') AS releaseVersion,
      COALESCE(json_extract(r.release_json, '$.sceneCount'), json_array_length(r.release_json, '$.scenes')) AS sceneCount,
      (SELECT COUNT(*) FROM json_each(r.release_json, '$.capabilities') capability
        WHERE json_extract(capability.value, '$.status') = 'available'
          AND json_extract(capability.value, '$.id') NOT LIKE 'navigation-tool:%'
          AND json_extract(capability.value, '$.id') NOT LIKE 'capability_shared_nav_%'
      ) AS capabilityCount,
      c.origin, c.url, c.title, c.heading, c.connected_at AS connectedAt, c.last_seen_at AS lastSeenAt,
      (SELECT COUNT(*) FROM site_agent_v2_episodes e WHERE e.site_agent_id = a.id) AS episodeCount,
      (SELECT COUNT(DISTINCT e.task_session_id) FROM site_agent_v2_episodes e WHERE e.site_agent_id = a.id) AS taskCount
    FROM site_agent_v2_agents a
    JOIN site_agent_v2_releases r ON r.id = a.active_release_id
    LEFT JOIN site_agent_v2_connections c ON c.site_agent_id = a.id
    ORDER BY a.updated_at DESC`);
  let rows: ListRow[];
  try {
    rows = await query(reader);
  } catch (error) {
    if (!String(error).toLowerCase().includes("no such table")) throw error;
    await ensureSiteAgentV2Schema(database);
    rows = await query(database);
  }
  return {
    agents: rows.flatMap((row) => {
      const profile = JSON.parse(row.profileJson) as SiteProfile;
      const visibility = profile.visibility || "production";
      if (visibility !== "production") return [];
      const connection = row.origin ? {
        siteAgentId: row.id, origin: row.origin, url: row.url!, title: row.title!, heading: row.heading!, connectedAt: row.connectedAt!, lastSeenAt: row.lastSeenAt!,
      } : undefined;
      return [{ id: row.id, profile: { ...profile, visibility }, connection, activeReleaseVersion: Number(row.releaseVersion || 0), sceneCount: Number(row.sceneCount || 0), capabilityCount: Number(row.capabilityCount || 0), taskCount: Number(row.taskCount || 0), episodeCount: Number(row.episodeCount || 0), updatedAt: row.updatedAt }];
    }),
    persistence: "d1",
  };
}

async function siteRunnerServiceProjection(siteAgentId: string) {
  try {
    const configured = configuredRunnerProjectionMode({ siteAgentId });
    return await getRunnerControlProjection({
      siteAgentId,
      mode: configured === "hidden" ? "hidden" : "aggregate",
    });
  } catch (error) {
    throw new SiteAgentDataError(
      "site_agent_runner_service_failed",
      "Runner service projection failed.",
      "site_agent_overview_runner",
      { cause: error },
    );
  }
}

async function siteRunnerServiceForOverview(siteAgentId: string) {
  try {
    return { runnerService: await siteRunnerServiceProjection(siteAgentId) };
  } catch (error) {
    const diagnostic = siteAgentDiagnosticFromError(
      error,
      "site_agent_runner_service_failed",
      "site_agent_overview_runner",
    );
    // Runner is an optional management projection. Keep the site overview
    // available and expose a stable diagnostic instead of hiding the failure
    // behind the generic overview error.
    console.error("site_agent_overview_dependency_failed", {
      siteAgentId,
      code: diagnostic.code,
      phase: diagnostic.phase,
      message: error instanceof Error ? error.message : String(error),
    });
    return { diagnostic };
  }
}

export async function getSiteAgentOverview(siteAgentId: string): Promise<{ overview: SiteAgentOverview & { knowledge: SiteKnowledge; contentCoverage: ContentCoverage; diagnostics?: ReturnType<typeof siteAgentDiagnosticFromError>[] }; persistence: "memory" | "d1" }> {
  const database = getD1Binding();
  if (!database) {
    const agent = memoryAgent(siteAgentId);
    const now = new Date().toISOString();
    const activeSessions = agent.sessions.filter((item) => ["running", "validating"].includes(item.status) && item.expiresAt > now);
    const runnerResult = await siteRunnerServiceForOverview(siteAgentId);
    // Memory mode has no content index → empty coverage.
    const emptyCoverage: ContentCoverage = { indexedPages: 0, totalChunks: 0, totalChars: 0, scenesTotal: agent.release.scenes.length, emptyPages: [] };
    // The console settings form reads its current values off activeRelease, so
    // the live config has to be attached here too — the Release itself no
    // longer carries it.
    const activeRelease = withLiveAgentConfig(agent.release, agent.agentConfig);
    const previews = [...agent.previewJobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { overview: { ...summary(agent, siteAgentId), activeRelease, knowledge: siteKnowledgeFromRelease(agent.release), contentCoverage: emptyCoverage, recentEpisodes: [...agent.episodes].reverse().slice(0, 30).map(episodeSummary), activeSessions, candidates: presentCandidates(agent.candidates), learningJobs: [...agent.learningJobs].reverse().slice(0, 30).map(projectPublicRunnerLeasedRecord), validationJobs: [...agent.validationJobs].reverse().slice(0, 30).map(projectPublicRunnerLeasedRecord), browserRuns: [...agent.browserRuns].reverse().slice(0, 30), artifacts: [...agent.artifacts].reverse().slice(0, 60), runners: [], runnerService: runnerResult.runnerService, sitePreview: previews.find((item) => item.status === "succeeded")?.result, sitePreviewJob: previews[0] ? publicPreviewJob(previews[0]) : undefined, diagnostics: runnerResult.diagnostic ? [runnerResult.diagnostic] : undefined }, persistence: "memory" };
  }
  let release: SiteAgentReleaseV2;
  try {
    await ensureSiteAgentV2Schema(database);
    let persistedRelease = await d1Release(database, siteAgentId);
    if (!persistedRelease) {
      await requireD1Agent(database, siteAgentId);
      persistedRelease = emptyRelease(siteAgentId);
    }
    release = persistedRelease || emptyRelease(siteAgentId);
  } catch (error) {
    if (error instanceof SiteAgentDataError) throw error;
    throw new SiteAgentDataError(
      "site_agent_database_failed",
      "Site Agent overview release could not be read.",
      "site_agent_overview_database",
      { cause: error },
    );
  }
  const now = new Date().toISOString();
  let rows: [ConnectionRow[], OverviewEpisodeRow[], SessionRow[], CandidateRow[], LearningJobRow[], ValidationJobRow[], BrowserRunRow[], ArtifactRow[], SitePreviewJobRow[], { episodeCount: number; taskCount: number }[], Awaited<ReturnType<typeof siteRunnerServiceForOverview>>];
  try {
    const episodeQuery = database.dialect === "postgres"
      ? all<PostgresEpisodeRow>(database, `SELECT id, task_session_id AS taskSessionId, mode, episode_json AS episodeJson,
          started_at AS startedAt, ended_at AS endedAt
          FROM site_agent_v2_episodes WHERE site_agent_id = ? ORDER BY ended_at DESC LIMIT 30`, [siteAgentId])
      : all<EpisodeSummaryRow>(database, `SELECT id, task_session_id AS taskSessionId, mode,
        json_extract(episode_json, '$.goal') AS goal,
        json_extract(episode_json, '$.capabilityId') AS capabilityId,
        json_extract(episode_json, '$.input') AS inputJson,
        json_extract(episode_json, '$.outcome') AS outcomeJson,
        started_at AS startedAt, ended_at AS endedAt,
        json_extract(episode_json, '$.startSnapshot.url') AS startUrl,
        json_extract(episode_json, '$.startSnapshot.title') AS startTitle,
        json_extract(episode_json, '$.startSnapshot.heading') AS startHeading,
        json_extract(episode_json, '$.endSnapshot.url') AS endUrl,
        json_extract(episode_json, '$.endSnapshot.title') AS endTitle,
        json_extract(episode_json, '$.endSnapshot.heading') AS endHeading
        FROM site_agent_v2_episodes WHERE site_agent_id = ? ORDER BY ended_at DESC LIMIT 30`, [siteAgentId]);
    rows = await Promise.all([
      all<ConnectionRow>(database, `SELECT site_agent_id AS siteAgentId, origin, url, title, heading, connected_at AS connectedAt, last_seen_at AS lastSeenAt FROM site_agent_v2_connections WHERE site_agent_id = ? LIMIT 1`, [siteAgentId]),
      episodeQuery,
      all<SessionRow>(database, `SELECT session_json AS sessionJson FROM site_agent_v2_sessions WHERE site_agent_id = ? AND status IN ('running','validating') AND expires_at > ? ORDER BY updated_at DESC LIMIT 20`, [siteAgentId, now]),
      all<CandidateRow>(database, `SELECT candidate_json AS candidateJson FROM site_agent_v2_candidates WHERE site_agent_id = ? ORDER BY updated_at DESC LIMIT 30`, [siteAgentId]),
      all<LearningJobRow>(database, `SELECT result_json AS jobJson FROM site_agent_v2_learning_jobs WHERE site_agent_id = ? ORDER BY updated_at DESC LIMIT 30`, [siteAgentId]),
      all<ValidationJobRow>(database, `SELECT job_json AS jobJson FROM site_agent_v2_validation_jobs WHERE site_agent_id = ? ORDER BY updated_at DESC LIMIT 30`, [siteAgentId]),
      all<BrowserRunRow>(database, `SELECT run_json AS runJson FROM site_agent_v2_browser_runs WHERE site_agent_id = ? ORDER BY started_at DESC LIMIT 30`, [siteAgentId]),
      all<ArtifactRow>(database, `SELECT artifact_json AS artifactJson FROM site_agent_v2_artifacts WHERE site_agent_id = ? ORDER BY created_at DESC LIMIT 60`, [siteAgentId]),
      all<SitePreviewJobRow>(database, `SELECT job_json AS jobJson FROM site_agent_v2_preview_jobs WHERE site_agent_id=? ORDER BY created_at DESC LIMIT 20`, [siteAgentId]),
      all<{ episodeCount: number; taskCount: number }>(database, `SELECT COUNT(*) AS episodeCount, COUNT(DISTINCT task_session_id) AS taskCount FROM site_agent_v2_episodes WHERE site_agent_id = ?`, [siteAgentId]),
      siteRunnerServiceForOverview(siteAgentId),
    ]);
  } catch (error) {
    if (error instanceof SiteAgentDataError) throw error;
    throw new SiteAgentDataError("site_agent_database_failed", "Site Agent overview data could not be read.", "site_agent_overview_database", { cause: error });
  }
  const [connections, episodes, sessions, candidates, learningJobs, validationJobs, browserRuns, artifacts, previewRows, counts, runnerResult] = rows;
  const diagnostics = runnerResult.diagnostic ? [runnerResult.diagnostic] : [];
  const recentEpisodes: TaskEpisodeSummary[] = [];
  for (const row of episodes) {
    try {
      recentEpisodes.push("episodeJson" in row ? episodeSummaryFromPostgresRow(row) : episodeSummaryFromRow(row));
    } catch (error) {
      const diagnostic = siteAgentDiagnosticFromError(
        new SiteAgentDataError("site_agent_episode_data_invalid", "Site Agent episode data is invalid.", "site_agent_episode", { cause: error, retryable: false }),
        "site_agent_episode_data_invalid",
        "site_agent_episode",
      );
      diagnostics.push(diagnostic);
      console.error("site_agent_overview_episode_skipped", {
        siteAgentId,
        episodeId: row.id,
        code: diagnostic.code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const connection = connections[0];
  const agentSummary: SiteAgentSummary = {
    id: siteAgentId,
    profile: release.profile,
    connection,
    activeReleaseVersion: release.version,
    sceneCount: release.scenes.length,
    capabilityCount: activeFormalCapabilityCount(release.capabilities),
    taskCount: Number(counts[0]?.taskCount || 0),
    episodeCount: Number(counts[0]?.episodeCount || 0),
    updatedAt: connection?.lastSeenAt || release.createdAt,
  };
  let activeSessions: TaskSession[];
  let knowledgeCandidates: KnowledgeCandidate[];
  let projectedLearningJobs: LearningJob[];
  let projectedValidationJobs: ValidationJob[];
  let projectedBrowserRuns: BrowserRun[];
  let projectedArtifacts: BrowserArtifact[];
  let previewJobs: SitePreviewJob[];
  try {
    activeSessions = sessions.map((row) => JSON.parse(row.sessionJson) as TaskSession);
    knowledgeCandidates = candidates.map((row) => JSON.parse(row.candidateJson) as KnowledgeCandidate);
    projectedLearningJobs = learningJobs.map((row) => projectPublicRunnerLeasedRecord(JSON.parse(row.jobJson) as LearningJob));
    projectedValidationJobs = validationJobs.map((row) => projectPublicRunnerLeasedRecord(JSON.parse(row.jobJson) as ValidationJob));
    projectedBrowserRuns = browserRuns.map((row) => JSON.parse(row.runJson) as BrowserRun);
    projectedArtifacts = artifacts.map((row) => JSON.parse(row.artifactJson) as BrowserArtifact);
    previewJobs = previewRows.map((row) => JSON.parse(row.jobJson) as SitePreviewJob);
  } catch (error) {
    throw new SiteAgentDataError("site_agent_database_failed", "Site Agent overview data contains an unreadable record.", "site_agent_overview_database", { cause: error });
  }
  let coverage: ContentCoverage;
  try {
    coverage = await contentCoverage(database, siteAgentId, release.scenes);
  } catch (error) {
    const diagnostic = siteAgentDiagnosticFromError(
      new SiteAgentDataError("site_agent_content_coverage_failed", "Site Agent content coverage is unavailable.", "site_agent_overview_database", { cause: error }),
      "site_agent_database_failed",
      "site_agent_overview_database",
    );
    diagnostics.push(diagnostic);
    console.error("site_agent_overview_content_coverage_failed", {
      siteAgentId,
      code: diagnostic.code,
      phase: diagnostic.phase,
      message: error instanceof Error ? error.message : String(error),
    });
    coverage = { indexedPages: 0, totalChunks: 0, totalChars: 0, scenesTotal: release.scenes.length, emptyPages: [] };
  }
  return { overview: {
    ...agentSummary,
    activeRelease: release,
    knowledge: siteKnowledgeFromRelease(release),
    contentCoverage: coverage,
    recentEpisodes,
    activeSessions,
    candidates: presentCandidates(knowledgeCandidates),
    learningJobs: projectedLearningJobs,
    validationJobs: projectedValidationJobs,
    browserRuns: projectedBrowserRuns,
    artifacts: projectedArtifacts,
    runners: [],
    runnerService: runnerResult.runnerService,
    sitePreview: previewJobs.find((item) => item.status === "succeeded")?.result,
    sitePreviewJob: previewJobs[0] ? publicPreviewJob(previewJobs[0]) : undefined,
    diagnostics: diagnostics.length ? diagnostics : undefined,
  }, persistence: "d1" };
}

function profileFromSnapshot(siteAgentId: string, snapshot: PageSnapshot) {
  const name = snapshot.heading || snapshot.title || new URL(snapshot.url).hostname;
  return {
    name: name.slice(0, 100),
    description: snapshot.title && snapshot.title !== name ? snapshot.title.slice(0, 200) : `${name} 的网站 SiteAgent`,
    semanticSource: "program" as const,
    visibility: "production" as const,
    entryUrl: snapshot.metadata?.canonicalUrl || new URL(snapshot.url).origin,
    vocabulary: {},
    suggestedGoals: [],
  } satisfies SiteProfile;
}


/**
 * An observation does one thing: live re-verification of already verified entries.
 *
 * It used to also learn scenes, links, targets and actions from navigations, so
 * every page navigation published a knowledge version. The connection path
 * (recordSiteAgentConnection) was already narrowed for the same reason: **site
 * knowledge comes from crawling only**. This is the other half of that leak — one
 * production site accumulated 38,710 releases and 31 GB of JSON, growing the
 * pre-release database backup from 19 MB to 6 GB.
 *
 * What remains is not new knowledge but the health of existing scenes: a real
 * landing on a verified scene is a live re-verification, and only a failure streak
 * demotes it to needs-reverify. A version is published only when the status actually
 * flips — orders of magnitude fewer than "one per navigation". Re-promotion still
 * requires a re-crawl.
 */
function releaseFromObservations(release: SiteAgentReleaseV2, observations: TransitionObservation[]) {
  const now = observations.at(-1)?.endedAt || new Date().toISOString();
  // Lean freshness check (drift, no sweep/cron): a real landing on a VERIFIED scene is a live
  // re-verification — a pass keeps its entry healthy (fail-streak reset), a fail-streak
  // demotes it to needs-reverify. Reuses the crawl probe's verifyEntry/applyEntryFeedback.
  // Only `verified` scenes are touched here; re-promotion of a demoted scene stays with
  // manual re-crawl (per the doc's "refresh = re-crawl" policy).
  const entryUpdates = new Map<string, SceneDefinition>();
  for (const observation of observations) {
    const sceneId = observation.toScene?.sceneId;
    const snapshot = observation.toSnapshot;
    if (!sceneId || !snapshot) continue;
    const scene = entryUpdates.get(sceneId) || release.scenes.find((item) => item.id === sceneId);
    if (!scene || scene.directEntry !== "verified") continue;
    entryUpdates.set(sceneId, applyEntryFeedback(scene, verifyEntry(scene, snapshot, observation.endedAt || now)));
  }
  if (!entryUpdates.size) return release;
  const next = {
    ...release,
    id: `${release.siteAgentId}:release:${release.version + 1}`,
    version: release.version + 1,
    createdAt: now,
    scenes: release.scenes.map((scene) => entryUpdates.get(scene.id) || scene),
  };
  const hashable = { ...next, contentHash: undefined, knowledgeRevision: undefined };
  return { ...next, contentHash: stableHash(JSON.stringify(hashable)) };
}

// Scenes arrive through `adoptCrawlDocument`, never through a handshake. This
// used to accept `reviewedScenes` and never read it, so a caller could pass
// scenes and watch nothing happen — worse than not offering the parameter.
export async function recordSiteAgentConnection(siteAgentId: string, input: { origin: string; url: string; title: string; heading: string; snapshot: PageSnapshot; profile?: SiteProfile; visibility?: SiteProfile["visibility"] }) {
  const now = new Date().toISOString();
  const connection: SiteConnection = { siteAgentId, origin: input.origin, url: input.url, title: input.title, heading: input.heading, connectedAt: now, lastSeenAt: now };
  const database = getD1Binding();
  if (!database) {
    const agent = memoryAgent(siteAgentId);
    // "First connection" = this handshake created a connection row that did not exist
    // before. It is the only trigger for auto-scheduling a crawl.
    const firstConnection = !agent.connection;
    connection.connectedAt = agent.connection?.connectedAt || now;
    agent.connection = connection;
    // Visibility (production / sandbox) is a **site attribute, not knowledge**: the
    // widget declares it on connect and it is updated on the profile in place — no
    // longer smuggled in through a knowledge version, which is exactly what was removed.
    if (input.visibility && agent.release.profile.visibility !== input.visibility) {
      agent.release = { ...agent.release, profile: { ...agent.release.profile, visibility: input.visibility } };
    }
    agent.updatedAt = now;
    return { connection, release: agent.release, firstConnection, persistence: "memory" as const };
  }
  await ensureSiteAgentV2Schema(database);
  await requireD1Agent(database, siteAgentId);
  // Site knowledge has a single source: crawling. A widget connection **only records
  // who connected and when**; it no longer learns page structure from real visits or
  // publishes versions — that was the origin of "one crawl, several versions". The
  // widget still receives the current knowledge base; runtime is unaffected.
  const release = await d1Release(database, siteAgentId) || emptyRelease(siteAgentId);
  // The upsert leaves `connected_at` untouched on conflict, so `RETURNING connected_at`
  // equal to this call's `now` means a first insert — the first-connection signal comes
  // for free from this statement, no extra round trip on the handshake path.
  const statements = [
    database.prepare(`INSERT INTO site_agent_v2_connections (site_agent_id, origin, url, title, heading, connected_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(site_agent_id) DO UPDATE SET origin=excluded.origin,url=excluded.url,title=excluded.title,heading=excluded.heading,last_seen_at=excluded.last_seen_at
      RETURNING connected_at AS connectedAt`)
      .bind(siteAgentId, input.origin, input.url, input.title, input.heading, now, now),
  ];
  // Visibility (production / sandbox) is a **site attribute, not knowledge**: updated
  // on the agent profile in place, no version published.
  if (input.visibility && (release.profile.visibility || "production") !== input.visibility) {
    statements.push(
      database.prepare(`UPDATE site_agent_v2_agents SET profile_json=?,updated_at=? WHERE id=?`)
        .bind(JSON.stringify({ ...release.profile, visibility: input.visibility }), now, siteAgentId),
    );
  }
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "site_agent_v2_connection_failed");
  const returned = (results[0]?.results as Array<{ connectedAt?: string }> | undefined)?.[0]?.connectedAt;
  connection.connectedAt = returned || now;
  const firstConnection = returned === now;
  invalidateSiteAgentListCache();
  return { connection, release, firstConnection, persistence: "d1" as const };
}




export async function appendObservations(siteAgentId: string, observations: TransitionObservation[]) {
  const unique = [...new Map(observations.map((observation) => [observation.id, observation])).values()];
  const database = getD1Binding();
  if (!database) {
    const agent = memoryAgent(siteAgentId);
    const known = new Set(agent.observations.map((item) => item.id));
    const accepted = unique.filter((item) => !known.has(item.id));
    agent.observations.push(...accepted);
    agent.observations = agent.observations.slice(-1000);
    setMemoryRelease(agent, releaseFromObservations(agent.release, accepted));
    return { accepted: accepted.length, release: agent.release, persistence: "memory" as const };
  }
  await ensureSiteAgentV2Schema(database);
  await requireD1Agent(database, siteAgentId);
  const current = await d1Release(database, siteAgentId) || emptyRelease(siteAgentId);
  const release = releaseFromObservations(current, unique);
  const statements = unique.map((observation) => database.prepare(`INSERT OR IGNORE INTO site_agent_v2_observations
    (id, site_agent_id, session_id, kind, scene_id, observation_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(observation.id, siteAgentId, observation.sessionId, "transition", observation.toScene?.sceneId || observation.fromScene?.sceneId || null, JSON.stringify(observation), observation.endedAt));
  if (release.version !== current.version) {
    statements.push(
      database.prepare(`INSERT OR IGNORE INTO site_agent_v2_releases (id, site_agent_id, version, content_hash, release_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(release.id, siteAgentId, release.version, release.contentHash, JSON.stringify(release), release.createdAt),
      database.prepare(`UPDATE site_agent_v2_agents SET active_release_id=?,updated_at=? WHERE id=? AND active_release_id=?`)
        .bind(release.id, release.createdAt, siteAgentId, current.id),
    );
  }
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "site_agent_v2_observation_failed");
  if (release.version !== current.version) invalidateSiteAgentListCache();
  return { accepted: unique.length, release, persistence: "d1" as const };
}

export async function createTaskSession(session: TaskSession) {
  const database = getD1Binding();
  if (!database) {
    const agent = memoryAgent(session.siteAgentId);
    agent.sessions = [...agent.sessions.filter((item) => item.id !== session.id), session].slice(-100);
    return { session, persistence: "memory" as const };
  }
  await ensureSiteAgentV2Schema(database);
  await requireD1Agent(database, session.siteAgentId);
  const result = await database.prepare(`INSERT OR REPLACE INTO site_agent_v2_sessions
    (id, site_agent_id, browser_session_id, status, session_json, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(session.id, session.siteAgentId, session.browserSessionId, session.status, JSON.stringify(session), session.createdAt, session.updatedAt, session.expiresAt).run();
  if (!result.success) throw new Error(result.error || "site_agent_v2_session_create_failed");
  return { session, persistence: "d1" as const };
}

export async function getTaskSession(siteAgentId: string, sessionId: string) {
  const database = getD1Binding();
  if (!database) return { session: memoryAgent(siteAgentId).sessions.find((item) => item.id === sessionId), persistence: "memory" as const };
  await ensureSiteAgentV2Schema(database);
  const rows = await all<SessionRow>(database, `SELECT session_json AS sessionJson FROM site_agent_v2_sessions WHERE id=? AND site_agent_id=? LIMIT 1`, [sessionId, siteAgentId]);
  return { session: rows[0] ? JSON.parse(rows[0].sessionJson) as TaskSession : undefined, persistence: "d1" as const };
}

export async function updateTaskSession(siteAgentId: string, sessionId: string, patch: Partial<TaskSession>) {
  const current = await getTaskSession(siteAgentId, sessionId);
  if (!current.session) return { session: undefined, persistence: current.persistence };
  const session = { ...current.session, ...patch, id: sessionId, siteAgentId, updatedAt: new Date().toISOString() };
  return createTaskSession(session);
}

async function d1Candidates(database: D1DatabaseLike, siteAgentId: string) {
  const rows = await all<CandidateRow>(database, `SELECT candidate_json AS candidateJson FROM site_agent_v2_candidates WHERE site_agent_id=?`, [siteAgentId]);
  return rows.map((row) => JSON.parse(row.candidateJson) as KnowledgeCandidate);
}

function capabilitySignalFromEpisode(
  episode: TaskEpisode,
  current?: CapabilitySignal,
  candidate?: KnowledgeCandidate,
) {
  const wallClock = new Date().toISOString();
  const now = current && wallClock <= current.updatedAt
    ? new Date(Date.parse(current.updatedAt) + 1).toISOString()
    : wallClock;
  const intentBucket = candidate?.authoring?.intentKey
    || candidate?.normalizedGoal
    || episode.normalizedGoal
    || normalizeGoal(episode.goal);
  const sourceEvidence = [...new Set([episode.id, ...(candidate?.sourceEpisodeIds || [])])];
  const signal: CapabilitySignal = current ? {
    ...current,
    episodeIds: [...new Set([...current.episodeIds, episode.id])],
    evidenceRefs: [...new Set([...current.evidenceRefs, ...sourceEvidence])],
    updatedAt: now,
  } : {
    id: `capability_signal:${stableHash(`${episode.siteAgentId}:${intentBucket}`)}`,
    siteAgentId: episode.siteAgentId,
    intentBucket,
    kind: "new-gap",
    status: "pending",
    episodeIds: [episode.id],
    evidenceRefs: sourceEvidence,
    createdAt: now,
    updatedAt: now,
  };
  return signal;
}

async function queueCapabilitySignal(database: D1DatabaseLike, episode: TaskEpisode, candidate?: KnowledgeCandidate) {
  const intentBucket = candidate?.authoring?.intentKey
    || candidate?.normalizedGoal
    || episode.normalizedGoal
    || normalizeGoal(episode.goal);
  const deterministicId = `capability_signal:${stableHash(`${episode.siteAgentId}:${intentBucket}`)}`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rows = await all<{ id: string; status: CapabilitySignal["status"]; signalJson: string; updatedAt: string }>(database,
      `SELECT id,status,signal_json AS signalJson,updated_at AS updatedAt
       FROM site_agent_v2_capability_signals
       WHERE site_agent_id=? AND intent_bucket=? AND (status IN ('pending','processing') OR id=?)
       ORDER BY CASE WHEN status='processing' THEN 0 WHEN status='pending' THEN 1 ELSE 2 END, created_at LIMIT 1`,
      [episode.siteAgentId, intentBucket, deterministicId]);
    const row = rows[0];
    const stored = row
      ? { ...JSON.parse(row.signalJson) as CapabilitySignal, status: row.status, updatedAt: row.updatedAt }
      : undefined;
    const current = stored && (stored.status === "pending" || stored.status === "processing")
      ? stored
      : stored
        ? { ...stored, status: "pending" as const, attempts: 0, nextAttemptAt: undefined, lastError: undefined, resolution: undefined }
        : undefined;
    const signal = capabilitySignalFromEpisode(episode, current, candidate);
    if (!row) {
      const inserted = await database.prepare(`INSERT OR IGNORE INTO site_agent_v2_capability_signals
        (id,site_agent_id,intent_bucket,status,signal_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
        .bind(signal.id, signal.siteAgentId, signal.intentBucket, signal.status, JSON.stringify(signal), signal.createdAt, signal.updatedAt).run();
      if (inserted.success && Number(inserted.meta?.changes || 0) === 1) return signal;
      continue;
    }
    const updated = await database.prepare(`UPDATE site_agent_v2_capability_signals
      SET status=?,signal_json=?,updated_at=? WHERE id=? AND site_agent_id=? AND status=? AND updated_at=?`)
      .bind(signal.status, JSON.stringify(signal), signal.updatedAt, row.id, episode.siteAgentId, row.status, row.updatedAt).run();
    if (updated.success && Number(updated.meta?.changes || 0) === 1) return signal;
  }
  throw new Error("capability_signal_queue_conflict");
}

function capabilitySignalStatement(database: D1DatabaseLike, signal: CapabilitySignal) {
  return database.prepare(`INSERT OR REPLACE INTO site_agent_v2_capability_signals (id,site_agent_id,intent_bucket,status,signal_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(signal.id, signal.siteAgentId, signal.intentBucket, signal.status, JSON.stringify(signal), signal.createdAt, signal.updatedAt);
}

async function nextCapabilitySignal(database: D1DatabaseLike, episode: TaskEpisode) {
  const intentBucket = episode.normalizedGoal || normalizeGoal(episode.goal);
  const rows = await all<{ signalJson: string }>(database, `SELECT signal_json AS signalJson FROM site_agent_v2_capability_signals WHERE site_agent_id=? AND intent_bucket=? AND status='pending' ORDER BY created_at LIMIT 1`, [episode.siteAgentId, intentBucket]);
  return capabilitySignalFromEpisode(
    episode,
    rows[0] ? JSON.parse(rows[0].signalJson) as CapabilitySignal : undefined,
  );
}

function queueMemoryCapabilitySignal(agent: MemoryAgent, episode: TaskEpisode) {
  agent.capabilitySignals ||= [];
  const intentBucket = episode.normalizedGoal || normalizeGoal(episode.goal);
  const current = agent.capabilitySignals.find((signal) =>
    signal.intentBucket === intentBucket
    && (signal.status === "pending" || signal.status === "processing"))
    || agent.capabilitySignals.find((signal) => signal.id === `capability_signal:${stableHash(`${episode.siteAgentId}:${intentBucket}`)}`);
  const base = current && (current.status === "pending" || current.status === "processing")
    ? current
    : current
      ? { ...current, status: "pending" as const, attempts: 0, nextAttemptAt: undefined, lastError: undefined, resolution: undefined }
      : undefined;
  const signal = capabilitySignalFromEpisode(episode, base);
  if (current) Object.assign(current, signal);
  else agent.capabilitySignals.push(signal);
  return signal;
}

async function finishProcessingCapabilitySignal(
  database: D1DatabaseLike,
  siteAgentId: string,
  signalId: string,
  update: (current: CapabilitySignal) => CapabilitySignal,
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rows = await all<{ signalJson: string; updatedAt: string }>(database,
      `SELECT signal_json AS signalJson,updated_at AS updatedAt FROM site_agent_v2_capability_signals
       WHERE id=? AND site_agent_id=? AND status='processing' LIMIT 1`, [signalId, siteAgentId]);
    if (!rows[0]) throw new Error("capability_signal_processing_conflict");
    const current = JSON.parse(rows[0].signalJson) as CapabilitySignal;
    const next = update(current);
    const saved = await database.prepare(`UPDATE site_agent_v2_capability_signals
      SET status=?,signal_json=?,updated_at=? WHERE id=? AND site_agent_id=? AND status='processing' AND updated_at=?`)
      .bind(next.status, JSON.stringify(next), next.updatedAt, signalId, siteAgentId, rows[0].updatedAt).run();
    if (saved.success && Number(saved.meta?.changes || 0) === 1) return next;
  }
  throw new Error("capability_signal_finish_conflict");
}

type ActiveCapabilitySignalRow = {
  id: string;
  siteAgentId: string;
  status: "pending" | "processing";
  signalJson: string;
  createdAt: string;
  updatedAt: string;
};

async function coalesceActiveCapabilitySignals(
  database: D1DatabaseLike,
  siteAgentId: string,
  intentBucket: string,
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rows = await all<ActiveCapabilitySignalRow>(database,
      `SELECT id,site_agent_id AS siteAgentId,status,signal_json AS signalJson,
        created_at AS createdAt,updated_at AS updatedAt
       FROM site_agent_v2_capability_signals
       WHERE site_agent_id=? AND intent_bucket=? AND status IN ('pending','processing')
       ORDER BY CASE WHEN status='processing' THEN 0 ELSE 1 END,created_at,id`,
      [siteAgentId, intentBucket]);
    if (rows.length <= 1) return rows[0];
    const winner = rows[0]!;
    const signals = rows.map((row) => ({
      row,
      signal: { ...JSON.parse(row.signalJson) as CapabilitySignal, status: row.status, updatedAt: row.updatedAt },
    }));
    const latestUpdatedAt = rows.reduce((latest, row) => row.updatedAt > latest ? row.updatedAt : latest, rows[0]!.updatedAt);
    const wallClock = new Date().toISOString();
    const updatedAt = wallClock > latestUpdatedAt ? wallClock : new Date(Date.parse(latestUpdatedAt) + 1).toISOString();
    const latestError = [...signals]
      .sort((left, right) => right.row.updatedAt.localeCompare(left.row.updatedAt))
      .find((item) => item.signal.lastError)?.signal.lastError;
    const merged: CapabilitySignal = {
      ...signals[0]!.signal,
      status: winner.status,
      episodeIds: [...new Set(signals.flatMap((item) => item.signal.episodeIds))],
      evidenceRefs: [...new Set(signals.flatMap((item) => item.signal.evidenceRefs))],
      attempts: Math.max(...signals.map((item) => item.signal.attempts || 0)),
      ...(latestError ? { lastError: latestError } : {}),
      updatedAt,
    };
    const statements = [
      database.prepare(`UPDATE site_agent_v2_capability_signals
        SET signal_json=?,updated_at=? WHERE id=? AND site_agent_id=? AND status=? AND updated_at=?`)
        .bind(JSON.stringify(merged), updatedAt, winner.id, siteAgentId, winner.status, winner.updatedAt),
      ...signals.slice(1).map(({ row, signal }) => {
        const superseded = { ...signal, status: "superseded" as const, updatedAt };
        return database.prepare(`UPDATE site_agent_v2_capability_signals
          SET status='superseded',signal_json=?,updated_at=?
          WHERE id=? AND site_agent_id=? AND status=? AND updated_at=?`)
          .bind(JSON.stringify(superseded), updatedAt, row.id, siteAgentId, row.status, row.updatedAt);
      }),
    ];
    const results = await database.batch(statements);
    if (results.every((result) => result.success && Number(result.meta?.changes || 0) === 1)) {
      return { ...winner, signalJson: JSON.stringify(merged), updatedAt };
    }
  }
  throw new Error("capability_signal_coalesce_conflict");
}

function coalesceMemoryCapabilitySignals(agent: MemoryAgent) {
  const groups = new Map<string, CapabilitySignal[]>();
  for (const signal of agent.capabilitySignals || []) {
    if (signal.status !== "pending" && signal.status !== "processing") continue;
    groups.set(signal.intentBucket, [...(groups.get(signal.intentBucket) || []), signal]);
  }
  for (const signals of groups.values()) {
    if (signals.length <= 1) continue;
    signals.sort((left, right) => Number(right.status === "processing") - Number(left.status === "processing")
      || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const winner = signals[0]!;
    winner.episodeIds = [...new Set(signals.flatMap((signal) => signal.episodeIds))];
    winner.evidenceRefs = [...new Set(signals.flatMap((signal) => signal.evidenceRefs))];
    winner.attempts = Math.max(...signals.map((signal) => signal.attempts || 0));
    const latestError = [...signals].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).find((signal) => signal.lastError)?.lastError;
    if (latestError) winner.lastError = latestError;
    winner.updatedAt = new Date().toISOString();
    for (const duplicate of signals.slice(1)) {
      duplicate.status = "superseded";
      duplicate.updatedAt = winner.updatedAt;
    }
  }
}

function recordsTerminalCapabilitySignal(
  release: SiteAgentReleaseV2,
  episode: TaskEpisode,
  triggerAuthority?: "terminal-user-gap",
) {
  const completedCapabilityCall = episode.experience?.toolReceipts?.some((receipt) =>
    receipt.kind === "capability" && receipt.status === "completed");
  const structuredOutput = episode.outcome.evidence.structuredOutput;
  const hasStructuredOutput = Boolean(structuredOutput
    && typeof structuredOutput === "object"
    && !Array.isArray(structuredOutput)
    && Object.keys(structuredOutput).length > 0);
  const hasRealPageEvidence = Boolean(episode.experience
    && (episode.experience.actions.length > 0
      || hasStructuredOutput
      || episode.experience.toolReceipts?.some((receipt) =>
        receipt.kind === "page" && receipt.status === "completed")));
  return triggerAuthority === "terminal-user-gap"
    && episode.outcome.status === "success"
    && hasRealPageEvidence
    && !completedCapabilityCall
    && !episode.capabilityId
    && !exactCapabilityForGoal(release, episode.goal);
}

export async function appendTaskEpisode(
  siteAgentId: string,
  episode: TaskEpisode,
  options: {
    /**
     * Only the terminal-user path supplies this, and only as
     * `terminal-user-gap`: the episode route refuses `author-request` and never
     * mints any other authority. A `control-plane` value existed for an entry
     * point no route called.
     */
    triggerAuthority?: "terminal-user-gap";
    /** Server-computed V2 authority persisted atomically with its Episode. */
    experienceAuthority?: CapabilityExperienceAuthority;
    /** Exact compiled source authenticated and pinned by AgentRun authority. */
    compiledRepairSourceCapabilityId?: string;
  } = {},
): Promise<{ accepted: boolean; published: boolean; release: SiteAgentReleaseV2; directive: ClientDirective; persistence: "memory" | "d1" }> {
  // An Episode always belongs to a Session that already exists: the widget
  // opens one before it runs anything. The control-plane path used to hand its
  // own Session in to be created inside this batch; that entry point is gone,
  // and with it the only caller that did not have a stored Session.
  const sessionResult = await getTaskSession(siteAgentId, episode.taskSessionId);
  if (!sessionResult.session) throw new Error("task_session_not_found");
  const database = getD1Binding();
  if (!database) {
    const agent = memoryAgent(siteAgentId);
    if (agent.episodes.some((item) => item.id === episode.id)) {
      if (options.experienceAuthority) enqueueMemoryCapabilityExperience(options.experienceAuthority, new Date().toISOString());
      return { accepted: false, published: false, release: agent.release, directive: { type: "recorded", release: agent.release }, persistence: "memory" };
    }
    const recordTerminalSignal = recordsTerminalCapabilitySignal(agent.release, episode, options.triggerAuthority);
    if (options.triggerAuthority === "terminal-user-gap" || options.experienceAuthority) {
      if (recordTerminalSignal && !options.experienceAuthority) queueMemoryCapabilitySignal(agent, episode);
      if (options.experienceAuthority) enqueueMemoryCapabilityExperience(options.experienceAuthority, episode.endedAt);
      agent.episodes.push(episode);
      agent.updatedAt = episode.endedAt;
      return {
        accepted: true,
        published: false,
        release: agent.release,
        directive: { type: "recorded", release: agent.release },
        persistence: "memory",
      };
    }
    const compiled = compileEpisode({
      release: agent.release,
      candidates: agent.candidates,
      session: sessionResult.session,
      suppressions: agent.capabilitySuppressions,
      triggerAuthority: options.triggerAuthority,
      compiledRepairSourceCapabilityId: options.compiledRepairSourceCapabilityId,
    }, episode);
    if (compiled.directive.type === "learning-queued"
      && typeof compiled.directive.job.result?.requestedGoal !== "string") {
      compiled.directive.job.result = {
        ...compiled.directive.job.result,
        requestedGoal: episode.goal,
      };
    }
    agent.episodes.push(episode);
    if (recordTerminalSignal && !options.experienceAuthority) queueMemoryCapabilitySignal(agent, episode);
    setMemoryRelease(agent, compiled.release);
    agent.candidates = compiled.candidates;
    let memoryDirective = compiled.directive;
    if (compiled.directive.type === "learning-queued") {
      const queued = compiled.directive.job;
      // The browser author/validator is a separate process and cannot consume
      // process-local memory. Report that limitation honestly instead of
      // leaving a user-triggered capability permanently displayed as queued.
      const stored = queued.origin === "user-triggered"
        ? {
          ...queued,
          status: "failed" as const,
          failure: {
            code: "durable_persistence_required",
            summary: "自动能力构建需要 D1 或兼容的持久数据库。",
          },
          updatedAt: episode.endedAt,
        }
        : queued;
      agent.learningJobs = [...agent.learningJobs.filter((job) => job.id !== queued.id), stored].slice(-100);
      memoryDirective = stored.status === "failed"
        ? {
          type: "learning-unavailable",
          session: compiled.directive.session,
          candidate: compiled.directive.candidate,
          job: stored,
          reason: stored.failure?.summary || "当前环境不支持自动能力沉淀。",
        }
        : { ...compiled.directive, job: stored };
    }
    agent.sessions = agent.sessions.map((item) => item.id === compiled.session.id ? compiled.session : item);
    agent.updatedAt = episode.endedAt;
    return { accepted: true, published: compiled.published, release: compiled.release, directive: memoryDirective, persistence: "memory" };
  }
  await ensureSiteAgentV2Schema(database);
  if (options.experienceAuthority) await ensureSiteAgentV3Schema(database);
  await requireD1Agent(database, siteAgentId);
  const duplicate = await all<{ id: string }>(database, `SELECT id FROM site_agent_v2_episodes WHERE id=? LIMIT 1`, [episode.id]);
  const release = await d1Release(database, siteAgentId) || emptyRelease(siteAgentId);
  if (duplicate.length) {
    // A retry also repairs a legacy/non-atomic write where the Episode exists
    // but its deferred capability signal does not.
    if (!options.experienceAuthority && recordsTerminalCapabilitySignal(release, episode, options.triggerAuthority)) {
      await queueCapabilitySignal(database, episode);
    }
    if (options.experienceAuthority) {
      const queued = await capabilityExperienceOutboxStatement(database, options.experienceAuthority, new Date().toISOString()).run();
      if (!queued.success) throw new Error(queued.error || "capability_experience_outbox_write_failed");
    }
    return { accepted: false, published: false, release, directive: { type: "recorded", release }, persistence: "d1" };
  }
  if (options.triggerAuthority === "terminal-user-gap" || options.experienceAuthority) {
    const shouldQueueSignal = !options.experienceAuthority && recordsTerminalCapabilitySignal(release, episode, options.triggerAuthority);
    const statements = [
      database.prepare(`UPDATE site_agent_v2_sessions
        SET updated_at=updated_at WHERE id=? AND site_agent_id=?`)
        .bind(episode.taskSessionId, siteAgentId),
      database.prepare(`INSERT OR IGNORE INTO site_agent_v2_episodes
        (id,site_agent_id,task_session_id,mode,normalized_goal,outcome_status,
         episode_json,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(
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
      ...(options.experienceAuthority
        ? [capabilityExperienceOutboxStatement(database, options.experienceAuthority, episode.endedAt)]
        : []),
    ];
    const results = await database.batch(statements);
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "capability_signal_queue_failed");
    // Queue after the Episode commit. A queue CAS failure is repaired by the
    // duplicate-Episode path on retry, while a Signal can never reference an
    // Episode that failed to persist.
    if (shouldQueueSignal) await queueCapabilitySignal(database, episode);
    return {
      accepted: true,
      published: false,
      release,
      directive: { type: "recorded", release },
      persistence: "d1",
    };
  }
  const [candidates, suppressions] = await Promise.all([
    d1Candidates(database, siteAgentId),
    activeCapabilitySuppressions(database, siteAgentId),
  ]);
  let baseRelease = release;
  const recordTerminalSignal = recordsTerminalCapabilitySignal(baseRelease, episode, options.triggerAuthority);
  const terminalSignal = recordTerminalSignal
    ? await nextCapabilitySignal(database, episode)
    : undefined;
  let compiled = compileEpisode({
    release: baseRelease,
    candidates,
    session: sessionResult.session,
    suppressions,
    triggerAuthority: options.triggerAuthority,
    compiledRepairSourceCapabilityId: options.compiledRepairSourceCapabilityId,
  }, episode);
  if (compiled.directive.type === "learning-queued"
    && typeof compiled.directive.job.result?.requestedGoal !== "string") {
    compiled.directive.job.result = {
      ...compiled.directive.job.result,
      requestedGoal: episode.goal,
    };
  }
  for (let mergeAttempt = 0; mergeAttempt < 3; mergeAttempt += 1) {
    // Explicit BuildRequests are append-only at this boundary. `candidates`
    // was read before this batch, so rewriting that full snapshot could roll
    // back another worker's newer designed/authored Candidate. Persist only
    // the Candidate created by this request; design owns later mutations.
    const candidatesToPersist = compiled.candidates;
    const nextIds = new Set(candidatesToPersist.map((candidate) => candidate.id));
    const statements = [
      database.prepare(`UPDATE site_agent_v2_sessions SET status=?,session_json=?,updated_at=?,expires_at=? WHERE id=? AND site_agent_id=?`)
        .bind(compiled.session.status, JSON.stringify(compiled.session), compiled.session.updatedAt, compiled.session.expiresAt, compiled.session.id, siteAgentId),
      database.prepare(`INSERT OR IGNORE INTO site_agent_v2_episodes (id,site_agent_id,task_session_id,mode,normalized_goal,outcome_status,episode_json,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(episode.id, siteAgentId, episode.taskSessionId, episode.mode, episode.normalizedGoal, episode.outcome.status, JSON.stringify(episode), episode.startedAt, episode.endedAt),
      ...candidates.filter((candidate) => !nextIds.has(candidate.id)).map((candidate) =>
        database.prepare(`DELETE FROM site_agent_v2_candidates WHERE id=? AND site_agent_id=?`).bind(candidate.id, siteAgentId)),
    ];
    for (const candidate of candidatesToPersist) {
      statements.push(
        database.prepare(`DELETE FROM site_agent_v2_candidates WHERE site_agent_id=? AND normalized_goal=? AND id<>?`)
          .bind(siteAgentId, candidate.normalizedGoal, candidate.id),
      );
      statements.push(
        database.prepare(`INSERT OR REPLACE INTO site_agent_v2_candidates
          (id,site_agent_id,normalized_goal,status,base_release_version,candidate_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
          .bind(candidate.id, siteAgentId, candidate.normalizedGoal, candidate.validation.status, candidate.baseReleaseVersion, JSON.stringify(candidate), candidate.createdAt, candidate.updatedAt),
      );
    }
    if (compiled.directive.type === "learning-queued") {
      const job = compiled.directive.job;
      statements.push(database.prepare(`INSERT OR REPLACE INTO site_agent_v2_learning_jobs
        (id,site_agent_id,task_session_id,status,result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
        .bind(job.id, siteAgentId, job.taskSessionId, job.status, JSON.stringify(job), job.createdAt, job.updatedAt));
    }
    if (terminalSignal) statements.push(capabilitySignalStatement(database, terminalSignal));
    if (compiled.published) statements.push(
      database.prepare(`INSERT OR IGNORE INTO site_agent_v2_releases (id,site_agent_id,version,content_hash,release_json,created_at) VALUES (?,?,?,?,?,?)`)
        .bind(compiled.release.id, siteAgentId, compiled.release.version, compiled.release.contentHash, JSON.stringify(compiled.release), compiled.release.createdAt),
      database.prepare(`UPDATE site_agent_v2_agents SET profile_json=?,active_release_id=?,updated_at=? WHERE id=? AND active_release_id=?`)
        .bind(JSON.stringify(compiled.release.profile), compiled.release.id, episode.endedAt, siteAgentId, baseRelease.id),
    );
    const results = await database.batch(statements);
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "site_agent_v2_episode_failed");
    if (!compiled.published) {
      invalidateSiteAgentListCache();
      return { accepted: true, published: false, release: compiled.release, directive: compiled.directive, persistence: "d1" };
    }
    const active = await d1Release(database, siteAgentId) || baseRelease;
    if (active.contentHash === compiled.release.contentHash) {
      invalidateSiteAgentListCache();
      return { accepted: true, published: true, release: active, directive: { type: "release-updated", session: compiled.session, release: active }, persistence: "d1" };
    }
    baseRelease = active;
    compiled = compileEpisode({
      release: baseRelease,
      candidates,
      session: sessionResult.session,
      suppressions,
      triggerAuthority: options.triggerAuthority,
      compiledRepairSourceCapabilityId: options.compiledRepairSourceCapabilityId,
    }, episode);
  }
  throw new Error("site_agent_v2_release_conflict");
}

function updateReceipt(job: LearningJob, stage: LearningJob["phase"] | "evidence", patch: Partial<LearningStageReceipt>): LearningJob {
  const receipts = job.receipts || [];
  let foundIndex = -1;
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    if (receipts[index].stage === stage) {
      foundIndex = index;
      break;
    }
  }
  const now = new Date().toISOString();
  if (foundIndex >= 0) {
    return {
      ...job,
      receipts: receipts.map((receipt, index) =>
        index === foundIndex ? { ...receipt, ...patch } : receipt),
      updatedAt: now,
    };
  }
  const receipt: LearningStageReceipt = {
    id: uid("receipt"), stage, actor: stage === "design" ? "ai" : stage === "publish" ? "release-gate" : "browser-runner",
    status: "queued", title: stage, summary: "", startedAt: now, ...patch,
  };
  return {
    ...job,
    receipts: [...receipts, receipt],
    updatedAt: now,
  };
}

function validationInput(candidate: KnowledgeCandidate, episode: TaskEpisode) {
  const fields = candidate.authoring?.requiredInputs || [];
  if (!fields.length) return { input: episode.input, source: "observed" as const };
  const input: Record<string, JsonValue> = {};
  let derived = false;
  for (const field of fields) {
    const alternative = field.examples?.find((value) => value !== field.value);
    input[field.id] = alternative ?? field.value ?? episode.input[field.id] ?? "";
    if (alternative !== undefined) derived = true;
  }
  return { input, source: derived ? "derived-from-evidence" as const : "observed" as const };
}

function normalizedExecutionUrl(value: string) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function sceneExecutionUrl(scene: SceneDefinition) {
  const observed = (scene.evidence?.observedUrls || [])
    .map(normalizedExecutionUrl)
    .find(Boolean);
  if (observed) return observed;
  const template = scene.urlTemplates.find((item) =>
    item.originPattern !== "*"
    && !/[*:{}]/.test(item.pathnamePattern)
    && Object.keys(item.query || {}).length === 0);
  if (!template) return undefined;
  return normalizedExecutionUrl(new URL(template.pathnamePattern, template.originPattern).toString());
}

export function independentNavigationStartUrl(
  release: SiteAgentReleaseV2,
  capability: CapabilityDefinition,
  fallback: string,
  observedTarget?: string,
) {
  const configuredOrigins = (Array.isArray(release.profile.allowedOrigins) ? release.profile.allowedOrigins : []).flatMap((value) => {
    try { return [new URL(value).origin]; } catch { return []; }
  });
  const anchorOrigins = configuredOrigins.length
    ? configuredOrigins
    : [release.profile.entryUrl, fallback].flatMap((value) => {
      try { return value ? [new URL(value).origin] : []; } catch { return []; }
    });
  const trustedOrigins = new Set(anchorOrigins);
  const targetUrls = new Set(capability.outcomes
    .flatMap((outcome) => outcome.classifiers)
    .filter((classifier) => classifier.kind === "url")
    .map((classifier) => normalizedExecutionUrl(classifier.value))
    .filter((value): value is string => Boolean(value)));
  const normalizedObservedTarget = observedTarget
    ? normalizedExecutionUrl(observedTarget)
    : undefined;
  if (normalizedObservedTarget) targetUrls.add(normalizedObservedTarget);
  const normalizedEntryUrl = release.profile.entryUrl
    ? normalizedExecutionUrl(release.profile.entryUrl)
    : undefined;
  const normalizedFallbackUrl = normalizedExecutionUrl(fallback);
  const originDrift = configuredOrigins.length === 0
    && normalizedEntryUrl
    && normalizedFallbackUrl
    && new URL(normalizedEntryUrl).origin !== new URL(normalizedFallbackUrl).origin;
  const canonicalStarts = (originDrift
    ? [normalizedFallbackUrl, normalizedEntryUrl]
    : [normalizedEntryUrl, normalizedFallbackUrl]
  ).filter((value): value is string =>
    Boolean(value)
    && trustedOrigins.has(new URL(value!).origin)
    && !targetUrls.has(value!));
  if (canonicalStarts[0]) return canonicalStarts[0];
  const candidates = release.scenes
    .map((scene) => ({ scene, url: sceneExecutionUrl(scene) }))
    .filter((item): item is { scene: SceneDefinition; url: string } =>
      Boolean(item.url)
      && trustedOrigins.has(new URL(item.url!).origin)
      && !targetUrls.has(item.url!))
    .sort((left, right) =>
      Number(right.scene.directEntry === "verified") - Number(left.scene.directEntry === "verified")
      || Number(right.scene.evidenceStatus === "entry-verified") - Number(left.scene.evidenceStatus === "entry-verified"));
  if (candidates[0]?.url) return candidates[0].url;
  const trustedOriginStart = anchorOrigins
    .map(normalizedExecutionUrl)
    .find((value): value is string => Boolean(value) && !targetUrls.has(value!));
  if (trustedOriginStart) return trustedOriginStart;
  throw new Error("independent_navigation_start_url_untrusted");
}

export function refreshedValidationStartUrl(
  release: SiteAgentReleaseV2,
  candidate: KnowledgeCandidate,
  validation: ValidationJob,
  fallbackUrls: Array<string | undefined>,
  observedTarget?: string,
) {
  if (candidate.capability.kind !== "navigation") return validation.validationCase.startUrl;
  const normalizedTarget = observedTarget
    ? normalizedExecutionUrl(observedTarget)
    : undefined;
  const candidates = fallbackUrls
    .map((value) => value ? normalizedExecutionUrl(value) : undefined)
    .filter((value): value is string => Boolean(value) && value !== normalizedTarget);
  const configuredOrigins = (Array.isArray(release.profile.allowedOrigins) ? release.profile.allowedOrigins : []).flatMap((value) => {
    try { return [new URL(value).origin]; } catch { return []; }
  });
  const entryOrigin = release.profile.entryUrl ? (() => {
    try { return new URL(release.profile.entryUrl!).origin; } catch { return undefined; }
  })() : undefined;
  const preferred = configuredOrigins.length === 0 && entryOrigin
    ? candidates.find((value) => new URL(value).origin !== entryOrigin) || candidates[0]
    : candidates[0];
  return independentNavigationStartUrl(
    release,
    candidate.capability,
    preferred || validation.validationCase.startUrl,
    observedTarget,
  );
}

function retryableValidationRevision(revision: CapabilityRevision) {
  const failureClass = classifyCapabilityFailure(
    revision.validation?.failureClass || "",
    revision.validation?.summary || "",
  );
  return revision.stage === "validate"
    && revision.validation?.status === "failed"
    && (failureClass === "transient-runtime" || failureClass === "verifier-mismatch");
}

function validationRetryReceiptStartUrls(job?: LearningJob) {
  return [...(job?.receipts || [])].reverse().flatMap((receipt) =>
    typeof receipt.evidence?.startUrl === "string"
      ? [receipt.evidence.startUrl]
      : []);
}

async function makeValidationJob(job: LearningJob, candidate: KnowledgeCandidate, episode: TaskEpisode, release: SiteAgentReleaseV2): Promise<ValidationJob> {
  const now = new Date().toISOString();
  let selected = validationInput(candidate, episode);
  if (selected.source === "observed") {
    const aiInput = await deriveValidationInputFromEvidence(candidate, episode);
    if (aiInput) selected = { input: { ...selected.input, ...aiInput }, source: "derived-from-evidence" };
  }
  const firstOperationId = candidate.capability.plans[0]?.steps[0]?.operationId;
  const firstOperation = candidate.operations.find((operation) => operation.id === firstOperationId) || release.operations.find((operation) => operation.id === firstOperationId);
  // A globally addressable implementation must be validated independently of
  // the previous user's incidental page. Start at the site's canonical entry;
  // the authored program itself is responsible for reaching the result Scene.
  const operationScene = firstOperation?.fromSceneId && firstOperation.fromSceneId !== "*"
    ? release.scenes.find((scene) => scene.id === firstOperation.fromSceneId)
    : undefined;
  const startUrl = candidate.capability.kind === "navigation"
    ? independentNavigationStartUrl(
        release,
        candidate.capability,
        episode.startSnapshot.url,
        episode.endSnapshot.url,
      )
    : firstOperation?.fromSceneId === "*"
      ? (release.profile.entryUrl || new URL(episode.startSnapshot.url).origin)
      : (operationScene && sceneExecutionUrl(operationScene)) || episode.startSnapshot.url;
  return {
    id: uid("validation_job"), learningJobId: job.id, siteAgentId: job.siteAgentId, candidateId: candidate.id,
    capabilityId: candidate.capability.id, baseReleaseVersion: candidate.baseReleaseVersion, status: "queued",
    validationCase: {
      id: uid("validation_case"), name: `${candidate.capability.name} · 独立浏览器重放`, input: selected.input,
      inputSource: selected.source, startUrl,
      expectedStatuses: ["success", "no-result", "business-rejection"], effect: "read-only",
    },
    attempt: 0, maxAttempts: 2, createdAt: now, updatedAt: now,
  };
}

function projectIdForLearningJob(job: LearningJob) {
  if (typeof job.result?.projectId === "string" && job.result.projectId) return job.result.projectId;
  const intentKey = job.intentKey || job.goalTemplate || job.candidateId;
  return `project_${stableHash(`${job.siteAgentId}:${intentKey}`)}`;
}

function candidatesShareStrictCapabilityIdentity(
  left: KnowledgeCandidate,
  right: KnowledgeCandidate,
) {
  const leftIdentity = canonicalReleaseCapabilityProject(left.siteAgentId, left.capability);
  const rightIdentity = canonicalReleaseCapabilityProject(right.siteAgentId, right.capability);
  return leftIdentity.stableKey === rightIdentity.stableKey
    && leftIdentity.contractFingerprint === rightIdentity.contractFingerprint;
}

function navigationToolPinsForCapability(
  release: SiteAgentReleaseV2,
  capability: CapabilityDefinition,
): NavigationToolDependencyPin[] {
  const operationIds = new Set(capability.plans.flatMap((plan) =>
    plan.steps.map((step) => step.operationId)));
  return (release.navigationTools || [])
    .filter((tool) => tool.strategies.some((strategy) => operationIds.has(strategy.operationId)))
    .map((tool) => ({
      toolId: tool.id,
      knowledgeRevision: tool.source.knowledgeRevision,
      dependencyHash: tool.source.dependencyHash,
    }))
    .sort((left, right) => left.toolId.localeCompare(right.toolId));
}

function revisionImplementationForCapability(
  release: SiteAgentReleaseV2,
  capability: CapabilityDefinition,
): CapabilityRevisionImplementation | undefined {
  const navigationToolRefs = navigationToolPinsForCapability(release, capability);
  if (capability.module) {
    return {
      kind: "program",
      moduleRef: capability.module,
      ...(navigationToolRefs.length ? { navigationToolRefs } : {}),
    };
  }
  if (navigationToolRefs.length === 1 && capability.kind === "navigation") {
    return { kind: "navigation-tool", toolRef: navigationToolRefs[0] };
  }
  return navigationToolRefs.length
    ? { kind: "program", navigationToolRefs }
    : undefined;
}

async function claimCanonicalCapabilityForDesign(
  database: D1DatabaseLike,
  job: LearningJob,
  episode: TaskEpisode,
  candidate: KnowledgeCandidate & { authoring: NonNullable<KnowledgeCandidate["authoring"]> },
  release: SiteAgentReleaseV2,
) {
  const kind = candidate.capability.kind
    || (classifyGoal(candidate.authoring.goalTemplate || candidate.capability.name) === "navigation" ? "navigation" : "task");
  const resultKind = candidate.capability.resultKind || "page";
  const explicitProjectId = job.result?.source === "capability-control"
    && typeof job.result.projectId === "string"
    ? job.result.projectId
    : undefined;
  const base = canonicalReleaseCapabilityProject(job.siteAgentId, {
    ...candidate.capability,
    kind,
    resultKind,
    exposure: candidate.capability.exposure || "public",
  });
  const reservedProjectId = explicitProjectId
    || `project_${stableHash(`${job.siteAgentId}:${base.stableKey}:${base.contractFingerprint}`)}`;
  const strictCapabilityId = `capability_${stableHash(`${job.siteAgentId}:${base.stableKey}:${base.contractFingerprint}`)}`;
  const proposedIdentity = capabilityProjectForWrite(projectWithIdentityDefaults({
    ...base,
    id: reservedProjectId,
    intentKey: candidate.authoring.intentKey || job.intentKey || base.intentKey,
    requestedGoal: typeof job.result?.requestedGoal === "string" ? job.result.requestedGoal : episode.goal,
    origin: job.origin || candidate.capability.origin || base.origin,
    triggeredBy: episode.mode === "author-request" ? "administrator" : "user",
    generatedBy: "ai",
    status: "building",
    stage: "design",
    structure: "atomic",
    operation: kind === "navigation" || resultKind !== "action" ? "read" : "write",
    canonicalCapabilityId: strictCapabilityId,
    activeCapabilityId: undefined,
    activeRevisionId: undefined,
    latestRevisionId: undefined,
    revisionCount: 0,
    buildStartedAt: job.createdAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }));

  const exactRows = await all<CapabilityProjectRow>(
    database,
    `SELECT project_json AS projectJson
       FROM site_agent_v2_capability_projects
      WHERE site_agent_id=?
        AND (
          (stable_key=? AND contract_fingerprint=?)
          OR (
            json_extract(project_json,'$.identityConflict.canonicalStableKey')=?
            AND json_extract(project_json,'$.identityConflict.canonicalContractFingerprint')=?
          )
        )
      LIMIT 3`,
    [
      job.siteAgentId,
      proposedIdentity.stableKey,
      proposedIdentity.contractFingerprint,
      proposedIdentity.stableKey,
      proposedIdentity.contractFingerprint,
    ],
  );
  const bindWinner = async (
    winner: CapabilityProject,
    pointer: string,
    authority: "published" | "in-flight",
  ) => {
    const boundJob: LearningJob = {
      ...job,
      result: { ...job.result, projectId: winner.id, revisionId: pointer },
    };
    const revisionGuard = authority === "published"
      ? `EXISTS (
          SELECT 1 FROM site_agent_v2_capability_revisions r
           WHERE r.id=? AND r.site_agent_id=? AND r.project_id=? AND r.status='published'
        )`
      : `EXISTS (
          SELECT 1
            FROM site_agent_v2_capability_revisions r
            JOIN site_agent_v2_learning_jobs owner
              ON owner.id=json_extract(r.revision_json,'$.learningJobId')
             AND owner.site_agent_id=r.site_agent_id
           WHERE r.id=? AND r.site_agent_id=? AND r.project_id=?
             AND r.status IN ('building','awaiting-review')
             AND owner.status IN ('queued','leased','running','awaiting-review')
        )`;
    const updated = await database.prepare(`UPDATE site_agent_v2_learning_jobs
      SET result_json=?,updated_at=?
      WHERE id=? AND site_agent_id=? AND status IN ('leased','running')
        AND ${revisionGuard}`)
      .bind(
        JSON.stringify(boundJob),
        boundJob.updatedAt,
        boundJob.id,
        boundJob.siteAgentId,
        pointer,
        job.siteAgentId,
        winner.id,
      ).run();
    if (!updated.success || Number(updated.meta?.changes || 0) !== 1) {
      throw new Error(updated.error || "canonical_capability_design_bind_failed");
    }
    return {
      project: winner,
      revision: undefined,
      job: boundJob,
      reused: true as const,
      capabilityId: winner.activeCapabilityId || strictCapabilityId,
    };
  };

  const resumeWorkingRevision = async (
    claimed: CapabilityProject,
    ownWorking: CapabilityRevision,
  ) => {
    const capabilityId = claimed.activeCapabilityId
      || (explicitProjectId ? candidate.capability.id : strictCapabilityId);
    const revision: CapabilityRevision = {
      ...ownWorking,
      status: "building",
      stage: "design",
      implementationReleaseId: release.id,
      implementationReleaseVersion: release.version,
      candidateId: candidate.id,
      learningJobId: job.id,
      contract: undefined,
      parameterizationDecisions: candidate.authoring.parameterizationDecisions || [],
      implementation: revisionImplementationForCapability(release, {
        ...candidate.capability,
        id: capabilityId,
        kind,
      })
        || ownWorking.implementation,
      updatedAt: job.updatedAt,
    };
    const project = capabilityProjectForWrite({
      ...claimed,
      status: claimed.activeRevisionId ? claimed.status : "building",
      stage: claimed.activeRevisionId ? claimed.stage : "design",
      latestRevisionId: revision.id,
      revisionCount: Math.max(claimed.revisionCount, revision.number),
      buildStartedAt: claimed.buildStartedAt || job.createdAt,
      updatedAt: job.updatedAt > claimed.updatedAt ? job.updatedAt : claimed.updatedAt,
    });
    const boundJob: LearningJob = {
      ...job,
      result: { ...job.result, projectId: project.id, revisionId: revision.id },
    };
    const results = await database.batch([
      canonicalCapabilityProjectUpdateStatement(database, project),
      database.prepare(`UPDATE site_agent_v2_capability_revisions
        SET status=?,revision_json=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND project_id=? AND status<>'published'`)
        .bind(revision.status, JSON.stringify(revision), revision.updatedAt, revision.id, revision.siteAgentId, revision.projectId),
      database.prepare(`UPDATE site_agent_v2_learning_jobs
        SET result_json=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND status IN ('leased','running')`)
        .bind(JSON.stringify(boundJob), boundJob.updatedAt, boundJob.id, boundJob.siteAgentId),
    ]);
    const failure = results.find((result) => !result.success);
    if (failure
      || results.some((result) => Number(result.meta?.changes || 0) !== 1)) {
      throw new Error(failure?.error || "canonical_capability_design_resume_failed");
    }
    return { project, revision, job: boundJob, reused: false as const, capabilityId };
  };

  const createWorkingRevision = async (claimed: CapabilityProject) => {
    const capabilityId = claimed.activeCapabilityId
      || (explicitProjectId ? candidate.capability.id : strictCapabilityId);
    const maxRows = await all<{ maxNumber: number | string }>(
      database,
      `SELECT COALESCE(MAX(revision_number),0) AS maxNumber
         FROM site_agent_v2_capability_revisions
        WHERE site_agent_id=? AND project_id=?`,
      [job.siteAgentId, claimed.id],
    );
    const revisionNumber = Number(maxRows[0]?.maxNumber || 0) + 1;
    const revision: CapabilityRevision = {
      id: `revision_${stableHash(`${claimed.id}:${job.id}:${revisionNumber}`)}`,
      projectId: claimed.id,
      siteAgentId: job.siteAgentId,
      number: revisionNumber,
      status: "building",
      stage: "design",
      baseReleaseVersion: release.version,
      implementationReleaseId: release.id,
      implementationReleaseVersion: release.version,
      candidateId: candidate.id,
      learningJobId: job.id,
      parameterizationDecisions: candidate.authoring.parameterizationDecisions || [],
      implementation: revisionImplementationForCapability(release, {
        ...candidate.capability,
        id: capabilityId,
        kind,
      }),
      guidanceIds: [],
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
    const project = capabilityProjectForWrite({
      ...claimed,
      status: claimed.activeRevisionId ? claimed.status : "building",
      stage: claimed.activeRevisionId ? claimed.stage : "design",
      latestRevisionId: revision.id,
      revisionCount: Math.max(claimed.revisionCount, revision.number),
      buildStartedAt: claimed.buildStartedAt || job.createdAt,
      updatedAt: job.updatedAt > claimed.updatedAt ? job.updatedAt : claimed.updatedAt,
    });
    const boundJob: LearningJob = {
      ...job,
      result: { ...job.result, projectId: project.id, revisionId: revision.id },
    };
    const results = await database.batch([
      canonicalCapabilityProjectUpdateStatement(database, project),
      database.prepare(`INSERT INTO site_agent_v2_capability_revisions
        (id,project_id,site_agent_id,revision_number,status,revision_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .bind(
          revision.id,
          revision.projectId,
          revision.siteAgentId,
          revision.number,
          revision.status,
          JSON.stringify(revision),
          revision.createdAt,
          revision.updatedAt,
        ),
      database.prepare(`UPDATE site_agent_v2_learning_jobs
        SET result_json=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND status IN ('leased','running')`)
        .bind(JSON.stringify(boundJob), boundJob.updatedAt, boundJob.id, boundJob.siteAgentId),
    ]);
    const failure = results.find((result) => !result.success);
    if (failure
      || results.some((result) => Number(result.meta?.changes || 0) !== 1)) {
      throw new Error(failure?.error || "canonical_capability_revision_create_failed");
    }
    return { project, revision, job: boundJob, reused: false as const, capabilityId };
  };

  const claimExistingCanonicalProject = async (claimed: CapabilityProject) => {
    const revisionRows = await all<CapabilityRevisionRow>(
      database,
      `SELECT revision_json AS revisionJson
         FROM site_agent_v2_capability_revisions
        WHERE site_agent_id=? AND project_id=?
        ORDER BY revision_number DESC`,
      [job.siteAgentId, claimed.id],
    );
    const revisions = revisionRows.map((row) =>
      JSON.parse(row.revisionJson) as CapabilityRevision);
    const ownWorking = revisions.find((revision) =>
      revision.learningJobId === job.id
      && (revision.status === "building" || revision.status === "failed"));
    if (ownWorking) return resumeWorkingRevision(claimed, ownWorking);

    const activeRevision = claimed.activeRevisionId
      ? revisions.find((revision) =>
        revision.id === claimed.activeRevisionId && revision.status === "published")
      : undefined;
    if (activeRevision) return bindWinner(claimed, activeRevision.id, "published");

    const inFlightRevision = revisions.find((revision) =>
      revision.id === claimed.latestRevisionId
      && revision.learningJobId !== job.id
      && (revision.status === "building" || revision.status === "awaiting-review"));
    if (inFlightRevision?.learningJobId) {
      const ownerRows = await all<{ status: string }>(
        database,
        `SELECT status FROM site_agent_v2_learning_jobs
          WHERE id=? AND site_agent_id=?
            AND status IN ('queued','leased','running','awaiting-review')
          LIMIT 1`,
        [inFlightRevision.learningJobId, job.siteAgentId],
      );
      if (ownerRows[0]) {
        return bindWinner(claimed, inFlightRevision.id, "in-flight");
      }
    }
    return createWorkingRevision(claimed);
  };

  if (explicitProjectId) {
    const projectRows = await all<CapabilityProjectRow>(
      database,
      `SELECT project_json AS projectJson
         FROM site_agent_v2_capability_projects
        WHERE id=? AND site_agent_id=?
        LIMIT 1`,
      [explicitProjectId, job.siteAgentId],
    );
    if (!projectRows[0]) throw new Error("capability_project_not_found");
    const claimed = projectWithIdentityDefaults(
      JSON.parse(projectRows[0].projectJson) as CapabilityProject,
    );
    if (claimed.identityConflict) throw new Error("canonical_capability_identity_conflict");
    const currentContractFingerprint = capabilityContractFingerprint({
      kind: claimed.kind,
      resultKind: claimed.resultKind,
      structure: claimed.structure,
      operation: claimed.operation,
      inputs: claimed.inputSchema,
      outputs: claimed.outputSchema,
    });
    if (currentContractFingerprint !== proposedIdentity.contractFingerprint) {
      throw new Error("capability_contract_immutable");
    }
    const ownRows = await all<CapabilityRevisionRow>(
      database,
      `SELECT revision_json AS revisionJson
         FROM site_agent_v2_capability_revisions
        WHERE site_agent_id=? AND project_id=?
        ORDER BY revision_number DESC`,
      [job.siteAgentId, claimed.id],
    );
    const ownRevisions = ownRows.map((row) =>
      JSON.parse(row.revisionJson) as CapabilityRevision);
    const ownWorking = ownRevisions.find((revision) =>
      revision.learningJobId === job.id
      && (revision.status === "building" || revision.status === "failed"));
    if (ownWorking) return resumeWorkingRevision(claimed, ownWorking);
    return createWorkingRevision(claimed);
  }

  const exactPublishedCapability = exactCapabilityForGoal(release, episode.goal);
  if (exactPublishedCapability) {
    const publishedOwnerRows = await all<CapabilityProjectRow>(
      database,
      `SELECT project_json AS projectJson
         FROM site_agent_v2_capability_projects
        WHERE site_agent_id=?
          AND json_extract(project_json,'$.activeCapabilityId')=?
        LIMIT 3`,
      [job.siteAgentId, exactPublishedCapability.id],
    );
    if (publishedOwnerRows.length > 1) {
      throw new Error("canonical_capability_identity_conflict");
    }
    if (publishedOwnerRows[0]) {
      const publishedOwner = projectWithIdentityDefaults(
        JSON.parse(publishedOwnerRows[0].projectJson) as CapabilityProject,
      );
      if (publishedOwner.identityConflict) {
        throw new Error("canonical_capability_identity_conflict");
      }
      return claimExistingCanonicalProject(publishedOwner);
    }
  }

  const exactProjects = exactRows.map((row) =>
    projectWithIdentityDefaults(JSON.parse(row.projectJson) as CapabilityProject));
  if (exactProjects.some((project) => Boolean(project.identityConflict))) {
    throw new Error("canonical_capability_identity_conflict");
  }
  if (exactRows.length > 1) throw new Error("canonical_capability_identity_conflict");

  if (exactRows[0]) {
    const claimed = projectWithIdentityDefaults(JSON.parse(exactRows[0].projectJson) as CapabilityProject);
    return claimExistingCanonicalProject(claimed);
  }

  const maxRows = await all<{ maxNumber: number | string }>(
    database,
    `SELECT COALESCE(MAX(revision_number),0) AS maxNumber
       FROM site_agent_v2_capability_revisions
      WHERE site_agent_id=? AND project_id=?`,
    [job.siteAgentId, proposedIdentity.id],
  );
  const revisionNumber = Number(maxRows[0]?.maxNumber || 0) + 1;
  const revisionId = `revision_${stableHash(`${proposedIdentity.id}:${job.id}:${revisionNumber}`)}`;
  const revision: CapabilityRevision = {
    id: revisionId,
    projectId: proposedIdentity.id,
    siteAgentId: job.siteAgentId,
    number: revisionNumber,
    status: "building",
    stage: "design",
    baseReleaseVersion: release.version,
    implementationReleaseId: release.id,
    implementationReleaseVersion: release.version,
    candidateId: candidate.id,
    learningJobId: job.id,
    parameterizationDecisions: candidate.authoring.parameterizationDecisions || [],
    implementation: revisionImplementationForCapability(release, {
      ...candidate.capability,
      id: strictCapabilityId,
      kind,
    }),
    guidanceIds: [],
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  const project = capabilityProjectForWrite({
    ...proposedIdentity,
    latestRevisionId: revision.id,
    revisionCount: revision.number,
  });
  const boundJob: LearningJob = {
    ...job,
    result: { ...job.result, projectId: project.id, revisionId: revision.id },
  };
  const guardKey = `capability_claim_guard:${job.siteAgentId}:${job.id}`;
  const guardValue = `${project.id}:${revision.id}`;
  let claimError: unknown;
  try {
    const results = await database.batch([
      canonicalCapabilityProjectStatement(database, project, "insert"),
      database.prepare(`INSERT INTO site_agent_v2_capability_revisions
        (id,project_id,site_agent_id,revision_number,status,revision_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .bind(revision.id, revision.projectId, revision.siteAgentId, revision.number, revision.status, JSON.stringify(revision), revision.createdAt, revision.updatedAt),
      database.prepare(`UPDATE site_agent_v2_learning_jobs SET result_json=?,updated_at=? WHERE id=? AND site_agent_id=?`)
        .bind(JSON.stringify(boundJob), boundJob.updatedAt, boundJob.id, boundJob.siteAgentId),
      database.prepare(`INSERT OR REPLACE INTO site_agent_v2_meta (key,value,updated_at)
        VALUES (?,CASE WHEN
          EXISTS (SELECT 1 FROM site_agent_v2_capability_projects
            WHERE id=? AND site_agent_id=? AND latest_revision_id=?)
          AND EXISTS (SELECT 1 FROM site_agent_v2_capability_revisions
            WHERE id=? AND site_agent_id=? AND project_id=?)
          AND EXISTS (SELECT 1 FROM site_agent_v2_learning_jobs
            WHERE id=? AND site_agent_id=?
              AND json_extract(result_json,'$.result.projectId')=?)
          THEN ? ELSE NULL END,?)`)
        .bind(
          guardKey,
          project.id,
          project.siteAgentId,
          revision.id,
          revision.id,
          revision.siteAgentId,
          revision.projectId,
          boundJob.id,
          boundJob.siteAgentId,
          project.id,
          guardValue,
          job.updatedAt,
        ),
      database.prepare(`DELETE FROM site_agent_v2_meta WHERE key=? AND value=?`)
        .bind(guardKey, guardValue),
    ]);
    const failure = results.find((result) => !result.success);
    if (failure) claimError = new Error(failure.error || "canonical_capability_design_claim_failed");
  } catch (error) {
    claimError = error;
  }
  if (!claimError) {
    return {
      project,
      revision,
      job: boundJob,
      reused: false as const,
      capabilityId: strictCapabilityId,
    };
  }

  // The identity insert is intentionally not ignored. A concurrent winner
  // commits the root+Revision+Job batch first; only then does the loser resolve
  // and bind to that complete root.
  const winnerRows = await all<CapabilityProjectRow>(
    database,
    `SELECT project_json AS projectJson
       FROM site_agent_v2_capability_projects
      WHERE site_agent_id=? AND stable_key=? AND contract_fingerprint=?
      LIMIT 2`,
    [job.siteAgentId, proposedIdentity.stableKey, proposedIdentity.contractFingerprint],
  );
  if (winnerRows.length === 1) {
    return claimExistingCanonicalProject(
      projectWithIdentityDefaults(JSON.parse(winnerRows[0].projectJson) as CapabilityProject),
    );
  }
  if (winnerRows.length > 1) throw new Error("canonical_capability_identity_conflict");
  throw claimError;
}

async function persistGeneratedCapabilitySpec(
  database: D1DatabaseLike,
  job: LearningJob,
  episode: TaskEpisode,
  candidate: KnowledgeCandidate,
  identity?: { projectId: string; revisionId: string },
) {
  if (!candidate.authoring) return undefined;
  const projectId = identity?.projectId
    || projectIdForLearningJob({ ...job, intentKey: candidate.authoring.intentKey || job.intentKey });
  const revisionId = identity?.revisionId || `revision_${stableHash(`${projectId}:${job.id}`)}`;
  const existing = await all<{ specJson: string }>(database, `SELECT spec_json AS specJson FROM site_agent_v2_capability_spec_docs WHERE site_agent_id=? AND project_id=? AND revision_id=? ORDER BY version DESC LIMIT 1`, [job.siteAgentId, projectId, revisionId]);
  if (existing[0]) return JSON.parse(existing[0].specJson) as CapabilitySpecDoc;
  const now = new Date().toISOString();
  const inputs = candidate.authoring.requiredInputs || [];
  const results = candidate.authoring.resultFields || [];
  const smokeInput = Object.fromEntries(inputs.flatMap((field) => {
    const value = field.value ?? field.examples?.[0] ?? episode.input[field.id];
    return value === undefined ? [] : [[field.id, value]];
  })) as Record<string, JsonValue>;
  const spec: CapabilitySpecDoc = {
    id: uid("spec_doc"), siteAgentId: job.siteAgentId, projectId, revisionId, version: 1,
    intent: candidate.capability.description || candidate.capability.name,
    whenToUse: `当用户提出“${candidate.authoring.goalTemplate || candidate.capability.name}”这一类目标时使用。`,
    inputsNarrative: inputs.length ? inputs.map((field) => `${field.name || field.id}（${field.type}）`).join("、") : "无需额外输入。",
    resultNarrative: results.length ? `返回${results.map((field) => field.name || field.id).join("、")}。` : "返回任务执行结果。",
    scenarios: [{ id: "observed-success", title: "真实成功输入", given: `从 ${episode.startSnapshot.url} 开始`, when: episode.goal, then: episode.outcome.summary.slice(0, 400), sampleInput: Object.keys(smokeInput).length ? smokeInput : episode.input, expectedOutcome: "success" }],
    nonGoals: [], openQuestions: [],
    projected: { inputs: candidate.capability.inputs, resultFields: results.map((field) => ({ ...field, importance: field.importance || "core" })), intentKey: candidate.authoring.intentKey, reuseDecision: candidate.authoring.reuseDecision === "strengthen-capability" ? "strengthen" : "create" },
    source: "program", createdAt: now, updatedAt: now,
  };
  const versionRows = await all<{ version: number }>(database, `SELECT version FROM site_agent_v2_capability_spec_docs WHERE site_agent_id=? AND project_id=? ORDER BY version DESC LIMIT 1`, [job.siteAgentId, projectId]);
  const stored = { ...spec, version: (versionRows[0]?.version || 0) + 1 };
  const result = await database.prepare(`INSERT INTO site_agent_v2_capability_spec_docs (id,site_agent_id,project_id,revision_id,version,spec_json,created_at) VALUES (?,?,?,?,?,?,?)`).bind(stored.id, stored.siteAgentId, stored.projectId, stored.revisionId, stored.version, JSON.stringify(stored), stored.createdAt).run();
  if (!result.success) throw new Error(result.error || "capability_spec_save_failed");
  return stored;
}

async function episodeById(database: D1DatabaseLike, siteAgentId: string, episodeId: string) {
  const rows = await all<{ episodeJson: string }>(database, `SELECT episode_json AS episodeJson FROM site_agent_v2_episodes WHERE id=? AND site_agent_id=? LIMIT 1`, [episodeId, siteAgentId]);
  return rows[0] ? JSON.parse(rows[0].episodeJson) as TaskEpisode : undefined;
}

function capabilityExperienceOutboxId(authority: CapabilityExperienceAuthority) {
  return `capability_experience:${authority.siteAgentId}:${authority.episodeId}:${authority.kind}`;
}

function enqueueMemoryCapabilityExperience(authority: CapabilityExperienceAuthority, now: string) {
  const root = globalThis as MemoryRoot;
  root.__SITEWAKE_CAPABILITY_EXPERIENCE_OUTBOX_V3__ ||= new Map();
  const id = capabilityExperienceOutboxId(authority);
  const expected = JSON.stringify({
    siteAgentId: authority.siteAgentId,
    runId: authority.runId,
    episodeId: authority.episodeId,
    authority: authority.kind,
    sourceCapabilityId: authority.sourceCapabilityId,
    sourceVersionId: authority.sourceVersionId,
    observationRefs: authority.observationRefs,
  });
  const existing = root.__SITEWAKE_CAPABILITY_EXPERIENCE_OUTBOX_V3__.get(id);
  if (existing) {
    const actual = JSON.stringify({
      siteAgentId: existing.siteAgentId,
      runId: existing.runId,
      episodeId: existing.episodeId,
      authority: existing.authority,
      sourceCapabilityId: existing.sourceCapabilityId,
      sourceVersionId: existing.sourceVersionId,
      observationRefs: existing.observationRefs,
    });
    if (actual !== expected) throw new Error("capability_experience_outbox_conflict");
    return;
  }
  root.__SITEWAKE_CAPABILITY_EXPERIENCE_OUTBOX_V3__.set(id, {
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
  });
}

function capabilityExperienceOutboxStatement(
  database: D1DatabaseLike,
  authority: CapabilityExperienceAuthority,
  now: string,
) {
  return database.prepare(`INSERT OR IGNORE INTO site_agent_v3_capability_experience_outbox
    (id,site_agent_id,run_id,episode_id,authority_kind,authority,source_capability_id,source_version_id,observation_refs_json,status,attempts,next_attempt_at,result_json,last_error,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    capabilityExperienceOutboxId(authority),
    authority.siteAgentId,
    authority.runId,
    authority.episodeId,
    authority.kind,
    authority.kind,
    authority.sourceCapabilityId || null,
    authority.sourceVersionId || null,
    JSON.stringify(authority.observationRefs),
    "pending",
    0,
    null,
    null,
    null,
    now,
    now,
  );
}

/** Internal evidence loader used by the capability-experience outbox worker. */
export async function getTaskEpisodeById(siteAgentId: string, episodeId: string) {
  const database = getD1Binding();
  if (!database) {
    return {
      episode: memoryAgent(siteAgentId).episodes.find((item) => item.id === episodeId),
      persistence: "memory" as const,
    };
  }
  await ensureSiteAgentV2Schema(database);
  return {
    episode: await episodeById(database, siteAgentId, episodeId),
    persistence: "d1" as const,
  };
}

async function candidateById(database: D1DatabaseLike, siteAgentId: string, candidateId: string) {
  const rows = await all<CandidateRow>(database, `SELECT candidate_json AS candidateJson FROM site_agent_v2_candidates WHERE id=? AND site_agent_id=? LIMIT 1`, [candidateId, siteAgentId]);
  return rows[0] ? JSON.parse(rows[0].candidateJson) as KnowledgeCandidate : undefined;
}

function validatedCandidateContentHash(
  candidate: KnowledgeCandidate,
  revision?: CapabilityRevision,
) {
  if (revision?.implementation?.kind === "navigation-tool") {
    return stableHash(JSON.stringify({
      candidate,
      navigationToolRef: revision.implementation.toolRef,
    }));
  }
  return stableHash(JSON.stringify(candidate));
}

function revisionReviewId(
  revisionId: string,
  validationRunId: string,
  validatedContentHash: string,
  status: RevisionReview["status"],
) {
  return `review_${stableHash(`${revisionId}:${validationRunId}:${validatedContentHash}:${status}`)}`;
}

async function saveLearningJob(database: D1DatabaseLike, job: LearningJob) {
  const result = await database.prepare(`UPDATE site_agent_v2_learning_jobs SET status=?,result_json=?,updated_at=? WHERE id=? AND site_agent_id=?`)
    .bind(job.status, JSON.stringify(job), job.updatedAt, job.id, job.siteAgentId).run();
  if (!result.success) throw new Error(result.error || "learning_job_update_failed");
}

export function isHealthyDiscardedParameter(evidence: string, reason: string) {
  return /(内部|索引|导航项|页面布局|选择器|非业务输入|非输入|不属于.*(?:用户|业务)输入|无需.*(?:用户|业务)输入|点击结果|结果而非输入|页面显示|与用户.*无关|未在目标中提及|incidental|not (?:a )?(?:user|business) input|result value)/i.test(`${evidence} ${reason}`);
}

function contractIntegrityFailure(episode: TaskEpisode, candidate: KnowledgeCandidate) {
  const authoring = candidate.authoring;
  if (!authoring) return "AI 没有生成参数化决策。";
  // The model may explicitly discard DOM indexes, result values, or unrelated
  // page context. Those are healthy decisions, not incomplete contracts. Only
  // a rejected value that belongs to the user's requested business input must
  // stop authoring.
  const rejected = authoring.parameterizationDecisions?.find((decision) => decision.decision === "reject" && !isHealthyDiscardedParameter(decision.evidence || "", decision.reason || ""));
  if (rejected) return rejected.reason || `经验值 ${String(rejected.observedValue || "")} 尚未被可靠参数化。`;
  const ordinalExperience = /(第\s*[一二三四五六七八九十百千万两\d]+\s*(?:个|条|名|项|位)|top\s*\d+)/i.test(episode.goal);
  if (ordinalExperience) {
    const rank = authoring.requiredInputs?.find((field) => field.id === "rank" && field.type === "number");
    const rankDecision = authoring.parameterizationDecisions?.find((decision) => decision.decision === "input" && decision.inputId === "rank");
    if (!rank || !rankDecision || !/\{rank\}/.test(authoring.goalTemplate || "")) return "经验包含具体序号；必须生成 rank:number 输入，并在目标模板中使用 {rank}。";
  }
  for (const field of authoring.requiredInputs || []) {
    if (field.value === undefined) continue;
    const decided = authoring.parameterizationDecisions?.some((decision) => decision.decision === "input" && decision.inputId === field.id);
    if (!decided) return `具体样例值尚未解释为业务输入：${field.name || field.id}。`;
  }
  return undefined;
}

function reusableReleaseOperation(release: SiteAgentReleaseV2, candidate: KnowledgeCandidate) {
  if (candidate.capability.resultKind !== "page") return undefined;
  if ((candidate.authoring?.requiredInputs || []).length) return undefined;
  if ((candidate.authoring?.resultFields || []).some((field) => field.source === "extracted")) return undefined;
  const goal = normalizeGoal(`${candidate.capability.name} ${candidate.authoring?.goalTemplate || ""}`).replace(/(打开|查看|进入|前往|去到|浏览)/g, "");
  return release.operations
    .filter((operation) => (operation.status === "verified" || operation.status === "published") && operation.implementations.length > 0 && operation.toSceneId && operation.applicability)
    .map((operation) => {
      const scene = release.scenes.find((item) => item.id === operation.toSceneId);
      const terms = [operation.name, scene?.name || ""].map((value) => normalizeGoal(value).replace(/(打开|查看|进入|前往|去到|浏览)/g, "")).filter((value) => value.length >= 2);
      const score = Math.max(0, ...terms.map((term) => goal.includes(term) ? term.length : 0));
      return { operation, score };
    })
    .filter((item) => item.score >= 2)
    .sort((left, right) => right.score - left.score)[0]?.operation;
}

function jsonValueType(value: JsonValue): "string" | "number" | "boolean" | "object" | "array" {
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

type DesignedCandidate = KnowledgeCandidate & { authoring: NonNullable<KnowledgeCandidate["authoring"]> };

/**
 * A pure "open/go to page" request has one stable public promise. The model
 * may describe the same destination with incidental fields such as `url`,
 * `heading` or `cartPageUrl`; those are implementation evidence, not distinct
 * Capability contracts. Normalize before strict identity is claimed so an
 * identical BuildRequest cannot create a parallel Capability root.
 */
function canonicalPureNavigationCandidate(candidate: DesignedCandidate): DesignedCandidate {
  const outputs = {
    type: "object" as const,
    properties: {
      pageUrl: { type: "string" as const, description: "到达页面 URL" },
      pageTitle: { type: "string" as const, description: "到达页面标题" },
    },
    required: ["pageUrl", "pageTitle"],
  };
  const outputBindings = {
    pageUrl: { source: "state" as const, path: "__pageUrl" },
    pageTitle: { source: "state" as const, path: "__pageTitle" },
  };
  return {
    ...candidate,
    operations: candidate.operations.map((operation) => ({
      ...operation,
      kind: "navigation",
      outputs,
    })),
    capability: {
      ...candidate.capability,
      kind: "navigation",
      resultKind: "page",
      outputs,
      plans: candidate.capability.plans.map((plan) => ({
        ...plan,
        outputBindings,
      })),
    },
    authoring: {
      ...candidate.authoring,
      capabilityKind: "navigation",
      resultArchetype: "navigation",
      resultFields: [
        {
          id: "pageUrl",
          name: "到达页面 URL",
          type: "string",
          source: "page-url",
          importance: "metadata",
        },
        {
          id: "pageTitle",
          name: "到达页面标题",
          type: "string",
          source: "page-title",
          importance: "metadata",
        },
      ],
    },
  };
}

function hasOnlyPageMetadataResults(candidate: DesignedCandidate) {
  const resultFields = candidate.authoring.resultFields || [];
  const schemaFieldIds = Object.keys(candidate.capability.outputs.properties || {});
  const fields = [
    ...resultFields.map((field) => ({
      id: field.id,
      source: field.source,
    })),
    ...schemaFieldIds
      .filter((id) => !resultFields.some((field) => field.id === id))
      .map((id) => ({ id, source: undefined })),
  ];
  return fields.every((field) => {
    if (field.source === "page-url" || field.source === "page-title" || field.source === "page-heading") {
      return true;
    }
    const id = field.id.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    return id === "sceneid"
      || id === "url"
      || id === "uri"
      || id === "href"
      || id === "link"
      || id === "title"
      || id === "heading"
      || id.endsWith("pageurl")
      || id.endsWith("pagetitle")
      || id.endsWith("pageheading")
      || id.endsWith("destinationurl")
      || id.endsWith("targeturl")
      || id.endsWith("currenturl")
      || id.endsWith("finalurl");
  });
}

function inferredTaskInput(episode: TaskEpisode) {
  if (Object.keys(episode.input).length) return episode.input;
  const normalizedGoal = episode.goal.normalize("NFKC");
  const searchGoal = /(?:搜索|搜一下|搜|查找|检索|查询)(?:一下)?\s*(.+)/u.exec(normalizedGoal);
  if (!searchGoal) return {};
  const urlValues: Array<{ key: string; value: string }> = [];
  for (const rawUrl of [episode.startSnapshot.url, episode.endSnapshot.url]) {
    try {
      const url = new URL(rawUrl);
      for (const [key, value] of url.searchParams) {
        const decoded = value.trim();
        if (decoded.length >= 2 && normalizedGoal.includes(decoded)) urlValues.push({ key, value: decoded });
      }
      for (const value of url.pathname.split("/").filter(Boolean).map((part) => {
        try { return decodeURIComponent(part).trim(); } catch { return part.trim(); }
      })) {
        if (value.length >= 2 && normalizedGoal.includes(value)) urlValues.push({ key: "keyword", value });
      }
    } catch { /* malformed evidence URL: fall back to the explicit goal */ }
  }
  const observed = urlValues.sort((left, right) => right.value.length - left.value.length)[0];
  if (observed) {
    const id = /^(?:q|query|search|kw|key|term)$/i.test(observed.key) ? "keyword" : observed.key.replace(/[^a-zA-Z0-9_-]/g, "_") || "keyword";
    return { [id]: observed.value };
  }
  // A short value immediately following an explicit search verb is still
  // user-supplied evidence. Keep the fallback deliberately narrow so a whole
  // instruction sentence cannot accidentally become one giant parameter.
  const value = searchGoal[1].trim().replace(/[，。！？?]+$/u, "");
  return value && value.length <= 80 && !/\s/u.test(value) ? { keyword: value } : {};
}

/**
 * Turns one successful episode into the single authoring specification used by
 * Codex when semantic design is temporarily unavailable. User-triggered gaps
 * must still be assessed by the semantic model; explicit administrator goals
 * may use this fallback because the administrator already authorized creation.
 */
function designCandidateFromEvidence(episode: TaskEpisode, candidate: KnowledgeCandidate): DesignedCandidate {
  if (candidate.authoring?.stage === "designed") return candidate as DesignedCandidate;
  const inferredInput = inferredTaskInput(episode);
  const inputEntries = Object.entries(inferredInput);
  const completedOutputs = (episode.experience?.toolReceipts || [])
    .filter((receipt) => receipt.status === "completed" && receipt.output)
    .reduce<Record<string, JsonValue>>((all, receipt) => ({ ...all, ...receipt.output }), {});
  const goalTemplate = inputEntries.reduce((goal, [id, value]) => {
    const observed = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
    return observed ? goal.split(observed).join(`{${id}}`) : goal;
  }, episode.goal);
  const requiredInputs = inputEntries.map(([id, value]) => ({
    id, name: candidate.capability.inputs.properties?.[id]?.description || id, type: jsonValueType(value) === "number" || jsonValueType(value) === "boolean" ? jsonValueType(value) as "number" | "boolean" : "string" as const, value: value as string | number | boolean,
  }));
  const inputs = {
    type: "object" as const,
    properties: Object.fromEntries(requiredInputs.map((field) => [field.id, {
      type: field.type,
      description: field.name,
      examples: field.value === undefined ? undefined : [field.value],
    }])),
    required: requiredInputs.map((field) => field.id),
  };
  const resultFields: NonNullable<DesignedCandidate["authoring"]["resultFields"]> = Object.entries(completedOutputs).map(([id, value]) => ({
    id, name: id, type: jsonValueType(value), source: Object.prototype.hasOwnProperty.call(episode.input, id) ? "input" as const : "extracted" as const, importance: "core" as const,
  }));
  if (!resultFields.some((field) => field.id === "pageUrl")) resultFields.push({ id: "pageUrl", name: "完成后的页面地址", type: "string", source: "page-url", importance: "metadata" });
  if (!resultFields.some((field) => field.id === "pageTitle")) resultFields.push({ id: "pageTitle", name: "完成后的页面标题", type: "string", source: "page-title", importance: "metadata" });
  const outputs = {
    type: "object" as const,
    properties: Object.fromEntries(resultFields.map((field) => [field.id, { type: field.type, description: field.name }])),
    required: resultFields.filter((field) => field.importance === "core").map((field) => field.id),
  };
  const intentKey = candidate.authoring?.intentKey || `intent_${stableHash(normalizeGoal(goalTemplate || episode.goal))}`;
  const capabilityKind = classifyGoal(episode.goal) === "navigation" ? "navigation" as const : "task" as const;
  return {
    ...candidate,
    normalizedGoal: normalizeGoal(goalTemplate || episode.goal),
    capability: {
      ...candidate.capability,
      kind: capabilityKind,
      exposure: candidate.capability.exposure || "public",
      name: candidate.capability.name || episode.goal,
      description: candidate.capability.description || episode.outcome.summary,
      goalTemplate,
      inputs,
      outputs,
      resultKind: resultFields.some((field) => field.importance === "core") ? "data" : "page",
    },
    operations: candidate.operations.map((operation) => ({ ...operation, inputs })),
    authoring: {
      ...candidate.authoring,
      stage: "designed",
      reusableTrace: false,
      intentKey,
      capabilityKind,
      reason: "已从一次真实成功任务生成能力规格，交给 Codex 编写并冒烟试跑。",
      goalTemplate,
      requiredInputs,
      parameterizationDecisions: requiredInputs.map((field) => ({ id: `parameter_${stableHash(`${candidate.id}:${field.id}:${String(field.value)}`)}`, observedValue: field.value!, evidence: "来自真实成功任务输入", decision: "input" as const, inputId: field.id, reason: `保留为业务输入 ${field.name}` })),
      resultFields,
      reuseDecision: "create-capability",
      reuseReason: "使用同一份真实任务证据生成规格与程序，不再调用独立设计模型。",
    },
    updatedAt: new Date().toISOString(),
  } as DesignedCandidate;
}

async function designLearningJob(database: D1DatabaseLike, job: LearningJob) {
  const episode = await episodeById(database, job.siteAgentId, job.sourceEpisodeId);
  const candidate = await candidateById(database, job.siteAgentId, job.candidateId);
  if (!episode || !candidate) throw new Error("learning_job_evidence_missing");
  let running = job.receipts?.some((receipt) => receipt.stage === "evidence") ? job : updateReceipt(job, "evidence", {
    actor: episode.mode === "demonstration" ? "user" : "program", status: "passed", title: "获得一次真实成功经验", summary: episode.outcome.summary,
    startedAt: episode.startedAt, endedAt: episode.endedAt, evidence: { episodeId: episode.id, startUrl: episode.startSnapshot.url, endUrl: episode.endSnapshot.url },
  });
  running = updateReceipt({ ...running, status: "running", attempts: job.attempts + 1 }, "design", {
    actor: "program", status: "running", title: "正在生成能力规范", summary: "从真实成功任务确定目标、输入、结果与冒烟场景。", startedAt: new Date().toISOString(),
  });
  await saveLearningJob(database, running);
  const goalClass = classifyGoal(episode.goal);
  if (goalClass === "conversation") {
    const reuseDecision = "conversation-only";
    const completed = updateReceipt({
      ...running,
      status: "completed",
      result: {
        ...running.result,
        reuseDecision,
        reuseReason: "这是一次对话回答，不是可重放的网站任务。",
      },
    }, "design", {
      actor: "program",
      status: "passed",
      title: "识别为普通对话",
      summary: "不会生成 Capability、Operation 或导航资产。",
      endedAt: new Date().toISOString(),
      evidence: { goalClass, startUrl: episode.startSnapshot.url, endUrl: episode.endSnapshot.url },
    });
    await saveLearningJob(database, completed);
    return;
  }
  if (goalClass === "navigation" && episode.mode !== "author-request") {
    const completed = updateReceipt({
      ...running,
      status: "completed",
      result: {
        ...running.result,
        reuseDecision: "navigation-tool",
        reuseReason: "这是已有导航证据，由网站知识编译为 Navigation Tool，不重复进入自主探索队列。",
      },
    }, "design", {
      actor: "program",
      status: "passed",
      title: "归入网站导航工具",
      summary: "现有导航证据继续由 Navigation Compiler 增量维护。",
      endedAt: new Date().toISOString(),
      evidence: { goalClass, startUrl: episode.startSnapshot.url, endUrl: episode.endSnapshot.url },
    });
    await saveLearningJob(database, completed);
    return;
  }
  const otherCandidates = await d1Candidates(database, job.siteAgentId);
  const origin = job.origin || candidate.capability.origin || (episode.mode === "author-request" ? "administrator" : "user-triggered");
  const releaseBeforeDesign = await immutableActiveReleaseForRevision(
    database,
    job.siteAgentId,
  );
  const existingIntents = [
    ...releaseBeforeDesign.capabilities
      .filter((capability) => capability.exposure !== "internal")
      .map((capability) => ({
        intentKey: `capability_${capability.id}`,
        capabilityId: capability.id,
        origin: capability.origin,
        name: capability.name,
        goalTemplate: capability.goalTemplate,
      })),
    ...otherCandidates.flatMap((item) => item.authoring?.intentKey ? [{
      intentKey: item.authoring.intentKey,
      capabilityId: item.capability.id,
      origin: item.capability.origin,
      name: item.capability.name,
      goalTemplate: item.authoring.goalTemplate,
    }] : []),
  ];
  const semanticCandidate = await designCapabilityContract(episode, candidate, {
    existingIntents,
    telemetry: {
      learningJobId: job.id,
      record: async (invocation) => { await recordModelInvocation(invocation); },
    },
  });
  // An administrator explicitly asked the system to build this capability, so
  // the semantic pass defines its inputs and business outputs but may not turn
  // the request into "do not persist". User-triggered work keeps the model's
  // reuse assessment because one successful user task is not automatically a
  // shared capability.
  const designedCandidate = origin === "user-triggered"
    ? semanticCandidate
    : semanticCandidate?.authoring
      ? {
        ...semanticCandidate,
        authoring: {
          ...semanticCandidate.authoring,
          reuseDecision: semanticCandidate.authoring.reuseDecision === "strengthen-capability"
            ? "strengthen-capability" as const
            : "create-capability" as const,
          evolutionAssessment: semanticCandidate.authoring.evolutionAssessment
            ? {
              ...semanticCandidate.authoring.evolutionAssessment,
              decision: semanticCandidate.authoring.reuseDecision === "strengthen-capability"
                ? "strengthen" as const
                : "create" as const,
            }
            : undefined,
        },
      }
      : designCandidateFromEvidence(episode, candidate);
  if (!designedCandidate?.authoring) throw new Error("ai_capability_assessment_unavailable");
  let designed: KnowledgeCandidate & { authoring: NonNullable<KnowledgeCandidate["authoring"]> } = {
    ...designedCandidate,
    capability: {
      ...designedCandidate.capability,
      origin: designedCandidate.authoring.reuseDecision === "strengthen-capability"
        ? designedCandidate.capability.origin || origin
        : origin,
    },
    authoring: {
      ...designedCandidate.authoring,
      evolutionAssessment: designedCandidate.authoring.evolutionAssessment
        ? { ...designedCandidate.authoring.evolutionAssessment, sourceEpisodeId: episode.id }
        : undefined,
    },
  };
  if (
    goalClass === "navigation"
    && inferResultArchetype(episode.goal) === "navigation"
    && !explicitlyRequestsStructuredResult(episode.goal)
    && hasOnlyPageMetadataResults(designed)
  ) {
    designed = canonicalPureNavigationCandidate(designed);
  }
  const exactPublishedCapability = exactCapabilityForGoal(
    releaseBeforeDesign,
    episode.goal,
  );
  designed = exactPublishedCapability
    ? pinCapabilityContract(designed, exactPublishedCapability)
    : pinStrengthenedCapabilityContract(releaseBeforeDesign, designed);
  if (designed.authoring.reuseDecision === "conversation-only" || designed.authoring.reuseDecision === "do-not-persist") {
    const reuseReason = designed.authoring.reuseReason || "这次回答不构成可以在网站中稳定重放和验证的共享能力。";
    const completed = updateReceipt({
      ...running,
      origin,
      candidateId: designed.id,
      intentKey: designed.authoring.intentKey,
      goalTemplate: designed.authoring.goalTemplate,
      status: "completed",
      result: { ...running.result, reuseDecision: designed.authoring.reuseDecision, reuseReason, evolutionAssessment: designed.authoring.evolutionAssessment || null },
    }, "design", {
      actor: "ai",
      status: "passed",
      title: designed.authoring.reuseDecision === "conversation-only" ? "识别为普通对话" : "AI 判断无需沉淀为通用能力",
      summary: reuseReason,
      endedAt: new Date().toISOString(),
      evidence: {
        reuseDecision: designed.authoring.reuseDecision,
        reuseReason,
        factors: designed.authoring.evolutionAssessment?.factors || [],
      },
    });
    const results = await database.batch([
      database.prepare(`INSERT OR REPLACE INTO site_agent_v2_candidates (id,site_agent_id,normalized_goal,status,base_release_version,candidate_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
        .bind(designed.id, job.siteAgentId, designed.normalizedGoal, "pending", designed.baseReleaseVersion, JSON.stringify(designed), designed.createdAt, designed.updatedAt),
      database.prepare(`UPDATE site_agent_v2_learning_jobs SET status=?,result_json=?,updated_at=? WHERE id=? AND site_agent_id=?`)
        .bind(completed.status, JSON.stringify(completed), completed.updatedAt, completed.id, completed.siteAgentId),
    ]);
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "reuse_decision_save_failed");
    return;
  }
  const suppression = matchingCapabilitySuppression(
    await activeCapabilitySuppressions(database, job.siteAgentId),
    designed.authoring.goalTemplate || episode.goal,
    designed.authoring.intentKey,
  );
  if (suppression && origin !== "administrator") {
    const reason = `管理员已下架“${suppression.name}”，相同或相似意图不会自动重新生成。`;
    designed = {
      ...designed,
      authoring: {
        ...designed.authoring,
        reuseDecision: "suppressed",
        reuseReason: reason,
        evolutionAssessment: {
          decision: "suppressed",
          summary: reason,
          factors: [{ label: "管理员策略", evidence: suppression.reason }],
          analyzedAt: new Date().toISOString(),
          sourceEpisodeId: episode.id,
        },
      },
    };
    const completed = updateReceipt({
      ...running,
      origin,
      candidateId: designed.id,
      intentKey: designed.authoring.intentKey,
      goalTemplate: designed.authoring.goalTemplate,
      status: "completed",
      result: { ...running.result, reuseDecision: "suppressed", reuseReason: reason, suppressionId: suppression.id },
    }, "design", {
      actor: "release-gate",
      status: "skipped",
      title: "管理员策略阻止自动重新生成",
      summary: reason,
      endedAt: new Date().toISOString(),
      evidence: { suppressionId: suppression.id, intentKey: suppression.intentKey },
    });
    const results = await database.batch([
      database.prepare(`INSERT OR REPLACE INTO site_agent_v2_candidates (id,site_agent_id,normalized_goal,status,base_release_version,candidate_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
        .bind(designed.id, job.siteAgentId, designed.normalizedGoal, "failed", designed.baseReleaseVersion, JSON.stringify(designed), designed.createdAt, designed.updatedAt),
      database.prepare(`UPDATE site_agent_v2_learning_jobs SET status=?,result_json=?,updated_at=? WHERE id=? AND site_agent_id=?`)
        .bind(completed.status, JSON.stringify(completed), completed.updatedAt, completed.id, completed.siteAgentId),
    ]);
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "capability_suppression_save_failed");
    return;
  }
  const contractFailure = contractIntegrityFailure(episode, designed);
  if (contractFailure) {
    const failed = updateReceipt({
      ...running,
      candidateId: designed.id,
      intentKey: designed.authoring.intentKey,
      goalTemplate: designed.authoring.goalTemplate,
      status: "failed",
      failure: { code: "contract_incomplete", summary: contractFailure },
    }, "design", {
      status: "failed",
      title: "能力契约缺少必要参数",
      summary: contractFailure,
      endedAt: new Date().toISOString(),
      evidence: { parameterizationDecisions: designed.authoring.parameterizationDecisions || [] },
    });
    const results = await database.batch([
      database.prepare(`INSERT OR REPLACE INTO site_agent_v2_candidates (id,site_agent_id,normalized_goal,status,base_release_version,candidate_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
        .bind(designed.id, job.siteAgentId, designed.normalizedGoal, "pending", designed.baseReleaseVersion, JSON.stringify(designed), designed.createdAt, designed.updatedAt),
      database.prepare(`UPDATE site_agent_v2_learning_jobs SET status=?,result_json=?,updated_at=? WHERE id=? AND site_agent_id=?`)
        .bind(failed.status, JSON.stringify(failed), failed.updatedAt, failed.id, failed.siteAgentId),
    ]);
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "contract_gate_save_failed");
    return;
  }
  const intentKey = designed.authoring.intentKey || designed.normalizedGoal;
  designed = {
    ...designed,
    normalizedGoal: normalizeGoal(designed.authoring.goalTemplate || designed.capability.name),
    capability: { ...designed.capability, kind: designed.authoring.capabilityKind || "task" },
    updatedAt: new Date().toISOString(),
  };
  // An explicit Capability rebuild must author a fresh implementation for the
  // existing root. Reusing an older Candidate here would silently validate the
  // already-published module and create no real Revision evolution.
  const existing = job.result?.rawExperienceOnly
    ? undefined
    : otherCandidates
      .filter((item) =>
        // The persisted request Candidate is the only row that represents the
        // current request. The semantic model may deliberately return the id
        // of an older matching Candidate, so excluding `designed.id` would
        // discard the authored implementation we are trying to reuse.
        item.id !== candidate.id
        && item.authoring?.intentKey === intentKey
        && candidatesShareStrictCapabilityIdentity(item, designed!))
      .toSorted((left, right) =>
        Number(right.authoring?.stage === "authored")
          - Number(left.authoring?.stage === "authored"))[0];
  const reuseAuthoredProgram = existing?.authoring?.stage === "authored" && existing.operations.length > 0 && existing.capability.plans.length > 0;
  if (existing) designed = (reuseAuthoredProgram ? {
    ...existing,
    sourceEpisodeIds: [...new Set([...existing.sourceEpisodeIds, ...designed.sourceEpisodeIds])],
    capability: {
      ...existing.capability,
      aliases: [...new Set([...existing.capability.aliases, ...designed.capability.aliases])],
      sourceEpisodeIds: [...new Set([...existing.capability.sourceEpisodeIds, ...designed.capability.sourceEpisodeIds])],
    },
    updatedAt: new Date().toISOString(),
  } : {
    ...designed,
    id: existing.id,
    sourceEpisodeIds: [...new Set([...existing.sourceEpisodeIds, ...designed.sourceEpisodeIds])],
    capability: { ...designed.capability, id: existing.capability.id, aliases: [...new Set([...existing.capability.aliases, ...designed.capability.aliases])] },
  }) as DesignedCandidate;
  designed = {
    ...designed,
    normalizedGoal: normalizeGoal(designed.authoring!.goalTemplate || designed.capability.name),
    capability: { ...designed.capability, kind: designed.authoring!.capabilityKind || "task" },
    updatedAt: new Date().toISOString(),
  };
  const release = releaseBeforeDesign;
  const claimed = await claimCanonicalCapabilityForDesign(
    database,
    { ...running, intentKey },
    episode,
    designed,
    release,
  );
  running = claimed.job;
  designed = {
    ...designed,
    capability: {
      ...designed.capability,
      id: claimed.capabilityId,
    },
  };
  if (claimed.reused) {
    const duplicateReason = `生成已停止：该请求与现有能力“${claimed.project.name}”的稳定契约完全相同，不会创建新的 Capability 或 Working Revision。`;
    const failed = updateReceipt({
      ...running,
      status: "failed",
      candidateId: designed.id,
      intentKey,
      goalTemplate: designed.authoring.goalTemplate,
      failure: { code: "duplicate_capability", summary: duplicateReason },
      result: {
        ...running.result,
        reuseDecision: "strengthen-capability",
        reuseReason: duplicateReason,
        duplicateOf: {
          projectId: claimed.project.id,
          capabilityId: claimed.project.activeCapabilityId || null,
          name: claimed.project.name,
        },
        evolutionAssessment: designed.authoring.evolutionAssessment || null,
      },
    }, "design", {
      actor: "release-gate",
      status: "failed",
      title: "重复能力，已停止生成",
      summary: duplicateReason,
      endedAt: new Date().toISOString(),
      evidence: { projectId: claimed.project.id },
    });
    const results = await database.batch([
      // Contract-level identity has already bound this request to the winning
      // Capability. Its Episode and completed Job retain the causal evidence;
      // keeping the transient request Candidate would leak a record that can
      // never advance to author/validate and would pollute future intent input.
      database.prepare(`DELETE FROM site_agent_v2_candidates WHERE id=? AND site_agent_id=?`)
        .bind(candidate.id, job.siteAgentId),
      database.prepare(`UPDATE site_agent_v2_learning_jobs SET status=?,result_json=?,updated_at=? WHERE id=? AND site_agent_id=?`)
        .bind(failed.status, JSON.stringify(failed), failed.updatedAt, failed.id, failed.siteAgentId),
    ]);
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "canonical_capability_reuse_save_failed");
    return;
  }
  await persistGeneratedCapabilitySpec(database, running, episode, designed, {
    projectId: claimed.project.id,
    revisionId: claimed.revision.id,
  });
  const designSummary = designed.authoring!.reason || "已形成通用能力契约。";
  let next = updateReceipt({
    ...running,
    candidateId: designed.id,
    intentKey,
    goalTemplate: designed.authoring!.goalTemplate,
    result: {
      ...running.result,
      reuseDecision: designed.authoring!.reuseDecision || "create-capability",
      reuseReason: designed.authoring!.reuseReason || designSummary,
      evolutionAssessment: designed.authoring!.evolutionAssessment || null,
    },
  }, "design", {
    actor: origin === "user-triggered" ? "ai" : "program", status: "passed", endedAt: new Date().toISOString(), title: "能力规范已生成", summary: designSummary,
    evidence: {
      intentKey,
      goalTemplate: designed.authoring!.goalTemplate || designed.capability.name,
      requiredInputs: designed.authoring!.requiredInputs || [],
      factors: designed.authoring!.evolutionAssessment?.factors || [],
    },
  });
  if (reuseAuthoredProgram) {
    const reusedRevisionImplementation = revisionImplementationForCapability(
      release,
      designed.capability,
    );
    if (reusedRevisionImplementation && claimed.revision) {
      const validation = await makeValidationJob(next, designed, episode, release);
      next = updateReceipt({ ...next, phase: "validate", status: "queued" }, "author", {
        status: "passed", title: "复用同一 Intent 的已编写程序", summary: "新的真实经验已并入同一能力，不重复编写；直接使用新证据独立重放。", endedAt: new Date().toISOString(),
        evidence: { reusedCandidateId: designed.id, sourceEpisodeId: episode.id },
      });
      next = updateReceipt(next, "validate", {
        status: "queued", title: "等待独立重放", summary: "将从通用起点验证既有程序与新输入。", startedAt: new Date().toISOString(),
        evidence: { inputSource: validation.validationCase.inputSource, input: validation.validationCase.input, startUrl: validation.validationCase.startUrl },
      });
      const reusedRevision: CapabilityRevision = {
        ...claimed.revision,
        status: "building",
        stage: "validate",
        candidateId: designed.id,
        learningJobId: next.id,
        implementation: reusedRevisionImplementation,
        validation: { status: "pending" },
        updatedAt: next.updatedAt,
      };
      const results = await database.batch([
        database.prepare(`UPDATE site_agent_v2_capability_revisions
          SET status=?,revision_json=?,updated_at=?
          WHERE id=? AND site_agent_id=? AND project_id=?
            AND status='building' AND revision_json=?`)
          .bind(
            reusedRevision.status,
            JSON.stringify(reusedRevision),
            reusedRevision.updatedAt,
            reusedRevision.id,
            reusedRevision.siteAgentId,
            reusedRevision.projectId,
            JSON.stringify(claimed.revision),
          ),
        database.prepare(`DELETE FROM site_agent_v2_candidates WHERE id=? AND site_agent_id=? AND id<>?`).bind(candidate.id, job.siteAgentId, designed.id),
        database.prepare(`INSERT OR REPLACE INTO site_agent_v2_candidates (id,site_agent_id,normalized_goal,status,base_release_version,candidate_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(designed.id, job.siteAgentId, designed.normalizedGoal, "pending", designed.baseReleaseVersion, JSON.stringify(designed), designed.createdAt, designed.updatedAt),
        database.prepare(`INSERT OR REPLACE INTO site_agent_v2_validation_jobs (id,learning_job_id,site_agent_id,candidate_id,status,lease_expires_at,job_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(validation.id, validation.learningJobId, validation.siteAgentId, validation.candidateId, validation.status, null, JSON.stringify(validation), validation.createdAt, validation.updatedAt),
        database.prepare(`UPDATE site_agent_v2_learning_jobs SET status=?,result_json=?,updated_at=? WHERE id=?`).bind(next.status, JSON.stringify(next), next.updatedAt, next.id),
      ]);
      const failure = results.find((result) => !result.success);
      if (failure || Number(results[0]?.meta?.changes || 0) !== 1) {
        throw new Error(failure?.error || "learning_reuse_revision_update_failed");
      }
      return;
    }
  }
  const sharedOperation = reusableReleaseOperation(release, designed);
  if (sharedOperation) {
    const sharedDesigned = {
      ...designed,
      operations: [],
      capability: {
        ...designed.capability,
        plans: [{
          id: `plan_${stableHash(`${designed.capability.id}:${sharedOperation.id}`)}`,
          entrySceneIds: sharedOperation.applicability?.scope === "scene-set" ? sharedOperation.applicability.sceneIds || [] : release.scenes.map((scene) => scene.id),
          steps: [{ operationId: sharedOperation.id, bindings: {} }],
          outputBindings: Object.fromEntries(Object.keys(designed.capability.outputs.properties || {}).flatMap((field) => field === "pageUrl" ? [[field, { source: "state" as const, path: "__pageUrl" }]] : field === "pageTitle" ? [[field, { source: "state" as const, path: "__pageTitle" }]] : field === "pageHeading" ? [[field, { source: "state" as const, path: "__pageHeading" }]] : [])),
        }],
      },
      authoring: {
        ...designed.authoring!,
        stage: "authored",
        selectedImplementationId: sharedOperation.implementations[0].id,
        alternatives: [{ id: `reuse_${sharedOperation.id}`, kind: "page-program", label: "复用全站共享操作", rationale: `已有“${sharedOperation.name}”通过页面证据验证，无需重复编写。`, selected: true }],
      },
    } as DesignedCandidate;
    const sharedRevisionImplementation = revisionImplementationForCapability(
      release,
      sharedDesigned.capability,
    );
    // A shared Operation may skip Program Authoring only when the Revision can
    // pin the Navigation Tool that owns it. Otherwise fall through to normal
    // module authoring; a plan without a Revision-owned implementation cannot
    // be validated or executed reproducibly.
    if (sharedRevisionImplementation && claimed.revision) {
      designed = sharedDesigned;
      const validation = await makeValidationJob(next, designed, episode, release);
      next = updateReceipt({ ...next, phase: "validate", status: "queued" }, "author", {
        status: "passed", title: "复用已验证的全站操作", summary: `能力直接引用“${sharedOperation.name}”，跳过重复编程并重新验证用户得到的页面结果。`, endedAt: new Date().toISOString(),
        evidence: { operationId: sharedOperation.id, applicability: sharedOperation.applicability || {} },
      });
      next = updateReceipt(next, "validate", { status: "queued", title: "等待业务结果验证", summary: "将在独立浏览器中从适用页面重放共享操作。", startedAt: new Date().toISOString(), evidence: { startUrl: validation.validationCase.startUrl } });
      const sharedRevision: CapabilityRevision = {
        ...claimed.revision,
        stage: "validate",
        implementation: sharedRevisionImplementation,
        updatedAt: next.updatedAt,
      };
      const results = await database.batch([
        database.prepare(`UPDATE site_agent_v2_capability_revisions
          SET status=?,revision_json=?,updated_at=?
          WHERE id=? AND site_agent_id=? AND project_id=?
            AND status='building' AND revision_json=?`)
          .bind(
            sharedRevision.status,
            JSON.stringify(sharedRevision),
            sharedRevision.updatedAt,
            sharedRevision.id,
            sharedRevision.siteAgentId,
            sharedRevision.projectId,
            JSON.stringify(claimed.revision),
          ),
        database.prepare(`DELETE FROM site_agent_v2_candidates WHERE id=? AND site_agent_id=? AND id<>?`).bind(candidate.id, job.siteAgentId, designed.id),
        database.prepare(`INSERT OR REPLACE INTO site_agent_v2_candidates (id,site_agent_id,normalized_goal,status,base_release_version,candidate_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(designed.id, job.siteAgentId, designed.normalizedGoal, "pending", designed.baseReleaseVersion, JSON.stringify(designed), designed.createdAt, designed.updatedAt),
        database.prepare(`INSERT OR REPLACE INTO site_agent_v2_validation_jobs (id,learning_job_id,site_agent_id,candidate_id,status,lease_expires_at,job_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(validation.id, validation.learningJobId, validation.siteAgentId, validation.candidateId, validation.status, null, JSON.stringify(validation), validation.createdAt, validation.updatedAt),
        database.prepare(`UPDATE site_agent_v2_learning_jobs SET status=?,result_json=?,updated_at=? WHERE id=?`).bind(next.status, JSON.stringify(next), next.updatedAt, next.id),
      ]);
      const failure = results.find((result) => !result.success);
      if (failure || Number(results[0]?.meta?.changes || 0) !== 1) {
        throw new Error(failure?.error || "learning_shared_operation_revision_update_failed");
      }
      return;
    }
  }
  const statements = [
    database.prepare(`DELETE FROM site_agent_v2_candidates WHERE site_agent_id=? AND id<>? AND json_extract(candidate_json,'$.authoring.intentKey')=?`).bind(job.siteAgentId, designed.id, intentKey),
    database.prepare(`DELETE FROM site_agent_v2_candidates WHERE id=? AND site_agent_id=? AND id<>?`).bind(candidate.id, job.siteAgentId, designed.id),
    database.prepare(`INSERT OR REPLACE INTO site_agent_v2_candidates (id,site_agent_id,normalized_goal,status,base_release_version,candidate_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(designed.id, job.siteAgentId, designed.normalizedGoal, "pending", designed.baseReleaseVersion, JSON.stringify(designed), designed.createdAt, designed.updatedAt),
  ];
  next = updateReceipt({ ...next, phase: "author", status: "queued" }, "author", {
    status: "queued", title: "等待 AI 编写能力程序", summary: "AI Program Author 将在隔离浏览器中比较路径、设计 Target 和完成验证器。", startedAt: new Date().toISOString(),
  });
  statements.push(database.prepare(`UPDATE site_agent_v2_learning_jobs SET status=?,result_json=?,updated_at=? WHERE id=?`).bind(next.status, JSON.stringify(next), next.updatedAt, next.id));
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "learning_design_save_failed");
}

/**
 * Consume the model-only part of the learning queue.
 *
 * Designing a capability needs D1 plus the model proxy, but does not need a
 * Playwright browser.  Keeping it behind the browser-runner lease meant a
 * perfectly healthy queued design could wait forever whenever the optional
 * browser worker was offline.  Browser workers now own author/validate only.
 */
export async function processQueuedLearningDesigns(siteAgentId?: string, limit = 1): Promise<{ processed: number; persistence: "memory" | "d1" }> {
  const database = getD1Binding();
  if (!database) return { processed: 0, persistence: "memory" };
  await ensureSiteAgentV2Schema(database);
  const maximum = Math.max(1, Math.min(3, Math.floor(limit) || 1));
  let processed = 0;
  for (let index = 0; index < maximum; index += 1) {
    const now = new Date().toISOString();
    const staleAt = new Date(Date.now() - 120_000).toISOString();
    const whereSite = siteAgentId ? " AND site_agent_id=?" : "";
    // One SiteAgent owns one capability-production cursor. Do not design a
    // second capability while an older one is being authored or validated;
    // that created many apparently “forming” projects with no honest notion
    // of which task was actually using the worker.
    const rows = await all<LearningJobRow>(database, `SELECT result_json AS jobJson FROM site_agent_v2_learning_jobs WHERE status IN ('queued','leased','running')${whereSite} ORDER BY created_at LIMIT 1`, siteAgentId ? [siteAgentId] : []);
    if (!rows[0]) break;
    const job = JSON.parse(rows[0].jobJson) as LearningJob;
    if (job.phase !== "design") break;
    const claimed = await database.prepare(`UPDATE site_agent_v2_learning_jobs SET status='running',updated_at=? WHERE id=? AND site_agent_id=? AND (status='queued' OR (status='running' AND updated_at<=?))`)
      .bind(now, job.id, job.siteAgentId, staleAt).run();
    if (!claimed.success || Number(claimed.meta?.changes || 0) < 1) continue;
    try {
      await designLearningJob(database, job);
    } catch (error) {
      const failed = updateReceipt({ ...job, status: "failed", failure: { code: "ai_design_dispatch_failed", summary: error instanceof Error ? error.message : "能力设计任务未能启动。" } }, "design", {
        status: "failed", title: "AI 能力设计未完成", summary: "设计任务发生异常；保留真实经验，可重新触发。", endedAt: new Date().toISOString(),
      });
      await saveLearningJob(database, failed);
    }
    // Capability projects are a materialized read model. Rebuild it once at
    // the state transition boundary, never from a polling GET request.
    await reconcileCapabilityControl(job.siteAgentId);
    processed += 1;
  }
  return { processed, persistence: "d1" };
}

/**
 * Consume successful terminal-user gaps. The durable signal is deliberately
 * outside Capability Center: AI must classify the evidence before a Proposal
 * or Task is allowed to exist.
 */
export async function processQueuedCapabilitySignals(
  siteAgentId?: string,
  limit = 1,
): Promise<{ processed: number; retried: number; persistence: "memory" | "d1" }> {
  const maximum = Math.max(1, Math.min(3, Math.floor(limit) || 1));
  const { capabilitySignalLastError, submitEpisodeCapabilitySignal } = await import("../lib/capability-center/proposal-service");
  const { coalesceCapabilityProposalsForEpisodes } = await import("./capability-center-store");
  const database = getD1Binding();
  if (!database) {
    let processed = 0;
    let retried = 0;
    const now = new Date().toISOString();
    for (const [agentId, agent] of memoryStore()) {
      if (processed >= maximum || (siteAgentId && agentId !== siteAgentId)) continue;
      coalesceMemoryCapabilitySignals(agent);
      const signal = agent.capabilitySignals.find((item) =>
        item.status === "pending" && (!item.nextAttemptAt || item.nextAttemptAt <= now));
      if (!signal) continue;
      const proposalConvergence = await coalesceCapabilityProposalsForEpisodes(agentId, signal.episodeIds);
      const episode = agent.episodes.find((item) => item.id === (proposalConvergence.sourceEpisodeId || signal.episodeIds[0]));
      if (!episode) continue;
      signal.status = "processing";
      signal.updatedAt = now;
      try {
        const result = await submitEpisodeCapabilitySignal(agentId, episode);
        const analysis = "analysis" in result ? result.analysis : undefined;
        const disposition = analysis?.disposition || ("disposition" in result ? result.disposition : "rejected");
        const task = "task" in result ? result.task as { id: string } | undefined : undefined;
        signal.status = "completed";
        signal.resolution = {
          disposition,
          ...(analysis?.duplicateCapabilityId ? { duplicateCapabilityId: analysis.duplicateCapabilityId } : {}),
          ...(result.proposal ? { proposalId: result.proposal.id } : {}),
          ...(task ? { taskId: task.id } : {}),
          summary: analysis?.summary,
        };
        signal.lastError = undefined;
        signal.nextAttemptAt = undefined;
      } catch (error) {
        signal.status = "pending";
        signal.attempts = (signal.attempts || 0) + 1;
        signal.lastError = capabilitySignalLastError(error);
        signal.nextAttemptAt = new Date(Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(signal.attempts, 5))).toISOString();
        retried += 1;
      }
      signal.updatedAt = new Date().toISOString();
      processed += 1;
    }
    return { processed, retried, persistence: "memory" };
  }

  await ensureSiteAgentV2Schema(database);
  let processed = 0;
  let retried = 0;
  for (let index = 0; index < maximum; index += 1) {
    const now = new Date().toISOString();
    const staleAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const whereSite = siteAgentId ? " AND site_agent_id=?" : "";
    const rows = await all<{ id: string; siteAgentId: string; status: string; signalJson: string; updatedAt: string }>(database,
      `SELECT id,site_agent_id AS siteAgentId,status,signal_json AS signalJson,updated_at AS updatedAt
       FROM site_agent_v2_capability_signals
       WHERE (status='pending' OR (status='processing' AND updated_at<=?))${whereSite}
       ORDER BY created_at LIMIT 20`, siteAgentId ? [staleAt, siteAgentId] : [staleAt]);
    let row = rows.find((candidate) => {
      const signal = JSON.parse(candidate.signalJson) as CapabilitySignal;
      return !signal.nextAttemptAt || signal.nextAttemptAt <= now;
    });
    if (!row) break;
    const queuedSignal = JSON.parse(row.signalJson) as CapabilitySignal;
    const coalesced = await coalesceActiveCapabilitySignals(database, row.siteAgentId, queuedSignal.intentBucket);
    if (!coalesced) continue;
    const coalescedSignal = JSON.parse(coalesced.signalJson) as CapabilitySignal;
    const proposalConvergence = await coalesceCapabilityProposalsForEpisodes(row.siteAgentId, coalescedSignal.episodeIds);
    if (coalesced.status === "processing" && coalesced.updatedAt > staleAt) continue;
    row = coalesced;
    const claimed = await database.prepare(`UPDATE site_agent_v2_capability_signals
      SET status='processing',updated_at=? WHERE id=? AND site_agent_id=? AND updated_at=?
      AND (status='pending' OR status='processing')`)
      .bind(now, row.id, row.siteAgentId, row.updatedAt).run();
    if (!claimed.success || Number(claimed.meta?.changes || 0) !== 1) continue;
    const signal = { ...JSON.parse(row.signalJson) as CapabilitySignal, status: "processing" as const, updatedAt: now };
    const episode = await episodeById(database, row.siteAgentId, proposalConvergence.sourceEpisodeId || signal.episodeIds[0]);
    try {
      if (!episode) throw new Error("capability_signal_episode_missing");
      const result = await submitEpisodeCapabilitySignal(row.siteAgentId, episode);
      const analysis = "analysis" in result ? result.analysis : undefined;
      const disposition = analysis?.disposition || ("disposition" in result ? result.disposition : "rejected");
      const task = "task" in result ? result.task as { id: string } | undefined : undefined;
      await finishProcessingCapabilitySignal(database, row.siteAgentId, signal.id, (current) => ({
        ...current,
        status: "completed",
        lastError: undefined,
        nextAttemptAt: undefined,
        resolution: {
          disposition,
          ...(analysis?.duplicateCapabilityId ? { duplicateCapabilityId: analysis.duplicateCapabilityId } : {}),
          ...(result.proposal ? { proposalId: result.proposal.id } : {}),
          ...(task ? { taskId: task.id } : {}),
          summary: analysis?.summary,
        },
        updatedAt: new Date().toISOString(),
      }));
    } catch (error) {
      await finishProcessingCapabilitySignal(database, row.siteAgentId, signal.id, (current) => {
        const attempts = (current.attempts || 0) + 1;
        return {
          ...current,
          status: "pending",
          attempts,
          lastError: capabilitySignalLastError(error),
          nextAttemptAt: new Date(Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(attempts, 5))).toISOString(),
          updatedAt: new Date().toISOString(),
        };
      });
      retried += 1;
    }
    processed += 1;
  }
  return { processed, retried, persistence: "d1" };
}

export async function listCapabilitySignals(siteAgentId: string, limit = 100) {
  const maximum = Math.max(1, Math.min(100, Math.floor(limit) || 100));
  const database = getD1Binding();
  if (!database) {
    const signals = [...(memoryAgent(siteAgentId).capabilitySignals || [])]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, maximum);
    return { signals, persistence: "memory" as const };
  }
  await ensureSiteAgentV2Schema(database);
  const rows = await all<{ signalJson: string }>(database,
    `SELECT signal_json AS signalJson FROM site_agent_v2_capability_signals
     WHERE site_agent_id=? ORDER BY updated_at DESC LIMIT ?`, [siteAgentId, maximum]);
  return {
    signals: rows.map((row) => JSON.parse(row.signalJson) as CapabilitySignal),
    persistence: "d1" as const,
  };
}

export async function registerValidationRunner(input: {
  id?: string;
  name?: string;
  version?: string;
  role?: RunnerRole | "mixed";
  workKinds?: RunnerWorkKind[];
  browsers?: string[];
  maxConcurrency?: number;
  recording?: boolean;
  prewarmCapacity?: number;
  readySlots?: number;
}) {
  const control = await registerRunnerInstance(input);
  const now = control.instance.lastHeartbeatAt;
  const runner: RunnerRegistration = {
    id: control.instance.id,
    name: control.instance.name,
    status: "online",
    poolId: control.instance.poolId,
    sessionId: control.instance.sessionId,
    generation: control.instance.generation,
    desiredState: control.instance.desiredState,
    observedState: control.instance.observedState,
    role: control.instance.role,
    workKinds: control.instance.workKinds,
    version: control.instance.version,
    capabilities: control.instance.capabilities,
    lastHeartbeatAt: now,
    createdAt: control.instance.createdAt,
    lastError: control.instance.lastError,
  };
  const database = getD1Binding();
  if (!database) {
    runnerMemoryStore().set(runner.id, runner);
    return { runner, instance: control.instance, sessionToken: control.sessionToken, persistence: "memory" as const };
  }
  await ensureSiteAgentV2Schema(database);
  const result = await database.prepare(`INSERT OR REPLACE INTO site_agent_v2_runners (id,status,runner_json,last_heartbeat_at,created_at) VALUES (?,?,?,?,COALESCE((SELECT created_at FROM site_agent_v2_runners WHERE id=?),?))`)
    .bind(runner.id, runner.status, JSON.stringify(runner), now, runner.id, now).run();
  if (!result.success) throw new Error(result.error || "runner_registration_failed");
  return { runner, instance: control.instance, sessionToken: control.sessionToken, persistence: "d1" as const };
}

type RunnerAuthoringActivity = {
  stage?: string;
  phase?: CodexAuthoringEvent["phase"];
  message?: string;
  learningJobId?: string;
  artifactIds?: string[];
  tokenUsage?: CodexAuthoringEvent["tokenUsage"];
};

export async function heartbeatValidationRunner(
  runnerId: string,
  status: RunnerRegistration["status"] = "online",
  activity?: RunnerAuthoringActivity | null,
  control?: { sessionId?: string; sessionToken?: string; readySlots?: number; legacy?: boolean; lastError?: Omit<RunnerLastError, "at"> },
) {
  const now = new Date().toISOString();
  const database = getD1Binding();
  if (!database) {
    const current = runnerMemoryStore().get(runnerId); if (!current) throw new Error("runner_not_found");
    let heartbeat;
    try {
      heartbeat = await heartbeatRunnerInstance(runnerId, {
        sessionId: control?.sessionId,
        sessionToken: control?.sessionToken,
        legacy: control?.legacy ?? !control?.sessionToken,
        readySlots: control?.readySlots,
        lastError: control?.lastError,
        activity: activity === undefined ? (status === "busy" ? undefined : null) : activity,
      });
    } catch (error) {
      if (!String(error).includes("runner_instance_not_found")) throw error;
      const registered = await registerRunnerInstance({
        id: runnerId,
        name: current.name,
        role: current.role,
        workKinds: current.workKinds,
        browsers: current.capabilities.browsers,
        maxConcurrency: current.capabilities.maxConcurrency,
        recording: current.capabilities.recording,
        prewarmCapacity: current.capabilities.prewarmCapacity,
        readySlots: control?.readySlots ?? current.capabilities.readySlots,
      });
      heartbeat = {
        instance: registered.instance,
        desiredState: registered.instance.desiredState,
        heartbeatIntervalMs: 5_000,
        persistence: registered.persistence,
      };
    }
    const runner: RunnerRegistration = {
      ...current,
      status,
      poolId: heartbeat.instance.poolId,
      sessionId: heartbeat.instance.sessionId,
      generation: heartbeat.instance.generation,
      desiredState: heartbeat.instance.desiredState,
      observedState: heartbeat.instance.observedState,
      role: heartbeat.instance.role,
      workKinds: heartbeat.instance.workKinds,
      capabilities: heartbeat.instance.capabilities,
      lastHeartbeatAt: heartbeat.instance.lastHeartbeatAt,
      activity: heartbeat.instance.activity,
      lastError: heartbeat.instance.lastError,
    };
    runnerMemoryStore().set(runnerId, runner);
    await maybeExpireStaleTaskLaunches();
    return { runner, instance: heartbeat.instance, desiredState: heartbeat.desiredState, persistence: "memory" as const };
  }
  const rows = await all<RunnerRow>(database, `SELECT runner_json AS runnerJson FROM site_agent_v2_runners WHERE id=? LIMIT 1`, [runnerId]);
  if (!rows[0]) throw new Error("runner_not_found");
  const current = JSON.parse(rows[0].runnerJson) as RunnerRegistration;
  let heartbeat;
  try {
    heartbeat = await heartbeatRunnerInstance(runnerId, {
      sessionId: control?.sessionId,
      sessionToken: control?.sessionToken,
      legacy: control?.legacy ?? !control?.sessionToken,
      readySlots: control?.readySlots,
      lastError: control?.lastError,
      activity: activity === undefined ? (status === "busy" ? undefined : null) : activity,
    });
  } catch (error) {
    if (!String(error).includes("runner_instance_not_found")) throw error;
    const registered = await registerRunnerInstance({
      id: runnerId,
      name: current.name,
      version: current.version,
      role: current.role,
      workKinds: current.workKinds,
      browsers: current.capabilities.browsers,
      maxConcurrency: current.capabilities.maxConcurrency,
      recording: current.capabilities.recording,
      prewarmCapacity: current.capabilities.prewarmCapacity,
      readySlots: control?.readySlots ?? current.capabilities.readySlots,
    });
    heartbeat = {
      instance: registered.instance,
      desiredState: registered.instance.desiredState,
      heartbeatIntervalMs: 5_000,
      persistence: registered.persistence,
    };
  }
  const runner: RunnerRegistration = {
    ...current,
    status,
    poolId: heartbeat.instance.poolId,
    sessionId: heartbeat.instance.sessionId,
    generation: heartbeat.instance.generation,
    desiredState: heartbeat.instance.desiredState,
    observedState: heartbeat.instance.observedState,
    role: heartbeat.instance.role,
    workKinds: heartbeat.instance.workKinds,
    capabilities: heartbeat.instance.capabilities,
    lastHeartbeatAt: heartbeat.instance.lastHeartbeatAt,
    activity: heartbeat.instance.activity,
    lastError: heartbeat.instance.lastError,
  };
  const statements = [database.prepare(`UPDATE site_agent_v2_runners SET status=?,runner_json=?,last_heartbeat_at=? WHERE id=?`).bind(status, JSON.stringify(runner), now, runnerId)];
  if (activity?.learningJobId && activity.message && activity.phase) {
    const sequenceRows = await all<{ sequence: number }>(database, `SELECT COALESCE(MAX(sequence),0) AS sequence FROM site_agent_v2_codex_authoring_events WHERE learning_job_id=?`, [activity.learningJobId]);
    const sequence = Number(sequenceRows[0]?.sequence || 0) + 1;
    const jobRows = await all<LearningJobRow>(database, `SELECT result_json AS jobJson FROM site_agent_v2_learning_jobs WHERE id=? LIMIT 1`, [activity.learningJobId]);
    const job = jobRows[0] ? JSON.parse(jobRows[0].jobJson) as LearningJob : undefined;
    if (job) {
      const event: CodexAuthoringEvent = {
        id: uid("codex_event"), sessionId: activity.learningJobId, sequence, phase: activity.phase,
        message: activity.message.slice(0, 800), artifactIds: activity.artifactIds?.slice(0, 20), tokenUsage: activity.tokenUsage, createdAt: now,
      };
      statements.push(database.prepare(`INSERT OR IGNORE INTO site_agent_v2_codex_authoring_events (id,site_agent_id,learning_job_id,sequence,event_json,created_at) VALUES (?,?,?,?,?,?)`).bind(event.id, job.siteAgentId, activity.learningJobId, sequence, JSON.stringify(event), now));
    }
  }
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "runner_heartbeat_failed");
  await maybeExpireStaleTaskLaunches(database);
  return { runner, instance: heartbeat.instance, desiredState: heartbeat.desiredState, persistence: "d1" as const };
}

export type RunnerWorkQueue = "any" | "interactive" | "background" | "author" | "validate" | "crawl";

type CrawlJobRow = { jobJson: string };
type SitePreviewJobRow = { jobJson: string };
const CRAWL_LEASE_TTL_MS = 2 * 60_000;
const SITE_PREVIEW_LEASE_TTL_MS = 2 * 60_000;

function publicPreviewJob(job: SitePreviewJob): SitePreviewJobSummary {
  return {
    ...job,
    lease: job.lease ? { runnerId: job.lease.runnerId, leasedAt: job.lease.leasedAt, expiresAt: job.lease.expiresAt } : undefined,
  };
}

export async function getSitePreview(siteAgentId: string): Promise<{ preview?: SitePreviewResult; job?: SitePreviewJobSummary; persistence: "memory" | "d1" }> {
  const database = getD1Binding();
  if (!database) {
    const jobs = [...memoryAgent(siteAgentId).previewJobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { preview: jobs.find((item) => item.status === "succeeded")?.result, job: jobs[0] ? publicPreviewJob(jobs[0]) : undefined, persistence: "memory" };
  }
  await ensureSiteAgentV2Schema(database);
  const rows = await all<SitePreviewJobRow>(database, `SELECT job_json AS jobJson FROM site_agent_v2_preview_jobs WHERE site_agent_id=? ORDER BY created_at DESC LIMIT 20`, [siteAgentId]);
  const jobs = rows.map((row) => JSON.parse(row.jobJson) as SitePreviewJob);
  return { preview: jobs.find((item) => item.status === "succeeded")?.result, job: jobs[0] ? publicPreviewJob(jobs[0]) : undefined, persistence: "d1" };
}

/** A preview is intentionally separate from knowledge collection. */
export async function enqueueSitePreviewJob(input: {
  siteAgentId: string;
  origin: string;
  url?: string;
  force?: boolean;
  /** `try-install` opens the page with the snippet already in it; see SitePreviewMode. */
  mode?: SitePreviewMode;
  installSnippet?: string;
}): Promise<{ job: SitePreviewJobSummary; persistence: "memory" | "d1" }> {
  const origin = new URL(input.origin).origin;
  const url = new URL(input.url || origin, origin).toString();
  if (new URL(url).origin !== origin) throw new Error("site_preview_origin_invalid");
  const now = new Date().toISOString();
  const database = getD1Binding();
  if (!database) {
    const agent = memoryAgent(input.siteAgentId);
    // A rehearsal and a live render answer different questions, so an active
    // rehearsal must not be handed back as the answer to "check the site" —
    // the round would then be decided by a snippet the rehearsal injected
    // itself, and the reader had to press the button a second time.
    const wantedMode = previewMode(input).mode || "live";
    const existing = [...agent.previewJobs].reverse().find((item) =>
      ((item.mode || "live") === wantedMode) && (["queued", "leased", "running"].includes(item.status) || !input.force));
    if (existing) return { job: publicPreviewJob(existing), persistence: "memory" };
    const job: SitePreviewJob = { id: uid("preview"), siteAgentId: input.siteAgentId, origin, url, status: "queued", attempts: 0, createdAt: now, updatedAt: now, ...previewMode(input) };
    agent.previewJobs.push(job);
    return { job: publicPreviewJob(job), persistence: "memory" };
  }
  await ensureSiteAgentV2Schema(database);
  const wantedMode = previewMode(input).mode || "live";
  const existingRows = await all<SitePreviewJobRow>(database, `SELECT job_json AS jobJson FROM site_agent_v2_preview_jobs WHERE site_agent_id=? ORDER BY created_at DESC LIMIT 8`, [input.siteAgentId]);
  const existing = existingRows
    .map((row) => JSON.parse(row.jobJson) as SitePreviewJob)
    .find((job) => (job.mode || "live") === wantedMode);
  if (existing && (["queued", "leased", "running"].includes(existing.status) || !input.force)) return { job: publicPreviewJob(existing), persistence: "d1" };
  const job: SitePreviewJob = { id: uid("preview"), siteAgentId: input.siteAgentId, origin, url, status: "queued", attempts: 0, createdAt: now, updatedAt: now, ...previewMode(input) };
  const result = await database.prepare(`INSERT INTO site_agent_v2_preview_jobs (id,site_agent_id,status,lease_expires_at,attempts,job_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(job.id, job.siteAgentId, job.status, null, 0, JSON.stringify(job), now, now).run();
  if (!result.success) throw new Error(result.error || "site_preview_enqueue_failed");
  return { job: publicPreviewJob(job), persistence: "d1" };
}

/** Only a rehearsal carries a snippet; a live render must never be given one. */
function previewMode(input: { mode?: SitePreviewMode; installSnippet?: string }) {
  return input.mode === "try-install" && input.installSnippet
    ? { mode: "try-install" as const, installSnippet: input.installSnippet }
    : {};
}

export async function renewSitePreviewJobLease(runnerId: string, leaseToken: string, jobId: string) {
  const database = getD1Binding();
  const expiresAt = new Date(Date.now() + SITE_PREVIEW_LEASE_TTL_MS).toISOString();
  if (!database) return { expiresAt, persistence: "memory" as const };
  await ensureSiteAgentV2Schema(database);
  const now = new Date().toISOString();
  const rows = await all<SitePreviewJobRow>(database, `SELECT job_json AS jobJson FROM site_agent_v2_preview_jobs WHERE id=? AND status IN ('leased','running') LIMIT 1`, [jobId]);
  const job = rows[0] ? JSON.parse(rows[0].jobJson) as SitePreviewJob : undefined;
  if (!job || job.lease?.runnerId !== runnerId || job.lease.token !== leaseToken || job.lease.expiresAt <= now) throw new Error("site_preview_lease_invalid");
  const renewed: SitePreviewJob = { ...job, status: "running", lease: { ...job.lease, expiresAt }, updatedAt: now };
  const result = await database.prepare(`UPDATE site_agent_v2_preview_jobs SET status='running',lease_expires_at=?,job_json=?,updated_at=? WHERE id=? AND job_json=?`).bind(expiresAt, JSON.stringify(renewed), now, job.id, rows[0].jobJson).run();
  if (!result.success || Number(result.meta?.changes || 0) < 1) throw new Error("site_preview_lease_invalid");
  return { expiresAt, persistence: "d1" as const };
}

export async function completeSitePreviewJob(runnerId: string, leaseToken: string, jobId: string, preview: SitePreviewResult) {
  const database = getD1Binding();
  if (!database) return { persistence: "memory" as const };
  await ensureSiteAgentV2Schema(database);
  const now = new Date().toISOString();
  const rows = await all<SitePreviewJobRow>(database, `SELECT job_json AS jobJson FROM site_agent_v2_preview_jobs WHERE id=? LIMIT 1`, [jobId]);
  const job = rows[0] ? JSON.parse(rows[0].jobJson) as SitePreviewJob : undefined;
  if (!job) throw new Error("site_preview_job_missing");
  if (job.status === "succeeded" && job.result?.artifactId === preview.artifactId) return { persistence: "d1" as const };
  if (job.lease?.runnerId !== runnerId || job.lease.token !== leaseToken || job.lease.expiresAt <= now) throw new Error("site_preview_lease_invalid");
  const succeeded: SitePreviewJob = { ...job, status: "succeeded", lease: undefined, result: preview, error: undefined, updatedAt: now };
  const result = await database.prepare(`UPDATE site_agent_v2_preview_jobs SET status='succeeded',lease_expires_at=NULL,job_json=?,updated_at=? WHERE id=? AND job_json=?`).bind(JSON.stringify(succeeded), now, job.id, rows[0].jobJson).run();
  if (!result.success || Number(result.meta?.changes || 0) < 1) throw new Error("site_preview_lease_invalid");
  const oldRows = await all<{ id: string; jobJson: string }>(database, `SELECT id,job_json AS jobJson FROM site_agent_v2_preview_jobs WHERE site_agent_id=? AND status='succeeded' ORDER BY created_at DESC LIMIT 100 OFFSET 3`, [job.siteAgentId]);
  const old = oldRows.map((item) => ({ id: item.id, artifactId: (JSON.parse(item.jobJson) as SitePreviewJob).result?.artifactId }));
  for (const item of old) if (item.artifactId) await deleteBrowserArtifact(item.artifactId).catch(() => undefined);
  if (old.length) await database.prepare(`DELETE FROM site_agent_v2_preview_jobs WHERE id IN (${old.map(() => "?").join(",")})`).bind(...old.map((item) => item.id)).run();
  return { persistence: "d1" as const };
}

export async function failSitePreviewJob(runnerId: string, leaseToken: string, jobId: string, error: string) {
  const database = getD1Binding();
  if (!database) return { persistence: "memory" as const };
  await ensureSiteAgentV2Schema(database);
  const now = new Date().toISOString();
  const rows = await all<SitePreviewJobRow>(database, `SELECT job_json AS jobJson FROM site_agent_v2_preview_jobs WHERE id=? LIMIT 1`, [jobId]);
  const job = rows[0] ? JSON.parse(rows[0].jobJson) as SitePreviewJob : undefined;
  if (!job) throw new Error("site_preview_job_missing");
  if (job.status === "failed") return { persistence: "d1" as const };
  if (job.lease?.runnerId !== runnerId || job.lease.token !== leaseToken || job.lease.expiresAt <= now) throw new Error("site_preview_lease_invalid");
  const retry = job.attempts < 3;
  const failed: SitePreviewJob = { ...job, status: retry ? "queued" : "failed", lease: undefined, error: error.slice(0, 500), updatedAt: now };
  const result = await database.prepare(`UPDATE site_agent_v2_preview_jobs SET status=?,lease_expires_at=NULL,job_json=?,updated_at=? WHERE id=? AND job_json=?`).bind(failed.status, JSON.stringify(failed), now, job.id, rows[0].jobJson).run();
  if (!result.success || Number(result.meta?.changes || 0) < 1) throw new Error("site_preview_lease_invalid");
  return { persistence: "d1" as const };
}

/** Enqueue an onboarding crawl job (durable queue leased by the browser runner). */
export async function enqueueCrawlJob(input: { siteAgentId: string; origin: string; seeds?: string[]; limits?: CrawlJobLimits }): Promise<{ job?: CrawlJob; persistence: "memory" | "d1" }> {
  const now = new Date().toISOString();
  const job: CrawlJob = {
    id: uid("crawl"),
    siteAgentId: input.siteAgentId,
    status: "queued",
    origin: input.origin,
    seeds: input.seeds || [],
    limits: validateCrawlJobLimits(input.limits),
    trigger: "manual",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  const database = getD1Binding();
  if (!database) return { job, persistence: "memory" };
  await ensureSiteAgentV2Schema(database);
  await database.prepare(`INSERT INTO site_agent_v2_crawl_jobs (id,site_agent_id,status,lease_expires_at,attempts,job_json,result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(job.id, job.siteAgentId, job.status, null, 0, JSON.stringify(job), null, now, now).run();
  return { job, persistence: "d1" };
}

/**
 * The crawl triggered by the first connection. Inserted only when the site has **no
 * crawl job at all yet**; the check and the insert are one statement
 * (`INSERT … SELECT … WHERE NOT EXISTS`), so at most one of several concurrent first
 * handshakes wins. The same predicate satisfies three requirements at once: no
 * automatic retry after failure, no auto-scheduling if one was scheduled manually,
 * and no re-scheduling after a stop.
 */
export async function enqueueInitialCrawlJob(input: { siteAgentId: string; origin: string; seeds?: string[] }): Promise<{ queued: boolean; job?: CrawlJob; persistence: "memory" | "d1" }> {
  const now = new Date().toISOString();
  const job: CrawlJob = {
    id: uid("crawl"),
    siteAgentId: input.siteAgentId,
    status: "queued",
    origin: input.origin,
    seeds: input.seeds || [],
    limits: validateCrawlJobLimits(undefined),
    trigger: "auto",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  const database = getD1Binding();
  // In memory mode crawl jobs are neither persisted nor executed (same as
  // enqueueCrawlJob), so do not pretend one was scheduled.
  if (!database) return { queued: false, persistence: "memory" };
  await ensureSiteAgentV2Schema(database);
  const result = await database.prepare(`INSERT INTO site_agent_v2_crawl_jobs (id,site_agent_id,status,lease_expires_at,attempts,job_json,result_json,created_at,updated_at)
    SELECT ?,?,?,NULL,0,?,NULL,?,? WHERE NOT EXISTS (SELECT 1 FROM site_agent_v2_crawl_jobs WHERE site_agent_id=?)`)
    .bind(job.id, job.siteAgentId, job.status, JSON.stringify(job), now, now, job.siteAgentId).run();
  if (!result.success) throw new Error(result.error || "crawl_initial_enqueue_failed");
  const queued = Number(result.meta?.changes || 0) > 0;
  return queued ? { queued, job, persistence: "d1" } : { queued: false, persistence: "d1" };
}

export async function listCrawlJobs(siteAgentId: string): Promise<{ jobs: CrawlJobSummary[]; persistence: "memory" | "d1" }> {
  const database = getD1Binding();
  if (!database) return { jobs: [], persistence: "memory" };
  await ensureSiteAgentV2Schema(database);
  const rows = await all<CrawlJobRow>(database, `SELECT job_json AS jobJson FROM site_agent_v2_crawl_jobs WHERE site_agent_id=? ORDER BY created_at DESC LIMIT 20`, [siteAgentId]);
  return {
    jobs: rows.map((row) => {
      const job = JSON.parse(row.jobJson) as CrawlJob;
      return {
        ...job,
        completion: undefined,
        lease: job.lease
          ? {
              runnerId: job.lease.runnerId,
              leasedAt: job.lease.leasedAt,
              expiresAt: job.lease.expiresAt,
            }
          : undefined,
      };
    }),
    persistence: "d1",
  };
}

/** Clears unfinished (queued/leased/running) crawl jobs for a site. */
export async function cancelCrawlJobs(siteAgentId: string): Promise<{ cleared: number; persistence: "memory" | "d1" }> {
  const database = getD1Binding();
  if (!database) return { cleared: 0, persistence: "memory" };
  await ensureSiteAgentV2Schema(database);
  const result = await database.prepare(`DELETE FROM site_agent_v2_crawl_jobs WHERE site_agent_id=? AND status IN ('queued','leased','running')`).bind(siteAgentId).run();
  return { cleared: Number(result.meta?.changes || 0), persistence: "d1" };
}

type SiteKnowledgeRow = { knowledgeJson: string };

async function readSiteKnowledgeRow(database: D1DatabaseLike, siteAgentId: string, version: number): Promise<SiteKnowledge | undefined> {
  const rows = await all<SiteKnowledgeRow>(database, `SELECT knowledge_json AS knowledgeJson FROM site_agent_v2_knowledge WHERE site_agent_id=? AND version=? LIMIT 1`, [siteAgentId, version]);
  return rows[0] ? JSON.parse(rows[0].knowledgeJson) as SiteKnowledge : undefined;
}

/**
 * Loads the independent Site Knowledge base. When no explicit version is asked,
 * it lazily mirrors the active release's embedded knowledge into the store if the
 * store lags behind (Phase-A dual write done on read — one place, covers every
 * producer; the derived knowledge equals the release's by construction).
 */
export async function loadSiteKnowledge(siteAgentId: string, version?: number): Promise<{ knowledge?: SiteKnowledge; persistence: "memory" | "d1" }> {
  const database = getD1Binding();
  if (!database) return { persistence: "memory" };
  await ensureSiteAgentV2Schema(database);
  if (version !== undefined) return { knowledge: await readSiteKnowledgeRow(database, siteAgentId, version), persistence: "d1" };
  const release = await d1Release(database, siteAgentId);
  if (release) {
    // Read by the release's KnowledgeRevision pointer (d1Release rehydrated it, so
    // the row already exists); a config-only release points at an earlier revision.
    const stored = await readSiteKnowledgeRow(database, siteAgentId, knowledgeRevisionOf(release));
    if (stored) return { knowledge: stored, persistence: "d1" };
    // Derive from the canonical release so stored knowledge matches what the
    // release route serves (the active row can predate Scene clustering fixes).
    const derived = siteKnowledgeFromRelease(canonicalizeReleaseKnowledge(release));
    const revision = await persistKnowledgeRevision(database, siteAgentId, derived).catch(() => undefined);
    return { knowledge: revision != null ? { ...derived, version: revision } : derived, persistence: "d1" };
  }
  const rows = await all<SiteKnowledgeRow>(database, `SELECT knowledge_json AS knowledgeJson FROM site_agent_v2_knowledge WHERE site_agent_id=? ORDER BY version DESC LIMIT 1`, [siteAgentId]);
  return { knowledge: rows[0] ? JSON.parse(rows[0].knowledgeJson) as SiteKnowledge : undefined, persistence: "d1" };
}

/** Persists a Site Knowledge version (dedup by (site_agent_id, version)). */
export async function writeSiteKnowledge(database: D1DatabaseLike, knowledge: SiteKnowledge): Promise<void> {
  // The Postgres adapter surfaces failures as `{ success: false }` rather than
  // throwing. This write MUST throw on failure: callers slim the stored release
  // (dropping scenes) only when they believe the knowledge was persisted, so a
  // silent failure here permanently loses the site knowledge.
  const result = await database.prepare(`INSERT OR REPLACE INTO site_agent_v2_knowledge (site_agent_id, version, content_hash, knowledge_json, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(knowledge.siteAgentId, knowledge.version, knowledge.contentHash, JSON.stringify(knowledge), knowledge.updatedAt).run();
  if (!result.success) throw new Error(result.error || "site_knowledge_write_failed");
}

/**
 * Assigns (or reuses) the KnowledgeRevision for a knowledge blob and persists it,
 * returning the revision the caller stamps onto `release.knowledgeRevision`.
 *
 * The revision advances ONLY on a material change: if this exact material content
 * (`content_hash` — already volatile-stripped) already has a row for the site, its
 * revision is REUSED and nothing is written, so a config-only publish (agentConfig,
 * which is not part of the material profile/scenes/links) never mints a new revision.
 * A genuinely new material state takes `MAX(revision)+1`. The knowledge table's
 * `version` column IS the revision (no schema change: the same column, reinterpreted).
 *
 * Assignment is a COMPARE-AND-SET, not a bare read-then-write: allocating a revision
 * is a check-then-act (content-hash existence → MAX+1 → write), so two concurrent
 * writers of DIFFERENT content for one site could otherwise read the same MAX and
 * both target the same revision — and the Postgres `INSERT OR REPLACE` upsert would
 * let the second CLOBBER the first, permanently losing the first's knowledge (the
 * exact silent-loss class this table guards). Instead we claim the slot with
 * `INSERT OR IGNORE` (a no-op if a racer already took it) and then re-read: if the
 * slot holds someone else's content we retry at a fresh, strictly-higher MAX+1. This
 * is dialect-portable (a no-op fast path on single-writer SQLite/D1). Throws if the
 * write genuinely fails (the caller must not slim an unstored release).
 */
export async function persistKnowledgeRevision(database: D1DatabaseLike, siteAgentId: string, knowledge: SiteKnowledge): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    // Reuse an existing revision for identical material content (idempotent re-persist).
    const existing = await all<{ version: number }>(database, `SELECT version FROM site_agent_v2_knowledge WHERE site_agent_id=? AND content_hash=? ORDER BY version ASC LIMIT 1`, [siteAgentId, knowledge.contentHash]);
    if (existing[0]) return existing[0].version;
    const latest = await all<{ maxRevision: number | null }>(database, `SELECT MAX(version) AS maxRevision FROM site_agent_v2_knowledge WHERE site_agent_id=?`, [siteAgentId]);
    const revision = latest[0]?.maxRevision != null ? latest[0].maxRevision + 1 : knowledge.version;
    const stamped = { ...knowledge, version: revision };
    // Claim WITHOUT clobbering: INSERT OR IGNORE leaves a slot a racer already took.
    const result = await database.prepare(`INSERT OR IGNORE INTO site_agent_v2_knowledge (site_agent_id, version, content_hash, knowledge_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(stamped.siteAgentId, revision, stamped.contentHash, JSON.stringify(stamped), stamped.updatedAt).run();
    if (!result.success) throw new Error(result.error || "site_knowledge_write_failed");
    // Confirm WE own the slot (IGNORE is a no-op on collision); on a mismatch a
    // different content won this revision, so retry at a now-higher MAX+1.
    const claimed = await all<{ contentHash: string }>(database, `SELECT content_hash AS contentHash FROM site_agent_v2_knowledge WHERE site_agent_id=? AND version=? LIMIT 1`, [siteAgentId, revision]);
    if (claimed[0]?.contentHash === knowledge.contentHash) return revision;
  }
  throw new Error("site_knowledge_revision_contended");
}

// --- Content-search (build-knowledge-center-v1, phase 1) ---------------------
// Page text chunks live in their own table, separate from the knowledge JSON.
// Re-index is content-hash-gated PER URL: an unchanged page is skipped; a changed
// page's chunks are replaced wholesale (chunk count may change). Keyword ranking
// runs in JS over a site's chunks (portable across D1/Postgres — no native FTS).

export type SiteContentPageInput = {
  url: string;
  sceneId?: string;
  contentHash: string;
  chunks: Array<{ chunkIndex: number; headingPath?: string; text: string; source?: ContentSource }>;
};

function contentChunkId(siteAgentId: string, url: string, chunkIndex: number): string {
  return `${siteAgentId}::${url}::${chunkIndex}`;
}

/** Upsert one page's chunks, gated by contentHash. Returns whether it (re)indexed
 * (false = unchanged, skipped). Throws on a real write failure (the Postgres adapter
 * returns `{success:false}` rather than throwing). */
export async function writeSiteContentPage(database: D1DatabaseLike, siteAgentId: string, page: SiteContentPageInput, now: string): Promise<{ indexed: boolean }> {
  const existing = await all<{ contentHash: string }>(database, `SELECT content_hash AS contentHash FROM site_agent_v2_content WHERE site_agent_id=? AND url=? LIMIT 1`, [siteAgentId, page.url]);
  if (existing[0]?.contentHash === page.contentHash) return { indexed: false };
  const removed = await database.prepare(`DELETE FROM site_agent_v2_content WHERE site_agent_id=? AND url=?`).bind(siteAgentId, page.url).run();
  if (!removed.success) throw new Error(removed.error || "site_content_delete_failed");
  for (const chunk of page.chunks) {
    const result = await database.prepare(`INSERT OR REPLACE INTO site_agent_v2_content (id, site_agent_id, scene_id, url, chunk_index, heading_path, text, content_hash, updated_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(contentChunkId(siteAgentId, page.url, chunk.chunkIndex), siteAgentId, page.sceneId ?? null, page.url, chunk.chunkIndex, chunk.headingPath ?? null, chunk.text, page.contentHash, now, chunk.source ?? null).run();
    if (!result.success) throw new Error(result.error || "site_content_write_failed");
  }
  return { indexed: true };
}

/** Load every stored chunk for a site (the in-JS keyword scorer runs over these). */
/** Console "what's on this page" view: the stored content chunks for a scene, matched by
 *  its URL path pattern (content is indexed by url, not scene_id). A parameterized pattern
 *  like `/celebrity/{path1}` matches every instance URL; ordered by url + chunk so headings
 *  read top-to-bottom. */
export async function loadPageContent(siteAgentId: string, pathPattern: string): Promise<ContentChunkRow[]> {
  const database = getD1Binding();
  const pattern = pathPattern.trim();
  if (!pattern) return [];
  if (!database) {
    // `{param}` matches any instance URL, exactly as the LIKE below does.
    const matcher = new RegExp(`${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]+\\\}/g, ".*")}$`);
    return memoryContentChunks(siteAgentId)
      .filter((row) => matcher.test(row.url))
      .sort((left, right) => left.url.localeCompare(right.url) || left.chunkIndex - right.chunkIndex)
      .slice(0, 40);
  }
  await ensureSiteAgentV2Schema(database);
  // `{param}` → `%` so a template matches all its instance URLs; leading `%` absorbs the origin.
  const like = `%${pattern.replace(/%/g, "").replace(/\{[^}]+\}/g, "%")}`;
  const rows = await all<{ url: string; chunkIndex: number; headingPath: string | null; text: string }>(
    database,
    `SELECT url, chunk_index AS chunkIndex, heading_path AS headingPath, text, source FROM site_agent_v2_content WHERE site_agent_id=? AND url LIKE ? ORDER BY url, chunk_index LIMIT 40`,
    [siteAgentId, like],
  );
  return rows.map((row) => ({ url: row.url, chunkIndex: row.chunkIndex, headingPath: row.headingPath ?? undefined, text: row.text }));
}

/** The `read_page` backend: every indexed chunk of ONE exact URL, in reading order — the
 * agent's Read step after a grep hit, when a context window is not enough to answer. Reads
 * only the index (never touches the live page). Empty in memory mode / for an unindexed URL. */
export async function readPageByUrl(siteAgentId: string, url: string): Promise<ContentChunkRow[]> {
  const database = getD1Binding();
  const target = url.trim();
  if (!database || !target) return [];
  await ensureSiteAgentV2Schema(database);
  const rows = await all<{ url: string; sceneId: string | null; chunkIndex: number; headingPath: string | null; text: string }>(
    database,
    `SELECT url, scene_id AS sceneId, chunk_index AS chunkIndex, heading_path AS headingPath, text, source FROM site_agent_v2_content WHERE site_agent_id=? AND url=? ORDER BY chunk_index LIMIT 100`,
    [siteAgentId, target],
  );
  return rows.map((row) => ({ url: row.url, sceneId: row.sceneId ?? undefined, chunkIndex: row.chunkIndex, headingPath: row.headingPath ?? undefined, text: row.text }));
}

export async function loadSiteContentChunks(database: D1DatabaseLike, siteAgentId: string): Promise<ContentChunkRow[]> {
  const rows = await all<{ url: string; sceneId: string | null; chunkIndex: number; headingPath: string | null; text: string }>(
    database,
    `SELECT url, scene_id AS sceneId, chunk_index AS chunkIndex, heading_path AS headingPath, text, source FROM site_agent_v2_content WHERE site_agent_id=? ORDER BY url, chunk_index`,
    [siteAgentId],
  );
  return rows.map((row) => ({ url: row.url, sceneId: row.sceneId ?? undefined, chunkIndex: row.chunkIndex, headingPath: row.headingPath ?? undefined, text: row.text }));
}

/** Turn a scene URL template (`/celebrity/{path1}`) into a pathname matcher — literal
 * segments escaped, `{param}` → one path segment — so we can tell which scenes have
 * indexed content without pulling any text. */
function scenePathMatcher(pattern: string): RegExp {
  const escaped = pattern.split(/\{[^}]+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+");
  return new RegExp(`^${escaped}$`);
}

/** Site-wide content coverage (knowledge-center-manageability): page/chunk counts plus the
 * scenes that have NO indexed body text ("content missing"). Two cheap reads (a COUNT and the
 * DISTINCT url set) + in-JS matching; never pulls full text. */
export async function contentCoverage(database: D1DatabaseLike, siteAgentId: string, scenes: SceneDefinition[]): Promise<ContentCoverage> {
  const stats = await all<{ pages: number; chunks: number; chars: number }>(database, `SELECT COUNT(DISTINCT url) AS pages, COUNT(*) AS chunks, COALESCE(SUM(LENGTH(text)),0) AS chars FROM site_agent_v2_content WHERE site_agent_id=?`, [siteAgentId]);
  const urls = await all<{ url: string }>(database, `SELECT DISTINCT url FROM site_agent_v2_content WHERE site_agent_id=?`, [siteAgentId]);
  const paths = urls.map((row) => { try { return new URL(row.url).pathname; } catch { return row.url; } });
  const emptyPages = scenes.filter((scene) => {
    const pattern = scene.urlTemplates[0]?.pathnamePattern;
    if (!pattern) return true;
    const matcher = scenePathMatcher(pattern);
    return !paths.some((path) => matcher.test(path));
  }).map((scene) => ({ sceneId: scene.id, name: scene.name, path: scene.urlTemplates[0]?.pathnamePattern || "" }));
  return { indexedPages: Number(stats[0]?.pages || 0), totalChunks: Number(stats[0]?.chunks || 0), totalChars: Number(stats[0]?.chars || 0), scenesTotal: scenes.length, emptyPages };
}

/** Content backend of the unified search entry: load a site's chunks and run the
 * grep-style keyword-LIST search, returning the top PAGES with sentence-bounded context
 * windows so the agent answers from the knowledge base directly, plus the honest
 * `totalPagesWithHits`. A page backed by a known scene gets a small rank bump. Empty in
 * memory mode (no content index) — the caller still has structure results (`routes`), so
 * the agent degrades to structure + live read. A miss returns empty; nothing is recorded. */
export async function searchSiteContent(siteAgentId: string, keywords: string[], options?: { topPages?: number }): Promise<GrepResult> {
  const database = getD1Binding();
  if (!database) {
    return grepSiteContent(memoryContentChunks(siteAgentId), keywords, {
      topPages: options?.topPages,
      pageBonus: (page) => (page.sceneId ? 0.05 : 0),
    });
  }
  await ensureSiteAgentV2Schema(database);
  const chunks = await loadSiteContentChunks(database, siteAgentId);
  return grepSiteContent(chunks, keywords, {
    topPages: options?.topPages,
    pageBonus: (page) => (page.sceneId ? 0.05 : 0),
  });
}

/**
 * Read-only diagnostic backend of the console probe (knowledge-center-manageability).
 * Loads the site's chunks ONCE, runs the SAME grep as the runtime search, and — for the
 * "search problem vs knowledge gap" verdict — checks whether the raw question's terms
 * appear anywhere literally. Purely read: writes nothing, records no demand signal. Empty
 * (with `coverageOfQuery.appears=false`) in memory mode. */
export async function probeContentDiagnosis(siteAgentId: string, keywords: string[], diagnosisText: string): Promise<GrepResult & { coverageOfQuery: { appears: boolean; sampleUrls: string[] } }> {
  const database = getD1Binding();
  if (!database) return { pages: [], totalPagesWithHits: 0, coverageOfQuery: { appears: false, sampleUrls: [] } };
  await ensureSiteAgentV2Schema(database);
  const chunks = await loadSiteContentChunks(database, siteAgentId);
  const result = grepSiteContent(chunks, keywords, { topPages: 5, pageBonus: (page) => (page.sceneId ? 0.05 : 0) });
  return { ...result, coverageOfQuery: queryTermsAppear(chunks, diagnosisText) };
}

/** Ingest a set of rendered pages into the content index (chunk + hash + write,
 * per-URL contentHash-gated). The crawl pipeline / a debug ingest both call this.
 * Empty no-op in memory mode. */
/**
 * Source of the indexed body text. Defaults to the block-filtered text; "off" rolls
 * back to the full page text — the migration's single switch, so a rollback is one
 * environment variable.
 */
function contentFilterEnabled(): boolean {
  return (process.env.SITEWAKE_CONTENT_FILTER || "on").toLowerCase() !== "off";
}

export async function ingestSiteContentPages(siteAgentId: string, pages: ContentPage[]): Promise<{
  persistence: "memory" | "d1";
  indexed: number;
  skipped: number;
  /** Filter statistics: visible in the console, no human confirmation of any verdict needed. */
  contentFilter?: { enabled: boolean; pagesFiltered: number; emptyContentPages: number; purgedPages: number; writtenChars: number; health?: unknown };
}> {
  const database = getD1Binding();
  if (!database) {
    // Same chunking, same shared-chrome stripping and the same contentHash gate
    // as the D1 path; only the row store differs.
    const cleaned = stripSharedChrome(pages);
    const store = memoryContent(siteAgentId);
    let indexed = 0;
    let skipped = 0;
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index]!;
      const visibleText = cleaned[index] || "";
      if (!visibleText.trim()) { skipped += 1; continue; }
      const built = buildContentPage({ ...page, visibleText });
      if (store.get(built.url)?.contentHash === built.contentHash) { skipped += 1; continue; }
      store.set(built.url, {
        contentHash: built.contentHash,
        rows: built.chunks.map((chunk) => ({
          url: built.url,
          sceneId: built.sceneId,
          chunkIndex: chunk.chunkIndex,
          headingPath: chunk.headingPath,
          text: chunk.text,
        })),
      });
      indexed += 1;
    }
    return { persistence: "memory", indexed, skipped };
  }
  await ensureSiteAgentV2Schema(database);
  const now = new Date().toISOString();
  // Strip shared nav/footer chrome across the batch so page-specific content ranks
  // instead of being buried under site boilerplate.
  // Indexed body: prefer the block-filtered output, fall back to the full page text.
  // Cross-page duplicate-line removal still runs afterwards — demoted from "the only
  // defence" to a fallback for cross-page chrome the block-level signals cannot reach.
  const useFiltered = contentFilterEnabled();
  const sourced = pages.map((page) => ({
    ...page,
    visibleText: useFiltered && typeof page.filteredText === "string" ? page.filteredText : page.visibleText,
  }));
  const cleaned = stripSharedChrome(sourced);
  let indexed = 0;
  let skipped = 0;
  let purged = 0;
  // Characters actually written: counted only after the cross-page layer stripped the
  // chrome and this page was really rewritten. Filtered volume is not written volume —
  // unchanged pages are skipped, and the cross-page layer has not run yet here.
  let writtenChars = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const visibleText = cleaned[index];
    if (!visibleText.trim()) {
      // This page turned out to hold no knowledge (its whole class was excluded by the
      // cross-instance layer, or the shape layer dropped everything). Skipping the write
      // is not enough: last round's body would linger and the knowledge base never
      // gets clean. This round concluded "this page does not belong", so delete it —
      // the next round writes it back once content is found again.
      const removed = await database
        .prepare(`DELETE FROM site_agent_v2_content WHERE site_agent_id=? AND url=?`)
        .bind(siteAgentId, pages[index].url).run();
      if (Number(removed.meta?.changes || 0) > 0) purged += 1;
      skipped += 1;
      continue;
    }
    const result = await writeSiteContentPage(database, siteAgentId, buildContentPage({ ...sourced[index], visibleText }), now);
    if (result.indexed) {
      indexed += 1;
      writtenChars += visibleText.length + (sourced[index].description?.trim().length ?? 0);
    } else skipped += 1;
  }
  const reports = pages
    .map((page) => page.filterReport)
    .filter((report): report is Record<string, unknown> => Boolean(report));
  return {
    persistence: "d1",
    indexed,
    skipped,
    contentFilter: {
      enabled: useFiltered,
      pagesFiltered: reports.length,
      emptyContentPages: sourced.filter((page) => useFiltered && page.filteredText === "").length,
      purgedPages: purged,
      writtenChars,
      health: reports.length ? siteHealth(reports as never) : undefined,
    },
  };
}

/**
 * Shared adoption core: turns a crawl document into a new base-layer release
 * (version+1) and returns the statements to persist it + point the agent's
 * active release at it. Crawl contributes structure; `mergeScenes` keeps
 * usage/human-refined semantics on the current release, so a re-crawl never
 * overwrites them.
 */
/**
 * Reads/writes of crawl observation records (the cross-time comparison baseline).
 *
 * They are **not knowledge** but the crawl ledger: one row per URL, overwritten on
 * every crawl. They used to live inside the release / knowledge JSON, where every
 * re-crawl added a version with a full copy — one site reached 10 MB over 46
 * versions, and the release row is read on every agent load.
 */
export async function readPageObservations(siteAgentId: string): Promise<Record<string, PageObservation[]>> {
  const database = getD1Binding();
  if (!database) return {};
  await ensureSiteAgentV2Schema(database);
  const rows = await all<{ url: string; observationsJson: string }>(
    database,
    `SELECT url, observations_json AS observationsJson FROM site_agent_v2_page_observations WHERE site_agent_id=?`,
    [siteAgentId],
  );
  const result: Record<string, PageObservation[]> = {};
  for (const row of rows) {
    try { result[row.url] = JSON.parse(row.observationsJson) as PageObservation[]; } catch { /* 坏行跳过，等于该页首爬 */ }
  }
  return result;
}

/** URLs confirmed dead: drop their observation records and indexed body together. */
async function purgeDeadUrls(database: D1DatabaseLike, siteAgentId: string, urls: string[]): Promise<void> {
  for (const url of urls.slice(0, 200)) {
    await database.prepare(`DELETE FROM site_agent_v2_page_observations WHERE site_agent_id=? AND url=?`).bind(siteAgentId, url).run();
    await database.prepare(`DELETE FROM site_agent_v2_content WHERE site_agent_id=? AND url=?`).bind(siteAgentId, url).run();
  }
}

export async function writePageObservations(
  siteAgentId: string,
  observations: Record<string, PageObservation[]>,
  now: string,
): Promise<{ written: number }> {
  const database = getD1Binding();
  if (!database) return { written: 0 };
  const entries = Object.entries(observations || {});
  if (!entries.length) return { written: 0 };
  await ensureSiteAgentV2Schema(database);
  const statements = entries.map(([url, history]) => database
    .prepare(`INSERT OR REPLACE INTO site_agent_v2_page_observations (site_agent_id, url, observations_json, updated_at) VALUES (?, ?, ?, ?)`)
    .bind(siteAgentId, url, JSON.stringify(history.slice(0, 2)), now));
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "page_observations_write_failed");
  return { written: entries.length };
}

function mergeDataPageTypes(
  current: SiteAgentReleaseV2["dataPageTypes"],
  adopted: SiteAgentReleaseV2["dataPageTypes"],
): SiteAgentReleaseV2["dataPageTypes"] {
  const byPattern = new Map((current || []).map((entry) => [entry.urlPattern, entry]));
  for (const entry of adopted || []) byPattern.set(entry.urlPattern, entry);
  return [...byPattern.values()];
}

async function buildCrawlAdoption(
  database: D1DatabaseLike,
  siteAgentId: string,
  document: SiteKnowledgeDocument,
  now: string,
  guard?: { jobId: string; jobJson: string },
) {
  await requireD1Agent(database, siteAgentId);
  const current = await d1Release(database, siteAgentId) || emptyRelease(siteAgentId, now);
  const versions = await all<{ maxVersion: number | null }>(
    database,
    `SELECT MAX(version) AS maxVersion
       FROM site_agent_v2_releases
      WHERE site_agent_id=?`,
    [siteAgentId],
  );
  const nextVersion = Math.max(current.version, versions[0]?.maxVersion ?? 0) + 1;
  const adopted = siteKnowledgeDocumentToRelease(document, {
    version: nextVersion,
    createdAt: now,
  });
  // Only let a crawl replace the profile when it produced a real AI profile; a
  // bland default (host name) must never clobber the existing one.
  const crawlProfileIsRich = adopted.profile.semanticSource === "ai" || adopted.profile.semanticSource === "human";
  // allowedOrigins is admin-controlled deploy policy (where the SDK may embed),
  // set out-of-band and unknowable to a crawl — a crawl only sees the site it
  // rendered. Preserve it verbatim across a re-crawl (as releaseFromConnection
  // does for every learned Release), or the crawl silently wipes the embed origin
  // and every widget connection 403s. Union so a crawl may only ADD origins.
  // (On read, canonicalize re-anchors entryUrl to a preserved origin, so a crawl
  // that mis-inferred entryUrl can't strand it off-origin either.)
  const adoptedProfile = crawlProfileIsRich
    ? { ...adopted.profile, allowedOrigins: [...new Set([...(current.profile.allowedOrigins || []), ...(adopted.profile.allowedOrigins || [])])] }
    : current.profile;
  const release: SiteAgentReleaseV2 = {
    ...emptyRelease(siteAgentId, now),
    id: `${siteAgentId}:release:${nextVersion}`,
    version: nextVersion,
    profile: adoptedProfile,
    agentConfig: current.agentConfig,
    // Only a complete crawl may retire old scenes: partial/failed crawls must not delete knowledge.
    scenes: mergeScenes(retireUnseenReferencedScenes(current.scenes, adopted.scenes, document.deadUrls, document.unreachableUrls), adopted.scenes),
    // Aggregate to the page-TYPE level (aggregate-knowledge-links): collapse site-wide nav to
    // one "*" edge per target and dedupe content links to scene-pairs. Runs AFTER the merge so
    // the stored release always converges to the aggregated form regardless of legacy input.
    linkReferences: aggregateKnowledgeLinks(mergeLinkReferences(current.linkReferences || [], adopted.linkReferences || [])),
    targets: current.targets,
    operations: current.operations,
    navigationTools: current.navigationTools,
    capabilities: current.capabilities,
    sourceEpisodeIds: current.sourceEpisodeIds,
    // A template rendered to a single instance has nothing to compare against; that
    // must not erase the type description decided last time. (Observation records are
    // not here — they are the crawl ledger in site_agent_v2_page_observations.)
    ...(adopted.dataPageTypes?.length || current.dataPageTypes?.length
      ? { dataPageTypes: mergeDataPageTypes(current.dataPageTypes, adopted.dataPageTypes) }
      : {}),
  };
  release.contentHash = stableHash(JSON.stringify({ ...release, contentHash: undefined, knowledgeRevision: undefined }));
  const statements = guard
    ? [
        database.prepare(`INSERT OR IGNORE INTO site_agent_v2_releases
          (id,site_agent_id,version,content_hash,release_json,created_at)
          SELECT ?,?,?,?,?,?
          WHERE EXISTS (
            SELECT 1 FROM site_agent_v2_crawl_jobs
             WHERE id=? AND site_agent_id=? AND job_json=?
               AND status IN ('leased','running')
          )`)
          .bind(
            release.id,
            siteAgentId,
            release.version,
            release.contentHash,
            JSON.stringify(release),
            now,
            guard.jobId,
            siteAgentId,
            guard.jobJson,
          ),
        database.prepare(`UPDATE site_agent_v2_agents
          SET profile_json=?,active_release_id=?,updated_at=?
          WHERE id=? AND active_release_id=?
            AND EXISTS (
              SELECT 1 FROM site_agent_v2_releases
               WHERE id=? AND site_agent_id=? AND version=? AND content_hash=?
            )
            AND EXISTS (
              SELECT 1 FROM site_agent_v2_crawl_jobs
               WHERE id=? AND site_agent_id=? AND job_json=?
                 AND status IN ('leased','running')
            )`)
          .bind(
            JSON.stringify(release.profile),
            release.id,
            now,
            siteAgentId,
            current.id,
            release.id,
            siteAgentId,
            release.version,
            release.contentHash,
            guard.jobId,
            siteAgentId,
            guard.jobJson,
          ),
      ]
    : [
        database.prepare(`INSERT OR IGNORE INTO site_agent_v2_releases (id, site_agent_id, version, content_hash, release_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(release.id, siteAgentId, release.version, release.contentHash, JSON.stringify(release), now),
        database.prepare(`UPDATE site_agent_v2_agents
          SET profile_json=?,active_release_id=?,updated_at=?
          WHERE id=? AND active_release_id=?
            AND EXISTS (
              SELECT 1 FROM site_agent_v2_releases
               WHERE id=? AND site_agent_id=? AND version=? AND content_hash=?
            )`)
          .bind(
            JSON.stringify(release.profile),
            release.id,
            now,
            siteAgentId,
            current.id,
            release.id,
            siteAgentId,
            release.version,
            release.contentHash,
          ),
      ];
  return { release, statements, newScenes: countNewScenes(current.scenes, release.scenes) };
}

/** Directly adopt a crawl document as a base-layer release (dev / preview path — no lease). */
export async function adoptCrawlDocument(siteAgentId: string, document: SiteKnowledgeDocument): Promise<{ release?: SiteAgentReleaseV2; persistence: "memory" | "d1" }> {
  const active = await getActiveSiteAgentRelease(siteAgentId);
  assertValidSiteKnowledgeDocument(document, {
    siteAgentId,
    origin: active.release.profile.entryUrl || document.meta.origin,
  });
  const database = getD1Binding();
  if (!database) return { persistence: "memory" };
  await ensureSiteAgentV2Schema(database);
  if (!document.scenes.length) return { persistence: "d1" }; // empty crawl → don't touch the release
  // Review is a step of the crawl: it runs before publishing and merges into the document.
  await reviewCrawlDocumentInPlace(database, siteAgentId, document).catch(() => undefined);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const now = new Date().toISOString();
    const { release, statements } = await buildCrawlAdoption(
      database,
      siteAgentId,
      document,
      now,
    );
    const results = await database.batch(statements);
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "crawl_adopt_failed");
    if (Number(results.at(-1)?.meta?.changes || 0) < 1) continue;
    const active = await all<{ activeReleaseId: string; contentHash: string }>(
      database,
      `SELECT a.active_release_id AS activeReleaseId,
              r.content_hash AS contentHash
         FROM site_agent_v2_agents a
         JOIN site_agent_v2_releases r ON r.id=a.active_release_id
        WHERE a.id=? LIMIT 1`,
      [siteAgentId],
    );
    if (active[0]?.activeReleaseId !== release.id
      || active[0].contentHash !== release.contentHash) {
      continue;
    }
    invalidateSiteAgentListCache();
    // Review already ran before publishing (see the top of the loop below) — one crawl = one version.
    return { release, persistence: "d1" };
  }
  throw new Error("crawl_adopt_contended");
}

/** Completes a leased crawl job, adopts its document, and marks the job succeeded. */
/**
 * Last step of a crawl: the AI review — names page types and refreshes the site profile.
 *
 * **It runs before publishing and merges into the document, so one crawl publishes one
 * version.** It used to run after publishing and had to publish its result as another
 * version, so each crawl consumed two version numbers, the first being the
 * "page types not named yet" intermediate state. A version should be the product of the
 * whole pipeline; intermediate states do not deserve one.
 *
 * A failure still publishes — **a model outage must not block releases**. The failure is
 * reported as is and the UI suggests re-crawling; no retry, no queue, crawls are independent.
 */
async function reviewCrawlDocumentInPlace(
  database: D1DatabaseLike,
  siteAgentId: string,
  document: SiteKnowledgeDocument,
): Promise<{ reviewed: number; failed: boolean }> {
  const snapshot = crawlReviewSnapshot(document);
  const current = await d1Release(database, siteAgentId) || emptyRelease(siteAgentId);
  const reviewable = document.scenes.filter((scene) => sceneNeedsSemanticReview(scene, undefined, false));
  const profileEvidenceHash = siteProfileEvidenceHash(snapshot, document.scenes);
  let failed = false;
  const [profile, reviewed] = await Promise.all([
    siteProfileNeedsSemanticReview(document.profile, profileEvidenceHash, undefined, false)
      ? analyzeSiteProfile(snapshot, document.profile, document.scenes).catch(() => { failed = true; return undefined; })
      : Promise.resolve(undefined),
    reviewable.length
      ? reviewSceneSemantics(snapshot, reviewable, current.scenes.flatMap((scene) => scene.businessArea ? [scene.businessArea] : []))
        .catch(() => { failed = true; return [] as SiteAgentReleaseV2["scenes"]; })
      : Promise.resolve([] as SiteAgentReleaseV2["scenes"]),
  ]);
  const reviewedById = new Map(reviewed.map((scene) => [scene.id, scene]));
  if (reviewedById.size) document.scenes = document.scenes.map((scene) => reviewedById.get(scene.id) || scene);
  if (profile) document.profile = profile;
  if (reviewable.length && !reviewedById.size) failed = true;
  return { reviewed: reviewedById.size, failed };
}

export async function completeCrawlJob(runnerId: string, leaseToken: string, siteAgentId: string, jobId: string, document: SiteKnowledgeDocument, contentFilter?: NonNullable<CrawlJob["result"]>["contentFilter"]): Promise<{ release?: SiteAgentReleaseV2; persistence: "memory" | "d1" }> {
  const database = getD1Binding();
  if (!database) return { persistence: "memory" };
  await ensureSiteAgentV2Schema(database);
  const completionIdentity = {
    runnerId,
    leaseTokenHash: stableHash(leaseToken),
    kind: "succeeded" as const,
    payloadHash: stableHash(JSON.stringify(document)),
  };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const now = new Date().toISOString();
    const rows = await all<CrawlJobRow>(
      database,
      `SELECT job_json AS jobJson
         FROM site_agent_v2_crawl_jobs
        WHERE id=? LIMIT 1`,
      [jobId],
    );
    const job = rows[0] ? JSON.parse(rows[0].jobJson) as CrawlJob : undefined;
    if (!job) throw new Error("crawl_job_missing");
    if (job.status === "succeeded"
      && JSON.stringify(job.completion) === JSON.stringify(completionIdentity)) {
      const release = job.result?.releaseId
        ? (await d1ReleaseById(database, siteAgentId, job.result.releaseId))
          ?? undefined
        : undefined;
      return { release, persistence: "d1" };
    }
    if (job.siteAgentId !== siteAgentId
      || job.lease?.token !== leaseToken
      || job.lease?.runnerId !== runnerId) {
      throw new Error("crawl_lease_invalid");
    }
    if (!job.lease.expiresAt || job.lease.expiresAt <= now) {
      throw new Error("crawl_lease_expired");
    }
    assertValidSiteKnowledgeDocument(document, {
      siteAgentId,
      origin: job.origin,
      limits: job.limits,
    });
    // An empty crawl (0 scenes, e.g. an SPA that rendered nothing) still
    // finishes the job, but must not create a release or clobber the profile.
    // Observation records go to their own table: they are the crawl ledger and do not
    // accumulate with release versions. Written before adoption so that even if adoption
    // yields to a concurrent writer, what was actually seen is recorded — which is
    // exactly what the fourth layer needs.
    if (document.observations) {
      await writePageObservations(siteAgentId, document.observations, now).catch(() => undefined);
    }
    // URLs confirmed as error pages: drop observation records and indexed body together,
    // otherwise they hang in the coverage figures forever.
    if (document.deadUrls?.length) {
      await purgeDeadUrls(database, siteAgentId, document.deadUrls).catch(() => undefined);
    }
    // Review is a step of the crawl, not a separate thing after it — finish it first,
    // then publish the single version.
    const review = document.scenes.length
      ? await reviewCrawlDocumentInPlace(database, siteAgentId, document).catch(() => ({ reviewed: 0, failed: true }))
      : undefined;
    const adoption = document.scenes.length
      ? await buildCrawlAdoption(
          database,
          siteAgentId,
          document,
          now,
          { jobId: job.id, jobJson: rows[0].jobJson },
        )
      : undefined;
    const succeeded: CrawlJob = {
      ...job,
      status: "succeeded",
      lease: undefined,
      completion: completionIdentity,
      result: {
        scenes: document.scenes.length,
        links: document.links.length,
        pagesRendered: document.meta.stats.pagesRendered,
        releaseId: adoption?.release.id,
        ...(adoption ? { newScenes: adoption.newScenes } : {}),
        ...(review ? { review } : {}),
        ...(contentFilter ? { contentFilter } : {}),
      },
      updatedAt: now,
    };
    const terminal = adoption
      ? database.prepare(`UPDATE site_agent_v2_crawl_jobs
          SET status='succeeded',lease_expires_at=?,result_json=?,job_json=?,updated_at=?
          WHERE id=? AND site_agent_id=? AND job_json=?
            AND status IN ('leased','running')
            AND EXISTS (
              SELECT 1 FROM site_agent_v2_releases
               WHERE id=? AND site_agent_id=? AND version=? AND content_hash=?
            )
            AND EXISTS (
              SELECT 1 FROM site_agent_v2_agents
               WHERE id=? AND active_release_id=?
            )`)
          .bind(
            null,
            JSON.stringify(succeeded.result),
            JSON.stringify(succeeded),
            now,
            job.id,
            siteAgentId,
            rows[0].jobJson,
            adoption.release.id,
            siteAgentId,
            adoption.release.version,
            adoption.release.contentHash,
            siteAgentId,
            adoption.release.id,
          )
      : database.prepare(`UPDATE site_agent_v2_crawl_jobs
          SET status='succeeded',lease_expires_at=?,result_json=?,job_json=?,updated_at=?
          WHERE id=? AND site_agent_id=? AND job_json=?
            AND status IN ('leased','running')`)
          .bind(
            null,
            JSON.stringify(succeeded.result),
            JSON.stringify(succeeded),
            now,
            job.id,
            siteAgentId,
            rows[0].jobJson,
          );
    const adoptionStatements = adoption?.statements ?? [];
    const results = await database.batch([
      database.prepare(`UPDATE site_agent_v2_crawl_jobs
        SET updated_at=updated_at
        WHERE id=? AND site_agent_id=? AND job_json=?
          AND status IN ('leased','running')`)
        .bind(job.id, siteAgentId, rows[0].jobJson),
      ...adoptionStatements,
      terminal,
    ]);
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "crawl_adopt_failed");
    // Success means **the active-version pointer moved**, not merely that the job-status
    // statement ran.
    //
    // The job-status statement is guarded by "the release row for this version exists",
    // and that row was inserted by this very batch — it always exists. So when a
    // concurrent publisher (a widget connection report) moved the active pointer first,
    // the crawl's CAS failed and the pointer stayed put, yet the job was marked
    // successful with its releaseId. Result: **the crawl reported success while its
    // version was orphaned** — production had a v52 created at 05:37 sorted after a v53
    // created at 05:36, with v53 active. The retry below was written for exactly this
    // case (re-merging onto the new active version as MAX(version)+1) but checked the
    // wrong signal and never fired.
    const activePointerMoved = adoptionStatements.length === 0
      || Number(results[adoptionStatements.length]?.meta?.changes || 0) > 0;
    if (activePointerMoved && Number(results.at(-1)?.meta?.changes || 0) > 0) {
      invalidateSiteAgentListCache();
      // Review already ran and merged before publishing — one crawl = one version, no second one here.
      return { release: adoption?.release, persistence: "d1" };
    }
    // A concurrent publisher or another crawl may have won the active Release
    // CAS or occupied this version. Re-read the still-fenced job and merge the
    // crawl onto the new active Release at a fresh MAX(version)+1.
  }
  throw new Error("crawl_adopt_contended");
}

/**
 * Resolves a leased crawl job as `failed` with the runner's error. Without this
 * a render/parse crash left the job `leased/running` until the 15-minute lease
 * expiry, so the console showed "crawling…" for minutes with no way to recover.
 * Marking it failed surfaces the real error and re-enables the "crawl this site" action.
 */
export async function failCrawlJob(runnerId: string, leaseToken: string, jobId: string, error: string): Promise<{ persistence: "memory" | "d1" }> {
  const database = getD1Binding();
  if (!database) return { persistence: "memory" };
  await ensureSiteAgentV2Schema(database);
  const now = new Date().toISOString();
  const rows = await all<CrawlJobRow>(database, `SELECT job_json AS jobJson FROM site_agent_v2_crawl_jobs WHERE id=? LIMIT 1`, [jobId]);
  const job = rows[0] ? JSON.parse(rows[0].jobJson) as CrawlJob : undefined;
  if (!job) throw new Error("crawl_job_missing");
  const normalizedError = error.slice(0, 500);
  const completionIdentity = {
    runnerId,
    leaseTokenHash: stableHash(leaseToken),
    kind: "failed" as const,
    payloadHash: stableHash(normalizedError),
  };
  if (job.status === "failed"
    && JSON.stringify(job.completion) === JSON.stringify(completionIdentity)) {
    return { persistence: "d1" };
  }
  if (job.lease?.token !== leaseToken || job.lease?.runnerId !== runnerId) throw new Error("crawl_lease_invalid");
  if (!job.lease.expiresAt || job.lease.expiresAt <= now) throw new Error("crawl_lease_expired");
  const failed: CrawlJob = {
    ...job,
    status: "failed",
    lease: undefined,
    completion: completionIdentity,
    error: normalizedError,
    updatedAt: now,
  };
  const result = await database.prepare(`UPDATE site_agent_v2_crawl_jobs
    SET status='failed',lease_expires_at=?,job_json=?,updated_at=?
    WHERE id=? AND job_json=? AND status IN ('leased','running')`)
    .bind(null, JSON.stringify(failed), now, job.id, rows[0].jobJson).run();
  if (!result.success) throw new Error(result.error || "crawl_fail_update_failed");
  if (Number(result.meta?.changes || 0) < 1) throw new Error("crawl_lease_invalid");
  invalidateSiteAgentListCache();
  return { persistence: "d1" };
}

export async function renewCrawlJobLease(
  runnerId: string,
  leaseToken: string,
  jobId: string,
): Promise<{ expiresAt: string; persistence: "memory" | "d1" }> {
  const database = getD1Binding();
  const expiresAt = new Date(Date.now() + CRAWL_LEASE_TTL_MS).toISOString();
  if (!database) return { expiresAt, persistence: "memory" };
  await ensureSiteAgentV2Schema(database);
  const now = new Date().toISOString();
  const rows = await all<CrawlJobRow>(
    database,
    `SELECT job_json AS jobJson FROM site_agent_v2_crawl_jobs
      WHERE id=? AND status IN ('leased','running') LIMIT 1`,
    [jobId],
  );
  const job = rows[0] ? JSON.parse(rows[0].jobJson) as CrawlJob : undefined;
  // A missing job (site deleted, job purged) is a 404, not a lease conflict: the runner
  // stops instead of retrying.
  if (!job) throw new Error("crawl_job_missing");
  if (job.lease?.runnerId !== runnerId
    || job.lease.token !== leaseToken
    || job.lease.expiresAt <= now) {
    throw new Error("crawl_lease_invalid");
  }
  const renewed: CrawlJob = {
    ...job,
    status: "running",
    lease: { ...job.lease, expiresAt },
    updatedAt: now,
  };
  const result = await database.prepare(`UPDATE site_agent_v2_crawl_jobs
    SET status='running',lease_expires_at=?,job_json=?,updated_at=?
    WHERE id=? AND job_json=? AND status IN ('leased','running')`)
    .bind(expiresAt, JSON.stringify(renewed), now, job.id, rows[0].jobJson)
    .run();
  if (!result.success) throw new Error(result.error || "crawl_lease_renew_failed");
  if (Number(result.meta?.changes || 0) < 1) throw new Error("crawl_lease_invalid");
  return { expiresAt, persistence: "d1" };
}

async function closeInterruptedBrowserRuns(database: D1DatabaseLike, learningJobId: string, now: string) {
  const rows = await all<BrowserRunRow>(database, `SELECT run_json AS runJson FROM site_agent_v2_browser_runs WHERE learning_job_id=? AND status='running'`, [learningJobId]);
  if (!rows.length) return;
  const statements = rows.map((row) => {
    const run = JSON.parse(row.runJson) as BrowserRun;
    const closed: BrowserRun = {
      ...run,
      status: "failed",
      endedAt: now,
      outcome: run.outcome || { status: "execution-fault", code: "runner_interrupted", summary: "上一次 Codex Runner 中断，任务已由新 Attempt 接管。", evaluatedAt: now, evidence: { source: "runner-watchdog" } },
    };
    return database.prepare(`UPDATE site_agent_v2_browser_runs SET status='failed',run_json=?,ended_at=? WHERE id=? AND status='running'`).bind(JSON.stringify(closed), now, run.id);
  });
  await database.batch(statements);
}

export type RunnerAuthorityLeaseClaim = {
  authority: "central" | "legacy";
  grant: RunnerLeaseGrant<unknown>;
};

export function projectRunnerAuthorityBusinessLease(
  claim: RunnerAuthorityLeaseClaim,
): LegacyRunnerLeaseRef {
  const { grant } = claim;
  const publicBusinessLease = {
    runnerId: grant.lease.runnerId,
    token: grant.token,
    leasedAt: grant.lease.leasedAt,
    expiresAt: grant.lease.expiresAt,
  };
  return claim.authority === "central"
    ? {
      ...publicBusinessLease,
      leaseId: grant.lease.id,
      fence: grant.lease.fence,
      runnerSessionId: grant.lease.runnerSessionId,
    }
    : publicBusinessLease;
}

function controlIdentityFromBusinessLease(
  runnerId: string,
  leaseToken: string,
  lease?: LegacyRunnerLeaseRef,
) {
  if (configuredRunnerLeaseAuthority() === "legacy"
    || lease?.runnerId !== runnerId
    || lease.token !== leaseToken
    || !lease.leaseId
    || !lease.runnerSessionId
    || !Number.isInteger(lease.fence)) return undefined;
  return {
    runnerId,
    runnerSessionId: lease.runnerSessionId,
    legacy: true as const,
    leaseId: lease.leaseId,
    token: lease.token,
    fence: lease.fence!,
  };
}

function businessLeaseAuthorized(
  lease: LegacyRunnerLeaseRef | undefined,
  runnerId: string,
  leaseToken: string,
) {
  return Boolean(lease
    && lease.runnerId === runnerId
    && lease.token === leaseToken
    && lease.expiresAt > new Date().toISOString());
}

async function synchronizedBusinessLeaseExpiry(lease: LegacyRunnerLeaseRef) {
  const now = new Date();
  if (lease.expiresAt <= now.toISOString()) throw new Error("runner_lease_expired");
  if (configuredRunnerLeaseAuthority() === "legacy") {
    return new Date(now.getTime() + 15 * 60_000).toISOString();
  }
  const identity = controlIdentityFromBusinessLease(lease.runnerId, lease.token, lease);
  if (!identity) return new Date(now.getTime() + 15 * 60_000).toISOString();
  const central = await getRunnerLeaseMirror(identity);
  return central.lease.expiresAt;
}

export async function resolveCapabilityRunLeaseControl(
  runnerId: string,
  leaseToken: string,
  runId: string,
) {
  const database = getD1Binding();
  if (!database) return undefined;
  await ensureSiteAgentV2Schema(database);
  const rows = await all<CapabilityRunRow>(database,
    `SELECT run_json AS runJson FROM site_agent_v2_capability_runs WHERE id=? LIMIT 1`,
    [runId]);
  const run = rows[0] ? JSON.parse(rows[0].runJson) as CapabilityRun : undefined;
  return controlIdentityFromBusinessLease(runnerId, leaseToken, run?.lease);
}

export async function resolveBrowserRunLeaseControl(
  runnerId: string,
  leaseToken: string,
  run: Pick<BrowserRun, "learningJobId" | "validationJobId">,
) {
  const database = getD1Binding();
  if (!database) return undefined;
  await ensureSiteAgentV2Schema(database);
  if (run.validationJobId) {
    const rows = await all<ValidationJobRow>(database,
      `SELECT job_json AS jobJson FROM site_agent_v2_validation_jobs WHERE id=? LIMIT 1`,
      [run.validationJobId]);
    const validation = rows[0] ? JSON.parse(rows[0].jobJson) as ValidationJob : undefined;
    const identity = controlIdentityFromBusinessLease(runnerId, leaseToken, validation?.lease);
    if (identity) return identity;
  }
  const rows = await all<LearningJobRow>(database,
    `SELECT result_json AS jobJson FROM site_agent_v2_learning_jobs WHERE id=? LIMIT 1`,
    [run.learningJobId]);
  const learning = rows[0] ? JSON.parse(rows[0].jobJson) as LearningJob : undefined;
  return controlIdentityFromBusinessLease(runnerId, leaseToken, learning?.lease);
}

function placementMiss(error: unknown) {
  const message = String(error);
  return message.includes("runner_placement_") || message.includes("runner_work_already_leased");
}

export type RunnerCandidateCursor = { id: string; createdAt: string };

export async function scanRunnerCandidates<T extends RunnerCandidateCursor, TResult>(
  loadPage: (cursor: RunnerCandidateCursor | undefined, pageSize: number) => Promise<T[]>,
  visit: (candidate: T) => Promise<TResult | undefined>,
  pageSize = 100,
): Promise<TResult | undefined> {
  let cursor: RunnerCandidateCursor | undefined;
  while (true) {
    const page = await loadPage(cursor, pageSize);
    if (!page.length) return undefined;
    for (const candidate of page) {
      const result = await visit(candidate);
      if (result !== undefined) return result;
    }
    const last = page.at(-1)!;
    const nextCursor = { id: last.id, createdAt: last.createdAt };
    if (cursor && nextCursor.id === cursor.id && nextCursor.createdAt === cursor.createdAt) {
      throw new Error("runner_candidate_scan_stalled");
    }
    if (page.length < pageSize) return undefined;
    cursor = nextCursor;
  }
}

async function releaseControlLease(claim: RunnerAuthorityLeaseClaim, reason: string) {
  if (claim.authority === "legacy") return;
  const { grant } = claim;
  await completeRunnerLease({
    runnerId: grant.lease.runnerId,
    runnerSessionId: grant.lease.runnerSessionId,
    legacy: true,
    leaseId: grant.lease.id,
    token: grant.token,
    fence: grant.lease.fence,
    status: "released",
    result: { reason },
  }).catch(() => undefined);
}

type RunnerAuthorityLeaseInput = {
  runnerId: string;
  runnerSessionId?: string;
  sessionToken?: string;
  workloadKind: RunnerWorkloadKind;
  workloadId: string;
  siteAgentId: string;
  workKind: RunnerWorkKind;
};

export async function claimRunnerAuthorityLease(
  input: RunnerAuthorityLeaseInput,
): Promise<RunnerAuthorityLeaseClaim> {
  const authority = configuredRunnerLeaseAuthority();
  if (authority === "legacy") {
    const now = new Date();
    const leasedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
    return {
      authority,
      grant: {
        lease: {
          id: `legacy_lease_${crypto.randomUUID()}`,
          poolId: DEFAULT_RUNNER_POOL_ID,
          workload: { kind: input.workloadKind, id: input.workloadId, siteAgentId: input.siteAgentId },
          workKind: input.workKind,
          runnerId: input.runnerId,
          runnerSessionId: input.runnerSessionId || `legacy_session_${input.runnerId}`,
          status: "active",
          fence: 1,
          slot: 0,
          routing: "default",
          leasedAt,
          renewedAt: leasedAt,
          expiresAt,
          createdAt: leasedAt,
          updatedAt: leasedAt,
        },
        token: crypto.randomUUID().replaceAll("-", ""),
        work: undefined,
      },
    };
  }
  return {
    authority,
    grant: await claimRunnerLease({
    runnerId: input.runnerId,
    runnerSessionId: input.runnerSessionId,
    sessionToken: input.sessionToken,
    legacy: !input.sessionToken,
    workload: { kind: input.workloadKind, id: input.workloadId, siteAgentId: input.siteAgentId },
    workKind: input.workKind,
    work: undefined,
    ttlMs: input.sessionToken ? 120_000 : 15 * 60_000,
    }),
  };
}

export async function leaseRunnerWork(
  runnerId: string,
  queue: RunnerWorkQueue = "any",
  control?: { sessionId?: string; sessionToken?: string },
): Promise<{ lease?: RunnerLease; persistence: "memory" | "d1" }> {
  const database = getD1Binding();
  if (!database) return { persistence: "memory" };
  await ensureSiteAgentV2Schema(database);
  const heartbeat = await heartbeatValidationRunner(runnerId, "online", undefined, {
    sessionId: control?.sessionId,
    sessionToken: control?.sessionToken,
    legacy: !control?.sessionToken,
  });
  const runnerSessionId = heartbeat.instance.sessionId;
  const now = new Date().toISOString();
  const crawlLeaseExpiresAt = new Date(Date.now() + CRAWL_LEASE_TTL_MS).toISOString();
  const crawlLeaseToken = uid("crawl_lease");
  const previewLeaseExpiresAt = new Date(Date.now() + SITE_PREVIEW_LEASE_TTL_MS).toISOString();
  const previewLeaseToken = uid("preview_lease");
  if (queue !== "background" && queue !== "author" && queue !== "validate") {
    const runtimeLease = await scanRunnerCandidates(
      (cursor, pageSize) => {
        const cursorSql = cursor
          ? " AND (created_at>? OR (created_at=? AND id>?))"
          : "";
        const values = cursor
          ? [now, cursor.createdAt, cursor.createdAt, cursor.id, pageSize]
          : [now, pageSize];
        return all<CapabilityRunRow & RunnerCandidateCursor>(database,
          `SELECT id,created_at AS createdAt,run_json AS runJson FROM site_agent_v2_capability_runs
          WHERE environment_kind='cloud-browser'
          AND (status='queued' OR (status='running' AND lease_expires_at<=?))${cursorSql}
          ORDER BY created_at,id LIMIT ?`,
          values);
      },
      async (row) => {
        const job = JSON.parse(row.runJson) as CapabilityRun;
        if (!job.releaseId
          || job.releaseVersion === undefined
          || (!job.capabilityVersionId && !job.revisionId)
          || !job.startUrl) {
          const code = "capability_run_resolution_missing";
          const failed: CapabilityRun = {
            ...job,
            status: "failed",
            lease: undefined,
            error: {
              code,
              summary: "Cloud execution requires pinned Release, Version or legacy Revision, and validated start URL.",
            },
            outcome: {
              status: "execution-fault",
              code,
              summary: "The queued Run has no complete immutable execution resolution.",
              evaluatedAt: now,
              evidence: { source: "capability-run-lease-gate" },
            },
            completedAt: now,
            updatedAt: now,
          };
          await database.prepare(`UPDATE site_agent_v2_capability_runs
            SET status='failed',lease_expires_at=?,run_json=?,updated_at=? WHERE id=?
            AND (status='queued' OR (status='running' AND lease_expires_at<=?))`)
            .bind(null, JSON.stringify(failed), now, job.id, now).run();
          return undefined;
        }
        let authorityClaim: RunnerAuthorityLeaseClaim;
        try {
          authorityClaim = await claimRunnerAuthorityLease({
            runnerId,
            runnerSessionId,
            sessionToken: control?.sessionToken,
            workloadKind: "capability-run",
            workloadId: job.id,
            siteAgentId: job.siteAgentId,
            workKind: "execute",
          });
        } catch (error) {
          if (placementMiss(error)) return undefined;
          throw error;
        }
        const { grant } = authorityClaim;
        const leased: CapabilityRun = {
          ...job,
          status: "running",
          runnerId,
          lease: projectRunnerAuthorityBusinessLease(authorityClaim),
          startedAt: job.startedAt || now,
          updatedAt: now,
          timings: { ...job.timings, queuedMs: Math.max(0, Date.parse(now) - Date.parse(job.createdAt)) },
        };
        const claim = await database.prepare(`UPDATE site_agent_v2_capability_runs
          SET status='running',lease_expires_at=?,run_json=?,updated_at=? WHERE id=?
          AND (status='queued' OR (status='running' AND lease_expires_at<=?))`)
          .bind(grant.lease.expiresAt, JSON.stringify(leased), now, job.id, now).run();
        if (claim.success && Number(claim.meta?.changes || 0) > 0) {
          const release = await d1ReleaseById(database, job.siteAgentId, job.releaseId);
          const capability = release ? runtimeCapability(release, job.capabilityId) : undefined;
          const revisionRows = job.projectId
            ? await all<CapabilityRevisionRow>(
                database,
                `SELECT revision_json AS revisionJson
                   FROM site_agent_v2_capability_revisions
                  WHERE id=? AND site_agent_id=? AND project_id=? LIMIT 1`,
                [job.revisionId, job.siteAgentId, job.projectId],
              )
            : [];
          const revision = revisionRows[0]
            ? JSON.parse(revisionRows[0].revisionJson) as CapabilityRevision
            : undefined;
          let resolutionFailure: Error | undefined;
          try {
            if (!release
              || release.id !== job.releaseId
              || release.version !== job.releaseVersion
              || !capability) {
              throw new Error("capability_run_knowledge_missing");
            }
            if (job.capabilityVersionId) {
              await assertPinnedCapabilityVersion({
                siteAgentId: job.siteAgentId,
                capabilityId: job.capabilityId,
                capabilityVersionId: job.capabilityVersionId,
                releaseId: job.releaseId,
                releaseVersion: job.releaseVersion,
              });
            } else {
              if (!revision || revision.id !== job.revisionId) {
                throw new Error("capability_run_knowledge_missing");
              }
              assertCapabilityRevisionRelease(release, capability, revision);
            }
          } catch (error) {
            resolutionFailure = error instanceof Error
              ? error
              : new Error("capability_run_resolution_invalid");
          }
          if (resolutionFailure
            || !release
            || !capability
            || (!job.capabilityVersionId && !revision)) {
            const code = resolutionFailure?.message.split(":")[0]
              || "capability_run_resolution_invalid";
            await releaseControlLease(authorityClaim, code);
            const failed: CapabilityRun = {
              ...leased,
              status: "failed",
              lease: undefined,
              error: {
                code,
                summary: "The pinned Capability execution resolution is no longer valid.",
              },
              outcome: {
                status: "execution-fault",
                code,
                summary: "The queued Run failed its immutable Release and Version/Revision lease gate.",
                evaluatedAt: now,
                evidence: { source: "capability-run-lease-gate" },
              },
              completedAt: now,
              updatedAt: now,
            };
            await database.prepare(`UPDATE site_agent_v2_capability_runs
              SET status='failed',lease_expires_at=?,run_json=?,updated_at=?
              WHERE id=? AND site_agent_id=? AND status='running' AND run_json=?`)
              .bind(
                null,
                JSON.stringify(failed),
                now,
                job.id,
                job.siteAgentId,
                JSON.stringify(leased),
              ).run();
            return undefined;
          }
          await heartbeatValidationRunner(runnerId, "busy");
          return {
            lease: {
              kind: "execute" as const,
              job: leased,
              capability,
              release,
              ...(revision ? { revision } : {}),
            },
            persistence: "d1" as const,
          };
        }
        await releaseControlLease(authorityClaim, "capability_run_claim_lost");
        return undefined;
      },
    );
    if (runtimeLease) return runtimeLease;
  }
  // A site preview is short, isolated background work. Prefer it over a full
  // crawl so a newly connected site gets visual confirmation promptly.
  const previewRows = queue !== "interactive"
    ? await all<SitePreviewJobRow>(database, `SELECT job_json AS jobJson FROM site_agent_v2_preview_jobs WHERE status='queued' OR (status IN ('leased','running') AND lease_expires_at<=?) ORDER BY created_at LIMIT 1`, [now])
    : [];
  if (previewRows[0]) {
    const job = JSON.parse(previewRows[0].jobJson) as SitePreviewJob;
    const attempts = job.attempts + 1;
    if (attempts > 3) {
      const failed: SitePreviewJob = { ...job, status: "failed", error: job.error || "site_preview_max_attempts", lease: undefined, attempts, updatedAt: now };
      await database.prepare(`UPDATE site_agent_v2_preview_jobs SET status='failed',lease_expires_at=NULL,attempts=?,job_json=?,updated_at=? WHERE id=?`).bind(attempts, JSON.stringify(failed), now, job.id).run();
    } else {
      const leased: SitePreviewJob = { ...job, status: "leased", attempts, lease: { runnerId, token: previewLeaseToken, leasedAt: now, expiresAt: previewLeaseExpiresAt }, updatedAt: now };
      const claim = await database.prepare(`UPDATE site_agent_v2_preview_jobs SET status='leased',lease_expires_at=?,attempts=?,job_json=?,updated_at=? WHERE id=? AND (status='queued' OR (status IN ('leased','running') AND lease_expires_at<=?))`).bind(previewLeaseExpiresAt, attempts, JSON.stringify(leased), now, job.id, now).run();
      if (claim.success && Number(claim.meta?.changes || 0) > 0) {
        await heartbeatValidationRunner(runnerId, "busy");
        return { lease: { kind: "site-preview", job: leased }, persistence: "d1" };
      }
    }
  }
  // Onboarding crawl jobs are background work: leased by any non-interactive
  // worker, with the same stale-lease recovery and terminal-after-3-attempts
  // contract as the durable review queue.
  //
  // This used to be an allow-list of any/background/crawl. When background was split
  // into author/validate/interactive, nobody claimed the crawl queue — none of the
  // resident workers were listed, so a crawl started from the console queued forever.
  // Excluding the interactive queue, as the comment intended, is enough: interactive
  // runners are reserved for the user's live actions; long crawls go to whoever is idle.
  const crawlRows = queue !== "interactive"
    ? await all<CrawlJobRow>(database, `SELECT job_json AS jobJson FROM site_agent_v2_crawl_jobs WHERE status='queued' OR (status IN ('leased','running') AND lease_expires_at<=?) ORDER BY created_at LIMIT 1`, [now])
    : [];
  if (crawlRows[0]) {
    const job = JSON.parse(crawlRows[0].jobJson) as CrawlJob;
    const attempts = job.attempts + 1;
    if (attempts > 3) {
      const failed: CrawlJob = { ...job, status: "failed", error: job.error || "crawl_max_attempts", lease: undefined, attempts, updatedAt: now };
      await database.prepare(`UPDATE site_agent_v2_crawl_jobs SET status='failed',lease_expires_at=?,attempts=?,job_json=?,updated_at=? WHERE id=?`).bind(null, attempts, JSON.stringify(failed), now, job.id).run();
    } else {
      const leased: CrawlJob = {
        ...job,
        status: "leased",
        attempts,
        lease: { runnerId, token: crawlLeaseToken, leasedAt: now, expiresAt: crawlLeaseExpiresAt },
        updatedAt: now,
      };
      const claim = await database.prepare(`UPDATE site_agent_v2_crawl_jobs SET status='leased',lease_expires_at=?,attempts=?,job_json=?,updated_at=? WHERE id=? AND (status='queued' OR (status IN ('leased','running') AND lease_expires_at<=?))`).bind(crawlLeaseExpiresAt, attempts, JSON.stringify(leased), now, job.id, now).run();
      if (claim.success && Number(claim.meta?.changes || 0) > 0) {
        await heartbeatValidationRunner(runnerId, "busy");
        // The cross-time baseline ships with the job. The runner has no other way to get
        // it: the release read API needs an admin login (the runner only holds a lease),
        // and runtime=1 applies the public trimming and must not expose per-row checksums.
        // Without history this layer silently degrades — one observation only, never a verdict.
        return {
          lease: { kind: "crawl", job: leased, priorObservations: await readPageObservations(job.siteAgentId) },
          persistence: "d1",
        };
      }
    }
  }
  // Interactive calls have a reserved worker and must never be delayed by
  // capability authoring or validation. Returning here is intentional: the
  // background worker owns the learning queue.
  if (queue === "interactive") {
    await heartbeatValidationRunner(runnerId, "online");
    return { persistence: "d1" };
  }
  // Preserve FIFO within the work this Runner is eligible to serve. A bound,
  // offline site's oldest job must not block unrelated sites in the shared set.
  const pipelineLease = await scanRunnerCandidates(
    (cursor, pageSize) => {
      const cursorSql = cursor
        ? " AND (created_at>? OR (created_at=? AND id>?))"
        : "";
      const values = cursor
        ? [cursor.createdAt, cursor.createdAt, cursor.id, pageSize]
        : [pageSize];
      return all<LearningJobRow & RunnerCandidateCursor>(database,
        `SELECT id,created_at AS createdAt,result_json AS jobJson
        FROM site_agent_v2_learning_jobs WHERE status IN ('queued','leased','running')${cursorSql}
        ORDER BY created_at,id LIMIT ?`,
        values);
    },
    async (pipelineRow) => {
    const pipelineJob = JSON.parse(pipelineRow.jobJson) as LearningJob;
    const pipelineLeaseExpired = !pipelineJob.lease?.expiresAt || pipelineJob.lease.expiresAt <= now;
    if (pipelineJob.phase === "author" && queue !== "validate" && (pipelineJob.status === "queued" || pipelineLeaseExpired)) {
      let authorityClaim: RunnerAuthorityLeaseClaim;
      try {
        authorityClaim = await claimRunnerAuthorityLease({
          runnerId,
          runnerSessionId,
          sessionToken: control?.sessionToken,
          workloadKind: "learning-job",
          workloadId: pipelineJob.id,
          siteAgentId: pipelineJob.siteAgentId,
          workKind: "author",
        });
      } catch (error) {
        if (placementMiss(error)) return undefined;
        throw error;
      }
      const leased = updateReceipt({
        ...pipelineJob,
        status: "leased",
        lease: projectRunnerAuthorityBusinessLease(authorityClaim),
      }, "author", { status: "running", startedAt: now });
      const claim = await database.prepare(`UPDATE site_agent_v2_learning_jobs SET status='leased',result_json=?,updated_at=?
        WHERE id=? AND (status='queued' OR (status IN ('leased','running')
        AND json_extract(result_json,'$.lease.expiresAt')<=?))`)
        .bind(JSON.stringify(leased), now, pipelineJob.id, now).run();
      if (!claim.success || Number(claim.meta?.changes || 0) < 1) {
        await releaseControlLease(authorityClaim, "learning_job_claim_lost");
        return undefined;
      }
      await closeInterruptedBrowserRuns(database, pipelineJob.id, now);
      const projectId = projectIdForLearningJob(pipelineJob);
      const [candidate, episode, release, specDoc] = await Promise.all([
        candidateById(database, pipelineJob.siteAgentId, pipelineJob.candidateId),
        episodeById(database, pipelineJob.siteAgentId, pipelineJob.sourceEpisodeId),
        d1Release(database, pipelineJob.siteAgentId),
        getLatestCapabilitySpecDoc(pipelineJob.siteAgentId, projectId, database),
      ]);
      if (!candidate || !episode || !release) {
        const code = "learning_job_knowledge_missing";
        const summary = "The legacy learning job no longer has the candidate, episode, or release required for authoring.";
        const failed = updateReceipt({
          ...leased,
          status: "failed",
          lease: undefined,
          failure: { code, summary },
        }, "author", {
          status: "failed",
          title: "Authoring prerequisites are unavailable",
          summary,
          endedAt: now,
          evidence: {
            candidateAvailable: Boolean(candidate),
            episodeAvailable: Boolean(episode),
            releaseAvailable: Boolean(release),
          },
        });
        const terminal = await database.prepare(`UPDATE site_agent_v2_learning_jobs
          SET status='failed',result_json=?,updated_at=?
          WHERE id=? AND site_agent_id=? AND status='leased' AND result_json=?`)
          .bind(JSON.stringify(failed), failed.updatedAt, leased.id, leased.siteAgentId, JSON.stringify(leased)).run();
        await releaseControlLease(authorityClaim, "learning_job_knowledge_missing");
        if (!terminal.success) throw new Error(terminal.error || "learning_job_terminalization_failed");
        return undefined;
      }
      await heartbeatValidationRunner(runnerId, "busy");
      return {
        lease: {
          kind: "author" as const,
          job: leased,
          candidate,
          episode,
          release,
          specDoc,
          reviewFeedback: leased.reviewFeedback,
        },
        persistence: "d1" as const,
      };
    }
    if (pipelineJob.phase !== "validate" || queue === "author") return undefined;
    return scanRunnerCandidates(
      (cursor, pageSize) => {
        const cursorSql = cursor
          ? " AND (created_at>? OR (created_at=? AND id>?))"
          : "";
        const values = cursor
          ? [pipelineJob.id, now, cursor.createdAt, cursor.createdAt, cursor.id, pageSize]
          : [pipelineJob.id, now, pageSize];
        return all<ValidationJobRow & RunnerCandidateCursor>(database,
          `SELECT id,created_at AS createdAt,job_json AS jobJson
          FROM site_agent_v2_validation_jobs WHERE learning_job_id=?
          AND (status='queued' OR (status IN ('leased','running') AND lease_expires_at<=?))${cursorSql}
          ORDER BY created_at,id LIMIT ?`,
          values);
      },
      async (validationRow) => {
        const job = JSON.parse(validationRow.jobJson) as ValidationJob;
        let authorityClaim: RunnerAuthorityLeaseClaim;
        try {
          authorityClaim = await claimRunnerAuthorityLease({
            runnerId,
            runnerSessionId,
            sessionToken: control?.sessionToken,
            workloadKind: "validation-job",
            workloadId: job.id,
            siteAgentId: job.siteAgentId,
            workKind: "validate",
          });
        } catch (error) {
          if (placementMiss(error)) return undefined;
          throw error;
        }
        const { grant } = authorityClaim;
        const leased: ValidationJob = {
          ...job,
          status: "leased",
          lease: projectRunnerAuthorityBusinessLease(authorityClaim),
          updatedAt: now,
        };
        const claim = await database.prepare(`UPDATE site_agent_v2_validation_jobs
          SET status='leased',lease_expires_at=?,job_json=?,updated_at=? WHERE id=?
          AND (status='queued' OR (status IN ('leased','running') AND lease_expires_at<=?))`)
          .bind(grant.lease.expiresAt, JSON.stringify(leased), now, job.id, now).run();
        if (!claim.success || Number(claim.meta?.changes || 0) < 1) {
          await releaseControlLease(authorityClaim, "validation_job_claim_lost");
          return undefined;
        }
        const learningRows = await all<LearningJobRow>(database, `SELECT result_json AS jobJson
          FROM site_agent_v2_learning_jobs WHERE id=? LIMIT 1`, [job.learningJobId]);
        const learningJob = learningRows[0]
          ? JSON.parse(learningRows[0].jobJson) as LearningJob
          : undefined;
        const revisionRows = learningJob
          ? await all<CapabilityRevisionRow>(
              database,
              `SELECT revision_json AS revisionJson
                 FROM site_agent_v2_capability_revisions
                WHERE id=? AND site_agent_id=?
                  AND json_extract(revision_json,'$.learningJobId')=?
                LIMIT 1`,
              [
                typeof learningJob.result?.revisionId === "string"
                  ? learningJob.result.revisionId
                  : "",
                job.siteAgentId,
                learningJob.id,
              ],
            )
          : [];
        const revision = revisionRows[0]
          ? JSON.parse(revisionRows[0].revisionJson) as CapabilityRevision
          : undefined;
        const candidate = await candidateById(database, job.siteAgentId, job.candidateId);
        const activeRelease = await d1Release(database, job.siteAgentId);
        if (!learningJob || !candidate || !activeRelease || !revision) {
          await releaseControlLease(authorityClaim, "validation_job_knowledge_missing");
          throw new Error("validation_job_knowledge_missing");
        }
        if (revision.status !== "building"
          || revision.stage !== "validate"
          || revision.candidateId !== candidate.id
          || revision.learningJobId !== learningJob.id) {
          await releaseControlLease(authorityClaim, "validation_revision_mismatch");
          throw new Error("validation_revision_mismatch");
        }
        let release: SiteAgentReleaseV2;
        try {
          release = await implementationReleaseForRevision(
            database,
            job.siteAgentId,
            activeRelease,
            revision,
          );
          assertCapabilityRevisionRelease(
            release,
            candidate.capability,
            revision,
            { requirePublished: false },
          );
        } catch (error) {
          await releaseControlLease(authorityClaim, "validation_revision_implementation_mismatch");
          throw error;
        }
        await heartbeatValidationRunner(runnerId, "busy");
        return {
          lease: {
            kind: "validate" as const,
            job: leased,
            learningJob,
            candidate,
            release,
            revision,
          },
          persistence: "d1" as const,
        };
      },
    );
    },
  );
  if (pipelineLease) return pipelineLease;
  await heartbeatValidationRunner(runnerId, "online");
  return { persistence: "d1" };
}

export async function startBrowserRun(runnerId: string, leaseToken: string, run: BrowserRun) {
  const database = getD1Binding();
  if (!database) throw new Error("browser_runner_requires_d1");
  await ensureSiteAgentV2Schema(database);
  const learningRows = await all<LearningJobRow>(database, `SELECT result_json AS jobJson FROM site_agent_v2_learning_jobs WHERE id=? LIMIT 1`, [run.learningJobId]);
  if (!learningRows[0]) throw new Error("learning_job_not_found");
  const learningJob = JSON.parse(learningRows[0].jobJson) as LearningJob;
  const validLearningLease = businessLeaseAuthorized(learningJob.lease, runnerId, leaseToken);
  const renewedAt = new Date().toISOString();
  const mirroredLeaseExpiry = async (lease: LearningJob["lease"] | ValidationJob["lease"]) =>
    lease?.leaseId
      ? synchronizedBusinessLeaseExpiry(lease)
      : new Date(Date.now() + 15 * 60_000).toISOString();
  let validValidationLease = false;
  if (run.validationJobId) {
    const rows = await all<ValidationJobRow>(database, `SELECT job_json AS jobJson FROM site_agent_v2_validation_jobs WHERE id=? LIMIT 1`, [run.validationJobId]);
    const validation = rows[0] ? JSON.parse(rows[0].jobJson) as ValidationJob : undefined;
    validValidationLease = businessLeaseAuthorized(validation?.lease, runnerId, leaseToken);
    if (validation && validValidationLease) {
      const renewedExpiresAt = await mirroredLeaseExpiry(validation.lease);
      const updated = { ...validation, status: "running" as const, latestRunId: run.id, lease: { ...validation.lease!, expiresAt: renewedExpiresAt }, updatedAt: renewedAt };
      await database.prepare(`UPDATE site_agent_v2_validation_jobs SET status='running',lease_expires_at=?,job_json=?,updated_at=? WHERE id=?`).bind(renewedExpiresAt, JSON.stringify(updated), renewedAt, updated.id).run();
    }
  }
  if (!validLearningLease && !validValidationLease) throw new Error("invalid_runner_lease");
  if (validLearningLease) {
    const renewedExpiresAt = await mirroredLeaseExpiry(learningJob.lease);
    const renewed = { ...learningJob, lease: { ...learningJob.lease!, expiresAt: renewedExpiresAt }, updatedAt: renewedAt };
    await database.prepare(`UPDATE site_agent_v2_learning_jobs SET result_json=?,updated_at=? WHERE id=? AND site_agent_id=?`).bind(JSON.stringify(renewed), renewedAt, renewed.id, renewed.siteAgentId).run();
  }
  const result = await database.prepare(`INSERT OR REPLACE INTO site_agent_v2_browser_runs (id,learning_job_id,validation_job_id,site_agent_id,candidate_id,status,run_json,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(run.id, run.learningJobId, run.validationJobId || null, run.siteAgentId, run.candidateId, run.status, JSON.stringify(run), run.startedAt, null).run();
  if (!result.success) throw new Error(result.error || "browser_run_start_failed");
  return { run, persistence: "d1" as const };
}

async function completedBrowserRunRetryMatches(
  database: D1DatabaseLike,
  runnerId: string,
  run: Pick<BrowserRun, "id" | "learningJobId" | "validationJobId">,
) {
  const rows = await all<BrowserRunRow>(database,
    `SELECT run_json AS runJson FROM site_agent_v2_browser_runs WHERE id=? LIMIT 1`,
    [run.id]);
  if (!rows[0]) return false;
  const stored = JSON.parse(rows[0].runJson) as BrowserRun;
  return stored.runnerId === runnerId
    && stored.learningJobId === run.learningJobId
    && stored.validationJobId === run.validationJobId
    && stored.status !== "running";
}

export async function completeAuthoring(
  runnerId: string,
  leaseToken: string,
  run: BrowserRun,
  authored: KnowledgeCandidate,
  options: { allowCompletedRetry?: boolean } = {},
) {
  const database = getD1Binding();
  if (!database) throw new Error("browser_runner_requires_d1");
  const rows = await all<LearningJobRow>(database, `SELECT result_json AS jobJson FROM site_agent_v2_learning_jobs WHERE id=? LIMIT 1`, [run.learningJobId]);
  if (!rows[0]) throw new Error("learning_job_not_found");
  const job = JSON.parse(rows[0].jobJson) as LearningJob;
  const activeAuthoringRevision = ["leased", "running"].includes(job.status) && job.phase === "author";
  if (!activeAuthoringRevision || !businessLeaseAuthorized(job.lease, runnerId, leaseToken)) {
    if (options.allowCompletedRetry
      && !job.lease
      && job.latestRunId === run.id
      && await completedBrowserRunRetryMatches(database, runnerId, run)) {
      const validationRows = await all<ValidationJobRow>(database,
        `SELECT job_json AS jobJson FROM site_agent_v2_validation_jobs
        WHERE learning_job_id=? ORDER BY created_at DESC LIMIT 1`,
        [job.id]);
      return {
        job,
        validationJob: validationRows[0]
          ? JSON.parse(validationRows[0].jobJson) as ValidationJob
          : undefined,
        duplicate: true,
        persistence: "d1" as const,
      };
    }
    if (!activeAuthoringRevision) throw new Error("authoring_revision_superseded");
    throw new Error("invalid_runner_lease");
  }
  const designed = await candidateById(database, job.siteAgentId, job.candidateId);
  const episode = await episodeById(database, job.siteAgentId, job.sourceEpisodeId);
  if (!designed || !episode) throw new Error("learning_job_knowledge_missing");
  const suppression = matchingCapabilitySuppression(
    await activeCapabilitySuppressions(database, job.siteAgentId),
    designed.authoring?.goalTemplate || designed.capability.goalTemplate || designed.capability.name,
    designed.authoring?.intentKey || job.intentKey,
  );
  if (suppression) throw new Error("authoring_generation_suppressed");
  const now = run.endedAt || new Date().toISOString();
  const hasAuthoringProof = authored.operations.length > 0 && authored.capability.plans.length > 0 && authored.operations.every((operation) => operation.implementations.some((implementation) => {
    if (!implementation.authored?.proof?.verifier.success.length) return false;
    if (implementation.authored.kind === "module") return Boolean(implementation.authored.module.contentHash && implementation.authored.module.moduleUrl);
    return implementation.authored.program.steps.length > 0;
  }));
  const authoringPassed = run.status === "passed" && hasAuthoringProof;
  const authorFailureCode = run.outcome?.code || (hasAuthoringProof ? "authoring_failed" : "authoring_proof_missing");
  // Authoring is evidence-driven, so an identical retry cannot improve it.
  // Preserve the first failure and require a changed spec/plan/code path before
  // a new job is explicitly queued.
  const retryableAuthorFailure = false;
  const authoredCandidate: KnowledgeCandidate = authoringPassed ? {
    ...authored, id: designed.id, siteAgentId: designed.siteAgentId, baseReleaseVersion: designed.baseReleaseVersion,
    normalizedGoal: designed.normalizedGoal,
    capability: {
      ...authored.capability,
      id: designed.capability.id,
      kind: designed.capability.kind,
      resultKind: designed.capability.resultKind,
      exposure: designed.capability.exposure || "public",
      name: designed.capability.name,
      description: designed.capability.description,
      normalizedGoal: designed.normalizedGoal || normalizeGoal(designed.capability.name),
      aliases: designed.capability.aliases,
      inputs: designed.capability.inputs,
      outputs: designed.capability.outputs,
    },
    authoring: { ...authored.authoring!, stage: "authored", reusableTrace: false },
    sourceEpisodeIds: [...new Set([...designed.sourceEpisodeIds, ...authored.sourceEpisodeIds])], updatedAt: now,
  } : { ...designed, authoring: { ...designed.authoring!, iterations: authored.authoring?.iterations || designed.authoring?.iterations }, validation: { ...designed.validation, status: retryableAuthorFailure ? "pending" : "failed" }, updatedAt: now };
  const release = await immutableActiveReleaseForRevision(
    database,
    job.siteAgentId,
  );
  const workingRevisionRows = await all<CapabilityRevisionRow>(
    database,
    `SELECT revision_json AS revisionJson
       FROM site_agent_v2_capability_revisions
      WHERE site_agent_id=? AND project_id=?
        AND (
          id=?
          OR json_extract(revision_json,'$.learningJobId')=?
        )
      ORDER BY revision_number DESC
      LIMIT 1`,
    [
      job.siteAgentId,
      projectIdForLearningJob(job),
      typeof job.result?.revisionId === "string" ? job.result.revisionId : "",
      job.id,
    ],
  );
  const workingRevision = workingRevisionRows[0]
    ? JSON.parse(workingRevisionRows[0].revisionJson) as CapabilityRevision
    : undefined;
  const completedRevision: CapabilityRevision | undefined = workingRevision
    ? {
      ...workingRevision,
      status: authoringPassed ? "building" : "failed",
      stage: authoringPassed ? "validate" : "author",
      candidateId: authoredCandidate.id,
      learningJobId: job.id,
      parameterizationDecisions: authoredCandidate.authoring?.parameterizationDecisions
        || workingRevision.parameterizationDecisions,
      implementation: authoringPassed
        ? revisionImplementationForCapability(release, authoredCandidate.capability)
          || workingRevision.implementation
        : workingRevision.implementation,
      implementationReleaseId: authoringPassed
        ? release.id
        : workingRevision.implementationReleaseId,
      implementationReleaseVersion: authoringPassed
        ? release.version
        : workingRevision.implementationReleaseVersion,
      validation: authoringPassed
        ? { status: "pending" }
        : {
          status: "failed",
          failureClass: classifyCapabilityFailure(
            authorFailureCode,
            run.outcome?.summary || "",
          ),
          summary: run.outcome?.summary || "AI 程序编写失败",
        },
      updatedAt: now,
    }
    : undefined;
  const validation = authoringPassed ? await makeValidationJob(job, authoredCandidate, episode, release) : undefined;
  let next = updateReceipt({ ...job, attempts: job.attempts + 1, phase: authoringPassed ? "validate" : "author", status: authoringPassed || retryableAuthorFailure ? "queued" : "failed", lease: undefined, latestRunId: run.id }, "author", {
    status: authoringPassed ? "passed" : retryableAuthorFailure ? "queued" : "failed", endedAt: retryableAuthorFailure ? undefined : now,
    title: authoringPassed ? "AI 已编写并试运行能力程序" : retryableAuthorFailure ? "编写协议中断，正在自动重试" : "AI 程序编写证据不足",
    summary: authoringPassed ? run.outcome?.summary || "程序编写已结束。" : retryableAuthorFailure ? `本轮页面证据未通过（${authorFailureCode}），AI 将使用新浏览器重新观察目标与完成条件。` : run.outcome?.summary || "AI 输出缺少可执行程序或完成条件，发布门禁已拒绝。", artifactIds: run.artifactIds,
    evidence: authoringPassed ? { selectedImplementationId: authoredCandidate.authoring?.selectedImplementationId || "", alternatives: authoredCandidate.authoring?.alternatives || [], targetCount: authoredCandidate.targets.length } : { code: authorFailureCode },
  });
  if (authoringPassed) {
    next = updateReceipt(next, "validate", {
      status: "queued",
      title: "等待独立重放",
      summary: validation?.validationCase.inputSource === "derived-from-evidence" ? "AI 已从真实页面证据选择不同输入，将在全新浏览器上下文验证程序泛化能力。" : "页面证据没有可靠替代值，将在全新浏览器上下文重放原输入。",
      startedAt: now,
      evidence: validation ? { inputSource: validation.validationCase.inputSource, input: validation.validationCase.input } : undefined,
    });
  }
  else next = retryableAuthorFailure
    ? { ...next, phase: "author", status: "queued", failure: undefined }
    : { ...next, phase: "author", status: "failed", failure: { code: authorFailureCode, summary: run.outcome?.summary || "AI 程序编写失败" } };
  const completionGuardKey = `authoring_guard:${job.id}:${run.id}`;
  const statements = [
    database.prepare(`INSERT OR REPLACE INTO site_agent_v2_meta (key,value,updated_at)
      VALUES (?,CASE WHEN (
        SELECT COUNT(*) FROM site_agent_v2_learning_jobs
        WHERE id=? AND site_agent_id=? AND status IN ('leased','running') AND result_json=?
      )=1 THEN ? ELSE NULL END,?)`)
      .bind(completionGuardKey, job.id, job.siteAgentId, rows[0].jobJson, run.id, now),
    database.prepare(`INSERT OR REPLACE INTO site_agent_v2_browser_runs (id,learning_job_id,validation_job_id,site_agent_id,candidate_id,status,run_json,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(run.id, run.learningJobId, null, run.siteAgentId, authoredCandidate.id, authoringPassed ? "passed" : "failed", JSON.stringify({ ...run, status: authoringPassed ? "passed" : "failed" }), run.startedAt, now),
    database.prepare(`INSERT OR REPLACE INTO site_agent_v2_candidates (id,site_agent_id,normalized_goal,status,base_release_version,candidate_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(authoredCandidate.id, authoredCandidate.siteAgentId, authoredCandidate.normalizedGoal, authoringPassed || retryableAuthorFailure ? "pending" : "failed", authoredCandidate.baseReleaseVersion, JSON.stringify(authoredCandidate), authoredCandidate.createdAt, now),
    database.prepare(`UPDATE site_agent_v2_learning_jobs SET status=?,result_json=?,updated_at=? WHERE id=?`).bind(next.status, JSON.stringify(next), now, next.id),
  ];
  if (completedRevision && workingRevisionRows[0]) {
    statements.push(database.prepare(`UPDATE site_agent_v2_capability_revisions
      SET status=?,revision_json=?,updated_at=?
      WHERE id=? AND project_id=? AND site_agent_id=?
        AND status<>'published' AND revision_json=?`)
      .bind(
        completedRevision.status,
        JSON.stringify(completedRevision),
        now,
        completedRevision.id,
        completedRevision.projectId,
        completedRevision.siteAgentId,
        workingRevisionRows[0].revisionJson,
      ));
    statements.push(database.prepare(`INSERT OR REPLACE INTO site_agent_v2_meta
      (key,value,updated_at) VALUES (?,CASE WHEN
        EXISTS (
          SELECT 1 FROM site_agent_v2_capability_revisions
           WHERE id=? AND project_id=? AND site_agent_id=?
             AND status=? AND revision_json=?
        )
      THEN ? ELSE NULL END,?)`)
      .bind(
        completionGuardKey,
        completedRevision.id,
        completedRevision.projectId,
        completedRevision.siteAgentId,
        completedRevision.status,
        JSON.stringify(completedRevision),
        run.id,
        now,
      ));
  }
  if (validation) statements.push(database.prepare(`INSERT OR REPLACE INTO site_agent_v2_validation_jobs (id,learning_job_id,site_agent_id,candidate_id,status,lease_expires_at,job_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(validation.id, job.id, job.siteAgentId, authoredCandidate.id, "queued", null, JSON.stringify(validation), now, now));
  statements.push(database.prepare(`DELETE FROM site_agent_v2_meta WHERE key=?`).bind(completionGuardKey));
  const results = await database.batch(statements); const failure = results.find((result) => !result.success); if (failure) throw new Error(failure.error || "authoring_complete_failed");
  if (job.result?.source !== "capability-control") {
    await reconcileCapabilityControl(job.siteAgentId);
  }
  await heartbeatValidationRunner(runnerId, "online");
  return { job: next, validationJob: validation, persistence: "d1" as const };
}

export async function completeValidation(
  runnerId: string,
  leaseToken: string,
  run: BrowserRun,
  options: { allowCompletedRetry?: boolean } = {},
) {
  const database = getD1Binding();
  if (!database || !run.validationJobId) throw new Error("validation_job_not_found");
  const rows = await all<ValidationJobRow>(database, `SELECT job_json AS jobJson FROM site_agent_v2_validation_jobs WHERE id=? LIMIT 1`, [run.validationJobId]);
  if (!rows[0]) throw new Error("validation_job_not_found");
  const job = JSON.parse(rows[0].jobJson) as ValidationJob;
  if (!businessLeaseAuthorized(job.lease, runnerId, leaseToken)) {
    if (options.allowCompletedRetry
      && !job.lease
      && job.latestRunId === run.id
      && await completedBrowserRunRetryMatches(database, runnerId, run)) {
      const learningRows = await all<LearningJobRow>(database,
        `SELECT result_json AS jobJson FROM site_agent_v2_learning_jobs WHERE id=? LIMIT 1`,
        [job.learningJobId]);
      return {
        job,
        learningJob: learningRows[0]
          ? JSON.parse(learningRows[0].jobJson) as LearningJob
          : undefined,
        decision: job.status === "passed" ? "awaiting-review" : job.status === "queued" ? "retry" : "reject",
        duplicate: true,
        persistence: "d1" as const,
      };
    }
    throw new Error("invalid_runner_lease");
  }
  const [candidateRows, activeRelease, learningRows, revisionRows] = await Promise.all([
    all<CandidateRow>(database, `SELECT candidate_json AS candidateJson
      FROM site_agent_v2_candidates WHERE id=? AND site_agent_id=? LIMIT 1`,
    [job.candidateId, job.siteAgentId]),
    d1Release(database, job.siteAgentId),
    all<LearningJobRow>(database, `SELECT result_json AS jobJson FROM site_agent_v2_learning_jobs WHERE id=? LIMIT 1`, [job.learningJobId]),
    all<CapabilityRevisionRow>(database, `SELECT revision_json AS revisionJson
      FROM site_agent_v2_capability_revisions
      WHERE site_agent_id=? AND json_extract(revision_json,'$.learningJobId')=?
      ORDER BY revision_number DESC LIMIT 1`, [job.siteAgentId, job.learningJobId]),
  ]);
  const candidate = candidateRows[0]
    ? JSON.parse(candidateRows[0].candidateJson) as KnowledgeCandidate
    : undefined;
  if (!candidate || !activeRelease || !learningRows[0]) throw new Error("validation_job_knowledge_missing");
  const learning = JSON.parse(learningRows[0].jobJson) as LearningJob;
  const workingRevision = revisionRows[0]
    ? JSON.parse(revisionRows[0].revisionJson) as CapabilityRevision
    : undefined;
  const implementationRelease = workingRevision
    ? await implementationReleaseForRevision(
        database,
        job.siteAgentId,
        activeRelease,
        workingRevision,
      )
    : activeRelease;
  // A newer Revision may supersede this validation while its browser is still
  // running. Never let a late receipt publish an obsolete contract.
  if (learning.status === "cancelled" || learning.failure?.code === "superseded_by_revision") throw new Error("validation_revision_superseded");
  const now = run.endedAt || new Date().toISOString();
  const suppression = matchingCapabilitySuppression(
    await activeCapabilitySuppressions(database, job.siteAgentId),
    candidate.authoring?.goalTemplate || candidate.capability.goalTemplate || candidate.capability.name,
    candidate.authoring?.intentKey || learning.intentKey,
  );
  if (suppression) {
    const reason = `管理员已下架“${suppression.name}”，本次迟到的验证结果不得重新发布该能力。`;
    const finalJob: ValidationJob = {
      ...job,
      status: "cancelled",
      attempt: job.attempt + 1,
      latestRunId: run.id,
      lease: undefined,
      failure: { code: "capability_generation_suppressed", summary: reason },
      updatedAt: now,
    };
    const nextLearning = updateReceipt({
      ...learning,
      status: "cancelled",
      lease: undefined,
      latestRunId: run.id,
      failure: { code: "capability_generation_suppressed", summary: reason },
    }, "publish", {
      actor: "release-gate",
      status: "skipped",
      title: "发布已被管理员策略阻止",
      summary: reason,
      startedAt: now,
      endedAt: now,
      evidence: { suppressionId: suppression.id },
    });
    const blockedCandidate = {
      ...candidate,
      validation: { ...candidate.validation, status: "failed" as const },
      authoring: {
        ...candidate.authoring!,
        reuseDecision: "suppressed" as const,
        reuseReason: reason,
        evolutionAssessment: {
          decision: "suppressed" as const,
          summary: reason,
          factors: [{ label: "管理员策略", evidence: suppression.reason }],
          analyzedAt: now,
          sourceEpisodeId: learning.sourceEpisodeId,
        },
      },
      updatedAt: now,
    };
    const results = await database.batch([
      database.prepare(`INSERT OR REPLACE INTO site_agent_v2_browser_runs (id,learning_job_id,validation_job_id,site_agent_id,candidate_id,status,run_json,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(run.id, run.learningJobId, run.validationJobId, run.siteAgentId, run.candidateId, run.status, JSON.stringify(run), run.startedAt, now),
      database.prepare(`UPDATE site_agent_v2_candidates SET status='failed',candidate_json=?,updated_at=? WHERE id=?`).bind(JSON.stringify(blockedCandidate), now, candidate.id),
      database.prepare(`UPDATE site_agent_v2_validation_jobs SET status='cancelled',lease_expires_at=NULL,job_json=?,updated_at=? WHERE id=?`).bind(JSON.stringify(finalJob), now, finalJob.id),
      database.prepare(`UPDATE site_agent_v2_learning_jobs SET status='cancelled',result_json=?,updated_at=? WHERE id=?`).bind(JSON.stringify(nextLearning), now, nextLearning.id),
    ]);
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "suppressed_validation_complete_failed");
    await reconcileCapabilityControl(job.siteAgentId);
    await heartbeatValidationRunner(runnerId, "online");
    return { job: finalJob, learningJob: nextLearning, decision: "reject" as const, release: activeRelease, persistence: "d1" as const };
  }
  const decision = evaluateBrowserRun(
    implementationRelease,
    candidate,
    job,
    run,
  );
  const repairableProgramFault = decision.decision !== "publish" && ["target_not_found", "input_value_mismatch", "scene_assertion_failed", "operation_implementation_missing", "extractor_field_alias", "verifier_mismatch", "program_verifier_failed"].includes(run.outcome?.code || "") && learning.attempts < 3;
  const finalStatus = decision.decision === "publish" ? "passed" : repairableProgramFault ? "cancelled" : decision.decision === "retry" ? "queued" : "failed";
  let finalJob: ValidationJob = { ...job, status: finalStatus, attempt: job.attempt + 1, latestRunId: run.id, lease: undefined, failure: decision.decision === "publish" ? undefined : { code: decision.reason, summary: run.outcome?.summary || decision.reason }, updatedAt: now };
  let nextLearning = updateReceipt({ ...learning, latestRunId: run.id, lease: undefined }, "validate", {
    status: decision.decision === "publish" ? "passed" : decision.decision === "retry" ? "queued" : "failed", endedAt: decision.decision === "retry" ? undefined : now,
    title: decision.decision === "publish" ? "独立验证通过" : decision.decision === "retry" ? "验证将自动重试" : "独立验证未通过",
    summary: run.outcome?.summary || decision.reason, artifactIds: run.artifactIds,
  });
  const statements = [database.prepare(`INSERT OR REPLACE INTO site_agent_v2_browser_runs (id,learning_job_id,validation_job_id,site_agent_id,candidate_id,status,run_json,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(run.id, run.learningJobId, run.validationJobId, run.siteAgentId, run.candidateId, run.status, JSON.stringify(run), run.startedAt, now)];
  const completionDecision: "awaiting-review" | "retry" | "reject" = decision.decision === "publish"
    ? "awaiting-review"
    : decision.decision;
  let validationGuardKey: string | undefined;
  if (decision.decision === "publish") {
    if (!workingRevision
      || workingRevision.status !== "building"
      || workingRevision.stage !== "validate"
      || workingRevision.learningJobId !== learning.id
      || workingRevision.candidateId !== candidate.id) {
      throw new Error("validation_revision_missing");
    }
    assertCapabilityRevisionRelease(
      implementationRelease,
      candidate.capability,
      workingRevision,
      { requirePublished: false },
    );
    const projectRows = await all<CapabilityProjectRow>(
      database,
      `SELECT project_json AS projectJson FROM site_agent_v2_capability_projects
        WHERE id=? AND site_agent_id=? LIMIT 1`,
      [workingRevision.projectId, job.siteAgentId],
    );
    if (!projectRows[0]) throw new Error("capability_project_not_found");
    const project = projectWithIdentityDefaults(
      JSON.parse(projectRows[0].projectJson) as CapabilityProject,
    );
    if (project.latestRevisionId !== workingRevision.id) {
      throw new Error("validation_revision_superseded");
    }
    const validatedCandidate: KnowledgeCandidate = {
      ...decision.candidate,
      baseReleaseVersion: activeRelease.version,
    };
    finalJob = {
      ...finalJob,
      baseReleaseVersion: activeRelease.version,
    };
    const validatedContentHash = validatedCandidateContentHash(
      validatedCandidate,
      workingRevision,
    );
    const review: RevisionReview = {
      id: revisionReviewId(
        workingRevision.id,
        run.id,
        validatedContentHash,
        "awaiting-review",
      ),
      siteAgentId: job.siteAgentId,
      projectId: project.id,
      revisionId: workingRevision.id,
      validationRunId: run.id,
      validatedContentHash,
      status: "awaiting-review",
      reviewer: "release-gate",
      createdAt: now,
    };
    const awaitingRevision: CapabilityRevision = {
      ...workingRevision,
      status: "awaiting-review",
      stage: "publish",
      baseReleaseVersion: activeRelease.version,
      candidateId: validatedCandidate.id,
      validation: {
        status: "passed",
        input: job.validationCase.input,
        runId: run.id,
        startUrl: run.startUrl,
        validatedContentHash,
        summary: run.outcome?.summary || decision.reason,
      },
      updatedAt: now,
    };
    const awaitingProject = capabilityProjectForWrite({
      ...project,
      status: project.activeRevisionId ? project.status : "awaiting-review",
      stage: project.activeRevisionId ? project.stage : "publish",
      latestRevisionId: awaitingRevision.id,
      health: {
        ...project.health,
        lastValidatedAt: now,
        failureClass: undefined,
        recommendedAction: undefined,
      },
      updatedAt: now,
    });
    nextLearning = {
      ...updateReceipt({
        ...nextLearning,
        phase: "publish",
        status: "awaiting-review",
        failure: undefined,
        reviewFeedback: undefined,
      }, "publish", {
        status: "queued",
        actor: "release-gate",
        title: "等待人工审核",
        summary: "独立验证已通过；管理员批准这一精确 Revision 与验证 Run 后才会发布。",
        startedAt: now,
        evidence: {
          revisionId: awaitingRevision.id,
          validationRunId: run.id,
          validatedContentHash,
        },
      }),
      updatedAt: now,
    };
    validationGuardKey = `validation_review_guard:${review.id}`;
    statements.push(
      database.prepare(`UPDATE site_agent_v2_candidates
        SET status='awaiting-review',base_release_version=?,candidate_json=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND candidate_json=?`)
        .bind(
          activeRelease.version,
          JSON.stringify(validatedCandidate),
          now,
          candidate.id,
          candidate.siteAgentId,
          candidateRows[0].candidateJson,
        ),
      database.prepare(`INSERT INTO site_agent_v2_revision_reviews
        (id,site_agent_id,project_id,revision_id,validation_run_id,validated_content_hash,status,review_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(
          review.id,
          review.siteAgentId,
          review.projectId,
          review.revisionId,
          review.validationRunId,
          review.validatedContentHash,
          review.status,
          JSON.stringify(review),
          review.createdAt,
        ),
      database.prepare(`UPDATE site_agent_v2_capability_revisions
        SET status=?,revision_json=?,updated_at=?
        WHERE id=? AND project_id=? AND site_agent_id=? AND revision_json=? AND status<>'published'`)
        .bind(
          awaitingRevision.status,
          JSON.stringify(awaitingRevision),
          now,
          awaitingRevision.id,
          awaitingRevision.projectId,
          awaitingRevision.siteAgentId,
          revisionRows[0].revisionJson,
        ),
      database.prepare(`UPDATE site_agent_v2_capability_projects
        SET intent_key=?,stable_key=?,contract_fingerprint=?,active_revision_id=?,latest_revision_id=?,
            status=?,project_json=?,created_at=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND latest_revision_id=? AND project_json=?`)
        .bind(
          awaitingProject.intentKey,
          awaitingProject.stableKey || null,
          awaitingProject.contractFingerprint || null,
          awaitingProject.activeRevisionId || null,
          awaitingProject.latestRevisionId || null,
          awaitingProject.status,
          JSON.stringify(awaitingProject),
          awaitingProject.createdAt,
          awaitingProject.updatedAt,
          awaitingProject.id,
          awaitingProject.siteAgentId,
          awaitingRevision.id,
          projectRows[0].projectJson,
        ),
      database.prepare(`UPDATE site_agent_v2_validation_jobs
        SET status='passed',lease_expires_at=NULL,job_json=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND job_json=?`)
        .bind(JSON.stringify(finalJob), now, finalJob.id, finalJob.siteAgentId, rows[0].jobJson),
      database.prepare(`UPDATE site_agent_v2_learning_jobs
        SET status='awaiting-review',result_json=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND result_json=?`)
        .bind(
          JSON.stringify(nextLearning),
          now,
          nextLearning.id,
          nextLearning.siteAgentId,
          learningRows[0].jobJson,
        ),
      database.prepare(`INSERT OR REPLACE INTO site_agent_v2_meta (key,value,updated_at)
        VALUES (?,CASE WHEN
          (SELECT active_release_id FROM site_agent_v2_agents WHERE id=?)=?
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_revision_reviews
            WHERE id=? AND status='awaiting-review'
              AND revision_id=? AND validation_run_id=? AND validated_content_hash=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_capability_revisions
            WHERE id=? AND project_id=? AND status='awaiting-review'
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_capability_projects
            WHERE id=? AND latest_revision_id=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_candidates
            WHERE id=? AND status='awaiting-review' AND candidate_json=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_validation_jobs
            WHERE id=? AND status='passed' AND job_json=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_learning_jobs
            WHERE id=? AND status='awaiting-review' AND result_json=?
          )
        THEN ? ELSE NULL END,?)`)
        .bind(
          validationGuardKey,
          job.siteAgentId,
          activeRelease.id,
          review.id,
          review.revisionId,
          review.validationRunId,
          review.validatedContentHash,
          awaitingRevision.id,
          awaitingRevision.projectId,
          awaitingProject.id,
          awaitingRevision.id,
          validatedCandidate.id,
          JSON.stringify(validatedCandidate),
          finalJob.id,
          JSON.stringify(finalJob),
          nextLearning.id,
          JSON.stringify(nextLearning),
          review.id,
          now,
        ),
    );
  } else if (repairableProgramFault) {
    const repairCandidate: KnowledgeCandidate = {
      ...decision.candidate,
      capability: { ...decision.candidate.capability, status: "learning" },
      authoring: {
        ...(decision.candidate.authoring || { stage: "designed", reusableTrace: false }),
        stage: "designed",
        reusableTrace: false,
        reason: run.outcome?.code === "verifier_mismatch" ? "程序已到达正确 Scene，只有完成条件发生漂移；保留程序并仅重新设计 Verifier。" : run.outcome?.code?.startsWith("extract") ? "业务字段提取证据不匹配；保留契约并重新设计 ExtractionProof。" : "独立验证发现程序定位证据不完整，已自动退回 AI Program Author 修复。",
      },
      validation: { ...decision.candidate.validation, status: "pending" },
      updatedAt: now,
    };
    nextLearning = updateReceipt({ ...nextLearning, phase: "author", status: "queued", failure: undefined }, "author", {
      status: "queued", title: run.outcome?.code === "verifier_mismatch" ? "页面已正确到达，AI 只修完成条件" : run.outcome?.code?.startsWith("extract") ? "AI 正在修复业务字段提取" : "验证发现缺口，AI 正在自动修复程序", summary: run.outcome?.code === "verifier_mismatch" ? "URL 与 Scene 已证明程序正确，文本漂移不会触发路径重写。" : "失败已归因到程序定位、输出或页面状态；Program Author 会基于最新 DOM 定向修复。", startedAt: now, endedAt: undefined,
    });
    statements.push(database.prepare(`UPDATE site_agent_v2_candidates SET status='pending',candidate_json=?,updated_at=? WHERE id=?`).bind(JSON.stringify(repairCandidate), now, candidate.id));
  } else {
    nextLearning = { ...nextLearning, phase: "validate", status: decision.decision === "retry" ? "queued" : "failed", failure: decision.decision === "retry" ? undefined : { code: decision.reason, summary: run.outcome?.summary || decision.reason } };
    statements.push(database.prepare(`UPDATE site_agent_v2_candidates SET status=?,candidate_json=?,updated_at=? WHERE id=?`).bind(decision.candidate.validation.status, JSON.stringify(decision.candidate), now, candidate.id));
  }
  if (decision.decision !== "publish") {
    statements.push(
      database.prepare(`UPDATE site_agent_v2_validation_jobs SET status=?,lease_expires_at=NULL,job_json=?,updated_at=? WHERE id=?`).bind(finalJob.status, JSON.stringify(finalJob), now, finalJob.id),
      database.prepare(`UPDATE site_agent_v2_learning_jobs SET status=?,result_json=?,updated_at=? WHERE id=?`).bind(nextLearning.status, JSON.stringify(nextLearning), now, nextLearning.id),
    );
  }
  if (validationGuardKey) {
    statements.push(database.prepare(`DELETE FROM site_agent_v2_meta WHERE key=?`).bind(validationGuardKey));
  }
  const results = await database.batch(statements); const failure = results.find((result) => !result.success); if (failure) throw new Error(failure.error || "validation_complete_failed");
  // The exact Working Revision was updated atomically above. Re-projecting a
  // successful validation from legacy Candidate/Operation rows can overwrite
  // its Revision-owned module pin before human review.
  if (decision.decision !== "publish") {
    await reconcileCapabilityControl(job.siteAgentId);
  }
  invalidateSiteAgentListCache(); await heartbeatValidationRunner(runnerId, "online");
  return {
    job: finalJob,
    learningJob: nextLearning,
    decision: completionDecision,
    release: decision.decision === "publish" ? activeRelease : decision.release,
    persistence: "d1" as const,
  };
}

export async function putBrowserArtifact(input: { siteAgentId: string; learningJobId: string; runId: string; ownerKind?: BrowserArtifact["ownerKind"]; kind: BrowserArtifact["kind"]; role?: BrowserArtifact["role"]; label: string; contentType: string; bytes: ArrayBuffer }) {
  const database = getD1Binding(); const bucket = getArtifactBinding();
  if (!database) throw new Error("artifact_storage_unavailable");
  const contentType = browserArtifactContentType(input.kind, input.contentType);
  if (!contentType) throw new Error("artifact_content_type_invalid");
  const now = new Date().toISOString(); const id = uid("artifact"); const objectKey = bucket ? `${input.siteAgentId}/${input.learningJobId}/${input.runId}/${id}` : `d1:${id}`;
  if (bucket) await bucket.put(objectKey, input.bytes, { httpMetadata: { contentType }, customMetadata: { kind: input.kind, runId: input.runId, ...(input.role ? { role: input.role } : {}) } });
  const artifact: BrowserArtifact = { id, siteAgentId: input.siteAgentId, learningJobId: input.learningJobId, runId: input.runId, ownerKind: input.ownerKind || "learning-job", kind: input.kind, ...(input.role ? { role: input.role } : {}), label: input.label.slice(0, 120), contentType, size: input.bytes.byteLength, url: `/api/artifacts/${id}`, createdAt: now };
  const statements = [database.prepare(`INSERT INTO site_agent_v2_artifacts (id,site_agent_id,learning_job_id,run_id,kind,object_key,artifact_json,created_at) VALUES (?,?,?,?,?,?,?,?)`).bind(id, input.siteAgentId, input.learningJobId, input.runId, input.kind, objectKey, JSON.stringify(artifact), now)];
  if (!bucket) {
    const bytes = new Uint8Array(input.bytes); const chunkSize = 384 * 1024;
    for (let offset = 0, sequence = 0; offset < bytes.length; offset += chunkSize, sequence += 1) statements.push(database.prepare(`INSERT INTO site_agent_v2_artifact_chunks (artifact_id,sequence,body) VALUES (?,?,?)`).bind(id, sequence, bytes.slice(offset, offset + chunkSize)));
  }
  const results = await database.batch(statements); const failure = results.find((result) => !result.success);
  if (failure) { if (bucket) await bucket.delete(objectKey); throw new Error(failure.error || "artifact_metadata_failed"); }
  return artifact;
}

export async function getBrowserArtifact(id: string) {
  const database = getD1Binding(); const bucket = getArtifactBinding(); if (!database) return undefined;
  const rows = await all<{ objectKey: string; artifactJson: string }>(database, `SELECT object_key AS objectKey,artifact_json AS artifactJson FROM site_agent_v2_artifacts WHERE id=? LIMIT 1`, [id]);
  if (!rows[0]) return undefined;
  const artifact = JSON.parse(rows[0].artifactJson) as BrowserArtifact;
  if (bucket && !rows[0].objectKey.startsWith("d1:")) {
    const object = await bucket.get(rows[0].objectKey); if (!object) return undefined; return { artifact, object };
  }
  const chunks = await all<{ body: ArrayBuffer | Uint8Array | number[] }>(database, `SELECT body FROM site_agent_v2_artifact_chunks WHERE artifact_id=? ORDER BY sequence`, [id]);
  if (!chunks.length) return undefined;
  const body = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk.body instanceof Uint8Array ? chunk.body : chunk.body instanceof ArrayBuffer ? new Uint8Array(chunk.body) : new Uint8Array(chunk.body)); controller.close(); } });
  return { artifact, object: { body, size: artifact.size, httpMetadata: { contentType: artifact.contentType } } };
}

async function deleteBrowserArtifact(id: string) {
  const database = getD1Binding();
  const bucket = getArtifactBinding();
  if (!database) return;
  const rows = await all<{ objectKey: string }>(database, `SELECT object_key AS objectKey FROM site_agent_v2_artifacts WHERE id=? LIMIT 1`, [id]);
  if (!rows[0]) return;
  if (bucket && !rows[0].objectKey.startsWith("d1:")) await bucket.delete(rows[0].objectKey).catch(() => undefined);
  await database.batch([
    database.prepare(`DELETE FROM site_agent_v2_artifact_chunks WHERE artifact_id=?`).bind(id),
    database.prepare(`DELETE FROM site_agent_v2_artifacts WHERE id=?`).bind(id),
  ]);
}

/**
 * Persist one original-DOM replay chunk (rrweb-style incremental snapshot
 * stream). Chunks are evidence for the Capability Center; they are never part
 * of a Release and are capped in size so a single record stays small. Both
 * user Episodes and authoring/validation BrowserRuns produce chunks.
 */
export async function appendDomReplayChunk(siteAgentId: string, chunk: DomReplayChunk): Promise<{ accepted: boolean; persistence: "memory" | "d1" }> {
  // Keep individual records bounded. A misbehaving page must not be able to
  // push an unbounded frame array into a single row.
  const bounded: DomReplayChunk = { ...chunk, siteAgentId, frames: chunk.frames.slice(0, 600) };
  const serialized = JSON.stringify(bounded);
  if (serialized.length > 2_000_000) throw new Error("dom_replay_chunk_too_large");
  const database = getD1Binding();
  if (!database) {
    const agent = memoryAgent(siteAgentId);
    if (!agent.domReplayChunks.some((item) => item.id === bounded.id)) {
      agent.domReplayChunks.push(bounded);
      // Bound in-memory retention for local development.
      if (agent.domReplayChunks.length > 4_000) agent.domReplayChunks.splice(0, agent.domReplayChunks.length - 4_000);
    }
    return { accepted: true, persistence: "memory" };
  }
  await ensureSiteAgentV2Schema(database);
  const result = await database.prepare(`INSERT OR REPLACE INTO site_agent_v2_dom_replay_chunks (id,site_agent_id,session_id,document_id,episode_id,run_id,seq_start,seq_end,chunk_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(bounded.id, siteAgentId, bounded.sessionId, bounded.documentId, bounded.episodeId || null, bounded.runId || null, bounded.seqStart, bounded.seqEnd, serialized, bounded.createdAt || new Date().toISOString()).run();
  if (!result.success) throw new Error(result.error || "dom_replay_chunk_save_failed");
  return { accepted: true, persistence: "d1" };
}

export async function getDomReplayChunksForEpisodes(siteAgentId: string, episodeIds: string[]): Promise<DomReplayChunk[]> {
  const ids = [...new Set(episodeIds.filter(Boolean))].slice(0, 16);
  if (!ids.length) return [];
  const database = getD1Binding();
  if (!database) {
    const agent = memoryAgent(siteAgentId);
    return agent.domReplayChunks.filter((chunk) => chunk.episodeId && ids.includes(chunk.episodeId)).sort((a, b) => a.seqStart - b.seqStart);
  }
  await ensureSiteAgentV2Schema(database);
  const rows = await all<{ chunkJson: string }>(database, `SELECT chunk_json AS chunkJson FROM site_agent_v2_dom_replay_chunks WHERE site_agent_id=? AND episode_id IN (${ids.map(() => "?").join(",")}) ORDER BY seq_start ASC LIMIT 400`, [siteAgentId, ...ids]);
  return rows.map((row) => JSON.parse(row.chunkJson) as DomReplayChunk);
}

export async function getDomReplayChunksForRun(siteAgentId: string, runId: string): Promise<DomReplayChunk[]> {
  if (!runId) return [];
  const database = getD1Binding();
  if (!database) {
    const agent = memoryAgent(siteAgentId);
    return agent.domReplayChunks.filter((chunk) => chunk.runId === runId).sort((a, b) => a.seqStart - b.seqStart);
  }
  await ensureSiteAgentV2Schema(database);
  const rows = await all<{ chunkJson: string }>(database, `SELECT chunk_json AS chunkJson FROM site_agent_v2_dom_replay_chunks WHERE site_agent_id=? AND run_id=? ORDER BY seq_start ASC LIMIT 400`, [siteAgentId, runId]);
  return rows.map((row) => JSON.parse(row.chunkJson) as DomReplayChunk);
}

/**
 * P2 · Persist a capability requirement document. Spec docs are versioned per
 * project; the newest is projected into the design stage. They are design
 * evidence, never mutated into a Release.
 */
export async function saveCapabilitySpecDoc(specDoc: CapabilitySpecDoc): Promise<{ specDoc: CapabilitySpecDoc; persistence: "memory" | "d1" }> {
  const database = getD1Binding();
  if (!database) {
    const agent = memoryAgent(specDoc.siteAgentId);
    const prior = agent.specDocs.filter((item) => item.projectId === specDoc.projectId);
    const version = prior.length ? Math.max(...prior.map((item) => item.version)) + 1 : 1;
    const stored: CapabilitySpecDoc = { ...specDoc, version };
    agent.specDocs = [...agent.specDocs, stored];
    return { specDoc: stored, persistence: "memory" };
  }
  await ensureSiteAgentV2Schema(database);
  const versionRows = await all<{ version: number }>(database, `SELECT version FROM site_agent_v2_capability_spec_docs WHERE site_agent_id=? AND project_id=? ORDER BY version DESC LIMIT 1`, [specDoc.siteAgentId, specDoc.projectId]);
  const version = (versionRows[0]?.version || 0) + 1;
  const stored: CapabilitySpecDoc = { ...specDoc, version };
  const result = await database.prepare(`INSERT OR REPLACE INTO site_agent_v2_capability_spec_docs (id,site_agent_id,project_id,revision_id,version,spec_json,created_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(stored.id, stored.siteAgentId, stored.projectId, stored.revisionId || null, stored.version, JSON.stringify(stored), stored.createdAt).run();
  if (!result.success) throw new Error(result.error || "capability_spec_doc_save_failed");
  return { specDoc: stored, persistence: "d1" };
}

async function getLatestCapabilitySpecDoc(siteAgentId: string, projectId: string, database?: D1DatabaseLike): Promise<CapabilitySpecDoc | undefined> {
  if (!database) {
    const agent = memoryAgent(siteAgentId);
    return agent.specDocs.filter((item) => item.projectId === projectId).sort((a, b) => b.version - a.version)[0];
  }
  const rows = await all<{ specJson: string }>(database, `SELECT spec_json AS specJson FROM site_agent_v2_capability_spec_docs WHERE site_agent_id=? AND project_id=? ORDER BY version DESC LIMIT 1`, [siteAgentId, projectId]);
  return rows[0] ? JSON.parse(rows[0].specJson) as CapabilitySpecDoc : undefined;
}

/**
 * P3/P4 · Persist an authoring workspace snapshot (the VFS the coding agent
 * wrote). This is authoring-craft evidence used by the workbench to replay
 * "which files the AI wrote"; it is never part of a Release.
 */
export async function saveAuthoringWorkspace(workspace: PersistedAuthoringWorkspace): Promise<{ persistence: "memory" | "d1" }> {
  const bounded: PersistedAuthoringWorkspace = { ...workspace, files: workspace.files.slice(0, 60).map((file) => ({ ...file, content: file.content.slice(0, 200_000) })) };
  const serialized = JSON.stringify(bounded);
  if (serialized.length > 4_000_000) throw new Error("authoring_workspace_too_large");
  const database = getD1Binding();
  if (!database) {
    const agent = memoryAgent(bounded.siteAgentId);
    if (!agent.authoringWorkspaces.some((item) => item.id === bounded.id)) {
      agent.authoringWorkspaces = [...agent.authoringWorkspaces, bounded];
      if (agent.authoringWorkspaces.length > 200) agent.authoringWorkspaces.splice(0, agent.authoringWorkspaces.length - 200);
    }
    return { persistence: "memory" };
  }
  await ensureSiteAgentV2Schema(database);
  const result = await database.prepare(`INSERT OR REPLACE INTO site_agent_v2_authoring_workspaces (id,site_agent_id,project_id,revision_id,learning_job_id,run_id,hash,workspace_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(bounded.id, bounded.siteAgentId, bounded.projectId, bounded.revisionId || null, bounded.learningJobId || null, bounded.runId || null, bounded.hash, serialized, bounded.createdAt).run();
  if (!result.success) throw new Error(result.error || "authoring_workspace_save_failed");
  return { persistence: "d1" };
}

async function getAuthoringWorkspacesForProject(siteAgentId: string, projectId: string, database?: D1DatabaseLike): Promise<PersistedAuthoringWorkspace[]> {
  if (!database) {
    const agent = memoryAgent(siteAgentId);
    return agent.authoringWorkspaces.filter((item) => item.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
  }
  const rows = await all<{ workspaceJson: string }>(database, `SELECT workspace_json AS workspaceJson FROM site_agent_v2_authoring_workspaces WHERE site_agent_id=? AND project_id=? ORDER BY created_at DESC LIMIT 20`, [siteAgentId, projectId]);
  return rows.map((row) => JSON.parse(row.workspaceJson) as PersistedAuthoringWorkspace);
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJsonValue(item)]),
  );
}

function canonicalJsonString(value: unknown) {
  return JSON.stringify(canonicalJsonValue(value));
}

async function sha256Json(value: unknown) {
  return sha256Hex(canonicalJsonString(value));
}

export async function putProgramModule(siteAgentId: string, source: string): Promise<ProgramModuleRef> {
  const database = getD1Binding();
  if (!database) throw new Error("program_module_storage_unavailable");
  await ensureSiteAgentV2Schema(database);
  const normalized = source.replace(/\r\n/g, "\n").trim();
  const validation = validateProgramModuleSource(normalized);
  if (!validation.ok) throw new Error(validation.code);
  const contentHash = await sha256Hex(normalized);
  const now = new Date().toISOString();
  const result = await database.prepare(`INSERT OR IGNORE INTO site_agent_v2_program_modules (content_hash,site_agent_id,source,created_at) VALUES (?,?,?,?)`)
    .bind(contentHash, siteAgentId, normalized, now).run();
  if (!result.success) throw new Error(result.error || "program_module_save_failed");
  return { contentHash, moduleUrl: `/programs/${contentHash}.js`, exportName: "capability" };
}

export async function getProgramModule(contentHash: string) {
  if (!/^[a-f0-9]{64}$/.test(contentHash)) return undefined;
  const database = getD1Binding();
  if (!database) return undefined;
  await ensureSiteAgentV2Schema(database);
  const rows = await all<{ source: string; siteAgentId: string }>(database, `SELECT source,site_agent_id AS siteAgentId FROM site_agent_v2_program_modules WHERE content_hash=? LIMIT 1`, [contentHash]);
  return rows[0] ? { contentHash, ...rows[0] } : undefined;
}

type CapabilityProjectRow = { projectJson: string };
type CapabilityRevisionRow = { revisionJson: string };
type CapabilityEventRow = { eventJson: string };
type CapabilitySuppressionRow = { suppressionJson: string };
type TaskLaunchRow = {
  launchJson: string;
  tokenHash: string;
  claimKeyHash?: string;
  status?: TaskLaunch["status"];
  updatedAt?: string;
};
type NavigationBuildHeadRow = { intentKey: string; launchId: string };

function taskLaunchFromRow(row: Pick<TaskLaunchRow, "launchJson" | "status" | "updatedAt">) {
  const launch = JSON.parse(row.launchJson) as TaskLaunch;
  return {
    ...launch,
    status: row.status || launch.status,
    updatedAt: row.updatedAt || launch.updatedAt,
  };
}

function projectPublicTaskLaunch(
  launch: TaskLaunch & { tokenHash?: string; claimKeyHash?: string },
): TaskLaunch {
  const {
    tokenHash: _tokenHash,
    claimKeyHash: _claimKeyHash,
    terminalRequestHash: _terminalRequestHash,
    ...publicLaunch
  } = launch;
  void _tokenHash;
  void _claimKeyHash;
  void _terminalRequestHash;
  return publicLaunch;
}
type CapabilityRunRow = { runJson: string };

function capabilityBuildTaskFromLearningJob(job: LearningJob): CapabilityBuildTask | undefined {
  const requestedGoal = typeof job.result?.requestedGoal === "string"
    ? job.result.requestedGoal.trim()
    : "";
  if (!requestedGoal || !["queued", "leased", "running", "failed"].includes(job.status)) return undefined;
  const goalClass = classifyGoal(requestedGoal);
  if (goalClass === "conversation") return undefined;
  const classification: CapabilityBuildTask["classification"] = goalClass === "navigation"
    ? "navigation"
    : "business";
  const status: CapabilityBuildTask["status"] = job.status === "queued"
    ? "pending"
    : job.status === "leased"
      ? "claimed"
      : job.status === "running"
        ? "running"
        : "failed";
  const duplicateOf = job.failure?.code === "duplicate_capability"
    && job.result?.duplicateOf
    && typeof job.result.duplicateOf === "object"
    && !Array.isArray(job.result.duplicateOf)
    && typeof job.result.duplicateOf.projectId === "string"
    && typeof job.result.duplicateOf.name === "string"
    ? {
        projectId: job.result.duplicateOf.projectId,
        capabilityId: typeof job.result.duplicateOf.capabilityId === "string"
          ? job.result.duplicateOf.capabilityId
          : undefined,
        name: job.result.duplicateOf.name,
      }
    : undefined;
  return {
    id: `build-request:${job.id}`,
    siteAgentId: job.siteAgentId,
    intentKey: job.intentKey || `build_request_${stableHash(normalizeGoal(requestedGoal))}`,
    classification,
    assetKind: "capability-build-request",
    goal: requestedGoal,
    status,
    phase: job.phase,
    latestLaunchId: job.id,
    latestLearningJobId: job.id,
    attemptCount: job.attempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: new Date(Date.parse(job.createdAt) + 24 * 60 * 60_000).toISOString(),
    error: job.failure,
    duplicateOf,
  };
}

/**
 * Exported for tests: one pending goal is one card, and the only live producer
 * of these jobs (`actOnCapabilityProject`) needs a project with a contract to
 * reach it, which is a long way round for a list-shaping rule.
 */
export function mergeCapabilityBuildTasks(
  learningJobs: LearningJob[],
  navigationTasks: CapabilityBuildTask[],
  projectGoals: Set<string>,
) {
  const allLearningTasks = learningJobs
    .map(capabilityBuildTaskFromLearningJob)
    .filter((task): task is CapabilityBuildTask => Boolean(task))
    .filter((task) => task.error?.code === "duplicate_capability"
      || !projectGoals.has(normalizeGoal(task.goal)));
  // One pending goal is one card. Clicking the same button twice mints two
  // build requests, and listing both told the administrator two different
  // things were being built. A duplicate receipt is kept separate on purpose:
  // it is a durable record of that click's verdict, not work in flight.
  const pendingByGoal = new Map<string, CapabilityBuildTask>();
  const learningTasks: CapabilityBuildTask[] = [];
  for (const task of allLearningTasks) {
    if (task.error?.code === "duplicate_capability") { learningTasks.push(task); continue; }
    const goalKey = normalizeGoal(task.goal);
    const previous = pendingByGoal.get(goalKey);
    if (!previous) { pendingByGoal.set(goalKey, task); learningTasks.push(task); continue; }
    // Keep the newest request as the visible one, and let the count say how
    // many times it was asked for.
    const newest = task.updatedAt.localeCompare(previous.updatedAt) > 0 ? task : previous;
    const merged = { ...newest, attemptCount: (previous.attemptCount || 0) + (task.attemptCount || 0) + 1 };
    pendingByGoal.set(goalKey, merged);
    learningTasks[learningTasks.indexOf(previous)] = merged;
  }
  const ownedGoals = new Set(learningTasks.map((task) => normalizeGoal(task.goal)));
  return [
    ...learningTasks,
    ...navigationTasks.filter((task) =>
      !projectGoals.has(normalizeGoal(task.goal))
      && !ownedGoals.has(normalizeGoal(task.goal))),
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
}

const DUPLICATE_BUILD_TASK_PAGE_SIZE = 50;

function duplicateBuildTaskCursor(job: LearningJob) {
  return JSON.stringify([job.updatedAt, job.id]);
}

function parseDuplicateBuildTaskCursor(value?: string) {
  if (!value) return undefined;
  if (value.length > 1_024) throw new Error("capability_build_request_cursor_invalid");
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)
      || parsed.length !== 2
      || typeof parsed[0] !== "string"
      || typeof parsed[1] !== "string"
      || !parsed[0]
      || !parsed[1]
      || parsed[0].length !== 24
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed[0])
      || new Date(parsed[0]).toISOString() !== parsed[0]
      || parsed[1].length > 512) {
      throw new Error("invalid");
    }
    return { updatedAt: parsed[0], id: parsed[1] };
  } catch {
    throw new Error("capability_build_request_cursor_invalid");
  }
}

function duplicateLearningJobPage(jobs: LearningJob[], cursor?: string) {
  const parsedCursor = parseDuplicateBuildTaskCursor(cursor);
  const ordered = jobs
    .filter((job) => job.status === "failed" && job.failure?.code === "duplicate_capability")
    .filter((job) => !parsedCursor
      || job.updatedAt < parsedCursor.updatedAt
      || (job.updatedAt === parsedCursor.updatedAt && job.id < parsedCursor.id))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
  const page = ordered.slice(0, DUPLICATE_BUILD_TASK_PAGE_SIZE);
  const hasMoreDuplicates = ordered.length > page.length;
  return {
    jobs: page,
    buildTaskPage: {
      hasMoreDuplicates,
      nextDuplicateCursor: hasMoreDuplicates && page.length
        ? duplicateBuildTaskCursor(page[page.length - 1])
        : undefined,
    },
  };
}

async function activeCapabilitySuppressions(database: D1DatabaseLike, siteAgentId: string) {
  const rows = await all<CapabilitySuppressionRow>(
    database,
    `SELECT suppression_json AS suppressionJson
       FROM site_agent_v2_capability_suppressions
      WHERE site_agent_id=? AND status='active'
      ORDER BY updated_at DESC`,
    [siteAgentId],
  );
  return rows.map((row) => JSON.parse(row.suppressionJson) as CapabilitySuppression);
}

function projectWithIdentityDefaults(project: CapabilityProject): CapabilityProject {
  const structure = project.structure || "atomic";
  return {
    ...project,
    canonicalCapabilityId: project.canonicalCapabilityId
      || project.activeCapabilityId,
    stableKey: project.stableKey || capabilityProjectStableKey(project),
    contractFingerprint: project.contractFingerprint || capabilityContractFingerprint({
      kind: project.kind,
      resultKind: project.resultKind,
      structure: project.structure,
      operation: project.operation,
      inputs: project.inputSchema,
      outputs: project.outputSchema,
    }),
    structure,
    // Composite capabilities orchestrate other Capability contracts. They do
    // not have one atomic read/write effect of their own.
    operation: structure === "composite"
      ? undefined
      : project.kind === "navigation"
        ? "read"
        : project.operation || (project.resultKind === "action" ? "write" : "read"),
  };
}

function capabilityProjectForWrite(project: CapabilityProject): CapabilityProject {
  const canonical = projectWithIdentityDefaults(project);
  // implementationAssets is a legacy projection field. Keeping the optional
  // reader above lets old JSON render, while every new root write removes it.
  const root = { ...canonical };
  delete root.implementationAssets;
  return root;
}

function projectWithPublishedContract(project: CapabilityProject, release: SiteAgentReleaseV2) {
  const published = project.activeCapabilityId
    ? release.capabilities.find((capability) => capability.id === project.activeCapabilityId)
    : undefined;
  if (!published) return projectWithIdentityDefaults({
    ...project,
    kind: project.kind || (classifyGoal(project.goalTemplate || project.name) === "navigation" ? "navigation" : "task"),
    exposure: project.exposure || "public",
    origin: project.origin || (project.resultKind === "page" ? "ai-exploration" : "administrator"),
  });
  // A knowledge-compiled Navigation Capability may aggregate several runtime
  // adapters. The representative adapter is only an implementation pointer;
  // copying its entity-specific label back onto the project would undo the
  // semantic grouping on every read.
  if (project.generatedBy === "program") return projectWithIdentityDefaults({
    ...project,
    kind: published.kind || project.kind || "navigation",
    exposure: published.exposure || project.exposure || "internal",
    origin: project.origin || "knowledge-compiled",
  });
  const repaired = {
    ...project,
    kind: published.kind || project.kind || "task",
    exposure: published.exposure || project.exposure || "public",
    origin: published.origin || project.origin,
    name: published.name,
    description: published.description,
    goalTemplate: published.goalTemplate || published.name,
    resultKind: published.resultKind || project.resultKind,
    inputSchema: published.inputs,
    outputSchema: published.outputs,
  } satisfies CapabilityProject;
  const repairedIdentity = projectWithIdentityDefaults({
    ...repaired,
    stableKey: undefined,
    contractFingerprint: undefined,
  });
  // A canonical schema repair is an identity repair as well. Keeping the old
  // fingerprint beside the new schema would make a later strict claim create
  // a second root for the same published contract.
  return project.contractFingerprint
    && project.contractFingerprint !== repairedIdentity.contractFingerprint
    ? repairedIdentity
    : projectWithIdentityDefaults(repaired);
}

function canonicalCapabilityProjectStatement(
  database: D1DatabaseLike,
  project: CapabilityProject,
  mode: "insert" | "ignore" = "insert",
) {
  const canonical = capabilityProjectForWrite(project);
  const insert = mode === "insert"
    ? "INSERT"
    : "INSERT OR IGNORE";
  return database.prepare(`${insert} INTO site_agent_v2_capability_projects
    (id,site_agent_id,intent_key,stable_key,contract_fingerprint,active_revision_id,latest_revision_id,status,project_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      canonical.id,
      canonical.siteAgentId,
      canonical.intentKey,
      canonical.stableKey || null,
      canonical.contractFingerprint || null,
      canonical.activeRevisionId || null,
      canonical.latestRevisionId || null,
      canonical.status,
      JSON.stringify(canonical),
      canonical.createdAt,
      canonical.updatedAt,
    );
}

function canonicalCapabilityProjectUpdateStatement(
  database: D1DatabaseLike,
  project: CapabilityProject,
) {
  const canonical = capabilityProjectForWrite(project);
  return database.prepare(`UPDATE site_agent_v2_capability_projects
    SET intent_key=?,stable_key=?,contract_fingerprint=?,active_revision_id=?,latest_revision_id=?,
        status=?,project_json=?,created_at=?,updated_at=?
    WHERE id=? AND site_agent_id=?`)
    .bind(
      canonical.intentKey,
      canonical.stableKey || null,
      canonical.contractFingerprint || null,
      canonical.activeRevisionId || null,
      canonical.latestRevisionId || null,
      canonical.status,
      JSON.stringify(canonical),
      canonical.createdAt,
      canonical.updatedAt,
      canonical.id,
      canonical.siteAgentId,
    );
}

function canonicalCapabilityProjectCompareAndSetStatement(
  database: D1DatabaseLike,
  previousProjectJson: string,
  project: CapabilityProject,
  expectedReleaseId: string,
) {
  const canonical = capabilityProjectForWrite(project);
  return database.prepare(`UPDATE site_agent_v2_capability_projects
    SET intent_key=?,stable_key=?,contract_fingerprint=?,active_revision_id=?,latest_revision_id=?,
        status=?,project_json=?,created_at=?,updated_at=?
    WHERE id=? AND site_agent_id=? AND project_json=?
      AND EXISTS (
        SELECT 1 FROM site_agent_v2_agents
         WHERE id=? AND active_release_id=?
      )`)
    .bind(
      canonical.intentKey,
      canonical.stableKey || null,
      canonical.contractFingerprint || null,
      canonical.activeRevisionId || null,
      canonical.latestRevisionId || null,
      canonical.status,
      JSON.stringify(canonical),
      canonical.createdAt,
      canonical.updatedAt,
      canonical.id,
      canonical.siteAgentId,
      previousProjectJson,
      canonical.siteAgentId,
      expectedReleaseId,
    );
}

function canonicalCapabilityProjectMigrationInsertStatement(
  database: D1DatabaseLike,
  project: CapabilityProject,
  expectedReleaseId: string,
) {
  const canonical = capabilityProjectForWrite(project);
  return database.prepare(`INSERT OR IGNORE INTO site_agent_v2_capability_projects
    (id,site_agent_id,intent_key,stable_key,contract_fingerprint,active_revision_id,latest_revision_id,status,project_json,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?
    WHERE EXISTS (
      SELECT 1 FROM site_agent_v2_agents
       WHERE id=? AND active_release_id=?
    )`)
    .bind(
      canonical.id,
      canonical.siteAgentId,
      canonical.intentKey,
      canonical.stableKey || null,
      canonical.contractFingerprint || null,
      canonical.activeRevisionId || null,
      canonical.latestRevisionId || null,
      canonical.status,
      JSON.stringify(canonical),
      canonical.createdAt,
      canonical.updatedAt,
      canonical.siteAgentId,
      expectedReleaseId,
    );
}

function canonicalCapabilityRevisionMigrationInsertStatement(
  database: D1DatabaseLike,
  revision: CapabilityRevision,
  expectedProject: CapabilityProject,
  expectedReleaseId: string,
) {
  const project = capabilityProjectForWrite(expectedProject);
  return database.prepare(`INSERT OR IGNORE INTO site_agent_v2_capability_revisions
    (id,project_id,site_agent_id,revision_number,status,revision_json,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?
    WHERE EXISTS (
      SELECT 1 FROM site_agent_v2_agents
       WHERE id=? AND active_release_id=?
    )
      AND EXISTS (
        SELECT 1 FROM site_agent_v2_capability_projects
         WHERE id=? AND site_agent_id=? AND project_json=?
           AND active_revision_id=? AND latest_revision_id=?
      )`)
    .bind(
      revision.id,
      revision.projectId,
      revision.siteAgentId,
      revision.number,
      revision.status,
      JSON.stringify(revision),
      revision.createdAt,
      revision.updatedAt,
      revision.siteAgentId,
      expectedReleaseId,
      project.id,
      project.siteAgentId,
      JSON.stringify(project),
      revision.id,
      revision.id,
    );
}

function sameCapabilityProjectIdentity(
  left: CapabilityProject,
  right: CapabilityProject,
) {
  const canonicalLeft = projectWithIdentityDefaults(left);
  const canonicalRight = projectWithIdentityDefaults(right);
  return Boolean(
    canonicalLeft.stableKey
    && canonicalLeft.contractFingerprint
    && canonicalLeft.stableKey === canonicalRight.stableKey
    && canonicalLeft.contractFingerprint === canonicalRight.contractFingerprint,
  );
}

/**
 * Reconciliation is allowed to refresh production state for an explicit
 * canonical Capability, but it may not create, merge or delete identities.
 * Published Revision JSON is immutable; only a Working Revision can advance.
 */
async function persistCapabilityDerivedState(
  database: D1DatabaseLike,
  siteAgentId: string,
  expectedReleaseId: string,
  projection: ReturnType<typeof projectCapabilityControl>,
) {
  const existingProjects = new Map((await all<CapabilityProjectRow>(database, `SELECT project_json AS projectJson FROM site_agent_v2_capability_projects WHERE site_agent_id=?`, [siteAgentId])).map((row) => {
    const value = projectWithIdentityDefaults(JSON.parse(row.projectJson) as CapabilityProject);
    return [value.id, { value, projectJson: row.projectJson }] as const;
  }));
  const existingRevisions = new Map((await all<CapabilityRevisionRow>(database, `SELECT revision_json AS revisionJson FROM site_agent_v2_capability_revisions WHERE site_agent_id=?`, [siteAgentId])).map((row) => {
    const value = JSON.parse(row.revisionJson) as CapabilityRevision;
    return [value.id, { value, revisionJson: row.revisionJson }] as const;
  }));
  const strictProjectMatch = (incoming: CapabilityProject) => {
    const exactId = existingProjects.get(incoming.id);
    if (exactId && (
      sameCapabilityProjectIdentity(exactId.value, incoming)
      || Boolean(exactId.value.activeCapabilityId
        && exactId.value.activeCapabilityId === incoming.activeCapabilityId)
    )) return exactId;
    const matches = [...existingProjects.values()].filter(({ value }) =>
      Boolean(value.activeCapabilityId
        && value.activeCapabilityId === incoming.activeCapabilityId)
      || sameCapabilityProjectIdentity(value, incoming));
    return matches.length === 1 ? matches[0] : undefined;
  };
  const statements = [];
  for (const incoming of projection.projects) {
    const matched = strictProjectMatch(incoming);
    if (!matched) continue;
    const previous = matched.value;
    const identityMatches = sameCapabilityProjectIdentity(previous, incoming);
    const incomingCapabilityIsPersisted = Boolean(
      previous.activeCapabilityId
      && previous.activeCapabilityId === incoming.activeCapabilityId,
    );
    const projectionBlocked = previous.status === "archived"
      || previous.status === "unpublished"
      || previous.autoGenerationBlocked;
    const mayBindPublishedIdentity = !projectionBlocked
      && (identityMatches || incomingCapabilityIsPersisted);
    const derived = projectWithIdentityDefaults({
      ...previous,
      status: projectionBlocked
        ? previous.status
        : mayBindPublishedIdentity
          ? incoming.status
          : previous.status,
      stage: mayBindPublishedIdentity ? incoming.stage : previous.stage,
      activeCapabilityId: previous.activeCapabilityId
        || (mayBindPublishedIdentity ? incoming.activeCapabilityId : undefined),
      activeRevisionId: previous.activeRevisionId
        || (mayBindPublishedIdentity ? incoming.activeRevisionId : undefined),
      latestRevisionId: previous.latestRevisionId
        || (mayBindPublishedIdentity ? incoming.latestRevisionId : undefined),
      executionRequirements: incoming.executionRequirements,
      health: incoming.health,
      revisionCount: Math.max(previous.revisionCount, incoming.revisionCount),
      buildStartedAt: previous.buildStartedAt || incoming.buildStartedAt,
      updatedAt: incoming.updatedAt > previous.updatedAt ? incoming.updatedAt : previous.updatedAt,
      // Capability identity and its stable contract are never projected.
      id: previous.id,
      stableKey: previous.stableKey,
      contractFingerprint: previous.contractFingerprint,
      intentKey: previous.intentKey,
      name: previous.name,
      description: previous.description,
      goalTemplate: previous.goalTemplate,
      structure: previous.structure,
      operation: previous.operation,
      inputSchema: previous.inputSchema,
      outputSchema: previous.outputSchema,
      createdAt: previous.createdAt,
    });
    if (JSON.stringify(previous) === JSON.stringify(derived)) continue;
    statements.push(canonicalCapabilityProjectCompareAndSetStatement(
      database,
      matched.projectJson,
      derived,
      expectedReleaseId,
    ));
  }
  const canonicalProjectId = (projectId: string) => {
    const incoming = projection.projects.find((project) => project.id === projectId);
    return incoming ? strictProjectMatch(incoming)?.value.id : undefined;
  };
  const canonicalRevisionIds = new Map<string, string>();
  for (const incoming of projection.revisions) {
    const projectId = canonicalProjectId(incoming.projectId);
    if (!projectId) continue;
    const projectedRevision = projectId === incoming.projectId ? incoming : { ...incoming, projectId };
    const existingById = existingRevisions.get(projectedRevision.id);
    const existingByLearningJob = projectedRevision.learningJobId
      ? [...existingRevisions.values()].find(({ value }) =>
        value.projectId === projectId
        && value.learningJobId === projectedRevision.learningJobId)
      : undefined;
    const previousEntry = existingById || existingByLearningJob;
    const previous = previousEntry?.value;
    const projectedCanonicalRevision = previous && previous.id !== projectedRevision.id
      ? {
          ...projectedRevision,
          id: previous.id,
          number: previous.number,
        }
      : projectedRevision;
    // The projection can derive lifecycle/health from runs, but implementation
    // belongs to the Revision write model. In particular, a freshly pinned
    // NavigationTool is not present in the Release projection until publish;
    // never erase that pin during the reconciliation immediately following
    // design.
    const revision = previous
      ? {
          ...projectedCanonicalRevision,
          publicationProvenance: projectedCanonicalRevision.publicationProvenance
            || previous.publicationProvenance,
          implementationReleaseId: projectedCanonicalRevision.implementationReleaseId
            || previous.implementationReleaseId,
          implementationReleaseVersion: projectedCanonicalRevision.implementationReleaseVersion
            ?? previous.implementationReleaseVersion,
          publishedReleaseId: projectedCanonicalRevision.publishedReleaseId
            || previous.publishedReleaseId,
          publishedReleaseVersion: projectedCanonicalRevision.publishedReleaseVersion
            ?? previous.publishedReleaseVersion,
          implementation: projectedCanonicalRevision.implementation
            || previous.implementation,
        }
      : projectedCanonicalRevision;
    canonicalRevisionIds.set(incoming.id, revision.id);
    const canonicalProject = existingProjects.get(projectId)?.value;
    const publishedRevision = [...existingRevisions.values()].find(({ value }) =>
      value.projectId === projectId && value.status === "published")?.value;
    if (revision.status === "published"
      && ((canonicalProject?.activeRevisionId && canonicalProject.activeRevisionId !== revision.id)
        || (publishedRevision && publishedRevision.id !== revision.id))) continue;
    if (previous?.status === "published") continue;
    if (JSON.stringify(previous) === JSON.stringify(revision)) continue;
    const revisionForWrite = { ...revision };
    delete revisionForWrite.contract;
    statements.push(previous
      ? database.prepare(`UPDATE site_agent_v2_capability_revisions
          SET status=?,revision_json=?,updated_at=?
          WHERE id=? AND project_id=? AND site_agent_id=?
            AND status<>'published' AND revision_json=?`)
        .bind(
          revision.status,
          JSON.stringify(revisionForWrite),
          revision.updatedAt,
          revision.id,
          revision.projectId,
          revision.siteAgentId,
          previousEntry!.revisionJson,
        )
      : database.prepare(`INSERT INTO site_agent_v2_capability_revisions
          (id,project_id,site_agent_id,revision_number,status,revision_json,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?)`)
        .bind(
          revision.id,
          revision.projectId,
          revision.siteAgentId,
          revision.number,
          revision.status,
          JSON.stringify(revisionForWrite),
          revision.createdAt,
          revision.updatedAt,
        ));
  }
  for (const incoming of projection.events) {
    const projectId = canonicalProjectId(incoming.projectId);
    if (!projectId) continue;
    const event = {
      ...incoming,
      projectId,
      revisionId: incoming.revisionId
        ? canonicalRevisionIds.get(incoming.revisionId) || incoming.revisionId
        : undefined,
    };
    statements.push(database.prepare(`INSERT OR IGNORE INTO site_agent_v2_capability_events
      (id,project_id,revision_id,site_agent_id,type,status,event_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .bind(event.id, event.projectId, event.revisionId || null, event.siteAgentId, event.type, event.status, JSON.stringify(event), event.createdAt));
  }
  for (let index = 0; index < statements.length; index += 80) {
    const results = await database.batch(statements.slice(index, index + 80));
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "capability_derived_state_save_failed");
  }
}

const CAPABILITY_MODEL_EPOCH = "canonical-capability-roots-v3";

function capabilityModelMarker(siteAgentId: string) {
  return `capability_model_epoch:${siteAgentId}`;
}

function technicalCapabilityProject(
  project: CapabilityProject,
  revisionProjectIds: ReadonlySet<string>,
) {
  const capabilityId = project.activeCapabilityId || "";
  const emptyDuplicateReceipt = project.status === "duplicate"
    && Boolean(project.duplicateOf)
    && !project.activeCapabilityId
    && !project.activeRevisionId
    && !project.latestRevisionId
    && project.revisionCount === 0
    && !revisionProjectIds.has(project.id);
  if (emptyDuplicateReceipt) return true;
  return capabilityId.startsWith("navigation-tool:")
    || capabilityId.startsWith("capability_shared_nav_");
}

function importedPublishedRevision(
  project: CapabilityProject,
  capability: CapabilityDefinition,
  release: SiteAgentReleaseV2,
  number: number,
): CapabilityRevision {
  const id = `revision_${stableHash(`${project.id}:release:${capability.id}:${capability.updatedAt}:${number}`)}`;
  return {
    id,
    projectId: project.id,
    siteAgentId: project.siteAgentId,
    number,
    status: "published",
    stage: "publish",
    publicationProvenance: "legacy-release-import",
    baseReleaseVersion: Math.max(0, release.version - 1),
    implementationReleaseId: release.id,
    implementationReleaseVersion: release.version,
    publishedReleaseId: release.id,
    publishedReleaseVersion: release.version,
    parameterizationDecisions: [],
    implementation: revisionImplementationForCapability(release, capability),
    guidanceIds: [],
    createdAt: capability.updatedAt,
    updatedAt: capability.updatedAt,
  };
}

function importedCapabilityProject(
  siteAgentId: string,
  capability: CapabilityDefinition,
  release: SiteAgentReleaseV2,
  existing?: CapabilityProject,
) {
  const base = projectWithIdentityDefaults(existing
    ? projectWithPublishedContract(existing, {
      ...emptyRelease(siteAgentId),
      id: `migration_${siteAgentId}`,
      version: release.version,
      capabilities: [capability],
    })
    : canonicalReleaseCapabilityProject(siteAgentId, capability));
  return capabilityProjectForWrite({
    ...base,
    canonicalCapabilityId: capability.id,
    activeCapabilityId: capability.id,
  });
}

type CanonicalRevisionRecord = {
  id: string;
  projectId: string;
  number: number;
  revision: CapabilityRevision;
};

type CanonicalCatalogPlan = {
  projects: CapabilityProject[];
  newRevisions: CapabilityRevision[];
  technicalProjects: CapabilityProject[];
  existingProjectIds: Set<string>;
  conflictEvents: CapabilityEvent[];
};

function uniqueImportedProject(
  project: CapabilityProject,
  capability: CapabilityDefinition,
  usedProjectIds: Set<string>,
) {
  if (!usedProjectIds.has(project.id)) return project;
  let ordinal = 1;
  let id = project.id;
  do {
    id = `project_${stableHash(`${project.id}:canonical-import:${capability.id}:${ordinal}`)}`;
    ordinal += 1;
  } while (usedProjectIds.has(id));
  return { ...project, id };
}

function canonicalIdentityForConflict(project: CapabilityProject) {
  const canonical = projectWithIdentityDefaults(project);
  return {
    stableKey: project.identityConflict?.canonicalStableKey || canonical.stableKey!,
    contractFingerprint: project.identityConflict?.canonicalContractFingerprint || canonical.contractFingerprint!,
  };
}

function prepareCanonicalCatalogPlan(input: {
  siteAgentId: string;
  release: SiteAgentReleaseV2;
  existingProjects: CapabilityProject[];
  existingRevisions: CanonicalRevisionRecord[];
  migrationAt: string;
}): CanonicalCatalogPlan {
  const { siteAgentId, release, existingRevisions, migrationAt } = input;
  const normalizedExisting = input.existingProjects.map(projectWithIdentityDefaults);
  const revisionProjectIds = new Set(
    existingRevisions.map((revision) => revision.projectId),
  );
  const technicalProjects = normalizedExisting.filter((project) =>
    technicalCapabilityProject(project, revisionProjectIds));
  const roots = normalizedExisting
    .filter((project) => !technicalCapabilityProject(project, revisionProjectIds))
    .map(capabilityProjectForWrite);
  const existingProjectIds = new Set(roots.map((project) => project.id));
  const usedProjectIds = new Set(normalizedExisting.map((project) => project.id));
  const capabilityByProjectId = new Map<string, CapabilityDefinition>();

  // A formal Release capability may only resume the root that explicitly
  // names its capability id. Canonical identity is deliberately not used as
  // an implicit merge key during migration.
  //
  // `suggested` is excluded: it is a discovery hint that nobody asked to be
  // built. Importing one creates a root with no Revision, which the projection
  // then reports as `building` — the console claiming work is under way when
  // no job exists. `learning` is kept, because that one really is being built.
  const importable = release.capabilities
    .filter(isFormalCapability)
    .filter((capability) => capability.status !== "suggested");
  for (const capability of importable) {
    const matchIndex = roots.findIndex((project) =>
      project.activeCapabilityId === capability.id
      && !capabilityByProjectId.has(project.id));
    if (matchIndex >= 0) {
      const project = importedCapabilityProject(siteAgentId, capability, release, roots[matchIndex]);
      roots[matchIndex] = project;
      capabilityByProjectId.set(project.id, capability);
      continue;
    }
    const project = uniqueImportedProject(
      importedCapabilityProject(siteAgentId, capability, release),
      capability,
      usedProjectIds,
    );
    usedProjectIds.add(project.id);
    roots.push(project);
    capabilityByProjectId.set(project.id, capability);
  }

  const revisionRecords = [...existingRevisions];
  const newRevisions: CapabilityRevision[] = [];
  const projectsWithValidPointers = roots.map((root) => {
    const ownRevisions = revisionRecords
      .filter((record) => record.projectId === root.id)
      .sort((left, right) => left.number - right.number);
    const maxRevisionNumber = ownRevisions.reduce(
      (maximum, record) => Math.max(maximum, record.number),
      0,
    );
    const active = root.activeRevisionId
      ? ownRevisions.find((record) => record.id === root.activeRevisionId)
      : undefined;
    const latest = root.latestRevisionId
      ? ownRevisions.find((record) => record.id === root.latestRevisionId)
      : undefined;
    const capability = capabilityByProjectId.get(root.id);
    const capabilityIsCallable = capability?.status === "available"
      || capability?.status === "improving";

    if (capabilityIsCallable
      && capability
      && (!active || active.revision.status !== "published")) {
      // The SQL revision_number column, supplied in existingRevisions, is the
      // authority for max+1. Never trust a stale count or JSON snapshot.
      const revision = importedPublishedRevision(root, capability, release, maxRevisionNumber + 1);
      newRevisions.push(revision);
      revisionRecords.push({
        id: revision.id,
        projectId: revision.projectId,
        number: revision.number,
        revision,
      });
      return capabilityProjectForWrite({
        ...root,
        activeRevisionId: revision.id,
        latestRevisionId: revision.id,
        executionRequirements: executionRequirementsForPublishedRevision(root, capability, revision),
        revisionCount: Math.max(root.revisionCount, revision.number),
      });
    }

    if (capabilityIsCallable && capability && active) {
      const newest = ownRevisions[ownRevisions.length - 1];
      return capabilityProjectForWrite({
        ...root,
        activeRevisionId: active.id,
        latestRevisionId: latest?.id || newest?.id || active.id,
        executionRequirements: executionRequirementsForPublishedRevision(root, capability, active.revision),
        revisionCount: Math.max(root.revisionCount, maxRevisionNumber),
      });
    }

    const danglingPointer = Boolean(
      (root.activeRevisionId && !active)
      || (root.latestRevisionId && !latest),
    );
    const newest = ownRevisions[ownRevisions.length - 1];
    // A suggested/learning Release entry is a real Capability contract, but it
    // is not a published implementation. Keep the root visible and retain any
    // historical Revision as latest evidence without presenting it as active.
    const repairedActive = capability && !capabilityIsCallable
      ? undefined
      : active?.id;
    const repairedLatest = latest?.id || repairedActive || newest?.id;
    const requiresGuidance = danglingPointer
      || (root.status === "available" && !repairedActive);
    return capabilityProjectForWrite({
      ...root,
      activeRevisionId: repairedActive,
      latestRevisionId: repairedLatest,
      revisionCount: Math.max(root.revisionCount, maxRevisionNumber),
      status: capability && !capabilityIsCallable
        ? "building"
        : requiresGuidance
          ? "needs-guidance"
          : root.status,
      stage: capability && !capabilityIsCallable
        ? "design"
        : requiresGuidance
          ? "design"
          : root.stage,
    });
  });

  // Isolate every member of an ambiguous legacy identity. Both rows stay
  // visible and retain the original canonical identity for a human decision;
  // a deterministic storage key keeps the unique index enforceable.
  const identityGroups = new Map<string, {
    stableKey: string;
    contractFingerprint: string;
    projects: CapabilityProject[];
  }>();
  for (const project of projectsWithValidPointers) {
    const identity = canonicalIdentityForConflict(project);
    const key = JSON.stringify([identity.stableKey, identity.contractFingerprint]);
    const group = identityGroups.get(key) || { ...identity, projects: [] };
    group.projects.push(project);
    identityGroups.set(key, group);
  }

  const conflictEvents: CapabilityEvent[] = [];
  const projects = projectsWithValidPointers.map((project) => {
    const identity = canonicalIdentityForConflict(project);
    const group = identityGroups.get(JSON.stringify([identity.stableKey, identity.contractFingerprint]))!;
    if (group.projects.length < 2) return capabilityProjectForWrite(project);
    const conflictingProjectIds = group.projects.map((item) => item.id).sort();
    const isolated = capabilityProjectForWrite({
      ...project,
      stableKey: `legacy_conflict_${stableHash(JSON.stringify([
        group.stableKey,
        group.contractFingerprint,
        project.id,
      ]))}`,
      contractFingerprint: group.contractFingerprint,
      identityConflict: {
        canonicalStableKey: group.stableKey,
        canonicalContractFingerprint: group.contractFingerprint,
        conflictingProjectIds,
      },
      status: "needs-guidance",
      stage: "design",
      updatedAt: migrationAt > project.updatedAt ? migrationAt : project.updatedAt,
    });
    conflictEvents.push({
      id: `event_${stableHash(`${CAPABILITY_MODEL_EPOCH}:identity-conflict:${project.id}`)}`,
      siteAgentId,
      projectId: project.id,
      type: "migration",
      actor: "release-gate",
      status: "failed",
      title: "Legacy canonical identity needs guidance",
      summary: "This Capability was retained and isolated because another legacy root has the same canonical identity.",
      evidence: {
        modelEpoch: CAPABILITY_MODEL_EPOCH,
        canonicalStableKey: group.stableKey,
        canonicalContractFingerprint: group.contractFingerprint,
        conflictingProjectIds,
      },
      createdAt: migrationAt,
    });
    return isolated;
  });

  return {
    projects,
    newRevisions,
    technicalProjects,
    existingProjectIds,
    conflictEvents,
  };
}

function ensureMemoryCanonicalCapabilityCatalog(siteAgentId: string) {
  const agent = memoryAgent(siteAgentId);
  if (agent.capabilityCatalogMigrated) return;
  const migrationAt = new Date().toISOString();
  // Memory fixtures may intentionally retain incomplete historical execution
  // graphs. Catalog migration only reclassifies technical adapters; it must not
  // run the broader knowledge release gate and accidentally discard a formal
  // contract for unrelated graph-quality reasons.
  const release: SiteAgentReleaseV2 = {
    ...agent.release,
    capabilities: agent.release.capabilities.filter(isFormalCapability),
  };
  const plan = prepareCanonicalCatalogPlan({
    siteAgentId,
    release,
    existingProjects: agent.capabilityProjects,
    existingRevisions: agent.capabilityRevisions.map((revision) => ({
      id: revision.id,
      projectId: revision.projectId,
      number: revision.number,
      revision,
    })),
    migrationAt,
  });
  const eventIds = new Set(agent.capabilityEvents.map((event) => event.id));
  // The in-memory catalog view may filter technical adapter capabilities for
  // planning, but it must not rewrite an immutable Release under the same id.
  // Imported Revisions can safely pin the original snapshot because every
  // formal capability used by the plan is still present there.
  agent.capabilityProjects = plan.projects;
  agent.capabilityRevisions = [...agent.capabilityRevisions, ...plan.newRevisions];
  agent.capabilityEvents = [
    ...agent.capabilityEvents,
    ...plan.conflictEvents.filter((event) => !eventIds.has(event.id)),
  ];
  agent.capabilityCatalogMigrated = true;
}

function canonicalCatalogMarkerStatement(
  database: D1DatabaseLike,
  marker: string,
  siteAgentId: string,
  expectedReleaseId: string,
  expectedReleaseHash: string,
  now: string,
  expectedProjects: CapabilityProject[],
  expectedRevisions: CapabilityRevision[],
  technicalProjectIds: string[],
) {
  const expectedProjectJson = JSON.stringify(expectedProjects.map((project) => {
    const canonical = capabilityProjectForWrite(project);
    return { id: canonical.id, project: canonical };
  }));
  const expectedRevisionJson = JSON.stringify(expectedRevisions.map((revision) => ({
    id: revision.id,
    projectId: revision.projectId,
    number: revision.number,
    status: revision.status,
    revision,
  })));
  const markerSql = database.dialect === "postgres"
    ? `INSERT OR REPLACE INTO site_agent_v2_meta (key,value,updated_at)
      SELECT ?,?,?
      WHERE (SELECT active_release_id FROM site_agent_v2_agents WHERE id=?)=?
        AND EXISTS (
          SELECT 1 FROM site_agent_v2_releases
           WHERE id=? AND site_agent_id=? AND content_hash=?
        )
        AND NOT EXISTS (
          SELECT 1
            FROM jsonb_array_elements(?::jsonb) AS expected(value)
            LEFT JOIN site_agent_v2_capability_projects p
              ON p.id=(expected.value->>'id')
             AND p.site_agent_id=?
           WHERE p.id IS NULL
              OR p.stable_key IS NULL
              OR p.contract_fingerprint IS NULL
              OR p.stable_key IS DISTINCT FROM (expected.value->'project'->>'stableKey')
              OR p.contract_fingerprint IS DISTINCT FROM (expected.value->'project'->>'contractFingerprint')
              OR p.active_revision_id IS DISTINCT FROM (expected.value->'project'->>'activeRevisionId')
              OR p.latest_revision_id IS DISTINCT FROM (expected.value->'project'->>'latestRevisionId')
              OR p.status IS DISTINCT FROM (expected.value->'project'->>'status')
              OR p.project_json::jsonb IS DISTINCT FROM (expected.value->'project')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM jsonb_array_elements(?::jsonb) AS expected(value)
            LEFT JOIN site_agent_v2_capability_revisions r
              ON r.id=(expected.value->>'id')
             AND r.project_id=(expected.value->>'projectId')
             AND r.site_agent_id=?
           WHERE r.id IS NULL
              OR r.revision_number IS DISTINCT FROM (expected.value->>'number')::integer
              OR r.status IS DISTINCT FROM (expected.value->>'status')
              OR r.revision_json::jsonb IS DISTINCT FROM (expected.value->'revision')
        )
        AND NOT EXISTS (
          SELECT 1 FROM site_agent_v2_capability_projects p
           WHERE p.site_agent_id=?
             AND p.id IN (SELECT technical.value FROM jsonb_array_elements_text(?::jsonb) AS technical(value))
        )
        AND NOT EXISTS (
          SELECT 1 FROM site_agent_v2_capability_projects p
           WHERE p.site_agent_id=?
             AND (
               (p.active_revision_id IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM site_agent_v2_capability_revisions r
                  WHERE r.id=p.active_revision_id
                    AND r.project_id=p.id
                    AND r.site_agent_id=p.site_agent_id
                    AND r.status='published'
               ))
               OR
               (p.latest_revision_id IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM site_agent_v2_capability_revisions r
                  WHERE r.id=p.latest_revision_id
                    AND r.project_id=p.id
                    AND r.site_agent_id=p.site_agent_id
               ))
             )
        )`
    : `INSERT OR REPLACE INTO site_agent_v2_meta (key,value,updated_at)
      SELECT ?,?,?
      WHERE (SELECT active_release_id FROM site_agent_v2_agents WHERE id=?)=?
        AND EXISTS (
          SELECT 1 FROM site_agent_v2_releases
           WHERE id=? AND site_agent_id=? AND content_hash=?
        )
        AND NOT EXISTS (
          SELECT 1
            FROM json_each(?) expected
            LEFT JOIN site_agent_v2_capability_projects p
              ON p.id=json_extract(expected.value,'$.id')
             AND p.site_agent_id=?
           WHERE p.id IS NULL
              OR p.stable_key IS NULL
              OR p.contract_fingerprint IS NULL
              OR p.stable_key IS NOT json_extract(expected.value,'$.project.stableKey')
              OR p.contract_fingerprint IS NOT json_extract(expected.value,'$.project.contractFingerprint')
              OR p.active_revision_id IS NOT json_extract(expected.value,'$.project.activeRevisionId')
              OR p.latest_revision_id IS NOT json_extract(expected.value,'$.project.latestRevisionId')
              OR p.status IS NOT json_extract(expected.value,'$.project.status')
              OR json(p.project_json) IS NOT json(json_extract(expected.value,'$.project'))
        )
        AND NOT EXISTS (
          SELECT 1
            FROM json_each(?) expected
            LEFT JOIN site_agent_v2_capability_revisions r
              ON r.id=json_extract(expected.value,'$.id')
             AND r.project_id=json_extract(expected.value,'$.projectId')
             AND r.site_agent_id=?
           WHERE r.id IS NULL
              OR r.revision_number IS NOT json_extract(expected.value,'$.number')
              OR r.status IS NOT json_extract(expected.value,'$.status')
              OR json(r.revision_json) IS NOT json(json_extract(expected.value,'$.revision'))
        )
        AND NOT EXISTS (
          SELECT 1 FROM site_agent_v2_capability_projects p
           WHERE p.site_agent_id=?
             AND p.id IN (SELECT value FROM json_each(?))
        )
        AND NOT EXISTS (
          SELECT 1 FROM site_agent_v2_capability_projects p
           WHERE p.site_agent_id=?
             AND (
               (p.active_revision_id IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM site_agent_v2_capability_revisions r
                  WHERE r.id=p.active_revision_id
                    AND r.project_id=p.id
                    AND r.site_agent_id=p.site_agent_id
                    AND r.status='published'
               ))
               OR
               (p.latest_revision_id IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM site_agent_v2_capability_revisions r
                  WHERE r.id=p.latest_revision_id
                    AND r.project_id=p.id
                    AND r.site_agent_id=p.site_agent_id
               ))
             )
        )`;
  return database.prepare(markerSql)
    .bind(
      marker,
      CAPABILITY_MODEL_EPOCH,
      now,
      siteAgentId,
      expectedReleaseId,
      expectedReleaseId,
      siteAgentId,
      expectedReleaseHash,
      expectedProjectJson,
      siteAgentId,
      expectedRevisionJson,
      siteAgentId,
      siteAgentId,
      JSON.stringify(technicalProjectIds),
      siteAgentId,
    );
}

async function ensureCanonicalCapabilityCatalog(
  database: D1DatabaseLike,
  siteAgentId: string,
  attempt = 0,
) {
  const marker = capabilityModelMarker(siteAgentId);
  const markerRows = await all<{ value: string }>(database, `SELECT value FROM site_agent_v2_meta WHERE key=? LIMIT 1`, [marker]);
  if (markerRows[0]?.value === CAPABILITY_MODEL_EPOCH) return;

  const [activeReleaseRows, projectRows, revisionRows] = await Promise.all([
    all<{ releaseId: string; releaseJson: string }>(
      database,
      `SELECT r.id AS releaseId,r.release_json AS releaseJson
         FROM site_agent_v2_agents a
         JOIN site_agent_v2_releases r ON r.id=a.active_release_id
        WHERE a.id=? LIMIT 1`,
      [siteAgentId],
    ),
    all<CapabilityProjectRow>(database, `SELECT project_json AS projectJson FROM site_agent_v2_capability_projects WHERE site_agent_id=?`, [siteAgentId]),
    all<CapabilityRevisionRow & { id: string; projectId: string; revisionNumber: number | string }>(
      database,
      `SELECT id,project_id AS projectId,revision_number AS revisionNumber,revision_json AS revisionJson
         FROM site_agent_v2_capability_revisions WHERE site_agent_id=?`,
      [siteAgentId],
    ),
  ]);
  const activeReleaseRow = activeReleaseRows[0];
  if (!activeReleaseRow) throw new Error("site_agent_release_missing");
  const storedRelease = withAgentConfigDefaults(JSON.parse(activeReleaseRow.releaseJson) as SiteAgentReleaseV2);
  // Do not rehydrate an embedded historical row through d1Release here: that
  // helper may slim it in place. Migration publishes a new immutable Release
  // and leaves the previous Release JSON/hash byte-for-byte untouched.
  const materializedRelease = releaseEmbedsKnowledge(storedRelease)
    ? storedRelease
    : await rehydrateRelease(database, siteAgentId, storedRelease);
  // Canonicalization may change profile knowledge (for example generated task
  // templates) as well as the executable graph. Allocate that exact knowledge
  // revision before compiling the immutable snapshot so NavigationTool pins do
  // not change the next time the active Release is read and indexed.
  const initialCanonicalRelease = canonicalRelease(materializedRelease);
  const canonicalKnowledgeRevision = await persistKnowledgeRevision(
    database,
    siteAgentId,
    siteKnowledgeFromRelease(initialCanonicalRelease),
  );
  const canonicalizedRelease = canonicalRelease({
    ...initialCanonicalRelease,
    knowledgeRevision: canonicalKnowledgeRevision,
  });
  const canonicalReleaseChanged = JSON.stringify(canonicalizedRelease)
    !== JSON.stringify(materializedRelease);
  const now = new Date().toISOString();
  const nextReleaseVersion = canonicalReleaseChanged
    ? Number((await all<{ maxVersion: number | string | null }>(
        database,
        `SELECT MAX(version) AS maxVersion
           FROM site_agent_v2_releases
          WHERE site_agent_id=?`,
        [siteAgentId],
      ))[0]?.maxVersion ?? storedRelease.version) + 1
    : storedRelease.version;
  const release: SiteAgentReleaseV2 = canonicalReleaseChanged
    ? (() => {
        const identityHash = stableHash(JSON.stringify({
          sourceReleaseId: storedRelease.id,
          sourceContentHash: canonicalizedRelease.contentHash,
          knowledgeRevision: canonicalKnowledgeRevision,
        }));
        const cleanRelease = {
          ...canonicalizedRelease,
          id: `${siteAgentId}:release:${nextReleaseVersion}:canonical-${identityHash}`,
          version: nextReleaseVersion,
          createdAt: now,
        };
        const hashable = {
          ...cleanRelease,
          contentHash: undefined,
          knowledgeRevision: undefined,
        };
        return {
          ...cleanRelease,
          contentHash: stableHash(JSON.stringify(hashable)),
        };
      })()
    : canonicalizedRelease;
  const existingProjects = projectRows.map((row) => projectWithIdentityDefaults(JSON.parse(row.projectJson) as CapabilityProject));
  const existingProjectJson = new Map(projectRows.map((row) => {
    const project = JSON.parse(row.projectJson) as CapabilityProject;
    return [project.id, row.projectJson] as const;
  }));
  const existingRevisions = revisionRows.map((row) => {
    const revision = JSON.parse(row.revisionJson) as CapabilityRevision;
    return {
      id: row.id,
      projectId: row.projectId,
      number: Number(row.revisionNumber),
      revision,
    } satisfies CanonicalRevisionRecord;
  });
  const plan = prepareCanonicalCatalogPlan({
    siteAgentId,
    release,
    existingProjects,
    existingRevisions,
    migrationAt: now,
  });
  const statements = [];

  for (const project of plan.technicalProjects) {
    statements.push(
      // This is the sole identity-removal path: a one-time reclassification of
      // technical wrappers/duplicate receipts. Historical revisions/events are
      // deliberately retained.
      database.prepare(`DELETE FROM site_agent_v2_capability_projects
        WHERE id=? AND site_agent_id=? AND project_json=?
          AND (active_revision_id=? OR (active_revision_id IS NULL AND CAST(? AS TEXT) IS NULL))
          AND (latest_revision_id=? OR (latest_revision_id IS NULL AND CAST(? AS TEXT) IS NULL))
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_agents
             WHERE id=? AND active_release_id=?
          )`)
        .bind(
          project.id,
          siteAgentId,
          existingProjectJson.get(project.id)!,
          project.activeRevisionId || null,
          project.activeRevisionId || null,
          project.latestRevisionId || null,
          project.latestRevisionId || null,
          siteAgentId,
          activeReleaseRow.releaseId,
        ),
    );
    const event: CapabilityEvent = {
      id: `event_${stableHash(`${CAPABILITY_MODEL_EPOCH}:${project.id}`)}`,
      siteAgentId,
      projectId: project.id,
      type: "migration",
      actor: "release-gate",
      status: "passed",
      title: "技术包装已移出能力目录",
      summary: `${project.activeCapabilityId || project.id} 保留为历史证据或知识资产，不再作为 Capability。`,
      evidence: { modelEpoch: CAPABILITY_MODEL_EPOCH },
      createdAt: now,
    };
    statements.push(database.prepare(`INSERT OR IGNORE INTO site_agent_v2_capability_events
      (id,project_id,revision_id,site_agent_id,type,status,event_json,created_at)
      SELECT ?,?,?,?,?,?,?,?
      WHERE EXISTS (
        SELECT 1 FROM site_agent_v2_agents
         WHERE id=? AND active_release_id=?
      )
        AND NOT EXISTS (
          SELECT 1 FROM site_agent_v2_capability_projects
           WHERE id=? AND site_agent_id=?
        )`)
      .bind(
        event.id,
        event.projectId,
        null,
        event.siteAgentId,
        event.type,
        event.status,
        JSON.stringify(event),
        event.createdAt,
        siteAgentId,
        activeReleaseRow.releaseId,
        project.id,
        siteAgentId,
      ));
  }

  for (const project of plan.projects) {
    statements.push(plan.existingProjectIds.has(project.id)
      ? canonicalCapabilityProjectCompareAndSetStatement(
          database,
          existingProjectJson.get(project.id)!,
          project,
          activeReleaseRow.releaseId,
        )
      : canonicalCapabilityProjectMigrationInsertStatement(
          database,
          project,
          activeReleaseRow.releaseId,
        ));
  }
  const plannedProjectById = new Map(
    plan.projects.map((project) => [project.id, project] as const),
  );
  for (const revision of plan.newRevisions) {
    const expectedProject = plannedProjectById.get(revision.projectId);
    if (!expectedProject) throw new Error("canonical_capability_migration_project_missing");
    statements.push(canonicalCapabilityRevisionMigrationInsertStatement(
      database,
      revision,
      expectedProject,
      activeReleaseRow.releaseId,
    ));
  }
  for (const event of plan.conflictEvents) {
    statements.push(database.prepare(`INSERT OR IGNORE INTO site_agent_v2_capability_events
      (id,project_id,revision_id,site_agent_id,type,status,event_json,created_at)
      SELECT ?,?,?,?,?,?,?,?
      WHERE EXISTS (
        SELECT 1 FROM site_agent_v2_agents
         WHERE id=? AND active_release_id=?
      )
        AND EXISTS (
          SELECT 1 FROM site_agent_v2_capability_projects
           WHERE id=? AND site_agent_id=? AND project_json=?
        )`)
      .bind(
        event.id,
        event.projectId,
        null,
        event.siteAgentId,
        event.type,
        event.status,
        JSON.stringify(event),
        event.createdAt,
        siteAgentId,
        activeReleaseRow.releaseId,
        event.projectId,
        siteAgentId,
        JSON.stringify(capabilityProjectForWrite(
          plannedProjectById.get(event.projectId)!,
        )),
      ));
  }

  if (canonicalReleaseChanged) {
    const storedCleanRelease = releaseEmbedsKnowledge(storedRelease)
      ? release
      : stripReleaseKnowledge(release, siteKnowledgeFromRelease(release));
    statements.push(
      database.prepare(`INSERT OR IGNORE INTO site_agent_v2_releases
        (id,site_agent_id,version,content_hash,release_json,created_at)
        VALUES (?,?,?,?,?,?)`)
        .bind(
          release.id,
          siteAgentId,
          release.version,
          release.contentHash,
          JSON.stringify(storedCleanRelease),
          release.createdAt,
        ),
      database.prepare(`UPDATE site_agent_v2_agents
        SET profile_json=?,active_release_id=?,updated_at=?
        WHERE id=? AND active_release_id=?
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_releases
             WHERE id=? AND site_agent_id=? AND version=? AND content_hash=?
          )`)
        .bind(
          JSON.stringify(release.profile),
          release.id,
          now,
          siteAgentId,
          activeReleaseRow.releaseId,
          release.id,
          siteAgentId,
          release.version,
          release.contentHash,
        ),
      canonicalCatalogMarkerStatement(
        database,
        marker,
        siteAgentId,
        release.id,
        release.contentHash,
        now,
        plan.projects,
        plan.newRevisions,
        plan.technicalProjects.map((project) => project.id),
      ),
    );
  } else {
    statements.push(canonicalCatalogMarkerStatement(
      database,
      marker,
      siteAgentId,
      activeReleaseRow.releaseId,
      release.contentHash,
      now,
      plan.projects,
      plan.newRevisions,
      plan.technicalProjects.map((project) => project.id),
    ));
  }
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "canonical_capability_migration_failed");
  const completed = await all<{ value: string }>(
    database,
    `SELECT value FROM site_agent_v2_meta WHERE key=? LIMIT 1`,
    [marker],
  );
  if (completed[0]?.value !== CAPABILITY_MODEL_EPOCH) {
    if (attempt < 7) {
      return ensureCanonicalCapabilityCatalog(database, siteAgentId, attempt + 1);
    }
    throw new Error("canonical_capability_migration_incomplete");
  }
}

export async function reconcileCapabilityControl(siteAgentId: string) {
  const database = getD1Binding();
  if (!database) {
    const agent = memoryAgent(siteAgentId);
    ensureMemoryCanonicalCapabilityCatalog(siteAgentId);
    const projection = projectCapabilityControl({
      siteAgentId,
      release: agent.release,
      candidates: agent.candidates,
      learningJobs: agent.learningJobs,
      validationJobs: agent.validationJobs,
      browserRuns: agent.browserRuns,
      episodes: agent.episodes.map(episodeSummary),
    });
    const explicitById = new Map(agent.capabilityProjects.map((project) => [project.id, project] as const));
    const strictMemoryProject = (incoming: CapabilityProject) => {
      const exactId = explicitById.get(incoming.id);
      if (exactId && (
        sameCapabilityProjectIdentity(exactId, incoming)
        || Boolean(exactId.activeCapabilityId
          && exactId.activeCapabilityId === incoming.activeCapabilityId)
      )) return exactId;
      const matches = agent.capabilityProjects.filter((project) =>
        Boolean(project.activeCapabilityId
          && project.activeCapabilityId === incoming.activeCapabilityId)
        || sameCapabilityProjectIdentity(project, incoming));
      return matches.length === 1 ? matches[0] : undefined;
    };
    for (const incoming of projection.projects) {
      const previous = strictMemoryProject(incoming);
      if (!previous) continue;
      const projectionBlocked = previous.status === "archived"
        || previous.status === "unpublished"
        || previous.autoGenerationBlocked;
      const mayBindPublishedIdentity = !projectionBlocked
        && (sameCapabilityProjectIdentity(previous, incoming)
          || Boolean(previous.activeCapabilityId
            && previous.activeCapabilityId === incoming.activeCapabilityId));
      const updated = projectWithIdentityDefaults({
        ...previous,
        status: projectionBlocked
          ? previous.status
          : mayBindPublishedIdentity
            ? incoming.status
            : previous.status,
        stage: mayBindPublishedIdentity ? incoming.stage : previous.stage,
        activeCapabilityId: previous.activeCapabilityId
          || (mayBindPublishedIdentity ? incoming.activeCapabilityId : undefined),
        activeRevisionId: previous.activeRevisionId
          || (mayBindPublishedIdentity ? incoming.activeRevisionId : undefined),
        latestRevisionId: previous.latestRevisionId
          || (mayBindPublishedIdentity ? incoming.latestRevisionId : undefined),
        executionRequirements: incoming.executionRequirements,
        health: incoming.health,
        revisionCount: Math.max(previous.revisionCount, incoming.revisionCount),
        buildStartedAt: previous.buildStartedAt || incoming.buildStartedAt,
        updatedAt: incoming.updatedAt > previous.updatedAt ? incoming.updatedAt : previous.updatedAt,
      });
      agent.capabilityProjects = agent.capabilityProjects.map((project) => project.id === previous.id ? updated : project);
    }
    const currentIds = new Set(agent.capabilityProjects.map((project) => project.id));
    const remapProjectId = (projectId: string) => {
      const incoming = projection.projects.find((project) => project.id === projectId);
      if (!incoming) return undefined;
      const matched = strictMemoryProject(incoming);
      return matched && currentIds.has(matched.id) ? matched.id : undefined;
    };
    for (const incoming of projection.revisions) {
      const projectId = remapProjectId(incoming.projectId);
      if (!projectId) continue;
      const projectedRevision = projectId === incoming.projectId
        ? incoming
        : { ...incoming, projectId };
      const previous = agent.capabilityRevisions.find((item) =>
        item.id === projectedRevision.id);
      const revision = previous
        ? {
            ...projectedRevision,
            publicationProvenance: projectedRevision.publicationProvenance
              || previous.publicationProvenance,
            implementationReleaseId: projectedRevision.implementationReleaseId
              || previous.implementationReleaseId,
            implementationReleaseVersion: projectedRevision.implementationReleaseVersion
              ?? previous.implementationReleaseVersion,
            publishedReleaseId: projectedRevision.publishedReleaseId
              || previous.publishedReleaseId,
            publishedReleaseVersion: projectedRevision.publishedReleaseVersion
              ?? previous.publishedReleaseVersion,
            implementation: projectedRevision.implementation
              || previous.implementation,
          }
        : projectedRevision;
      const canonicalProject = explicitById.get(projectId);
      const publishedRevision = agent.capabilityRevisions.find((item) =>
        item.projectId === projectId && item.status === "published");
      if (revision.status === "published"
        && ((canonicalProject?.activeRevisionId && canonicalProject.activeRevisionId !== revision.id)
          || (publishedRevision && publishedRevision.id !== revision.id))) continue;
      if (previous?.status === "published") continue;
      agent.capabilityRevisions = [...agent.capabilityRevisions.filter((item) => item.id !== revision.id), revision];
    }
    for (const incoming of projection.events) {
      const projectId = remapProjectId(incoming.projectId);
      if (!projectId) continue;
      const event = projectId === incoming.projectId ? incoming : { ...incoming, projectId };
      if (!agent.capabilityEvents.some((item) => item.id === event.id)) agent.capabilityEvents.push(event);
    }
    return {
      projects: agent.capabilityProjects,
      revisions: agent.capabilityRevisions,
      events: agent.capabilityEvents.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      persistence: "memory" as const,
    };
  }
  await ensureSiteAgentV2Schema(database);
  await requireD1Agent(database, siteAgentId);
  await ensureCanonicalCapabilityCatalog(database, siteAgentId);
  const release = await d1Release(database, siteAgentId) || emptyRelease(siteAgentId);
  const [candidateRows, jobRows, validationRows, runRows, episodeRows] = await Promise.all([
    all<CandidateRow>(database, `SELECT candidate_json AS candidateJson FROM site_agent_v2_candidates WHERE site_agent_id=? ORDER BY updated_at DESC LIMIT 200`, [siteAgentId]),
    all<LearningJobRow>(database, `SELECT result_json AS jobJson FROM site_agent_v2_learning_jobs WHERE site_agent_id=? ORDER BY updated_at DESC LIMIT 200`, [siteAgentId]),
    all<ValidationJobRow>(database, `SELECT job_json AS jobJson FROM site_agent_v2_validation_jobs WHERE site_agent_id=? ORDER BY updated_at DESC LIMIT 200`, [siteAgentId]),
    all<BrowserRunRow>(database, `SELECT run_json AS runJson FROM site_agent_v2_browser_runs WHERE site_agent_id=? ORDER BY started_at DESC LIMIT 200`, [siteAgentId]),
    all<EpisodeSummaryRow>(database, `SELECT id, task_session_id AS taskSessionId, mode,
      json_extract(episode_json, '$.goal') AS goal, json_extract(episode_json, '$.capabilityId') AS capabilityId, json_extract(episode_json, '$.input') AS inputJson,
      json_extract(episode_json, '$.outcome') AS outcomeJson, started_at AS startedAt, ended_at AS endedAt,
      json_extract(episode_json, '$.startSnapshot.url') AS startUrl, json_extract(episode_json, '$.startSnapshot.title') AS startTitle, json_extract(episode_json, '$.startSnapshot.heading') AS startHeading,
      json_extract(episode_json, '$.endSnapshot.url') AS endUrl, json_extract(episode_json, '$.endSnapshot.title') AS endTitle, json_extract(episode_json, '$.endSnapshot.heading') AS endHeading
      FROM site_agent_v2_episodes WHERE site_agent_id=? ORDER BY ended_at DESC LIMIT 200`, [siteAgentId]),
  ]);
  const projection = projectCapabilityControl({
    siteAgentId,
    release,
    candidates: candidateRows.map((row) => JSON.parse(row.candidateJson) as KnowledgeCandidate),
    learningJobs: jobRows.map((row) => JSON.parse(row.jobJson) as LearningJob),
    validationJobs: validationRows.map((row) => JSON.parse(row.jobJson) as ValidationJob),
    browserRuns: runRows.map((row) => JSON.parse(row.runJson) as BrowserRun),
    episodes: episodeRows.map(episodeSummaryFromRow),
  });
  await persistCapabilityDerivedState(database, siteAgentId, release.id, projection);
  const [projectRows, revisionRows, eventRows] = await Promise.all([
    all<CapabilityProjectRow>(database, `SELECT project_json AS projectJson FROM site_agent_v2_capability_projects WHERE site_agent_id=? ORDER BY updated_at DESC,id`, [siteAgentId]),
    all<CapabilityRevisionRow>(database, `SELECT revision_json AS revisionJson FROM site_agent_v2_capability_revisions WHERE site_agent_id=? ORDER BY updated_at DESC`, [siteAgentId]),
    all<CapabilityEventRow>(database, `SELECT event_json AS eventJson FROM site_agent_v2_capability_events WHERE site_agent_id=? ORDER BY created_at DESC LIMIT 500`, [siteAgentId]),
  ]);
  return {
    projects: projectRows.map((row) => projectWithIdentityDefaults(JSON.parse(row.projectJson) as CapabilityProject)),
    revisions: revisionRows.map((row) => JSON.parse(row.revisionJson) as CapabilityRevision),
    events: eventRows.map((row) => JSON.parse(row.eventJson) as CapabilityEvent),
    persistence: "d1" as const,
  };
}

export async function listCapabilityProjects(
  siteAgentId: string,
  options: {
    status?: CapabilityProject["status"];
    excludeArchived?: boolean;
    duplicateCursor?: string;
  } = {},
) {
  const database = getD1Binding();
  if (!database) {
    const agent = memoryAgent(siteAgentId);
    const launches: TaskLaunch[] = agent.taskLaunches;
    const projects = agent.capabilityProjects
      .map(projectWithIdentityDefaults)
      .filter((project) => options.status ? project.status === options.status : !options.excludeArchived || project.status !== "archived")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
    const projectGoals = new Set(projects.flatMap((project) => [project.name, project.goalTemplate]).map(normalizeGoal));
    const navigationTasks = projectNavigationBuildTasks(
      launches,
      new Date(),
      agent.navigationBuildHeads,
    );
    const duplicatePage = duplicateLearningJobPage(agent.learningJobs, options.duplicateCursor);
    const activeLearningJobs = agent.learningJobs
      .filter((job) => ["queued", "leased", "running"].includes(job.status))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
      .slice(0, 200);
    const failedLearningJobs = agent.learningJobs
      .filter((job) => job.status === "failed" && job.failure?.code !== "duplicate_capability")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
      .slice(0, 200);
    const buildTasks = mergeCapabilityBuildTasks(
      [...activeLearningJobs, ...duplicatePage.jobs, ...failedLearningJobs],
      navigationTasks,
      projectGoals,
    );
    return {
      projects,
      total: projects.length,
      buildTasks,
      buildTaskPage: duplicatePage.buildTaskPage,
      persistence: "memory" as const,
    };
  }
  await ensureSiteAgentV2Schema(database);
  await requireD1Agent(database, siteAgentId);
  const conditions = ["site_agent_id=?"];
  const params: unknown[] = [siteAgentId];
  if (options.status) {
    conditions.push("status=?");
    params.push(options.status);
  } else if (options.excludeArchived) {
    conditions.push("status<>'archived'");
  }
  const where = conditions.join(" AND ");
  const duplicateCursor = parseDuplicateBuildTaskCursor(options.duplicateCursor);
  const duplicateCursorClause = duplicateCursor
    ? "AND (updated_at<? OR (updated_at=? AND id<?))"
    : "";
  const duplicateParams = duplicateCursor
    ? [siteAgentId, duplicateCursor.updatedAt, duplicateCursor.updatedAt, duplicateCursor.id]
    : [siteAgentId];
  const [
    rows,
    countRows,
    launchRows,
    buildHeadRows,
    activeLearningJobRows,
    duplicateLearningJobRows,
    failedLearningJobRows,
  ] = await Promise.all([
    all<CapabilityProjectRow>(
      database,
      `SELECT project_json AS projectJson FROM site_agent_v2_capability_projects WHERE ${where} ORDER BY updated_at DESC,id`,
      params,
    ),
    all<{ total: number }>(
      database,
      `SELECT COUNT(*) AS total FROM site_agent_v2_capability_projects WHERE ${where}`,
      params,
    ),
    all<Pick<TaskLaunchRow, "launchJson" | "status" | "updatedAt">>(
      database,
      `SELECT launch_json AS launchJson,status,updated_at AS updatedAt FROM site_agent_v2_task_launches
       WHERE site_agent_id=? AND project_id IS NULL AND capability_id IS NULL
         AND json_extract(launch_json, '$.mode')='demonstrate'
       ORDER BY created_at DESC LIMIT 200`,
      [siteAgentId],
    ),
    all<NavigationBuildHeadRow>(
      database,
      `SELECT intent_key AS intentKey,launch_id AS launchId
       FROM site_agent_v2_navigation_build_heads WHERE site_agent_id=?`,
      [siteAgentId],
    ),
    all<LearningJobRow>(
      database,
      `SELECT result_json AS jobJson FROM site_agent_v2_learning_jobs
        WHERE site_agent_id=? AND status IN ('queued','leased','running')
        ORDER BY updated_at DESC LIMIT 200`,
      [siteAgentId],
    ),
    all<LearningJobRow>(
      database,
      `SELECT result_json AS jobJson FROM site_agent_v2_learning_jobs
        WHERE site_agent_id=? AND status='failed'
          AND json_extract(result_json,'$.failure.code')='duplicate_capability'
          ${duplicateCursorClause}
        ORDER BY updated_at DESC,id DESC LIMIT ${DUPLICATE_BUILD_TASK_PAGE_SIZE + 1}`,
      duplicateParams,
    ),
    all<LearningJobRow>(
      database,
      `SELECT result_json AS jobJson FROM site_agent_v2_learning_jobs
        WHERE site_agent_id=? AND status='failed'
          AND COALESCE(json_extract(result_json,'$.failure.code'),'')<>'duplicate_capability'
        ORDER BY updated_at DESC LIMIT 200`,
      [siteAgentId],
    ),
  ]);
  const projects = rows.map((row) => projectWithIdentityDefaults(JSON.parse(row.projectJson) as CapabilityProject));
  const projectGoals = new Set(projects.flatMap((project) => [project.name, project.goalTemplate]).map(normalizeGoal));
  const navigationTasks = projectNavigationBuildTasks(
    launchRows.map(taskLaunchFromRow),
    new Date(),
    new Map(buildHeadRows.map((row) => [row.intentKey, row.launchId])),
  );
  const duplicatePageRows = duplicateLearningJobRows.slice(0, DUPLICATE_BUILD_TASK_PAGE_SIZE);
  const duplicatePageJobs = duplicatePageRows.map((row) => JSON.parse(row.jobJson) as LearningJob);
  const hasMoreDuplicates = duplicateLearningJobRows.length > duplicatePageRows.length;
  const learningJobs = new Map([
    ...activeLearningJobRows,
    ...duplicatePageRows,
    ...failedLearningJobRows,
  ].map((row) => {
    const job = JSON.parse(row.jobJson) as LearningJob;
    return [job.id, job] as const;
  }));
  const buildTasks = mergeCapabilityBuildTasks(
    [...learningJobs.values()],
    navigationTasks,
    projectGoals,
  );
  return {
    projects,
    total: Number(countRows[0]?.total || 0),
    buildTasks,
    buildTaskPage: {
      hasMoreDuplicates,
      nextDuplicateCursor: hasMoreDuplicates && duplicatePageJobs.length
        ? duplicateBuildTaskCursor(duplicatePageJobs[duplicatePageJobs.length - 1])
        : undefined,
    },
    persistence: "d1" as const,
  };
}

function duplicateBuildRequestJobId(buildRequestId: string) {
  const prefix = "build-request:";
  const normalized = buildRequestId.trim();
  if (!normalized.startsWith(prefix) || normalized.length === prefix.length) {
    throw new Error("capability_build_request_id_invalid");
  }
  return normalized.slice(prefix.length);
}

function assertDuplicateBuildRequestDismissible(job: LearningJob | undefined) {
  if (!job) throw new Error("capability_build_request_not_found");
  if (job.status !== "failed" || job.failure?.code !== "duplicate_capability") {
    throw new Error("capability_build_request_dismiss_not_allowed");
  }
}

export async function dismissDuplicateCapabilityBuildRequest(
  siteAgentId: string,
  buildRequestId: string,
) {
  const jobId = duplicateBuildRequestJobId(buildRequestId);
  const database = getD1Binding();
  const now = new Date().toISOString();
  if (!database) {
    const agent = memoryAgent(siteAgentId);
    const index = agent.learningJobs.findIndex((job) => job.id === jobId);
    const current = index >= 0 ? agent.learningJobs[index] : undefined;
    assertDuplicateBuildRequestDismissible(current);
    agent.learningJobs[index] = {
      ...current!,
      status: "cancelled",
      lease: undefined,
      updatedAt: now,
    };
    return { dismissed: true, buildRequestId, persistence: "memory" as const };
  }
  await ensureSiteAgentV2Schema(database);
  const rows = await all<LearningJobRow>(database,
    `SELECT result_json AS jobJson FROM site_agent_v2_learning_jobs
      WHERE id=? AND site_agent_id=? LIMIT 1`,
    [jobId, siteAgentId]);
  const observedJobJson = rows[0]?.jobJson;
  const current = observedJobJson
    ? JSON.parse(observedJobJson) as LearningJob
    : undefined;
  assertDuplicateBuildRequestDismissible(current);
  const dismissed: LearningJob = {
    ...current!,
    status: "cancelled",
    lease: undefined,
    updatedAt: now,
  };
  const result = await database.prepare(`UPDATE site_agent_v2_learning_jobs
    SET status='cancelled',result_json=?,updated_at=?
    WHERE id=? AND site_agent_id=? AND status='failed' AND result_json=?`)
    .bind(JSON.stringify(dismissed), now, jobId, siteAgentId, observedJobJson).run();
  if (!result.success) throw new Error(result.error || "capability_build_request_dismiss_failed");
  if (Number(result.meta?.changes || 0) !== 1) {
    throw new Error("capability_build_request_dismiss_conflict");
  }
  return { dismissed: true, buildRequestId, persistence: "d1" as const };
}

type CapabilityProjectDetailBeforeDeletion =
  Omit<CapabilityProjectDetail, "deletion">
  & { deletion?: CapabilityProjectDeletion };

function withRevisionScopes(
  detail: CapabilityProjectDetailBeforeDeletion,
): CapabilityProjectDetailBeforeDeletion {
  const activeRevision = detail.revisions.find((revision) => revision.id === detail.project.activeRevisionId)
    || detail.revisions.find((revision) => revision.status === "published");
  const isWorking = (revision: CapabilityRevision) =>
    revision.status === "building"
    || revision.status === "awaiting-review"
    || revision.status === "failed";
  const latestRevision = detail.revisions.find((revision) => revision.id === detail.project.latestRevisionId);
  const workingRevision = latestRevision && latestRevision.id !== activeRevision?.id && isWorking(latestRevision)
    ? latestRevision
    : detail.project.status !== "available"
      ? detail.revisions.find((revision) => revision.id !== activeRevision?.id && isWorking(revision))
      : undefined;
  return { ...detail, activeRevision, workingRevision };
}

function withPipelineStatus(
  detail: CapabilityProjectDetailBeforeDeletion,
  allJobs: LearningJob[],
): CapabilityProjectDetailBeforeDeletion {
  const projectJobs = allJobs.filter((job) => detail.revisions.some((revision) => revision.learningJobId === job.id));
  const preferredJobId = detail.workingRevision?.learningJobId;
  const activeJob = projectJobs.find((job) => job.id === preferredJobId)
    || (detail.project.status === "available" ? projectJobs.find((job) => job.id === detail.activeRevision?.learningJobId) : undefined)
    || projectJobs.toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]
    || detail.activeJob;
  const pipeline = allJobs
    .filter((job) => ["queued", "leased", "running"].includes(job.status))
    .toSorted((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const index = activeJob ? pipeline.findIndex((job) => job.id === activeJob.id) : -1;
  return {
    ...detail,
    activeJob,
    pipeline: index >= 0 ? {
      state: index === 0 ? "active" : "queued",
      position: index + 1,
      total: pipeline.length,
      ahead: index > 0 ? { jobId: pipeline[0].id, goalTemplate: pipeline[0].goalTemplate, phase: pipeline[0].phase } : undefined,
    } : { state: "terminal", position: 0, total: pipeline.length },
  };
}

const CAPABILITY_PROJECT_DELETION_HISTORY_KINDS = [
  "revisions",
  "reviews",
  "events",
  "capabilityRuns",
  "taskLaunches",
  "learningJobs",
  "candidates",
  "validationJobs",
  "browserRuns",
  "artifacts",
  "domReplayChunks",
  "modelInvocations",
  "authoringEvents",
  "specDocs",
  "authoringWorkspaces",
  "authoringGuidance",
  "suppressions",
  "rfcs",
  "contractProposals",
] as const satisfies readonly CapabilityProjectDeletionHistoryKind[];

function emptyCapabilityProjectDeletionCounts(): CapabilityProjectDeletion["counts"] {
  return Object.fromEntries(
    CAPABILITY_PROJECT_DELETION_HISTORY_KINDS.map((kind) => [kind, 0]),
  ) as CapabilityProjectDeletion["counts"];
}

function capabilityProjectDeletionFromCounts(
  project: CapabilityProject,
  counts: CapabilityProjectDeletion["counts"],
): CapabilityProjectDeletion {
  const blockers: CapabilityProjectDeletion["blockers"] = [];
  if (project.activeCapabilityId) blockers.push("activeCapability");
  if (project.activeRevisionId) blockers.push("activeRevision");
  if (project.status === "available" || project.status === "unpublished") {
    blockers.push("publishedLifecycle");
  }
  if (project.latestRevisionId || project.revisionCount > 0) {
    blockers.push("revisionPointer");
  }
  if (project.buildStartedAt) blockers.push("buildHistory");
  if (project.duplicateOf) blockers.push("duplicateReceipt");
  if (project.identityConflict) blockers.push("identityConflict");
  for (const kind of CAPABILITY_PROJECT_DELETION_HISTORY_KINDS) {
    if (counts[kind] > 0) blockers.push(kind);
  }
  return { allowed: blockers.length === 0, blockers, counts };
}

function memoryCapabilityProjectDeletion(
  agent: MemoryAgent,
  project: CapabilityProject,
): CapabilityProjectDeletion {
  const counts = emptyCapabilityProjectDeletionCounts();
  const revisions = agent.capabilityRevisions.filter((item) =>
    item.projectId === project.id);
  const revisionJobIds = new Set(revisions.flatMap((item) =>
    item.learningJobId ? [item.learningJobId] : []));
  const jobs = agent.learningJobs.filter((job) =>
    job.result?.projectId === project.id || revisionJobIds.has(job.id));
  const jobIds = new Set(jobs.map((job) => job.id));
  const candidateIds = new Set([
    ...jobs.map((job) => job.candidateId).filter(Boolean),
    ...revisions.flatMap((revision) =>
      revision.candidateId ? [revision.candidateId] : []),
  ]);
  const validationJobs = agent.validationJobs.filter((job) =>
    jobIds.has(job.learningJobId) || candidateIds.has(job.candidateId));
  const browserRuns = agent.browserRuns.filter((run) =>
    jobIds.has(run.learningJobId) || candidateIds.has(run.candidateId));
  const browserRunIds = new Set(browserRuns.map((run) => run.id));
  const sourceEpisodeIds = new Set(jobs.map((job) =>
    job.sourceEpisodeId).filter(Boolean));
  const artifacts = agent.artifacts.filter((artifact) =>
    jobIds.has(artifact.learningJobId) || browserRunIds.has(artifact.runId));

  counts.revisions = revisions.length;
  counts.reviews = agent.revisionReviews.filter((item) =>
    item.projectId === project.id).length;
  counts.events = agent.capabilityEvents.filter((item) =>
    item.projectId === project.id).length;
  counts.capabilityRuns = agent.capabilityRuns.filter((run) =>
    run.projectId === project.id).length;
  counts.taskLaunches = agent.taskLaunches.filter((launch) =>
    launch.projectId === project.id).length;
  counts.learningJobs = jobs.length;
  counts.candidates = agent.candidates.filter((candidate) =>
    candidateIds.has(candidate.id)).length;
  counts.validationJobs = validationJobs.length;
  counts.browserRuns = browserRuns.length;
  counts.artifacts = artifacts.length;
  counts.domReplayChunks = agent.domReplayChunks.filter((chunk) =>
    (chunk.runId && browserRunIds.has(chunk.runId))
    || (chunk.episodeId && sourceEpisodeIds.has(chunk.episodeId))).length;
  counts.modelInvocations = agent.modelCalls.filter((call) =>
    call.learningJobId && jobIds.has(call.learningJobId)).length;
  // Local runner activity has no separate authoring-event collection. Its
  // owning LearningJob already blocks deletion.
  counts.authoringEvents = 0;
  counts.specDocs = agent.specDocs.filter((spec) =>
    spec.projectId === project.id).length;
  counts.authoringWorkspaces = agent.authoringWorkspaces.filter((workspace) =>
    workspace.projectId === project.id
    || (workspace.learningJobId && jobIds.has(workspace.learningJobId))
    || (workspace.runId && browserRunIds.has(workspace.runId))).length;
  counts.authoringGuidance = agent.authoringGuidance.filter((guidance) =>
    guidance.projectId === project.id).length;
  counts.suppressions = agent.capabilitySuppressions.filter((suppression) =>
    suppression.projectId === project.id).length;
  // RFCs and contract proposals are currently durable only in D1. A synthetic
  // RFC rendered from a Revision is represented by the Revision count above.
  counts.rfcs = 0;
  counts.contractProposals = 0;
  return capabilityProjectDeletionFromCounts(project, counts);
}

type CapabilityProjectDeletionRelation = {
  kind: CapabilityProjectDeletionHistoryKind;
  sql: string;
  params: unknown[];
};

function d1CapabilityProjectDeletionRelations(
  siteAgentId: string,
  project: CapabilityProject,
): CapabilityProjectDeletionRelation[] {
  const ownedJob = (alias: string) => ({
    sql: `${alias}.site_agent_id=? AND (
      json_extract(${alias}.result_json,'$.result.projectId')=?
      OR json_extract(${alias}.result_json,'$.projectId')=?
      OR EXISTS (
        SELECT 1 FROM site_agent_v2_capability_revisions owned_revision
         WHERE owned_revision.site_agent_id=?
           AND owned_revision.project_id=?
           AND json_extract(owned_revision.revision_json,'$.learningJobId')=${alias}.id
      )
    )`,
    params: [siteAgentId, project.id, project.id, siteAgentId, project.id] as unknown[],
  });
  const ownedCandidate = (alias: string) => {
    const job = ownedJob("candidate_job");
    return {
      sql: `${alias}.site_agent_id=? AND (
        EXISTS (
          SELECT 1 FROM site_agent_v2_learning_jobs candidate_job
           WHERE ${job.sql}
             AND json_extract(candidate_job.result_json,'$.candidateId')=${alias}.id
        )
        OR EXISTS (
          SELECT 1 FROM site_agent_v2_capability_revisions candidate_revision
           WHERE candidate_revision.site_agent_id=?
             AND candidate_revision.project_id=?
             AND json_extract(candidate_revision.revision_json,'$.candidateId')=${alias}.id
        )
      )`,
      params: [siteAgentId, ...job.params, siteAgentId, project.id] as unknown[],
    };
  };
  const ownedBrowserRun = (alias: string) => {
    const job = ownedJob("browser_job");
    const candidate = ownedCandidate("browser_candidate");
    return {
      sql: `${alias}.site_agent_id=? AND (
        EXISTS (
          SELECT 1 FROM site_agent_v2_learning_jobs browser_job
           WHERE ${job.sql} AND browser_job.id=${alias}.learning_job_id
        )
        OR EXISTS (
          SELECT 1 FROM site_agent_v2_candidates browser_candidate
           WHERE ${candidate.sql} AND browser_candidate.id=${alias}.candidate_id
        )
      )`,
      params: [siteAgentId, ...job.params, ...candidate.params] as unknown[],
    };
  };
  const direct = (
    kind: CapabilityProjectDeletionHistoryKind,
    table: string,
    alias: string,
    predicate = `${alias}.project_id=?`,
    params: unknown[] = [project.id],
  ): CapabilityProjectDeletionRelation => ({
    kind,
    sql: `SELECT 1 FROM ${table} ${alias}
      WHERE ${alias}.site_agent_id=? AND ${predicate}`,
    params: [siteAgentId, ...params],
  });

  const job = ownedJob("owned_job");
  const candidate = ownedCandidate("owned_candidate");
  const validationJob = ownedJob("validation_job_owner");
  const validationCandidate = ownedCandidate("validation_candidate_owner");
  const browserRun = ownedBrowserRun("owned_browser_run");
  const artifactJob = ownedJob("artifact_job_owner");
  const artifactRun = ownedBrowserRun("artifact_run_owner");
  const replayRun = ownedBrowserRun("replay_run_owner");
  const replayJob = ownedJob("replay_job_owner");
  const modelJob = ownedJob("model_job_owner");
  const authoringJob = ownedJob("authoring_job_owner");
  const workspaceJob = ownedJob("workspace_job_owner");
  const workspaceRun = ownedBrowserRun("workspace_run_owner");

  return [
    direct("revisions", "site_agent_v2_capability_revisions", "history_revision"),
    direct("reviews", "site_agent_v2_revision_reviews", "history_review"),
    direct("events", "site_agent_v2_capability_events", "history_event"),
    direct("capabilityRuns", "site_agent_v2_capability_runs", "history_capability_run"),
    direct("taskLaunches", "site_agent_v2_task_launches", "history_task_launch"),
    {
      kind: "learningJobs",
      sql: `SELECT 1 FROM site_agent_v2_learning_jobs owned_job WHERE ${job.sql}`,
      params: job.params,
    },
    {
      kind: "candidates",
      sql: `SELECT 1 FROM site_agent_v2_candidates owned_candidate WHERE ${candidate.sql}`,
      params: candidate.params,
    },
    {
      kind: "validationJobs",
      sql: `SELECT 1 FROM site_agent_v2_validation_jobs history_validation
        WHERE history_validation.site_agent_id=? AND (
          EXISTS (
            SELECT 1 FROM site_agent_v2_learning_jobs validation_job_owner
             WHERE ${validationJob.sql}
               AND validation_job_owner.id=history_validation.learning_job_id
          )
          OR EXISTS (
            SELECT 1 FROM site_agent_v2_candidates validation_candidate_owner
             WHERE ${validationCandidate.sql}
               AND validation_candidate_owner.id=history_validation.candidate_id
          )
        )`,
      params: [siteAgentId, ...validationJob.params, ...validationCandidate.params],
    },
    {
      kind: "browserRuns",
      sql: `SELECT 1 FROM site_agent_v2_browser_runs owned_browser_run
        WHERE ${browserRun.sql}`,
      params: browserRun.params,
    },
    {
      kind: "artifacts",
      sql: `SELECT 1 FROM site_agent_v2_artifacts history_artifact
        WHERE history_artifact.site_agent_id=? AND (
          EXISTS (
            SELECT 1 FROM site_agent_v2_learning_jobs artifact_job_owner
             WHERE ${artifactJob.sql}
               AND artifact_job_owner.id=history_artifact.learning_job_id
          )
          OR EXISTS (
            SELECT 1 FROM site_agent_v2_browser_runs artifact_run_owner
             WHERE ${artifactRun.sql}
               AND artifact_run_owner.id=history_artifact.run_id
          )
        )`,
      params: [siteAgentId, ...artifactJob.params, ...artifactRun.params],
    },
    {
      kind: "domReplayChunks",
      sql: `SELECT 1 FROM site_agent_v2_dom_replay_chunks history_replay
        WHERE history_replay.site_agent_id=? AND (
          EXISTS (
            SELECT 1 FROM site_agent_v2_browser_runs replay_run_owner
             WHERE ${replayRun.sql}
               AND replay_run_owner.id=history_replay.run_id
          )
          OR EXISTS (
            SELECT 1 FROM site_agent_v2_learning_jobs replay_job_owner
             WHERE ${replayJob.sql}
               AND json_extract(replay_job_owner.result_json,'$.sourceEpisodeId')=history_replay.episode_id
          )
        )`,
      params: [siteAgentId, ...replayRun.params, ...replayJob.params],
    },
    {
      kind: "modelInvocations",
      sql: `SELECT 1 FROM site_agent_v2_model_invocations history_model
        WHERE history_model.site_agent_id=? AND EXISTS (
          SELECT 1 FROM site_agent_v2_learning_jobs model_job_owner
           WHERE ${modelJob.sql}
             AND model_job_owner.id=history_model.learning_job_id
        )`,
      params: [siteAgentId, ...modelJob.params],
    },
    {
      kind: "authoringEvents",
      sql: `SELECT 1 FROM site_agent_v2_codex_authoring_events history_authoring
        WHERE history_authoring.site_agent_id=? AND EXISTS (
          SELECT 1 FROM site_agent_v2_learning_jobs authoring_job_owner
           WHERE ${authoringJob.sql}
             AND authoring_job_owner.id=history_authoring.learning_job_id
        )`,
      params: [siteAgentId, ...authoringJob.params],
    },
    direct("specDocs", "site_agent_v2_capability_spec_docs", "history_spec"),
    {
      kind: "authoringWorkspaces",
      sql: `SELECT 1 FROM site_agent_v2_authoring_workspaces history_workspace
        WHERE history_workspace.site_agent_id=? AND (
          history_workspace.project_id=?
          OR EXISTS (
            SELECT 1 FROM site_agent_v2_learning_jobs workspace_job_owner
             WHERE ${workspaceJob.sql}
               AND workspace_job_owner.id=history_workspace.learning_job_id
          )
          OR EXISTS (
            SELECT 1 FROM site_agent_v2_browser_runs workspace_run_owner
             WHERE ${workspaceRun.sql}
               AND workspace_run_owner.id=history_workspace.run_id
          )
        )`,
      params: [siteAgentId, project.id, ...workspaceJob.params, ...workspaceRun.params],
    },
    direct("authoringGuidance", "site_agent_v2_authoring_guidance", "history_guidance"),
    direct(
      "suppressions",
      "site_agent_v2_capability_suppressions",
      "history_suppression",
      "json_extract(history_suppression.suppression_json,'$.projectId')=?",
    ),
    {
      kind: "rfcs",
      sql: `SELECT 1 FROM site_agent_v2_capability_rfcs history_rfc
        WHERE history_rfc.site_agent_id=? AND history_rfc.intent_key=?`,
      params: [siteAgentId, project.intentKey],
    },
    {
      kind: "contractProposals",
      sql: `SELECT 1 FROM site_agent_v2_contract_proposals history_proposal
        WHERE history_proposal.site_agent_id=? AND history_proposal.rfc_id IN (
          SELECT id FROM site_agent_v2_capability_rfcs
           WHERE site_agent_id=? AND intent_key=?
        )`,
      params: [siteAgentId, siteAgentId, project.intentKey],
    },
  ];
}

async function d1CapabilityProjectDeletion(
  database: D1DatabaseLike,
  siteAgentId: string,
  project: CapabilityProject,
): Promise<CapabilityProjectDeletion> {
  const counts = emptyCapabilityProjectDeletionCounts();
  await Promise.all(d1CapabilityProjectDeletionRelations(siteAgentId, project)
    .map(async (relation) => {
      const rows = await all<{ total: number | string }>(
        database,
        `SELECT COUNT(*) AS total FROM (${relation.sql}) deletion_history`,
        relation.params,
      );
      counts[relation.kind] = Number(rows[0]?.total || 0);
    }));
  return capabilityProjectDeletionFromCounts(project, counts);
}

function capabilityContractFromProject(project: CapabilityProject): CapabilityDefinition {
  return {
    id: project.canonicalCapabilityId
      || project.activeCapabilityId
      || `capability_${stableHash(project.id)}`,
    origin: project.origin,
    kind: project.kind,
    resultKind: project.resultKind,
    exposure: project.exposure,
    name: project.name,
    description: project.description,
    normalizedGoal: normalizeGoal(project.goalTemplate || project.name),
    goalTemplate: project.goalTemplate,
    aliases: [],
    inputs: project.inputSchema,
    outputs: project.outputSchema,
    outcomes: [],
    plans: [],
    sourceEpisodeIds: [],
    confidence: project.status === "available" ? 1 : 0,
    status: project.status === "available" ? "available" : "learning",
    updatedAt: project.updatedAt,
  };
}

function readableRevisionContract(
  project: CapabilityProject,
  revision: CapabilityRevision,
  published?: CapabilityDefinition,
) {
  const contract = revision.contract
    || (revision.id === project.activeRevisionId ? published : undefined)
    || published
    || capabilityContractFromProject(project);
  const implementation = revision.implementation;
  const moduleRef = implementation?.kind === "program"
    ? implementation.moduleRef
    : implementation?.kind === "module"
      ? implementation.module
      : undefined;
  // CapabilityDefinition.module is a runtime compatibility projection. The
  // canonical owner remains the Revision; rebuilding a public release (for
  // example after unpublish/relist) must project that exact pinned module
  // instead of silently restoring a contract with no executable program.
  return moduleRef ? { ...contract, module: moduleRef } : contract;
}

function rfcFromRevision(project: CapabilityProject, inputRevision: CapabilityRevision): CapabilityRFC {
  const contract = readableRevisionContract(project, inputRevision);
  const revision = { ...inputRevision, contract };
  const implementationStrategy = revision.implementation
    ? "codex-authoring" as const
    : revision.contract.plans.length ? "existing-assets" as const : "codex-authoring" as const;
  return {
    id: `rfc_${stableHash(`${project.id}:${revision.number}`)}`,
    siteAgentId: project.siteAgentId,
    version: revision.number,
    decision: revision.number > 1 || project.activeRevisionId ? "enhance" : "create",
    intentKey: project.intentKey,
    goalTemplate: revision.contract.goalTemplate || revision.contract.name,
    inputs: revision.contract.inputs,
    requiredOutputs: { ...revision.contract.outputs, properties: Object.fromEntries(Object.entries(revision.contract.outputs.properties || {}).filter(([key]) => revision.contract.outputs.required?.includes(key))), required: revision.contract.outputs.required || [] },
    optionalOutputs: { ...revision.contract.outputs, properties: Object.fromEntries(Object.entries(revision.contract.outputs.properties || {}).filter(([key]) => !revision.contract.outputs.required?.includes(key))), required: [] },
    legalOutcomes: revision.contract.outcomes.map((outcome) => ({ status: outcome.status, description: outcome.description })),
    parameterization: revision.parameterizationDecisions,
    reusedAssets: revision.contract.plans.flatMap((plan) => plan.steps.map((step) => ({ kind: "operation" as const, id: step.operationId, reason: "复用已验证的网站操作" }))),
    acceptanceCases: [{ id: `acceptance_${stableHash(revision.id)}`, name: "独立浏览器重放", input: revision.validation?.input || {}, expectedOutcome: "success", startSceneId: revision.contract.plans[0]?.entrySceneIds[0] }],
    implementationStrategy,
    evidenceRefs: revision.contract.sourceEpisodeIds,
    rationale: revision.implementation ? "现有资产不足，由独立 Program Author 编写并验证实现。" : revision.contract.plans.length ? "已有验证资产可以直接组合，无需启动 Coding Agent。" : "等待 Program Author 补齐实现。",
    createdAt: revision.createdAt,
  };
}

export async function getCapabilityProjectDetail(siteAgentId: string, projectId: string): Promise<{ detail?: CapabilityProjectDetail; persistence: "memory" | "d1" }> {
  const database = getD1Binding();
  if (!database) {
    const agent = memoryAgent(siteAgentId);
    const project = agent.capabilityProjects
      .map(projectWithIdentityDefaults)
      .find((item) => item.id === projectId);
    if (!project) return { persistence: "memory" };
    const publishedContract = project.activeCapabilityId
      ? agent.release.capabilities.find((capability) => capability.id === project.activeCapabilityId)
      : undefined;
    const revisions = agent.capabilityRevisions
      .filter((item) => item.projectId === projectId)
      .sort((a, b) => b.number - a.number)
      .map((revision) => ({
        ...revision,
        contract: readableRevisionContract(project, revision, publishedContract),
    }));
    const jobIds = new Set(revisions.flatMap((item) => item.learningJobId ? [item.learningJobId] : []));
    const capabilityRuns = agent.capabilityRuns
      .filter((item) => item.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50);
    const executionLearningJobIds = new Set(
      capabilityRuns.map((item) => `capability_run:${item.id}`),
    );
    const executionBrowserRunIds = new Set(capabilityRuns.flatMap((item) =>
      item.completionReceipt?.browserRunId ? [item.completionReceipt.browserRunId] : []));
    const capabilityArtifactIds = new Set(
      capabilityRuns.flatMap((item) => item.artifactIds || []),
    );
    const browserRuns = agent.browserRuns.filter((item) =>
      jobIds.has(item.learningJobId)
      || executionLearningJobIds.has(item.learningJobId)
      || executionBrowserRunIds.has(item.id));
    const browserRunIds = new Set(browserRuns.map((item) => item.id));
    const artifacts = agent.artifacts.filter((item) =>
      jobIds.has(item.learningJobId)
      || executionLearningJobIds.has(item.learningJobId)
      || browserRunIds.has(item.runId)
      || capabilityArtifactIds.has(item.id));
    const scoped = withPipelineStatus(withRevisionScopes({
      project,
      revisions,
      reviews: agent.revisionReviews.filter((item) =>
        item.projectId === projectId).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt)),
      events: agent.capabilityEvents.filter((item) =>
        item.projectId === projectId).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt)),
      capabilityRuns,
      browserRuns,
      artifacts,
      activeJob: agent.learningJobs.filter((item) =>
        jobIds.has(item.id)).sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt))[0],
      validationJobs: agent.validationJobs.filter((item) =>
        jobIds.has(item.learningJobId)),
      modelCalls: agent.modelCalls.filter((item) =>
        item.learningJobId && jobIds.has(item.learningJobId)),
    }), agent.learningJobs);
    const memorySourceEpisodeIds = [...new Set((scoped.sourceEpisodes || []).map((episode) => episode.id).concat(revisions.flatMap((revision) => revision.contract.sourceEpisodeIds || [])))].slice(0, 16);
    const memoryRunIds = new Set((scoped.browserRuns || []).map((run) => run.id));
    const memoryReplayChunks = agent.domReplayChunks.filter((chunk) => (chunk.episodeId && memorySourceEpisodeIds.includes(chunk.episodeId)) || (chunk.runId && memoryRunIds.has(chunk.runId))).sort((a, b) => a.seqStart - b.seqStart);
    const memorySpecDoc = await getLatestCapabilitySpecDoc(siteAgentId, projectId);
    const memoryWorkspaces = await getAuthoringWorkspacesForProject(siteAgentId, projectId);
    const deletion = memoryCapabilityProjectDeletion(agent, project);
    return {
      detail: projectPublicCapabilityDetail({
        ...scoped,
        deletion,
        domReplayChunks: memoryReplayChunks,
        specDoc: memorySpecDoc,
        authoringWorkspaces: memoryWorkspaces,
        rfc: scoped.workingRevision || scoped.activeRevision
          ? rfcFromRevision(project, (scoped.workingRevision || scoped.activeRevision)!)
          : undefined,
      }),
      persistence: "memory",
    };
  }
  await ensureSiteAgentV2Schema(database);
  const projectRows = await all<CapabilityProjectRow>(database, `SELECT project_json AS projectJson FROM site_agent_v2_capability_projects WHERE id=? AND site_agent_id=? LIMIT 1`, [projectId, siteAgentId]);
  if (!projectRows[0]) return { persistence: "d1" };
  const release = await d1Release(database, siteAgentId) || emptyRelease(siteAgentId);
  const project = projectWithPublishedContract(JSON.parse(projectRows[0].projectJson) as CapabilityProject, release);
  const d1 = getD1Binding()!;
  const [revisionRows, reviewRows, eventRows, capabilityRunRows, runRows, artifactRows, jobRows, validationRows, modelRows, authoringEventRows, proposalRows] = await Promise.all([
    all<CapabilityRevisionRow>(d1, `SELECT revision_json AS revisionJson FROM site_agent_v2_capability_revisions WHERE site_agent_id=? AND project_id=? ORDER BY revision_number DESC`, [siteAgentId, projectId]),
    all<RevisionReviewRow>(d1, `SELECT review_json AS reviewJson FROM site_agent_v2_revision_reviews WHERE site_agent_id=? AND project_id=? ORDER BY created_at DESC`, [siteAgentId, projectId]),
    all<CapabilityEventRow>(d1, `SELECT event_json AS eventJson FROM site_agent_v2_capability_events WHERE site_agent_id=? AND project_id=? ORDER BY created_at DESC LIMIT 200`, [siteAgentId, projectId]),
    all<CapabilityRunRow>(d1, `SELECT run_json AS runJson FROM site_agent_v2_capability_runs WHERE site_agent_id=? AND project_id=? ORDER BY created_at DESC LIMIT 50`, [siteAgentId, projectId]),
    all<BrowserRunRow>(d1, `SELECT r.run_json AS runJson
      FROM site_agent_v2_browser_runs r
      WHERE r.site_agent_id=? AND (
        EXISTS (
          SELECT 1 FROM site_agent_v2_capability_revisions v
           WHERE v.site_agent_id=? AND v.project_id=?
             AND json_extract(v.revision_json,'$.learningJobId')=r.learning_job_id
        )
        OR EXISTS (
          SELECT 1 FROM site_agent_v2_capability_runs capability_run
           WHERE capability_run.site_agent_id=? AND capability_run.project_id=?
             AND (
               json_extract(capability_run.run_json,'$.completionReceipt.browserRunId')=r.id
               OR r.learning_job_id=('capability_run:' || capability_run.id)
             )
        )
      )
      ORDER BY r.started_at DESC LIMIT 50`,
    [siteAgentId, siteAgentId, projectId, siteAgentId, projectId]),
    all<ArtifactRow>(d1, `SELECT a.artifact_json AS artifactJson
      FROM site_agent_v2_artifacts a
      WHERE a.site_agent_id=? AND (
        EXISTS (
          SELECT 1 FROM site_agent_v2_capability_revisions v
           WHERE v.site_agent_id=? AND v.project_id=?
             AND json_extract(v.revision_json,'$.learningJobId')=a.learning_job_id
        )
        OR EXISTS (
          SELECT 1 FROM site_agent_v2_capability_runs capability_run
           WHERE capability_run.site_agent_id=? AND capability_run.project_id=?
             AND (
               a.learning_job_id=('capability_run:' || capability_run.id)
               OR a.run_id=json_extract(capability_run.run_json,'$.completionReceipt.browserRunId')
             )
        )
      )
      ORDER BY a.created_at DESC LIMIT 100`,
    [siteAgentId, siteAgentId, projectId, siteAgentId, projectId]),
    all<LearningJobRow>(d1, `SELECT j.result_json AS jobJson FROM site_agent_v2_learning_jobs j JOIN site_agent_v2_capability_revisions v ON json_extract(v.revision_json,'$.learningJobId')=j.id WHERE v.site_agent_id=? AND v.project_id=? ORDER BY j.updated_at DESC LIMIT 20`, [siteAgentId, projectId]),
    all<ValidationJobRow>(d1, `SELECT j.job_json AS jobJson FROM site_agent_v2_validation_jobs j JOIN site_agent_v2_capability_revisions v ON json_extract(v.revision_json,'$.learningJobId')=j.learning_job_id WHERE v.site_agent_id=? AND v.project_id=? ORDER BY j.updated_at DESC LIMIT 20`, [siteAgentId, projectId]),
    all<ModelInvocationRow>(d1, `SELECT m.invocation_json AS invocationJson FROM site_agent_v2_model_invocations m JOIN site_agent_v2_capability_revisions v ON json_extract(v.revision_json,'$.learningJobId')=m.learning_job_id WHERE v.site_agent_id=? AND v.project_id=? ORDER BY m.started_at DESC LIMIT 100`, [siteAgentId, projectId]),
    all<{ eventJson: string }>(d1, `SELECT e.event_json AS eventJson FROM site_agent_v2_codex_authoring_events e JOIN site_agent_v2_capability_revisions v ON json_extract(v.revision_json,'$.learningJobId')=e.learning_job_id WHERE v.site_agent_id=? AND v.project_id=? ORDER BY e.created_at DESC LIMIT 200`, [siteAgentId, projectId]),
    all<{ proposalJson: string }>(d1, `SELECT p.proposal_json AS proposalJson FROM site_agent_v2_contract_proposals p JOIN site_agent_v2_capability_rfcs r ON r.id=p.rfc_id WHERE r.site_agent_id=? AND r.intent_key=? ORDER BY p.created_at DESC LIMIT 100`, [siteAgentId, project.intentKey]),
  ]);
  const publishedContract = project.activeCapabilityId ? release.capabilities.find((capability) => capability.id === project.activeCapabilityId) : undefined;
  const revisions = revisionRows.map((row) => {
    const revision = JSON.parse(row.revisionJson) as CapabilityRevision;
    return {
      ...revision,
      contract: readableRevisionContract(project, revision, publishedContract),
    };
  });
  const sourceEpisodeIds = [...new Set(revisions.flatMap((revision) => revision.contract.sourceEpisodeIds || []))].slice(0, 8);
  const sourceEpisodeRows = sourceEpisodeIds.length
    ? await all<{ episodeJson: string }>(d1, `SELECT episode_json AS episodeJson FROM site_agent_v2_episodes WHERE site_agent_id=? AND id IN (${sourceEpisodeIds.map(() => "?").join(",")}) ORDER BY ended_at DESC`, [siteAgentId, ...sourceEpisodeIds])
    : [];
  const domReplayChunkRows = sourceEpisodeIds.length
    ? await all<{ chunkJson: string }>(d1, `SELECT chunk_json AS chunkJson FROM site_agent_v2_dom_replay_chunks WHERE site_agent_id=? AND episode_id IN (${sourceEpisodeIds.map(() => "?").join(",")}) ORDER BY seq_start ASC LIMIT 400`, [siteAgentId, ...sourceEpisodeIds])
    : [];
  const domReplayEpisodeChunks = domReplayChunkRows.map((row) => JSON.parse(row.chunkJson) as DomReplayChunk);
  const projectRunIds = [...new Set(runRows.map((row) => (JSON.parse(row.runJson) as BrowserRun).id))].slice(0, 24);
  const runReplayRows = projectRunIds.length
    ? await all<{ chunkJson: string }>(d1, `SELECT chunk_json AS chunkJson FROM site_agent_v2_dom_replay_chunks WHERE site_agent_id=? AND run_id IN (${projectRunIds.map(() => "?").join(",")}) ORDER BY seq_start ASC LIMIT 400`, [siteAgentId, ...projectRunIds])
    : [];
  const domReplayChunks = [...domReplayEpisodeChunks, ...runReplayRows.map((row) => JSON.parse(row.chunkJson) as DomReplayChunk)];
  const pipelineJobRows = await all<LearningJobRow>(d1, `SELECT result_json AS jobJson FROM site_agent_v2_learning_jobs WHERE status IN ('queued','leased','running') ORDER BY created_at LIMIT 100`);
  const scoped = withPipelineStatus(withRevisionScopes({ project, revisions, reviews: reviewRows.map((row) => JSON.parse(row.reviewJson) as RevisionReview), events: eventRows.map((row) => JSON.parse(row.eventJson) as CapabilityEvent), capabilityRuns: capabilityRunRows.map((row) => JSON.parse(row.runJson) as CapabilityRun), browserRuns: runRows.map((row) => JSON.parse(row.runJson) as BrowserRun), artifacts: artifactRows.map((row) => JSON.parse(row.artifactJson) as BrowserArtifact), activeJob: jobRows[0] ? JSON.parse(jobRows[0].jobJson) as LearningJob : undefined, validationJobs: validationRows.map((row) => JSON.parse(row.jobJson) as ValidationJob), modelCalls: modelRows.map((row) => JSON.parse(row.invocationJson) as ModelInvocation), authoringEvents: authoringEventRows.map((row) => JSON.parse(row.eventJson) as CodexAuthoringEvent), contractProposals: proposalRows.map((row) => JSON.parse(row.proposalJson) as ContractChangeProposal), sourceEpisodes: sourceEpisodeRows.map((row) => JSON.parse(row.episodeJson) as TaskEpisode) }), [...pipelineJobRows.map((row) => JSON.parse(row.jobJson) as LearningJob), ...jobRows.map((row) => JSON.parse(row.jobJson) as LearningJob)]);
  const fallbackRfc = scoped.workingRevision || scoped.activeRevision ? rfcFromRevision(project, (scoped.workingRevision || scoped.activeRevision)!) : undefined;
  const rfcRows = await all<{ rfcJson: string }>(d1, `SELECT rfc_json AS rfcJson FROM site_agent_v2_capability_rfcs WHERE site_agent_id=? AND intent_key=? ORDER BY version DESC LIMIT 1`, [siteAgentId, project.intentKey]);
  const [specDoc, authoringWorkspaces, deletion] = await Promise.all([
    getLatestCapabilitySpecDoc(siteAgentId, projectId, d1),
    getAuthoringWorkspacesForProject(siteAgentId, projectId, d1),
    d1CapabilityProjectDeletion(d1, siteAgentId, project),
  ]);
  return {
    detail: projectPublicCapabilityDetail({
      ...scoped,
      deletion,
      domReplayChunks,
      specDoc,
      authoringWorkspaces,
      rfc: rfcRows[0] ? JSON.parse(rfcRows[0].rfcJson) as CapabilityRFC : fallbackRfc,
    }),
    persistence: "d1",
  };
}

type ContractPatch = { goalTemplate?: string; name?: string; description?: string; inputs?: CapabilityDefinition["inputs"]; outputs?: CapabilityDefinition["outputs"]; outcomes?: CapabilityDefinition["outcomes"]; resultKind?: CapabilityDefinition["resultKind"] };

function assertStableCapabilityIdentity(
  project: CapabilityProject,
  contract: CapabilityDefinition,
  currentOutcomes?: CapabilityDefinition["outcomes"],
) {
  const currentContractFingerprint = capabilityContractFingerprint({
    kind: project.kind,
    resultKind: project.resultKind,
    structure: project.structure,
    operation: project.operation,
    inputs: project.inputSchema,
    outputs: project.outputSchema,
  });
  const proposedContractFingerprint = capabilityContractFingerprint({
    kind: contract.kind,
    resultKind: contract.resultKind,
    structure: project.structure,
    operation: project.operation,
    inputs: contract.inputs,
    outputs: contract.outputs,
  });
  if (currentContractFingerprint !== proposedContractFingerprint) {
    throw new Error("capability_contract_immutable");
  }
  const currentGoal = normalizeGoal(project.goalTemplate || project.name);
  const proposedGoal = normalizeGoal(contract.goalTemplate || contract.name);
  if (currentGoal !== proposedGoal) {
    throw new Error("capability_identity_immutable");
  }
  // Outcome descriptions are presentation copy. IDs, statuses, codes and
  // classifiers define the stable business-effect boundary.
  const effectBoundary = (outcomes: CapabilityDefinition["outcomes"]) =>
    JSON.stringify(outcomes.map((outcome) => ({
      id: outcome.id,
      status: outcome.status,
      code: outcome.code,
      classifiers: outcome.classifiers,
    })));
  if (currentOutcomes
    && effectBoundary(currentOutcomes) !== effectBoundary(contract.outcomes)) {
    throw new Error("capability_effect_boundary_immutable");
  }
}

async function sourceEpisodeForProject(database: D1DatabaseLike, project: CapabilityProject, contract: CapabilityDefinition) {
  const ids = contract.sourceEpisodeIds || [];
  if (ids.length) {
    const rows = await all<{ episodeJson: string }>(database, `SELECT episode_json AS episodeJson FROM site_agent_v2_episodes WHERE site_agent_id=? AND id IN (${ids.map(() => "?").join(",")}) ORDER BY ended_at DESC LIMIT 1`, [project.siteAgentId, ...ids]);
    if (rows[0]) return JSON.parse(rows[0].episodeJson) as TaskEpisode;
  }
  const goals = [...new Set([contract.normalizedGoal, normalizeGoal(contract.name), normalizeGoal(contract.goalTemplate || ""), ...contract.aliases.map(normalizeGoal)].filter(Boolean))];
  if (!goals.length) return undefined;
  const rows = await all<{ episodeJson: string }>(database, `SELECT episode_json AS episodeJson FROM site_agent_v2_episodes WHERE site_agent_id=? AND outcome_status='success' AND normalized_goal IN (${goals.map(() => "?").join(",")}) ORDER BY ended_at DESC LIMIT 1`, [project.siteAgentId, ...goals]);
  return rows[0] ? JSON.parse(rows[0].episodeJson) as TaskEpisode : undefined;
}

function validateProjectContract(contract: CapabilityDefinition) {
  assertSafeCapabilitySchema(contract.inputs, "inputs");
  assertSafeCapabilitySchema(contract.outputs, "outputs");
  const properties = contract.inputs.properties || {};
  const required = new Set(contract.inputs.required || []);
  for (const key of required) if (!properties[key]) throw new Error(`contract_input_schema_missing:${key}`);
  const placeholders = [...(contract.goalTemplate || "").matchAll(/\{([a-zA-Z0-9_-]+)\}/g)].map((match) => match[1]);
  for (const key of placeholders) if (!properties[key] || !required.has(key)) throw new Error(`contract_placeholder_unbound:${key}`);
  if (/(第\s*(?:[一二三四五六七八九十百千万两\d]+|\{rank\})\s*(?:个|条|名|项|位)|top\s*(?:\d+|\{rank\}))/i.test(`${contract.name}${contract.goalTemplate || ""}`)) {
    if (properties.rank?.type !== "number" || !required.has("rank") || !(contract.goalTemplate || "").includes("{rank}")) throw new Error("contract_rank_input_required");
  }
  if (contract.resultKind === "data" && !Object.keys(contract.outputs.properties || {}).some((key) => !META_OUTPUTS_FOR_STORE.has(key))) throw new Error("contract_business_output_required");
}

function ordinalValueFromGoal(goal: string) {
  const match = goal.match(/第\s*([一二三四五六七八九十两\d]+)\s*(?:个|条|名|项|位)/i) || goal.match(/top\s*(\d+)/i);
  if (!match) return undefined;
  if (/^\d+$/.test(match[1])) return Number(match[1]);
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const raw = match[1];
  if (raw === "十") return 10;
  if (raw.startsWith("十")) return 10 + (digits[raw[1]] || 0);
  if (raw.endsWith("十")) return (digits[raw[0]] || 0) * 10;
  if (raw.includes("十")) return (digits[raw[0]] || 0) * 10 + (digits[raw.at(-1)!] || 0);
  return digits[raw];
}

function projectInputValue(episode: TaskEpisode, id: string) {
  if (episode.input[id] !== undefined) return episode.input[id];
  if (id === "rank") return ordinalValueFromGoal(episode.goal);
  if (id === "date") {
    const corpus = `${episode.goal} ${episode.endSnapshot.url}`.normalize("NFKC");
    const iso = corpus.match(/(?:^|[^\d])(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日|号)?(?:[^\d]|$)/);
    const short = corpus.match(/(?:^|[^\d])(\d{2})年(\d{1,2})月(\d{1,2})(?:日|号)(?:[^\d]|$)/);
    const match = iso || short;
    if (!match) return undefined;
    const year = match === short ? 2000 + Number(match[1]) : Number(match[1]);
    return `${year.toString().padStart(4, "0")}-${Number(match[2]).toString().padStart(2, "0")}-${Number(match[3]).toString().padStart(2, "0")}`;
  }
  const observedInputs = Object.values(episode.input).filter((value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean");
  if (observedInputs.length === 1) return observedInputs[0];
  return undefined;
}

async function queueProjectRevision(database: D1DatabaseLike, project: CapabilityProject, contract: CapabilityDefinition, guidanceText?: string) {
  validateProjectContract(contract);
  const currentProjectRows = await all<CapabilityProjectRow>(
    database,
    `SELECT project_json AS projectJson
       FROM site_agent_v2_capability_projects
      WHERE id=? AND site_agent_id=?
      LIMIT 1`,
    [project.id, project.siteAgentId],
  );
  if (!currentProjectRows[0]) throw new Error("capability_project_not_found");
  project = projectWithIdentityDefaults(
    JSON.parse(currentProjectRows[0].projectJson) as CapabilityProject,
  );
  const release = await immutableActiveReleaseForRevision(
    database,
    project.siteAgentId,
  );
  const currentOutcomes = project.activeCapabilityId
    ? runtimeCapability(release, project.activeCapabilityId)?.outcomes
    : undefined;
  assertStableCapabilityIdentity(project, contract, currentOutcomes);
  const episode = await sourceEpisodeForProject(database, project, contract);
  if (!episode) throw new Error("demonstration_required");
  const authoringStartUrl = contract.kind === "navigation"
    ? independentNavigationStartUrl(release, contract, episode.startSnapshot.url)
    : episode.startSnapshot.url;
  const now = new Date().toISOString();
  const candidateId = uid("candidate");
  const candidate: KnowledgeCandidate = {
    id: candidateId,
    siteAgentId: project.siteAgentId,
    normalizedGoal: normalizeGoal(contract.goalTemplate || contract.name),
    baseReleaseVersion: release.version,
    scenes: release.scenes,
    targets: [],
    operations: [],
    capability: { ...contract, status: "learning", exposure: contract.exposure || "public", updatedAt: now },
    validation: { status: "pending", attempts: 0, successfulReplays: 0, requiredReplays: 1 },
    authoring: { stage: "designed", reusableTrace: false, intentKey: project.intentKey, capabilityKind: contract.kind, reason: guidanceText ? `人工指导：${guidanceText}` : "使用最新网站知识重新探索并编写程序", goalTemplate: contract.goalTemplate || contract.name, requiredInputs: Object.entries(contract.inputs.properties || {}).map(([id, schema]) => ({ id, name: schema.description || id, type: schema.type === "number" || schema.type === "boolean" ? schema.type : "string", value: projectInputValue(episode, id) ?? schema.examples?.[0] as string | number | boolean | undefined })), parameterizationDecisions: Object.entries(contract.inputs.properties || {}).flatMap(([id, schema]) => { const value = projectInputValue(episode, id) ?? schema.examples?.[0]; return value === undefined || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") ? [] : [{ id: `parameter_${stableHash(`${candidateId}:${id}:${String(value)}`)}`, observedValue: value, evidence: id === "rank" ? `从真实目标“${episode.goal}”识别出的榜单序号` : "来自该能力的真实成功经验", decision: "input" as const, inputId: id, reason: `具体样例值被保留为业务输入 ${schema.description || id}` }]; }), resultFields: Object.entries(contract.outputs.properties || {}).map(([id, schema]) => ({ id, name: schema.description || id, type: schema.type, description: schema.description, source: META_OUTPUTS_FOR_STORE.has(id) ? id === "pageUrl" ? "page-url" : id === "pageTitle" ? "page-title" : "page-heading" : "extracted", importance: META_OUTPUTS_FOR_STORE.has(id) ? "metadata" as const : contract.outputs.required?.includes(id) ? "core" as const : "optional" as const })) },
    sourceEpisodeIds: [...new Set([...(contract.sourceEpisodeIds || []), episode.id])],
    createdAt: now,
    updatedAt: now,
  };
  const jobId = uid("learning");
  const maxRows = await all<{ maxNumber: number | string }>(
    database,
    `SELECT COALESCE(MAX(revision_number),0) AS maxNumber
       FROM site_agent_v2_capability_revisions
      WHERE site_agent_id=? AND project_id=?`,
    [project.siteAgentId, project.id],
  );
  const revisionNumber = Number(maxRows[0]?.maxNumber || 0) + 1;
  const revision: CapabilityRevision = {
    id: `revision_${stableHash(`${project.id}:${jobId}:${revisionNumber}`)}`,
    projectId: project.id,
    siteAgentId: project.siteAgentId,
    number: revisionNumber,
    status: "building",
    stage: "author",
    baseReleaseVersion: release.version,
    implementationReleaseId: release.id,
    implementationReleaseVersion: release.version,
    candidateId,
    learningJobId: jobId,
    parameterizationDecisions: candidate.authoring?.parameterizationDecisions || [],
    implementation: revisionImplementationForCapability(release, contract),
    validation: { status: "pending" },
    guidanceIds: [],
    createdAt: now,
    updatedAt: now,
  };
  const queuedProject = capabilityProjectForWrite({
    ...project,
    status: project.activeRevisionId ? project.status : "building",
    stage: project.activeRevisionId ? project.stage : "author",
    latestRevisionId: revision.id,
    revisionCount: Math.max(project.revisionCount, revision.number),
    buildStartedAt: project.buildStartedAt || now,
    updatedAt: now,
  });
  const job: LearningJob = {
    id: jobId, siteAgentId: project.siteAgentId, taskSessionId: episode.taskSessionId, sourceEpisodeId: episode.id, candidateId,
    origin: project.origin, phase: "author", status: "queued", attempts: 0, intentKey: project.intentKey, goalTemplate: candidate.authoring?.goalTemplate,
    receipts: [
      { id: uid("receipt"), stage: "evidence", actor: "program", status: "passed", title: "复用已有真实经验", summary: episode.outcome.summary, startedAt: episode.startedAt, endedAt: episode.endedAt, evidence: { episodeId: episode.id } },
      { id: uid("receipt"), stage: "design", actor: "program", status: "passed", title: guidanceText ? "能力契约已结合人工指导" : "稳定能力契约已复用", summary: guidanceText || "Capability 的稳定输入输出契约保持不变，本次只重新编写 Revision 实现。", startedAt: now, endedAt: now },
      { id: uid("receipt"), stage: "author", actor: "ai", status: "queued", title: "等待 AI 重新探索并编写", summary: "Last Good 保持不变，新实现将在独立浏览器中编写。", startedAt: now },
    ],
    result: {
      source: "capability-control",
      rawExperienceOnly: true,
      projectId: project.id,
      revisionId: revision.id,
      authoringStartUrl,
    },
    createdAt: now,
    updatedAt: now,
  };
  // Only one working Revision may own an Intent.  A re-design request replaces
  // stale queued/leased work instead of letting two browser authors race and
  // creating duplicate implementations from the same evidence.
  const activeRows = await all<LearningJobRow>(database, `SELECT result_json AS jobJson FROM site_agent_v2_learning_jobs WHERE site_agent_id=? AND status IN ('queued','leased','running') ORDER BY updated_at DESC LIMIT 100`, [project.siteAgentId]);
  const superseded = activeRows.map((row) => JSON.parse(row.jobJson) as LearningJob).filter((item) => item.intentKey === project.intentKey);
  const supersededJobIds = new Set(superseded.map((item) => item.id));
  const activeValidationRows = supersededJobIds.size ? await all<ValidationJobRow>(database, `SELECT job_json AS jobJson FROM site_agent_v2_validation_jobs WHERE site_agent_id=? AND status IN ('queued','leased','running') ORDER BY updated_at DESC LIMIT 100`, [project.siteAgentId]) : [];
  const supersedeStatements = superseded.map((item) => {
    const replaced: LearningJob = {
      ...item,
      status: "cancelled",
      lease: undefined,
      receipts: item.receipts.map((receipt) => receipt.status === "queued" || receipt.status === "running" ? { ...receipt, status: "skipped" as const, title: "已由更新的 Revision 接管", summary: "新的能力设计已开始，旧队列不再继续执行。", endedAt: now } : receipt),
      failure: { code: "superseded_by_revision", summary: "已由更新的 Revision 接管。" },
      updatedAt: now,
    };
    return database.prepare(`UPDATE site_agent_v2_learning_jobs SET status='cancelled',result_json=?,updated_at=? WHERE id=? AND site_agent_id=?`).bind(JSON.stringify(replaced), now, replaced.id, replaced.siteAgentId);
  });
  const supersedeValidationStatements = activeValidationRows.map((row) => JSON.parse(row.jobJson) as ValidationJob)
    .filter((item) => supersededJobIds.has(item.learningJobId))
    .map((item) => {
      const replaced: ValidationJob = { ...item, status: "cancelled", lease: undefined, failure: { code: "superseded_by_revision", summary: "已由更新的 Revision 接管。" }, updatedAt: now };
      return database.prepare(`UPDATE site_agent_v2_validation_jobs SET status='cancelled',lease_expires_at=NULL,job_json=?,updated_at=? WHERE id=? AND site_agent_id=?`).bind(JSON.stringify(replaced), now, replaced.id, replaced.siteAgentId);
    });
  const supersededRevisionRows = supersededJobIds.size
    ? await all<CapabilityRevisionRow>(
      database,
      `SELECT revision_json AS revisionJson
         FROM site_agent_v2_capability_revisions
        WHERE site_agent_id=? AND project_id=? AND status IN ('building','failed')`,
      [project.siteAgentId, project.id],
    )
    : [];
  const supersedeRevisionStatements = supersededRevisionRows
    .map((row) => JSON.parse(row.revisionJson) as CapabilityRevision)
    .filter((item) => Boolean(item.learningJobId && supersededJobIds.has(item.learningJobId)))
    .map((item) => {
      const replaced: CapabilityRevision = {
        ...item,
        status: "superseded",
        updatedAt: now,
      };
      return database.prepare(`UPDATE site_agent_v2_capability_revisions
        SET status='superseded',revision_json=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND project_id=? AND status IN ('building','failed')`)
        .bind(JSON.stringify(replaced), now, replaced.id, replaced.siteAgentId, replaced.projectId);
    });
  const results = await database.batch([
    ...supersedeStatements,
    ...supersedeValidationStatements,
    ...supersedeRevisionStatements,
    database.prepare(`INSERT INTO site_agent_v2_candidates (id,site_agent_id,normalized_goal,status,base_release_version,candidate_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(candidate.id, candidate.siteAgentId, candidate.normalizedGoal, "pending", candidate.baseReleaseVersion, JSON.stringify(candidate), now, now),
    database.prepare(`INSERT INTO site_agent_v2_learning_jobs (id,site_agent_id,task_session_id,status,result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(job.id, job.siteAgentId, job.taskSessionId, job.status, JSON.stringify(job), now, now),
    database.prepare(`INSERT INTO site_agent_v2_capability_revisions
      (id,project_id,site_agent_id,revision_number,status,revision_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .bind(revision.id, revision.projectId, revision.siteAgentId, revision.number, revision.status, JSON.stringify(revision), revision.createdAt, revision.updatedAt),
    database.prepare(`UPDATE site_agent_v2_capability_projects
      SET intent_key=?,stable_key=?,contract_fingerprint=?,active_revision_id=?,latest_revision_id=?,
          status=?,project_json=?,created_at=?,updated_at=?
      WHERE id=? AND site_agent_id=? AND project_json=?`)
      .bind(
        queuedProject.intentKey,
        queuedProject.stableKey || null,
        queuedProject.contractFingerprint || null,
        queuedProject.activeRevisionId || null,
        queuedProject.latestRevisionId || null,
        queuedProject.status,
        JSON.stringify(queuedProject),
        queuedProject.createdAt,
        queuedProject.updatedAt,
        queuedProject.id,
        queuedProject.siteAgentId,
        currentProjectRows[0].projectJson,
      ),
    database.prepare(`INSERT OR REPLACE INTO site_agent_v2_meta (key,value,updated_at)
      VALUES (?,CASE WHEN
        EXISTS (SELECT 1 FROM site_agent_v2_capability_projects
          WHERE id=? AND site_agent_id=? AND latest_revision_id=?)
        AND EXISTS (SELECT 1 FROM site_agent_v2_capability_revisions
          WHERE id=? AND site_agent_id=? AND project_id=? AND status='building')
        AND EXISTS (SELECT 1 FROM site_agent_v2_learning_jobs
          WHERE id=? AND site_agent_id=? AND status='queued'
            AND json_extract(result_json,'$.result.revisionId')=?)
        THEN ? ELSE NULL END,?)`)
      .bind(
        `capability_revision_queue_guard:${job.id}`,
        queuedProject.id,
        queuedProject.siteAgentId,
        revision.id,
        revision.id,
        revision.siteAgentId,
        revision.projectId,
        job.id,
        job.siteAgentId,
        revision.id,
        revision.id,
        now,
      ),
    database.prepare(`DELETE FROM site_agent_v2_meta WHERE key=?`)
      .bind(`capability_revision_queue_guard:${job.id}`),
  ]);
  const failure = results.find((result) => !result.success); if (failure) throw new Error(failure.error || "capability_revision_queue_failed");
  return { candidate, job, revision, project: queuedProject };
}

const META_OUTPUTS_FOR_STORE = new Set(["pageUrl", "pageTitle", "pageHeading"]);

function suppressionForProject(project: CapabilityProject, contract: CapabilityDefinition, now: string): CapabilitySuppression {
  const normalizedPatterns = [...new Set([
    project.name,
    project.goalTemplate,
    contract.name,
    contract.goalTemplate || "",
    ...contract.aliases,
  ].map(normalizeGoal).filter(Boolean))];
  return {
    id: `suppression_${stableHash(`${project.siteAgentId}:${project.intentKey}`)}`,
    siteAgentId: project.siteAgentId,
    projectId: project.id,
    sourceCapabilityId: project.activeCapabilityId || contract.id,
    intentKey: project.intentKey,
    intentFingerprint: stableHash(normalizedPatterns.slice().sort().join("|")),
    name: project.name,
    goalTemplate: project.goalTemplate,
    aliases: contract.aliases,
    normalizedPatterns,
    reason: `管理员已下架“${project.name}”；用户任务仍可临时完成，但系统不得自动重新生成相同或相似能力。`,
    createdBy: "administrator",
    scope: "auto-generation",
    status: "active",
    policyVersion: 1,
    createdAt: now,
  };
}

function releaseWithSuppression(
  current: SiteAgentReleaseV2,
  suppression: CapabilitySuppression,
  now: string,
  operationId: string,
) {
  const removeSuppressed = (capability: CapabilityDefinition) =>
    capability.id === suppression.sourceCapabilityId;
  const removeNavigationTool = (tool: NavigationTool) =>
    `navigation-tool:${tool.id}` === suppression.sourceCapabilityId;
  const filtered = canonicalizeReleaseKnowledge({
    ...current,
    id: capabilityManagementReleaseId(
      current.siteAgentId,
      current.version + 1,
      "unpublish",
      suppression.id,
      now,
      operationId,
    ),
    version: current.version + 1,
    createdAt: now,
    capabilities: current.capabilities.filter((capability) => !removeSuppressed(capability)),
    navigationTools: (current.navigationTools || []).filter((tool) => !removeNavigationTool(tool)),
  });
  const capabilities = filtered.capabilities.filter((capability) => !removeSuppressed(capability));
  const navigationTools = (filtered.navigationTools || []).filter((tool) => !removeNavigationTool(tool));
  const taskTemplates = deriveCapabilityTaskTemplates(capabilities, navigationTools);
  const release = {
    ...filtered,
    capabilities,
    navigationTools,
    profile: { ...filtered.profile, taskTemplates, suggestedGoals: taskTemplates.map((task) => task.name) },
  };
  const hashable = { ...release, contentHash: undefined, knowledgeRevision: undefined };
  return { ...release, contentHash: stableHash(JSON.stringify(hashable)) };
}

function memoryDeleteCapabilityProject(
  agent: MemoryAgent,
  siteAgentId: string,
  projectId: string,
) {
  const current = agent.capabilityProjects
    .map(projectWithIdentityDefaults)
    .find((item) => item.id === projectId && item.siteAgentId === siteAgentId);
  if (!current) throw new Error("capability_project_not_found");
  assertCapabilityProjectDeletable(
    memoryCapabilityProjectDeletion(agent, current),
  );
  // Hard delete is deliberately root-only. If any production or evidence row
  // exists, the predicate above rejects and callers must archive instead.
  agent.capabilityProjects = agent.capabilityProjects.filter((item) =>
    item.id !== projectId);
}

async function d1DeleteCapabilityProject(
  database: D1DatabaseLike,
  siteAgentId: string,
  projectId: string,
) {
  const projectRows = await all<CapabilityProjectRow>(
    database,
    `SELECT project_json AS projectJson
       FROM site_agent_v2_capability_projects
      WHERE id=? AND site_agent_id=? LIMIT 1`,
    [projectId, siteAgentId],
  );
  if (!projectRows[0]) throw new Error("capability_project_not_found");
  const observedProjectJson = projectRows[0].projectJson;
  const project = projectWithIdentityDefaults(
    JSON.parse(observedProjectJson) as CapabilityProject,
  );
  assertCapabilityProjectDeletable(
    await d1CapabilityProjectDeletion(database, siteAgentId, project),
  );

  const relations = d1CapabilityProjectDeletionRelations(siteAgentId, project);
  const postgres = database.dialect === "postgres";
  const historyGuard = relations.map((relation) => {
    if (postgres) return `NOT EXISTS (${relation.sql})`;
    let parameterIndex = 0;
    const sql = relation.sql.replace(/\?/g, () => {
      const value = relation.params[parameterIndex++];
      if (value === project.id) return "?1";
      if (value === siteAgentId) return "?2";
      if (value === project.intentKey) return "?4";
      throw new Error("capability_delete_guard_parameter_invalid");
    });
    if (parameterIndex !== relation.params.length) {
      throw new Error("capability_delete_guard_parameter_invalid");
    }
    return `NOT EXISTS (${sql})`;
  }).join("\n AND ");
  const projectIdParameter = postgres ? "?" : "?1";
  const siteAgentIdParameter = postgres ? "?" : "?2";
  const projectJsonParameter = postgres ? "?" : "?3";
  const result = await database.prepare(
    `DELETE FROM site_agent_v2_capability_projects
      WHERE id=${projectIdParameter}
        AND site_agent_id=${siteAgentIdParameter}
        AND project_json=${projectJsonParameter}
        AND COALESCE(active_revision_id,'')=''
        AND COALESCE(latest_revision_id,'')=''
        AND status NOT IN ('available','unpublished')
        AND COALESCE(json_extract(project_json,'$.activeCapabilityId'),'')=''
        AND COALESCE(json_extract(project_json,'$.activeRevisionId'),'')=''
        AND COALESCE(json_extract(project_json,'$.latestRevisionId'),'')=''
        AND CAST(COALESCE(json_extract(project_json,'$.revisionCount'),'0') AS TEXT) IN ('','0')
        AND COALESCE(json_extract(project_json,'$.buildStartedAt'),'')=''
        AND json_extract(project_json,'$.duplicateOf') IS NULL
        AND json_extract(project_json,'$.identityConflict') IS NULL
        AND ${historyGuard}`,
  ).bind(
    projectId,
    siteAgentId,
    observedProjectJson,
    ...(postgres
      ? relations.flatMap((relation) => relation.params)
      : [project.intentKey]),
  ).run();
  if (!result.success) {
    throw new Error(result.error || "capability_delete_failed");
  }
  if (Number(result.meta?.changes || 0) !== 1) {
    const currentRows = await all<CapabilityProjectRow>(
      database,
      `SELECT project_json AS projectJson
         FROM site_agent_v2_capability_projects
        WHERE id=? AND site_agent_id=? LIMIT 1`,
      [projectId, siteAgentId],
    );
    if (!currentRows[0]) throw new Error("capability_project_not_found");
    const current = projectWithIdentityDefaults(
      JSON.parse(currentRows[0].projectJson) as CapabilityProject,
    );
    assertCapabilityProjectDeletable(
      await d1CapabilityProjectDeletion(database, siteAgentId, current),
    );
    throw new Error("capability_release_conflict");
  }
  invalidateSiteAgentListCache();
}
function releaseWithRelistedCapability(
  current: SiteAgentReleaseV2,
  contract: CapabilityDefinition,
  now: string,
  operationId: string,
) {
  const capability = { ...contract, status: "available" as const, updatedAt: now };
  const capabilities = [...current.capabilities.filter((item) => item.id !== capability.id), capability];
  const taskTemplates = deriveCapabilityTaskTemplates(capabilities, current.navigationTools || []);
  const release = canonicalizeReleaseKnowledge({
    ...current,
    id: capabilityManagementReleaseId(
      current.siteAgentId,
      current.version + 1,
      "relist",
      contract.id,
      now,
      operationId,
    ),
    version: current.version + 1,
    createdAt: now,
    capabilities,
    profile: { ...current.profile, taskTemplates, suggestedGoals: taskTemplates.map((task) => task.name) },
  });
  const hashable = { ...release, contentHash: undefined, knowledgeRevision: undefined };
  return { ...release, contentHash: stableHash(JSON.stringify(hashable)) };
}

function capabilityIdsForExposure(project: CapabilityProject) {
  if (!project.activeCapabilityId) return [];
  if (!project.activeCapabilityId.startsWith("navigation-tool:")) return [project.activeCapabilityId];
  return [...new Set([
    project.activeCapabilityId,
    ...(project.implementationAssets || []).map((asset) => asset.capabilityId),
  ])];
}

function releaseWithCapabilityExposure(
  current: SiteAgentReleaseV2,
  capabilityIds: string | string[],
  exposure: "public" | "internal",
  now: string,
  operationId: string,
) {
  const ids = new Set(Array.isArray(capabilityIds) ? capabilityIds : [capabilityIds]);
  const releaseIdentity = [...ids].sort().join(",");
  if (!current.capabilities.some((capability) => ids.has(capability.id))) throw new Error("capability_not_published");
  const capabilities = current.capabilities.map((capability) =>
    ids.has(capability.id) ? { ...capability, exposure, updatedAt: now } : capability);
  const canonical = canonicalizeReleaseKnowledge({
    ...current,
    id: capabilityManagementReleaseId(current.siteAgentId, current.version + 1, "exposure", releaseIdentity, now, operationId),
    version: current.version + 1,
    createdAt: now,
    capabilities,
  });
  // Knowledge canonicalization may rematerialize a Navigation Tool adapter.
  // Exposure is an administrator policy, so it must win over generated defaults.
  const canonicalCapabilities = canonical.capabilities.map((capability) =>
    ids.has(capability.id) ? { ...capability, exposure, updatedAt: now } : capability);
  if (!canonicalCapabilities.some((capability) => ids.has(capability.id))) throw new Error("capability_not_published");
  const taskTemplates = deriveCapabilityTaskTemplates(canonicalCapabilities, canonical.navigationTools || []);
  const release = {
    ...canonical,
    capabilities: canonicalCapabilities,
    profile: { ...canonical.profile, taskTemplates, suggestedGoals: taskTemplates.map((task) => task.name) },
  };
  const hashable = { ...release, contentHash: undefined, knowledgeRevision: undefined };
  return { ...release, contentHash: stableHash(JSON.stringify(hashable)) };
}

function reviewFeedbackText(input?: string) {
  return String(input || "").trim().slice(0, 2_000);
}

function publishedLifecycleRevision(
  project: CapabilityProject,
  revisions: CapabilityRevision[],
) {
  const revision = revisions.find((item) =>
    item.id === project.activeRevisionId);
  if (!revision
    || revision.status !== "published"
    || !revision.publicationProvenance
    || !revision.publishedReleaseId
    || revision.publishedReleaseVersion === undefined) {
    throw new Error("capability_last_good_missing");
  }
  return revision;
}

function assertCapabilityProjectDeletable(
  deletion: CapabilityProjectDeletion,
) {
  if (!deletion.allowed) {
    throw new Error("capability_project_delete_requires_draft");
  }
}

function exactLastGoodContract(
  project: CapabilityProject,
  revision: CapabilityRevision,
  release: SiteAgentReleaseV2,
) {
  if (release.id !== revision.publishedReleaseId
    || release.version !== revision.publishedReleaseVersion) {
    throw new Error("capability_last_good_release_mismatch");
  }
  const capabilityId = project.canonicalCapabilityId
    || project.activeCapabilityId;
  if (!capabilityId) throw new Error("capability_last_good_missing");
  const published = release.capabilities.find((item) =>
    item.id === capabilityId);
  if (!published) throw new Error("capability_last_good_missing");
  if (stableHash(JSON.stringify(published.inputs))
      !== stableHash(JSON.stringify(project.inputSchema))
    || stableHash(JSON.stringify(published.outputs))
      !== stableHash(JSON.stringify(project.outputSchema))) {
    throw new Error("capability_last_good_contract_mismatch");
  }
  return {
    ...readableRevisionContract(project, revision, published),
    id: capabilityId,
    exposure: project.exposure,
  };
}

function assertValidatedCapabilityInRelease(
  release: SiteAgentReleaseV2,
  candidate: KnowledgeCandidate,
) {
  const published = release.capabilities.find((capability) =>
    capability.id === candidate.capability.id);
  if (!published) throw new Error("revision_approval_release_invalid");
  const validatedModuleHash = candidate.capability.module?.contentHash;
  if (validatedModuleHash && published.module?.contentHash !== validatedModuleHash) {
    throw new Error("revision_approval_release_invalid");
  }
}

function reviewRetryJob(
  job: LearningJob,
  review: RevisionReview,
  feedback: string,
  now: string,
) {
  const publishFailed = updateReceipt(job, "publish", {
    status: "failed",
    actor: "release-gate",
    title: "人工审核已驳回",
    summary: feedback,
    endedAt: now,
    evidence: { reviewId: review.id, validationRunId: review.validationRunId },
  });
  const authorReceipt: LearningStageReceipt = {
    id: uid("receipt"),
    stage: "author",
    actor: "ai",
    status: "queued",
    title: "带着人工审核意见重新编写",
    summary: feedback,
    startedAt: now,
    evidence: { reviewId: review.id },
  };
  const validationReceipt: LearningStageReceipt = {
    id: uid("receipt"),
    stage: "validate",
    actor: "browser-runner",
    status: "queued",
    title: "等待修订后的独立验证",
    summary: "旧验证已失效；新实现必须重新通过独立浏览器验证。",
    startedAt: now,
    evidence: { invalidatedValidationRunId: review.validationRunId },
  };
  return {
    ...publishFailed,
    phase: "author" as const,
    status: "queued" as const,
    lease: undefined,
    latestRunId: undefined,
    reviewFeedback: { reviewId: review.id, text: feedback },
    failure: undefined,
    receipts: [...publishFailed.receipts, authorReceipt, validationReceipt],
    updatedAt: now,
  };
}

function failedAuthoringRetryState(
  project: CapabilityProject,
  revision: CapabilityRevision,
  candidate: KnowledgeCandidate,
  job: LearningJob,
  now: string,
) {
  const previousFailureSummary = job.failure?.summary
    || "上一轮程序编写未完成，管理员要求在当前 Working Revision 内重新编写。";
  const resultAssessment = job.result.evolutionAssessment
    && typeof job.result.evolutionAssessment === "object"
    && !Array.isArray(job.result.evolutionAssessment)
    ? job.result.evolutionAssessment as Record<string, JsonValue>
    : undefined;
  const authoringReason = job.reviewFeedback?.text
    || candidate.authoring?.reuseReason
    || candidate.authoring?.evolutionAssessment?.summary
    || (typeof job.result.reuseReason === "string" ? job.result.reuseReason : undefined)
    || (typeof resultAssessment?.summary === "string" ? resultAssessment.summary : undefined)
    || candidate.authoring?.reason
    || "使用当前稳定契约与已有页面证据重新编写程序。";
  const receiptEvidence: Record<string, JsonValue> = {
    previousFailureCode: job.failure?.code || "authoring_failed",
    previousAttemptCount: job.attempts,
  };
  if (job.latestRunId) receiptEvidence.previousRunId = job.latestRunId;
  const retryReceipt: LearningStageReceipt = {
    id: uid("receipt"),
    stage: "author",
    actor: "ai",
    status: "queued",
    title: "重新编写当前 Working Revision",
    summary: previousFailureSummary,
    startedAt: now,
    evidence: receiptEvidence,
  };
  const retryCandidate: KnowledgeCandidate = {
    ...candidate,
    capability: {
      ...candidate.capability,
      status: "learning",
      updatedAt: now,
    },
    validation: {
      ...candidate.validation,
      status: "pending",
    },
    authoring: {
      ...(candidate.authoring || { stage: "designed", reusableTrace: false }),
      stage: "designed",
      reusableTrace: false,
      reason: authoringReason,
    },
    updatedAt: now,
  };
  const retryJob: LearningJob = {
    ...job,
    phase: "author",
    status: "queued",
    lease: undefined,
    latestRunId: undefined,
    failure: undefined,
    receipts: [...job.receipts, retryReceipt],
    updatedAt: now,
  };
  const retryRevision: CapabilityRevision = {
    ...revision,
    status: "building",
    stage: "author",
    validation: {
      status: "pending",
      input: revision.validation?.input,
      summary: previousFailureSummary,
    },
    updatedAt: now,
  };
  const retryProject = capabilityProjectForWrite({
    ...project,
    status: project.activeRevisionId
      ? project.status === "archived" || project.status === "unpublished"
        ? project.status
        : "available"
      : "building",
    stage: project.activeRevisionId ? project.stage : "author",
    latestRevisionId: revision.id,
    health: {
      ...project.health,
      failureClass: undefined,
      recommendedAction: undefined,
    },
    updatedAt: now,
  });
  const event: CapabilityEvent = {
    id: uid("event"),
    siteAgentId: project.siteAgentId,
    projectId: project.id,
    revisionId: revision.id,
    type: "author",
    actor: "user",
    status: "info",
    title: "Working Revision 已重新进入编写队列",
    summary: previousFailureSummary,
    evidence: {
      candidateId: candidate.id,
      learningJobId: job.id,
      previousAttemptCount: job.attempts,
    },
    createdAt: now,
  };
  return {
    project: retryProject,
    revision: retryRevision,
    candidate: retryCandidate,
    job: retryJob,
    event,
  };
}

function retryTupleAlreadyQueued(
  project: CapabilityProject,
  revision: CapabilityRevision,
  candidate: KnowledgeCandidate,
  job: LearningJob,
) {
  return project.latestRevisionId === revision.id
    && revision.status === "building"
    && revision.stage === "author"
    && revision.candidateId === candidate.id
    && revision.learningJobId === job.id
    && candidate.validation.status === "pending"
    && candidate.authoring?.stage === "designed"
    && job.candidateId === candidate.id
    && job.phase === "author"
    && ["queued", "leased", "running"].includes(job.status);
}

function approvedLearningJob(
  job: LearningJob,
  review: RevisionReview,
  release: SiteAgentReleaseV2,
  now: string,
) {
  return updateReceipt({
    ...job,
    phase: "publish",
    status: "completed",
    lease: undefined,
    reviewFeedback: undefined,
    failure: undefined,
    updatedAt: now,
  }, "publish", {
    status: "passed",
    actor: "release-gate",
    title: "人工审核通过并发布",
    summary: `已发布为 Release v${release.version}。`,
    endedAt: now,
    evidence: {
      reviewId: review.id,
      validationRunId: review.validationRunId,
      validatedContentHash: review.validatedContentHash,
      releaseVersion: release.version,
    },
  });
}

function revisionReviewEvent(
  review: RevisionReview,
  title: string,
  summary: string,
  releaseVersion?: number,
): CapabilityEvent {
  return {
    id: `event_${stableHash(review.id)}`,
    siteAgentId: review.siteAgentId,
    projectId: review.projectId,
    revisionId: review.revisionId,
    type: review.status === "approved" ? "publish" : "guidance",
    actor: "user",
    status: review.status === "approved" ? "passed" : "failed",
    title,
    summary,
    evidence: {
      reviewId: review.id,
      validationRunId: review.validationRunId,
      validatedContentHash: review.validatedContentHash,
      ...(releaseVersion === undefined ? {} : { releaseVersion }),
    },
    createdAt: review.createdAt,
  };
}

function executionRequirementsForPublishedRevision(
  project: CapabilityProject,
  capability: CapabilityDefinition,
  revision: CapabilityRevision,
): CapabilityProject["executionRequirements"] {
  if ((project.structure || "atomic") === "composite") {
    return {
      ...project.executionRequirements,
      supportedEnvironments: {
        connectedBrowser: "blocked",
        cloudBrowser: "blocked",
        managedProfile: "blocked",
      },
    };
  }
  const implementation = revision.implementation;
  const supportsCloudBrowser = Boolean(capability.module)
    || implementation?.kind === "module"
    || implementation?.kind === "navigation-tool"
    || (implementation?.kind === "program" && Boolean(implementation.moduleRef));
  if (!supportsCloudBrowser) return project.executionRequirements;
  return {
    ...project.executionRequirements,
    supportedEnvironments: {
      ...project.executionRequirements.supportedEnvironments,
      cloudBrowser: "supported",
    },
  };
}

function actOnRevisionReviewMemory(
  agent: MemoryAgent,
  siteAgentId: string,
  projectId: string,
  action: "approve-revision" | "reject-revision",
  expected: {
    revisionId?: string;
    validationRunId?: string;
    validatedContentHash?: string;
  },
  inputText?: string,
) {
  const now = new Date().toISOString();
  const feedback = reviewFeedbackText(inputText);
  if (action === "reject-revision" && !feedback) {
    throw new Error("review_feedback_required");
  }
  if (!expected.revisionId
    || !expected.validationRunId
    || !expected.validatedContentHash) {
    throw new Error("revision_review_identity_required");
  }
  const project = agent.capabilityProjects.find((item) => item.id === projectId);
  const revision = agent.capabilityRevisions.find((item) =>
    item.id === expected.revisionId && item.projectId === projectId);
  const validationRunId = revision?.validation?.runId;
  const validatedContentHash = revision?.validation?.validatedContentHash;
  if (!project
    || !revision
    || !validationRunId
    || !validatedContentHash
    || !revision.candidateId
    || !revision.learningJobId) {
    throw new Error("revision_review_not_ready");
  }
  if (project.latestRevisionId !== expected.revisionId
    || validationRunId !== expected.validationRunId
    || validatedContentHash !== expected.validatedContentHash) {
    throw new Error("revision_review_state_drifted");
  }
  const reviews = agent.revisionReviews.filter((item) =>
    item.revisionId === revision.id
    && item.validationRunId === validationRunId
    && item.validatedContentHash === validatedContentHash);
  if (reviews.some((review) => review.status === "approved" || review.status === "rejected")) {
    throw new Error("revision_review_already_decided");
  }
  if (revision.status !== "awaiting-review" || revision.validation?.status !== "passed") {
    throw new Error("revision_review_not_ready");
  }
  if (!reviews.some((review) => review.status === "awaiting-review")) {
    throw new Error("revision_review_not_ready");
  }
  const candidate = agent.candidates.find((item) => item.id === revision.candidateId);
  const learningJob = agent.learningJobs.find((item) => item.id === revision.learningJobId);
  const validationJob = agent.validationJobs.find((item) =>
    item.learningJobId === revision.learningJobId
    && item.latestRunId === validationRunId);
  if (!candidate
    || validatedCandidateContentHash(candidate, revision) !== validatedContentHash
    || !learningJob
    || learningJob.status !== "awaiting-review"
    || learningJob.latestRunId !== validationRunId
    || !validationJob
    || validationJob.status !== "passed"
    || validationJob.invalidatedAt) {
    throw new Error("revision_review_state_drifted");
  }
  if (action === "approve-revision"
    && (revision.baseReleaseVersion !== candidate.baseReleaseVersion
      || revision.baseReleaseVersion !== validationJob.baseReleaseVersion)) {
    throw new Error("revision_review_validation_base_mismatch");
  }
  if (action === "approve-revision"
    && (project.structure || "atomic") === "composite") {
    throw new Error("composite_publication_not_implemented");
  }
  const review: RevisionReview = {
    id: revisionReviewId(revision.id, validationRunId, validatedContentHash,
      action === "approve-revision" ? "approved" : "rejected"),
    siteAgentId,
    projectId,
    revisionId: revision.id,
    validationRunId,
    validatedContentHash,
    status: action === "approve-revision" ? "approved" : "rejected",
    reviewer: "administrator",
    ...(feedback ? { feedback } : {}),
    createdAt: now,
  };
  if (action === "approve-revision") {
    const implementationRelease = revision.implementationReleaseId
      ? memoryReleaseById(agent, revision.implementationReleaseId)
      : agent.release;
    if (!implementationRelease
      || (revision.implementationReleaseVersion !== undefined
        && implementationRelease.version !== revision.implementationReleaseVersion)) {
      throw new Error("revision_review_implementation_release_missing");
    }
    validateProjectContract(candidate.capability);
    assertCapabilityRevisionRelease(
      implementationRelease,
      candidate.capability,
      revision,
      { requirePublished: false },
    );
    const release = materializeCandidateRelease(
      agent.release,
      { id: `review:${review.id}`, endedAt: now },
      candidate,
    );
    assertValidatedCapabilityInRelease(release, candidate);
    const publishedRevision: CapabilityRevision = {
      ...revision,
      status: "published",
      stage: "publish",
      publicationProvenance: "human-reviewed",
      publishedReleaseId: release.id,
      publishedReleaseVersion: release.version,
      updatedAt: now,
    };
    const publishedProject = capabilityProjectForWrite({
      ...project,
      status: "available",
      stage: "publish",
      canonicalCapabilityId: candidate.capability.id,
      activeCapabilityId: candidate.capability.id,
      activeRevisionId: revision.id,
      latestRevisionId: revision.id,
      executionRequirements: executionRequirementsForPublishedRevision(
        project,
        candidate.capability,
        publishedRevision,
      ),
      health: {
        ...project.health,
        lastValidatedAt: now,
        failureClass: undefined,
        recommendedAction: undefined,
      },
      updatedAt: now,
    });
    const completedJob = approvedLearningJob(learningJob, review, release, now);
    const event = revisionReviewEvent(
      review,
      "Revision 人工审核通过",
      `Validated Candidate 已发布为 Release v${release.version}。`,
      release.version,
    );
    setMemoryRelease(agent, release);
    agent.capabilityProjects = agent.capabilityProjects.map((item) =>
      item.id === projectId ? publishedProject : item);
    agent.capabilityRevisions = agent.capabilityRevisions.map((item) =>
      item.id === revision.id ? publishedRevision : item);
    agent.learningJobs = agent.learningJobs.map((item) =>
      item.id === learningJob.id ? completedJob : item);
    agent.candidates = agent.candidates.filter((item) => item.id !== candidate.id);
    agent.revisionReviews = [...agent.revisionReviews, review];
    agent.capabilityEvents.push(event);
    return {
      project: publishedProject,
      revision: publishedRevision,
      review,
      release,
      persistence: "memory" as const,
    };
  }
  const retryCandidate: KnowledgeCandidate = {
    ...candidate,
    capability: { ...candidate.capability, status: "learning", updatedAt: now },
    validation: { ...candidate.validation, status: "pending" },
    authoring: {
      ...(candidate.authoring || { stage: "designed", reusableTrace: false }),
      stage: "designed",
      reusableTrace: false,
      reason: feedback,
    },
    updatedAt: now,
  };
  const retryJob = reviewRetryJob(learningJob, review, feedback, now);
  const retryRevision: CapabilityRevision = {
    ...revision,
    status: "building",
    stage: "author",
    validation: {
      status: "pending",
      input: validationJob.validationCase.input,
      summary: feedback,
    },
    updatedAt: now,
  };
  const retryProject = capabilityProjectForWrite({
    ...project,
    status: project.activeRevisionId ? "available" : "building",
    stage: project.activeRevisionId ? project.stage : "author",
    latestRevisionId: revision.id,
    updatedAt: now,
  });
  const invalidatedValidation: ValidationJob = {
    ...validationJob,
    invalidatedAt: now,
    invalidatedByReviewId: review.id,
    invalidatedReason: feedback,
    updatedAt: now,
  };
  const event = revisionReviewEvent(review, "Revision 人工审核驳回", feedback);
  agent.capabilityProjects = agent.capabilityProjects.map((item) =>
    item.id === projectId ? retryProject : item);
  agent.capabilityRevisions = agent.capabilityRevisions.map((item) =>
    item.id === revision.id ? retryRevision : item);
  agent.learningJobs = agent.learningJobs.map((item) =>
    item.id === learningJob.id ? retryJob : item);
  agent.validationJobs = agent.validationJobs.map((item) =>
    item.id === validationJob.id ? invalidatedValidation : item);
  agent.candidates = agent.candidates.map((item) =>
    item.id === candidate.id ? retryCandidate : item);
  agent.revisionReviews = [...agent.revisionReviews, review];
  agent.capabilityEvents.push(event);
  return {
    project: retryProject,
    revision: retryRevision,
    review,
    persistence: "memory" as const,
  };
}

async function actOnRevisionReviewD1(
  database: D1DatabaseLike,
  siteAgentId: string,
  projectId: string,
  action: "approve-revision" | "reject-revision",
  expected: {
    revisionId?: string;
    validationRunId?: string;
    validatedContentHash?: string;
  },
  inputText?: string,
) {
  const now = new Date().toISOString();
  const feedback = reviewFeedbackText(inputText);
  if (action === "reject-revision" && !feedback) {
    throw new Error("review_feedback_required");
  }
  if (!expected.revisionId
    || !expected.validationRunId
    || !expected.validatedContentHash) {
    throw new Error("revision_review_identity_required");
  }
  const projectRows = await all<CapabilityProjectRow>(
    database,
    `SELECT project_json AS projectJson FROM site_agent_v2_capability_projects
      WHERE id=? AND site_agent_id=? LIMIT 1`,
    [projectId, siteAgentId],
  );
  if (!projectRows[0]) throw new Error("capability_project_not_found");
  const project = projectWithIdentityDefaults(
    JSON.parse(projectRows[0].projectJson) as CapabilityProject,
  );
  if (project.latestRevisionId !== expected.revisionId) {
    throw new Error("revision_review_state_drifted");
  }
  const revisionRows = await all<CapabilityRevisionRow>(
    database,
    `SELECT revision_json AS revisionJson FROM site_agent_v2_capability_revisions
      WHERE id=? AND project_id=? AND site_agent_id=? LIMIT 1`,
    [expected.revisionId, project.id, siteAgentId],
  );
  if (!revisionRows[0]) throw new Error("revision_review_not_ready");
  const revision = JSON.parse(revisionRows[0].revisionJson) as CapabilityRevision;
  const validationRunId = revision.validation?.runId;
  const validatedContentHash = revision.validation?.validatedContentHash;
  if (!validationRunId
    || !validatedContentHash
    || !revision.candidateId
    || !revision.learningJobId) {
    throw new Error("revision_review_not_ready");
  }
  if (validationRunId !== expected.validationRunId
    || validatedContentHash !== expected.validatedContentHash) {
    throw new Error("revision_review_state_drifted");
  }
  const reviewRows = await all<RevisionReviewRow>(
    database,
    `SELECT review_json AS reviewJson FROM site_agent_v2_revision_reviews
      WHERE site_agent_id=? AND project_id=? AND revision_id=?
        AND validation_run_id=? AND validated_content_hash=?
      ORDER BY created_at DESC`,
    [siteAgentId, projectId, revision.id, validationRunId, validatedContentHash],
  );
  const reviews = reviewRows.map((row) => JSON.parse(row.reviewJson) as RevisionReview);
  if (reviews.some((review) => review.status === "approved" || review.status === "rejected")) {
    throw new Error("revision_review_already_decided");
  }
  if (revision.status !== "awaiting-review" || revision.validation?.status !== "passed") {
    throw new Error("revision_review_not_ready");
  }
  const awaitingReview = reviews.find((review) => review.status === "awaiting-review");
  if (!awaitingReview) throw new Error("revision_review_not_ready");

  const [candidateRows, learningRows, validationRows, current] = await Promise.all([
    all<CandidateRow>(
      database,
      `SELECT candidate_json AS candidateJson FROM site_agent_v2_candidates
        WHERE id=? AND site_agent_id=? LIMIT 1`,
      [revision.candidateId, siteAgentId],
    ),
    all<LearningJobRow>(
      database,
      `SELECT result_json AS jobJson FROM site_agent_v2_learning_jobs
        WHERE id=? AND site_agent_id=? LIMIT 1`,
      [revision.learningJobId, siteAgentId],
    ),
    all<ValidationJobRow>(
      database,
      `SELECT job_json AS jobJson FROM site_agent_v2_validation_jobs
        WHERE learning_job_id=? AND site_agent_id=? ORDER BY created_at DESC`,
      [revision.learningJobId, siteAgentId],
    ),
    d1Release(database, siteAgentId),
  ]);
  if (!candidateRows[0] || !learningRows[0] || !current) {
    throw new Error("revision_review_state_missing");
  }
  const candidate = JSON.parse(candidateRows[0].candidateJson) as KnowledgeCandidate;
  const learningJob = JSON.parse(learningRows[0].jobJson) as LearningJob;
  const validationRecord = validationRows
    .map((row) => ({
      row,
      job: JSON.parse(row.jobJson) as ValidationJob,
    }))
    .find(({ job }) => job.latestRunId === validationRunId);
  if (validatedCandidateContentHash(candidate, revision) !== validatedContentHash
    || learningJob.status !== "awaiting-review"
    || learningJob.latestRunId !== validationRunId
    || !validationRecord
    || validationRecord.job.status !== "passed"
    || validationRecord.job.invalidatedAt) {
    throw new Error("revision_review_state_drifted");
  }
  if (action === "approve-revision"
    && (revision.baseReleaseVersion !== candidate.baseReleaseVersion
      || revision.baseReleaseVersion !== validationRecord.job.baseReleaseVersion)) {
    throw new Error("revision_review_validation_base_mismatch");
  }
  if (action === "approve-revision"
    && (project.structure || "atomic") === "composite") {
    throw new Error("composite_publication_not_implemented");
  }

  const review: RevisionReview = {
    id: revisionReviewId(revision.id, validationRunId, validatedContentHash,
      action === "approve-revision" ? "approved" : "rejected"),
    siteAgentId,
    projectId,
    revisionId: revision.id,
    validationRunId,
    validatedContentHash,
    status: action === "approve-revision" ? "approved" : "rejected",
    reviewer: "administrator",
    ...(feedback ? { feedback } : {}),
    createdAt: now,
  };
  const reviewInsert = database.prepare(`INSERT INTO site_agent_v2_revision_reviews
    (id,site_agent_id,project_id,revision_id,validation_run_id,validated_content_hash,status,review_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(
      review.id,
      review.siteAgentId,
      review.projectId,
      review.revisionId,
      review.validationRunId,
      review.validatedContentHash,
      review.status,
      JSON.stringify(review),
      review.createdAt,
    );

  if (action === "approve-revision") {
    let implementationRelease: SiteAgentReleaseV2;
    try {
      implementationRelease = await implementationReleaseForRevision(
        database,
        siteAgentId,
        current,
        revision,
      );
    } catch {
      throw new Error("revision_review_implementation_release_missing");
    }
    validateProjectContract(candidate.capability);
    assertCapabilityRevisionRelease(
      implementationRelease,
      candidate.capability,
      revision,
      { requirePublished: false },
    );
    const release = materializeCandidateRelease(
      current,
      { id: `review:${review.id}`, endedAt: now },
      candidate,
    );
    assertValidatedCapabilityInRelease(release, candidate);
    const releaseJson = JSON.stringify(release);
    const publishedRevision: CapabilityRevision = {
      ...revision,
      status: "published",
      stage: "publish",
      publicationProvenance: "human-reviewed",
      publishedReleaseId: release.id,
      publishedReleaseVersion: release.version,
      updatedAt: now,
    };
    const publishedProject = capabilityProjectForWrite({
      ...project,
      status: "available",
      stage: "publish",
      canonicalCapabilityId: candidate.capability.id,
      activeCapabilityId: candidate.capability.id,
      activeRevisionId: revision.id,
      latestRevisionId: revision.id,
      executionRequirements: executionRequirementsForPublishedRevision(
        project,
        candidate.capability,
        publishedRevision,
      ),
      health: {
        ...project.health,
        lastValidatedAt: now,
        failureClass: undefined,
        recommendedAction: undefined,
      },
      updatedAt: now,
    });
    const completedJob = approvedLearningJob(learningJob, review, release, now);
    const event = revisionReviewEvent(
      review,
      "Revision 人工审核通过",
      `Validated Candidate 已发布为 Release v${release.version}。`,
      release.version,
    );
    const guardKey = `revision_approval_guard:${review.id}`;
    const statements = [
      database.prepare(`INSERT INTO site_agent_v2_releases
        (id,site_agent_id,version,content_hash,release_json,created_at)
        VALUES (?,?,?,?,?,?)`)
        .bind(
          release.id,
          siteAgentId,
          release.version,
          release.contentHash,
          releaseJson,
          release.createdAt,
        ),
      database.prepare(`UPDATE site_agent_v2_agents
        SET profile_json=?,active_release_id=?,updated_at=?
        WHERE id=? AND active_release_id=?`)
        .bind(JSON.stringify(release.profile), release.id, now, siteAgentId, current.id),
      reviewInsert,
      database.prepare(`UPDATE site_agent_v2_capability_revisions
        SET status='published',revision_json=?,updated_at=?
        WHERE id=? AND project_id=? AND site_agent_id=?
          AND status='awaiting-review' AND revision_json=?`)
        .bind(
          JSON.stringify(publishedRevision),
          now,
          revision.id,
          projectId,
          siteAgentId,
          revisionRows[0].revisionJson,
        ),
      database.prepare(`UPDATE site_agent_v2_capability_projects
        SET intent_key=?,stable_key=?,contract_fingerprint=?,active_revision_id=?,latest_revision_id=?,
            status=?,project_json=?,created_at=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND latest_revision_id=? AND project_json=?`)
        .bind(
          publishedProject.intentKey,
          publishedProject.stableKey || null,
          publishedProject.contractFingerprint || null,
          publishedProject.activeRevisionId || null,
          publishedProject.latestRevisionId || null,
          publishedProject.status,
          JSON.stringify(publishedProject),
          publishedProject.createdAt,
          publishedProject.updatedAt,
          projectId,
          siteAgentId,
          revision.id,
          projectRows[0].projectJson,
        ),
      database.prepare(`UPDATE site_agent_v2_learning_jobs
        SET status='completed',result_json=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND status='awaiting-review' AND result_json=?`)
        .bind(
          JSON.stringify(completedJob),
          now,
          completedJob.id,
          siteAgentId,
          learningRows[0].jobJson,
        ),
      database.prepare(`DELETE FROM site_agent_v2_candidates
        WHERE id=? AND site_agent_id=? AND candidate_json=?`)
        .bind(candidate.id, siteAgentId, candidateRows[0].candidateJson),
      database.prepare(`INSERT INTO site_agent_v2_capability_events
        (id,project_id,revision_id,site_agent_id,type,status,event_json,created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .bind(
          event.id,
          event.projectId,
          event.revisionId || null,
          event.siteAgentId,
          event.type,
          event.status,
          JSON.stringify(event),
          event.createdAt,
        ),
      database.prepare(`INSERT OR REPLACE INTO site_agent_v2_meta
        (key,value,updated_at) VALUES (?,CASE WHEN
          (SELECT active_release_id FROM site_agent_v2_agents WHERE id=?)=?
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_releases
             WHERE id=? AND site_agent_id=?
               AND content_hash=? AND release_json=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_revision_reviews
            WHERE id=? AND status='approved' AND revision_id=?
              AND validation_run_id=? AND validated_content_hash=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_capability_revisions
            WHERE id=? AND project_id=? AND status='published'
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_capability_projects
            WHERE id=? AND active_revision_id=? AND latest_revision_id=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_learning_jobs
            WHERE id=? AND status='completed' AND result_json=?
          )
          AND NOT EXISTS (
            SELECT 1 FROM site_agent_v2_candidates WHERE id=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_validation_jobs
            WHERE id=? AND status='passed' AND job_json=?
          )
        THEN ? ELSE NULL END,?)`)
        .bind(
          guardKey,
          siteAgentId,
          release.id,
          release.id,
          siteAgentId,
          release.contentHash,
          releaseJson,
          review.id,
          revision.id,
          validationRunId,
          validatedContentHash,
          revision.id,
          projectId,
          projectId,
          revision.id,
          revision.id,
          completedJob.id,
          JSON.stringify(completedJob),
          candidate.id,
          validationRecord.job.id,
          validationRecord.row.jobJson,
          review.id,
          now,
        ),
      database.prepare(`DELETE FROM site_agent_v2_meta WHERE key=?`).bind(guardKey),
    ];
    let results;
    try {
      results = await database.batch(statements);
    } catch {
      throw new Error("revision_approval_conflict");
    }
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error("revision_approval_conflict");
    invalidateSiteAgentListCache();
    return {
      project: publishedProject,
      revision: publishedRevision,
      review,
      release,
      persistence: "d1" as const,
    };
  }

  const invalidatedValidation: ValidationJob = {
    ...validationRecord.job,
    invalidatedAt: now,
    invalidatedByReviewId: review.id,
    invalidatedReason: feedback,
    updatedAt: now,
  };
  const retryCandidate: KnowledgeCandidate = {
    ...candidate,
    capability: { ...candidate.capability, status: "learning", updatedAt: now },
    validation: { ...candidate.validation, status: "pending" },
    authoring: {
      ...(candidate.authoring || { stage: "designed", reusableTrace: false }),
      stage: "designed",
      reusableTrace: false,
      // Compatibility for runners deployed before AuthoringLease.reviewFeedback.
      reason: feedback,
    },
    updatedAt: now,
  };
  const retryJob = reviewRetryJob(learningJob, review, feedback, now);
  const retryRevision: CapabilityRevision = {
    ...revision,
    status: "building",
    stage: "author",
    validation: {
      status: "pending",
      input: validationRecord.job.validationCase.input,
      summary: feedback,
    },
    updatedAt: now,
  };
  const retryProject = capabilityProjectForWrite({
    ...project,
    status: project.activeRevisionId ? "available" : "building",
    stage: project.activeRevisionId ? project.stage : "author",
    latestRevisionId: revision.id,
    health: {
      ...project.health,
      failureClass: undefined,
      recommendedAction: undefined,
    },
    updatedAt: now,
  });
  const event = revisionReviewEvent(
    review,
    "Revision 人工审核驳回",
    feedback,
  );
  const guardKey = `revision_rejection_guard:${review.id}`;
  let results;
  try {
    results = await database.batch([
      reviewInsert,
    database.prepare(`UPDATE site_agent_v2_validation_jobs
      SET status='passed',lease_expires_at=NULL,job_json=?,updated_at=?
      WHERE id=? AND site_agent_id=? AND status='passed' AND job_json=?`)
      .bind(
        JSON.stringify(invalidatedValidation),
        now,
        invalidatedValidation.id,
        siteAgentId,
        validationRecord.row.jobJson,
      ),
    database.prepare(`UPDATE site_agent_v2_candidates
      SET status='pending',candidate_json=?,updated_at=?
      WHERE id=? AND site_agent_id=? AND status='awaiting-review' AND candidate_json=?`)
      .bind(
        JSON.stringify(retryCandidate),
        now,
        candidate.id,
        siteAgentId,
        candidateRows[0].candidateJson,
      ),
    database.prepare(`UPDATE site_agent_v2_learning_jobs
      SET status='queued',result_json=?,updated_at=?
      WHERE id=? AND site_agent_id=? AND status='awaiting-review' AND result_json=?`)
      .bind(
        JSON.stringify(retryJob),
        now,
        retryJob.id,
        siteAgentId,
        learningRows[0].jobJson,
      ),
    database.prepare(`UPDATE site_agent_v2_capability_revisions
      SET status='building',revision_json=?,updated_at=?
      WHERE id=? AND project_id=? AND site_agent_id=?
        AND status='awaiting-review' AND revision_json=?`)
      .bind(
        JSON.stringify(retryRevision),
        now,
        revision.id,
        projectId,
        siteAgentId,
        revisionRows[0].revisionJson,
      ),
    database.prepare(`UPDATE site_agent_v2_capability_projects
      SET intent_key=?,stable_key=?,contract_fingerprint=?,active_revision_id=?,latest_revision_id=?,
          status=?,project_json=?,created_at=?,updated_at=?
      WHERE id=? AND site_agent_id=? AND latest_revision_id=? AND project_json=?`)
      .bind(
        retryProject.intentKey,
        retryProject.stableKey || null,
        retryProject.contractFingerprint || null,
        retryProject.activeRevisionId || null,
        retryProject.latestRevisionId || null,
        retryProject.status,
        JSON.stringify(retryProject),
        retryProject.createdAt,
        retryProject.updatedAt,
        projectId,
        siteAgentId,
        revision.id,
        projectRows[0].projectJson,
      ),
    database.prepare(`INSERT INTO site_agent_v2_capability_events
      (id,project_id,revision_id,site_agent_id,type,status,event_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .bind(
        event.id,
        event.projectId,
        event.revisionId || null,
        event.siteAgentId,
        event.type,
        event.status,
        JSON.stringify(event),
        event.createdAt,
      ),
    database.prepare(`INSERT OR REPLACE INTO site_agent_v2_meta
      (key,value,updated_at) VALUES (?,CASE WHEN
        (SELECT active_release_id FROM site_agent_v2_agents WHERE id=?)=?
        AND EXISTS (
          SELECT 1 FROM site_agent_v2_revision_reviews
          WHERE id=? AND status='rejected' AND revision_id=?
            AND validation_run_id=? AND validated_content_hash=?
        )
        AND EXISTS (
          SELECT 1 FROM site_agent_v2_capability_revisions
          WHERE id=? AND project_id=? AND status='building'
        )
        AND EXISTS (
          SELECT 1 FROM site_agent_v2_capability_projects
          WHERE id=? AND latest_revision_id=?
        )
        AND EXISTS (
          SELECT 1 FROM site_agent_v2_learning_jobs
          WHERE id=? AND status='queued' AND result_json=?
        )
        AND EXISTS (
          SELECT 1 FROM site_agent_v2_candidates
          WHERE id=? AND status='pending' AND candidate_json=?
        )
        AND EXISTS (
          SELECT 1 FROM site_agent_v2_validation_jobs
          WHERE id=? AND status='passed' AND job_json=?
        )
      THEN ? ELSE NULL END,?)`)
      .bind(
        guardKey,
        siteAgentId,
        current.id,
        review.id,
        revision.id,
        validationRunId,
        validatedContentHash,
        revision.id,
        projectId,
        projectId,
        revision.id,
        retryJob.id,
        JSON.stringify(retryJob),
        retryCandidate.id,
        JSON.stringify(retryCandidate),
        invalidatedValidation.id,
        JSON.stringify(invalidatedValidation),
        review.id,
        now,
      ),
      database.prepare(`DELETE FROM site_agent_v2_meta WHERE key=?`).bind(guardKey),
    ]);
  } catch {
    throw new Error("revision_rejection_conflict");
  }
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error("revision_rejection_conflict");
  invalidateSiteAgentListCache();
  return {
    project: retryProject,
    revision: retryRevision,
    review,
    persistence: "d1" as const,
  };
}

function retryFailedAuthoringRevisionMemory(
  agent: MemoryAgent,
  projectId: string,
) {
  const project = agent.capabilityProjects.find((item) => item.id === projectId);
  const revision = agent.capabilityRevisions.find((item) =>
    item.id === project?.latestRevisionId && item.projectId === projectId);
  if (!project
    || !revision
    || revision.stage !== "author"
    || !["building", "failed"].includes(revision.status)
    || !revision.learningJobId
    || !revision.candidateId) {
    return undefined;
  }
  const job = agent.learningJobs.find((item) => item.id === revision.learningJobId);
  const candidate = agent.candidates.find((item) => item.id === revision.candidateId);
  if (!job || !candidate || job.candidateId !== candidate.id) {
    throw new Error("capability_revision_retry_conflict");
  }
  if (retryTupleAlreadyQueued(project, revision, candidate, job)) {
    return { project, revision, persistence: "memory" as const };
  }
  if (revision.status !== "failed"
    || job.status !== "failed"
    || job.phase !== "author"
    || candidate.validation.status !== "failed") {
    throw new Error("capability_revision_retry_conflict");
  }
  if (!agent.episodes.some((episode) => episode.id === job.sourceEpisodeId)) {
    throw new Error("learning_job_knowledge_missing");
  }
  if (agent.learningJobs.some((item) =>
    item.id !== job.id
    && item.intentKey === job.intentKey
    && ["queued", "leased", "running"].includes(item.status))) {
    throw new Error("capability_revision_retry_conflict");
  }
  const retry = failedAuthoringRetryState(
    project,
    revision,
    candidate,
    job,
    new Date().toISOString(),
  );
  agent.capabilityProjects = agent.capabilityProjects.map((item) =>
    item.id === project.id ? retry.project : item);
  agent.capabilityRevisions = agent.capabilityRevisions.map((item) =>
    item.id === revision.id ? retry.revision : item);
  agent.candidates = agent.candidates.map((item) =>
    item.id === candidate.id ? retry.candidate : item);
  agent.learningJobs = agent.learningJobs.map((item) =>
    item.id === job.id ? retry.job : item);
  agent.capabilityEvents.push(retry.event);
  return {
    project: retry.project,
    revision: retry.revision,
    persistence: "memory" as const,
  };
}

async function loadAuthoringRetryTupleD1(
  database: D1DatabaseLike,
  siteAgentId: string,
  projectId: string,
) {
  const projectRows = await all<{ status: string; projectJson: string }>(
    database,
    `SELECT status,project_json AS projectJson
       FROM site_agent_v2_capability_projects
      WHERE id=? AND site_agent_id=? LIMIT 1`,
    [projectId, siteAgentId],
  );
  if (!projectRows[0]) return undefined;
  const project = projectWithIdentityDefaults(
    JSON.parse(projectRows[0].projectJson) as CapabilityProject,
  );
  if (!project.latestRevisionId) return undefined;
  const revisionRows = await all<{ status: string; revisionJson: string }>(
    database,
    `SELECT status,revision_json AS revisionJson
       FROM site_agent_v2_capability_revisions
      WHERE id=? AND project_id=? AND site_agent_id=? LIMIT 1`,
    [project.latestRevisionId, projectId, siteAgentId],
  );
  if (!revisionRows[0]) return undefined;
  const revision = JSON.parse(revisionRows[0].revisionJson) as CapabilityRevision;
  if (revision.stage !== "author"
    || !["building", "failed"].includes(revision.status)
    || !revision.learningJobId
    || !revision.candidateId) {
    return undefined;
  }
  const [jobRows, candidateRows, episodeRows] = await Promise.all([
    all<{ status: string; jobJson: string }>(
      database,
      `SELECT status,result_json AS jobJson
         FROM site_agent_v2_learning_jobs
        WHERE id=? AND site_agent_id=? LIMIT 1`,
      [revision.learningJobId, siteAgentId],
    ),
    all<{ status: string; candidateJson: string }>(
      database,
      `SELECT status,candidate_json AS candidateJson
         FROM site_agent_v2_candidates
        WHERE id=? AND site_agent_id=? LIMIT 1`,
      [revision.candidateId, siteAgentId],
    ),
    all<{ id: string }>(
      database,
      `SELECT id FROM site_agent_v2_episodes
        WHERE id=(SELECT json_extract(result_json,'$.sourceEpisodeId')
                    FROM site_agent_v2_learning_jobs
                   WHERE id=? AND site_agent_id=?)
          AND site_agent_id=? LIMIT 1`,
      [revision.learningJobId, siteAgentId, siteAgentId],
    ),
  ]);
  if (!jobRows[0] || !candidateRows[0]) {
    throw new Error("capability_revision_retry_conflict");
  }
  const job = JSON.parse(jobRows[0].jobJson) as LearningJob;
  const candidate = JSON.parse(candidateRows[0].candidateJson) as KnowledgeCandidate;
  return {
    project,
    projectRow: projectRows[0],
    revision,
    revisionRow: revisionRows[0],
    job,
    jobRow: jobRows[0],
    candidate,
    candidateRow: candidateRows[0],
    sourceEpisodeExists: Boolean(episodeRows[0]),
  };
}

async function retryFailedAuthoringRevisionD1(
  database: D1DatabaseLike,
  siteAgentId: string,
  projectId: string,
) {
  const tuple = await loadAuthoringRetryTupleD1(database, siteAgentId, projectId);
  if (!tuple) return undefined;
  const { project, revision, candidate, job } = tuple;
  if (revision.candidateId !== candidate.id
    || revision.learningJobId !== job.id
    || job.candidateId !== candidate.id) {
    throw new Error("capability_revision_retry_conflict");
  }
  if (retryTupleAlreadyQueued(project, revision, candidate, job)) {
    return {
      project,
      revision,
      persistence: "d1" as const,
    };
  }
  if (!["building", "failed"].includes(tuple.revisionRow.status)
    || !["building", "failed"].includes(revision.status)
    || tuple.jobRow.status !== "failed"
    || job.status !== "failed"
    || job.phase !== "author"
    || tuple.candidateRow.status !== "failed"
    || candidate.validation.status !== "failed") {
    throw new Error("capability_revision_retry_conflict");
  }
  if (!tuple.sourceEpisodeExists) throw new Error("learning_job_knowledge_missing");
  const competingRows = await all<{ count: number | string }>(
    database,
    `SELECT COUNT(*) AS count
       FROM site_agent_v2_learning_jobs
      WHERE site_agent_id=? AND id<>? AND status IN ('queued','leased','running')
        AND json_extract(result_json,'$.intentKey')=?`,
    [siteAgentId, job.id, job.intentKey || project.intentKey],
  );
  if (Number(competingRows[0]?.count || 0) > 0) {
    throw new Error("capability_revision_retry_conflict");
  }
  const now = new Date().toISOString();
  const retry = failedAuthoringRetryState(project, revision, candidate, job, now);
  const guardKey = `authoring_retry_guard:${revision.id}:${uid("retry")}`;
  let results;
  try {
    results = await database.batch([
      database.prepare(`INSERT OR REPLACE INTO site_agent_v2_meta
        (key,value,updated_at) VALUES (?,CASE WHEN
          EXISTS (
            SELECT 1 FROM site_agent_v2_capability_projects
             WHERE id=? AND site_agent_id=? AND latest_revision_id=? AND project_json=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_capability_revisions
             WHERE id=? AND project_id=? AND site_agent_id=?
               AND status IN ('building','failed') AND revision_json=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_learning_jobs
             WHERE id=? AND site_agent_id=? AND status='failed' AND result_json=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_candidates
             WHERE id=? AND site_agent_id=? AND status='failed' AND candidate_json=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_episodes WHERE id=? AND site_agent_id=?
          )
          AND NOT EXISTS (
            SELECT 1 FROM site_agent_v2_learning_jobs
             WHERE site_agent_id=? AND id<>? AND status IN ('queued','leased','running')
               AND json_extract(result_json,'$.intentKey')=?
          )
        THEN ? ELSE NULL END,?)`)
        .bind(
          guardKey,
          project.id,
          siteAgentId,
          revision.id,
          tuple.projectRow.projectJson,
          revision.id,
          project.id,
          siteAgentId,
          tuple.revisionRow.revisionJson,
          job.id,
          siteAgentId,
          tuple.jobRow.jobJson,
          candidate.id,
          siteAgentId,
          tuple.candidateRow.candidateJson,
          job.sourceEpisodeId,
          siteAgentId,
          siteAgentId,
          job.id,
          job.intentKey || project.intentKey,
          revision.id,
          now,
        ),
      database.prepare(`UPDATE site_agent_v2_candidates
        SET status='pending',candidate_json=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND status='failed' AND candidate_json=?`)
        .bind(
          JSON.stringify(retry.candidate),
          now,
          candidate.id,
          siteAgentId,
          tuple.candidateRow.candidateJson,
        ),
      database.prepare(`UPDATE site_agent_v2_learning_jobs
        SET status='queued',result_json=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND status='failed' AND result_json=?`)
        .bind(
          JSON.stringify(retry.job),
          now,
          job.id,
          siteAgentId,
          tuple.jobRow.jobJson,
        ),
      database.prepare(`UPDATE site_agent_v2_capability_revisions
        SET status='building',revision_json=?,updated_at=?
        WHERE id=? AND project_id=? AND site_agent_id=?
          AND status IN ('building','failed') AND revision_json=?`)
        .bind(
          JSON.stringify(retry.revision),
          now,
          revision.id,
          project.id,
          siteAgentId,
          tuple.revisionRow.revisionJson,
        ),
      database.prepare(`UPDATE site_agent_v2_capability_projects
        SET intent_key=?,stable_key=?,contract_fingerprint=?,active_revision_id=?,latest_revision_id=?,
            status=?,project_json=?,created_at=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND latest_revision_id=? AND project_json=?`)
        .bind(
          retry.project.intentKey,
          retry.project.stableKey || null,
          retry.project.contractFingerprint || null,
          retry.project.activeRevisionId || null,
          retry.project.latestRevisionId || null,
          retry.project.status,
          JSON.stringify(retry.project),
          retry.project.createdAt,
          retry.project.updatedAt,
          project.id,
          siteAgentId,
          revision.id,
          tuple.projectRow.projectJson,
        ),
      database.prepare(`INSERT INTO site_agent_v2_capability_events
        (id,project_id,revision_id,site_agent_id,type,status,event_json,created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .bind(
          retry.event.id,
          retry.event.projectId,
          retry.event.revisionId || null,
          retry.event.siteAgentId,
          retry.event.type,
          retry.event.status,
          JSON.stringify(retry.event),
          retry.event.createdAt,
        ),
      database.prepare(`INSERT OR REPLACE INTO site_agent_v2_meta
        (key,value,updated_at) VALUES (?,CASE WHEN
          EXISTS (
            SELECT 1 FROM site_agent_v2_capability_projects
             WHERE id=? AND site_agent_id=? AND latest_revision_id=? AND project_json=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_capability_revisions
             WHERE id=? AND project_id=? AND site_agent_id=?
               AND status='building' AND revision_json=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_learning_jobs
             WHERE id=? AND site_agent_id=? AND status='queued' AND result_json=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_candidates
             WHERE id=? AND site_agent_id=? AND status='pending' AND candidate_json=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_capability_events WHERE id=?
          )
        THEN ? ELSE NULL END,?)`)
        .bind(
          guardKey,
          retry.project.id,
          siteAgentId,
          retry.revision.id,
          JSON.stringify(retry.project),
          retry.revision.id,
          retry.project.id,
          siteAgentId,
          JSON.stringify(retry.revision),
          retry.job.id,
          siteAgentId,
          JSON.stringify(retry.job),
          retry.candidate.id,
          siteAgentId,
          JSON.stringify(retry.candidate),
          retry.event.id,
          retry.revision.id,
          now,
        ),
      database.prepare(`DELETE FROM site_agent_v2_meta WHERE key=?`).bind(guardKey),
    ]);
  } catch {
    const current = await loadAuthoringRetryTupleD1(database, siteAgentId, projectId);
    if (current && retryTupleAlreadyQueued(
      current.project,
      current.revision,
      current.candidate,
      current.job,
    )) {
      return {
        project: current.project,
        revision: current.revision,
        persistence: "d1" as const,
      };
    }
    throw new Error("capability_revision_retry_conflict");
  }
  const failure = results.find((result) => !result.success);
  if (failure) {
    const current = await loadAuthoringRetryTupleD1(database, siteAgentId, projectId);
    if (current && retryTupleAlreadyQueued(
      current.project,
      current.revision,
      current.candidate,
      current.job,
    )) {
      return {
        project: current.project,
        revision: current.revision,
        persistence: "d1" as const,
      };
    }
    throw new Error("capability_revision_retry_conflict");
  }
  invalidateSiteAgentListCache();
  return {
    project: retry.project,
    revision: retry.revision,
    persistence: "d1" as const,
  };
}

export async function actOnCapabilityProject(siteAgentId: string, projectId: string, input: {
  action: string;
  text?: string;
  exposure?: "public" | "internal";
  patch?: ContractPatch;
  spec?: Partial<CapabilitySpecDoc>;
  revisionId?: string;
  validationRunId?: string;
  validatedContentHash?: string;
}) {
  const detailResult = await getCapabilityProjectDetail(siteAgentId, projectId);
  if (!detailResult.detail) throw new Error("capability_project_not_found");
  const {
    project,
    deletion,
    revisions,
    sourceEpisodes,
    specDoc,
  } = detailResult.detail;
  const selectedRevision = revisions.find((item) => item.id === project.activeRevisionId) || revisions[0];
  const contract = selectedRevision
    ? readableRevisionContract(project, selectedRevision)
    : capabilityContractFromProject(project);
  if (input.action === "delete") {
    assertCapabilityProjectDeletable(deletion);
    const database = getD1Binding();
    if (!database) {
      memoryDeleteCapabilityProject(
        memoryAgent(siteAgentId),
        siteAgentId,
        projectId,
      );
      return { deleted: true, persistence: "memory" as const };
    }
    await d1DeleteCapabilityProject(database, siteAgentId, projectId);
    return {
      deleted: true,
      persistence: "d1" as const,
    };
  }
  if (!contract
    && !["set-exposure", "archive", "restore"].includes(input.action)) {
    throw new Error("capability_contract_not_found");
  }
  const database = getD1Binding();
  if (input.action === "approve-revision" || input.action === "reject-revision") {
    const expected = {
      revisionId: input.revisionId,
      validationRunId: input.validationRunId,
      validatedContentHash: input.validatedContentHash,
    };
    return database
      ? actOnRevisionReviewD1(
          database,
          siteAgentId,
          projectId,
          input.action,
          expected,
          input.text,
        )
      : actOnRevisionReviewMemory(
          memoryAgent(siteAgentId),
          siteAgentId,
          projectId,
          input.action,
          expected,
          input.text,
        );
  }
  if (input.action === "request-demonstration") return createTaskLaunch({ siteAgentId, projectId, goal: project.goalTemplate, input: {}, mode: "demonstrate" });
  if (input.action === "design-spec") {
    const episode = (sourceEpisodes || []).find((item) => item.outcome.status === "success") || (sourceEpisodes || [])[0];
    if (!episode) throw new Error("demonstration_required");
    const revisionId = project.latestRevisionId || project.activeRevisionId || `revision_${stableHash(`${projectId}:spec`)}`;
    const spec = await designCapabilitySpec(episode, { siteAgentId, capability: { description: project.description } }, { siteAgentId, projectId, revisionId, existingIntents: [] });
    if (!spec) throw new Error("spec_design_unavailable");
    const saved = await saveCapabilitySpecDoc(spec);
    return { specDoc: saved.specDoc, persistence: saved.persistence };
  }
  if (input.action === "patch-spec") {
    if (!specDoc) throw new Error("spec_not_found");
    const patch = input.spec || {};
    const now = new Date().toISOString();
    const merged: CapabilitySpecDoc = {
      ...specDoc,
      intent: typeof patch.intent === "string" ? patch.intent.slice(0, 2_000) : specDoc.intent,
      whenToUse: typeof patch.whenToUse === "string" ? patch.whenToUse.slice(0, 2_000) : specDoc.whenToUse,
      inputsNarrative: typeof patch.inputsNarrative === "string" ? patch.inputsNarrative.slice(0, 4_000) : specDoc.inputsNarrative,
      resultNarrative: typeof patch.resultNarrative === "string" ? patch.resultNarrative.slice(0, 4_000) : specDoc.resultNarrative,
      scenarios: Array.isArray(patch.scenarios) ? patch.scenarios.slice(0, 20) : specDoc.scenarios,
      nonGoals: Array.isArray(patch.nonGoals) ? patch.nonGoals.slice(0, 20).map((item) => String(item).slice(0, 500)) : specDoc.nonGoals,
      openQuestions: Array.isArray(patch.openQuestions) ? patch.openQuestions.slice(0, 20).map((item) => String(item).slice(0, 500)) : specDoc.openQuestions,
      source: "human",
      updatedAt: now,
    };
    const saved = await saveCapabilitySpecDoc(merged);
    return { specDoc: saved.specDoc, persistence: saved.persistence };
  }
  if (!database) {
    const agent = memoryAgent(siteAgentId);
    if (input.action === "set-exposure") {
      if (!project.activeCapabilityId || (input.exposure !== "public" && input.exposure !== "internal")) throw new Error("capability_exposure_invalid");
      const now = new Date().toISOString();
      setMemoryRelease(agent, releaseWithCapabilityExposure(agent.release, capabilityIdsForExposure(project), input.exposure, now, uid("release_operation")));
      const updated = { ...project, exposure: input.exposure, updatedAt: now };
      agent.capabilityProjects = agent.capabilityProjects.map((item) => item.id === projectId ? updated : item);
      return { project: updated, release: agent.release, persistence: "memory" as const };
    }
    if (input.action === "unpublish") {
      if (project.status !== "available"
        || !project.activeCapabilityId
        || project.activeCapabilityId !== project.canonicalCapabilityId) {
        throw new Error("capability_unpublish_last_good_required");
      }
      const revision = publishedLifecycleRevision(project, revisions);
      const publishedRelease = memoryReleaseById(
        agent,
        revision.publishedReleaseId!,
      );
      if (!publishedRelease) throw new Error("capability_last_good_missing");
      const lastGoodContract = exactLastGoodContract(
        project,
        revision,
        publishedRelease,
      );
      if (!agent.release.capabilities.some((item) =>
        item.id === lastGoodContract.id)) {
        throw new Error("capability_not_published");
      }
      const now = new Date().toISOString();
      const operationId = uid("release_operation");
      const suppression = suppressionForProject(project, lastGoodContract, now);
      agent.capabilitySuppressions = [
        ...agent.capabilitySuppressions.filter((item) => item.id !== suppression.id),
        suppression,
      ];
      setMemoryRelease(agent, releaseWithSuppression(agent.release, suppression, now, operationId));
      agent.learningJobs = agent.learningJobs.map((job) =>
        job.intentKey === project.intentKey && !["completed", "failed", "cancelled"].includes(job.status)
          ? { ...job, status: "cancelled", lease: undefined, failure: { code: "capability_unpublished", summary: suppression.reason }, updatedAt: now }
          : job);
      agent.validationJobs = agent.validationJobs.map((job) =>
        agent.learningJobs.some((learning) => learning.id === job.learningJobId && learning.failure?.code === "capability_unpublished")
          ? { ...job, status: "cancelled", lease: undefined, failure: { code: "capability_unpublished", summary: suppression.reason }, updatedAt: now }
          : job);
      const unpublished = capabilityProjectForWrite({
        ...project,
        canonicalCapabilityId: lastGoodContract.id,
        status: "unpublished" as const,
        activeCapabilityId: undefined,
        autoGenerationBlocked: true,
        unpublishedAt: now,
        updatedAt: now,
      });
      agent.capabilityProjects = agent.capabilityProjects.map((item) => item.id === projectId ? unpublished : item);
      agent.capabilityEvents.push({ id: uid("event"), siteAgentId, projectId, type: "archive", actor: "user", status: "info", title: "能力已下架", summary: suppression.reason, evidence: { suppressionId: suppression.id, releaseVersion: agent.release.version }, createdAt: now });
      return { project: unpublished, release: agent.release, suppression, persistence: "memory" as const };
    }
    if (input.action === "relist") {
      if (project.status !== "unpublished" || project.activeCapabilityId) {
        throw new Error("capability_relist_unpublished_required");
      }
      const revision = publishedLifecycleRevision(project, revisions);
      const publishedRelease = memoryReleaseById(
        agent,
        revision.publishedReleaseId!,
      );
      if (!publishedRelease) throw new Error("capability_last_good_missing");
      const lastGoodContract = exactLastGoodContract(
        project,
        revision,
        publishedRelease,
      );
      const now = new Date().toISOString();
      const operationId = uid("release_operation");
      const suppression = agent.capabilitySuppressions.find((item) => item.projectId === projectId && item.status === "active");
      if (!suppression) throw new Error("capability_suppression_not_found");
      agent.capabilitySuppressions = agent.capabilitySuppressions.map((item) => item.id === suppression.id ? { ...item, status: "revoked", revokedAt: now } : item);
      setMemoryRelease(agent, releaseWithRelistedCapability(
        agent.release,
        lastGoodContract,
        now,
        operationId,
      ));
      const relisted = capabilityProjectForWrite({
        ...project,
        status: "available" as const,
        canonicalCapabilityId: lastGoodContract.id,
        activeCapabilityId: lastGoodContract.id,
        autoGenerationBlocked: false,
        unpublishedAt: undefined,
        updatedAt: now,
      });
      agent.capabilityProjects = agent.capabilityProjects.map((item) => item.id === projectId ? relisted : item);
      agent.capabilityEvents.push({ id: uid("event"), siteAgentId, projectId, type: "publish", actor: "user", status: "passed", title: "能力已重新上架", summary: "管理员撤销了自动生成抑制，并恢复最后一个已验证版本。", evidence: { suppressionId: suppression.id, releaseVersion: agent.release.version }, createdAt: now });
      return { project: relisted, release: agent.release, persistence: "memory" as const };
    }
    if (input.action === "archive") {
      const current = agent.capabilityProjects.find((item) =>
        item.id === projectId);
      if (!current || current.status === "archived") {
        throw new Error("capability_project_conflict");
      }
      const now = new Date().toISOString();
      const archived = capabilityProjectForWrite({
        ...current,
        archivedFromStatus: current.status,
        status: "archived" as const,
        updatedAt: now,
      });
      agent.capabilityProjects = agent.capabilityProjects.map((item) =>
        item.id === projectId ? archived : item);
      agent.capabilityEvents.push({
        id: uid("event"),
        siteAgentId,
        projectId,
        type: "archive",
        actor: "user",
        status: "info",
        title: "能力项目已归档",
        summary: "能力已停用并归档；能力中心仍保留版本、运行与审核证据，可按状态筛选。",
        createdAt: now,
      });
      return { project: archived, persistence: "memory" as const };
    }
    if (input.action === "restore") {
      const current = agent.capabilityProjects.find((item) =>
        item.id === projectId);
      if (!current || current.status !== "archived") {
        throw new Error("capability_project_conflict");
      }
      const now = new Date().toISOString();
      const restored = capabilityProjectForWrite({
        ...current,
        status: current.archivedFromStatus
          || (current.activeCapabilityId ? "available" as const : "building" as const),
        archivedFromStatus: undefined,
        updatedAt: now,
      });
      agent.capabilityProjects = agent.capabilityProjects.map((item) =>
        item.id === projectId ? restored : item);
      agent.capabilityEvents.push({
        id: uid("event"),
        siteAgentId,
        projectId,
        type: "archive",
        actor: "user",
        status: "info",
        title: "能力项目已恢复",
        summary: "能力重新出现在能力中心；历史版本和证据保持不变。",
        createdAt: now,
      });
      return { project: restored, persistence: "memory" as const };
    }
    if (input.action === "retry-validation") {
      const revision = revisions.find((item) => item.validation?.status === "failed" && item.learningJobId);
      if (!revision || !retryableValidationRevision(revision)) throw new Error("validation_retry_requires_reauthoring");
      const candidate = agent.candidates.find((item) => item.id === revision.candidateId);
      const learning = agent.learningJobs.find((item) => item.id === revision.learningJobId);
      const episode = agent.episodes.find((item) => item.id === learning?.sourceEpisodeId);
      if (!candidate || !learning) throw new Error("validation_retry_unavailable");
      const now = new Date().toISOString();
      agent.validationJobs = agent.validationJobs.map((item) => item.learningJobId === revision.learningJobId ? {
        ...item,
        status: "queued",
        lease: undefined,
        failure: undefined,
        validationCase: {
          ...item.validationCase,
          startUrl: refreshedValidationStartUrl(
            agent.release,
            candidate,
            item,
            [episode?.startSnapshot.url, agent.connection?.url, ...validationRetryReceiptStartUrls(learning)],
            episode?.endSnapshot.url,
          ),
        },
        updatedAt: now,
      } : item);
      const retryRevision: CapabilityRevision = {
        ...revision,
        status: "building",
        stage: "validate",
        validation: { ...revision.validation, status: "pending", failureClass: undefined },
        updatedAt: now,
      };
      agent.capabilityRevisions = agent.capabilityRevisions.map((item) =>
        item.id === retryRevision.id ? retryRevision : item);
      agent.learningJobs = agent.learningJobs.map((item) => item.id === learning.id ? {
        ...item,
        phase: "validate",
        status: "queued",
        lease: undefined,
        failure: undefined,
        updatedAt: now,
      } : item);
      const retryProject = capabilityProjectForWrite({
        ...project,
        status: project.activeCapabilityId ? "available" : "building",
        stage: project.activeCapabilityId ? project.stage : "validate",
        health: { ...project.health, failureClass: undefined, recommendedAction: undefined },
        updatedAt: now,
      });
      agent.capabilityProjects = agent.capabilityProjects.map((item) =>
        item.id === retryProject.id ? retryProject : item);
      return { project: retryProject, revision: retryRevision, persistence: "memory" as const };
    }
    if (input.action === "re-explore") {
      const retried = retryFailedAuthoringRevisionMemory(agent, projectId);
      if (retried) return retried;
    }
    if (input.action === "patch-contract") throw new Error("capability_contract_patch_not_supported");
    if (!["guide", "re-explore"].includes(input.action)) throw new Error("capability_action_invalid");
    const guidanceText = input.action === "guide" ? String(input.text || "").trim().slice(0, 2_000) : undefined;
    if (input.action === "guide" && !guidanceText) throw new Error("guidance_text_required");
    const nextContract = contract;
    assertStableCapabilityIdentity(project, nextContract, contract.outcomes);
    validateProjectContract(nextContract);
    const goals = new Set([nextContract.normalizedGoal, normalizeGoal(nextContract.name), normalizeGoal(nextContract.goalTemplate || ""), ...nextContract.aliases.map(normalizeGoal)]);
    const episode = agent.episodes.find((item) => nextContract.sourceEpisodeIds.includes(item.id)) || agent.episodes.find((item) => item.outcome.status === "success" && goals.has(item.normalizedGoal));
    if (!episode) throw new Error("demonstration_required");
    const now = new Date().toISOString();
    const candidateId = uid("candidate");
    const revisionNumber = Math.max(
      project.revisionCount || 0,
      ...agent.capabilityRevisions
        .filter((item) => item.projectId === projectId)
        .map((item) => item.number),
    ) + 1;
    const requiredInputs = Object.entries(nextContract.inputs.properties || {}).map(([id, schema]) => ({ id, name: schema.description || id, type: schema.type === "number" || schema.type === "boolean" ? schema.type : "string" as const, value: projectInputValue(episode, id) as string | number | boolean | undefined }));
    const candidate: KnowledgeCandidate = {
      id: candidateId, siteAgentId, normalizedGoal: normalizeGoal(nextContract.goalTemplate || nextContract.name), baseReleaseVersion: agent.release.version, scenes: agent.release.scenes, targets: [], operations: [], capability: { ...nextContract, status: "learning", exposure: nextContract.exposure || "public", updatedAt: now },
      validation: { status: "pending", attempts: 0, successfulReplays: 0, requiredReplays: 1 }, sourceEpisodeIds: [...new Set([...nextContract.sourceEpisodeIds, episode.id])], createdAt: now, updatedAt: now,
      authoring: { stage: "designed", reusableTrace: false, intentKey: project.intentKey, capabilityKind: nextContract.kind, reason: guidanceText ? `人工指导：${guidanceText}` : "使用最新网站知识重新探索并编写程序", goalTemplate: nextContract.goalTemplate || nextContract.name, requiredInputs, parameterizationDecisions: requiredInputs.flatMap((field) => field.value === undefined ? [] : [{ id: `parameter_${stableHash(`${candidateId}:${field.id}:${String(field.value)}`)}`, observedValue: field.value, evidence: "来自该能力的真实成功经验", decision: "input" as const, inputId: field.id, reason: `保留为业务输入 ${field.name}` }]), resultFields: Object.entries(nextContract.outputs.properties || {}).map(([id, schema]) => ({ id, name: schema.description || id, type: schema.type, description: schema.description, source: META_OUTPUTS_FOR_STORE.has(id) ? id === "pageUrl" ? "page-url" as const : id === "pageTitle" ? "page-title" as const : "page-heading" as const : "extracted" as const, importance: META_OUTPUTS_FOR_STORE.has(id) ? "metadata" as const : nextContract.outputs.required?.includes(id) ? "core" as const : "optional" as const })) },
    };
    const job: LearningJob = { id: uid("learning"), siteAgentId, taskSessionId: episode.taskSessionId, sourceEpisodeId: episode.id, candidateId, origin: project.origin, phase: "author", status: "queued", attempts: 0, intentKey: project.intentKey, goalTemplate: candidate.authoring?.goalTemplate, receipts: [{ id: uid("receipt"), stage: "evidence", actor: "program", status: "passed", title: "复用已有真实经验", summary: episode.outcome.summary, startedAt: episode.startedAt, endedAt: episode.endedAt }, { id: uid("receipt"), stage: "design", actor: "ai", status: "passed", title: guidanceText ? "能力契约已结合人工指导更新" : "能力契约已创建新 Revision", summary: guidanceText || "将使用最新网站知识重新设计实现。", startedAt: now, endedAt: now }, { id: uid("receipt"), stage: "author", actor: "ai", status: "queued", title: "等待 AI 重新探索并编写", summary: "线上版本保持不变。", startedAt: now }], result: { source: "capability-control", rawExperienceOnly: true, projectId }, createdAt: now, updatedAt: now };
    const revisionId = `revision_${stableHash(`${projectId}:${job.id}`)}`;
    job.result = { ...job.result, revisionId };
    const revision: CapabilityRevision = {
      id: revisionId,
      projectId,
      siteAgentId,
      number: revisionNumber,
      status: "building",
      stage: "author",
      baseReleaseVersion: agent.release.version,
      implementationReleaseId: agent.release.id,
      implementationReleaseVersion: agent.release.version,
      candidateId,
      learningJobId: job.id,
      parameterizationDecisions: candidate.authoring?.parameterizationDecisions || [],
      implementation: revisionImplementationForCapability(agent.release, nextContract),
      validation: { status: "pending" },
      guidanceIds: [],
      createdAt: now,
      updatedAt: now,
    };
    const updatedProject = capabilityProjectForWrite({
      ...project,
      status: project.activeRevisionId ? project.status : "building",
      stage: project.activeRevisionId ? project.stage : "author",
      latestRevisionId: revision.id,
      revisionCount: revision.number,
      buildStartedAt: project.buildStartedAt || now,
      updatedAt: now,
    });
    agent.candidates.push(candidate);
    agent.learningJobs.push(job);
    agent.capabilityRevisions.push(revision);
    agent.capabilityProjects = agent.capabilityProjects.map((item) =>
      item.id === projectId ? updatedProject : item);
    if (guidanceText) agent.capabilityEvents.push({ id: uid("event"), siteAgentId, projectId, revisionId: `revision_${stableHash(`${projectId}:${job.id}`)}`, type: "guidance", actor: "user", status: "info", title: "开发者补充了 AI 编写指导", summary: guidanceText, createdAt: now });
    return { project: updatedProject, revision, persistence: "memory" as const };
  }
  if (input.action === "set-exposure") {
    if (!project.activeCapabilityId || (input.exposure !== "public" && input.exposure !== "internal")) throw new Error("capability_exposure_invalid");
    const now = new Date().toISOString();
    const current = await d1Release(database, siteAgentId);
    if (!current) throw new Error("site_agent_release_missing");
    const release = releaseWithCapabilityExposure(current, capabilityIdsForExposure(project), input.exposure, now, uid("release_operation"));
    const updated = capabilityProjectForWrite({
      ...project,
      exposure: input.exposure,
      updatedAt: now,
    });
    const guardKey = `capability_exposure_guard:${release.id}`;
    const event: CapabilityEvent = {
      id: uid("event"), siteAgentId, projectId, revisionId: project.activeRevisionId,
      type: "publish", actor: "user", status: "info",
      title: input.exposure === "public" ? "能力已设为公开" : "能力已设为内部",
      summary: input.exposure === "public"
        ? "该能力会进入网站 Agent 的公开能力目录与推荐。"
        : "该能力仍可作为内部依赖和管理调试使用，但不会进入公开能力目录与推荐。",
      evidence: { exposure: input.exposure, releaseVersion: release.version },
      createdAt: now,
    };
    const results = await database.batch([
      database.prepare(`INSERT OR IGNORE INTO site_agent_v2_releases (id,site_agent_id,version,content_hash,release_json,created_at) VALUES (?,?,?,?,?,?)`)
        .bind(release.id, siteAgentId, release.version, release.contentHash, JSON.stringify(release), now),
      database.prepare(`INSERT OR REPLACE INTO site_agent_v2_meta (key,value,updated_at)
        SELECT ?,?,? WHERE EXISTS (
          SELECT 1 FROM site_agent_v2_agents
           WHERE id=? AND active_release_id=?
        ) AND EXISTS (
          SELECT 1 FROM site_agent_v2_capability_projects
           WHERE id=? AND site_agent_id=? AND status='available'
             AND active_revision_id=?
             AND json_extract(project_json,'$.activeCapabilityId')=?
        )`)
        .bind(
          guardKey,
          current.id,
          now,
          siteAgentId,
          current.id,
          projectId,
          siteAgentId,
          project.activeRevisionId || null,
          project.activeCapabilityId,
        ),
      database.prepare(`UPDATE site_agent_v2_capability_projects
        SET project_json=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND status='available'
          AND active_revision_id=?
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_meta WHERE key=? AND value=?
          )`)
        .bind(
          JSON.stringify(updated),
          now,
          projectId,
          siteAgentId,
          project.activeRevisionId || null,
          guardKey,
          current.id,
        ),
      database.prepare(`UPDATE site_agent_v2_agents
        SET profile_json=?,active_release_id=?,updated_at=?
        WHERE id=? AND active_release_id=?
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_meta WHERE key=? AND value=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_capability_projects
             WHERE id=? AND site_agent_id=? AND project_json=?
          )`)
        .bind(
          JSON.stringify(release.profile),
          release.id,
          now,
          siteAgentId,
          current.id,
          guardKey,
          current.id,
          projectId,
          siteAgentId,
          JSON.stringify(updated),
        ),
      database.prepare(`INSERT INTO site_agent_v2_capability_events
        (id,project_id,revision_id,site_agent_id,type,status,event_json,created_at)
        SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (
          SELECT 1 FROM site_agent_v2_meta WHERE key=? AND value=?
        ) AND EXISTS (
          SELECT 1 FROM site_agent_v2_agents WHERE id=? AND active_release_id=?
        )`)
        .bind(
          event.id,
          projectId,
          event.revisionId || null,
          siteAgentId,
          event.type,
          event.status,
          JSON.stringify(event),
          now,
          guardKey,
          current.id,
          siteAgentId,
          release.id,
        ),
      database.prepare(`DELETE FROM site_agent_v2_meta WHERE key=? AND value=?`)
        .bind(guardKey, current.id),
    ]);
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "capability_exposure_update_failed");
    if ([1, 2, 3, 4].some((index) =>
      Number(results[index]?.meta?.changes || 0) !== 1)) {
      throw new Error("capability_release_conflict");
    }
    invalidateSiteAgentListCache();
    return { project: updated, release, persistence: "d1" as const };
  }
  if (input.action === "unpublish") {
    if (project.status !== "available"
      || !project.activeCapabilityId
      || project.activeCapabilityId !== project.canonicalCapabilityId) {
      throw new Error("capability_unpublish_last_good_required");
    }
    const revision = publishedLifecycleRevision(project, revisions);
    const publishedRelease = await d1ReleaseById(
      database,
      siteAgentId,
      revision.publishedReleaseId!,
    );
    if (!publishedRelease) throw new Error("capability_last_good_missing");
    const lastGoodContract = exactLastGoodContract(
      project,
      revision,
      publishedRelease,
    );
    const now = new Date().toISOString();
    const operationId = uid("release_operation");
    const current = await d1Release(database, siteAgentId);
    if (!current) throw new Error("site_agent_release_missing");
    if (!current.capabilities.some((item) =>
      item.id === lastGoodContract.id)) {
      throw new Error("capability_not_published");
    }
    const suppression = suppressionForProject(
      project,
      lastGoodContract,
      now,
    );
    const release = releaseWithSuppression(current, suppression, now, operationId);
    const unpublished: CapabilityProject = capabilityProjectForWrite({
      ...project,
      canonicalCapabilityId: lastGoodContract.id,
      status: "unpublished",
      activeCapabilityId: undefined,
      autoGenerationBlocked: true,
      unpublishedAt: now,
      updatedAt: now,
    });
    const event: CapabilityEvent = {
      id: uid("event"),
      siteAgentId,
      projectId,
      type: "archive",
      actor: "user",
      status: "info",
      title: "能力已下架",
      summary: suppression.reason,
      evidence: { suppressionId: suppression.id, releaseVersion: release.version },
      createdAt: now,
    };
    const activeJobRows = await all<LearningJobRow>(
      database,
      `SELECT result_json AS jobJson FROM site_agent_v2_learning_jobs
        WHERE site_agent_id=? AND status IN ('queued','leased','running')`,
      [siteAgentId],
    );
    const cancelledJobs = activeJobRows
      .map((row) => ({
        job: JSON.parse(row.jobJson) as LearningJob,
        rowJson: row.jobJson,
      }))
      .filter(({ job }) =>
        job.intentKey === project.intentKey
        || matchingCapabilitySuppression(
          [suppression],
          job.goalTemplate || "",
        ));
    const cancelledIds = new Set(cancelledJobs.map(({ job }) => job.id));
    const releaseGuardKey = `release_guard:${release.id}`;
    const activeValidationRows = cancelledIds.size
      ? await all<ValidationJobRow>(database, `SELECT job_json AS jobJson FROM site_agent_v2_validation_jobs WHERE site_agent_id=? AND status IN ('queued','leased','running')`, [siteAgentId])
      : [];
    const statements = [
      database.prepare(`INSERT OR IGNORE INTO site_agent_v2_releases (id,site_agent_id,version,content_hash,release_json,created_at) VALUES (?,?,?,?,?,?)`)
        .bind(release.id, siteAgentId, release.version, release.contentHash, JSON.stringify(release), now),
      database.prepare(`INSERT OR REPLACE INTO site_agent_v2_meta (key,value,updated_at)
        SELECT ?,?,? WHERE EXISTS (
          SELECT 1 FROM site_agent_v2_agents
           WHERE id=? AND active_release_id=?
        ) AND EXISTS (
          SELECT 1 FROM site_agent_v2_capability_projects
           WHERE id=? AND site_agent_id=? AND status='available'
             AND active_revision_id=?
             AND json_extract(project_json,'$.activeCapabilityId')=?
        ) AND EXISTS (
          SELECT 1 FROM site_agent_v2_capability_revisions
           WHERE id=? AND project_id=? AND site_agent_id=? AND status='published'
        )`)
        .bind(
          releaseGuardKey,
          current.id,
          now,
          siteAgentId,
          current.id,
          projectId,
          siteAgentId,
          revision.id,
          lastGoodContract.id,
          revision.id,
          projectId,
          siteAgentId,
        ),
      database.prepare(`INSERT OR REPLACE INTO site_agent_v2_capability_suppressions
        (id,site_agent_id,intent_key,status,suppression_json,created_at,updated_at)
        SELECT ?,?,?,?,?,?,? WHERE EXISTS (
          SELECT 1 FROM site_agent_v2_meta WHERE key=? AND value=?
        )`)
        .bind(
          suppression.id,
          siteAgentId,
          suppression.intentKey,
          suppression.status,
          JSON.stringify(suppression),
          suppression.createdAt,
          now,
          releaseGuardKey,
          current.id,
        ),
      database.prepare(`UPDATE site_agent_v2_capability_projects
        SET status='unpublished',project_json=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND status='available'
          AND active_revision_id=?
          AND json_extract(project_json,'$.activeCapabilityId')=?
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_meta WHERE key=? AND value=?
          )`)
        .bind(
          JSON.stringify(unpublished),
          now,
          projectId,
          siteAgentId,
          revision.id,
          lastGoodContract.id,
          releaseGuardKey,
          current.id,
        ),
      database.prepare(`UPDATE site_agent_v2_agents
        SET profile_json=?,active_release_id=?,updated_at=?
        WHERE id=? AND active_release_id=?
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_meta WHERE key=? AND value=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_capability_projects
             WHERE id=? AND site_agent_id=? AND status='unpublished'
               AND active_revision_id=? AND project_json=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_capability_suppressions
             WHERE id=? AND site_agent_id=? AND status='active'
          )`)
        .bind(
          JSON.stringify(release.profile),
          release.id,
          now,
          siteAgentId,
          current.id,
          releaseGuardKey,
          current.id,
          projectId,
          siteAgentId,
          revision.id,
          JSON.stringify(unpublished),
          suppression.id,
          siteAgentId,
        ),
      database.prepare(`INSERT INTO site_agent_v2_capability_events
        (id,project_id,revision_id,site_agent_id,type,status,event_json,created_at)
        SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (
          SELECT 1 FROM site_agent_v2_meta WHERE key=? AND value=?
        ) AND EXISTS (
          SELECT 1 FROM site_agent_v2_agents WHERE id=? AND active_release_id=?
        )`)
        .bind(
          event.id,
          projectId,
          null,
          siteAgentId,
          event.type,
          event.status,
          JSON.stringify(event),
          now,
          releaseGuardKey,
          current.id,
          siteAgentId,
          release.id,
        ),
      ...cancelledJobs.map(({ job, rowJson }) => {
        const cancelled = { ...job, status: "cancelled" as const, lease: undefined, failure: { code: "capability_unpublished", summary: suppression.reason }, updatedAt: now };
        return database.prepare(`UPDATE site_agent_v2_learning_jobs
          SET status='cancelled',result_json=?,updated_at=?
          WHERE id=? AND site_agent_id=? AND status IN ('queued','leased','running')
            AND result_json=?
            AND EXISTS (
              SELECT 1 FROM site_agent_v2_meta WHERE key=? AND value=?
            )`)
          .bind(
            JSON.stringify(cancelled),
            now,
            job.id,
            siteAgentId,
            rowJson,
            releaseGuardKey,
            current.id,
          );
      }),
      ...activeValidationRows
        .map((row) => JSON.parse(row.jobJson) as ValidationJob)
        .filter((job) => cancelledIds.has(job.learningJobId))
        .map((job) => {
          const cancelled = { ...job, status: "cancelled" as const, lease: undefined, failure: { code: "capability_unpublished", summary: suppression.reason }, updatedAt: now };
          const rowJson = activeValidationRows.find((row) =>
            (JSON.parse(row.jobJson) as ValidationJob).id === job.id)?.jobJson;
          return database.prepare(`UPDATE site_agent_v2_validation_jobs
            SET status='cancelled',lease_expires_at=NULL,job_json=?,updated_at=?
            WHERE id=? AND status IN ('queued','leased','running')
              AND job_json=?
              AND EXISTS (
                SELECT 1 FROM site_agent_v2_meta WHERE key=? AND value=?
              )`)
            .bind(
              JSON.stringify(cancelled),
              now,
              job.id,
              rowJson || "",
              releaseGuardKey,
              current.id,
            );
        }),
      database.prepare(`DELETE FROM site_agent_v2_meta WHERE key=? AND value=?`)
        .bind(releaseGuardKey, current.id),
    ];
    const results = await database.batch(statements);
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "capability_unpublish_failed");
    if ([1, 2, 3, 4, 5].some((index) =>
      Number(results[index]?.meta?.changes || 0) !== 1)) {
      throw new Error("capability_release_conflict");
    }
    invalidateSiteAgentListCache();
    return { project: unpublished, release, suppression, persistence: "d1" as const };
  }
  if (input.action === "relist") {
    if (project.status !== "unpublished" || project.activeCapabilityId) {
      throw new Error("capability_relist_unpublished_required");
    }
    const revision = publishedLifecycleRevision(project, revisions);
    const publishedRelease = await d1ReleaseById(
      database,
      siteAgentId,
      revision.publishedReleaseId!,
    );
    if (!publishedRelease) throw new Error("capability_last_good_missing");
    const lastGoodContract = exactLastGoodContract(
      project,
      revision,
      publishedRelease,
    );
    const now = new Date().toISOString();
    const operationId = uid("release_operation");
    const current = await d1Release(database, siteAgentId);
    if (!current) throw new Error("site_agent_release_missing");
    const suppressions = await activeCapabilitySuppressions(database, siteAgentId);
    const suppression = suppressions.find((item) => item.projectId === projectId || item.intentKey === project.intentKey);
    if (!suppression) throw new Error("capability_suppression_not_found");
    const revoked: CapabilitySuppression = { ...suppression, status: "revoked", revokedAt: now };
    const release = releaseWithRelistedCapability(
      current,
      lastGoodContract,
      now,
      operationId,
    );
    const releaseGuardKey = `release_guard:${release.id}`;
    const relisted: CapabilityProject = capabilityProjectForWrite({
      ...project,
      status: "available",
      canonicalCapabilityId: lastGoodContract.id,
      activeCapabilityId: lastGoodContract.id,
      autoGenerationBlocked: false,
      unpublishedAt: undefined,
      updatedAt: now,
    });
    const event: CapabilityEvent = {
      id: uid("event"), siteAgentId, projectId, type: "publish", actor: "user", status: "passed",
      title: "能力已重新上架", summary: "管理员撤销了自动生成抑制，并恢复最后一个已验证版本。",
      evidence: { suppressionId: suppression.id, releaseVersion: release.version }, createdAt: now,
    };
    const results = await database.batch([
      database.prepare(`INSERT OR IGNORE INTO site_agent_v2_releases (id,site_agent_id,version,content_hash,release_json,created_at) VALUES (?,?,?,?,?,?)`)
        .bind(release.id, siteAgentId, release.version, release.contentHash, JSON.stringify(release), now),
      database.prepare(`INSERT OR REPLACE INTO site_agent_v2_meta (key,value,updated_at)
        SELECT ?,?,? WHERE EXISTS (
          SELECT 1 FROM site_agent_v2_agents
           WHERE id=? AND active_release_id=?
        ) AND EXISTS (
          SELECT 1 FROM site_agent_v2_capability_projects
           WHERE id=? AND site_agent_id=? AND status='unpublished'
             AND active_revision_id=?
             AND json_extract(project_json,'$.activeCapabilityId') IS NULL
             AND json_extract(project_json,'$.canonicalCapabilityId')=?
        ) AND EXISTS (
          SELECT 1 FROM site_agent_v2_capability_revisions
           WHERE id=? AND project_id=? AND site_agent_id=? AND status='published'
        ) AND EXISTS (
          SELECT 1 FROM site_agent_v2_capability_suppressions
           WHERE id=? AND site_agent_id=? AND status='active'
             AND suppression_json=?
        )`)
        .bind(
          releaseGuardKey,
          current.id,
          now,
          siteAgentId,
          current.id,
          projectId,
          siteAgentId,
          revision.id,
          lastGoodContract.id,
          revision.id,
          projectId,
          siteAgentId,
          suppression.id,
          siteAgentId,
          JSON.stringify(suppression),
        ),
      database.prepare(`UPDATE site_agent_v2_capability_suppressions
        SET status='revoked',suppression_json=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND status='active'
          AND suppression_json=?
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_meta WHERE key=? AND value=?
          )`)
        .bind(
          JSON.stringify(revoked),
          now,
          suppression.id,
          siteAgentId,
          JSON.stringify(suppression),
          releaseGuardKey,
          current.id,
        ),
      database.prepare(`UPDATE site_agent_v2_capability_projects
        SET status='available',project_json=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND status='unpublished'
          AND active_revision_id=?
          AND json_extract(project_json,'$.activeCapabilityId') IS NULL
          AND json_extract(project_json,'$.canonicalCapabilityId')=?
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_meta WHERE key=? AND value=?
          )`)
        .bind(
          JSON.stringify(relisted),
          now,
          projectId,
          siteAgentId,
          revision.id,
          lastGoodContract.id,
          releaseGuardKey,
          current.id,
        ),
      database.prepare(`UPDATE site_agent_v2_agents
        SET profile_json=?,active_release_id=?,updated_at=?
        WHERE id=? AND active_release_id=?
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_meta WHERE key=? AND value=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_capability_projects
             WHERE id=? AND site_agent_id=? AND status='available'
               AND active_revision_id=? AND project_json=?
          )
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_capability_suppressions
             WHERE id=? AND site_agent_id=? AND status='revoked'
               AND suppression_json=?
          )`)
        .bind(
          JSON.stringify(release.profile),
          release.id,
          now,
          siteAgentId,
          current.id,
          releaseGuardKey,
          current.id,
          projectId,
          siteAgentId,
          revision.id,
          JSON.stringify(relisted),
          suppression.id,
          siteAgentId,
          JSON.stringify(revoked),
        ),
      database.prepare(`INSERT INTO site_agent_v2_capability_events
        (id,project_id,revision_id,site_agent_id,type,status,event_json,created_at)
        SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (
          SELECT 1 FROM site_agent_v2_meta WHERE key=? AND value=?
        ) AND EXISTS (
          SELECT 1 FROM site_agent_v2_agents WHERE id=? AND active_release_id=?
        )`)
        .bind(
          event.id,
          projectId,
          null,
          siteAgentId,
          event.type,
          event.status,
          JSON.stringify(event),
          now,
          releaseGuardKey,
          current.id,
          siteAgentId,
          release.id,
        ),
      database.prepare(`DELETE FROM site_agent_v2_meta WHERE key=? AND value=?`)
        .bind(releaseGuardKey, current.id),
    ]);
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "capability_relist_failed");
    if ([1, 2, 3, 4, 5].some((index) =>
      Number(results[index]?.meta?.changes || 0) !== 1)) {
      throw new Error("capability_release_conflict");
    }
    invalidateSiteAgentListCache();
    return { project: relisted, release, persistence: "d1" as const };
  }
  const now = new Date().toISOString();
  if (input.action === "archive" || input.action === "restore") {
    const rows = await all<{
      projectJson: string;
      status: CapabilityProject["status"];
      updatedAt: string;
    }>(
      database,
      `SELECT project_json AS projectJson,status,updated_at AS updatedAt
         FROM site_agent_v2_capability_projects
        WHERE id=? AND site_agent_id=? LIMIT 1`,
      [projectId, siteAgentId],
    );
    if (!rows[0]) throw new Error("capability_project_not_found");
    const current = projectWithIdentityDefaults(
      JSON.parse(rows[0].projectJson) as CapabilityProject,
    );
    if ((input.action === "archive" && current.status === "archived")
      || (input.action === "restore" && current.status !== "archived")) {
      throw new Error("capability_project_conflict");
    }
    const next = capabilityProjectForWrite({
      ...current,
      status: input.action === "archive"
        ? "archived" as const
        : current.archivedFromStatus
          || (current.activeCapabilityId ? "available" as const : "building" as const),
      archivedFromStatus: input.action === "archive"
        ? current.status === "archived" ? undefined : current.status
        : undefined,
      updatedAt: now,
    });
    const event: CapabilityEvent = {
      id: uid("event"),
      siteAgentId,
      projectId,
      type: "archive",
      actor: "user",
      status: "info",
      title: input.action === "archive"
        ? "能力项目已归档"
        : "能力项目已恢复",
      summary: input.action === "archive"
        ? "能力已停用并归档；能力中心仍保留版本、运行与审核证据，可按状态筛选。"
        : "能力重新出现在能力中心；历史版本和证据保持不变。",
      createdAt: now,
    };
    const nextJson = JSON.stringify(next);
    const results = await database.batch([
      database.prepare(`UPDATE site_agent_v2_capability_projects
        SET status=?,project_json=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND status=?
          AND updated_at=? AND project_json=?`)
        .bind(
          next.status,
          nextJson,
          now,
          projectId,
          siteAgentId,
          rows[0].status,
          rows[0].updatedAt,
          rows[0].projectJson,
        ),
      database.prepare(`INSERT INTO site_agent_v2_capability_events
        (id,project_id,revision_id,site_agent_id,type,status,event_json,created_at)
        SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (
          SELECT 1 FROM site_agent_v2_capability_projects
           WHERE id=? AND site_agent_id=? AND status=?
             AND updated_at=? AND project_json=?
        )`)
        .bind(
          event.id,
          projectId,
          null,
          siteAgentId,
          event.type,
          event.status,
          JSON.stringify(event),
          now,
          projectId,
          siteAgentId,
          next.status,
          now,
          nextJson,
        ),
    ]);
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "capability_project_transition_failed");
    if (results.some((result) =>
      Number(result.meta?.changes || 0) !== 1)) {
      throw new Error("capability_project_conflict");
    }
    invalidateSiteAgentListCache();
    return { project: next, persistence: "d1" as const };
  }
  if (input.action === "retry-validation") {
    const revision = revisions.find((item) => item.validation?.status === "failed" && item.learningJobId);
    if (!revision?.learningJobId) {
      const inProgress = revisions.find((item) => item.stage === "validate"
        && item.status === "building"
        && item.validation?.status === "pending"
        && item.learningJobId);
      if (inProgress) return { project, revision: inProgress, persistence: "d1" as const };
      throw new Error("validation_retry_unavailable");
    }
    if (!retryableValidationRevision(revision)) throw new Error("validation_retry_requires_reauthoring");
    const [rows, candidateRows, connectionRows, release, learningRows, revisionRows, projectRows] = await Promise.all([
      all<{ status: ValidationJob["status"]; jobJson: string; updatedAt: string }>(database, `SELECT status,job_json AS jobJson,updated_at AS updatedAt FROM site_agent_v2_validation_jobs WHERE learning_job_id=? ORDER BY updated_at DESC LIMIT 1`, [revision.learningJobId]),
      revision.candidateId
        ? all<CandidateRow>(database, `SELECT candidate_json AS candidateJson FROM site_agent_v2_candidates WHERE id=? AND site_agent_id=? LIMIT 1`, [revision.candidateId, siteAgentId])
        : Promise.resolve([]),
      all<ConnectionRow>(database, `SELECT site_agent_id AS siteAgentId,origin,url,title,heading,connected_at AS connectedAt,last_seen_at AS lastSeenAt FROM site_agent_v2_connections WHERE site_agent_id=? LIMIT 1`, [siteAgentId]),
      d1Release(database, siteAgentId),
      all<{ status: LearningJob["status"]; jobJson: string; updatedAt: string }>(database, `SELECT status,result_json AS jobJson,updated_at AS updatedAt FROM site_agent_v2_learning_jobs WHERE id=? AND site_agent_id=? LIMIT 1`, [revision.learningJobId, siteAgentId]),
      all<{ status: CapabilityRevision["status"]; revisionJson: string; updatedAt: string }>(database, `SELECT status,revision_json AS revisionJson,updated_at AS updatedAt FROM site_agent_v2_capability_revisions WHERE id=? AND project_id=? AND site_agent_id=? LIMIT 1`, [revision.id, projectId, siteAgentId]),
      all<{ status: CapabilityProject["status"]; projectJson: string; updatedAt: string }>(database, `SELECT status,project_json AS projectJson,updated_at AS updatedAt FROM site_agent_v2_capability_projects WHERE id=? AND site_agent_id=? LIMIT 1`, [projectId, siteAgentId]),
    ]);
    if (rows[0] && ["queued", "leased", "running"].includes(rows[0].status)) {
      const refreshed = await getCapabilityProjectDetail(siteAgentId, projectId);
      return { project: refreshed.detail?.project || project, revision: refreshed.detail?.revisions[0] || revision, persistence: "d1" as const };
    }
    if (!rows[0] || !candidateRows[0] || !release || !learningRows[0] || !revisionRows[0] || !projectRows[0]) throw new Error("validation_retry_unavailable");
    if (rows[0].status !== "failed" || learningRows[0].status !== "failed" || revisionRows[0].status !== "failed") throw new Error("validation_retry_conflict");
    const validation = JSON.parse(rows[0].jobJson) as ValidationJob;
    const candidate = JSON.parse(candidateRows[0].candidateJson) as KnowledgeCandidate;
    const learning = JSON.parse(learningRows[0].jobJson) as LearningJob;
    const currentRevision = JSON.parse(revisionRows[0].revisionJson) as CapabilityRevision;
    const currentProject = projectWithIdentityDefaults(JSON.parse(projectRows[0].projectJson) as CapabilityProject);
    const episode = (sourceEpisodes || []).find((item) => item.id === learning.sourceEpisodeId);
    const next = {
      ...validation,
      status: "queued" as const,
      lease: undefined,
      failure: undefined,
      validationCase: {
        ...validation.validationCase,
        startUrl: refreshedValidationStartUrl(
          release,
          candidate,
          validation,
          [episode?.startSnapshot.url, connectionRows[0]?.url, ...validationRetryReceiptStartUrls(learning)],
          episode?.endSnapshot.url,
        ),
      },
      updatedAt: now,
    };
    const retryLearning: LearningJob = {
      ...learning,
      phase: "validate",
      status: "queued",
      lease: undefined,
      failure: undefined,
      updatedAt: now,
    };
    const retryRevision: CapabilityRevision = {
      ...currentRevision,
      status: "building",
      stage: "validate",
      validation: { ...revision.validation, status: "pending", failureClass: undefined },
      updatedAt: now,
    };
    const retryProject = capabilityProjectForWrite({
      ...currentProject,
      status: currentProject.activeCapabilityId ? "available" : "building",
      stage: currentProject.activeCapabilityId ? currentProject.stage : "validate",
      health: { ...currentProject.health, failureClass: undefined, recommendedAction: undefined },
      updatedAt: now,
    });
    const guardKey = `validation_retry_guard:${retryRevision.id}:${uid("retry")}`;
    const guardValue = rows[0].updatedAt;
    const results = await database.batch([
      database.prepare(`INSERT OR REPLACE INTO site_agent_v2_meta (key,value,updated_at)
        SELECT ?,?,? WHERE EXISTS (
          SELECT 1 FROM site_agent_v2_validation_jobs WHERE id=? AND site_agent_id=? AND status='failed' AND job_json=? AND updated_at=?
        ) AND EXISTS (
          SELECT 1 FROM site_agent_v2_learning_jobs WHERE id=? AND site_agent_id=? AND status='failed' AND result_json=? AND updated_at=?
        ) AND EXISTS (
          SELECT 1 FROM site_agent_v2_capability_revisions WHERE id=? AND project_id=? AND site_agent_id=? AND status='failed' AND revision_json=? AND updated_at=?
        ) AND EXISTS (
          SELECT 1 FROM site_agent_v2_capability_projects WHERE id=? AND site_agent_id=? AND status=? AND project_json=? AND updated_at=?
        )`).bind(
          guardKey, guardValue, now,
          validation.id, siteAgentId, rows[0].jobJson, rows[0].updatedAt,
          learning.id, siteAgentId, learningRows[0].jobJson, learningRows[0].updatedAt,
          currentRevision.id, projectId, siteAgentId, revisionRows[0].revisionJson, revisionRows[0].updatedAt,
          currentProject.id, siteAgentId, projectRows[0].status, projectRows[0].projectJson, projectRows[0].updatedAt,
        ),
      database.prepare(`UPDATE site_agent_v2_validation_jobs SET status='queued',lease_expires_at=NULL,job_json=?,updated_at=? WHERE id=? AND site_agent_id=? AND status='failed' AND job_json=? AND updated_at=? AND EXISTS (SELECT 1 FROM site_agent_v2_meta WHERE key=? AND value=?)`).bind(JSON.stringify(next), now, next.id, siteAgentId, rows[0].jobJson, rows[0].updatedAt, guardKey, guardValue),
      database.prepare(`UPDATE site_agent_v2_learning_jobs SET status='queued',result_json=?,updated_at=? WHERE id=? AND site_agent_id=? AND status='failed' AND result_json=? AND updated_at=? AND EXISTS (SELECT 1 FROM site_agent_v2_meta WHERE key=? AND value=?)`).bind(JSON.stringify(retryLearning), now, retryLearning.id, siteAgentId, learningRows[0].jobJson, learningRows[0].updatedAt, guardKey, guardValue),
      database.prepare(`UPDATE site_agent_v2_capability_revisions SET status='building',revision_json=?,updated_at=? WHERE id=? AND project_id=? AND site_agent_id=? AND status='failed' AND revision_json=? AND updated_at=? AND EXISTS (SELECT 1 FROM site_agent_v2_meta WHERE key=? AND value=?)`).bind(JSON.stringify(retryRevision), now, retryRevision.id, projectId, siteAgentId, revisionRows[0].revisionJson, revisionRows[0].updatedAt, guardKey, guardValue),
      database.prepare(`UPDATE site_agent_v2_capability_projects SET status=?,project_json=?,updated_at=? WHERE id=? AND site_agent_id=? AND status=? AND project_json=? AND updated_at=? AND EXISTS (SELECT 1 FROM site_agent_v2_meta WHERE key=? AND value=?)`).bind(retryProject.status, JSON.stringify(retryProject), now, retryProject.id, siteAgentId, projectRows[0].status, projectRows[0].projectJson, projectRows[0].updatedAt, guardKey, guardValue),
      database.prepare(`DELETE FROM site_agent_v2_meta WHERE key=? AND value=?`).bind(guardKey, guardValue),
    ]);
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "validation_retry_failed");
    if (results.some((result) => Number(result.meta?.changes || 0) !== 1)) {
      const refreshed = await getCapabilityProjectDetail(siteAgentId, projectId);
      const refreshedValidation = refreshed.detail?.validationJobs?.find((item) => item.learningJobId === revision.learningJobId);
      if (refreshedValidation && ["queued", "leased", "running"].includes(refreshedValidation.status)) {
        return { project: refreshed.detail?.project || project, revision: refreshed.detail?.revisions[0] || revision, persistence: "d1" as const };
      }
      throw new Error("validation_retry_conflict");
    }
    invalidateSiteAgentListCache();
    return { project: retryProject, revision: retryRevision, persistence: "d1" as const };
  }
  if (input.action === "re-explore") {
    const retried = await retryFailedAuthoringRevisionD1(database, siteAgentId, projectId);
    if (retried) return retried;
  }
  const guidanceText = input.action === "guide" ? String(input.text || "").trim().slice(0, 2_000) : undefined;
  if (input.action === "guide" && !guidanceText) throw new Error("guidance_text_required");
  if (input.action === "patch-contract") throw new Error("capability_contract_patch_not_supported");
  if (!["guide", "re-explore"].includes(input.action)) throw new Error("capability_action_invalid");
  const nextContract = contract;
  assertStableCapabilityIdentity(project, nextContract, contract.outcomes);
  const queued = await queueProjectRevision(database, project, nextContract, guidanceText);
  if (guidanceText) {
    const revisionId = queued.revision.id;
    const guidance: AuthoringGuidance = { id: uid("guidance"), siteAgentId, projectId, revisionId, text: guidanceText, createdAt: now };
    const event: CapabilityEvent = { id: uid("event"), siteAgentId, projectId, revisionId, type: "guidance", actor: "user", status: "info", title: "开发者补充了 AI 编写指导", summary: guidanceText, createdAt: now };
    await database.batch([
      database.prepare(`INSERT INTO site_agent_v2_authoring_guidance (id,project_id,revision_id,site_agent_id,guidance_json,created_at) VALUES (?,?,?,?,?,?)`).bind(guidance.id, projectId, revisionId, siteAgentId, JSON.stringify(guidance), now),
      database.prepare(`INSERT INTO site_agent_v2_capability_events (id,project_id,revision_id,site_agent_id,type,status,event_json,created_at) VALUES (?,?,?,?,?,?,?,?)`).bind(event.id, projectId, revisionId, siteAgentId, event.type, event.status, JSON.stringify(event), now),
    ]);
  }
  const refreshed = await getCapabilityProjectDetail(siteAgentId, projectId);
  return { project: refreshed.detail?.project, revision: refreshed.detail?.revisions[0], persistence: "d1" as const };
}

function trustedReleaseOriginsForLaunch(release: SiteAgentReleaseV2) {
  const configured = (Array.isArray(release.profile.allowedOrigins) ? release.profile.allowedOrigins : []).flatMap((value) => {
    try { return [new URL(value).origin]; } catch { return []; }
  });
  const entry = release.profile.entryUrl ? (() => {
    try { return [new URL(release.profile.entryUrl!).origin]; } catch { return []; }
  })() : [];
  const sceneOrigins = release.scenes.flatMap((scene) =>
    scene.urlTemplates.flatMap((template) => {
      try {
        return template.originPattern === "*"
          ? []
          : [new URL(template.originPattern).origin];
      } catch {
        return [];
      }
    }));
  return [...new Set(
    configured.length
      ? configured
      : entry.length
        ? entry
        : [...new Set(sceneOrigins)].length === 1
          ? sceneOrigins
          : [],
  )];
}

function trustedPinnedLaunchStartUrl(
  release: SiteAgentReleaseV2,
  value: string,
) {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:")
      && !parsed.username
      && !parsed.password
      && trustedReleaseOriginsForLaunch(release).includes(parsed.origin)) {
      return parsed.toString();
    }
  } catch {
    // Invalid Revision evidence must never steer a connected browser.
  }
  throw new Error("capability_run_start_url_untrusted");
}

async function publishedRevisionStartUrl(
  siteAgentId: string,
  revision: CapabilityRevision,
  release: SiteAgentReleaseV2,
  knownRuns: BrowserRun[] = [],
) {
  let startUrl = revision.validation?.startUrl;
  if (!startUrl && revision.validation?.runId) {
    const database = getD1Binding();
    if (database) {
      const rows = await all<BrowserRunRow>(database, `SELECT run_json AS runJson
        FROM site_agent_v2_browser_runs
        WHERE id=? AND site_agent_id=? AND status='passed' LIMIT 1`,
      [revision.validation.runId, siteAgentId]);
      startUrl = rows[0]
        ? (JSON.parse(rows[0].runJson) as BrowserRun).startUrl
        : undefined;
    } else {
      startUrl = knownRuns.find((run) =>
        run.id === revision.validation?.runId
        && run.status === "passed")?.startUrl;
    }
  }
  if (!startUrl && revision.publicationProvenance === "legacy-release-import") {
    startUrl = release.profile.entryUrl;
  }
  if (!startUrl) throw new Error("capability_run_start_url_missing");
  return startUrl;
}

function normalizeLaunchOrigin(value: string) {
  const url = new URL(value);
  return url.origin;
}

export async function createTaskLaunch(input: {
  siteAgentId: string;
  projectId?: string;
  capabilityId?: string;
  capabilityRunId?: string;
  releaseId?: string;
  releaseVersion?: number;
  capabilityVersionId?: string;
  revisionId?: string;
  /** Internal exact-pin entry selected from the published Revision evidence. */
  startUrl?: string;
  goal: string;
  input: Record<string, JsonValue>;
  mode: TaskLaunchMode;
  executionMode?: ExecutionMode;
  supersedePendingNavigation?: boolean;
  /** Internal: return a fully validated row for an enclosing atomic batch. */
  deferPersistence?: boolean;
  /** Internal high-entropy deterministic token for idempotent Run creation. */
  rawToken?: string;
}) {
  const goal = input.goal.trim().slice(0, 1_000); if (!goal) throw new Error("task_launch_goal_required");
  const navigationIntentKey = input.supersedePendingNavigation ? normalizeGoal(goal) : undefined;
  const database = getD1Binding();
  const active = await getActiveSiteAgentRelease(input.siteAgentId);
  const suppliedExecutionPin = input.releaseId !== undefined
    || input.releaseVersion !== undefined
    || input.capabilityVersionId !== undefined
    || input.revisionId !== undefined;
  if (input.startUrl !== undefined && !suppliedExecutionPin) {
    throw new Error("task_launch_start_url_requires_execution_pin");
  }
  if (suppliedExecutionPin
    && (!input.releaseId
      || input.releaseVersion === undefined
      || !input.capabilityId
      || !input.startUrl
      || (input.capabilityVersionId
        ? Boolean(input.revisionId)
        : !input.revisionId || !input.projectId))) {
    throw new Error("task_launch_execution_pin_incomplete");
  }
  if (input.capabilityRunId && !suppliedExecutionPin) {
    throw new Error("task_launch_execution_pin_incomplete");
  }
  let executionRelease = active.release;
  let executionProjectId = input.projectId;
  let executionCapabilityVersionId = input.capabilityVersionId;
  let executionRevisionId = input.revisionId;
  let pinnedLaunchStartUrl: string | undefined;
  if (suppliedExecutionPin) {
    const pinnedRelease = input.releaseId === active.release.id
      ? active.release
      : database
        ? await d1ReleaseById(database, input.siteAgentId, input.releaseId!)
        : memoryReleaseById(memoryAgent(input.siteAgentId), input.releaseId!);
    if (!pinnedRelease) throw new Error("task_launch_release_not_found");
    if (pinnedRelease.id !== input.releaseId
      || pinnedRelease.version !== input.releaseVersion) {
      throw new Error("task_launch_release_mismatch");
    }
    const pinnedCapability = runtimeCapability(
      pinnedRelease,
      input.capabilityId!,
    );
    if (!pinnedCapability) throw new Error("task_launch_capability_not_found");
    let expectedStartUrl: string;
    if (input.capabilityVersionId) {
      const selected = await assertPinnedCapabilityVersion({
        siteAgentId: input.siteAgentId,
        capabilityId: input.capabilityId!,
        capabilityVersionId: input.capabilityVersionId,
        releaseId: pinnedRelease.id,
        releaseVersion: pinnedRelease.version,
      });
      if (!selected.version.validation?.startUrl) {
        throw new Error("capability_version_start_url_missing");
      }
      expectedStartUrl = selected.version.validation.startUrl;
    } else {
      const detail = await getCapabilityProjectDetail(
        input.siteAgentId,
        input.projectId!,
      );
      const revision = detail.detail?.revisions.find((candidate) =>
        candidate.id === input.revisionId);
      if (!revision || revision.projectId !== input.projectId) {
        throw new Error("task_launch_revision_mismatch");
      }
      if ((revision.publishedReleaseId
        && revision.publishedReleaseId !== pinnedRelease.id)
        || (revision.publishedReleaseVersion !== undefined
          && revision.publishedReleaseVersion !== pinnedRelease.version)) {
        throw new Error("task_launch_revision_mismatch");
      }
      assertCapabilityRevisionRelease(
        pinnedRelease,
        pinnedCapability,
        revision,
        { allowLegacyReleasePlan: true },
      );
      expectedStartUrl = await publishedRevisionStartUrl(
        input.siteAgentId,
        revision,
        pinnedRelease,
        detail.detail?.browserRuns,
      );
    }
    pinnedLaunchStartUrl = trustedPinnedLaunchStartUrl(
      pinnedRelease,
      input.startUrl!,
    );
    if (pinnedLaunchStartUrl
      !== trustedPinnedLaunchStartUrl(pinnedRelease, expectedStartUrl)) {
      throw new Error("task_launch_start_url_mismatch");
    }
    executionRelease = pinnedRelease;
  } else if (input.capabilityId && input.mode === "run") {
    const resolvedVersion = await resolvedCapabilityRunVersion(
      input.siteAgentId,
      input.capabilityId,
    );
    if (resolvedVersion) {
      executionRelease = resolvedVersion.release;
      executionProjectId = undefined;
      executionCapabilityVersionId = resolvedVersion.capabilityVersionId;
      executionRevisionId = undefined;
      pinnedLaunchStartUrl = resolvedVersion.startUrl;
    } else {
      const activeCapability = runtimeCapability(
        active.release,
        input.capabilityId,
      );
      const resolved = await resolvedCapabilityRunRevision(
        input.siteAgentId,
        input.projectId,
        active.release,
        input.capabilityId,
        activeCapability,
        { allowLegacyReleasePlan: true },
      );
      executionRelease = resolved.release;
      executionProjectId = resolved.projectId;
      executionRevisionId = resolved.revisionId;
      pinnedLaunchStartUrl = trustedPinnedLaunchStartUrl(
        resolved.release,
        resolved.startUrl,
      );
    }
  }
  const capability = input.capabilityId
    ? runtimeCapability(executionRelease, input.capabilityId)
    : undefined;
  if (input.capabilityId && !capability) throw new Error("task_launch_capability_not_found");
  if (capability && input.mode === "run") {
    assertCapabilityInput(capability.inputs, input.input);
  }
  const connection = database
    ? (await all<ConnectionRow>(database, `SELECT site_agent_id AS siteAgentId,origin,url,title,heading,connected_at AS connectedAt,last_seen_at AS lastSeenAt FROM site_agent_v2_connections WHERE site_agent_id=? LIMIT 1`, [input.siteAgentId]))[0]
    : memoryAgent(input.siteAgentId).connection;
  const launchEntryUrl = pinnedLaunchStartUrl
    || connection?.url
    || executionRelease.profile.entryUrl
    || connection?.origin
    || "https://example.invalid";
  const allowedOrigin = normalizeLaunchOrigin(
    pinnedLaunchStartUrl || connection?.origin || launchEntryUrl,
  );
  const now = new Date();
  const id = uid("launch");
  const rawToken = input.rawToken || crypto.randomUUID().replaceAll("-", "");
  if (!/^[A-Za-z0-9_-]{24,200}$/.test(rawToken)) {
    throw new Error("task_launch_token_invalid");
  }
  const launch: TaskLaunch = {
    id,
    siteAgentId: input.siteAgentId,
    purpose: navigationIntentKey ? "navigation-evidence" : undefined,
    intentKey: navigationIntentKey,
    attemptSequence: nextTaskLaunchSequence(),
    projectId: executionProjectId,
    capabilityId: capability?.id,
    capabilityRunId: input.capabilityRunId,
    ...(capability && (executionCapabilityVersionId || executionRevisionId)
      ? {
          releaseId: executionRelease.id,
          releaseVersion: executionRelease.version,
          ...(executionCapabilityVersionId
            ? { capabilityVersionId: executionCapabilityVersionId }
            : { revisionId: executionRevisionId }),
          ...(pinnedLaunchStartUrl ? { startUrl: pinnedLaunchStartUrl } : {}),
        }
      : {}),
    goal: capability?.goalTemplate || goal,
    input: input.input,
    mode: input.mode,
    executionMode: input.executionMode || "run",
    allowedOrigin,
    status: "pending",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TASK_LAUNCH_PENDING_TTL_MS).toISOString(),
  };
  const tokenHash = await sha256Hex(rawToken); const packedToken = `${id}.${rawToken}`;
  const launchUrl = new URL(launchEntryUrl);
  const returnHash = launchUrl.hash.replace(/^#/, "");
  const launchHash = new URLSearchParams({
    ...(returnHash ? { "sitewake-return-hash": returnHash } : {}),
    "sitewake-launch": packedToken,
  });
  launchUrl.hash = launchHash.toString();
  if (input.deferPersistence) {
    if (navigationIntentKey) {
      throw new Error("task_launch_deferred_navigation_unsupported");
    }
    return {
      launch,
      token: packedToken,
      launchUrl: launchUrl.toString(),
      persistence: database ? "d1" as const : "memory" as const,
      deferred: {
        tokenHash,
        memoryLaunch: { ...launch, tokenHash },
      },
    };
  }
  if (!database) {
    const agent = memoryAgent(input.siteAgentId);
    if (navigationIntentKey) {
      agent.taskLaunches = agent.taskLaunches.map((stored) =>
        stored.status === "pending"
        && stored.mode === "demonstrate"
        && !stored.projectId
        && !stored.capabilityId
        && normalizeGoal(stored.goal) === navigationIntentKey
          ? { ...stored, status: "cancelled" as const, updatedAt: launch.createdAt }
          : stored);
    }
    agent.taskLaunches.push({ ...launch, tokenHash });
    if (navigationIntentKey) agent.navigationBuildHeads.set(navigationIntentKey, launch.id);
    return { launch, token: packedToken, launchUrl: launchUrl.toString(), persistence: "memory" as const };
  }
  await ensureSiteAgentV2Schema(database);
  const insert = database.prepare(`INSERT INTO site_agent_v2_task_launches (id,site_agent_id,project_id,capability_id,status,token_hash,claim_key_hash,launch_json,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(id, input.siteAgentId, executionProjectId || null, capability?.id || null, launch.status, tokenHash, null, JSON.stringify(launch), launch.createdAt, launch.updatedAt, launch.expiresAt);
  if (!navigationIntentKey) {
    const result = await insert.run();
    if (!result.success) throw new Error(result.error || "task_launch_create_failed");
  } else {
    const pendingRows = await all<Pick<TaskLaunchRow, "launchJson">>(
      database,
      `SELECT launch_json AS launchJson FROM site_agent_v2_task_launches
       WHERE site_agent_id=? AND project_id IS NULL AND capability_id IS NULL AND status='pending'
         AND json_extract(launch_json, '$.mode')='demonstrate'
       ORDER BY created_at DESC LIMIT 200`,
      [input.siteAgentId],
    );
    const legacyMatches = pendingRows
      .map((row) => JSON.parse(row.launchJson) as TaskLaunch)
      .filter((stored) => normalizeGoal(stored.goal) === navigationIntentKey);
    const cancelJson = database.dialect === "postgres"
      ? `jsonb_set(jsonb_set(launch_json::jsonb, '{status}', '"cancelled"'::jsonb), '{updatedAt}', to_jsonb(?::text))::text`
      : `json_set(json_set(launch_json,'$.status','cancelled'),'$.updatedAt',?)`;
    const statements = [
      ...(database.dialect === "postgres"
        ? [database.prepare(`SELECT pg_advisory_xact_lock(hashtext(?))`).bind(`navigation-launch:${input.siteAgentId}:${navigationIntentKey}`)]
        : []),
      database.prepare(`UPDATE site_agent_v2_task_launches
        SET status='cancelled',launch_json=${cancelJson},updated_at=?
        WHERE site_agent_id=? AND project_id IS NULL AND capability_id IS NULL
          AND status='pending' AND claim_key_hash IS NULL
          AND json_extract(launch_json, '$.mode')='demonstrate'
          AND json_extract(launch_json, '$.intentKey')=?`)
        .bind(launch.createdAt, launch.createdAt, input.siteAgentId, navigationIntentKey),
      ...legacyMatches.map((stored) => database.prepare(`UPDATE site_agent_v2_task_launches
        SET status='cancelled',launch_json=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND status='pending' AND claim_key_hash IS NULL`)
        .bind(JSON.stringify({ ...stored, status: "cancelled", updatedAt: launch.createdAt }), launch.createdAt, stored.id, input.siteAgentId)),
      insert,
      database.prepare(`INSERT INTO site_agent_v2_navigation_build_heads
        (site_agent_id,intent_key,launch_id,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(site_agent_id,intent_key) DO UPDATE
        SET launch_id=excluded.launch_id,updated_at=excluded.updated_at`)
        .bind(input.siteAgentId, navigationIntentKey, launch.id, launch.createdAt),
    ];
    const results = await database.batch(statements);
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "task_launch_create_failed");
  }
  return { launch, token: packedToken, launchUrl: launchUrl.toString(), persistence: "d1" as const };
}

function runtimeCapability(release: SiteAgentReleaseV2, capabilityId: string): CapabilityDefinition | undefined {
  const capability = release.capabilities.find((item) =>
    item.id === capabilityId
    && (item.status === "available" || item.status === "improving"));
  if (capability) return capability;
  const operationId = capabilityId.startsWith("operation:") ? capabilityId.slice("operation:".length) : capabilityId;
  const operation = release.operations.find((item) => item.id === operationId && (item.status === "verified" || item.status === "published"));
  if (!operation) return undefined;
  const now = operation.updatedAt;
  return {
    id: `operation:${operation.id}`,
    kind: "navigation",
    resultKind: "page",
    exposure: "internal",
    name: operation.name,
    description: operation.description || `执行网站内置动作：${operation.name}`,
    normalizedGoal: normalizeGoal(operation.name),
    goalTemplate: operation.name,
    aliases: [],
    inputs: operation.inputs,
    outputs: operation.outputs,
    outcomes: [],
    plans: [{ id: `runtime_plan_${operation.id}`, entrySceneIds: operation.fromSceneId === "*" ? ["*"] : [operation.fromSceneId], steps: [{ operationId: operation.id, bindings: {} }], outputBindings: {} }],
    sourceEpisodeIds: [], confidence: 1, status: "available", updatedAt: now,
  };
}

function validateRunInput(schema: CapabilityDefinition["inputs"], value: Record<string, JsonValue>) {
  assertCapabilityInput(schema, value);
}

function revisionModuleContentHash(revision: CapabilityRevision) {
  const implementation = revision.implementation;
  if (implementation?.kind === "program") return implementation.moduleRef?.contentHash;
  if (implementation?.kind === "module") return implementation.module.contentHash;
  // Historical published Revisions may still carry the module in their
  // read-only contract snapshot. New writes never use this compatibility path.
  return revision.contract?.module?.contentHash;
}

function assertCapabilityRevisionRelease(
  release: SiteAgentReleaseV2,
  capability: CapabilityDefinition,
  revision: CapabilityRevision,
  options: {
    requirePublished?: boolean;
    allowLegacyReleasePlan?: boolean;
  } = {},
) {
  const legacyPublished = revision.publicationProvenance === "legacy-release-import";
  if (options.requirePublished !== false
    && (revision.status !== "published"
      || (!legacyPublished
        && (revision.validation?.status !== "passed"
          || !revision.validation.runId)))) {
    throw new Error("capability_run_revision_not_published");
  }
  if (capability.module) {
    if (revisionModuleContentHash(revision) !== capability.module.contentHash) {
      throw new Error("capability_run_revision_release_mismatch");
    }
    return;
  }
  if (legacyPublished && options.allowLegacyReleasePlan) {
    const operations = new Map(
      release.operations.map((operation) => [operation.id, operation]),
    );
    const operationIds = capability.plans.flatMap((plan) =>
      plan.steps.map((step) => step.operationId));
    if (!capability.plans.length
      || !operationIds.length
      || operationIds.some((operationId) => {
        const operation = operations.get(operationId);
        return !operation
          || (operation.status !== "verified" && operation.status !== "published")
          || !operation.implementations.length;
      })) {
      throw new Error("capability_run_legacy_plan_unavailable");
    }
    return;
  }
  const implementation = revision.implementation;
  if (capability.kind !== "navigation"
    || capability.resultKind !== "page"
    || implementation?.kind !== "navigation-tool") {
    throw new Error("capability_run_revision_implementation_required");
  }
  const pin = implementation.toolRef;
  const tool = (release.navigationTools || []).find((candidate) =>
    candidate.id === pin.toolId);
  if (!tool
    || tool.status !== "verified"
    || tool.siteAgentId !== release.siteAgentId
    || tool.source.knowledgeRevision !== pin.knowledgeRevision
    || tool.source.dependencyHash !== pin.dependencyHash) {
    throw new Error("capability_run_navigation_tool_mismatch");
  }
  if (!release.scenes.some((scene) => scene.id === tool.verifier.sceneId)
    || !release.scenes.some((scene) => scene.id === tool.targetSceneId)) {
    throw new Error("capability_run_navigation_tool_scene_missing");
  }
  const strategyOperationIds = new Set(
    tool.strategies.map((strategy) => strategy.operationId),
  );
  const capabilityOperationIds = capability.plans.flatMap((plan) =>
    plan.steps.map((step) => step.operationId));
  if (!capabilityOperationIds.length
    || capabilityOperationIds.some((operationId) =>
      !strategyOperationIds.has(operationId))) {
    throw new Error("capability_run_navigation_tool_plan_mismatch");
  }
  const operations = new Map(
    release.operations.map((operation) => [operation.id, operation]),
  );
  if (capabilityOperationIds.some((operationId) => {
    const operation = operations.get(operationId);
    return !operation
      || (operation.status !== "verified" && operation.status !== "published")
      || !operation.implementations.length;
  })) {
    throw new Error("capability_run_navigation_tool_operation_unavailable");
  }
}

async function implementationReleaseForRevision(
  database: D1DatabaseLike,
  siteAgentId: string,
  activeRelease: SiteAgentReleaseV2,
  revision: CapabilityRevision,
) {
  if (!revision.implementationReleaseId) return activeRelease;
  const release = revision.implementationReleaseId === activeRelease.id
    ? activeRelease
    : await d1ReleaseById(
        database,
        siteAgentId,
        revision.implementationReleaseId,
      );
  if (!release
    || release.id !== revision.implementationReleaseId
    || (revision.implementationReleaseVersion !== undefined
      && release.version !== revision.implementationReleaseVersion)) {
    throw new Error("validation_revision_release_missing");
  }
  return release;
}

async function exactCapabilityRevisionRelease(
  siteAgentId: string,
  activeRelease: SiteAgentReleaseV2,
  capabilityId: string,
  revision: CapabilityRevision,
  activeCapability?: CapabilityDefinition,
  options: { allowLegacyReleasePlan?: boolean } = {},
) {
  const database = getD1Binding();
  const validateResolution = (release: SiteAgentReleaseV2) => {
    const capability = runtimeCapability(release, capabilityId);
    if (!capability
      || (activeCapability
        && capabilityContractFingerprint(capability)
          !== capabilityContractFingerprint(activeCapability))) {
      throw new Error("capability_run_revision_release_mismatch");
    }
    assertCapabilityRevisionRelease(release, capability, revision, options);
    return { release, capability };
  };
  if (revision.publishedReleaseId) {
    const release = revision.publishedReleaseId === activeRelease.id
      ? activeRelease
      : database
        ? await d1ReleaseById(
            database,
            siteAgentId,
            revision.publishedReleaseId,
          )
        : memoryReleaseById(memoryAgent(siteAgentId), revision.publishedReleaseId);
    if (!release
      || release.id !== revision.publishedReleaseId
      || (revision.publishedReleaseVersion !== undefined
        && release.version !== revision.publishedReleaseVersion)) {
      throw new Error("capability_run_published_release_missing");
    }
    return validateResolution(release);
  }

  // Compatibility for immutable Revisions published before Release pinning was
  // introduced. Search only the small window immediately after the Revision's
  // base Release; never scan and parse an unbounded site history per Run.
  const candidates = [activeRelease];
  if (database) {
    const rows = await all<{ id: string }>(
      database,
      `SELECT id
         FROM site_agent_v2_releases
        WHERE site_agent_id=? AND version>=?
        ORDER BY version ASC,created_at ASC
        LIMIT 64`,
      [siteAgentId, revision.baseReleaseVersion],
    );
    for (const row of rows) {
      const release = await d1ReleaseById(database, siteAgentId, row.id);
      if (!release) continue;
      if (!candidates.some((candidate) => candidate.id === release.id)) {
        candidates.push(release);
      }
    }
  }
  let mismatch: Error | undefined;
  for (const release of candidates) {
    try {
      return validateResolution(release);
    } catch (error) {
      mismatch = error instanceof Error
        ? error
        : new Error("capability_run_revision_release_mismatch");
    }
  }
  throw mismatch || new Error("capability_run_revision_release_mismatch");
}

async function resolvedCapabilityRunRevision(
  siteAgentId: string,
  projectId: string | undefined,
  release: SiteAgentReleaseV2,
  capabilityId: string,
  activeCapability?: CapabilityDefinition,
  options: { allowLegacyReleasePlan?: boolean } = {},
) {
  let resolvedProjectId = projectId;
  if (!resolvedProjectId) {
    const catalog = await listCapabilityProjects(siteAgentId, { excludeArchived: true });
    const matches = catalog.projects.filter((project) =>
      project.activeCapabilityId === capabilityId);
    if (matches.length === 0) throw new Error("capability_run_project_not_found");
    if (matches.length > 1) throw new Error("capability_run_project_ambiguous");
    resolvedProjectId = matches[0].id;
  }
  const { detail } = await getCapabilityProjectDetail(siteAgentId, resolvedProjectId);
  if (!detail) throw new Error("capability_run_project_not_found");
  if ((detail.project.structure || "atomic") === "composite") {
    throw new Error("capability_run_composite_not_implemented");
  }
  if (detail.project.activeCapabilityId !== capabilityId) {
    throw new Error("capability_run_project_mismatch");
  }
  const revision = detail.activeRevision;
  if (!revision) throw new Error("capability_run_revision_not_published");
  const exactResolution = await exactCapabilityRevisionRelease(
    siteAgentId,
    release,
    capabilityId,
    revision,
    activeCapability,
    options,
  );
  const startUrl = await publishedRevisionStartUrl(
    siteAgentId,
    revision,
    exactResolution.release,
    detail.browserRuns,
  );
  return {
    projectId: resolvedProjectId,
    revisionId: revision.id,
    startUrl,
    revision,
    release: exactResolution.release,
    capability: exactResolution.capability,
  };
}

async function resolvedCapabilityRunVersion(
  siteAgentId: string,
  capabilityId: string,
) {
  const selected = await resolveCurrentCapabilityVersion(siteAgentId, capabilityId);
  if (!selected) return undefined;
  const releaseId = selected.version.publishedReleaseId!;
  const releaseVersion = selected.version.publishedReleaseVersion!;
  const database = getD1Binding();
  const release = database
    ? await d1ReleaseById(database, siteAgentId, releaseId)
    : memoryReleaseById(memoryAgent(siteAgentId), releaseId);
  if (!release || release.version !== releaseVersion) {
    throw new Error("capability_version_release_mismatch");
  }
  const capability = runtimeCapability(release, capabilityId);
  if (!capability) throw new Error("capability_version_runtime_missing");
  const startUrl = trustedPinnedLaunchStartUrl(
    release,
    selected.version.validation!.startUrl!,
  );
  return {
    capabilityVersionId: selected.version.id,
    startUrl,
    release,
    capability,
  };
}

let localCapabilityRunTokenSecret: string | undefined;

function capabilityRunTokenSecret() {
  const configured = [
    process.env.SITEWAKE_IDEMPOTENCY_SECRET,
    process.env.SITEWAKE_RUNNER_ENROLLMENT_TOKEN,
    process.env.SITEWAKE_RUNNER_TOKEN,
    process.env.ACCESS_ADMIN_KEY,
  ].map((value) => value?.trim()).find((value) => value && value.length >= 32);
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("capability_run_idempotency_secret_missing");
  }
  if (!localCapabilityRunTokenSecret) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    localCapabilityRunTokenSecret = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0")).join("");
  }
  return localCapabilityRunTokenSecret;
}

async function capabilityRunHmac(payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(capabilityRunTokenSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

async function idempotentCapabilityRunLaunchToken(
  siteAgentId: string,
  idempotencyKey: string,
) {
  return capabilityRunHmac(
    `capability-run-launch:${siteAgentId}:${idempotencyKey}`,
  );
}

function taskLaunchUrlFromStored(
  launch: TaskLaunch,
  rawToken: string,
) {
  const entry = launch.startUrl || launch.allowedOrigin;
  const launchUrl = new URL(entry);
  const returnHash = launchUrl.hash.replace(/^#/, "");
  launchUrl.hash = new URLSearchParams({
    ...(returnHash ? { "sitewake-return-hash": returnHash } : {}),
    "sitewake-launch": `${launch.id}.${rawToken}`,
  }).toString();
  return launchUrl.toString();
}

async function replayCapabilityRunResponse(
  database: D1DatabaseLike,
  siteAgentId: string,
  idempotencyKey: string,
  responseJson: string,
) {
  const stored = JSON.parse(responseJson) as {
    run: CapabilityRun;
    persistence: "d1";
  };
  let launchUrl: string | undefined;
  if (stored.run.taskLaunchId) {
    const launchRows = await all<Pick<TaskLaunchRow, "launchJson">>(
      database,
      `SELECT launch_json AS launchJson
         FROM site_agent_v2_task_launches
        WHERE id=? AND site_agent_id=? LIMIT 1`,
      [stored.run.taskLaunchId, siteAgentId],
    );
    if (!launchRows[0]) {
      throw new Error("capability_run_idempotency_launch_missing");
    }
    launchUrl = taskLaunchUrlFromStored(
      JSON.parse(launchRows[0].launchJson) as TaskLaunch,
      await idempotentCapabilityRunLaunchToken(siteAgentId, idempotencyKey),
    );
  }
  return { ...stored, launchUrl, duplicate: true };
}

type CreateCapabilityRunInput = {
  siteAgentId: string;
  projectId?: string;
  capabilityId: string;
  mode: ExecutionMode;
  environment: ExecutionEnvironment;
  input: Record<string, JsonValue>;
  idempotencyKey?: string;
};

async function createCapabilityRunUnlocked(input: CreateCapabilityRunInput) {
  const idempotencyKey = input.idempotencyKey?.trim();
  // The key is also the entropy source for reconstructing a connected-browser
  // launch bearer after an idempotent retry. Only accept an RFC 4122 UUID so a
  // database reader cannot enumerate a short caller key and recover that token.
  if (idempotencyKey
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
    throw new Error("capability_run_idempotency_key_invalid");
  }
  const idempotencyKeyHash = idempotencyKey
    ? await capabilityRunHmac(
        `capability-run-idempotency:${input.siteAgentId}:${idempotencyKey}`,
      )
    : undefined;
  const requestHash = await sha256Json({
    siteAgentId: input.siteAgentId,
    projectId: input.projectId || null,
    capabilityId: input.capabilityId,
    mode: input.mode,
    environment: input.environment,
    input: input.input,
  });
  const database = getD1Binding();
  if (!database && idempotencyKeyHash) {
    const existing = memoryAgent(input.siteAgentId).capabilityRunRequests.get(
      idempotencyKeyHash,
    );
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new Error("capability_run_idempotency_conflict");
      }
      return { ...existing.result, duplicate: true };
    }
  }
  if (database) {
    await ensureSiteAgentV2Schema(database);
    if (idempotencyKeyHash) {
      const existing = await all<{
        requestHash?: string;
        responseJson?: string;
      }>(
        database,
        `SELECT request_hash AS requestHash,response_json AS responseJson
           FROM site_agent_v2_capability_runs
          WHERE site_agent_id=? AND idempotency_key_hash=? LIMIT 1`,
        [input.siteAgentId, idempotencyKeyHash],
      );
      if (existing[0]) {
        if (existing[0].requestHash !== requestHash) {
          throw new Error("capability_run_idempotency_conflict");
        }
        if (!existing[0].responseJson) {
          throw new Error("capability_run_idempotency_receipt_missing");
        }
        return replayCapabilityRunResponse(
          database,
          input.siteAgentId,
          idempotencyKey!,
          existing[0].responseJson,
        );
      }
    }
  }
  if (input.environment.kind === "managed-profile") throw new Error("managed_profile_not_configured");
  const resolvedVersion = await resolvedCapabilityRunVersion(
    input.siteAgentId,
    input.capabilityId,
  );
  const resolvedRevision = resolvedVersion
    ? undefined
    : await (async () => {
        const active = await getActiveSiteAgentRelease(input.siteAgentId);
        return resolvedCapabilityRunRevision(
          input.siteAgentId,
          input.projectId,
          active.release,
          input.capabilityId,
          runtimeCapability(active.release, input.capabilityId),
          {
            allowLegacyReleasePlan: input.environment.kind === "connected-browser",
          },
        );
      })();
  const executionRelease = resolvedVersion?.release || resolvedRevision!.release;
  const executionCapability = resolvedVersion?.capability || resolvedRevision!.capability;
  validateRunInput(executionCapability.inputs, input.input);
  const now = new Date().toISOString();
  const run: CapabilityRun = {
    id: uid("capability_run"), siteAgentId: input.siteAgentId,
    ...(resolvedRevision ? { projectId: resolvedRevision.projectId } : {}),
    capabilityId: executionCapability.id,
    capabilityName: executionCapability.name, mode: input.mode, environment: input.environment,
    releaseId: executionRelease.id,
    releaseVersion: executionRelease.version,
    ...(resolvedVersion
      ? { capabilityVersionId: resolvedVersion.capabilityVersionId }
      : {}),
    ...(resolvedRevision?.revisionId ? { revisionId: resolvedRevision.revisionId } : {}),
    ...((resolvedVersion?.startUrl || resolvedRevision?.startUrl)
      ? { startUrl: resolvedVersion?.startUrl || resolvedRevision?.startUrl }
      : {}),
    status: input.environment.kind === "connected-browser" ? "waiting-for-browser" : "queued",
    input: input.input, steps: [], artifactIds: [], timings: {}, createdAt: now, updatedAt: now,
  };
  let launchUrl: string | undefined;
  let deferredLaunch:
    | {
        tokenHash: string;
        memoryLaunch: TaskLaunch & {
          tokenHash: string;
          claimKeyHash?: string;
        };
      }
    | undefined;
  if (input.environment.kind === "connected-browser") {
    const launched = await createTaskLaunch({
      siteAgentId: input.siteAgentId,
      projectId: resolvedRevision?.projectId,
      capabilityId: executionCapability.id,
      capabilityRunId: run.id,
      releaseId: executionRelease.id,
      releaseVersion: executionRelease.version,
      capabilityVersionId: resolvedVersion?.capabilityVersionId,
      revisionId: resolvedRevision?.revisionId,
      startUrl: resolvedVersion?.startUrl || resolvedRevision?.startUrl,
      goal: executionCapability.goalTemplate || executionCapability.name,
      input: input.input,
      mode: "run",
      executionMode: input.mode,
      deferPersistence: true,
      rawToken: idempotencyKey
        ? await idempotentCapabilityRunLaunchToken(
            input.siteAgentId,
            idempotencyKey,
          )
        : undefined,
    });
    if (!launched.deferred) throw new Error("task_launch_deferred_row_missing");
    run.taskLaunchId = launched.launch.id;
    launchUrl = launched.launchUrl;
    deferredLaunch = launched.deferred;
  }
  if (!database) {
    const agent = memoryAgent(input.siteAgentId);
    if (deferredLaunch) agent.taskLaunches.push(deferredLaunch.memoryLaunch);
    agent.capabilityRuns.push(run);
    const result = {
      run,
      launchUrl,
      persistence: "memory" as const,
    };
    if (idempotencyKeyHash) {
      agent.capabilityRunRequests.set(idempotencyKeyHash, {
        requestHash,
        result,
      });
    }
    return result;
  }
  const response = { run, launchUrl, persistence: "d1" as const };
  const storedResponse = { run, persistence: "d1" as const };
  const statements = [];
  if (deferredLaunch) {
    const launch = deferredLaunch.memoryLaunch;
    const {
      tokenHash: _tokenHash,
      claimKeyHash: _claimKeyHash,
      ...persistedLaunch
    } = launch;
    void _tokenHash;
    void _claimKeyHash;
    statements.push(database.prepare(`INSERT INTO site_agent_v2_task_launches
      (id,site_agent_id,project_id,capability_id,status,token_hash,
       claim_key_hash,launch_json,created_at,updated_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(
        launch.id,
        launch.siteAgentId,
        launch.projectId || null,
        launch.capabilityId || null,
        launch.status,
        deferredLaunch.tokenHash,
        null,
        JSON.stringify(persistedLaunch),
        launch.createdAt,
        launch.updatedAt,
        launch.expiresAt,
      ));
  }
  statements.push(database.prepare(`INSERT INTO site_agent_v2_capability_runs
    (id,site_agent_id,project_id,capability_id,status,environment_kind,
     lease_expires_at,idempotency_key_hash,request_hash,response_json,
     run_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      run.id,
      run.siteAgentId,
      run.projectId || null,
      run.capabilityId,
      run.status,
      run.environment.kind,
      null,
      idempotencyKeyHash || null,
      idempotencyKeyHash ? requestHash : null,
      idempotencyKeyHash ? JSON.stringify(storedResponse) : null,
      JSON.stringify(run),
      run.createdAt,
      run.updatedAt,
    ));
  let results: Awaited<ReturnType<D1DatabaseLike["batch"]>> = [];
  let batchError: unknown;
  try {
    results = await database.batch(statements);
  } catch (error) {
    batchError = error;
  }
  const failure = batchError || results.find((result) => !result.success);
  if (failure) {
    if (idempotencyKeyHash) {
      const existing = await all<{
        requestHash?: string;
        responseJson?: string;
      }>(
        database,
        `SELECT request_hash AS requestHash,response_json AS responseJson
           FROM site_agent_v2_capability_runs
          WHERE site_agent_id=? AND idempotency_key_hash=? LIMIT 1`,
        [input.siteAgentId, idempotencyKeyHash],
      );
      if (existing[0]?.requestHash === requestHash && existing[0].responseJson) {
        return replayCapabilityRunResponse(
          database,
          input.siteAgentId,
          idempotencyKey!,
          existing[0].responseJson,
        );
      }
      if (existing[0]) throw new Error("capability_run_idempotency_conflict");
    }
    throw new Error(
      failure instanceof Error
        ? failure.message
        : failure && typeof failure === "object" && "error" in failure
          ? String(failure.error || "capability_run_create_failed")
          : "capability_run_create_failed",
    );
  }
  if (results.some((result) => Number(result.meta?.changes || 0) < 1)) {
    throw new Error("capability_run_create_conflict");
  }
  return response;
}

export async function createCapabilityRun(input: CreateCapabilityRunInput) {
  const idempotencyKey = input.idempotencyKey?.trim();
  if (getD1Binding() || !idempotencyKey) {
    return createCapabilityRunUnlocked(input);
  }
  const lockKey = `${input.siteAgentId}:${await capabilityRunHmac(
    `capability-run-lock:${input.siteAgentId}:${idempotencyKey}`,
  )}`;
  while (memoryCapabilityRunLocks.has(lockKey)) {
    await memoryCapabilityRunLocks.get(lockKey);
  }
  let releaseLock!: () => void;
  const lock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  memoryCapabilityRunLocks.set(lockKey, lock);
  try {
    return await createCapabilityRunUnlocked(input);
  } finally {
    if (memoryCapabilityRunLocks.get(lockKey) === lock) {
      memoryCapabilityRunLocks.delete(lockKey);
    }
    releaseLock();
  }
}

export async function getCapabilityRun(siteAgentId: string, runId: string) {
  const database = getD1Binding();
  let run: CapabilityRun | undefined;
  if (!database) run = memoryAgent(siteAgentId).capabilityRuns.find((item) => item.id === runId);
  else {
    await ensureSiteAgentV2Schema(database);
    const rows = await all<CapabilityRunRow>(database, `SELECT run_json AS runJson FROM site_agent_v2_capability_runs WHERE id=? AND site_agent_id=? LIMIT 1`, [runId, siteAgentId]);
    run = rows[0] ? JSON.parse(rows[0].runJson) as CapabilityRun : undefined;
  }
  if (run?.taskLaunchId && !["completed", "failed", "cancelled", "expired"].includes(run.status)) {
    const launched = await getTaskLaunch(siteAgentId, run.taskLaunchId);
    if (launched.launch) {
      run = capabilityRunFromTaskLaunch(run, launched.launch);
    }
  }
  return {
    run: run ? projectPublicRunnerLeasedRecord(run) : undefined,
    persistence: database ? "d1" as const : "memory" as const,
  };
}

export async function listCapabilityRuns(siteAgentId: string, options: { capabilityId?: string; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(50, options.limit || 12));
  const database = getD1Binding();
  if (!database) {
    const runs = memoryAgent(siteAgentId).capabilityRuns
      .filter((item) => !options.capabilityId || item.capabilityId === options.capabilityId)
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
    return { runs: runs.map(projectPublicRunnerLeasedRecord), persistence: "memory" as const };
  }
  await ensureSiteAgentV2Schema(database);
  const rows = options.capabilityId
    ? await all<CapabilityRunRow>(database, `SELECT run_json AS runJson FROM site_agent_v2_capability_runs WHERE site_agent_id=? AND capability_id=? ORDER BY created_at DESC LIMIT ?`, [siteAgentId, options.capabilityId, limit])
    : await all<CapabilityRunRow>(database, `SELECT run_json AS runJson FROM site_agent_v2_capability_runs WHERE site_agent_id=? ORDER BY created_at DESC LIMIT ?`, [siteAgentId, limit]);
  return {
    runs: rows.map((row) => projectPublicRunnerLeasedRecord(JSON.parse(row.runJson) as CapabilityRun)),
    persistence: "d1" as const,
  };
}

export async function updateCapabilityRunFromRunner(
  runnerId: string,
  leaseToken: string,
  runId: string,
  patch: Pick<CapabilityRun, "status" | "steps" | "timings" | "artifactIds">
    & Partial<Pick<CapabilityRun, "progress" | "output" | "outcome" | "resultUrl" | "error" | "startedAt" | "completedAt">>
    & { browserRun?: BrowserRun },
  options: { allowCompletedRetry?: boolean } = {},
) {
  const database = getD1Binding();
  if (!database) throw new Error("capability_runner_requires_d1");
  await ensureSiteAgentV2Schema(database);
  const rows = await all<CapabilityRunRow>(database, `SELECT run_json AS runJson FROM site_agent_v2_capability_runs WHERE id=? LIMIT 1`, [runId]);
  if (!rows[0]) throw new Error("capability_run_not_found");
  const stored = JSON.parse(rows[0].runJson) as CapabilityRun;
  const { browserRun, ...runPatch } = patch;
  const storedLease = stored.lease;
  const now = new Date().toISOString();
  const requestedTerminal = runPatch.status === "completed"
    || runPatch.status === "failed"
    || runPatch.status === "cancelled";
  if (!requestedTerminal
    && (runPatch.output !== undefined
      || runPatch.outcome !== undefined
      || runPatch.error !== undefined
      || runPatch.completedAt !== undefined
      || browserRun !== undefined)) {
    throw new Error("capability_run_nonterminal_result_rejected");
  }
  if (requestedTerminal && !browserRun) {
    throw new Error("capability_browser_run_required");
  }
  const effectiveRunPatch = requestedTerminal
    ? { ...runPatch, output: runPatch.output ?? stored.output ?? {} }
    : runPatch;
  const terminalPayloadHash = requestedTerminal
    ? await sha256Json({ runPatch: effectiveRunPatch, browserRun })
    : undefined;
  if (!storedLease || !businessLeaseAuthorized(storedLease, runnerId, leaseToken)) {
    if (options.allowCompletedRetry
      && !storedLease
      && requestedTerminal
      && stored.completionReceipt?.runnerId === runnerId
      && stored.completionReceipt.payloadHash === terminalPayloadHash
      && stored.completionReceipt.browserRunId === browserRun?.id) {
      return { run: stored, duplicate: true, persistence: "d1" as const };
    }
    throw new Error("invalid_runner_lease");
  }

  if (canonicalJsonString({ ...effectiveRunPatch, browserRun }).length > 5_000_000) {
    throw new Error("capability_run_patch_too_large");
  }
  if (!["running", "completed", "failed", "cancelled"].includes(runPatch.status)) {
    throw new Error("capability_run_status_invalid");
  }
  if (!Array.isArray(runPatch.steps) || runPatch.steps.length > 2_000) {
    throw new Error("capability_run_steps_invalid");
  }
  if (!Array.isArray(runPatch.artifactIds)
    || runPatch.artifactIds.length > 128
    || runPatch.artifactIds.some((id) => typeof id !== "string" || !id || id.length > 200)) {
    throw new Error("capability_run_artifacts_invalid");
  }
  if (!runPatch.timings
    || typeof runPatch.timings !== "object"
    || Object.values(runPatch.timings).some((value) =>
      value !== undefined && (!Number.isFinite(value) || value < 0))) {
    throw new Error("capability_run_timings_invalid");
  }
  if (browserRun && !requestedTerminal) {
    throw new Error("capability_browser_run_requires_terminal_status");
  }
  if (stored.status !== "queued"
    && stored.status !== "waiting-for-browser"
    && stored.status !== "running") {
    throw new Error("capability_run_already_terminal");
  }

  let acceptedPatch = effectiveRunPatch;
  let pinnedRelease: SiteAgentReleaseV2 | undefined;
  if (effectiveRunPatch.status === "completed") {
    try {
      if (!stored.releaseId
        || stored.releaseVersion === undefined
        || (!stored.capabilityVersionId
          && (!stored.projectId || !stored.revisionId))) {
        throw new Error("capability_run_execution_pin_incomplete");
      }
      const release = await d1ReleaseById(
        database,
        stored.siteAgentId,
        stored.releaseId,
      );
      if (!release || release.version !== stored.releaseVersion) {
        throw new Error("capability_run_release_mismatch");
      }
      pinnedRelease = release;
      const capability = runtimeCapability(release, stored.capabilityId);
      if (!capability) throw new Error("capability_run_capability_not_found");
      if (stored.capabilityVersionId) {
        await assertPinnedCapabilityVersion({
          siteAgentId: stored.siteAgentId,
          capabilityId: stored.capabilityId,
          capabilityVersionId: stored.capabilityVersionId,
          releaseId: stored.releaseId,
          releaseVersion: stored.releaseVersion,
        });
      } else {
        const revisionRows = await all<CapabilityRevisionRow>(
          database,
          `SELECT revision_json AS revisionJson
             FROM site_agent_v2_capability_revisions
            WHERE id=? AND site_agent_id=? AND project_id=? LIMIT 1`,
          [stored.revisionId, stored.siteAgentId, stored.projectId],
        );
        const revision = revisionRows[0]
          ? JSON.parse(revisionRows[0].revisionJson) as CapabilityRevision
          : undefined;
        if (!revision
          || revision.publishedReleaseId !== stored.releaseId
          || revision.publishedReleaseVersion !== stored.releaseVersion) {
          throw new Error("capability_run_revision_mismatch");
        }
        assertCapabilityRevisionRelease(release, capability, revision);
      }
      assertCapabilityOutput(capability.outputs, effectiveRunPatch.output ?? {});
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      const code = summary.split(":", 1)[0] || "capability_output_invalid";
      acceptedPatch = {
        ...effectiveRunPatch,
        status: "failed",
        output: {},
        outcome: {
          status: "execution-fault",
          code,
          summary,
          evaluatedAt: effectiveRunPatch.completedAt || now,
          evidence: { source: "server-output-contract" },
        },
        error: { code, summary },
      };
    }
  }

  const terminal = acceptedPatch.status === "completed"
    || acceptedPatch.status === "failed"
    || acceptedPatch.status === "cancelled";
  const mirroredLeaseExpiresAt = terminal
    ? undefined
    : await synchronizedBusinessLeaseExpiry(storedLease);
  const next: CapabilityRun = {
    ...stored,
    ...acceptedPatch,
    runnerId,
    updatedAt: now,
    completedAt: terminal
      ? acceptedPatch.completedAt || now
      : acceptedPatch.completedAt || stored.completedAt,
    lease: mirroredLeaseExpiresAt ? { ...storedLease, expiresAt: mirroredLeaseExpiresAt } : undefined,
    completionReceipt: terminal
      ? {
        runnerId,
        payloadHash: terminalPayloadHash!,
        ...(browserRun?.id ? { browserRunId: browserRun.id } : {}),
      }
      : stored.completionReceipt,
  };
  next.timings = {
    ...stored.timings,
    ...acceptedPatch.timings,
    totalMs: acceptedPatch.timings.totalMs ?? (terminal ? Math.max(0, Date.parse(next.completedAt!) - Date.parse(next.createdAt)) : stored.timings.totalMs),
    executionMs: acceptedPatch.timings.executionMs ?? stored.timings.executionMs,
  };

  let nestedRun: BrowserRun | undefined;
  let existingBrowserRunJson: string | undefined;
  if (browserRun && terminal) {
    if (!browserRun.id || !browserRun.startedAt || !browserRun.startUrl) {
      throw new Error("capability_browser_run_invalid");
    }
    if (!stored.releaseId || stored.releaseVersion === undefined || !stored.startUrl) {
      throw new Error("capability_run_execution_pin_incomplete");
    }
    pinnedRelease ||= await d1ReleaseById(database, stored.siteAgentId, stored.releaseId) || undefined;
    if (!pinnedRelease || pinnedRelease.version !== stored.releaseVersion) {
      throw new Error("capability_run_release_mismatch");
    }
    const expectedStartUrl = trustedPinnedLaunchStartUrl(
      pinnedRelease,
      stored.startUrl,
    );
    const evidenceStartUrl = trustedPinnedLaunchStartUrl(
      pinnedRelease,
      browserRun.startUrl,
    );
    if (evidenceStartUrl !== expectedStartUrl) {
      throw new Error("capability_browser_run_start_url_mismatch");
    }
    for (const [kind, value] of [
      ["result", next.resultUrl],
      ["end", browserRun.endUrl],
    ] as const) {
      if (!value) continue;
      try {
        const parsed = new URL(value);
        if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
          || parsed.username
          || parsed.password
          || !trustedReleaseOriginsForLaunch(pinnedRelease).includes(parsed.origin)) {
          throw new Error("untrusted");
        }
      } catch {
        throw new Error(`capability_browser_run_${kind}_url_untrusted`);
      }
    }
    nestedRun = {
      ...browserRun,
      learningJobId: `capability_run:${runId}`,
      validationJobId: undefined,
      siteAgentId: stored.siteAgentId,
      candidateId: stored.capabilityId,
      runnerId,
      mode: stored.mode === "debug" ? "debug" : "execute",
      status: next.status === "completed" ? "passed" : "failed",
      steps: next.steps,
      outcome: next.outcome,
      artifactIds: next.artifactIds,
      endedAt: browserRun.endedAt || next.completedAt || now,
    };
    const browserRows = await all<BrowserRunRow>(
      database,
      `SELECT run_json AS runJson
         FROM site_agent_v2_browser_runs
        WHERE id=? LIMIT 1`,
      [nestedRun.id],
    );
    existingBrowserRunJson = browserRows[0]?.runJson;
    if (existingBrowserRunJson
      && existingBrowserRunJson !== JSON.stringify(nestedRun)) {
      throw new Error("capability_browser_run_conflict");
    }
  }

  const nextJson = JSON.stringify(next);
  const statements = [
    database.prepare(`UPDATE site_agent_v2_capability_runs
      SET status=?,lease_expires_at=?,run_json=?,updated_at=?
      WHERE id=? AND site_agent_id=? AND run_json=?
        AND status NOT IN ('completed','failed','expired','cancelled')`)
      .bind(
        next.status,
        next.lease?.expiresAt || null,
        nextJson,
        now,
        runId,
        stored.siteAgentId,
        rows[0].runJson,
      ),
  ];
  if (nestedRun && !existingBrowserRunJson) {
    statements.push(database.prepare(`INSERT INTO site_agent_v2_browser_runs
      (id,learning_job_id,validation_job_id,site_agent_id,candidate_id,status,run_json,started_at,ended_at)
      SELECT ?,?,?,?,?,?,?,?,?
       WHERE EXISTS (
         SELECT 1 FROM site_agent_v2_capability_runs
          WHERE id=? AND site_agent_id=? AND run_json=?
       )`)
      .bind(
        nestedRun.id,
        nestedRun.learningJobId,
        null,
        nestedRun.siteAgentId,
        nestedRun.candidateId,
        nestedRun.status,
        JSON.stringify(nestedRun),
        nestedRun.startedAt,
        nestedRun.endedAt || null,
        runId,
        stored.siteAgentId,
        nextJson,
      ));
  }
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "capability_run_update_failed");
  if (Number(results[0]?.meta?.changes || 0) < 1) {
    const currentRows = await all<CapabilityRunRow>(
      database,
      `SELECT run_json AS runJson
         FROM site_agent_v2_capability_runs
        WHERE id=? AND site_agent_id=? LIMIT 1`,
      [runId, stored.siteAgentId],
    );
    const current = currentRows[0]
      ? JSON.parse(currentRows[0].runJson) as CapabilityRun
      : undefined;
    if (current?.completionReceipt?.runnerId === runnerId
      && current.completionReceipt.payloadHash === terminalPayloadHash
      && current.completionReceipt.browserRunId === browserRun?.id) {
      return { run: current, duplicate: true, persistence: "d1" as const };
    }
    throw new Error("capability_run_update_conflict");
  }
  if (nestedRun && !existingBrowserRunJson
    && Number(results[1]?.meta?.changes || 0) < 1) {
    throw new Error("capability_browser_run_save_failed");
  }
  if (terminal) {
    await heartbeatValidationRunner(runnerId, "online").catch(() => undefined);
  }
  return { run: next, persistence: "d1" as const };
}

export async function getTaskLaunch(siteAgentId: string, launchId: string) {
  const database = getD1Binding();
  let launch: TaskLaunch | undefined;
  if (!database) launch = memoryAgent(siteAgentId).taskLaunches.find((item) => item.id === launchId);
  else {
    await ensureSiteAgentV2Schema(database);
    const rows = await all<TaskLaunchRow>(database, `SELECT launch_json AS launchJson,token_hash AS tokenHash,claim_key_hash AS claimKeyHash,status,updated_at AS updatedAt FROM site_agent_v2_task_launches WHERE id=? AND site_agent_id=? LIMIT 1`, [launchId, siteAgentId]);
    launch = rows[0] ? taskLaunchFromRow(rows[0]) : undefined;
  }
  if (launch && launch.status === "pending" && launch.expiresAt <= new Date().toISOString()) launch = { ...launch, status: "expired", updatedAt: new Date().toISOString() };
  return {
    launch: launch ? projectPublicTaskLaunch(launch) : undefined,
    persistence: database ? "d1" as const : "memory" as const,
  };
}

function capabilityRunFromTaskLaunch(
  run: CapabilityRun,
  launch: TaskLaunch,
): CapabilityRun {
  const status = launch.status === "completed"
    ? "completed"
    : launch.status === "failed"
      ? "failed"
      : launch.status === "expired"
        ? "expired"
        : launch.status === "cancelled"
          ? "cancelled"
          : launch.status === "running" || launch.status === "claimed"
            ? "running"
            : "waiting-for-browser";
  const completedAt = launch.completedAt;
  return {
    ...run,
    status,
    output: launch.output,
    outcome: launch.outcome,
    resultUrl: launch.resultUrl,
    error: launch.error,
    startedAt: launch.claimedAt || run.startedAt,
    completedAt,
    updatedAt: launch.updatedAt,
    timings: {
      ...run.timings,
      queuedMs: launch.claimedAt
        ? Math.max(0, Date.parse(launch.claimedAt) - Date.parse(run.createdAt))
        : undefined,
      executionMs: completedAt && launch.claimedAt
        ? Math.max(0, Date.parse(completedAt) - Date.parse(launch.claimedAt))
        : undefined,
      totalMs: completedAt
        ? Math.max(0, Date.parse(completedAt) - Date.parse(run.createdAt))
        : undefined,
    },
  };
}

function expiredTaskLaunch(stored: TaskLaunch, now: string): TaskLaunch {
  const code = stored.status === "pending"
    ? "task_launch_pending_expired"
    : "task_launch_lease_expired";
  return {
    ...stored,
    status: "expired",
    output: stored.output ?? {},
    outcome: {
      status: "execution-fault",
      code,
      summary: stored.status === "pending"
        ? "The browser did not claim this launch before it expired."
        : "The claimed browser stopped renewing its execution lease.",
      evidence: { source: "task-launch-watchdog" },
      evaluatedAt: now,
    },
    error: {
      code,
      summary: stored.status === "pending"
        ? "Task launch expired before claim."
        : "Task launch execution lease expired.",
    },
    updatedAt: now,
    completedAt: now,
  };
}

/**
 * Explicit watchdog for TaskLaunch records. Read APIs remain observational;
 * this mutating sweep is invoked by continuously-running runner heartbeats and
 * may also be called by an operator/test with an injected clock.
 */
export async function expireStaleTaskLaunches(
  options: { database?: D1DatabaseLike; now?: string } = {},
) {
  const now = options.now || new Date().toISOString();
  const database = options.database ?? getD1Binding();
  if (!database) {
    let expired = 0;
    for (const agent of memoryStore().values()) {
      for (let index = 0; index < agent.taskLaunches.length; index += 1) {
        const stored = agent.taskLaunches[index];
        if (!["pending", "claimed", "running"].includes(stored.status)
          || stored.expiresAt > now) continue;
        const launch = expiredTaskLaunch(stored, now);
        agent.taskLaunches[index] = {
          ...launch,
          tokenHash: stored.tokenHash,
          claimKeyHash: stored.claimKeyHash,
        };
        if (stored.capabilityRunId) {
          const runIndex = agent.capabilityRuns.findIndex(
            (run) => run.id === stored.capabilityRunId,
          );
          const run = runIndex >= 0 ? agent.capabilityRuns[runIndex] : undefined;
          if (run && !["completed", "failed", "cancelled", "expired"].includes(run.status)) {
            agent.capabilityRuns[runIndex] = capabilityRunFromTaskLaunch(run, launch);
          }
        }
        expired += 1;
      }
    }
    return { expired, persistence: "memory" as const };
  }

  await ensureSiteAgentV2Schema(database);
  const rows = await all<TaskLaunchRow & { id: string; siteAgentId: string }>(
    database,
    `SELECT id,site_agent_id AS siteAgentId,launch_json AS launchJson,
            token_hash AS tokenHash,claim_key_hash AS claimKeyHash,
            status,updated_at AS updatedAt
       FROM site_agent_v2_task_launches
      WHERE status IN ('pending','claimed','running') AND expires_at<=?
      ORDER BY expires_at ASC LIMIT 100`,
    [now],
  );
  let expired = 0;
  for (const row of rows) {
    const stored = taskLaunchFromRow(row);
    if (!["pending", "claimed", "running"].includes(stored.status)
      || stored.expiresAt > now) continue;
    const launch = expiredTaskLaunch(stored, now);
    let related:
      | { run: CapabilityRun; rowJson: string; next: CapabilityRun }
      | undefined;
    if (stored.capabilityRunId) {
      const runRows = await all<CapabilityRunRow>(
        database,
        `SELECT run_json AS runJson
           FROM site_agent_v2_capability_runs
          WHERE id=? AND site_agent_id=? LIMIT 1`,
        [stored.capabilityRunId, row.siteAgentId],
      );
      if (runRows[0]) {
        const run = JSON.parse(runRows[0].runJson) as CapabilityRun;
        if (!["completed", "failed", "cancelled", "expired"].includes(run.status)) {
          related = {
            run,
            rowJson: runRows[0].runJson,
            next: capabilityRunFromTaskLaunch(run, launch),
          };
        }
      }
    }
    const launchJson = JSON.stringify(launch);
    const launchUpdate = related
      ? database.prepare(`UPDATE site_agent_v2_task_launches
          SET status='expired',launch_json=?,updated_at=?
          WHERE id=? AND site_agent_id=? AND launch_json=?
            AND status IN ('pending','claimed','running')
            AND EXISTS (
              SELECT 1 FROM site_agent_v2_capability_runs
               WHERE id=? AND site_agent_id=? AND run_json=?
                 AND status NOT IN ('completed','failed','expired','cancelled')
            )`)
        .bind(
          launchJson,
          now,
          row.id,
          row.siteAgentId,
          row.launchJson,
          related.run.id,
          row.siteAgentId,
          related.rowJson,
        )
      : database.prepare(`UPDATE site_agent_v2_task_launches
          SET status='expired',launch_json=?,updated_at=?
          WHERE id=? AND site_agent_id=? AND launch_json=?
            AND status IN ('pending','claimed','running')`)
        .bind(launchJson, now, row.id, row.siteAgentId, row.launchJson);
    const statements = [launchUpdate];
    if (related) {
      statements.push(database.prepare(`UPDATE site_agent_v2_capability_runs
        SET status='expired',lease_expires_at=NULL,run_json=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND run_json=?
          AND status NOT IN ('completed','failed','expired','cancelled')
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_task_launches
             WHERE id=? AND site_agent_id=? AND launch_json=?
          )`)
        .bind(
          JSON.stringify(related.next),
          now,
          related.run.id,
          row.siteAgentId,
          related.rowJson,
          row.id,
          row.siteAgentId,
          launchJson,
        ));
    }
    const results = await database.batch(statements);
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "task_launch_expiry_failed");
    const launchChanged = Number(results[0]?.meta?.changes || 0);
    const runChanged = related ? Number(results[1]?.meta?.changes || 0) : 1;
    if (related && launchChanged !== runChanged) {
      throw new Error("task_launch_expiry_atomicity_conflict");
    }
    if (launchChanged > 0) expired += 1;
  }
  return { expired, persistence: "d1" as const };
}

export async function claimTaskLaunch(
  siteAgentId: string,
  launchId: string,
  input: { token: string; origin: string; claimKey: string },
) {
  const tokenPart = input.token.includes(".") ? input.token.slice(input.token.indexOf(".") + 1) : input.token;
  const tokenHash = await sha256Hex(tokenPart);
  const origin = normalizeLaunchOrigin(input.origin);
  const claimKey = input.claimKey.trim();
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(claimKey)) {
    throw new Error("task_launch_claim_key_invalid");
  }
  const claimKeyHash = await sha256Hex(claimKey);
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const leaseExpiresAt = new Date(nowDate.getTime() + TASK_LAUNCH_LEASE_TTL_MS).toISOString();
  const database = getD1Binding();
  if (!database) {
    const agent = memoryAgent(siteAgentId); const index = agent.taskLaunches.findIndex((item) => item.id === launchId); const stored = agent.taskLaunches[index];
    if (!stored || stored.tokenHash !== tokenHash || stored.allowedOrigin !== origin) {
      throw new Error("task_launch_claim_rejected");
    }
    if (stored.status === "claimed" && stored.claimKeyHash === claimKeyHash) {
      return {
        launch: projectPublicTaskLaunch(stored),
        claimKey,
        duplicate: true,
        persistence: "memory" as const,
      };
    }
    if (stored.status !== "pending" || stored.expiresAt <= now) {
      throw new Error("task_launch_claim_rejected");
    }
    const launch = {
      ...stored,
      status: "claimed" as const,
      claimedAt: now,
      updatedAt: now,
      expiresAt: leaseExpiresAt,
      claimKeyHash,
    };
    agent.taskLaunches[index] = launch;
    return {
      launch: projectPublicTaskLaunch(launch),
      claimKey,
      persistence: "memory" as const,
    };
  }
  await ensureSiteAgentV2Schema(database);
  const rows = await all<TaskLaunchRow>(database, `SELECT launch_json AS launchJson,token_hash AS tokenHash,claim_key_hash AS claimKeyHash,status,updated_at AS updatedAt FROM site_agent_v2_task_launches WHERE id=? AND site_agent_id=? LIMIT 1`, [launchId, siteAgentId]);
  const row = rows[0]; if (!row) throw new Error("task_launch_not_found"); const stored = taskLaunchFromRow(row);
  if (row.tokenHash !== tokenHash || stored.allowedOrigin !== origin) {
    throw new Error("task_launch_claim_rejected");
  }
  if (stored.status === "claimed" && row.claimKeyHash === claimKeyHash) {
    return {
      launch: projectPublicTaskLaunch(stored),
      claimKey,
      duplicate: true,
      persistence: "d1" as const,
    };
  }
  if (stored.status !== "pending" || stored.expiresAt <= now) {
    throw new Error("task_launch_claim_rejected");
  }
  const launch = {
    ...stored,
    status: "claimed" as const,
    claimedAt: now,
    updatedAt: now,
    expiresAt: leaseExpiresAt,
  };
  const result = await database.prepare(`UPDATE site_agent_v2_task_launches
      SET status='claimed',claim_key_hash=?,launch_json=?,updated_at=?,expires_at=?
      WHERE id=? AND site_agent_id=? AND status='pending' AND launch_json=?`)
    .bind(
      claimKeyHash,
      JSON.stringify(launch),
      now,
      leaseExpiresAt,
      launchId,
      siteAgentId,
      row.launchJson,
    ).run();
  if (!result.success || Number(result.meta?.changes || 0) < 1) throw new Error("task_launch_claim_conflict");
  return {
    launch: projectPublicTaskLaunch(launch),
    claimKey,
    persistence: "d1" as const,
  };
}

type TaskLaunchUpdateInput = {
  claimKey: string;
  /** Browser-supplied Origin header, asserted by the HTTP boundary. */
  origin: string;
  executionOwnerId?: string;
  executionFence?: number;
  previousExecutionOwnerId?: string;
  status?: TaskLaunch["status"];
  taskSessionId?: string;
  outcome?: TaskLaunch["outcome"];
  output?: Record<string, JsonValue>;
  resultUrl?: string;
  error?: TaskLaunch["error"];
};

const taskLaunchTerminalStatuses = new Set<TaskLaunch["status"]>([
  "completed",
  "failed",
  "expired",
  "cancelled",
]);

function taskLaunchTerminalReplayMatches(
  stored: TaskLaunch,
  input: TaskLaunchUpdateInput,
) {
  if (!taskLaunchTerminalStatuses.has(stored.status)
    || input.status !== stored.status) return false;
  return (input.taskSessionId === undefined || input.taskSessionId === stored.taskSessionId)
    && (input.resultUrl === undefined || input.resultUrl === stored.resultUrl)
    && (input.outcome === undefined || JSON.stringify(input.outcome) === JSON.stringify(stored.outcome))
    && (input.output === undefined || JSON.stringify(input.output) === JSON.stringify(stored.output))
    && (input.error === undefined || JSON.stringify(input.error) === JSON.stringify(stored.error));
}

async function taskLaunchTerminalRequestHash(input: TaskLaunchUpdateInput) {
  const { claimKey: _claimKey, ...request } = input;
  void _claimKey;
  return sha256Json(request);
}

function taskLaunchTerminalReceiptMatches(
  stored: TaskLaunch,
  requestHash: string,
) {
  return taskLaunchTerminalStatuses.has(stored.status)
    && stored.terminalRequestHash === requestHash;
}

function assertTaskLaunchUpdatePayload(input: TaskLaunchUpdateInput) {
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(input.claimKey.trim())) {
    throw new Error("task_launch_claim_key_invalid");
  }
  if ((input.taskSessionId?.length || 0) > 500
    || (input.resultUrl?.length || 0) > 4_096
    || (input.executionOwnerId?.length || 0) > 200
    || (input.previousExecutionOwnerId?.length || 0) > 200
    || (input.error?.code?.length || 0) > 200
    || (input.error?.summary?.length || 0) > 8_000) {
    throw new Error("task_launch_update_too_large");
  }
  if ((input.output !== undefined
      && (!input.output || typeof input.output !== "object" || Array.isArray(input.output)))
    || (input.outcome !== undefined
      && (!input.outcome || typeof input.outcome !== "object" || Array.isArray(input.outcome)))
    || (input.error !== undefined
      && (!input.error || typeof input.error !== "object" || Array.isArray(input.error)))) {
    throw new Error("task_launch_result_invalid");
  }
  let nodes = 0;
  const inspect = (value: unknown, depth = 0) => {
    nodes += 1;
    if (depth > 16 || nodes > 20_000) {
      throw new Error("task_launch_update_too_large");
    }
    if (typeof value === "string" && value.length > 32_768) {
      throw new Error("task_launch_update_too_large");
    }
    if (Array.isArray(value)) {
      if (value.length > 2_000) throw new Error("task_launch_update_too_large");
      value.forEach((child) => inspect(child, depth + 1));
    } else if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length > 2_000
        || entries.some(([key]) => key.length > 500)) {
        throw new Error("task_launch_update_too_large");
      }
      entries.forEach(([, child]) => inspect(child, depth + 1));
    }
  };
  inspect(input);
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    throw new Error("task_launch_result_invalid");
  }
  if (new TextEncoder().encode(encoded).byteLength > 192 * 1024) {
    throw new Error("task_launch_update_too_large");
  }
}

function assertTaskLaunchOriginAndResult(
  stored: TaskLaunch,
  input: TaskLaunchUpdateInput,
) {
  let origin: string;
  try {
    origin = new URL(input.origin).origin;
  } catch {
    throw new Error("task_launch_origin_invalid");
  }
  if (origin !== stored.allowedOrigin) {
    throw new Error("task_launch_origin_rejected");
  }
  if (!input.resultUrl) return;
  try {
    const result = new URL(input.resultUrl);
    if ((result.protocol !== "http:" && result.protocol !== "https:")
      || result.username
      || result.password
      || result.origin !== stored.allowedOrigin) {
      throw new Error("untrusted");
    }
  } catch {
    throw new Error("task_launch_result_url_rejected");
  }
}

async function taskLaunchWithValidatedOutput(
  stored: TaskLaunch,
  input: TaskLaunchUpdateInput,
  database?: D1DatabaseLike,
): Promise<TaskLaunchUpdateInput> {
  if (input.status !== "completed" || !stored.capabilityId) return input;
  let failure: Error | undefined;
  try {
    if (!stored.releaseId
      || stored.releaseVersion === undefined
      || (!stored.capabilityVersionId && !stored.revisionId)
      || !stored.capabilityId) {
      throw new Error("task_launch_execution_pin_incomplete");
    }
    const release = database
      ? await d1ReleaseById(database, stored.siteAgentId, stored.releaseId)
      : memoryReleaseById(memoryAgent(stored.siteAgentId), stored.releaseId);
    if (!release || release.version !== stored.releaseVersion) {
      throw new Error("task_launch_release_mismatch");
    }
    const capability = runtimeCapability(release, stored.capabilityId);
    if (!capability) throw new Error("task_launch_capability_not_found");
    if (stored.capabilityVersionId) {
      await assertPinnedCapabilityVersion({
        siteAgentId: stored.siteAgentId,
        capabilityId: stored.capabilityId,
        capabilityVersionId: stored.capabilityVersionId,
        releaseId: stored.releaseId,
        releaseVersion: stored.releaseVersion,
      });
    }
    assertCapabilityOutput(capability.outputs, input.output ?? {});
    return input;
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }
  const code = failure.message.split(":", 1)[0] || "capability_output_invalid";
  const summary = failure.message || code;
  if (stored.status === "failed"
    && stored.error?.code === code
    && JSON.stringify(input.output ?? {}) === JSON.stringify(stored.output ?? {})) {
    return {
      ...input,
      status: "failed",
      output: stored.output,
      outcome: stored.outcome,
      error: stored.error,
    };
  }
  return {
    ...input,
    status: "failed",
    output: {},
    outcome: {
      status: "execution-fault",
      code,
      summary,
      evidence: { source: "server-output-contract" },
      evaluatedAt: new Date().toISOString(),
    },
    error: { code, summary },
  };
}

async function updateTaskLaunchUnlocked(
  siteAgentId: string,
  launchId: string,
  input: TaskLaunchUpdateInput,
  conflictAttempt = 0,
) {
  assertTaskLaunchUpdatePayload(input);
  const submittedInput = { ...input };
  const claimKeyHash = await sha256Hex(input.claimKey);
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const allowedStatuses = new Set<TaskLaunch["status"]>(["running", "completed", "failed", "cancelled"]);
  if (input.status && !allowedStatuses.has(input.status)) {
    throw new Error("task_launch_status_invalid");
  }
  const normalizeUpdate = async (
    stored: TaskLaunch,
    database?: D1DatabaseLike,
  ) => {
    const requestedStatus = input.status || stored.status;
    const terminal = taskLaunchTerminalStatuses.has(requestedStatus);
    if (!terminal
      && (input.output !== undefined
        || input.outcome !== undefined
        || input.error !== undefined)) {
      throw new Error("task_launch_nonterminal_result_rejected");
    }
    const effective = terminal
      ? { ...input, output: input.output ?? stored.output ?? {} }
      : input;
    const requestHash = terminal
      ? await taskLaunchTerminalRequestHash(effective)
      : undefined;
    if (taskLaunchTerminalStatuses.has(stored.status)) {
      return {
        input: effective,
        requestHash,
        executionOwnerId: stored.executionOwnerId,
        executionFence: stored.executionFence,
      };
    }
    if (stored.expiresAt <= now) {
      throw new Error("task_launch_lease_expired");
    }
    const trustedInternalUpdate = effective.executionOwnerId === undefined
      && effective.executionFence === undefined;
    const ownerId = trustedInternalUpdate
      ? stored.executionOwnerId || "trusted_internal_owner"
      : effective.executionOwnerId?.trim();
    const previousOwnerId = effective.previousExecutionOwnerId?.trim();
    const suppliedFence = trustedInternalUpdate
      ? stored.executionFence || 0
      : effective.executionFence;
    if (!ownerId
      || !/^[A-Za-z0-9_-]{8,200}$/.test(ownerId)
      || !Number.isSafeInteger(suppliedFence)
      || Number(suppliedFence) < 0) {
      throw new Error("task_launch_execution_owner_invalid");
    }
    const authorizedFence = Number(suppliedFence);
    let executionFence: number;
    if (!stored.executionOwnerId) {
      if (authorizedFence !== 0) {
        throw new Error("task_launch_execution_fence_rejected");
      }
      executionFence = 1;
    } else if (ownerId === stored.executionOwnerId) {
      if (authorizedFence !== stored.executionFence) {
        throw new Error("task_launch_execution_fence_rejected");
      }
      executionFence = stored.executionFence || 1;
    } else {
      if (requestedStatus !== "running"
        || previousOwnerId !== stored.executionOwnerId
        || authorizedFence !== stored.executionFence) {
        throw new Error("task_launch_execution_owner_rejected");
      }
      executionFence = (stored.executionFence || 1) + 1;
    }
    return {
      input: await taskLaunchWithValidatedOutput(stored, effective, database),
      requestHash,
      executionOwnerId: ownerId,
      executionFence,
    };
  };
  const database = getD1Binding();
  if (!database) {
    const agent = memoryAgent(siteAgentId); const index = agent.taskLaunches.findIndex((item) => item.id === launchId); const stored = agent.taskLaunches[index];
    if (!stored || stored.claimKeyHash !== claimKeyHash) throw new Error("task_launch_update_rejected");
    assertTaskLaunchOriginAndResult(stored, input);
    const normalized = await normalizeUpdate(stored);
    const terminalRequestHash = normalized.requestHash;
    input = normalized.input;
    if (taskLaunchTerminalStatuses.has(stored.status)) {
      if ((terminalRequestHash && taskLaunchTerminalReceiptMatches(stored, terminalRequestHash))
        || (!stored.terminalRequestHash && taskLaunchTerminalReplayMatches(stored, input))) {
        return {
          launch: projectPublicTaskLaunch(stored),
          persistence: "memory" as const,
        };
      }
      throw new Error("task_launch_already_terminal");
    }
    const status = input.status && allowedStatuses.has(input.status) ? input.status : stored.status;
    const terminal = taskLaunchTerminalStatuses.has(status);
    const launch = {
      ...stored,
      status,
      executionOwnerId: normalized.executionOwnerId,
      executionFence: normalized.executionFence,
      taskSessionId: input.taskSessionId ?? stored.taskSessionId,
      outcome: input.outcome ?? stored.outcome,
      output: input.output ?? stored.output,
      resultUrl: input.resultUrl ?? stored.resultUrl,
      error: input.error ?? stored.error,
      updatedAt: now,
      expiresAt: terminal
        ? stored.expiresAt
        : new Date(nowDate.getTime() + TASK_LAUNCH_LEASE_TTL_MS).toISOString(),
      completedAt: terminal ? now : stored.completedAt,
      terminalRequestHash: terminal
        ? terminalRequestHash!
        : stored.terminalRequestHash,
    };
    const runIndex = stored.capabilityRunId
      ? agent.capabilityRuns.findIndex((run) => run.id === stored.capabilityRunId)
      : -1;
    if (stored.capabilityRunId && runIndex < 0) {
      throw new Error("task_launch_capability_run_not_found");
    }
    const currentRun = runIndex >= 0 ? agent.capabilityRuns[runIndex] : undefined;
    if (currentRun
      && ["completed", "failed", "cancelled", "expired"].includes(currentRun.status)) {
      throw new Error("task_launch_capability_run_conflict");
    }
    agent.taskLaunches[index] = launch;
    if (currentRun && runIndex >= 0) {
      agent.capabilityRuns[runIndex] = capabilityRunFromTaskLaunch(
        currentRun,
        launch,
      );
    }
    return {
      launch: projectPublicTaskLaunch(launch),
      persistence: "memory" as const,
    };
  }
  const rows = await all<TaskLaunchRow>(database, `SELECT launch_json AS launchJson,token_hash AS tokenHash,claim_key_hash AS claimKeyHash,status,updated_at AS updatedAt FROM site_agent_v2_task_launches WHERE id=? AND site_agent_id=? LIMIT 1`, [launchId, siteAgentId]);
  const row = rows[0]; if (!row || row.claimKeyHash !== claimKeyHash) throw new Error("task_launch_update_rejected"); const stored = taskLaunchFromRow(row);
  assertTaskLaunchOriginAndResult(stored, input);
  const normalized = await normalizeUpdate(stored, database);
  const terminalRequestHash = normalized.requestHash;
  input = normalized.input;
  if (taskLaunchTerminalStatuses.has(stored.status)) {
    if ((terminalRequestHash && taskLaunchTerminalReceiptMatches(stored, terminalRequestHash))
      || (!stored.terminalRequestHash && taskLaunchTerminalReplayMatches(stored, input))) {
      return {
        launch: projectPublicTaskLaunch(stored),
        persistence: "d1" as const,
      };
    }
    throw new Error("task_launch_already_terminal");
  }
  const status = input.status && allowedStatuses.has(input.status) ? input.status : stored.status;
  const terminal = taskLaunchTerminalStatuses.has(status);
  const launch = {
    ...stored,
    status,
    executionOwnerId: normalized.executionOwnerId,
    executionFence: normalized.executionFence,
    taskSessionId: input.taskSessionId ?? stored.taskSessionId,
    outcome: input.outcome ?? stored.outcome,
    output: input.output ?? stored.output,
    resultUrl: input.resultUrl ?? stored.resultUrl,
    error: input.error ?? stored.error,
    updatedAt: now,
    expiresAt: terminal
      ? stored.expiresAt
      : new Date(nowDate.getTime() + TASK_LAUNCH_LEASE_TTL_MS).toISOString(),
    completedAt: terminal ? now : stored.completedAt,
    terminalRequestHash: terminal
      ? terminalRequestHash!
      : stored.terminalRequestHash,
  };
  let relatedRun:
    | { rowJson: string; run: CapabilityRun; next: CapabilityRun }
    | undefined;
  if (stored.capabilityRunId) {
    const runRows = await all<CapabilityRunRow>(
      database,
      `SELECT run_json AS runJson
         FROM site_agent_v2_capability_runs
        WHERE id=? AND site_agent_id=? LIMIT 1`,
      [stored.capabilityRunId, siteAgentId],
    );
    if (!runRows[0]) throw new Error("task_launch_capability_run_not_found");
    const run = JSON.parse(runRows[0].runJson) as CapabilityRun;
    if (["completed", "failed", "cancelled", "expired"].includes(run.status)) {
      throw new Error("task_launch_capability_run_conflict");
    }
    relatedRun = {
      rowJson: runRows[0].runJson,
      run,
      next: capabilityRunFromTaskLaunch(run, launch),
    };
  }
  const launchJson = JSON.stringify(launch);
  const launchUpdate = relatedRun
    ? database.prepare(`UPDATE site_agent_v2_task_launches
        SET status=?,launch_json=?,updated_at=?,expires_at=?
        WHERE id=? AND site_agent_id=? AND claim_key_hash=? AND launch_json=?
          AND status NOT IN ('completed','failed','expired','cancelled')
          AND EXISTS (
            SELECT 1 FROM site_agent_v2_capability_runs
             WHERE id=? AND site_agent_id=? AND run_json=?
               AND status NOT IN ('completed','failed','expired','cancelled')
          )`)
      .bind(
        status,
        launchJson,
        now,
        launch.expiresAt,
        launchId,
        siteAgentId,
        claimKeyHash,
        row.launchJson,
        relatedRun.run.id,
        siteAgentId,
        relatedRun.rowJson,
      )
    : database.prepare(`UPDATE site_agent_v2_task_launches
        SET status=?,launch_json=?,updated_at=?,expires_at=?
        WHERE id=? AND site_agent_id=? AND claim_key_hash=? AND launch_json=?
          AND status NOT IN ('completed','failed','expired','cancelled')`)
      .bind(
        status,
        launchJson,
        now,
        launch.expiresAt,
        launchId,
        siteAgentId,
        claimKeyHash,
        row.launchJson,
      );
  const statements = [launchUpdate];
  if (relatedRun) {
    const nextRunJson = JSON.stringify(relatedRun.next);
    statements.push(database.prepare(`UPDATE site_agent_v2_capability_runs
      SET status=?,lease_expires_at=NULL,run_json=?,updated_at=?
      WHERE id=? AND site_agent_id=? AND run_json=?
        AND status NOT IN ('completed','failed','expired','cancelled')
        AND EXISTS (
          SELECT 1 FROM site_agent_v2_task_launches
           WHERE id=? AND site_agent_id=? AND launch_json=?
        )`)
      .bind(
        relatedRun.next.status,
        nextRunJson,
        relatedRun.next.updatedAt,
        relatedRun.run.id,
        siteAgentId,
        relatedRun.rowJson,
        launchId,
        siteAgentId,
        launchJson,
      ));
  }
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "task_launch_update_failed");
  if (Number(results[0]?.meta?.changes || 0) < 1) {
    const currentRows = await all<TaskLaunchRow>(
      database,
      `SELECT launch_json AS launchJson,token_hash AS tokenHash,
              claim_key_hash AS claimKeyHash,status,updated_at AS updatedAt
         FROM site_agent_v2_task_launches
        WHERE id=? AND site_agent_id=? LIMIT 1`,
      [launchId, siteAgentId],
    );
    const current = currentRows[0]
      ? taskLaunchFromRow(currentRows[0])
      : undefined;
    if (current
      && currentRows[0].claimKeyHash === claimKeyHash
      && ((terminalRequestHash && taskLaunchTerminalReceiptMatches(current, terminalRequestHash))
        || (!current.terminalRequestHash && taskLaunchTerminalReplayMatches(current, input)))) {
      return {
        launch: projectPublicTaskLaunch(current),
        persistence: "d1" as const,
      };
    }
    if (current
      && currentRows[0].claimKeyHash === claimKeyHash
      && !taskLaunchTerminalStatuses.has(current.status)
      && terminalRequestHash
      && conflictAttempt < 2) {
      return updateTaskLaunchUnlocked(
        siteAgentId,
        launchId,
        submittedInput,
        conflictAttempt + 1,
      );
    }
    throw new Error("task_launch_update_conflict");
  }
  if (relatedRun && Number(results[1]?.meta?.changes || 0) < 1) {
    throw new Error("task_launch_capability_run_conflict");
  }
  return {
    launch: projectPublicTaskLaunch(launch),
    persistence: "d1" as const,
  };
}

export async function updateTaskLaunch(
  siteAgentId: string,
  launchId: string,
  input: TaskLaunchUpdateInput,
) {
  if (getD1Binding()) {
    return updateTaskLaunchUnlocked(siteAgentId, launchId, input);
  }
  const lockKey = `${siteAgentId}:${launchId}`;
  while (memoryTaskLaunchLocks.has(lockKey)) {
    await memoryTaskLaunchLocks.get(lockKey);
  }
  let releaseLock!: () => void;
  const lock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  memoryTaskLaunchLocks.set(lockKey, lock);
  try {
    return await updateTaskLaunchUnlocked(siteAgentId, launchId, input);
  } finally {
    if (memoryTaskLaunchLocks.get(lockKey) === lock) {
      memoryTaskLaunchLocks.delete(lockKey);
    }
    releaseLock();
  }
}

/**
 * On site deletion, the tables this module owns — every `site_agent_v2_*` / `v3_*` table
 * keyed by `site_agent_id`, plus `artifact_chunks` keyed by artifact. Children before
 * parents; the `site_agent_v2_agents` row is not here — the orchestrator puts it last in
 * the batch so any earlier failure leaves the site visible and retryable.
 * Each store module owns its tables so that "forgot a table" is a local error;
 * `tests/site-lifecycle` has a schema-comparison test as a safety net.
 */
export const SITE_AGENT_STORE_DELETION_TABLES = [
  "site_agent_v2_connections",
  "site_agent_v2_knowledge",
  "site_agent_v2_content",
  "site_agent_v2_crawl_jobs",
  "site_agent_v2_preview_jobs",
  "site_agent_v2_learning_jobs",
  "site_agent_v2_validation_jobs",
  "site_agent_v2_dom_replay_chunks",
  "site_agent_v2_browser_runs",
  "site_agent_v2_sessions",
  "site_agent_v2_observations",
  "site_agent_v2_episodes",
  "site_agent_v2_candidates",
  "site_agent_v2_capability_signals",
  "site_agent_v2_revision_reviews",
  "site_agent_v2_capability_revisions",
  "site_agent_v2_capability_projects",
  "site_agent_v2_capability_events",
  "site_agent_v2_capability_suppressions",
  "site_agent_v2_capability_spec_docs",
  "site_agent_v2_authoring_workspaces",
  "site_agent_v2_authoring_guidance",
  "site_agent_v2_codex_authoring_events",
  "site_agent_v2_contract_proposals",
  "site_agent_v2_capability_rfcs",
  "site_agent_v2_task_launches",
  "site_agent_v2_navigation_build_heads",
  "site_agent_v2_capability_runs",
  "site_agent_v2_model_invocations",
  "site_agent_v2_program_modules",
  "site_agent_v2_page_observations",
  "site_agent_v3_capability_programs",
  // Release tables last: many rows above reference release ids in their JSON; delete referrers first.
  "site_agent_v2_releases",
] as const;

export function siteAgentDeletionStatements(database: D1DatabaseLike, siteAgentId: string): D1PreparedStatementLike[] {
  return [
    database.prepare(`DELETE FROM site_agent_v2_artifact_chunks WHERE artifact_id IN (SELECT id FROM site_agent_v2_artifacts WHERE site_agent_id=?)`).bind(siteAgentId),
    database.prepare(`DELETE FROM site_agent_v2_artifacts WHERE site_agent_id=?`).bind(siteAgentId),
    ...SITE_AGENT_STORE_DELETION_TABLES.map((table) => database.prepare(`DELETE FROM ${table} WHERE site_agent_id=?`).bind(siteAgentId)),
  ];
}

/** Object-storage keys of this site's evidence artifacts. `d1:`-prefixed artifacts live in the DB chunk table and have no object. */
export async function siteAgentObjectKeys(database: D1DatabaseLike, siteAgentId: string): Promise<string[]> {
  const rows = await all<{ objectKey: string }>(database, `SELECT object_key AS objectKey FROM site_agent_v2_artifacts WHERE site_agent_id=?`, [siteAgentId]);
  return rows.map((row) => row.objectKey).filter((key) => !key.startsWith("d1:"));
}

export function deleteMemorySiteAgentData(siteAgentId: string) {
  memoryStore().delete(siteAgentId);
  (globalThis as ContentMemoryRoot).__SITEWAKE_SITE_AGENT_V2_CONTENT__?.delete(siteAgentId);
  invalidateSiteAgentListCache();
}

export function resetMemorySiteAgentStore() {
  memoryStore().clear();
  runnerMemoryStore().clear();
  memoryCapabilityRunLocks.clear();
  memoryTaskLaunchLocks.clear();
  invalidateSiteAgentListCache();
}
