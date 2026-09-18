import type {
  CapabilityGenerationInput,
  CapabilityTask,
  CapabilityTaskInput,
  CapabilityTaskStatus,
  CapabilityReplacementPlan,
  DiscoveryRunSpec,
  GenerationTask,
  JsonObject,
  JsonValue,
  RepairRunSpec,
} from "./model";
import { CapabilityCenterV2Error } from "../../db/capability-center-v2-store";

function replacementPlanFromContext(value: unknown): CapabilityReplacementPlan | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const targets = Array.isArray(raw.replacesCapabilityIds) ? raw.replacesCapabilityIds.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
  const reason = typeof raw.reason === "string" ? raw.reason : "";
  if (!targets.length || !reason) return undefined;
  return { replacesCapabilityIds: targets, reason, disableAfterPublish: raw.disableAfterPublish === true };
}

/**
 * Boundary evidence is currently retained only at the A -> B trust boundary.
 * It is not a C-facing Runner input yet, so do not carry the opaque reference
 * payload into the logical GenerationTask projection.
 */
function withoutBoundaryEvidence(value: JsonObject) {
  const output = value.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return value;
  const { boundaryEvidence: _boundaryEvidence, ...rest } = output as JsonObject & { boundaryEvidence?: JsonValue };
  return { ...value, output: rest } as JsonObject;
}

/**
 * The database task is a transport/lease record.  This adapter is the only
 * place where that record is projected into the B → C logical contract.
 */
export function generationTaskFromPhysical(task: CapabilityTask): GenerationTask {
  if (task.type !== "Discovery" && task.type !== "Repair") {
    throw new Error("generation_task_type_invalid");
  }
  const source = task.input.context.__generationSource === "Episode" || task.sourceAgentRunId ? "Episode" : "Admin";
  if (task.status === "WaitingInput") {
    return {
      id: task.id,
      siteId: task.siteId,
      source,
      type: task.type,
      status: "WaitingInput",
      interactions: task.input.interactions,
    };
  }
  if (!task.runSpec) throw new Error("generation_task_run_spec_missing");
  const runSpec = task.runSpec;
  const base = {
    protocolVersion: "2.0" as const,
    id: runSpec.id,
    goal: task.goal,
    ...((Array.isArray(task.input.context.__requirements) || Array.isArray(task.input.context.__derivedGuidance))
      ? {
          guidance: {
            ...(Array.isArray(task.input.context.__requirements) ? { requirements: task.input.context.__requirements as never } : {}),
            ...(Array.isArray(task.input.context.__derivedGuidance)
              ? { derived: task.input.context.__derivedGuidance as never }
              : !Array.isArray(task.input.context.__requirements) && task.guidance
                ? { derived: [{ text: task.guidance, basedOn: [] }] }
                : {}),
          },
        }
      : task.guidance ? { guidance: { derived: [{ text: task.guidance, basedOn: [] }] } } : {}),
    browser: {
      startUrl: runSpec.browser.startUrl || "",
      recording: runSpec.browser.recording,
    },
    input: {
      parameters: runSpec.input.parameters,
      ...(typeof runSpec.input.context.locale === "string" ? { locale: runSpec.input.context.locale } : {}),
      ...(runSpec.input.candidateSummary ? { capabilitySeed: {
        name: runSpec.input.candidateSummary.name || task.goal,
        description: runSpec.input.candidateSummary.description || task.goal,
        aliases: runSpec.input.candidateSummary.aliases || [],
      } } : {}),
      ...(runSpec.input.experience ? { authoringEvidence: { experience: withoutBoundaryEvidence(runSpec.input.experience as unknown as JsonObject) } as JsonObject } : {}),
    },
    ...(replacementPlanFromContext(runSpec.input.context.__replacementPlan) ? { replacementPlan: replacementPlanFromContext(runSpec.input.context.__replacementPlan) } : {}),
  } satisfies DiscoveryRunSpec;
  if (task.type === "Repair") {
    const repair = {
      ...base,
      baseCapabilityId: typeof task.input.context.sourceCapabilityId === "string"
        ? task.input.context.sourceCapabilityId
        : "",
      baseVersionId: task.input.trigger.baseVersionId || "",
    } satisfies RepairRunSpec;
    return {
      id: task.id,
      siteId: task.siteId,
      source,
      type: "Repair",
      status: "Pending",
      runSpec: repair,
    };
  }
  return {
    id: task.id,
    siteId: task.siteId,
    source,
    type: "Discovery",
    status: "Pending",
    runSpec: base,
  };
}

