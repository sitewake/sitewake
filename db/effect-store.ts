import { attributeRunFailure } from "../lib/capability-center-v2/failure-class";
import { getCapabilityExperienceOutboxItem } from "./capability-experience-outbox-store";
import { getD1Binding, type D1DatabaseLike, type D1PreparedStatementLike } from "./index";
import { ensureSiteAgentV3Schema } from "./site-agent-schema";
import {
  normalizeGoal,
  uid,
  type AgentRun,
  type AgentRunActivity,
  type AgentRunConversationTurn,
  type AgentRunEvent,
  type DomReplayChunk,
  type ExecutionReceipt,
  type JsonValue,
  type PageSnapshot,
  type TaskEpisode,
} from "../lib/site-knowledge/protocol";
import { capabilityHandoffForEpisode, discoveryGenerationInputFromExperience } from "../lib/capability-center-v2/experience";
import { executionRequirementForGoal } from "../lib/site-knowledge/execution-requirement";
import type {
  CapabilityHandoffDownstream,
  CapabilityHandoffEpisodeView,
  CapabilityHandoffJudgement,
  CapabilityHandoffView,
} from "../lib/site-knowledge/effect-types";
import type {
  EffectCapabilityContribution,
  EffectCapabilityMetric,
  EffectCompletionMethod,
  EffectCompletionVerdict,
  EffectEvidenceRef,
  EffectFailureCategory,
  EffectIssue,
  EffectKnowledgeContribution,
  EffectRunDetail,
  EffectRunFact,
  EffectRunList,
  EffectRunMode,
  EffectSummary,
  EffectAnalysisJob,
  EffectAnalysisStatus,
  EffectSubmissionDetail,
  EffectSubmissionList,
  EffectTrackingSummary,
  SubmissionAnalysis,
} from "../lib/site-knowledge/effect-types";
import {
  analyzeEffectSubmission,
  type EffectAnalysisSource,
} from "../lib/site-knowledge/effect-analysis";

type FactRow = { factJson: string };
type CountRow = { count: number | string };
type RunRow = { runJson: string };
type EpisodeRow = { episodeJson: string };
type EventRow = { eventJson: string };
type ReceiptRow = { id: string; status: string; receiptJson: string; createdAt: string };
type ReplayRow = { chunkJson: string };
type ImprovementRow = { improvementJson: string };
type EngagementCountRow = { type: string; count: number | string };

type EffectMemory = typeof globalThis & {
  __SITEWAKE_EFFECT_FACTS__?: Map<string, EffectRunFact>;
  __SITEWAKE_ENGAGEMENT_EVENTS__?: Array<{
    siteAgentId: string;
    actorKey: string;
    type: string;
    createdAt: string;
  }>;
  __SITEWAKE_EFFECT_ANALYSES__?: Map<string, SubmissionAnalysis>;
  __SITEWAKE_EFFECT_ANALYSIS_JOBS__?: Map<string, EffectAnalysisJob>;
  __SITEWAKE_EFFECT_ANALYSIS_SOURCES__?: Map<string, EffectAnalysisSource>;
};

function memoryFacts() {
  const root = globalThis as EffectMemory;
  root.__SITEWAKE_EFFECT_FACTS__ ||= new Map();
  return root.__SITEWAKE_EFFECT_FACTS__;
}

function memoryEngagement() {
  const root = globalThis as EffectMemory;
  root.__SITEWAKE_ENGAGEMENT_EVENTS__ ||= [];
  return root.__SITEWAKE_ENGAGEMENT_EVENTS__;
}

function memoryAnalyses() {
  const root = globalThis as EffectMemory;
  root.__SITEWAKE_EFFECT_ANALYSES__ ||= new Map();
  return root.__SITEWAKE_EFFECT_ANALYSES__;
}

function memoryAnalysisJobs() {
  const root = globalThis as EffectMemory;
  root.__SITEWAKE_EFFECT_ANALYSIS_JOBS__ ||= new Map();
  return root.__SITEWAKE_EFFECT_ANALYSIS_JOBS__;
}

function memoryAnalysisSources() {
  const root = globalThis as EffectMemory;
  root.__SITEWAKE_EFFECT_ANALYSIS_SOURCES__ ||= new Map();
  return root.__SITEWAKE_EFFECT_ANALYSIS_SOURCES__;
}

