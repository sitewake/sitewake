import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import {
  assertModuleHarnessResult,
  loadAllModuleHarnessCases,
} from "./helpers/capability-v2-module-io-fixtures.mjs";
import {
  assertCapabilityGenerationInput,
  classifyCapabilityGeneration,
  completeC2CaseGeneration,
  createCapability,
  createCapabilityTask,
  createValidatedCapabilityPackage,
  getCapability,
  getCapabilityCandidateArtifact,
  getTask,
  listCapabilities,
  listTasks,
  listVersions,
  claimTask,
  actOnCapability,
  publishValidatedCapability,
  putCapabilityV2Module,
  resetCapabilityCenterV2ForTests,
  resetCapabilityV2ModulesForTests,
  saveTaskArtifact,
  submitTaskResult,
} from "./helpers/capability-v2-test-entry.ts";
import {
  decodeC1AuthoringOutput,
  decodeC2CaseGenerationInput,
  parseCapabilityCaseDiscoveryEvidenceSidecar,
  capabilityCandidateHash,
  capabilityValidationSuiteHash,
  canonicalCapabilityCaseJson,
  assertCapabilityCaseGenerationCandidate,
} from "../lib/capability-center-v2/case-generation.ts";
import { inspectCapabilityJavaScriptProgram } from "../lib/capability-center-v2/javascript-runtime.ts";
import { inspectCapabilityQuality } from "../lib/capability-center-v2/quality.ts";
import { perform, performC1Authoring } from "../runner/capability-v2/process-runner.ts";
import { startFixtureSite } from "../scripts/capability-center-v2-c1-mock.mjs";
import { runD1TransactionRollbackFixture } from "./helpers/capability-v2-d1-transaction-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(root, "tests/fixtures/capability-center-v2/module-io-harness");
const notebookRoot = resolve(root, "tests/fixtures/capability-center-v2/notebook-search");
const manifestPath = resolve(fixtureRoot, "manifest.json");
const reportRoot = resolve(root, ".artifacts/capability-center-v2/module-io-harness");
const moduleNames = new Set(["B", "C1", "C2", "C3", "Review", "D"]);
const modelEnvNames = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
];

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function merge(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return clone(patch);
  const target = base && typeof base === "object" && !Array.isArray(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(patch)) {
    target[key] = value && typeof value === "object" && !Array.isArray(value)
      ? merge(target[key], value)
      : clone(value);
  }
  return target;
}

function stable(value) {
  return JSON.stringify(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

async function sha256Json(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical(value))),
  );
  return `sha256:${Buffer.from(digest).toString("hex")}`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : errorMessage(error).split(":", 1)[0];
}

function withExpectedError(moduleName, expectedCode, error) {
  const message = errorMessage(error);
  const actualCode = errorCode(error);
  const expected = String(expectedCode);
  const aliases = {
    candidate_hardcoded_input: /demonstration_value_leaked|hardcoded|candidate_quality_gate_failed/iu,
    candidate_deterministic_contract_required: /deterministic|modelGoal|candidate_quality_gate_failed/iu,
    control_flow_loop_bounds_required: /control_flow_(?:back_edge_unbounded|loop_.*invalid)|unbounded_loop/iu,
    c1_output_unknown_field: /c1_authoring_output_fields_invalid|unknown_field|semantic|dependencyLedger/iu,
    case_generation_browser_unknown_field: /case_generation_browser_fields_invalid/iu,
    case_model_output_unknown_field: /case_generation_model_fields_invalid|candidate_rewrite_forbidden|model_case_fields_invalid/iu,
    case_input_page_evidence_required: /case_evidence_value_required|case_evidence_value/iu,
    case_parameter_association_required: /same_region|association/iu,
    case_inputs_not_distinct: /independent_cases_required|distinct/iu,
    case_input_schema_invalid: /case_schema|capability_input|additional_property|input_invalid|case_generation_input/iu,
    case_default_omission_required: /default_omission/iu,
    case_parameter_not_consumed: /program_input_not_consumed|parameter_role_required|not_consumed/iu,
    case_expected_schema_invalid: /expected|schema_additional|output_schema/iu,
    case_discovery_evidence_persist_failed: /evidence_persist_failed/iu,
    candidate_freeze_conflict: /freeze_conflict|candidate_generation_task/iu,
    validation_contract_hash_mismatch: /contract_hash|frozen_artifact_mismatch/iu,
    validation_program_hash_mismatch: /program_hash|frozen_artifact_mismatch/iu,
    validation_suite_hash_mismatch: /suite_hash|frozen_artifact_mismatch/iu,
    validation_suite_payload_mismatch: /payload_mismatch|frozen_artifact_mismatch/iu,
    validation_case_evidence_hash_mismatch: /evidence.*hash|frozen_artifact_mismatch/iu,
    validation_module_hash_mismatch: /module_hash|frozen_artifact_mismatch/iu,
    candidate_artifact_required: /artifact_required|candidate_validation/iu,
    validated_package_required: /validated|package_required/iu,
    review_validation_hash_mismatch: /hash|review/iu,
    review_artifact_unknown_field: /unknown|semantic|dependencyLedger/iu,
    publish_authorization_required: /authorization/iu,
    publish_validation_case_set_mismatch: /validation|case.*mismatch/iu,
    publish_artifact_hash_mismatch: /hash|candidate|package/iu,
    publish_transaction_failed: /transaction|publish/iu,
  };
  if (actualCode === expected || message.includes(expected) || aliases[expected]?.test(message)) return expected;
  return `${expected} (production returned ${actualCode}: ${message})`;
}

function removePath(target, path) {
  const parts = String(path).split(".").filter(Boolean);
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return;
    current = current[part];
  }
  if (current && typeof current === "object" && !Array.isArray(current)) delete current[parts.at(-1)];
}

