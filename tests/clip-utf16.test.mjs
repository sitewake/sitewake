/**
 * Truncation must not split a character in half.
 *
 * Production incident: an episode's element text was cut by `slice(0, 300)` right
 * inside an emoji, leaving a lone high surrogate. Harmless in JS, JSON.stringify still
 * emits `\ud83d`, and it only blew up in Postgres with `invalid input syntax for type
 * json` — the whole agent overview page returned 500.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const result = await build({
  entryPoints: [fileURLToPath(new URL("../lib/site-knowledge/protocol.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false,
});
const { clipUtf16 } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

const LONE_HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
const LONE_LOW = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test("切在 emoji 中间时把半个字符一起去掉", () => {
  const text = "无锡暴雨🌤️晴";            // 🌤 占两个码元
  const at = text.indexOf("🌤") + 1;          // 正好切在代理对中间
  const cut = clipUtf16(text, at);
  assert.ok(!LONE_HIGH.test(cut), `截断结果不得含孤立高位代理，实测 ${JSON.stringify(cut)}`);
  assert.equal(cut, "无锡暴雨");
});

test("切在字符边界上不受影响", () => {
  assert.equal(clipUtf16("无锡暴雨🌤️晴", 4), "无锡暴雨");
  assert.equal(clipUtf16("abcdef", 3), "abc");
});

test("不超长时原样返回", () => {
  assert.equal(clipUtf16("热搜时光机🌤️", 100), "热搜时光机🌤️");
});

test("清理上游已经切坏的输入", () => {
  // The browser side of crawl-render cuts first; the Node side must still clean up a leftover half character
  const broken = `无锡暴雨${"🌤".charAt(0)}`;
  assert.ok(LONE_HIGH.test(broken), "样本本身应含孤立高位代理");
  assert.ok(!LONE_HIGH.test(clipUtf16(broken, 20_000)), "即使没到上限也要清掉残留");
});

test("空值与边界", () => {
  assert.equal(clipUtf16(undefined, 10), "");
  assert.equal(clipUtf16(null, 10), "");
  assert.equal(clipUtf16("", 10), "");
});

test("整段文本经截断后可以安全写入 JSON", () => {
  const text = "热搜：世界杯决赛🤯地铁站也能办结婚证了😟无锡暴雨🌤️".repeat(20);
  for (let max = 1; max <= 60; max += 1) {
    const cut = clipUtf16(text, max);
    assert.ok(!LONE_HIGH.test(cut) && !LONE_LOW.test(cut), `max=${max} 产生了孤立代理：${JSON.stringify(cut)}`);
    JSON.parse(JSON.stringify({ v: cut }));
  }
});
