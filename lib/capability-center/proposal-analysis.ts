import { modelJson } from "../site-knowledge/model-analyzer";
import {
  normalizeGoal,
  stableHash,
  type JsonSchema,
  type JsonValue,
  type ModelInvocation,
  type SiteAgentReleaseV2,
} from "../site-knowledge/protocol";
import type { Capability, CapabilityAcceptanceSpec, CapabilityProposal, CapabilityProposalKind } from "./model";

export type CapabilityProposalDisposition = "duplicate" | "new" | "improvement" | "repair" | "rejected";

export type CapabilityFeasibility = {
  status: "feasible" | "blocked";
  summary: string;
  blockers: string[];
  requiredResources: string[];
  plan: Array<{ step: string; objective: string; resource?: string }>;
};

export type CapabilityProposalAnalysis = {
  disposition: CapabilityProposalDisposition;
  summary: string;
  confidence: number;
  duplicateCapabilityId?: string;
  targetCapabilityId?: string;
  capability?: Pick<
    Capability,
    | "stableKey"
    | "intentKey"
    | "name"
    | "localizedNames"
    | "description"
    | "goalTemplate"
    | "kind"
    | "structure"
    | "operation"
    | "exposure"
    | "resultKind"
    | "inputSchema"
    | "outputSchema"
    | "acceptanceSpec"
    | "executionRequirements"
  >;
  evidence: string[];
  modelUsed: boolean;
  feasibility: CapabilityFeasibility;
  manualOverride?: {
    authorizedBy: "administrator";
    reason: string;
    assignedResources: string[];
    authorizedAt: string;
  };
};

type ModelAnalysis = {
  disposition?: CapabilityProposalDisposition;
  summary?: string;
  confidence?: number;
  duplicateCapabilityId?: string;
  targetCapabilityId?: string;
  capability?: {
    intentKey?: string;
    name?: string;
    localizedNames?: { zhCN?: string; en?: string };
    description?: string;
    goalTemplate?: string;
    kind?: "navigation" | "task";
    operation?: "read" | "write";
    resultKind?: "page" | "data" | "action";
    inputSchema?: JsonSchema;
    outputSchema?: JsonSchema;
    acceptanceSpec?: CapabilityAcceptanceSpec;
    executionRequirements?: Capability["executionRequirements"];
  };
  evidence?: string[];
  feasibility?: {
    status?: "feasible" | "blocked";
    summary?: string;
    blockers?: string[];
    requiredResources?: string[];
    plan?: Array<{ step?: string; objective?: string; resource?: string }>;
  };
};

function authenticationRequired(goal: string, model: ModelAnalysis | undefined) {
  return model?.capability?.executionRequirements?.authentication === "required"
    || /(?:退出登录|登出|注销登录|\bsign\s*out\b|\blog\s*out\b|\blogout\b)/iu.test(goal);
}

function authenticatedEvidence(value: JsonValue | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, JsonValue>;
  return record.authenticated === true
    || record.authentication === "authenticated"
    || record.loginState === "authenticated"
    || record.sessionState === "authenticated";
}

