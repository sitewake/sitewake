import { getTask, respondTaskInteraction, sanitizeTaskForClient } from "@/db/capability-center-v2-store";
import { RuntimeLauncher, terminateRunnerProcess } from "@/runner/capability-v2/runtime-launcher";
import { capabilityJson, capabilityOptions, capabilityWriteAuthorized, siteIdFromRequest, errorResponse } from "../../../../../http";

type Context = { params: Promise<{ taskId: string; interactionId: string }> | { taskId: string; interactionId: string } };
export async function OPTIONS() { return capabilityOptions(); }
export async function POST(request: Request, context: Context) {
  let body: Record<string, unknown>; try { body = await request.json() as Record<string, unknown>; } catch { return capabilityJson({ error: "invalid_json" }, 400); }
  const siteId = siteIdFromRequest(request, body); const params = await context.params; if (!siteId) return capabilityJson({ error: "site_id_required" }, 400);
  if (!(await capabilityWriteAuthorized(request))) return capabilityJson({ error: "unauthorized" }, 401);
  try {
    const before = await getTask(siteId, params.taskId, true);
    const result = await respondTaskInteraction(siteId, params.taskId, params.interactionId, body.values && typeof body.values === "object" ? body.values as Record<string, unknown> : {});
    if (result.task.status === "Pending") {
      if (before?.runnerId) await terminateRunnerProcess(siteId, before.runnerId);
      if (process.env.CAPABILITY_V2_AUTO_DISPATCH !== "0") void new RuntimeLauncher().dispatchOne(siteId, result.task.id).catch(() => undefined);
    }
    return capabilityJson({ ...result, task: sanitizeTaskForClient(result.task) });
  } catch (error) { return errorResponse(error, "capability_interaction_failed"); }
}
