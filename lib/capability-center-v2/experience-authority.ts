import type {
  AgentRun,
  JsonValue,
  PageAgentObservation,
  PageObservationRef,
  StableTargetRef,
  TaskEpisode,
} from "../site-knowledge/protocol";
import { capabilityHandoffForEpisode } from "./experience";
import { normalizeGoal } from "../site-knowledge/protocol";
import { executionCompletionCriteria, executionRequirementForGoal } from "../site-knowledge/execution-requirement";

export type CapabilityExperienceAuthority = {
  version: 1;
  kind: "create" | "strengthen" | "legacy-create";
  evidence: "page-observation-v1" | "authenticated-episode-v1";
  siteAgentId: string;
  runId: string;
  episodeId: string;
  observationRefs: PageObservationRef[];
  sourceCapabilityId?: string;
  sourceVersionId?: string;
};

// Synthetic keyboard events cannot establish a trusted material effect. They
// remain in the ordered execution trace so that a following changed submit or
// result observation can close the chain, but never count as success evidence
// on their own because the browser cannot prove isTrusted.
const MATERIAL_ACTIONS = new Set(["click", "set-text", "insert-text", "select", "submit"]);
const TARGETED_ACTIONS = new Set([...MATERIAL_ACTIONS, "press", "focus"]);
const POSSIBLE_SIDE_EFFECT_ACTIONS = new Set([...MATERIAL_ACTIONS, "press"]);
const RECEIPT_ACTIONS = new Set(["click", "set-text", "insert-text", "select", "submit", "press", "focus", "scroll", "wait"]);
const SENSITIVE_TARGET = /(?:password|passwd|passcode|one.?time|otp|credit.?card|debit.?card|payment.?card|card.?(?:number|no|security|expiry|expiration)|cc.?(?:number|num|csc|exp)|cvc|cvv|cvn)/iu;
const NO_RESULT_EVIDENCE = /(?:no\s+(?:search\s+)?(?:results?|products?|matches)|nothing\s+(?:was\s+)?(?:found|matched)|zero\s+(?:search\s+)?results?|没有(?:找到|搜索结果|匹配结果|相关商品)|未找到(?:相关)?(?:结果|商品)|搜索结果为\s*0)/iu;
const CART_EVIDENCE = /(?:cart|basket|shopping\s+bag|购物车|购物袋)/iu;
const QUERY_GOAL = /(?:search|find|filter|sort|搜索|查找|筛选|排序)/iu;
const CART_GOAL = /(?:add\b.*\bcart|加入(?:购物车|购物袋))/iu;
const QUERY_TARGET = /(?:search|find|filter|sort|query|搜索|查找|筛选|排序)/iu;
const POSITIVE_QUERY_COUNT = /(?:\b[1-9]\d*\b\s+(?:results?|matches|products?|items?)|(?:results?|matches|products?|items?)\s*[:：]\s*[1-9]\d*|there\s+(?:is|are)\s+[1-9]\d*\s+(?:results?|matches|products?|items?)|找到\s*[1-9]\d*\s*(?:个|件)?|搜索结果\s*[:：]\s*[1-9]\d*)/iu;
const QUERY_PENDING = /(?:searching|loading|please\s+wait|in\s+progress|正在(?:搜索|加载|查找)|请稍候)/iu;

function validReceiptShape(receipt: NonNullable<NonNullable<TaskEpisode["experience"]>["actionReceiptsV2"]>[number]) {
  return RECEIPT_ACTIONS.has(receipt.action)
    && ["changed", "unchanged", "unknown"].includes(receipt.effect)
    && typeof receipt.id === "string" && Boolean(receipt.id)
    && Number.isInteger(receipt.turnIndex) && receipt.turnIndex >= 0
    && typeof receipt.beforeObservationId === "string" && Boolean(receipt.beforeObservationId)
    && (receipt.afterObservationId === undefined || typeof receipt.afterObservationId === "string")
    && typeof receipt.dispatched === "boolean"
    && Boolean(receipt.input) && typeof receipt.input === "object" && !Array.isArray(receipt.input)
    && Boolean(receipt.effectSignals) && typeof receipt.effectSignals === "object" && !Array.isArray(receipt.effectSignals)
    && Number.isFinite(Date.parse(receipt.startedAt)) && Number.isFinite(Date.parse(receipt.endedAt));
}

