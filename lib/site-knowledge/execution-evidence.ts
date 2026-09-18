import {
  normalizeGoal,
  type ActionReceiptV2,
  type JsonValue,
  type PageAgentObservation,
  type PageExecutionBrief,
} from "./protocol";

export type CompletionEvidenceCitation = {
  criterion: string;
  evidence: string;
};

export type PageExecutionEvidenceAssessment = {
  satisfied: boolean;
  missingEntities: string[];
  missingCriteria: string[];
  entityBindings: Record<string, string>;
  completionEvidence: CompletionEvidenceCitation[];
};

const TARGET_ALIAS_GROUPS = [
  ["cushion", "垫子", "靠垫"],
  ["mug", "马克杯", "杯子"],
  ["shirt", "t-shirt", "tshirt", "衣服", "衬衫", "t恤"],
  ["notebook", "笔记本"],
  ["sweater", "毛衣"],
  ["shoe", "shoes", "鞋"],
  ["phone", "mobile", "手机"],
  ["poster", "海报"],
];

/**
 * Extract only a reusable product/entity noun from an effectful request. This
 * is intentionally a small safety vocabulary, not a capability classifier:
 * unknown nouns are retained literally, while generic words such as 商品 do
 * not create a false target requirement.
 */
export function inferExecutionTargetEntity(goal: string): JsonValue | undefined {
  const value = goal.normalize("NFKC").trim();
  const match = value.match(/(?:搜索|查找|找一下|找个|找一个|寻找|search|find)\s*(?:一个|个|a|an|the)?\s*(.+?)(?=(?:加入|添加|放进|放入|加到|移入|购物车|购物袋|to\s+cart|cart\b|$))/iu);
  if (!match?.[1]) return undefined;
  const phrase = match[1].replace(/[的之]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!phrase || /^(?:商品|东西|item|product|something)$/iu.test(phrase)) return undefined;
  const normalizedPhrase = normalizeGoal(phrase);
  const group = TARGET_ALIAS_GROUPS.find((aliases) => aliases.some((alias) => normalizedPhrase.includes(normalizeGoal(alias))));
  if (group) return { anyOf: group };
  const tail = phrase.split(/\s+/u).filter(Boolean).slice(-2).join(" ");
  return { anyOf: [tail || phrase] };
}

function scalarValues(value: JsonValue, depth = 0): string[] {
  if (depth > 2 || value === null) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const normalized = normalizeGoal(String(value));
    return normalized ? [normalized] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => scalarValues(item, depth + 1));
  return Object.values(value).flatMap((item) => scalarValues(item, depth + 1));
}

function observationCorpus(observation?: PageAgentObservation) {
  if (!observation) return "";
  return normalizeGoal([
    observation.state.url,
    observation.state.title,
    observation.state.header,
    observation.state.content,
    observation.state.footer,
    ...observation.targets.flatMap((target) => [
      target.role || "",
      target.accessibleName || "",
      target.controlType || "",
      target.hrefPath || "",
      target.nearbyText || "",
    ]),
  ].join("\n"));
}

function receiptCorpus(receipt: ActionReceiptV2) {
  return normalizeGoal([
    ...Object.values(receipt.input).flatMap((value) => scalarValues(value)),
    receipt.target?.role || "",
    receipt.target?.accessibleName || "",
    receipt.target?.controlType || "",
    receipt.target?.hrefPath || "",
    receipt.target?.nearbyText || "",
    ...Object.values(receipt.effectSignals).flatMap((value) => scalarValues(value)),
  ].join("\n"));
}

function targetReceiptCorpus(receipt: ActionReceiptV2) {
  // Do not use free-form action input here. A search field can contain the
  // requested noun while the final click adds a different product (the exact
  // failure this guard is meant to prevent).
  return normalizeGoal([
    receipt.target?.role || "",
    receipt.target?.accessibleName || "",
    receipt.target?.controlType || "",
    receipt.target?.hrefPath || "",
    receipt.target?.nearbyText || "",
    ...Object.values(receipt.effectSignals).flatMap((value) => scalarValues(value)),
  ].join("\n"));
}

