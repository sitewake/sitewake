import { loadAuthorCheckpoint } from "@/db/capability-workspace-checkpoint";
import {
  claimTask,
  appendTaskEvent,
  getTask,
  getTaskArtifact,
  getCandidateValidationBundle,
  getRunnerRunSpec,
  heartbeatRunner,
  markRunnerLost,
  requestTaskInteraction,
  saveTaskArtifact,
  registerRunner,
  submitTaskResult,
  terminateRunner,
} from "@/db/capability-center-v2-store";
import { advanceCompletedTask } from "@/lib/capability-center-v2/coordinator";
import { putCapabilityV2Module } from "@/db/capability-center-v2-module-store";
import { issueRunnerToken, verifyRunnerToken } from "@/lib/capability-center-v2/runner-auth";
import { capabilityJson, capabilityOptions, errorResponse, runnerAuthorized, siteIdFromRequest } from "@/app/api/capability-v2/http";
import { RuntimeLauncher } from "@/runner/capability-v2/runtime-launcher";

type Context = { params: Promise<{ taskId: string; path: string[] }> | { taskId: string; path: string[] } };
async function paramsOf(context: Context) { const params = await context.params; return { taskId: decodeURIComponent(params.taskId || ""), path: (params.path || []).map((part) => decodeURIComponent(part)) }; }
async function bodyOf(request: Request) { try { return await request.json() as Record<string, unknown>; } catch { throw new Error("invalid_json"); } }

export async function OPTIONS() { return capabilityOptions(); }

export async function GET(request: Request, context: Context) {
  const { taskId, path } = await paramsOf(context); const siteId = siteIdFromRequest(request); if (!siteId || !taskId) return capabilityJson({ error: "site_id_and_task_id_required" }, 400);
  try {
    const task = await getTask(siteId, taskId, true); if (!task) return capabilityJson({ error: "task_not_found" }, 404);
    const runnerId = request.headers.get("x-capability-runner-id") || "";
    const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!(await verifyRunnerToken(bearer, siteId, taskId, runnerId))) return capabilityJson({ error: "unauthorized" }, 401);
    if (task.runnerId !== runnerId) return capabilityJson({ error: "runner_mismatch" }, 409);
    if (path[0] === "author-checkpoint") return capabilityJson({checkpoint:await loadAuthorCheckpoint(siteId,taskId)});
    if (path[0] === "run-spec") return capabilityJson(await getRunnerRunSpec(siteId, taskId, runnerId));
    if (path[0] === "candidate-artifact") return capabilityJson(await getCandidateValidationBundle(siteId, taskId));
    if (path[0] === "commands") return capabilityJson({ commands: task.status === "Cancelled" ? [{ type: "Cancel" }] : task.status === "Running" ? [{ type: "Continue" }] : [] });
    if (path[0] === "artifacts" && path[1]) {
      const stored = await getTaskArtifact(siteId, path[1]);
      if (!stored || stored.artifact.taskId !== taskId) return capabilityJson({ error: "artifact_not_found" }, 404);
      const content = "stream" in stored ? stored.stream : stored.bytes;
      return new Response(content as BodyInit, { headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${stored.artifact.id}.bin"`,
        "content-length": String(stored.artifact.size),
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "cache-control": "private, no-store",
      } });
    }
    return capabilityJson({ error: "internal_capability_v2_route_not_found" }, 404);
  } catch (error) { return errorResponse(error, "internal_capability_v2_get_failed"); }
}

