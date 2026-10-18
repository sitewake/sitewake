"use client";

import { useEffect, useMemo, useState } from "react";
import { type OverviewResponse, type Tab } from "../../lib/console/route";
import { productCopy } from "../../lib/console/product-copy";
import { overviewCopy } from "../../lib/console/overview-copy";
import type { EffectRunFact } from "../../lib/site-knowledge/effect-types";
import type { Locale } from "../../lib/i18n";
import { deriveAgentConfigFromKnowledge, normalizeAgentConfig, type SitePreviewJobSummary, type SitePreviewResult } from "../../lib/site-knowledge/protocol";
import { resolveChromeCopy } from "../../client/user-agent-copy";
import { EmptyState } from "../ui";

export function LivingOverview({ overview, onTab, onReload, locale }: { overview: OverviewResponse; onTab(tab: Tab): void; onReload(): void; locale: Locale }) {
  const copy = overviewCopy(locale);
  const ui = productCopy(locale);
  const [preview, setPreview] = useState<SitePreviewResult | undefined>(overview.sitePreview);
  const [job, setJob] = useState<SitePreviewJobSummary | undefined>(overview.sitePreviewJob);
  const [refreshing, setRefreshing] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const agentConfig = normalizeAgentConfig(overview.activeRelease.agentConfig, deriveAgentConfigFromKnowledge(overview.activeRelease));
  // The top-level brand/copy hold one language — whichever the generator preferred —
  // so reading them directly showed this reader the other language's sentences. The
  // same resolver the widget and the agent settings use picks this reader's set.
  const chrome = resolveChromeCopy(agentConfig, locale);
  // The Capability Center is the only source here, because it is what the button
  // beside this card opens. Merging it with the release's own `capabilities` gave the
  // card a second, older list that the tab does not read, so the two could name
  // different capabilities for the same site. Newest first, three of them.
  const [capabilities, setCapabilities] = useState<Array<{ id: string; name: string; description: string; createdAt: string }>>([]);
  // Read from the session history, which is what the button beside this list opens.
  // The overview response carries episodes instead, and an episode is one attempt at
  // a task, not a session: a site whose visitors are answered from knowledge has
  // conversations and no episodes at all, so this card sat empty under a heading that
  // said "recent sessions" while the sessions tab listed eleven of them.
  const [sessions, setSessions] = useState<EffectRunFact[]>([]);
  const pending = job?.status === "queued" || job?.status === "leased" || job?.status === "running";
  function formatTime(value?: string) {
    if (!value || !Number.isFinite(Date.parse(value))) return "—";
    return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  }

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/site-agents/${encodeURIComponent(overview.id)}/session-history?limit=3`, { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("session_history_failed")))
      .then((payload: { records?: EffectRunFact[] }) => {
        if (!controller.signal.aborted) setSessions(payload.records || []);
      })
      // Falling back to the episodes in the overview response is what produced the
      // disagreement in the first place; an empty card is honest, a different list is not.
      .catch(() => { /* the empty state below still renders */ });
    return () => controller.abort();
  }, [overview.id]);

  useEffect(() => { setPreview(overview.sitePreview); setJob(overview.sitePreviewJob); }, [overview.sitePreview, overview.sitePreviewJob]);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/admin/capability-v2/capabilities?siteId=${encodeURIComponent(overview.id)}`, { cache: "no-store", signal: controller.signal, headers: { "x-sitewake-site-id": overview.id } })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("capabilities_failed")))
      .then((payload: { capabilities?: Array<{ id: string; name: string; description?: string; status?: string; currentVersionId?: string; createdAt?: string }> }) => {
        if (controller.signal.aborted) return;
        setCapabilities((payload.capabilities || [])
          // "Reusable" is the claim this card makes: published, and with a version to run.
          .filter((capability) => capability.status === "Active" && capability.currentVersionId)
          .map((capability) => ({ id: capability.id, name: capability.name, description: capability.description || "", createdAt: capability.createdAt || "" }))
          // Sorted here rather than trusted from the server, so three of four is the
          // three newest whatever order the endpoint happens to return.
          .sort((left, right) => (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0)));
      })
      .catch(() => { /* the empty state below still renders */ });
    return () => controller.abort();
  }, [overview.id]);
  useEffect(() => {
    if (!pending) return;
    const controller = new AbortController();
    let inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const response = await fetch(`/api/site-agents/${encodeURIComponent(overview.id)}/preview`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("preview_failed");
        const payload = await response.json() as { preview?: SitePreviewResult; job?: SitePreviewJobSummary };
        if (controller.signal.aborted) return;
        if (payload.preview) setPreview(payload.preview);
        setJob(payload.job); setPreviewError("");
        if (!payload.job || payload.job.status === "succeeded" || payload.job.status === "failed") { setRefreshing(false); onReload(); }
      } catch { if (!controller.signal.aborted) setPreviewError(copy.pollFailed); }
      finally { inFlight = false; }
    }, 2000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [overview.id, onReload, pending, copy.pollFailed]);

  async function refreshPreview() {
    setRefreshing(true); setPreviewError("");
    try {
      const response = await fetch(`/api/site-agents/${encodeURIComponent(overview.id)}/preview`, { method: "POST" });
      if (!response.ok) throw new Error("preview_failed");
      const payload = await response.json() as { job: SitePreviewJobSummary };
      setJob(payload.job);
    } catch { setPreviewError(copy.previewStartFailed); }
    finally { setRefreshing(false); }
  }
  return <section className="sw-overview-v2">
    {/* Installation-wide, so it sits above the site's own cards; the form is in Settings › Models. */}
    {overview.modelConfigured === false && <div className="sw-overview-model-missing" role="status"><span>{copy.modelMissing}</span><button type="button" onClick={() => { const url = new URL(window.location.href); url.searchParams.set("section", "runtime"); window.history.replaceState(window.history.state, "", url); onTab("settings"); }}>{copy.modelMissingAction} →</button></div>}
    <div className="sw-overview-grid">
      <section className="sw-preview-panel">
        <header><div><h3>{copy.preview}</h3><p>{preview ? `${ui.previewCaption} · ${formatTime(preview.capturedAt)}` : pending ? copy.generating : copy.notGenerated}</p></div><button onClick={() => void refreshPreview()} disabled={refreshing || pending}>{refreshing || pending ? copy.generating : preview ? copy.refresh : copy.generate}</button></header>
        <div className="sw-preview-frame">
          {preview ? <img src={preview.url} alt={`${overview.profile.name} — ${copy.preview}`} /> : <EmptyState title={pending ? copy.generating : copy.noPreview} text={copy.previewHint} />}
          {pending && preview && <div className="sw-preview-progress">{copy.keeping}</div>}
        </div>
        <footer>{preview && <span className={preview.agentDetected ? "detected" : "not-detected"}><i />{preview.agentDetected ? copy.detected : copy.notDetected}</span>}{job?.status === "failed" && <span className="failed">{preview ? copy.refreshFailed : copy.previewFailed}</span>}{previewError && <span className="failed" role="status">{previewError}</span>}<button type="button" onClick={() => onTab("connection")}>{ui.viewSettings} →</button></footer>
      </section>
      <aside className="sw-overview-side">
        <section className="sw-overview-card sw-agent-summary"><header><h3>{copy.agent}</h3><button onClick={() => onTab("agent")}>{copy.edit}</button></header><div className="sw-summary-identity"><img src="/brand/sitewake-mark.svg?v=wstar-1" alt="" /><div><h4>{chrome.displayName}</h4><p>{chrome.welcomeTitle}</p></div></div><dl><div><dt>{copy.position}</dt><dd>{agentConfig.appearance?.launcherPosition === "bottom-left" ? copy.left : copy.right}</dd></div><div><dt>{copy.suggestions}</dt><dd>{agentConfig.features.showSuggestions ? copy.show : copy.hide}</dd></div></dl></section>
        <section className="sw-overview-card"><header><h3>{copy.knowledge}</h3><button onClick={() => onTab("model")}>{copy.view}</button></header><p>{overview.profile.description || ui.knowledgeEmpty}</p><div className="sw-overview-facts"><span>{overview.sceneCount} {copy.pages}</span></div></section>
      </aside>
    </div>
    <div className="sw-overview-bottom">
      <section className="sw-overview-card"><header><h3>{copy.sessions}</h3><button onClick={() => onTab("sessions")}>{copy.all} →</button></header>{sessions.length ? <ul className="sw-recent-sessions">{sessions.slice(0, 3).map((run) => <li key={run.runId}><div><b>{run.goal}</b><p>{run.outcomeSummary}</p></div><span data-outcome={run.outcomeStatus}>{copy.status[run.outcomeStatus as keyof typeof copy.status] || copy.status.unknown}</span><time>{formatTime(run.endedAt)}</time></li>)}</ul> : <EmptyState title={copy.noSessions} text={ui.noTasks} />}</section>
      <section className="sw-overview-card"><header><h3>{copy.capabilities}</h3><button onClick={() => onTab("capabilities")}>{copy.all} →</button></header>{capabilities.length ? <ul className="sw-overview-capabilities">{capabilities.slice(0, 3).map((capability) => <li key={capability.id}><span>◇</span><div><b>{capability.name}</b><p>{capability.description || copy.noDescription}</p></div><em>{copy.ready}</em></li>)}</ul> : <EmptyState title={copy.noCapabilities} text={ui.readyTasks} />}</section>
    </div>
  </section>;
}
