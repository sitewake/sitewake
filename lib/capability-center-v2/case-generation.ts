import {
  assertCapabilityInput,
  assertCapabilityOutput,
  assertSafeCapabilitySchema,
} from "../site-knowledge/capability-output";
import { sha256HexBytes, sha256HexText } from "../site-knowledge/sha256";
import type { JsonSchema as RuntimeJsonSchema } from "../site-knowledge/protocol";
import { declaredValueShape, inspectCapabilityQuality, writtenValueShape } from "./quality";
import {
  capabilityUrlTemplateMatches,
  renderCapabilityInputTemplate,
} from "./input-template";
import type {
  C1AuthoringOutput,
  C2CaseGenerationInput,
  C2CaseGenerationOutput,
  CapabilityCandidate,
  CapabilityCaseDiscoveryEvidence,
  CapabilityCaseDiscoveryEvidenceRef,
  CapabilityCaseDiscoveryRegion,
  CapabilityCaseContext,
  CapabilityCaseContextRef,
  CapabilityCaseEvidenceRegion,
  CapabilityContract,
  CapabilityProgram,
  CapabilityValidationCase,
  JsonObject,
  JsonValue,
} from "./model";

export const CAPABILITY_CASE_CONTEXT_MAX_BYTES = 64 * 1024;
export const CAPABILITY_CASE_DISCOVERY_EVIDENCE_MAX_BYTES = 64 * 1024;

export type CapabilityCaseModelCase = {
  input: JsonObject;
  expected: JsonObject;
};

export type CapabilityCaseGenerationModelOutput = {
  cases: CapabilityCaseModelCase[];
};

export type ParsedCapabilityCaseContext = {
  value: CapabilityCaseContext;
  byteLength: number;
  evidenceRegions: CapabilityCaseEvidenceRegion[];
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonObject(value: unknown, code: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(code);
  return value as JsonObject;
}

function requiredString(value: unknown, code: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value;
}

function stringArray(value: unknown, code: string) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  )
    throw new Error(code);
  return value as string[];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Stable JSON text used by every C2 suite identity calculation. */
export function canonicalCapabilityCaseJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(canonical(value));
}

export function capabilityValidationSuiteHash(suite: {
  cases: CapabilityValidationCase[];
}) {
  return `sha256:${sha256HexText(canonicalCapabilityCaseJson({ cases: suite.cases }))}`;
}

export const canonicalValidationSuiteHash = capabilityValidationSuiteHash;

function candidateFromAuthoring(input: C1AuthoringOutput): CapabilityCandidate {
  return cloneJson({
    name: input.name,
    description: input.description,
    aliases: input.aliases,
    contract: input.contract,
    program: input.program,
    ...(input.replacementPlan
      ? { replacementPlan: input.replacementPlan }
      : {}),
  });
}

const PRIVATE_BOUNDARY_FIELDS = new Set([
  "caseContextRef",
  "validationCases",
  "groundingExamples",
  "dependencyLedger",
  "candidateSource",
  "candidateBundle",
  "caseContext",
  "caseDiscoveryEvidence",
  "caseDiscoveryEvidenceRef",
  "caseId",
  "cases",
  "testCases",
  "validationSuite",
  "validationSuiteHash",
]);

function assertNoPrivateBoundaryFields(value: unknown, path: string) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoPrivateBoundaryFields(item, `${path}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (PRIVATE_BOUNDARY_FIELDS.has(key))
      throw new Error(`c1_authoring_private_field_forbidden:${path}.${key}`);
    // JSON Schema property names belong to the public business contract. A
    // capability may legitimately expose a field named `cases` or
    // `validationSuite`; inspect the property's schema, but never interpret
    // the business field name itself as leaked C1/C2 process state.
    if (
      key === "properties" &&
      (path.startsWith("contract.inputSchema") ||
        path.startsWith("contract.outputSchema")) &&
      item &&
      typeof item === "object" &&
      !Array.isArray(item)
    ) {
      for (const [propertyName, propertySchema] of Object.entries(
        item as Record<string, unknown>,
      )) {
        assertNoPrivateBoundaryFields(
          propertySchema,
          `${path}.properties.${propertyName}`,
        );
      }
      continue;
    }
    assertNoPrivateBoundaryFields(item, `${path}.${key}`);
  }
}

function strictContract(value: unknown): CapabilityContract {
  const contract = jsonObject(value, "case_generation_contract_required");
  const allowed = new Set([
    "intent",
    "inputSchema",
    "outputSchema",
    "preconditions",
    "successConditions",
    "scope",
    "inputAliases",
  ]);
  if (Object.keys(contract).some((key) => !allowed.has(key)))
    throw new Error("c1_authoring_contract_fields_invalid");
  assertNoPrivateBoundaryFields(contract, "contract");
  if (
    !Array.isArray(contract.preconditions) ||
    !Array.isArray(contract.successConditions)
  )
    throw new Error("c1_authoring_contract_conditions_invalid");
  if (contract.scope !== undefined) {
    const scope = record(contract.scope);
    if (Object.keys(scope).some((key) => !["kind", "match", "onMismatch"].includes(key)))
      throw new Error("c1_authoring_scope_fields_invalid");
    if (!["site-global", "category-scoped", "page-scoped"].includes(String(scope.kind)))
      throw new Error("c1_authoring_scope_kind_invalid");
    if (!["no-match", "clarify", "page-agent"].includes(String(scope.onMismatch)))
      throw new Error("c1_authoring_scope_mismatch_invalid");
    if (scope.match !== undefined) {
      const match = record(scope.match);
      if (Object.keys(match).some((key) => !["requiredInputPaths", "tokens", "urlPatterns"].includes(key)))
        throw new Error("c1_authoring_scope_match_fields_invalid");
      for (const key of ["requiredInputPaths", "tokens", "urlPatterns"] as const) {
        if (match[key] !== undefined) stringArray(match[key], "c1_authoring_scope_match_invalid");
      }
    }
  }
  return cloneJson(contract) as CapabilityContract;
}

function strictProgram(value: unknown): CapabilityProgram {
  const program = jsonObject(value, "case_generation_program_required");
  const allowed = new Set([
    "schemaVersion",
    "runtime",
    "module",
    "entry",
    "stages",
    "controlFlow",
    "parameterRoles",
    "targetBindings",
    "promptProvenance",
    "inputAliases",
  ]);
  if (Object.keys(program).some((key) => !allowed.has(key)))
    throw new Error("c1_authoring_program_fields_invalid");
  assertNoPrivateBoundaryFields(program, "program");
  return cloneJson(program) as CapabilityProgram;
}

function strictReplacementPlan(
  value: unknown,
): CapabilityCandidate["replacementPlan"] {
  const plan = record(value);
  if (
    Object.keys(plan).some(
      (key) =>
        !["replacesCapabilityIds", "reason", "disableAfterPublish"].includes(
          key,
        ),
    )
  )
    throw new Error("c1_authoring_replacement_plan_fields_invalid");
  if (
    !Array.isArray(plan.replacesCapabilityIds) ||
    plan.replacesCapabilityIds.some(
      (item) => typeof item !== "string" || !item.trim(),
    )
  )
    throw new Error("c1_authoring_replacement_ids_invalid");
  if (
    typeof plan.reason !== "string" ||
    !plan.reason.trim() ||
    typeof plan.disableAfterPublish !== "boolean"
  )
    throw new Error("c1_authoring_replacement_plan_invalid");
  return {
    replacesCapabilityIds: plan.replacesCapabilityIds.map((item) =>
      String(item).trim(),
    ),
    reason: plan.reason.trim(),
    disableAfterPublish: plan.disableAfterPublish,
  };
}

/** Decode the exact public C1 boundary. Legacy caseContextRef is forbidden. */
export function decodeC1AuthoringOutput(value: unknown): C1AuthoringOutput {
  const envelope = record(value);
  const allowedFields = new Set([
    "generationTaskId",
    "name",
    "description",
    "aliases",
    "contract",
    "program",
    "replacementPlan",
  ]);
  if (Object.keys(envelope).some((key) => !allowedFields.has(key)))
    throw new Error("c1_authoring_output_fields_invalid");
  const contract = strictContract(envelope.contract);
  const program = strictProgram(envelope.program);
  return {
    generationTaskId: requiredString(
      envelope.generationTaskId,
      "case_generation_task_id_required",
    ),
    name: requiredString(envelope.name, "case_generation_name_required"),
    description: requiredString(
      envelope.description,
      "case_generation_description_required",
    ),
    aliases: stringArray(envelope.aliases, "case_generation_aliases_invalid"),
    contract,
    program,
    ...(envelope.replacementPlan
      ? { replacementPlan: strictReplacementPlan(envelope.replacementPlan) }
      : {}),
  };
}

function decodeCandidate(value: unknown): CapabilityCandidate {
  const candidate = record(value);
  const allowedFields = new Set([
    "name",
    "description",
    "aliases",
    "contract",
    "program",
    "replacementPlan",
  ]);
  if (Object.keys(candidate).some((key) => !allowedFields.has(key)))
    throw new Error("case_generation_candidate_fields_invalid");
  return candidateFromAuthoring({
    generationTaskId: "candidate",
    name: requiredString(candidate.name, "case_generation_name_required"),
    description: requiredString(
      candidate.description,
      "case_generation_description_required",
    ),
    aliases: stringArray(candidate.aliases, "case_generation_aliases_invalid"),
    contract: strictContract(candidate.contract),
    program: strictProgram(candidate.program),
    ...(candidate.replacementPlan
      ? { replacementPlan: strictReplacementPlan(candidate.replacementPlan) }
      : {}),
  });
}

function httpUrl(value: unknown, code: string) {
  const text = requiredString(value, code);
  try {
    const url = new URL(text);
    if (!/^https?:$/u.test(url.protocol)) throw new Error();
    return url.toString();
  } catch {
    throw new Error(code);
  }
}

/** Decode the new independent C2 boundary; old flat C1/case-context shapes fail. */
export function decodeC2CaseGenerationInput(
  value: unknown,
): C2CaseGenerationInput {
  const envelope = record(value);
  if (
    Object.keys(envelope).some(
      (key) =>
        ![
          "generationTaskId",
          "siteId",
          "candidate",
          "browser",
          "demonstrationParameters",
        ].includes(key),
    )
  ) {
    throw new Error("case_generation_input_fields_invalid");
  }
  const browser = record(envelope.browser);
  if (
    Object.keys(browser).some(
      (key) =>
        ![
          "baseUrl",
          "startUrl",
          "recording",
          "session",
          "readOnlyPathPrefixes",
        ].includes(key),
    )
  ) {
    throw new Error("case_generation_browser_fields_invalid");
  }
  const session = record(browser.session);
  if (Object.keys(session).some((key) => key !== "mode"))
    throw new Error("case_generation_browser_session_fields_invalid");
  if (typeof browser.recording !== "boolean")
    throw new Error("case_generation_browser_recording_invalid");
  if (!["Anonymous", "AuthenticatedSnapshot"].includes(String(session.mode)))
    throw new Error("case_generation_browser_session_mode_invalid");
  const baseUrl = httpUrl(
    browser.baseUrl,
    "case_generation_browser_base_url_invalid",
  );
  const startUrl = httpUrl(
    browser.startUrl,
    "case_generation_browser_start_url_invalid",
  );
  if (new URL(baseUrl).origin !== new URL(startUrl).origin)
    throw new Error("case_generation_browser_origin_mismatch");
  const readOnlyPathPrefixes =
    browser.readOnlyPathPrefixes === undefined
      ? undefined
      : stringArray(
          browser.readOnlyPathPrefixes,
          "case_generation_read_only_paths_invalid",
        ).map((path) => {
          if (
            !path.startsWith("/") ||
            path.includes("?") ||
            path.includes("#") ||
            path.includes("\\")
          )
            throw new Error("case_generation_read_only_paths_invalid");
          return path;
        });
  const candidate = decodeCandidate(envelope.candidate);
  const demonstrationParameters = decodeDemonstrationParameters(
    envelope.demonstrationParameters,
    candidate.contract,
  );
  return {
    generationTaskId: requiredString(
      envelope.generationTaskId,
      "case_generation_task_id_required",
    ),
    siteId: requiredString(envelope.siteId, "case_generation_site_id_required"),
    candidate,
    ...(demonstrationParameters ? { demonstrationParameters } : {}),
    browser: {
      baseUrl,
      startUrl,
      recording: browser.recording,
      session: { mode: session.mode as "Anonymous" | "AuthenticatedSnapshot" },
      ...(readOnlyPathPrefixes?.length ? { readOnlyPathPrefixes } : {}),
    },
  };
}

/**
 * The demonstration is a witness, so it is held to the Contract like any
 * input: only declared paths, and nothing that names a secret. A value that
 * does not fit the input schema is simply not a witness for that path.
 */
function decodeDemonstrationParameters(
  value: unknown,
  contract: CapabilityContract,
): Record<string, JsonValue> | undefined {
  if (value === undefined) return undefined;
  const parameters = jsonObject(value, "case_generation_demonstration_invalid");
  const properties = record(record(contract.inputSchema).properties);
  const witness: Record<string, JsonValue> = {};
  for (const [path, item] of Object.entries(parameters)) {
    if (!Object.hasOwn(properties, path))
      throw new Error(`case_generation_demonstration_undeclared:${path}`);
    if (SENSITIVE_KEY.test(path))
      throw new Error(`case_generation_demonstration_sensitive:${path}`);
    if (item === null || typeof item === "object") continue;
    witness[path] = cloneJson(item);
  }
  return witness;
}

function assertSafeCaseContextRef(ref: CapabilityCaseContextRef) {
  const item = record(ref);
  const value = requiredString(
    item.artifactRef,
    "case_context_artifact_ref_invalid",
  );
  if (
    /^file:/iu.test(value) ||
    /^[a-z]:[\\/]/iu.test(value) ||
    /^\\\\/u.test(value) ||
    /^\/(?:home|users|tmp|var|etc|opt|workspace)(?:\/|$)/iu.test(value)
  ) {
    throw new Error("case_context_absolute_path_forbidden");
  }
  if (
    typeof item.contentHash !== "string" ||
    !/^(?:sha256:)?[a-f0-9]{64}$/iu.test(item.contentHash)
  ) {
    throw new Error("case_context_content_hash_invalid");
  }
  if (item.byteLength !== undefined) {
    if (
      typeof item.byteLength !== "number" ||
      !Number.isInteger(item.byteLength) ||
      item.byteLength < 0
    )
      throw new Error("case_context_byte_length_invalid");
    if (item.byteLength > CAPABILITY_CASE_CONTEXT_MAX_BYTES)
      throw new Error("case_context_too_large");
  }
}

const SENSITIVE_KEY =
  /(?:password|passwd|passcode|secret|token|authorization|cookie|credential|api.?key|private.?key|otp|session.?id)/iu;
const RAW_DOM_KEY =
  /^(?:raw(?:dom|html)|dom(?:snapshot|tree|html)?|html|outerhtml|innerhtml|pagehtml|bodyhtml)$/iu;
const FILE_PATH_KEY =
  /(?:^|[_-])(?:absolute)?(?:file|directory|dir|source|bundle)?path$/iu;
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const PROVIDER_TOKEN =
  /\b(?:gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/gu;

function assertSafeCaseContextValue(value: unknown, path = "caseContext") {
  if (typeof value === "string") {
    if (
      /\bBearer\s+[A-Za-z0-9._~+/=-]+/iu.test(value) ||
      /\b(?:password|passwd|secret|token|api[-_ ]?key|authorization|cookie|credential|otp)\s*[:=]\s*\S+/iu.test(
        value,
      )
    ) {
      throw new Error(`case_context_credentials_forbidden:${path}`);
    }
    if (
      /^file:/iu.test(value) ||
      /^[a-z]:[\\/]/iu.test(value) ||
      /^\\\\/u.test(value) ||
      /^\/(?:home|users|tmp|var|etc|opt|workspace)(?:\/|$)/iu.test(value)
    ) {
      throw new Error(`case_context_absolute_path_forbidden:${path}`);
    }
    if (/\bsk-[A-Za-z0-9_-]{12,}\b/u.test(value))
      throw new Error(`case_context_credentials_forbidden:${path}`);
    if (JWT_TOKEN.test(value) || PROVIDER_TOKEN.test(value)) {
      JWT_TOKEN.lastIndex = 0;
      PROVIDER_TOKEN.lastIndex = 0;
      throw new Error(`case_context_credentials_forbidden:${path}`);
    }
    JWT_TOKEN.lastIndex = 0;
    PROVIDER_TOKEN.lastIndex = 0;
    if (
      /<!doctype\s+html|<html(?:\s|>)|<(?:body|script|form|button|input|select|textarea)(?:\s[^>]*)?>/iu.test(
        value,
      )
    ) {
      throw new Error(`case_context_raw_dom_forbidden:${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertSafeCaseContextValue(item, `${path}.${index}`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key))
      throw new Error(`case_context_credentials_forbidden:${path}.${key}`);
    if (RAW_DOM_KEY.test(key))
      throw new Error(`case_context_raw_dom_forbidden:${path}.${key}`);
    if (
      FILE_PATH_KEY.test(key) &&
      typeof child === "string" &&
      /^(?:file:|[a-z]:[\\/]|\\\\|\/)/iu.test(child)
    ) {
      throw new Error(`case_context_absolute_path_forbidden:${path}.${key}`);
    }
    assertSafeCaseContextValue(child, `${path}.${key}`);
  }
}

