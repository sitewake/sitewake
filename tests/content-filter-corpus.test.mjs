/**
 * Regression corpus runner for content-filter.
 *
 * Renders local HTML samples in a real browser (no network), runs the same block
 * measurement + verdict as production, and compares against the data-expect
 * annotations in the samples. The corpus exists to **catch regressions**, not to tune.
 *
 * The dev set and the holdout set run separately: the holdout never takes part in
 * tuning and only estimates real generalization. If only the holdout goes red after a
 * parameter change, that is the overfitting signal.
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
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { BLOCK_MEASURE_SOURCE, filterBlocks } = await loadModule("../lib/site-knowledge/content-filter.ts");
const manifest = JSON.parse(
  await readFile(new URL("./fixtures/content-filter/manifest.json", import.meta.url), "utf8"),
);

const fixtureUrl = (file) => new URL(`./fixtures/content-filter/${file}`, import.meta.url).href;

/** Lines long enough to be a distinctive probe (skips "…"-style filler and stray whitespace). */
const probeLines = (text, limit = 6) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 6)
    .sort((a, b) => b.length - a.length)
    .slice(0, limit);

/**
 * Renders one fixture, runs measurement + filtering, and returns the verdict text
 * plus the expectations declared in the DOM.
 */
async function runFixture(browser, file) {
  const page = await browser.newPage();
  try {
    await page.goto(fixtureUrl(file), { waitUntil: "domcontentloaded" });
    const blocks = await page.evaluate(BLOCK_MEASURE_SOURCE);
    const expectations = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-expect]")).map((element) => ({
        expect: element.getAttribute("data-expect"),
        tag: element.tagName.toLowerCase(),
        className: element.getAttribute("class") || "",
        text: element.innerText || "",
      })),
    );
    // No LLM in the corpus, so run twice to pin both ends of the deterministic kernel:
    //   lenient (1 vote still kept) — drop expectations must vanish here too, i.e. ≥2 votes;
    //   strict  (1 vote drops)      — keep expectations must survive here too, i.e. 0 votes.
    // Blocks with exactly 1 vote are gray, arbitrated by the LLM in production; the
    // corpus only asserts they were not confidently kept.
    const lenient = filterBlocks(blocks, { undecidedPolicy: "keep" });
    const strict = filterBlocks(blocks, { undecidedPolicy: "drop" });
    return { blocks, expectations, result: lenient, lenient, strict };
  } finally {
    await page.close();
  }
}

function assertFixture(file, expectations, { lenient, strict }) {
  // Whole-line comparison, not substring: a short probe ("API 参考") would collide with "下一页：API 参考" elsewhere.
  const linesOf = (text) => new Set(text.split("\n").map((line) => line.trim()).filter(Boolean));
  const inLenient = linesOf(lenient.mainText);
  const inStrict = linesOf(strict.mainText);
  const failures = [];
  for (const item of expectations) {
    const probes = probeLines(item.text);
    if (!probes.length) continue;
    const label = `${item.tag}${item.className ? "." + item.className.split(" ")[0] : ""}`;
    if (item.expect === "keep") {
      // Must pass with zero votes: surviving the lenient run is not enough, the strict run must keep it too.
      const missing = probes.filter((line) => !inStrict.has(line));
      if (missing.length) failures.push(`应确定保留却未保留 <${label}>：${JSON.stringify(missing.slice(0, 2))}`);
    } else if (item.expect === "drop") {
      // Must get ≥2 votes: must not survive even the lenient run.
      const leaked = probes.filter((line) => inLenient.has(line));
      if (leaked.length) failures.push(`应确定丢弃却残留 <${label}>：${JSON.stringify(leaked.slice(0, 2))}`);
    } else if (item.expect === "gray") {
      // Gray: at least suspected (≥1 vote), arbitrated by the LLM in production; must not pass confidently with zero votes.
      const unsuspected = probes.filter((line) => inStrict.has(line));
      if (unsuspected.length) failures.push(`应至少被怀疑却零票通过 <${label}>：${JSON.stringify(unsuspected.slice(0, 2))}`);
    }
  }
  assert.equal(
    failures.length,
    0,
    `${file}\n  ${failures.join("\n  ")}\n  保留率 ${(lenient.stats.keptRatio * 100).toFixed(1)}%`
      + `，保留 ${lenient.stats.keptChars} 字 / 丢弃 ${lenient.stats.droppedChars} 字`
      + `，灰区 ${lenient.stats.undecidedCount} 块`,
  );
}

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser?.close(); });

for (const entry of manifest.dev) {
  test(`content-filter 开发集: ${entry.archetype} (${entry.focus})`, async () => {
    const run = await runFixture(browser, entry.file);
    assertFixture(entry.file, run.expectations, run);
  });
}

for (const entry of manifest.holdout) {
  test(`content-filter 留出集: ${entry.archetype} (${entry.focus})`, async () => {
    const run = await runFixture(browser, entry.file);
    assertFixture(entry.file, run.expectations, run);
  });
}

test("content-filter: 纯榜单页只剩标题，榜单条目全部消失", async () => {
  const { result } = await runFixture(browser, "pure-ranking-page.html");
  for (const item of ["某某新规出台", "某地暴雨预警", "某明星演唱会", "某公司发布财报"]) {
    assert.ok(!result.mainText.includes(item), `榜单条目「${item}」残留`);
  }
  // Keeping the title is right; the correct content-store output for such pages is "almost empty".
  assert.ok(result.stats.keptChars < 60, `榜单页保留 ${result.stats.keptChars} 字，超出预期`);
});

