import assert from "node:assert/strict";
import test from "node:test";
import { compileVerifiedEntryCapability } from "../lib/site-knowledge/verified-entry-compiler.ts";

test("verified entry compiler binds semantic inputs without embedding sample values", () => {
  const source = compileVerifiedEntryCapability({
    scenes: [{
      id: "scene_search",
      name: "关键词搜索",
      description: "按关键词搜索历史记录",
      directEntry: "verified",
      urlTemplates: [{ id: "url_search", originPattern: "https://example.test", pathnamePattern: "/search", query: { q: "{q?}" } }],
      parameters: [{ id: "q", name: "搜索关键词", type: "string", required: false }],
    }],
    capability: {
      id: "cap_search",
      kind: "task",
      name: "搜索历史记录",
      description: "按用户提供的关键词搜索历史记录",
      inputs: { type: "object", properties: { keyword: { type: "string", description: "搜索关键词" } }, required: ["keyword"] },
      outputs: { type: "object", properties: { items: { type: "array" } }, required: ["items"] },
      aliases: [],
      outcomes: [],
      plans: [],
      sourceEpisodeIds: [],
      confidence: 1,
      status: "learning",
      updatedAt: new Date().toISOString(),
    },
    targets: [],
    operations: [],
    sourceEpisodeIds: [],
    status: "learning",
    baseReleaseVersion: 1,
    id: "candidate",
    siteAgentId: "site",
    normalizedGoal: "搜索许嵩",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  assert.match(source, /"inputId":"keyword"/);
  assert.match(source, /searchParams\.set/);
  assert.doesNotMatch(source, /许嵩/);
  assert.match(source, /items/);
});
