import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { emptyRelease } from "../lib/site-knowledge/protocol.ts";

/**
 * "Launcher position: bottom-left" must move the panel along with the launcher.
 *
 * The panel is anchored to the host's right edge and the host is only as wide as
 * the launcher: with the launcher bottom-left, the 430px panel spread leftward from
 * the launcher's right edge and mostly left the viewport. Load the built artifact in
 * a real browser, open the panel in each position, and require it to sit entirely in
 * the viewport, flush with the launcher's side.
 */
const sdk = await readFile(new URL("../public/sitewake.js", import.meta.url), "utf8");
// The widget links its stylesheet from the control plane now: a site with
// `style-src 'self'` refuses an injected one (measured), so the fixture
// serves it exactly as the control plane does.
const sdkCss = await readFile(new URL("../public/sitewake.css", import.meta.url), "utf8");

function site(launcherPosition) {
  const release = { ...emptyRelease("position-test"), agentConfig: { appearance: { preset: "orb", palette: "mint", launcherPosition }, overrides: {}, features: {} } };
  return createServer((request, response) => {
    const path = new URL(request.url, "http://x").pathname;
    if (path === "/sitewake.js") { response.writeHead(200, { "content-type": "application/javascript" }); response.end(sdk); return; }
    if (path === "/sitewake.css") { response.writeHead(200, { "content-type": "text/css" }); response.end(sdkCss); return; }
    if (path.endsWith("/release")) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ release })); return; }
    if (path.startsWith("/api/")) { response.writeHead(503, { "content-type": "application/json" }); response.end("{}"); return; }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>Position test</title><h1>site</h1>
      <script src="/sitewake.js" data-site-agent="position-test" data-endpoint="http://${request.headers.host}" data-open="true" defer></script>`);
  });
}

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });

/** Viewport rectangles of the launcher and the (open) panel. */
async function layout(page) {
  await page.waitForFunction(() => {
    const host = document.querySelector('[data-sitewake-agent="widget"]');
    const panel = host?.shadowRoot?.querySelector(".panel");
    return Boolean(host?.dataset.position && panel && !panel.hidden && panel.getBoundingClientRect().width > 0);
  }, undefined, { timeout: 15_000 });
  return page.evaluate(async () => {
    const host = document.querySelector('[data-sitewake-agent="widget"]');
    // The entrance animation scales by .985; measuring before it ends is off by a few pixels.
    await Promise.all(host.shadowRoot.querySelector(".panel").getAnimations().map((animation) => animation.finished));
    const rect = (element) => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width }; };
    return { side: host.dataset.position, viewport: window.innerWidth, launcher: rect(host.shadowRoot.querySelector(".launcher")), panel: rect(host.shadowRoot.querySelector(".panel")) };
  });
}

for (const [launcherPosition, viewport] of [["bottom-left", { width: 1280, height: 800 }], ["bottom-right", { width: 1280, height: 800 }], ["bottom-left", { width: 480, height: 800 }]]) {
  test(`${launcherPosition} @ ${viewport.width}px：面板整个在视口里，并贴着入口那一边`, async () => {
    const server = site(launcherPosition);
    let browser;
    try {
      const origin = await listen(server);
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport });
      await page.goto(origin, { waitUntil: "load" });
      const { side, launcher, panel } = await layout(page);
      assert.equal(side, launcherPosition);
      assert.ok(panel.left >= 0, `面板左边缘出屏：${panel.left}`);
      assert.ok(panel.right <= viewport.width, `面板右边缘出屏：${panel.right}`);
      if (viewport.width > 520) {
        // Desktop: the panel aligns with the launcher on the same side.
        if (launcherPosition === "bottom-left") assert.ok(Math.abs(panel.left - launcher.left) < 1, `面板应与入口左对齐：${panel.left} vs ${launcher.left}`);
        else assert.ok(Math.abs(panel.right - launcher.right) < 1, `面板应与入口右对齐：${panel.right} vs ${launcher.right}`);
      } else {
        // Phone: the panel fills the viewport and the launcher sits on the configured side.
        assert.equal(panel.width, viewport.width);
        if (launcherPosition === "bottom-left") assert.ok(launcher.left < viewport.width / 2, `手机版入口应在左侧：${launcher.left}`);
      }
    } finally {
      await browser?.close();
      await close(server);
    }
  });
}
