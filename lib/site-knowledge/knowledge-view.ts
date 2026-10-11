import {
  normalizeGoal,
  stableHash,
  type OperationDefinition,
  type SceneDefinition,
  type SiteAgentReleaseV2,
} from "./protocol";
import { profileTaskTemplates } from "./site-knowledge";

export type KnowledgeScene = {
  id: string;
  sourceIds: string[];
  name: string;
  description?: string;
  semanticSource: "program" | "ai" | "human";
  path: string;
  parameterNames: string[];
  directEntry: SceneDefinition["directEntry"];
  evidenceCount: number;
  incoming: number;
  outgoing: number;
};

export type KnowledgeEdge = {
  id: string;
  from: string;
  to: string;
  names: string[];
  status: OperationDefinition["status"];
  evidenceCount: number;
  implementationCount: number;
};

export type KnowledgeGraph = {
  scenes: KnowledgeScene[];
  edges: KnowledgeEdge[];
  sceneIdMap: Map<string, string>;
};

function sceneKey(scene: SceneDefinition) {
  const template = scene.urlTemplates[0];
  return `${template?.originPattern || "*"}:${template?.pathnamePattern || scene.id}`;
}

function nameScore(name: string) {
  let score = Math.min(name.length, 24);
  if (/详情$/.test(name)) score -= 8;
  if (/^(search|guides|city|country|celebrity)/i.test(name)) score -= 10;
  if (/^[\w/-]+$/.test(name)) score -= 8;
  return score;
}

function bestSceneName(scenes: SceneDefinition[]) {
  return [...scenes].sort((left, right) => nameScore(right.name) - nameScore(left.name))[0]?.name || "未命名页面";
}

function strongestEntry(scenes: SceneDefinition[]): SceneDefinition["directEntry"] {
  if (scenes.some((scene) => scene.directEntry === "verified")) return "verified";
  // A demoted entry (was verified, failed re-check) must read as needs-reverify, not
  // candidate — the console's "why not promoted" signal and the re-verify sweep depend on it.
  if (scenes.some((scene) => scene.directEntry === "needs-reverify")) return "needs-reverify";
  if (scenes.every((scene) => scene.directEntry === "failed")) return "failed";
  return "candidate";
}

function strongestStatus(operations: OperationDefinition[]): OperationDefinition["status"] {
  if (operations.some((operation) => operation.status === "published")) return "published";
  if (operations.some((operation) => operation.status === "verified")) return "verified";
  return "candidate";
}

/**
 * Builds the read model used by the console and planner diagnostics. The Release
 * remains immutable; duplicate route observations and concrete element paths are
 * collapsed here into the semantic Scene/Edge graph an operator can reason about.
 */
export function buildKnowledgeGraph(release: SiteAgentReleaseV2): KnowledgeGraph {
  const groups = new Map<string, SceneDefinition[]>();
  for (const scene of release.scenes) {
    const key = sceneKey(scene);
    groups.set(key, [...(groups.get(key) || []), scene]);
  }

  const sceneIdMap = new Map<string, string>();
  const scenes = [...groups.entries()].map(([key, members]) => {
    const id = `knowledge_scene_${stableHash(key)}`;
    for (const member of members) sceneIdMap.set(member.id, id);
    const template = members[0]?.urlTemplates[0];
    return {
      id,
      sourceIds: members.map((scene) => scene.id),
      name: bestSceneName(members),
      description: members.find((scene) => scene.description)?.description,
      semanticSource: members.some((scene) => scene.semanticSource === "human") ? "human" : members.some((scene) => scene.semanticSource === "ai") ? "ai" : "program",
      path: template?.pathnamePattern || "/",
      parameterNames: [...new Set(members.flatMap((scene) => scene.parameters.map((parameter) => parameter.name)))],
      directEntry: strongestEntry(members),
      evidenceCount: new Set(members.flatMap((scene) => scene.sourceObservationIds)).size,
      incoming: 0,
      outgoing: 0,
    } satisfies KnowledgeScene;
  });

  const operationGroups = new Map<string, OperationDefinition[]>();
  for (const operation of release.operations) {
    const from = operation.fromSceneId === "*" ? "*" : sceneIdMap.get(operation.fromSceneId);
    const to = operation.toSceneId ? sceneIdMap.get(operation.toSceneId) : undefined;
    if (!from || !to || from === to) continue;
    const key = `${from}:${to}`;
    operationGroups.set(key, [...(operationGroups.get(key) || []), operation]);
  }

  const edges = [...operationGroups.entries()].map(([key, operations]) => {
    const [from, to] = key.split(":");
    const names = [...new Set(operations.map((operation) => operation.name.replace(/^(打开|前往|进入)/, "").trim()).filter(Boolean))];
    const sourceIds = operations.flatMap((operation) => operation.implementations.flatMap((implementation) => implementation.sourceEpisodeIds));
    return {
      id: `knowledge_edge_${stableHash(key)}`,
      from,
      to,
      names: names.slice(0, 4),
      status: strongestStatus(operations),
      evidenceCount: new Set(sourceIds).size || operations.reduce((sum, operation) => sum + operation.implementations.reduce((count, implementation) => count + implementation.successes, 0), 0),
      implementationCount: operations.reduce((sum, operation) => sum + operation.implementations.length, 0),
    } satisfies KnowledgeEdge;
  });

  const byId = new Map(scenes.map((scene) => [scene.id, scene]));
  for (const edge of edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from) from.outgoing += 1;
    if (to) to.incoming += 1;
  }
  return { scenes, edges, sceneIdMap };
}

export function isConcreteNavigationCapability(release: SiteAgentReleaseV2, capabilityId: string) {
  const capability = release.capabilities.find((item) => item.id === capabilityId);
  if (!capability || capability.kind !== "navigation") return false;
  const operationIds = new Set(capability.plans.flatMap((plan) => plan.steps.map((step) => step.operationId)));
  return release.operations.some((operation) => operationIds.has(operation.id) && operation.toSceneId && release.scenes.find((scene) => scene.id === operation.toSceneId)?.parameters.length);
}

export function suggestedGoals(release: SiteAgentReleaseV2, candidateGoals: string[]) {
  const occupied = new Set([
    ...release.capabilities.flatMap((capability) => [capability.name, ...capability.aliases]),
    ...candidateGoals,
  ].map(normalizeGoal));
  return profileTaskTemplates(release).map((task) => task.name).filter((goal) => !occupied.has(normalizeGoal(goal)));
}