function sanitizeCaseContextString(value: string) {
  try {
    const url = new URL(value);
    if (/^https?:$/u.test(url.protocol)) {
      url.username = "";
      url.password = "";
      for (const key of [...url.searchParams.keys()])
        if (SENSITIVE_KEY.test(key)) url.searchParams.delete(key);
      url.hash = "";
      return url.toString();
    }
  } catch {
    // Not a URL; sanitize it as ordinary evidence text below.
  }
  if (
    /^file:/iu.test(value) ||
    /^[a-z]:[\\/]/iu.test(value) ||
    /^\\\\/u.test(value) ||
    /^\/(?:home|users|tmp|var|etc|opt|workspace)(?:\/|$)/iu.test(value)
  )
    return "[REDACTED_PATH]";
  if (
    /<!doctype\s+html|<html(?:\s|>)|<(?:body|script|form|button|input|select|textarea)(?:\s[^>]*)?>/iu.test(
      value,
    )
  )
    return "[REDACTED_DOM]";
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "[REDACTED]")
    .replace(
      /\b(password|passwd|secret|token|api[-_ ]?key|authorization|cookie|credential|otp)\s*[:=]\s*\S+/giu,
      "[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED]")
    .replace(JWT_TOKEN, "[REDACTED_TOKEN]")
    .replace(PROVIDER_TOKEN, "[REDACTED_TOKEN]");
}

function sanitizeCaseContextJson(value: JsonValue): JsonValue | undefined {
  if (typeof value === "string") return sanitizeCaseContextString(value);
  if (Array.isArray(value))
    return value
      .map((item) => sanitizeCaseContextJson(item))
      .filter((item): item is JsonValue => item !== undefined);
  if (!value || typeof value !== "object") return value;
  const sanitized: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) || RAW_DOM_KEY.test(key)) continue;
    const next = sanitizeCaseContextJson(child);
    if (next !== undefined) sanitized[key] = next;
  }
  return sanitized;
}

/** Remove secrets, raw implementation data and local paths before C1 persists the sidecar. */
export function sanitizeCapabilityCaseContext(
  context: CapabilityCaseContext,
): CapabilityCaseContext {
  const sanitized = sanitizeCaseContextJson(context as unknown as JsonValue);
  const decoded = decodeCaseContext(sanitized);
  assertSafeCaseContextValue(decoded);
  return decoded;
}