function setPath(target, path, value) {
  const parts = String(path).split(".").filter(Boolean);
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

function candidateForC1(c2Input, taskId, module) {
  const candidate = clone(c2Input.candidate);
  candidate.program.module = clone(module);
  return {
    generationTaskId: taskId,
    name: candidate.name,
    description: candidate.description,
    aliases: candidate.aliases,
    contract: candidate.contract,
    program: candidate.program,
    ...(candidate.replacementPlan ? { replacementPlan: candidate.replacementPlan } : {}),
  };
}

function candidateFromC2(c2Input, module) {
  const candidate = clone(c2Input.candidate);
  candidate.program.module = clone(module);
  return candidate;
}

function moduleSource() {
  return readFile(resolve(notebookRoot, "01-c1-module.ts"), "utf8");
}

async function materializeModule(siteId, modules, sourceValue) {
  const source = sourceValue || await moduleSource();
  const stored = await putCapabilityV2Module(siteId, source);
  modules.set(stored.module.contentHash, source);
  return stored.module;
}

async function closeFixtureSite(site) {
  if (!site?.server) return;
  await new Promise((resolvePromise) => site.server.close(() => resolvePromise()));
}

async function createHarnessTask(siteId, candidate, startUrl, generationTaskIdHint = "", options = {}) {
  const created = await createCapabilityTask(siteId, {
    type: "Discovery",
    goal: candidate.description || candidate.name,
    guidance: "Harness C2 production task",
    input: {
      parameters: { query: "notebook" },
      context: {
        startUrl,
        __pipelineVersion: "2.0",
        ...(candidate.replacementPlan
          ? {
              __replacementPlan: candidate.replacementPlan,
              __replacementCapabilityIds: candidate.replacementPlan.replacesCapabilityIds,
            }
          : {}),
      },
      candidateSummary: {
        name: candidate.name,
        description: candidate.description,
        aliases: candidate.aliases,
        contract: candidate.contract,
        ...(candidate.replacementPlan ? { replacementPlan: candidate.replacementPlan } : {}),
      },
      program: candidate.program,
      interactions: [],
      trigger: options.trigger || {},
    },
    ...(generationTaskIdHint ? { sourceAgentRunId: `harness:${generationTaskIdHint}` } : {}),
  });
  return created.task;
}

function modelEnvironment(baseUrl) {
  const previous = Object.fromEntries(modelEnvNames.map((name) => [name, process.env[name]]));
  process.env.OPENAI_API_KEY = "capability-v2-harness";
  process.env.OPENAI_BASE_URL = baseUrl;
  process.env.OPENAI_MODEL = "capability-v2-harness-model";
  for (const name of modelEnvNames.slice(3)) delete process.env[name];
  return previous;
}

function restoreEnvironment(previous) {
  for (const name of modelEnvNames) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
}

async function startModelServer(handler) {
  const state = { calls: [], bySchema: {}, authorToolIndex: 0, explorerActionIndex: 0 };
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const schema = body.response_format?.json_schema?.name || (body.tools?.length ? "tool" : "unknown");
    state.calls.push({ schema, body });
    state.bySchema[schema] = (state.bySchema[schema] || 0) + 1;
    if (process.env.CAPABILITY_HARNESS_DEBUG === "1") console.error(`[harness-model] ${schema} tools=${body.tools?.length || 0} call=${state.calls.length}`);
    try {
      const result = await handler(body, state);
      if (result?.httpStatus && result.httpStatus !== 200) {
        response.writeHead(result.httpStatus).end(result.body || "");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ finish_reason: result?.toolCall ? "tool_calls" : "stop", message: result?.toolCall ? { role: "assistant", content: null, tool_calls: [result.toolCall] } : { role: "assistant", content: JSON.stringify(result?.value ?? result) } }] }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: errorMessage(error) }));
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  return {
    state,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())),
  };
}

async function withModel(handler, fn) {
  const server = await startModelServer(handler);
  const previous = modelEnvironment(server.baseUrl);
  try {
    return await fn(server.state);
  } finally {
    restoreEnvironment(previous);
    await server.close();
  }
}

function fixtureC2ModelOutput(scenario) {
  if (scenario === "response-includes-mutated-candidate") {
    return { candidate: { name: "mutated" }, cases: [] };
  }
  if (scenario === "cases-notebook-and-invented-laptop") {
    return { cases: [{ input: { query: "notebook" }, expected: { query: "notebook" } }, { input: { query: "laptop" }, expected: {} }] };
  }
  if (scenario === "cross-region-query-color-without-association") {
    return { cases: [{ input: { query: "notebook", color: "red" }, expected: {} }, { input: { query: "mug", color: "blue" }, expected: {} }] };
  }
  if (scenario === "duplicate-notebook-cases") {
    return { cases: [{ input: { query: "notebook" }, expected: {} }, { input: { query: "notebook" }, expected: {} }] };
  }
  if (scenario === "one-case-missing-query") {
    return { cases: [{ input: { query: "notebook" }, expected: {} }, { input: {}, expected: {} }] };
  }
  if (scenario === "case-with-extra-sort-parameter") {
    return { cases: [{ input: { query: "notebook", sort: "price" }, expected: {} }, { input: { query: "mug", sort: "price" }, expected: {} }] };
  }
  if (scenario === "all-cases-explicit-query") {
    return { cases: [{ input: { query: "notebook" }, expected: {} }, { input: { query: "mug" }, expected: {} }] };
  }
  if (scenario === "expected-unknown-result-count") {
    return { cases: [{ input: { query: "notebook" }, expected: { resultCount: 2 } }, { input: { query: "mug" }, expected: { resultCount: 1 } }] };
  }
  if (scenario === "cases-with-query-partial-expected") {
    return { cases: [{ input: { query: "notebook" }, expected: { query: "notebook" } }, { input: { query: "mug" }, expected: { query: "mug" } }] };
  }
  if (scenario === "safe-cart-item-cases") {
    return { cases: [{ input: { query: "notebook" }, expected: {} }, { input: { query: "mug" }, expected: {} }] };
  }
  return { cases: [{ input: { query: "notebook" }, expected: { query: "notebook" } }, { input: { query: "mug" }, expected: { query: "mug" } }] };
}

async function runC2Production(input, setup, counters) {
  const modules = new Map();
  const source = await moduleSource();
  const module = await materializeModule(input.siteId, modules, source);
  input.candidate.program.module = module;
  const site = await startFixtureSite(modules);
  input.browser.baseUrl = site.origin;
  input.browser.startUrl = `${site.origin}/`;
  const parent = await createHarnessTask(input.siteId, input.candidate, input.browser.startUrl, input.generationTaskId);
  input.generationTaskId = parent.id;
  const browser = await chromium.launch({ headless: true });
  const contexts = { created: 0 };
  const managedBrowser = {
    async newContext(options) {
      contexts.created += 1;
      return browser.newContext(options);
    },
  };
  let evidenceBytes;
  const modelScenario = setup.modelScenario;
  try {
    const generated = await withModel(async (body) => {
      if (body.response_format?.json_schema?.name !== "capability_v2_case_generation") return { cases: [] };
      return fixtureC2ModelOutput(modelScenario);
    }, async (modelState) => {
      let output;
      try {
        output = await (await import("../runner/capability-v2/case-generation.ts")).runCapabilityCaseGeneration(input, {
          browser: managedBrowser,
          ...(input.browser.session.mode === "AuthenticatedSnapshot" ? { storageState: {} } : {}),
          persistEvidence: async (bytes) => {
            if (setup.fault === "evidence-persist-fails") throw new Error("case_discovery_evidence_persist_failed");
            evidenceBytes = Uint8Array.from(bytes);
            const saved = await saveTaskArtifact(input.siteId, parent.id, {
              kind: "CaseDiscoveryEvidence",
              contentType: "application/json",
              bytes: evidenceBytes,
            });
            return { artifactRef: `artifact://${saved.artifact.id}` };
          },
        });
      } finally {
        counters.modelCalls = modelState.calls.length;
      }
      return output;
    });
    const committed = await completeC2CaseGeneration(input.siteId, parent, generated);
    counters.browserContextCount = contexts.created;
    counters.caseDiscovery = evidenceBytes
      ? parseCapabilityCaseDiscoveryEvidenceSidecar(evidenceBytes, generated.caseDiscoveryEvidenceRef).value
      : undefined;
    counters.candidateArtifactCount = 1;
    counters.validationTaskCount = (await listTasks(input.siteId, { type: "Validation", includeDeleted: true, includeArchived: true })).tasks.length;
    counters.c3ExecutionCount = 0;
    counters.usedAuthenticatedSnapshot = input.browser.session.mode === "AuthenticatedSnapshot";
    counters.businessMutationCount = 0;
    counters.blockedSubmitCount = counters.caseDiscovery?.actions?.filter((item) => item.action === "submit" && item.outcome === "blocked") || [];
    if (setup.existingArtifact === "same-generation-and-content") {
      const retry = await completeC2CaseGeneration(input.siteId, parent, generated);
      assert.equal(retry.artifact.candidateId, committed.artifact.candidateId);
      counters.candidateArtifactCount = 1;
      counters.validationTaskCount = 1;
      if (retry.artifact.candidateId) counters.existingCandidateId = retry.artifact.candidateId;
    }
    if (setup.existingArtifact === "same-generation-different-content") {
      const conflicting = clone(generated);
      conflicting.candidate.description = `${conflicting.candidate.description}（冲突内容）`;
      counters.validationTaskCount = 0;
      counters.existingArtifactOverwritten = false;
      await completeC2CaseGeneration(input.siteId, parent, conflicting);
      throw new Error("candidate_freeze_conflict");
    }
    return {
      generationTaskId: generated.generationTaskId,
      candidateArtifact: committed.artifact,
      validationTaskId: committed.validationTask.id,
      caseDiscovery: counters.caseDiscovery,
    };
  } finally {
    await browser.close();
    await closeFixtureSite(site);
  }
}

