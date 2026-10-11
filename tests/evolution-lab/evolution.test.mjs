import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const now = "2026-07-19T00:00:00.000Z";
const artifactsDirectory = ".evolution-lab";
const requestedCase = process.env.SITEWAKE_EVOLUTION_LAB_CASE;

async function bundledModule(entry, options = {}) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    keepNames: options.keepNames,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

function scenario(name, body) {
  return test(name, { skip: requestedCase && requestedCase !== name }, async () => {
    const started = performance.now();
    const events = [];
    const report = { name, startedAt: new Date().toISOString(), events, status: "passed", durationMs: 0 };
    try {
      await body({ event: (stage, detail = {}) => events.push({ stage, detail, atMs: Math.round(performance.now() - started) }) });
    } catch (error) {
      report.status = "failed";
      report.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) };
      throw error;
    } finally {
      report.durationMs = Math.round(performance.now() - started);
      await mkdir(artifactsDirectory, { recursive: true });
      const stem = `${artifactsDirectory}/${name.replace(/[^a-z0-9]+/gi, "-")}`;
      const json = JSON.stringify(report, null, 2);
      await writeFile(`${stem}.json`, json);
      await writeFile(`${stem}.html`, `<!doctype html><meta charset="utf-8"><title>${name}</title><style>body{margin:0;background:#10121a;color:#eef1ff;font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}main{max-width:980px;margin:40px auto;padding:28px}h1{font:700 24px system-ui;margin:0 0 8px}.ok{color:#6ee7ad}.failed{color:#fb7185}pre{white-space:pre-wrap;background:#181b26;padding:20px;border-radius:12px;border:1px solid #2d3347}</style><main><h1>Evolution Lab · ${name}</h1><p class="${report.status}">${report.status} · ${report.durationMs}ms</p><pre>${json.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre></main>`);
    }
  });
}

function fakeCrawlCdpSession() {
  const handlers = new Map();
  const commands = [];
  return {
    commands,
    session: {
      on: (event, handler) => { handlers.set(event, handler); },
      send: async (method, params) => { commands.push({ method, params }); },
    },
    emitRequestPaused: async (event) => {
      const handler = handlers.get("Fetch.requestPaused");
      assert.ok(handler, "crawl renderer registers a CDP Fetch.requestPaused handler");
      handler(event);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function snapshot(url, heading, links = []) {
  return {
    id: `snapshot-${url}`, sessionId: "lab-session", documentId: "lab-document", sequence: 1, url,
    title: heading, heading, visibleText: `${heading}\n受控测试页面内容`, links,
    elements: links.map((link) => ({ tag: "a", role: "link", accessibleName: link.text, href: link.url, attributes: { href: link.url }, cssPath: `a[href='${link.url}']` })),
    metadata: { applicationName: "Atlas Lab", description: "受控测试站" }, capturedAt: now,
  };
}

scenario("knowledge-url-topology", async ({ event }) => {
  const discovery = await bundledModule("../../lib/site-knowledge/discovery.ts");
  const canonicalize = await bundledModule("../../lib/site-knowledge/canonicalize.ts");
  const protocol = await bundledModule("../../lib/site-knowledge/protocol.ts");
  const home = snapshot("https://lab.test/", "Atlas Lab", [
    { text: "商品 甲", url: "https://lab.test/products/1001" },
    { text: "商品 乙", url: "https://lab.test/products/1002" },
    { text: "商品 丙", url: "https://lab.test/products/1003" },
    { text: "搜索耳机", url: "https://lab.test/search?q=耳机#items" },
    { text: "隐私政策", url: "https://lab.test/privacy" },
  ]);
  const first = discovery.discoverInitialKnowledge(home);
  event("facts.discovered", { scenes: first.scenes.length, references: first.linkReferences.length });
  const product = first.scenes.find((scene) => scene.urlTemplates[0].pathnamePattern === "/products/{path1}");
  assert.ok(product, "concrete IDs must cluster into one parameterized Scene");
  assert.equal(product.parameters[0].examples.length, 3);
  assert.equal(product.evidenceStatus, "referenced", "links are not observed pages");
  const release = protocol.emptyRelease("lab", now);
  release.scenes = [...first.scenes, { ...product, id: `${product.id}-legacy`, name: "path1", sourceObservationIds: ["legacy"] }];
  release.linkReferences = first.linkReferences;
  const normalized = canonicalize.canonicalizeReleaseKnowledge(release);
  event("identity.canonicalized", { scenesBefore: release.scenes.length, scenesAfter: normalized.scenes.length });
  assert.equal(normalized.scenes.filter((scene) => scene.urlTemplates[0].pathnamePattern === "/products/{path1}").length, 1);
  assert.equal(normalized.scenes.find((scene) => scene.urlTemplates[0].pathnamePattern === "/products/{path1}")?.evidenceStatus, "referenced");
});

scenario("knowledge-semantic-evidence-guard", async ({ event }) => {
  const analyzer = await bundledModule("../../lib/site-knowledge/model-analyzer.ts");
  const referenced = {
    id: "scene-help", name: "help详情", semanticSource: "program", evidenceStatus: "referenced", lifecycle: "referenced", identityConfidence: .5,
    evidence: { linkLabels: ["帮助"], observedUrls: [], titles: [], headings: [] }, urlTemplates: [{ id: "url-help", originPattern: "https://lab.test", pathnamePattern: "/help", query: {} }], parameters: [], verifier: {}, directEntry: "candidate", sourceObservationIds: [], updatedAt: now,
  };
  assert.equal(analyzer.sceneNeedsSemanticReview(referenced), false, "AI must not review a page it has never seen");
  const observed = { ...referenced, evidenceStatus: "observed", lifecycle: "observed", evidence: { ...referenced.evidence, observedUrls: ["https://lab.test/help"], titles: ["帮助"], headings: ["帮助中心"] } };
  assert.equal(analyzer.sceneNeedsSemanticReview(observed), true);
  event("semantic.reviewable", { sceneId: observed.id, evidenceStatus: observed.evidenceStatus });
  const firstHash = analyzer.sceneSemanticEvidenceHash(observed);
  const changed = { ...observed, evidence: { ...observed.evidence, headings: ["帮助中心", "配送帮助"] } };
  assert.notEqual(firstHash, analyzer.sceneSemanticEvidenceHash(changed), "new evidence must re-open semantic review");
});

scenario("capability-reuse-and-parameterization", async ({ event }) => {
  const protocol = await bundledModule("../../lib/site-knowledge/protocol.ts");
  const compiler = await bundledModule("../../lib/site-knowledge/compiler.ts");
  const release = protocol.emptyRelease("lab", now);
  const capability = {
    id: "capability-search", kind: "task", resultKind: "data", exposure: "public", name: "搜索商品", description: "按关键词返回商品结果", normalizedGoal: protocol.normalizeGoal("搜索 {keyword}"), goalTemplate: "搜索 {keyword}", aliases: ["查找商品"],
    inputs: { type: "object", properties: { keyword: { type: "string", description: "关键词" } }, required: ["keyword"] },
    outputs: { type: "object", properties: { items: { type: "array", description: "结果" }, totalCount: { type: "number" } }, required: ["items"] },
    outcomes: [], plans: [], sourceEpisodeIds: [], confidence: .9, status: "available", updatedAt: now,
  };
  release.capabilities = [capability];
  const taskSession = { id: "session", siteAgentId: "lab", browserSessionId: "browser", goal: "搜索耳机", input: { keyword: "耳机" }, conversation: [], nextStepIndex: 0, bindings: {}, status: "running", createdAt: now, updatedAt: now, expiresAt: "2030-01-01T00:00:00.000Z" };
  const page = snapshot("https://lab.test/search?q=耳机", "搜索结果");
  const episode = { schemaVersion: protocol.SITE_AGENT_SCHEMA_VERSION, id: "episode-search", siteAgentId: "lab", taskSessionId: "session", browserSessionId: "browser", documentId: "document", mode: "compiled", goal: "搜索耳机", normalizedGoal: protocol.normalizeGoal("搜索耳机"), input: { keyword: "耳机" }, capabilityId: capability.id, startedAt: now, endedAt: now, releaseId: release.id, startSnapshot: page, endSnapshot: page, transitions: [], outcome: { status: "success", code: "success", summary: "找到 3 个耳机", evidence: { capabilityUse: { fullySatisfied: true } } } };
  const result = compiler.compileEpisode({ release, candidates: [], session: taskSession }, episode);
  event("capability.reused", { directive: result.directive.type, candidates: result.candidates.length });
  assert.equal(result.candidates.length, 0, "a satisfied capability call must not create a duplicate candidate");
  assert.notEqual(result.directive.type, "learning-queued");
  const control = await bundledModule("../../lib/site-knowledge/capability-control.ts");
  const ordinal = control.projectCapabilityControl({ siteAgentId: "lab", release, candidates: [], learningJobs: [], validationJobs: [], browserRuns: [], episodes: [{ id: "e", taskSessionId: "s", goal: "查看第 3 个商品详情", input: {}, mode: "adaptive", outcome: { status: "success", code: "ok", summary: "ok", evidence: {} }, startedAt: now, endedAt: now, startUrl: "https://lab.test/", endUrl: "https://lab.test/products/3" }] });
  assert.equal(ordinal.projects.length, 1, "published capability remains canonical");
});

scenario("capability-release-proof-gate", async ({ event }) => {
  const protocol = await bundledModule("../../lib/site-knowledge/protocol.ts");
  const gate = await bundledModule("../../lib/site-knowledge/release-gate.ts");
  const release = protocol.emptyRelease("lab", now);
  const candidate = {
    id: "candidate-list", siteAgentId: "lab", normalizedGoal: "查询列表", baseReleaseVersion: 0, scenes: [], targets: [], sourceEpisodeIds: [], createdAt: now, updatedAt: now,
    capability: { id: "capability-list", kind: "task", resultKind: "data", exposure: "public", name: "查询列表", description: "返回列表", normalizedGoal: "查询列表", aliases: [], inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: { items: { type: "array" } }, required: ["items"] }, outcomes: [], plans: [{ id: "plan", entrySceneIds: ["*"], steps: [{ operationId: "operation-list", bindings: {} }], outputBindings: {} }], sourceEpisodeIds: [], confidence: .7, status: "learning", updatedAt: now },
    operations: [{ id: "operation-list", name: "读取列表", fromSceneId: "*", toSceneId: "*", inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} }, preconditions: [], effects: [], verification: {}, status: "verified", updatedAt: now, implementations: [{ id: "impl", conditions: [], successes: 1, failures: 0, sourceEpisodeIds: [], program: { version: 2, steps: [{ id: "wait", op: "wait", durationMs: 1 }] }, authored: { kind: "page-program", program: { version: 2, steps: [{ id: "wait", op: "wait", durationMs: 1 }] }, proof: { version: 1, iterationId: "i", author: "ai-program-author", rationale: "test", alternativeIds: [], verifier: { success: [{ kind: "url", value: "/" }], noResult: [], businessRejection: [] }, groundedTargetIds: [], extractionProofs: [], createdAt: now } } }] }],
    validation: { status: "pending", attempts: 0, successfulReplays: 0, requiredReplays: 1 }, authoring: { stage: "authored", reusableTrace: false, resultFields: [{ id: "items", name: "列表", type: "array", source: "extracted", importance: "core" }] },
  };
  const validation = { id: "validation", learningJobId: "job", siteAgentId: "lab", candidateId: candidate.id, capabilityId: candidate.capability.id, baseReleaseVersion: 0, status: "running", validationCase: { id: "case", name: "case", input: {}, inputSource: "observed", startUrl: "https://lab.test/", expectedStatuses: ["success"], effect: "read-only" }, attempt: 0, maxAttempts: 1, createdAt: now, updatedAt: now };
  const run = { id: "run", learningJobId: "job", validationJobId: validation.id, siteAgentId: "lab", candidateId: candidate.id, runnerId: "runner", mode: "validate", status: "passed", browser: { name: "chromium", version: "1", headless: true }, startedAt: now, endedAt: now, startUrl: "https://lab.test/", endUrl: "https://lab.test/", steps: [{ stepId: "wait", op: "wait", status: "passed", startedAt: now, endedAt: now }], outcome: { status: "success", code: "success", summary: "完成", evaluatedAt: now, evidence: {} } };
  const decision = gate.evaluateBrowserRun(release, candidate, validation, run);
  event("release.gated", { decision: decision.decision, reason: decision.reason });
  assert.equal(decision.decision, "reject", "data capability without extraction proof must not publish");
  assert.equal(decision.reason, "ai_authoring_proof_missing");
});

