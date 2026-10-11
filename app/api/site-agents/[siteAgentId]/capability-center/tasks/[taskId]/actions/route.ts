import { actOnCapabilityTask } from "@/db/capability-center-store";
import { managementMutationAuthorized, siteAgentJson, siteAgentOptions } from "../../../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string; taskId: string }> | { siteAgentId: string; taskId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

export async function POST(request: Request, context: RouteContext) {
  if (!(await managementMutationAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  const taskId = decodeURIComponent(params.taskId || "").trim();
  let body: {
    action?: "approve" | "reject" | "retry" | "rebuild" | "revalidate" | "cancel" | "archive";
    feedback?: string;
  };
  try { body = await request.json() as typeof body; } catch { return siteAgentJson({ error: "invalid_json" }, 400); }
  if (!siteAgentId || !taskId || !body.action) return siteAgentJson({ error: "capability_task_action_required" }, 400);
  if (!["approve", "reject", "retry", "rebuild", "revalidate", "cancel", "archive"].includes(body.action)) {
    return siteAgentJson({ error: "capability_task_action_invalid" }, 400);
  }
  try {
    return siteAgentJson({ task: await actOnCapabilityTask(siteAgentId, taskId, body.action, { feedback: body.feedback }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    const status = message.includes("not_found") ? 404 : message.includes("required") || message.includes("invalid") ? 400 : message.includes("conflict") || message.includes("not_") || message.includes("deleted") || message.includes("already_") ? 409 : 500;
    return siteAgentJson({ error: "capability_task_action_failed", message }, status);
  }
}

