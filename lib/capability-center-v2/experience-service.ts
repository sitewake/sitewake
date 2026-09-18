import {
  CapabilityCenterV2Error,
  getCapability,
  getCapabilityMaintenanceDefaults,
  listTasks,
} from "../../db/capability-center-v2-store";
import { RuntimeLauncher } from "../../runner/capability-v2/runtime-launcher";
import { getModelConfig } from "../model-config";
import type { CapabilityContract, CapabilityExperience, LegacyCapabilityScope, CapabilityTaskInput, JsonObject, JsonValue } from "./model";
import { requestStructuredModelJson } from "./model-json";
import { makeDebugEvent, type CapabilityDebugEvent } from "./debug-trace";
import { EXPERIENCE_ABSTRACTION_PROMPT } from "./prompts/experience-abstraction";
import { discoveryGenerationInputFromExperience } from "./experience";
import type { CapabilityExperienceAuthority } from "./experience-authority";
import { analyzeCapabilitySemantics, projectCapabilityScope, withoutSemanticDependencies } from "./semantic-analyzer";
import type { CapabilitySemanticIR } from "./model";
import { classifyCapabilityGeneration } from "./generation-classifier";
import type { CapabilityGenerationInput, CapabilitySeed, ExperienceClassificationResult } from "./model";
import { assertCapabilityGenerationInput, generationTaskFromPhysical } from "./generation-boundary";

type AbstractedParameter = {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  required: boolean;
  exampleValue: string | number | boolean;
};

export type AbstractedCapabilityExperience = {
  name: string;
  description: string;
  aliases: string[];
  intent: string;
  parameters: AbstractedParameter[];
  scope?: LegacyCapabilityScope;
  semantic: CapabilitySemanticIR;
};

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/gu, "").trim();
}

function technicalParameterName(name: string) {
  return /^(?:index|elementIndex|targetIndex|selector|locator|xpath|cssPath|testId)$/iu.test(name)
    || /(?:element|locator|selector|xpath|css|test.?id)(?:Index|Id|Path)$/iu.test(name)
    || /(?:元素|目标).*(?:索引|下标|编号)|选择器|定位器|测试.?ID/iu.test(name);
}

function validParameterName(name: string) {
  return /^[\p{L}_][\p{L}\p{N}_-]{0,63}$/u.test(name);
}

function evidenceCorpus(experience: CapabilityExperience) {
  return normalize(JSON.stringify({
    goal: experience.originalGoal,
    pages: [experience.startPage, experience.endPage],
    actions: experience.actions,
    output: experience.output,
  }));
}

function variableActionValues(experience: CapabilityExperience) {
  return experience.actions.flatMap((action) => {
    if (action.action === "fill") return [action.input.text, action.input.value];
    if (action.action === "select") return [action.input.option, action.input.value];
    return [];
  }).filter((value): value is string | number | boolean =>
    typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && value.trim().length > 0));
}

function observedExactBusinessLabels(experience: CapabilityExperience) {
  return [
    experience.endPage.heading,
    ...experience.actions.flatMap((action) => [action.element?.contextText, action.element?.accessibleName, action.rawAction]),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 1)
    .map(normalize);
}

function isConcreteObservedTarget(parameter: AbstractedParameter, experience: CapabilityExperience) {
  if (!/(?:product|item|target|sku|variant|object|商品|产品|目标|标识|名称|标题|identifier|name)/iu.test(parameter.name)) return false;
  const example = normalize(String(parameter.exampleValue));
  const goal = normalize(experience.originalGoal);
  if (!example || goal.includes(example)) return false;
  return observedExactBusinessLabels(experience).some((label) => label === example);
}

