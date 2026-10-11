import { getCapabilityTaskDetail } from "@/db/capability-center-store";
import { managementAuthorized, siteAgentJson, siteAgentOptions } from "../../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string; taskId: string }> | { siteAgentId: string; taskId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  const taskId = decodeURIComponent(params.taskId || "").trim();
  const detail = siteAgentId && taskId ? await getCapabilityTaskDetail(siteAgentId, taskId) : undefined;
  return detail ? siteAgentJson(detail) : siteAgentJson({ error: "capability_task_not_found" }, 404);
}

export async function PATCH(request: Request, context: RouteContext) {
  void request;
  void context;
  return siteAgentJson({ error: "capability_task_runner_endpoint_required" }, 405, { allow: "GET" });
}

