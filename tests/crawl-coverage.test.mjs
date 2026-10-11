/**
 * The crawl coverage invariant: **unless the render budget runs out, every discovered
 * structure family renders at least once.**
 *
 * The crawl decides what to look at before rendering, with only URL strings in hand,
 * and "which segment is the instance value" is a guess — every site trips one kind of
 * wrong guess. These cases write each kind down and all assert the same invariant: a
 * wrong guess may cost efficiency, never a page class's only turn.
 *
 * Production incident: an index page linked 30 date pages, tied in score with
 * /history; the date pages formed one template, from the third on each counted as
 * "no new template", the saturation counter hit its cap and the crawl stopped —
 * /history was never opened and showed in the console as "unverified / unclassified /
 * no body".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const result = await build({
  entryPoints: [fileURLToPath(new URL("../lib/site-knowledge/crawl-frontier.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false,
});
const { CrawlFrontier } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

const ORIGIN = "https://site.test";

/** Runs one crawl and returns rendered paths, sampled-out paths and the stop reason. */
function crawl(urls, options = {}) {
  const frontier = new CrawlFrontier({ origin: ORIGIN, ...options });
  frontier.seed(urls.map((path) => ORIGIN + path));
  const rendered = [];
  const sampled = [];
  let reason = "";
  for (let guard = 0; guard < 5000; guard += 1) {
    const decision = frontier.next();
    if (decision.action === "stop") { reason = decision.reason; break; }
    const path = decision.item.url.replace(ORIGIN, "");
    if (decision.action === "render") {
      rendered.push(path);
      // Structure is reported by the caller after rendering; here the first path segment simulates "same template, same structure"
      if (options.structureOf) frontier.observeStructure(decision.item.url, options.structureOf(path));
    } else sampled.push(path);
  }
  return { rendered, sampled, reason, frontier };
}

const dates = Array.from({ length: 30 }, (_, i) => `/daily/2026-08-${String(i + 1).padStart(2, "0")}`);
const latinNames = ["Ella", "Andy", "Elva", "Hebe", "JJ", "Jay", "Kris", "Lay", "Tony", "Vae", "GEM", "Jane", "Vic", "Ken", "Amy", "Ivy", "Zoe"];

test("猜错方式一：该合的没合（短拉丁名实例页）——独立页仍必须被渲染", () => {
  const { rendered } = crawl([
    "/", ...latinNames.map((n) => `/celebrity/${n}`), "/history", "/about",
  ]);
  assert.ok(rendered.includes("/history"), `/history 必须被渲染，实测渲染了 ${rendered.length} 页：${rendered.join(" ")}`);
  assert.ok(rendered.includes("/about"));
});

test("猜错方式二：归拢正确但族极大（30 个日期页）——独立页仍必须被渲染", () => {
  const { rendered, reason } = crawl(["/", "/daily", ...dates, "/history", "/guides/x"]);
  assert.ok(rendered.includes("/history"), `饱和停止不得越过没覆盖到的族；停止原因=${reason}`);
  assert.ok(rendered.includes("/guides/x"));
  assert.ok(rendered.filter((p) => p.startsWith("/daily/2026")).length <= 2, "同一族渲染数受预算约束");
});

test("预算紧张时每族至少一页，不许饿死任何一族", () => {
  const families = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const urls = families.flatMap((f) => [`/${f}/1001`, `/${f}/1002`, `/${f}/1003`]);
  const { rendered } = crawl(urls, { maxRenders: 10 });
  for (const f of families) {
    assert.ok(rendered.some((p) => p.startsWith(`/${f}/`)), `族 ${f} 被饿死了：${rendered.join(" ")}`);
  }
});

test("预算按结构合并：网址归不到一起、结构相同的页只渲染够对照物的份数", () => {
  // 17 short-Latin-name instance pages, each its own URL template, all the same structure
  const { rendered } = crawl(["/", ...latinNames.map((n) => `/celebrity/${n}`), "/about"], {
    structureOf: (path) => (path.startsWith("/celebrity/") ? "sig-celebrity" : `sig${path}`),
  });
  const celebrity = rendered.filter((p) => p.startsWith("/celebrity/"));
  assert.ok(celebrity.length <= 3,
    `同结构族应受预算约束，实测渲染了 ${celebrity.length} 个：${celebrity.join(" ")}`);
  assert.ok(rendered.includes("/about"), "省下来的预算要能用在别的页面上");
});

