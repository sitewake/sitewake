/**
 * Persistence regression for observation records and data-page type descriptions.
 *
 * These two fields are the baselines of the comparison layers: the cross-time layer
 * needs observation records to accumulate "twice in a row", and a type description
 * decided by the cross-instance layer must not be erased when only one instance
 * renders. `buildCrawlAdoption` rebuilds the release field by field — it once omitted
 * these two, the whole pipeline stayed green and production stored nothing. So this
 * asserts what the real persistence path reads back, not the module's return value.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";

let sequence = 0;

async function isolatedStore(t) {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `crawl-observation-${++sequence}` },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB");
  const key = `__CRAWL_OBSERVATION_D1_${sequence}`;
  globalThis[key] = database;
  try {
    const result = await build({
      stdin: {
        contents: `
          export { createSiteAgent, adoptCrawlDocument, getActiveSiteAgentRelease, ingestSiteContentPages, enqueueCrawlJob, leaseRunnerWork, registerValidationRunner, readPageObservations, writePageObservations, completeCrawlJob } from "./db/site-agent-store.ts";
          export { assembleSiteKnowledgeDocument } from "./lib/site-knowledge/crawl-knowledge.ts";
        `,
        resolveDir: fileURLToPath(new URL("..", import.meta.url)),
        sourcefile: `crawl-observation-${sequence}.ts`,
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      plugins: [{
        name: "isolated-crawl-observation-d1",
        setup(builder) {
          builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
            contents: `const database=globalThis[${JSON.stringify(key)}]; export function getD1Binding(){return database;} export function getArtifactBinding(){return null;} export class D1UnavailableError extends Error {}`,
            loader: "ts",
          }));
        },
      }],
    });
    // Must await: the bundle reads the D1 handle on globalThis at evaluation, and finally removes it.
    return await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  } finally {
    delete globalThis[key];
  }
}

const ORIGIN = "https://sample.test";

function snapshot(path, heading, sequenceIndex) {
  return {
    id: `crawl_${sequenceIndex}`,
    sessionId: "crawl",
    documentId: `document-${sequenceIndex}`,
    sequence: sequenceIndex,
    url: `${ORIGIN}${path}`,
    title: heading,
    heading,
    visibleText: `${heading}\n本页说明文字，足够长到能被当作一段正文来对待。`,
    links: [],
    elements: [],
    capturedAt: "2026-08-13T08:00:00.000Z",
  };
}

/** Builds a valid crawl document and attaches the two comparison layers' outputs. */
function documentWith(store, siteAgentId, crawledAt, extra) {
  const document = store.assembleSiteKnowledgeDocument({
    siteAgentId,
    origin: ORIGIN,
    crawledAt,
    seeds: [ORIGIN],
    snapshots: [snapshot("/about", "关于我们", 1), snapshot("/terms", "服务条款", 2)],
    urlsSeen: 2,
  });
  return { ...document, ...extra };
}

const observationAt = (at, hash) => [{ at, lines: { "body>main>p.1": [hash] } }];

test("观测记录进独立表，类型描述进 release", async (t) => {
  const store = await isolatedStore(t);
  await store.createSiteAgent({ id: "obs-agent", name: "样例站", url: ORIGIN });

  await store.writePageObservations("obs-agent", {
    [`${ORIGIN}/about`]: observationAt("2026-08-13T08:00:00.000Z", "aaaaaaaa"),
    [`${ORIGIN}/terms`]: observationAt("2026-08-13T08:00:00.000Z", "bbbbbbbb"),
  }, "2026-08-13T08:00:00.000Z");
  await store.adoptCrawlDocument("obs-agent", documentWith(store, "obs-agent", "2026-08-13T08:00:00.000Z", {
    dataPageTypes: [{ urlPattern: `${ORIGIN}/celebrity/Ella`, name: "人物榜单页", description: "该人物的历史上榜记录", instanceCount: 3 }],
  }));

  const stored = await store.readPageObservations("obs-agent");
  assert.deepEqual(Object.keys(stored).sort(), [`${ORIGIN}/about`, `${ORIGIN}/terms`]);
  const { release } = await store.getActiveSiteAgentRelease("obs-agent");
  assert.equal(release.observations, undefined,
    "观测记录不得再进 release——它是抓取账本，每个版本各存一份会把 release 撑到 10 MB");
  assert.equal(release.dataPageTypes?.length, 1);
  assert.equal(release.dataPageTypes[0].name, "人物榜单页");
});

