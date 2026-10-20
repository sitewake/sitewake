"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SiteAgentOverview } from "../lib/site-knowledge/protocol";
import type { Capability, CapabilityArtifact, CapabilityStageManifest, CapabilityTask, CapabilityTaskEvent, CapabilityVersion, JsonValue } from "../lib/capability-center-v2/model";
import { CapabilityExperienceInbox } from "./capability-experience-inbox";
import type { CapabilityExperienceIntake } from "../lib/capability-center-v2/experience-intake";
import { projectProductionStatus, type CapabilityProductionStatus, type ProductionMessageKey } from "../lib/capability-center-v2/production-status";
import "./capability-center-product.css";
import { activeLocale, t, type Locale } from "../lib/i18n";

type Tab = "capabilities" | "tasks" | "intakes";
type SortKey = "updatedAt" | "createdAt";
type MaintenanceMode = "Rebuild" | "Repair";
type MaintenanceDefaults = {
  capabilityId: string;
  baseVersionId: string;
  goal: string;
  guidance?: string;
  parameters: Record<string, JsonValue>;
  startUrl?: string;
  sourceTaskId?: string;
  requiredInputs: string[];
  activeTaskId?: string;
};

const adminBase = "/api/admin/capability-v2";
function headers(siteId: string) { return { "content-type": "application/json", "x-sitewake-site-id": siteId }; }
async function request<T>(siteId: string, path: string, init: RequestInit = {}, base = adminBase) {
  const response = await fetch(`${base}${path}`, { cache: "no-store", ...init, headers: { ...headers(siteId), ...(init.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload.message || payload.error || response.statusText));
  return payload as T;
}
function time(value?: string) { return value ? new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—"; }
/**
 * A failed task leaves a screenshot, a trace, a recording and a log; they were all
 * labelled "execution record", so the user saw four identical download buttons.
 * Name them by kind and append the file type.
 */
export function artifactLabel(artifact: { kind: string; contentType: string }, locale?: Locale) {
  const copy = t(locale).capability.v2.screen;
  if (artifact.contentType.startsWith("application/vnd.sitewake.workspace")) return copy.artifact.workspace;
  const label = copy.artifact[artifact.kind] || copy.artifact.other;
  const extension = artifact.contentType.includes("png") ? "PNG" : artifact.contentType.includes("webm") ? "WebM" : artifact.contentType.includes("json") ? "JSON" : artifact.contentType.includes("zip") ? "ZIP" : "";
  return extension ? copy.artifactWithType(label, extension) : label;
}

function badge(status: string) { return <span className={`ccv2-badge ccv2-${status.toLowerCase()}`}>{t().capability.v2.screen.statuses[status] || status}</span>; }
function humanStage(stage: CapabilityStageManifest) {
  const copy = t().capability.v2;
  return copy.stageLine(
    stage.effect === "write" ? copy.stageWrite : copy.stageRead,
    stage.title,
    stage.purpose || "",
    stage.resumePolicy === "reconcile-before-retry" ? copy.stageReconcile : "",
  );
}
function eventText(event: CapabilityTaskEvent) {
  const phase = typeof event.payload.phase === "string" ? event.payload.phase : event.eventType;
  const message = typeof event.payload.message === "string"
    ? event.payload.message
    : typeof event.payload.reason === "string"
      ? event.payload.reason
      : "";
  return { phase, message };
}
/**
 * The "最近进展" feed: the business-facing phases, newest first, at most six.
 * Once another generation's publication has superseded this one, the review
 * that ran meanwhile is moot: its verdict (either way) changed nothing and,
 * shown under "已发布", reads as a contradiction. The engineering record and
 * the events API keep it; the feed shows the outcome that stands.
 */
export function progressActivity(taskEvents: CapabilityTaskEvent[]) {
  const supersededAt = taskEvents.find((event) => event.eventType === "PublicationSuperseded")?.sequence;
  return taskEvents
    .filter((event) => {
      const item = eventText(event);
      // These are the authoring loop's own notes to itself, not progress a
      // reader acts on; the markers are matched verbatim, not translated.
      if (/model turn|capability.ts written|building the module/.test(item.message)) return false;
      if (!["Exploring", "DraftReplay", "CaseGeneration", "AuthoringRestored", "Validating", "Reviewing", "Published"].includes(item.phase)) return false;
      return !(supersededAt !== undefined && item.phase === "Reviewing" && event.sequence < supersededAt);
    })
    .slice(-6)
    .reverse();
}
function maintenanceOf(task: CapabilityTask) {
  const capabilityId = task.input.context.__maintenanceCapabilityId;
  const mode = task.input.context.__maintenanceMode;
  return typeof capabilityId === "string" && (mode === "Rebuild" || mode === "Repair") ? { capabilityId, mode } : undefined;
}
function taskTypeLabel(task: CapabilityTask) {
  const maintenance = maintenanceOf(task);
  const copy = t().capability.v2;
  return maintenance?.mode === "Rebuild" ? copy.taskRebuild : maintenance?.mode === "Repair" ? copy.taskRepair : task.type === "Validation" ? copy.screen.taskValidation : copy.screen.taskGeneration;
}
function taskOriginLabel(task: CapabilityTask) {
  const copy = t().capability.v2;
  if (task.sourceAgentRunId) return copy.originAgent;
  if (task.type === "Validation") return copy.originValidation;
  return copy.originAdmin;
}
function taskDescription(task: CapabilityTask) {
  return task.input.candidateSummary?.description?.trim() || task.goal;
}
function taskFailureCause(message?: string) {
  const normalized = message?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized
    .replace(/https?:\/\/(?:control-plane|[^/\s]+\.internal)(?::\d+)?[^\s]*/gi, t().capability.v2.internalAddress)
    .replace(/([?&](?:access_token|api_key|token|secret|password|credential|authorization|session|signature)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(?:authorization|proxy-authorization)\s*:\s*bearer\s+[^\s,;]+/gi, "Authorization: Bearer [REDACTED]")
    .slice(0, 500);
}
/**
 * What the progress line says.
 *
 * The projection names a state and the console words it, so the same task
 * reads correctly for an administrator in either language. A failure is worded
 * by its code, which is already the panel's own rule for failures.
 */
function progressMessage(state: CapabilityProductionStatus) {
  const copy = t().capability.v2;
  const progress: Record<ProductionMessageKey, string> = copy.screen.progress;
  if (state.messageKey === "failed" && state.code && copy.failure[state.code]) return copy.failure[state.code];
  return progress[state.messageKey] || state.messageKey;
}
/**
 * One line of the progress feed.
 *
 * The authoring events carry stable markers rather than sentences, and each
 * marker has copy. A record written before the markers existed falls through
 * to its own text, which keeps old tasks readable instead of blank.
 */
function activityMessage(message: string) {
  const copy = t().capability.v2.screen;
  if (message === "run_draft failed") return copy.repairing;
  if (message === "draft replay succeeded") return copy.frozen;
  const example = message.match(/^draft grounding example (\d+)/);
  if (example) return copy.activityExample(example[1]);
  return copy.activityMessage[message] || taskFailureCause(message);
}
/** The administrator is asked for one named input; the key names what it wants. */
function interactionTitle(message: string) {
  const required = message.match(/^runtime_input_required:(.+)$/);
  return required ? t().capability.v2.screen.interactionNeeded(required[1]) : message;
}
function taskFailure(task: CapabilityTask) {
  if (!task.error) return undefined;
  const copy = t().capability.v2;
  // A gate's own words are written for the authoring model, which is the only
  // reader that can act on them: they name directives and quote JavaScript.
  // One reached this panel verbatim — "a condition is checked and then nothing
  // is done with it: if (targetTitle && …) {}" — where the reader is watching
  // a capability being made. Where the code has copy of its own that is what
  // the panel says, and the gate's text moves to the engineering section,
  // which is where someone goes to read it.
  const curated = copy.failure[task.error.code];
  const rawOnly = task.error.message === task.error.code || /^(?:exploration_|runner_)[a-z0-9_:.-]+$/i.test(task.error.message);
  return {
    code: task.error.code,
    message: curated || (rawOnly ? copy.runnerFailed(task.error.message) : task.error.message),
    retryable: task.error.retryable,
    cause: taskFailureCause(task.error.cause?.message),
  };
}
function schemaFields(capability?: Capability) {
  const schema = capability?.contract.inputSchema;
  const properties = schema?.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? schema.properties as Record<string, JsonValue> : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter((value): value is string => typeof value === "string") : []);
  return Object.entries(properties).map(([key, raw]) => {
    const field = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, JsonValue> : {};
    const type = field.type === "number" || field.type === "integer" || field.type === "boolean" ? String(field.type) : "string";
    return { key, type, required: required.has(key), label: typeof field.title === "string" ? field.title : key, description: typeof field.description === "string" ? field.description : "" };
  });
}

export function CapabilityCenterV2Screen({ overview }: { overview: SiteAgentOverview }) {
  const siteId = overview.id;
  // Discovery should start from the site entry point, not whichever dynamic
  // product/detail page the connected browser happened to visit last. The
  // latter is useful evidence in an Episode, but it is an unsafe default for
  // an administrator-created, site-global capability.
  const startUrl = overview.profile.entryUrl || overview.connection?.origin || overview.connection?.url || "";
  const [tab, setTab] = useState<Tab>("capabilities");
  useEffect(() => { if (new URLSearchParams(window.location.search).has("intake")) setTab("tasks"); }, []);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [intakes, setIntakes] = useState<CapabilityExperienceIntake[]>([]);
  const [tasks, setTasks] = useState<CapabilityTask[]>([]);
  const [taskProgress, setTaskProgress] = useState<Record<string, CapabilityProductionStatus>>({});
  const [selectedCapabilityId, setSelectedCapabilityId] = useState<string>();
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [versions, setVersions] = useState<CapabilityVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string>();
  const [taskEvents, setTaskEvents] = useState<CapabilityTaskEvent[]>([]);
  const [taskArtifacts, setTaskArtifacts] = useState<CapabilityArtifact[]>([]);
  const [query, setQuery] = useState("");
  const sort: SortKey = "updatedAt";
  const sortDescending = true;
  const [showArchivedTasks, setShowArchivedTasks] = useState(false);
  const [goal, setGoal] = useState("");
  const [guidance, setGuidance] = useState("");
  const [interactionValues, setInteractionValues] = useState<Record<string, string>>({});
  const [maintenanceMode, setMaintenanceMode] = useState<MaintenanceMode>();
  const [maintenanceBaseVersionId, setMaintenanceBaseVersionId] = useState("");
  const [maintenanceGoal, setMaintenanceGoal] = useState("");
  const [maintenanceGuidance, setMaintenanceGuidance] = useState("");
  const [maintenanceStartUrl, setMaintenanceStartUrl] = useState("");
  const [maintenanceParameters, setMaintenanceParameters] = useState<Record<string, string>>({});
  const [maintenanceSourceTaskId, setMaintenanceSourceTaskId] = useState<string>();
  const [maintenanceLoading, setMaintenanceLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const copy = t().capability.v2;
  const ui = copy.screen;
  const [loading, setLoading] = useState(true);
  const [taskFilter, setTaskFilter] = useState("all");
  const [detailOpen, setDetailOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const loadSequence = useRef(0);
  const createDialog = useRef<HTMLDialogElement>(null);
  const [progress, setProgress] = useState<CapabilityProductionStatus>();
  useEffect(() => { if (creating) createDialog.current?.showModal(); else createDialog.current?.close(); }, [creating]);


  const selectedCapability = capabilities.find((item) => item.id === selectedCapabilityId);
  const selectedTask = tasks.find((item) => item.id === selectedTaskId);
  const selectedTaskFailure = selectedTask ? taskFailure(selectedTask) : undefined;
  const selectedVersion = versions.find((item) => item.id === selectedVersionId) || versions[0];
  const activeMaintenanceTask = selectedCapability ? tasks.find((task) => ["Pending", "Running", "WaitingInput"].includes(task.status) && maintenanceOf(task)?.capabilityId === selectedCapability.id) : undefined;
  const maintenanceFields = schemaFields(selectedCapability);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const [intakePayload, capabilityPayload, taskPayload] = await Promise.all([
        request<{ intakes: CapabilityExperienceIntake[] }>(siteId, "/experiences"),
        request<{ capabilities: Capability[] }>(siteId, "/capabilities"),
        request<{ tasks: CapabilityTask[]; progress?: Record<string, CapabilityProductionStatus> }>(siteId, `/tasks?includeArchived=${showArchivedTasks ? "1" : "0"}`),
      ]);
      if (sequence !== loadSequence.current) return;
      // Deleted capabilities are tombstones retained for uniqueness/audit only.
      // Keep this defensive filter even though the API excludes them by default.
      const nextCapabilities = (capabilityPayload.capabilities || []).filter((item) => item.status !== "Deleted" && !item.deletedAt);
      const nextTasks = (taskPayload.tasks || []).filter((item) => item.status !== "Deleted" && !item.deletedAt && (showArchivedTasks || !item.archivedAt));
      setIntakes(intakePayload.intakes || []); setCapabilities(nextCapabilities); setTasks(nextTasks); setTaskProgress(taskPayload.progress || {});
      setSelectedCapabilityId((current) => nextCapabilities.some((item) => item.id === current) ? current : nextCapabilities[0]?.id);
      setSelectedTaskId((current) => nextTasks.some((item) => item.id === current) ? current : nextTasks[0]?.id);

    } catch (error) { setNotice(error instanceof Error ? error.message : copy.catalogFailed); }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }, [showArchivedTasks, siteId]);

  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 5000); return () => window.clearInterval(timer); }, [load]);
  useEffect(() => {
    setVersions([]);
    if (!selectedCapabilityId) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void request<{ versions: CapabilityVersion[] }>(siteId, `/capabilities/${encodeURIComponent(selectedCapabilityId)}/versions`)
        .then((payload) => { if (cancelled) return; const next = payload.versions || []; setVersions(next); setSelectedVersionId((current) => next.some((item) => item.id === current) ? current : next[0]?.id); })
        .catch((error) => setNotice(error instanceof Error ? error.message : copy.versionsFailed));
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [siteId, selectedCapabilityId]);
  useEffect(() => {
    if (!selectedTaskId || tab !== "tasks") {
      const timer = window.setTimeout(() => { setTaskEvents([]); setTaskArtifacts([]); }, 0);
      return () => window.clearTimeout(timer);
    }
    let cancelled = false;
    // Do not leave evidence from the previously selected task visible while
    // the new task detail is loading.  Without this reset, a freshly selected
    // Running/Pending task can temporarily display another task's timeline,
    // runner records, or artifacts, which makes the debug view look as if
    // progress was attributed to the wrong task.
    setProgress(undefined);
    setTaskEvents([]);
    setTaskArtifacts([]);

    const refresh = async () => {
      try {
        const [taskPayload, eventPayload, artifactPayload, progressPayload] = await Promise.all([
          request<{ task: CapabilityTask }>(siteId, `/tasks/${encodeURIComponent(selectedTaskId)}`),
          request<{ events: CapabilityTaskEvent[] }>(siteId, `/tasks/${encodeURIComponent(selectedTaskId)}/events`),
          request<{ artifacts: CapabilityArtifact[] }>(siteId, `/tasks/${encodeURIComponent(selectedTaskId)}/artifacts`),
          request<{ progress: CapabilityProductionStatus }>(siteId, `/tasks/${encodeURIComponent(selectedTaskId)}/progress`),
        ]);
        if (cancelled) return;
        setTasks((current) => current.map((task) => task.id === taskPayload.task.id ? taskPayload.task : task));
        setProgress(progressPayload.progress);
        setTaskEvents(eventPayload.events || []);
        setTaskArtifacts(artifactPayload.artifacts || []);
      } catch (error) {
        if (!cancelled) setNotice(error instanceof Error ? error.message : copy.progressFailed);
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [selectedTaskId, siteId, tab]);

  const visibleCapabilities = useMemo(() => capabilities.filter((item) => item.status !== "Deleted" && !item.deletedAt && `${item.id} ${item.name} ${item.description} ${item.aliases.join(" ")}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => sortDescending ? -a[sort].localeCompare(b[sort]) : a[sort].localeCompare(b[sort])), [capabilities, query, sort, sortDescending]);
  const visibleTasks = useMemo(() => tasks.filter((item) => item.status !== "Deleted" && !item.deletedAt && (showArchivedTasks || !item.archivedAt) && `${item.id} ${item.goal} ${taskDescription(item)} ${item.type} ${item.status} ${item.input.experience?.originalGoal || ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => sortDescending ? -a[sort].localeCompare(b[sort]) : a[sort].localeCompare(b[sort])), [tasks, query, showArchivedTasks, sort, sortDescending]);

  async function act(path: string, body: Record<string, unknown> = {}) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const result = await request<{ task?: CapabilityTask; review?: { outcome: string; reason?: string } }>(siteId, path, { method: "POST", body: JSON.stringify(body) });
      setNotice(result.review && result.review.outcome !== "Published" ? result.review.reason || copy.screen.noticeNotPublished : copy.actionDone);
      await load();
      if (result.task) { setSelectedTaskId(result.task.id); setTab("tasks"); setDetailOpen(true); }
    } catch (error) { setNotice(error instanceof Error ? error.message : copy.actionFailed); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function createTask() {
    if (!goal.trim() || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const generationBody = { request: { goal: goal.trim(), parameters: {}, entryUrl: startUrl }, source: "Admin", instruction: { operation: "create" }, ...(guidance.trim() ? { requirements: [{ text: guidance.trim(), authority: "Admin" }] } : {}) };
      const result = await request<{ disposition: string; task?: CapabilityTask; match?: { capabilityId?: string; reason?: string }; reason?: string }>(siteId, "/generation", { method: "POST", body: JSON.stringify(generationBody) }, "/api/capability-v2");
      await load();
      if (result.disposition === "Created" && result.task) {
        setNotice(copy.screen.noticeQueued);
        setSelectedTaskId(result.task.id); setTab("tasks"); setDetailOpen(true); setGoal(""); setGuidance(""); setCreating(false);
      } else {
        setNotice(result.disposition === "Duplicate" ? copy.screen.noticeDuplicate : result.disposition === "Disabled" ? copy.screen.noticeDisabled : result.reason || result.match?.reason || copy.screen.noticeRejected);
        if (result.match?.capabilityId) { setSelectedCapabilityId(result.match.capabilityId); setTab("capabilities"); setCreating(false); }
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : copy.taskCreateFailed); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function submitInteraction() {
    const interaction = selectedTask?.input.interactions.find((item) => item.status === "Requested");
    if (!selectedTask || !interaction) return;
    try {
      await request(siteId, `/tasks/${encodeURIComponent(selectedTask.id)}/interactions/${encodeURIComponent(interaction.id)}/response`, { method: "POST", body: JSON.stringify({ siteId, values: interactionValues }) });
      setInteractionValues({}); setNotice(copy.inputSubmitted); await load();
    } catch (error) { setNotice(error instanceof Error ? error.message : copy.inputFailed); }
  }
  async function loadMaintenanceDefaults(mode: MaintenanceMode, baseVersionId?: string) {
    if (!selectedCapability) return;
    setMaintenanceLoading(true);
    try {
      const requestedBaseVersionId = baseVersionId || selectedCapability.currentVersionId || "";
      const payload = await request<MaintenanceDefaults>(siteId, `/capabilities/${encodeURIComponent(selectedCapability.id)}/maintenance-defaults?baseVersionId=${encodeURIComponent(requestedBaseVersionId)}`);
      if (payload.activeTaskId) { setTab("tasks"); setSelectedTaskId(payload.activeTaskId); setMaintenanceMode(undefined); return; }
      setMaintenanceMode(mode);
      setMaintenanceBaseVersionId(payload.baseVersionId);
      setMaintenanceGoal(payload.goal || selectedCapability.name);
      setMaintenanceGuidance(mode === "Repair" ? copy.repairConfirmed : payload.guidance || "");
      setMaintenanceStartUrl(payload.startUrl || startUrl);
      setMaintenanceParameters(Object.fromEntries(Object.entries(payload.parameters || {}).map(([key, value]) => [key, String(value ?? "")])));
      setMaintenanceSourceTaskId(payload.sourceTaskId);
    } catch (error) { setNotice(error instanceof Error ? error.message : copy.maintenanceFailed); }
    finally { setMaintenanceLoading(false); }
  }
  function viewMaintenanceTask() {
    if (!activeMaintenanceTask) return;
    setSelectedTaskId(activeMaintenanceTask.id); setTab("tasks");
  }
  async function submitMaintenance() {
    if (!selectedCapability || !maintenanceMode || !maintenanceGoal.trim()) return;
    const missing = maintenanceFields.filter((field) => field.required && !maintenanceParameters[field.key]?.trim());
    if (missing.length) { setNotice(copy.requiredMissing(missing.map((field) => field.label).join("、"))); return; }
    const parameters = maintenanceFields.reduce<Record<string, JsonValue>>((values, field) => {
      const raw = maintenanceParameters[field.key];
      if (raw === undefined || raw === "") return values;
      values[field.key] = field.type === "number" || field.type === "integer" ? Number(raw) : field.type === "boolean" ? raw === "true" : raw;
      return values;
    }, {});
    setMaintenanceLoading(true);
    try {
      const result = await request<{ task: CapabilityTask }>(siteId, `/capabilities/${encodeURIComponent(selectedCapability.id)}/${maintenanceMode === "Repair" ? "repair" : "rebuild"}`, { method: "POST", body: JSON.stringify({ baseVersionId: maintenanceBaseVersionId, goal: maintenanceGoal, guidance: maintenanceGuidance || undefined, parameters, context: { startUrl: maintenanceStartUrl || startUrl } }) });
      setMaintenanceMode(undefined); setNotice(maintenanceMode === "Repair" ? copy.repairCreated : copy.rebuildCreated);
      await load(); setSelectedTaskId(result.task.id); setTab("tasks"); setDetailOpen(true);
    } catch (error) { setNotice(error instanceof Error ? error.message : copy.maintenanceCreateFailed); }
    finally { setMaintenanceLoading(false); }
  }

  const stateOf = (task: CapabilityTask) => taskProgress[task.id] || projectProductionStatus(task);
  const inProgress = tasks.filter(task => ['Queued','Running'].includes(stateOf(task).state)).length;
  const attention = tasks.filter(task => ['Failed','Rejected','WaitingInput','NeedsAttention'].includes(stateOf(task).state)).length;
  const filteredTasks = visibleTasks.filter(task => taskFilter === 'all' || (taskFilter === 'active' ? ['Queued','Running'].includes(stateOf(task).state) : ['Failed','Rejected','WaitingInput','NeedsAttention'].includes(stateOf(task).state)));
  const selectTask = (id: string | undefined) => { if (!id) return; setSelectedTaskId(id); setTab('tasks'); setDetailOpen(true); };
  const latestWorkspace = [...taskArtifacts].filter(a => a.contentType.startsWith('application/vnd.sitewake.workspace')).sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0];
  const activity = progressActivity(taskEvents);

  return <section className={`ccv2-shell ${detailOpen ? "detail-open" : ""}`} aria-label={ui.aria}>
    <header className="ccv2-head"><div><p className="ccv2-muted">{ui.intro}</p></div><button className="ccv2-primary" disabled title={ui.createUnavailable} aria-describedby="ccv2-create-unavailable" onClick={() => { setNotice(""); setCreating(true); }}>{ui.create}</button><span id="ccv2-create-unavailable" hidden>{ui.createUnavailable}</span></header>
    <nav className="ccv2-tabs" aria-label={ui.tabsAria}>{([['capabilities',ui.tabCapabilities,capabilities.length],['tasks',ui.tabTasks,tasks.length],['intakes',ui.tabIntakes,intakes.filter(i=>i.status!=='completed').length]] as const).map(([key,label,count])=><button key={key} aria-current={tab===key?'page':undefined} className={`ccv2-tab ${tab===key?'active':''}`} onClick={()=>{setTab(key);setDetailOpen(false);}}>{label}<em>{count}</em></button>)}</nav>
    <dialog ref={createDialog} className="ccv2-dialog" onCancel={() => setCreating(false)} onClose={() => setCreating(false)} aria-labelledby="ccv2-create-title"><form onSubmit={e => { e.preventDefault(); void createTask(); }}><div className="ccv2-maintenance-head"><h3 id="ccv2-create-title">{ui.dialogTitle}</h3><button type="button" aria-label={ui.close} onClick={() => setCreating(false)}>×</button></div><p className="ccv2-muted">{ui.dialogIntro}</p><div className="ccv2-form"><label>{ui.goalLabel}<input autoFocus required value={goal} onChange={e => setGoal(e.target.value)} placeholder={ui.goalPlaceholder} /></label><label>{ui.guidanceLabel} <span className="ccv2-muted">{ui.optional}</span><textarea value={guidance} onChange={e => setGuidance(e.target.value)} placeholder={ui.guidancePlaceholder} /></label><p className="ccv2-muted">{ui.startFrom(startUrl || ui.noEntryUrl)}</p></div>{notice && <p role="status" className="ccv2-notice">{notice}</p>}<div className="ccv2-actions"><button disabled={busy || !goal.trim() || !startUrl}>{busy ? ui.judging : ui.start}</button><button type="button" className="secondary" onClick={() => setCreating(false)}>{ui.cancel}</button></div></form></dialog>
    {tab === 'intakes' && <><p className="ccv2-section-note">{ui.intakesNote}</p><CapabilityExperienceInbox siteId={siteId} items={intakes} expanded busy={busy} onTask={selectTask} onRetry={id => void act(`/experiences/${encodeURIComponent(id)}/retry`)} />{!intakes.length && <div className="ccv2-empty">{ui.intakesEmpty}</div>}</>}
    {notice && <div className="ccv2-notice" role="status">{notice}<button onClick={() => setNotice("")} style={{ float: "right", border: 0, background: "none" }}>×</button></div>}
    {tab !== "intakes" && <><div className="ccv2-toolbar"><input aria-label={ui.searchAria} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tab === "capabilities" ? copy.searchCapabilities : copy.searchTasks} />{tab === "tasks" && <label className="ccv2-checkbox"><input data-testid="capability-v2-show-archived" type="checkbox" checked={showArchivedTasks} onChange={(event) => setShowArchivedTasks(event.target.checked)} />{copy.showArchived}</label>}{tab === 'tasks' && <div className="ccv2-filters" aria-label={ui.filtersAria}>{[['all',ui.filterAll],['active',ui.filterActive(inProgress)],['attention',ui.filterAttention(attention)]].map(([key,label])=><button key={key} aria-pressed={taskFilter===key} onClick={()=>setTaskFilter(key)}>{label}</button>)}</div>}<button onClick={() => void load()} aria-label={ui.refreshAria}>{copy.refresh}</button></div>
    {loading ? <div className="ccv2-empty">{copy.loading}</div> : <div className="ccv2-layout">
      <div className="ccv2-list">{tab === "capabilities" ? visibleCapabilities.map((item) => <button key={item.id} className={`ccv2-row ${selectedCapabilityId === item.id ? "selected" : ""}`} onClick={() => { setSelectedCapabilityId(item.id); setMaintenanceMode(undefined); setDetailOpen(true); }}><div><h3>{item.name}</h3><p>{item.description || copy.noDescription}</p><div className="ccv2-meta"><span>{item.currentVersionId ? ui.hasVersion : ui.noVersion}</span><span>{time(item.updatedAt)}</span></div></div>{badge(item.status)}</button>) : filteredTasks.map((item) => <button key={item.id} data-task-id={item.id} className={`ccv2-row ${selectedTaskId === item.id ? "selected" : ""}`} onClick={() => selectTask(item.id)}><div><h3>{item.input.candidateSummary?.name || item.input.experience?.originalGoal || item.goal}</h3><p>{progressMessage(stateOf(item))}</p><div className="ccv2-meta"><span>{taskTypeLabel(item)}</span><span>{copy.originLabel(taskOriginLabel(item))}</span><span>{time(item.updatedAt)}</span></div></div>{item.archivedAt ? <span className="ccv2-badge ccv2-archived">{copy.archived}</span> : badge(taskProgress[item.id]?.state || item.status)}</button>)}{(tab === "capabilities" ? visibleCapabilities : filteredTasks).length === 0 && <div className="ccv2-empty">{query ? ui.noMatch : tab === "capabilities" ? ui.emptyCapabilities : ui.emptyTasks}</div>}</div>
      <aside className="ccv2-detail"><button className="ccv2-back" onClick={()=>setDetailOpen(false)}>{ui.backToList}</button>{tab === "capabilities" && selectedCapability ? <>
        <h3>{selectedCapability.name}</h3><p className="ccv2-muted">{selectedCapability.description || copy.noDescription}</p>
        <section className="ccv2-contract"><h4>{ui.howToUse}</h4><div><strong>{ui.needsInput}</strong>{schemaFields(selectedCapability).length ? schemaFields(selectedCapability).map(field => <p key={field.key}><b>{field.label}</b><span>{field.required ? ui.required : ui.optionalField} · {field.description || field.type}</span></p>) : <p className="ccv2-muted">{ui.noInput}</p>}</div><details><summary>{ui.viewSchema}</summary><pre className="ccv2-json">{JSON.stringify(selectedCapability.contract, null, 2)}</pre></details></section>
        <details><summary>{ui.identity}</summary><dl><dt>{copy.capabilityId}</dt><dd>{selectedCapability.id}</dd><dt>{copy.status}</dt><dd>{badge(selectedCapability.status)}</dd><dt>{copy.createdAt}</dt><dd>{time(selectedCapability.createdAt)}</dd><dt>{copy.updatedAt}</dt><dd>{time(selectedCapability.updatedAt)}</dd><dt>{copy.currentVersion}</dt><dd>{selectedCapability.currentVersionId || copy.noPublishedVersion}</dd></dl></details>
        <div className="ccv2-actions">
          {selectedCapability.currentVersionId && (activeMaintenanceTask
            ? <button data-testid="capability-v2-view-maintenance" onClick={viewMaintenanceTask}>{copy.viewBuildTask}</button>
            : <><button data-testid="capability-v2-rebuild" onClick={() => void loadMaintenanceDefaults("Rebuild")}>{copy.rebuild}</button><button data-testid="capability-v2-repair" className="secondary" onClick={() => void loadMaintenanceDefaults("Repair")}>{copy.repair}</button></>)}
          {selectedCapability.status === "Active" && <button className="danger" onClick={() => void act(`/capabilities/${selectedCapability.id}/disable`)}>{copy.disable}</button>}
          {selectedCapability.status === "Disabled" && <button onClick={() => void act(`/capabilities/${selectedCapability.id}/enable`)}>{copy.enable}</button>}
        </div>
        {maintenanceMode && <section className="ccv2-maintenance" role="dialog" aria-label={maintenanceMode === "Repair" ? copy.repairDialog : copy.rebuildDialog} data-testid="capability-v2-maintenance-form">
          <div className="ccv2-maintenance-head"><strong>{maintenanceMode === "Repair" ? copy.repair : copy.rebuild}</strong><button aria-label={copy.close} onClick={() => setMaintenanceMode(undefined)}>×</button></div>
          <p className="ccv2-maintenance-note">{maintenanceMode === "Repair" ? copy.repairNote : copy.rebuildNote}</p>
          <div className="ccv2-form">
            <label>{copy.baseVersion}<select value={maintenanceBaseVersionId} onChange={(event) => void loadMaintenanceDefaults(maintenanceMode, event.target.value)}>{versions.filter((version) => version.status === "Published" || version.status === "Disabled").map((version) => <option key={version.id} value={version.id}>{version.id} · {version.status}</option>)}</select></label>
            <label>{copy.maintenanceGoal}<input value={maintenanceGoal} onChange={(event) => setMaintenanceGoal(event.target.value)} /></label>
            <label>{copy.startPage}<input value={maintenanceStartUrl} onChange={(event) => setMaintenanceStartUrl(event.target.value)} placeholder={startUrl} /></label>
            <label>{copy.runnerGuidance}<textarea value={maintenanceGuidance} onChange={(event) => setMaintenanceGuidance(event.target.value)} placeholder={maintenanceMode === "Repair" ? copy.repairGuidancePlaceholder : copy.rebuildGuidancePlaceholder} /></label>
            {maintenanceFields.map((field) => <label key={field.key}>{field.label}{field.required ? copy.required : ""}{field.type === "boolean"
              ? <select value={maintenanceParameters[field.key] || ""} onChange={(event) => setMaintenanceParameters((current) => ({ ...current, [field.key]: event.target.value }))}><option value="">{copy.pickOne}</option><option value="true">{copy.yes}</option><option value="false">{copy.no}</option></select>
              : <input type={field.type === "number" || field.type === "integer" ? "number" : "text"} value={maintenanceParameters[field.key] || ""} onChange={(event) => setMaintenanceParameters((current) => ({ ...current, [field.key]: event.target.value }))} placeholder={field.description} />}</label>)}
            {maintenanceSourceTaskId && <span className="ccv2-muted">{copy.defaultsFrom(maintenanceSourceTaskId)}</span>}
            <div className="ccv2-actions"><button data-testid="capability-v2-maintenance-submit" disabled={maintenanceLoading} onClick={() => void submitMaintenance()}>{maintenanceLoading ? copy.creating : maintenanceMode === "Repair" ? copy.createRepair : copy.startRebuild}</button><button className="secondary" onClick={() => setMaintenanceMode(undefined)}>{copy.cancel}</button></div>
          </div>
        </section>}
        <h4 style={{ marginTop: 20 }}>{ui.versionHistory}</h4>
        {versions.map((version) => {
          const expanded = selectedVersion?.id === version.id;
          const validationTask = tasks.find((task) => task.versionId === version.id && task.type === "Validation" && task.status !== "Deleted");
          const sourceTask = tasks.find((task) => task.versionId === version.id && (task.type === "Discovery" || task.type === "Repair") && task.result?.outcome === "Success");
          const validationCases = Array.isArray(sourceTask?.input.context.validationCases) ? sourceTask.input.context.validationCases : [];
          return <div className="ccv2-version" key={version.id}>
            <div className="ccv2-version-head"><button onClick={() => setSelectedVersionId(version.id)} style={{ border: 0, background: "none", fontWeight: 700, cursor: "pointer" }}>{version.id.slice(-10)}</button>{badge(selectedCapability.currentVersionId === version.id ? "Active" : version.status)}</div>
            <div className="ccv2-meta"><span>{copy.sourceLabel(version.source)}</span><span>{copy.createdLabel(time(version.createdAt))}</span><span>{copy.validationLabel(validationTask?.status || copy.notValidated)}</span><span>{copy.reviewLabel(version.review?.ai?.status || copy.notReviewed)}</span></div>
            {expanded && <details><summary>{ui.versionDetails}</summary>
              <dl><dt>{copy.moduleHash}</dt><dd>{version.program.module.contentHash}</dd><dt>{copy.runtime}</dt><dd>{copy.runtimeValue}</dd></dl>
              <ol className="ccv2-steps">{version.program.stages.length ? version.program.stages.map((stage) => <li key={stage.id}>{humanStage(stage)}</li>) : <li>{copy.noStages}</li>}</ol>
              {version.program.targetBindings.length > 0 && <><strong>{copy.targetBindings}</strong><ul className="ccv2-steps">{version.program.targetBindings.map((binding) => <li key={binding.inputPath}>{copy.bindingLine(binding.inputPath, binding.targetKind, binding.identityStatePath)}</li>)}</ul></>}
              {validationCases.length > 0 && <><strong>{copy.validationCases}</strong><pre className="ccv2-json">{JSON.stringify(validationCases, null, 2)}</pre></>}
              {/* A replay no longer stops at the first case that did not work, so
                  what each case came to is shown as it is: a capability can be
                  published with one of its cases recorded as failed. */}
              {(validationTask?.result?.validationResults || []).length > 0 && <><strong>{copy.caseOutcomes}</strong><ul className="ccv2-case-outcomes">{(validationTask?.result?.validationResults || []).map((item) => {
                const state = item.noResultReason ? "no-result" : item.failureReason ? "failed" : "passed";
                const label = state === "no-result" ? copy.caseNoResult : state === "failed" ? copy.caseFailed : copy.casePassed;
                return <li key={item.caseId} data-outcome={state}><b>{item.caseId}</b> <span>{label}</span>{item.noResultReason || item.failureReason ? <small>{item.noResultReason || item.failureReason}</small> : null}</li>;
              })}</ul></>}
              {validationTask?.result && <details><summary>{copy.viewValidationResult}</summary><pre className="ccv2-json">{JSON.stringify({ outcome: validationTask.result.outcome, validationCaseCount: validationTask.result.validationCaseCount, stageReceipts: validationTask.result.stageReceipts, targetEvidence: validationTask.result.targetEvidence }, null, 2)}</pre></details>}
              <div className="ccv2-actions">
                {version.status === "Draft" && !validationTask && <button onClick={() => void act("/tasks", { type: "Validation", versionId: version.id, goal: selectedCapability.name, input: { parameters: {}, context: { startUrl, versionSource: "Admin" }, interactions: [], trigger: {} } })}>{copy.replayValidate}</button>}
                {version.status === "Draft" && validationTask?.status === "Succeeded" && <button onClick={() => { const reason = window.prompt(version.review?.ai?.status === "Rejected" || version.review?.ai?.status === "Error" ? copy.overturnPrompt : copy.publishPrompt); if (reason) void act(`/versions/${version.id}/publish`, { adminId: "administrator", reason }); }}>{copy.adminPublish}</button>}
                {version.status === "Published" && selectedCapability.currentVersionId !== version.id && <button onClick={() => void act(`/capabilities/${selectedCapability.id}/switch-version`, { versionId: version.id })}>{copy.switchVersion}</button>}
              </div>
              <details><summary>{copy.viewProgramJson}</summary><pre className="ccv2-json">{JSON.stringify(version.program, null, 2)}</pre></details>
              {sourceTask?.result?.candidateSource && <details><summary>{copy.viewSource}</summary><pre className="ccv2-json">{sourceTask.result.candidateSource}</pre></details>}
            </details>}
          </div>;
        })}</>
        : tab === "tasks" && selectedTask ? <><div className="ccv2-detail-heading"><p className="ccv2-kicker">{ui.progressKicker}</p><h3>{selectedTask.input.candidateSummary?.name || selectedTask.input.experience?.originalGoal || selectedTask.goal}</h3><p className="ccv2-muted">{selectedTask.input.experience?.originalGoal || selectedTask.goal}</p><div className="ccv2-detail-links">{selectedTask.sourceAgentRunId && <a href={`/?site=${encodeURIComponent(siteId)}&view=sessions&run=${encodeURIComponent(selectedTask.sourceAgentRunId)}`}>{ui.viewSourceSession}</a>}{latestWorkspace && <a href={`/api/admin/capability-v2/artifacts/${encodeURIComponent(latestWorkspace.id)}?siteId=${encodeURIComponent(siteId)}`}>{ui.downloadWorkspace}</a>}</div></div>
          {(() => { const state = progress?.taskId === selectedTask.id ? progress : taskProgress[selectedTask.id] || projectProductionStatus(selectedTask); const phases = ["Production", "Validation", "Review", "Publication"]; const index = phases.indexOf(state.phase); return <section className="ccv2-production" data-testid="capability-production-progress"><ol>{ui.phases.map((label, i) => <li key={label} className={i < index || state.state === "Published" ? "done" : i === index ? "current" : ""}><i>{i < index || state.state === "Published" ? "✓" : i + 1}</i>{label}</li>)}</ol><div className="ccv2-production-status">{badge(state.state)}<p>{progressMessage(state)}</p>{state.detail && <small className="ccv2-muted">{taskFailureCause(state.detail)}</small>}{state.code && <small>{ui.errorCode(state.code)}</small>}</div><div className="ccv2-actions">{state.nextTaskId && <button onClick={() => selectTask(state.nextTaskId)}>{ui.viewValidation}</button>}{state.recovery === "RetryReview" && <button disabled={busy} onClick={() => void act(`/tasks/${selectedTask.id}/retry-review`)}>{busy ? ui.reviewing : ui.retryReview}</button>}{state.recovery === "InspectConflict" && <p>{ui.conflict}</p>}{state.state === "Published" && state.capabilityId && <button onClick={() => { setSelectedCapabilityId(state.capabilityId); setTab("capabilities"); }}>{ui.viewPublished}</button>}</div>{state.state !== "Published" && <small className="ccv2-muted">{ui.availableAfter}</small>}</section>; })()}
          {selectedTaskFailure && <section className="ccv2-failure" role="alert"><strong>{ui.failureTitle}</strong><p>{selectedTaskFailure.message}</p><p className="ccv2-muted">{ui.failureHint}</p></section>}
          {activity.length > 0 && <section className="ccv2-activity"><h4>{ui.recentProgress}</h4>{activity.map(event=>{const item=eventText(event);return <div key={event.id}><span>{ui.activity[item.phase]}</span><p>{activityMessage(item.message)}</p><time>{time(event.createdAt)}</time></div>;})}</section>}
          <details className="ccv2-engineering"><summary>{ui.engineering}</summary><dl><dt>{ui.taskNumber}</dt><dd><code>{selectedTask.id}</code></dd><dt>{ui.createdOn}</dt><dd>{time(selectedTask.createdAt)}</dd><dt>{ui.lastUpdated}</dt><dd>{time(selectedTask.updatedAt)}</dd></dl>{selectedTaskFailure && <p className="ccv2-engineering-failure"><code>{selectedTaskFailure.code}</code> {selectedTaskFailure.cause}</p>}{taskArtifacts.some(a=>a.id!==latestWorkspace?.id) && <div className="ccv2-artifacts">{taskArtifacts.filter(a=>a.id!==latestWorkspace?.id).map(a=><a key={a.id} href={`/api/admin/capability-v2/artifacts/${encodeURIComponent(a.id)}?siteId=${encodeURIComponent(siteId)}`} download><b>↓ {artifactLabel(a)}</b><time dateTime={a.createdAt}>{time(a.createdAt)}</time></a>)}</div>}</details>
          {selectedTask.status === "WaitingInput" && selectedTask.input.interactions.filter((item) => item.status === "Requested").map((interaction) => <div className="ccv2-form" key={interaction.id}><strong>{interactionTitle(interaction.message)}</strong>{interaction.fields.map((field) => <label key={field.key}>{field.label}<input type={field.type === "password" || field.type === "otp" ? "password" : field.type === "number" ? "number" : "text"} value={interactionValues[field.key] || ""} onChange={(event) => setInteractionValues((current) => ({ ...current, [field.key]: event.target.value }))} /></label>)}<div className="ccv2-actions"><button onClick={() => void submitInteraction()}>{copy.submitAndContinue}</button></div></div>)}
          <div className="ccv2-actions">{!["Succeeded", "Failed", "Cancelled", "Deleted"].includes(selectedTask.status) && <button className="danger" onClick={() => void act(`/tasks/${selectedTask.id}/cancel`)}>{copy.cancelTask}</button>}{["Succeeded", "Failed", "Cancelled"].includes(selectedTask.status) && <button disabled={busy} onClick={() => void act(`/tasks/${progress?.state === "Rejected" && selectedTask.result?.buildResult?.outcome === "Validated" ? selectedTask.result.buildResult.package.artifact.generationTaskId : selectedTask.id}/rerun`, { goal: selectedTask.goal, guidance: selectedTask.guidance, input: selectedTask.input })}>{progress?.state === "Rejected" ? ui.regenerateCandidate : selectedTask.type === "Validation" ? ui.revalidateCandidate : ui.regenerate}</button>}{["Succeeded", "Failed", "Cancelled"].includes(selectedTask.status) && !selectedTask.archivedAt && <button data-testid="capability-v2-task-archive" className="secondary" onClick={() => void act(`/tasks/${selectedTask.id}/archive`, { archived: true })}>{copy.archiveTask}</button>}{selectedTask.archivedAt && <button data-testid="capability-v2-task-unarchive" className="secondary" onClick={() => void act(`/tasks/${selectedTask.id}/archive`, { archived: false })}>{copy.unarchive}</button>}</div>
          <details><summary>{copy.viewRunSpec}</summary><pre className="ccv2-json">{JSON.stringify({ runSpec: selectedTask.runSpec, input: selectedTask.input }, null, 2)}</pre></details></> : <div className="ccv2-empty">{copy.pickRecord}</div>}</aside>
    </div>}
    </>}
  </section>;
}
