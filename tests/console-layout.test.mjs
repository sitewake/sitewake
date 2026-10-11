import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

/**
 * Layout smoke net for the console.
 *
 * Stage 3 of the refinement plan moves several thousand lines between files.
 * Unit tests assert data shape and cannot see that a grid collapsed or a panel
 * vanished, so this renders each tab in both its empty and populated state and
 * records structural signatures — which landmarks exist, how many rows, whether
 * anything overflows its viewport.
 *
 * Signatures live in tests/__layout__/. If a refactor changes one, the test
 * fails with a diff; re-record deliberately with UPDATE_LAYOUT_SNAPSHOTS=1
 * after confirming the change in a browser.
 */

const SNAPSHOT_DIR = new URL("./__layout__/", import.meta.url);
const UPDATE = process.env.UPDATE_LAYOUT_SNAPSHOTS === "1";

const TABS = ["overview", "agent", "sessions", "capabilities", "model", "settings"];

const NOW = "2026-01-15T10:00:00.000Z";

function profile(overrides = {}) {
  return {
    name: "示例商城",
    description: "一个用于验证的电商网站。",
    entryUrl: "https://shop.example/",
    allowedOrigins: ["https://shop.example"],
    vocabulary: {},
    suggestedGoals: ["搜索商品", "查看购物车"],
    businessDomains: [{ name: "商品", description: "浏览与搜索商品" }],
    ...overrides,
  };
}

/** A Scene shaped like SceneDefinition, which the topology projection requires. */
function scene({ id, name, pathname, area }) {
  return {
    id,
    name,
    businessArea: area,
    evidenceStatus: "observed",
    origin: "usage",
    origins: ["usage"],
    aliases: { titles: [], headings: [] },
    urlTemplates: [
      {
        id: `${id}-template`,
        originPattern: "https://shop.example",
        pathnamePattern: pathname,
        query: {},
      },
    ],
    parameters: [],
    verifier: { titleIncludes: [name], headingIncludes: [] },
    directEntry: "verified",
    sourceObservationIds: [],
    updatedAt: NOW,
  };
}

function release({ id = "shop", version = 3, capabilities = [], scenes = [] } = {}) {
  return {
    id: `release-${version}`,
    siteAgentId: id,
    version,
    createdAt: NOW,
    contentHash: version ? "abc123" : "0",
    profile: profile(),
    capabilities,
    scenes,
    operations: [],
    targets: [],
  };
}

/** Structurally complete overview, matching SiteAgentOverview. */
function populatedOverview() {
  return {
    id: "shop",
    profile: profile(),
    connection: { url: "https://shop.example/", origin: "https://shop.example", connectedAt: NOW },
    activeReleaseVersion: 3,
    sceneCount: 2,
    capabilityCount: 1,
    taskCount: 2,
    episodeCount: 2,
    updatedAt: NOW,
    persistence: "memory",
    modelConfigured: true,
    activeRelease: release({
      capabilities: [
        {
          id: "capability-search",
          kind: "task",
          exposure: "public",
          status: "available",
          name: "搜索商品",
          description: "按关键词搜索商品并返回结果。",
          normalizedGoal: "搜索商品",
          aliases: ["搜索商品"],
          inputs: { type: "object", properties: { keyword: { type: "string", description: "关键词" } }, required: ["keyword"] },
          outputs: { type: "object", properties: {} },
          outcomes: [],
          plans: [],
          sourceEpisodeIds: ["episode-1"],
          confidence: 0.9,
          updatedAt: NOW,
        },
      ],
      scenes: [
        scene({ id: "scene-home", name: "首页", pathname: "/", area: "网站入口" }),
        scene({ id: "scene-search", name: "搜索结果", pathname: "/search", area: "商品" }),
        scene({ id: "scene-product", name: "商品详情", pathname: "/products/{id}", area: "商品" }),
      ],
    }),
    recentEpisodes: [
      {
        id: "episode-1",
        siteAgentId: "shop",
        goal: "搜索无线耳机",
        mode: "compiled",
        status: "completed",
        outcome: { status: "success", code: "completed", summary: "已找到 12 个结果", evaluatedAt: NOW },
        startedAt: NOW,
        endedAt: NOW,
      },
      {
        id: "episode-2",
        siteAgentId: "shop",
        goal: "查询订单状态",
        mode: "adaptive",
        status: "failed",
        outcome: { status: "execution-fault", code: "target_not_found", summary: "页面目标发生变化", evaluatedAt: NOW },
        startedAt: NOW,
        endedAt: NOW,
      },
    ],
    activeSessions: [],
    candidates: [],
    learningJobs: [],
    validationJobs: [],
    browserRuns: [],
    artifacts: [],
    runners: [],
  };
}

/**
 * A site that was just connected: every collection is empty.
 *
 * The connection record must exist: a site that never handshook now belongs to the
 * onboarding flow and never renders the console. This fixture wants "connected but
 * learned nothing yet", exactly the state every page's empty state must hold.
 */