function parseParameter(value: unknown, corpus: string): AbstractedParameter {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const name = String(raw.name || "").trim();
  const type = raw.type === "number" || raw.type === "boolean" ? raw.type : "string";
  const description = String(raw.description || "").trim();
  const exampleValue = raw.exampleValue;
  if (!validParameterName(name) || technicalParameterName(name)) throw new Error("experience_parameter_name_invalid");
  if (!description) throw new Error("experience_parameter_description_required");
  if (raw.required !== true) throw new Error("experience_parameter_must_be_required");
  if (typeof exampleValue !== "string" && typeof exampleValue !== "number" && typeof exampleValue !== "boolean") {
    throw new Error("experience_parameter_example_type_invalid");
  }
  if ((type === "string" && typeof exampleValue !== "string")
    || (type === "number" && typeof exampleValue !== "number")
    || (type === "boolean" && typeof exampleValue !== "boolean")) throw new Error("experience_parameter_example_type_invalid");
  if (!corpus.includes(normalize(String(exampleValue)))) throw new Error("experience_parameter_example_not_in_evidence");
  return { name, type, description, required: true, exampleValue };
}

/**
 * Keep the logical parameter names supplied at the A→B boundary when the
 * semantic model invents a localized synonym for the same value.  Parameter
 * names are part of the C-facing Contract, so letting one model call rename
 * `query` to `商品类别` (or `color` to `商品属性`) makes the JavaScript author
 * and later callers solve an unnecessary Unicode transport problem.  This is
 * a generic value-grounded alignment: it uses only the source parameter
 * names and matching example values, never a site/product dictionary.
 */
function alignAbstractionParameterNames(
  abstraction: AbstractedCapabilityExperience,
  sourceParameters: Record<string, JsonValue>,
): AbstractedCapabilityExperience {
  const sourceEntries = Object.entries(sourceParameters);
  if (!sourceEntries.length || !abstraction.parameters.length) return abstraction;
  const used = new Set<string>();
  const rename: Record<string, string> = {};
  for (let index = 0; index < abstraction.parameters.length; index += 1) {
    const parameter = abstraction.parameters[index];
    const example = normalize(String(parameter.exampleValue));
    const matched = sourceEntries.find(([name, value]) => !used.has(name) && normalize(String(value)) === example)
      || (sourceEntries[index] && !used.has(sourceEntries[index][0]) ? sourceEntries[index] : undefined);
    if (!matched || !validParameterName(matched[0])) continue;
    used.add(matched[0]);
    if (matched[0] !== parameter.name) rename[parameter.name] = matched[0];
  }
  const existingNames = new Set(abstraction.parameters.map((parameter) => parameter.name));
  const missingSourceParameters: AbstractedParameter[] = sourceEntries.flatMap(([name, value]) => {
    if (used.has(name) || !validParameterName(name) || technicalParameterName(name) || existingNames.has(name)) return [];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return [];
    return [{
      name,
      type: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string",
      description: `用户提供的公开业务参数：${name}`,
      required: true,
      exampleValue: value,
    }];
  });
  if (!Object.keys(rename).length && !missingSourceParameters.length) return abstraction;
  const path = (value: string) => rename[value] || value;
  const placeholderText = (value: string) => Object.entries(rename).reduce(
    (text, [from, to]) => text.replaceAll(`{{${from}}}`, `{{${to}}}`),
    value,
  );
  const semantic: CapabilitySemanticIR = {
    ...abstraction.semantic,
    goal: placeholderText(abstraction.semantic.goal),
    parameters: abstraction.semantic.parameters.map((parameter) => ({ ...parameter, path: path(parameter.path) })),
    dependencies: (abstraction.semantic.dependencies || []).map((dependency) => ({
      ...dependency,
      ...(dependency.parameterPath ? { parameterPath: path(dependency.parameterPath) } : {}),
      ...(dependency.id.startsWith("input:") ? { id: `input:${path(dependency.id.slice("input:".length))}` } : {}),
    })),
    entryPolicy: {
      ...abstraction.semantic.entryPolicy,
      requiredInputPaths: abstraction.semantic.entryPolicy.requiredInputPaths.map(path),
    },
  };
  return {
    ...abstraction,
    intent: placeholderText(abstraction.intent),
    parameters: [
      ...abstraction.parameters.map((parameter) => ({ ...parameter, name: path(parameter.name) })),
      ...missingSourceParameters,
    ],
    semantic,
  };
}