function sameStableTarget(
  target: StableTargetRef,
  observed: PageAgentObservation["targets"][number],
) {
  return target.observationId === observed.observationId
    && target.index === observed.index
    && target.semanticId === observed.semanticId
    && target.role === observed.role
    && target.accessibleName === observed.accessibleName
    && target.controlType === observed.controlType
    && target.formSignature === observed.formSignature
    && target.hrefPath === observed.hrefPath
    && target.nearbyText === observed.nearbyText;
}

function sensitiveTarget(target: StableTargetRef | undefined) {
  return Boolean(target && SENSITIVE_TARGET.test([
    target.role,
    target.accessibleName,
    target.controlType,
    target.nearbyText,
  ].map(String).join(" ")));
}

/** Receipt effect is client-provided evidence, never authority on its own. */
function observedEffect(before: PageAgentObservation, after: PageAgentObservation) {
  const sameState = before.state.url === after.state.url
    && before.state.title === after.state.title
    && before.state.header === after.state.header
    && before.state.content === after.state.content
    && before.state.footer === after.state.footer;
  const beforeTargets = [...before.targets].sort((left, right) => left.index - right.index);
  const afterTargets = [...after.targets].sort((left, right) => left.index - right.index);
  const sameTargets = beforeTargets.length === afterTargets.length
    && beforeTargets.every((target, index) => {
      const next = afterTargets[index];
      return Boolean(next)
        && target.index === next.index
        && target.semanticId === next.semanticId
        && target.role === next.role
        && target.accessibleName === next.accessibleName
        && target.controlType === next.controlType
        && target.formSignature === next.formSignature
        && target.hrefPath === next.hrefPath
        && target.nearbyText === next.nearbyText;
    });
  return sameState && sameTargets ? "unchanged" as const : "changed" as const;
}

function unique<T>(values: T[]) {
  return new Set(values).size === values.length;
}

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}

function sameJson(left: Record<string, JsonValue>, right: Record<string, JsonValue>) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function serverRuntimeModelBudget(run: AgentRun) {
  const raw = run.agentState.runtimeModelBudget;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { requestCount: 0 };
  const value = raw as Record<string, JsonValue>;
  const count = value.requestCount;
  const stageCounts = value.stageCounts && typeof value.stageCounts === "object" && !Array.isArray(value.stageCounts)
    ? value.stageCounts as Record<string, JsonValue>
    : {};
  const stageFirst = value.stageFirstRequestedAt && typeof value.stageFirstRequestedAt === "object" && !Array.isArray(value.stageFirstRequestedAt)
    ? value.stageFirstRequestedAt as Record<string, JsonValue>
    : {};
  const stageLast = value.stageLastRequestedAt && typeof value.stageLastRequestedAt === "object" && !Array.isArray(value.stageLastRequestedAt)
    ? value.stageLastRequestedAt as Record<string, JsonValue>
    : {};
  const stageCount = (stage: string) => Number.isSafeInteger(stageCounts[stage]) && Number(stageCounts[stage]) >= 0
    ? Number(stageCounts[stage])
    : 0;
  const pageStageDates = (values: Record<string, JsonValue>) => ["runtime-page-agent", "runtime-boundary"]
    .map((stage) => typeof values[stage] === "string" ? Date.parse(values[stage]) : Number.NaN)
    .filter(Number.isFinite);
  const pageFirst = pageStageDates(stageFirst);
  const pageLast = pageStageDates(stageLast);
  return {
    requestCount: Number.isSafeInteger(count) && Number(count) >= 0 ? Number(count) : 0,
    pageExecutionRequestCount: stageCount("runtime-page-agent") + stageCount("runtime-boundary"),
    pageExecutionFirstRequestedAt: pageFirst.length ? new Date(Math.min(...pageFirst)).toISOString() : undefined,
    pageExecutionLastRequestedAt: pageLast.length ? new Date(Math.max(...pageLast)).toISOString() : undefined,
    firstRequestedAt: typeof value.firstRequestedAt === "string" ? value.firstRequestedAt : undefined,
    lastRequestedAt: typeof value.lastRequestedAt === "string" ? value.lastRequestedAt : undefined,
  };
}

