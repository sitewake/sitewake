import { knowledgeRevisionOf } from "./knowledge-model";
import {
  normalizeGoal,
  stableHash,
  type CapabilityDefinition,
  type JsonSchema,
  type NavigationTool,
  type OperationDefinition,
  type SceneDefinition,
  type SiteAgentReleaseV2,
} from "./protocol";

const BUSINESS_RESULT_WORDS = /(搜索|查询|查找|结果|列表|榜单内容|总结|分析|对比|提取|导出|创建|提交|保存|删除|修改|购买|下单|订阅|收藏|记录有哪些|返回数据)/i;
const NAVIGATION_PREFIX = /^(请|帮我|我要|我想|带我|麻烦)?\s*(打开|进入|前往|去到|跳转到|返回|回到|浏览)/i;
const VIEW_NAVIGATION_PREFIX = /^(请|帮我|我要|我想|带我|麻烦)?\s*(查看|看看|看一下)/i;
const NAVIGATION_WITH_BUSINESS_RESULT = /(并|然后|之后|以后|并且|再).*(搜索|查询|查找|总结|分析|对比|提取|导出|创建|提交|保存|删除|修改|购买|下单|订阅|收藏|返回数据)/i;
// "查看关于我们/服务条款" is still a page-arrival request.  Keep obvious
// data/entity lookups out of this compatibility classifier so "查看商品价格"
// can continue to use a business capability or PageAgent.
const VIEW_BUSINESS_ENTITY = /(商品|产品|订单|购物车|数量|价格|库存|搜索|查询|查找|筛选|排序|结果|列表|榜单|统计|数据)/i;
const CONVERSATION_ONLY = /^(你好|您好|hi|hello|嗨|谢谢|感谢|你是谁|你能做什么|这个网站(是)?做什么的)[！!。.？?\s]*$/i;

export type GoalClass = "conversation" | "navigation" | "business" | "unknown";

export function classifyGoal(goal: string): GoalClass {
  const value = goal.normalize("NFKC").trim();
  if (!value || CONVERSATION_ONLY.test(value)) return "conversation";
  if (NAVIGATION_PREFIX.test(value)) return NAVIGATION_WITH_BUSINESS_RESULT.test(value) ? "business" : "navigation";
  if (BUSINESS_RESULT_WORDS.test(value)) return "business";
  return "unknown";
}

export function isPureNavigationGoal(goal: string) {
  return classifyGoal(goal) === "navigation";
}

/**
 * Runtime-only navigation intent.  This is deliberately broader than
 * classifyGoal: a user often says "查看关于我们" rather than "打开关于我们".
 * It only identifies candidates for verified static-entry shortcuts. It must
 * not hide published capabilities or constrain the Agent's tool selection.
 * Dynamic destinations still require a contract or live page evidence.
 */
export function isNavigationIntentGoal(goal: string) {
  const value = goal.normalize("NFKC").trim();
  if (isPureNavigationGoal(value)) return true;
  return VIEW_NAVIGATION_PREFIX.test(value) && !VIEW_BUSINESS_ENTITY.test(value);
}
function schemaForScene(scene: SceneDefinition): JsonSchema {
  return {
    type: "object",
    properties: Object.fromEntries(scene.parameters.map((parameter) => [parameter.id, {
      type: parameter.type,
      description: parameter.name || parameter.id,
      ...(parameter.examples.length ? { examples: parameter.examples } : {}),
    }])),
    required: scene.parameters.filter((parameter) => parameter.required).map((parameter) => parameter.id),
  };
}

function outputSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      pageUrl: { type: "string", description: "到达页面 URL" },
      pageTitle: { type: "string", description: "到达页面标题" },
      sceneId: { type: "string", description: "到达页面类型" },
    },
    required: ["pageUrl", "pageTitle", "sceneId"],
  };
}

