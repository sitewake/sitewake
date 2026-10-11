import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  normalizeSiteAddresses,
  originIsRegistered,
  registeredOriginMatches,
  sameSiteLanding,
} from "../lib/console/site-addresses.ts";

/**
 * A website is rarely one address. These are the rules that decide which pages
 * belong to it, plus the two endpoints that make the set visible and editable
 * instead of discoverable only as a 403.
 */

test("an address acts for the site only if it was registered, exactly", () => {
  // This used to admit `www` and every subdomain, while creating a task required
  // an exact match. A page at an unregistered subdomain therefore passed the
  // connection check and then had its task refused with
  // `agent_run_origin_rejected`. One of the two had to move, and it could not be
  // the authorization: an administrator names the addresses, and nothing
  // observed at runtime widens that.
  const origins = ["https://shop.example"];
  assert.equal(originIsRegistered(origins, "https://shop.example/cart"), true, "the path is not part of the answer");
  assert.equal(originIsRegistered(origins, "https://www.shop.example/"), false, "www is a different address and needs registering");
  assert.equal(originIsRegistered(origins, "https://m.shop.example/item"), false, "a subdomain needs registering");
  assert.equal(originIsRegistered(["https://shop.example", "https://www.shop.example"], "https://www.shop.example/"), true,
    "registering both is how a site served at two addresses is enrolled");
  // What a browser makes different was already different.
  assert.equal(originIsRegistered(origins, "https://shop.example:9443/"), false, "a port is another server");
  assert.equal(originIsRegistered(origins, "http://shop.example/"), false, "http is not the https site");
  assert.equal(originIsRegistered(origins, "https://other.example/"), false, "another domain is another website");
  assert.equal(originIsRegistered(origins, "https://shop.example.evil.test/"), false, "a lookalike suffix is not a subdomain");
  assert.equal(originIsRegistered(origins, "not a url"), false);
  assert.equal(registeredOriginMatches("https://Shop.Example", "https://shop.example"), true, "case does not matter in a host");
});

test("landing on the site's own subdomain is still landing on the site", () => {
  // The other question the one function used to answer. A task that walks from a
  // page to a subdomain of the same site has not left the site, and the landing
  // URL is rewritten accordingly. It grants nothing, so same-site is right here.
  assert.equal(sameSiteLanding("https://shop.example", "https://www.shop.example"), true, "www");
  assert.equal(sameSiteLanding("https://shop.example", "https://m.shop.example"), true, "a subdomain");
  assert.equal(sameSiteLanding("https://shop.example", "https://other.example"), false, "another domain");
  assert.equal(sameSiteLanding("https://shop.example", "https://shop.example.evil.test"), false, "a lookalike suffix");
  assert.equal(sameSiteLanding("https://shop.example", "http://shop.example"), false, "another scheme");
});

