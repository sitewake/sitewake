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
