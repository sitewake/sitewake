import type { CapabilityContract, CapabilityStageManifest, JsonValue } from "./model";

/**
 * The invariants a frozen Contract and the Stage I/O derived from it should
 * satisfy. A model used to design the Contract, and several rule sets then
 * pruned and hardened it; together they could demand something no Stage may
 * deliver (seen in production: `outputExists pageUrl` against an outputSchema
 * of `{targetTitle, targetUrl}`), and authoring burned its budget on it. The
 * Contract is now stated by the demonstration and frozen on what the first
 * passing draft answered, so the contradiction has no author left; the
 * invariants are still inspected, and what they find is a note on the version.
 */
export type ContractConsistencyIssue = { code: string; path: string; message: string };

/**
 * Every code this inspector reports. None blocks: a check earns the right to
 * block by a recorded module it refuses or a benchmark failure it produced
 * (benchmark/GATES.md), and none of these had either.
 */
export const DEMOTED_CONTRACT_CHECKS: Record<string, string> = {
  condition_input_undeclared: "a condition or the intent references an undeclared input",
  condition_output_undeclared: "a success condition names an output the schema does not declare",
  condition_output_unwritable: "a success condition names an output no Stage declares it writes",
  deterministic_success_condition_required: "no success condition is executable",
  required_input_undeclared: "a required input is not declared",
  required_output_undeclared: "a required output is not declared",
};

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
  // A Contract whose outputs are still open is one a draft has not answered
  // yet; its conditions arrive with the outputs, when they are frozen.
  if (!executable && !output.open) issues.push({ code: "deterministic_success_condition_required", path: "contract.successConditions", message: "At least one executable success condition is required." });
  return issues;
}
