import {
  normalizeGoal,
  stableHash,
  type CapabilityDefinition,
  type CapabilityProject,
  type NavigationTool,
  type SiteAgentReleaseV2,
} from "./protocol";
import type { CapabilityControlProjection } from "./capability-control";
import { classifyGoal } from "./navigation-tools";
import {
  capabilityContractFingerprint,
  capabilityProjectStableKey,
  navigationCapabilityStableKey,
  navigationToolAsset,
  normalizedNavigationIntent,
  representativeNavigationTool,
} from "./capability-identity";

function releaseCapabilityResultKind(capability: CapabilityDefinition) {
  if (capability.resultKind) return capability.resultKind;
  const businessOutputs = Object.keys(capability.outputs.properties || {})
    .filter((key) => !["pageUrl", "pageTitle", "pageHeading", "sceneId"].includes(key));
  return businessOutputs.length ? "data" as const : "page" as const;
}

export function canonicalReleaseCapabilityProject(siteAgentId: string, capability: CapabilityDefinition): CapabilityProject {
  const kind = capability.kind || (classifyGoal(capability.goalTemplate || capability.name) === "navigation" ? "navigation" : "task");
  const intentKey = `capability_${capability.id}`;
  const available = capability.status === "available" || capability.status === "improving";
  const resultKind = releaseCapabilityResultKind(capability);
  const contractFingerprint = capabilityContractFingerprint({
    kind,
    resultKind,
    inputs: capability.inputs,
    outputs: capability.outputs,
  });
  const stableKey = capabilityProjectStableKey({
    kind,
    resultKind,
    goalTemplate: capability.goalTemplate || capability.name,
    name: capability.name,
    inputSchema: capability.inputs,
    outputSchema: capability.outputs,
  });
  return {
    id: `project_${stableHash(`${siteAgentId}:${intentKey}:${kind}`)}`,
    siteAgentId,
    stableKey,
    contractFingerprint,
    intentKey,
    name: capability.name,
    description: capability.description,
    goalTemplate: capability.goalTemplate || capability.name,
    requestedGoal: capability.goalTemplate || capability.name,
    origin: capability.origin || (kind === "navigation" ? "knowledge-compiled" : "administrator"),
    triggeredBy: capability.origin === "user-triggered"
      ? "user"
      : capability.origin === "administrator"
        ? "administrator"
        : "system",
    generatedBy: capability.origin === "administrator"
      ? "administrator"
      : capability.origin === "knowledge-compiled"
        ? "program"
        : "ai",
    status: available ? "available" : "building",
    stage: available ? "publish" : "design",
    kind,
    structure: "atomic",
    operation: kind === "navigation" ? "read" : resultKind === "action" ? "write" : "read",
    exposure: capability.exposure || "public",
    resultKind,
    activeCapabilityId: capability.id,
    inputSchema: capability.inputs,
    outputSchema: capability.outputs,
    implementationAssets: [],
    executionRequirements: {
      authentication: available ? "none" : "unknown",
      supportedEnvironments: {
        connectedBrowser: "supported",
        cloudBrowser: capability.module ? "supported" : "unverified",
        managedProfile: "blocked",
      },
      checkpoints: [],
      evidenceRefs: capability.sourceEpisodeIds,
    },
    health: {
      lastValidatedAt: available ? capability.updatedAt : undefined,
      recentRuns: 0,
      recentSuccesses: 0,
    },
    revisionCount: 0,
    createdAt: capability.updatedAt,
    updatedAt: capability.updatedAt,
  };
}

