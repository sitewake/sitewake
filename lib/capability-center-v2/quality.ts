import type {
  CapabilityContract,
  CapabilityProgram,
  CapabilityStageEvidence,
  JsonObject,
  JsonValue,
} from "./model";
import { hasUnsafeFirstCandidateSelection, inspectCapabilityJavaScriptProgram, sourceConsumesInputPath } from "./javascript-runtime";
import { capabilityRootPath } from "./stage-io";

export type CapabilityQualityIssue = { code: string; message: string; path?: string };
export type CapabilityQualityReport = {
  valid: boolean;
  issues: CapabilityQualityIssue[];
  declaredInputs: string[];
  requiredInputs: string[];
  programInputs: string[];
  contractInputs: string[];
  targetInputs: string[];
  scopeVerdict?: "pass" | "warn" | "fail";
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function rootPath(path: string) { return path.split(".").filter(Boolean)[0] || ""; }
function unique(values: string[]) { return [...new Set(values.filter(Boolean))].sort(); }
function templateInputs(value: unknown) {
  return typeof value === "string" ? [...value.matchAll(/\{\{\s*([\p{L}_][\p{L}\p{N}_.-]*)\s*\}\}/gu)].map((match) => rootPath(match[1])) : [];
}
function contractInputRefs(values: JsonValue[]) {
  const refs: string[] = [];
  for (const value of values) {
    const condition = record(value);
    if (condition.type === "inputExists" && typeof condition.path === "string") refs.push(rootPath(condition.path));
    if (condition.type === "textTemplate" || condition.type === "urlTemplate") refs.push(...templateInputs(condition.template));
  }
  return unique(refs);
}
function conditionIssue(value: JsonValue) {
  if (typeof value === "string") return value.trim() ? undefined : "condition_string_empty";
  const condition = record(value);
  const type = String(condition.type || "");
  if (!type) return "condition_type_missing";
  if (type === "textIncludes" || type === "urlIncludes") return typeof condition.value === "string" && condition.value.trim() ? undefined : "condition_value_missing";
  if (type === "textTemplate" || type === "urlTemplate") return typeof condition.template === "string" && condition.template.trim() ? undefined : "condition_template_missing";
  if (type === "inputExists" || type === "outputExists") return typeof condition.path === "string" && condition.path.trim() ? undefined : "condition_path_missing";
  if (type === "outputEquals") return typeof condition.path === "string" && condition.path.trim() && Object.hasOwn(condition, "value") ? undefined : "condition_output_equals_invalid";
  if (type === "modelGoal") return typeof condition.goal === "string" && condition.goal.trim() ? undefined : "condition_goal_missing";
  return "condition_type_unsupported";
}
function containsLiteral(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => containsLiteral(item, needle));
  if (value && typeof value === "object") return Object.values(value).some((item) => containsLiteral(item, needle));
  return false;
}

