/**
 * Birth and death of a site.
 *
 * Birth: a site is created only in `createSiteAgent`. Eleven non-create paths used to
 * create an empty site when given an unknown one — meaning one observation against a
 * random id conjured a site, and a script the user had not yet removed after deletion
 * brought the site back as an empty shell.
 *
 * First connection: the first stored connection record auto-schedules one crawl, once.
 *
 * Death: deletion clears every table, every in-memory holding and every object in
 * storage; afterwards any data-plane write gets 404 and the site is never recreated
 * implicitly.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let isolatedSequence = 0;

async function isolatedD1Database() {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `site-lifecycle-${isolatedSequence += 1}` },
  });
  return { database: await miniflare.getD1Database("DB"), dispose: () => miniflare.dispose() };
}

/**
 * Bundles an entry as ESM and loads it. `database` / `bucket` replace the bindings in
 * `db/index.ts`; memory mode passes neither. Route entries need the CommonJS shims
 * (`commonjsShims`).
 */
async function bundledModule(entry, options = {}) {
  const key = `__SITEWAKE_SITE_LIFECYCLE_${isolatedSequence += 1}`;
  globalThis[key] = { database: options.database || null, bucket: options.bucket || null };
  try {
    const result = await build({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      banner: options.commonjsShims ? { js: [
        "import { createRequire as __createRequire } from 'node:module';",
        `const require = __createRequire(${JSON.stringify(import.meta.url)});`,
        `const __filename = ${JSON.stringify(fileURLToPath(import.meta.url))};`,
        `const __dirname = ${JSON.stringify(fileURLToPath(new URL(".", import.meta.url)))};`,
      ].join("\n") } : undefined,
      plugins: [{
        name: "site-lifecycle-bindings",
        setup(builder) {
          builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
            contents: `
              const bindings = globalThis[${JSON.stringify(key)}];
              export function getD1Binding() { return bindings.database; }
              export function getArtifactBinding() { return bindings.bucket; }
              export class D1UnavailableError extends Error {}
            `,
            loader: "ts",
          }));
        },
      }],
    });
    return await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  } finally {
    // Keep the binding object: closures in the bundle still read it after import.
  }
}

function snapshot(url, title) {
  return {
    url, title, heading: title, documentId: `document-${isolatedSequence += 1}`, sequence: 0, capturedAt: "2026-09-15T00:00:00.000Z",
    links: [], elements: [], forms: [], visibleText: title, landmarks: [],
  };
}

function jsonRequest(url, body, headers = {}) {
  const request = new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  request.nextUrl = new URL(url);
  return request;
}

const GHOST = "ghost-site-never-registered";

test("对一个从未登记的 id 发数据面写入：一律 4xx，且不会凭空造出网站", async () => {
  const store = await bundledModule("../db/site-agent-store.ts");
  store.resetMemorySiteAgentStore();
  const routes = {
    observations: await bundledModule("../app/api/site-agents/[siteAgentId]/observations/route.ts", { commonjsShims: true }),
    sessions: await bundledModule("../app/api/site-agents/[siteAgentId]/sessions/route.ts", { commonjsShims: true }),
    connection: await bundledModule("../app/api/site-agents/[siteAgentId]/connection/route.ts", { commonjsShims: true }),
    content: await bundledModule("../app/api/site-agents/[siteAgentId]/content/route.ts", { commonjsShims: true }),
    episodes: await bundledModule("../app/api/site-agents/[siteAgentId]/episodes/route.ts", { commonjsShims: true }),
  };
  const base = `https://control.test/api/site-agents/${GHOST}`;
  const params = { siteAgentId: GHOST };
  const observation = { id: "transition-ghost", siteAgentId: GHOST, sessionId: "browser-ghost", steps: [], elementEvidence: [], inputBindings: {}, outputBindings: {}, startedAt: "2026-09-15T00:00:00.000Z", endedAt: "2026-09-15T00:00:01.000Z" };

  const results = {
    observations: await routes.observations.POST(jsonRequest(`${base}/observations`, { observations: [observation] }), { params }),
    sessions: await routes.sessions.POST(jsonRequest(`${base}/sessions`, { goal: "打开购物车", browserSessionId: "browser-ghost" }), { params }),
    connection: await routes.connection.POST(jsonRequest(`${base}/connection`, { snapshot: snapshot("https://ghost.test/", "Ghost") }, { origin: "https://ghost.test" }), { params }),
    content: await routes.content.POST(jsonRequest(`${base}/content`, { pages: [{ url: "https://ghost.test/", visibleText: "hello" }] }), { params }),
    episodes: await routes.episodes.POST(jsonRequest(`${base}/episodes`, {}), { params }),
  };
  // Unauthenticated paths must be an explicit 404; authenticated paths may be stopped by
  // auth first (401/403). What matters is that none of them creates the site.
  assert.equal(results.observations.status, 404, "observations");
  assert.equal(results.sessions.status, 404, "sessions");
  assert.equal(results.connection.status, 404, "connection");
  assert.equal(results.content.status, 404, "content");
  assert.ok([401, 403, 404].includes(results.episodes.status), `episodes: ${results.episodes.status}`);
  assert.equal(await store.siteAgentExists(GHOST), false);
  assert.equal((await store.listSiteAgents()).agents.some((agent) => agent.id === GHOST), false);
  assert.equal(globalThis.__SITEWAKE_SITE_AGENT_V2__?.has(GHOST), false, "memory store must not hold a ghost");
});

test("存储层：非创建路径遇到不存在的网站抛 site_agent_not_found（内存与 D1）", async () => {
  const memory = await bundledModule("../db/site-agent-store.ts");
  memory.resetMemorySiteAgentStore();
  const page = snapshot("https://ghost.test/", "Ghost");
  const attempts = (store) => [
    () => store.recordSiteAgentConnection(GHOST, { origin: "https://ghost.test", url: page.url, title: page.title, heading: page.heading, snapshot: page }),
    () => store.appendObservations(GHOST, []),
    () => store.getSiteAgentOverview(GHOST),
    () => store.getActiveSiteAgentRelease(GHOST),
    () => store.listCapabilityProjects(GHOST, {}),
    () => store.updateSiteAgent(GHOST, { agentConfig: {} }),
  ];
  for (const attempt of attempts(memory)) {
    await assert.rejects(attempt, (error) => error.code === "site_agent_not_found" && error.status === 404);
  }
  assert.equal(await memory.siteAgentExists(GHOST), false);

  const isolated = await isolatedD1Database();
  try {
    const d1 = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
    for (const attempt of attempts(d1)) {
      await assert.rejects(attempt, (error) => error.code === "site_agent_not_found" && error.status === 404);
    }
    assert.equal(await d1.siteAgentExists(GHOST), false);
    const rows = await isolated.database.prepare(`SELECT COUNT(*) AS count FROM site_agent_v2_agents WHERE id=?`).bind(GHOST).all();
    assert.equal(Number(rows.results[0].count), 0);
  } finally {
    await isolated.dispose();
  }
});

