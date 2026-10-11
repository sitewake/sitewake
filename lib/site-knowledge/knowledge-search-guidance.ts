/**
 * Single source of truth for how a user's phrasing becomes search keywords.
 *
 * Content search is pure literal grep (simplify-knowledge-search): a synonym the caller
 * does not list is never found. So recall depends entirely on the caller expanding the
 * question into the words the site itself might use. TWO callers do this expansion — the
 * runtime main agent (inline, at tool-call time) and the console diagnostic probe (a direct
 * model call) — and they MUST stay in sync, or the console would test a different search
 * than production runs. Both reference this one constant so the guidance can never drift.
 */
export const KEYWORD_EXPANSION_GUIDANCE =
  "把用户的问题扩展成 2~6 个关键词：原词 + 近义词 + 网站可能采用的表述（例：“小孩能玩吗”→[\"小孩\",\"未成年\",\"儿童\"]）。检索是字面匹配，没有列出的近义词不会被命中。";
