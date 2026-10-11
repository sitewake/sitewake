import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// install-readiness now imports its sibling modules, so it is bundled the way
// the route tests bundle it rather than imported as a bare .ts file.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../lib/console/install-readiness.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
});
const { assessInstallReadiness, cspAllowsOrigin, cspFromHtml, installReadinessBlocked, parseCsp } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const allows = (policy, directive, origin) => cspAllowsOrigin(parseCsp(policy), directive, origin);

test("a policy admits the control plane only when it really names it", () => {
  const sdk = "https://console.example.com";
  // No policy at all, or no directive that covers this one: the browser allows it.
  assert.equal(allows("", "script-src", sdk), true);
  assert.equal(allows("img-src 'self'", "script-src", sdk), true);
  // default-src is the fallback; 'self' is another origin, so it never admits us.
  assert.equal(allows("default-src 'self'", "script-src", sdk), false);
  assert.equal(allows("default-src 'self'", "connect-src", sdk), false);
  assert.equal(allows("script-src 'self' https://console.example.com", "script-src", sdk), true);
  // script-src-elem wins over script-src for a <script> element.
  assert.equal(allows("script-src https://console.example.com; script-src-elem 'self'", "script-src", sdk), false);
  // Wildcards, schemes and host patterns.
  assert.equal(allows("default-src *", "connect-src", sdk), true);
  assert.equal(allows("connect-src https:", "connect-src", sdk), true);
  assert.equal(allows("connect-src https:", "connect-src", "http://192.168.1.10:3000"), false);
  assert.equal(allows("script-src *.example.com", "script-src", sdk), true);
  assert.equal(allows("script-src *.example.com", "script-src", "https://example.com"), false);
  // Port and scheme are compared when the source names them.
  assert.equal(allows("connect-src http://192.168.1.10:3000", "connect-src", "http://192.168.1.10:3000"), true);
  assert.equal(allows("connect-src http://192.168.1.10:4000", "connect-src", "http://192.168.1.10:3000"), false);
  assert.equal(allows("connect-src https://console.example.com", "connect-src", "http://console.example.com"), false);
  // Nonces and hashes admit specific inline code, never a cross-origin file.
  assert.equal(allows("script-src 'nonce-abc123'", "script-src", sdk), false);
});

test("a policy in a meta tag counts exactly like the header", () => {
  const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'self'">`;
  assert.equal(cspFromHtml(html), "default-src 'self'");
  assert.equal(cspFromHtml("<!doctype html><title>x</title>"), undefined);
  const readiness = assessInstallReadiness({ siteUrl: "https://shop.example/", sdkOrigin: "https://console.example.com", html });
  assert.deepEqual(readiness.csp, { source: "meta", missing: ["script-src", "connect-src", "img-src"] });
});

test("a redirect to any other origin is reported, because the handshake is origin-bound", () => {
  const redirected = assessInstallReadiness({
    siteUrl: "https://shop.example/",
    finalUrl: "https://other.example/home",
    sdkOrigin: "https://console.example.com",
  });
  assert.deepEqual(redirected.originMismatch, { registered: "https://shop.example", actual: "https://other.example" });
  // A `www` name and a subdomain are reported too. The handshake and task
  // authorization both need the exact address, so calling them "the same
  // website" here told the reader they were installed and then refused the
  // first task. Reporting it is how they learn to register the address they
  // actually serve from.
  assert.deepEqual(
    assessInstallReadiness({ siteUrl: "https://shop.example/", finalUrl: "https://www.shop.example/home", sdkOrigin: "https://console.example.com" }).originMismatch,
    { registered: "https://shop.example", actual: "https://www.shop.example" },
  );
  assert.deepEqual(
    assessInstallReadiness({ siteUrl: "https://shop.example/", finalUrl: "https://staging.shop.example/", sdkOrigin: "https://console.example.com" }).originMismatch,
    { registered: "https://shop.example", actual: "https://staging.shop.example" },
  );
  // http → https is the same trap seen from the other side.
  assert.deepEqual(
    assessInstallReadiness({ siteUrl: "http://shop.example/", finalUrl: "https://shop.example/", sdkOrigin: "https://console.example.com" }).originMismatch,
    { registered: "http://shop.example", actual: "https://shop.example" },
  );
  // Same origin, different path: nothing to report.
  assert.equal(
    assessInstallReadiness({ siteUrl: "https://shop.example/", finalUrl: "https://shop.example/landing", sdkOrigin: "https://console.example.com" }).originMismatch,
    undefined,
  );
});

test("everything a reader must know is collected in one verdict", () => {
  const readiness = assessInstallReadiness({
    siteUrl: "https://shop.example/",
    finalUrl: "https://other.example/",
    sdkOrigin: "https://console.example.com",
    cspHeader: "default-src 'self'; img-src *",
  });
  assert.deepEqual(readiness.originMismatch, { registered: "https://shop.example", actual: "https://other.example" });
  assert.deepEqual(readiness.csp, { source: "header", missing: ["script-src", "connect-src"] });
  assert.equal(installReadinessBlocked(readiness), true);

  const clean = assessInstallReadiness({ siteUrl: "https://shop.example/", finalUrl: "https://shop.example/", sdkOrigin: "https://console.example.com", cspHeader: "default-src 'self' https://console.example.com" });
  assert.equal(installReadinessBlocked(clean), false);
  assert.equal(clean.csp, undefined);
});

test("a site the control plane cannot load at all is its own verdict", () => {
  const readiness = assessInstallReadiness({
    siteUrl: "https://intranet.local/",
    sdkOrigin: "https://console.example.com",
    unreachable: { reason: "certificate", detail: "self-signed certificate" },
  });
  assert.deepEqual(readiness.unreachable, { reason: "certificate", detail: "self-signed certificate" });
  assert.equal(installReadinessBlocked(readiness), true);
});

test("the mismatch tells the reader which address to register, in both languages", async () => {
  // A subdomain and a www alias are now reported, and the copy that was there
  // said "a different domain is another website" — true of neither. A reader
  // seeing it for `www.shop.example` would go looking for a second website.
  // Bundled rather than imported: lib/i18n reaches its neighbours without file
  // extensions, which the strip-types loader cannot resolve.
  const { build } = await import("esbuild");
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../lib/i18n/index.ts", import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
  });
  const { t } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  for (const locale of ["zh", "en"]) {
    const copy = t(locale).shell.onboarding.install;
    const body = copy.originMismatchBody("https://shop.example", "https://www.shop.example");
    assert.match(body, /shop\.example/, `${locale}: 要点名登记的地址`);
    assert.match(body, /www\.shop\.example/, `${locale}: 要点名实际的地址`);
    assert.doesNotMatch(copy.originMismatchTitle, /另一个来源|another origin/,
      `${locale}: 标题不能把同域的另一个地址说成「另一个来源」`);
  }
});
