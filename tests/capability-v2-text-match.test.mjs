import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilityTextIncludes,
  normalizeCapabilityText,
} from "../lib/capability-center-v2/text-match.ts";

test("capability contract text matching ignores harmless display normalization", () => {
  assert.equal(capabilityTextIncludes("“Echo 桌面音箱”的搜索结果", '"Echo 桌面音箱"的搜索结果'), true);
  assert.equal(capabilityTextIncludes("订单提交成功 — 请稍候", "订单提交成功 - 请稍候"), true);
  assert.equal(capabilityTextIncludes("“arc”的搜索结果", "“Arc”的搜索结果"), true);
  assert.equal(capabilityTextIncludes("找到\n  ＡＲＣ  商品", "找到 arc 商品"), true);
  assert.equal(capabilityTextIncludes("订单\u200B提交成功", "订单提交成功"), true);
});

test("capability contract text matching remains structurally strict", () => {
  assert.equal(capabilityTextIncludes("“arc”的搜索结果", "“echo”的搜索结果"), false);
  assert.equal(capabilityTextIncludes("任意页面", ""), false);
  assert.equal(normalizeCapabilityText("  Ａrc\n商品  "), "arc 商品");
});