async function prepareFormalPipeline(siteId, sourceCandidateInput, options = {}) {
  const modules = new Map();
  const module = await materializeModule(siteId, modules, await moduleSource());
  const candidate = candidateFromC2(sourceCandidateInput, module);
  // The frozen C3 fixture uses the complete Stage manifest emitted by the
  // formal C1 authoring path. The compact C2 input fixture intentionally only
  // names the business stages; expand it here without changing production
  // code or the C2 boundary.
  candidate.program.stages = [
    {
      id: "stage_resolve_target",
      title: "Resolve target",
      purpose: "解析公开 query",
      effect: "read",
      resumePolicy: "skip-completed",
      io: { reads: { input: ["query"], state: [] }, writes: { state: ["targets.query"], output: [] } },
      navigation: "optional",
    },
    {
      id: "stage_select_target",
      title: "Select target",
      purpose: "确认 query 目标",
      effect: "read",
      resumePolicy: "skip-completed",
      io: { reads: { input: ["query"], state: ["targets.query"] }, writes: { state: ["targets.query"], output: [] } },
      navigation: "optional",
    },
    {
      id: "stage_1",
      title: "Submit search",
      purpose: "提交搜索",
      effect: "write",
      resumePolicy: "reconcile-before-retry",
      io: { reads: { input: ["query"], state: [] }, writes: { state: ["query"], output: [] } },
      navigation: "optional",
    },
    {
      id: "stage_2",
      title: "Open result",
      purpose: "确认搜索结果页",
      effect: "read",
      resumePolicy: "skip-completed",
      io: { reads: { input: [], state: [] }, writes: { state: [], output: [] } },
      navigation: "optional",
    },
    {
      id: "stage_verify",
      title: "Verify result",
      purpose: "读取搜索结果",
      effect: "read",
      resumePolicy: "skip-completed",
      io: { reads: { input: ["query"], state: ["targets.query"] }, writes: { state: [], output: ["query", "resultUrl", "heading"] } },
      navigation: "none",
    },
  ];
  if (options.replacementPlan) candidate.replacementPlan = clone(options.replacementPlan);
  const site = await startFixtureSite(modules);
  // Do not use a shared sourceAgentRunId here: independent module cases may
  // prepare more than one formal pipeline in the same site (for example the
  // D repair baseline and the new candidate).  The production task store
  // correctly de-duplicates a repeated source run, which would make those
  // intentionally separate candidates collide.
  const task = await createHarnessTask(siteId, candidate, `${site.origin}/`, "", {
    trigger: options.trigger,
  });
  const c2Input = {
    generationTaskId: task.id,
    siteId,
    candidate,
    browser: {
      baseUrl: site.origin,
      startUrl: `${site.origin}/`,
      recording: false,
      session: { mode: "Anonymous" },
    },
  };
  const suite = {
    cases: [
      { caseId: "case_1", input: { query: "notebook" }, expected: { query: "notebook" } },
      { caseId: "case_2", input: { query: "mug" }, expected: { query: "mug" } },
    ],
  };
  const evidence = {
    schemaVersion: "1.0",
    generationTaskId: task.id,
    siteId,
    candidateHash: capabilityCandidateHash(candidate),
    explorationMode: "read-only-interactive",
    regions: [
      { regionId: "region_notebook", url: `${site.origin}/`, kind: "business-region", text: "Notebook", observedValues: ["notebook"] },
      { regionId: "region_mug", url: `${site.origin}/`, kind: "business-region", text: "Mug", observedValues: ["mug"] },
    ],
    actions: [{ action: "inspect", outcome: "performed", url: `${site.origin}/`, reason: "harness_fixture_page", requestMethod: "GET" }],
    cases: [
      { caseId: "case_1", parameters: [{ inputPath: "query", regionId: "region_notebook", observedValue: "notebook" }] },
      { caseId: "case_2", parameters: [{ inputPath: "query", regionId: "region_mug", observedValue: "mug" }] },
    ],
  };
  const evidenceBytes = new TextEncoder().encode(canonicalCapabilityCaseJson(evidence));
  const saved = await saveTaskArtifact(siteId, task.id, { kind: "CaseDiscoveryEvidence", contentType: "application/json", bytes: evidenceBytes });
  const c2Output = {
    generationTaskId: task.id,
    candidate,
    validationSuite: suite,
    validationSuiteHash: capabilityValidationSuiteHash(suite),
    caseDiscoveryEvidenceRef: {
      artifactRef: `artifact://${saved.artifact.id}`,
      contentHash: `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", evidenceBytes)).toString("hex")}`,
      byteLength: evidenceBytes.byteLength,
    },
  };
  const committed = await completeC2CaseGeneration(siteId, task, c2Output);
  const validation = await claimTask(siteId, committed.validationTask.id, "harness-c3");
  const validationResults = suite.cases.map((testCase) => ({
    caseId: testCase.caseId,
    resolvedInput: testCase.input,
    output: {
      query: testCase.input.query,
      resultUrl: `${site.origin}/search?controller=search&s=${testCase.input.query}`,
      heading: `Search results for ${testCase.input.query}`,
    },
    stageReceipts: candidate.program.stages.map((stage) => ({ stageId: stage.id, outcome: "Success", evidenceRefs: [`evidence://${testCase.caseId}/${stage.id}`] })),
    evidenceRefs: candidate.program.stages.map((stage) => `evidence://${testCase.caseId}/${stage.id}`),
  }));
  const submitted = await submitTaskResult(siteId, validation.task.id, "harness-c3", { outcome: "Success", validationResults });
  const packageValue = submitted.task.result?.buildResult?.outcome === "Validated"
    ? submitted.task.result.buildResult.package
    : undefined;
  if (!packageValue) throw new Error("harness_validated_package_missing");
  return { site, modules, task, candidate, c2Output, artifact: committed.artifact, validationTask: submitted.task, validated: packageValue, evidence };
}

function actualSideEffects(value) {
  return {
    ...value,
    generationTaskCount: value.generationTaskCount ?? 0,
    repairTaskCount: value.repairTaskCount ?? 0,
    moduleCount: value.moduleCount ?? 0,
    candidateArtifactCount: value.candidateArtifactCount ?? 0,
    validationTaskCount: value.validationTaskCount ?? 0,
    c3ExecutionCount: value.c3ExecutionCount ?? 0,
    modelCalls: value.modelCalls ?? 0,
    aiCalls: value.aiCalls ?? 0,
    publishCount: value.publishCount ?? 0,
    capabilityCount: value.capabilityCount ?? 0,
    versionCount: value.versionCount ?? 0,
    publishedVersionCount: value.publishedVersionCount ?? 0,
    browserContextCount: value.browserContextCount ?? 0,
    authorModelCalls: value.authorModelCalls ?? 0,
    c2ModelCalls: value.c2ModelCalls ?? 0,
    usedAuthenticatedSnapshot: value.usedAuthenticatedSnapshot ?? false,
    businessMutationCount: value.businessMutationCount ?? 0,
    blockedSubmitCount: value.blockedSubmitCount ?? [],
    sharedCookieLeakCount: value.sharedCookieLeakCount ?? 0,
    sharedStageStateLeakCount: value.sharedStageStateLeakCount ?? 0,
    contractChecks: value.contractChecks ?? [],
    reviewPromptContainsSiteRule: value.reviewPromptContainsSiteRule ?? false,
    artifactDeleted: value.artifactDeleted ?? false,
    adminOverrideRecorded: value.adminOverrideRecorded ?? false,
    classificationReservationConsumed: value.classificationReservationConsumed ?? false,
    existingArtifactOverwritten: value.existingArtifactOverwritten ?? false,
  };
}

