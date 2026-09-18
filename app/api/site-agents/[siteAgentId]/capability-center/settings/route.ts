import {
  getCapabilityCenterSettings,
  updateCapabilityCenterSettings,
} from "@/db/capability-center-store";
import { siteAgentExists } from "@/db/site-agent-store";
import { managementAuthorized, managementMutationAuthorized, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

async function siteId(context: RouteContext) {
  const params = await context.params;
  return decodeURIComponent(params.siteAgentId || "").trim();
}

export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const siteAgentId = await siteId(context);
  if (!siteAgentId) return siteAgentJson({ error: "site_agent_id_required" }, 400);
  if (!(await siteAgentExists(siteAgentId))) return siteAgentJson({ error: "site_agent_not_found" }, 404);
  try {
    const result = await getCapabilityCenterSettings(siteAgentId);
    return siteAgentJson(result, 200, { "x-sitewake-persistence": result.persistence });
  } catch (error) {
    return siteAgentFailure(error, "capability_center_settings_failed");
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!(await managementMutationAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const siteAgentId = await siteId(context);
  if (!siteAgentId) return siteAgentJson({ error: "site_agent_id_required" }, 400);
  if (!(await siteAgentExists(siteAgentId))) return siteAgentJson({ error: "site_agent_not_found" }, 404);
  let body: unknown;
  try { body = await request.json(); } catch { return siteAgentJson({ error: "invalid_json" }, 400); }
  try {
    const result = await updateCapabilityCenterSettings(siteAgentId, body);
    return siteAgentJson(result, 200, { "x-sitewake-persistence": result.persistence });
  } catch (error) {
    return siteAgentFailure(error, "capability_center_settings_failed");
  }
}