function scalarValues(value: JsonValue, depth = 0): string[] {
  if (depth > 2 || value === null) return [];
  if (["string", "number", "boolean"].includes(typeof value)) {
    const normalized = normalizeGoal(String(value));
    return normalized ? [normalized] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => scalarValues(item, depth + 1));
  return Object.values(value).flatMap((item) => scalarValues(item, depth + 1));
}

function targetCorpus(target?: StableTargetRef) {
  return normalizeGoal([
    target?.role,
    target?.accessibleName,
    target?.controlType,
    target?.hrefPath,
    target?.nearbyText,
  ].filter(Boolean).join("\n"));
}

function observationCorpus(observation: PageAgentObservation) {
  return normalizeGoal([
    observation.state.url,
    observation.state.title,
    observation.state.header,
    observation.state.content,
    observation.state.footer,
    ...observation.targets.map(targetCorpus),
  ].join("\n"));
}

/** Site-wide footer counters and newsletter text cannot prove a query result. */
function resultCorpus(observation: PageAgentObservation) {
  return normalizeGoal([
    observation.state.url,
    observation.state.title,
    observation.state.header,
    observation.state.content,
    ...observation.targets.map(targetCorpus),
  ].join("\n"));
}

function queryCompletionProven(
  episode: TaskEpisode,
  terminal: PageAgentObservation,
  initial: PageAgentObservation,
  changedMaterial: NonNullable<NonNullable<TaskEpisode["experience"]>["actionReceiptsV2"]>,
  entities: Map<string, string[]>,
) {
  const terminalText = resultCorpus(terminal);
  if (QUERY_PENDING.test(terminalText)) return false;
  const values = [...entities.values()].flat();
  if (!values.length) return false;
  const initialText = resultCorpus(initial);
  const entityBindingAction = changedMaterial.find((receipt) => {
    const corpus = targetCorpus(receipt.target);
    const actionValues = Object.values(receipt.input).flatMap((value) => scalarValues(value));
    return values.every((value) => corpus.includes(value) || actionValues.includes(value));
  });
  if (!entityBindingAction) return false;
  const terminalizingAction = [...changedMaterial].reverse().find((receipt) =>
    ["click", "submit", "select"].includes(receipt.action));
  if (!terminalizingAction) return false;
  const actionText = targetCorpus(terminalizingAction.target);
  if (!QUERY_TARGET.test(actionText)) return false;
  const explicitNoResult = NO_RESULT_EVIDENCE.test(terminalText) && !NO_RESULT_EVIDENCE.test(initialText);
  const newPositiveCount = POSITIVE_QUERY_COUNT.test(terminalText) && !POSITIVE_QUERY_COUNT.test(initialText);
  if (episode.outcome.status === "no-result") {
    // A genuine empty-state page does not always echo the query. The entity is
    // bound by the earlier set-text/select receipt and the later explicit
    // Search action must make a new empty state observable.
    return explicitNoResult;
  }
  if (values.some((value) => !terminalText.includes(value))) return false;
  if (NO_RESULT_EVIDENCE.test(terminalText)) return false;
  if (newPositiveCount) return true;
  return terminal.targets.some((target) => {
    const corpus = targetCorpus(target);
    if (QUERY_TARGET.test(corpus) || /(?:textbox|searchbox|input)/iu.test(String(target.controlType || target.role || ""))) return false;
    if (!values.every((value) => corpus.includes(value))) return false;
    return !initial.targets.some((before) => before.semanticId === target.semanticId
      || targetCorpus(before) === corpus);
  });
}

function samePage(snapshot: TaskEpisode["startSnapshot"], observation: PageAgentObservation) {
  try {
    const snapshotUrl = new URL(snapshot.url);
    const observationUrl = new URL(observation.state.url);
    return snapshot.documentId === observation.documentId
      && snapshotUrl.origin === observationUrl.origin
      && snapshotUrl.pathname === observationUrl.pathname
      && snapshotUrl.search === observationUrl.search
      && normalizeGoal(snapshot.title) === normalizeGoal(observation.state.title);
  } catch { return false; }
}

function expectedRepairSource(run: AgentRun) {
  const stateValue = run.agentState.compiledRepairSourceCapabilityId;
  return typeof stateValue === "string" && stateValue ? stateValue : undefined;
}

function expectedRepairVersion(run: AgentRun) {
  const stateValue = run.agentState.compiledRepairSourceVersionId;
  return typeof stateValue === "string" && stateValue ? stateValue : undefined;
}