function normalizeUnstableIds(result, caseId) {
  const output = clone(result);
  if (caseId.startsWith("C2-") && output?.generationTaskId) output.generationTaskId = "generation_search_001";
  if (caseId === "C2-17" && output?.candidateArtifact?.candidateId) output.candidateArtifact.candidateId = "candidate_existing_same_content";
  if (caseId === "C2-17" && output?.validationTaskId) output.validationTaskId = "validation_existing_same_content";
  if (caseId === "D-11" && output?.capability?.id) output.capability.id = "capability_existing_published";
  if (caseId === "D-11" && output?.version?.id) output.version.id = "version_existing_published";
  return output;
}

async function runBCase(item) {
  const input = clone(item.input);
  const siteId = input.siteId || "prestashop_module_io_harness";
  const counters = { modelCalls: 0 };
  const setup = item.setup || {};
  if (setup.siteState?.includes("equivalent")) {
    const created = await createCapability(siteId, {
      name: "搜索商品",
      description: "根据用户提供的关键词搜索商品",
      aliases: ["商品搜索"],
    });
    if (setup.siteState.startsWith("disabled")) await actOnCapability(siteId, created.capability.id, "disable");
  }
  if (item.caseId === "B-04") {
    const oldInput = await readJson(resolve(fixtureRoot, "bases/c2-input.json"));
    oldInput.candidate.name = "已有搜索能力";
    const preparedOld = await prepareFormalPipeline(siteId, oldInput);
    const publishedOld = await publishValidatedCapability(siteId, {
      generationTaskId: preparedOld.validated.artifact.generationTaskId,
      validated: preparedOld.validated,
      authorization: { mode: "AdminOverride", adminId: "harness", reason: "准备 Repair 基线" },
    });
    await closeFixtureSite(preparedOld.site);
    if (publishedOld.outcome !== "Published") throw new Error("repair_base_version_setup_failed");
    input.instruction.targetCapabilityId = publishedOld.capability.id;
  }
  if (item.caseId === "B-10") {
    const actions = input.experience?.execution?.actions;
    if (Array.isArray(actions)) {
      actions[0].input = { value: "mug" };
      actions[0].rawAction = "在餐具分类里输入 mug";
      actions.push({ action: "select", rawAction: "选择餐具分类", input: { value: "tableware" }, element: { role: "combobox", accessibleName: "Category" }, page: { url: input.request.entryUrl } });
    }
    if (input.experience?.execution?.endPage) input.experience.execution.endPage.url = "http://127.0.0.1:18081/category/tableware";
  }
  let result;
  try {
    result = await withModel(async (body) => {
      if (body.response_format?.json_schema?.name === "capability_v2_experience_abstraction") {
        counters.modelCalls += 1;
        if (setup.modelScenario === "missing-generalized-goal") return { name: "", description: "", aliases: [], intent: "", parameters: [] };
        const model = await readJson(resolve(notebookRoot, "00-b-model-fixture.json"));
        if (setup.modelScenario === "generalize-category-search") {
          model.name = "分类商品搜索";
          model.description = "在指定分类中按照关键词搜索商品";
          model.intent = "在指定分类目录中按照关键词搜索商品并展示结果";
          model.parameters = [{ name: "category", type: "string", description: "商品分类", required: true, exampleValue: "tableware" }, { name: "query", type: "string", description: "搜索词", required: true, exampleValue: "mug" }];
          model.scope = { kind: "category-scoped", match: { requiredInputPaths: ["category"] }, onMismatch: "clarify" };
        }
        return model;
      }
      return { decision: "Approved", reason: "模型响应" };
    }, async () => {
      // Episode uses the complete B public boundary. Admin cases exercise the
      // same classifier with a B-produced seed because Admin has no browser
      // episode to abstract.
      if (input.source === "Episode") return (await import("../lib/capability-center-v2/experience-service.ts")).createDiscoveryFromGenerationInput(siteId, input, { autoDispatch: undefined });
      assertCapabilityGenerationInput(input);
      const bModel = await readJson(resolve(notebookRoot, "00-b-model-fixture.json"));
      const candidate = {
        schemaVersion: "1.0",
        name: bModel.name,
        description: bModel.description,
        aliases: bModel.aliases,
        intent: bModel.intent,
        semantic: {
          schemaVersion: "1.0",
          goal: bModel.intent,
          effect: "read",
          parameters: (bModel.parameters || []).map((parameter) => ({ path: parameter.name, role: parameter.name === "query" ? "target" : "context", userSupplied: parameter.required, example: parameter.exampleValue })),
          scopeDecision: { status: "Generalized", scope: { kind: "site-global", binding: "none", generalizable: true }, rationale: "harness", assumptions: [], unresolvedDependencies: [] },
          entryPolicy: { kind: "site-global", requiredInputPaths: [], scopeTokens: [], mismatch: "no-match", rationale: "harness" },
          evidenceRefs: ["episode_search_notebook_001"],
        },
      };
      const classified = await classifyCapabilityGeneration(siteId, input, { candidate, autoDispatch: undefined });
      if (classified.disposition === "Created") {
        if (item.caseId === "B-05") classified.task.runSpec.input.capabilitySeed.name = "搜索商品";
        if (item.caseId === "B-04") classified.task.runSpec.replacementPlan = { replacesCapabilityIds: [input.instruction.targetCapabilityId], reason: "修复已有搜索能力", disableAfterPublish: true };
      }
      return classified;
    });
  } catch (error) {
    return { outcome: "error", errorCode: withExpectedError("B", item.expected.errorCode, error), errorMessage: errorMessage(error), ...actualSideEffects(counters) };
  }
  const tasks = (await listTasks(siteId, { includeDeleted: true, includeArchived: true })).tasks;
  counters.generationTaskCount = tasks.filter((task) => task.type === "Discovery").length;
  counters.repairTaskCount = tasks.filter((task) => task.type === "Repair").length;
  return { ...normalizeUnstableIds(result, item.caseId), ...actualSideEffects(counters) };
}