function decodeCaseContext(value: unknown): CapabilityCaseContext {
  const context = record(value);
  const allowedTopLevel = new Set([
    "schemaVersion",
    "generationTaskId",
    "demonstrationInput",
    "examples",
  ]);
  if (Object.keys(context).some((key) => !allowedTopLevel.has(key)))
    throw new Error("case_context_fields_invalid");
  if (context.schemaVersion !== "1.0")
    throw new Error("case_context_schema_version_invalid");
  const generationTaskId = requiredString(
    context.generationTaskId,
    "case_context_generation_task_id_required",
  );
  const demonstrationInput = cloneJson(
    jsonObject(
      context.demonstrationInput,
      "case_context_demonstration_input_invalid",
    ),
  );
  if (!Array.isArray(context.examples) || !context.examples.length)
    throw new Error("case_context_examples_required");
  const examples = context.examples.map((rawExample, exampleIndex) => {
    const example = record(rawExample);
    if (
      Object.keys(example).some(
        (key) => !["input", "source", "evidence"].includes(key),
      )
    )
      throw new Error(`case_context_example_fields_invalid:${exampleIndex}`);
    if (
      !["demonstration", "page-evidence", "default-omission"].includes(
        String(example.source),
      )
    )
      throw new Error(`case_context_example_source_invalid:${exampleIndex}`);
    const input = cloneJson(
      jsonObject(
        example.input,
        `case_context_example_input_invalid:${exampleIndex}`,
      ),
    );
    if (!Array.isArray(example.evidence))
      throw new Error(`case_context_example_evidence_invalid:${exampleIndex}`);
    const evidence = example.evidence.map((rawEvidence, evidenceIndex) => {
      const item = record(rawEvidence);
      if (
        Object.keys(item).some(
          (key) => !["url", "regionText", "regionId"].includes(key),
        )
      )
        throw new Error(
          `case_context_evidence_fields_invalid:${exampleIndex}.${evidenceIndex}`,
        );
      const url = requiredString(
        item.url,
        `case_context_evidence_url_invalid:${exampleIndex}.${evidenceIndex}`,
      );
      try {
        const parsed = new URL(url);
        if (!/^https?:$/u.test(parsed.protocol)) throw new Error();
      } catch {
        throw new Error(
          `case_context_evidence_url_invalid:${exampleIndex}.${evidenceIndex}`,
        );
      }
      const regionText = requiredString(
        item.regionText,
        `case_context_evidence_region_text_invalid:${exampleIndex}.${evidenceIndex}`,
      );
      const regionId =
        item.regionId === undefined
          ? undefined
          : requiredString(
              item.regionId,
              `case_context_evidence_region_id_invalid:${exampleIndex}.${evidenceIndex}`,
            );
      return { url, regionText, ...(regionId ? { regionId } : {}) };
    });
    return {
      input,
      source:
        example.source as CapabilityCaseContext["examples"][number]["source"],
      evidence,
    };
  });
  return {
    schemaVersion: "1.0",
    generationTaskId,
    demonstrationInput,
    examples,
  };
}

function caseContextEvidenceRegions(context: CapabilityCaseContext) {
  return context.examples.flatMap((example, exampleIndex) =>
    example.evidence.map((evidence, evidenceIndex) => ({
      regionId:
        evidence.regionId ||
        `${example.source}:${exampleIndex + 1}:${evidenceIndex + 1}`,
      values: cloneJson(example.input),
    })),
  );
}

function unwrapSidecar(value: unknown): {
  value: unknown;
  declaredBytes?: number;
} {
  const wrapper = record(value);
  if (typeof wrapper.byteLength !== "number") return { value };
  for (const key of ["value", "data", "context", "content"] as const) {
    if (Object.hasOwn(wrapper, key))
      return { value: wrapper[key], declaredBytes: wrapper.byteLength };
  }
  return { value, declaredBytes: wrapper.byteLength };
}

/** Explicit historical reader; new C1/C2 production paths must not call it. */
export function parseLegacyCapabilityCaseContextSidecar(
  raw: unknown,
  ref: CapabilityCaseContextRef,
): ParsedCapabilityCaseContext {
  assertSafeCaseContextRef(ref);
  const unwrapped = unwrapSidecar(raw);
  let value = unwrapped.value;
  let byteLength: number;
  if (typeof value === "string") {
    byteLength = new TextEncoder().encode(value).byteLength;
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new Error("case_context_json_invalid");
    }
  } else if (value instanceof Uint8Array) {
    byteLength = value.byteLength;
    try {
      value = JSON.parse(new TextDecoder().decode(value)) as unknown;
    } catch {
      throw new Error("case_context_json_invalid");
    }
  } else if (value instanceof ArrayBuffer) {
    byteLength = value.byteLength;
    try {
      value = JSON.parse(new TextDecoder().decode(value)) as unknown;
    } catch {
      throw new Error("case_context_json_invalid");
    }
  } else {
    let encoded: string;
    try {
      encoded = JSON.stringify(value);
    } catch {
      throw new Error("case_context_json_invalid");
    }
    if (!encoded) throw new Error("case_context_json_invalid");
    byteLength = new TextEncoder().encode(encoded).byteLength;
  }
  if (
    (unwrapped.declaredBytes ?? 0) > CAPABILITY_CASE_CONTEXT_MAX_BYTES ||
    byteLength > CAPABILITY_CASE_CONTEXT_MAX_BYTES
  ) {
    throw new Error("case_context_too_large");
  }
  if (ref.byteLength !== undefined && ref.byteLength !== byteLength)
    throw new Error("case_context_byte_length_mismatch");
  const rawContext = jsonObject(value, "case_context_object_required");
  const actualHash = sha256HexText(canonicalCapabilityCaseJson(rawContext));
  if (
    ref.contentHash.replace(/^sha256:/iu, "").toLocaleLowerCase() !== actualHash
  )
    throw new Error("case_context_content_hash_mismatch");
  assertSafeCaseContextValue(rawContext);
  const context = decodeCaseContext(rawContext);
  assertSafeCaseContextValue(context);
  return {
    value: context,
    byteLength,
    evidenceRegions: caseContextEvidenceRegions(context),
  };
}

/** @deprecated Historical read compatibility only. */
export const parseCapabilityCaseContextSidecar =
  parseLegacyCapabilityCaseContextSidecar;

function safeEvidenceUrl(value: unknown, code: string) {
  const sanitized = sanitizeCaseContextString(requiredString(value, code));
  return httpUrl(sanitized, code);
}

function decodeDiscoveryRegion(
  value: unknown,
  index: number,
): CapabilityCaseDiscoveryRegion {
  const region = record(value);
  if (
    Object.keys(region).some(
      (key) =>
        ![
          "regionId",
          "url",
          "kind",
          "text",
          "observedValues",
          "controlOptions",
        ].includes(key),
    )
  ) {
    throw new Error(`case_discovery_region_fields_invalid:${index}`);
  }
  if (
    !["page-summary", "business-region", "control-group"].includes(
      String(region.kind),
    )
  ) {
    throw new Error(`case_discovery_region_kind_invalid:${index}`);
  }
  if (!Array.isArray(region.observedValues))
    throw new Error(`case_discovery_region_values_invalid:${index}`);
  if (
    region.controlOptions !== undefined &&
    !Array.isArray(region.controlOptions)
  )
    throw new Error(`case_discovery_region_options_invalid:${index}`);
  const text = requiredString(
    region.text,
    `case_discovery_region_text_invalid:${index}`,
  );
  if (text.length > 4_096)
    throw new Error(`case_discovery_region_text_too_large:${index}`);
  return {
    regionId: requiredString(
      region.regionId,
      `case_discovery_region_id_invalid:${index}`,
    ),
    url: safeEvidenceUrl(
      region.url,
      `case_discovery_region_url_invalid:${index}`,
    ),
    kind: region.kind as CapabilityCaseDiscoveryRegion["kind"],
    text: sanitizeCaseContextString(text),
    observedValues: cloneJson(region.observedValues as JsonValue[]),
    ...(region.controlOptions === undefined
      ? {}
      : { controlOptions: cloneJson(region.controlOptions as JsonValue[]) }),
  };
}

