import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { chromium } from "playwright";

// Use the production response-header declaration, without mocking a browser
// route: Playwright interception can bypass the preflight we need to test.
const source = await readFile(new URL("../app/api/capability-v2/http.ts", import.meta.url), "utf8");
const declaration = source.match(/export const CAPABILITY_V2_HEADERS = (\{[\s\S]*?\n\});/)?.[1];
assert.ok(declaration);
const cors = runInNewContext(`(${declaration})`);
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

test("real cross-origin fetch permits the SDK's x-sitewake-* headers", async () => {
  let obsolete = true, posts = 0, preflights = 0;
  const site = createServer((_, response) => response.end("<!doctype html><title>Protocol test</title>"));
  const api = createServer((request, response) => {
    const headers = { ...cors };
    if (obsolete) headers["access-control-allow-headers"] = headers["access-control-allow-headers"].split(",").filter(h => !h.startsWith("x-sitewake-")).join(",");
    if (request.method === "OPTIONS") { preflights++; response.writeHead(204, headers); response.end(); return; }
    posts++; response.writeHead(200, { ...headers, "content-type": "application/json" }); response.end(JSON.stringify({ items: [{ name: "按排名打开热搜" }] }));
  });
  let browser;
  try {
    const origin = await listen(site), endpoint = await listen(api);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(origin);
    const lookup = () => page.evaluate(async endpoint => {
      try {
        const response = await fetch(endpoint, { method: "POST", headers: {
          "content-type": "application/json", authorization: "Bearer fixture",
          "x-sitewake-site-id": "site", "x-sitewake-site-agent-id": "site",
        }, body: JSON.stringify({ goal: "点开第三个热搜" }) });
        return { status: response.status, data: await response.json() };
      } catch { return { error: "fetch_blocked" }; }
    }, endpoint);
    assert.deepEqual(await lookup(), { error: "fetch_blocked" }, "negative control reproduces production's missing CORS headers");
    assert.equal(posts, 0, "the browser never sent the capability search");
    obsolete = false;
    const result = await lookup();
    assert.equal(result.status, 200);
    assert.equal(result.data.items[0].name, "按排名打开热搜");
    assert.equal(posts, 1);
    assert.equal(preflights, 2);
  } finally {
    await browser?.close();
    await Promise.all([close(site), close(api)]);
  }
});

test("the preflight allow-list carries only x-sitewake-* product headers, so any other prefix is blocked", async () => {
  const allowed = cors["access-control-allow-headers"].split(",");
  // `x-capability-*` is the capability module's own contract, not a product prefix.
  const product = allowed.filter((name) => /^x-(?!capability-)[a-z]+-(site-id|site-agent-id|runner-token|lease-token|run-id|ai-stage|learning-job-id|artifact-|maintenance-token|crawl-token)/.test(name));
  assert.ok(product.length > 0);
  assert.deepEqual(product.filter((name) => !name.startsWith("x-sitewake-")), [], "a product header under another prefix is still allowed");

  // A real browser preflight for a same-shaped header under another prefix must fail.
  let posts = 0;
  const site = createServer((_, response) => response.end("<!doctype html><title>Prefix test</title>"));
  const api = createServer((request, response) => {
    if (request.method === "OPTIONS") { response.writeHead(204, cors); response.end(); return; }
    posts++; response.writeHead(200, { ...cors, "content-type": "application/json" }); response.end("{}");
  });
  let browser;
  try {
    const origin = await listen(site), endpoint = await listen(api);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(origin);
    const attempt = (header) => page.evaluate(async ([endpoint, header]) => {
      try {
        const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", [header]: "site" }, body: "{}" });
        return { status: response.status };
      } catch { return { error: "fetch_blocked" }; }
    }, [endpoint, header]);
    assert.deepEqual(await attempt("x-otherbrand-site-id"), { error: "fetch_blocked" });
    assert.equal(posts, 0);
    assert.deepEqual(await attempt("x-sitewake-site-id"), { status: 200 });
    assert.equal(posts, 1);
  } finally {
    await browser?.close();
    await Promise.all([close(site), close(api)]);
  }
});

test("a site header under any prefix other than x-sitewake- is the same as no site header", () => {
  // Same trick as the CORS declaration above: evaluate the production function
  // without importing the route module (which resolves next/server).
  const fn = source.match(/export function siteIdFromRequest\([\s\S]*?\n\}/)?.[0];
  assert.ok(fn);
  const siteIdFromRequest = runInNewContext(`${stripTypeScriptTypes(fn.replace("export function", "function"))}; siteIdFromRequest`, { URL });
  const at = (headers) => siteIdFromRequest(new Request("http://control.test/api/capability-v2/search", { headers }));
  assert.equal(at({ "x-sitewake-site-id": "s1" }), "s1");
  assert.equal(at({}), "");
  for (const prefix of ["otherbrand", "oldname", "x"]) assert.equal(at({ [`x-${prefix}-site-id`]: "s1" }), "", prefix);
});
