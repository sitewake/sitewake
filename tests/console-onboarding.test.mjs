import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

/**
 * Behavioral net for the onboarding flow.
 *
 * Like console-layout it runs the real components in a real browser, because what is
 * checked here — "no console shell inside the flow", "no step three without a
 * handshake", "double-clicking detect sends no second request" — is behavior, not
 * data shape, and static assertions cannot see it.
 */

const NOW = "2026-09-08T10:00:00.000Z";

const PROVIDERS = [
  { id: "openai", baseUrl: "https://api.openai.com/v1", families: ["gpt-*", "o-series"] },
  { id: "bailian", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", families: ["qwen*"] },
];
const MODEL_FROM_ENV = { source: "env", configured: true, baseUrl: "https://api.openai.com/v1", model: "gpt-env", executionModel: "", semanticModel: "", apiKeyMasked: "sk-…env1" };
const MODEL_MISSING = { source: "missing", configured: false, baseUrl: "", model: "", executionModel: "", semanticModel: "", apiKeyMasked: "" };


function profile(overrides = {}) {
  return {
    name: "示例商城",
    description: "一个用于验证的电商网站。",
    entryUrl: "https://shop.example/",
    allowedOrigins: ["https://shop.example"],
    vocabulary: {},
    suggestedGoals: [],
    ...overrides,
  };
}

function overviewFor(id, { connection, sitePreview, sitePreviewJob } = {}) {
  return {
    id,
    profile: profile(),
    ...(connection ? { connection } : {}),
    activeReleaseVersion: 1,
    sceneCount: 0, capabilityCount: 0, taskCount: 0, episodeCount: 0,
    updatedAt: NOW,
    persistence: "memory",
    modelConfigured: true,
    activeRelease: {
      id: `${id}:release:1`, siteAgentId: id, version: 1, createdAt: NOW,
      profile: profile(), scenes: [], capabilities: [], operations: [], contentHash: "h",
    },
    recentEpisodes: [], activeSessions: [], candidates: [],
    learningJobs: [], validationJobs: [], browserRuns: [], artifacts: [], runners: [],
    ...(sitePreview ? { sitePreview } : {}),
    ...(sitePreviewJob ? { sitePreviewJob } : {}),
  };
}

function summaryFor(id, { connection } = {}) {
  return {
    id, profile: profile(), ...(connection ? { connection } : {}),
    activeReleaseVersion: 1, sceneCount: 0, capabilityCount: 0, taskCount: 0, episodeCount: 0, updatedAt: NOW,
  };
}

function connectionAt(lastSeenAt) {
  return { siteAgentId: "shop.example", origin: "https://shop.example", url: "https://shop.example/", title: "商城", heading: "商城", connectedAt: lastSeenAt, lastSeenAt };
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
  Promise.all(["../app/globals.css", "../app/console-polish.css", "../components/console/sidebar.css"]
    .map((path) => readFile(new URL(path, import.meta.url), "utf8"))).then((parts) => parts.join("\n")),
]);

/**
 * Starts a controlled control plane. `state` can be mutated in a case to simulate
 * "handshake arrived" or "job succeeded". `calls` records every write request, for
 * assertions like "no second request".
 */
async function flowServer(state) {
  const calls = [];
  const server = createServer((request, response) => {
    const url = request.url || "/";
    const json = (body, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url === "/app.js") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(consoleScript); return; }
    if (url === "/globals.css") { response.writeHead(200, { "content-type": "text/css" }); response.end(css); return; }
    // The console password. `state.access` is what the rail reads; the default is
    // "already set", so every test written before this step existed keeps the
    // flow it was written against.
    if (url === "/api/access" && request.method === "GET") {
      return json({ configured: true, enabled: true, updatedAt: null, onboardingSkipped: false, ...(state.access || {}) });
    }
    if (url === "/api/access" && request.method === "PUT") {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        const body = (() => { try { return JSON.parse(raw || "{}"); } catch { return {}; } })();
        calls.push({ kind: "setPassword", length: String(body.password || "").length });
        if (String(body.password || "").length < 6) return json({ ok: false, error: "password_too_short" }, 400);
        state.access = { ...(state.access || {}), configured: true, enabled: true };
        // The real route signs the caller in here; the cookie itself is not what
        // this suite checks (tests/access-route.test.mjs does), only that the
        // flow continues without a login screen.
        json({ ok: true, status: { configured: true, enabled: true, updatedAt: null } });
      });
      return;
    }
    if (url === "/api/access" && request.method === "POST") {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        calls.push({ kind: "skipOnboarding" });
        state.access = { ...(state.access || {}), onboardingSkipped: true };
        json({ ok: true, onboardingSkipped: true });
      });
      return;
    }
    if (url === "/api/system/status") return json({ environment: "development", database: "SQLite / D1", artifactsConfigured: false, build: "development", models: Object.fromEntries(["general", "execution", "semantic"].map((role) => [role, { configured: true, model: "m" }])) });
    // The model is installation-wide. `state.model` is what the console reads; verify / save answer per `state.modelVerify`.
    if (url === "/api/system/model" && request.method === "GET") return json({ ...(state.model || MODEL_FROM_ENV), providers: PROVIDERS });
    if (url === "/api/system/model/verify" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        calls.push({ kind: "verify", body: parsed });
        json(state.modelVerify ? state.modelVerify(parsed) : { ok: true, results: [{ stage: "runtime-router", ok: true, status: 200 }, { stage: "runtime-page-agent", ok: true, status: 200 }], durationMs: 1200 });
      });
      return;
    }
    if (url === "/api/system/model" && request.method === "PUT") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        calls.push({ kind: "saveModel", body: parsed });
        state.model = { source: "console", configured: true, baseUrl: parsed.baseUrl, model: parsed.model, executionModel: "", semanticModel: "", apiKeyMasked: `sk-…${String(parsed.apiKey).slice(-4)}` };
        json({ ...state.model });
      });
      return;
    }
    if (url.startsWith("/api/site-agents") && url.includes("/preview") && request.method === "POST") {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        const body = (() => { try { return JSON.parse(raw || "{}"); } catch { return {}; } })();
        calls.push({ kind: "detect", url, mode: body.mode, installSnippet: body.installSnippet });
        if (state.detectFails) return json({ error: "site_preview_enqueue_failed" }, 500);
        state.job = state.nextJob ? state.nextJob() : { id: `preview-${calls.length}`, createdAt: new Date().toISOString(), status: "queued" };
        json({ job: state.job }, 202);
      });
      return;
    }
    // Adopt the site id found on the page: recreate the same registration (still pending) under the new id and delete the old one.
    if (/^\/api\/site-agents\/[^/?]+\/install-id\/adopt$/.test(url) && request.method === "POST") {
      const from = decodeURIComponent(url.split("/api/site-agents/")[1].split("/")[0]);
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const to = String(JSON.parse(body || "{}").siteAgentId || "");
        calls.push({ kind: "adopt", from, to });
        if (state.adoptFails) return json({ error: "site_agent_not_fresh", message: "当前网站不是空的。", retryable: false }, 409);
        const previous = state.overviews[from];
        state.overviews[to] = { ...previous, id: to, activeRelease: { ...previous.activeRelease, id: `${to}:release:0`, siteAgentId: to } };
        delete state.overviews[from];
        state.agents = state.agents.filter((agent) => agent.id !== from).concat([{ ...summaryFor(to), profile: previous.profile }]);
        state.detectingSite = to;
        state.job = undefined;
        json({ siteAgentId: to, replacedSiteAgentId: from });
      });
      return;
    }
    if (url === "/api/site-agents" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        calls.push({ kind: "create", body: parsed });
        if (parsed.id && state.overviews[parsed.id]) {
          // A create with an id fills in the address of an existing site: the backend merges entryUrl / allowedOrigins by id.
          const bound = profile({ name: parsed.name || parsed.id, entryUrl: parsed.url, allowedOrigins: [new URL(parsed.url).origin] });
          state.agents = state.agents.map((agent) => (agent.id === parsed.id ? { ...agent, profile: bound } : agent));
          state.overviews[parsed.id] = { ...state.overviews[parsed.id], profile: bound };
          return json({ siteAgentId: parsed.id });
        }
        const id = "shop.example";
        state.agents = [...state.agents, summaryFor(id)];
        state.overviews[id] = overviewFor(id);
        json({ siteAgentId: id });
      });
      return;
    }
    if (url.startsWith("/api/site-agents?") || url === "/api/site-agents") return json({ agents: state.agents });
    // The address visitors load SiteWake from. Unset in most cases, which is
    // how a local install behaves; a case that sets it proves the snippet
    // follows the setting rather than the administrator's own address.
    if (url === "/api/system/public-address") {
      return json(state.publicAddress || { origin: "https://console.acme.test", source: "console", installationId: "install-test", usableForPublicSites: true });
    }
    // What the control plane found when it loaded the reader's website. A
    // function answers each round differently, which is how a site fixed
    // between two checks is modelled.
    if (url.includes("/install-readiness")) {
      calls.push({ kind: "readiness", url });
      const round = calls.filter((call) => call.kind === "readiness").length;
      const found = typeof state.readiness === "function" ? state.readiness(round) : state.readiness;
      const answer = found || { readiness: { siteUrl: "https://shop.example/" }, policy: { source: "measured", findings: [], blocked: false, patches: [] } };
      return json({ sdkOrigin: "https://console.acme.test", ...answer });
    }
    if (url.startsWith("/api/admin/capability-v2/experiences")) return json({ intakes: [] });
    const site = url.startsWith("/api/site-agents/") ? decodeURIComponent(url.split("/api/site-agents/")[1].split(/[/?]/)[0]) : "";
    if (site && state.overviews[site]) {
      const overview = { ...state.overviews[site] };
      // job / preview only make sense for the site being detected; scoped by detectingSite.
      if (state.job && site === (state.detectingSite || site)) overview.sitePreviewJob = state.job;
      if (state.preview && site === (state.detectingSite || site)) overview.sitePreview = state.preview;
      if (url.includes("/session-history")) return json({ records: [], total: 0 });
      if (url.includes("/crawl")) return json({ jobs: [] });
      if (url.includes("/content")) return json({ chunks: [] });
      if (url.startsWith(`/api/site-agents/${encodeURIComponent(site)}`) && !url.includes("/")) return json(overview);
      if (/\/api\/site-agents\/[^/?]+(\?|$)/.test(url)) return json(overview);
      return json({});
    }
    if (url.startsWith("/api/")) return json({});
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/globals.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>`);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, calls, origin: `http://127.0.0.1:${server.address().port}` };
}