test("createSiteAgent 仍然是唯一的诞生地，创建后同样的调用都能通过", async () => {
  const store = await bundledModule("../db/site-agent-store.ts");
  store.resetMemorySiteAgentStore();
  await store.createSiteAgent({ id: "born-here", url: "https://born.test/" });
  const page = snapshot("https://born.test/", "Born");
  const result = await store.recordSiteAgentConnection("born-here", { origin: "https://born.test", url: page.url, title: page.title, heading: page.heading, snapshot: page });
  assert.equal(result.connection.origin, "https://born.test");
  assert.equal((await store.getSiteAgentOverview("born-here")).overview.id, "born-here");
});

// ---------------------------------------------------------------------------
// First-connection auto crawl — store layer
// ---------------------------------------------------------------------------

test("recordSiteAgentConnection 说得出这次握手是不是首次（内存与 D1）", async () => {
  const page = snapshot("https://first.test/", "First");
  const handshake = (store) => store.recordSiteAgentConnection("first-site", { origin: "https://first.test", url: page.url, title: page.title, heading: page.heading, snapshot: page });

  const memory = await bundledModule("../db/site-agent-store.ts");
  memory.resetMemorySiteAgentStore();
  await memory.createSiteAgent({ id: "first-site", url: "https://first.test/" });
  assert.equal((await handshake(memory)).firstConnection, true);
  assert.equal((await handshake(memory)).firstConnection, false);

  const isolated = await isolatedD1Database();
  try {
    const d1 = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
    await d1.createSiteAgent({ id: "first-site", url: "https://first.test/" });
    const first = await handshake(d1);
    assert.equal(first.firstConnection, true);
    const again = await handshake(d1);
    assert.equal(again.firstConnection, false);
    assert.equal(again.connection.connectedAt, first.connection.connectedAt, "connected_at 只在首次写入");
  } finally {
    await isolated.dispose();
  }
});

test("enqueueInitialCrawlJob 只在该网站没有任何采集任务时插入，并发也只成功一个", async () => {
  const isolated = await isolatedD1Database();
  try {
    const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
    await store.createSiteAgent({ id: "crawl-once", url: "https://once.test/" });
    const input = { siteAgentId: "crawl-once", origin: "https://once.test", seeds: ["https://once.test/"] };

    const first = await store.enqueueInitialCrawlJob(input);
    assert.equal(first.queued, true);
    assert.equal(first.job.trigger, "auto");
    assert.deepEqual(first.job.seeds, ["https://once.test/"]);
    assert.equal((await store.enqueueInitialCrawlJob(input)).queued, false, "已有任务就不再排");
    let jobs = (await store.listCrawlJobs("crawl-once")).jobs;
    assert.equal(jobs.length, 1);

    // After cancelling pending jobs, is the record still there? cancelCrawlJobs only
    // deletes unfinished ones, so the table is empty — and still no auto-schedule: it
    // happens only at the first handshake (guaranteed by the route layer); the store
    // layer verifies "any record at all means no insert". Add a failed record first.
    await store.cancelCrawlJobs("crawl-once");
    const manual = await store.enqueueCrawlJob({ siteAgentId: "crawl-once", origin: "https://once.test" });
    assert.equal(manual.job.trigger, "manual");
    await isolated.database.prepare(`UPDATE site_agent_v2_crawl_jobs SET status='failed' WHERE id=?`).bind(manual.job.id).run();
    assert.equal((await store.enqueueInitialCrawlJob(input)).queued, false, "失败的记录也算记录");

    // Concurrency: two first handshakes arrive at once
    await store.createSiteAgent({ id: "crawl-race", url: "https://race.test/" });
    const race = { siteAgentId: "crawl-race", origin: "https://race.test" };
    const results = await Promise.all([store.enqueueInitialCrawlJob(race), store.enqueueInitialCrawlJob(race)]);
    assert.equal(results.filter((result) => result.queued).length, 1);
    jobs = (await store.listCrawlJobs("crawl-race")).jobs;
    assert.equal(jobs.length, 1);
  } finally {
    await isolated.dispose();
  }
});

test("enqueueInitialCrawlJob 在内存模式下不假装排上了", async () => {
  const store = await bundledModule("../db/site-agent-store.ts");
  store.resetMemorySiteAgentStore();
  await store.createSiteAgent({ id: "memory-only", url: "https://memory.test/" });
  const result = await store.enqueueInitialCrawlJob({ siteAgentId: "memory-only", origin: "https://memory.test" });
  assert.deepEqual(result, { queued: false, persistence: "memory" });
});