function parseScope(value: unknown): LegacyCapabilityScope | undefined {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const kind = raw.kind === "site-global" || raw.kind === "category-scoped" || raw.kind === "page-scoped" || raw.kind === "unknown" ? raw.kind : undefined;
  const formalMatch = raw.match && typeof raw.match === "object" && !Array.isArray(raw.match) ? raw.match as Record<string, unknown> : undefined;
  if (kind && (raw.onMismatch === "no-match" || raw.onMismatch === "clarify" || raw.onMismatch === "page-agent")) {
    const requiredInputPaths = Array.isArray(formalMatch?.requiredInputPaths)
      ? formalMatch.requiredInputPaths.filter((path): path is string => typeof path === "string" && Boolean(path.trim()))
      : [];
    const scopeTokens = Array.isArray(formalMatch?.tokens)
      ? formalMatch.tokens.filter((token): token is string => typeof token === "string" && Boolean(token.trim()))
      : [];
    const observedPaths = Array.isArray(formalMatch?.urlPatterns)
      ? formalMatch.urlPatterns.filter((path): path is string => typeof path === "string" && Boolean(path.trim()))
      : [];
    return {
      kind,
      binding: kind === "site-global" ? "none" : requiredInputPaths.length ? "user-input" : "fixed",
      generalizable: kind === "site-global" || requiredInputPaths.length > 0,
      ...(observedPaths.length ? { observedPaths } : {}),
      ...(scopeTokens.length ? { scopeTokens } : {}),
      ...(requiredInputPaths.length ? { requiredInputPaths } : {}),
    };
  }
  const binding = raw.binding === "none" || raw.binding === "user-input" || raw.binding === "derived-context" || raw.binding === "fixed" ? raw.binding : undefined;
  if (!kind || !binding || typeof raw.generalizable !== "boolean") return undefined;
  const observedPaths = Array.isArray(raw.observedPaths) ? raw.observedPaths.filter((path): path is string => Boolean(typeof path === "string" && path.trim())).slice(0, 12) : undefined;
  return {
    kind,
    binding,
    generalizable: raw.generalizable,
    ...(observedPaths?.length ? { observedPaths } : {}),
    ...(typeof raw.rationale === "string" && raw.rationale.trim() ? { rationale: raw.rationale.trim().slice(0, 500) } : {}),
  };
}

