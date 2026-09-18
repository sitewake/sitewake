import { stableHash, type LinkReference, type OperationDefinition, type SceneDefinition, type SiteAgentReleaseV2 } from "./protocol";

export type TopologyNode = {
  id: string;
  sceneId: string;
  name: string;
  description?: string;
  path: string;
  areaId: string;
  parameters: string[];
  evidenceStatus: "referenced" | "crawled" | "observed" | "entry-verified";
  lifecycle: "referenced" | "crawled" | "observed" | "semantic-reviewed" | "entry-verified";
  semanticSource: "program" | "ai" | "human";
  /**
   * Direct-entry readiness, surfaced verbatim (not collapsed into evidenceStatus)
   * so the console can say WHY a scene stalled: candidate = never probed,
   * needs-reverify = demoted after drift, failed = repeatedly unreachable.
   */
  directEntry: SceneDefinition["directEntry"];
  /** The recorded failure reason when directEntry is needs-reverify/failed. */
  entryFault?: string;
  identityConfidence: number;
  evidenceCount: number;
  /** When the page first appeared (from SceneDefinition.createdAt); the console marks "new" from it. Empty for old data. */
  createdAt?: string;
  /** Known real URLs under this URL class (folded by the crawl + actually opened); list rows show a class as "· N pages". */
  instanceCount: number;
};

export type TopologyArea = {
  id: string;
  name: string;
  nodeIds: string[];
  source: "program" | "ai" | "human";
  confidence: number;
};

export type TopologyEdge = {
  id: string;
  from: string;
  to: string;
  kind: "hierarchy" | "business-flow" | "global-nav" | "contextual" | "utility";
  status: "referenced" | "observed" | "verified";
  label?: string;
  score: number;
  evidenceCount: number;
};

export type SiteBusinessTopology = {
  root: { id: "site-root"; name: string };
  areas: TopologyArea[];
  nodes: TopologyNode[];
  primaryEdges: TopologyEdge[];
  secondaryEdges: TopologyEdge[];
  stats: { referencedScenes: number; crawledScenes: number; observedScenes: number; reviewedScenes: number; verifiedScenes: number; hiddenEdges: number };
};

function pathOf(scene: SceneDefinition) {
  return scene.urlTemplates[0]?.pathnamePattern || "/";
}

function evidenceStatusOf(scene: SceneDefinition): TopologyNode["evidenceStatus"] {
  if (scene.evidenceStatus) return scene.evidenceStatus;
  if (scene.directEntry === "verified" || scene.lifecycle === "entry-verified") return "entry-verified";
  if (scene.lifecycle === "observed" || scene.verifier.headingIncludes?.length || scene.verifier.titleIncludes?.length || scene.evidence?.observedUrls.length) return "observed";
  return "referenced";
}

function lifecycleOf(scene: SceneDefinition): TopologyNode["lifecycle"] {
  const evidenceStatus = evidenceStatusOf(scene);
  if (evidenceStatus === "entry-verified") return "entry-verified";
  if (scene.semanticSource === "ai" || scene.semanticSource === "human" || scene.semanticReview?.status === "reviewed") return "semantic-reviewed";
  return evidenceStatus;
}

/** A page title is a poor area name ("明星热搜榜 - 实时明星热度排行 | 热搜时光机"): keep only
 * the leading descriptor before a " - " / " | " / "_" tail and cap its length, so a
 * pre-review fallback area reads like a label, not a full title. */
function tidyAreaName(name: string) {
  const lead = name.split(/\s[-|·—]\s|[|｜]|_/)[0].trim();
  const base = lead.length >= 2 ? lead : name.trim();
  return base.length > 14 ? `${base.slice(0, 14)}…` : base;
}

function fallbackArea(scene: SceneDefinition, scenes: SceneDefinition[]) {
  const path = pathOf(scene);
  if (path === "/") return "网站入口";
  const segment = path.split("/").filter(Boolean)[0] || "other";
  const family = scenes.filter((item) => pathOf(item) === `/${segment}` || pathOf(item).startsWith(`/${segment}/`));
  const root = family.find((item) => pathOf(item) === `/${segment}`);
  if (family.length > 1) return root?.name ? tidyAreaName(root.name) : segment;
  return "其他页面";
}

function isObservedOperation(operation: OperationDefinition) {
  return operation.evidenceSource === "observed-transition" || operation.evidenceSource === "compiled-task" || operation.status !== "candidate" || operation.implementations.some((implementation) => implementation.successes > 0 || implementation.sourceEpisodeIds.length > 0);
}

function legacyReferences(linkReferences: LinkReference[] | undefined, operations: OperationDefinition[]): LinkReference[] {
  if (linkReferences?.length) return linkReferences;
  return operations.filter((operation) => !isObservedOperation(operation) && operation.toSceneId).map((operation) => ({
    id: `legacy_link_${operation.id}`,
    fromSceneId: operation.fromSceneId,
    toSceneId: operation.toSceneId!,
    label: operation.name.replace(/^(打开|前往|进入)/, ""),
    href: "",
    landmark: "unknown" as const,
    observations: 1,
    firstSeenAt: operation.updatedAt,
    lastSeenAt: operation.updatedAt,
  }));
}

