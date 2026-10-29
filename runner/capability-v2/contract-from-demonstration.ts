/**
 * The Contract as the demonstration states it, with no model in between.
 *
 * What the visitor asked, with the values they named, is the intent; the
 * values they named are the inputs, in the writing they used; where the run
 * stood is the scope; where it ended, when an input's value is written into
 * that address, is the one address condition. What the capability answers
 * with is known only once a draft has answered: the outputs are frozen from
 * the first draft that passed the demonstration, and the success conditions
 * are that each of them is there. No condition is ever a page's wording.
 */
import type { CapabilityContract, CapabilityDslProgram, CapabilityExperience, JsonObject, JsonValue } from "../../lib/capability-center-v2/model";
import { inferCapabilityScope } from "./browser-runtime";

type Parameters = Record<string, JsonValue>;

function key(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

/** Longest values first, so "Brown bear cushion" is replaced before "cushion" would be. */
function namedValues(parameters: Parameters) {
  return Object.entries(parameters)
    .filter((entry): entry is [string, string | number] => (typeof entry[1] === "string" && entry[1].trim().length > 0) || typeof entry[1] === "number")
    .map(([path, value]) => [path, String(value).trim()] as const)
    .sort((left, right) => right[1].length - left[1].length);
}

/** The goal with each named value written as its input: "How many books are in the {{category}} category?". */
export function intentFromGoal(goal: string, parameters: Parameters) {
  let intent = goal;
  for (const [path, value] of namedValues(parameters)) {
    const pattern = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu");
    if (pattern.test(intent)) intent = intent.replace(pattern, `{{${path}}}`);
  }
  return intent;
}

/** "quoteCount" → "Quote count", "product_name" → "Product name". */
export function humanize(name: string) {
  const words = name.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/[_-]+/gu, " ").trim().toLocaleLowerCase();
  return words ? words[0].toLocaleUpperCase() + words.slice(1) : name;
}

function typeOf(value: JsonValue): string {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

/** The inputs: each value the visitor named, in the writing they used, with that writing as its example. */
export function inputSchemaFromDemonstration(parameters: Parameters): JsonObject {
  const entries = Object.entries(parameters).filter(([, value]) => value !== null && typeof value !== "object");
  return {
    type: "object",
    properties: Object.fromEntries(entries.map(([path, value]) => [path, {
      type: typeOf(value),
      description: `${humanize(path)}, as the visitor names it; write it the way the example is written.`,
      examples: [value],
    }])),
    required: entries.map(([path]) => path),
    additionalProperties: false,
  } as JsonObject;
}

/**
 * The address the run ended on, as a template, when a path segment or a
 * query value is one of the inputs: `/tag/{{tag}}` for
 * `/tag/humor/page/2/index.html` — the template stops at the input, so the
 * page the visitor happened to be reading is not demanded of every run —
 * and `/search?controller=search&s={{query}}` for a query. Undefined when
 * no input is written into the address.
 */
export function addressTemplateFromEnd(endUrl: string, parameters: Parameters): string | undefined {
  let url: URL;
  try { url = new URL(endUrl); } catch { return undefined; }
  const values = namedValues(parameters);
  const inputFor = (raw: string) => {
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* not encoded */ }
    return values.find(([, value]) => key(value) === key(decoded))?.[0];
  };
  const segments = url.pathname.split("/").filter(Boolean);
  const at = segments.findIndex((segment) => inputFor(segment));
  if (at >= 0) {
    const path = segments.slice(0, at).map((segment) => `/${segment}`).join("");
    return `${path}/{{${inputFor(segments[at])}}}`;
  }
  const query: string[] = [];
  let found = false;
  for (const [name, value] of url.searchParams) {
    const path = inputFor(value);
    if (path) found = true;
    query.push(`${name}=${path ? `{{${path}}}` : value}`);
  }
  return found ? `${url.pathname}?${query.join("&")}` : undefined;
}

/**
 * The Contract before authoring: intent, inputs, scope and the address
 * condition. Its outputs are empty until `contractWithOutputs`.
 */
export function contractFromDemonstration(input: {
  goal: string;
  parameters: Parameters;
  experience: Pick<CapabilityExperience, "startPage" | "endPage">;
  trace: CapabilityDslProgram;
}): CapabilityContract {
  const inputSchema = inputSchemaFromDemonstration(input.parameters);
  const required = Array.isArray(inputSchema.required) ? inputSchema.required as string[] : [];
  const scope = inferCapabilityScope(input.trace.entry.mode === "Navigate" && input.trace.entry.url ? input.trace.entry.url : input.experience.startPage.url, input.trace.steps, {
    parameters: Object.entries(input.parameters).map(([name, value]) => ({ name, type: typeOf(value) as "string" | "number" | "boolean", description: humanize(name), required: true, exampleValue: typeof value === "object" || value === null ? "" : String(value) })),
  });
  const template = addressTemplateFromEnd(input.experience.endPage.url, input.parameters);
  return {
    intent: intentFromGoal(input.goal, input.parameters),
    inputSchema,
    // Open until a draft has answered: the quality rules read an empty,
    // closed schema as a Contract with nothing to answer with.
    outputSchema: { type: "object", properties: {}, required: [], additionalProperties: true } as JsonObject,
    preconditions: required.map((path) => ({ type: "inputExists", path })),
    successConditions: template ? [{ type: "urlTemplate", template }] : [],
    scope,
  };
}

function outputProperty(value: JsonValue): JsonObject {
  if (Array.isArray(value)) {
    const first = value.find((item) => item !== null && item !== undefined);
    return { type: "array", items: first === undefined ? { type: "string" } : outputProperty(first) };
  }
  if (value && typeof value === "object") {
    return {
      type: "object",
      properties: Object.fromEntries(Object.entries(value).map(([name, item]) => [name, { ...outputProperty(item), title: humanize(name) }])),
      additionalProperties: true,
    };
  }
  return { type: typeOf(value ?? "") };
}

/**
 * The Contract frozen on what the first passing draft answered with: every
 * field of its output is an output of the capability, and each one's
 * presence is a success condition. `declared` are the outputs the program's
 * stages declare they write; a field the draft returned without declaring it
 * (a harness can, the kernel refuses) is an output but not a required one.
 */
export function contractWithOutputs(contract: CapabilityContract, output: JsonObject, declared?: string[]): CapabilityContract {
  const entries = Object.entries(output).filter(([, value]) => value !== undefined);
  const properties = Object.fromEntries(entries.map(([name, value]) => [name, { ...outputProperty(value), title: humanize(name) }]));
  const required = entries.filter(([name, value]) => value !== null && (!declared || declared.includes(name))).map(([name]) => name);
  const kept = contract.successConditions.filter((condition) => !(condition && typeof condition === "object" && !Array.isArray(condition) && (condition as JsonObject).type === "outputExists"));
  return {
    ...contract,
    outputSchema: { type: "object", properties, required, additionalProperties: false } as JsonObject,
    successConditions: [...kept, ...required.map((path) => ({ type: "outputExists", path }))],
  };
}
