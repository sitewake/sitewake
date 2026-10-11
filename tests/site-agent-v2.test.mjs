import assert from "node:assert/strict";
const src_lib_site_knowledge_protocol_ts = readFileSync(new URL("../lib/site-knowledge/protocol.ts", import.meta.url), "utf8"); // `evolutionAssessment` lives here now
const src_lib_page_agent_control_plane_ts = readFileSync(new URL("../lib/page-agent/control-plane.ts", import.meta.url), "utf8"); // `sitewake.js` lives here now
const src_lib_capability_center_v2_debug_trace_ts = readFileSync(new URL("../lib/capability-center-v2/debug-trace.ts", import.meta.url), "utf8"); // `event.message` lives here now
const src_lib_site_knowledge_authoring_workspace_ts = readFileSync(new URL("../lib/site-knowledge/authoring-workspace.ts", import.meta.url), "utf8"); // `capability.ts` lives here now
const src_db_site_agent_store_ts = readFileSync(new URL("../db/site-agent-store.ts", import.meta.url), "utf8"); // `网站知识编译` lives here now
import test from "node:test";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** The widget's copy catalog, both languages. The copy moved here; the components reference keys. */
const widgetCopySource = readFileSync(new URL("../client/user-agent-copy.ts", import.meta.url), "utf8");

/** The overview cards' copy. The copy moved here; the components reference keys. */
const overviewCopySource = readFileSync(new URL("../lib/console/overview-copy.ts", import.meta.url), "utf8");

/** `data-preset` lives in client/user-agent-styles.ts now. */
const source_client_user_agent_styles_ts = readFileSync(new URL("../client/user-agent-styles.ts", import.meta.url), "utf8");

/** `cap-v1-stage-trace` lives in app/globals.css now. */
const source_app_globals_css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

/** The console's Chinese copy. Labels moved here; components reference keys. */
const consoleCopyZh = await readFile(new URL("../lib/i18n/zh.ts", import.meta.url), "utf8");
/** The duplicate-check prompt, where the contract wording lives now. */
const duplicateCheckPrompt = await readFile(new URL("../lib/capability-center-v2/prompts/duplicate-check.ts", import.meta.url), "utf8");
/** The conversation renderer, which took over the item-kind filter. */
const conversationSource = await readFile(new URL("../client/user-agent-conversation.ts", import.meta.url), "utf8");
import { Miniflare } from "miniflare";

let isolatedDatabaseSequence = 0;

async function isolatedD1Database() {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `site-agent-test-${isolatedDatabaseSequence += 1}` },
  });
  return {
    database: await miniflare.getD1Database("DB"),
    dispose: () => miniflare.dispose(),
  };
}

async function bundledModule(entry, options = {}) {
  const databaseKey = options.database ? `__SITEWAKE_TEST_D1_${isolatedDatabaseSequence += 1}` : undefined;
  if (databaseKey) globalThis[databaseKey] = options.database;
  try {
    const result = await build({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      plugins: databaseKey ? [{
        name: "isolated-d1-binding",
        setup(builder) {
          builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
            contents: `
              const database = globalThis[${JSON.stringify(databaseKey)}] || null;
              export function getD1Binding() { return database; }
              export function getArtifactBinding() { return null; }
              export class D1UnavailableError extends Error {}
            `,
            loader: "ts",
          }));
        },
      }] : [],
    });
    return await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  } finally {
    if (databaseKey) delete globalThis[databaseKey];
  }
}

const now = "2026-07-15T00:00:00.000Z";

/**
 * A capability reaches a Release only with an implementation: canonicalization
 * drops one that has neither a module nor a plan backed by an authored
 * Operation. A Revision-owned module is the smallest honest stand-in for a
 * fixture that only cares that the capability exists.
 */
const FIXTURE_MODULE = { contentHash: "a".repeat(64), moduleUrl: "/module.mjs", exportName: "capability" };

/**
 * The console is assembled from a component plus extracted view modules, so
 * copy/behaviour assertions read them as one unit. Add new console files here
 * rather than repointing individual assertions.
 */
const CONSOLE_SOURCE_FILES = [
  "../components/site-agent-console.tsx",
  "../components/console/shell-states.tsx",
  "../components/console/topology-graph.tsx",
  "../components/console/site-model.tsx",
  "../components/console/settings.tsx",
  "../components/console/living-overview.tsx",
  "../components/console/session-history.tsx",
];

async function consoleSources() {
  const parts = await Promise.all(
    CONSOLE_SOURCE_FILES.map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );
  return parts.join("\n");
}

test("cross-origin AI stages are accepted by the SiteAgent API", async () => {
  const source = await readFile(new URL("../app/api/site-agents/http.ts", import.meta.url), "utf8");
  assert.match(source, /access-control-allow-headers[^\n]+x-sitewake-ai-stage/);
});

