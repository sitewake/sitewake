import { NextRequest } from "next/server";
import { getActiveSiteAgentRelease, probeContentDiagnosis } from "../../../../../db/site-agent-store";
import { expandQueryKeywords } from "../../../../../lib/site-knowledge/model-analyzer";
import { searchKnowledgeIndex } from "../../../../../lib/site-knowledge/planner";
import { siteAgentJson, siteAgentOptions } from "../../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };

export async function OPTIONS() {
  return siteAgentOptions();
}

/**
 * Knowledge-center diagnostic probe (knowledge-center-manageability). READ-ONLY: lets an
 * operator try a real question and see exactly what the agent's search would do, to tell
 * a knowledge gap from a search/expansion problem. Writes nothing — no demand signal, no
 * state change; runtime answering is untouched.
 *
 * GET ?question=<q>        → expand (same guidance as the agent) into keywords, then search.
 * GET ?keyword=a&keyword=b → skip expansion, search the given keywords verbatim (operator override).
 *
 * Returns { expandedKeywords, pages, routes, totalPagesWithHits, diagnosis }.
 *   diagnosis: "answerable"      — search found pages
 *              "search_gap"      — no pages, but the question's terms DO appear on some page
 *                                  (content exists, search/expansion missed) + sampleUrls
 *              "knowledge_gap"   — no pages and the terms appear nowhere (site lacks it)
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  if (!siteAgentId) return siteAgentJson({ error: "site_agent_id_required" }, 400);
  const explicit = request.nextUrl.searchParams.getAll("keyword").map((keyword) => keyword.trim()).filter(Boolean);
  const question = (request.nextUrl.searchParams.get("question") || "").trim();
  if (!explicit.length && !question) return siteAgentJson({ error: "question_or_keyword_required" }, 400);
  try {
    // Operator-supplied keywords skip expansion; a raw question is expanded with the SAME
    // guidance the runtime agent uses (so the probe mirrors production).
    const keywords = explicit.length ? explicit : await expandQueryKeywords(question);
    const diagnosisText = question || explicit.join(" ");
    const { pages, totalPagesWithHits, coverageOfQuery } = await probeContentDiagnosis(siteAgentId, keywords, diagnosisText);

    // Structure routes come from the SAME index the runtime uses.
    const { release } = await getActiveSiteAgentRelease(siteAgentId);
    // Pages hit by body search feed navigation ranking directly: a verbatim hit in the
    // content store means the answer is on that page — far stronger evidence than
    // "shares a character with the name".
    const index = searchKnowledgeIndex(release, keywords, undefined, pages.map((page) => page.url));
    // The navigation half of the test: scenes the agent could `navigate_scene` to. Already
    // ranked verified-first by searchKnowledgeIndex. directEntry/evidenceStatus let the UI
    // label readiness (verified / needs re-verification / referenced only); the resolved URL is built client-side from
    // urlTemplate + the site origin. Cap to the top 5 so the navigation track stays readable.
    const routes = index.scenes.slice(0, 5).map((scene) => ({
      sceneId: scene.id, name: scene.name, urlTemplate: scene.urlTemplate,
      requiredParams: scene.requiredParams, readiness: scene.readiness, score: scene.score,
      directEntry: scene.directEntry, evidenceStatus: scene.evidenceStatus,
    }));

    const answerable = pages.length > 0 || routes.length > 0;
    const diagnosis = answerable
      ? "answerable"
      : coverageOfQuery.appears
        ? "search_gap"
        : "knowledge_gap";
    return siteAgentJson({ expandedKeywords: keywords, pages, routes, totalPagesWithHits, diagnosis, coverageOfQuery }, 200);
  } catch (error) {
    return siteAgentJson({ error: error instanceof Error ? error.message : "knowledge_probe_failed" }, 500);
  }
}
