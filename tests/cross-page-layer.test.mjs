/**
 * Regression for layer 3 (cross-page).
 *
 * The baseline is the site's other pages: lines repeated verbatim on enough pages are
 * site chrome. The key assertion is the **threshold denominator** — once layer 2 empties
 * a data-page class, those pages contribute no lines; counting every page in the
 * denominator makes site-wide lines miss the threshold, and enabling layer 2 disables
 * layer 3. Production broke exactly this way.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

async function load(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { stripSharedChrome, buildContentPage } = await load("../lib/site-knowledge/content-index.ts");

const CHROME = "关注\n搜索\n登录\n注册";
const FOOTER = "© 2026 热搜时光机";
const page = (body) => ({ visibleText: `${CHROME}\n${body}\n${FOOTER}` });

test("跨页重复的导航与页脚被清除，各页自己的内容留下", () => {
  const pages = [page("关于我们的介绍"), page("服务条款正文"), page("隐私政策正文"), page("方法说明")];
  const cleaned = stripSharedChrome(pages);
  for (const text of cleaned) {
    assert.ok(!text.includes("关注"), "全站导航必须清除");
    assert.ok(!text.includes(FOOTER), "全站页脚必须清除");
  }
  assert.ok(cleaned[0].includes("关于我们的介绍"));
  assert.ok(cleaned[1].includes("服务条款正文"));
});

test("被前面几层清空的页不参与分母——否则第二层一开第三层就失效", () => {
  // 4 pages with body (all with nav), 20 emptied by layer 2 as data pages.
  const pages = [
    page("关于我们的介绍"), page("服务条款正文"), page("隐私政策正文"), page("方法说明"),
    ...Array.from({ length: 20 }, () => ({ visibleText: "" })),
  ];
  const cleaned = stripSharedChrome(pages);
  assert.ok(!cleaned[0].includes("关注"),
    "导航出现在 4/4 个有正文的页面上，就该判为外壳；按 24 页算分母则 4/24 达不到阈值，导航会漏进库");
  assert.ok(cleaned[0].includes("关于我们的介绍"), "本页自己的内容不能被牵连");
});

test("有正文的页面太少时整层不生效", () => {
  const cleaned = stripSharedChrome([page("甲"), page("乙")]);
  assert.ok(cleaned[0].includes("关注"), "少于三页无从判断重复，宁可不删");
});

test("只出现在一页上的内容不会被误删", () => {
  const pages = [page("只有这页才有的说明文字"), page("乙"), page("丙"), page("丁")];
  assert.ok(stripSharedChrome(pages)[0].includes("只有这页才有的说明文字"));
});

/* ── source mark ────────────────────────────────────────────────────── */

test("模型写的页面说明单独成块并标 model，逐字正文不受影响", () => {
  const built = buildContentPage({
    url: "https://x.test/daily",
    visibleText: "2026 年\n223 个有数据日期\n2025 年\n365 个有数据日期",
    heading: "每日热搜归档",
    description: "按日期归档回看微博每日热搜榜。",
  });
  const model = built.chunks.filter((chunk) => chunk.source === "model");
  const verbatim = built.chunks.filter((chunk) => chunk.source !== "model");
  assert.equal(model.length, 1, "说明必须独立成块——混进逐字正文就分不出来源了");
  assert.equal(model[0].text, "按日期归档回看微博每日热搜榜。");
  assert.ok(verbatim.length >= 1 && verbatim.every((chunk) => !chunk.text.includes("按日期归档")),
    "逐字正文里不得混入模型文字");
  assert.ok(built.chunks.every((chunk, index) => chunk.chunkIndex === index), "块号必须连续");
});

test("没有说明时不产生任何 model 块", () => {
  const built = buildContentPage({ url: "https://x.test/a", visibleText: "正文", heading: "标题" });
  assert.ok(built.chunks.every((chunk) => chunk.source !== "model"));
});

test("说明变化会改变页面指纹——否则说明更新了也不会重写", () => {
  const base = { url: "https://x.test/a", visibleText: "正文", heading: "标题" };
  const a = buildContentPage({ ...base, description: "甲说明" });
  const b = buildContentPage({ ...base, description: "乙说明" });
  assert.notEqual(a.contentHash, b.contentHash);
});
