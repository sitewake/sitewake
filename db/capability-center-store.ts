import { getD1Binding, type D1DatabaseLike, type D1PreparedStatementLike } from "./index";
import { ensureSiteAgentV2Schema } from "./site-agent-schema";
import { releaseRunnerLeasesForWorkload } from "./runner-control-store";
import { uid, type BrowserArtifact, type BrowserRun, type JsonSchema, type JsonValue } from "../lib/site-knowledge/protocol";
import {
  activatePreparedSiteAgentReleaseInMemory,
  getActiveSiteAgentRelease,
} from "./site-agent-store";
import {
  deleteCapabilityRuntimeRelease,
  publishCapabilityRuntimeRelease,
  relistCapabilityRuntimeRelease,
  unpublishCapabilityRuntimeRelease,
} from "../lib/capability-center/release";
import type {
  Capability,
  CapabilityAcceptanceSpec,
  CapabilityDetail,
  CapabilityExecutionSummary,
  CapabilityProposal,
  CapabilityProposalKind,
  CapabilityProposalStatus,
  CapabilityStatus,
  CapabilityTask,
  CapabilityTaskDetail,
  CapabilityTaskStage,
  CapabilityTaskStatus,
  CapabilityTaskType,
  CapabilityVerificationCheck,
  CapabilityVerificationProof,
  CapabilityVersion,
  CapabilityVersionStatus,
} from "../lib/capability-center/model";

const MIGRATION_KEY = "capability_center_four_table_backfill";
const MIGRATION_VERSION = "2";