async function withFlow(state, run, { query = "", host = "" } = {}) {
  const initial = { agents: [], overviews: {}, ...state };
  const { server, calls, origin: loopbackOrigin } = await flowServer(initial);
  // A console opened at a real hostname instead of loopback: the browser then
  // applies its mixed-content rule to the SDK tag the page offers.
  const browser = await chromium.launch({
    headless: true,
    ...(host ? { args: [`--host-resolver-rules=MAP ${host} 127.0.0.1`] } : {}),
  });
  const origin = host ? loopbackOrigin.replace("127.0.0.1", host) : loopbackOrigin;
  try {
    const context = await browser.newContext();
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const page = await context.newPage();
    const crashes = [];
    page.on("pageerror", (error) => crashes.push(String(error)));
    await page.goto(`${origin}/${query}`);
    await run(page, { calls, state: initial, crashes, origin });
    assert.deepEqual(crashes, [], "页面不该抛错");
  } finally {
    await browser.close().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
  }
}

test("with no site at all the console opens the flow, not an empty shell", async () => {
  await withFlow({}, async (page) => {
    await page.waitForSelector(".sw-onboarding", { timeout: 15_000 });
    // Independent of the console: none of the shell's sidebar or tabs are present.
    assert.equal(await page.locator(".sw-console-sidebar").count(), 0);
    assert.equal(await page.locator(".sw-console-navigation").count(), 0);
    assert.equal(await page.locator('[role="tablist"] [role="tab"][aria-selected]').count(), 0);
    assert.equal(await page.locator(".sw-shell").count(), 0);
    // Step one; the header is the first-use variant.
    assert.match(await page.locator(".sw-onboarding-kicker").innerText(), /第一步/);
    assert.match(await page.locator(".sw-onboarding-content h1").innerText(), /把 Agent 接进你的网站/);
  });
});

