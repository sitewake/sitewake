import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Bundle a pure TS lib module and import it (no D1 / worker bindings needed). */
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

const mod = await loadModule("../lib/site-knowledge/content-index.ts");
const { grepSiteContent, findKeywordHits, normalizeForMatch } = mod;

/** Build chunk rows for a single page from an array of paragraph strings. */
function pageChunks(url, paragraphs, sceneId, headingPath) {
  return paragraphs.map((text, chunkIndex) => ({ url, sceneId, chunkIndex, headingPath, text }));
}

test("knowledge-search: literal keyword hits found across chunks", () => {
  const chunks = pageChunks("https://s.test/privacy", [
    "本网站重视隐私保护。",
    "未成年人使用本服务需监护人同意。",
  ]);
  const hits = findKeywordHits(chunks, ["未成年"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].chunkIndex, 1);
  assert.equal(hits[0].keyword, "未成年");
});

test("knowledge-search: synonym expansion is a caller concern — the matching keyword wins", () => {
  // The page only says 未成年; the agent expanded 小孩→[小孩,未成年,儿童]. Literal grep
  // over the list catches the page via the matching term, and reports which one hit.
  const chunks = pageChunks("https://s.test/policy", [
    "关于未成年人保护的专项条款见下。",
  ]);
  const { pages } = grepSiteContent(chunks, ["小孩", "未成年", "儿童"]);
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].matchedKeywords, ["未成年"]);
});

test("knowledge-search: distinct-keyword coverage outranks single-keyword frequency", () => {
  const pageA = pageChunks("https://s.test/a", ["会员 等级 与 积分 说明。"]); // 3 distinct of 3
  const pageB = pageChunks("https://s.test/b", ["会员会员会员会员会员会员会员会员会员会员"]); // 1 distinct, high freq
  const { pages } = grepSiteContent([...pageA, ...pageB], ["会员", "等级", "积分"]);
  assert.equal(pages[0].url, "https://s.test/a", "3/3 coverage page ranks above the high-frequency single-term page");
  assert.ok(pages[0].score > pages[1].score);
});

test("knowledge-search: context window centers on the hit deep in a long page", () => {
  const filler = "无关内容。".repeat(400); // ~2000 chars of noise before the answer
  const chunks = pageChunks("https://s.test/long", [
    filler,
    "退款政策:下单后七天内可申请全额退款。",
    "其他条款省略。",
  ]);
  const { pages } = grepSiteContent(chunks, ["退款"]);
  assert.equal(pages.length, 1);
  const joined = pages[0].context.map((window) => window.text).join(" ");
  assert.match(joined, /七天内可申请全额退款/, "the hit sentence is present in the context");
  assert.doesNotMatch(pages[0].context[0]?.text ?? "", /^无关内容。无关内容。无关内容/, "context does not lead with page-top filler");
});

test("knowledge-search: NO fuzzy fallback — a keyword the page doesn't literally contain returns empty", () => {
  const chunks = pageChunks("https://s.test/help", [
    "配送与物流:我们支持全国范围的快递配送服务。",
  ]);
  // "配送物流查询" never appears literally; there is no bigram fallback, so this is empty.
  // Recall for such a phrasing is the caller's job (expand into ["配送","物流"] and retry).
  const { pages, totalPagesWithHits } = grepSiteContent(chunks, ["配送物流查询"]);
  assert.equal(pages.length, 0, "no literal match ⇒ empty, no fuzzy guess");
  assert.equal(totalPagesWithHits, 0);
  // The atomic keyword that IS present is found — that's the caller's expansion doing its job.
  assert.equal(grepSiteContent(chunks, ["配送"]).pages.length, 1);
});

test("knowledge-search: zero results when nothing matches literally", () => {
  const chunks = pageChunks("https://s.test/x", ["苹果 香蕉 橙子。"]);
  const { pages, totalPagesWithHits } = grepSiteContent(chunks, ["量子纠缠超导磁悬浮"]);
  assert.equal(pages.length, 0);
  assert.equal(totalPagesWithHits, 0);
});

test("knowledge-search: totalPagesWithHits reports breadth honestly", () => {
  const chunks = [
    ...pageChunks("https://s.test/1", ["会员权益介绍。"]),
    ...pageChunks("https://s.test/2", ["会员中心入口。"]),
    ...pageChunks("https://s.test/3", ["开通会员流程。"]),
  ];
  const { totalPagesWithHits } = grepSiteContent(chunks, ["会员"], { topPages: 1 });
  assert.equal(totalPagesWithHits, 3, "breadth counts every hit page, not just the returned top page");
});

test("knowledge-search: ASCII keywords match on word boundaries", () => {
  const chunks = pageChunks("https://s.test/api", ["The video API returns json.", "An id field is included."]);
  const hits = findKeywordHits(chunks, ["id"]);
  assert.equal(hits.length, 1, "'id' matches the standalone word, not inside 'video'");
  assert.equal(hits[0].chunkIndex, 1);
});

test("knowledge-search: normalization folds full-width and case", () => {
  assert.equal(normalizeForMatch("ＶＩＰ　会员"), "vip 会员");
});

test("keyword-expansion: falls back to the whole question when no model is configured", async () => {
  const analyzer = await loadModule("../lib/site-knowledge/model-analyzer.ts");
  // No model configured in the test env → expansion returns the question verbatim (honest:
  // without a model the agent could not expand either), never throws, never empty.
  const out = await analyzer.expandQueryKeywords("小孩能玩吗");
  assert.deepEqual(out, ["小孩能玩吗"]);
  assert.deepEqual(await analyzer.expandQueryKeywords("   "), []);
});

test("keyword-expansion: runtime and probe reference the SAME guidance constant (no drift)", async () => {
  const guidance = await loadModule("../lib/site-knowledge/knowledge-search-guidance.ts");
  assert.match(guidance.KEYWORD_EXPANSION_GUIDANCE, /关键词/, "guidance constant exists");
  const port = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  const analyzer = await readFile(new URL("../lib/site-knowledge/model-analyzer.ts", import.meta.url), "utf8");
  // Both the runtime agent (tool description + system prompt) and the probe expander import
  // and interpolate the one constant — so editing the guidance updates both at once.
  assert.match(port, /KEYWORD_EXPANSION_GUIDANCE/, "client references the shared guidance");
  assert.match(analyzer, /KEYWORD_EXPANSION_GUIDANCE/, "expander references the shared guidance");
  assert.equal((port.match(/\$\{KEYWORD_EXPANSION_GUIDANCE\}/g) || []).length >= 2, true, "used in both tool description and system prompt");
});
