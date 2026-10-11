import {
  stableHash,
  withAgentConfigDefaults,
  type CapabilityDefinition,
  type CapabilitySuppression,
  type ClientDirective,
  type KnowledgeCandidate,
  type LocatorVariant,
  type OperationDefinition,
  type OutcomeSpec,
  type SceneDefinition,
  type SiteAgentReleaseV2,
  type TargetSpec,
  type TaskEpisode,
  type TaskSession,
} from "./protocol";
import { exactCapabilityForGoal, matchCapability } from "./planner";
import { deriveCapabilityTaskTemplates } from "./site-knowledge";

function mergeById<T extends { id: string }>(current: T[], incoming: T[], merge: (left: T, right: T) => T) {
  const values = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) values.set(item.id, values.has(item.id) ? merge(values.get(item.id)!, item) : item);
  return [...values.values()];
}

export function capabilityManagementReleaseId(
  siteAgentId: string,
  nextVersion: number,
  action: "unpublish" | "relist" | "exposure",
  targetId: string,
  requestedAt: string,
  operationId: string,
) {
  if (!operationId) throw new Error("capability_management_operation_id_required");
  return `${siteAgentId}:release:${nextVersion}:${action}:${stableHash(`${targetId}:${requestedAt}`)}:${operationId}`;
}

function mergeScenes(current: SceneDefinition[], incoming: SceneDefinition[]) {
  // Entry readiness follows the side with the newer verify/demote decision, so a
  // demotion is not silently re-promoted by a stale verified copy (matches
  // discovery.mergeSceneEvidence). The entry-verified rung tracks that decision.
  const entryStamp = (scene: SceneDefinition) => Math.max(Date.parse(scene.lastVerifiedAt || "") || 0, Date.parse(scene.demotedAt || "") || 0);
  return mergeById(current, incoming, (left, right) => {
    const entry = entryStamp(right) > entryStamp(left) ? right : left;
    const climbed = right.evidenceStatus || left.evidenceStatus;
    const evidenceStatus = (entry.directEntry === "verified" ? "entry-verified" : climbed === "entry-verified" ? "observed" : climbed) as SceneDefinition["evidenceStatus"];
    return {
      ...left,
      ...right,
      createdAt: left.createdAt || right.createdAt,
      urlTemplates: mergeById(left.urlTemplates, right.urlTemplates, (a, b) => ({ ...a, ...b })),
      sourceObservationIds: [...new Set([...left.sourceObservationIds, ...right.sourceObservationIds])].slice(-100),
      directEntry: entry.directEntry,
      lastVerifiedAt: entry.lastVerifiedAt,
      demotedAt: entry.demotedAt,
      verificationFailure: entry.verificationFailure,
      entryHealth: entry.entryHealth,
      evidenceStatus,
      lifecycle: evidenceStatus as SceneDefinition["lifecycle"],
    };
  });
}

function mergeLocators(current: LocatorVariant[], incoming: LocatorVariant[]) {
  const keyed = new Map<string, LocatorVariant>();
  for (const variant of [...current, ...incoming]) {
    const key = `${variant.strategy}:${variant.role || ""}:${variant.contextTargetId || ""}:${variant.value}`;
    const previous = keyed.get(key);
    keyed.set(key, previous ? {
      ...previous,
      score: Math.max(previous.score, variant.score),
      successes: previous.successes + variant.successes,
      failures: previous.failures + variant.failures,
      lastSeenAt: previous.lastSeenAt > variant.lastSeenAt ? previous.lastSeenAt : variant.lastSeenAt,
    } : variant);
  }
  return [...keyed.values()].sort((a, b) => b.score - a.score).slice(0, 12);
}

function mergeTargets(current: TargetSpec[], incoming: TargetSpec[]) {
  return mergeById(current, incoming, (left, right) => ({
    ...left,
    ...right,
    sceneIds: [...new Set([...left.sceneIds, ...right.sceneIds])],
    accessibleNames: [...new Set([...left.accessibleNames, ...right.accessibleNames])],
    locatorVariants: mergeLocators(left.locatorVariants, right.locatorVariants),
  }));
}