test("the rail marks progress and never lets you jump ahead; the model step exists only while no model is connected", async () => {
  // A model is in place (from .env in the stub): three steps.
  await withFlow({}, async (page) => {
    await page.waitForSelector(".sw-onboarding-steps", { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelectorAll(".sw-onboarding-steps li").length === 3, null, { timeout: 5_000 });
    const steps = page.locator(".sw-onboarding-steps li");
    assert.deepEqual(
      await steps.evaluateAll((nodes) => nodes.map((node) => node.className)),
      ["is-current", "is-upcoming", "is-upcoming"],
    );
    assert.ok(!(await steps.allInnerTexts()).join(" ").includes("接入模型"));
    // The rail is not navigation: on step one nothing in it is clickable, no skipping ahead.
    assert.equal(await page.locator(".sw-onboarding-steps button, .sw-onboarding-steps a").count(), 0);
    assert.equal(await page.locator(".sw-onboarding-success-panel").count(), 0);
  });
  // No model yet: the flow grows a third step for it.
  await withFlow({ model: MODEL_MISSING }, async (page) => {
    await page.waitForSelector(".sw-onboarding-steps", { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelectorAll(".sw-onboarding-steps li").length === 4, null, { timeout: 5_000 });
    assert.deepEqual(await page.locator(".sw-onboarding-steps li").allInnerTexts().then((names) => names.map((name) => name.split("\n")[0].trim())), ["1", "2", "3", "4"]);
    assert.match((await page.locator(".sw-onboarding-steps").innerText()), /接入模型/);
  });
});

test("a site that never handshook opens at step two instead of the console", async () => {
  const id = "shop.example";
  await withFlow({ agents: [summaryFor(id)], overviews: { [id]: overviewFor(id) } }, async (page) => {
    await page.waitForSelector(".sw-onboarding", { timeout: 15_000 });
    assert.match(await page.locator(".sw-onboarding-kicker").innerText(), /第二步/);
    const steps = await page.locator(".sw-onboarding-steps li").evaluateAll((nodes) => nodes.map((n) => n.className));
    assert.deepEqual(steps, ["is-done is-returnable", "is-current", "is-upcoming"], "step one is done and, from step two, the way back");
    assert.equal(await page.locator(".sw-shell").count(), 0);
  });
});

test("a placeholder site with no address asks for it before showing any prompt", async () => {
  // A site only touched by id, never handshaken: no entryUrl, hence no allowedOrigins.
  const id = "acme-production";
  const placeholder = profile({ name: id, description: "等待网站首次连接", entryUrl: undefined, allowedOrigins: [] });
  const summary = { ...summaryFor(id), profile: placeholder };
  const overview = { ...overviewFor(id), profile: placeholder };
  await withFlow({ agents: [summary], overviews: { [id]: overview } }, async (page, { calls }) => {
    await page.waitForSelector(".sw-onboarding", { timeout: 15_000 });
    // Neither step two nor an empty prompt: ask for the address first, and say which id it is for.
    assert.match(await page.locator(".sw-onboarding-kicker").innerText(), /补上网站地址/);
    assert.match(await page.locator(".sw-onboarding-lead").innerText(), new RegExp(id));
    assert.equal(await page.locator(".sw-onboarding-prompt").count(), 0);

    await page.locator(".sw-onboarding-field input").fill("https://www.example.org");
    await page.locator("button.sw-onboarding-primary").click();
    await page.waitForFunction(() => document.querySelector(".sw-onboarding-kicker")?.textContent?.includes("第二步"), null, { timeout: 10_000 });
    // The address binds to the existing id; no new site is created.
    const create = calls.filter((call) => call.kind === "create");
    assert.equal(create.length, 1);
    assert.deepEqual(create[0].body, { id, url: "https://www.example.org/" });
    // The prompt is complete now: address, id and SDK URL.
    const prompt = await page.locator(".sw-onboarding-prompt").innerText();
    assert.match(prompt, /https:\/\/www\.example\.org\//);
    assert.match(prompt, new RegExp(`接入标识：${id}`));
    assert.match(prompt, /\/sitewake\.js/);
    assert.match(await page.locator(".sw-onboarding-stage small").first().innerText(), /www\.example\.org/);
  });
});

test("a connected site goes straight to the console and shows no onboarding chrome", async () => {
  const id = "shop.example";
  const connection = connectionAt(NOW);
  await withFlow({
    agents: [summaryFor(id, { connection })],
    overviews: { [id]: overviewFor(id, { connection }) },
  }, async (page) => {
    await page.waitForSelector(".sw-shell", { timeout: 15_000 });
    assert.equal(await page.locator(".sw-onboarding").count(), 0);
    // The everyday console does not keep the step bar or install code around.
    assert.equal(await page.locator(".sw-onboarding-steps").count(), 0);
    assert.equal(await page.locator(".sw-onboarding-code").count(), 0);
  });
});

/** A connected existing site + `?connect=1`: the entry state of "add site". */
function withExistingSite(extra = {}) {
  const id = "docs.example";
  const connection = { ...connectionAt(NOW), siteAgentId: id, origin: "https://shop.example", url: "https://shop.example/" };
  return {
    agents: [{ ...summaryFor(id, { connection }), profile: profile({ name: "帮助中心", entryUrl: "https://shop.example/" }) }],
    overviews: { [id]: { ...overviewFor(id, { connection }), profile: profile({ name: "帮助中心", entryUrl: "https://shop.example/" }) } },
    ...extra,
  };
}

test("step one refuses an address it cannot reach and says why", async () => {
  await withFlow({}, async (page, { calls }) => {
    await page.waitForSelector(".sw-onboarding-field input", { timeout: 15_000 });
    const input = page.locator(".sw-onboarding-field input");
    const submit = page.locator("button.sw-onboarding-primary");

    // Invalid input: block, explain, do not create a site.
    await input.fill("не url ::");
    await submit.click();
    await page.waitForSelector(".sw-onboarding-error", { timeout: 5_000 });
    assert.match(await page.locator(".sw-onboarding-error").innerText(), /http:\/\/ 或 https:\/\//);
    assert.equal(calls.filter((call) => call.kind === "create").length, 0);

    // Missing scheme: prepend https:// and continue, stating the origin used.
    await input.fill("shop.example");
    await page.waitForFunction(() => document.querySelector(".sw-onboarding-note")?.textContent?.includes("https://shop.example"), null, { timeout: 5_000 });
    assert.equal(await page.locator(".sw-onboarding-error").count(), 0);
  });
});

test("opening the site to check it keeps what you typed", async () => {
  await withFlow({}, async (page) => {
    await page.waitForSelector(".sw-onboarding-field input", { timeout: 15_000 });
    await page.locator(".sw-onboarding-field input").fill("https://shop.example/docs");
    const link = page.locator(".sw-onboarding-field-row a.sw-onboarding-ghost");
    await link.waitFor({ timeout: 5_000 });
    // Opens in a new tab; the current page stays.
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
    assert.equal(await link.getAttribute("href"), "https://shop.example/docs");
    assert.equal(await page.locator(".sw-onboarding-field input").inputValue(), "https://shop.example/docs");
  });
});

test("an address that already belongs to a site stops the flow instead of overwriting it", async () => {
  await withFlow(withExistingSite(), async (page, { calls, state }) => {
    await page.waitForSelector(".sw-onboarding-field input", { timeout: 15_000 });
    const before = JSON.stringify(state.agents);
    await page.locator(".sw-onboarding-field input").fill("https://shop.example/anything");
    await page.locator("button.sw-onboarding-primary").click();
    await page.waitForSelector(".sw-onboarding-alert", { timeout: 5_000 });
    const alert = await page.locator(".sw-onboarding-alert").innerText();
    assert.match(alert, /已经属于一个网站/);
    assert.match(alert, /帮助中心/);
    // No create request was sent; the existing site is untouched.
    assert.equal(calls.filter((call) => call.kind === "create").length, 0);
    assert.equal(JSON.stringify(state.agents), before);
    // An exit is offered, not a dead end.
    assert.ok(await page.locator(".sw-onboarding-alert button").count());
  }, { query: "?connect=1" });
});

test("adding a second site says so, and creating one lands on step two", async () => {
  await withFlow(withExistingSite(), async (page, { calls }) => {
    await page.waitForSelector(".sw-onboarding", { timeout: 15_000 });
    // The new-site header differs from the first-use one.
    assert.match(await page.locator(".sw-onboarding-kicker").innerText(), /添加网站/);
    assert.match(await page.locator(".sw-onboarding-content h1").innerText(), /为这个网站建一个独立的 Agent/);

    await page.locator(".sw-onboarding-field input").fill("https://new.example");
    await page.locator("button.sw-onboarding-primary").click();
    await page.waitForFunction(() => document.querySelector(".sw-onboarding-kicker")?.textContent?.includes("第二步"), null, { timeout: 10_000 });
    assert.equal(calls.filter((call) => call.kind === "create").length, 1);
    assert.equal(calls.find((call) => call.kind === "create").body.url, "https://new.example/");
  }, { query: "?connect=1" });
});

test("step two defaults to the AI path and keeps state when you switch tabs", async () => {
  const id = "shop.example";
  await withFlow({ agents: [summaryFor(id)], overviews: { [id]: overviewFor(id) } }, async (page) => {
    await page.waitForSelector(".sw-onboarding-tabs", { timeout: 15_000 });
    const tabs = page.locator(".sw-onboarding-tabs").first().locator("button");
    assert.equal(await tabs.nth(0).getAttribute("aria-selected"), "true", "默认是 AI Coding");
    assert.match(await tabs.nth(0).innerText(), /推荐/);
    // The prompt carries the real site id and SDK URL.
    const prompt = await page.locator(".sw-onboarding-prompt").innerText();
    assert.ok(prompt.includes(id), "提示词里是这个网站的接入标识");
    assert.ok(prompt.includes("/sitewake.js"), "提示词里是真实 SDK 地址");

    await tabs.nth(1).click();
    await page.waitForSelector(".sw-onboarding-install-steps", { timeout: 5_000 });
    assert.equal(await page.locator(".sw-onboarding-stacks button").count(), 4);
    // Switching back keeps the site id.
    await tabs.nth(0).click();
    await page.waitForSelector(".sw-onboarding-prompt", { timeout: 5_000 });
    assert.ok((await page.locator(".sw-onboarding-prompt").innerText()).includes(id));
  });
});

test("the stack picker shows where the code goes and resets the copied state", async () => {
  const id = "shop.example";
  await withFlow({ agents: [summaryFor(id)], overviews: { [id]: overviewFor(id) } }, async (page) => {
    await page.waitForSelector(".sw-onboarding-tabs", { timeout: 15_000 });
    await page.locator(".sw-onboarding-tabs").first().locator("button").nth(1).click();
    await page.waitForSelector(".sw-onboarding-stacks", { timeout: 5_000 });
    const stacks = page.locator(".sw-onboarding-stacks button");
    assert.deepEqual(await stacks.evaluateAll((nodes) => nodes.map((n) => n.textContent)), ["HTML", "React", "Next.js", "Vue"]);

    // HTML tab: a script tag ready to paste.
    assert.match(await page.locator(".sw-onboarding-code").innerText(), /^<script /);
    await page.locator(".sw-onboarding-actions button").first().click();
    await page.waitForFunction(() => document.body.innerText.includes("代码已复制"), null, { timeout: 5_000 });

    // Next.js tab: the framework component, and the copied state resets on switch.
    await stacks.nth(2).click();
    await page.waitForFunction(() => document.querySelector(".sw-onboarding-code")?.textContent?.includes("next/script"), null, { timeout: 5_000 });
    const code = await page.locator(".sw-onboarding-code").innerText();
    assert.ok(!code.includes("<script "), "Next.js 栏不给原生 script 标签");
    assert.match(await page.locator(".sw-onboarding-install-steps li").first().innerText(), /app\/layout\.tsx/);
    assert.ok(!(await page.body?.innerText?.()) , undefined);
    assert.ok(!(await page.locator(".sw-onboarding-actions").innerText()).includes("代码已复制"), "换了技术栈就得重新复制");
  });
});

test("troubleshooting is available before anything fails, and does not repeat the conditions", async () => {
  const id = "shop.example";
  await withFlow({ agents: [summaryFor(id)], overviews: { [id]: overviewFor(id) } }, async (page) => {
    await page.waitForSelector(".sw-onboarding-link", { timeout: 15_000 });
    const toggle = page.locator(".sw-onboarding-link").last();
    assert.match(await toggle.innerText(), /检测遇到问题/);
    assert.equal(await page.locator(".sw-onboarding-troubleshoot").count(), 0, "默认收起");

    await toggle.click();
    await page.waitForSelector(".sw-onboarding-troubleshoot", { timeout: 5_000 });
    const panel = page.locator(".sw-onboarding-troubleshoot");
    const text = await panel.innerText();
    // What is left here is the one thing no check can see: whether the code
    // went into a file every page loads.
    assert.ok(text.includes("脚本没有加载"), "排查里保留「脚本没有加载」");
    assert.ok(text.includes("接入条件"), "其余指回上面实测过的条件");
    assert.ok(!text.includes("如果浏览器控制台提示"), "不再让用户自己去判断 CSP 报错");
    // Expanding deliberately is not an error state.
    assert.equal(await panel.getAttribute("role"), null);
    assert.equal(await page.locator('.sw-onboarding-troubleshoot[role="alert"]').count(), 0);
  });
});

/** Starting point of step two: a created site that never handshook. */
function pendingSite(extra = {}) {
  const id = "shop.example";
  // Freshly created, never handshaken: knowledge version is still the initial 0 (emptyRelease), which makes it "empty".
  const overview = overviewFor(id);
  overview.activeReleaseVersion = 0;
  overview.activeRelease = { ...overview.activeRelease, id: `${id}:release:0`, version: 0 };
  return { agents: [summaryFor(id)], overviews: { [id]: overview }, detectingSite: id, ...extra };
}

/** The same site, but running on this machine: the local development pairing. */
function localPendingSite() {
  const state = pendingSite();
  const local = profile({ entryUrl: "http://localhost:5173/", allowedOrigins: ["http://localhost:5173"] });
  state.agents = state.agents.map((agent) => ({ ...agent, profile: local }));
  const overview = state.overviews["shop.example"];
  overview.profile = local;
  overview.activeRelease = { ...overview.activeRelease, profile: local };
  return state;
}

/** Copies the prompt: step one is then done and the check becomes the primary action. */
async function armDetect(page) {
  await page.waitForSelector(".sw-onboarding-prompt", { timeout: 15_000 });
  await page.locator("button.sw-onboarding-primary").first().click();
  await page.waitForFunction(() => document.body.innerText.includes("提示词已复制"), null, { timeout: 5_000 });
}

test("an address a visitor cannot use is the first condition, and it folds the code away", async () => {
  // The installation still has the address the installer guessed: http on an
  // IP. Nothing about the website can be judged until that is settled, so the
  // conditions below it stay pending and the code is not handed over as if it
  // would work.
  const state = pendingSite({
    publicAddress: { origin: "http://203.0.113.9:3000", source: "env", installationId: "install-test", usableForPublicSites: false },
    nextJob: () => ({ id: "preview-1", createdAt: new Date(Date.now() - 1_000).toISOString(), status: "succeeded" }),
    preview: { artifactId: "a", url: "u", pageUrl: "https://shop.example/", capturedAt: NOW, width: 1440, height: 900, agentDetected: true, detectedSiteAgentIds: ["shop.example"] },
  });
  await withFlow(state, async (page) => {
    const conditions = page.locator("[data-install-conditions]");
    await conditions.waitFor({ timeout: 15_000 });
    // The block renders as soon as the check starts and answers a moment
    // later; on a slow machine this read landed on "checking" and the run
    // failed for a reason that had nothing to do with what it tests.
    await page.waitForFunction(
      () => !/正在检查这个网站/.test(document.querySelector("[data-install-conditions]")?.textContent || ""),
      null,
      { timeout: 15_000 },
    );
    const text = (await conditions.innerText()).replace(/\s+/g, " ");
    assert.match(text, /还有 1 项要处理，这段代码才能在 shop\.example 上运行/, "一句话说清现在能不能装");
    // The condition is about https in front of port 3000. Where the address is
    // then configured is a different question and does not belong in this line.
    assert.ok(!text.includes("设置中"), `别把「去设置里填」混进来：${text}`);
    assert.match(text, /代码来源/);
    assert.match(text, /203\.0\.113\.9:3000/, "点名当前地址");
    assert.match(text, /混合内容/, "说清是哪条规则");
    assert.match(text, /给这个地址配上 https。/, "给出下一步");
    assert.equal(await conditions.locator('li[data-condition="address"][data-state="unmet"]').count(), 1);
    // Upstream unsettled: the other two are not judged, and no policy advice
    // is given for a console address that cannot work anyway.
    assert.equal(await conditions.locator('li[data-state="pending"]').count(), 2);
    assert.ok(!text.includes("script-src"), `对外地址没配好时不该给 CSP 建议：${text}`);

    // The code is still reachable, but folded and labelled.
    assert.equal(await page.locator("[data-folded-code]").count(), 1);
    assert.equal(await page.locator(".sw-onboarding-prompt").isVisible(), false);
    assert.match(await page.locator("[data-folded-code] summary").innerText(), /不会生效/);
    // And the primary action is to check again after fixing it.
    assert.match(await page.locator("button[data-recheck]").innerText(), /重新检测/);

    // A detection that finds the tag and no handshake says the same thing.
    await page.locator("[data-folded-code] summary").click();
    await page.locator(".sw-onboarding-stage").nth(1).locator("button:not(.sw-onboarding-link)").first().click();
    await page.waitForSelector(".sw-onboarding-notice", { timeout: 10_000 });
    assert.match(await page.locator(".sw-onboarding-notice").innerText(), /接入条件未满足/);
  });
});

test("both ends on this machine is development: no conditions, no warnings", async () => {
  const state = localPendingSite();
  state.publicAddress = { origin: "", source: "none", installationId: "install-test", usableForPublicSites: false };
  await withFlow(state, async (page) => {
    await page.waitForSelector(".sw-onboarding-prompt", { timeout: 15_000 });
    assert.equal(await page.locator("[data-install-conditions]").count(), 0, "本机站点配本地控制台：一条条件都不出");
    assert.equal(await page.locator("[data-folded-code]").count(), 0, "代码照常给出");
    assert.equal(await page.locator(".sw-onboarding-alert").count(), 0);
  });
});

test("the console asks a browser to try the install before the reader pastes anything", async () => {
  // No measurement yet: the console rehearses, then re-reads the verdict.
  const state = pendingSite();
  state.readiness = (round) => (round === 1
    ? { readiness: { siteUrl: "https://shop.example/" }, policy: { source: "inferred", blocked: false, findings: [], patches: [] } }
    : { readiness: { siteUrl: "https://shop.example/" }, policy: { source: "measured", blocked: false, findings: [], patches: [] } });
  state.nextJob = () => ({ id: "preview-rehearsal", createdAt: new Date().toISOString(), status: "succeeded" });
  await withFlow(state, async (page, { calls }) => {
    await page.waitForSelector("[data-install-conditions]", { timeout: 15_000 });
    const deadline = Date.now() + 15_000;
    while (!calls.some((call) => call.kind === "detect" && call.mode === "try-install") && Date.now() < deadline) {
      await page.waitForTimeout(200);
    }
    const rehearsal = calls.find((call) => call.kind === "detect" && call.mode === "try-install");
    assert.ok(rehearsal, `应当请求一次试装：${JSON.stringify(calls.map((call) => call.kind))}`);
    // What is rehearsed is exactly what the reader would paste.
    assert.match(rehearsal.installSnippet, /^<script src="https:\/\/console\.acme\.test\/sitewake\.js"/);
    // And once it has run, the reader sees one line saying they can install.
    await page.waitForFunction(
      () => /检查通过/.test(document.querySelector("[data-install-conditions]")?.textContent || ""),
      null,
      { timeout: 15_000 },
    );
    // The measurement is still there, one click away.
    assert.equal(await page.locator("[data-install-conditions] li").count(), 0, "全通过时不铺开三行");
    await page.getByRole("button", { name: /查看详情/ }).click();
    const details = (await page.locator("[data-install-conditions]").innerText()).replace(/\s+/g, " ");
    // Three short rows: what it loads from, which address, and the policy.
    assert.match(details, /代码来源 https:\/\/console\.acme\.test/);
    assert.match(details, /网站地址 shop\.example/);
    assert.match(details, /安全策略 /);
  });
});

test("the policy condition is measured for the reader, and pressing check measures the website again", async () => {
  // The reader should never have to read a browser console and judge a CSP
  // error: the control plane rehearses the install and reports what the
  // browser refused, with the policy to paste back.
  const state = pendingSite();
  state.nextJob = () => ({ id: `preview-${Date.now()}`, createdAt: new Date(Date.now() - 1_000).toISOString(), status: "succeeded" });
  state.preview = { artifactId: "a", url: "u", pageUrl: "https://shop.example/", capturedAt: NOW, width: 1440, height: 900, agentDetected: true, detectedSiteAgentIds: ["shop.example"] };
  // First round: the browser refused the script and the API. Second round —
  // after the reader changed the policy and pressed check — nothing is refused.
  state.readiness = (round) => (round === 1
    ? {
      readiness: { siteUrl: "https://shop.example/" },
      platform: "vercel",
      policy: {
        source: "measured",
        blocked: true,
        findings: [
          { kind: "script", blocked: true, directive: "script-src-elem", disposition: "enforce" },
          { kind: "api", blocked: true, directive: "connect-src", disposition: "enforce" },
        ],
        patches: [{
          before: "default-src 'self'",
          after: "default-src 'self'; script-src-elem 'self' https://console.acme.test; connect-src 'self' https://console.acme.test",
          directives: ["script-src-elem", "connect-src"],
          edits: [
            { directive: "script-src-elem", add: "https://console.acme.test", present: false, sources: ["'self'", "https://console.acme.test"] },
            { directive: "connect-src", add: "https://console.acme.test", present: true, sources: ["'self'", "https://console.acme.test"] },
          ],
          source: "header",
          strictDynamic: false,
        }],
      },
    }
    : { readiness: { siteUrl: "https://shop.example/" }, policy: { source: "measured", blocked: false, findings: [], patches: [] } });
  await withFlow(state, async (page, { calls }) => {
    const conditions = page.locator("[data-install-conditions]");
    await conditions.waitFor({ timeout: 15_000 });
    await conditions.locator('li[data-condition="policy"][data-state="unmet"]').waitFor({ timeout: 10_000 });
    const text = (await conditions.innerText()).replace(/\s+/g, " ");
    assert.match(text, /已在浏览器中试装/, "说实测，不是「如果浏览器提示…」");
    assert.match(text, /脚本被拦截（script-src-elem）/);
    assert.match(text, /接口被拦截（connect-src）/);
    // What actually has to change is stated one directive at a time. A real
    // policy runs to kilobytes; printing it whole says nothing about the edit.
    const edits = (await conditions.locator("[data-policy-edits] li").allInnerTexts()).map((line) => line.replace(/\s+/g, " ").trim());
    assert.deepEqual(edits, [
      "新增一条 script-src-elem 'self' https://console.acme.test",
      "connect-src 追加 https://console.acme.test",
    ]);
    assert.ok(!text.includes("default-src 'self'; script-src-elem"), `完整策略默认折起来：${text}`);
    assert.match(text, /vercel/);

    // The whole policy is one click away, for a reader who wants to read it.
    await conditions.locator("[data-full-policy] summary").click();
    assert.match((await conditions.innerText()).replace(/\s+/g, " "), /default-src 'self'; script-src-elem 'self' https:\/\/console\.acme\.test/);

    // The list of refusals sits inside a row, and must not inherit the row's
    // own grid — it once did, and every line broke one character wide.
    const findingWidth = await conditions.locator(".sw-condition-blocked li").first().evaluate((element) => element.getBoundingClientRect().width);
    assert.ok(findingWidth > 120, `被拦项被挤成一列：${findingWidth}px`);

    // The policy is the one thing here that has to be reproduced exactly, so
    // it is copied rather than retyped.
    await conditions.locator("button[data-copy-policy]").click();
    await page.waitForFunction(() => /策略已复制/.test(document.querySelector("[data-install-conditions]")?.textContent || ""), null, { timeout: 5_000 });
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      "default-src 'self'; script-src-elem 'self' https://console.acme.test; connect-src 'self' https://console.acme.test",
    );

    // While a condition is unmet the primary action is the re-check, not the
    // copy: pressing it re-measures, so a reader who fixed the policy does not
    // have to tell the console about it.
    await page.locator("button[data-recheck]").click();
    const deadline = Date.now() + 10_000;
    while (calls.filter((call) => call.kind === "readiness").length < 2 && Date.now() < deadline) await page.waitForTimeout(100);
    assert.ok(calls.filter((call) => call.kind === "readiness").length >= 2, "每次检测都重新体检一次网站");
    await page.waitForFunction(
      () => /检查通过/.test(document.querySelector("[data-install-conditions]")?.textContent || ""),
      null,
      { timeout: 10_000 },
    );
  });
});

test("the check never waits for the clipboard; copying marks step one done and makes the check primary", async () => {
  await withFlow(pendingSite(), async (page) => {
    await page.waitForSelector(".sw-onboarding-prompt", { timeout: 15_000 });
    // Before copying: the check is already enabled (a user who copied by hand,
    // or set the site up earlier, just clicks it), only not yet the primary action.
    const detectButton = page.locator(".sw-onboarding-stage").nth(1).locator("button:not(.sw-onboarding-link)");
    assert.equal(await detectButton.isDisabled(), false);
    assert.ok(!(await detectButton.getAttribute("class") || "").includes("sw-onboarding-primary"));
    assert.equal(await page.locator("button.sw-onboarding-primary").count(), 1, "one primary action at a time: copy");

    await armDetect(page);
    assert.equal(await detectButton.isDisabled(), false);
    assert.match(await detectButton.getAttribute("class"), /sw-onboarding-primary/);
    assert.match(await page.locator(".sw-onboarding-stage").first().innerText(), /重新复制提示词/);
  });
});

test("the flow shows the arrow cursor; only copyable text and inputs show the text cursor, buttons the hand", async () => {
  await withFlow(pendingSite(), async (page) => {
    await page.waitForSelector(".sw-onboarding-prompt", { timeout: 15_000 });
    const cursor = (selector) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).cursor);
    assert.equal(await cursor(".sw-onboarding-lead"), "default");
    assert.equal(await cursor(".sw-onboarding-stage small"), "default");
    assert.equal(await cursor(".sw-onboarding-prompt"), "text");
    assert.equal(await cursor("button.sw-onboarding-primary"), "pointer");
    assert.equal(await cursor(".sw-onboarding-tabs button"), "pointer");
    // The manual tab: the code block is copyable too.
    await page.locator(".sw-onboarding-tabs button").nth(1).click();
    await page.waitForSelector(".sw-onboarding-code", { timeout: 5_000 });
    assert.equal(await cursor(".sw-onboarding-code"), "text");
    assert.equal(await cursor(".sw-onboarding-install-steps small"), "default");
  });
});

test("without the async clipboard API (a plain-HTTP console) the legacy copy command still copies", async () => {
  await withFlow(pendingSite(), async (page) => {
    await page.addInitScript(() => {
      // What a browser exposes on an insecure origin: no navigator.clipboard at all.
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
      window.__copied = [];
      document.addEventListener("copy", (event) => {
        window.__copied.push(document.activeElement?.value ?? window.getSelection()?.toString() ?? "");
      });
    });
    await page.reload();
    await page.waitForSelector(".sw-onboarding-prompt", { timeout: 15_000 });
    const prompt = await page.locator(".sw-onboarding-prompt").innerText();
    await page.locator("button.sw-onboarding-primary").first().click();
    await page.waitForFunction(() => document.body.innerText.includes("提示词已复制"), null, { timeout: 5_000 });
    const copied = await page.evaluate(() => window.__copied);
    assert.equal(copied.length, 1);
    assert.equal(copied[0].trim(), prompt.trim(), "the legacy command copied the whole prompt");
    assert.equal(await page.locator(".sw-onboarding-error").count(), 0);
  });
});

test("when every copy route refuses, the prompt is selected for a manual copy and nothing claims success", async () => {
  await withFlow(pendingSite(), async (page) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error("denied")) },
      });
      document.execCommand = () => false;
    });
    await page.reload();
    await page.waitForSelector(".sw-onboarding-prompt", { timeout: 15_000 });
    const prompt = await page.locator(".sw-onboarding-prompt").innerText();
    await page.locator("button.sw-onboarding-primary").first().click();
    await page.waitForSelector(".sw-onboarding-error", { timeout: 5_000 });
    assert.match(await page.locator(".sw-onboarding-error").innerText(), /自动复制没有成功.*Ctrl\+C/);
    assert.ok(!(await page.locator(".sw-onboarding-panel").innerText()).includes("提示词已复制"));
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    assert.equal(selected.trim(), prompt.trim(), "the prompt text is selected, ready for Ctrl+C");
    // And the check is still available.
    assert.equal(await page.locator(".sw-onboarding-stage").nth(1).locator("button").first().isDisabled(), false);
  });
});

