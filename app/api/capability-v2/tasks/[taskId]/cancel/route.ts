import { cancelTask, getTask } from "@/db/capability-center-v2-store";
import { terminateRunnerProcess } from "@/runner/capability-v2/runtime-launcher";
import { capabilityJson, capabilityOptions, capabilityWriteAuthorized, siteIdFromRequest, errorResponse } from "../../../http";

type Context = { params: Promise<{ taskId: string }> | { taskId: string } };

async function taskId(context: Context) {
  const params = await context.params;
  return decodeURIComponent(params.taskId || "");
}

export async function OPTIONS() { return capabilityOptions(); }

export async function POST(request: Request, context: Context) {
  const siteId = siteIdFromRequest(request);
  const id = await taskId(context);
  if (!siteId || !id) return capabilityJson({ error: "site_id_and_task_id_required" }, 400);
  if (!(await capabilityWriteAuthorized(request))) return capabilityJson({ error: "unauthorized" }, 401);
  try {
    const before = await getTask(siteId, id, true);
    const result = await cancelTask(siteId, id);
    if (before?.runnerId) await terminateRunnerProcess(siteId, before.runnerId);
    return capabilityJson(result);
  } catch (error) {
    return errorResponse(error, "capability_task_cancel_failed");
  }
}