test("MODEL_* is canonical, OPENAI_* is the read-only alias, and no product-prefixed model name is read", async () => {
  const names = [
    "MODEL_API_KEY", "MODEL_BASE_URL", "MODEL", "MODEL_EXECUTION", "MODEL_SEMANTIC",
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
    "SITEWAKE_MODEL_API_KEY", "SITEWAKE_MODEL_BASE_URL", "SITEWAKE_MODEL",
  ];
  const previous = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  for (const key of names) delete process.env[key];
  Object.assign(process.env, {
    OPENAI_API_KEY: "alias-key", OPENAI_BASE_URL: "https://alias.example/v1", OPENAI_MODEL: "alias-model",
    MODEL_API_KEY: "canonical-key", MODEL_BASE_URL: "https://canonical.example/v1", MODEL: "canonical-model",
    MODEL_EXECUTION: "canonical-execution",
  });
  const config = await bundledModule("../lib/model-config.ts");
  assert.equal(config.getModelConfig("general").apiKey, "canonical-key");
  assert.equal(config.getModelConfig("general").baseUrl, "https://canonical.example/v1");
  assert.equal(config.getModelConfig("general").model, "canonical-model");
  assert.equal(config.getModelConfig("execution").model, "canonical-execution");
  assert.equal(config.getModelConfig("semantic").model, "canonical-model");
  assert.equal(config.getModelConfig("general").source, "model");
  for (const key of ["MODEL_API_KEY", "MODEL_BASE_URL", "MODEL", "MODEL_EXECUTION"]) delete process.env[key];
  assert.equal(config.getModelConfig("general").apiKey, "alias-key");
  assert.equal(config.getModelConfig("execution").model, "alias-model");
  assert.equal(config.getModelConfig("general").source, "openai");
  for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"]) delete process.env[key];
  // A product-prefixed spelling is not a model variable, current brand included.
  Object.assign(process.env, { SITEWAKE_MODEL_API_KEY: "k", SITEWAKE_MODEL_BASE_URL: "https://x.example/v1", SITEWAKE_MODEL: "m" });
  assert.equal(config.getModelConfig("general").configured, false);
  assert.equal(config.getModelConfig("general").source, "missing");
  // The source reads exactly this set of names and nothing else, so no earlier
  // product prefix can be silently honoured.
  const source = await readFile(new URL("../lib/model-config.ts", import.meta.url), "utf8");
  const read = new Set([...source.matchAll(/(?:value|firstValue)\(([^)]*)\)/g)].flatMap(([, args]) => [...args.matchAll(/"([A-Z0-9_]+)"/g)].map(([, name]) => name)));
  assert.deepEqual([...read].sort(), [
    // The proxy address and the internal token carry the product name, but
    // neither is a model name: workers that must never hold the provider key
    // are pointed at the control plane's own chat-completions endpoint, which
    // substitutes the real model. The rule below is the one that matters.
    "CAPABILITY_V2_DISPATCH_TOKEN",
    "CAPABILITY_V2_INTEGRATION_MODEL_API_KEY", "CAPABILITY_V2_INTEGRATION_MODEL_BASE_URL", "CAPABILITY_V2_INTEGRATION_MODEL_NAME",
    "MODEL", "MODEL_API_KEY", "MODEL_BASE_URL", "MODEL_EXECUTION", "MODEL_SEMANTIC",
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
    "SITEWAKE_MODEL_PROXY_URL", "SITEWAKE_TEST_SUITE",
  ]);
  assert.deepEqual(
    [...read].filter((name) => /^SITEWAKE_MODEL(?:_API_KEY|_BASE_URL)?$/.test(name)),
    [],
    "a product-prefixed model name must never be read, however the brand is spelled",
  );
  assert.equal(config.modelChatCompletionsUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions");
  assert.equal(config.modelChatCompletionsUrl("https://ark.cn-beijing.volces.com/api/coding/v3"), "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions");
  assert.equal(config.modelChatCompletionsUrl("https://api.deepseek.com"), "https://api.deepseek.com/v1/chat/completions");
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function snapshot(url, heading = "Atlas Market") {
  return { id: `snapshot-${url}`, sessionId: "browser-1", documentId: "document-1", sequence: 0, url, title: heading, heading, visibleText: heading, links: [], capturedAt: now };
}

function candidate(protocol, from, to) {
  const verifier = { success: [{ kind: "url", value: "/search" }], noResult: [], businessRejection: [] };
  const program = { version: 2, steps: [{ id: "step-wait", op: "waitForCondition", urlPattern: "/search", timeoutMs: 8_000 }] };
  const operation = {
    id: "operation-search", name: "搜索商品", fromSceneId: from.id, toSceneId: to.id,
    inputs: { type: "object", properties: { query: { type: "string" } } }, outputs: { type: "object", properties: {} },
    preconditions: [], effects: [`scene:${to.id}`],
    implementations: [{ id: "implementation-search", program, authored: { kind: "page-program", program, proof: { version: 1, iterationId: "iteration-1", author: "ai-program-author", rationale: "使用参数化搜索入口", alternativeIds: ["direct"], verifier, groundedTargetIds: [], createdAt: now } }, conditions: [], successes: 1, failures: 0, sourceEpisodeIds: [] }],
    verification: { sceneId: to.id }, status: "verified", updatedAt: now,
  };
  const capability = {
    id: "capability-search", kind: "task", exposure: "public", name: "搜索商品", description: "搜索商品", normalizedGoal: protocol.normalizeGoal("搜索商品"), aliases: ["查找商品"],
    inputs: operation.inputs, outputs: operation.outputs,
    outcomes: [{ id: "outcome-success", status: "success", code: "success", description: "搜索完成", classifiers: [] }],
    plans: [{ id: "plan-search", entrySceneIds: [from.id], steps: [{ operationId: operation.id, bindings: {} }], outputBindings: {} }],
    sourceEpisodeIds: [], confidence: 0.7, status: "learning", updatedAt: now,
  };
  return { id: "candidate-search", siteAgentId: "atlas", normalizedGoal: capability.normalizedGoal, baseReleaseVersion: 0, scenes: [from, to], targets: [], operations: [operation], capability, validation: { status: "pending", attempts: 0, successfulReplays: 0, requiredReplays: 1 }, authoring: { stage: "authored", reusableTrace: false, selectedImplementationId: "implementation-search", alternatives: [{ id: "direct", kind: "page-program", label: "参数化直接入口", rationale: "最短可靠路径", selected: true }] }, sourceEpisodeIds: [], createdAt: now, updatedAt: now };
}

function session() {
  return { id: "task-1", siteAgentId: "atlas", browserSessionId: "browser-1", goal: "搜索商品", input: { query: "耳机" }, conversation: [], nextStepIndex: 0, bindings: {}, status: "running", createdAt: now, updatedAt: now, expiresAt: "2026-07-16T00:00:00.000Z" };
}

function episode(protocol, mode, outcome) {
  const experience = outcome.status === "success" && (mode === "adaptive" || mode === "demonstration") ? { version: 1, actions: [{ id: "action-1", action: "fill", rawAction: "input_text", input: { value: "耳机" }, page: { url: "https://atlas.test/", title: "Atlas Market", heading: "Atlas Market" }, observedAt: now }], actorSummary: "搜索成功", judgeEvidence: ["搜索结果"] } : undefined;
  const evidence = mode === "adaptive" ? { decisionSource: "user-agent" } : {};
  return { schemaVersion: protocol.SITE_AGENT_SCHEMA_VERSION, id: `episode-${mode}-${outcome.status}`, siteAgentId: "atlas", taskSessionId: "task-1", browserSessionId: "browser-1", documentId: "document-1", mode, goal: "搜索商品", normalizedGoal: protocol.normalizeGoal("搜索商品"), input: { query: "耳机" }, startedAt: now, endedAt: now, releaseId: "atlas:release:0", candidateId: mode === "validation" ? "candidate-search" : undefined, startSnapshot: snapshot("https://atlas.test/"), endSnapshot: snapshot("https://atlas.test/search?q=x", "搜索结果"), transitions: [], outcome: { ...outcome, evaluatedAt: now, evidence }, experience };
}

test("URL templates bind dynamic path, query and hash without creating one Scene per entity", async () => {
  const scene = await bundledModule("../lib/site-knowledge/url-scene.ts");
  const template = scene.urlTemplateFromUrl("https://shop.test/products/123456?q=headphones#reviews");
  assert.equal(template.pathnamePattern, "/products/{path1}");
  const bindings = scene.matchUrlTemplate(template, "https://shop.test/products/987654?q=keyboard#specs");
  assert.deepEqual(bindings, { path1: "987654", q: "keyboard", hash: "specs" });
  const definition = scene.sceneFromSnapshot(snapshot("https://shop.test/products/123456?q=headphones"));
  assert.equal(definition.parameters.find((item) => item.id === "path1").examples[0], "123456");
  assert.match(scene.buildSceneUrl(definition, { path1: "42", q: "phone" }), /\/products\/42\?q=phone/);
  const chineseQuery = scene.buildSceneUrl(definition, { path1: "42", q: "周杰伦" });
  assert.equal(new URL(chineseQuery).searchParams.get("q"), "周杰伦");
  assert.doesNotMatch(chineseQuery, /%25E5/i);
  assert.equal(
    new URL(scene.buildSceneUrl(definition, { path1: "42", q: "phone" }, "http://10.31.0.80:3000")).origin,
    "http://10.31.0.80:3000",
    "runtime navigation keeps learned routes on the live Site Origin",
  );
});

test("first connection clusters child links into Scene references without publishing execution knowledge", async () => {
  const discovery = await bundledModule("../lib/site-knowledge/discovery.ts");
  const page = snapshot("https://demo.test/", "首页");
  page.links = [
    { text: "日榜", url: "https://demo.test/daily" },
    { text: "明星甲", url: "https://demo.test/celebrity/1001" },
    { text: "明星乙", url: "https://demo.test/celebrity/1002" },
    { text: "明星丙", url: "https://demo.test/celebrity/1003" },
  ];
  page.elements = page.links.map((link) => ({ tag: "a", role: "link", accessibleName: link.text, href: link.url, attributes: { href: link.url }, cssPath: `a[href=\"${link.url}\"]` }));
  const knowledge = discovery.discoverInitialKnowledge(page);
  const celebrity = knowledge.scenes.find((scene) => scene.urlTemplates[0].pathnamePattern === "/celebrity/{path1}");
  assert.ok(celebrity);
  assert.equal(celebrity.parameters[0].examples.length, 3);
  assert.equal(knowledge.scenes.filter((scene) => scene.urlTemplates[0].pathnamePattern.startsWith("/celebrity/")).length, 1);
  assert.equal(knowledge.scenes.find((scene) => scene.urlTemplates[0].pathnamePattern === "/")?.lifecycle, "observed");
  assert.equal(celebrity.lifecycle, "referenced");
  assert.equal(knowledge.linkReferences.length, 4);
  assert.equal(knowledge.linkReferences.some((reference) => reference.toSceneId === celebrity.id), true);
  assert.equal(knowledge.operations.length, 0);
  assert.equal(knowledge.targets.length, 0);
  assert.equal(knowledge.capabilities.length, 0);
});

test("a verified header navigation becomes one cross-Scene Operation with a useful return contract", async () => {
  const discovery = await bundledModule("../lib/site-knowledge/discovery.ts");
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const canonical = await bundledModule("../lib/site-knowledge/canonicalize.ts");
  const navigation = await bundledModule("../lib/site-knowledge/navigation-tools.ts");
  const daily = snapshot("https://demo.test/daily", "每日榜单");
  const observed = discovery.discoverInitialKnowledge(daily);
  const home = snapshot("https://demo.test/", "首页");
  home.links = [{ text: "日榜", url: "https://demo.test/daily" }];
  home.elements = [{ tag: "a", role: "link", accessibleName: "日榜", href: "https://demo.test/daily", landmark: "header", attributes: { href: "/daily" }, cssPath: "header a" }];
  const knowledge = discovery.discoverInitialKnowledge(home, observed.scenes);
  assert.equal(knowledge.operations.length, 1);
  assert.equal(knowledge.operations[0].fromSceneId, "*");
  assert.equal(knowledge.operations[0].evidenceSource, "shared-navigation");
  // Discovery stops at the Operation. The reusable tool is compiled from the
  // canonical graph, and the capability shape exists only as the compatibility
  // projection a pre-canonical SDK is handed — which is why discovery itself
  // produces no capability here.
  assert.equal(knowledge.capabilities.length, 0);
  const release = protocol.emptyRelease("demo", now);
  release.scenes = [...observed.scenes, ...knowledge.scenes];
  release.operations = knowledge.operations;
  release.linkReferences = knowledge.linkReferences;
  const compiled = canonical.canonicalizeReleaseKnowledge(release);
  assert.equal(compiled.navigationTools.length, 1, "one destination is one tool, however many pages link to it");
  assert.equal(compiled.navigationTools[0].status, "verified");
  const [tool] = navigation.withTransientNavigationToolCapabilities(compiled)
    .capabilities.filter((item) => item.id.startsWith("navigation-tool:"));
  assert.equal(tool.status, "available");
  assert.deepEqual(Object.keys(tool.outputs.properties), ["pageUrl", "pageTitle", "sceneId"]);
  assert.equal(tool.plans[0].outputBindings.pageUrl.path, "__pageUrl");
  assert.equal(tool.plans[0].outputBindings.sceneId.value, compiled.navigationTools[0].targetSceneId,
    "arriving somewhere has to say where, or the caller cannot tell which page it got");
});

test("navigation intent classification separates conversation, arrival and business results", async () => {
  const navigation = await bundledModule("../lib/site-knowledge/navigation-tools.ts");
  assert.equal(navigation.classifyGoal("你好"), "conversation");
  assert.equal(navigation.classifyGoal("打开词云页面"), "navigation");
  assert.equal(navigation.classifyGoal("回到首页"), "navigation");
  assert.equal(navigation.classifyGoal("搜索周杰伦的历史热搜"), "business");
  assert.equal(navigation.classifyGoal("打开日榜并总结榜单内容"), "business");
  assert.equal(navigation.isNavigationIntentGoal("帮我查看关于我们"), true, "static page wording is still navigation at runtime");
  assert.equal(navigation.isNavigationIntentGoal("帮我查看棕色笔记本的价格"), false, "dynamic business data is not page-arrival navigation");
});

test("the deprecated capability-projects POST delegates to the proposal pipeline", async () => {
  // The goal-string entry point this test used to drive
  // (`createAutonomousCapabilityGoal`) had no route and is gone. What is live is
  // this route, which forwards to the capability centre's proposal service and
  // says so in its headers. Goal classification itself is covered by
  // "navigation intent classification separates conversation, arrival and business results".
  const route = await readFile(new URL("../app/api/site-agents/[siteAgentId]/capability-projects/route.ts", import.meta.url), "utf8");
  assert.match(route, /submitCapabilityProposal/);
  assert.match(route, /result\.queued \? 202 : 200/);
  assert.match(route, /"deprecation": "true"/);
  assert.match(route, /rel=successor-version/);
  assert.doesNotMatch(route, /createAutonomousCapabilityGoal/);
});





test("a near match is recalled as a candidate but is not reuse authority", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const planner = await bundledModule("../lib/site-knowledge/planner.ts");
  const release = protocol.emptyRelease("fuzzy-business-site", now);
  release.capabilities = [{
    id: "capability-order-status",
    kind: "task",
    resultKind: "data",
    exposure: "public",
    name: "查询订单状态",
    description: "查询订单状态并返回业务结果",
    normalizedGoal: protocol.normalizeGoal("查询订单状态"),
    goalTemplate: "查询订单状态",
    aliases: ["订单状态查询"],
    inputs: { type: "object", properties: {} },
    outputs: { type: "object", properties: { status: { type: "string" } } },
    module: FIXTURE_MODULE,
    outcomes: [],
    plans: [],
    sourceEpisodeIds: [],
    confidence: 1,
    status: "available",
    updatedAt: now,
  }];
  const nearMatchGoal = "查询订单状态和物流详情";
  // The existing capability is recalled as a candidate, so this is a near match
  // rather than an unrelated goal. It still clears neither bar that would let a
  // request be answered out of the catalog: the reuse threshold, or owning the
  // wording outright. Anything else has to be designed, and the duplicate
  // verdict belongs to that design pass.
  assert.ok(
    planner.recallCapabilities(release, nearMatchGoal)
      .some((item) => item.capability.id === "capability-order-status" && item.score > 0.12),
    "the existing capability is a near match, not a stranger",
  );
  assert.equal(planner.matchCapability(release, nearMatchGoal), undefined, "a near match is not reuse authority");
  assert.equal(planner.exactCapabilityForGoal(release, nearMatchGoal), undefined);
});

test("the console keeps no second source of truth for capability projects", async () => {
  // The console used to merge a pending project into a possibly stale list
  // (`mergePendingCapabilityProjects`), because creation acknowledged something
  // the next GET did not have yet. Both the function and the entry point that
  // needed it are gone; a project is now written before any response names it.
  const screens = await Promise.all([
    readFile(new URL("../components/capability-center/capability-center-screen.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/capability-center-v2-screen.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(screens.join("\n"), /mergePendingCapabilityProjects/);
});

test("AI contract normalization cannot replace the project identity shown at initialization", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const control = await bundledModule("../lib/site-knowledge/capability-control.ts");
  const now = "2026-07-26T14:00:00.000Z";
  const capability = {
    id: "candidate-capability",
    kind: "task",
    resultKind: "data",
    exposure: "public",
    name: "Search catalog",
    description: "Search the product catalog",
    normalizedGoal: protocol.normalizeGoal("search products"),
    goalTemplate: "search products",
    aliases: [],
    inputs: { type: "object", properties: {} },
    outputs: { type: "object", properties: {} },
    module: FIXTURE_MODULE,
    outcomes: [],
    plans: [],
    sourceEpisodeIds: ["episode"],
    confidence: 0.5,
    status: "learning",
    updatedAt: now,
  };
  const candidate = {
    id: "candidate",
    siteAgentId: "stable-project",
    normalizedGoal: capability.normalizedGoal,
    baseReleaseVersion: 0,
    scenes: [],
    targets: [],
    operations: [],
    capability,
    validation: { status: "pending", attempts: 0, successfulReplays: 0, requiredReplays: 1 },
    authoring: {
      stage: "designed",
      reusableTrace: false,
      intentKey: "normalized_search_catalog",
      goalTemplate: capability.goalTemplate,
      requiredInputs: [],
      resultFields: [],
    },
    sourceEpisodeIds: ["episode"],
    createdAt: now,
    updatedAt: now,
  };
  const job = {
    id: "job",
    siteAgentId: "stable-project",
    taskSessionId: "session",
    sourceEpisodeId: "episode",
    candidateId: candidate.id,
    phase: "author",
    status: "queued",
    attempts: 0,
    intentKey: "normalized_search_catalog",
    goalTemplate: capability.goalTemplate,
    receipts: [],
    result: {
      projectId: "project_first_visible",
      requestedGoal: "Find the products I described",
    },
    createdAt: now,
    updatedAt: now,
  };
  const projection = control.projectCapabilityControl({
    siteAgentId: "stable-project",
    release: protocol.emptyRelease("stable-project", now),
    candidates: [candidate],
    learningJobs: [job],
    validationJobs: [],
    browserRuns: [],
    episodes: [],
  });
  assert.equal(projection.projects[0].id, "project_first_visible");
  assert.equal(projection.projects[0].requestedGoal, "Find the products I described");
  assert.equal(projection.revisions[0].projectId, "project_first_visible");
});

test("one pending goal is one card, however many times it was asked for", async () => {
  const store = await bundledModule("../db/site-agent-store.ts");
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const normalizeGoalForTest = protocol.normalizeGoal;
  const job = (id, at) => ({
    id,
    siteAgentId: "collapse-site",
    taskSessionId: `session-${id}`,
    sourceEpisodeId: `episode-${id}`,
    candidateId: `candidate-${id}`,
    phase: "design",
    status: "queued",
    attempts: 0,
    intentKey: `intent_${id}`,
    goalTemplate: "打开报表页面",
    receipts: [],
    // `requestedGoal` is what the card shows and what it is grouped by: the
    // exact words the request arrived in, kept on the job itself.
    result: { requestedGoal: "打开报表页面" },
    createdAt: at,
    updatedAt: at,
  });
  // Asking twice is one goal. Two cards told the administrator two different
  // things were being built, and the intent key cannot collapse them: it is
  // minted per request, and legacy jobs carry opaque ones.
  const collapsed = store.mergeCapabilityBuildTasks(
    [job("a", "2026-07-15T00:00:00.000Z"), job("b", "2026-07-15T00:01:00.000Z")],
    [],
    new Set(),
  );
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].goal, "打开报表页面");
  assert.equal(collapsed[0].latestLearningJobId, "b", "the newest request is the visible one");

  // A duplicate receipt stays its own row: it is a durable record of that
  // click's verdict, not work in flight.
  const receipt = {
    ...job("c", "2026-07-15T00:02:00.000Z"),
    status: "failed",
    failure: { code: "duplicate_capability", summary: "与现有能力契约相同" },
    result: { requestedGoal: "打开报表页面", duplicateOf: { projectId: "project-1", capabilityId: "capability-1", name: "打开报表页面" } },
  };
  const withReceipt = store.mergeCapabilityBuildTasks(
    [job("a", "2026-07-15T00:00:00.000Z"), receipt],
    [],
    new Set(),
  );
  assert.equal(withReceipt.length, 2);
  assert.equal(withReceipt.filter((task) => task.error?.code === "duplicate_capability").length, 1);

  // A goal a project already owns is not offered as a build card at all.
  assert.deepEqual(
    store.mergeCapabilityBuildTasks([job("a", "2026-07-15T00:00:00.000Z")], [], new Set([normalizeGoalForTest("打开报表页面")])),
    [],
  );
});

test("a published navigation capability is grounded in the Scene the runner actually reached", async () => {
  // This used to slice db/site-agent-store.ts between two functions to prove
  // the goal-string entry point never asked for a demonstration. That entry
  // point is gone, so the claim moves to where it is still decided: the runner
  // publishes from the Scene it ended on, and the console offers no
  // demonstration UI.
  const runner = await readFile(new URL("../runner/browser-runner.ts", import.meta.url), "utf8");
  const center = await readFile(new URL("../components/capability-center-v1.tsx", import.meta.url), "utf8");
  assert.match(runner, /sceneFromSnapshot\(after/);
  assert.match(runner, /module: moduleRef, exposure: "public"/);
  assert.doesNotMatch(center, /演示|用户操作/);
});

test("autonomous navigation rejects a no-op and accepts a proven cart destination", async () => {
  const navigation = await bundledModule("../lib/site-knowledge/navigation-authoring.ts");
  const entry = snapshot("https://atlas.test/", "Atlas Market");
  const noOp = snapshot("https://atlas.test/", "Atlas Market");
  const cart = { ...snapshot("https://atlas.test/cart", "购物车"), visibleText: "购物车 商品清单 结算" };
  const wrong = { ...snapshot("https://atlas.test/furniture", "家具"), visibleText: "家具 沙发 桌子" };
  assert.equal(navigation.navigationTargetEvidence("打开购物车", entry, noOp), undefined);
  assert.equal(navigation.navigationTargetEvidence("打开购物车", entry, wrong), undefined);
  assert.deepEqual(navigation.navigationTargetEvidence("打开购物车", entry, cart), [
    { kind: "url", value: "https://atlas.test/cart" },
    { kind: "text", value: "购物车" },
  ]);
  const verifierCandidate = {
    operations: [{
      implementations: [{
        authored: {
          proof: {
            verifier: { success: [{ kind: "url", value: "https://atlas.test/cart" }] },
          },
        },
      }],
    }],
  };
  assert.equal(
    navigation.navigationCompletionVerified(verifierCandidate, entry, snapshot("https://atlas.test/cartoon", "Cartoon")),
    false,
  );
});

test("AI navigation author generates a same-origin two-stage module from explored evidence", async () => {
  const author = await bundledModule("../runner/navigation-ai-author.ts");
  const source = author.navigationModuleSource("https://atlas.test/demo", "https://atlas.test/demo/cart?from=ai&token=secret#sitewake-launch=secret");
  assert.match(source, /id: "navigate"/);
  assert.match(source, /id: "result"/);
  assert.ok(source.includes('"/demo/cart?from=ai"'));
  assert.doesNotMatch(source, /secret|token|sitewake-launch/);
  assert.match(source, /window\.location\.assign/);
  assert.match(source, /pageUrl: window\.location\.href/);
  assert.equal(
    author.sanitizeNavigationUrl("https://atlas.test/cart?q=desk&session=secret#token=secret", "https://atlas.test"),
    "https://atlas.test/cart?q=desk",
  );
  assert.equal(
    author.sanitizeNavigationUrl("https://atlas.test/cart?q=desk&accessToken=AAA&refreshToken=BBB&idToken=CCC&sessionId=DDD&sessionKey=EEE&apiKey=FFF&authCode=GGG&jwt=HHH&ticket=III&state=JJJ"),
    "https://atlas.test/cart?q=desk",
  );
  assert.equal(
    author.sanitizeNavigationUrl("https://atlas.test/#/cart"),
    "https://atlas.test/#/cart",
  );
  assert.equal(
    author.sanitizeNavigationUrl("https://atlas.test/#sitewake-launch=secret"),
    "https://atlas.test/",
  );
  assert.throws(
    () => author.sanitizeNavigationUrl("https://user:secret@atlas.test/cart"),
    /navigation_url_credentials_forbidden/,
  );
  assert.throws(
    () => author.navigationModuleSource("https://atlas.test/demo", "https://evil.test/cart"),
    /navigation_target_origin_invalid/,
  );
});

test("AI navigation author retries malformed provider JSON and emits metadata-only telemetry", async () => {
  const previous = Object.fromEntries(["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { OPENAI_API_KEY: "must-not-appear", OPENAI_BASE_URL: "https://model.test/v1", OPENAI_MODEL: "test-model" });
  const originalFetch = globalThis.fetch;
  const requests = [];
  const responses = [
    new Response('{"secret":"provider-response-must-not-appear"', { status: 200 }),
    new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"navigate","href":"https://atlas.test/demo/cart","reason":"api_key=reason-must-not-appear"}' } }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }), { status: 200 }),
    new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"done","reason":"user@example.test must-not-appear"}' } }] }), { status: 200 }),
    new Response("<html>upstream prompt echo must-not-appear</html>", { status: 200 }),
    new Response(JSON.stringify({ choices: [{ message: { content: '```json\\n{"satisfied":true,"evidence":"https://private.test/?api_key=evidence-must-not-appear"}\\n```' } }] }), { status: 200 }),
  ];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body || "{}")));
    return responses.shift();
  };
  try {
    const author = await bundledModule("../runner/navigation-ai-author.ts");
    let currentUrl = "https://atlas.test/demo";
    const page = {
      async goto(url) { currentUrl = String(url); },
      async evaluate() {
        const cart = currentUrl.endsWith("/cart");
        return {
          url: currentUrl,
          title: cart ? "Cart" : "Atlas",
          heading: cart ? "Cart" : "Store",
          text: cart ? "Cart items" : "Browse products",
          elements: cart ? [] : [{ index: 0, tag: "a", text: "Cart", href: "https://atlas.test/demo/cart" }],
        };
      },
      mouse: { async wheel() {} },
      async waitForTimeout() {},
    };
    const events = [];
    const result = await author.exploreNavigationWithAI(page, "open cart", "https://atlas.test/demo", 3, (event) => events.push(event));
    assert.equal(result.targetUrl, "https://atlas.test/demo/cart");
    assert.equal(result.semanticEvidence, "semantic-goal-confirmed");
    assert.doesNotMatch(JSON.stringify(result.actions), /reason-must-not-appear|user@example|api_key/i);
    assert.equal(requests.length, 5);
    assert.ok(requests[0].response_format);
    assert.equal(requests[1].response_format, undefined);
    assert.equal(requests[1].thinking, undefined);
    assert.ok(events.some((event) => event.stage === "choose-action" && event.status === "failed" && event.errorCode === "navigation_ai_response_json_invalid"));
    assert.ok(events.some((event) => event.stage === "judge-goal" && event.status === "failed" && event.errorCode === "navigation_ai_response_json_invalid"));
    assert.ok(events.some((event) => event.status === "succeeded" && event.totalTokens === 13));
    assert.doesNotMatch(JSON.stringify(events), /must-not-appear|provider-response|upstream prompt echo|model\\.test/i);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("AI navigation author does not retry a valid negative goal judgment", async () => {
  const previous = Object.fromEntries(["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://model.test/v1", OPENAI_MODEL: "test-model" });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const responses = [
    new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"navigate","href":"https://atlas.test/demo/cart"}' } }] }), { status: 200 }),
    new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"done"}' } }] }), { status: 200 }),
    new Response(JSON.stringify({ choices: [{ message: { content: '{"satisfied":false,"evidence":"not the requested destination"}' } }] }), { status: 200 }),
  ];
  globalThis.fetch = async () => {
    calls += 1;
    return responses.shift();
  };
  try {
    const author = await bundledModule("../runner/navigation-ai-author.ts");
    let currentUrl = "https://atlas.test/demo";
    const page = {
      async goto(url) { currentUrl = String(url); },
      async evaluate() {
        const cart = currentUrl.endsWith("/cart");
        return {
          url: currentUrl,
          title: cart ? "Cart" : "Atlas",
          heading: cart ? "Cart" : "Store",
          text: cart ? "Cart items" : "Browse products",
          elements: cart ? [] : [{ index: 0, tag: "a", text: "Cart", href: "https://atlas.test/demo/cart" }],
        };
      },
      mouse: { async wheel() {} },
      async waitForTimeout() {},
    };
    const events = [];
    await assert.rejects(
      () => author.exploreNavigationWithAI(page, "open cart", "https://atlas.test/demo", 3, (event) => events.push(event)),
      (error) => error instanceof Error && error.message === "navigation_ai_target_not_confirmed",
    );
    assert.equal(calls, 3, "the valid negative judge response must not issue a fallback request");
    assert.equal(events.filter((event) => event.stage === "judge-goal" && event.status === "running").length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("AI navigation author returns a stable redacted error after its bounded JSON retry", async () => {
  const previous = Object.fromEntries(["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { OPENAI_API_KEY: "must-not-appear", OPENAI_BASE_URL: "https://model.test/v1", OPENAI_MODEL: "test-model" });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(`{"sensitive":"raw-${calls}-must-not-appear"`, { status: 200 });
  };
  try {
    const author = await bundledModule("../runner/navigation-ai-author.ts");
    const page = {
      async goto() {},
      async evaluate() {
        return { url: "https://atlas.test/demo", title: "Atlas", heading: "Store", text: "Browse", elements: [] };
      },
      mouse: { async wheel() {} },
      async waitForTimeout() {},
    };
    const events = [];
    await assert.rejects(
      () => author.exploreNavigationWithAI(page, "open cart", "https://atlas.test/demo", 1, (event) => events.push(event)),
      (error) => error instanceof Error && error.message === "navigation_ai_response_json_invalid",
    );
    assert.equal(calls, 2);
    assert.equal(events.filter((event) => event.status === "failed").length, 2);
    assert.doesNotMatch(JSON.stringify(events), /raw-|must-not-appear/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("navigation build task projection expires by clock and collapses normalized retries", async () => {
  const projection = await bundledModule("../lib/site-knowledge/build-tasks.ts");
  const base = {
    siteAgentId: "projection-site",
    input: {},
    mode: "demonstrate",
    executionMode: "run",
    allowedOrigin: "https://projection.test",
    status: "pending",
  };
  const tasks = projection.projectNavigationBuildTasks([{
    ...base,
    id: "launch-old",
    goal: "  打开报表页面 ",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    expiresAt: "2026-07-15T00:10:00.000Z",
    tokenHash: "must-not-leak",
  }, {
    ...base,
    id: "launch-latest",
    goal: "打开报表页面",
    createdAt: "2026-07-15T01:00:00.000Z",
    updatedAt: "2026-07-15T01:00:00.000Z",
    expiresAt: "2026-07-15T01:10:00.000Z",
    resultUrl: "https://projection.test/reports#sitewake-launch=secret",
    token: "must-not-leak",
    claimKey: "must-not-leak",
    claimKeyHash: "must-not-leak",
    launchUrl: "https://projection.test/#sitewake-launch=secret",
  }, {
    ...base,
    id: "business-demonstration",
    projectId: "project-1",
    goal: "打开报表页面",
    createdAt: "2026-07-15T02:00:00.000Z",
    updatedAt: "2026-07-15T02:00:00.000Z",
    expiresAt: "2026-07-15T02:10:00.000Z",
  }], "2026-07-15T01:11:00.000Z");

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].attemptCount, 2);
  assert.equal(tasks[0].latestLaunchId, "launch-latest");
  assert.equal(tasks[0].status, "expired");
  assert.equal(tasks[0].updatedAt, "2026-07-15T01:10:00.000Z");
  assert.equal(tasks[0].result.url, "https://projection.test/reports");
  assert.doesNotMatch(JSON.stringify(tasks), /"(?:token|tokenHash|claimKey|claimKeyHash|launchUrl|allowedOrigin)"|#?sitewake-launch|must-not-leak/i);

  const claimed = projection.projectNavigationBuildTasks([{
    ...base,
    id: "launch-claimed",
    goal: "打开设置页面",
    status: "claimed",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:01:00.000Z",
    expiresAt: "2026-07-15T00:10:00.000Z",
  }], "2026-07-15T00:11:00.000Z");
  assert.equal(claimed[0].status, "claimed", "the expiry is only the unclaimed launch deadline");

  const committedOutOfCreationOrder = projection.projectNavigationBuildTasks([{
    ...base,
    id: "launch-started-later-but-superseded",
    goal: "鎵撳紑璁剧疆椤甸潰",
    status: "cancelled",
    attemptSequence: 20,
    createdAt: "2026-07-15T00:00:00.002Z",
    updatedAt: "2026-07-15T00:00:00.004Z",
    expiresAt: "2026-07-15T00:10:00.002Z",
  }, {
    ...base,
    id: "launch-committed-last-and-active",
    goal: "鎵撳紑璁剧疆椤甸潰",
    status: "pending",
    attemptSequence: 10,
    createdAt: "2026-07-15T00:00:00.001Z",
    updatedAt: "2026-07-15T00:00:00.005Z",
    expiresAt: "2026-07-15T00:10:00.001Z",
  }], "2026-07-15T00:01:00.000Z", new Map([
    ["鎵撳紑璁剧疆椤甸潰", "launch-committed-last-and-active"],
  ]));
  assert.equal(committedOutOfCreationOrder[0].latestLaunchId, "launch-committed-last-and-active");
  assert.equal(committedOutOfCreationOrder[0].status, "pending");

  const completedAfterOutOfOrderCommit = projection.projectNavigationBuildTasks(
    [{
      ...base,
      id: "launch-started-later-but-superseded",
      goal: "鎵撳紑璁剧疆椤甸潰",
      status: "cancelled",
      attemptSequence: 20,
      createdAt: "2026-07-15T00:00:00.002Z",
      updatedAt: "2026-07-15T00:00:00.004Z",
      expiresAt: "2026-07-15T00:10:00.002Z",
    }, {
      ...base,
      id: "launch-committed-last-and-active",
      goal: "鎵撳紑璁剧疆椤甸潰",
      status: "completed",
      attemptSequence: 10,
      createdAt: "2026-07-15T00:00:00.001Z",
      updatedAt: "2026-07-15T00:02:00.000Z",
      expiresAt: "2026-07-15T00:10:00.001Z",
      completedAt: "2026-07-15T00:02:00.000Z",
    }],
    "2026-07-15T00:03:00.000Z",
    new Map([["鎵撳紑璁剧疆椤甸潰", "launch-committed-last-and-active"]]),
  );
  assert.equal(completedAfterOutOfOrderCommit[0].latestLaunchId, "launch-committed-last-and-active");
  assert.equal(completedAfterOutOfOrderCommit[0].status, "completed");

  const source = await readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8");
  assert.match(source, /projectNavigationBuildTasks/);
  assert.match(source, /project_id IS NULL AND capability_id IS NULL[\s\S]*json_extract\(launch_json, '\$\.mode'\)='demonstrate'[\s\S]*ORDER BY created_at DESC LIMIT 200/);
  const route = await readFile(new URL("../app/api/site-agents/[siteAgentId]/capability-projects/route.ts", import.meta.url), "utf8");
  assert.match(route, /buildTasks: result\.buildTasks/);
});

test("available navigation tools satisfy control-plane navigation goals without a demonstration launch", async () => {
  const store = await bundledModule("../db/site-agent-store.ts");
  store.resetMemorySiteAgentStore();
  const entryUrl = "https://navigation-ready.test/app";
  // A handshake no longer creates the site: an external website is enrolled by
  // an administrator, never by connecting. See db/agent-run-store.ts.
  await store.createSiteAgent({ id: "navigation-ready-site" });
  await store.recordSiteAgentConnection("navigation-ready-site", {
    origin: "https://navigation-ready.test",
    url: entryUrl,
    title: "Navigation",
    heading: "Navigation",
    snapshot: snapshot(entryUrl, "Navigation"),
  });
  // Verified Scene knowledge is what a Navigation Tool is compiled from, so the
  // scene is placed in the Release the way a crawl leaves it there. A handshake
  // never carries scenes (see `recordSiteAgentConnection`).
  const memoryAgent = globalThis.__SITEWAKE_SITE_AGENT_V2__.get("navigation-ready-site");
  memoryAgent.release.scenes = [{
    id: "scene-reports",
    name: "报表页面",
    semanticSource: "ai",
    evidenceStatus: "entry-verified",
    lifecycle: "observed",
    identityConfidence: 1,
    evidence: { linkLabels: ["报表"], observedUrls: ["https://navigation-ready.test/reports"], titles: ["报表页面"], headings: ["报表页面"] },
    urlTemplates: [{ id: "url-reports", originPattern: "https://navigation-ready.test", pathnamePattern: "/reports", query: {} }],
    parameters: [],
    verifier: { urlPattern: "/reports" },
    directEntry: "verified",
    sourceObservationIds: ["observation-reports"],
    updatedAt: now,
  }];
  const active = await store.getActiveSiteAgentRelease("navigation-ready-site");
  const tool = active.release.navigationTools.find((item) =>
    active.release.scenes.find((scene) => scene.id === item.targetSceneId)?.urlTemplates[0].pathnamePattern === "/reports");
  assert.ok(tool, "verified Scene knowledge is already a Navigation Tool, with no build request involved");
  assert.equal(tool.status, "verified");

  // No demonstration was ever asked for: the tool came out of crawled Scene
  // knowledge, not out of somebody driving the page. The goal-string entry
  // point that used to be exercised here is gone, and nothing replaced it with
  // a path that creates a launch.
  assert.deepEqual(memoryAgent.taskLaunches, [], "compiling a Navigation Tool creates no demonstration launch");
  assert.equal(
    store.mergeCapabilityBuildTasks([], [], new Set([tool.name])).length,
    0,
    "a destination already covered by a tool is not offered as something to build",
  );
});

test("an exact navigation alias chooses the one tool whose destination owns that wording", async () => {
  const planner = await bundledModule("../lib/site-knowledge/planner.ts");
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const release = protocol.emptyRelease("navigation-alias-site", now);
  const navigationCapability = (id, name, aliases) => ({
    id,
    kind: "navigation",
    resultKind: "page",
    exposure: "public",
    name,
    description: `到达“${name}”`,
    normalizedGoal: protocol.normalizeGoal(name),
    goalTemplate: name,
    aliases,
    inputs: { type: "object", properties: {} },
    outputs: { type: "object", properties: { pageUrl: { type: "string" } } },
    module: FIXTURE_MODULE,
    outcomes: [],
    plans: [],
    sourceEpisodeIds: [],
    confidence: 1,
    status: "available",
    updatedAt: now,
  });

  // One destination owns the wording through an alias, so the request resolves
  // to it without a model.
  release.capabilities = [
    navigationCapability("navigation-cart", "打开商品浏览与购物车", ["打开购物车"]),
    navigationCapability("navigation-products", "打开浏览全部商品", []),
    navigationCapability("navigation-demo", "打开demo详情", []),
  ];
  assert.equal(planner.exactCapabilityForGoal(release, "打开购物车")?.id, "navigation-cart");

  // Two destinations claim the same wording: deterministic reuse refuses rather
  // than picking the first. Guessing here lands a visitor on the wrong page,
  // and the Agent can still read the catalog and ask.
  release.capabilities = [
    navigationCapability("navigation-cart", "打开商品浏览与购物车", ["打开购物车"]),
    navigationCapability("navigation-products", "打开浏览全部商品", ["打开购物车"]),
  ];
  assert.equal(planner.exactCapabilityForGoal(release, "打开购物车"), undefined);

  // An internal asset is knowledge, never terminal invocation authority.
  release.capabilities = [{
    ...navigationCapability("navigation-cart", "打开商品浏览与购物车", ["打开购物车"]),
    exposure: "internal",
  }];
  assert.equal(planner.exactCapabilityForGoal(release, "打开购物车"), undefined);
});

test("capability control holds formal capabilities only, not suggestions or Navigation Tools", async () => {
  const store = await bundledModule("../db/site-agent-store.ts");
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  store.resetMemorySiteAgentStore();
  await store.createSiteAgent({ id: "complete-capability-center" });
  await store.getSiteAgentOverview("complete-capability-center");
  const memoryAgent = globalThis.__SITEWAKE_SITE_AGENT_V2__.get("complete-capability-center");
  memoryAgent.release.capabilities = [{
    id: "capability-release-draft",
    kind: "task",
    resultKind: "data",
    exposure: "internal",
    name: "Draft release capability",
    description: "A release capability that is not published yet",
    normalizedGoal: protocol.normalizeGoal("Draft release capability"),
    goalTemplate: "Draft release capability",
    aliases: [],
    inputs: { type: "object", properties: {} },
    outputs: { type: "object", properties: { result: { type: "string" } } },
    module: FIXTURE_MODULE,
    outcomes: [],
    plans: [],
    sourceEpisodeIds: [],
    confidence: 0.5,
    status: "suggested",
    updatedAt: now,
  }, {
    // A published, formal capability, so the contrast below is real: this one
    // must appear in the catalog while the suggestion and the tools must not.
    id: "capability-published",
    kind: "task",
    resultKind: "data",
    exposure: "public",
    name: "Published capability",
    description: "A published capability an administrator manages",
    normalizedGoal: protocol.normalizeGoal("Published capability"),
    goalTemplate: "Published capability",
    aliases: [],
    inputs: { type: "object", properties: {} },
    outputs: { type: "object", properties: { result: { type: "string" } } },
    module: FIXTURE_MODULE,
    outcomes: [],
    plans: [],
    sourceEpisodeIds: [],
    confidence: 1,
    status: "available",
    updatedAt: now,
  }];
  const navigationTool = (id, status) => ({
    id,
    siteAgentId: "complete-capability-center",
    intentKey: `navigate_${id}`,
    name: `Open ${id}`,
    description: `Navigate to ${id}`,
    aliases: [`Go to ${id}`],
    targetSceneId: `scene-${id}`,
    inputs: { type: "object", properties: {} },
    outputs: { type: "object", properties: { pageUrl: { type: "string" } } },
    applicability: { scope: "any-scene" },
    strategies: [],
    verifier: { sceneId: `scene-${id}` },
    source: { kind: "knowledge-compiled", knowledgeRevision: 1, dependencyHash: `hash-${id}`, evidenceRefs: [] },
    status,
    usedByCapabilityIds: [],
    updatedAt: now,
  });
  memoryAgent.release.navigationTools = [
    navigationTool("verified", "verified"),
    navigationTool("candidate", "candidate"),
    navigationTool("degraded", "degraded"),
  ];
  await store.reconcileCapabilityControl("complete-capability-center");
  const listed = await store.listCapabilityProjects("complete-capability-center");
  const published = listed.projects.find((project) => project.activeCapabilityId === "capability-published");
  assert.ok(published, "a published capability is what the catalog is for");
  const detail = await store.getCapabilityProjectDetail("complete-capability-center", published.id);
  assert.equal(detail.detail.project.id, published.id);
  // A `suggested` capability is a discovery hint, not a build: importing it as
  // a root makes the console report `building` with no job behind it.
  assert.equal(listed.projects.some((project) => project.activeCapabilityId === "capability-release-draft"), false,
    "a discovery suggestion is not presented as a live build");
  // A Navigation Tool is compiled knowledge, not something an administrator
  // manages: the catalog keeps formal capabilities only (`isFormalCapability`)
  // and the runtime reads the tools straight off the Release.
  for (const tool of memoryAgent.release.navigationTools) {
    assert.equal(listed.projects.some((project) => project.activeCapabilityId === `navigation-tool:${tool.id}`), false,
      `Navigation Tool ${tool.id} must not appear as a capability project`);
  }
  assert.equal(memoryAgent.release.navigationTools.length, 3, "the tools stay on the Release for the runtime to use");
});

test("capability projection exposes one logical Navigation Tool and lets a managed capability win the same intent", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const projection = await bundledModule("../lib/site-knowledge/capability-projection.ts");
  const release = protocol.emptyRelease("navigation-projection", now);
  const schema = { type: "object", properties: {} };
  const pageOutputs = { type: "object", properties: { pageUrl: { type: "string" } } };
  const capability = (id, name, origin = "knowledge-compiled") => ({
    id,
    kind: "navigation",
    resultKind: "page",
    exposure: id === "capability-open-cart" ? "public" : "internal",
    name,
    description: name,
    normalizedGoal: protocol.normalizeGoal(name),
    goalTemplate: name,
    aliases: [],
    inputs: schema,
    outputs: pageOutputs,
    module: FIXTURE_MODULE,
    outcomes: [],
    plans: [],
    sourceEpisodeIds: [],
    confidence: 1,
    status: "available",
    origin,
    updatedAt: now,
  });
  const navigationTool = (id, name) => ({
    id,
    siteAgentId: "navigation-projection",
    intentKey: `navigate_${id}`,
    name,
    description: name,
    aliases: [name],
    targetSceneId: `scene-${id}`,
    inputs: schema,
    outputs: pageOutputs,
    applicability: { scope: "any-scene" },
    strategies: [],
    verifier: { sceneId: `scene-${id}` },
    source: { kind: "knowledge-compiled", knowledgeRevision: 1, dependencyHash: `hash-${id}`, evidenceRefs: [] },
    status: "verified",
    usedByCapabilityIds: [],
    updatedAt: now,
  });
  release.capabilities = [
    capability("capability-open-cart", "打开购物车", "administrator"),
    capability("capability_shared_nav_cart", "打开购物车"),
    capability("navigation-tool:navigation_cart", "打开购物车"),
    capability("capability_shared_nav_search", "搜索商品"),
    capability("navigation-tool:navigation_search", "搜索商品"),
  ];
  release.navigationTools = [
    navigationTool("navigation_cart", "打开购物车"),
    navigationTool("navigation_search", "搜索商品"),
  ];
  const sameNameBusiness = {
    ...projection.canonicalReleaseCapabilityProject("navigation-projection", capability("capability-business-search", "搜索商品", "administrator")),
    id: "project-building-business-search",
    intentKey: "building_business_search",
    kind: "task",
    status: "building",
    stage: "design",
    activeCapabilityId: undefined,
  };
  const sameNameBuildingNavigation = {
    ...sameNameBusiness,
    id: "project-building-navigation-search",
    intentKey: "building_navigation_search",
    kind: "navigation",
  };

  const projected = projection.withCanonicalReleaseProjects("navigation-projection", release, {
    projects: [sameNameBusiness, sameNameBuildingNavigation],
    revisions: [],
    events: [],
  });
  assert.deepEqual(
    projected.projects.flatMap((project) => project.activeCapabilityId ? [project.activeCapabilityId] : []).sort(),
    ["capability-open-cart", "navigation-tool:navigation_search"],
  );
  assert.equal(projected.projects.some((project) => project.id === sameNameBusiness.id), true, "a Business Capability with the same words remains in its own model category");
  assert.equal(projected.projects.some((project) => project.id === sameNameBuildingNavigation.id), true, "an unfinished managed navigation project does not hide a verified Navigation Tool");
  const search = projected.projects.find((project) => project.activeCapabilityId === "navigation-tool:navigation_search");
  assert.equal(search.origin, "knowledge-compiled");
  assert.equal(search.triggeredBy, "system");
  assert.equal(search.generatedBy, "program");
  assert.equal(projected.projects.some((project) => project.activeCapabilityId?.startsWith("capability_shared_nav_")), false);

  const legacyRelease = protocol.emptyRelease("legacy-navigation-projection", now);
  legacyRelease.capabilities = [capability("capability_shared_nav_legacy", "打开旧版帮助中心")];
  const legacyProjected = projection.withCanonicalReleaseProjects("legacy-navigation-projection", legacyRelease, {
    projects: [],
    revisions: [],
    events: [],
  });
  assert.equal(legacyProjected.projects[0].activeCapabilityId, "capability_shared_nav_legacy", "legacy Releases without first-class tools keep one compatibility projection");
});

test("reconciling reclassifies a technical Navigation wrapper and its empty receipt out of the catalog", async () => {
  const store = await bundledModule("../db/site-agent-store.ts");
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  store.resetMemorySiteAgentStore();
  await store.createSiteAgent({ id: "navigation-projection-refresh" });
  await store.getSiteAgentOverview("navigation-projection-refresh");
  const memoryAgent = globalThis.__SITEWAKE_SITE_AGENT_V2__.get("navigation-projection-refresh");
  const staleTarget = {
    id: "project-stale-shared-nav",
    siteAgentId: "navigation-projection-refresh",
    intentKey: "capability_capability_shared_nav_cart",
    name: "打开购物车",
    description: "打开购物车",
    goalTemplate: "打开购物车",
    requestedGoal: "打开购物车",
    origin: "ai-exploration",
    triggeredBy: "system",
    generatedBy: "ai",
    status: "available",
    stage: "publish",
    kind: "navigation",
    exposure: "internal",
    resultKind: "page",
    activeCapabilityId: "capability_shared_nav_cart",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { pageUrl: { type: "string" } } },
    executionRequirements: { authentication: "unknown", supportedEnvironments: { connectedBrowser: "supported", cloudBrowser: "unverified", managedProfile: "blocked" }, checkpoints: [], evidenceRefs: [] },
    health: { recentRuns: 0, recentSuccesses: 0 },
    revisionCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const duplicateReceipt = {
    ...staleTarget,
    id: "project-duplicate-receipt",
    intentKey: "duplicate_receipt_project-duplicate-receipt",
    activeCapabilityId: undefined,
    status: "duplicate",
    duplicateOf: { projectId: staleTarget.id, capabilityId: staleTarget.activeCapabilityId, name: staleTarget.name, kind: "navigation" },
  };
  memoryAgent.capabilityProjects = [staleTarget, duplicateReceipt];
  memoryAgent.release.capabilities = [{
    id: "capability_shared_nav_cart",
    kind: "navigation",
    resultKind: "page",
    exposure: "internal",
    name: "打开购物车",
    description: "打开购物车",
    normalizedGoal: protocol.normalizeGoal("打开购物车"),
    goalTemplate: "打开购物车",
    aliases: [],
    inputs: staleTarget.inputSchema,
    outputs: staleTarget.outputSchema,
    module: FIXTURE_MODULE,
    outcomes: [],
    plans: [],
    sourceEpisodeIds: [],
    confidence: 1,
    status: "available",
    origin: "knowledge-compiled",
    updatedAt: now,
  }];
  memoryAgent.release.navigationTools = [{
    id: "navigation_cart",
    siteAgentId: "navigation-projection-refresh",
    intentKey: "navigate_cart",
    name: "打开购物车",
    description: "打开购物车",
    aliases: [],
    targetSceneId: "scene-cart",
    inputs: staleTarget.inputSchema,
    outputs: staleTarget.outputSchema,
    applicability: { scope: "any-scene" },
    strategies: [],
    verifier: { sceneId: "scene-cart" },
    source: { kind: "knowledge-compiled", knowledgeRevision: 1, dependencyHash: "hash-cart", evidenceRefs: [] },
    status: "verified",
    usedByCapabilityIds: [],
    updatedAt: now,
  }];

  // Removing a superseded row is a one-time catalog reclassification, not
  // something a read performs: listing reports what is stored, and reconciling
  // is what rewrites the catalog.
  const beforeReconcile = await store.listCapabilityProjects("navigation-projection-refresh");
  assert.equal(beforeReconcile.projects.some((project) => project.id === staleTarget.id), true, "a read reports what is stored");

  await store.reconcileCapabilityControl("navigation-projection-refresh");
  const listed = await store.listCapabilityProjects("navigation-projection-refresh");
  assert.equal(listed.projects.some((project) => project.id === staleTarget.id), false,
    "a technical wrapper around a shared-navigation adapter is not a Capability");
  // An empty duplicate receipt is reclassified with it. It is not lost: the
  // capability centre carries that verdict as a proposal row with its
  // `duplicateCapabilityId` (tests/capability-center-four-table.test.mjs), and
  // the reclassification itself is recorded as a migration event.
  assert.equal(listed.projects.some((project) => project.id === duplicateReceipt.id), false);
  const storeSource = await readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8");
  assert.match(storeSource, /sole identity-removal path[\s\S]*DELETE FROM site_agent_v2_capability_projects/,
    "there is exactly one path that removes a project identity");
  assert.match(storeSource, /title: "技术包装已移出能力目录"/, "the removal leaves an auditable event behind");
});

test("the D1 catalog migration removes a technical Navigation identity and records why", async (t) => {
  const isolated = await isolatedD1Database();
  t.after(isolated.dispose);
  const siteAgentId = "d1-navigation-projection";
  const canonical = await bundledModule("../lib/site-knowledge/canonicalize.ts");
  const projection = await bundledModule("../lib/site-knowledge/capability-projection.ts");
  const knowledge = await bundledModule("../lib/site-knowledge/site-knowledge.ts");
  const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
  await store.createSiteAgent({
    id: siteAgentId,
    name: "D1 Navigation Projection",
    url: "https://d1-navigation.test/",
  });
  const releaseRow = await isolated.database.prepare(`
    SELECT r.id, r.release_json AS releaseJson
      FROM site_agent_v2_agents a
      JOIN site_agent_v2_releases r ON r.id=a.active_release_id
     WHERE a.id=? LIMIT 1
  `).bind(siteAgentId).first();
  const release = JSON.parse(releaseRow.releaseJson);
  release.scenes = [{
    id: "scene-cart",
    name: "Cart",
    description: "Shopping cart",
    semanticSource: "program",
    businessArea: "shopping",
    evidenceStatus: "entry-verified",
    lifecycle: "observed",
    identityConfidence: 1,
    evidence: {
      linkLabels: ["Cart"],
      observedUrls: ["https://d1-navigation.test/cart"],
      titles: ["Cart"],
      headings: ["Cart"],
    },
    urlTemplates: [{
      id: "url-cart",
      originPattern: "https://d1-navigation.test",
      pathnamePattern: "/cart",
      query: {},
    }],
    parameters: [],
    verifier: { urlPattern: "/cart" },
    directEntry: "verified",
    sourceObservationIds: ["observation-cart"],
    updatedAt: now,
  }];
  release.operations = [];
  release.capabilities = [];
  release.navigationTools = [];
  const canonicalRelease = canonical.canonicalizeReleaseKnowledge(release);
  const tool = canonicalRelease.navigationTools[0];
  assert.ok(tool);
  assert.equal(tool.status, "verified");
  const canonicalProject = projection.withCanonicalReleaseProjects(siteAgentId, canonicalRelease, {
    projects: [],
    revisions: [],
    events: [],
  }).projects.find((project) => project.activeCapabilityId === `navigation-tool:${tool.id}`);
  assert.ok(canonicalProject);
  const staleProject = {
    ...canonicalProject,
    id: "project-stale-d1-shared-nav",
    // A historical projection may use the canonical Intent but an obsolete
    // project id. PostgreSQL must delete it before writing the replacement.
    intentKey: canonicalProject.intentKey,
    activeCapabilityId: "capability_shared_nav_cart",
    origin: "ai-exploration",
    generatedBy: "ai",
  };
  const duplicateReceipt = {
    ...staleProject,
    id: "project-d1-duplicate-receipt",
    intentKey: "duplicate_receipt_project-d1-duplicate-receipt",
    activeCapabilityId: undefined,
    status: "duplicate",
    duplicateOf: {
      projectId: staleProject.id,
      capabilityId: staleProject.activeCapabilityId,
      name: staleProject.name,
      kind: "navigation",
    },
  };
  const projectInsert = (project) => isolated.database.prepare(`
    INSERT OR REPLACE INTO site_agent_v2_capability_projects
      (id,site_agent_id,intent_key,status,project_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)
  `).bind(
    project.id,
    project.siteAgentId,
    project.intentKey,
    project.status,
    JSON.stringify(project),
    project.createdAt,
    project.updatedAt,
  );
  const seeded = await isolated.database.batch([
    isolated.database.prepare("UPDATE site_agent_v2_releases SET release_json=? WHERE id=?")
      .bind(JSON.stringify(release), releaseRow.id),
    projectInsert(staleProject),
    projectInsert(duplicateReceipt),
    isolated.database.prepare("INSERT OR REPLACE INTO site_agent_v2_meta (key,value,updated_at) VALUES (?,?,?)")
      .bind(`capability_projection_epoch:${siteAgentId}`, "legacy-projection", now),
    isolated.database.prepare("INSERT OR REPLACE INTO site_agent_v2_meta (key,value,updated_at) VALUES (?,?,?)")
      .bind(`executable_asset_epoch:${siteAgentId}`, "sitewake-runtime-v1", now),
  ]);
  assert.equal(seeded.every((result) => result.success), true);

  // Reconciling runs the one-time catalog reclassification. A technical
  // navigation wrapper is not a Capability an administrator manages, so its
  // row leaves the catalog — together with the empty duplicate receipt that
  // pointed at it — and the removal is recorded as an auditable event.
  await store.reconcileCapabilityControl(siteAgentId);
  const listed = await store.listCapabilityProjects(siteAgentId);
  assert.equal(listed.persistence, "d1");
  assert.deepEqual(listed.projects.map((project) => project.id), []);

  const storedRows = await isolated.database.prepare(`
    SELECT project_json AS projectJson
      FROM site_agent_v2_capability_projects
     WHERE site_agent_id=?
  `).bind(siteAgentId).all();
  assert.deepEqual(storedRows.results, [], "the rows are gone from storage, not just from the projection");

  const eventRows = await isolated.database.prepare(`
    SELECT event_json AS eventJson
      FROM site_agent_v2_capability_events
     WHERE site_agent_id=? AND type='migration'
  `).bind(siteAgentId).all();
  const events = eventRows.results.map((row) => JSON.parse(row.eventJson));
  assert.equal(events.length >= 1, true, "a removed identity leaves a migration event behind");
  assert.ok(events.every((event) => event.actor === "release-gate" && event.status === "passed"));

  // The knowledge itself is untouched: the Navigation Tool stays on the Release
  // for the runtime, which is the only consumer that needs it.
  const activeAfterMigration = await store.getActiveSiteAgentRelease(siteAgentId);
  assert.equal(activeAfterMigration.release.navigationTools.length >= 1, true);
  assert.equal(
    knowledge.userInvocableCapabilities(activeAfterMigration.release).some((item) => item.id.startsWith("navigation-tool:")),
    false,
    "a reclassified adapter is knowledge, never a tool a visitor may invoke",
  );
});

test("verified Scene knowledge compiles into one replaceable Navigation Tool", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const canonical = await bundledModule("../lib/site-knowledge/canonicalize.ts");
  const navigation = await bundledModule("../lib/site-knowledge/navigation-tools.ts");
  const release = protocol.emptyRelease("generic", now);
  release.version = 7;
  release.scenes = [{
    id: "scene-daily", name: "历史日榜", description: "按日期访问历史日榜", semanticSource: "ai", businessArea: "日榜",
    evidenceStatus: "entry-verified", lifecycle: "observed", identityConfidence: .95,
    evidence: { linkLabels: ["每日热搜归档"], observedUrls: ["https://generic.test/daily/2025-04-24"], titles: ["日榜"], headings: ["日榜"] },
    urlTemplates: [{ id: "url-daily", originPattern: "https://generic.test", pathnamePattern: "/daily/{date}", query: {} }],
    parameters: [{ id: "date", name: "日期", type: "string", required: true, examples: ["2025-04-24"] }],
    verifier: { urlPattern: "/daily/" }, directEntry: "verified", sourceObservationIds: ["observation-1"], updatedAt: now,
  }, {
    id: "scene-unvisited", name: "未访问页面", semanticSource: "program", evidenceStatus: "referenced", lifecycle: "referenced", identityConfidence: .4,
    evidence: { linkLabels: ["未访问"], observedUrls: [], titles: [], headings: [] },
    urlTemplates: [{ id: "url-unvisited", originPattern: "https://generic.test", pathnamePattern: "/unvisited", query: {} }],
    parameters: [], verifier: {}, directEntry: "candidate", sourceObservationIds: [], updatedAt: now,
  }];
  release.capabilities = [{
    id: "navigation-tool:stale", kind: "navigation", resultKind: "page", exposure: "internal", name: "旧工具", description: "旧工具", normalizedGoal: "旧工具", goalTemplate: "旧工具", aliases: [],
    inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} }, outcomes: [], plans: [], sourceEpisodeIds: [], confidence: 1, status: "available", updatedAt: now,
  }];
  const result = canonical.canonicalizeReleaseKnowledge(release);
  assert.equal(result.navigationTools.length, 1);
  const dailyTool = result.navigationTools.find((tool) => result.scenes.find((scene) => scene.id === tool.targetSceneId)?.urlTemplates[0].pathnamePattern.startsWith("/daily/"));
  assert.ok(dailyTool);
  assert.equal(dailyTool.inputs.properties.date.examples[0], "2025-04-24");
  assert.equal(dailyTool.source.kind, "ai-reviewed");
  assert.equal(dailyTool.strategies[0].kind, "direct-entry");
  assert.equal(result.capabilities.some((item) => item.id === "navigation-tool:stale"), false);
  // The canonical Release stores Navigation Tools, not navigation capabilities:
  // one stored shape per fact. The capability form is produced on the way out,
  // for an SDK that predates tools.
  assert.equal(result.capabilities.some((item) => item.id.startsWith("navigation-tool:")), false);
  assert.equal(
    navigation.withTransientNavigationToolCapabilities(result)
      .capabilities.filter((item) => item.id.startsWith("navigation-tool:")).length,
    1,
  );
  assert.equal(result.navigationTools.some((item) => item.targetSceneId === "scene-unvisited"), false);
  const repeated = canonical.canonicalizeReleaseKnowledge(result);
  assert.equal(repeated.navigationTools.length, 1);
  assert.equal(repeated.navigationTools[0].strategies.length, result.navigationTools[0].strategies.length);
  assert.equal(repeated.operations.filter((item) => item.id.startsWith("operation_navigation_direct_")).length, 1);
});

test("local pagination stays inside its parameterized Scene until cross-Scene evidence proves shared navigation", async () => {
  const discovery = await bundledModule("../lib/site-knowledge/discovery.ts");
  const page = snapshot("https://demo.test/daily/2026-07-17", "今日日榜");
  page.links = [{ text: "前一个有数据日期 2026-07-16", url: "https://demo.test/daily/2026-07-16" }];
  page.elements = [{ tag: "a", role: "link", accessibleName: page.links[0].text, href: page.links[0].url, landmark: "nav", attributes: { href: "/daily/2026-07-16" }, cssPath: "main nav a" }];
  const knowledge = discovery.discoverInitialKnowledge(page);
  assert.equal(knowledge.operations.length, 0, "a local nav landmark is not automatically site-wide");
  // The previous/next edge is kept as contextual graph evidence — a date family
  // really does link between two instances of itself — but it is a self-edge,
  // and promotion to a reusable Operation still needs cross-Scene evidence.
  assert.equal(knowledge.linkReferences.length, 1);
  assert.equal(knowledge.linkReferences[0].fromSceneId, knowledge.linkReferences[0].toSceneId,
    "a date change stays inside its own parameterized Scene");
});

test("two static sibling routes remain distinct until there is enough family evidence", async () => {
  const discovery = await bundledModule("../lib/site-knowledge/discovery.ts");
  const page = snapshot("https://docs.test/", "文档");
  page.links = [
    { text: "关于", url: "https://docs.test/guides/about" },
    { text: "常见问题", url: "https://docs.test/guides/faq" },
  ];
  const knowledge = discovery.discoverInitialKnowledge(page);
  assert.equal(knowledge.scenes.filter((scene) => scene.urlTemplates[0].pathnamePattern.startsWith("/guides/")).length, 2);
  assert.equal(knowledge.scenes.some((scene) => scene.urlTemplates[0].pathnamePattern === "/guides/{path1}"), false);
});

test("repeated query links do not merge cart, search, and about into one route parameter", async () => {
  const discovery = await bundledModule("../lib/site-knowledge/discovery.ts");
  const canonical = await bundledModule("../lib/site-knowledge/canonicalize.ts");
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const page = snapshot("https://shop.test/demo", "Store");
  page.links = [
    { text: "Desks", url: "https://shop.test/demo/search?category=desks" },
    { text: "Furniture", url: "https://shop.test/demo/search?category=furniture" },
    { text: "Travel", url: "https://shop.test/demo/search?category=travel" },
    { text: "Cart", url: "https://shop.test/demo/cart" },
    { text: "About", url: "https://shop.test/demo/about" },
  ];
  const discovered = discovery.discoverInitialKnowledge(page);
  const release = protocol.emptyRelease("shop", now);
  release.scenes = discovered.scenes;
  const normalized = canonical.canonicalizeReleaseKnowledge(release);
  const paths = normalized.scenes.map((scene) => scene.urlTemplates[0].pathnamePattern);
  assert.ok(paths.includes("/demo/search"));
  assert.ok(paths.includes("/demo/cart"));
  assert.ok(paths.includes("/demo/about"));
  assert.equal(paths.includes("/demo/{path1}"), false);
  const search = normalized.scenes.find((scene) => scene.urlTemplates[0].pathnamePattern === "/demo/search");
  assert.equal(search.urlTemplates[0].query.category, "{category?}");
});

test("referenced-only slug links fold into an existing parameterized family (BLACKPINK/Lisa → /celebrity/{path1})", async () => {
  const canonical = await bundledModule("../lib/site-knowledge/canonicalize.ts");
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const release = protocol.emptyRelease("weibo", now);
  release.scenes = [{
    id: "scene-family", name: "微博热搜记录", description: "明星热搜记录", semanticSource: "ai", businessArea: "明星热度",
    evidenceStatus: "entry-verified", lifecycle: "observed", identityConfidence: .95,
    evidence: { linkLabels: ["明星"], observedUrls: ["https://weibo.test/celebrity/x"], titles: [], headings: [] },
    urlTemplates: [{ id: "url-family", originPattern: "https://weibo.test", pathnamePattern: "/celebrity/{path1}", query: {} }],
    parameters: [{ id: "path1", name: "明星姓名", type: "string", required: true, examples: ["王一博", "迪丽热巴"] }],
    verifier: {}, directEntry: "verified", sourceObservationIds: ["obs-1"], updatedAt: now,
  }, {
    id: "scene-blackpink", name: "BLACKPINK", semanticSource: "program", evidenceStatus: "referenced", lifecycle: "referenced", identityConfidence: .4,
    evidence: { linkLabels: ["BLACKPINK"], observedUrls: [], titles: [], headings: [] },
    urlTemplates: [{ id: "url-bp", originPattern: "https://weibo.test", pathnamePattern: "/celebrity/BLACKPINK", query: {} }],
    parameters: [], verifier: {}, directEntry: "candidate", sourceObservationIds: [], updatedAt: now,
  }, {
    id: "scene-lisa", name: "明星热搜记录详情页", semanticSource: "program", evidenceStatus: "referenced", lifecycle: "referenced", identityConfidence: .4,
    evidence: { linkLabels: ["Lisa"], observedUrls: [], titles: [], headings: [] },
    urlTemplates: [{ id: "url-lisa", originPattern: "https://weibo.test", pathnamePattern: "/celebrity/Lisa", query: {} }],
    parameters: [], verifier: {}, directEntry: "candidate", sourceObservationIds: [], updatedAt: now,
  }];
  const result = canonical.canonicalizeReleaseKnowledge(release);
  const celeb = result.scenes.filter((scene) => scene.urlTemplates[0].pathnamePattern.startsWith("/celebrity/"));
  assert.equal(celeb.length, 1, "referenced BLACKPINK + Lisa fold into the one /celebrity/{path1} family");
  assert.equal(celeb[0].urlTemplates[0].pathnamePattern, "/celebrity/{path1}");
  assert.equal(celeb[0].evidenceStatus, "entry-verified", "family keeps its verified status");
  assert.equal(celeb[0].directEntry, "verified");
  const examples = celeb[0].parameters[0].examples;
  assert.ok(examples.includes("BLACKPINK") && examples.includes("Lisa"), "folded slugs become examples of the family");
});

test("common link-label templates do not turn static sibling pages into entity routes", async () => {
  const discovery = await bundledModule("../lib/site-knowledge/discovery.ts");
  for (const siblings of [
    [["Login page", "login"], ["Signup page", "signup"]],
    [["Edit page", "edit"], ["Create page", "create"]],
    [["Privacy page", "privacy"], ["Terms page", "terms"]],
  ]) {
    const page = snapshot("https://shop.test/account", "Account");
    page.links = siblings.map(([text, slug]) => ({ text, url: `https://shop.test/account/${slug}` }));
    const discovered = discovery.discoverInitialKnowledge(page);
    const paths = discovered.scenes.map((scene) => scene.urlTemplates[0].pathnamePattern);
    assert.equal(paths.includes("/account/{path1}"), false);
    for (const [, slug] of siblings) assert.ok(paths.includes(`/account/${slug}`));
  }
});

test("concrete numeric entity IDs still canonicalize into one parameterized route", async () => {
  const canonical = await bundledModule("../lib/site-knowledge/canonicalize.ts");
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const release = protocol.emptyRelease("shop", now);
  release.scenes = ["1001", "1002", "1003"].map((id) => ({
    id: `product-${id}`,
    name: `Product ${id}`,
    urlTemplates: [{ id: `url-${id}`, originPattern: "https://shop.test", pathnamePattern: `/products/${id}`, query: {} }],
    parameters: [],
    verifier: {},
    directEntry: "candidate",
    sourceObservationIds: [],
    updatedAt: now,
  }));
  const normalized = canonical.canonicalizeReleaseKnowledge(release);
  assert.equal(normalized.scenes.length, 1);
  assert.equal(normalized.scenes[0].urlTemplates[0].pathnamePattern, "/products/{path1}");
  assert.deepEqual(normalized.scenes[0].parameters[0].examples.sort(), ["1001", "1002", "1003"]);
});

test("a dynamic detail template does not absorb reserved static sibling routes", async () => {
  const canonical = await bundledModule("../lib/site-knowledge/canonicalize.ts");
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  for (const [placeholder, reserved] of [["userId", "settings"], ["id", "new"], ["slug", "search"]]) {
    const release = protocol.emptyRelease("shop", now);
    release.scenes = [
      {
        id: `dynamic-${placeholder}`,
        name: "Dynamic detail",
        urlTemplates: [{ id: `url-dynamic-${placeholder}`, originPattern: "https://shop.test", pathnamePattern: `/users/{${placeholder}}`, query: {} }],
        parameters: [{ id: placeholder, name: placeholder, type: "string", required: true, examples: ["1001"] }],
        verifier: {},
        directEntry: "verified",
        sourceObservationIds: [],
        updatedAt: now,
      },
      {
        id: `reserved-${reserved}`,
        name: reserved,
        urlTemplates: [{ id: `url-${reserved}`, originPattern: "https://shop.test", pathnamePattern: `/users/${reserved}`, query: {} }],
        parameters: [],
        verifier: {},
        directEntry: "verified",
        sourceObservationIds: [],
        updatedAt: now,
      },
    ];
    const normalized = canonical.canonicalizeReleaseKnowledge(release);
    const paths = normalized.scenes.map((scene) => scene.urlTemplates[0].pathnamePattern);
    assert.equal(normalized.scenes.length, 2);
    assert.ok(paths.includes(`/users/${reserved}`));
    assert.ok(paths.some((path) => /^\u002fusers\u002f\{[^}]+\}$/.test(path)));
  }
});

test("a dynamic entity position does not generalize static edit and view suffixes", async () => {
  const canonical = await bundledModule("../lib/site-knowledge/canonicalize.ts");
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const release = protocol.emptyRelease("shop", now);
  const makeScene = (id, path, parameters = []) => ({
    id,
    name: id,
    urlTemplates: [{ id: `url-${id}`, originPattern: "https://shop.test", pathnamePattern: path, query: {} }],
    parameters,
    verifier: {},
    directEntry: "candidate",
    sourceObservationIds: [],
    updatedAt: now,
  });
  release.scenes = [
    makeScene("product-edit", "/products/{productId}/edit", [{ id: "productId", name: "Product ID", type: "string", required: true, examples: ["1001"] }]),
    makeScene("product-view-1001", "/products/1001/view"),
    makeScene("product-view-1002", "/products/1002/view"),
  ];
  const normalized = canonical.canonicalizeReleaseKnowledge(release);
  const paths = normalized.scenes.map((scene) => scene.urlTemplates[0].pathnamePattern).sort();
  assert.deepEqual(paths, ["/products/{path1}/edit", "/products/{path1}/view"]);
  assert.equal(paths.some((path) => path.endsWith("/{path2}")), false);
});

test("business topology projects one primary parent per Scene and folds noisy relationships", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const topologyModule = await bundledModule("../lib/site-knowledge/business-topology.ts");
  const release = protocol.emptyRelease("generic", now);
  const scene = (id, name, path, lifecycle = "observed", businessArea) => ({
    id, name, businessArea, semanticSource: businessArea ? "ai" : "program", lifecycle,
    identityConfidence: 0.8, evidence: { linkLabels: [], observedUrls: lifecycle === "referenced" ? [] : [`https://generic.test${path}`], titles: [name], headings: [name] },
    urlTemplates: [{ id: `url-${id}`, originPattern: "https://generic.test", pathnamePattern: path, query: {} }],
    parameters: [], verifier: {}, directEntry: "candidate", sourceObservationIds: [], updatedAt: now,
  });
  release.scenes = [
    scene("home", "首页", "/", "observed", "网站入口"),
    scene("catalog", "商品目录", "/catalog", "semantic-reviewed", "商品浏览"),
    scene("detail", "商品详情", "/catalog/{path1}", "observed", "商品浏览"),
    scene("about", "关于我们", "/about", "referenced"),
  ];
  release.linkReferences = [
    { id: "l1", fromSceneId: "home", toSceneId: "catalog", label: "商品", href: "/catalog", landmark: "nav", observations: 10, firstSeenAt: now, lastSeenAt: now },
    { id: "l2", fromSceneId: "home", toSceneId: "about", label: "关于", href: "/about", landmark: "footer", observations: 10, firstSeenAt: now, lastSeenAt: now },
    { id: "l3", fromSceneId: "catalog", toSceneId: "about", label: "关于", href: "/about", landmark: "footer", observations: 8, firstSeenAt: now, lastSeenAt: now },
    { id: "l4", fromSceneId: "detail", toSceneId: "about", label: "关于", href: "/about", landmark: "footer", observations: 6, firstSeenAt: now, lastSeenAt: now },
    { id: "l5", fromSceneId: "home", toSceneId: "detail", label: "推荐商品", href: "/catalog/featured", landmark: "main", observations: 2, firstSeenAt: now, lastSeenAt: now },
  ];
  release.operations = [{
    id: "open-detail", name: "查看商品详情", kind: "business-transition", evidenceSource: "observed-transition",
    fromSceneId: "catalog", toSceneId: "detail", inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} },
    preconditions: [], effects: ["scene:detail"], implementations: [{ id: "impl", program: { version: 2, steps: [] }, conditions: [], successes: 3, failures: 0, sourceEpisodeIds: [] }],
    verification: { sceneId: "detail" }, status: "verified", updatedAt: now,
  }];
  const topology = topologyModule.buildBusinessTopology(release);
  assert.equal(topology.primaryEdges.length, release.scenes.length);
  assert.equal(new Set(topology.primaryEdges.map((edge) => edge.to)).size, release.scenes.length);
  assert.equal(topology.primaryEdges.find((edge) => edge.to === "detail")?.from, "catalog");
  assert.equal(topology.primaryEdges.find((edge) => edge.to === "detail")?.kind, "business-flow");
  assert.equal(topology.primaryEdges.find((edge) => edge.to === "about")?.from, "site-root");
  assert.equal(topology.secondaryEdges.length > 0, true);
  assert.equal(topology.stats.hiddenEdges, topology.secondaryEdges.length);
  assert.equal(topology.areas.some((area) => area.name === "商品浏览" && area.nodeIds.length === 2), true);
});

