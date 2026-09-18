"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { activeLocale, t, type Locale } from "../../lib/i18n";
import { productCopy } from "../../lib/console/product-copy";
import { sessionCopy } from "../../lib/console/session-copy";
import { overviewCopy } from "../../lib/console/overview-copy";
import type { EffectRunDetail, EffectRunFact, EffectRunList } from "../../lib/site-knowledge/effect-types";
import { experienceIntakeLabel, type CapabilityExperienceIntake } from "../../lib/capability-center-v2/experience-intake";
import { DomReplayPlayer } from "../dom-replay-player";
import { EmptyState, Spinner } from "../ui";

type SessionDetail = Pick<EffectRunDetail, "fact" | "conversation" | "activityTimeline" | "replayChunks">;

export function SessionHistory({ siteAgentId, locale = activeLocale() }: { siteAgentId: string; locale?: Locale }) {
  const copy = sessionCopy(locale);
  const ui = productCopy(locale);
  const intake = t(locale).capability.v2.intake;
  const initialRun = useRef(typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("run") || "");
  const [reading, setReading] = useState(Boolean(initialRun.current));
  const [linkMessage, setLinkMessage] = useState("");
  const outcomes = overviewCopy(locale).status;
  function statusLabel(fact: EffectRunFact) {
    if (fact.status === "cancelled") return copy.cancelled;
    return outcomes[fact.outcomeStatus as keyof typeof outcomes] || outcomes.unknown;
  }
  function shortTime(value: string) {
    if (!value || !Number.isFinite(Date.parse(value))) return "—";
    return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  }
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [records, setRecords] = useState<EffectRunFact[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string>();
  const cursorRef = useRef<string | undefined>(undefined);
  const listRequest = useRef<AbortController | null>(null);
  const [selectedId, setSelectedId] = useState(initialRun.current);
  const [loadedDetail, setLoadedDetail] = useState<{ id: string; value: SessionDetail }>();
  const detail = loadedDetail?.id === selectedId ? loadedDetail.value : undefined;
  const [detailError, setDetailError] = useState<{ id: string; message: string }>();
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [intakeState, setIntakeState] = useState<{ runId: string; items: CapabilityExperienceIntake[]; failed?: boolean }>();
  const [detailTab, setDetailTab] = useState<"conversation" | "activity">("conversation");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (append = false) => {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ limit: "30" });
    if (query.trim()) params.set("query", query.trim());
    if (status !== "all") params.set("status", status);
    if (append && cursorRef.current) params.set("cursor", cursorRef.current);
    try {
      const response = await fetch(`/api/site-agents/${encodeURIComponent(siteAgentId)}/session-history?${params}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("load_failed");
      const payload = await response.json() as EffectRunList;
      if (controller.signal.aborted) return;
      setRecords((current) => append ? [...new Map([...current, ...payload.records].map((item) => [item.runId, item])).values()] : payload.records);
      setTotal(payload.total);
      setCursor(payload.nextCursor);
      cursorRef.current = payload.nextCursor;
      if (!append) {
        const requestedRun = initialRun.current;
        setSelectedId((current) => requestedRun || (payload.records.some((item) => item.runId === current) ? current : payload.records[0]?.runId || ""));
        initialRun.current = "";
      }
    } catch {
      if (!controller.signal.aborted) setError(copy.listError);
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [query, siteAgentId, status, copy.listError]);

  useEffect(() => {
    const timer = setTimeout(() => void load(false), 180);
    return () => { clearTimeout(timer); listRequest.current?.abort(); };
  }, [load]);
  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    setDetailError(undefined);
    void fetch(`/api/site-agents/${encodeURIComponent(siteAgentId)}/session-history/${encodeURIComponent(selectedId)}`, { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("detail_failed")))
      .then((payload: { detail: SessionDetail }) => {
        if (!controller.signal.aborted) setLoadedDetail({ id: selectedId, value: payload.detail });
      })
      .catch(() => { if (!controller.signal.aborted) setDetailError({ id: selectedId, message: copy.detailError }); });
    return () => controller.abort();
  }, [selectedId, siteAgentId, detailAttempt, copy.detailError]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    const loadIntakes = async () => {
      try {
        const response = await fetch(`/api/admin/capability-v2/experiences?siteId=${encodeURIComponent(siteAgentId)}&runId=${encodeURIComponent(selectedId)}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("intake_load_failed");
        const payload = await response.json() as { intakes: CapabilityExperienceIntake[] };
        if (!controller.signal.aborted) setIntakeState({ runId: selectedId, items: payload.intakes });
      } catch { if (!controller.signal.aborted) setIntakeState({ runId: selectedId, items: [], failed: true }); }
    };
    void loadIntakes();
    const timer = window.setInterval(() => void loadIntakes(), 5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [siteAgentId, selectedId]);

  async function copyRecordLink() {
    const url = new URL(window.location.href);
    url.searchParams.set("run", selectedId);
    try { await navigator.clipboard.writeText(url.href); setLinkMessage(ui.copied); }
    catch { setLinkMessage(ui.copyFailed); }
  }
  const outcome = detail?.fact.status === "cancelled" ? "cancelled" : detail?.fact.outcomeStatus;
  return <section className={`sw-session-page sw-session-reader ${reading ? "is-reading" : ""}`} aria-busy={loading}>
    <div className="sw-session-intro"><p className="sw-page-description">{ui.sessionsIntro}</p><button className="sw-text-button" onClick={() => void load(false)} disabled={loading}>{ui.refresh} <span aria-hidden="true">↻</span></button></div>
    <div className="sw-session-layout">
      <aside className="sw-session-sidebar">
        <div className="sw-session-sidebar-heading"><h2>{ui.sessionRecords}</h2><span>{total}</span></div>
        <div className="sw-session-filters">
          <label><span aria-hidden="true">⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder={copy.search} aria-label={copy.search} /></label>
          <select aria-label={copy.status} value={status} onChange={event => setStatus(event.target.value)}><option value="all">{copy.all}</option>{Object.entries(outcomes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="cancelled">{copy.cancelled}</option></select>
        </div>
        {error && <div className="sw-error" role="alert">{error}<button onClick={() => void load(false)}>{copy.retry}</button></div>}
        <div className="sw-session-list">
          {loading && !records.length ? <Spinner label={copy.loading} /> : records.map(item => <button key={item.runId} className={selectedId === item.runId ? "active" : ""} aria-pressed={selectedId === item.runId} onClick={() => { setSelectedId(item.runId); setDetailTab("conversation"); setReading(true); setLinkMessage(""); }}>
            <b>{item.goal || copy.unnamed}</b><p>{item.outcomeSummary || copy.noSummary}</p>
            <div className="sw-session-list-meta"><span data-outcome={item.status === "cancelled" ? "cancelled" : item.outcomeStatus} className={`sw-session-status ${item.status}`}>{statusLabel(item)}</span><time dateTime={item.endedAt}>{shortTime(item.endedAt)}</time></div>
          </button>)}
          {!loading && !error && !records.length && <div className="sw-session-list-empty"><EmptyState title={query.trim() || status !== "all" ? copy.noMatch : copy.empty} text={query.trim() || status !== "all" ? copy.noMatchHint : copy.emptyHint} />{(query.trim() || status !== "all") && <button className="sw-text-button" onClick={() => { setQuery(""); setStatus("all"); }}>{copy.reset}</button>}</div>}
          {cursor && <button className="sw-session-more" disabled={loading} onClick={() => void load(true)}>{loading ? copy.loadingMore : copy.more}</button>}
        </div>
        <p className="sw-session-list-footnote">{ui.recorded}</p>
      </aside>
      <article className="sw-session-detail">
        <button className="sw-session-back sw-text-button" onClick={() => setReading(false)}>← {ui.back}</button>
        {!selectedId ? <div className="sw-session-pick"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M10 11h28v22H21l-11 7V11Z"/><path d="M17 19h14M17 25h10"/></svg><EmptyState title={ui.noSessionSelected} text={ui.readConversation} /></div> : detailError?.id === selectedId ? <div className="sw-session-detail-error" role="alert"><p>{detailError.message}</p><button onClick={() => setDetailAttempt(attempt => attempt + 1)}>{copy.retry}</button></div> : !detail ? <Spinner label={copy.loadingDetail} /> : <>
          <header><div><h2>{detail.fact.goal || copy.unnamed}</h2><div className="sw-session-detail-meta"><time dateTime={detail.fact.startedAt}>{shortTime(detail.fact.startedAt)}</time>{Number.isFinite(detail.fact.durationMs) && <span>{ui.duration} {Math.max(1, Math.round(detail.fact.durationMs / 1000))} {ui.seconds}</span>}</div></div><span data-outcome={outcome} className={`sw-session-status ${detail.fact.status}`}>{statusLabel(detail.fact)}</span></header>
          {intakeState?.runId === selectedId && <div className="sw-session-result" role="status"><span>{intake.sessionTitle}</span><p>{intakeState.failed ? intake.sessionUnavailable : intakeState.items.length ? intakeState.items.map((item) => experienceIntakeLabel(item, locale)).join(" · ") : intake.sessionNone} <a href={`/?site=${encodeURIComponent(siteAgentId)}&view=capabilities&intake=${encodeURIComponent(selectedId)}`}>{intake.sessionOpen}</a></p></div>}
          <div className="sw-session-toolbar"><div className="sw-session-tabs" role="group" aria-label={ui.details}><button aria-pressed={detailTab === "conversation"} className={detailTab === "conversation" ? "active" : ""} onClick={() => setDetailTab("conversation")}>{copy.conversation}</button><button aria-pressed={detailTab === "activity"} className={detailTab === "activity" ? "active" : ""} onClick={() => setDetailTab("activity")}>{copy.activity}</button></div><button className="sw-text-button sw-copy-record" onClick={() => void copyRecordLink()}>{linkMessage || ui.recordLink}</button></div>
          <div className="sw-session-reading-pane">
          {/* The result belongs to the conversation; the activity tab is only the process. */}
          {detailTab === "conversation" && <div className="sw-session-result"><span>{ui.result}</span><p>{detail.fact.outcomeSummary || copy.noSummary}</p></div>}
          {detailTab === "conversation" ? <div className="sw-session-conversation">{detail.conversation.length ? detail.conversation.map((turn, index) => <div key={`${turn.at}:${index}`} className={turn.role}><small><span>{turn.role === "user" ? copy.user : copy.agent}</span><time dateTime={turn.at}>{shortTime(turn.at)}</time></small><p>{turn.content}</p></div>) : <EmptyState title={copy.noConversation} text={copy.noConversationHint} />}</div> : <div className="sw-session-activity">
            {detail.replayChunks.length > 0 && <section className="sw-session-replay"><h3>{copy.replay}</h3><DomReplayPlayer chunks={detail.replayChunks} height={360} /></section>}
            <section><h3>{detail.replayChunks.length ? copy.keyActions : copy.activity}</h3>{detail.activityTimeline.length ? <ol>{detail.activityTimeline.map(item => <li key={item.id}><i className={item.state} /><div><b>{item.label}</b>{item.detail && <p>{item.detail}</p>}{item.url && <small title={item.url}>{item.url}</small>}</div><time dateTime={item.createdAt}>{shortTime(item.createdAt)}</time></li>)}</ol> : <EmptyState title={copy.noReplay} text={copy.noReplayHint} />}</section>
          </div>}
          {(detail.fact.startUrl || detail.fact.endUrl) && <details className="sw-session-page-context"><summary>{ui.details}</summary>{detail.fact.startUrl && <p><span>{ui.startPage}</span><span>{detail.fact.startUrl}</span></p>}{detail.fact.endUrl && <p><span>{ui.endPage}</span><span>{detail.fact.endUrl}</span></p>}</details>}
          </div>
        </>}
      </article>
    </div>
  </section>;
}