// Demonstration examples frequently appear in model-authored explanatory
// comments. Comments are not executable capability semantics, so they must
// not make an otherwise parameterized module fail the leakage gate. Keep
// quoted strings and template literals intact: a value embedded there still
// affects runtime behaviour and must remain a rejection.
export function stripJavaScriptComments(source: string) {
  return source.replace(
    /(["'`])(?:\\.|(?!\1)[\s\S])*\1|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    (match, quote: string | undefined) => quote ? match : match.replace(/[^\r\n]/g, " "),
  );
}
function distinctCases(cases: Array<Record<string, JsonValue>>, required: string[]) {
  return new Set(cases.map((item) => JSON.stringify(required.map((key) => item[key])))).size;
}
function targetEvidenceValues(evidence: CapabilityStageEvidence[], path: string) {
  return new Set(evidence.filter((item) => item.kind === "target" && item.key === path && item.unique === true).map((item) => JSON.stringify(item.value)));
}

export function inspectCapabilityQuality(
  contract: CapabilityContract,
  program: CapabilityProgram,
  options: {
    demonstrationParameters?: Record<string, JsonValue>;
    validationCases?: Array<Record<string, JsonValue>>;
    requireIndependentCases?: boolean;
    requireTargetEvidence?: boolean;
    targetEvidence?: CapabilityStageEvidence[];
    source?: string;
    summary?: { name?: string; description?: string; aliases?: string[] };
  } = {},
): CapabilityQualityReport {
  const issues: CapabilityQualityIssue[] = [];
  const schema = record(contract.inputSchema);
  const properties = record(schema.properties);
  const declaredInputs = unique(Object.keys(properties));
  const requiredInputs = unique(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : []);
  const defaultInputs = declaredInputs.filter((name) => Object.hasOwn(record(properties[name]), "default"));
  for (const name of defaultInputs) {
    if (requiredInputs.includes(name)) issues.push({ code: "default_input_must_be_optional", message: `Input '${name}' declares a default but is required.`, path: `contract.inputSchema.properties.${name}` });
  }
  const parameterRoles = Array.isArray(program?.parameterRoles) ? program.parameterRoles : [];
  const targetBindings = Array.isArray(program?.targetBindings) ? program.targetBindings : [];
  const stages = Array.isArray(program?.stages) ? program.stages : [];
  const programInputs = unique(parameterRoles.map((item) => rootPath(item.inputPath)));
  const targetInputs = unique(parameterRoles.filter((item) => item.role === "target").map((item) => rootPath(item.inputPath)));
  const successInputs = contractInputRefs(contract.successConditions);
  const contractInputs = unique([...contractInputRefs(contract.preconditions), ...successInputs, ...templateInputs(contract.intent)]);

  let scopeVerdict: CapabilityQualityReport["scopeVerdict"];
  const declaredScope = contract.scope;
  if (declaredScope) {
    scopeVerdict = "pass";
    const match = declaredScope.match;
    if (match?.requiredInputPaths?.some((path) => !declaredInputs.includes(rootPath(path)))) {
      scopeVerdict = "fail";
      issues.push({ code: "scope_input_undeclared", message: "Scope references an undeclared input.", path: "contract.scope.match.requiredInputPaths" });
    }
    if (declaredScope.kind === "page-scoped" && !match?.urlPatterns?.length && !match?.tokens?.length) {
      scopeVerdict = "fail";
      issues.push({ code: "page_scope_match_required", message: "Page-scoped capabilities need a stable URL or token matcher.", path: "contract.scope.match" });
    }
  }

  const protocol = inspectCapabilityJavaScriptProgram(program);
  for (const code of protocol.issues) issues.push({ code, message: code, path: "program" });

  const outputSchema = record(contract.outputSchema);
  const outputProperties = record(outputSchema.properties);
  if (outputSchema.type !== "object") issues.push({ code: "output_schema_object_required", message: "Contract outputSchema must be a complete object JSON Schema.", path: "contract.outputSchema" });
  if (!Object.keys(outputProperties).length && outputSchema.additionalProperties !== true) issues.push({ code: "output_schema_properties_required", message: "Contract outputSchema must declare properties or explicitly allow additional properties.", path: "contract.outputSchema.properties" });
  if (Array.isArray(outputSchema.required)) {
    for (const key of outputSchema.required.filter((item): item is string => typeof item === "string")) {
      if (!Object.hasOwn(outputProperties, key)) issues.push({ code: "output_required_undeclared", message: `Required output '${key}' is not declared.`, path: `contract.outputSchema.required.${key}` });
    }
  }

  const stageStateWrites = stages.map((stage) => {
    const writes = stage.io?.writes?.state || [];
    return writes.map((path) => capabilityRootPath(path));
  });
  for (const [index, stage] of stages.entries()) {
    const io = stage.io;
    if (!io) {
      issues.push({ code: "stage_io_required", message: `Stage '${stage.id}' must declare input/state reads and state/output writes.`, path: `program.stages.${stage.id}.io` });
      continue;
    }
    const declaredInputs = new Set(Object.keys(properties));
    for (const path of io.reads.input) {
      if (!declaredInputs.has(capabilityRootPath(path))) issues.push({ code: "stage_io_input_undeclared", message: `Stage '${stage.id}' reads undeclared input '${path}'.`, path: `program.stages.${stage.id}.io.reads.input` });
    }
    for (const path of io.writes.output) {
      if (!Object.hasOwn(outputProperties, capabilityRootPath(path)) && outputSchema.additionalProperties !== true) {
        issues.push({ code: "stage_io_output_undeclared", message: `Stage '${stage.id}' writes undeclared output '${path}'.`, path: `program.stages.${stage.id}.io.writes.output` });
      }
    }
    for (const path of io.reads.state) {
      const root = capabilityRootPath(path);
      const available = stageStateWrites.some((writes, writerIndex) => writerIndex !== index && writes.includes(root));
      if (!available) issues.push({ code: "stage_io_state_read_unavailable", message: `Stage '${stage.id}' reads state '${path}' without a declared producer.`, path: `program.stages.${stage.id}.io.reads.state` });
    }
    if (stage.navigation === "none" && stage.io.writes.output.length && stage.effect === "write") {
      // Keep this branch intentionally empty: a write can finish in the
      // current document. The navigation enum is checked by the runtime.
    }
  }
  const requiredOutputs = Array.isArray(outputSchema.required) ? outputSchema.required.filter((item): item is string => typeof item === "string") : [];
  const terminalStage = stages.at(-1);
  if (terminalStage && requiredOutputs.length) {
    const terminalWrites = new Set((terminalStage.io?.writes.output || []).map(capabilityRootPath));
    for (const output of requiredOutputs) {
      if (!terminalWrites.has(capabilityRootPath(output)) && outputSchema.additionalProperties !== true) {
        issues.push({ code: "stage_io_terminal_output_missing", message: `Terminal Stage '${terminalStage.id}' must declare required output '${output}'.`, path: `program.stages.${terminalStage.id}.io.writes.output` });
      }
    }
  }

  for (const key of requiredInputs) {
    if (!declaredInputs.includes(key)) issues.push({ code: "required_input_undeclared", message: `Required input '${key}' is not declared.`, path: `contract.inputSchema.required.${key}` });
    if (!programInputs.includes(key)) issues.push({ code: "required_input_not_consumed", message: `Required input '${key}' has no parameter role.`, path: `program.parameterRoles.${key}` });
  }
  for (const key of unique([...programInputs, ...contractInputs])) {
    if (!declaredInputs.includes(key)) issues.push({ code: "input_reference_undeclared", message: `Program or Contract references undeclared input '${key}'.`, path: key });
  }
  for (const path of targetInputs) {
    if (!targetBindings.some((binding) => rootPath(binding.inputPath) === path)) issues.push({ code: "target_binding_required", message: `Target input '${path}' requires a binding.`, path: `program.targetBindings.${path}` });
    if (!successInputs.includes(path)) issues.push({ code: "target_success_condition_required", message: `Target input '${path}' must be verified by a parameterized success condition.`, path: `contract.successConditions.${path}` });
  }
  for (const stage of stages) {
    if (stage.effect === "write" && stage.resumePolicy !== "reconcile-before-retry") issues.push({ code: "write_stage_reconciliation_required", message: `Write stage '${stage.id}' must reconcile before retry.`, path: `program.stages.${stage.id}` });
  }

  for (const [group, conditions] of [["preconditions", contract.preconditions], ["successConditions", contract.successConditions]] as const) {
    conditions.forEach((condition, index) => {
      const code = conditionIssue(condition);
      if (code) issues.push({ code, message: code, path: `contract.${group}.${index}` });
    });
  }

  const executableConditions = contract.successConditions.filter((value) => {
    if (conditionIssue(value)) return false;
    if (typeof value === "string") return Boolean(value.trim());
    return ["urlIncludes", "urlTemplate", "textIncludes", "textTemplate", "inputExists", "outputExists", "outputEquals"].includes(String(record(value).type || ""));
  });
  if (!executableConditions.length) issues.push({ code: "deterministic_success_condition_required", message: "At least one executable success condition is required before publishing." });

  for (const [key, raw] of Object.entries(options.demonstrationParameters || {})) {
    if (!requiredInputs.includes(key) || typeof raw !== "string" || raw.trim().length < 2) continue;
    const demonstration = raw.trim();
    if (options.source && containsLiteral(stripJavaScriptComments(options.source), demonstration)) issues.push({ code: "demonstration_value_leaked", message: `Demonstration value for '${key}' was baked into executable JavaScript source.`, path: `source.${key}` });
    if (containsLiteral({ stages, intent: contract.intent, preconditions: contract.preconditions, successConditions: contract.successConditions }, demonstration)) issues.push({ code: "demonstration_value_leaked", message: `Demonstration value for '${key}' was baked into Program/Contract semantics.`, path: `program.${key}` });
    // Contract inputAliases are an explicit, parameterized site-language
    // mapping (for example 用户词“衣服” -> 站点词“Clothes”). They are data
    // consumed by the host before the Stage runs, not a concrete value baked
    // into the user-facing capability summary. Only inspect presentation
    // fields here; executable semantics and source remain checked above.
    const presentation = options.summary
      ? { name: options.summary.name, description: options.summary.description, aliases: options.summary.aliases }
      : undefined;
    if (containsLiteral(presentation, demonstration)) issues.push({ code: "demonstration_value_leaked", message: `Demonstration value for '${key}' was baked into the capability summary.`, path: `summary.${key}` });
  }

  if (options.requireIndependentCases && requiredInputs.length) {
    const complete = (options.validationCases || []).filter((item) => requiredInputs.every((key) => item[key] !== undefined));
    if (complete.length < 2 || distinctCases(complete, requiredInputs) < 2) issues.push({ code: "independent_validation_cases_required", message: "A parameterized capability requires two distinct complete validation cases." });
  }
  if (options.validationCases?.length) {
    for (const name of defaultInputs) {
      if (!options.validationCases.some((item) => item[name] === undefined)) {
        issues.push({ code: "default_omission_validation_required", message: `A validation case must omit defaulted input '${name}'.`, path: `validationCases.${name}` });
      }
    }
  }
  if (options.requireTargetEvidence) {
    const evidence = options.targetEvidence || [];
    for (const path of targetInputs) if (targetEvidenceValues(evidence, path).size < 2) issues.push({ code: "independent_target_evidence_required", message: `Target '${path}' requires two distinct unique identities.`, path: `evidence.${path}` });
  }

  if (options.source) {
    for (const path of programInputs) {
      if (!sourceConsumesInputPath(options.source, path)) issues.push({ code: "declared_input_not_consumed_by_source", message: `JavaScript source does not consume declared input '${path}'.`, path: `source.${path}` });
    }
    if (targetInputs.length && (hasUnsafeFirstCandidateSelection(options.source) || /\.(?:first\s*\(\s*\)|nth\s*\(\s*0\s*\))/.test(options.source))) {
      issues.push({ code: "target_first_candidate_forbidden", message: "Target resolution must not select the first similar candidate by default.", path: "source" });
    }
  }

  return { valid: issues.length === 0, issues, declaredInputs, requiredInputs, programInputs, contractInputs, targetInputs, scopeVerdict };
}

export function assertCapabilityQuality(contract: CapabilityContract, program: CapabilityProgram, options?: Parameters<typeof inspectCapabilityQuality>[2]) {
  const report = inspectCapabilityQuality(contract, program, options);
  if (!report.valid) throw new Error(`capability_quality_rejected:${report.issues.map((issue) => issue.code).join(",")}`);
  return report;
}

export function qualityReportJson(report: CapabilityQualityReport): JsonObject {
  return JSON.parse(JSON.stringify(report)) as JsonObject;
}