test("AI semantics never turn a link-only Scene into an observed page", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const topologyModule = await bundledModule("../lib/site-knowledge/business-topology.ts");
  const release = protocol.emptyRelease("generic", now);
  release.scenes = [{
    id: "help", name: "帮助中心", description: "产品帮助", semanticSource: "ai", businessArea: "支持与治理",
    evidenceStatus: "referenced", lifecycle: "referenced", identityConfidence: 0.7,
    semanticReview: { status: "reviewed", evidenceHash: "evidence", model: "semantic-model", attemptedAt: now, reviewedAt: now },
    evidence: { linkLabels: ["帮助"], observedUrls: [], titles: [], headings: [] },
    urlTemplates: [{ id: "url-help", originPattern: "https://generic.test", pathnamePattern: "/help", query: {} }],
    parameters: [], verifier: {}, directEntry: "candidate", sourceObservationIds: [], updatedAt: now,
  }];
  const topology = topologyModule.buildBusinessTopology(release);
  assert.equal(topology.nodes[0].semanticSource, "ai");
  assert.equal(topology.nodes[0].evidenceStatus, "referenced");
  assert.equal(topology.stats.observedScenes, 0);
  assert.equal(topology.stats.reviewedScenes, 1);
});

test("site knowledge review is evidence-versioned instead of becoming permanently frozen after first AI pass", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const analyzer = await bundledModule("../lib/site-knowledge/model-analyzer.ts");
  const page = snapshot("https://product.test/", "Product - Official Site");
  page.metadata = { applicationName: "Product", ogSiteName: "Product", description: "A useful product" };
  const release = protocol.emptyRelease("product", now);
  const firstHash = analyzer.siteProfileEvidenceHash(page, []);
  release.profile.semanticReview = { status: "reviewed", evidenceHash: firstHash, attemptedAt: now, reviewedAt: now };
  assert.equal(analyzer.siteProfileNeedsSemanticReview(release.profile, firstHash), false);
  page.metadata.description = "A more complete product description";
  const changedHash = analyzer.siteProfileEvidenceHash(page, []);
  assert.notEqual(firstHash, changedHash);
  assert.equal(analyzer.siteProfileNeedsSemanticReview(release.profile, changedHash), true);
});

test("link-only Scene candidates wait for page evidence instead of pretending an AI review is queued", async () => {
  const analyzer = await bundledModule("../lib/site-knowledge/model-analyzer.ts");
  const scene = {
    id: "topic-reference", name: "词条详情", semanticSource: "program", evidenceStatus: "referenced", lifecycle: "referenced", identityConfidence: 0.5,
    evidence: { linkLabels: ["词条"], observedUrls: [], titles: [], headings: [] },
    urlTemplates: [{ id: "url-topic", originPattern: "https://product.test", pathnamePattern: "/topic", query: {} }],
    parameters: [], verifier: {}, directEntry: "candidate", sourceObservationIds: [], updatedAt: now,
  };
  assert.equal(analyzer.sceneNeedsSemanticReview(scene), false);
  scene.evidenceStatus = "observed"; scene.lifecycle = "observed"; scene.evidence.observedUrls = ["https://product.test/topic"];
  assert.equal(analyzer.sceneNeedsSemanticReview(scene), true);
});

test("website knowledge projects typed task inputs and only a relevant graph neighborhood to the Agent", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const knowledge = await bundledModule("../lib/site-knowledge/site-knowledge.ts");
  const release = protocol.emptyRelease("search", now);
  release.profile.suggestedGoals = ["legacy suggestion"];
  release.capabilities = [{
    id: "cap-search", kind: "task", exposure: "public", name: "查询历史记录", description: "查询指定词", normalizedGoal: "查询历史记录",
    goalTemplate: "查询 {keyword} 的历史记录", aliases: [],
    inputs: { type: "object", properties: { keyword: { type: "string", description: "关键词" } }, required: ["keyword"] },
    outputs: { type: "object", properties: {} }, outcomes: [], plans: [], sourceEpisodeIds: [], confidence: 0.86, status: "available", updatedAt: now,
  }];
  release.scenes = ["home", "search", "unrelated"].map((id) => ({ id, name: id, urlTemplates: [{ id: `url-${id}`, originPattern: "https://search.test", pathnamePattern: `/${id}`, query: {} }], parameters: [], verifier: {}, directEntry: "verified", sourceObservationIds: [], updatedAt: now }));
  release.operations = [{ id: "open-search", name: "打开搜索", fromSceneId: "home", toSceneId: "search", inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} }, preconditions: [], effects: ["scene:search"], implementations: [], verification: {}, status: "verified", updatedAt: now }];
  assert.equal(knowledge.profileTaskTemplates(release)[0].requiredInputs[0].prompt, "请提供关键词");
  const context = knowledge.buildSiteKnowledgeContext(release, "home");
  assert.deepEqual(context.nearbyScenes.map((scene) => scene.id).sort(), ["home", "search"]);
  assert.equal(context.taskTemplates[0].requiredInputs[0].id, "keyword");
});

test("suggested tasks derive only from explicitly public user-invocable capabilities", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const knowledge = await bundledModule("../lib/site-knowledge/site-knowledge.ts");
  const capability = (id, overrides = {}) => ({
    id, kind: "task", exposure: "public", name: `任务 ${id}`, description: `完成 ${id}`, normalizedGoal: id, aliases: [],
    goalTemplate: `执行 {query} ${id}`,
    inputs: { type: "object", properties: { query: { type: "string", description: "产品关键词" } }, required: ["query"] },
    outputs: { type: "object", properties: {} }, outcomes: [], plans: [], sourceEpisodeIds: [], confidence: 0.9, status: "available", updatedAt: now,
    ...overrides,
  });
  const tasks = knowledge.deriveCapabilityTaskTemplates([
    capability("search", { name: "查找产品" }),
    capability("duplicate", { name: "查找产品" }),
    capability("legacy-public", { exposure: undefined }),
    capability("improving", { status: "improving", inputs: { type: "object", properties: { query: { type: "string", description: "产品关键词" } } } }),
    capability("learning", { status: "learning" }),
    capability("private", { exposure: "internal" }),
    capability("navigation", { kind: "navigation", exposure: "public" }),
  ]);
  assert.deepEqual(tasks.map((task) => task.name), ["查找产品", "任务 improving", "任务 navigation"]);
  assert.equal(tasks[0].goalTemplate, "执行 {query} search");
  assert.deepEqual(tasks[0].requiredInputs, [{ id: "query", name: "产品关键词", type: "string", prompt: "请提供产品关键词" }]);
  assert.deepEqual(tasks[1].requiredInputs.map((input) => input.id), ["query"], "legacy schemas without required treat every property as required");
  assert.equal(knowledge.deriveCapabilityTaskTemplates(Array.from({ length: 10 }, (_, index) => capability(`unbounded-${index}`))).length, 10);

  const release = protocol.emptyRelease("suggested-navigation", now);
  const publicCart = capability("public-cart", {
    kind: "navigation",
    name: "openCart",
    goalTemplate: "openCart",
    aliases: [],
    inputs: { type: "object", properties: {} },
    plans: [{ id: "plan-public-cart", entrySceneIds: ["*"], steps: [{ operationId: "operation-cart", bindings: {} }], outputBindings: {} }],
  });
  const compiledCart = capability("navigation-tool:cart", {
    kind: "navigation",
    exposure: "public",
    origin: "knowledge-compiled",
    name: "打开购物车",
    goalTemplate: "打开购物车",
    aliases: ["查看购物车"],
    inputs: { type: "object", properties: {} },
  });
  const compiledSearch = capability("navigation-tool:search", {
    kind: "navigation",
    exposure: "internal",
    origin: "knowledge-compiled",
    name: "打开商品搜索结果",
    goalTemplate: "打开商品搜索结果",
    aliases: ["进入商品搜索结果"],
    inputs: { type: "object", properties: {} },
  });
  const sharedSearch = capability("capability_shared_nav_search", {
    kind: "navigation",
    exposure: "public",
    origin: "knowledge-compiled",
    name: "打开商品搜索结果",
    goalTemplate: "打开商品搜索结果",
    inputs: { type: "object", properties: {} },
  });
  const orphanShared = capability("capability_shared_nav_internal_orphan", {
    kind: "navigation",
    exposure: "internal",
    origin: "knowledge-compiled",
    name: "打开内部旧入口",
    goalTemplate: "打开内部旧入口",
    inputs: { type: "object", properties: {} },
  });
  const internalBusiness = capability("internal-business", {
    exposure: "internal",
    name: "内部诊断",
  });
  const navigationTool = (id, name, aliases) => ({
    id,
    siteAgentId: "suggested-navigation",
    intentKey: `navigate_${id}`,
    name,
    description: name,
    aliases,
    targetSceneId: `scene-${id}`,
    inputs: { type: "object", properties: {} },
    outputs: { type: "object", properties: {} },
    applicability: { scope: "any-scene" },
    strategies: [{ kind: "direct-entry", operationId: `operation-${id}`, urlTemplateId: `url-${id}` }],
    verifier: { sceneId: `scene-${id}` },
    source: { kind: "knowledge-compiled", knowledgeRevision: 1, dependencyHash: `hash-${id}`, evidenceRefs: [] },
    status: "verified",
    usedByCapabilityIds: [],
    updatedAt: now,
  });
  release.capabilities = [publicCart, compiledCart, sharedSearch, compiledSearch, orphanShared, internalBusiness];
  release.navigationTools = [
    navigationTool("cart", "打开购物车", ["进入购物车"]),
    navigationTool("search", "打开商品搜索结果", ["进入商品搜索结果"]),
  ];
  assert.deepEqual(
    knowledge.userInvocableCapabilities(release).map((item) => item.id),
    ["public-cart"],
    "an internal verified Navigation Tool remains hidden from terminal users",
  );
  assert.deepEqual(
    knowledge.profileTaskTemplates(release).map((task) => task.name),
    ["openCart"],
  );
  // Publishing the compiled adapter changes nothing: a Navigation Tool is
  // knowledge the Agent may use to operate the page, never a tool a visitor can
  // invoke by name. The exposure flag cannot promote it, because the exclusion
  // is by id (`isTechnicalCapabilityAdapterId`) rather than by exposure.
  compiledSearch.exposure = "public";
  assert.deepEqual(
    knowledge.userInvocableCapabilities(release).map((item) => item.id),
    ["public-cart"],
    "a compiled navigation adapter is never terminal invocation authority",
  );
  assert.deepEqual(
    knowledge.profileTaskTemplates(release).map((task) => task.name),
    ["openCart"],
  );
});

test("canonicalization preserves explicit exposure independently from capability kind", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const canonicalize = await bundledModule("../lib/site-knowledge/canonicalize.ts");
  const knowledge = await bundledModule("../lib/site-knowledge/site-knowledge.ts");
  const navigation = await bundledModule("../lib/site-knowledge/navigation-tools.ts");
  const release = protocol.emptyRelease("navigation-exposure", now);
  release.scenes = [{
    id: "scene-cart", name: "购物车", urlTemplates: [{ id: "url-cart", originPattern: "https://shop.test", pathnamePattern: "/cart", query: {} }],
    parameters: [], verifier: {}, directEntry: "verified", evidenceStatus: "entry-verified", sourceObservationIds: [], updatedAt: now,
  }];
  release.operations = [{
    id: "operation-open-cart", name: "打开购物车", kind: "navigation", evidenceSource: "ai-authored",
    fromSceneId: "*", toSceneId: "scene-cart", inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} },
    preconditions: [], effects: ["scene:scene-cart"],
    implementations: [{ id: "implementation-open-cart", program: { version: 2, steps: [] }, conditions: [], successes: 1, failures: 0, sourceEpisodeIds: [] }],
    verification: { sceneId: "scene-cart" }, status: "published", updatedAt: now,
  }];
  const authored = {
    id: "capability_open_cart", kind: "navigation", exposure: "internal", name: "打开购物车", description: "进入购物车",
    normalizedGoal: protocol.normalizeGoal("打开购物车"), goalTemplate: "打开购物车", aliases: [],
    inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} },
    outcomes: [], plans: [{ id: "plan-open-cart", entrySceneIds: ["*"], steps: [{ operationId: "operation-open-cart", bindings: {} }], outputBindings: {} }],
    sourceEpisodeIds: [], confidence: 0.9, status: "available", updatedAt: now,
  };
  const publicAuthored = { ...authored, id: "capability_open_cart_public", exposure: "public", name: "前往购物车", goalTemplate: "前往购物车", normalizedGoal: protocol.normalizeGoal("前往购物车") };
  release.capabilities = [authored, publicAuthored];
  const canonical = canonicalize.canonicalizeReleaseKnowledge(release);
  assert.equal(canonical.capabilities.find((item) => item.id === authored.id)?.exposure, "internal");
  assert.equal(canonical.capabilities.find((item) => item.id === publicAuthored.id)?.exposure, "public");
  assert.ok(canonical.profile.suggestedGoals.includes("前往购物车"));
  assert.ok(!canonical.profile.suggestedGoals.includes("打开购物车"));
  // A compiled Navigation Tool is not a capability on the canonical Release at
  // all: it lives in `navigationTools`, and the capability shape exists only as
  // the compatibility projection for a pre-canonical SDK. There is therefore no
  // adapter exposure for an administrator to flip, and nothing to publish.
  assert.equal(canonical.capabilities.some((item) => item.id.startsWith("navigation-tool:")), false);
  assert.equal(canonical.navigationTools.length, 1);
  assert.deepEqual(
    knowledge.userInvocableCapabilities(canonical).map((item) => item.id),
    [publicAuthored.id],
    "exposure decides what a visitor may invoke, and only formal capabilities have it",
  );
  const projected = navigation.withTransientNavigationToolCapabilities(canonical);
  assert.equal(projected.capabilities.filter((item) => item.id.startsWith("navigation-tool:")).length, 1);
  assert.equal(
    projected.capabilities.find((item) => item.id.startsWith("navigation-tool:")).exposure,
    "internal",
    "the projected adapter is internal whatever the tool was compiled from",
  );
});

test("knowledge graph merges duplicate route identities and concrete operations into semantic edges", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const view = await bundledModule("../lib/site-knowledge/knowledge-view.ts");
  const release = protocol.emptyRelease("demo", now);
  const base = { urlTemplates: [{ id: "url-1", originPattern: "https://demo.test", pathnamePattern: "/search", query: {} }], parameters: [], verifier: {}, directEntry: "candidate", sourceObservationIds: ["obs-1"], updatedAt: now };
  release.scenes = [{ ...base, id: "search-a", name: "search详情" }, { ...base, id: "search-b", name: "历史热搜查询", sourceObservationIds: ["obs-2"] }, { ...base, id: "home", name: "首页", urlTemplates: [{ ...base.urlTemplates[0], id: "home-url", pathnamePattern: "/" }] }];
  release.operations = ["A", "B"].map((name, index) => ({ id: `operation-${index}`, name: `打开${name}`, fromSceneId: "home", toSceneId: index ? "search-b" : "search-a", inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} }, preconditions: [], effects: [], implementations: [{ id: `implementation-${index}`, program: { version: 2, steps: [] }, conditions: [], successes: 0, failures: 0, sourceEpisodeIds: [] }], verification: {}, status: "candidate", updatedAt: now }));
  const graph = view.buildKnowledgeGraph(release);
  assert.equal(graph.scenes.length, 2);
  assert.equal(graph.scenes.find((scene) => scene.path === "/search").name, "历史热搜查询");
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].implementationCount, 2);
});

test("release canonicalization collapses legacy query Scenes and remaps every graph reference", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const canonical = await bundledModule("../lib/site-knowledge/canonicalize.ts");
  const release = protocol.emptyRelease("demo", now);
  const template = { id: "url-search", originPattern: "https://demo.test", pathnamePattern: "/search", query: {} };
  release.scenes = [
    { id: "search-empty", name: "search详情", urlTemplates: [template], parameters: [], verifier: {}, directEntry: "candidate", sourceObservationIds: ["obs-1"], updatedAt: now },
    { id: "search-query", name: "历史热搜查询", description: "查询历史热搜", urlTemplates: [{ ...template, id: "url-search-q", query: { q: "{q?}" } }], parameters: [{ id: "q", name: "关键词", type: "string", required: false, examples: ["航天"] }], verifier: {}, directEntry: "verified", sourceObservationIds: ["obs-2"], updatedAt: now },
  ];
  release.targets = [{ id: "target-search", name: "搜索", sceneIds: ["search-empty", "search-query"], accessibleNames: ["搜索"], attributes: {}, locatorVariants: [], updatedAt: now }];
  release.operations = [{ id: "operation-search", name: "搜索", kind: "business-transition", evidenceSource: "observed-transition", fromSceneId: "search-empty", toSceneId: "search-query", inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} }, preconditions: [], effects: [], implementations: [], verification: { sceneId: "search-query", targetIds: ["target-search"] }, status: "candidate", updatedAt: now }];
  release.capabilities = [{ id: "cap-search", name: "搜索", description: "搜索", normalizedGoal: "搜索", aliases: [], inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} }, outcomes: [], plans: [{ id: "plan-search", entrySceneIds: ["search-empty", "search-query"], steps: [], outputBindings: {} }], sourceEpisodeIds: [], confidence: 0.7, status: "available", updatedAt: now }];
  const result = canonical.canonicalizeReleaseKnowledge(release);
  assert.equal(result.scenes.length, 1);
  assert.equal(result.scenes[0].name, "历史热搜查询");
  assert.equal(result.scenes[0].directEntry, "verified");
  assert.equal(result.targets[0].sceneIds.length, 1);
  assert.equal(result.operations[0].fromSceneId, result.scenes[0].id);
  assert.equal(result.operations[0].toSceneId, result.scenes[0].id);
  assert.equal(result.capabilities.length, 0, "legacy business capabilities without AI Authoring Proof are retired");
});

test("browser execution authority comes from allowed Origins instead of AI profile metadata", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const canonical = await bundledModule("../lib/site-knowledge/canonicalize.ts");
  const release = protocol.emptyRelease("trusted-origin", now);
  release.profile = { ...release.profile, entryUrl: "https://www.example.test/", allowedOrigins: ["https://demo.example.test"] };
  release.scenes = [{ id: "home", name: "首页", urlTemplates: [{ id: "home-url", originPattern: "https://demo.example.test", pathnamePattern: "/", query: {} }], parameters: [], verifier: {}, directEntry: "verified", sourceObservationIds: [], updatedAt: now }];
  const result = canonical.canonicalizeReleaseKnowledge(release);
  assert.equal(result.profile.entryUrl, "https://demo.example.test/");
  const runner = await readFile(new URL("../runner/browser-runner.ts", import.meta.url), "utf8");
  assert.match(runner, /trustedReleaseStartUrl/);
  assert.doesNotMatch(runner, /startUrl: lease\.release\.profile\.entryUrl \|\|/);
});

test("canonicalization remaps program Scene IDs, removes parameterless dynamic navigation, and deduplicates semantic actions", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const canonical = await bundledModule("../lib/site-knowledge/canonicalize.ts");
  const release = protocol.emptyRelease("demo", now);
  const makeScene = (id, name, path, parameters = []) => ({ id, name, urlTemplates: [{ id: `url-${id}`, originPattern: "https://demo.test", pathnamePattern: path, query: {} }], parameters, verifier: {}, directEntry: "verified", sourceObservationIds: [], updatedAt: now });
  release.scenes = [
    makeScene("daily-concrete", "前一个有数据日期 2026-07-16", "/daily/2026-07-16"),
    makeScene("daily-family", "日榜详情", "/daily/{path1}", [{ id: "path1", name: "日期", type: "string", required: true, examples: ["2026-07-16"] }]),
    makeScene("city-a", "地区热搜榜", "/city"),
    makeScene("city-b", "国家与地区", "/city"),
  ];
  const nav = (id, to, name) => ({ id, name, kind: "navigation", evidenceSource: "shared-navigation", applicability: { scope: "any-scene", evidenceSceneIds: ["city-a"] }, fromSceneId: "*", toSceneId: to, inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} }, preconditions: [], effects: [`scene:${to}`], implementations: [{ id: `impl-${id}`, program: { version: 2, steps: [{ id: `step-${id}`, op: "navigate", sceneId: to, bindings: {}, timeoutMs: 1000 }] }, conditions: [], successes: 1, failures: 0, sourceEpisodeIds: [] }], verification: { sceneId: to }, status: "verified", updatedAt: now });
  release.operations = [nav("date-nav", "daily-concrete", "前往前一个有数据日期 2026-07-16"), nav("city-nav-a", "city-a", "前往地区热搜榜"), nav("city-nav-b", "city-b", "前往地区热搜榜")];
  release.operations[1].implementations[0].program.steps[0].sceneId = "retired-city-scene";
  release.operations[1].implementations[0].program.steps[0].transition = { kind: "document", expectedSceneIds: ["retired-city-proof"], expectedOrigin: "https://demo.test" };
  release.operations[1].implementations[0].authored = {
    kind: "page-program",
    program: release.operations[1].implementations[0].program,
    proof: { version: 1, iterationId: "iteration-city", author: "ai-program-author", rationale: "verified route", alternativeIds: [], verifier: { success: [{ kind: "scene", value: "retired-city-proof" }], noResult: [], businessRejection: [] }, groundedTargetIds: [], createdAt: now },
  };
  const result = canonical.canonicalizeReleaseKnowledge(release);
  const cityOperations = result.operations.filter((operation) => operation.name === "前往地区热搜榜");
  assert.equal(cityOperations.length, 1);
  assert.equal(cityOperations[0].implementations[0].program.steps[0].sceneId, cityOperations[0].toSceneId);
  assert.deepEqual(cityOperations[0].implementations[0].program.steps[0].transition.expectedSceneIds, [cityOperations[0].toSceneId]);
  assert.equal(cityOperations[0].implementations[0].authored.proof.verifier.success[0].value, cityOperations[0].toSceneId);
  assert.equal(result.operations.some((operation) => operation.id === "date-nav"), false);
});

test("canonicalization preserves authored query-state navigation within one Scene", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const canonical = await bundledModule("../lib/site-knowledge/canonicalize.ts");
  const release = protocol.emptyRelease("query-state", now);
  release.scenes = [{
    id: "search",
    name: "商品列表",
    urlTemplates: [{ id: "search-url", originPattern: "https://demo.test", pathnamePattern: "/search", query: { sort: "{sort?}" } }],
    parameters: [{ id: "sort", name: "排序", type: "string", required: false, examples: ["price-low"] }],
    verifier: {},
    directEntry: "verified",
    sourceObservationIds: [],
    updatedAt: now,
  }];
  const operation = (id, name, url) => ({
    id,
    name,
    kind: "navigation",
    evidenceSource: "ai-authored",
    applicability: { scope: "scene-set", sceneIds: ["search"], evidenceSceneIds: ["search"] },
    fromSceneId: "search",
    toSceneId: "search",
    inputs: { type: "object", properties: {}, required: [] },
    outputs: { type: "object", properties: {} },
    preconditions: ["scene:search"],
    effects: ["scene:search"],
    implementations: [{
      id: `implementation-${id}`,
      program: { version: 2, steps: [] },
      authored: {
        kind: "module",
        module: { contentHash: `hash-${id}`, moduleUrl: `/programs/${id}.js`, exportName: "capability" },
        proof: {
          version: 1,
          iterationId: `iteration-${id}`,
          author: "ai-program-author",
          rationale: "proven query state",
          alternativeIds: [],
          verifier: { success: [{ kind: "url", value: url }], noResult: [], businessRejection: [] },
          groundedTargetIds: [],
          provingRuns: [{ runId: `run-${id}`, input: {}, outcome: "success", producedFieldIds: ["pageUrl"], at: now }],
          createdAt: now,
        },
      },
      conditions: [],
      successes: 1,
      failures: 0,
      sourceEpisodeIds: [],
    }],
    verification: { sceneId: "search", targetIds: [], outcomeIds: [] },
    status: "published",
    updatedAt: now,
  });
  const capability = (id, name, operationId) => ({
    id,
    kind: "navigation",
    resultKind: "page",
    exposure: "public",
    name,
    description: name,
    normalizedGoal: protocol.normalizeGoal(name),
    goalTemplate: name,
    aliases: [],
    inputs: { type: "object", properties: {}, required: [] },
    outputs: { type: "object", properties: { pageUrl: { type: "string" } } },
    outcomes: [],
    plans: [{ id: `plan-${id}`, entrySceneIds: ["search"], steps: [{ operationId, bindings: {} }], outputBindings: {} }],
    sourceEpisodeIds: [],
    confidence: 0.9,
    status: "available",
    module: { contentHash: `hash-${id}`, moduleUrl: `/programs/${id}.js`, exportName: "capability" },
    updatedAt: now,
  });
  release.operations = [
    operation("open-search", "打开商品列表", "https://demo.test/search"),
    operation("sort-low", "按价格从低到高排序", "https://demo.test/search?sort=price-low"),
  ];
  release.capabilities = [
    capability("cap-open-search", "打开商品列表", "open-search"),
    capability("cap-sort-low", "按价格从低到高排序", "sort-low"),
  ];

  const result = canonical.canonicalizeReleaseKnowledge(release);
  assert.deepEqual(result.operations.map((item) => item.id).sort(), ["open-search", "sort-low"]);
  assert.deepEqual(result.capabilities.map((item) => item.id).sort(), ["cap-open-search", "cap-sort-low"]);
});

test("release canonicalization removes sample text once dynamic input has structural proof", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const sceneModule = await bundledModule("../lib/site-knowledge/url-scene.ts");
  const canonical = await bundledModule("../lib/site-knowledge/canonicalize.ts");
  const from = sceneModule.sceneFromSnapshot(snapshot("https://demo.test/", "首页"));
  const to = sceneModule.sceneFromSnapshot(snapshot("https://demo.test/search?q=周杰伦", "搜索结果"));
  const learned = candidate(protocol, from, to);
  learned.operations[0].implementations[0].authored.proof.verifier.success = [
    { kind: "scene", value: to.id },
    { kind: "text", value: "周杰伦" },
    { kind: "input-visible", value: "query", inputId: "query" },
  ];
  learned.operations[0].verification.textIncludes = ["周杰伦"];
  learned.operations[0].verification.outcomeIds = [learned.capability.outcomes[0].id];
  learned.capability.outcomes[0].classifiers = [{ kind: "text", value: "周杰伦" }];
  const release = protocol.emptyRelease("demo", now);
  release.scenes = [from, to]; release.operations = learned.operations; release.capabilities = [learned.capability];
  const result = canonical.canonicalizeReleaseKnowledge(release);
  const operation = result.operations.find((item) => item.id === learned.operations[0].id);
  assert.deepEqual(operation.verification.textIncludes, []);
  assert.equal(operation.implementations[0].authored.proof.verifier.success.some((rule) => rule.kind === "text"), false);
  assert.deepEqual(result.capabilities[0].outcomes[0].classifiers, []);
});

test("Agent configuration has safe defaults, migrates old releases, and publishes without changing knowledge", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const canonical = await bundledModule("../lib/site-knowledge/canonicalize.ts");
  const store = await bundledModule("../db/site-agent-store.ts");
  const release = protocol.emptyRelease("agent-config");
  assert.equal(release.agentConfig.brand.displayName, "网站助手");
  release.profile = { ...release.profile, name: "热搜时光机", description: "微博热搜历史查询与每日热搜榜回看", jobsToBeDone: ["查询历史热搜记录"], suggestedGoals: ["查看每日热搜榜", "搜索历史热搜话题"] };
  delete release.agentConfig;
  const generated = canonical.canonicalizeReleaseKnowledge(release).agentConfig;
  assert.equal(generated.brand.displayName, "热搜时光机助手");
  assert.equal(generated.copy.welcomeTitle, "想在热搜时光机完成什么？");
  // A site is at its emptiest right after onboarding, which is exactly when a
  // visitor most needs a way in, so the opening questions come from what the
  // knowledge knows rather than from a released capability. The list this test
  // originally guarded against — goals derived from the capability catalog —
  // is still not a source.
  assert.deepEqual(generated.suggestions, ["查询历史热搜记录"], "knowledge answers for a site with no released capability");
  assert.ok(!generated.suggestions.some((item) => release.profile.suggestedGoals.includes(item)), "capability-derived goals are not the source");
  assert.equal(generated.appearance.preset, "orb");
  assert.equal(generated.appearance.palette, "blue");
  assert.equal(generated.brand.avatarText, "SiteWake");

  store.resetMemorySiteAgentStore();
  await store.createSiteAgent({ id: "agent-config" });
  const before = await store.getActiveSiteAgentRelease("agent-config");
  const updated = await store.updateSiteAgent("agent-config", { agentConfig: {
    appearance: { preset: "dock", palette: "violet", launcherPosition: "bottom-left" },
    overrides: { welcomeTitle: "Hi", pinnedSuggestions: ["一", "二", "三", "四"] },
    copy: { poweredByText: "Powered by Customer" },
  } });
  assert.equal(updated.release.version, before.release.version);
  assert.equal(updated.release.agentConfig.appearance.preset, "dock");
  assert.equal(updated.release.agentConfig.appearance.palette, "violet");
  assert.equal(updated.release.agentConfig.theme.accentColor, "#7c5cff");
  assert.equal(updated.release.agentConfig.theme.launcherPosition, "bottom-left");
  assert.equal(updated.release.agentConfig.copy.welcomeTitle, "Hi");
  assert.equal(updated.release.agentConfig.copy.poweredByText, "由 SiteWake 提供");
  assert.equal(updated.release.agentConfig.overrides.pinnedSuggestions.length, 3);
  assert.equal(updated.release.agentConfig.suggestions.length, 3);
  const movedRight = await store.updateSiteAgent("agent-config", { agentConfig: {
    ...updated.release.agentConfig,
    appearance: { ...updated.release.agentConfig.appearance, launcherPosition: "bottom-right" },
  } });
  assert.equal(movedRight.release.agentConfig.appearance.launcherPosition, "bottom-right", "an explicit right position replaces a saved left position");
  assert.equal(movedRight.release.agentConfig.theme.launcherPosition, "bottom-right");
  const reset = await store.updateSiteAgent("agent-config", { agentConfig: { reset: true } });
  assert.equal(reset.release.agentConfig.overrides.pinnedSuggestions.length, 0);
  assert.equal(reset.release.agentConfig.copy.poweredByText, "由 SiteWake 提供");
  assert.deepEqual(updated.release.scenes, before.release.scenes);
  assert.deepEqual(updated.release.capabilities, before.release.capabilities);
});

