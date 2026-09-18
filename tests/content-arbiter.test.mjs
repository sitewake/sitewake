/**
 * Orchestration tests for gray-zone arbitration and the page-level fallback.
 *
 * The model is injected and every case uses a fake — so this tests the orchestration's
 * deterministic behavior: call counts, URL-class reuse, degradation on cap and failure,
 * and the inviolable rule that the model only picks indices and text always comes from
 * the original.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

async function loadModule(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { createArbiterSession } = await loadModule("../lib/site-knowledge/content-arbiter.ts");

/** Builds a block. Defaults describe a body paragraph passing with zero votes. */
function block(id, text, overrides = {}) {
  const lines = text.split("\n").filter(Boolean);
  return {
    id,
    tag: "p",
    region: "main",
    structural: false,
    text,
    textLen: text.length,
    linkTextLen: 0,
    lineCount: lines.length,
    avgLineLen: Math.round(lines.reduce((sum, line) => sum + line.length, 0) / Math.max(1, lines.length)),
    childCount: 0,
    distinctChildShapes: 0,
    timestampHits: 0,
    punctHits: (text.match(/[，。；？！：、,;?!:]/g) || []).length,
    ...overrides,
  };
}

const PROSE = "在实际选型中，多数团队会按业务场景混合使用：账务类操作走强一致路径，而浏览与推荐类的读多写少场景则容忍最终一致。";
/** A sidebar link-only list: two votes (region + link density), definitely dropped. */
const widget = (id) => block(id, "热搜一\n热搜二\n热搜三\n热搜四", {
  tag: "ul", region: "aside", linkTextLen: 16, childCount: 4, distinctChildShapes: 1, punctHits: 0,
});
/** A one-vote block: link-only but in the main area, too few items. The shape layer cannot decide; always kept. */
const gray = (id) => block(id, "前一天后一天", { tag: "div", linkTextLen: 6, punctHits: 0 });



test("保底: 整页快被滤空时把被丢块交给模型挑，按编号从原文恢复", async () => {
  // After tightening, one-vote blocks are always kept and a page is no longer easily
  // filtered empty. To trigger the fallback, blocks need two full votes — here "sidebar
  // + link-only list" (region + link density), but one of them is actually valuable and
  // the model rescues it.
  const rescued = block(2, PROSE, {
    tag: "ul", region: "aside", linkTextLen: PROSE.length, childCount: 4, distinctChildShapes: 1,
  });
  const session = createArbiterSession({ judge: async (request) => (request.kind === "fallback" ? [2] : []) });
  const { mainText, report } = await session.resolve("https://s.test/a", [widget(1), rescued]);
  assert.ok(mainText.includes(PROSE), "被模型挑中的块应逐字恢复");
  assert.equal(report.fallbackTriggered, true);
  assert.equal(report.fallbackPath, "llm");
});

test("保底: 一个都没挑 → 无正文内容页，不写内容库", async () => {
  const session = createArbiterSession({ judge: async () => [] });
  const { mainText, report } = await session.resolve("https://s.test/daily/2026-08-11", [widget(1), widget(2)]);
  assert.equal(mainText, "");
  assert.equal(report.emptyContentPage, true);
  assert.equal(report.fallbackTriggered, true);
});

test("保底: 模型返回伪造编号时被忽略，正文绝不含模型生成内容", async () => {
  const session = createArbiterSession({ judge: async () => [999, 1000] });
  const { mainText, report } = await session.resolve("https://s.test/a", [widget(1), widget(2)]);
  assert.equal(mainText, "", "不存在的编号必须被忽略");
  assert.equal(report.emptyContentPage, true);
});

test("同类网址: 只问一次，其余页面复用结论", async () => {
  let calls = 0;
  const session = createArbiterSession({ judge: async () => { calls += 1; return []; } });
  for (const day of ["2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14"]) {
    const { report } = await session.resolve(`https://s.test/daily/${day}`, [widget(1), widget(2)]);
    assert.equal(report.emptyContentPage, true);
  }
  assert.equal(calls, 1, `同类网址只该问一次，实际 ${calls} 次`);
});

test("上限: 超出调用总量后一律走保守规则", async () => {
  let calls = 0;
  const session = createArbiterSession({ judge: async () => { calls += 1; return []; }, maxCalls: 1 });
  await session.resolve("https://s.test/x/1", [widget(1), widget(2)]);
  const { report } = await session.resolve("https://s.test/y/2", [widget(1), widget(2)]);
  assert.equal(calls, 1, "超限后不得再调用");
  assert.equal(report.fallbackPath, "conservative");
});

test("降级: 完全没有模型时，保底走保守规则，正文区的块必须留下", async () => {
  // To trigger the fallback every block must be "definitely dropped" (two votes) — a
  // one-vote gray block is kept without a model, the page is no longer nearly empty,
  // and the fallback must not fire.
  const listInMain = block(2, "条目一\n条目二\n条目三\n条目四", {
    tag: "ul", region: "main", linkTextLen: 20, childCount: 4, distinctChildShapes: 1, punctHits: 0,
  });
  const session = createArbiterSession();
  const { mainText, report } = await session.resolve("https://s.test/a", [widget(1), listInMain]);
  assert.equal(report.fallbackTriggered, true);
  assert.equal(report.fallbackPath, "conservative");
  assert.equal(report.llmUsed, false);
  assert.ok(mainText.includes("条目一"), "正文区的块必须留下——宁可留噪声，不可静默清空");
  assert.ok(!mainText.includes("热搜一"), "外壳区域仍然丢弃");
});

test("降级: 灰区块在无模型时留下，页面因此不触发保底", async () => {
  const session = createArbiterSession();
  const { report } = await session.resolve("https://s.test/a", [widget(1), block(2, PROSE, { region: "aside" })]);
  assert.equal(report.fallbackTriggered, false, "灰区块被留下后页面不再几乎被滤空");
  assert.equal(report.llmUsed, false);
});

test("正常页面不触发保底，也不调用模型", async () => {
  let calls = 0;
  const session = createArbiterSession({ judge: async () => { calls += 1; return []; } });
  const { mainText, report } = await session.resolve("https://s.test/a", [block(1, PROSE), block(2, PROSE), widget(3)]);
  assert.equal(calls, 0, "没有灰区、也不触发保底时不该有任何调用");
  assert.equal(report.fallbackTriggered, false);
  assert.equal(report.llmUsed, false);
  assert.ok(!mainText.includes("热搜一"));
});




/* ── Semantics after tightening: the model exits per-block decisions ── */

test("逐块判定不再调用模型：只有 1 票的块一律保留", async () => {
  let calls = 0;
  const session = createArbiterSession({ judge: async () => { calls += 1; return []; } });
  const { mainText, report } = await session.resolve("https://s.test/a", [block(1, PROSE), gray(11), gray(12)]);
  assert.equal(calls, 0, "形状层定不了的块不该触发任何模型调用");
  assert.equal(report.llmUsed, false);
  assert.ok(mainText.includes(PROSE));
  assert.ok(mainText.includes("前一天后一天"), "1 票的块一律保留，留给跨实例与跨时间两层处置");
});

test("模型只在整页保底一处出现", async () => {
  const seen = [];
  const session = createArbiterSession({ judge: async (req) => { seen.push(req.kind); return [2]; } });
  const rescued = block(2, PROSE, {
    tag: "ul", region: "aside", linkTextLen: PROSE.length, childCount: 4, distinctChildShapes: 1,
  });
  await session.resolve("https://s.test/a", [widget(1), rescued]);
  assert.deepEqual(seen, ["fallback"], "除保底外不得有其他模型调用");
});
