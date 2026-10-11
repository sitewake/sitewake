import { normalizeGoal } from "./protocol";

/**
 * Deterministic safety gate for permissive capability recall. Fuzzy retrieval
 * may surface nearby operations, but an opposite value (price ascending vs
 * descending) or a different explicit sort dimension must never be invoked.
 * This is routing metadata only; it does not change any public module schema.
 */
const OPPOSITE_GROUPS = [
  ["从低到高", "低到高", "low to high", "ascending", "asc", "升序", "递增", "正序"],
  ["从高到低", "高到低", "high to low", "descending", "desc", "降序", "递减", "倒序"],
  ["a到z", "a-z", "a to z", "a至z", "名称a到z", "字母正序"],
  ["z到a", "z-a", "z to a", "z至a", "名称z到a", "字母倒序"],
  ["最便宜", "便宜优先", "cheapest", "cheapest first"],
  ["最贵", "昂贵优先", "most expensive", "expensive first"],
  ["最新", "newest", "latest"],
  ["最旧", "oldest", "earliest"],
  ["从小到大", "小到大", "small to large"],
  ["从大到小", "大到小", "large to small"],
] as const;

const AXIS_GROUPS = [
  { id: "price", terms: ["价格", "价钱", "金额", "price", "cost", "cheapest", "expensive"] },
  { id: "name", terms: ["名称", "名字", "字母", "name", "alphabetical", "a到z", "z到a", "a to z", "z to a"] },
  { id: "rating", terms: ["评分", "评价", "星级", "rating", "review", "stars"] },
  { id: "sales", terms: ["销量", "热销", "畅销", "sales", "popular", "best seller"] },
  { id: "date", terms: ["时间", "日期", "最新", "最旧", "date", "newest", "oldest", "latest"] },
] as const;

const ACTION_GROUPS = [
  { id: "sort", terms: ["排序", "sort", "order", "低到高", "高到低", "a到z", "z到a", "升序", "降序"] },
  { id: "cart", terms: ["加入购物车", "加购", "购物车", "addtocart", "add to cart"] },
  { id: "search", terms: ["搜索", "查询", "检索", "search", "query", "find"] },
  { id: "detail", terms: ["商品详情", "详情页", "productdetail", "product detail", "view product"] },
  { id: "preview", terms: ["快速预览", "快速查看", "quickview", "quick view", "preview"] },
  { id: "variant", terms: ["尺码", "颜色", "材质", "尺寸", "size", "color", "colour", "material", "variant"] },
  { id: "currency", terms: ["货币", "currency", "美元", "欧元", "usd", "eur"] },
] as const;

function compact(value: string) {
  return normalizeGoal(value)
    .toLocaleLowerCase("zh-CN")
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function containsAny(text: string, terms: readonly string[]) {
  return terms.some((term) => compact(term) && text.includes(compact(term)));
}

function axisSet(text: string) {
  return new Set(AXIS_GROUPS.filter((group) => containsAny(text, group.terms)).map((group) => group.id));
}

function actionSet(text: string) {
  return new Set(ACTION_GROUPS.filter((group) => containsAny(text, group.terms)).map((group) => group.id));
}

/** Return true when a retrieved capability is semantically unsafe to invoke. */
export function capabilityGoalConflicts(goal: string, phrases: string[]) {
  const request = compact(goal);
  if (!request) return false;
  const candidate = compact(phrases.filter(Boolean).join(" "));
  if (!candidate) return false;

  for (let leftIndex = 0; leftIndex < OPPOSITE_GROUPS.length; leftIndex += 1) {
    const left = OPPOSITE_GROUPS[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < OPPOSITE_GROUPS.length; rightIndex += 1) {
      const right = OPPOSITE_GROUPS[rightIndex];
      if (containsAny(request, left) && containsAny(candidate, right) && !containsAny(request, right)) return true;
      if (containsAny(request, right) && containsAny(candidate, left) && !containsAny(request, left)) return true;
    }
  }

  const requestedAxes = axisSet(request);
  const candidateAxes = axisSet(candidate);
  if (requestedAxes.size > 0 && candidateAxes.size > 0 && [...requestedAxes].every((axis) => !candidateAxes.has(axis))) return true;

  const requestedActions = actionSet(request);
  const candidateActions = actionSet(candidate);
  return requestedActions.size > 0 && candidateActions.size > 0 && [...requestedActions].every((action) => !candidateActions.has(action));
}
