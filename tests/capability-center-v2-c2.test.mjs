import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_CASE_DISCOVERY_EVIDENCE_MAX_BYTES,
  canonicalCapabilityCaseJson,
  capabilityCandidateHash,
  capabilityValidationSuiteHash,
  compileCapabilityCaseGeneration,
  decodeC1AuthoringOutput,
  decodeC2CaseGenerationInput,
  decodeC2CaseGenerationOutput,
  decodeCapabilityCaseModelOutput,
  deriveCapabilityCases,
  offeredInputPaths,
  finalizeCapabilityCaseGeneration,
  parseCapabilityCaseDiscoveryEvidenceSidecar,
  sanitizeCapabilityCaseDiscoveryEvidence,
} from "../lib/capability-center-v2/case-generation.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = resolve(
  root,
  "tests/fixtures/capability-center-v2/notebook-search",
);

async function fixture(name) {
  return JSON.parse(await readFile(resolve(fixtureDir, name), "utf8"));
}

function discoveryFor(input, overrides = {}) {
  return {
    schemaVersion: "1.0",
    generationTaskId: input.generationTaskId,
    siteId: input.siteId,
    candidateHash: capabilityCandidateHash(input.candidate),
    explorationMode: "read-only-interactive",
    regions: [
      {
        regionId: "region_products",
        url: input.browser.startUrl,
        kind: "business-region",
        text: "Available product search values: notebook mug",
        observedValues: ["notebook", "mug"],
      },
    ],
    actions: [
      {
        action: "navigate",
        outcome: "performed",
        url: input.browser.startUrl,
        reason: "entry_get_navigation",
        requestMethod: "GET",
      },
    ],
    ...overrides,
  };
}

async function setup() {
  const [input, model] = await Promise.all([
    fixture("02-c2-input.json"),
    fixture("02-c2-model-fixture.json"),
  ]);
  return { input, model, discovery: discoveryFor(input) };
}

function addOptionalLimit(input) {
  input.candidate.contract.inputSchema.properties.limit = {
    type: "number",
    default: 10,
  };
  input.candidate.program.parameterRoles.push({
    inputPath: "limit",
    role: "value",
  });
  input.candidate.program.stages[0].io.reads.input.push("limit");
}

function addCategoryParameter(input, model) {
  input.candidate.contract.inputSchema.properties.category = {
    type: "string",
    minLength: 1,
  };
  input.candidate.contract.inputSchema.required.push("category");
  input.candidate.program.parameterRoles.push({
    inputPath: "category",
    role: "value",
  });
  input.candidate.program.stages[0].io.reads.input.push("category");
  model.cases[0].input.category = "ceramics";
  model.cases[1].input.category = "office";
}

function compileAfterCandidateChange(input, model, discovery) {
  return compileCapabilityCaseGeneration(input, model, {
    ...discovery,
    candidateHash: capabilityCandidateHash(input.candidate),
  });
}

test("C2 input requires an explicit generationTaskId", async () => {
  const { input } = await setup();
  delete input.generationTaskId;
  assert.throws(
    () => decodeC2CaseGenerationInput(input),
    /case_generation_task_id_required/,
  );
});

test("C2 input rejects the historical flat C1 envelope", async () => {
  const { input } = await setup();
  const flat = {
    generationTaskId: input.generationTaskId,
    siteId: input.siteId,
    ...input.candidate,
    browser: input.browser,
  };
  assert.throws(
    () => decodeC2CaseGenerationInput(flat),
    /case_generation_input_fields_invalid/,
  );
});

test("C2 input rejects the historical caseContextRef field", async () => {
  const { input } = await setup();
  input.caseContextRef = {
    artifactRef: "artifact://legacy",
    contentHash: `sha256:${"0".repeat(64)}`,
  };
  assert.throws(
    () => decodeC2CaseGenerationInput(input),
    /case_generation_input_fields_invalid/,
  );
});

test("C2 input rejects unknown candidate fields", async () => {
  const { input } = await setup();
  input.candidate.validationCases = [];
  assert.throws(
    () => decodeC2CaseGenerationInput(input),
    /case_generation_candidate_fields_invalid/,
  );
});

test("C1 output rejects private case data nested inside Contract or Program", async () => {
  const { input } = await setup();
  const authoring = {
    generationTaskId: input.generationTaskId,
    ...structuredClone(input.candidate),
  };
  authoring.contract.scope.caseContextRef = {
    artifactRef: "artifact://forbidden",
    contentHash: `sha256:${"0".repeat(64)}`,
  };
  assert.throws(
    () => decodeC1AuthoringOutput(authoring),
    /c1_authoring_private_field_forbidden:contract\.scope\.caseContextRef/,
  );

  delete authoring.contract.scope.caseContextRef;
  authoring.contract.scope.validationSuite = { cases: [] };
  assert.throws(
    () => decodeC1AuthoringOutput(authoring),
    /c1_authoring_private_field_forbidden:contract\.scope\.validationSuite/,
  );

  delete authoring.contract.scope.validationSuite;
  authoring.program.stages[0].groundingExamples = [{ query: "forbidden" }];
  assert.throws(
    () => decodeC1AuthoringOutput(authoring),
    /c1_authoring_private_field_forbidden:program\.stages\[0\]\.groundingExamples/,
  );
});

