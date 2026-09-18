import { getCapability, listCapabilityVersions } from "@/db/capability-center-store";
import { managementAuthorized, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string; capabilityId: string }> | { siteAgentId: string; capabilityId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  const capabilityId = decodeURIComponent(params.capabilityId || "").trim();
  if (!siteAgentId || !capabilityId) return siteAgentJson({ error: "capability_id_required" }, 400);
  try {
    if (!(await getCapability(siteAgentId, capabilityId, { includeDeleted: true }))) return siteAgentJson({ error: "capability_not_found" }, 404);
    return siteAgentJson({ versions: await listCapabilityVersions(siteAgentId, capabilityId) });
  } catch (error) { return siteAgentFailure(error, "capability_versions_failed"); }
}

