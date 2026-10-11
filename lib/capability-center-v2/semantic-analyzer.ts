import type {
  CapabilitySemanticIR,
  CapabilityContract,
  CapabilityScope,
  LegacyCapabilityScope,
  CapabilitySeed,
  DependencyAction,
  DependencyKind,
  DependencyLedgerEntry,
  EntryPolicy,
  JsonValue,
  ProgramStep,
  ScopeDecision,
} from "./model";

type SemanticAction = {
  action?: string;
  input?: Record<string, JsonValue>;
  element?: { href?: string; accessibleName?: string; label?: string; contextText?: string; role?: string };
  page?: { url?: string; title?: string; heading?: string };
};

export type SemanticAnalysisInput = {
  goal: string;
  effect?: CapabilitySemanticIR["effect"];
  startUrl?: string;
  endUrl?: string;
  input?: Record<string, JsonValue>;
  parameterPaths?: string[];
  steps?: ProgramStep[];
  actions?: SemanticAction[];
  pageTexts?: string[];
};

const CONTEXT_KEYS: Array<[RegExp, DependencyKind]> = [
  [/tenant|workspace|organization|租户|组织|工作区/iu, "tenant"],
  [/filter|facet|color|colour|size|brand|category|分类|颜色|尺码|品牌|筛选/iu, "filter"],
  [/page|offset|cursor|页码|分页/iu, "page"],
  [/role|permission|admin|member|角色|权限/iu, "role"],
  [/date|time|day|日期|时间/iu, "date"],
  [/locale|language|lang|语言|地区/iu, "locale"],
  [/device|mobile|desktop|设备|布局/iu, "device"],
];

const STOP_TOKENS = new Set([
  "http", "https", "www", "com", "html", "php", "index", "search", "query", "page", "category", "categories", "catalog", "products",
  "商品", "产品", "页面", "网站", "查看", "打开", "搜索", "查询", "列表", "首页", "详情",
]);