test("Chinese goal matching recalls a discovered navigation Capability instead of starting the agent cold", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const planner = await bundledModule("../lib/site-knowledge/planner.ts");
  const release = protocol.emptyRelease("demo", now);
  release.capabilities = [{ id: "cap-star", name: "打开明星热搜榜", description: "进入明星热搜", normalizedGoal: protocol.normalizeGoal("打开明星热搜榜"), aliases: ["明星热搜", "查看明星热搜"], inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} }, outcomes: [], plans: [], sourceEpisodeIds: [], confidence: 0.72, status: "available", updatedAt: now }];
  // An abbreviation is recalled, which is what keeps the Agent from starting
  // cold: the capability arrives as the top candidate in its bounded toolbox.
  // Reuse without a model is deliberately stricter — only wording the
  // capability owns clears that bar — so an abbreviation is routed, not assumed.
  assert.equal(planner.recallCapabilities(release, "打开明星榜")[0]?.capability.id, "cap-star");
  assert.equal(planner.matchCapability(release, "打开明星热搜榜")?.capability.id, "cap-star", "its own name is reuse");
  assert.equal(planner.matchCapability(release, "明星热搜")?.capability.id, "cap-star", "an alias it owns is reuse");
  assert.equal(planner.matchCapability(release, "打开明星榜"), undefined, "an abbreviation is routed, not assumed");
});

test("semantic recall exposes a bounded typed capability catalog when entity wording differs from the tool name", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const planner = await bundledModule("../lib/site-knowledge/planner.ts");
  const release = protocol.emptyRelease("demo", now);
  release.capabilities = [{ id: "cap-search", name: "按关键词搜索历史记录", description: "使用关键词查询历史内容并返回结果列表", normalizedGoal: protocol.normalizeGoal("按关键词搜索历史记录"), aliases: ["搜索历史记录"], goalTemplate: "搜索 {keyword}", inputs: { type: "object", properties: { keyword: { type: "string", description: "要搜索的关键词" } }, required: ["keyword"] }, outputs: { type: "object", properties: {} }, outcomes: [], plans: [], sourceEpisodeIds: [], confidence: 0.9, status: "available", exposure: "public", updatedAt: now }];
  assert.equal(planner.recallCapabilities(release, "帮我找一下周杰伦有什么热搜")[0]?.capability.id, "cap-search");
});

test("capability retrieval rejects opposite sort directions and mismatched dimensions", async () => {
  const planner = await bundledModule("../lib/site-knowledge/planner.ts");
  assert.equal(planner.capabilityGoalConflicts("帮我把商品按价格从高到低排一下", ["帮我把商品按价格从低到高排一下"]), true);
  assert.equal(planner.capabilityGoalConflicts("帮我把商品按价格从高到低排一下", ["按名称A到Z排序商品列表"]), true);
  assert.equal(planner.capabilityGoalConflicts("帮我把商品按价格从高到低排一下", ["帮我从商品卡片打开一个商品的快速预览"]), true);
  assert.equal(planner.capabilityGoalConflicts("帮我把商品按价格从低到高排一下", ["帮我把商品按价格从低到高排一下"]), false);
  assert.equal(planner.capabilityGoalConflicts("帮我把商品排序", ["帮我把商品按价格从低到高排一下"]), false);
});

test("an exact public capability is deterministic reuse while ambiguous matches still require routing", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const planner = await bundledModule("../lib/site-knowledge/planner.ts");
  const release = protocol.emptyRelease("demo", now);
  const capability = {
    id: "cap-cart",
    kind: "navigation",
    exposure: "public",
    name: "打开购物车",
    description: "进入购物车",
    normalizedGoal: protocol.normalizeGoal("打开购物车"),
    goalTemplate: "打开购物车",
    aliases: ["查看购物车"],
    inputs: { type: "object", properties: {} },
    outputs: { type: "object", properties: {} },
    module: FIXTURE_MODULE,
    outcomes: [],
    plans: [],
    sourceEpisodeIds: [],
    confidence: 1,
    status: "available",
    updatedAt: now,
  };
  release.capabilities = [capability];
  assert.equal(planner.exactCapabilityForGoal(release, "查看购物车")?.id, capability.id);
  release.capabilities.push({ ...capability, id: "cap-cart-duplicate" });
  assert.equal(planner.exactCapabilityForGoal(release, "查看购物车"), undefined);
});

test("planner can start a shared Operation from every recognized Scene", async () => {
  const planner = await bundledModule("../lib/site-knowledge/planner.ts");
  const operation = { id: "shared-daily", fromSceneId: "*" };
  const capability = { plans: [{ id: "plan", entrySceneIds: ["*"], steps: [{ operationId: operation.id, bindings: {} }], outputBindings: {} }] };
  const selected = planner.choosePlan(capability, [operation], "an-unrelated-detail-page");
  assert.equal(selected.startIndex, 0);
  assert.equal(selected.score, 3);
});

test("planner resumes from the Operation whose fromScene matches the user's current Scene", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const planner = await bundledModule("../lib/site-knowledge/planner.ts");
  const cap = candidate(protocol, { id: "home" }, { id: "result" }).capability;
  cap.plans[0].steps.push({ operationId: "open-detail", bindings: {} });
  const operations = [{ id: "operation-search", fromSceneId: "home" }, { id: "open-detail", fromSceneId: "result" }];
  assert.equal(planner.choosePlan(cap, operations, "result").startIndex, 1);
  assert.equal(planner.choosePlan(cap, operations, "unknown").score, 0);
});

test("a public page capability can reuse a verified internal Operation without duplicate authoring", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const gate = await bundledModule("../lib/site-knowledge/release-gate.ts");
  const canonicalize = await bundledModule("../lib/site-knowledge/canonicalize.ts");
  const release = protocol.emptyRelease("atlas", now);
  const sharedProgram = { version: 2, steps: [{ id: "go-daily", op: "navigate", url: "https://atlas.test/daily" }] };
  release.operations = [{ id: "operation-daily", kind: "navigate", name: "打开日榜", fromSceneId: "*", toSceneId: "scene-daily", applicability: { scope: "any-scene", evidenceSceneIds: ["scene-home", "scene-search"] }, inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: {} }, preconditions: [], effects: ["scene:scene-daily"], implementations: [{ id: "implementation-daily", program: sharedProgram, conditions: [], successes: 2, failures: 0, sourceEpisodeIds: [] }], verification: { sceneId: "scene-daily" }, status: "verified", updatedAt: now }];
  const capability = { id: "capability-daily", kind: "task", resultKind: "page", exposure: "public", name: "查看热搜日榜", description: "进入每日热搜归档", normalizedGoal: protocol.normalizeGoal("查看热搜日榜"), goalTemplate: "查看热搜日榜", aliases: [], inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: { pageUrl: { type: "string" }, pageTitle: { type: "string" } } }, outcomes: [{ id: "outcome-daily", status: "success", code: "success", description: "已到达日榜", classifiers: [] }], plans: [{ id: "plan-daily", entrySceneIds: ["scene-home", "scene-search"], steps: [{ operationId: "operation-daily", bindings: {} }], outputBindings: { pageUrl: { source: "state", path: "__pageUrl" }, pageTitle: { source: "state", path: "__pageTitle" } } }], sourceEpisodeIds: [], confidence: 0.8, status: "learning", updatedAt: now };
  const reused = { id: "candidate-daily", siteAgentId: "atlas", normalizedGoal: capability.normalizedGoal, baseReleaseVersion: 0, scenes: [], targets: [], operations: [], capability, validation: { status: "pending", attempts: 0, successfulReplays: 0, requiredReplays: 1 }, authoring: { stage: "authored", reusableTrace: false, intentKey: "open_daily_rank", capabilityKind: "task", goalTemplate: capability.goalTemplate, requiredInputs: [], resultFields: [{ id: "pageUrl", name: "页面地址", type: "string", source: "page-url" }, { id: "pageTitle", name: "页面标题", type: "string", source: "page-title" }], selectedImplementationId: "implementation-daily", alternatives: [{ id: "reuse", kind: "page-program", label: "复用共享导航", rationale: "已有两页证据", selected: true }] }, sourceEpisodeIds: [], createdAt: now, updatedAt: now };
  const job = { id: "validation-daily", learningJobId: "learning-daily", siteAgentId: "atlas", candidateId: reused.id, capabilityId: capability.id, baseReleaseVersion: 0, status: "running", validationCase: { id: "case-daily", name: "从搜索页执行", input: {}, inputSource: "observed", startUrl: "https://atlas.test/search?q=x", expectedStatuses: ["success"], effect: "read-only" }, attempt: 0, maxAttempts: 2, createdAt: now, updatedAt: now };
  const run = { id: "run-daily", learningJobId: "learning-daily", validationJobId: job.id, siteAgentId: "atlas", candidateId: reused.id, runnerId: "runner", mode: "validate", status: "passed", browser: { name: "chromium", version: "1", headless: true }, startedAt: now, endedAt: now, startUrl: job.validationCase.startUrl, endUrl: "https://atlas.test/daily", steps: [{ stepId: "go-daily", op: "navigate", status: "passed", startedAt: now, endedAt: now }], outcome: { status: "success", code: "success", summary: "已到达日榜", evaluatedAt: now, evidence: {} } };
  const decision = gate.evaluateBrowserRun(release, reused, job, run);
  assert.equal(decision.decision, "publish");
  assert.equal(decision.release.operations.length, 1);
  assert.equal(decision.release.capabilities[0].plans[0].steps[0].operationId, "operation-daily");
  const canonical = canonicalize.canonicalizeReleaseKnowledge(decision.release);
  assert.ok(canonical.capabilities.some((item) => item.id === "capability-daily" && item.exposure === "public"));
});

test("first success only queues AI authoring; an authored program publishes only through the independent release gate", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const compiler = await bundledModule("../lib/site-knowledge/compiler.ts");
  const canonical = await bundledModule("../lib/site-knowledge/canonicalize.ts");
  const gate = await bundledModule("../lib/site-knowledge/release-gate.ts");
  const scenes = await bundledModule("../lib/site-knowledge/url-scene.ts");
  const from = scenes.sceneFromSnapshot(snapshot("https://atlas.test/"));
  const to = scenes.sceneFromSnapshot(snapshot("https://atlas.test/search?q=earbuds", "搜索结果"));
  const learned = candidate(protocol, from, to);
  const initial = protocol.emptyRelease("atlas", now);
  // A terminal conversation that succeeded is evidence, not a production
  // request: the store aggregates these receipts for a later proposal pass, and
  // nothing is queued or published from the conversation itself.
  const conversation = compiler.compileEpisode(
    { release: initial, candidates: [], session: session(), triggerAuthority: "terminal-user-gap" },
    episode(protocol, "adaptive", { status: "success", code: "success", summary: "完成" }),
  );
  assert.equal(conversation.directive.type, "complete");
  assert.equal(conversation.published, false);
  assert.equal(conversation.release.version, 0);

  // Nothing is queued from an episode at all now: the branch that built a
  // Candidate and a LearningJob here was reachable only from a control-plane
  // entry point no route called, and the capability centre's own proposal
  // pipeline owns authoring. An Episode never carries a compiled candidate.
  assert.equal("compiledCandidate" in episode(protocol, "adaptive", { status: "success", code: "success", summary: "完成" }), false);
  assert.equal(initial.version, 0);
  const validationJob = { id: "validation-1", learningJobId: "learning-1", siteAgentId: "atlas", candidateId: learned.id, capabilityId: learned.capability.id, baseReleaseVersion: 0, status: "running", validationCase: { id: "case-1", name: "different input", input: { query: "键盘" }, inputSource: "derived-from-evidence", startUrl: "https://atlas.test/", expectedStatuses: ["success", "no-result", "business-rejection"], effect: "read-only" }, attempt: 0, maxAttempts: 2, createdAt: now, updatedAt: now };
  const run = { id: "run-1", learningJobId: "learning-1", validationJobId: validationJob.id, siteAgentId: "atlas", candidateId: learned.id, runnerId: "runner-1", mode: "validate", status: "passed", browser: { name: "chromium", version: "1", headless: true }, startedAt: now, endedAt: now, startUrl: "https://atlas.test/", endUrl: "https://atlas.test/search?q=keyboard", steps: [{ stepId: "step-wait", op: "waitForCondition", status: "passed", startedAt: now, endedAt: now }], outcome: { status: "success", code: "verified", summary: "验证完成", evaluatedAt: now, evidence: {} } };
  const decision = gate.evaluateBrowserRun(initial, learned, validationJob, run);
  assert.equal(decision.decision, "publish");
  assert.equal(decision.release.version, 1);
  assert.equal(decision.release.capabilities[0].status, "available");
  console.log("PROBE published", JSON.stringify(decision.release.capabilities.map((c) => [c.id, c.status, c.exposure, c.origin])), JSON.stringify(decision.release.profile.suggestedGoals), JSON.stringify(decision.release.profile.taskTemplates?.map((t) => t.name)));
  assert.equal(decision.release.profile.taskTemplates[0].name, "搜索商品");
  // The widget's suggestions are the site's own words, written from its pages,
  // rather than capability names: a visitor is offered a question to ask, and
  // "搜索商品" is a tool. A published capability shows up in `suggestedGoals`
  // and `taskTemplates`, which is what the console and the Agent read.
  assert.deepEqual(decision.release.agentConfig.suggestions, [], "a capability name is not a visitor-facing question");
  const withQuestions = {
    ...decision.release,
    profile: { ...decision.release.profile, suggestedQuestions: ["帮我搜索一款耳机"] },
  };
  assert.deepEqual(
    protocol.deriveAgentConfigFromKnowledge(withQuestions).suggestions,
    ["帮我搜索一款耳机"],
    "the site's own questions are what the widget offers",
  );
  const mixed = structuredClone(decision.release);
  mixed.capabilities.push({
    ...mixed.capabilities[0],
    id: "capability-internal",
    name: "内部诊断",
    normalizedGoal: "内部诊断",
    exposure: "internal",
  });
  mixed.profile.taskTemplates = [];
  mixed.profile.suggestedGoals = [];
  const mixedRelease = canonical.canonicalizeReleaseKnowledge(mixed);
  // An internal capability is not offered to anybody: it stays out of the
  // public goal list and out of the task templates built from it.
  assert.deepEqual(mixedRelease.profile.suggestedGoals, ["搜索商品"]);
  assert.deepEqual(mixedRelease.profile.taskTemplates.map((task) => task.name), ["搜索商品"]);
  const pinned = protocol.emptyRelease("atlas-pinned", now);
  pinned.agentConfig.overrides.pinnedSuggestions = ["固定建议"];
  pinned.agentConfig.suggestions = ["固定建议"];
  const pinnedRelease = compiler.materializeCandidateRelease(pinned, { id: "episode-pinned", endedAt: now }, learned);
  assert.deepEqual(pinnedRelease.agentConfig.overrides.pinnedSuggestions, ["固定建议"]);
  // A pinned suggestion is what the administrator typed. Materializing a new
  // capability neither drops it nor appends a tool name beside it.
  assert.deepEqual(pinnedRelease.agentConfig.suggestions, ["固定建议"]);
  assert.equal(initial.version, 0);
});

test("only a terminal Site Agent capability gap or an explicit authoring request enters AI production", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const compiler = await bundledModule("../lib/site-knowledge/compiler.ts");
  const store = await bundledModule("../db/site-agent-store.ts");
  const succeeded = { status: "success", code: "success", summary: "完成" };
  const compile = (value, triggerAuthority) => compiler.compileEpisode({
    release: protocol.emptyRelease(`trigger-${value.mode}`, now),
    candidates: [],
    session: session(),
    triggerAuthority,
  }, value);

  const passive = episode(protocol, "passive", succeeded);
  passive.experience = structuredClone(episode(protocol, "adaptive", succeeded).experience);
  assert.notEqual(compile(passive).directive.type, "learning-queued", "passive experience is knowledge evidence, not a user capability request");

  const demonstration = episode(protocol, "demonstration", succeeded);
  assert.notEqual(compile(demonstration).directive.type, "learning-queued", "a demonstration recording does not autonomously start production");

  const repair = episode(protocol, "repair", succeeded);
  repair.outcome.evidence.decisionSource = "user-agent";
  assert.notEqual(compile(repair).directive.type, "learning-queued", "repair is an execution recovery path, not a new capability request");

  const untrustedAdaptive = episode(protocol, "adaptive", succeeded);
  assert.notEqual(compile(untrustedAdaptive).directive.type, "learning-queued", "a client decisionSource marker alone grants no production authority");

  store.resetMemorySiteAgentStore();
  await store.createSiteAgent({ id: "atlas", url: "https://atlas.test/" });
  await store.getSiteAgentOverview("atlas");
  await store.createTaskSession(session());
  const terminalGap = episode(protocol, "adaptive", succeeded);
  const recorded = await store.appendTaskEpisode("atlas", terminalGap, { triggerAuthority: "terminal-user-gap" });
  assert.equal(recorded.directive.type, "recorded");
  const terminalAgent = globalThis.__SITEWAKE_SITE_AGENT_V2__.get("atlas");
  assert.equal(terminalAgent.capabilitySignals.length, 1);
  assert.equal(terminalAgent.learningJobs.length, 0);

  // There is no longer a second kind of trigger. Real-time authoring from
  // inside the compiler was reachable only through a control-plane entry point
  // that no route called; both are gone, and an `author-request` episode is
  // refused at the route (403) rather than compiled into a build.
  const explicitRequest = episode(protocol, "author-request", { status: "success", code: "AUTHORING_REQUESTED", summary: "开始建设" });
  assert.equal(compile(explicitRequest).directive.type, "complete", "nothing is queued from an episode any more");
  const episodeRoute = await readFile(new URL("../app/api/site-agents/[siteAgentId]/episodes/route.ts", import.meta.url), "utf8");
  assert.match(episodeRoute, /episode\.mode === "author-request"[\s\S]{0,80}403/);
  assert.doesNotMatch(episodeRoute, /control-plane/);
});

test("an authenticated AgentRun grants one terminal user-gap trigger and rejects replay", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const siteStore = await bundledModule("../db/site-agent-store.ts");
  const runStore = await bundledModule("../db/agent-run-store.ts");
  siteStore.resetMemorySiteAgentStore();
  await siteStore.createSiteAgent({ id: "trusted-terminal-gap", url: "https://trusted-gap.test/" });
  await siteStore.getSiteAgentOverview("trusted-terminal-gap");
  const created = await runStore.createAgentRun({
    siteAgentId: "trusted-terminal-gap",
    origin: "https://trusted-gap.test",
    url: "https://trusted-gap.test/",
    goal: "打开购物车",
    taskInput: {},
    documentId: "document-trusted-gap",
    browserSessionId: "browser-trusted-gap",
    controller: "page-agent",
    requestOrigin: "https://trusted-gap.test",
    controlPlaneOrigin: "https://trusted-gap.test",
  });
  const receipt = {
    ...episode(protocol, "adaptive", { status: "success", code: "success", summary: "已打开购物车" }),
    id: "episode-trusted-gap",
    siteAgentId: "trusted-terminal-gap",
    taskSessionId: created.run.id,
    browserSessionId: "browser-trusted-gap",
    documentId: "document-trusted-gap",
    goal: "打开购物车",
    normalizedGoal: protocol.normalizeGoal("打开购物车"),
    input: {},
  };
  const authorized = await runStore.authorizeAgentRunEpisode(created.run.id, created.resumeToken, receipt);
  assert.equal(authorized.triggerAuthority, "terminal-user-gap");
  assert.equal(authorized.run.status, "completed");
  assert.equal(authorized.run.agentState.capabilityGapEpisodeId, receipt.id);
  const idempotent = await runStore.authorizeAgentRunEpisode(created.run.id, created.resumeToken, receipt);
  assert.equal(idempotent.triggerAuthority, "terminal-user-gap");
  const experienceAuthority = await runStore.authorizeAgentRunCapabilityExperience(created.run.id, created.resumeToken, {
    schemaVersion: "1.0",
    episodeId: receipt.id,
    agentRunId: created.run.id,
    browserSessionId: "browser-trusted-gap",
    originalGoal: "打开购物车",
    outcome: "Success",
    outcomeSummary: "已打开购物车",
    startedAt: receipt.startedAt,
    endedAt: receipt.endedAt,
    startPage: { url: receipt.startSnapshot.url },
    endPage: { url: receipt.endSnapshot.url },
    actions: [],
    output: {},
  }, "trusted-terminal-gap");
  assert.equal(experienceAuthority.run.id, created.run.id);
  await assert.rejects(
    runStore.authorizeAgentRunEpisode(created.run.id, created.resumeToken, { ...receipt, id: "episode-forged-replay" }),
    /agent_run_episode_already_consumed/,
  );

  const route = await readFile(new URL("../app/api/site-agents/[siteAgentId]/episodes/route.ts", import.meta.url), "utf8");
  assert.match(route, /episode\.mode === "author-request"[\s\S]*403/);
  assert.match(route, /authorizeAgentRunEpisode/);
});

test("an authenticated no-result PageAgent run may seed capability construction only with page actions", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const siteStore = await bundledModule("../db/site-agent-store.ts");
  const runStore = await bundledModule("../db/agent-run-store.ts");
  siteStore.resetMemorySiteAgentStore();
  await siteStore.createSiteAgent({ id: "trusted-no-result-gap", url: "https://trusted-no-result.test/" });
  await siteStore.getSiteAgentOverview("trusted-no-result-gap");
  const created = await runStore.createAgentRun({
    siteAgentId: "trusted-no-result-gap",
    origin: "https://trusted-no-result.test",
    url: "https://trusted-no-result.test/",
    goal: "搜索不存在的商品",
    taskInput: {},
    documentId: "document-no-result",
    browserSessionId: "browser-no-result",
    controller: "page-agent",
    requestOrigin: "https://trusted-no-result.test",
    controlPlaneOrigin: "https://trusted-no-result.test",
  });
  const base = {
    ...episode(protocol, "adaptive", { status: "no-result", code: "empty", summary: "没有匹配商品" }),
    siteAgentId: "trusted-no-result-gap",
    taskSessionId: created.run.id,
    browserSessionId: "browser-no-result",
    documentId: "document-no-result",
    goal: "搜索不存在的商品",
    normalizedGoal: protocol.normalizeGoal("搜索不存在的商品"),
    input: {},
    experience: {
      version: 1,
      actions: [{ id: "no-result-fill", action: "fill", rawAction: "input_text", input: { text: "不存在的商品" }, page: { url: "https://trusted-no-result.test/", title: "商品", heading: "商品" }, observedAt: now }],
      actorSummary: "没有匹配商品",
      judgeEvidence: ["搜索结果为空"],
    },
  };
  const withoutAction = { ...base, id: "episode-no-result-empty", experience: { ...base.experience, actions: [] } };
  const rejectedSeed = await runStore.authorizeAgentRunEpisode(created.run.id, created.resumeToken, withoutAction);
  assert.equal(rejectedSeed.triggerAuthority, undefined);
  const withAction = { ...base, id: "episode-no-result-action" };
  const acceptedSeed = await runStore.authorizeAgentRunEpisode(created.run.id, created.resumeToken, withAction);
  assert.equal(acceptedSeed.triggerAuthority, "terminal-user-gap");
  assert.equal(acceptedSeed.run.outcome.status, "no-result");
});

test("D1 CAS grants terminal user-gap authority to only one competing Episode", async (t) => {
  const isolated = await isolatedD1Database();
  t.after(isolated.dispose);
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const siteStore = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
  const runStore = await bundledModule("../db/agent-run-store.ts", { database: isolated.database });
  await siteStore.createSiteAgent({
    id: "d1-terminal-gap",
    name: "D1 terminal gap",
    url: "https://d1-gap.test/",
  });
  const created = await runStore.createAgentRun({
    siteAgentId: "d1-terminal-gap",
    origin: "https://d1-gap.test",
    url: "https://d1-gap.test/",
    goal: "open cart",
    taskInput: {},
    documentId: "document-d1-gap",
    browserSessionId: "browser-d1-gap",
    controller: "page-agent",
    requestOrigin: "https://d1-gap.test",
    controlPlaneOrigin: "https://d1-gap.test",
  });
  const baseReceipt = {
    ...episode(protocol, "adaptive", { status: "success", code: "success", summary: "cart opened" }),
    siteAgentId: "d1-terminal-gap",
    taskSessionId: created.run.id,
    browserSessionId: "browser-d1-gap",
    documentId: "document-d1-gap",
    goal: "open cart",
    normalizedGoal: protocol.normalizeGoal("open cart"),
    input: {},
  };
  const receipts = [
    { ...baseReceipt, id: "episode-d1-gap-a" },
    { ...baseReceipt, id: "episode-d1-gap-b" },
  ];
  const competing = await Promise.allSettled(receipts.map((receipt) =>
    runStore.authorizeAgentRunEpisode(created.run.id, created.resumeToken, receipt)));
  const fulfilled = competing.filter((result) => result.status === "fulfilled");
  const rejected = competing.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0].reason), /agent_run_episode_already_consumed/);
  const stored = await isolated.database.prepare(
    "SELECT revision,run_json AS runJson FROM site_agent_v3_agent_runs WHERE id=? LIMIT 1",
  ).bind(created.run.id).first();
  assert.equal(stored.revision, 2, "only one CAS update commits");
  const persistedRun = JSON.parse(stored.runJson);
  assert.equal(persistedRun.agentState.capabilityGapEpisodeId, fulfilled[0].value.run.agentState.capabilityGapEpisodeId);
});

test("D1 aggregates concurrent pending and processing capability signals by intent", async (t) => {
  const isolated = await isolatedD1Database();
  t.after(isolated.dispose);
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
  const centerStore = await bundledModule("../db/capability-center-store.ts", { database: isolated.database });
  const siteAgentId = "d1-capability-signal-aggregate";
  await store.createSiteAgent({ id: siteAgentId, name: "Signal aggregate", url: "https://signals.test/" });
  await store.createTaskSession({
    ...session(),
    id: "task-signal-aggregate",
    siteAgentId,
    browserSessionId: "browser-signal-aggregate",
  });
  const base = {
    ...episode(protocol, "adaptive", { status: "success", code: "success", summary: "cart opened" }),
    siteAgentId,
    taskSessionId: "task-signal-aggregate",
    browserSessionId: "browser-signal-aggregate",
    goal: "open cart",
    normalizedGoal: protocol.normalizeGoal("open cart"),
  };
  await Promise.all([
    store.appendTaskEpisode(siteAgentId, { ...base, id: "episode-signal-a" }, { triggerAuthority: "terminal-user-gap" }),
    store.appendTaskEpisode(siteAgentId, { ...base, id: "episode-signal-b" }, { triggerAuthority: "terminal-user-gap" }),
  ]);
  let rows = (await isolated.database.prepare(
    "SELECT status,signal_json AS signalJson FROM site_agent_v2_capability_signals WHERE site_agent_id=?",
  ).bind(siteAgentId).all()).results;
  assert.equal(rows.length, 1, "concurrent same-intent Episodes create one active signal");
  let signal = JSON.parse(rows[0].signalJson);
  assert.deepEqual(new Set(signal.episodeIds), new Set(["episode-signal-a", "episode-signal-b"]));

  const processingAt = new Date().toISOString();
  await isolated.database.prepare(
    "UPDATE site_agent_v2_capability_signals SET status='processing',updated_at=? WHERE id=?",
  ).bind(processingAt, signal.id).run();
  await store.appendTaskEpisode(siteAgentId, { ...base, id: "episode-signal-c" }, { triggerAuthority: "terminal-user-gap" });
  rows = (await isolated.database.prepare(
    "SELECT status,signal_json AS signalJson FROM site_agent_v2_capability_signals WHERE site_agent_id=?",
  ).bind(siteAgentId).all()).results;
  assert.equal(rows.length, 1);
  signal = JSON.parse(rows[0].signalJson);
  assert.equal(signal.status, "processing", "new evidence does not detach or restart the in-flight analysis");
  assert.deepEqual(new Set(signal.episodeIds), new Set(["episode-signal-a", "episode-signal-b", "episode-signal-c"]));

  const legacySignal = {
    ...signal,
    id: "legacy-random-signal-id",
    status: "pending",
    episodeIds: ["episode-signal-legacy"],
    evidenceRefs: ["episode-signal-legacy"],
    createdAt: new Date(Date.parse(signal.createdAt) + 1).toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await isolated.database.prepare(`INSERT INTO site_agent_v2_capability_signals
    (id,site_agent_id,intent_bucket,status,signal_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(legacySignal.id, siteAgentId, legacySignal.intentBucket, legacySignal.status, JSON.stringify(legacySignal), legacySignal.createdAt, legacySignal.updatedAt).run();
  const canonicalProposal = await centerStore.createCapabilityProposal(siteAgentId, {
    id: "proposal-signal-a", title: "Open cart", requestedGoal: "open cart", sourceEpisodeId: "episode-signal-a",
  });
  const loserProposal = await centerStore.createCapabilityProposal(siteAgentId, {
    id: "proposal-signal-z", title: "Open cart again", requestedGoal: "open cart", sourceEpisodeId: "episode-signal-legacy",
  });
  await centerStore.claimCapabilityProposalAnalysis(siteAgentId, canonicalProposal.proposal.id, canonicalProposal.proposal.updatedAt);
  await centerStore.claimCapabilityProposalAnalysis(siteAgentId, loserProposal.proposal.id, loserProposal.proposal.updatedAt);
  const terminalProposal = await centerStore.createCapabilityProposal(siteAgentId, {
    id: "proposal-signal-terminal", title: "Historical rejection", requestedGoal: "open cart", sourceEpisodeId: "episode-signal-b",
  });
  const terminalClaim = await centerStore.claimCapabilityProposalAnalysis(siteAgentId, terminalProposal.proposal.id, terminalProposal.proposal.updatedAt);
  await centerStore.resolveCapabilityProposalAnalysis(siteAgentId, terminalClaim.id, {
    status: "rejected", expectedUpdatedAt: terminalClaim.updatedAt, analysis: { reason: "terminal-history" },
  });
  await isolated.database.prepare(`INSERT INTO site_agent_v2_capability_tasks
    (id,site_agent_id,proposal_id,capability_id,capability_version_id,type,status,stage,task_json,result_json,evidence_json,error_json,archived_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind("task-existing-proposal", siteAgentId, loserProposal.proposal.id, "capability-existing", "version-existing", "generate", "queued", "author", "{}", "{}", "{}", null, null, new Date().toISOString(), new Date().toISOString()).run();
  const dispatch = await store.processQueuedCapabilitySignals(siteAgentId, 1);
  assert.equal(dispatch.processed, 0, "a second legacy row is consolidated before either row can create a Proposal");
  rows = (await isolated.database.prepare(
    "SELECT status,signal_json AS signalJson FROM site_agent_v2_capability_signals WHERE site_agent_id=? ORDER BY status",
  ).bind(siteAgentId).all()).results;
  assert.deepEqual(rows.map((row) => row.status).sort(), ["processing", "superseded"]);
  const active = JSON.parse(rows.find((row) => row.status === "processing").signalJson);
  assert.deepEqual(new Set(active.episodeIds), new Set([
    "episode-signal-a", "episode-signal-b", "episode-signal-c", "episode-signal-legacy",
  ]));
  const proposalRows = (await isolated.database.prepare(
    "SELECT id,status,analysis_json AS analysisJson,archived_at AS archivedAt FROM site_agent_v2_capability_proposals WHERE site_agent_id=? ORDER BY id",
  ).bind(siteAgentId).all()).results;
  const activeProposals = proposalRows.filter((row) => !row.archivedAt && (row.status === "pending" || row.status === "analyzing"));
  const supersededProposals = proposalRows.filter((row) => row.archivedAt);
  assert.equal(activeProposals.length, 1, "the default UI sees only one canonical Proposal");
  assert.equal(activeProposals[0].id, loserProposal.proposal.id, "a Proposal that already owns a Task is canonical even when it is newer");
  assert.equal(activeProposals[0].status, "analyzing", "coalescing never overwrites a Proposal that already owns a Task");
  assert.ok(supersededProposals.length >= 1, "no-Task active losers are archived");
  for (const proposal of supersededProposals) {
    assert.equal(JSON.parse(proposal.analysisJson).supersededByProposalId, activeProposals[0].id);
  }
  const preservedTerminal = proposalRows.find((row) => row.id === terminalProposal.proposal.id);
  assert.equal(preservedTerminal.archivedAt, null, "terminal Proposal history is not overwritten or archived");
  assert.deepEqual(JSON.parse(preservedTerminal.analysisJson), { reason: "terminal-history" });
});

test("an existing public capability never re-enters AI production when an exploratory client omits capabilityId", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const compiler = await bundledModule("../lib/site-knowledge/compiler.ts");
  const release = protocol.emptyRelease("atlas", now);
  const existing = candidate(protocol, { id: "home" }, { id: "result" }).capability;
  existing.status = "available";
  existing.exposure = "public";
  release.capabilities = [existing];
  const completed = episode(protocol, "adaptive", { status: "success", code: "success", summary: "完成" });
  completed.goal = existing.name;
  completed.normalizedGoal = protocol.normalizeGoal(existing.name);
  delete completed.capabilityId;
  const result = compiler.compileEpisode({ release, candidates: [], session: session() }, completed);
  assert.notEqual(result.directive.type, "learning-queued");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.release.capabilities[0].origin, existing.origin);
});

test("a successful published capability run never queues an implicit enhancement", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const compiler = await bundledModule("../lib/site-knowledge/compiler.ts");
  const release = protocol.emptyRelease("atlas", now);
  const existing = candidate(protocol, { id: "home" }, { id: "result" }).capability;
  existing.status = "available";
  existing.exposure = "public";
  release.capabilities = [existing];
  const completed = episode(protocol, "compiled", { status: "success", code: "success", summary: "完成" });
  completed.goal = existing.name;
  completed.normalizedGoal = protocol.normalizeGoal(existing.name);
  completed.capabilityId = existing.id;
  completed.outcome.evidence.capabilityUse = {
    fullySatisfied: false,
    missingOutputFields: ["totalCount"],
  };
  const result = compiler.compileEpisode({ release, candidates: [], session: session() }, completed);
  assert.notEqual(result.directive.type, "learning-queued");
  assert.equal(result.candidates.length, 0);
});

test("a successful zero-action page insight enters AI reuse review instead of disappearing", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const store = await bundledModule("../db/site-agent-store.ts");
  store.resetMemorySiteAgentStore();
  await store.createSiteAgent({ id: "atlas", url: "https://atlas.test/" });
  await store.getSiteAgentOverview("atlas");
  await store.createTaskSession(session());
  const insight = episode(protocol, "adaptive", { status: "success", code: "TASK_COMPLETED", summary: "已总结当前榜单" });
  insight.goal = "总结一下当前榜单";
  insight.normalizedGoal = protocol.normalizeGoal(insight.goal);
  insight.input = {};
  insight.endSnapshot = { ...insight.startSnapshot };
  insight.experience = { version: 1, actions: [], actorSummary: "已总结当前榜单", judgeEvidence: ["榜单摘要"], toolReceipts: [] };
  insight.outcome.evidence.structuredOutput = { summary: "榜单第一名是示例商品", total: 10 };
  const result = await store.appendTaskEpisode("atlas", insight, { triggerAuthority: "terminal-user-gap" });
  assert.equal(result.directive.type, "recorded");
  const agent = globalThis.__SITEWAKE_SITE_AGENT_V2__.get("atlas");
  assert.equal(agent.capabilitySignals.length, 1);
  assert.deepEqual(agent.capabilitySignals[0].episodeIds, [insight.id]);

  const emptyInsight = structuredClone(insight);
  emptyInsight.id = "episode-zero-action-empty-output";
  emptyInsight.goal = "闲聊一下";
  emptyInsight.normalizedGoal = protocol.normalizeGoal(emptyInsight.goal);
  emptyInsight.outcome.evidence = { decisionSource: "user-agent" };
  await store.appendTaskEpisode("atlas", emptyInsight, { triggerAuthority: "terminal-user-gap" });
  assert.equal(agent.capabilitySignals.length, 1, "zero-action success without structured output remains ordinary conversation");
});