function emptyOverview() {
  const blank = profile({ name: "新接入网站", description: "", entryUrl: undefined, allowedOrigins: [], suggestedGoals: [], businessDomains: [] });
  return {
    id: "fresh",
    profile: blank,
    connection: { url: "https://fresh.example/", origin: "https://fresh.example", connectedAt: NOW, lastSeenAt: NOW, siteAgentId: "fresh", title: "新接入网站", heading: "新接入网站" },
    activeReleaseVersion: 0,
    sceneCount: 0,
    capabilityCount: 0,
    taskCount: 0,
    episodeCount: 0,
    updatedAt: NOW,
    persistence: "memory",
    modelConfigured: false,
    activeRelease: { ...release({ id: "fresh", version: 0 }), profile: blank },
    recentEpisodes: [],
    activeSessions: [],
    candidates: [],
    learningJobs: [],
    validationJobs: [],
    browserRuns: [],
    artifacts: [],
    runners: [],
  };
}

/** The agent-list payload, which carries its own profile per entry. */
function agentSummary(overview) {
  return {
    id: overview.id,
    profile: overview.profile,
    connection: overview.connection,
    activeReleaseVersion: overview.activeReleaseVersion,
    sceneCount: overview.sceneCount,
    capabilityCount: overview.capabilityCount,
    taskCount: overview.taskCount,
    episodeCount: overview.episodeCount,
    updatedAt: overview.updatedAt,
  };
}