test("C1 strict boundary still accepts legitimate schema property names", async () => {
  const { input } = await setup();
  const authoring = {
    generationTaskId: input.generationTaskId,
    ...structuredClone(input.candidate),
  };
  authoring.contract.inputSchema.properties.semantic = { type: "string" };
  authoring.contract.inputSchema.properties.validationSuite = {
    type: "string",
  };
  authoring.contract.inputSchema.dependencies = {
    semantic: ["query"],
  };
  assert.doesNotThrow(() => decodeC1AuthoringOutput(authoring));
});

test("C2 input rejects unknown browser fields", async () => {
  const { input } = await setup();
  input.browser.context = "reuse-c1";
  assert.throws(
    () => decodeC2CaseGenerationInput(input),
    /case_generation_browser_fields_invalid/,
  );
});

test("C2 input rejects a start URL from another origin", async () => {
  const { input } = await setup();
  input.browser.startUrl = "https://other.example.test/";
  assert.throws(
    () => decodeC2CaseGenerationInput(input),
    /case_generation_browser_origin_mismatch/,
  );
});

test("C2 rejects case inputs that violate the contract schema", async () => {
  const { input, model, discovery } = await setup();
  model.cases[0].input.query = 42;
  assert.throws(
    () => compileCapabilityCaseGeneration(input, model, discovery),
    /capability_run_input_type:query:string/,
  );
});

test("C2 rejects undeclared case input fields", async () => {
  const { input, model, discovery } = await setup();
  model.cases[0].input.invented = true;
  assert.throws(
    () => compileCapabilityCaseGeneration(input, model, discovery),
    /case_schema_additional_property_forbidden:cases\.0\.input\.invented/,
  );
});

test("C2 rejects expected fields outside the output schema", async () => {
  const { input, model, discovery } = await setup();
  model.cases[0].expected = { invented: true };
  assert.throws(
    () => compileCapabilityCaseGeneration(input, model, discovery),
    /case_schema_additional_property_forbidden:cases\.0\.expected\.invented/,
  );
});

test("C2 rejects expected values that violate the output schema", async () => {
  const { input, model, discovery } = await setup();
  model.cases[0].expected = { query: 42 };
  assert.throws(
    () => compileCapabilityCaseGeneration(input, model, discovery),
    /capability_output_type:output\.query:string/,
  );
});

test("C2 accepts deterministic partial expected assertions", async () => {
  const { input, model, discovery } = await setup();
  model.cases[0].expected = { query: "notebook" };
  const output = compileCapabilityCaseGeneration(input, model, discovery);
  assert.deepEqual(output.validationSuite.cases[0].expected, {
    query: "notebook",
  });
});

test("C2 accepts an expected value deterministically proven by a Contract template", async () => {
  const { input, model, discovery } = await setup();
  model.cases[0].expected = {
    resultUrl: "/search?controller=search&s=notebook",
  };
  const output = compileCapabilityCaseGeneration(input, model, discovery);
  assert.equal(
    output.validationSuite.cases[0].expected.resultUrl,
    "/search?controller=search&s=notebook",
  );
});

test("C2 rejects an expected value that is neither evidenced nor deterministically derived", async () => {
  const { input, model, discovery } = await setup();
  model.cases[0].expected = {
    resultUrl: "/invented/result/notebook",
  };
  assert.throws(
    () => compileCapabilityCaseGeneration(input, model, discovery),
    /case_expected_evidence_required:0:resultUrl/,
  );
});

test("C2 requires one case to omit each optional defaulted input", async () => {
  const { input, model } = await setup();
  addOptionalLimit(input);
  model.cases.forEach((item) => {
    item.input.limit = 10;
  });
  const discovery = discoveryFor(input, {
    regions: [
      {
        regionId: "region_products",
        url: input.browser.startUrl,
        kind: "business-region",
        text: "notebook mug limit 10",
        observedValues: ["notebook", "mug", 10],
      },
    ],
  });
  assert.throws(
    () => compileCapabilityCaseGeneration(input, model, discovery),
    /default_omission_validation_required:limit/,
  );
});

test("C2 accepts an independent case that omits an optional defaulted input", async () => {
  const { input, model } = await setup();
  addOptionalLimit(input);
  model.cases[0].input.limit = 10;
  const discovery = discoveryFor(input, {
    regions: [
      {
        regionId: "region_products",
        url: input.browser.startUrl,
        kind: "business-region",
        text: "notebook mug limit 10",
        observedValues: ["notebook", "mug", 10],
      },
    ],
  });
  const output = compileCapabilityCaseGeneration(input, model, discovery);
  assert.equal("limit" in output.validationSuite.cases[1].input, false);
});

