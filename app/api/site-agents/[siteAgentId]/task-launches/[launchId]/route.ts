import { getTaskLaunch, updateTaskLaunch } from "../../../../../../db/site-agent-store";
import type { JsonValue, TaskLaunch } from "../../../../../../lib/site-knowledge/protocol";
import { boundedJsonErrorStatus, readBoundedJson } from "../../../../../../lib/http/bounded-json";
import { managementAuthorized, siteAgentJson, siteAgentOptions } from "../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string; launchId: string }> | { siteAgentId: string; launchId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const params = await context.params;
  const result = await getTaskLaunch(decodeURIComponent(params.siteAgentId || ""), decodeURIComponent(params.launchId || ""));
  if (!result.launch) return siteAgentJson({ error: "task_launch_not_found" }, 404);
  return siteAgentJson(result);
}

function taskLaunchUpdateError(error: unknown) {
  const code = error instanceof Error
    ? error.message.split(":", 1)[0]
    : "task_launch_update_failed";
  if (code === "task_launch_status_invalid"
    || code === "task_launch_claim_key_invalid"
    || code === "task_launch_origin_invalid"
    || code === "task_launch_execution_owner_invalid"
    || code === "task_launch_result_invalid"
    || code === "task_launch_nonterminal_result_rejected") {
    return { code, status: 400 };
  }
  if (code === "task_launch_update_too_large") {
    return { code, status: 413 };
  }
  if (code === "task_launch_update_rejected"
    || code === "task_launch_origin_rejected"
    || code === "task_launch_result_url_rejected") {
    return { code, status: 403 };
  }
  if (code === "task_launch_already_terminal"
    || code === "task_launch_lease_expired"
    || code === "task_launch_execution_owner_rejected"
    || code === "task_launch_execution_fence_rejected"
    || code === "task_launch_update_conflict"
    || code === "task_launch_capability_run_not_found"
    || code === "task_launch_capability_run_conflict") {
    return { code, status: 409 };
  }
  return { code: "task_launch_update_failed", status: 500 };
}

export async function PATCH(request: Request, context: RouteContext) {
  const params = await context.params;
  const origin = request.headers.get("origin")?.trim();
  if (!origin || origin.length > 2_048) return siteAgentJson({ error: "task_launch_origin_required" }, 403);
  try {
    new URL(origin);
  } catch {
    return siteAgentJson({ error: "task_launch_origin_invalid" }, 400);
  }
  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson(request, 256 * 1024);
  } catch (error) {
    const status = boundedJsonErrorStatus(error) || 400;
    return siteAgentJson(
      { error: status === 413 ? "task_launch_update_too_large" : "invalid_json" },
      status,
    );
  }
  try {
    const result = await updateTaskLaunch(decodeURIComponent(params.siteAgentId || ""), decodeURIComponent(params.launchId || ""), {
      claimKey: String(body.claimKey || ""), origin, status: body.status as TaskLaunch["status"], taskSessionId: typeof body.taskSessionId === "string" ? body.taskSessionId : undefined,
      executionOwnerId: typeof body.executionOwnerId === "string" ? body.executionOwnerId : "",
      executionFence: Number(body.executionFence),
      previousExecutionOwnerId: typeof body.previousExecutionOwnerId === "string"
        ? body.previousExecutionOwnerId
        : undefined,
      outcome: body.outcome as TaskLaunch["outcome"], output: body.output && typeof body.output === "object" && !Array.isArray(body.output) ? body.output as Record<string, JsonValue> : undefined,
      resultUrl: typeof body.resultUrl === "string" ? body.resultUrl : undefined, error: body.error as TaskLaunch["error"],
    });
    return siteAgentJson(result);
  } catch (error) {
    const failure = taskLaunchUpdateError(error);
    return siteAgentJson({ error: failure.code }, failure.status);
  }
}
