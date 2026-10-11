import type { Capability, CapabilityVersion } from "./model";
import {
  normalizeGoal,
  stableHash,
  withAgentConfigDefaults,
  type CapabilityDefinition,
  type CapabilityPlan,
  type OperationDefinition,
  type SiteAgentReleaseV2,
} from "../site-knowledge/protocol";
import { deriveCapabilityTaskTemplates } from "../site-knowledge/site-knowledge";

const ownedOperationPrefix = (capabilityId: string) =>
  `capability-version-operation:${capabilityId}:`;

function publishedVersion(capability: Capability, version: CapabilityVersion) {
  if (capability.siteAgentId !== version.siteAgentId
    || capability.id !== version.capabilityId) {
    throw new Error("capability_version_identity_mismatch");
  }
  if (capability.currentVersionId !== version.id) {
    throw new Error("capability_current_version_mismatch");
  }
  if (version.status !== "published") {
    throw new Error("capability_version_not_published");
  }
  if (version.validation?.status !== "passed") {
    throw new Error("capability_version_not_validated");
  }
}

function programOperation(
  capability: Capability,
  version: CapabilityVersion,
  now: string,
): OperationDefinition | undefined {
  const implementation = version.implementation;
  const program = implementation?.kind === "program"
    ? implementation.pageProgram
    : implementation?.kind === "page-program"
      ? implementation.program
      : undefined;
  if (!program) return undefined;
  return {
    id: `${ownedOperationPrefix(capability.id)}${version.id}`,
    name: capability.name,
    description: capability.description,
    kind: capability.kind === "navigation" ? "navigation" : "task",
    evidenceSource: "compiled-task",
    applicability: {
      scope: "any-scene",
      evidenceSceneIds: [],
    },
    fromSceneId: "*",
    inputs: capability.inputSchema,
    outputs: capability.outputSchema,
    preconditions: [],
    effects: [],
    implementations: [{
      id: `${ownedOperationPrefix(capability.id)}${version.id}:implementation`,
      program,
      conditions: [],
      successes: 1,
      failures: 0,
      sourceEpisodeIds: [],
    }],
    verification: {},
    status: "published",
    updatedAt: now,
  };
}

function implementationPlan(
  release: SiteAgentReleaseV2,
  capability: Capability,
  version: CapabilityVersion,
  generatedOperation?: OperationDefinition,
): CapabilityPlan[] {
  const implementation = version.implementation;
  if (!implementation) throw new Error("capability_version_implementation_missing");
  if (generatedOperation) {
    return [{
      id: `capability-version-plan:${version.id}`,
      entrySceneIds: ["*"],
      steps: [{
        operationId: generatedOperation.id,
        bindings: "inputBindings" in implementation
          ? implementation.inputBindings || {}
          : {},
      }],
      outputBindings: "outputBindings" in implementation
        ? implementation.outputBindings || {}
        : {},
    }];
  }
  if (implementation.kind === "program" || implementation.kind === "module") {
    return [];
  }
  if (implementation.kind === "navigation-tool") {
    const tool = (release.navigationTools || []).find((item) =>
      item.id === implementation.toolRef.toolId);
    if (!tool
      || tool.source.knowledgeRevision !== implementation.toolRef.knowledgeRevision
      || tool.source.dependencyHash !== implementation.toolRef.dependencyHash) {
      throw new Error("capability_version_navigation_tool_mismatch");
    }
    const strategy = tool.strategies.find((item) =>
      release.operations.some((operation) => operation.id === item.operationId));
    if (!strategy) throw new Error("capability_version_navigation_operation_missing");
    return [{
      id: `capability-version-plan:${version.id}`,
      entrySceneIds: tool.applicability.sceneIds?.length
        ? tool.applicability.sceneIds
        : ["*"],
      steps: [{
        operationId: strategy.operationId,
        bindings: implementation.inputBindings || {},
      }],
      outputBindings: implementation.outputBindings || {},
    }];
  }
  if (implementation.kind === "workflow") {
    const steps = implementation.nodes.flatMap((node) => {
      const dependency = release.capabilities.find((item) => item.id === node.capabilityId);
      if (!dependency) throw new Error("capability_version_workflow_dependency_missing");
      const plan = dependency.plans[0];
      if (!plan) throw new Error("capability_version_workflow_plan_missing");
      return plan.steps;
    });
    return [{
      id: `capability-version-plan:${version.id}`,
      entrySceneIds: ["*"],
      steps,
      outputBindings: implementation.outputBindings || {},
    }];
  }
  throw new Error("capability_version_implementation_unsupported");
}