/** Bundles the real console component with a client-side entry point. */
async function bundleConsole() {
  const result = await build({
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client";
        import { SiteAgentConsole } from ${JSON.stringify(fileURLToPath(new URL("../components/site-agent-console.tsx", import.meta.url)))};
        createRoot(document.getElementById("root")).render(<SiteAgentConsole initialRunnerMode="full" locale="zh" />);
      `,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      loader: "tsx",
    },
    bundle: true,
    format: "iife",
    jsx: "automatic",
    write: false,
    logLevel: "silent",
    banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "production" } };' },
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty" },
  });
  return result.outputFiles[0].text;
}

const [consoleScript, css] = await Promise.all([
  bundleConsole(),
  Promise.all(["../app/globals.css", "../app/console-polish.css", "../components/console/sidebar.css"].map(path => readFile(new URL(path, import.meta.url), "utf8"))).then(parts => parts.join("\n")),
]);

async function consoleServer(overview, { jobs = [], probe, agents: agentsOverride, publishedCapabilities = [] } = {}) {
  const agents = agentsOverride || [agentSummary(overview)];
  const server = createServer((request, response) => {
    const url = request.url || "/";
    const json = (body) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url === "/app.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(consoleScript);
      return;
    }
    if (url === "/globals.css") {
      response.writeHead(200, { "content-type": "text/css" });
      response.end(css);
      return;
    }
    if (url.startsWith("/api/admin/capability-v2/experiences")) return json({ intakes: [], blockedReason: "capability-call" });
    if (url.startsWith("/api/admin/capability-v2/capabilities")) return json({ capabilities: publishedCapabilities });
    if (url === "/api/system/status") return json({ environment: "development", database: "SQLite / D1", artifactsConfigured: false, build: "development", models: Object.fromEntries(["general", "execution", "semantic"].map(role => [role, { configured: true, model: "test-model" }])) });
    if (url === "/api/site-agents") return json({ agents });
    if (url.startsWith("/api/site-agents/") && url.includes("/session-history/")) return json({ detail: { fact: { goal: "搜索台灯", status: "completed", outcomeStatus: "success", outcomeSummary: "找到 3 件商品", endedAt: NOW }, conversation: [], activityTimeline: [], replayChunks: [] } });
    if (url.startsWith("/api/site-agents/") && url.includes("/session-history")) return json({ records: [], total: 0 });
    if (url.startsWith("/api/site-agents/") && url.includes("/preview")) return json({});
    if (url.startsWith("/api/site-agents/") && url.includes("/crawl")) return json(request.method === "GET" ? { jobs } : { persistence: "d1" });
    if (url.startsWith("/api/site-agents/") && url.includes("/knowledge-probe")) {
      const question = decodeURIComponent((url.split("question=")[1] || "").split("&")[0]);
      return json(probe ? probe(question) : { expandedKeywords: [], pages: [], routes: [], totalPagesWithHits: 0, diagnosis: "knowledge_gap", coverageOfQuery: { appears: false, sampleUrls: [] } });
    }
    if (url.startsWith("/api/site-agents/") && url.includes("/content")) return json({ chunks: [] });
    if (url.startsWith("/api/site-agents/") && url.includes("/effects/summary")) {
      // Matches EffectTrackingSummary. All queue counters are 0 so the view
      // does not start its 5s polling interval and hang the test.
      return json({
        summary: {
          range: { from: NOW, to: NOW },
          queue: { queued: 0, analyzing: 0, reviewing: 0, completed: 2, failed: 0 },
          goal: { achieved: 1, analyzed: 2, rate: 0.5 },
          capability: { contributed: 1, invoked: 2, rate: 0.5 },
          pendingImprovements: 1,
        },
      });
    }
    if (url.startsWith("/api/site-agents/") && url.includes("/effects")) {
      return json({ records: [], total: 0 });
    }
    if (url.startsWith("/api/site-agents/") && url.includes("/capability-projects")) {
      return json({ projects: [] });
    }
    if (url.startsWith("/api/site-agents/")) return json(overview);
    if (url.startsWith("/api/")) return json({});
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/globals.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>`);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function launchTestBrowser() {
  const configuredChannel = process.env.SITEWAKE_BROWSER_CHANNEL?.trim();
  const channel = configuredChannel || (process.platform === "win32" ? "chrome" : undefined);
  return chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
}

/**
 * Captures a structural signature of the rendered page. Deliberately records
 * shape rather than pixels: pixel diffs are brittle across platforms and font
 * stacks, while "the stat grid lost a column" is exactly what a refactor breaks.
 */
async function layoutSignature(page) {
  return page.evaluate(() => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const count = (selector) => document.querySelectorAll(selector).length;
    const overflowing = Array.from(document.querySelectorAll("*"))
      .filter((node) => visible(node) && node.scrollWidth > node.clientWidth + 2 && getComputedStyle(node).overflowX === "visible")
      .map((node) => node.className?.toString?.().slice(0, 40))
      .filter(Boolean);
    return {
      headings: Array.from(document.querySelectorAll("h1,h2,h3")).filter(visible).map((n) => n.textContent.trim().slice(0, 40)),
      landmarks: {
        nav: count("nav"),
        tablist: count('[role="tablist"]'),
        tabs: count('[role="tab"]'),
        tables: count("table,[role='table']"),
        buttons: count("button:not([disabled])"),
      },
      // Any element wider than its container with visible overflow is a
      // horizontal-scroll bug waiting to happen.
      unexpectedOverflow: [...new Set(overflowing)].sort(),
      documentOverflowsViewport: document.documentElement.scrollWidth > window.innerWidth + 2,
    };
  });
}

async function readSnapshot(name) {
  try {
    return JSON.parse(await readFile(new URL(`${name}.json`, SNAPSHOT_DIR), "utf8"));
  } catch {
    return undefined;
  }
}

async function writeSnapshot(name, value) {
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  await writeFile(new URL(`${name}.json`, SNAPSHOT_DIR), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Serves the console against a fixture, opens one tab and hands the page to
 * `run`. Every uncaught render error is collected in `crashes` — a component
 * that throws leaves an empty #root, which a selector-based check would happily
 * read as "rendered". Callers assert on `crashes` themselves.
 */
async function withTab({ overview, tab, width = 1440, jobs, probe, publishedCapabilities }, run) {
  const { server, origin } = await consoleServer(overview, { jobs, probe, publishedCapabilities });
  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const crashes = [];
    page.on("pageerror", (error) => crashes.push(error?.stack || String(error)));
    const url = tab === "overview" ? origin : `${origin}/?view=${tab}`;
    await page.goto(url);
    // The console hydrates and then fetches; wait for real content, not a timer.
    try {
      await page.waitForSelector(".sw-shell, .sw-welcome", { timeout: 15_000 });
    } catch (error) {
      const body = await page.locator("body").innerText().catch(() => "");
      throw new Error(`console did not render ${tab}; pageErrors=${JSON.stringify(crashes)}; body=${body.slice(0, 500)}`, { cause: error });
    }
    await page.waitForLoadState("networkidle").catch(() => undefined);
    return await run(page, crashes);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function captureTab(options) {
  const { tab } = options;
  return withTab(options, async (page, crashes) => {
    const signature = await layoutSignature(page);
    assert.deepEqual(crashes, [], `console threw while rendering the ${tab} tab`);
    assert.ok(
      signature.headings.length > 0 || signature.landmarks.buttons > 0,
      `the ${tab} tab rendered nothing at all — the fixture or the component is broken`,
    );
    return signature;
  });
}

for (const tab of TABS) {
  test(`console ${tab} tab layout is stable when populated`, async () => {
    const signature = await captureTab({ overview: populatedOverview(), tab });
    const name = `${tab}-populated`;
    const expected = await readSnapshot(name);
    if (!expected || UPDATE) {
      await writeSnapshot(name, signature);
      assert.ok(signature.headings.length >= 0);
      return;
    }
    assert.deepEqual(signature, expected);
  });
}

// One baseline each for site settings (with the "delete site" danger zone at the bottom) and the system settings site list (with "delete" per row).
for (const view of [
  { name: "website-settings-populated", tab: "connection", expect: ".sw-settings-danger .sw-danger-button" },
  { name: "system-sites-populated", tab: "settings&section=sites", expect: ".sw-managed-site .sw-managed-site-delete" },
]) {
  test(`console ${view.name} layout is stable and carries the delete affordance`, async () => {
    const signature = await withTab({ overview: populatedOverview(), tab: view.tab }, async (page, crashes) => {
      await page.waitForSelector(view.expect, { timeout: 15_000 });
      assert.deepEqual(crashes, [], `console threw while rendering ${view.name}`);
      // Rendering alone sends no write request: deletion needs dialog confirmation.
      assert.equal(await page.locator(".sa-modal").count(), 0);
      return layoutSignature(page);
    });
    const expected = await readSnapshot(view.name);
    if (!expected || UPDATE) {
      await writeSnapshot(view.name, signature);
      assert.ok(signature.landmarks.buttons > 0);
      return;
    }
    assert.deepEqual(signature, expected);
  });
}

test("delete affordances stay inside the viewport and off the row body on a phone", async () => {
  for (const view of [
    { tab: "connection", button: ".sw-settings-danger .sw-danger-button", body: ".sw-settings-danger strong" },
    { tab: "settings&section=sites", button: ".sw-managed-site .sw-managed-site-delete", body: ".sw-managed-site .sw-managed-site-open" },
  ]) {
    await withTab({ overview: populatedOverview(), tab: view.tab, width: 400 }, async (page, crashes) => {
      await page.waitForSelector(view.button, { timeout: 15_000 });
      assert.deepEqual(crashes, []);
      const signature = await layoutSignature(page);
      assert.equal(signature.documentOverflowsViewport, false, `${view.tab} overflows a 400px viewport`);
      assert.deepEqual(signature.unexpectedOverflow, []);
      const [button, body] = await Promise.all([
        page.locator(view.button).first().boundingBox(),
        page.locator(view.body).first().boundingBox(),
      ]);
      assert.ok(button && body, "both the delete button and the row body render");
      const overlaps = button.x < body.x + body.width && body.x < button.x + button.width && button.y < body.y + body.height && body.y < button.y + button.height;
      assert.equal(overlaps, false, `${view.tab}: the delete button overlaps the row body at 400px`);
      assert.ok(button.x + button.width <= 400 + 1, "the delete button is inside the viewport");
    });
  }
});

test("console renders a deliberate first-run state rather than empty panels", async () => {
  const signature = await captureTab({ overview: emptyOverview(), tab: "overview" });
  const expected = await readSnapshot("overview-empty");
  if (!expected || UPDATE) {
    await writeSnapshot("overview-empty", signature);
  } else {
    assert.deepEqual(signature, expected);
  }
  // A fresh console must still say something and offer a next step.
  assert.ok(signature.headings.length > 0, "first-run console has no headings at all");
  assert.ok(signature.landmarks.buttons > 0, "first-run console offers no action");
});

test("console does not overflow the viewport at tablet and mobile widths", async () => {
  for (const width of [768, 390]) {
    const signature = await captureTab({ overview: populatedOverview(), tab: "overview", width });
    assert.equal(
      signature.documentOverflowsViewport,
      false,
      `console overflows horizontally at ${width}px, which forces sideways scrolling`,
    );
  }
});

test("sidebar keeps desktop labels aligned and mobile drawer restores keyboard focus", async () => {
  const { server, origin } = await consoleServer(populatedOverview());
  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(origin);
    await page.waitForSelector(".sw-console-navigation");
    for (const width of [1440, 1280, 1024, 821]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await page.evaluate(() => {
        const rail = document.querySelector(".sw-console-sidebar").getBoundingClientRect();
        const main = document.querySelector(".sw-main").getBoundingClientRect();
        return { width: rail.width, right: rail.right, mainLeft: main.left,
          settingsHeight: document.querySelector(".sw-console-settings").getBoundingClientRect().height,
          labels: [...document.querySelectorAll(".sw-console-navigation button > span")].map(n => n.getBoundingClientRect().height) };
      });
      assert.equal(layout.width, 232);
      assert.equal(layout.right, layout.mainLeft, "sidebar track and actual width stay identical");
      assert.deepEqual(layout.labels, [20, 20, 20, 20, 20]);
      assert.equal(layout.settingsHeight, 44, "settings never wraps vertically");
    }
    for (const width of [768, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const trigger = page.getByRole("button", { name: "打开导航", exact: true });
      assert.equal(await page.locator(".sw-console-sidebar").isVisible(), false);
      await trigger.click();
      assert.equal(await page.getByRole("dialog").isVisible(), true);
      assert.equal(await page.locator(".sw-main").getAttribute("inert"), "");
      assert.equal(await page.getByRole("button", { name: "系统设置", exact: true }).isVisible(), true);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".sw-console-sidebar").isVisible(), false);
      assert.equal(await trigger.evaluate(n => n === document.activeElement), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test("layout snapshots are committed so refactors have something to diff against", async () => {
  const files = await readdir(SNAPSHOT_DIR).catch(() => []);
  assert.ok(
    files.filter((name) => name.endsWith(".json")).length >= TABS.length,
    "expected one committed layout snapshot per console tab",
  );
});

test("读取状态行的读秒有独立的 1 秒时钟，不搭在任务轮询上", async () => {
  const panel = await readFile(new URL("../components/console/site-model.tsx", import.meta.url), "utf8");
  // The seconds counter needs its own 1 s interval. It used to ride the 3 s job poll, so the stopwatch jumped in 3 s steps.
  assert.match(panel, /setInterval\(\(\) => setNow\(Date\.now\(\)\), 1_000\)/, "读秒应有独立的 1 秒 interval");
  const pollTimer = panel.match(/setInterval\(\(\) => \{ void load\(\); \}, [^)]*\)/)?.[0] || "";
  assert.ok(pollTimer, "任务轮询应只在有任务进行中时开启");
  assert.doesNotMatch(pollTimer, /setNow/, "轮询里不该再顺手推进秒表");
  // No Date.now during render: the clock comes only from hook state.
  assert.doesNotMatch(panel, /const now = crawl\.now \|\| Date\.now\(\)/);
});

/**
 * The site knowledge page's only interaction path: section → list row → drawer → entry.
 *
 * Selecting a page once blanked the whole console (the detail panel's useMemo read a
 * dictionary variable declared after it and hit the temporal dead zone during render).
 * The empty state rendered fine, so snapshot tests never saw it. Here every step is
 * really clicked, and the page's top level is asserted free of pipeline-internal words.
 */
test("console model tab survives the area → row → drawer → entry path and hides pipeline vocabulary", async () => {
  await withTab({ overview: populatedOverview(), tab: "model" }, async (page, crashes) => {
    await page.waitForSelector(".sw-topology-nodes g.area", { timeout: 15_000 });
    const alive = async (step) => {
      assert.deepEqual(crashes, [], `console threw after ${step}`);
      assert.ok(await page.locator(".kc-page").count(), `console unmounted after ${step}`);
    };
    // Sections on the graph equal business groups (two in the fixture: site entry, products)
    assert.equal(await page.locator(".sw-topology-nodes g.area").count(), 2);

    await page.locator(".sw-topology-nodes g.area", { hasText: "商品" }).first().click();
    await alive("selecting an area in the graph");
    assert.ok((await page.locator(".kc-list-head b").innerText()).includes("商品"), "list header follows the selected area");
    assert.equal(await page.locator(".kc-row").count(), 2);

    await page.locator(".kc-row").first().click();
    await page.waitForSelector(".kc-drawer", { timeout: 5_000 });
    await alive("opening the page drawer");
    const drawerText = await page.locator(".kc-drawer").innerText();
    for (const banned of ["页面类型", "业务域", "归类依据", "内容标识"]) assert.ok(!drawerText.includes(banned), `drawer still says "${banned}"`);

    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".kc-drawer").count(), 0, "Escape closes the drawer");

    await page.locator(".sw-topology-nodes g.root").click();
    await alive("selecting the site entry");
    assert.ok((await page.locator(".kc-list-head b").innerText()).includes("网站入口"), "entry selects the homepage's area");
    assert.ok((await page.locator(".kc-row.active").innerText()).includes("首页"), "entry selects the homepage row");

    const text = await page.locator(".kc-page").innerText();
    // The Chinese UI must be pure Chinese: reading the site is not attributed to the assistant, and "Agent" never appears.
    for (const banned of ["版本", "内容标识", "JSON", "页面类型", "业务域", "检索词", "runner", "Agent", "助手"]) {
      assert.ok(!text.includes(banned), `knowledge page still shows "${banned}"`);
    }
  });
});

const MINUTE = 60_000;
const at = (offsetMinutes) => new Date(Date.now() + offsetMinutes * MINUTE).toISOString();
const crawlJob = (status, createdMinutes, extra = {}) => ({
  id: `job-${createdMinutes}`, siteAgentId: "shop", status, origin: "https://shop.example", seeds: [], attempts: 1,
  createdAt: at(createdMinutes), updatedAt: at(createdMinutes + 5), ...extra,
});
const finished = (createdMinutes, result = {}) => crawlJob("succeeded", createdMinutes, { result: { scenes: 3, links: 4, pagesRendered: 12, ...result } });
const filter = (extra) => ({ indexed: 1, skipped: 0, purgedPages: 0, ...extra });

/** The eight states of the top status line, each driven by a job fixture, checking copy and buttons. */
const STATUS_CASES = [
  { name: "从没读过", overview: emptyOverview, jobs: [], text: "还没有读取过这个网站", button: "现在读取", card: true },
  { name: "正在读", overview: populatedOverview, jobs: [crawlJob("running", -2)], text: "正在读取网站", button: "停止" },
  { name: "读完但为空", overview: emptyOverview, jobs: [finished(-30, { scenes: 0, pagesRendered: 0 })], text: "没读到内容", button: "怎么办", card: true },
  { name: "失败", overview: populatedOverview, jobs: [crawlJob("failed", -30, { error: "timeout" })], text: "读取失败：timeout", button: "重试" },
  { name: "第一次读完", overview: populatedOverview, jobs: [finished(-30, { contentFilter: filter({ recrawlStage: "first-crawl" }) })], text: "刚读完，3 类页面", button: "再读一次" },
  { name: "还差一次", overview: populatedOverview, jobs: [finished(-30, { contentFilter: filter({ recrawlStage: "needs-one-more", recrawlPagesNeedingMore: 7 }) })], text: "还有 7 类页面", button: "再读一次" },
  { name: "间隔太短", overview: populatedOverview, jobs: [finished(-45, { contentFilter: filter({ recrawlStage: "ready", recrawlShortestIntervalMinutes: 120 }) })], text: "隔 2 小时以上再读", button: "更新网站知识" },
  { name: "平时", overview: populatedOverview, jobs: [finished(-3 * 24 * 60 - 10, { newScenes: 2, contentFilter: filter({ recrawlStage: "ready" }) })], text: "上次读取 3 天前 · 3 类页面 · 新读到 2 类页面", button: "更新网站知识" },
];

for (const scenario of STATUS_CASES) {
  test(`knowledge status line: ${scenario.name}`, async () => {
    await withTab({ overview: scenario.overview(), tab: "model", jobs: scenario.jobs }, async (page, crashes) => {
      await page.waitForSelector(".kc-status", { timeout: 15_000 });
      // The job list is fetched after mount and the status line updates with it
      try {
        await page.waitForFunction((expected) => document.querySelector(".kc-status")?.textContent?.includes(expected), scenario.text, { timeout: 10_000 });
      } catch (error) {
        const actual = await page.locator(".kc-status").innerText().catch(() => "");
        throw new Error(`status line never said "${scenario.text}"; it says: ${JSON.stringify(actual)}; crashes=${JSON.stringify(crashes)}`, { cause: error });
      }
      assert.deepEqual(crashes, []);
      assert.equal(await page.locator(".kc-status .kc-btn").innerText(), scenario.button);
      if (scenario.card) {
        // Before the first read the page structure is laid out as usual, each part
        // explaining what will appear once read — a blank leaves people unsure what the
        // page will look like, or whether they are in the wrong place.
        assert.equal(await page.locator(".kc-onboard").count(), 0, "不再是孤零零一张卡");
        assert.equal(await page.locator(".kc-unread").count(), 2, "图与问问看各有一处占位");
        assert.equal(await page.locator(".kc-map, .kc-probe, .kc-row").count(), 0, "真正的图、列表与问问看仍不出现");
        const headings = await page.locator(".kc-section-head h2").allInnerTexts();
        assert.deepEqual(headings, ["网站结构", "问问看"], "两个分区的标题照常在");
      } else {
        assert.ok(await page.locator(".kc-map").count(), "graph keeps showing the current knowledge");
      }
    });
  });
}

/** Ask: the site's own words shown directly, deduplicated per page, no internal metrics or placeholder URLs. */
test("knowledge probe shows the site's own words instead of a verdict word", async () => {
  const verified = { sceneId: "scene-search", name: "搜索结果", urlTemplate: "/search?q={q?}", directEntry: "verified" };
  const unread = { sceneId: "scene-product", name: "商品详情", urlTemplate: "/products/{id}", evidenceStatus: "referenced" };
  const quote = "手工编织，防滑底衬，耐踩不易变形。";
  // Two URLs of the same page (with and without query) must collapse into one page name
  const listPlain = { url: "https://shop.example/search", headingPath: "全部商品", context: [{ text: quote }] };
  const listQuery = { url: "https://shop.example/search?category=home", headingPath: "家居类商品", context: [{ text: quote }] };
  const probe = (question) => {
    const base = { expandedKeywords: [question], totalPagesWithHits: 3, diagnosis: "answerable", coverageOfQuery: { appears: false, sampleUrls: [] } };
    if (question === "quotes") return { ...base, pages: [listPlain, listQuery], routes: [verified] };
    if (question === "related") return { ...base, pages: [], routes: [unread] };
    return { ...base, pages: [], routes: [] };
  };
  await withTab({ overview: populatedOverview(), tab: "model", probe }, async (page, crashes) => {
    await page.waitForSelector(".kc-probe input", { timeout: 15_000 });

    await page.locator(".kc-probe input").fill("quotes");
    await page.locator(".kc-probe .kc-btn").click();
    await page.waitForSelector(".kc-quotes blockquote", { timeout: 5_000 });
    assert.deepEqual(crashes, []);
    // The quote appears once and its source collapses into one page name
    assert.equal(await page.locator(".kc-quotes blockquote").count(), 1);
    assert.equal(await page.locator(".kc-quotes blockquote p").innerText(), quote);
    const cite = await page.locator(".kc-quotes blockquote cite").innerText();
    assert.ok(cite.includes("搜索结果"), `出处应给页面名，实际是 ${JSON.stringify(cite)}`);
    assert.ok(!cite.includes("·"), `同一页面不该被列两次：${JSON.stringify(cite)}`);
    const probeText = await page.locator(".kc-probe").innerText();
    // No verdict words, navigation claims, internal metrics or placeholder URLs.
    // "Will take the user to" was an arbitrary verified scene unrelated to where the
    // body matched, and misleading.
    for (const banned of ["已覆盖", "未覆盖", "会带用户去", "检索词", "命中", "区分度", "{q?}", "search_site_knowledge", "navigate_scene"]) {
      assert.ok(!probeText.includes(banned), `probe still shows "${banned}"`);
    }

    // Without a quote fall back to "related pages"; clicking selects that row in the list
    await page.locator(".kc-probe input").fill("related");
    await page.locator(".kc-probe .kc-btn").click();
    await page.waitForSelector(".kc-fact button.link", { timeout: 5_000 });
    assert.equal(await page.locator(".kc-quotes").count(), 0);
    assert.ok((await page.locator(".kc-probe").innerText()).includes("相关页面"));
    await page.locator(".kc-fact button.link").click();
    await page.waitForSelector(".kc-drawer", { timeout: 5_000 });
    assert.ok((await page.locator(".kc-drawer h3").innerText()).includes("商品详情"));

    // Nothing at all: only an explanation remains
    await page.locator(".kc-drawer .kc-close").click();
    await page.locator(".kc-probe input").fill("nothing");
    await page.locator(".kc-probe .kc-btn").click();
    await page.waitForFunction(() => document.querySelector(".kc-probe .kc-msg")?.textContent?.includes("没有相关内容"), null, { timeout: 5_000 });
    assert.equal(await page.locator(".kc-quotes, .kc-fact").count(), 0);
    assert.deepEqual(crashes, []);
  });
});

/**
 * Structural baseline of the onboarding flow.
 *
 * Not a console page, so recorded separately: this screen should have a step rail
 * and one content column, no nav, no tabs. If someone ever wires it back into the
 * shell, this goes red first.
 */
async function withOnboarding({ overview, agents, query = "" }, run) {
  const { server, origin } = await consoleServer(overview, { agents });
  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const crashes = [];
    page.on("pageerror", (error) => crashes.push(error?.stack || String(error)));
    await page.goto(`${origin}/${query}`);
    await page.waitForSelector(".sw-onboarding, .sw-shell", { timeout: 15_000 });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    return await run(page, crashes);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Summary of a site without a handshake: the entry state of onboarding step two. */
function pendingSummary(overview) {
  // A site past step one has its address registered; a placeholder without one is sent back to step one for the address, not step two.
  return { ...agentSummary(overview), connection: undefined, profile: { ...overview.profile, entryUrl: "https://fresh.example/", allowedOrigins: ["https://fresh.example"] } };
}

const ONBOARDING_CASES = [
  { name: "onboarding-create", agents: [], step: "第一步" },
  { name: "onboarding-install", agents: (overview) => [pendingSummary(overview)], step: "第二步" },
];

for (const scenario of ONBOARDING_CASES) {
  test(`onboarding layout is stable: ${scenario.name}`, async () => {
    const overview = { ...emptyOverview(), connection: undefined };
    const agents = typeof scenario.agents === "function" ? scenario.agents(overview) : scenario.agents;
    const signature = await withOnboarding({ overview, agents }, async (page, crashes) => {
      await page.waitForSelector(".sw-onboarding-steps", { timeout: 15_000 });
      assert.deepEqual(crashes, [], `${scenario.name} 渲染时抛错`);
      assert.ok((await page.locator(".sw-onboarding-kicker").innerText()).includes(scenario.step));
      // The flow is independent of the console: no side nav. Step two has two role=tab
      // elements, the "AI coding / detailed guide" path switch, not console tabs (the four
      // stacks appear only on the manual path).
      assert.equal(await page.locator("nav").count(), 0);
      assert.equal(await page.locator('[role="tab"]').count(), scenario.name === "onboarding-install" ? 2 : 0);
      return layoutSignature(page);
    });
    const expected = await readSnapshot(scenario.name);
    if (!expected || UPDATE) {
      await writeSnapshot(scenario.name, signature);
      return;
    }
    assert.deepEqual(signature, expected);
  });
}

test("the site switcher marks a site that has not connected yet", async () => {
  const connected = populatedOverview();
  const pending = { ...emptyOverview(), id: "pending", connection: undefined, profile: { ...emptyOverview().profile, name: "待接入网站" } };
  await withOnboarding({
    overview: connected,
    agents: [agentSummary(connected), pendingSummary(pending)],
    query: `?site=${connected.id}`,
  }, async (page, crashes) => {
    await page.waitForSelector(".sw-shell", { timeout: 15_000 });
    await page.locator(".sw-site-current").click();
    await page.waitForSelector(".sw-site-menu", { timeout: 5_000 });
    const signature = await page.evaluate(() => ({
      entries: document.querySelectorAll(".sw-site-menu > div > button").length,
      pending: document.querySelectorAll(".sw-site-menu .sw-site-pending").length,
      pendingLabels: [...document.querySelectorAll(".sw-site-menu .sw-site-pending")].map((n) => n.textContent),
    }));
    assert.deepEqual(crashes, []);
    assert.deepEqual(signature, { entries: 2, pending: 1, pendingLabels: ["待接入"] });
  });
});

test("the overview lists a capability published by the Capability Center even when the site release has none", async () => {
  // Published capabilities live in the Capability Center store, not in the site
  // knowledge release the overview used to read; the card said "no capabilities
  // yet" right after one had been published.
  const published = [
    { id: "cap-1", name: "搜索微博历史热搜", description: "按关键词搜索历史热搜。", status: "Active", currentVersionId: "v1" },
    { id: "cap-2", name: "未发布的能力", description: "", status: "Building" },
  ];
  await withTab({ overview: emptyOverview(), tab: "overview", publishedCapabilities: published }, async (page, crashes) => {
    await page.waitForSelector(".sw-overview-capabilities li", { timeout: 10_000 });
    const names = await page.locator(".sw-overview-capabilities li b").allInnerTexts();
    assert.deepEqual(names, ["搜索微博历史热搜"], "only Active, published capabilities are listed");
    assert.deepEqual(crashes, []);
  });
});

test("the session activity tab shows the process only; the task result stays on the conversation tab", async () => {
  const { server, origin } = await consoleServer(populatedOverview());
  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    // Deep links carry the site; without it the route sync drops `run` before the view mounts.
    await page.goto(`${origin}/?site=shop&view=sessions&run=run-1`);
    await page.waitForSelector(".sw-session-detail header h2", { timeout: 15_000 });
    const resultBlocks = () => page.locator(".sw-session-reading-pane .sw-session-result").count();
    assert.equal(await resultBlocks(), 1, "the conversation tab shows the task result");
    await page.getByRole("button", { name: "操作过程" }).click();
    await page.waitForSelector(".sw-session-reading-pane section", { timeout: 5_000 });
    assert.equal(await resultBlocks(), 0, "the activity tab does not repeat the task result");
    await page.getByRole("button", { name: "对话" }).click();
    assert.equal(await resultBlocks(), 1);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the capability-deposit line reads as one plain sentence, with its link on the heading row", async () => {
  const { server, origin } = await consoleServer(populatedOverview());
  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${origin}/?site=shop&view=sessions&run=run-1`);
    await page.waitForSelector(".sw-session-result", { timeout: 15_000 });
    const block = page.locator(".sw-session-result").first();
    const title = await block.locator("header > span").boundingBox();
    const link = await block.locator("header > a").boundingBox();
    assert.ok(title && link, "the heading row carries both the title and the link");
    // Same row, link to the right: it has a place instead of trailing the text.
    assert.ok(Math.abs(title.y - link.y) < 10, `title y=${title.y} link y=${link.y}`);
    assert.ok(link.x > title.x + title.width, "the link sits to the right of the heading");
    const text = (await block.innerText()).replace(/\s+/g, " ");
    assert.match(text, /这次用的是已有能力/, `plain reason: ${text}`);
    // The pipeline's diagnostic wording belongs to the effect centre.
    assert.ok(!/值得排查|既有设计/.test(text), `no engineering wording for the reader: ${text}`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the Capability Center's primary button has its own hover rule (the generic button hover must not wash it out)", async () => {
  // The console harness bundles component CSS as empty, so this reads the sheet:
  // `.ccv2-shell button:hover` (0,3,1) outranked `.ccv2-shell .ccv2-primary` (0,2,0)
  // and hovering "new capability" painted a light background under white text.
  const css = await readFile(new URL("../components/capability-center-product.css", import.meta.url), "utf8");
  const rule = css.match(/\.ccv2-shell \.ccv2-primary:hover:not\(:disabled\)[^{]*\{([^}]*)\}/);
  assert.ok(rule, "a dedicated hover rule for .ccv2-primary");
  assert.match(rule[1], /background:\s*color-mix\(in srgb,\s*var\(--cc-accent\)/, "hover keeps the accent, only darker");
  assert.match(rule[1], /color:\s*#fff/, "text stays white");
});