export function parseCapabilityExperienceAbstraction(value: Record<string, unknown>, experience: CapabilityExperience): AbstractedCapabilityExperience {
  const name = String(value.name || "").trim();
  const description = String(value.description || "").trim();
  const intent = String(value.intent || "").trim();
  const aliases = Array.isArray(value.aliases)
    ? [...new Set(value.aliases.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, 20)
    : [];
  if (name.length < 2 || name.length > 80 || description.length < 4 || description.length > 500 || intent.length < 2 || intent.length > 300) {
    throw new Error("experience_abstraction_text_invalid");
  }
  const corpus = evidenceCorpus(experience);
  const parameters = (Array.isArray(value.parameters) ? value.parameters : []).map((item) => parseParameter(item, corpus));
  if (new Set(parameters.map((item) => item.name)).size !== parameters.length) throw new Error("experience_parameter_duplicate");
  if (parameters.some((parameter) => isConcreteObservedTarget(parameter, experience))) {
    throw new Error("experience_concrete_target_not_generalized");
  }
  for (const actionValue of variableActionValues(experience)) {
    if (!parameters.some((parameter) => normalize(String(parameter.exampleValue)) === normalize(String(actionValue)))) {
      throw new Error("experience_action_value_not_parameterized");
    }
  }
  for (const parameter of parameters) {
    const example = normalize(String(parameter.exampleValue));
    if (example.length < 2) continue;
    if ([name, description, intent, ...aliases].some((item) => normalize(item).includes(example))) {
      throw new Error("experience_example_leaked_into_summary");
    }
  }
  const parameterInput = Object.fromEntries(parameters.map((parameter) => [parameter.name, parameter.exampleValue])) as Record<string, JsonValue>;
  const semantic = analyzeCapabilitySemantics({
    goal: experience.originalGoal || intent,
    effect: /加入|添加|购物车|add|cart|删除|remove|delete|保存|submit|提交|修改|update/iu.test(experience.originalGoal) ? "reversible-write" : "read",
    startUrl: experience.startPage.url,
    endUrl: experience.endPage.url,
    input: parameterInput,
    parameterPaths: parameters.map((parameter) => parameter.name),
    actions: experience.actions.map((action) => ({ action: action.action, input: action.input, element: action.element, page: action.page })),
    pageTexts: [experience.startPage.title, experience.startPage.heading, experience.endPage.title, experience.endPage.heading].filter((item): item is string => Boolean(item)),
  });
  return { name, description, aliases, intent, parameters, scope: semantic.scopeDecision.scope || parseScope(value.scope), semantic };
}

function taskInput(experience: CapabilityExperience, abstraction: AbstractedCapabilityExperience): CapabilityTaskInput {
  const semantic = withoutSemanticDependencies(abstraction.semantic);
  const properties = Object.fromEntries(abstraction.parameters.map((parameter) => [parameter.name, {
    type: parameter.type,
    description: parameter.description,
  }])) as JsonObject;
  const contract: CapabilityContract = {
    intent: abstraction.intent,
    inputSchema: {
      type: "object",
      properties,
      required: abstraction.parameters.map((parameter) => parameter.name),
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: {}, additionalProperties: true },
    preconditions: [],
    successConditions: [],
    ...(projectCapabilityScope(abstraction.scope || semantic.scopeDecision.scope)
      ? { scope: projectCapabilityScope(abstraction.scope || semantic.scopeDecision.scope) }
      : {}),
  };
  return {
    parameters: Object.fromEntries(abstraction.parameters.map((parameter) => [parameter.name, parameter.exampleValue])) as Record<string, JsonValue>,
    context: {
      startUrl: experience.startPage.url,
      versionSource: "User",
      experienceOutcome: experience.outcome,
    },
    interactions: [],
    trigger: {},
    candidateSummary: {
      name: abstraction.name,
      description: abstraction.description,
      aliases: abstraction.aliases,
      contract,
    },
    experience,
  };
}

export async function abstractCapabilityExperience(experience: CapabilityExperience) {
  const config = getModelConfig("semantic");
  if (!config.configured) throw new CapabilityCenterV2Error("experience_model_not_configured", "experience_model_not_configured", 503);
  const response = await requestStructuredModelJson(config, {
    system: EXPERIENCE_ABSTRACTION_PROMPT.text,
    payload: { experience },
    timeoutMs: Number(process.env.CAPABILITY_V2_MODEL_TIMEOUT_MS || 180_000),
    maxTokens: 2_500,
    attempts: 3,
    jsonSchema: EXPERIENCE_ABSTRACTION_PROMPT.outputSchema,
    validate: (value) => { parseCapabilityExperienceAbstraction(value, experience); },
    onAttempt: (attempt) => {
      if (attempt.error) console.warn("[capability-v2] experience abstraction attempt failed", { episodeId: experience.episodeId, ...attempt });
    },
  });
  return parseCapabilityExperienceAbstraction(response, experience);
}

type EpisodeGenerationInput = Extract<CapabilityGenerationInput, { source: "Episode" }>;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pageValue(value: unknown, fallbackUrl: string) {
  const raw = objectValue(value);
  return {
    url: typeof raw.url === "string" && raw.url.trim() ? raw.url : fallbackUrl,
    ...(typeof raw.title === "string" && raw.title.trim() ? { title: raw.title.trim() } : {}),
    ...(typeof raw.heading === "string" && raw.heading.trim() ? { heading: raw.heading.trim() } : {}),
  };
}

/**
 * Project the logical A -> B boundary fixture into the existing internal
 * evidence shape used by authoring. This is not a database model and does not
 * imply that an AgentRun or browser session actually existed.
 */
function experienceFromGenerationInput(input: EpisodeGenerationInput): CapabilityExperience {
  const execution = objectValue(input.experience.execution);
  const outcome = objectValue(input.experience.outcome);
  const startPage = pageValue(execution.startPage, input.request.entryUrl);
  const endPage = pageValue(execution.endPage, startPage.url);
  const now = new Date().toISOString();
  const actions = (Array.isArray(execution.actions) ? execution.actions : []).map((item) => {
    const raw = objectValue(item);
    const action = raw.action === "click" || raw.action === "fill" || raw.action === "select"
      || raw.action === "scroll" || raw.action === "wait" ? raw.action : "unknown";
    const element = objectValue(raw.element || raw.target);
    const allowedElement = Object.fromEntries(Object.entries(element).filter(([key, value]) =>
      ["tag", "role", "accessibleName", "label", "placeholder", "name", "href", "contextText", "landmark"].includes(key)
      && typeof value === "string" && value.trim())) as CapabilityExperience["actions"][number]["element"];
    return {
      action,
      rawAction: typeof raw.rawAction === "string" ? raw.rawAction : action,
      input: objectValue(raw.input) as Record<string, JsonValue>,
      ...(Object.keys(allowedElement || {}).length ? { element: allowedElement } : {}),
      page: pageValue(raw.page, startPage.url),
      observedAt: typeof raw.observedAt === "string" ? raw.observedAt : now,
    } satisfies CapabilityExperience["actions"][number];
  });
  const successful = outcome.status === "Success" || String(outcome.status || "").toLocaleLowerCase() === "success";
  return {
    schemaVersion: "1.0",
    episodeId: input.experience.episodeId,
    agentRunId: `mock-boundary:${input.experience.episodeId}`,
    browserSessionId: `mock-boundary:${input.experience.episodeId}`,
    originalGoal: input.request.goal,
    outcome: successful ? "Success" : "NoResult",
    outcomeSummary: typeof outcome.summary === "string" ? outcome.summary : successful ? "Mock boundary reports success" : "Mock boundary reports no result",
    startedAt: typeof execution.startedAt === "string" ? execution.startedAt : now,
    endedAt: typeof execution.endedAt === "string" ? execution.endedAt : now,
    startPage,
    endPage,
    actions,
    output: {
      ...outcome as JsonObject,
      ...(input.experience.capabilityContext ? { capabilityContext: input.experience.capabilityContext } : {}),
    },
  };
}

type DiscoveryBoundaryOptions = {
  onDebugEvent?: (event: CapabilityDebugEvent) => void;
  sourceAgentRunId?: string;
  autoDispatch?: (task: Extract<ExperienceClassificationResult, { disposition: "Created" }>["task"]) => Promise<void> | void;
};

async function abstractAndClassifyEpisode(
  siteId: string,
  input: EpisodeGenerationInput,
  experience: CapabilityExperience,
  options: DiscoveryBoundaryOptions = {},
): Promise<ExperienceClassificationResult> {
  const traceId = `generation:${input.experience.episodeId}`;
  const emit = (event: Omit<Parameters<typeof makeDebugEvent>[0], "traceId" | "traceKind" | "siteId" | "correlation"> & { correlation?: Parameters<typeof makeDebugEvent>[0]["correlation"] }) => {
    options.onDebugEvent?.(makeDebugEvent({
      ...event,
      traceId,
      traceKind: "generation",
      siteId,
      correlation: {
        ...(options.sourceAgentRunId ? { agentRunId: options.sourceAgentRunId } : {}),
        episodeId: input.experience.episodeId,
        ...event.correlation,
      },
    }));
  };

  emit({ moduleId: "experience.abstract", lifecycle: "started", input: { experience } });
  let abstraction: AbstractedCapabilityExperience;
  try {
    abstraction = await abstractCapabilityExperience(experience);
    abstraction = alignAbstractionParameterNames(abstraction, input.request.parameters);
    // The abstraction model may omit a user-supplied facet when it is only
    // present in the natural-language request (for example color in “棕色的
    // 垫子”). Recompute the semantic IR after the source-parameter alignment
    // so B's seed, dependency ledger and C-facing Contract all carry the same
    // complete public parameter set.
    abstraction = {
      ...abstraction,
      semantic: analyzeCapabilitySemantics({
        goal: experience.originalGoal || abstraction.intent,
        effect: /加入|添加|购物车|add|cart|删除|remove|delete|保存|submit|提交|修改|update/iu.test(experience.originalGoal) ? "reversible-write" : "read",
        startUrl: experience.startPage.url,
        endUrl: experience.endPage.url,
        input: Object.fromEntries(abstraction.parameters.map((parameter) => [parameter.name, parameter.exampleValue])) as Record<string, JsonValue>,
        parameterPaths: abstraction.parameters.map((parameter) => parameter.name),
        actions: experience.actions.map((action) => ({ action: action.action, input: action.input, element: action.element, page: action.page })),
        pageTexts: [experience.startPage.title, experience.startPage.heading, experience.endPage.title, experience.endPage.heading].filter((item): item is string => Boolean(item)),
      }),
    };
    emit({ moduleId: "experience.abstract", lifecycle: "completed", input: { experience }, output: abstraction });
    emit({ moduleId: "semantic.analyze", lifecycle: "completed", input: { goal: experience.originalGoal, experience: { episodeId: experience.episodeId, actionCount: experience.actions.length } }, output: { semantic: abstraction.semantic, dependencies: abstraction.semantic.dependencies || [] } });
    emit({ moduleId: "dependency.ledger", lifecycle: "completed", input: { semantic: abstraction.semantic, observations: [], program: {} }, output: { entries: abstraction.semantic.dependencies || [], decisions: abstraction.semantic.scopeDecision } });
    emit({ moduleId: "scope.resolve", lifecycle: "completed", input: { dependencies: abstraction.semantic.dependencies || [], parameters: abstraction.parameters.map((parameter) => parameter.name), paths: abstraction.semantic.scopeDecision.scope.observedPaths || [] }, output: { scope: abstraction.semantic.scopeDecision.scope, decision: abstraction.semantic.scopeDecision.status, entryPolicy: abstraction.semantic.entryPolicy } });
    emit({ moduleId: "seed.build", lifecycle: "completed", input: { semantic: abstraction.semantic, scope: abstraction.semantic.scopeDecision.scope, summary: { name: abstraction.name, description: abstraction.description } }, output: { seed: { name: abstraction.name, description: abstraction.description, aliases: abstraction.aliases, intent: abstraction.intent }, contractSeed: abstraction.semantic } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ moduleId: "experience.abstract", lifecycle: "failed", message, error: { code: message.split(":")[0], message, retryable: message.includes("timeout") || message.includes("configured") } });
    throw error;
  }

  const classifiedInput: EpisodeGenerationInput = {
    ...input,
    request: {
      ...input.request,
      goal: abstraction.intent,
      parameters: Object.fromEntries(abstraction.parameters.map((parameter) => [parameter.name, parameter.exampleValue])) as JsonObject,
    },
  };
  const candidate: CapabilitySeed = {
    schemaVersion: "1.0",
    name: abstraction.name,
    description: abstraction.description,
    aliases: abstraction.aliases,
    intent: abstraction.intent,
    semantic: abstraction.semantic,
  };
  const derivedTaskInput = taskInput(experience, abstraction);
  try {
    emit({ moduleId: "capability.dedupe", lifecycle: "started", input: { name: candidate.name, candidateSummary: derivedTaskInput.candidateSummary } });
    emit({ moduleId: "capability.classify", lifecycle: "started", input: { capabilityGenerationInput: classifiedInput } });
    const result = await classifyCapabilityGeneration(siteId, classifiedInput, {
      candidate,
      contract: derivedTaskInput.candidateSummary?.contract,
      sourceAgentRunId: options.sourceAgentRunId,
      experience,
      autoDispatch: options.autoDispatch || (async (task) => {
        if (task.status === "Pending" && process.env.CAPABILITY_V2_AUTO_DISPATCH !== "0") {
          void new RuntimeLauncher().dispatchOne(siteId, task.id).catch(() => undefined);
        }
      }),
    });
    const correlation = result.disposition === "Created" ? { taskId: result.task.id } : undefined;
    emit({ moduleId: "capability.dedupe", lifecycle: result.disposition === "Created" ? "completed" : "handled", correlation, output: { disposition: result.disposition, ...(result.disposition === "Created" ? { match: null } : { match: result.match }) } });
    emit({ moduleId: "capability.classify", lifecycle: result.disposition === "Created" ? "completed" : "handled", correlation, output: result });
    if (result.disposition === "Created" && result.task.status === "Pending") {
      emit({ moduleId: "runspec.build", lifecycle: "completed", correlation, input: { capabilityGenerationInput: classifiedInput, seed: candidate }, output: { runSpec: result.task.runSpec } });
      emit({ moduleId: "task.create", lifecycle: "completed", correlation, input: { capabilityGenerationInput: classifiedInput, runSpec: result.task.runSpec }, output: { task: result.task } });
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ moduleId: "capability.classify", lifecycle: "failed", message, error: { code: error instanceof CapabilityCenterV2Error ? error.code : "classification_failed", message, retryable: false } });
    throw error;
  }
}

