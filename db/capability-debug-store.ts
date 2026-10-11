import {
  getCapability,
  getTask,
  getVersion,
  listCapabilities,
  listTaskArtifacts,
  listTaskEventPage,
  listTasks,
  listVersions,
} from "./capability-center-v2-store";
import {
  getAgentRunForAdmin,
  listAgentRunDebugEventsForAdmin,
  listAgentRunEventsForAdmin,
  listAgentRunsForAdmin,
} from "./agent-run-store";
import { getArtifactBinding, getD1Binding } from "./index";
import { getEffectRunDetail } from "./effect-store";
import { getDomReplayChunksForEpisodes, getDomReplayChunksForRun } from "./site-agent-store";
import type {
  AgentRun,
  AgentRunEvent,
  DomReplayChunk,
} from "../lib/site-knowledge/protocol";
import type {
  Capability,
  CapabilityArtifact,
  CapabilityTask,
  CapabilityTaskEvent,
  CapabilityVersion,
  JsonObject,
  JsonValue,
} from "../lib/capability-center-v2/model";
import {
  CAPABILITY_DEBUG_MODULES,
  capabilityIdFromRun,
  debugEventFromTaskEvent,
  debugEventsFromAgentRunEvent,
  firstDebugFailure,
  isCapabilityDebugEvent,
  makeDebugEvent,
  projectDebugEdges,
  projectDebugNodes,
  projectDebugPhases,
  sanitizeDebugText,
  taskTraceId,
  taskTraceKind,
  usageTraceId,
  versionIdFromRun,
  type CapabilityDebugEvent,
  type DebugDataQuality,
  type DebugNodeState,
  type DebugTraceDetail,
  type DebugTraceKind,
  type DebugTraceStatus,
  type DebugTraceSummary,
  type DebugValidationCell,
} from "../lib/capability-center-v2/debug-trace";

const STRUCTURED_RETENTION_MS = 30 * 24 * 60 * 60_000;
const HEAVY_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_ADMIN_RUNS = 500;
const pruneAfterBySite = new Map<string, number>();

type Catalog = {
  tasks: CapabilityTask[];
  tasksById: Map<string, CapabilityTask>;
  capabilities: Capability[];
  capabilitiesById: Map<string, Capability>;
  versions: CapabilityVersion[];
  versionsById: Map<string, CapabilityVersion>;
  runs: AgentRun[];
  generationGroups: Map<string, CapabilityTask[]>;
  debugEventsByTrace: Map<string, CapabilityDebugEvent[]>;
  summaries: DebugTraceSummary[];
};

export type DebugTraceListResult = {
  traces: DebugTraceSummary[];
  nextCursor?: string;
  total: number;
  cursor: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonRecord(value: unknown): JsonObject {
  return record(value) as JsonObject;
}

function jsonArray(value: unknown): JsonValue[] {
  return Array.isArray(value) ? value as JsonValue[] : [];
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function encodeCursor(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): { updatedAt?: string; id?: string } {
  if (!value) return {};
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
      id: typeof parsed.id === "string" ? parsed.id : undefined,
    };
  } catch {
    return {};
  }
}

function terminalTrace(status: DebugTraceStatus) {
  return ["succeeded", "handled", "rejected", "failed", "cancelled"].includes(status);
}

export function debugTraceRootTaskFor(task: CapabilityTask, tasksById: Map<string, CapabilityTask>) {
  let current = task;
  const seen = new Set([task.id]);
  // Only Validation belongs to its generating automation. Discovery, Repair,
  // Rebuild and their explicit reruns are independent Trace roots.
  while (current.type === "Validation" && current.rerunOfTaskId && seen.size < 32 && !seen.has(current.rerunOfTaskId)) {
    const parent = tasksById.get(current.rerunOfTaskId);
    if (!parent) break;
    seen.add(parent.id);
    current = parent;
  }
  return current;
}

function capabilityForTasks(tasks: CapabilityTask[], versionsById: Map<string, CapabilityVersion>, capabilitiesById: Map<string, Capability>) {
  const explicit = tasks.map((task) => task.result?.capabilityId || task.result?.existingCapabilityId).find(Boolean);
  if (explicit) return capabilitiesById.get(explicit);
  const maintenance = tasks.map((task) => task.input.context.__maintenanceCapabilityId).find((value): value is string => typeof value === "string");
  if (maintenance) return capabilitiesById.get(maintenance);
  const version = tasks.map((task) => versionsById.get(task.result?.versionId || task.versionId)).find(Boolean);
  return version ? capabilitiesById.get(version.capabilityId) : undefined;
}

function versionForTasks(tasks: CapabilityTask[], versionsById: Map<string, CapabilityVersion>) {
  return tasks.map((task) => versionsById.get(task.result?.versionId || task.versionId)).find((version) => version?.status === "Published")
    || tasks.map((task) => versionsById.get(task.result?.versionId || task.versionId)).find(Boolean);
}

function statusForTaskGroup(tasks: CapabilityTask[], version?: CapabilityVersion): DebugTraceStatus {
  if (version?.status === "Published") return "succeeded";
  if (version?.review?.ai?.status === "Rejected") return "rejected";
  if (version?.review?.ai?.status === "Error") return "failed";
  const newest = [...tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!newest) return "waiting";
  if (newest.status === "Cancelled" || newest.status === "Deleted") return "cancelled";
  if (newest.status === "Failed") return "failed";
  if (newest.result?.outcome === "Duplicate" || newest.result?.outcome === "NoResult" || newest.result?.outcome === "BusinessRejection") return "handled";
  if (newest.status === "Running") return "running";
  if (newest.status === "Pending" || newest.status === "WaitingInput") return newest.status === "WaitingInput" ? "waiting" : "running";
  return "waiting";
}

function statusForRun(run: AgentRun): DebugTraceStatus {
  if (run.status === "running") return "running";
  if (run.status === "awaiting-page" || run.status === "awaiting-user") return "waiting";
  if (run.status === "cancelled") return "cancelled";
  if (run.status === "failed") return "failed";
  if (["no-result", "business-rejection"].includes(run.outcome?.status || "")) return "handled";
  return "succeeded";
}

function taskGroupSummary(
  root: CapabilityTask,
  tasks: CapabilityTask[],
  versionsById: Map<string, CapabilityVersion>,
  capabilitiesById: Map<string, Capability>,
): DebugTraceSummary {
  const ordered = [...tasks].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const capability = capabilityForTasks(tasks, versionsById, capabilitiesById);
  const version = versionForTasks(tasks, versionsById);
  const status = statusForTaskGroup(tasks, version);
  const failed = ordered.find((task) => task.status === "Failed" && task.error);
  const source = root.sourceAgentRunId || root.input.experience ? "User" as const : version?.source === "Admin" ? "Admin" as const : "System" as const;
  const startedAt = ordered[0]?.createdAt || root.createdAt;
  const updatedAt = [version?.updatedAt, ...ordered.map((task) => task.updatedAt)].filter((value): value is string => Boolean(value)).sort().at(-1) || root.updatedAt;
  const kind = taskTraceKind(root);
  return {
    id: taskTraceId(root, root.id),
    kind,
    title: sanitizeDebugText(capability?.name || root.input.candidateSummary?.name || root.goal, "能力生成"),
    source,
    status,
    userOutcome: root.input.experience?.outcomeSummary ? sanitizeDebugText(root.input.experience.outcomeSummary) : undefined,
    automationOutcome: status === "succeeded" ? "能力已发布" : status === "rejected" ? "AI Review 拒绝" : failed?.error?.message ? sanitizeDebugText(failed.error.message) : undefined,
    startedAt,
    updatedAt,
    durationMs: terminalTrace(status) ? Math.max(0, Date.parse(updatedAt) - Date.parse(startedAt)) : undefined,
    currentModuleId: status === "succeeded" ? "version.publish" : status === "rejected" ? "review.ai" : failed ? failureModuleForTask(failed) : ordered.at(-1)?.type === "Validation" ? "validation.replay" : "runner.dispatch",
    firstFailure: failed?.error ? { moduleId: failureModuleForTask(failed), code: sanitizeDebugText(failed.error.code, "task_failed"), message: sanitizeDebugText(failed.error.message, "任务失败") } : undefined,
    siteId: root.siteId,
    agentRunId: root.sourceAgentRunId || root.input.experience?.agentRunId,
    rootTaskId: root.id,
    capabilityId: capability?.id,
    versionId: version?.id || ordered.map((task) => task.result?.versionId || task.versionId).find(Boolean),
    relatedTraceIds: [],
    dataQuality: "legacy",
  };
}