function mergeOperations(current: OperationDefinition[], incoming: OperationDefinition[]) {
  return mergeById(current, incoming, (left, right) => ({
    ...left,
    ...right,
    implementations: mergeById(left.implementations, right.implementations, (a, b) => ({
      ...a,
      ...b,
      successes: a.successes + b.successes,
      failures: a.failures + b.failures,
      sourceEpisodeIds: [...new Set([...a.sourceEpisodeIds, ...b.sourceEpisodeIds])].slice(-100),
    })),
    status: (left.status === "published" || right.status === "published" ? "published" : right.status) as OperationDefinition["status"],
  }));
}

function outcomeFromEpisode(episode: TaskEpisode): OutcomeSpec {
  const classifiers: OutcomeSpec["classifiers"] = [];
  const text = typeof episode.outcome.evidence.text === "string" ? episode.outcome.evidence.text : "";
  if (text) classifiers.push({ kind: "text", value: text });
  return {
    id: `outcome_${stableHash(`${episode.outcome.status}:${episode.outcome.code}`)}`,
    status: episode.outcome.status,
    code: episode.outcome.code,
    description: episode.outcome.summary,
    classifiers,
  };
}

export function materializeCandidateRelease(
  current: SiteAgentReleaseV2,
  episode: Pick<TaskEpisode, "id" | "endedAt">,
  candidate: KnowledgeCandidate,
): SiteAgentReleaseV2 {
  const createdAt = episode.endedAt;
  const capability = { ...candidate.capability, status: "available" as const, confidence: Math.max(0.82, candidate.capability.confidence), updatedAt: createdAt };
  const capabilities = mergeById(current.capabilities, [capability], (left, right) => ({
    ...left,
    ...right,
    aliases: [...new Set([...left.aliases, ...right.aliases])],
    outcomes: mergeById(left.outcomes, right.outcomes, (a, b) => ({ ...a, ...b })),
    sourceEpisodeIds: [...new Set([...left.sourceEpisodeIds, ...right.sourceEpisodeIds])].slice(-100),
  }));
  const next = {
    ...current,
    id: `${current.siteAgentId}:release:${current.version + 1}:${stableHash(`${candidate.id}:${candidate.updatedAt}:${createdAt}`)}`,
    version: current.version + 1,
    createdAt,
    scenes: mergeScenes(current.scenes, candidate.scenes.map((scene) => ({ ...scene, directEntry: "verified" as const, evidenceStatus: "entry-verified" as const, lifecycle: "entry-verified" as const }))),
    targets: mergeTargets(current.targets, candidate.targets),
    operations: mergeOperations(current.operations, candidate.operations.map((operation) => ({ ...operation, status: "published" as const }))),
    capabilities,
    outcomes: mergeById(current.outcomes, capability.outcomes, (a, b) => ({ ...a, ...b })),
    evalSummary: {
      passed: true,
      evaluatedEpisodes: current.evalSummary.evaluatedEpisodes + 1,
      successfulEpisodes: current.evalSummary.successfulEpisodes + 1,
      failedEpisodes: current.evalSummary.failedEpisodes,
      generatedAt: createdAt,
    },
    sourceEpisodeIds: [...new Set([...current.sourceEpisodeIds, ...candidate.sourceEpisodeIds, episode.id])].slice(-200),
  } satisfies Omit<SiteAgentReleaseV2, "contentHash">;
  const taskTemplates = deriveCapabilityTaskTemplates(capabilities, next.navigationTools || []);
  const projected = withAgentConfigDefaults({
    ...next,
    profile: {
      ...next.profile,
      taskTemplates,
      suggestedGoals: taskTemplates.map((task) => task.name),
    },
  });
  const hashable = { ...projected, contentHash: undefined, knowledgeRevision: undefined };
  return { ...projected, contentHash: stableHash(JSON.stringify(hashable)) };
}

