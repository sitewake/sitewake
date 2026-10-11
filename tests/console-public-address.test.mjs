/**
 * Settings › the address visitors load SiteWake from.
 *
 * The console is the real bundle in a real browser; the control plane is a stub
 * that answers the way the route does. What must hold is that a reader is told
 * which mode they are in, that a refused address names the step they have to go
 * and do, and that a successful save changes the mode on the spot.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const NOW = "2026-09-24T00:00:00.000Z";

function profile() {
  return { name: "示例商城", description: "一个用于验证的电商网站。", entryUrl: "https://shop.example/", allowedOrigins: ["https://shop.example"], vocabulary: {}, suggestedGoals: [], businessDomains: [] };
}
function overview() {
  const connection = { url: "https://shop.example/", origin: "https://shop.example", connectedAt: NOW, lastSeenAt: NOW, siteAgentId: "shop", title: "商城", heading: "商城" };
  return {
    id: "shop", profile: profile(), connection,
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
  Promise.all(["../app/globals.css", "../app/console-polish.css", "../components/console/sidebar.css"]
    .map((path) => readFile(new URL(path, import.meta.url), "utf8"))).then((parts) => parts.join("\n")),
]);

/** The control plane, as far as this section is concerned. */
async function consoleServer(state) {
  const calls = [];
  const server = createServer((request, response) => {
    const url = request.url || "/";
    const json = (body, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (url === "/app.js") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(consoleScript); return; }
    if (url === "/globals.css") { response.writeHead(200, { "content-type": "text/css" }); response.end(css); return; }
    if (url === "/api/system/public-address" && request.method === "GET") return json(state.address);
    if (url === "/api/system/public-address" && request.method === "PUT") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        calls.push({ kind: "save", body: parsed });
        const verdict = state.verdict(parsed);
        if (verdict.error) return json(verdict, 400);
        state.address = { ...state.address, origin: parsed.origin, source: "console", usableForPublicSites: true };
        json(state.address);
      });
      return;
    }
    if (url === "/api/system/status") {
      return json({ environment: "development", database: "memory", artifactsConfigured: false, build: "development", models: { general: { configured: true, model: "glm-5.2", source: "console" }, execution: { configured: true, model: "glm-5.2", source: "console" }, semantic: { configured: true, model: "glm-5.2", source: "console" } } });
    }
    if (url === "/api/system/model" && request.method === "GET") {
      return json({ source: "console", configured: true, baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.2", executionModel: "", semanticModel: "", apiKeyMasked: "sk-…key1", providers: [] });
    }
    if (url === "/api/site-agents") {
      const site = overview();
      return json({ agents: [{ id: site.id, profile: site.profile, connection: site.connection, activeReleaseVersion: 1, sceneCount: 0, capabilityCount: 0, taskCount: 0, episodeCount: 0, updatedAt: NOW }] });
    }
    if (url.startsWith("/api/site-agents/") && url.includes("/session-history")) return json({ records: [], total: 0 });
    if (url.startsWith("/api/site-agents/") && url.includes("/crawl")) return json({ jobs: [] });
    if (url.startsWith("/api/site-agents/")) return json(overview());
    if (url.startsWith("/api/")) return json({});
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/globals.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>`);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, calls, origin: `http://127.0.0.1:${server.address().port}` };
}

async function withSettings(state, run) {
  const { server, calls, origin } = await consoleServer(state);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const crashes = [];
    page.on("pageerror", (error) => crashes.push(String(error)));
    await page.goto(`${origin}/?view=settings&section=runtime`);
    await page.waitForSelector("[data-public-address]", { timeout: 15_000 });
    await run(page, { calls, state, origin });
    assert.deepEqual(crashes, []);
  } finally {
    await browser.close().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
  }
}

