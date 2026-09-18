import { gzipSync } from "node:zlib";
import { CapabilityWorkspace } from "./workspace";
import { chromium, type BrowserContext, type Page } from "playwright";
import { readFile } from "node:fs/promises";
import type {
  C1AuthoringOutput,
  C2CaseGenerationInput,
  C2CaseGenerationOutput,
  CapabilityCandidateArtifact,
  CapabilityCaseDiscoveryEvidence,
  CapabilityContract,
  CapabilityModuleRef,
  CapabilityProgram,
  CapabilityPromptProvenance,
  CapabilityStageEvidence,
  InteractionField,
  JsonObject,
  JsonValue,
  RunSpec,
  TaskInteraction,
} from "../../lib/capability-center-v2/model";
import {
  EvaluationError,
  MissingInputError,
  evaluatePreconditions,
  evaluateResult,
  evaluateResultDeterministic,
  exploreCapability,
  validateContractInput,
  type CapabilityExplorationTraceEvent,
} from "./browser-runtime";
import { authorJavaScriptCapability } from "./javascript-author";
import { bootstrapAuthentication } from "./auth-bootstrap";
import {
  projectStageReceipts,
  runCapabilityJavaScriptStages,
  type JavaScriptStageReceipt,
} from "./javascript-stage-runner";
import { inspectCapabilityQuality } from "../../lib/capability-center-v2/quality";
import {
  diagnoseRunnerFailure,
  type RunnerPageSummary,
} from "./failure-diagnostics";
import {
  assertBrowserModuleUrlForPage,
  capabilityV2RuntimeEndpoints,
  resolveCapabilityModuleUrl,
} from "./module-delivery";
import { resolveCapabilityInputDefaults } from "../../lib/capability-center-v2/input-template";
import { projectCapabilityContract } from "../../lib/capability-center-v2/semantic-analyzer";
import { runCapabilityCaseGeneration } from "./case-generation";
import {
  capabilityCandidateHash,
  parseCapabilityCaseDiscoveryEvidenceSidecar,
} from "../../lib/capability-center-v2/case-generation";

const { controlPlaneUrl: endpoint, browserPublicUrl: browserPublicEndpoint } =
  capabilityV2RuntimeEndpoints();
const siteId = process.env.CAPABILITY_V2_SITE_ID || "";
const taskId = process.env.CAPABILITY_V2_TASK_ID || "";
const runnerId = process.env.CAPABILITY_V2_RUNNER_ID || crypto.randomUUID();
let heartbeatStatus: "Running" | "WaitingInput" = "Running";

function headers() {
  return {
    "content-type": "application/json",
    "x-sitewake-site-id": siteId,
    "x-capability-runner-id": runnerId,
    ...(process.env.CAPABILITY_V2_RUNNER_TOKEN
      ? { authorization: `Bearer ${process.env.CAPABILITY_V2_RUNNER_TOKEN}` }
      : {}),
  };
}