test("one case is a capability; two identical ones are not a reason to refuse it", async () => {
  // A site with one date control and one day on it offers one value, and
  // demanding a second distinct case meant the capability was never generated.
  // What still decides a replay is running it: a terminal outcome, an output
  // the schema accepts, the contract's conditions holding on the page, and
  // cases meant to differ that did not all come back the same.
  const { input, model, discovery } = await setup();
  model.cases[1] = structuredClone(model.cases[0]);
  const output = compileCapabilityCaseGeneration(input, model, discovery);
  assert.ok(output.validationSuite.cases.length >= 1);
});

test("C2 takes a value the page never showed, and says so in the evidence", async () => {
  // A search box takes words that are nowhere on the page it stands on, and
  // the demonstration's own input is usually one of them. Refusing those
  // values refused the capability; whether it works is decided by running it.
  const { input, model, discovery } = await setup();
  model.cases[1].input.query = "phone";
  const compiled = compileCapabilityCaseGeneration(input, model, discovery);
  assert.equal(compiled.validationSuite.cases[1].input.query, "phone");
  const mapped = compiled.caseDiscoveryEvidence.cases[1].parameters[0];
  assert.equal(mapped.regionId, "", "页面上没有的值,不假装它来自某个区域");
  assert.equal(mapped.observedValue, "phone");
});

test("C2 takes a target value that only a control offered", async () => {
  const { input, model, discovery } = await setup();
  discovery.regions.push({
    regionId: "region_search_control",
    url: input.browser.startUrl,
    kind: "control-group",
    text: "Search products",
    observedValues: ["Search products"],
    controlOptions: ["Search products"],
  });
  model.cases[0].input.query = "Search products";
  const compiled = compileCapabilityCaseGeneration(input, model, discovery);
  assert.equal(compiled.validationSuite.cases[0].input.query, "Search products");
});

test("C2 takes a combination no single region held", async () => {
  const { input, model } = await setup();
  addCategoryParameter(input, model);
  const discovery = discoveryFor(input, {
    regions: [
      {
        regionId: "region_queries",
        url: input.browser.startUrl,
        kind: "business-region",
        text: "queries",
        observedValues: ["notebook", "mug"],
      },
      {
        regionId: "region_categories",
        url: input.browser.startUrl,
        kind: "control-group",
        text: "categories",
        observedValues: ["ceramics", "office"],
      },
    ],
  });
  const compiled = compileCapabilityCaseGeneration(input, model, discovery);
  assert.equal(compiled.validationSuite.cases.length, model.cases.length);
  // A combination the page never showed together may simply have no data
  // behind it; the run says so, and the case is not refused before it runs.
  assert.equal(compiled.caseDiscoveryEvidence.cases[0].associationId, undefined);
});

test("C2 accepts a cross-region combination backed by an explorer association", async () => {
  const { input, model } = await setup();
  addCategoryParameter(input, model);
  const discovery = discoveryFor(input, {
    regions: [
      {
        regionId: "region_queries",
        url: input.browser.startUrl,
        kind: "business-region",
        text: "queries",
        observedValues: ["notebook", "mug"],
      },
      {
        regionId: "region_categories",
        url: input.browser.startUrl,
        kind: "control-group",
        text: "categories",
        observedValues: ["ceramics", "office"],
      },
    ],
    associations: [
      {
        associationId: "association_filters",
        regionIds: ["region_queries", "region_categories"],
        inputPaths: ["query", "category"],
        reason: "same search form",
      },
    ],
  });
  const output = compileCapabilityCaseGeneration(input, model, discovery);
  assert.equal(
    output.caseDiscoveryEvidence.cases[0].associationId,
    "association_filters",
  );
});

test("C2 rejects a declared parameter that the program does not consume", async () => {
  const { input, model, discovery } = await setup();
  input.candidate.program.stages.forEach((stage) => {
    stage.io.reads.input = [];
  });
  assert.throws(
    () => compileAfterCandidateChange(input, model, discovery),
    /case_generation_program_input_not_consumed:query/,
  );
});

test("C2 requires exactly one role for each declared parameter", async () => {
  const { input, model, discovery } = await setup();
  input.candidate.program.parameterRoles = [];
  assert.throws(
    () => compileAfterCandidateChange(input, model, discovery),
    /case_generation_parameter_role_required:query/,
  );
});

test("C2 rejects duplicate roles for one declared parameter", async () => {
  const { input, model, discovery } = await setup();
  input.candidate.program.parameterRoles.push({
    inputPath: "query",
    role: "value",
  });
  assert.throws(
    () => compileAfterCandidateChange(input, model, discovery),
    /case_generation_parameter_role_required:query/,
  );
});

test("C2 rejects roles for undeclared parameters", async () => {
  const { input, model, discovery } = await setup();
  input.candidate.program.parameterRoles.push({
    inputPath: "ghost",
    role: "value",
  });
  assert.throws(
    () => compileAfterCandidateChange(input, model, discovery),
    /case_generation_parameter_role_undeclared:ghost/,
  );
});