test("旧格式的采集任务（没有 trigger）照常读出", async () => {
  const isolated = await isolatedD1Database();
  try {
    const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
    await store.createSiteAgent({ id: "legacy-job", url: "https://legacy.test/" });
    const legacy = { id: "crawl_legacy", siteAgentId: "legacy-job", status: "succeeded", origin: "https://legacy.test", seeds: [], attempts: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    await isolated.database.prepare(`INSERT INTO site_agent_v2_crawl_jobs (id,site_agent_id,status,lease_expires_at,attempts,job_json,result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(legacy.id, legacy.siteAgentId, legacy.status, null, 1, JSON.stringify(legacy), null, legacy.createdAt, legacy.updatedAt).run();
    const jobs = (await store.listCrawlJobs("legacy-job")).jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].trigger, undefined);
  } finally {
    await isolated.dispose();
  }
});

test("initialCrawlSeeds：同源取入口地址，跨源取握手页面，入口缺失取握手页面", async () => {
  const { initialCrawlSeeds } = await bundledModule("../lib/site-knowledge/initial-crawl.ts");
  assert.deepEqual(initialCrawlSeeds("https://shop.test/cart", "https://shop.test/"), ["https://shop.test/"]);
  assert.deepEqual(initialCrawlSeeds("https://shop.test/cart", "https://www.shop.test/"), ["https://shop.test/cart"]);
  assert.deepEqual(initialCrawlSeeds("https://shop.test/cart", undefined), ["https://shop.test/cart"]);
  assert.deepEqual(initialCrawlSeeds("https://shop.test/cart", "not a url"), ["https://shop.test/cart"]);
  assert.deepEqual(initialCrawlSeeds("not a url", "https://shop.test/"), []);
});

test("首次采集与首次握手的 SQL 在 PostgreSQL 方言下翻译无误", async () => {
  const { postgresSql } = await import("../db/postgres-adapter.ts");
  const insert = postgresSql(`INSERT INTO site_agent_v2_crawl_jobs (id,site_agent_id,status,lease_expires_at,attempts,job_json,result_json,created_at,updated_at)
    SELECT ?,?,?,NULL,0,?,NULL,?,? WHERE NOT EXISTS (SELECT 1 FROM site_agent_v2_crawl_jobs WHERE site_agent_id=?)`);
  assert.match(insert, /SELECT \$1,\$2,\$3,NULL,0,\$4,NULL,\$5,\$6 WHERE NOT EXISTS \(SELECT 1 FROM site_agent_v2_crawl_jobs WHERE site_agent_id=\$7\)/);
  const upsert = postgresSql(`INSERT INTO site_agent_v2_connections (site_agent_id, origin, url, title, heading, connected_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(site_agent_id) DO UPDATE SET origin=excluded.origin,last_seen_at=excluded.last_seen_at
      RETURNING connected_at AS connectedAt`);
  assert.match(upsert, /RETURNING connected_at AS "connectedAt"/, "camelCase 别名必须加引号，否则 Postgres 会折成小写");
});

// ---------------------------------------------------------------------------
// First-connection auto crawl — handshake route
// ---------------------------------------------------------------------------

/** A cross-origin site handshake: the origin header matches the snapshot URL and is registered in allowedOrigins. */
async function handshakeVia(route, siteAgentId, pageUrl) {
  const request = jsonRequest(`https://control.test/api/site-agents/${siteAgentId}/connection`, { snapshot: snapshot(pageUrl, "Page") }, { origin: new URL(pageUrl).origin });
  const response = await route.POST(request, { params: { siteAgentId } });
  return { status: response.status, body: await response.json() };
}

/** Makes statements with the given SQL prefix throw on run(); everything else passes through. */
function failingDatabase(database, pattern) {
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql) => {
          if (pattern.test(sql)) {
            return { bind() { return this; }, run: async () => { throw new Error("injected_crawl_insert_failure"); }, all: async () => { throw new Error("injected_crawl_insert_failure"); } };
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("首次握手排一条自动采集；再次握手不新增；响应形状不变", async () => {
  const isolated = await isolatedD1Database();
  try {
    const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
    const route = await bundledModule("../app/api/site-agents/[siteAgentId]/connection/route.ts", { database: isolated.database, commonjsShims: true });
    await store.createSiteAgent({ id: "auto-crawl-site", url: "https://auto.test/" });

    const first = await handshakeVia(route, "auto-crawl-site", "https://auto.test/pricing");
    assert.equal(first.status, 200);
    assert.deepEqual(Object.keys(first.body).sort(), ["connection", "knowledgeReview", "persistence", "release"], "握手响应的键集合不变");
    let jobs = (await store.listCrawlJobs("auto-crawl-site")).jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].trigger, "auto");
    assert.equal(jobs[0].origin, "https://auto.test");
    assert.deepEqual(jobs[0].seeds, ["https://auto.test/"], "入口地址同源，种子取入口地址");
    assert.equal(jobs[0].status, "queued");

    const second = await handshakeVia(route, "auto-crawl-site", "https://auto.test/about");
    assert.equal(second.status, 200);
    jobs = (await store.listCrawlJobs("auto-crawl-site")).jobs;
    assert.equal(jobs.length, 1, "之后的每次页面加载都不再排队");
  } finally {
    await isolated.dispose();
  }
});

test("登记后先手动排过采集，首次握手不再自动排", async () => {
  const isolated = await isolatedD1Database();
  try {
    const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
    const route = await bundledModule("../app/api/site-agents/[siteAgentId]/connection/route.ts", { database: isolated.database, commonjsShims: true });
    await store.createSiteAgent({ id: "manual-first", url: "https://manual.test/" });
    await store.enqueueCrawlJob({ siteAgentId: "manual-first", origin: "https://manual.test" });
    const result = await handshakeVia(route, "manual-first", "https://manual.test/");
    assert.equal(result.status, 200);
    const jobs = (await store.listCrawlJobs("manual-first")).jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].trigger, "manual");
  } finally {
    await isolated.dispose();
  }
});

test("采集任务插入失败时握手照常成功，连接记录已登记", async () => {
  const isolated = await isolatedD1Database();
  try {
    const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
    await store.createSiteAgent({ id: "fragile-queue", url: "https://fragile.test/" });
    const broken = failingDatabase(isolated.database, /INSERT INTO site_agent_v2_crawl_jobs/);
    const route = await bundledModule("../app/api/site-agents/[siteAgentId]/connection/route.ts", { database: broken, commonjsShims: true });
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => { errors.push(args); };
    try {
      const result = await handshakeVia(route, "fragile-queue", "https://fragile.test/");
      assert.equal(result.status, 200);
      assert.equal(result.body.connection.origin, "https://fragile.test");
    } finally {
      console.error = originalError;
    }
    assert.ok(errors.some((args) => args[0] === "initial_crawl_enqueue_failed"), "故障要记到日志");
    assert.equal((await store.getSiteAgentOverview("fragile-queue")).overview.connection?.origin, "https://fragile.test");
    assert.equal((await store.listCrawlJobs("fragile-queue")).jobs.length, 0);
  } finally {
    await isolated.dispose();
  }
});

test("端到端：API 登记 → SDK 首次握手 → 采集排队，来源与种子正确", async () => {
  const isolated = await isolatedD1Database();
  try {
    const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
    const createRoute = await bundledModule("../app/api/site-agents/route.ts", { database: isolated.database, commonjsShims: true });
    const connectionRoute = await bundledModule("../app/api/site-agents/[siteAgentId]/connection/route.ts", { database: isolated.database, commonjsShims: true });
    // Site creation requires same-origin admin write access; in local dev the console origin is the request origin.
    const previousLocalDev = process.env.SITEWAKE_LOCAL_DEV;
    process.env.SITEWAKE_LOCAL_DEV = "1";
    try {
      const created = await createRoute.POST(jsonRequest("https://control.test/api/site-agents", { id: "e2e-site", name: "E2E", url: "https://e2e.test/start" }, { origin: "https://control.test" }));
      assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
    } finally {
      if (previousLocalDev === undefined) delete process.env.SITEWAKE_LOCAL_DEV; else process.env.SITEWAKE_LOCAL_DEV = previousLocalDev;
    }
    assert.equal((await store.listCrawlJobs("e2e-site")).jobs.length, 0, "登记本身不排采集");
    const handshake = await handshakeVia(connectionRoute, "e2e-site", "https://e2e.test/deep/page");
    assert.equal(handshake.status, 200);
    const jobs = (await store.listCrawlJobs("e2e-site")).jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].origin, "https://e2e.test");
    assert.deepEqual(jobs[0].seeds, ["https://e2e.test/start"]);
  } finally {
    await isolated.dispose();
  }
});

// ---------------------------------------------------------------------------
// Site deletion — store layer
// ---------------------------------------------------------------------------

const SITE = "doomed-site";
const OTHER = "bystander-site";

/** In-memory bucket: records every delete; keys matching `failOn` make delete throw. */
function memoryBucket(options = {}) {
  const objects = new Map();
  const deleted = [];
  return {
    objects, deleted,
    async put(key, value) { objects.set(key, value); },
    async get(key) { return objects.has(key) ? { body: null, size: 0 } : null; },
    async delete(key) {
      if (options.failOn && options.failOn.test(key)) throw new Error("bucket_unavailable");
      deleted.push(key); objects.delete(key);
    },
  };
}

/** The tables and columns the real database has right now — more reliable than parsing the schema source; ALTER-added columns are included. */
async function liveTables(database) {
  const names = (await database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all()).results.map((row) => row.name);
  const tables = [];
  for (const name of names) {
    const columns = (await database.prepare(`PRAGMA table_info(${name})`).all()).results.map((row) => ({ name: row.name, type: String(row.type || "").toLowerCase(), notNull: Boolean(row.notnull), pk: Boolean(row.pk), hasDefault: row.dflt_value !== null }));
    tables.push({ name, columns });
  }
  return tables;
}

const siteColumn = (table) => table.columns.find((column) => column.name === "site_agent_id" || column.name === "site_id")?.name;
const childColumn = (table) => table.columns.find((column) => column.name === "run_id" || column.name === "artifact_id")?.name;

/**
 * Seeds every site-keyed table with one row for SITE and one for OTHER; run/artifact-
 * keyed child tables get one row pointing at SITE's run/artifact and one at OTHER's.
 * Object keys follow each module's prefix convention, plus one out-of-scope key to
 * verify "never delete someone else's".
 */
async function seedEverySiteTable(database, bucket) {
  const tables = await liveTables(database);
  const runIds = { [SITE]: `run-${SITE}`, [OTHER]: `run-${OTHER}` };
  const artifactIds = { [SITE]: `artifact-${SITE}`, [OTHER]: `artifact-${OTHER}` };
  const seeded = { site: [], child: [] };
  let sequence = 0;
  const value = (table, column, owner, extra = "") => {
    sequence += 1;
    if (column.name === "site_agent_id" || column.name === "site_id") return owner;
    if (column.name === "run_id") return runIds[owner];
    if (column.name === "artifact_id") return artifactIds[owner];
    if (table.name === "site_agent_v3_agent_runs" && column.name === "id") return runIds[owner];
    if (table.name === "site_agent_v2_artifacts" && column.name === "id") return artifactIds[owner];
    if (column.name === "object_key") return `${owner}/${table.name}/${sequence}`;
    if (column.name === "storage_key") return `ccv2/${owner}/${table.name}/${sequence}`;
    if (column.type.includes("int") || column.type.includes("real") || column.type.includes("numeric")) return sequence;
    if (column.type.includes("blob") || column.type.includes("bytea")) return new Uint8Array([1, 2, 3]);
    return `${table.name}:${column.name}:${owner}:${sequence}${extra}`;
  };
  for (const table of tables) {
    const keyed = siteColumn(table) ? "site" : childColumn(table) ? "child" : undefined;
    if (!keyed) continue;
    for (const owner of [SITE, OTHER]) {
      const columns = table.columns;
      const values = columns.map((column) => value(table, column, owner));
      await database.prepare(`INSERT INTO ${table.name} (${columns.map((column) => column.name).join(",")}) VALUES (${columns.map(() => "?").join(",")})`).bind(...values).run();
      for (const column of columns) {
        if (column.name === "object_key" || column.name === "storage_key") await bucket.put(values[columns.indexOf(column)], new Uint8Array([9]));
      }
    }
    seeded[keyed].push(table.name);
  }
  // An out-of-scope key: the row belongs to SITE but the object sits under someone else's prefix.
  await database.prepare(`INSERT INTO ccv2_program_modules (site_id,content_hash,source_text,storage_key,size,created_at) VALUES (?,?,?,?,?,?)`)
    .bind(SITE, "foreign-hash", "export {}", `ccv2/${OTHER}/stolen-module`, 9, "2026-09-15T00:00:00.000Z").run();
  await bucket.put(`ccv2/${OTHER}/stolen-module`, new Uint8Array([9]));
  return { tables, seeded, runIds, artifactIds };
}

async function rowsFor(database, table, owner, runIds, artifactIds) {
  const column = siteColumn(table) || childColumn(table);
  const key = column === "run_id" ? runIds[owner] : column === "artifact_id" ? artifactIds[owner] : owner;
  const result = await database.prepare(`SELECT COUNT(*) AS count FROM ${table.name} WHERE ${column}=?`).bind(key).all();
  return Number(result.results[0].count);
}

/** Row counts per site in every relevant table — createSiteAgent writes some rows itself (release), so compare against a snapshot. */
async function countSnapshot(database, tables, runIds, artifactIds) {
  const counts = {};
  for (const table of tables) {
    if (!siteColumn(table) && !childColumn(table)) continue;
    if (table.name === "site_agent_v2_agents") continue;
    counts[table.name] = { [SITE]: await rowsFor(database, table, SITE, runIds, artifactIds), [OTHER]: await rowsFor(database, table, OTHER, runIds, artifactIds) };
  }
  return counts;
}

async function preparedDatabase(bucket) {
  const isolated = await isolatedD1Database();
  const schema = await bundledModule("../db/site-agent-schema.ts", { database: isolated.database });
  const ccv2Schema = await bundledModule("../db/capability-center-v2-schema.ts", { database: isolated.database });
  await schema.ensureSiteAgentV2Schema(isolated.database);
  await schema.ensureSiteAgentV3Schema(isolated.database);
  await ccv2Schema.ensureCapabilityCenterV2Schema(isolated.database);
  const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database, bucket });
  const deletion = await bundledModule("../db/site-agent-deletion.ts", { database: isolated.database, bucket });
  await store.createSiteAgent({ id: SITE, url: "https://doomed.test/" });
  await store.createSiteAgent({ id: OTHER, url: "https://bystander.test/" });
  return { isolated, store, deletion };
}