async function api<T>(path: string, init: RequestInit = {}) {
  const internalMatch = path.match(
    /^\/api\/internal\/capability-v2\/tasks\/[^/]+\/(.+)$/,
  );
  const internalPath = internalMatch
    ? `/api/internal/capability-v2/runner?taskId=${encodeURIComponent(taskId)}&action=${encodeURIComponent(internalMatch[1])}`
    : path;
  const response = await fetch(`${endpoint}${internalPath}`, {
    ...init,
    headers: { ...headers(), ...(init.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      String(
        (payload as { message?: string; error?: string }).message ||
          (payload as { error?: string }).error ||
          response.statusText,
      ),
    );
  return payload as T;
}

function isPrivateHostname(hostname: string) {
  const value = hostname.toLowerCase();
  return (
    value === "localhost" ||
    value === "::1" ||
    value === "0.0.0.0" ||
    value === "169.254.169.254" ||
    /^127\./.test(value) ||
    /^10\./.test(value) ||
    /^192\.168\./.test(value) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(value)
  );
}

function assertSafeUrl(value: string, allowedOrigin?: string) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new Error("runner_url_invalid");
  for (const key of url.searchParams.keys())
    if (
      /token|secret|password|credential|authorization|session|signature|ticket|code|state/i.test(
        key,
      )
    )
      throw new Error("runner_url_sensitive_parameter");
  if (allowedOrigin && url.origin !== allowedOrigin)
    throw new Error("runner_url_origin_invalid");
  if (
    isPrivateHostname(url.hostname) &&
    process.env.CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN !== "1"
  )
    throw new Error("runner_private_url_forbidden");
  return url;
}

function validateSpecUrls(spec: RunSpec) {
  const contextStartUrl =
    typeof spec.input.context.startUrl === "string"
      ? spec.input.context.startUrl
      : undefined;
  const start =
    spec.browser.startUrl || contextStartUrl
      ? assertSafeUrl(spec.browser.startUrl || contextStartUrl!)
      : undefined;
  const origin = start?.origin;
  const authBootstrap = spec.input.context.authBootstrap;
  if (
    authBootstrap &&
    typeof authBootstrap === "object" &&
    !Array.isArray(authBootstrap)
  ) {
    const authUrl = (authBootstrap as JsonObject).url;
    if (typeof authUrl === "string" && authUrl.trim())
      assertSafeUrl(authUrl, origin);
  }
  for (const item of spec.plan) {
    const program = item.program;
    if (program?.entry.url) assertSafeUrl(program.entry.url, origin);
  }
}

function assertValidationRunnerIsolation(spec: RunSpec) {
  const validation =
    process.env.CAPABILITY_V2_TASK_TYPE === "Validation" ||
    Boolean(spec.candidateValidation);
  if (!validation) return;
  const forbidden = [
    "MODEL_API_KEY",
    "MODEL_BASE_URL",
    "MODEL",
    "MODEL_EXECUTION",
    "MODEL_SEMANTIC",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
  ];
  const present = forbidden.filter((key) => (process.env[key] || "").trim());
  if (present.length)
    throw new Error(
      `validation_runner_model_credentials_present:${present.join(",")}`,
    );
}

function interactionFor(error: MissingInputError): TaskInteraction {
  const field: InteractionField = {
    key: error.key,
    label: error.key,
    type: /otp|code/i.test(error.key)
      ? "otp"
      : error.sensitive
        ? "password"
        : "text",
    required: true,
    sensitive: error.sensitive,
  };
  return {
    id: `runtime-${error.key.replace(/[^a-z0-9_-]/gi, "-")}`,
    status: "Requested",
    audience: "Administrator",
    message: `任务继续执行需要提供：${error.key}`,
    resumeMode: "Continue",
    fields: [field],
  };
}

async function awaitInput(error: MissingInputError) {
  const interaction = interactionFor(error);
  heartbeatStatus = "WaitingInput";
  await api(`/api/internal/capability-v2/tasks/${taskId}/events`, {
    method: "POST",
    body: JSON.stringify({
      runnerId,
      eventType: "InputRequested",
      interaction,
    }),
  });
  const configured = Number(
    process.env.CAPABILITY_V2_INTERACTION_TIMEOUT_MS || 15 * 60_000,
  );
  const deadline =
    Date.now() +
    Math.max(
      30_000,
      Math.min(
        60 * 60_000,
        Number.isFinite(configured) ? configured : 15 * 60_000,
      ),
    );
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const response = await api<{ commands: Array<{ type: string }> }>(
      `/api/internal/capability-v2/tasks/${taskId}/commands`,
    );
    if (response.commands.some((command) => command.type === "Cancel"))
      throw new Error("task_cancelled");
    if (response.commands.some((command) => command.type === "Continue")) {
      heartbeatStatus = "Running";
      await api(
        `/api/internal/capability-v2/tasks/${taskId}/runner/heartbeat`,
        {
          method: "POST",
          body: JSON.stringify({ runnerId, status: "Running" }),
        },
      );
      return api<RunSpec>(
        `/api/internal/capability-v2/tasks/${taskId}/run-spec`,
      );
    }
  }
  heartbeatStatus = "Running";
  throw new Error("interaction_timeout");
}

async function initializeBrowserContext(
  context: BrowserContext,
  spec: RunSpec,
) {
  const initialLocalStorage = spec.input.context.initialLocalStorage;
  if (
    !initialLocalStorage ||
    typeof initialLocalStorage !== "object" ||
    Array.isArray(initialLocalStorage)
  )
    return;
  await context.addInitScript(
    (entries: Record<string, string>) => {
      for (const [key, value] of Object.entries(entries))
        localStorage.setItem(key, value);
    },
    Object.fromEntries(
      Object.entries(initialLocalStorage).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  );
}

async function isolatedValidationPage(
  page: Page,
  spec: RunSpec,
  baselineStorageState?: Awaited<ReturnType<BrowserContext["storageState"]>>,
) {
  const browser = page.context().browser();
  if (!browser) throw new Error("validation_browser_unavailable");
  // Copy only the authenticated baseline captured before exploration. The
  // exploration itself may add products, change filters, or mutate other
  // business state; carrying that post-exploration state into DraftReplay or
  // C3 would make a supposedly fresh case observe contaminated data.
  const storageState =
    baselineStorageState || (await page.context().storageState());
  const context = await browser.newContext({
    recordVideo: spec.browser.recording
      ? {
          dir:
            process.env.CAPABILITY_V2_ARTIFACT_DIR ||
            ".artifacts/capability-v2",
        }
      : undefined,
    storageState,
  });
  await initializeBrowserContext(context, spec);
  return { context, page: await context.newPage() };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

async function hashJson(value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical(value))),
  );
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function jsonValuesEqual(left: unknown, right: unknown) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function assertExpectedOutput(
  actual: JsonObject,
  expected: JsonObject,
  caseId: string,
) {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (!(key in actual))
      throw new EvaluationError(
        "BusinessRejection",
        `validation_expected_output_missing:${caseId}:${key}`,
      );
    if (!jsonValuesEqual(actual[key], expectedValue)) {
      throw new EvaluationError(
        "BusinessRejection",
        `validation_expected_output_mismatch:${caseId}:${key}`,
      );
    }
  }
}

