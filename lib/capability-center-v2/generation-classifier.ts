import {
  findActiveClassificationReservationsByName,
  findLiveCapabilityByName,
  CapabilityCenterV2Error,
  createCapabilityTask,
  getCapability,
  getTask,
  findActiveCapabilityClassificationReservation,
  reserveCapabilityClassification,
} from "../../db/capability-center-v2-store";
import { findDuplicateCapability } from "./duplicate-matcher";
import { isTerminalTaskStatus } from "./model";
import type {
  CapabilityContract,
  CapabilityGenerationInput,
  CapabilityTaskInput,
  CapabilitySeed,
  ExperienceClassificationResult,
  GenerationTask,
  JsonObject,
  JsonValue,
} from "./model";
import { assertCapabilityGenerationInput, generationTaskFromPhysical } from "./generation-boundary";
import { projectCapabilityContract, projectCapabilityScope, withoutSemanticDependencies } from "./semantic-analyzer";

type ClassifierOptions = {
  /** Internal transport identity; not part of the B business input. */
  sourceAgentRunId?: string;
  /** Candidate summary is the result of B's abstraction step. */
  candidate?: CapabilitySeed;
  /** Optional full Contract produced by B's abstraction/semantic gate. */
  contract?: CapabilityContract;
  /** Existing episode receipt kept only for C authoring evidence. */
  experience?: CapabilityTaskInput["experience"];
  repair?: { capabilityId: string; baseVersionId: string };
  autoDispatch?: (task: GenerationTask) => Promise<void> | void;
};

function taskInput(input: CapabilityGenerationInput, options: ClassifierOptions): CapabilityTaskInput {
  const candidate = options.candidate;
  const context: CapabilityTaskInput["context"] = {
    startUrl: input.request.entryUrl,
    ...(input.request.locale ? { locale: input.request.locale } : {}),
    versionSource: input.source === "Admin" ? "Admin" : "User",
    __pipelineVersion: "2.0",
    // Internal transport metadata. The logical GenerationTask source must not
    // depend on fabricating an AgentRun id for boundary tests.
    __generationSource: input.source,
    ...(input.requirements?.length ? { __requirements: input.requirements } : {}),
    ...(candidate?.semantic ? {
      __derivedGuidance: [{
        // Read by the authoring models and shown in the task record: English, not prose for one reader.
        text: `Capability goal as abstracted from the session: ${candidate.intent}`,
        basedOn: candidate.semantic.evidenceRefs.map((id) => ({ kind: "observation", id })),
      }],
    } : {}),
  };
  const base: CapabilityTaskInput = {
    parameters: input.request.parameters,
    context,
    interactions: [],
    trigger: {},
    candidateSummary: {
      name: candidate?.name || input.request.goal,
      description: candidate?.description || input.request.goal,
      aliases: candidate?.aliases || [],
      ...(candidate?.replacementPlan ? { replacementPlan: candidate.replacementPlan } : {}),
    },
    ...(options.experience ? { experience: options.experience } : {}),
    ...(candidate?.replacementPlan ? { context: { ...context, __replacementPlan: candidate.replacementPlan, __replacementCapabilityIds: candidate.replacementPlan.replacesCapabilityIds } } : {}),
  };
  if (input.source === "Admin" && (input.instruction.operation === "repair" || input.instruction.operation === "rebuild")) {
    // The caller resolves the base version and injects it through the private
    // context marker.  It is physical routing data, not a module contract.
    base.context.__targetCapabilityId = input.instruction.targetCapabilityId as JsonValue;
  }
  return base;
}

function candidateContract(candidate: CapabilitySeed, override?: CapabilityContract): CapabilityContract {
  if (override) return projectCapabilityContract(override);
  const semantic = withoutSemanticDependencies(candidate.semantic);
  const properties = Object.fromEntries(candidate.semantic.parameters.map((parameter) => [parameter.path, {
    type: parameter.example === undefined ? "string" : typeof parameter.example,
  }])) as JsonObject;
  return {
    intent: candidate.intent,
    inputSchema: {
      type: "object",
      properties,
      required: candidate.semantic.parameters.filter((parameter) => parameter.userSupplied).map((parameter) => parameter.path),
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: {}, additionalProperties: true },
    preconditions: [],
    successConditions: [],
    ...(projectCapabilityScope(semantic.scopeDecision.scope) ? { scope: projectCapabilityScope(semantic.scopeDecision.scope) } : {}),
  };
}

function duplicateResult(match: { id: string; status: "Active" | "Disabled" | "Building" | "Deleted" }, reason: string): ExperienceClassificationResult {
  return {
    disposition: match.status === "Disabled" ? "Disabled" : "Duplicate",
    match: {
      capabilityId: match.id,
      status: match.status === "Disabled" ? "Disabled" : "Active",
      reason,
    },
  };
}

