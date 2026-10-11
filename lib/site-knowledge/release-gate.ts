import { materializeCandidateRelease } from "./compiler";
import { stableHash, type BrowserRun, type KnowledgeCandidate, type LocatorStrategy, type SiteAgentReleaseV2, type ValidationJob } from "./protocol";

export type ReleaseGateResult = { decision: "publish" | "reject" | "retry"; release: SiteAgentReleaseV2; candidate: KnowledgeCandidate; reason: string };

function withLocatorEvidence(candidate: KnowledgeCandidate, run: BrowserRun) {
  const allowed: LocatorStrategy[] = ["role", "label", "placeholder", "name", "text", "href-template", "relative", "css"];
  const repairs = new Map<string, { strategy: LocatorStrategy; value: string; role?: string; score: number }>();
  for (const step of run.steps) {
    if (step.status !== "passed" || step.evidence?.locatorTier !== "reidentified") continue;
    const targetId = typeof step.evidence.targetId === "string" ? step.evidence.targetId : "";
    const strategy = step.evidence.locatorStrategy;
    const value = typeof step.evidence.locatorValue === "string" ? step.evidence.locatorValue : "";
    if (targetId && value && typeof strategy === "string" && allowed.includes(strategy as LocatorStrategy)) repairs.set(targetId, { strategy: strategy as LocatorStrategy, value, role: typeof step.evidence.locatorRole === "string" && step.evidence.locatorRole ? step.evidence.locatorRole : undefined, score: Math.max(0.76, Math.min(0.99, Number(step.evidence.locatorScore || 0.8))) });
  }
  if (!repairs.size) return candidate;
  const updatedAt = run.endedAt || new Date().toISOString();
  return {
    ...candidate,
    targets: candidate.targets.map((target) => {
      const repair = repairs.get(target.id); if (!repair) return target;
      const previous = target.locatorVariants.map((variant) => ({ ...variant, failures: variant.failures + 1 }));
      const match = previous.find((variant) => variant.strategy === repair.strategy && variant.role === repair.role && variant.value === repair.value);
      const locatorVariants = match ? previous.map((variant) => variant === match ? { ...variant, score: Math.max(variant.score, repair.score), successes: variant.successes + 1, lastSeenAt: updatedAt } : variant)
        : [{ id: `locator_${stableHash(`${repair.strategy}:${repair.role || ""}:${repair.value}`)}`, strategy: repair.strategy, value: repair.value, role: repair.role, score: repair.score, successes: 1, failures: 0, lastSeenAt: updatedAt }, ...previous];
      return { ...target, name: /[<>]|\/\s*>$/.test(target.name) ? repair.value : target.name, role: repair.role || target.role, accessibleNames: [...new Set([repair.value, ...target.accessibleNames])], locatorVariants, updatedAt };
    }),
    updatedAt,
  };
}

