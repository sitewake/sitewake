import type { CapabilityContract, JsonValue } from "./model";
import { capabilityRunPage } from "./entry-page";
import { capabilityInputPathValue, capabilityTemplateInputPaths, capabilityUrlTemplateMatches, renderCapabilityInputTemplate, resolveCapabilityInputDefaults } from "./input-template";
import { capabilityUrlHas } from "./entry-page";
import { capabilityTextIncludes } from "./text-match";
import { expectedValuesEqual } from "./value-equality";

/**
 * The Contract is the one authority on where a capability starts, what its
 * inputs are and what success looks like. Every host — the visitor's widget,
 * the authoring draft, independent validation, the search and runtime routes
 * — reads the decisions made here and makes none of its own. Two hosts that
 * each derived them disagreed: a record carried a capability's input instead
 * of the run's, a search offered what the runtime refused, a condition passed
 * in validation and failed in the widget because one decoded the address and
 * the other did not.
 */

export type CapabilityInputAliases = Record<string, Record<string, string>>;
type Input = Record<string, JsonValue>;
/** The parts of a Contract these decisions read; a host may hold only some of them, and may hold them loosely typed. */
type ContractLike = {
  preconditions?: JsonValue[];
  successConditions?: JsonValue[];
  scope?: CapabilityContract["scope"] | Record<string, unknown>;
  inputSchema?: CapabilityContract["inputSchema"] | Record<string, unknown>;
  inputAliases?: CapabilityInputAliases;
};
const asContract = (contract: ContractLike | undefined) => contract as CapabilityContract | undefined;

/** A visitor's word for a value replaced by the site's, where the Contract learned one. */
export function applyCapabilityInputAliases(aliases: CapabilityInputAliases | undefined, input: Input): Input {
  if (!aliases) return input;
  const resolved: Input = { ...input };
  for (const [name, values] of Object.entries(aliases)) {
    const value = resolved[name];
    if (typeof value !== "string") continue;
    const mapped = values[value];
    if (typeof mapped === "string" && mapped.trim()) resolved[name] = mapped;
  }
  return resolved;
}

export type ResolvedCapabilityInput = {
  /** The caller's values with the Contract's defaults filled in: what the input schema is checked against. */
  declared: Input;
  /** The same values in the site's writing: what the program runs with and what conditions are rendered from. */
  site: Input;
};

/** Defaults then aliases, once, for every host. A program may carry the aliases it was published with. */
export function resolveCapabilityInput(contract: ContractLike | undefined, provided: Input, programAliases?: CapabilityInputAliases): ResolvedCapabilityInput {
  const declared = resolveCapabilityInputDefaults(asContract(contract), provided);
  return { declared, site: applyCapabilityInputAliases(programAliases || contract?.inputAliases, declared) };
}

export type ResolvedCapabilityRun = ResolvedCapabilityInput & {
  /** Where the run starts: the current page when it qualifies, the bound page otherwise; `undefined` when the Contract binds no page. */
  startUrl: string | undefined;
  /** The program entry that gets there; `undefined` leaves the program's own entry standing. */
  entry: { mode: "CurrentPage" } | { mode: "Navigate"; url: string } | undefined;
};

/** Everything a host needs to run a capability from `currentUrl` with `input`. */
export function resolveCapabilityRun(contract: ContractLike | undefined, options: { currentUrl?: string; input: Input; programAliases?: CapabilityInputAliases }): ResolvedCapabilityRun {
  const page = capabilityRunPage(contract ? { preconditions: contract.preconditions || [], scope: asContract(contract)?.scope } : undefined, options.currentUrl);
  return { ...resolveCapabilityInput(contract, options.input, options.programAliases), startUrl: page.url, entry: page.entry };
}

export type PageFacts = { url: string; text: string };

