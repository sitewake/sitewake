import { createTaskLaunch } from "../../../../../db/site-agent-store";
import type { JsonValue, TaskLaunchMode } from "../../../../../lib/site-knowledge/protocol";
import { managementMutationAuthorized, siteAgentJson, siteAgentNotFoundError, siteAgentOptions } from "../../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

export async function POST(request: Request, context: RouteContext) {
  if (!(await managementMutationAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const { siteAgentId: encoded } = await context.params;
  const siteAgentId = decodeURIComponent(encoded || "").trim();
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return siteAgentJson({ error: "invalid_json" }, 400); }
  const mode: TaskLaunchMode = body.mode === "demonstrate" ? "demonstrate" : "run";
  try {
    const result = await createTaskLaunch({ siteAgentId, projectId: typeof body.projectId === "string" ? body.projectId : undefined, capabilityId: typeof body.capabilityId === "string" ? body.capabilityId : undefined, goal: String(body.goal || ""), input: body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input as Record<string, JsonValue> : {}, mode });
    return siteAgentJson(result, 201);
  } catch (error) {
    if (siteAgentNotFoundError(error)) return siteAgentJson({ error: "site_agent_not_found" }, 404);
    const message = error instanceof Error ? error.message : "unknown";
    return siteAgentJson({ error: "task_launch_create_failed", message }, message.includes("required") || message.includes("not_found") ? 400 : 500);
  }
}
