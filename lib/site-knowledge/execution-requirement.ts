import type { ExecutionRequirement } from "./protocol";
import { isNavigationIntentGoal } from "./navigation-tools";
import { deriveGoalSemanticFrame, semanticFrameEffect } from "./goal-semantics";

const PAGE_EFFECT_GOAL = /(?:提交|保存|删除|移除|收藏|订阅|购买|下单|加入(?:购物车|购物袋)|添加(?:到|进)?(?:购物车|购物袋)|放入?(?:购物车|购物袋)|加(?:到|进)?(?:购物车|购物袋)|移入(?:购物车|购物袋)|结算|支付|创建|修改|发送|登录|填写|选择|点击|上传|下载|预约|预订|点赞|关注|搜索|查找|筛选|排序|排(?:个?序|一下)|从高到低|从低到高|由高到低|由低到高|A\s*到\s*Z|Z\s*到\s*A|add\b.*\bcart|put\b.*\bcart|checkout|purchase|buy|submit|save|delete|remove|send|upload|\bbook\b|\breserve\b|sign\s*in|log\s*in|search|find|filter|sort)/i;
const INFORMATIONAL_ACTION_QUESTION = /(?:我想知道|我需要了解|告诉我|请问|怎么|如何|为什么|是否|能否|可不可以|是什么|规则|说明|介绍|教程|方法|步骤|流程|how\s+(?:do|can|should|would)\s+i\b|what\s+(?:is|are|does|should)\b|why\b|whether\b|can\s+i\b|could\s+you\s+(?:explain|show|tell)\b|instructions?\b|guide\b)/i;
const COMPOUND_PAGE_EFFECT_GOAL = /(?:并|然后|之后|以后|并且|再|接着|and\s+then|then)\s*.*(?:提交|保存|删除|移除|收藏|订阅|购买|下单|加入(?:购物车|购物袋)|结算|支付|创建|修改|发送|登录|填写|选择|点击|上传|预约|预订|点赞|关注|add\b.*\bcart|checkout|purchase|buy|submit|save|delete|remove|send|upload|\bbook\b|\breserve\b|sign\s*in|log\s*in)/i;
// Word-bound the English reservation verbs. Without the boundaries, a
// harmless search term such as "notebook" matches `book` and is incorrectly
// classified as an irreversible operation.
const IRREVERSIBLE_PAGE_EFFECT_GOAL = /(?:delete|remove|submit|send|checkout|purchase|buy|pay|\bbook\b|\breserve\b|place\s+(?:an?\s+)?order|删除|移除|提交|发送|结算|支付|购买|下单|预约|预订)/i;
const REVERSIBLE_PAGE_EFFECT_GOAL = /(?:save|add\b.*\bcart|put\b.*\bcart|favorite|follow|subscribe|create|modify|edit|保存|加入(?:购物车|购物袋)|添加(?:到|进)?(?:购物车|购物袋)|放入?(?:购物车|购物袋)|加(?:到|进)?(?:购物车|购物袋)|移入(?:购物车|购物袋)|收藏|关注|订阅|创建|修改|编辑)/i;
const AMBIGUOUS_LIVE_PAGE_GOAL = /(?:current|currently|latest|live|on\s+this\s+page|check\s+(?:it|this)|look\s+(?:at|into)|当前|现在|最新|实时|这个页面|看一下|看看|检查一下|帮我处理)/i;

/** Code-owned execution authority shared by the browser and server. */
export function executionRequirementForGoal(goal: string): ExecutionRequirement {
  const value = goal.normalize("NFKC").trim();
  if (!value) return { kind: "not-required", effect: "read", evidence: "none", reasons: ["empty-goal"] };
  if (INFORMATIONAL_ACTION_QUESTION.test(value)) {
    return { kind: "not-required", effect: "read", evidence: "none", reasons: ["informational-question"] };
  }
  // First classify the user's verbs and their polarity.  This prevents a noun
  // such as “notebook” from widening authority merely because it contains the
  // characters “book”, while still allowing a later PageAgent step to discover
  // the concrete controls one at a time.
  const semantic = deriveGoalSemanticFrame(value);
  if (semantic.actions.length) {
    const effect = semanticFrameEffect(semantic);
    return {
      kind: "required",
      effect,
      evidence: effect === "read" ? "page-action" : "business-receipt",
      reasons: [semantic.mode === "navigate" ? "semantic-navigation-action" : "semantic-page-action"],
    };
  }
  if (isNavigationIntentGoal(value) && !COMPOUND_PAGE_EFFECT_GOAL.test(value)) {
    // A verified static Scene is handled without PageAgent. If the destination
    // is dynamic or only observed, however, the runtime still has to click a
    // live link/card to enter it. Treat that arrival as a read-only page action
    // (never a capability-authoring write) so full-mode PageAgent can navigate;
    // the experience authority allowlist still excludes navigation goals.
    return { kind: "required", effect: "read", evidence: "page-action", reasons: ["navigation-page-action"] };
  }
  if (PAGE_EFFECT_GOAL.test(value)) {
    const effect: ExecutionRequirement["effect"] = IRREVERSIBLE_PAGE_EFFECT_GOAL.test(value)
      ? "irreversible-write"
      : REVERSIBLE_PAGE_EFFECT_GOAL.test(value)
        ? "reversible-write"
        : "read";
    return {
      kind: "required",
      effect,
      evidence: effect === "read" ? "page-action" : "business-receipt",
      reasons: [effect === "read" ? "explicit-page-read-action" : "explicit-page-write-action"],
    };
  }
  if (AMBIGUOUS_LIVE_PAGE_GOAL.test(value)) {
    return { kind: "uncertain", effect: "read", evidence: "none", reasons: ["live-page-context-ambiguous"] };
  }
  return { kind: "not-required", effect: "read", evidence: "none", reasons: ["no-page-effect-requested"] };
}

export function executionCompletionCriteria(goal: string, requirement: ExecutionRequirement) {
  const objective = goal.normalize("NFKC").trim();
  if (requirement.evidence === "business-receipt") {
    return [`Complete the user's original objective: ${objective}`, "Observe a page or business receipt that proves the requested change took effect."];
  }
  if (requirement.evidence === "page-action") {
    return [`Complete the user's original objective: ${objective}`, "Observe the page state after the requested page action."];
  }
  return [`Answer the user's original objective from verifiable current-page information: ${objective}`];
}
