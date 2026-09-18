import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

/**
 * The appearance preview must say the same thing as the widget visitors really see.
 *
 * The brand and greeting the server generates from site knowledge are **Chinese**
 * (AgentConfig.generatedLocale). For a visitor who cannot read that language the widget
 * falls back to its built-in dictionary; if the preview rendered the config's copy
 * directly, an English console would preview a screen of Chinese — while visitors
 * actually see English. Not merely "untranslated": the preview would be lying.
 *
 * So this renders the real component in a real browser, once per language: the English
 * run must land on the widget dictionary, the Chinese run must keep the personalized
 * copy with the site name (reversed fallback layers are equally invisible until you
 * switch language).
 */

const NOW = "2026-09-09T10:00:00.000Z";

function profile() {
  return {
    name: "示例商城",
    description: "一个用于验证的电商网站。",
    entryUrl: "https://shop.example/",
    allowedOrigins: ["https://shop.example"],
    vocabulary: {},
    suggestedGoals: [],
    jobsToBeDone: ["查询订单状态"],
  };
}

function overview() {
  return {
    id: "shop.example",
    profile: profile(),
    activeReleaseVersion: 1,
    sceneCount: 0, capabilityCount: 0, taskCount: 0, episodeCount: 0,
    updatedAt: NOW,
    persistence: "memory",
    modelConfigured: true,
    activeRelease: {
      id: "shop.example:release:1", siteAgentId: "shop.example", version: 1, createdAt: NOW,
      profile: profile(), scenes: [], capabilities: [], operations: [], contentHash: "h",
    },
    recentEpisodes: [], activeSessions: [], candidates: [],
    learningJobs: [], validationJobs: [], browserRuns: [], artifacts: [], runners: [],
  };
}

const script = await build({
  stdin: {
    contents: `
      import { createRoot } from "react-dom/client";
      import { AgentExperience } from ${JSON.stringify(fileURLToPath(new URL("../components/console/settings.tsx", import.meta.url)))};
      createRoot(document.getElementById("root")).render(<AgentExperience overview={window.__overview} onSaved={() => {}} />);
    `,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "tsx",
  },
  bundle: true, format: "iife", jsx: "automatic", write: false, logLevel: "silent",
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "production" } };' },
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".css": "empty" },
}).then((result) => result.outputFiles[0].text);

/** `<html lang>` is the console's only locale source (see lib/i18n activeLocale), so it is written from the query. */
async function withPreview(lang, run) {
  const server = createServer((request, response) => {
    if ((request.url || "/").startsWith("/app.js")) {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(script);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"></head><body><div id="root"></div>`
      + `<script>window.__overview = ${JSON.stringify(overview())}</script><script src="/app.js"></script></body></html>`);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const crashes = [];
    page.on("pageerror", (error) => crashes.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector(".sw-preview-canvas .sw-chat-preview", { timeout: 15_000 });
    await run(page);
    assert.deepEqual(crashes, [], "页面不该抛错");
  } finally {
    await browser.close().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
  }
}

const canvas = {
  name: ".sw-chat-preview header b",
  title: ".sw-chat-preview .sw-chat-welcome h3",
  body: ".sw-chat-preview .sw-chat-welcome p",
  placeholder: ".sw-chat-preview .sw-preview-composer span",
  poweredBy: ".sw-chat-preview footer small",
};

test("英文控制台里，预览落到挂件自带的英文词表，而不是生成出来的中文", async () => {
  await withPreview("en", async (page) => {
    assert.equal(await page.locator(canvas.name).innerText(), "Site assistant");
    assert.equal(await page.locator(canvas.title).innerText(), "What would you like to do on this site?");
    assert.equal(await page.locator(canvas.placeholder).innerText(), "Give SiteWake a goal…");
    assert.equal(await page.locator(canvas.poweredBy).innerText(), "Powered by SiteWake");
    for (const [part, selector] of Object.entries(canvas)) {
      assert.doesNotMatch(await page.locator(selector).innerText(), /[一-鿿]/, `${part} 仍然是中文`);
    }
    // The inputs next to it show the same "auto" values. If the two disagree, people edit against copy they cannot see.
    assert.equal(await page.locator("#agent-displayName").inputValue(), "Site assistant");
    assert.equal(await page.locator("#agent-welcomeTitle").inputValue(), "What would you like to do on this site?");
  });
});

test("运营手打的文案压过语言回落——那是他对自己网站的措辞选择", async () => {
  await withPreview("en", async (page) => {
    await page.fill("#agent-displayName", "Shop helper");
    assert.equal(await page.locator(canvas.name).innerText(), "Shop helper");
  });
});

test("中文控制台仍然预览到带站点名的个性化文案，没有被回落成通用句", async () => {
  await withPreview("zh-CN", async (page) => {
    assert.equal(await page.locator(canvas.name).innerText(), "示例商城助手");
    assert.equal(await page.locator(canvas.title).innerText(), "想在示例商城完成什么？");
    assert.match(await page.locator(canvas.body).innerText(), /查询订单状态/);
    assert.equal(await page.locator(canvas.poweredBy).innerText(), "由 SiteWake 提供");
  });
});