type CapabilityRow = {
  id: string;
  site_agent_id: string;
  stable_key: string;
  intent_key: string;
  name: string;
  description: string;
  goal_template: string;
  status: CapabilityStatus;
  current_version_id: string | null;
  latest_version_id: string | null;
  contract_json: string;
  capability_json: string;
  unpublished_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type VersionRow = {
  id: string;
  site_agent_id: string;
  capability_id: string;
  version: number | string;
  status: CapabilityVersionStatus;
  implementation_json: string;
  validation_json: string;
  version_json: string;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

type ProposalRow = {
  id: string;
  site_agent_id: string;
  capability_id: string | null;
  duplicate_capability_id: string | null;
  kind: CapabilityProposalKind;
  status: CapabilityProposalStatus;
  proposal_json: string;
  analysis_json: string;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type TaskRow = {
  id: string;
  site_agent_id: string;
  proposal_id: string | null;
  capability_id: string | null;
  capability_version_id: string | null;
  type: CapabilityTaskType;
  status: CapabilityTaskStatus;
  stage: CapabilityTaskStage;
  task_json: string;
  result_json: string;
  evidence_json: string;
  error_json: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type CapabilityMemory = {
  capabilities: Capability[];
  versions: CapabilityVersion[];
  proposals: CapabilityProposal[];
  tasks: CapabilityTask[];
  settings: CapabilityCenterSettings;
};

export type CapabilityCenterSettings = {
  autoApproval: { enabled: boolean; prompt: string };
};

const DEFAULT_CAPABILITY_CENTER_SETTINGS: CapabilityCenterSettings = {
  autoApproval: { enabled: false, prompt: "" },
};

type MemoryRoot = typeof globalThis & {
  __SITEWAKE_CAPABILITY_CENTER_V2__?: Map<string, CapabilityMemory>;
};

const backfillByDatabase = new WeakMap<object, Promise<CapabilityCenterMigrationResult>>();

function memoryFor(siteAgentId: string) {
  const root = globalThis as MemoryRoot;
  root.__SITEWAKE_CAPABILITY_CENTER_V2__ ||= new Map();
  let memory = root.__SITEWAKE_CAPABILITY_CENTER_V2__.get(siteAgentId);
  if (!memory) {
    memory = { capabilities: [], versions: [], proposals: [], tasks: [], settings: structuredClone(DEFAULT_CAPABILITY_CENTER_SETTINGS) };
    root.__SITEWAKE_CAPABILITY_CENTER_V2__.set(siteAgentId, memory);
  }
  memory.capabilities ||= [];
  memory.versions ||= [];
  memory.proposals ||= [];
  memory.tasks ||= [];
  memory.settings ||= structuredClone(DEFAULT_CAPABILITY_CENTER_SETTINGS);
  return memory;
}

function normalizeCapabilityCenterSettings(input: unknown): CapabilityCenterSettings {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const auto = record.autoApproval && typeof record.autoApproval === "object"
    ? record.autoApproval as Record<string, unknown>
    : {};
  return {
    autoApproval: {
      enabled: auto.enabled === true,
      prompt: (typeof auto.prompt === "string" ? auto.prompt.normalize("NFKC").trim() : "").slice(0, 4_000),
    },
  };
}

export async function getCapabilityCenterSettings(siteAgentId: string) {
  const database = await databaseReady();
  if (!database) return { settings: memoryFor(siteAgentId).settings, persistence: "memory" as const };
  const rows = await all<{ capability_center_json: string }>(database,
    `SELECT capability_center_json FROM site_agent_v2_agents WHERE id=? LIMIT 1`, [siteAgentId]);
  return {
    settings: normalizeCapabilityCenterSettings(json(rows[0]?.capability_center_json, DEFAULT_CAPABILITY_CENTER_SETTINGS)),
    persistence: "d1" as const,
  };
}

export async function updateCapabilityCenterSettings(siteAgentId: string, input: unknown) {
  const settings = normalizeCapabilityCenterSettings(input);
  const database = await databaseReady();
  if (!database) {
    memoryFor(siteAgentId).settings = settings;
    return { settings, persistence: "memory" as const };
  }
  const result = await run(database, `UPDATE site_agent_v2_agents SET capability_center_json=?,updated_at=? WHERE id=?`,
    [JSON.stringify(settings), new Date().toISOString(), siteAgentId]);
  if (Number(result.meta?.changes || 0) !== 1) throw new Error("site_agent_not_found");
  return { settings, persistence: "d1" as const };
}

async function all<T>(database: D1DatabaseLike, sql: string, values: unknown[] = []) {
  const result = await database.prepare(sql).bind(...values).all<T>();
  if (!result.success) throw new Error(result.error || "capability_center_query_failed");
  return result.results || [];
}

async function run(database: D1DatabaseLike, sql: string, values: unknown[] = []) {
  const result = await database.prepare(sql).bind(...values).run();
  if (!result.success) throw new Error(result.error || "capability_center_write_failed");
  return result;
}

function json<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function defaultSchema(): JsonSchema {
  return { type: "object", properties: {} };
}

function defaultExecutionRequirements(): Capability["executionRequirements"] {
  return {
    authentication: "unknown",
    supportedEnvironments: {
      connectedBrowser: "unverified",
      cloudBrowser: "unverified",
      managedProfile: "blocked",
    },
    checkpoints: [],
    evidenceRefs: [],
  };
}

function defaultAcceptanceSpec(input: Pick<Capability, "operation" | "resultKind" | "outputSchema" | "executionRequirements">): CapabilityAcceptanceSpec {
  const requiredOutputs = Array.isArray(input.outputSchema.required)
    ? input.outputSchema.required.filter((field): field is string => typeof field === "string")
    : [];
  const criteria: CapabilityAcceptanceSpec["criteria"] = requiredOutputs.map((field) => ({
    id: `output:${field}`,
    label: `输出字段 ${field}`,
    kind: "output",
    operator: "exists",
    field,
    required: true,
  }));
  if (!criteria.length && input.resultKind === "page") {
    criteria.push({
      id: "page:end-url",
      label: "最终页面地址",
      kind: "url",
      operator: "exists",
      field: "endUrl",
      required: true,
    });
  }
  const requiredCheckpoints = [...new Set(input.executionRequirements.checkpoints || [])];
  if (input.operation === "write" && !requiredCheckpoints.includes("confirmation")) {
    requiredCheckpoints.push("confirmation");
  }
  return {
    version: 1,
    criteria,
    requiredEvidence: ["before-screenshot", "after-screenshot", "validation-video"],
    sideEffectPolicy: {
      mode: input.operation === "read" ? "read-only" : "irreversible",
      requiredCheckpoints,
      requireIdempotencyKey: input.operation === "write",
    },
  };
}

function normalizeAcceptanceSpec(
  value: CapabilityAcceptanceSpec | undefined,
  fallback: Pick<Capability, "operation" | "resultKind" | "outputSchema" | "executionRequirements">,
): CapabilityAcceptanceSpec {
  if (!value || value.version !== 1 || !Array.isArray(value.criteria)) return defaultAcceptanceSpec(fallback);
  const allowedKinds = new Set(["url", "text", "output", "checkpoint", "side-effect"]);
  const allowedOperators = new Set(["equals", "contains", "exists", "changed", "unchanged", "recorded"]);
  const criteria = value.criteria.flatMap((criterion, index) => {
    if (!criterion || !allowedKinds.has(criterion.kind) || !allowedOperators.has(criterion.operator)) return [];
    return [{
      id: String(criterion.id || `criterion:${index + 1}`).slice(0, 120),
      label: String(criterion.label || criterion.id || `验收条件 ${index + 1}`).slice(0, 240),
      kind: criterion.kind,
      operator: criterion.operator,
      ...(criterion.expected !== undefined ? { expected: criterion.expected } : {}),
      ...(criterion.field ? { field: String(criterion.field).slice(0, 120) } : {}),
      required: criterion.required !== false,
    }];
  }).slice(0, 40) as CapabilityAcceptanceSpec["criteria"];
  const requiredEvidence = [...new Set((value.requiredEvidence || []).filter((role) =>
    role === "before-screenshot" || role === "after-screenshot" || role === "validation-video"))];
  const requiredCheckpoints = [...new Set((value.sideEffectPolicy?.requiredCheckpoints || []).filter((checkpoint) =>
    checkpoint === "login" || checkpoint === "captcha" || checkpoint === "payment" || checkpoint === "confirmation"))];
  if (fallback.operation === "write" && !requiredCheckpoints.includes("confirmation")) {
    requiredCheckpoints.push("confirmation");
  }
  return {
    version: 1,
    criteria: criteria.length ? criteria : defaultAcceptanceSpec(fallback).criteria,
    requiredEvidence: requiredEvidence.length ? requiredEvidence : ["before-screenshot", "after-screenshot", "validation-video"],
    sideEffectPolicy: {
      mode: fallback.operation === "write"
        ? value.sideEffectPolicy?.mode === "reversible" ? "reversible" : "irreversible"
        : "read-only",
      requiredCheckpoints,
      requireIdempotencyKey: fallback.operation === "write",
    },
  };
}

function acceptanceSpecForDraft(input: {
  operation?: Capability["operation"];
  kind?: Capability["kind"];
  resultKind?: Capability["resultKind"];
  outputSchema: JsonSchema;
  executionRequirements?: Capability["executionRequirements"];
  acceptanceSpec?: CapabilityAcceptanceSpec;
}) {
  const executionRequirements = input.executionRequirements || defaultExecutionRequirements();
  return normalizeAcceptanceSpec(input.acceptanceSpec, {
    operation: input.operation || (input.kind === "navigation" ? "read" : "write"),
    resultKind: input.resultKind || "page",
    outputSchema: input.outputSchema,
    executionRequirements,
  });
}

function containsChinese(value: string | undefined) {
  return Boolean(value && /\p{Script=Han}/u.test(value));
}

function fallbackChineseName(input: { name: string; description: string; goalTemplate: string }) {
  const source = [input.name, input.goalTemplate, input.description].find(containsChinese) || "未命名能力";
  return source
    .split(/[，。；;！!？?]/u)[0]
    .replace(/^从当前页面/u, "")
    .replace(/^跳转到/u, "前往")
    .replace(/^让用户/u, "")
    .trim()
    .slice(0, 120) || "未命名能力";
}

function fallbackEnglishName(value: string) {
  const normalized = value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .slice(0, 120);
  return !containsChinese(normalized) && /[A-Za-z]/.test(normalized) ? normalized : "Unnamed Capability";
}

function localizedNamesFor(input: Pick<Capability, "name" | "description" | "goalTemplate"> & { localizedNames?: Capability["localizedNames"]; intentKey?: string }) {
  const explicitChinese = input.localizedNames?.zhCN?.trim();
  const explicitEnglish = input.localizedNames?.en?.trim();
  const validExplicitEnglish = explicitEnglish && !containsChinese(explicitEnglish) && /[A-Za-z]/.test(explicitEnglish)
    ? explicitEnglish
    : undefined;
  return {
    zhCN: explicitChinese && containsChinese(explicitChinese) ? explicitChinese.slice(0, 120) : fallbackChineseName(input),
    en: validExplicitEnglish
      ? (/[_-]|[a-z0-9][A-Z]/.test(validExplicitEnglish) ? fallbackEnglishName(validExplicitEnglish) : validExplicitEnglish.slice(0, 120))
      : fallbackEnglishName(!containsChinese(input.name) ? input.name : input.intentKey || input.name),
  };
}

function capabilityFromRow(row: CapabilityRow): Capability {
  const metadata = json<Partial<Capability>>(row.capability_json, {});
  const contract = json<Pick<Capability, "inputSchema" | "outputSchema"> & { acceptanceSpec?: CapabilityAcceptanceSpec }>(row.contract_json, {
    inputSchema: defaultSchema(),
    outputSchema: defaultSchema(),
  });
  const executionRequirements = metadata.executionRequirements || defaultExecutionRequirements();
  const operation = metadata.operation || (metadata.kind === "navigation" ? "read" : "write");
  const resultKind = metadata.resultKind || "page";
  return {
    id: row.id,
    siteAgentId: row.site_agent_id,
    stableKey: row.stable_key,
    intentKey: row.intent_key,
    name: row.name,
    localizedNames: localizedNamesFor({
      name: row.name,
      description: row.description,
      goalTemplate: row.goal_template,
      intentKey: row.intent_key,
      localizedNames: metadata.localizedNames,
    }),
    description: row.description,
    goalTemplate: row.goal_template,
    kind: metadata.kind || "task",
    structure: metadata.structure || "atomic",
    operation,
    exposure: metadata.exposure || "public",
    resultKind,
    inputSchema: contract.inputSchema || defaultSchema(),
    outputSchema: contract.outputSchema || defaultSchema(),
    acceptanceSpec: normalizeAcceptanceSpec(contract.acceptanceSpec, {
      operation,
      resultKind,
      outputSchema: contract.outputSchema || defaultSchema(),
      executionRequirements,
    }),
    executionRequirements,
    status: row.status,
    currentVersionId: row.current_version_id || undefined,
    latestVersionId: row.latest_version_id || undefined,
    unpublishedAt: row.unpublished_at || undefined,
    deletedAt: row.deleted_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function versionFromRow(row: VersionRow): CapabilityVersion {
  const metadata = json<Partial<CapabilityVersion>>(row.version_json, {});
  return {
    id: row.id,
    siteAgentId: row.site_agent_id,
    capabilityId: row.capability_id,
    version: Number(row.version),
    status: row.status,
    implementation: json(row.implementation_json, undefined),
    validation: json(row.validation_json, undefined),
    sourceReleaseId: metadata.sourceReleaseId,
    sourceReleaseVersion: metadata.sourceReleaseVersion,
    publishedReleaseId: metadata.publishedReleaseId,
    publishedReleaseVersion: metadata.publishedReleaseVersion,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at || undefined,
  };
}

function proposalFromRow(row: ProposalRow): CapabilityProposal {
  const payload = json<Partial<CapabilityProposal>>(row.proposal_json, {});
  const storedAnalysis = json<Record<string, JsonValue> | undefined>(row.analysis_json, undefined);
  const analysis = storedAnalysis
    ? Object.fromEntries(Object.entries(storedAnalysis).filter(([key]) => key !== "__proposalApplyFence"))
    : undefined;
  return {
    id: row.id,
    siteAgentId: row.site_agent_id,
    kind: row.kind,
    status: row.status,
    title: payload.title || payload.requestedGoal || "未命名提案",
    description: payload.description || "",
    requestedGoal: payload.requestedGoal || "",
    input: payload.input || {},
    capabilityId: row.capability_id || undefined,
    duplicateCapabilityId: row.duplicate_capability_id || undefined,
    sourceEpisodeId: payload.sourceEpisodeId,
    analysis,
    failure: payload.failure,
    archivedAt: row.archived_at || undefined,
    deletedAt: row.deleted_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskFromRow(row: TaskRow): CapabilityTask {
  const payload = json<Partial<CapabilityTask>>(row.task_json, {});
  return {
    id: row.id,
    siteAgentId: row.site_agent_id,
    proposalId: row.proposal_id || undefined,
    capabilityId: row.capability_id || undefined,
    capabilityVersionId: row.capability_version_id || undefined,
    type: row.type,
    status: row.status,
    stage: row.stage,
    attempts: payload.attempts || [],
    result: json(row.result_json, {}),
    evidence: json(row.evidence_json, {}),
    error: json(row.error_json, undefined),
    review: payload.review,
    archivedAt: row.archived_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function capabilityMetadata(capability: Capability) {
  return JSON.stringify(compact({
    kind: capability.kind,
    structure: capability.structure,
    operation: capability.operation,
    exposure: capability.exposure,
    resultKind: capability.resultKind,
    localizedNames: localizedNamesFor(capability),
    executionRequirements: capability.executionRequirements,
  }));
}

function capabilityContract(capability: Pick<Capability, "inputSchema" | "outputSchema" | "acceptanceSpec">) {
  return JSON.stringify({ inputSchema: capability.inputSchema, outputSchema: capability.outputSchema, acceptanceSpec: capability.acceptanceSpec });
}

function versionMetadata(version: CapabilityVersion) {
  return JSON.stringify(compact({
    sourceReleaseId: version.sourceReleaseId,
    sourceReleaseVersion: version.sourceReleaseVersion,
    publishedReleaseId: version.publishedReleaseId,
    publishedReleaseVersion: version.publishedReleaseVersion,
  }));
}

function proposalPayload(proposal: CapabilityProposal) {
  return JSON.stringify(compact({
    title: proposal.title,
    description: proposal.description,
    requestedGoal: proposal.requestedGoal,
    input: proposal.input,
    sourceEpisodeId: proposal.sourceEpisodeId,
    failure: proposal.failure,
  }));
}

function taskPayload(task: CapabilityTask, extra: Record<string, unknown> = {}) {
  return JSON.stringify(compact({ attempts: task.attempts, review: task.review, ...extra }));
}

function stableKeyFor(input: { stableKey?: string; intentKey?: string; goalTemplate?: string; name?: string }) {
  const raw = input.stableKey || input.intentKey || input.goalTemplate || input.name || "capability";
  return raw.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 160) || `capability-${Date.now().toString(36)}`;
}

function mapLegacyCapabilityStatus(status: string): CapabilityStatus {
  if (status === "available") return "active";
  if (status === "degraded") return "degraded";
  if (status === "unpublished" || status === "archived") return "unpublished";
  return "draft";
}

function mapLegacyVersionStatus(status: string): CapabilityVersionStatus {
  if (status === "published") return "published";
  if (status === "awaiting-review") return "awaiting-review";
  if (status === "failed") return "failed";
  if (status === "superseded") return "superseded";
  return "draft";
}

function mapLegacyTaskStatus(status: string): CapabilityTaskStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "awaiting-review") return "awaiting-review";
  if (status === "queued") return "queued";
  return "running";
}

function mapLegacyTaskStage(phase: string, status: CapabilityTaskStatus): CapabilityTaskStage {
  if (status === "completed") return "complete";
  if (status === "awaiting-review") return "review";
  if (phase === "design" || phase === "author") return "author";
  if (phase === "validate") return "validate";
  if (phase === "publish") return "publish";
  return "queued";
}

export type CapabilityCenterMigrationResult = {
  alreadyApplied: boolean;
  capabilities: number;
  versions: number;
  proposals: number;
  tasks: number;
};

export type CapabilityCenterMigrationVerification = {
  passed: boolean;
  marker: { expected: string; actual: string | null };
  counts: {
    capabilities: number;
    versions: number;
    proposals: number;
    tasks: number;
  };
  legacySources: {
    projects: number;
    revisions: number;
    signals: number;
    learningJobs: number;
  };
  catastrophicEmptyBackfill: boolean;
  orphanVersions: number;
  orphanTasks: number;
  orphanProposalCapabilityReferences: number;
  orphanProposalDuplicateReferences: number;
  orphanCurrentVersionPointers: number;
  orphanLatestVersionPointers: number;
  duplicateLiveStableKeys: number;
  errors: string[];
};

/**
 * Phase one creates the new tables in the schema initializer. Phase two copies
 * legacy projections into them without mutating the legacy evidence tables.
 * Every insert is idempotent and a metadata marker makes later requests cheap.
 */
export async function backfillLegacyCapabilityCenter(database: D1DatabaseLike): Promise<CapabilityCenterMigrationResult> {
  await ensureSiteAgentV2Schema(database);
  const marker = await all<{ value: string }>(database, `SELECT value FROM site_agent_v2_meta WHERE key=? LIMIT 1`, [MIGRATION_KEY]);
  if (marker[0]?.value === MIGRATION_VERSION) {
    return { alreadyApplied: true, capabilities: 0, versions: 0, proposals: 0, tasks: 0 };
  }

  let capabilities = 0;
  let versions = 0;
  let proposals = 0;
  let tasks = 0;
  const uncovered = { capabilities: 0, duplicateProposals: 0, versions: 0, referencedJobs: 0, tasks: 0, signals: 0 };
  const projectCapabilityIds = new Map<string, string>();
  const duplicateProjectIds = new Set<string>();
  const legacyProjects = await all<{ id: string; site_agent_id: string; status: string; project_json: string; created_at: string; updated_at: string }>(
    database,
    `SELECT id,site_agent_id,status,project_json,created_at,updated_at FROM site_agent_v2_capability_projects ORDER BY created_at`,
  );

  for (const row of legacyProjects) {
    const project = json<Record<string, unknown>>(row.project_json, {});
    const duplicateOf = project.duplicateOf as { capabilityId?: string; projectId?: string; name?: string } | undefined;
    if (row.status === "duplicate" || duplicateOf) {
      duplicateProjectIds.add(row.id);
      const proposal: CapabilityProposal = {
        id: `migration:duplicate:${row.id}`,
        siteAgentId: row.site_agent_id,
        kind: "new",
        status: "duplicate",
        title: String(project.name || project.requestedGoal || "重复能力提案"),
        description: String(project.description || ""),
        requestedGoal: String(project.requestedGoal || project.goalTemplate || ""),
        input: {},
        duplicateCapabilityId: duplicateOf?.capabilityId,
        analysis: { legacyProjectId: row.id, duplicateOf: (duplicateOf || {}) as JsonValue },
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      const result = await run(database, `INSERT OR IGNORE INTO site_agent_v2_capability_proposals
        (id,site_agent_id,capability_id,duplicate_capability_id,kind,status,proposal_json,analysis_json,archived_at,deleted_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [proposal.id, proposal.siteAgentId, null, proposal.duplicateCapabilityId || null, proposal.kind, proposal.status, proposalPayload(proposal), JSON.stringify(proposal.analysis || {}), null, null, proposal.createdAt, proposal.updatedAt]);
      proposals += Number(result.meta?.changes || 0);
      const persisted = await all<{ id: string }>(database,
        `SELECT id FROM site_agent_v2_capability_proposals WHERE id=? AND site_agent_id=? LIMIT 1`,
        [proposal.id, proposal.siteAgentId]);
      if (!persisted[0]) uncovered.duplicateProposals += 1;
      continue;
    }

    const explicitCapabilityId = typeof project.canonicalCapabilityId === "string" && project.canonicalCapabilityId.trim()
      ? project.canonicalCapabilityId
      : typeof project.activeCapabilityId === "string" && project.activeCapabilityId.trim()
        ? project.activeCapabilityId
        : undefined;
    const id = explicitCapabilityId || row.id;
    const stableKey = stableKeyFor({
      stableKey: typeof project.stableKey === "string" ? project.stableKey : undefined,
      intentKey: typeof project.intentKey === "string" ? project.intentKey : undefined,
      goalTemplate: typeof project.goalTemplate === "string" ? project.goalTemplate : undefined,
      name: typeof project.name === "string" ? project.name : undefined,
    });
    const status = mapLegacyCapabilityStatus(row.status);
    const capability: Capability = {
      id,
      siteAgentId: row.site_agent_id,
      stableKey,
      intentKey: String(project.intentKey || stableKey),
      name: String(project.name || project.goalTemplate || id),
      localizedNames: localizedNamesFor({
        name: String(project.name || project.goalTemplate || id),
        description: String(project.description || ""),
        goalTemplate: String(project.goalTemplate || project.requestedGoal || project.name || ""),
        intentKey: String(project.intentKey || stableKey),
      }),
      description: String(project.description || ""),
      goalTemplate: String(project.goalTemplate || project.requestedGoal || project.name || ""),
      kind: project.kind === "navigation" ? "navigation" : "task",
      structure: project.structure === "composite" ? "composite" : "atomic",
      operation: project.operation === "read" || project.kind === "navigation" ? "read" : "write",
      exposure: project.exposure === "internal" ? "internal" : "public",
      resultKind: project.resultKind === "data" || project.resultKind === "action" ? project.resultKind : "page",
      inputSchema: (project.inputSchema || defaultSchema()) as JsonSchema,
      outputSchema: (project.outputSchema || defaultSchema()) as JsonSchema,
      acceptanceSpec: acceptanceSpecForDraft({
        kind: project.kind === "navigation" ? "navigation" : "task",
        operation: project.operation === "read" || project.kind === "navigation" ? "read" : "write",
        resultKind: project.resultKind === "data" || project.resultKind === "action" ? project.resultKind : "page",
        outputSchema: (project.outputSchema || defaultSchema()) as JsonSchema,
        executionRequirements: (project.executionRequirements || defaultExecutionRequirements()) as Capability["executionRequirements"],
        acceptanceSpec: project.acceptanceSpec as CapabilityAcceptanceSpec | undefined,
      }),
      executionRequirements: (project.executionRequirements || defaultExecutionRequirements()) as Capability["executionRequirements"],
      status,
      currentVersionId: typeof project.activeRevisionId === "string" ? project.activeRevisionId : undefined,
      latestVersionId: typeof project.latestRevisionId === "string" ? project.latestRevisionId : undefined,
      unpublishedAt: typeof project.unpublishedAt === "string" ? project.unpublishedAt : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    const result = await run(database, `INSERT OR IGNORE INTO site_agent_v2_capabilities
      (id,site_agent_id,stable_key,intent_key,name,description,goal_template,status,current_version_id,latest_version_id,contract_json,capability_json,unpublished_at,deleted_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [capability.id, capability.siteAgentId, capability.stableKey, capability.intentKey, capability.name, capability.description, capability.goalTemplate, capability.status, capability.currentVersionId || null, capability.latestVersionId || null, capabilityContract(capability), capabilityMetadata(capability), capability.unpublishedAt || null, null, capability.createdAt, capability.updatedAt]);
    capabilities += Number(result.meta?.changes || 0);
    const persisted = explicitCapabilityId
      ? await all<{ id: string }>(database, `SELECT id FROM site_agent_v2_capabilities WHERE id=? AND site_agent_id=? AND deleted_at IS NULL LIMIT 1`, [explicitCapabilityId, row.site_agent_id])
      : await all<{ id: string }>(database, `SELECT id FROM site_agent_v2_capabilities WHERE site_agent_id=? AND stable_key=? AND deleted_at IS NULL LIMIT 1`, [row.site_agent_id, stableKey]);
    if (persisted[0]) projectCapabilityIds.set(row.id, persisted[0].id);
    else uncovered.capabilities += 1;
  }

  const legacyRevisions = await all<{ id: string; project_id: string; site_agent_id: string; revision_number: number | string; status: string; revision_json: string; created_at: string; updated_at: string }>(
    database,
    `SELECT id,project_id,site_agent_id,revision_number,status,revision_json,created_at,updated_at FROM site_agent_v2_capability_revisions ORDER BY created_at,id`,
  );
  const revisionJobs: Array<{ learningJobId: string; siteAgentId: string; capabilityId: string; versionId: string; number: number }> = [];
  for (const row of legacyRevisions) {
    const capabilityId = projectCapabilityIds.get(row.project_id);
    if (!capabilityId) {
      if (!duplicateProjectIds.has(row.project_id)) uncovered.versions += 1;
      continue;
    }
    const revision = json<Record<string, unknown>>(row.revision_json, {});
    const validation = revision.validation as CapabilityVersion["validation"] | undefined;
    const existingById = await all<{ id: string; site_agent_id: string; capability_id: string; version: number | string }>(database,
      `SELECT id,site_agent_id,capability_id,version FROM site_agent_v2_capability_versions WHERE id=? LIMIT 1`, [row.id]);
    if (existingById[0]) {
      const existing = existingById[0];
      if (existing.site_agent_id !== row.site_agent_id || existing.capability_id !== capabilityId) {
        uncovered.versions += 1;
        continue;
      }
      if (typeof revision.learningJobId === "string") {
        revisionJobs.push({ learningJobId: revision.learningJobId, siteAgentId: row.site_agent_id, capabilityId, versionId: row.id, number: Number(existing.version) });
      }
      continue;
    }
    const occupiedVersions = new Set((await all<{ version: number | string }>(database,
      `SELECT version FROM site_agent_v2_capability_versions WHERE site_agent_id=? AND capability_id=?`,
      [row.site_agent_id, capabilityId])).map((item) => Number(item.version)));
    let versionNumber = Number(row.revision_number);
    while (occupiedVersions.has(versionNumber)) versionNumber += 1;
    const version: CapabilityVersion = {
      id: row.id,
      siteAgentId: row.site_agent_id,
      capabilityId,
      version: versionNumber,
      status: mapLegacyVersionStatus(row.status),
      implementation: revision.implementation as CapabilityVersion["implementation"],
      validation,
      sourceReleaseId: typeof revision.implementationReleaseId === "string" ? revision.implementationReleaseId : undefined,
      sourceReleaseVersion: typeof revision.implementationReleaseVersion === "number" ? revision.implementationReleaseVersion : undefined,
      publishedReleaseId: typeof revision.publishedReleaseId === "string" ? revision.publishedReleaseId : undefined,
      publishedReleaseVersion: typeof revision.publishedReleaseVersion === "number" ? revision.publishedReleaseVersion : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      publishedAt: row.status === "published" ? row.updated_at : undefined,
    };
    const result = await run(database, `INSERT OR IGNORE INTO site_agent_v2_capability_versions
      (id,site_agent_id,capability_id,version,status,implementation_json,validation_json,version_json,published_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [version.id, version.siteAgentId, version.capabilityId, version.version, version.status, JSON.stringify(version.implementation || {}), JSON.stringify(version.validation || {}), versionMetadata(version), version.publishedAt || null, version.createdAt, version.updatedAt]);
    versions += Number(result.meta?.changes || 0);
    const persisted = await all<{ id: string }>(database,
      `SELECT id FROM site_agent_v2_capability_versions WHERE id=? AND site_agent_id=? AND capability_id=? LIMIT 1`,
      [version.id, version.siteAgentId, version.capabilityId]);
    if (!persisted[0]) uncovered.versions += 1;
    if (typeof revision.learningJobId === "string") {
      revisionJobs.push({ learningJobId: revision.learningJobId, siteAgentId: row.site_agent_id, capabilityId, versionId: row.id, number: version.version });
    }
  }

  const legacySignals = await all<{ id: string; site_agent_id: string; status: string; signal_json: string; created_at: string; updated_at: string }>(
    database,
    `SELECT id,site_agent_id,status,signal_json,created_at,updated_at FROM site_agent_v2_capability_signals ORDER BY created_at`,
  );
  for (const row of legacySignals) {
    const signal = json<Record<string, unknown>>(row.signal_json, {});
    const signalStatus = row.status === "completed" ? "accepted" : row.status === "failed" ? "failed" : "pending";
    const kind = signal.kind === "enhancement" ? "improvement" : signal.kind === "runtime-regression" || signal.kind === "bad-case" ? "repair" : "new";
    const proposal: CapabilityProposal = {
      id: row.id,
      siteAgentId: row.site_agent_id,
      kind,
      status: signalStatus,
      title: String(signal.title || signal.intentBucket || "能力提案"),
      description: String(signal.description || ""),
      requestedGoal: String(signal.goal || signal.intentBucket || ""),
      input: {},
      capabilityId: typeof signal.capabilityId === "string" ? signal.capabilityId : undefined,
      sourceEpisodeId: Array.isArray(signal.episodeIds) && typeof signal.episodeIds[0] === "string" ? signal.episodeIds[0] : undefined,
      analysis: { legacySignal: signal as JsonValue },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    const result = await run(database, `INSERT OR IGNORE INTO site_agent_v2_capability_proposals
      (id,site_agent_id,capability_id,duplicate_capability_id,kind,status,proposal_json,analysis_json,archived_at,deleted_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [proposal.id, proposal.siteAgentId, proposal.capabilityId || null, null, proposal.kind, proposal.status, proposalPayload(proposal), JSON.stringify(proposal.analysis || {}), null, null, proposal.createdAt, proposal.updatedAt]);
    proposals += Number(result.meta?.changes || 0);
    const persisted = await all<{ id: string }>(database,
      `SELECT id FROM site_agent_v2_capability_proposals WHERE id=? AND site_agent_id=? LIMIT 1`,
      [proposal.id, proposal.siteAgentId]);
    if (!persisted[0]) uncovered.signals += 1;
  }

  const legacyJobs = await all<{ id: string; site_agent_id: string; status: string; result_json: string; created_at: string; updated_at: string }>(
    database,
    `SELECT id,site_agent_id,status,result_json,created_at,updated_at FROM site_agent_v2_learning_jobs ORDER BY created_at`,
  );
  const legacyJobsBySiteAndId = new Map(legacyJobs.map((row) => [`${row.site_agent_id}\u0000${row.id}`, row] as const));
  for (const link of revisionJobs) {
    const row = legacyJobsBySiteAndId.get(`${link.siteAgentId}\u0000${link.learningJobId}`);
    if (!row) {
      uncovered.referencedJobs += 1;
      continue;
    }
    const job = json<Record<string, unknown>>(row.result_json, {});
    const status = mapLegacyTaskStatus(row.status);
    const task: CapabilityTask = {
      id: row.id,
      siteAgentId: row.site_agent_id,
      capabilityId: link.capabilityId,
      capabilityVersionId: link.versionId,
      type: link.number > 1 ? "repair" : "generate",
      status,
      stage: mapLegacyTaskStage(String(job.phase || ""), status),
      attempts: Array.from({ length: Number(job.attempts || 0) }, (_, index) => ({ number: index + 1, startedAt: row.created_at, status: index + 1 === Number(job.attempts || 0) && status === "failed" ? "failed" : "passed" })),
      result: (job.result && typeof job.result === "object" ? job.result : {}) as Record<string, JsonValue>,
      evidence: { legacyLearningJobId: row.id },
      error: job.failure as CapabilityTask["error"],
      review: status === "awaiting-review" ? { status: "pending" } : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    const result = await run(database, `INSERT OR IGNORE INTO site_agent_v2_capability_tasks
      (id,site_agent_id,proposal_id,capability_id,capability_version_id,type,status,stage,task_json,result_json,evidence_json,error_json,archived_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [task.id, task.siteAgentId, null, task.capabilityId, task.capabilityVersionId, task.type, task.status, task.stage, taskPayload(task, { migrationSource: "learning-job" }), JSON.stringify(task.result), JSON.stringify(task.evidence), task.error ? JSON.stringify(task.error) : null, null, task.createdAt, task.updatedAt]);
    tasks += Number(result.meta?.changes || 0);
    const persisted = await all<{ id: string }>(database,
      `SELECT id FROM site_agent_v2_capability_tasks WHERE id=? AND site_agent_id=? AND capability_id=? AND capability_version_id=? LIMIT 1`,
      [task.id, task.siteAgentId, task.capabilityId, task.capabilityVersionId]);
    if (!persisted[0]) uncovered.tasks += 1;
  }

  if (Object.values(uncovered).some((count) => count > 0)) {
    throw new Error(`capability_center_backfill_coverage_failed:c${uncovered.capabilities}:d${uncovered.duplicateProposals}:v${uncovered.versions}:j${uncovered.referencedJobs}:t${uncovered.tasks}:s${uncovered.signals}`);
  }

  const missingAcceptance = await all<CapabilityRow>(database,
    `SELECT * FROM site_agent_v2_capabilities WHERE json_extract(contract_json,'$.acceptanceSpec') IS NULL`);
  for (const row of missingAcceptance) {
    const capability = capabilityFromRow(row);
    await run(database, `UPDATE site_agent_v2_capabilities SET contract_json=?,updated_at=? WHERE id=? AND site_agent_id=?`,
      [capabilityContract(capability), new Date().toISOString(), row.id, row.site_agent_id]);
  }
  await run(database, `INSERT OR REPLACE INTO site_agent_v2_meta (key,value,updated_at) VALUES (?,?,?)`, [MIGRATION_KEY, MIGRATION_VERSION, new Date().toISOString()]);
  return { alreadyApplied: false, capabilities, versions, proposals, tasks };
}

/**
 * Production cutover gate for the four-table Capability Center model. This is
 * intentionally separate from backfill so a previously written marker can
 * never hide later referential corruption from a deployment.
 */
export async function verifyCapabilityCenterMigration(database: D1DatabaseLike): Promise<CapabilityCenterMigrationVerification> {
  const [markerRows, capabilityRows, versionRows, proposalRows, taskRows, legacyProjectRows, legacyRevisionRows, legacySignalRows, legacyLearningJobRows, orphanVersionRows, orphanTaskRows, orphanProposalCapabilityRows, orphanProposalDuplicateRows, orphanCurrentRows, orphanLatestRows, duplicateRows] = await Promise.all([
    all<{ value: string }>(database, `SELECT value FROM site_agent_v2_meta WHERE key=? LIMIT 1`, [MIGRATION_KEY]),
    all<{ count: number | string }>(database, `SELECT COUNT(*) AS count FROM site_agent_v2_capabilities`),
    all<{ count: number | string }>(database, `SELECT COUNT(*) AS count FROM site_agent_v2_capability_versions`),
    all<{ count: number | string }>(database, `SELECT COUNT(*) AS count FROM site_agent_v2_capability_proposals`),
    all<{ count: number | string }>(database, `SELECT COUNT(*) AS count FROM site_agent_v2_capability_tasks`),
    all<{ count: number | string }>(database, `SELECT COUNT(*) AS count FROM site_agent_v2_capability_projects`),
    all<{ count: number | string }>(database, `SELECT COUNT(*) AS count FROM site_agent_v2_capability_revisions`),
    all<{ count: number | string }>(database, `SELECT COUNT(*) AS count FROM site_agent_v2_capability_signals`),
    all<{ count: number | string }>(database, `SELECT COUNT(*) AS count FROM site_agent_v2_learning_jobs`),
    all<{ count: number | string }>(database, `SELECT COUNT(*) AS count
      FROM site_agent_v2_capability_versions v
      LEFT JOIN site_agent_v2_capabilities c
        ON c.id=v.capability_id AND c.site_agent_id=v.site_agent_id
      WHERE c.id IS NULL`),
    all<{ count: number | string }>(database, `SELECT COUNT(*) AS count
      FROM site_agent_v2_capability_tasks t
      LEFT JOIN site_agent_v2_capabilities c
        ON c.id=t.capability_id AND c.site_agent_id=t.site_agent_id
      LEFT JOIN site_agent_v2_capability_versions v
        ON v.id=t.capability_version_id AND v.site_agent_id=t.site_agent_id
      LEFT JOIN site_agent_v2_capability_proposals p
        ON p.id=t.proposal_id AND p.site_agent_id=t.site_agent_id
      WHERE (t.capability_id IS NOT NULL AND c.id IS NULL)
         OR (t.capability_version_id IS NOT NULL AND (t.capability_id IS NULL OR v.id IS NULL OR v.capability_id<>t.capability_id))
         OR (t.proposal_id IS NOT NULL AND p.id IS NULL)`),
    all<{ count: number | string }>(database, `SELECT COUNT(*) AS count
      FROM site_agent_v2_capability_proposals p
      LEFT JOIN site_agent_v2_capabilities c
        ON c.id=p.capability_id AND c.site_agent_id=p.site_agent_id
      WHERE p.capability_id IS NOT NULL AND c.id IS NULL`),
    all<{ count: number | string }>(database, `SELECT COUNT(*) AS count
      FROM site_agent_v2_capability_proposals p
      LEFT JOIN site_agent_v2_capabilities c
        ON c.id=p.duplicate_capability_id AND c.site_agent_id=p.site_agent_id
      WHERE p.duplicate_capability_id IS NOT NULL AND c.id IS NULL`),
    all<{ count: number | string }>(database, `SELECT COUNT(*) AS count
      FROM site_agent_v2_capabilities c
      LEFT JOIN site_agent_v2_capability_versions v
        ON v.id=c.current_version_id AND v.site_agent_id=c.site_agent_id AND v.capability_id=c.id
      WHERE c.current_version_id IS NOT NULL AND v.id IS NULL`),
    all<{ count: number | string }>(database, `SELECT COUNT(*) AS count
      FROM site_agent_v2_capabilities c
      LEFT JOIN site_agent_v2_capability_versions v
        ON v.id=c.latest_version_id AND v.site_agent_id=c.site_agent_id AND v.capability_id=c.id
      WHERE c.latest_version_id IS NOT NULL AND v.id IS NULL`),
    all<{ count: number | string }>(database, `SELECT COUNT(*) AS count FROM (
      SELECT site_agent_id,stable_key
      FROM site_agent_v2_capabilities
      WHERE deleted_at IS NULL AND stable_key IS NOT NULL AND TRIM(stable_key)<>''
      GROUP BY site_agent_id,stable_key
      HAVING COUNT(*)>1
    ) duplicate_live_stable_keys`),
  ]);
  const marker = markerRows[0]?.value || null;
  const counts = {
    capabilities: Number(capabilityRows[0]?.count || 0),
    versions: Number(versionRows[0]?.count || 0),
    proposals: Number(proposalRows[0]?.count || 0),
    tasks: Number(taskRows[0]?.count || 0),
  };
  const legacySources = {
    projects: Number(legacyProjectRows[0]?.count || 0),
    revisions: Number(legacyRevisionRows[0]?.count || 0),
    signals: Number(legacySignalRows[0]?.count || 0),
    learningJobs: Number(legacyLearningJobRows[0]?.count || 0),
  };
  const catastrophicEmptyBackfill = legacySources.projects + legacySources.signals > 0
    && counts.capabilities + counts.proposals === 0;
  const orphanVersions = Number(orphanVersionRows[0]?.count || 0);
  const orphanTasks = Number(orphanTaskRows[0]?.count || 0);
  const orphanProposalCapabilityReferences = Number(orphanProposalCapabilityRows[0]?.count || 0);
  const orphanProposalDuplicateReferences = Number(orphanProposalDuplicateRows[0]?.count || 0);
  const orphanCurrentVersionPointers = Number(orphanCurrentRows[0]?.count || 0);
  const orphanLatestVersionPointers = Number(orphanLatestRows[0]?.count || 0);
  const duplicateLiveStableKeys = Number(duplicateRows[0]?.count || 0);
  const errors = [
    ...(marker === MIGRATION_VERSION ? [] : ["capability_center_migration_marker_invalid"]),
    ...(!catastrophicEmptyBackfill ? [] : ["capability_center_catastrophic_empty_backfill"]),
    ...(orphanVersions === 0 ? [] : ["capability_center_orphan_versions"]),
    ...(orphanTasks === 0 ? [] : ["capability_center_orphan_tasks"]),
    ...(orphanProposalCapabilityReferences === 0 ? [] : ["capability_center_orphan_proposal_capability_references"]),
    ...(orphanProposalDuplicateReferences === 0 ? [] : ["capability_center_orphan_proposal_duplicate_references"]),
    ...(orphanCurrentVersionPointers === 0 ? [] : ["capability_center_orphan_current_version_pointers"]),
    ...(orphanLatestVersionPointers === 0 ? [] : ["capability_center_orphan_latest_version_pointers"]),
    ...(duplicateLiveStableKeys === 0 ? [] : ["capability_center_duplicate_live_stable_keys"]),
  ];
  return {
    passed: errors.length === 0,
    marker: { expected: MIGRATION_VERSION, actual: marker },
    counts,
    legacySources,
    catastrophicEmptyBackfill,
    orphanVersions,
    orphanTasks,
    orphanProposalCapabilityReferences,
    orphanProposalDuplicateReferences,
    orphanCurrentVersionPointers,
    orphanLatestVersionPointers,
    duplicateLiveStableKeys,
    errors,
  };
}

async function databaseReady() {
  const database = getD1Binding();
  if (!database) return null;
  await ensureSiteAgentV2Schema(database);
  let pending = backfillByDatabase.get(database as object);
  if (!pending) {
    pending = backfillLegacyCapabilityCenter(database);
    backfillByDatabase.set(database as object, pending);
  }
  try { await pending; }
  catch (error) { backfillByDatabase.delete(database as object); throw error; }
  return database;
}

export async function listCapabilities(siteAgentId: string, options: { status?: CapabilityStatus; includeDeleted?: boolean } = {}) {
  const database = await databaseReady();
  if (!database) {
    const capabilities = memoryFor(siteAgentId).capabilities
      .filter((item) => (options.includeDeleted || item.status !== "deleted") && (!options.status || item.status === options.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { capabilities, total: capabilities.length, persistence: "memory" as const };
  }
  const clauses = ["site_agent_id=?"];
  const values: unknown[] = [siteAgentId];
  if (!options.includeDeleted) clauses.push("deleted_at IS NULL");
  if (options.status) { clauses.push("status=?"); values.push(options.status); }
  const rows = await all<CapabilityRow>(database, `SELECT * FROM site_agent_v2_capabilities WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC`, values);
  return { capabilities: rows.map(capabilityFromRow), total: rows.length, persistence: "d1" as const };
}

export async function getCapability(siteAgentId: string, capabilityId: string, options: { includeDeleted?: boolean } = {}) {
  const database = await databaseReady();
  if (!database) {
    const capability = memoryFor(siteAgentId).capabilities.find((item) => item.id === capabilityId && (options.includeDeleted || item.status !== "deleted"));
    return capability;
  }
  const rows = await all<CapabilityRow>(database, `SELECT * FROM site_agent_v2_capabilities WHERE site_agent_id=? AND id=?${options.includeDeleted ? "" : " AND deleted_at IS NULL"} LIMIT 1`, [siteAgentId, capabilityId]);
  return rows[0] ? capabilityFromRow(rows[0]) : undefined;
}

export async function listCapabilityVersions(siteAgentId: string, capabilityId: string) {
  const database = await databaseReady();
  if (!database) return memoryFor(siteAgentId).versions.filter((item) => item.capabilityId === capabilityId).sort((a, b) => b.version - a.version);
  const rows = await all<VersionRow>(database, `SELECT * FROM site_agent_v2_capability_versions WHERE site_agent_id=? AND capability_id=? ORDER BY version DESC`, [siteAgentId, capabilityId]);
  return rows.map(versionFromRow);
}

export async function getCapabilityDetail(siteAgentId: string, capabilityId: string): Promise<CapabilityDetail | undefined> {
  const capability = await getCapability(siteAgentId, capabilityId, { includeDeleted: true });
  if (!capability) return undefined;
  const [versions, taskResult] = await Promise.all([
    listCapabilityVersions(siteAgentId, capabilityId),
    listCapabilityTasks(siteAgentId, { capabilityId, includeArchived: true }),
  ]);
  const database = await databaseReady();
  let userExecutions: CapabilityExecutionSummary[] = [];
  if (database) {
    const rows = await all<{ episode_json: string }>(database, `SELECT episode_json FROM site_agent_v2_episodes
      WHERE site_agent_id=? AND json_extract(episode_json,'$.capabilityId')=? ORDER BY ended_at DESC LIMIT 20`, [siteAgentId, capabilityId]);
    userExecutions = rows.map((row) => {
      const episode = json<Record<string, unknown>>(row.episode_json, {});
      const outcome = episode.outcome as Record<string, unknown> | undefined;
      return {
        id: String(episode.id || ""),
        status: String(outcome?.status || "unknown"),
        startedAt: String(episode.startedAt || ""),
        endedAt: typeof episode.endedAt === "string" ? episode.endedAt : undefined,
        summary: typeof outcome?.summary === "string" ? outcome.summary : undefined,
      };
    });
  }
  return {
    capability,
    versions,
    tasks: taskResult.tasks,
    userExecutions,
    systemValidations: taskResult.tasks.filter((task) => task.type === "validate"),
  };
}

export async function createCapabilityProposal(siteAgentId: string, input: {
  id?: string;
  kind?: CapabilityProposalKind;
  title: string;
  description?: string;
  requestedGoal: string;
  input?: Record<string, JsonValue>;
  capabilityId?: string;
  sourceEpisodeId?: string;
}) {
  if (!input.requestedGoal?.trim()) throw new Error("capability_proposal_goal_required");
  const now = new Date().toISOString();
  const proposal: CapabilityProposal = {
    id: input.id || uid("proposal"), siteAgentId, kind: input.kind || (input.capabilityId ? "improvement" : "new"),
    status: "pending",
    title: input.title?.trim() || input.requestedGoal.trim(), description: input.description?.trim() || "",
    requestedGoal: input.requestedGoal.trim(), input: input.input || {}, capabilityId: input.capabilityId,
    sourceEpisodeId: input.sourceEpisodeId, createdAt: now, updatedAt: now,
  };
  const database = await databaseReady();
  if (!database) {
    const existing = memoryFor(siteAgentId).proposals.find((item) => item.id === proposal.id);
    if (existing) return { proposal: existing, persistence: "memory" as const };
    memoryFor(siteAgentId).proposals.push(proposal);
    return { proposal, persistence: "memory" as const };
  }
  await run(database, `INSERT OR IGNORE INTO site_agent_v2_capability_proposals
    (id,site_agent_id,capability_id,duplicate_capability_id,kind,status,proposal_json,analysis_json,archived_at,deleted_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [proposal.id, siteAgentId, proposal.capabilityId || null, proposal.duplicateCapabilityId || null, proposal.kind, proposal.status, proposalPayload(proposal), JSON.stringify(proposal.analysis || {}), null, null, now, now]);
  return { proposal: (await getCapabilityProposal(siteAgentId, proposal.id)) || proposal, persistence: "d1" as const };
}

export async function getCapabilityProposal(siteAgentId: string, proposalId: string) {
  const database = await databaseReady();
  if (!database) return memoryFor(siteAgentId).proposals.find((item) => item.id === proposalId && !item.deletedAt);
  const rows = await all<ProposalRow>(database, `SELECT * FROM site_agent_v2_capability_proposals
    WHERE id=? AND site_agent_id=? AND deleted_at IS NULL LIMIT 1`, [proposalId, siteAgentId]);
  return rows[0] ? proposalFromRow(rows[0]) : undefined;
}

export async function coalesceCapabilityProposalsForEpisodes(siteAgentId: string, episodeIds: string[]) {
  const sources = [...new Set(episodeIds.filter(Boolean))];
  if (!sources.length) return {};
  const database = await databaseReady();
  if (!database) {
    const memory = memoryFor(siteAgentId);
    const candidates = memory.proposals
      .filter((proposal) => proposal.sourceEpisodeId && sources.includes(proposal.sourceEpisodeId) && !proposal.archivedAt && !proposal.deletedAt)
      .sort((left, right) => Number(memory.tasks.some((task) => task.proposalId === right.id)) - Number(memory.tasks.some((task) => task.proposalId === left.id))
        || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const canonical = candidates[0];
    if (!canonical) return {};
    const now = new Date().toISOString();
    for (const proposal of candidates.slice(1)) {
      if ((proposal.status !== "pending" && proposal.status !== "analyzing") || memory.tasks.some((task) => task.proposalId === proposal.id)) continue;
      proposal.archivedAt = now;
      proposal.analysis = { ...(proposal.analysis || {}), supersededByProposalId: canonical.id };
      proposal.updatedAt = now;
    }
    return { canonicalProposalId: canonical.id, sourceEpisodeId: canonical.sourceEpisodeId };
  }
  const placeholders = sources.map(() => "?").join(",");
  const rows = await all<ProposalRow & { hasTask: number }>(database,
    `SELECT p.*,EXISTS(SELECT 1 FROM site_agent_v2_capability_tasks t WHERE t.proposal_id=p.id) AS "hasTask"
     FROM site_agent_v2_capability_proposals p
     WHERE p.site_agent_id=? AND p.archived_at IS NULL AND p.deleted_at IS NULL
       AND json_extract(p.proposal_json,'$.sourceEpisodeId') IN (${placeholders})
     ORDER BY "hasTask" DESC,p.created_at,p.id`, [siteAgentId, ...sources]);
  const canonicalRow = rows[0];
  if (!canonicalRow) return {};
  const canonical = proposalFromRow(canonicalRow);
  const now = new Date().toISOString();
  const losers = rows.slice(1).filter((row) => !Number(row.hasTask) && (row.status === "pending" || row.status === "analyzing"));
  if (losers.length) {
    await database.batch(losers.map((row) => {
      const proposal = proposalFromRow(row);
      const analysis = { ...(proposal.analysis || {}), supersededByProposalId: canonical.id };
      return database.prepare(`UPDATE site_agent_v2_capability_proposals
        SET analysis_json=?,archived_at=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND status=? AND updated_at=?
          AND archived_at IS NULL AND deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM site_agent_v2_capability_tasks t WHERE t.proposal_id=site_agent_v2_capability_proposals.id)`)
        .bind(JSON.stringify(analysis), now, now, row.id, siteAgentId, row.status, row.updated_at);
    }));
  }
  return { canonicalProposalId: canonical.id, sourceEpisodeId: canonical.sourceEpisodeId };
}

export async function claimCapabilityProposalAnalysis(siteAgentId: string, proposalId: string, expectedUpdatedAt: string) {
  const now = new Date().toISOString();
  const database = await databaseReady();
  if (!database) {
    const proposal = memoryFor(siteAgentId).proposals.find((item) => item.id === proposalId && !item.deletedAt);
    if (!proposal || (proposal.status !== "pending" && proposal.status !== "analyzing") || proposal.updatedAt !== expectedUpdatedAt) throw new Error("capability_proposal_analysis_conflict");
    proposal.status = "analyzing";
    proposal.updatedAt = now;
    return proposal;
  }
  const result = await run(database, `UPDATE site_agent_v2_capability_proposals
    SET status='analyzing',updated_at=? WHERE id=? AND site_agent_id=? AND status IN ('pending','analyzing')
    AND updated_at=? AND deleted_at IS NULL`, [now, proposalId, siteAgentId, expectedUpdatedAt]);
  if (Number(result.meta?.changes || 0) !== 1) throw new Error("capability_proposal_analysis_conflict");
  return (await getCapabilityProposal(siteAgentId, proposalId))!;
}

export async function resolveCapabilityProposalAnalysis(siteAgentId: string, proposalId: string, input: {
  status: Extract<CapabilityProposalStatus, "duplicate" | "blocked" | "rejected" | "failed">;
  analysis: Record<string, JsonValue>;
  expectedUpdatedAt: string;
  duplicateCapabilityId?: string;
  failure?: CapabilityProposal["failure"];
}) {
  const now = new Date().toISOString();
  const database = await databaseReady();
  if (!database) {
    const proposal = memoryFor(siteAgentId).proposals.find((item) => item.id === proposalId && !item.deletedAt);
    if (!proposal || proposal.status !== "analyzing" || proposal.updatedAt !== input.expectedUpdatedAt) throw new Error("capability_proposal_analysis_conflict");
    proposal.status = input.status;
    proposal.analysis = input.analysis;
    proposal.duplicateCapabilityId = input.duplicateCapabilityId;
    proposal.failure = input.failure;
    proposal.updatedAt = now;
    return proposal;
  }
  const rows = await all<ProposalRow>(database, `SELECT * FROM site_agent_v2_capability_proposals
    WHERE id=? AND site_agent_id=? AND status='analyzing' AND updated_at=? AND deleted_at IS NULL LIMIT 1`, [proposalId, siteAgentId, input.expectedUpdatedAt]);
  if (!rows[0]) throw new Error("capability_proposal_analysis_conflict");
  const proposal = proposalFromRow(rows[0]);
  const updated: CapabilityProposal = {
    ...proposal,
    status: input.status,
    analysis: input.analysis,
    duplicateCapabilityId: input.duplicateCapabilityId,
    failure: input.failure,
    updatedAt: now,
  };
  const result = await run(database, `UPDATE site_agent_v2_capability_proposals
    SET status=?,duplicate_capability_id=?,proposal_json=?,analysis_json=?,updated_at=?
    WHERE id=? AND site_agent_id=? AND status='analyzing' AND updated_at=? AND deleted_at IS NULL`, [
    updated.status,
    updated.duplicateCapabilityId || null,
    proposalPayload(updated),
    JSON.stringify(updated.analysis || {}),
    now,
    proposalId,
    siteAgentId,
    input.expectedUpdatedAt,
  ]);
  if (Number(result.meta?.changes || 0) !== 1) throw new Error("capability_proposal_analysis_conflict");
  return updated;
}

export async function claimBlockedCapabilityProposalOverride(
  siteAgentId: string,
  proposalId: string,
  input: { reason?: string } = {},
) {
  const proposal = await getCapabilityProposal(siteAgentId, proposalId);
  if (!proposal || proposal.status !== "blocked" || proposal.deletedAt) throw new Error("capability_proposal_not_blocked");
  const now = new Date().toISOString();
  const feasibility = proposal.analysis?.feasibility;
  const requiredResources = feasibility && typeof feasibility === "object" && !Array.isArray(feasibility)
    && Array.isArray((feasibility as Record<string, JsonValue>).requiredResources)
    ? ((feasibility as Record<string, JsonValue>).requiredResources as JsonValue[]).map(String).slice(0, 12)
    : [];
  const analysis = {
    ...(proposal.analysis || {}),
    manualOverride: {
      authorizedBy: "administrator",
      reason: input.reason?.trim().slice(0, 1_000) || "管理员确认强制分配 Runner 资源。",
      assignedResources: requiredResources,
      authorizedAt: now,
    },
  } as Record<string, JsonValue>;
  const database = await databaseReady();
  if (!database) {
    const memoryProposal = memoryFor(siteAgentId).proposals.find((item) => item.id === proposalId && item.status === "blocked" && !item.deletedAt);
    if (!memoryProposal) throw new Error("capability_proposal_override_conflict");
    memoryProposal.status = "analyzing";
    memoryProposal.analysis = analysis;
    memoryProposal.updatedAt = now;
    return memoryProposal;
  }
  const result = await run(database, `UPDATE site_agent_v2_capability_proposals
    SET status='analyzing',analysis_json=?,updated_at=?
    WHERE id=? AND site_agent_id=? AND status='blocked' AND updated_at=? AND deleted_at IS NULL`,
  [JSON.stringify(analysis), now, proposalId, siteAgentId, proposal.updatedAt]);
  if (Number(result.meta?.changes || 0) !== 1) throw new Error("capability_proposal_override_conflict");
  return (await getCapabilityProposal(siteAgentId, proposalId))!;
}

export async function listCapabilityProposals(siteAgentId: string, options: { status?: CapabilityProposalStatus; includeArchived?: boolean; includeDeleted?: boolean } = {}) {
  const database = await databaseReady();
  if (!database) {
    const proposals = memoryFor(siteAgentId).proposals.filter((item) => (!options.status || item.status === options.status) && (options.includeArchived || !item.archivedAt) && (options.includeDeleted || !item.deletedAt));
    return { proposals: proposals.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), total: proposals.length, persistence: "memory" as const };
  }
  const clauses = ["site_agent_id=?"];
  const values: unknown[] = [siteAgentId];
  if (options.status) { clauses.push("status=?"); values.push(options.status); }
  if (!options.includeArchived) clauses.push("archived_at IS NULL");
  if (!options.includeDeleted) clauses.push("deleted_at IS NULL");
  const rows = await all<ProposalRow>(database, `SELECT * FROM site_agent_v2_capability_proposals WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC`, values);
  return { proposals: rows.map(proposalFromRow), total: rows.length, persistence: "d1" as const };
}

export async function archiveCapabilityProposal(siteAgentId: string, proposalId: string, options: { deleted?: boolean } = {}) {
  const now = new Date().toISOString();
  const database = await databaseReady();
  if (!database) {
    const proposal = memoryFor(siteAgentId).proposals.find((item) => item.id === proposalId);
    if (!proposal) throw new Error("capability_proposal_not_found");
    if (options.deleted) proposal.deletedAt = now; else proposal.archivedAt = now;
    proposal.updatedAt = now;
    return proposal;
  }
  const column = options.deleted ? "deleted_at" : "archived_at";
  const result = await run(database, `UPDATE site_agent_v2_capability_proposals SET ${column}=?,updated_at=? WHERE id=? AND site_agent_id=? AND ${column} IS NULL`, [now, now, proposalId, siteAgentId]);
  if (Number(result.meta?.changes || 0) !== 1) throw new Error("capability_proposal_not_found");
  const rows = await all<ProposalRow>(database, `SELECT * FROM site_agent_v2_capability_proposals WHERE id=? AND site_agent_id=? LIMIT 1`, [proposalId, siteAgentId]);
  return proposalFromRow(rows[0]!);
}

export async function listCapabilityTasks(siteAgentId: string, options: { status?: CapabilityTaskStatus; type?: CapabilityTaskType; capabilityId?: string; includeArchived?: boolean } = {}) {
  const database = await databaseReady();
  if (!database) {
    const tasks = memoryFor(siteAgentId).tasks.filter((item) => (!options.status || item.status === options.status) && (!options.type || item.type === options.type) && (!options.capabilityId || item.capabilityId === options.capabilityId) && (options.includeArchived || item.status !== "archived"));
    return { tasks: tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), total: tasks.length, persistence: "memory" as const };
  }
  const clauses = ["site_agent_id=?"];
  const values: unknown[] = [siteAgentId];
  if (options.status) { clauses.push("status=?"); values.push(options.status); }
  if (options.type) { clauses.push("type=?"); values.push(options.type); }
  if (options.capabilityId) { clauses.push("capability_id=?"); values.push(options.capabilityId); }
  if (!options.includeArchived) clauses.push("archived_at IS NULL");
  const rows = await all<TaskRow>(database, `SELECT * FROM site_agent_v2_capability_tasks WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC`, values);
  return { tasks: rows.map(taskFromRow), total: rows.length, persistence: "d1" as const };
}

export async function getCapabilityTask(siteAgentId: string, taskId: string) {
  const database = await databaseReady();
  if (!database) return memoryFor(siteAgentId).tasks.find((item) => item.id === taskId);
  const rows = await all<TaskRow>(database, `SELECT * FROM site_agent_v2_capability_tasks WHERE site_agent_id=? AND id=? LIMIT 1`, [siteAgentId, taskId]);
  return rows[0] ? taskFromRow(rows[0]) : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function implementationSuccessRules(version: CapabilityVersion | undefined) {
  const implementation = objectRecord(version?.implementation);
  const proof = objectRecord(implementation.proof);
  const verifier = objectRecord(proof.verifier);
  return Array.isArray(verifier.success)
    ? verifier.success.map(objectRecord).filter((rule) => typeof rule.kind === "string" && typeof rule.value === "string")
    : [];
}

function embeddedRunner(task: CapabilityTask): BrowserRun | undefined {
  const runner = objectRecord(task.evidence.runner);
  if (typeof runner.runId !== "string") return undefined;
  return {
    id: runner.runId,
    learningJobId: task.id,
    siteAgentId: task.siteAgentId,
    candidateId: task.capabilityVersionId || task.capabilityId || task.id,
    runnerId: typeof runner.runnerId === "string" ? runner.runnerId : "capability-task-runner",
    mode: runner.mode === "author" || runner.mode === "execute" || runner.mode === "debug" ? runner.mode : "validate",
    status: runner.status === "passed" || runner.status === "failed" ? runner.status : "running",
    browser: { name: "chromium", version: "unknown", headless: true },
    startedAt: typeof runner.startedAt === "string" ? runner.startedAt : task.updatedAt,
    endedAt: typeof runner.endedAt === "string" ? runner.endedAt : undefined,
    startUrl: typeof runner.startUrl === "string" ? runner.startUrl : "",
    endUrl: typeof runner.endUrl === "string" ? runner.endUrl : undefined,
    steps: Array.isArray(runner.steps) ? runner.steps as BrowserRun["steps"] : [],
    outcome: objectRecord(runner.outcome) as BrowserRun["outcome"],
    artifactIds: Array.isArray(runner.artifactIds)
      ? runner.artifactIds.filter((item): item is string => typeof item === "string")
      : [],
  };
}

function artifactRole(artifact: BrowserArtifact): BrowserArtifact["role"] | undefined {
  if (artifact.role) return artifact.role;
  const match = artifact.label.match(/^\[(before-screenshot|after-screenshot|keyframe|validation-video|trace|diagnostic)\]/);
  return match?.[1] as BrowserArtifact["role"] | undefined;
}

function proofEvidenceRoles(artifacts: BrowserArtifact[], artifactIds: string[]) {
  const owned = new Set(artifactIds);
  const roles: CapabilityVerificationProof["evidenceRoles"] = {};
  for (const artifact of artifacts) {
    if (!owned.has(artifact.id)) continue;
    const role = artifactRole(artifact);
    if (!role || role === "diagnostic") continue;
    const proofRole = role === "before-screenshot" || role === "after-screenshot" || role === "keyframe"
      || role === "validation-video" || role === "trace" ? role : undefined;
    if (!proofRole) continue;
    roles[proofRole] = [...(roles[proofRole] || []), artifact.id];
  }
  return roles;
}

function displayed(value: unknown) {
  return value === undefined ? "未记录实际值" : typeof value === "string" ? value : JSON.stringify(value);
}

function acceptanceStatus(actual: unknown, operator: Capability["acceptanceSpec"]["criteria"][number]["operator"], expected: JsonValue | undefined) {
  const exists = actual !== undefined && actual !== null && actual !== "";
  if (operator === "exists" || operator === "recorded") return exists;
  if (operator === "equals") return exists && JSON.stringify(actual) === JSON.stringify(expected);
  if (operator === "contains") {
    if (typeof actual === "string") return actual.includes(String(expected ?? ""));
    if (Array.isArray(actual)) return actual.some((item) => JSON.stringify(item) === JSON.stringify(expected));
    return false;
  }
  if (operator === "changed") return actual === true || (typeof actual === "string" && actual === "changed");
  if (operator === "unchanged") return actual === false || (typeof actual === "string" && actual === "unchanged");
  return false;
}

function verificationProof(
  task: CapabilityTask,
  capability: Capability | undefined,
  version: CapabilityVersion | undefined,
  run: BrowserRun | undefined,
  source: CapabilityVerificationProof["source"],
  artifacts: BrowserArtifact[] = [],
): CapabilityVerificationProof {
  const expectedRunId = version?.validation?.runId;
  if (version && (version.validation?.status === "pending" || version.validation?.status === "running")) {
    return {
      status: "incomplete",
      summary: version.validation.status === "running" ? "独立验证仍在运行，尚不能证明能力完成。" : "实现已生成，但尚未完成独立验证。",
      goal: capability?.goalTemplate,
      startUrl: version.validation.startUrl,
      checks: [],
      evidenceArtifactIds: [],
      evidenceRoles: {},
      source: "version-only",
    };
  }
  if (!run) {
    return {
      status: expectedRunId ? "incomplete" : "incomplete",
      summary: expectedRunId
        ? "验证记录引用存在，但对应的独立浏览器运行已缺失，暂时不能证明能力完成。"
        : "尚未形成可审计的独立验证证明。",
      runId: expectedRunId,
      goal: capability?.goalTemplate,
      startUrl: version?.validation?.startUrl,
      checks: [],
      evidenceArtifactIds: [],
      evidenceRoles: {},
      source: expectedRunId ? "version-only" : "missing",
    };
  }

  const evidence = objectRecord(run.outcome?.evidence);
  const after = objectRecord(evidence.after);
  const output = objectRecord(evidence.output);
  const assertions = Array.isArray(evidence.assertions) ? evidence.assertions.map(objectRecord) : [];
  const checkpoints = Array.isArray(evidence.checkpoints) ? evidence.checkpoints.map(objectRecord) : [];
  const sideEffects = Array.isArray(evidence.sideEffects) ? evidence.sideEffects.map(objectRecord) : [];
  const artifactIds = run.artifactIds || [];
  const evidenceRoles = proofEvidenceRoles(artifacts, artifactIds);
  const checks: CapabilityVerificationCheck[] = [];
  const terminalStatus = run.status === "passed" ? "passed" : run.status === "failed" ? "failed" : "incomplete";
  checks.push({
    id: "browser-run",
    label: "独立浏览器验证",
    expected: "运行成功结束",
    actual: run.status === "passed" ? "已成功结束" : run.status === "failed" ? `失败：${run.outcome?.summary || "未知原因"}` : "仍在运行",
    status: terminalStatus,
    evidenceArtifactIds: artifactIds,
  });

  for (const requiredRole of capability?.acceptanceSpec.requiredEvidence || []) {
    const ids = evidenceRoles[requiredRole] || [];
    checks.push({
      id: `evidence:${requiredRole}`,
      label: requiredRole === "before-screenshot" ? "执行前截图" : requiredRole === "after-screenshot" ? "执行后截图" : "验证录屏",
      expected: "同一次独立验证运行中已留存",
      actual: ids.length ? `已留存 ${ids.length} 份` : "未留存或旧证据未标明角色",
      status: ids.length ? "passed" : "incomplete",
      evidenceArtifactIds: ids,
    });
  }

  for (const criterion of capability?.acceptanceSpec.criteria || []) {
    let actual: unknown;
    if (criterion.kind === "url") {
      if (criterion.operator === "changed" || criterion.operator === "unchanged") {
        actual = typeof evidence.urlChanged === "boolean" ? evidence.urlChanged : undefined;
      } else actual = run.endUrl || after.url;
    } else if (criterion.kind === "text") {
      actual = typeof after.matchedText === "string"
        ? after.matchedText
        : assertions.find((item) => item.kind === "text" && (!criterion.expected || item.expected === criterion.expected))?.actual;
    } else if (criterion.kind === "output") {
      actual = criterion.field ? output[criterion.field] : output;
    } else if (criterion.kind === "checkpoint") {
      actual = checkpoints.find((item) => item.id === criterion.field || item.kind === criterion.field || item.label === criterion.expected);
    } else if (criterion.kind === "side-effect") {
      actual = sideEffects.find((item) => item.id === criterion.field || item.kind === criterion.field || item.label === criterion.expected);
    }
    let passed = acceptanceStatus(actual, criterion.operator, criterion.expected);
    if (criterion.kind === "url" && criterion.operator === "equals" && typeof actual === "string" && typeof criterion.expected === "string") {
      try {
        const actualUrl = new URL(actual);
        const expectedUrl = new URL(criterion.expected, actualUrl.origin);
        passed = actualUrl.origin === expectedUrl.origin
          && actualUrl.pathname === expectedUrl.pathname
          && actualUrl.search === expectedUrl.search;
      } catch { passed = false; }
    }
    checks.push({
      id: `acceptance:${criterion.id}`,
      label: criterion.label,
      expected: criterion.expected === undefined ? criterion.operator : displayed(criterion.expected),
      actual: displayed(actual),
      status: passed ? "passed" : criterion.required ? (actual === undefined ? "incomplete" : "failed") : "passed",
      evidenceArtifactIds: artifactIds,
    });
  }

  if (capability?.acceptanceSpec.sideEffectPolicy.mode !== "read-only") {
    checks.push({
      id: "side-effects:recorded",
      label: "业务副作用回执",
      expected: `${capability?.acceptanceSpec.sideEffectPolicy.mode || "write"} 操作必须记录业务结果`,
      actual: sideEffects.length ? sideEffects.map((item) => String(item.label || item.kind || item.id || "副作用")).join("、") : "未记录副作用回执",
      status: sideEffects.length ? "passed" : "incomplete",
      evidenceArtifactIds: artifactIds,
    });
    for (const checkpoint of capability?.acceptanceSpec.sideEffectPolicy.requiredCheckpoints || []) {
      const receipt = checkpoints.find((item) => item.kind === checkpoint || item.id === checkpoint);
      checks.push({
        id: `checkpoint:${checkpoint}`,
        label: `人工卡点：${checkpoint}`,
        expected: "执行不可逆操作前已完成并留存回执",
        actual: receipt ? displayed(receipt) : "未记录",
        status: receipt ? "passed" : "incomplete",
        evidenceArtifactIds: artifactIds,
      });
    }
    if (capability?.acceptanceSpec.sideEffectPolicy.requireIdempotencyKey) {
      const idempotencyKey = evidence.idempotencyKey;
      checks.push({
        id: "side-effects:idempotency",
        label: "幂等保护",
        expected: "已记录幂等键或等价的 at-most-once 回执",
        actual: displayed(idempotencyKey),
        status: typeof idempotencyKey === "string" && idempotencyKey ? "passed" : "incomplete",
        evidenceArtifactIds: artifactIds,
      });
    }
  }

  const rules = implementationSuccessRules(version);
  for (const [index, rule] of rules.entries()) {
    const persisted = assertions.find((assertion) => assertion.kind === rule.kind && assertion.expected === rule.value);
    let actual = typeof persisted?.actual === "string" ? persisted.actual : "";
    let status: CapabilityVerificationCheck["status"] = persisted?.passed === true ? "passed" : persisted?.passed === false ? "failed" : "incomplete";
    if (!persisted && rule.kind === "url" && run.endUrl) {
      try {
        const actualUrl = new URL(run.endUrl);
        const expectedUrl = new URL(String(rule.value), actualUrl.origin);
        const matches = actualUrl.origin === expectedUrl.origin && actualUrl.pathname === expectedUrl.pathname && actualUrl.search === expectedUrl.search;
        actual = run.endUrl;
        status = matches ? "passed" : "failed";
      } catch {
        actual = run.endUrl;
        status = "failed";
      }
    }
    if (!actual && rule.kind === "text" && typeof after.matchedText === "string") actual = after.matchedText;
    if (!actual && rule.kind === "text" && run.status === "passed") {
      actual = "旧验证记录未保留命中文本摘录";
      status = "incomplete";
    }
    checks.push({
      id: `verifier-${index + 1}`,
      label: rule.kind === "url" ? "最终页面地址" : rule.kind === "text" ? "目标页面文本" : `完成条件：${String(rule.kind)}`,
      expected: String(rule.value),
      actual: actual || "未记录实际值",
      status,
      evidenceArtifactIds: artifactIds,
    });
  }

  const required = Array.isArray(capability?.outputSchema.required)
    ? capability.outputSchema.required.filter((item): item is string => typeof item === "string")
    : [];
  if (required.length) {
    const missing = required.filter((field) => output[field] === undefined);
    checks.push({
      id: "required-output",
      label: "输出契约必填字段",
      expected: required.join("、"),
      actual: missing.length
        ? run.status === "passed" ? "契约校验已通过；旧验证记录未保留字段值" : `缺少：${missing.join("、")}`
        : required.map((field) => `${field}=${JSON.stringify(output[field])}`).join("；"),
      status: missing.length ? (run.status === "passed" ? "incomplete" : "failed") : "passed",
      evidenceArtifactIds: artifactIds,
    });
  }

  const capabilitySpecificChecks = checks.filter((check) => check.id !== "browser-run" && !check.id.startsWith("evidence:"));
  if (!capabilitySpecificChecks.length) {
    checks.push({
      id: "acceptance-criteria",
      label: "能力专属验收条件",
      expected: "至少一个目标断言或输出契约必填字段",
      actual: "当前版本没有定义可验证的完成条件",
      status: "incomplete",
      evidenceArtifactIds: artifactIds,
    });
  }

  const failed = terminalStatus === "failed" || checks.some((check) => check.status === "failed");
  const hasIncomplete = checks.some((check) => check.status === "incomplete");
  const status: CapabilityVerificationProof["status"] = failed
    ? "failed"
    : !capabilitySpecificChecks.length || hasIncomplete ? "incomplete"
      : run.status === "passed" ? "passed" : "incomplete";
  const incompleteCount = checks.filter((check) => check.status === "incomplete").length;
  return {
    status,
    summary: failed
      ? run.outcome?.summary || "独立验证失败，能力尚未完成。"
      : incompleteCount
        ? `${run.outcome?.summary || "独立验证已通过"}（${incompleteCount} 项旧记录缺少实际值，已明确标注）`
        : run.outcome?.summary || "所有验收条件均已通过。",
    runId: run.id,
    goal: capability?.goalTemplate,
    startUrl: run.startUrl || version?.validation?.startUrl,
    endUrl: run.endUrl || (typeof after.url === "string" ? after.url : undefined),
    checkedAt: run.endedAt || run.outcome?.evaluatedAt,
    checks,
    evidenceArtifactIds: artifactIds,
    evidenceRoles,
    source,
  };
}

export async function getCapabilityTaskDetail(siteAgentId: string, taskId: string): Promise<CapabilityTaskDetail | undefined> {
  const task = await getCapabilityTask(siteAgentId, taskId);
  if (!task) return undefined;
  const database = await databaseReady();
  const capability = task.capabilityId ? await getCapability(siteAgentId, task.capabilityId, { includeDeleted: true }) : undefined;
  const version = task.capabilityId && task.capabilityVersionId
    ? (await listCapabilityVersions(siteAgentId, task.capabilityId)).find((item) => item.id === task.capabilityVersionId)
    : undefined;
  const runnerRun = embeddedRunner(task);
  if (!database) return {
    task,
    artifacts: [],
    capability,
    version,
    verification: verificationProof(task, capability, version, runnerRun, runnerRun ? "task-runner" : "missing", []),
  };
  const runner = task.evidence.runner && typeof task.evidence.runner === "object" && !Array.isArray(task.evidence.runner)
    ? task.evidence.runner as Record<string, JsonValue>
    : {};
  const learningJobIds = [...new Set([
    task.id,
    typeof task.evidence.legacyLearningJobId === "string" ? task.evidence.legacyLearningJobId : "",
  ].filter(Boolean))].slice(0, 8);
  const artifactIds = Array.isArray(runner.artifactIds)
    ? runner.artifactIds.filter((item): item is string => typeof item === "string").slice(0, 60)
    : [];
  const clauses = [`learning_job_id IN (${learningJobIds.map(() => "?").join(",")})`];
  const values: unknown[] = [siteAgentId, ...learningJobIds];
  if (artifactIds.length) {
    clauses.push(`id IN (${artifactIds.map(() => "?").join(",")})`);
    values.push(...artifactIds);
  }
  const rows = await all<{ artifact_json: string }>(database, `SELECT artifact_json FROM site_agent_v2_artifacts
    WHERE site_agent_id=? AND (${clauses.join(" OR ")}) ORDER BY created_at ASC LIMIT 60`, values);
  let artifacts = rows.flatMap((row) => {
    try { return [JSON.parse(row.artifact_json) as BrowserArtifact]; } catch { return []; }
  });
  let authoritativeRun = runnerRun;
  let source: CapabilityVerificationProof["source"] = runnerRun ? "task-runner" : "missing";
  const validationRunId = version?.validation?.runId;
  if (validationRunId) {
    const runRows = await all<{ run_json: string }>(database,
      `SELECT run_json FROM site_agent_v2_browser_runs WHERE id=? AND site_agent_id=? LIMIT 1`,
      [validationRunId, siteAgentId]);
    if (runRows[0]) {
      authoritativeRun = json<BrowserRun | undefined>(runRows[0].run_json, undefined);
      source = "legacy-browser-run";
    } else if (runnerRun?.id === validationRunId) {
      authoritativeRun = runnerRun;
      source = "task-runner";
    } else {
      authoritativeRun = undefined;
      source = "version-only";
    }
  }
  const ownedLearningJobIds = new Set([
    task.id,
    typeof task.evidence.legacyLearningJobId === "string" ? task.evidence.legacyLearningJobId : "",
  ].filter(Boolean));
  if (authoritativeRun && (
    authoritativeRun.id !== validationRunId
    || authoritativeRun.siteAgentId !== siteAgentId
    || authoritativeRun.mode !== "validate"
    || !ownedLearningJobIds.has(authoritativeRun.learningJobId)
  )) {
    authoritativeRun = undefined;
    source = validationRunId ? "version-only" : "missing";
  }
  const authoritativeArtifactIds = authoritativeRun?.artifactIds || [];
  const missingAuthoritativeIds = authoritativeArtifactIds.filter((id) => !artifacts.some((artifact) => artifact.id === id));
  if (missingAuthoritativeIds.length) {
    const primaryRows = await all<{ artifact_json: string }>(database,
      `SELECT artifact_json FROM site_agent_v2_artifacts WHERE site_agent_id=?
        AND id IN (${missingAuthoritativeIds.map(() => "?").join(",")}) ORDER BY created_at ASC`,
      [siteAgentId, ...missingAuthoritativeIds]);
    const primaryArtifacts = primaryRows.flatMap((row) => {
      try { return [JSON.parse(row.artifact_json) as BrowserArtifact]; } catch { return []; }
    });
    artifacts = [...primaryArtifacts, ...artifacts];
  }
  return {
    task,
    artifacts,
    capability,
    version,
    verification: verificationProof(task, capability, version, authoritativeRun, source, artifacts),
  };
}

export type CreateCapabilityTaskInput = {
  taskId?: string;
  type: CapabilityTaskType;
  proposalId?: string;
  proposalFence?: string;
  capabilityId?: string;
  capabilityVersionId?: string;
  capability?: Partial<Omit<Capability, "id" | "siteAgentId" | "status" | "createdAt" | "updatedAt">> & Pick<Capability, "name" | "description" | "goalTemplate" | "inputSchema" | "outputSchema">;
  implementation?: CapabilityVersion["implementation"];
  validation?: CapabilityVersion["validation"];
  validationInput?: Record<string, JsonValue>;
  result?: Record<string, JsonValue>;
  evidence?: Record<string, JsonValue>;
  proposalAnalysis?: Record<string, JsonValue>;
};

export async function createCapabilityTask(siteAgentId: string, input: CreateCapabilityTaskInput) {
  if (!new Set<CapabilityTaskType>(["generate", "repair", "validate"]).has(input.type)) throw new Error("capability_task_type_invalid");
  if (input.proposalFence && !input.proposalId) throw new Error("capability_proposal_fence_requires_proposal");
  const now = new Date().toISOString();
  const database = await databaseReady();
  const memory = !database ? memoryFor(siteAgentId) : undefined;
  if (input.taskId) {
    const existing = database
      ? (await all<TaskRow>(database, `SELECT * FROM site_agent_v2_capability_tasks WHERE site_agent_id=? AND id=? LIMIT 1`, [siteAgentId, input.taskId]))[0]
      : undefined;
    const task = existing ? taskFromRow(existing) : memory?.tasks.find((item) => item.id === input.taskId);
    if (task) {
      const capability = task.capabilityId ? await getCapability(siteAgentId, task.capabilityId, { includeDeleted: true }) : undefined;
      const versions = capability ? await listCapabilityVersions(siteAgentId, capability.id) : [];
      const version = versions.find((item) => item.id === task.capabilityVersionId);
      return { task, capability, version, persistence: database ? "d1" as const : "memory" as const };
    }
  }
  let capability: Capability | undefined;
  let version: CapabilityVersion | undefined;

  if (input.type === "generate") {
    // Proposal acceptance starts production before AI has designed a stable
    // contract. The Task is therefore allowed to exist unbound; authoring later
    // materializes Capability + Version atomically through the function below.
    if (!input.capability) {
      const task: CapabilityTask = {
        id: input.taskId || uid("capability-task"), siteAgentId, proposalId: input.proposalId,
        type: "generate", status: "queued", stage: "author", attempts: [],
        result: input.result || (input.validationInput ? { validationInput: input.validationInput } : {}), evidence: input.evidence || {}, createdAt: now, updatedAt: now,
      };
      if (!database) {
        const winner = input.taskId ? memory!.tasks.find((item) => item.id === input.taskId) : undefined;
        if (winner) return { task: winner, persistence: "memory" as const };
        memory!.tasks.push(task);
        const proposal = input.proposalId ? memory!.proposals.find((item) => item.id === input.proposalId) : undefined;
        if (proposal) { proposal.status = "accepted"; proposal.updatedAt = now; }
        return { task, persistence: "memory" as const };
      }
      const statements = [database.prepare(`INSERT INTO site_agent_v2_capability_tasks
        (id,site_agent_id,proposal_id,capability_id,capability_version_id,type,status,stage,task_json,result_json,evidence_json,error_json,archived_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(task.id, siteAgentId, task.proposalId || null, null, null, task.type, task.status, task.stage, taskPayload(task), JSON.stringify(task.result), JSON.stringify(task.evidence), null, null, now, now)];
      if (task.proposalId) statements.push(database.prepare(`UPDATE site_agent_v2_capability_proposals SET status='accepted',updated_at=? WHERE id=? AND site_agent_id=? AND deleted_at IS NULL`).bind(now, task.proposalId, siteAgentId));
      let results;
      try {
        results = await database.batch(statements);
      } catch (error) {
        if (input.taskId) {
          const existingTask = await getCapabilityTask(siteAgentId, input.taskId);
          if (existingTask) return { task: existingTask, persistence: "d1" as const };
        }
        throw error;
      }
      const failure = results.find((result) => !result.success);
      if (failure) {
        if (input.taskId) {
          const existingTask = await getCapabilityTask(siteAgentId, input.taskId);
          if (existingTask) return { task: existingTask, persistence: "d1" as const };
        }
        throw new Error(failure.error || "capability_task_create_failed");
      }
      return { task, persistence: "d1" as const };
    }
    const stableKey = stableKeyFor(input.capability);
    if (database) {
      const existing = await all<CapabilityRow>(database, `SELECT * FROM site_agent_v2_capabilities WHERE site_agent_id=? AND stable_key=? AND deleted_at IS NULL LIMIT 1`, [siteAgentId, stableKey]);
      if (existing[0]) throw new Error("capability_task_duplicate");
    } else if (memory!.capabilities.some((item) => item.stableKey === stableKey && item.status !== "deleted")) {
      throw new Error("capability_task_duplicate");
    }
    capability = {
      id: input.capabilityId || uid("capability"), siteAgentId, stableKey,
      intentKey: input.capability.intentKey || stableKey, name: input.capability.name.trim(), description: input.capability.description.trim(),
      localizedNames: localizedNamesFor({ ...input.capability, intentKey: input.capability.intentKey || stableKey }),
      goalTemplate: input.capability.goalTemplate.trim(), kind: input.capability.kind || "task", structure: input.capability.structure || "atomic",
      operation: input.capability.operation || (input.capability.kind === "navigation" ? "read" : "write"), exposure: input.capability.exposure || "public",
      resultKind: input.capability.resultKind || "page", inputSchema: input.capability.inputSchema, outputSchema: input.capability.outputSchema,
      acceptanceSpec: acceptanceSpecForDraft(input.capability),
      executionRequirements: input.capability.executionRequirements || defaultExecutionRequirements(), status: "draft", createdAt: now, updatedAt: now,
    };
    version = {
      id: input.capabilityVersionId || uid("capability-version"), siteAgentId, capabilityId: capability.id, version: 1, status: "draft",
      implementation: input.implementation, validation: input.validation || { status: "pending" }, createdAt: now, updatedAt: now,
    };
    capability.latestVersionId = version.id;
  } else {
    if (!input.capabilityId) throw new Error("capability_task_capability_required");
    capability = await getCapability(siteAgentId, input.capabilityId, { includeDeleted: true });
    if (!capability) throw new Error("capability_not_found");
    if (capability.status === "deleted") throw new Error("capability_deleted");
    const versions = await listCapabilityVersions(siteAgentId, capability.id);
    if (input.type === "validate") {
      version = versions.find((item) => item.id === input.capabilityVersionId) || versions.find((item) => item.id === capability!.currentVersionId) || versions[0];
      if (!version) throw new Error("capability_version_not_found");
    } else {
      version = {
        id: input.capabilityVersionId || uid("capability-version"), siteAgentId, capabilityId: capability.id,
        version: Math.max(0, ...versions.map((item) => item.version)) + 1, status: "draft", implementation: input.implementation,
        validation: input.validation || { status: "pending" }, createdAt: now, updatedAt: now,
      };
      capability.latestVersionId = version.id;
      capability.updatedAt = now;
    }
  }

  const task: CapabilityTask = {
    id: input.taskId || uid("capability-task"), siteAgentId, proposalId: input.proposalId, capabilityId: capability.id,
    capabilityVersionId: version.id, type: input.type, status: "queued", stage: input.type === "validate" ? "validate" : "author", attempts: [],
    result: input.result || (input.validationInput ? { validationInput: input.validationInput } : {}), evidence: input.evidence || {}, createdAt: now, updatedAt: now,
  };
  if (!database) {
    const winner = input.taskId ? memory!.tasks.find((item) => item.id === input.taskId) : undefined;
    if (winner) {
      const winnerCapability = winner.capabilityId
        ? memory!.capabilities.find((item) => item.id === winner.capabilityId)
        : undefined;
      const winnerVersion = winner.capabilityVersionId
        ? memory!.versions.find((item) => item.id === winner.capabilityVersionId)
        : undefined;
      return { task: winner, capability: winnerCapability, version: winnerVersion, persistence: "memory" as const };
    }
    const proposal = task.proposalId
      ? memory!.proposals.find((item) => item.id === task.proposalId
        && item.status === "analyzing"
        && (!input.proposalFence || item.updatedAt === input.proposalFence)
        && !item.deletedAt)
      : undefined;
    if (task.proposalId && !proposal) throw new Error("capability_proposal_analysis_conflict");
    if (input.type === "generate") memory!.capabilities.push(capability);
    else {
      const index = memory!.capabilities.findIndex((item) => item.id === capability!.id);
      memory!.capabilities[index] = capability;
    }
    if (input.type !== "validate") memory!.versions.push(version);
    memory!.tasks.push(task);
    if (proposal) {
      proposal.capabilityId = capability.id;
      proposal.status = "accepted";
      proposal.analysis = input.proposalAnalysis;
      proposal.updatedAt = now;
    }
    return { task, capability, version, persistence: "memory" as const };
  }

  const statements = [];
  const fencedProposal = Boolean(task.proposalId && input.proposalFence);
  const applyToken = fencedProposal ? uid("proposal-apply") : undefined;
  const acceptedAnalysis = fencedProposal
    ? JSON.stringify({ ...(input.proposalAnalysis || {}), __proposalApplyFence: applyToken })
    : JSON.stringify(input.proposalAnalysis || {});
  const fenceExists = `EXISTS (SELECT 1 FROM site_agent_v2_capability_proposals
    WHERE id=? AND site_agent_id=? AND status='accepted'
    AND json_extract(analysis_json,'$.__proposalApplyFence')=?)`;
  const fenceBindings = () => [task.proposalId!, siteAgentId, applyToken!];
  if (fencedProposal) statements.push(database.prepare(`UPDATE site_agent_v2_capability_proposals
    SET capability_id=?,status='accepted',analysis_json=?,updated_at=?
    WHERE id=? AND site_agent_id=? AND status='analyzing' AND updated_at=? AND deleted_at IS NULL`)
    .bind(capability.id, acceptedAnalysis, now, task.proposalId!, siteAgentId, input.proposalFence!));
  if (input.type === "generate") {
    const sql = fencedProposal
      ? `INSERT INTO site_agent_v2_capabilities
        (id,site_agent_id,stable_key,intent_key,name,description,goal_template,status,current_version_id,latest_version_id,contract_json,capability_json,unpublished_at,deleted_at,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${fenceExists}`
      : `INSERT INTO site_agent_v2_capabilities
        (id,site_agent_id,stable_key,intent_key,name,description,goal_template,status,current_version_id,latest_version_id,contract_json,capability_json,unpublished_at,deleted_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    statements.push(database.prepare(sql).bind(capability.id, siteAgentId, capability.stableKey, capability.intentKey, capability.name, capability.description, capability.goalTemplate, capability.status, null, capability.latestVersionId || null, capabilityContract(capability), capabilityMetadata(capability), null, null, now, now, ...(fencedProposal ? fenceBindings() : [])));
  } else if (input.type === "repair") {
    statements.push(database.prepare(`UPDATE site_agent_v2_capabilities SET latest_version_id=?,updated_at=?
      WHERE id=? AND site_agent_id=? AND deleted_at IS NULL${fencedProposal ? ` AND ${fenceExists}` : ""}`)
      .bind(version.id, now, capability.id, siteAgentId, ...(fencedProposal ? fenceBindings() : [])));
  }
  if (input.type !== "validate") {
    const sql = fencedProposal
      ? `INSERT INTO site_agent_v2_capability_versions
        (id,site_agent_id,capability_id,version,status,implementation_json,validation_json,version_json,published_at,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${fenceExists}`
      : `INSERT INTO site_agent_v2_capability_versions
        (id,site_agent_id,capability_id,version,status,implementation_json,validation_json,version_json,published_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`;
    statements.push(database.prepare(sql).bind(version.id, siteAgentId, capability.id, version.version, version.status, JSON.stringify(version.implementation || {}), JSON.stringify(version.validation || {}), versionMetadata(version), null, now, now, ...(fencedProposal ? fenceBindings() : [])));
  }
  {
    const sql = fencedProposal
      ? `INSERT INTO site_agent_v2_capability_tasks
        (id,site_agent_id,proposal_id,capability_id,capability_version_id,type,status,stage,task_json,result_json,evidence_json,error_json,archived_at,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${fenceExists}`
      : `INSERT INTO site_agent_v2_capability_tasks
        (id,site_agent_id,proposal_id,capability_id,capability_version_id,type,status,stage,task_json,result_json,evidence_json,error_json,archived_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    statements.push(database.prepare(sql).bind(task.id, siteAgentId, task.proposalId || null, task.capabilityId, task.capabilityVersionId, task.type, task.status, task.stage, taskPayload(task), JSON.stringify(task.result), JSON.stringify(task.evidence), null, null, now, now, ...(fencedProposal ? fenceBindings() : [])));
  }
  if (task.proposalId && !fencedProposal) statements.push(database.prepare(`UPDATE site_agent_v2_capability_proposals
    SET capability_id=?,status='accepted',analysis_json=?,updated_at=? WHERE id=? AND site_agent_id=?
    AND status='analyzing' AND deleted_at IS NULL`).bind(capability.id, acceptedAnalysis, now, task.proposalId, siteAgentId));
  let results;
  try {
    results = await database.batch(statements);
  } catch (error) {
    if (input.taskId) {
      const existingTask = await getCapabilityTask(siteAgentId, input.taskId);
      if (existingTask) {
        const existingCapability = existingTask.capabilityId
          ? await getCapability(siteAgentId, existingTask.capabilityId, { includeDeleted: true })
          : undefined;
        const existingVersions = existingCapability ? await listCapabilityVersions(siteAgentId, existingCapability.id) : [];
        return {
          task: existingTask,
          capability: existingCapability,
          version: existingVersions.find((item) => item.id === existingTask.capabilityVersionId),
          persistence: "d1" as const,
        };
      }
    }
    throw error;
  }
  const failure = results.find((result) => !result.success);
  if (failure) {
    if (input.taskId) {
      const existingTask = await getCapabilityTask(siteAgentId, input.taskId);
      if (existingTask) {
        const existingCapability = existingTask.capabilityId
          ? await getCapability(siteAgentId, existingTask.capabilityId, { includeDeleted: true })
          : undefined;
        const existingVersions = existingCapability ? await listCapabilityVersions(siteAgentId, existingCapability.id) : [];
        return {
          task: existingTask,
          capability: existingCapability,
          version: existingVersions.find((item) => item.id === existingTask.capabilityVersionId),
          persistence: "d1" as const,
        };
      }
    }
    throw new Error(failure.error || "capability_task_create_failed");
  }
  if (fencedProposal && results.some((result) => Number(result.meta?.changes || 0) !== 1)) throw new Error("capability_proposal_analysis_conflict");
  if (task.proposalId && Number(results.at(-1)?.meta?.changes || 0) !== 1) throw new Error("capability_proposal_analysis_conflict");
  return { task, capability, version, persistence: "d1" as const };
}

export async function materializeCapabilityTaskDraft(siteAgentId: string, taskId: string, input: {
  capabilityId?: string;
  capabilityVersionId?: string;
  capability: NonNullable<CreateCapabilityTaskInput["capability"]>;
  implementation?: CapabilityVersion["implementation"];
  validation?: CapabilityVersion["validation"];
}) {
  const task = await getCapabilityTask(siteAgentId, taskId);
  if (!task) throw new Error("capability_task_not_found");
  if (task.type !== "generate" || task.capabilityId || task.capabilityVersionId) throw new Error("capability_task_already_materialized");
  if (!new Set<CapabilityTaskStatus>(["queued", "running"]).has(task.status)) throw new Error("capability_task_not_materializable");
  const now = new Date().toISOString();
  const stableKey = stableKeyFor(input.capability);
  const capability: Capability = {
    id: input.capabilityId || uid("capability"), siteAgentId, stableKey,
    intentKey: input.capability.intentKey || stableKey, name: input.capability.name.trim(), description: input.capability.description.trim(),
    localizedNames: localizedNamesFor({ ...input.capability, intentKey: input.capability.intentKey || stableKey }),
    goalTemplate: input.capability.goalTemplate.trim(), kind: input.capability.kind || "task", structure: input.capability.structure || "atomic",
    operation: input.capability.operation || (input.capability.kind === "navigation" ? "read" : "write"), exposure: input.capability.exposure || "public",
    resultKind: input.capability.resultKind || "page", inputSchema: input.capability.inputSchema, outputSchema: input.capability.outputSchema,
    acceptanceSpec: acceptanceSpecForDraft(input.capability),
    executionRequirements: input.capability.executionRequirements || defaultExecutionRequirements(), status: "draft", createdAt: now, updatedAt: now,
  };
  const version: CapabilityVersion = {
    id: input.capabilityVersionId || uid("capability-version"), siteAgentId, capabilityId: capability.id, version: 1,
    status: "draft", implementation: input.implementation, validation: input.validation || { status: "pending" }, createdAt: now, updatedAt: now,
  };
  capability.latestVersionId = version.id;
  const updatedTask: CapabilityTask = { ...task, capabilityId: capability.id, capabilityVersionId: version.id, stage: "author", updatedAt: now };
  const database = await databaseReady();
  if (!database) {
    const memory = memoryFor(siteAgentId);
    if (memory.capabilities.some((item) => item.stableKey === stableKey && item.status !== "deleted")) throw new Error("capability_task_duplicate");
    memory.capabilities.push(capability); memory.versions.push(version);
    memory.tasks[memory.tasks.findIndex((item) => item.id === taskId)] = updatedTask;
    if (task.proposalId) { const proposal = memory.proposals.find((item) => item.id === task.proposalId); if (proposal) { proposal.capabilityId = capability.id; proposal.updatedAt = now; } }
    return { task: updatedTask, capability, version, persistence: "memory" as const };
  }
  const existing = await all<CapabilityRow>(database, `SELECT * FROM site_agent_v2_capabilities WHERE site_agent_id=? AND stable_key=? AND deleted_at IS NULL LIMIT 1`, [siteAgentId, stableKey]);
  if (existing[0]) throw new Error("capability_task_duplicate");
  const statements = [
    database.prepare(`INSERT INTO site_agent_v2_capabilities
      (id,site_agent_id,stable_key,intent_key,name,description,goal_template,status,current_version_id,latest_version_id,contract_json,capability_json,unpublished_at,deleted_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(capability.id, siteAgentId, capability.stableKey, capability.intentKey, capability.name, capability.description, capability.goalTemplate, capability.status, null, version.id, capabilityContract(capability), capabilityMetadata(capability), null, null, now, now),
    database.prepare(`INSERT INTO site_agent_v2_capability_versions
      (id,site_agent_id,capability_id,version,status,implementation_json,validation_json,version_json,published_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(version.id, siteAgentId, capability.id, version.version, version.status, JSON.stringify(version.implementation || {}), JSON.stringify(version.validation || {}), versionMetadata(version), null, now, now),
    database.prepare(`UPDATE site_agent_v2_capability_tasks SET capability_id=?,capability_version_id=?,stage='author',updated_at=?
      WHERE id=? AND site_agent_id=? AND type='generate' AND capability_id IS NULL AND capability_version_id IS NULL AND status IN ('queued','running')`).bind(capability.id, version.id, now, taskId, siteAgentId),
  ];
  if (task.proposalId) statements.push(database.prepare(`UPDATE site_agent_v2_capability_proposals SET capability_id=?,updated_at=? WHERE id=? AND site_agent_id=? AND deleted_at IS NULL`).bind(capability.id, now, task.proposalId, siteAgentId));
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure || Number(results[2]?.meta?.changes || 0) !== 1) throw new Error(failure?.error || "capability_task_materialize_conflict");
  return { task: updatedTask, capability, version, persistence: "d1" as const };
}

export async function updateCapabilityTaskProgress(siteAgentId: string, taskId: string, patch: {
  status?: Extract<CapabilityTaskStatus, "running" | "awaiting-review" | "completed" | "failed" | "cancelled">;
  stage?: CapabilityTaskStage;
  result?: Record<string, JsonValue>;
  evidence?: Record<string, JsonValue>;
  error?: CapabilityTask["error"];
  runnerId?: string;
}) {
  const task = await getCapabilityTask(siteAgentId, taskId);
  if (!task) throw new Error("capability_task_not_found");
  if (["completed", "archived", "cancelled"].includes(task.status)) throw new Error("capability_task_terminal");
  const now = new Date().toISOString();
  const status = patch.status || task.status;
  const attempts = [...task.attempts];
  if (status === "running" && task.status !== "running") attempts.push({ number: attempts.length + 1, startedAt: now, status: "running", runnerId: patch.runnerId });
  if ((status === "failed" || status === "awaiting-review" || status === "completed") && attempts.at(-1)?.status === "running") {
    attempts[attempts.length - 1] = { ...attempts.at(-1)!, endedAt: now, status: status === "failed" ? "failed" : "passed", error: patch.error };
  }
  const updated: CapabilityTask = {
    ...task, status, stage: patch.stage || (status === "awaiting-review" ? "review" : status === "completed" ? "complete" : task.stage),
    attempts, result: patch.result || task.result, evidence: patch.evidence || task.evidence, error: patch.error, review: status === "awaiting-review" ? { status: "pending" } : task.review, updatedAt: now,
  };
  const database = await databaseReady();
  if (!database) {
    const memory = memoryFor(siteAgentId);
    memory.tasks[memory.tasks.findIndex((item) => item.id === taskId)] = updated;
    if (task.type !== "validate" && task.capabilityVersionId && (status === "awaiting-review" || status === "failed")) {
      const version = memory.versions.find((item) => item.id === task.capabilityVersionId);
      if (version) { version.status = status === "awaiting-review" ? "awaiting-review" : "failed"; version.updatedAt = now; }
    }
    if (status === "failed" && task.type === "generate" && task.capabilityId) {
      const capability = memory.capabilities.find((item) => item.id === task.capabilityId);
      if (capability && !capability.currentVersionId) { capability.status = "draft_failed"; capability.updatedAt = now; }
    }
    return updated;
  }
  const result = await run(database, `UPDATE site_agent_v2_capability_tasks SET status=?,stage=?,task_json=?,result_json=?,evidence_json=?,error_json=?,updated_at=? WHERE id=? AND site_agent_id=? AND status=?`, [updated.status, updated.stage, taskPayload(updated), JSON.stringify(updated.result), JSON.stringify(updated.evidence), updated.error ? JSON.stringify(updated.error) : null, now, taskId, siteAgentId, task.status]);
  if (Number(result.meta?.changes || 0) !== 1) throw new Error("capability_task_conflict");
  if (task.type !== "validate" && task.capabilityVersionId && (status === "awaiting-review" || status === "failed")) {
    if (status === "awaiting-review") {
      await run(database, `UPDATE site_agent_v2_capability_versions SET status='awaiting-review',updated_at=?
        WHERE id=? AND site_agent_id=? AND json_extract(validation_json,'$.status')='passed'`,
      [now, task.capabilityVersionId, siteAgentId]);
    } else {
      await run(database, `UPDATE site_agent_v2_capability_versions SET status='failed',validation_json=?,updated_at=?
        WHERE id=? AND site_agent_id=?`,
      [JSON.stringify({ status: "failed", summary: patch.error?.summary }), now, task.capabilityVersionId, siteAgentId]);
    }
  }
  if (status === "failed" && task.type === "generate" && task.capabilityId) {
    await run(database, `UPDATE site_agent_v2_capabilities SET status='draft_failed',updated_at=?
      WHERE id=? AND site_agent_id=? AND current_version_id IS NULL AND deleted_at IS NULL`, [now, task.capabilityId, siteAgentId]);
  }
  return updated;
}

export async function recordCapabilityTaskAutoReview(siteAgentId: string, taskId: string, input: {
  decision: "manual-review" | "error";
  summary: string;
  confidence?: number;
  checks?: string[];
}) {
  const task = await getCapabilityTask(siteAgentId, taskId);
  if (!task) throw new Error("capability_task_not_found");
  if (task.status !== "awaiting-review" || task.stage !== "review") return task;
  const now = new Date().toISOString();
  const evidence = {
    ...task.evidence,
    autoReview: {
      decision: input.decision,
      summary: input.summary,
      confidence: input.confidence,
      checks: input.checks || [],
      reviewedAt: now,
    } as unknown as JsonValue,
  };
  const updated: CapabilityTask = {
    ...task,
    evidence,
    review: { status: "pending", reviewer: "ai", feedback: input.summary, decidedAt: now },
    updatedAt: now,
  };
  const database = await databaseReady();
  if (!database) {
    const memory = memoryFor(siteAgentId);
    memory.tasks[memory.tasks.findIndex((item) => item.id === taskId)] = updated;
    return updated;
  }
  const result = await run(database, `UPDATE site_agent_v2_capability_tasks
    SET task_json=?,evidence_json=?,updated_at=?
    WHERE id=? AND site_agent_id=? AND status='awaiting-review' AND stage='review'`,
  [taskPayload(updated), JSON.stringify(evidence), now, taskId, siteAgentId]);
  if (Number(result.meta?.changes || 0) !== 1) throw new Error("capability_task_auto_review_conflict");
  return updated;
}

export async function actOnCapabilityTask(siteAgentId: string, taskId: string, action: "approve" | "reject" | "retry" | "rebuild" | "revalidate" | "cancel" | "archive", input: { feedback?: string; reviewer?: "administrator" | "ai" } = {}) {
  const task = await getCapabilityTask(siteAgentId, taskId);
  if (!task) throw new Error("capability_task_not_found");
  const now = new Date().toISOString();
  const database = await databaseReady();
  if (action === "cancel") {
    if (!new Set<CapabilityTaskStatus>(["queued", "running", "awaiting-review"]).has(task.status)) {
      throw new Error("capability_task_not_cancellable");
    }
    const cancellation = { code: "user_cancelled", summary: input.feedback?.trim() || "任务已由管理员终止。" };
    const attempts = [...task.attempts];
    if (attempts.at(-1)?.status === "running") {
      attempts[attempts.length - 1] = { ...attempts.at(-1)!, status: "failed", endedAt: now, error: cancellation };
    }
    const updated: CapabilityTask = { ...task, status: "cancelled", attempts, error: cancellation, updatedAt: now };
    if (!database) {
      const memory = memoryFor(siteAgentId);
      memory.tasks[memory.tasks.findIndex((item) => item.id === taskId)] = updated;
      if (task.type !== "validate" && task.capabilityVersionId) {
        const version = memory.versions.find((item) => item.id === task.capabilityVersionId);
        if (version && version.status !== "published" && version.status !== "superseded") {
          version.status = "failed";
          version.validation = { ...version.validation, status: "failed", failureClass: "user_cancelled", summary: cancellation.summary };
          version.updatedAt = now;
        }
      }
      if (task.type === "generate" && task.capabilityId) {
        const capability = memory.capabilities.find((item) => item.id === task.capabilityId && !item.currentVersionId);
        if (capability) { capability.status = "draft_failed"; capability.updatedAt = now; }
      }
      await releaseRunnerLeasesForWorkload({ kind: "capability-task", id: task.id, siteAgentId }, cancellation);
      return updated;
    }
    const statements = [database.prepare(`UPDATE site_agent_v2_capability_tasks SET
      status='cancelled',task_json=?,error_json=?,runner_id=NULL,runner_session_id=NULL,runner_lease_id=NULL,
      runner_lease_fence=NULL,runner_lease_expires_at=NULL,updated_at=?
      WHERE id=? AND site_agent_id=? AND status=?`)
      .bind(taskPayload(updated), JSON.stringify(cancellation), now, task.id, siteAgentId, task.status)];
    if (task.type !== "validate" && task.capabilityVersionId) statements.push(database.prepare(`UPDATE site_agent_v2_capability_versions
      SET status='failed',validation_json=?,updated_at=? WHERE id=? AND site_agent_id=? AND status IN ('draft','awaiting-review')`)
      .bind(JSON.stringify({ status: "failed", failureClass: "user_cancelled", summary: cancellation.summary }), now, task.capabilityVersionId, siteAgentId));
    if (task.type === "generate" && task.capabilityId) statements.push(database.prepare(`UPDATE site_agent_v2_capabilities
      SET status='draft_failed',updated_at=? WHERE id=? AND site_agent_id=? AND current_version_id IS NULL AND deleted_at IS NULL`)
      .bind(now, task.capabilityId, siteAgentId));
    const results = await database.batch(statements);
    const failure = results.find((result) => !result.success);
    if (failure || Number(results[0]?.meta?.changes || 0) !== 1) throw new Error(failure?.error || "capability_task_cancel_conflict");
    await releaseRunnerLeasesForWorkload({ kind: "capability-task", id: task.id, siteAgentId }, cancellation);
    return updated;
  }
  if (action === "revalidate") {
    if (task.status !== "awaiting-review" || task.stage !== "review" || task.type === "validate"
      || !task.capabilityId || !task.capabilityVersionId) throw new Error("capability_task_not_revalidatable");
    const version = (await listCapabilityVersions(siteAgentId, task.capabilityId)).find((item) => item.id === task.capabilityVersionId);
    if (!version || version.status !== "awaiting-review") throw new Error("capability_task_version_not_revalidatable");
    const currentRunner = task.evidence.runner;
    const existingHistory = Array.isArray(task.evidence.validationHistory) ? task.evidence.validationHistory : [];
    const retainedEvidence = Object.fromEntries(
      Object.entries(task.evidence).filter(([key]) => key !== "runner" && key !== "autoReview"),
    ) as Record<string, JsonValue>;
    const evidence = {
      ...retainedEvidence,
      ...(currentRunner ? { validationHistory: [...existingHistory, currentRunner].slice(-8) as JsonValue } : {}),
    };
    const updated: CapabilityTask = {
      ...task,
      status: "queued",
      stage: "validate",
      evidence,
      error: undefined,
      review: undefined,
      updatedAt: now,
    };
    const validation = {
      ...version.validation,
      status: "pending" as const,
      runId: undefined,
      validatedContentHash: undefined,
      failureClass: undefined,
      summary: "等待使用当前验收规范重新采集证据。",
    };
    if (!database) {
      const memory = memoryFor(siteAgentId);
      memory.tasks[memory.tasks.findIndex((item) => item.id === taskId)] = updated;
      memory.versions[memory.versions.findIndex((item) => item.id === version.id)] = { ...version, status: "draft", validation, updatedAt: now };
      return updated;
    }
    const results = await database.batch([
      database.prepare(`UPDATE site_agent_v2_capability_versions SET status='draft',validation_json=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND capability_id=? AND status='awaiting-review'`)
        .bind(JSON.stringify(validation), now, version.id, siteAgentId, task.capabilityId),
      database.prepare(`UPDATE site_agent_v2_capability_tasks SET status='queued',stage='validate',task_json=?,evidence_json=?,error_json=NULL,
        runner_id=NULL,runner_session_id=NULL,runner_lease_id=NULL,runner_lease_fence=NULL,runner_lease_expires_at=NULL,updated_at=?
        WHERE id=? AND site_agent_id=? AND status='awaiting-review' AND stage='review'`)
        .bind(taskPayload(updated), JSON.stringify(evidence), now, task.id, siteAgentId),
    ]);
    const failure = results.find((result) => !result.success);
    if (failure || Number(results[0]?.meta?.changes || 0) !== 1 || Number(results[1]?.meta?.changes || 0) !== 1) {
      throw new Error(failure?.error || "capability_task_revalidation_conflict");
    }
    return updated;
  }
  if (action === "approve") {
    if (task.status !== "awaiting-review" || task.stage !== "review") throw new Error("capability_task_not_awaiting_review");
    if (task.type !== "validate" && (!task.capabilityId || !task.capabilityVersionId)) throw new Error("capability_task_draft_missing");
    const updated: CapabilityTask = { ...task, status: "completed", stage: "complete", review: { status: "approved", reviewer: input.reviewer || "administrator", feedback: input.feedback, decidedAt: now }, updatedAt: now };
    if (task.type === "validate") {
      if (!database) {
        const memory = memoryFor(siteAgentId);
        memory.tasks[memory.tasks.findIndex((item) => item.id === taskId)] = updated;
        return updated;
      }
      const result = await run(database, `UPDATE site_agent_v2_capability_tasks
        SET status='completed',stage='complete',task_json=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND status='awaiting-review' AND stage='review'`,
      [taskPayload(updated), now, taskId, siteAgentId]);
      if (Number(result.meta?.changes || 0) !== 1) throw new Error("capability_task_approval_conflict");
      return updated;
    }

    const capability = await getCapability(siteAgentId, task.capabilityId!);
    const version = (await listCapabilityVersions(siteAgentId, task.capabilityId!))
      .find((item) => item.id === task.capabilityVersionId);
    if (!capability || !version) throw new Error("capability_task_draft_missing");
    if (capability.latestVersionId !== version.id) throw new Error("capability_task_version_superseded");
    if (version.status !== "awaiting-review" || version.validation?.status !== "passed") {
      throw new Error("capability_task_validation_required");
    }
    if (!version.validation.runId || !version.validation.startUrl) {
      throw new Error("capability_task_validation_evidence_missing");
    }
    const active = await getActiveSiteAgentRelease(siteAgentId);
    const publishingCapability: Capability = {
      ...capability,
      status: "active",
      currentVersionId: version.id,
      latestVersionId: version.id,
      unpublishedAt: undefined,
      updatedAt: now,
    };
    const publishingVersion: CapabilityVersion = {
      ...version,
      status: "published",
      publishedAt: now,
      updatedAt: now,
    };
    const publication = publishCapabilityRuntimeRelease(
      active.release,
      publishingCapability,
      publishingVersion,
      now,
    );
    if (!database) {
      const memory = memoryFor(siteAgentId);
      memory.tasks[memory.tasks.findIndex((item) => item.id === taskId)] = updated;
      memory.versions[memory.versions.findIndex((item) => item.id === version.id)] = publication.version;
      memory.capabilities[memory.capabilities.findIndex((item) => item.id === capability.id)] = publishingCapability;
      activatePreparedSiteAgentReleaseInMemory(siteAgentId, active.release.id, publication.release);
      return updated;
    }
    const publicationGuard = `EXISTS (
      SELECT 1 FROM site_agent_v2_agents a
      JOIN site_agent_v2_capability_tasks t ON t.site_agent_id=a.id
      JOIN site_agent_v2_capability_versions v ON v.id=t.capability_version_id AND v.site_agent_id=t.site_agent_id
      JOIN site_agent_v2_capabilities c ON c.id=t.capability_id AND c.site_agent_id=t.site_agent_id
      WHERE a.id=? AND a.active_release_id=? AND t.id=? AND t.status='awaiting-review' AND t.stage='review'
        AND v.id=? AND v.status='awaiting-review' AND json_extract(v.validation_json,'$.status')='passed'
        AND c.id=? AND c.latest_version_id=v.id AND c.deleted_at IS NULL
    )`;
    const statements = [
      database.prepare(`INSERT INTO site_agent_v2_releases
        (id,site_agent_id,version,content_hash,release_json,created_at)
        SELECT ?,?,?,?,?,? WHERE ${publicationGuard}`)
        .bind(publication.release.id, siteAgentId, publication.release.version, publication.release.contentHash,
          JSON.stringify(publication.release), now, siteAgentId, active.release.id, task.id, version.id, capability.id),
      database.prepare(`UPDATE site_agent_v2_capability_versions SET status='superseded',updated_at=?
        WHERE capability_id=? AND site_agent_id=? AND status='published' AND id<>?
          AND EXISTS (SELECT 1 FROM site_agent_v2_releases WHERE id=? AND site_agent_id=?)`)
        .bind(now, capability.id, siteAgentId, version.id, publication.release.id, siteAgentId),
      database.prepare(`UPDATE site_agent_v2_capability_versions
        SET status='published',version_json=?,published_at=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND status='awaiting-review'
          AND EXISTS (SELECT 1 FROM site_agent_v2_releases WHERE id=? AND site_agent_id=?)`)
        .bind(versionMetadata(publication.version), now, now, version.id, siteAgentId, publication.release.id, siteAgentId),
      database.prepare(`UPDATE site_agent_v2_capabilities
        SET status='active',current_version_id=?,latest_version_id=?,unpublished_at=NULL,updated_at=?
        WHERE id=? AND site_agent_id=? AND latest_version_id=? AND deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM site_agent_v2_releases WHERE id=? AND site_agent_id=?)`)
        .bind(version.id, version.id, now, capability.id, siteAgentId, version.id, publication.release.id, siteAgentId),
      database.prepare(`UPDATE site_agent_v2_capability_tasks
        SET status='completed',stage='complete',task_json=?,updated_at=?
        WHERE id=? AND site_agent_id=? AND status='awaiting-review' AND stage='review'
          AND EXISTS (SELECT 1 FROM site_agent_v2_releases WHERE id=? AND site_agent_id=?)`)
        .bind(taskPayload(updated), now, task.id, siteAgentId, publication.release.id, siteAgentId),
      database.prepare(`UPDATE site_agent_v2_agents SET profile_json=?,active_release_id=?,updated_at=?
        WHERE id=? AND active_release_id=?
          AND EXISTS (SELECT 1 FROM site_agent_v2_releases WHERE id=? AND site_agent_id=?)`)
        .bind(JSON.stringify(publication.release.profile), publication.release.id, now, siteAgentId,
          active.release.id, publication.release.id, siteAgentId),
    ];
    const results = await database.batch(statements);
    const failure = results.find((result) => !result.success);
    if (failure || Number(results[0]?.meta?.changes || 0) !== 1
      || Number(results[2]?.meta?.changes || 0) !== 1
      || Number(results[3]?.meta?.changes || 0) !== 1
      || Number(results[4]?.meta?.changes || 0) !== 1
      || Number(results[5]?.meta?.changes || 0) !== 1) {
      throw new Error(failure?.error || "capability_task_approval_conflict");
    }
    return updated;
  }

  if (action === "reject") {
    if (task.status !== "awaiting-review") throw new Error("capability_task_not_awaiting_review");
    const updated: CapabilityTask = { ...task, status: "rejected", review: { status: "rejected", reviewer: input.reviewer || "administrator", feedback: input.feedback, decidedAt: now }, error: { code: input.reviewer === "ai" ? "ai_rejected" : "human_rejected", summary: input.feedback?.trim() || "人工验证未通过" }, updatedAt: now };
    if (!database) {
      const memory = memoryFor(siteAgentId); memory.tasks[memory.tasks.findIndex((item) => item.id === taskId)] = updated;
      if (task.type !== "validate") { const version = memory.versions.find((item) => item.id === task.capabilityVersionId); if (version) version.status = "failed"; }
      return updated;
    }
    const statements = [
      database.prepare(`UPDATE site_agent_v2_capability_tasks SET status='rejected',task_json=?,error_json=?,updated_at=? WHERE id=? AND site_agent_id=? AND status='awaiting-review'`).bind(taskPayload(updated), JSON.stringify(updated.error), now, taskId, siteAgentId),
    ];
    if (task.type !== "validate" && task.capabilityVersionId) statements.push(database.prepare(`UPDATE site_agent_v2_capability_versions SET status='failed',updated_at=? WHERE id=? AND site_agent_id=? AND status='awaiting-review'`).bind(now, task.capabilityVersionId, siteAgentId));
    const results = await database.batch(statements); const failure = results.find((result) => !result.success);
    if (failure || Number(results[0]?.meta?.changes || 0) !== 1) throw new Error(failure?.error || "capability_task_rejection_conflict");
    if (task.type === "generate" && task.capabilityId) await run(database, `UPDATE site_agent_v2_capabilities SET status='draft_failed',updated_at=? WHERE id=? AND site_agent_id=? AND current_version_id IS NULL AND deleted_at IS NULL`, [now, task.capabilityId, siteAgentId]);
    return updated;
  }

  if (action === "retry") {
    if (!new Set<CapabilityTaskStatus>(["failed", "cancelled"]).has(task.status)) throw new Error("capability_task_not_retryable");
    const retried: CapabilityTask = {
      ...task,
      status: "queued",
      stage: task.type === "validate" ? "validate" : "author",
      error: undefined,
      review: undefined,
      updatedAt: now,
    };
    if (!database) {
      const memory = memoryFor(siteAgentId);
      memory.tasks[memory.tasks.findIndex((item) => item.id === taskId)] = retried;
      if (task.capabilityVersionId) {
        const version = memory.versions.find((item) => item.id === task.capabilityVersionId);
        if (version) { version.status = "draft"; version.validation = { status: "pending" }; version.updatedAt = now; }
      }
      if (task.type === "generate" && task.capabilityId) {
        const capability = memory.capabilities.find((item) => item.id === task.capabilityId);
        if (capability?.status === "draft_failed") { capability.status = "draft"; capability.updatedAt = now; }
      }
      return retried;
    }
    const statements = [database.prepare(`UPDATE site_agent_v2_capability_tasks
      SET status='queued',stage=?,task_json=?,error_json=NULL,updated_at=?
      WHERE id=? AND site_agent_id=? AND status=?`).bind(retried.stage, taskPayload(retried), now, taskId, siteAgentId, task.status)];
    if (task.capabilityVersionId) statements.push(database.prepare(`UPDATE site_agent_v2_capability_versions
      SET status='draft',validation_json=?,updated_at=? WHERE id=? AND site_agent_id=? AND status='failed'`)
      .bind(JSON.stringify({ status: "pending" }), now, task.capabilityVersionId, siteAgentId));
    if (task.type === "generate" && task.capabilityId) statements.push(database.prepare(`UPDATE site_agent_v2_capabilities
      SET status='draft',updated_at=? WHERE id=? AND site_agent_id=? AND status='draft_failed' AND deleted_at IS NULL`)
      .bind(now, task.capabilityId, siteAgentId));
    const results = await database.batch(statements);
    const failure = results.find((result) => !result.success);
    if (failure || Number(results[0]?.meta?.changes || 0) !== 1) throw new Error(failure?.error || "capability_task_retry_conflict");
    return retried;
  }

  if (action === "rebuild") {
    if (!new Set<CapabilityTaskStatus>(["failed", "rejected", "cancelled"]).has(task.status)) throw new Error("capability_task_not_retryable");
    let capabilityVersionId = task.capabilityVersionId;
    let newVersion: CapabilityVersion | undefined;
    let capability: Capability | undefined;
    if (task.capabilityId && task.type !== "validate") {
      capability = await getCapability(siteAgentId, task.capabilityId, { includeDeleted: true });
      if (!capability || capability.status === "deleted") throw new Error("capability_deleted");
      const versions = await listCapabilityVersions(siteAgentId, task.capabilityId);
      const previous = versions.find((item) => item.id === task.capabilityVersionId);
      newVersion = {
        id: uid("capability-version"), siteAgentId, capabilityId: task.capabilityId,
        version: Math.max(0, ...versions.map((item) => item.version)) + 1,
        status: "draft", implementation: previous?.implementation,
        validation: { status: "pending" }, createdAt: now, updatedAt: now,
      };
      capabilityVersionId = newVersion.id;
    }
    const retried: CapabilityTask = {
      id: uid("capability-task"), siteAgentId, proposalId: task.proposalId,
      capabilityId: task.capabilityId, capabilityVersionId, type: task.type,
      status: "queued", stage: task.type === "validate" ? "validate" : "author", attempts: [],
      result: { ...task.result, rebuiltFromTaskId: task.id },
      evidence: { ...task.evidence, retryOfTaskId: task.id }, createdAt: now, updatedAt: now,
    };
    if (!database) {
      const memory = memoryFor(siteAgentId);
      if (newVersion) memory.versions.push(newVersion);
      if (capability && newVersion) {
        const index = memory.capabilities.findIndex((item) => item.id === capability!.id);
        memory.capabilities[index] = { ...capability, status: task.type === "generate" ? "draft" : capability.status, latestVersionId: newVersion.id, updatedAt: now };
      }
      memory.tasks.push(retried);
      return retried;
    }
    const statements = [];
    if (newVersion && capability) {
      statements.push(
        database.prepare(`INSERT INTO site_agent_v2_capability_versions
          (id,site_agent_id,capability_id,version,status,implementation_json,validation_json,version_json,published_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(newVersion.id, siteAgentId, newVersion.capabilityId, newVersion.version, newVersion.status, JSON.stringify(newVersion.implementation || {}), JSON.stringify(newVersion.validation || {}), versionMetadata(newVersion), null, now, now),
        database.prepare(`UPDATE site_agent_v2_capabilities SET status=?,latest_version_id=?,updated_at=? WHERE id=? AND site_agent_id=? AND deleted_at IS NULL`).bind(task.type === "generate" ? "draft" : capability.status, newVersion.id, now, capability.id, siteAgentId),
      );
    }
    statements.push(database.prepare(`INSERT INTO site_agent_v2_capability_tasks
      (id,site_agent_id,proposal_id,capability_id,capability_version_id,type,status,stage,task_json,result_json,evidence_json,error_json,archived_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(retried.id, siteAgentId, retried.proposalId || null, retried.capabilityId || null, retried.capabilityVersionId || null, retried.type, retried.status, retried.stage, taskPayload(retried, { retryOfTaskId: task.id }), JSON.stringify(retried.result), JSON.stringify(retried.evidence), null, null, now, now));
    const results = await database.batch(statements); const failure = results.find((result) => !result.success);
    if (failure || Number(results.at(-1)?.meta?.changes || 0) !== 1) throw new Error(failure?.error || "capability_task_retry_conflict");
    return retried;
  }

  if (action !== "archive") throw new Error("capability_task_action_invalid");
  if (!new Set<CapabilityTaskStatus>(["completed", "failed", "rejected", "cancelled"]).has(task.status)) throw new Error("capability_task_not_archivable");
  const updated: CapabilityTask = { ...task, status: "archived", archivedAt: now, updatedAt: now };
  if (!database) { const memory = memoryFor(siteAgentId); memory.tasks[memory.tasks.findIndex((item) => item.id === taskId)] = updated; return updated; }
  const result = await run(database, `UPDATE site_agent_v2_capability_tasks SET status='archived',task_json=?,archived_at=?,updated_at=? WHERE id=? AND site_agent_id=? AND status=?`, [taskPayload(updated, { archivedFromStatus: task.status }), now, now, taskId, siteAgentId, task.status]);
  if (Number(result.meta?.changes || 0) !== 1) throw new Error("capability_task_archive_conflict");
  return updated;
}

export async function actOnCapability(siteAgentId: string, capabilityId: string, action: "unpublish" | "relist" | "delete") {
  const capability = await getCapability(siteAgentId, capabilityId, { includeDeleted: true });
  if (!capability) throw new Error("capability_not_found");
  if (capability.status === "deleted") throw new Error("capability_deleted");
  if (action === "delete") {
    const activeTasks = (await listCapabilityTasks(siteAgentId, { capabilityId, includeArchived: true })).tasks
      .filter((task) => new Set<CapabilityTaskStatus>(["queued", "running", "awaiting-review"]).has(task.status));
    if (activeTasks.length) throw new Error("capability_has_active_task");
  }
  const now = new Date().toISOString();
  let updated: Capability;
  if (action === "unpublish") {
    if (!capability.currentVersionId || !new Set<CapabilityStatus>(["active", "degraded"]).has(capability.status)) throw new Error("capability_not_published");
    updated = { ...capability, status: "unpublished", unpublishedAt: now, updatedAt: now };
  } else if (action === "relist") {
    if (capability.status !== "unpublished" || !capability.currentVersionId) throw new Error("capability_not_unpublished");
    updated = { ...capability, status: "active", unpublishedAt: undefined, updatedAt: now };
  } else {
    updated = { ...capability, status: "deleted", deletedAt: now, updatedAt: now };
  }
  const active = await getActiveSiteAgentRelease(siteAgentId);
  let runtimeRelease: ReturnType<typeof unpublishCapabilityRuntimeRelease> | undefined;
  let relistedVersion: CapabilityVersion | undefined;
  if (action === "unpublish" || (action === "delete" && new Set<CapabilityStatus>(["active", "degraded"]).has(capability.status))) {
    runtimeRelease = action === "delete"
      ? deleteCapabilityRuntimeRelease(active.release, capability.id, now)
      : unpublishCapabilityRuntimeRelease(active.release, capability.id, now);
  } else if (action === "relist") {
    const version = (await listCapabilityVersions(siteAgentId, capability.id))
      .find((item) => item.id === capability.currentVersionId);
    if (!version || version.status !== "published" || version.validation?.status !== "passed") {
      throw new Error("capability_current_version_not_executable");
    }
    const relisted = relistCapabilityRuntimeRelease(
      active.release,
      { ...updated, status: "active" },
      version,
      now,
    );
    runtimeRelease = relisted.release;
    relistedVersion = relisted.version;
  }
  const database = await databaseReady();
  if (!database) {
    const memory = memoryFor(siteAgentId);
    memory.capabilities[memory.capabilities.findIndex((item) => item.id === capabilityId)] = updated;
    if (relistedVersion) {
      memory.versions[memory.versions.findIndex((item) => item.id === relistedVersion!.id)] = relistedVersion;
    }
    if (runtimeRelease) {
      activatePreparedSiteAgentReleaseInMemory(siteAgentId, active.release.id, runtimeRelease);
    }
    return updated;
  }
  if (!runtimeRelease) {
    const statements = [database.prepare(`UPDATE site_agent_v2_capabilities
      SET status=?,unpublished_at=?,deleted_at=?,updated_at=?
      WHERE id=? AND site_agent_id=? AND status=? AND deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM site_agent_v2_capability_tasks t
          WHERE t.site_agent_id=site_agent_v2_capabilities.site_agent_id
            AND t.capability_id=site_agent_v2_capabilities.id
            AND t.status IN ('queued','running','awaiting-review'))`)
      .bind(updated.status, updated.unpublishedAt || null, updated.deletedAt || null, now,
        capabilityId, siteAgentId, capability.status)];
    const results = await database.batch(statements);
    const failure = results.find((item) => !item.success);
    if (failure || Number(results[0]?.meta?.changes || 0) !== 1) throw new Error(failure?.error || "capability_action_conflict");
    return updated;
  }
  const statements = [
    database.prepare(`INSERT INTO site_agent_v2_releases
      (id,site_agent_id,version,content_hash,release_json,created_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS (
        SELECT 1 FROM site_agent_v2_agents a
        JOIN site_agent_v2_capabilities c ON c.site_agent_id=a.id
        WHERE a.id=? AND a.active_release_id=? AND c.id=? AND c.status=? AND c.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM site_agent_v2_capability_tasks t
            WHERE t.site_agent_id=c.site_agent_id AND t.capability_id=c.id
              AND t.status IN ('queued','running','awaiting-review'))
      )`).bind(runtimeRelease.id, siteAgentId, runtimeRelease.version, runtimeRelease.contentHash,
      JSON.stringify(runtimeRelease), now, siteAgentId, active.release.id, capabilityId, capability.status),
  ];
  if (relistedVersion) statements.push(database.prepare(`UPDATE site_agent_v2_capability_versions
    SET version_json=?,updated_at=? WHERE id=? AND site_agent_id=? AND status='published'
      AND EXISTS (SELECT 1 FROM site_agent_v2_releases WHERE id=? AND site_agent_id=?)`)
    .bind(versionMetadata(relistedVersion), now, relistedVersion.id, siteAgentId, runtimeRelease.id, siteAgentId));
  statements.push(database.prepare(`UPDATE site_agent_v2_capabilities
    SET status=?,unpublished_at=?,deleted_at=?,updated_at=?
    WHERE id=? AND site_agent_id=? AND status=? AND deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM site_agent_v2_capability_tasks t
        WHERE t.site_agent_id=site_agent_v2_capabilities.site_agent_id
          AND t.capability_id=site_agent_v2_capabilities.id
          AND t.status IN ('queued','running','awaiting-review'))
      AND EXISTS (SELECT 1 FROM site_agent_v2_releases WHERE id=? AND site_agent_id=?)`)
    .bind(updated.status, updated.unpublishedAt || null, updated.deletedAt || null, now,
      capabilityId, siteAgentId, capability.status, runtimeRelease.id, siteAgentId));
  statements.push(database.prepare(`UPDATE site_agent_v2_agents SET profile_json=?,active_release_id=?,updated_at=?
    WHERE id=? AND active_release_id=?
      AND EXISTS (SELECT 1 FROM site_agent_v2_releases WHERE id=? AND site_agent_id=?)`)
    .bind(JSON.stringify(runtimeRelease.profile), runtimeRelease.id, now, siteAgentId,
      active.release.id, runtimeRelease.id, siteAgentId));
  const results = await database.batch(statements);
  const failure = results.find((item) => !item.success);
  const capabilityResultIndex = relistedVersion ? 2 : 1;
  const agentResultIndex = results.length - 1;
  if (failure || Number(results[0]?.meta?.changes || 0) !== 1
    || Number(results[capabilityResultIndex]?.meta?.changes || 0) !== 1
    || Number(results[agentResultIndex]?.meta?.changes || 0) !== 1) {
    throw new Error(failure?.error || "capability_action_conflict");
  }
  return updated;
}

/** On site deletion: this module's tables of the four-table model (capabilities / versions / proposals / tasks). Children before parents. */
export const CAPABILITY_CENTER_DELETION_TABLES = [
  "site_agent_v2_capability_tasks",
  "site_agent_v2_capability_proposals",
  "site_agent_v2_capability_versions",
  "site_agent_v2_capabilities",
] as const;

export function capabilityCenterDeletionStatements(database: D1DatabaseLike, siteAgentId: string): D1PreparedStatementLike[] {
  return CAPABILITY_CENTER_DELETION_TABLES.map((table) => database.prepare(`DELETE FROM ${table} WHERE site_agent_id=?`).bind(siteAgentId));
}

export function deleteMemoryCapabilityCenterData(siteAgentId: string) {
  (globalThis as MemoryRoot).__SITEWAKE_CAPABILITY_CENTER_V2__?.delete(siteAgentId);
}
