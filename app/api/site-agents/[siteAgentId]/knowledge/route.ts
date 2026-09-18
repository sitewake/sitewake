import { NextRequest, NextResponse } from "next/server";
import { getActiveSiteAgentRelease, loadSiteKnowledge } from "../../../../../db/site-agent-store";
import { canonicalizeReleaseKnowledge } from "../../../../../lib/site-knowledge/canonicalize";
import { siteKnowledgeFromRelease } from "../../../../../lib/site-knowledge/knowledge-model";
import { SITE_AGENT_CORS_HEADERS, persistenceHeaders, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };
export async function OPTIONS() { return siteAgentOptions(); }

/**
 * The independent Site Knowledge base as its own product surface: a single
 * self-contained JSON (profile / scenes / links / tree) that guides the agent's
 * capability invocation. Knowledge only — no operations/capabilities/targets/
 * agentConfig (those live in the Release, which references this by KnowledgeRevision).
 * `?version=N` returns a specific stored revision; otherwise the latest. The revision
 * advances only on a material change, so it is stable across config/capability publishes.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  if (!siteAgentId) return siteAgentJson({ error: "site_agent_id_required" }, 400);
  try {
    // Only a non-empty, non-negative integer is an explicit version request;
    // everything else (omitted, empty "", "abc", "1.5", "-1", "Infinity") means latest.
    const versionParam = (request.nextUrl.searchParams.get("version") || "").trim();
    const parsedVersion = versionParam === "" ? NaN : Number(versionParam);
    const version = Number.isInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : undefined;
    const loaded = await loadSiteKnowledge(siteAgentId, version);
    let knowledge = loaded.knowledge;
    // No stored row (memory persistence, or store not yet mirrored): derive the
    // latest from the active release. An explicit version miss stays a 404.
    if (!knowledge && version === undefined) {
      const result = await getActiveSiteAgentRelease(siteAgentId);
      knowledge = siteKnowledgeFromRelease(canonicalizeReleaseKnowledge(result.release));
    }
    if (!knowledge) return siteAgentJson({ error: "site_knowledge_not_found" }, 404);
    const etag = `"${knowledge.contentHash}-knowledge"`;
    if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers: { ...SITE_AGENT_CORS_HEADERS, etag, "cache-control": "public,max-age=0,must-revalidate" } });
    return siteAgentJson({ knowledge }, 200, { etag, "cache-control": "public,max-age=0,must-revalidate", ...persistenceHeaders(loaded.persistence) });
  } catch (error) {
    return siteAgentFailure(error, "site_agent_knowledge_failed");
  }
}
