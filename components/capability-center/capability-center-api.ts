import type {
  Capability,
  CapabilityDetail,
  CapabilityProposal,
  CapabilityTask,
  CapabilityTaskDetail,
  CapabilityVersion,
} from "../../lib/capability-center/model";
import type {
  CapabilityProject,
  CapabilityProjectDetail,
  CapabilityRun,
  CapabilitySignal,
} from "../../lib/site-knowledge/protocol";

type JsonRecord = Record<string, unknown>;

async function json<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({})) as JsonRecord;
  if (!response.ok) throw new Error(String(payload.message || payload.error || response.statusText));
  return payload as T;
}

function listFrom<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const value = (payload as JsonRecord)[key];
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

export function capabilityProjectProjection(capability: Capability, versions: CapabilityVersion[] = []): CapabilityProject {
  const current = versions.find((item) => item.id === capability.currentVersionId);
  const latest = versions.find((item) => item.id === capability.latestVersionId);
  const status: CapabilityProject["status"] = capability.status === "active"
    ? "available"
    : capability.status === "draft"
      ? latest?.status === "awaiting-review" ? "awaiting-review" : latest?.status === "failed" ? "needs-guidance" : "building"
      : capability.status === "draft_failed"
        ? "needs-guidance"
      : capability.status === "deleted"
        ? "archived"
        : capability.status;
  return {
    id: capability.id,
    siteAgentId: capability.siteAgentId,
    stableKey: capability.stableKey,
    intentKey: capability.intentKey,
    name: capability.name,
    description: capability.description,
    goalTemplate: capability.goalTemplate,
    requestedGoal: capability.goalTemplate,
    origin: "administrator",
    triggeredBy: "administrator",
    generatedBy: "program",
    status,
    stage: current ? "publish" : latest?.status === "awaiting-review" ? "validate" : "author",
    kind: capability.kind,
    structure: capability.structure,
    operation: capability.operation,
    exposure: capability.exposure,
    resultKind: capability.resultKind,
    canonicalCapabilityId: capability.id,
    activeCapabilityId: capability.status === "active" || capability.status === "degraded" || capability.status === "unpublished" ? capability.id : undefined,
    activeRevisionId: capability.currentVersionId,
    latestRevisionId: capability.latestVersionId,
    inputSchema: capability.inputSchema,
    outputSchema: capability.outputSchema,
    executionRequirements: capability.executionRequirements,
    health: { recentRuns: 0, recentSuccesses: 0 },
    revisionCount: versions.length,
    createdAt: capability.createdAt,
    updatedAt: capability.updatedAt,
    unpublishedAt: capability.unpublishedAt,
  };
}

function detailProjection(detail: CapabilityDetail): CapabilityProjectDetail {
  const project = capabilityProjectProjection(detail.capability, detail.versions);
  const revisions = detail.versions.map((version) => ({
    id: version.id,
    projectId: version.capabilityId,
    number: version.version,
    status: version.status === "draft" ? "building" : version.status,
    stage: version.status === "awaiting-review" ? "validate" : version.status === "published" ? "publish" : "author",
    implementation: version.implementation,
    validation: version.validation,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
  })) as CapabilityProjectDetail["revisions"];
  const activeRevision = revisions.find((item) => item.id === detail.capability.currentVersionId);
  const workingRevision = revisions.find((item) => item.id === detail.capability.latestVersionId && item.id !== detail.capability.currentVersionId);
  return {
    project,
    deletion: { allowed: false, blockers: [], counts: {} as CapabilityProjectDetail["deletion"]["counts"] },
    revisions,
    activeRevision,
    workingRevision,
    reviews: detail.tasks.flatMap((task) => task.review ? [{
      id: `${task.id}:review`,
      siteAgentId: task.siteAgentId,
      projectId: task.capabilityId || detail.capability.id,
      revisionId: task.capabilityVersionId || detail.capability.latestVersionId || detail.capability.id,
      validationRunId: String(task.evidence.validationRunId || task.id),
      validatedContentHash: String(task.evidence.validatedContentHash || task.capabilityVersionId),
      status: task.review.status === "pending" ? "awaiting-review" : task.review.status,
      reviewer: task.review.reviewer || "administrator",
      feedback: task.review.feedback,
      createdAt: task.createdAt,
    }] : []) as CapabilityProjectDetail["reviews"],
    events: [],
    capabilityRuns: [],
    browserRuns: [],
    artifacts: [],
    validationJobs: [],
    modelCalls: [],
  };
}