function runSummary(run: AgentRun, capability: Capability | undefined): DebugTraceSummary {
  const capabilityId = capabilityIdFromRun(run);
  const status = statusForRun(run);
  const failure = status === "failed" ? {
    moduleId: failureModuleForRun(run),
    code: sanitizeDebugText(run.outcome?.code, "agent_run_failed"),
    message: sanitizeDebugText(run.outcome?.summary, "能力运行失败"),
  } : undefined;
  return {
    id: usageTraceId(run, capabilityId),
    kind: "usage",
    title: sanitizeDebugText(capability?.name || run.activityTimeline.find((item) => item.capabilityId === capabilityId)?.capabilityName || run.goal, "能力使用"),
    source: "User",
    status,
    userOutcome: run.outcome?.summary ? sanitizeDebugText(run.outcome.summary) : undefined,
    automationOutcome: status === "succeeded" ? "能力调用成功" : status === "handled" ? "业务可处理结果" : run.outcome?.summary ? sanitizeDebugText(run.outcome.summary) : undefined,
    startedAt: run.createdAt,
    updatedAt: run.updatedAt,
    durationMs: terminalTrace(status) ? Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.createdAt)) : undefined,
    currentModuleId: failure?.moduleId || (terminalTrace(status) ? "effect.project" : "runtime.stage"),
    firstFailure: failure,
    siteId: run.scope.siteAgentId,
    agentRunId: run.id,
    capabilityId,
    versionId: versionIdFromRun(run),
    relatedTraceIds: [],
    dataQuality: run.checkpoint || run.outcome?.evidence ? "partial" : "legacy",
  };
}

function orphanGenerationSummary(events: CapabilityDebugEvent[], runs: AgentRun[]): DebugTraceSummary {
  const ordered = [...events].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  const first = ordered[0];
  const last = ordered.at(-1) || first;
  const failure = firstDebugFailure(ordered);
  const published = ordered.some((event) => event.module.id === "version.publish" && event.lifecycle === "completed");
  const handled = ordered.some((event) => event.lifecycle === "handled") && !failure;
  const correlation = ordered.map((event) => event.correlation).reverse().find(Boolean) || first.correlation;
  const run = runs.find((candidate) => candidate.id === correlation.agentRunId);
  const abstraction = ordered.find((event) => event.module.id === "experience.abstract" && event.io?.output?.value);
  const output = record(abstraction?.io?.output?.value);
  const request = ordered.find((event) => event.module.id === "request.receive" && event.io?.input?.value);
  const input = record(request?.io?.input?.value);
  const status: DebugTraceStatus = failure ? "failed" : published ? "succeeded" : handled ? "handled" : "running";
  return {
    id: first.trace.id,
    kind: first.trace.kind,
    title: sanitizeDebugText(typeof output.name === "string" ? output.name : typeof input.goal === "string" ? input.goal : run?.goal, "能力生成"),
    source: "User",
    status,
    userOutcome: run?.outcome?.summary ? sanitizeDebugText(run.outcome.summary) : undefined,
    automationOutcome: failure?.message ? sanitizeDebugText(failure.message) : handled && last.message ? sanitizeDebugText(last.message) : undefined,
    startedAt: first.occurredAt,
    updatedAt: last.occurredAt,
    durationMs: terminalTrace(status) ? Math.max(0, Date.parse(last.occurredAt) - Date.parse(first.occurredAt)) : undefined,
    currentModuleId: last.module.id,
    firstFailure: failure,
    siteId: first.correlation.siteId,
    agentRunId: correlation.agentRunId,
    rootTaskId: correlation.taskId,
    capabilityId: correlation.capabilityId,
    versionId: correlation.versionId,
    relatedTraceIds: unique([...(first.trace.relatedTraceIds || []), ...(first.trace.parentTraceId ? [first.trace.parentTraceId] : [])]),
    dataQuality: "complete",
  };
}

async function loadCatalog(siteId: string): Promise<Catalog> {
  const [{ tasks }, { capabilities }, { runs }, debugRunPage] = await Promise.all([
    listTasks(siteId, { includeDeleted: true, includeArchived: true }),
    listCapabilities(siteId, { includeDeleted: true }),
    listAgentRunsForAdmin(siteId, { since: new Date(Date.now() - STRUCTURED_RETENTION_MS).toISOString(), limit: MAX_ADMIN_RUNS }),
    listAgentRunDebugEventsForAdmin(siteId, { since: new Date(Date.now() - STRUCTURED_RETENTION_MS).toISOString(), limit: 5_000 }),
  ]);
  const versionPages = await Promise.all(capabilities.map((capability) => listVersions(siteId, capability.id, true)));
  const versions = versionPages.flatMap((page) => page.versions);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const capabilitiesById = new Map(capabilities.map((capability) => [capability.id, capability]));
  const versionsById = new Map(versions.map((version) => [version.id, version]));
  const generationGroups = new Map<string, CapabilityTask[]>();
  for (const task of tasks) {
    const root = debugTraceRootTaskFor(task, tasksById);
    generationGroups.set(root.id, [...(generationGroups.get(root.id) || []), task]);
  }
  const debugEventsByTrace = new Map<string, CapabilityDebugEvent[]>();
  for (const record of debugRunPage.records) for (const event of record.debugEvents) debugEventsByTrace.set(event.trace.id, [...(debugEventsByTrace.get(event.trace.id) || []), event]);
  const generationSummaries = [...generationGroups.entries()].map(([rootId, grouped]) => {
    const summary = taskGroupSummary(tasksById.get(rootId) || grouped[0], grouped, versionsById, capabilitiesById);
    if (debugEventsByTrace.has(summary.id)) summary.dataQuality = "partial";
    return summary;
  });
  const existingGenerationIds = new Set(generationSummaries.map((summary) => summary.id));
  const orphanSummaries = [...debugEventsByTrace.values()]
    .filter((events) => events[0] && events[0].trace.kind !== "usage" && !existingGenerationIds.has(events[0].trace.id))
    .map((events) => orphanGenerationSummary(events, runs));
  const usageSummaries = runs
    .filter((run) => Boolean(capabilityIdFromRun(run)))
    .map((run) => runSummary(run, capabilitiesById.get(capabilityIdFromRun(run) || "")));
  const summaries = [...generationSummaries, ...orphanSummaries, ...usageSummaries];
  const byCapability = new Map<string, DebugTraceSummary[]>();
  for (const summary of summaries) {
    if (!summary.capabilityId) continue;
    byCapability.set(summary.capabilityId, [...(byCapability.get(summary.capabilityId) || []), summary]);
  }
  for (const summary of summaries) {
    const sameCapability = summary.capabilityId ? byCapability.get(summary.capabilityId) || [] : [];
    const explicitParent = summary.kind === "evolution" && summary.agentRunId
      ? usageSummaries.find((candidate) => candidate.agentRunId === summary.agentRunId)?.id
      : undefined;
    summary.relatedTraceIds = unique([
      ...(explicitParent ? [explicitParent] : []),
      ...sameCapability.filter((candidate) => candidate.id !== summary.id).map((candidate) => candidate.id),
    ]).slice(0, 30);
  }
  return { tasks, tasksById, capabilities, capabilitiesById, versions, versionsById, runs, generationGroups, debugEventsByTrace, summaries };
}