/** Combines the stable contract with one immutable implementation snapshot. */
export function materializeCapabilityVersion(
  release: SiteAgentReleaseV2,
  capability: Capability,
  version: CapabilityVersion,
  now = new Date().toISOString(),
) {
  publishedVersion(capability, version);
  const generatedOperation = programOperation(capability, version, now);
  const plans = implementationPlan(release, capability, version, generatedOperation);
  const implementation = version.implementation;
  const moduleRef = implementation?.kind === "program"
    ? implementation.moduleRef
    : implementation?.kind === "module"
      ? implementation.module
      : undefined;
  const runtimeCapability: CapabilityDefinition = {
    id: capability.id,
    origin: "administrator",
    kind: capability.kind,
    resultKind: capability.resultKind,
    exposure: capability.exposure,
    name: capability.name,
    // Carry the bilingual names. The widget picks by visitor language and falls back to
    // name — without them Chinese visitors only see the English name the proposal path
    // generated, while the Chinese name sits in the capability center.
    localizedNames: capability.localizedNames,
    description: capability.description,
    normalizedGoal: normalizeGoal(capability.goalTemplate || capability.name),
    goalTemplate: capability.goalTemplate,
    aliases: [],
    inputs: capability.inputSchema,
    outputs: capability.outputSchema,
    ...(moduleRef ? { module: moduleRef } : {}),
    outcomes: [],
    plans,
    sourceEpisodeIds: [],
    confidence: 1,
    status: capability.status === "degraded" ? "improving" : "available",
    updatedAt: now,
  };
  return {
    capability: runtimeCapability,
    operations: generatedOperation ? [generatedOperation] : [],
  };
}

function finalizedRelease(
  current: SiteAgentReleaseV2,
  capabilities: CapabilityDefinition[],
  operations: OperationDefinition[],
  action: string,
  capabilityId: string,
  now: string,
) {
  const navigationTools = current.navigationTools || [];
  const taskTemplates = deriveCapabilityTaskTemplates(capabilities, navigationTools);
  const next = withAgentConfigDefaults({
    ...current,
    id: `${current.siteAgentId}:release:${current.version + 1}:${stableHash(`${action}:${capabilityId}:${now}`)}`,
    version: current.version + 1,
    createdAt: now,
    capabilities,
    operations,
    navigationTools,
    profile: {
      ...current.profile,
      taskTemplates,
      suggestedGoals: taskTemplates.map((task) => task.name),
    },
  });
  const hashable = { ...next, contentHash: undefined, knowledgeRevision: undefined };
  return { ...next, contentHash: stableHash(JSON.stringify(hashable)) };
}

/** Creates the immutable runtime Release selected by a newly published Version. */
export function publishCapabilityRuntimeRelease(
  current: SiteAgentReleaseV2,
  capability: Capability,
  version: CapabilityVersion,
  now = new Date().toISOString(),
) {
  const materialized = materializeCapabilityVersion(current, capability, version, now);
  const capabilities = [
    ...current.capabilities.filter((item) => item.id !== capability.id),
    materialized.capability,
  ];
  const operations = [
    ...current.operations.filter((item) =>
      !item.id.startsWith(ownedOperationPrefix(capability.id))),
    ...materialized.operations,
  ];
  const release = finalizedRelease(
    current,
    capabilities,
    operations,
    "publish",
    capability.id,
    now,
  );
  return {
    release,
    capability: materialized.capability,
    version: {
      ...version,
      publishedReleaseId: release.id,
      publishedReleaseVersion: release.version,
      publishedAt: version.publishedAt || now,
      updatedAt: now,
    },
  };
}

function withoutCapabilityRuntime(
  current: SiteAgentReleaseV2,
  capabilityId: string,
  action: "unpublish" | "delete",
  now: string,
) {
  const capabilities = current.capabilities.filter((item) => item.id !== capabilityId);
  const referencedOperations = new Set(capabilities.flatMap((item) =>
    item.plans.flatMap((plan) => plan.steps.map((step) => step.operationId))));
  const operations = current.operations.filter((item) =>
    !item.id.startsWith(ownedOperationPrefix(capabilityId))
    || referencedOperations.has(item.id));
  return finalizedRelease(current, capabilities, operations, action, capabilityId, now);
}

export function unpublishCapabilityRuntimeRelease(
  current: SiteAgentReleaseV2,
  capabilityId: string,
  now = new Date().toISOString(),
) {
  return withoutCapabilityRuntime(current, capabilityId, "unpublish", now);
}

export function deleteCapabilityRuntimeRelease(
  current: SiteAgentReleaseV2,
  capabilityId: string,
  now = new Date().toISOString(),
) {
  return withoutCapabilityRuntime(current, capabilityId, "delete", now);
}

export const relistCapabilityRuntimeRelease = publishCapabilityRuntimeRelease;
