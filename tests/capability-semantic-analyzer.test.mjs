import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({
  stdin: {
    contents: `
      export { analyzeCapabilitySemantics, analyzeCapabilitySemanticsDetailed, scopeMatchesRequest } from "./lib/capability-center-v2/semantic-analyzer";
      export { executionRequirementForGoal } from "./lib/site-knowledge/execution-requirement";
      export { deriveGoalSemanticFrame, semanticFrameEffect } from "./lib/site-knowledge/goal-semantics";
    `,
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    sourcefile: "capability-semantic-analyzer-test.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const {
  analyzeCapabilitySemantics,
  analyzeCapabilitySemanticsDetailed,
  scopeMatchesRequest,
  executionRequirementForGoal,
  deriveGoalSemanticFrame,
  semanticFrameEffect,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("semantic analyzer separates user inputs from an incidental fixed category route", () => {
  const semantic = analyzeCapabilitySemantics({
    goal: "把某个商品加入购物车",
    effect: "reversible-write",
    startUrl: "http://shop.test/3-tableware",
    input: { query: "马克杯" },
    parameterPaths: ["query"],
    pageTexts: ["餐具"],
    steps: [{ id: "navigate", action: "navigate", value: { source: "literal", value: "http://shop.test/3-tableware" } }],
  });
  assert.equal(semantic.scopeDecision.status, "Narrowed");
  assert.equal(semantic.scopeDecision.scope.kind, "category-scoped");
  assert.equal(semantic.scopeDecision.scope.binding, "fixed");
  assert.equal(scopeMatchesRequest(semantic.scopeDecision.scope, { goal: "找一件衣服加入购物车" }).matched, false);
  assert.equal(scopeMatchesRequest(semantic.scopeDecision.scope, { goal: "在餐具分类找马克杯" }).matched, true);
});

test("declared category input remains category-scoped and reusable", () => {
  const semantic = analyzeCapabilitySemantics({
    goal: "在指定分类搜索商品",
    startUrl: "http://shop.test/3-{{category}}",
    input: { category: "餐具", query: "马克杯" },
    parameterPaths: ["category", "query"],
    steps: [{ id: "navigate", action: "navigate", value: { source: "literal", value: "http://shop.test/3-{{category}}" } }],
  });
  assert.equal(semantic.scopeDecision.status, "Generalized");
  assert.equal(semantic.scopeDecision.scope.binding, "user-input");
  assert.deepEqual(semantic.entryPolicy.requiredInputPaths, ["category"]);
  assert.equal(scopeMatchesRequest(semantic.scopeDecision.scope, { goal: "搜索", input: { category: "服装", query: "衣服" } }).matched, true);
  assert.equal(scopeMatchesRequest(semantic.scopeDecision.scope, { goal: "搜索", input: { query: "衣服" } }).matched, false);
});

test("unstable DOM position is rejected before Validation", () => {
  const semantic = analyzeCapabilitySemantics({
    goal: "查看商品详情",
    input: { query: "杯子" },
    parameterPaths: ["query"],
    steps: [{ id: "click", action: "click", target: { strategies: [{ type: "css", value: ".product:nth-child(1)" }] } }],
  });
  assert.equal(semantic.scopeDecision.status, "Rejected");
  assert.ok(semantic.dependencies.some((entry) => entry.action === "Reject" && entry.kind === "dom-position"));
});

test("tenant, locale, role and date are explicit dependencies rather than hidden defaults", () => {
  const semantic = analyzeCapabilitySemantics({
    goal: "查询报表",
    input: { tenant: "acme", locale: "zh-CN", role: "admin", date: "2026-08-15" },
    parameterPaths: ["tenant", "locale", "role", "date"],
  });
  const kinds = new Set(semantic.dependencies.map((entry) => entry.kind));
  assert.deepEqual([...kinds].sort(), ["date", "locale", "role", "tenant"]);
  assert.ok(semantic.dependencies.every((entry) => entry.action === "Parameterize"));
});

test("site-global scope does not require a category token", () => {
  const semantic = analyzeCapabilitySemantics({ goal: "查看站点地图", input: {}, parameterPaths: [], startUrl: "http://shop.test/" });
  assert.equal(semantic.scopeDecision.scope.kind, "site-global");
  assert.equal(scopeMatchesRequest(semantic.scopeDecision.scope, { goal: "打开网站地图" }).matched, true);
});

test("global search entry does not leak the site's home path into scope", () => {
  const { semantic, observedDependencies } = analyzeCapabilitySemanticsDetailed({
    goal: "搜索商品",
    startUrl: "http://shop.test/demo",
    input: { keyword: "Echo 桌面音箱" },
    parameterPaths: ["keyword"],
    steps: [{
      id: "fill-search",
      action: "fill",
      target: { strategies: [{ type: "css", value: "input[name=\"q\"]" }] },
      value: { source: "input", path: "keyword" },
    }],
  });
  assert.equal(semantic.scopeDecision.scope.kind, "site-global");
  assert.equal(semantic.scopeDecision.status, "Generalized");
  assert.equal(semantic.dependencies.find((entry) => entry.id === "start-url"), undefined);
  assert.equal(observedDependencies.find((entry) => entry.id === "start-url")?.action, "Derive");
  assert.deepEqual(semantic.scopeDecision.unresolvedDependencies, []);
});

test("site shell entry is not treated as business scope for navigation capabilities", () => {
  const { semantic, observedDependencies } = analyzeCapabilitySemanticsDetailed({
    goal: "打开商品搜索页",
    startUrl: "http://shop.test/demo",
    steps: [{
      id: "open-search",
      action: "click",
      target: { strategies: [{ type: "role", role: "link", name: "浏览全部商品" }] },
    }],
  });
  assert.equal(semantic.scopeDecision.scope.kind, "site-global");
  assert.equal(semantic.dependencies.find((entry) => entry.id === "start-url"), undefined);
  assert.equal(observedDependencies.find((entry) => entry.id === "start-url")?.action, "Derive");
  assert.deepEqual(semantic.scopeDecision.unresolvedDependencies, []);
});

test("natural cart wording still grants reversible page-action authority", () => {
  for (const goal of ["给我找一个棕色的垫子放购物车里", "把白色马克杯加进购物袋", "put the mug in the cart"]) {
    const requirement = executionRequirementForGoal(goal);
    assert.equal(requirement.kind, "required", goal);
    assert.equal(requirement.effect, "reversible-write", goal);
    assert.equal(requirement.evidence, "business-receipt", goal);
  }
});

test("notebook search plus add-to-cart is not misclassified by the word book", () => {
  const requirement = executionRequirementForGoal("帮我搜索一个notebook并加入购物车");
  assert.equal(requirement.kind, "required");
  assert.equal(requirement.effect, "reversible-write");
  assert.equal(requirement.evidence, "business-receipt");
});

test("goal semantics separates the business atoms from one-by-one page actions", () => {
  const frame = deriveGoalSemanticFrame("帮我搜索一个notebook并加入购物车");
  assert.equal(frame.mode, "execute");
  assert.deepEqual(frame.actions.map((action) => action.predicate), ["search", "add-to-cart"]);
  assert.equal(frame.actions[0].effect, "read");
  assert.equal(frame.actions[1].effect, "reversible-write");
  assert.deepEqual(frame.actions[1].dependencies, ["goal-action-1"]);
  assert.equal(semanticFrameEffect(frame), "reversible-write");
  assert.equal(deriveGoalSemanticFrame("how can I buy a book?").mode, "inform");
  assert.equal(deriveGoalSemanticFrame("book a hotel").actions[0].predicate, "reserve");
  assert.equal(deriveGoalSemanticFrame("search for a notebook").actions[0].predicate, "search");
});
