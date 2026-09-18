import { getCapabilityRun } from "@/db/site-agent-store";
import { managementAuthorized, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string; runId: string }> | { siteAgentId: string; runId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  const runId = decodeURIComponent(params.runId || "").trim();
  try {
    const result = await getCapabilityRun(siteAgentId, runId);
    if (!result.run) return siteAgentJson({ error: "capability_run_not_found" }, 404);
    return siteAgentJson(result, 200, { "x-sitewake-persistence": result.persistence });
  } catch (error) {
    return siteAgentFailure(error, "capability_run_read_failed");
  }
}
