import { NextRequest } from "next/server";
import { ingestSiteContentPages, loadPageContent, readPageByUrl, searchSiteContent, siteAgentExists } from "../../../../../db/site-agent-store";
import { siteAgentJson, siteAgentOptions } from "../../http";
import type { ContentPage } from "../../../../../lib/site-knowledge/content-index";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };

export async function OPTIONS() {
  return siteAgentOptions();
}

/**
 * The content backend of the unified knowledge search. The knowledge JSON stays
 * structure-only; page text is indexed separately here.
 *
 * GET  ?keyword=<kw>&keyword=<kw>…  → grep-style literal search over a keyword LIST,
 *   aggregated to pages with sentence-bounded context windows. Synonym expansion is the
 *   caller's job (the agent turns the user's phrasing into the keyword list), so a name
 *   miss (e.g. "小孩" → ["小孩","未成年"]) is still caught. Returns { pages, totalPagesWithHits }.
 *   `?goal=<query>` is accepted as a single-keyword shorthand for back-compat.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  if (!siteAgentId) return siteAgentJson({ error: "site_agent_id_required" }, 400);
  // ?path=<pathnamePattern> → the raw indexed content of that page type, for the console
  // "what's actually on this page" view. (The keyword search is the agent-facing search.)
  const path = (request.nextUrl.searchParams.get("path") || "").trim();
  if (path) {
    try {
      const chunks = await loadPageContent(siteAgentId, path);
      return siteAgentJson({ chunks }, 200);
    } catch (error) {
      return siteAgentJson({ error: error instanceof Error ? error.message : "content_load_failed" }, 500);
    }
  }
  // ?url=<exact url> → the `read_page` tool: every indexed chunk of one page, in order.
  const url = (request.nextUrl.searchParams.get("url") || "").trim();
  if (url) {
    try {
      const chunks = await readPageByUrl(siteAgentId, url);
      return siteAgentJson({ url, chunks }, 200);
    } catch (error) {
      return siteAgentJson({ error: error instanceof Error ? error.message : "page_read_failed" }, 500);
    }
  }
  const keywords = request.nextUrl.searchParams.getAll("keyword").map((keyword) => keyword.trim()).filter(Boolean);
  const goal = (request.nextUrl.searchParams.get("goal") || "").trim();
  const terms = keywords.length ? keywords : (goal ? [goal] : []);
  if (!terms.length) return siteAgentJson({ error: "keyword_required" }, 400);
  try {
    const result = await searchSiteContent(siteAgentId, terms, { topPages: 5 });
    return siteAgentJson(result, 200);
  } catch (error) {
    return siteAgentJson({ error: error instanceof Error ? error.message : "content_search_failed" }, 500);
  }
}

/**
 * POST { pages: [{ url, sceneId?, visibleText, heading? }] } → ingest into the
 * content index (chunk + hash + write, per-URL contentHash-gated). The crawl
 * pipeline will call this seam once the runner sends page text; it is also the
 * debug ingest path for onboarding a site's content directly.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  if (!siteAgentId) return siteAgentJson({ error: "site_agent_id_required" }, 400);
  if (!(await siteAgentExists(siteAgentId))) return siteAgentJson({ error: "site_agent_not_found" }, 404);
  try {
    const body = (await request.json()) as { pages?: ContentPage[] };
    const pages = Array.isArray(body?.pages)
      ? body.pages.filter((page) => page && typeof page.url === "string" && typeof page.visibleText === "string")
      : [];
    if (!pages.length) return siteAgentJson({ error: "pages_required" }, 400);
    const result = await ingestSiteContentPages(siteAgentId, pages);
    return siteAgentJson(result, 200);
  } catch (error) {
    return siteAgentJson({ error: error instanceof Error ? error.message : "content_ingest_failed" }, 500);
  }
}
