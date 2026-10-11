/**
 * Regression corpus runner for layer 2 (cross-instance) and layer 4 (cross-time).
 *
 * Unlike the shape-layer corpus, the assertions here are about **relations between a
 * set of pages** — sibling instances of one template, several versions of one page —
 * so expectations live in the manifest rather than on single-page elements.
 *
 * No model anywhere: both layers are deterministic comparisons, reproducible and
 * regression-testable.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

async function loadModule(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { BLOCK_MEASURE_SOURCE } = await loadModule("../lib/site-knowledge/content-filter.ts");
const { analyzeTemplateGroup, observePage, timeLayerVerdict, applyTimeVerdict, structureSignature, structurePaths } =
  await loadModule("../lib/site-knowledge/content-comparison.ts");
const manifest = JSON.parse(await readFile(new URL("./fixtures/comparison/manifest.json", import.meta.url), "utf8"));

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser?.close(); });

async function measure(group, file) {
  const page = await browser.newPage();
  try {
    await page.goto(new URL(`./fixtures/comparison/${group}/${file}`, import.meta.url).href, { waitUntil: "domcontentloaded" });
    return await page.evaluate(BLOCK_MEASURE_SOURCE);
  } finally { await page.close(); }
}

const textOf = (blocks) => blocks.map((block) => block.text).join("\n");

/* ── Layer 2 ────────────────────────────────────────────────────────── */

for (const entry of manifest.templates) {
  test(`跨实例: ${entry.archetype} → ${entry.expect}`, async () => {
    const instances = [];
    for (const file of entry.instances) instances.push({ url: `/${entry.group}/${file}`, blocks: await measure(entry.group, file) });
    const verdict = analyzeTemplateGroup(instances);

    assert.equal(verdict.kind, entry.expect,
      `${entry.why}\n  实测：${verdict.reason}\n  变量行长 ${verdict.metrics.variantAvgLineLen.toFixed(1)}`
      + ` / 常量行长 ${verdict.metrics.constantAvgLineLen.toFixed(1)}`
      + ` / 变量标点密度 ${verdict.metrics.variantPunctDensity.toFixed(3)}`);

    if (entry.expectConstantContains) {
      const constantText = verdict.constantPaths.map((path) => instances[0].blocks.find((b) => b.path === path)?.text || "").join("\n");
      for (const probe of entry.expectConstantContains) {
        assert.ok(constantText.includes(probe), `「${probe}」应被认作模板常量，实测不在常量位置里`);
      }
    }
    if (entry.expectVariantContains) {
      const variantText = instances.flatMap((instance) =>
        verdict.variantPaths.map((path) => instance.blocks.find((b) => b.path === path)?.text || "")).join("\n");
      for (const probe of entry.expectVariantContains) {
        assert.ok(variantText.includes(probe), `「${probe}」应被认作变量（数据）位置，实测不在变量位置里`);
      }
    }
  });
}

/* ── Grouping key ───────────────────────────────────────────────────── */

test("分组: 同模板实例结构签名一致，与网址写法无关", async () => {
  const entry = manifest.templates[0];
  const signatures = [];
  for (const file of entry.instances) signatures.push(structureSignature(await measure(entry.group, file)));
  assert.equal(new Set(signatures).size, 1,
    "同模板实例必须同签名——网址参数化猜不出 /celebrity/Ella 这类实例段，分组只能靠结构");
});

test("分组: 不同模板的页面不会混进同一组", async () => {
  const dataSignature = structureSignature(await measure("data-template", "Ella.html"));
  const contentSignature = structureSignature(await measure("content-template", "caching.html"));
  assert.notEqual(dataSignature, contentSignature);
});

test("分组: 条目数不同不影响签名", async () => {
  const blocks = await measure("data-template", "Ella.html");
  const listPath = blocks.find((block) => /\.\d/.test(block.path))?.path;
  assert.ok(listPath, "样本里应有带序号的结构位置");
  // More items at the same position (8 entries instead of 5): the signature must not change.
  const more = [...blocks, { ...blocks.find((block) => block.path === listPath), path: listPath.replace(/\.\d+$/, ".99") }];
  assert.equal(structureSignature(blocks), structureSignature(more));
});

test("分组: 结构相同才同组——碎组只是退回第四层，错并会张冠李戴", async () => {
  // "Merge groups whose position sets are subsets" was tried for optional sections, but a
  // shallow page's position set is naturally a subset of a rich page's (the two samples
  // below), and a wrong merge gives the verdict the wrong baseline. Fragmented groups
  // only cost a fallback to layer 4; a wrong merge costs a wrong verdict — fragment.
  const data = structurePaths(await measure("data-template", "Ella.html"));
  const content = structurePaths(await measure("content-template", "caching.html"));
  assert.ok([...content].every((path) => data.has(path)), "浅结构页面的位置集合确实是富结构页面的子集");
  assert.notEqual(structureSignature(await measure("data-template", "Ella.html")),
    structureSignature(await measure("content-template", "caching.html")));
});

