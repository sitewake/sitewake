import { getEffectSubmissionDetail } from "@/db/effect-store";
import { siteAgentExists } from "@/db/site-agent-store";
import {
  managementAuthorized,
  siteAgentJson,
  siteAgentOptions,
} from "../../../../http";

type RouteContext = {
  params:
    | Promise<{ siteAgentId: string; runId: string }>
    | { siteAgentId: string; runId: string };
};

export async function OPTIONS() {
  return siteAgentOptions();
}

export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request)))
    return siteAgentJson({ error: "unauthorized" }, 401);
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  const runId = decodeURIComponent(params.runId || "").trim();
  if (!siteAgentId || !runId)
    return siteAgentJson({ error: "effect_record_id_required" }, 400);
  if (!(await siteAgentExists(siteAgentId)))
    return siteAgentJson({ error: "site_agent_not_found" }, 404);
  try {
    const detail = await getEffectSubmissionDetail(siteAgentId, runId);
    return detail
      ? siteAgentJson({ detail })
      : siteAgentJson({ error: "effect_record_not_found" }, 404);
  } catch (error) {
    return siteAgentJson(
      {
        error: "effect_record_failed",
        message: error instanceof Error ? error.message : "unknown",
      },
      500,
    );
  }
}
