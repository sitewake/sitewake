import { resolveCapabilityInput, resolveCapabilityRun } from "../../lib/capability-center-v2/run-resolution";
import { runCandidateInVisitorHost } from "./visitor-host-check";
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
  CapabilityDslProgram,
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
  contractInProgramWritings,
  pinContractToBase,
  validateContractInput,
  type CapabilityExplorationTraceEvent,
} from "./browser-runtime";
import { traceFromExperience } from "./recording-trace";
import { harvestStartPage, type CapabilityCaseDiscoverySnapshot } from "./case-discovery";
import { contractFromDemonstration } from "./contract-from-demonstration";
import { addressOpenedInputs, authorJavaScriptCapability, type AuthoringRepair } from "./javascript-author";
import { bootstrapAuthentication } from "./auth-bootstrap";
import {
  projectStageReceipts,
  runCapabilityJavaScriptStages,
  type JavaScriptStageReceipt,
  isJavaScriptModuleLoadFailure,
} from "./javascript-stage-runner";
import { inspectCapabilityQuality, withDefaultOmissionExamples } from "../../lib/capability-center-v2/quality";
import {
  compareCapabilityExpectedOutput,
  describeExpectedOutputDrift,
  outputsConstantAcrossCases,
} from "../../lib/capability-center-v2/expected-output";
import {
  diagnoseRunnerFailure,
  type RunnerPageSummary,
} from "./failure-diagnostics";
import {
  assertBrowserModuleUrlForPage,
  capabilityV2RuntimeEndpoints,
  resolveCapabilityModuleUrl,
} from "./module-delivery";
import { projectCapabilityContract } from "../../lib/capability-center-v2/semantic-analyzer";
import { runCapabilityCaseGeneration } from "./case-generation";
import {
  capabilityCandidateHash,
  offeredInputPaths,
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
    message: `runtime_input_required:${error.key}`,
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

/**
 * What the replay did not reproduce of a case's prediction.
 *
 * A prediction never decides whether a case passed. What does is the run
 * itself: the program reached a terminal outcome, its output satisfied the
 * contract's outputSchema, the contract's success conditions held on the page,
 * and cases meant to differ did not all come back the same. The differences
 * are recorded for the review turn, which is where a judgement about what they
 * mean belongs.
 */
function expectedOutputDrift(
  actual: JsonObject,
  expected: JsonObject,
  input: JsonObject,
) {
  return compareCapabilityExpectedOutput({ expected, actual, input }).drift;
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
    /** Set when the capability answered that this input has nothing to show. */
    noResultReason?: string;
    failureReason?: string;
  }> = [];
  const stageReceipts: JavaScriptStageReceipt[] = [];
  const targetEvidence: CapabilityStageEvidence[] = [];
  const artifactRefs: UploadedArtifact[] = [];
  const caseStartUrl = () => {
    const explored = spec.browser.startUrl || spec.input.context.startUrl;
    // A caller of a site-wide capability may be anywhere; validation stands
    // in for one at the site's root. The Contract's resolution then decides
    // whether the run stays there or goes to the page it is bound to, ahead
    // of whatever entry the program was published with.
    const callerPage = candidate.contract.scope?.kind === "site-global"
      ? (() => { try { return new URL(explored!).origin + "/"; } catch { return explored; } })()
      : explored;
    const run = resolveCapabilityRun(candidate.contract, { currentUrl: callerPage, input: {} });
    if (run.entry?.mode === "Navigate") return run.entry.url;
    return candidate.program.entry.mode === "Navigate" ? candidate.program.entry.url : callerPage;
  };
  for (const testCase of candidate.cases) {
    const isolated = await isolatedValidationPage(
      page,
      spec,
      baselineStorageState,
    );
    // Resolved before the attempt so a case that throws is still recorded
    // under the input the frozen suite says it ran with.
    const caseInput: import("../../lib/capability-center-v2/model").CapabilityTaskInput =
      {
        ...spec.input,
        parameters: resolveCapabilityInput(candidate.contract, testCase.input).declared,
      };
    try {
      validateContractInput(candidate.contract, caseInput);
      // CandidateValidation's physical transport projection intentionally keeps
      // the candidate browser envelope small.  The discovery start page still
      // travels in the logical task input context, so C3 must use it when the
      // published entry policy is CurrentPage.  Otherwise the fresh page stays
      // at about:blank (opaque origin) and every module import fails before the
      // deterministic replay even starts.
      // A capability validates the promise it makes. A site-global one says it
      // can be called from anywhere on the site, so it is replayed from the
      // site's own entry — not from the page the exploration happened to end
      // on. Starting there hid the requirement to navigate: the by-date
      // archive capability was replayed on the very day page it had been built
      // from, read it without moving, passed, and then could do nothing when a
      // person asked for another day from the home page.
      const startUrl = caseStartUrl();
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
      // An input the site has no data for is answered correctly by saying so.
      // A capability that works was refused for it: 「那一天没有榜单」 and 「这个
      // 关键词搜不到条目」 are the capability working, not the program failing.
      // The case is recorded with what it said, and the review turn reads it.
      // A capability that never worked for any input is still refused, below.
      // Except for a value the site lists beside the demonstrated one: the
      // category list says Mystery is a category, so a count that finds no
      // category for it has not answered, it has failed — and used to be
      // published on the demonstration alone, to answer every other category
      // with the demonstrated page.
      const offered = replayed.outcome === "NoResult"
        ? offeredInputPaths(caseInput.parameters, parsedEvidence.value.regions)
        : [];
      if (replayed.outcome === "NoResult" && !offered.length) {
        validationResults.push({
          caseId: testCase.caseId,
          resolvedInput: caseInput.parameters,
          output: replayed.output || {},
          stageReceipts: projectStageReceipts(replayed.receipts, []),
          evidenceRefs: [],
          noResultReason: replayed.reason || "no_result",
        });
        await helpers.onEvent(
          "Validating",
          "validation case returned no result",
          { caseId: testCase.caseId, ai: false, noResult: true, reason: replayed.reason || "no_result" },
        );
        continue;
      }
      // One case is one input, not the capability. A rank whose detail page
      // shows the topic's own best position instead of the one that was asked
      // for fails its success condition — and it used to end the replay, throw
      // away the two cases that had already passed, and leave the capability
      // unpublishable. The case is recorded with what went wrong, the replay
      // goes on, and the review turn reads all of them together.
      const recordFailure = async (reason: string) => {
        validationResults.push({
          caseId: testCase.caseId,
          resolvedInput: caseInput.parameters,
          output: replayed.output || {},
          stageReceipts: projectStageReceipts(replayed.receipts, []),
          evidenceRefs: [],
          failureReason: reason,
        });
        await helpers.onEvent(
          "Validating",
          "validation case failed",
          { caseId: testCase.caseId, ai: false, failed: true, reason },
        );
      };
      if (replayed.outcome === "NoResult") {
        const path = offered[0];
        await recordFailure(`no_result_for_offered_input:${path}=${JSON.stringify(caseInput.parameters[path])}:${replayed.reason || "no_result"}`);
        continue;
      }
      if (replayed.outcome !== "Success") {
        await recordFailure(replayed.reason || replayed.outcome);
        continue;
      }
      try {
        await evaluateResultDeterministic(
          isolated.page,
          candidate.contract,
          replayed.output,
          caseInput,
          replayed.observedText,
        );
      } catch (error) {
        await recordFailure(error instanceof Error ? error.message : String(error));
        continue;
      }
      const outputDrift = expectedOutputDrift(
        replayed.output,
        testCase.expected,
        caseInput.parameters,
      );
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
        ...(outputDrift.length ? { outputDrift } : {}),
      });
      await helpers.onEvent(
        "Validating",
        "validation case passed",
        { caseId: testCase.caseId, ai: false, ...(outputDrift.length ? { outputDrift, outputDriftSummary: describeExpectedOutputDrift(outputDrift) } : {}) },
      );
    } catch (error) {
      // The module itself being unloadable is not one case's problem: every
      // case would fail the same way and there is nothing to record.
      if (isJavaScriptModuleLoadFailure(error)) throw error;
      // Anything else this one input did is this one input's. A replay that
      // ran out of its budget used to end the whole validation, and the two
      // cases that had already passed went with it: 查询微博历史热搜 was
      // refused because its third case searched for 「如何按日期查看微博热
      // 搜」 — a question lifted off the page, not a term anyone searches —
      // and waited out three minutes for results that were never coming.
      const reason = error instanceof Error ? error.message : String(error);
      validationResults.push({
        caseId: testCase.caseId,
        resolvedInput: caseInput.parameters,
        output: {},
        stageReceipts: [],
        evidenceRefs: [],
        failureReason: reason,
      });
      await helpers.onEvent(
        "Validating",
        "validation case failed",
        { caseId: testCase.caseId, ai: false, failed: true, reason },
      );
    } finally {
      await isolated.context.close().catch(() => undefined);
    }
  }
  // A capability has to work for something. What is published is a program the
  // authoring turn wrote, not the path the agent walked, so it has to have been
  // run: every case saying "no data" or "did not work" is a program that never
  // produced a result, whatever the reason each gave. This is the only thing
  // the replay refuses for; what the outputs were worth is the review's.
  const answered = validationResults.filter((result) => !result.noResultReason && !result.failureReason);
  if (!answered.length) {
    const first = validationResults[0];
    throw new EvaluationError(
      "NoResult",
      `validation_no_case_produced_a_result:${first?.noResultReason || first?.failureReason || "no_result"}`,
    );
  }
  // The replay above is this runner's host; visitors run the program in the
  // widget. The first input that succeeded here must succeed there too, or the
  // capability would be published to hang, loop or fail for the people it is
  // for. Same program, same input, two hosts disagreeing is a defect either
  // way, and it is not published until they agree.
  const accepted = answered[0];
  const visitorPage = await isolatedValidationPage(page, spec, baselineStorageState);
  try {
    const check = await runCandidateInVisitorHost({
      page: visitorPage.page,
      startUrl: caseStartUrl(),
      candidate: {
        name: spec.input.candidateSummary?.name || spec.goal || "candidate",
        description: spec.input.candidateSummary?.description,
        contract: candidate.contract,
        program: candidate.program,
      },
      input: accepted.resolvedInput,
      timeoutMs: Math.min(240_000, (candidate.program.controlFlow?.totalTimeoutMs || 120_000) + 30_000),
    });
    if (check.outcome === "Skipped") {
      await helpers.onEvent("Validating", "visitor check skipped", { caseId: accepted.caseId, reason: check.reason, ai: false });
    } else if (check.outcome === "Agreed") {
      await helpers.onEvent("Validating", "visitor check passed", { caseId: accepted.caseId, url: check.result.url, ai: false });
    } else {
      await helpers.onEvent("Validating", "visitor check failed", { caseId: accepted.caseId, reason: check.reason, ...(check.widgetStatus ? { widgetStatus: check.widgetStatus } : {}), ai: false });
      throw new EvaluationError("NoResult", `validation_visitor_host_diverged:${accepted.caseId}:${check.reason}`);
    }
  } finally {
    await visitorPage.context.close().catch(() => undefined);
  }
  // The cases that did answer, read together, can still show that the program
  // never looked at the item: two inputs the expectations say should differ,
  // one answer for both.
  const answeredIds = new Set(answered.map((result) => result.caseId));
  const constant = outputsConstantAcrossCases(
    candidate.cases.filter((testCase) => answeredIds.has(testCase.caseId)).map((testCase) => ({ expected: testCase.expected })),
    answered.map((result) => result.output),
  );
  // Worth saying, not worth refusing over. A live board changes between the
  // demonstration and the replay, a term genuinely has one answer, and a field
  // that repeats is sometimes just a field that repeats. The review turn is
  // told which field it was and what every case returned, and decides.
  if (constant.length) {
    await helpers.onEvent(
      "Validating",
      "every case returned the same value",
      { constantOutputs: constant, field: constant[0], value: answered[0]?.output?.[constant[0]] ?? null, ai: false },
    );
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

/** What exploration found, kept so a rerun can author again without exploring again. */
/** What authoring starts from: the recording as a trace, the Contract the demonstration states, the inputs it ran with. */
export type C1Exploration = {
  program: CapabilityDslProgram;
  candidateSummary: { name: string; description: string; aliases: string[]; contract: CapabilityContract };
  demonstrationParameters: Record<string, JsonValue>;
  groundingExamples: Array<Record<string, JsonValue>>;
  promptProvenance: CapabilityPromptProvenance[];
};

/**
 * The rejection a generation was rerun to answer, as the coordinator wrote it
 * into the task's context: the verdict's reason and the case it named.
 */
function repairOf(spec: { input: { context: Record<string, JsonValue | undefined> } }): AuthoringRepair | undefined {
  const raw = spec.input.context.repair;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as JsonObject;
  if (typeof record.reason !== "string") return undefined;
  const input = record.input && typeof record.input === "object" && !Array.isArray(record.input) ? record.input as Record<string, JsonValue> : undefined;
  return {
    reason: record.reason,
    ...(typeof record.caseId === "string" ? { caseId: record.caseId } : {}),
    ...(typeof record.failure === "string" ? { failure: record.failure } : {}),
    ...(input ? { input } : {}),
  };
}

export async function performC1Authoring(
  page: Page,
  spec: RunSpec,
  observer: ((event: CapabilityExplorationTraceEvent) => void) | undefined,
  helpers: PerformHelpers,
  baselineStorageState?: Awaited<ReturnType<BrowserContext["storageState"]>>,
  /** A prior run's exploration and the source it authored; the source becomes the first draft. */
  resume?: { exploration: C1Exploration; source: string },
) {
  const authoringBaselineStorageState =
    baselineStorageState || (await page.context().storageState());
  if (!spec.browser.startUrl) throw new Error("exploration_start_url_required");
  let startPageSnapshot: CapabilityCaseDiscoverySnapshot | undefined;
  // The visitor's recording is the trace, and the Contract is what the
  // demonstration states; no agent walks the path again to find out what
  // the recording already holds, and no model writes a page's wording into
  // a condition. A rerun starts from the trace its first run took.
  const fromRecording = async (): Promise<C1Exploration> => {
    const experience = spec.input.experience;
    if (!experience) throw Object.assign(new Error("capability_recording_required"), { code: "capability_recording_required" });
    const parameters = spec.input.parameters;
    const { program, dropped } = traceFromExperience(experience, parameters);
    await helpers.onEvent("Specification", "trace taken from the recording", {
      steps: program.steps.map((step) => step.action),
      ...(dropped.length ? { dropped: dropped.map((item) => `${item.reason}: ${item.action} ${item.name}`.trim()) } : {}),
    });
    if (!program.steps.length) throw Object.assign(new Error("capability_recording_without_actions"), { code: "capability_recording_without_actions" });
    const goal = spec.goal || experience.originalGoal;
    const base = spec.input.trigger?.baseVersionId ? spec.input.candidateSummary?.contract : undefined;
    const contract = pinContractToBase(contractFromDemonstration({ goal, parameters, experience, trace: program }), base);
    const named = spec.input.candidateSummary;
    return {
      program,
      candidateSummary: {
        name: named?.name || experience.originalGoal.slice(0, 80),
        description: named?.description || experience.originalGoal,
        aliases: named?.aliases || [],
        contract,
      },
      demonstrationParameters: parameters,
      groundingExamples: [],
      promptProvenance: [],
    };
  };
  const explored = resume?.exploration || await fromRecording();
  // The contract states each input in the writing the program consumes: the
  // address writing only where the program opens the page by its address.
  // Where the program starts: the recorded start page, unless the trace
  // starts elsewhere — the home page, when the run began on the page an
  // input chooses. Authoring, the harvest and the cases start there too.
  const startUrl = explored.program.entry.mode === "Navigate" && explored.program.entry.url ? explored.program.entry.url : spec.browser.startUrl;
  const explorationContract = explored.candidateSummary.contract;
  const summary = {
    ...explored.candidateSummary,
    contract: contractInProgramWritings(
      explorationContract,
      addressOpenedInputs(explored.program, explorationContract, {
        startUrl,
        demonstrationParameters: resolveCapabilityInput(explorationContract, explored.demonstrationParameters).declared,
      }),
      explored.demonstrationParameters,
    ),
  };
  // The start page, read once: the lists the demonstrated values were chosen
  // from give the authoring loop the sibling values to replay on, and case
  // generation the page it would otherwise browse for again.
  const harvestPage = await isolatedValidationPage(page, spec, authoringBaselineStorageState);
  let harvested: Awaited<ReturnType<typeof harvestStartPage>> | undefined;
  try {
    await harvestPage.page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await harvestPage.page.waitForTimeout(200);
    harvested = await harvestStartPage(harvestPage.page, { generationTaskId: spec.taskId, siteId: spec.siteId, parameters: explored.demonstrationParameters });
  } catch (error) {
    await helpers.onEvent("Specification", "start page could not be harvested; authoring proves the demonstration alone", { reason: error instanceof Error ? error.message.slice(0, 200) : String(error) });
  } finally {
    await harvestPage.context.close().catch(() => undefined);
  }
  const siblingExamples = Object.entries(harvested?.siblings || {})
    .flatMap(([path, values]) => values.slice(0, 2).map((value) => ({ [path]: value })));
  if (harvested) {
    await helpers.onEvent("Specification", "start page harvested", {
      lists: harvested.snapshot.regions.filter((region) => region.kind === "choice-list").length,
      regions: harvested.snapshot.regions.length,
      siblings: Object.fromEntries(Object.entries(harvested.siblings).map(([path, values]) => [path, values.slice(0, 6)])),
    });
  }
  startPageSnapshot = harvested?.snapshot;
  // A generation rerun as the one repair after a rejection carries the case
  // the verdict named; that case is replayed first, ahead of the siblings.
  const repair = repairOf(spec);
  const groundingExamples = withDefaultOmissionExamples(summary.contract, [...(repair?.input ? [repair.input] : []), ...siblingExamples, ...explored.groundingExamples]);
  const authored = await authorJavaScriptCapability({
    explorationPage: page,
    workspace: helpers.workspace,
    startUrl,
    goal: spec.goal || "完成用户目标",
    input: { ...spec.input, parameters: explored.demonstrationParameters },
    contract: summary.contract,
    explorationProgram: explored.program,
    groundingExamples,
    discoveryRegions: harvested?.snapshot.regions,
    startingSource: resume?.source,
    repair,
    summary,
    explorationPromptProvenance: explored.promptProvenance,
    createDraftContext: () =>
      isolatedValidationPage(page, spec, authoringBaselineStorageState),
    persistModule: helpers.persistModule,
    absoluteModuleUrl: helpers.absoluteModuleUrl,
    onEvent: (event) =>
      helpers.onEvent(event.phase, event.message, event.payload),
  });
  const draftQuality = inspectCapabilityQuality(
    authored.contract,
    authored.program,
    {
      demonstrationParameters: explored.demonstrationParameters,
      validationCases: groundingExamples,
      source: authored.bundle,
      summary,
      entryUrl: startUrl,
    },
  );
  await helpers.onEvent(
    "Quality",
    draftQuality.valid ? "quality gate passed" : "quality gate rejected the candidate",
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
    // Every rule this gate applies ran already: on the Contract and summary
    // before the loop, on the program inside it. A refusal here means a rule
    // ran late — a defect in the pipeline's gate ordering, not in the
    // capability — and is named as such so it is never read as the model's
    // failure. It is retryable: the same run under a fixed pipeline passes.
    const details = draftQuality.issues
      .map((issue) => `${issue.code}${issue.path ? `@${issue.path}` : ""}`)
      .join(",");
    await helpers.onEvent("Quality", "pipeline gate ordering bug: a quality rule first fired after the authoring loop", {
      issues: draftQuality.issues.map((issue) => ({ code: issue.code, message: issue.message, ...(issue.path ? { path: issue.path } : {}) })),
    });
    throw Object.assign(
      new Error(`pipeline_gate_ordering_bug:${details}`),
      { code: "pipeline_gate_ordering_bug", retryable: true },
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
    ...summary,
    contract: projectCapabilityContract(authored.contract),
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
    exploration: {
      program: explored.program,
      candidateSummary: { ...explored.candidateSummary, contract: authored.contract },
      demonstrationParameters: explored.demonstrationParameters,
      groundingExamples: explored.groundingExamples,
      promptProvenance: explored.promptProvenance,
    } satisfies C1Exploration,
    stageReceipts: authored.draft.receipts,
    targetEvidence: authored.draft.evidence,
    promptProvenance: authored.program.promptProvenance,
    artifactRefs: [],
    // The start page as read before authoring, for case generation to read instead of browsing again.
    startPageSnapshot,
    startUrl,
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
    // A checkpoint holds the source that passed its self-test when it was
    // written, under the checks of that day. Trusting it skipped every check
    // added since — the static gates were re-applied here, but the checks that
    // have to run the program (grounding replays, a count read against its
    // list across runs) live inside the authoring loop, and a rerun never
    // reached them: "Find floor lamps" was rerun after the count check shipped
    // and came back with the same catalog-wide count. So the restored source
    // does not skip the loop; it is the loop's first draft. It runs through
    // every check before any model call, costs nothing more when it passes,
    // and is repaired from the failure when it does not. A checkpoint without
    // its exploration cannot be checked that way and is explored again.
    const restored = await helpers.loadAuthorCheckpoint?.();
    const resume = restored?.exploration && restored.candidateSource
      ? { exploration: restored.exploration, source: restored.candidateSource }
      : undefined;
    if (restored && !resume) {
      await helpers.onEvent("AuthoringRestoreRejected", "checkpoint holds no exploration to recheck it against; exploring again");
    }
    if (resume) await helpers.onEvent("AuthoringRestored", "prior source restored; rechecking it as the first draft");
    const authored = await performC1Authoring(page, spec, observer, helpers, baselineStorageState, resume);
    await helpers.workspace?.write('reports/c1-checkpoint.json',{authored});
    await helpers.checkpoint?.();
    await helpers.onEvent(
      "CaseGeneration",
      "authoring complete; generating test cases",
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
        // The witness for every input's shape; C2 derives its cases from
        // what the site shows, in that shape.
        ...(authored.demonstrationParameters
          ? { demonstrationParameters: authored.demonstrationParameters }
          : {}),
        browser: {
          baseUrl: new URL(authored.startUrl || spec.browser.startUrl).origin,
          startUrl: authored.startUrl || spec.browser.startUrl,
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
        snapshot: authored.startPageSnapshot,
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
      "test cases generated and checked",
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
    "replaying validation cases",
    { caseCount: cases.length },
  );
  let output: JsonObject = {};
  const stageReceipts: JavaScriptStageReceipt[] = [];
  const targetEvidence: CapabilityStageEvidence[] = [];
  const artifactRefs: UploadedArtifact[] = [];
  for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
    const validationCase = cases[caseIndex];
    await helpers?.onEvent("Validating", "replaying a validation case", {
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
      parameters: resolveCapabilityInput(spec.contract, validationCase).declared,
    };
    try {
      validateContractInput(spec.contract, caseInput);
      const explored = spec.browser.startUrl || spec.input.context.startUrl;
      const boundEntry = resolveCapabilityRun(spec.contract, { currentUrl: explored, input: {} }).entry;
      const startUrl =
        (boundEntry?.mode === "Navigate" ? boundEntry.url : undefined)
        || (replay.entry.mode === "Navigate" ? replay.entry.url : explored);
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
      await helpers?.onEvent("Validating", "validation case passed", {
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
        message: "run spec and module address checked",
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
    await helpers.onEvent("Completed", "runner finished; submitting the result");
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
        message: "runner failed",
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