/** B boundary used by the Generation API and the real Agent experience path. */
export async function createDiscoveryFromGenerationInput(
  siteId: string,
  input: CapabilityGenerationInput,
  options: Omit<DiscoveryBoundaryOptions, "sourceAgentRunId"> = {},
): Promise<ExperienceClassificationResult> {
  // Validate the public B boundary before episode lookup or semantic model
  // abstraction. Invalid fixtures/requests must fail closed without invoking
  // a model, creating a task, or writing a reservation.
  assertCapabilityGenerationInput(input);
  if (input.source === "Admin") {
    return classifyCapabilityGeneration(siteId, input, {
      autoDispatch: options.autoDispatch || (async (task) => {
        if (task.status === "Pending" && process.env.CAPABILITY_V2_AUTO_DISPATCH !== "0") {
          void new RuntimeLauncher().dispatchOne(siteId, task.id).catch(() => undefined);
        }
      }),
    });
  }
  const existing = (await listTasks(siteId, { includeArchived: true, includeDeleted: true })).tasks.find((task) =>
    task.input.experience?.episodeId === input.experience.episodeId
    && task.input.context.__generationSource === "Episode"
    && task.type === "Discovery");
  if (existing) return { disposition: "Created", task: generationTaskFromPhysical(existing) };
  return abstractAndClassifyEpisode(siteId, input, experienceFromGenerationInput(input), options);
}