scenario("knowledge-crawl-evidence-tier", async ({ event }) => {
  const protocol = await bundledModule("../../lib/site-knowledge/protocol.ts");
  // Ladder ordering: referenced < crawled < observed < entry-verified.
  assert.equal(protocol.strongerEvidenceStatus("referenced", "crawled"), "crawled");
  assert.equal(protocol.strongerEvidenceStatus("crawled", "observed"), "observed");
  assert.equal(protocol.strongerEvidenceStatus("observed", "entry-verified"), "entry-verified");
  assert.equal(protocol.strongerEvidenceStatus("crawled", "referenced"), "crawled");
  assert.equal(protocol.strongerEvidenceStatus("semantic-reviewed", "crawled"), "observed", "deprecated lifecycle maps above crawled");
  assert.ok(protocol.EVIDENCE_RANK.referenced < protocol.EVIDENCE_RANK.crawled);
  assert.ok(protocol.EVIDENCE_RANK.crawled < protocol.EVIDENCE_RANK.observed);
  assert.deepEqual(protocol.mergeOrigins(["crawl"], "usage", undefined, ["usage"]).sort(), ["crawl", "usage"]);
  // crawled seeds the agent context; a link-only referenced scene stays out.
  const knowledge = await bundledModule("../../lib/site-knowledge/site-knowledge.ts");
  const release = protocol.emptyRelease("lab", now);
  release.scenes = [
    { id: "scene-crawled", name: "已爬页", evidenceStatus: "crawled", origin: "crawl", urlTemplates: [{ id: "u1", originPattern: "https://lab.test", pathnamePattern: "/catalog", query: {} }], parameters: [], verifier: {}, directEntry: "candidate", sourceObservationIds: [], updatedAt: now, evidence: { linkLabels: [], observedUrls: ["https://lab.test/catalog"], titles: [], headings: [] } },
    { id: "scene-referenced", name: "只被链接", evidenceStatus: "referenced", urlTemplates: [{ id: "u2", originPattern: "https://lab.test", pathnamePattern: "/legal", query: {} }], parameters: [], verifier: {}, directEntry: "candidate", sourceObservationIds: [], updatedAt: now, evidence: { linkLabels: ["条款"], observedUrls: [], titles: [], headings: [] } },
  ];
  const context = knowledge.buildSiteKnowledgeContext(release);
  const ids = context.nearbyScenes.map((scene) => scene.id);
  event("context.seeded", { nearby: ids });
  assert.ok(ids.includes("scene-crawled"), "crawled scene seeds the agent context");
  assert.ok(!ids.includes("scene-referenced"), "link-only referenced scene stays out of context");
});

scenario("knowledge-crawl-merge", async ({ event }) => {
  const discovery = await bundledModule("../../lib/site-knowledge/discovery.ts");
  const base = (over) => ({ id: "scene-x", name: "X", urlTemplates: [{ id: "u", originPattern: "https://lab.test", pathnamePattern: "/p/{path1}", query: {} }], parameters: [], verifier: {}, directEntry: "candidate", sourceObservationIds: [], updatedAt: now, evidence: { linkLabels: [], observedUrls: [], titles: [], headings: [] }, ...over });
  // crawled + observed -> observed, both provenances retained.
  const crawled = base({ evidenceStatus: "crawled", origin: "crawl", origins: ["crawl"], semanticSource: "program" });
  const observed = base({ evidenceStatus: "observed", origin: "usage", origins: ["usage"], semanticSource: "program", evidence: { linkLabels: [], observedUrls: ["https://lab.test/p/900"], titles: ["商品"], headings: [] } });
  const upgraded = discovery.mergeSceneEvidence(crawled, observed);
  event("merge.upgrade", { evidenceStatus: upgraded.evidenceStatus, origins: upgraded.origins });
  assert.equal(upgraded.evidenceStatus, "observed", "crawled page becomes observed once really used");
  assert.deepEqual([...upgraded.origins].sort(), ["crawl", "usage"], "both provenances retained");
  // precedence: crawl must NOT override a usage/human name, but still contributes structure.
  const usageNamed = base({ evidenceStatus: "observed", origin: "usage", semanticSource: "ai", name: "商品详情页", description: "商品详情" });
  // crawl-side AI naming (semanticSource "ai") still must NOT beat usage-ai — only the precedence guard stops it.
  const crawlName = base({ evidenceStatus: "crawled", origin: "crawl", semanticSource: "ai", name: "Product Page", evidence: { linkLabels: [], observedUrls: ["https://lab.test/p/800"], titles: [], headings: [] } });
  const merged = discovery.mergeSceneEvidence(usageNamed, crawlName);
  assert.equal(merged.name, "商品详情页", "crawl name must not overwrite usage-ai name");
  assert.ok(merged.evidence.observedUrls.includes("https://lab.test/p/800"), "crawl still contributes structural evidence");
  // crawl DOES fill a name when the prior scene has none (rendered page beats a link placeholder).
  const placeholder = base({ evidenceStatus: "referenced", semanticSource: "program", name: "/p/{path1}" });
  const crawlFill = base({ evidenceStatus: "crawled", origin: "crawl", semanticSource: "program", name: "商品页", evidence: { linkLabels: [], observedUrls: ["https://lab.test/p/700"], titles: ["商品页"], headings: [] } });
  assert.equal(discovery.mergeSceneEvidence(placeholder, crawlFill).name, "商品页", "crawl fills a name when previous has none");
});

scenario("knowledge-crawl-sitemap", async ({ event }) => {
  const seed = await bundledModule("../../lib/site-knowledge/sitemap-seed.ts");
  const docs = {
    "https://lab.test/sitemap.xml": '<?xml version="1.0"?><sitemapindex><sitemap><loc>https://lab.test/sm1.xml</loc></sitemap><sitemap><loc>https://evil.test/offsite.xml</loc></sitemap><sitemap><loc>https://user:pass@lab.test/private.xml</loc></sitemap></sitemapindex>',
    "https://lab.test/sm1.xml": '<urlset><url><loc>https://lab.test/a</loc></url><url><loc>https://lab.test/b?utm_source=x</loc></url><url><loc>http://lab.test/downgrade</loc></url><url><loc>https://evil.test/x</loc></url><url><loc>https://user:pass@lab.test/private</loc></url></urlset>',
  };
  const requested = [];
  const fetchText = async (url) => {
    requested.push(url);
    return docs[url] ? { ok: true, status: 200, text: docs[url] } : { ok: false, status: 404, text: "" };
  };
  const result = await seed.seedFromSitemap("https://lab.test", {
    fetchText,
    robotsSitemaps: ["https://evil.test/robots.xml", "https://user:pass@lab.test/robots-private.xml"],
  });
  event("sitemap.seeded", { urls: result.urls, sitemaps: result.sitemapUrls.length });
  assert.equal(result.source, "sitemap");
  assert.deepEqual(result.urls.sort(), ["https://lab.test/a", "https://lab.test/b?utm_source=x"], "index followed, nested urls kept, off-host dropped");
  assert.ok(result.sitemapUrls.includes("https://lab.test/sm1.xml"), "nested sitemap actually read");
  assert.ok(requested.every((url) => new URL(url).origin === "https://lab.test" && !new URL(url).username), "robots and nested sitemap locations are filtered before fetch");

  const crossOriginRedirects = [];
  const redirected = await seed.fetchSameOriginText("https://lab.test/robots.txt", "https://lab.test", {
    fetchImpl: async (url, init) => {
      crossOriginRedirects.push({ url: String(url), redirect: init.redirect });
      return new Response("", { status: 302, headers: { location: "https://evil.test/robots.txt" } });
    },
  });
  assert.equal(redirected, null, "cross-origin redirect is rejected without following it");
  assert.deepEqual(crossOriginRedirects, [{ url: "https://lab.test/robots.txt", redirect: "manual" }]);

  const sameOriginRedirects = [];
  const followed = await seed.fetchSameOriginText("https://lab.test/robots.txt", "https://lab.test", {
    fetchImpl: async (url) => {
      sameOriginRedirects.push(String(url));
      return String(url).endsWith("/robots.txt")
        ? new Response("", { status: 302, headers: { location: "/robots-final.txt" } })
        : new Response("User-agent: *", { status: 200 });
    },
  });
  assert.equal(followed.text, "User-agent: *", "validated same-origin redirect may be followed");
  assert.deepEqual(sameOriginRedirects, ["https://lab.test/robots.txt", "https://lab.test/robots-final.txt"]);
  assert.equal(
    await seed.fetchSameOriginText("https://user:pass@lab.test/robots.txt", "https://lab.test"),
    null,
    "userinfo fetch targets are rejected before network access",
  );
  assert.equal(
    (await seed.seedFromSitemap("https://user:pass@lab.test")).source,
    "empty",
    "userinfo crawl origins cannot seed sitemap requests",
  );
  const empty = await seed.seedFromSitemap("https://none.test", { fetchText: async () => ({ ok: false, status: 404, text: "" }) });
  assert.equal(empty.source, "empty", "no sitemap => fallback signaled");
  assert.equal(empty.urls.length, 0);

  let oversizedCancelled = false;
  const oversized = await seed.fetchSameOriginText(
    "https://lab.test/huge.xml",
    "https://lab.test",
    {
      maxBytes: 8,
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("0123456789"));
        },
        cancel() {
          oversizedCancelled = true;
        },
      }), { status: 200 }),
    },
  );
  assert.equal(oversized, null, "streaming body limits reject oversized sitemap responses");
  assert.equal(oversizedCancelled, true, "oversized response bodies are cancelled immediately");

  const timeoutStartedAt = Date.now();
  const timedOut = await seed.fetchSameOriginText(
    "https://lab.test/slow.xml",
    "https://lab.test",
    {
      timeoutMs: 20,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
    },
  );
  assert.equal(timedOut, null, "a stalled sitemap fetch respects its deadline");
  assert.ok(Date.now() - timeoutStartedAt < 1_000);

  const externalAbort = new AbortController();
  const abortedFetch = seed.fetchSameOriginText(
    "https://lab.test/abort.xml",
    "https://lab.test",
    {
      signal: externalAbort.signal,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
    },
  );
  externalAbort.abort(new Error("lease_lost"));
  await assert.rejects(abortedFetch, /lease_lost/, "external lease aborts propagate instead of becoming an optional sitemap miss");

  const fanout = Array.from(
    { length: 100 },
    (_, index) => `<sitemap><loc>https://lab.test/nested-${index}.xml</loc></sitemap>`,
  ).join("");
  const fanoutRequests = [];
  await seed.seedFromSitemap("https://lab.test", {
    maxSitemaps: 7,
    fetchText: async (url) => {
      fanoutRequests.push(url);
      return url.endsWith("/sitemap.xml")
        ? { ok: true, status: 200, text: `<sitemapindex>${fanout}</sitemapindex>` }
        : { ok: true, status: 200, text: "<urlset></urlset>" };
    },
  });
  assert.ok(fanoutRequests.length <= 7, "sitemap-index fanout cannot grow beyond maxSitemaps");

  const invalidEntity = await seed.seedFromSitemap("https://lab.test", {
    fetchText: async (url) => url.endsWith("/sitemap.xml")
      ? {
          ok: true,
          status: 200,
          text: "<urlset><url><loc>https://lab.test/&#xD800;</loc></url><url><loc>https://lab.test/good</loc></url></urlset>",
        }
      : { ok: false, status: 404, text: "" },
  });
  assert.deepEqual(invalidEntity.urls, ["https://lab.test/good"], "invalid numeric XML entities are skipped rather than converted into URLs");
});