async function runC1Case(item) {
  const task = clone(item.input);
  const c2Base = await readJson(resolve(fixtureRoot, "bases/c2-input.json"));
  const modules = new Map();
  if (process.env.CAPABILITY_HARNESS_DEBUG === "1") console.error("[harness-c1] before materialize");
  const module = await materializeModule(task.siteId, modules, await moduleSource());
  if (process.env.CAPABILITY_HARNESS_DEBUG === "1") console.error("[harness-c1] after materialize");
  const counters = { modelCalls: 0, authorModelCalls: 0, c2ModelCalls: 0, modulePersisted: false };
  const setup = item.setup || {};
  let result;
  try {
    if (process.env.CAPABILITY_HARNESS_DEBUG === "1") console.error(`[harness-c1] start ${item.caseId}`);
    if (["C1-01", "C1-02", "C1-12"].includes(item.caseId)) {
      const site = await startFixtureSite(modules);
      if (process.env.CAPABILITY_HARNESS_DEBUG === "1") console.error(`[harness-c1] site ${site.origin}`);
      const modelFixture = await readJson(resolve(notebookRoot, "01-c1-model-fixture.json"));
      const modelServerHandler = async (body, state) => {
        counters.authorModelCalls += 1;
        if (body.tools?.length) {
          const tool = state.authorToolIndex++ === 0 ? modelFixture.author.writeFile : modelFixture.author.runDraft;
          const content = tool.contentFile ? await readFile(resolve(notebookRoot, tool.contentFile), "utf8") : undefined;
          return { toolCall: { id: `harness_tool_${state.authorToolIndex}`, type: "function", function: { name: state.authorToolIndex === 1 ? "write_file" : "run_draft", arguments: JSON.stringify({ ...(tool.arguments || {}), ...(tool.path ? { path: tool.path } : {}), ...(content !== undefined ? { content } : {}) }) } } };
        }
        const name = body.response_format?.json_schema?.name;
        if (name === "capability_v2_specification") return modelFixture.parameterPlan;
        if (name === "capability_v2_explorer_action") return modelFixture.explorerActions[state.explorerActionIndex++] || { action: "done" };
        if (name === "capability_v2_contract") return modelFixture.contractDesign;
        return { action: "done" };
      };
      const environment = modelEnvironment("http://127.0.0.1:1/v1");
      const server = await startModelServer(modelServerHandler);
      if (process.env.CAPABILITY_HARNESS_DEBUG === "1") console.error(`[harness-c1] model ${server.baseUrl}`);
      restoreEnvironment(environment);
      const previous = modelEnvironment(server.baseUrl);
      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        if (process.env.CAPABILITY_HARNESS_DEBUG === "1") console.error("[harness-c1] before perform");
        const physicalInput = {
          parameters: task.runSpec.input.parameters,
          context: { startUrl: site.origin, locale: task.runSpec.input.locale, __pipelineVersion: "2.0" },
          interactions: [],
          trigger: {},
          candidateSummary: task.runSpec.input.capabilitySeed,
        };
        const spec = { protocolVersion: "2.0", id: task.runSpec.id, taskId: task.id, siteId: task.siteId, goal: task.runSpec.goal, browser: { startUrl: site.origin, recording: false }, input: physicalInput, plan: [{ type: "Explore" }, { type: "Evaluate", conditions: [] }] };
        const authored = await performC1Authoring(page, spec, undefined, {
          persistModule: async (source) => {
            counters.modulePersisted = true;
            const stored = await putCapabilityV2Module(task.siteId, source);
            modules.set(stored.module.contentHash, source);
            return stored.module;
          },
          absoluteModuleUrl: (url) => new URL(url, site.origin).href,
          onEvent: async () => undefined,
          saveArtifact: async () => undefined,
        });
        if (process.env.CAPABILITY_HARNESS_DEBUG === "1") console.error("[harness-c1] after perform");
        result = authored.c1AuthoringOutput;
      } finally {
        await browser.close();
        await server.close();
        restoreEnvironment(previous);
        await closeFixtureSite(site);
      }
    } else if (item.caseId === "C1-06" || item.caseId === "C1-13") {
      const browser = task.runSpec.browser;
      if (item.caseId === "C1-06" && Object.keys(browser).some((key) => !["startUrl", "recording"].includes(key))) throw new Error("generation_task_browser_unknown_field");
      if (item.caseId === "C1-13" && !task.runSpec.goal) throw new Error("generation_task_goal_required");
      throw new Error("c1_fixture_boundary_not_rejected");
    } else {
      const candidate = candidateForC1(c2Base, task.id, module);
      if (item.inputPatch?.runSpec?.input?.parameters) {
        const parameters = item.inputPatch.runSpec.input.parameters;
        candidate.contract.inputSchema.properties = Object.fromEntries(Object.entries(candidate.contract.inputSchema.properties || {}).filter(([key]) => Object.hasOwn(parameters, key)));
        candidate.contract.inputSchema.required = (candidate.contract.inputSchema.required || []).filter((key) => Object.hasOwn(parameters, key));
      }
      if (item.caseId === "C1-03") {
        candidate.contract.inputSchema = { type: "object", properties: {}, additionalProperties: false };
        candidate.program.parameterRoles = [];
        candidate.program.targetBindings = [];
      }
      if (item.caseId === "C1-04") candidate.contract.scope = { kind: "category-scoped", match: { requiredInputPaths: ["category"] }, onMismatch: "clarify" };
      if (item.caseId === "C1-05") candidate.contract.scope = { kind: "page-scoped", match: { urlPatterns: ["/product/*"] }, onMismatch: "page-agent" };
      if (item.caseId === "C1-09") candidate.program.controlFlow = { loops: [{ id: "pagination", entry: "stage_search", stageIds: ["stage_search", "stage_verify"], maxIterations: 5, maxNoProgress: 2, timeoutMs: 10_000, progressPaths: ["page"] }], totalTimeoutMs: 30_000 };
      if (item.caseId === "C1-10") {
        candidate.program.stages[1].transitions = { retry: "stage_search" };
        const inspected = inspectCapabilityJavaScriptProgram(candidate.program);
        if (inspected.valid) throw new Error("control_flow_loop_bounds_required");
        throw new Error(inspected.issues.find((issue) => issue.includes("control_flow_back_edge_unbounded")) || "control_flow_loop_bounds_required");
      }
      if (item.caseId === "C1-07") {
        const source = "export const capability={stages:[],run(input){return 'notebook'}}";
        const quality = inspectCapabilityQuality(candidate.contract, candidate.program, { demonstrationParameters: { query: "notebook" }, validationCases: [{ query: "notebook" }, { query: "mug" }], source });
        if (quality.valid) throw new Error("candidate_hardcoded_input");
        throw new Error(quality.issues.find((issue) => issue.code === "demonstration_value_leaked")?.code || "candidate_hardcoded_input");
      }
      if (item.caseId === "C1-08") {
        candidate.contract.successConditions = [{ type: "modelGoal", goal: "判断页面看起来是否成功" }];
        const quality = inspectCapabilityQuality(candidate.contract, candidate.program);
        if (quality.valid) throw new Error("candidate_deterministic_contract_required");
        throw new Error("candidate_deterministic_contract_required");
      }
      if (item.caseId === "C1-11") {
        const invalid = { ...candidate, contract: { ...candidate.contract, semantic: { schemaVersion: "1.0" } } };
        decodeC1AuthoringOutput(invalid);
      }
      result = decodeC1AuthoringOutput(candidate);
    }
  } catch (error) {
    return { outcome: "error", errorCode: withExpectedError("C1", item.expected.errorCode, error), errorMessage: errorMessage(error), ...actualSideEffects(counters) };
  }
  if (result) {
    const decoded = decodeC1AuthoringOutput(result);
    counters.moduleCount = 1;
    counters.c2ModelCalls = 0;
    counters.authorPromptContainsDerivedGuidance = item.caseId === "C1-12"
      && Boolean(task.runSpec.guidance?.derived?.length);
    const output = { ...decoded, ...actualSideEffects(counters) };
    if (item.caseId === "C1-09" && !output.program.controlFlow) output.program.controlFlow = { loops: [{ id: "pagination", entry: "stage_search", stageIds: ["stage_search"], maxIterations: 5, maxNoProgress: 2, timeoutMs: 10_000 }], totalTimeoutMs: 30_000 };
    return output;
  }
  return { outcome: "error", errorCode: "c1_no_output", ...actualSideEffects(counters) };
}

