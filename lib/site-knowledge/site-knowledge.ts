import {
  stableHash,
  type CapabilityDefinition,
  type NavigationTool,
  type SceneDefinition,
  type SiteAgentReleaseV2,
  type SuggestedTaskDefinition,
} from "./protocol";
import { isTechnicalCapabilityAdapterId } from "./navigation-tools";

function capabilityTaskInput(capability: CapabilityDefinition, id: string): SuggestedTaskDefinition["requiredInputs"][number] {
  const field = capability.inputs.properties?.[id];
  const type = field?.type === "number" || field?.type === "boolean" ? field.type : "string";
  const name = field?.description?.trim() || id;
  return { id, name, type, prompt: `请提供${name}` }; // i18n-exempt: release data for the model; the widget never displays it
}

function available(capability: CapabilityDefinition) {
  return capability.status === "available" || capability.status === "improving";
}

/**
 * Returns every capability that a terminal user can invoke from the assistant.
 *
 * Exposure is the terminal-user security boundary: only explicitly public,
 * released Capability contracts are eligible. NavigationTools remain
 * knowledge/execution assets; legacy runtime adapters are never discoverable,
 * even if an older runtime response happens to contain one transiently.
 */
export function userInvocableCapabilities(
  release: Pick<SiteAgentReleaseV2, "capabilities" | "navigationTools">,
) {
  return release.capabilities.filter((capability) =>
    available(capability)
    && capability.exposure === "public"
    && !isTechnicalCapabilityAdapterId(capability.id));
}

/** Builds user-facing suggestions from every terminal-user-invocable contract. */
export function deriveCapabilityTaskTemplates(
  capabilities: CapabilityDefinition[],
  _navigationTools: NavigationTool[] = [],
): SuggestedTaskDefinition[] {
  const seen = new Set<string>();
  const tasks: SuggestedTaskDefinition[] = [];
  for (const capability of userInvocableCapabilities({ capabilities, navigationTools: _navigationTools })) {
    const name = capability.name.trim();
    if (!name) continue;
    const key = name.normalize("NFKC").toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push({
      id: `task_${stableHash(capability.id)}`,
      name,
      description: capability.description || name,
      goalTemplate: capability.goalTemplate || name,
      requiredInputs: (capability.inputs.required || Object.keys(capability.inputs.properties || {}))
        .map((id) => capabilityTaskInput(capability, id)),
      confidence: capability.confidence,
    });
  }
  return tasks;
}

export function profileTaskTemplates(release: SiteAgentReleaseV2): SuggestedTaskDefinition[] {
  return deriveCapabilityTaskTemplates(release.capabilities, release.navigationTools || []);
}

function sceneSummary(scene: SceneDefinition) {
  return {
    id: scene.id,
    name: scene.name,
    description: scene.description,
    businessArea: scene.businessArea,
    path: scene.urlTemplates[0]?.pathnamePattern,
    parameters: scene.parameters.map((parameter) => ({ id: parameter.id, name: parameter.name, examples: parameter.examples.slice(0, 3) })),
    verified: scene.directEntry === "verified",
  };
}

/**
 * Produces the small, task-relevant projection consumed by the Actor/Judge.
 * The full knowledge graph remains in the Release; it is never dumped into a
 * prompt wholesale.
 */
export function buildSiteKnowledgeContext(release: SiteAgentReleaseV2, currentSceneId?: string) {
  const current = release.scenes.find((scene) => scene.id === currentSceneId);
  const relatedIds = new Set<string>([currentSceneId || ""]);
  for (const operation of release.operations) {
    if ((operation.fromSceneId === currentSceneId || operation.fromSceneId === "*") && operation.toSceneId) relatedIds.add(operation.toSceneId);
    if (operation.toSceneId === currentSceneId && operation.fromSceneId !== "*") relatedIds.add(operation.fromSceneId);
  }
  const nearbyScenes = current
    ? release.scenes.filter((scene) => relatedIds.has(scene.id)).slice(0, 12)
    : release.scenes.filter((scene) => scene.directEntry === "verified" || (scene.evidenceStatus || scene.lifecycle) !== "referenced").slice(0, 12);
  return {
    product: {
      name: release.profile.name,
      description: release.profile.description,
      category: release.profile.category,
      audiences: release.profile.audiences || [],
      jobsToBeDone: release.profile.jobsToBeDone || [],
      entities: release.profile.entityTypes || [],
      vocabulary: release.profile.vocabulary,
    },
    currentScene: current ? sceneSummary(current) : undefined,
    nearbyScenes: nearbyScenes.map(sceneSummary),
    knownOperations: release.operations.filter((operation) => (operation.fromSceneId === currentSceneId || operation.fromSceneId === "*") && operation.status !== "candidate").slice(0, 16).map((operation) => ({ name: operation.name, toSceneId: operation.toSceneId, effects: operation.effects })),
    taskTemplates: profileTaskTemplates(release).slice(0, 8).map((task) => ({ name: task.name, goalTemplate: task.goalTemplate, requiredInputs: task.requiredInputs, description: task.description })),
    verifiedCapabilities: release.capabilities.filter((capability) => capability.kind !== "navigation" && ["available", "improving"].includes(capability.status)).slice(0, 12).map((capability) => ({ name: capability.name, description: capability.description, inputs: capability.inputs.required || [] })),
  };
}
