/**
 * Adopting the site id on the page (spec site-agents/install-id-adoption).
 *
 * After delete-and-re-add the id is re-derived from the domain while the page's snippet
 * still carries the old one: the runner sees it, the handshake can only 404. An empty
 * site may adopt that unowned id — but only one the runner itself observed at the
 * registered address, and only an empty site may.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let sequence = 0;

async function isolatedD1Database() {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `site-id-adoption-${sequence += 1}` },
  });
  return { database: await miniflare.getD1Database("DB"), dispose: () => miniflare.dispose() };
}

async function bundledModule(entry, options = {}) {
  const key = `__SITEWAKE_ADOPTION_${sequence += 1}`;
  globalThis[key] = { database: options.database || null };
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
    banner: options.commonjsShims ? { js: [
      "import { createRequire as __createRequire } from 'node:module';",
      `const require = __createRequire(${JSON.stringify(import.meta.url)});`,
      `const __filename = ${JSON.stringify(fileURLToPath(import.meta.url))};`,
      `const __dirname = ${JSON.stringify(fileURLToPath(new URL(".", import.meta.url)))};`,
    ].join("\n") } : undefined,
    plugins: [{
      name: "adoption-bindings",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
          contents: `
            const bindings = globalThis[${JSON.stringify(key)}];
            export function getD1Binding() { return bindings.database; }
            export function getArtifactBinding() { return null; }
            export class D1UnavailableError extends Error {}
          `,
          loader: "ts",
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

function snapshot(url, title) {
  return { url, title, heading: title, documentId: `document-${sequence += 1}`, sequence: 0, capturedAt: "2026-09-16T00:00:00.000Z", links: [], elements: [], forms: [], visibleText: title, landmarks: [] };
}

/** Makes the runner "see" the id on the page: schedule a preview job, lease it, complete it with detectedSiteAgentIds. */
async function observeInstallIds(store, siteAgentId, url, ids) {
  await store.enqueueSitePreviewJob({ siteAgentId, origin: new URL(url).origin, url, force: true });
  const registration = await store.registerValidationRunner({ id: `runner-${sequence += 1}`, name: "Runner", role: "interactive", workKinds: ["execute"], browsers: ["chromium"], maxConcurrency: 2 });
  const control = { sessionId: registration.instance.sessionId, sessionToken: registration.sessionToken };
  let lease;
  for (let attempt = 0; attempt < 4 && !lease; attempt += 1) {
    const leased = await store.leaseRunnerWork(registration.runner.id, "any", control);
    if (leased.lease?.kind === "site-preview" && leased.lease.job.siteAgentId === siteAgentId) lease = leased.lease;
  }
  assert.ok(lease, "preview lease");
  await store.completeSitePreviewJob(registration.runner.id, lease.job.lease.token, lease.job.id, {
    artifactId: `artifact-${sequence}`, url: "/api/artifacts/x", pageUrl: url, capturedAt: "2026-09-16T00:00:00.000Z", width: 1440, height: 900,
    agentDetected: ids.length > 0, detectedSiteAgentIds: ids,
  });
}

async function fixture() {
  const isolated = await isolatedD1Database();
  const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
  const adoption = await bundledModule("../db/site-agent-adoption.ts", { database: isolated.database });
  return { isolated, store, adoption };
}

const URL_ = "https://www.example.test/";

test("空网站沿用页面上无主的标识：新标识登记一致、旧空壳消失、之后握手即首次接入", async () => {
  const { isolated, store, adoption } = await fixture();
  try {
    // The user deleted old-site and re-added by address: got example-test; the page snippet still says old-site.
    await store.createSiteAgent({ id: "example-test", name: "Example", description: "一个示例网站", url: URL_ });
    await observeInstallIds(store, "example-test", URL_, ["old-site"]);

    const result = await adoption.adoptInstalledSiteAgentId("example-test", "old-site");
    assert.equal(result.siteAgentId, "old-site");
    assert.equal(result.replacedSiteAgentId, "example-test");
    assert.equal(await store.siteAgentExists("example-test"), false, "空壳已删除");
    const { overview } = await store.getSiteAgentOverview("old-site");
    assert.equal(overview.profile.entryUrl, URL_);
    assert.deepEqual(overview.profile.allowedOrigins, ["https://www.example.test"]);
    assert.equal(overview.profile.name, "Example");
    assert.equal(overview.profile.description, "一个示例网站");
    assert.equal(overview.connection, undefined);
    assert.equal(overview.activeRelease.version, 0);

    // The page's SDK handshakes as old-site: first connection, auto crawl queued.
    const page = snapshot(URL_, "Example");
    const handshake = await store.recordSiteAgentConnection("old-site", { origin: "https://www.example.test", url: URL_, title: "Example", heading: "Example", snapshot: page });
    assert.equal(handshake.firstConnection, true);
    const queued = await store.enqueueInitialCrawlJob({ siteAgentId: "old-site", origin: "https://www.example.test", seeds: [URL_] });
    assert.equal(queued.queued, true);
  } finally {
    await isolated.dispose();
  }
});