scenario("knowledge-crawl-frontier", async ({ event }) => {
  const { CrawlFrontier } = await bundledModule("../../lib/site-knowledge/crawl-frontier.ts");
  // template dedup: three same-template product URLs -> one render, two samples.
  const dedup = new CrawlFrontier({ origin: "https://lab.test", maxPerTemplate: 1, adaptiveStopAfter: 50 });
  dedup.seed(["https://lab.test/p/100", "https://lab.test/p/200", "https://lab.test/p/300"]);
  const actions = [];
  for (let decision = dedup.next(); decision.action !== "stop"; decision = dedup.next()) actions.push(decision.action);
  event("frontier.dedup", { actions, rendered: dedup.stats.rendered });
  assert.equal(actions.filter((a) => a === "render").length, 1, "one representative rendered per template");
  assert.equal(actions.filter((a) => a === "sample").length, 2, "duplicates folded as samples");
  // filter chain rejects traps / assets / off-host / facet explosion.
  const filter = new CrawlFrontier({ origin: "https://lab.test" });
  assert.equal(filter.accepts("https://lab.test/ok"), true);
  assert.equal(filter.accepts("https://lab.test/logout"), false, "trap");
  assert.equal(filter.accepts("https://lab.test/x.png"), false, "asset");
  assert.equal(filter.accepts("https://other.test/x"), false, "off-host");
  assert.equal(filter.accepts("http://lab.test/x"), false, "same-host scheme downgrade is off-origin");
  assert.equal(filter.accepts("https://lab.test:444/x"), false, "same-host port change is off-origin");
  assert.equal(filter.accepts("https://user:pass@lab.test/private"), false, "userinfo is never crawlable");
  assert.equal(filter.accepts("wss://lab.test/socket"), false, "non-http protocols are never crawlable");
  assert.equal(filter.accepts("https://lab.test/s?a=1&b=2&c=3&d=4"), false, "facet explosion");
  // adaptive stop after N consecutive no-new-template.
  const saturate = new CrawlFrontier({ origin: "https://lab.test", maxPerTemplate: 1, adaptiveStopAfter: 2 });
  saturate.seed(["https://lab.test/p/100", "https://lab.test/p/200", "https://lab.test/p/300", "https://lab.test/p/400"]);
  let saturateReason;
  for (let decision = saturate.next(); ; decision = saturate.next()) { if (decision.action === "stop") { saturateReason = decision.reason; break; } }
  assert.equal(saturateReason, "saturated", "stops once templates stop being new");
  // hard render cap.
  const capped = new CrawlFrontier({ origin: "https://lab.test", maxRenders: 1, maxPerTemplate: 5 });
  capped.seed(["https://lab.test/a", "https://lab.test/b/100", "https://lab.test/c/200"]);
  let renders = 0, cappedReason;
  for (let decision = capped.next(); ; decision = capped.next()) { if (decision.action === "render") renders += 1; if (decision.action === "stop") { cappedReason = decision.reason; break; } }
  assert.equal(renders, 1);
  assert.equal(cappedReason, "max-renders");
});

scenario("knowledge-crawl-robots", async ({ event }) => {
  const politeness = await bundledModule("../../lib/site-knowledge/crawl-politeness.ts");
  const rules = politeness.parseRobots("User-agent: *\nDisallow: /cart\nAllow: /cart/help\nSitemap: https://lab.test/sitemap.xml\n\nUser-agent: SiteWakeBot\nDisallow: /admin");
  event("robots.parsed", { disallow: rules.disallow, sitemaps: rules.sitemaps });
  assert.deepEqual(rules.disallow, ["/admin"], "UA-specific group wins over *");
  assert.deepEqual(rules.sitemaps, ["https://lab.test/sitemap.xml"], "sitemaps collected across groups");
  assert.equal(politeness.robotsAllows(rules, "https://lab.test/admin"), false);
  assert.equal(politeness.robotsAllows(rules, "https://lab.test/anything"), true);
  const star = politeness.parseRobots("User-agent: *\nDisallow: /cart\nAllow: /cart/help", "googlebot");
  assert.equal(politeness.robotsAllows(star, "https://lab.test/cart"), false);
  assert.equal(politeness.robotsAllows(star, "https://lab.test/cart/help"), true, "longer Allow overrides Disallow");
  assert.equal(politeness.parseRobots("User-agent: *\nCrawl-delay: 2").crawlDelayMs, 2000, "crawl-delay parsed to ms");
  assert.ok(politeness.DEFAULT_UA.includes("SiteWakeBot"), "identifiable UA");
});

scenario("knowledge-crawl-document", async ({ event }) => {
  const { CrawlFrontier } = await bundledModule("../../lib/site-knowledge/crawl-frontier.ts");
  const ck = await bundledModule("../../lib/site-knowledge/crawl-knowledge.ts");
  const bt = await bundledModule("../../lib/site-knowledge/business-topology.ts");
  const page = (url, heading, links = []) => snapshot(url, heading, links);
  const pages = {
    "https://lab.test/": page("https://lab.test/", "示例商城", [
      { text: "商品A", url: "https://lab.test/p/100" },
      { text: "商品B", url: "https://lab.test/p/200" },
      { text: "商品C", url: "https://lab.test/p/300" },
      { text: "搜索", url: "https://lab.test/search?q=x" },
      { text: "登出", url: "https://lab.test/logout" },
    ]),
    "https://lab.test/p/100": page("https://lab.test/p/100", "商品 100"),
    "https://lab.test/p/200": page("https://lab.test/p/200", "商品 200"),
    "https://lab.test/p/300": page("https://lab.test/p/300", "商品 300"),
    "https://lab.test/search?q=x": page("https://lab.test/search?q=x", "搜索结果"),
  };
  const frontier = new CrawlFrontier({ origin: "https://lab.test", maxPerTemplate: 1, adaptiveStopAfter: 50 });
  const doc = await ck.crawlSiteKnowledge({
    siteAgentId: "lab", origin: "https://lab.test", crawledAt: now,
    seeds: ["https://lab.test/", "https://lab.test/p/100", "https://lab.test/p/200", "https://lab.test/p/300"],
    frontier, renderPage: async (url) => pages[url] ?? null,
  });
  event("document.assembled", { scenes: doc.scenes.length, links: doc.links.length, stats: doc.meta.stats });
  assert.equal(doc.schemaVersion, "site-knowledge/v1");
  assert.equal(doc.origin, "crawl");
  const product = doc.scenes.filter((scene) => scene.urlTemplates[0].pathnamePattern === "/p/{path1}");
  assert.equal(product.length, 1, "product URLs cluster to one Scene");
  assert.equal(product[0].evidenceStatus, "crawled", "rendered page is crawled, not observed");
  assert.equal(product[0].origin, "crawl");
  assert.ok((product[0].sampleCount ?? 0) >= 2, "duplicate product URLs folded as samples, not re-rendered");
  assert.ok(!doc.scenes.some((scene) => scene.urlTemplates[0].pathnamePattern === "/logout"), "trap filtered out of knowledge, not just rendering");
  assert.ok(doc.scenes.every((scene) => scene.origin === "crawl"), "every crawled scene tagged crawl provenance");
  // Topology is derived on demand (not carried in the document) from scenes + links.
  const tree = bt.buildBusinessTopologyFromParts({ rootName: doc.profile.name, scenes: doc.scenes, linkReferences: doc.links });
  assert.ok(tree.root.name, "tree derived from scenes + links");
  assert.ok(doc.meta.stats.pagesRendered <= 3, "dedup: rendered home + one product + search, not five");
  // lossless mapping onto the Release knowledge fields.
  const fields = ck.siteKnowledgeToReleaseFields(doc);
  assert.equal(fields.scenes, doc.scenes);
  assert.equal(fields.linkReferences, doc.links);
  assert.equal(fields.profile.origin, "crawl");
  // crawl-side AI: an injected profile generator is used when provided.
  const frontier2 = new CrawlFrontier({ origin: "https://lab.test", maxPerTemplate: 1, adaptiveStopAfter: 50 });
  const withProfile = await ck.crawlSiteKnowledge({
    siteAgentId: "lab", origin: "https://lab.test", crawledAt: now, seeds: ["https://lab.test/"], frontier: frontier2,
    renderPage: async (url) => pages[url] ?? null,
    generateProfile: async () => ({ name: "注入知识库", description: "AI 生成", category: "test", vocabulary: {}, suggestedGoals: [], semanticSource: "ai", origin: "crawl" }),
  });
  assert.equal(withProfile.profile.name, "注入知识库", "crawl uses the injected profile generator (crawl-side AI)");
  assert.equal(withProfile.profile.semanticSource, "ai");

  const escapedFrontier = new CrawlFrontier({ origin: "https://lab.test" });
  const escaped = await ck.crawlSiteKnowledge({
    siteAgentId: "lab",
    origin: "https://lab.test",
    crawledAt: now,
    seeds: ["https://lab.test/redirect"],
    frontier: escapedFrontier,
    renderPage: async () => snapshot("https://evil.test/redirected", "escaped"),
  });
  assert.equal(escaped.meta.stats.pagesRendered, 0, "an off-origin final snapshot is not adopted");
  assert.equal(escaped.scenes.length, 0, "an off-origin final snapshot cannot enter knowledge");
});

scenario("knowledge-crawl-tree-projection", async ({ event }) => {
  const { CrawlFrontier } = await bundledModule("../../lib/site-knowledge/crawl-frontier.ts");
  const ck = await bundledModule("../../lib/site-knowledge/crawl-knowledge.ts");
  const bt = await bundledModule("../../lib/site-knowledge/business-topology.ts");
  // A cyclic site: home <-> dashboard link each other; catalog linked from BOTH.
  const pages = {
    "https://lab.test/": snapshot("https://lab.test/", "首页", [
      { text: "工作台", url: "https://lab.test/dashboard" },
      { text: "目录", url: "https://lab.test/catalog" },
    ]),
    "https://lab.test/dashboard": snapshot("https://lab.test/dashboard", "工作台", [
      { text: "回首页", url: "https://lab.test/" },
      { text: "目录", url: "https://lab.test/catalog" },
    ]),
    "https://lab.test/catalog": snapshot("https://lab.test/catalog", "目录", [
      { text: "回首页", url: "https://lab.test/" },
    ]),
  };
  const frontier = new CrawlFrontier({ origin: "https://lab.test", maxPerTemplate: 1, adaptiveStopAfter: 50 });
  const doc = await ck.crawlSiteKnowledge({ siteAgentId: "lab", origin: "https://lab.test", crawledAt: now, seeds: ["https://lab.test/"], frontier, renderPage: async (url) => pages[url] ?? null });
  const idOf = (path) => doc.scenes.find((scene) => scene.urlTemplates[0].pathnamePattern === path)?.id;
  const hasEdge = (fromPath, toPath) => doc.links.some((link) => link.fromSceneId === idOf(fromPath) && link.toSceneId === idOf(toPath));
  // Topology is derived on demand from scenes + links, not carried in the document.
  const tree = bt.buildBusinessTopologyFromParts({ rootName: doc.profile.name, scenes: doc.scenes, linkReferences: doc.links });
  event("tree.projection", { links: doc.links.length, primary: tree.primaryEdges.length, secondary: tree.secondaryEdges.length });
  // links are the TRUTH: every edge is kept, including the home<->dashboard cycle.
  assert.ok(hasEdge("/", "/dashboard"), "links keep home->dashboard");
  assert.ok(hasEdge("/dashboard", "/"), "links keep dashboard->home (the back-edge of the cycle)");
  // node/edge separation: catalog linked from home AND dashboard => two distinct edges, not folded into the node.
  const inboundCatalog = doc.links.filter((link) => link.toSceneId === idOf("/catalog"));
  assert.ok(inboundCatalog.length >= 2, "multi-source inbound links stay as distinct edges");
  assert.ok(new Set(inboundCatalog.map((link) => link.fromSceneId)).size >= 2, "distinct sources preserved");
  // tree is a LOSSY acyclic projection: no node is its own ancestor via primary parents.
  const parent = new Map(tree.primaryEdges.map((edge) => [edge.to, edge.from]));
  for (const node of tree.nodes) {
    const seen = new Set([node.id]);
    let current = parent.get(node.id);
    while (current && current !== "site-root") { assert.ok(!seen.has(current), "tree must be acyclic"); seen.add(current); current = parent.get(current); }
  }
});

scenario("knowledge-crawl-review-orthogonal", async ({ event }) => {
  const analyzer = await bundledModule("../../lib/site-knowledge/model-analyzer.ts");
  const scene = (over) => ({ id: "s", name: "n", semanticSource: "program", urlTemplates: [{ id: "u", originPattern: "https://lab.test", pathnamePattern: "/x", query: {} }], parameters: [], verifier: {}, directEntry: "candidate", sourceObservationIds: [], updatedAt: now, evidence: { linkLabels: [], observedUrls: ["https://lab.test/x"], titles: ["X"], headings: ["X"] }, ...over });
  // Crawled pages are named by the crawl pipeline's own AI pass; they must NOT
  // enter the usage review queue until real usage promotes them to observed.
  assert.equal(analyzer.sceneNeedsSemanticReview(scene({ evidenceStatus: "crawled" })), false, "crawled page stays out of usage review queue even with page evidence");
  assert.equal(analyzer.sceneNeedsSemanticReview(scene({ evidenceStatus: "observed" })), true, "observed page enters usage review");
  event("review.orthogonal", {});
});

