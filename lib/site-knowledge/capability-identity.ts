import {
  normalizeGoal,
  stableHash,
  type CapabilityDefinition,
  type CapabilityImplementationAsset,
  type CapabilityProject,
  type JsonSchema,
  type JsonValue,
  type LinkReference,
  type NavigationTool,
  type SceneDefinition,
} from "./protocol";

type ContractShape = Pick<CapabilityDefinition, "kind" | "resultKind" | "inputs" | "outputs"> & {
  structure?: "atomic" | "composite";
  operation?: "read" | "write";
};

function canonicalValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

/**
 * JSON Schema descriptions and examples may improve without changing a
 * capability contract. Validation keywords and the property graph may not.
 */
export function capabilitySchemaShape(schema: JsonSchema): JsonValue {
  const shape: Record<string, JsonValue> = { type: schema.type };
  if (schema.properties) {
    shape.properties = Object.fromEntries(
      Object.entries(schema.properties)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, capabilitySchemaShape(child)]),
    );
  }
  if (schema.items) shape.items = capabilitySchemaShape(schema.items);
  if (schema.required?.length) shape.required = [...new Set(schema.required)].sort();
  if (schema.format) shape.format = schema.format;
  if (schema.enum?.length) {
    shape.enum = [...schema.enum]
      .map((value) => canonicalValue(value))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (schema.pattern !== undefined) shape.pattern = schema.pattern;
  if (schema.minimum !== undefined) shape.minimum = schema.minimum;
  if (schema.maximum !== undefined) shape.maximum = schema.maximum;
  if (schema.minLength !== undefined) shape.minLength = schema.minLength;
  if (schema.maxLength !== undefined) shape.maxLength = schema.maxLength;
  if (schema.minItems !== undefined) shape.minItems = schema.minItems;
  if (schema.maxItems !== undefined) shape.maxItems = schema.maxItems;
  return shape;
}

export function capabilityContractFingerprint(contract: ContractShape) {
  const structure = contract.structure || "atomic";
  const operation = structure === "atomic"
    ? contract.operation || (contract.kind === "navigation" || contract.resultKind !== "action" ? "read" : "write")
    : undefined;
  const shape = canonicalValue({
    kind: contract.kind || "task",
    resultKind: contract.resultKind || "page",
    structure,
    ...(operation ? { operation } : {}),
    inputs: capabilitySchemaShape(contract.inputs),
    outputs: capabilitySchemaShape(contract.outputs),
  });
  return `contract_${stableHash(JSON.stringify(shape))}`;
}

export function normalizedNavigationIntent(value: string) {
  return normalizeGoal(value)
    .replace(/^(?:请|帮我|我要|我想|带我|麻烦)?\s*(?:打开|进入|前往|去到|跳转到|返回|回到|浏览|查看)\s*/i, "")
    .trim();
}

function pathnameFamily(
  template: SceneDefinition["urlTemplates"][number],
  scene: SceneDefinition,
  scenes: SceneDefinition[],
  linkReferences: LinkReference[],
) {
  const pathname = template.pathnamePattern.replace(/\/+$/, "") || "/";
  // A parameterized template already describes the stable destination family.
  if (/[:*{}]/.test(pathname)) return pathname;
  const slash = pathname.lastIndexOf("/");
  if (slash <= 0) return pathname;
  const parent = pathname.slice(0, slash);
  const incomingLabels = new Set(linkReferences
    .filter((reference) => reference.toSceneId === scene.id)
    .map((reference) => normalizeGoal(reference.label))
    .filter((label) => label.length >= 2));
  const siblings = new Set(scenes.flatMap((candidate) =>
    candidate.urlTemplates.flatMap((other) => {
      const otherPath = other.pathnamePattern.replace(/\/+$/, "") || "/";
      const otherSlash = otherPath.lastIndexOf("/");
      if (other.originPattern !== template.originPattern
        || otherSlash <= 0
        || otherPath.slice(0, otherSlash) !== parent) return [];
      const sharesObservedEntry = candidate.id === scene.id || linkReferences.some((reference) =>
        reference.toSceneId === candidate.id
        && incomingLabels.has(normalizeGoal(reference.label)));
      if (!sharesObservedEntry) return [];
      return [otherPath.slice(otherSlash + 1)];
    })));
  // A parent path and cardinality alone do not prove a parameterized family:
  // /settings/edit, /settings/view and /settings/audit are separate intents.
  // Require at least three siblings reached through the same observed entry
  // label (for example repeated "查看详情" product links) before folding the
  // concrete leaves into one implementation family.
  return siblings.size >= 3 ? `${parent}/{item}` : pathname;
}