/** The addresses endpoint with a store that only remembers what it was told. */
async function loadAddressesRoute(initial) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../app/api/site-agents/[siteAgentId]/addresses/route.ts", import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
    absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
    alias: { "@": fileURLToPath(new URL("..", import.meta.url)) },
    plugins: [{
      name: "addresses-fixtures",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]db[\\/]site-agent-store\.ts$/ }, () => ({
          contents: `
            let allowedOrigins = ${JSON.stringify(initial)};
            export async function siteAgentExists(id) { return id === "shop"; }
            export async function siteAgentAccess() { return "allowed"; }
            export async function getActiveSiteAgentRelease() {
              return { release: { profile: { entryUrl: "https://shop.example/", allowedOrigins } } };
            }
            export async function createSiteAgent(input) { allowedOrigins = input.profile.allowedOrigins; return { siteAgentId: input.id }; }
          `,
          loader: "ts",
        }));
        builder.onLoad({ filter: /[\\/]app[\\/]api[\\/]site-agents[\\/]http\.ts$/ }, () => ({
          contents: `
            export async function managementAuthorized(request) { return request.headers.get("x-test-management") === "authorized"; }
            export async function managementMutationAuthorized(request) { return request.headers.get("x-test-management") === "authorized"; }
            export function siteAgentJson(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }); }
            export function siteAgentFailure(error, code, status = 500) { return siteAgentJson({ error: code, message: String(error) }, status); }
          `,
          loader: "ts",
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const context = { params: Promise.resolve({ siteAgentId: "shop" }) };
const managed = { "x-test-management": "authorized", "content-type": "application/json" };

test("the address set can be read and extended from the console", async () => {
  const route = await loadAddressesRoute(["https://shop.example"]);
  const before = await route.GET(new Request("http://console/api/site-agents/shop/addresses", { headers: managed }), context);
  assert.deepEqual(await before.json(), { addresses: ["https://shop.example"], entryUrl: "https://shop.example/" });

  // Adding the www variant is one call, and what comes back is what will be enforced.
  const after = await route.PUT(new Request("http://console/api/site-agents/shop/addresses", {
    method: "PUT", headers: managed,
    body: JSON.stringify({ addresses: ["https://shop.example", "https://www.shop.example/home"] }),
  }), { params: Promise.resolve({ siteAgentId: "shop" }) });
  assert.equal(after.status, 200);
  assert.deepEqual((await after.json()).addresses, ["https://shop.example", "https://www.shop.example"]);
});

test("an unusable address is refused, and a site is never left with none", async () => {
  const route = await loadAddressesRoute(["https://shop.example"]);
  const rejected = await route.PUT(new Request("http://console/api/site-agents/shop/addresses", {
    method: "PUT", headers: managed, body: JSON.stringify({ addresses: ["https://shop.example", "javascript:alert(1)"] }),
  }), context);
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, "site_address_rejected");

  const empty = await route.PUT(new Request("http://console/api/site-agents/shop/addresses", {
    method: "PUT", headers: managed, body: JSON.stringify({ addresses: [] }),
  }), { params: Promise.resolve({ siteAgentId: "shop" }) });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, "addresses_required");
});

test("reading or changing addresses needs management authorization", async () => {
  const route = await loadAddressesRoute(["https://shop.example"]);
  const read = await route.GET(new Request("http://console/api/site-agents/shop/addresses"), context);
  assert.equal(read.status, 401);
  const write = await route.PUT(new Request("http://console/api/site-agents/shop/addresses", { method: "PUT", body: "{}" }), { params: Promise.resolve({ siteAgentId: "shop" }) });
  assert.equal(write.status, 401);
});

/** The handshake, with the same store stub: what a page at an unregistered address is told. */
async function loadConnectionRoute(registered) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../app/api/site-agents/[siteAgentId]/connection/route.ts", import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
    absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
    plugins: [{
      name: "connection-fixtures",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]db[\\/]site-agent-store\.ts$/ }, () => ({
          contents: `
            export async function siteAgentExists() { return true; }
            export async function createSiteAgent() { return { siteAgentId: "shop" }; }
            export async function getActiveSiteAgentRelease() {
              return { release: { profile: { entryUrl: "https://shop.example/", allowedOrigins: ${JSON.stringify(registered)} } } };
            }
            const calls = (globalThis.__storeCalls ||= []);
            export async function recordSiteAgentConnection() { calls.push("connection"); return { release: { version: 1 }, persistence: "memory" }; }
            export async function enqueueSitePreviewJob() { calls.push("preview"); }
            export async function enqueueInitialCrawlJob() { calls.push("crawl"); }
          `,
          loader: "ts",
        }));
        builder.onLoad({ filter: /[\\/]app[\\/]api[\\/]site-agents[\\/]http\.ts$/ }, () => ({
          contents: `
            export async function managementAuthorized() { return false; }
            export function controlPlaneOriginForRequest() { return "https://console.acme.test"; }
            export function persistenceHeaders() { return {}; }
            export function siteAgentJson(payload, status = 200, headers = {}) { return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } }); }
            export function siteAgentOptions() { return new Response(null, { status: 204 }); }
            export function siteAgentFailure(error, code, status = 500) { return siteAgentJson({ error: code, message: String(error) }, status); }
          `,
          loader: "ts",
        }));
        builder.onLoad({ filter: /next[\\/]server/ }, () => ({ contents: "export class NextRequest {}\nexport const NextResponse = {};", loader: "ts" }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

/** What the route asked the store to do since the last check. */
function recorded() {
  const calls = globalThis.__storeCalls || [];
  const copy = [...calls];
  calls.length = 0;
  return copy;
}

function handshake(route, pageUrl) {
  const origin = new URL(pageUrl).origin;
  return route.POST(new Request("https://console.acme.test/api/site-agents/shop/connection", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ snapshot: { url: pageUrl, title: "商城", heading: "商城", sequence: 1 } }),
  }), { params: { siteAgentId: "shop" } });
}