test("删除计划覆盖 schema 里每一张以网站、运行或产物为键的表", async () => {
  const isolated = await isolatedD1Database();
  try {
    const schema = await bundledModule("../db/site-agent-schema.ts", { database: isolated.database });
    const ccv2Schema = await bundledModule("../db/capability-center-v2-schema.ts", { database: isolated.database });
    await schema.ensureSiteAgentV2Schema(isolated.database);
    await schema.ensureSiteAgentV3Schema(isolated.database);
    await ccv2Schema.ensureCapabilityCenterV2Schema(isolated.database);
    const deletion = await bundledModule("../db/site-agent-deletion.ts", { database: isolated.database });
    // Recording fake database: collects SQL, executes nothing.
    const recorded = [];
    const recorder = { prepare(sql) { recorded.push(sql); return { bind() { return this; } }; } };
    deletion.siteAgentDeletionPlan(recorder, SITE);
    const tables = await liveTables(isolated.database);
    // Tables not owned by a single site: the site row is deleted last by the orchestrator; the rest are org-level or global records.
    const exempt = new Set(["site_agent_v2_agents", "site_agent_v2_meta", "site_agent_v3_meta", "site_agent_v2_runners", "site_agent_v2_runner_instances", "site_agent_v2_runner_pools", "site_access_v1_meta", "site_access_v1_policy"]);
    const missing = [];
    for (const table of tables) {
      if (exempt.has(table.name)) continue;
      const keyed = siteColumn(table) || childColumn(table);
      assert.ok(keyed, `${table.name} 既不以网站为键也不是从属表，要么登记清理器要么加进豁免名单`);
      if (!recorded.some((sql) => new RegExp(`DELETE FROM ${table.name}\\b`).test(sql))) missing.push(table.name);
    }
    assert.deepEqual(missing, [], "这些表没有任何模块交出删除语句");
  } finally {
    await isolated.dispose();
  }
});

