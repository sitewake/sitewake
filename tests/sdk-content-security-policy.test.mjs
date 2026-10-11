import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

/**
 * What SiteWake asks a website's policy to allow: one address, for everything.
 *
 * The widget used to inject its stylesheet, which a policy can only admit with
 * `'unsafe-inline'` — measured in tests/csp-request-inventory.test.mjs, shadow
 * root included. Asking every customer to weaken their policy for a chat
 * widget is not a thing SiteWake may do, so the stylesheet is served from the
 * control plane and this test holds the line: under a strict policy that names
 * the control plane and nothing else, the widget is fully styled.
 */

const [sdk, sdkCss] = await Promise.all([
  readFile(new URL("../public/sitewake.js", import.meta.url), "utf8"),
  readFile(new URL("../public/sitewake.css", import.meta.url), "utf8"),
]);

const release = {
  id: "release-1", siteAgentId: "policy-test", version: 1, createdAt: "2026-09-24T00:00:00.000Z", contentHash: "abc",
  profile: { name: "Shop", description: "", entryUrl: "https://shop.example/", allowedOrigins: [], vocabulary: {}, suggestedGoals: [] },
  capabilities: [], scenes: [], operations: [], targets: [],
};

/** The control plane: the script, the stylesheet and a quiet API. */
async function controlPlane() {
  const server = createServer((request, response) => {
    const path = (request.url || "").split("?")[0];
    const cors = { "access-control-allow-origin": "*" };
    if (path === "/sitewake.js") { response.writeHead(200, { "content-type": "application/javascript", ...cors }); return response.end(sdk); }
    if (path === "/sitewake.css") { response.writeHead(200, { "content-type": "text/css", ...cors }); return response.end(sdkCss); }
    if (path.endsWith("/release")) { response.writeHead(200, { "content-type": "application/json", ...cors }); return response.end(JSON.stringify({ release })); }
    response.writeHead(200, { "content-type": "application/json", ...cors });
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A website with a strict policy that admits exactly one other address. */
async function website(consoleOrigin) {
  const policy = [
    "default-src 'self'",
    `script-src 'self' ${consoleOrigin}`,
    `connect-src 'self' ${consoleOrigin}`,
    `style-src 'self' ${consoleOrigin}`,
    `img-src 'self' data: ${consoleOrigin}`,
  ].join("; ");
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": policy });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>shop</title></head><body>
      <script src="${consoleOrigin}/sitewake.js" data-site-agent="policy-test" data-endpoint="${consoleOrigin}" data-open="true" defer></script>
    </body></html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, policy, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("under a strict policy that names only the control plane, the widget loads and is fully styled", async (t) => {
  const plane = await controlPlane();
  const site = await website(plane.origin);
  t.after(async () => { await site.close(); await plane.close(); });

  // Both fixtures are on loopback; a page reaching another loopback port is
  // classified as a public page touching a local address in current Chrome,
  // which is not what this test is about. Real sites and consoles are both
  // public addresses.
  const browser = await chromium.launch({ headless: true, args: ["--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const violations = [];
    await page.exposeFunction("__violation", (value) => violations.push(value));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        void window.__violation({ blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective, disposition: event.disposition });
      });
    });
    await page.goto(`${site.origin}/`, { waitUntil: "load" });
    await page.waitForSelector('[data-sitewake-agent="widget"]', { timeout: 15_000 });

    // Nothing was refused: one origin covered script, styles and the API.
    assert.deepEqual(violations, []);

    // The stylesheet is linked from the control plane, not injected.
    const styleSources = await page.evaluate(() => {
      const host = document.querySelector('[data-sitewake-agent="widget"]');
      const root = host.shadowRoot;
      return {
        links: [...root.querySelectorAll("link[rel=stylesheet]")].map((link) => link.href),
        styleElements: root.querySelectorAll("style").length,
      };
    });
    assert.equal(styleSources.styleElements, 0, "挂件不再注入 <style>");
    assert.deepEqual(styleSources.links, [`${plane.origin}/sitewake.css`]);

    // And the styles actually applied: the launcher has its own size from the
    // sheet rather than the browser's default for a button.
    await page.waitForFunction(() => {
      const launcher = document.querySelector('[data-sitewake-agent="widget"]')?.shadowRoot?.querySelector(".launcher");
      return launcher ? getComputedStyle(launcher).borderRadius !== "0px" : false;
    }, null, { timeout: 10_000 });
    const launcher = await page.evaluate(() => {
      const element = document.querySelector('[data-sitewake-agent="widget"]').shadowRoot.querySelector(".launcher");
      const style = getComputedStyle(element);
      return { width: element.getBoundingClientRect().width, radius: style.borderRadius, position: style.position };
    });
    assert.ok(launcher.width >= 44, `入口尺寸来自样式表：${JSON.stringify(launcher)}`);
    assert.notEqual(launcher.radius, "0px");
  } finally {
    await browser.close().catch(() => undefined);
  }
});

test("the stylesheet the build ships is the one the widget asks for", async () => {
  // A file that exists and carries the widget's own rules: if the build ever
  // stops emitting it, the widget is unstyled on every site.
  assert.match(sdkCss, /\.launcher\{/);
  assert.match(sdkCss, /\.panel\{/);
  assert.match(sdkCss, /\.studio\{/, "teaching overlay styles ship in the same file");
  assert.ok(!sdkCss.includes("unsafe-inline"));
});