test("a check in flight cannot be fired twice", async () => {
  const state = pendingSite();
  // The job stays queued: the verdict stays in progress, ideal for testing double clicks.
  state.nextJob = () => ({ id: "preview-1", createdAt: new Date().toISOString(), status: "queued" });
  await withFlow(state, async (page, { calls }) => {
    await armDetect(page);
    const detect = page.locator(".sw-onboarding-stage").nth(1).locator("button.sw-onboarding-primary");
    await detect.click();
    await page.waitForFunction(() => document.body.innerText.includes("正在检测网站"), null, { timeout: 5_000 });
    assert.equal(await detect.isDisabled(), true, "进行中不可再次触发");
    await page.waitForTimeout(300);
    assert.equal(calls.filter((call) => call.kind === "detect").length, 1, "只发出一个检测请求");
  });
});

test("a page without the install code says so and points at the entry file", async () => {
  const state = pendingSite();
  state.nextJob = () => ({ id: "preview-1", createdAt: new Date(Date.now() - 1_000).toISOString(), status: "succeeded" });
  state.preview = { artifactId: "a", url: "u", pageUrl: "https://shop.example/", capturedAt: NOW, width: 1440, height: 900, agentDetected: false, detectedSiteAgentIds: [] };
  await withFlow(state, async (page) => {
    await armDetect(page);
    await page.locator(".sw-onboarding-stage").nth(1).locator("button.sw-onboarding-primary").click();
    await page.waitForSelector(".sw-onboarding-notice", { timeout: 10_000 });
    const notice = await page.locator(".sw-onboarding-notice").innerText();
    assert.match(notice, /还没有检测到接入/);
    assert.match(notice, /没有找到接入代码/);
    // Not called a failure; stays on step two with troubleshooting expanded.
    assert.ok(!notice.includes("失败"), `不该出现「失败」：${notice}`);
    assert.match(await page.locator(".sw-onboarding-kicker").innerText(), /第二步/);
    await page.waitForSelector(".sw-onboarding-troubleshoot", { timeout: 5_000 });
  });
});