test("跨实例: 实例逐字相同则不构成判据", async () => {
  const blocks = await measure("data-template", "Ella.html");
  const verdict = analyzeTemplateGroup([{ url: "/a", blocks }, { url: "/b", blocks }]);
  assert.equal(verdict.kind, "undetermined");
  assert.match(verdict.reason, /逐字相同/);
});

/* ── Layer 4 ────────────────────────────────────────────────────────── */

test("跨时间: 连续两次都变的行清除，只变一次的保留", async () => {
  const entry = manifest.timeSeries[0];
  const [v1, v2, v3] = await Promise.all(entry.versions.map((file) => measure(entry.group, file)));
  const o1 = observePage(v1, "2026-08-12T08:00:00Z");
  const o2 = observePage(v2, "2026-08-13T08:00:00Z");
  const o3 = observePage(v3, "2026-08-14T08:00:00Z");

  const verdict = timeLayerVerdict(o3, o2, o1);
  const { blocks, droppedLines } = applyTimeVerdict(v3, verdict);
  const kept = textOf(blocks);

  assert.equal(verdict.observationsCompared, 2, "应有两次历史观测才能定论");
  assert.equal(verdict.baselineIntervalMs, 24 * 3600 * 1000, "基线间隔应为一天");
  assert.ok(droppedLines > 0, "应有行被判为动态");

  for (const item of entry.expectDroppedAtV3) {
    assert.ok(!kept.includes(item.contains), `「${item.contains}」应被清除（${item.why}），实测仍在正文里`);
  }
  for (const item of entry.expectKeptAtV3) {
    assert.ok(kept.includes(item.contains), `「${item.contains}」应保留（${item.why}），实测被清除了`);
  }
});

test("跨时间: 首爬没有基线时不丢弃任何内容", async () => {
  const v1 = await measure("time-series", "v1.html");
  const verdict = timeLayerVerdict(observePage(v1, "2026-08-12T08:00:00Z"));
  assert.equal(verdict.observationsCompared, 0);
  assert.equal(verdict.baselineIntervalMs, null, "无基线时必须如实为 null，不能假装比对过");
  const { blocks, droppedLines } = applyTimeVerdict(v1, verdict);
  assert.equal(droppedLines, 0);
  assert.equal(textOf(blocks), textOf(v1));
});

test("跨时间: 只有一次历史观测时不下结论", async () => {
  const [v1, v2] = await Promise.all(["v1.html", "v2.html"].map((f) => measure("time-series", f)));
  const verdict = timeLayerVerdict(observePage(v2, "2026-08-13T08:00:00Z"), observePage(v1, "2026-08-12T08:00:00Z"));
  assert.equal(verdict.observationsCompared, 1);
  assert.deepEqual(verdict.volatile, {}, "只变一次不足以判定，必须等第三次观测");
  assert.equal(applyTimeVerdict(v2, verdict).droppedLines, 0);
});

test("跨时间: 同一块内变与不变的行分别处置", async () => {
  const entry = manifest.timeSeries[0];
  const [v1, v2, v3] = await Promise.all(entry.versions.map((file) => measure(entry.group, file)));
  const verdict = timeLayerVerdict(
    observePage(v3, "2026-08-14T08:00:00Z"),
    observePage(v2, "2026-08-13T08:00:00Z"),
    observePage(v1, "2026-08-12T08:00:00Z"),
  );
  // In the hero block the clock and digest both change; the two faq lines never do
  const kept = textOf(applyTimeVerdict(v3, verdict).blocks);
  assert.ok(kept.includes("本站能查什么"), "同页未变的说明必须保留");
  assert.ok(!kept.includes("2026-08-14 08:00:00"), "同页每次都变的时钟必须清除");
});

test("跨时间: 被判为动态的行仍进入观测记录，因而可恢复", async () => {
  const v3 = await measure("time-series", "v3.html");
  const observation = observePage(v3, "2026-08-14T08:00:00Z");
  const heroPath = v3.find((block) => block.text.includes("实时 · "))?.path;
  assert.ok(heroPath, "样本里应有 hero 块");
  assert.ok(observation.lines[heroPath]?.length > 0,
    "动态行的校验值必须记入观测记录——否则下次会被当成新内容再丢一次，永远无法自我纠正");
});

/* ── Re-observation hint ────────────────────────────────────────────── */

const { recrawlHint } = await loadModule("../lib/site-knowledge/content-comparison.ts");

test("提示: 首次抓取时说明比对尚未开始", () => {
  const hint = recrawlHint([
    { url: "/a", observationsCompared: 0, baselineIntervalMs: null },
    { url: "/b", observationsCompared: 0, baselineIntervalMs: null },
  ]);
  assert.equal(hint.stage, "first-crawl");
  assert.match(hint.message, /再采集一次/);
  assert.ok(!/没有时效内容/.test(hint.message), "不得让人以为该站点确实没有时效内容");
});