test("重爬：用上一次量到的结构预热，同族不再挨个渲染", () => {
  const frontier = new CrawlFrontier({ origin: ORIGIN });
  // Last crawl's URL → structure signature map: measured, not guessed
  frontier.primeStructures(latinNames.map((n) => [`${ORIGIN}/celebrity/${n}`, "sig-celebrity"]));
  frontier.seed(["/", ...latinNames.map((n) => `/celebrity/${n}`), "/about", "/history"].map((p) => ORIGIN + p));
  const rendered = [];
  for (let guard = 0; guard < 500; guard += 1) {
    const decision = frontier.next();
    if (decision.action === "stop") break;
    if (decision.action === "render") {
      rendered.push(decision.item.url.replace(ORIGIN, ""));
      frontier.observeStructure(decision.item.url, decision.item.url.includes("/celebrity/") ? "sig-celebrity" : `sig${decision.item.url}`);
    }
  }
  const celebrity = rendered.filter((p) => p.startsWith("/celebrity/"));
  assert.ok(celebrity.length <= 2, `重爬时同族应只渲染够对照物的份数，实测 ${celebrity.length} 个`);
  assert.ok(rendered.includes("/history") && rendered.includes("/about"));
});

test("覆盖不随网址写法变化：中日韩文 / 不透明短码 / 查询串路由", () => {
  for (const [名字, urls] of [
    ["中日韩文", ["/", "/celebrity/周杰伦", "/celebrity/林俊杰", "/celebrity/蔡依林", "/history"]],
    ["不透明短码", ["/", "/u/WnBzdg", "/u/Kj28dQ", "/u/Zp91xC", "/history"]],
    ["查询串路由", ["/", "/p?id=a1", "/p?id=b2", "/p?id=c3", "/history"]],
    ["深层路径", ["/", "/x/y/z/1", "/x/y/z/2", "/x/y/z/3", "/history"]],
  ]) {
    const { rendered } = crawl(urls);
    assert.ok(rendered.includes("/history"), `${名字}：/history 必须被渲染，实测 ${rendered.join(" ")}`);
  }
});

test("预算耗尽是唯一允许漏掉族的理由", () => {
  const { rendered, reason } = crawl(["/a", "/b", "/c", "/d", "/e"], { maxRenders: 2 });
  assert.equal(reason, "max-renders");
  assert.equal(rendered.length, 2, "只有渲染预算耗尽才允许停在没覆盖完的状态");
});

test("队列排空时正常结束，不误报饱和", () => {
  const { reason } = crawl(["/a", "/b"]);
  assert.equal(reason, "empty");
});

/* ── Redirect aliases ───────────────────────────────────────────────── */

const knowledge = await import(`data:text/javascript;base64,${Buffer.from((await build({
  entryPoints: [fileURLToPath(new URL("../lib/site-knowledge/crawl-knowledge.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false,
})).outputFiles[0].text).toString("base64")}`);

/** The frontier normalizes URLs (CJK segments get percent-encoded), so mock keys must be normalized too. */
function renderMap(entries) {
  return new Map(entries.map(([url, snapshot]) => [new URL(url).toString(), snapshot]));
}

function snapshotOf(url, links = []) {
  return {
    id: `s${url}`, sessionId: "crawl", documentId: url, sequence: 1,
    url, title: url, heading: url,
    visibleText: `${url} 的正文，成段文字，足够长到能被当作一段正文来对待。`,
    links: links.map((href) => ({ text: href, url: href })),
    elements: [], capturedAt: "2026-08-15T00:00:00.000Z",
  };
}

test("跳转别名不会变成幽灵场景", async () => {
  const rendered = new Map([
    [`${ORIGIN}/`, snapshotOf(`${ORIGIN}/`, [`${ORIGIN}/about`, `${ORIGIN}/history`])],
    [`${ORIGIN}/about`, snapshotOf(`${ORIGIN}/about`, [`${ORIGIN}/history`])],
    // /history 302s to the home page: the snapshot url is the landing page
    [`${ORIGIN}/history`, snapshotOf(`${ORIGIN}/`, [`${ORIGIN}/about`])],
  ]);
  const doc = await knowledge.crawlSiteKnowledge({
    siteAgentId: "t", origin: ORIGIN, crawledAt: "2026-08-15T00:00:00.000Z",
    seeds: [`${ORIGIN}/`],
    frontier: new CrawlFrontier({ origin: ORIGIN }),
    renderPage: async (url) => rendered.get(new URL(url).toString()) || null,
  });
  const paths = doc.scenes.map((scene) => scene.urlTemplates[0]?.pathnamePattern).sort();
  assert.ok(!paths.includes("/history"),
    `/history 会跳转到首页，永远不会有自己的页面，不该单独立场景（实测场景：${paths.join(" ")}）`);
  assert.ok(paths.includes("/about"), "真实页面仍要成场景");
  assert.equal(doc.scenes.filter((scene) => scene.urlTemplates[0]?.pathnamePattern === "/").length, 1,
    "落地页被抓了两遍（直接一次、经别名一次），场景不能因此重复");
});

