import { listEffectSubmissions } from "@/db/effect-store";
import { siteAgentExists } from "@/db/site-agent-store";
import {
  managementAuthorized,
  siteAgentJson,
  siteAgentOptions,
} from "../../../http";

type RouteContext = {
  params:
    | Promise<{ siteAgentId: string }>
    | { siteAgentId: string };
};

export async function OPTIONS() {
  return siteAgentOptions();
}

export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request)))
    return siteAgentJson({ error: "unauthorized" }, 401);
  const { siteAgentId: rawId } = await context.params;
  const siteAgentId = decodeURIComponent(rawId || "").trim();
  if (!siteAgentId) return siteAgentJson({ error: "site_agent_id_required" }, 400);
  if (!(await siteAgentExists(siteAgentId)))
    return siteAgentJson({ error: "site_agent_not_found" }, 404);
  const query = new URL(request.url).searchParams;
  try {
    const records = await listEffectSubmissions(siteAgentId, {
      from: query.get("from") || undefined,
      to: query.get("to") || undefined,
      goalStatus: query.get("goalStatus") || undefined,
      issue: query.get("issue") || undefined,
      improvement: query.get("improvement") || undefined,
      status: query.get("status") || undefined,
      actorKey: query.get("actorKey") || undefined,
      query: query.get("query") || undefined,
      cursor: query.get("cursor") || undefined,
      limit: Number(query.get("limit") || 40),
    });
    return siteAgentJson(records);
  } catch (error) {
    return siteAgentJson(
      {
        error: "effect_records_failed",
        message: error instanceof Error ? error.message : "unknown",
      },
      500,
    );
  }
}
