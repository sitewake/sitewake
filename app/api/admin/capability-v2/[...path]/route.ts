import { capabilityExperienceRunVerdict, listCapabilityExperienceIntakes, retryCapabilityExperienceIntake } from "@/db/capability-experience-outbox-store";
import { advanceTaskById } from "@/lib/capability-center-v2/coordinator";
import type { CapabilityTask } from "@/lib/capability-center-v2/model";
import { projectProductionStatus } from "@/lib/capability-center-v2/production-status";
import {
  actOnCapability,
  actOnVersion,
  cancelTask,
  createCapability,
  createCapabilityMaintenanceTask,
  createCapabilityTask,
  createDraftVersion,
  deleteSetting,
  deleteTask,
  getCapability,
  getCapabilityDetail,
  getCapabilityCandidateArtifact,
  getCapabilityMaintenanceDefaults,
  getRunner,
  getSetting,
  getTask,
  getGenerationPublication,
  getLatestTaskPublicationEvent,
  getTaskMaintenance,
  listCapabilities,
  listRunners,
  listSettings,
  listTaskArtifacts,
  listTaskEventPage,
  listTaskEvents,
  listTasks,
  listVersions,
  patchPendingTask,
  publishVersion,
  publishValidatedCapability,
  reviewVersion,
  respondTaskInteraction,
  sanitizeTaskForAdmin,
  setTaskArchived,
  terminateRunner,
  updateCapability,
  upsertSetting,
} from "@/db/capability-center-v2-store";
import { RuntimeLauncher, terminateRunnerProcess } from "@/runner/capability-v2/runtime-launcher";
import type { CapabilityProductionStatus } from "@/lib/capability-center-v2/production-status";
import { capabilityJson, capabilityOptions, capabilityReadAuthorized, capabilityWriteAuthorized, errorResponse, siteIdFromRequest } from "@/app/api/capability-v2/http";

type Context = { params: Promise<{ path: string[] }> | { path: string[] } };
async function segments(context: Context) { const params = await context.params; return (params.path || []).map((part) => decodeURIComponent(part)); }
async function bodyOf(request: Request) { try { return await request.json() as Record<string, unknown>; } catch { throw new Error("invalid_json"); } }

/** The validation task a frozen candidate was handed to, as recorded by the CandidateFrozen audit event. */
async function validationTaskIdFromEvents(siteId: string, taskId: string) {
  const frozen = (await listTaskEvents(siteId, taskId)).filter((event) => event.eventType === "CandidateFrozen").at(-1);
  const id = frozen?.payload.validationTaskId;
  return typeof id === "string" && id ? id : undefined;
}

async function productionProgress(siteId: string, task: CapabilityTask): Promise<CapabilityProductionStatus> {
  if (task.status === "Succeeded" && task.input.context.__pipelineVersion === "2.0" && !task.result?.capabilityId) {
    const generationId = task.type === "Validation" && task.result?.buildResult?.outcome === "Validated" ? task.result.buildResult.package.artifact.generationTaskId : task.id;
    const published = await getGenerationPublication(siteId, generationId);
    // Only a publication this generation made is its own; a superseded one
    // is told by its PublicationSuperseded event below, in its own words.
    if (published?.outcome === "Published") task = { ...task, result: { ...task.result!, capabilityId: published.capability.id, versionId: published.version.id } };
  }
  const latest = task.type === "Validation" && task.status === "Succeeded" ? await getLatestTaskPublicationEvent(siteId, task.id) : undefined;
  const own = projectProductionStatus(task, latest ? [latest] : []);
  // A generation task hands its frozen candidate to a separate validation task,
  // and review/publication then happen on that one. Left alone, the generation
  // record stays on "authoring" forever while the work moves on. Follow the
  // chain so the record the user opened shows where the capability really is.
  if (own.state !== "Published" && task.type !== "Validation" && !["Failed", "Cancelled", "Deleted", "WaitingInput"].includes(task.status)) {
    const validationTaskId = task.result?.validationTaskId || await validationTaskIdFromEvents(siteId, task.id);
    const validation = validationTaskId ? await getTask(siteId, validationTaskId, true) : undefined;
    if (validation) {
      const downstream = await productionProgress(siteId, validation);
      return { ...downstream, taskId: task.id, nextTaskId: validation.id };
    }
  }
  return own;
}

