import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

// The built artifacts are what an integrating site actually loads, so the
// contract is checked against them in a real browser rather than the sources.
const sdk = await readFile(new URL("../public/sitewake.js", import.meta.url), "utf8");
const adaptive = await readFile(new URL("../public/sitewake-adaptive.js", import.meta.url), "utf8");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });

function startSite() {
  return createServer((request, response) => {
    const path = new URL(request.url, "http://x").pathname;
    if (path === "/sitewake.js") { response.writeHead(200, { "content-type": "application/javascript" }); response.end(sdk); return; }
    if (path === "/sitewake-adaptive.js") { response.writeHead(200, { "content-type": "application/javascript" }); response.end(adaptive); return; }
    if (path.endsWith(".js")) { response.writeHead(404); response.end(); return; }
    if (path.startsWith("/api/")) { response.writeHead(503, { "content-type": "application/json" }); response.end("{}"); return; }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>Entry test</title><h1>site</h1>
      <script src="/sitewake.js" data-site-agent="entry-test" data-endpoint="${request.headers.host ? `http://${request.headers.host}` : ""}" defer></script>`);
  });
}

test("the SDK defines globals only inside the SiteWake namespace and reads only SITEWAKE_CONFIG", async () => {
  const site = startSite();
  let browser;
  try {
    const origin = await listen(site);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.addInitScript(() => { window.__baseline = new Set(Object.getOwnPropertyNames(window)); });
    await page.goto(origin, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean(window.SiteWake));
    const added = await page.evaluate(() => Object.getOwnPropertyNames(window).filter((name) => !window.__baseline.has(name) && name !== "__baseline"));
    assert.ok(added.includes("SiteWake"));
    // Every global the SDK adds is SiteWake-named: no alias under any earlier product name.
    assert.deepEqual(added.filter((name) => !/^(?:__)?SITEWAKE/i.test(name)), [], `unexpected globals: ${added}`);
    // The built artifact knows exactly one page-level config object.
    const configObjects = [...sdk.matchAll(/window\.([A-Z][A-Z0-9]*_CONFIG)\b/g)].map(([, name]) => name);
    assert.ok(configObjects.length > 0);
    assert.deepEqual([...new Set(configObjects)], ["SITEWAKE_CONFIG"]);
  } finally {
    await browser?.close();
    await close(site);
  }
});

test("every storage key the SDK writes is under sitewake:v5:", async () => {
  const site = startSite();
  let browser;
  try {
    const origin = await listen(site);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate(() => window.SiteWake.open());
    await page.waitForTimeout(500);
    const keys = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]);
    assert.ok(keys.length > 0, "the SDK persists at least its browser session id");
    assert.deepEqual(keys.filter((key) => !key.startsWith("sitewake:v5:")), [], `keys outside the namespace: ${keys}`);
    // The built artifact carries no other `<name>:v<N>:` namespace either.
    const namespaces = new Set([...sdk.matchAll(/["`']([a-z]+:v\d+):/g)].map(([, ns]) => ns));
    assert.deepEqual([...namespaces], ["sitewake:v5"]);
  } finally {
    await browser?.close();
    await close(site);
  }
});

test("handoff hash parameters are consumed under sitewake-* only; any other prefix is left untouched", async () => {
  const site = startSite();
  let browser;
  try {
    const origin = await listen(site);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`${origin}/#sitewake-goal=hello&keep=1`, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean(window.SiteWake));
    assert.equal(await page.evaluate(() => location.hash), "#keep=1", "sitewake-goal is consumed, other params restored");
    await page.goto(`${origin}/#otherbrand-goal=hello&keep=1`, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean(window.SiteWake));
    assert.equal(await page.evaluate(() => location.hash), "#otherbrand-goal=hello&keep=1", "a foreign prefix is not a handoff signal");
    // The built artifact spells every handoff parameter under the one prefix.
    const params = new Set([...sdk.matchAll(/"([a-z]+-(?:run|return-hash|launch|mode))"/g)].map(([, name]) => name));
    assert.ok(params.size >= 4, `handoff parameters found: ${[...params]}`);
    assert.deepEqual([...params].filter((name) => !name.startsWith("sitewake-")), []);
  } finally {
    await browser?.close();
    await close(site);
  }
});

test("the SDK marks its DOM under data-sitewake-* only", async () => {
  const site = startSite();
  let browser;
  try {
    const origin = await listen(site);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: "load" });
    await page.waitForFunction(() => document.querySelector("[data-sitewake-agent]"));
    const attributes = await page.evaluate(() => {
      const names = new Set();
      for (const element of document.querySelectorAll("*")) for (const attribute of element.attributes) if (attribute.name.startsWith("data-")) names.add(attribute.name);
      return [...names].sort();
    });
    assert.ok(attributes.includes("data-sitewake-agent"));
    // Product marks are the `data-<product>-agent|ready|page-operating` family; any
    // such mark must carry the current prefix. (`data-site-agent` is the
    // integrator's declaration; `data-preset` / `data-surface` are styling.)
    const marks = attributes.filter((name) => name !== "data-site-agent" && /^data-[a-z]+-(?:agent|ready|page-operating)$/.test(name));
    assert.ok(marks.length > 0);
    assert.deepEqual(marks.filter((name) => !name.startsWith("data-sitewake-")), [], `marks outside the prefix: ${marks}`);
  } finally {
    await browser?.close();
    await close(site);
  }
});
