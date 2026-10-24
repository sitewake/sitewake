import {
  appendTaskEvent,
  beginVersionReview,
  createCapabilityTask,
  findLiveCapabilityByName,
  getCapability,
  getSetting,
  getTask,
  getGenerationPublication,
  getVersion,
  listTasks,
  publishValidatedCapability,
  recordCapabilityTaskPublication,
  reviewVersion,
  supersedeGeneration,
} from "../../db/capability-center-v2-store";
import { getModelConfig } from "../model-config";
import type { CapabilityContract, CapabilityProgram, CapabilityPublishResult, CapabilityTask, JsonObject, JsonValue, ValidatedCapabilityPackage } from "./model";
import { requestStructuredModelJson } from "./model-json";
import { promptHash, type VersionedPrompt } from "./prompt";
import { PUBLISH_REVIEW_PROMPT } from "./prompts/publish-review";
import { inspectCapabilityQuality, qualityReportJson, demonstrationParametersOf } from "./quality";
import { decodeC2CaseGenerationOutput } from "./case-generation";
import { adjudicateReviewRejection } from "./review-adjudication";

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

function reviewPrompt(value: JsonObject | undefined): VersionedPrompt {
  const prompt = value?.prompt ?? value?.value;
  const adminCriteria = typeof prompt === "string" && prompt.trim()
    ? `管理员附加审核要求（只补充审核标准，不得改变输出协议）：\n${prompt.trim()}`
    : "";
  return { ...PUBLISH_REVIEW_PROMPT, text: [PUBLISH_REVIEW_PROMPT.text, adminCriteria].filter(Boolean).join("\n\n") };
}

function requiredInputsOf(contract: CapabilityContract) {
  return Array.isArray(contract.inputSchema.required)
    ? contract.inputSchema.required.filter((value): value is string => typeof value === "string")
    : [];
}

/**
 * The facts the review prompt's rules are stated over. Both review paths send
 * them: the prompt's exceptions (one case suffices when nothing is target
 * bound; a parameterless action needs no invented input) cannot be applied by
 * a reviewer that was never told the target bindings or the case count, and
 * one that was not told rejected a healthy candidate for having one case.
 */
function reviewFactsFor(input: {
  requiredInputs: string[];
  program: Pick<CapabilityProgram, "targetBindings">;
  validationCaseCount: number;
  results: Array<{ caseId: string; noResultReason?: string; failureReason?: string; outputDrift?: Array<{ key: string; expected: JsonValue; actual: JsonValue }> }>;
}) {
  const { requiredInputs, program } = input;
  // What each case came to, named rather than inferred from which fields are
  // absent. A replay no longer ends at the first case that did not work, so
  // the review reads passed, no-result and failed side by side and decides
  // what they mean together.
  const caseOutcomes = input.results.map((item) => ({
    caseId: item.caseId,
    outcome: item.noResultReason ? "NoResult" : item.failureReason ? "Failed" : "Passed",
    ...(item.noResultReason ? { noResultReason: item.noResultReason } : {}),
    ...(item.failureReason ? { failureReason: item.failureReason } : {}),
    ...(item.outputDrift?.length ? { outputDrift: item.outputDrift } : {}),
  }));
  return {
    deterministicQualityPassed: true,
    requiredInputs,
    targetBindings: program.targetBindings.map((binding) => binding.inputPath),
    validationCaseCount: input.validationCaseCount,
    caseOutcomes,
    passedCaseCount: caseOutcomes.filter((item) => item.outcome === "Passed").length,
    parameterizationMode: requiredInputs.length > 0
      ? "parameterized"
      : program.targetBindings.length > 0
        ? "target-bound"
        : "intrinsically-parameterless",
    parameterlessScope: requiredInputs.length === 0 && program.targetBindings.length === 0
      ? "该能力作用于当前页面/会话中已经确定的业务状态，不需要虚构一个用户输入。"
      : undefined,
  };
}