test("an install that is present but silent points at CSP and the address instead", async () => {
  // Both ends local — the one pairing a browser allows — so nothing about
  // addresses is in the way and the generic explanation is the right one.
  const state = localPendingSite();
  state.nextJob = () => ({ id: "preview-1", createdAt: new Date(Date.now() - 1_000).toISOString(), status: "succeeded" });
  state.preview = { artifactId: "a", url: "u", pageUrl: "http://localhost:5173/", capturedAt: NOW, width: 1440, height: 900, agentDetected: true, detectedSiteAgentIds: ["shop.example"] };
  await withFlow(state, async (page) => {
    assert.equal(await page.locator(".sw-onboarding-alert").count(), 0, "本地站点配本地控制台没有任何阻碍");
    await armDetect(page);
    await page.locator(".sw-onboarding-stage").nth(1).locator("button.sw-onboarding-primary").click();
    await page.waitForSelector(".sw-onboarding-notice", { timeout: 10_000 });
    assert.match(await page.locator(".sw-onboarding-notice").innerText(), /接入代码在页面上但未连接/);
  });
});

test("a page bound to another existing site stops the flow and names that site", async () => {
  const state = pendingSite();
  // The other is a real site in the list — that is "bound to another site": stop, overwrite neither.
  state.agents = [...state.agents, summaryFor("docs.other.test", { connection: connectionAt(NOW) })];
  state.overviews["docs.other.test"] = overviewFor("docs.other.test", { connection: connectionAt(NOW) });
  state.nextJob = () => ({ id: "preview-1", createdAt: new Date(Date.now() - 1_000).toISOString(), status: "succeeded" });
  state.preview = { artifactId: "a", url: "u", pageUrl: "https://shop.example/", capturedAt: NOW, width: 1440, height: 900, agentDetected: true, detectedSiteAgentIds: ["docs.other.test"] };
  await withFlow(state, async (page, { calls, state: live }) => {
    const before = JSON.stringify(live.agents);
    await armDetect(page);
    await page.locator(".sw-onboarding-stage").nth(1).locator("button.sw-onboarding-primary").click();
    await page.waitForSelector(".sw-onboarding-alert", { timeout: 10_000 });
    const alert = await page.locator(".sw-onboarding-alert").filter({ hasText: "接入的是另一个网站" }).innerText();
    assert.match(alert, /接入的是另一个网站/);
    assert.ok(alert.includes("docs.other.test"), "把对方的标识说出来");
    // Not judged connected, neither side touched, no adoption attempted.
    assert.equal(await page.locator(".sw-onboarding-success-panel").count(), 0);
    assert.equal(JSON.stringify(live.agents), before);
    assert.equal(calls.filter((call) => call.kind === "adopt").length, 0);
  });
});

test("deleted and re-added: the flow adopts the identifier still on the page, re-checks, and connects", async () => {
  // The user deleted shop-old and re-added by address, getting shop.example; the page
  // snippet still says shop-old, which is no longer in the list — it is unowned and the
  // current site is empty: adopt it.
  const state = pendingSite();
  // The real shape of a site the wizard just created: registering publishes
  // release 0 and confirming the address publishes release 1. Nothing has been
  // learned, so this must not stand in the way — a version test here is what
  // kept the whole path from ever running on the production console.
  state.overviews["shop.example"].activeReleaseVersion = 1;
  state.overviews["shop.example"].activeRelease = { ...state.overviews["shop.example"].activeRelease, version: 1 };
  state.nextJob = () => ({ id: `preview-${Date.now()}`, createdAt: new Date(Date.now() - 1_000).toISOString(), status: "succeeded" });
  state.preview = { artifactId: "a", url: "u", pageUrl: "https://shop.example/", capturedAt: NOW, width: 1440, height: 900, agentDetected: true, detectedSiteAgentIds: ["shop-old"] };
  await withFlow(state, async (page, { calls, state: live }) => {
    await armDetect(page);
    await page.locator(".sw-onboarding-stage").nth(1).locator("button.sw-onboarding-primary").click();
    // Adoption happens, the flow switches to the new id, a notice appears, detection re-runs.
    await page.waitForSelector(".sw-onboarding-adopted", { timeout: 15_000 });
    const adopts = calls.filter((call) => call.kind === "adopt");
    assert.deepEqual(adopts, [{ kind: "adopt", from: "shop.example", to: "shop-old" }]);
    assert.equal(new URL(page.url()).searchParams.get("site"), "shop-old");
    const notice = await page.locator(".sw-onboarding-adopted").innerText();
    assert.ok(notice.includes("shop-old") && notice.includes("shop.example"), "通知里新旧标识都在");
    assert.match(notice, /不用改/);
    // After adoption the re-check uses the new id: check the request, not the UI text (the mocked job succeeds instantly).
    const deadline = Date.now() + 10_000;
    while (!calls.some((call) => call.kind === "detect" && call.url.includes("/shop-old/")) && Date.now() < deadline) await page.waitForTimeout(200);
    const detects = calls.filter((call) => call.kind === "detect");
    assert.ok(detects.some((call) => call.url.includes("/shop-old/")), `沿用后以新标识自动重检: ${JSON.stringify(detects)}`);
    // The page's SDK can now handshake as shop-old: handshake arrived means connected.
    live.overviews["shop-old"].connection = { ...connectionAt(new Date(Date.now() + 5_000).toISOString()), siteAgentId: "shop-old" };
    live.agents = live.agents.map((agent) => (agent.id === "shop-old" ? { ...agent, connection: live.overviews["shop-old"].connection } : agent));
    await page.waitForSelector(".sw-onboarding-success-panel", { timeout: 15_000 });
    assert.match(await page.locator(".sw-onboarding-success-panel").innerText(), /接入成功/);
    assert.ok(!live.agents.some((agent) => agent.id === "shop.example"), "旧空壳不在列表里了");
  });
});

test("a site that already holds something is never replaced: the page has to change, and no adoption is offered", async () => {
  const state = pendingSite();
  // Learned content is what makes a site non-empty — adopting would delete it.
  state.overviews["shop.example"].activeReleaseVersion = 1;
  state.overviews["shop.example"].activeRelease = {
    ...state.overviews["shop.example"].activeRelease,
    version: 1,
    scenes: [{ id: "scene_home", title: "首页", url: "https://shop.example/", summary: "首页", elements: [], links: [] }],
  };
  state.nextJob = () => ({ id: `preview-${Date.now()}`, createdAt: new Date(Date.now() - 1_000).toISOString(), status: "succeeded" });
  state.preview = { artifactId: "a", url: "u", pageUrl: "https://shop.example/", capturedAt: NOW, width: 1440, height: 900, agentDetected: true, detectedSiteAgentIds: ["shop-old"] };
  await withFlow(state, async (page, { calls }) => {
    await armDetect(page);
    await page.locator(".sw-onboarding-stage").nth(1).locator("button.sw-onboarding-primary").click();
    const alert = page.locator(".sw-onboarding-alert").filter({ hasText: "对不上" });
    await alert.waitFor({ timeout: 15_000 });
    const text = await alert.innerText();
    assert.ok(text.includes("shop-old") && text.includes("shop.example"), "点名页面上的标识和应该改成的标识");
    assert.equal(calls.filter((call) => call.kind === "adopt").length, 0, "不空就不沿用");
    // No button may offer what the server would refuse; only re-checking is left.
    const buttons = await alert.locator("button").allInnerTexts();
    assert.deepEqual(buttons.map((item) => item.trim()), ["重新检测"]);
  });
});

test("when adoption is refused the flow says so and keeps the re-check", async () => {
  const state = pendingSite({ adoptFails: true });
  state.nextJob = () => ({ id: `preview-${Date.now()}`, createdAt: new Date(Date.now() - 1_000).toISOString(), status: "succeeded" });
  state.preview = { artifactId: "a", url: "u", pageUrl: "https://shop.example/", capturedAt: NOW, width: 1440, height: 900, agentDetected: true, detectedSiteAgentIds: ["shop-old"] };
  await withFlow(state, async (page, { calls }) => {
    await armDetect(page);
    await page.locator(".sw-onboarding-stage").nth(1).locator("button.sw-onboarding-primary").click();
    const refusal = page.locator(".sw-onboarding-alert").filter({ hasText: "沿用没有成功" });
    await refusal.waitFor({ timeout: 15_000 });
    const alert = await refusal.innerText();
    assert.equal(calls.filter((call) => call.kind === "adopt").length, 1, "一个窗口只自动试一次");
    assert.equal(await page.locator(".sw-onboarding-success-panel").count(), 0);
    assert.ok((await refusal.locator("button").allInnerTexts()).some((text) => text.includes("重新检测")));
  });
});

test("when the server cannot reach the address the flow waits for a handshake instead of failing", async () => {
  const state = pendingSite();
  state.nextJob = () => ({ id: "preview-1", createdAt: new Date(Date.now() - 1_000).toISOString(), status: "failed", error: "site_preview_navigation_failed" });
  await withFlow(state, async (page, { state: live }) => {
    await armDetect(page);
    await page.locator(".sw-onboarding-stage").nth(1).locator("button.sw-onboarding-primary").click();
    await page.waitForFunction(() => document.body.innerText.includes("打开你的网站，我们在这里等"), null, { timeout: 10_000 });
    const notice = await page.locator(".sw-onboarding-notice").innerText();
    assert.match(notice, /本机地址/, "说清为什么服务端过不去");
    assert.ok(!notice.includes("接入失败"), "不呈现为接入失败");

    // Handshake arrives while waiting: no second click needed, moves to step three by itself.
    live.overviews["shop.example"].connection = connectionAt(new Date(Date.now() + 5_000).toISOString());
    await page.waitForSelector(".sw-onboarding-success-panel", { timeout: 15_000 });
    assert.match(await page.locator(".sw-onboarding-success-panel h1").innerText(), /接入成功/);
  });
});

