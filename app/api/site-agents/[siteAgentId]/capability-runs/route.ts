import { listCapabilityRuns } from "@/db/site-agent-store";
import { managementAuthorized, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const { siteAgentId } = await context.params;
  const url = new URL(request.url);
  const capabilityId = url.searchParams.get("capabilityId") || undefined;
  const limit = Number(url.searchParams.get("limit") || 12);
  try {
    return siteAgentJson(await listCapabilityRuns(decodeURIComponent(siteAgentId), { capabilityId, limit }));
  } catch (error) {
    return siteAgentFailure(error, "capability_runs_failed");
  }
}