async function rows<T>(
  database: D1DatabaseLike,
  sql: string,
  values: unknown[] = [],
) {
  const result = await database.prepare(sql).bind(...values).all<T>();
  if (!result.success) throw new Error(result.error || "effect_query_failed");
  return result.results || [];
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function effectActorKey(
  siteAgentId: string,
  browserSessionId?: string,
) {
  if (!browserSessionId) return "anonymous";
  const salt =
    typeof process !== "undefined"
      ? process.env.SITEWAKE_ANALYTICS_SALT?.trim() || "site-reflex"
      : "site-reflex";
  return (await sha256Hex(`${salt}:${siteAgentId}:${browserSessionId}`)).slice(
    0,
    16,
  );
}

function activityCapabilityIds(activity: AgentRunActivity[]) {
  return [
    ...new Set(
      activity
        .map((item) => item.capabilityId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

function runMode(run: AgentRun): EffectRunMode {
  if (run.checkpoint?.mode) return run.checkpoint.mode;
  if (run.activityTimeline.some((item) => item.kind === "capability"))
    return "compiled";
  return "unknown";
}

function effectFailureCategory(input: {
  status: EffectRunFact["status"];
  outcomeStatus: EffectRunFact["outcomeStatus"];
  code: string;
  summary: string;
  capabilityUsed: boolean;
  humanHandoff: boolean;
}): EffectFailureCategory {
  if (input.status === "cancelled") return "user-cancelled";
  if (
    input.outcomeStatus === "no-result" ||
    input.outcomeStatus === "business-rejection"
  )
    return "business-result";
  if (input.outcomeStatus === "success") return "none";
  if (input.humanHandoff) return "human-boundary";
  const value = `${input.code} ${input.summary}`.toLowerCase();
  if (/knowledge[_ -]?gap|missing[_ -]?route|unknown scene/.test(value))
    return "knowledge-gap";
  if (/capability[_ -]?(?:not[_ -]?found|gap)|no[_ -]?capability/.test(value))
    return "capability-gap";
  if (
    /target[_ -]?not[_ -]?found|binding[_ -]?not[_ -]?found|selector|dom|extraction[_ -]?proof/.test(
      value,
    )
  )
    return "page-drift";
  if (/auth|captcha|mfa|consent|confirmation|payment|permission/.test(value))
    return "human-boundary";
  if (/runner|browser[_ -]?unavailable|lease/.test(value))
    return "runner-unavailable";
  if (/timeout|timed out|expired/.test(value)) return "runtime-timeout";
  if (/model|agent[_ -]?protocol|unknown action|invalid operation/.test(value))
    return "model-error";
  if (input.capabilityUsed) return "capability-mismatch";
  return "unknown";
}

function runUrls(run: AgentRun) {
  const activityUrls = run.activityTimeline
    .map((item) => item.url)
    .filter((value): value is string => Boolean(value));
  const startFromState =
    typeof run.agentState.effectStartUrl === "string"
      ? run.agentState.effectStartUrl
      : undefined;
  return {
    startUrl: startFromState || activityUrls[0] || run.activePort?.url,
    endUrl: activityUrls.at(-1) || run.activePort?.url,
  };
}

function recordValue(value: JsonValue | undefined) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

function adaptiveSnapshot(run: AgentRun) {
  const checkpoint = run.checkpoint as
    | (AgentRun["checkpoint"] & {
        adaptiveTrace?: { startSnapshot?: PageSnapshot };
      })
    | undefined;
  return checkpoint?.adaptiveTrace?.startSnapshot;
}

function normalizedEvidenceText(value: string) {
  return value
    .toLowerCase()
    .replace(/[\s\u3000，。！？；：、“”‘’（）()【】《》,.!?;:'"`~\-_/\\|]+/g, "");
}

function answerSupportedBySnapshot(run: AgentRun, snapshot?: PageSnapshot) {
  if (!snapshot?.visibleText) return false;
  const output = recordValue(run.output as JsonValue);
  const answer = [output?.text, output?.summary, run.outcome?.summary]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const normalizedAnswer = normalizedEvidenceText(answer);
  const normalizedPage = normalizedEvidenceText(snapshot.visibleText);
  if (normalizedAnswer.length < 8 || normalizedPage.length < 8) return false;
  const windowSize = Math.min(18, Math.max(8, Math.floor(normalizedAnswer.length / 3)));
  let checked = 0;
  let matches = 0;
  for (let index = 0; index + windowSize <= normalizedAnswer.length; index += windowSize) {
    const fragment = normalizedAnswer.slice(index, index + windowSize);
    if (fragment.length < 8) continue;
    checked += 1;
    if (normalizedPage.includes(fragment)) matches += 1;
  }
  return checked > 0 && matches / checked >= 0.34;
}

function outcomeEvidence(run: AgentRun) {
  return recordValue(run.outcome?.evidence as JsonValue);
}

function hasPageWork(run: AgentRun) {
  return run.activityTimeline.some(
    (item) =>
      item.state === "completed" &&
      ["page", "navigation", "transition"].includes(item.kind),
  );
}

function knowledgeAttribution(run: AgentRun): {
  contribution: EffectKnowledgeContribution;
  reason: string;
  refs: EffectEvidenceRef[];
} {
  const activity = run.activityTimeline.filter((item) => item.kind === "knowledge");
  if (!activity.length)
    return {
      contribution: "none",
      reason: "任务没有查询网站知识。",
      refs: [],
    };
  const failed = activity.every((item) => item.state === "failed");
  if (failed)
    return {
      contribution: "gap",
      reason: "查询未得到可继续使用的知识。",
      refs: activity.map((item) => ({
        id: item.id,
        kind: "knowledge-receipt" as const,
        label: item.label,
        url: item.url,
      })),
    };
  const routed = activity.some((item) => {
    const output = item.output || {};
    return (
      /导航|路径|进入|navigate|route/i.test(`${item.label} ${item.detail || ""}`) ||
      typeof output.destination === "string" ||
      typeof output.url === "string"
    );
  });
  const grounded = activity.some((item) => {
    const output = item.output || {};
    return (
      Array.isArray(output.evidenceRefs) ||
      typeof output.answer === "string" ||
      typeof output.content === "string"
    );
  });
  const refs = activity.map((item) => ({
    id: item.id,
    kind: "knowledge-receipt" as const,
    label: item.label,
    url: item.url,
  }));
  if (grounded)
    return {
      contribution: "answer-grounded",
      reason: "回答引用了知识查询返回的内容证据。",
      refs,
    };
  if (routed)
    return {
      contribution: "route-assisted",
      reason: "网站知识帮助 Agent 找到目标页面或业务路径。",
      refs,
    };
  return {
    contribution: "queried-only",
    reason: "发生过知识查询，但现有回执不能证明结果采用了查询内容。",
    refs,
  };
}

function assessAgentRun(run: AgentRun, capabilityUsed: boolean) {
  const evidence = outcomeEvidence(run);
  const capabilityUse = recordValue(evidence?.capabilityUse);
  const programVerified =
    evidence?.source === "program-postconditions" ||
    capabilityUse?.fullySatisfied === true ||
    run.outcome?.code === "verified_program";
  const snapshot = adaptiveSnapshot(run);
  const pageSupported = answerSupportedBySnapshot(run, snapshot);
  const pageWork = hasPageWork(run);
  const capabilityActivities = run.activityTimeline.filter(
    (item) => item.kind === "capability",
  );
  const capabilityFailed = capabilityActivities.some(
    (item) => item.state === "failed",
  );
  const knowledge = knowledgeAttribution(run);
  const refs: EffectEvidenceRef[] = [...knowledge.refs];
  let completionVerdict: EffectCompletionVerdict;
  let completionMethod: EffectCompletionMethod = "unknown";
  let completionConfidence: "high" | "medium" | "low" = "low";
  let completionReason = "现有记录不足以判断任务是否真实完成。";

  if (run.status === "cancelled") {
    completionVerdict = "cancelled";
    completionReason = "用户在结果产生前取消了任务。";
  } else if (run.outcome?.status === "no-result") {
    completionVerdict = "valid-no-result";
    completionMethod = capabilityUsed ? "capability-direct" : pageWork ? "exploration" : "conversation";
    completionConfidence = programVerified ? "high" : "medium";
    completionReason = "网站返回了正常的无结果状态，这是一种有效业务结果。";
    refs.push({
      id: `${run.id}:business-outcome`,
      kind: "business-outcome",
      label: run.outcome.summary,
      url: run.activePort?.url,
    });
  } else if (run.outcome?.status === "business-rejection") {
    completionVerdict = "valid-business-rejection";
    completionMethod = capabilityUsed ? "capability-direct" : pageWork ? "exploration" : "conversation";
    completionConfidence = programVerified ? "high" : "medium";
    completionReason = "网站明确拒绝了该业务请求，拒绝原因本身是有效结果。";
    refs.push({
      id: `${run.id}:business-outcome`,
      kind: "business-outcome",
      label: run.outcome.summary,
      url: run.activePort?.url,
    });
  } else if (run.status !== "completed" || run.outcome?.status === "execution-fault") {
    completionVerdict = "failed";
    completionMethod =
      capabilityFailed && pageWork ? "exploration-recovery" : capabilityUsed ? "capability-direct" : pageWork ? "exploration" : "unknown";
    completionConfidence = "high";
    completionReason = run.outcome?.summary || "执行过程失败，未产生有效业务结果。";
  } else if (programVerified) {
    completionVerdict = "verified-success";
    completionMethod = "capability-direct";
    completionConfidence = "high";
    completionReason = "能力输出通过了程序后置条件验证。";
    refs.push({
      id: `${run.id}:postconditions`,
      kind: "program-postcondition",
      label: "能力输出通过后置条件",
      url: run.activePort?.url,
    });
  } else if (pageSupported) {
    completionVerdict = "verified-success";
    completionMethod = pageWork ? "exploration" : "current-page-reading";
    completionConfidence = "medium";
    completionReason = "Agent 的回答可在当时页面快照中找到内容依据。";
    refs.push({
      id: snapshot!.id,
      kind: "page-snapshot",
      label: snapshot!.heading || snapshot!.title || "当时页面内容",
      url: snapshot!.url,
    });
  } else if (run.outcome?.status === "success" && pageWork) {
    completionVerdict = "verified-success";
    completionMethod = capabilityFailed ? "exploration-recovery" : capabilityUsed ? "capability-assisted" : "exploration";
    completionConfidence = "medium";
    completionReason = "任务产生了可观测的页面操作或页面变化，并返回成功结果。";
    refs.push(
      ...run.activityTimeline
        .filter(
          (item) =>
            item.state === "completed" &&
            ["page", "navigation", "transition"].includes(item.kind),
        )
        .slice(-3)
        .map((item) => ({
          id: item.id,
          kind: "page-transition" as const,
          label: item.label,
          url: item.url,
        })),
    );
  } else if (run.outcome?.status === "success") {
    completionVerdict = "claimed-success";
    completionMethod = capabilityUsed ? "capability-assisted" : "conversation";
    completionReason = "Agent 报告已完成，但没有保存可独立核验的页面或结果证据。";
    refs.push({
      id: `${run.id}:agent-report`,
      kind: "agent-report",
      label: run.outcome.summary,
      url: run.activePort?.url,
    });
  } else {
    completionVerdict = "unknown";
  }

  let capabilityContribution: EffectCapabilityContribution = "none";
  let capabilityReason = "任务没有调用已发布能力。";
  if (capabilityUsed && programVerified) {
    capabilityContribution = "direct";
    capabilityReason = "能力直接交付结果，并通过程序后置条件验证。";
  } else if (capabilityFailed && completionVerdict === "verified-success") {
    capabilityContribution = "failed-recovered";
    capabilityReason = "能力调用失败，Agent 随后通过页面探索完成了任务。";
  } else if (capabilityFailed) {
    capabilityContribution = "failed";
    capabilityReason = "能力被调用，但没有完成预期结果。";
  } else if (capabilityUsed && completionVerdict === "verified-success") {
    capabilityContribution = "assisted";
    capabilityReason = "能力参与了任务，但最终结果还依赖其他页面证据。";
  } else if (capabilityUsed) {
    capabilityContribution = "invoked-only";
    capabilityReason = "能力被调用，但现有证据不足以证明它产生了有效结果。";
  }

  if (capabilityUsed)
    refs.push(
      ...capabilityActivities.map((item) => ({
        id: item.id,
        kind: "capability-receipt" as const,
        label: item.capabilityName || item.label,
        url: item.url,
      })),
    );

  return {
    assessmentStatus: "evaluated" as const,
    completionVerdict,
    completionMethod,
    completionConfidence,
    completionReason,
    evidenceRefs: refs.slice(0, 12),
    knowledgeContribution: knowledge.contribution,
    knowledgeReason: knowledge.reason,
    capabilityContribution,
    capabilityReason,
  };
}

function legacyAssessment(stored: EffectRunFact): EffectRunFact {
  // A fact written before failures were attributed gets its class when read.
  const fact: EffectRunFact = stored.status === "failed" && !stored.failureClass
    ? { ...stored, ...attributeRunFailure({ outcomeCode: stored.outcomeCode, summary: stored.outcomeSummary, capabilityUsed: stored.capabilityUsed }) }
    : stored;
  if (fact.assessmentStatus) return fact;
  const completionVerdict: EffectCompletionVerdict =
    fact.status === "cancelled"
      ? "cancelled"
      : fact.outcomeStatus === "no-result"
        ? "valid-no-result"
        : fact.outcomeStatus === "business-rejection"
          ? "valid-business-rejection"
          : fact.outcomeStatus === "success"
            ? "claimed-success"
            : fact.status === "failed"
              ? "failed"
              : "unknown";
  return {
    ...fact,
    assessmentStatus: "legacy",
    completionVerdict,
    completionMethod:
      fact.mode === "adaptive" || fact.mode === "repair"
        ? "exploration"
        : fact.capabilityUsed
          ? "capability-assisted"
          : "unknown",
    completionConfidence:
      completionVerdict === "failed" || completionVerdict === "cancelled"
        ? "high"
        : "low",
    completionReason:
      completionVerdict === "claimed-success"
        ? "这是一条历史记录：Agent 报告成功，但当时未保存足够证据进行独立核验。"
        : fact.outcomeSummary,
    evidenceRefs: [],
    knowledgeContribution: fact.knowledgeUsed ? "queried-only" : "none",
    knowledgeReason: fact.knowledgeUsed
      ? "历史记录只能确认发生过查询，不能证明结果采用了知识内容。"
      : "任务没有记录知识查询。",
    capabilityContribution: fact.capabilityUsed ? "invoked-only" : "none",
    capabilityReason: fact.capabilityUsed
      ? "历史记录只能确认发生过能力调用，不能证明能力直接交付了结果。"
      : "任务没有记录能力调用。",
  };
}

export async function effectFactFromAgentRun(
  run: AgentRun,
): Promise<EffectRunFact> {
  const capabilityIds = activityCapabilityIds(run.activityTimeline);
  const checkpointCapability = run.checkpoint?.capabilityId;
  if (
    checkpointCapability &&
    !capabilityIds.includes(checkpointCapability)
  )
    capabilityIds.unshift(checkpointCapability);
  const capabilityId = capabilityIds[0];
  const knowledgeActivity = run.activityTimeline.filter(
    (item) => item.kind === "knowledge",
  );
  const humanHandoff = run.activityTimeline.some(
    (item) => item.kind === "human",
  );
  const mode = runMode(run);
  const outcomeStatus =
    run.status === "cancelled"
      ? "cancelled"
      : run.outcome?.status ||
        (run.status === "completed" ? "unknown" : "execution-fault");
  const outcomeCode =
    run.outcome?.code ||
    (run.status === "cancelled" ? "user_cancelled" : run.status);
  const outcomeSummary =
    run.outcome?.summary ||
    (run.status === "cancelled" ? "用户取消了任务" : "任务未提供结果回执");
  const actorKey =
    typeof run.agentState.effectActorKey === "string"
      ? run.agentState.effectActorKey
      : await effectActorKey(
          run.scope.siteAgentId,
          run.activePort?.browserSessionId,
        );
  const urls = runUrls(run);
  const status: EffectRunFact["status"] =
    run.status === "cancelled"
      ? "cancelled"
      : run.status === "completed"
        ? "completed"
        : "failed";
  const capabilityUsed = Boolean(capabilityId);
  return {
    runId: run.id,
    siteAgentId: run.scope.siteAgentId,
    actorKey,
    source: "agent-run",
    goal: run.goal,
    status,
    outcomeStatus,
    outcomeCode,
    outcomeSummary,
    mode,
    capabilityId,
    capabilityIds,
    capabilityUsed,
    knowledgeUsed: knowledgeActivity.length > 0,
    knowledgeSucceeded: knowledgeActivity.some(
      (item) => item.state === "completed",
    ),
    ...assessAgentRun(run, capabilityUsed),
    adaptive: mode === "adaptive",
    repair: mode === "repair",
    humanHandoff,
    failureCategory: effectFailureCategory({
      status,
      outcomeStatus,
      code: outcomeCode,
      summary: outcomeSummary,
      capabilityUsed,
      humanHandoff,
    }),
    ...(status === "failed"
      ? attributeRunFailure({ outcomeCode, summary: outcomeSummary, evidence: run.outcome?.evidence as Record<string, unknown> | undefined, capabilityUsed })
      : {}),
    durationMs: Math.max(
      0,
      Date.parse(run.updatedAt) - Date.parse(run.createdAt),
    ),
    pageCount: Math.max(
      1,
      run.pageEpoch,
      ...run.activityTimeline.map((item) => item.pageEpoch || 0),
    ),
    releaseId:
      typeof run.agentState.effectReleaseId === "string"
        ? run.agentState.effectReleaseId
        : undefined,
    releaseVersion:
      typeof run.agentState.effectReleaseVersion === "number"
        ? run.agentState.effectReleaseVersion
        : undefined,
    ...urls,
    startedAt: run.createdAt,
    endedAt: run.updatedAt,
  };
}

export async function effectFactFromEpisode(
  episode: TaskEpisode,
): Promise<EffectRunFact> {
  const capabilityIds = episode.capabilityId ? [episode.capabilityId] : [];
  const knowledgeReceipts =
    episode.experience?.toolReceipts?.filter(
      (receipt) => receipt.kind === "knowledge",
    ) || [];
  const mode: EffectRunMode =
    episode.mode === "compiled" ||
    episode.mode === "adaptive" ||
    episode.mode === "repair" ||
    episode.mode === "demonstration"
      ? episode.mode
      : "unknown";
  const valid = ["success", "no-result", "business-rejection"].includes(
    episode.outcome.status,
  );
  const status: EffectRunFact["status"] = valid ? "completed" : "failed";
  const humanHandoff =
    episode.experience?.toolReceipts?.some(
      (receipt) => receipt.kind === "human",
    ) || false;
  const programVerified =
    episode.outcome.evidence.source === "program-postconditions" ||
    recordValue(episode.outcome.evidence.capabilityUse)?.fullySatisfied === true ||
    episode.outcome.code === "verified_program";
  const pageChanged =
    episode.transitions.length > 0 ||
    episode.startSnapshot.url !== episode.endSnapshot.url ||
    episode.startSnapshot.visibleText !== episode.endSnapshot.visibleText;
  const validNoResult = episode.outcome.status === "no-result";
  const validRejection = episode.outcome.status === "business-rejection";
  const verifiedSuccess =
    episode.outcome.status === "success" && (programVerified || pageChanged);
  const completionVerdict: EffectCompletionVerdict = validNoResult
    ? "valid-no-result"
    : validRejection
      ? "valid-business-rejection"
      : verifiedSuccess
        ? "verified-success"
        : episode.outcome.status === "success"
          ? "claimed-success"
          : "failed";
  const routeAssisted = knowledgeReceipts.some(
    (receipt) =>
      receipt.status === "completed" &&
      (/导航|路径|进入|navigate|route/i.test(`${receipt.name} ${receipt.summary}`) ||
        typeof receipt.output?.destination === "string" ||
        typeof receipt.output?.url === "string"),
  );
  const answerGrounded = knowledgeReceipts.some(
    (receipt) =>
      receipt.status === "completed" &&
      (Array.isArray(receipt.output?.evidenceRefs) ||
        typeof receipt.output?.answer === "string" ||
        typeof receipt.output?.content === "string"),
  );
  const knowledgeContribution: EffectKnowledgeContribution = !knowledgeReceipts.length
    ? "none"
    : knowledgeReceipts.every((receipt) => receipt.status === "failed")
      ? "gap"
      : answerGrounded
        ? "answer-grounded"
        : routeAssisted
          ? "route-assisted"
          : "queried-only";
  const capabilityContribution: EffectCapabilityContribution = !episode.capabilityId
    ? "none"
    : programVerified
      ? "direct"
      : verifiedSuccess
        ? "assisted"
        : episode.outcome.status === "success"
          ? "invoked-only"
          : "failed";
  const completionMethod: EffectCompletionMethod = programVerified
    ? "capability-direct"
    : episode.capabilityId && pageChanged
      ? "capability-assisted"
      : pageChanged
        ? "exploration"
        : "unknown";
  const evidenceRefs: EffectEvidenceRef[] = [
    ...(programVerified
      ? [
          {
            id: `${episode.id}:postconditions`,
            kind: "program-postcondition" as const,
            label: "能力输出通过后置条件",
            url: episode.endSnapshot.url,
          },
        ]
      : []),
    ...(pageChanged
      ? [
          {
            id: episode.endSnapshot.id,
            kind: "page-snapshot" as const,
            label:
              episode.endSnapshot.heading ||
              episode.endSnapshot.title ||
              "任务结束页面",
            url: episode.endSnapshot.url,
          },
        ]
      : []),
    ...knowledgeReceipts.map((receipt, index) => ({
      id: `${episode.id}:knowledge:${index}`,
      kind: "knowledge-receipt" as const,
      label: receipt.summary || receipt.name,
    })),
  ];
  return {
    runId: episode.taskSessionId,
    siteAgentId: episode.siteAgentId,
    actorKey: await effectActorKey(
      episode.siteAgentId,
      episode.browserSessionId,
    ),
    source: "episode",
    goal: episode.goal,
    status,
    outcomeStatus: episode.outcome.status,
    outcomeCode: episode.outcome.code,
    outcomeSummary: episode.outcome.summary,
    mode,
    capabilityId: episode.capabilityId,
    capabilityIds,
    capabilityUsed: Boolean(episode.capabilityId),
    knowledgeUsed: knowledgeReceipts.length > 0,
    knowledgeSucceeded: knowledgeReceipts.some(
      (receipt) => receipt.status === "completed",
    ),
    assessmentStatus: "evaluated",
    completionVerdict,
    completionMethod,
    completionConfidence:
      programVerified || validNoResult || validRejection ? "high" : pageChanged ? "medium" : "low",
    completionReason: programVerified
      ? "能力输出通过了程序后置条件验证。"
      : pageChanged
        ? "任务产生了可观测的页面变化，并返回业务结果。"
        : completionVerdict === "claimed-success"
          ? "Agent 报告已完成，但没有保存可独立核验的页面或结果证据。"
          : episode.outcome.summary,
    evidenceRefs,
    knowledgeContribution,
    knowledgeReason:
      knowledgeContribution === "none"
        ? "任务没有查询网站知识。"
        : knowledgeContribution === "queried-only"
          ? "发生过知识查询，但现有回执不能证明结果采用了查询内容。"
          : knowledgeContribution === "route-assisted"
            ? "网站知识帮助 Agent 找到目标页面或业务路径。"
            : knowledgeContribution === "answer-grounded"
              ? "回答引用了知识查询返回的内容证据。"
              : "查询未得到可继续使用的知识。",
    capabilityContribution,
    capabilityReason:
      capabilityContribution === "none"
        ? "任务没有调用已发布能力。"
        : capabilityContribution === "direct"
          ? "能力直接交付结果，并通过程序后置条件验证。"
          : capabilityContribution === "assisted"
            ? "能力参与了任务，结果还依赖页面证据。"
            : capabilityContribution === "invoked-only"
              ? "能力被调用，但现有证据不足以证明它直接交付了结果。"
              : "能力被调用，但没有完成预期结果。",
    adaptive: episode.mode === "adaptive",
    repair: episode.mode === "repair",
    humanHandoff,
    failureCategory: effectFailureCategory({
      status,
      outcomeStatus: episode.outcome.status,
      code: episode.outcome.code,
      summary: episode.outcome.summary,
      capabilityUsed: Boolean(episode.capabilityId),
      humanHandoff,
    }),
    ...(status === "failed"
      ? attributeRunFailure({ outcomeCode: episode.outcome.code, summary: episode.outcome.summary, evidence: episode.outcome.evidence as Record<string, unknown> | undefined, capabilityUsed: Boolean(episode.capabilityId) })
      : {}),
    durationMs: Math.max(
      0,
      Date.parse(episode.endedAt) - Date.parse(episode.startedAt),
    ),
    pageCount: Math.max(
      1,
      new Set([
        episode.documentId,
        ...episode.transitions.flatMap((item) => [
          item.fromSnapshot?.documentId,
          item.toSnapshot?.documentId,
        ]),
      ]).size,
    ),
    releaseId: episode.releaseId,
    startUrl: episode.startSnapshot.url,
    endUrl: episode.endSnapshot.url,
    startedAt: episode.startedAt,
    endedAt: episode.endedAt,
  };
}

async function saveFact(
  database: D1DatabaseLike | null,
  fact: EffectRunFact,
) {
  if (!database) {
    memoryFacts().set(fact.runId, fact);
    return;
  }
  await ensureSiteAgentV3Schema(database);
  const result = await database
    .prepare(
      `INSERT OR REPLACE INTO site_agent_v3_usage_facts
      (run_id,site_agent_id,actor_key,source,goal,status,outcome_status,outcome_code,mode,
       capability_id,capability_used,knowledge_used,knowledge_succeeded,adaptive,repair,
       human_handoff,failure_category,duration_ms,page_count,release_id,release_version,
       fact_json,started_at,ended_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      fact.runId,
      fact.siteAgentId,
      fact.actorKey,
      fact.source,
      fact.goal,
      fact.status,
      fact.outcomeStatus,
      fact.outcomeCode,
      fact.mode,
      fact.capabilityId || null,
      fact.capabilityUsed ? 1 : 0,
      fact.knowledgeUsed ? 1 : 0,
      fact.knowledgeSucceeded ? 1 : 0,
      fact.adaptive ? 1 : 0,
      fact.repair ? 1 : 0,
      fact.humanHandoff ? 1 : 0,
      fact.failureCategory,
      fact.durationMs,
      fact.pageCount,
      fact.releaseId || null,
      fact.releaseVersion ?? null,
      JSON.stringify(fact),
      fact.startedAt,
      fact.endedAt,
    )
    .run();
  if (!result.success) throw new Error(result.error || "effect_fact_write_failed");
}

function queuedAnalysis(run: AgentRun, actorKey: string): SubmissionAnalysis {
  const now = new Date().toISOString();
  return {
    version: 1,
    runId: run.id,
    siteAgentId: run.scope.siteAgentId,
    actorKey,
    submission: redactText(run.goal),
    submittedAt: run.createdAt,
    finishedAt: run.updatedAt,
    status: "queued",
    goalChecks: [],
    attributions: [],
    primaryIssue: "none",
    improvements: [],
    reviewed: false,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function saveSubmissionAnalysis(
  database: D1DatabaseLike | null,
  analysis: SubmissionAnalysis,
) {
  if (!database) {
    memoryAnalyses().set(analysis.runId, analysis);
    return;
  }
  await ensureSiteAgentV3Schema(database);
  const result = await database
    .prepare(
      `INSERT OR REPLACE INTO site_agent_v3_effect_analyses
       (run_id,site_agent_id,actor_key,status,goal_status,primary_issue,
        has_improvement,analysis_json,submitted_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      analysis.runId,
      analysis.siteAgentId,
      analysis.actorKey,
      analysis.status,
      analysis.goalStatus || null,
      analysis.primaryIssue,
      analysis.improvements.length ? 1 : 0,
      JSON.stringify(analysis),
      analysis.submittedAt,
      analysis.updatedAt,
    )
    .run();
  if (!result.success)
    throw new Error(result.error || "effect_analysis_write_failed");
}

async function saveAnalysisJob(
  database: D1DatabaseLike | null,
  job: EffectAnalysisJob,
) {
  if (!database) {
    memoryAnalysisJobs().set(job.runId, job);
    return;
  }
  await ensureSiteAgentV3Schema(database);
  const result = await database
    .prepare(
      `INSERT OR REPLACE INTO site_agent_v3_effect_analysis_jobs
       (id,run_id,site_agent_id,status,attempts,job_json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .bind(
      job.id,
      job.runId,
      job.siteAgentId,
      job.status,
      job.attempts,
      JSON.stringify(job),
      job.createdAt,
      job.updatedAt,
    )
    .run();
  if (!result.success)
    throw new Error(result.error || "effect_analysis_job_write_failed");
}

async function enqueueEffectAnalysis(run: AgentRun) {
  const database = getD1Binding();
  const actorKey =
    typeof run.agentState.effectActorKey === "string"
      ? run.agentState.effectActorKey
      : "anonymous";
  if (!database) {
    if (memoryAnalysisJobs().has(run.id)) return;
    memoryAnalysisSources().set(run.id, { run, actorKey, receipts: [] });
  } else {
    await ensureSiteAgentV3Schema(database);
    const existing = await rows<CountRow>(
      database,
      `SELECT COUNT(*) AS count FROM site_agent_v3_effect_analysis_jobs WHERE run_id=?`,
      [run.id],
    );
    if (Number(existing[0]?.count || 0)) return;
  }
  const now = new Date().toISOString();
  const job: EffectAnalysisJob = {
    id: uid("effect_analysis"),
    runId: run.id,
    siteAgentId: run.scope.siteAgentId,
    status: "queued",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  await saveSubmissionAnalysis(database, queuedAnalysis(run, actorKey));
  await saveAnalysisJob(database, job);
}

export async function persistEffectRun(run: AgentRun) {
  if (!["completed", "failed", "cancelled"].includes(run.status)) return;
  await Promise.all([
    saveFact(getD1Binding(), await effectFactFromAgentRun(run)),
    enqueueEffectAnalysis(run),
  ]);
}

export async function backfillEffectFacts(siteAgentId: string) {
  const database = getD1Binding();
  if (!database) return;
  await ensureSiteAgentV3Schema(database);
  const missingRuns = await rows<RunRow>(
    database,
    `SELECT r.run_json AS runJson
     FROM site_agent_v3_agent_runs r
     LEFT JOIN site_agent_v3_usage_facts f ON f.run_id=r.id
     WHERE r.site_agent_id=? AND r.status IN ('completed','failed','cancelled')
       AND f.run_id IS NULL
     ORDER BY r.updated_at DESC LIMIT 1000`,
    [siteAgentId],
  );
  for (const row of missingRuns) {
    await saveFact(
      database,
      await effectFactFromAgentRun(JSON.parse(row.runJson) as AgentRun),
    );
  }
  let missingEpisodes: EpisodeRow[] = [];
  try {
    missingEpisodes = await rows<EpisodeRow>(
      database,
      `SELECT e.episode_json AS episodeJson
       FROM site_agent_v2_episodes e
       LEFT JOIN site_agent_v3_usage_facts f ON f.run_id=e.task_session_id
       WHERE e.site_agent_id=? AND f.run_id IS NULL
         AND e.mode NOT IN ('validation','passive','author-request')
       ORDER BY e.ended_at DESC LIMIT 1000`,
      [siteAgentId],
    );
  } catch (error) {
    if (!/no such table|does not exist/.test(String(error).toLowerCase()))
      throw error;
  }
  for (const row of missingEpisodes) {
    await saveFact(
      database,
      await effectFactFromEpisode(
        JSON.parse(row.episodeJson) as TaskEpisode,
      ),
    );
  }
}

type EffectFilters = {
  from?: string;
  to?: string;
  outcome?: string;
  mode?: string;
  capabilityId?: string;
  query?: string;
};

function effectRange(filters: EffectFilters) {
  const toDate = filters.to ? new Date(filters.to) : new Date();
  if (!Number.isFinite(toDate.getTime())) toDate.setTime(Date.now());
  const fromDate = filters.from
    ? new Date(filters.from)
    : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(fromDate.getTime()))
    fromDate.setTime(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from: fromDate.toISOString(), to: toDate.toISOString() };
}

function filterSql(siteAgentId: string, filters: EffectFilters) {
  const range = effectRange(filters);
  const conditions = [
    "site_agent_id=?",
    "ended_at>=?",
    "ended_at<=?",
  ];
  const values: unknown[] = [siteAgentId, range.from, range.to];
  if (filters.outcome && filters.outcome !== "all") {
    if (filters.outcome === "failed") {
      conditions.push(
        "outcome_status NOT IN ('success','no-result','business-rejection')",
      );
    } else {
      conditions.push("outcome_status=?");
      values.push(filters.outcome);
    }
  }
  if (filters.mode && filters.mode !== "all") {
    conditions.push("mode=?");
    values.push(filters.mode);
  }
  if (filters.capabilityId) {
    conditions.push("capability_id=?");
    values.push(filters.capabilityId);
  }
  const query = filters.query?.trim().slice(0, 100);
  if (query) {
    conditions.push("(goal LIKE ? OR run_id LIKE ? OR actor_key LIKE ?)");
    const like = `%${query}%`;
    values.push(like, like, like);
  }
  return { range, conditions, values };
}

function memoryFiltered(siteAgentId: string, filters: EffectFilters) {
  const range = effectRange(filters);
  const query = filters.query?.trim().toLowerCase();
  return [...memoryFacts().values()]
    .map(legacyAssessment)
    .filter((fact) => fact.siteAgentId === siteAgentId)
    .filter((fact) => fact.endedAt >= range.from && fact.endedAt <= range.to)
    .filter(
      (fact) =>
        !filters.outcome ||
        filters.outcome === "all" ||
        (filters.outcome === "failed"
          ? !["success", "no-result", "business-rejection"].includes(
              fact.outcomeStatus,
            )
          : fact.outcomeStatus === filters.outcome),
    )
    .filter(
      (fact) =>
        !filters.mode ||
        filters.mode === "all" ||
        fact.mode === filters.mode,
    )
    .filter(
      (fact) =>
        !filters.capabilityId || fact.capabilityId === filters.capabilityId,
    )
    .filter(
      (fact) =>
        !query ||
        `${fact.goal} ${fact.runId} ${fact.actorKey}`
          .toLowerCase()
          .includes(query),
    )
    .sort(
      (left, right) =>
        right.endedAt.localeCompare(left.endedAt) ||
        right.runId.localeCompare(left.runId),
    );
}

export async function listEffectRuns(
  siteAgentId: string,
  filters: EffectFilters & { cursor?: string; limit?: number },
): Promise<EffectRunList> {
  const limit = Math.max(1, Math.min(100, filters.limit || 40));
  const database = getD1Binding();
  if (!database) {
    const all = memoryFiltered(siteAgentId, filters);
    const start = filters.cursor
      ? Math.max(
          0,
          all.findIndex(
            (item) => `${item.endedAt}~${item.runId}` === filters.cursor,
          ) + 1,
        )
      : 0;
    const records = all.slice(start, start + limit);
    const last = records.at(-1);
    return {
      records,
      total: all.length,
      nextCursor:
        start + records.length < all.length && last
          ? `${last.endedAt}~${last.runId}`
          : undefined,
    };
  }
  const built = filterSql(siteAgentId, filters);
  const countRows = await rows<CountRow>(
    database,
    `SELECT COUNT(*) AS count FROM site_agent_v3_usage_facts WHERE ${built.conditions.join(" AND ")}`,
    built.values,
  );
  const conditions = [...built.conditions];
  const values = [...built.values];
  if (filters.cursor) {
    const separator = filters.cursor.lastIndexOf("~");
    const cursorTime = filters.cursor.slice(0, separator);
    const cursorId = filters.cursor.slice(separator + 1);
    if (separator > 0 && cursorTime && cursorId) {
      conditions.push("(ended_at<? OR (ended_at=? AND run_id<?))");
      values.push(cursorTime, cursorTime, cursorId);
    }
  }
  values.push(limit + 1);
  const factRows = await rows<FactRow>(
    database,
    `SELECT fact_json AS factJson FROM site_agent_v3_usage_facts
     WHERE ${conditions.join(" AND ")}
     ORDER BY ended_at DESC,run_id DESC LIMIT ?`,
    values,
  );
  const parsed = factRows.map((row) =>
    legacyAssessment(JSON.parse(row.factJson) as EffectRunFact),
  );
  const hasMore = parsed.length > limit;
  const records = parsed.slice(0, limit);
  const last = records.at(-1);
  return {
    records,
    total: Number(countRows[0]?.count || 0),
    nextCursor:
      hasMore && last ? `${last.endedAt}~${last.runId}` : undefined,
  };
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  ];
}

function rate(value: number, total: number) {
  return total ? Math.round((value / total) * 1000) / 1000 : 0;
}

const ISSUE_LABELS: Record<EffectFailureCategory, string> = {
  none: "已成功",
  "user-cancelled": "用户主动取消",
  "capability-gap": "缺少可用能力",
  "capability-mismatch": "能力执行未满足目标",
  "knowledge-gap": "网站知识或路径存在缺口",
  "page-drift": "页面结构发生变化",
  "human-boundary": "需要用户完成验证或确认",
  "runtime-timeout": "执行超时",
  "runner-unavailable": "执行服务不可用",
  "model-error": "模型响应异常",
  "business-result": "网站返回正常业务结果",
  unknown: "尚未归因",
};

function issueMetrics(facts: EffectRunFact[]): EffectIssue[] {
  const groups = new Map<
    string,
    {
      category: EffectFailureCategory;
      goal: string;
      tasks: number;
      actors: Set<string>;
      latestAt: string;
    }
  >();
  for (const fact of facts) {
    if (fact.failureCategory === "none" || fact.failureCategory === "business-result")
      continue;
    const goal = normalizeGoal(fact.goal) || "未归类目标";
    const key = `${fact.failureCategory}:${goal}`;
    const current = groups.get(key) || {
      category: fact.failureCategory,
      goal: fact.goal,
      tasks: 0,
      actors: new Set<string>(),
      latestAt: fact.endedAt,
    };
    current.tasks += 1;
    current.actors.add(fact.actorKey);
    if (fact.endedAt > current.latestAt) current.latestAt = fact.endedAt;
    groups.set(key, current);
  }
  return [...groups.entries()]
    .map(([id, item]) => {
      const users = item.actors.size;
      const score = item.tasks * Math.max(1, users);
      return {
        id,
        category: item.category,
        label: ISSUE_LABELS[item.category],
        goal: item.goal,
        tasks: item.tasks,
        users,
        latestAt: item.latestAt,
        priority:
          score >= 8 ? "high" : score >= 3 ? "medium" : "low",
      } satisfies EffectIssue;
    })
    .sort(
      (left, right) =>
        right.tasks * right.users - left.tasks * left.users ||
        right.latestAt.localeCompare(left.latestAt),
    )
    .slice(0, 20);
}

function capabilityMetrics(facts: EffectRunFact[]) {
  const groups = new Map<
    string,
    {
      tasks: number;
      actors: Set<string>;
      successes: number;
      valid: number;
      failures: number;
      direct: number;
      assisted: number;
      recovered: number;
      durations: number[];
    }
  >();
  for (const fact of facts) {
    if (!fact.capabilityId) continue;
    const current = groups.get(fact.capabilityId) || {
      tasks: 0,
      actors: new Set<string>(),
      successes: 0,
      valid: 0,
      failures: 0,
      direct: 0,
      assisted: 0,
      recovered: 0,
      durations: [],
    };
    current.tasks += 1;
    current.actors.add(fact.actorKey);
    current.durations.push(fact.durationMs);
    if (fact.outcomeStatus === "success") current.successes += 1;
    if (
      ["success", "no-result", "business-rejection"].includes(
        fact.outcomeStatus,
      )
    )
      current.valid += 1;
    else current.failures += 1;
    if (fact.capabilityContribution === "direct") current.direct += 1;
    if (fact.capabilityContribution === "assisted") current.assisted += 1;
    if (fact.capabilityContribution === "failed-recovered")
      current.recovered += 1;
    groups.set(fact.capabilityId, current);
  }
  return [...groups.entries()]
    .map(
      ([capabilityId, item]) =>
        ({
          capabilityId,
          tasks: item.tasks,
          users: item.actors.size,
          successes: item.successes,
          validResults: item.valid,
          failures: item.failures,
          directResults: item.direct,
          assistedResults: item.assisted,
          recoveredResults: item.recovered,
          validRate: rate(item.valid, item.tasks),
          p95DurationMs: percentile(item.durations, 0.95),
        }) satisfies EffectCapabilityMetric,
    )
    .sort((left, right) => right.tasks - left.tasks);
}

export async function summarizeEffectRuns(
  siteAgentId: string,
  filters: EffectFilters,
): Promise<EffectSummary> {
  const range = effectRange(filters);
  const database = getD1Binding();
  let facts: EffectRunFact[];
  let total = 0;
  let engagementRows: EngagementCountRow[] = [];
  if (!database) {
    facts = memoryFiltered(siteAgentId, { ...filters, ...range });
    total = facts.length;
    const groups = new Map<string, Set<string>>();
    for (const event of memoryEngagement().filter(
      (item) =>
        item.siteAgentId === siteAgentId &&
        item.createdAt >= range.from &&
        item.createdAt <= range.to,
    )) {
      const actors = groups.get(event.type) || new Set<string>();
      actors.add(event.actorKey);
      groups.set(event.type, actors);
    }
    engagementRows = [...groups.entries()].map(([type, actors]) => ({
      type,
      count: actors.size,
    }));
  } else {
    const built = filterSql(siteAgentId, filters);
    const [factRows, countRows, countedEngagement] = await Promise.all([
      rows<FactRow>(
        database,
        `SELECT fact_json AS factJson FROM site_agent_v3_usage_facts
         WHERE ${built.conditions.join(" AND ")}
         ORDER BY ended_at DESC LIMIT 5001`,
        built.values,
      ),
      rows<CountRow>(
        database,
        `SELECT COUNT(*) AS count FROM site_agent_v3_usage_facts
         WHERE ${built.conditions.join(" AND ")}`,
        built.values,
      ),
      rows<EngagementCountRow>(
        database,
        `SELECT type,COUNT(DISTINCT actor_key) AS count
         FROM site_agent_v3_engagement_events
         WHERE site_agent_id=? AND created_at>=? AND created_at<=?
         GROUP BY type`,
        [siteAgentId, range.from, range.to],
      ),
    ]);
    facts = factRows
      .slice(0, 5000)
      .map((row) =>
        legacyAssessment(JSON.parse(row.factJson) as EffectRunFact),
      );
    total = Number(countRows[0]?.count || 0);
    engagementRows = countedEngagement;
  }
  const successes = facts.filter(
    (fact) => fact.outcomeStatus === "success",
  ).length;
  const validResults = facts.filter((fact) =>
    ["success", "no-result", "business-rejection"].includes(
      fact.outcomeStatus,
    ),
  ).length;
  const cancelled = facts.filter(
    (fact) => fact.status === "cancelled",
  ).length;
  const capabilityRuns = facts.filter((fact) => fact.capabilityUsed).length;
  const adaptiveRuns = facts.filter(
    (fact) => fact.adaptive || fact.repair,
  ).length;
  const knowledgeGaps = facts.filter(
    (fact) => fact.failureCategory === "knowledge-gap",
  ).length;
  const users = new Set(facts.map((fact) => fact.actorKey)).size;
  const verifiedResults = facts.filter((fact) =>
    [
      "verified-success",
      "valid-no-result",
      "valid-business-rejection",
    ].includes(fact.completionVerdict),
  ).length;
  const claimedResults = facts.filter(
    (fact) => fact.completionVerdict === "claimed-success",
  ).length;
  const unknownResults = facts.filter(
    (fact) => fact.completionVerdict === "unknown",
  ).length;
  const capabilityContributed = facts.filter((fact) =>
    ["direct", "assisted"].includes(fact.capabilityContribution),
  ).length;
  const knowledgeContributed = facts.filter((fact) =>
    ["route-assisted", "answer-grounded", "decisive"].includes(
      fact.knowledgeContribution,
    ),
  ).length;
  const explorationCompleted = facts.filter(
    (fact) =>
      ["exploration", "exploration-recovery", "current-page-reading"].includes(
        fact.completionMethod,
      ) &&
      [
        "verified-success",
        "valid-no-result",
        "valid-business-rejection",
      ].includes(fact.completionVerdict),
  ).length;
  const durations = facts.map((fact) => fact.durationMs);
  const trendMap = new Map<
    string,
    {
      tasks: number;
      validResults: number;
      successes: number;
      capabilityRuns: number;
      knowledgeGaps: number;
    }
  >();
  for (const fact of facts) {
    const date = fact.endedAt.slice(0, 10);
    const point = trendMap.get(date) || {
      tasks: 0,
      validResults: 0,
      successes: 0,
      capabilityRuns: 0,
      knowledgeGaps: 0,
    };
    point.tasks += 1;
    if (
      ["success", "no-result", "business-rejection"].includes(
        fact.outcomeStatus,
      )
    )
      point.validResults += 1;
    if (fact.outcomeStatus === "success") point.successes += 1;
    if (fact.capabilityUsed) point.capabilityRuns += 1;
    if (fact.failureCategory === "knowledge-gap") point.knowledgeGaps += 1;
    trendMap.set(date, point);
  }
  const knowledgeFacts = facts.filter((fact) => fact.knowledgeUsed);
  const knowledgeValid = knowledgeFacts.filter((fact) =>
    ["success", "no-result", "business-rejection"].includes(
      fact.outcomeStatus,
    ),
  ).length;
  const engagement = new Map(
    engagementRows.map((item) => [item.type, Number(item.count || 0)]),
  );
  const seenUsers = engagement.get("agent-seen") || 0;
  const openedUsers = engagement.get("agent-opened") || 0;
  const goalUsers = engagement.get("goal-submitted") || users;
  const resultUsers = engagement.get("result-seen") || users;
  return {
    range,
    engagement: {
      seenUsers,
      openedUsers,
      goalUsers,
      resultUsers,
      openRate: rate(openedUsers, seenUsers),
      goalRate: rate(goalUsers, openedUsers),
      resultRate: rate(resultUsers, goalUsers),
    },
    totals: {
      tasks: total,
      users,
      successes,
      validResults,
      cancelled,
      capabilityRuns,
      adaptiveRuns,
      knowledgeGaps,
      verifiedResults,
      claimedResults,
      unknownResults,
      capabilityContributed,
      knowledgeContributed,
      explorationCompleted,
    },
    rates: {
      goalSuccess: rate(successes, facts.length),
      validResult: rate(validResults, facts.length),
      capabilityReuse: rate(capabilityRuns, facts.length),
      adaptive: rate(adaptiveRuns, facts.length),
      knowledgeGap: rate(knowledgeGaps, facts.length),
      cancellation: rate(cancelled, facts.length),
      verifiedCompletion: rate(verifiedResults, facts.length),
      claimedOnly: rate(claimedResults, facts.length),
      capabilityContribution: rate(capabilityContributed, facts.length),
      knowledgeContribution: rate(knowledgeContributed, facts.length),
    },
    latency: {
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
    },
    trend: [...trendMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, point]) => ({ date, ...point })),
    capabilities: capabilityMetrics(facts),
    knowledge: {
      queriedTasks: knowledgeFacts.length,
      usedTasks: knowledgeFacts.length,
      successfulLookups: knowledgeFacts.filter(
        (fact) => fact.knowledgeSucceeded,
      ).length,
      contributedTasks: knowledgeContributed,
      groundedAnswers: facts.filter((fact) =>
        ["answer-grounded", "decisive"].includes(fact.knowledgeContribution),
      ).length,
      routeAssists: facts.filter(
        (fact) => fact.knowledgeContribution === "route-assisted",
      ).length,
      validResults: knowledgeValid,
      gaps: knowledgeGaps,
      validRate: rate(knowledgeValid, knowledgeFacts.length),
    },
    issues: issueMetrics(facts),
    sampleLimited: total > facts.length,
  };
}

function redactText(value: string) {
  return value
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      "[邮箱已隐藏]",
    )
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[手机号已隐藏]")
    .replace(/(?<!\d)\d{15,19}(?!\d)/g, "[敏感号码已隐藏]")
    .slice(0, 4_000);
}

function redactJson(
  value: JsonValue | undefined,
  key = "",
  depth = 0,
): JsonValue {
  if (depth > 6) return "[内容过深]";
  if (
    /password|passwd|secret|token|authorization|cookie|card|cvv|credential/i.test(
      key,
    )
  )
    return "[已隐藏]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value))
    return value
      .slice(0, 100)
      .map((item) => redactJson(item, key, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([childKey, child]) => [
          childKey,
          redactJson(child as JsonValue, childKey, depth + 1),
        ]),
    );
  return value ?? null;
}

function redactConversation(
  conversation: AgentRunConversationTurn[],
): AgentRunConversationTurn[] {
  return conversation.slice(-40).map((turn) => ({
    ...turn,
    content: redactText(turn.content),
  }));
}

function legacyActivity(episode: TaskEpisode): AgentRunActivity[] {
  const values: AgentRunActivity[] = [
    {
      id: `${episode.id}:goal`,
      sessionId: episode.taskSessionId,
      kind: "reasoning",
      state: "completed",
      label: "收到用户目标",
      detail: episode.goal,
      url: episode.startSnapshot.url,
      createdAt: episode.startedAt,
    },
    ...episode.transitions.map((transition, index) => ({
      id: `${episode.id}:transition:${index}`,
      sessionId: episode.taskSessionId,
      kind: "transition" as const,
      state: "completed" as const,
      label: "页面发生变化",
      detail:
        transition.toSnapshot?.heading ||
        transition.toSnapshot?.title ||
        transition.toScene?.sceneId ||
        "已继续执行",
      url: transition.toSnapshot?.url,
      stepIndex: index + 1,
      stepTotal: episode.transitions.length,
      createdAt: transition.endedAt,
    })),
    {
      id: `${episode.id}:result`,
      sessionId: episode.taskSessionId,
      kind: "result",
      state: ["success", "no-result", "business-rejection"].includes(
        episode.outcome.status,
      )
        ? "completed"
        : "failed",
      label: episode.outcome.summary,
      url: episode.endSnapshot.url,
      createdAt: episode.endedAt,
    },
  ];
  return values;
}

export async function getEffectRunDetail(
  siteAgentId: string,
  runId: string,
): Promise<EffectRunDetail | undefined> {
  const database = getD1Binding();
  const factRows = database
    ? await rows<FactRow>(
        database,
        `SELECT fact_json AS factJson FROM site_agent_v3_usage_facts
         WHERE site_agent_id=? AND run_id=? LIMIT 1`,
        [siteAgentId, runId],
      )
    : [];
  let fact = database
    ? factRows[0]
      ? legacyAssessment(JSON.parse(factRows[0].factJson) as EffectRunFact)
      : undefined
    : memoryFacts().get(runId);
  if (!fact || fact.siteAgentId !== siteAgentId) return undefined;
  if (!database)
    return {
      fact,
      conversation: [],
      activityTimeline: [],
      input: {},
      output: {},
      events: [],
      receipts: [],
      replayChunks: [],
    };

  const [runRows, eventRows, receiptRows, runReplayRows] = await Promise.all([
    rows<RunRow>(
      database,
      `SELECT run_json AS runJson FROM site_agent_v3_agent_runs
       WHERE id=? AND site_agent_id=? LIMIT 1`,
      [runId, siteAgentId],
    ),
    rows<EventRow>(
      database,
      `SELECT e.event_json AS eventJson FROM site_agent_v3_run_events e
       JOIN site_agent_v3_agent_runs r ON r.id=e.run_id
       WHERE e.run_id=? AND r.site_agent_id=? ORDER BY e.sequence LIMIT 300`,
      [runId, siteAgentId],
    ),
    rows<ReceiptRow>(
      database,
      `SELECT x.id,x.status,x.receipt_json AS receiptJson,x.created_at AS createdAt
       FROM site_agent_v3_execution_receipts x
       JOIN site_agent_v3_agent_runs r ON r.id=x.run_id
       WHERE x.run_id=? AND r.site_agent_id=? ORDER BY x.created_at LIMIT 200`,
      [runId, siteAgentId],
    ),
    rows<ReplayRow>(
      database,
      `SELECT chunk_json AS chunkJson FROM site_agent_v2_dom_replay_chunks
       WHERE site_agent_id=? AND run_id=? ORDER BY seq_start LIMIT 400`,
      [siteAgentId, runId],
    ),
  ]);
  const run = runRows[0]
    ? (JSON.parse(runRows[0].runJson) as AgentRun)
    : undefined;
  if (run) {
    if (fact.assessmentStatus === "legacy") {
      fact = await effectFactFromAgentRun(run);
      void saveFact(database, fact).catch(() => undefined);
    }
    return {
      fact,
      conversation: redactConversation(run.conversation),
      activityTimeline: run.activityTimeline,
      input: redactJson(run.input) as Record<string, JsonValue>,
      output: redactJson(run.output || {}) as Record<string, JsonValue>,
      events: eventRows.map((row) => {
        const event = JSON.parse(row.eventJson) as AgentRunEvent;
        return {
          id: event.id,
          type: event.type,
          sequence: event.sequence,
          payload: redactJson(event.payload) as Record<string, JsonValue>,
          createdAt: event.createdAt,
        };
      }),
      receipts: receiptRows.map((row) => ({
        id: row.id,
        status: row.status,
        payload: redactJson(
          JSON.parse(row.receiptJson) as ExecutionReceipt as unknown as JsonValue,
        ) as Record<string, JsonValue>,
        createdAt: row.createdAt,
      })),
      replayChunks: runReplayRows.map(
        (row) => JSON.parse(row.chunkJson) as DomReplayChunk,
      ),
    };
  }

  const episodeRows = await rows<HandoffEpisodeRow>(
    database,
    `SELECT episode_json AS episodeJson FROM site_agent_v2_episodes
     WHERE site_agent_id=? AND (task_session_id=? OR id=?)
     ORDER BY ended_at DESC LIMIT 1`,
    [siteAgentId, runId, runId],
  );
  if (!episodeRows[0])
    return {
      fact,
      conversation: [],
      activityTimeline: [],
      input: {},
      output: {},
      events: [],
      receipts: [],
      replayChunks: [],
    };
  const episode = JSON.parse(episodeRows[0].episodeJson) as TaskEpisode;
  const replayRows = await rows<ReplayRow>(
    database,
    `SELECT chunk_json AS chunkJson FROM site_agent_v2_dom_replay_chunks
     WHERE site_agent_id=? AND episode_id=? ORDER BY seq_start LIMIT 400`,
    [siteAgentId, episode.id],
  );
  return {
    fact,
    conversation: [],
    activityTimeline: legacyActivity(episode),
    input: redactJson(episode.input) as Record<string, JsonValue>,
    output: redactJson(
      episode.outcome.evidence,
    ) as Record<string, JsonValue>,
    events: [],
    receipts: [],
    replayChunks: replayRows.map(
      (row) => JSON.parse(row.chunkJson) as DomReplayChunk,
    ),
  };
}

export async function appendEngagementEvent(input: {
  siteAgentId: string;
  browserSessionId: string;
  runId?: string;
  type:
    | "agent-seen"
    | "agent-opened"
    | "suggestion-selected"
    | "goal-submitted"
    | "result-seen"
    | "feedback-submitted"
    | "runtime-startup-failed";
  metadata?: Record<string, JsonValue>;
}) {
  const actorKey = await effectActorKey(
    input.siteAgentId,
    input.browserSessionId,
  );
  const event = {
    id: uid("engagement"),
    siteAgentId: input.siteAgentId,
    actorKey,
    runId: input.runId,
    type: input.type,
    metadata: redactJson(input.metadata || {}),
    createdAt: new Date().toISOString(),
  };
  const database = getD1Binding();
  if (!database) {
    const events = memoryEngagement();
    events.push({
      siteAgentId: event.siteAgentId,
      actorKey: event.actorKey,
      type: event.type,
      createdAt: event.createdAt,
    });
    if (events.length > 5000) events.splice(0, events.length - 5000);
    return { event, persistence: "memory" as const };
  }
  await ensureSiteAgentV3Schema(database);
  const result = await database
    .prepare(
      `INSERT INTO site_agent_v3_engagement_events
       (id,site_agent_id,actor_key,browser_session_id,run_id,type,event_json,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .bind(
      event.id,
      event.siteAgentId,
      event.actorKey,
      event.actorKey,
      event.runId || null,
      event.type,
      JSON.stringify(event),
      event.createdAt,
    )
    .run();
  if (!result.success)
    throw new Error(result.error || "engagement_event_write_failed");
  return { event, persistence: "d1" as const };
}

type AnalysisRow = { analysisJson: string };
type AnalysisJobRow = { jobJson: string };

async function sourceForAnalysis(
  database: D1DatabaseLike | null,
  runId: string,
): Promise<EffectAnalysisSource | undefined> {
  if (!database) return memoryAnalysisSources().get(runId);
  const [runRows, receiptRows] = await Promise.all([
    rows<RunRow>(
      database,
      `SELECT run_json AS runJson FROM site_agent_v3_agent_runs WHERE id=? LIMIT 1`,
      [runId],
    ),
    rows<ReceiptRow>(
      database,
      `SELECT id,status,receipt_json AS receiptJson,created_at AS createdAt
       FROM site_agent_v3_execution_receipts WHERE run_id=?
       ORDER BY created_at LIMIT 200`,
      [runId],
    ),
  ]);
  if (!runRows[0]) return undefined;
  const run = JSON.parse(runRows[0].runJson) as AgentRun;
  return {
    run,
    actorKey:
      typeof run.agentState.effectActorKey === "string"
        ? run.agentState.effectActorKey
        : "anonymous",
    receipts: receiptRows.map((row) => ({
      id: row.id,
      receipt: JSON.parse(row.receiptJson) as ExecutionReceipt,
    })),
  };
}

async function persistImprovements(
  database: D1DatabaseLike | null,
  analysis: SubmissionAnalysis,
) {
  if (!database) return;
  const items = analysis.improvements.filter((item) => item.reviewed);
  if (!items.length) return;
  const merged = await Promise.all(
    items.map(async (item) => {
      const existing = await rows<ImprovementRow>(
        database,
        `SELECT improvement_json AS improvementJson
         FROM site_agent_v3_effect_improvements WHERE id=? LIMIT 1`,
        [item.id],
      );
      const previous = existing[0]
        ? (JSON.parse(existing[0].improvementJson) as typeof item)
        : undefined;
      return {
        ...item,
        runId: previous?.runId || item.runId,
        sourceRunIds: [
          ...new Set([
            ...(previous?.sourceRunIds || [previous?.runId].filter(Boolean)),
            ...item.sourceRunIds,
          ]),
        ] as string[],
      };
    }),
  );
  const results = await database.batch(
    merged.map((item) =>
      database
        .prepare(
          `INSERT OR REPLACE INTO site_agent_v3_effect_improvements
           (id,run_id,site_agent_id,kind,target_id,status,improvement_json,created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .bind(
          item.id,
          item.runId,
          item.siteAgentId,
          item.kind,
          item.targetId || null,
          item.status,
          JSON.stringify(item),
          item.createdAt,
        ),
    ),
  );
  const failure = results.find((result) => !result.success);
  if (failure)
    throw new Error(failure.error || "effect_improvement_write_failed");
}

async function updateJobState(
  database: D1DatabaseLike | null,
  job: EffectAnalysisJob,
  status: EffectAnalysisStatus,
  patch: Partial<EffectAnalysisJob> = {},
) {
  const next: EffectAnalysisJob = {
    ...job,
    ...patch,
    status,
    updatedAt: new Date().toISOString(),
  };
  await saveAnalysisJob(database, next);
  let current: SubmissionAnalysis | undefined;
  if (!database) {
    current = memoryAnalyses().get(job.runId);
  } else {
    const found = await rows<AnalysisRow>(
      database,
      `SELECT analysis_json AS analysisJson
       FROM site_agent_v3_effect_analyses WHERE run_id=? LIMIT 1`,
      [job.runId],
    );
    current = found[0]
      ? (JSON.parse(found[0].analysisJson) as SubmissionAnalysis)
      : undefined;
  }
  if (current)
    await saveSubmissionAnalysis(database, {
      ...current,
      status,
      attempts: next.attempts,
      updatedAt: next.updatedAt,
    });
  return next;
}

async function queuedAnalysisJobs(
  database: D1DatabaseLike | null,
  limit: number,
) {
  if (!database)
    return [...memoryAnalysisJobs().values()]
      .filter((job) => job.status === "queued")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit);
  const found = await rows<AnalysisJobRow>(
    database,
    `SELECT job_json AS jobJson FROM site_agent_v3_effect_analysis_jobs
     WHERE status='queued' ORDER BY created_at LIMIT ?`,
    [limit],
  );
  return found.map(
    (row) => JSON.parse(row.jobJson) as EffectAnalysisJob,
  );
}

export async function processQueuedEffectAnalyses(limit = 2) {
  const database = getD1Binding();
  if (database) await ensureSiteAgentV3Schema(database);
  const jobs = await queuedAnalysisJobs(
    database,
    Math.max(1, Math.min(10, limit)),
  );
  let completed = 0;
  let failed = 0;
  for (const queued of jobs) {
    let job = await updateJobState(database, queued, "analyzing", {
      attempts: queued.attempts + 1,
      lastError: undefined,
    });
    try {
      const source = await sourceForAnalysis(database, job.runId);
      if (!source) throw new Error("effect_analysis_source_missing");
      const analysis = await analyzeEffectSubmission(source, {
        onReview: async () => {
          job = await updateJobState(database, job, "reviewing");
        },
      });
      await saveSubmissionAnalysis(database, {
        ...analysis,
        attempts: job.attempts,
      });
      await persistImprovements(database, analysis);
      job = await updateJobState(database, job, "completed");
      completed += 1;
    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 500) : "unknown";
      const status = job.attempts >= 3 ? "failed" : "queued";
      await updateJobState(database, job, status, { lastError: message });
      if (status === "failed") failed += 1;
    }
  }
  return { processed: jobs.length, completed, failed };
}

export async function retryEffectAnalysis(
  siteAgentId: string,
  runId: string,
) {
  const database = getD1Binding();
  let job: EffectAnalysisJob | undefined;
  if (!database) {
    job = memoryAnalysisJobs().get(runId);
  } else {
    await ensureSiteAgentV3Schema(database);
    const found = await rows<AnalysisJobRow>(
      database,
      `SELECT job_json AS jobJson FROM site_agent_v3_effect_analysis_jobs
       WHERE site_agent_id=? AND run_id=? LIMIT 1`,
      [siteAgentId, runId],
    );
    job = found[0]
      ? (JSON.parse(found[0].jobJson) as EffectAnalysisJob)
      : undefined;
  }
  if (!job || job.siteAgentId !== siteAgentId)
    throw new Error("effect_analysis_not_found");
  const next = await updateJobState(database, job, "queued", {
    attempts: 0,
    lastError: undefined,
  });
  return next;
}

type SubmissionFilters = {
  from?: string;
  to?: string;
  goalStatus?: string;
  issue?: string;
  improvement?: string;
  status?: string;
  actorKey?: string;
  query?: string;
};

function analysisRange(filters: SubmissionFilters) {
  return effectRange(filters);
}

function matchesSubmission(
  analysis: SubmissionAnalysis,
  filters: SubmissionFilters,
) {
  const range = analysisRange(filters);
  if (
    analysis.submittedAt < range.from ||
    analysis.submittedAt > range.to
  )
    return false;
  if (
    filters.goalStatus &&
    filters.goalStatus !== "all" &&
    analysis.goalStatus !== filters.goalStatus
  )
    return false;
  if (
    filters.issue &&
    filters.issue !== "all" &&
    analysis.primaryIssue !== filters.issue &&
    !analysis.attributions.some((item) => item.issue === filters.issue)
  )
    return false;
  if (
    filters.improvement === "pending" &&
    !analysis.improvements.some((item) => item.status === "pending")
  )
    return false;
  if (
    filters.status &&
    filters.status !== "all" &&
    analysis.status !== filters.status
  )
    return false;
  if (filters.actorKey && analysis.actorKey !== filters.actorKey) return false;
  const query = filters.query?.trim().toLowerCase();
  return (
    !query ||
    `${analysis.submission} ${analysis.runId} ${analysis.actorKey}`
      .toLowerCase()
      .includes(query)
  );
}

async function allSubmissionAnalyses(
  siteAgentId: string,
  filters: SubmissionFilters,
) {
  const database = getD1Binding();
  let analyses: SubmissionAnalysis[];
  if (!database) {
    analyses = [...memoryAnalyses().values()];
  } else {
    await ensureSiteAgentV3Schema(database);
    const range = analysisRange(filters);
    const found = await rows<AnalysisRow>(
      database,
      `SELECT analysis_json AS analysisJson
       FROM site_agent_v3_effect_analyses
       WHERE site_agent_id=? AND submitted_at>=? AND submitted_at<=?
       ORDER BY submitted_at DESC,run_id DESC LIMIT 5001`,
      [siteAgentId, range.from, range.to],
    );
    analyses = found.map(
      (row) => JSON.parse(row.analysisJson) as SubmissionAnalysis,
    );
  }
  return analyses
    .filter((item) => item.siteAgentId === siteAgentId)
    .filter((item) => matchesSubmission(item, filters))
    .sort(
      (left, right) =>
        right.submittedAt.localeCompare(left.submittedAt) ||
        right.runId.localeCompare(left.runId),
    );
}

export async function listEffectSubmissions(
  siteAgentId: string,
  filters: SubmissionFilters & { cursor?: string; limit?: number },
): Promise<EffectSubmissionList> {
  const all = await allSubmissionAnalyses(siteAgentId, filters);
  const limit = Math.max(1, Math.min(100, filters.limit || 40));
  const start = filters.cursor
    ? Math.max(
        0,
        all.findIndex(
          (item) =>
            `${item.submittedAt}~${item.runId}` === filters.cursor,
        ) + 1,
      )
    : 0;
  const records = all.slice(start, start + limit);
  const last = records.at(-1);
  return {
    records,
    total: all.length,
    nextCursor:
      start + records.length < all.length && last
        ? `${last.submittedAt}~${last.runId}`
        : undefined,
  };
}

export async function summarizeEffectSubmissions(
  siteAgentId: string,
  filters: SubmissionFilters,
): Promise<EffectTrackingSummary> {
  const range = analysisRange(filters);
  const all = await allSubmissionAnalyses(siteAgentId, {
    from: range.from,
    to: range.to,
  });
  const queue: Record<EffectAnalysisStatus, number> = {
    queued: 0,
    analyzing: 0,
    reviewing: 0,
    completed: 0,
    failed: 0,
  };
  for (const item of all) queue[item.status] += 1;
  const completed = all.filter((item) => item.status === "completed");
  const achieved = completed.filter(
    (item) => item.goalStatus === "achieved",
  ).length;
  const invoked = completed.filter((item) =>
    item.attributions.some(
      (entry) => entry.area === "capability" && entry.used,
    ),
  );
  const contributed = invoked.filter((item) =>
    item.attributions.some(
      (entry) =>
        entry.area === "capability" &&
        ["direct", "supporting"].includes(entry.contribution),
    ),
  ).length;
  return {
    range,
    queue,
    goal: {
      achieved,
      analyzed: completed.length,
      rate: rate(achieved, completed.length),
    },
    capability: {
      contributed,
      invoked: invoked.length,
      rate: rate(contributed, invoked.length),
    },
    pendingImprovements: new Set(
      completed.flatMap((item) =>
        item.improvements
          .filter((entry) => entry.status === "pending")
          .map((entry) => entry.id),
      ),
    ).size,
  };
}

type HandoffEpisodeRow = { id: string; episodeJson: string };
type SignalRow = { id: string; signalJson: string };
type CapabilityRow = { id: string; name: string; status: string };

const IN_PROGRESS_RUN_STATUS = new Set(["running", "awaiting-page", "awaiting-user"]);

/**
 * Find what the capability centre did with one Episode.
 *
 * The signal row carries both provenance and outcome — `episodeIds` and a
 * `resolution` naming the proposal, the task and the reason — so it is the only
 * table that has to be searched. Absence of a signal is reported as unconfirmed
 * rather than as "not handed over": the first is the far side's state, the
 * second is our own judgement, and conflating them would hide a lost delivery.
 */
async function downstreamForEpisode(
  database: D1DatabaseLike,
  siteAgentId: string,
  episodeId: string,
): Promise<CapabilityHandoffDownstream> {
  for (const kind of ["legacy-create", "create", "strengthen"] as const) {
    const intake = await getCapabilityExperienceOutboxItem(siteAgentId, episodeId, kind);
    if (!intake) continue;
    const result = intake.result;
    return {
      intakeId: intake.id,
      state: intake.status === "failed" ? "intake-failed" : intake.status === "processing" ? "generating"
        : intake.status !== "completed" ? "queued" : result?.disposition === "Created" ? "task-created"
          : result?.disposition === "Disabled" ? "disabled" : "duplicate",
      ...(typeof result?.taskId === "string" ? { taskId: result.taskId } : {}),
      ...(typeof result?.capabilityId === "string" ? { capabilityId: result.capabilityId } : {}),
      summary: redactText(intake.lastError || (typeof result?.reason === "string" ? result.reason :
        intake.status === "completed" ? "接入结果已保存，可在能力中心查看。" : "执行记录已保存，服务端会继续处理；无需保持网页打开。")),
    };
  }
  const found = await rows<SignalRow>(
    database,
    `SELECT id, signal_json AS signalJson FROM site_agent_v2_capability_signals
     WHERE site_agent_id=? AND signal_json LIKE ? ORDER BY created_at DESC LIMIT 1`,
    [siteAgentId, `%${episodeId}%`],
  );
  if (!found[0]) return { state: "unconfirmed" };
  let signal: Record<string, JsonValue>;
  try { signal = JSON.parse(found[0].signalJson) as Record<string, JsonValue>; }
  catch { return { state: "unconfirmed" }; }
  const episodeIds = Array.isArray(signal.episodeIds) ? signal.episodeIds : [];
  // A LIKE match can hit a substring elsewhere in the row; confirm provenance.
  if (!episodeIds.includes(episodeId)) return { state: "unconfirmed" };
  const resolution = (signal.resolution && typeof signal.resolution === "object" && !Array.isArray(signal.resolution)
    ? signal.resolution
    : {}) as Record<string, JsonValue>;
  const disposition = typeof resolution.disposition === "string" ? resolution.disposition : undefined;
  const proposalId = typeof resolution.proposalId === "string" ? resolution.proposalId : undefined;
  const base: CapabilityHandoffDownstream = {
    state: "legacy",
    signalId: found[0].id,
    ...(disposition ? { disposition } : {}),
    ...(proposalId ? { proposalId } : {}),
    ...(typeof resolution.taskId === "string" ? { taskId: resolution.taskId } : {}),
    ...(typeof resolution.summary === "string" ? { summary: redactText(resolution.summary) } : {}),
  };
  const capabilities = await rows<CapabilityRow>(
    database,
    `SELECT id, name, status FROM site_agent_v2_capabilities
     WHERE site_agent_id=? AND capability_json LIKE ? LIMIT 1`,
    [siteAgentId, `%${episodeId}%`],
  );
  if (!capabilities[0]) return base;
  return {
    ...base,
    capabilityId: capabilities[0].id,
    capabilityName: capabilities[0].name,
    capabilityStatus: capabilities[0].status,
  };
}

/**
 * Put both sides' reading of one execution next to each other.
 *
 * The User Agent's effect is recomputed from the stored goal because it is not
 * written into the Episode today — that gap is precisely why the capability
 * centre has to infer an operation from wording. Neither value is rewritten to
 * match the other; a disagreement is information, not an error to smooth over.
 */
function judgementFor(goal: string, downstream: CapabilityHandoffDownstream, capabilityJson?: string): CapabilityHandoffJudgement {
  const userAgentEffect = goal ? executionRequirementForGoal(goal).effect : undefined;
  let capabilityOperation: "read" | "write" | undefined;
  let capabilitySideEffectMode: string | undefined;
  if (capabilityJson) {
    try {
      const parsed = JSON.parse(capabilityJson) as Record<string, JsonValue>;
      if (parsed.operation === "read" || parsed.operation === "write") capabilityOperation = parsed.operation;
      const acceptance = parsed.acceptanceSpec as Record<string, JsonValue> | undefined;
      const policy = acceptance?.sideEffectPolicy as Record<string, JsonValue> | undefined;
      if (typeof policy?.mode === "string") capabilitySideEffectMode = policy.mode;
    } catch { /* Leave both sides absent rather than guessing one. */ }
  }
  if (!userAgentEffect || !capabilityOperation) {
    return {
      ...(userAgentEffect ? { userAgentEffect } : {}),
      ...(capabilityOperation ? { capabilityOperation } : {}),
      ...(capabilitySideEffectMode ? { capabilitySideEffectMode } : {}),
    };
  }
  void downstream;
  return {
    userAgentEffect,
    capabilityOperation,
    ...(capabilitySideEffectMode ? { capabilitySideEffectMode } : {}),
    agrees: (userAgentEffect === "read") === (capabilityOperation === "read"),
  };
}

/**
 * Recompute what each of this run's Episodes would hand over.
 *
 * A run can produce more than one Episode, and production has such runs. Every
 * one is listed with its own verdict rather than picking a primary: any rule
 * for picking would be a guess, and a run with two Episodes is itself worth
 * seeing.
 */
async function capabilityHandoffForRun(
  database: D1DatabaseLike,
  siteAgentId: string,
  runId: string,
  runStatus: string,
): Promise<CapabilityHandoffView> {
  const episodeRows = await rows<EpisodeRow>(
    database,
    `SELECT id, episode_json AS episodeJson FROM site_agent_v2_episodes
     WHERE site_agent_id=? AND task_session_id=? ORDER BY started_at LIMIT 20`,
    [siteAgentId, runId],
  );
  if (!episodeRows.length) {
    // Why there is no Episode depends on how the run ended, and the three
    // cases are not interchangeable. Answering without driving the page is the
    // design working; a cancelled or failed run simply never got that far, and
    // calling that "by design" would file a fault as intended behaviour.
    //
    // A run that answered from the knowledge base cannot be told apart from a
    // plain direct answer here: entering a verified Scene hands the run to the
    // destination document, and the stored run keeps that document's activity
    // rather than the origin's. So this says only what the record supports.
    if (IN_PROGRESS_RUN_STATUS.has(runStatus)) {
      return { conclusion: "pending", derived: true, episodes: [] };
    }
    const reason = runStatus === "cancelled"
      ? "run-cancelled" as const
      : runStatus === "failed"
        ? "run-unfinished" as const
        : "noEpisode" as const;
    return { conclusion: "not-delivered", reason, derived: true, episodes: [] };
  }
  const episodes: CapabilityHandoffEpisodeView[] = [];
  for (const row of episodeRows) {
    let episode: TaskEpisode;
    try { episode = JSON.parse(row.episodeJson) as TaskEpisode; }
    catch { continue; }
    const handoff = capabilityHandoffForEpisode(episode, {});
    const downstream = await downstreamForEpisode(database, siteAgentId, episode.id);
    const capabilityJson = downstream.capabilityId
      ? (await rows<{ capabilityJson: string }>(
        database,
        `SELECT capability_json AS capabilityJson FROM site_agent_v2_capabilities WHERE id=? LIMIT 1`,
        [downstream.capabilityId],
      ))[0]?.capabilityJson
      : undefined;
    episodes.push({
      episodeId: episode.id,
      mode: episode.mode,
      goal: redactText(episode.goal || ""),
      outcomeStatus: episode.outcome.status,
      outcomeCode: episode.outcome.code,
      startedAt: episode.startedAt,
      endedAt: episode.endedAt,
      startPageUrl: redactText(episode.startSnapshot?.url || ""),
      endPageUrl: redactText(episode.endSnapshot?.url || ""),
      actionCount: episode.experience?.actions.length || 0,
      episodeBytes: row.episodeJson.length,
      delivered: Boolean(downstream.intakeId || downstream.signalId),
      ...(handoff.delivered ? {} : { blockedReason: handoff.reason }),
      ...(handoff.bytes === undefined ? {} : { payloadBytes: handoff.bytes }),
      ...(handoff.delivered
        // Only the contract the two modules agree on travels: the intermediate
        // handover payload and the source Episode stay server-side. Built by
        // the same function the discovery path calls, so this is the shape
        // generation receives rather than a second rendering of it. The page
        // text it carries in `accessibleName` and `contextText` is redacted
        // before it leaves here.
        ? {
          generationInput: redactJson(
            discoveryGenerationInputFromExperience(handoff.experience) as unknown as JsonValue,
          ),
        }
        : {}),
      downstream,
      judgement: judgementFor(episode.goal || "", downstream, capabilityJson),
    });
  }
  if (episodes.some((item) => item.delivered)) {
    return { conclusion: "delivered", derived: episodes.some(item => !item.downstream.intakeId), episodes };
  }
  if (IN_PROGRESS_RUN_STATUS.has(runStatus)) {
    return { conclusion: "pending", derived: true, episodes };
  }
  const reasons = new Set(episodes.map((item) => item.blockedReason).filter(Boolean));
  return {
    conclusion: "not-delivered",
    ...(reasons.size === 1 ? { reason: [...reasons][0] } : {}),
    derived: true,
    episodes,
  };
}

export async function getEffectSubmissionDetail(
  siteAgentId: string,
  runId: string,
): Promise<EffectSubmissionDetail | undefined> {
  const database = getD1Binding();
  let analysis: SubmissionAnalysis | undefined;
  if (!database) {
    analysis = memoryAnalyses().get(runId);
  } else {
    await ensureSiteAgentV3Schema(database);
    const found = await rows<AnalysisRow>(
      database,
      `SELECT analysis_json AS analysisJson
       FROM site_agent_v3_effect_analyses
       WHERE site_agent_id=? AND run_id=? LIMIT 1`,
      [siteAgentId, runId],
    );
    analysis = found[0]
      ? (JSON.parse(found[0].analysisJson) as SubmissionAnalysis)
      : undefined;
  }
  if (!analysis || analysis.siteAgentId !== siteAgentId) return undefined;
  const source = await sourceForAnalysis(database, runId);
  if (!source)
    return {
      analysis,
      conversation: [],
      activityTimeline: [],
      receipts: [],
      capabilityHandoff: { conclusion: "not-delivered", reason: "noEpisode", derived: true, episodes: [] },
    };
  return {
    analysis,
    conversation: redactConversation(source.run.conversation),
    activityTimeline: source.run.activityTimeline,
    receipts: source.receipts.map(({ id, receipt }) => ({
      id,
      status: receipt.status,
      payload: redactJson(
        receipt as unknown as JsonValue,
      ) as Record<string, JsonValue>,
      createdAt: receipt.createdAt,
    })),
    capabilityHandoff: database
      ? await capabilityHandoffForRun(database, siteAgentId, runId, source.run.status)
      : { conclusion: "pending", derived: true, episodes: [] },
  };
}

/** On site deletion: effect analyses, analysis jobs, improvement suggestions, engagement events, usage facts. */
export const EFFECT_DELETION_TABLES = [
  "site_agent_v3_effect_improvements",
  "site_agent_v3_effect_analysis_jobs",
  "site_agent_v3_effect_analyses",
  "site_agent_v3_engagement_events",
  "site_agent_v3_usage_facts",
] as const;

export function effectDeletionStatements(database: D1DatabaseLike, siteAgentId: string): D1PreparedStatementLike[] {
  return EFFECT_DELETION_TABLES.map((table) => database.prepare(`DELETE FROM ${table} WHERE site_agent_id=?`).bind(siteAgentId));
}

export function deleteMemoryEffectData(siteAgentId: string) {
  for (const [key, fact] of memoryFacts()) if (fact.siteAgentId === siteAgentId) memoryFacts().delete(key);
  for (const [key, analysis] of memoryAnalyses()) if (analysis.siteAgentId === siteAgentId) memoryAnalyses().delete(key);
  for (const [key, job] of memoryAnalysisJobs()) if (job.siteAgentId === siteAgentId) memoryAnalysisJobs().delete(key);
  for (const [key, source] of memoryAnalysisSources()) if (source.run.scope.siteAgentId === siteAgentId) memoryAnalysisSources().delete(key);
  const engagement = memoryEngagement();
  for (let index = engagement.length - 1; index >= 0; index -= 1) {
    if (engagement[index].siteAgentId === siteAgentId) engagement.splice(index, 1);
  }
}
