import { enqueueSitePreviewJob, getSiteAgentOverview, getSitePreview, siteAgentAccess } from "@/db/site-agent-store";
import { managementAuthorized, managementMutationAuthorized, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };
export async function OPTIONS() { return siteAgentOptions(); }

async function accessible(siteAgentId: string) {
  return await siteAgentAccess(siteAgentId);
}

export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const { siteAgentId: rawId } = await context.params;
  const siteAgentId = decodeURIComponent(rawId || "").trim();
  const access = await accessible(siteAgentId);
  if (access === "not_found") return siteAgentJson({ error: "site_agent_not_found" }, 404);
  if (access === "forbidden") return siteAgentJson({ error: "site_agent_forbidden" }, 403);
  const result = await getSitePreview(siteAgentId);
  return siteAgentJson(result);
}

export async function POST(request: Request, context: RouteContext) {
  if (!(await managementMutationAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const { siteAgentId: rawId } = await context.params;
  const siteAgentId = decodeURIComponent(rawId || "").trim();
  const access = await accessible(siteAgentId);
  if (access === "not_found") return siteAgentJson({ error: "site_agent_not_found" }, 404);
  if (access === "forbidden") return siteAgentJson({ error: "site_agent_forbidden" }, 403);
  try {
    const { overview } = await getSiteAgentOverview(siteAgentId);
    // A preview represents the site, not the most recently visited detail page.
    // The release entry URL is the durable homepage choice; connection.url is
    // transient execution state and remains only as a fallback for legacy sites.
    const url = overview.profile.entryUrl || overview.connection?.origin || overview.connection?.url;
    if (!url) return siteAgentJson({ error: "site_preview_url_missing" }, 409);
    const result = await enqueueSitePreviewJob({ siteAgentId, origin: new URL(url).origin, url, force: true });
    return siteAgentJson({ job: result.job, persistence: result.persistence }, 202);
  } catch (error) {
    return siteAgentFailure(error, "site_preview_enqueue_failed");
  }
}
