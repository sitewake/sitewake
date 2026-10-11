/**
 * Settings › Models: the same form as onboarding step three, mounted where a
 * model can be connected or changed at any time. The console is the real
 * bundle in a browser; the control plane is a stub that records writes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const NOW = "2026-09-19T00:00:00.000Z";
const PROVIDERS = [
  { id: "openai", baseUrl: "https://api.openai.com/v1", families: ["gpt-*", "o-series"] },
  { id: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4", families: ["glm*"] },
];

function profile() {
  return { name: "示例商城", description: "一个用于验证的电商网站。", entryUrl: "https://shop.example/", allowedOrigins: ["https://shop.example"], vocabulary: {}, suggestedGoals: [], businessDomains: [] };
}
function overview() {
  return {
    id: "shop", profile: profile(), connection: { url: "https://shop.example/", origin: "https://shop.example", connectedAt: NOW, lastSeenAt: NOW, siteAgentId: "shop", title: "商城", heading: "商城" },
    activeReleaseVersion: 1, sceneCount: 0, capabilityCount: 0, taskCount: 0, episodeCount: 0, updatedAt: NOW, persistence: "memory", modelConfigured: true,
    activeRelease: { id: "release-1", siteAgentId: "shop", version: 1, createdAt: NOW, contentHash: "abc", profile: profile(), capabilities: [], scenes: [], operations: [], targets: [] },
    recentEpisodes: [], activeSessions: [], candidates: [], learningJobs: [], validationJobs: [], browserRuns: [], artifacts: [], runners: [],
  };
}

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
    bundle: true, format: "iife", jsx: "automatic", write: false, logLevel: "silent",
    banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "production" } };' },
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty" },
  });
  return result.outputFiles[0].text;
}

const [consoleScript, css] = await Promise.all([
  bundleConsole(),
  Promise.all(["../app/globals.css", "../app/console-polish.css", "../components/console/sidebar.css"].map((path) => readFile(new URL(path, import.meta.url), "utf8"))).then((parts) => parts.join("\n")),
]);

async function consoleServer(state) {
  const calls = [];
  const site = { ...overview(), modelConfigured: state.model.configured };
  const server = createServer((request, response) => {
    const url = request.url || "/";
    const json = (body, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    const withBody = (handler) => { let body = ""; request.on("data", (chunk) => { body += chunk; }); request.on("end", () => handler(JSON.parse(body || "{}"))); };
    if (url === "/app.js") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(consoleScript); return; }
    if (url === "/globals.css") { response.writeHead(200, { "content-type": "text/css" }); response.end(css); return; }
    if (url === "/api/system/status") {
      const configured = state.model.configured;
      return json({ environment: "development", database: "memory", artifactsConfigured: false, build: "development", models: Object.fromEntries(["general", "execution", "semantic"].map((role) => [role, { configured, model: state.model.model, source: state.model.source }])) });
    }
    if (url === "/api/system/model" && request.method === "GET") return json({ ...state.model, providers: PROVIDERS });
    if (url === "/api/system/model/verify" && request.method === "POST") return withBody((body) => { calls.push({ kind: "verify", body }); json(state.verify(body)); });
    if (url === "/api/system/model" && request.method === "PUT") return withBody((body) => {
      calls.push({ kind: "save", body });
      state.model = { source: "console", configured: true, baseUrl: body.baseUrl, model: body.model, executionModel: body.executionModel || "", semanticModel: body.semanticModel || "", apiKeyMasked: body.apiKey ? `sk-…${body.apiKey.slice(-4)}` : state.model.apiKeyMasked };
      json({ ...state.model });
    });
    if (url.startsWith("/api/admin/capability-v2/")) return json({ intakes: [], capabilities: [] });
    if (url === "/api/site-agents") return json({ agents: [{ id: site.id, profile: site.profile, connection: site.connection, activeReleaseVersion: 1, sceneCount: 0, capabilityCount: 0, taskCount: 0, episodeCount: 0, updatedAt: NOW }] });
    if (url.startsWith("/api/site-agents/") && url.includes("/session-history")) return json({ records: [], total: 0 });
    if (url.startsWith("/api/site-agents/") && url.includes("/crawl")) return json({ jobs: [] });
    if (url.startsWith("/api/site-agents/")) return json(site);
    if (url.startsWith("/api/")) return json({});
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/globals.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>`);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, calls, origin: `http://127.0.0.1:${server.address().port}` };
}

async function withSettings(state, run, { query = "/?view=settings&section=runtime" } = {}) {
  const { server, calls, origin } = await consoleServer(state);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const crashes = [];
    page.on("pageerror", (error) => crashes.push(String(error)));
    await page.goto(`${origin}${query}`);
    if (query.includes("view=settings")) await page.waitForSelector("[data-model-settings] [data-model-form]", { timeout: 15_000 });
    await run(page, { calls, state });
    assert.deepEqual(crashes, []);
  } finally {
    await browser.close().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
  }
}

test("Settings › Models shows the current model and masked key — never the key, never where it came from — and a save takes effect", async () => {
  const state = {
    model: { source: "env", configured: true, baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.2", executionModel: "", semanticModel: "", apiKeyMasked: "sk-…env1" },
    verify: () => ({ ok: true, results: [{ stage: "runtime-router", ok: true, status: 200 }, { stage: "runtime-page-agent", ok: true, status: 200 }], durationMs: 800 }),
  };
  await withSettings(state, async (page, { calls }) => {
    const block = page.locator("[data-model-settings]");
    const text = await block.innerText();
    assert.ok(!text.includes("来自 .env") && !text.includes("在控制台设置"), "where the configuration comes from is not the person's concern");
    assert.match(text, /glm-5\.2/);
    assert.match(text, /sk-…env1/);
    assert.ok(!text.includes("sk-…env1sk"), "never the key");
    // The provider menu is preselected from the base URL; the key field is empty and says a blank keeps the saved key.
    assert.equal(await block.locator("select").inputValue(), "zhipu");
    assert.equal(await block.locator("input[type=password]").inputValue(), "");
    assert.match(await block.locator("input[type=password]").getAttribute("placeholder"), /sk-…env1/);
    assert.equal(await block.locator("button.sw-mng-primary").isDisabled(), true, "nothing verified yet");

    // Only the model changes: the saved key is kept (the request carries an empty key).
    await block.locator("input[type=text]").fill("glm-5.3");
    await block.locator("button[type=submit]").click();
    await page.waitForSelector('[data-model-settings] [data-verification="ok"]', { timeout: 10_000 });
    assert.match(await block.locator('[data-verification="ok"]').innerText(), /验证通过/);
    await block.locator("button.sw-mng-primary").click();
    await page.waitForFunction(() => document.querySelector("[data-model-settings]")?.textContent?.includes("已保存"), null, { timeout: 10_000 });
    assert.deepEqual(calls.map((call) => call.kind), ["verify", "save"]);
    assert.equal(calls[0].body.apiKey, "");
    assert.equal(calls[1].body.apiKey, "");
    assert.equal(calls[1].body.model, "glm-5.3");
    assert.equal(calls[1].body.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
    const after = await block.innerText();
    assert.ok(!after.includes("在控制台设置"));
    assert.match(after, /glm-5\.3/);
    assert.match(after, /已保存/);
    // Nothing else about the model here: no per-role table, no execution-service
    // entry. The only other block on this page is the installation's public
    // address, which is the other thing every website shares.
    assert.equal(await page.locator(".sw-model-role").count(), 0);
    assert.equal(await page.locator("[data-model-settings] .sw-settings-block").count(), 0);
    assert.deepEqual(
      await page.locator(".sw-settings-block > header > h2").allInnerTexts(),
      ["对外地址", "模型"],
    );
    assert.ok(!(await page.locator(".sw-system-settings").innerText()).includes("执行服务"));
  });
});

test("Settings › Models without a model says so and shows the wizard's hint when verification fails", async () => {
  const state = {
    model: { source: "missing", configured: false, baseUrl: "", model: "", executionModel: "", semanticModel: "", apiKeyMasked: "" },
    verify: () => ({ ok: false, hint: "404", results: [{ stage: "runtime-router", ok: false, status: 404, detail: "not found" }, { stage: "runtime-page-agent", ok: false, status: 404, detail: "not found" }], durationMs: 200 }),
  };
  await withSettings(state, async (page, { calls }) => {
    const block = page.locator("[data-model-settings]");
    const text = await block.innerText();
    assert.match(text, /还没有接入模型/);
    await block.locator("select").selectOption("other");
    await block.locator("input[type=url]").fill("https://gateway.example");
    await block.locator("input[type=password]").fill("sk-anything");
    await block.locator("input[type=text]").fill("some-model");
    await block.locator("button[type=submit]").click();
    await page.waitForSelector('[data-model-settings] [data-verification="failed"]', { timeout: 10_000 });
    const failed = await block.locator('[data-verification="failed"]').innerText();
    assert.match(failed, /404/);
    assert.match(failed, /\/v1/, "the same hint as the wizard");
    assert.equal(await block.locator("button.sw-mng-primary").isDisabled(), true);
    assert.equal(calls.filter((call) => call.kind === "save").length, 0);
    assert.equal(calls[0].body.baseUrl, "https://gateway.example");
  });
});

test("the overview says when no model is connected and takes you to the form", async () => {
  const state = {
    model: { source: "missing", configured: false, baseUrl: "", model: "", executionModel: "", semanticModel: "", apiKeyMasked: "" },
    verify: () => ({ ok: true, results: [], durationMs: 1 }),
  };
  await withSettings(state, async (page) => {
    await page.waitForSelector(".sw-overview-model-missing", { timeout: 15_000 });
    assert.match(await page.locator(".sw-overview-model-missing").innerText(), /还没有接入模型/);
    await page.locator(".sw-overview-model-missing button").click();
    await page.waitForSelector("[data-model-settings] [data-model-form]", { timeout: 15_000 });
    assert.equal(new URL(page.url()).searchParams.get("section"), "runtime");
  }, { query: "/?site=shop" });
  const configured = {
    model: { source: "env", configured: true, baseUrl: "https://api.openai.com/v1", model: "gpt-x", executionModel: "", semanticModel: "", apiKeyMasked: "sk-…0000" },
    verify: () => ({ ok: true, results: [], durationMs: 1 }),
  };
  await withSettings(configured, async (page) => {
    await page.waitForSelector(".sw-overview-v2", { timeout: 15_000 });
    assert.equal(await page.locator(".sw-overview-model-missing").count(), 0, "no notice once a model is in place");
  }, { query: "/?site=shop" });
});
