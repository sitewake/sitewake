import { actOnCapability } from "@/db/capability-center-store";
import { managementMutationAuthorized, siteAgentJson, siteAgentOptions } from "../../../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string; capabilityId: string }> | { siteAgentId: string; capabilityId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

export async function POST(request: Request, context: RouteContext) {
  if (!(await managementMutationAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  const capabilityId = decodeURIComponent(params.capabilityId || "").trim();
  let body: { action?: "unpublish" | "relist" };
  try { body = await request.json() as typeof body; } catch { return siteAgentJson({ error: "invalid_json" }, 400); }
  if (!siteAgentId || !capabilityId || !body.action || !new Set(["unpublish", "relist"]).has(body.action)) return siteAgentJson({ error: "capability_action_invalid" }, 400);
  try { return siteAgentJson({ capability: await actOnCapability(siteAgentId, capabilityId, body.action) }); }
  catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    return siteAgentJson({ error: "capability_action_failed", message }, message.includes("not_found") ? 404 : message.includes("not_") || message.includes("deleted") || message.includes("conflict") ? 409 : 500);
  }
}