/** C3: deterministic replay only; this branch never calls a model. */
async function performCandidateValidation(
  page: Page,
  spec: RunSpec,
  helpers: PerformHelpers,
  baselineStorageState?: Awaited<ReturnType<BrowserContext["storageState"]>>,
) {
  const candidate = spec.candidateValidation;
  if (!candidate) throw new Error("candidate_validation_spec_missing");
  if (!helpers.loadCandidateValidationBundle)
    throw new Error("candidate_validation_bundle_loader_required");
  const frozen = await helpers.loadCandidateValidationBundle();
  const artifact = frozen.artifact;
  const expectedArtifactRef = `candidate-artifact://${spec.siteId}/${artifact.candidateId}`;
  if (
    artifact.candidateId !== candidate.candidateId ||
    artifact.generationTaskId !== frozen.evidence.generationTaskId ||
    candidate.artifactRef !== expectedArtifactRef ||
    artifact.contractHash !== candidate.contractHash ||
    artifact.programHash !== candidate.programHash ||
    !artifact.validationSuiteHash ||
    !candidate.validationSuiteHash ||
    artifact.validationSuiteHash !== candidate.validationSuiteHash ||
    !artifact.caseDiscoveryEvidenceRef ||
    !candidate.caseDiscoveryEvidenceRef ||
    !jsonValuesEqual(
      artifact.caseDiscoveryEvidenceRef,
      candidate.caseDiscoveryEvidenceRef,
    ) ||
    !jsonValuesEqual(artifact.candidate.contract, candidate.contract) ||
    !jsonValuesEqual(artifact.candidate.program, candidate.program) ||
    !jsonValuesEqual(artifact.validationSuite.cases, candidate.cases)
  ) {
    throw new EvaluationError(
      "BusinessRejection",
      "candidate_frozen_artifact_mismatch",
    );
  }
  const parsedEvidence = parseCapabilityCaseDiscoveryEvidenceSidecar(
    frozen.evidence,
    artifact.caseDiscoveryEvidenceRef,
  );
  if (
    parsedEvidence.value.siteId !== spec.siteId ||
    parsedEvidence.value.generationTaskId !== artifact.generationTaskId ||
    parsedEvidence.value.candidateHash !==
      capabilityCandidateHash(artifact.candidate)
  ) {
    throw new EvaluationError(
      "BusinessRejection",
      "candidate_discovery_evidence_mismatch",
    );
  }
  if (
    (await hashJson(candidate.contract)) !== candidate.contractHash ||
    (await hashJson(candidate.program)) !== candidate.programHash
  ) {
    throw new EvaluationError("BusinessRejection", "candidate_hash_mismatch");
  }
  if (
    candidate.validationSuiteHash &&
    (await hashJson({ cases: candidate.cases })) !==
      candidate.validationSuiteHash
  ) {
    throw new EvaluationError(
      "BusinessRejection",
      "candidate_validation_suite_hash_mismatch",
    );
  }
  const validationResults: Array<{
    caseId: string;
    resolvedInput: JsonObject;
    output: JsonObject;
    stageReceipts: Array<{
      stageId: string;
      outcome: "Success" | "Failed" | "NoResult" | "BusinessRejection";
      evidenceRefs: string[];
    }>;
    evidenceRefs: string[];
  }> = [];
  const stageReceipts: JavaScriptStageReceipt[] = [];
  const targetEvidence: CapabilityStageEvidence[] = [];
  const artifactRefs: UploadedArtifact[] = [];
  for (const testCase of candidate.cases) {
    const isolated = await isolatedValidationPage(
      page,
      spec,
      baselineStorageState,
    );
    try {
      const caseInput: import("../../lib/capability-center-v2/model").CapabilityTaskInput =
        {
          ...spec.input,
          parameters: resolveCapabilityInputDefaults(
            candidate.contract,
            testCase.input,
          ),
        };
      validateContractInput(candidate.contract, caseInput);
      // CandidateValidation's physical transport projection intentionally keeps
      // the candidate browser envelope small.  The discovery start page still
      // travels in the logical task input context, so C3 must use it when the
      // published entry policy is CurrentPage.  Otherwise the fresh page stays
      // at about:blank (opaque origin) and every module import fails before the
      // deterministic replay even starts.
      const startUrl =
        candidate.program.entry.mode === "Navigate"
          ? candidate.program.entry.url
          : spec.browser.startUrl || spec.input.context.startUrl;
      if (startUrl) {
        await isolated.page.goto(startUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await isolated.page.waitForTimeout(200);
      }
      await evaluatePreconditions(isolated.page, candidate.contract, caseInput);
      const replayed = await runCapabilityJavaScriptStages({
        page: isolated.page,
        moduleUrl: helpers.absoluteModuleUrl(
          candidate.program.module.moduleUrl,
          candidate.program.module.contentHash,
        ),
        program: candidate.program,
        input: caseInput.parameters,
      });
      if (replayed.outcome !== "Success")
        throw new EvaluationError(
          replayed.outcome === "NoResult" ? "NoResult" : "BusinessRejection",
          replayed.reason || replayed.outcome,
        );
      await evaluateResultDeterministic(
        isolated.page,
        candidate.contract,
        replayed.output,
        caseInput,
        replayed.observedText,
      );
      assertExpectedOutput(replayed.output, testCase.expected, testCase.caseId);
      const refs = replayed.evidence.map(
        (_, index) =>
          `evidence://validation/${spec.taskId}/${testCase.caseId}/${index + 1}`,
      );
      const receipts = projectStageReceipts(replayed.receipts, refs);
      stageReceipts.push(...replayed.receipts);
      targetEvidence.push(...replayed.evidence);
      validationResults.push({
        caseId: testCase.caseId,
        resolvedInput: caseInput.parameters,
        output: replayed.output,
        stageReceipts: receipts,
        evidenceRefs: refs,
      });
      await helpers.onEvent(
        "Validating",
        `C3 纯代码验证样例 ${testCase.caseId} 已通过`,
        { caseId: testCase.caseId, ai: false },
      );
    } finally {
      await isolated.context.close().catch(() => undefined);
    }
  }
  return {
    output: validationResults.at(-1)?.output || {},
    validationCaseCount: validationResults.length,
    stageReceipts,
    targetEvidence,
    validationResults,
    artifactRefs,
  };
}

type PerformHelpers = {
  workspace?: CapabilityWorkspace;
  checkpoint?: () => Promise<void>;
  loadAuthorCheckpoint?: () => Promise<Awaited<ReturnType<typeof performC1Authoring>> | null>;
  persistModule: (source: string) => Promise<CapabilityModuleRef>;
  absoluteModuleUrl: (moduleUrl: string, contentHash?: string) => string;
  onEvent: (
    phase: string,
    message: string,
    payload?: JsonObject,
  ) => Promise<void>;
  saveArtifact: (
    kind:
      | "Screenshot"
      | "Trace"
      | "Video"
      | "Log"
      | "CaseContext"
      | "CaseDiscoveryEvidence",
    contentType: string,
    bytes: Uint8Array,
  ) => Promise<UploadedArtifact | undefined>;
  loadCandidateValidationBundle?: () => Promise<{
    artifact: CapabilityCandidateArtifact;
    evidence: CapabilityCaseDiscoveryEvidence;
  }>;
};

type CompletedResult = {
  output: JsonObject;
  candidateProgram?: CapabilityProgram;
  candidateSource?: string;
  candidateBundle?: string;
  candidateSummary?: {
    name: string;
    description: string;
    aliases: string[];
    contract: CapabilityContract;
  };
  demonstrationParameters?: Record<string, JsonValue>;
  c1AuthoringOutput?: C1AuthoringOutput;
  c2CaseGenerationOutput?: C2CaseGenerationOutput;
  validationCaseCount?: number;
  validationResults?: Array<{
    caseId: string;
    resolvedInput: JsonObject;
    output: JsonObject;
    stageReceipts: Array<{
      stageId: string;
      outcome: "Success" | "Failed" | "NoResult" | "BusinessRejection";
      evidenceRefs: string[];
    }>;
    evidenceRefs: string[];
  }>;
  stageReceipts: JavaScriptStageReceipt[];
  targetEvidence: CapabilityStageEvidence[];
  promptProvenance?: CapabilityPromptProvenance[];
  artifactRefs: UploadedArtifact[];
};

export async function performC1Authoring(
  page: Page,
  spec: RunSpec,
  observer: ((event: CapabilityExplorationTraceEvent) => void) | undefined,
  helpers: PerformHelpers,
  baselineStorageState?: Awaited<ReturnType<BrowserContext["storageState"]>>,
) {
  const authoringBaselineStorageState =
    baselineStorageState || (await page.context().storageState());
  if (!spec.browser.startUrl) throw new Error("exploration_start_url_required");
  await helpers.onEvent(
    "Specification",
    "设计参数、Contract 与 C1 私有编写样例",
  );
  const configuredExplorationSteps = Number(
    process.env.CAPABILITY_V2_EXPLORATION_MAX_STEPS || 24,
  );
  const explorationMaxSteps = Number.isFinite(configuredExplorationSteps)
    ? Math.max(16, Math.min(100, configuredExplorationSteps))
    : 24;
  const explored = await exploreCapability(
    page,
    spec.goal || "完成用户目标",
    spec.browser.startUrl,
    spec.input,
    explorationMaxSteps,
    observer,
    spec.guidance,
  );
  await helpers.onEvent(
    "Exploring",
    "Playwright 探索已成功，开始编写 JavaScript Stage",
  );
  const authored = await authorJavaScriptCapability({
    explorationPage: page,
    workspace: helpers.workspace,
    startUrl: spec.browser.startUrl,
    goal: spec.goal || "完成用户目标",
    input: { ...spec.input, parameters: explored.demonstrationParameters },
    contract: explored.candidateSummary.contract,
    explorationProgram: explored.program,
    groundingExamples: explored.groundingExamples,
    explorationPromptProvenance: explored.promptProvenance,
    createDraftContext: () =>
      isolatedValidationPage(page, spec, authoringBaselineStorageState),
    persistModule: helpers.persistModule,
    absoluteModuleUrl: helpers.absoluteModuleUrl,
    onEvent: (event) =>
      helpers.onEvent(event.phase, event.message, event.payload),
  });
  const draftQuality = inspectCapabilityQuality(
    explored.candidateSummary.contract,
    authored.program,
    {
      demonstrationParameters: explored.demonstrationParameters,
      validationCases: explored.groundingExamples,
      source: authored.bundle,
      summary: explored.candidateSummary,
    },
  );
  await helpers.onEvent(
    "Quality",
    draftQuality.valid ? "确定性质量门禁通过" : "确定性质量门禁拒绝候选能力",
    {
      valid: draftQuality.valid,
      issues: draftQuality.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        ...(issue.path ? { path: issue.path } : {}),
      })),
      declaredInputs: draftQuality.declaredInputs,
      requiredInputs: draftQuality.requiredInputs,
      programInputs: draftQuality.programInputs,
      contractInputs: draftQuality.contractInputs,
      sourceHash: authored.program.module.contentHash,
      sourceBytes: new TextEncoder().encode(authored.bundle).byteLength,
    },
  );
  if (!draftQuality.valid) {
    const details = draftQuality.issues
      .map((issue) => `${issue.code}${issue.path ? `@${issue.path}` : ""}`)
      .join(",");
    throw new EvaluationError(
      "BusinessRejection",
      `capability_quality_rejected:${details}`,
    );
  }
  const candidateProgram: CapabilityProgram = {
    schemaVersion: authored.program.schemaVersion,
    runtime: authored.program.runtime,
    module: authored.program.module,
    entry: authored.program.entry,
    stages: authored.program.stages,
    ...(authored.program.controlFlow
      ? { controlFlow: authored.program.controlFlow }
      : {}),
    parameterRoles: authored.program.parameterRoles,
    targetBindings: authored.program.targetBindings,
    promptProvenance: authored.program.promptProvenance,
    ...(authored.program.inputAliases
      ? { inputAliases: authored.program.inputAliases }
      : {}),
  };
  const candidateSummary = {
    ...explored.candidateSummary,
    contract: projectCapabilityContract(explored.candidateSummary.contract),
  };
  const c1AuthoringOutput: C1AuthoringOutput = {
    generationTaskId: spec.taskId,
    name: candidateSummary.name,
    description: candidateSummary.description,
    aliases: candidateSummary.aliases,
    contract: candidateSummary.contract,
    program: candidateProgram,
  };
  return {
    c1AuthoringOutput,
    output: authored.draft.output,
    candidateSource: authored.source,
    candidateBundle: authored.bundle,
    demonstrationParameters: explored.demonstrationParameters,
    stageReceipts: authored.draft.receipts,
    targetEvidence: authored.draft.evidence,
    promptProvenance: authored.program.promptProvenance,
    artifactRefs: [],
  };
}