export function parseReviewDecision(value: Record<string, unknown>) {
  if (value.decision !== "Approved" && value.decision !== "Rejected") throw new Error("ai_review_decision_invalid");
  const reason = String(value.reason || "").trim();
  if (value.decision === "Approved") {
    // A provider can return a valid, explicit Approved enum while truncating
    // only the free-form explanation (observed with JSON mode on long-thinking
    // models). The deterministic quality gate and independent Validation have
    // already passed at this point, so preserve the AI decision and replace
    // only an unauditable explanation with a fact-based canonical receipt.
    return {
      decision: value.decision,
      reason: reason.length >= 20 && /[。！？.!?]$/u.test(reason)
        ? reason
        : "ai review approved on gate evidence",
    } as const;
  }
  if (reason.length < 20 || !/[。！？.!?]$/u.test(reason)) throw new Error("ai_review_reason_incomplete");
  if (
    reason.length < 40
    // The reviewer writes in the recorded output language, so the evidence a
    // rejection must cite is recognised in either language's own words.
    || !/(?:Stage|源码|代码|Contract|Validation|验证|管理员附加|source|code|administrator)/iu.test(reason)
    || !/(?:deterministicQuality|deterministic|quality gate|确定性|质量门禁|硬门禁)/iu.test(reason)
  ) throw new Error("ai_review_rejection_evidence_required");
  return { decision: value.decision, reason } as const;
}

