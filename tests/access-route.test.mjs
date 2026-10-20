import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/**
 * `/api/access` decides what the browser is *given*, not only what it is told.
 *
 * The first password is set from a console that is still open, by whoever is in
 * front of it. Rotating the session secret there invalidates exactly one
 * cookie — that person's — so clearing it costs them a login in the middle of
 * onboarding and protects nobody. A later change is the opposite: every device
 * signs out, including this one.
 *
 * The route is bundled against a fake policy module so these two paths can be
 * driven directly; what the policy itself decides is covered in
 * tests/access-control.test.mjs against a real database.
 */
async function loadRoute(policy) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../app/api/access/route.ts", import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
    absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
    alias: { "@": fileURLToPath(new URL("..", import.meta.url)) },
    plugins: [{
      name: "access-route-fixtures",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]lib[\\/]access-control[\\/]index\.ts$/ }, () => ({
          loader: "ts",
          contents: `
            export const ACCESS_COOKIE_NAME = "sitewake_access";
            export const SESSION_TTL_MS = 86_400_000;
            export async function createSessionCookieValue(secret, nowMs) {
              return { value: \`\${nowMs + 86_400_000}.signed-with-\${secret}\`, expiresAt: nowMs + 86_400_000 };
            }
            export async function getAccessStatus() { return { configured: true, enabled: true, updatedAt: null }; }
            export async function verifyAccessPassword() { return { ok: false }; }
            export async function applyManagement(action, input) { return globalThis.__ACCESS_ROUTE_POLICY__(action, input); }
            export async function accessOnboardingSkipped() { return globalThis.__ACCESS_ROUTE_SKIPPED__ === true; }
            export async function skipAccessOnboarding() { globalThis.__ACCESS_ROUTE_SKIPPED__ = true; return { skipped: true }; }
            // app/api/site-agents/http.ts imports this from the same barrel.
            export async function authorizeManagementSession() { return true; }
            export async function resolveAccessGate() { return { locked: false, configured: true, enabled: true }; }
          `,
        }));
        // The real one returns a NextResponse, and bundling next/server into a
        // data: URL dies on `__dirname`. This stand-in keeps the one thing the
        // route uses — `response.cookies.set` — and writes it where a browser
        // would read it, so the assertions below are about real Set-Cookie
        // lines rather than a recorded call.
        builder.onLoad({ filter: /[\\/]app[\\/]api[\\/]site-agents[\\/]http\.ts$/ }, () => ({
          loader: "ts",
          contents: `
            export function siteAgentJson(body, status = 200, headers = {}) {
              const response = new Response(JSON.stringify(body), {
                status,
                headers: { "content-type": "application/json", ...headers },
              });
              response.cookies = {
                set(name, value, options = {}) {
                  const parts = [name + "=" + value, "Path=" + (options.path || "/")];
                  if (options.httpOnly) parts.push("HttpOnly");
                  if (options.secure) parts.push("Secure");
                  if (options.sameSite) parts.push("SameSite=" + options.sameSite);
                  if (options.maxAge !== undefined) parts.push("Max-Age=" + options.maxAge);
                  response.headers.append("set-cookie", parts.join("; "));
                },
              };
              return response;
            }
            export function siteAgentOptions() { return new Response(null, { status: 204 }); }
          `,
        }));
      },
    }],
  });
  globalThis.__ACCESS_ROUTE_POLICY__ = policy;
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const put = (route, body) => route.PUT(new Request("https://console.test/api/access", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
}));

/** The Set-Cookie the response carries for the access cookie, if any. */
function accessCookie(response) {
  return response.headers.getSetCookie().find((line) => line.startsWith("sitewake_access="));
}

test("a first password signs the caller in instead of signing them out", async () => {
  const route = await loadRoute(async () => ({
    ok: true,
    status: { configured: true, enabled: true, updatedAt: null },
    session: { firstTime: true, sessionSecret: "aa".repeat(32) },
  }));
  const response = await put(route, { action: "setPassword", password: "first-password" });
  assert.equal(response.status, 200);
  const cookie = accessCookie(response);
  assert.ok(cookie, "the response must carry the access cookie");
  assert.match(cookie, /signed-with-aa/, "the cookie is signed with the new secret");
  assert.doesNotMatch(cookie, /Max-Age=0/, "it is a real session, not a cleared one");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/, "an https request gets a secure cookie");
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(JSON.stringify(body).includes("aa".repeat(32)), false, "the secret never reaches the body");
});

test("changing the password clears the caller's cookie", async () => {
  const route = await loadRoute(async () => ({
    ok: true,
    status: { configured: true, enabled: true, updatedAt: null },
    session: { firstTime: false, sessionSecret: "bb".repeat(32) },
  }));
  const response = await put(route, { action: "setPassword", password: "second", currentPassword: "first-password" });
  assert.equal(response.status, 200);
  const cookie = accessCookie(response);
  assert.ok(cookie, "the cookie is still set, as a cleared one");
  assert.match(cookie, /Max-Age=0/, "every device signs out, including this one");
  assert.doesNotMatch(cookie, /signed-with-bb/, "and it carries no usable session");
});

test("revoking sessions clears the cookie, and a refused call sets none", async () => {
  const revoke = await loadRoute(async () => ({ ok: true, status: { configured: true, enabled: true, updatedAt: null } }));
  const revoked = await put(revoke, { action: "revokeSessions", currentPassword: "pw" });
  assert.match(accessCookie(revoked) ?? "", /Max-Age=0/);

  const refused = await loadRoute(async () => ({ ok: false, error: "password_too_short", code: 400 }));
  const response = await put(refused, { action: "setPassword", password: "abc" });
  assert.equal(response.status, 400);
  assert.equal(accessCookie(response), undefined, "a refused call touches no cookie");
  assert.equal((await response.json()).error, "password_too_short");
});

test("an unknown action is refused before the policy is consulted", async () => {
  let consulted = false;
  const route = await loadRoute(async () => { consulted = true; return { ok: true, status: {} }; });
  const response = await put(route, { action: "promote-me" });
  assert.equal(response.status, 400);
  assert.equal(consulted, false);
});

test("the console can record a skip without a session, and the status carries it", async () => {
  // Nothing to authenticate against: an installation with no password is open,
  // which is the whole reason the step is being offered. The flag rides along
  // with the status so the rail decides from one answer rather than two.
  delete globalThis.__ACCESS_ROUTE_SKIPPED__;
  const route = await loadRoute(async () => ({ ok: true, status: {} }));

  const before = await (await route.GET()).json();
  assert.equal(before.onboardingSkipped, false);
  assert.equal(before.configured, true, "the status fields are still there");

  const skipped = await route.POST(new Request("https://console.test/api/access", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "skipOnboarding" }),
  }));
  assert.equal(skipped.status, 200);
  assert.equal((await skipped.json()).onboardingSkipped, true);
  assert.equal(accessCookie(skipped), undefined, "recording a skip grants nothing");

  const after = await (await route.GET()).json();
  assert.equal(after.onboardingSkipped, true);
  delete globalThis.__ACCESS_ROUTE_SKIPPED__;
});

test("the status endpoint still refuses to hand out anything secret", async () => {
  const route = await loadRoute(async () => ({ ok: true, status: {} }));
  const body = await (await route.GET()).json();
  assert.deepEqual(Object.keys(body).sort(), ["configured", "demoLock", "enabled", "onboardingSkipped", "updatedAt"]);
});
