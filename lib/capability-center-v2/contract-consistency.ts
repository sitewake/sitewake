import type { CapabilityContract, CapabilityStageManifest, JsonValue } from "./model";

/**
 * A Contract is frozen by several independently written rule sets: the model
 * designs it, evidence alignment prunes it, hardening adds predicates, the
 * authoring manifest derives Stage I/O from it. Each rule is locally sound;
 * together they can still demand something no Stage may deliver, and then the
 * authoring loop burns its whole repair budget on a contradiction the model
 * cannot resolve (seen in production: `outputExists pageUrl` against an
 * outputSchema of `{targetTitle, targetUrl}`).
 *
 * This module states the invariants every frozen Contract must satisfy and is
 * consulted at each boundary that could break them: when the Contract is
 * assembled, before authoring spends a model call, and in the quality gate.
 */
export type ContractConsistencyIssue = { code: string; path: string; message: string };

const EXECUTABLE_CONDITION_TYPES = ["urlIncludes", "urlTemplate", "textIncludes", "textTemplate", "inputExists", "outputExists", "outputEquals"];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function rootPath(path: unknown) {
  return String(path || "").split(".").filter(Boolean)[0] || "";
}
function templateInputs(value: unknown) {
  return typeof value === "string" ? [...value.matchAll(/\{\{\s*([\p{L}_][\p{L}\p{N}_.-]*)\s*\}\}/gu)].map((match) => rootPath(match[1])) : [];
}

/** Output fields a Contract admits: the declared properties, or anything when the schema is open. */
function outputAdmits(outputSchema: Record<string, unknown>) {
  const declared = Object.keys(record(outputSchema.properties));
  const open = !declared.length && outputSchema.additionalProperties !== false || outputSchema.additionalProperties === true;
  return { declared, open };
}

export function inspectContractConsistency(
  contract: CapabilityContract,
  stages?: CapabilityStageManifest[],
): ContractConsistencyIssue[] {
  const issues: ContractConsistencyIssue[] = [];
  const inputSchema = record(contract.inputSchema);
  const inputs = Object.keys(record(inputSchema.properties));
  const outputSchema = record(contract.outputSchema);
  const output = outputAdmits(outputSchema);
  const required = Array.isArray(inputSchema.required) ? inputSchema.required.filter((item): item is string => typeof item === "string") : [];
  for (const name of required) {
    if (!inputs.includes(name)) issues.push({ code: "required_input_undeclared", path: `contract.inputSchema.required.${name}`, message: `Required input '${name}' is not declared.` });
  }
  const requiredOutputs = Array.isArray(outputSchema.required) ? outputSchema.required.filter((item): item is string => typeof item === "string") : [];
  for (const name of requiredOutputs) {
    if (!output.open && !output.declared.includes(name)) issues.push({ code: "required_output_undeclared", path: `contract.outputSchema.required.${name}`, message: `Required output '${name}' is not declared.` });
  }
  for (const name of templateInputs(contract.intent)) {
    if (!inputs.includes(name)) issues.push({ code: "condition_input_undeclared", path: "contract.intent", message: `Intent references undeclared input '${name}'.` });
  }

  const stageWrites = new Set((stages || []).flatMap((stage) => (stage.io?.writes.output || []).map(rootPath)));
  const conditions: Array<[string, JsonValue[]]> = [["preconditions", contract.preconditions || []], ["successConditions", contract.successConditions || []]];
  for (const [group, list] of conditions) {
    list.forEach((value, index) => {
      if (typeof value === "string") return;
      const condition = record(value);
      const type = String(condition.type || "");
      const path = `contract.${group}.${index}`;
      if (type === "inputExists") {
        const name = rootPath(condition.path);
        if (name && !inputs.includes(name)) issues.push({ code: "condition_input_undeclared", path, message: `${group}[${index}] requires input '${name}', which the inputSchema does not declare.` });
      }
      if (type === "textTemplate" || type === "urlTemplate") {
        for (const name of templateInputs(condition.template)) {
          if (!inputs.includes(name)) issues.push({ code: "condition_input_undeclared", path, message: `${group}[${index}] templates input '${name}', which the inputSchema does not declare.` });
        }
      }
      if (type === "outputExists" || type === "outputEquals") {
        const name = rootPath(condition.path);
        if (!name) return;
        if (!output.open && !output.declared.includes(name)) {
          issues.push({ code: "condition_output_undeclared", path, message: `${group}[${index}] requires output '${name}', which the outputSchema does not declare; no Stage may write it.` });
        } else if (stages && !stageWrites.has(name)) {
          issues.push({ code: "condition_output_unwritable", path, message: `${group}[${index}] requires output '${name}', but no Stage declares it in io.writes.output.` });
        }
      }
    });
  }

  const executable = (contract.successConditions || []).some((value) => typeof value === "string" ? Boolean(value.trim()) : EXECUTABLE_CONDITION_TYPES.includes(String(record(value).type || "")));
  if (!executable) issues.push({ code: "deterministic_success_condition_required", path: "contract.successConditions", message: "At least one executable success condition is required." });
  return issues;
}

export class ContractInconsistentError extends Error {
  readonly code = "capability_contract_inconsistent";
  /** Nothing the authoring model writes can satisfy a contradictory Contract. */
  readonly authorRepairable = false;
  readonly taskRetryable = true;

  constructor(readonly issues: ContractConsistencyIssue[]) {
    super(`capability_contract_inconsistent:${issues.map((issue) => `${issue.code}@${issue.path}`).join(",")}`);
    this.name = "ContractInconsistentError";
  }
}

/** Throw the first contradiction found; the message names each rule and where it bites. */
export function assertContractConsistent(contract: CapabilityContract, stages?: CapabilityStageManifest[]) {
  const issues = inspectContractConsistency(contract, stages);
  if (issues.length) throw new ContractInconsistentError(issues);
}
