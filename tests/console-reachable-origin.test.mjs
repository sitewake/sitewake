import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// A self-hosted console is opened at whatever address its owner can reach:
// localhost, a LAN IP, a tunnel host, or a public name behind a TLS proxy.
// Management mutations must work at every one of them and must still refuse a
// cross-site request. The production deployment configures SITEWAKE_PUBLIC_ORIGIN;
// a fresh install has not configured anything yet.
async function managementHttp() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../app/api/site-agents/http.ts", import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{
      name: "console-origin-stubs",
      setup(builder) {
        builder.onResolve({ filter: /^next\/server$/ }, () => ({ path: "next/server", namespace: "stub" }));
        builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: "export class NextResponse { static json(){ return { cookies: { set(){} } }; } }",
        }));
        // Access control is disabled on a fresh install: the session check passes
        // and the Origin rule is the only thing deciding these cases.
        builder.onResolve({ filter: /access-control\/policy$/ }, () => ({ path: "policy", namespace: "policy" }));
        builder.onLoad({ filter: /.*/, namespace: "policy" }, () => ({
          contents: `
            export const ACCESS_COOKIE_NAME = "sr_access";
            export async function authorizeManagementSession() { return true; }
            export async function verifyAccessPassword() { return { ok: false }; }
            export function signSessionCookieValue() { return ""; }
            export async function loadAccessPolicyStatus() { return { enabled: false, configured: false }; }
          `,
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

function withEnvironment(values, run) {
  const keys = ["NODE_ENV", "SITEWAKE_LOCAL_DEV", "SITEWAKE_PUBLIC_ORIGIN", "SITEWAKE_PUBLIC_HOSTNAME", "CLOUDFLARE_ROUTE_HOSTNAME"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, values);
    return run();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

const post = (url, headers) => new Request(url, { method: "POST", headers: { cookie: "sr_access=session", ...headers } });

test("a console opened at its own address may create a site — localhost, LAN IP, or a tunnel behind TLS", async () => {
  const http = await managementHttp();
  // `./setup` prints a LAN/bridge address and writes it as the public origin;
  // the owner may still reach the console by another route.
  const cases = [
    ["http://localhost:3000", "http://localhost:3000/api/site-agents", {}],
    ["http://172.17.0.29:3000", "http://172.17.0.29:3000/api/site-agents", {}],
    ["http://192.168.1.10:3000", "http://192.168.1.10:3000/api/site-agents", {}],
    // A TLS-terminating proxy or cloud tunnel: the browser speaks https, the
    // app is reached over http and learns the public scheme from the proxy.
    ["https://workspace-3000.example.run", "http://workspace-3000.example.run/api/site-agents", { "x-forwarded-proto": "https" }],
    ["https://console.example.com", "http://control-plane:3000/api/site-agents", { "x-forwarded-proto": "https", "x-forwarded-host": "console.example.com" }],
  ];
  for (const [origin, url, headers] of cases) {
    const authorized = await withEnvironment({ NODE_ENV: "production" }, () => http.managementMutationAuthorized(post(url, { origin, ...headers })));
    assert.equal(await authorized, true, `${origin} must be able to manage the console it is served from`);
  }
});

test("a configured public origin still authorizes a proxy that rewrites the Host", async () => {
  const http = await managementHttp();
  const authorized = await withEnvironment(
    { NODE_ENV: "production", SITEWAKE_PUBLIC_ORIGIN: "https://console.example.com" },
    () => http.managementMutationAuthorized(post("http://127.0.0.1:3000/api/site-agents", { origin: "https://console.example.com" })),
  );
  assert.equal(await authorized, true);
});

test("a cross-site request is refused however it arrives", async () => {
  const http = await managementHttp();
  const refused = [
    // No Origin at all.
    ["http://192.168.1.10:3000/api/site-agents", {}],
    // Another site posting to this console.
    ["http://192.168.1.10:3000/api/site-agents", { origin: "https://evil.example.com" }],
    // A sibling hostname of the configured origin.
    ["https://console.example.com/api/site-agents", { origin: "https://evil.console.example.com" }],
    // The forwarded scheme does not turn a different host into this one.
    ["http://console.example.com/api/site-agents", { origin: "https://other.example.com", "x-forwarded-proto": "https" }],
    // http Origin against a proxy that says the public scheme is https.
    ["http://console.example.com/api/site-agents", { origin: "http://console.example.com", "x-forwarded-proto": "https" }],
  ];
  for (const [url, headers] of refused) {
    const authorized = await withEnvironment({ NODE_ENV: "production" }, () => http.managementMutationAuthorized(post(url, headers)));
    assert.equal(await authorized, false, `${JSON.stringify(headers)} must not manage the console`);
  }
});