function directOperation(scene: SceneDefinition): OperationDefinition {
  const id = `operation_navigation_direct_${stableHash(scene.id)}`;
  const bindings = Object.fromEntries(scene.parameters.map((parameter) => [parameter.id, { source: "input" as const, path: parameter.id }]));
  return {
    id,
    name: `直达${scene.name}`,
    description: `使用网站已验证的 URL 模板进入“${scene.name}”`,
    kind: "navigation",
    evidenceSource: "compiled-task",
    applicability: { scope: "any-scene", evidenceSceneIds: scene.sourceObservationIds },
    fromSceneId: "*",
    toSceneId: scene.id,
    inputs: schemaForScene(scene),
    outputs: outputSchema(),
    preconditions: [],
    effects: [`scene:${scene.id}`],
    implementations: [{
      id: `implementation_navigation_direct_${stableHash(scene.id)}`,
      program: { version: 2, steps: [{ id: `step_navigation_direct_${stableHash(scene.id)}`, op: "navigate", sceneId: scene.id, bindings, timeoutMs: 10_000 }] },
      conditions: [], successes: 1, failures: 0, sourceEpisodeIds: [],
    }],
    verification: { sceneId: scene.id },
    status: "verified",
    updatedAt: scene.updatedAt,
  };
}

function operationRuntimeSemantics(operation: OperationDefinition) {
  return {
    id: operation.id,
    kind: operation.kind,
    applicability: operation.applicability,
    fromSceneId: operation.fromSceneId,
    toSceneId: operation.toSceneId,
    inputs: operation.inputs,
    outputs: operation.outputs,
    preconditions: operation.preconditions,
    effects: operation.effects,
    implementations: operation.implementations
      .map((implementation) => ({
        id: implementation.id,
        program: implementation.program,
        conditions: implementation.conditions,
        ...(implementation.authored?.kind === "page-program"
          ? {
              authored: {
                kind: implementation.authored.kind,
                program: implementation.authored.program,
              },
            }
          : implementation.authored?.kind === "module"
            ? {
                authored: {
                  kind: implementation.authored.kind,
                  module: implementation.authored.module,
                },
              }
            : {}),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    verification: operation.verification,
    status: operation.status,
  };
}

function navigationDependencyHash(
  release: SiteAgentReleaseV2,
  targetScene: SceneDefinition,
  strategies: NavigationTool["strategies"],
  operations: OperationDefinition[],
) {
  const targetIds = new Set<string>();
  const sceneIds = new Set<string>([targetScene.id]);
  const outcomeIds = new Set<string>();
  const recordProgram = (program: OperationDefinition["implementations"][number]["program"]) => {
    for (const step of program.steps) {
      if ("targetId" in step && step.targetId) targetIds.add(step.targetId);
      if ("sceneId" in step && step.sceneId) sceneIds.add(step.sceneId);
      if (step.op === "assertOutcome") outcomeIds.add(step.outcomeId);
      for (const expectedSceneId of (
        "transition" in step ? step.transition?.expectedSceneIds : undefined
      ) || []) {
        sceneIds.add(expectedSceneId);
      }
    }
  };
  for (const operation of operations) {
    if (operation.fromSceneId !== "*") sceneIds.add(operation.fromSceneId);
    if (operation.toSceneId) sceneIds.add(operation.toSceneId);
    for (const sceneId of operation.applicability?.sceneIds || []) sceneIds.add(sceneId);
    for (const sceneId of operation.applicability?.evidenceSceneIds || []) sceneIds.add(sceneId);
    if (operation.verification.sceneId) sceneIds.add(operation.verification.sceneId);
    for (const targetId of operation.verification.targetIds || []) targetIds.add(targetId);
    for (const outcomeId of operation.verification.outcomeIds || []) outcomeIds.add(outcomeId);
    for (const implementation of operation.implementations) {
      recordProgram(implementation.program);
      if (implementation.authored?.kind === "page-program") {
        recordProgram(implementation.authored.program);
      }
    }
  }
  // A locator may be scoped by another target. Include that chain so changing
  // a parent selector also invalidates the NavigationTool dependency pin.
  let targetSetExpanded = true;
  while (targetSetExpanded) {
    targetSetExpanded = false;
    for (const target of release.targets) {
      if (!targetIds.has(target.id)
        || !target.contextTargetId
        || targetIds.has(target.contextTargetId)) continue;
      targetIds.add(target.contextTargetId);
      targetSetExpanded = true;
    }
  }
  const scenes = release.scenes
    .filter((scene) => sceneIds.has(scene.id))
    .map((scene) => ({
      id: scene.id,
      name: scene.name,
      evidenceStatus: scene.evidenceStatus,
      lifecycle: scene.lifecycle,
      urlTemplates: scene.urlTemplates,
      parameters: scene.parameters,
      verifier: scene.verifier,
      directEntry: scene.directEntry,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const targets = release.targets
    .filter((target) => targetIds.has(target.id))
    .map((target) => ({
      id: target.id,
      name: target.name,
      sensitive: target.sensitive,
      purpose: target.purpose,
      sceneIds: target.sceneIds,
      role: target.role,
      accessibleNames: target.accessibleNames,
      attributes: target.attributes,
      hrefTemplateId: target.hrefTemplateId,
      contextTargetId: target.contextTargetId,
      locatorVariants: target.locatorVariants,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const outcomes = release.outcomes
    .filter((outcome) => outcomeIds.has(outcome.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  return stableHash(JSON.stringify({
    strategies,
    operations: operations
      .map(operationRuntimeSemantics)
      .sort((left, right) => left.id.localeCompare(right.id)),
    scenes,
    targets,
    outcomes,
  }));
}

export function isTechnicalCapabilityAdapterId(id: string) {
  return id.startsWith("navigation-tool:") || id.startsWith("capability_shared_nav_");
}

/**
 * Builds the legacy executable shape for one NavigationTool.
 *
 * This object is a runtime adapter, not a Capability identity. Callers may use
 * it in memory (or on the legacy runtime response boundary), but must never
 * persist it in a Release or in the canonical Capability catalog.
 */
export function transientNavigationToolCapability(tool: NavigationTool): CapabilityDefinition {
  const primary = tool.strategies[0];
  const outputBindings = Object.fromEntries(Object.keys(tool.outputs.properties || {}).map((key) => {
    if (key === "pageUrl") return [key, { source: "state" as const, path: "__pageUrl" }];
    if (key === "pageTitle") return [key, { source: "state" as const, path: "__pageTitle" }];
    if (key === "sceneId") return [key, { source: "literal" as const, value: tool.targetSceneId }];
    return [key, { source: "state" as const, path: key }];
  }));
  return {
    id: `navigation-tool:${tool.id}`,
    origin: "knowledge-compiled",
    kind: "navigation",
    resultKind: "page",
    exposure: "internal",
    name: tool.name,
    description: `${tool.description}。只负责到达页面，不代表已经获取页面业务数据。`,
    normalizedGoal: normalizeGoal(tool.name),
    goalTemplate: tool.name,
    aliases: tool.aliases,
    inputs: tool.inputs,
    outputs: tool.outputs,
    outcomes: [],
    plans: primary ? [{
      id: `plan_${stableHash(tool.id)}`,
      entrySceneIds: ["*"],
      steps: [{ operationId: primary.operationId, bindings: Object.fromEntries(Object.keys(tool.inputs.properties || {}).map((key) => [key, { source: "input", path: key }])) }],
      outputBindings,
    }] : [],
    sourceEpisodeIds: [], confidence: tool.status === "verified" ? 1 : 0.6,
    status: tool.status === "verified" ? "available" : "suggested",
    updatedAt: tool.updatedAt,
  };
}

/**
 * Compatibility projection for pre-canonical SDKs. The returned Release is a
 * new response-only object; callers must not write it back to persistence.
 */
export function withTransientNavigationToolCapabilities(release: SiteAgentReleaseV2): SiteAgentReleaseV2 {
  return {
    ...release,
    capabilities: [
      ...release.capabilities.filter((capability) => !isTechnicalCapabilityAdapterId(capability.id)),
      ...(release.navigationTools || []).map(transientNavigationToolCapability),
    ],
  };
}

export function compileNavigationTools(release: SiteAgentReleaseV2): SiteAgentReleaseV2 {
  const formalCapabilities = release.capabilities.filter((capability) => !isTechnicalCapabilityAdapterId(capability.id));
  const baseOperations = release.operations.filter((operation) => !operation.id.startsWith("operation_navigation_direct_"));
  const existingOperations = baseOperations.filter((operation) => operation.kind === "navigation" || operation.evidenceSource === "shared-navigation");
  const generatedOperations: OperationDefinition[] = [];
  const tools: NavigationTool[] = [];
  for (const scene of release.scenes) {
    if ((scene.evidenceStatus || scene.lifecycle) === "referenced") continue;
    const related = existingOperations.filter((operation) => operation.toSceneId === scene.id && operation.implementations.length);
    if (scene.directEntry === "verified" || scene.evidenceStatus === "entry-verified") generatedOperations.push(directOperation(scene));
    const allOperations = [...new Map([...generatedOperations.filter((operation) => operation.toSceneId === scene.id), ...related].map((operation) => [operation.id, operation])).values()];
    if (!allOperations.length) continue;
    const aliases = [...new Set([
      `打开${scene.name}`, `进入${scene.name}`, `前往${scene.name}`,
      ...(scene.evidence?.linkLabels || []).flatMap((label) => [`打开${label}`, `进入${label}`]),
      ...formalCapabilities.filter((capability) => capability.kind === "navigation" && capability.plans.some((plan) => plan.steps.some((step) => allOperations.some((operation) => operation.id === step.operationId)))).flatMap((capability) => [capability.name, ...capability.aliases]),
    ].filter(Boolean))].slice(0, 16);
    const direct = allOperations.filter((operation) => operation.id.startsWith("operation_navigation_direct_")).map((operation) => ({ kind: "direct-entry" as const, operationId: operation.id, urlTemplateId: scene.urlTemplates[0]?.id || "" }));
    const shared = allOperations.filter((operation) => operation.evidenceSource === "shared-navigation").map((operation) => ({ kind: "shared-component" as const, operationId: operation.id, evidenceSceneIds: operation.applicability?.evidenceSceneIds || [] }));
    const programs = allOperations.filter((operation) => !direct.some((item) => item.operationId === operation.id) && !shared.some((item) => item.operationId === operation.id)).map((operation) => ({ kind: "scene-program" as const, operationId: operation.id }));
    const strategies = [...direct, ...shared, ...programs];
    const dependencyHash = navigationDependencyHash(
      release,
      scene,
      strategies,
      allOperations,
    );
    const usedByCapabilityIds = formalCapabilities.filter((capability) => capability.plans.some((plan) => plan.steps.some((step) => strategies.some((strategy) => strategy.operationId === step.operationId)))).map((capability) => capability.id);
    tools.push({
      id: `navigation_${stableHash(scene.id)}`,
      siteAgentId: release.siteAgentId,
      intentKey: `navigate_to_${stableHash(scene.id)}`,
      name: `打开${scene.name}`,
      description: `到达“${scene.name}”页面`,
      aliases,
      targetSceneId: scene.id,
      inputs: schemaForScene(scene),
      outputs: outputSchema(),
      applicability: allOperations.find((operation) => operation.applicability)?.applicability || { scope: "scene-set", sceneIds: [], evidenceSceneIds: [] },
      strategies,
      verifier: { sceneId: scene.id },
      source: {
        kind: scene.semanticSource === "human" ? "human" : scene.semanticSource === "ai" ? "ai-reviewed" : "knowledge-compiled",
        knowledgeRevision: knowledgeRevisionOf(release),
        dependencyHash,
        evidenceRefs: scene.sourceObservationIds,
      },
      status: allOperations.some((operation) => operation.status === "verified" || operation.status === "published") ? "verified" : "candidate",
      usedByCapabilityIds,
      updatedAt: scene.updatedAt,
    });
  }
  const operationIds = new Set(baseOperations.map((operation) => operation.id));
  const operations = [...baseOperations, ...generatedOperations.filter((operation) => !operationIds.has(operation.id))];
  return { ...release, operations, navigationTools: tools, capabilities: formalCapabilities };
}
