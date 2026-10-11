import { listCapabilityProposals } from "@/db/capability-center-store";
import { submitCapabilityProposal } from "@/lib/capability-center/proposal-service";
import type { CapabilityProposalKind, CapabilityProposalStatus } from "@/lib/capability-center/model";
import type { JsonValue } from "@/lib/site-knowledge/protocol";
import { managementAuthorized, managementMutationAuthorized, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const { siteAgentId: encoded } = await context.params;
  const siteAgentId = decodeURIComponent(encoded || "").trim();
  if (!siteAgentId) return siteAgentJson({ error: "site_agent_id_required" }, 400);
  const search = new URL(request.url).searchParams;
  const rawStatus = search.get("status");
  const statuses = new Set<CapabilityProposalStatus>(["pending", "analyzing", "accepted", "duplicate", "blocked", "rejected", "failed"]);
  try {
    const result = await listCapabilityProposals(siteAgentId, {
      status: rawStatus && statuses.has(rawStatus as CapabilityProposalStatus) ? rawStatus as CapabilityProposalStatus : undefined,
      includeArchived: search.get("includeArchived") === "1",
      includeDeleted: search.get("includeDeleted") === "1",
    });
    return siteAgentJson(result, 200, { "x-sitewake-persistence": result.persistence });
  } catch (error) { return siteAgentFailure(error, "capability_proposals_failed"); }
}

export async function POST(request: Request, context: RouteContext) {
  if (!(await managementMutationAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const { siteAgentId: encoded } = await context.params;
  const siteAgentId = decodeURIComponent(encoded || "").trim();
  let body: {
    kind?: CapabilityProposalKind; title?: string; description?: string; requestedGoal?: string;
    input?: Record<string, JsonValue>; capabilityId?: string; sourceEpisodeId?: string;
  };
  try { body = await request.json() as typeof body; } catch { return siteAgentJson({ error: "invalid_json" }, 400); }
  if (!siteAgentId || !body.requestedGoal?.trim()) return siteAgentJson({ error: "capability_proposal_goal_required" }, 400);
  try {
    const result = await submitCapabilityProposal(siteAgentId, {
      ...body, title: body.title?.trim() || body.requestedGoal.trim(), requestedGoal: body.requestedGoal,
    });
    return siteAgentJson(result, result.queued ? 202 : 200, { "x-sitewake-persistence": result.persistence });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    return siteAgentJson({ error: "capability_proposal_create_failed", message }, message.includes("required") || message.includes("invalid") ? 400 : 500);
  }
}

