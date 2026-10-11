import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// This case guards the known issue recorded in design.md: the site preview blocked every
// non-site origin, while the SDK loads from the control plane and handshakes back to it,
// so `agentDetected` was always false under cross-origin hosting. Real browser, real
// guard, no network mocking.
async function load(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["playwright"],
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { playwrightRenderPage } = await load("../lib/site-knowledge/crawl-render.ts");
const { normalizeDetectedSiteAgentIds } = await load("../lib/site-knowledge/site-preview-detection.ts");

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) =>
  new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });

const SITE_AGENT_ID = "shop.example.test";

/** Equivalent of the runner's two probes: runtime trace + site ids in the HTML. */
async function observe(page) {
  const runtimeMounted = await page
    .locator("[data-sitewake-agent], sitewake-agent")
    .count()
    .then((count) => count > 0)
    .catch(() => false);
  const ids = await page.evaluate(() =>
    Array.from(document.querySelectorAll("script[data-site-agent]"))
      .map((element) => (element.getAttribute("data-site-agent") || "").trim()),
  ).catch(() => []);
  const observedSiteAgentIds = normalizeDetectedSiteAgentIds(ids);
  return { agentDetected: runtimeMounted || observedSiteAgentIds.length > 0, runtimeMounted, observedSiteAgentIds };
}

test("a control-plane hosted SDK is only observable when its origin is allowed through", async () => {
  let sdkRequests = 0;
  let handshakes = 0;
  let thirdPartyRequests = 0;

  // The real SDK reports back to the absolute control-plane URL from `data-endpoint`, not a page-relative path.
  let controlPlaneOriginForScript = "";
  const controlPlane = createServer((request, response) => {
    if (request.url.startsWith("/sitewake.js")) {
      sdkRequests++;
      response.writeHead(200, { "content-type": "application/javascript" });
      // Minimal equivalent of the real SDK: leave a runtime trace, then handshake with the control plane.
      response.end(
        `document.documentElement.setAttribute("data-sitewake-agent", "1");`
        + `fetch(${JSON.stringify(`${controlPlaneOriginForScript}/connection`)}, { method: "POST" })`
        + `.then(() => document.documentElement.setAttribute("data-handshake", "1")).catch(() => {});`,
      );
      return;
    }
    if (request.url.startsWith("/connection")) {
      // Production /connection carries CORS headers (siteAgentJson / siteAgentOptions);
      // do the same here, or the browser blocks the response and the render guard is not
      // what gets tested.
      const cors = {
        "access-control-allow-origin": request.headers.origin || "*",
        "access-control-allow-methods": "POST,OPTIONS",
        "access-control-allow-headers": "content-type",
      };
      if (request.method === "OPTIONS") { response.writeHead(204, cors); response.end(); return; }
      handshakes++;
      response.writeHead(200, { ...cors, "content-type": "application/json" });
      response.end("{}");
      return;
    }
    response.writeHead(404).end();
  });
  const thirdParty = createServer((_, response) => {
    thirdPartyRequests++;
    response.writeHead(200, { "content-type": "application/javascript" });
    response.end("void 0;");
  });

  let site;
  let browser;
  try {
    const controlPlaneOrigin = await listen(controlPlane);
    controlPlaneOriginForScript = controlPlaneOrigin;
    const thirdPartyOrigin = await listen(thirdParty);
    site = createServer((_, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html><head><title>Shop</title></head><body><h1>Shop</h1>`
        + `<script src="${controlPlaneOrigin}/sitewake.js" data-site-agent="${SITE_AGENT_ID}" data-endpoint="${controlPlaneOrigin}" defer></script>`
        + `<script src="${thirdPartyOrigin}/analytics.js" defer></script>`
        + `</body></html>`,
      );
    });
    const siteOrigin = await listen(site);
    browser = await chromium.launch({ headless: true });

    // Status quo (the crawl's parameters): the SDK request is blocked, no runtime trace, no handshake.
    const strictContext = await browser.newContext();
    const strictPage = await strictContext.newPage();
    const strictSnapshot = await playwrightRenderPage(strictPage, { timeoutMs: 15_000, allowedOrigin: siteOrigin })(siteOrigin);
    assert.ok(strictSnapshot, "the page itself still renders");
    await strictPage.waitForTimeout(300);
    const strict = await observe(strictPage);
    assert.equal(sdkRequests, 0, "the SDK script never reached the control plane");
    assert.equal(handshakes, 0, "so no handshake could happen");
    assert.equal(strict.runtimeMounted, false, "and nothing was mounted on the page");
    // But the install tag in the HTML is always there, which is why "installed" can be judged independently of "running".
    assert.deepEqual(strict.observedSiteAgentIds, [SITE_AGENT_ID]);
    assert.equal(strict.agentDetected, true, "the install tag alone already counts as detected");
    await strictContext.close();

    // With the control-plane origin allowed: the SDK really loads and really handshakes.
    const allowedContext = await browser.newContext();
    const allowedPage = await allowedContext.newPage();
    const allowedSnapshot = await playwrightRenderPage(allowedPage, {
      timeoutMs: 15_000,
      allowedOrigin: siteOrigin,
      additionalRequestOrigins: [controlPlaneOrigin],
    })(siteOrigin);
    assert.ok(allowedSnapshot);
    await allowedPage.waitForFunction(() => document.documentElement.hasAttribute("data-sitewake-agent"), null, { timeout: 5_000 });
    const allowed = await observe(allowedPage);
    assert.equal(sdkRequests, 1, "the SDK script loaded from the control plane");
    assert.equal(allowed.runtimeMounted, true, "and left its runtime mark on the page");
    assert.deepEqual(allowed.observedSiteAgentIds, [SITE_AGENT_ID]);
    assert.equal(allowed.agentDetected, true);
    await allowedPage.waitForFunction(() => document.documentElement.hasAttribute("data-handshake"), null, { timeout: 5_000 });
    assert.equal(handshakes, 1, "the handshake reached the control plane");

    // Allowance is per origin: third-party scripts are blocked under both configurations.
    assert.equal(thirdPartyRequests, 0, "an unrelated third-party origin stays blocked");
    await allowedContext.close();
  } finally {
    await browser?.close().catch(() => undefined);
    await Promise.all([close(controlPlane), close(thirdParty), site ? close(site) : undefined].filter(Boolean));
  }
});