function canonicalNavigationToolProject(
  siteAgentId: string,
  tools: NavigationTool[],
  release: SiteAgentReleaseV2,
  runtimeAdapter?: CapabilityDefinition,
): CapabilityProject {
  const tool = representativeNavigationTool(tools);
  const names = tools.map((candidate) => candidate.name.trim()).filter(Boolean);
  const commonAffixName = (() => {
    if (names.length < 2) return tool.name;
    const values = names.map((name) => [...name]);
    const shortest = Math.min(...values.map((value) => value.length));
    let prefixLength = 0;
    while (prefixLength < shortest
      && values.every((value) => value[prefixLength] === values[0][prefixLength])) prefixLength += 1;
    let suffixLength = 0;
    while (suffixLength < shortest - prefixLength
      && values.every((value) => value[value.length - suffixLength - 1] === values[0][values[0].length - suffixLength - 1])) suffixLength += 1;
    const prefix = values[0].slice(0, prefixLength).join("");
    const suffix = suffixLength ? values[0].slice(values[0].length - suffixLength).join("") : "";
    const collapsed = `${prefix}${suffix}`.replace(/\s+/g, " ").trim();
    return collapsed.length >= 2 ? collapsed : tool.name;
  })();
  const stableKey = navigationCapabilityStableKey(tool, release.scenes, release.linkReferences);
  const capabilityId = `navigation-tool:${tool.id}`;
  const intentKey = `navigation_capability_${stableHash(stableKey)}`;
  const humanAuthored = tool.source.kind === "human";
  const contractFingerprint = capabilityContractFingerprint({
    kind: "navigation",
    resultKind: "page",
    inputs: tool.inputs,
    outputs: tool.outputs,
  });
  const verified = tools.some((candidate) => candidate.status === "verified");
  const building = tools.some((candidate) => candidate.status === "candidate");
  const createdAt = [...tools].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0]?.updatedAt || tool.updatedAt;
  const updatedAt = [...tools].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.updatedAt || tool.updatedAt;
  return {
    id: `project_${stableHash(`${siteAgentId}:${stableKey}`)}`,
    siteAgentId,
    stableKey,
    contractFingerprint,
    intentKey,
    name: commonAffixName,
    description: tools.length > 1
      ? `同一导航目标族的 ${tools.length} 个实现资产，按具体页面选择可用实现。`
      : tool.description,
    goalTemplate: commonAffixName,
    requestedGoal: commonAffixName,
    origin: humanAuthored ? "administrator" : "knowledge-compiled",
    triggeredBy: humanAuthored ? "administrator" : "system",
    generatedBy: humanAuthored ? "administrator" : "program",
    status: verified ? "available" : building ? "building" : "degraded",
    stage: verified ? "publish" : building ? "design" : "validate",
    kind: "navigation",
    structure: "atomic",
    operation: "read",
    exposure: runtimeAdapter?.exposure || "internal",
    resultKind: "page",
    activeCapabilityId: capabilityId,
    inputSchema: tool.inputs,
    outputSchema: tool.outputs,
    implementationAssets: tools.map((candidate) => navigationToolAsset(candidate, release.scenes)),
    executionRequirements: {
      authentication: "unknown",
      supportedEnvironments: {
        connectedBrowser: "supported",
        cloudBrowser: "unverified",
        managedProfile: "blocked",
      },
      checkpoints: [],
      evidenceRefs: tool.source.evidenceRefs,
    },
    health: {
      lastValidatedAt: verified ? updatedAt : undefined,
      recentRuns: 0,
      recentSuccesses: 0,
      failureClass: !verified && !building ? "runtime-regression" : undefined,
      recommendedAction: !verified && !building ? "re-explore" : undefined,
    },
    revisionCount: 0,
    createdAt,
    updatedAt,
  };
}

function normalizedIntentTerms(...values: Array<string | undefined>) {
  return values.flatMap((value) => {
    const normalized = value ? normalizeGoal(value) : "";
    return normalized ? [normalized] : [];
  });
}

/**
 * Adds release-only capabilities to the capability-control projection.
 *
 * Navigation runtime adapters are materialized twice inside a Release:
 * `capability_shared_nav_*` is discovery's executable compatibility view and
 * `navigation-tool:*` is the canonical adapter for a first-class
 * `NavigationTool`. The capability center must expose the logical tool once,
 * never both runtime representations. A managed capability with the same
 * normalized intent also wins over its knowledge-compiled fallback.
 */
