"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Capability, CapabilityDetail, CapabilityProposal, CapabilityTask, CapabilityTaskDetail } from "../../lib/capability-center/model";
import type { CapabilitySignal, SiteAgentOverview } from "../../lib/site-knowledge/protocol";
import { RunnerManagement, type RunnerManagementMode } from "../runner-management";
import { capabilityCenterApi } from "./capability-center-api";
import { activeLocale, t } from "../../lib/i18n";

type Module = "tasks" | "capabilities" | "runners";
type TaskFilter = "all" | "active" | "awaiting-review" | "failed" | "completed" | "archived";

/**
 * Read through functions, never module-level maps: `t()` resolves against
 * `<html lang>`, which does not exist when this module is first evaluated.
 */
const taskStatus = () => t().capability.center.taskStatus;
const stageLabel = () => t().capability.center.stage;
const capabilityStatus = () => t().capability.center.status;
const signalStatus = () => t().capability.center.signalStatus;

function initialModule(): Module {
  if (typeof window === "undefined") return "capabilities";
  const value = new URL(window.location.href).searchParams.get("module");
  return value === "tasks" || value === "runners" ? value : "capabilities";
}

/**
 * A capability carries its own zh/en name. Which one to show follows the
 * console's locale — the one the operator chose and the server rendered into
 * `<html lang>` — rather than `navigator.language`. Reading the browser
 * directly also made this hydrate differently than it rendered.
 */
function capabilityName(capability: Capability | undefined, locale: string) {
  if (!capability) return "";
  return locale === "zh"
    ? capability.localizedNames?.zhCN || capability.name
    : capability.localizedNames?.en || capability.name;
}

