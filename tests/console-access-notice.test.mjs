import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

/**
 * The console says, for as long as it is true, that it has no password.
 *
 * It follows one fact and one only: whether a password is configured. Skipping
 * the onboarding step stops that step from interrupting anybody — it does not
 * make the console protected, so it must not silence this. The two facts are
 * kept separate precisely so the console cannot go quiet about a door that is
 * still open, and that is what these check.
 */
async function bundleNotice() {
  const result = await build({
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client";
        import { AccessNotice } from ${JSON.stringify(fileURLToPath(new URL("../components/console/access-notice.tsx", import.meta.url)))};
        createRoot(document.getElementById("root")).render(<AccessNotice />);
      `,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      loader: "tsx",
    },
    bundle: true, format: "iife", jsx: "automatic", write: false, logLevel: "silent",
    banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "production" } };' },
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty" },
  });
  return result.outputFiles[0].text;
}

const [script, css] = await Promise.all([
  bundleNotice(),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
]);

/** Serves the notice against a controllable /api/access. */
async function withNotice(access, body) {
  const calls = [];
  const state = { access: { ...access } };
  const server = createServer((request, response) => {
    const url = request.url || "/";
    const json = (payload, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (url === "/app.js") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(script); return; }
    if (url === "/globals.css") { response.writeHead(200, { "content-type": "text/css" }); response.end(css); return; }
    if (url === "/api/access" && request.method === "GET") {
      if (state.access === null) return json({ error: "unavailable" }, 500);
      return json({ enabled: false, updatedAt: null, onboardingSkipped: false, ...state.access });
    }
    if (url === "/api/access" && request.method === "PUT") {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        const parsed = (() => { try { return JSON.parse(raw || "{}"); } catch { return {}; } })();
        calls.push({ kind: "setPassword", length: String(parsed.password || "").length });
        if (String(parsed.password || "").length < 6) return json({ ok: false, error: "password_too_short" }, 400);
        state.access = { ...state.access, configured: true, enabled: true };
        json({ ok: true, status: { configured: true, enabled: true, updatedAt: null } });
      });
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/globals.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ locale: "zh-CN" });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await body(page, { calls, state });
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const NOTICE = '[data-access-notice="unprotected"]';

test("the notice appears exactly while the console has no password", async () => {
  await withNotice({ configured: false }, async (page) => {
    await page.waitForSelector(NOTICE, { timeout: 15_000 });
    const text = await page.locator(NOTICE).innerText();
    assert.match(text, /没有设置密码/);
    assert.match(text, /都可以打开/, "it says what that means, not just that a setting is missing");
    assert.equal(await page.locator(`${NOTICE} button`).count(), 1, "and offers the one action that fixes it");
    // Nothing to dismiss: an open console is not a preference to remember.
    assert.equal(await page.locator(`${NOTICE} [data-dismiss], ${NOTICE} [aria-label*="关闭"]`).count(), 0);
  });

  await withNotice({ configured: true }, async (page) => {
    await page.waitForFunction(() => document.getElementById("root")?.textContent !== null, null, { timeout: 15_000 });
    await page.waitForTimeout(300);
    assert.equal(await page.locator(NOTICE).count(), 0, "a protected console says nothing");
  });
});

test("skipping the onboarding step does not silence the notice", async () => {
  // This is the whole point of keeping the two facts apart: the step stops
  // interrupting, the console keeps telling the truth.
  await withNotice({ configured: false, onboardingSkipped: true }, async (page) => {
    await page.waitForSelector(NOTICE, { timeout: 15_000 });
    assert.match(await page.locator(NOTICE).innerText(), /没有设置密码/);
  });
});

test("a demo console is open on purpose and shows no notice", async () => {
  await withNotice({ configured: false, demoLock: true }, async (page) => {
    await page.waitForFunction(() => document.getElementById("root")?.textContent !== null, null, { timeout: 15_000 });
    await page.waitForTimeout(300);
    assert.equal(await page.locator(NOTICE).count(), 0, "visitors to a demo cannot set its password");
  });
});

test("a read that failed does not accuse a console of being open", async () => {
  await withNotice(null, async (page) => {
    await page.waitForFunction(() => document.getElementById("root")?.textContent !== null, null, { timeout: 15_000 });
    await page.waitForTimeout(300);
    assert.equal(await page.locator(NOTICE).count(), 0, "not knowing is not the same as knowing it is open");
  });
});

test("setting the password from the notice makes it go away, and keeps this browser in", async () => {
  await withNotice({ configured: false }, async (page, { calls }) => {
    await page.waitForSelector(NOTICE, { timeout: 15_000 });
    await page.locator(`${NOTICE} button`).click();
    const field = page.locator(`${NOTICE} input[type="password"]`);
    await field.waitFor({ timeout: 5_000 });

    await field.fill("abc");
    await page.locator(`${NOTICE} .sw-primary-button`).click();
    await page.waitForSelector(`${NOTICE} .sw-access-notice-error`, { timeout: 5_000 });
    assert.match(await page.locator(`${NOTICE} .sw-access-notice-error`).innerText(), /至少/);
    assert.equal(calls.filter((call) => call.kind === "setPassword").length, 0, "no round trip for a length the browser can check");

    await field.fill("a-real-password");
    await page.locator(`${NOTICE} .sw-primary-button`).click();
    await page.waitForFunction((selector) => document.querySelector(selector) === null, NOTICE, { timeout: 10_000 });
    assert.equal(calls.filter((call) => call.kind === "setPassword").length, 1);
    // The reply carries the session, so the page stays where it is rather than
    // bouncing to a login screen.
    assert.equal(await page.locator(".sw-access-gate, [data-access-gate]").count(), 0);
  });
});

test("the standing banners are one family, not two boxes that happen to stack", async () => {
  // They appear together on a console that has neither a password nor a public
  // address, directly above one another. Two sets of paddings and radii read as
  // a mistake, so both come from one rule — and this is what notices the day
  // somebody gives one of them its own.
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const shared = css.match(/\.sw-public-address-banner,\s*\n\.sw-access-notice \{([^}]*)\}/);
  assert.ok(shared, "the access notice must share the public-address banner's rule");
  for (const property of ["border-radius: 10px", "padding: 12px 16px", "margin: 0 0 16px"]) {
    assert.ok(shared[1].includes(property), `the shared rule must carry ${property}`);
  }
  // Count the rules that give the notice a box. The shared one above is the
  // only legitimate match; a second would be somebody quietly re-styling it.
  // (The selector list puts `.sw-access-notice {` at the start of its own line,
  // which is why this counts rather than forbids.)
  const boxRules = [...css.matchAll(/^\.sw-access-notice \{/gm)];
  assert.equal(boxRules.length, 1, "exactly one rule may give the notice its box, and it is the shared one");
  assert.doesNotMatch(shared[1], /margin: 0 \d+px/, "no bespoke horizontal offset: it lines up with the content");

  // It also has to live where the other banner lives: inside the content, not
  // floating between the topbar and it.
  const shell = await readFile(new URL("../components/site-agent-console.tsx", import.meta.url), "utf8");
  const content = shell.slice(shell.indexOf('<section className="sw-content"'), shell.indexOf("<PublicAddressBanner"));
  assert.ok(content.includes("<AccessNotice />"), "the notice sits inside the content, above the banner it stacks with");
});
