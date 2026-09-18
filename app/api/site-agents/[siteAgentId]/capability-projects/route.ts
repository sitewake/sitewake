import { listCapabilityProjects } from "../../../../../db/site-agent-store";
import { submitCapabilityProposal } from "../../../../../lib/capability-center/proposal-service";
import type { CapabilityProject, JsonValue } from "../../../../../lib/site-knowledge/protocol";
import { managementAuthorized, managementMutationAuthorized, siteAgentJson, siteAgentOptions } from "../../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const { siteAgentId: encoded } = await context.params;
  const siteAgentId = decodeURIComponent(encoded || "").trim();
  if (!siteAgentId) return siteAgentJson({ error: "site_agent_id_required" }, 400);
  try {
    const search = new URL(request.url).searchParams;
    const status = search.get("status");
    const allowedStatuses = new Set(["available", "building", "awaiting-review", "needs-guidance", "degraded", "unpublished", "archived"]);
    const result = await listCapabilityProjects(siteAgentId, {
      status: status && allowedStatuses.has(status) ? status as CapabilityProject["status"] : undefined,
      excludeArchived: search.get("excludeArchived") === "1",
      duplicateCursor: search.get("duplicateCursor") || undefined,
    });
    return siteAgentJson({
      projects: result.projects,
      total: result.total,
      buildTasks: result.buildTasks,
      buildTaskPage: result.buildTaskPage,
      persistence: result.persistence,
    }, 200, { "x-sitewake-persistence": result.persistence });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    return siteAgentJson(
      { error: "capability_projects_failed", message },
      message === "capability_build_request_cursor_invalid" ? 400 : 500,
    );
  }
}

export async function POST(request: Request, context: RouteContext) {
  if (!(await managementMutationAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const { siteAgentId: encoded } = await context.params;
  const siteAgentId = decodeURIComponent(encoded || "").trim();
  if (!siteAgentId) return siteAgentJson({ error: "site_agent_id_required" }, 400);
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return siteAgentJson({ error: "invalid_json" }, 400); }
  try {
    const goal = String(body.goal || "").trim();
    const result = await submitCapabilityProposal(siteAgentId, {
      title: goal,
      description: goal,
      requestedGoal: goal,
      kind: "new",
      input: body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input as Record<string, JsonValue> : {},
      sourceEpisodeId: typeof body.sourceEpisodeId === "string" ? body.sourceEpisodeId : undefined,
    });
    return siteAgentJson(result, result.queued ? 202 : 200, { "deprecation": "true", "link": `</api/site-agents/${encodeURIComponent(siteAgentId)}/capability-center/proposals>; rel=successor-version` });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    return siteAgentJson({ error: "capability_goal_create_failed", message }, /required/.test(message) ? 400 : 500);
  }
}