test("C2 requires exactly one binding for each target parameter", async () => {
  const { input, model, discovery } = await setup();
  input.candidate.program.targetBindings = [];
  assert.throws(
    () => compileAfterCandidateChange(input, model, discovery),
    /case_generation_target_binding_required:query/,
  );
});

test("C2 rejects target bindings attached to a value role", async () => {
  const { input, model, discovery } = await setup();
  input.candidate.program.parameterRoles[0].role = "value";
  assert.throws(
    () => compileAfterCandidateChange(input, model, discovery),
    /case_generation_target_binding_role_invalid:query/,
  );
});

test("C2 rejects a target binding whose identity state is never written", async () => {
  const { input, model, discovery } = await setup();
  input.candidate.program.targetBindings[0].identityStatePath =
    "targets.neverWritten";
  assert.throws(
    () => compileAfterCandidateChange(input, model, discovery),
    /case_generation_target_binding_unwritten:query/,
  );
});

test("C2 rejects non-deterministic contract conditions", async () => {
  const { input, model, discovery } = await setup();
  input.candidate.contract.successConditions = [
    { type: "modelJudge", prompt: "looks correct" },
  ];
  assert.throws(
    () => compileAfterCandidateChange(input, model, discovery),
    /case_generation_condition_not_deterministic:successConditions\.0:modelJudge/,
  );
});

test("C2 requires at least one deterministic success condition", async () => {
  const { input, model, discovery } = await setup();
  input.candidate.contract.successConditions = [];
  assert.throws(
    () => compileAfterCandidateChange(input, model, discovery),
    /case_generation_deterministic_success_condition_required/,
  );
});

test("C2 model output cannot contain a candidate rewrite", () => {
  assert.throws(
    () =>
      decodeCapabilityCaseModelOutput({
        candidate: { name: "rewritten" },
        cases: [{ input: {}, expected: {} }],
      }),
    /case_generation_candidate_rewrite_forbidden/,
  );
});

test("C2 model output accepts only 1-12 current-shape cases", () => {
  assert.throws(
    () =>
      decodeCapabilityCaseModelOutput({
        validationCases: [{ query: "notebook" }],
      }),
    /case_generation_model_fields_invalid/,
  );
  assert.throws(
    () =>
      decodeCapabilityCaseModelOutput({
        cases: Array.from({ length: 13 }, () => ({ input: {}, expected: {} })),
      }),
    /case_generation_cases_too_many/,
  );
  assert.throws(
    () => decodeCapabilityCaseModelOutput({ cases: [{ input: {} }] }),
    /case_generation_model_case_shape_invalid/,
  );
});

test("C2 compiler leaves its candidate input immutable and returns a detached copy", async () => {
  const { input, model, discovery } = await setup();
  const before = canonicalCapabilityCaseJson(input.candidate);
  const output = compileCapabilityCaseGeneration(input, model, discovery);
  output.candidate.name = "changed output";
  assert.equal(canonicalCapabilityCaseJson(input.candidate), before);
});

test("C2 maps every case value to an observed sidecar value", async () => {
  const { input, model, discovery } = await setup();
  const output = compileCapabilityCaseGeneration(input, model, discovery);
  const mug = output.caseDiscoveryEvidence.cases[1].parameters.find(
    (item) => item.inputPath === "query",
  );
  const region = output.caseDiscoveryEvidence.regions.find(
    (item) => item.regionId === mug.regionId,
  );
  assert.equal(region.observedValues.includes(mug.observedValue), true);
});

test("C2 rejects a performed submit recorded by exploration", async () => {
  const { input, model } = await setup();
  const discovery = discoveryFor(input, {
    explorationMode: "evidence-only",
    actions: [
      {
        action: "submit",
        outcome: "performed",
        url: input.browser.startUrl,
        reason: "unsafe",
        requestMethod: "POST",
      },
    ],
  });
  assert.throws(
    () => compileCapabilityCaseGeneration(input, model, discovery),
    /case_discovery_submit_performed_forbidden/,
  );
});

test("C2 rejects any performed non-GET request recorded by exploration", async () => {
  const { input, model } = await setup();
  const discovery = discoveryFor(input, {
    actions: [
      {
        action: "inspect",
        outcome: "performed",
        url: input.browser.startUrl,
        reason: "unsafe",
        requestMethod: "PATCH",
      },
    ],
  });
  assert.throws(
    () => compileCapabilityCaseGeneration(input, model, discovery),
    /case_discovery_non_get_performed_forbidden/,
  );
});

test("C2 evidence-only exploration rejects performed search actions", async () => {
  const { input, model } = await setup();
  const discovery = discoveryFor(input, {
    explorationMode: "evidence-only",
    actions: [
      {
        action: "search",
        outcome: "performed",
        url: input.browser.startUrl,
        reason: "interactive search",
        requestMethod: "GET",
      },
    ],
  });
  assert.throws(
    () => compileCapabilityCaseGeneration(input, model, discovery),
    /case_discovery_mode_action_mismatch/,
  );
});