test("a fresh handshake finishes the flow and the console opens on the new site", async () => {
  const state = pendingSite();
  state.nextJob = () => ({ id: "preview-1", createdAt: new Date(Date.now() - 1_000).toISOString(), status: "running" });
  await withFlow(state, async (page, { state: live }) => {
    await armDetect(page);
    await page.locator(".sw-onboarding-stage").nth(1).locator("button.sw-onboarding-primary").click();
    await page.waitForFunction(() => document.body.innerText.includes("正在检测网站"), null, { timeout: 10_000 });

    live.overviews["shop.example"].connection = connectionAt(new Date(Date.now() + 5_000).toISOString());
    live.agents = [summaryFor("shop.example", { connection: live.overviews["shop.example"].connection })];
    // A model is already in place (from .env here): no model step, straight to the result.
    await page.waitForSelector(".sw-onboarding-success-panel", { timeout: 15_000 });
    assert.equal(await page.locator("[data-onboarding-model]").count(), 0, "已有模型时没有模型这一步");
    assert.equal(await page.locator(".sw-onboarding-steps li").count(), 3);
    const panel = await page.locator(".sw-onboarding-success-panel").innerText();
    assert.match(panel, /接入成功/);
    assert.ok(panel.includes("shop.example"), "把网站地址摆出来");
    // The big check mark + "connected" already say it; no redundant status badge.
    assert.ok(!panel.includes("已连接"), "结果页不重复标注已连接");
    // The first handshake already scheduled a knowledge read for the user: say so and point to the progress; no action required.
    assert.match(panel, /网站知识正在自动读取/);
    assert.match(panel, /网站知识/);
    assert.ok(!panel.includes("立即读取"), "结果页不让用户去点读取");

    await page.locator(".sw-onboarding-success-panel button.sw-onboarding-primary").click();
    await page.waitForSelector(".sw-shell", { timeout: 10_000 });
    // Lands on the site just connected.
    assert.ok((await page.locator(".sw-site-current").innerText()).includes("示例商城"));
    assert.equal(await page.locator(".sw-onboarding").count(), 0);
  });
});

test("a stale handshake from before this check does not count as connected", async () => {
  const state = pendingSite();
  // The site handshook long ago, but before this detection round started.
  state.overviews["shop.example"].connection = connectionAt("2026-09-01T00:00:00.000Z");
  state.agents = [summaryFor("shop.example", { connection: state.overviews["shop.example"].connection })];
  state.nextJob = () => ({ id: "preview-1", createdAt: new Date(Date.now() - 1_000).toISOString(), status: "succeeded" });
  state.preview = { artifactId: "a", url: "u", pageUrl: "https://shop.example/", capturedAt: NOW, width: 1440, height: 900, agentDetected: false, detectedSiteAgentIds: [] };
  await withFlow(state, async (page) => {
    // This site has a connection record, so it goes straight to the console; returning to
    // the flow from site settings is out of scope. Only the rule is checked: a stale
    // handshake must not count as "connected".
    await page.waitForSelector(".sw-shell", { timeout: 15_000 });
    assert.equal(await page.locator(".sw-onboarding-success-panel").count(), 0);
  });
});

test("a site waiting to connect is marked in the switcher and reopens the flow", async () => {
  const connected = "docs.example";
  const pending = "shop.example";
  const connection = { ...connectionAt(NOW), siteAgentId: connected, origin: "https://docs.example", url: "https://docs.example/" };
  await withFlow({
    agents: [
      { ...summaryFor(connected, { connection }), profile: profile({ name: "帮助中心", entryUrl: "https://docs.example/" }) },
      summaryFor(pending),
    ],
    overviews: {
      [connected]: { ...overviewFor(connected, { connection }), profile: profile({ name: "帮助中心", entryUrl: "https://docs.example/" }) },
      [pending]: overviewFor(pending),
    },
  }, async (page) => {
    await page.waitForSelector(".sw-shell", { timeout: 15_000 });
    await page.locator(".sw-site-current").click();
    await page.waitForSelector(".sw-site-menu", { timeout: 5_000 });
    const menu = await page.locator(".sw-site-menu").innerText();
    assert.ok(menu.includes("待接入"), `切换器里应标出待接入：${menu}`);
    assert.equal(await page.locator(".sw-site-menu .sw-site-pending").count(), 1, "只有没握手过的那个带标记");

    // Clicking returns to step two of the flow without creating a site.
    await page.locator(".sw-site-menu > div > button").nth(1).click();
    await page.waitForSelector(".sw-onboarding", { timeout: 10_000 });
    assert.match(await page.locator(".sw-onboarding-kicker").innerText(), /第二步/);
    assert.ok((await page.locator(".sw-onboarding-prompt").innerText()).includes(pending), "带的是这个网站原有的接入标识");
  }, { query: `?site=docs.example` });
});

test("reloading inside the flow comes back to the same place and creates nothing", async () => {
  await withFlow(pendingSite(), async (page, { calls }) => {
    await page.waitForSelector(".sw-onboarding", { timeout: 15_000 });
    assert.match(await page.locator(".sw-onboarding-kicker").innerText(), /第二步/);
    await page.reload();
    await page.waitForSelector(".sw-onboarding", { timeout: 15_000 });
    assert.match(await page.locator(".sw-onboarding-kicker").innerText(), /第二步/, "刷新仍在第二步");
    assert.ok((await page.locator(".sw-onboarding-prompt").innerText()).includes("shop.example"), "接入标识不变");
    assert.equal(calls.filter((call) => call.kind === "create").length, 0, "刷新不会建站");
  });
});

test("reloading on step one creates no empty site", async () => {
  await withFlow({}, async (page, { calls }) => {
    await page.waitForSelector(".sw-onboarding-field input", { timeout: 15_000 });
    await page.locator(".sw-onboarding-field input").fill("https://shop.example");
    await page.reload();
    await page.waitForSelector(".sw-onboarding-field input", { timeout: 15_000 });
    assert.match(await page.locator(".sw-onboarding-kicker").innerText(), /第一步/);
    assert.equal(calls.filter((call) => call.kind === "create").length, 0);
  });
});

test("once a site connects the switcher drops the waiting mark on its own", async () => {
  const id = "shop.example";
  const state = { agents: [summaryFor(id)], overviews: { [id]: overviewFor(id) }, detectingSite: id };
  state.nextJob = () => ({ id: "preview-1", createdAt: new Date(Date.now() - 1_000).toISOString(), status: "running" });
  await withFlow(state, async (page, { state: live }) => {
    await armDetect(page);
    await page.locator(".sw-onboarding-stage").nth(1).locator("button.sw-onboarding-primary").click();
    await page.waitForFunction(() => document.body.innerText.includes("正在检测网站"), null, { timeout: 10_000 });

    // Handshake stored: the site is no longer pending, the flow reaches step three, and the switcher badge is gone in the console.
    const connection = connectionAt(new Date(Date.now() + 5_000).toISOString());
    live.overviews[id].connection = connection;
    live.agents = [summaryFor(id, { connection })];
    await page.waitForSelector(".sw-onboarding-success-panel", { timeout: 15_000 });
    await page.locator(".sw-onboarding-success-panel button.sw-onboarding-primary").click();
    await page.waitForSelector(".sw-shell", { timeout: 10_000 });

    await page.locator(".sw-site-current").click();
    await page.waitForSelector(".sw-site-menu", { timeout: 5_000 });
    assert.equal(await page.locator(".sw-site-menu .sw-site-pending").count(), 0, "连上之后不再标待接入");
  });
});

const OVERFLOW_SCAN = () => {
      const wide = [];
      // The page itself never scrolls horizontally; long content scrolls inside its own container.
      if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) wide.push("document");
      // Only the deliberate scroll containers are exempt. Cannot use computed overflow-x:
      // with only overflow-y:auto set, overflow-x computes to auto, every child of the
      // content area would be skipped and this guard would be empty.
      const SCROLLERS = ["sw-onboarding-code", "sw-onboarding-prompt", "sw-onboarding-rail", "sw-onboarding-main"];
      const insideScroller = (node) => {
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          if (SCROLLERS.some((name) => parent.classList.contains(name))) {
            // The content area may scroll vertically, but its children still must not overflow horizontally.
            return !parent.classList.contains("sw-onboarding-main");
          }
        }
        return false;
      };
      for (const node of document.querySelectorAll(".sw-onboarding *")) {
        const style = getComputedStyle(node);
        if (style.overflowX === "auto" || style.overflowX === "scroll") continue;
        // Screen-reader-only text is clipped to 1px by design; not an overflow.
        if (node.classList.contains("sw-visually-hidden")) continue;
        // Long content (code, prompt, rail) has its own scroll container by design; not a page overflow.
        if (insideScroller(node)) continue;
        if (node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0) wide.push(node.className || node.tagName);
      }
  return wide;
};

async function assertFits(page, label) {
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 820 }]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(120);
    assert.deepEqual(await page.evaluate(OVERFLOW_SCAN), [], `${label} 在 ${size.width}px 下溢出了`);
  }
}

