/**
 * Structured fields of the crawl summary: re-read verdict, pages new this crawl, first
 * appearance time.
 *
 * These numbers are the only source of the console status line and the "new" badge.
 * Data is asserted, not copy: the console renders copy in the current locale; this only
 * guarantees the data is right.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recrawlHint } from "../../../lib/site-knowledge/content-comparison.ts";
import { countNewScenes } from "../../../lib/site-knowledge/crawl-knowledge.ts";
import { discoverInitialKnowledge, mergeSceneEvidence } from "../../../lib/site-knowledge/discovery.ts";
import { sceneFromSnapshot } from "../../../lib/site-knowledge/url-scene.ts";
import { materialKnowledgeHash, stripVolatile } from "../../../lib/site-knowledge/knowledge-model.ts";

const HOUR = 3600_000;
const status = (url, observationsCompared, baselineIntervalMs = null) => ({ url, observationsCompared, baselineIntervalMs });

test("首次采集：阶段 first-crawl，还差一次的页面数等于本次读到的页面数，没有最短间隔", () => {
  const hint = recrawlHint([status("/a", 0), status("/b", 0)]);
  assert.equal(hint.stage, "first-crawl");
  assert.equal(hint.pagesNeedingMore, 2);
  assert.equal(hint.shortestIntervalMinutes, undefined);
  assert.ok(hint.message, "旧消费方仍要有那句中文");
});

test("部分页面只观测过一次：阶段 needs-one-more，数字是还差一次的页面数", () => {
  const hint = recrawlHint([status("/a", 2, 26 * HOUR), status("/b", 1), status("/c", 1)]);
  assert.equal(hint.stage, "needs-one-more");
  assert.equal(hint.pagesNeedingMore, 2);
});

test("全部页面观测够了但间隔短：阶段 ready，带最短间隔（分钟）", () => {
  const hint = recrawlHint([status("/a", 2, 90 * 60_000), status("/b", 3, 5 * HOUR)]);
  assert.equal(hint.stage, "ready");
  assert.equal(hint.pagesNeedingMore, 0);
  assert.equal(hint.shortestIntervalMinutes, 90);
});

test("全部页面观测够了且间隔超过一天：阶段 ready，不带最短间隔", () => {
  const hint = recrawlHint([status("/a", 2, 26 * HOUR), status("/b", 2, 48 * HOUR)]);
  assert.equal(hint.stage, "ready");
  assert.equal(hint.shortestIntervalMinutes, undefined);
});

const scene = (id) => ({ id, name: id, urlTemplates: [], parameters: [], verifier: {}, directEntry: "candidate", sourceObservationIds: [], updatedAt: "2026-01-01T00:00:00.000Z" });

test("没有上一版时，新增页面数等于本次页面总数", () => {
  assert.equal(countNewScenes([], [scene("a"), scene("b"), scene("c")]), 3);
});

test("上一版 36 类、本次 38 类且 36 类沿用标识：新增 2", () => {
  const previous = Array.from({ length: 36 }, (_, index) => scene(`s${index}`));
  const next = [...previous.map((item) => ({ ...item })), scene("new-1"), scene("new-2")];
  assert.equal(countNewScenes(previous, next), 2);
});

const now = "2026-03-01T10:00:00.000Z";
const later = "2026-03-02T10:00:00.000Z";
const snapshot = (url, capturedAt, links = []) => ({
  id: `snap-${url}-${capturedAt}`, sessionId: "b1", documentId: "d1", sequence: 0,
  url, title: "示例", heading: "示例", visibleText: "示例", links, capturedAt,
});

test("访客访问路径建出的页面带首次出现时间", () => {
  const created = sceneFromSnapshot(snapshot("https://shop.example/help", now));
  assert.equal(created.createdAt, now);
});

test("从链接里发现的候选页面也带首次出现时间", () => {
  const result = discoverInitialKnowledge(snapshot("https://shop.example/", now, [{ text: "帮助", url: "https://shop.example/help" }]));
  const help = result.scenes.find((item) => item.urlTemplates[0]?.pathnamePattern === "/help");
  assert.ok(help, "应发现 /help 候选");
  assert.equal(help.createdAt, now);
});

test("再次观测合并证据时保留最早的首次出现时间", () => {
  const first = sceneFromSnapshot(snapshot("https://shop.example/help", now));
  const again = sceneFromSnapshot(snapshot("https://shop.example/help", later));
  assert.equal(mergeSceneEvidence(first, again).createdAt, now);
  assert.equal(mergeSceneEvidence(again, first).createdAt, later, "以先存下来的那份为准");
});

test("旧知识库没有首次出现时间：合并后仍为空，不报错", () => {
  const legacy = { ...sceneFromSnapshot(snapshot("https://shop.example/help", now)), createdAt: undefined };
  const alsoLegacy = { ...sceneFromSnapshot(snapshot("https://shop.example/help", later)), createdAt: undefined };
  assert.equal(mergeSceneEvidence(legacy, alsoLegacy).createdAt, undefined);
});

test("首次出现时间不参与实质指纹", () => {
  const profile = { name: "示例商城", vocabulary: {}, suggestedGoals: [], businessDomains: [] };
  const withStamp = sceneFromSnapshot(snapshot("https://shop.example/help", now));
  const without = { ...withStamp, createdAt: undefined };
  assert.equal(
    materialKnowledgeHash({ profile, scenes: [withStamp], links: [] }),
    materialKnowledgeHash({ profile, scenes: [without], links: [] }),
  );
  assert.equal("createdAt" in stripVolatile({ createdAt: now, name: "x" }), false);
});
