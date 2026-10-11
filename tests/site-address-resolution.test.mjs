/**
 * The address a website actually serves.
 *
 * A site registered at its bare domain that redirects to www could never be
 * checked: the preview pins one origin and refuses a document that lands on
 * another, so the console reported "we cannot open this address" while a
 * visitor's browser had no trouble. A redirect inside the same website is not
 * a different site, and the address to keep is where it lands.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../lib/site-knowledge/site-address.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
});
const { resolveSiteAddress } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

/** A fetch that lands wherever the table says, the way `redirect: "follow"` reports it. */
function landing(map) {
  return async (url) => {
    const landed = map[url];
    if (landed === undefined) throw new Error("fetch_failed");
    return { url: landed, body: { cancel: async () => undefined } };
  };
}

test("a redirect inside the same website decides the address; anything else leaves it alone", async () => {
  const same = landing({ "https://shop.example/": "https://www.shop.example/" });
  assert.equal(await resolveSiteAddress("https://shop.example/", { fetchImpl: same }), "https://www.shop.example/");

  // www → bare, and a subdomain of the registered domain, are the same site too.
  assert.equal(
    await resolveSiteAddress("https://www.shop.example/", { fetchImpl: landing({ "https://www.shop.example/": "https://shop.example/" }) }),
    "https://shop.example/",
  );
  assert.equal(
    await resolveSiteAddress("https://shop.example/", { fetchImpl: landing({ "https://shop.example/": "https://store.shop.example/" }) }),
    "https://store.shop.example/",
  );

  // Landing on another site is the operator's business: the readiness check
  // reports it, and the registration is not moved.
  assert.equal(
    await resolveSiteAddress("https://shop.example/", { fetchImpl: landing({ "https://shop.example/": "https://other.test/" }) }),
    "https://shop.example/",
  );
  // A redirect to plain http is not an address to adopt silently.
  assert.equal(
    await resolveSiteAddress("https://shop.example/", { fetchImpl: landing({ "https://shop.example/": "http://www.shop.example/" }) }),
    "https://shop.example/",
  );
  // No redirect at all: unchanged, character for character.
  assert.equal(
    await resolveSiteAddress("https://shop.example/shop", { fetchImpl: landing({ "https://shop.example/shop": "https://shop.example/shop" }) }),
    "https://shop.example/shop",
  );
});

test("the path the operator chose survives a host-only redirect", async () => {
  // Landing on the root of the other host means the redirect moved the host,
  // not the page: keep the page.
  assert.equal(
    await resolveSiteAddress("https://shop.example/daily/2026-03-11", { fetchImpl: landing({ "https://shop.example/daily/2026-03-11": "https://www.shop.example/" }) }),
    "https://www.shop.example/daily/2026-03-11",
  );
  // A redirect that names a page keeps that page.
  assert.equal(
    await resolveSiteAddress("https://shop.example/old", { fetchImpl: landing({ "https://shop.example/old": "https://www.shop.example/new" }) }),
    "https://www.shop.example/new",
  );
});

test("a site that cannot be reached keeps the address it was given", async () => {
  const failing = async () => { throw new Error("ENOTFOUND"); };
  assert.equal(await resolveSiteAddress("https://shop.example/", { fetchImpl: failing }), "https://shop.example/");
  // And so does anything that is not an http address.
  assert.equal(await resolveSiteAddress("not a url", { fetchImpl: failing }), "not a url");
  assert.equal(await resolveSiteAddress("ftp://shop.example/", { fetchImpl: failing }), "ftp://shop.example/");
});
