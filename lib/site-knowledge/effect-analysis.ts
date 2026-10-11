import { getModelConfig } from "../model-config";
import type {
  EffectAttribution,
  EffectContribution,
  EffectFactRef,
  EffectGoalCheck,
  EffectGoalStatus,
  EffectImprovementKind,
  EffectIssueCode,
  SubmissionAnalysis,
} from "./effect-types";
import { modelJson } from "./model-analyzer";
import {
  stableHash,
  type AgentRun,
  type ExecutionReceipt,
  type JsonValue,
} from "./protocol";

export type EffectAnalysisSource = {
  run: AgentRun;
  actorKey: string;
  receipts: Array<{ id: string; receipt: ExecutionReceipt }>;
};

type ModelAttribution = {
  area?: string;
  subjectId?: string;
  subjectName?: string;
  used?: boolean;
  execution?: string;
  contribution?: string;
  issue?: string;
  factRefIds?: string[];
};

type ModelGoalCheck = {
  requirement?: string;
  status?: string;
  factRefIds?: string[];
};

type ModelImprovement = {
  kind?: string;
  targetId?: string;
  title?: string;
  factRefIds?: string[];
};

type ModelEffectAnalysis = {
  goalStatus?: string;
  goalChecks?: ModelGoalCheck[];
  attributions?: ModelAttribution[];
  primaryIssue?: string;
  improvements?: ModelImprovement[];
  confidence?: number;
};

const GOAL_STATUSES = new Set<EffectGoalStatus>([
  "achieved",
  "partially-achieved",
  "not-achieved",
  "insufficient-evidence",
]);
const CONTRIBUTIONS = new Set<EffectContribution>([
  "direct",
  "supporting",
  "none",
  "unknown",
]);
const ISSUES = new Set<EffectIssueCode>([
  "none",
  "capability-unavailable",
  "capability-routing-missed",
  "capability-call-failed",
  "capability-output-mismatch",
  "knowledge-query-failed",
  "knowledge-missing",
  "knowledge-irrelevant",
  "knowledge-unused",
  "page-target-not-found",
  "page-operation-failed",
  "page-state-unchanged",
  "page-unverifiable",
]);
const IMPROVEMENTS = new Set<EffectImprovementKind>([
  "create-capability",
  "repair-capability",
  "improve-routing",
  "add-knowledge",
]);

function text(value: unknown, limit = 240) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function record(value: JsonValue | undefined) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

function redacted(value: string) {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[邮箱已隐藏]")
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[手机号已隐藏]")
    .replace(/(?<!\d)\d{15,19}(?!\d)/g, "[敏感号码已隐藏]")
    .slice(0, 4_000);
}

function sourceFacts(source: EffectAnalysisSource) {
  const refs = new Map<string, EffectFactRef>();
  const activities = source.run.activityTimeline.slice(-100).map((item) => {
    const ref: EffectFactRef = {
      id: item.id,
      source: "activity",
      label: text(item.label, 120) || "执行记录",
    };
    refs.set(ref.id, ref);
    return {
      id: item.id,
      kind: item.kind,
      state: item.state,
      label: redacted(item.label),
      detail: item.detail ? redacted(item.detail) : undefined,
      capabilityId: item.capabilityId,
      capabilityName: item.capabilityName,
      operationName: item.operationName,
      url: item.url,
      input: record(item.input),
      output: record(item.output),
    };
  });
  const receipts = source.receipts.slice(-80).map(({ id, receipt }) => {
    const ref: EffectFactRef = {
      id,
      source: "receipt",
      label: `${receipt.status === "completed" ? "执行成功" : "执行失败"} · ${receipt.sliceId}`,
    };
    refs.set(ref.id, ref);
    return {
      id,
      status: receipt.status,
      sliceId: receipt.sliceId,
      pageEpoch: receipt.pageEpoch,
      output: receipt.outputBindings,
      error: receipt.error,
    };
  });
  const outcomeRef: EffectFactRef = {
    id: `${source.run.id}:outcome`,
    source: "outcome",
    label: "运行结果",
  };
  refs.set(outcomeRef.id, outcomeRef);
  const routeActivity = [...source.run.activityTimeline]
    .reverse()
    .find((item) => item.kind === "capability-search");
  return {
    refs,
    payload: {
      runId: source.run.id,
      submission: redacted(source.run.goal),
      recentConversation: source.run.conversation.slice(-8).map((turn) => ({
        role: turn.role,
        content: redacted(turn.content),
      })),
      outcome: source.run.outcome
        ? {
            id: outcomeRef.id,
            status: source.run.outcome.status,
            code: source.run.outcome.code,
            summary: redacted(source.run.outcome.summary),
            evidence: record(source.run.outcome.evidence),
          }
        : undefined,
      output: record(source.run.output as JsonValue),
      activities,
      receipts,
      routeSnapshot: Object.keys(
        record(source.run.agentState.capabilityRouteSnapshot),
      ).length
        ? record(source.run.agentState.capabilityRouteSnapshot)
        : Object.keys(record(source.run.agentState.capabilityCandidates)).length
          ? record(source.run.agentState.capabilityCandidates)
          : record(routeActivity?.output),
    },
  };
}