export function evaluateBrowserRun(release: SiteAgentReleaseV2, candidate: KnowledgeCandidate, job: ValidationJob, run: BrowserRun): ReleaseGateResult {
  const attempts = candidate.validation.attempts + 1;
  const evidenced = withLocatorEvidence(candidate, run);
  const scenes = new Map([...release.scenes, ...candidate.scenes].map((scene) => [scene.id, scene]));
  const capabilityInputIds = new Set(Object.keys(candidate.capability.inputs.properties || {}));
  const programBindingsComplete = candidate.operations.every((operation) => operation.implementations.every((implementation) => {
    if (implementation.authored?.kind === "module") return true;
    return implementation.program.steps.every((step) => {
      if (step.op !== "navigate") return true;
      const scene = scenes.get(step.sceneId);
      if (!scene) return false;
      return scene.parameters.filter((parameter) => parameter.required).every((parameter) => {
        const binding = step.bindings[parameter.id];
        return Boolean(binding && (binding.source !== "input" || Boolean(binding.path && capabilityInputIds.has(binding.path))));
      });
    });
  }));
  if (!programBindingsComplete) {
    const rejected: KnowledgeCandidate = { ...evidenced, capability: { ...evidenced.capability, status: "improving" }, validation: { ...evidenced.validation, status: "failed", attempts }, updatedAt: run.endedAt || new Date().toISOString() };
    return { decision: "reject", release, candidate: rejected, reason: "program_binding_incomplete" };
  }
  const operationProofComplete = (operation: KnowledgeCandidate["operations"][number]) => operation.implementations.some((implementation) => {
      const authored = implementation.authored;
      if (!authored?.proof.verifier.success.length) return false;
      // Scene clustering is allowed to replace identifiers, but an executable
      // Release must be self-contained.  A verifier or handoff contract that
      // points at a retired Scene can make a successful navigation look like a
      // failed task in the real browser.
      const sceneReferencesComplete = authored.proof.verifier.success.every((rule) => rule.kind !== "scene" || scenes.has(rule.value));
      if (!sceneReferencesComplete) return false;
      if (authored.kind === "module") {
        return Boolean(authored.module.contentHash && authored.module.moduleUrl && authored.proof.provingRuns?.some((proof) => proof.outcome === "success"));
      }
      const businessOutputIds = Object.keys(candidate.capability.outputs.properties || {}).filter((id) => !["pageUrl", "pageTitle", "pageHeading"].includes(id)
        && candidate.authoring?.resultFields?.find((field) => field.id === id)?.importance !== "optional");
      if ((candidate.capability.resultKind === "data" || businessOutputIds.length > 0) && !businessOutputIds.every((id) => authored.proof.extractionProofs?.some((proof) => proof.fieldId === id) || candidate.authoring?.resultFields?.some((field) => field.id === id && field.source === "input"))) return false;
      const referencedTargetIds = authored.program.steps.flatMap((step): string[] => "targetId" in step && step.targetId ? [step.targetId] : "containerTargetId" in step && step.containerTargetId ? [String(step.containerTargetId)] : []);
      const grounded = new Set(authored.proof.groundedTargetIds);
      const targetsGrounded = referencedTargetIds.every((targetId) => grounded.has(targetId) && candidate.targets.some((target) => target.id === targetId && target.locatorVariants.length > 0));
      if (!targetsGrounded) return false;
      return authored.program.steps.length > 0;
    });
  const candidateOperations = new Map(candidate.operations.map((operation) => [operation.id, operation]));
  const releaseOperations = new Map(release.operations.map((operation) => [operation.id, operation]));
  const authoredProofComplete = candidate.authoring?.stage === "authored"
    && candidate.capability.plans.length > 0
    && candidate.capability.plans.every((plan) => plan.steps.length > 0 && plan.steps.every((step) => {
      const authoredOperation = candidateOperations.get(step.operationId);
      if (authoredOperation) return operationProofComplete(authoredOperation);
      const sharedOperation = releaseOperations.get(step.operationId);
      return Boolean(sharedOperation && (sharedOperation.status === "verified" || sharedOperation.status === "published") && sharedOperation.implementations.length > 0 && sharedOperation.applicability);
    }))
    && candidate.operations.every(operationProofComplete);
  if (!authoredProofComplete) {
    const rejected: KnowledgeCandidate = { ...evidenced, capability: { ...evidenced.capability, status: "improving" }, validation: { ...evidenced.validation, status: "failed", attempts }, updatedAt: run.endedAt || new Date().toISOString() };
    return { decision: "reject", release, candidate: rejected, reason: "ai_authoring_proof_missing" };
  }
  const passed = run.status === "passed" && run.outcome && job.validationCase.expectedStatuses.includes(run.outcome.status) && run.steps.every((step) => step.status !== "failed");
  if (passed) {
    const validated: KnowledgeCandidate = { ...evidenced, capability: { ...evidenced.capability, status: "available" }, validation: { ...evidenced.validation, status: "passed", attempts, successfulReplays: candidate.validation.successfulReplays + 1 }, updatedAt: run.endedAt || new Date().toISOString() };
    return { decision: "publish", release: materializeCandidateRelease(release, { id: `browser-run:${run.id}`, endedAt: run.endedAt || new Date().toISOString() }, validated), candidate: validated, reason: "independent_browser_replay_passed" };
  }
  const transient = new Set(["timeout", "navigation_timeout", "network_error", "page_crashed", "browser_disconnected", "judge_unavailable"]);
  const retry = attempts < job.maxAttempts && run.outcome?.status === "execution-fault" && transient.has(run.outcome.code);
  const failed: KnowledgeCandidate = { ...evidenced, capability: { ...evidenced.capability, status: "improving" }, validation: { ...evidenced.validation, status: retry ? "pending" : "failed", attempts }, updatedAt: run.endedAt || new Date().toISOString() };
  return { decision: retry ? "retry" : "reject", release, candidate: failed, reason: run.outcome?.code || "independent_browser_replay_failed" };
}