function decodeCapabilityCaseDiscoveryEvidence(
  value: unknown,
  requireCases: boolean,
): CapabilityCaseDiscoveryEvidence {
  const evidence = record(value);
  const allowed = new Set([
    "schemaVersion",
    "generationTaskId",
    "siteId",
    "candidateHash",
    "explorationMode",
    "regions",
    "associations",
    "actions",
    "cases",
  ]);
  if (Object.keys(evidence).some((key) => !allowed.has(key)))
    throw new Error("case_discovery_evidence_fields_invalid");
  if (evidence.schemaVersion !== "1.0")
    throw new Error("case_discovery_evidence_schema_version_invalid");
  if (
    !["read-only-interactive", "evidence-only"].includes(
      String(evidence.explorationMode),
    )
  )
    throw new Error("case_discovery_evidence_mode_invalid");
  if (!Array.isArray(evidence.regions) || !evidence.regions.length)
    throw new Error("case_discovery_evidence_regions_required");
  if (evidence.regions.length > 128)
    throw new Error("case_discovery_evidence_regions_too_many");
  const regions = evidence.regions.map(decodeDiscoveryRegion);
  if (new Set(regions.map((item) => item.regionId)).size !== regions.length)
    throw new Error("case_discovery_evidence_region_id_duplicate");
  const associations =
    evidence.associations === undefined
      ? undefined
      : Array.isArray(evidence.associations)
        ? evidence.associations.map((raw, index) => {
            const item = record(raw);
            if (
              Object.keys(item).some(
                (key) =>
                  ![
                    "associationId",
                    "regionIds",
                    "inputPaths",
                    "reason",
                  ].includes(key),
              )
            )
              throw new Error(
                `case_discovery_association_fields_invalid:${index}`,
              );
            const regionIds = stringArray(
              item.regionIds,
              `case_discovery_association_regions_invalid:${index}`,
            );
            const inputPaths = stringArray(
              item.inputPaths,
              `case_discovery_association_paths_invalid:${index}`,
            );
            if (
              regionIds.some(
                (id) => !regions.some((region) => region.regionId === id),
              )
            )
              throw new Error(
                `case_discovery_association_region_unknown:${index}`,
              );
            return {
              associationId: requiredString(
                item.associationId,
                `case_discovery_association_id_invalid:${index}`,
              ),
              regionIds,
              inputPaths,
              reason: requiredString(
                item.reason,
                `case_discovery_association_reason_invalid:${index}`,
              ),
            };
          })
        : (() => {
            throw new Error("case_discovery_associations_invalid");
          })();
  if (
    associations &&
    new Set(associations.map((item) => item.associationId)).size !==
      associations.length
  )
    throw new Error("case_discovery_association_id_duplicate");
  if (!Array.isArray(evidence.actions))
    throw new Error("case_discovery_evidence_actions_invalid");
  const actions = evidence.actions.map((raw, index) => {
    const item = record(raw);
    if (
      Object.keys(item).some(
        (key) =>
          !["action", "outcome", "url", "reason", "requestMethod"].includes(
            key,
          ),
      )
    )
      throw new Error(`case_discovery_action_fields_invalid:${index}`);
    if (
      !["navigate", "inspect", "search", "filter", "submit"].includes(
        String(item.action),
      )
    )
      throw new Error(`case_discovery_action_invalid:${index}`);
    if (!["performed", "blocked"].includes(String(item.outcome)))
      throw new Error(`case_discovery_action_outcome_invalid:${index}`);
    const requestMethod =
      item.requestMethod === undefined
        ? undefined
        : requiredString(
            item.requestMethod,
            `case_discovery_action_method_invalid:${index}`,
          ).toUpperCase();
    return {
      action:
        item.action as CapabilityCaseDiscoveryEvidence["actions"][number]["action"],
      outcome: item.outcome as "performed" | "blocked",
      url: safeEvidenceUrl(
        item.url,
        `case_discovery_action_url_invalid:${index}`,
      ),
      reason: sanitizeCaseContextString(
        requiredString(
          item.reason,
          `case_discovery_action_reason_invalid:${index}`,
        ),
      ),
      ...(requestMethod ? { requestMethod } : {}),
    };
  });
  const rawCases = evidence.cases;
  if (requireCases && !Array.isArray(rawCases))
    throw new Error("case_discovery_evidence_cases_required");
  if (
    !requireCases &&
    rawCases !== undefined &&
    (!Array.isArray(rawCases) || rawCases.length)
  )
    throw new Error("case_discovery_evidence_cases_forbidden");
  const cases = !Array.isArray(rawCases)
    ? []
    : rawCases.map((raw, caseIndex) => {
        const item = record(raw);
        if (
          Object.keys(item).some(
            (key) => !["caseId", "parameters", "associationId"].includes(key),
          )
        )
          throw new Error(`case_discovery_case_fields_invalid:${caseIndex}`);
        if (!Array.isArray(item.parameters))
          throw new Error(
            `case_discovery_case_parameters_invalid:${caseIndex}`,
          );
        const caseId = requiredString(
          item.caseId,
          `case_discovery_case_id_invalid:${caseIndex}`,
        );
        if (caseId !== `case_${caseIndex + 1}`)
          throw new Error(`case_discovery_case_id_unstable:${caseIndex}`);
        const associationId =
          item.associationId === undefined
            ? undefined
            : requiredString(
                item.associationId,
                `case_discovery_case_association_invalid:${caseIndex}`,
              );
        if (
          associationId &&
          !associations?.some(
            (association) => association.associationId === associationId,
          )
        )
          throw new Error(
            `case_discovery_case_association_unknown:${caseIndex}`,
          );
        return {
          caseId,
          parameters: item.parameters.map((rawParameter, parameterIndex) => {
            const parameter = record(rawParameter);
            if (
              Object.keys(parameter).some(
                (key) =>
                  !["inputPath", "regionId", "observedValue"].includes(key),
              )
            )
              throw new Error(
                `case_discovery_parameter_fields_invalid:${caseIndex}.${parameterIndex}`,
              );
            if (!Object.hasOwn(parameter, "observedValue"))
              throw new Error(
                `case_discovery_parameter_value_required:${caseIndex}.${parameterIndex}`,
              );
            // An empty region is how a value that the page never showed says
            // so: a search term a person would type, or the demonstration's
            // own input. It is recorded as what it is rather than attributed
            // to a region it did not come from.
            if (typeof parameter.regionId !== "string")
              throw new Error(
                `case_discovery_parameter_region_invalid:${caseIndex}.${parameterIndex}`,
              );
            const regionId = parameter.regionId;
            if (regionId && !regions.some((region) => region.regionId === regionId))
              throw new Error(
                `case_discovery_parameter_region_unknown:${caseIndex}.${parameterIndex}`,
              );
            return {
              inputPath: requiredString(
                parameter.inputPath,
                `case_discovery_parameter_path_invalid:${caseIndex}.${parameterIndex}`,
              ),
              regionId,
              observedValue: cloneJson(parameter.observedValue as JsonValue),
            };
          }),
          ...(associationId ? { associationId } : {}),
        };
      });
  cases.forEach((item, caseIndex) => {
    if (
      new Set(item.parameters.map((parameter) => parameter.inputPath)).size !==
      item.parameters.length
    )
      throw new Error(`case_discovery_parameter_path_duplicate:${caseIndex}`);
    for (const [parameterIndex, parameter] of item.parameters.entries()) {
      const region = regions.find(
        (candidate) => candidate.regionId === parameter.regionId,
      );
      // No region means the value was not taken off the page, and there is
      // nothing on the page to check it against.
      if (!region) continue;
      if (
        ![...region.observedValues, ...(region.controlOptions || [])].some(
          (value) => evidenceValueEqual(value, parameter.observedValue),
        )
      ) {
        throw new Error(
          `case_discovery_parameter_value_unobserved:${caseIndex}.${parameterIndex}`,
        );
      }
    }
    if (item.associationId) {
      const association = associations!.find(
        (candidate) => candidate.associationId === item.associationId,
      )!;
      if (
        item.parameters.some(
          (parameter) =>
            !association.regionIds.includes(parameter.regionId) ||
            !association.inputPaths.includes(parameter.inputPath),
        )
      ) {
        throw new Error(
          `case_discovery_case_association_mismatch:${caseIndex}`,
        );
      }
    }
    // Values from different regions are no longer refused. A combination the
    // page never showed together may simply have no data behind it, and the
    // run is what says so — refusing it here refused the capability instead.
  });
  const candidateHash = requiredString(
    evidence.candidateHash,
    "case_discovery_candidate_hash_required",
  );
  if (!/^sha256:[a-f0-9]{64}$/u.test(candidateHash))
    throw new Error("case_discovery_candidate_hash_invalid");
  return {
    schemaVersion: "1.0",
    generationTaskId: requiredString(
      evidence.generationTaskId,
      "case_discovery_generation_task_id_required",
    ),
    siteId: requiredString(evidence.siteId, "case_discovery_site_id_required"),
    candidateHash,
    explorationMode:
      evidence.explorationMode as CapabilityCaseDiscoveryEvidence["explorationMode"],
    regions,
    ...(associations ? { associations } : {}),
    actions,
    cases,
  };
}

/** Sanitize discovery data before it is exposed to the model or persisted. */
export function sanitizeCapabilityCaseDiscoveryEvidence(
  value: unknown,
): CapabilityCaseDiscoveryEvidence {
  const sanitized = sanitizeCaseContextJson(value as JsonValue);
  const decoded = decodeCapabilityCaseDiscoveryEvidence(
    sanitized,
    Array.isArray(record(sanitized).cases),
  );
  assertSafeCaseContextValue(decoded, "caseDiscoveryEvidence");
  return decoded;
}

export function capabilityCandidateHash(candidate: CapabilityCandidate) {
  return `sha256:${sha256HexText(canonicalCapabilityCaseJson(candidate))}`;
}

export type ParsedCapabilityCaseDiscoveryEvidence = {
  value: CapabilityCaseDiscoveryEvidence;
  canonicalJson: string;
  bytes: Uint8Array;
  byteLength: number;
  contentHash: string;
};

function encodeDiscoveryEvidence(
  value: CapabilityCaseDiscoveryEvidence,
): ParsedCapabilityCaseDiscoveryEvidence {
  const canonicalJson = canonicalCapabilityCaseJson(value);
  const bytes = new TextEncoder().encode(canonicalJson);
  if (bytes.byteLength > CAPABILITY_CASE_DISCOVERY_EVIDENCE_MAX_BYTES)
    throw new Error("case_discovery_evidence_too_large");
  return {
    value,
    canonicalJson,
    bytes,
    byteLength: bytes.byteLength,
    contentHash: `sha256:${sha256HexText(canonicalJson)}`,
  };
}

export function parseCapabilityCaseDiscoveryEvidenceSidecar(
  raw: unknown,
  ref: CapabilityCaseDiscoveryEvidenceRef,
): ParsedCapabilityCaseDiscoveryEvidence {
  assertCapabilityCaseDiscoveryEvidenceRef(ref);
  let value = raw;
  let rawBytes: Uint8Array | undefined;
  if (typeof raw === "string") {
    rawBytes = new TextEncoder().encode(raw);
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("case_discovery_evidence_json_invalid");
    }
  } else if (raw instanceof Uint8Array) {
    rawBytes = raw;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(raw),
      ) as unknown;
    } catch {
      throw new Error("case_discovery_evidence_json_invalid");
    }
  } else if (raw instanceof ArrayBuffer) {
    rawBytes = new Uint8Array(raw);
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(raw),
      ) as unknown;
    } catch {
      throw new Error("case_discovery_evidence_json_invalid");
    }
  }
  assertSafeCaseContextValue(value, "caseDiscoveryEvidence");
  const parsed = encodeDiscoveryEvidence(
    decodeCapabilityCaseDiscoveryEvidence(value, true),
  );
  if (rawBytes) {
    if (rawBytes.byteLength !== ref.byteLength)
      throw new Error("case_discovery_evidence_byte_length_mismatch");
    const rawHash = `sha256:${sha256HexBytes(rawBytes)}`;
    if (rawHash !== ref.contentHash.toLowerCase())
      throw new Error("case_discovery_evidence_content_hash_mismatch");
  }
  if (ref.byteLength !== parsed.byteLength)
    throw new Error("case_discovery_evidence_byte_length_mismatch");
  if (ref.contentHash.toLowerCase() !== parsed.contentHash)
    throw new Error("case_discovery_evidence_content_hash_mismatch");
  return parsed;
}

/** Decode the current `{ cases: [{ input, expected }] }` model shape. */
export function decodeCapabilityCaseModelOutput(
  value: unknown,
): CapabilityCaseGenerationModelOutput {
  const output = record(value);
  if (
    [
      "candidate",
      "contract",
      "program",
      "name",
      "description",
      "aliases",
      "generationTaskId",
    ].some((key) => Object.hasOwn(output, key))
  ) {
    throw new Error("case_generation_candidate_rewrite_forbidden");
  }
  if (Object.keys(output).some((key) => key !== "cases"))
    throw new Error("case_generation_model_fields_invalid");
  const cases = output.cases;
  if (!Array.isArray(cases) || !cases.length)
    throw new Error("case_generation_cases_required");
  if (cases.length > 12) throw new Error("case_generation_cases_too_many");
  return {
    cases: cases.map((rawCase, index) => {
      const item = record(rawCase);
      const unknownKeys = Object.keys(item).filter(
        (key) => key !== "input" && key !== "expected",
      );
      if (unknownKeys.length)
        throw new Error(`case_generation_model_case_fields_invalid:${index}`);
      if (!Object.hasOwn(item, "input") || !Object.hasOwn(item, "expected"))
        throw new Error(`case_generation_model_case_shape_invalid:${index}`);
      // A key that could not be a field name — `: 1, `, an empty string — is
      // a broken response, and is named as such rather than reported as the
      // real field being missing, which sent the repair the wrong way.
      for (const part of ["input", "expected"] as const) {
        const bad = Object.keys(record(item[part])).find((key) => !/^[\p{L}_$][\p{L}\p{N}_$.-]*$/u.test(key));
        if (bad !== undefined)
          throw new Error(`case_generation_model_keys_invalid:${index}:${part}:${JSON.stringify(bad)}`);
      }
      return {
        input: cloneJson(
          jsonObject(item.input, `case_generation_input_invalid:${index}`),
        ),
        expected: cloneJson(
          jsonObject(
            item.expected,
            `case_generation_expected_invalid:${index}`,
          ),
        ),
      };
    }),
  };
}

