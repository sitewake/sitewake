import { listEffectRuns } from "@/db/effect-store";
import { siteAgentAccess } from "@/db/site-agent-store";
import { managementAuthorized, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const { siteAgentId: rawId } = await context.params;
  const siteAgentId = decodeURIComponent(rawId || "").trim();
  if (!siteAgentId) return siteAgentJson({ error: "site_agent_id_required" }, 400);
  const access = await siteAgentAccess(siteAgentId);
  if (access === "not_found") return siteAgentJson({ error: "site_agent_not_found" }, 404);
  if (access === "forbidden") return siteAgentJson({ error: "site_agent_forbidden" }, 403);
  const params = new URL(request.url).searchParams;
  try {
    const result = await listEffectRuns(siteAgentId, {
      query: params.get("query") || undefined,
      outcome: params.get("status") || undefined,
      cursor: params.get("cursor") || undefined,
      limit: Number(params.get("limit") || 30),
    });
    return siteAgentJson(result);
  } catch (error) {
    return siteAgentFailure(error, "session_history_failed");
  }
}