test("content-filter: 条款页的重复条目列表须全部存活", async () => {
  const { result } = await runFixture(browser, "legal-terms-page.html");
  for (const clause of ["访问权", "更正权", "删除权", "限制处理权", "可携带权", "撤回同意权", "投诉权", "拒绝自动化决策权"]) {
    assert.ok(result.mainText.includes(clause), `条款「${clause}」被误杀`);
  }
});

test("content-filter: 保留的正文不得包含模型生成内容（逐字取自原文）", async () => {
  const { blocks, result } = await runFixture(browser, "news-article-with-hot-sidebar.html");
  const source = blocks.map((block) => block.text).join("\n");
  for (const line of result.mainText.split("\n").filter((line) => line.trim().length >= 6)) {
    assert.ok(source.includes(line.trim()), `正文出现了原文中不存在的行：${line.slice(0, 40)}`);
  }
});

/* ── Label-free health metrics: no ground truth needed, any unseen site can self-check ── */

const { siteHealth } = await loadModule("../lib/site-knowledge/content-filter.ts");

/** Runs a set of samples into a site-wide report, simulating one crawl. */
async function siteReport(files) {
  const reports = [];
  for (const file of files) {
    const { result } = await runFixture(browser, file);
    reports.push({
      ...result.stats,
      url: `file:///${file}`,
      fallbackTriggered: result.stats.keptRatio < 0.05,
      fallbackPath: result.stats.keptRatio < 0.05 ? "conservative" : "none",
      llmUsed: false,
      emptyContentPage: result.stats.keptChars === 0,
    });
  }
  return siteHealth(reports);
}

test("健康指标: 正常站点不报警", async () => {
  const health = await siteReport(manifest.dev.map((entry) => entry.file));
  assert.equal(health.pages, manifest.dev.length);
  assert.ok(health.keptRatioQuartiles[1] > 0.2, `保留率中位数 ${health.keptRatioQuartiles[1]}`);
  assert.deepEqual(health.warnings, [], `不该报警却报了：${health.warnings.join("；")}`);
});

test("健康指标: 过滤失效时能自己看见（不需要标准答案）", () => {
  const base = {
    blockCount: 10, keptChars: 1000, droppedChars: 0, keptRatio: 1, undecidedCount: 0,
    signalHits: { linkList: 0, shellRepeat: 0, region: 0, timestamp: 0 },
    droppedLinkDensityMedian: 0, keptAvgLineLen: 80, keptPunctDensity: 0.06, proseBaseline: 80,
    fallbackTriggered: false, fallbackPath: "none", llmUsed: false, emptyContentPage: false,
  };
  const health = siteHealth(Array.from({ length: 6 }, (_, index) => ({ ...base, url: `p${index}` })));
  assert.ok(health.warnings.some((line) => line.includes("过滤可能失效")), health.warnings.join("；"));
});

test("健康指标: 过滤过激时能自己看见", () => {
  const base = {
    blockCount: 10, keptChars: 10, droppedChars: 990, keptRatio: 0.01, undecidedCount: 0,
    signalHits: { linkList: 5, shellRepeat: 5, region: 2, timestamp: 0 },
    droppedLinkDensityMedian: 0.05, keptAvgLineLen: 12, keptPunctDensity: 0, proseBaseline: 80,
    fallbackTriggered: true, fallbackPath: "conservative", llmUsed: false, emptyContentPage: false,
  };
  const health = siteHealth(Array.from({ length: 6 }, (_, index) => ({ ...base, url: `p${index}` })));
  assert.ok(health.warnings.some((line) => line.includes("过滤可能过激")), health.warnings.join("；"));
  assert.ok(health.warnings.some((line) => line.includes("误杀正文")), health.warnings.join("；"));
  assert.ok(health.warnings.some((line) => line.includes("超出设计假设")), health.warnings.join("；"));
});

/* ── Integration with the render pipeline: filter results attached to the snapshot in parallel, visibleText unchanged ── */

const render = await loadModule("../lib/site-knowledge/crawl-render.ts");

test("快照: 有块级测量时并行挂出过滤结果，visibleText 不变", async () => {
  const { blocks } = await runFixture(browser, "news-article-with-hot-sidebar.html");
  const extract = {
    title: "t", heading: "h", visibleText: "整页原文", links: [], elements: [], blocks,
  };
  const snapshot = render.snapshotFromExtract("https://s.test/a", extract, "2026-08-12T00:00:00Z");
  assert.equal(snapshot.visibleText, "整页原文", "迁移第 1 步：入库来源尚未切换");
  assert.ok(snapshot.contentFilter, "应挂出过滤结果");
  assert.ok(snapshot.contentFilter.mainText.includes("分布式数据库"), "正文应保留");
  assert.ok(!snapshot.contentFilter.mainText.includes("某地暴雨预警"), "热搜不应进正文");
  assert.ok(snapshot.contentFilter.dropped.length > 0, "被丢块应带回，供保底判定使用");
});

test("快照: 没有块级测量时不挂过滤结果（静默降级）", () => {
  const snapshot = render.snapshotFromExtract(
    "https://s.test/a",
    { title: "t", heading: "h", visibleText: "整页原文", links: [], elements: [] },
    "2026-08-12T00:00:00Z",
  );
  assert.equal(snapshot.contentFilter, undefined);
  assert.equal(snapshot.visibleText, "整页原文");
});