export async function listCapabilityDebugTraces(siteId: string, options: {
  kind?: DebugTraceKind;
  group?: "generation" | "usage";
  status?: DebugTraceStatus;
  query?: string;
  cursor?: string;
  limit?: number;
} = {}): Promise<DebugTraceListResult> {
  const catalog = await loadCatalog(siteId);
  const query = options.query?.trim().toLocaleLowerCase("zh-CN") || "";
  const decoded = decodeCursor(options.cursor);
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit || 40)));
  const filtered = catalog.summaries
    .filter((trace) => !options.kind || trace.kind === options.kind)
    .filter((trace) => !options.group || (options.group === "usage" ? trace.kind === "usage" : trace.kind !== "usage"))
    .filter((trace) => !options.status || trace.status === options.status)
    .filter((trace) => !query || [trace.title, trace.id, trace.capabilityId, trace.versionId, trace.firstFailure?.code, trace.firstFailure?.message].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN").includes(query))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
  const matches = filtered
    .filter((trace) => !decoded.updatedAt || trace.updatedAt < decoded.updatedAt || (trace.updatedAt === decoded.updatedAt && trace.id < (decoded.id || "")));
  const traces = matches.slice(0, limit);
  const last = traces.at(-1);
  const nextCursor = matches.length > limit && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : undefined;
  return {
    traces,
    nextCursor,
    total: filtered.length,
    cursor: encodeCursor({ updatedAt: catalog.summaries.map((trace) => trace.updatedAt).sort().at(-1) || "", count: catalog.summaries.length }),
  };
}

async function allTaskEvents(siteId: string, taskId: string) {
  const collected: CapabilityTaskEvent[] = [];
  let after = 0;
  for (let page = 0; page < 100; page += 1) {
    const result = await listTaskEventPage(siteId, taskId, after, 1_000);
    collected.push(...result.events);
    if (!result.hasMore || !result.events.length) break;
    after = result.events.at(-1)?.sequence || after;
  }
  return collected;
}

async function allAgentRunEvents(siteId: string, runId: string) {
  const collected: AgentRunEvent[] = [];
  let after = 0;
  for (let page = 0; page < 100; page += 1) {
    const result = await listAgentRunEventsForAdmin(siteId, runId, { after, limit: 1_000 });
    collected.push(...result.events);
    if (!result.hasMore || !result.events.length) break;
    after = result.events.at(-1)?.sequence || after;
  }
  return collected;
}

function failureModuleForTask(task: CapabilityTask) {
  const step = `${task.error?.stepId || ""} ${task.error?.code || ""} ${task.error?.message || ""}`.toLocaleLowerCase();
  if (task.type === "Validation") return step.includes("judge") || step.includes("evaluat") || /(?:^|\s)(?:success_|output_schema|capability_result)/u.test(step) ? "validation.judge" : "validation.replay";
  if (step.includes("preflight")) return "runner.preflight";
  if (step.includes("auth")) return "browser.authenticate";
  if (step.includes("module")) return "module.persist";
  if (step.includes("quality")) return "quality.gate";
  if (step.includes("contract")) return "contract.design";
  if (step.includes("author") || step.includes("program")) return "program.author";
  if (step.includes("replay")) return "draft.replay";
  return "browser.explore";
}

function failureModuleForRun(run: AgentRun) {
  const evidence = record(run.outcome?.evidence);
  const error = `${run.outcome?.code || ""} ${evidence.technicalError || ""}`.toLocaleLowerCase();
  if (error.includes("module_unavailable") || error.includes("http_")) return "runtime.fetch";
  if (error.includes("integrity") || error.includes("manifest") || error.includes("import")) return "runtime.integrity";
  if (error.includes("input") || error.includes("schema")) return "runtime.input";
  if (error.includes("precondition") || error.includes("navigation_origin")) return "runtime.preconditions";
  if (error.includes("output") || error.includes("success_") || error.includes("unverified")) return "runtime.output";
  return "runtime.stage";
}

function eventId(traceId: string, moduleId: string, suffix = "") {
  return `inferred:${traceId}:${moduleId}${suffix ? `:${suffix}` : ""}`;
}

function inferredEvent(input: Parameters<typeof makeDebugEvent>[0]) {
  return makeDebugEvent({ ...input, eventId: input.eventId || eventId(input.traceId, input.moduleId) });
}

function appendIfMissing(events: CapabilityDebugEvent[], event: CapabilityDebugEvent, dynamicKey?: (candidate: CapabilityDebugEvent) => boolean) {
  if (events.some(dynamicKey || ((candidate) => candidate.module.id === event.module.id))) return;
  events.push(event);
}

function embeddedEvents(event: AgentRunEvent | CapabilityTaskEvent) {
  const single = event.payload.debugEvent;
  const many = event.payload.debugEvents;
  if (isCapabilityDebugEvent(single)) return [single];
  return Array.isArray(many) ? many.filter(isCapabilityDebugEvent) : [];
}

function normalizedTaskEvents(tasks: CapabilityTask[], root: CapabilityTask, byTask: Map<string, CapabilityTaskEvent[]>) {
  const events: CapabilityDebugEvent[] = [];
  for (const task of tasks) {
    for (const event of byTask.get(task.id) || []) {
      const embedded = embeddedEvents(event);
      events.push(...(embedded.length ? embedded : [debugEventFromTaskEvent(task, event, root.id)]));
    }
  }
  return events;
}