test("重爬只覆盖本次见到的网址，其余历史原样留着", async (t) => {
  const store = await isolatedStore(t);
  await store.createSiteAgent({ id: "obs-agent", name: "样例站", url: ORIGIN });

  await store.writePageObservations("obs-agent", {
    [`${ORIGIN}/about`]: observationAt("2026-08-13T08:00:00.000Z", "aaaaaaaa"),
    [`${ORIGIN}/terms`]: observationAt("2026-08-13T08:00:00.000Z", "bbbbbbbb"),
  }, "2026-08-13T08:00:00.000Z");
  await store.adoptCrawlDocument("obs-agent", documentWith(store, "obs-agent", "2026-08-13T08:00:00.000Z", {
    dataPageTypes: [{ urlPattern: `${ORIGIN}/celebrity/Ella`, name: "人物榜单页", description: "旧描述", instanceCount: 3 }],
  }));

  // The second crawl renders only /about: /terms history must not vanish because it was not crawled (one row per URL, independent).
  await store.writePageObservations("obs-agent", {
    [`${ORIGIN}/about`]: observationAt("2026-08-14T08:00:00.000Z", "cccccccc"),
  }, "2026-08-14T08:00:00.000Z");
  await store.adoptCrawlDocument("obs-agent", documentWith(store, "obs-agent", "2026-08-14T08:00:00.000Z", {}));

  const stored = await store.readPageObservations("obs-agent");
  assert.equal(stored[`${ORIGIN}/about`][0].lines["body>main>p.1"][0], "cccccccc", "本次观测到的以本次为准");
  assert.equal(stored[`${ORIGIN}/terms`][0].lines["body>main>p.1"][0], "bbbbbbbb", "本次没抓到的网址，历史必须留着");
  const { release } = await store.getActiveSiteAgentRelease("obs-agent");
  assert.equal(release.dataPageTypes?.length, 1, "只渲染到单个实例拿不到对照物，不该抹掉已判定的类型描述");
});

test("每个网址只留最近两次观测，不随重爬累积", async (t) => {
  const store = await isolatedStore(t);
  await store.createSiteAgent({ id: "obs-agent", name: "样例站", url: ORIGIN });
  const url = `${ORIGIN}/about`;
  // Three observations handed to the store, only the latest two should remain — "changed twice in a row" needs two, more is useless
  await store.writePageObservations("obs-agent", {
    [url]: [
      { at: "2026-08-15T08:00:00.000Z", lines: { "body>main>p.1": ["cccccccc"] } },
      { at: "2026-08-14T08:00:00.000Z", lines: { "body>main>p.1": ["bbbbbbbb"] } },
      { at: "2026-08-13T08:00:00.000Z", lines: { "body>main>p.1": ["aaaaaaaa"] } },
    ],
  }, "2026-08-15T08:00:00.000Z");
  const stored = await store.readPageObservations("obs-agent");
  assert.equal(stored[url].length, 2, "只留最近两次");
  assert.equal(stored[url][0].at, "2026-08-15T08:00:00.000Z");
});