export function withCanonicalReleaseProjects(
  siteAgentId: string,
  release: SiteAgentReleaseV2,
  projection: CapabilityControlProjection,
) {
  const navigationToolCapabilityIds = new Set((release.navigationTools || []).map((tool) => `navigation-tool:${tool.id}`));
  const navigationToolIntentTerms = new Set((release.navigationTools || []).flatMap((tool) =>
    normalizedIntentTerms(tool.name, ...tool.aliases)));
  const projects = projection.projects.filter((project) => {
    const capabilityId = project.activeCapabilityId || "";
    if (navigationToolCapabilityIds.has(capabilityId)) return false;
    if (!capabilityId.startsWith("capability_shared_nav_")) return true;
    return !normalizedIntentTerms(project.name, project.goalTemplate, project.requestedGoal)
      .some((term) => navigationToolIntentTerms.has(term));
  });
  const visibleProjectIds = new Set(projects.map((project) => project.id));
  const activeCapabilityIds = new Set(projects.flatMap((project) => project.activeCapabilityId ? [project.activeCapabilityId] : []));
  const addProject = (project: CapabilityProject) => {
    projects.push(project);
    if (project.activeCapabilityId) activeCapabilityIds.add(project.activeCapabilityId);
  };

  for (const capability of release.capabilities) {
    if (capability.status !== "available" && capability.status !== "improving") continue;
    if (capability.id.startsWith("capability_shared_nav_")
      && normalizedIntentTerms(capability.name, capability.goalTemplate, ...capability.aliases)
        .some((term) => navigationToolIntentTerms.has(term))) continue;
    if (capability.id.startsWith("navigation-tool:") && navigationToolCapabilityIds.has(capability.id)) continue;
    if (activeCapabilityIds.has(capability.id)) continue;
    addProject(canonicalReleaseCapabilityProject(siteAgentId, capability));
  }

  for (let index = 0; index < projects.length; index += 1) {
    const project = projects[index];
    const resultKind = project.resultKind || "page";
    projects[index] = {
      ...project,
      stableKey: project.stableKey || capabilityProjectStableKey(project),
      contractFingerprint: project.contractFingerprint || capabilityContractFingerprint({
        kind: project.kind,
        resultKind,
        inputs: project.inputSchema,
        outputs: project.outputSchema,
      }),
      structure: project.structure || "atomic",
      operation: project.kind === "navigation"
        ? "read"
        : project.operation || (resultKind === "action" ? "write" : "read"),
      implementationAssets: project.implementationAssets || [],
    };
  }

  const navigationGroups = new Map<string, NavigationTool[]>();
  for (const tool of release.navigationTools || []) {
    const key = navigationCapabilityStableKey(tool, release.scenes, release.linkReferences);
    navigationGroups.set(key, [...(navigationGroups.get(key) || []), tool]);
  }

  const mergeAssets = (project: CapabilityProject, tools: NavigationTool[], stableKey?: string) => {
    const assets = new Map((project.implementationAssets || []).map((asset) => [asset.id, asset]));
    for (const tool of tools) assets.set(tool.id, navigationToolAsset(tool, release.scenes));
    return {
      ...project,
      ...(stableKey ? { stableKey } : {}),
      implementationAssets: [...assets.values()].sort((left, right) =>
        left.targetSceneName?.localeCompare(right.targetSceneName || "") || left.id.localeCompare(right.id)),
    };
  };

  for (const tools of navigationGroups.values()) {
    const representative = representativeNavigationTool(tools);
    const toolTerms = new Set(tools.flatMap((tool) => [tool.name, ...tool.aliases])
      .map(normalizedNavigationIntent)
      .filter(Boolean));
    const operationIds = new Set(tools.flatMap((tool) => tool.strategies.map((strategy) => strategy.operationId)));
    const managedIndex = projects.findIndex((project) => {
      if (project.kind !== "navigation"
        || project.status !== "available"
        || !project.activeCapabilityId
        || project.generatedBy === "program") return false;
      const capability = release.capabilities.find((candidate) => candidate.id === project.activeCapabilityId);
      const claimsTool = capability?.plans.some((plan) =>
        plan.steps.some((step) => operationIds.has(step.operationId)));
      const projectTerms = [
        project.name,
        project.goalTemplate,
        project.requestedGoal || "",
        capability?.normalizedGoal || "",
        ...(capability?.aliases || []),
      ]
        .map(normalizedNavigationIntent)
        .filter(Boolean);
      return Boolean(claimsTool) || projectTerms.some((term) => toolTerms.has(term));
    });
    if (managedIndex >= 0) {
      projects[managedIndex] = mergeAssets(projects[managedIndex], tools);
      continue;
    }
    if (tools.every((tool) => activeCapabilityIds.has(`navigation-tool:${tool.id}`))) continue;
    // Exposure is policy attached to the runtime adapters. When multiple
    // compiler variants collapse into one semantic capability, a public
    // adapter must keep the aggregate capability public even if another
    // (newer or human-authored) adapter is the representative implementation.
    const runtimeAdapter = release.capabilities.find((capability) =>
      tools.some((tool) => capability.id === `navigation-tool:${tool.id}`)
      && capability.exposure === "public")
      || release.capabilities.find((capability) =>
        capability.id === `navigation-tool:${representative.id}`);
    addProject(canonicalNavigationToolProject(siteAgentId, tools, release, runtimeAdapter));
  }

  // Business and richer managed capabilities may depend on Navigation Tools
  // without becoming the same semantic capability. Surface those dependencies
  // on the capability while keeping the Navigation Capability itself visible.
  for (const tool of release.navigationTools || []) {
    for (const capabilityId of tool.usedByCapabilityIds) {
      const index = projects.findIndex((project) => project.activeCapabilityId === capabilityId);
      if (index >= 0) projects[index] = mergeAssets(projects[index], [tool]);
    }
  }

  return {
    ...projection,
    projects: projects.sort((left, right) =>
      (left.status === "available" ? 0 : left.status === "building" ? 1 : 2)
      - (right.status === "available" ? 0 : right.status === "building" ? 1 : 2)
      || right.updatedAt.localeCompare(left.updatedAt)),
    revisions: projection.revisions.filter((revision) => visibleProjectIds.has(revision.projectId)),
    events: projection.events.filter((event) => visibleProjectIds.has(event.projectId)),
  };
}