export async function POST(request: Request, context: Context) {
  const { taskId, path } = await paramsOf(context); let body: Record<string, unknown>; try { body = await bodyOf(request); } catch { return capabilityJson({ error: "invalid_json" }, 400); }
  const siteId = siteIdFromRequest(request, body); if (!siteId || !taskId) return capabilityJson({ error: "site_id_and_task_id_required" }, 400);
  try {
    if (path[0] === "runner" && path[1] === "register") {
      if (!runnerAuthorized(request)) return capabilityJson({ error: "unauthorized" }, 401);
      const runnerId = typeof body.runnerId === "string" ? body.runnerId : undefined;
      const registered = await registerRunner(siteId, { id: runnerId, taskId, runtimeType: body.runtimeType as never, runtimeProvider: typeof body.runtimeProvider === "string" ? body.runtimeProvider : undefined, runtimeVersion: typeof body.runtimeVersion === "string" ? body.runtimeVersion : undefined });
      await claimTask(siteId, taskId, registered.runner.id);
      await appendTaskEvent(siteId, taskId, { eventType: "RunnerDispatched", payload: { phase: "RunnerDispatch", runnerId: registered.runner.id, runtimeType: registered.runner.runtimeType, runtimeProvider: registered.runner.runtimeProvider } });
      return capabilityJson({ runnerId: registered.runner.id, runnerToken: await issueRunnerToken(siteId, taskId, registered.runner.id), runSpecUrl: `/api/internal/capability-v2/tasks/${taskId}/run-spec` }, 200);
    }
    const assigned = await getTask(siteId, taskId, true); if (!assigned) return capabilityJson({ error: "task_not_found" }, 404);
    const assignedRunnerId = String(body.runnerId || request.headers.get("x-capability-runner-id") || "");
    const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!(await verifyRunnerToken(bearer, siteId, taskId, assignedRunnerId))) return capabilityJson({ error: "unauthorized" }, 401);
    if (!assignedRunnerId || assigned.runnerId !== assignedRunnerId) return capabilityJson({ error: "runner_mismatch" }, 409);
    if (path[0] === "runner" && path[1] === "heartbeat") return capabilityJson(await heartbeatRunner(siteId, assignedRunnerId, { status: body.status as never, lastError: typeof body.lastError === "string" ? body.lastError : undefined }));
    if (path[0] === "events") {
      const task = await getTask(siteId, taskId, true); if (!task) return capabilityJson({ error: "task_not_found" }, 404);
      const runnerId = assignedRunnerId;
      if (body.eventType === "InputRequested" && body.interaction && typeof body.interaction === "object") {
        await requestTaskInteraction(siteId, taskId, runnerId, body.interaction as never);
        await heartbeatRunner(siteId, runnerId, { status: "WaitingInput" });
      }
      const eventId = typeof body.eventId === "string" ? body.eventId : crypto.randomUUID();
      const event = await appendTaskEvent(siteId, taskId, { id: eventId, eventType: typeof body.eventType === "string" ? body.eventType : "RunnerEvent", payload: body as never });
      return capabilityJson({ accepted: true, eventId, sequence: event.sequence });
    }
    if (path[0] === "artifacts") {
      const kind = ["Screenshot", "Trace", "Video", "Log", "Source", "Bundle", "CaseContext", "CaseDiscoveryEvidence"].includes(String(body.kind)) ? String(body.kind) as "Screenshot" | "Trace" | "Video" | "Log" | "Source" | "Bundle" | "CaseContext" | "CaseDiscoveryEvidence" : "Log";
      const encoded = typeof body.contentBase64 === "string" ? body.contentBase64 : "";
      if (!encoded) return capabilityJson({ error: "artifact_content_required" }, 400);
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const saved = await saveTaskArtifact(siteId, taskId, { kind, contentType: typeof body.contentType === "string" ? body.contentType : "application/octet-stream", bytes });
      return capabilityJson({ artifactId: saved.artifact.id, kind: saved.artifact.kind, storageKey: saved.artifact.storageKey }, 201);
    }
    if (path[0] === "modules") {
      const source = typeof body.source === "string" ? body.source : "";
      if (!source) return capabilityJson({ error: "module_source_required" }, 400);
      const saved = await putCapabilityV2Module(siteId, source);
      await appendTaskEvent(siteId, taskId, { eventType: "ModulePersisted", payload: { phase: "Module", contentHash: saved.module.contentHash, moduleUrl: saved.module.moduleUrl, created: saved.created } });
      return capabilityJson(saved, saved.created ? 201 : 200);
    }
    if (path[0] === "runner" && path[1] === "failed") {
      const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : "runner_process_exited";
      return capabilityJson(await markRunnerLost(siteId, assignedRunnerId, reason));
    }
    if (path[0] === "runner" && path[1] === "terminated") return capabilityJson(await terminateRunner(siteId, assignedRunnerId));
    return capabilityJson({ error: "internal_capability_v2_route_not_found" }, 404);
  } catch (error) { return errorResponse(error, "internal_capability_v2_post_failed"); }
}

export async function PUT(request: Request, context: Context) {
  const { taskId, path } = await paramsOf(context); if (path[0] !== "result") return capabilityJson({ error: "internal_capability_v2_route_not_found" }, 404);
  let body: Record<string, unknown>; try { body = await bodyOf(request); } catch { return capabilityJson({ error: "invalid_json" }, 400); }
  const siteId = siteIdFromRequest(request, body); const runnerId = String(body.runnerId || request.headers.get("x-capability-runner-id") || ""); if (!siteId || !runnerId) return capabilityJson({ error: "site_id_and_runner_id_required" }, 400);
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!(await verifyRunnerToken(bearer, siteId, taskId, runnerId))) return capabilityJson({ error: "unauthorized" }, 401);
  try {
    const submitted = await submitTaskResult(siteId, taskId, runnerId, body as never, body.error as never);
    await appendTaskEvent(siteId, taskId, {
      eventType: submitted.task.status === "Succeeded" ? "TaskCompleted" : "TaskFailed",
      payload: {
        phase: submitted.task.type === "Validation" ? "ValidationCompleted" : "Completed",
        outcome: submitted.task.result?.outcome || "ExecutionFailure",
        errorCode: submitted.task.error?.code || null,
        retryable: submitted.task.error?.retryable === true,
        stepId: submitted.task.error?.stepId || null,
        message: submitted.task.error?.message || submitted.task.result?.outcome || submitted.task.status,
        capabilityId: submitted.task.result?.capabilityId || null,
        versionId: submitted.task.result?.versionId || submitted.task.versionId,
      },
    });
    // submitTaskResult may perform a second persistence pass while freezing a
    // CandidateArtifact/building the validation projection. Re-read the
    // committed task before advancing so Review/D sees the complete result
    // (including buildResult and validationTaskId), rather than a stale object
    // returned by the first write.
    const completedTask = await getTask(siteId, taskId, true) || submitted.task;
    const advanced = await advanceCompletedTask(completedTask);
    const nextTask = "nextTask" in advanced ? advanced.nextTask : undefined;
    if (nextTask?.status === "Pending" && process.env.CAPABILITY_V2_AUTO_DISPATCH !== "0") {
      void new RuntimeLauncher().dispatchOne(siteId, nextTask.id).catch(() => undefined);
    }
    return capabilityJson({ ...submitted, nextTaskId: nextTask?.id, review: "review" in advanced ? advanced.review : undefined });
  } catch (error) { return errorResponse(error, "internal_capability_v2_result_failed"); }
}
