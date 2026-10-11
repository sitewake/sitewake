import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/**
 * The rehearsal: a reader's page opened with the install snippet already in
 * it, in a real browser, so the browser decides what would happen before
 * anyone pastes anything.
 *
 * Driven here against fixture pages with real policies — the same mechanism
 * the site-preview job uses, not a copy of it.
 */

async function bundled(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false, external: ["playwright"],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { injectInstallSnippet, markAsRehearsal, collectPolicyViolations, serveWithInstallSnippet } = await bundled("../runner/site-preview-rehearsal.ts");

test("the snippet goes where a reader would put it, or nowhere at all", () => {
  const snippet = '<script src="https://console.acme.test/sitewake.js"></script>';
  assert.equal(
    injectInstallSnippet("<!doctype html><html><head><title>x</title></head><body>hi</body></html>", snippet),
    `<!doctype html><html><head><title>x</title>${snippet}</head><body>hi</body></html>`,
  );
  // No head: the top of the body still parses the tag before the page's own scripts run.
  assert.equal(
    injectInstallSnippet("<html><body><p>hi</p></body></html>", snippet),
    `<html><body>${snippet}<p>hi</p></body></html>`,
  );
  // Nothing to anchor to: say so instead of appending somewhere arbitrary.
  assert.equal(injectInstallSnippet("just text", snippet), "");
  assert.equal(injectInstallSnippet("", snippet), "");
});

/** A website with a policy, a sub-frame and a JSON endpoint. */
async function website({ policy, reportOnly }) {
  const server = createServer((request, response) => {
    const url = request.url || "/";
    if (url === "/data.json") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end('{"ok":true}');
    }
    if (url === "/frame") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", ...(policy ? { "content-security-policy": policy } : {}) });
      return response.end("<!doctype html><html><head></head><body>frame</body></html>");
    }
    const headers = { "content-type": "text/html; charset=utf-8" };
    if (policy) headers["content-security-policy"] = policy;
    if (reportOnly) headers["content-security-policy-report-only"] = reportOnly;
    response.writeHead(200, headers);
    response.end('<!doctype html><html><head><title>shop</title></head><body><iframe src="/frame"></iframe></body></html>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** The control plane the snippet points at: a script and an endpoint. */
async function controlPlane() {
  const server = createServer((request, response) => {
    if ((request.url || "").startsWith("/sitewake.js")) {
      response.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" });
      return response.end('window.__sitewake = true; fetch(new URL("/api/ping", document.currentScript ? document.currentScript.src : location.href)).catch(() => {});');
    }
    if ((request.url || "").startsWith("/api/ping")) {
      response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      return response.end("{}");
    }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * Both fixture servers are on loopback, and a response served through the
 * interception loses the document's address-space classification — so Chrome
 * would refuse the cross-port script as a public page reaching a local one.
 * That is an artifact of loopback fixtures: a real site and a real console are
 * both public addresses. The check is switched off here so the policies under
 * test are what decides.
 */
const FIXTURE_ARGS = ["--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights"];

async function rehearse(site, snippet) {
  const browser = await chromium.launch({ headless: true, args: FIXTURE_ARGS });
  try {
    const page = await browser.newPage();
    const violations = await collectPolicyViolations(page);
    const injection = await serveWithInstallSnippet(page, snippet);
    await page.goto(`${site.origin}/`, { waitUntil: "load" });
    await page.waitForTimeout(300);
    const html = await page.content();
    const loaded = await page.evaluate(() => Boolean(window.__sitewake));
    return { violations, injection, html, loaded };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

test("a page with default-src 'self' refuses the snippet, and the browser says which directives", async (t) => {
  const console_ = await controlPlane();
  const site = await website({ policy: "default-src 'self'" });
  t.after(async () => { await site.close(); await console_.close(); });

  const snippet = `<script src="${console_.origin}/sitewake.js" data-site-agent="shop" data-endpoint="${console_.origin}" defer></script>`;
  const { violations, injection, html, loaded } = await rehearse(site, snippet);

  assert.equal(injection.injected, true, "the snippet reached the document");
  assert.match(html, /sitewake\.js/);
  assert.equal(loaded, false, "the policy refused it, which is the point of rehearsing");

  const script = violations.find((violation) => violation.blockedUrl.includes("/sitewake.js"));
  assert.ok(script, `脚本违规应当被记录：${JSON.stringify(violations)}`);
  assert.equal(script.effectiveDirective, "script-src-elem");
  assert.equal(script.disposition, "enforce");
  assert.equal(script.policy, "default-src 'self'");
});

test("a policy that admits the console lets the install through, and reports nothing", async (t) => {
  const console_ = await controlPlane();
  const site = await website({ policy: `default-src 'self'; script-src 'self' ${console_.origin}; connect-src 'self' ${console_.origin}` });
  t.after(async () => { await site.close(); await console_.close(); });

  const snippet = `<script src="${console_.origin}/sitewake.js" data-site-agent="shop" defer></script>`;
  const { violations, loaded } = await rehearse(site, snippet);
  assert.equal(loaded, true);
  assert.deepEqual(violations, []);
});

test("report-only is recorded as reporting, so it is never presented as a blocker", async (t) => {
  const console_ = await controlPlane();
  const site = await website({ reportOnly: "default-src 'self'" });
  t.after(async () => { await site.close(); await console_.close(); });

  const snippet = `<script src="${console_.origin}/sitewake.js" data-site-agent="shop" defer></script>`;
  const { violations, loaded } = await rehearse(site, snippet);
  assert.equal(loaded, true, "报告模式不拦截");
  const script = violations.find((violation) => violation.blockedUrl.includes("/sitewake.js"));
  assert.equal(script.disposition, "report");
});

test("only the main document is rewritten: sub-frames and non-HTML responses are the site's own", async (t) => {
  const console_ = await controlPlane();
  const site = await website({});
  t.after(async () => { await site.close(); await console_.close(); });

  const snippet = `<script src="${console_.origin}/sitewake.js" data-site-agent="shop" defer></script>`;
  const browser = await chromium.launch({ headless: true, args: FIXTURE_ARGS });
  try {
    const page = await browser.newPage();
    await serveWithInstallSnippet(page, snippet);
    await page.goto(`${site.origin}/`, { waitUntil: "load" });
    await page.waitForTimeout(200);

    // The frame is a document too, but not the main one.
    const frame = page.frames().find((item) => item !== page.mainFrame());
    assert.ok(frame, "fixture 应当有子框架");
    assert.ok(!(await frame.content()).includes("sitewake.js"), "子框架不被改写");

    // A JSON response passes through untouched.
    const data = await page.evaluate(async (origin) => (await fetch(`${origin}/data.json`)).text(), site.origin);
    assert.equal(data, '{"ok":true}');
  } finally {
    await browser.close().catch(() => undefined);
  }
});

test("the snippet the rehearsal serves is marked as a rehearsal", () => {
  // The mark is what stops a rehearsal from being recorded as an installation.
  // Without it the SDK handshakes for real and the console reports a website as
  // connected when nobody has installed anything.
  const snippet = '<script src="https://console.acme.test/sitewake.js" data-site-agent="shop" defer></script>';
  const marked = markAsRehearsal(snippet);
  assert.match(marked, /^<script data-sitewake-rehearsal="1" src=/);
  assert.ok(marked.includes('data-site-agent="shop"'), "读者要粘贴的内容原样保留");

  // Whatever shape the snippet has, the mark lands on the tag itself.
  assert.match(markAsRehearsal('<SCRIPT src="x"></SCRIPT>'), /^<SCRIPT data-sitewake-rehearsal="1" /);
  assert.equal(markAsRehearsal("not a tag"), "not a tag");
});
