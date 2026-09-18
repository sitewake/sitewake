import { abandonIdempotentRequest, beginIdempotentRequest, CapabilityCenterV2Error, completeIdempotentRequest, createCapabilityTask, listTasks, sanitizeTaskForClient } from "@/db/capability-center-v2-store";
import type { CapabilityTaskStatus, CapabilityTaskType } from "@/lib/capability-center-v2/model";
import { assertCapabilityStartUrl, capabilityJson, capabilityOptions, capabilityReadAuthorized, capabilityWriteAuthorized, siteIdFromRequest, errorResponse } from "../http";
import { RuntimeLauncher } from "@/runner/capability-v2/runtime-launcher";
import { findDuplicateCapability } from "@/lib/capability-center-v2/duplicate-matcher";

export async function OPTIONS() { return capabilityOptions(); }

export async function GET(request: Request) {
  const siteId = siteIdFromRequest(request); const query = new URL(request.url).searchParams;
  if (!siteId) return capabilityJson({ error: "site_id_required" }, 400);
  if (!(await capabilityReadAuthorized(request))) return capabilityJson({ error: "unauthorized" }, 401);
  try {
    const statuses = new Set<CapabilityTaskStatus>(["Pending", "Running", "WaitingInput", "Succeeded", "Failed", "Cancelled", "Deleted"]);
    const types = new Set<CapabilityTaskType>(["Discovery", "Validation", "Repair"]);
    const status = query.get("status") as CapabilityTaskStatus | null; const type = query.get("type") as CapabilityTaskType | null;
    const result = await listTasks(siteId, { status: status && statuses.has(status) ? status : undefined, type: type && types.has(type) ? type : undefined, versionId: query.get("versionId") || undefined, includeDeleted: query.get("includeDeleted") === "1", includeArchived: query.get("includeArchived") === "1" });
    return capabilityJson({ ...result, tasks: result.tasks.map(sanitizeTaskForClient) });
  } catch (error) { return errorResponse(error, "capability_tasks_failed"); }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return capabilityJson({ error: "invalid_json" }, 400); }
  const siteId = siteIdFromRequest(request, body); if (!siteId) return capabilityJson({ error: "site_id_required" }, 400);
  if (!(await capabilityWriteAuthorized(request))) return capabilityJson({ error: "unauthorized" }, 401);
  const type = body.type as CapabilityTaskType;
  if (type !== "Discovery") return capabilityJson({ error: "task_type_invalid" }, 400);
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  const scope = `task:create:${type}`;
  const requestHash = idempotencyKey ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body))).then((digest) => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")) : "";
  try {
    await assertCapabilityStartUrl(siteId, (body.input as { context?: { startUrl?: unknown } } | undefined)?.context?.startUrl);
    if (idempotencyKey) {
      const reservation = await beginIdempotentRequest(siteId, scope, idempotencyKey, requestHash);
      if (reservation.replay) return capabilityJson(reservation.replay, 202, { "x-capability-v2-idempotent-replay": "1" });
    }
    if (type === "Discovery") {
      const input = body.input as { candidateSummary?: never } | undefined;
      const duplicate = await findDuplicateCapability(siteId, typeof body.goal === "string" ? body.goal : "", input?.candidateSummary);
      if (duplicate) throw new CapabilityCenterV2Error(duplicate.status === "Disabled" ? "capability_disabled_match" : "capability_duplicate", duplicate.id, 409);
    }
    const result = await createCapabilityTask(siteId, { type, versionId: typeof body.versionId === "string" ? body.versionId : undefined, capabilityId: typeof body.capabilityId === "string" ? body.capabilityId : undefined, goal: typeof body.goal === "string" ? body.goal : "", guidance: typeof body.guidance === "string" ? body.guidance : undefined, input: body.input as never, sourceAgentRunId: typeof body.sourceAgentRunId === "string" ? body.sourceAgentRunId : undefined, rerunOfTaskId: typeof body.rerunOfTaskId === "string" ? body.rerunOfTaskId : undefined });
    if (result.task.status === "Pending" && process.env.CAPABILITY_V2_AUTO_DISPATCH !== "0") {
      void new RuntimeLauncher().dispatchOne(siteId, result.task.id).catch(() => undefined);
    }
    const payload = { taskId: result.task.id, status: result.task.status, versionId: result.task.versionId, eventsUrl: `/api/capability-v2/tasks/${result.task.id}/events` };
    if (idempotencyKey) await completeIdempotentRequest(siteId, scope, idempotencyKey, payload);
    return capabilityJson(payload, 202, { "x-capability-v2-persistence": result.persistence });
  } catch (error) {
    if (idempotencyKey) await abandonIdempotentRequest(siteId, scope, idempotencyKey).catch(() => undefined);
    return errorResponse(error, "capability_task_create_failed");
  }
}