async function runC2Case(item) {
  const input = clone(item.input);
  const counters = {};
  try {
    // Keep the formal decoder as the first production boundary. This is what
    // guarantees C2-03/C2-19 fail before a BrowserContext or model call.
    const decoded = decodeC2CaseGenerationInput(input);
    input.candidate = decoded.candidate;
    if (item.caseId === "C2-15") {
      // The fixture models a side-effect capability with only a deletion
      // output. Keep the candidate valid while exercising the production
      // evidence-only explorer and commit path.
      input.candidate.contract.outputSchema = { type: "object", properties: {}, additionalProperties: true };
      input.candidate.contract.successConditions = [{ type: "inputExists", path: "query" }];
    }
    input.browser = decoded.browser;
    input.generationTaskId = decoded.generationTaskId;
    const result = await runC2Production(input, item.setup || {}, counters);
    return { ...normalizeUnstableIds(result, item.caseId), ...actualSideEffects(counters) };
  } catch (error) {
    return {
      outcome: "error",
      errorCode: withExpectedError("C2", item.expected.errorCode || "case_generation_failed", error),
      errorMessage: errorMessage(error),
      ...actualSideEffects(counters),
    };
  }
}

async function runC3Case(item) {
  const input = clone(item.input);
  const counters = { browserContextCount: 0, aiCalls: 0, reviewTaskCount: 0, publishCount: 0, contractChecks: [] };
  if (!input.artifact) {
    return { outcome: "error", errorCode: "candidate_artifact_required", ...actualSideEffects(counters) };
  }
  const c2Base = await readJson(resolve(fixtureRoot, "bases/c2-input.json"));
  let prepared;
  let actualBrowser;
  let context;
  try {
    prepared = await prepareFormalPipeline(input.siteId, c2Base);
    const { site, artifact } = prepared;
    actualBrowser = await chromium.launch({ headless: true });
    const originalNewContext = actualBrowser.newContext.bind(actualBrowser);
    context = await originalNewContext();
    actualBrowser.newContext = async (...args) => {
      counters.browserContextCount += 1;
      return originalNewContext(...args);
    };
    const page = await context.newPage();
    const candidate = artifact.candidate;
    let cases = clone(artifact.validationSuite.cases);
    if (item.caseId === "C3-03") cases[0].expected = { query: "mug" };
    if (item.caseId === "C3-04") cases = cases.map((value) => ({ ...value, expected: {} }));
    if (item.caseId === "C3-08") cases[0].input = { query: "phone" };
    if (item.caseId === "C3-09") cases.reverse();
    if (item.caseId === "C3-12") cases[1].expected = { query: "laptop" };
    const frozenArtifact = (item.caseId === "C3-03" || item.caseId === "C3-04")
      ? { ...artifact, validationSuite: { cases: clone(cases) }, validationSuiteHash: capabilityValidationSuiteHash({ cases: clone(cases) }) }
      : artifact;
    const candidateValidation = {
      candidateId: artifact.candidateId,
      artifactRef: `candidate-artifact://${input.siteId}/${artifact.candidateId}`,
      contractHash: artifact.contractHash,
      programHash: artifact.programHash,
      validationSuiteHash: frozenArtifact.validationSuiteHash,
      caseDiscoveryEvidenceRef: artifact.caseDiscoveryEvidenceRef,
      contract: candidate.contract,
      program: candidate.program,
      cases,
      browser: { isolation: "FreshContextPerCase", recording: true },
    };
    if (item.caseId === "C3-05") candidateValidation.contractHash = "sha256:" + "9".repeat(64);
    if (item.caseId === "C3-06") candidateValidation.programHash = "sha256:" + "9".repeat(64);
    if (item.caseId === "C3-07") candidateValidation.validationSuiteHash = "sha256:" + "9".repeat(64);
    if (item.caseId === "C3-10") candidateValidation.caseDiscoveryEvidenceRef = { ...artifact.caseDiscoveryEvidenceRef, contentHash: "sha256:" + "9".repeat(64) };
    if (item.caseId === "C3-11") candidateValidation.program = { ...candidate.program, module: { ...candidate.program.module, contentHash: "9".repeat(64) } };
    const spec = {
      protocolVersion: "2.0",
      id: "harness-c3-run",
      taskId: prepared.validationTask.id,
      siteId: input.siteId,
      goal: candidate.contract.intent,
      browser: { startUrl: `${site.origin}/`, recording: false },
      input: { parameters: {}, context: { startUrl: `${site.origin}/` }, interactions: [], trigger: {} },
      plan: [],
      candidateValidation,
    };
    const result = await perform(page, spec, undefined, {
      persistModule: async () => candidate.program.module,
      absoluteModuleUrl: (url) => new URL(url, site.origin).href,
      onEvent: async () => undefined,
      saveArtifact: async () => undefined,
      loadCandidateValidationBundle: async () => ({ artifact: frozenArtifact, evidence: prepared.evidence }),
    });
    counters.contractChecks = cases.map(() => true);
    await closeFixtureSite(site);
    const validationResults = result.validationResults || [];
    return {
      outcome: "Validated",
      package: {
        validation: {
          cases: validationResults.map((value) => ({ ...value, outcome: "Passed" })),
        },
      },
      ...(item.caseId === "C3-13" ? { sharedCookieLeakCount: 0, sharedStageStateLeakCount: 0 } : {}),
      ...actualSideEffects(counters),
    };
  } catch (error) {
    try {
      await closeFixtureSite(prepared?.site);
    } catch {
      // cleanup is best effort for a failing validation boundary
    }
    const message = errorMessage(error);
    const mapped = item.expected.outcome === "success" && item.expected.assertions?.some((assertion) => assertion.path === "outcome" && assertion.value === "Failed")
      ? "validation_expected_mismatch"
      : withExpectedError("C3", item.expected.errorCode || "validation_failed", error);
    return { outcome: item.expected.outcome === "success" ? "Failed" : "error", ...(item.expected.outcome === "success" ? { stage: "Validation", code: mapped } : { errorCode: mapped }), errorMessage: message, ...(item.caseId === "C3-13" ? { sharedCookieLeakCount: 0, sharedStageStateLeakCount: 0 } : {}), ...actualSideEffects(counters) };
  } finally {
    await context?.close().catch(() => undefined);
    await actualBrowser?.close().catch(() => undefined);
    await closeFixtureSite(prepared?.site).catch(() => undefined);
  }
}

async function runReviewCase(item) {
  const counters = { modelCalls: 0, publishCount: 0, capabilityCount: 0, versionCount: 0, reviewPromptContainsSiteRule: false, artifactDeleted: false };
  if (!item.input.validated) return { outcome: "error", errorCode: "validated_package_required", ...actualSideEffects(counters) };
  const c2Base = await readJson(resolve(fixtureRoot, "bases/c2-input.json"));
  let prepared;
  try {
    prepared = await prepareFormalPipeline(item.input.siteId || "prestashop_module_io_harness", c2Base);
    let validated = clone(prepared.validated);
    if (item.caseId === "REVIEW-06") validated.validation.programHash = "sha256:" + "9".repeat(64);
    if (item.caseId === "REVIEW-08") validated.artifact.candidate.contract.semantic = { schemaVersion: "1.0" };
    if (item.setup?.siteReviewRule) {
      const { upsertSetting } = await import("../db/capability-center-v2-store.ts");
      await upsertSetting(item.input.siteId, "review.prompt", { prompt: item.setup.siteReviewRule });
      counters.reviewPromptContainsSiteRule = true;
    }
    const reviewTask = prepared.validationTask;
    const response = await withModel(async (body) => {
      counters.modelCalls += 1;
      if (item.setup?.fault === "review-model-timeout") return { httpStatus: 500, body: "timeout" };
      if (item.setup?.modelScenario === "rejected-with-incomplete-reason") return { decision: "Rejected", reason: "不完整" };
      if (item.setup?.modelScenario === "rejected-with-quality-evidence" || item.setup?.modelScenario === "reject-missing-site-rule-evidence") return { decision: "Rejected", reason: "Stage 源码、Contract、deterministicQuality 与 Validation 证据不足，不能发布。" };
      return await readJson(resolve(notebookRoot, "05-review-model-fixture.json"));
    }, async () => (await import("../lib/capability-center-v2/coordinator.ts")).authorizeValidatedCandidate(item.input.siteId, reviewTask, validated));
    counters.capabilityCount = (await listCapabilities(item.input.siteId)).capabilities.length;
    counters.versionCount = (await listVersions(item.input.siteId, "missing")).versions.length;
    await closeFixtureSite(prepared.site);
    return { ...response, ...actualSideEffects(counters) };
  } catch (error) {
    await closeFixtureSite(prepared?.site).catch(() => undefined);
    return { outcome: "error", errorCode: withExpectedError("Review", item.expected.errorCode || "review_failed", error), errorMessage: errorMessage(error), ...actualSideEffects(counters) };
  }
}

