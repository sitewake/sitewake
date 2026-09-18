import { getEffectRunDetail } from "@/db/effect-store";
import { siteAgentAccess } from "@/db/site-agent-store";
import { managementAuthorized, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string; runId: string }> | { siteAgentId: string; runId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  const runId = decodeURIComponent(params.runId || "").trim();
  if (!siteAgentId || !runId) return siteAgentJson({ error: "session_history_id_required" }, 400);
  const access = await siteAgentAccess(siteAgentId);
  if (access === "not_found") return siteAgentJson({ error: "site_agent_not_found" }, 404);
  if (access === "forbidden") return siteAgentJson({ error: "site_agent_forbidden" }, 403);
  try {
    const detail = await getEffectRunDetail(siteAgentId, runId);
    if (!detail) return siteAgentJson({ error: "session_history_not_found" }, 404);
    return siteAgentJson({
      detail: {
        fact: detail.fact,
        conversation: detail.conversation.filter((turn) => turn.role === "user" || turn.role === "assistant"),
        activityTimeline: detail.activityTimeline.filter((item) => item.kind !== "reasoning" && item.kind !== "capability-search"),
        replayChunks: detail.replayChunks,
      },
    });
  } catch (error) {
    return siteAgentFailure(error, "session_history_detail_failed");
  }
}
