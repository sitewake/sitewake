import type { CapabilityWorkspace } from "./workspace";
import type { Browser, BrowserContextOptions } from "playwright";
import { getModelConfig } from "../../lib/model-config";
import {
  CAPABILITY_CASE_DISCOVERY_EVIDENCE_MAX_BYTES,
  assertCapabilityCaseGenerationCandidate,
  canonicalCapabilityCaseJson,
  capabilityCandidateHash,
  compileCapabilityCaseGeneration,
  decodeC2CaseGenerationInput,
  decodeCapabilityCaseEnrichment,
  deriveCapabilityCases,
  finalizeCapabilityCaseGeneration,
  mergeCapabilityCaseEnrichment,
  type CapabilityCaseDerivation,
  type CapabilityCaseModelCase,
} from "../../lib/capability-center-v2/case-generation";
import { requestStructuredModelJson } from "../../lib/capability-center-v2/model-json";
import type {
  C2CaseGenerationOutput,
  CapabilityCaseDiscoveryEvidence,
  JsonObject,
} from "../../lib/capability-center-v2/model";
import { discoverCapabilityCaseEvidence } from "./case-discovery";
import { CAPABILITY_CASE_GENERATION_PROMPT } from "./prompts/case-generation";

/** A model may take this long to enrich; the run does not wait longer. */
// The turn reads the whole candidate, the page evidence and every case's
// alternatives — around 38KB on a real site — and answers with a structured
// object. One 60s attempt was not enough for that: a single timeout dropped
// the enrichment silently, and the derived cases went to validation with a
// page's own prose in them. It is still non-fatal; it is simply given a fair
// chance, and its failure is said out loud.
const CASE_ENRICHMENT_TIMEOUT_MS = 90_000;
const CASE_ENRICHMENT_ATTEMPTS = 2;

/**
 * The output schema for one enrichment request, carrying the capability's own
 * fields. A strict decoder cannot emit any key for a bare object — what came
 * out of one was `"input": { ": 1, ": 1 }` — so `input` lists the Contract's
 * input properties with nothing required (it is omitted when the derived
 * input is fine) and `expected` lists the output properties, nothing required.
 */
export function caseEnrichmentOutputSchema(
  contract: { inputSchema: JsonObject; outputSchema: JsonObject },
  count: number,
) {
  const base = JSON.parse(JSON.stringify(CAPABILITY_CASE_GENERATION_PROMPT.outputSchema)) as typeof CAPABILITY_CASE_GENERATION_PROMPT.outputSchema;
  const schema = base.schema as {
    properties: { cases: { minItems: number; maxItems: number; items: { properties: Record<string, unknown> } } };
  };
  const cases = schema.properties.cases;
  cases.minItems = count;
  cases.maxItems = count;
  cases.items.properties.input = {
    type: "object",
    properties: (contract.inputSchema.properties as JsonObject | undefined) || {},
    required: [],
    additionalProperties: false,
  };
  cases.items.properties.expected = {
    type: "object",
    properties: (contract.outputSchema.properties as JsonObject | undefined) || {},
    required: [],
    additionalProperties: false,
  };
  return base;
}

export type CapabilityCaseEnrichmentRequest = {
  system: string;
  payload: JsonObject;
  outputSchema: ReturnType<typeof caseEnrichmentOutputSchema>;
  /** How many cases the response must carry, in order. */
  count: number;
};

