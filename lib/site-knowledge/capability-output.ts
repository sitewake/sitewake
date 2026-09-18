import safeRegex from "safe-regex2";
import type { JsonSchema, JsonValue } from "./protocol";

function outputPath(parent: string, key: string | number) {
  return parent ? `${parent}.${key}` : String(key);
}

function stringMatchesFormat(
  value: string,
  format: NonNullable<JsonSchema["format"]>,
): boolean {
  if (format === "date") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day;
  }
  if (format === "date-time") {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
    return Boolean(match)
      && stringMatchesFormat(match![1], "date")
      && Number(match![2]) <= 23
      && Number(match![3]) <= 59
      && Number(match![4]) <= 59
      && (match![6] === undefined
        || (Number(match![6]) <= 23 && Number(match![7]) <= 59))
      && Number.isFinite(Date.parse(value));
  }
  if (format === "email") {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }
  try {
    const parsed = new URL(value);
    return /^[a-z][a-z0-9+.-]*:/i.test(value) && Boolean(parsed.protocol);
  } catch {
    return false;
  }
}

type CapabilityContractDomain = "capability_output" | "capability_run_input";

const compiledPatterns = new Map<string, RegExp>();

function safePattern(pattern: string, domain: string, path: string) {
  if (pattern.length > 512 || !safeRegex(pattern, { limit: 20 })) {
    throw new Error(`${domain}_pattern_unsafe:${path}`);
  }
  let compiled = compiledPatterns.get(pattern);
  if (!compiled) {
    try {
      compiled = new RegExp(pattern);
    } catch {
      throw new Error(`${domain}_pattern_invalid:${path}`);
    }
    if (compiledPatterns.size >= 200) compiledPatterns.clear();
    compiledPatterns.set(pattern, compiled);
  }
  return compiled;
}

/** Reject unsafe AI-authored schema regexes before a Revision can publish. */
export function assertSafeCapabilitySchema(
  schema: JsonSchema,
  path = "schema",
) {
  if (schema.pattern) safePattern(schema.pattern, "capability_contract", path);
  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) {
      assertSafeCapabilitySchema(child, outputPath(path, key));
    }
  }
  if (schema.items) assertSafeCapabilitySchema(schema.items, `${path}[]`);
}

function assertContractValue(
  schema: JsonSchema,
  value: JsonValue,
  path: string,
  domain: CapabilityContractDomain,
) {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${domain}_type:${path}:object`);
    }
    const record = value as Record<string, JsonValue>;
    const missing = (schema.required || []).filter((key) =>
      !Object.prototype.hasOwnProperty.call(record, key));
    if (missing.length) {
      throw new Error(
        `${domain}_required:${missing.map((key) =>
          outputPath(path, key)).join(",")}`,
      );
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      assertContractValue(
        childSchema,
        record[key],
        outputPath(path, key),
        domain,
      );
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      throw new Error(`${domain}_type:${path}:array`);
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new Error(`${domain}_min_items:${path}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new Error(`${domain}_max_items:${path}`);
    }
    if (schema.items) {
      value.forEach((item, index) =>
        assertContractValue(
          schema.items!,
          item,
          outputPath(path, index),
          domain,
        ));
    }
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") {
      throw new Error(`${domain}_type:${path}:string`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new Error(`${domain}_min_length:${path}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new Error(`${domain}_max_length:${path}`);
    }
    if (schema.pattern) {
      if (value.length > 32_768) {
        throw new Error(`${domain}_max_length:${path}`);
      }
      if (!safePattern(schema.pattern, domain, path).test(value)) {
        throw new Error(`${domain}_pattern:${path}`);
      }
    }
    if (schema.format && !stringMatchesFormat(value, schema.format)) {
      throw new Error(`${domain}_format:${path}:${schema.format}`);
    }
  } else if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${domain}_type:${path}:number`);
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new Error(`${domain}_minimum:${path}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new Error(`${domain}_maximum:${path}`);
    }
  } else if (schema.type === "boolean" && typeof value !== "boolean") {
    throw new Error(`${domain}_type:${path}:boolean`);
  }
  if (schema.enum?.length && !schema.enum.includes(value as never)) {
    throw new Error(`${domain}_enum:${path}`);
  }
}

/** Runtime contract gate shared by cloud and connected-browser execution. */
export function assertCapabilityOutput(
  schema: JsonSchema,
  output: Record<string, JsonValue>,
) {
  assertContractValue(schema, output, "output", "capability_output");
}

/** Full recursive input gate used before any published Revision can run. */
export function assertCapabilityInput(
  schema: JsonSchema,
  input: Record<string, JsonValue>,
) {
  assertContractValue(schema, input, "", "capability_run_input");
}