/** Normalize a B input before it reaches semantic classification. */
export function assertCapabilityGenerationInput(input: CapabilityGenerationInput) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CapabilityCenterV2Error("generation_input_invalid");
  const raw = input as unknown as Record<string, unknown>;
  const allowedTop = new Set(["request", "requirements", "source", "experience", "instruction"]);
  if (Object.keys(raw).some((key) => !allowedTop.has(key))) throw new CapabilityCenterV2Error("generation_input_unknown_field");
  const request = raw.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new CapabilityCenterV2Error("generation_request_required");
  const requestRecord = request as Record<string, unknown>;
  const allowedRequest = new Set(["goal", "parameters", "entryUrl", "locale"]);
  if (Object.keys(requestRecord).some((key) => !allowedRequest.has(key))) throw new CapabilityCenterV2Error("generation_input_unknown_field");
  if (!input.request.goal.trim()) throw new CapabilityCenterV2Error("generation_goal_required");
  if (!input.request.entryUrl.trim()) throw new CapabilityCenterV2Error("generation_entry_url_required");
  if (input.requirements !== undefined) {
    if (!Array.isArray(input.requirements)) throw new CapabilityCenterV2Error("generation_requirements_invalid");
    for (const requirement of input.requirements) {
      if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)
        || typeof requirement.text !== "string" || !requirement.text.trim()
        || (requirement.authority !== "Admin" && requirement.authority !== "Policy")) {
        throw new CapabilityCenterV2Error("generation_requirement_authority_invalid");
      }
    }
  }
  if (input.source === "Episode") {
    if (!input.experience.episodeId) throw new CapabilityCenterV2Error("generation_episode_required");
  } else {
    const operation = input.instruction.operation;
    if ((operation === "repair" || operation === "rebuild") && !input.instruction.targetCapabilityId) {
      throw new CapabilityCenterV2Error("generation_target_capability_required");
    }
    if (operation === "create" && input.instruction.targetCapabilityId) throw new CapabilityCenterV2Error("generation_create_target_forbidden");
  }
  return input;
}

/**
 * Convert the logical RunSpec back to the legacy storage input.  The adapter
 * keeps lease and persistence details out of the module contract while the
 * existing runner is migrated incrementally.
 */
export function generationTaskInput(task: GenerationTask): Partial<CapabilityTaskInput> {
  if (task.status === "WaitingInput") return { interactions: task.interactions, parameters: {}, context: {}, trigger: {} };
  return {
    parameters: task.runSpec.input.parameters,
    context: {
      ...(task.runSpec.input.locale ? { locale: task.runSpec.input.locale } : {}),
      startUrl: task.runSpec.browser.startUrl,
    },
    interactions: [],
    trigger: task.type === "Repair" ? { baseVersionId: task.runSpec.baseVersionId } : {},
    candidateSummary: task.runSpec.input.capabilitySeed ? {
      name: task.runSpec.input.capabilitySeed.name,
      description: task.runSpec.input.capabilitySeed.description,
      aliases: task.runSpec.input.capabilitySeed.aliases,
    } : undefined,
  };
}

export function isPendingGenerationTask(task: GenerationTask): task is Exclude<GenerationTask, { status: "WaitingInput" }> {
  return task.status === "Pending";
}

export function normalizeBoundaryStatus(status: CapabilityTaskStatus): "Pending" | "WaitingInput" {
  return status === "WaitingInput" ? "WaitingInput" : "Pending";
}
