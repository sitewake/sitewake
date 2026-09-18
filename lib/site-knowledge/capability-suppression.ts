import { normalizeGoal, type CapabilitySuppression } from "./protocol";

function canonicalIntentText(value: string) {
  return normalizeGoal(value)
    .replace(/(查找|查询|检索|搜一下|找一下)/g, "搜索")
    .replace(/(查看|进入|前往|去到)/g, "打开");
}

function semanticTokens(value: string) {
  const normalized = canonicalIntentText(value)
    .replace(/\{[^}]+\}/g, " ")
    .replace(/^(请|帮我|我要|我想|麻烦|能否|可以)?(打开|查看|进入|前往|去到)?/g, "")
    .replace(/\s+/g, "");
  const tokens = new Set<string>();
  for (const word of normalizeGoal(value).split(/\s+/).filter((item) => item.length > 1)) tokens.add(word);
  if (/\p{Script=Han}/u.test(normalized)) {
    for (let index = 0; index < normalized.length - 1; index += 1) tokens.add(normalized.slice(index, index + 2));
  } else if (normalized) {
    for (const word of normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) tokens.add(word);
  }
  return tokens;
}

function templateMatches(template: string, goal: string) {
  if (!/\{[^}]+\}/.test(template)) return false;
  const normalizedGoal = canonicalIntentText(goal).replace(/\s+/g, "");
  const genericResultWords = new Set([
    "详情", "明细", "列表", "清单", "结果", "页面", "内容", "信息",
    "detail", "details", "list", "results", "result", "page", "content", "information",
  ]);
  const fixed = template
    .split(/\{[^}]+\}/)
    .map((part) => canonicalIntentText(part)
      .replace(/^(请|帮我|我要|我想|麻烦|能否|可以)?(打开|搜索)/g, "")
      .replace(/^(please)?(open|view|visit|go\s*to|search|find|query)/i, "")
      .replace(/\s+/g, ""))
    .filter((part) => part.length >= 2 && !genericResultWords.has(part));
  // A generic verb is not a business object. For example, unpublishing
  // “搜索 {keyword}” must not suppress every future search capability.
  return fixed.length > 0 && fixed.every((part) => normalizedGoal.includes(part));
}

export function capabilitySuppressionScore(suppression: CapabilitySuppression, goal: string) {
  const normalized = canonicalIntentText(goal);
  if (suppression.normalizedPatterns.some((pattern) => canonicalIntentText(pattern) === normalized)) return 1;
  if (templateMatches(suppression.goalTemplate, goal)) return 0.96;
  const left = semanticTokens(goal);
  if (!left.size) return 0;
  return Math.max(0, ...suppression.normalizedPatterns.map((pattern) => {
    const right = semanticTokens(pattern);
    if (!right.size) return 0;
    const common = [...left].filter((token) => right.has(token)).length;
    return (2 * common) / (left.size + right.size);
  }));
}

export function matchingCapabilitySuppression(
  suppressions: CapabilitySuppression[],
  goal: string,
  intentKey?: string,
) {
  const active = suppressions.filter((item) => item.status === "active");
  const exactIntent = intentKey ? active.find((item) => item.intentKey === intentKey) : undefined;
  if (exactIntent) return exactIntent;
  return active
    .map((suppression) => ({ suppression, score: capabilitySuppressionScore(suppression, goal) }))
    .filter((item) => item.score >= 0.68)
    .sort((left, right) => right.score - left.score)[0]?.suppression;
}