function appendOutcome(release: SiteAgentReleaseV2, episode: TaskEpisode) {
  const matched = matchCapability(release, episode.goal)?.capability;
  if (!matched) return release;
  const outcome = outcomeFromEpisode(episode);
  const existing = matched.outcomes.some((item) => item.status === outcome.status && item.code === outcome.code);
  if (existing) return release;
  const createdAt = episode.endedAt;
  const capabilities = release.capabilities.map((capability) => capability.id === matched.id ? {
    ...capability,
    outcomes: [...capability.outcomes, outcome],
    sourceEpisodeIds: [...new Set([...capability.sourceEpisodeIds, episode.id])].slice(-100),
    updatedAt: createdAt,
  } : capability);
  const next = {
    ...release,
    id: `${release.siteAgentId}:release:${release.version + 1}`,
    version: release.version + 1,
    createdAt,
    capabilities,
    outcomes: mergeById(release.outcomes, [outcome], (a, b) => ({ ...a, ...b })),
    sourceEpisodeIds: [...new Set([...release.sourceEpisodeIds, episode.id])].slice(-200),
  };
  const hashable = { ...next, contentHash: undefined, knowledgeRevision: undefined };
  return { ...next, contentHash: stableHash(JSON.stringify(hashable)) };
}

export type CompileState = {
  release: SiteAgentReleaseV2;
  candidates: KnowledgeCandidate[];
  session: TaskSession;
  suppressions?: CapabilitySuppression[];
  triggerAuthority?: "terminal-user-gap";
  /** Explicit BuildRequests keep their own evidence until contract-level deduplication. */
  /** Exact compiled source authenticated and pinned by AgentRun authority. */
  compiledRepairSourceCapabilityId?: string;
};

const COMPILED_CAPABILITY_DRIFT_CODES = new Set([
  "target_not_found",
  "operation_not_found",
  "operation_implementation_not_found",
  "capability_plan_not_found",
  "postcondition_failed",
  "operation_verification_failed",
  "program_verification_failed",
  "scene_not_found",
  "scene_binding_missing",
]);

function publishedDriftSource(state: CompileState, episode: TaskEpisode) {
  const { release } = state;
  if (release.runtimeFeatures?.pageAgentRuntimeV2 !== true) return undefined;
  if (episode.mode !== "compiled" && episode.repairKind !== "compiled-capability-drift") return undefined;
  if (episode.repairKind && episode.repairKind !== "compiled-capability-drift") return undefined;
  if (!COMPILED_CAPABILITY_DRIFT_CODES.has(episode.outcome.code)) return undefined;
  const sourceCapabilityId = episode.sourceCapabilityId || episode.capabilityId;
  if (!sourceCapabilityId) return undefined;
  const source = release.capabilities.find((capability) =>
    capability.id === sourceCapabilityId
    && capability.exposure !== "internal"
    && ["available", "improving"].includes(capability.status));
  // Capability Center V2 runtimes are intentionally omitted from the legacy
  // Release catalog. Only the source projected by AgentRun authorization may
  // stand in for membership; a browser-provided grant id is not authority.
  return source || state.compiledRepairSourceCapabilityId === sourceCapabilityId
    ? sourceCapabilityId
    : undefined;
}