function sceneTargetSignature(
  scene: SceneDefinition | undefined,
  fallbackSceneId: string,
  scenes: SceneDefinition[],
  linkReferences: LinkReference[],
) {
  if (!scene) return `scene_${stableHash(fallbackSceneId)}`;
  const templates = scene.urlTemplates
    .map((template) => ({
      originPattern: template.originPattern,
      pathnamePattern: pathnameFamily(template, scene, scenes, linkReferences),
      query: canonicalValue(template.query),
      hashPattern: template.hashPattern || "",
      routeMode: template.routeMode || "",
      basePath: template.basePath || "",
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const target = templates.length
    ? { templates, parameters: scene.parameters.map((parameter) => ({ id: parameter.id, type: parameter.type, required: parameter.required })).sort((left, right) => left.id.localeCompare(right.id)) }
    : { name: normalizeGoal(scene.name), verifier: canonicalValue(scene.verifier as unknown as JsonValue) };
  return `target_${stableHash(JSON.stringify(target))}`;
}

export function navigationCapabilityStableKey(
  tool: NavigationTool,
  scenes: SceneDefinition[] = [],
  linkReferences: LinkReference[] = [],
) {
  const contractFingerprint = capabilityContractFingerprint({
    kind: "navigation",
    resultKind: "page",
    inputs: tool.inputs,
    outputs: tool.outputs,
  });
  const targetFingerprint = sceneTargetSignature(
    scenes.find((scene) => scene.id === tool.targetSceneId),
    tool.targetSceneId,
    scenes,
    linkReferences,
  );
  // Navigation identity is the destination family plus its contract. Compiler
  // labels often contain the current entity ("打开弧光台灯商品详情"), which is
  // an implementation value rather than a new capability intent. Keeping the
  // prose label in the identity would split one parameterized destination into
  // a card per observed entity.
  return `navigation_${stableHash(`${contractFingerprint}:${targetFingerprint}`)}`;
}

export function capabilityProjectStableKey(project: Pick<CapabilityProject,
  "kind" | "resultKind" | "goalTemplate" | "name" | "inputSchema" | "outputSchema" | "structure" | "operation">) {
  const intent = project.kind === "navigation"
    ? normalizedNavigationIntent(project.goalTemplate || project.name)
    : normalizeGoal(project.goalTemplate || project.name);
  const fingerprint = capabilityContractFingerprint({
    kind: project.kind,
    resultKind: project.resultKind,
    structure: project.structure,
    operation: project.operation,
    inputs: project.inputSchema,
    outputs: project.outputSchema,
  });
  return `capability_${stableHash(`${project.kind}:${intent}:${fingerprint}`)}`;
}

export function navigationToolAsset(
  tool: NavigationTool,
  scenes: SceneDefinition[] = [],
): CapabilityImplementationAsset {
  const scene = scenes.find((candidate) => candidate.id === tool.targetSceneId);
  const targetRoute = scene?.urlTemplates[0]
    ? `${scene.urlTemplates[0].originPattern}${scene.urlTemplates[0].pathnamePattern}`
    : undefined;
  return {
    kind: "navigation-tool",
    id: tool.id,
    capabilityId: `navigation-tool:${tool.id}`,
    name: tool.name,
    status: tool.status,
    targetSceneId: tool.targetSceneId,
    targetSceneName: scene?.name,
    targetRoute,
    strategyKinds: [...new Set(tool.strategies.map((strategy) => strategy.kind))],
    strategyCount: tool.strategies.length,
    sourceKind: tool.source.kind,
    knowledgeRevision: tool.source.knowledgeRevision,
    dependencyHash: tool.source.dependencyHash,
    evidenceCount: tool.source.evidenceRefs.length,
    updatedAt: tool.updatedAt,
  };
}

function navigationToolScore(tool: NavigationTool) {
  const status = tool.status === "verified" ? 30 : tool.status === "candidate" ? 20 : 10;
  const source = tool.source.kind === "human" ? 3 : tool.source.kind === "ai-reviewed" ? 2 : 1;
  return status + source;
}

export function representativeNavigationTool(tools: NavigationTool[]) {
  return [...tools].sort((left, right) =>
    navigationToolScore(right) - navigationToolScore(left)
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id))[0];
}
