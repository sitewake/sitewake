import { listCapabilities } from "@/db/capability-center-v2-store";
import { capabilityAgentAuthorized, capabilityJson, capabilityOptions, siteIdFromRequest, errorResponse } from "../http";

export async function OPTIONS() { return capabilityOptions(); }

/**
 * Lightweight catalog for the embedded Agent's empty-state shortcuts.
 * Programs and search text stay server-side; the browser receives only the
 * fields needed to name a capability and collect its declared inputs.
 */
export async function GET(request: Request) {
  const siteId = siteIdFromRequest(request);
  if (!siteId) return capabilityJson({ error: "site_id_required" }, 400);
  if (!(await capabilityAgentAuthorized(request, siteId))) return capabilityJson({ error: "unauthorized" }, 401);
  const requestedLimit = Number(new URL(request.url).searchParams.get("limit") || 8);
  const limit = Math.min(20, Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 8));
  try {
    const { capabilities } = await listCapabilities(siteId, { status: "Active", includeDeleted: false });
    const items = capabilities.slice(0, limit).map((item) => ({
      capabilityId: item.id,
      name: item.name,
      description: item.description,
      aliases: item.aliases,
      contract: item.contract,
      status: item.status,
    }));
    return capabilityJson({ items });
  } catch (error) { return errorResponse(error, "capability_catalog_failed"); }
}