function edgeKind(reference: LinkReference, global: boolean): TopologyEdge["kind"] {
  if (reference.landmark === "footer") return "utility";
  if (global || reference.landmark === "header" || reference.landmark === "nav") return "global-nav";
  if (reference.landmark === "main") return "contextual";
  return "contextual";
}

function wouldCycle(parents: Map<string, string>, child: string, parent: string) {
  let current: string | undefined = parent;
  const visited = new Set([child]);
  while (current && current !== "site-root") {
    if (visited.has(current)) return true;
    visited.add(current);
    current = parents.get(current);
  }
  return false;
}

export function buildBusinessTopology(release: SiteAgentReleaseV2): SiteBusinessTopology {
  return buildBusinessTopologyFromParts({
    rootName: release.profile.name,
    scenes: release.scenes,
    linkReferences: release.linkReferences,
    operations: release.operations,
  });
}

/**
 * The operation-derived business-flow edges only — the "execution overlay" the
 * knowledge view can toggle on top of the knowledge-pure topology (which consumers
 * derive from scenes + links via `buildBusinessTopologyFromParts`).
 * Keys are scene ids, matching the knowledge topology's node ids, so the two lay
 * over each other cleanly. Mirrors the operation edges built inside FromParts.
 */
export function businessFlowEdges(release: SiteAgentReleaseV2): TopologyEdge[] {
  const sceneIds = new Set(release.scenes.map((scene) => scene.id));
  return release.operations
    .filter((operation) => operation.toSceneId && isObservedOperation(operation) && sceneIds.has(operation.fromSceneId) && sceneIds.has(operation.toSceneId))
    .map((operation) => {
      const verified = operation.status === "verified" || operation.status === "published";
      const evidenceCount = operation.implementations.reduce((sum, implementation) => sum + implementation.successes, 0);
      return { id: `edge_operation_${operation.id}`, from: operation.fromSceneId, to: operation.toSceneId!, kind: "business-flow", status: verified ? "verified" : "observed", label: operation.name, score: verified ? 108 : 88 + Math.min(10, evidenceCount), evidenceCount } satisfies TopologyEdge;
    });
}

/**
 * The graph→tree derivation, decoupled from a full Release. The onboarding
 * crawler uses this to materialize `tree` from just scenes + links, without
 * fabricating operations/eval/agentConfig it does not have.
 */
