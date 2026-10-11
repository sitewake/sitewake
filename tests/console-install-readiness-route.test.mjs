import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// The console cannot read another origin's headers from the browser, so this
// endpoint is where the site is loaded once and judged. The route is thin; what
// must hold is that it reports what the site really sends.
async function loadRoute(entryUrl, preview) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../app/api/site-agents/[siteAgentId]/install-readiness/route.ts", import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
    absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
    alias: { "@": fileURLToPath(new URL("..", import.meta.url)) },
    plugins: [{
      name: "install-readiness-fixtures",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]lib[\\/]public-address\.ts$/ }, () => ({
          contents: 'export function getPublicAddress() { return { origin: "https://console.example.com", source: "console" }; }\n',
          loader: "ts",
        }));
        builder.onLoad({ filter: /[\\/]db[\\/]site-agent-store\.ts$/ }, () => ({
          contents: `
            const PREVIEW = ${JSON.stringify(preview ?? null)} || undefined;
            export async function siteAgentAccess() { return "allowed"; }
            export async function getSiteAgentOverview() {
              return { overview: { activeRelease: { profile: { entryUrl: ${JSON.stringify(entryUrl)} } } }, persistence: "memory" };
            }
            // What a browser reported, when a rehearsal or a live render has run.
            export async function getSitePreview() { return { preview: PREVIEW, persistence: "memory" }; }
          `,
          loader: "ts",
        }));
        builder.onLoad({ filter: /[\\/]app[\\/]api[\\/]site-agents[\\/]http\.ts$/ }, () => ({
          contents: `
            export async function managementAuthorized(request) { return request.headers.get("x-test-management") === "authorized"; }
            export function controlPlaneOriginForRequest() { return "https://console.example.com"; }
            export function siteAgentJson(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }); }
            export function siteAgentOptions() { return new Response(null, { status: 204 }); }
            export function siteAgentFailure(error, code, status = 500) { return siteAgentJson({ error: code, message: String(error) }, status); }
          `,
          loader: "ts",
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

async function site(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

const ask = (route, siteAgentId, url, authorized = true) => route.GET(
  new Request(`https://console.example.com/api/site-agents/${siteAgentId}/install-readiness${url ? `?url=${encodeURIComponent(url)}` : ""}`, {
    headers: authorized ? { "x-test-management": "authorized" } : {},
  }),
  { params: { siteAgentId } },
);

test("the site is loaded once and every finding a reader needs comes back", async () => {
  const fixture = await site((request, response) => {
    if (request.url === "/moved") {
      response.writeHead(302, { location: "/final" });
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'self'; img-src * data:",
    });
    response.end(`<!doctype html><meta http-equiv="content-security-policy" content="connect-src 'self'"><title>shop</title>`);
  });
  try {
    const route = await loadRoute(`${fixture.origin}/`);
    const answer = await ask(route, "shop", `${fixture.origin}/moved`);
    assert.equal(answer.status, 200);
    const { readiness, sdkOrigin, policy } = await answer.json();
    // The snippet's address is the configured one, not wherever this request
    // happened to arrive.
    assert.equal(sdkOrigin, "https://console.example.com");
    // The header forbids script-src (via default-src) and the meta forbids
    // connect-src; img-src is open, so it is not reported.
    assert.deepEqual(readiness.csp, { source: "header-and-meta", missing: ["script-src", "connect-src"] });
    assert.equal(readiness.finalUrl, `${fixture.origin}/final`);
    // Same origin after the redirect: nothing to say about the registration.
    assert.equal(readiness.originMismatch, undefined);
    // No browser has opened this page, so the policy answer is labelled as
    // read rather than measured — and it still carries the patch to paste.
    assert.equal(policy.source, "inferred");
    assert.equal(policy.blocked, true);
    // The patch names the directive a browser actually consults, and never
    // widens default-src.
    assert.match(policy.patches[0].after, /script-src-elem 'self' https:\/\/console\.example\.com/);
    assert.match(policy.patches[0].after, /connect-src 'self' https:\/\/console\.example\.com/);
    assert.match(policy.patches[0].after, /^default-src 'self'; img-src \* data:;/);
  } finally { await fixture.close(); }
});

test("a site that does not answer is reported as unreachable, not as a missing policy", async () => {
  const route = await loadRoute("http://127.0.0.1:1/");
  const { readiness } = await (await ask(route, "shop", "http://127.0.0.1:1/")).json();
  assert.equal(readiness.unreachable?.reason, "network");
  assert.equal(readiness.csp, undefined);
});

test("the check is management-only and needs an address", async () => {
  const route = await loadRoute("");
  assert.equal((await ask(route, "shop", "https://example.com/", false)).status, 401);
  assert.equal((await ask(route, "shop", "")).status, 400);
});

test("what a browser reported outranks reading the policy text", async () => {
  // A rehearsal has run: its violations are the answer, and the patch comes
  // from the policy the browser attached to them.
  const fixture = await site((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'", "x-vercel-id": "hkg1::abc" });
    response.end("<!doctype html><title>shop</title>");
  });
  try {
    const route = await loadRoute(`${fixture.origin}/`, {
      artifactId: "a", url: "u", pageUrl: `${fixture.origin}/`, capturedAt: "2026-09-24T00:00:00.000Z", width: 1440, height: 900,
      agentDetected: true, mode: "try-install", installConnected: false,
      violations: [{
        blockedUrl: "https://console.example.com/sitewake.js",
        effectiveDirective: "script-src-elem",
        violatedDirective: "script-src-elem",
        disposition: "enforce",
        policy: "default-src 'self'",
      }],
    });
    const { policy, platform } = await (await ask(route, "shop", `${fixture.origin}/`)).json();
    assert.equal(policy.source, "measured");
    assert.equal(policy.blocked, true);
    assert.deepEqual(policy.findings.filter((finding) => finding.blocked).map((finding) => finding.kind), ["script"]);
    assert.match(policy.patches[0].after, /script-src-elem 'self' https:\/\/console\.example\.com/);
    // Where to change it is named only because the response proved it.
    assert.equal(platform, "vercel");
  } finally { await fixture.close(); }
});

test("a rehearsal that could not place the snippet is not read as a measurement", async () => {
  const fixture = await site((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'" });
    response.end("<!doctype html><title>shop</title>");
  });
  try {
    const route = await loadRoute(`${fixture.origin}/`, {
      artifactId: "a", url: "u", pageUrl: `${fixture.origin}/`, capturedAt: "2026-09-24T00:00:00.000Z", width: 1440, height: 900,
      agentDetected: false, mode: "try-install", rehearsalUnavailable: "not-injectable", violations: [],
    });
    const { policy } = await (await ask(route, "shop", `${fixture.origin}/`)).json();
    assert.equal(policy.source, "inferred", "试装没成，就不能当成实测");
    assert.equal(policy.blocked, true);
  } finally { await fixture.close(); }
});

test("a site that cannot be read at all is undetermined, not declared clean", async () => {
  const route = await loadRoute("http://127.0.0.1:1/");
  const { policy, readiness } = await (await ask(route, "shop", "http://127.0.0.1:1/")).json();
  assert.equal(readiness.unreachable?.reason, "network");
  assert.deepEqual(policy, { source: "unknown" });
});