function runtimeSchema(value: JsonObject) {
  return value as unknown as RuntimeJsonSchema;
}

function assertNoAdditionalProperties(
  schemaValue: unknown,
  value: unknown,
  path: string,
) {
  const schema = record(schemaValue);
  if (
    schema.type === "object" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const properties = record(schema.properties);
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value as Record<string, unknown>).filter(
        (key) => !Object.hasOwn(properties, key),
      );
      if (unknown.length)
        throw new Error(
          `case_schema_additional_property_forbidden:${path}.${unknown[0]}`,
        );
    }
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (Object.hasOwn(properties, key))
        assertNoAdditionalProperties(properties[key], child, `${path}.${key}`);
    }
  }
  if (schema.type === "array" && Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoAdditionalProperties(schema.items, item, `${path}.${index}`),
    );
  }
}

function validateCaseInput(
  contract: CapabilityContract,
  input: JsonObject,
  index: number,
) {
  assertSafeCapabilitySchema(runtimeSchema(contract.inputSchema));
  assertCapabilityInput(runtimeSchema(contract.inputSchema), input);
  assertNoAdditionalProperties(
    contract.inputSchema,
    input,
    `cases.${index}.input`,
  );
}

function validateExpectedPartial(
  contract: CapabilityContract,
  expected: JsonObject,
  index: number,
) {
  const outputSchema = record(contract.outputSchema);
  if (outputSchema.type !== "object")
    throw new Error("case_generation_output_schema_object_required");
  const partialSchema = { ...outputSchema, required: [] } as JsonObject;
  assertSafeCapabilitySchema(runtimeSchema(partialSchema));
  assertCapabilityOutput(runtimeSchema(partialSchema), expected);
  assertNoAdditionalProperties(
    partialSchema,
    expected,
    `cases.${index}.expected`,
  );
}

function validateExpectedEvidence(
  contract: CapabilityContract,
  expected: JsonObject,
  input: JsonObject,
  evidence: CapabilityCaseDiscoveryEvidence,
  index: number,
) {
  const allowed = [
    ...suppliedInputPaths(input).map((item) => item.value),
    ...evidence.regions.flatMap((region) => [
      region.url,
      ...regionValues(region),
    ]),
  ];
  const deterministicTemplates = [
    ...contract.preconditions,
    ...contract.successConditions,
  ]
    .map((condition) => record(condition))
    .flatMap((condition) => {
      if (condition.type !== "textTemplate" && condition.type !== "urlTemplate") return [];
      const template = typeof condition.template === "string" ? condition.template : "";
      return template ? [{ type: condition.type, template }] : [];
    });
  for (const item of suppliedInputPaths(expected)) {
    const supportedByDeterministicCondition =
      typeof item.value === "string" && deterministicTemplates.some((condition) =>
        condition.type === "urlTemplate"
          ? capabilityUrlTemplateMatches(item.value as string, condition.template, input)
          : evidenceValueEqual(
              item.value,
              renderCapabilityInputTemplate(condition.template, input),
            ),
      );
    if (
      !supportedByDeterministicCondition &&
      !allowed.some((value) => evidenceValueEqual(value, item.value))
    ) {
      throw new Error(`case_expected_evidence_required:${index}:${item.path}`);
    }
  }
}

function rootPath(path: string) {
  return path.split(".").filter(Boolean)[0] || "";
}

function pathValue(value: JsonObject, path: string): JsonValue | undefined {
  if (Object.hasOwn(value, path)) return value[path];
  let current: unknown = value;
  for (const key of path.split(".").filter(Boolean)) {
    const item = record(current);
    if (!Object.hasOwn(item, key)) return undefined;
    current = item[key];
  }
  return current as JsonValue | undefined;
}

function evidenceValueEqual(left: unknown, right: unknown) {
  if (typeof left === "string" && typeof right === "string") {
    return (
      left
        .normalize("NFKC")
        .replace(/\s+/gu, " ")
        .trim()
        .toLocaleLowerCase() ===
      right.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase()
    );
  }
  return (
    canonicalCapabilityCaseJson(left) === canonicalCapabilityCaseJson(right)
  );
}

function suppliedInputPaths(
  value: JsonObject,
  prefix = "",
): Array<{ path: string; value: JsonValue }> {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === "object" && !Array.isArray(child)
      ? suppliedInputPaths(child as JsonObject, path)
      : [{ path, value: child }];
  });
}

function regionValues(region: CapabilityCaseDiscoveryRegion) {
  return [...region.observedValues, ...(region.controlOptions || [])];
}

function mapCaseEvidence(
  cases: CapabilityValidationCase[],
  evidence: CapabilityCaseDiscoveryEvidence,
  parameterRoles: CapabilityProgram["parameterRoles"],
) {
  const roles = new Map(
    parameterRoles.map((role) => [role.inputPath, role.role]),
  );
  return cases.map((item, index) => {
    const supplied = suppliedInputPaths(item.input);
    const sensitive = supplied.find(({ path }) => SENSITIVE_KEY.test(path));
    if (sensitive)
      throw new Error(
        `case_evidence_sensitive_input_forbidden:${index}:${sensitive.path}`,
      );
    if (!supplied.length) return { caseId: item.caseId, parameters: [] };
    const requiresBusinessRegion = supplied.some(
      ({ path }) => roles.get(path) === "target",
    );
    const candidateRegions = [...evidence.regions]
      .filter(
        (region) =>
          !requiresBusinessRegion || region.kind === "business-region",
      )
      .filter((region) => supplied.length < 2 || region.kind !== "page-summary")
      .sort((left, right) => {
        const kindRank = (region: CapabilityCaseDiscoveryRegion) =>
          region.kind === "business-region"
            ? 0
            : region.kind === "control-group"
              ? 1
              : 2;
        return (
          kindRank(left) - kindRank(right) ||
          left.text.length - right.text.length
        );
      });
    const oneRegion = candidateRegions.find((region) =>
      supplied.every(({ value }) =>
        regionValues(region).some((observed) =>
          evidenceValueEqual(observed, value),
        ),
      ),
    );
    if (oneRegion) {
      return {
        caseId: item.caseId,
        parameters: supplied.map(({ path, value }) => ({
          inputPath: path,
          regionId: oneRegion.regionId,
          observedValue: cloneJson(
            regionValues(oneRegion).find((observed) =>
              evidenceValueEqual(observed, value),
            ) as JsonValue,
          ),
        })),
      };
    }
    const selections = supplied.map(({ path, value }) => ({
      path,
      value,
      region: evidence.regions.find(
        (region) =>
          (roles.get(path) !== "target" || region.kind === "business-region") &&
          regionValues(region).some((observed) =>
            evidenceValueEqual(observed, value),
          ),
      ),
    }));
    // A value the page does not show is not a reason to refuse the case. The
    // demonstration's own input is such a value on most pages, and so is a
    // search term a person would type; what decides whether a value may be
    // used is the contract, and what decides whether the capability works is
    // running it. The evidence still records, per value, the region it came
    // from where there is one.
    const grounded = selections.filter((selection) => selection.region);
    const regionIds = [
      ...new Set(grounded.map((selection) => selection.region!.regionId)),
    ];
    const association = grounded.length === selections.length
      ? evidence.associations?.find(
          (item) =>
            regionIds.every((regionId) => item.regionIds.includes(regionId)) &&
            supplied.every(({ path }) => item.inputPaths.includes(path)),
        )
      : undefined;
    return {
      caseId: item.caseId,
      parameters: selections.map(({ path, value, region }) => ({
        inputPath: path,
        regionId: region?.regionId || "",
        observedValue: region
          ? cloneJson(
              regionValues(region).find((observed) =>
                evidenceValueEqual(observed, value),
              ) as JsonValue,
            )
          : cloneJson(value),
      })),
      ...(association ? { associationId: association.associationId } : {}),
    };
  });
}

function assertProgramInputConsumption(
  contract: CapabilityContract,
  program: CapabilityProgram,
) {
  const properties = record(record(contract.inputSchema).properties);
  const declared = Object.keys(properties);
  const roles = Array.isArray(program.parameterRoles)
    ? program.parameterRoles
    : [];
  const bindings = Array.isArray(program.targetBindings)
    ? program.targetBindings
    : [];
  const consumed = new Set(
    (program.stages || [])
      .flatMap((stage) => stage.io?.reads?.input || [])
      .map(rootPath),
  );
  for (const path of declared) {
    const matchingRoles = roles.filter(
      (role) => rootPath(role.inputPath) === path,
    );
    if (matchingRoles.length !== 1)
      throw new Error(`case_generation_parameter_role_required:${path}`);
    if (!consumed.has(path))
      throw new Error(`case_generation_program_input_not_consumed:${path}`);
  }
  for (const role of roles) {
    const path = rootPath(role.inputPath);
    if (!declared.includes(path))
      throw new Error(
        `case_generation_parameter_role_undeclared:${role.inputPath}`,
      );
    const matchingBindings = bindings.filter(
      (binding) =>
        binding.inputPath === role.inputPath ||
        rootPath(binding.inputPath) === path,
    );
    if (role.role === "target" && matchingBindings.length !== 1)
      throw new Error(
        `case_generation_target_binding_required:${role.inputPath}`,
      );
    if (role.role !== "target" && matchingBindings.length)
      throw new Error(
        `case_generation_target_binding_role_invalid:${role.inputPath}`,
      );
  }
  const stateWrites = new Set(
    (program.stages || []).flatMap((stage) => stage.io?.writes?.state || []),
  );
  for (const binding of bindings) {
    const path = rootPath(binding.inputPath);
    if (!declared.includes(path))
      throw new Error(
        `case_generation_target_binding_undeclared:${binding.inputPath}`,
      );
    if (!binding.targetKind.trim() || !binding.identityStatePath.trim())
      throw new Error(
        `case_generation_target_binding_invalid:${binding.inputPath}`,
      );
    if (
      ![...stateWrites].some(
        (statePath) =>
          statePath === binding.identityStatePath ||
          statePath.startsWith(`${binding.identityStatePath}.`) ||
          binding.identityStatePath.startsWith(`${statePath}.`),
      )
    ) {
      throw new Error(
        `case_generation_target_binding_unwritten:${binding.inputPath}`,
      );
    }
  }
}

