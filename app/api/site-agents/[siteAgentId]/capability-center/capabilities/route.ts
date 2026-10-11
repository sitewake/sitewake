import { listCapabilities } from "@/db/capability-center-store";
import type { CapabilityStatus } from "@/lib/capability-center/model";
import { managementAuthorized, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const { siteAgentId: encoded } = await context.params;
  const siteAgentId = decodeURIComponent(encoded || "").trim();
  if (!siteAgentId) return siteAgentJson({ error: "site_agent_id_required" }, 400);
  const search = new URL(request.url).searchParams;
  const rawStatus = search.get("status");
  const statuses = new Set<CapabilityStatus>(["draft", "draft_failed", "active", "degraded", "unpublished", "deleted"]);
  try {
    const result = await listCapabilities(siteAgentId, {
      status: rawStatus && statuses.has(rawStatus as CapabilityStatus) ? rawStatus as CapabilityStatus : undefined,
      includeDeleted: search.get("includeDeleted") === "1",
    });
    return siteAgentJson(result, 200, { "x-sitewake-persistence": result.persistence });
  } catch (error) {
    return siteAgentFailure(error, "capabilities_failed");
  }
}

