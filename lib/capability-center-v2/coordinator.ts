import {
  appendTaskEvent,
  createCapabilityTask,
  findLiveCapabilityByName,
  getCapability,
  getTask,
  getGenerationPublication,
  getVersion,
  listTasks,
  publishValidatedCapability,
  recordCapabilityTaskPublication,
  reviewVersion,
  supersedeGeneration,
} from "../../db/capability-center-v2-store";
import type { CapabilityContract, CapabilityPublishResult, CapabilityTask, JsonValue, ValidatedCapabilityPackage } from "./model";
import { inspectCapabilityQuality, demonstrationParametersOf } from "./quality";
import { decodeC2CaseGenerationOutput } from "./case-generation";
import { validationVerdict, type ValidationVerdict } from "./review-adjudication";

/** Review is a read-only gate over the exact persisted C3 package. */
function assertValidatedPackageForReview(validated: ValidatedCapabilityPackage) {
  if (!validated || typeof validated !== "object" || !validated.artifact || !validated.validation) {
    throw new Error("validated_package_required");
  }
  const artifact = validated.artifact;
  if (
    validated.validation.candidateId !== artifact.candidateId ||
    validated.validation.contractHash !== artifact.contractHash ||
    validated.validation.programHash !== artifact.programHash
  ) {
    throw new Error("review_validation_hash_mismatch");
  }
  try {
    decodeC2CaseGenerationOutput({
      generationTaskId: artifact.generationTaskId,
      candidate: artifact.candidate,
      validationSuite: artifact.validationSuite,
      caseDiscoveryEvidenceRef: artifact.caseDiscoveryEvidenceRef,
      validationSuiteHash: artifact.validationSuiteHash,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(/semantic|dependencyLedger|entryPolicy|unknown|fields_invalid/iu.test(message)
      ? "review_artifact_unknown_field"
      : "review_validation_hash_mismatch");
  }
}

/** What the visitor's run came to, as the generation task recorded it: the outcome the demonstrated case is held to. */
function demonstrationOutcomeOf(task: { input?: { experience?: { outcome?: unknown } } } | undefined): "Success" | "NoResult" | undefined {
  const outcome = task?.input?.experience?.outcome;
  return outcome === "Success" || outcome === "NoResult" ? outcome : undefined;
}

function requiredInputsOf(contract: CapabilityContract) {
  return Array.isArray(contract.inputSchema.required)
    ? contract.inputSchema.required.filter((value): value is string => typeof value === "string")
    : [];
}

/** The verdict as the task feed and the version record carry it. */
function verdictEvent(verdict: ValidationVerdict) {
  const { decision, reason, ...details } = verdict;
  return { phase: "Reviewing", decision, reason, ...details, deterministic: true as const };
}

export async function reviewValidatedVersion(siteId: string, versionId: string) {
  const version = await getVersion(siteId, versionId);
  if (!version) throw new Error("version_not_found");
  const capability = await getCapability(siteId, version.capabilityId, true);
  if (!capability) throw new Error("capability_not_found");
  const validation = (await listTasks(siteId, { type: "Validation", versionId, includeDeleted: true, includeArchived: true })).tasks.find((task) => task.status === "Succeeded");
  if (!validation) throw new Error("validation_required");
  const validationCases = Array.isArray(validation.input.context.validationCases)
    ? validation.input.context.validationCases.filter((value): value is Record<string, JsonValue> => Boolean(value) && typeof value === "object" && !Array.isArray(value))
    : [];
  const rerunSourceTask = validation.rerunOfTaskId ? await getTask(siteId, validation.rerunOfTaskId, true) : undefined;
  const sourceTask = rerunSourceTask?.result?.candidateSource
    ? rerunSourceTask
    : (await listTasks(siteId, { versionId, includeDeleted: true, includeArchived: true })).tasks
      .find((task) => (task.type === "Discovery" || task.type === "Repair") && task.status === "Succeeded" && task.result?.outcome === "Success" && Boolean(task.result.candidateSource));
  const quality = inspectCapabilityQuality(capability.contract, version.program, {
    // The validation task's own input is its first C2 case; the demonstration lives on the generation task.
    demonstrationParameters: demonstrationParametersOf(sourceTask),
    validationCases,
    // C3 requires one deterministic validation case. Multiple independent
    // cases improve confidence, but are not a hard publication gate: a
    // narrow capability can legitimately have only one executable case.
    requireTargetEvidence: version.program.targetBindings.length > 0,
    targetEvidence: validation.result?.targetEvidence,
    source: sourceTask?.result?.candidateSource,
    summary: { name: capability.name, description: capability.description, aliases: capability.aliases },
  });
  if (!quality.valid) throw new Error(`capability_quality_rejected:${quality.issues.map((issue) => issue.code).join(",")}`);
  try {
    const verdict = validationVerdict({
      results: validation.result?.validationResults || [],
      demonstrationParameters: demonstrationParametersOf(sourceTask),
      demonstrationOutcome: demonstrationOutcomeOf(sourceTask),
      source: sourceTask?.result?.candidateSource,
      requiredInputs: requiredInputsOf(capability.contract),
    });
    await appendTaskEvent(siteId, validation.id, { eventType: "ReviewCompleted", payload: verdictEvent(verdict) });
    return reviewVersion(siteId, versionId, { decision: verdict.decision, reason: verdict.reason, deterministic: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await appendTaskEvent(siteId, validation.id, { eventType: "ReviewFailed", payload: { phase: "Reviewing", reason } });
    return reviewVersion(siteId, versionId, { decision: "Error", reason, deterministic: true });
  }
}

export async function advanceCompletedTask(task: CapabilityTask) {
  if (task.status !== "Succeeded") return { task };
  const moduleV2 = task.input.context.__pipelineVersion === "2.0";
  // A completed generation that froze a candidate already created its
  // validation task, and says so in its result. That is the fact to go by, not
  // the context flag: a rebuild started through the admin API arrived here
  // without the flag, fell into the legacy branch below, asked for a second
  // validation by version id, and was refused with validation_version_invalid
  // — 29 ms after its own TaskCompleted, which the runner then reported as a
  // failure.
  const frozenValidationId = task.result?.outcome === "Success" ? task.result.validationTaskId : undefined;
  if ((moduleV2 || frozenValidationId) && (task.type === "Discovery" || task.type === "Repair") && task.result?.outcome === "Success") {
    const nextTask = frozenValidationId ? await getTask(task.siteId, frozenValidationId, true) : undefined;
    return { task, ...(nextTask ? { nextTask } : {}) };
  }
  if (moduleV2 && task.type === "Validation" && task.result?.outcome === "Success") {
    const buildResult = task.result.buildResult;
    if (!buildResult || buildResult.outcome !== "Validated") return { task, buildResult: undefined };
    const review = await getGenerationPublication(task.siteId, buildResult.package.artifact.generationTaskId) || await reviewValidatedCandidate(task.siteId, task, buildResult.package);
    if (review.outcome === "Published") {
      // D's transaction is authoritative.  Persist its identifiers back onto
      // both task projections so the task chain and Debug workbench resolve
      // the published Version rather than the pre-Candidate draft id.
      await recordCapabilityTaskPublication(task.siteId, task.id, { capabilityId: review.capability.id, versionId: review.version.id });
      await recordCapabilityTaskPublication(task.siteId, buildResult.package.artifact.generationTaskId, { capabilityId: review.capability.id, versionId: review.version.id });
    }
    return { task, buildResult, review };
  }
  if ((task.type === "Discovery" || task.type === "Repair") && task.result?.outcome === "Success") {
    const versionId = task.result.versionId || task.versionId;
    const existing = (await listTasks(task.siteId, { type: "Validation", versionId, includeDeleted: true, includeArchived: true })).tasks.find((item) => item.status !== "Deleted");
    if (existing) return { task, nextTask: existing };
    const created = await createCapabilityTask(task.siteId, {
      type: "Validation",
      versionId,
      goal: task.goal,
      guidance: "Replay the candidate program independently and verify the Contract's success conditions strictly.",
      input: task.input,
      rerunOfTaskId: task.id,
    });
    if (created.task.status === "Pending" && process.env.CAPABILITY_V2_AUTO_DISPATCH !== "0") {
      const { RuntimeLauncher } = await import("../../runner/capability-v2/runtime-launcher");
      // The completing Runner still occupies a broker slot until this request
      // returns and its finally block terminates the process.  Dispatch is a
      // best-effort wake-up; the broker's pending-task loop will retry once the
      // slot is free.  A transient launch failure must not turn an already
      // persisted successful task result into an HTTP 500.
      void new RuntimeLauncher().dispatchOne(task.siteId, created.task.id).catch(() => undefined);
    }
    return { task, nextTask: created.task };
  }
  if (task.type === "Validation" && task.result?.outcome === "Success") {
    return { task, review: await reviewValidatedVersion(task.siteId, task.versionId) };
  }
  return { task };
}

/** The verdict on a validated candidate, without performing D's publish mutation. */
export async function authorizeValidatedCandidate(siteId: string, task: CapabilityTask, validated: ValidatedCapabilityPackage): Promise<
  | { outcome: "Approved"; review: Extract<ValidationVerdict, { decision: "Approved" }>; authorization: { mode: "Validated"; reason: string } }
  | { outcome: "Rejected" | "Error"; reason: string }
> {
  assertValidatedPackageForReview(validated);
  try {
    const { candidate } = validated.artifact;
    const generation = await getTask(siteId, validated.artifact.generationTaskId, true);
    const verdict = validationVerdict({
      results: validated.validation.cases,
      demonstrationParameters: demonstrationParametersOf(generation),
      demonstrationOutcome: demonstrationOutcomeOf(generation),
      source: generation?.result?.candidateSource || "",
      requiredInputs: requiredInputsOf(candidate.contract),
    });
    await appendTaskEvent(siteId, task.id, { eventType: "ReviewCompleted", payload: verdictEvent(verdict) }).catch(() => undefined);
    if (verdict.decision !== "Approved") return { outcome: "Rejected", reason: verdict.reason };
    return { outcome: "Approved", review: verdict, authorization: { mode: "Validated", reason: verdict.reason } };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await appendTaskEvent(siteId, task.id, { eventType: "ReviewFailed", payload: { phase: "Reviewing", reason } }).catch(() => undefined);
    return { outcome: "Error", reason };
  }
}

/** C3 result → verdict → D authorization, without creating a Draft. */
type ReviewPublishResult = CapabilityPublishResult | { outcome: "ReviewPending" | "Rejected" | "Error"; reason: string };
// Coalesce automatic completion and an administrator retry within this process.
// Across processes, D's database transaction remains the idempotency authority.
const publicationFlights = new Map<string, Promise<ReviewPublishResult>>();
export async function reviewValidatedCandidate(siteId: string, task: CapabilityTask, validated: ValidatedCapabilityPackage): Promise<ReviewPublishResult> {
  const key = `${siteId}:${task.id}`;
  const existing = publicationFlights.get(key);
  if (existing) return existing;
  const flight = (async (): Promise<ReviewPublishResult> => {
    const superseded = async (result: Extract<CapabilityPublishResult, { outcome: "AlreadyPublished" }>) => {
      await appendTaskEvent(siteId, task.id, { eventType: "PublicationSuperseded", payload: { phase: "Published", capabilityId: result.capability.id, versionId: result.version.id, capabilityName: result.capability.name, publishedAt: result.version.publishedAt || result.version.updatedAt, message: "publication superseded" } });
      return result;
    };
    // A new capability whose name is already live cannot publish; another
    // generation got there first. Yield now rather than after a verdict that
    // could not change that.
    const generationTask = await getTask(siteId, validated.artifact.generationTaskId, true);
    if (generationTask && !generationTask.input.trigger.baseVersionId) {
      const live = await findLiveCapabilityByName(siteId, validated.artifact.candidate.name);
      if (live) {
        const result = await supersedeGeneration(siteId, validated.artifact.generationTaskId, live);
        if (result) return superseded(result);
      }
    }
    await appendTaskEvent(siteId, task.id, { eventType: "ReviewStarted", payload: { phase: "Reviewing" } });
    const reviewed = await authorizeValidatedCandidate(siteId, task, validated);
    if (reviewed.outcome !== "Approved") return reviewed;
    await appendTaskEvent(siteId, task.id, { eventType: "PublicationStarted", payload: { phase: "Publishing" } });
    try {
      const result = await publishValidatedCapability(siteId, { generationTaskId: validated.artifact.generationTaskId, validated, authorization: reviewed.authorization });
      if (result.outcome === "WriteConflict") {
        await appendTaskEvent(siteId, task.id, { eventType: "PublicationFailed", payload: { phase: "Publishing", code: result.code, reason: result.reason, conflict: true } });
      }
      if (result.outcome === "AlreadyPublished") return superseded(result);
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await appendTaskEvent(siteId, task.id, { eventType: "PublicationFailed", payload: { phase: "Publishing", code: "publication_failed", reason, conflict: false } });
      return { outcome: "Error", reason };
    }
  })();
  publicationFlights.set(key, flight);
  try { return await flight; } finally { publicationFlights.delete(key); }
}

export async function advanceTaskById(siteId: string, taskId: string) {
  const task = await getTask(siteId, taskId, true);
  if (!task) throw new Error("task_not_found");
  return advanceCompletedTask(task);
}
