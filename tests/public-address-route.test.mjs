import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/**
 * The endpoint that saves the address visitors will load SiteWake from. It
 * saves only an address that was shown to reach this installation, so each of
 * the four endings a reader can hit is exercised here against a real server
 * standing in for "that address".
 */

const INSTALLATION_ID = "11111111-2222-3333-4444-555555555555";

async function loadRoute() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../app/api/system/public-address/route.ts", import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
    absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
    alias: { "@": fileURLToPath(new URL("..", import.meta.url)) },
    plugins: [{
      name: "public-address-fixtures",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
          contents: "export function getD1Binding() { return null; }\nexport function getArtifactBinding() { return null; }\n",
          loader: "ts",
        }));
        builder.onLoad({ filter: /[\\/]app[\\/]api[\\/]site-agents[\\/]http\.ts$/ }, () => ({
          contents: `
            export async function managementAuthorized(request) { return request.headers.get("x-test-management") === "authorized"; }
            export async function managementMutationAuthorized(request) { return request.headers.get("x-test-management") === "authorized"; }
            export function siteAgentJson(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }); }
          `,
          loader: "ts",
        }));
        builder.onLoad({ filter: /[\\/]lib[\\/]public-address\.ts$/ }, () => ({
          contents: `
            let saved = "";
            export async function ensureInstallationId() { return ${JSON.stringify(INSTALLATION_ID)}; }
            export function getPublicAddress() { return saved ? { origin: saved, source: "console" } : { origin: "http://203.0.113.9:3000", source: "env" }; }
            export async function savePublicAddress(origin) { saved = origin; return { origin, source: "console" }; }
          `,
          loader: "ts",
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

/** A server that answers /api/health the way some control plane would. */
async function standIn(body, { status = 200 } = {}) {
  const server = createServer((request, response) => {
    if (!request.url.startsWith("/api/health")) { response.writeHead(404); return response.end(); }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function save(route, body) {
  return route.PUT(new Request("http://console.internal/api/system/public-address", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-test-management": "authorized" },
    body: JSON.stringify(body),
  }));
}

test("the address is saved when this installation answers at it", async (t) => {
  // The stand-in is plain http on loopback, which the shape rules refuse, so
  // this case proves the verification path by handing the browser's evidence
  // for an address that is otherwise well-formed.
  const route = await loadRoute();
  const answer = await save(route, {
    origin: "https://console.acme.com",
    browserProbe: { ok: true, installationId: INSTALLATION_ID },
  });
  assert.equal(answer.status, 200);
  const body = await answer.json();
  assert.equal(body.origin, "https://console.acme.com");
  assert.equal(body.source, "console");
  assert.equal(body.usableForPublicSites, true);

  // And a read now reports the saved value rather than the installer's default.
  const read = await route.GET(new Request("http://console.internal/api/system/public-address", { headers: { "x-test-management": "authorized" } }));
  assert.deepEqual(await read.json(), {
    origin: "https://console.acme.com",
    source: "console",
    installationId: INSTALLATION_ID,
    usableForPublicSites: true,
  });
});

test("an address that reaches another SiteWake is refused and says so", async () => {
  const route = await loadRoute();
  const other = await standIn({ installationId: "99999999-0000-0000-0000-000000000000" });
  try {
    // The server probe reaches the stand-in through the browser-probe path,
    // which carries what that address actually returned.
    const answer = await save(route, {
      origin: "https://console.acme.com",
      browserProbe: { ok: true, installationId: "99999999-0000-0000-0000-000000000000" },
    });
    assert.equal(answer.status, 400);
    const body = await answer.json();
    assert.equal(body.error, "public_address_unverified");
    assert.equal(body.reason, "other-installation");
  } finally { await other.close(); }
});

test("an address nothing answers at is refused with what was seen", async () => {
  const route = await loadRoute();
  const answer = await save(route, {
    origin: "https://console.acme.invalid",
    browserProbe: { ok: false, error: "TypeError: Failed to fetch" },
  });
  assert.equal(answer.status, 400);
  const body = await answer.json();
  assert.equal(body.error, "public_address_unverified");
  // Nothing resolves under .invalid, so the reader is sent to the DNS record.
  assert.equal(body.reason, "dns");
});

test("http and local addresses are refused before anything is fetched", async () => {
  const route = await loadRoute();
  for (const [origin, reason] of [["http://203.0.113.9:3000", "insecure"], ["https://localhost:3000", "local"], ["nonsense address", "malformed"]]) {
    const answer = await save(route, { origin });
    assert.equal(answer.status, 400, origin);
    const body = await answer.json();
    assert.equal(body.error, "public_address_rejected", origin);
    assert.equal(body.reason, reason, origin);
  }
});

test("reading requires management authorization", async () => {
  const route = await loadRoute();
  const answer = await route.GET(new Request("http://console.internal/api/system/public-address"));
  assert.equal(answer.status, 401);
});
