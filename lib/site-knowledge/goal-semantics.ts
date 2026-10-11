/**
 * Runtime-only semantic decomposition of a user's goal.
 *
 * This is deliberately not a capability-center transport schema.  It is a
 * small, code-owned frame used to keep the original business intent stable
 * while the PageAgent discovers one UI atom at a time.  The model may suggest
 * a focused page step, but it cannot replace this frame or widen its effect.
 */

export type GoalSemanticEffect = "read" | "reversible-write" | "irreversible-write";
export type GoalSemanticMode = "execute" | "inform" | "navigate" | "verify";

export type GoalSemanticAction = {
  id: string;
  predicate: string;
  object?: string;
  polarity: "positive" | "negative";
  effect: GoalSemanticEffect;
  dependencies: string[];
  successPredicate: Record<string, string>;
};

export type GoalSemanticFrame = {
  originalGoal: string;
  normalizedGoal: string;
  mode: GoalSemanticMode;
  actions: GoalSemanticAction[];
  ambiguityReasons: string[];
};

type ActionPattern = {
  predicate: string;
  effect: GoalSemanticEffect;
  pattern: RegExp;
  objectPattern?: RegExp;
  successType: string;
};

// The patterns describe predicates, not nouns.  In particular, `book` is
// accepted only as a reservation verb phrase; `notebook` can never become a
// purchase/reservation action just because it contains the same characters.
const ACTION_PATTERNS: ActionPattern[] = [
  { predicate: "search", effect: "read", pattern: /(?:搜索|查找|找(?:一下|一个|个)?|\b(?:search|find)\b)/iu, objectPattern: /(?:搜索|查找|找(?:一下|一个|个)?|\b(?:search|find)\b)\s*(?:一个|个|一下)?\s*(.+?)(?:并|然后|之后|\band\b|\bthen\b|$)/iu, successType: "search-results" },
  { predicate: "filter", effect: "read", pattern: /(?:筛选|过滤|\bfilter\b)/iu, successType: "filtered-results" },
  { predicate: "sort", effect: "read", pattern: /(?:排序|排(?:个?序|一下)|\bsort\b)/iu, successType: "sorted-results" },
  { predicate: "add-to-cart", effect: "reversible-write", pattern: /(?:加入|添加|放入|放|加(?:到|进)?|移入).{0,16}(?:购物车|购物袋)|(?:add|put)\s+.+?\s+(?:to|in(?:to)?)\s+(?:the\s+)?cart\b/iu, successType: "business-receipt" },
  { predicate: "purchase", effect: "irreversible-write", pattern: /(?:购买|买下|下单|结算|支付|\b(?:purchase|buy|checkout|pay)\b)/iu, successType: "business-receipt" },
  { predicate: "reserve", effect: "irreversible-write", pattern: /(?:预订|预约|reserve|book\s+(?:an?\s+)?(?:hotel|room|flight|table|appointment))\b/iu, successType: "business-receipt" },
  { predicate: "delete", effect: "irreversible-write", pattern: /(?:删除|移除|\b(?:delete|remove)\b)/iu, successType: "business-receipt" },
  { predicate: "save", effect: "reversible-write", pattern: /(?:保存|收藏|关注|订阅|\b(?:save|favorite|follow|subscribe)\b)/iu, successType: "business-receipt" },
  { predicate: "read", effect: "read", pattern: /(?:查看|浏览|阅读|打开|点开|点进去|看看|\b(?:read|view|open)\b|\blook\s+at\b)/iu, successType: "page-state" },
];

