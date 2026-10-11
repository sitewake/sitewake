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

const { crawlAuthorizationHeaders } = await load("../runner/crawl-authorization.ts");
const token = "a".repeat(32);

test("crawl authorization is issued only for an exact approved HTTPS origin", () => {
  const environment = {
    SITEWAKE_CRAWL_SHARED_TOKEN: token,
    SITEWAKE_CRAWL_AUTH_ORIGINS: "https://www.example.org,https://docs.example.com",
  };
  assert.deepEqual(crawlAuthorizationHeaders("https://www.example.org", environment), {
    "x-sitewake-crawl-token": token,
  });
  assert.deepEqual(crawlAuthorizationHeaders("https://example.org", environment), {});
  assert.deepEqual(crawlAuthorizationHeaders("https://www.example.org.evil.test", environment), {});
  assert.deepEqual(crawlAuthorizationHeaders("http://www.example.org", environment), {});
});

test("crawl authorization fails closed for missing, short, or malformed configuration", () => {
  assert.deepEqual(crawlAuthorizationHeaders("https://www.example.org", {}), {});
  assert.deepEqual(crawlAuthorizationHeaders("https://www.example.org", {
    SITEWAKE_CRAWL_SHARED_TOKEN: "short",
    SITEWAKE_CRAWL_AUTH_ORIGINS: "https://www.example.org",
  }), {});
  assert.deepEqual(crawlAuthorizationHeaders("https://www.example.org", {
    SITEWAKE_CRAWL_SHARED_TOKEN: token,
    SITEWAKE_CRAWL_AUTH_ORIGINS: "not-a-url",
  }), {});
});

test("crawl documents bound large sitemap seed provenance before runner completion", async () => {
  const {
    MAX_CRAWL_DOCUMENT_SEEDS,
    assembleSiteKnowledgeDocument,
    assertValidSiteKnowledgeDocument,
    crawlSiteKnowledge,
  } = await load("../lib/site-knowledge/crawl-knowledge.ts");
  const origin = "https://www.example.org";
  const seeds = Array.from(
    { length: MAX_CRAWL_DOCUMENT_SEEDS + 250 },
    (_, index) => `${origin}/daily/2026-08-${String((index % 31) + 1).padStart(2, "0")}?seed=${index}`,
  );
  // Exercise deterministic de-duplication as well as the hard document bound.
  seeds.splice(10, 0, seeds[0]);
  const document = assembleSiteKnowledgeDocument({
    siteAgentId: "acme-production",
    origin,
    crawledAt: "2026-08-10T00:00:00.000Z",
    seeds,
    snapshots: [],
  });

  assert.equal(document.meta.seeds.length, MAX_CRAWL_DOCUMENT_SEEDS);
  assert.equal(document.meta.seeds[0], seeds[0]);
  assert.equal(new Set(document.meta.seeds).size, MAX_CRAWL_DOCUMENT_SEEDS);
  assert.doesNotThrow(() => assertValidSiteKnowledgeDocument(document, {
    siteAgentId: "acme-production",
    origin,
  }));

  // Use the real frontier with only a probe on seed. A hand-written stub rots silently
  // when the interface grows a method — the classic "all green, nothing ran".
  // maxRenders: 0 stops it at once; what is checked is how seeds are passed, not rendering.
  const { CrawlFrontier } = await load("../lib/site-knowledge/crawl-frontier.ts");
  class SeedProbeFrontier extends CrawlFrontier {
    seeded = [];
    seed(values) {
      this.seeded = [...values];
      return super.seed(values);
    }
  }
  const frontier = new SeedProbeFrontier({ origin, maxRenders: 0 });
  const crawled = await crawlSiteKnowledge({
    siteAgentId: "acme-production",
    origin,
    crawledAt: "2026-08-10T00:00:00.000Z",
    seeds,
    frontier,
    renderPage: async () => null,
  });
  // The frontier gets all seeds (untruncated); the document keeps only the first MAX_CRAWL_DOCUMENT_SEEDS.
  assert.equal(frontier.seeded.length, seeds.length);
  assert.equal(crawled.meta.seeds.length, MAX_CRAWL_DOCUMENT_SEEDS);
  // The duplicate is deduplicated in the frontier, so urlsSeen is one fewer than submitted.
  assert.equal(crawled.meta.stats.urlsSeen, seeds.length - 1);

  const oversizedProvenance = structuredClone(document);
  oversizedProvenance.meta.seeds = seeds.slice(0, MAX_CRAWL_DOCUMENT_SEEDS + 1);
  assert.throws(() => assertValidSiteKnowledgeDocument(oversizedProvenance, {
    siteAgentId: "acme-production",
    origin,
  }), /crawl_document_invalid:meta/);
});
