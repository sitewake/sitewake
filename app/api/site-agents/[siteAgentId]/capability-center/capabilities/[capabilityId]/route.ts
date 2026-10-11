import { actOnCapability, getCapabilityDetail } from "@/db/capability-center-store";
import { managementAuthorized, managementMutationAuthorized, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string; capabilityId: string }> | { siteAgentId: string; capabilityId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  const capabilityId = decodeURIComponent(params.capabilityId || "").trim();
  if (!siteAgentId || !capabilityId) return siteAgentJson({ error: "capability_id_required" }, 400);
  try {
    const detail = await getCapabilityDetail(siteAgentId, capabilityId);
    return detail ? siteAgentJson(detail) : siteAgentJson({ error: "capability_not_found" }, 404);
  } catch (error) {
    return siteAgentFailure(error, "capability_detail_failed");
  }
}

/** Logical, irreversible deletion. Historical versions/tasks remain auditable. */
export async function DELETE(request: Request, context: RouteContext) {
  if (!(await managementMutationAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  const capabilityId = decodeURIComponent(params.capabilityId || "").trim();
  if (!siteAgentId || !capabilityId) return siteAgentJson({ error: "capability_id_required" }, 400);
  try { return siteAgentJson({ capability: await actOnCapability(siteAgentId, capabilityId, "delete") }); }
  catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    return siteAgentJson({ error: "capability_delete_failed", message }, message.includes("not_found") ? 404 : message.includes("deleted") || message.includes("conflict") || message.includes("active_task") ? 409 : 500);
  }
}

