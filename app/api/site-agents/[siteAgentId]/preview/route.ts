import { enqueueSitePreviewJob, getSiteAgentOverview, getSitePreview, siteAgentAccess } from "@/db/site-agent-store";
import { resolveSiteAddress } from "@/lib/site-knowledge/site-address";
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
  // `try-install` rehearses the install before anyone pastes anything: the page
  // is opened with the snippet in it and the browser's own refusals are the
  // verdict. Without it the page is rendered as it is.
  let rehearsal: { mode?: "try-install"; installSnippet?: string } = {};
  try {
    const body = await request.json() as { mode?: unknown; installSnippet?: unknown };
    if (body?.mode === "try-install" && typeof body.installSnippet === "string" && body.installSnippet.trim()) {
      rehearsal = { mode: "try-install", installSnippet: body.installSnippet.trim().slice(0, 2_000) };
    }
  } catch {
    // No body is the ordinary case: a live render.
  }
  try {
    const { overview } = await getSiteAgentOverview(siteAgentId);
    // A preview represents the site, not the most recently visited detail page.
    // The release entry URL is the durable homepage choice; connection.url is
    // transient execution state and remains only as a fallback for legacy sites.
    const registered = overview.profile.entryUrl || overview.connection?.origin || overview.connection?.url;
    if (!registered) return siteAgentJson({ error: "site_preview_url_missing" }, 409);
    // Sites registered at a bare domain that redirects to www were checked at
    // an address the pinned browser refuses to leave, and the check could only
    // report that the site could not be opened. The preview runs where the
    // site actually serves; the registration is corrected when it is next saved.
    const url = await resolveSiteAddress(registered);
    const result = await enqueueSitePreviewJob({ siteAgentId, origin: new URL(url).origin, url, force: true, ...rehearsal });
    return siteAgentJson({ job: result.job, persistence: result.persistence }, 202);
  } catch (error) {
    return siteAgentFailure(error, "site_preview_enqueue_failed");
  }
}