function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function normalize(value: string) { return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase(); }
function tokens(value: string) {
  return [...new Set(normalize(value).split(/[^\p{L}\p{N}]+/u).filter((item) => item.length >= 2 && !STOP_TOKENS.has(item)))].slice(0, 20);
}
function parameterFor(value: string, input: Record<string, JsonValue>, parameterPaths: string[]) {
  const normalized = normalize(value);
  return parameterPaths.find((path) => {
    const candidate = input[path];
    return (typeof candidate === "string" && normalize(candidate) === normalized)
      || (typeof candidate === "number" && String(candidate) === value);
  });
}
function inputParameterEntries(input: Record<string, JsonValue>, parameterPaths: string[]) {
  return parameterPaths.flatMap((path) => input[path] === undefined ? [] : [{ path, value: input[path] }]);
}
function dependency(
  id: string,
  kind: DependencyKind,
  source: DependencyLedgerEntry["source"],
  value: string,
  action: DependencyAction,
  reason: string,
  extra: Partial<DependencyLedgerEntry> = {},
): DependencyLedgerEntry {
  return { id, kind, source, value: value.slice(0, 500), action, reason: reason.slice(0, 500), ...extra };
}
function routePath(url: string | undefined) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`.slice(0, 500);
  } catch { return url.slice(0, 500); }
}
function sameOrigin(left: string | undefined, right: string | undefined) {
  if (!left || !right) return true;
  try { return new URL(left).origin === new URL(right).origin; } catch { return false; }
}
function hasInputMarker(value: string, parameterPaths: string[]) {
  return parameterPaths.some((path) => value.includes(`{{${path}}}`) || value.includes(`{${path}}`));
}
function likelyCategoryPath(path: string) {
  return /(?:^|\/)(?:category|categories|catalog|collection|department|shop|products?)(?:\/|$)/iu.test(path)
    || /(?:category|categories|catalog|collection|department|分类|目录|品类)/iu.test(path)
    || /(?:^|\/)\d+-[a-z][a-z0-9-]*(?:\/|$)/iu.test(path);
}
// A crawler/runtime often needs a concrete site shell as its deterministic
// navigation entry (for example `/demo`), but that shell is not a business
// scope.  Treat one-segment home-like paths as an entry anchor.  Deeper paths
// such as `/demo/cart` or `/demo/3-tableware` remain explicit page/category
// dependencies and therefore still protect us from scope leakage.
function isSiteEntryPath(path: string) {
  const pathname = path.split(/[?#]/u)[0].replace(/\/+$/u, "") || "/";
  const segments = pathname.split("/").filter(Boolean);
  return segments.length <= 1 || /^(?:home|index|start|welcome|首页)$/iu.test(segments.at(-1) || "");
}
function isUserInputPath(path: string) {
  return /(?:query|keyword|search|term|product|item|target|category|department|color|colour|size|brand|quantity|count|date|locale|language|sort|filter)/iu.test(path);
}

/**
 * A user supplied field is not automatically a target identity.  Quantity,
 * count and similar fields control the write operation; colour/size/brand
 * constrain a target; product/query fields identify the target itself.  Keep
 * this distinction in the semantic IR so the authoring boundary can reserve
 * dynamic target stages without treating `quantity` as a product identity.
 */
function semanticParameterRole(path: string): "target" | "value" | "context" {
  if (/(?:quantity|count|amount|qty|number|date|locale|language|sort)/iu.test(path)) return "value";
  if (/(?:color|colour|size|brand|filter|facet|category|department|分类|颜色|尺码|品牌|筛选)/iu.test(path)) return "context";
  if (/(?:query|keyword|search|term|product|item|target|sku|variant|object|商品|产品)/iu.test(path)) return "target";
  return isUserInputPath(path) ? "context" : "context";
}
function pathKind(path: string): DependencyKind {
  for (const [pattern, kind] of CONTEXT_KEYS) if (pattern.test(path)) return kind;
  if (/url|route|path|href|origin/iu.test(path)) return "route";
  if (/product|item|sku|商品|产品/iu.test(path)) return "product";
  return "other";
}

function usesGlobalSearchControl(input: SemanticAnalysisInput) {
  const goal = normalize(input.goal);
  if (!/(?:搜索|查找|寻找|search|find)/iu.test(goal)) return false;
  return (input.steps || []).some((step) => (step.target?.strategies || []).some((strategy) => {
    const values = [strategy.value, strategy.name, strategy.containsText, ...(strategy.containsTextAll || [])]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    return /搜索|search|query|keyword|关键词|关键字|\bq\b|name\s*=\s*["']?q\b/iu.test(values);
  }));
}

function collectProgramDependencies(input: SemanticAnalysisInput, ledger: DependencyLedgerEntry[]) {
  const values = input.input || {};
  const parameterPaths = input.parameterPaths || Object.keys(values);
  const steps = input.steps || [];
  if (input.startUrl) {
      const startPath = routePath(input.startUrl);
    // A non-root starting page is a real dependency unless the caller has
    // already proved that it is the current-page entry for a declared input.
    if (startPath && startPath !== "/") {
      const parameterized = hasInputMarker(input.startUrl, parameterPaths);
      const globalSearchEntry = !parameterized && usesGlobalSearchControl(input) && !likelyCategoryPath(startPath);
      const siteEntry = !parameterized && isSiteEntryPath(startPath);
      ledger.push(dependency(
        "start-url",
        likelyCategoryPath(startPath) ? "filter" : "start-url",
        "system",
        startPath,
        parameterized ? "Parameterize" : globalSearchEntry || siteEntry ? "Derive" : "Narrow",
        parameterized
          ? "入口 URL 由公开输入驱动。"
            : globalSearchEntry
              ? "起始页仅承载站点级搜索入口；实际业务值通过搜索控件输入，不把首页路径固化为能力前置条件。"
              : siteEntry
                ? "起始页是站点壳/首页锚点；它用于启动探索，不构成业务分类或固定页面前置条件。"
            : "非根入口是本次探索上下文，不能隐式成为站点级前置条件。",
        { required: !parameterized && !globalSearchEntry && !siteEntry },
      ));
    }
  }
  for (const step of steps) {
    const literal = step.value?.source === "literal" && typeof step.value.value === "string" ? step.value.value : "";
    if (step.action === "navigate" && literal) {
      const kind: DependencyKind = likelyCategoryPath(routePath(literal)) ? "filter" : "route";
      const parameterized = hasInputMarker(literal, parameterPaths);
      ledger.push(dependency(
        `route:${step.id}`, kind, "program", routePath(literal), parameterized ? "Parameterize" : "Narrow",
        parameterized ? "导航路径由声明的输入驱动。" : "导航路径是探索中出现的固定上下文，不能自动升级为站点级入口。",
        { parameterPath: parameterized ? parameterPaths.find((path) => literal.includes(`{{${path}}}`) || literal.includes(`{${path}}`)) : undefined, required: !parameterized },
      ));
      continue;
    }
    const strategies = step.target?.strategies || [];
    for (const strategy of strategies) {
      const candidates: unknown[] = [strategy.value, strategy.name, strategy.containsText, ...(strategy.containsTextAll || [])]
        .filter((value) => typeof value === "string" || Boolean(value && typeof value === "object"));
      for (const candidate of candidates) {
        if (typeof candidate !== "string") continue;
        const position = /:nth-(?:child|of-type)|\[(?:data-)?index\s*[=~]|\b(?:nth|index|elementIndex)\b/iu.test(candidate);
        if (position) {
          ledger.push(dependency(`dom:${step.id}`, "dom-position", "program", candidate, "Reject", "DOM 位置不是稳定的业务身份，禁止让 Program 静默选择第一个元素。", { required: true }));
          continue;
        }
        const parameterPath = parameterFor(candidate, values, parameterPaths);
        if (parameterPath || hasInputMarker(candidate, parameterPaths)) {
          ledger.push(dependency(`input:${step.id}:${parameterPath || candidate}`, isUserInputPath(parameterPath || candidate) ? "product" : "other", "program", candidate, "Parameterize", "目标文本与用户输入一致，必须保留为输入绑定。", { parameterPath }));
        } else if (candidate.length >= 2 && !/^\[[^\]]+\]$/.test(candidate)) {
          ledger.push(dependency(`literal:${step.id}:${candidate.slice(0, 30)}`, pathKind(candidate), "program", candidate, "Derive", "固定 DOM 文本只能作为站点语言/证据，不能成为隐藏业务输入。"));
        }
      }
    }
  }
}

function collectExperienceDependencies(input: SemanticAnalysisInput, ledger: DependencyLedgerEntry[]) {
  const values = input.input || {};
  const parameterPaths = input.parameterPaths || Object.keys(values);
  for (const [index, action] of (input.actions || []).entries()) {
    const actionValues = Object.entries(action.input || {});
    for (const [key, raw] of actionValues) {
      if (typeof raw !== "string" && typeof raw !== "number") continue;
      const value = String(raw);
      const parameterPath = parameterFor(value, values, parameterPaths);
      if (parameterPath || isUserInputPath(key)) {
        ledger.push(dependency(`receipt:${index}:${key}`, pathKind(key), "action-receipt", value, "Parameterize", "ActionReceipt 中的业务值来自用户输入或明确业务字段。", { parameterPath }));
      }
    }
    const href = text(action.element?.href);
    if (href && !sameOrigin(input.startUrl, href)) {
      ledger.push(dependency(`receipt-route:${index}`, "route", "action-receipt", href, "Reject", "跨站导航不能在未声明站点边界时进入能力 Program。", { required: true }));
    } else if (href) {
      const path = routePath(href);
      const parameterized = hasInputMarker(href, parameterPaths);
      ledger.push(dependency(`receipt-route:${index}`, likelyCategoryPath(path) ? "filter" : "route", "action-receipt", path, parameterized ? "Parameterize" : "Narrow", parameterized ? "回执路径包含已声明输入。" : "回执路径是探索上下文，需要在 Scope 中显式声明。", { required: !parameterized }));
      const pageLabel = text(action.page?.heading) || text(action.page?.title);
      if (pageLabel && likelyCategoryPath(path)) ledger.push(dependency(`receipt-page:${index}`, "filter", "page-observation", pageLabel, "Narrow", "页面标题/面包屑是分类作用域证据。"));
    }
  }
}

function collectContextDependencies(input: SemanticAnalysisInput, ledger: DependencyLedgerEntry[]) {
  const values = input.input || {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    const kind = pathKind(key);
    if (["tenant", "role", "date", "locale", "device", "page", "filter"].includes(kind)) {
      ledger.push(dependency(`context:${key}`, kind, "user-input", String(value), "Parameterize", "上下文已作为公开输入提供，不能偷偷固定在路径或 DOM 位置中。", { parameterPath: key, required: true }));
    }
  }
  for (const [index, raw] of (input.pageTexts || []).entries()) {
    for (const token of tokens(raw).slice(0, 12)) {
      if (Object.values(values).some((value) => typeof value === "string" && normalize(String(value)).includes(token))) continue;
      if (/^[0-9]+$/u.test(token)) continue;
      ledger.push(dependency(`page-token:${index}:${token}`, "other", "page-observation", token, "Derive", "页面词汇用于解释站点语言，不直接成为业务参数。"));
    }
  }
}

function uniqueLedger(entries: DependencyLedgerEntry[]) {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.kind}|${entry.value}|${entry.parameterPath || ""}|${entry.action}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 100);
}

/**
 * Only dependencies that affect the public input contract or the declared
 * capability boundary should cross the generation boundary. DOM selectors,
 * UI copy and other derived observations remain useful in the debug ledger,
 * but persisting them in every downstream artifact makes the Contract noisy
 * without changing validation or routing decisions.
 */
function durableDependencies(entries: DependencyLedgerEntry[]) {
  const durableActions = new Set<DependencyAction>(["Parameterize", "Precondition", "Narrow", "Split", "Keep", "Reject"]);
  const seenParameters = new Set<string>();
  return entries.filter((entry) => {
    if (!durableActions.has(entry.action)) return false;
    if (entry.action !== "Parameterize" || !entry.parameterPath) return true;
    if (seenParameters.has(entry.parameterPath)) return false;
    seenParameters.add(entry.parameterPath);
    return true;
  });
}

function scopeFromLedger(input: SemanticAnalysisInput, ledger: DependencyLedgerEntry[]): { scope: LegacyCapabilityScope; decision: ScopeDecision; entryPolicy: EntryPolicy } {
  const parameterPaths = input.parameterPaths || Object.keys(input.input || {});
  const fixedRoutes = ledger.filter((entry) => (entry.kind === "route" || entry.kind === "filter") && entry.action === "Narrow");
  const categoryEvidence = ledger.filter((entry) => entry.kind === "filter");
  const categoryRoutes = categoryEvidence.filter((entry) => entry.action === "Narrow");
  const scopeTokens = [...new Set([
    ...categoryRoutes.flatMap((entry) => tokens(entry.value)),
    ...ledger.filter((entry) => categoryEvidence.length && entry.source === "page-observation").flatMap((entry) => tokens(entry.value)),
  ])].slice(0, 20);
  const categoryParameter = parameterPaths.find((path) => /category|department|collection|分类|品类/iu.test(path));
  const rejected = ledger.filter((entry) => entry.action === "Reject");
  const unresolved = ledger.filter((entry) => ["Narrow", "Precondition"].includes(entry.action) && !entry.parameterPath).map((entry) => entry.id);
  let scope: LegacyCapabilityScope;
  let status: ScopeDecision["status"];
  let rationale: string;
  if (rejected.length) {
    scope = { kind: "unknown", binding: "fixed", generalizable: false, ...(scopeTokens.length ? { scopeTokens } : {}), rationale: "存在不稳定 DOM/跨站依赖，必须先修复或拒绝生成。" };
    status = "Rejected";
    rationale = `发现 ${rejected.length} 个不可接受依赖。`;
  } else if (categoryEvidence.length && categoryParameter) {
    scope = { kind: "category-scoped", binding: "user-input", generalizable: true, scopeTokens, requiredInputPaths: [categoryParameter], rationale: "分类是显式用户输入；探索路径可由分类参数驱动。" };
    status = "Generalized";
    rationale = "分类依赖已参数化，能力声明为 category-scoped，不伪装成 site-global。";
  } else if (categoryRoutes.length) {
    scope = { kind: "category-scoped", binding: "fixed", generalizable: false, scopeTokens, rationale: "探索固定在分类/目录上下文，未发现对应用户输入。" };
    status = "Narrowed";
    rationale = "保留为窄范围能力；超出 scope 的请求必须由路由拒绝或转回 PageAgent。";
  } else if (fixedRoutes.length) {
    scope = { kind: "page-scoped", binding: "fixed", generalizable: false, scopeTokens, rationale: "探索依赖固定页面路径，未能证明可跨页面复用。" };
    status = "Narrowed";
    rationale = "固定页面上下文被显式标记，不能被抽象成任意站点任务。";
  } else {
    scope = { kind: "site-global", binding: "none", generalizable: true, rationale: "没有未参数化的站内固定路由依赖。" };
    status = "Generalized";
    rationale = "业务目标由公开输入驱动，未发现必须固定的页面/分类上下文。";
  }
  const entryPolicy: EntryPolicy = {
    kind: scope.kind === "category-scoped" ? "category" : scope.kind === "page-scoped" ? "page" : scope.kind === "site-global" ? "site-global" : "explicit-context",
    requiredInputPaths: scope.requiredInputPaths || [],
    scopeTokens,
    mismatch: scope.kind === "site-global" ? "page-agent" : scope.binding === "user-input" ? "clarify" : "no-match",
    rationale,
  };
  return { scope, decision: { status, scope, rationale, assumptions: scope.generalizable ? [] : ["观察到的页面路径不是可复用业务语义"], unresolvedDependencies: unresolved }, entryPolicy };
}

export function analyzeCapabilitySemanticsDetailed(input: SemanticAnalysisInput) {
  const ledger: DependencyLedgerEntry[] = [];
  const values = input.input || {};
  const parameterPaths = input.parameterPaths || Object.keys(values);
  for (const { path, value } of inputParameterEntries(values, parameterPaths)) {
    ledger.push(dependency(`input:${path}`, pathKind(path), "user-input", String(value), "Parameterize", "用户原话/任务输入是公开业务参数。", { parameterPath: path, required: true }));
  }
  collectProgramDependencies({ ...input, parameterPaths }, ledger);
  collectExperienceDependencies({ ...input, parameterPaths }, ledger);
  collectContextDependencies({ ...input, parameterPaths }, ledger);
  const observedDependencies = uniqueLedger(ledger);
  const { decision, entryPolicy } = scopeFromLedger({ ...input, parameterPaths }, observedDependencies);
  const dependencies = durableDependencies(observedDependencies);
  const semantic: CapabilitySemanticIR = {
    schemaVersion: "1.0",
    goal: input.goal.trim().slice(0, 500),
    effect: input.effect || "read",
    parameters: parameterPaths.map((path) => ({ path, role: semanticParameterRole(path), userSupplied: values[path] !== undefined, ...(values[path] !== undefined ? { example: values[path] } : {}) })),
    dependencies,
    scopeDecision: decision,
    entryPolicy,
    evidenceRefs: dependencies.flatMap((entry) => entry.evidenceRefs || []).slice(0, 50),
  };
  return { semantic, observedDependencies };
}

export function analyzeCapabilitySemantics(input: SemanticAnalysisInput): CapabilitySemanticIR {
  return analyzeCapabilitySemanticsDetailed(input).semantic;
}

/** Remove the internal dependency ledger before crossing the B/C boundary. */
export function withoutSemanticDependencies(semantic: CapabilitySemanticIR): CapabilitySemanticIR {
  const { dependencies: _dependencies, ...projected } = semantic;
  return projected;
}

/** Project the private analyzer scope into the small runtime scope contract. */
export function projectCapabilityScope(scope: LegacyCapabilityScope | undefined): CapabilityScope | undefined {
  if (!scope || scope.kind === "unknown") return undefined;
  const requiredInputPaths = scope.requiredInputPaths?.filter(Boolean);
  const tokens = scope.scopeTokens?.filter(Boolean);
  const urlPatterns = scope.observedPaths?.filter(Boolean);
  const match = {
    ...(requiredInputPaths?.length ? { requiredInputPaths } : {}),
    ...(tokens?.length ? { tokens } : {}),
    ...(urlPatterns?.length ? { urlPatterns } : {}),
  };
  return {
    kind: scope.kind,
    ...(Object.keys(match).length ? { match } : {}),
    onMismatch: scope.kind === "site-global"
      ? "page-agent"
      : scope.binding === "user-input"
        ? "clarify"
        : "no-match",
  };
}

/**
 * C1 uses semantic IR while authoring, then publishes only the resolved
 * Contract boundary. Historical semantic/ledger fields remain readable but
 * are not emitted by new candidates.
 */
export function projectCapabilityContract(contract: CapabilityContract): CapabilityContract {
  const legacy = contract as CapabilityContract & { semantic?: CapabilitySemanticIR; entryPolicy?: EntryPolicy; dependencyLedger?: DependencyLedgerEntry[] };
  const { semantic, dependencyLedger: _dependencyLedger, entryPolicy: _entryPolicy, ...projected } = legacy;
  const scope = projected.scope || projectCapabilityScope(semantic?.scopeDecision.scope);
  return {
    ...projected,
    ...(scope ? { scope } : {}),
  };
}

export function seedFromSemantic(
  semantic: CapabilitySemanticIR,
  text: { name: string; description: string; aliases?: string[]; intent: string },
): CapabilitySeed {
  return { schemaVersion: "1.0", name: text.name, description: text.description, aliases: text.aliases || [], intent: text.intent, semantic };
}

export function scopeMatchesRequest(
  scope: CapabilityScope | undefined,
  request: { goal?: string; input?: Record<string, JsonValue>; currentUrl?: string },
) {
  if (!scope || scope.kind === "site-global") return { matched: true as const, reason: "site-global" };
  const goal = normalize(request.goal || "");
  const input = request.input || {};
  // Same two shapes as the tokens below: the canonical scope nests these under
  // `match`, the analyzer's own output puts them at the top level. Reading only
  // the nested form skipped this check for every scope produced here, so a
  // capability that needs a category matched a request that supplied none.
  const requiredInputPaths = scope.match?.requiredInputPaths
    ?? (scope as { requiredInputPaths?: string[] }).requiredInputPaths
    ?? [];
  if (requiredInputPaths.some((path) => input[path] === undefined || input[path] === null || input[path] === "")) {
    return { matched: false as const, reason: "scope_input_missing" };
  }
  const tokensInRequest = tokens(`${request.goal || ""} ${Object.values(input).filter((value) => typeof value === "string").join(" ")}`);
  // A scope carries its tokens under `match.tokens`, and the analyzer's own
  // output carries them under the legacy `scopeTokens`. Reading only the first
  // meant a scope produced here had no tokens to compare, the mismatch check
  // below was skipped, and a capability fixed to one category matched every
  // request — tableware offered for a request about clothing. A matcher handed a
  // scope it does not recognise must not answer "matches".
  const declaredTokens = scope.match?.tokens
    ?? (scope as { scopeTokens?: string[] }).scopeTokens
    ?? [];
  const scopeTokens = declaredTokens.map(normalize).filter(Boolean);
  if (scopeTokens.length && !scopeTokens.some((token) => tokensInRequest.some((candidate) => candidate === token || candidate.includes(token) || token.includes(candidate)))) {
    return { matched: false as const, reason: "fixed_scope_mismatch" };
  }
  if (scope.kind === "page-scoped" && request.currentUrl) {
    const paths = scope.match?.urlPatterns || [];
    if (paths.length && !paths.some((path) => request.currentUrl?.includes(path))) return { matched: false as const, reason: "page_scope_mismatch" };
  }
  if (requiredInputPaths.length) return { matched: true as const, reason: "declared_scope_input" };
  return { matched: true as const, reason: goal ? "scope_evidence_match" : "scope_declared" };
}

export function scopeDecisionFor(input: SemanticAnalysisInput) {
  const semantic = analyzeCapabilitySemantics(input);
  return { scope: semantic.scopeDecision.scope, decision: semantic.scopeDecision, entryPolicy: semantic.entryPolicy, semantic };
}
