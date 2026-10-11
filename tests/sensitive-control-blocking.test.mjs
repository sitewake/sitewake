import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

// Sensitive-control blocking is DOM behaviour: it depends on real selector
// matching, `closest()` and computed visibility. A hand-rolled DOM shim would
// only prove the shim works, so this suite drives the actual bundle in a real
// browser.
//
// The two defences under test are independent by design and must both hold at
// all times, regardless of whether any boundary/pause subsystem exists:
//   1. sensitive controls never enter the actionable target list;
//   2. a dispatch aimed at one is refused even if it were requested anyway.
const ROOT = new URL("../", import.meta.url);

async function sensitiveControlBundle() {
  const result = await build({
    stdin: {
      // `humanInteractionBlacklist` moved here from the boundary module, which
      // has since been deleted. Importing it by name is now what pins the
      // defence to its permanent home.
      contents: `
        import * as shared from "./client/user-agent-shared";
        globalThis.__sensitiveProbe__ = {
          blacklist: () => shared.humanInteractionBlacklist(),
          isSensitive: (element) => shared.isSensitiveElement(element),
          kind: (element) => shared.sensitiveControlKind(element),
        };
      `,
      resolveDir: fileURLToPath(ROOT),
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome110"],
    write: false,
  });
  return result.outputFiles[0].text;
}

const FIXTURE = `<!doctype html>
<meta charset="utf-8">
<title>sensitive controls</title>
<body>
  <form id="login">
    <input id="username" name="username" autocomplete="username">
    <input id="password" name="password" type="password" autocomplete="current-password">
    <button id="submit-login" type="submit">Sign in</button>
  </form>

  <form id="verify">
    <input id="otp" name="otp" autocomplete="one-time-code">
  </form>

  <form id="pay">
    <input id="card" name="cardNumber" autocomplete="cc-number">
    <input id="cvc" name="cvc" autocomplete="cc-csc">
  </form>

  <div id="captcha-widget" class="g-recaptcha" data-sitekey="test-key">captcha</div>

  <form id="search">
    <input id="query" name="q" placeholder="Search">
    <button id="submit-search" type="submit">Search</button>
  </form>
</body>`;

async function probePage(browser) {
  const page = await browser.newPage();
  await page.setContent(FIXTURE);
  await page.addScriptTag({ content: await sensitiveControlBundle() });
  return page;
}

test("sensitive controls are excluded from the actionable target list", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await probePage(browser);

  const blocked = await page.evaluate(() =>
    globalThis.__sensitiveProbe__.blacklist().map((element) => element.id).filter(Boolean));

  for (const id of ["password", "otp", "card", "cvc", "captcha-widget"]) {
    assert.ok(blocked.includes(id), `expected ${id} to be excluded from actionable targets`);
  }
});

test("a benign control in an unrelated form stays actionable", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await probePage(browser);

  const blocked = await page.evaluate(() =>
    globalThis.__sensitiveProbe__.blacklist().map((element) => element.id).filter(Boolean));

  // Guards against an over-broad blacklist that would make the Agent unable to
  // operate ordinary pages.
  assert.ok(!blocked.includes("query"), "a plain search field must remain actionable");
  assert.ok(!blocked.includes("submit-search"), "a plain submit button must remain actionable");
});

test("every control inside an authentication form is treated as sensitive", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await probePage(browser);

  // The username field carries no sensitive attribute of its own; it is
  // sensitive because it shares a form with a password input.
  const verdicts = await page.evaluate(() => ({
    username: globalThis.__sensitiveProbe__.isSensitive(document.getElementById("username")),
    submitLogin: globalThis.__sensitiveProbe__.isSensitive(document.getElementById("submit-login")),
    query: globalThis.__sensitiveProbe__.isSensitive(document.getElementById("query")),
  }));

  assert.equal(verdicts.username, true);
  assert.equal(verdicts.submitLogin, true);
  assert.equal(verdicts.query, false);
});

test("sensitive control kinds are classified for diagnostics", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await probePage(browser);

  const kinds = await page.evaluate(() => ({
    password: globalThis.__sensitiveProbe__.kind(document.getElementById("password")),
    otp: globalThis.__sensitiveProbe__.kind(document.getElementById("otp")),
    card: globalThis.__sensitiveProbe__.kind(document.getElementById("card")),
    cvc: globalThis.__sensitiveProbe__.kind(document.getElementById("cvc")),
    query: globalThis.__sensitiveProbe__.kind(document.getElementById("query")),
  }));

  assert.equal(kinds.password, "password");
  assert.equal(kinds.otp, "otp");
  assert.equal(kinds.card, "payment-card");
  assert.equal(kinds.cvc, "payment-code");
  assert.equal(kinds.query, undefined);
});