/**
 * A human success choice is a hand-off signal, not proof that the operation
 * is trustworthy.  It may relax semantic completion checks so the later
 * capability-generation/validation pipeline can inspect the raw experience,
 * but it never relaxes the authenticated observation and receipt chain.
 * Irreversible writes remain outside this automatic hand-off and require the
 * existing explicit/admin path.
 * Reconciliation/confirmed-continuation Episodes are excluded because they
 * are follow-up control-flow checks, not new user experiences.
 */
export function humanConfirmedSuccessAdmission(
  episode: TaskEpisode,
  requirement: ReturnType<typeof executionRequirementForGoal>,
) {
  const evidence = episode.outcome.evidence;
  if (episode.mode !== "adaptive" || episode.outcome.status !== "success" || requirement.kind !== "required"
    || requirement.effect === "irreversible-write"
    || !evidence || typeof evidence !== "object" || Array.isArray(evidence)
    || evidence.executionIntent !== undefined) return false;
  const confirmation = evidence.humanConfirmation;
  return Boolean(confirmation && typeof confirmation === "object" && !Array.isArray(confirmation)
    && (confirmation as Record<string, JsonValue>).answer === "success");
}

function trustedEntityValues(run: AgentRun, episode: TaskEpisode) {
  const goal = normalizeGoal(run.goal);
  const result = new Map<string, string[]>();
  for (const [key, value] of Object.entries(run.input)) {
    const values = scalarValues(value);
    if (values.length) result.set(key, values);
  }
  for (const [key, value] of Object.entries(episode.pageExecutionBrief?.entities || {})) {
    if (result.has(key)) continue;
    const values = scalarValues(value);
    // Model-extracted entities become trusted only when every scalar is
    // literally grounded in the immutable user goal stored on AgentRun.
    if (values.length && values.every((item) => goal.includes(item))) result.set(key, values);
  }
  return result;
}

function sameRef(ref: PageObservationRef, observation: PageAgentObservation) {
  return ref.id === observation.id
    && (ref.pageEpoch === undefined || ref.pageEpoch === observation.pageEpoch)
    && (ref.documentId === undefined || ref.documentId === observation.documentId)
    && ref.turnIndex === observation.turnIndex
    && ref.kind === observation.kind
    && ref.sha256 === observation.sha256;
}

/**
 * V2 automatic capability authority is intentionally strict. Every referenced
 * model-visible observation must already be durable and the dispatched action
 * receipts must form one closed before/after chain ending at the terminal
 * observation. Partial evidence falls back to the legacy receipt path; it
 * never receives this authority.
 */