scenario("knowledge-crawl-adopt", async ({ event }) => {
  const { CrawlFrontier } = await bundledModule("../../lib/site-knowledge/crawl-frontier.ts");
  const ck = await bundledModule("../../lib/site-knowledge/crawl-knowledge.ts");
  const knowledge = await bundledModule("../../lib/site-knowledge/site-knowledge.ts");
  const pages = {
    "https://lab.test/": snapshot("https://lab.test/", "示例商城", [
      { text: "商品A", url: "https://lab.test/p/100" },
      { text: "目录", url: "https://lab.test/catalog" },
    ]),
    "https://lab.test/p/100": snapshot("https://lab.test/p/100", "商品 100"),
    "https://lab.test/catalog": snapshot("https://lab.test/catalog", "目录"),
  };
  const frontier = new CrawlFrontier({ origin: "https://lab.test", maxPerTemplate: 1, adaptiveStopAfter: 50 });
  const doc = await ck.crawlSiteKnowledge({ siteAgentId: "lab", origin: "https://lab.test", crawledAt: now, seeds: ["https://lab.test/"], frontier, renderPage: async (url) => pages[url] ?? null });
  const release = ck.siteKnowledgeDocumentToRelease(doc, { version: 1 });
  event("crawl.adopted", { version: release.version, scenes: release.scenes.length });
  assert.equal(release.schemaVersion, "site-agent.v2", "adopted as a v2 release");
  assert.equal(release.version, 1);
  assert.equal(release.id, "lab:release:1");
  assert.equal(release.siteAgentId, "lab");
  assert.ok(release.agentConfig, "agentConfig filled from defaults");
  assert.ok(release.evalSummary, "eval summary present");
  assert.equal(release.scenes, doc.scenes);
  assert.equal(release.linkReferences, doc.links);
  assert.equal(release.profile.origin, "crawl", "base-layer release keeps crawl provenance");
  assert.ok(release.contentHash, "content hash computed");
  // the adopted base layer is consumable: the agent sees the crawled scenes.
  const context = knowledge.buildSiteKnowledgeContext(release);
  assert.ok(context.nearbyScenes.length >= 1, "adopted crawled scenes are visible to the agent (cold start)");
});

scenario("knowledge-crawl-profile-generator", async ({ event }) => {
  const ck = await bundledModule("../../lib/site-knowledge/crawl-knowledge.ts");
  const generate = ck.crawlProfileGenerator();
  // No snapshots -> no model call, no profile (deterministic guard; avoids a live model call in tests).
  assert.equal(await generate([]), undefined, "empty snapshots yield no profile without touching the model");
  event("crawl.profile.guard", {});
});

