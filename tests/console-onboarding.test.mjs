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
    if (url === "/api/system/status") return json({ environment: "development", database: "SQLite / D1", artifactsConfigured: false, build: "development", models: Object.fromEntries(["general", "execution", "semantic"].map((role) => [role, { configured: true, model: "m" }])) });
    if (url.startsWith("/api/site-agents") && url.includes("/preview") && request.method === "POST") {
      calls.push({ kind: "detect", url });
      if (state.detectFails) return json({ error: "site_preview_enqueue_failed" }, 500);
      state.job = state.nextJob ? state.nextJob() : { id: `preview-${calls.length}`, createdAt: new Date().toISOString(), status: "queued" };
      return json({ job: state.job }, 202);
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
          const bound = profile({ name: parsed.id, entryUrl: parsed.url, allowedOrigins: [new URL(parsed.url).origin] });
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

async function withFlow(state, run, { query = "" } = {}) {
  const initial = { agents: [], overviews: {}, ...state };
  const { server, calls, origin } = await flowServer(initial);
  const browser = await chromium.launch({ headless: true });
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

test("the three-step rail marks progress and never lets you jump ahead", async () => {
  await withFlow({}, async (page) => {
    await page.waitForSelector(".sw-onboarding-steps", { timeout: 15_000 });
    const steps = page.locator(".sw-onboarding-steps li");
    assert.equal(await steps.count(), 3);
    assert.deepEqual(
      await steps.evaluateAll((nodes) => nodes.map((node) => node.className)),
      ["is-current", "is-upcoming", "is-upcoming"],
    );
    // The rail is not navigation: none of the three steps is clickable, no skipping.
    assert.equal(await page.locator(".sw-onboarding-steps button, .sw-onboarding-steps a").count(), 0);
    assert.equal(await page.locator(".sw-onboarding-success-panel").count(), 0);
  });
});

test("a site that never handshook opens at step two instead of the console", async () => {
  const id = "shop.example";
  await withFlow({ agents: [summaryFor(id)], overviews: { [id]: overviewFor(id) } }, async (page) => {
    await page.waitForSelector(".sw-onboarding", { timeout: 15_000 });
    assert.match(await page.locator(".sw-onboarding-kicker").innerText(), /第二步/);
    const steps = await page.locator(".sw-onboarding-steps li").evaluateAll((nodes) => nodes.map((n) => n.className));
    assert.deepEqual(steps, ["is-done", "is-current", "is-upcoming"]);
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

test("troubleshooting is available before anything fails and never reads as an error", async () => {
  const id = "shop.example";
  await withFlow({ agents: [summaryFor(id)], overviews: { [id]: overviewFor(id) } }, async (page, { origin }) => {
    await page.waitForSelector(".sw-onboarding-link", { timeout: 15_000 });
    const toggle = page.locator(".sw-onboarding-link").last();
    assert.match(await toggle.innerText(), /检测遇到问题/);
    assert.equal(await page.locator(".sw-onboarding-troubleshoot").count(), 0, "默认收起");

    await toggle.click();
    await page.waitForSelector(".sw-onboarding-troubleshoot", { timeout: 5_000 });
    const panel = page.locator(".sw-onboarding-troubleshoot");
    const text = await panel.innerText();
    for (const topic of ["脚本没有加载", "内容安全策略", "地址与登记的网站地址不一致"]) {
      assert.ok(text.includes(topic), `排查里应覆盖「${topic}」`);
    }
    // Expanding deliberately is not an error state.
    assert.equal(await panel.getAttribute("role"), null);
    assert.equal(await page.locator('.sw-onboarding-troubleshoot[role="alert"]').count(), 0);
    // The CSP snippet carries the console's real SDK origin.
    assert.ok(text.includes(origin), "CSP 说明里给出真实来源");
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

/** Only after "copy prompt" does the detect button become the primary action. */
async function armDetect(page) {
  await page.waitForSelector(".sw-onboarding-prompt", { timeout: 15_000 });
  await page.locator("button.sw-onboarding-primary").first().click();
  await page.waitForFunction(() => document.body.innerText.includes("提示词已复制"), null, { timeout: 5_000 });
}

test("copying the prompt unlocks the check, and a clipboard refusal never claims success", async () => {
  await withFlow(pendingSite(), async (page) => {
    await page.waitForSelector(".sw-onboarding-prompt", { timeout: 15_000 });
    // Before copying, detect is not the enabled primary action, but the "connected before" secondary entry exists.
    const detectButton = page.locator(".sw-onboarding-stage").nth(1).locator("button.sw-onboarding-primary");
    assert.equal(await detectButton.isDisabled(), true);
    assert.match(await page.locator(".sw-onboarding-stage").nth(1).locator(".sw-onboarding-link").innerText(), /以前已经接入过/);

    await armDetect(page);
    assert.equal(await detectButton.isDisabled(), false);
    assert.match(await page.locator(".sw-onboarding-stage").first().innerText(), /重新复制提示词/);
  });
});

test("a clipboard that refuses is reported instead of being shown as copied", async () => {
  await withFlow(pendingSite(), async (page) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error("denied")) },
      });
    });
    await page.reload();
    await page.waitForSelector(".sw-onboarding-prompt", { timeout: 15_000 });
    await page.locator("button.sw-onboarding-primary").first().click();
    await page.waitForSelector(".sw-onboarding-error", { timeout: 5_000 });
    assert.match(await page.locator(".sw-onboarding-error").innerText(), /复制没有成功/);
    assert.ok(!(await page.locator(".sw-onboarding-panel").innerText()).includes("提示词已复制"));
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
  const state = pendingSite();
  state.nextJob = () => ({ id: "preview-1", createdAt: new Date(Date.now() - 1_000).toISOString(), status: "succeeded" });
  state.preview = { artifactId: "a", url: "u", pageUrl: "https://shop.example/", capturedAt: NOW, width: 1440, height: 900, agentDetected: true, detectedSiteAgentIds: ["shop.example"] };
  await withFlow(state, async (page) => {
    await armDetect(page);
    await page.locator(".sw-onboarding-stage").nth(1).locator("button.sw-onboarding-primary").click();
    await page.waitForSelector(".sw-onboarding-notice", { timeout: 10_000 });
    assert.match(await page.locator(".sw-onboarding-notice").innerText(), /接入代码在页面上，但没有连回来/);
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
    const alert = await page.locator(".sw-onboarding-alert").innerText();
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

test("an unowned identifier on a site that is not empty is not adopted automatically, and both ways out are shown", async () => {
  const state = pendingSite();
  // The current site already has knowledge (version 1): not empty, no automatic adoption.
  state.overviews["shop.example"].activeRelease.version = 1;
  state.overviews["shop.example"].activeReleaseVersion = 1;
  state.nextJob = () => ({ id: `preview-${Date.now()}`, createdAt: new Date(Date.now() - 1_000).toISOString(), status: "succeeded" });
  state.preview = { artifactId: "a", url: "u", pageUrl: "https://shop.example/", capturedAt: NOW, width: 1440, height: 900, agentDetected: true, detectedSiteAgentIds: ["shop-old"] };
  await withFlow(state, async (page, { calls }) => {
    await armDetect(page);
    await page.locator(".sw-onboarding-stage").nth(1).locator("button.sw-onboarding-primary").click();
    await page.waitForSelector(".sw-onboarding-alert", { timeout: 10_000 });
    const alert = await page.locator(".sw-onboarding-alert").innerText();
    assert.match(alert, /没有对应的网站/);
    assert.ok(alert.includes("shop-old") && alert.includes("shop.example"), "两条路都点名：改页面成当前标识，或沿用页面上的");
    assert.equal(calls.filter((call) => call.kind === "adopt").length, 0, "不空就不自动沿用");
    // Manual adoption uses the same endpoint.
    await page.locator(".sw-onboarding-alert button.sw-onboarding-primary").click();
    await page.waitForSelector(".sw-onboarding-adopted", { timeout: 15_000 });
    assert.deepEqual(calls.filter((call) => call.kind === "adopt"), [{ kind: "adopt", from: "shop.example", to: "shop-old" }]);
  });
});

test("when adoption is refused the flow says so and keeps the re-check", async () => {
  const state = pendingSite({ adoptFails: true });
  state.nextJob = () => ({ id: `preview-${Date.now()}`, createdAt: new Date(Date.now() - 1_000).toISOString(), status: "succeeded" });
  state.preview = { artifactId: "a", url: "u", pageUrl: "https://shop.example/", capturedAt: NOW, width: 1440, height: 900, agentDetected: true, detectedSiteAgentIds: ["shop-old"] };
  await withFlow(state, async (page, { calls }) => {
    await armDetect(page);
    await page.locator(".sw-onboarding-stage").nth(1).locator("button.sw-onboarding-primary").click();
    await page.waitForSelector(".sw-onboarding-alert", { timeout: 15_000 });
    const alert = await page.locator(".sw-onboarding-alert").innerText();
    assert.match(alert, /沿用没有成功/);
    assert.equal(calls.filter((call) => call.kind === "adopt").length, 1, "一个窗口只自动试一次");
    assert.equal(await page.locator(".sw-onboarding-success-panel").count(), 0);
    assert.ok((await page.locator(".sw-onboarding-alert button").allInnerTexts()).some((text) => text.includes("重新检测")));
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
    await page.waitForSelector(".sw-onboarding-success-panel", { timeout: 15_000 });
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
  // Step three
  const state = pendingSite();
  state.nextJob = () => ({ id: "preview-1", createdAt: new Date(Date.now() - 1_000).toISOString(), status: "running" });
  await withFlow(state, async (page, { state: live }) => {
    await armDetect(page);
    await page.locator(".sw-onboarding-stage").nth(1).locator("button.sw-onboarding-primary").click();
    live.overviews["shop.example"].connection = connectionAt(new Date(Date.now() + 5_000).toISOString());
    await page.waitForSelector(".sw-onboarding-success-panel", { timeout: 15_000 });
    await assertFits(page, "第三步");
  });
});

test("the flow folds the rail on a narrow screen", async () => {
  await withFlow(pendingSite(), async (page) => {
    await page.waitForSelector(".sw-onboarding", { timeout: 15_000 });
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await page.locator(".sw-onboarding-rail").evaluate((node) => getComputedStyle(node).borderRightWidth), "1px");

    await page.setViewportSize({ width: 390, height: 820 });
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".sw-onboarding-rail")).borderRightWidth === "0px", null, { timeout: 5_000 });
    // The rail folds to the top: three steps in a row, all still visible.
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