export async function OPTIONS() { return capabilityOptions(); }

export async function GET(request: Request, context: Context) {
  if (!(await capabilityReadAuthorized(request))) return capabilityJson({ error: "unauthorized" }, 401);
  const path = await segments(context); const siteId = siteIdFromRequest(request); if (!siteId) return capabilityJson({ error: "site_id_required" }, 400);
  try {
    if (path[0] === "settings") return path[1] ? capabilityJson({ setting: await getSetting(siteId, path[1]) }) : capabilityJson(await listSettings(siteId));
    if (path[0] === "experiences" && !path[1]) {
      const runId = new URL(request.url).searchParams.get("runId") || undefined;
      const intakes = await listCapabilityExperienceIntakes(siteId, runId);
      // Asked about one run and holding nothing for it, the capability centre
      // says why rather than leaving the reader with "no intake record".
      const verdict = runId && !intakes.length ? await capabilityExperienceRunVerdict(siteId, runId) : undefined;
      return capabilityJson({
        intakes,
        ...(verdict?.kind === "blocked" ? { blockedReason: verdict.reason } : {}),
        ...(verdict?.kind === "expected" ? { expected: true } : {}),
      });
    }
    if (path[0] === "capabilities") {
      if (!path[1]) return capabilityJson(await listCapabilities(siteId, { includeDeleted: new URL(request.url).searchParams.get("includeDeleted") === "1" }));
      if (path[2] === "versions") return capabilityJson(await listVersions(siteId, path[1], true));
      if (path[2] === "maintenance-defaults") return capabilityJson(await getCapabilityMaintenanceDefaults(siteId, path[1], new URL(request.url).searchParams.get("baseVersionId") || undefined));
      const detail = await getCapabilityDetail(siteId, path[1]); return detail ? capabilityJson(detail) : capabilityJson({ error: "capability_not_found" }, 404);
    }
    if (path[0] === "tasks") {
      if (!path[1]) {
        const query = new URL(request.url).searchParams;
        const result = await listTasks(siteId, { includeDeleted: query.get("includeDeleted") === "1", includeArchived: query.get("includeArchived") === "1" });
        const progress = Object.fromEntries(await Promise.all(result.tasks.map(async task => {
          return [task.id, await productionProgress(siteId, task)];
        })));
        return capabilityJson({ ...result, tasks: result.tasks.map(sanitizeTaskForAdmin), progress });
      }
      if (path[2] === "progress") {
        const task = await getTask(siteId, path[1], true);
        if (!task) return capabilityJson({ error: "task_not_found" }, 404);
        return capabilityJson({ progress: await productionProgress(siteId, task) });
      }
      if (path[2] === "events") {
        const task = await getTask(siteId, path[1], true);
        if (!task) return capabilityJson({ error: "task_not_found" }, 404);
        const query = new URL(request.url).searchParams;
        const afterSequence = Number(query.get("afterSequence") || 0);
        const limit = Number(query.get("limit") || 200);
        return capabilityJson(await listTaskEventPage(siteId, path[1], Number.isFinite(afterSequence) ? afterSequence : 0, Number.isFinite(limit) ? limit : 200));
      }
      if (path[2] === "artifacts") return capabilityJson({ artifacts: await listTaskArtifacts(siteId, path[1]) });
      const task = await getTask(siteId, path[1], true); return task ? capabilityJson({ task: sanitizeTaskForAdmin(task) }) : capabilityJson({ error: "task_not_found" }, 404);
    }
    if (path[0] === "runners") {
      if (!path[1]) {
        const query = new URL(request.url).searchParams;
        return capabilityJson(await listRunners(siteId, { taskId: query.get("taskId") || undefined }));
      }
      const runner = await getRunner(siteId, path[1]); return runner ? capabilityJson({ runner }) : capabilityJson({ error: "runner_not_found" }, 404);
    }
    return capabilityJson({ error: "admin_capability_v2_route_not_found" }, 404);
  } catch (error) { return errorResponse(error, "admin_capability_v2_get_failed"); }
}