scenario("knowledge-crawl-render", async ({ event }) => {
  const render = await bundledModule("../../lib/site-knowledge/crawl-render.ts");
  const extract = {
    title: "标题", heading: "大标题", visibleText: "正文内容",
    links: Array.from({ length: 200 }, (_, index) => ({ text: `链接${index}`, url: `https://lab.test/${index}` })),
    elements: [{ tag: "a", role: "link", accessibleName: "首页", href: "https://lab.test/0", landmark: "header", attributes: { href: "https://lab.test/0" } }],
    metadata: { description: "站点描述" },
  };
  const snap = render.snapshotFromExtract("https://lab.test/", extract, now, 3);
  event("crawl.render", { links: snap.links.length, sequence: snap.sequence });
  assert.equal(snap.url, "https://lab.test/");
  assert.equal(snap.sessionId, "crawl", "server-side crawl snapshots are tagged crawl session");
  assert.equal(snap.sequence, 3);
  assert.equal(snap.title, "标题");
  assert.equal(snap.heading, "大标题");
  assert.equal(snap.links.length, 120, "links capped at 120 to bound snapshot size");
  assert.equal(snap.metadata.description, "站点描述");
  assert.ok(snap.id.startsWith("crawl_"), "stable crawl-scoped id");

  let activeUrl = "";
  let finalUrl = "";
  let hydrationUrl;
  let extractNavigationUrl;
  let routeHandler;
  let webSocketHandler;
  let pageHandler;
  let initScriptInstalled = false;
  let evaluateCount = 0;
  const requestStage = fakeCrawlCdpSession();
  const fakeContext = {
    addInitScript: async () => { initScriptInstalled = true; },
    newCDPSession: async (candidate) => {
      assert.equal(candidate, fakePage, "request-stage interception is attached to the crawl page");
      return requestStage.session;
    },
    route: async (_, handler) => { routeHandler = handler; },
    routeWebSocket: async (_, handler) => { webSocketHandler = handler; },
    on: (event, handler) => { if (event === "page") pageHandler = handler; },
  };
  const fakePage = {
    context: () => fakeContext,
    goto: async (url) => { activeUrl = finalUrl || url; },
    url: () => activeUrl,
    waitForLoadState: async () => {
      if (hydrationUrl !== undefined) {
        activeUrl = hydrationUrl;
        hydrationUrl = undefined;
      }
    },
    evaluate: async () => {
      if (++evaluateCount === 1) return true;
      const pageUrl = activeUrl;
      if (extractNavigationUrl !== undefined) {
        activeUrl = extractNavigationUrl;
        extractNavigationUrl = undefined;
      }
      return { pageUrl, extract };
    },
  };
  const renderPage = render.playwrightRenderPage(fakePage, { timeoutMs: 100, allowedOrigin: "https://lab.test" });
  const rendered = await renderPage("https://lab.test/demo");
  assert.equal(initScriptInstalled, true, "browser network guards are installed before crawl navigation");
  assert.equal(rendered.url, "https://lab.test/demo", "snapshot records the browser's verified final URL");
  assert.deepEqual(
    requestStage.commands[0],
    {
      method: "Fetch.enable",
      params: {
        patterns: [
          { urlPattern: "http://*", requestStage: "Request" },
          { urlPattern: "https://*", requestStage: "Request" },
        ],
      },
    },
    "CDP request-stage interception covers both HTTP protocols before navigation",
  );
  await requestStage.emitRequestPaused({
    requestId: "same-origin",
    request: { url: "https://lab.test/app.js" },
  });
  assert.deepEqual(
    requestStage.commands.at(-1),
    { method: "Fetch.continueRequest", params: { requestId: "same-origin" } },
    "same-origin requests continue at the CDP request stage",
  );
  await requestStage.emitRequestPaused({
    requestId: "cross-origin-redirect",
    request: { url: "https://evil.test/redirected" },
  });
  assert.deepEqual(
    requestStage.commands.at(-1),
    {
      method: "Fetch.failRequest",
      params: { requestId: "cross-origin-redirect", errorReason: "BlockedByClient" },
    },
    "cross-origin redirects are blocked at the CDP request stage before any bytes are sent",
  );

  let routeAction = "";
  await routeHandler({
    request: () => ({ url: () => "https://evil.test/tracker.js" }),
    abort: async () => { routeAction = "abort"; },
    continue: async () => { routeAction = "continue"; },
  });
  assert.equal(routeAction, "abort", "cross-origin http requests are blocked before they are sent");
  await routeHandler({
    request: () => ({ url: () => "https://lab.test/app.js" }),
    abort: async () => { routeAction = "abort"; },
    continue: async () => { routeAction = "continue"; },
  });
  assert.equal(routeAction, "continue", "same-origin page resources remain available");

  let socketAction = "";
  await webSocketHandler({
    url: () => "wss://evil.test/socket",
    close: async () => { socketAction = "close"; },
    connectToServer: () => { socketAction = "connect"; },
  });
  assert.equal(socketAction, "close", "cross-origin WebSockets are closed before connecting");
  await webSocketHandler({
    url: () => "wss://lab.test/socket",
    close: async () => { socketAction = "close"; },
    connectToServer: () => { socketAction = "connect"; },
  });
  assert.equal(socketAction, "connect", "same-origin secure WebSockets may connect");

  let popupClosed = false;
  await pageHandler({ close: async () => { popupClosed = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(popupClosed, true, "window.open pages are closed before they can escape the crawl page");

  finalUrl = "";
  const hydratedSpaUrl = "https://lab.test/demo/spa";
  hydrationUrl = hydratedSpaUrl;
  assert.equal((await renderPage("https://lab.test/demo/loading")).url, hydratedSpaUrl, "same-origin SPA navigation completed during hydration becomes the snapshot URL");

  finalUrl = "https://lab.test/demo/final";
  assert.equal((await renderPage("https://lab.test/demo/redirect")).url, finalUrl, "same-origin final navigation is accepted");
  finalUrl = "";
  extractNavigationUrl = "https://lab.test/demo/changed-after-extract";
  assert.equal(await renderPage("https://lab.test/demo/changing"), null, "URL changes during extraction cannot be paired with stale page content");
  hydrationUrl = "https://evil.test/spa-escape";
  assert.equal(await renderPage("https://lab.test/demo/spa-escape"), null, "cross-origin SPA navigation during hydration is rejected before extraction");
  finalUrl = "https://evil.test/redirected";
  assert.equal(await renderPage("https://lab.test/demo/escape"), null, "cross-origin final page URL is rejected");
  assert.equal(await renderPage("https://user:pass@lab.test/private"), null, "userinfo navigation is rejected before goto");

  const guardInstallFailure = new Error("crawl_guard_install_failed");
  const installFailurePage = {
    context: () => ({ addInitScript: async () => { throw guardInstallFailure; } }),
  };
  await assert.rejects(
    render.playwrightRenderPage(installFailurePage, { allowedOrigin: "https://lab.test" })("https://lab.test/"),
    guardInstallFailure,
    "guard installation failure is fatal instead of becoming a skipped page",
  );

  const inactiveRequestStage = fakeCrawlCdpSession();
  const inactiveGuardContext = {
    addInitScript: async () => {},
    newCDPSession: async () => inactiveRequestStage.session,
    route: async () => {},
    routeWebSocket: async () => {},
    on: () => {},
  };
  const inactiveGuardPage = {
    context: () => inactiveGuardContext,
    goto: async () => {},
    evaluate: async () => false,
  };
  await assert.rejects(
    render.playwrightRenderPage(inactiveGuardPage, { allowedOrigin: "https://lab.test" })("https://lab.test/"),
    /crawl_network_guard_inactive/,
    "guard self-check failure is fatal instead of producing a zero-page successful crawl",
  );

  const failingPage = ({ failure, failureStage = "navigation", pageClosed = false, browserConnected = true }) => {
    let gotoCount = 0;
    let evaluateCount = 0;
    let activeUrl = "";
    const requestStage = fakeCrawlCdpSession();
    const context = {
      addInitScript: async () => {},
      newCDPSession: async () => requestStage.session,
      route: async () => {},
      routeWebSocket: async () => {},
      on: () => {},
      browser: () => ({ isConnected: () => browserConnected }),
    };
    return {
      context: () => context,
      goto: async (url) => {
        gotoCount += 1;
        if (gotoCount > 1 && failureStage === "navigation") throw failure;
        activeUrl = url;
      },
      url: () => activeUrl,
      waitForLoadState: async () => {},
      evaluate: async () => {
        evaluateCount += 1;
        if (evaluateCount > 1 && failureStage === "extraction") throw failure;
        return true;
      },
      isClosed: () => pageClosed,
    };
  };
  const recoverableNavigationFailure = new Error("net::ERR_NAME_NOT_RESOLVED");
  assert.equal(
    await render.playwrightRenderPage(
      failingPage({ failure: recoverableNavigationFailure }),
      { allowedOrigin: "https://lab.test" },
    )("https://lab.test/recoverable"),
    null,
    "a recoverable single-page navigation failure is skipped",
  );
  for (const fatalCase of [
    { label: "closed page", failure: new Error("synthetic extraction failure"), failureStage: "extraction", pageClosed: true },
    { label: "disconnected browser", failure: new Error("synthetic navigation failure"), browserConnected: false },
    { label: "renderer crash", failure: new Error("page.goto: Page crashed") },
    {
      label: "target closed race",
      failure: Object.assign(new Error("page.goto: Target page, context or browser has been closed"), { name: "TargetClosedError" }),
    },
  ]) {
    await assert.rejects(
      render.playwrightRenderPage(
        failingPage(fatalCase),
        { allowedOrigin: "https://lab.test" },
      )(`https://lab.test/${fatalCase.label.replaceAll(" ", "-")}`),
      fatalCase.failure,
      `${fatalCase.label} is rethrown so the crawl job cannot succeed with zero pages`,
    );
  }
});

scenario("knowledge-crawl-browser-boundary", async ({ event }) => {
  // The production runner is loaded through tsx/esbuild with keepNames. Keep
  // that exact transform here: a named function inside addInitScript once
  // compiled to an unavailable __name helper and made real crawls return zero
  // rendered pages while the ordinary test bundle still passed.
  const render = await bundledModule("../../lib/site-knowledge/crawl-render.ts", { keepNames: true });
  let offOriginRequests = 0;
  let offOriginSockets = 0;
  let serviceWorkerRequests = 0;
  let workerRequests = 0;
  let stunPackets = 0;
  let webTransportPackets = 0;
  const stunTarget = createSocket("udp4");
  const webTransportTarget = createSocket("udp4");
  stunTarget.on("message", () => { stunPackets += 1; });
  webTransportTarget.on("message", () => { webTransportPackets += 1; });
  const offOriginServer = createServer((_, response) => {
    offOriginRequests += 1;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("unexpected");
  });
  offOriginServer.on("upgrade", (_, socket) => {
    offOriginSockets += 1;
    socket.destroy();
  });
  const listen = (server) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
  const listenUdp = (socket) => new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => resolve(socket.address()));
  });
  const close = (server) => new Promise((resolve) => server.close(() => resolve()));
  const closeUdp = (socket) => new Promise((resolve) => socket.close(() => resolve()));
  const stunAddress = await listenUdp(stunTarget);
  const webTransportAddress = await listenUdp(webTransportTarget);
  const offAddress = await listen(offOriginServer);
  const offOrigin = `http://127.0.0.1:${offAddress.port}`;
  const appServer = createServer((request, response) => {
    if (request.url === "/sw.js") {
      serviceWorkerRequests += 1;
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end("self.addEventListener('fetch', () => {});");
      return;
    }
    if (request.url === "/worker.js") {
      workerRequests += 1;
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end("postMessage('unexpected');");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><h1>crawl boundary</h1><script>
      window.open(${JSON.stringify(`${offOrigin}/popup`)});
      fetch(${JSON.stringify(`${offOrigin}/fetch`)}).catch(() => {});
      new WebSocket(${JSON.stringify(`${offOrigin.replace("http:", "ws:")}/socket`)});
      navigator.serviceWorker.register('/sw.js').catch(() => {});
      window.crawlGuardAttempts = {};
      try {
        const peer = new RTCPeerConnection({ iceServers: [{ urls: ${JSON.stringify(`stun:127.0.0.1:${stunAddress.port}`)} }] });
        peer.createDataChannel("crawl-boundary");
        peer.createOffer().then((offer) => peer.setLocalDescription(offer)).catch(() => {});
        window.crawlGuardAttempts.rtc = "allowed";
      } catch (error) {
        window.crawlGuardAttempts.rtc = error && error.name;
      }
      try {
        new WebTransport(${JSON.stringify(`https://127.0.0.1:${webTransportAddress.port}/crawl-boundary`)});
        window.crawlGuardAttempts.webTransport = "allowed";
      } catch (error) {
        window.crawlGuardAttempts.webTransport = error && error.name;
      }
      try {
        new Worker("/worker.js");
        window.crawlGuardAttempts.worker = "allowed";
      } catch (error) {
        window.crawlGuardAttempts.worker = error && error.name;
      }
      try {
        new SharedWorker("/worker.js");
        window.crawlGuardAttempts.sharedWorker = "allowed";
      } catch (error) {
        window.crawlGuardAttempts.sharedWorker = error && error.name;
      }
    </script>`);
  });
  const appAddress = await listen(appServer);
  const appOrigin = `http://127.0.0.1:${appAddress.port}`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  try {
    const renderPage = render.playwrightRenderPage(page, { timeoutMs: 5_000, allowedOrigin: appOrigin });
    const snapshot = await renderPage(`${appOrigin}/start`);
    const guardState = await page.evaluate(async (blockedApis) => {
      const checkRealm = (realm) => blockedApis.every((name) => {
        const descriptor = Object.getOwnPropertyDescriptor(realm, name);
        if (!descriptor || descriptor.configurable || descriptor.writable || typeof descriptor.value !== "function") return false;
        try {
          Reflect.construct(descriptor.value, []);
          return false;
        } catch (error) {
          return error instanceof realm.DOMException && error.name === "SecurityError";
        }
      });
      const iframe = document.createElement("iframe");
      iframe.srcdoc = "<!doctype html><p>guarded frame</p>";
      document.body.append(iframe);
      await new Promise((resolve) => iframe.addEventListener("load", resolve, { once: true }));
      return {
        attempts: window.crawlGuardAttempts,
        main: checkRealm(window),
        iframe: checkRealm(iframe.contentWindow),
      };
    }, render.CRAWL_DISABLED_BROWSER_NETWORK_APIS);
    await page.waitForTimeout(300);
    event("crawl.browser-boundary", {
      offOriginRequests,
      offOriginSockets,
      serviceWorkerRequests,
      workerRequests,
      stunPackets,
      webTransportPackets,
      guardState,
      pages: context.pages().length,
    });
    assert.equal(snapshot.url, `${appOrigin}/start`);
    assert.equal(offOriginRequests, 0, "window.open and fetch cannot send cross-origin HTTP requests");
    assert.equal(offOriginSockets, 0, "cross-origin WebSocket cannot reach the server");
    assert.equal(serviceWorkerRequests, 0, "serviceWorkers:block prevents registration network access");
    assert.equal(workerRequests, 0, "dedicated and shared worker scripts never start");
    assert.equal(stunPackets, 0, "RTCPeerConnection cannot send STUN/TURN packets outside Playwright routes");
    assert.equal(webTransportPackets, 0, "WebTransport cannot send QUIC packets outside Playwright routes");
    assert.deepEqual(guardState.attempts, {
      rtc: "SecurityError",
      webTransport: "SecurityError",
      worker: "SecurityError",
      sharedWorker: "SecurityError",
    });
    assert.equal(guardState.main, true, "crawl network APIs are locked in the main frame");
    assert.equal(guardState.iframe, true, "BrowserContext init scripts lock the same APIs in child frames");
    assert.equal(context.pages().length, 1, "window.open popup is closed");
  } finally {
    await context.close();
    await browser.close();
    await close(appServer);
    await close(offOriginServer);
    await closeUdp(stunTarget);
    await closeUdp(webTransportTarget);
  }
});

scenario("knowledge-crawl-queue-liveness", async ({ event }) => {
  const [schema, store, leaseRoute, completeRoute, triggerRoute, runner, preview] = await Promise.all([
    readFile(new URL("../../db/site-agent-schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../../db/site-agent-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/validation/runners/[runnerId]/lease/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/validation/runners/[runnerId]/crawl/complete/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/site-agents/[siteAgentId]/crawl/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../runner/browser-runner.ts", import.meta.url), "utf8"),
    readFile(new URL("../../scripts/crawl-preview.ts", import.meta.url), "utf8"),
  ]);
  // Durable queue table + queue index.
  assert.match(schema, /site_agent_v2_crawl_jobs/);
  assert.match(schema, /site_agent_v2_crawl_jobs_queue_idx/);
  // Store: enqueue + lease (stale recovery + terminal-after-3) + complete (adopt release).
  assert.match(store, /export async function enqueueCrawlJob/);
  assert.match(store, /export async function completeCrawlJob/);
  assert.match(store, /FROM site_agent_v2_crawl_jobs WHERE status='queued' OR \(status IN \('leased','running'\) AND lease_expires_at<=\?\)/);
  assert.match(store, /attempts > 3/);
  assert.match(store, /siteKnowledgeDocumentToRelease/);
  assert.match(store, /active_release_id=\?/);
  assert.match(store, /kind: "crawl", job: leased/);
  // Lease/complete/trigger routes.
  assert.match(leaseRoute, /"crawl"/);
  assert.match(completeRoute, /completeCrawlJob/);
  assert.match(triggerRoute, /enqueueCrawlJob/);
  // Runner: dispatch + crawl run (robots + sitemap + playwright render + complete post).
  assert.match(runner, /lease\?\.kind === "crawl"/);
  assert.match(runner, /async function runCrawl/);
  assert.match(runner, /parseRobots|robotsAllows/);
  assert.match(runner, /playwrightRenderPage/);
  assert.match(runner, /serviceWorkers: "block"/, "crawler context must disable service workers");
  assert.match(runner, /installCrawlBrowserNetworkGuards\(context\)/, "crawler must install non-HTTP network guards before creating its page");
  assert.match(runner, /crawl\/complete/);
  const runCrawlSource = runner.slice(runner.indexOf("async function runCrawl"), runner.indexOf("async function runCapabilityExecution"));
  assert.ok(
    runCrawlSource.indexOf("try {") < runCrawlSource.indexOf("context = await crawlBrowser.newContext"),
    "context, network guards, and page creation must all be covered by the crawl failure/finally lifecycle",
  );
  assert.match(runCrawlSource, /retryRunnerCompletion\(/, "fatal crawl setup/render failures are durably reported instead of silently leaving a leased job");
  assert.doesNotMatch(runCrawlSource, /\}\)\.catch\(\(\) => undefined\)/, "fatal completion reporting must not be swallowed");
  assert.ok(
    preview.indexOf("try {") < preview.indexOf("context = await browser.newContext"),
    "the standalone preview uses the same fail-closed setup and cleanup lifecycle",
  );
  event("crawl.queue-contract", { table: true, staleRecovery: true, terminalAfter: 3, adopts: true, dispatched: true });
});

scenario("knowledge-crawl-render-e2e", async ({ event }) => {
  const { CrawlFrontier } = await bundledModule("../../lib/site-knowledge/crawl-frontier.ts");
  const ck = await bundledModule("../../lib/site-knowledge/crawl-knowledge.ts");
  const render = await bundledModule("../../lib/site-knowledge/crawl-render.ts");
  // Duck-typed Playwright Page: goto records the url, evaluate returns that page's extract.
  const extracts = {
    "https://lab.test/": { title: "首页", heading: "首页", visibleText: "t", links: [{ text: "商品", url: "https://lab.test/p/100" }, { text: "目录", url: "https://lab.test/catalog" }], elements: [], metadata: {} },
    "https://lab.test/p/100": { title: "商品100", heading: "商品100", visibleText: "t", links: [], elements: [], metadata: {} },
    "https://lab.test/catalog": { title: "目录", heading: "目录", visibleText: "t", links: [], elements: [], metadata: {} },
  };
  let current = null;
  let evaluateCount = 0;
  const requestStage = fakeCrawlCdpSession();
  const fakeContext = {
    addInitScript: async () => {},
    newCDPSession: async () => requestStage.session,
    route: async () => {},
    routeWebSocket: async () => {},
    on: () => {},
  };
  const fakePage = {
    context: () => fakeContext,
    goto: async (url) => { current = url; },
    url: () => current,
    waitForLoadState: async () => {},
    evaluate: async () => (++evaluateCount === 1 ? true : { pageUrl: current, extract: extracts[current] ?? null }),
  };
  const renderPage = render.playwrightRenderPage(fakePage, { timeoutMs: 100 });
  const frontier = new CrawlFrontier({ origin: "https://lab.test", maxPerTemplate: 1, adaptiveStopAfter: 50 });
  const doc = await ck.crawlSiteKnowledge({ siteAgentId: "lab", origin: "https://lab.test", crawledAt: now, seeds: ["https://lab.test/"], frontier, renderPage });
  event("crawl.e2e", { rendered: doc.meta.stats.pagesRendered, scenes: doc.scenes.length });
  assert.ok(doc.meta.stats.pagesRendered >= 3, "playwrightRenderPage drove goto+evaluate for each representative");
  assert.ok(doc.scenes.every((scene) => scene.evidenceStatus === "crawled"), "rendered pages are crawled");
  assert.ok(doc.scenes.some((scene) => scene.urlTemplates[0].pathnamePattern === "/p/{path1}"), "product clustered");
  assert.ok(doc.scenes.some((scene) => scene.name === "首页"), "server-side render fed real headings into scenes");
});

scenario("knowledge-hash-route-identity", async ({ event }) => {
  const urlScene = await bundledModule("../../lib/site-knowledge/url-scene.ts");
  const O = "http://localhost:4000";
  const scene = (url) => urlScene.sceneFromSnapshot({ id: "s", sessionId: "c", documentId: "d", sequence: 1, url, title: "t", heading: "h", visibleText: "x", links: [], elements: [], capturedAt: now });
  // Distinct hash routes → distinct Scenes (was: all collapsed onto "/").
  const ids = ["#/client/list", "#/orders", "#/settings"].map((h) => scene(`${O}/${h}`).id);
  event("hash.scenes", { ids });
  assert.equal(new Set(ids).size, 3, "three hash routes must be three Scenes");
  // Dynamic hash segment parameterized + routeMode hash.
  const t = urlScene.urlTemplateFromUrl(`${O}/#/order/123456`);
  assert.equal(t.pathnamePattern, "/order/{path1}");
  assert.equal(t.routeMode, "hash");
  // Match binds the id; does not cross-match other routes or non-hash URLs.
  assert.deepEqual(urlScene.matchUrlTemplate(t, `${O}/#/order/999`), { path1: "999" });
  assert.equal(urlScene.matchUrlTemplate(t, `${O}/#/client/list`), null);
  assert.equal(urlScene.matchUrlTemplate(t, `${O}/order/999`), null, "non-hash url must not match a hash template");
  // Round-trips back to a hash URL.
  assert.equal(urlScene.buildSceneUrl(scene(`${O}/#/order/123456`), { path1: "777" }, O), `${O}/#/order/777`);
  // Non-hash sites unchanged.
  const p = urlScene.urlTemplateFromUrl(`${O}/products/1001`);
  assert.equal(p.pathnamePattern, "/products/{path1}");
  assert.equal(p.routeMode, undefined);
  // Plain #anchor stays a hash param, not a route.
  assert.equal(urlScene.urlTemplateFromUrl(`${O}/search#items`).routeMode, undefined);
});

scenario("knowledge-extract-selfcontained", async ({ event }) => {
  // Phase A: the independent Site Knowledge base derived from a Release must be
  // self-contained (profile/scenes/links/tree only), stable-hashed, and carry NO
  // execution/config — proving knowledge is separable from the release.
  const discovery = await bundledModule("../../lib/site-knowledge/discovery.ts");
  const protocol = await bundledModule("../../lib/site-knowledge/protocol.ts");
  const knowledgeModel = await bundledModule("../../lib/site-knowledge/knowledge-model.ts");
  const home = snapshot("https://lab.test/", "Atlas Lab", [
    { text: "商品 甲", url: "https://lab.test/products/1001" },
    { text: "商品 乙", url: "https://lab.test/products/1002" },
    { text: "订单", url: "https://lab.test/orders/9" },
  ]);
  const first = discovery.discoverInitialKnowledge(home);
  const release = protocol.emptyRelease("lab", now);
  release.profile = { ...release.profile, name: "Atlas Lab" };
  release.scenes = first.scenes;
  release.linkReferences = first.linkReferences;

  const knowledge = knowledgeModel.siteKnowledgeFromRelease(release);
  event("knowledge.derived", { scenes: knowledge.scenes.length, links: knowledge.links.length, hash: knowledge.contentHash });

  assert.equal(knowledge.schemaVersion, "site-knowledge/v1");
  assert.equal(knowledge.siteAgentId, "lab");
  assert.equal(knowledge.version, release.version);
  // Four parts mirror the release exactly (dual-write consistency, task 3.4).
  assert.deepEqual(knowledge.profile, release.profile);
  assert.deepEqual(knowledge.scenes, release.scenes);
  assert.deepEqual(knowledge.links, release.linkReferences);
  // Source-only: no execution/config AND no derived topology (`tree`) is stored — the
  // site-map is recomputed on demand by consumers (buildBusinessTopologyFromParts).
  for (const forbidden of ["operations", "capabilities", "targets", "agentConfig", "linkReferences", "tree"]) {
    assert.ok(!(forbidden in knowledge), `knowledge must not carry ${forbidden}`);
  }
  // Content hash is deterministic over the source parts and ignores version/timestamps.
  const again = knowledgeModel.buildSiteKnowledge({
    siteAgentId: "lab", version: 999, updatedAt: "2030-01-01T00:00:00.000Z",
    profile: release.profile, scenes: release.scenes, links: release.linkReferences,
  });
  assert.equal(again.contentHash, knowledge.contentHash, "same content → same hash (version/time excluded)");
  const mutated = knowledgeModel.buildSiteKnowledge({
    siteAgentId: "lab", version: release.version, updatedAt: now,
    profile: { ...release.profile, name: "Different" }, scenes: release.scenes, links: release.linkReferences,
  });
  assert.notEqual(mutated.contentHash, knowledge.contentHash, "changed content → changed hash");
});

scenario("knowledge-flow-overlay", async ({ event }) => {
  // The site knowledge view renders a knowledge-pure base (no execution edges); the
  // operation-derived business flows are a separate, toggleable overlay whose
  // endpoints must line up with the base nodes.
  const discovery = await bundledModule("../../lib/site-knowledge/discovery.ts");
  const topo = await bundledModule("../../lib/site-knowledge/business-topology.ts");
  const home = snapshot("https://flow.test/", "Flow Lab", [
    { text: "列表", url: "https://flow.test/list" },
    { text: "详情", url: "https://flow.test/detail/1" },
  ]);
  const first = discovery.discoverInitialKnowledge(home);
  const list = first.scenes.find((s) => s.urlTemplates[0].pathnamePattern === "/list");
  const detail = first.scenes.find((s) => s.urlTemplates[0].pathnamePattern.startsWith("/detail"));
  assert.ok(list && detail, "fixture must yield a list and a detail scene");
  const release = {
    profile: { name: "Flow Lab" },
    scenes: first.scenes,
    linkReferences: first.linkReferences,
    operations: [{
      id: "op-search", name: "搜索并进入详情", fromSceneId: list.id, toSceneId: detail.id,
      status: "verified", effects: [], evidenceSource: "observed-transition",
      implementations: [{ successes: 3, sourceEpisodeIds: ["e1"] }],
    }],
  };

  // 1) Knowledge-pure base (scenes + links only) carries NO business-flow edges.
  const pure = topo.buildBusinessTopologyFromParts({ rootName: "Flow Lab", scenes: release.scenes, linkReferences: release.linkReferences });
  const pureFlow = [...pure.primaryEdges, ...pure.secondaryEdges].filter((e) => e.kind === "business-flow");
  assert.equal(pureFlow.length, 0, "knowledge-pure base must not contain execution flow edges");

  // 2) The overlay surfaces the operation edge, keyed by scene ids that are base nodes.
  const flows = topo.businessFlowEdges(release);
  event("flows", { count: flows.length });
  assert.equal(flows.length, 1);
  assert.equal(flows[0].kind, "business-flow");
  assert.equal(flows[0].from, list.id);
  assert.equal(flows[0].to, detail.id);
  const nodeIds = new Set(pure.nodes.map((n) => n.id));
  assert.ok(nodeIds.has(flows[0].from) && nodeIds.has(flows[0].to), "overlay endpoints must exist as base nodes");

  // 3) The full topology DOES include the flow edge — proving the only difference
  //    between base and full is the execution overlay.
  const withOps = topo.buildBusinessTopology(release);
  const withFlow = [...withOps.primaryEdges, ...withOps.secondaryEdges].filter((e) => e.kind === "business-flow");
  assert.ok(withFlow.length >= 1, "with-operations topology includes the flow edge");
});

scenario("knowledge-storage-dedup-roundtrip", async ({ event }) => {
  // Phase C: scenes/links are deduped into the knowledge table; the release is
  // stored slim and rehydrated on read. The round-trip MUST be lossless AND
  // re-hash byte-identically (etags / INSERT-OR-IGNORE dedup depend on contentHash).
  const protocol = await bundledModule("../../lib/site-knowledge/protocol.ts");
  const canonicalize = await bundledModule("../../lib/site-knowledge/canonicalize.ts");
  const model = await bundledModule("../../lib/site-knowledge/knowledge-model.ts");
  const discovery = await bundledModule("../../lib/site-knowledge/discovery.ts");

  const home = snapshot("https://dedup.test/", "Dedup Lab", [
    { text: "列表", url: "https://dedup.test/list" },
    { text: "详情甲", url: "https://dedup.test/detail/1" },
    { text: "详情乙", url: "https://dedup.test/detail/2" },
  ]);
  const first = discovery.discoverInitialKnowledge(home);
  const release = protocol.emptyRelease("dedup", now);
  release.profile = { ...release.profile, name: "Dedup Lab" };
  release.scenes = first.scenes;
  release.linkReferences = first.linkReferences;

  // Mirror the store's canonicalRelease (the consumer-facing read). knowledgeRevision
  // is a derived pointer, excluded from the release hash (as production now does).
  const canonicalRelease = (r) => {
    const normalized = canonicalize.canonicalizeReleaseKnowledge(r);
    if (JSON.stringify(normalized) === JSON.stringify(r)) return normalized;
    return { ...normalized, contentHash: protocol.stableHash(JSON.stringify({ ...normalized, contentHash: undefined, knowledgeRevision: undefined })) };
  };
  const before = canonicalRelease(release);

  // Storage round-trip.
  const knowledge = model.siteKnowledgeFromRelease(canonicalize.canonicalizeReleaseKnowledge(release));
  const stored = model.stripReleaseKnowledge(release, knowledge);
  event("stored", { scenes: stored.scenes.length, sceneCount: stored.sceneCount, knowledgeVersion: stored.knowledgeVersion });
  assert.equal(stored.scenes.length, 0, "stored release must not embed scenes");
  assert.equal(stored.linkReferences.length, 0, "stored release must not embed links");
  assert.equal(stored.sceneCount, knowledge.scenes.length);
  assert.equal(stored.knowledgeVersion, release.version);

  const rehydrated = model.rehydrateReleaseKnowledge(stored, knowledge);
  assert.ok(!("knowledgeVersion" in rehydrated) && !("sceneCount" in rehydrated), "storage-only fields dropped on rehydrate");
  const after = canonicalRelease(rehydrated);

  assert.equal(after.contentHash, before.contentHash, "rehydrated release must re-hash identically");
  assert.deepEqual(after.scenes, before.scenes, "scenes restored exactly");
  assert.deepEqual(after.linkReferences, before.linkReferences, "links restored exactly");

  // Distinguishes embedded (old) from slim (migrated).
  assert.equal(model.releaseEmbedsKnowledge(before), true);
  assert.equal(model.releaseEmbedsKnowledge(stored), false);

  // Reference integrity (task 6.3): every operation endpoint resolves in the knowledge scenes.
  const sceneIds = new Set(knowledge.scenes.map((s) => s.id));
  for (const op of after.operations) {
    if (op.toSceneId) assert.ok(sceneIds.has(op.toSceneId) || op.toSceneId === "*", `operation ${op.id} toScene resolvable`);
  }
});

scenario("knowledge-storage-dedup-noncanonical", async ({ event }) => {
  // The Phase C round-trip must hold for a NON-canonical legacy release (scenes
  // that cluster; operations/targets/capabilities referencing the pre-cluster ids).
  // The knowledge and the stored execution graph must share ONE canonical scene-id
  // space, or ops end up dangling and contentHash diverges (ETag break).
  const protocol = await bundledModule("../../lib/site-knowledge/protocol.ts");
  const canon = await bundledModule("../../lib/site-knowledge/canonicalize.ts");
  const model = await bundledModule("../../lib/site-knowledge/knowledge-model.ts");

  const release = protocol.emptyRelease("demo", now);
  const template = { id: "url-search", originPattern: "https://demo.test", pathnamePattern: "/search", query: {} };
  release.scenes = [
    { id: "search-empty", name: "search详情", urlTemplates: [template], parameters: [], verifier: {}, directEntry: "candidate", sourceObservationIds: ["obs-1"], updatedAt: now },
    { id: "search-query", name: "历史热搜查询", description: "查询历史热搜", urlTemplates: [{ ...template, id: "url-search-q", query: { q: "{q?}" } }], parameters: [{ id: "q", name: "关键词", type: "string", required: false, examples: ["航天"] }], verifier: {}, directEntry: "verified", sourceObservationIds: ["obs-2"], updatedAt: now },
  ];
  release.targets = [{ id: "target-search", name: "搜索", sceneIds: ["search-empty", "search-query"], accessibleNames: ["搜索"], attributes: {}, locatorVariants: [], updatedAt: now }];
  release.operations = [{ id: "operation-search", name: "搜索", kind: "business-transition", evidenceSource: "observed-transition", fromSceneId: "search-empty", toSceneId: "search-query", inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} }, preconditions: [], effects: [], implementations: [], verification: { sceneId: "search-query", targetIds: ["target-search"] }, status: "candidate", updatedAt: now }];

  const canonicalRelease = (r) => {
    const n = canon.canonicalizeReleaseKnowledge(r);
    if (JSON.stringify(n) === JSON.stringify(r)) return n;
    return { ...n, contentHash: protocol.stableHash(JSON.stringify({ ...n, contentHash: undefined })) };
  };
  const before = canonicalRelease(release); // pre-Phase-C consumer view
  assert.equal(before.scenes.length, 1, "fixture must actually cluster (non-canonical)");

  // Fixed Phase C path: canonicalize ONCE, then derive knowledge / slim / rehydrate.
  const canonical = canon.canonicalizeReleaseKnowledge(release);
  const knowledge = model.siteKnowledgeFromRelease(canonical);
  const stored = model.stripReleaseKnowledge(canonical, knowledge);
  const rehydrated = model.rehydrateReleaseKnowledge(stored, knowledge);
  const after = canonicalRelease(rehydrated);
  event("hashes", { before: before.contentHash, after: after.contentHash });

  assert.equal(after.contentHash, before.contentHash, "non-canonical release: contentHash byte-stable across Phase C");

  // No dangling references in the served execution graph.
  const sceneIds = new Set(after.scenes.map((s) => s.id));
  for (const op of after.operations) {
    if (op.fromSceneId && op.fromSceneId !== "*") assert.ok(sceneIds.has(op.fromSceneId), `op.fromSceneId ${op.fromSceneId} must resolve`);
    if (op.toSceneId && op.toSceneId !== "*") assert.ok(sceneIds.has(op.toSceneId), `op.toSceneId ${op.toSceneId} must resolve`);
  }
  for (const target of after.targets) for (const sid of target.sceneIds) assert.ok(sceneIds.has(sid), `target scene ${sid} must resolve`);
});

