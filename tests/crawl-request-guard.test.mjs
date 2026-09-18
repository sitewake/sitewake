import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

async function load(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { crawlRequestAllowed, normalizeAdditionalRequestOrigins } = await load("../lib/site-knowledge/crawl-render.ts");

const site = "https://shop.example.com";
const controlPlane = "https://console.sitewake.test";

test("without the extra parameter every foreign origin stays blocked", () => {
  // The crawl path does not pass this parameter; behavior must be exactly as before.
  assert.equal(crawlRequestAllowed(`${site}/app.js`, site), true);
  assert.equal(crawlRequestAllowed(`${site}/a/b?c=1#d`, site), true);
  assert.equal(crawlRequestAllowed(`${controlPlane}/sitewake.js`, site), false);
  assert.equal(crawlRequestAllowed("https://cdn.other.test/x.js", site), false);
  // Same host with a different port or scheme is a different origin.
  assert.equal(crawlRequestAllowed("https://shop.example.com:8443/x.js", site), false);
  assert.equal(crawlRequestAllowed("http://shop.example.com/x.js", site), false);
});

test("an extra origin is allowed and nothing else is", () => {
  const extra = [controlPlane];
  assert.equal(crawlRequestAllowed(`${site}/app.js`, site, extra), true);
  assert.equal(crawlRequestAllowed(`${controlPlane}/sitewake.js`, site, extra), true);
  assert.equal(crawlRequestAllowed(`${controlPlane}/api/site-agents/s1/connection`, site, extra), true);
  // Allowance is per origin; sibling and parent domains are not included.
  assert.equal(crawlRequestAllowed("https://evil.sitewake.test/x.js", site, extra), false);
  assert.equal(crawlRequestAllowed("https://sitewake.test/x.js", site, extra), false);
  assert.equal(crawlRequestAllowed("https://cdn.other.test/x.js", site, extra), false);
});

test("credentials in a request URL are refused even for an allowed origin", () => {
  assert.equal(crawlRequestAllowed("https://user:pw@console.sitewake.test/sitewake.js", site, [controlPlane]), false);
  assert.equal(crawlRequestAllowed("https://user:pw@shop.example.com/app.js", site), false);
});

test("non-http schemes are not origin-scoped and unparseable URLs are blocked", () => {
  // data:/blob: are allowed by the Playwright route; the CDP guard never sees them.
  assert.equal(crawlRequestAllowed("data:text/plain,hello", site), true);
  assert.equal(crawlRequestAllowed("blob:https://shop.example.com/abc", site), true);
  assert.equal(crawlRequestAllowed("not a url", site), false);
});

test("the additional origin list drops entries it must not honour", () => {
  const normalized = normalizeAdditionalRequestOrigins([
    "https://console.sitewake.test/some/path",
    "https://user:pw@creds.test",
    "ftp://files.test",
    "not a url",
    "",
  ]);
  assert.deepEqual([...normalized], [controlPlane]);
  assert.deepEqual([...normalizeAdditionalRequestOrigins(undefined)], []);
});