test("沿用的四道门：标识须被观察到、目标不能已存在、当前须为空、当前须存在", async () => {
  const { isolated, store, adoption } = await fixture();
  try {
    await store.createSiteAgent({ id: "example-test", url: URL_ });
    await store.createSiteAgent({ id: "taken", url: "https://taken.test/" });
    const rejects = (promise, code, status) => assert.rejects(promise, (error) => error.code === code && error.status === status, code);

    // No preview observation yet: the id was not observed.
    await rejects(adoption.adoptInstalledSiteAgentId("example-test", "old-site"), "site_agent_install_id_unobserved", 409);
    await observeInstallIds(store, "example-test", URL_, ["old-site", "taken"]);
    // Observed, but the target already exists.
    await rejects(adoption.adoptInstalledSiteAgentId("example-test", "taken"), "site_agent_id_taken", 409);
    // An id absent from the observation.
    await rejects(adoption.adoptInstalledSiteAgentId("example-test", "never-seen"), "site_agent_install_id_unobserved", 409);
    // Adopting itself is meaningless.
    await rejects(adoption.adoptInstalledSiteAgentId("example-test", "example-test"), "site_agent_install_id_invalid", 400);
    // The current site does not exist.
    await rejects(adoption.adoptInstalledSiteAgentId("ghost", "old-site"), "site_agent_not_found", 404);

    // Once the current site is not empty (has connected) it cannot adopt.
    const page = snapshot(URL_, "Example");
    await store.recordSiteAgentConnection("example-test", { origin: "https://www.example.test", url: URL_, title: "Example", heading: "Example", snapshot: page });
    await rejects(adoption.adoptInstalledSiteAgentId("example-test", "old-site"), "site_agent_not_fresh", 409);
    assert.equal(await store.siteAgentExists("example-test"), true, "拒绝时什么都不变");
    assert.equal(await store.siteAgentExists("old-site"), false);
  } finally {
    await isolated.dispose();
  }
});

test("有过采集任务的网站也不算空", async () => {
  const { isolated, store, adoption } = await fixture();
  try {
    await store.createSiteAgent({ id: "example-test", url: URL_ });
    await observeInstallIds(store, "example-test", URL_, ["old-site"]);
    await store.enqueueCrawlJob({ siteAgentId: "example-test", origin: "https://www.example.test" });
    await assert.rejects(adoption.adoptInstalledSiteAgentId("example-test", "old-site"), (error) => error.code === "site_agent_not_fresh");
  } finally {
    await isolated.dispose();
  }
});

test("握手路径不参与沿用：未知标识即使来源域名属于一个空网站也只是 404", async () => {
  const { isolated, store } = await fixture();
  try {
    await store.createSiteAgent({ id: "example-test", url: URL_ });
    const route = await bundledModule("../app/api/site-agents/[siteAgentId]/connection/route.ts", { database: isolated.database, commonjsShims: true });
    const url = "https://control.test/api/site-agents/old-site/connection";
    const request = new Request(url, { method: "POST", headers: { "content-type": "application/json", origin: "https://www.example.test" }, body: JSON.stringify({ snapshot: snapshot(URL_, "Example") }) });
    request.nextUrl = new URL(url);
    const response = await route.POST(request, { params: { siteAgentId: "old-site" } });
    assert.equal(response.status, 404);
    assert.equal(await store.siteAgentExists("old-site"), false);
    assert.equal(await store.siteAgentExists("example-test"), true);
  } finally {
    await isolated.dispose();
  }
});

test("POST /install-id/adopt：401 / 404 / 409 / 200", async () => {
  const { isolated, store } = await fixture();
  try {
    const route = await bundledModule("../app/api/site-agents/[siteAgentId]/install-id/adopt/route.ts", { database: isolated.database, commonjsShims: true });
    await store.createSiteAgent({ id: "example-test", url: URL_ });
    await observeInstallIds(store, "example-test", URL_, ["old-site"]);
    const call = async (id, body, headers = { origin: "https://control.test" }) => {
      const url = `https://control.test/api/site-agents/${id}/install-id/adopt`;
      const request = new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      request.nextUrl = new URL(url);
      const response = await route.POST(request, { params: { siteAgentId: id } });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    assert.equal((await call("example-test", { siteAgentId: "old-site" }, {})).status, 401, "没有同源 Origin");
    const previous = process.env.SITEWAKE_LOCAL_DEV;
    process.env.SITEWAKE_LOCAL_DEV = "1";
    try {
      assert.equal((await call("ghost", { siteAgentId: "old-site" })).status, 404);
      assert.equal((await call("example-test", {})).status, 400);
      assert.equal((await call("example-test", { siteAgentId: "never-seen" })).status, 409);
      const ok = await call("example-test", { siteAgentId: "old-site" });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.siteAgentId, "old-site");
      assert.equal(ok.body.replacedSiteAgentId, "example-test");
      assert.equal(await store.siteAgentExists("old-site"), true);
      assert.equal(await store.siteAgentExists("example-test"), false);
    } finally {
      if (previous === undefined) delete process.env.SITEWAKE_LOCAL_DEV; else process.env.SITEWAKE_LOCAL_DEV = previous;
    }
  } finally {
    await isolated.dispose();
  }
});
