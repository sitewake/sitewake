import type { CapabilityContract, JsonObject, JsonValue } from "./model";

const INPUT_TEMPLATE_PATTERN = /\{\{\s*([\p{L}_][\p{L}\p{N}_.-]*)\s*\}\}/gu;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function capabilityInputPathValue(root: unknown, path: string): unknown {
  return path.split(".").filter(Boolean).reduce((value, key) => record(value)[key], root);
}

export function capabilityTemplateInputPaths(template: unknown) {
  return [...new Set([...String(template || "").matchAll(INPUT_TEMPLATE_PATTERN)].map((match) => match[1]))];
}

/** Resolve only defaults declared by the immutable Contract input schema. */
export function resolveCapabilityInputDefaults(contract: CapabilityContract | undefined, provided: Record<string, JsonValue>) {
  const properties = record(contract?.inputSchema).properties;
  const resolved: Record<string, JsonValue> = { ...provided };
  for (const [path, schemaValue] of Object.entries(record(properties))) {
    const schema = record(schemaValue);
    if (resolved[path] === undefined && Object.hasOwn(schema, "default")) {
      const value = schema.default;
      if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" || Array.isArray(value)) {
        resolved[path] = value as JsonValue;
      }
    }
  }
  return resolved as JsonObject;
}

export function renderCapabilityInputTemplate(
  template: unknown,
  input: Record<string, JsonValue>,
  missing: (path: string) => never = (path) => { throw new Error(`capability_input_required:${path}`); },
) {
  return String(template || "").replace(INPUT_TEMPLATE_PATTERN, (_match, path: string) => {
    const value = capabilityInputPathValue(input, path);
    if (value === undefined) return missing(path);
    return String(value);
  });
}

function decodedUrlText(value: string) {
  try { return decodeURIComponent(value.replace(/\+/g, " ")); }
  catch { return value; }
}

/**
 * Match a rendered URL template by URL semantics rather than raw href bytes.
 * Browsers percent-encode Unicode and may encode query spaces as either `+`
 * or `%20`; direct string inclusion therefore rejects correct executions.
 */
export function capabilityUrlTemplateMatches(
  actualValue: string,
  template: unknown,
  input: Record<string, JsonValue>,
) {
  const rendered = renderCapabilityInputTemplate(template, input);
  if (!rendered) return false;
  if (decodedUrlText(actualValue).includes(decodedUrlText(rendered))) return true;
  try {
    const actual = new URL(actualValue);
    const expected = new URL(rendered, actual.origin);
    const hasExplicitOrigin = /^[a-z][a-z\d+.-]*:\/\//i.test(rendered);
    if (hasExplicitOrigin && actual.origin !== expected.origin) return false;
    if (expected.pathname && actual.pathname !== expected.pathname) return false;
    for (const key of new Set(expected.searchParams.keys())) {
      const expectedValues = expected.searchParams.getAll(key);
      const actualValues = actual.searchParams.getAll(key);
      if (expectedValues.length !== actualValues.length || expectedValues.some((value, index) => value !== actualValues[index])) return false;
    }
    if (expected.hash && actual.hash !== expected.hash) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * The inputs a request fills in a capability's intent.
 *
 * A published intent is a sentence with holes in it: 「给我查看{{celebrityName}}
 * 热搜」. When the request is that sentence with the holes filled, the capability
 * is the answer and the holes are its arguments, and no model has to decide it.
 *
 * Until this existed, a request could only route on its own by equalling a
 * capability's name or one of its aliases, so the very sentence a capability was
 * generated from did not reach it with a different name in the middle: asked for
 * a different singer, the agent went back to clicking around the page while the
 * capability it had just published sat unused in the catalogue.
 *
 * The match is deliberately literal. Holes are non-empty, what surrounds them
 * has to be there in full, and a template that is all hole matches nothing —
 * otherwise 「{{keyword}}」 would answer every request ever made.
 */
export function matchCapabilityIntentTemplate(template: unknown, goal: string): Record<string, string> | undefined {
  const pattern = /\{\{\s*([\p{L}_][\p{L}\p{N}_.-]*)\s*\}\}/gu;
  const text = comparableIntentText(template);
  const request = comparableIntentText(goal);
  if (!text || !request) return undefined;
  const literals: string[] = [];
  const paths: string[] = [];
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    literals.push(text.slice(index, match.index));
    paths.push(match[1]);
    index = match.index + match[0].length;
  }
  literals.push(text.slice(index));
  if (!paths.length) return undefined;
  // Something has to be recognisable besides the holes, and two holes cannot sit
  // against each other: nothing would say where one value ends.
  if (literals.join("").replace(/\s+/gu, "").length < 2) return undefined;
  if (literals.slice(1, -1).some((literal) => !literal.trim())) return undefined;
  const expression = new RegExp(`^${literals.map(escapeRegExp).join("(.+?)")}$`, "u");
  const found = expression.exec(request);
  if (!found) return undefined;
  const input: Record<string, string> = {};
  for (const [position, path] of paths.entries()) {
    const value = (found[position + 1] || "").trim();
    if (!value) return undefined;
    if (input[path] !== undefined && input[path] !== value) return undefined;
    input[path] = value;
  }
  return input;
}

/** Width, case and spacing differences are not differences of meaning here. */
function comparableIntentText(value: unknown) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
