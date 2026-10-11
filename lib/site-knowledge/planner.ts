import { sampleEntryBindings } from "./entry-verification";
import { knowledgeRevisionOf } from "./knowledge-model";
import { capabilityGoalConflicts } from "./capability-compatibility";
import {
  normalizeGoal,
  type CapabilityDefinition,
  type JsonSchema,
  type JsonValue,
  type OperationDefinition,
  type SceneDefinition,
  type SiteAgentReleaseV2,
} from "./protocol";

function tokens(value: string) {
  const normalized = normalizeGoal(value).replace(/^(请|帮我|我要|我想|打开|查看|进入|前往|去到)+/g, "").replace(/\s+/g, "");
  const pieces = new Set<string>();
  for (const word of normalizeGoal(value).split(/\s+/).filter(Boolean)) pieces.add(word);
  if (/\p{Script=Han}/u.test(normalized)) {
    for (const character of normalized) pieces.add(character);
    for (let index = 0; index < normalized.length - 1; index += 1) pieces.add(normalized.slice(index, index + 2));
  }
  return pieces;
}

/**
 * Single-character co-occurrence does not score.
 *
 * Chinese is tokenized as "each character + adjacent pairs", so "未成**年**" and
 * "**年**度热搜归档" score by sharing one character. Measured in production: asking
 * "未成年人能用吗" recommended the yearly archive, monthly digest and celebrity records —
 * each let in by a single "年", "年" or "人" — while the privacy policy literally
 * containing "未成年人保护" scored 0. **For short queries, single-character overlap is
 * all noise.**
 *
 * Require at least one shared fragment of length ≥2: Chinese needs two characters to
 * form a word, and space-split English words are already ≥2, so the rule is
 * language-independent, not a Chinese patch.
 */
function scorePhrases(goal: string, phrases: Array<string | undefined>) {
  const normalized = normalizeGoal(goal);
  const left = tokens(goal);
  return Math.max(0, ...phrases.filter((phrase): phrase is string => Boolean(phrase)).map((phrase) => {
    if (normalizeGoal(phrase) === normalized) return 1;
    const right = tokens(phrase);
    const common = [...left].filter((item) => right.has(item) && item.length > 1).length;
    return (2 * common) / Math.max(1, left.size + right.size);
  }));
}

export function scoreCapabilityGoal(goal: string, capability: CapabilityDefinition) {
  if (normalizeGoal(goal) === capability.normalizedGoal) return 1;
  if (capability.aliases.some((alias) => normalizeGoal(alias) === normalizeGoal(goal))) return 0.99;
  return scorePhrases(goal, [capability.name, capability.goalTemplate, capability.description, ...capability.aliases]);
}

export { capabilityGoalConflicts };

/** Tool schemas should describe valid input, not suggest values for the model
 * to invent. Examples remain in the Release for forms and authoring. */
export function runtimeToolSchema(schema: JsonSchema): JsonSchema {
  const rest = { ...schema };
  delete rest.examples;
  return {
    ...rest,
    ...(schema.properties ? { properties: Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, runtimeToolSchema(value)])) } : {}),
    ...(schema.items ? { items: runtimeToolSchema(schema.items) } : {}),
  };
}

export type AgentRoutingContext = {
  site: { name: string; description: string; jobs: string[] };
  tasks: Array<{ id: string; name: string; description: string; goalTemplate: string; requiredInputs: Array<{ id: string; name: string; type: string; prompt: string }>; score: number }>;
  scenes: Array<{ id: string; name: string; description?: string; parameters: Array<{ id: string; name: string; type: string; required: boolean }>; score: number }>;
  publicCapabilityCount: number;
  hasRelevantRoute: boolean;
};

export type KnowledgeMatch = {
  site: { name: string; description: string; jobs: string[] };
  currentSceneId?: string;
  tasks: Array<{ id: string; name: string; description: string; goalTemplate: string; requiredInputs: Array<{ id: string; name: string; type: string; prompt?: string }>; score: number }>;
  scenes: Array<{ id: string; name: string; description?: string; urlTemplate?: string; paths: string[]; parameters: Array<{ id: string; name: string; type: string; required: boolean }>; requiredParams: string[]; directEntry: SceneDefinition["directEntry"]; evidenceStatus?: SceneDefinition["evidenceStatus"]; readiness: number; current: boolean; score: number; /** 正文检索在这一页上逐字命中过——跳转排序里最强的证据。 */ contentHit?: boolean }>;
  operations: Array<{ id: string; name: string; description?: string; from: string; to: string; scope: string; status: OperationDefinition["status"]; score: number }>;
  capabilities: Array<{ id: string; name: string; description?: string; goalTemplate?: string; inputs: JsonSchema; outputs: JsonSchema; score: number }>;
  /** The KnowledgeRevision the scenes/links come from (advances only on material change). */
  knowledgeRevision: number;
  hasRoute: boolean;
};