test("判为没有知识的页面，旧正文要从内容库里删掉", async (t) => {
  const store = await isolatedStore(t);
  await store.createSiteAgent({ id: "obs-agent", name: "样例站", url: ORIGIN });
  const url = `${ORIGIN}/celebrity/Ella`;
  const page = (filteredText) => ({
    url,
    heading: "Ella",
    visibleText: "Ella 歌手 共上榜 27427 次 最高热度 437.0万 平均排名 12.3",
    filteredText,
  });

  const first = await store.ingestSiteContentPages("obs-agent", [page("Ella 歌手 共上榜 27427 次 最高热度 437.0万 平均排名 12.3")]);
  assert.equal(first.indexed, 1, "第一轮应正常入库，否则后面的删除断言不成立");
  assert.ok((first.contentFilter?.writtenChars ?? 0) > 0, "写入字数要算的是真正落库的那部分");

  // Unchanged pages are skipped, not rewritten — they must not count as "written this time"
  const again = await store.ingestSiteContentPages("obs-agent", [page("Ella 歌手 共上榜 27427 次 最高热度 437.0万 平均排名 12.3")]);
  assert.equal(again.indexed, 0);
  assert.equal(again.contentFilter?.writtenChars, 0,
    "没被重写的页面不计入本次写入——否则这个数会被读成知识库总量");

  // Second round: the whole class is judged data pages by the cross-instance layer,
  // body empty. Skipping the write is not enough — last round's rows would linger and
  // the knowledge base would never get clean.
  const result = await store.ingestSiteContentPages("obs-agent", [page("")]);
  assert.equal(result.contentFilter.purgedPages, 1, "空正文必须触发删除，而不是静默跳过");
  assert.equal(result.indexed, 0);
});

test("领取抓取任务时下发上两次观测记录", async (t) => {
  const store = await isolatedStore(t);
  await store.createSiteAgent({ id: "obs-agent", name: "样例站", url: ORIGIN });
  await store.writePageObservations("obs-agent", {
    [`${ORIGIN}/about`]: observationAt("2026-08-13T08:00:00.000Z", "aaaaaaaa"),
  }, "2026-08-13T08:00:00.000Z");

  await store.registerValidationRunner({ id: "runner-1", name: "测试 runner", role: "author" });
  await store.enqueueCrawlJob({ siteAgentId: "obs-agent", origin: ORIGIN });
  const leased = await store.leaseRunnerWork("runner-1", "crawl");

  assert.equal(leased.lease?.kind, "crawl");
  // This layer once failed silently as a whole: the runner reading the release itself
  // needed an admin login, the 401 was swallowed, history stayed empty, only one
  // observation ever accumulated, and "changed twice in a row" never happened.
  assert.ok(leased.lease.priorObservations, "租约必须带上历史观测，否则跨时间层不生效且不会报错");
  assert.equal(leased.lease.priorObservations[`${ORIGIN}/about`][0].lines["body>main>p.1"][0], "aaaaaaaa");
});


/**
 * Guards the invariant: **a crawl reporting success ⇒ the active version is the one it
 * produced**.
 *
 * Note this test **cannot reproduce the race** — the window is inside completeCrawlJob
 * (between reading the current version and committing) and cannot be forced from
 * outside. It guards the outcome contract: the old check looked only at the job-status
 * statement, which only verified the release row existed (inserted by this batch, so
 * always), and a failed CAS on the active pointer still counted as success. Production
 * evidence: v52 created at 05:37 sorted after v53 created at 05:36, with v53 active.
 */
test("采集报告成功时，活跃版本必须就是它产出的那一版", async (t) => {
  const store = await isolatedStore(t);
  await store.createSiteAgent({ id: "obs-agent", name: "样例站", url: ORIGIN });
  await store.registerValidationRunner({ id: "runner-1", name: "测试 runner", role: "author" });
  await store.enqueueCrawlJob({ siteAgentId: "obs-agent", origin: ORIGIN });
  const leased = await store.leaseRunnerWork("runner-1", "crawl");
  const job = leased.lease.job;

  // Simulate a concurrent publisher (widget connection report) swapping the active version before the crawl commits
  await store.adoptCrawlDocument("obs-agent", documentWith(store, "obs-agent", "2026-08-15T05:36:00.000Z", {}));
  const raced = await store.getActiveSiteAgentRelease("obs-agent");

  const result = await store.completeCrawlJob(
    "runner-1", job.lease.token, "obs-agent", job.id,
    documentWith(store, "obs-agent", "2026-08-15T05:37:00.000Z", {}),
  );

  const active = await store.getActiveSiteAgentRelease("obs-agent");
  assert.ok(result.release, "采集应当产出一个版本");
  assert.equal(active.release.id, result.release.id,
    "采集报告成功，活跃版本就必须是它，否则这一版是孤儿");
  assert.ok(active.release.version > raced.release.version,
    "采集要合并到抢先发布的那一版之上，版本号必须更大");
});
