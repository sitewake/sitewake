/**
 * Tolerant extraction of keyword expansion.
 *
 * Production failure: the UI's "search terms" equaled the user's question verbatim with
 * 0 pages hit, as if expansion had not run. The model had expanded correctly (青少年 /
 * 未成年 / 儿童 / 学生), but the output shape was hinted by **a schema field stuffed into
 * the input**, and the model echoed the input shape as
 *   {"question":"…","schema":{"keywords":[…]}}
 * No top-level keywords → judged not expanded → silent fallback to literal sentence search.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const result = await build({
  entryPoints: [fileURLToPath(new URL("../lib/site-knowledge/model-analyzer.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false,
});
const { keywordsFromModelResult } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

test("顶层 keywords 正常取出", () => {
  assert.deepEqual(keywordsFromModelResult({ keywords: ["青少年", "未成年"] }), ["青少年", "未成年"]);
});

test("模型把入参形状原样回填时仍能取到——生产实测的返回", () => {
  const echoed = { question: "青少年可以使用本网站吗", schema: { keywords: ["青少年", "未成年", "儿童", "学生"] } };
  assert.deepEqual(keywordsFromModelResult(echoed), ["青少年", "未成年", "儿童", "学生"],
    "关键词其实扩对了，只是嵌了一层——不该因为形状偏差就整个丢掉，退回整句字面检索");
});

test("去掉空白项并截到 6 个", () => {
  assert.deepEqual(keywordsFromModelResult({ keywords: ["  甲 ", "", "  ", "乙"] }), ["甲", "乙"]);
  assert.equal(keywordsFromModelResult({ keywords: ["1", "2", "3", "4", "5", "6", "7", "8"] }).length, 6);
});

test("确实没有关键词时返回空，交给调用方回落", () => {
  assert.deepEqual(keywordsFromModelResult(undefined), []);
  assert.deepEqual(keywordsFromModelResult({}), []);
  assert.deepEqual(keywordsFromModelResult({ keywords: "不是数组" }), []);
  assert.deepEqual(keywordsFromModelResult({ answer: { text: "无关" } }), []);
});
