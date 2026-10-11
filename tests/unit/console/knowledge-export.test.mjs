import { test } from "node:test";
import assert from "node:assert/strict";
import { knowledgeExportAvailable, knowledgeFileName, serializeKnowledge } from "../../../lib/console/knowledge-export.ts";

test("文件名含站点标识与版本号", () => {
  assert.equal(knowledgeFileName("shop", 12), "shop-knowledge-v12.json");
});
test("没有独立 JSON 时不可用", () => {
  assert.equal(knowledgeExportAvailable(undefined), false);
  assert.equal(knowledgeExportAvailable({ schemaVersion: "site-knowledge/v1", siteAgentId: "shop", version: 1, contentHash: "x", updatedAt: "", profile: {}, scenes: [], links: [] }), true);
});
test("导出的是整份知识库，包含画像、页面与链接", () => {
  const parsed = JSON.parse(serializeKnowledge({ schemaVersion: "site-knowledge/v1", siteAgentId: "shop", version: 1, contentHash: "x", updatedAt: "", profile: { name: "示例" }, scenes: [{ id: "a" }], links: [{ id: "l" }] }));
  assert.deepEqual(Object.keys(parsed).sort(), ["contentHash", "links", "profile", "scenes", "schemaVersion", "siteAgentId", "updatedAt", "version"]);
});