test("the section says which mode this installation is in, refuses what cannot work, and switches mode on a save", async () => {
  const state = {
    address: { origin: "http://203.0.113.9:3000", source: "env", installationId: "install-a", usableForPublicSites: false },
    verdict: (body) => {
      // The stub answers exactly as the route does: shape first, then whether
      // anything reached this installation.
      if (/^https:\/\/localhost/.test(body.origin)) return { error: "public_address_rejected", reason: "local", detail: "localhost" };
      if (body.origin === "https://console.wrong.test") {
        return { error: "public_address_unverified", reason: "dns", resolved: ["198.51.100.4"], expected: ["203.0.113.9"] };
      }
      return {};
    },
  };
  await withSettings(state, async (page, { calls }) => {
    const block = page.locator("[data-public-address]");
    const initial = (await block.innerText()).replace(/\s+/g, " ");
    // The installer's guess is shown for what it is, and the mode is a state,
    // not a failure.
    assert.match(initial, /http:\/\/203\.0\.113\.9:3000/);
    assert.match(initial, /安装时自动填写/);
    assert.match(initial, /本地模式/);
    // The way to get an address is right there, and it says who does it.
    assert.match(initial, /在它前面放一层反向代理/);
    assert.match(initial, /caddy reverse-proxy/);
    assert.match(initial, /也可暂不配置/);

    const input = block.locator("#sw-public-address-input");
    const submit = block.locator("button[type=submit]");

    // A local address: refused, and the reason is what a visitor's browser can reach.
    await input.fill("https://localhost:3000");
    await submit.click();
    await page.waitForFunction(() => document.querySelector("[data-public-address] .sw-error"), null, { timeout: 10_000 });
    assert.match(await block.locator(".sw-error").innerText(), /仅本机或内网可达/);

    // A real-looking address that points elsewhere: the DNS record is named,
    // with both values.
    await input.fill("https://console.wrong.test");
    await submit.click();
    await page.waitForFunction(() => /解析到/.test(document.querySelector("[data-public-address] .sw-error")?.textContent || ""), null, { timeout: 10_000 });
    const dns = await block.locator(".sw-error").innerText();
    assert.match(dns, /198\.51\.100\.4/);
    assert.match(dns, /203\.0\.113\.9/);

    // The address that works: saved, and the installation is in online mode.
    await input.fill("https://console.acme.test");
    await submit.click();
    await page.waitForFunction(() => /已保存/.test(document.querySelector("[data-public-address]")?.textContent || ""), null, { timeout: 10_000 });
    const after = (await block.innerText()).replace(/\s+/g, " ");
    assert.match(after, /已就绪/);
    assert.match(after, /console\.acme\.test/);
    assert.ok(!after.includes("本地模式"), "模式切换后不再显示旧状态");

    // Every attempt carried what this browser saw at that address, which is the
    // evidence a server behind NAT cannot gather for itself.
    assert.deepEqual(calls.map((call) => call.body.origin), ["https://localhost:3000", "https://console.wrong.test", "https://console.acme.test"]);
    assert.equal(calls[2].body.browserProbe.ok, false, "这台浏览器打不开测试域名，如实上报");
  });
});