test("提示: 只有一次观测时说明尚不能定论", () => {
  const hint = recrawlHint([
    { url: "/a", observationsCompared: 1, baselineIntervalMs: 3600_000 },
    { url: "/b", observationsCompared: 2, baselineIntervalMs: 3600_000 },
  ]);
  assert.equal(hint.stage, "needs-one-more");
  assert.equal(hint.pagesNeedingMore, 1);
  assert.match(hint.message, /再采集一次可清除更多/);
});

test("提示: 观测足够且间隔够长时不再催促重抓", () => {
  const hint = recrawlHint([
    { url: "/a", observationsCompared: 2, baselineIntervalMs: 86400_000 },
    { url: "/b", observationsCompared: 3, baselineIntervalMs: 86400_000 },
  ]);
  assert.equal(hint.stage, "ready");
  assert.equal(hint.pagesNeedingMore, 0);
  assert.ok(!/再采集一次/.test(hint.message), "已可定论时不该再催促");
});

test("提示: 观测够了但间隔太短，要说清日更内容测不出来", () => {
  const hint = recrawlHint([
    { url: "/a", observationsCompared: 2, baselineIntervalMs: 600_000 },
    { url: "/b", observationsCompared: 2, baselineIntervalMs: 600_000 },
  ]);
  assert.equal(hint.stage, "ready");
  assert.match(hint.message, /10 分钟/);
  assert.match(hint.message, /隔一天以上/);
  assert.ok(!/能被正常识别并清除/.test(hint.message),
    "次数够不等于测得准——隔十分钟采两次，日更的时效内容根本没变，说成『正常识别』会让人以为库已经干净");
});

/* ── The site health summary must state the interval and the hint ──── */

const { siteHealth } = await loadModule("../lib/site-knowledge/content-filter.ts");

const reportOf = (extra) => ({
  url: "/a", keptChars: 100, droppedChars: 20, keptRatio: 0.83, undecidedCount: 0,
  signalHits: {}, droppedLinkDensityMedian: 0.8, keptAvgLineLen: 30, keptPunctDensity: 0.04,
  proseBaseline: 30, fallbackTriggered: false, fallbackPath: "none", llmUsed: false,
  emptyContentPage: false, ...extra,
});

test("统计: 基线间隔与重抓提示必须出现在整站摘要里", () => {
  const health = siteHealth([
    reportOf({ baselineIntervalMs: 86_400_000, observationsCompared: 1, recrawlHint: "再抓一次可清除更多动态内容" }),
    reportOf({ baselineIntervalMs: 86_400_000, observationsCompared: 2, recrawlHint: "再抓一次可清除更多动态内容" }),
  ]);
  assert.equal(health.baselineIntervalMs, 86_400_000);
  assert.match(health.recrawlHint, /再抓一次/);
});

test("统计: 间隔过短由提示一句话说清，不再另发一条同义警示", () => {
  const health = siteHealth([reportOf({ baselineIntervalMs: 120_000, observationsCompared: 2 })]);
  assert.ok(!health.warnings.some((warning) => /只隔了/.test(warning)),
    "recrawlHint 已经说了间隔短、还说了该怎么办；再来一条几乎同义的警示只是噪声");
});

test("统计: 首爬没有基线时如实为 null，不假装比对过", () => {
  const health = siteHealth([reportOf({ baselineIntervalMs: null, observationsCompared: 0 })]);
  assert.equal(health.baselineIntervalMs, null);
});

/* ── Trigger rule for page descriptions ─────────────────────────────── */

const { hasProseBlock } = await loadModule("../lib/site-knowledge/content-comparison.ts");
const { calibratePage } = await loadModule("../lib/site-knowledge/content-filter.ts");

test("触发: 有说明段落的页面不触发模型", async () => {
  // Instance pages of a data template contain intro text like "this page shows the person's chart history…"
  const blocks = await measure("data-template", "Ella.html");
  const { proseBaseline } = calibratePage(blocks);
  assert.equal(hasProseBlock(blocks, proseBaseline), true,
    "页面自己有成段说明时必须用原文——模型写的说明既多余又不如原文可信");
});

test("触发: 只剩枚举与标签的页面才触发", async () => {
  const blocks = await measure("data-template", "Ella.html");
  const { proseBaseline } = calibratePage(blocks);
  // Keep only short-field blocks, simulating an index page after filtering
  const enumerationOnly = blocks.filter((block) => !/[，。；]/.test(block.text));
  assert.ok(enumerationOnly.length, "样本里应有纯字段块");
  assert.equal(hasProseBlock(enumerationOnly, proseBaseline), false);
});

test("触发: 空页面不算有散文", () => {
  assert.equal(hasProseBlock([], 30), false);
});
