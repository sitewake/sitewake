import { getSiteAgentOverview, siteAgentAccess, siteAgentExists, updateSiteAgent } from "../../../../db/site-agent-store";
import { deleteSiteAgent } from "../../../../db/site-agent-deletion";
import { classifySiteAgentError, SiteAgentDataError } from "../../../../lib/site-knowledge/errors";
import { publicModelStatus } from "@/lib/model-config";
import { managementAuthorized, managementMutationAuthorized, persistenceHeaders, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

function decodeSiteAgentId(value: string | undefined) {
  try {
    return decodeURIComponent(value || "").trim();
  } catch (error) {
    throw new SiteAgentDataError("site_agent_id_invalid", "Site Agent id is not valid URL encoding.", "site_agent_lookup", { status: 400, retryable: false, cause: error });
  }
}

function failureResponse(
  error: unknown,
  fallbackCode: "site_agent_lookup_failed" | "site_agent_overview_failed",
  phase: "site_agent_lookup" | "site_agent_overview",
  siteAgentId: string,
) {
  const classified = classifySiteAgentError(error, fallbackCode, phase);
  console.error("site_agent_request_failed", {
    siteAgentId,
    code: classified.code,
    phase: classified.phase,
    status: classified.status,
    message: error instanceof Error ? error.message : String(error),
  });
  return siteAgentJson({
    error: classified.code,
    message: classified.message,
    retryable: classified.retryable,
    phase: classified.phase,
  }, classified.status);
}

export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  let siteAgentId = "";
  try {
    const params = await context.params;
    siteAgentId = decodeSiteAgentId(params.siteAgentId);
    if (!siteAgentId) return siteAgentJson({ error: "site_agent_id_required" }, 400);
    if (!(await siteAgentExists(siteAgentId))) return siteAgentJson({ error: "site_agent_not_found" }, 404);
    const access = await siteAgentAccess(siteAgentId);
    if (access === "not_found") return siteAgentJson({ error: "site_agent_not_found" }, 404);
    if (access === "forbidden") return siteAgentJson({ error: "site_agent_forbidden" }, 403);
    const result = await getSiteAgentOverview(siteAgentId);
    return siteAgentJson({ ...result.overview, persistence: result.persistence, modelConfigured: publicModelStatus("execution").configured }, 200, persistenceHeaders(result.persistence));
  } catch (error) {
    return failureResponse(error, "site_agent_overview_failed", "site_agent_overview", siteAgentId);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!(await managementMutationAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  let siteAgentId = "";
  try {
    const params = await context.params;
    siteAgentId = decodeSiteAgentId(params.siteAgentId);
    if (!siteAgentId) return siteAgentJson({ error: "site_agent_id_required" }, 400);
    if (!(await siteAgentExists(siteAgentId))) return siteAgentJson({ error: "site_agent_not_found" }, 404);
    const access = await siteAgentAccess(siteAgentId);
    if (access === "not_found") return siteAgentJson({ error: "site_agent_not_found" }, 404);
    if (access === "forbidden") return siteAgentJson({ error: "site_agent_forbidden" }, 403);
  } catch (error) {
    return failureResponse(error, "site_agent_lookup_failed", "site_agent_lookup", siteAgentId);
  }
  let body: { agentConfig?: unknown };
  try { body = await request.json() as { agentConfig?: unknown }; } catch { return siteAgentJson({ error: "invalid_json" }, 400); }
  if (!body || !Object.prototype.hasOwnProperty.call(body, "agentConfig")) return siteAgentJson({ error: "agent_config_required" }, 400);
  try {
    const result = await updateSiteAgent(siteAgentId, { agentConfig: body.agentConfig as never });
    return siteAgentJson({ release: result.release, persistence: result.persistence }, 200, persistenceHeaders(result.persistence));
  } catch (error) {
    return siteAgentFailure(error, "site_agent_update_failed");
  }
}

/**
 * Deletes a site with all its data. Hard delete, immediate, irreversible; same gate as
 * PATCH. If object storage cannot be cleared, returns a retryable 5xx and the site stays
 * visible; the database side is one transaction, see `db/site-agent-deletion.ts`.
 */
export async function DELETE(request: Request, context: RouteContext) {
  if (!(await managementMutationAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  let siteAgentId = "";
  try {
    const params = await context.params;
    siteAgentId = decodeSiteAgentId(params.siteAgentId);
    if (!siteAgentId) return siteAgentJson({ error: "site_agent_id_required" }, 400);
    if (!(await siteAgentExists(siteAgentId))) return siteAgentJson({ error: "site_agent_not_found" }, 404);
    const access = await siteAgentAccess(siteAgentId);
    if (access === "not_found") return siteAgentJson({ error: "site_agent_not_found" }, 404);
    if (access === "forbidden") return siteAgentJson({ error: "site_agent_forbidden" }, 403);
  } catch (error) {
    return failureResponse(error, "site_agent_lookup_failed", "site_agent_lookup", siteAgentId);
  }
  try {
    const result = await deleteSiteAgent(siteAgentId);
    return siteAgentJson({ deleted: true, persistence: result.persistence }, 200, persistenceHeaders(result.persistence));
  } catch (error) {
    return failureResponse(error, "site_agent_lookup_failed", "site_agent_lookup", siteAgentId);
  }
}
