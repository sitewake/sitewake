import { adoptInstalledSiteAgentId } from "../../../../../../db/site-agent-adoption";
import { siteAgentAccess, siteAgentExists } from "../../../../../../db/site-agent-store";
import { classifySiteAgentError } from "../../../../../../lib/site-knowledge/errors";
import { managementMutationAuthorized, persistenceHeaders, siteAgentJson, siteAgentOptions } from "../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };
export async function OPTIONS() { return siteAgentOptions(); }

/**
 * Adopt the site id on the page: recreate this (empty) site as body.siteAgentId and
 * delete the current one. Only ids the runner observed at the site's registered address
 * are accepted; `adoptInstalledSiteAgentId` enforces the preconditions.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!(await managementMutationAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  if (!siteAgentId) return siteAgentJson({ error: "site_agent_id_required" }, 400);
  if (!(await siteAgentExists(siteAgentId))) return siteAgentJson({ error: "site_agent_not_found" }, 404);
  const access = await siteAgentAccess(siteAgentId);
  if (access === "not_found") return siteAgentJson({ error: "site_agent_not_found" }, 404);
  if (access === "forbidden") return siteAgentJson({ error: "site_agent_forbidden" }, 403);
  let body: { siteAgentId?: unknown };
  try { body = await request.json() as { siteAgentId?: unknown }; } catch { return siteAgentJson({ error: "invalid_json" }, 400); }
  if (typeof body.siteAgentId !== "string" || !body.siteAgentId.trim()) return siteAgentJson({ error: "site_agent_install_id_required" }, 400);
  try {
    const result = await adoptInstalledSiteAgentId(siteAgentId, body.siteAgentId);
    return siteAgentJson(result, 200, persistenceHeaders(result.persistence));
  } catch (error) {
    const classified = classifySiteAgentError(error, "site_agent_lookup_failed", "site_agent_lookup");
    return siteAgentJson({ error: classified.code, message: classified.message, retryable: classified.retryable }, classified.status);
  }
}