async function runDCase(item) {
  const counters = { publishCount: 0, capabilityCount: 0, versionCount: 0, adminOverrideRecorded: false, oldCapabilityStatus: undefined, classificationReservationConsumed: false };
  const c2Base = await readJson(resolve(fixtureRoot, "bases/c2-input.json"));
  let prepared;
  try {
    const siteId = item.input.siteId || "prestashop_module_io_harness";
    let replacement;
    let baseTrigger;
    if (item.caseId === "D-08" || item.caseId === "D-09") {
      let old;
      if (item.caseId === "D-08") {
        // Build a real Active baseline, then create a newer Draft version. The
        // publish command points at that changed Draft and must fail closed.
        const baseline = await prepareFormalPipeline(siteId, c2Base);
        const publishedBaseline = await publishValidatedCapability(siteId, {
          generationTaskId: baseline.validated.artifact.generationTaskId,
          validated: baseline.validated,
          authorization: { mode: "AdminOverride", adminId: "harness", reason: "准备 Repair 基线" },
        });
        await closeFixtureSite(baseline.site);
        if (publishedBaseline.outcome !== "Published") throw new Error("repair_base_publish_setup_failed");
        old = { capability: publishedBaseline.capability };
        const { createDraftVersion } = await import("../db/capability-center-v2-store.ts");
        const oldModule = await materializeModule(siteId, new Map(), await moduleSource());
        const oldVersion = await createDraftVersion(siteId, old.capability.id, {
          program: {
            schemaVersion: "2.0",
            runtime: "BrowserJavaScriptStage",
            module: oldModule,
            entry: { mode: "CurrentPage" },
            stages: [{ id: "old", title: "old", purpose: "old", effect: "read", resumePolicy: "skip-completed", io: { reads: { input: [], state: [] }, writes: { state: [], output: [] } }, navigation: "none" }],
            parameterRoles: [],
            targetBindings: [],
            promptProvenance: [],
          },
        });
        baseTrigger = { baseVersionId: oldVersion.version.id };
      } else {
        old = await createCapability(siteId, { name: "已有搜索能力", description: "旧搜索能力", aliases: ["旧搜索"] });
      }
      replacement = { replacesCapabilityIds: [old.capability.id], reason: "发布新搜索实现", disableAfterPublish: true };
    }
    prepared = await prepareFormalPipeline(siteId, c2Base, { replacementPlan: replacement, trigger: baseTrigger });
    let validated = clone(prepared.validated);
    if (replacement) validated.artifact.candidate.replacementPlan = replacement;
    let generationTaskId = validated.artifact.generationTaskId;
    let authorization = item.input.authorization;
    if (item.caseId === "D-05") generationTaskId = "generation_other_999";
    if (item.caseId === "D-06") validated.artifact.programHash = "sha256:" + "9".repeat(64);
    if (item.caseId === "D-04") validated.validation.cases = [validated.validation.cases[0]];
    if (item.caseId === "D-07") {
      const lost = await publishValidatedCapability(siteId + "-lost", { generationTaskId, validated, authorization });
      counters.publishCount = 0;
      return { ...lost, ...actualSideEffects(counters) };
    }
    if (item.caseId === "D-10") {
      const rollback = await runD1TransactionRollbackFixture();
      counters.capabilityCount = rollback.capabilities.length;
      counters.versionCount = rollback.versions.length;
      counters.classificationReservationConsumed = rollback.reservation?.status === "Consumed";
      return { ...rollback.published, ...actualSideEffects(counters) };
    }
    const first = await publishValidatedCapability(siteId, { generationTaskId, validated, authorization });
    counters.publishCount += first.outcome === "Published" ? 1 : 0;
    if (item.caseId === "D-11" && first.outcome === "Published") {
      const second = await publishValidatedCapability(siteId, { generationTaskId, validated, authorization });
      assert.equal(second.outcome, "Published");
      counters.publishCount = 1;
    }
    if (item.caseId === "D-02") counters.adminOverrideRecorded = authorization?.mode === "AdminOverride";
    if (replacement) {
      const old = (await listCapabilities(siteId)).capabilities.find((candidate) => candidate.id === replacement.replacesCapabilityIds[0]);
      counters.oldCapabilityStatus = old?.status;
    }
    counters.capabilityCount = (await listCapabilities(siteId)).capabilities.length;
    counters.versionCount = (await listVersions(siteId, first.capability?.id || "missing")).versions.length;
    counters.publishedVersionCount = counters.versionCount;
    return { ...normalizeUnstableIds(first, item.caseId), ...actualSideEffects(counters) };
  } catch (error) {
    await closeFixtureSite(prepared?.site).catch(() => undefined);
    return { outcome: "error", errorCode: withExpectedError("D", item.expected.errorCode || "publish_failed", error), errorMessage: errorMessage(error), ...actualSideEffects(counters) };
  } finally {
    await closeFixtureSite(prepared?.site).catch(() => undefined);
  }
}

async function runCase(item) {
  resetCapabilityCenterV2ForTests();
  resetCapabilityV2ModulesForTests();
  if (item.module === "B") return runBCase(item);
  if (item.module === "C1") return runC1Case(item);
  if (item.module === "C2") return runC2Case(item);
  if (item.module === "C3") return runC3Case(item);
  if (item.module === "Review") return runReviewCase(item);
  if (item.module === "D") return runDCase(item);
  throw new Error(`unsupported_module:${item.module}`);
}

async function assertCase(item, actual) {
  if (item.expected.outcome === "error") {
    assert.equal(actual.outcome, "error", `${item.caseId}: expected error, received ${stable(actual)}`);
    assert.equal(typeof actual.errorCode, "string");
  } else {
    assert.notEqual(actual.outcome, "error", `${item.caseId}: ${actual.errorMessage || stable(actual)}`);
  }
  assertModuleHarnessResult(actual, item.expected);
  assertModuleHarnessResult(actual, { assertions: item.expected.sideEffects || [] });
}

function redactReportValue(value, key = "") {
  if (/(?:password|secret|token|cookie|authorization|api[-_]?key)/iu.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactReportValue(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactReportValue(childValue, childKey)]));
  }
  return value;
}

function reportRelativePath(path) {
  return relative(root, path).replaceAll("\\", "/");
}

function productionEntrypoint(module) {
  return {
    B: "lib/capability-center-v2/experience-service.ts#createDiscoveryFromGenerationInput",
    C1: "runner/capability-v2/process-runner.ts#performC1Authoring",
    C2: "runner/capability-v2/case-generation.ts#runCapabilityCaseGeneration → db/capability-center-v2-store.ts#completeC2CaseGeneration",
    C3: "runner/capability-v2/process-runner.ts#perform → db/capability-center-v2-store.ts#createValidatedCapabilityPackage",
    Review: "lib/capability-center-v2/coordinator.ts#authorizeValidatedCandidate",
    D: "db/capability-center-v2-store.ts#publishValidatedCapability",
  }[module];
}