scenario("knowledge-material-hash", async ({ event }) => {
  // P0 (stop self-consumption): a re-visit that only bumps timestamps / grows
  // observed-url logs / examples must NOT change the material knowledge hash (no
  // version bloat); a real business change must.
  const model = await bundledModule("../../lib/site-knowledge/knowledge-model.ts");
  const profile = { name: "站点", description: "desc", semanticSource: "program", vocabulary: {}, suggestedGoals: [] };
  const scene = (over = {}) => ({
    id: "s1", name: "列表", semanticSource: "program", businessArea: "订单", evidenceStatus: "observed",
    identityConfidence: 0.7, directEntry: "candidate",
    evidence: { linkLabels: [], observedUrls: ["https://x/list"], titles: ["列表"], headings: ["列表页"] },
    urlTemplates: [{ id: "u1", originPattern: "https://x", pathnamePattern: "/list", query: {} }],
    parameters: [{ id: "p", name: "q", type: "string", required: false, examples: ["a"] }],
    verifier: {}, sourceObservationIds: ["o1"], updatedAt: now, ...over,
  });
  const links = [{ id: "l1", fromSceneId: "root", toSceneId: "s1", label: "列表", observations: 1, updatedAt: now }];
  const base = model.materialKnowledgeHash({ profile, scenes: [scene()], links });

  const revisited = model.materialKnowledgeHash({
    profile,
    scenes: [scene({ updatedAt: "2030-01-01T00:00:00.000Z", sourceObservationIds: ["o1", "o2", "o3"], identityConfidence: 0.95,
      evidence: { linkLabels: [], observedUrls: ["https://x/list", "https://x/list?p=2"], titles: ["列表"], headings: ["列表页"] },
      parameters: [{ id: "p", name: "q", type: "string", required: false, examples: ["a", "b", "c"] }] })],
    links: [{ ...links[0], observations: 99, updatedAt: "2030-01-01T00:00:00.000Z" }],
  });
  event("hashes", { base, revisited });
  assert.equal(revisited, base, "re-visit churn (timestamps/observedUrls/examples) must NOT change the material hash");

  assert.notEqual(model.materialKnowledgeHash({ profile, scenes: [scene({ businessArea: "客户" })], links }), base, "businessArea change is material");
  assert.notEqual(model.materialKnowledgeHash({ profile, scenes: [scene({ semanticSource: "ai" })], links }), base, "semanticSource program→ai is material");
  assert.notEqual(model.materialKnowledgeHash({ profile, scenes: [scene({ evidenceStatus: "entry-verified" })], links }), base, "evidenceStatus promotion is material");
  assert.notEqual(model.materialKnowledgeHash({ profile, scenes: [scene({ evidence: { linkLabels: [], observedUrls: ["https://x/list"], titles: ["列表"], headings: ["列表页", "已归档"] } })], links }), base, "a new heading (real content) is material");

  assert.deepEqual(model.stripVolatile({ a: 1, updatedAt: "t", nested: { observedUrls: ["u"], keep: 2 } }), { a: 1, nested: { keep: 2 } });
});