test("without a model, step three is the form: a failed verification says why, a passing one unlocks save, and saving reaches step four", async () => {
  const state = pendingSite({ model: MODEL_MISSING });
  state.nextJob = () => ({ id: "preview-1", createdAt: new Date(Date.now() - 1_000).toISOString(), status: "running" });
  state.modelVerify = (body) => body.apiKey === "sk-right-0001"
    ? { ok: true, results: [{ stage: "runtime-router", ok: true, status: 200 }, { stage: "runtime-page-agent", ok: true, status: 200 }], durationMs: 900 }
    : { ok: false, hint: "401", results: [{ stage: "runtime-router", ok: false, status: 401, detail: "invalid_api_key" }, { stage: "runtime-page-agent", ok: false, status: 401, detail: "invalid_api_key" }], durationMs: 300 };
  await withFlow(state, async (page, { calls, state: live }) => {
    await armDetect(page);
    await page.locator(".sw-onboarding-stage").nth(1).locator("button.sw-onboarding-primary").click();
    live.overviews["shop.example"].connection = connectionAt(new Date(Date.now() + 5_000).toISOString());
    live.agents = [summaryFor("shop.example", { connection: live.overviews["shop.example"].connection })];
    await page.waitForSelector("[data-onboarding-model] [data-model-form]", { timeout: 15_000 });
    const rail = await page.locator(".sw-onboarding-steps li").evaluateAll((nodes) => nodes.map((n) => n.className));
    assert.deepEqual(rail, ["is-done", "is-done", "is-current", "is-upcoming"], "no model yet: four steps, the model one current");
    assert.match(await page.locator("[data-onboarding-model]").innerText(), /接入模型/);
    // Provider menu from the verified list, plus "other"; the key field never shows a value.
    const options = await page.locator("[data-model-form] select option").allInnerTexts();
    assert.deepEqual(options, ["OpenAI", "阿里云百炼", "其他 OpenAI 兼容服务"]);
    assert.equal(await page.locator("[data-model-form] input[type=password]").inputValue(), "");
    assert.equal(await page.locator("[data-model-form] button.sw-mng-primary").isDisabled(), true, "未验证不能保存");
    assert.equal(await page.locator("[data-model-form] button[type=submit]").isDisabled(), true, "没填完不能验证");

    await page.locator("[data-model-form] input[type=password]").fill("sk-wrong-0000");
    await page.locator("[data-model-form] input[type=text]").fill("gpt-5.6-luna");
    await page.locator("[data-model-form] button[type=submit]").click();
    await page.waitForSelector('[data-verification="failed"]', { timeout: 10_000 });
    const failed = await page.locator('[data-verification="failed"]').innerText();
    assert.match(failed, /401\/403/, "与向导相同的提示");
    assert.match(failed, /对话路由/);
    assert.match(failed, /HTTP 401/);
    assert.equal(await page.locator("[data-model-form] button.sw-mng-primary").isDisabled(), true, "验证失败不能保存");
    assert.equal(calls.filter((call) => call.kind === "saveModel").length, 0, "验证失败不写配置");

    await page.locator("[data-model-form] input[type=password]").fill("sk-right-0001");
    assert.equal(await page.locator('[data-verification]').count(), 0, "改动后上次验证作废");
    await page.locator("[data-model-form] button[type=submit]").click();
    await page.waitForSelector('[data-verification="ok"]', { timeout: 10_000 });
    assert.equal(await page.locator("[data-model-form] button.sw-mng-primary").isDisabled(), false);
    await page.locator("[data-model-form] button.sw-mng-primary").click();
    await page.waitForSelector(".sw-onboarding-success-panel", { timeout: 15_000 });
    const saves = calls.filter((call) => call.kind === "saveModel");
    assert.equal(saves.length, 1);
    assert.equal(saves[0].body.apiKey, "sk-right-0001");
    assert.equal(saves[0].body.model, "gpt-5.6-luna");
    assert.equal(saves[0].body.baseUrl, "https://api.openai.com/v1");
    // Step four still tells the user the site knowledge is being read.
    const panel = await page.locator(".sw-onboarding-success-panel").innerText();
    assert.match(panel, /接入成功/);
    assert.match(panel, /网站知识正在自动读取/);
    assert.deepEqual(await page.locator(".sw-onboarding-steps li").evaluateAll((nodes) => nodes.map((n) => n.className)), ["is-done", "is-done", "is-done", "is-current"]);
  });
});

test("a wrong address is fixed from step two: step one in the rail is clickable, same site, same identifier, new address", async () => {
  await withFlow(pendingSite(), async (page, { calls, state: live }) => {
    await page.waitForSelector(".sw-onboarding-prompt", { timeout: 15_000 });
    // Only the completed step one is clickable; the current and upcoming steps are not.
    assert.equal(await page.locator(".sw-onboarding-steps button").count(), 1);
    assert.equal(await page.locator(".sw-onboarding-steps li:first-child button").count(), 1);
    await page.locator(".sw-onboarding-steps li:first-child button").click();
    await page.waitForSelector('[data-onboarding-create="change"]', { timeout: 5_000 });
    assert.match(await page.locator(".sw-onboarding-kicker").innerText(), /第一步 · 更改网站地址/);
    assert.equal(await page.locator(".sw-onboarding-field input").inputValue(), "https://shop.example/", "the current address is prefilled");
    assert.deepEqual(await page.locator(".sw-onboarding-steps li").evaluateAll((nodes) => nodes.map((n) => n.className)), ["is-current", "is-upcoming", "is-upcoming"]);

    // While editing, the rail is back to "step one current": nothing clickable.
    assert.equal(await page.locator(".sw-onboarding-steps button").count(), 0);
    // Changing nothing and keeping the address returns to step two without a request.
    await page.locator(".sw-onboarding-actions button:not(.sw-onboarding-primary)").click();
    await page.waitForSelector(".sw-onboarding-prompt", { timeout: 5_000 });
    assert.equal(calls.filter((call) => call.kind === "create").length, 0);

    // The real fix: a new address on the same identifier, renamed after the new host.
    await page.locator(".sw-onboarding-steps li:first-child button").click();
    await page.waitForSelector('[data-onboarding-create="change"]', { timeout: 5_000 });
    await page.locator(".sw-onboarding-field input").fill("https://store.example/shop");
    await page.locator("button.sw-onboarding-primary").click();
    await page.waitForFunction(() => document.querySelector(".sw-onboarding-kicker")?.textContent?.includes("第二步"), null, { timeout: 10_000 });
    const creates = calls.filter((call) => call.kind === "create");
    assert.equal(creates.length, 1);
    assert.deepEqual(creates[0].body, { id: "shop.example", url: "https://store.example/shop", name: "store.example" });
    // The prompt now carries the new address; the site keeps its id.
    await page.waitForFunction(() => document.querySelector(".sw-onboarding-prompt")?.textContent?.includes("store.example"), null, { timeout: 10_000 });
    assert.equal(new URL(page.url()).searchParams.get("site"), "shop.example");
    assert.ok(!live.agents.some((agent) => agent.id !== "shop.example"), "no second site was created");
  });
});

test("every step fits its viewport at desktop and phone widths", async () => {
  // Step one
  await withFlow({}, async (page) => {
    await page.waitForSelector(".sw-onboarding-field input", { timeout: 15_000 });
    await assertFits(page, "第一步");
  });
  // Step two: both paths, the manual one with the code block
  await withFlow(pendingSite(), async (page) => {
    await page.waitForSelector(".sw-onboarding-prompt", { timeout: 15_000 });
    await assertFits(page, "第二步 · AI");
    await page.locator(".sw-onboarding-tabs").first().locator("button").nth(1).click();
    await page.waitForSelector(".sw-onboarding-code", { timeout: 5_000 });
    await assertFits(page, "第二步 · 手动");
    await page.locator(".sw-onboarding-stacks button").nth(2).click();
    await page.waitForFunction(() => document.querySelector(".sw-onboarding-code")?.textContent?.includes("next/script"), null, { timeout: 5_000 });
    await assertFits(page, "第二步 · Next.js");
  });
  // Step three (the form) and step four
  const state = pendingSite({ model: MODEL_MISSING });
  state.nextJob = () => ({ id: "preview-1", createdAt: new Date(Date.now() - 1_000).toISOString(), status: "running" });
  await withFlow(state, async (page, { state: live }) => {
    await armDetect(page);
    await page.locator(".sw-onboarding-stage").nth(1).locator("button.sw-onboarding-primary").click();
    live.overviews["shop.example"].connection = connectionAt(new Date(Date.now() + 5_000).toISOString());
    await page.waitForSelector("[data-model-form]", { timeout: 15_000 });
    await assertFits(page, "第三步");
    await page.locator("[data-model-form] input[type=password]").fill("sk-fits-1234");
    await page.locator("[data-model-form] input[type=text]").fill("gpt-fits");
    await page.locator("[data-model-form] button[type=submit]").click();
    await page.waitForSelector('[data-verification="ok"]', { timeout: 10_000 });
    await page.locator("[data-model-form] button.sw-mng-primary").click();
    await page.waitForSelector(".sw-onboarding-success-panel", { timeout: 15_000 });
    await assertFits(page, "第四步");
  });
});

test("the flow folds the rail on a narrow screen", async () => {
  await withFlow(pendingSite(), async (page) => {
    await page.waitForSelector(".sw-onboarding", { timeout: 15_000 });
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await page.locator(".sw-onboarding-rail").evaluate((node) => getComputedStyle(node).borderRightWidth), "1px");

    await page.setViewportSize({ width: 390, height: 820 });
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".sw-onboarding-rail")).borderRightWidth === "0px", null, { timeout: 5_000 });
    // The rail folds to the top: the steps in a row, all still visible.
    assert.equal(await page.locator(".sw-onboarding-steps li").count(), 3);
    const railBox = await page.locator(".sw-onboarding-rail").boundingBox();
    const mainBox = await page.locator(".sw-onboarding-main").boundingBox();
    assert.ok(railBox.y + railBox.height <= mainBox.y + 1, "导轨在内容上方，不再是左栏");
  });
});

test("no console tab carries onboarding chrome back into daily use", async () => {
  const id = "shop.example";
  const connection = connectionAt(NOW);
  await withFlow({
    agents: [summaryFor(id, { connection })],
    overviews: { [id]: overviewFor(id, { connection }) },
  }, async (page) => {
    await page.waitForSelector(".sw-shell", { timeout: 15_000 });
    // The four-page design's rule: first onboarding stays standalone; the everyday home keeps no step bar or install code.
    for (const view of ["", "agent", "sessions", "capabilities", "model", "settings"]) {
      await page.goto(`${page.url().split("?")[0]}?site=${id}${view ? `&view=${view}` : ""}`);
      await page.waitForSelector(".sw-shell", { timeout: 15_000 });
      await page.waitForTimeout(200);
      const banned = await page.evaluate(() => ({
        flow: document.querySelectorAll(".sw-onboarding").length,
        rail: document.querySelectorAll(".sw-onboarding-steps").length,
        code: document.querySelectorAll(".sw-onboarding-code, .sw-onboarding-prompt").length,
      }));
      assert.deepEqual(banned, { flow: 0, rail: 0, code: 0 }, `view=${view || "overview"} 出现了接入流程的元素`);
    }
  });
});