function generationSnapshotEvents(summary: DebugTraceSummary, root: CapabilityTask, tasks: CapabilityTask[], version?: CapabilityVersion, capability?: Capability) {
  const events: CapabilityDebugEvent[] = [];
  const moduleV2 = root.input.context.__pipelineVersion === "2.0";
  const base = { traceId: summary.id, traceKind: summary.kind, siteId: summary.siteId, correlation: { taskId: root.id, agentRunId: summary.agentRunId, episodeId: root.input.experience?.episodeId, capabilityId: summary.capabilityId, versionId: summary.versionId } } as const;
  appendIfMissing(events, inferredEvent({ ...base, moduleId: "request.receive", lifecycle: "completed", occurredAt: root.createdAt, input: { goal: root.goal, source: summary.source }, output: { accepted: true, agentRunId: summary.agentRunId } }));
  if (root.input.experience) {
    appendIfMissing(events, inferredEvent({ ...base, moduleId: "agent-run.authorize", lifecycle: "completed", occurredAt: root.createdAt, input: { siteId: root.siteId, agentRunId: root.input.experience.agentRunId, episodeId: root.input.experience.episodeId, browserSessionId: "[redacted]" }, output: { authorized: true, triggerAuthority: "AgentRun resume token" } }));
    appendIfMissing(events, inferredEvent({ ...base, moduleId: "experience.compact", lifecycle: "completed", occurredAt: root.createdAt, input: { episodeId: root.input.experience.episodeId, outcome: root.input.experience.outcome }, output: { experience: root.input.experience, bytes: JSON.stringify(root.input.experience).length } }));
    appendIfMissing(events, inferredEvent({ ...base, moduleId: "experience.validate", lifecycle: "completed", occurredAt: root.createdAt, input: { sourceAgentRunId: root.sourceAgentRunId, experience: root.input.experience }, output: { accepted: true } }));
  }
  if (root.input.candidateSummary) {
    appendIfMissing(events, inferredEvent({ ...base, moduleId: "experience.abstract", lifecycle: "completed", occurredAt: root.createdAt, input: { experience: root.input.experience ? { episodeId: root.input.experience.episodeId, originalGoal: root.input.experience.originalGoal } : { goal: root.goal } }, output: root.input.candidateSummary }));
    appendIfMissing(events, inferredEvent({ ...base, moduleId: "capability.dedupe", lifecycle: root.result?.outcome === "Duplicate" ? "handled" : "completed", occurredAt: root.updatedAt, input: root.input.candidateSummary, output: { duplicate: root.result?.outcome === "Duplicate", existingCapabilityId: root.result?.existingCapabilityId } }));
  }
  if (moduleV2) appendIfMissing(events, inferredEvent({
    ...base,
    moduleId: "capability.classify",
    lifecycle: "completed",
    occurredAt: root.createdAt,
    input: { capabilityGenerationInput: { source: root.sourceAgentRunId ? "Episode" : "Admin", request: { goal: root.goal, parameters: root.input.parameters, entryUrl: root.input.context.startUrl || "" }, ...(root.input.context.__requirements ? { requirements: root.input.context.__requirements } : {}) } },
    output: { classification: { disposition: "Created", taskId: root.id } },
  }));
  appendIfMissing(events, inferredEvent({
    ...base,
    moduleId: "task.create",
    lifecycle: "completed",
    occurredAt: root.createdAt,
    input: moduleV2
      ? { capabilityGenerationInput: { source: root.sourceAgentRunId ? "Episode" : "Admin", request: { goal: root.goal, parameters: root.input.parameters, entryUrl: root.input.context.startUrl || "" }, ...(root.input.context.__requirements ? { requirements: root.input.context.__requirements } : {}) } }
      : { type: root.type, goal: root.goal, input: { parameters: root.input.parameters, context: root.input.context, trigger: root.input.trigger } },
    output: moduleV2
      ? { generationTask: { id: root.id, siteId: root.siteId, source: root.sourceAgentRunId ? "Episode" : "Admin", type: root.type, status: "Pending", runSpec: root.runSpec } }
      : { taskId: root.id, versionId: root.versionId, status: root.status },
  }));
  if (root.runSpec) {
    appendIfMissing(events, inferredEvent({ ...base, moduleId: "runspec.build", lifecycle: "completed", occurredAt: root.createdAt, input: moduleV2 ? { generationTask: { id: root.id, type: root.type, status: "Pending" } } : { task: { id: root.id, type: root.type }, capability: capability ? { id: capability.id, contract: capability.contract } : undefined, version: version ? { id: version.id, status: version.status } : undefined }, output: { runSpec: root.runSpec } }));
    // Runner emits a preflight/auth progress envelope before it starts the
    // model/browser work. Older task rows only retained that input envelope;
    // reconstruct the bounded, non-sensitive completion output so the Debug
    // I/O ledger does not incorrectly report a successful preflight as having
    // no output.
    appendIfMissing(events, inferredEvent({ ...base, moduleId: "runner.preflight", lifecycle: "completed", occurredAt: root.startedAt || root.createdAt, input: { runSpec: root.runSpec }, output: { valid: true, startUrl: root.runSpec.browser.startUrl } }));
    if (root.status === "Succeeded" || root.result?.outcome === "Success") {
      appendIfMissing(events, inferredEvent({ ...base, moduleId: "browser.authenticate", lifecycle: "completed", occurredAt: root.startedAt || root.createdAt, input: { auth: { configured: Boolean(root.runSpec.input.context.authBootstrap) }, startUrl: root.runSpec.browser.startUrl }, output: { storageStateReady: true } }));
    }
  }
  if (root.result?.candidateSummary) {
    const contract = root.result.candidateSummary.contract || capability?.contract;
    appendIfMissing(events, inferredEvent({
      ...base,
      moduleId: "browser.explore",
      lifecycle: "completed",
      occurredAt: root.finishedAt || root.updatedAt,
      input: { goal: root.goal, parameters: root.result.demonstrationParameters || root.input.parameters, page: { url: root.runSpec?.browser.startUrl } },
      output: {
        actions: [],
        endPage: { url: root.result.output?.pageUrl, title: root.result.output?.pageTitle },
        targetEvidence: root.result.targetEvidence || [],
        scope: contract?.scope,
        inputAliases: contract?.inputAliases,
      },
    }));
  }
  if (root.runnerId) appendIfMissing(events, inferredEvent({ ...base, moduleId: "runner.dispatch", lifecycle: "completed", occurredAt: root.startedAt || root.updatedAt, input: { taskId: root.id, runSpecId: root.runSpec?.id }, output: { runnerId: root.runnerId, lease: { status: root.status } } }));
  if (root.result?.candidateSummary) appendIfMissing(events, inferredEvent({ ...base, moduleId: "contract.design", lifecycle: "completed", occurredAt: root.finishedAt || root.updatedAt, input: { goal: root.goal }, output: { contract: root.result.candidateSummary.contract } }));
  if (root.result?.candidateProgram) {
    appendIfMissing(events, inferredEvent({ ...base, moduleId: "program.author", lifecycle: "completed", occurredAt: root.finishedAt || root.updatedAt, input: { contract: capability?.contract }, output: { program: root.result.candidateProgram, promptProvenance: root.result.promptProvenance } }));
    appendIfMissing(events, inferredEvent({ ...base, moduleId: "module.persist", lifecycle: "completed", occurredAt: root.finishedAt || root.updatedAt, input: { moduleUrl: root.result.candidateProgram.module.moduleUrl }, output: root.result.candidateProgram.module }));
  }
  if (root.result?.stageReceipts) appendIfMissing(events, inferredEvent({ ...base, moduleId: "draft.replay", lifecycle: root.status === "Failed" ? "failed" : "completed", occurredAt: root.finishedAt || root.updatedAt, input: { program: root.result.candidateProgram, demonstrationParameters: root.result.demonstrationParameters }, output: { stageReceipts: root.result.stageReceipts, output: root.result.output }, error: root.status === "Failed" && root.error ? { ...root.error } : undefined }));
  if (root.result?.candidateProgram && root.status === "Succeeded") appendIfMissing(events, inferredEvent({ ...base, moduleId: "quality.gate", lifecycle: "completed", occurredAt: root.finishedAt || root.updatedAt, input: { contract: capability?.contract, program: root.result.candidateProgram }, output: { valid: true, issues: [] } }));
  if (moduleV2 && root.result?.c2CaseGenerationOutput) appendIfMissing(events, inferredEvent({
    ...base,
    moduleId: "case.generate-compile",
    lifecycle: "completed",
    occurredAt: root.finishedAt || root.updatedAt,
    input: { c2CaseGenerationInput: { candidate: root.result.c2CaseGenerationOutput.candidate } },
    output: { c2CaseGenerationOutput: root.result.c2CaseGenerationOutput, caseDiscoveryEvidenceRef: root.result.c2CaseGenerationOutput.caseDiscoveryEvidenceRef, validationSuiteHash: root.result.c2CaseGenerationOutput.validationSuiteHash },
  }));
  if (moduleV2 && root.result?.candidateArtifact) appendIfMissing(events, inferredEvent({
    ...base,
    moduleId: "case.generate-compile",
    lifecycle: "completed",
    occurredAt: root.finishedAt || root.updatedAt,
    input: { c2CaseGenerationOutput: root.result.c2CaseGenerationOutput },
    output: { candidateArtifact: root.result.candidateArtifact, validationTaskId: root.result.validationTaskId },
  }));
  if (!moduleV2 && (root.result?.capabilityId || root.result?.existingCapabilityId)) appendIfMissing(events, inferredEvent({ ...base, moduleId: "capability.materialize", lifecycle: root.result.outcome === "Duplicate" ? "handled" : "completed", occurredAt: root.finishedAt || root.updatedAt, input: { candidateSummary: root.result.candidateSummary, candidateProgram: root.result.candidateProgram }, output: { capabilityId: root.result.capabilityId || root.result.existingCapabilityId, versionId: root.result.versionId, status: version?.status } }));
  for (const task of tasks.filter((candidate) => candidate.type === "Validation")) {
    const validationBase = { ...base, correlation: { ...base.correlation, taskId: task.id, versionId: task.versionId } };
    const candidateValidation = task.input.context.__candidateValidation === true;
    const candidateArtifact = root.result?.candidateArtifact || task.result?.candidateArtifact;
    const candidateCases = candidateArtifact?.validationSuite?.cases || [];
    appendIfMissing(events, inferredEvent({
      ...validationBase,
      eventId: eventId(summary.id, "validation.create", task.id),
      moduleId: "validation.create",
      lifecycle: "completed",
      occurredAt: task.createdAt,
      input: candidateValidation ? { candidateArtifact } : { versionId: task.versionId, validationCases: task.input.context.validationCases },
      output: candidateValidation ? { candidateValidationTask: { id: task.id, siteId: task.siteId, type: task.type, status: task.status, runSpec: task.runSpec?.candidateValidation } } : { taskId: task.id, status: task.status },
    }));
    const cases = candidateCases.length
      ? candidateCases.map((testCase) => testCase.input)
      : Array.isArray(task.input.context.validationCases) && task.input.context.validationCases.length ? task.input.context.validationCases : [task.input.parameters];
    cases.forEach((validationCase, index) => {
      const caseId = `case-${index + 1}`;
      const failed = task.status === "Failed" && index === Math.max(0, cases.length - 1);
      const validationResult = task.result?.validationResults?.find((item) => item.caseId === caseId || item.caseId === `case_${index + 1}`);
      events.push(inferredEvent({ ...validationBase, eventId: eventId(summary.id, "validation.replay", `${task.id}:${caseId}`), moduleId: "validation.replay", lifecycle: failed ? "failed" : task.status === "Succeeded" ? "completed" : "progress", occurredAt: task.finishedAt || task.updatedAt, correlation: { ...validationBase.correlation, validationCaseId: caseId }, input: { case: validationCase, program: candidateArtifact?.candidate.program || version?.program }, output: candidateValidation ? { outcome: failed ? task.error?.code : validationResult ? "Validated" : task.result?.outcome, stageReceipts: validationResult?.stageReceipts || [], evidence: validationResult?.evidenceRefs || [] } : { outcome: failed ? task.error?.code : task.result?.outcome, stageReceipts: task.result?.stageReceipts, evidence: task.result?.targetEvidence }, error: failed && task.error ? { ...task.error } : undefined }));
    });
    if (task.result || task.error) appendIfMissing(events, inferredEvent({ ...validationBase, eventId: eventId(summary.id, "validation.judge", task.id), moduleId: "validation.judge", lifecycle: task.status === "Succeeded" ? "completed" : task.status === "Failed" ? "failed" : "progress", occurredAt: task.finishedAt || task.updatedAt, input: candidateValidation ? { candidateValidationTask: { id: task.id, runSpec: task.runSpec?.candidateValidation }, caseResults: task.result?.validationResults || [], contractHash: task.runSpec?.candidateValidation?.contractHash, programHash: task.runSpec?.candidateValidation?.programHash } : { conditions: capability?.contract.successConditions, output: task.result?.output }, output: candidateValidation ? { buildResult: task.result?.buildResult, validationResults: task.result?.validationResults || [] } : { status: task.status, reason: task.error?.message }, error: task.status === "Failed" && task.error ? { ...task.error } : undefined }));
  }
  if (!moduleV2 && version?.review?.ai) appendIfMissing(events, inferredEvent({ ...base, moduleId: "review.ai", lifecycle: version.review.ai.status === "Rejected" ? "handled" : version.review.ai.status === "Error" ? "failed" : version.review.ai.status === "Approved" ? "completed" : "progress", occurredAt: version.review.ai.reviewedAt || version.updatedAt, input: { capability: capability ? { id: capability.id, contract: capability.contract } : undefined, version: { id: version.id, program: version.program } }, output: { decision: version.review.ai.status, reason: version.review.ai.reason, model: version.review.ai.model }, error: version.review.ai.status === "Error" ? { code: "ai_review_error", message: version.review.ai.error || version.review.ai.reason || "AI Review failed", retryable: true } : undefined }));
  if (!moduleV2 && version?.status === "Published") appendIfMissing(events, inferredEvent({ ...base, moduleId: "version.publish", lifecycle: "completed", occurredAt: version.publishedAt || version.updatedAt, input: { versionId: version.id, review: version.review }, output: { capabilityId: version.capabilityId, currentVersionId: version.id, status: version.status } }));
  const failed = [...tasks].sort((left, right) => (left.finishedAt || left.updatedAt).localeCompare(right.finishedAt || right.updatedAt)).find((task) => task.status === "Failed" && task.error);
  if (failed) {
    const moduleId = failureModuleForTask(failed);
    if (!events.some((event) => event.module.id === moduleId && event.lifecycle === "failed")) events.push(inferredEvent({ ...base, eventId: eventId(summary.id, moduleId, failed.id), moduleId, lifecycle: "failed", occurredAt: failed.finishedAt || failed.updatedAt, correlation: { ...base.correlation, taskId: failed.id }, message: failed.error?.message, error: failed.error ? { ...failed.error } : undefined }));
  }
  return events;
}