function feasibilityFor(
  proposal: CapabilityProposal,
  model: ModelAnalysis | undefined,
  runtimeEvidence: JsonValue | undefined,
): CapabilityFeasibility {
  const requiresAuthentication = authenticationRequired(proposal.requestedGoal, model);
  const missingAuthentication = requiresAuthentication && !authenticatedEvidence(runtimeEvidence);
  const status = missingAuthentication || model?.feasibility?.status === "blocked" ? "blocked" : "feasible";
  const blockers = [
    ...(missingAuthentication ? ["缺少可用于探索和验证的已登录浏览器会话或测试账号。"] : []),
    ...(model?.feasibility?.blockers || []).map((item) => String(item).trim()).filter(Boolean),
  ].slice(0, 12);
  const requiredResources = [
    ...(missingAuthentication ? ["authenticated-browser-or-test-account"] : []),
    ...(model?.feasibility?.requiredResources || []).map((item) => String(item).trim()).filter(Boolean),
  ].filter((item, index, items) => items.indexOf(item) === index).slice(0, 12);
  const modelPlan = (model?.feasibility?.plan || []).flatMap((item, index) => {
    const objective = item?.objective?.trim();
    if (!objective) return [];
    return [{
      step: item.step?.trim().slice(0, 120) || `step-${index + 1}`,
      objective: objective.slice(0, 500),
      ...(item.resource?.trim() ? { resource: item.resource.trim().slice(0, 160) } : {}),
    }];
  }).slice(0, 12);
  const plan = modelPlan.length ? modelPlan : [
    {
      step: "prepare",
      objective: requiresAuthentication ? "准备已登录且可回收的浏览器环境。" : "确认入口页面、运行环境与验收前置条件。",
      ...(requiresAuthentication ? { resource: "authenticated-browser-or-test-account" } : {}),
    },
    { step: "author", objective: "生成能力实现，并通过最小自证用例。", resource: "authoring-runner" },
    { step: "validate", objective: "在独立浏览器中按稳定契约完成验证并采集证据。", resource: "validation-runner" },
  ];
  return {
    status,
    summary: model?.feasibility?.summary?.trim().slice(0, 1_000)
      || (status === "blocked" ? blockers[0] || "当前资源无法可靠完成该能力。" : "当前前置条件允许进入能力构建。"),
    blockers,
    requiredResources,
    plan,
  };
}