test("归纳族模式必须有共同父路径——否则所有顶层页会被并成一族", () => {
  // /about and /methodology differ only in the first segment; static pages sharing a
  // layout is normal, so structures often match. Inducing /{*} from that would make
  // /history "covered" and never opened. It really happened in production.
  const { rendered } = crawl(["/", "/about", "/methodology", "/history", "/terms", "/compare"], {
    structureOf: () => "sig-same",   // 极端情况：全站顶层页结构完全相同
  });
  for (const path of ["/about", "/methodology", "/history", "/terms", "/compare"]) {
    assert.ok(rendered.includes(path), `${path} 必须被渲染，实测只渲染了 ${rendered.join(" ")}`);
  }
});

test("有共同父路径时仍照常归纳", () => {
  const { rendered } = crawl(["/", ...latinNames.map((n) => `/celebrity/${n}`), "/about"], {
    structureOf: (path) => (path.startsWith("/celebrity/") ? "sig-celebrity" : `sig${path}`),
  });
  assert.ok(rendered.filter((p) => p.startsWith("/celebrity/")).length <= 3);
});

/* ── Scene status must reflect whether it was actually crawled ──────── */

test("渲染过的网址匹配到的场景不得停在未验证", async () => {
  const rendered = new Map([
    // The home page links to /daily/year, and /daily/year itself was rendered
    [`${ORIGIN}/`, snapshotOf(`${ORIGIN}/`, [`${ORIGIN}/daily/year`, `${ORIGIN}/about`])],
    [`${ORIGIN}/daily/year`, snapshotOf(`${ORIGIN}/daily/year`, [`${ORIGIN}/`])],
    [`${ORIGIN}/about`, snapshotOf(`${ORIGIN}/about`, [])],
  ]);
  const doc = await knowledge.crawlSiteKnowledge({
    siteAgentId: "t", origin: ORIGIN, crawledAt: "2026-08-15T00:00:00.000Z",
    seeds: [`${ORIGIN}/`], frontier: new CrawlFrontier({ origin: ORIGIN }),
    renderPage: async (url) => rendered.get(new URL(url).toString()) || null,
  });
  for (const scene of doc.scenes) {
    const path = scene.urlTemplates[0]?.pathnamePattern;
    if (path !== "/daily/year") continue;
    assert.notEqual(scene.evidenceStatus, "referenced",
      "这一页实际渲染过，却因为场景是从链接建的而停在未验证——console 还写着『重新爬取后确认』，是做不到的承诺");
  }
});

test("确认是错误页的链接目标不再被建成场景（HTTP 状态码优先）", async () => {
  // Use the 404 status, not the title wording: the production page said "页面没找到"
  // while the word list had "页面未找到" — one character off, missed, and a ghost scene
  // named "页面没找到" was created.
  const errorPage = { ...snapshotOf(`${ORIGIN}/daily/year`, []), httpStatus: 404 };
  const rendered = new Map([
    [`${ORIGIN}/`, snapshotOf(`${ORIGIN}/`, [`${ORIGIN}/daily/year`, `${ORIGIN}/about`])],
    [`${ORIGIN}/daily/year`, errorPage],
    [`${ORIGIN}/about`, snapshotOf(`${ORIGIN}/about`, [])],
  ]);
  const doc = await knowledge.crawlSiteKnowledge({
    siteAgentId: "t", origin: ORIGIN, crawledAt: "2026-08-15T00:00:00.000Z",
    seeds: [`${ORIGIN}/`], frontier: new CrawlFrontier({ origin: ORIGIN }),
    renderPage: async (url) => rendered.get(new URL(url).toString()) || null,
  });
  const paths = doc.scenes.map((scene) => scene.urlTemplates[0]?.pathnamePattern);
  assert.ok(!paths.includes("/daily/year"),
    `软 404 的链接目标不该建场景（生产上出现过一个名字就叫"页面没找到"的场景）；实测：${paths.join(" ")}`);
  assert.ok(paths.includes("/about"));
});