test("C2 sanitizes discovery evidence before persistence", async () => {
  const { input } = await setup();
  const discovery = discoveryFor(input);
  discovery.password = "private";
  discovery.regions[0].url = `${input.browser.startUrl}?token=private#secret`;
  discovery.regions[0].text = "authorization=Bearer private-token";
  discovery.regions[0].observedValues.push(
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature",
    "ghp_" + "A".repeat(32),
  );
  const sanitized = sanitizeCapabilityCaseDiscoveryEvidence(discovery);
  assert.equal("password" in sanitized, false);
  assert.equal(
    new URL(sanitized.regions[0].url).searchParams.has("token"),
    false,
  );
  assert.doesNotMatch(sanitized.regions[0].text, /private-token/);
  assert.doesNotMatch(JSON.stringify(sanitized), /eyJhbGci|ghp_/);
});

test("C2 rejects invalid UTF-8 evidence bytes before JSON parsing or hash comparison", async () => {
  const bytes = Uint8Array.from([
    0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
  ]);
  assert.throws(
    () =>
      parseCapabilityCaseDiscoveryEvidenceSidecar(bytes, {
        artifactRef: "artifact://invalid-utf8",
        contentHash: `sha256:${"0".repeat(64)}`,
        byteLength: bytes.byteLength,
      }),
    /case_discovery_evidence_json_invalid/,
  );
});

test("C2 rejects discovery evidence larger than 64 KiB", async () => {
  const { input } = await setup();
  const evidence = {
    ...discoveryFor(input),
    regions: Array.from({ length: 128 }, (_, index) => ({
      regionId: `region_${index + 1}`,
      url: input.browser.startUrl,
      kind: "business-region",
      text: `${index}:`.padEnd(600, "x"),
      observedValues: [index],
    })),
    cases: [],
  };
  assert.ok(
    Buffer.byteLength(canonicalCapabilityCaseJson(evidence)) >
      CAPABILITY_CASE_DISCOVERY_EVIDENCE_MAX_BYTES,
  );
  assert.throws(
    () =>
      parseCapabilityCaseDiscoveryEvidenceSidecar(evidence, {
        artifactRef: "artifact://oversized",
        contentHash: `sha256:${"0".repeat(64)}`,
        byteLength: 0,
      }),
    /case_discovery_evidence_too_large/,
  );
});

test("C2 rejects a tampered discovery evidence hash", async () => {
  const { input, model, discovery } = await setup();
  const compiled = compileCapabilityCaseGeneration(input, model, discovery);
  assert.throws(
    () =>
      parseCapabilityCaseDiscoveryEvidenceSidecar(
        compiled.caseDiscoveryEvidenceBytes,
        {
          artifactRef: "artifact://tests/c2-evidence",
          contentHash: `sha256:${"0".repeat(64)}`,
          byteLength: compiled.caseDiscoveryEvidenceByteLength,
        },
      ),
    /case_discovery_evidence_content_hash_mismatch/,
  );
});

test("C2 caseId and validationSuiteHash are stable for identical inputs", async () => {
  const { input, model, discovery } = await setup();
  const first = compileCapabilityCaseGeneration(input, model, discovery);
  const second = compileCapabilityCaseGeneration(
    structuredClone(input),
    structuredClone(model),
    structuredClone(discovery),
  );
  assert.deepEqual(
    first.validationSuite.cases.map((item) => item.caseId),
    ["case_1", "case_2"],
  );
  assert.equal(first.validationSuiteHash, second.validationSuiteHash);
  assert.equal(
    first.validationSuiteHash,
    capabilityValidationSuiteHash(first.validationSuite),
  );
});

test("C2 validationSuiteHash covers deterministic expected assertions", async () => {
  const { input, model, discovery } = await setup();
  const first = compileCapabilityCaseGeneration(input, model, discovery);
  model.cases[0].expected = { query: "notebook" };
  const changed = compileCapabilityCaseGeneration(input, model, discovery);
  assert.notEqual(changed.validationSuiteHash, first.validationSuiteHash);
});

test("C2 final output requires the persisted evidence identity", async () => {
  const { input, model, discovery } = await setup();
  const compiled = compileCapabilityCaseGeneration(input, model, discovery);
  const output = finalizeCapabilityCaseGeneration(compiled, {
    artifactRef: "artifact://tests/c2-evidence",
  });
  const decoded = decodeC2CaseGenerationOutput(output);
  assert.deepEqual(decoded.caseDiscoveryEvidenceRef, {
    artifactRef: "artifact://tests/c2-evidence",
    contentHash: compiled.caseDiscoveryEvidenceContentHash,
    byteLength: compiled.caseDiscoveryEvidenceByteLength,
  });
});

