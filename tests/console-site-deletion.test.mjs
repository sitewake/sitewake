import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

/**
 * Behavioral net for deleting a site in the console: each scenario of the
 * console/site-deletion spec maps here. Like console-onboarding it runs real components
 * in a real browser — "clicking delete does not switch site", "wrong name disables the
 * button", "where you land afterwards" are invisible to static assertions.
 */

const NOW = "2026-09-15T10:00:00.000Z";

function profile(name, entryUrl) {
  return { name, description: "", entryUrl, allowedOrigins: [new URL(entryUrl).origin], vocabulary: {}, suggestedGoals: [] };
}
function connectionFor(id, origin) {
  return { siteAgentId: id, origin, url: `${origin}/`, title: id, heading: id, connectedAt: NOW, lastSeenAt: NOW };
}
function site(id, name, { connected = true } = {}) {
  const entryUrl = `https://${id}/`;
  const connection = connected ? connectionFor(id, `https://${id}`) : undefined;
  const summary = { id, profile: profile(name, entryUrl), ...(connection ? { connection } : {}), activeReleaseVersion: 1, sceneCount: 0, capabilityCount: 0, taskCount: 0, episodeCount: 0, updatedAt: NOW };
  const overview = {
    ...summary, persistence: "memory", modelConfigured: true,
    activeRelease: { id: `${id}:release:1`, siteAgentId: id, version: 1, createdAt: NOW, profile: profile(name, entryUrl), scenes: [], capabilities: [], operations: [], contentHash: "h" },
    recentEpisodes: [], activeSessions: [], candidates: [], learningJobs: [], validationJobs: [], browserRuns: [], artifacts: [], runners: [],
  };
  return { summary, overview };
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

async function consoleServer(state) {
  const calls = [];
  const server = createServer((request, response) => {
    const url = request.url || "/";
    const json = (body, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (url === "/app.js") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(consoleScript); return; }
    if (url === "/globals.css") { response.writeHead(200, { "content-type": "text/css" }); response.end(css); return; }
    if (url === "/api/system/status") return json({ environment: "development", database: "SQLite / D1", artifactsConfigured: false, build: "development", models: Object.fromEntries(["general", "execution", "semantic"].map((role) => [role, { configured: true, model: "test" }])) });
    if (url.startsWith("/api/site-agents?") || url === "/api/site-agents") return json({ agents: state.sites.map((item) => item.summary) });
    if (url.startsWith("/api/admin/capability-v2/experiences")) return json({ intakes: [] });
    const match = url.match(/^\/api\/site-agents\/([^/?]+)(\/[^?]*)?/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const rest = match[2] || "";
      if (request.method === "DELETE" && !rest) {
        calls.push({ kind: "delete", id });
        if (state.deleteFails) return json({ error: "site_agent_delete_objects_failed", message: "网站的证据文件暂时删不掉，这次没有删除任何数据；请稍后重试。", retryable: true }, 503);
        if (!state.sites.some((item) => item.summary.id === id)) return json({ error: "site_agent_not_found" }, 404);
        state.sites = state.sites.filter((item) => item.summary.id !== id);
        return json({ deleted: true, persistence: "memory" });
      }
      const found = state.sites.find((item) => item.summary.id === id);
      if (!found) return json({ error: "site_agent_not_found" }, 404);
      if (rest.startsWith("/session-history")) return json({ records: [], total: 0 });
      if (rest.startsWith("/crawl")) return json({ jobs: [] });
      if (rest.startsWith("/content")) return json({ chunks: [] });
      if (!rest) return json(found.overview);
      return json({});
    }
    if (url.startsWith("/api/")) return json({});
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/globals.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>`);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, calls, origin: `http://127.0.0.1:${server.address().port}` };
}

async function withConsole(state, run, { query = "" } = {}) {
  const { server, calls, origin } = await consoleServer(state);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const crashes = [];
    page.on("pageerror", (error) => crashes.push(String(error)));
    await page.goto(`${origin}/${query}`);
    await run(page, { calls, state, origin });
    assert.deepEqual(crashes, [], "页面不该抛错");
  } finally {
    await browser.close().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
  }
}

const twoSites = () => ({ sites: [site("shop.example", "示例商城"), site("blog.example", "示例博客")] });
const dialog = ".sa-modal";
const deleteCalls = (calls) => calls.filter((call) => call.kind === "delete");

test("网站设置的「删除网站」只打开对话框；名称不对按不了，对了才发一次请求", async () => {
  await withConsole(twoSites(), async (page, { calls }) => {
    await page.waitForSelector(".sw-settings-danger", { timeout: 15_000 });
    await page.locator(".sw-settings-danger .sw-danger-button").click();
    await page.waitForSelector(dialog, { timeout: 5_000 });
    assert.equal(deleteCalls(calls).length, 0, "未确认前不发请求");
    const text = await page.locator(dialog).innerText();
    // One sentence says it all: who, what is lost, irreversible; the name also appears in the confirm label; the footnote reminds to remove the script.
    assert.match(text, /删除网站/);
    assert.match(text, /示例商城 的网站知识、能力、会话记录与证据文件会被永久删除/);
    assert.match(text, /无法撤销/);
    assert.match(text, /移除接入脚本/);
    assert.equal(await page.locator(`${dialog} ul`).count(), 0, "不再逐条罗列类别");
    assert.equal(await page.locator(`${dialog} input`).getAttribute("placeholder"), "示例商城");
    const confirm = page.locator(`${dialog} .sa-btn--danger`);
    assert.equal(await confirm.isDisabled(), true, "还没输入名称");
    await page.locator(`${dialog} input`).fill("示例博客");
    assert.equal(await confirm.isDisabled(), true, "名称不匹配");
    await page.locator(`${dialog} input`).fill("  示例商城 ");
    assert.equal(await confirm.isDisabled(), false, "去掉首尾空白后匹配");
    await confirm.click();
    await page.waitForSelector(dialog, { state: "detached", timeout: 10_000 });
    assert.equal(deleteCalls(calls).length, 1);
    assert.equal(deleteCalls(calls)[0].id, "shop.example");
    // Deleting the current site with others left: switch to the next one's overview.
    await page.waitForFunction(() => document.querySelector(".sw-site-current")?.textContent?.includes("示例博客"), null, { timeout: 10_000 });
    assert.equal(await page.locator(".sw-onboarding").count(), 0);
    assert.ok(new URL(page.url()).searchParams.get("site") === "blog.example");
  }, { query: "?site=shop.example&view=connection" });
});

test("取消不发请求；删除失败对话框留着并说明原因，网站还在", async () => {
  const state = { ...twoSites(), deleteFails: true };
  await withConsole(state, async (page, { calls }) => {
    await page.waitForSelector(".sw-settings-danger", { timeout: 15_000 });
    await page.locator(".sw-settings-danger .sw-danger-button").click();
    await page.waitForSelector(dialog);
    await page.locator(`${dialog} .sa-modal__foot button:not(.sa-btn--danger)`).first().click();
    await page.waitForSelector(dialog, { state: "detached" });
    assert.equal(deleteCalls(calls).length, 0, "取消不发请求");

    await page.locator(".sw-settings-danger .sw-danger-button").click();
    await page.waitForSelector(dialog);
    assert.equal(await page.locator(`${dialog} input`).inputValue(), "", "重新打开时输入是空的");
    await page.locator(`${dialog} input`).fill("示例商城");
    await page.locator(`${dialog} .sa-btn--danger`).click();
    await page.waitForSelector(`${dialog} [role="alert"]`, { timeout: 10_000 });
    assert.match(await page.locator(`${dialog} [role="alert"]`).innerText(), /证据文件暂时删不掉/);
    assert.equal(await page.locator(dialog).count(), 1, "失败后对话框保持打开");
    assert.equal(deleteCalls(calls).length, 1);
    // Retryable.
    state.deleteFails = false;
    await page.locator(`${dialog} .sa-btn--danger`).click();
    await page.waitForSelector(dialog, { state: "detached", timeout: 10_000 });
    assert.equal(deleteCalls(calls).length, 2);
  }, { query: "?site=shop.example&view=connection" });
});

test("系统设置的列表行：点「删除」不切换网站；待接入的网站也能从这里删", async () => {
  const state = { sites: [site("shop.example", "示例商城"), site("pending.example", "待接入站", { connected: false })] };
  await withConsole(state, async (page, { calls }) => {
    await page.waitForSelector(".sw-managed-site", { timeout: 15_000 });
    assert.equal(await page.locator(".sw-managed-site").count(), 2);
    const pendingRow = page.locator(".sw-managed-site", { hasText: "待接入站" });
    assert.match(await pendingRow.innerText(), /待接入/);
    await pendingRow.locator(".sw-managed-site-delete").click();
    await page.waitForSelector(dialog);
    assert.match(await page.locator(dialog).innerText(), /待接入站 的网站知识/);
    // Neither entered onboarding nor left system settings.
    assert.equal(await page.locator(".sw-onboarding").count(), 0);
    assert.ok(new URL(page.url()).searchParams.get("view") === "settings" || (await page.locator(".sw-managed-site").count()) === 2);
    await page.locator(`${dialog} input`).fill("待接入站");
    await page.locator(`${dialog} .sa-btn--danger`).click();
    await page.waitForSelector(dialog, { state: "detached", timeout: 10_000 });
    assert.deepEqual(deleteCalls(calls).map((call) => call.id), ["pending.example"]);
    // Deleting another site: one row fewer, page unchanged, current site unchanged.
    await page.waitForFunction(() => document.querySelectorAll(".sw-managed-site").length === 1, null, { timeout: 10_000 });
    assert.ok((await page.locator(".sw-site-current").innerText()).includes("示例商城"));
    assert.equal(await page.locator(".sw-onboarding").count(), 0);
  }, { query: "?site=shop.example&view=settings&section=sites" });
});

test("删的是当前网站时，落点优先挑已接入的网站，不掉进别人的接入流程", async () => {
  // List order: pending sites first, connected after — landing on remaining[0] would send the user into the pending site's step two.
  const state = { sites: [site("shop.example", "示例商城"), site("pending.example", "待接入站", { connected: false }), site("blog.example", "示例博客")] };
  await withConsole(state, async (page) => {
    await page.waitForSelector(".sw-settings-danger", { timeout: 15_000 });
    await page.locator(".sw-settings-danger .sw-danger-button").click();
    await page.waitForSelector(dialog);
    await page.locator(`${dialog} input`).fill("示例商城");
    await page.locator(`${dialog} .sa-btn--danger`).click();
    await page.waitForSelector(dialog, { state: "detached", timeout: 10_000 });
    await page.waitForFunction(() => document.querySelector(".sw-site-current")?.textContent?.includes("示例博客"), null, { timeout: 10_000 });
    assert.equal(await page.locator(".sw-onboarding").count(), 0, "不进待接入站的接入流程");
    assert.equal(new URL(page.url()).searchParams.get("site"), "blog.example");
  }, { query: "?site=shop.example&view=connection" });
});

test("删掉唯一的网站后进入 first 接入流程", async () => {
  await withConsole({ sites: [site("shop.example", "示例商城")] }, async (page) => {
    await page.waitForSelector(".sw-settings-danger", { timeout: 15_000 });
    await page.locator(".sw-settings-danger .sw-danger-button").click();
    await page.waitForSelector(dialog);
    await page.locator(`${dialog} input`).fill("示例商城");
    await page.locator(`${dialog} .sa-btn--danger`).click();
    await page.waitForSelector(".sw-onboarding", { timeout: 15_000 });
    assert.match(await page.locator(".sw-onboarding-kicker").innerText(), /第一步/);
    assert.equal(await page.locator(".sw-shell").count(), 0);
  }, { query: "?site=shop.example&view=connection" });
});

test("带着已删网站的 id 刷新：不显示它、不为它进接入流程，按既有兜底处理", async () => {
  await withConsole({ sites: [site("blog.example", "示例博客")] }, async (page) => {
    // The URL carries an id the server already 404s.
    await page.waitForSelector(".sw-shell", { timeout: 15_000 });
    await page.waitForTimeout(1_500);
    assert.equal(await page.locator(".sw-onboarding").count(), 0, "不为已删网站进接入流程");
    assert.equal(await page.locator(".sw-settings-danger").count(), 0, "不显示已删网站的设置");
    const text = await page.locator(".sw-shell").innerText();
    assert.ok(text.includes("网站数据尚未载入") || text.includes("找不到这个网站"), `既有兜底：${text.slice(0, 120)}`);
  }, { query: "?site=deleted.example&view=connection" });
});