test("the administration address is called out as irrelevant to the snippet", async () => {
  const state = {
    address: { origin: "", source: "none", installationId: "install-a", usableForPublicSites: false },
    verdict: () => ({}),
  };
  await withSettings(state, async (page, { origin }) => {
    const text = (await page.locator("[data-public-address]").innerText()).replace(/\s+/g, " ");
    assert.match(text, new RegExp(origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "说明里点名当前管理地址");
    assert.match(text, /不会写进接入代码/);
    assert.match(text, /未设置/);
  });
});

test("the banner says it once for the installation, and only when a public website is here", async () => {
  // Local trial mode with a website on the internet: exactly one statement,
  // in the shell, not one per site.
  const blocked = {
    address: { origin: "http://203.0.113.9:3000", source: "env", installationId: "install-a", usableForPublicSites: false },
    verdict: () => ({}),
  };
  await withSettings(blocked, async (page) => {
    await page.waitForSelector("[data-public-address-banner]", { timeout: 10_000 });
    assert.equal(await page.locator("[data-public-address-banner]").count(), 1, "整个控制台只出现一处");
    const text = (await page.locator("[data-public-address-banner]").innerText()).replace(/\s+/g, " ");
    assert.match(text, /公网站点暂时无法接入/);
    assert.match(text, /配置 https/);
  });

  // Once the address works, the statement is gone — nothing to say.
  const online = {
    address: { origin: "https://console.acme.test", source: "console", installationId: "install-a", usableForPublicSites: true },
    verdict: () => ({}),
  };
  await withSettings(online, async (page) => {
    await page.waitForSelector("[data-public-address]", { timeout: 10_000 });
    assert.equal(await page.locator("[data-public-address-banner]").count(), 0);
  });
});

test("the section is dated by nothing: it reads its value every time it is opened", async () => {
  const state = {
    address: { origin: "https://console.acme.test", source: "console", installationId: "install-a", usableForPublicSites: true },
    verdict: () => ({}),
  };
  await withSettings(state, async (page) => {
    const text = (await page.locator("[data-public-address]").innerText()).replace(/\s+/g, " ");
    assert.match(text, /已就绪/);
    assert.match(text, /手动设置/);
    // Nothing to fix, so the how-to stays out of the way.
    assert.equal(await page.locator("[data-public-address] .sw-public-address-guide").count(), 0);
  });
});


test("every line of the section starts on the card's one left edge, and the card ends below its last line", async () => {
  // The card carries no padding of its own: each child holds the inset. The
  // form, its guide and its error were written without one and ran out to the
  // border while the rows above them stayed indented.
  const state = {
    address: { origin: "http://203.0.113.9:3000", source: "env", installationId: "install-a", usableForPublicSites: false },
    verdict: () => ({ error: "public_address_rejected", reason: "malformed" }),
  };
  await withSettings(state, async (page) => {
    await page.locator("[data-public-address] #sw-public-address-input").fill("https://console.acme.test");
    await page.locator("[data-public-address] button[type=submit]").click();
    await page.waitForFunction(() => document.querySelector("[data-public-address] .sw-error"), null, { timeout: 10_000 });
    const geometry = await page.evaluate(() => {
      const card = document.querySelector("[data-public-address]");
      const cardBox = card.getBoundingClientRect();
      // Where a line visibly starts. A box that paints a surface of its own
      // starts at its border; a plain paragraph starts where its text does,
      // and in this card a paragraph carries the inset as its padding.
      const edge = (selector) => {
        const node = card.querySelector(selector);
        if (!node) return null;
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const paints = style.backgroundColor !== "rgba(0, 0, 0, 0)" || parseFloat(style.borderLeftWidth) > 0;
        const padLeft = paints ? 0 : parseFloat(style.paddingLeft);
        const padRight = paints ? 0 : parseFloat(style.paddingRight);
        return {
          left: Math.round(box.left - cardBox.left + padLeft),
          right: Math.round(cardBox.right - box.right + padRight),
          bottom: Math.round(cardBox.bottom - box.bottom),
        };
      };
      return {
        heading: edge("header h2"),
        note: edge(".sw-public-address > .sw-setting-note"),
        label: edge(".sw-public-address-form label"),
        input: edge(".sw-public-address-form input"),
        button: edge(".sw-public-address-form button"),
        error: edge(".sw-error"),
        guideLead: edge(".sw-public-address-guide .sw-setting-note"),
        guideSteps: edge(".sw-public-address-guide pre"),
        last: edge(".sw-public-address-guide > :last-child"),
      };
    });
    const inset = geometry.heading.left;
    assert.ok(inset >= 16, `卡片内缩应当存在，实测 ${inset}px`);
    for (const name of ["note", "label", "input", "error", "guideLead", "guideSteps", "last"]) {
      assert.equal(geometry[name].left, inset, `${name} 的左边缘应与标题对齐，实测 ${geometry[name].left}px`);
    }
    // The button shares the input's row, so its right edge is the one that
    // has to sit on the card's inset.
    assert.equal(geometry.button.right, inset, `按钮右边缘应与卡片内缩对齐，实测 ${geometry.button.right}px`);
    assert.ok(geometry.button.left > geometry.input.left, "按钮排在输入框之后");
    assert.equal(geometry.guideSteps.right, inset, "步骤块不贴到卡片边框");
    assert.ok(geometry.last.bottom >= 12, `卡片底部应留白，实测 ${geometry.last.bottom}px`);
  });
});