export type ConditionFailure = {
  code: string;
  condition: JsonValue;
  /** For a template condition: the text it rendered to, and the inputs it names. */
  rendered?: string;
  inputPaths?: string[];
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * The Contract's preconditions against a page, judged the same way in every
 * host. Every unmet condition is returned, with the code the hosts already
 * raise for it, so the host decides how to say it.
 */
export function checkPreconditions(contract: Pick<ContractLike, "preconditions"> | undefined, page: PageFacts, input: ResolvedCapabilityInput): ConditionFailure[] {
  const failures: ConditionFailure[] = [];
  for (const raw of contract?.preconditions || []) {
    if (typeof raw === "string") {
      if (!capabilityTextIncludes(page.text, raw)) failures.push({ code: `precondition_text_missing:${raw}`, condition: raw });
      continue;
    }
    const condition = asObject(raw);
    const type = String(condition.type || "");
    if (type === "urlIncludes" && !capabilityUrlHas(page.url, String(condition.value || ""))) failures.push({ code: "precondition_url_mismatch", condition: raw });
    if (type === "urlTemplate" && !capabilityUrlTemplateMatches(page.url, condition.template, input.site)) failures.push({ code: "precondition_url_mismatch", condition: raw });
    if (type === "textIncludes" && !capabilityTextIncludes(page.text, condition.value)) failures.push({ code: "precondition_text_missing", condition: raw });
    if (type === "textTemplate") {
      const rendered = renderCapabilityInputTemplate(condition.template, input.site);
      if (!capabilityTextIncludes(page.text, rendered)) failures.push({ code: "precondition_text_missing", condition: raw, rendered, inputPaths: capabilityTemplateInputPaths(condition.template) });
    }
    if (type === "inputExists" && capabilityInputPathValue(input.declared, String(condition.path || "")) === undefined) failures.push({ code: `precondition_input_missing:${String(condition.path || "")}`, condition: raw });
  }
  return failures;
}

export type SuccessVerdict = {
  /** Conditions about the run itself — its output and the address it ended on — that did not hold. */
  failures: ConditionFailure[];
  /** Text the page was expected to show and did not. The page is a fact about a moving world; this is reported, not charged. */
  unmetText: string[];
  /** The Contract names no deterministic condition, or asks for a model's judgement. */
  needsModelJudge: boolean;
};

/**
 * The Contract's success conditions against the run's end state, judged the
 * same way in every host: output and address conditions decide, text
 * conditions are recorded.
 */
export function evaluateSuccessConditions(contract: Pick<ContractLike, "successConditions"> | undefined, end: PageFacts & { output: Record<string, unknown> }, input: ResolvedCapabilityInput): SuccessVerdict {
  const conditions = contract?.successConditions || [];
  const failures: ConditionFailure[] = [];
  const unmetText: string[] = [];
  let needsModelJudge = conditions.length === 0;
  for (const raw of conditions) {
    if (typeof raw === "string") {
      if (!capabilityTextIncludes(end.text, raw)) unmetText.push(raw);
      continue;
    }
    const condition = asObject(raw);
    const type = String(condition.type || "");
    if (type === "modelGoal") { needsModelJudge = true; continue; }
    if (type === "urlIncludes" && !capabilityUrlHas(end.url, String(condition.value || ""))) failures.push({ code: "success_url_mismatch", condition: raw });
    if (type === "urlTemplate" && !capabilityUrlTemplateMatches(end.url, condition.template, input.site)) failures.push({ code: "success_url_mismatch", condition: raw });
    if (type === "textIncludes" && !capabilityTextIncludes(end.text, condition.value)) unmetText.push(String(condition.value || ""));
    if (type === "textTemplate") {
      const rendered = renderCapabilityInputTemplate(condition.template, input.site);
      if (!capabilityTextIncludes(end.text, rendered)) unmetText.push(rendered);
    }
    if (type === "inputExists" && capabilityInputPathValue(input.declared, String(condition.path || "")) === undefined) failures.push({ code: "success_input_missing", condition: raw });
    if (type === "outputEquals" && !expectedValuesEqual(capabilityInputPathValue(end.output, String(condition.path || "")), condition.value)) failures.push({ code: "success_output_mismatch", condition: raw });
    if (type === "outputExists" && capabilityInputPathValue(end.output, String(condition.path || "")) === undefined) failures.push({ code: "success_output_missing", condition: raw });
  }
  return { failures, unmetText, needsModelJudge };
}
