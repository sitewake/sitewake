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
  decodeCapabilityCaseModelOutput,
  finalizeCapabilityCaseGeneration,
  type CapabilityCaseGenerationModelOutput,
} from "../../lib/capability-center-v2/case-generation";
import { requestStructuredModelJson } from "../../lib/capability-center-v2/model-json";
import type {
  C2CaseGenerationOutput,
  CapabilityCaseDiscoveryEvidence,
  JsonObject,
} from "../../lib/capability-center-v2/model";
import { discoverCapabilityCaseEvidence } from "./case-discovery";
import { CAPABILITY_CASE_GENERATION_PROMPT } from "./prompts/case-generation";

export type CapabilityCaseGenerationModelRequest = {
  system: string;
  payload: JsonObject;
  outputSchema: typeof CAPABILITY_CASE_GENERATION_PROMPT.outputSchema;
};

export type CapabilityCaseGenerationDependencies = {
  browser: Browser;
  workspace?: CapabilityWorkspace;
  storageState?: BrowserContextOptions["storageState"];
  persistEvidence: (bytes: Uint8Array) => Promise<{ artifactRef: string }>;
  requestModel?: (
    request: CapabilityCaseGenerationModelRequest,
  ) => unknown | Promise<unknown>;
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function requestCapabilityCaseGenerationModel(
  request: CapabilityCaseGenerationModelRequest,
): Promise<CapabilityCaseGenerationModelOutput> {
  const config = getModelConfig("execution");
  if (!config.configured)
    throw new Error("case_generation_model_not_configured");
  const value = await requestStructuredModelJson(config, {
    system: request.system,
    payload: request.payload,
    jsonSchema: request.outputSchema,
    maxTokens: 4_096,
    attempts: 2,
    validate: decodeCapabilityCaseModelOutput,
  });
  return decodeCapabilityCaseModelOutput(value);
}

/** Independent C2 service: discover, model, code-gate, then persist evidence. */
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
  const payload = cloneJson({
    generationTaskId: input.generationTaskId,
    candidate,
    caseDiscoveryEvidence,
    generationConstraints: {
      inputFields: Object.keys(
        input.candidate.contract.inputSchema.properties || {},
      ),
      requiredInputFields: Array.isArray(
        input.candidate.contract.inputSchema.required,
      )
        ? input.candidate.contract.inputSchema.required
        : [],
      expectedFields: Object.keys(
        input.candidate.contract.outputSchema.properties || {},
      ),
    },
  }) as JsonObject;
  const requestModel =
    dependencies.requestModel || requestCapabilityCaseGenerationModel;
  let compilation:
    ReturnType<typeof compileCapabilityCaseGeneration> | undefined;
  let correction: JsonObject | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const requestPayload = correction
      ? (cloneJson({ ...payload, correction }) as JsonObject)
      : payload;
    let attemptedCases: CapabilityCaseGenerationModelOutput["cases"] = [];
    try {
      await dependencies.workspace?.write(`validation/attempt-${attempt + 1}-request.json`, requestPayload);
      const rawOutput = await requestModel({
          system: correction
            ? `${CAPABILITY_CASE_GENERATION_PROMPT.text}\n上一次输出未通过纯代码门禁。对照 correction.previousCases 和 gateError 重新生成完整 cases；必须实际修改失败字段，不要解释，也不要重复无证据值。`
            : CAPABILITY_CASE_GENERATION_PROMPT.text,
          payload: requestPayload,
          outputSchema: CAPABILITY_CASE_GENERATION_PROMPT.outputSchema,
        });
      await dependencies.workspace?.write(`validation/attempt-${attempt + 1}-response.json`, rawOutput);
      const modelOutput = decodeCapabilityCaseModelOutput(rawOutput);
      attemptedCases = cloneJson(modelOutput.cases);
      if (
        canonicalCapabilityCaseJson(candidate) !== candidateCanonical ||
        canonicalCapabilityCaseJson(input.candidate) !== candidateCanonical
      ) {
        throw new Error("case_generation_candidate_mutated");
      }
      compilation = compileCapabilityCaseGeneration(
        input,
        modelOutput,
        caseDiscoveryEvidence,
      );
      break;
    } catch (error) {
      await dependencies.workspace?.write(`validation/attempt-${attempt + 1}-failure.json`, {error:error instanceof Error ? error.message : String(error)});
      lastError = error;
      correction = {
        gateError: error instanceof Error ? error.message : String(error),
        allowedInputFields: Object.keys(
          input.candidate.contract.inputSchema.properties || {},
        ),
        allowedExpectedFields: Object.keys(
          input.candidate.contract.outputSchema.properties || {},
        ),
        previousCases: attemptedCases,
        instruction:
          error instanceof Error &&
          error.message.includes("independent_cases_required")
            ? "至少生成两个 input 有真实差异的用例；从页面证据中为至少一个输入字段选择不同的已观察值。"
            : "只使用允许字段；删除不允许的字段；expected 不确定时返回空对象。",
      };
    }
  }
  if (!compilation) throw lastError;
  const persisted = await dependencies.persistEvidence(
    compilation.caseDiscoveryEvidenceBytes,
  );
  return finalizeCapabilityCaseGeneration(compilation, persisted);
}
