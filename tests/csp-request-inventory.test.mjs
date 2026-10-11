import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { CSP_REQUEST_INVENTORY, governingDirective, requestKindsNeedingOrigin } from "../lib/console/csp-request-inventory.ts";

/**
 * What a browser actually does with the requests the SDK makes, measured.
 *
 * Every piece of install guidance the console gives rests on one question: which
 * directive governs which of our requests, and what happens under the policies
 * real sites use. Answering that from the specification is how the previous
 * version got `'strict-dynamic'` and inline styles wrong, so it is answered here
 * by two origins, a real Chromium and the browser's own violation events.
 *
 * The measured table lives in lib/console/csp-request-inventory.ts and is what
 * the checker, the patch generator and the install prompt all read; the last
 * test in this file fails if that table and these measurements ever disagree.
 */

/** The page's own origin serves the driver; everything the SDK needs comes from the other one. */
async function fixture() {
  const foreign = createServer((request, response) => {
    const send = (type, body) => {
      response.writeHead(200, { "content-type": type, "access-control-allow-origin": "*", "cache-control": "no-store" });
      response.end(body);
    };
    if (request.url.startsWith("/tag.js")) return send("text/javascript", "window.__loaded = { ...(window.__loaded || {}), tag: true };");
    if (request.url.startsWith("/inserted.js")) return send("text/javascript", "window.__loaded = { ...(window.__loaded || {}), inserted: true };");
    if (request.url.startsWith("/module.mjs")) return send("text/javascript", "export const ok = true;");
    if (request.url.startsWith("/import-me.mjs")) return send("text/javascript", "window.__loaded = { ...(window.__loaded || {}), importedByTrusted: true }; export const ok = true;");
    if (request.url.startsWith("/data.json")) return send("application/json", '{"ok":true}');
    if (request.url.startsWith("/sheet.css")) return send("text/css", "#sheet-probe { color: rgb(7, 8, 9); }");
    if (request.url.startsWith("/pixel.png")) {
      response.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" });
      // 1x1 transparent PNG.
      return response.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"));
    }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  const foreignOrigin = `http://127.0.0.1:${foreign.address().port}`;

  /** `page(policy)` decides the document's policy; `driver.js` is same-origin, so `'self'` runs it. */
  let policy = { header: "", meta: "", reportOnly: "", nonce: "", tagNonce: true, parserTag: true };
  const site = createServer((request, response) => {
    if (request.url.startsWith("/driver.js")) {
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      return response.end(DRIVER);
    }
    const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
    if (policy.header) headers["content-security-policy"] = policy.header;
    if (policy.reportOnly) headers["content-security-policy-report-only"] = policy.reportOnly;
    response.writeHead(200, headers);
    // The site's own scripts carry the page nonce when there is one; the
    // install tag carries it only when the case says so.
    const siteNonce = policy.nonce ? ` nonce="${policy.nonce}"` : "";
    const tagNonce = policy.nonce && policy.tagNonce ? ` nonce="${policy.nonce}"` : "";
    response.end(`<!doctype html><html><head><meta charset="utf-8">`
      + (policy.meta ? `<meta http-equiv="Content-Security-Policy" content="${policy.meta}">` : "")
      + `<script id="foreign-origin" type="application/json">${JSON.stringify(foreignOrigin)}</script>`
      // Parser-blocking and ahead of the install tag: a violation is reported
      // as the resource is fetched, so the listener has to exist by then.
      + `<script src="/driver.js"${siteNonce}></script>`
      // Parser-inserted with defer, exactly how the install snippet enters a page.
      + (policy.parserTag ? `<script src="${foreignOrigin}/tag.js"${tagNonce} defer></script>` : "")
      + `</head><body><div id="probe">probe</div><div id="sheet-probe">sheet</div></body></html>`);
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));

  return {
    foreignOrigin,
    siteOrigin: `http://127.0.0.1:${site.address().port}`,
    set(next) { policy = { header: "", meta: "", reportOnly: "", nonce: "", parserTag: true, ...next }; },
    async close() {
      await Promise.all([
        new Promise((resolve) => site.close(resolve)),
        new Promise((resolve) => foreign.close(resolve)),
      ]);
    },
  };
}

/**
 * Runs in the page, same-origin so no policy has to allow it. Attempts one
 * request of every kind the SDK makes and records both the browser's violation
 * events and whether the thing actually took effect.
 */
const DRIVER = `
const violations = [];
document.addEventListener("securitypolicyviolation", (event) => violations.push({
  blockedURI: event.blockedURI,
  effectiveDirective: event.effectiveDirective,
  violatedDirective: event.violatedDirective,
  disposition: event.disposition,
  originalPolicy: event.originalPolicy,
}));
const foreign = JSON.parse(document.getElementById("foreign-origin").textContent);
const outcome = {};
async function attempt(name, run) {
  try { outcome[name] = await run(); } catch (error) { outcome[name] = { ok: false, error: String(error && error.message || error) }; }
}
window.__measure = (async () => {
  // The probes live in the body, and this script runs while the head is parsed.
  if (document.readyState === "loading") {
    await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
  }
  // Script inserted by another script, which is what 'strict-dynamic' treats differently.
  await attempt("scriptInserted", () => new Promise((resolve) => {
    const element = document.createElement("script");
    element.src = foreign + "/inserted.js";
    element.onload = () => resolve({ ok: true });
    element.onerror = () => resolve({ ok: false });
    document.head.appendChild(element);
  }));
  // A capability module: a dynamic import of a cross-origin module.
  await attempt("dynamicImport", async () => {
    const module = await import(foreign + "/module.mjs");
    return { ok: Boolean(module && module.ok) };
  });
  await attempt("fetch", async () => {
    const response = await fetch(foreign + "/data.json");
    return { ok: response.ok };
  });
  await attempt("image", () => new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ ok: true });
    image.onerror = () => resolve({ ok: false });
    image.src = foreign + "/pixel.png";
  }));
  // A <style> element created and appended by script: how the widget styles itself today.
  await attempt("styleElement", () => {
    const element = document.createElement("style");
    element.textContent = "#probe { color: rgb(1, 2, 3); }";
    document.head.appendChild(element);
    return { ok: getComputedStyle(document.getElementById("probe")).color === "rgb(1, 2, 3)" };
  });
  // A style attribute written through the CSSOM: how the widget positions its host.
  await attempt("styleAttribute", () => {
    const element = document.getElementById("probe");
    element.style.cssText = "outline-color: rgb(4, 5, 6)";
    return { ok: getComputedStyle(element).outlineColor === "rgb(4, 5, 6)" };
  });
  // The widget renders inside a shadow root, so the question is not whether a
  // <style> in the document is refused but whether one inside a shadow root is.
  await attempt("styleInShadow", () => {
    const host = document.createElement("div");
    host.id = "shadow-host";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const element = document.createElement("style");
    element.textContent = ":host { outline-color: rgb(9, 9, 9); }";
    shadow.appendChild(element);
    return { ok: getComputedStyle(host).outlineColor === "rgb(9, 9, 9)" };
  });
  // A stylesheet loaded from the other origin into the shadow root: the
  // alternative to injecting one.
  await attempt("styleSheetInShadow", () => new Promise((resolve) => {
    const host = document.createElement("div");
    host.id = "shadow-sheet-host";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const probe = document.createElement("div");
    probe.id = "sheet-probe";
    probe.textContent = "sheet";
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = foreign + "/sheet.css";
    link.onload = () => resolve({ ok: getComputedStyle(probe).color === "rgb(7, 8, 9)" });
    link.onerror = () => resolve({ ok: false });
    shadow.append(link, probe);
  }));
  // An external stylesheet from the other origin: the alternative to injecting styles.
  await attempt("styleSheet", () => new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = foreign + "/sheet.css";
    link.onload = () => resolve({ ok: getComputedStyle(document.getElementById("sheet-probe")).color === "rgb(7, 8, 9)" });
    link.onerror = () => resolve({ ok: false });
    document.head.appendChild(link);
  }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  return { outcome, violations, loaded: window.__loaded || {} };
})();
`;

/** One page load under `policy`, returning what the browser did. */
async function measure(browser, target, policy) {
  target.set(policy);
  const page = await browser.newPage();
  try {
    await page.goto(`${target.siteOrigin}/`, { waitUntil: "load" });
    const result = await page.evaluate(() => window.__measure);
    return {
      ...result,
      /** The directive the browser named for the first violation of this kind. */
      directiveFor(blockedPath) {
        const hit = result.violations.find((violation) => violation.blockedURI.includes(blockedPath));
        return hit ? { effective: hit.effectiveDirective, violated: hit.violatedDirective, disposition: hit.disposition } : undefined;
      },
    };
  } finally {
    await page.close();
  }
}

let browser;
let target;
test.before(async () => {
  browser = await chromium.launch({ headless: true });
  target = await fixture();
});
test.after(async () => {
  await browser?.close();
  await target?.close();
});

test("under default-src 'self' the browser names one directive per request kind", async () => {
  const measured = await measure(browser, target, { header: "default-src 'self'" });

  // Every cross-origin request the SDK makes is refused by a bare default-src.
  assert.equal(measured.loaded.tag, undefined, "解析器插入的脚本被拦");
  assert.equal(measured.outcome.scriptInserted.ok, false, "脚本插入的脚本被拦");
  assert.equal(measured.outcome.dynamicImport.ok, false, "能力模块被拦");
  assert.equal(measured.outcome.fetch.ok, false, "接口被拦");
  assert.equal(measured.outcome.image.ok, false, "图片被拦");
  assert.equal(measured.outcome.styleSheet.ok, false, "外链样式表被拦");

  // The browser names the directive that GOVERNS the request, in both fields,
  // even though the policy here writes none of them and `default-src` is what
  // actually matched. A patch generator therefore cannot learn from the event
  // which written directive to extend — it has to read the policy itself,
  // which the event carries as `originalPolicy`.
  assert.deepEqual(measured.directiveFor("/tag.js"), { effective: "script-src-elem", violated: "script-src-elem", disposition: "enforce" });
  assert.deepEqual(measured.directiveFor("/inserted.js"), { effective: "script-src-elem", violated: "script-src-elem", disposition: "enforce" });
  assert.deepEqual(measured.directiveFor("/module.mjs"), { effective: "script-src-elem", violated: "script-src-elem", disposition: "enforce" });
  assert.deepEqual(measured.directiveFor("/data.json"), { effective: "connect-src", violated: "connect-src", disposition: "enforce" });
  assert.deepEqual(measured.directiveFor("/pixel.png"), { effective: "img-src", violated: "img-src", disposition: "enforce" });
  assert.deepEqual(measured.directiveFor("/sheet.css"), { effective: "style-src-elem", violated: "style-src-elem", disposition: "enforce" });
  // The policy text comes with the event, so the governing directive is
  // derivable: none of these are written, so each patch adds a new directive.
  const policyText = measured.violations[0].originalPolicy;
  assert.equal(policyText, "default-src 'self'");
  assert.deepEqual(governingDirective("script", ["default-src"]), { directive: "default-src", present: true, effectiveDirective: "script-src-elem" });
  assert.deepEqual(governingDirective("api", []), { directive: "connect-src", present: false, effectiveDirective: "connect-src" });

  // The two ways the widget styles itself today. Whether SiteWake must stop
  // doing this — and therefore whether a site has to allow anything for style
  // at all — is decided by these two lines.
  assert.equal(measured.outcome.styleElement.ok, false, "注入的 <style> 在 default-src 'self' 下不生效");
  assert.equal(measured.directiveFor("inline").effective, "style-src-elem", "注入的 <style> 归 style-src-elem 管，来源记作 inline");
  assert.equal(measured.outcome.styleAttribute.ok, true, "CSSOM 写入不受策略约束");
  // The widget's own case: styles injected into a shadow root.
  assert.equal(measured.outcome.styleInShadow.ok, false, "shadow root 里的 <style> 同样被 default-src 'self' 拦下");
});

test("a policy that names the origin admits every request kind", async () => {
  const measured = await measure(browser, target, { header: `default-src 'self'; script-src 'self' ${target.foreignOrigin}; connect-src 'self' ${target.foreignOrigin}; img-src 'self' ${target.foreignOrigin}; style-src 'self' ${target.foreignOrigin}` });

  assert.equal(measured.loaded.tag, true);
  assert.equal(measured.outcome.scriptInserted.ok, true);
  assert.equal(measured.outcome.dynamicImport.ok, true);
  assert.equal(measured.outcome.fetch.ok, true);
  assert.equal(measured.outcome.image.ok, true);
  assert.equal(measured.outcome.styleSheet.ok, true, "外链样式表只要放行这一个来源就够");
  assert.equal(measured.outcome.styleSheetInShadow.ok, true, "shadow root 里的外链样式表也放行");
  assert.deepEqual(measured.violations.filter((violation) => !violation.blockedURI.includes("inline")), []);
  // Naming the origin does not buy back an injected <style>: that needs
  // 'unsafe-inline', which SiteWake must not ask a site for.
  assert.equal(measured.outcome.styleElement.ok, false);
});

test("under 'strict-dynamic' the allowlist is ignored and only the nonce carries", async () => {
  const measured = await measure(browser, target, {
    header: `script-src 'strict-dynamic' 'nonce-sitewake' ${target.foreignOrigin}; default-src 'self'`,
    nonce: "sitewake",
    tagNonce: true,
  });

  // The install tag carries the page's nonce, so it runs even though
  // 'strict-dynamic' is in force.
  assert.equal(measured.loaded.tag, true, "带 nonce 的标签放行");
  // Trust propagates from it: what that script loads is allowed without being
  // on any list — which is why the fix under this policy is the nonce, not the
  // origin.
  assert.equal(measured.outcome.scriptInserted.ok, true, "受信脚本插入的脚本随之放行");
  assert.equal(measured.outcome.dynamicImport.ok, true, "能力模块随之放行");
  // The origin in the allowlist did nothing for scripts, but connect-src is
  // untouched by 'strict-dynamic' and still falls back to default-src 'self'.
  assert.equal(measured.outcome.fetch.ok, false, "接口仍按 connect-src/default-src 判定");
  assert.equal(measured.directiveFor("/data.json").violated, "connect-src");
});

test("without the nonce, 'strict-dynamic' refuses the tag however the origin is listed", async () => {
  const measured = await measure(browser, target, {
    header: `script-src 'strict-dynamic' 'nonce-sitewake' ${target.foreignOrigin}; default-src 'self'`,
    nonce: "sitewake",
    tagNonce: false,
  });

  assert.equal(measured.loaded.tag, undefined, "白名单地址被忽略");
  assert.equal(measured.directiveFor("/tag.js").violated.startsWith("script-src"), true);
});

test("report-only reports and does not block; header and meta are enforced together", async () => {
  const onlyReporting = await measure(browser, target, { reportOnly: "default-src 'self'" });
  assert.equal(onlyReporting.loaded.tag, true, "Report-Only 不拦截");
  assert.equal(onlyReporting.outcome.fetch.ok, true);
  assert.equal(onlyReporting.directiveFor("/tag.js").disposition, "report");

  // Enforced and report-only at once: one blocks, and both are reported, so a
  // reader is told which of the two they actually have to change.
  const both = await measure(browser, target, {
    header: `default-src 'self' ${target.foreignOrigin}`,
    reportOnly: "default-src 'self'",
  });
  assert.equal(both.loaded.tag, true, "强制策略放行就能加载");
  assert.equal(both.directiveFor("/tag.js").disposition, "report", "仅报告的那条仍然报一次");

  // Two enforced policies: a request must pass every one of them.
  const headerAndMeta = await measure(browser, target, {
    header: `default-src 'self' ${target.foreignOrigin}`,
    meta: "default-src 'self'",
  });
  assert.equal(headerAndMeta.loaded.tag, undefined, "任何一条强制策略拦住就加载不了");
  assert.equal(headerAndMeta.directiveFor("/tag.js").disposition, "enforce");
});

test("the request inventory the console reasons from matches what was measured", () => {
  // One row per request the SDK makes. Changing the SDK means changing this
  // table and re-running the measurements above, not adjusting a copy of it
  // somewhere in the console.
  assert.deepEqual(CSP_REQUEST_INVENTORY.map((entry) => [entry.kind, entry.effectiveDirective, entry.fallback]), [
    ["script", "script-src-elem", ["script-src", "default-src"]],
    ["capability-module", "script-src-elem", ["script-src", "default-src"]],
    ["api", "connect-src", ["default-src"]],
    ["style", "style-src-elem", ["style-src", "default-src"]],
    ["image", "img-src", ["default-src"]],
  ]);
  // Every kind is satisfied by naming the control plane's origin: nothing in
  // the table asks a site for 'unsafe-inline' or 'unsafe-eval'.
  assert.deepEqual(requestKindsNeedingOrigin(), ["script", "capability-module", "api", "style", "image"]);
  assert.equal(CSP_REQUEST_INVENTORY.some((entry) => entry.needsUnsafeInline || entry.needsUnsafeEval), false);
});
