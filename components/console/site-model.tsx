"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CrawlJob } from "../../lib/site-knowledge/protocol";
import type { TopologyNode } from "../../lib/site-knowledge/business-topology";
import { knowledgeTopology, type OverviewResponse, type Tab } from "../../lib/console/route";
import { relativeTime } from "../../lib/console/copy";
import {
  areaSummaries,
  knowledgeStatus,
  newPageIds,
  nodeForUrl,
  probeVerdict,
  readState,
  updateHistory,
  type KnowledgeStatus,
  type ProbeResultLike,
  type ReadState,
} from "../../lib/console/knowledge-view";
import { TopologyGraph } from "./topology-graph";
import { ConfirmDialog } from "../ui";
import { activeLocale, t } from "../../lib/i18n";

/**
 * The site knowledge page: the site's page structure and indexed content, which the
 * agent answers from.
 *
 * Three parts, in the order users ask: how much it knows now (top status line), which
 * pages it knows (entry → section graph + section page list + page drawer), and whether
 * it answers correctly (Ask). All state is derived by the pure functions in
 * lib/console/knowledge-view; this file only lays out.
 */

type Environment = "development" | "container" | "cloudflare";
const isActive = (job: CrawlJob) => job.status === "queued" || job.status === "leased" || job.status === "running";

/**
 * Read jobs: one poll shared by the status line, the update log and the "new" badge.
 * Polls only while a job is active; if queued for over 20 s without a lease, backs off
 * to every 30 s.
 */
