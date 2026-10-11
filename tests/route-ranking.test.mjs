/**
 * Ranking of navigation recommendations.
 *
 * Production failure: asking "未成年人能用吗", body search hit "八、未成年人保护"
 * verbatim on /privacy, yet the recommendations were the yearly archive, monthly digest
 * and celebrity records — each let in by a single "年", "年" or "人" — while /privacy
 * scored 0 and did not make the list.
 *
 * Three causes combined: single-character overlap scored; body hits played no part in
 * ranking; readiness came before score.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const result = await build({
  entryPoints: [fileURLToPath(new URL("../lib/site-knowledge/planner.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false,
});
const { searchKnowledgeIndex } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

const ORIGIN = "https://site.test";
const scene = (id, name, description, path, params = [], observed = []) => ({
  id, name, description, businessArea: "热搜榜单",
  urlTemplates: [{ id: `url_${id}`, originPattern: ORIGIN, pathnamePattern: path, query: {}, ignoredQueryKeys: [] }],
  parameters: params.map((n) => ({ id: n, name: n, type: "string", required: true, examples: [] })),
  evidence: { titles: [], headings: [], linkLabels: [], observedUrls: observed },
  evidenceStatus: "entry-verified", lifecycle: "entry-verified", directEntry: "verified",
});

const release = {
  profile: { name: "站点", description: "", suggestedGoals: [], taskTemplates: [] },
  scenes: [
    scene("s1", "年度热搜归档", "展示指定年份的全年热搜数据归档", "/daily/year/{path1}", ["年份"]),
    scene("s2", "月度热搜汇总", "展示指定月份的微博热搜历史日榜汇总", "/daily/month/{path1}", ["年月标识"]),
    scene("s3", "微博热搜记录", "展示特定明星或公众人物的微博历史上榜记录", "/celebrity/{path1}", ["明星姓名或昵称"]),
    scene("s4", "隐私政策", "本站如何收集与使用信息", "/privacy", [], [`${ORIGIN}/privacy`]),
  ],
  operations: [], capabilities: [], linkReferences: [],
};
const KEYWORDS = ["未成年人", "未成年", "儿童", "小孩", "青少年"];

test("单字共现不再计分——一个『年』字不该把年度归档推上来", () => {
  const index = searchKnowledgeIndex(release, KEYWORDS);
  for (const name of ["年度热搜归档", "月度热搜汇总", "微博热搜记录"]) {
    const hit = index.scenes.find((item) => item.name === name);
    assert.ok(!hit || hit.score === 0,
      `${name} 只和关键词共享一个字，不该得分（实测 ${hit?.score}）`);
  }
});

test("正文命中的页面排在最前", () => {
  const index = searchKnowledgeIndex(release, KEYWORDS, undefined, [`${ORIGIN}/privacy`]);
  assert.equal(index.scenes[0]?.name, "隐私政策",
    `正文里逐字命中的页面必须排第一，实测顺序：${index.scenes.map((s) => s.name).join(" > ")}`);
  assert.equal(index.scenes[0].contentHit, true);
});

test("正文命中的页面即使名字不匹配也要进列表", () => {
  const index = searchKnowledgeIndex(release, ["完全无关的词"], undefined, [`${ORIGIN}/privacy`]);
  assert.ok(index.scenes.some((item) => item.name === "隐私政策"),
    "名字不匹配但正文命中，仍是最该推荐的页面");
});

test("分数优先于就绪度——就绪度只做同分决胜", () => {
  const plain = (id, name, description) => ({ ...scene(id, name, description, `/${id}`), businessArea: "其它" });
  const mixed = {
    ...release,
    scenes: [
      { ...plain("a", "热搜榜单查询", "查询热搜榜单"), evidenceStatus: "referenced", lifecycle: "referenced", directEntry: "candidate" },
      plain("b", "热搜时刻", "无关描述"),
    ],
  };
  const index = searchKnowledgeIndex(mixed, ["热搜榜单"]);
  assert.equal(index.scenes[0]?.name, "热搜榜单查询",
    `匹配更好的页面必须排前面，就绪度不该盖过分数；实测：${index.scenes.map((s) => `${s.name}(${s.score.toFixed(2)},r=${s.readiness})`).join(" > ")}`);
});

test("真正的词仍然匹配得上", () => {
  const index = searchKnowledgeIndex(release, ["热搜归档"]);
  assert.ok((index.scenes.find((item) => item.name === "年度热搜归档")?.score || 0) > 0,
    "共享『热搜』『归档』这样的两字词，本就该匹配");
});