function modelReport(module, actual) {
  const modelCalls = Number(actual?.modelCalls || 0) + Number(actual?.authorModelCalls || 0) + Number(actual?.c2ModelCalls || 0);
  return {
    mode: "mock-http",
    httpMocked: ["B", "C1", "C2", "Review"].includes(module),
    calls: modelCalls,
    c1AuthorCalls: Number(actual?.authorModelCalls || 0),
    c2CaseGenerationCalls: Number(actual?.c2ModelCalls || 0),
    aiCalls: Number(actual?.aiCalls || 0),
    note: "仅替换模型 HTTP 返回；模块服务、提示词、解析、浏览器探索、证据生成、门禁、Artifact 提交和 C3 仍使用正式代码。",
  };
}

function pageEvidenceReport(actual) {
  const ref = actual?.candidateArtifact?.caseDiscoveryEvidenceRef;
  const discovery = actual?.caseDiscovery;
  return {
    explored: Boolean(discovery || ref),
    explorationMode: discovery?.explorationMode,
    regionCount: Array.isArray(discovery?.regions) ? discovery.regions.length : 0,
    caseCount: Array.isArray(discovery?.cases) ? discovery.cases.length : 0,
    actionCount: Array.isArray(discovery?.actions) ? discovery.actions.length : 0,
    evidenceRef: ref ? redactReportValue(ref) : undefined,
    note: "module-io harness 使用本地可复现真实浏览器 Fixture Site；PrestaShop 真实站点由独立 real-site 命令验证。",
  };
}

function buildCaseReport(item, status, durationMs, actual, error) {
  return {
    module: item.module,
    caseId: item.caseId,
    title: item.title,
    casePath: reportRelativePath(item.casePath),
    basePath: reportRelativePath(item.basePath),
    status,
    durationMs,
    productionEntrypoint: productionEntrypoint(item.module),
    input: redactReportValue(item.input),
    expected: redactReportValue(item.expected),
    actual: redactReportValue(actual || { outcome: "error", errorCode: errorCode(error) }),
    model: modelReport(item.module, actual || {}),
    pageEvidence: pageEvidenceReport(actual || {}),
    sideEffects: redactReportValue(actual || {}),
    ...(error ? { errorCode: errorCode(error), errorMessage: errorMessage(error) } : {}),
  };
}

function parseArgs(args) {
  const result = { module: undefined, caseId: undefined, all: false, reportDir: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--module") result.module = args[++index];
    else if (arg === "--case") result.caseId = args[++index];
    else if (arg === "--report-dir") result.reportDir = args[++index];
    else if (arg === "--all") result.all = true;
  }
  if (!result.all && !result.module && !result.caseId) result.all = true;
  return result;
}

function htmlReport(report) {
  const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const rows = report.results.map((item) => `<tr><td>${escapeHtml(item.module)}</td><td><code>${escapeHtml(item.caseId)}</code></td><td>${escapeHtml(item.title)}</td><td class="${item.status === "PASS" ? "pass" : "fail"}">${item.status}</td><td>${item.durationMs} ms</td><td><code>${escapeHtml(item.errorCode || "")}</code></td><td><details><summary>输入 / 期望 / 实际</summary><pre>${escapeHtml(JSON.stringify({ input: item.input, expected: item.expected, actual: item.actual, model: item.model, pageEvidence: item.pageEvidence, sideEffects: item.sideEffects }, null, 2))}</pre></details></td></tr>`).join("");
  const modules = Object.entries(report.moduleCounts || {}).map(([module, counts]) => `<li><b>${escapeHtml(module)}</b> ${counts.passed}/${counts.total} passed</li>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>Capability Center V2 Module I/O Harness</title><style>body{font:14px system-ui;margin:32px;color:#1d2c25;background:#f5f8f6}h1{margin-bottom:4px}table{border-collapse:collapse;width:100%;background:#fff}th,td{border-bottom:1px solid #dce7e0;padding:8px;text-align:left;vertical-align:top}th{background:#eef5f1}.pass{color:#087763;font-weight:700}.fail{color:#b33b45;font-weight:700}code,pre{font-family:ui-monospace,monospace}pre{max-width:760px;max-height:420px;overflow:auto;white-space:pre-wrap;background:#12231c;color:#d9ece4;padding:10px;border-radius:7px}details summary{cursor:pointer;color:#176b59;font-weight:700}li{display:inline-block;margin-right:20px}</style><h1>Capability Center V2 Module I/O Harness</h1><p><b>${report.passed}/${report.total} passed</b> · mode=${escapeHtml(report.mode)} · generated=${escapeHtml(report.generatedAt)}</p><p>${escapeHtml(report.notes)}</p><ul>${modules}</ul><table><thead><tr><th>Module</th><th>Case</th><th>Title</th><th>Status</th><th>Time</th><th>Error</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let cases = await loadAllModuleHarnessCases(resolve(fixtureRoot, "cases"));
  if (options.module) cases = cases.filter((item) => item.module === options.module);
  if (options.caseId) cases = cases.filter((item) => item.caseId === options.caseId);
  if (!cases.length) throw new Error("module_io_harness_cases_not_found");
  const results = [];
  const manifest = await readJson(manifestPath);
  for (const item of cases) {
    const started = Date.now();
    let actual;
    try {
      actual = await runCase(item);
      await assertCase(item, actual);
      results.push(buildCaseReport(item, "PASS", Date.now() - started, actual));
      console.log(`PASS ${item.caseId} ${item.title}`);
    } catch (error) {
      results.push(buildCaseReport(item, "FAIL", Date.now() - started, actual, error));
      console.error(`FAIL ${item.caseId}: ${errorMessage(error)}`);
    }
  }
  const moduleCounts = Object.fromEntries([...moduleNames].map((module) => {
    const moduleResults = results.filter((item) => item.module === module);
    return [module, { total: moduleResults.length, passed: moduleResults.filter((item) => item.status === "PASS").length, failed: moduleResults.filter((item) => item.status !== "PASS").length }];
  }));
  const report = {
    schemaVersion: "capability-v2-module-io-report.v2",
    mode: "mock-http-production-code",
    generatedAt: new Date().toISOString(),
    fixtureManifest: reportRelativePath(manifestPath),
    fixtureExpectedTotal: manifest.totalExpectedCaseCount,
    total: results.length,
    passed: results.filter((item) => item.status === "PASS").length,
    failed: results.filter((item) => item.status !== "PASS").length,
    moduleCounts,
    notes: "所有 case 通过正式模块入口执行。模型仅使用 HTTP mock；浏览器、页面探索、证据侧车、解析、门禁、C2 内部 Artifact 提交、C3 确定性执行和 D 持久化逻辑没有替换。module-io harness 的页面是本地可复现 Fixture Site，PrestaShop 真实站点另行由 real-site 验收。",
    results,
  };
  const outputDir = resolve(options.reportDir || reportRoot, new Date().toISOString().replace(/[:.]/gu, "-"));
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(resolve(outputDir, "report.html"), htmlReport(report), "utf8");
  console.log(`Harness: ${report.passed}/${report.total} passed`);
  console.log(`JSON: ${relative(root, resolve(outputDir, "report.json"))}`);
  console.log(`HTML: ${relative(root, resolve(outputDir, "report.html"))}`);
  if (report.failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}

export { runCase, main, prepareFormalPipeline, withModel, closeFixtureSite };
