/**
 * Contract of the site knowledge page's derivation layer: each scenario in the
 * console/site-knowledge-view spec maps here. Data only, no copy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { areaSummaries, knowledgeStatus, newPageIds, nodeForUrl, pathMatcher, probeVerdict, readState, updateHistory } from "../../../lib/console/knowledge-view.ts";

const T = (offsetMinutes) => new Date(Date.UTC(2026, 2, 1, 12, 0, 0) + offsetMinutes * 60_000).toISOString();
const NOW = Date.parse(T(0));
const job = (status, createdMinutes, overrides = {}) => ({
  id: `job-${createdMinutes}`, siteAgentId: "shop", status, origin: "https://shop.example", seeds: [], attempts: 1,
  createdAt: T(createdMinutes), updatedAt: T(createdMinutes + 5), ...overrides,
});
const done = (createdMinutes, result = {}, overrides = {}) => job("succeeded", createdMinutes, { result: { scenes: 38, links: 90, pagesRendered: 120, ...result }, ...overrides });

// ---- 2.1 Status line ----
test("从没读过：没有页面也没有任务", () => {
  assert.deepEqual(knowledgeStatus({ pages: 0, jobs: [], now: NOW }), { kind: "never" });
});
test("正在读：有排队/进行中的任务，已用时长按秒算，且压过更早的失败", () => {
  const status = knowledgeStatus({ pages: 38, jobs: [job("failed", -600), job("running", -2)], now: NOW });
  assert.equal(status.kind, "reading");
  assert.equal(status.elapsedSeconds, 120);
});
test("首次接入自动排的任务与手动排的表现一致：状态行、失败、读完都不看 trigger", () => {
  // The crawl the server schedules on first handshake carries trigger: "auto"; the derivation layer does not distinguish it.
  const manual = knowledgeStatus({ pages: 38, jobs: [job("queued", -2)], now: NOW });
  const auto = knowledgeStatus({ pages: 38, jobs: [job("queued", -2, { trigger: "auto" })], now: NOW });
  assert.deepEqual(auto, manual);
  assert.deepEqual(
    knowledgeStatus({ pages: 38, jobs: [job("failed", -30, { error: "timeout", trigger: "auto" })], now: NOW }),
    knowledgeStatus({ pages: 38, jobs: [job("failed", -30, { error: "timeout", trigger: "manual" })], now: NOW }),
  );
  assert.deepEqual(
    knowledgeStatus({ pages: 38, jobs: [done(-30, {}, { trigger: "auto" })], now: NOW }),
    knowledgeStatus({ pages: 38, jobs: [done(-30, {}, { trigger: "manual" })], now: NOW }),
  );
});
test("读完但为空：成功结束但一页都没读到", () => {
  const status = knowledgeStatus({ pages: 0, jobs: [done(-30, { scenes: 0, pagesRendered: 0 })], now: NOW });
  assert.equal(status.kind, "empty");
});
test("失败：最近一次任务失败，带原因", () => {
  const status = knowledgeStatus({ pages: 38, jobs: [done(-600), job("failed", -30, { error: "timeout" })], now: NOW });
  assert.deepEqual(status, { kind: "failed", finishedAt: T(-25), reason: "timeout" });
});
test("第一次读完：阶段 first-crawl", () => {
  const status = knowledgeStatus({ pages: 38, jobs: [done(-30, { contentFilter: { indexed: 1, skipped: 0, purgedPages: 0, recrawlStage: "first-crawl" } })], now: NOW });
  assert.equal(status.kind, "first-read");
  assert.equal(status.pages, 38);
});
test("还差一次：阶段 needs-one-more，带页面数", () => {
  const status = knowledgeStatus({ pages: 38, jobs: [done(-30, { contentFilter: { indexed: 1, skipped: 0, purgedPages: 0, recrawlStage: "needs-one-more", recrawlPagesNeedingMore: 7 } })], now: NOW });
  assert.equal(status.kind, "needs-one-more");
  assert.equal(status.pagesNeedingMore, 7);
});
test("间隔太短：阶段 ready、给了最短间隔、距上次读取不足该间隔", () => {
  const status = knowledgeStatus({ pages: 38, jobs: [done(-45, { contentFilter: { indexed: 1, skipped: 0, purgedPages: 0, recrawlStage: "ready", recrawlShortestIntervalMinutes: 120 } })], now: NOW });
  assert.equal(status.kind, "interval-too-short");
  assert.equal(status.intervalMinutes, 120);
});
test("平时：间隔已过、或阶段 ready 没给间隔、或旧任务没有结构化摘要", () => {
  const passed = knowledgeStatus({ pages: 38, jobs: [done(-300, { contentFilter: { indexed: 1, skipped: 0, purgedPages: 0, recrawlStage: "ready", recrawlShortestIntervalMinutes: 120 } })], now: NOW });
  assert.equal(passed.kind, "steady");
  const noInterval = knowledgeStatus({ pages: 38, jobs: [done(-30, { contentFilter: { indexed: 1, skipped: 0, purgedPages: 0, recrawlStage: "ready" } })], now: NOW });
  assert.equal(noInterval.kind, "steady");
  const legacy = knowledgeStatus({ pages: 38, jobs: [done(-30, { contentFilter: { indexed: 1, skipped: 0, purgedPages: 0, recrawlHint: "第一次采集…" } })], now: NOW });
  assert.equal(legacy.kind, "steady");
  assert.equal(legacy.newScenes, undefined);
});
test("读完后报告新增：newScenes 大于零才带上", () => {
  assert.equal(knowledgeStatus({ pages: 38, jobs: [done(-30, { newScenes: 2 })], now: NOW }).newScenes, 2);
  assert.equal(knowledgeStatus({ pages: 38, jobs: [done(-30, { newScenes: 0 })], now: NOW }).newScenes, undefined);
});

test("时钟未就绪（now 为 0）：不做间隔判断，时长记 0", () => {
  const jobs = [done(-45, { contentFilter: { indexed: 1, skipped: 0, purgedPages: 0, recrawlStage: "ready", recrawlShortestIntervalMinutes: 120 } })];
  assert.equal(knowledgeStatus({ pages: 38, jobs, now: 0 }).kind, "steady");
  assert.equal(knowledgeStatus({ pages: 38, jobs: [job("running", -2)], now: 0 }).elapsedSeconds, 0);
});

// ---- 2.2 Three states and section summary ----
const node = (id, overrides = {}) => ({ id, sceneId: id, name: id, path: `/${id}`, areaId: "a", parameters: [], evidenceStatus: "crawled", lifecycle: "crawled", semanticSource: "program", directEntry: "candidate", identityConfidence: 0.7, evidenceCount: 1, ...overrides });
const coverage = (emptyIds) => ({ indexedPages: 0, totalChunks: 0, totalChars: 0, scenesTotal: 0, emptyPages: emptyIds.map((id) => ({ sceneId: id, name: id, path: `/${id}` })) });

test("已收录正文且入口没坏：已收录", () => {
  assert.deepEqual(readState(node("p"), coverage([])), { state: "read", reason: "read" });
});
test("只在链接里见过：只见过链接（原因 referenced）", () => {
  assert.deepEqual(readState(node("p", { evidenceStatus: "referenced" }), coverage(["p"])), { state: "seen", reason: "referenced" });
});
test("打开过但没有正文：只见过链接（原因 no-content）", () => {
  assert.deepEqual(readState(node("p"), coverage(["p"])), { state: "seen", reason: "no-content" });
});
test("入口失败或待复验：打不开，且压过其它判定", () => {
  assert.deepEqual(readState(node("p", { directEntry: "failed" }), coverage([])), { state: "blocked", reason: "failed" });
  assert.deepEqual(readState(node("p", { directEntry: "needs-reverify", evidenceStatus: "referenced" }), coverage(["p"])), { state: "blocked", reason: "needs-reverify" });
});
test("没有覆盖数据时退回按证据状态", () => {
  assert.equal(readState(node("p"), undefined).state, "read");
  assert.equal(readState(node("p", { evidenceStatus: "referenced" }), undefined).state, "seen");
});
test("板块汇总：6 类页面、4 类已收录、1 类打不开 → 4/6 带警示", () => {
  const nodes = [node("a1"), node("a2"), node("a3"), node("a4"), node("a5", { evidenceStatus: "referenced" }), node("a6", { directEntry: "failed" })];
  const [summary] = areaSummaries({ areas: [{ id: "a", name: "商品", nodeIds: nodes.map((n) => n.id), source: "ai", confidence: 0.8 }], nodes }, coverage(["a5"]), new Set(["a2"]));
  assert.equal(summary.read, 4); assert.equal(summary.total, 6); assert.equal(summary.warn, true); assert.equal(summary.isNew, true);
});

// ---- 2.3 "New" ----
test("读取新增了页面：晚于最近一次成功读取开始时间的才是新", () => {
  const jobs = [done(-1440), done(-60)];
  const nodes = [node("old1", { createdAt: T(-1400) }), node("old2", { createdAt: T(-1300) }), node("new1", { createdAt: T(-58) }), node("new2", { createdAt: T(-57) }), node("legacy")];
  assert.deepEqual([...newPageIds(nodes, jobs)].sort(), ["new1", "new2"]);
});
test("访客访问中学到的页面：晚于最近一次读取，同样是新", () => {
  const nodes = [node("old", { createdAt: T(-1400) }), node("visit", { createdAt: T(-10) })];
  assert.deepEqual([...newPageIds(nodes, [done(-1440), done(-60)])], ["visit"]);
});
test("只读过一次：所有页面都晚于开始时间，整体不标", () => {
  const nodes = [node("a", { createdAt: T(-58) }), node("b", { createdAt: T(-57) })];
  assert.equal(newPageIds(nodes, [done(-60)]).size, 0);
  assert.equal(newPageIds(nodes, []).size, 0);
});

// ---- 2.4 Ask ----
const route = (sceneId, overrides = {}) => ({ sceneId, name: sceneId, urlTemplate: `/${sceneId}`, ...overrides });
const hit = (url, texts, headingPath) => ({ url, headingPath, context: (Array.isArray(texts) ? texts : [texts]).filter(Boolean).map((text) => ({ text, headingPath })) });
// Page name normalization: different URLs of one page (with or without query) collapse into one page
const NODES = {
  "https://shop.example/products.html": { id: "s-list", name: "商品分类列表" },
  "https://shop.example/products.html?category=%E5%AE%B6%E5%B1%85": { id: "s-list", name: "商品分类列表" },
  "https://shop.example/products/n-2008": { id: "s-detail", name: "商品详情" },
};
const resolve = (url) => NODES[url];

test("网站原话直接给出来，并列出它出现在哪几页", () => {
  const verdict = probeVerdict({
    pages: [hit("https://shop.example/products.html", "手工编织，防滑底衬，耐踩不易变形。", "全部商品"), hit("https://shop.example/products/n-2008", "手工编织，防滑底衬，耐踩不易变形。", "Warm 羊毛毯")],
    routes: [],
  }, resolve);
  assert.deepEqual(verdict.quotes, [{ text: "手工编织，防滑底衬，耐踩不易变形。", pages: ["商品分类列表", "商品详情"] }]);
});

test("命中什么就显示什么：短片段与面包屑同样保留，用户自己判断", () => {
  const verdict = probeVerdict({
    pages: [hit("https://shop.example/products/n-2008", ["首页 / 全部商品 / Warm 羊毛毯", "Warm 羊毛毯"], "Warm 羊毛毯"), hit("https://shop.example/products.html", "Warm 羊毛毯", "全部商品")],
    routes: [route("s-detail", { name: "商品详情", directEntry: "verified" })],
  }, resolve);
  assert.deepEqual(verdict.quotes, [
    { text: "首页 / 全部商品 / Warm 羊毛毯", pages: ["商品详情"] },
    { text: "Warm 羊毛毯", pages: ["商品详情", "商品分类列表"] },
  ]);
});

test("空白文本不算一条原话", () => {
  assert.deepEqual(probeVerdict({ pages: [hit("https://shop.example/a", ["", "   "])], routes: [] }).quotes, []);
});

test("同一页面的多个网址收敛成一个页面，不重复出现", () => {
  const verdict = probeVerdict({
    pages: [hit("https://shop.example/products.html", "手工编织。"), hit("https://shop.example/products.html?category=%E5%AE%B6%E5%B1%85", "手工编织。")],
    routes: [],
  }, resolve);
  assert.deepEqual(verdict.pages, [{ name: "商品分类列表", sceneId: "s-list" }]);
  assert.deepEqual(verdict.quotes[0].pages, ["商品分类列表"]);
});

test("不同的原话各留一条，最多三条", () => {
  const pages = Array.from({ length: 5 }, (_, index) => hit(`https://shop.example/p${index}`, `第 ${index} 句原话。`));
  assert.equal(probeVerdict({ pages, routes: [] }).quotes.length, 3);
});

test("不再给「会带用户去」：场景命中并进相关页面，不当成导航目标", () => {
  const verdict = probeVerdict({
    pages: [],
    routes: [route("s-home", { name: "商城首页", directEntry: "verified" }), route("s-list", { name: "商品分类列表", directEntry: "verified" })],
  }, resolve);
  assert.equal("jumpPage" in verdict, false);
  assert.deepEqual(verdict.pages.map((page) => page.name), ["商城首页", "商品分类列表"]);
});

test("正文命中的页面排在场景命中之前，同名只留一条并保留 sceneId", () => {
  const verdict = probeVerdict({
    pages: [hit("https://shop.example/products/n-2008", "手工编织。")],
    routes: [route("s-home", { name: "商城首页", directEntry: "verified" }), route("s-detail", { name: "商品详情", directEntry: "verified" })],
  }, resolve);
  assert.deepEqual(verdict.pages, [{ name: "商品详情", sceneId: "s-detail" }, { name: "商城首页", sceneId: "s-home" }]);
});

test("未验证与打不开的页面同样进相关页面，可点", () => {
  const verdict = probeVerdict({ pages: [], routes: [route("member", { name: "会员中心", evidenceStatus: "referenced" }), route("member", { name: "会员中心", evidenceStatus: "referenced" }), route("vip", { name: "会员权益", directEntry: "failed" })] });
  assert.deepEqual(verdict.pages, [{ name: "会员中心", sceneId: "member" }, { name: "会员权益", sceneId: "vip" }]);
});

test("完全没有相关内容 / 正文里有词但没检索到", () => {
  const nothing = probeVerdict({ pages: [], routes: [], coverageOfQuery: { appears: false, sampleUrls: [] } });
  assert.deepEqual(nothing, { quotes: [], pages: [], termsAppearElsewhere: false });
  assert.equal(probeVerdict({ pages: [], routes: [], coverageOfQuery: { appears: true, sampleUrls: ["https://shop.example/x"] } }).termsAppearElsewhere, true);
});

test("没有 resolve 时退回标题、再退回路径", () => {
  const verdict = probeVerdict({ pages: [hit("https://shop.example/a", "甲。", "标题甲"), hit("https://shop.example/b", "乙。")], routes: [] });
  assert.deepEqual(verdict.pages.map((page) => page.name), ["标题甲", "/b"]);
});

test("用网址找回页面：精确路径优先，带参数的模式其次", () => {
  const nodes = [node("home", { path: "/" }), node("product", { path: "/products/{id}" }), node("list", { path: "/products" })];
  assert.equal(nodeForUrl(nodes, "https://shop.example/products").id, "list");
  assert.equal(nodeForUrl(nodes, "https://shop.example/products/42").id, "product");
  assert.equal(pathMatcher("/a.b/{x}").test("/a.b/1"), true);
  assert.equal(pathMatcher("/a.b/{x}").test("/aXb/1"), false);
});

// ---- 2.5 Update log ----
test("更新记录：只有成功的，最新在前，清掉处数来自 changingLines，缺失为 0", () => {
  const jobs = [job("failed", -500), done(-1440, { contentFilter: { indexed: 1, skipped: 0, purgedPages: 0, removed: { shapeChars: 1, dataPages: 0, changingLines: 3, keptChars: 9 } } }), done(-60)];
  assert.deepEqual(updateHistory(jobs), [{ at: T(-55), pages: 38, purged: 0 }, { at: T(-1435), pages: 38, purged: 3 }]);
  assert.deepEqual(updateHistory([job("failed", -1)]), []);
});