export function buildBusinessTopologyFromParts(parts: {
  rootName: string;
  scenes: SceneDefinition[];
  linkReferences?: LinkReference[];
  operations?: OperationDefinition[];
}): SiteBusinessTopology {
  const scenes = parts.scenes;
  const operations = parts.operations ?? [];
  const nodes: TopologyNode[] = scenes.map((scene) => {
    const areaName = scene.businessArea || fallbackArea(scene, scenes);
    return {
      id: scene.id,
      sceneId: scene.id,
      name: scene.name,
      description: scene.description,
      path: pathOf(scene),
      areaId: `area_${stableHash(areaName)}`,
      parameters: scene.parameters.map((parameter) => parameter.name),
      evidenceStatus: evidenceStatusOf(scene),
      lifecycle: lifecycleOf(scene),
      semanticSource: scene.semanticSource || "program",
      directEntry: scene.directEntry,
      entryFault: scene.directEntry === "needs-reverify" || scene.directEntry === "failed" ? scene.verificationFailure : undefined,
      identityConfidence: scene.identityConfidence || (scene.parameters.length ? 0.68 : 0.76),
      evidenceCount: new Set([...(scene.sourceObservationIds || []), ...(scene.evidence?.observedUrls || [])]).size,
      createdAt: scene.createdAt,
      instanceCount: (scene.sampleCount || 0) + new Set(scene.evidence?.observedUrls || []).size,
    };
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  const nodeByPath = new Map(nodes.map((node) => [node.path, node]));

  const areaGroups = new Map<string, TopologyArea>();
  for (const node of nodes) {
    const scene = sceneById.get(node.id)!;
    const name = scene.businessArea || fallbackArea(scene, scenes);
    const source = scene.businessArea ? scene.semanticSource === "human" ? "human" : "ai" : "program";
    const previous = areaGroups.get(node.areaId);
    areaGroups.set(node.areaId, previous ? { ...previous, nodeIds: [...previous.nodeIds, node.id], source: previous.source === "human" || source === "human" ? "human" : previous.source === "ai" || source === "ai" ? "ai" : "program", confidence: Math.max(previous.confidence, source === "program" ? 0.55 : 0.84) } : { id: node.areaId, name, nodeIds: [node.id], source, confidence: source === "program" ? 0.55 : 0.84 });
  }

  // A `fromSceneId:"*"` reference is an aggregated global-nav edge (aggregate-knowledge-links);
  // accept it (its source is not a scene node) — it is rendered from site-root below.
  const references = legacyReferences(parts.linkReferences, operations).filter((reference) => (reference.fromSceneId === "*" || nodeIds.has(reference.fromSceneId)) && nodeIds.has(reference.toSceneId) && reference.fromSceneId !== reference.toSceneId);
  const sourceCountByTarget = new Map<string, Set<string>>();
  for (const reference of references) sourceCountByTarget.set(reference.toSceneId, new Set([...(sourceCountByTarget.get(reference.toSceneId) || []), reference.fromSceneId]));
  const candidates = new Map<string, TopologyEdge[]>();
  const addCandidate = (edge: TopologyEdge) => candidates.set(edge.to, [...(candidates.get(edge.to) || []), edge]);

  for (const node of nodes) {
    if (node.path === "/") addCandidate({ id: `edge_root_${node.id}`, from: "site-root", to: node.id, kind: "hierarchy", status: node.evidenceStatus === "referenced" ? "referenced" : "observed", score: 120, evidenceCount: node.evidenceCount });
    const segments = node.path.split("/").filter(Boolean);
    if (segments.length > 1) {
      const parentPath = `/${segments.slice(0, -1).join("/")}`;
      const parent = nodeByPath.get(parentPath);
      if (parent) addCandidate({ id: `edge_path_${parent.id}_${node.id}`, from: parent.id, to: node.id, kind: "hierarchy", status: "referenced", score: 92, evidenceCount: 1 });
    }
  }

  for (const reference of references) {
    const global = reference.fromSceneId === "*" || (sourceCountByTarget.get(reference.toSceneId)?.size || 0) >= Math.max(2, Math.ceil(nodes.length * 0.3));
    const kind = edgeKind(reference, global);
    const from = global ? "site-root" : reference.fromSceneId;
    const score = kind === "global-nav" ? 82 : kind === "utility" ? 12 : reference.landmark === "main" ? 64 : 45;
    addCandidate({ id: `edge_reference_${stableHash(`${from}:${reference.toSceneId}:${kind}`)}`, from, to: reference.toSceneId, kind, status: "referenced", label: reference.label, score, evidenceCount: reference.observations });
  }

  for (const operation of operations.filter((item) => item.toSceneId && isObservedOperation(item) && nodeIds.has(item.fromSceneId) && nodeIds.has(item.toSceneId!))) {
    const verified = operation.status === "verified" || operation.status === "published";
    const evidenceCount = operation.implementations.reduce((sum, implementation) => sum + implementation.successes, 0);
    addCandidate({ id: `edge_operation_${operation.id}`, from: operation.fromSceneId, to: operation.toSceneId!, kind: "business-flow", status: verified ? "verified" : "observed", label: operation.name, score: verified ? 108 : 88 + Math.min(10, evidenceCount), evidenceCount });
  }

  const parents = new Map<string, string>();
  const primaryEdges: TopologyEdge[] = [];
  for (const node of [...nodes].sort((left, right) => left.path.split("/").length - right.path.split("/").length || left.path.localeCompare(right.path))) {
    const ranked = [...(candidates.get(node.id) || [])].sort((left, right) => right.score - left.score || right.evidenceCount - left.evidenceCount);
    const chosen = ranked.find((edge) => !wouldCycle(parents, node.id, edge.from)) || { id: `edge_fallback_${node.id}`, from: "site-root", to: node.id, kind: "hierarchy" as const, status: "referenced" as const, score: 1, evidenceCount: 0 };
    parents.set(node.id, chosen.from);
    primaryEdges.push(chosen);
  }

  const primaryKeys = new Set(primaryEdges.map((edge) => `${edge.from}:${edge.to}`));
  const secondaryEdges = [...candidates.values()].flat().filter((edge) => !primaryKeys.has(`${edge.from}:${edge.to}`));
  const stats = {
    referencedScenes: nodes.filter((node) => node.evidenceStatus === "referenced").length,
    crawledScenes: nodes.filter((node) => node.evidenceStatus === "crawled").length,
    observedScenes: nodes.filter((node) => node.evidenceStatus !== "referenced").length,
    reviewedScenes: nodes.filter((node) => node.semanticSource === "ai" || node.semanticSource === "human").length,
    verifiedScenes: nodes.filter((node) => node.evidenceStatus === "entry-verified").length,
    hiddenEdges: secondaryEdges.length,
  };
  return { root: { id: "site-root", name: parts.rootName }, areas: [...areaGroups.values()].sort((left, right) => right.nodeIds.length - left.nodeIds.length || left.name.localeCompare(right.name)), nodes, primaryEdges, secondaryEdges, stats };
}