test("a case key that could not be a field name is refused as a broken response, not as a missing field", () => {
  assert.throws(
    () => decodeCapabilityCaseModelOutput({ cases: [{ input: { ": 1, ": 1 }, expected: {} }] }),
    /case_generation_model_keys_invalid:0:input:": 1, "/,
  );
  assert.throws(
    () => decodeCapabilityCaseModelOutput({ cases: [{ input: { rank: 1 }, expected: { "": "x" } }] }),
    /case_generation_model_keys_invalid:0:expected:""/,
  );
  // Real field names, including non-ASCII ones, pass through.
  assert.deepEqual(decodeCapabilityCaseModelOutput({ cases: [{ input: { rank: 1, 关键词: "a" }, expected: { targetTitle: "t" } }] }).cases[0].input, { rank: 1, 关键词: "a" });
});

/* -------------------------------------------------------------------- */
/* Deterministic derivation                                               */
/* -------------------------------------------------------------------- */

function regionsFor(input, regions) {
  return discoveryFor(input, {
    regions: regions.map((region, index) => ({
      regionId: region.regionId || `region_${index + 1}`,
      url: input.browser.startUrl,
      kind: region.kind || "business-region",
      text: region.text || region.observedValues.map(String).join(" "),
      observedValues: region.observedValues,
      ...(region.controlOptions ? { controlOptions: region.controlOptions } : {}),
    })),
  });
}

function dateCandidate(input) {
  const next = JSON.parse(JSON.stringify(input));
  next.candidate.contract.inputSchema = {
    type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" } }, required: ["date"], additionalProperties: false,
  };
  next.candidate.contract.preconditions = [{ type: "inputExists", path: "date" }];
  next.candidate.contract.successConditions = [{ type: "textTemplate", template: "{{date}}" }, { type: "outputExists", path: "heading" }];
  next.candidate.program.parameterRoles = [{ inputPath: "date", role: "context" }];
  next.candidate.program.targetBindings = [];
  for (const stage of next.candidate.program.stages) stage.io.reads.input = ["date"];
  next.demonstrationParameters = { date: "2026-03-11" };
  return next;
}

test("cases are derived from the evidence: the demonstration, then the values the page presents", async () => {
  const { input } = await setup();
  const discovery = regionsFor(input, [
    { observedValues: ["Notebook", "Hardcover ruled notebook", 12] },
    { observedValues: ["Mug", "Ceramic coffee mug"] },
    { kind: "page-summary", observedValues: ["Product search", "Notebook", "Mug", "Pen"] },
  ]);
  const derived = deriveCapabilityCases(input, discovery);
  // The demonstration leads: it is the one input this capability is known to
  // work for. Then headings, in the order the regions were ranked; the number
  // 12 is not a string and never a query.
  assert.deepEqual(derived.cases.map((item) => item.input), [
    { query: "notebook" }, { query: "Notebook" }, { query: "Mug" },
  ]);
  // A target is grounded by a business region; the page summary's "Pen" is
  // not a case.
  assert.ok(derived.cases.every((item) => item.regionId !== "region_3"));
  // An output that carries the input's name and type echoes it.
  assert.deepEqual(derived.cases[0].expected, { query: "notebook" });
  assert.deepEqual(derived.cases[1].expected, { query: "Notebook" });
  // The case is anchored to its own region; what the enrichment turn may
  // choose from is every value the page offered for that field, its own
  // region's first. Held to one region, the turn could only pick among that
  // region's words — a page's FAQ questions, where the field wanted a search
  // term — and had no better answer available to it.
  assert.deepEqual(derived.cases[1].alternatives, {
    query: ["Notebook", "Hardcover ruled notebook", "Mug", "Ceramic coffee mug"],
  });
  assert.deepEqual(derived.fields, [{ path: "query", required: true, witness: "notebook", admissible: 4 }]);
  // And the compiler accepts exactly this, with no model in between.
  const compiled = compileCapabilityCaseGeneration(
    input,
    { cases: derived.cases.map(({ input: caseInput, expected }) => ({ input: caseInput, expected })) },
    discovery,
  );
  assert.equal(compiled.validationSuite.cases.length, 3);
  assert.equal(compiled.caseDiscoveryEvidence.cases[2].parameters[0].regionId, "region_2");
});

test("what the page shows are suggestions; the demonstration is a case in its own right", async () => {
  const { input } = await setup();
  const dated = dateCandidate(input);
  // The writing an input takes decides what the page may suggest for it, and
  // nothing else. It used to decide whether the capability was allowed to
  // exist: a page writing its dates one way and a person writing theirs
  // another refused the capability outright. Now a value in another writing
  // is simply not one of the page's suggestions, and 「微博」 — a word of the
  // site, not a day — is not one either.
  const discovery = regionsFor(dated, [
    { kind: "page-summary", observedValues: ["2026-03-11", "微博", "2026年03月11日", "2026-03-10", 15, "2026/03/12"] },
  ]);
  const derived = deriveCapabilityCases(dated, discovery);
  assert.deepEqual(derived.cases.map((item) => item.input), [
    { date: "2026-03-11" },
    { date: "2026-03-10" },
  ]);

  // A page with almost nothing on it no longer refuses the capability: the one
  // input it is known to work for is a case.
  const sparse = deriveCapabilityCases(dated, regionsFor(dated, [{ kind: "page-summary", observedValues: ["热搜"] }]));
  assert.ok(sparse.cases.length >= 1, "证据少不再是拒绝的理由");
  assert.ok(
    sparse.cases.some((item) => item.input.date === dated.demonstrationParameters.date),
    `演示值必须在用例里：${JSON.stringify(sparse.cases.map((item) => item.input))}`,
  );
});