export async function POST(request: Request, context: Context) {
  if (!(await capabilityWriteAuthorized(request))) return capabilityJson({ error: "unauthorized" }, 401);
  const path = await segments(context); let body: Record<string, unknown>; try { body = await bodyOf(request); } catch { return capabilityJson({ error: "invalid_json" }, 400); }
  const siteId = siteIdFromRequest(request, body); if (!siteId) return capabilityJson({ error: "site_id_required" }, 400);
  try {
    if (path[0] === "experiences" && path[1] && path[2] === "retry") {
      return await retryCapabilityExperienceIntake(siteId, path[1])
        ? capabilityJson({ accepted: true }, 202)
        : capabilityJson({ error: "experience_not_retryable" }, 409);
    }

    if (path[0] === "capabilities" && !path[1]) return capabilityJson(await createCapability(siteId, { name: String(body.name || ""), description: typeof body.description === "string" ? body.description : undefined, aliases: Array.isArray(body.aliases) ? body.aliases.filter((item): item is string => typeof item === "string") : undefined, contract: body.contract as never }), 201);
    if (path[0] === "capabilities" && path[1] && path[2] === "disable") return capabilityJson(await actOnCapability(siteId, path[1], "disable"));
    if (path[0] === "capabilities" && path[1] && path[2] === "enable") return capabilityJson(await actOnCapability(siteId, path[1], "enable"));
    if (path[0] === "capabilities" && path[1] && path[2] === "switch-version") return capabilityJson(await actOnCapability(siteId, path[1], "switch-version", { versionId: String(body.versionId || "") }));
    if (path[0] === "capabilities" && path[1] && (path[2] === "rebuild" || path[2] === "repair")) {
      const result = await createCapabilityMaintenanceTask(siteId, path[1], {
        mode: path[2] === "repair" ? "Repair" : "Rebuild",
        baseVersionId: typeof body.baseVersionId === "string" ? body.baseVersionId : undefined,
        sourceAgentRunId: typeof body.sourceAgentRunId === "string" ? body.sourceAgentRunId : undefined,
        goal: typeof body.goal === "string" ? body.goal : undefined,
        guidance: typeof body.guidance === "string" ? body.guidance : undefined,
        parameters: body.parameters && typeof body.parameters === "object" && !Array.isArray(body.parameters) ? body.parameters as never : undefined,
        context: body.context && typeof body.context === "object" && !Array.isArray(body.context) ? body.context as never : undefined,
      });
      if (result.task.status === "Pending" && process.env.CAPABILITY_V2_AUTO_DISPATCH !== "0") void new RuntimeLauncher().dispatchOne(siteId, result.task.id).catch(() => undefined);
      return capabilityJson(result, 202);
    }
    if (path[0] === "capabilities" && path[1] && path[2] === "versions") return capabilityJson(await createDraftVersion(siteId, path[1], { program: body.program as never, source: body.source as never }), 201);
    if (path[0] === "versions" && path[1] && path[2] === "review") {
      if (!["Approved", "Rejected", "Error"].includes(String(body.decision || ""))) return capabilityJson({ error: "review_decision_invalid" }, 400);
      return capabilityJson(await reviewVersion(siteId, path[1], { decision: body.decision as "Approved" | "Rejected" | "Error", reason: typeof body.reason === "string" ? body.reason : undefined, model: typeof body.model === "string" ? body.model : undefined }));
    }
    if (path[0] === "versions" && path[1] && path[2] === "publish") return capabilityJson(await publishVersion(siteId, path[1], { adminId: String(body.adminId || "administrator"), reason: typeof body.reason === "string" ? body.reason : undefined }));
    if (path[0] === "publish") return capabilityJson(await publishValidatedCapability(siteId, body as never));
    if (path[0] === "versions" && path[1] && path[2] === "disable") return capabilityJson(await actOnVersion(siteId, path[1], "disable", { replacementVersionId: typeof body.replacementVersionId === "string" ? body.replacementVersionId : undefined, disableCapability: body.disableCapability === true }));
    if (path[0] === "versions" && path[1] && path[2] === "enable") return capabilityJson(await actOnVersion(siteId, path[1], "enable"));
    if (path[0] === "tasks" && !path[1]) {
      const result = await createCapabilityTask(siteId, { type: body.type as never, versionId: typeof body.versionId === "string" ? body.versionId : undefined, capabilityId: typeof body.capabilityId === "string" ? body.capabilityId : undefined, goal: String(body.goal || ""), guidance: typeof body.guidance === "string" ? body.guidance : undefined, input: body.input as never, sourceAgentRunId: typeof body.sourceAgentRunId === "string" ? body.sourceAgentRunId : undefined });
      if (result.task.status === "Pending" && process.env.CAPABILITY_V2_AUTO_DISPATCH !== "0") void new RuntimeLauncher().dispatchOne(siteId, result.task.id).catch(() => undefined);
      return capabilityJson(result, 202);
    }
    if (path[0] === "tasks" && path[1] && path[2] === "interactions" && path[3] && path[4] === "response") {
      const before = await getTask(siteId, path[1], true);
      const result = await respondTaskInteraction(siteId, path[1], path[3], body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values as Record<string, unknown> : {});
      if (result.task.status === "Pending") {
        if (before?.runnerId) await terminateRunnerProcess(siteId, before.runnerId);
        if (process.env.CAPABILITY_V2_AUTO_DISPATCH !== "0") void new RuntimeLauncher().dispatchOne(siteId, result.task.id).catch(() => undefined);
      }
      return capabilityJson({ ...result, task: sanitizeTaskForAdmin(result.task) });
    }
    if (path[0] === "tasks" && path[1] && path[2] === "cancel") {
      const before = await getTask(siteId, path[1], true); const result = await cancelTask(siteId, path[1]);
      if (before?.runnerId) await terminateRunnerProcess(siteId, before.runnerId);
      return capabilityJson(result);
    }
    if (path[0] === "tasks" && path[1] && path[2] === "retry-review") {
      const task = await getTask(siteId, path[1], true);
      if (!task) return capabilityJson({ error: "task_not_found" }, 404);
      if (task.type !== "Validation" || task.status !== "Succeeded" || task.input.context.__pipelineVersion !== "2.0" || task.result?.buildResult?.outcome !== "Validated") return capabilityJson({ error: "validated_candidate_required" }, 409);
      if (task.result.capabilityId && task.result.versionId) return capabilityJson({ alreadyPublished: true });
      const result = await advanceTaskById(siteId, task.id);
      return capabilityJson({ review: 'review' in result ? result.review : undefined });
    }
    if (path[0] === "tasks" && path[1] && path[2] === "rerun") {
      const original = await getTask(siteId, path[1], true); if (!original) return capabilityJson({ error: "task_not_found" }, 404);
      if (["Pending", "Running", "WaitingInput", "Deleted"].includes(original.status)) return capabilityJson({ error: "task_not_retryable_in_current_state" }, 409);
      // A generation whose capability is live is rerun as a new version of
      // that capability. Rerun as a fresh generation, its result carried a
      // name already taken and was set aside as a duplicate however much
      // better it was: "Find floor lamps" was rebuilt to count its own
      // matches, passed validation, and the visitors kept the old count.
      const published = !getTaskMaintenance(original) && original.type === "Discovery"
        ? await getGenerationPublication(siteId, original.id)
        : undefined;
      const live = published && await getCapability(siteId, published.capability.id);
      const maintenance = getTaskMaintenance(original) || (live ? { capabilityId: live.id, mode: "Rebuild" as const } : undefined);
      const candidateArtifact = original.type === "Validation"
        ? original.result?.candidateArtifact || await getCapabilityCandidateArtifact(siteId, original.versionId)
        : undefined;
      const rerun = maintenance && (original.type === "Discovery" || original.type === "Repair")
        ? await createCapabilityMaintenanceTask(siteId, maintenance.capabilityId, { mode: maintenance.mode, baseVersionId: original.input.trigger.baseVersionId || undefined, sourceAgentRunId: original.sourceAgentRunId, goal: typeof body.goal === "string" ? body.goal : original.goal, guidance: typeof body.guidance === "string" ? body.guidance : original.guidance, parameters: original.input.parameters, context: original.input.context, rerunOfTaskId: original.id })
        : await createCapabilityTask(siteId, { type: original.type, versionId: candidateArtifact ? undefined : original.type === "Discovery" || original.type === "Repair" ? undefined : original.versionId, candidateArtifact, goal: typeof body.goal === "string" ? body.goal : original.goal, guidance: typeof body.guidance === "string" ? body.guidance : original.guidance, input: candidateArtifact ? { ...original.input, context: { ...original.input.context, __retryOfTaskId: original.id } } : original.input, rerunOfTaskId: candidateArtifact?.generationTaskId || original.id });
      if (rerun.task.status === "Pending" && process.env.CAPABILITY_V2_AUTO_DISPATCH !== "0") void new RuntimeLauncher().dispatchOne(siteId, rerun.task.id).catch(() => undefined);
      return capabilityJson(rerun, 202);
    }
    if (path[0] === "tasks" && path[1] && path[2] === "archive") {
      return capabilityJson(await setTaskArchived(siteId, path[1], body.archived !== false));
    }
    if (path[0] === "runners" && path[1] && path[2] === "terminate") return capabilityJson(await terminateRunner(siteId, path[1]));
    return capabilityJson({ error: "admin_capability_v2_route_not_found" }, 404);
  } catch (error) { return errorResponse(error, "admin_capability_v2_post_failed"); }
}