test("错误页判定以 HTTP 状态码为准，标题词表只兜底", async () => {
  const urlScene = await import(`data:text/javascript;base64,${Buffer.from((await build({
    entryPoints: [fileURLToPath(new URL("../lib/site-knowledge/url-scene.ts", import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
  })).outputFiles[0].text).toString("base64")}`);
  const { isErrorPage } = urlScene;
  assert.equal(isErrorPage({ title: "正常页面", heading: "正常页面", httpStatus: 404 }), true,
    "状态码说了不是页面，标题写什么都不算数——这是唯一不依赖语言的信号");
  assert.equal(isErrorPage({ title: "正常页面", heading: "正常页面", httpStatus: 200 }), false);
  // Fallback word list: the production wording is "页面没找到", not the list's original "页面未找到"
  assert.equal(isErrorPage({ title: "页面没找到", heading: "" }), true);
  assert.equal(isErrorPage({ title: "页面未找到", heading: "" }), true);
  assert.equal(isErrorPage({ title: "Page Not Found", heading: "" }), true);
  assert.equal(isErrorPage({ title: "每日热搜归档", heading: "微博热搜历史日榜" }), false,
    "正常页面不得被误判");
});

test("实例的字面场景并进它所属的参数化场景", async () => {
  // /celebrity/{path1} clustered from Chinese-name instances (short Latin names do not cluster); /celebrity/Jay was not rendered this time
  const rendered = renderMap([
    [`${ORIGIN}/`, snapshotOf(`${ORIGIN}/`, [`${ORIGIN}/celebrity/周杰伦`, `${ORIGIN}/celebrity/林俊杰`, `${ORIGIN}/celebrity/Jay`])],
    [`${ORIGIN}/celebrity/周杰伦`, snapshotOf(`${ORIGIN}/celebrity/周杰伦`, [])],
    [`${ORIGIN}/celebrity/林俊杰`, snapshotOf(`${ORIGIN}/celebrity/林俊杰`, [])],
  ]);
  const doc = await knowledge.crawlSiteKnowledge({
    siteAgentId: "t", origin: ORIGIN, crawledAt: "2026-08-15T00:00:00.000Z",
    seeds: [`${ORIGIN}/`], frontier: new CrawlFrontier({ origin: ORIGIN, maxPerTemplate: 2 }),
    renderPage: async (url) => rendered.get(new URL(url).toString()) || null,
  });
  const paths = doc.scenes.map((scene) => scene.urlTemplates[0]?.pathnamePattern);
  assert.ok(!paths.includes("/celebrity/Jay"),
    `没渲染过的实例不该单独立场景，它属于 /celebrity/{path1}；实测：${paths.join(" ")}`);
  assert.ok(paths.some((path) => path?.startsWith("/celebrity/{")), "族场景必须还在");
});

test("渲染过的页面即使匹配某个参数化模板也保留独立身份", async () => {
  // /daily/month is an index page matched by /daily/{path1}, but it was rendered itself → must not be folded
  const rendered = new Map([
    [`${ORIGIN}/`, snapshotOf(`${ORIGIN}/`, [`${ORIGIN}/daily/2026-08-01`, `${ORIGIN}/daily/2026-08-02`, `${ORIGIN}/daily/month`])],
    [`${ORIGIN}/daily/2026-08-01`, snapshotOf(`${ORIGIN}/daily/2026-08-01`, [])],
    [`${ORIGIN}/daily/2026-08-02`, snapshotOf(`${ORIGIN}/daily/2026-08-02`, [])],
    [`${ORIGIN}/daily/month`, snapshotOf(`${ORIGIN}/daily/month`, [])],
  ]);
  const doc = await knowledge.crawlSiteKnowledge({
    siteAgentId: "t", origin: ORIGIN, crawledAt: "2026-08-15T00:00:00.000Z",
    seeds: [`${ORIGIN}/`], frontier: new CrawlFrontier({ origin: ORIGIN }),
    renderPage: async (url) => rendered.get(new URL(url).toString()) || null,
  });
  const paths = doc.scenes.map((scene) => scene.urlTemplates[0]?.pathnamePattern);
  assert.ok(paths.includes("/daily/month"),
    `目录页被渲染过，有独立身份，不该并进日期族；实测：${paths.join(" ")}`);
});