test("a word the page happens to show is not a value of every input that takes a string", async () => {
  // 查看指定日期的微博热搜榜单, on the deployed installation. The contract
  // declared `date` as `{type:"string"}` and put its writing in a description
  // no code reads, so the page's own words 「热搜」 and 「日期」 were admitted
  // as days. Three cases asked for the same day in the end, every one came
  // back with the same targetTitle, and the capability was failed for a
  // program that was never given a second day to answer about.
  const { input } = await setup();
  const dated = dateCandidate(input);
  dated.demonstrationParameters = { date: "2026年9月20日" };
  dated.candidate.contract.inputSchema.properties.date = {
    type: "string",
    description: "要查看的微博热搜日期。取值写法与示例一致，例如「2026年9月20日」。",
    examples: ["2026年9月20日"],
  };
  const derived = deriveCapabilityCases(
    dated,
    regionsFor(dated, [{ kind: "page-summary", observedValues: ["热搜", "日期", "2026年9月19日", "微博"] }]),
  );
  assert.deepEqual(derived.cases.map((item) => item.input), [
    { date: "2026年9月20日" },
    { date: "2026年9月19日" },
  ]);
  assert.deepEqual(derived.cases[0].alternatives, { date: ["2026年9月19日"] });

  // And where the site offers no second day, the capability keeps the one day
  // it is known to work for rather than three questions about nothing.
  const alone = deriveCapabilityCases(
    dated,
    regionsFor(dated, [{ kind: "page-summary", observedValues: ["热搜", "日期", "微博"] }]),
  );
  assert.deepEqual(alone.cases.map((item) => item.input), [{ date: "2026年9月20日" }]);
});

test("a multi-value case is grounded by one region, and never gives two inputs the same value", async () => {
  const { input } = await setup();
  const paired = JSON.parse(JSON.stringify(input));
  addCategoryParameter(paired, { cases: [{ input: {} }, { input: {} }] });
  paired.demonstrationParameters = { query: "notebook", category: "office" };
  const discovery = regionsFor(paired, [
    { observedValues: ["Notebook", "office"] },
    { observedValues: ["Mug", "ceramics"] },
    { kind: "page-summary", observedValues: ["Notebook", "Mug", "office", "ceramics"] },
  ]);
  const derived = deriveCapabilityCases(paired, discovery);
  assert.deepEqual(derived.cases.map((item) => item.input), [
    { query: "notebook", category: "office" },
    { query: "Notebook", category: "office" },
    { query: "Mug", category: "ceramics" },
  ]);
  // Each page-derived case is still grounded by one region, and no case gives
  // two inputs the same value.
  assert.deepEqual(derived.cases.slice(1).map((item) => item.regionId), ["region_1", "region_2"]);
});

// The demonstration chose "Home office" from "Shop by room"; the product cards
// above it are records, not rooms. Recorded on the demo store, where the cases
// asked the room filter for "Lune Table Lamp" and "Arden Floor Lamp".
test("an input's other cases come from the group of choices its demonstrated value was taken from", async () => {
  const { input } = await setup();
  // A filter value, like the recorded roomContext; a target is a record by definition.
  input.candidate.program.parameterRoles = [{ inputPath: "query", role: "value" }];
  input.demonstrationParameters = { query: "Home office" };
  const discovery = regionsFor(input, [
    { observedValues: ["Lune Table Lamp", "Table lamp · 2700K · Dimmable", "$129"] },
    { observedValues: ["Arden Floor Lamp", "Floor lamp · 2700K · Dimmable", "$289"] },
    { kind: "page-summary", observedValues: ["Shop by room", "Light for every room", "Living room", "Bedroom", "Home office", "Dining", "living", "office", "ROOM", "Home"] },
    { kind: "page-summary", observedValues: ["Lune Table Lamp", "Arden Floor Lamp", "Shop by room", "Living room", "Bedroom", "Home office", "Dining", "Shop all lighting"] },
  ]);
  const derived = deriveCapabilityCases(input, discovery);
  assert.deepEqual(derived.cases.map((item) => item.input.query), ["Home office", "Living room", "Bedroom"]);
});