function runtimeSnapshot(run: AgentRun) {
  const adaptive = record(run.checkpoint?.adaptiveState);
  const runtime = record(adaptive.v2Runtime);
  const evidence = record(run.outcome?.evidence);
  const receipts = Array.isArray(evidence.stageReceipts) ? evidence.stageReceipts : Array.isArray(adaptive.v2StageReceipts) ? adaptive.v2StageReceipts : [];
  const stageEvidence = Array.isArray(evidence.stageEvidence) ? evidence.stageEvidence : Array.isArray(adaptive.v2StageEvidence) ? adaptive.v2StageEvidence : [];
  return { adaptive, runtime, evidence, receipts: receipts.map(record), stageEvidence };
}

function usageSnapshotEvents(
  summary: DebugTraceSummary,
  run: AgentRun,
  effect: Awaited<ReturnType<typeof getEffectRunDetail>>,
  capability?: Capability,
  version?: CapabilityVersion,
) {
  const snapshot = runtimeSnapshot(run);
  const runtime = Object.keys(snapshot.runtime).length ? snapshot.runtime : {
    capabilityId: summary.capabilityId,
    versionId: summary.versionId,
    contract: capability?.contract,
    program: version?.program,
  };
  const { evidence, receipts, stageEvidence } = snapshot;
  const events: CapabilityDebugEvent[] = [];
  const base = { traceId: summary.id, traceKind: "usage" as const, siteId: summary.siteId, correlation: { agentRunId: run.id, capabilityId: summary.capabilityId, versionId: summary.versionId, pageEpoch: run.pageEpoch } };
  appendIfMissing(events, inferredEvent({ ...base, moduleId: "request.receive", lifecycle: "completed", occurredAt: run.createdAt, input: { goal: run.goal, input: run.input, conversation: run.conversation.map((turn) => ({ role: turn.role, at: turn.at })) }, output: { agentRunId: run.id, accepted: true } }));
  const search = run.activityTimeline.filter((item) => item.kind === "capability-search");
  appendIfMissing(events, inferredEvent({ ...base, moduleId: "capability.search", lifecycle: "completed", occurredAt: search[0]?.createdAt || run.createdAt, input: { queries: [run.goal] }, output: { capabilityId: summary.capabilityId, versionId: summary.versionId, candidates: search.map((item) => item.output || {}) } }));
  const progressedToStage = receipts.length > 0 || Boolean(run.output && Object.keys(run.output).length);
  if (Object.keys(runtime).length || summary.versionId) appendIfMissing(events, inferredEvent({ ...base, moduleId: "runtime.fetch", lifecycle: "completed", occurredAt: run.checkpoint?.savedAt || run.updatedAt, input: { capabilityId: summary.capabilityId }, output: { contract: runtime.contract, program: runtime.program, versionId: runtime.versionId || summary.versionId } }));
  if (progressedToStage) {
    const program = record(runtime.program);
    const moduleRef = record(program.module);
    appendIfMissing(events, inferredEvent({ ...base, moduleId: "runtime.integrity", lifecycle: "completed", occurredAt: run.checkpoint?.savedAt || run.updatedAt, input: { moduleUrl: moduleRef.moduleUrl, expectedHash: moduleRef.contentHash, manifest: program.stages }, output: { actualHash: moduleRef.contentHash, valid: true } }));
    appendIfMissing(events, inferredEvent({ ...base, moduleId: "runtime.input", lifecycle: "completed", occurredAt: run.createdAt, input: { schema: record(runtime.contract).inputSchema, value: run.input }, output: { valid: true, missing: [] } }));
    appendIfMissing(events, inferredEvent({ ...base, moduleId: "runtime.preconditions", lifecycle: "completed", occurredAt: run.createdAt, input: { entry: program.entry, conditions: record(runtime.contract).preconditions }, output: { valid: true, pageEpoch: run.pageEpoch } }));
  }
  receipts.forEach((receipt, index) => {
    const stageId = typeof receipt.stageId === "string" ? receipt.stageId : `stage-${index + 1}`;
    const completed = receipt.status === "Completed";
    events.push(inferredEvent({
      ...base,
      eventId: eventId(summary.id, "runtime.stage", `${stageId}:${index}`),
      moduleId: "runtime.stage",
      lifecycle: completed ? "completed" : "started",
      occurredAt: typeof receipt.completedAt === "string" ? receipt.completedAt : run.checkpoint?.savedAt || run.updatedAt,
      correlation: { ...base.correlation, stageId },
      input: { stage: { id: stageId, index: receipt.stageIndex }, input: run.input, urlBefore: receipt.urlBefore },
      output: completed ? { outcome: receipt.outcome, output: run.output, evidence: receipt.evidence, urlAfter: receipt.urlAfter } : undefined,
      evidence: { urlBefore: typeof receipt.urlBefore === "string" ? receipt.urlBefore : undefined, urlAfter: typeof receipt.urlAfter === "string" ? receipt.urlAfter : undefined, replayRunId: run.id },
    }));
  });
  if (run.status === "awaiting-page") appendIfMissing(events, inferredEvent({ ...base, moduleId: "runtime.handoff", lifecycle: "progress", occurredAt: run.updatedAt, input: { pageEpoch: run.pageEpoch, cursor: run.programCursor }, output: { resumed: false, pageEpoch: run.pageEpoch } }));
  if (run.outcome && run.status !== "running" && run.status !== "awaiting-page" && run.status !== "awaiting-user") appendIfMissing(events, inferredEvent({ ...base, moduleId: "runtime.output", lifecycle: run.status === "failed" && failureModuleForRun(run) === "runtime.output" ? "failed" : "completed", occurredAt: run.outcome.evaluatedAt || run.updatedAt, input: { schema: record(runtime.contract).outputSchema, output: run.output, conditions: record(runtime.contract).successConditions }, output: { valid: run.status !== "failed", outcome: run.outcome.status, stageEvidence }, error: run.status === "failed" && failureModuleForRun(run) === "runtime.output" ? { code: run.outcome.code, message: run.outcome.summary, retryable: false } : undefined }));
  if (terminalTrace(summary.status)) appendIfMissing(events, inferredEvent({ ...base, moduleId: "run.finish", lifecycle: run.status === "failed" ? "failed" : "completed", occurredAt: run.updatedAt, input: { outcome: run.outcome, output: run.output }, output: { status: run.status, persisted: true }, error: run.status === "failed" ? { code: run.outcome?.code || "agent_run_failed", message: run.outcome?.summary || "AgentRun failed", retryable: false } : undefined }));
  if (run.status === "failed") {
    const moduleId = failureModuleForRun(run);
    if (!events.some((event) => event.module.id === moduleId && event.lifecycle === "failed")) events.push(inferredEvent({ ...base, eventId: eventId(summary.id, moduleId, "failure"), moduleId, lifecycle: "failed", occurredAt: run.outcome?.evaluatedAt || run.updatedAt, input: moduleId === "runtime.stage" ? { input: run.input, stageId: evidence.stepId } : { capabilityId: summary.capabilityId }, output: { receipts, evidence: stageEvidence }, error: { code: run.outcome?.code || "capability_runtime_failed", message: run.outcome?.summary || String(evidence.technicalError || "能力运行失败"), retryable: false, sideEffectStarted: evidence.sideEffectStarted === true }, correlation: { ...base.correlation, stageId: typeof evidence.stepId === "string" ? evidence.stepId : undefined } }));
  }
  if (effect) appendIfMissing(events, inferredEvent({ ...base, moduleId: "effect.project", lifecycle: "completed", occurredAt: run.updatedAt, input: { agentRun: { id: run.id, status: run.status }, receipts: effect.receipts }, output: { fact: effect.fact, activityCount: effect.activityTimeline.length, replayChunkCount: effect.replayChunks.length } }));
  return events;
}