export function capabilityExperienceAuthority(
  run: AgentRun,
  episode: TaskEpisode,
  observations: PageAgentObservation[],
): CapabilityExperienceAuthority | undefined {
  if (!episode || !episode.outcome || typeof episode.goal !== "string"
    || !episode.input || typeof episode.input !== "object" || Array.isArray(episode.input)
    || !episode.startSnapshot || !episode.endSnapshot
    || typeof episode.startSnapshot.url !== "string" || typeof episode.endSnapshot.url !== "string") return undefined;
  const refs = episode.experience?.observationRefs || [];
  const receipts = episode.experience?.actionReceiptsV2 || [];
  if (!refs.length && !receipts.length) return undefined;
  if (!refs.length || !receipts.length || refs.length !== observations.length
    || refs.some((ref) => !Number.isInteger(ref.pageEpoch) || !ref.documentId)
    || receipts.some((receipt) => !validReceiptShape(receipt)) || run.controller !== "page-agent"
    || run.scope.kind !== "site" || run.scope.siteAgentId !== episode.siteAgentId
    || run.id !== episode.taskSessionId
    || run.activePort?.browserSessionId !== episode.browserSessionId
    || normalizeGoal(run.goal) !== normalizeGoal(episode.goal)
    || !sameJson(run.input, episode.input)
    || (episode.outcome.status !== "success" && episode.outcome.status !== "no-result")) return undefined;

  if (!unique(refs.map((ref) => ref.id))) return undefined;
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  if (byId.size !== observations.length || byId.size !== refs.length || refs.some((ref) => {
    const observation = byId.get(ref.id);
    return !observation || !sameRef(ref, observation)
      || observation.siteAgentId !== episode.siteAgentId
      || observation.runId !== run.id
      || observation.episodeId !== episode.id
      || observation.browserSessionId !== episode.browserSessionId;
  })) return undefined;

  const orderedObservations = refs.map((ref) => byId.get(ref.id)!)
    .sort((left, right) => left.pageEpoch - right.pageEpoch
      || left.turnIndex - right.turnIndex
      || left.id.localeCompare(right.id));
  if (!unique(orderedObservations.map((observation) => `${observation.pageEpoch}:${observation.turnIndex}`))) return undefined;
  const refById = new Map(refs.map((ref) => [ref.id, ref]));
  const orderedRefs = orderedObservations.map((observation) => refById.get(observation.id)!);

  const firstObservation = orderedObservations[0]!;
  if (firstObservation.kind !== "full" || firstObservation.baseObservationId) return undefined;
  for (let index = 1; index < orderedObservations.length; index += 1) {
    const previous = orderedObservations[index - 1]!;
    const observation = orderedObservations[index]!;
    const sameDocument = observation.pageEpoch === previous.pageEpoch
      && observation.documentId === previous.documentId;
    if (sameDocument) {
      if (observation.kind !== "delta" || observation.baseObservationId !== previous.id) return undefined;
    } else if (observation.kind !== "full" || observation.baseObservationId
      || observation.pageEpoch !== previous.pageEpoch + 1 || observation.documentId === previous.documentId) return undefined;
  }

  const terminalObservation = orderedObservations.at(-1)!;
  if (!samePage(episode.startSnapshot, firstObservation)
    || !samePage(episode.endSnapshot, terminalObservation)
    || episode.documentId !== firstObservation.documentId
    || terminalObservation.pageEpoch !== run.pageEpoch
    || terminalObservation.documentId !== run.activePort?.documentId) return undefined;

  const requirement = executionRequirementForGoal(run.goal);
  // V1 is a positive authority allowlist, not a growing verb blacklist. Pure
  // read-only query/filter operations are permitted. The sole automatic write
  // exception is add-to-cart, which is checked below using a dedicated
  // before/after business predicate. Mixed goals such as "search then follow"
  // remain rejected for AI-only admission; an explicit human success choice
  // may hand that structurally verified experience to later generation and
  // validation without claiming that its semantics are already trusted.
  const boundedQuery = QUERY_GOAL.test(run.goal) && !CART_GOAL.test(run.goal)
    && requirement.kind === "required" && requirement.effect === "read"
    && requirement.evidence === "page-action";
  const boundedCartAdd = CART_GOAL.test(run.goal)
    && requirement.kind === "required" && requirement.effect === "reversible-write"
    && requirement.evidence === "business-receipt";
  const humanAdmission = humanConfirmedSuccessAdmission(episode, requirement);
  if (!humanAdmission && !boundedQuery && !boundedCartAdd) return undefined;
  const brief = episode.pageExecutionBrief;
  if (!brief || brief.normalizedGoal !== normalizeGoal(run.goal)
    || brief.effect !== (requirement.kind === "required" ? requirement.effect : "read")
    || executionCompletionCriteria(run.goal, requirement)
      .some((criterion) => !brief.completionCriteria.includes(criterion))) return undefined;
  const budget = episode.experience?.budgetEvidence;
  const serverModelBudget = serverRuntimeModelBudget(run);
  const serverModelWindowMs = serverModelBudget.pageExecutionFirstRequestedAt && serverModelBudget.pageExecutionLastRequestedAt
    ? Date.parse(serverModelBudget.pageExecutionLastRequestedAt) - Date.parse(serverModelBudget.pageExecutionFirstRequestedAt)
    : 0;
  if (!budget || budget.activeLimitMs > 180_000 || budget.modelRequestLimit > 100
    || budget.activeElapsedMs < 0 || budget.activeElapsedMs >= budget.activeLimitMs
    || budget.modelRequests < 0 || budget.modelRequests > budget.modelRequestLimit
    || budget.noProgressCount >= 3 || Boolean(budget.exhaustedReason)
    // PageAgent and ambiguous-boundary calls reserve the same client budget
    // and the same durable AgentRun ledger. Capability authoring requires an
    // exact match; a browser cannot under-report provider attempts.
    || budget.modelRequests !== serverModelBudget.pageExecutionRequestCount
    // Server timestamps are a trusted lower bound on active execution. Runs
    // containing long user/hidden waits may still complete, but are excluded
    // from automatic learning when the server cannot prove the 180s budget.
    || !Number.isFinite(serverModelWindowMs) || serverModelWindowMs > budget.activeElapsedMs) return undefined;

  const dispatched = receipts.filter((receipt) => receipt.dispatched)
    .sort((left, right) => {
      const leftBefore = byId.get(left.beforeObservationId);
      const rightBefore = byId.get(right.beforeObservationId);
      return (leftBefore?.pageEpoch || 0) - (rightBefore?.pageEpoch || 0)
        || left.turnIndex - right.turnIndex
        || left.id.localeCompare(right.id);
    });
  if (!dispatched.length || dispatched.length !== orderedObservations.length - 1
    || !unique(dispatched.map((receipt) => receipt.id))) return undefined;
  let hasObservedMaterialChange = false;
  const changedMaterial: typeof dispatched = [];
  for (let index = 0; index < dispatched.length; index += 1) {
    const receipt = dispatched[index]!;
    const before = byId.get(receipt.beforeObservationId);
    const after = receipt.afterObservationId ? byId.get(receipt.afterObservationId) : undefined;
    if (!before || !after || before.turnIndex !== receipt.turnIndex
      || receipt.beforeObservationId !== orderedObservations[index]!.id
      || receipt.afterObservationId !== orderedObservations[index + 1]!.id) return undefined;
    if (sensitiveTarget(receipt.target)) return undefined;
    const effect = observedEffect(before, after);
    if (receipt.action === "press") {
      // PageAgent dispatches keyboard events synthetically. Preserve this step
      // only as non-authoritative telemetry; an arbitrary or client-asserted
      // changed press is rejected, and some later material receipt must still
      // prove the business effect.
      if (receipt.effect !== "unknown"
        || receipt.effectSignals.synthetic !== true
        || receipt.effectSignals.isTrusted !== false
        || typeof receipt.effectSignals.observedStateChanged !== "boolean") return undefined;
    } else {
      // Both directions are fail-closed: a client may neither invent a change
      // nor hide one behind an `unchanged` receipt.
      if (POSSIBLE_SIDE_EFFECT_ACTIONS.has(receipt.action) && receipt.effect === "unknown") return undefined;
      if (receipt.effect !== effect) return undefined;
    }
    if (MATERIAL_ACTIONS.has(receipt.action) && effect === "changed") {
      hasObservedMaterialChange = true;
      changedMaterial.push(receipt);
    }
    if (TARGETED_ACTIONS.has(receipt.action)) {
      if (!receipt.target || receipt.target.observationId !== before.id
        || !before.targets.some((target) => sameStableTarget(receipt.target!, target))) return undefined;
    }
  }
  if (!hasObservedMaterialChange) return undefined;
  if (dispatched.at(-1)!.afterObservationId !== orderedRefs.at(-1)!.id) return undefined;

  const entities = trustedEntityValues(run, episode);
  if (!humanAdmission && requirement.effect !== "read" && entities.size === 0) return undefined;
  if (!humanAdmission && entities.size && !(QUERY_GOAL.test(run.goal) && episode.outcome.status === "no-result")) {
    const relevantReceipts = requirement.effect === "read" ? changedMaterial : changedMaterial.slice(-1);
    if ([...entities.values()].some((values) => !relevantReceipts.some((receipt) => {
      const after = receipt.afterObservationId ? byId.get(receipt.afterObservationId) : undefined;
      const direct = targetCorpus(receipt.target);
      const actionValues = Object.values(receipt.input).flatMap((value) => scalarValues(value));
      const before = byId.get(receipt.beforeObservationId);
      const beforeText = before ? observationCorpus(before) : "";
      const afterText = after ? observationCorpus(after) : "";
      return values.every((value) => direct.includes(value)
        // Text/select values are authenticated by the ordered action receipt.
        // They remain valid entity bindings when the initial page already
        // happens to mention the same value (for example, a featured product
        // named "notebook" before the user searches for notebook).
        || actionValues.includes(value)
        || (afterText.includes(value) && !beforeText.includes(value)));
    }))) return undefined;
  }
  const terminalText = observationCorpus(terminalObservation);
  if (QUERY_GOAL.test(run.goal) && !CART_GOAL.test(run.goal)
    && !humanAdmission
    && !queryCompletionProven(episode, terminalObservation, firstObservation, changedMaterial, entities)) return undefined;
  if (!humanAdmission && episode.outcome.status === "no-result" && !QUERY_GOAL.test(run.goal)) return undefined;
  if (!humanAdmission && CART_GOAL.test(run.goal)) {
    const lastMaterial = changedMaterial.at(-1)!;
    const addTarget = targetCorpus(lastMaterial.target);
    const before = byId.get(lastMaterial.beforeObservationId);
    const beforeText = before ? observationCorpus(before) : "";
    const entityValues = [...entities.values()].flat();
    const explicitlyAdded = (value: string) =>
      /(?:successfully\s+added|added\s+to|has\s+been\s+added|已(?:成功)?加入)/iu.test(value)
      && entityValues.every((entity) => value.includes(entity));
    // A stale success banner is not evidence for this action. The explicit
    // acknowledgement must be new in the receipt's before/after transition;
    // otherwise only a strictly increased cart count can authorize learning.
    const explicitAdded = explicitlyAdded(terminalText) && !explicitlyAdded(beforeText);
    const cartCount = (value: string) => {
      const match = value.match(/(?:cart|basket|shopping\s+bag|购物车|购物袋)[^\d]{0,24}(\d+)/iu);
      return match ? Number(match[1]) : undefined;
    };
    const beforeCount = cartCount(beforeText);
    const afterCount = cartCount(terminalText);
    const countIncreased = beforeCount !== undefined && afterCount !== undefined && afterCount > beforeCount;
    if (!CART_EVIDENCE.test(addTarget) || !(explicitAdded || countIncreased)) return undefined;
  }

  const repairSource = expectedRepairSource(run);
  const repairVersion = expectedRepairVersion(run);
  if (!repairSource && !repairVersion
    && episode.mode === "adaptive" && !episode.capabilityId && !episode.sourceCapabilityId) {
    return {
      version: 1,
      kind: "create",
      evidence: "page-observation-v1",
      siteAgentId: episode.siteAgentId,
      runId: run.id,
      episodeId: episode.id,
      observationRefs: orderedRefs,
    };
  }
  if (episode.mode === "repair" && episode.repairKind === "compiled-capability-drift"
    && episode.sourceCapabilityId && repairSource === episode.sourceCapabilityId && repairVersion
    && (!episode.capabilityId || episode.capabilityId === episode.sourceCapabilityId)) {
    return {
      version: 1,
      kind: "strengthen",
      evidence: "page-observation-v1",
      siteAgentId: episode.siteAgentId,
      runId: run.id,
      episodeId: episode.id,
      observationRefs: orderedRefs,
      sourceCapabilityId: episode.sourceCapabilityId,
      sourceVersionId: repairVersion,
    };
  }
  return undefined;
}