const INFORMATIONAL = /(?:我想知道|我需要了解|告诉我|请问|怎么|如何|为什么|是否|能否|可不可以|是什么|规则|说明|介绍|教程|方法|步骤|流程|how\s+(?:do|can|should|would)\s+i\b|what\s+(?:is|are|does|should)\b|why\b|whether\b|can\s+i\b|could\s+you\s+(?:explain|show|tell)\b|instructions?\b|guide\b)/iu;
const NEGATED = /(?:不要|别|无需|不需要|不用|仅(?:仅)?(?:帮我)?找|只(?:帮我)?找|don't|do\s+not|not\s+buy|not\s+purchase|without\s+(?:buying|purchasing))/iu;
const NAVIGATION = /(?:跳转|导航|打开|点开|点进去|进入|前往|带我去|go\s+to|navigate|open\s+(?:the\s+)?page|take\s+me\s+to)/iu;

function extractObject(goal: string, pattern?: RegExp) {
  if (!pattern) return undefined;
  const match = goal.match(pattern);
  const value = match?.[1]?.trim().replace(/[，。,.!?！？]+$/gu, "");
  return value && value.length <= 120 ? value : undefined;
}

function actionOrder(left: RegExpMatchArray, right: RegExpMatchArray) {
  return (left.index || 0) - (right.index || 0);
}

/** Build a stable semantic frame from the original user request. */
export function deriveGoalSemanticFrame(goal: string): GoalSemanticFrame {
  const originalGoal = goal.trim();
  const normalizedGoal = originalGoal.normalize("NFKC").trim();
  const ambiguityReasons: string[] = [];
  if (!normalizedGoal) return { originalGoal, normalizedGoal, mode: "inform", actions: [], ambiguityReasons: ["empty-goal"] };

  const informational = INFORMATIONAL.test(normalizedGoal);
  const negated = NEGATED.test(normalizedGoal);
  const matches = ACTION_PATTERNS.flatMap((entry) => {
    const match = normalizedGoal.match(entry.pattern);
    return match ? [{ entry, match }] : [];
  }).sort((left, right) => actionOrder(left.match, right.match));

  const actions: GoalSemanticAction[] = [];
  for (const { entry } of matches) {
    const polarity = negated && ["purchase", "reserve", "delete", "add-to-cart"].includes(entry.predicate) ? "negative" : "positive";
    const effect = polarity === "negative" ? "read" : entry.effect;
    const object = extractObject(normalizedGoal, entry.objectPattern);
    actions.push({
      id: `goal-action-${actions.length + 1}`,
      predicate: entry.predicate,
      ...(object ? { object } : {}),
      polarity,
      effect,
      dependencies: actions.length ? [actions[actions.length - 1].id] : [],
      successPredicate: { type: entry.successType, predicate: entry.predicate },
    });
  }

  if (informational) {
    // “How can I buy a book?” is an explanation request, not a purchase.
    return {
      originalGoal,
      normalizedGoal,
      mode: "inform",
      actions: actions.map((action) => ({ ...action, effect: "read" as const, polarity: "negative" as const })),
      ambiguityReasons: ["informational-question"],
    };
  }
  if (!actions.length) {
    ambiguityReasons.push("no-canonical-action");
    return { originalGoal, normalizedGoal, mode: NAVIGATION.test(normalizedGoal) ? "navigate" : "verify", actions, ambiguityReasons };
  }
  if (actions.every((action) => action.polarity === "negative" || action.effect === "read")) {
    return { originalGoal, normalizedGoal, mode: NAVIGATION.test(normalizedGoal) ? "navigate" : "verify", actions, ambiguityReasons };
  }
  return { originalGoal, normalizedGoal, mode: NAVIGATION.test(normalizedGoal) && actions.every((action) => action.effect === "read") ? "navigate" : "execute", actions, ambiguityReasons };
}

export function semanticFrameEffect(frame: GoalSemanticFrame): GoalSemanticEffect {
  if (frame.mode === "inform" || !frame.actions.length) return "read";
  if (frame.actions.some((action) => action.effect === "irreversible-write" && action.polarity === "positive")) return "irreversible-write";
  if (frame.actions.some((action) => action.effect === "reversible-write" && action.polarity === "positive")) return "reversible-write";
  return "read";
}

export function semanticActionSummary(frame: GoalSemanticFrame) {
  return frame.actions.map((action) => {
    const object = action.object ? `(${action.object})` : "";
    return `${action.polarity === "negative" ? "禁止" : "执行"} ${action.predicate}${object} → ${action.successPredicate.type}`;
  }).join("；");
}