function markInferred(nodes: ReturnType<typeof projectDebugNodes>) {
  return nodes.map((node) => {
    if (!node.eventIds.length || node.eventIds.some((id) => !id.startsWith("inferred:"))) return node;
    return { ...node, observed: false, dataQuality: "legacy" as const };
  });
}

function dataQualityFor(nodes: ReturnType<typeof projectDebugNodes>, replayExpected: boolean, replayChunks: DomReplayChunk[]): DebugDataQuality {
  if (replayExpected && !replayChunks.length) return "retention-limited";
  const observed = nodes.filter((node) => node.observed).length;
  if (!observed) return "legacy";
  if (nodes.some((node) => !node.observed || node.state === "unavailable")) return "partial";
  return "complete";
}

function relatedFor(summary: DebugTraceSummary, catalog: Catalog) {
  const wanted = new Set(summary.relatedTraceIds);
  return catalog.summaries.filter((candidate) => wanted.has(candidate.id));
}

export function projectValidationMatrix(
  tasks: CapabilityTask[],
  version?: CapabilityVersion,
  eventsByTask: Map<string, CapabilityTaskEvent[]> = new Map(),
): DebugTraceDetail["validationMatrix"] {
  const validation = [...tasks].filter((task) => task.type === "Validation").sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!validation) return { cases: [], stages: [], cells: [] };
  const rawCases = Array.isArray(validation.input.context.validationCases) && validation.input.context.validationCases.length ? validation.input.context.validationCases : [validation.input.parameters];
  const cases = rawCases.map((input, index) => ({ id: `case-${index + 1}`, label: `Case ${index + 1}`, input }));
  const stages = (version?.program.stages || []).map((stage) => ({ id: stage.id, label: stage.title }));
  const cells = new Map<string, DebugValidationCell>();
  const key = (caseIndex: number, stageId: string) => `${caseIndex}:${stageId}`;
  const defaultState: DebugNodeState = validation.status === "Succeeded"
    ? "succeeded"
    : validation.status === "Cancelled" || validation.status === "Deleted"
      ? "skipped"
      : "pending";
  cases.forEach((validationCase, caseIndex) => stages.forEach((stage) => {
    cells.set(key(caseIndex, stage.id), { caseId: validationCase.id, stageId: stage.id, state: defaultState });
  }));
  const setCell = (caseIndex: number, stageId: string, patch: Partial<DebugValidationCell>) => {
    const current = cells.get(key(caseIndex, stageId));
    if (current) cells.set(key(caseIndex, stageId), { ...current, ...patch });
  };
  const markCase = (caseIndex: number, state: DebugNodeState) => stages.forEach((stage) => setCell(caseIndex, stage.id, { state }));

  let activeCase = 0;
  const passedCases = new Set<number>();
  for (const event of eventsByTask.get(validation.id) || []) {
    const nested = record(event.payload.payload);
    const rawIndex = typeof nested.caseIndex === "number" ? nested.caseIndex - 1 : undefined;
    if (rawIndex === undefined || rawIndex < 0 || rawIndex >= cases.length) continue;
    activeCase = Math.max(activeCase, rawIndex);
    const message = typeof event.payload.message === "string" ? event.payload.message : "";
    if (/已通过|passed/iu.test(message)) passedCases.add(rawIndex);
  }
  passedCases.forEach((caseIndex) => markCase(caseIndex, "succeeded"));

  let receiptCase = 0;
  for (const receipt of validation.result?.stageReceipts || []) {
    if (receiptCase >= cases.length || !stages.some((stage) => stage.id === receipt.stageId)) continue;
    const terminal = receipt.status === "Completed" && receipt.outcome !== "Continue";
    const state: DebugNodeState = receipt.status === "Started"
      ? "running"
      : receipt.outcome === "NoResult" || receipt.outcome === "Ambiguous" || receipt.outcome === "BusinessRejection"
        ? "handled"
        : "succeeded";
    const existing = cells.get(key(receiptCase, receipt.stageId));
    if (existing?.state !== "succeeded" || state !== "running") setCell(receiptCase, receipt.stageId, { state, durationMs: receipt.durationMs });
    if (terminal) receiptCase += 1;
  }

  if (validation.status === "Failed") {
    activeCase = Math.min(cases.length - 1, Math.max(activeCase, receiptCase, passedCases.size));
    for (let index = 0; index < activeCase; index += 1) markCase(index, "succeeded");
    if (failureModuleForTask(validation) === "validation.judge") {
      markCase(activeCase, "succeeded");
    } else {
      const clue = `${validation.error?.stepId || ""} ${validation.error?.code || ""} ${validation.error?.message || ""}`;
      const failedStageIndex = stages.findIndex((stage) => clue.includes(stage.id));
      if (failedStageIndex >= 0) {
        stages.forEach((stage, stageIndex) => setCell(activeCase, stage.id, { state: stageIndex < failedStageIndex ? "succeeded" : stageIndex === failedStageIndex ? "failed" : "pending" }));
      } else {
        // The task tells us which Case failed but older receipts cannot always
        // identify the exact Stage. Do not invent a red cell on the last Stage.
        stages.forEach((stage) => {
          const current = cells.get(key(activeCase, stage.id));
          if (current && current.state !== "succeeded" && current.state !== "handled") setCell(activeCase, stage.id, { state: "unavailable" });
        });
      }
    }
  }
  return { cases, stages, cells: [...cells.values()] };
}

