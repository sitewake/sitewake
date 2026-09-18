import { getCapabilityProjectDetail } from "../../../../../../db/site-agent-store";
import { managementAuthorized, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string; projectId: string }> | { siteAgentId: string; projectId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  const projectId = decodeURIComponent(params.projectId || "").trim();
  if (!siteAgentId || !projectId) return siteAgentJson({ error: "capability_project_required" }, 400);
  try {
    const result = await getCapabilityProjectDetail(siteAgentId, projectId);
    if (!result.detail) return siteAgentJson({ error: "capability_project_not_found" }, 404);
    return siteAgentJson({ ...result.detail, persistence: result.persistence }, 200, { "x-sitewake-persistence": result.persistence });
  } catch (error) {
    return siteAgentFailure(error, "capability_project_failed");
  }
}
