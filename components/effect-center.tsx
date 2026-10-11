"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { activeLocale, t } from "@/lib/i18n";
import type {
  CapabilityHandoffEpisodeView,
  EffectAnalysisStatus,
  EffectAttribution,
  EffectGoalStatus,
  EffectSubmissionDetail,
  EffectSubmissionList,
  EffectTrackingSummary,
  SubmissionAnalysis,
} from "../lib/site-knowledge/effect-types";
import type { SiteAgentOverview } from "../lib/site-knowledge/protocol";

/**
 * Vocabulary lives in the shared copy catalog so the wording is reviewable in
 * one place and stays consistent with the rest of the console.
 *
 * Read through a function, never destructured at module scope: `t()` resolves
 * against `<html lang>`, which does not exist yet when this module is first
 * evaluated. Destructuring up here would freeze every label at the default
 * language and leave the page half-translated after a switch.
 */
function labels() {
  return t().effect;
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function dateTime(value: string) {
  // Follow the console's language for month/day order and the 12/24-hour clock.
  return new Date(value).toLocaleString(activeLocale(), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function rangeDates(days: number) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function statusTone(status: EffectAnalysisStatus) {
  return status === "completed"
    ? "ok"
    : status === "failed"
      ? "danger"
      : status === "reviewing"
        ? "review"
        : "pending";
}

function goalTone(status?: EffectGoalStatus) {
  return status === "achieved"
    ? "ok"
    : status === "partially-achieved"
      ? "warn"
      : status === "not-achieved"
        ? "danger"
        : "neutral";
}

function attributionSummary(analysis: SubmissionAnalysis) {
  const { area: AREA_LABELS, issue: ISSUE_LABELS, contribution: CONTRIBUTION_LABELS, page } = labels();
  const material = analysis.attributions.filter(
    (item) =>
      item.used ||
      item.issue !== "none" ||
      item.contribution === "direct" ||
      item.contribution === "supporting",
  );
  if (!material.length) return page.noAttribution;
  return material
    .slice(0, 3)
    .map(
      (item) =>
        `${AREA_LABELS[item.area]} · ${
          item.issue !== "none"
            ? ISSUE_LABELS[item.issue]
            : CONTRIBUTION_LABELS[item.contribution]
        }`,
    )
    .join("；");
}

function recordQuery(input: {
  days: number;
  goalStatus: string;
  issue: string;
  improvement: string;
  analysisStatus: string;
  actorKey: string;
  query: string;
}) {
  const values = new URLSearchParams(rangeDates(input.days));
  if (input.goalStatus !== "all")
    values.set("goalStatus", input.goalStatus);
  if (input.issue !== "all") values.set("issue", input.issue);
  if (input.improvement !== "all")
    values.set("improvement", input.improvement);
  if (input.analysisStatus !== "all")
    values.set("status", input.analysisStatus);
  if (input.actorKey) values.set("actorKey", input.actorKey);
  if (input.query.trim()) values.set("query", input.query.trim());
  return values.toString();
}

function EmptyEffect() {
  const page = labels().page;
  return (
    <div className="effect-tracking-empty">
      <span>◎</span>
      <b>{page.emptyTitle}</b>
      <p>{page.emptyBody}</p>
    </div>
  );
}

export function EffectCenter({
  overview,
}: {
  overview: SiteAgentOverview;
  onOpenCapability(capabilityId?: string): void;
  onOpenKnowledge(): void;
}) {
  const [days, setDays] = useState(30);
  const [goalStatus, setGoalStatus] = useState("all");
  const [issue, setIssue] = useState("all");
  const [improvement, setImprovement] = useState("all");
  const [analysisStatus, setAnalysisStatus] = useState("all");
  const [actorKey, setActorKey] = useState("");
  const [query, setQuery] = useState("");
  const [summary, setSummary] = useState<EffectTrackingSummary>();
  const [records, setRecords] = useState<SubmissionAnalysis[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string>();
  const [detail, setDetail] = useState<EffectSubmissionDetail>();
  const [loading, setLoading] = useState(true);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const {
    goal: GOAL_LABELS,
    analysis: STATUS_LABELS,
    issue: ISSUE_LABELS,
    improvement: IMPROVEMENT_LABELS,
    page,
  } = labels();

  const summaryQuery = useMemo(
    () => new URLSearchParams(rangeDates(days)).toString(),
    [days],
  );
  const filters = useMemo(
    () =>
      recordQuery({
        days,
        goalStatus,
        issue,
        improvement,
        analysisStatus,
        actorKey,
        query,
      }),
    [
      actorKey,
      analysisStatus,
      days,
      goalStatus,
      improvement,
      issue,
      query,
    ],
  );

  const loadSummary = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/site-agents/${encodeURIComponent(overview.id)}/effects/summary?${summaryQuery}`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as {
        summary?: EffectTrackingSummary;
        message?: string;
      };
      if (!response.ok || !payload.summary)
        throw new Error(payload.message || "effect_summary_failed");
      setSummary(payload.summary);
      setError("");
    } catch {
      setError(page.summaryFailed);
    } finally {
      setLoading(false);
    }
  }, [overview.id, summaryQuery]);

  const loadRecords = useCallback(
    async (cursor?: string) => {
      setRecordsLoading(true);
      try {
        const url = new URL(
          `/api/site-agents/${encodeURIComponent(overview.id)}/effects/records`,
          window.location.origin,
        );
        for (const [key, value] of new URLSearchParams(filters))
          url.searchParams.set(key, value);
        if (cursor) url.searchParams.set("cursor", cursor);
        url.searchParams.set("limit", "40");
        const response = await fetch(url, { cache: "no-store" });
        const payload = (await response.json()) as EffectSubmissionList & {
          message?: string;
        };
        if (!response.ok)
          throw new Error(payload.message || "effect_records_failed");
        setRecords((current) =>
          cursor ? [...current, ...payload.records] : payload.records,
        );
        setTotal(payload.total);
        setNextCursor(payload.nextCursor);
        setError("");
      } catch {
        setError(page.recordsFailed);
      } finally {
        setRecordsLoading(false);
      }
    },
    [filters, overview.id],
  );

  const refresh = useCallback(async () => {
    await Promise.all([loadSummary(), loadRecords()]);
  }, [loadRecords, loadSummary]);


  const openDetail = useCallback(
    async (runId: string) => {
      setDetailLoading(true);
      setDetail(undefined);
      try {
        const response = await fetch(
          `/api/site-agents/${encodeURIComponent(overview.id)}/effects/records/${encodeURIComponent(runId)}`,
          { cache: "no-store" },
        );
        const payload = (await response.json()) as {
          detail?: EffectSubmissionDetail;
        };
        if (!response.ok || !payload.detail)
          throw new Error("effect_detail_failed");
        setDetail(payload.detail);
      } catch {
        setError(page.detailFailed);
      } finally {
        setDetailLoading(false);
      }
    },
    [overview.id],
  );

  const retry = useCallback(
    async (runId: string) => {
      const response = await fetch(
        `/api/site-agents/${encodeURIComponent(overview.id)}/effects/records/${encodeURIComponent(runId)}/retry`,
        { method: "POST" },
      );
      if (!response.ok) {
        setError(page.retryFailed);
        return;
      }
      setDetail(undefined);
      setAnalysisStatus("queued");
      await refresh();
    },
    [overview.id, refresh],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (
      !summary ||
      summary.queue.queued +
        summary.queue.analyzing +
        summary.queue.reviewing ===
        0
    )
      return;
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh, summary]);

  const clearActor = () => setActorKey("");

  return (
    <section className="effect-center effect-tracking">
      <header className="effect-head">
        <div>
          <h2>{page.title}</h2>
          <p>{page.lead}</p>
        </div>
        <div className="effect-range" aria-label={page.rangeLabel}>
          {[7, 30, 90].map((value) => (
            <button
              key={value}
              className={days === value ? "active" : ""}
              onClick={() => setDays(value)}
            >
              {page.rangeDays(value)}
            </button>
          ))}
        </div>
      </header>

      {summary && (
        <>
          <section className="effect-queue" aria-label={page.queueLabel}>
            <div className="effect-queue-title">
              <span className="effect-live-dot" />
              <b>{page.queueTitle}</b>
            </div>
            {(
              [
                "queued",
                "analyzing",
                "reviewing",
                "completed",
              ] as EffectAnalysisStatus[]
            ).map((status, index) => (
              <div className="effect-queue-step" key={status}>
                {index > 0 && <i>→</i>}
                <button
                  className={analysisStatus === status ? "active" : ""}
                  onClick={() =>
                    setAnalysisStatus((current) =>
                      current === status ? "all" : status,
                    )
                  }
                >
                  <span>{STATUS_LABELS[status]}</span>
                  <strong>{summary.queue[status]}</strong>
                </button>
              </div>
            ))}
            <button
              className={`effect-queue-failed ${
                analysisStatus === "failed" ? "active" : ""
              }`}
              onClick={() =>
                setAnalysisStatus((current) =>
                  current === "failed" ? "all" : "failed",
                )
              }
            >
              {page.queueFailed} <b>{summary.queue.failed}</b>
            </button>
          </section>

          <section className="effect-tracking-metrics">
            <article>
              <small>{page.goalRate}</small>
              <strong>{percent(summary.goal.rate)}</strong>
              <p>{page.goalRateDetail(summary.goal.achieved, summary.goal.analyzed)}</p>
            </article>
            <article>
              <small>{page.capabilityRate}</small>
              <strong>
                {summary.capability.invoked
                  ? percent(summary.capability.rate)
                  : "—"}
              </strong>
              <p>
                {page.capabilityRateDetail(
                  summary.capability.contributed,
                  summary.capability.invoked,
                )}
              </p>
            </article>
            <button
              onClick={() =>
                setImprovement((current) =>
                  current === "pending" ? "all" : "pending",
                )
              }
              className={improvement === "pending" ? "active" : ""}
            >
              <small>{page.pendingImprovements}</small>
              <strong>{summary.pendingImprovements}</strong>
              <p>{page.pendingImprovementsDetail}</p>
            </button>
          </section>
        </>
      )}

      <section className="effect-history">
        <header>
          <div>
            <small>{page.historyEyebrow}</small>
            <h3>{page.historyTitle(total)}</h3>
          </div>
          <button className="effect-refresh" onClick={() => void refresh()}>
            {page.refresh}
          </button>
        </header>

        <div className="effect-tracking-filters">
          <label className="effect-search">
            <span>⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={page.searchPlaceholder}
            />
          </label>
          <label>
            <span>{page.filterGoal}</span>
            <select
              value={goalStatus}
              onChange={(event) => setGoalStatus(event.target.value)}
            >
              <option value="all">{page.filterGoalAll}</option>
              {Object.entries(GOAL_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{page.filterIssue}</span>
            <select
              value={issue}
              onChange={(event) => setIssue(event.target.value)}
            >
              <option value="all">{page.filterIssueAll}</option>
              {Object.entries(ISSUE_LABELS)
                .filter(([value]) => value !== "none")
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <span>{page.filterAnalysis}</span>
            <select
              value={analysisStatus}
              onChange={(event) => setAnalysisStatus(event.target.value)}
            >
              <option value="all">{page.filterAnalysisAll}</option>
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {actorKey && (
          <div className="effect-actor-filter">
            {page.actorFilter(actorKey.slice(0, 8))}
            <button onClick={clearActor}>{page.actorClear}</button>
          </div>
        )}

        {error && <div className="effect-error">{error}</div>}
        {loading && !summary ? (
          <div className="effect-loading">{page.loadingSummary}</div>
        ) : !records.length && !recordsLoading ? (
          <EmptyEffect />
        ) : (
          <div className="effect-tracking-table" role="table">
            <div className="effect-tracking-table-head" role="row">
              <span>{page.colSubmission}</span>
              <span>{page.colGoal}</span>
              <span>{page.colAttribution}</span>
              <span>{page.colIssue}</span>
              <span>{page.colImprovement}</span>
              <span>{page.colStatus}</span>
            </div>
            {records.map((record) => (
              <button
                key={record.runId}
                className="effect-tracking-row"
                onClick={() => void openDetail(record.runId)}
                role="row"
              >
                <span className="effect-submission-cell">
                  <b>{record.submission}</b>
                  <small>
                    {dateTime(record.submittedAt)} ·{" "}
                    <i
                      role="button"
                      tabIndex={0}
                      onClick={(event) => {
                        event.stopPropagation();
                        setActorKey(record.actorKey);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.stopPropagation();
                          setActorKey(record.actorKey);
                        }
                      }}
                    >
                      {page.actor(record.actorKey.slice(0, 8))}
                    </i>
                  </small>
                </span>
                <span>
                  {record.goalStatus ? (
                    <em className={`effect-pill ${goalTone(record.goalStatus)}`}>
                      {GOAL_LABELS[record.goalStatus]}
                    </em>
                  ) : (
                    <small>{page.awaitingAnalysis}</small>
                  )}
                </span>
                <span className="effect-attribution-text">
                  {attributionSummary(record)}
                </span>
                <span>
                  {record.primaryIssue !== "none" ? (
                    <em className="effect-pill danger">
                      {ISSUE_LABELS[record.primaryIssue]}
                    </em>
                  ) : (
                    <small>—</small>
                  )}
                </span>
                <span>
                  {record.improvements.length ? (
                    <em className="effect-pill improvement">
                      {IMPROVEMENT_LABELS[record.improvements[0].kind]}
                      {record.improvements.length > 1
                        ? ` +${record.improvements.length - 1}`
                        : ""}
                    </em>
                  ) : (
                    <small>—</small>
                  )}
                </span>
                <span>
                  <em
                    className={`effect-pill ${statusTone(record.status)}`}
                  >
                    {record.reviewed && record.status === "completed"
                      ? page.reviewed
                      : STATUS_LABELS[record.status]}
                  </em>
                </span>
              </button>
            ))}
          </div>
        )}

        {nextCursor && (
          <button
            className="effect-load-more"
            disabled={recordsLoading}
            onClick={() => void loadRecords(nextCursor)}
          >
            {recordsLoading ? page.loadingMore : page.loadMore}
          </button>
        )}
      </section>

      {(detail || detailLoading) && (
        <EffectTrackingDetail
          detail={detail}
          loading={detailLoading}
          onClose={() => setDetail(undefined)}
          onRetry={(runId) => void retry(runId)}
        />
      )}
    </section>
  );
}

/**
 * One Episode's handover: the verdict, then the payload behind a fold.
 *
 * The payload and the delivery state are shown as two separate facts. A payload
 * can always be recomputed from a stored Episode, which says nothing about
 * whether the capability centre ever received it — and a delivery that was lost
 * is exactly what an owner opens this panel to find.
 */
function HandoffEpisodeCard({ episode }: { episode: CapabilityHandoffEpisodeView }) {
  const { judgement, downstream } = episode;
  const {
    handoffReason: HANDOFF_REASON_LABELS,
    handoffDownstream: HANDOFF_DOWNSTREAM_LABELS,
    writeClass: EFFECT_LABELS,
    page,
  } = labels();
  return (
    <article className="effect-handoff-episode">
      <header>
        <b>{episode.delivered ? page.delivered : page.notDelivered}</b>
        <code>{episode.episodeId.slice(0, 22)}</code>
        <em>{episode.outcomeStatus} · {episode.outcomeCode}</em>
      </header>
      {episode.blockedReason && (
        <p className="effect-handoff-why">{HANDOFF_REASON_LABELS[episode.blockedReason]}</p>
      )}
      {episode.delivered && (
        <dl className="effect-handoff-facts">
          <span><dt>{page.goal}</dt><dd>{episode.goal}</dd></span>
          <span><dt>{page.startPage}</dt><dd>{episode.startPageUrl}</dd></span>
          <span><dt>{page.endPage}</dt><dd>{episode.endPageUrl}</dd></span>
          <span><dt>{page.actions}</dt><dd>{page.actionCount(episode.actionCount)}</dd></span>
          {/* Only claim a payload size when one was actually recorded — the
              old markup printed a bare unit with no number when it was absent. */}
          {episode.payloadBytes !== undefined && (
            <span>
              <dt>{page.payloadSize}</dt>
              <dd>
                {page.payloadBytes(episode.payloadBytes)}
                <small>{page.payloadNote(Math.round(episode.episodeBytes / 1024))}</small>
              </dd>
            </span>
          )}
        </dl>
      )}
      <p className="effect-handoff-downstream">
        <span>{page.downstream}</span>
        <b>{HANDOFF_DOWNSTREAM_LABELS[downstream.state]}</b>
        {downstream.capabilityName && (
          <em>{downstream.capabilityName} · {downstream.capabilityStatus}</em>
        )}
      </p>
      {downstream.summary && <p className="effect-handoff-why">{downstream.summary}</p>}
      {(judgement.userAgentEffect || judgement.capabilityOperation) && (
        <p className={`effect-handoff-judgement ${judgement.agrees === false ? "disagree" : ""}`}>
          <span>
            {page.userAgentVerdict}
            <b>
              {judgement.userAgentEffect
                ? EFFECT_LABELS[judgement.userAgentEffect]
                : page.verdictMissing}
            </b>
            <small>{page.verdictComputed}</small>
          </span>
          <span>
            {page.capabilityVerdict}
            <b>
              {judgement.capabilityOperation === "read"
                ? page.capabilityRead
                : judgement.capabilityOperation === "write"
                  ? page.capabilityWrite
                  : page.verdictMissing}
            </b>
            {judgement.capabilitySideEffectMode && <small>{judgement.capabilitySideEffectMode}</small>}
          </span>
          {judgement.agrees === false && <i>{page.verdictDisagree}</i>}
        </p>
      )}
      {episode.generationInput !== undefined && (
        <details className="effect-handoff-raw">
          <summary>{page.viewGenerationInput}</summary>
          <pre>{JSON.stringify(episode.generationInput, null, 2)}</pre>
        </details>
      )}
    </article>
  );
}

function AttributionCard({ item }: { item: EffectAttribution }) {
  const {
    area: AREA_LABELS,
    contribution: CONTRIBUTION_LABELS,
    issue: ISSUE_LABELS,
    page,
  } = labels();
  return (
    <article className="effect-attribution-card">
      <header>
        <span>{AREA_LABELS[item.area]}</span>
        <em className={`effect-pill ${goalTone(
          item.contribution === "direct" ? "achieved" : undefined,
        )}`}>
          {CONTRIBUTION_LABELS[item.contribution]}
        </em>
      </header>
      <b>{item.subjectName}</b>
      <p>
        {item.execution === "not-used"
          ? page.execNotUsed
          : item.execution === "succeeded"
            ? page.execSucceeded
            : item.execution === "failed"
              ? page.execFailed
              : page.execUnknown}
        {item.issue !== "none" ? ` · ${ISSUE_LABELS[item.issue]}` : ""}
      </p>
    </article>
  );
}

function EffectTrackingDetail({
  detail,
  loading,
  onClose,
  onRetry,
}: {
  detail?: EffectSubmissionDetail;
  loading: boolean;
  onClose(): void;
  onRetry(runId: string): void;
}) {
  const {
    goal: GOAL_LABELS,
    analysis: STATUS_LABELS,
    improvement: IMPROVEMENT_LABELS,
    handoff: HANDOFF_LABELS,
    handoffReason: HANDOFF_REASON_LABELS,
    page,
  } = labels();
  return (
    <div className="effect-detail-backdrop" onMouseDown={onClose}>
      <aside
        className="effect-detail effect-tracking-detail"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {loading && !detail ? (
          <div className="effect-loading">{page.loadingDetail}</div>
        ) : detail ? (
          <>
            <header>
              <div>
                <small>{page.detailEyebrow(detail.analysis.runId.slice(-12))}</small>
                <h3>{detail.analysis.submission}</h3>
                <span>
                  {page.detailActor(
                    detail.analysis.actorKey.slice(0, 8),
                    dateTime(detail.analysis.submittedAt),
                  )}
                </span>
              </div>
              <button aria-label={page.close} onClick={onClose}>
                ×
              </button>
            </header>

            <section className="effect-detail-goal">
              <div>
                <small>{page.detailGoal}</small>
                <strong>
                  {detail.analysis.goalStatus
                    ? GOAL_LABELS[detail.analysis.goalStatus]
                    : STATUS_LABELS[detail.analysis.status]}
                </strong>
              </div>
              <span>
                {detail.analysis.reviewed
                  ? page.reviewedByStrongModel
                  : detail.analysis.status === "completed"
                    ? page.autoAnalysisDone
                    : STATUS_LABELS[detail.analysis.status]}
              </span>
            </section>

            {detail.analysis.attributions.length > 0 && (
              <section className="effect-detail-section">
                <header>
                  <h4>{page.attributionTitle}</h4>
                  <span>{page.attributionHint}</span>
                </header>
                <div className="effect-attribution-grid">
                  {detail.analysis.attributions.map((item, index) => (
                    <AttributionCard
                      key={`${item.area}:${item.subjectId || index}`}
                      item={item}
                    />
                  ))}
                </div>
              </section>
            )}

            {detail.analysis.improvements.length > 0 && (
              <section className="effect-detail-section">
                <header>
                  <h4>{page.improvementTitle}</h4>
                  <span>{page.improvementHint}</span>
                </header>
                <div className="effect-improvement-list">
                  {detail.analysis.improvements.map((item) => (
                    <article key={item.id}>
                      <em>{IMPROVEMENT_LABELS[item.kind]}</em>
                      <span>
                        <b>{item.title}</b>
                        <small>{item.status === "pending" ? page.improvementPending : item.status}</small>
                      </span>
                    </article>
                  ))}
                </div>
              </section>
            )}

            <section className="effect-detail-section">
              <header>
                <h4>{page.handoffTitle}</h4>
                <span>
                  {detail.capabilityHandoff.derived
                    ? page.handoffDerived
                    : page.handoffStored}
                </span>
              </header>
              <div className="effect-handoff">
                <p className={`effect-handoff-verdict ${detail.capabilityHandoff.conclusion}`}>
                  <b>{HANDOFF_LABELS[detail.capabilityHandoff.conclusion]}</b>
                  {detail.capabilityHandoff.reason && (
                    <small>{HANDOFF_REASON_LABELS[detail.capabilityHandoff.reason]}</small>
                  )}
                </p>
                {detail.capabilityHandoff.episodes.map((episode) => (
                  <HandoffEpisodeCard key={episode.episodeId} episode={episode} />
                ))}
                {!detail.capabilityHandoff.episodes.length &&
                  detail.capabilityHandoff.conclusion !== "not-delivered" && (
                    <p className="effect-detail-empty">{page.handoffEmpty}</p>
                  )}
              </div>
            </section>

            <section className="effect-detail-section">
              <header>
                <h4>{page.timelineTitle}</h4>
                <span>{page.timelineStages(detail.activityTimeline.length)}</span>
              </header>
              <div className="effect-timeline">
                {detail.activityTimeline.map((activity) => (
                  <article key={activity.id} className={activity.state}>
                    <i />
                    <span>
                      <b>{activity.label}</b>
                      <small>
                        {activity.detail ||
                          activity.operationName ||
                          activity.url ||
                          page.timelineRecorded}
                      </small>
                    </span>
                    <em>{dateTime(activity.createdAt)}</em>
                  </article>
                ))}
                {!detail.activityTimeline.length && (
                  <p className="effect-detail-empty">{page.timelineEmpty}</p>
                )}
              </div>
            </section>

            {detail.conversation.length > 0 && (
              <section className="effect-detail-section">
                <header>
                  <h4>{page.conversationTitle}</h4>
                  <span>{page.conversationHint}</span>
                </header>
                <div className="effect-conversation">
                  {detail.conversation.map((turn, index) => (
                    <article key={`${turn.at}-${index}`} className={turn.role}>
                      <small>
                        {turn.role === "user"
                          ? page.roleUser
                          : turn.role === "assistant"
                            ? "Agent"
                            : page.roleSystem}
                      </small>
                      <p>{turn.content}</p>
                    </article>
                  ))}
                </div>
              </section>
            )}

            {(detail.analysis.goalChecks.length > 0 ||
              detail.receipts.length > 0) && (
              <details className="effect-fact-details">
                <summary>
                  {page.factsSummary(
                    detail.analysis.goalChecks.length + detail.receipts.length,
                  )}
                </summary>
                <div>
                  {detail.analysis.goalChecks.map((check) => (
                    <article key={check.id}>
                      <b>{check.requirement}</b>
                      <span>
                        {check.status === "met"
                          ? page.checkMet
                          : check.status === "partially-met"
                            ? page.checkPartial
                            : check.status === "unmet"
                              ? page.checkUnmet
                              : page.checkUnknown}
                        {" · "}
                        {page.factRefs(check.factRefs.length)}
                      </span>
                    </article>
                  ))}
                  {detail.receipts.map((receipt) => (
                    <article key={receipt.id}>
                      <b>{page.receipt(receipt.id.slice(-10))}</b>
                      <span>
                        {receipt.status} · {dateTime(receipt.createdAt)}
                      </span>
                    </article>
                  ))}
                </div>
              </details>
            )}

            {detail.analysis.status === "failed" && (
              <footer>
                <button onClick={() => onRetry(detail.analysis.runId)}>
                  {page.retry}
                </button>
              </footer>
            )}
          </>
        ) : null}
      </aside>
    </div>
  );
}