export async function PATCH(request: Request, context: Context) {
  if (!(await capabilityWriteAuthorized(request))) return capabilityJson({ error: "unauthorized" }, 401);
  const path = await segments(context); let body: Record<string, unknown>; try { body = await bodyOf(request); } catch { return capabilityJson({ error: "invalid_json" }, 400); }
  const siteId = siteIdFromRequest(request, body); if (!siteId) return capabilityJson({ error: "site_id_required" }, 400);
  try {
    if (path[0] === "settings" && path[1]) {
      const saved = await upsertSetting(siteId, path[1], (body.settingValue || {}) as never, String(body.updatedBy || "administrator"));
      // The review prompt once steered a model review between validation and
      // publication. Publication is decided by the validation record now; the
      // setting is kept for the records that cite it and steers nothing.
      return capabilityJson(path[1] === "review.prompt" ? { ...saved, applied: false, note: "review.prompt is no longer applied: publication is decided by the validation record" } : saved);
    }
    if (path[0] === "capabilities" && path[1]) return capabilityJson(await updateCapability(siteId, path[1], { name: typeof body.name === "string" ? body.name : undefined, description: typeof body.description === "string" ? body.description : undefined, aliases: Array.isArray(body.aliases) ? body.aliases.filter((item): item is string => typeof item === "string") : undefined, searchText: typeof body.searchText === "string" ? body.searchText : undefined }));
    if (path[0] === "tasks" && path[1]) return capabilityJson(await patchPendingTask(siteId, path[1], { goal: typeof body.goal === "string" ? body.goal : undefined, guidance: typeof body.guidance === "string" ? body.guidance : undefined, input: body.input as never }));
    return capabilityJson({ error: "admin_capability_v2_route_not_found" }, 404);
  } catch (error) { return errorResponse(error, "admin_capability_v2_patch_failed"); }
}

export async function DELETE(request: Request, context: Context) {
  if (!(await capabilityWriteAuthorized(request))) return capabilityJson({ error: "unauthorized" }, 401);
  const path = await segments(context); const siteId = siteIdFromRequest(request); if (!siteId) return capabilityJson({ error: "site_id_required" }, 400);
  try {
    if (path[0] === "settings" && path[1]) return capabilityJson(await deleteSetting(siteId, path[1]));
    if (path[0] === "capabilities" && path[1]) return capabilityJson(await actOnCapability(siteId, path[1], "delete"));
    if (path[0] === "versions" && path[1]) return capabilityJson(await actOnVersion(siteId, path[1], "delete"));
    if (path[0] === "tasks" && path[1]) return capabilityJson(await deleteTask(siteId, path[1]));
    return capabilityJson({ error: "admin_capability_v2_route_not_found" }, 404);
  } catch (error) { return errorResponse(error, "admin_capability_v2_delete_failed"); }
}