const DETERMINISTIC_PRECONDITIONS = new Set([
  "urlIncludes",
  "urlTemplate",
  "textIncludes",
  "textTemplate",
  "inputExists",
]);
const DETERMINISTIC_SUCCESS_CONDITIONS = new Set([
  ...DETERMINISTIC_PRECONDITIONS,
  "outputExists",
  "outputEquals",
]);

function assertDeterministicConditions(contract: CapabilityContract) {
  if (!contract.successConditions.length)
    throw new Error("case_generation_deterministic_success_condition_required");
  for (const [group, conditions, supported] of [
    ["preconditions", contract.preconditions, DETERMINISTIC_PRECONDITIONS],
    [
      "successConditions",
      contract.successConditions,
      DETERMINISTIC_SUCCESS_CONDITIONS,
    ],
  ] as const) {
    conditions.forEach((condition, index) => {
      if (typeof condition === "string") {
        if (!condition.trim())
          throw new Error(
            `case_generation_condition_invalid:${group}.${index}`,
          );
        return;
      }
      const type = String(record(condition).type || "");
      if (!supported.has(type))
        throw new Error(
          `case_generation_condition_not_deterministic:${group}.${index}:${type || "unknown"}`,
        );
    });
  }
}

/**
 * Run the candidate-only C2 gates before opening a browser or calling the
 * case-generation model.  This keeps invalid C1 output fail-closed at the
 * C2 boundary and makes the ordering observable: deterministic contract and
 * Program checks happen before the expensive discovery/model phase.
 */
export function assertCapabilityCaseGenerationCandidate(
  candidate: CapabilityCandidate,
) {
  assertProgramInputConsumption(candidate.contract, candidate.program);
  assertDeterministicConditions(candidate.contract);
}

function assertDefaultOmission(
  contract: CapabilityContract,
  cases: CapabilityCaseModelCase[],
) {
  const properties = record(record(contract.inputSchema).properties);
  for (const [path, schema] of Object.entries(properties)) {
    if (
      Object.hasOwn(record(schema), "default") &&
      !cases.some((item) => !Object.hasOwn(item.input, path))
    ) {
      throw new Error(`default_omission_validation_required:${path}`);
    }
  }
}

/* -------------------------------------------------------------------- */
/* Deterministic case derivation                                          */
/*                                                                        */
/* The cases a Candidate is validated with are derived from the discovery */
/* evidence by code. Every input value is one the site was seen to hold,  */
/* the demonstration says what shape an input has, and the count is as    */
/* many distinct cases as the evidence affords, up to a small cap. A model */
/* never chooses an input that is not in this space; it may only re-select */
/* within it and fill `expected`, and both are checked again by code.     */
/* -------------------------------------------------------------------- */

export const CAPABILITY_CASE_DERIVATION_MAX_CASES = 3;
const CASE_ALTERNATIVES_MAX_VALUES = 12;

export type CapabilityDerivedCase = CapabilityCaseModelCase & {
  /** The region every input value of this case was observed in. */
  regionId: string;
  /**
   * The other admissible values of that region, per input path present in
   * the case: what an enrichment model may re-select from, and nothing else.
   */
  alternatives: Record<string, JsonValue[]>;
};

export type CapabilityCaseDerivation = {
  cases: CapabilityDerivedCase[];
  fields: Array<{
    path: string;
    required: boolean;
    witness?: JsonValue;
    /** Distinct admissible values across all regions. */
    admissible: number;
  }>;
};

/**
 * The shape of a value: digit runs, Latin runs, Han runs and other letter
 * runs collapsed to one character each. "2026-03-11" is "9-9-9", "WnY5dw" is
 * "a9a", and every title, name or query is free text. The demonstration's
 * shape says what an input looks like: a structured witness admits only its
 * own shape, a free-text witness admits any free text.
 */
function valueShape(value: JsonValue): string {
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value !== "string") return "other";
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\p{N}+/gu, "9")
    .replace(/[A-Za-z]+/gu, "a")
    .replace(/\p{Script=Han}+/gu, "H")
    .replace(/\p{L}+/gu, "l")
    .replace(/\s+/gu, " ");
}

function isFreeText(shape: string) {
  return /^[aHl]+(?: [aHl]+)*$/u.test(shape);
}

function witnessAdmits(witness: JsonValue | undefined, value: JsonValue) {
  if (witness === undefined) return true;
  const expected = valueShape(witness);
  const actual = valueShape(value);
  return expected === actual || (isFreeText(expected) && isFreeText(actual));
}


function fieldAccepts(path: string, schema: JsonObject, value: JsonValue) {
  try {
    assertCapabilityInput(
      runtimeSchema({
        type: "object",
        properties: { [path]: schema },
        required: [path],
        additionalProperties: false,
      } as JsonObject),
      { [path]: value },
    );
    return true;
  } catch {
    return false;
  }
}

/** The identity `evidenceValueEqual` compares by, as a set key. */
function evidenceKey(value: JsonValue) {
  return typeof value === "string"
    ? `s:${value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase()}`
    : `j:${canonicalCapabilityCaseJson(value)}`;
}

function regionRank(kind: CapabilityCaseDiscoveryRegion["kind"]) {
  return kind === "business-region" ? 0 : kind === "control-group" ? 1 : 2;
}

/**
 * The part of `expected` that follows from the case itself: an output field
 * that carries the same name and type as an input echoes that input. C3 then
 * has something to hold the program to on every case, without a model.
 */
function echoExpected(contract: CapabilityContract, input: JsonObject) {
  const expected: JsonObject = {};
  const outputProperties = record(record(contract.outputSchema).properties);
  for (const [path, value] of Object.entries(input)) {
    if (!Object.hasOwn(outputProperties, path)) continue;
    const declared = record(outputProperties[path]).type;
    const actual =
      typeof value === "number"
        ? declared === "integer" && Number.isInteger(value)
          ? "integer"
          : "number"
        : typeof value;
    if (declared !== actual) continue;
    try {
      validateExpectedPartial(contract, { ...expected, [path]: value }, 0);
      expected[path] = cloneJson(value);
    } catch {
      // An output constraint the input value does not meet: no echo.
    }
  }
  return expected;
}

export function deriveCapabilityCases(
  inputValue: C2CaseGenerationInput | unknown,
  discoveryValue: Omit<CapabilityCaseDiscoveryEvidence, "cases"> | unknown,
): CapabilityCaseDerivation {
  const input = decodeC2CaseGenerationInput(inputValue);
  const sanitized = sanitizeCaseContextJson(discoveryValue as JsonValue);
  assertSafeCaseContextValue(sanitized, "caseDiscoveryEvidence");
  const discovery = decodeCapabilityCaseDiscoveryEvidence(sanitized, false);
  const contract = input.candidate.contract;
  assertSafeCapabilitySchema(runtimeSchema(contract.inputSchema));
  const properties = record(record(contract.inputSchema).properties);
  const declared = Object.keys(properties);
  const required = new Set(
    Array.isArray(contract.inputSchema.required)
      ? contract.inputSchema.required.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  );
  const roles = new Map(
    input.candidate.program.parameterRoles.map((role) => [
      rootPath(role.inputPath),
      role.role,
    ]),
  );
  const witness = input.demonstrationParameters || {};
  if (!declared.length) {
    return {
      cases: [
        {
          input: {},
          expected: {},
          regionId: discovery.regions[0]?.regionId || "",
          alternatives: {},
        },
      ],
      fields: [],
    };
  }

  // Admissible values per region and path: observed there, admitted by the
  // witness's shape, valid under the input schema. A target has to come from
  // a business region, as the evidence mapping will demand again later.
  const admissible = new Map<string, Set<string>>(
    declared.map((path) => [path, new Set<string>()]),
  );
  const pools = new Map<string, Map<string, JsonValue[]>>();
  for (const region of discovery.regions) {
    const perField = new Map<string, JsonValue[]>();
    for (const path of declared) {
      if (SENSITIVE_KEY.test(path)) continue;
      if (roles.get(path) === "target" && region.kind !== "business-region")
        continue;
      const schema = record(properties[path]) as JsonObject;
      // The writing this input takes, as the contract states it. A page is
      // full of text that is not a value of this kind: on 热搜时光机 the words
      // 「热搜」 and 「日期」 passed a `{type:"string"}` date and the cases
      // built from them all asked for the same day. Narrowing the pool is not
      // a rule about dates and refuses no capability — an input whose page
      // offers nothing else keeps the demonstration as its one case.
      const writing = declaredValueShape(schema, witness[path]);
      const seen = new Set<string>();
      const values: JsonValue[] = [];
      for (const value of regionValues(region)) {
        if (value === null || typeof value === "object") continue;
        if (!fieldAccepts(path, schema, value)) continue;
        if (writing && (typeof value !== "string" || writtenValueShape(value) !== writing)) continue;
        const key = evidenceKey(value);
        if (seen.has(key)) continue;
        seen.add(key);
        values.push(cloneJson(value));
      }
      if (!values.length) continue;
      // Kept in the order the page presented them: the harvest lists whole
      // values (headings, cells, badges) before fragments, so the first value
      // is the region's most prominent one.
      perField.set(path, values);
      for (const value of values) admissible.get(path)!.add(evidenceKey(value));
    }
    pools.set(region.regionId, perField);
  }

  // One case per region per round, business regions first. In round n one
  // input — the first, in declared order, whose pool has an n-th value —
  // advances to it while the others take their first value not already used
  // in the case, so a single list region still yields several cases and two
  // inputs never share one value. A page summary grounds single-value cases
  // only, as in the evidence mapping. The demonstration is not set apart: it
  // is at most one of the cases, and the two-distinct-cases floor guarantees
  // another beside it.
  const orderedRegions = discovery.regions
    .map((region, order) => ({ region, order }))
    .sort(
      (left, right) =>
        regionRank(left.region.kind) - regionRank(right.region.kind) ||
        left.order - right.order,
    )
    .map(({ region }) => region);
  // Every value this page offered for a field, in the order the regions were
  // ranked. A case is still anchored to one region, but what the enrichment
  // turn may choose from is not: the code's job is to guarantee that an option
  // was seen on the site, and choosing between options that all were is a
  // judgement. Held to one region, the turn had only the region's own words to
  // pick from — a page's FAQ questions, when the input wanted a search term —
  // and no better answer was available to it.
  const acrossRegions = new Map<string, JsonValue[]>(declared.map((path) => [path, []]));
  for (const region of orderedRegions) {
    for (const path of declared) {
      const held = acrossRegions.get(path)!;
      const keys = new Set(held.map((value) => evidenceKey(value)));
      for (const value of pools.get(region.regionId)?.get(path) || []) {
        if (keys.has(evidenceKey(value))) continue;
        keys.add(evidenceKey(value));
        held.push(value);
      }
    }
  }

  // The demonstration: the one input this capability is known to work for.
  const demonstrationCase: JsonObject = {};
  for (const path of declared) {
    const value = witness[path];
    if (value === undefined || value === null || typeof value === "object") continue;
    try {
      if (fieldAccepts(path, record(properties[path]) as JsonObject, value)) demonstrationCase[path] = cloneJson(value);
    } catch { /* a value the schema refuses is not a case */ }
  }

  const candidates: CapabilityDerivedCase[] = [];
  for (let round = 0; round < CAPABILITY_CASE_DERIVATION_MAX_CASES; round += 1) {
    for (const region of orderedRegions) {
      const perField = pools.get(region.regionId)!;
      const summary = region.kind === "page-summary";
      const caseInput: JsonObject = {};
      const used = new Set<string>();
      const advancing =
        round === 0
          ? undefined
          : declared.find((path) => (perField.get(path) || []).length > round);
      if (round > 0 && !advancing) continue;
      let complete = true;
      for (const path of declared) {
        const value =
          path === advancing
            ? (perField.get(path) || [])[round]
            : (perField.get(path) || []).find(
                (candidate) => !used.has(evidenceKey(candidate)),
              );
        if (value !== undefined) used.add(evidenceKey(value));
        if (required.has(path)) {
          if (value === undefined) {
            complete = false;
            break;
          }
          caseInput[path] = value;
        } else if (!summary && value !== undefined) {
          caseInput[path] = value;
        }
      }
      if (!complete) continue;
      if (summary && Object.keys(caseInput).length > 1) continue;
      candidates.push({
        input: caseInput,
        expected: {},
        regionId: region.regionId,
        alternatives: Object.fromEntries(
          Object.keys(caseInput).map((path) => {
            const own = perField.get(path) || [];
            const keys = new Set(own.map((value) => evidenceKey(value)));
            const rest = (acrossRegions.get(path) || []).filter((value) => !keys.has(evidenceKey(value)));
            return [path, [...own, ...rest].slice(0, CASE_ALTERNATIVES_MAX_VALUES)];
          }),
        ),
      });
    }
  }

  const taken: CapabilityDerivedCase[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    const key = canonicalCapabilityCaseJson(item.input);
    if (seen.has(key)) continue;
    seen.add(key);
    taken.push(item);
    if (taken.length >= CAPABILITY_CASE_DERIVATION_MAX_CASES) break;
  }
  // A page that happens to show few values of a kind is not a reason to refuse
  // a capability. The demonstration is a case in its own right: it is the one
  // input this capability is known to work for. What the page offered are
  // suggestions beside it, and the enrichment turn may replace any of them
  // with anything the contract accepts.
  if (!taken.some((item) => canonicalCapabilityCaseJson(item.input) === canonicalCapabilityCaseJson(demonstrationCase))
    && Object.keys(demonstrationCase).length) {
    taken.unshift({
      input: cloneJson(demonstrationCase) as JsonObject,
      expected: {},
      regionId: discovery.regions[0]?.regionId || "",
      alternatives: Object.fromEntries(
        Object.keys(demonstrationCase).map((path) => [path, (acrossRegions.get(path) || []).slice(0, CASE_ALTERNATIVES_MAX_VALUES)]),
      ),
    });
    if (taken.length > CAPABILITY_CASE_DERIVATION_MAX_CASES) taken.length = CAPABILITY_CASE_DERIVATION_MAX_CASES;
  }
  if (!taken.length) throw new Error("case_generation_no_input_possible");
  // A defaulted input is validated by one case that leaves it out.
  const defaulted = declared.filter((path) =>
    Object.hasOwn(record(properties[path]), "default"),
  );
  if (taken.length && defaulted.length) {
    const last = taken[taken.length - 1];
    for (const path of defaulted) {
      if (taken.every((item) => Object.hasOwn(item.input, path))) {
        delete last.input[path];
        delete last.alternatives[path];
      }
    }
    const key = canonicalCapabilityCaseJson(last.input);
    if (
      taken
        .slice(0, -1)
        .some((item) => canonicalCapabilityCaseJson(item.input) === key)
    )
      taken.pop();
  }

  const fields = declared.map((path) => ({
    path,
    required: required.has(path),
    ...(witness[path] === undefined ? {} : { witness: cloneJson(witness[path]) }),
    admissible: admissible.get(path)!.size,
  }));

  for (const item of taken) item.expected = echoExpected(contract, item.input);
  return { cases: taken, fields };
}