function dedupeReplay(chunks: DomReplayChunk[]) {
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  return [...byId.values()].sort((left, right) => left.seqStart - right.seqStart);
}

async function generationDetail(summary: DebugTraceSummary, catalog: Catalog): Promise<DebugTraceDetail | undefined> {
  const root = summary.rootTaskId ? catalog.tasksById.get(summary.rootTaskId) : undefined;
  if (!root) {
    const events = [...(catalog.debugEventsByTrace.get(summary.id) || [])].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    if (!events.length) return undefined;
    const expectedModuleIds = CAPABILITY_DEBUG_MODULES.filter((module) => module.traceKinds.includes(summary.kind)).map((module) => module.id);
    const nodes = projectDebugNodes(events, { expectedModuleIds, terminal: terminalTrace(summary.status), terminalStatus: summary.status });
    const replayChunks = summary.agentRunId ? await getDomReplayChunksForRun(summary.siteId, summary.agentRunId) : [];
    const updatedSummary = { ...summary, firstFailure: firstDebugFailure(events) || summary.firstFailure, dataQuality: dataQualityFor(nodes, false, replayChunks) };
    return {
      summary: updatedSummary,
      phases: projectDebugPhases(nodes),
      nodes,
      edges: projectDebugEdges(nodes),
      events,
      moduleDefinitions: CAPABILITY_DEBUG_MODULES.filter((module) => module.traceKinds.includes(summary.kind)),
      artifacts: [],
      replayChunks,
      validationMatrix: { cases: [], stages: [], cells: [] },
      relatedTraces: relatedFor(summary, catalog),
      cursor: encodeCursor({ updatedAt: updatedSummary.updatedAt, events: events.length, replay: replayChunks.length }),
    };
  }
  const tasks = catalog.generationGroups.get(root.id) || [root];
  const byTask = new Map<string, CapabilityTaskEvent[]>();
  await Promise.all(tasks.map(async (task) => byTask.set(task.id, await allTaskEvents(summary.siteId, task.id))));
  const version = summary.versionId ? catalog.versionsById.get(summary.versionId) || await getVersion(summary.siteId, summary.versionId, true) : versionForTasks(tasks, catalog.versionsById);
  const capability = summary.capabilityId ? catalog.capabilitiesById.get(summary.capabilityId) || await getCapability(summary.siteId, summary.capabilityId, true) : capabilityForTasks(tasks, catalog.versionsById, catalog.capabilitiesById);
  const stored = [...normalizedTaskEvents(tasks, root, byTask), ...(catalog.debugEventsByTrace.get(summary.id) || [])];
  if (summary.agentRunId) {
    const sourceRun = await getAgentRunForAdmin(summary.siteId, summary.agentRunId);
    if (sourceRun) {
      const runEvents = await allAgentRunEvents(summary.siteId, sourceRun.id);
      for (const runEvent of runEvents) stored.push(...embeddedEvents(runEvent).filter((event) => event.trace.id === summary.id || event.trace.kind === summary.kind));
    }
  }
  const inferred = generationSnapshotEvents(summary, root, tasks, version, capability);
  const storedIds = new Set(stored.map((event) => event.eventId));
  const events = [...stored, ...inferred.filter((candidate) => !storedIds.has(candidate.eventId))]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId));
  const expectedModuleIds = CAPABILITY_DEBUG_MODULES.filter((module) => module.traceKinds.includes(summary.kind)).map((module) => module.id);
  const nodes = markInferred(projectDebugNodes(events, { expectedModuleIds, terminal: terminalTrace(summary.status), terminalStatus: summary.status }));
  const artifacts = (await Promise.all(tasks.map((task) => listTaskArtifacts(summary.siteId, task.id)))).flat();
  const episodeIds = unique(tasks.map((task) => task.input.experience?.episodeId).filter((value): value is string => Boolean(value)));
  const replayChunks = dedupeReplay([
    ...(episodeIds.length ? await getDomReplayChunksForEpisodes(summary.siteId, episodeIds) : []),
    ...(summary.agentRunId ? await getDomReplayChunksForRun(summary.siteId, summary.agentRunId) : []),
  ]);
  const failure = firstDebugFailure(events);
  // A task may have recovered from an earlier RunnerLost/lease-expiry event
  // and then fail deterministically on a later retry.  Keep the event-level
  // earliest failure on the corresponding node for audit, but make the trace
  // headline use the terminal task error when one exists; that is the reason
  // an operator can act on now (for example `target_ambiguous`).
  const updatedSummary = { ...summary, firstFailure: summary.firstFailure || failure, dataQuality: dataQualityFor(nodes, Date.now() - Date.parse(summary.updatedAt) > HEAVY_RETENTION_MS, replayChunks) };
  return {
    summary: updatedSummary,
    phases: projectDebugPhases(nodes),
    nodes,
    edges: projectDebugEdges(nodes),
    events,
    moduleDefinitions: CAPABILITY_DEBUG_MODULES.filter((module) => module.traceKinds.includes(summary.kind)),
    artifacts,
    replayChunks,
    validationMatrix: projectValidationMatrix(tasks, version, byTask),
    relatedTraces: relatedFor(summary, catalog),
    cursor: encodeCursor({ updatedAt: updatedSummary.updatedAt, events: events.length, artifacts: artifacts.length, replay: replayChunks.length }),
  };
}