async function perform(
  page: Page,
  spec: RunSpec,
  observer?: (event: CapabilityExplorationTraceEvent) => void,
  helpers?: PerformHelpers,
) {
  const baselineStorageState = await page.context().storageState();
  if (spec.candidateValidation) {
    if (!helpers) throw new Error("candidate_validation_helpers_required");
    return performCandidateValidation(
      page,
      spec,
      helpers,
      baselineStorageState,
    );
  }
  const explore = spec.plan.find((item) => item.type === "Explore");
  if (explore) {
    if (!helpers) throw new Error("javascript_author_helpers_required");
    const restored = await helpers.loadAuthorCheckpoint?.();
    const authored = restored || await performC1Authoring(page,spec,observer,helpers,baselineStorageState);
    if (restored) await helpers.onEvent('AuthoringRestored','已恢复通过自测的源码，继续独立取证');
    await helpers.workspace?.write('reports/c1-checkpoint.json',{authored});
    await helpers.checkpoint?.();
    await helpers.onEvent(
      "CaseGeneration",
      "C1 已完成，开始独立 C2 测试用例生成",
      { generationTaskId: spec.taskId },
    );
    let c2CaseGenerationOutput: C2CaseGenerationOutput;
    let caseDiscoveryEvidenceArtifact: UploadedArtifact | undefined;
    try {
      const browser = page.context().browser();
      if (!browser || !spec.browser.startUrl)
        throw new Error("case_generation_browser_required");
      const c2Input: C2CaseGenerationInput = {
        generationTaskId: spec.taskId,
        siteId: spec.siteId,
        candidate: {
          name: authored.c1AuthoringOutput.name,
          description: authored.c1AuthoringOutput.description,
          aliases: authored.c1AuthoringOutput.aliases,
          contract: authored.c1AuthoringOutput.contract,
          program: authored.c1AuthoringOutput.program,
          ...(authored.c1AuthoringOutput.replacementPlan
            ? { replacementPlan: authored.c1AuthoringOutput.replacementPlan }
            : {}),
        },
        browser: {
          baseUrl: new URL(spec.browser.startUrl).origin,
          startUrl: spec.browser.startUrl,
          recording: spec.browser.recording,
          session: { mode: "AuthenticatedSnapshot" },
          readOnlyPathPrefixes: ["/"],
        },
      };
      observer?.({
        at: new Date().toISOString(),
        stage: "case-generate-compile",
        request: { c2CaseGenerationInput: c2Input },
      });
      c2CaseGenerationOutput = await runCapabilityCaseGeneration(c2Input, {
        workspace: helpers.workspace,
        browser,
        storageState: baselineStorageState,
        persistEvidence: async (bytes) => {
          caseDiscoveryEvidenceArtifact = await helpers.saveArtifact(
            "CaseDiscoveryEvidence",
            "application/json",
            bytes,
          );
          if (!caseDiscoveryEvidenceArtifact)
            throw new Error("case_discovery_evidence_persist_failed");
          return {
            artifactRef: `artifact://${caseDiscoveryEvidenceArtifact.artifactId}`,
          };
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`case_generation_failed:${reason}`);
    }
    await helpers.onEvent(
      "CaseGeneration",
      "C2 测试用例生成与纯代码门禁已通过",
      {
        generationTaskId: spec.taskId,
        caseCount: c2CaseGenerationOutput.validationSuite.cases.length,
        validationSuiteHash: c2CaseGenerationOutput.validationSuiteHash,
      },
    );
    observer?.({
      at: new Date().toISOString(),
      stage: "case-generate-compile",
      response: {
        generationTaskId: spec.taskId,
        validationSuiteHash: c2CaseGenerationOutput.validationSuiteHash,
        caseCount: c2CaseGenerationOutput.validationSuite.cases.length,
      },
    });
    return {
      output: authored.output,
      candidateProgram: authored.c1AuthoringOutput.program,
      candidateSource: authored.candidateSource,
      candidateBundle: authored.candidateBundle,
      candidateSummary: c2CaseGenerationOutput.candidate,
      c1AuthoringOutput: authored.c1AuthoringOutput,
      c2CaseGenerationOutput,
      stageReceipts: authored.stageReceipts,
      targetEvidence: authored.targetEvidence,
      promptProvenance: authored.promptProvenance,
      artifactRefs: [
        ...authored.artifactRefs,
        ...(caseDiscoveryEvidenceArtifact
          ? [caseDiscoveryEvidenceArtifact]
          : []),
      ],
    };
  }

  validateContractInput(spec.contract, spec.input);
  const replay = spec.plan.find((item) => item.type === "Replay")?.program;
  if (!replay) throw new Error("run_spec_program_missing");
  const configuredCases = Array.isArray(spec.input.context.validationCases)
    ? spec.input.context.validationCases.filter(
        (value): value is JsonObject =>
          Boolean(value) && typeof value === "object" && !Array.isArray(value),
      )
    : [];
  const cases = configuredCases.length
    ? configuredCases
    : [spec.input.parameters];
  await helpers?.onEvent(
    "Validating",
    `开始独立回放 ${cases.length} 个验证样例`,
    { caseCount: cases.length },
  );
  let output: JsonObject = {};
  const stageReceipts: JavaScriptStageReceipt[] = [];
  const targetEvidence: CapabilityStageEvidence[] = [];
  const artifactRefs: UploadedArtifact[] = [];
  for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
    const validationCase = cases[caseIndex];
    await helpers?.onEvent("Validating", `正在回放验证样例 ${caseIndex + 1}`, {
      caseIndex: caseIndex + 1,
      caseCount: cases.length,
    });
    const isolated = await isolatedValidationPage(
      page,
      spec,
      baselineStorageState,
    );
    const caseVideo = isolated.page.video();
    const caseInput = {
      ...spec.input,
      parameters: resolveCapabilityInputDefaults(spec.contract, validationCase),
    };
    try {
      validateContractInput(spec.contract, caseInput);
      const startUrl =
        replay.entry.mode === "Navigate"
          ? replay.entry.url
          : spec.browser.startUrl || spec.input.context.startUrl;
      if (startUrl) {
        await isolated.page.goto(startUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await isolated.page.waitForTimeout(200);
      }
      const before = await isolated.page.screenshot({
        type: "png",
        fullPage: false,
      });
      const beforeArtifact = await helpers?.saveArtifact(
        "Screenshot",
        "image/png",
        before,
      );
      if (beforeArtifact) artifactRefs.push(beforeArtifact);
      await evaluatePreconditions(isolated.page, spec.contract, caseInput);
      const replayed = await runCapabilityJavaScriptStages({
        page: isolated.page,
        moduleUrl:
          helpers?.absoluteModuleUrl(
            replay.module.moduleUrl,
            replay.module.contentHash,
          ) ||
          resolveCapabilityModuleUrl(
            replay.module.moduleUrl,
            browserPublicEndpoint,
            replay.module.contentHash,
          ),
        program: replay,
        input: caseInput.parameters,
      });
      if (replayed.outcome !== "Success")
        throw new EvaluationError(
          replayed.outcome === "NoResult" ? "NoResult" : "BusinessRejection",
          replayed.reason || replayed.outcome,
        );
      output = replayed.output;
      stageReceipts.push(...replayed.receipts);
      targetEvidence.push(...replayed.evidence);
      await evaluateResult(
        replayed.page,
        spec.goal || "完成用户目标",
        spec.contract,
        output,
        caseInput,
        observer,
        replayed.observedText,
      );
      const after = await replayed.page.screenshot({
        type: "png",
        fullPage: false,
      });
      const afterArtifact = await helpers?.saveArtifact(
        "Screenshot",
        "image/png",
        after,
      );
      if (afterArtifact) artifactRefs.push(afterArtifact);
      const receiptArtifact = await helpers?.saveArtifact(
        "Trace",
        "application/json",
        Buffer.from(
          JSON.stringify(
            {
              schemaVersion: "2.0",
              caseIndex: caseIndex + 1,
              caseCount: cases.length,
              receipts: replayed.receipts,
              evidence: replayed.evidence,
              outcome: replayed.outcome,
            },
            null,
            2,
          ),
          "utf8",
        ),
      );
      if (receiptArtifact) artifactRefs.push(receiptArtifact);
      await helpers?.onEvent("Validating", `验证样例 ${caseIndex + 1} 已通过`, {
        caseIndex: caseIndex + 1,
        caseCount: cases.length,
        artifactIds: [
          beforeArtifact?.artifactId,
          afterArtifact?.artifactId,
          receiptArtifact?.artifactId,
        ].filter((value): value is string => Boolean(value)),
      });
    } finally {
      await isolated.context.close().catch(() => undefined);
      if (caseVideo) {
        const videoPath = await caseVideo.path().catch(() => undefined);
        if (videoPath) {
          const videoArtifact = await helpers?.saveArtifact(
            "Video",
            "video/webm",
            await readFile(videoPath),
          );
          if (videoArtifact) artifactRefs.push(videoArtifact);
        }
      }
    }
  }
  return {
    output,
    validationCaseCount: cases.length,
    stageReceipts,
    targetEvidence,
    artifactRefs,
  };
}

type UploadedArtifact = {
  artifactId: string;
  kind: string;
  storageKey: string;
};

async function uploadArtifact(
  kind:
    | "Screenshot"
    | "Trace"
    | "Video"
    | "Log"
    | "Source"
    | "Bundle"
    | "CaseContext"
    | "CaseDiscoveryEvidence",
  contentType: string,
  bytes: Uint8Array,
) {
  return api<UploadedArtifact>(
    `/api/internal/capability-v2/tasks/${taskId}/artifacts`,
    {
      method: "POST",
      body: JSON.stringify({
        runnerId,
        kind,
        contentType,
        contentBase64: Buffer.from(bytes).toString("base64"),
      }),
    },
  ).catch(() => undefined);
}

async function captureScreenshot(page: Page) {
  const bytes = await page
    .screenshot({ type: "png", fullPage: false })
    .catch(() => undefined);
  if (!bytes) return undefined;
  return uploadArtifact("Screenshot", "image/png", bytes);
}

async function captureTrace(events: CapabilityExplorationTraceEvent[]) {
  const payload = Buffer.from(
    JSON.stringify({ schemaVersion: "1.0", taskId, runnerId, events }, null, 2),
    "utf8",
  );
  return uploadArtifact("Trace", "application/json", payload);
}

async function run() {
  const workspace = await CapabilityWorkspace.create();
  const captureWorkspace = async (status: string, error?: string, required = true) => {
    await workspace.write('reports/status.json', {taskId,runnerId,status,error});
    const saved = await uploadArtifact('Log','application/vnd.sitewake.workspace+json+gzip',gzipSync(Buffer.from(JSON.stringify(await workspace.export()))));
    if (!saved && required) throw new Error('workspace_artifact_persist_failed');
    return saved;
  };
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let spec: RunSpec;
  let completed: CompletedResult;
  const trace: CapabilityExplorationTraceEvent[] = [
    { at: new Date().toISOString(), stage: "runner-start" },
  ];
  const recordTrace = (event: CapabilityExplorationTraceEvent) => {
    void workspace.event("pipeline.trace", event).catch(error => console.error("workspace_record_failed", String(error)));
    if (trace.length < 240) trace.push(event);
    const moduleByStage: Record<string, string> = {
      "semantic-analyze": "semantic.analyze",
      "dependency-ledger": "dependency.ledger",
      "scope-resolve": "scope.resolve",
      "seed-build": "seed.build",
      "parameter-plan": "browser.explore",
      "parameter-plan-normalized": "browser.explore",
      "explorer-action": "browser.explore",
      "explorer-action-result": "browser.explore",
      "contract-design": "contract.design",
      "case-generate-compile": "case.generate-compile",
      "explorer-terminal-signal": "browser.explore",
      "goal-judge": "validation.judge",
    };
    const moduleId = moduleByStage[event.stage];
    if (moduleId) {
      void api(`/api/internal/capability-v2/tasks/${taskId}/events`, {
        method: "POST",
        body: JSON.stringify({
          runnerId,
          eventType: "TraceStage",
          phase: event.stage,
          message: event.message,
          moduleId,
          payload: {
            input:
              event.request && typeof event.request === "object"
                ? event.request
                : {},
            output:
              event.response && typeof event.response === "object"
                ? event.response
                : {},
            error: event.error || null,
            durationMs: event.durationMs || null,
          },
        }),
      }).catch(() => undefined);
    }
  };
  try {
    if (!siteId || !taskId)
      throw new Error("capability_v2_runner_environment_missing");
    if (process.env.CAPABILITY_V2_SKIP_REGISTER !== "1") {
      const registered = await api<{ runnerToken: string }>(
        `/api/internal/capability-v2/tasks/${taskId}/runner/register`,
        {
          method: "POST",
          body: JSON.stringify({
            siteId,
            runnerId,
            runtimeType: "Process",
            runtimeProvider: "Local",
            runtimeVersion: "2.0.0",
          }),
        },
      );
      process.env.CAPABILITY_V2_RUNNER_TOKEN = registered.runnerToken;
    }
    // Start heartbeats before fetching and validating the RunSpec. A startup
    // failure must remain observable instead of becoming a silent heartbeat
    // timeout in the control plane.
    heartbeat = setInterval(() => {
      void api(`/api/internal/capability-v2/tasks/${taskId}/runner/heartbeat`, {
        method: "POST",
        body: JSON.stringify({ runnerId, status: heartbeatStatus }),
      }).catch(() => undefined);
    }, 10_000);
    spec = await api<RunSpec>(
      `/api/internal/capability-v2/tasks/${taskId}/run-spec`,
    );
    validateSpecUrls(spec);
    assertValidationRunnerIsolation(spec);
    // Authentication happens in a non-recorded context so credentials and OTP
    // never enter a video artifact. The resulting storage state is copied into
    // the independently recorded work context and remains in Runner memory only.
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    await initializeBrowserContext(context, spec);
    page = await context.newPage();
    const browserEntryUrl =
      spec.browser.startUrl ||
      spec.plan.find((item) => item.program?.entry.url)?.program?.entry.url;
    if (
      browserEntryUrl &&
      spec.plan.some(
        (item) =>
          item.type === "Explore" ||
          item.program?.runtime === "BrowserJavaScriptStage",
      )
    ) {
      assertBrowserModuleUrlForPage(
        browserEntryUrl,
        resolveCapabilityModuleUrl(
          `/api/capability-v2/modules/${"0".repeat(64)}`,
          browserPublicEndpoint,
        ),
      );
    }
    await api(`/api/internal/capability-v2/tasks/${taskId}/events`, {
      method: "POST",
      body: JSON.stringify({
        runnerId,
        eventType: "PhaseChanged",
        phase: "Preflight",
        message: "RunSpec 与浏览器模块公共地址检查通过",
        payload: {},
      }),
    });
    await workspace.write("task/run-spec.json", spec);
    await workspace.write("context/runtime.json", {target:"browser-sdk",kernelVersion:"2",buildSha:process.env.SITEWAKE_BUILD_SHA || "development",taskId,runnerId});
    const helpers: PerformHelpers = {
      workspace,
      checkpoint: async () => {await captureWorkspace('authoring-completed');},
      loadAuthorCheckpoint: async () => (await api<{checkpoint:Awaited<ReturnType<typeof performC1Authoring>> | null}>(`/api/internal/capability-v2/tasks/${taskId}/author-checkpoint`)).checkpoint,
      persistModule: async (source) => {
        const saved = await api<{ module: CapabilityModuleRef }>(
          `/api/internal/capability-v2/tasks/${taskId}/modules`,
          { method: "POST", body: JSON.stringify({ runnerId, source }) },
        );
        return saved.module;
      },
      absoluteModuleUrl: (moduleUrl, contentHash) =>
        resolveCapabilityModuleUrl(
          moduleUrl,
          browserPublicEndpoint,
          contentHash,
        ),
      onEvent: async (phase, message, payload = {}) => {
        await workspace.event("pipeline.phase", {phase,message,payload});
        await api(`/api/internal/capability-v2/tasks/${taskId}/events`, {
          method: "POST",
          body: JSON.stringify({
            runnerId,
            eventType: "PhaseChanged",
            phase,
            message,
            payload,
          }),
        });
      },
      saveArtifact: uploadArtifact,
      loadCandidateValidationBundle: async () =>
        api<{
          artifact: CapabilityCandidateArtifact;
          evidence: CapabilityCaseDiscoveryEvidence;
        }>(`/api/internal/capability-v2/tasks/${taskId}/candidate-artifact`),
    };
    for (;;) {
      try {
        await bootstrapAuthentication(page!, spec, helpers.onEvent);
        break;
      } catch (error) {
        if (!(error instanceof MissingInputError)) throw error;
        recordTrace({
          at: new Date().toISOString(),
          stage: "runner-waiting-input",
          error: error.message,
        });
        spec = await awaitInput(error);
        validateSpecUrls(spec);
      }
    }
    const authenticatedState = await context!.storageState();
    await context!.close();
    context = await browser!.newContext({
      recordVideo: spec.browser.recording
        ? {
            dir:
              process.env.CAPABILITY_V2_ARTIFACT_DIR ||
              ".artifacts/capability-v2",
          }
        : undefined,
      storageState: authenticatedState,
    });
    await initializeBrowserContext(context, spec);
    page = await context.newPage();
    for (;;) {
      try {
        completed = await perform(page!, spec, recordTrace, helpers);
        break;
      } catch (error) {
        if (!(error instanceof MissingInputError)) throw error;
        recordTrace({
          at: new Date().toISOString(),
          stage: "runner-waiting-input",
          error: error.message,
        });
        spec = await awaitInput(error);
        validateSpecUrls(spec);
      }
    }
    recordTrace({ at: new Date().toISOString(), stage: "runner-success" });
    await helpers.onEvent("Completed", "Runner 已完成并准备提交任务结果");
    const mainVideo = page!.video();
    const artifactRefs = [
      await captureWorkspace("completed"),
      await captureScreenshot(page!),
      await captureTrace(trace),
      completed.candidateSource
        ? await uploadArtifact(
            "Source",
            "text/typescript",
            Buffer.from(completed.candidateSource, "utf8"),
          )
        : undefined,
      completed.candidateBundle
        ? await uploadArtifact(
            "Bundle",
            "text/javascript",
            Buffer.from(completed.candidateBundle, "utf8"),
          )
        : undefined,
      ...(completed.artifactRefs || []),
    ].filter((value): value is UploadedArtifact => Boolean(value));
    if (mainVideo) {
      await context?.close().catch(() => undefined);
      const videoPath = await mainVideo.path().catch(() => undefined);
      if (videoPath) {
        const uploadedVideo = await uploadArtifact(
          "Video",
          "video/webm",
          await readFile(videoPath),
        );
        if (uploadedVideo) artifactRefs.push(uploadedVideo);
      }
    }
    await api(`/api/internal/capability-v2/tasks/${taskId}/result`, {
      method: "PUT",
      body: JSON.stringify({
        runnerId,
        taskId,
        outcome: "Success",
        candidateProgram: completed.candidateProgram,
        candidateSource: completed.candidateSource,
        candidateSummary: completed.candidateSummary,
        demonstrationParameters: completed.demonstrationParameters,
        c1AuthoringOutput: completed.c1AuthoringOutput,
        c2CaseGenerationOutput: completed.c2CaseGenerationOutput,
        validationCaseCount: completed.validationCaseCount,
        validationResults: completed.validationResults,
        stageReceipts: completed.stageReceipts,
        targetEvidence: completed.targetEvidence,
        promptProvenance: completed.promptProvenance,
        output: completed.output,
        artifactRefs,
        completedAt: new Date().toISOString(),
      }),
    });
  } catch (error) {
    const evaluation = error instanceof EvaluationError;
    const rawMessage = error instanceof Error ? error.message : String(error);
    const pageSummary = page
      ? await page
          .evaluate(
            () =>
              ({
                url: location.href,
                title: document.title,
                heading:
                  document.querySelector("h1,[role=heading]")?.textContent ||
                  "",
                text: document.body?.innerText || "",
              }) satisfies RunnerPageSummary,
          )
          .catch(() => undefined)
      : undefined;
    const diagnostic = evaluation
      ? {
          code: error.code.toLowerCase(),
          message: rawMessage,
          retryable: false,
        }
      : diagnoseRunnerFailure(error, pageSummary);
    recordTrace({
      at: new Date().toISOString(),
      stage: "runner-failure",
      error: rawMessage,
      response: diagnostic,
    });
    await api(`/api/internal/capability-v2/tasks/${taskId}/events`, {
      method: "POST",
      body: JSON.stringify({
        runnerId,
        eventType: "RunnerFailed",
        phase: "Failed",
        message: diagnostic.message,
        payload: { errorCode: diagnostic.code, rawError: rawMessage },
      }),
    }).catch(() => undefined);
    const mainVideo = page?.video();
    const artifactRefs = [
      await captureWorkspace("failed", rawMessage, false).catch(() => undefined),
      page ? await captureScreenshot(page) : undefined,
      await captureTrace(trace),
    ].filter((value): value is UploadedArtifact => Boolean(value));
    if (mainVideo) {
      await context?.close().catch(() => undefined);
      const videoPath = await mainVideo.path().catch(() => undefined);
      if (videoPath) {
        const uploadedVideo = await uploadArtifact(
          "Video",
          "video/webm",
          await readFile(videoPath),
        );
        if (uploadedVideo) artifactRefs.push(uploadedVideo);
      }
    }
    const caseGenerationFailure = /^case_generation_failed:/u.test(rawMessage);
    await api(`/api/internal/capability-v2/tasks/${taskId}/result`, {
      method: "PUT",
      body: JSON.stringify({
        runnerId,
        taskId,
        outcome: evaluation ? error.code : "ExecutionFailure",
        error: diagnostic,
        ...(caseGenerationFailure
          ? {
              buildResult: {
                outcome: "Failed",
                stage: "CaseGeneration",
                code: rawMessage.split(":", 2)[1] || "case_generation_failed",
                reason: rawMessage,
              },
            }
          : {}),
        artifactRefs,
        completedAt: new Date().toISOString(),
      }),
    }).catch(() => undefined);
    process.exitCode = 1;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await api(`/api/internal/capability-v2/tasks/${taskId}/runner/terminated`, {
      method: "POST",
      body: JSON.stringify({ runnerId }),
    }).catch(() => undefined);
  }
}

if (process.argv[1] && process.argv[1].endsWith("process-runner.ts"))
  void run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

export { perform, validateSpecUrls };
