import { deleteTask, getTask, patchPendingTask, sanitizeTaskForClient } from "@/db/capability-center-v2-store";
import { capabilityJson, capabilityOptions, capabilityReadAuthorized, capabilityWriteAuthorized, siteIdFromRequest, errorResponse } from "../../http";

type Context = { params: Promise<{ taskId: string }> | { taskId: string } };
async function taskId(context: Context) { const params = await context.params; return decodeURIComponent(params.taskId || ""); }

export async function OPTIONS() { return capabilityOptions(); }

export async function GET(request: Request, context: Context) {
  const siteId = siteIdFromRequest(request); const id = await taskId(context); if (!siteId || !id) return capabilityJson({ error: "site_id_and_task_id_required" }, 400);
  if (!(await capabilityReadAuthorized(request))) return capabilityJson({ error: "unauthorized" }, 401);
  try { const task = await getTask(siteId, id, true); return task ? capabilityJson({ task: sanitizeTaskForClient(task) }) : capabilityJson({ error: "task_not_found" }, 404); } catch (error) { return errorResponse(error, "capability_task_failed"); }
}

export async function PATCH(request: Request, context: Context) {
  if (!(await capabilityWriteAuthorized(request))) return capabilityJson({ error: "unauthorized" }, 401);
  let body: Record<string, unknown>; try { body = await request.json() as Record<string, unknown>; } catch { return capabilityJson({ error: "invalid_json" }, 400); }
  const siteId = siteIdFromRequest(request, body); const id = await taskId(context); if (!siteId || !id) return capabilityJson({ error: "site_id_and_task_id_required" }, 400);
  try { return capabilityJson(await patchPendingTask(siteId, id, { goal: typeof body.goal === "string" ? body.goal : undefined, guidance: typeof body.guidance === "string" ? body.guidance : undefined, input: body.input as never })); } catch (error) { return errorResponse(error, "capability_task_patch_failed"); }
}

export async function DELETE(request: Request, context: Context) {
  if (!(await capabilityWriteAuthorized(request))) return capabilityJson({ error: "unauthorized" }, 401);
  const siteId = siteIdFromRequest(request); const id = await taskId(context); if (!siteId || !id) return capabilityJson({ error: "site_id_and_task_id_required" }, 400);
  try { return capabilityJson(await deleteTask(siteId, id)); } catch (error) { return errorResponse(error, "capability_task_delete_failed"); }
}