async function classificationReservationHash(candidateName: string, operation: string, capabilityId: string | undefined, semantic: CapabilitySeed["semantic"] | null) {
  const bytes = new TextEncoder().encode(JSON.stringify({ candidateName, operation, capabilityId, contract: semantic ? withoutSemanticDependencies(semantic) : null }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * B's single public operation.  It owns semantic duplicate authority and is
 * the only function that creates a C-facing GenerationTask.
 */
export async function classifyCapabilityGeneration(
  siteId: string,
  rawInput: CapabilityGenerationInput,
  options: ClassifierOptions = {},
): Promise<ExperienceClassificationResult> {
  const input = assertCapabilityGenerationInput(rawInput);
  let candidate = options.candidate;
  const operation = options.repair ? "repair" : input.source === "Admin" ? input.instruction.operation : "create";
  const summary = candidate ? {
    name: candidate.name,
    description: candidate.description,
    aliases: candidate.aliases,
    contract: candidateContract(candidate, options.contract),
  } : undefined;
  const duplicate = operation === "create" ? await findDuplicateCapability(siteId, input.request.goal, summary) : undefined;
  const replacementTargets = new Set(candidate?.replacementPlan?.replacesCapabilityIds || []);
  if (duplicate && !replacementTargets.has(duplicate.id)) return duplicateResult(duplicate, "B semantic classification matched an existing capability");
  // Not a duplicate, and named like a live capability: publication would set
  // it aside as already published. "Add product to cart" with a quantity was
  // judged a capability of its own, then dropped for the live "Add product to
  // cart" that has no quantity, and the visitor's three mugs became one. It
  // is named for what it adds.
  // The same holds for a generation still in flight under that name: two
  // ran at once, neither name was live yet, and the second was dropped at
  // publication for the first.
  if (operation === "create" && candidate) {
    const live = await findLiveCapabilityByName(siteId, candidate.name);
    const inFlight = live ? [] : await findActiveClassificationReservationsByName(siteId, candidate.name);
    const reserving = inFlight.length ? await getTask(siteId, inFlight[0].generationTaskId, true) : undefined;
    // The inputs the taken name stands for: the live contract's, or the
    // values the in-flight generation was demonstrated with.
    const takenInputs = live && !replacementTargets.has(live.id)
      ? Object.keys((live.contract.inputSchema.properties || {}) as Record<string, unknown>)
      : reserving && !(options.sourceAgentRunId && reserving.sourceAgentRunId === options.sourceAgentRunId) ? Object.keys(reserving.input.parameters || {}) : undefined;
    if (takenInputs) {
      const liveInputs = takenInputs;
      const added = candidate.semantic.parameters.map((parameter) => parameter.path).filter((path) => !liveInputs.includes(path));
      const words = (path: string) => path.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/[_-]+/gu, " ").toLocaleLowerCase();
      // Only a generation that asks for more than the taken name's contract
      // is renamed; one that asks for the same is a duplicate, and the checks
      // below are what say so.
      if (added.length) {
        candidate = { ...candidate, name: `${candidate.name} (with ${added.map(words).join(", ")})` };
        options = { ...options, candidate };
      }
    }
  }

  const candidateName = candidate?.name || input.request.goal;
  const createReservationHash = await classificationReservationHash(candidateName, operation, options.repair?.capabilityId, candidate?.semantic || null);
  if (operation === "create") {
    const reservation = await findActiveCapabilityClassificationReservation(siteId, createReservationHash);
    if (reservation) {
      const existingTask = await getTask(siteId, reservation.generationTaskId, true);
      const validationTaskId = existingTask?.result?.validationTaskId;
      const validationTask = validationTaskId ? await getTask(siteId, validationTaskId, true) : undefined;
      const inFlight = Boolean(existingTask && (
        !isTerminalTaskStatus(existingTask.status)
        || Boolean(validationTask && !isTerminalTaskStatus(validationTask.status))
      ));
      if (inFlight) {
        if (existingTask && options.sourceAgentRunId && existingTask.sourceAgentRunId === options.sourceAgentRunId) {
          return { disposition: "Created" as const, task: generationTaskFromPhysical(existingTask) };
        }
        return { disposition: "Duplicate" as const, match: { status: "Active" as const, reason: `B classification already has an in-flight semantic reservation (${reservation.generationTaskId})` } };
      }
    }
  }

  const type: "Discovery" | "Repair" = operation === "repair" || operation === "rebuild" ? "Repair" : "Discovery";
  let capabilityId: string | undefined;
  let baseVersionId: string | undefined;
  if (type === "Repair") {
    capabilityId = options.repair?.capabilityId || (input.source === "Admin" ? input.instruction.targetCapabilityId : undefined);
    if (!capabilityId) throw new CapabilityCenterV2Error("generation_target_capability_required");
    const capability = await getCapability(siteId, capabilityId, true);
    if (!capability || capability.status === "Deleted") throw new CapabilityCenterV2Error("capability_not_found", "capability_not_found", 404);
    baseVersionId = options.repair?.baseVersionId || capability.currentVersionId;
    if (!baseVersionId) throw new CapabilityCenterV2Error("repair_base_version_required", "repair_base_version_required", 409);
  }
  const physicalInput = taskInput(input, options);
  if (type === "Repair") physicalInput.trigger = { baseVersionId, errorCode: "classification_repair" };
  let created: Awaited<ReturnType<typeof createCapabilityTask>>;
  try {
    created = await createCapabilityTask(siteId, {
      type,
      capabilityId,
      goal: input.request.goal,
      guidance: input.requirements?.map((item) => item.text).join("\n"),
      input: physicalInput,
      sourceAgentRunId: options.sourceAgentRunId,
      ...(type === "Repair" && capabilityId ? { maintenance: { mode: "Repair", capabilityId } } : {}),
    });
  } catch (error) {
    if (error instanceof CapabilityCenterV2Error && error.code === "capability_duplicate") {
      return { disposition: "Duplicate", match: { reason: error.message } };
    }
    throw error;
  }
  const reservationHash = operation === "create"
    ? createReservationHash
    : await classificationReservationHash(candidateName, operation, capabilityId, candidate?.semantic || null);
  await reserveCapabilityClassification(siteId, created.task.id, candidateName, reservationHash);
  const task = generationTaskFromPhysical(created.task);
  await options.autoDispatch?.(task);
  return { disposition: "Created", task };
}

export type { ClassifierOptions };
