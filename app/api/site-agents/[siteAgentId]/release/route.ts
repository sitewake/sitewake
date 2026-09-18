import { NextRequest, NextResponse } from "next/server";
import { getActiveSiteAgentRelease, getSiteAgentReleaseById, siteAgentExists } from "../../../../../db/site-agent-store";
import { canonicalizeReleaseKnowledge } from "../../../../../lib/site-knowledge/canonicalize";
import { siteKnowledgeFromRelease } from "../../../../../lib/site-knowledge/knowledge-model";
import { withTransientNavigationToolCapabilities } from "../../../../../lib/site-knowledge/navigation-tools";
import { sanitizePublicRuntime } from "../../../../../lib/site-knowledge/public-runtime";
import { runtimeFeatureEtag, siteAgentRuntimeFeatures } from "../../../../../lib/site-knowledge/runtime-features";
import { stableHash } from "../../../../../lib/site-knowledge/protocol";
import { SITE_AGENT_CORS_HEADERS, managementAuthorized, persistenceHeaders, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };
export async function OPTIONS() { return siteAgentOptions(); }

export async function GET(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  if (!siteAgentId) return siteAgentJson({ error: "site_agent_id_required" }, 400);
  if (!(await siteAgentExists(siteAgentId))) return siteAgentJson({ error: "site_agent_not_found" }, 404);
  const releaseIdParam = request.nextUrl.searchParams.get("releaseId");
  const releaseId = releaseIdParam?.trim();
  if (releaseIdParam !== null && !releaseId) return siteAgentJson({ error: "site_agent_release_id_required" }, 400);
  const runtime = request.nextUrl.searchParams.get("runtime") === "1";
  if (!runtime && !(await managementAuthorized(request))) {
    return siteAgentJson({ error: "unauthorized" }, 401);
  }
  try {
    const result = releaseId
      ? await getSiteAgentReleaseById(siteAgentId, releaseId)
      : await getActiveSiteAgentRelease(siteAgentId);
    // The active row can predate Scene clustering fixes. Every Release consumer
    // must receive the same self-contained executable graph; connection-only
    // normalization left SDK refreshes reading retired Scene references. A
    // historical execution pin is already an immutable, validated graph and
    // must not be recompiled with today's canonicalization rules.
    const canonicalRelease = releaseId ? result.release : canonicalizeReleaseKnowledge(result.release);
    // Pre-canonical SDKs expect navigation-tool:* executable records in the
    // runtime manifest. Synthesize those records only on this response boundary
    // and never write them back. The current SDK opts out and resolves an
    // explicit legacy ID from NavigationTools in its own trusted memory.
    const legacyRuntimeAdapters = runtime && request.nextUrl.searchParams.get("capabilityAdapters") !== "0";
    const runtimeSource = legacyRuntimeAdapters
      ? withTransientNavigationToolCapabilities(canonicalRelease)
      : canonicalRelease;
    const runtimeFeatures = siteAgentRuntimeFeatures(siteAgentId);
    const release = runtime ? sanitizePublicRuntime({
      ...runtimeSource,
      runtimeFeatures,
      profile: { ...runtimeSource.profile, fieldEvidence: undefined },
      scenes: runtimeSource.scenes.map((scene) => ({ ...scene, sourceObservationIds: [], evidence: scene.evidence ? { linkLabels: scene.evidence.linkLabels.slice(0, 4), observedUrls: scene.evidence.observedUrls.slice(-2), titles: scene.evidence.titles.slice(-2), headings: scene.evidence.headings.slice(-2) } : undefined })),
      linkReferences: [],
    }) : canonicalRelease;
    // Widget config is no longer inside the content hash, so it has to enter
    // the ETag on its own — otherwise a recoloured widget keeps serving 304 and
    // the browser never sees the new config. Hashed rather than timestamped so
    // that changing a value back to what it was returns the previous ETag
    // instead of forcing every client to refetch.
    const etag = `"${canonicalRelease.contentHash}${runtime ? `${legacyRuntimeAdapters ? "-runtime-legacy-adapters" : "-runtime"}-${runtimeFeatureEtag(runtimeFeatures)}` : ""}-c${stableHash(JSON.stringify(canonicalRelease.agentConfig ?? null))}"`;
    if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers: { ...SITE_AGENT_CORS_HEADERS, etag, "cache-control": "public,max-age=0,must-revalidate" } });
    // Public Knowledge is derived only from the already-sanitized runtime
    // graph. Raw canonical evidence remains management-only.
    const body = runtime
      ? {
          release,
          knowledge: sanitizePublicRuntime(siteKnowledgeFromRelease(release)),
        }
      : { release };
    return siteAgentJson(body, 200, { etag, "cache-control": "public,max-age=0,must-revalidate", ...persistenceHeaders(result.persistence) });
  } catch (error) {
    if (error instanceof Error && error.message === "site_agent_release_not_found") {
      return siteAgentJson({ error: error.message }, 404);
    }
    return siteAgentFailure(error, "site_agent_release_failed");
  }
}