test("a rehearsal gets the release and leaves nothing behind", async () => {
  // The console's rehearsal serves the reader's page with the snippet in it, so
  // the SDK boots and handshakes for real. The website has installed nothing,
  // so recording that handshake would tell the reader they are connected when
  // they are not — which is what the check exists to find out.
  const route = await loadConnectionRoute(["https://shop.example"]);
  const answer = await route.POST(new Request("https://console.acme.test/api/site-agents/shop/connection", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://shop.example" },
    body: JSON.stringify({ snapshot: { url: "https://shop.example/", title: "商城", heading: "商城", sequence: 1 }, rehearsal: true }),
  }), { params: { siteAgentId: "shop" } });

  assert.equal(answer.status, 200, "试装照常拿到 Release，SDK 才能真的跑起来");
  const body = await answer.json();
  assert.equal(body.rehearsal, true);
  assert.equal(body.connection, null, "不留接入记录");
  assert.ok(body.release, "但要给出 Release");
  assert.deepEqual(recorded(), [], "不写连接、不排预览、不排抓取");
});

test("the handshake accepts a registered address and names the reason when it refuses", async () => {
  const route = await loadConnectionRoute(["https://shop.example", "https://www.shop.example"]);

  // Each registered address is accepted.
  for (const page of ["https://shop.example/cart", "https://www.shop.example/"]) {
    const accepted = await handshake(route, page);
    assert.equal(accepted.status, 200, page);
  }

  // An unregistered subdomain is refused here rather than accepted and then
  // refused by `agent-run-store` at the first task. The refusal names the
  // address and lists the registered ones, which is what a developer needs in
  // order to add it.
  const subdomain = await handshake(route, "https://staging.shop.example/");
  assert.equal(subdomain.status, 403, "an unregistered subdomain cannot act for the site");
  assert.deepEqual(await subdomain.json(), {
    error: "site_agent_origin_rejected",
    reason: "origin_not_registered",
    origin: "https://staging.shop.example",
    registered: ["https://shop.example", "https://www.shop.example"],
  });

  // Another domain, same answer.
  const refused = await handshake(route, "https://other.example/");
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), {
    error: "site_agent_origin_rejected",
    reason: "origin_not_registered",
    origin: "https://other.example",
    registered: ["https://shop.example", "https://www.shop.example"],
  });
});

test("the SDK says in the page's own console which address was refused, and stays quiet otherwise", async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../client/user-agent-diagnostics.ts", import.meta.url))],
    bundle: true, platform: "browser", format: "esm", write: false, logLevel: "silent",
    absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  });
  const port = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  const originalLocation = globalThis.location;
  if (!originalLocation) globalThis.location = { origin: "https://staging.shop.example" };
  try {
    await port.reportUnregisteredOrigin(new Response(JSON.stringify({
      error: "site_agent_origin_rejected",
      reason: "origin_not_registered",
      origin: "https://staging.shop.example",
      registered: ["https://shop.example", "https://www.shop.example"],
    }), { status: 403, headers: { "content-type": "application/json" } }));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /staging\.shop\.example/);
    assert.match(errors[0], /shop\.example、https:\/\/www\.shop\.example|shop\.example, https:\/\/www\.shop\.example/);

    // Any other refusal is the host page's business, not ours: nothing printed.
    errors.length = 0;
    await port.reportUnregisteredOrigin(new Response(JSON.stringify({ error: "site_agent_not_found" }), { status: 404 }));
    await port.reportUnregisteredOrigin(new Response("not json", { status: 403 }));
    assert.deepEqual(errors, []);
  } finally {
    console.error = original;
    if (!originalLocation) delete globalThis.location;
  }
});

test("the rehearsal flag survives the port's own option handling", () => {
  // The port rebuilds its options from a fixed list of fields. A flag added to
  // the call site but not to that list is silently dropped, which is how the
  // first version of this fix reached the server doing nothing at all: the
  // attribute was on the tag, the SDK read it, and the handshake still carried
  // no flag.
  const source = readFileSync(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  const constructed = source.slice(source.indexOf("this.options = {"), source.indexOf("this.executionPin = this.executionPinFrom"));
  assert.match(constructed, /rehearsal: options\.rehearsal === true/, "构造选项时必须带上 rehearsal");
  assert.match(source, /body: JSON\.stringify\(\{ snapshot, visibility: this\.options\.visibility, rehearsal: this\.options\.rehearsal \}\)/);
});
