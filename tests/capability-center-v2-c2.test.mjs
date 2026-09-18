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

test("C2 rejects duplicate parameterized cases", async () => {
  const { input, model, discovery } = await setup();
  model.cases[1] = structuredClone(model.cases[0]);
  assert.throws(
    () => compileCapabilityCaseGeneration(input, model, discovery),
    /case_generation_independent_cases_required/,
  );
});

test("C2 rejects a model value absent from discovery evidence", async () => {
  const { input, model, discovery } = await setup();
  model.cases[1].input.query = "phone";
  assert.throws(
    () => compileCapabilityCaseGeneration(input, model, discovery),
    /case_evidence_value_required:1:query/,
  );
});

test("C2 rejects a target value observed only as control text", async () => {
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
  assert.throws(
    () => compileCapabilityCaseGeneration(input, model, discovery),
    /case_evidence_value_required:0:query/,
  );
});

test("C2 rejects an unassociated cross-region parameter combination", async () => {
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
  assert.throws(
    () => compileCapabilityCaseGeneration(input, model, discovery),
    /case_evidence_same_region_required:0/,
  );
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