test("确认是错误页的网址，连同旧场景一起退休", async () => {
  const rendered = renderMap([
    [`${ORIGIN}/`, snapshotOf(`${ORIGIN}/`, [`${ORIGIN}/topic`, `${ORIGIN}/about`])],
    [`${ORIGIN}/topic`, { ...snapshotOf(`${ORIGIN}/topic`, []), httpStatus: 404 }],
    [`${ORIGIN}/about`, snapshotOf(`${ORIGIN}/about`, [])],
  ]);
  const doc = await knowledge.crawlSiteKnowledge({
    siteAgentId: "t", origin: ORIGIN, crawledAt: "2026-08-15T00:00:00.000Z",
    seeds: [`${ORIGIN}/`], frontier: new CrawlFrontier({ origin: ORIGIN }),
    renderPage: async (url) => rendered.get(new URL(url).toString()) || null,
  });
  assert.ok(doc.deadUrls?.includes(`${ORIGIN}/topic`),
    "确认访问过且是错误页，必须作为阳性证据带出来——采纳时才敢退休早已标为『已验证』的旧场景");
  assert.ok(!doc.scenes.some((scene) => scene.urlTemplates[0]?.pathnamePattern === "/topic"));
});

test("取过、取不回来的链接目标，作为阳性证据带出来", async () => {
  // /security is a link on an anti-bot page: it reappears every crawl but never resolves.
  // It had no exit before — "did not reappear" cannot catch it, so it stayed "pending verification" forever.
  const rendered = renderMap([
    [`${ORIGIN}/`, snapshotOf(`${ORIGIN}/`, [`${ORIGIN}/security`, `${ORIGIN}/about`])],
    [`${ORIGIN}/about`, snapshotOf(`${ORIGIN}/about`, [])],
  ]);
  const doc = await knowledge.crawlSiteKnowledge({
    siteAgentId: "t", origin: ORIGIN, crawledAt: "2026-08-15T00:00:00.000Z",
    seeds: [`${ORIGIN}/`], frontier: new CrawlFrontier({ origin: ORIGIN }),
    // /security is not in rendered → unresolvable
    renderPage: async (url) => rendered.get(new URL(url).toString()) || null,
  });
  assert.ok(doc.unreachableUrls?.includes(`${ORIGIN}/security`),
    `取过但取不回来，必须列进阳性证据；实测：${JSON.stringify(doc.unreachableUrls)}`);
  assert.ok(!doc.unreachableUrls?.includes(`${ORIGIN}/about`), "取回来了的不该在名单里");
});

test("采纳侧：取不到的链接目标退休，取得到的保留", async () => {
  // retireUnseenReferencedScenes is pure; testing it directly beats assembling a crawl document that passes the validator.
  const bundle = await build({
    stdin: {
      contents: 'export { retireUnseenReferencedScenes } from "./db/site-agent-store.ts";',
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      sourcefile: "retire-scenes.ts",
      loader: "ts",
    },
    bundle: true, platform: "node", format: "esm", write: false,
  });
  const { retireUnseenReferencedScenes } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

  const referenced = (id, path) => ({
    id, name: id, evidenceStatus: "referenced", lifecycle: "referenced", directEntry: "candidate",
    evidence: { linkLabels: [id], observedUrls: [], titles: [], headings: [] },
    urlTemplates: [{ id: `u-${id}`, originPattern: ORIGIN, pathnamePattern: path, query: {} }],
    parameters: [], verifier: {}, sourceObservationIds: [], updatedAt: "2026-08-21T00:00:00.000Z",
  });
  const blocked = referenced("blocked", "/security");
  const reachable = referenced("reachable", "/guides");
  const verified = { ...referenced("verified", "/about"), evidenceStatus: "entry-verified", directEntry: "verified" };

  // Both reappear in this crawl (as links), so the "did not reappear" rule cannot catch them.
  const incoming = [blocked, reachable];
  const kept = retireUnseenReferencedScenes(
    [blocked, reachable, verified], incoming, [], [`${ORIGIN}/security`],
  ).map((scene) => scene.id);

  assert.ok(!kept.includes("blocked"),
    `取过、取不回来的链接目标必须退休——它每次都作为链接回来，重爬改变不了什么，console 却一直写着「待访问验证」；实测：${kept.join(" ")}`);
  assert.ok(kept.includes("reachable"), `取得到的链接目标要保留；实测：${kept.join(" ")}`);
  assert.ok(kept.includes("verified"), `已验证的场景一律保留——一次取不到可能只是超时；实测：${kept.join(" ")}`);
});