test("D1：删除清掉每一张表里属于该网站的行、对象存储里的对象，旁观网站分毫不动，主行最后删", async () => {
  const bucket = memoryBucket();
  const { isolated, store, deletion } = await preparedDatabase(bucket);
  try {
    const { tables, seeded, runIds, artifactIds } = await seedEverySiteTable(isolated.database, bucket);
    assert.ok(seeded.site.length > 40, `site-keyed tables seeded: ${seeded.site.length}`);
    assert.ok(seeded.child.length >= 4, `child tables seeded: ${seeded.child.join(",")}`);
    const objectsBefore = bucket.objects.size;
    const before = await countSnapshot(isolated.database, tables, runIds, artifactIds);
    for (const [name, counts] of Object.entries(before)) assert.ok(counts[SITE] >= 1, `${name} 没有种上该网站的行`);

    // Observe batch order: the site row must be last.
    const batches = [];
    const observed = new Proxy(isolated.database, {
      get(target, property, receiver) {
        if (property === "batch") return async (statements) => { batches.push(statements.map((statement) => statement.__sql)); return target.batch(statements); };
        if (property === "prepare") return (sql) => {
          // D1's bind() returns a new statement object, so the bound result must be wrapped too to carry the SQL along.
          const wrap = (item) => new Proxy(item, { get(t, p, r) {
            if (p === "__sql") return sql;
            const v = Reflect.get(t, p, r);
            if (p === "bind") return (...args) => wrap(v.apply(t, args));
            return typeof v === "function" ? v.bind(t) : v;
          } });
          return wrap(target.prepare(sql));
        };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const observedDeletion = await bundledModule("../db/site-agent-deletion.ts", { database: observed, bucket });
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args); };
    let result;
    try { result = await observedDeletion.deleteSiteAgent(SITE); } finally { console.warn = originalWarn; }
    assert.equal(result.deleted, true);
    assert.equal(result.persistence, "d1");
    // The proxy is a new database to the schema-init cache, so a few CREATE batches come first; only look at batches containing DELETE.
    const deleteBatches = batches.filter((sqls) => sqls.some((sql) => /^DELETE FROM /.test(sql)));
    assert.equal(deleteBatches.length, 1, "所有 DELETE 在一个 batch 里");
    assert.ok(deleteBatches[0].every((sql) => /^DELETE FROM /.test(sql)), "删除批里只有 DELETE");
    assert.match(deleteBatches[0].at(-1), /^DELETE FROM site_agent_v2_agents WHERE id=\?$/, "主行是最后一条");
    assert.equal(result.statements, deleteBatches[0].length);
    console.info("site_agent_delete_batch_size", deleteBatches[0].length);

    const after = await countSnapshot(isolated.database, tables, runIds, artifactIds);
    for (const [name, counts] of Object.entries(after)) {
      assert.equal(counts[SITE], 0, `${name} 还留着该网站的行`);
      assert.equal(counts[OTHER], before[name][OTHER], `${name} 旁观网站的行被误删`);
    }
    assert.equal(await store.siteAgentExists(SITE), false);
    assert.equal(await store.siteAgentExists(OTHER), true);
    // Objects: everything under the site's prefix is gone; others (including the out-of-scope key) untouched.
    for (const key of bucket.objects.keys()) assert.ok(!key.startsWith(`${SITE}/`) && !key.startsWith(`ccv2/${SITE}/`), `对象 ${key} 还在`);
    assert.ok(bucket.objects.has(`ccv2/${OTHER}/stolen-module`), "越界键不删");
    assert.ok(warnings.some((args) => args[0] === "site_agent_delete_object_key_foreign"), "越界键要记日志");
    assert.ok(result.objects > 0 && bucket.objects.size === objectsBefore - result.objects);

    // Delete again: 404, nothing happens.
    await assert.rejects(() => deletion.deleteSiteAgent(SITE), (error) => error.code === "site_agent_not_found" && error.status === 404);
    // Idempotent: rerunning the same delete statements affects zero rows.
    const again = await isolated.database.batch(deletion.siteAgentDeletionPlan(isolated.database, SITE));
    assert.equal(again.reduce((sum, item) => sum + Number(item.meta?.changes || 0), 0), 0);
  } finally {
    await isolated.dispose();
  }
});

test("D1：对象删除失败即中止，数据库一行不动，网站仍在，可重试", async () => {
  const bucket = memoryBucket({ failOn: /site_agent_v2_artifacts/ });
  const { isolated, store, deletion } = await preparedDatabase(bucket);
  try {
    const { tables, runIds, artifactIds } = await seedEverySiteTable(isolated.database, bucket);
    const before = await countSnapshot(isolated.database, tables, runIds, artifactIds);
    await assert.rejects(() => deletion.deleteSiteAgent(SITE), (error) => error.code === "site_agent_delete_objects_failed" && error.retryable === true && error.status >= 500);
    assert.deepEqual(await countSnapshot(isolated.database, tables, runIds, artifactIds), before, "对象删除失败后数据库一行不该动");
    assert.equal(await store.siteAgentExists(SITE), true);
    assert.ok((await store.listSiteAgents()).agents.some((agent) => agent.id === SITE));
    // Retry succeeds once the bucket recovers.
    bucket.delete = async (key) => { bucket.deleted.push(key); bucket.objects.delete(key); };
    const retried = await deletion.deleteSiteAgent(SITE);
    assert.equal(retried.deleted, true);
    assert.equal(await store.siteAgentExists(SITE), false);
  } finally {
    await isolated.dispose();
  }
});

test("D1：数据库删除中途失败时整个 batch 回滚，网站与数据保持删除前的状态", async () => {
  const bucket = memoryBucket();
  const { isolated, store, deletion } = await preparedDatabase(bucket);
  try {
    const { tables, runIds, artifactIds } = await seedEverySiteTable(isolated.database, bucket);
    // Make the last statement in the batch (the site row) invalid SQL: any failure in the transaction fails the whole batch.
    const sabotaged = new Proxy(isolated.database, {
      get(target, property, receiver) {
        if (property === "prepare") return (sql) => target.prepare(sql.startsWith("DELETE FROM site_agent_v2_agents WHERE id=?") ? "DELETE FROM site_agent_v2_agents WHERE nonexistent_column=?" : sql);
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const before = await countSnapshot(isolated.database, tables, runIds, artifactIds);
    const brokenDeletion = await bundledModule("../db/site-agent-deletion.ts", { database: sabotaged, bucket });
    await assert.rejects(() => brokenDeletion.deleteSiteAgent(SITE));
    assert.deepEqual(await countSnapshot(isolated.database, tables, runIds, artifactIds), before, "batch 失败后数据库一行不该动");
    assert.equal(await store.siteAgentExists(SITE), true);
    void deletion;
  } finally {
    await isolated.dispose();
  }
});

test("删除后同 id 重新登记从零开始", async () => {
  const bucket = memoryBucket();
  const { isolated, store, deletion } = await preparedDatabase(bucket);
  try {
    await seedEverySiteTable(isolated.database, bucket);
    await deletion.deleteSiteAgent(SITE);
    await store.createSiteAgent({ id: SITE, url: "https://reborn.test/" });
    const overview = (await store.getSiteAgentOverview(SITE)).overview;
    assert.equal(overview.connection, undefined, "没有连接记录");
    assert.equal(overview.activeRelease.version, 0, "知识版本回到初始");
    assert.equal(overview.activeRelease.scenes.length, 0);
    assert.equal((await store.listCapabilityProjects(SITE, {})).projects.length, 0);
    assert.equal((await store.listCrawlJobs(SITE)).jobs.length, 0);
  } finally {
    await isolated.dispose();
  }
});

test("内存模式：每个模块的内存持有都清干净，旁观网站不受影响", async () => {
  const store = await bundledModule("../db/site-agent-store.ts");
  const deletion = await bundledModule("../db/site-agent-deletion.ts");
  const runStore = await bundledModule("../db/agent-run-store.ts");
  const capabilityStore = await bundledModule("../db/capability-center-store.ts");
  store.resetMemorySiteAgentStore();
  for (const id of [SITE, OTHER]) {
    await store.createSiteAgent({ id, url: `https://${id}.test/` });
    const page = snapshot(`https://${id}.test/`, id);
    await store.recordSiteAgentConnection(id, { origin: `https://${id}.test`, url: page.url, title: id, heading: id, snapshot: page });
    await store.createTaskSession({ id: `task-${id}`, siteAgentId: id, browserSessionId: `browser-${id}`, goal: "打开购物车", input: {}, conversation: [], nextStepIndex: 0, bindings: {}, status: "running", createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" });
    await runStore.createAgentRun({ siteAgentId: id, origin: `https://${id}.test`, url: `https://${id}.test/`, goal: "打开购物车", taskInput: {}, documentId: `document-${id}`, browserSessionId: `browser-${id}`, controller: "page-agent", requestOrigin: `https://${id}.test`, controlPlaneOrigin: `https://${id}.test` });
    await capabilityStore.createCapabilityTask(id, { type: "generate", capability: { intentKey: `intent-${id}`, name: `Cap ${id}`, description: "d", goalTemplate: "g", kind: "task", operation: "read", resultKind: "data", inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object", properties: {} }, executionRequirements: { authentication: "none", supportedEnvironments: { connectedBrowser: "supported", cloudBrowser: "supported", managedProfile: "supported" }, checkpoints: [], evidenceRefs: [] } } }).catch(() => undefined);
  }
  const result = await deletion.deleteSiteAgent(SITE);
  assert.equal(result.persistence, "memory");
  assert.equal(globalThis.__SITEWAKE_SITE_AGENT_V2__.has(SITE), false);
  assert.equal(globalThis.__SITEWAKE_SITE_AGENT_V2__.has(OTHER), true);
  assert.equal(globalThis.__SITEWAKE_CAPABILITY_CENTER_V2__?.has(SITE) ?? false, false);
  assert.ok([...(globalThis.__SITEWAKE_AGENT_RUN_V3__?.values() || [])].every((stored) => stored.run.scope.siteAgentId !== SITE));
  assert.ok([...(globalThis.__SITEWAKE_AGENT_RUN_V3__?.values() || [])].some((stored) => stored.run.scope.siteAgentId === OTHER));
  assert.equal(await store.siteAgentExists(SITE), false);
  assert.equal(await store.siteAgentExists(OTHER), true);
  await assert.rejects(() => deletion.deleteSiteAgent(SITE), (error) => error.code === "site_agent_not_found");
});

// ---------------------------------------------------------------------------
// Site deletion — API and runner
// ---------------------------------------------------------------------------

function deleteRequest(siteAgentId, headers = {}) {
  const url = `https://control.test/api/site-agents/${encodeURIComponent(siteAgentId)}`;
  const request = new Request(url, { method: "DELETE", headers: { origin: "https://control.test", ...headers } });
  request.nextUrl = new URL(url);
  return request;
}

async function withLocalDev(run) {
  const previous = process.env.SITEWAKE_LOCAL_DEV;
  process.env.SITEWAKE_LOCAL_DEV = "1";
  try { return await run(); } finally { if (previous === undefined) delete process.env.SITEWAKE_LOCAL_DEV; else process.env.SITEWAKE_LOCAL_DEV = previous; }
}

test("DELETE /api/site-agents/[id]：401 / 404 / 403 / 200 / 重复 404 / 对象存储失败 5xx 且网站仍在", async () => {
  const bucket = memoryBucket({ failOn: /flaky-object/ });
  const { isolated, store } = await preparedDatabase(bucket);
  try {
    const route = await bundledModule("../app/api/site-agents/[siteAgentId]/route.ts", { database: isolated.database, bucket, commonjsShims: true });
    await store.createSiteAgent({ id: "sandboxed", url: "https://sandboxed.test/", visibility: "sandbox" });

    // No same-origin Origin header → admin write access denied.
    const noOrigin = await route.DELETE(new Request(`https://control.test/api/site-agents/${SITE}`, { method: "DELETE" }), { params: { siteAgentId: SITE } });
    assert.equal(noOrigin.status, 401);

    await withLocalDev(async () => {
      assert.equal((await route.DELETE(deleteRequest("never-existed"), { params: { siteAgentId: "never-existed" } })).status, 404);
      assert.equal((await route.DELETE(deleteRequest("sandboxed"), { params: { siteAgentId: "sandboxed" } })).status, 403, "沙箱网站对当前账号是 forbidden");

      // Object storage delete fails: 5xx, retryable, site still exists.
      await isolated.database.prepare(`INSERT INTO site_agent_v2_artifacts (id,site_agent_id,learning_job_id,run_id,kind,object_key,artifact_json,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .bind("artifact-flaky", SITE, "job", "run", "screenshot", `${SITE}/flaky-object`, "{}", "2026-09-15T00:00:00.000Z").run();
      await bucket.put(`${SITE}/flaky-object`, new Uint8Array([1]));
      const flaky = await route.DELETE(deleteRequest(SITE), { params: { siteAgentId: SITE } });
      assert.ok(flaky.status >= 500, `status ${flaky.status}`);
      const flakyBody = await flaky.json();
      assert.equal(flakyBody.error, "site_agent_delete_objects_failed");
      assert.equal(flakyBody.retryable, true);
      assert.equal(await store.siteAgentExists(SITE), true);

      bucket.delete = async (key) => { bucket.deleted.push(key); bucket.objects.delete(key); };
      const ok = await route.DELETE(deleteRequest(SITE), { params: { siteAgentId: SITE } });
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { deleted: true, persistence: "d1" });
      assert.equal(ok.headers.get("x-sitewake-persistence"), "d1");
      assert.equal(await store.siteAgentExists(SITE), false);
      assert.equal((await route.GET(deleteRequest(SITE), { params: { siteAgentId: SITE } })).status, 404);
      assert.equal((await route.DELETE(deleteRequest(SITE), { params: { siteAgentId: SITE } })).status, 404, "第二次删除 404");
      assert.equal(await store.siteAgentExists(OTHER), true, "旁观网站还在");
    });
  } finally {
    await isolated.dispose();
  }
});

test("删除后，运行器为该网站进行中的工作回报都得到「目标不存在」，网站不会被重建", async () => {
  const bucket = memoryBucket();
  const { isolated, store, deletion } = await preparedDatabase(bucket);
  try {
    // Schedule a crawl and a screenshot job for the runner to lease.
    await store.enqueueCrawlJob({ siteAgentId: SITE, origin: "https://doomed.test" });
    await store.enqueueSitePreviewJob({ siteAgentId: SITE, origin: "https://doomed.test", url: "https://doomed.test/" });
    const registration = await store.registerValidationRunner({ id: `runner-${isolatedSequence}`, name: "Runner", role: "interactive", workKinds: ["execute"], browsers: ["chromium"], maxConcurrency: 2 });
    const control = { sessionId: registration.instance.sessionId, sessionToken: registration.sessionToken };
    const leases = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const leased = await store.leaseRunnerWork(registration.runner.id, "any", control);
      if (leased.lease) leases.push(leased.lease);
    }
    const crawlLease = leases.find((lease) => lease.kind === "crawl");
    const previewLease = leases.find((lease) => lease.kind === "site-preview");
    assert.ok(crawlLease, `crawl lease: ${JSON.stringify(leases.map((lease) => lease.kind))}`);
    assert.ok(previewLease, "site-preview lease");

    await deletion.deleteSiteAgent(SITE);

    const runnerId = registration.runner.id;
    const crawlToken = crawlLease.job.lease.token;
    const previewToken = previewLease.job.lease.token;
    const notFound = (error) => /crawl_job_missing|site_preview_job_missing|site_agent_not_found/.test(error.message);
    await assert.rejects(() => store.renewCrawlJobLease(runnerId, crawlToken, crawlLease.job.id), notFound);
    await assert.rejects(() => store.completeCrawlJob(runnerId, crawlToken, SITE, crawlLease.job.id, { scenes: [], links: [], pages: [] }), notFound);
    await assert.rejects(() => store.failCrawlJob(runnerId, crawlToken, crawlLease.job.id, "boom"), notFound);
    await assert.rejects(() => store.failSitePreviewJob(runnerId, previewToken, previewLease.job.id, "boom"), notFound);
    await assert.rejects(() => store.completeSitePreviewJob(runnerId, previewToken, previewLease.job.id, { artifactId: "a", url: "u", pageUrl: "https://doomed.test/", capturedAt: "2026-09-15T00:00:00.000Z", width: 1, height: 1, agentDetected: false, detectedSiteAgentIds: [] }), notFound);
    assert.equal(await store.siteAgentExists(SITE), false, "回报不会把网站重建出来");

    // The route layer maps all of these to 404; the runner retries only 408/429/5xx.
    const runnerHttp = await bundledModule("../app/api/validation/runners/http.ts", { database: isolated.database, commonjsShims: true });
    assert.equal(runnerHttp.runnerControlErrorStatus(Object.assign(new Error("site_agent_not_found"), { code: "site_agent_not_found" })), 404);
    const [crawlComplete, crawlRenew, previewComplete, browserRunner] = await Promise.all([
      readFile(new URL("../app/api/validation/runners/[runnerId]/crawl/complete/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/validation/runners/[runnerId]/crawl/renew/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/validation/runners/[runnerId]/site-preview/complete/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../runner/browser-runner.ts", import.meta.url), "utf8"),
    ]);
    assert.match(crawlComplete, /message === "crawl_job_missing"\s*\?\s*404/);
    assert.match(crawlRenew, /message === "crawl_job_missing" \|\| message === "site_agent_not_found" \? 404/);
    assert.match(previewComplete, /message === "site_preview_job_missing" \|\| message === "site_agent_not_found" \? 404/);
    // Retry predicate for crawl complete/fail reports: only 408 / 429 / 5xx, never 404.
    const retryPredicates = browserRunner.match(/completionError\.status === 408\s*\|\| completionError\.status === 429\s*\|\| completionError\.status >= 500/g) || [];
    assert.ok(retryPredicates.length >= 2, "采集完成与失败两条回报都用同一个重试谓词");
    assert.doesNotMatch(browserRunner, /completionError\.status === 404/, "404 不在重试名单里");
  } finally {
    await isolated.dispose();
  }
});

test("端到端：接入 → 采集 → 会话/观察/运行/证据 → 删除 → 一行不剩，残留脚本一律 404", async () => {
  const bucket = memoryBucket();
  const { isolated, store, deletion } = await preparedDatabase(bucket);
  try {
    const runStore = await bundledModule("../db/agent-run-store.ts", { database: isolated.database, bucket });
    const connection = await bundledModule("../app/api/site-agents/[siteAgentId]/connection/route.ts", { database: isolated.database, bucket, commonjsShims: true });
    const observations = await bundledModule("../app/api/site-agents/[siteAgentId]/observations/route.ts", { database: isolated.database, bucket, commonjsShims: true });
    const episodes = await bundledModule("../app/api/site-agents/[siteAgentId]/episodes/route.ts", { database: isolated.database, bucket, commonjsShims: true });
    const site = await bundledModule("../app/api/site-agents/[siteAgentId]/route.ts", { database: isolated.database, bucket, commonjsShims: true });
    const list = await bundledModule("../app/api/site-agents/route.ts", { database: isolated.database, bucket, commonjsShims: true });

    // Onboarding: first handshake → auto crawl queued.
    const handshake = await handshakeVia(connection, SITE, "https://doomed.test/");
    assert.equal(handshake.status, 200);
    assert.equal((await store.listCrawlJobs(SITE)).jobs.length, 1);
    // Sessions, observations, runs, evidence artifacts.
    await store.createTaskSession({ id: "task-doomed", siteAgentId: SITE, browserSessionId: "browser-doomed", goal: "打开购物车", input: {}, conversation: [], nextStepIndex: 0, bindings: {}, status: "running", createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" });
    await store.appendObservations(SITE, [{ id: "transition-doomed", siteAgentId: SITE, sessionId: "browser-doomed", steps: [], elementEvidence: [], inputBindings: {}, outputBindings: {}, startedAt: "2026-09-15T00:00:00.000Z", endedAt: "2026-09-15T00:00:01.000Z" }]);
    await runStore.createAgentRun({ siteAgentId: SITE, origin: "https://doomed.test", url: "https://doomed.test/", goal: "打开购物车", taskInput: {}, documentId: "document-doomed", browserSessionId: "browser-doomed", controller: "page-agent", requestOrigin: "https://doomed.test", controlPlaneOrigin: "https://doomed.test" });
    const artifact = await store.putBrowserArtifact({ siteAgentId: SITE, learningJobId: "job-doomed", runId: "run-doomed", kind: "screenshot", label: "shot", contentType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]).buffer });
    assert.ok(bucket.objects.has(`${SITE}/job-doomed/run-doomed/${artifact.id}`));

    const tables = await liveTables(isolated.database);
    const populated = [];
    for (const table of tables) {
      if (!siteColumn(table)) continue;
      const count = (await isolated.database.prepare(`SELECT COUNT(*) AS count FROM ${table.name} WHERE ${siteColumn(table)}=?`).bind(SITE).all()).results[0].count;
      if (Number(count) > 0) populated.push(table.name);
    }
    for (const expected of ["site_agent_v2_connections", "site_agent_v2_crawl_jobs", "site_agent_v2_preview_jobs", "site_agent_v2_sessions", "site_agent_v2_observations", "site_agent_v3_agent_runs", "site_agent_v2_artifacts"]) {
      assert.ok(populated.includes(expected), `${expected} 应该已有数据`);
    }

    await withLocalDev(async () => {
      assert.equal((await site.DELETE(deleteRequest(SITE), { params: { siteAgentId: SITE } })).status, 200);
    });

    for (const table of tables) {
      const column = siteColumn(table);
      if (!column) continue;
      const count = (await isolated.database.prepare(`SELECT COUNT(*) AS count FROM ${table.name} WHERE ${column}=?`).bind(SITE).all()).results[0].count;
      assert.equal(Number(count), 0, `${table.name} 还有该网站的行`);
    }
    assert.equal(bucket.objects.size, 0, "对象存储清空");
    assert.equal(Number((await isolated.database.prepare(`SELECT COUNT(*) AS count FROM site_agent_v3_run_events`).all()).results[0].count), 0);
    assert.equal(Number((await isolated.database.prepare(`SELECT COUNT(*) AS count FROM site_agent_v2_artifact_chunks`).all()).results[0].count), 0);
    // Rerun the delete statements: zero rows affected.
    const again = await isolated.database.batch(deletion.siteAgentDeletionPlan(isolated.database, SITE));
    assert.equal(again.reduce((sum, item) => sum + Number(item.meta?.changes || 0), 0), 0);

    // A leftover script keeps reporting: always 404, and the site is not in the list.
    const base = `https://control.test/api/site-agents/${SITE}`;
    const params = { siteAgentId: SITE };
    assert.equal((await handshakeVia(connection, SITE, "https://doomed.test/")).status, 404);
    assert.equal((await observations.POST(jsonRequest(`${base}/observations`, { observations: [{ id: "t2", siteAgentId: SITE, sessionId: "browser-doomed", steps: [], elementEvidence: [], inputBindings: {}, outputBindings: {}, startedAt: "2026-09-15T00:00:00.000Z", endedAt: "2026-09-15T00:00:01.000Z" }] }), { params })).status, 404);
    assert.ok([401, 404].includes((await episodes.POST(jsonRequest(`${base}/episodes`, {}), { params })).status));
    await withLocalDev(async () => {
      assert.equal((await site.GET(deleteRequest(SITE), { params })).status, 404);
      const listed = await (await list.GET(deleteRequest(""), {})).json();
      assert.ok(!listed.agents.some((agent) => agent.id === SITE));
      assert.ok(listed.agents.some((agent) => agent.id === OTHER));
    });
    assert.equal(await store.siteAgentExists(SITE), false);
  } finally {
    await isolated.dispose();
  }
});