async function usageDetail(summary: DebugTraceSummary, catalog: Catalog): Promise<DebugTraceDetail | undefined> {
  const run = summary.agentRunId ? catalog.runs.find((candidate) => candidate.id === summary.agentRunId) || await getAgentRunForAdmin(summary.siteId, summary.agentRunId) : undefined;
  if (!run) return undefined;
  const [storedRunEvents, effect, directReplay] = await Promise.all([
    allAgentRunEvents(summary.siteId, run.id),
    getEffectRunDetail(summary.siteId, run.id),
    getDomReplayChunksForRun(summary.siteId, run.id),
  ]);
  const stored = storedRunEvents.flatMap((event) => debugEventsFromAgentRunEvent(run, event, summary.id, "usage"));
  const inferred = usageSnapshotEvents(
    summary,
    run,
    effect,
    summary.capabilityId ? catalog.capabilitiesById.get(summary.capabilityId) : undefined,
    summary.versionId ? catalog.versionsById.get(summary.versionId) : undefined,
  );
  const storedIds = new Set(stored.map((event) => event.eventId));
  const events = [...stored, ...inferred.filter((candidate) => !storedIds.has(candidate.eventId))]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId));
  const expectedModuleIds = CAPABILITY_DEBUG_MODULES.filter((module) => module.traceKinds.includes("usage")).map((module) => module.id);
  const nodes = markInferred(projectDebugNodes(events, { expectedModuleIds, terminal: terminalTrace(summary.status), terminalStatus: summary.status }));
  const replayChunks = dedupeReplay([...(effect?.replayChunks || []), ...directReplay]);
  const failure = firstDebugFailure(events);
  const updatedSummary = { ...summary, firstFailure: failure || summary.firstFailure, dataQuality: dataQualityFor(nodes, Date.now() - Date.parse(summary.updatedAt) > HEAVY_RETENTION_MS, replayChunks) };
  return {
    summary: updatedSummary,
    phases: projectDebugPhases(nodes),
    nodes,
    edges: projectDebugEdges(nodes),
    events,
    moduleDefinitions: CAPABILITY_DEBUG_MODULES.filter((module) => module.traceKinds.includes("usage")),
    artifacts: [],
    replayChunks,
    validationMatrix: { cases: [], stages: [], cells: [] },
    relatedTraces: relatedFor(summary, catalog),
    cursor: encodeCursor({ updatedAt: updatedSummary.updatedAt, events: events.length, replay: replayChunks.length, effect: Boolean(effect) }),
  };
}

export async function getCapabilityDebugTrace(siteId: string, kind: DebugTraceKind, traceId: string) {
  const catalog = await loadCatalog(siteId);
  const summary = catalog.summaries.find((candidate) => candidate.id === traceId && candidate.kind === kind);
  if (!summary) return undefined;
  return kind === "usage" ? usageDetail(summary, catalog) : generationDetail(summary, catalog);
}

/**
 * Opportunistic bounded retention. It reuses the existing event, artifact and
 * replay stores and intentionally never creates a scheduler or metadata table.
 */
export async function pruneCapabilityDebugData(siteId: string) {
  const database = getD1Binding();
  if (!database) return { pruned: false, reason: "memory" as const };
  const nextAllowedAt = pruneAfterBySite.get(siteId) || 0;
  if (Date.now() < nextAllowedAt) return { pruned: false, reason: "rate-limited" as const };
  pruneAfterBySite.set(siteId, Date.now() + 60 * 60_000);
  const structuredBefore = new Date(Date.now() - STRUCTURED_RETENTION_MS).toISOString();
  const heavyBefore = new Date(Date.now() - HEAVY_RETENTION_MS).toISOString();
  const successfulFlightBefore = new Date(Date.now() - 60 * 60_000).toISOString();
  const artifactRows = await database.prepare(`SELECT id,storage_key AS storageKey FROM ccv2_artifacts WHERE site_id=? AND kind IN ('Screenshot','Trace','Video','Log') AND created_at<? ORDER BY created_at LIMIT 200`).bind(siteId, heavyBefore).all<{ id: string; storageKey: string }>();
  const artifacts = artifactRows.results || [];
  const binding = getArtifactBinding();
  if (binding) await Promise.all(artifacts.map((artifact) => binding.delete(artifact.storageKey).catch(() => undefined)));
  const statements = [
    database.prepare(`DELETE FROM ccv2_task_events WHERE site_id=? AND created_at<?`).bind(siteId, structuredBefore),
    database.prepare(`DELETE FROM site_agent_v3_run_events WHERE created_at<? AND run_id IN (SELECT id FROM site_agent_v3_agent_runs WHERE site_agent_id=?)`).bind(structuredBefore, siteId),
    database.prepare(`DELETE FROM site_agent_v2_dom_replay_chunks WHERE site_agent_id=? AND created_at<? AND run_id IN (SELECT id FROM site_agent_v3_agent_runs WHERE site_agent_id=? AND status='completed')`).bind(siteId, successfulFlightBefore, siteId),
    database.prepare(`DELETE FROM site_agent_v2_dom_replay_chunks WHERE site_agent_id=? AND created_at<?`).bind(siteId, heavyBefore),
    ...artifacts.map((artifact) => database.prepare(`DELETE FROM ccv2_artifacts WHERE id=? AND site_id=?`).bind(artifact.id, siteId)),
  ];
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "capability_debug_retention_failed");
  return { pruned: true, artifacts: artifacts.length };
}

/**
 * On site deletion this module owns no table — the `ccv2_artifacts` / `ccv2_task_events`
 * / replay chunks it cleans belong to their own stores — it only forgets the site's
 * retention throttle mark, so a site recreated under the same id is not skipped for an hour.
 */
export function deleteMemoryCapabilityDebugData(siteId: string) {
  pruneAfterBySite.delete(siteId);
}