export async function createDiscoveryFromExperience(
  siteId: string,
  experience: CapabilityExperience,
  options: { onDebugEvent?: (event: CapabilityDebugEvent) => void } = {},
): Promise<ExperienceClassificationResult> {
  const existing = (await listTasks(siteId, { includeArchived: true, includeDeleted: true })).tasks.find((task) =>
    task.sourceAgentRunId === experience.agentRunId
    && task.input.experience?.episodeId === experience.episodeId
    && task.type === "Discovery");
  if (existing) {
    const task = generationTaskFromPhysical(existing);
    return { disposition: "Created" as const, task };
  }
  // Shared with the effect drawer, so what an owner inspects is the shape
  // generation is handed rather than a second copy of it.
  const input = discoveryGenerationInputFromExperience(experience);
  return abstractAndClassifyEpisode(siteId, input, experience, {
    sourceAgentRunId: experience.agentRunId,
    onDebugEvent: options.onDebugEvent,
  });
}

/** Apply a server-issued authority envelope; clients cannot select this path. */
export async function createCapabilityFromAuthorizedExperience(
  siteId: string,
  experience: CapabilityExperience,
  authority: CapabilityExperienceAuthority,
) {
  if (authority.siteAgentId !== siteId
    || authority.runId !== experience.agentRunId
    || authority.episodeId !== experience.episodeId) {
    throw new CapabilityCenterV2Error("capability_experience_authority_rejected", "capability_experience_authority_rejected", 403);
  }
  if (authority.kind === "create" || authority.kind === "legacy-create") return createDiscoveryFromExperience(siteId, experience);
  const sourceCapabilityId = authority.sourceCapabilityId;
  const sourceVersionId = authority.sourceVersionId;
  if (!sourceCapabilityId) throw new CapabilityCenterV2Error("capability_experience_source_required", "capability_experience_source_required", 409);
  if (!sourceVersionId) throw new CapabilityCenterV2Error("capability_experience_source_version_required", "capability_experience_source_version_required", 409);
  const existing = (await listTasks(siteId, { includeArchived: true, includeDeleted: true })).tasks.find((task) =>
    task.sourceAgentRunId === experience.agentRunId
    && task.input.experience?.episodeId === experience.episodeId
    && task.type === "Repair");
  if (existing) return { disposition: "Created" as const, task: generationTaskFromPhysical(existing) };
  const capability = await getCapability(siteId, sourceCapabilityId);
  if (!capability?.currentVersionId || capability.currentVersionId !== sourceVersionId) throw new CapabilityCenterV2Error("capability_source_version_changed", "capability_source_version_changed", 409);
  const defaults = await getCapabilityMaintenanceDefaults(siteId, sourceCapabilityId, sourceVersionId);
  if (defaults.activeTaskId) throw new CapabilityCenterV2Error("capability_maintenance_in_progress", defaults.activeTaskId, 409);
  const input: CapabilityGenerationInput = {
    request: {
      goal: experience.originalGoal,
      parameters: {},
      entryUrl: experience.startPage.url,
    },
    source: "Episode",
    experience: {
      episodeId: experience.episodeId,
      mode: "repair",
      execution: { startPage: experience.startPage, actions: experience.actions, endPage: experience.endPage },
      outcome: { status: experience.outcome, summary: experience.outcomeSummary },
      evidence: { episodeId: experience.episodeId, actionCount: experience.actions.length },
      capabilityContext: { sourceCapabilityId, sourceVersionId: capability.currentVersionId },
    },
  };
  const abstraction = await abstractCapabilityExperience(experience);
  const candidate: CapabilitySeed = {
    schemaVersion: "1.0",
    name: capability.name,
    description: capability.description,
    aliases: capability.aliases,
    intent: capability.contract.intent || capability.name,
    semantic: abstraction.semantic,
  };
  const derivedTaskInput = taskInput(experience, abstraction);
  return classifyCapabilityGeneration(siteId, input, {
    candidate,
    contract: capability.contract || derivedTaskInput.candidateSummary?.contract,
    experience,
    sourceAgentRunId: experience.agentRunId,
    repair: { capabilityId: sourceCapabilityId, baseVersionId: capability.currentVersionId },
    autoDispatch: async (task) => {
      if (task.status === "Pending" && process.env.CAPABILITY_V2_AUTO_DISPATCH !== "0") {
        void new RuntimeLauncher().dispatchOne(siteId, task.id).catch(() => undefined);
      }
    },
  });
}