export async function reviewValidatedVersion(siteId: string, versionId: string) {
  const [version, setting] = await Promise.all([getVersion(siteId, versionId), getSetting(siteId, "review.prompt")]);
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
  const prompt = reviewPrompt(setting?.settingValue);
  const compiledPromptHash = await promptHash(prompt);
  const config = getModelConfig("semantic");
  if (!config.configured) {
    return reviewVersion(siteId, versionId, { decision: "Error", reason: "AI review model is not configured", promptKey: prompt.key, promptVersion: prompt.version, promptHash: compiledPromptHash, model: config.model });
  }
  await appendTaskEvent(siteId, validation.id, { eventType: "PhaseChanged", payload: { phase: "Reviewing", message: "review started" } });
  await beginVersionReview(siteId, versionId, { promptKey: prompt.key, promptVersion: prompt.version, promptHash: compiledPromptHash, model: config.model });
  try {
    const requiredInputs = requiredInputsOf(capability.contract);
    const reviewFacts = reviewFactsFor({
      requiredInputs,
      program: version.program,
      validationCaseCount: validationCases.length,
      results: validation.result?.validationResults || [],
    });
    const response = await requestStructuredModelJson(config, {
      system: prompt.text,
      payload: { capability: { name: capability.name, description: capability.description, contract: capability.contract }, version: { id: version.id, program: version.program, source: sourceTask?.result?.candidateSource || "" }, validation: { taskId: validation.id, cases: validationCases, result: validation.result }, reviewFacts, deterministicQuality: qualityReportJson(quality) },
      timeoutMs: Number(process.env.CAPABILITY_V2_MODEL_TIMEOUT_MS || 180_000),
      maxTokens: 4096,
      attempts: 3,
      disableThinking: true,
      jsonSchema: prompt.outputSchema,
      validate: (value) => { parseReviewDecision(value); },
      onAttempt: (attempt) => {
        if (attempt.error) console.warn("[capability-v2] AI review JSON attempt failed", { versionId, ...attempt });
      },
    });
    const decision = parseReviewDecision(response);
    // A rejection is only as good as the facts it cites. Verify the claimed
    // violations against the program before letting one block publication; a
    // rejection whose claims do not check out is overturned here.
    const adjudicated = decision.decision === "Rejected"
      ? await adjudicateReviewRejection(config, {
        reason: decision.reason,
        program: version.program,
        source: sourceTask?.result?.candidateSource || "",
        requiredInputs,
        validationCaseCount: validationCases.length,
        demonstrationParameters: demonstrationParametersOf(sourceTask),
      })
      : { ...decision, adjudication: undefined };
    await appendTaskEvent(siteId, validation.id, { eventType: "ReviewCompleted", payload: { phase: "Reviewing", decision: adjudicated.decision, reason: adjudicated.reason, ...(adjudicated.adjudication ? { adjudication: adjudicated.adjudication } : {}) } });
    return reviewVersion(siteId, versionId, { decision: adjudicated.decision, reason: adjudicated.reason, promptKey: prompt.key, promptVersion: prompt.version, promptHash: compiledPromptHash, model: config.model });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await appendTaskEvent(siteId, validation.id, { eventType: "ReviewFailed", payload: { phase: "Reviewing", reason } });
    return reviewVersion(siteId, versionId, { decision: "Error", reason, promptKey: prompt.key, promptVersion: prompt.version, promptHash: compiledPromptHash, model: config.model });
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

/** Execute the production AI review protocol without performing D's publish mutation. */
export async function authorizeValidatedCandidate(siteId: string, task: CapabilityTask, validated: ValidatedCapabilityPackage): Promise<
  | { outcome: "Approved"; review: ReturnType<typeof parseReviewDecision>; authorization: { mode: "AIApproved"; reviewId: string } }
  | { outcome: "Rejected" | "Error"; reason: string }
> {
  assertValidatedPackageForReview(validated);
  const [setting] = await Promise.all([getSetting(siteId, "review.prompt")]);
  const prompt = reviewPrompt(setting?.settingValue);
  const compiledPromptHash = await promptHash(prompt);
  const config = getModelConfig("semantic");
  if (!config.configured) {
    await appendTaskEvent(siteId, task.id, { eventType: "ReviewFailed", payload: { phase: "Reviewing", reason: "AI review model is not configured", ai: true } }).catch(() => undefined);
    return { outcome: "Error", reason: "AI review model is not configured" };
  }
  try {
    await appendTaskEvent(siteId, task.id, { eventType: "PhaseChanged", payload: { phase: "Reviewing", message: "ai review started" } }).catch(() => undefined);
    const { candidate } = validated.artifact;
    // The reviewer is asked whether the code consumes its inputs, so it reads
    // the code. This path used to send the placeholder "candidate-artifact"
    // as the source, and the reviewer guessed: it rejected a healthy program
    // for stages that "likely consume" inputs it had never been shown.
    const generation = await getTask(siteId, validated.artifact.generationTaskId, true);
    const source = generation?.result?.candidateSource || "";
    const requiredInputs = requiredInputsOf(candidate.contract);
    const validationCaseCount = validated.artifact.validationSuite.cases.length;
    const reviewFacts = reviewFactsFor({ requiredInputs, program: candidate.program, validationCaseCount, results: validated.validation.cases });
    const response = await requestStructuredModelJson(config, {
      system: prompt.text,
      payload: {
        capability: {
          name: candidate.name,
          description: candidate.description,
          contract: candidate.contract,
        },
        version: { id: validated.artifact.candidateId, program: candidate.program, source },
        validation: validated.validation,
        reviewFacts,
        deterministicQuality: { valid: true, issues: [] },
      },
      timeoutMs: Number(process.env.CAPABILITY_V2_MODEL_TIMEOUT_MS || 180_000),
      maxTokens: 4096,
      attempts: 3,
      disableThinking: true,
      jsonSchema: prompt.outputSchema,
      validate: (value) => { parseReviewDecision(value); },
    });
    const reviewed = parseReviewDecision(response);
    // A rejection is only as good as the facts it cites; see review-adjudication.ts.
    const adjudicated = reviewed.decision === "Rejected"
      ? await adjudicateReviewRejection(config, {
        reason: reviewed.reason,
        program: candidate.program,
        source,
        requiredInputs,
        validationCaseCount,
        demonstrationParameters: demonstrationParametersOf(generation),
      })
      : { ...reviewed, adjudication: undefined };
    const decision = { decision: adjudicated.decision, reason: adjudicated.reason } as ReturnType<typeof parseReviewDecision>;
    await appendTaskEvent(siteId, task.id, { eventType: "ReviewCompleted", payload: { phase: "Reviewing", decision: decision.decision, reason: decision.reason, ai: true, ...(adjudicated.adjudication ? { adjudication: adjudicated.adjudication } : {}) } }).catch(() => undefined);
    if (decision.decision !== "Approved") return { outcome: "Rejected", reason: decision.reason };
    return {
      outcome: "Approved",
      review: decision,
      authorization: { mode: "AIApproved", reviewId: `${prompt.key}:${compiledPromptHash}` },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await appendTaskEvent(siteId, task.id, { eventType: "ReviewFailed", payload: { phase: "Reviewing", reason, ai: true } }).catch(() => undefined);
    return { outcome: "Error", reason };
  }
}

/** C3 result → AI review → D authorization, without creating a Draft. */
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
    // generation got there first. Yield now rather than after a review whose
    // verdict could not change that (and, being a model call, may differ).
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