function dateTime(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(activeLocale(), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function taskVisible(task: CapabilityTask, filter: TaskFilter) {
  if (filter === "all") return true;
  if (filter === "active") return task.status === "queued" || task.status === "running";
  return task.status === filter;
}

function artifactRole(artifact: CapabilityTaskDetail["artifacts"][number]) {
  return "role" in artifact && typeof artifact.role === "string" ? artifact.role : "";
}

function JsonContract({ title, value }: { title: string; value: unknown }) {
  return <article className="cc4-contract"><header><b>{title}</b></header><pre>{JSON.stringify(value, null, 2)}</pre></article>;
}

function TaskEvidence({ task, detail }: { task: CapabilityTask; detail?: CapabilityTaskDetail }) {
  const verification = detail?.verification;
  const artifacts = detail?.artifacts || [];
  const proofIds = new Set(verification?.evidenceArtifactIds || []);
  const proofArtifacts = artifacts.filter((artifact) => proofIds.has(artifact.id) && artifact.runId === verification?.runId);
  const historicalArtifacts = artifacts.filter((artifact) => !proofIds.has(artifact.id) || artifact.runId !== verification?.runId);
  const screenshots = proofArtifacts.filter((artifact) => artifact.kind === "screenshot");
  const beforeScreenshots = screenshots.filter((artifact) => artifactRole(artifact) === "before-screenshot");
  const afterScreenshots = screenshots.filter((artifact) => artifactRole(artifact) === "after-screenshot");
  const keyframes = screenshots.filter((artifact) => artifactRole(artifact) === "keyframe");
  const unclassifiedScreenshots = screenshots.filter((artifact) => !["before-screenshot", "after-screenshot", "keyframe"].includes(artifactRole(artifact)));
  const videos = proofArtifacts.filter((artifact) => artifact.kind === "video");
  const processFiles = proofArtifacts.filter((artifact) => artifact.kind === "trace" || artifact.kind === "dom" || artifact.kind === "console");
  const passedChecks = verification?.checks.filter((check) => check.status === "passed").length || 0;
  const pendingChecks = verification?.checks.filter((check) => check.status === "incomplete").length || 0;
  const copy = t().capability.evidence;
  const statusLabel = verification?.status === "passed"
    ? pendingChecks ? copy.passedPending : copy.passed
    : verification?.status === "failed" ? copy.failed : copy.incomplete;
  return <section className="cc4-section cc4-evidence">
    <h4>{copy.title}</h4>
    <article className={`cc4-proof ${verification?.status || "incomplete"}`}>
      <header><div><span>{copy.verdict}</span><b>{statusLabel}</b></div>{verification?.checkedAt && <small>{dateTime(verification.checkedAt)}</small>}</header>
      <p>{verification?.summary || copy.loadingSummary}</p>
      {verification?.goal && <dl><dt>{copy.goal}</dt><dd>{verification.goal}</dd></dl>}
      {(verification?.startUrl || verification?.endUrl) && <div className="cc4-proof-route"><span><small>{copy.startPage}</small>{verification.startUrl || copy.unrecorded}</span><i>→</i><span><small>{copy.endPage}</small>{verification.endUrl || copy.unrecorded}</span></div>}
      {verification?.runId && <code>{copy.runId(verification.runId)}</code>}
    </article>
    <div className="cc4-evidence-block"><header><b>{copy.checksTitle}</b><small>{copy.checksPassed(passedChecks)}{pendingChecks ? copy.checksPending(pendingChecks) : ""}</small></header>
      {verification?.checks.length ? <div className="cc4-check-list">{verification.checks.map((check) => <article key={check.id} className={check.status}>
        <span>{check.status === "passed" ? "✓" : check.status === "failed" ? "×" : "!"}</span><div><b>{check.label}</b><dl><dt>{copy.expected}</dt><dd>{check.expected}</dd><dt>{copy.actual}</dt><dd>{check.actual}</dd></dl></div>
      </article>)}</div> : <p className="cc4-muted">{copy.noChecks}</p>}
    </div>
    <div className="cc4-proof-compare">
      <div className="cc4-evidence-block"><header><b>{copy.beforeShots}</b><small>{copy.count(beforeScreenshots.length)}</small></header>{beforeScreenshots.length ? <div className="cc4-shot-grid">{beforeScreenshots.map((artifact) => <a key={artifact.id} href={artifact.url} target="_blank" rel="noreferrer"><Image src={artifact.url} alt={artifact.label} width={640} height={360} unoptimized /><span>{artifact.label}</span></a>)}</div> : <p className="cc4-muted">{copy.noBeforeShots}</p>}</div>
      <div className="cc4-evidence-block"><header><b>{copy.afterShots}</b><small>{copy.count(afterScreenshots.length)}</small></header>{afterScreenshots.length ? <div className="cc4-shot-grid">{afterScreenshots.map((artifact) => <a key={artifact.id} href={artifact.url} target="_blank" rel="noreferrer"><Image src={artifact.url} alt={artifact.label} width={640} height={360} unoptimized /><span>{artifact.label}</span></a>)}</div> : <p className="cc4-muted">{copy.noAfterShots}</p>}</div>
    </div>
    <div className="cc4-evidence-block"><header><b>{copy.keyframes}</b><small>{copy.count(keyframes.length)}</small></header>{keyframes.length ? <div className="cc4-shot-grid cc4-keyframe-grid">{keyframes.map((artifact, index) => <a key={artifact.id} href={artifact.url} target="_blank" rel="noreferrer"><Image src={artifact.url} alt={artifact.label} width={640} height={360} unoptimized /><span><i>{copy.keyframe(index + 1)}</i>{artifact.label}</span></a>)}</div> : <p className="cc4-muted">{copy.noKeyframes}</p>}</div>
    {unclassifiedScreenshots.length > 0 && <div className="cc4-evidence-block"><header><b>{copy.unclassifiedShots}</b><small>{copy.count(unclassifiedScreenshots.length)}</small></header><p className="cc4-muted">{copy.unclassifiedNote}</p><div className="cc4-shot-grid">{unclassifiedScreenshots.map((artifact) => <a key={artifact.id} href={artifact.url} target="_blank" rel="noreferrer"><Image src={artifact.url} alt={artifact.label} width={640} height={360} unoptimized /><span>{artifact.label}</span></a>)}</div></div>}
    <div className="cc4-evidence-block"><header><b>{copy.videos}</b><small>{copy.count(videos.length)}</small></header>{videos.length ? <div className="cc4-video-grid">{videos.map((artifact) => <article key={artifact.id}><video controls preload="metadata" src={artifact.url}></video><b>{artifact.label}</b><small>{artifactRole(artifact) === "validation-video" && <i>{copy.validationVideo}</i>}{Math.max(1, Math.round(artifact.size / 1024))} KB</small></article>)}</div> : <p className="cc4-muted">{copy.noVideos}</p>}</div>
    <div className="cc4-evidence-block"><header><b>{copy.processFiles}</b><small>{copy.count(processFiles.length)}</small></header>{processFiles.length ? <div className="cc4-file-list">{processFiles.map((artifact) => <a key={artifact.id} href={artifact.url} target="_blank" rel="noreferrer"><span>{artifact.kind === "trace" ? "TRACE" : artifact.kind.toUpperCase()}</span><div><b>{artifact.label}</b><small>{Math.max(1, Math.round(artifact.size / 1024))} KB · {copy.downloadHint}</small></div><em>{copy.open}</em></a>)}</div> : <p className="cc4-muted">{copy.noProcessFiles}</p>}</div>
    {historicalArtifacts.length > 0 && <details className="cc4-history"><summary>{copy.historySummary(historicalArtifacts.length)}</summary><p>{copy.historyNote}</p><div className="cc4-file-list">{historicalArtifacts.map((artifact) => <a key={artifact.id} href={artifact.url} target="_blank" rel="noreferrer"><span>{artifact.kind.toUpperCase()}</span><div><b>{artifact.label}</b><small>{artifact.runId} · {dateTime(artifact.createdAt)}</small></div><em>{copy.open}</em></a>)}</div></details>}
    <details className="cc4-raw"><summary>{copy.rawSummary}</summary><div className="cc4-json-grid"><JsonContract title={copy.rawResult} value={task.result} /><JsonContract title={copy.rawEvidence} value={task.evidence} /></div></details>
  </section>;
}

export function CapabilityCenterScreen({
  overview,
  runnerMode = "full",
  onRunnerModeChange,
}: {
  overview: SiteAgentOverview;
  runnerMode?: RunnerManagementMode;
  onRunnerModeChange?(mode: RunnerManagementMode): void;
}) {
  const [module, setModule] = useState<Module>(initialModule);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [tasks, setTasks] = useState<CapabilityTask[]>([]);
  const [taskDetail, setTaskDetail] = useState<CapabilityTaskDetail>();
  const [proposals, setProposals] = useState<CapabilityProposal[]>([]);
  const [signals, setSignals] = useState<CapabilitySignal[]>([]);
  const [detail, setDetail] = useState<CapabilityDetail>();
  const [selectedCapabilityId, setSelectedCapabilityId] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [selectedProposalId, setSelectedProposalId] = useState("");
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("awaiting-review");
  const [query, setQuery] = useState("");
  const [goal, setGoal] = useState("");
  const [feedback, setFeedback] = useState("");
  const [autoApprovalEnabled, setAutoApprovalEnabled] = useState(false);
  const [autoApprovalPrompt, setAutoApprovalPrompt] = useState("");
  const [draftAutoApprovalEnabled, setDraftAutoApprovalEnabled] = useState(false);
  const [draftAutoApprovalPrompt, setDraftAutoApprovalPrompt] = useState("");
  const [approvalSettingsOpen, setApprovalSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string }>();
  const copy = t().capability.center;
  const locale = activeLocale();
  const displayName = useCallback((capability: Capability | undefined) => capabilityName(capability, locale), [locale]);

  const loadCatalog = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [catalogResult, settingsResult] = await Promise.allSettled([
        capabilityCenterApi.catalog(overview.id),
        capabilityCenterApi.getSettings(overview.id),
      ]);
      if (catalogResult.status === "rejected") throw catalogResult.reason;
      const payload = catalogResult.value;
      setCapabilities(payload.capabilities);
      setTasks(payload.tasks);
      setProposals(payload.proposals);
      setSignals(payload.signals);
      if (settingsResult.status === "fulfilled") {
        setAutoApprovalEnabled(settingsResult.value.settings.autoApproval.enabled);
        setAutoApprovalPrompt(settingsResult.value.settings.autoApproval.prompt);
      } else {
        setAutoApprovalEnabled(false);
        setAutoApprovalPrompt("");
        setNotice({ tone: "error", text: copy.settingsFailed });
      }
      const urlCapability = typeof window === "undefined" ? "" : new URL(window.location.href).searchParams.get("capability") || "";
      setSelectedCapabilityId((current) => current || (payload.capabilities.some((item) => item.id === urlCapability) ? urlCapability : payload.capabilities[0]?.id || ""));
      setSelectedTaskId((current) => current || payload.tasks.find((item) => item.status === "awaiting-review")?.id || payload.tasks[0]?.id || "");
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : copy.catalogFailed });
    } finally { setLoading(false); }
  }, [overview.id]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void loadCatalog(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadCatalog]);
  useEffect(() => {
    if (!selectedCapabilityId) return;
    let current = true;
    void capabilityCenterApi.detail(overview.id, selectedCapabilityId)
      .then((payload) => { if (current) setDetail(payload.detail); })
      .catch((error) => { if (current) setNotice({ tone: "error", text: error instanceof Error ? error.message : copy.detailFailed }); });
    return () => { current = false; };
  }, [overview.id, selectedCapabilityId]);
  useEffect(() => {
    if (!selectedTaskId) return;
    let current = true;
    void capabilityCenterApi.taskDetail(overview.id, selectedTaskId)
      .then((payload) => { if (current) setTaskDetail(payload); })
      .catch((error) => { if (current) setNotice({ tone: "error", text: error instanceof Error ? error.message : copy.taskEvidenceFailed }); });
    return () => { current = false; };
  }, [overview.id, selectedTaskId]);

  const setActiveModule = (next: Module) => {
    setModule(next);
    const url = new URL(window.location.href);
    url.searchParams.set("module", next);
    window.history.replaceState({}, "", url);
  };
  const selectedTask = tasks.find((item) => item.id === selectedTaskId);
  const selectedProposal = proposals.find((item) => item.id === selectedProposalId);
  const selectedCapabilityHasActiveTask = Boolean(detail && tasks.some((task) =>
    task.capabilityId === detail.capability.id && ["queued", "running", "awaiting-review"].includes(task.status)));
  const capabilityById = useMemo(() => new Map(capabilities.map((item) => [item.id, item])), [capabilities]);
  const filteredCapabilities = capabilities.filter((item) => !item.deletedAt && [item.name, item.localizedNames?.zhCN, item.localizedNames?.en, item.description, item.stableKey].join(" ").toLowerCase().includes(query.trim().toLowerCase()));
  const filteredTasks = tasks.filter((item) => taskVisible(item, taskFilter));
  const visibleSignals = signals.filter((signal) => signal.status === "pending" || signal.status === "processing");
  const activeCount = tasks.filter((item) => item.status === "queued" || item.status === "running").length;
  const reviewCount = tasks.filter((item) => item.status === "awaiting-review").length;
  const taskFilterCounts: Record<TaskFilter, number> = {
    all: tasks.length,
    active: activeCount,
    "awaiting-review": reviewCount,
    failed: tasks.filter((item) => item.status === "failed").length,
    completed: tasks.filter((item) => item.status === "completed").length,
    archived: tasks.filter((item) => item.status === "archived").length,
  };

  async function runAction(key: string, action: () => Promise<unknown>, success: string) {
    setBusy(key); setNotice(undefined);
    try { await action(); await loadCatalog(true); setNotice({ tone: "ok", text: success }); }
    catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : copy.actionFailed }); }
    finally { setBusy(""); }
  }

  async function submitProposal() {
    const requestedGoal = goal.trim();
    if (!requestedGoal) return;
    await runAction("proposal", () => capabilityCenterApi.createProposal(overview.id, requestedGoal), copy.proposeDone);
    setGoal(""); setTaskFilter("all");
  }

  async function saveAutoApproval() {
    await runAction(
      "auto-approval",
      () => capabilityCenterApi.updateAutoApproval(overview.id, {
        enabled: draftAutoApprovalEnabled,
        prompt: draftAutoApprovalPrompt.trim(),
      }),
      draftAutoApprovalEnabled ? copy.autoApprovalOn : copy.autoApprovalOff,
    );
    setApprovalSettingsOpen(false);
  }

  function openAutoApprovalSettings() {
    if (approvalSettingsOpen) { setApprovalSettingsOpen(false); return; }
    setDraftAutoApprovalEnabled(autoApprovalEnabled);
    setDraftAutoApprovalPrompt(autoApprovalPrompt);
    setApprovalSettingsOpen(true);
  }

  async function capabilityAction(action: "unpublish" | "relist" | "delete") {
    const capability = detail?.capability;
    if (!capability) return;
    if (action === "delete" && !window.confirm(copy.confirmDelete(capability.name))) return;
    await runAction(`capability:${action}`, () => capabilityCenterApi.capabilityAction(overview.id, capability.id, action),
      action === "unpublish" ? copy.unpublished : action === "relist" ? copy.relisted : copy.deleted);
    if (action === "delete") { setSelectedCapabilityId(""); setDetail(undefined); }
    else setDetail((await capabilityCenterApi.detail(overview.id, capability.id)).detail);
  }

  async function taskAction(action: "approve" | "reject" | "retry" | "rebuild" | "revalidate" | "cancel" | "archive") {
    if (!selectedTask) return;
    if (action === "cancel" && !window.confirm(copy.confirmCancelTask)) return;
    await runAction(`task:${action}`, () => capabilityCenterApi.taskAction(overview.id, selectedTask.id, action, feedback ? { feedback } : {}),
      action === "approve" ? copy.approved : action === "reject" ? copy.rejected : action === "retry" ? copy.retried : action === "rebuild" ? copy.rebuilt : action === "revalidate" ? copy.revalidated : action === "cancel" ? copy.cancelled : copy.archived);
    setFeedback("");
  }

  async function startValidation() {
    const capability = detail?.capability;
    if (!capability?.currentVersionId) return;
    await runAction("validate", () => capabilityCenterApi.createTask(overview.id, { type: "validate", capabilityId: capability.id, capabilityVersionId: capability.currentVersionId }), copy.validationQueued);
    setActiveModule("tasks");
  }

  return <div className="cc4-shell">
    <header className="cc4-header">
      <div><span>CAPABILITY CENTER</span><h2>{copy.title}</h2><p>{copy.lead}</p></div>
      <div className="cc4-header-actions"><button className={autoApprovalEnabled ? "cc4-auto on" : "cc4-auto"} onClick={openAutoApprovalSettings}><i></i>{copy.autoApproval(autoApprovalEnabled)}</button><button onClick={() => void loadCatalog()} disabled={loading || Boolean(busy)}>{loading ? copy.loading : copy.refresh}</button></div>
    </header>
    <nav className="cc4-tabs" aria-label={copy.tabsLabel}>
      <button className={module === "capabilities" ? "active" : ""} onClick={() => setActiveModule("capabilities")}>{copy.tabCapabilities} <em>{capabilities.length}</em></button>
      <button className={module === "tasks" ? "active" : ""} onClick={() => setActiveModule("tasks")}>{copy.tabTasks} <em>{copy.tabTasksPending(reviewCount)}</em></button>
      <button className={module === "runners" ? "active" : ""} onClick={() => setActiveModule("runners")}>Runner</button>
    </nav>
    {notice && <div className={`cc4-notice ${notice.tone}`}>{notice.text}<button aria-label={copy.closeNotice} onClick={() => setNotice(undefined)}>×</button></div>}
    {approvalSettingsOpen && <section className="cc4-auto-panel">
      <div><b>{copy.autoPanelTitle}</b><p>{copy.autoPanelLead}</p></div>
      <label className="cc4-switch"><input type="checkbox" checked={draftAutoApprovalEnabled} onChange={(event) => setDraftAutoApprovalEnabled(event.target.checked)} /><span></span><b>{draftAutoApprovalEnabled ? copy.autoOn : copy.autoOff}</b></label>
      <label className="cc4-prompt"><span>{copy.autoPromptLabel}</span><textarea value={draftAutoApprovalPrompt} maxLength={4000} onChange={(event) => setDraftAutoApprovalPrompt(event.target.value)} placeholder={copy.autoPromptPlaceholder} /><small>{copy.autoPromptCounter(draftAutoApprovalPrompt.length)}</small></label>
      <div className="cc4-actions"><button disabled={busy === "auto-approval"} onClick={() => void saveAutoApproval()}>{copy.save}</button><button className="ghost" onClick={() => setApprovalSettingsOpen(false)}>{copy.cancel}</button></div>
    </section>}

    {module === "tasks" && <div className="cc4-layout">
      <aside className="cc4-sidebar">
        <div className="cc4-proposal-box"><b>{copy.proposeTitle}</b><textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder={copy.proposePlaceholder} /><button disabled={!goal.trim() || Boolean(busy)} onClick={() => void submitProposal()}>{copy.proposeSubmit}</button></div>
        {visibleSignals.length > 0 && <section className="cc4-signal-queue" aria-label={copy.signalQueueLabel}>
          <header><b>{copy.signalQueueTitle}</b><small>{copy.signalPending(visibleSignals.length)}</small></header>
          {visibleSignals.map((signal) => <article key={signal.id} className={signal.lastError ? "has-error" : ""}>
            <div><span className={`cc4-dot ${signal.status}`}></span><b>{signal.attempts && signal.status === "pending" ? copy.signalRetrying : signalStatus()[signal.status]}</b><small>{copy.signalAggregated(signal.episodeIds.length)}</small></div>
            <p>{copy.signalRetries(signal.attempts || 0, signal.nextAttemptAt ? dateTime(signal.nextAttemptAt) : "")}</p>
            {signal.lastError && <><strong>{signal.lastError.summary}</strong><code>{[signal.lastError.code, signal.lastError.httpStatus ? `HTTP ${signal.lastError.httpStatus}` : "", signal.lastError.finishReason ? `finish=${signal.lastError.finishReason}` : "", signal.lastError.parseError || "", signal.lastError.attempt !== undefined ? `attempt=${signal.lastError.attempt}` : ""].filter(Boolean).join(" · ")}</code></>}
          </article>)}
        </section>}
        <div className="cc4-filter-row">{(["awaiting-review","active","failed","completed","archived","all"] as TaskFilter[]).map((filter) => <button key={filter} className={taskFilter === filter ? "active" : ""} onClick={() => { setTaskFilter(filter); setSelectedProposalId(""); setSelectedTaskId((current) => tasks.some((item) => item.id === current && taskVisible(item, filter)) ? current : tasks.find((item) => taskVisible(item, filter))?.id || ""); }}>{filter === "active" ? copy.filterActive : filter === "awaiting-review" ? copy.filterAwaitingReview : filter === "failed" ? copy.filterFailed : filter === "completed" ? copy.filterCompleted : filter === "archived" ? copy.filterArchived : copy.filterAll} <span>{taskFilterCounts[filter]}</span></button>)}</div>
        <div className="cc4-list">
          {filteredTasks.map((task) => <button key={task.id} className={selectedTaskId === task.id && !selectedProposalId ? "selected" : ""} onClick={() => { setSelectedTaskId(task.id); setSelectedProposalId(""); }}>
            <span className={`cc4-dot ${task.status}`}></span><div><b>{task.capabilityId ? displayName(capabilityById.get(task.capabilityId)) : task.type === "validate" ? copy.taskSystemValidation : copy.taskGeneration}</b><small>{task.type} · {stageLabel()[task.stage] || task.stage} · {dateTime(task.updatedAt)}</small>{task.error && <em>{task.error.summary}</em>}</div><strong>{taskStatus()[task.status] || task.status}</strong>
          </button>)}
          {taskFilter === "all" && proposals.filter((item) => !item.archivedAt && !item.deletedAt).map((proposal) => <button key={proposal.id} className={selectedProposalId === proposal.id ? "selected" : ""} onClick={() => { setSelectedProposalId(proposal.id); setSelectedTaskId(""); }}>
            <span className={`cc4-dot ${proposal.status}`}></span><div><b>{proposal.title}</b><small>Proposal · {dateTime(proposal.updatedAt)}</small></div><strong>{proposal.status === "duplicate" ? copy.proposalDuplicate : proposal.status === "analyzing" ? copy.proposalAnalyzing : proposal.status === "blocked" ? copy.proposalBlocked : proposal.status}</strong>
          </button>)}
          {!filteredTasks.length && taskFilter !== "all" && <div className="cc4-empty">{copy.noTasksInFilter}</div>}
        </div>
      </aside>
      <main className="cc4-detail">
        {selectedTask ? <>
          <div className="cc4-title"><div><span>{selectedTask.type.toUpperCase()} TASK</span><h3>{selectedTask.capabilityId ? displayName(capabilityById.get(selectedTask.capabilityId)) : copy.capabilityTask}</h3><p>{copy.taskLead}</p></div><span className={`cc4-status ${selectedTask.status}`}>{taskStatus()[selectedTask.status] || selectedTask.status}</span></div>
          <div className="cc4-stagebar">{["author","validate","review","complete"].map((stage) => <div key={stage} className={stage === selectedTask.stage || (stage === "complete" && selectedTask.status === "completed") ? "current" : ""}><i></i><span>{stageLabel()[stage]}</span></div>)}</div>
          {selectedTask.error && <section className="cc4-error"><b>{copy.failureTitle}</b><p>{selectedTask.error.summary}</p><code>{selectedTask.error.code}</code></section>}
          <section className="cc4-section"><h4>{copy.attemptsTitle}</h4>{selectedTask.attempts.length ? selectedTask.attempts.map((attempt) => <article className="cc4-attempt" key={attempt.number}><b>{copy.attempt(attempt.number)}</b><span>{attempt.status}</span><small>{dateTime(attempt.startedAt)} — {dateTime(attempt.endedAt)}</small>{attempt.error && <p>{attempt.error.summary}</p>}</article>) : <p className="cc4-muted">{copy.notClaimed}</p>}</section>
          <TaskEvidence task={selectedTask} detail={taskDetail?.task.id === selectedTask.id ? taskDetail : undefined} />
          {selectedTask.status === "awaiting-review" && <section className="cc4-review"><b>{copy.reviewTitle}</b><p>{copy.reviewLead}</p>{taskDetail?.verification.status !== "passed" && <p className="cc4-warning">{copy.reviewIncomplete}</p>}<textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder={copy.reviewNotePlaceholder} /><div><button disabled={Boolean(busy)} onClick={() => void taskAction("approve")}>{copy.approve}</button><button disabled={Boolean(busy)} onClick={() => void taskAction("revalidate")}>{taskDetail?.verification.status === "passed" ? copy.revalidateAgain : copy.revalidate}</button><button className="secondary" disabled={Boolean(busy)} onClick={() => void taskAction("reject")}>{copy.reject}</button></div></section>}
          <div className="cc4-actions">{["queued","running","awaiting-review"].includes(selectedTask.status) && <button className="danger" disabled={Boolean(busy)} onClick={() => void taskAction("cancel")}>{copy.cancelTask}</button>}{(selectedTask.status === "failed" || selectedTask.status === "cancelled") && <><button onClick={() => void taskAction("retry")}>{copy.retryTask}</button><button className="secondary" onClick={() => void taskAction("rebuild")}>{copy.rebuild}</button></>}{["completed","failed","rejected","cancelled"].includes(selectedTask.status) && <button className="ghost" onClick={() => void taskAction("archive")}>{copy.archive}</button>}</div>
        </> : selectedProposal ? <>
          <div className="cc4-title"><div><span>PROPOSAL</span><h3>{selectedProposal.title}</h3><p>{selectedProposal.description}</p></div><span className={`cc4-status ${selectedProposal.status}`}>{selectedProposal.status === "duplicate" ? copy.duplicateProposal : selectedProposal.status}</span></div>
          {selectedProposal.status === "duplicate" && <section className="cc4-error"><b>{copy.noTaskCreated}</b><p>{copy.duplicateOf(displayName(capabilityById.get(selectedProposal.duplicateCapabilityId || "")) || selectedProposal.duplicateCapabilityId || copy.existingCapability)}</p></section>}
          {selectedProposal.status === "blocked" && <section className="cc4-error"><b>{copy.blockedTitle}</b><p>{String((selectedProposal.analysis?.feasibility as Record<string, unknown> | undefined)?.summary || copy.blockedFallback)}</p></section>}
          <JsonContract title={copy.aiAnalysis} value={selectedProposal.analysis || { status: selectedProposal.status }} />
          <div className="cc4-actions">{selectedProposal.status === "blocked" && <button onClick={() => { const reason = window.prompt(copy.forcePrompt, copy.forceDefault); if (reason !== null) void runAction("proposal:force", () => capabilityCenterApi.forceProposalTask(overview.id, selectedProposal.id, reason), copy.forced); }}>{copy.force}</button>}<button onClick={() => void runAction("proposal:archive", () => capabilityCenterApi.archiveProposal(overview.id, selectedProposal.id), copy.proposalArchived)}>{copy.archiveProposal}</button><button className="danger" onClick={() => void runAction("proposal:delete", () => capabilityCenterApi.deleteProposal(overview.id, selectedProposal.id), copy.proposalDeleted)}>{copy.deleteProposal}</button></div>
        </> : <div className="cc4-empty large">{copy.pickTaskOrProposal}</div>}
      </main>
    </div>}

    {module === "capabilities" && <div className="cc4-layout">
      <aside className="cc4-sidebar"><input className="cc4-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.searchPlaceholder} /><div className="cc4-list">{filteredCapabilities.map((capability) => <button key={capability.id} className={selectedCapabilityId === capability.id ? "selected" : ""} onClick={() => { setSelectedCapabilityId(capability.id); const url = new URL(window.location.href); url.searchParams.set("capability", capability.id); window.history.replaceState({}, "", url); }}><span className={`cc4-dot ${capability.status}`}></span><div><b>{displayName(capability)}</b><small>{capability.localizedNames.zhCN} · {capability.localizedNames.en}</small></div><strong>{capabilityStatus()[capability.status] || capability.status}</strong></button>)}</div></aside>
      <main className="cc4-detail">{detail ? <>
        <div className="cc4-title"><div><span>{detail.capability.stableKey}</span><h3>{displayName(detail.capability)}</h3><p className="cc4-bilingual-name"><b>{copy.chinese}</b>{detail.capability.localizedNames.zhCN}<i></i><b>{copy.english}</b>{detail.capability.localizedNames.en}</p><p>{detail.capability.description}</p></div><span className={`cc4-status ${detail.capability.status}`}>{capabilityStatus()[detail.capability.status]}</span></div>
        <section className="cc4-section"><h4>{copy.contractTitle}</h4><p className="cc4-muted">{copy.contractLead}</p><div className="cc4-json-grid"><JsonContract title={copy.inputContract} value={detail.capability.inputSchema} /><JsonContract title={copy.outputContract} value={detail.capability.outputSchema} /></div></section>
        <section className="cc4-section"><h4>{copy.versionsTitle}</h4><div className="cc4-version-list">{detail.versions.map((version) => <article key={version.id}><b>v{version.version}</b><span>{version.status}</span><small>{copy.versionValidation(version.validation?.status || "pending", dateTime(version.updatedAt))}</small></article>)}</div></section>
        <section className="cc4-section"><h4>{copy.executionTitle}</h4><div className="cc4-execution-grid"><article><b>{copy.userExecutions}</b><strong>{detail.userExecutions.length}</strong><small>{copy.userExecutionsHint}</small></article><article><b>{copy.systemValidations}</b><strong>{detail.systemValidations.length}</strong><small>{copy.systemValidationsHint}</small></article></div></section>
        {selectedCapabilityHasActiveTask && <p className="cc4-warning">{copy.hasActiveTask}</p>}
        <div className="cc4-actions"><button disabled={!detail.capability.currentVersionId || Boolean(busy)} onClick={() => void startValidation()}>{copy.validateCurrent}</button>{(detail.capability.status === "active" || detail.capability.status === "degraded") && <button className="secondary" onClick={() => void capabilityAction("unpublish")}>{copy.unpublish}</button>}{detail.capability.status === "unpublished" && <button onClick={() => void capabilityAction("relist")}>{copy.relist}</button>}<button className="danger" disabled={selectedCapabilityHasActiveTask || Boolean(busy)} onClick={() => void capabilityAction("delete")}>{copy.deleteForever}</button></div>
      </> : <div className="cc4-empty large">{copy.pickCapability}</div>}</main>
    </div>}

    {module === "runners" && <RunnerManagement mode={runnerMode} siteAgentId={overview.id} siteAgentIdFilter={overview.id} sites={[{ id: overview.id, name: overview.profile.name }]} onModeChange={onRunnerModeChange} />}
  </div>;
}