export const capabilityCenterApi = {
  getSettings(siteAgentId: string) {
    return json<{ settings: { autoApproval: { enabled: boolean; prompt: string } } }>(`/api/site-agents/${encodeURIComponent(siteAgentId)}/capability-center/settings`);
  },

  updateAutoApproval(siteAgentId: string, input: { enabled: boolean; prompt: string }) {
    return json<JsonRecord>(`/api/site-agents/${encodeURIComponent(siteAgentId)}/capability-center/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoApproval: input }),
    });
  },

  async catalog(siteAgentId: string) {
    const base = `/api/site-agents/${encodeURIComponent(siteAgentId)}/capability-center`;
    const [capabilitiesPayload, tasksPayload, proposalsPayload, signalsPayload] = await Promise.all([
      json<unknown>(`${base}/capabilities`),
      json<unknown>(`${base}/tasks?includeArchived=1`),
      json<unknown>(`${base}/proposals?includeArchived=1`),
      json<unknown>(`${base}/signals`),
    ]);
    const capabilities = listFrom<Capability>(capabilitiesPayload, "capabilities");
    return {
      capabilities,
      projects: capabilities.map((item) => capabilityProjectProjection(item)),
      tasks: listFrom<CapabilityTask>(tasksPayload, "tasks"),
      proposals: listFrom<CapabilityProposal>(proposalsPayload, "proposals"),
      signals: listFrom<CapabilitySignal>(signalsPayload, "signals"),
    };
  },

  async detail(siteAgentId: string, capabilityId: string) {
    const base = `/api/site-agents/${encodeURIComponent(siteAgentId)}/capability-center/capabilities/${encodeURIComponent(capabilityId)}`;
    const [capabilityPayload, versionsPayload] = await Promise.all([
      json<unknown>(base),
      json<unknown>(`${base}/versions`),
    ]);
    const record = capabilityPayload as JsonRecord;
    const capability = (record.capability || record) as Capability;
    const versions = listFrom<CapabilityVersion>(versionsPayload, "versions");
    const tasks = listFrom<CapabilityTask>(record.tasks || [], "tasks");
    const userExecutions = listFrom<CapabilityDetail["userExecutions"][number]>(record.userExecutions || [], "userExecutions");
    const systemValidations = listFrom<CapabilityTask>(record.systemValidations || [], "systemValidations");
    const detail: CapabilityDetail = { capability, versions, tasks, userExecutions, systemValidations };
    return { detail, projection: detailProjection(detail) };
  },

  taskDetail(siteAgentId: string, taskId: string) {
    return json<CapabilityTaskDetail>(`/api/site-agents/${encodeURIComponent(siteAgentId)}/capability-center/tasks/${encodeURIComponent(taskId)}`);
  },

  createProposal(siteAgentId: string, requestedGoal: string, options: { kind?: "new" | "improvement" | "repair"; capabilityId?: string } = {}) {
    return json<JsonRecord>(`/api/site-agents/${encodeURIComponent(siteAgentId)}/capability-center/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestedGoal, title: requestedGoal, description: requestedGoal, kind: options.kind || "new", capabilityId: options.capabilityId, input: {} }),
    });
  },

  capabilityAction(siteAgentId: string, capabilityId: string, action: string, body: JsonRecord = {}) {
    const base = `/api/site-agents/${encodeURIComponent(siteAgentId)}/capability-center/capabilities/${encodeURIComponent(capabilityId)}`;
    if (action === "delete") return json<JsonRecord>(base, { method: "DELETE" });
    return json<JsonRecord>(`${base}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...body }),
    });
  },

  taskAction(siteAgentId: string, taskId: string, action: string, body: JsonRecord = {}) {
    return json<JsonRecord>(`/api/site-agents/${encodeURIComponent(siteAgentId)}/capability-center/tasks/${encodeURIComponent(taskId)}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...body }),
    });
  },

  createTask(siteAgentId: string, body: JsonRecord) {
    return json<JsonRecord>(`/api/site-agents/${encodeURIComponent(siteAgentId)}/capability-center/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  },

  deleteProposal(siteAgentId: string, proposalId: string) {
    return json<JsonRecord>(`/api/site-agents/${encodeURIComponent(siteAgentId)}/capability-center/proposals/${encodeURIComponent(proposalId)}`, { method: "DELETE" });
  },

  forceProposalTask(siteAgentId: string, proposalId: string, reason?: string) {
    return json<JsonRecord>(`/api/site-agents/${encodeURIComponent(siteAgentId)}/capability-center/proposals/${encodeURIComponent(proposalId)}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "force-create-task", reason }),
    });
  },

  archiveProposal(siteAgentId: string, proposalId: string) {
    return json<JsonRecord>(`/api/site-agents/${encodeURIComponent(siteAgentId)}/capability-center/proposals/${encodeURIComponent(proposalId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
  },

  run(siteAgentId: string, capabilityId: string, body: string, idempotencyKey: string) {
    return json<{ run?: CapabilityRun; message?: string }>(`/api/site-agents/${encodeURIComponent(siteAgentId)}/capabilities/${encodeURIComponent(capabilityId)}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body,
    });
  },
};