function requiredEntities(brief?: PageExecutionBrief) {
  if (!brief) return [];
  return Object.entries(brief.entities).flatMap(([key, value]) => {
    const candidate = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined;
    const alternatives = Array.isArray(candidate?.anyOf)
      ? candidate.anyOf.filter((item): item is JsonValue => item !== undefined).flatMap((item) => scalarValues(item))
      : [];
    const values = alternatives.length ? alternatives : scalarValues(value);
    return values.length ? [{ key, values, anyOf: alternatives.length > 0 }] : [];
  });
}

/**
 * Bind immutable task facts and completion claims to the exact observations
 * and receipts used by PageAgent. This is deliberately pure so the browser and
 * the capability-authority boundary can apply the same rules independently.
 */
export function assessPageExecutionEvidence(input: {
  brief?: PageExecutionBrief;
  receipts: ActionReceiptV2[];
  observations: PageAgentObservation[];
  completionEvidence?: CompletionEvidenceCitation[];
}): PageExecutionEvidenceAssessment {
  const { brief, receipts, observations } = input;
  if (!brief) {
    return { satisfied: true, missingEntities: [], missingCriteria: [], entityBindings: {}, completionEvidence: [] };
  }
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const changed = receipts.filter((receipt) => receipt.dispatched && receipt.effect === "changed");
  const entityBindings: Record<string, string> = {};
  const missingEntities: string[] = [];

  for (const entity of requiredEntities(brief)) {
    const binding = changed.find((receipt) => {
      const direct = entity.key === "goalTarget" ? targetReceiptCorpus(receipt) : receiptCorpus(receipt);
      const matches = entity.anyOf
        ? entity.values.some((value) => direct.includes(normalizeGoal(String(value))))
        : entity.values.every((value) => direct.includes(normalizeGoal(String(value))));
      if (matches) return true;
      if (entity.key === "goalTarget") return false;
      const before = observationCorpus(byId.get(receipt.beforeObservationId));
      const after = observationCorpus(receipt.afterObservationId ? byId.get(receipt.afterObservationId) : undefined);
      return entity.anyOf
        ? entity.values.some((value) => after.includes(normalizeGoal(String(value))) && !before.includes(normalizeGoal(String(value))))
        : entity.values.every((value) => after.includes(normalizeGoal(String(value))) && !before.includes(normalizeGoal(String(value))));
    });
    if (binding) entityBindings[entity.key] = binding.id;
    else missingEntities.push(entity.key);
  }

  // A write must be proven by its changed after-state. A read-only
  // reconciliation has no material receipt, so its current observation is the
  // authoritative corpus instead.
  const relevantObservations = brief.effect === "read"
    ? observations
    : changed.flatMap((receipt) => {
        const after = receipt.afterObservationId ? byId.get(receipt.afterObservationId) : undefined;
        return after ? [after] : [];
      });
  const evidenceCorpus = normalizeGoal([
    ...relevantObservations.map(observationCorpus),
    ...changed.map(receiptCorpus),
  ].join("\n"));
  const supplied = input.completionEvidence || [];
  const accepted: CompletionEvidenceCitation[] = [];
  const missingCriteria = brief.completionCriteria.filter((criterion) => {
    const row = supplied.find((item) => normalizeGoal(item.criterion) === normalizeGoal(criterion));
    const evidence = normalizeGoal(row?.evidence || "");
    // One-character citations such as a cart badge of "1" are too ambiguous
    // to establish completion. The model can cite the surrounding label.
    if (evidence.length < 2 || !evidenceCorpus.includes(evidence)) return true;
    accepted.push({ criterion, evidence: row!.evidence.trim().slice(0, 500) });
    return false;
  });

  return {
    satisfied: missingEntities.length === 0 && missingCriteria.length === 0,
    missingEntities,
    missingCriteria,
    entityBindings,
    completionEvidence: accepted,
  };
}
