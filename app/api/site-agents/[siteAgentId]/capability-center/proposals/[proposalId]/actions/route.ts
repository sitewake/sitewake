import { forceCapabilityProposalTask } from "@/lib/capability-center/proposal-service";
import { managementMutationAuthorized, siteAgentJson, siteAgentOptions } from "../../../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string; proposalId: string }> | { siteAgentId: string; proposalId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

export async function POST(request: Request, context: RouteContext) {
  if (!(await managementMutationAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  const proposalId = decodeURIComponent(params.proposalId || "").trim();
  let body: { action?: "force-create-task"; reason?: string };
  try { body = await request.json() as typeof body; } catch { return siteAgentJson({ error: "invalid_json" }, 400); }
  if (!siteAgentId || !proposalId || body.action !== "force-create-task") {
    return siteAgentJson({ error: "capability_proposal_action_invalid" }, 400);
  }
  try {
    return siteAgentJson(await forceCapabilityProposalTask(siteAgentId, proposalId, { reason: body.reason }), 202);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    const status = message.includes("not_found") ? 404 : message.includes("not_blocked") || message.includes("conflict") || message.includes("invalid") || message.includes("missing") ? 409 : 500;
    return siteAgentJson({ error: "capability_proposal_force_failed", message }, status);
  }
}
