import type { CapabilityWorkspace } from "./workspace";
import type { Browser, BrowserContextOptions } from "playwright";
import {
  CAPABILITY_CASE_DISCOVERY_EVIDENCE_MAX_BYTES,
  assertCapabilityCaseGenerationCandidate,
  canonicalCapabilityCaseJson,
  capabilityCandidateHash,
  compileCapabilityCaseGeneration,
  decodeC2CaseGenerationInput,
  deriveCapabilityCases,
  finalizeCapabilityCaseGeneration,
} from "../../lib/capability-center-v2/case-generation";
import type {
  C2CaseGenerationOutput,
  CapabilityCaseDiscoveryEvidence,
} from "../../lib/capability-center-v2/model";
import { discoverCapabilityCaseEvidence, type CapabilityCaseDiscoverySnapshot } from "./case-discovery";

export type CapabilityCaseGenerationDependencies = {
  browser: Browser;
  workspace?: CapabilityWorkspace;
  storageState?: BrowserContextOptions["storageState"];
  persistEvidence: (bytes: Uint8Array) => Promise<{ artifactRef: string }>;
  /** The start page as authoring harvested it; given, case generation reads it instead of browsing. */
  snapshot?: CapabilityCaseDiscoverySnapshot;
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Independent C2 service: discover (or take the harvested page), derive by code, code-gate, then persist evidence. */
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
    snapshot: dependencies.snapshot,
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
  // The cases are what the page offered, as derived; no model re-selects
  // them (the one turn that did chose "Add to basket" as a category).
  const cases = derivation.cases.map(({ input: caseInput, expected }) => ({ input: caseInput, expected }));
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