test("a value written in a list takes the list's other items as its cases, one input changed at a time", async () => {
  const { input } = await setup();
  addCategoryParameter(input, { cases: [{ input: {} }, { input: {} }] });
  input.demonstrationParameters = { query: "Brass", category: "US plug (Type A/B)" };
  const discovery = regionsFor(input, [
    { observedValues: ["Lune Table Lamp", "3 finishes: Brass, Matte black, Chalk white", "Brass", "Matte", "black", "Chalk", "white", "Dimmable"] },
  ]);
  const derived = deriveCapabilityCases(input, discovery);
  assert.deepEqual(derived.cases.map((item) => item.input), [
    { query: "Brass", category: "US plug (Type A/B)" },
    { query: "Matte black", category: "US plug (Type A/B)" },
    { query: "Chalk white", category: "US plug (Type A/B)" },
  ]);
});

test("a value the harvest found in a list takes that list's other items as its cases, not the card beside it", async () => {
  // "Poetry" sat in the catalogue's category list; the cases built for the
  // category input took "In stock" and a book's title from the first product
  // card, and the reviewer rejected a working program for what they came to.
  const { input } = await setup();
  addCategoryParameter(input, { cases: [{ input: {} }, { input: {} }] });
  input.demonstrationParameters = { query: "Brass", category: "Poetry" };
  const discovery = regionsFor(input, [
    { observedValues: ["A Light in the ...", "£51.77", "In stock", "Add to basket", "Tipping the Velvet", "Brass"] },
    { kind: "choice-list", observedValues: ["Travel", "Mystery", "Historical Fiction", "Poetry", "Science"] },
  ]);
  const derived = deriveCapabilityCases(input, discovery);
  assert.deepEqual(derived.cases.map((item) => item.input), [
    { query: "Brass", category: "Poetry" },
    { query: "Brass", category: "Travel" },
    { query: "Brass", category: "Mystery" },
  ]);
  assert.deepEqual(derived.cases[0].alternatives.category, ["Poetry", "Travel", "Mystery", "Historical Fiction", "Science"], "the suggestions beside the demonstration are the list's items and nothing else");
  assert.ok(derived.cases.every((item) => !["In stock", "Tipping the Velvet"].includes(item.input.category)));
});

test("the inputs a case took from a list the page offers are named, and no others", async () => {
  const { input } = await setup();
  const discovery = regionsFor(input, [
    { observedValues: ["A Light in the ...", "In stock", "Tipping the Velvet"] },
    { kind: "choice-list", observedValues: ["Travel", "Mystery", "Poetry"] },
  ]);
  assert.deepEqual(offeredInputPaths({ category: "Mystery", query: "In stock" }, discovery.regions), ["category"], "a card's text is not a list of choices");
  assert.deepEqual(offeredInputPaths({ category: "Attic" }, discovery.regions), []);
  assert.deepEqual(offeredInputPaths({ category: "Mystery" }, []), []);
});

test("a defaulted optional input is left out by one case", async () => {
  const { input } = await setup();
  addOptionalLimit(input);
  input.demonstrationParameters = { query: "notebook", limit: 10 };
  const discovery = regionsFor(input, [
    { observedValues: ["Notebook", 5] },
    { observedValues: ["Mug", 20] },
  ]);
  const derived = deriveCapabilityCases(input, discovery);
  assert.deepEqual(derived.cases.map((item) => item.input), [
    { query: "notebook", limit: 10 }, { query: "Notebook", limit: 5 }, { query: "Mug" },
  ]);
  const compiled = compileCapabilityCaseGeneration(
    input,
    { cases: derived.cases.map(({ input: caseInput, expected }) => ({ input: caseInput, expected })) },
    discovery,
  );
  assert.equal(compiled.validationSuite.cases.length, 3);
});

test("a capability without inputs gets one empty case", async () => {
  const { input } = await setup();
  const bare = JSON.parse(JSON.stringify(input));
  bare.candidate.contract.inputSchema = { type: "object", properties: {}, additionalProperties: false };
  bare.candidate.contract.preconditions = [];
  bare.candidate.contract.successConditions = [{ type: "outputExists", path: "heading" }];
  bare.candidate.program.parameterRoles = [];
  bare.candidate.program.targetBindings = [];
  for (const stage of bare.candidate.program.stages) stage.io.reads.input = [];
  delete bare.demonstrationParameters;
  const derived = deriveCapabilityCases(bare, regionsFor(bare, [{ observedValues: ["Notebook"] }]));
  assert.deepEqual(derived.cases.map((item) => item.input), [{}]);
});

test("the demonstration witness is held to the Contract", async () => {
  const { input } = await setup();
  assert.throws(
    () => decodeC2CaseGenerationInput({ ...input, demonstrationParameters: { colour: "red" } }),
    /case_generation_demonstration_undeclared:colour/u,
  );
  assert.throws(
    () => decodeC2CaseGenerationInput({ ...input, demonstrationParameters: "notebook" }),
    /case_generation_demonstration_invalid/u,
  );
  assert.deepEqual(decodeC2CaseGenerationInput(input).demonstrationParameters, { query: "notebook" });
});