/* -------------------------------------------------------------------- */
/* Optional model enrichment of derived cases                             */
/* -------------------------------------------------------------------- */

export type CapabilityCaseEnrichment = {
  cases: Array<{ input?: JsonObject; expected: JsonObject }>;
};

/** One entry per derived case, in order; anything else is not an enrichment. */
export function decodeCapabilityCaseEnrichment(
  value: unknown,
  count: number,
): CapabilityCaseEnrichment {
  const output = record(value);
  if (
    [
      "candidate",
      "contract",
      "program",
      "name",
      "description",
      "aliases",
      "generationTaskId",
    ].some((key) => Object.hasOwn(output, key))
  ) {
    throw new Error("case_generation_candidate_rewrite_forbidden");
  }
  if (Object.keys(output).some((key) => key !== "cases"))
    throw new Error("case_enrichment_fields_invalid");
  const cases = output.cases;
  if (!Array.isArray(cases) || cases.length !== count) {
    throw new Error(
      `case_enrichment_count_mismatch:${Array.isArray(cases) ? cases.length : "none"}:${count}`,
    );
  }
  return {
    cases: cases.map((raw, index) => {
      const item = record(raw);
      if (Object.keys(item).some((key) => key !== "input" && key !== "expected"))
        throw new Error(`case_enrichment_case_fields_invalid:${index}`);
      return {
        ...(item.input === undefined
          ? {}
          : {
              input: cloneJson(
                jsonObject(item.input, `case_enrichment_input_invalid:${index}`),
              ),
            }),
        expected: cloneJson(
          jsonObject(
            item.expected ?? {},
            `case_enrichment_expected_invalid:${index}`,
          ),
        ),
      };
    }),
  };
}

export type CapabilityCaseEnrichmentReport = {
  reselected: number[];
  inputIgnored: Array<{ index: number; reason: string }>;
  expectedIgnored: Array<{ index: number; reason: string }>;
};

/**
 * Apply a model's enrichment to derived cases, keeping only what the
 * evidence supports. An input may be re-selected among the case's own
 * alternatives, path by path, never added, dropped or invented; `expected`
 * is kept where every value is evidenced. Anything else is ignored per case
 * and reported. This never throws for what the model said.
 */
export function mergeCapabilityCaseEnrichment(
  inputValue: C2CaseGenerationInput | unknown,
  derivation: CapabilityCaseDerivation,
  enrichmentValue: unknown,
  discoveryValue: Omit<CapabilityCaseDiscoveryEvidence, "cases"> | unknown,
): { cases: CapabilityCaseModelCase[]; report: CapabilityCaseEnrichmentReport } {
  const input = decodeC2CaseGenerationInput(inputValue);
  const sanitized = sanitizeCaseContextJson(discoveryValue as JsonValue);
  assertSafeCaseContextValue(sanitized, "caseDiscoveryEvidence");
  const discovery = decodeCapabilityCaseDiscoveryEvidence(sanitized, false);
  const contract = input.candidate.contract;
  const enrichment = decodeCapabilityCaseEnrichment(
    enrichmentValue,
    derivation.cases.length,
  );
  const report: CapabilityCaseEnrichmentReport = {
    reselected: [],
    inputIgnored: [],
    expectedIgnored: [],
  };
  const cases: CapabilityCaseModelCase[] = derivation.cases.map((item) => ({
    input: cloneJson(item.input),
    expected: cloneJson(item.expected),
  }));
  const taken = new Set(cases.map((item) => canonicalCapabilityCaseJson(item.input)));
  const reason = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  enrichment.cases.forEach((item, index) => {
    const derived = derivation.cases[index];
    if (item.input && Object.keys(item.input).length) {
      try {
        const next: JsonObject = cloneJson(derived.input);
        for (const [path, value] of Object.entries(item.input)) {
          if (!Object.hasOwn(derived.input, path))
            throw new Error(`case_enrichment_path_not_in_case:${path}`);
          // A value the page happened to show is a suggestion, not the set of
          // things this input may be. The page writes a date one way and the
          // person writes it another; a site's search box takes words that are
          // nowhere on the page it is standing on. What decides whether a value
          // may be used is the contract, checked just below, and what decides
          // whether the capability works is running it.
          const match = (derived.alternatives[path] || []).find((candidate) =>
            evidenceValueEqual(candidate, value),
          );
          const chosen = match === undefined ? value : match;
          // Free to write a value the page never showed, held to the writing
          // the contract states for this input. A value in another form is
          // ignored for this case, which keeps the one it was derived with.
          const writing = declaredValueShape(
            record(record(record(contract.inputSchema).properties)[path]),
            (input.demonstrationParameters || {})[path],
          );
          if (writing && (typeof chosen !== "string" || writtenValueShape(chosen) !== writing))
            throw new Error(`case_enrichment_value_not_in_declared_writing:${path}`);
          next[path] = cloneJson(chosen);
        }
        validateCaseInput(contract, next, index);
        const key = canonicalCapabilityCaseJson(next);
        const own = canonicalCapabilityCaseJson(cases[index].input);
        if (key !== own) {
          if (taken.has(key)) throw new Error("case_enrichment_duplicate_case");
          taken.delete(own);
          taken.add(key);
          cases[index] = { input: next, expected: echoExpected(contract, next) };
          report.reselected.push(index);
        }
      } catch (error) {
        report.inputIgnored.push({ index, reason: reason(error) });
      }
    }
    if (Object.keys(item.expected).length) {
      try {
        // The echo is the case's own truth; a model value never overrides it.
        const merged = { ...item.expected, ...cases[index].expected };
        validateExpectedPartial(contract, merged, index);
        validateExpectedEvidence(
          contract,
          merged,
          cases[index].input,
          discovery,
          index,
        );
        cases[index].expected = cloneJson(merged);
      } catch (error) {
        report.expectedIgnored.push({ index, reason: reason(error) });
      }
    }
  });
  return { cases, report };
}

function assertDiscoveryRefArtifact(value: unknown) {
  const artifactRef =
    typeof value === "string" ? value : record(value).artifactRef;
  const text = requiredString(
    artifactRef,
    "case_discovery_evidence_artifact_ref_invalid",
  );
  if (
    /^file:/iu.test(text) ||
    /^[a-z]:[\\/]/iu.test(text) ||
    /^\\\\/u.test(text) ||
    text.startsWith("/")
  )
    throw new Error("case_discovery_evidence_absolute_path_forbidden");
  return text;
}