function refsFor(ids: string[] | undefined, refs: Map<string, EffectFactRef>) {
  return (ids || []).flatMap((id) => {
    const ref = refs.get(id);
    return ref ? [ref] : [];
  });
}

function clampGoal(value: string | undefined): EffectGoalStatus {
  return GOAL_STATUSES.has(value as EffectGoalStatus)
    ? (value as EffectGoalStatus)
    : "insufficient-evidence";
}

function clampIssue(value: string | undefined): EffectIssueCode {
  return ISSUES.has(value as EffectIssueCode)
    ? (value as EffectIssueCode)
    : "none";
}

function normalizeAnalysis(
  raw: ModelEffectAnalysis,
  source: EffectAnalysisSource,
  refs: Map<string, EffectFactRef>,
  reviewed: boolean,
  model: string,
): SubmissionAnalysis {
  const now = new Date().toISOString();
  const attributions: EffectAttribution[] = (raw.attributions || [])
    .slice(0, 20)
    .flatMap((item) => {
      if (!["capability", "knowledge", "page"].includes(item.area || ""))
        return [];
      const contribution = CONTRIBUTIONS.has(item.contribution as EffectContribution)
        ? (item.contribution as EffectContribution)
        : "unknown";
      const execution = ["not-used", "succeeded", "failed", "unknown"].includes(
        item.execution || "",
      )
        ? (item.execution as EffectAttribution["execution"])
        : "unknown";
      return [
        {
          area: item.area as EffectAttribution["area"],
          subjectId: text(item.subjectId, 120) || undefined,
          subjectName:
            text(item.subjectName, 120) ||
            (item.area === "capability"
              ? "能力"
              : item.area === "knowledge"
                ? "网站知识"
                : "页面探索"),
          used: item.used === true,
          execution,
          contribution,
          issue: clampIssue(item.issue),
          factRefs: refsFor(item.factRefIds, refs),
        },
      ];
    });
  for (const area of ["capability", "knowledge", "page"] as const) {
    if (!attributions.some((item) => item.area === area)) {
      attributions.push({
        area,
        subjectName:
          area === "capability"
            ? "能力"
            : area === "knowledge"
              ? "网站知识"
              : "页面探索",
        used: false,
        execution: "not-used",
        contribution: "none",
        issue: "none",
        factRefs: [],
      });
    }
  }
  const improvements = (raw.improvements || [])
    .slice(0, 8)
    .flatMap((item) => {
      if (!IMPROVEMENTS.has(item.kind as EffectImprovementKind)) return [];
      return [
        {
          id: `effect_improvement_${stableHash(
            `${item.kind}:${text(item.targetId, 120) || text(item.title, 180)}`,
          ).slice(0, 20)}`,
          runId: source.run.id,
          siteAgentId: source.run.scope.siteAgentId,
          kind: item.kind as EffectImprovementKind,
          status: "pending" as const,
          targetId: text(item.targetId, 120) || undefined,
          title: text(item.title, 180) || "待处理改进项",
          factRefs: refsFor(item.factRefIds, refs),
          sourceRunIds: [source.run.id],
          reviewed,
          createdAt: now,
        },
      ];
    });
  const goalChecks: EffectGoalCheck[] = (raw.goalChecks || [])
    .slice(0, 8)
    .flatMap((item, index) => {
      const requirement = text(item.requirement, 240);
      if (!requirement) return [];
      const status = ["met", "partially-met", "unmet", "unknown"].includes(
        item.status || "",
      )
        ? (item.status as EffectGoalCheck["status"])
        : "unknown";
      return [
        {
          id: `goal_check_${index + 1}`,
          requirement,
          status,
          factRefs: refsFor(item.factRefIds, refs),
        },
      ];
    });
  return {
    version: 1,
    runId: source.run.id,
    siteAgentId: source.run.scope.siteAgentId,
    actorKey: source.actorKey,
    submission: redacted(source.run.goal),
    submittedAt: source.run.createdAt,
    finishedAt: source.run.updatedAt,
    status: "completed",
    goalStatus: clampGoal(raw.goalStatus),
    goalChecks,
    attributions,
    primaryIssue: clampIssue(raw.primaryIssue),
    improvements,
    reviewed,
    confidence: Math.max(0, Math.min(1, Number(raw.confidence || 0))),
    model,
    attempts: reviewed ? 2 : 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function validateEffectAnalysis(
  analysis: SubmissionAnalysis,
  source: EffectAnalysisSource,
) {
  const problems: string[] = [];
  const capabilityActivities = source.run.activityTimeline.filter(
    (item) => item.kind === "capability",
  );
  const knowledgeActivities = source.run.activityTimeline.filter(
    (item) => item.kind === "knowledge",
  );
  const pageActivities = source.run.activityTimeline.filter((item) =>
    ["page", "navigation", "transition"].includes(item.kind),
  );
  const routeSnapshotAvailable =
    Boolean(source.run.agentState.capabilityRouteSnapshot) ||
    Boolean(source.run.agentState.capabilityCandidates) ||
    source.run.activityTimeline.some(
      (item) => item.kind === "capability-search" && item.state === "completed",
    );
  for (const item of analysis.attributions) {
    if (
      item.area === "capability" &&
      !capabilityActivities.length &&
      item.contribution !== "none"
    )
      problems.push("未调用能力却判断能力产生贡献");
    if (
      item.area === "knowledge" &&
      !knowledgeActivities.length &&
      item.contribution !== "none"
    )
      problems.push("未检索知识却判断知识产生贡献");
    if (
      item.area === "page" &&
      !pageActivities.length &&
      item.contribution !== "none"
    )
      problems.push("没有页面过程却判断页面产生贡献");
    if (item.execution === "failed" && item.contribution === "direct")
      problems.push("执行失败不能直接贡献");
    if (
      ["capability-unavailable", "capability-routing-missed"].includes(
        item.issue,
      ) &&
      !routeSnapshotAvailable
    )
      problems.push("缺少能力路由快照，不能判断能力缺失或路由遗漏");
  }
  return problems;
}

const ANALYSIS_PROMPT = `你是独立的效果归因分析器。分析对象是一条用户提交及其完整可观察执行记录，不拆分任务类型。

先形成最小验收条件，再判断用户目标：achieved、partially-achieved、not-achieved、insufficient-evidence。
能力、网站知识、页面探索必须分别归因，允许同时贡献。contribution 只能是 direct、supporting、none、unknown。
issue 只能从 schema 枚举中选择。不能把发生调用、点击或页面变化直接等同为贡献；必须有记录证明其满足、支持或验证了用户要求。
能力调用成功但结果不满足目标，应标 capability-output-mismatch。能力调用失败标 capability-call-failed。
只有 routeSnapshot 明确存在合适候选但未使用，才能标 capability-routing-missed；明确没有合适候选才能标 capability-unavailable；没有 routeSnapshot 时两者都不能判断。
知识只有发生检索并返回内容后才能判断采用。页面探索只有产生可验证页面状态、内容或业务结果时才能直接贡献。
改进项仅在证据明确时给出：create-capability、repair-capability、improve-routing、add-knowledge。所有结论通过 factRefIds 关联给定 activity、receipt 或 outcome id。不要输出分析散文。`;

function analysisSchema() {
  return {
    goalStatus:
      "achieved | partially-achieved | not-achieved | insufficient-evidence",
    goalChecks: [
      {
        requirement: "最小、可验证的用户要求",
        status: "met | partially-met | unmet | unknown",
        factRefIds: ["已提供的事实 id"],
      },
    ],
    attributions: [
      {
        area: "capability | knowledge | page",
        subjectId: "能力 id，可选",
        subjectName: "名称",
        used: true,
        execution: "not-used | succeeded | failed | unknown",
        contribution: "direct | supporting | none | unknown",
        issue:
          "none | capability-unavailable | capability-routing-missed | capability-call-failed | capability-output-mismatch | knowledge-query-failed | knowledge-missing | knowledge-irrelevant | knowledge-unused | page-target-not-found | page-operation-failed | page-state-unchanged | page-unverifiable",
        factRefIds: ["已提供的事实 id"],
      },
    ],
    primaryIssue: "同一 issue 枚举",
    improvements: [
      {
        kind:
          "create-capability | repair-capability | improve-routing | add-knowledge",
        targetId: "能力 id，可选",
        title: "简洁、可执行的中文改进项",
        factRefIds: ["已提供的事实 id"],
      },
    ],
    confidence: "0-1",
  };
}

export async function analyzeEffectSubmission(
  source: EffectAnalysisSource,
  options?: { onReview?(): void | Promise<void> },
) {
  const { refs, payload } = sourceFacts(source);
  const primary = await modelJson<ModelEffectAnalysis>(
    ANALYSIS_PROMPT,
    { ...payload, schema: analysisSchema() },
    60_000,
    undefined,
    "semantic",
  );
  if (!primary) throw new Error("effect_analysis_model_unavailable");
  const primaryModel = getModelConfig("semantic").model;
  let analysis = normalizeAnalysis(primary, source, refs, false, primaryModel);
  const problems = validateEffectAnalysis(analysis, source);
  const needsReview =
    (analysis.confidence || 0) < 0.75 ||
    problems.length > 0 ||
    analysis.improvements.length > 0 ||
    analysis.attributions.some(
      (item) => item.area === "page" && item.contribution === "direct",
    );
  if (!needsReview) return analysis;
  await options?.onReview?.();
  const reviewed = await modelJson<ModelEffectAnalysis>(
    `${ANALYSIS_PROMPT}
你是最终 Reviewer。主分析可能存在错误。必须根据原始事实修正，并特别处理这些程序校验问题：${problems.join("；") || "无"}。只有证据充分的改进项可以保留。`,
    { ...payload, primaryAnalysis: primary, schema: analysisSchema() },
    90_000,
    undefined,
    "general",
  );
  if (!reviewed) throw new Error("effect_review_model_unavailable");
  analysis = normalizeAnalysis(
    reviewed,
    source,
    refs,
    true,
    getModelConfig("general").model,
  );
  const reviewProblems = validateEffectAnalysis(analysis, source);
  if (reviewProblems.length) {
    return {
      ...analysis,
      goalStatus: "insufficient-evidence" as const,
      improvements: [],
      primaryIssue: "none" as const,
      confidence: Math.min(analysis.confidence || 0, 0.49),
    };
  }
  return analysis;
}