test("the episode compiler cannot start a capability build at all", async () => {
  const compiler = await readFile(new URL("../lib/site-knowledge/compiler.ts", import.meta.url), "utf8");
  // Authoring used to have two doors: the capability centre's proposal
  // pipeline, and a control-plane entry point that compiled an `author-request`
  // episode straight into a Candidate and a LearningJob. The second door had no
  // route, so it was reachable only from tests — and it duplicated the factory's
  // own judgement about what deserves to be built. It is gone, and the compiler
  // now has no way to queue anything: an Episode records evidence, updates a
  // Release, or asks the page Agent to carry on.
  assert.doesNotMatch(compiler, /learning-queued/);
  // The authority union is the structural half of the claim: there is no value
  // a caller could pass to ask for authoring. (The prose above the code still
  // explains the removal, so the check reads the quoted literal, not the word.)
  assert.match(compiler, /triggerAuthority\?: "terminal-user-gap";/);
  assert.doesNotMatch(compiler, /"control-plane"/);
  assert.doesNotMatch(compiler, /"author-request"/);
  const directives = [...compiler.matchAll(/directive: \{ type: "([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(directives)].sort(), ["complete"]);
  const store = await readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8");
  assert.doesNotMatch(store, /createAutonomousCapabilityGoal/);
  assert.doesNotMatch(store, /forceCapabilityDesign/);
});

test("business no-result expands the outcome contract and never starts selector repair", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const compiler = await bundledModule("../lib/site-knowledge/compiler.ts");
  const release = protocol.emptyRelease("atlas", now);
  const learned = candidate(protocol, { id: "home" }, { id: "result" });
  release.capabilities = [{ ...learned.capability, status: "available" }];
  const result = compiler.compileEpisode({ release, candidates: [], session: session() }, episode(protocol, "compiled", { status: "no-result", code: "not_found", summary: "没有找到商品" }));
  assert.notEqual(result.directive.type, "continue-adaptive");
  assert.equal(result.release.capabilities[0].outcomes.some((item) => item.status === "no-result"), true);
});

test("a no-result reached during independent replay is a valid release-gate outcome", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const gate = await bundledModule("../lib/site-knowledge/release-gate.ts");
  const scenes = await bundledModule("../lib/site-knowledge/url-scene.ts");
  const learned = candidate(protocol, scenes.sceneFromSnapshot(snapshot("https://atlas.test/")), scenes.sceneFromSnapshot(snapshot("https://atlas.test/search?q=x", "搜索结果")));
  const job = { id: "validation-2", learningJobId: "learning-2", siteAgentId: "atlas", candidateId: learned.id, capabilityId: learned.capability.id, baseReleaseVersion: 0, status: "running", validationCase: { id: "case-2", name: "no result", input: { query: "不存在" }, inputSource: "derived-from-evidence", startUrl: "https://atlas.test/", expectedStatuses: ["success", "no-result", "business-rejection"], effect: "read-only" }, attempt: 0, maxAttempts: 2, createdAt: now, updatedAt: now };
  const run = { id: "run-2", learningJobId: "learning-2", validationJobId: job.id, siteAgentId: "atlas", candidateId: learned.id, runnerId: "runner-1", mode: "validate", status: "passed", browser: { name: "chromium", version: "1", headless: true }, startedAt: now, endedAt: now, startUrl: "https://atlas.test/", endUrl: "https://atlas.test/search?q=none", steps: [{ stepId: "step-wait", op: "waitForCondition", status: "passed", startedAt: now, endedAt: now }], outcome: { status: "no-result", code: "not_found", summary: "没有找到商品", evaluatedAt: now, evidence: {} } };
  const result = gate.evaluateBrowserRun(protocol.emptyRelease("atlas", now), learned, job, run);
  assert.equal(result.decision, "publish");
  assert.equal(result.candidate.validation.status, "passed");
});

test("release gate rejects a navigate program whose required Scene parameter is not bound", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const gate = await bundledModule("../lib/site-knowledge/release-gate.ts");
  const scenes = await bundledModule("../lib/site-knowledge/url-scene.ts");
  const home = scenes.sceneFromSnapshot(snapshot("https://atlas.test/", "首页"));
  const daily = scenes.sceneFromSnapshot(snapshot("https://atlas.test/daily/2025-03-25", "日榜"));
  daily.parameters = [{ id: "path1", name: "路径参数 1", type: "string", required: true, examples: ["2025-03-25"] }];
  daily.urlTemplates[0].pathnamePattern = "/daily/{path1}";
  const learned = candidate(protocol, home, daily);
  learned.capability.inputs = { type: "object", properties: { date: { type: "string" } }, required: ["date"] };
  learned.operations[0].inputs = learned.capability.inputs;
  const navigate = { id: "step-daily", op: "navigate", sceneId: daily.id, bindings: {}, timeoutMs: 8_000 };
  learned.operations[0].implementations[0].program = { version: 2, steps: [navigate] };
  learned.operations[0].implementations[0].authored.program = { version: 2, steps: [navigate] };
  const job = { id: "validation-binding", learningJobId: "learning-binding", siteAgentId: "atlas", candidateId: learned.id, capabilityId: learned.capability.id, baseReleaseVersion: 0, status: "running", validationCase: { id: "case-binding", name: "date", input: { date: "2025-03-25" }, inputSource: "observed", startUrl: "https://atlas.test/", expectedStatuses: ["success"], effect: "read-only" }, attempt: 0, maxAttempts: 2, createdAt: now, updatedAt: now };
  const run = { id: "run-binding", learningJobId: job.learningJobId, validationJobId: job.id, siteAgentId: "atlas", candidateId: learned.id, runnerId: "runner-1", mode: "validate", status: "passed", browser: { name: "chromium", version: "1", headless: true }, startedAt: now, endedAt: now, startUrl: "https://atlas.test/", endUrl: "https://atlas.test/daily/2025-03-25", steps: [{ stepId: "step-daily", op: "navigate", status: "passed", startedAt: now, endedAt: now }], outcome: { status: "success", code: "verified", summary: "验证完成", evaluatedAt: now, evidence: {} } };
  const result = gate.evaluateBrowserRun(protocol.emptyRelease("atlas", now), learned, job, run);
  assert.equal(result.decision, "reject");
  assert.equal(result.reason, "program_binding_incomplete");
});

test("execution faults get at most two adaptive repair rounds", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const compiler = await bundledModule("../lib/site-knowledge/compiler.ts");
  for (const attempt of [0, 1]) {
    const broken = episode(protocol, "compiled", { status: "execution-fault", code: "target_not_found", summary: "定位失败" });
    broken.outcome.evidence.repairAttempt = attempt;
    assert.equal(compiler.compileEpisode({ release: protocol.emptyRelease("atlas", now), candidates: [], session: session() }, broken).directive.type, "continue-adaptive");
  }
  const exhausted = episode(protocol, "compiled", { status: "execution-fault", code: "target_not_found", summary: "定位失败" });
  exhausted.outcome.evidence.repairAttempt = 2;
  assert.equal(compiler.compileEpisode({ release: protocol.emptyRelease("atlas", now), candidates: [], session: session() }, exhausted).session.status, "failed");
});

test("PageAgent Runtime V2 repairs only published capability drift and inherits its brief and budget", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const compiler = await bundledModule("../lib/site-knowledge/compiler.ts");
  const release = protocol.emptyRelease("atlas", now);
  release.runtimeFeatures = { pageAgentRuntimeV2: true, pageAgentEvidenceV2: true, capabilityExperienceOutbox: true };
  const learned = candidate(protocol, { id: "home" }, { id: "result" });
  learned.capability.status = "available";
  release.capabilities = [learned.capability];
  const brief = {
    objective: "搜索耳机",
    normalizedGoal: protocol.normalizeGoal("搜索耳机"),
    entities: { query: "耳机" },
    effect: "read",
    completionCriteria: ["页面展示搜索结果"],
    relevantSceneIds: [],
    relevantCapabilityIds: [learned.capability.id],
    rejectedCapabilityReasons: ["selector drift"],
    knowledgeReceiptRefs: [],
  };
  const budgetEvidence = { activeLimitMs: 90_000, modelRequestLimit: 5, activeElapsedMs: 12_000, modelRequests: 1, noProgressCount: 0 };
  const broken = episode(protocol, "compiled", { status: "execution-fault", code: "target_not_found", summary: "定位失败" });
  broken.capabilityId = learned.capability.id;
  broken.sourceCapabilityId = learned.capability.id;
  broken.repairKind = "compiled-capability-drift";
  broken.pageExecutionBrief = brief;
  broken.experience = { version: 1, actions: [], actorSummary: "", judgeEvidence: [], budgetEvidence };
  const result = compiler.compileEpisode({ release, candidates: [], session: session() }, broken);
  assert.equal(result.directive.type, "continue-adaptive");
  assert.equal(result.directive.sourceCapabilityId, learned.capability.id);
  assert.equal(result.directive.repairKind, "compiled-capability-drift");
  assert.deepEqual(result.directive.pageExecutionBrief, brief);
  assert.deepEqual(result.directive.budgetEvidence, budgetEvidence);

  const missingBudget = structuredClone(broken);
  missingBudget.id = "episode-drift-without-budget";
  delete missingBudget.experience;
  const noFreshBudget = compiler.compileEpisode({ release, candidates: [], session: session() }, missingBudget);
  assert.equal(noFreshBudget.directive.type, "complete", "drift repair must not receive a fresh budget");

  const exhaustedBudget = structuredClone(broken);
  exhaustedBudget.id = "episode-drift-exhausted-budget";
  exhaustedBudget.experience.budgetEvidence = {
    ...budgetEvidence,
    activeElapsedMs: budgetEvidence.activeLimitMs,
    exhaustedReason: "active-time",
  };
  const noBudgetLeft = compiler.compileEpisode({ release, candidates: [], session: session() }, exhaustedBudget);
  assert.equal(noBudgetLeft.directive.type, "complete", "drift repair must stop when the inherited budget is exhausted");

  for (const [mode, code] of [
    ["adaptive", "adaptive_timeout"],
    ["adaptive", "page_agent_budget_exhausted"],
    ["adaptive", "no_progress"],
    ["adaptive", "cancelled"],
    ["adaptive", "side_effect_unknown"],
    ["compiled", "runtime_error"],
  ]) {
    const generic = episode(protocol, mode, { status: "execution-fault", code, summary: "失败" });
    generic.capabilityId = learned.capability.id;
    const terminal = compiler.compileEpisode({ release, candidates: [], session: session() }, generic);
    assert.equal(terminal.directive.type, "complete");
    assert.equal(terminal.session.status, "failed");
  }
});

test("a failed independent replay stays outside the release and routes back to authoring", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const gate = await bundledModule("../lib/site-knowledge/release-gate.ts");
  const learned = candidate(protocol, { id: "home" }, { id: "result" });
  const job = { id: "validation-3", learningJobId: "learning-3", siteAgentId: "atlas", candidateId: learned.id, capabilityId: learned.capability.id, baseReleaseVersion: 0, status: "running", validationCase: { id: "case-3", name: "broken", input: { query: "耳机" }, inputSource: "observed", startUrl: "https://atlas.test/", expectedStatuses: ["success", "no-result", "business-rejection"], effect: "read-only" }, attempt: 0, maxAttempts: 2, createdAt: now, updatedAt: now };
  const run = { id: "run-3", learningJobId: "learning-3", validationJobId: job.id, siteAgentId: "atlas", candidateId: learned.id, runnerId: "runner-1", mode: "validate", status: "failed", browser: { name: "chromium", version: "1", headless: true }, startedAt: now, endedAt: now, startUrl: "https://atlas.test/", steps: [{ stepId: "step-wait", op: "waitForCondition", status: "failed", startedAt: now, endedAt: now }], outcome: { status: "execution-fault", code: "target_not_found", summary: "定位失败", evaluatedAt: now, evidence: {} } };
  const result = gate.evaluateBrowserRun(protocol.emptyRelease("atlas", now), learned, job, run);
  assert.equal(result.decision, "reject");
  assert.equal(result.release.version, 0);
  assert.equal(result.candidate.validation.status, "failed");
});

test("memory persistence excludes expired TaskSessions and merges duplicate observations idempotently", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const discovery = await bundledModule("../lib/site-knowledge/discovery.ts");
  const store = await bundledModule("../db/site-agent-store.ts");
  store.resetMemorySiteAgentStore();
  await store.createSiteAgent({ id: "atlas", url: "https://atlas.test/" });
  await store.createTaskSession(session());
  assert.equal((await store.getTaskSession("atlas", "task-1")).session.goal, "搜索商品");
  const observation = { id: "transition-1", siteAgentId: "atlas", sessionId: "browser-1", steps: [], elementEvidence: [], inputBindings: {}, outputBindings: {}, startedAt: now, endedAt: now };
  assert.equal((await store.appendObservations("atlas", [observation, observation])).accepted, 1);
  const fromSnapshot = snapshot("https://atlas.test/", "首页");
  const toSnapshot = { ...snapshot("https://atlas.test/city/beijing", "北京热搜"), documentId: "document-2" };
  const evidence = { tag: "a", role: "link", accessibleName: "北京热搜", href: toSnapshot.url, attributes: { href: toSnapshot.url }, cssPath: "a.city" };
  const target = discovery.targetFromObservedEvidence(evidence, "unknown", now);
  const before = (await store.getActiveSiteAgentRelease("atlas")).release;
  const learned = await store.appendObservations("atlas", [{
    ...observation, id: "transition-2", fromSnapshot, toSnapshot, elementEvidence: [evidence],
    steps: [{ id: "step-1", op: "click", targetId: target.id, timeoutMs: 8_000 }],
  }]);
  // A real navigation carrying an unseen page and an unseen element. It is stored as an
  // observation but **produces no knowledge**: site knowledge comes from crawling only.
  // This leak once gave one production site 38,710 releases and 31 GB of JSON — one
  // version per page navigation.
  assert.equal(learned.accepted, 1, "观察本身照常入库");
  assert.equal(learned.release.version, before.version, "但不发新版本");
  assert.equal(learned.release.scenes.length, before.scenes.length, "不从跳转里学场景");
  assert.equal((learned.release.operations || []).length, (before.operations || []).length, "也不学操作");
  assert.equal((await store.getSiteAgentOverview("atlas")).overview.activeSessions.length, 0);
  assert.equal(protocol.SITE_AGENT_SCHEMA_VERSION, "site-agent.v2");
});

test("knowledge search: a keyword LIST resolves a synonym miss the user's own wording would not", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const planner = await bundledModule("../lib/site-knowledge/planner.ts");
  const scene = (id, name, path) => ({
    id, name, urlTemplates: [{ id: "url-" + id, originPattern: "https://gap.test", pathnamePattern: path, query: {} }],
    parameters: [], verifier: {}, directEntry: "verified", evidenceStatus: "entry-verified", sourceObservationIds: [], updatedAt: now,
  });
  const release = { ...protocol.emptyRelease("gapsite", now), scenes: [scene("s-minor", "未成年保护", "/minor"), scene("s-terms", "服务条款", "/terms")] };
  // The user says 小孩; the scene is named 未成年. A single-string search misses it; the
  // agent-expanded keyword LIST (max over keywords) catches it — synonym handling lives
  // on the caller side, exactly as the search contract intends.
  assert.equal(planner.searchKnowledgeIndex(release, "小孩").scenes.length, 0, "user's own word misses");
  const list = planner.searchKnowledgeIndex(release, ["小孩", "未成年", "儿童"]);
  assert.ok(list.scenes.some((s) => s.id === "s-minor"), "keyword list catches the synonym scene");
  assert.equal(list.hasRoute, true);
});

test("usage-failure demotion moves a verified entry to needs-reverify without spawning a duplicate candidate", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const canonicalize = await bundledModule("../lib/site-knowledge/canonicalize.ts");
  const store = await bundledModule("../db/site-agent-store.ts");
  store.resetMemorySiteAgentStore();
  const entryUrl = "https://drift.test/";
  await store.createSiteAgent({ id: "drift-site", url: entryUrl });
  await store.recordSiteAgentConnection("drift-site", { origin: "https://drift.test", url: entryUrl, title: "Drift", heading: "Drift", snapshot: snapshot(entryUrl, "Drift") });
  // Seed a VERIFIED scene whose id is the production-derived id (scene_<hash of identity
  // origin:path> — the identity origin drops the http/https scheme, see siteIdentityOrigin),
  // so a re-landing that fails the verifier re-derives the SAME id and must merge, not duplicate.
  const sceneId = `scene_${protocol.stableHash("drift.test:/methodology")}`;
  const memoryAgent = globalThis.__SITEWAKE_SITE_AGENT_V2__.get("drift-site");
  memoryAgent.release.scenes = [{
    id: sceneId, name: "方法论", semanticSource: "ai",
    urlTemplates: [{ id: "url-methodology", originPattern: "https://drift.test", pathnamePattern: "/methodology", query: {} }],
    parameters: [], verifier: { headingIncludes: ["方法论"] },
    directEntry: "verified", evidenceStatus: "entry-verified", lastVerifiedAt: now,
    entryHealth: { successes: 3, failures: 0, failStreak: 0, lastOkAt: now },
    sourceObservationIds: [], updatedAt: now,
  }];
  // Two real landings that fail the entry verifier (heading no longer says 方法论).
  const failSnapshot = { ...snapshot("https://drift.test/methodology", "系统维护中"), documentId: "document-fail" };
  const toScene = { sceneId, url: failSnapshot.url, bindings: {}, confidence: 0.9, observedAt: now };
  const base = { siteAgentId: "drift-site", sessionId: "browser-1", steps: [], elementEvidence: [], inputBindings: {}, outputBindings: {}, startedAt: now, endedAt: now, toScene, toSnapshot: failSnapshot };
  const learned = await store.appendObservations("drift-site", [
    { ...base, id: "drift-fail-1" },
    { ...base, id: "drift-fail-2" },
  ]);
  const methodologyScenes = learned.release.scenes.filter((scene) => scene.urlTemplates.some((template) => template.pathnamePattern === "/methodology"));
  assert.equal(methodologyScenes.length, 1, "no parallel candidate scene for the same page");
  const demoted = methodologyScenes[0];
  assert.equal(demoted.id, sceneId);
  assert.equal(demoted.directEntry, "needs-reverify");
  assert.equal(demoted.evidenceStatus, "observed");
  assert.equal(demoted.entryHealth.failStreak, 2);
  assert.equal(typeof demoted.demotedAt, "string");
  // The demotion is written to the release, but every read/slim runs through
  // canonicalizeReleaseKnowledge (KB extraction). It must NOT collapse needs-reverify
  // back to candidate, or resurrect entry-verified from the stale lifecycle — that was
  // the production bug the raw releaseFromObservations test above did not catch.
  const canonical = canonicalize.canonicalizeReleaseKnowledge(learned.release);
  const canonScene = canonical.scenes.find((scene) => scene.urlTemplates.some((template) => template.pathnamePattern === "/methodology"));
  assert.equal(canonScene.directEntry, "needs-reverify", "canonicalization keeps the demotion");
  assert.notEqual(canonScene.evidenceStatus, "entry-verified", "canonicalization does not resurrect entry-verified");
});

test("a site served over both http and https is ONE site, not a parallel unvisited copy", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const canonicalize = await bundledModule("../lib/site-knowledge/canonicalize.ts");
  const discovery = await bundledModule("../lib/site-knowledge/discovery.ts");
  const topology = await bundledModule("../lib/site-knowledge/business-topology.ts");
  // Production shape (a real production site): the site answers on plaintext WITHOUT redirecting, so a
  // minority of sessions land on http. Scene identity used to carry the scheme, so every such
  // session minted a twin of the whole map from the page's own nav — twins no entry probe could
  // ever reach (matchUrlTemplate rejected the other scheme), so they sat at "referenced" forever
  // and the console reported 15 areas of "link candidate · awaiting real visit" for pages already verified.
  const verified = {
    id: `scene_${protocol.stableHash("mixed.test:/about")}`, name: "关于平台", semanticSource: "ai", businessArea: "平台治理",
    evidenceStatus: "entry-verified", lifecycle: "entry-verified", identityConfidence: .95,
    evidence: { linkLabels: [], observedUrls: ["https://mixed.test/about"], titles: ["关于"], headings: ["关于"] },
    urlTemplates: [{ id: "url-about", originPattern: "https://mixed.test", pathnamePattern: "/about", query: {} }],
    parameters: [], verifier: {}, directEntry: "verified", origin: "crawl", origins: ["crawl"],
    sourceObservationIds: [], updatedAt: now,
  };

  // 1. A plaintext landing that links to /about reuses the https Scene instead of minting a twin.
  const plaintext = snapshot("http://mixed.test/", "热搜时光机");
  plaintext.links = [{ text: "关于我们", url: "http://mixed.test/about" }];
  const discovered = discovery.discoverInitialKnowledge(plaintext, [verified]);
  const aboutScenes = discovered.scenes.filter((scene) => scene.urlTemplates.some((template) => template.pathnamePattern === "/about"));
  assert.equal(aboutScenes.length, 1, "the plaintext twin of a known page is the same Scene");
  assert.equal(aboutScenes[0].id, verified.id);
  assert.equal(aboutScenes[0].evidenceStatus, "entry-verified", "a link sighting never demotes proven evidence");

  // 2. A release that ALREADY carries both twins collapses on read — no re-crawl, no migration.
  const release = protocol.emptyRelease("mixed", now);
  release.scenes = [verified, {
    id: "scene-about-plaintext", name: "关于我们", semanticSource: "program",
    evidenceStatus: "referenced", lifecycle: "referenced", identityConfidence: .72,
    evidence: { linkLabels: ["关于我们"], observedUrls: [], titles: [], headings: [] },
    urlTemplates: [{ id: "url-about-plaintext", originPattern: "http://mixed.test", pathnamePattern: "/about", query: {} }],
    parameters: [], verifier: {}, directEntry: "candidate", sourceObservationIds: [], updatedAt: now,
  }];
  const canonical = canonicalize.canonicalizeReleaseKnowledge(release);
  assert.equal(canonical.scenes.length, 1, "http/https twins are one canonical Scene");
  assert.equal(canonical.scenes[0].evidenceStatus, "entry-verified");
  assert.equal(canonical.scenes[0].directEntry, "verified");
  assert.equal(
    canonical.scenes[0].urlTemplates[0].originPattern,
    "https://mixed.test",
    "the merged Scene is addressed by the origin we actually reached, never the unproven twin",
  );

  // 3. So the console stops reporting a verified page as waiting for its first real visit.
  const model = topology.buildBusinessTopology(canonical);
  assert.equal(model.stats.referencedScenes, 0);
  assert.equal(model.nodes.filter((node) => node.evidenceStatus === "referenced").length, 0);
});

test("control-plane overview projects episode summaries instead of parsing and returning full page evidence", async () => {
  const store = await readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8");
  const listRoute = await readFile(new URL("../app/api/site-agents/route.ts", import.meta.url), "utf8");
  assert.match(store, /json_extract\(episode_json, '\$\.outcome'\)/);
  assert.match(store, /episodeSummaryFromRow/);
  assert.match(store, /episodeById/);
  assert.match(store, /expires_at > \?/);
  assert.match(store, /json_array_length\(r\.release_json, '\$\.scenes'\)/);
  assert.match(store, /siteAgentListCache/);
  assert.match(store, /database\.withSession\?\.\(\)/);
  assert.doesNotMatch(store, /SELECT a\.id, a\.profile_json AS profileJson, a\.updated_at AS updatedAt, r\.release_json AS releaseJson/);
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const release = protocol.emptyRelease("lightweight", now);
  assert.equal(release.schemaVersion, "site-agent.v2");
});

test("sandbox SiteAgents stay out of the production website list", async () => {
  const store = await bundledModule("../db/site-agent-store.ts");
  store.resetMemorySiteAgentStore();
  const productSnapshot = snapshot("https://product.test/", "Product");
  productSnapshot.links = [{ href: "https://product.test/catalog", text: "Catalog" }];
  await store.createSiteAgent({ id: "production-site", url: "https://product.test/" });
  await store.createSiteAgent({ id: "sandbox-site", url: "https://sandbox.test/", visibility: "sandbox" });
  const production = await store.recordSiteAgentConnection("production-site", {
    origin: "https://product.test", url: "https://product.test/", title: "Product", heading: "Product", snapshot: productSnapshot, visibility: "production",
  });
  await store.recordSiteAgentConnection("sandbox-site", {
    origin: "https://sandbox.test", url: "https://sandbox.test/", title: "Sandbox", heading: "Sandbox", snapshot: snapshot("https://sandbox.test/", "Sandbox"), visibility: "sandbox",
  });
  assert.deepEqual(production.release.profile.suggestedGoals, [], "first connection links do not become task suggestions");
  const listed = await store.listSiteAgents();
  assert.deepEqual(listed.agents.map((agent) => agent.id), ["production-site"]);
});

test("挂件连接只登记连接事实，不再产生知识", async () => {
  // Site knowledge has one source: crawling. Connections used to learn page structure
  // from real visits and publish versions along the way — hence "one crawl, several
  // versions". Now they only record who connected and when.
  const store = await bundledModule("../db/site-agent-store.ts");
  store.resetMemorySiteAgentStore();
  const page = snapshot("https://demo.test/search?q=flight", "search详情");
  await store.createSiteAgent({ id: "reviewed", url: "https://demo.test/" });
  const before = await store.getActiveSiteAgentRelease("reviewed");
  const result = await store.recordSiteAgentConnection("reviewed", {
    origin: "https://demo.test", url: page.url, title: page.title, heading: page.heading, snapshot: page,
  });
  assert.equal(result.connection.url, page.url, "连接事实要记下来");
  assert.equal(result.release.version, before.release.version, "连接不得推进知识库版本");
  assert.deepEqual(result.release.scenes, before.release.scenes, "连接不得改动页面结构");
});