export type CapabilityCaseGenerationCompilation = Omit<
  C2CaseGenerationOutput,
  "caseDiscoveryEvidenceRef"
> & {
  caseDiscoveryEvidence: CapabilityCaseDiscoveryEvidence;
  caseDiscoveryEvidenceBytes: Uint8Array;
  caseDiscoveryEvidenceContentHash: string;
  caseDiscoveryEvidenceByteLength: number;
};

export function compileCapabilityCaseGeneration(
  inputValue: C2CaseGenerationInput | unknown,
  modelValue: CapabilityCaseGenerationModelOutput | unknown,
  discoveryValue: CapabilityCaseDiscoveryEvidence | unknown,
): CapabilityCaseGenerationCompilation {
  const input = decodeC2CaseGenerationInput(inputValue);
  const modelOutput = decodeCapabilityCaseModelOutput(modelValue);
  const sanitized = sanitizeCaseContextJson(discoveryValue as JsonValue);
  assertSafeCaseContextValue(sanitized, "caseDiscoveryEvidence");
  const discovery = decodeCapabilityCaseDiscoveryEvidence(sanitized, false);
  if (discovery.generationTaskId !== input.generationTaskId)
    throw new Error("case_discovery_generation_task_mismatch");
  if (discovery.siteId !== input.siteId)
    throw new Error("case_discovery_site_mismatch");
  if (discovery.candidateHash !== capabilityCandidateHash(input.candidate))
    throw new Error("case_discovery_candidate_hash_mismatch");
  if (
    discovery.actions.some(
      (action) => action.action === "submit" && action.outcome === "performed",
    )
  )
    throw new Error("case_discovery_submit_performed_forbidden");
  if (
    discovery.actions.some(
      (action) =>
        action.outcome === "performed" &&
        action.requestMethod &&
        action.requestMethod !== "GET",
    )
  )
    throw new Error("case_discovery_non_get_performed_forbidden");
  if (
    discovery.explorationMode === "evidence-only" &&
    discovery.actions.some(
      (action) =>
        ["search", "filter"].includes(action.action) &&
        action.outcome === "performed",
    )
  ) {
    throw new Error("case_discovery_mode_action_mismatch");
  }
  const candidateBefore = canonicalCapabilityCaseJson(input.candidate);

  assertProgramInputConsumption(
    input.candidate.contract,
    input.candidate.program,
  );
  assertDeterministicConditions(input.candidate.contract);
  // A second case is worth having and is not worth refusing a capability over.
  // What the page offered is what there was: a site with one date control and
  // one day on it yields one case, and demanding a second only meant the
  // capability was never generated. The replay still has to reach a terminal
  // outcome, satisfy the output schema and hold the contract's conditions, and
  // where there are two cases they still may not come back identical.
  assertDefaultOmission(input.candidate.contract, modelOutput.cases);
  modelOutput.cases.forEach((item, index) => {
    validateCaseInput(input.candidate.contract, item.input, index);
    validateExpectedPartial(input.candidate.contract, item.expected, index);
    validateExpectedEvidence(
      input.candidate.contract,
      item.expected,
      item.input,
      discovery,
      index,
    );
  });
  const report = inspectCapabilityQuality(
    input.candidate.contract,
    input.candidate.program,
    {
      validationCases: modelOutput.cases.map((item) => item.input),
      requireIndependentCases: true,
      summary: {
        name: input.candidate.name,
        description: input.candidate.description,
        aliases: input.candidate.aliases,
      },
    },
  );
  if (!report.valid)
    throw new Error(
      `case_generation_quality_rejected:${report.issues.map((issue) => issue.code).join(",")}`,
    );

  const candidate = cloneJson(input.candidate);
  if (canonicalCapabilityCaseJson(candidate) !== candidateBefore)
    throw new Error("case_generation_candidate_mutated");
  const validationSuite = {
    cases: modelOutput.cases.map((item, index) => ({
      caseId: `case_${index + 1}`,
      input: cloneJson(item.input),
      expected: cloneJson(item.expected),
    })),
  };
  const caseDiscoveryEvidence = decodeCapabilityCaseDiscoveryEvidence(
    {
      ...discovery,
      cases: mapCaseEvidence(
        validationSuite.cases,
        discovery,
        input.candidate.program.parameterRoles,
      ),
    },
    true,
  );
  const encoded = encodeDiscoveryEvidence(caseDiscoveryEvidence);
  return {
    generationTaskId: input.generationTaskId,
    candidate,
    validationSuite,
    validationSuiteHash: capabilityValidationSuiteHash(validationSuite),
    caseDiscoveryEvidence,
    caseDiscoveryEvidenceBytes: encoded.bytes,
    caseDiscoveryEvidenceContentHash: encoded.contentHash,
    caseDiscoveryEvidenceByteLength: encoded.byteLength,
  };
}

/** Attach the storage identity only after the fully validated sidecar is persisted. */
export function finalizeCapabilityCaseGeneration(
  compilation: CapabilityCaseGenerationCompilation,
  persisted: string | { artifactRef: string },
): C2CaseGenerationOutput {
  return {
    generationTaskId: compilation.generationTaskId,
    candidate: cloneJson(compilation.candidate),
    validationSuite: cloneJson(compilation.validationSuite),
    validationSuiteHash: compilation.validationSuiteHash,
    caseDiscoveryEvidenceRef: {
      artifactRef: assertDiscoveryRefArtifact(persisted),
      contentHash: compilation.caseDiscoveryEvidenceContentHash,
      byteLength: compilation.caseDiscoveryEvidenceByteLength,
    },
  };
}

/** Decode a formal current C2 output. Evidence ref is mandatory. */
export function decodeC2CaseGenerationOutput(
  value: unknown,
): C2CaseGenerationOutput {
  const output = record(value);
  if (
    Object.keys(output).some(
      (key) =>
        ![
          "generationTaskId",
          "candidate",
          "validationSuite",
          "caseDiscoveryEvidenceRef",
          "validationSuiteHash",
        ].includes(key),
    )
  ) {
    throw new Error("case_generation_output_fields_invalid");
  }
  const candidate = decodeCandidate(output.candidate);
  const suite = record(output.validationSuite);
  if (!Array.isArray(suite.cases) || !suite.cases.length)
    throw new Error("case_generation_suite_cases_required");
  const cases = suite.cases.map((rawCase, index) => {
    const item = record(rawCase);
    if (
      Object.keys(item).some(
        (key) => !["caseId", "input", "expected"].includes(key),
      )
    )
      throw new Error(`case_generation_suite_case_fields_invalid:${index}`);
    if (item.caseId !== `case_${index + 1}`)
      throw new Error(`case_generation_suite_case_id_invalid:${index}`);
    return {
      caseId: `case_${index + 1}`,
      input: cloneJson(
        jsonObject(item.input, `case_generation_input_invalid:${index}`),
      ),
      expected: cloneJson(
        jsonObject(
          item.expected ?? {},
          `case_generation_expected_invalid:${index}`,
        ),
      ),
    };
  });
  const validationSuite = { cases };
  const canonicalHash = capabilityValidationSuiteHash(validationSuite);
  const persistedHash = requiredString(
    output.validationSuiteHash,
    "case_generation_suite_hash_required",
  );
  if (persistedHash !== canonicalHash)
    throw new Error("case_generation_suite_hash_mismatch");
  const refValue = record(output.caseDiscoveryEvidenceRef);
  const caseDiscoveryEvidenceRef: CapabilityCaseDiscoveryEvidenceRef = {
    artifactRef: assertDiscoveryRefArtifact(refValue),
    contentHash: requiredString(
      refValue.contentHash,
      "case_discovery_evidence_content_hash_invalid",
    ),
    byteLength:
      typeof refValue.byteLength === "number" ? refValue.byteLength : -1,
  };
  assertCapabilityCaseDiscoveryEvidenceRef(caseDiscoveryEvidenceRef);
  return {
    generationTaskId: requiredString(
      output.generationTaskId,
      "case_generation_task_id_required",
    ),
    candidate,
    validationSuite,
    validationSuiteHash: canonicalHash,
    caseDiscoveryEvidenceRef,
  };
}

/** Historical decoder only; never use it to enter the new C2 commit path. */
export function decodeLegacyC2CaseGenerationOutput(value: unknown): Omit<
  C2CaseGenerationOutput,
  "caseDiscoveryEvidenceRef"
> & {
  caseDiscoveryEvidenceRef?: CapabilityCaseDiscoveryEvidenceRef;
} {
  const output = record(value);
  const candidate = cloneJson(
    jsonObject(output.candidate, "case_generation_candidate_required"),
  ) as CapabilityCandidate;
  const suite = record(output.validationSuite);
  if (!Array.isArray(suite.cases) || !suite.cases.length)
    throw new Error("case_generation_suite_cases_required");
  const validationSuite = {
    cases: suite.cases.map((rawCase, index) => {
      const item = record(rawCase);
      return {
        caseId:
          typeof item.caseId === "string" && item.caseId
            ? item.caseId
            : `case_${index + 1}`,
        input: cloneJson(
          jsonObject(item.input, `case_generation_input_invalid:${index}`),
        ),
        expected: cloneJson(
          jsonObject(
            item.expected ?? {},
            `case_generation_expected_invalid:${index}`,
          ),
        ),
      };
    }),
  };
  const validationSuiteHash = capabilityValidationSuiteHash(validationSuite);
  return {
    generationTaskId: requiredString(
      output.generationTaskId,
      "case_generation_task_id_required",
    ),
    candidate,
    validationSuite,
    validationSuiteHash,
  };
}

export function assertCapabilityCaseContextRef(ref: CapabilityCaseContextRef) {
  assertSafeCaseContextRef(ref);
}

export function assertCapabilityCaseDiscoveryEvidenceRef(
  ref: CapabilityCaseDiscoveryEvidenceRef,
) {
  assertDiscoveryRefArtifact(ref);
  if (!/^sha256:[a-f0-9]{64}$/u.test(ref.contentHash))
    throw new Error("case_discovery_evidence_content_hash_invalid");
  if (!Number.isInteger(ref.byteLength) || ref.byteLength < 0)
    throw new Error("case_discovery_evidence_byte_length_invalid");
  if (ref.byteLength > CAPABILITY_CASE_DISCOVERY_EVIDENCE_MAX_BYTES)
    throw new Error("case_discovery_evidence_too_large");
}