export type CapabilityCaseGenerationDependencies = {
  browser: Browser;
  workspace?: CapabilityWorkspace;
  storageState?: BrowserContextOptions["storageState"];
  persistEvidence: (bytes: Uint8Array) => Promise<{ artifactRef: string }>;
  /** The enrichment model; absent, the configured execution model is used. */
  requestModel?: (
    request: CapabilityCaseEnrichmentRequest,
  ) => unknown | Promise<unknown>;
  /** Told when the enrichment turn could not be used, so a silent fallback is visible. */
  onEnrichmentUnavailable?: (reason: string) => void | Promise<void>;
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function requestCapabilityCaseEnrichmentModel(
  request: CapabilityCaseEnrichmentRequest,
): Promise<unknown> {
  const config = getModelConfig("execution");
  if (!config.configured)
    throw new Error("case_enrichment_model_not_configured");
  return requestStructuredModelJson(config, {
    system: request.system,
    payload: request.payload,
    jsonSchema: request.outputSchema,
    maxTokens: 4_096,
    attempts: CASE_ENRICHMENT_ATTEMPTS,
    timeoutMs: CASE_ENRICHMENT_TIMEOUT_MS,
    disableThinking: true,
    validate: (value) => {
      decodeCapabilityCaseEnrichment(value, request.count);
    },
  });
}

/**
 * Enrich derived cases with one model call. Whatever happens here — no model
 * configured, a timeout, a malformed answer, values the evidence does not
 * support — the derived cases stand and the run goes on; the outcome is
 * written to the workspace for the record.
 */
async function enrichCases(
  input: ReturnType<typeof decodeC2CaseGenerationInput>,
  derivation: CapabilityCaseDerivation,
  evidence: Omit<CapabilityCaseDiscoveryEvidence, "cases">,
  dependencies: CapabilityCaseGenerationDependencies,
): Promise<CapabilityCaseModelCase[]> {
  const derived = derivation.cases.map(({ input: caseInput, expected }) => ({ input: caseInput, expected }));
  const requestModel = dependencies.requestModel || requestCapabilityCaseEnrichmentModel;
  const count = derivation.cases.length;
  const request: CapabilityCaseEnrichmentRequest = {
    system: CAPABILITY_CASE_GENERATION_PROMPT.text,
    payload: cloneJson({
      generationTaskId: input.generationTaskId,
      candidate: input.candidate,
      caseDiscoveryEvidence: evidence,
      cases: derivation.cases.map((item, index) => ({
        caseId: `case_${index + 1}`,
        input: item.input,
        expected: item.expected,
        regionId: item.regionId,
        alternatives: item.alternatives,
      })),
      expectedFields: Object.keys(input.candidate.contract.outputSchema.properties || {}),
    }) as JsonObject,
    outputSchema: caseEnrichmentOutputSchema(input.candidate.contract, count),
    count,
  };
  try {
    await dependencies.workspace?.write("validation/enrichment-request.json", request.payload);
    const raw = await requestModel(request);
    await dependencies.workspace?.write("validation/enrichment-response.json", raw);
    const merged = mergeCapabilityCaseEnrichment(input, derivation, raw, evidence);
    await dependencies.workspace?.write("validation/enrichment-result.json", merged.report);
    return merged.cases;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await dependencies.workspace?.write("validation/enrichment-failure.json", { error: reason });
    await dependencies.onEnrichmentUnavailable?.(reason);
    return derived;
  }
}

/** Independent C2 service: discover, derive, enrich, code-gate, then persist evidence. */
export async function runCapabilityCaseGeneration(
  inputValue: unknown,
  dependencies: CapabilityCaseGenerationDependencies,
): Promise<C2CaseGenerationOutput> {
  const input = decodeC2CaseGenerationInput(inputValue);
  const candidate = cloneJson(input.candidate);
  const candidateCanonical = canonicalCapabilityCaseJson(candidate);
  // Candidate-only gates intentionally run before browser discovery and the
  // model call.  C2 must reject an indeterminate Contract without spending
  // the expensive external steps or producing evidence side effects.
  assertCapabilityCaseGenerationCandidate(candidate);
  await dependencies.workspace?.write('validation/c2-input.json', input);
  const snapshot = await discoverCapabilityCaseEvidence(input, {
    browser: dependencies.browser,
    storageState: dependencies.storageState,
  });
  await dependencies.workspace?.write('validation/c2-observation.json', snapshot);
  const caseDiscoveryEvidence: Omit<CapabilityCaseDiscoveryEvidence, "cases"> =
    {
      ...cloneJson(snapshot),
      candidateHash: capabilityCandidateHash(candidate),
    };
  // Apply the evidence budget before any data is sent to the model.  The
  // final sidecar adds only bounded case mappings and is checked again by the
  // compiler before persistence.
  if (
    new TextEncoder().encode(canonicalCapabilityCaseJson(caseDiscoveryEvidence))
      .byteLength > CAPABILITY_CASE_DISCOVERY_EVIDENCE_MAX_BYTES
  ) {
    throw new Error("case_discovery_evidence_too_large");
  }
  // The cases come from the evidence, by code. Too little evidence fails
  // here, with the input named, before any model is asked anything.
  const derivation = deriveCapabilityCases(input, caseDiscoveryEvidence);
  await dependencies.workspace?.write("validation/c2-derived-cases.json", derivation);
  const cases = await enrichCases(input, derivation, caseDiscoveryEvidence, dependencies);
  if (
    canonicalCapabilityCaseJson(candidate) !== candidateCanonical ||
    canonicalCapabilityCaseJson(input.candidate) !== candidateCanonical
  ) {
    throw new Error("case_generation_candidate_mutated");
  }
  const compilation = compileCapabilityCaseGeneration(
    input,
    { cases },
    caseDiscoveryEvidence,
  );
  const persisted = await dependencies.persistEvidence(
    compilation.caseDiscoveryEvidenceBytes,
  );
  return finalizeCapabilityCaseGeneration(compilation, persisted);
}