function comparable(value: string) {
  return normalizeGoal(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function exactDuplicate(proposal: CapabilityProposal, capabilities: Capability[]) {
  const requested = comparable(proposal.requestedGoal);
  if (!requested) return undefined;
  return capabilities.find((capability) =>
    capability.status !== "deleted"
    && [capability.name, capability.localizedNames?.zhCN, capability.localizedNames?.en, capability.goalTemplate, capability.intentKey, capability.stableKey]
      .filter((value): value is string => Boolean(value))
      .some((value) => comparable(value) === requested));
}

function improvementRequested(proposal: CapabilityProposal) {
  if (proposal.kind === "improvement" || proposal.kind === "repair" || proposal.capabilityId) return true;
  return /(优化|改进|修复|修正|失效|过时|不好用|报错|失败|不准确|不稳定|增强|升级)/u.test(
    `${proposal.title} ${proposal.description} ${proposal.requestedGoal}`,
  );
}

function objectSchema(value: JsonSchema | undefined, fallback: JsonSchema): JsonSchema {
  if (!value || value.type !== "object" || !value.properties || typeof value.properties !== "object") return fallback;
  return {
    ...value,
    type: "object",
    properties: Object.fromEntries(Object.entries(value.properties).slice(0, 40)),
    required: Array.isArray(value.required) ? value.required.filter((key) => key in value.properties!).slice(0, 40) : undefined,
  };
}

function inputSchemaFrom(input: Record<string, JsonValue>): JsonSchema {
  const entries = Object.entries(input).slice(0, 30).map(([key, value]) => [key, {
    type: Array.isArray(value) ? "array" : value === null ? "string" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : typeof value === "object" ? "object" : "string",
    description: key,
  }] satisfies [string, JsonSchema]);
  return { type: "object", properties: Object.fromEntries(entries), required: entries.map(([key]) => key) };
}

function stableKey(intentKey: string, goal: string) {
  const normalized = (intentKey || normalizeGoal(goal)).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || `capability_${stableHash(goal).slice(0, 16)}`;
}

function acceptanceSpecFrom(
  proposed: CapabilityAcceptanceSpec | undefined,
  input: { operation: Capability["operation"]; resultKind: Capability["resultKind"]; outputSchema: JsonSchema },
): CapabilityAcceptanceSpec {
  const criteria = Array.isArray(proposed?.criteria)
    ? proposed.criteria.flatMap((criterion, index) => {
      if (!criterion || !["url", "text", "output", "checkpoint", "side-effect"].includes(criterion.kind)
        || !["equals", "contains", "exists", "changed", "unchanged", "recorded"].includes(criterion.operator)) return [];
      return [{
        id: String(criterion.id || `criterion:${index + 1}`).slice(0, 120),
        label: String(criterion.label || criterion.id || `验收条件 ${index + 1}`).slice(0, 240),
        kind: criterion.kind,
        operator: criterion.operator,
        ...(criterion.expected !== undefined ? { expected: criterion.expected } : {}),
        ...(criterion.field ? { field: String(criterion.field).slice(0, 120) } : {}),
        required: criterion.required !== false,
      }];
    }).slice(0, 40) as CapabilityAcceptanceSpec["criteria"]
    : [];
  if (!criteria.length) {
    for (const field of input.outputSchema.required || []) criteria.push({
      id: `output:${field}`,
      label: `输出字段 ${field}`,
      kind: "output",
      operator: "exists",
      field,
      required: true,
    });
  }
  if (!criteria.length && input.resultKind === "page") criteria.push({
    id: "page:end-url",
    label: "最终页面地址",
    kind: "url",
    operator: "exists",
    field: "endUrl",
    required: true,
  });
  const proposedCheckpoints = proposed?.sideEffectPolicy?.requiredCheckpoints || [];
  const requiredCheckpoints = [...new Set(proposedCheckpoints.filter((item) =>
    item === "login" || item === "captcha" || item === "payment" || item === "confirmation"))];
  if (input.operation === "write" && !requiredCheckpoints.includes("confirmation")) requiredCheckpoints.push("confirmation");
  return {
    version: 1,
    criteria,
    requiredEvidence: ["before-screenshot", "after-screenshot", "validation-video"],
    sideEffectPolicy: {
      mode: proposed?.sideEffectPolicy?.mode === "reversible" || proposed?.sideEffectPolicy?.mode === "irreversible"
        ? proposed.sideEffectPolicy.mode
        : input.operation === "read" ? "read-only" : "irreversible",
      requiredCheckpoints,
      requireIdempotencyKey: input.operation === "write",
    },
  };
}

function containsChinese(value: string | undefined) {
  return Boolean(value && /\p{Script=Han}/u.test(value));
}

function validEnglishName(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && !containsChinese(normalized) && /[A-Za-z]/.test(normalized) ? normalized : undefined;
}

function englishName(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .slice(0, 120);
}

function capabilityDraft(
  proposal: CapabilityProposal,
  model: ModelAnalysis | undefined,
): NonNullable<CapabilityProposalAnalysis["capability"]> {
  const kind = model?.capability?.kind === "navigation" ? "navigation" : "task";
  const operation = model?.capability?.operation || (kind === "navigation" ? "read" : "write");
  const resultKind = model?.capability?.resultKind || (kind === "navigation" ? "page" : "data");
  const intentKey = stableKey(model?.capability?.intentKey || "", proposal.requestedGoal);
  const modelName = model?.capability?.name?.trim();
  const modelChineseName = model?.capability?.localizedNames?.zhCN?.trim();
  const zhCN = (containsChinese(modelChineseName) ? modelChineseName!.slice(0, 120) : undefined)
    || [proposal.title, proposal.requestedGoal, proposal.description].find(containsChinese)?.trim().slice(0, 120)
    || "未命名能力";
  const en = validEnglishName(model?.capability?.localizedNames?.en)?.slice(0, 120)
    || validEnglishName(modelName)?.slice(0, 120)
    || englishName(intentKey);
  const inputSchema = objectSchema(model?.capability?.inputSchema, inputSchemaFrom(proposal.input));
  const outputSchema = objectSchema(model?.capability?.outputSchema, {
    type: "object",
    properties: resultKind === "page"
      ? { pageUrl: { type: "string", description: "最终页面地址" } }
      : { result: { type: "object", description: "能力执行产生的业务结果" } },
    required: resultKind === "page" ? ["pageUrl"] : ["result"],
  });
  const acceptanceSpec = acceptanceSpecFrom(model?.capability?.acceptanceSpec, { operation, resultKind, outputSchema });
  const requiresAuthentication = authenticationRequired(proposal.requestedGoal, model);
  const proposedRequirements = model?.capability?.executionRequirements;
  return {
    stableKey: intentKey,
    intentKey,
    name: en,
    localizedNames: { zhCN, en },
    description: model?.capability?.description?.trim().slice(0, 1_000) || proposal.description || proposal.requestedGoal,
    goalTemplate: model?.capability?.goalTemplate?.trim().slice(0, 500) || proposal.requestedGoal,
    kind,
    structure: "atomic",
    operation,
    exposure: "public",
    resultKind,
    inputSchema,
    outputSchema,
    acceptanceSpec,
    executionRequirements: {
      authentication: proposedRequirements?.authentication || (requiresAuthentication ? "required" : "unknown"),
      supportedEnvironments: {
        connectedBrowser: proposedRequirements?.supportedEnvironments?.connectedBrowser || "unverified",
        cloudBrowser: proposedRequirements?.supportedEnvironments?.cloudBrowser || "unverified",
        managedProfile: proposedRequirements?.supportedEnvironments?.managedProfile || "blocked",
      },
      checkpoints: proposedRequirements?.checkpoints || [],
      evidenceRefs: proposal.sourceEpisodeId ? [proposal.sourceEpisodeId] : [],
    },
  };
}

function validCapabilityId(id: string | undefined, capabilities: Capability[]) {
  return id && capabilities.some((capability) => capability.id === id && capability.status !== "deleted") ? id : undefined;
}

export async function analyzeCapabilityProposal(input: {
  proposal: CapabilityProposal;
  capabilities: Capability[];
  activeRelease?: SiteAgentReleaseV2;
  runtimeEvidence?: JsonValue;
  telemetry?: { record(invocation: ModelInvocation): void | Promise<void> };
}): Promise<CapabilityProposalAnalysis> {
  const { proposal, capabilities, activeRelease, runtimeEvidence, telemetry } = input;
  const exact = exactDuplicate(proposal, capabilities);
  const requestedImprovement = improvementRequested(proposal);
  if (exact && !requestedImprovement) {
    return {
      disposition: "duplicate",
      summary: `与现有能力“${exact.name}”的稳定目标完全相同。`,
      confidence: 1,
      duplicateCapabilityId: exact.id,
      evidence: ["stable-goal-exact-match"],
      modelUsed: false,
      feasibility: {
        status: "feasible",
        summary: "已有能力可以直接复用，无需分配新的构建资源。",
        blockers: [],
        requiredResources: [],
        plan: [{ step: "reuse", objective: "复用已有能力，不创建新的构建任务。" }],
      },
    };
  }

  const model = await modelJson<ModelAnalysis>(
    "You analyze Capability Center proposals on the server. Decide whether the request is an exact duplicate, a genuine improvement/repair of an existing capability, a new reusable capability, or should be rejected. Before allocating a Task, return a feasibility assessment and an ordered implementation plan. Mark feasibility.status=blocked when required authentication, permissions, test data, browser state, external access, payment, CAPTCHA, or another prerequisite is unavailable or unproven. A blocked proposal must not consume Runner resources unless an administrator explicitly overrides it. Duplicate means no implementation Task. Improvement/repair means a new version of the referenced existing capability. Return a complete stable input/output contract and implementation-independent acceptanceSpec for new capabilities. acceptanceSpec criteria must name observable URL/text/output/checkpoint/side-effect facts. Mark irreversible writes, require confirmation/payment checkpoints where appropriate, and require idempotency for externally visible writes. Every new capability must include localizedNames.zhCN as a concise Chinese display name and localizedNames.en as a concise English display name. Keep machine identifiers in intentKey/stableKey, not in the display names. Never invent an existing capability id.",
    {
      proposal: {
        kind: proposal.kind,
        title: proposal.title,
        description: proposal.description,
        requestedGoal: proposal.requestedGoal,
        input: proposal.input,
        requestedCapabilityId: proposal.capabilityId,
      },
      existingCapabilities: capabilities.filter((item) => item.status !== "deleted").map((item) => ({
        id: item.id,
        status: item.status,
        intentKey: item.intentKey,
        name: item.name,
        localizedNames: item.localizedNames,
        description: item.description,
        goalTemplate: item.goalTemplate,
        inputSchema: item.inputSchema,
        outputSchema: item.outputSchema,
        acceptanceSpec: item.acceptanceSpec,
      })),
      site: activeRelease ? { name: activeRelease.profile.name, description: activeRelease.profile.description, entryUrl: activeRelease.profile.entryUrl } : undefined,
      runtimeEvidence,
      responseSchema: {
        disposition: "duplicate | new | improvement | repair | rejected",
        summary: "short administrator-facing reason",
        confidence: "0..1",
        duplicateCapabilityId: "required only for duplicate",
        targetCapabilityId: "required only for improvement or repair",
        capability: "required only for new; stable contract with localizedNames, inputSchema/outputSchema, executionRequirements and acceptanceSpec {version:1, criteria, requiredEvidence, sideEffectPolicy}",
        evidence: ["short verifiable factors"],
        feasibility: {
          status: "feasible | blocked",
          summary: "why the current resources can or cannot complete the work",
          blockers: ["missing prerequisite"],
          requiredResources: ["resource required before execution"],
          plan: [{ step: "stable step id", objective: "ordered action", resource: "optional resource" }],
        },
      },
    },
    180_000,
    telemetry ? { siteAgentId: proposal.siteAgentId, stage: "capability-design", record: telemetry.record } : undefined,
    "semantic",
    undefined,
    [],
    { failureMode: telemetry ? "throw" : "soft" },
  );

  const explicitTarget = validCapabilityId(proposal.capabilityId, capabilities);
  const duplicateCapabilityId = validCapabilityId(model?.duplicateCapabilityId, capabilities);
  const targetCapabilityId = explicitTarget || validCapabilityId(model?.targetCapabilityId, capabilities) || (requestedImprovement ? exact?.id : undefined);
  let disposition: CapabilityProposalDisposition = model?.disposition || (targetCapabilityId ? proposal.kind === "repair" ? "repair" : "improvement" : "new");
  if (disposition === "duplicate" && !duplicateCapabilityId) disposition = targetCapabilityId ? "improvement" : "new";
  if ((disposition === "improvement" || disposition === "repair") && !targetCapabilityId) disposition = "new";

  return {
    disposition,
    summary: model?.summary?.trim().slice(0, 1_000) || (disposition === "new" ? "未发现相同稳定能力，将创建新的能力生成任务。" : "服务端已完成能力提案分析。"),
    confidence: Math.max(0, Math.min(1, Number(model?.confidence ?? (model ? 0.75 : 0.5)))),
    duplicateCapabilityId,
    targetCapabilityId,
    capability: disposition === "new" ? capabilityDraft(proposal, model) : undefined,
    evidence: (model?.evidence || [model ? "server-model-analysis" : "deterministic-fallback"]).map((item) => String(item).slice(0, 300)).slice(0, 8),
    modelUsed: Boolean(model),
    feasibility: feasibilityFor(proposal, model, runtimeEvidence),
  };
}

export function taskTypeForAnalysis(
  disposition: CapabilityProposalDisposition,
  proposalKind: CapabilityProposalKind,
): "generate" | "repair" {
  return disposition === "new" ? "generate" : disposition === "repair" || proposalKind === "repair" ? "repair" : "repair";
}