test("D1 schema is isolated under site_agent_v2 tables and leaves v1 untouched", async () => {
  const schema = await readFile(new URL("../db/site-agent-schema.ts", import.meta.url), "utf8");
  for (const table of ["agents", "connections", "releases", "sessions", "observations", "episodes", "candidates", "learning_jobs"]) assert.match(schema, new RegExp(`site_agent_v2_${table}`));
  // simplify-knowledge-search removed the answer-route / knowledge-gap tables: new
  // deployments must NOT create them (existing rows are left untouched, not migrated).
  for (const table of ["answer_routes", "knowledge_gaps", "gap_verdicts"]) {
    assert.doesNotMatch(schema, new RegExp(`CREATE TABLE IF NOT EXISTS site_agent_v2_${table}`), `${table} must not be created`);
  }
  assert.doesNotMatch(schema, /site_agent_v2_knowledge_review_jobs/); // review is a step of the crawl, no queue table
  assert.match(schema, /site_agent_v2_crawl_jobs/);
  assert.match(schema, /site_agent_v2_knowledge \(/);
  for (const table of ["capability_projects", "capability_revisions", "capability_events", "authoring_guidance", "task_launches", "navigation_build_heads", "capability_runs", "model_invocations", "capability_signals", "capability_rfcs", "codex_authoring_events", "contract_proposals", "capability_spec_docs", "authoring_workspaces", "runner_pools", "runner_instances", "runner_placement_bindings", "runner_leases", "capability_suppressions"]) assert.match(schema, new RegExp(`site_agent_v2_${table}`));
  assert.doesNotMatch(schema, /DROP TABLE/);
  assert.doesNotMatch(schema, /DELETE FROM site_agent_v2_(?:learning_jobs|validation_jobs|candidates)/);
  for (const [, table] of schema.matchAll(/ALTER TABLE(?:\s+IF\s+EXISTS)?\s+([A-Za-z0-9_]+)/g)) {
    assert.match(table, /^site_agent_v[23]_/, `schema migration must not alter a v1 table: ${table}`);
  }
});

test("a pre-metadata D1 database runs the v2 storage migration instead of failing the release API", async () => {
  const schema = await bundledModule("../db/site-agent-schema.ts");
  let batches = 0;
  let statementCount = 0;
  const database = {
    prepare(sql) {
      return {
        sql,
        async all() {
          // A v2 database that predates the metadata table. D1 throws for a
          // missing table instead of returning `success: false`, and that one
          // probe failure is the migration signal; every other read answers
          // normally, as it would on a real pre-metadata database.
          if (/site_agent_v2_meta/.test(sql)) throw new Error("D1_ERROR: no such table: site_agent_v2_meta: SQLITE_ERROR");
          return { success: true, results: [] };
        },
        async run() { return { success: true }; },
        async first() { return null; },
      };
    },
    async batch(statements) {
      batches += 1;
      statementCount += statements.length;
      return statements.map(() => ({ success: true }));
    },
  };
  await schema.ensureSiteAgentV2Schema(database);
  assert.ok(batches >= 1, "a missing metadata table migrates instead of failing the release API");
  assert.ok(statementCount > 1, "the migration is the schema, not a single statement");
});

test("the one-line SDK exposes the public API, ships as exactly two artifacts, and keeps PageAgent cold", async () => {
  const client = await readFile(new URL("../public/sitewake.js", import.meta.url), "utf8");
  const adaptive = await readFile(new URL("../public/sitewake-adaptive.js", import.meta.url), "utf8");
  for (const method of ["open", "run", "call", "teach", "cancel", "getRelease"]) assert.match(client, new RegExp(method));
  assert.match(client, /SiteWake/);
  assert.doesNotMatch(client, /Deprecated/);
  assert.doesNotMatch(client, /PageAgent|@page-agent\/core|MarketLens|Atlas Market|热搜时光机/);
  assert.match(adaptive, /PageAgent|page-agent/i);
  const { readdir } = await import("node:fs/promises");
  const artifacts = (await readdir(new URL("../public/", import.meta.url))).filter((name) => name.endsWith(".js")).sort();
  assert.deepEqual(artifacts, ["sitewake-adaptive.js", "sitewake.js"]);
});

test("page Agent customization is release-driven and does not expose arbitrary CSS or JS", async () => {
  const client = await readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/site-agents/[siteAgentId]/route.ts", import.meta.url), "utf8");
  const consoleSource = await consoleSources();
  assert.match(client, /getRelease\(\)\.agentConfig|agentConfig/);
  assert.match(source_client_user_agent_styles_ts, /data-preset/);
  assert.match(client, /dock/);
  assert.match(source_app_globals_css, /minimal/);
  assert.match(client, /sw-logo-shape/);
  assert.match(client, /showTeachAfterFailure/);
  assert.match(route, /export async function PATCH/);
  assert.match(route, /agentConfig/);
  // The editor's own copy lives in a dictionary rather than inline: both
  // languages are in lib/console/product-copy.ts and the editor reads them
  // through `productCopy(locale)`. Wiring breaks in the component, wording
  // breaks in the module — changing copy does not false-alarm.
  assert.match(consoleSource, /const ui = productCopy\(locale\)/);
  assert.match(consoleSource, /<h2>\{ui\.identity\}<\/h2>/);
  assert.match(consoleSource, /\{ui\.restore\}/, "restoring the automatic values is a dictionary label");
  assert.match(consoleSource, /ui\.apply\b/);
  const productCopySource = await readFile(new URL("../lib/console/product-copy.ts", import.meta.url), "utf8");
  assert.match(productCopySource, /identity: "名称与欢迎语"/);
  assert.match(productCopySource, /identity: "Name and welcome"/);
  assert.match(productCopySource, /restore: "恢复默认"/);
  // Attribution is not a setting: the dictionary says so and the editor offers
  // no control for it.
  assert.match(consoleCopyZh, /noWhitelabel: "开源版本固定保留/);
  assert.match(consoleSource, /AGENT_PALETTES/);
  // The attribution appears in the preview because a visitor sees it there. What
  // must not exist is a way to change it: the editor writes only `overrides` and
  // `appearance`, and normalization sets the attribution from a constant.
  assert.match(consoleSource, /<small>\{chrome\.poweredByText\}<\/small>/, "the preview shows what a visitor sees");
  assert.doesNotMatch(consoleSource, /poweredByText[^}\n]{0,60}(?:onChange|value=|<input)/i);
  assert.match(src_lib_site_knowledge_protocol_ts, /poweredByText: POWERED_BY/, "the attribution is a constant, not a field");
  assert.doesNotMatch(consoleSource, /底部署名|主色<input|头像字符/);
  assert.doesNotMatch(consoleSource, /customCss|customJS|dangerouslySetInnerHTML/);
});

test("page experience is a user task assistant and only offers demonstration after failure", async () => {
  const client = await readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8");
  const port = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  // The copy is in the widget dictionary; no literals in source. Wiring breaks in the
  // component, literals break in the dictionary — changing copy does not false-alarm,
  // deleting a key or breaking the wiring does.
  for (const key of ["empty.title", "empty.body", "action.demonstrate", "composer.poweredBy"]) {
    const [group, name] = key.split(".");
    assert.match(client, new RegExp(`copy\\.${group}\\.${name}|chrome\\.\\w+`), `${key} 必须来自词表`);
  }
  const widgetCatalog = await readFile(new URL("../client/user-agent-copy.ts", import.meta.url), "utf8");
  for (const label of ["今天想在这个网站完成什么", "直接说出目标", "我操作一次给你看", "由 SiteWake 提供"]) {
    assert.match(widgetCatalog, new RegExp(label));
  }
  assert.doesNotMatch(client, /让 AI 完成|已学会 · 直接执行|项可复用能力|目标.*完成.*验证.*可复用/s);
  assert.match(client, /sessionStorage\.setItem\(storageKey/);
  assert.match(client, /sitewake-adaptive\.js/);
  assert.match(client, /dataset\.allowFrame/);
  assert.match(port, /demonstrationKey/);
  assert.match(port, /restoreDemonstration/);
  assert.match(port, /taskResult/);
  assert.match(port, /executable capability[\s\S]*must never start from that cache/);
  assert.match(port, /void connectionPromise/);
  assert.doesNotMatch(port, /Promise\.allSettled\(\[releaseRequest, connectionRequest/);
});

test("published suggestions preserve Capability identity and runtime navigation preserves the live Origin", async () => {
  const [client, port] = await Promise.all([
    readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8"),
  ]);
  // The widget no longer surfaces capabilities as shortcuts: a suggestion is
  // the site owner's prompt, sent as typed; a typed request goes to the Agent
  // as typed. Neither path matches a capability name in the client.
  assert.match(client, /kind: "prompt" \}\);\s*input\.value = text; void submitGoal\(text\);/);
  assert.match(client, /await activePort\.run\(value, \{\}, conversation\)/);
  assert.doesNotMatch(client, /if \(known\) \{/);
  assert.doesNotMatch(client, /data-capability-version/);
  assert.match(port, /buildSceneUrl\(scene, bindings, location\.origin\)/);
  assert.match(port, /buildSceneUrl\(entry, bindings, location\.origin\)/);
});

test("direct conversation renders only real tool calls and never becomes learning evidence", async () => {
  const [client, port] = await Promise.all([
    readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8"),
  ]);
  assert.match(port, /interaction: "conversation"/);
  assert.match(port, /presentation: "conversation"/);
  assert.match(port, /conversation_completed/);
  assert.doesNotMatch(port, /return this\.ingestEpisode\(episode, \{\}, "adaptive"\)/);
  assert.match(conversationSource, /item\.kind === "reasoning" \|\| item\.kind === "result"/);
  assert.match(client, /presentation === "conversation" \? copy\.status\.connected/);
});

test("natural language goals stay in one Agent loop and capability tools ask instead of launching a second binder", async () => {
  const client = await readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8");
  const port = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  const adaptive = await readFile(new URL("../client/user-agent-adaptive.ts", import.meta.url), "utf8");
  assert.match(port, /return await this\.runMainAgent\(session\)/);
  assert.match(port, /name: "operate_page"/);
  assert.match(port, /callCapability: async \(capabilityId, capabilityInput, adaptiveTrace\)/);
  assert.match(port, /const resolvedInput = \{ \.\.\.session\.input, \.\.\.capabilityInput \}/);
  assert.match(port, /Do not invoke a second "parameter binder" model/);
  assert.match(adaptive, /call_capability: tool/);
  assert.match(adaptive, /search_site_knowledge: tool/);
  assert.match(adaptive, /必须使用 ask_user 追问/);
  assert.match(client, /function askUser\(question/);
  assert.match(client, /onAskUser: askUser/);
  assert.match(client, /agent-question-options/);
  assert.match(adaptive, /choices: \[/);
  assert.match(adaptive, /aiHasTerminalDecision\(actor\)/);
});

test("PageAgent Runtime V2 hands off a structured brief and exposes bounded, user-controlled timeout recovery", async () => {
  const [port, client, requirement] = await Promise.all([
    readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8"),
    readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/site-knowledge/execution-requirement.ts", import.meta.url), "utf8"),
  ]);
  assert.match(port, /executionRequirementForGoal/);
  for (const kind of ["required", "uncertain", "not-required"]) assert.match(requirement, new RegExp(`kind: "${kind}"`));
  assert.match(port, /required: \["objective", "effect", "entities", "completionCriteria"\]/);
  assert.match(port, /pageExecutionBrief: brief, pageExecutionBudget: budget/);
  assert.match(port, /runtimeFeatures\?\.pageAgentRuntimeV2 === true/);
  assert.match(port, /runtimeFeatures\?\.pageAgentEvidenceV2 === true/);
  assert.match(port, /JSON\.stringify\(\{ siteAgentId: this\.options\.siteAgentId, observations: batch \}\)/);
  assert.match(port, /observationOutbox\.slice\(0, 4\)/);
  assert.match(port, /pageEpoch: this\.activeRun\?\.pageEpoch \|\| this\.runPointer\?\.pageEpoch \|\| 1/);
  assert.match(port, /executionRequirement\.kind !== "required"[\s\S]*\? "read-only" as const/);
  assert.match(port, /onBeforeNavigationAction: async \(\) => \{[\s\S]*await drainObservations\(\);[\s\S]*await this\.armNavigationIntent\(\)/);
  assert.match(port, /activeLimitMs: 30_000, modelRequestLimit: 2/);
  assert.match(port, /activeLimitMs: 90_000, modelRequestLimit: 5/);
  assert.match(port, /async reconcile\(/);
  assert.match(port, /async continueAfterConfirmation\(/);
  assert.match(port, /type ReconciliationStatus = "completed" \| "not-completed" \| "unknown"/);
  assert.match(port, /status: "unknown", code: "reconciliation_unknown"/);
  assert.match(port, /status: "no-result", code: "reconciliation_not_completed"/);
  assert.match(port, /page_execution_followup_already_used/);
  assert.match(port, /sessionStorage\.setItem\(key/);
  assert.match(port, /requireAgentRunToken\(sourceTaskId\)/);
  assert.match(port, /grantConfirmedContinuation\(episode\.taskSessionId\)/);
  assert.match(port, /consumeConfirmedContinuationGrant\(sourceTaskId\)/);
  assert.match(client, /copy\.action\.verify/);
  assert.match(client, /copy\.action\.confirm/);
  assert.match(client, /reconciliationStatus === "not-completed" \? \["continue-confirmed"\] : undefined/);
  assert.doesNotMatch(client, /outcome: "execution-fault", actions: \["continue-confirmed"\]/);
  assert.match(client, /recoverablePageExecutionUncertainty/);
  for (const marker of ["adaptive_timeout", "budget_exhausted", "no-progress", "side_effect_unknown"]) assert.match(client, new RegExp(marker));
  assert.match(port, /backgroundCapabilityExperience && !serverOwnsExperienceOutbox && !executionIntent/);
  assert.match(port, /episode\.outcome\.status === "success" \|\| episode\.outcome\.status === "no-result"/);
  assert.doesNotMatch(client, /adaptive_timeout[^\n]+你可以重试/);
});

test("PageAgent V2 fails closed when observation or Episode persistence is not acknowledged", async () => {
  const port = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  const drainStart = port.indexOf("const drainObservations = async () => {");
  const drainEnd = port.indexOf("const result = await adaptive.run({", drainStart);
  assert.ok(drainStart >= 0 && drainEnd > drainStart);
  const drain = port.slice(drainStart, drainEnd);
  const observationRequest = drain.indexOf("fetchWithTimeout(");
  const acknowledgedDequeue = drain.indexOf("observationOutbox.splice(0, batch.length)");
  assert.ok(observationRequest >= 0 && acknowledgedDequeue > observationRequest, "observations leave the queue only after an acknowledged request");
  assert.match(drain, /page-observations`\), \{[\s\S]*\}, 10_000\)/);
  assert.match(drain, /if \(!response\.ok\) throw new Error\(`page_observation_persist_failed:/);
  assert.doesNotMatch(drain, /observationOutbox\.unshift/);

  const ingestStart = port.indexOf("type EpisodeResponse =");
  const ingestEnd = port.indexOf("if (response.agentRun)", ingestStart);
  assert.ok(ingestStart >= 0 && ingestEnd > ingestStart);
  const ingest = port.slice(ingestStart, ingestEnd);
  assert.match(ingest, /backgroundCapabilityExperience \? 3 : 1/);
  assert.match(ingest, /request\.status === 429 \|\| request\.status >= 500/);
  assert.match(ingest, /"idempotency-key": episode\.id/);
  assert.match(ingest, /code: "episode_persistence_failed"/);
  assert.match(ingest, /return taskResult/);
  assert.doesNotMatch(ingest, /this\.finishRun\(/);
  assert.doesNotMatch(ingest, /this\.releaseLease\(/);

  const persistedGrant = port.slice(ingestEnd, port.indexOf("const directive = response.directive", ingestEnd));
  assert.match(persistedGrant, /reconciliationAuthority\.status === "not-completed"[\s\S]*reconciliationAuthority\.episodeId === episode\.id[\s\S]*grantConfirmedContinuation\(episode\.taskSessionId\)/);
  const adaptiveTerminal = port.slice(port.indexOf("const reconciliationStatus = executionIntent"), port.indexOf("private async runExecutionFollowup"));
  assert.doesNotMatch(adaptiveTerminal, /grantConfirmedContinuation/);
});

test("published capability fast path keeps the run token until Episode append", async () => {
  const port = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  const start = port.indexOf("const publishedFastPath =");
  const end = port.indexOf("return { success, mode, text: responseText", start);
  assert.ok(start >= 0 && end > start);
  const fastPath = port.slice(start, end);
  assert.match(fastPath, /let episodeRunToken: string \| undefined/);
  assert.match(fastPath, /episodeRunToken = this\.requireAgentRunToken\(episode\.taskSessionId\)/);
  assert.match(fastPath, /authorization: `Bearer \$\{episodeRunToken\}`/);
  assert.match(fastPath, /"idempotency-key": episode\.id/);
  assert.match(fastPath, /\.finally\(\(\) => this\.releaseLease\(episode\.taskSessionId\)\)/);
  assert.doesNotMatch(fastPath.slice(0, fastPath.indexOf("let episodeRunToken")), /this\.releaseLease\(/);
});

test("code-owned PageAgent execution requirement distinguishes required, uncertain, and not-required goals", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  let port;
  try { port = await bundledModule("../client/user-agent-port.ts"); }
  finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  assert.deepEqual(
    { ...port.executionRequirementForGoal("search for headphones"), reasons: [] },
    { kind: "required", effect: "read", evidence: "page-action", reasons: [] },
  );
  assert.equal(port.executionRequirementForGoal("buy these headphones").effect, "irreversible-write");
  assert.equal(port.executionRequirementForGoal("how can I buy these headphones?").kind, "not-required");
  assert.equal(port.executionRequirementForGoal("check this page").kind, "uncertain");
  assert.deepEqual(
    { ...port.executionRequirementForGoal("打开棕色笔记本商品详情页"), reasons: [] },
    { kind: "required", effect: "read", evidence: "page-action", reasons: [] },
    "dynamic product arrival is a live read/navigation action, not a capability write",
  );
  assert.equal(port.executionRequirementForGoal("帮我查看关于我们").kind, "required", "static page wording can still use a knowledge/page navigation path");
  for (const goal of ["把这里的商品按销量从高到低排一下", "把商品按价格从低到高排个序"]) {
    assert.equal(port.executionRequirementForGoal(goal).kind, "required", goal);
    assert.equal(port.executionRequirementForGoal(goal).effect, "read", goal);
    assert.equal(port.executionRequirementForGoal(goal).evidence, "page-action", goal);
  }
  assert.equal(port.executionRequirementForGoal("tell me a joke").kind, "not-required");
});

test("published capability receipts get a lightweight final response and a structured client surface", async () => {
  const client = await readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8");
  const adaptive = await readFile(new URL("../client/user-agent-adaptive.ts", import.meta.url), "utf8");
  const port = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  assert.match(adaptive, /receiptCompletionOnly/);
  assert.match(adaptive, /不得再次观察或操作页面/);
  assert.match(adaptive, /receiptNeedsPageEvidence \|\| !completionReceipt/);
  assert.match(adaptive, /dataset\.sitewakePointer/);
  assert.match(client, /function renderMarkdown/);
  assert.match(client, /progress\.classList\.remove\("show"\)/);
  assert.match(port, /formatDirectCapabilityResponse/);
  assert.match(port, /metadataFields = new Set\(\["pageUrl", "pageTitle", "pageHeading", "sceneId"\]\)/);
});

test("page Agent renders GFM tables safely, including sparse model formatting", async () => {
  const client = await readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8");
  assert.match(client, /function splitMarkdownTableRow/);
  assert.match(client, /function appendMarkdownTable/);
  assert.match(client, /dividerIndex < lines\.length/);
  assert.match(client, /markdown-table-wrap/);
  assert.match(client, /document\.createElement\("table"\)/);
  assert.doesNotMatch(client, /innerHTML\s*=\s*source/);
});

test("public runtime model and evidence ingestion require one bounded AgentRun authority", async () => {
  const [modelRoute, episodeRoute, replayRoute, port, adaptive, recorder, client, judge] = await Promise.all([
    readFile(new URL("../app/api/site-agents/[siteAgentId]/model/v2/chat/completions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/site-agents/[siteAgentId]/episodes/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/site-agents/[siteAgentId]/dom-replay/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8"),
    readFile(new URL("../client/user-agent-adaptive.ts", import.meta.url), "utf8"),
    readFile(new URL("../client/user-agent-recorder.ts", import.meta.url), "utf8"),
    readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../client/user-agent-judge.ts", import.meta.url), "utf8"),
  ]);

  assert.match(modelRoute, /getSiteAgentRunByToken\(siteAgentId, token,/);
  assert.match(modelRoute, /readBoundedJson\(request, MAX_MODEL_REQUEST_BYTES\)/);
  // The budget is accounted per authenticated run and registers the upstream abort handle (a retry of the same run supersedes the zombie call, see runtime-model-budget).
  assert.match(modelRoute, /acquireRuntimeModelBudget\(\{\s*siteAgentId,\s*runId: authenticatedRunId,\s*abort: \(\) => \{ superseded = true; controller\.abort\(\); \},\s*\}\)/);
  assert.match(modelRoute, /model_rate_limited/);
  assert.match(episodeRoute, /if \(!token\).*agent_run_token_required/);
  assert.match(episodeRoute, /authorizeAgentRunEpisode\(episode\.taskSessionId, token, episode\)/);
  assert.doesNotMatch(episodeRoute, /token\s*\?\s*await authorizeAgentRunEpisode/);
  assert.match(episodeRoute, /readBoundedJson\(request, MAX_EPISODE_REQUEST_BYTES\)/);
  assert.match(replayRoute, /getSiteAgentRunByToken\(siteAgentId, token,/);
  assert.match(replayRoute, /chunk\.runId !== authenticatedRunId/);
  assert.match(replayRoute, /readBoundedJson<[^>]+>\(request, MAX_DOM_REPLAY_REQUEST_BYTES\)/);

  for (const source of [port, judge, recorder]) {
    assert.match(source, /authorization:\s*`Bearer \$\{/);
  }
  assert.match(adaptive, /apiKey:\s*options\.agentRunToken/);
  assert.match(adaptive, /options\.domReplay\s*\?\s*startDomReplayRecorder/);
  assert.match(adaptive, /runtime_read_only_click_forbidden/);
  assert.match(adaptive, /runtime_read_only_fill_forbidden/);
  assert.match(port, /runtime_read_only_capability_forbidden/);
  assert.match(port, /assertRuntimeActionAllowed\(this\.options\.runtimeMode, op\)/);
  assert.match(port, /runtime_read_only_module_forbidden/);
  assert.match(port, /assertRuntimeTeachingAllowed\(this\.options\.runtimeMode\)/);
  assert.match(port, /passiveObservationAllowed\(\)/);
  assert.match(client, /domReplay:\s*script\?\.dataset\.domReplay === "true"/);
  assert.match(client, /runtimeMode:\s*\(script\?\.dataset\.runtimeMode === "read-only"/);
  assert.match(client, /dispatchState\("booting"\)/);
  assert.match(client, /dispatchState\("ready"/);
  assert.match(modelRoute, /withStreamLifecycle\(response\.body/);
  assert.match(modelRoute, /if \(!budgetOwnedByStream\) budget\.release\(\)/);
  assert.doesNotMatch(recorder, /navigator\.sendBeacon/);
});

test("business outcomes are parsed as independent Judge decisions without keyword heuristics", async () => {
  const outcome = await bundledModule("../lib/site-knowledge/task-outcome.ts");
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const decision = outcome.parseTaskOutcomeDecision({
    status: "success", code: "topic_opened", summary: "已打开第一条热搜。", confidence: 0.94,
    evidence: ["URL 出现 topic 参数", "页面主标题切换到目标话题"], missingEvidence: [],
  });
  assert.equal(decision.status, "success");
  assert.equal(decision.source, "judge");
  const before = snapshot("https://demo.test/", "热搜时光机");
  before.visibleText = "首页\n实时热搜\n日榜\n词云";
  const after = snapshot("https://demo.test/daily", "每日热搜归档");
  after.visibleText = "每日热搜归档\n2026年07月15日微博热搜榜\n全天热点一览";
  const evidence = outcome.buildTaskJudgeEvidence({ goal: "查看每日热搜榜", values: {}, actorSuccess: true, actorText: "已打开日榜", start: before, end: after, steps: [{ id: "s1", op: "click", targetId: "日榜", timeoutMs: 1000 }] });
  assert.equal(evidence.highlights.afterUrlPath, "/daily");
  assert.equal(evidence.highlights.afterMatchedSnippets.some((item) => item.includes("每日热搜")), true);
  assert.equal(evidence.facts.urlChanged, true);
  assert.equal(protocol.normalizeGoal(evidence.goal).includes("每日"), true);
  const source = await readFile(new URL("../client/user-agent-shared.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /detectOutcome|noResultPatterns|rejectionPatterns|body\.innerText.*无法/);
});

test("model protocol adapter repairs flattened action envelopes from the requested schema", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/model-protocol.ts");
  const request = {
    tools: [{ type: "function", function: { name: "AgentOutput", parameters: { type: "object", properties: { action: { anyOf: [
      { type: "object", properties: { click_element_by_index: { type: "object", properties: { index: { type: "number" } }, required: ["index"] } }, required: ["click_element_by_index"] },
      { type: "object", properties: { input_text: { type: "object", properties: { index: { type: "number" }, text: { type: "string" } }, required: ["index", "text"] } }, required: ["input_text"] },
    ] } } } } }],
  };
  const response = { choices: [{ message: { tool_calls: [{ function: { name: "AgentOutput", arguments: JSON.stringify({ action: { index: 3 } }) } }] } }] };
  const normalized = protocol.normalizeAgentToolEnvelope(request, response);
  const args = JSON.parse(normalized.choices[0].message.tool_calls[0].function.arguments);
  assert.deepEqual(args.action, { click_element_by_index: { index: 3 } });
  const typed = { choices: [{ message: { tool_calls: [{ function: { name: "AgentOutput", arguments: JSON.stringify({ action: { type: "click", index: 8 } }) } }] } }] };
  const normalizedTyped = protocol.normalizeAgentToolEnvelope(request, typed);
  const typedArgs = JSON.parse(normalizedTyped.choices[0].message.tool_calls[0].function.arguments);
  assert.deepEqual(typedArgs.action, { click_element_by_index: { index: 8 } });
  const inputAlias = { choices: [{ message: { tool_calls: [{ function: { name: "AgentOutput", arguments: JSON.stringify({ action: { name: "type", index: 2, text: "周杰伦" } }) } }] } }] };
  const normalizedInput = protocol.normalizeAgentToolEnvelope(request, inputAlias);
  const inputArgs = JSON.parse(normalizedInput.choices[0].message.tool_calls[0].function.arguments);
  assert.deepEqual(inputArgs.action, { input_text: { index: 2, text: "周杰伦" } });
});

test("user tasks use one tool-using Agent while learning remains an asynchronous evidence side path", async () => {
  const adaptive = await readFile(new URL("../client/user-agent-adaptive.ts", import.meta.url), "utf8");
  const port = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  assert.doesNotMatch(adaptive, /judgeTaskOutcome|TaskOutcomeDecision|restore_early_judging/);
  assert.match(adaptive, /唯一负责理解目标、选择工具、操作页面和形成最终回答/);
  assert.match(adaptive, /search_site_knowledge/);
  assert.match(adaptive, /call_capability/);
  assert.match(adaptive, /toolReceipts/);
  assert.match(adaptive, /JSON\.stringify\(result\.data/);
  assert.match(adaptive, /禁止返回旧页面重新开始/);
  assert.match(adaptive, /resumeTrace/);
  assert.match(adaptive, /experience: evidencedExperience/);
  assert.match(port, /adaptiveTrace/);
  assert.match(port, /appendAdaptiveTrace/);
  assert.match(port, /learning-queued/);
  // The sentence moved to the widget catalog; the port now names the entry.
  assert.match(port, /say\.doneHandedToLearning/);
  const copy = await readFile(new URL("../client/user-agent-copy.ts", import.meta.url), "utf8");
  assert.match(copy, /这次经验已交给独立学习环境继续设计和验证/);
  assert.doesNotMatch(adaptive, /detectOutcome|inferDeterministicTaskOutcome/);
});

test("client Agent keeps task state across navigation and avoids uncontrolled new tabs", async () => {
  const client = await readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8");
  const port = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  const shared = await readFile(new URL("../client/user-agent-shared.ts", import.meta.url), "utf8");
  assert.match(client, /panelOpen/);
  assert.match(client, /mode\?: ExperienceMode/);
  assert.match(client, /setMode\(mode\)/);
  assert.match(port, /waiting-page-restore/);
  assert.match(port, /leaseKey/);
  assert.match(port, /acquireLease/);
  assert.match(port, /releaseLease/);
  assert.match(widgetCopySource, /已进入新页面，继续刚才的任务/);
  assert.match(shared, /window\.open =/);
  assert.match(shared, /target\.target = "_self"/);
});

test("successful user tasks never replay validation in the visible browser", async () => {
  const compiler = await readFile(new URL("../lib/site-knowledge/compiler.ts", import.meta.url), "utf8");
  const port = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/site-agents/[siteAgentId]/episodes/route.ts", import.meta.url), "utf8");
  // Stronger than it used to be: the compiler cannot start a validation at
  // all. It closes the Session and records evidence; an independent runner is
  // the only thing that replays anything, and never in the visitor's browser.
  assert.doesNotMatch(compiler, /learning-queued/);
  assert.match(compiler, /status: "completed"/);
  assert.doesNotMatch(port, /首份经验已编译，正在开始独立验证/);
  assert.match(port, /validation_requires_isolated_runner/);
  assert.doesNotMatch(route, /refineEpisodeSemantics/);
});

test("successful PageAgent work is saved as evidence and never compiled into the final program", async () => {
  const adaptive = await readFile(new URL("../client/user-agent-adaptive.ts", import.meta.url), "utf8");
  const analyzer = await readFile(new URL("../lib/site-knowledge/model-analyzer.ts", import.meta.url), "utf8");
  const compiler = await readFile(new URL("../lib/site-knowledge/compiler.ts", import.meta.url), "utf8");
  assert.match(adaptive, /PageAgent's accessibility serialization/);
  assert.match(adaptive, /ExperienceEvidenceBundle|actorSummary/);
  assert.doesNotMatch(adaptive, /compiledCandidate/);
  // The compiler used to mark the Candidate it built from a successful episode
  // "raw experience only", so that nothing downstream mistook it for a
  // program. It no longer builds one: experience reaches the capability centre
  // as a signal, and the program is authored there from scratch.
  assert.doesNotMatch(compiler, /rawExperienceOnly/);
  assert.doesNotMatch(compiler, /candidate_\$\{/, "the compiler mints no Candidate of its own");
  assert.match(compiler, /candidates: KnowledgeCandidate\[\]/, "it still carries the ones it was handed");
  assert.match(analyzer, /一次用户成功路径只是证据，不等于通用函数/);
  assert.match(analyzer, /requiredInputs/);
  assert.match(analyzer, /normalizedGoal: normalizeGoal\(goalTemplate/);
  assert.match(analyzer, /必须生成 rank:number 输入/);
  assert.match(analyzer, /deriveValidationInputFromEvidence/);
  assert.match(analyzer, /只允许逐字来自 evidence 的替代值/);
});

test("capability evolution prefers reusable functions with useful structured results", async () => {
  const analyzerModule = await bundledModule("../lib/site-knowledge/model-analyzer.ts");
  const analyzer = await readFile(new URL("../lib/site-knowledge/model-analyzer.ts", import.meta.url), "utf8");
  const compiler = await readFile(new URL("../lib/site-knowledge/compiler.ts", import.meta.url), "utf8");
  const runner = await readFile(new URL("../runner/browser-runner.ts", import.meta.url), "utf8");
  const port = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  const gate = await readFile(new URL("../lib/site-knowledge/release-gate.ts", import.meta.url), "utf8");
  assert.equal(analyzerModule.inferResultArchetype("按日期查看热搜日榜"), "ranking");
  assert.equal(analyzerModule.inferResultArchetype("搜索周杰伦的热搜"), "search");
  assert.equal(analyzerModule.inferResultArchetype("打开帮助中心"), "navigation");
  assert.match(analyzer, /禁止为每次用户回答线性新增函数/);
  assert.match(analyzer, /importance=core\|optional/);
  assert.match(analyzer, /resultArchetype/);
  assert.match(analyzer, /inferredArchetype !== "navigation"/);
  assert.match(analyzer, /\["pageUrl", "pageTitle", "pageHeading"\]\.includes\(id\)/);
  assert.match(compiler, /reusableCapability && \["success", "no-result", "business-rejection"\]/);
  assert.doesNotMatch(compiler, /enhancementSignal/);
  assert.doesNotMatch(runner, /extractList/);
  assert.match(port, /missingOutputFields\.length === 0/);
  assert.match(gate, /importance !== "optional"/);
});

test("capability suppression blocks the same parameterized intent without blocking unrelated work", async () => {
  const suppression = await bundledModule("../lib/site-knowledge/capability-suppression.ts");
  const policy = {
    id: "suppression_search_product",
    siteAgentId: "atlas",
    projectId: "project_search",
    sourceCapabilityId: "capability_search",
    intentKey: "search_product",
    intentFingerprint: "fingerprint",
    name: "搜索商品",
    goalTemplate: "搜索 {keyword} 商品",
    aliases: ["查找商品"],
    normalizedPatterns: ["搜索商品", "搜索 keyword 商品", "查找商品"],
    reason: "管理员已下架",
    createdBy: "administrator",
    scope: "auto-generation",
    status: "active",
    policyVersion: 1,
    createdAt: "2026-07-26T00:00:00.000Z",
  };
  assert.equal(suppression.matchingCapabilitySuppression([policy], "搜索红色沙发商品")?.id, policy.id);
  assert.equal(suppression.matchingCapabilitySuppression([policy], "查找商品")?.id, policy.id);
  assert.equal(suppression.matchingCapabilitySuppression([policy], "搜索订单"), undefined);
  assert.equal(suppression.matchingCapabilitySuppression([{
    ...policy,
    id: "suppression-generic-search",
    goalTemplate: "搜索 {keyword}",
    normalizedPatterns: ["搜索 {keyword}"],
  }], "搜索订单"), undefined);
  assert.equal(suppression.matchingCapabilitySuppression([{
    ...policy,
    id: "suppression-generic-english-search",
    goalTemplate: "search {query}",
    normalizedPatterns: ["search {query}"],
  }], "search orders"), undefined);
  assert.equal(suppression.matchingCapabilitySuppression([{
    ...policy,
    id: "suppression-generic-detail",
    goalTemplate: "查看 {id} 详情",
    normalizedPatterns: ["查看 {id} 详情"],
  }], "查看订单详情"), undefined);
  assert.equal(suppression.matchingCapabilitySuppression([policy], "查看我的订单"), undefined);
  assert.equal(suppression.matchingCapabilitySuppression([{ ...policy, status: "revoked" }], "搜索台灯商品"), undefined);
});

test("capability origin, AI assessment, unpublish, and durable suppression are first-class", async () => {
  const protocol = await readFile(new URL("../lib/site-knowledge/protocol.ts", import.meta.url), "utf8");
  const compiler = await readFile(new URL("../lib/site-knowledge/compiler.ts", import.meta.url), "utf8");
  const store = await readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/site-agent-schema.ts", import.meta.url), "utf8");
  const center = await readFile(new URL("../components/capability-center-v1.tsx", import.meta.url), "utf8");
  assert.match(protocol, /CapabilityOrigin = "administrator" \| "ai-exploration" \| "knowledge-compiled" \| "user-triggered"/);
  assert.match(protocol, /CapabilityGenerator = "administrator" \| "ai" \| "user-demonstration" \| "program"/);
  assert.match(protocol, /CapabilityEvolutionAssessment/);
  // Who triggered a capability is decided where a project is projected, not
  // where an episode is compiled: the compiler no longer creates capabilities.
  const control = await readFile(new URL("../lib/site-knowledge/capability-control.ts", import.meta.url), "utf8");
  assert.match(control, /sourceEpisode\?\.mode === "author-request"\s*\n?\s*\? "administrator" as const/);
  assert.match(control, /\? "user-triggered"/);
  assert.match(store, /designCapabilityContract/);
  assert.match(store, /releaseWithSuppression/);
  assert.match(store, /capability_generation_suppressed/);
  assert.match(store, /authoring_guard:/);
  assert.match(store, /release_guard:/);
  assert.match(store, /uid\("release_operation"\)/);
  assert.match(store, /capability\.id === suppression\.sourceCapabilityId/);
  const analyzer = await readFile(new URL("../lib/site-knowledge/model-analyzer.ts", import.meta.url), "utf8");
  assert.match(analyzer, /strengthenedIntent/);
  assert.match(analyzer, /capabilityId\?: string/);
  assert.match(schema, /site_agent_v2_capability_suppressions/);
  assert.match(consoleCopyZh, /重新上架/);
  assert.match(src_db_site_agent_store_ts, /网站知识编译/);
  assert.doesNotMatch(center, /return project\.triggeredBy === "administrator" \? "管理员主动触发" : "AI 自动触发"/);
  const capabilityActions = await readFile(new URL("../app/api/site-agents/[siteAgentId]/capability-projects/[projectId]/actions/route.ts", import.meta.url), "utf8");
  const capabilityCollection = await readFile(new URL("../app/api/site-agents/[siteAgentId]/capability-projects/route.ts", import.meta.url), "utf8");
  const accessPolicy = await readFile(new URL("../lib/access-control/policy.ts", import.meta.url), "utf8");
  const clientPort = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  const capabilityCenterSource = await readFile(new URL("../components/capability-center-v1.tsx", import.meta.url), "utf8");
  // "AI analysis basis" was part of the retired `Runs` inspector. The evolution
  // assessment it displayed is still produced server-side and surfaced by the
  // capability center.
  assert.match(src_lib_site_knowledge_protocol_ts, /evolutionAssessment/);
  assert.match(accessPolicy, /authorizeManagementSession[^]*catch \{[^]*return false/);
  assert.match(clientPort, /learning-unavailable/);
});

test("concurrent capability management operations get distinct release IDs at the same timestamp", async () => {
  const compiler = await bundledModule("../lib/site-knowledge/compiler.ts");
  const first = compiler.capabilityManagementReleaseId(
    "atlas-market",
    7,
    "unpublish",
    "suppression-cart",
    now,
    "release_operation_first",
  );
  const second = compiler.capabilityManagementReleaseId(
    "atlas-market",
    7,
    "unpublish",
    "suppression-cart",
    now,
    "release_operation_second",
  );
  assert.notEqual(first, second);
  assert.match(first, /release_operation_first$/);
  assert.match(second, /release_operation_second$/);
});

test("browser IDs fall back to getRandomValues when randomUUID is unavailable on LAN HTTP", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const value = protocol.uid("browser", {
    getRandomValues(target) {
      target.set(Uint8Array.from({ length: 16 }, (_, index) => index));
      return target;
    },
  });
  assert.equal(value, "browser_00010203-0405-4607-8809-0a0b0c0d0e0f");
  const browserSources = await Promise.all([
    "../client/user-agent-client.ts",
    "../client/user-agent-shared.ts",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  assert.equal(browserSources.some((source) => source.includes("crypto.randomUUID")), false);
});

test("capability workbench exposes live AI coding artifacts instead of a black box", async () => {
  const analyzer = await readFile(new URL("../lib/site-knowledge/model-analyzer.ts", import.meta.url), "utf8");
  // The workbench is the capability centre's own screen now; capability-center-v1
  // is only the version switch that chooses between it and the earlier redesign.
  const screen = await readFile(new URL("../components/capability-center-v2-screen.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(analyzer, /await record\(\{ status: "running" \}\)/);
  assert.match(src_lib_site_knowledge_authoring_workspace_ts, /capability\.ts/);
  assert.match(src_lib_site_knowledge_authoring_workspace_ts, /fixtures\.json/);
  // The artifacts are shown, not summarized: the module's own hash, how it
  // runs, the target bindings, and every independent validation case with its
  // outcome. Wiring breaks in the screen, wording breaks in the dictionary.
  for (const key of ["moduleHash", "runtime", "targetBindings", "validationCases", "caseOutcomes"]) {
    assert.match(screen, new RegExp(`copy\\.${key}\\b`), `the screen must render ${key}`);
    assert.match(consoleCopyZh, new RegExp(`\\b${key}:`), `${key} must exist in the dictionary`);
  }
  assert.match(screen, /version\.program\.module\.contentHash/, "the hash shown is the module's own, not a summary of it");
  assert.match(styles, /\.cap-v1-build/);
  assert.match(styles, /\.cap-v1-list-group/);
});

test("browser authoring survives transient registration failures and one Intent owns one working revision", async () => {
  const runner = await readFile(new URL("../runner/browser-runner.ts", import.meta.url), "utf8");
  const store = await readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8");
  assert.match(runner, /runner_registration_retry/);
  assert.match(runner, /const registration = await register\(\)/);
  assert.match(store, /superseded_by_revision/);
  assert.match(store, /status IN \('queued','leased','running'\)/);
});

test("capability formation is an observable backend pipeline with browser recordings", async () => {
  const protocol = await readFile(new URL("../lib/site-knowledge/protocol.ts", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/site-agent-schema.ts", import.meta.url), "utf8");
  const store = await readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8");
  const runner = await readFile(new URL("../runner/browser-runner.ts", import.meta.url), "utf8");
  const consoleSource = await readFile(new URL("../components/capability-center-v1.tsx", import.meta.url), "utf8");
  assert.match(protocol, /LearningStageReceipt/);
  assert.match(protocol, /type BrowserArtifact/);
  assert.match(schema, /site_agent_v2_validation_jobs/);
  assert.match(schema, /site_agent_v2_browser_runs/);
  assert.match(schema, /site_agent_v2_artifacts/);
  assert.match(store, /designCandidateFromEvidence/);
  assert.match(store, /const semanticCandidate = await designCapabilityContract/);
  assert.match(store, /An administrator explicitly asked[^]*reuseDecision/);
  assert.match(store, /: designCandidateFromEvidence\(episode, candidate\)/);
  assert.match(store, /ai_capability_assessment_unavailable/);
  assert.doesNotMatch(store, /persistCapabilityRfc/);
  assert.match(store, /persistGeneratedCapabilitySpec/);
  assert.match(store, /closeInterruptedBrowserRuns/);
  assert.match(store, /leaseRunnerWork/);
  assert.match(store, /completeAuthoring/);
  assert.match(store, /completeValidation/);
  assert.match(runner, /recordVideo/);
  assert.match(runner, /context\.tracing\.start/);
  assert.match(runner, /AI Program Author/);
  assert.match(runner, /runCodexAuthoringSession/);
  assert.match(runner, /new CodexAuthoringDriver/);
  assert.match(runner, /specDoc: lease\.specDoc/);
  assert.match(runner, /module_smoke_passed/);
  assert.doesNotMatch(runner, /requestAuthoringPlan|requestGroundedAuthoringDraft|submit_authoring_plan|executeAuthoringPlan/);
  assert.doesNotMatch(runner, /sitewake-adaptive\.js/);
  assert.match(store, /normalizedGoal: designed\.normalizedGoal/);
  assert.match(store, /deriveValidationInputFromEvidence/);
  assert.match(store, /const retryableAuthorFailure = false/);
  assert.doesNotMatch(consoleSource, /activeGoals/);
});

test("capability control center keeps navigation and business projects separate and hides generated adapters", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const control = await bundledModule("../lib/site-knowledge/capability-control.ts");
  const release = protocol.emptyRelease("atlas", now);
  const publicCapability = {
    id: "capability_1pjg88a", kind: "task", resultKind: "page", exposure: "public", name: "打开热搜日榜", description: "查看每日热搜归档", normalizedGoal: protocol.normalizeGoal("打开热搜日榜"), goalTemplate: "打开热搜日榜", aliases: ["查看热搜日榜"],
    inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: { pageUrl: { type: "string" }, pageTitle: { type: "string" } } }, outcomes: [], plans: [], sourceEpisodeIds: [], confidence: 0.9, status: "available", updatedAt: now,
    module: { contentHash: "a".repeat(64), moduleUrl: "/programs/capability_1pjg88a.js", exportName: "capability" },
  };
  const internalNavigation = { ...publicCapability, id: "navigation-tool:daily", kind: "navigation", exposure: "internal", module: undefined, updatedAt: "2026-07-15T01:00:00.000Z" };
  release.capabilities = [publicCapability, internalNavigation];
  const receipt = (id, status, title) => ({ id, stage: "validate", actor: "browser-runner", status, title, summary: title, startedAt: now, endedAt: now });
  const jobs = [
    { id: "job-old", siteAgentId: "atlas", taskSessionId: "session", sourceEpisodeId: "episode-old", candidateId: "missing-old", phase: "validate", status: "failed", attempts: 1, intentKey: "open_daily_rank", goalTemplate: "打开热搜日榜", receipts: [receipt("receipt-old", "failed", "旧验证未通过")], failure: { code: "verifier_mismatch", summary: "旧文本已漂移" }, result: {}, createdAt: now, updatedAt: now },
    { id: "job-new", siteAgentId: "atlas", taskSessionId: "session", sourceEpisodeId: "episode-new", candidateId: "missing-new", phase: "publish", status: "completed", attempts: 1, intentKey: "open_daily_rank", goalTemplate: "打开热搜日榜", receipts: [receipt("receipt-new", "passed", "独立验证通过")], result: {}, createdAt: now, updatedAt: now },
  ];
  const projected = control.projectCapabilityControl({ siteAgentId: "atlas", release, candidates: [], learningJobs: jobs, validationJobs: [], browserRuns: [], episodes: [] });
  assert.equal(projected.projects.length, 2);
  const businessProject = projected.projects.find((project) => project.kind === "task");
  const navigationProject = projected.projects.find((project) => project.kind === "navigation");
  assert.equal(businessProject?.status, "available");
  assert.equal(businessProject?.activeCapabilityId, "capability_1pjg88a");
  assert.equal(businessProject?.executionRequirements.supportedEnvironments.cloudBrowser, "supported");
  // Its newest attempt failed on a drifted verifier, so the project is not
  // merely "building": it is stuck until somebody acts, and it says which act.
  assert.equal(navigationProject?.status, "needs-guidance");
  assert.equal(navigationProject?.health?.failureClass, "verifier-mismatch");
  assert.equal(navigationProject?.health?.recommendedAction, "retry-validation");
  assert.equal(navigationProject?.activeCapabilityId, undefined);
  assert.ok(projected.revisions.some((revision) => revision.status === "failed"));
  const withoutModule = control.projectCapabilityControl({
    siteAgentId: "atlas",
    release: { ...release, capabilities: [{ ...publicCapability, module: undefined }, internalNavigation] },
    candidates: [],
    learningJobs: jobs,
    validationJobs: [],
    browserRuns: [],
    episodes: [],
  });
  assert.equal(withoutModule.projects[0].activeCapabilityId, "capability_1pjg88a");
  assert.equal(withoutModule.projects[0].executionRequirements.supportedEnvironments.cloudBrowser, "unverified");
});

test("a failed enhancement stays working while the last-good capability remains active", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const control = await bundledModule("../lib/site-knowledge/capability-control.ts");
  const publishedAt = "2026-07-15T02:00:00.000Z";
  const failedAt = "2026-07-15T03:00:00.000Z";
  const release = protocol.emptyRelease("atlas", publishedAt);
  const capability = {
    id: "capability-cart",
    kind: "task",
    resultKind: "page",
    exposure: "public",
    name: "打开购物车",
    description: "进入购物车页面",
    normalizedGoal: protocol.normalizeGoal("打开购物车"),
    goalTemplate: "打开购物车",
    aliases: [],
    inputs: { type: "object", properties: {} },
    outputs: { type: "object", properties: { pageUrl: { type: "string" } } },
    module: FIXTURE_MODULE,
    outcomes: [],
    plans: [],
    sourceEpisodeIds: ["episode-published"],
    confidence: 0.9,
    status: "available",
    origin: "ai-exploration",
    updatedAt: publishedAt,
  };
  release.capabilities = [capability];
  const candidate = (id, updatedAt) => ({
    id,
    siteAgentId: "atlas",
    normalizedGoal: capability.normalizedGoal,
    baseReleaseVersion: 0,
    scenes: [],
    targets: [],
    operations: [],
    capability: { ...capability, status: "learning", updatedAt },
    validation: { status: "pending", attempts: 0, successfulReplays: 0, requiredReplays: 1 },
    authoring: {
      stage: "authored",
      reusableTrace: false,
      intentKey: "open_cart",
      goalTemplate: "打开购物车",
      requiredInputs: [],
      resultFields: [],
    },
    sourceEpisodeIds: ["episode-published"],
    createdAt: updatedAt,
    updatedAt,
  });
  const candidates = [candidate("candidate-published", publishedAt), candidate("candidate-failed", failedAt)];
  const jobs = [
    {
      id: "job-published",
      siteAgentId: "atlas",
      taskSessionId: "session-published",
      sourceEpisodeId: "episode-published",
      candidateId: "candidate-published",
      phase: "publish",
      status: "completed",
      attempts: 1,
      intentKey: "open_cart",
      goalTemplate: "打开购物车",
      receipts: [],
      result: {},
      createdAt: publishedAt,
      updatedAt: publishedAt,
    },
    {
      id: "job-failed",
      siteAgentId: "atlas",
      taskSessionId: "session-failed",
      sourceEpisodeId: "episode-failed",
      candidateId: "candidate-failed",
      phase: "author",
      status: "failed",
      attempts: 1,
      intentKey: "open_cart",
      goalTemplate: "打开购物车",
      receipts: [],
      failure: { code: "ai_author_failed", summary: "模型响应不是完整 JSON" },
      result: {},
      createdAt: failedAt,
      updatedAt: failedAt,
    },
  ];
  const validationJobs = [{
    id: "validation-published",
    learningJobId: "job-published",
    siteAgentId: "atlas",
    candidateId: "candidate-published",
    capabilityId: capability.id,
    baseReleaseVersion: 0,
    status: "passed",
    validationCase: {
      id: "case-published",
      name: "打开购物车",
      input: {},
      inputSource: "observed",
      startUrl: "https://atlas.test/",
      expectedStatuses: ["success"],
      effect: "read-only",
    },
    attempt: 1,
    maxAttempts: 2,
    createdAt: publishedAt,
    updatedAt: publishedAt,
  }];
  const episode = (id, endedAt) => ({
    id,
    siteAgentId: "atlas",
    taskSessionId: id,
    browserSessionId: "browser",
    documentId: "document",
    mode: "author-request",
    goal: "打开购物车",
    normalizedGoal: protocol.normalizeGoal("打开购物车"),
    input: {},
    startedAt: endedAt,
    endedAt,
    releaseId: release.id,
    startSnapshot: { url: "https://atlas.test/", title: "Atlas", heading: "Atlas" },
    endSnapshot: { url: "https://atlas.test/cart", title: "购物车", heading: "购物车" },
    transitions: [],
    outcome: { status: "success", code: "success", summary: "已打开购物车", evidence: {}, evaluatedAt: endedAt },
  });

  const projected = control.projectCapabilityControl({
    siteAgentId: "atlas",
    release,
    candidates,
    learningJobs: jobs,
    validationJobs,
    browserRuns: [],
    episodes: [episode("episode-published", publishedAt), episode("episode-failed", failedAt)],
  });
  const project = projected.projects[0];
  const publishedRevision = projected.revisions.find((revision) => revision.learningJobId === "job-published");
  const failedRevision = projected.revisions.find((revision) => revision.learningJobId === "job-failed");

  assert.equal(project.status, "available");
  assert.equal(project.activeCapabilityId, capability.id);
  assert.equal(project.activeRevisionId, publishedRevision.id);
  assert.equal(project.latestRevisionId, failedRevision.id);
  assert.notEqual(project.activeRevisionId, project.latestRevisionId);
  assert.equal(publishedRevision.status, "published");
  assert.equal(publishedRevision.validation.status, "passed");
  assert.equal(failedRevision.status, "failed");
  assert.equal(failedRevision.stage, "author");
  assert.equal(failedRevision.validation.status, "pending");
  assert.equal(project.origin, "administrator");
  assert.equal(project.triggeredBy, "administrator");
  assert.equal(project.generatedBy, "ai");
});

test("a synthetic published revision remains historical when two newer attempts fail", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const control = await bundledModule("../lib/site-knowledge/capability-control.ts");
  const releasedAt = "2026-07-15T01:00:00.000Z";
  const release = protocol.emptyRelease("synthetic-history", releasedAt);
  release.capabilities = [{
    id: "capability-history",
    kind: "task",
    resultKind: "page",
    exposure: "public",
    name: "Open history",
    description: "Open history",
    normalizedGoal: protocol.normalizeGoal("Open history"),
    goalTemplate: "Open history",
    aliases: [],
    inputs: { type: "object", properties: {} },
    outputs: { type: "object", properties: { pageUrl: { type: "string" } } },
    module: FIXTURE_MODULE,
    outcomes: [],
    plans: [],
    sourceEpisodeIds: [],
    confidence: 0.8,
    status: "available",
    origin: "ai-exploration",
    updatedAt: releasedAt,
  }];
  const failedJob = (id, updatedAt) => ({
    id,
    siteAgentId: "synthetic-history",
    taskSessionId: `session-${id}`,
    sourceEpisodeId: `episode-${id}`,
    candidateId: `missing-${id}`,
    phase: "author",
    status: "failed",
    attempts: 1,
    intentKey: "open_history",
    goalTemplate: "Open history",
    receipts: [],
    failure: { code: "ai_author_failed", summary: `${id} failed` },
    result: {},
    createdAt: updatedAt,
    updatedAt,
  });
  const projected = control.projectCapabilityControl({
    siteAgentId: "synthetic-history",
    release,
    candidates: [],
    learningJobs: [
      failedJob("failure-one", "2026-07-15T02:00:00.000Z"),
      failedJob("failure-two", "2026-07-15T03:00:00.000Z"),
    ],
    validationJobs: [],
    browserRuns: [],
    episodes: [],
  });
  const project = projected.projects[0];
  const ordered = projected.revisions
    .filter((revision) => revision.projectId === project.id)
    .sort((left, right) => left.number - right.number);

  assert.deepEqual(ordered.map((revision) => revision.status), ["published", "failed", "failed"]);
  assert.deepEqual(ordered.map((revision) => revision.number), [1, 2, 3]);
  assert.equal(project.activeRevisionId, ordered[0].id);
  assert.equal(project.latestRevisionId, ordered[2].id);
  assert.equal(ordered[2].learningJobId, "failure-two");
  assert.equal(project.status, "available");
});

test("project trigger is first provenance and generator follows the active implementation", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const control = await bundledModule("../lib/site-knowledge/capability-control.ts");
  const firstAt = "2026-07-15T01:00:00.000Z";
  const secondAt = "2026-07-15T02:00:00.000Z";
  const capability = {
    id: "capability-provenance",
    kind: "task",
    resultKind: "page",
    exposure: "public",
    name: "Open reports",
    description: "Open reports",
    normalizedGoal: protocol.normalizeGoal("Open reports"),
    goalTemplate: "Open reports",
    aliases: [],
    inputs: { type: "object", properties: {} },
    outputs: { type: "object", properties: { pageUrl: { type: "string" } } },
    module: FIXTURE_MODULE,
    outcomes: [],
    plans: [],
    sourceEpisodeIds: [],
    confidence: 0.9,
    status: "available",
    origin: "ai-exploration",
    updatedAt: secondAt,
  };
  const release = protocol.emptyRelease("provenance", secondAt);
  release.capabilities = [capability];
  const completedJob = (id, episodeId, updatedAt) => ({
    id,
    siteAgentId: "provenance",
    taskSessionId: `session-${id}`,
    sourceEpisodeId: episodeId,
    candidateId: `missing-${id}`,
    phase: "publish",
    status: "completed",
    attempts: 1,
    intentKey: "open_reports",
    goalTemplate: "Open reports",
    receipts: [],
    result: {},
    createdAt: updatedAt,
    updatedAt,
  });
  const sourceEpisode = (id, mode, endedAt) => ({
    id,
    siteAgentId: "provenance",
    taskSessionId: `session-${id}`,
    browserSessionId: "browser",
    documentId: "document",
    mode,
    goal: "Open reports",
    normalizedGoal: protocol.normalizeGoal("Open reports"),
    input: {},
    startedAt: endedAt,
    endedAt,
    releaseId: release.id,
    startSnapshot: { url: "https://reports.test/", title: "Reports", heading: "Reports" },
    endSnapshot: { url: "https://reports.test/all", title: "Reports", heading: "Reports" },
    transitions: [],
    outcome: { status: "success", code: "success", summary: "Opened", evidence: {}, evaluatedAt: endedAt },
  });
  const projection = (firstMode, secondMode) => control.projectCapabilityControl({
    siteAgentId: "provenance",
    release,
    candidates: [],
    learningJobs: [
      completedJob("first", "episode-first", firstAt),
      completedJob("second", "episode-second", secondAt),
    ],
    validationJobs: [],
    browserRuns: [],
    episodes: [
      sourceEpisode("episode-first", firstMode, firstAt),
      sourceEpisode("episode-second", secondMode, secondAt),
    ],
  }).projects[0];

  const rebuiltAfterDemonstration = projection("demonstration", "adaptive");
  assert.equal(rebuiltAfterDemonstration.triggeredBy, "user");
  assert.equal(rebuiltAfterDemonstration.generatedBy, "ai");

  const administratorEnhancementAfterUser = projection("adaptive", "author-request");
  assert.equal(administratorEnhancementAfterUser.triggeredBy, "user");
  assert.equal(administratorEnhancementAfterUser.generatedBy, "ai");

  const overlappingLifecycle = control.projectCapabilityControl({
    siteAgentId: "provenance",
    release,
    candidates: [],
    learningJobs: [
      { ...completedJob("first", "episode-first", "2026-07-15T03:00:00.000Z"), createdAt: firstAt },
      { ...completedJob("second", "episode-second", "2026-07-15T02:30:00.000Z"), createdAt: secondAt },
    ],
    validationJobs: [],
    browserRuns: [],
    episodes: [
      sourceEpisode("episode-first", "adaptive", "2026-07-15T03:00:00.000Z"),
      sourceEpisode("episode-second", "author-request", "2026-07-15T02:30:00.000Z"),
    ],
  }).projects[0];
  assert.equal(overlappingLifecycle.triggeredBy, "user");
});

test("a failed runtime-regression enhancement does not degrade a still-good active revision", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const control = await bundledModule("../lib/site-knowledge/capability-control.ts");
  const publishedAt = "2026-07-15T01:00:00.000Z";
  const failedAt = "2026-07-15T02:00:00.000Z";
  const release = protocol.emptyRelease("runtime-regression", publishedAt);
  release.capabilities = [{
    id: "capability-runtime",
    kind: "task",
    resultKind: "page",
    exposure: "public",
    name: "Open runtime",
    description: "Open runtime",
    normalizedGoal: protocol.normalizeGoal("Open runtime"),
    goalTemplate: "Open runtime",
    aliases: [],
    inputs: { type: "object", properties: {} },
    outputs: { type: "object", properties: { pageUrl: { type: "string" } } },
    module: FIXTURE_MODULE,
    outcomes: [],
    plans: [],
    sourceEpisodeIds: [],
    confidence: 0.9,
    status: "available",
    origin: "ai-exploration",
    updatedAt: publishedAt,
  }];
  const job = (id, status, updatedAt, failure) => ({
    id,
    siteAgentId: "runtime-regression",
    taskSessionId: `session-${id}`,
    sourceEpisodeId: `episode-${id}`,
    candidateId: `missing-${id}`,
    phase: status === "completed" ? "publish" : "validate",
    status,
    attempts: 1,
    intentKey: "open_runtime",
    goalTemplate: "Open runtime",
    receipts: [],
    failure,
    result: {},
    createdAt: updatedAt,
    updatedAt,
  });
  const projected = control.projectCapabilityControl({
    siteAgentId: "runtime-regression",
    release,
    candidates: [],
    learningJobs: [
      job("last-good", "completed", publishedAt),
      job("failed-enhancement", "failed", failedAt, { code: "runtime_regression", summary: "New implementation drifted" }),
    ],
    validationJobs: [],
    browserRuns: [],
    episodes: [],
  });

  assert.equal(projected.projects[0].status, "available");
  assert.equal(projected.projects[0].health.failureClass, "runtime-regression");
  assert.equal(
    projected.revisions.find((revision) => revision.id === projected.projects[0].latestRevisionId).learningJobId,
    "failed-enhancement",
  );
});

test("capability control excludes greetings and navigation jobs from public projects", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const control = await bundledModule("../lib/site-knowledge/capability-control.ts");
  const release = protocol.emptyRelease("atlas", now);
  const makeEpisode = (id, goal, code = "success") => ({ id, taskSessionId: id, mode: "adaptive", goal, input: {}, startedAt: now, endedAt: now, outcome: { status: "success", code, summary: "完成", evidence: {}, evaluatedAt: now }, startSnapshot: { url: "https://atlas.test/", title: "Atlas", heading: "Atlas" }, endSnapshot: { url: "https://atlas.test/", title: "Atlas", heading: "Atlas" } });
  const makeJob = (id, episodeId, decision) => ({ id, siteAgentId: "atlas", taskSessionId: id, sourceEpisodeId: episodeId, phase: "design", status: "completed", attempts: 1, intentKey: id, goalTemplate: id, receipts: [], result: { reuseDecision: decision }, createdAt: now, updatedAt: now });
  const episodes = [makeEpisode("greeting", "你好", "conversation_completed"), makeEpisode("navigation", "打开词云")];
  const jobs = [makeJob("job-greeting", "greeting", "conversation-only"), makeJob("job-navigation", "navigation", "navigation-tool")];
  const projected = control.projectCapabilityControl({ siteAgentId: "atlas", release, candidates: [], learningJobs: jobs, validationJobs: [], browserRuns: [], episodes });
  assert.equal(projected.projects.length, 0);
});

test("a legacy task-shaped candidate cannot turn greeting evidence into a business project", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const control = await bundledModule("../lib/site-knowledge/capability-control.ts");
  const release = protocol.emptyRelease("atlas", now);
  const capability = { id: "legacy-home", kind: "task", resultKind: "data", exposure: "public", name: "openHomepage", description: "到达首页", normalizedGoal: "openhomepage", goalTemplate: "openHomepage", aliases: [], inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: { items: { type: "array" } } }, outcomes: [], plans: [], sourceEpisodeIds: ["hello-episode"], confidence: .4, status: "learning", updatedAt: now };
  const candidate = { id: "legacy-candidate", siteAgentId: "atlas", normalizedGoal: capability.normalizedGoal, baseReleaseVersion: 0, scenes: [], targets: [], operations: [], capability, validation: { status: "pending", attempts: 0, successfulReplays: 0, requiredReplays: 1 }, authoring: { stage: "designed", reusableTrace: false, intentKey: "legacy-home", goalTemplate: "openHomepage", requiredInputs: [], resultFields: [] }, sourceEpisodeIds: ["hello-episode"], createdAt: now, updatedAt: now };
  const greeting = { id: "hello-episode", taskSessionId: "hello", mode: "adaptive", goal: "你好", input: {}, startedAt: now, endedAt: now, outcome: { status: "success", code: "success", summary: "你好", evidence: {}, evaluatedAt: now }, startSnapshot: { url: "https://atlas.test/", title: "Atlas", heading: "Atlas" }, endSnapshot: { url: "https://atlas.test/", title: "Atlas", heading: "Atlas" } };
  const projected = control.projectCapabilityControl({ siteAgentId: "atlas", release, candidates: [candidate], learningJobs: [], validationJobs: [], browserRuns: [], episodes: [greeting] });
  assert.equal(projected.projects.length, 0);
});

test("console removes the Navigation Tools workbench from the knowledge view", async () => {
  const source = await readFile(new URL("../components/site-agent-console.tsx", import.meta.url), "utf8");
  // Navigation Tools are no longer surfaced in the knowledge console (removed by request).
  assert.doesNotMatch(source, /NAVIGATION TOOL LIBRARY/);
  assert.doesNotMatch(source, /只承诺到达页面/);
  assert.doesNotMatch(source, /导航工具由知识增量编译/);
  assert.doesNotMatch(source, /sw-built-in-routes/);
  // Console-route persistence is unrelated and must stay.
  assert.match(source, /const \[routeReady, setRouteReady\] = useState\(false\)/);
  assert.doesNotMatch(source, /useState\(\(\) => consoleRoute\(\)/);
});

test("capability control center collapses identical goals even when legacy jobs used opaque intent keys", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const control = await bundledModule("../lib/site-knowledge/capability-control.ts");
  const release = protocol.emptyRelease("atlas", now);
  const job = (id, intentKey) => ({ id, siteAgentId: "atlas", taskSessionId: `session-${id}`, sourceEpisodeId: `episode-${id}`, candidateId: `missing-${id}`, phase: "design", status: "queued", attempts: 0, intentKey, goalTemplate: "查看 {date} 的微博热搜日榜", receipts: [], result: {}, createdAt: now, updatedAt: now });
  const projected = control.projectCapabilityControl({ siteAgentId: "atlas", release, candidates: [], learningJobs: [job("a", "intent_a"), job("b", "intent_b")], validationJobs: [], browserRuns: [], episodes: [] });
  assert.equal(projected.projects.length, 1);
  assert.equal(projected.revisions.length, 2);
});

test("runtime evidence from an already published capability never creates a second project", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const control = await bundledModule("../lib/site-knowledge/capability-control.ts");
  const release = protocol.emptyRelease("atlas", now);
  const published = {
    id: "capability-search",
    kind: "task",
    resultKind: "data",
    exposure: "public",
    name: "searchProduct",
    description: "按关键词搜索商品",
    normalizedGoal: protocol.normalizeGoal("搜索 {keyword} 相关的商品"),
    goalTemplate: "搜索 {keyword} 相关的商品",
    aliases: ["搜索商品", "查找商品"],
    inputs: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] },
    outputs: { type: "object", properties: { results: { type: "array" } }, required: ["results"] },
    module: FIXTURE_MODULE,
    outcomes: [],
    plans: [],
    sourceEpisodeIds: ["episode-admin"],
    confidence: 0.9,
    status: "available",
    origin: "administrator",
    updatedAt: now,
  };
  release.capabilities = [published];
  const adminCandidate = {
    id: "candidate-admin",
    siteAgentId: "atlas",
    normalizedGoal: published.normalizedGoal,
    baseReleaseVersion: 0,
    scenes: [],
    targets: [],
    operations: [],
    capability: { ...published, id: "capability-draft", status: "learning" },
    validation: { status: "pending", attempts: 0, successfulReplays: 0, requiredReplays: 1 },
    authoring: { stage: "designed", reusableTrace: false, intentKey: "search_product", goalTemplate: published.goalTemplate },
    sourceEpisodeIds: ["episode-admin"],
    createdAt: now,
    updatedAt: now,
  };
  const runtimeCandidate = {
    ...adminCandidate,
    id: "candidate-runtime",
    normalizedGoal: "searchproduct",
    capability: { ...published, id: "capability-runtime-draft", name: "searchProduct", normalizedGoal: "searchproduct", status: "learning", sourceEpisodeIds: ["episode-runtime"] },
    authoring: { stage: "evidence", reusableTrace: false, reason: "现有能力已被复用" },
    sourceEpisodeIds: ["episode-runtime"],
  };
  const makeEpisode = (id, mode, capabilityId) => ({
    id,
    siteAgentId: "atlas",
    taskSessionId: `session-${id}`,
    browserSessionId: "browser",
    documentId: "document",
    mode,
    capabilityId,
    goal: mode === "author-request" ? published.goalTemplate : published.name,
    normalizedGoal: mode === "author-request" ? published.normalizedGoal : "searchproduct",
    input: {},
    startedAt: now,
    endedAt: now,
    releaseId: release.id,
    startSnapshot: { url: "https://atlas.test/", title: "Atlas", heading: "Atlas" },
    endSnapshot: { url: "https://atlas.test/search", title: "Search", heading: "Search" },
    transitions: [],
    outcome: { status: "success", code: "success", summary: "完成", evidence: {}, evaluatedAt: now },
  });
  const makeJob = (id, episodeId, candidateId, intentKey, origin) => ({
    id,
    siteAgentId: "atlas",
    taskSessionId: `session-${episodeId}`,
    sourceEpisodeId: episodeId,
    candidateId,
    origin,
    phase: "publish",
    status: "completed",
    attempts: 1,
    intentKey,
    goalTemplate: candidateId === "candidate-admin" ? published.goalTemplate : published.name,
    receipts: [],
    result: { source: candidateId === "candidate-admin" ? "control-plane-goal" : "successful-user-episode" },
    createdAt: now,
    updatedAt: now,
  });
  const projected = control.projectCapabilityControl({
    siteAgentId: "atlas",
    release,
    candidates: [adminCandidate, runtimeCandidate],
    learningJobs: [
      makeJob("job-admin", "episode-admin", "candidate-admin", "search_product", "administrator"),
      makeJob("job-runtime", "episode-runtime", "candidate-runtime", "intent-runtime", "user-triggered"),
    ],
    validationJobs: [],
    browserRuns: [],
    episodes: [
      makeEpisode("episode-admin", "author-request"),
      makeEpisode("episode-runtime", "compiled", published.id),
    ],
  });
  assert.equal(projected.projects.length, 1);
  assert.equal(projected.projects[0].activeCapabilityId, published.id);
  assert.equal(projected.projects[0].triggeredBy, "administrator");
  assert.equal(projected.revisions.some((revision) => revision.learningJobId === "job-runtime"), false);
});

test("capability projection merges legacy wording and rewrites ordinal experience as rank input", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const control = await bundledModule("../lib/site-knowledge/capability-control.ts");
  const release = protocol.emptyRelease("atlas", now);
  release.capabilities = [{
    id: "capability-search", kind: "task", resultKind: "page", exposure: "public", name: "按关键词搜索历史热搜", description: "查询历史热搜记录", normalizedGoal: protocol.normalizeGoal("按关键词搜索历史热搜"), aliases: ["搜索历史热搜"],
    inputs: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] }, outputs: { type: "object", properties: { pageUrl: { type: "string" } } }, outcomes: [], plans: [], sourceEpisodeIds: [], confidence: 0.9, status: "available", updatedAt: now,
  }];
  const receipt = { id: "receipt", stage: "design", actor: "ai", status: "failed", title: "旧设计", summary: "旧设计", startedAt: now, endedAt: now };
  const jobs = [
    { id: "job-search", siteAgentId: "atlas", taskSessionId: "session-search", sourceEpisodeId: "episode-search", candidateId: "missing-search", phase: "design", status: "failed", attempts: 1, intentKey: "search_hot_search_history", goalTemplate: "搜索 {keyword} 的历史热搜", receipts: [receipt], failure: { code: "duplicate", summary: "旧任务" }, result: {}, createdAt: now, updatedAt: now },
    { id: "job-rank", siteAgentId: "atlas", taskSessionId: "session-rank", sourceEpisodeId: "episode-rank", candidateId: "missing-rank", phase: "author", status: "failed", attempts: 1, intentKey: "view_hot_topic_detail", goalTemplate: "查看热搜话题详情", receipts: [{ ...receipt, id: "receipt-rank" }], failure: { code: "contract_incomplete", summary: "缺少序号" }, result: {}, createdAt: now, updatedAt: now },
  ];
  const episode = (id, goal) => ({ id, taskSessionId: id, mode: "adaptive", goal, input: {}, startedAt: now, endedAt: now, outcome: { status: "success", code: "success", summary: "完成", evidence: {}, evaluatedAt: now }, startSnapshot: { url: "https://atlas.test/", title: "Atlas", heading: "Atlas" }, endSnapshot: { url: "https://atlas.test/result", title: "Result", heading: "Result" } });
  const projected = control.projectCapabilityControl({ siteAgentId: "atlas", release, candidates: [], learningJobs: jobs, validationJobs: [], browserRuns: [], episodes: [episode("episode-search", "搜索周杰伦的热搜"), episode("episode-rank", "点开第三个热搜词条")] });
  assert.equal(projected.projects.length, 2);
  const search = projected.projects.find((project) => project.intentKey === "search_hot_search_history");
  assert.equal(search.status, "available");
  assert.equal(search.activeCapabilityId, "capability-search");
  const ranked = projected.projects.find((project) => project.intentKey === "view_hot_topic_detail");
  // The project keeps the wording the request was filed under; the rewrite that
  // turns "点开第三个" into a `rank` input belongs to the Revision's contract,
  // which is where a contract is decided and where the decision is recorded.
  assert.equal(ranked.goalTemplate, "查看热搜话题详情");
  const rankedRevision = projected.revisions.find((revision) => revision.projectId === ranked.id);
  // A Revision no longer carries its own copy of the contract — the Capability
  // root owns that — so the rewrite survives as the recorded decision: the
  // ordinal somebody actually used, and why it is an input rather than a fixed
  // task.
  const rankDecision = rankedRevision.parameterizationDecisions.find((decision) => decision.inputId === "rank");
  assert.equal(rankDecision.observedValue, 3);
  assert.equal(rankDecision.decision, "input");
  assert.match(rankDecision.evidence, /第三个/, "the decision cites the real experience it came from");
});

test("a shared experience never merges semantically different capability projects", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const control = await bundledModule("../lib/site-knowledge/capability-control.ts");
  const release = protocol.emptyRelease("atlas", now);
  release.capabilities = [{
    id: "capability-keyword", kind: "task", resultKind: "page", exposure: "public", name: "按关键词搜索历史热搜", description: "搜索关键词", normalizedGoal: protocol.normalizeGoal("按关键词搜索历史热搜"), aliases: [],
    inputs: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] }, outputs: { type: "object", properties: { pageUrl: { type: "string" } } }, outcomes: [], plans: [], sourceEpisodeIds: ["episode-shared"], confidence: 0.9, status: "available", updatedAt: now,
  }];
  const dateCapability = {
    id: "capability-date", kind: "task", resultKind: "page", exposure: "public", name: "按日期查看热搜日榜", description: "查看指定日期日榜", normalizedGoal: protocol.normalizeGoal("按日期查看热搜日榜"), goalTemplate: "查看 {date} 的热搜日榜", aliases: [],
    inputs: { type: "object", properties: { date: { type: "string" } }, required: ["date"] }, outputs: { type: "object", properties: { pageUrl: { type: "string" } } }, outcomes: [], plans: [], sourceEpisodeIds: ["episode-shared"], confidence: 0.7, status: "learning", updatedAt: now,
  };
  const candidate = { id: "candidate-date", siteAgentId: "atlas", normalizedGoal: dateCapability.normalizedGoal, baseReleaseVersion: 0, scenes: [], targets: [], operations: [], capability: dateCapability, validation: { status: "pending", attempts: 0, successfulReplays: 0, requiredReplays: 1 }, authoring: { stage: "designed", reusableTrace: false, intentKey: "view_daily_by_date", goalTemplate: dateCapability.goalTemplate, requiredInputs: [{ id: "date", name: "日期", type: "string", value: "2025-04-24", examples: [] }], resultFields: [] }, sourceEpisodeIds: ["episode-shared"], createdAt: now, updatedAt: now };
  const job = { id: "job-date", siteAgentId: "atlas", taskSessionId: "session-date", sourceEpisodeId: "episode-shared", candidateId: candidate.id, phase: "design", status: "queued", attempts: 0, intentKey: "view_daily_by_date", goalTemplate: dateCapability.goalTemplate, receipts: [], result: {}, createdAt: now, updatedAt: now };
  const projected = control.projectCapabilityControl({ siteAgentId: "atlas", release, candidates: [candidate], learningJobs: [job], validationJobs: [], browserRuns: [], episodes: [] });
  assert.equal(projected.projects.length, 2);
  assert.ok(projected.projects.some((project) => project.name === "按日期查看热搜日榜" && !project.activeCapabilityId));
  assert.ok(projected.projects.some((project) => project.name === "按关键词搜索历史热搜" && project.activeCapabilityId === "capability-keyword"));
});

test("capability projection parameterizes concrete dates and retries transient AI design failures", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/protocol.ts");
  const control = await bundledModule("../lib/site-knowledge/capability-control.ts");
  const release = protocol.emptyRelease("atlas", now);
  const receipt = { id: "receipt-date", stage: "design", actor: "ai", status: "failed", title: "设计未返回", summary: "模型暂时没有返回可靠结构", startedAt: now, endedAt: now };
  const job = { id: "job-date", siteAgentId: "atlas", taskSessionId: "session-date", sourceEpisodeId: "episode-date", candidateId: "missing-date", phase: "design", status: "failed", attempts: 1, intentKey: "view_daily_by_date", goalTemplate: "我想看25年4月24号的热搜", receipts: [receipt], failure: { code: "ai_design_unavailable", summary: "AI 能力设计没有返回可靠结构" }, result: {}, createdAt: now, updatedAt: now };
  const episode = { id: "episode-date", taskSessionId: "session-date", mode: "adaptive", goal: "我想看25年4月24号的热搜", input: {}, startedAt: now, endedAt: now, outcome: { status: "success", code: "success", summary: "完成", evidence: {}, evaluatedAt: now }, startSnapshot: { url: "https://atlas.test/", title: "Atlas", heading: "Atlas" }, endSnapshot: { url: "https://atlas.test/daily/2025-04-24", title: "日榜", heading: "日榜" } };
  const projected = control.projectCapabilityControl({ siteAgentId: "atlas", release, candidates: [], learningJobs: [job], validationJobs: [], browserRuns: [], episodes: [episode] });
  // The project is filed under the words the request arrived in; turning
  // "25年4月24号" into a `date` input is a contract decision, recorded on the
  // Revision that reached it rather than written back over the request.
  assert.equal(projected.projects[0].name, "我想看25年4月24号的热搜");
  const dateDecision = projected.revisions[0].parameterizationDecisions.find((decision) => decision.inputId === "date");
  assert.equal(dateDecision.observedValue, "2025-04-24");
  assert.equal(dateDecision.decision, "input");
  assert.match(dateDecision.reason, /日期/, "the decision says why a concrete date cannot be frozen into the task");
  assert.equal(projected.projects[0].status, "degraded");
  assert.equal(projected.projects[0].health.failureClass, "transient-runtime");
  assert.equal(projected.projects[0].health.recommendedAction, "re-explore");
  assert.equal(control.classifyCapabilityFailure("contract_incomplete", "索引是内部操作实现，非业务输入"), "transient-runtime");
  assert.equal(control.classifyCapabilityFailure("contract_incomplete", "该值是结果而非输入，用户未在目标中提及具体标题"), "transient-runtime");
  assert.equal(control.classifyCapabilityFailure("contract_incomplete", "该索引是当前页面布局的导航项，应通过语义化选择替代"), "transient-runtime");
  const store = await bundledModule("../db/site-agent-store.ts");
  assert.equal(store.isHealthyDiscardedParameter("end.url", "目标 URL 由系统根据 date 输入自动拼接生成，不属于用户输入"), true);
  assert.equal(store.isHealthyDiscardedParameter("目标中的日期", "用户要求的具体日期没有被参数化"), false);
});

test("capability factory exposes the failing layer and never hides it behind read-triggered retries", async () => {
  const consoleSource = await readFile(new URL("../components/capability-center-v1.tsx", import.meta.url), "utf8");
  const store = await readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8");
  assert.match(consoleCopyZh, /构建失败/);
  assert.match(src_lib_capability_center_v2_debug_trace_ts, /event\.message/);
  assert.match(consoleCopyZh, /重新构建/);
  assert.doesNotMatch(store, /autoRecoverCapabilityProjects/);
  assert.match(store, /const retryableAuthorFailure = false/);
  assert.doesNotMatch(store, /site_agent_v2_learning_jobs SET candidate_id/);
  assert.match(store, /status='running' AND updated_at<=/);
  assert.match(store, /status IN \('leased','running'\) AND lease_expires_at<=/);
  assert.match(store, /非业务输入/);
});

test("TaskLaunch is origin-bound, one-time claimable, and returns structured outcomes", async () => {
  const store = await bundledModule("../db/site-agent-store.ts");
  store.resetMemorySiteAgentStore();
  // A handshake no longer creates the site: an external website is enrolled by
  // an administrator, never by connecting. See db/agent-run-store.ts.
  await store.createSiteAgent({ id: "launch-site" });
  await store.recordSiteAgentConnection("launch-site", { origin: "https://launch.test", url: "https://launch.test/", title: "Launch", heading: "Launch", snapshot: snapshot("https://launch.test/", "Launch") });
  const created = await store.createTaskLaunch({ siteAgentId: "launch-site", goal: "完成一个目标", input: { keyword: "周杰伦" }, mode: "run" });
  assert.match(created.launchUrl, /sitewake-launch=/);
  // The page that claims a launch mints its own claim key and sends it with the
  // token; the store keeps only the hashes of both, so neither secret is
  // readable back out of it.
  const claimKey = "launch-claim-key-000001";
  await assert.rejects(
    () => store.claimTaskLaunch("launch-site", created.launch.id, { token: created.token, origin: "https://elsewhere.test", claimKey }),
    /task_launch_claim_rejected/,
    "a launch is bound to the origin it was issued for",
  );
  const claimed = await store.claimTaskLaunch("launch-site", created.launch.id, { token: created.token, origin: "https://launch.test", claimKey });
  assert.equal(claimed.launch.status, "claimed");
  // The same claimer repeating its claim is idempotent — a reload must not lock
  // the page out of its own launch — while a second claimer is refused.
  const reclaimed = await store.claimTaskLaunch("launch-site", created.launch.id, { token: created.token, origin: "https://launch.test", claimKey });
  assert.equal(reclaimed.launch.status, "claimed");
  await assert.rejects(
    () => store.claimTaskLaunch("launch-site", created.launch.id, { token: created.token, origin: "https://launch.test", claimKey: "launch-claim-key-000002" }),
    /task_launch_claim_rejected/,
    "a launch is claimable once: a second claimer is refused even with the token",
  );
  // The result is origin-bound too: the reporting page names its origin, and
  // both that origin and the result URL have to be the one the launch was
  // issued for. Otherwise a foreign page could report somebody else's outcome.
  await assert.rejects(
    () => store.updateTaskLaunch("launch-site", created.launch.id, { claimKey, origin: "https://elsewhere.test", status: "completed", output: {}, outcome: { status: "success", code: "success", summary: "x", evidence: {}, evaluatedAt: now } }),
    /task_launch_origin_rejected/,
  );
  const completed = await store.updateTaskLaunch("launch-site", created.launch.id, { claimKey, origin: "https://launch.test", status: "completed", output: { count: 12 }, resultUrl: "https://launch.test/search?q=x", outcome: { status: "success", code: "success", summary: "找到 12 条结果", evidence: {}, evaluatedAt: now } });
  assert.equal(completed.launch.output.count, 12);
  assert.equal(completed.launch.status, "completed");
});

test("specification, smoke, shared-operation, and launch gates are visible in the target architecture", async () => {
  const store = await readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8");
  const runner = await readFile(new URL("../runner/browser-runner.ts", import.meta.url), "utf8");
  const client = await readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8");
  const consoleSource = await readFile(new URL("../components/capability-center-v1.tsx", import.meta.url), "utf8");
  assert.match(store, /contractIntegrityFailure/);
  assert.match(store, /必须生成 rank:number 输入/);
  assert.match(store, /persistGeneratedCapabilitySpec/);
  assert.match(runner, /module_smoke_passed/);
  assert.match(runner, /provingRuns/);
  assert.match(client, /capturedLaunchToken/);
  assert.ok(client.indexOf("capturedLaunchToken") < client.indexOf("activePort.ready"));
  assert.match(duplicateCheckPrompt, /能力契约/);
});

test("browser evidence is organized by the exact authoring or validation run", async () => {
  const consoleSource = await readFile(new URL("../components/capability-center-v1.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(source_app_globals_css, /cap-v1-stage-trace/);
  assert.match(styles, /\.cap-v1-stage-trace/);
});

test("large browser evidence degrades safely when R2 is unavailable", async () => {
  const artifactRoute = await readFile(new URL("../app/api/artifacts/route.ts", import.meta.url), "utf8");
  const deploy = await readFile(new URL("../scripts/prepare-cloudflare-deploy.mjs", import.meta.url), "utf8");
  assert.match(artifactRoute, /artifact_requires_r2/);
  assert.match(artifactRoute, /2 \* 1024 \* 1024/);
  assert.match(deploy, /CLOUDFLARE_R2_BUCKET_NAME/);
});

test("AI-authored DSL and immutable ES Modules share the one-line runtime", async () => {
  const protocol = await readFile(new URL("../lib/site-knowledge/protocol.ts", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/site-agent-schema.ts", import.meta.url), "utf8");
  const store = await readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8");
  const port = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  const moduleRoute = await readFile(new URL("../app/programs/[...path]/route.ts", import.meta.url), "utf8");
  assert.match(protocol, /type AuthoredImplementation/);
  assert.match(protocol, /type AuthoringIteration/);
  assert.match(schema, /site_agent_v2_program_modules/);
  assert.match(store, /SHA-256/);
  assert.match(moduleRoute, /max-age=31536000, immutable/);
  assert.match(port, /webpackIgnore: true/);
  assert.match(port, /executeModule/);
  assert.doesNotMatch(port, /\beval\s*\(|new Function/);
});

test("execution and semantic model roles are isolated so a text model cannot silently break tool calls", async () => {
  const source = await readFile(new URL("../lib/model-config.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/site-agents/[siteAgentId]/model/v2/chat/completions/route.ts", import.meta.url), "utf8");
  const analyzer = await readFile(new URL("../lib/site-knowledge/model-analyzer.ts", import.meta.url), "utf8");
  assert.match(source, /"MODEL_EXECUTION", "MODEL", "OPENAI_MODEL"/);
  assert.match(source, /"MODEL_SEMANTIC", "MODEL", "OPENAI_MODEL"/);
  assert.match(route, /getModelConfig\(["']execution["']\)/);
  assert.match(analyzer, /getModelConfig\(["']semantic["']\)/);
});

test("a completed behavior record can explicitly start capability production", async () => {
  const [capabilityCenter, route, store] = await Promise.all([
    readFile(new URL("../components/capability-center-v1.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/site-agents/[siteAgentId]/capability-projects/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8"),
  ]);
  // The run-scoped entry point ("build a capability from this run") lived only in the unused
  // `Runs` inspector and was retired with it. Capability production is now
  // started from the capability center by goal; the server still accepts a
  // sourceEpisodeId, so the run-scoped path can be reintroduced without a
  // protocol change.
  assert.match(route, /sourceEpisodeId: typeof body\.sourceEpisodeId/);
  // It reaches the capability centre's proposal pipeline now. The store entry
  // point that used to receive it had no route of its own and is gone; the
  // protocol is unchanged, so a run-scoped path can still be reintroduced.
  const proposals = await readFile(new URL("../lib/capability-center/proposal-service.ts", import.meta.url), "utf8");
  assert.match(proposals, /sourceEpisodeId\?: string;/);
  assert.match(proposals, /sourceEpisodeId: claimed\.sourceEpisodeId/);
  assert.doesNotMatch(store, /createAutonomousCapabilityGoal/);
});

test("page-only goals keep the minimum explicit promise instead of inventing data outputs", async () => {
  const analyzer = await bundledModule("../lib/site-knowledge/model-analyzer.ts");
  const source = await readFile(new URL("../lib/site-knowledge/model-analyzer.ts", import.meta.url), "utf8");
  assert.equal(analyzer.explicitlyRequestsStructuredResult("按日期查看 2025 年 4 月 24 日热搜日榜"), false);
  assert.equal(analyzer.explicitlyRequestsStructuredResult("打开热搜日榜"), false);
  assert.equal(analyzer.explicitlyRequestsStructuredResult("返回当天热搜列表和数量"), true);
  assert.equal(analyzer.explicitlyRequestsStructuredResult("分析当天热搜趋势"), true);
  assert.match(source, /timeoutMs = 180_000/);
  assert.match(source, /required: completeResultFields\.filter\(\(field\) => field\.importance === "core"\)/);
});

test("capability reads are observational and never enqueue compensating retries", async () => {
  const store = await readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8");
  const reconcile = store.slice(store.indexOf("export async function reconcileCapabilityControl"), store.indexOf("export async function listCapabilityProjects"));
  assert.doesNotMatch(reconcile, /autoRecover|queueProjectRevision|status='queued'/);
  assert.match(store, /根因|re-explore|retry-validation/);
  assert.match(store, /DELETE FROM site_agent_v2_capability_projects/);
  assert.match(store, /normalizeGoal\(project\.goalTemplate/);
});

test("AI production telemetry and human checkpoints are first-class evidence", async () => {
  const protocol = await readFile(new URL("../lib/site-knowledge/protocol.ts", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/site-agent-schema.ts", import.meta.url), "utf8");
  const consoleSource = await consoleSources();
  const shared = await readFile(new URL("../client/user-agent-shared.ts", import.meta.url), "utf8");
  const modelRoute = await readFile(new URL("../app/api/site-agents/[siteAgentId]/model/v2/chat/completions/route.ts", import.meta.url), "utf8");
  for (const marker of ["ModelInvocation", "promptTokens", "completionTokens", "durationMs", "HumanCheckpoint"]) assert.match(protocol, new RegExp(marker));
  assert.match(schema, /site_agent_v2_model_invocations/);
  // The hand-back is enforced in the runtime, not explained in the console: the
  // page Agent recognises the sensitive control, redacts the page body, and
  // refuses to record the step. The console once carried a section describing
  // this; `settings.handoff` is still in the dictionary with no reader.
  assert.match(shared, /authentication page content redacted/);
  assert.match(shared, /sensitive_program_step/);
  assert.match(modelRoute, /(?:await|void) persist\(\{ status: "succeeded"/);
});

test("core runtime has no demo-specific branches", async () => {
  const files = [
    "../client/user-agent-port.ts", "../client/user-agent-shared.ts", "../client/user-agent-adaptive.ts",
    "../lib/site-knowledge/compiler.ts", "../lib/site-knowledge/discovery.ts",
    "../lib/site-knowledge/business-topology.ts", "../lib/site-knowledge/model-analyzer.ts",
    "../db/site-agent-store.ts",
  ];
  // Read the code, not the prose. Comments cite real sites as examples of a
  // problem ("明星热搜榜 … | 热搜时光机" is a bad area name), and the page Agent
  // matches what a visitor typed, where "加入购物车" is a verb on any shop.
  // Minifying keeps strings and drops comments, so what is left is a demo
  // site's proper nouns — the only thing that would make the core know one site.
  const built = await build({
    entryPoints: files.map((path) => fileURLToPath(new URL(path, import.meta.url))),
    bundle: false, write: false, minify: true, platform: "neutral", outdir: "out",
  });
  const code = built.outputFiles.map((file) => file.text).join("\n");
  assert.doesNotMatch(code, /Atlas Market|MarketLens|热搜时光机/);
  // The demo storefront the old second half read is no longer part of the
  // product; app/ holds the console and the API, and nothing else.
  await assert.rejects(() => readFile(new URL("../app/demo/page.tsx", import.meta.url), "utf8"));
});

test("console gives overview, agent, sessions, capabilities and knowledge one clear function", async () => {
  const [source, shellSource, consoleRouteSource, zh] = await Promise.all([
    consoleSources(),
    readFile(new URL("../components/site-agent-console.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/console/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/i18n/zh.ts", import.meta.url), "utf8"),
  ]);
  for (const label of ["概览", "智能体", "用户会话", "能力", "知识"])
    assert.match(zh, new RegExp(`label: "${label}"`));
  for (const label of ["网站预览", "最近会话", "网站知识"])
    assert.match(overviewCopySource, new RegExp(label));
  assert.doesNotMatch(shellSource, /EffectCenter|SettingsWorkspace/);
  assert.match(consoleRouteSource, /rawView === "runs" \|\| rawView === "effects"/);
  assert.match(consoleRouteSource, /rawView === "appearance"/);
  assert.match(consoleRouteSource, /buildBusinessTopology/);
  assert.match(source, /knowledgeTopology/);
  assert.match(src_lib_page_agent_control_plane_ts, /sitewake\.js/);
  assert.match(source, /no-homepage-iframe-v2/);
  assert.doesNotMatch(source, /sw-settings-preview|embedded-state|frame-ancestors/);
  assert.doesNotMatch(source, /TRUSTED WEBSITE MODEL|正在等待 SDK 握手|iframe 是体验层|后台浏览器验证/);
  assert.match(zh, /输入网站的公开地址/);
  assert.match(zh, /正在读取已接入网站/);
  assert.match(zh, /暂时无法读取网站列表/);
  assert.doesNotMatch(source, /MarketLens|打开 Atlas Market 演示|Atlas Market 已接入/);
});

test("capability workbench separates execution environment from evidence capture and scopes revision evidence", async () => {
  const [screen, protocol, store, runner, client] = await Promise.all([
    readFile(new URL("../components/capability-center-v2-screen.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/site-knowledge/protocol.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../runner/browser-runner.ts", import.meta.url), "utf8"),
    readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8"),
  ]);
  // Evidence capture is shown separately from the environment that produced it:
  // the module's hash and runtime on one side, the independent validation cases
  // on the other. The ad-hoc "run debug" button the v1 workbench had is gone —
  // re-exercising a capability is now a Task revalidation, which
  // tests/capability-center-redesign-v2.test.mjs covers.
  for (const key of ["moduleHash", "runtime", "validationCases", "viewValidationResult"]) {
    assert.match(screen, new RegExp(`copy\\.${key}\\b`), `the screen must render ${key}`);
  }
  assert.match(consoleCopyZh, /validationCases: "独立验证样例"/);
  assert.match(protocol, /type ExecutionMode = "run" \| "debug"/);
  assert.match(protocol, /kind: "connected-browser"/);
  assert.match(protocol, /kind: "cloud-browser"/);
  assert.match(protocol, /activeRevision\?: CapabilityRevision/);
  assert.match(protocol, /format\?: "date"/);
  assert.match(store, /createCapabilityRun/);
  // A run needs a real implementation to execute. The check moved from "this
  // capability has no module" to the Revision that would run: a published
  // Revision with an implementation, or a legacy plan whose Operations still
  // exist. Either way the refusal happens before any browser is leased.
  assert.match(store, /capability_run_revision_implementation_required/);
  assert.match(store, /capability_run_legacy_plan_unavailable/);
  assert.match(store, /withRevisionScopes/);
  assert.match(runner, /runPlaywrightCapabilityStages/);
  assert.match(runner, /lease\.capability\.module/);
  assert.match(client, /executionMode/);
  const runRoute = await readFile(new URL("../app/api/site-agents/[siteAgentId]/capabilities/[capabilityId]/runs/route.ts", import.meta.url), "utf8");
  // The refusal is a status contract rather than a sentence: every
  // `capability_run_*` code answers 409, and the code itself travels as the
  // message instead of a hand-written explanation per cause.
  assert.match(runRoute, /code\.startsWith\("capability_run_"\)[\s\S]{0,120}return 409;/);
  assert.match(runRoute, /capabilityRunErrorStatus\(code\)/);
  assert.match(runRoute, /message: code === "capability_run_create_failed"/);
});

test("runner readiness, cross-page handoff, agent tool activity, and observability are platform concerns", async () => {
  const [runner, port, client, consoleSource, protocol, store, leaseRoute] = await Promise.all([
    readFile(new URL("../runner/browser-runner.ts", import.meta.url), "utf8"),
    readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8"),
    readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8"),
    Promise.all([
      readFile(new URL("../components/site-agent-console.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/capability-center-v1.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/effect-center.tsx", import.meta.url), "utf8"),
    ]).then((parts) => parts.join("\n")),
    readFile(new URL("../lib/site-knowledge/protocol.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/validation/runners/[runnerId]/lease/route.ts", import.meta.url), "utf8"),
  ]);
  for (const marker of ["SITEWAKE_RUNNER_PREWARM", "SITEWAKE_RUNNER_CONCURRENCY", "BrowserReadyPool", "prewarmCapacity", "readySlots", "consume(\"interactive\", 350)", "consume(\"background\", 800)", "结果已返回，正在后台保存调试证据", "低清调试视频正在后台生成", 'quality: paths.evidenceMode === "full" ? 65 : 48']) assert.ok(runner.includes(marker), marker);
  assert.match(store, /RunnerWorkQueue = "any" \| "interactive" \| "background" \| "author" \| "validate"/);
  assert.match(store, /listCapabilityRuns/);
  assert.match(leaseRoute, /"interactive", "background", "author", "validate"/);
  assert.match(protocol, /prewarmCapacity\?: number/);
  assert.match(port, /restoreRun/);
  assert.match(port, /claimRun/);
  assert.match(port, /\/api\/agent-runs/);
  assert.match(port, /sitewake-run/);
  assert.match(port, /pageEpoch/);
  assert.match(port, /flushCheckpoint/);
  assert.match(widgetCopySource, /正在调用能力/);
  assert.match(port, /"capability", "navigation", "page"/);
  assert.match(port, /composeTaskResponse/);
  assert.equal((port.match(/id: capabilityActivityId, kind: activityKind, state: "running"/g) || []).length, 1);
  assert.match(port, /requiredParameters\.length === 1 && primitiveInputs\.length === 1/);
  assert.match(runner, /author_scene_binding_missing/);
  assert.match(runner, /author_scene_input_binding_invalid/);
  assert.doesNotMatch(runner, /extractList|extractOne|scrollToLoad|textOf/);
  assert.doesNotMatch(port, /extractList|extractOne|scrollToLoad|textOf/);
  assert.match(store, /validation_revision_superseded/);
  assert.match(store, /supersedeValidationStatements/);
  assert.match(client, /tool-activity/);
  for (const marker of ["使用记录", "可观察执行过程", "贡献归因"]) assert.match(consoleCopyZh, new RegExp(marker));
});

test("model-only capability design is recovered without requiring a browser runner", async () => {
  const [store, worker, dispatchRoute, deployPrepare, connectionRoute] = await Promise.all([
    readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/internal/learning-dispatch/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/prepare-cloudflare-deploy.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/api/site-agents/[siteAgentId]/connection/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(store, /export async function processQueuedLearningDesigns/);
  const lease = store.slice(store.indexOf("export async function leaseRunnerWork"), store.indexOf("export async function startBrowserRun"));
  assert.doesNotMatch(lease, /designLearningJob/);
  assert.match(worker, /async scheduled/);
  assert.match(worker, /api\/internal\/learning-dispatch/);
  assert.match(dispatchRoute, /processQueuedLearningDesigns/);
  // Site knowledge is not in background dispatch: review is a step of the crawl, no queue.
  assert.doesNotMatch(dispatchRoute, /KnowledgeReview/);
  assert.match(dispatchRoute, /runnerAuthorized/);
  assert.match(dispatchRoute, /unauthorized/);
  assert.match(deployPrepare, /crons: \["\* \* \* \* \*"\]/);
  // A widget connection only records the connection: no knowledge, no review triggered.
  assert.doesNotMatch(connectionRoute, /evaluateKnowledgeReview/);
  assert.doesNotMatch(connectionRoute, /after\(async \(\) =>/);
});

test("Cloudflare deploy rejects and verifies the retired iframe console", async () => {
  const deploy = await readFile(new URL("../scripts/deploy-cloudflare.mjs", import.meta.url), "utf8");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["deploy:cloudflare"], /scripts\/deploy-cloudflare\.mjs/);
  for (const marker of ["TRUSTED WEBSITE MODEL", "iframe 是体验层", "正在等待 SDK 握手"]) assert.match(deploy, new RegExp(marker));
  assert.match(deploy, /onlineConsole/);
  assert.match(deploy, /online_asset_digest_mismatch/);
  assert.match(deploy, /--keep-vars/);
});

test("validation releases and capability regeneration are repeatable, explicit actions", async () => {
  const [pkgRaw, releaseScript, consoleSource, store] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/release-validation.mjs", import.meta.url), "utf8"),
    readFile(new URL("../components/capability-center-v1.tsx", import.meta.url), "utf8"),
    readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8"),
  ]);
  const pkg = JSON.parse(pkgRaw);
  assert.match(pkg.scripts["release:validation"], /scripts\/release-validation\.mjs/);
  for (const command of ["lint", "test:evolution", "build", "server:deploy"]) assert.match(releaseScript, new RegExp(command));
  assert.match(consoleCopyZh, /重新构建/);
  assert.match(store, /线上版本保持不变/);
});

test("embedded websites perform an SDK handshake and page snapshots include product metadata evidence", async () => {
  const client = await readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8");
  const shared = await readFile(new URL("../client/user-agent-shared.ts", import.meta.url), "utf8");
  assert.match(client, /sitewake:embedded-state/);
  assert.match(client, /sitewake:embedded-command/);
  assert.equal((client.match(/:embedded-state"/g) || []).length, 1, "exactly one embedded-state message type");
  assert.match(client, /dataset\.allowFrame === "false"/);
  for (const evidence of ["application-name", "og:site_name", "application/ld+json", "canonical", "logoAlts"]) assert.match(shared, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
test("capability production uses one durable FIFO cursor across design, authoring, and validation", async () => {
  const source = await readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8");
  const designQueue = source.slice(source.indexOf("export async function processQueuedLearningDesigns"), source.indexOf("export async function registerValidationRunner"));
  const runnerQueue = source.slice(source.indexOf("export async function leaseRunnerWork"), source.indexOf("export async function startBrowserRun"));
  assert.match(designQueue, /status IN \('queued','leased','running'\).*ORDER BY created_at LIMIT 1/s);
  assert.match(designQueue, /if \(job\.phase !== "design"\) break/);
  assert.match(runnerQueue, /scanRunnerCandidates/);
  assert.match(runnerQueue, /const pipelineJob =/);
  assert.match(runnerQueue, /pipelineJob\.phase === "author"/);
  assert.match(runnerQueue, /pipelineJob\.phase !== "validate"/);
  assert.match(runnerQueue, /WHERE learning_job_id=\?/);
});

test("independent knowledge base is exposed as its own endpoint and rides the runtime release payload", async () => {
  const knowledgeRoute = await readFile(new URL("../app/api/site-agents/[siteAgentId]/knowledge/route.ts", import.meta.url), "utf8");
  const releaseRoute = await readFile(new URL("../app/api/site-agents/[siteAgentId]/release/route.ts", import.meta.url), "utf8");
  const knowledgeModel = await readFile(new URL("../lib/site-knowledge/knowledge-model.ts", import.meta.url), "utf8");
  // New endpoint returns the four-segment knowledge base and 404s a missing version.
  assert.match(knowledgeRoute, /loadSiteKnowledge/);
  assert.match(knowledgeRoute, /siteKnowledgeFromRelease\(canonicalizeReleaseKnowledge\(result\.release\)\)/);
  assert.match(knowledgeRoute, /return siteAgentJson\(\{ knowledge \}/);
  assert.match(knowledgeRoute, /site_knowledge_not_found/);
  // Only a non-negative integer is an explicit version; empty/malformed means latest.
  assert.match(knowledgeRoute, /Number\.isInteger\(parsedVersion\) && parsedVersion >= 0/);
  // Runtime release carries only the same sanitized knowledge graph exposed to
  // the SDK; management-only evidence must not be reintroduced here.
  assert.match(releaseRoute, /knowledge: sanitizePublicRuntime\(siteKnowledgeFromRelease\(release\)\)/);
  assert.match(releaseRoute, /runtimeFeatures = siteAgentRuntimeFeatures\(siteAgentId\)/);
  // Non-runtime response is unchanged (backward compatible).
  assert.match(releaseRoute, /: \{ release \};/);
  // The knowledge type carries only knowledge segments — no execution/config.
  // The business topology is not among them: it is derived from scenes and
  // links on demand (`buildBusinessTopology`), and storing a derived view beside
  // its own sources is how the two start disagreeing.
  for (const seg of [/profile: SiteProfile;/, /scenes: SceneDefinition\[\];/, /links: LinkReference\[\];/]) assert.match(knowledgeModel, seg);
  assert.doesNotMatch(knowledgeModel, /tree: SiteBusinessTopology;/);
  assert.doesNotMatch(knowledgeModel, /\b(operations|capabilities|targets|agentConfig):/);
});

test("Phase C: releases stored slim, rehydrated from the knowledge base on read", async () => {
  const store = await readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8");
  const model = await readFile(new URL("../lib/site-knowledge/knowledge-model.ts", import.meta.url), "utf8");
  // Read path rehydrates every release and lazily migrates un-migrated (embedded) rows.
  assert.match(store, /rehydrateRelease\(database, siteAgentId, release\)/);
  assert.match(store, /releaseEmbedsKnowledge\(release\)/);
  // Embedded rows canonicalize once, persist knowledge under its KnowledgeRevision,
  // then slim — knowledge is durable BEFORE the row drops its scenes (never orphan).
  assert.match(store, /const canonical = canonicalizeReleaseKnowledge\(release\);/);
  assert.match(store, /revision = await persistKnowledgeRevision\(database, siteAgentId, derived\)/);
  assert.match(store, /const resolved = \{ \.\.\.canonical, knowledgeRevision: revision \}/);
  assert.match(store, /slimStoredRelease\(database, siteAgentId, resolved, knowledge\)/);
  assert.match(store, /rehydrateReleaseKnowledge\(resolved, knowledge\)/);
  // Slim rows read their knowledge by the revision pointer, not release.version.
  assert.match(store, /const revision = knowledgeRevisionOf\(release\);/);
  assert.match(store, /readSiteKnowledgeRow\(database, siteAgentId, revision\)/);
  // Slim writer rewrites the stored row, scoped by id + site.
  assert.match(store, /UPDATE site_agent_v2_releases SET release_json=\? WHERE id=\? AND site_agent_id=\?/);
  // List summary reads the denormalized sceneCount (slim json has no $.scenes array).
  assert.match(store, /COALESCE\(json_extract\(r\.release_json, '\$\.sceneCount'\), json_array_length\(r\.release_json, '\$\.scenes'\)\)/);
  // Storage helpers exist and drop storage-only fields on rehydrate (contentHash stays stable).
  assert.match(model, /export function stripReleaseKnowledge/);
  assert.match(model, /export function rehydrateReleaseKnowledge/);
  assert.match(model, /delete rest\.knowledgeVersion/);
  assert.match(model, /delete rest\.sceneCount/);
});

test("Phase C: batchSlimReleases indexes embedded knowledge with bounded memory", async () => {
  const store = await readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/internal/migrate-releases/route.ts", import.meta.url), "utf8");
  assert.match(store, /export async function batchSlimReleases/);
  // Scans only lightweight ordered identities, then holds one large Release
  // payload at a time. Never bulk-load every release_json into the JS heap.
  assert.match(store, /SELECT id, site_agent_id AS siteAgentId FROM site_agent_v2_releases ORDER BY site_agent_id, version, id/);
  assert.match(store, /SELECT release_json AS releaseJson FROM site_agent_v2_releases WHERE id=\? AND site_agent_id=\? LIMIT 1/);
  assert.doesNotMatch(store, /SELECT id, site_agent_id AS siteAgentId, release_json AS releaseJson FROM site_agent_v2_releases/);
  assert.match(store, /return \{ scanned: identities\.length, migrated, skipped, failed \}/);
  assert.match(store, /if \(!releaseEmbedsKnowledge\(release\)\) \{ skipped\+\+; continue; \}/);
  // Dedups identical-content releases onto ONE shared revision, persisting FIRST.
  assert.match(store, /await persistKnowledgeRevision\(db, identity\.siteAgentId, derived\); \/\/ persist FIRST/);
  // Canonicalizes so scenes + execution graph stay consistent (same fix as the read path).
  assert.match(store, /const canonical = canonicalizeReleaseKnowledge\(release\);/);
  const batch = store.slice(store.indexOf("export async function batchSlimReleases"), store.indexOf("export async function batchCanonicalizeCapabilityCatalogs"));
  assert.doesNotMatch(batch, /stripReleaseKnowledge\(/, "the compatibility indexer does not rewrite immutable Release rows");
  assert.match(route, /batchSlimReleases/);
});

test("canonical catalog migration types nullable revision guards for PostgreSQL", async () => {
  const store = await readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8");
  assert.match(store, /active_revision_id IS NULL AND CAST\(\? AS TEXT\) IS NULL/);
  assert.match(store, /latest_revision_id IS NULL AND CAST\(\? AS TEXT\) IS NULL/);
  assert.doesNotMatch(store, /active_revision_id IS NULL AND \? IS NULL/);
  assert.doesNotMatch(store, /latest_revision_id IS NULL AND \? IS NULL/);
});

test("Phase C (4.1): KnowledgeRevision is independent of RuntimeRelease version", async (t) => {
  // The durable proof of the split: a config/capability-only publish bumps the
  // RELEASE version but NOT the knowledge revision (no new knowledge row); only a
  // material knowledge change advances the revision. Read always resolves the right
  // knowledge by the revision pointer.
  const isolated = await isolatedD1Database();
  t.after(isolated.dispose);
  const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
  const siteAgentId = "revision-split-site";
  await store.createSiteAgent({ id: siteAgentId, name: "Revision Split", url: "https://rev.test/" });
  const snap = (url, heading, links = []) => ({ id: `s-${url}`, sessionId: "b1", documentId: "d1", sequence: 0, url, title: heading, heading, visibleText: heading, links, capturedAt: now });
  const overview = async () => (await store.getSiteAgentOverview(siteAgentId)).overview;
  const knowledgeRows = async () => (await isolated.database.prepare(`SELECT version, content_hash AS contentHash FROM site_agent_v2_knowledge WHERE site_agent_id=? ORDER BY version`).bind(siteAgentId).all()).results;

  // 1. The crawl creates the first substantive knowledge. **Crawling is the only source
  //    of knowledge** — widget connections only record the connection and no longer
  //    produce knowledge, so connections cannot seed data here anymore.
  const adopt = async (pages) => {
    const knowledge = await bundledModule("../lib/site-knowledge/crawl-knowledge.ts");
    const document = knowledge.assembleSiteKnowledgeDocument({
      siteAgentId, origin: "https://rev.test", crawledAt: now, seeds: ["https://rev.test/"], snapshots: pages, urlsSeen: pages.length,
    });
    await store.adoptCrawlDocument(siteAgentId, document);
  };
  await adopt([snap("https://rev.test/orders", "订单列表", [{ text: "订单详情", url: "https://rev.test/orders/1" }])]);
  let ov = await overview(); // read triggers rehydrate → persists the revision row
  const baseVersion = ov.activeRelease.version;
  const baseRevision = ov.activeRelease.knowledgeRevision;
  assert.equal(typeof baseRevision, "number", "the release carries a first-class knowledgeRevision");
  const rowsAfterConnect = (await knowledgeRows()).length;
  assert.ok(rowsAfterConnect >= 1, "material knowledge is persisted as a revision row");

  // 2. TWO config-only publishes: neither the Release nor the revision moves.
  // A config write replaces the whole config rather than patching it — the
  // editor always submits every field — so both publishes carry appearance.
  await store.updateSiteAgent(siteAgentId, { agentConfig: { appearance: { preset: "dock", palette: "violet", launcherPosition: "bottom-left" } } });
  await store.updateSiteAgent(siteAgentId, { agentConfig: { appearance: { preset: "dock", palette: "coral", launcherPosition: "bottom-left" } } });
  ov = await overview();
  // Config is neither knowledge nor a Release. This assertion used to expect a
  // version bump, from when widget presentation lived inside the immutable
  // Release snapshot: recolouring the widget minted a knowledge version, which
  // then failed the execution pin a queued task had already taken.
  // tests/release-version-tracks-knowledge.test.mjs holds that line from both sides.
  assert.equal(ov.activeRelease.version, baseVersion, "a config publish must not mint a knowledge version");
  assert.equal(ov.activeRelease.agentConfig.appearance.palette, "coral", "the last config write is the one that stands");
  assert.equal(ov.activeRelease.knowledgeRevision, baseRevision, "the knowledge revision stayed FLAT across config publishes");
  assert.equal((await knowledgeRows()).length, rowsAfterConnect, "config publishes wrote NO new knowledge row (content-hash dedup)");
  const readBack = (await store.loadSiteKnowledge(siteAgentId)).knowledge;
  assert.deepEqual(readBack.scenes.map((s) => s.id).sort(), ov.activeRelease.scenes.map((s) => s.id).sort(), "read still resolves the correct knowledge after config publishes");

  // 3. A material change (a genuinely new page) advances the revision by exactly one.
  await adopt([
    snap("https://rev.test/orders", "订单列表", [{ text: "订单详情", url: "https://rev.test/orders/1" }]),
    snap("https://rev.test/account", "账户中心"),
  ]);
  ov = await overview();
  assert.equal(ov.activeRelease.knowledgeRevision, baseRevision + 1, "a material change advanced the knowledge revision by one");
  const finalRows = await knowledgeRows();
  assert.equal(finalRows.length, rowsAfterConnect + 1, "the new material state added exactly one knowledge row");
  assert.notEqual(finalRows[finalRows.length - 1].contentHash, finalRows[finalRows.length - 2].contentHash, "the two revisions carry distinct material content");
});

test("Phase C (4.1): concurrent distinct-content persists never clobber a revision", async (t) => {
  // Regression for the review's confirmed race: two concurrent persists of DIFFERENT
  // content for one site must not both take MAX+1 and clobber each other (silent
  // knowledge loss). The compare-and-set (INSERT OR IGNORE + verify + retry) must give
  // them DISTINCT revisions and preserve a pre-existing row untouched. Against the old
  // read-then-REPLACE code this fails: one content overwrites the other at MAX+1.
  const isolated = await isolatedD1Database();
  t.after(isolated.dispose);
  const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
  const siteAgentId = "revision-race-site";
  await store.createSiteAgent({ id: siteAgentId, name: "Race", url: "https://race.test/" }); // ensures schema
  const mk = (contentHash) => ({ schemaVersion: "site-knowledge/v1", siteAgentId, version: 0, contentHash, updatedAt: now, profile: { name: "race", description: "" }, scenes: [], links: [], tree: {} });
  // Pre-seed a distinct-content row so both racers allocate MAX+1 (=6), not the empty-table
  // fallback (which uses knowledge.version and would not collide).
  await isolated.database.prepare(`INSERT OR IGNORE INTO site_agent_v2_knowledge (site_agent_id, version, content_hash, knowledge_json, created_at) VALUES (?, ?, ?, ?, ?)`).bind(siteAgentId, 5, "H_OTHER", JSON.stringify(mk("H_OTHER")), now).run();

  // Interleaved at the awaits: both existence-miss, both read MAX=5, both target 6.
  const [revA, revB] = await Promise.all([store.persistKnowledgeRevision(isolated.database, siteAgentId, mk("HA")), store.persistKnowledgeRevision(isolated.database, siteAgentId, mk("HB"))]);
  assert.notEqual(revA, revB, "distinct content got DISTINCT revisions (no clobber-collision)");

  const rows = (await isolated.database.prepare(`SELECT version, content_hash AS contentHash FROM site_agent_v2_knowledge WHERE site_agent_id=? ORDER BY version`).bind(siteAgentId).all()).results;
  const byHash = Object.fromEntries(rows.map((r) => [r.contentHash, r.version]));
  assert.equal(byHash.H_OTHER, 5, "the pre-existing row was never overwritten");
  assert.ok(byHash.HA != null && byHash.HB != null, "BOTH contents persisted — neither was lost");
  assert.equal(new Set(rows.map((r) => r.version)).size, rows.length, "no revision holds two contents");
  // Idempotent re-persist returns the SAME revision, writes nothing new.
  assert.equal(await store.persistKnowledgeRevision(isolated.database, siteAgentId, mk("HA")), revA, "re-persisting identical content reuses its revision");
  assert.equal((await isolated.database.prepare(`SELECT COUNT(*) AS n FROM site_agent_v2_knowledge WHERE site_agent_id=?`).bind(siteAgentId).first()).n, rows.length, "re-persist wrote no new row");
});

test("console reads the knowledge base the server serves (overview.knowledge), not the release", async () => {
  const store = await readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8");
  const consoleSource = await consoleSources();
  // Server ships the independent knowledge base in the overview payload (both paths).
  assert.match(store, /knowledge: siteKnowledgeFromRelease\(release\)/);
  assert.match(store, /knowledge: siteKnowledgeFromRelease\(agent\.release\)/);
  // The knowledge view derives its topology from overview.knowledge (scenes + links),
  // recomputed on demand — the topology is no longer stored on the knowledge base.
  const consoleRouteSource = await readFile(new URL("../lib/console/route.ts", import.meta.url), "utf8");
  assert.match(consoleRouteSource, /overview\.knowledge/);
  assert.match(consoleRouteSource, /buildBusinessTopologyFromParts/);
  assert.match(consoleSource, /knowledgeTopology\(overview\)/);
});

test("knowledge search: a keyword miss returns empty and records nothing (no answer-route layer)", async (t) => {
  const isolated = await isolatedD1Database();
  t.after(isolated.dispose);
  const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
  const site = "search-miss-site";
  await store.createSiteAgent({ id: site, name: "SM", url: "https://sm.test/" });
  // A page whose body shares no term with the query.
  await store.ingestSiteContentPages(site, [{ url: "https://sm.test/guide", visibleText: "aardvark zebra quux lorem ipsum unrelated ascii body text here" }]);
  // A literal miss: empty result (no fuzzy fallback), and no persistence side effect.
  const result = await store.searchSiteContent(site, ["紫色大象会飞吗"]);
  assert.equal(result.pages.length, 0, "a miss returns no pages");
  assert.equal(result.totalPagesWithHits, 0, "a miss reports zero breadth");
  // No answer-route/gap table is written (they no longer exist / are never created).
  const info = (await isolated.database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='site_agent_v2_answer_routes'`).all()).results;
  assert.equal(info.length, 0, "no answer-route table is created by a search miss");

  // A literal hit returns the page with context and honest breadth.
  await store.ingestSiteContentPages(site, [{ url: "https://sm.test/minor", visibleText: "未成年人使用本服务需监护人同意，未成年保护专项条款见此。" }]);
  const hit = await store.searchSiteContent(site, ["小孩", "未成年", "儿童"]);
  assert.equal(hit.pages.length, 1, "the synonym keyword catches the page");
  assert.equal(hit.pages[0].url, "https://sm.test/minor");
  assert.ok(hit.pages[0].matchedKeywords.includes("未成年"), "reports which keyword hit");
});

test("knowledge probe: diagnosis separates knowledge gap from search/expansion problem", async (t) => {
  const isolated = await isolatedD1Database();
  t.after(isolated.dispose);
  const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
  const site = "probe-site";
  await store.createSiteAgent({ id: site, name: "PB", url: "https://pb.test/" });
  await store.ingestSiteContentPages(site, [{ url: "https://pb.test/privacy", visibleText: "未成年人保护：不会收集未满十四周岁儿童的个人信息，监护人可联系删除。" }]);

  // (a) answerable: the keyword hits a page.
  const answerable = await store.probeContentDiagnosis(site, ["未成年", "儿童"], "小孩能玩吗");
  assert.equal(answerable.pages.length, 1, "keyword hits → pages present (answerable)");

  // (b) search/expansion problem: grep on the given keywords misses, BUT the question's own
  // terms ARE on the site (the content exists, expansion/matching just missed it).
  const searchGap = await store.probeContentDiagnosis(site, ["青少年"], "未成年可以用吗");
  assert.equal(searchGap.pages.length, 0, "these keywords do not literally hit");
  assert.equal(searchGap.coverageOfQuery.appears, true, "but the question's terms appear on a page → search problem");
  assert.ok(searchGap.coverageOfQuery.sampleUrls.includes("https://pb.test/privacy"));

  // (c) knowledge gap: neither the keywords nor the question's terms appear anywhere.
  const knowledgeGap = await store.probeContentDiagnosis(site, ["股票", "证券"], "股票怎么买");
  assert.equal(knowledgeGap.pages.length, 0);
  assert.equal(knowledgeGap.coverageOfQuery.appears, false, "terms appear nowhere → genuine knowledge gap");

  // Read-only: the probe wrote nothing.
  const chunkCount = (await isolated.database.prepare(`SELECT COUNT(*) AS n FROM site_agent_v2_content WHERE site_agent_id=?`).bind(site).first()).n;
  assert.equal(chunkCount, 1, "probe made no writes to the content index");
});

test("content coverage: counts indexed pages and lists scenes with no body text", async (t) => {
  const isolated = await isolatedD1Database();
  t.after(isolated.dispose);
  const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
  const site = "coverage-site";
  await store.createSiteAgent({ id: site, name: "CV", url: "https://cov.test/" });
  await store.ingestSiteContentPages(site, [
    { url: "https://cov.test/a", visibleText: "关于页面的正文内容，介绍网站用途与边界。" },
    { url: "https://cov.test/b/1", visibleText: "实例详情页的正文，某条具体记录的内容。" },
  ]);
  const scene = (id, name, pattern) => ({ id, name, urlTemplates: [{ id: "u-" + id, originPattern: "https://cov.test", pathnamePattern: pattern, query: {} }], parameters: [], verifier: {}, directEntry: "verified", evidenceStatus: "crawled", sourceObservationIds: [], updatedAt: now });
  const scenes = [scene("s-a", "关于", "/a"), scene("s-b", "详情", "/b/{id}"), scene("s-empty", "空白页", "/empty")];
  const cov = await store.contentCoverage(isolated.database, site, scenes);
  assert.equal(cov.indexedPages, 2, "two distinct urls carry content");
  assert.ok(cov.totalChunks >= 2, "chunks counted");
  assert.equal(cov.scenesTotal, 3);
  // /a matches its literal scene; /b/1 matches the /b/{id} template; /empty has nothing.
  assert.deepEqual(cov.emptyPages.map((p) => p.sceneId), ["s-empty"], "only the no-content scene is listed as 待补内容");
});
