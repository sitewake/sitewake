/**
 * Local preview: runs the full crawl knowledge pipeline against a real site (real
 * Playwright + sitemap + frontier + assembly), writes the resulting site-knowledge JSON
 * to disk and prints a summary. No D1 / runner / Worker needed — a standalone runCrawl
 * for looking at results directly.
 *
 *   npx playwright install chromium        # first time
 *   node_modules/.bin/tsx scripts/crawl-preview.ts https://example.com [maxRenders]
 *
 * Inject straight into the frontend activeRelease (visible at view=model, no runner):
 *   ... https://example.com 20 --adopt http://localhost:3000 localhost
 */
import { chromium, type BrowserContext, type Page } from "playwright";
import { writeFile } from "node:fs/promises";
import { buildBusinessTopologyFromParts } from "../lib/site-knowledge/business-topology";
import { CrawlFrontier } from "../lib/site-knowledge/crawl-frontier";
import { crawlSiteKnowledge } from "../lib/site-knowledge/crawl-knowledge";
import { validateCrawlJobLimits } from "../lib/site-knowledge/crawl-limits";
import { installCrawlBrowserNetworkGuards, playwrightRenderPage } from "../lib/site-knowledge/crawl-render";
import { DEFAULT_UA, parseRobots, robotsAllows } from "../lib/site-knowledge/crawl-politeness";
import { fetchSameOriginText, seedFromSitemap } from "../lib/site-knowledge/sitemap-seed";
import {
  crawlArtifactFilename,
  chromiumPinnedOriginArgs,
  pinnedOriginFetch,
  resolvePinnedCrawlOrigin,
} from "../runner/crawl-network-policy";

const origin = process.argv[2];
if (!origin) {
  console.error("usage: tsx scripts/crawl-preview.ts <https://site> [maxRenders]");
  process.exit(1);
}
const maxRenders = validateCrawlJobLimits({
  maxRenders: Number(process.argv[3] || 20),
})!.maxRenders!;

const pin = await resolvePinnedCrawlOrigin(new URL(origin).origin, {
  allowPrivateNetwork: process.env.NODE_ENV !== "production"
    && process.env.SITEWAKE_CRAWL_ALLOW_PRIVATE_NETWORK === "1",
});
const pinnedFetch = pinnedOriginFetch(pin);
const browser = await chromium.launch({
  args: chromiumPinnedOriginArgs(pin),
});
let context: BrowserContext | undefined;
let page: Page | undefined;
try {
  context = await browser.newContext({ userAgent: DEFAULT_UA, serviceWorkers: "block" });
  await installCrawlBrowserNetworkGuards(context);
  page = await context.newPage();
  const crawlOrigin = pin.origin;
  const robotsResult = await fetchSameOriginText(
    new URL("/robots.txt", origin).toString(),
    crawlOrigin,
    { fetchImpl: pinnedFetch },
  );
  const robotsTxt = robotsResult?.ok ? robotsResult.text : "";
  const rules = parseRobots(robotsTxt);
  const seeded = await seedFromSitemap(origin, {
    robotsSitemaps: rules.sitemaps,
    fetchText: (url) => fetchSameOriginText(
      url,
      crawlOrigin,
      { fetchImpl: pinnedFetch },
    ),
  });
  console.log(`sitemap: ${seeded.source} — ${seeded.urls.length} urls from ${seeded.sitemapUrls.length} sitemap(s)`);

  const started = Date.now();
  const frontier = new CrawlFrontier({ origin, maxRenders, isAllowed: (url) => robotsAllows(rules, url) });
  const document = await crawlSiteKnowledge({
    siteAgentId: `preview:${new URL(origin).host}`,
    origin,
    crawledAt: new Date().toISOString(),
    seeds: [origin, ...seeded.urls],
    frontier,
    renderPage: playwrightRenderPage(page, { timeoutMs: 15_000, allowedOrigin: crawlOrigin }),
    // No generateProfile → defaultProfile (avoids model credentials; to see AI naming, configure a model and pass crawlProfileGenerator())
  });

  const outFile = crawlArtifactFilename(origin);
  await writeFile(outFile, JSON.stringify(document, null, 2));

  console.log(`\n=== ${origin}  (${Date.now() - started}ms) ===`);
  console.log(`rendered ${document.meta.stats.pagesRendered} pages → ${document.scenes.length} scene 类型 · ${document.links.length} link 边\n`);
  console.log("Scenes (URL 聚类):");
  for (const scene of document.scenes) {
    const samples = scene.sampleCount ? `  (~${scene.sampleCount} urls)` : "";
    console.log(`  ${(scene.evidenceStatus || "?").padEnd(9)} ${(scene.urlTemplates[0]?.pathnamePattern || "/").padEnd(30)}${samples}  ${scene.name}`);
  }
  // Topology is derived on demand, not carried in the document — recompute for the preview.
  const tree = buildBusinessTopologyFromParts({ rootName: document.profile.name, scenes: document.scenes, linkReferences: document.links });
  console.log(`\nTree(网站地图) root=${tree.root.name} · ${tree.primaryEdges.length} primary + ${tree.secondaryEdges.length} secondary 边`);
  console.log(`\n完整四段文档 → ${outFile}`);

  const adoptIndex = process.argv.indexOf("--adopt");
  if (adoptIndex !== -1) {
    const baseUrl = process.argv[adoptIndex + 1];
    const siteAgentId = process.argv[adoptIndex + 2];
    if (!baseUrl || !siteAgentId) {
      console.error("--adopt 需要 <baseUrl> <siteAgentId>,例如 --adopt http://localhost:3000 localhost");
    } else {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/site-agents/${encodeURIComponent(siteAgentId)}/crawl/adopt`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: new URL(baseUrl).origin,
          ...(process.env.SITEWAKE_MANAGEMENT_COOKIE
            ? { cookie: process.env.SITEWAKE_MANAGEMENT_COOKIE }
            : {}),
        },
        body: JSON.stringify({ document }),
      });
      const result = await response.json().catch(() => ({}));
      console.log(`\nadopt → ${response.status}  ${JSON.stringify(result)}`);
      console.log(`打开 ${baseUrl.replace(/\/$/, "")}/?site=${encodeURIComponent(siteAgentId)}&view=model 查看`);
    }
  }
} finally {
  await page?.close().catch(() => undefined);
  await context?.close().catch(() => undefined);
  await browser.close();
}