test("the password step exists only while there is a password to set", async () => {
  // The rail carries what is left to do. A console that already has a password
  // never sees this step, the same way the model step disappears once a model is
  // connected — and somebody who said to go without one is not asked again.
  const railNames = (page) => page.locator(".sw-onboarding-steps li").allInnerTexts()
    .then((rows) => rows.map((row) => row.split("\n").slice(1).join(" ").trim()));

  // No password, nobody skipped: the flow opens on it.
  await withFlow({ access: { configured: false, enabled: false, onboardingSkipped: false }, model: MODEL_FROM_ENV }, async (page) => {
    await page.waitForFunction(() => document.querySelectorAll(".sw-onboarding-steps li").length === 4, null, { timeout: 15_000 });
    const names = await railNames(page);
    assert.match(names[0], /设置密码/);
    assert.deepEqual(
      await page.locator(".sw-onboarding-steps li").evaluateAll((nodes) => nodes.map((node) => node.className)),
      ["is-current", "is-upcoming", "is-upcoming", "is-upcoming"],
    );
    assert.equal(await page.locator('[data-onboarding-password="set"]').count(), 1);
    assert.equal(await page.locator(".sw-onboarding-steps button, .sw-onboarding-steps a").count(), 0,
      "the rail is not navigation here either");
  });

  // Already configured: the step is absent, and the flow opens on the site.
  await withFlow({ access: { configured: true, enabled: true, onboardingSkipped: false }, model: MODEL_FROM_ENV }, async (page) => {
    await page.waitForFunction(() => document.querySelectorAll(".sw-onboarding-steps li").length === 3, null, { timeout: 15_000 });
    assert.equal((await railNames(page)).join(" ").includes("设置密码"), false);
    assert.equal(await page.locator('[data-onboarding-password="set"]').count(), 0);
    assert.match(await page.locator(".sw-onboarding-content h1").innerText(), /把 Agent 接进你的网站/);
  });

  // Skipped earlier, from any machine: not asked again.
  await withFlow({ access: { configured: false, enabled: false, onboardingSkipped: true }, model: MODEL_FROM_ENV }, async (page) => {
    await page.waitForFunction(() => document.querySelectorAll(".sw-onboarding-steps li").length === 3, null, { timeout: 15_000 });
    assert.equal((await railNames(page)).join(" ").includes("设置密码"), false);
    assert.equal(await page.locator('[data-onboarding-password="set"]').count(), 0);
  });
});

test("a password too short is refused in place, and a good one carries the flow to the site step", async () => {
  await withFlow({ access: { configured: false, enabled: false, onboardingSkipped: false }, model: MODEL_FROM_ENV }, async (page, { calls }) => {
    await page.waitForSelector('[data-onboarding-password="set"]', { timeout: 15_000 });
    const field = page.locator('[data-onboarding-password="set"] input[type="password"]');

    // Too short: the reason is shown, nothing is sent, and the step does not move.
    await field.fill("abc");
    await page.locator('[data-onboarding-password="set"] .sw-onboarding-primary').click();
    await page.waitForSelector('[data-onboarding-password="set"] .sw-onboarding-error', { timeout: 5_000 });
    assert.match(await page.locator('[data-onboarding-password="set"] .sw-onboarding-error').innerText(), /至少/);
    assert.equal(calls.filter((call) => call.kind === "setPassword").length, 0,
      "a length the browser can check is not worth a round trip");
    assert.equal(await page.locator('[data-onboarding-password="set"]').count(), 1);

    // A real one: the flow continues, and nothing asks for a login.
    await field.fill("a-real-password");
    await page.locator('[data-onboarding-password="set"] .sw-onboarding-primary').click();
    await page.waitForFunction(() => document.querySelector('[data-onboarding-create]') !== null
      || document.querySelector(".sw-onboarding-content h1") !== null, null, { timeout: 10_000 });
    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll(".sw-onboarding-steps li")];
      return nodes.length > 1 && nodes[1].className === "is-current";
    }, null, { timeout: 10_000 });
    assert.equal(calls.filter((call) => call.kind === "setPassword").length, 1);
    assert.equal(await page.locator('[data-onboarding-password="set"]').count(), 0);
    assert.equal(await page.locator(".sw-access-gate, [data-access-gate]").count(), 0,
      "setting the first password must not drop the user onto a login screen");
    assert.match(await page.locator(".sw-onboarding-content h1").innerText(), /把 Agent 接进你的网站/);
  });
});

test("skipping records the choice and moves on, without pretending the console is protected", async () => {
  await withFlow({ access: { configured: false, enabled: false, onboardingSkipped: false }, model: MODEL_FROM_ENV }, async (page, { calls }) => {
    await page.waitForSelector('[data-onboarding-password="set"]', { timeout: 15_000 });
    assert.match(await page.locator('[data-onboarding-password="set"] .sw-onboarding-note').innerText(), /任何人都能打开/);
    await page.locator('[data-onboarding-password="set"] .sw-onboarding-actions button:not(.sw-onboarding-primary)').click();
    await page.waitForFunction(() => document.querySelectorAll(".sw-onboarding-steps li").length === 3, null, { timeout: 10_000 });
    assert.equal(calls.filter((call) => call.kind === "skipOnboarding").length, 1,
      "the choice is recorded on the server, not only in this browser");
    assert.equal(await page.locator('[data-onboarding-password="set"]').count(), 0);
    assert.match(await page.locator(".sw-onboarding-content h1").innerText(), /把 Agent 接进你的网站/);
  });
});

test("the password step says the same thing in both languages", async () => {
  // The step is the first thing a new installation sees, so a missing English
  // key would greet an English reader with a blank panel or a Chinese sentence.
  const [zh, en] = await Promise.all([
    readFile(new URL("../lib/i18n/zh.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/i18n/en.ts", import.meta.url), "utf8"),
  ]);
  for (const key of ["title", "body", "placeholder", "submit", "skip", "skipHint", "tooShort", "failed"]) {
    assert.match(zh, new RegExp(`\\b${key}: "`), `zh is missing password.${key}`);
    assert.match(en, new RegExp(`\\b${key}: "`), `en is missing password.${key}`);
  }
  assert.match(zh, /password: "设置密码"/);
  assert.match(en, /password: "Set a password"/);
  // The component carries no sentence of its own.
  const component = await readFile(new URL("../components/console/onboarding.tsx", import.meta.url), "utf8");
  const panel = component.slice(component.indexOf('phase === "password"'), component.indexOf('phase === "create"'));
  assert.doesNotMatch(panel, /[一-鿿]/, "the panel must read its words from the dictionary");
  for (const key of ["copy.password.title", "copy.password.body", "copy.password.submit", "copy.password.skip", "copy.password.skipHint"]) {
    assert.ok(panel.includes(key), `the panel must wire ${key}`);
  }
});

test("the flow resumes where the installation actually is, not where a counter says", async () => {
  // 5.1 and 5.2 in one place, because they are the same property seen twice: the
  // rail is derived from server state, so a reload and a fresh browser both land
  // on whatever is left to do. Nothing records "the user reached step N" — if it
  // did, a reload could put somebody back on a step they had finished.
  const id = "shop.example";

  // Password set in this session, then reloaded: the password step is gone and
  // the flow is on the site, with no login screen in between.
  await withFlow({ access: { configured: false, enabled: false, onboardingSkipped: false }, model: MODEL_FROM_ENV }, async (page) => {
    await page.waitForSelector('[data-onboarding-password="set"]', { timeout: 15_000 });
    await page.locator('[data-onboarding-password="set"] input[type="password"]').fill("a-real-password");
    await page.locator('[data-onboarding-password="set"] .sw-onboarding-primary').click();
    await page.waitForFunction(() => document.querySelector('[data-onboarding-password="set"]') === null, null, { timeout: 10_000 });

    await page.reload();
    await page.waitForSelector(".sw-onboarding-steps", { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelectorAll(".sw-onboarding-steps li").length === 3, null, { timeout: 10_000 });
    assert.equal(await page.locator('[data-onboarding-password="set"]').count(), 0,
      "the step does not come back after a reload");
    assert.equal(await page.locator(".sw-access-gate, [data-access-gate]").count(), 0,
      "and the reload does not ask for the password that was just set");
    assert.match(await page.locator(".sw-onboarding-content h1").innerText(), /把 Agent 接进你的网站/);
  });

  // A site exists but never handshook, and the password is already set: the flow
  // opens on step two of three, which is what is actually left.
  await withFlow({
    access: { configured: true, enabled: true, onboardingSkipped: false },
    model: MODEL_FROM_ENV,
    agents: [{ id, profile: profile({ entryUrl: `https://${id}/` }), connection: null, updatedAt: NOW }],
  }, async (page) => {
    await page.goto(`${page.url().split("?")[0]}?site=${id}`);
    await page.waitForSelector(".sw-onboarding-steps", { timeout: 15_000 });
    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll(".sw-onboarding-steps li")];
      return nodes.length === 3 && nodes[1].className === "is-current";
    }, null, { timeout: 10_000 });
    assert.equal(await page.locator('[data-onboarding-password="set"]').count(), 0);
  });
});

test("no step counter is stored anywhere the flow reads", async () => {
  // The guard behind the test above: the rail is derived, so there is no
  // "current step" to get out of sync with reality. A stored counter would make
  // a reload able to disagree with the installation.
  const component = await readFile(new URL("../components/console/onboarding.tsx", import.meta.url), "utf8");
  const derivation = component.slice(component.indexOf("const phase: Phase"), component.indexOf("const step = phases.indexOf(phase)"));
  assert.match(derivation, /hasPasswordStep/);
  assert.match(derivation, /siteId/);
  assert.match(derivation, /connected/);
  assert.match(derivation, /hasModelStep/);
  // Nothing persists a position in the flow.
  assert.doesNotMatch(component, /localStorage|sessionStorage/, "a step counter must not be kept in the browser");
  assert.doesNotMatch(component, /onboardingStep|currentStep|stepIndex\s*=/, "nor in a state that outlives the derivation");
});

test("the password step's buttons are the flow's buttons, not the console shell's", async () => {
  // The onboarding panel styles its own buttons — 40px tall, 10px radius, the
  // accent for the primary one — and the console shell has a different family
  // with its own hover. Mixing them made this the only step that reacted
  // differently to a pointer, which is the kind of thing nobody reports and
  // everybody notices.
  const component = await readFile(new URL("../components/console/onboarding.tsx", import.meta.url), "utf8");
  const panel = component.slice(component.indexOf('phase === "password"'), component.indexOf('phase === "create"'));
  assert.match(panel, /className="sw-onboarding-primary"/, "the submit is the flow's primary button");
  assert.doesNotMatch(panel, /sw-primary-button|sw-secondary-button|sw-text-button/,
    "no console-shell button classes inside the flow");

  // Measured rather than asserted from the stylesheet: this is what "the same
  // as the other steps" actually means on screen.
  await withFlow({ access: { configured: false, enabled: false, onboardingSkipped: false }, model: MODEL_FROM_ENV }, async (page) => {
    await page.waitForSelector('[data-onboarding-password="set"]', { timeout: 15_000 });
    const here = await page.locator('[data-onboarding-password="set"] .sw-onboarding-actions button').evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node);
        return { height: style.minHeight, radius: style.borderRadius, size: style.fontSize, weight: style.fontWeight };
      }));
    assert.equal(here.length, 2);
    for (const button of here) {
      assert.equal(button.height, "40px");
      assert.equal(button.radius, "10px");
      assert.equal(button.size, "13px");
      assert.equal(button.weight, "650");
    }
  });
});