scenario("knowledge-search-returns-path", async ({ event }) => {
  // P0/P1-a: the main-agent knowledge search exposes the PATH template + required
  // params + readiness (not the bare origin/domain), now by delegating to the single
  // authoritative index which builds the path template.
  const port = await readFile(new URL("../../client/user-agent-port.ts", import.meta.url), "utf8");
  const planner = await readFile(new URL("../../lib/site-knowledge/planner.ts", import.meta.url), "utf8");
  assert.match(port, /const index = searchKnowledgeIndex\(this\.release, query\)/);
  assert.match(port, /urlTemplate: scene\.urlTemplate, requiredParams: scene\.requiredParams, directEntry: scene\.directEntry/);
  assert.doesNotMatch(port, /urlTemplate: scene\.urlTemplates\[0\]\?\.originPattern/);
  assert.match(planner, /urlTemplate: template \? `\$\{template\.pathnamePattern\}\$\{query\}` : undefined/);
  event("search.path", { ok: true });
});

scenario("knowledge-unified-index", async ({ event }) => {
  // P1-a: one authoritative search — scenes carry the PATH template + required
  // params + directEntry, RANKED by readiness (verified first) but NOT filtered to
  // verified-only (label, don't starve).
  const protocol = await bundledModule("../../lib/site-knowledge/protocol.ts");
  const planner = await bundledModule("../../lib/site-knowledge/planner.ts");
  const release = protocol.emptyRelease("idx", now);
  release.profile = { ...release.profile, name: "站点", taskTemplates: [{ id: "t1", name: "查看订单", description: "查看订单列表", goalTemplate: "查看订单", requiredInputs: [], confidence: 0.8 }] };
  const scene = (id, path, over = {}) => ({ id, name: id, businessArea: "订单", semanticSource: "program", evidenceStatus: "observed", directEntry: "candidate", identityConfidence: .7, evidence: { linkLabels: [], observedUrls: [], titles: [], headings: [] }, urlTemplates: [{ id: `u-${id}`, originPattern: "https://x", pathnamePattern: path, query: {} }], parameters: [], verifier: {}, sourceObservationIds: [], updatedAt: now, ...over });
  release.scenes = [
    scene("订单列表", "/orders"),
    scene("订单详情", "/orders/{path1}", { directEntry: "verified", evidenceStatus: "entry-verified", parameters: [{ id: "path1", name: "订单号", type: "string", required: true, examples: [] }] }),
    scene("无关页", "/about", { businessArea: "关于" }),
  ];

  const index = planner.searchKnowledgeIndex(release, "查看订单");
  event("index", { scenes: index.scenes.length, tasks: index.tasks.length });
  assert.ok(index.tasks.some((task) => task.name === "查看订单"), "matched task returned");
  assert.ok(index.hasRoute, "hasRoute true when a task/scene matches");
  const detail = index.scenes.find((s) => s.id === "订单详情");
  assert.ok(detail, "relevant scene present");
  assert.equal(detail.urlTemplate, "/orders/{path1}", "PATH template, not domain");
  assert.deepEqual(detail.requiredParams, ["订单号"]);
  assert.equal(detail.directEntry, "verified");
  assert.equal(detail.readiness, 3);
  const orders = index.scenes.find((s) => s.id === "订单列表");
  assert.ok(orders, "unverified but relevant scene still returned (labeled, not starved)");
  assert.ok(index.scenes.indexOf(detail) < index.scenes.indexOf(orders), "verified ranks above unverified");

  // buildAgentRoutingContext now delegates to the index (real caller) and is no
  // longer verified-only-starved.
  const routing = planner.buildAgentRoutingContext(release, "查看订单");
  assert.ok(routing.scenes.length >= 1 && routing.hasRelevantRoute, "routing context populated via the shared index");
});

scenario("knowledge-entry-verification", async ({ event }) => {
  // P1-b: the missing rung — a scene becomes "verified" ONLY via a real verified
  // reach; structural faults demote a verified entry; the material transition
  // re-versions while health counters stay volatile.
  const ev = await bundledModule("../../lib/site-knowledge/entry-verification.ts");
  const scene = (over = {}) => ({ id: "s1", name: "订单详情", directEntry: "candidate", evidenceStatus: "observed", urlTemplates: [], parameters: [], verifier: {}, sourceObservationIds: [], updatedAt: now, ...over });

  const promoted = ev.applyEntryFeedback(scene(), { kind: "reached-verified", at: "2026-07-27T00:00:00.000Z" });
  assert.equal(promoted.directEntry, "verified");
  assert.equal(promoted.evidenceStatus, "entry-verified");
  assert.equal(promoted.lastVerifiedAt, "2026-07-27T00:00:00.000Z");
  assert.equal(promoted.entryHealth.successes, 1);
  assert.equal(promoted.entryHealth.failStreak, 0);

  let s = { ...promoted };
  s = ev.applyEntryFeedback(s, { kind: "structural-fault", at: "2026-07-27T01:00:00.000Z", reason: "target_not_found" });
  assert.equal(s.directEntry, "verified", "one fault does not demote (hysteresis)");
  s = ev.applyEntryFeedback(s, { kind: "structural-fault", at: "2026-07-27T02:00:00.000Z", reason: "target_not_found" });
  assert.equal(s.directEntry, "needs-reverify", "two structural faults demote a verified entry");
  assert.equal(s.verificationFailure, "target_not_found");
  assert.ok(s.demotedAt);
  event("demoted", { failStreak: s.entryHealth.failStreak });

  let c = scene();
  for (let i = 0; i < 4; i += 1) c = ev.applyEntryFeedback(c, { kind: "structural-fault", at: now, reason: "scene_binding_missing" });
  assert.equal(c.directEntry, "failed", "a candidate that keeps failing is marked failed");

  const touched = ev.applyEntryFeedback(scene(), { kind: "machinery-ok", at: now });
  assert.equal(touched.directEntry, "candidate", "machinery success alone does not verify");
  assert.equal(touched.entryHealth.successes, 1);

  const rehealed = ev.applyEntryFeedback({ ...s }, { kind: "reached-verified", at: "2026-07-27T03:00:00.000Z" });
  assert.equal(rehealed.directEntry, "verified");
  assert.equal(rehealed.verificationFailure, undefined);

  const dayMs = 86400000;
  const t0 = Date.parse("2026-07-27T00:00:00.000Z");
  assert.equal(ev.entryNeedsReverify(promoted, t0 + 2 * dayMs, dayMs), true, "verified past TTL needs reverify");
  assert.equal(ev.entryNeedsReverify(promoted, t0 + 1000, dayMs), false, "fresh verified is not stale");
  assert.equal(ev.entryNeedsReverify(s, t0, dayMs), true, "needs-reverify always needs reverify");

  // The material hash must ignore entry-health churn but react to the directEntry transition.
  const model = await bundledModule("../../lib/site-knowledge/knowledge-model.ts");
  const profile = { name: "站点", description: "", semanticSource: "program", vocabulary: {}, suggestedGoals: [] };
  const base = model.materialKnowledgeHash({ profile, scenes: [scene()], links: [] });
  assert.equal(model.materialKnowledgeHash({ profile, scenes: [ev.applyEntryFeedback(scene(), { kind: "machinery-ok", at: "2099-01-01T00:00:00.000Z" })], links: [] }), base, "counter/timestamp churn is not material");
  assert.notEqual(model.materialKnowledgeHash({ profile, scenes: [promoted], links: [] }), base, "the verified transition IS material");
});

scenario("knowledge-demotion-aware-merge", async ({ event }) => {
  // P1-b step 6: merges must let a DEMOTION stick — no silent re-promotion of a
  // demoted entry by a stale verified copy — while a plain re-observation never
  // demotes a verified entry.
  const discovery = await bundledModule("../../lib/site-knowledge/discovery.ts");
  const scene = (over = {}) => ({ id: "s1", name: "订单详情", semanticSource: "program", evidenceStatus: "observed", directEntry: "candidate", identityConfidence: .7, evidence: { linkLabels: [], observedUrls: [], titles: [], headings: [] }, urlTemplates: [{ id: "u1", originPattern: "https://x", pathnamePattern: "/o/{p}", query: {} }], parameters: [], verifier: {}, sourceObservationIds: [], updatedAt: now, ...over });

  const verified = scene({ directEntry: "verified", evidenceStatus: "entry-verified", lastVerifiedAt: "2026-07-27T00:00:00.000Z" });
  const reobservation = scene({ evidenceStatus: "observed", updatedAt: "2026-07-27T05:00:00.000Z" });

  const m1 = discovery.mergeSceneEvidence(verified, reobservation);
  assert.equal(m1.directEntry, "verified", "re-observation does not demote a verified entry");
  assert.equal(m1.evidenceStatus, "entry-verified");

  const demoted = scene({ directEntry: "needs-reverify", evidenceStatus: "observed", demotedAt: "2026-07-27T06:00:00.000Z", verificationFailure: "target_not_found" });
  const m2 = discovery.mergeSceneEvidence(verified, demoted);
  assert.equal(m2.directEntry, "needs-reverify", "a newer demotion is NOT re-promoted by a stale verified copy");
  assert.notEqual(m2.evidenceStatus, "entry-verified", "evidenceStatus follows the demotion");
  event("merge", { m1: m1.directEntry, m2: m2.directEntry });

  const m3 = discovery.mergeSceneEvidence(demoted, reobservation);
  assert.equal(m3.directEntry, "needs-reverify", "re-observation of a demoted scene keeps it demoted");

  // A newer verification wins over an older demotion (recovery).
  const reverified = scene({ directEntry: "verified", evidenceStatus: "entry-verified", lastVerifiedAt: "2026-07-27T09:00:00.000Z" });
  const m4 = discovery.mergeSceneEvidence(demoted, reverified);
  assert.equal(m4.directEntry, "verified", "a newer re-verification recovers a demoted entry");
});