const READINESS_RANK: Record<string, number> = { "entry-verified": 3, observed: 2, crawled: 1, referenced: 0 };
function sceneReadiness(scene: SceneDefinition): number {
  if (scene.directEntry === "verified") return 3;
  return READINESS_RANK[(scene.evidenceStatus || scene.lifecycle || "referenced") as string] ?? 0;
}

/**
 * The single authoritative knowledge search every consumer (main agent, adaptive
 * agent, capability designer) routes through. Accepts a keyword LIST (or a single
 * string) — synonym expansion is the caller's job — and scores each object as the MAX
 * over the keywords (OR semantics, not summed, so one high-frequency word never drowns
 * out broader coverage). Scenes carry their PATH templates + required params and are
 * RANKED by readiness (verified first) — but never *filtered* to verified-only, so the
 * agent is labeled-not-starved when nothing is verified yet. Deterministic; no model
 * call, no full-graph dump.
 */
export function searchKnowledgeIndex(
  release: SiteAgentReleaseV2,
  goal: string | string[],
  currentSceneId?: string,
  /**
   * URLs actually hit by body search. **The strongest evidence**: a verbatim hit in the
   * content store means the answer is on that page, so navigation should recommend it
   * first. It used to play no part in ranking — in production, asking "未成年人能用吗",
   * the privacy policy literally containing "未成年人保护" did not even make the list,
   * while the yearly archive, let in by a single "年", ranked first.
   */
  contentHitUrls: string[] = [],
): KnowledgeMatch {
  const hitUrls = new Set(contentHitUrls);
  const keywords = (Array.isArray(goal) ? goal : [goal]).map((keyword) => keyword.trim()).filter(Boolean);
  const scoreMax = (phrases: Array<string | undefined>) => Math.max(0, ...keywords.map((keyword) => scorePhrases(keyword, phrases)));
  const capabilityScoreMax = (capability: CapabilityDefinition) => Math.max(0, ...keywords.map((keyword) => scoreCapabilityGoal(keyword, capability)));
  const taskTemplates = release.profile.taskTemplates?.length
    ? release.profile.taskTemplates
    : release.profile.suggestedGoals.map((name, index) => ({ id: `legacy_task_${index}`, name, description: name, goalTemplate: name, requiredInputs: [], confidence: 0.5 }));
  const tasks = taskTemplates
    .map((task) => ({ task, score: scoreMax([task.name, task.description, task.goalTemplate]) }))
    .filter(({ score }) => score >= 0.12)
    .sort((left, right) => right.score - left.score).slice(0, 6)
    .map(({ task, score }) => ({ id: task.id, name: task.name, description: task.description, goalTemplate: task.goalTemplate, requiredInputs: task.requiredInputs, score }));
  const sceneNames = new Map(release.scenes.map((scene) => [scene.id, scene.name]));
  const scenes = release.scenes
    .map((scene) => ({ scene, score: scoreMax([scene.name, scene.description, scene.businessArea, ...scene.parameters.map((parameter) => parameter.name), ...scene.urlTemplates.map((template) => `${template.pathnamePattern} ${Object.keys(template.query).join(" ")}`)]) }))
    .filter(({ scene, score }) => score > 0 || scene.id === currentSceneId
      || (scene.evidence?.observedUrls || []).some((url) => hitUrls.has(url)))
    .map(({ scene, score }) => {
      const template = scene.urlTemplates[0];
      const query = template?.query && Object.keys(template.query).length ? `?${Object.entries(template.query).map(([key, value]) => `${key}=${value}`).join("&")}` : "";
      const contentHit = (scene.evidence?.observedUrls || []).some((url) => hitUrls.has(url));
      return {
      id: scene.id, name: scene.name, description: scene.description, contentHit,
      urlTemplate: template ? `${template.pathnamePattern}${query}` : undefined,
      paths: scene.urlTemplates.map((item) => item.pathnamePattern),
      parameters: scene.parameters.map(({ id, name, type, required }) => ({ id, name, type, required })),
      requiredParams: scene.parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name),
      directEntry: scene.directEntry, evidenceStatus: scene.evidenceStatus,
      readiness: sceneReadiness(scene), current: scene.id === currentSceneId, score,
      };
    })
    // Sort by evidence strength: current page → body hit → match score → readiness.
    // Readiness used to come before score, so a 0.022 page beat a 0.083 one — the score
    // barely mattered.
    .sort((left, right) => Number(right.current) - Number(left.current)
      || Number(right.contentHit) - Number(left.contentHit)
      || right.score - left.score
      || right.readiness - left.readiness)
    .slice(0, 8);
  const operations = release.operations
    .map((operation) => ({ operation, score: scoreMax([operation.name, operation.description, sceneNames.get(operation.fromSceneId), operation.toSceneId ? sceneNames.get(operation.toSceneId) : undefined]) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score).slice(0, 10)
    .map(({ operation, score }) => ({ id: operation.id, name: operation.name, description: operation.description, from: sceneNames.get(operation.fromSceneId) || "任意页面", to: operation.toSceneId ? sceneNames.get(operation.toSceneId) || "目标页面" : "当前页面", scope: operation.applicability?.scope || (operation.fromSceneId === "*" ? "any-scene" : "scene-set"), status: operation.status, score }));
  const publicCapabilities = release.capabilities.filter((item) => (item.status === "available" || item.status === "improving") && item.exposure !== "internal" && item.kind !== "navigation");
  const capabilities = publicCapabilities
    .map((capability) => ({ capability, score: capabilityScoreMax(capability) }))
    .filter(({ score }) => score >= 0.12)
    .sort((left, right) => right.score - left.score).slice(0, 8)
    .map(({ capability, score }) => ({ id: capability.id, name: capability.name, description: capability.description, goalTemplate: capability.goalTemplate, inputs: capability.inputs, outputs: capability.outputs, score }));
  return {
    site: { name: release.profile.name, description: release.profile.description, jobs: (release.profile.jobsToBeDone || release.profile.suggestedGoals).slice(0, 8) },
    currentSceneId, tasks, scenes, operations, capabilities,
    knowledgeRevision: knowledgeRevisionOf(release),
    hasRoute: Boolean(tasks.length || scenes.some((scene) => scene.score > 0) || capabilities.length),
  };
}

/** A compact, local routing projection, now a thin projection of the single
 * `searchKnowledgeIndex` (folding the old verified-only body into it). */
export function buildAgentRoutingContext(release: SiteAgentReleaseV2, goal: string): AgentRoutingContext {
  const index = searchKnowledgeIndex(release, goal);
  return {
    site: index.site,
    tasks: index.tasks.map((task) => ({ id: task.id, name: task.name, description: task.description, goalTemplate: task.goalTemplate, requiredInputs: task.requiredInputs.map((input) => ({ id: input.id, name: input.name, type: input.type, prompt: input.prompt || "" })), score: task.score })),
    // Readiness-ranked, not verified-filtered (the old body's starvation bug).
    scenes: index.scenes.map((scene) => ({ id: scene.id, name: scene.name, description: scene.description, parameters: scene.parameters, score: scene.score })),
    publicCapabilityCount: release.capabilities.filter((item) => (item.status === "available" || item.status === "improving") && item.exposure !== "internal" && item.kind !== "navigation").length,
    hasRelevantRoute: index.hasRoute,
  };
}

/**
 * The three honest coverage tiers, weakest→strongest: a page was `discovered`
 * (it exists in the knowledge base at all), `semantically-reviewed` (a human/AI
 * understood what it is), and `entry-verified` (a real run reached it as a direct
 * entry) — the terminal rung of website knowledge. Whether a task capability routes
 * through a page belongs to the capability center, not the knowledge base, so it is
 * deliberately NOT a rung here. Each higher tier ⊆ the one below.
 */
export type ReadinessTier = "discovered" | "semantically-reviewed" | "entry-verified";

export type ScenePromotion = {
  sceneId: string;
  name: string;
  /** The highest tier this scene has reached. */
  tier: ReadinessTier;
  /** The next rung it has NOT reached (undefined once entry-verified — the terminal rung). */
  nextTier?: ReadinessTier;
  /** Machine code for why it stalled short of `nextTier`. */
  reasonCode?: string;
  /** Human-readable "why not promoted" detail (the failing assertion, the missing param, …). */
  detail?: string;
};

export type KnowledgeReadiness = {
  discovered: number;
  semanticReviewed: number;
  entryVerified: number;
  scenes: ScenePromotion[];
};

function sceneIsReviewed(scene: SceneDefinition): boolean {
  return scene.semanticSource === "ai" || scene.semanticSource === "human" || scene.semanticReview?.status === "reviewed";
}

/** Why a discovered scene has not reached semantic review yet. */
function reviewBlocker(scene: SceneDefinition): { reasonCode: string; detail: string } {
  if (scene.semanticReview?.status === "pending") return { reasonCode: "review-queued", detail: "已排队等待 AI 审阅" };
  if (scene.semanticReview?.status === "failed") return { reasonCode: "review-failed", detail: "AI 审阅失败，待重试" };
  if ((scene.evidenceStatus || "referenced") === "referenced" && !scene.evidence?.observedUrls?.length) return { reasonCode: "not-visited", detail: "仅作为链接被发现，尚未真实访问" };
  if (scene.evidenceStatus === "crawled") return { reasonCode: "crawled-only", detail: "已爬取，等待真实使用后审阅" };
  return { reasonCode: "awaiting-review", detail: "等待 AI 审阅" };
}

/** Why a reviewed scene has not reached entry-verified yet (mirrors the verifier's own failure codes). */
function entryBlocker(scene: SceneDefinition): { reasonCode: string; detail: string } {
  if (scene.directEntry === "failed") return { reasonCode: "entry-failed", detail: scene.verificationFailure ? `多次进入失败：${scene.verificationFailure}` : "多次进入失败" };
  if (scene.directEntry === "needs-reverify") return { reasonCode: "entry-demoted", detail: [scene.verificationFailure, scene.demotedAt].filter(Boolean).join(" · ") || "曾验证通过，站点变化后待复验" };
  if (!scene.urlTemplates[0]) return { reasonCode: "no-url-template", detail: "缺少可构造的直达 URL 模板" };
  if (sampleEntryBindings(scene) === undefined) return { reasonCode: "missing-param-example", detail: "必填参数缺少示例值，无法构造直达 URL 进行验证" };
  if (scene.verificationFailure) return { reasonCode: "verification-failed", detail: scene.verificationFailure };
  return { reasonCode: "not-probed", detail: "等待真实进入验证" };
}

/**
 * The four honest numbers + per-scene "why not promoted", as ONE pure funnel so
 * the console and any loop-health metric share a single definition. Cumulative:
 * discovered ≥ semanticReviewed ≥ entryVerified. Reaching a higher rung implies the
 * ones below it (a verified entry counts toward reviewed too). `entry-verified` (reachable)
 * is the terminal rung — task capability is the capability center's concern, so this
 * funnel never reaches into the execution graph. Deterministic; no model call, no IO.
 */
export function computeKnowledgeReadiness(release: SiteAgentReleaseV2): KnowledgeReadiness {
  let semanticReviewed = 0;
  let entryVerified = 0;
  const scenes = release.scenes.map((scene): ScenePromotion => {
    const verified = scene.directEntry === "verified";
    // A scene that has left the `candidate` rung — verified, or verified-then-demoted
    // to needs-reverify/failed — has been through entry probing, which the pipeline
    // only triggers after semantic review. So it counts as reviewed and its blocker is
    // an ENTRY blocker ("repeated entry failures"), not "waiting for AI review"; this also keeps the
    // reviewed tally stable across a demotion (the scene's semantics did not change).
    const reviewed = sceneIsReviewed(scene) || scene.directEntry !== "candidate";
    if (reviewed) semanticReviewed += 1;
    if (verified) entryVerified += 1;
    // Verified = accessible = the terminal rung of website knowledge (no nextTier).
    if (verified) return { sceneId: scene.id, name: scene.name, tier: "entry-verified" };
    if (reviewed) return { sceneId: scene.id, name: scene.name, tier: "semantically-reviewed", nextTier: "entry-verified", ...entryBlocker(scene) };
    return { sceneId: scene.id, name: scene.name, tier: "discovered", nextTier: "semantically-reviewed", ...reviewBlocker(scene) };
  });
  return { discovered: release.scenes.length, semanticReviewed, entryVerified, scenes };
}

/**
 * Return a deliberately small semantic-recall set for the Agent's one model
 * routing turn. Exact lexical matching remains the cheap fast path, but a
 * user normally says an entity ("周杰伦") rather than the catalog's parameter
 * name ("keyword"). In that case the router needs to see the few nearby
 * capability signatures before it can bind the entity to the typed input.
 */
export function recallCapabilities(release: SiteAgentReleaseV2, goal: string, limit = 4) {
  const available = release.capabilities.filter((item) => (item.status === "available" || item.status === "improving") && item.exposure !== "internal");
  const ranked = available.map((capability) => ({ capability, score: scoreCapabilityGoal(goal, capability) })).sort((left, right) => right.score - left.score);
  const overlapping = ranked.filter((item) => item.score >= 0.12).slice(0, limit);
  // Small sites commonly have only a handful of public tools. If wording has
  // no literal overlap, expose that bounded catalog to the semantic router
  // instead of needlessly loading the exploratory page Agent.
  return overlapping.length ? overlapping : ranked.slice(0, Math.min(limit, 6));
}

/** Ranked public tool catalog for the conversational Agent. Unlike
 * recallCapabilities this never drops low-overlap tools: the model gets a
 * bounded default toolbox and can search the rest explicitly. */
export function rankPublishedCapabilities(release: SiteAgentReleaseV2, goal: string, limit = 20) {
  return release.capabilities
    .filter((item) => (item.status === "available" || item.status === "improving") && item.exposure !== "internal")
    .map((capability) => ({ capability, score: scoreCapabilityGoal(goal, capability) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

/**
 * Deterministic reuse is deliberately stricter than semantic recall. It is
 * safe to bypass the model only when one public capability explicitly owns
 * the user's normalized wording through its name, goal or an alias.
 */
export function exactCapabilityForGoal(release: SiteAgentReleaseV2, goal: string) {
  const normalized = normalizeGoal(goal);
  if (!normalized) return undefined;
  const matches = release.capabilities.filter((capability) => {
    if (!["available", "improving"].includes(capability.status) || capability.exposure === "internal") return false;
    return [
      capability.normalizedGoal,
      capability.name,
      capability.goalTemplate,
      ...(Array.isArray(capability.aliases) ? capability.aliases : []),
    ].some((phrase) => typeof phrase === "string" && normalizeGoal(phrase) === normalized);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export function matchCapability(release: SiteAgentReleaseV2, goal: string) {
  return recallCapabilities(release, goal, Number.MAX_SAFE_INTEGER)
    .filter((item) => item.score >= 0.45)
    .sort((left, right) => right.score - left.score)[0];
}

export function choosePlan(capability: CapabilityDefinition, operations: OperationDefinition[], currentSceneId?: string) {
  const plans = capability.plans.map((plan) => {
    if (!currentSceneId) return { plan, startIndex: 0, score: 0 };
    const startIndex = plan.steps.findIndex((step) => {
      const operation = operations.find((item) => item.id === step.operationId);
      const applicability = operation?.applicability;
      if (applicability?.scope === "any-scene") return true;
      if (applicability?.scope === "scene-set") return applicability.sceneIds?.includes(currentSceneId) || false;
      return operation?.fromSceneId === currentSceneId || operation?.fromSceneId === "*";
    });
    return {
      plan,
      startIndex: startIndex >= 0 ? startIndex : 0,
      score: startIndex >= 0 ? 3 : plan.entrySceneIds.includes(currentSceneId) ? 2 : 0,
    };
  });
  return plans.sort((left, right) => right.score - left.score)[0];
}

export function valueAt(path: string, sources: { input: Record<string, JsonValue>; state: Record<string, JsonValue>; step: Record<string, JsonValue> }) {
  const [root, ...parts] = path.split(".");
  let value: JsonValue | undefined = root === "input" ? sources.input : root === "state" ? sources.state : sources.step;
  for (const part of parts) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = value[part];
  }
  return value;
}