export function compileEpisode(state: CompileState, episode: TaskEpisode): CompileState & { directive: ClientDirective; published: boolean } {
  let { release, candidates, session } = state;

  // A published capability invocation is a runtime health signal.  Its trace
  // can later trigger an enhancement revision, but it must never enter the
  // legacy candidate pipeline and create a duplicate public project.
  const invokedCapability = episode.capabilityId
    ? release.capabilities.find((capability) => capability.id === episode.capabilityId && capability.exposure !== "internal")
    : undefined;
  // A published capability is authoritative even if an older/model-routed
  // client completed the same exact goal through the exploratory page tool
  // and omitted capabilityId. Such a receipt may update health/outcomes, but
  // it must not create a second AI-authored project.
  const reusableCapability = invokedCapability || exactCapabilityForGoal(release, episode.goal);
  if (reusableCapability && ["success", "no-result", "business-rejection"].includes(episode.outcome.status)) {
    const releaseWithOutcome = appendOutcome(release, episode);
    session = { ...session, status: "completed", updatedAt: episode.endedAt };
    return {
      release: releaseWithOutcome,
      candidates,
      session,
      published: releaseWithOutcome.version !== release.version,
      directive: releaseWithOutcome.version !== release.version
        ? { type: "release-updated", session, release: releaseWithOutcome }
        : { type: "complete", session },
    };
  }

  if (episode.outcome.status === "no-result" || episode.outcome.status === "business-rejection") {
    const next = appendOutcome(release, episode);
    const published = next.version !== release.version;
    release = next;
    session = { ...session, status: "completed", updatedAt: episode.endedAt };
    return { release, candidates, session, published, directive: published ? { type: "release-updated", session, release } : { type: "complete", session } };
  }

  if (episode.outcome.status === "execution-fault") {
    const attempt = Number(episode.outcome.evidence.repairAttempt || 0);
    if (release.runtimeFeatures?.pageAgentRuntimeV2 !== true) {
      session = { ...session, status: attempt < 2 ? "running" : "failed", updatedAt: episode.endedAt };
      return {
        release,
        candidates,
        session,
        published: false,
        directive: attempt < 2
          ? { type: "continue-adaptive", session, reason: episode.outcome.summary, attempt: attempt + 1 }
          : { type: "complete", session },
      };
    }
    const sourceCapabilityId = publishedDriftSource(state, episode);
    const inheritedBudget = episode.experience?.budgetEvidence;
    const remainingActiveMs = inheritedBudget
      ? inheritedBudget.activeLimitMs - inheritedBudget.activeElapsedMs
      : 0;
    const remainingModelRequests = inheritedBudget
      ? inheritedBudget.modelRequestLimit - inheritedBudget.modelRequests
      : 0;
    // Runtime V2 repair is not a fresh fallback attempt. It is the same
    // bounded task continuing only when the compiled capability left budget.
    const targetedRepair = Boolean(sourceCapabilityId)
      && attempt < 2
      && Boolean(inheritedBudget)
      && remainingActiveMs > 0
      && remainingModelRequests > 0
      && !inheritedBudget?.exhaustedReason;
    session = { ...session, status: targetedRepair ? "running" : "failed", updatedAt: episode.endedAt };
    return {
      release,
      candidates,
      session,
      published: false,
      directive: targetedRepair
        ? {
            type: "continue-adaptive",
            session,
            reason: episode.outcome.summary,
            attempt: attempt + 1,
            sourceCapabilityId,
            repairKind: "compiled-capability-drift",
            pageExecutionBrief: episode.pageExecutionBrief,
            budgetEvidence: episode.experience?.budgetEvidence,
          }
        : { type: "complete", session },
    };
  }

  const terminalUserCapabilityGap = state.triggerAuthority === "terminal-user-gap"
    && !episode.capabilityId
    && !reusableCapability;
  // Terminal conversations are evidence, not capability production requests.
  // The store aggregates these receipts for a later scheduled proposal pass,
  // and a capability is authored from the capability centre's own proposal
  // pipeline. Real-time authoring from inside this function was reachable only
  // through a control-plane entry point that no route ever called; it is gone,
  // and with it the branch that built a Candidate and a LearningJob here.
  if (terminalUserCapabilityGap && episode.outcome.status === "success") {
    session = { ...session, status: "completed", updatedAt: episode.endedAt };
    return {
      release,
      candidates,
      session,
      published: false,
      directive: { type: "complete", session },
    };
  }

  session = { ...session, status: episode.outcome.status === "success" ? "completed" : "failed", updatedAt: episode.endedAt };
  return { release, candidates, session, published: false, directive: { type: "complete", session } };
}

export function capabilityForGoal(release: SiteAgentReleaseV2, goal: string): CapabilityDefinition | undefined {
  return matchCapability(release, goal)?.capability;
}