scenario("knowledge-entry-verifier", async ({ event }) => {
  // P1-b: the pure verifier the browser runner calls — build the candidate's URL
  // from sample bindings, then assert the opened page IS that scene.
  const ev = await bundledModule("../../lib/site-knowledge/entry-verification.ts");
  const scene = {
    id: "s1", name: "订单详情", directEntry: "candidate", evidenceStatus: "observed",
    urlTemplates: [{ id: "u1", originPattern: "https://x.test", pathnamePattern: "/orders/{path1}", query: {} }],
    parameters: [{ id: "path1", name: "订单号", type: "string", required: true, examples: ["A100"] }],
    verifier: { titleIncludes: ["订单"], headingIncludes: ["详情"], textIncludes: [] },
    sourceObservationIds: [], updatedAt: now,
  };

  assert.deepEqual(ev.sampleEntryBindings(scene), { path1: "A100" }, "sample bindings come from param examples");
  assert.equal(ev.sampleEntryBindings({ ...scene, parameters: [{ id: "x", name: "x", type: "string", required: true, examples: [] }] }), undefined, "a required param with no example cannot be probed");

  const at = "2026-07-27T00:00:00.000Z";
  const ok = ev.verifyEntry(scene, { url: "https://x.test/orders/A100", title: "订单 A100", heading: "订单详情页", visibleText: "…" }, at);
  assert.equal(ok.kind, "reached-verified", "matching URL + passing verifier earns verified");

  assert.equal(ev.verifyEntry(scene, { url: "https://x.test/about", title: "订单", heading: "详情", visibleText: "" }, at).reason, "url_template_mismatch", "wrong page is not the scene");
  assert.equal(ev.verifyEntry(scene, { url: "https://x.test/orders/A100", title: "About", heading: "详情", visibleText: "" }, at).reason, "title_assertion_failed", "title assertion must hold");
  event("verifier", { ok: ok.kind });

  // End-to-end: verify → apply feedback → the candidate becomes verified.
  const verified = ev.applyEntryFeedback(scene, ev.verifyEntry(scene, { url: "https://x.test/orders/A100", title: "订单 A100", heading: "订单详情页", visibleText: "…" }, at));
  assert.equal(verified.directEntry, "verified");
  assert.equal(verified.evidenceStatus, "entry-verified");
});

scenario("knowledge-readiness-funnel", async ({ event }) => {
  // P2 (4.2): the four honest numbers + per-scene "why not promoted" as ONE pure
  // funnel — discovered ≥ semantically-reviewed ≥ entry-verified. Task capability is
  // the capability center's concern and is deliberately NOT a knowledge-readiness rung.
  const protocol = await bundledModule("../../lib/site-knowledge/protocol.ts");
  const planner = await bundledModule("../../lib/site-knowledge/planner.ts");
  const release = protocol.emptyRelease("rd", now);
  const scene = (id, over = {}) => ({ id, name: id, semanticSource: "program", evidenceStatus: "observed", directEntry: "candidate", identityConfidence: .7, evidence: { linkLabels: [], observedUrls: [], titles: [], headings: [] }, urlTemplates: [{ id: `u-${id}`, originPattern: "https://x", pathnamePattern: `/${id}/{path1}`, query: {} }], parameters: [{ id: "path1", name: "编号", type: "string", required: true, examples: ["A1"] }], verifier: {}, sourceObservationIds: [], updatedAt: now, ...over });
  release.scenes = [
    scene("A", { semanticSource: "program", evidenceStatus: "referenced", evidence: { linkLabels: [], observedUrls: [], titles: [], headings: [] } }), // discovered / not-visited
    scene("B", { semanticSource: "ai" }),                                                                    // reviewed, candidate w/ example → not-probed
    scene("C", { directEntry: "verified", evidenceStatus: "entry-verified" }),                               // entry-verified, no capability
    scene("D", { directEntry: "verified", evidenceStatus: "entry-verified" }),                               // entry-verified — a capability routes through it, but readiness ignores that
    scene("E", { semanticSource: "ai", parameters: [{ id: "path1", name: "编号", type: "string", required: true, examples: [] }] }), // reviewed but un-probeable
    scene("F", { semanticSource: "ai", directEntry: "needs-reverify", verificationFailure: "title_assertion_failed", demotedAt: now }), // demoted (reviewed)
    // G: verified-then-demoted but NEVER semantically reviewed (semanticSource stays
    // "program" — the entry reducer never sets it). It must still classify at the
    // ENTRY rung ("entry-demoted"), not fall back two rungs to "awaiting-review".
    scene("G", { semanticSource: "program", evidenceStatus: "observed", directEntry: "needs-reverify", verificationFailure: "text_assertion_failed", demotedAt: now }),
  ];
  release.capabilities = [{ id: "cap1", kind: "task", exposure: "public", status: "available", name: "下单", description: "", normalizedGoal: "下单", aliases: [], inputs: { type: "object" }, outputs: { type: "object" }, outcomes: [], plans: [{ id: "p1", entrySceneIds: ["D"], steps: [], outputBindings: {} }], sourceEpisodeIds: [], confidence: 0.9, updatedAt: now }];

  const r = planner.computeKnowledgeReadiness(release);
  event("funnel", { discovered: r.discovered, reviewed: r.semanticReviewed, verified: r.entryVerified });
  assert.equal(r.discovered, 7, "every scene is discovered");
  assert.equal(r.semanticReviewed, 6, "B,E,F,G past the candidate rung + C,D verified count toward reviewed");
  assert.equal(r.entryVerified, 2, "only C,D reached entry-verified");
  assert.equal(r.taskCapable, undefined, "task capability is not a knowledge-readiness rung");
  assert.ok(r.discovered >= r.semanticReviewed && r.semanticReviewed >= r.entryVerified, "funnel is monotonic");

  const by = Object.fromEntries(r.scenes.map((s) => [s.sceneId, s]));
  assert.equal(by.A.tier, "discovered"); assert.equal(by.A.reasonCode, "not-visited");
  assert.equal(by.B.tier, "semantically-reviewed"); assert.equal(by.B.reasonCode, "not-probed");
  assert.equal(by.C.tier, "entry-verified"); assert.equal(by.C.nextTier, undefined, "可访问 is the terminal rung — no next step");
  assert.equal(by.D.tier, "entry-verified"); assert.equal(by.D.reasonCode, undefined, "a capability routing through D does not change its knowledge readiness");
  assert.equal(by.E.reasonCode, "missing-param-example", "required param without an example can't be probed");
  assert.equal(by.F.reasonCode, "entry-demoted"); assert.ok(by.F.detail.includes("title_assertion_failed"), "demotion detail carries the failure");
  // Regression (adversarial review): an unreviewed demoted scene reports the ENTRY
  // blocker, not a wrong-rung "wait for AI review", and stays counted as reviewed.
  assert.equal(by.G.tier, "semantically-reviewed"); assert.equal(by.G.reasonCode, "entry-demoted");
  assert.ok(by.G.detail.includes("text_assertion_failed"), "unreviewed demotion still surfaces the real entry fault");
});

scenario("knowledge-loop-closed", async ({ event }) => {
  // P2 (5.1): the whole loop, pure — observe → merge → review → verify entry →
  // search returns a routable entry → a simulated execution fault demotes it and
  // the SAME search now reports it degraded. The "loop closed" proof the suite lacked.
  const protocol = await bundledModule("../../lib/site-knowledge/protocol.ts");
  const discovery = await bundledModule("../../lib/site-knowledge/discovery.ts");
  const ev = await bundledModule("../../lib/site-knowledge/entry-verification.ts");
  const planner = await bundledModule("../../lib/site-knowledge/planner.ts");
  const km = await bundledModule("../../lib/site-knowledge/knowledge-model.ts");
  const at = "2026-07-27T00:00:00.000Z";

  // 1. OBSERVE + 2. MERGE — a re-observation of the same page keeps it observed.
  const base = { id: "s1", name: "订单详情", semanticSource: "program", evidenceStatus: "observed", directEntry: "candidate", identityConfidence: .7, evidence: { linkLabels: [], observedUrls: ["https://lab.test/orders/A100"], titles: [], headings: [] }, urlTemplates: [{ id: "u1", originPattern: "https://lab.test", pathnamePattern: "/orders/{path1}", query: {} }], parameters: [{ id: "path1", name: "订单号", type: "string", required: true, examples: ["A100"] }], verifier: { titleIncludes: ["订单"], headingIncludes: ["详情"] }, sourceObservationIds: ["o1"], updatedAt: at };
  const merged = discovery.mergeSceneEvidence(base, { ...base, sourceObservationIds: ["o2"], updatedAt: at });
  assert.equal(merged.evidenceStatus, "observed", "re-observation keeps the scene observed");

  // 3. REVIEW (simulated — the reviewSceneSemantics output shape, no model call).
  const reviewed = { ...merged, semanticSource: "ai", description: "单个订单的详情页", businessArea: "订单" };

  // 4. VERIFY ENTRY — build the URL from examples, assert the page, promote.
  assert.deepEqual(ev.sampleEntryBindings(reviewed), { path1: "A100" }, "probe params sourced from examples");
  const feedback = ev.verifyEntry(reviewed, { url: "https://lab.test/orders/A100", title: "订单 A100", heading: "订单详情页", visibleText: "…" }, at);
  assert.equal(feedback.kind, "reached-verified");
  const verified = ev.applyEntryFeedback(reviewed, feedback);
  assert.equal(verified.directEntry, "verified");
  assert.equal(verified.evidenceStatus, "entry-verified");

  // 5. SEARCH — the now-verified scene is a routable entry, ranked verified.
  const release = protocol.emptyRelease("lab", at);
  release.profile = { ...release.profile, name: "实验站", taskTemplates: [{ id: "t1", name: "查看订单", description: "查看订单详情", goalTemplate: "查看订单", requiredInputs: [], confidence: 0.8 }] };
  release.scenes = [verified];
  const hit = planner.searchKnowledgeIndex(release, "查看订单 A100").scenes.find((s) => s.id === "s1");
  assert.ok(hit, "verified scene routable from search");
  assert.equal(hit.urlTemplate, "/orders/{path1}");
  assert.equal(hit.directEntry, "verified");
  assert.equal(hit.readiness, 3);
  assert.equal(planner.computeKnowledgeReadiness(release).entryVerified, 1, "readiness funnel counts the verified entry");
  const versionA = km.materialKnowledgeHash({ profile: release.profile, scenes: release.scenes, links: [] });

  // 6. DEMOTE — a simulated execution fault (x2) demotes verified → needs-reverify;
  // the SAME search now reports it degraded, and the material hash re-versions.
  // The faults are stamped strictly after the verification (as they are in the real
  // loop), so the demotion-aware merge favours the newer demote over the verify.
  const later = "2026-07-27T01:00:00.000Z";
  let s = verified;
  s = ev.applyEntryFeedback(s, { kind: "structural-fault", at: later, reason: "target_not_found" });
  s = ev.applyEntryFeedback(s, { kind: "structural-fault", at: later, reason: "target_not_found" });
  assert.equal(s.directEntry, "needs-reverify", "two faults demote a verified entry");
  release.scenes = [s];
  const afterDemote = planner.searchKnowledgeIndex(release, "查看订单 A100").scenes.find((x) => x.id === "s1");
  assert.equal(afterDemote.directEntry, "needs-reverify", "search reflects the demotion");
  assert.ok(afterDemote.readiness < 3, "degraded entry no longer ranks as verified");
  assert.equal(discovery.mergeSceneEvidence(verified, s).directEntry, "needs-reverify", "merge keeps the demotion (no stale re-promotion)");
  assert.notEqual(versionA, km.materialKnowledgeHash({ profile: release.profile, scenes: release.scenes, links: [] }), "the verify→demote transition is material");
  event("loop", { verified: hit.directEntry, demoted: afterDemote.directEntry });
});
