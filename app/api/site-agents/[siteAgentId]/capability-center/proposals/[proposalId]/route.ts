import { archiveCapabilityProposal } from "@/db/capability-center-store";
import { managementMutationAuthorized, siteAgentJson, siteAgentOptions } from "../../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string; proposalId: string }> | { siteAgentId: string; proposalId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

async function mutate(request: Request, context: RouteContext, deleted: boolean) {
  if (!(await managementMutationAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  const proposalId = decodeURIComponent(params.proposalId || "").trim();
  if (!siteAgentId || !proposalId) return siteAgentJson({ error: "capability_proposal_id_required" }, 400);
  try { return siteAgentJson({ proposal: await archiveCapabilityProposal(siteAgentId, proposalId, { deleted }) }); }
  catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    return siteAgentJson({ error: deleted ? "capability_proposal_delete_failed" : "capability_proposal_archive_failed", message }, message.includes("not_found") ? 404 : 500);
  }
}

/** Logical deletion is especially useful for acknowledged duplicate proposals. */
export async function DELETE(request: Request, context: RouteContext) { return mutate(request, context, true); }
export async function PATCH(request: Request, context: RouteContext) { return mutate(request, context, false); }

