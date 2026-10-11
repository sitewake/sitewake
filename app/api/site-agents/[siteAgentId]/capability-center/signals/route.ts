import { listCapabilitySignals } from "@/db/site-agent-store";
import { managementAuthorized, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const { siteAgentId: encoded } = await context.params;
  const siteAgentId = decodeURIComponent(encoded || "").trim();
  if (!siteAgentId) return siteAgentJson({ error: "site_agent_id_required" }, 400);
  const requestedLimit = Number(new URL(request.url).searchParams.get("limit") || "100");
  try {
    const result = await listCapabilitySignals(siteAgentId, requestedLimit);
    return siteAgentJson(result, 200, { "x-sitewake-persistence": result.persistence });
  } catch (error) {
    return siteAgentFailure(error, "capability_signals_failed");
  }
}