/** Admission to generation, never permission to execute or publish a capability.
 * Legacy SDKs already consume an authenticated Run receipt before saving an
 * Episode. Reuse that receipt; never downgrade a rejected V2 observation chain.
 */
export function legacyCapabilityExperienceAuthority(run: AgentRun, episode: TaskEpisode): CapabilityExperienceAuthority | undefined {
  if (run.controller !== "page-agent" || run.scope.kind !== "site"
    || run.scope.siteAgentId !== episode.siteAgentId || run.id !== episode.taskSessionId
    || run.activePort?.browserSessionId !== episode.browserSessionId
    || normalizeGoal(run.goal) !== normalizeGoal(episode.goal)
    || run.agentState.capabilityGapEpisodeId !== episode.id
    || (run.agentState.capabilityExperienceAuthorityKind !== undefined
      && run.agentState.capabilityExperienceAuthorityKind !== "legacy-create")
    || episode.experience?.observationRefs?.length || episode.experience?.actionReceiptsV2?.length
    || run.outcome?.status !== episode.outcome.status
    || !capabilityHandoffForEpisode(episode, {}).delivered) return undefined;
  return { version: 1, kind: "legacy-create", evidence: "authenticated-episode-v1",
    siteAgentId: episode.siteAgentId, runId: run.id, episodeId: episode.id, observationRefs: [] };
}