function useCrawlJobs(siteAgentId: string, onAdopted: () => void) {
  // Dictionary first: the callbacks below are created during render, and referencing a const declared later hits the temporal dead zone.
  const copy = t().knowledge.status;
  const [jobs, setJobs] = useState<CrawlJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(0);
  const lastAdoptedRef = useRef("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/site-agents/${encodeURIComponent(siteAgentId)}/crawl`, { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { jobs?: CrawlJob[] };
      setJobs(data.jobs || []);
    } catch {
      /* transient failure, the next poll retries */
    }
  }, [siteAgentId]);

  const active = jobs.find(isActive);
  const hasActive = Boolean(active);
  const noRunner = active?.status === "queued" && now > 0 && now - Date.parse(active.updatedAt || active.createdAt) > 20_000;

  useEffect(() => {
    const initial = setTimeout(() => { void load(); setNow(Date.now()); }, 0);
    return () => clearTimeout(initial);
  }, [load]);
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => { void load(); }, noRunner ? 30_000 : 3_000);
    return () => clearInterval(timer);
  }, [hasActive, noRunner, load]);
  useEffect(() => {
    if (!hasActive) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [hasActive]);

  const succeeded = jobs.find((job) => job.status === "succeeded");
  useEffect(() => {
    const releaseId = succeeded?.result?.releaseId;
    if (releaseId && lastAdoptedRef.current !== releaseId) {
      lastAdoptedRef.current = releaseId;
      onAdopted();
    }
  }, [succeeded, onAdopted]);

  const start = async (origin: string, entryUrl?: string) => {
    if (!origin) { setMessage(copy.noOrigin); return; }
    setBusy(true); setMessage("");
    try {
      const seeds = (() => {
        try { return entryUrl && new URL(entryUrl).origin === new URL(origin).origin ? [entryUrl] : undefined; } catch { return undefined; }
      })();
      const response = await fetch(`/api/site-agents/${encodeURIComponent(siteAgentId)}/crawl`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin, ...(seeds ? { seeds } : {}) }),
      });
      const data = (await response.json()) as { error?: string; persistence?: string };
      setMessage(!response.ok || data.error ? (data.error || copy.startFailed) : data.persistence === "memory" ? copy.queuedInMemory : "");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : copy.startFailed);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/site-agents/${encodeURIComponent(siteAgentId)}/crawl`, { method: "DELETE" });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error || copy.stopFailed);
      setMessage("");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : copy.stopFailed);
    } finally {
      setBusy(false);
    }
  };

  return { jobs, busy, message, now, noRunner, start, stop };
}

/** Only for the "no local reader" hint; should not happen in production, and this page's user could not fix it anyway. */
function useEnvironment(): Environment | undefined {
  const [environment, setEnvironment] = useState<Environment>();
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/system/status", { cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((data: { environment?: Environment } | undefined) => { if (data?.environment) setEnvironment(data.environment); })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  return environment;
}

type StatusView = { text: string; hint?: string; action?: { label: string; onClick: () => void; disabled?: boolean } };

function statusView(
  status: KnowledgeStatus,
  copy: ReturnType<typeof t>["knowledge"]["status"],
  actions: { start(): void; stop(): void; help?(): void; busy: boolean },
): StatusView {
  const span = (minutes: number) => (minutes >= 60 ? copy.spanHours(Math.round(minutes / 60)) : copy.spanMinutes(minutes));
  const withNew = (text: string, count?: number) => (count ? `${text} · ${copy.newScenes(count)}` : text);
  const reread = { label: copy.reread, onClick: actions.start, disabled: actions.busy };
  const readAgain = { label: copy.readAgain, onClick: actions.start, disabled: actions.busy };
  switch (status.kind) {
    case "never":
      return { text: copy.never, hint: copy.neverHint, action: { label: copy.readNow, onClick: actions.start, disabled: actions.busy } };
    case "reading":
      return { text: `${copy.reading} ${copy.elapsed(Math.floor(status.elapsedSeconds / 60), status.elapsedSeconds % 60)}`, action: { label: copy.stop, onClick: actions.stop, disabled: actions.busy } };
    case "empty":
      return { text: copy.empty, action: actions.help ? { label: copy.howTo, onClick: actions.help } : undefined };
    case "failed":
      return { text: copy.failed(status.reason), action: { label: copy.retry, onClick: actions.start, disabled: actions.busy } };
    case "first-read":
      return { text: withNew(copy.firstRead(status.pages), status.newScenes), action: readAgain };
    case "needs-one-more":
      return { text: withNew(copy.needsOneMore(status.pagesNeedingMore), status.newScenes), action: readAgain };
    case "interval-too-short":
      return { text: withNew(copy.intervalTooShort(relativeTime(status.finishedAt), span(status.intervalMinutes)), status.newScenes), action: reread };
    case "steady":
      return status.finishedAt
        ? { text: withNew(copy.steady(relativeTime(status.finishedAt), status.pages), status.newScenes), action: reread }
        : { text: copy.steadyNoRead(status.pages), action: { label: copy.readNow, onClick: actions.start, disabled: actions.busy } };
  }
}

/** Ask: one question, four kinds of result. */
function AskProbe({ siteAgentId, modelConfigured, nodes, onPick }: { siteAgentId: string; modelConfigured?: boolean; nodes: TopologyNode[]; onPick(sceneId: string): void }) {
  const copy = t().knowledge.probe;
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<ProbeResultLike | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    const trimmed = question.trim();
    if (!trimmed) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/site-agents/${encodeURIComponent(siteAgentId)}/knowledge-probe?question=${encodeURIComponent(trimmed)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || data.error) { setError(data.error || copy.failed); setResult(null); return; }
      setResult(data as ProbeResultLike);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy.failed); setResult(null);
    } finally { setBusy(false); }
  };

  const verdict = result ? probeVerdict(result, (url) => nodeForUrl(nodes, url)) : undefined;
  return (
    <div className="kc-probe">
      <div className="kc-probe-bar">
        <input
          type="text" value={question} placeholder={copy.placeholder}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void run(); }}
        />
        <button className="kc-btn" disabled={busy || !question.trim()} onClick={() => void run()}>{busy ? copy.asking : copy.ask}</button>
      </div>
      {modelConfigured === false && <p className="kc-msg">{copy.noModel}</p>}
      {error && <p className="kc-msg">{error}</p>}
      {verdict && (
        <div className="kc-facts">
          {verdict.quotes.length > 0 && (
            <div className="kc-fact">
              <span className="k">{copy.quoteLabel}</span>
              <div className="kc-quotes">
                {verdict.quotes.map((quote) => (
                  <blockquote key={quote.text}>
                    <p>{quote.text}</p>
                    {/* i18n-exempt:中点只是页面名之间的分隔符，随页面名一起属于数据 */}
                    <cite>{copy.appearsOn} {quote.pages.join(" · ")}</cite>
                  </blockquote>
                ))}
              </div>
            </div>
          )}
          {/* 有原话时不再列相关页面：原话下面的「出现在」已经说清出处，再列一遍只是噪音。 */}
          {!verdict.quotes.length && verdict.pages.length > 0 && (
            <div className="kc-fact">
              <span className="k">{copy.relatedPages}</span>
              <ul>
                {verdict.pages.map((page) => (
                  <li key={page.name}>
                    {page.sceneId
                      ? <button type="button" className="link" onClick={() => onPick(page.sceneId!)}>{page.name}</button>
                      : <span className="nm">{page.name}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!verdict.quotes.length && !verdict.pages.length && (
            <p className="kc-msg">{verdict.termsAppearElsewhere ? copy.termsElsewhere : copy.nothing}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function SiteModel({ overview, onReload, onTab }: { overview: OverviewResponse; onReload(): void; onTab?(tab: Tab): void }) {
  // Dictionary at the very top of the component: the useMemo below runs synchronously
  // during render, and referencing a const declared after it hits the temporal dead zone
  // ("Cannot access 'X' before initialization") and blanks the page. Guarded by
  // tests/i18n-tdz.test.mjs.
  const copy = t().knowledge;
  const topology = useMemo(() => knowledgeTopology(overview), [overview]);
  const coverage = overview.contentCoverage;
  const profile = overview.activeRelease.profile;
  const origin = overview.connection?.origin || profile.entryUrl || profile.allowedOrigins?.[0] || "";
  const crawl = useCrawlJobs(overview.id, onReload);
  const environment = useEnvironment();
  // The clock comes from hook state (written by an effect after mount); no Date.now during render.
  const now = crawl.now;

  const status = useMemo(() => knowledgeStatus({ pages: topology.nodes.length, jobs: crawl.jobs, now }), [topology, crawl.jobs, now]);
  const newIds = useMemo(() => newPageIds(topology.nodes, crawl.jobs), [topology, crawl.jobs]);
  const areas = useMemo(() => areaSummaries(topology, coverage, newIds), [topology, coverage, newIds]);
  const history = useMemo(() => updateHistory(crawl.jobs), [crawl.jobs]);
  const nodeById = useMemo(() => new Map(topology.nodes.map((node) => [node.id, node])), [topology]);

  // The section containing the home page is the default: something to see on arrival, no click needed.
  // i18n-exempt: matches the customer site's own page names, which are data
  const home = topology.nodes.find((node) => node.path === "/") || topology.nodes.find((node) => node.name.includes("首页"));
  const homeAreaId = home?.areaId || areas[0]?.id || "";
  const [areaId, setAreaId] = useState("");
  const [pageId, setPageId] = useState("");
  // Stopping a read discards minutes of work in progress; confirm per the repo's destructive-action rule (tests/console-destructive-actions).
  const [confirmingStop, setConfirmingStop] = useState(false);
  const busy = crawl.busy;
  const cancelCrawl = async () => {
    await crawl.stop();
    setConfirmingStop(false);
  };
  const currentAreaId = areas.some((area) => area.id === areaId) ? areaId : homeAreaId;
  const currentArea = areas.find((area) => area.id === currentAreaId);
  const selected = pageId ? nodeById.get(pageId) : undefined;

  const selectArea = (id: string) => {
    setAreaId(id);
    if (selected && selected.areaId !== id) setPageId("");
  };
  const selectRoot = () => {
    if (!home) return;
    setAreaId(home.areaId);
    setPageId(home.id);
  };
  const pickPage = (sceneId: string) => {
    const node = nodeById.get(sceneId);
    if (!node) return;
    setAreaId(node.areaId);
    setPageId(node.id);
  };

  useEffect(() => {
    if (!selected) return;
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setPageId(""); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const rows = useMemo(
    () => (currentArea?.nodeIds || []).map((id) => nodeById.get(id)).filter((node): node is TopologyNode => Boolean(node))
      .map((node) => ({ node, ...readState(node, coverage), isNew: newIds.has(node.id) })),
    [currentArea, nodeById, coverage, newIds],
  );

  // Related pages: deduplicated by the page at the other end, keeping only direction and name.
  const related = useMemo(() => {
    if (!selected) return [] as Array<{ id: string; outbound: boolean; name: string }>;
    const merged = new Map<string, { id: string; outbound: boolean; name: string }>();
    for (const edge of [...topology.primaryEdges, ...topology.secondaryEdges]) {
      if (edge.kind === "business-flow") continue;
      const outbound = edge.from === selected.id;
      if (!outbound && edge.to !== selected.id) continue;
      const otherId = outbound ? edge.to : edge.from;
      if (otherId === selected.id) continue;
      const key = `${outbound ? "o" : "i"}:${otherId}`;
      if (!merged.has(key)) merged.set(key, { id: key, outbound, name: nodeById.get(otherId)?.name || copy.drawer.entryFallback });
    }
    return [...merged.values()].slice(0, 8);
  }, [selected, topology, nodeById, copy]);

  // "Content read" in the drawer: fetches the page's body paragraphs on demand when selected.
  const [pageContent, setPageContent] = useState<Array<{ url: string; headingPath?: string; text: string }> | null>(null);
  const [contentBusy, setContentBusy] = useState(false);
  const contentPath = selected?.path || "";
  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(() => {
      if (!contentPath) { setPageContent(null); setContentBusy(false); return; }
      setContentBusy(true);
      fetch(`/api/site-agents/${encodeURIComponent(overview.id)}/content?path=${encodeURIComponent(contentPath)}`, { cache: "no-store" })
        .then((response) => response.json())
        .then((data) => { if (alive) setPageContent(Array.isArray(data.chunks) ? data.chunks : []); })
        .catch(() => { if (alive) setPageContent([]); })
        .finally(() => { if (alive) setContentBusy(false); });
    }, 0);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [contentPath, overview.id]);

  const view = statusView(status, copy.status, {
    start: () => void crawl.start(origin, profile.entryUrl),
    stop: () => setConfirmingStop(true),
    help: onTab ? () => onTab("connection") : undefined,
    busy,
  });
  const stopDialog = (
    <ConfirmDialog
      open={confirmingStop}
      title={t().confirm.cancelCrawl.title}
      body={<><p>{t().confirm.cancelCrawl.consequence}</p><p>{t().confirm.cancelCrawl.reversibility}</p></>}
      confirmLabel={t().confirm.cancelCrawl.confirmLabel}
      busy={busy}
      onConfirm={() => void cancelCrawl()}
      onCancel={() => setConfirmingStop(false)}
    />
  );
  const statusLine = (
    <div className={`kc-status ${status.kind}`} role="status">
      <div>
        <span className="txt">{view.text}</span>
        {view.hint && <span className="hint">{view.hint}</span>}
        {crawl.message && <span className="msg">{crawl.message}</span>}
      </div>
      {view.action && <button type="button" className="kc-btn sm" onClick={view.action.onClick} disabled={view.action.disabled}>{view.action.label}</button>}
    </div>
  );
  const devHint = environment === "development" && crawl.noRunner ? <p className="kc-status-dev">{copy.status.devNoRunner}</p> : null;

  /*
    Not read yet (or read but no pages): the page structure is laid out as usual, each
    part explaining what will appear once read. Previously only one card remained and
    users saw a blank, unsure what the page would look like or whether they were in the
    wrong place. The status line already carries that hint and the "read now" action, so
    no extra card.
  */
  const unread = !topology.nodes.length;

  const stateLabel = (state: ReadState) => copy.state[state];
  // Only explain "why not indexed"; indexed pages get no note, that would be noise.
  const reasonText = (row: { state: ReadState; reason: ReturnType<typeof readState>["reason"] }, node: TopologyNode) => {
    switch (row.reason) {
      case "failed": return copy.drawer.reason.failed(node.entryFault);
      case "needs-reverify": return copy.drawer.reason.needsReverify(node.entryFault);
      case "referenced": return copy.drawer.reason.referenced;
      case "no-content": return copy.drawer.reason.noContent;
      default: return "";
    }
  };
  const selectedRow = selected ? { node: selected, ...readState(selected, coverage), isNew: newIds.has(selected.id) } : undefined;
  const grouped = (pageContent || []).reduce((map, chunk) => {
    map.set(chunk.url, [...(map.get(chunk.url) || []), chunk]);
    return map;
  }, new Map<string, Array<{ headingPath?: string; text: string }>>());

  return (
    <div className="kc-page">
      <div className="kc-head">
        <div>
          <h3>{profile.name}{profile.category ? ` · ${profile.category}` : ""}</h3>
          <p>{copy.intro}</p>
        </div>
      </div>
      {statusLine}
      {devHint}
      {history.length > 0 && (
        <details className="kc-history">
          <summary>{copy.history.title}</summary>
          <ul>
            {history.map((record) => (
              <li key={record.at}>{copy.history.line(relativeTime(record.at), record.pages)}{record.purged ? copy.history.purged(record.purged) : ""}</li>
            ))}
          </ul>
        </details>
      )}

      <section className="kc-section">
        <div className="kc-section-head"><div><h2>{copy.graph.title}</h2></div></div>
        {unread ? (
          <div className="kc-wb kc-wb-unread">
            <div className="kc-unread">
              <b>{copy.graph.unreadTitle}</b>
              <p>{copy.graph.unreadHint}</p>
            </div>
          </div>
        ) : (
        <div className={`kc-wb${selected ? " has-drawer" : ""}`}>
          <div className="kc-map">
            <TopologyGraph rootName={profile.name} areas={areas} selectedId={currentAreaId} onSelectArea={selectArea} onSelectRoot={home ? selectRoot : undefined} />
          </div>
          <div className="kc-list">
            <div className="kc-list-head">
              <b>{currentArea?.name}</b>
              <span>{currentArea?.total ?? 0}</span>
            </div>
            <div className="kc-rows">
              {rows.length ? rows.map(({ node, state, isNew }) => (
                <button key={node.id} type="button" className={`kc-row${pageId === node.id ? " active" : ""}`} onClick={() => setPageId(node.id)}>
                  <i className={`kc-dot ${state}`} aria-hidden="true" />
                  <span className="nm">{node.name}{isNew && <i className="kc-badge">{copy.state.isNew}</i>}</span>
                  <code>{node.path}{node.path.includes("{") && node.instanceCount > 1 ? ` ${copy.list.pages(node.instanceCount.toLocaleString(activeLocale()))}` : ""}</code>
                  {state === "read" && <span className="kc-state read">{stateLabel(state)}</span>}
                </button>
              )) : <p className="kc-list-empty">{copy.list.empty}</p>}
            </div>
          </div>
          {selected && selectedRow && (
        <aside className="kc-drawer" role="dialog" aria-label={selected.name}>
          <div className="kc-drawer-head">
            <div>
              <div className="eyebrow">{areas.find((area) => area.id === selected.areaId)?.name}</div>
              <h3>{selected.name}{selectedRow.isNew && <i className="kc-badge">{copy.state.isNew}</i>}</h3>
              <code>{selected.path}</code>
            </div>
            <div className="chips">
              {selectedRow.state === "read" && <span className="kc-state read">{stateLabel(selectedRow.state)}</span>}
              <button type="button" className="kc-close" onClick={() => setPageId("")} aria-label={copy.drawer.close}>×</button>
            </div>
          </div>
          <div className="kc-field">
            <span className="k">{copy.drawer.aboutLabel}</span>
            <p>{selected.description || copy.drawer.aboutFallback}</p>
            {selectedRow.state !== "read" && <span className={`note${selectedRow.state === "blocked" ? " warn" : ""}`}>{reasonText(selectedRow, selected)}</span>}
          </div>
          <div className="kc-field">
            <span className="k">{copy.drawer.relatedLabel}</span>
            <div className="kc-edges">
              {related.map((edge) => (
                <div className="kc-edge" key={edge.id}>
                  <i>{edge.outbound ? copy.drawer.outbound : copy.drawer.inbound}</i>
                  <span className="nm">{edge.name}</span>
                </div>
              ))}
              {!related.length && <span className="empty">{copy.drawer.noRelated}</span>}
            </div>
          </div>
          <details className="kc-content">
            <summary>
              {copy.drawer.contentLabel} · {contentBusy && !pageContent ? copy.drawer.contentLoading : pageContent && pageContent.length ? copy.drawer.contentCount(pageContent.length) : copy.drawer.contentEmpty}
            </summary>
            <div className="kc-excerpt">
              {grouped.size ? [...grouped.entries()].map(([url, chunks]) => (
                <div key={url}>
                  {grouped.size > 1 && <code>{(() => { try { return decodeURIComponent(new URL(url).pathname); } catch { return url; } })()}</code>}
                  {chunks.map((chunk, index) => (
                    <div key={index}>{chunk.headingPath && <b>{chunk.headingPath}</b>}<p>{chunk.text}</p></div>
                  ))}
                </div>
              )) : <span className="empty">{copy.drawer.contentEmpty}</span>}
            </div>
          </details>
        </aside>
          )}
        </div>
        )}
      </section>

      <section className="kc-section">
        <div className="kc-section-head"><div><h2>{copy.probe.title}</h2><p className="sub">{copy.probe.sub}</p></div></div>
        {unread
          ? <div className="kc-unread"><p>{copy.probe.unreadHint}</p></div>
          : <AskProbe siteAgentId={overview.id} modelConfigured={overview.modelConfigured} nodes={topology.nodes} onPick={pickPage} />}
      </section>
      {stopDialog}
    </div>
  );
}
