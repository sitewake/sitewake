import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "node:http";

process.env.CAPABILITY_V2_AUTO_DISPATCH = "0";
delete process.env.OPENAI_API_KEY;
const bundle = await build({
  entryPoints: [
    fileURLToPath(
      new URL("./helpers/capability-v2-test-entry.ts", import.meta.url),
    ),
  ],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const store = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const {
  actOnCapability,
  advanceCompletedTask,
  applyCapabilityInputAliases,
  beginVersionReview,
  canonicalCapabilityCaseJson,
  capabilityCandidateHash,
  capabilityValidationSuiteHash,
  capabilityModuleHash,
  capabilityUrlIncludes,
  capabilityTemplateInputPaths,
  capabilityUrlTemplateMatches,
  claimTask,
  cleanParameterPlan,
  withoutGoalEchoes,
  decomposeCompositeSearchParameter,
  evaluateResultDeterministic,
  executeProgram,
  createCapabilityMaintenanceTask,
  createCapability,
  createCapabilityTask,
  completeC2CaseGeneration,
  createValidatedCapabilityPackage,
  classifyCapabilityGeneration,
  getCapability,
  getCapabilityMaintenanceDefaults,
  getCapabilityV2Module,
  getRunnerRunSpec,
  outputsConstantAcrossCases,
  pinContractToBase,
  inspectContractConsistency,
  getTask,
  getTaskMaintenance,
  groundExplorerAction,
  hasVolatileNumber,
  typedInDemonstration,
  inferCapabilityScope,
  inspectCapabilityJavaScriptProgram,
  inspectCapabilityQuality,
  isSuspiciousDetailTransition,
  listCapabilities,
  listPendingTaskSites,
  listRunners,
  listTaskEvents,
  listTasks,
  listVersions,
  modelCompatibility,
  normalizeCapabilityJavaScriptProgram,
  normalizeContractCondition,
  normalizeContractConditions,
  normalizeContractOutputSchema,
  alignSuccessConditionsToEvidence,
  normalizeCapabilityExperience,
  overrideRepeatedAction,
  stabilizeSuccessConditions,
  validateContractDesignResponse,
  stripJavaScriptComments,
  normalizeExplorerAction,
  normalizeExplorerInputPath,
  projectExplorationInput,
  InvalidModelInputPathError,
  markRunnerLost,
  parseAndValidateToolArguments,
  parseCapabilityExperienceAbstraction,
  parseStructuredModelJson,
  projectProductionStatus,
  REVIEW_APPROVED_ON_VALIDATION,
  REVIEW_NO_CASE_PASSED,
  REVIEW_OFFERED_INPUT_NO_RESULT,
  rejectMismatchedFacetAction,
  promptProvenance,
  publishVersion,
  putCapabilityV2Module,
  publishValidatedCapability,
  getGenerationPublication,
  getCapabilityClassificationReservation,
  reviewValidatedCandidate,
  registerRunner,
  renderCapabilityInputTemplate,
  matchCapabilityIntentTemplate,
  renderCapabilityGoal,
  requestStructuredModelJson,
  requestTaskInteraction,
  requestToolCallingTurn,
  saveTaskArtifact,
  resetCapabilityCenterV2ForTests,
  resetCapabilityV2ModulesForTests,
  respondTaskInteraction,
  reviewVersion,
  strategiesFor,
  setTaskArchived,
  submitTaskResult: submitTaskResultRaw,
  validateCapabilityJavaScriptSource,
  groundingExamplesDiffer,
} = store;

test("an experience's identifiers survive the redaction that a card-like digit run would trigger", () => {
  // The run id's last thirteen digits pass the card-number check; redacted,
  // the experience named a run that did not exist, its authority never
  // matched it, and the visitor's successful run was never generated from.
  const experience = pageAgentExperience({
    episodeId: "episode_4111111111111111",
    agentRunId: "run_2864beef-7d4e-4de3-93c8-975708864470",
    browserSessionId: "browser_5500000000000004",
    outcomeSummary: "Order 4111 1111 1111 1111 was placed.",
  });
  assert.equal(experience.agentRunId, "run_2864beef-7d4e-4de3-93c8-975708864470");
  assert.equal(experience.episodeId, "episode_4111111111111111");
  assert.equal(experience.browserSessionId, "browser_5500000000000004");
  assert.doesNotMatch(experience.outcomeSummary, /4111 1111 1111 1111/, "what the visitor was told is still redacted");
});

function pageAgentExperience(overrides = {}) {
  return normalizeCapabilityExperience({
    schemaVersion: "1.0",
    episodeId: "episode-search-1",
    agentRunId: "run-search-1",
    browserSessionId: "browser-search-1",
    originalGoal: "搜索 Echo 桌面音箱",
    outcome: "Success",
    outcomeSummary: "已经展示 Echo 的搜索结果",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:00:03.000Z",
    startPage: {
      url: "https://shop.example.test/demo?token=private",
      title: "商品",
    },
    endPage: {
      url: "https://shop.example.test/demo/search?q=Echo",
      title: "搜索结果",
      heading: "Echo",
    },
    actions: [
      {
        action: "fill",
        rawAction: "input_text",
        input: { index: 3, text: "Echo", password: "must-not-persist" },
        element: {
          tag: "input",
          role: "searchbox",
          placeholder: "搜索商品",
          attributes: { type: "search" },
          cssPath: "#private-selector",
        },
        page: {
          url: "https://shop.example.test/demo",
          title: "商品",
          heading: "商品",
        },
        observedAt: "2026-08-09T00:00:01.000Z",
      },
      {
        action: "click",
        rawAction: "click_element_by_index",
        input: { index: 4 },
        element: {
          tag: "button",
          accessibleName: "搜索",
          attributes: {},
          cssPath: "#search",
        },
        page: {
          url: "https://shop.example.test/demo",
          title: "商品",
          heading: "商品",
        },
        observedAt: "2026-08-09T00:00:02.000Z",
      },
    ],
    output: { query: "Echo", resultCount: 1, accessToken: "must-not-persist" },
    ...overrides,
  });
}

const siteId = "site-v2-test";
let program;
let programSource;

async function makeProgram(source, options = {}) {
  const stored = await putCapabilityV2Module(siteId, source);
  const wildcardIO = {
    reads: { input: [], state: [] },
    writes: { state: ["*"], output: ["*"] },
  };
  const stages = (
    options.stages || [
      {
        id: "complete",
        title: "Complete",
        purpose: "Complete the requested browser operation",
        effect: "read",
        resumePolicy: "skip-completed",
      },
    ]
  ).map((stage) => ({
    ...stage,
    io: stage.io || wildcardIO,
    navigation: stage.navigation || "none",
  }));
  return {
    schemaVersion: "2.0",
    runtime: "BrowserJavaScriptStage",
    module: stored.module,
    entry: options.entry || { mode: "CurrentPage" },
    stages,
    parameterRoles: options.parameterRoles || [],
    targetBindings: options.targetBindings || [],
    promptProvenance: options.promptProvenance || [],
  };
}

async function formalGenerationOutputs(
  generationTaskId,
  candidate,
  inputs,
  expectedForInput = () => ({}),
) {
  const c1AuthoringOutput = {
    generationTaskId,
    ...candidate,
  };
  const validationSuite = {
    cases: inputs.map((input, index) => ({
      caseId: `case_${index + 1}`,
      input,
      expected: expectedForInput(input),
    })),
  };
  const regions = [];
  const evidenceCases = validationSuite.cases.map((testCase) => ({
    caseId: testCase.caseId,
    parameters: Object.entries(testCase.input).map(
      ([inputPath, observedValue]) => {
        const regionId = `region_${regions.length + 1}`;
        regions.push({
          regionId,
          url: "https://example.test/",
          kind: "business-region",
          text: String(observedValue),
          observedValues: [observedValue],
        });
        return { inputPath, regionId, observedValue };
      },
    ),
  }));
  if (!regions.length)
    regions.push({
      regionId: "region_1",
      url: "https://example.test/",
      kind: "page-summary",
      text: candidate.name,
      observedValues: [candidate.name],
    });
  const evidence = {
    schemaVersion: "1.0",
    generationTaskId,
    siteId,
    candidateHash: capabilityCandidateHash(candidate),
    explorationMode: "read-only-interactive",
    regions,
    actions: [
      {
        action: "inspect",
        outcome: "performed",
        url: "https://example.test/",
        reason: "test_page_observed",
        requestMethod: "GET",
      },
    ],
    cases: evidenceCases,
  };
  const evidenceBytes = new TextEncoder().encode(
    canonicalCapabilityCaseJson(evidence),
  );
  const savedEvidence = await saveTaskArtifact(siteId, generationTaskId, {
    kind: "CaseDiscoveryEvidence",
    contentType: "application/json",
    bytes: evidenceBytes,
  });
  const digest = await crypto.subtle.digest("SHA-256", evidenceBytes);
  return {
    c1AuthoringOutput,
    c2CaseGenerationOutput: {
      generationTaskId,
      candidate,
      validationSuite,
      caseDiscoveryEvidenceRef: {
        artifactRef: `artifact://${savedEvidence.artifact.id}`,
        contentHash: `sha256:${Buffer.from(digest).toString("hex")}`,
        byteLength: evidenceBytes.byteLength,
      },
      validationSuiteHash: capabilityValidationSuiteHash(validationSuite),
    },
  };
}

async function submitTaskResult(site, taskId, runnerId, result, error) {
  const task = await getTask(site, taskId, true);
  const candidateSource =
    (task?.type === "Discovery" || task?.type === "Repair") &&
    result.outcome === "Success" &&
    !result.candidateSource
      ? programSource
      : result.candidateSource;
  return submitTaskResultRaw(
    site,
    taskId,
    runnerId,
    candidateSource ? { ...result, candidateSource } : result,
    error,
  );
}
const contract = {
  intent: "测试能力",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  outputSchema: { type: "object", additionalProperties: true },
  preconditions: [],
  successConditions: [{ type: "urlIncludes", value: "example.test" }],
};

test("terminal PageAgent experience is compacted and strips credentials and implementation locators", () => {
  const experience = pageAgentExperience();
  assert.equal(
    new URL(experience.startPage.url).searchParams.has("token"),
    false,
  );
  assert.equal(experience.actions[0].input.text, "Echo");
  assert.equal("password" in experience.actions[0].input, false);
  assert.equal("cssPath" in experience.actions[0].element, false);
  assert.equal("accessToken" in experience.output, false);
});

test("experience abstraction requires action values to become reusable business parameters", () => {
  const experience = pageAgentExperience();
  const abstraction = parseCapabilityExperienceAbstraction(
    {
      name: "搜索商品",
      description: "按用户提供的关键词搜索商品并展示结果",
      aliases: ["查找商品"],
      intent: "使用指定关键词搜索商品并展示匹配结果",
      parameters: [
        {
          name: "query",
          type: "string",
          description: "商品搜索关键词",
          required: true,
          exampleValue: "Echo",
        },
      ],
    },
    experience,
  );
  assert.equal(abstraction.name, "搜索商品");
  assert.deepEqual(
    abstraction.parameters.map((item) => item.name),
    ["query"],
  );
  assert.throws(
    () =>
      parseCapabilityExperienceAbstraction(
        {
          name: "搜索 Echo 商品",
          description: "搜索 Echo 商品",
          aliases: [],
          intent: "搜索 Echo 商品",
          parameters: [
            {
              name: "query",
              type: "string",
              description: "搜索词",
              required: true,
              exampleValue: "Echo",
            },
          ],
        },
        experience,
      ),
    /experience_example_leaked_into_summary/,
  );
  assert.throws(
    () =>
      parseCapabilityExperienceAbstraction(
        {
          name: "搜索商品",
          description: "搜索商品并展示结果",
          aliases: [],
          intent: "搜索商品",
          parameters: [],
        },
        experience,
      ),
    /experience_action_value_not_parameterized/,
  );
});

test("only the values the visitor asked for must become parameters; the run's own choices may stay fixed", () => {
  // The demo session that sat in "waiting to retry" forever: the visitor asked
  // for a dimmable desk lamp in brass; the agent narrowed the shop with filters,
  // opened one product and picked a plug type nobody asked for.
  const page = { url: "https://lamps.example.test/product/lune-table-lamp", title: "Lune Table Lamp", heading: "Lune Table Lamp" };
  const select = (option, value) => ({ action: "select", rawAction: "select_dropdown_option", input: { option, value }, element: { tag: "select" }, page, observedAt: "2026-10-20T02:56:30.000Z" });
  const experience = pageAgentExperience({
    originalGoal: "Order a dimmable desk lamp in brass",
    endPage: page,
    actions: [
      select("Table lamp", "table"),
      select("Dimmable", "yes"),
      { action: "click", rawAction: "click_element_by_index", input: { index: 11 }, element: { tag: "button", accessibleName: "Brass" }, page, observedAt: "2026-10-20T02:56:50.000Z" },
      select("US plug (Type A/B)", "us"),
    ],
    routes: [{ url: "https://lamps.example.test/product/lune-table-lamp", bindings: { product: "lune-table-lamp" }, observedAt: "2026-10-20T02:56:44.000Z" }],
  });
  const abstraction = (parameters) => parseCapabilityExperienceAbstraction({
    name: "Order a lamp",
    description: "Order a table lamp with the requested feature and finish",
    aliases: [],
    intent: "Order a lamp with a given feature and finish",
    parameters,
  }, experience);
  const feature = { name: "feature", type: "string", description: "Lamp feature", required: true, exampleValue: "Dimmable" };
  const finish = { name: "finish", type: "string", description: "Lamp finish", required: true, exampleValue: "brass" };

  // The plug, the "Table lamp" filter and the product slug are the run's choices.
  assert.deepEqual(abstraction([feature, finish]).parameters.map((item) => item.name), ["feature", "finish"]);
  // "Dimmable" is the visitor's own word; leaving it out silently still fails, and says which value.
  assert.throws(() => abstraction([finish]), /experience_action_value_not_parameterized:Dimmable/);
  // Kept fixed and said out loud is honest, and is what the model wrote when
  // the two rules used to leave it no passing answer.
  const named = parseCapabilityExperienceAbstraction({
    name: "Order a dimmable desk lamp",
    description: "Order a dimmable desk lamp in the requested finish",
    aliases: [],
    intent: "Order a dimmable desk lamp in a given finish",
    parameters: [finish],
  }, experience);
  assert.deepEqual(named.parameters.map((item) => item.name), ["finish"]);
});

test("an input is a value the visitor chose, not a number that appears on the page", () => {
  // The demo's lamp abstraction required "quantity: 4" because the cart link
  // read "Cart, 4 items"; no recorded step ever set a quantity.
  const page = { url: "https://lamps.example.test/product/lune", title: "Lune", heading: "Lune" };
  const click = (role, accessibleName) => ({ action: "click", rawAction: "click_element_by_index", input: {}, element: { role, accessibleName }, page, observedAt: "2026-10-21T04:00:00.000Z" });
  const parse = (actions) => parseCapabilityExperienceAbstraction({
    name: "Order a lamp",
    description: "Order a lamp in the requested finish",
    aliases: [],
    intent: "Order a lamp in a given finish",
    parameters: [
      { name: "finish", type: "string", description: "Lamp finish", required: true, exampleValue: "Brass" },
      { name: "quantity", type: "number", description: "How many", required: true, exampleValue: 4 },
    ],
  }, pageAgentExperience({ originalGoal: "Order a lamp in brass", endPage: page, actions }));
  assert.deepEqual(parse([click("radio", "Brass"), click("link", "Cart, 4 items")]).parameters.map((item) => item.name), ["finish"]);
  // Typed, the same number is the visitor's.
  const typed = { action: "fill", rawAction: "input_text", input: { text: "4" }, element: { role: "spinbutton", accessibleName: "Quantity" }, page, observedAt: "2026-10-21T04:00:00.000Z" };
  assert.deepEqual(parse([click("radio", "Brass"), typed]).parameters.map((item) => item.name), ["finish", "quantity"]);
});

test("typed text is the visitor's data even when the summary names it", () => {
  const experience = pageAgentExperience();
  assert.throws(() => parseCapabilityExperienceAbstraction({
    name: "搜索 Echo 商品",
    description: "搜索 Echo 商品并展示结果",
    aliases: [],
    intent: "搜索 Echo 商品",
    parameters: [],
  }, experience), /experience_action_value_not_parameterized:Echo/);
});

test("a dropdown pick is one choice: its visible option or its form value covers it", () => {
  const page = { url: "https://lamps.example.test/product/lune", title: "Lune", heading: "Lune" };
  const experience = pageAgentExperience({
    originalGoal: "Order the lamp in brass",
    endPage: page,
    actions: [{ action: "select", rawAction: "select_dropdown_option", input: { option: "Brass", value: "sku-finish-07" }, element: { tag: "select" }, page, observedAt: "2026-10-20T02:56:30.000Z" }],
  });
  const result = parseCapabilityExperienceAbstraction({
    name: "Order a lamp",
    description: "Order the lamp in the requested finish",
    aliases: [],
    intent: "Order the lamp in a given finish",
    parameters: [{ name: "finish", type: "string", description: "Lamp finish", required: true, exampleValue: "Brass" }],
  }, experience);
  assert.deepEqual(result.parameters.map((item) => item.name), ["finish"]);
});

test("goal and summary checks match whole words, not fragments of other words", () => {
  const page = { url: "https://lamps.example.test/product/lune", title: "Lune", heading: "Lune" };
  const select = (option, value) => ({ action: "select", rawAction: "select_dropdown_option", input: { option, value }, element: { tag: "select" }, page, observedAt: "2026-10-20T02:56:30.000Z" });
  const experience = pageAgentExperience({
    originalGoal: "Order a red lamp for my focus corner",
    endPage: page,
    // "US" sits inside "focus" and was never asked for; "red" was.
    actions: [select("Red", "red"), select("US", "us")],
  });
  const parse = (fields) => parseCapabilityExperienceAbstraction({
    name: "Order a lamp",
    aliases: [],
    intent: "Order a lamp in a given colour",
    parameters: [{ name: "colour", type: "string", description: "Lamp colour", required: true, exampleValue: "red" }],
    ...fields,
  }, experience);
  // "red" inside "ordered" is not the example leaking into the summary.
  assert.equal(parse({ description: "Places an ordered lamp in the cart" }).parameters.length, 1);
  assert.throws(() => parse({ description: "Order a red lamp" }), /experience_example_leaked_into_summary:description:red/);
  // A Latin example pressed against Chinese text still counts as written there.
  assert.throws(() => parse({ description: "下单red台灯" }), /experience_example_leaked_into_summary/);
});

test("intrinsically stateful current-session operations may remain parameterless", () => {
  const experience = pageAgentExperience({
    episodeId: "episode-checkout-1",
    originalGoal: "提交购物车订单",
    actions: [
      {
        action: "click",
        rawAction: "click_element_by_index",
        input: { index: 8 },
        element: { tag: "button", accessibleName: "提交订单", attributes: {} },
        page: {
          url: "https://shop.example.test/demo/cart",
          title: "购物车",
          heading: "购物车",
        },
        observedAt: "2026-08-09T00:00:01.000Z",
      },
    ],
  });
  const abstraction = parseCapabilityExperienceAbstraction(
    {
      name: "提交购物车订单",
      description: "提交当前购物车中的商品并返回业务结果",
      aliases: ["购物车结算"],
      intent: "提交当前会话的购物车订单",
      parameters: [],
    },
    experience,
  );
  assert.deepEqual(abstraction.parameters, []);
});

test.beforeEach(async () => {
  resetCapabilityCenterV2ForTests();
  resetCapabilityV2ModulesForTests();
  programSource = `export const capability={version:2,stages:[{id:"complete",async run({input}){void input;return {outcome:"Success",output:{ok:true}}}}]};`;
  program = await makeProgram(programSource);
});

test("JavaScript module validation rejects unsafe or malformed bundles", () => {
  const valid =
    'export const capability={version:2,stages:[{id:"verify",async run(){return {outcome:"Success",output:{ok:true}}}}]};';
  assert.deepEqual(validateCapabilityJavaScriptSource(valid), { ok: true });
  const invalid = [
    ["", "capability_module_empty"],
    ["const capability={};", "capability_module_export_missing"],
    [
      "export const capability={run(){return eval('1')}};",
      "capability_module_dynamic_code_forbidden",
    ],
    [
      "export const capability={run(){return Function('return 1')()}};",
      "capability_module_dynamic_code_forbidden",
    ],
    [
      "export const capability={run(){return import('./other.js')}};",
      "capability_module_dynamic_import_forbidden",
    ],
    [
      "import x from './other.js'; export const capability=x;",
      "capability_module_external_import_forbidden",
    ],
    [
      "export const capability={run(){return fetch('/private')}};",
      "capability_module_network_forbidden",
    ],
    [
      "export const capability={};\n//# sourceMappingURL=capability.js.map",
      "capability_module_source_map_forbidden",
    ],
    [
      `export const capability={value:${JSON.stringify("x".repeat(120_001))}};`,
      "capability_module_too_large",
    ],
  ];
  for (const [source, code] of invalid) {
    const inspected = validateCapabilityJavaScriptSource(source);
    assert.equal(inspected.ok, false, code);
    assert.equal(inspected.code, code);
  }
  // Checks with no recorded defect behind them are notes: the module is
  // accepted and the finding is kept with it (benchmark/GATES.md).
  const noted = [
    // Seen in production: build a URL and jump via location.href, bypassing the site's own interaction.
    ["export const capability={run({input}){location.href='/search?q='+encodeURIComponent(input.keyword);return {outcome:'Continue'}}};", "capability_module_direct_navigation_forbidden"],
    ["export const capability={run(){location.assign('/next');return {outcome:'Continue'}}};", "capability_module_direct_navigation_forbidden"],
    ["export const capability={run(){return document.querySelector('button[role=\"button\"]')}};", "capability_module_computed_aria_selector_forbidden"],
  ];
  for (const [source, code] of noted) {
    const inspected = validateCapabilityJavaScriptSource(source);
    assert.equal(inspected.ok, true, code);
    assert.ok(inspected.notes.some((note) => note.code === code), code);
  }
});

test("content-addressed module storage is normalized, idempotent and site isolated", async () => {
  const windowsSource =
    'export const capability={version:2,\r\nstages:[{id:"verify",async run(){return {outcome:"Success",output:{ok:true}}}}]};\r\n';
  const normalizedSource = windowsSource.replace(/\r\n/g, "\n").trim();
  const expectedHash = await capabilityModuleHash(normalizedSource);
  assert.equal(await capabilityModuleHash(windowsSource), expectedHash);
  const first = await putCapabilityV2Module("module-site", windowsSource);
  const second = await putCapabilityV2Module("module-site", normalizedSource);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.module.contentHash, expectedHash);
  assert.match(
    first.module.moduleUrl,
    new RegExp(`${expectedHash}\\?siteId=module-site$`),
  );
  const stored = await getCapabilityV2Module("module-site", expectedHash);
  assert.equal(stored.source, normalizedSource);
  assert.equal(stored.contentHash, expectedHash);
  assert.equal(
    await getCapabilityV2Module("another-site", expectedHash),
    undefined,
  );
  assert.equal(
    await getCapabilityV2Module("module-site", "not-a-hash"),
    undefined,
  );
});

test("Program normalization and inspection enforce Stage and TargetBinding invariants", () => {
  const normalized = normalizeCapabilityJavaScriptProgram({
    schemaVersion: "ignored",
    runtime: "ignored",
    module: { contentHash: "a".repeat(64), moduleUrl: "/module.mjs" },
    entry: { mode: "Navigate" },
    stages: [
      {
        id: "same",
        title: "First",
        effect: "write",
        resumePolicy: "reconcile-before-retry",
      },
      { id: "same", title: "Second", effect: "read" },
    ],
    parameterRoles: [
      { inputPath: "productName", role: "target" },
      { inputPath: "quantity", role: "value" },
    ],
    targetBindings: [
      { inputPath: "quantity", identityStatePath: "targets.quantity" },
    ],
  });
  const inspected = inspectCapabilityJavaScriptProgram(normalized);
  assert.equal(inspected.valid, false);
  assert.ok(inspected.issues.includes("stage_id_duplicate"));
  assert.ok(inspected.issues.includes("entry_url_required"));
  assert.ok(inspected.issues.includes("target_binding_required:productName"));
  assert.ok(inspected.issues.includes("target_binding_role_invalid:quantity"));
});

test("prompt provenance is deterministic and changes when the prompt changes", async () => {
  const base = {
    key: "capability-v2.test",
    version: "1.0.0",
    text: "strict prompt",
    outputSchema: { name: "test", strict: true, schema: { type: "object" } },
  };
  const first = await promptProvenance(base, "qwen-test");
  const second = await promptProvenance(base, "qwen-test");
  const changed = await promptProvenance(
    { ...base, text: "changed prompt" },
    "qwen-test",
  );
  assert.deepEqual(first, second);
  assert.match(first.promptHash, /^[a-f0-9]{64}$/);
  assert.notEqual(first.promptHash, changed.promptHash);
  assert.equal(first.promptVersion, "1.0.0");
  assert.equal(first.model, "qwen-test");
});

test("Alibaba Qwen compatibility uses supported JSON mode without overriding default thinking", () => {
  const alibaba = modelCompatibility({
    configured: true,
    apiKey: "test",
    baseUrl:
      "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.8-max",
    source: "openai",
  });
  assert.equal(alibaba.nativeJsonSchema, false);
  assert.equal(alibaba.omitStructuredMaxTokens, true);
  assert.deepEqual(alibaba.requestBody, {});
  const generic = modelCompatibility({
    configured: true,
    apiKey: "test",
    baseUrl: "https://api.example.com/v1",
    model: "generic-model",
    source: "openai",
  });
  assert.equal(generic.nativeJsonSchema, true);
  assert.equal(generic.omitStructuredMaxTokens, false);
  assert.deepEqual(generic.requestBody, {});
  const deepseek = modelCompatibility({
    configured: true,
    apiKey: "test",
    baseUrl: "https://openapi.os1.cn/v1",
    model: "deepseek-v4-flash",
    source: "console",
  });
  assert.equal(deepseek.nativeJsonSchema, false, "DeepSeek rejects json_schema; ask for json_object up front");
});

test("Function Calling validates tool names, JSON arguments and bounded protocol repair", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const tool = {
    type: "function",
    function: {
      name: "write_file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", enum: ["capability.ts"] },
          content: { type: "string", minLength: 1 },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  };
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init.body)));
    const message =
      requests.length === 1
        ? { role: "assistant", content: "普通文本不是工具调用" }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-2",
                type: "function",
                function: {
                  name: "write_file",
                  arguments:
                    '{"path":"capability.ts","content":"export const capability={};"}',
                },
              },
            ],
          };
    return new Response(
      JSON.stringify({ choices: [{ finish_reason: "tool_calls", message }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const result = await requestToolCallingTurn({
      config: {
        configured: true,
        apiKey: "test",
        baseUrl: "https://example.test/v1",
        model: "tool-model",
      },
      messages: [{ role: "user", content: "write" }],
      tools: [tool],
      protocolRepairAttempts: 1,
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].parallel_tool_calls, false);
    assert.equal(requests[0].tool_choice, "auto");
    assert.match(
      requests[1].messages.at(-1).content,
      /违反 Function Calling 协议/,
    );
    assert.equal(result.calls[0].id, "call-2");
    assert.equal(result.message.tool_calls[0].id, "call-2");
    assert.deepEqual(parseAndValidateToolArguments(result.calls[0], tool), {
      path: "capability.ts",
      content: "export const capability={};",
    });
    assert.throws(
      () =>
        parseAndValidateToolArguments(
          {
            ...result.calls[0],
            function: {
              name: "write_file",
              arguments: '{"path":"wrong.ts","content":"x"}',
            },
          },
          tool,
        ),
      /tool_argument_enum_invalid/,
    );
    assert.throws(
      () =>
        parseAndValidateToolArguments(
          {
            ...result.calls[0],
            function: {
              name: "write_file",
              arguments: '{"path":"capability.ts","content":"x","extra":true}',
            },
          },
          tool,
        ),
      /tool_argument_unknown/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Function Calling fails explicitly after one repair and never falls back to text", async () => {
  const originalFetch = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async () => {
    count += 1;
    return new Response(
      JSON.stringify({
        choices: [
          { message: { role: "assistant", content: "I cannot call tools" } },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    await assert.rejects(
      () =>
        requestToolCallingTurn({
          config: {
            configured: true,
            apiKey: "test",
            baseUrl: "https://example.test/v1",
            model: "no-tools",
          },
          messages: [{ role: "user", content: "work" }],
          tools: [
            {
              type: "function",
              function: {
                name: "get_dom",
                parameters: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
              },
            },
          ],
          protocolRepairAttempts: 1,
        }),
      /tool_call_required/,
    );
    assert.equal(count, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Function Calling disables provider thinking without changing auto tool choice", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const tool = {
    type: "function",
    function: {
      name: "write_file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  };
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call-${requests.length}`,
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments:
                      '{"path":"capability.ts","content":"export {};"}',
                  },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const providers = [
    {
      baseUrl: "https://openapi.os1.cn",
      model: "qwen3.7-plus",
      expected: { enable_thinking: false },
    },
    {
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-5.2",
      expected: { thinking: { type: "disabled" } },
    },
    {
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      model: "doubao-seed-2.0-code",
      expected: { thinking: { type: "disabled" } },
    },
    {
      baseUrl: "https://compatible.example/v1",
      model: "unknown-model",
      expected: {},
    },
  ];
  try {
    for (const provider of providers) {
      await requestToolCallingTurn({
        config: { configured: true, apiKey: "test", ...provider },
        messages: [{ role: "user", content: "write" }],
        tools: [tool],
        protocolRepairAttempts: 0,
        disableThinking: true,
      });
    }
    assert.equal(requests.length, providers.length);
    for (const [index, provider] of providers.entries()) {
      const request = requests[index];
      assert.equal(request.tool_choice, "auto");
      assert.equal(request.parallel_tool_calls, false);
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(request).filter(
            ([key]) => key === "enable_thinking" || key === "thinking",
          ),
        ),
        provider.expected,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("structured model JSON parser reports empty responses and accepts fenced objects", () => {
  assert.throws(
    () => parseStructuredModelJson(""),
    /structured_model_empty_response/,
  );
  assert.deepEqual(
    parseStructuredModelJson('```json\n{"decision":"Approved"}\n```'),
    { decision: "Approved" },
  );
});

test("structured model JSON request repairs an invalid first response", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init.body)));
    const content =
      requests.length === 1
        ? '{"decision":"Approved","reason":"包含"未转义名称""}'
        : '{"decision":"Approved","reason":"检查通过"}';
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const response = await requestStructuredModelJson(
      {
        configured: true,
        apiKey: "test",
        baseUrl: "https://example.test/v1",
        model: "test",
      },
      {
        system: "只返回审核 JSON",
        payload: { capability: "test" },
        attempts: 2,
      },
    );
    assert.deepEqual(response, { decision: "Approved", reason: "检查通过" });
    assert.equal(requests.length, 2);
    assert.equal(
      requests[1].messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.includes("未转义名称"),
      ),
      true,
    );
    assert.equal(
      requests[1].messages.at(-1).content.includes("不符合结构化输出协议"),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("structured model JSON request uses a strict schema and falls back only when unsupported", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init.body)));
    if (requests.length === 1)
      return new Response(
        JSON.stringify({ error: "response_format_not_supported" }),
        { status: 400 },
      );
    const content =
      requests.length === 2
        ? '{"is_approved":false}'
        : '{"decision":"Rejected","reason":"证据不足"}';
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const response = await requestStructuredModelJson(
      {
        configured: true,
        apiKey: "test",
        baseUrl: "https://example.test/v1",
        model: "test",
      },
      {
        system: "审核能力",
        payload: { capability: "test" },
        attempts: 3,
        jsonSchema: {
          name: "capability_review",
          strict: true,
          schema: {
            type: "object",
            properties: {
              decision: { type: "string", enum: ["Approved", "Rejected"] },
              reason: { type: "string" },
            },
            required: ["decision", "reason"],
            additionalProperties: false,
          },
        },
        validate: (value) => {
          if (
            !["Approved", "Rejected"].includes(value.decision) ||
            typeof value.reason !== "string"
          )
            throw new Error("review_shape_invalid");
        },
      },
    );
    assert.deepEqual(response, { decision: "Rejected", reason: "证据不足" });
    assert.equal(requests[0].response_format.type, "json_schema");
    assert.equal(requests[0].response_format.json_schema.strict, true);
    assert.deepEqual(requests[0].response_format.json_schema.schema.required, [
      "decision",
      "reason",
    ]);
    assert.equal(
      requests[0].response_format.json_schema.schema.additionalProperties,
      false,
    );
    assert.equal(requests[1].response_format.type, "json_object");
    assert.equal(
      requests[1].messages[0].content.includes(
        '"required":["decision","reason"]',
      ),
      true,
    );
    assert.equal(
      requests[2].messages.at(-1).content.includes("review_shape_invalid"),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("structured model JSON retries a timed-out schema request as validated json_object", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init.body)));
    if (requests.length === 1)
      throw new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      );
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: '{"decision":"Approved","reason":"fallback validated"}',
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const response = await requestStructuredModelJson(
      {
        configured: true,
        apiKey: "test",
        baseUrl: "https://example.test/v1",
        model: "slow-schema",
      },
      {
        system: "review",
        payload: {},
        attempts: 2,
        timeoutMs: 10,
        jsonSchema: {
          name: "review",
          strict: true,
          schema: {
            type: "object",
            properties: {
              decision: { type: "string" },
              reason: { type: "string" },
            },
            required: ["decision", "reason"],
            additionalProperties: false,
          },
        },
        validate: (value) => {
          if (value.decision !== "Approved" || typeof value.reason !== "string")
            throw new Error("review_shape_invalid");
        },
      },
    );
    assert.deepEqual(response, {
      decision: "Approved",
      reason: "fallback validated",
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].response_format.type, "json_schema");
    assert.equal(requests[1].response_format.type, "json_object");
    assert.match(requests[1].messages[0].content, /必须遵循以下 JSON Schema/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explorer protocol normalizes nested model targets and grounds repeated actions by business input", () => {
  const normalized = normalizeExplorerAction({
    action: "click",
    elements: [{ index: 11 }],
  });
  assert.deepEqual(normalized, {
    action: "click",
    index: 11,
    inputPath: undefined,
    value: undefined,
    key: undefined,
    url: undefined,
    reason: undefined,
    saveAs: undefined,
    extractType: undefined,
    attribute: undefined,
  });
  const snapshot = {
    url: "https://example.test/",
    title: "商品",
    heading: "商品",
    text: "Arc 弧光台灯 Echo 桌面音箱",
    elements: [
      {
        index: 11,
        tag: "a",
        role: "link",
        name: "查看详情 →",
        container: {
          css: "article",
          text: "Echo 桌面音箱 查看详情 →",
          heading: "Echo 桌面音箱",
        },
      },
      {
        index: 12,
        tag: "a",
        role: "link",
        name: "查看详情 →",
        container: {
          css: "article",
          text: "Arc 弧光台灯 查看详情 →",
          heading: "Arc 弧光台灯",
        },
      },
    ],
  };
  const grounded = groundExplorerAction(normalized, snapshot, {
    parameters: { productName: "Arc 弧光台灯" },
    context: {},
    interactions: [],
    trigger: {},
  });
  assert.equal(grounded.index, 12);

  const typedAsPress = groundExplorerAction(
    normalizeExplorerAction({ action: "press", index: 11, key: "Mug" }),
    snapshot,
    {
      parameters: { keyword: "Mug" },
      context: {},
      interactions: [],
      trigger: {},
    },
  );
  assert.equal(typedAsPress.action, "fill");
  assert.equal(typedAsPress.inputPath, "keyword");
  assert.equal(typedAsPress.key, undefined);

  const enter = groundExplorerAction(
    normalizeExplorerAction({ action: "press", index: 11, key: "Enter" }),
    snapshot,
    {
      parameters: { keyword: "Mug" },
      context: {},
      interactions: [],
      trigger: {},
    },
  );
  assert.equal(enter.action, "press");
  assert.equal(enter.key, "Enter");

  const focusedEnter = groundExplorerAction(
    normalizeExplorerAction({ action: "press", key: "Enter" }),
    snapshot,
    {
      parameters: { keyword: "Mug" },
      context: {},
      interactions: [],
      trigger: {},
    },
  );
  assert.equal(focusedEnter.action, "press");
  assert.equal(focusedEnter.index, undefined);
  assert.equal(focusedEnter.key, "Enter");

  const enterWithRedundantInput = groundExplorerAction(
    normalizeExplorerAction({
      action: "press",
      key: "Enter",
      inputPath: "keyword",
    }),
    snapshot,
    {
      parameters: { keyword: "Mug" },
      context: {},
      interactions: [],
      trigger: {},
    },
  );
  assert.equal(enterWithRedundantInput.action, "press");
  assert.equal(enterWithRedundantInput.inputPath, undefined);
  assert.equal(enterWithRedundantInput.key, "Enter");
});

test("explorer repairs a target fill that was bound to a product textarea", () => {
  const snapshot = {
    elements: [
      {
        index: 10,
        tag: "input",
        role: "combobox",
        name: "Search",
        placeholder: "Search products...",
        inputType: "text",
      },
      {
        index: 18,
        tag: "textarea",
        role: "textbox",
        name: "Your message here",
        placeholder: "Your message here",
        container: {
          css: "#product",
          text: "Customizable mug White Ceramic Mug",
        },
      },
    ],
  };
  const action = normalizeExplorerAction({
    action: "fill",
    index: 18,
    inputPath: "productKeyword",
    value: "white mug",
  });
  const repaired = groundExplorerAction(action, snapshot, {
    parameters: { productKeyword: "mug" },
    context: {},
    interactions: [],
    trigger: {},
  });
  assert.equal(repaired.index, 10);
  assert.equal(repaired.inputPath, "productKeyword");
  assert.equal(repaired.value, undefined);
});

test("explorer prefers the visible label hit target for styled radio, checkbox, and color inputs", () => {
  const strategies = strategiesFor(
    {
      index: 3,
      tag: "input",
      role: "radio",
      name: "Color - White",
      label: "Color - White",
      inputType: "radio",
      css: "#input_2_8_10",
    },
    { parameters: {}, context: {}, interactions: [], trigger: {} },
  );
  assert.deepEqual(strategies[0], {
    type: "css",
    value: 'label[for="input_2_8_10"]',
  });
  assert.equal(
    strategies.some((strategy) => strategy.type === "role"),
    true,
  );
});

test("explorer rejects a nearest-but-wrong facet instead of silently changing the request", () => {
  const snapshot = {
    elements: [
      {
        index: 7,
        tag: "input",
        role: "radio",
        name: "Color - White",
        label: "Color - White",
        inputType: "radio",
      },
      {
        index: 8,
        tag: "input",
        role: "radio",
        name: "Color - Brown",
        label: "Color - Brown",
        inputType: "radio",
      },
    ],
  };
  const input = {
    parameters: { color: "brown" },
    context: { __capabilityInputAliases: { color: { brown: "Brown" } } },
    interactions: [],
    trigger: {},
  };
  assert.deepEqual(
    rejectMismatchedFacetAction({ action: "click", index: 7 }, snapshot, input),
    { action: "fail", reason: "requested_facet_unavailable:color:brown" },
  );
  assert.deepEqual(
    rejectMismatchedFacetAction({ action: "click", index: 8 }, snapshot, input),
    { action: "click", index: 8 },
  );
});

test("explorer keeps stable action prefixes while scoping the concrete product card", () => {
  const strategies = strategiesFor(
    {
      index: 101,
      tag: "a",
      role: "link",
      name: "View product Brown bear cushion",
      container: { css: "article", text: "Brown bear cushion Add to cart" },
    },
    {
      parameters: { productType: "cushion", color: "brown" },
      context: {},
      interactions: [],
      trigger: {},
    },
  );
  assert.deepEqual(strategies[0], {
    type: "role",
    role: "link",
    name: "View product",
    match: "contains",
  });
});

test("runner resolves an input-backed variant in the first matching product card", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><main>
      <article><a href="/first" aria-label="Black - First cushion" onclick="event.preventDefault();document.querySelector('#result').textContent='first'">Black - First cushion</a></article>
      <article><a href="/second" aria-label="Black - Second cushion" onclick="event.preventDefault();document.querySelector('#result').textContent='second'">Black - Second cushion</a></article>
      <output id="result"></output>
    </main>`);
    const input = {
      parameters: { productType: "cushion", color: "black" },
      context: {},
      interactions: [],
      trigger: {},
    };
    const strategies = strategiesFor(
      {
        index: 1,
        tag: "a",
        role: "link",
        name: "Black - First cushion",
        container: { css: "article", text: "Black - First cushion" },
      },
      input,
    );
    assert.equal(
      strategies.some(
        (strategy) =>
          strategy.name?.source === "input" &&
          strategy.containsTextAll?.length === 2,
      ),
      true,
    );
    const program = {
      schemaVersion: "1.0",
      entry: { mode: "CurrentPage" },
      defaults: { timeoutMs: 5_000, retryCount: 0 },
      steps: [
        {
          id: "step_1",
          action: "click",
          target: {
            scope: {
              strategies: [
                {
                  type: "css",
                  value: "article",
                  containsTextAll: [{ source: "input", path: "productType" }],
                },
              ],
            },
            strategies,
          },
        },
      ],
      result: {},
    };
    await executeProgram(page, program, input);
    assert.equal(await page.locator("#result").innerText(), "first");
  } finally {
    await browser.close();
  }
});

test("explorer can address an unnamed product image link inside a scoped card", () => {
  const strategies = strategiesFor(
    {
      index: 13,
      tag: "a",
      role: "link",
      href: "http://localhost:18081/19-customizable-mug.html",
      container: {
        css: "article",
        text: "Customizable mug €13.90 See details",
      },
    },
    {
      parameters: { productType: "马克杯" },
      context: { __capabilityInputAliases: { productType: { 马克杯: "mug" } } },
      interactions: [],
      trigger: {},
    },
  );
  assert.deepEqual(strategies, [{ type: "css", value: "a[href]" }]);
});

test("runner collapses alternate links for one product entity by shared href", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><main>
      <a href="/19-customizable-mug.html" aria-label="View product Customizable mug" onclick="event.preventDefault();document.querySelector('#result').textContent='clicked'">Customizable mug</a>
      <a href="/19-customizable-mug.html" aria-label="View product Customizable mug" onclick="event.preventDefault();document.querySelector('#result').textContent='clicked'">See details</a>
      <output id="result"></output>
    </main>`);
    const input = {
      parameters: { searchTerm: "白色马克杯" },
      context: {},
      interactions: [],
      trigger: {},
    };
    const program = {
      schemaVersion: "1.0",
      entry: { mode: "CurrentPage" },
      defaults: { timeoutMs: 5_000, retryCount: 0 },
      steps: [
        {
          id: "step_1",
          action: "click",
          target: {
            strategies: strategiesFor(
              {
                index: 1,
                tag: "a",
                role: "link",
                name: "View product Customizable mug",
              },
              input,
            ),
          },
        },
      ],
      result: {},
    };
    await executeProgram(page, program, input);
    assert.equal(await page.locator("#result").innerText(), "clicked");
  } finally {
    await browser.close();
  }
});

test("runner accepts a one-shot commerce click when the success modal intercepts pointerup", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><main>
      <button id="add" onpointerdown="document.body.insertAdjacentHTML('beforeend', '<div role=dialog>Added to your cart</div>')">Add</button>
    </main>`);
    const input = {
      parameters: {},
      context: {},
      interactions: [],
      trigger: {},
    };
    const program = {
      schemaVersion: "1.0",
      entry: { mode: "CurrentPage" },
      defaults: { timeoutMs: 1_000, retryCount: 0 },
      steps: [
        {
          id: "step_1",
          action: "click",
          target: { strategies: [{ type: "css", value: "#add" }] },
        },
      ],
      result: {},
    };
    await executeProgram(page, program, input);
    assert.match(
      await page.locator('[role="dialog"]').innerText(),
      /Added to your cart/,
    );
  } finally {
    await browser.close();
  }
});

test("discovery scope marks fixed category routes as non-generalizable before validation", () => {
  const scope = inferCapabilityScope(
    "https://shop.example.test/",
    [
      {
        id: "step_1",
        action: "navigate",
        value: {
          source: "literal",
          value: "https://shop.example.test/3-dining",
        },
      },
    ],
    {
      parameters: [
        {
          name: "query",
          type: "string",
          description: "搜索词",
          required: true,
          exampleValue: "马克杯",
        },
      ],
    },
  );
  assert.equal(scope.kind, "category-scoped");
  assert.deepEqual(scope.match?.urlPatterns, ["/3-dining"]);
  assert.equal(scope.onMismatch, "no-match");
});

test("discovery scope keeps an input-bound search URL reusable", () => {
  const scope = inferCapabilityScope(
    "https://shop.example.test/",
    [
      {
        id: "step_1",
        action: "navigate",
        value: {
          source: "literal",
          value: "https://shop.example.test/search?q=马克杯",
        },
      },
    ],
    {
      parameters: [
        {
          name: "query",
          type: "string",
          description: "搜索词",
          required: true,
          exampleValue: "马克杯",
        },
      ],
    },
  );
  assert.equal(scope.kind, "site-global");
  assert.equal(scope.onMismatch, "page-agent");
  assert.equal("generalizable" in scope, false);
});

test("explorer converts repeated fills into a submit or blur instead of looping", () => {
  const snapshot = {
    elements: [
      {
        index: 10,
        tag: "input",
        role: "searchbox",
        name: "搜索",
        inputType: "search",
        placeholder: "搜索商品",
      },
    ],
  };
  assert.deepEqual(
    overrideRepeatedAction(
      { action: "fill", index: 10, inputPath: "query" },
      snapshot,
      [{ action: "fill", index: 10 }],
    ),
    { action: "press", key: "Enter", reason: "repeated_search_fill_submit" },
  );
  assert.deepEqual(
    overrideRepeatedAction(
      { action: "fill", index: 10, inputPath: "query" },
      {
        elements: [
          { index: 10, tag: "input", role: "textbox", name: "收件人" },
        ],
      },
      [{ action: "fill", index: 10 }],
    ),
    { action: "press", key: "Tab", reason: "repeated_textlike_fill_blur" },
  );
  assert.deepEqual(
    overrideRepeatedAction(
      { action: "fill", index: 10, inputPath: "customizationText" },
      {
        elements: [
          { index: 10, tag: "textarea", role: "textbox", name: "Custom text" },
        ],
      },
      [{ action: "fill", index: 10 }],
    ),
    { action: "press", key: "Tab", reason: "repeated_textlike_fill_blur" },
  );
});

test("parameter-plan cleanup rejects technical parameters and preserves the final business action", () => {
  const raw = {
    intent: "ViewProductDetails",
    name: "查看商品详情",
    description: "查看商品详情",
    aliases: ["查看详情"],
    parameters: [
      {
        name: "商品",
        type: "string",
        description: "商品名称",
        required: true,
        exampleValue: "Arc 弧光台灯",
      },
      {
        name: "元素索引",
        type: "number",
        description: "元素索引",
        required: true,
        exampleValue: 11,
      },
    ],
    groundingExamples: [{ 商品: "Arc 弧光台灯" }, { 商品: "Echo 桌面音箱" }],
  };
  const snapshot = {
    url: "https://example.test/",
    title: "商品",
    heading: "商品",
    text: "Arc 弧光台灯 Echo 桌面音箱",
    elements: [
      {
        index: 11,
        tag: "a",
        role: "link",
        name: "查看详情 →",
        container: {
          css: "article",
          text: "Arc 弧光台灯 查看详情 →",
          heading: "Arc 弧光台灯",
        },
      },
      {
        index: 12,
        tag: "a",
        role: "link",
        name: "查看详情 →",
        container: {
          css: "article",
          text: "Echo 桌面音箱 查看详情 →",
          heading: "Echo 桌面音箱",
        },
      },
    ],
  };
  const plan = cleanParameterPlan(
    raw,
    "将 Arc 弧光台灯加入购物车",
    {},
    snapshot,
    {
      name: "加入购物车",
      description: "将指定商品加入购物车",
      aliases: ["加购"],
    },
  );
  assert.equal(plan.intent, "将 {{商品}}加入购物车");
  assert.equal(plan.name, "加入购物车");
  assert.deepEqual(
    plan.parameters.map((parameter) => parameter.name),
    ["商品"],
  );
  assert.deepEqual(plan.groundingExamples, [
    { 商品: "Arc 弧光台灯" },
    { 商品: "Echo 桌面音箱" },
  ]);
});

test("grounding examples written the page address's way still name different rooms", () => {
  // The floor-lamp rebuild: the demonstration chose "Living room" by its link,
  // the planner wrote its examples the old contract's way ("living",
  // "bedroom"). "bedroom" was dropped for lacking evidence, "living" survived
  // as a second room, and both runs looked at the same room — so a count that
  // ignored the room could not be told apart from one that followed it.
  const rooms = ["Living room", "Bedroom", "Home office", "Dining"];
  const snapshot = {
    url: "https://lamps.example.test/",
    title: "Lamps",
    heading: "Light, considered.",
    text: `Shop by room ${rooms.join(" ")}`,
    elements: rooms.map((name, index) => ({ index: index + 1, tag: "a", role: "link", name, href: `https://lamps.example.test/shop?room=${name.split(" ").at(-1).toLowerCase()}`, container: { css: "section", text: `Shop by room ${rooms.join(" ")}` } })),
  };
  const raw = {
    parameters: [{ name: "room", type: "string", description: "The room", required: true, exampleValue: "living" }],
    groundingExamples: [{ room: "living" }, { room: "bedroom" }],
    siteTerms: [
      { name: "room", from: "Living room", value: "living" },
      { name: "room", from: "Bedroom", value: "bedroom" },
      { name: "room", from: "Home office", value: "office" },
      { name: "room", from: "Dining", value: "dining" },
    ],
  };
  const plan = cleanParameterPlan(raw, "Locate floor lamps suitable for a specific room", { parameters: { room: "Living room" }, context: {}, interactions: [], trigger: {} }, snapshot);
  assert.deepEqual(plan.groundingExamples, [{ room: "Living room" }, { room: "Bedroom" }]);
});

test("a session's planner keeps the visitor's inputs, not values the run picked on its own", () => {
  // The demo lamp task: intake supplied only the finish the visitor asked for;
  // the planner added the plug type the agent chose, as a required input the
  // explored path never acted on.
  const snapshot = { url: "https://lamps.example.test/product/lune", title: "Lune", heading: "Lune", text: "Finish Brass Matte black Plug type US plug (Type A/B) UK plug (Type G)", elements: [] };
  const raw = {
    parameters: [
      { name: "finish", type: "string", description: "Lamp finish", required: true, exampleValue: "Brass" },
      { name: "plugType", type: "string", description: "Plug type", required: true, exampleValue: "US plug (Type A/B)" },
    ],
  };
  const fromSession = cleanParameterPlan(raw, "Order a dimmable desk lamp in brass", {
    parameters: { finish: "Brass" },
    context: {},
    interactions: [],
    trigger: {},
    experience: { originalGoal: "Order a dimmable desk lamp in brass", actions: [], output: {} },
  }, snapshot);
  assert.deepEqual(fromSession.parameters.map((parameter) => parameter.name), ["finish"]);
  // A task with no session has only the planner to define its inputs.
  const fromAdmin = cleanParameterPlan(raw, "Order a lamp with a chosen finish and plug", { parameters: {}, context: {}, interactions: [], trigger: {} }, snapshot);
  assert.deepEqual(fromAdmin.parameters.map((parameter) => parameter.name).sort(), ["finish", "plugType"]);
});

test("a control named with the visitor's whole request is not part of the site", () => {
  const snapshot = { url: "https://lamps.example.test/", elements: [
    { index: 1, name: "Order a dimmable desk lamp in brass" },
    { index: 2, name: "Brass" },
    { index: 3, name: "Add to cart" },
    { index: 4, label: "Try asking: Order a dimmable desk lamp in brass" },
  ] };
  const kept = withoutGoalEchoes(snapshot, ["Order a dimmable desk lamp in brass", undefined]);
  assert.deepEqual(kept.elements.map((element) => element.index), [2, 3]);
  // A goal a button may share is not used to exclude anything.
  assert.equal(withoutGoalEchoes(snapshot, ["Add to cart"]).elements.length, 4);
  // A request in a script without spaces is measured in characters.
  const chinese = { elements: [{ index: 1, name: "下单一盏可调光的黄铜台灯" }, { index: 2, name: "黄铜" }] };
  assert.deepEqual(withoutGoalEchoes(chinese, ["下单一盏可调光的黄铜台灯"]).elements.map((element) => element.index), [2]);
});

test("parameter-plan cleanup collapses model-synonym target fields onto the supplied field", () => {
  const snapshot = {
    url: "https://example.test/search",
    title: "Search results",
    heading: "Search results",
    text: "White mug Brown cushion",
    elements: [
      {
        index: 1,
        tag: "article",
        role: "article",
        name: "White mug",
        container: { css: "article", text: "White mug", heading: "White mug" },
      },
      {
        index: 2,
        tag: "article",
        role: "article",
        name: "Brown cushion",
        container: {
          css: "article",
          text: "Brown cushion",
          heading: "Brown cushion",
        },
      },
    ],
  };
  const plan = cleanParameterPlan(
    {
      parameters: [
        { name: "query", type: "string", required: true, exampleValue: "mug" },
        {
          name: "searchTerm",
          type: "string",
          required: true,
          exampleValue: "mug",
        },
        {
          name: "color",
          type: "string",
          required: true,
          exampleValue: "white",
        },
      ],
      groundingExamples: [
        { query: "mug", searchTerm: "mug", color: "white" },
        { query: "cushion", searchTerm: "cushion", color: "brown" },
      ],
    },
    "find a white mug",
    { parameters: { searchTerm: "mug", color: "white" } },
    snapshot,
  );
  assert.deepEqual(
    plan.parameters.map((parameter) => parameter.name),
    ["searchTerm", "color"],
  );
  assert.deepEqual(plan.groundingExamples, [
    { searchTerm: "mug", color: "white" },
    { searchTerm: "cushion", color: "brown" },
  ]);
});

test("parameter-plan cleanup does not classify an attribute field as a target", () => {
  const snapshot = {
    url: "https://example.test/search",
    title: "Search results",
    heading: "Search results",
    text: "White mug Brown cushion",
    elements: [
      {
        index: 1,
        tag: "article",
        role: "article",
        name: "White mug",
        container: { css: "article", text: "White mug", heading: "White mug" },
      },
      {
        index: 2,
        tag: "article",
        role: "article",
        name: "Brown cushion",
        container: {
          css: "article",
          text: "Brown cushion",
          heading: "Brown cushion",
        },
      },
    ],
  };
  const plan = cleanParameterPlan(
    {
      parameters: [
        {
          name: "商品类别",
          type: "string",
          required: true,
          exampleValue: "马克杯",
        },
        {
          name: "productAttribute",
          type: "string",
          required: true,
          exampleValue: "白色",
        },
      ],
      groundingExamples: [
        { 商品类别: "马克杯", productAttribute: "白色" },
        { 商品类别: "垫子", productAttribute: "棕色" },
      ],
    },
    "给我找一个白色的马克杯放到购物车",
    { parameters: { searchKeyword: "马克杯", productAttribute: "白色" } },
    snapshot,
  );
  assert.deepEqual(
    plan.parameters.map((parameter) => parameter.name),
    ["searchKeyword", "productAttribute"],
  );
});

test("parameter-plan cleanup keeps model alternatives grounded in the exploration snapshot", () => {
  const snapshot = {
    url: "https://example.test/cart",
    title: "购物车",
    heading: "购物车",
    text: "Arc 弧光台灯 Echo 桌面音箱",
    elements: [
      {
        index: 11,
        tag: "article",
        role: "article",
        name: "Arc 弧光台灯",
        text: "Arc 弧光台灯 数量 1",
      },
      {
        index: 12,
        tag: "article",
        role: "article",
        name: "Echo 桌面音箱",
        text: "Echo 桌面音箱 数量 1",
      },
    ],
  };
  const plan = cleanParameterPlan(
    {
      name: "从购物车删除商品",
      description: "从购物车删除指定商品",
      parameters: [
        {
          name: "product",
          type: "string",
          required: true,
          exampleValue: "Arc 弧光台灯",
        },
      ],
      groundingExamples: [
        { product: "Arc 弧光台灯" },
        { product: "Echo 桌面音箱" },
        { product: "无线蓝牙耳机" },
      ],
    },
    "从购物车删除 Arc 弧光台灯",
    {},
    snapshot,
    {
      name: "从购物车删除商品",
      description: "从购物车删除指定商品",
      aliases: [],
    },
  );
  assert.deepEqual(plan.groundingExamples, [
    { product: "Arc 弧光台灯" },
    { product: "Echo 桌面音箱" },
  ]);
});

test("parameter-plan cleanup never replaces an explicit B target parameter with inferred page text", () => {
  const snapshot = {
    url: "https://example.test/cart",
    title: "购物车",
    heading: "购物车",
    text: "购物车 Arc 弧光台灯 Echo 桌面音箱",
    elements: [
      {
        index: 11,
        tag: "article",
        role: "article",
        name: "Arc 弧光台灯",
        text: "Arc 弧光台灯 数量 1",
      },
      {
        index: 12,
        tag: "article",
        role: "article",
        name: "Echo 桌面音箱",
        text: "Echo 桌面音箱 数量 1",
      },
    ],
  };
  const plan = cleanParameterPlan(
    {
      parameters: [
        {
          name: "productName",
          type: "string",
          required: true,
          exampleValue: "购物车",
        },
      ],
      groundingExamples: [
        { productName: "Arc 弧光台灯" },
        { productName: "Echo 桌面音箱" },
      ],
    },
    "删除 Arc 弧光台灯",
    { parameters: { productName: "Arc 弧光台灯" } },
    snapshot,
  );
  assert.equal(plan.parameters[0].exampleValue, "Arc 弧光台灯");
  assert.deepEqual(plan.groundingExamples, [
    { productName: "Arc 弧光台灯" },
    { productName: "Echo 桌面音箱" },
  ]);
});

test("parameter-plan cleanup infers a reusable target from repeated page entities when the model omits it", () => {
  const snapshot = {
    url: "https://example.test/",
    title: "商品",
    heading: "商品",
    text: "Arc 弧光台灯 Echo 桌面音箱",
    elements: [
      {
        index: 11,
        tag: "a",
        role: "link",
        name: "查看详情 →",
        container: {
          css: "article",
          text: "Arc 弧光台灯 查看详情 →",
          heading: "Arc 弧光台灯",
        },
      },
      {
        index: 12,
        tag: "a",
        role: "link",
        name: "查看详情 →",
        container: {
          css: "article",
          text: "Echo 桌面音箱 查看详情 →",
          heading: "Echo 桌面音箱",
        },
      },
    ],
  };
  const plan = cleanParameterPlan(
    {
      name: "将 Arc 弧光台灯加入购物车",
      parameters: [],
      groundingExamples: [],
    },
    "将 Arc 弧光台灯加入购物车",
    {},
    snapshot,
    { name: "加入购物车", description: "将指定商品加入购物车" },
  );
  assert.deepEqual(
    plan.parameters.map((parameter) => parameter.name),
    ["target"],
  );
  assert.equal(plan.intent, "将 {{target}}加入购物车");
  assert.deepEqual(plan.groundingExamples, [
    { target: "Arc 弧光台灯" },
    { target: "Echo 桌面音箱" },
  ]);
});

test("parameter-plan cleanup prefers a generalized model name over a concrete Agent seed", () => {
  const snapshot = {
    url: "https://example.test/",
    title: "商品",
    heading: "商品",
    text: "Moss 休闲椅 Arc 弧光台灯",
    elements: [
      {
        index: 11,
        tag: "a",
        role: "link",
        name: "查看详情 →",
        container: {
          css: "article",
          text: "Moss 休闲椅 查看详情 →",
          heading: "Moss 休闲椅",
        },
      },
      {
        index: 12,
        tag: "a",
        role: "link",
        name: "查看详情 →",
        container: {
          css: "article",
          text: "Arc 弧光台灯 查看详情 →",
          heading: "Arc 弧光台灯",
        },
      },
    ],
  };
  const plan = cleanParameterPlan(
    {
      name: "把商品加入购物车",
      description: "将指定商品加入购物车",
      aliases: ["加入购物车"],
      parameters: [
        { name: "productName", required: true, exampleValue: "Moss 休闲椅" },
      ],
      groundingExamples: [
        { productName: "Moss 休闲椅" },
        { productName: "Arc 弧光台灯" },
      ],
    },
    "把 Moss 休闲椅加入购物车",
    {},
    snapshot,
    {
      name: "把 Moss 休闲椅加入购物车",
      description: "把 Moss 休闲椅加入购物车",
      aliases: ["Moss 休闲椅加购", "加入购物车"],
    },
  );
  assert.equal(plan.name, "把商品加入购物车");
  assert.equal(plan.description, "将指定商品加入购物车");
  assert.deepEqual(plan.aliases, ["加入购物车"]);
});

test("parameter-plan cleanup parameterizes localized PageAgent values before quality gates", () => {
  const snapshot = {
    url: "https://example.test/",
    title: "商品",
    heading: "商品",
    text: "Clothes Accessories Art",
    elements: [],
  };
  const plan = cleanParameterPlan(
    {
      name: "打开商品分类",
      description: "在导航中打开指定商品分类。",
      parameters: [
        {
          name: "categoryName",
          type: "string",
          required: true,
          exampleValue: "Clothes",
        },
      ],
      groundingExamples: [
        { categoryName: "Clothes" },
        { categoryName: "Accessories" },
      ],
      siteTerms: [
        { name: "categoryName", from: "衣服", value: "Clothes" },
        { name: "categoryName", from: "配饰", value: "Accessories" },
      ],
    },
    "帮我打开衣服分类",
    {},
    snapshot,
    {
      name: "帮我打开衣服分类",
      description: "帮我打开衣服分类",
      aliases: [],
    },
  );
  assert.equal(plan.intent, "帮我打开{{categoryName}}分类");
  assert.equal(plan.name, "打开商品分类");
  assert.equal(plan.description, "在导航中打开指定商品分类。");
});

test("parameter-plan decomposes an adjective+noun search phrase before exploration", () => {
  const parameters = decomposeCompositeSearchParameter([
    {
      name: "productKeyword",
      type: "string",
      description: "搜索词",
      required: true,
      exampleValue: "棕色的垫子",
    },
  ]);
  assert.deepEqual(
    parameters.map((item) => [item.name, item.exampleValue]),
    [
      ["productType", "垫子"],
      ["color", "棕色"],
    ],
  );
});

test("parameter-plan preserves a color facet when customers omit 的", () => {
  const parameters = decomposeCompositeSearchParameter([
    {
      name: "searchTerm",
      type: "string",
      description: "搜索词",
      required: true,
      exampleValue: "黑色T恤",
    },
    {
      name: "quantity",
      type: "number",
      description: "数量",
      required: true,
      exampleValue: 1,
    },
  ]);
  assert.deepEqual(
    parameters.map((item) => [item.name, item.exampleValue]),
    [
      ["productType", "T恤"],
      ["color", "黑色"],
      ["quantity", 1],
    ],
  );
});

test("parameter-plan parameterizes numeric business values in reusable intent", () => {
  const plan = cleanParameterPlan(
    {
      parameters: [
        {
          name: "query",
          type: "string",
          description: "搜索词",
          required: true,
          exampleValue: "马克杯",
        },
        {
          name: "quantity",
          type: "number",
          description: "数量",
          required: true,
          exampleValue: 2,
        },
      ],
      groundingExamples: [{ query: "马克杯", quantity: 2 }],
    },
    "给我找一个马克杯放到购物车，数量为2",
    { parameters: { query: "马克杯", quantity: 2 } },
    { text: "马克杯 数量 2", elements: [] },
  );
  assert.equal(
    plan.intent,
    "给我找一个{{query}}放到购物车，数量为{{quantity}}",
  );
  assert.equal(plan.name.includes("2"), false);
  assert.equal(plan.description.includes("2"), false);
});

test("parameter-plan keeps raw user values and records visible site-language aliases", () => {
  const snapshot = { text: "Brown bear cushion White mug", elements: [] };
  const plan = cleanParameterPlan(
    {
      parameters: [
        {
          name: "productKeyword",
          type: "string",
          required: true,
          exampleValue: "垫子",
        },
      ],
      groundingExamples: [
        { productKeyword: "垫子" },
        { productKeyword: "马克杯" },
      ],
      siteTerms: [{ name: "productKeyword", value: "cushion" }],
    },
    "找一个垫子",
    {},
    snapshot,
  );
  assert.deepEqual(plan.inputAliases, { productKeyword: { 垫子: "cushion" } });
  const programWithAliases = { inputAliases: plan.inputAliases };
  assert.deepEqual(
    applyCapabilityInputAliases(programWithAliases, { productKeyword: "垫子" }),
    { productKeyword: "cushion" },
  );
});

test("parameter-plan grounds a generic optional default from a visible control and keeps its omission case", () => {
  const plan = cleanParameterPlan(
    {
      parameters: [
        {
          name: "query",
          type: "string",
          description: "商品查询词",
          required: true,
          exampleValue: "mug",
        },
        {
          name: "quantity",
          type: "number",
          description: "商品数量",
          required: true,
          exampleValue: 1,
        },
      ],
      groundingExamples: [
        { query: "mug", quantity: 1 },
        { query: "cushion", quantity: 1 },
      ],
    },
    "将 mug 加入购物车",
    { parameters: { query: "mug" } },
    {
      url: "https://example.test/product",
      title: "Product",
      heading: "Product",
      text: "Mug Change quantity of product",
      elements: [
        {
          index: 4,
          tag: "input",
          role: "textbox",
          name: "Change quantity of product",
          inputType: "text",
          value: "1",
          css: "#quantity",
        },
      ],
    },
  );
  const quantity = plan.parameters.find(
    (parameter) => parameter.name === "quantity",
  );
  assert.equal(quantity?.required, false);
  assert.equal(quantity?.defaultValue, 1);
  assert.deepEqual(quantity?.defaultEvidence, {
    source: "page-control",
    ref: "page-control:#quantity",
  });
  assert.ok(
    plan.groundingExamples.some(
      (item) => item.query === "mug" && item.quantity === undefined,
    ),
  );
});

test("parameter-plan uses checkbox checked state instead of its static value attribute", () => {
  const checkedFalse = cleanParameterPlan(
    {
      parameters: [
        {
          name: "notifications",
          type: "boolean",
          description: "接收通知",
          required: true,
          exampleValue: true,
        },
      ],
      groundingExamples: [{ notifications: true }],
    },
    "开启通知",
    { parameters: { notifications: true } },
    {
      text: "接收通知",
      elements: [
        {
          index: 1,
          tag: "input",
          inputType: "checkbox",
          name: "接收通知",
          value: "true",
          checked: false,
          css: "#notifications",
        },
      ],
    },
  );
  const requestedTrue = checkedFalse.parameters.find(
    (parameter) => parameter.name === "notifications",
  );
  assert.equal(requestedTrue?.required, true);
  assert.equal(requestedTrue?.defaultValue, undefined);

  const genuineFalseDefault = cleanParameterPlan(
    {
      parameters: [
        {
          name: "notifications",
          type: "boolean",
          description: "接收通知",
          required: true,
          exampleValue: false,
        },
      ],
      groundingExamples: [{ notifications: false }],
    },
    "设置通知",
    { parameters: { notifications: false } },
    {
      text: "接收通知",
      elements: [
        {
          index: 1,
          tag: "input",
          inputType: "checkbox",
          name: "接收通知",
          value: "true",
          checked: false,
          css: "#notifications",
        },
      ],
    },
  );
  const requestedFalse = genuineFalseDefault.parameters.find(
    (parameter) => parameter.name === "notifications",
  );
  assert.equal(requestedFalse?.required, false);
  assert.equal(requestedFalse?.defaultValue, false);
});

test("parameter-plan only uses the selected radio option as default evidence", () => {
  const plan = cleanParameterPlan(
    {
      parameters: [
        {
          name: "sortOrder",
          type: "string",
          description: "排序方式",
          required: true,
          exampleValue: "name.asc",
        },
      ],
      groundingExamples: [{ sortOrder: "name.asc" }],
    },
    "按名称排序",
    { parameters: { sortOrder: "name.asc" } },
    {
      text: "排序方式",
      elements: [
        {
          index: 1,
          tag: "input",
          inputType: "radio",
          name: "排序方式",
          value: "price.desc",
          checked: false,
          css: "#price-desc",
        },
        {
          index: 2,
          tag: "input",
          inputType: "radio",
          name: "排序方式",
          value: "name.asc",
          checked: true,
          css: "#name-asc",
        },
      ],
    },
  );
  const sortOrder = plan.parameters.find(
    (parameter) => parameter.name === "sortOrder",
  );
  assert.equal(sortOrder?.required, false);
  assert.equal(sortOrder?.defaultValue, "name.asc");
  assert.deepEqual(sortOrder?.defaultEvidence, {
    source: "page-control",
    ref: "page-control:#name-asc",
  });
});

test("parameter-plan rejects a concrete product title as a reusable input alias", () => {
  const snapshot = {
    text: "Mug The best is yet to come",
    elements: [
      {
        name: "Mug The best is yet to come",
        href: "http://shop.test/6-mug-the-best-is-yet-to-come.html",
        container: {
          css: "article",
          text: "Mug The best is yet to come Add to cart",
        },
      },
    ],
  };
  const plan = cleanParameterPlan(
    {
      parameters: [
        {
          name: "productKeyword",
          type: "string",
          required: true,
          exampleValue: "马克杯",
        },
      ],
      groundingExamples: [{ productKeyword: "马克杯" }],
      siteTerms: [
        {
          name: "productKeyword",
          from: "马克杯",
          value: "Mug The best is yet to come",
        },
      ],
    },
    "找一个白色的马克杯加入购物车",
    {},
    snapshot,
  );
  assert.equal(plan.inputAliases?.productKeyword?.["马克杯"], undefined);
});

test("parameter-plan carries aliases across composite search decomposition", () => {
  const snapshot = {
    text: "Black Hummingbird printed t-shirt White Hummingbird printed t-shirt",
    elements: [],
  };
  const plan = cleanParameterPlan(
    {
      parameters: [
        {
          name: "searchTerm",
          type: "string",
          required: true,
          exampleValue: "黑色T恤",
        },
        { name: "quantity", type: "number", required: false, exampleValue: 1 },
      ],
      siteTerms: [
        {
          name: "searchTerm",
          from: "黑色T恤",
          value: "Hummingbird printed t-shirt",
        },
        {
          name: "searchTerm",
          from: "白色T恤",
          value: "Hummingbird printed t-shirt",
        },
      ],
      groundingExamples: [{ searchTerm: "黑色T恤", quantity: 1 }],
    },
    "找黑色T恤并加入购物车",
    { searchTerm: "黑色T恤", quantity: 1 },
    snapshot,
  );
  assert.deepEqual(plan.inputAliases, {
    productType: { T恤: "Hummingbird printed t-shirt" },
    color: { 黑色: "black", 黑: "black", 白: "white", 白色: "white" },
  });
  assert.deepEqual(
    applyCapabilityInputAliases(
      { inputAliases: plan.inputAliases },
      { productType: "T恤", color: "黑色" },
    ),
    { productType: "Hummingbird printed t-shirt", color: "black" },
  );
});

test("exploration input projects only canonical parameters after abstraction", () => {
  const input = {
    parameters: { keyword: "白色马克杯" },
    context: { startUrl: "http://localhost:18081/", locale: "zh-CN" },
    interactions: [],
    trigger: {},
    experience: pageAgentExperience({ originalGoal: "帮我找一个白色的马克杯" }),
  };
  const plan = {
    intent: "搜索{{productType}}并匹配{{color}}",
    name: "搜索商品",
    description: "按商品主体和颜色搜索商品",
    aliases: [],
    parameters: [
      {
        name: "productType",
        type: "string",
        description: "商品主体",
        required: true,
        exampleValue: "马克杯",
      },
      {
        name: "color",
        type: "string",
        description: "商品颜色",
        required: true,
        exampleValue: "白色",
      },
    ],
    groundingExamples: [{ productType: "马克杯", color: "白色" }],
    inputAliases: { productType: { 马克杯: "mug" }, color: { 白色: "white" } },
  };
  const projected = projectExplorationInput(input, plan);
  assert.deepEqual(projected.parameters, {
    productType: "马克杯",
    color: "白色",
  });
  assert.equal(projected.parameters.keyword, undefined);
  assert.deepEqual(projected.context.__canonicalParameterPaths, [
    "productType",
    "color",
  ]);
  assert.deepEqual(projected.context.__sourceParameterPaths, ["keyword"]);
  assert.deepEqual(
    projected.context.__capabilityInputAliases,
    plan.inputAliases,
  );
  assert.equal(projected.experience?.originalGoal, "帮我找一个白色的马克杯");
});

test("invalid explorer input paths fail as model contract errors, never as admin input", () => {
  const input = {
    parameters: { productType: "马克杯", color: "白色" },
    context: {},
    interactions: [],
    trigger: {},
  };
  assert.throws(
    () =>
      normalizeExplorerInputPath(
        { action: "fill", index: 10, inputPath: "0" },
        input,
      ),
    (error) =>
      error instanceof InvalidModelInputPathError &&
      error.path === "0" &&
      error.allowedPaths.join(",") === "productType,color",
  );
  assert.deepEqual(
    normalizeExplorerInputPath(
      { action: "fill", index: 10, inputPath: "parameters.productType" },
      input,
    ),
    { action: "fill", index: 10, inputPath: "productType" },
  );
  // A choice the task does not take as an input, given with its value, is a
  // fixed step: the value is kept and the stray inputPath dropped, rather
  // than pressing the model to bind it to an unrelated input.
  assert.deepEqual(
    normalizeExplorerInputPath(
      { action: "select", index: 24, inputPath: "plugType", value: "US" },
      input,
    ),
    { action: "select", index: 24, value: "US" },
  );
  assert.deepEqual(
    normalizeExplorerInputPath(
      { action: "fill", index: 10, inputPath: "customization_text" },
      { ...input, parameters: { customizationText: "Hello SiteWake" } },
    ),
    { action: "fill", index: 10, inputPath: "customizationText" },
    "separator variants should resolve to the single canonical camelCase input key",
  );
  assert.deepEqual(
    normalizeExplorerInputPath(
      { action: "fill", index: 10, inputPath: "text" },
      { ...input, parameters: { customizationText: "Hello SiteWake" } },
    ),
    { action: "fill", index: 10, inputPath: "customizationText" },
    "a unique descriptive text field may be shortened by the model without becoming an admin input",
  );
});

test("success URL conditions are aligned to the observed URL", () => {
  const plan = {
    intent: "查找并加入购物车",
    name: "查找并加入购物车",
    description: "查找并加入购物车",
    aliases: [],
    parameters: [
      {
        name: "productKeyword",
        type: "string",
        description: "商品",
        required: true,
        exampleValue: "马克杯",
      },
    ],
    groundingExamples: [{ productKeyword: "马克杯" }],
  };
  const aligned = alignSuccessConditionsToEvidence(
    [
      { type: "textIncludes", value: "Added to your cart" },
      { type: "urlIncludes", value: "/product-detail" },
      { type: "urlIncludes", value: "/6-mug-the-best-is-yet-to-come.html" },
    ],
    plan,
    "http://localhost:18081/6-mug-the-best-is-yet-to-come.html",
    { productKeyword: "马克杯" },
    "Added to your cart Mug The best is yet to come. There is 1 item in your cart.",
  );
  assert.deepEqual(aligned, [
    { type: "urlIncludes", value: "/6-mug-the-best-is-yet-to-come.html" },
  ]);
});

test("result evaluation renders the parameterized capability intent for each validation case", () => {
  const dynamicContract = { ...contract, intent: "将 {{商品}}加入购物车" };
  const rendered = renderCapabilityGoal(
    "将 Arc 弧光台灯加入购物车",
    dynamicContract,
    {
      parameters: { 商品: "Echo 桌面音箱" },
      context: {},
      interactions: [],
      trigger: {},
    },
  );
  assert.equal(rendered, "将 Echo 桌面音箱加入购物车");
});

test("shared input templates render Unicode and nested parameter paths", () => {
  const input = { 商品名称: "Echo 桌面音箱", recipient: { city: "杭州" } };
  assert.deepEqual(
    capabilityTemplateInputPaths(
      "将 {{商品名称}} 发往 {{recipient.city}}，再次确认 {{商品名称}}",
    ),
    ["商品名称", "recipient.city"],
  );
  assert.equal(
    renderCapabilityInputTemplate("{{商品名称}} 已加入购物车", input),
    "Echo 桌面音箱 已加入购物车",
  );
  assert.equal(
    renderCapabilityInputTemplate("发往 {{recipient.city}}", input),
    "发往 杭州",
  );
  assert.throws(
    () => renderCapabilityInputTemplate("{{缺失参数}}", input),
    /capability_input_required:缺失参数/,
  );
});

test("URL templates compare decoded Unicode query parameters in Runner and SDK semantics", () => {
  const input = { keyword: "Echo 桌面音箱" };
  const template = "https://example.test/demo/search?q={{keyword}}";
  assert.equal(
    capabilityUrlTemplateMatches(
      "https://example.test/demo/search?q=Echo+%E6%A1%8C%E9%9D%A2%E9%9F%B3%E7%AE%B1",
      template,
      input,
    ),
    true,
  );
  assert.equal(
    capabilityUrlTemplateMatches(
      "https://example.test/demo/search?extra=1&q=Echo%20%E6%A1%8C%E9%9D%A2%E9%9F%B3%E7%AE%B1",
      "/demo/search?q={{keyword}}",
      input,
    ),
    true,
  );
  assert.equal(
    capabilityUrlTemplateMatches(
      "https://example.test/demo/search?q=Arc",
      template,
      input,
    ),
    false,
  );
  assert.equal(
    capabilityUrlTemplateMatches(
      "https://other.test/demo/search?q=Echo%20%E6%A1%8C%E9%9D%A2%E9%9F%B3%E7%AE%B1",
      template,
      input,
    ),
    false,
  );
});

test("URL includes conditions accept the browser's percent-encoded Unicode URL", () => {
  assert.equal(
    capabilityUrlIncludes(
      "https://example.test/demo/search?category=%E5%87%BA%E8%A1%8C",
      "category=出行",
    ),
    true,
  );
  assert.equal(
    capabilityUrlIncludes(
      "https://example.test/demo/search?category=%E5%87%BA%E8%A1%8C",
      "category=家居",
    ),
    false,
  );
});

test("contract condition cleanup accepts equivalent nested model JSON", () => {
  const snapshot = {
    url: "https://example.test/",
    title: "商品",
    heading: "商品",
    text: "Arc 弧光台灯 Echo 桌面音箱",
    elements: [
      {
        index: 11,
        tag: "a",
        role: "link",
        name: "查看详情 →",
        container: {
          css: "article",
          text: "Arc 弧光台灯 查看详情 →",
          heading: "Arc 弧光台灯",
        },
      },
      {
        index: 12,
        tag: "a",
        role: "link",
        name: "查看详情 →",
        container: {
          css: "article",
          text: "Echo 桌面音箱 查看详情 →",
          heading: "Echo 桌面音箱",
        },
      },
    ],
  };
  const plan = cleanParameterPlan(
    {
      parameters: [
        { name: "productName", required: true, exampleValue: "Arc 弧光台灯" },
      ],
      groundingExamples: [
        { productName: "Arc 弧光台灯" },
        { productName: "Echo 桌面音箱" },
      ],
    },
    "将 Arc 弧光台灯加入购物车",
    {},
    snapshot,
  );
  assert.deepEqual(
    normalizeContractCondition(
      {
        type: "textIncludes",
        value: { type: "textTemplate", template: "{{productName}}" },
      },
      plan,
    ),
    { type: "textTemplate", template: "{{productName}}" },
  );
  assert.deepEqual(
    normalizeContractCondition(
      { type: "outputExists", value: "pageUrl" },
      plan,
    ),
    { type: "outputExists", path: "pageUrl" },
  );
  assert.deepEqual(
    normalizeContractCondition(
      { type: "outputExists", key: "pageTitle" },
      plan,
    ),
    { type: "outputExists", path: "pageTitle" },
  );
  assert.deepEqual(
    normalizeContractCondition({ type: "urlIncludes", url: "/demo" }, plan),
    { type: "urlIncludes", value: "/demo" },
  );
  assert.deepEqual(
    normalizeContractCondition(
      { type: "textIncludes", text: "加入成功" },
      plan,
    ),
    { type: "textIncludes", value: "加入成功" },
  );
  assert.deepEqual(
    normalizeContractCondition(
      { type: "textIncludes", textTemplate: "{{productName}} 已加入购物车" },
      plan,
    ),
    { type: "textTemplate", template: "{{productName}} 已加入购物车" },
  );
  assert.deepEqual(
    normalizeContractCondition(
      {
        type: "urlTemplate",
        template: "https://example.test/search?q={productName}",
      },
      plan,
    ),
    {
      type: "urlTemplate",
      template: "https://example.test/search?q={{productName}}",
    },
  );
  assert.deepEqual(
    normalizeContractCondition(
      { textTemplate: "{productName} 已加入购物车" },
      plan,
    ),
    { type: "textTemplate", template: "{{productName}} 已加入购物车" },
  );
  assert.doesNotThrow(() =>
    validateContractDesignResponse(
      {
        outputSchema: { type: "object" },
        preconditions: [
          {
            type: "urlTemplate",
            template: "https://example.test/demo?q={productName}",
          },
        ],
        successConditions: [
          { type: "textTemplate", template: "{productName} 已加入购物车" },
        ],
      },
      plan,
    ),
  );
  // A condition the model wrote in a form nothing can evaluate — an unknown
  // predicate, or one whose value never arrived — is dropped. It used to end
  // the discovery run: capability_contract_condition_value_missing threw away
  // a finished exploration and a working program over one malformed entry,
  // and there was nothing in that entry to repair.
  assert.deepEqual(
    normalizeContractConditions(
      [
        { type: "urlEquals", value: "https://example.test/demo" },
        { type: "textIncludes", value: "   " },
        { type: "outputExists", path: "pageUrl" },
      ],
      plan,
    ),
    [{ type: "outputExists", path: "pageUrl" }],
  );
  assert.doesNotThrow(() =>
    validateContractDesignResponse(
      {
        outputSchema: { type: "object" },
        preconditions: [
          { type: "urlEquals", value: "https://example.test/demo" },
        ],
        successConditions: [{ type: "outputExists", path: "pageUrl" }],
      },
      plan,
    ),
  );
  assert.deepEqual(
    normalizeContractConditions(
      [
        { outputExists: "pageUrl" },
        { textIncludes: { type: "textTemplate", template: "{{productName}}" } },
        { modelGoal: "确认商品已加入购物车" },
      ],
      plan,
    ),
    [
      { type: "outputExists", path: "pageUrl" },
      { type: "textTemplate", template: "{{productName}}" },
      { type: "modelGoal", goal: "确认商品已加入购物车" },
    ],
  );
  assert.deepEqual(
    normalizeContractConditions(
      { urlIncludes: "example.test", textIncludes: "已加入购物车" },
      plan,
    ),
    [
      { type: "urlIncludes", value: "example.test" },
      { type: "textIncludes", value: "已加入购物车" },
    ],
  );
  assert.deepEqual(
    stabilizeSuccessConditions(
      [
        { type: "urlIncludes", value: "/demo/products/arc-lamp" },
        { type: "textIncludes", textTemplate: "{{productName}} 已加入购物车" },
        { type: "outputExists", key: "pageUrl" },
        { type: "textIncludes", value: "Arc 弧光台灯 已加入购物车" },
        { type: "textIncludes", value: "加入购物车" },
      ],
      plan,
    ),
    [
      { type: "textTemplate", template: "{{productName}} 已加入购物车" },
      { type: "outputExists", path: "pageUrl" },
    ],
  );
});

test("quantity-dependent cart copy is not a cross-case contract gate", () => {
  const plan = {
    parameters: [
      {
        name: "productKeyword",
        type: "string",
        description: "商品",
        required: true,
        exampleValue: "mug",
      },
      {
        name: "quantity",
        type: "number",
        description: "数量",
        required: false,
        exampleValue: 1,
      },
    ],
  };
  assert.deepEqual(
    stabilizeSuccessConditions(
      [
        {
          type: "textTemplate",
          template: "There is {{quantity}} item in your cart.",
        },
        { type: "textTemplate", template: "购物车中有 {{quantity}} 件商品" },
        { type: "textIncludes", value: "added to your cart" },
        { type: "textTemplate", template: "{{productKeyword}}" },
      ],
      plan,
    ),
    [{ type: "textTemplate", template: "{{productKeyword}}" }],
  );
});

test("contract output schema cleanup wraps a model-returned property map", () => {
  assert.deepEqual(
    normalizeContractOutputSchema(
      {
        pageUrl: { type: "string", description: "URL" },
        pageTitle: { type: "string", description: "title" },
      },
      { pageUrl: "https://example.test", pageTitle: "Example" },
    ),
    {
      type: "object",
      properties: {
        pageUrl: { type: "string", description: "URL" },
        pageTitle: { type: "string", description: "title" },
      },
      required: ["pageUrl", "pageTitle"],
      additionalProperties: false,
    },
  );
  assert.deepEqual(
    normalizeContractOutputSchema(
      { type: "object", additionalProperties: true },
      { anything: "ok" },
    ),
    { type: "object", additionalProperties: true },
  );
});

test("a rebuild keeps the published contract's defaults, and the draft is run without each of them", () => {
  // The exploration planned `finish` as required; the published contract it is
  // rebuilt against makes it optional with a default. Without an example that
  // leaves it out, a correct candidate was refused after authoring finished.
  const contract = {
    intent: "Which wall lamps are available in {{finish}}?",
    inputSchema: { type: "object", properties: { finish: { type: "string", default: "brass" }, room: { type: "string" } }, required: [], additionalProperties: false },
    outputSchema: { type: "object", additionalProperties: true },
    preconditions: [],
    successConditions: [],
  };
  const explored = [{ finish: "brass", room: "hall" }, { finish: "matte black", room: "hall" }];
  const examples = store.withDefaultOmissionExamples(contract, explored);
  assert.deepEqual(examples, [...explored, { room: "hall" }]);
  assert.deepEqual(store.withDefaultOmissionExamples(contract, examples), examples, "an existing omission is not added twice");
  assert.deepEqual(store.withDefaultOmissionExamples(contract, []), [], "no example, nothing to derive from");
  const issues = (cases) => inspectCapabilityQuality(contract, { schemaVersion: "1.0", stages: [], parameterRoles: [], targetBindings: [], module: {} }, { validationCases: cases }).notes.map((issue) => issue.code);
  assert.ok(issues(explored).includes("default_omission_validation_required"));
  assert.ok(!issues(examples).includes("default_omission_validation_required"));
});

test("quality gate rejects malformed conditions and target success that ignores its input", () => {
  const report = inspectCapabilityQuality(
    {
      intent: "将 {{productName}} 加入购物车",
      inputSchema: {
        type: "object",
        properties: { productName: { type: "string" } },
        required: ["productName"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", additionalProperties: true },
      preconditions: [],
      successConditions: [
        { type: "textIncludes", textTemplate: "{{productName}} 已加入购物车" },
      ],
    },
    {
      ...program,
      parameterRoles: [{ inputPath: "productName", role: "target" }],
      targetBindings: [
        {
          inputPath: "productName",
          targetKind: "product",
          identityStatePath: "targets.productName",
          required: true,
        },
      ],
    },
  );
  assert.ok(
    report.issues.some((issue) => issue.code === "condition_value_missing"),
  );
  assert.ok(
    report.notes.some(
      (issue) => issue.code === "target_success_condition_required",
    ),
  );
});

test("quality gate enforces formal minimal scope matchers", () => {
  const undeclared = inspectCapabilityQuality(
    {
      ...contract,
      scope: {
        kind: "page-scoped",
        match: { requiredInputPaths: ["missing"] },
        onMismatch: "no-match",
      },
    },
    program,
  );
  assert.ok(
    undeclared.notes.some((issue) => issue.code === "scope_input_undeclared"),
  );

  const missingMatcher = inspectCapabilityQuality(
    {
      ...contract,
      scope: { kind: "page-scoped", onMismatch: "no-match" },
    },
    program,
  );
  assert.ok(
    missingMatcher.notes.some((issue) => issue.code === "page_scope_match_required"),
  );

  const siteGlobal = inspectCapabilityQuality(
    {
      ...contract,
      scope: { kind: "site-global", onMismatch: "page-agent" },
    },
    program,
  );
  assert.equal(siteGlobal.scopeVerdict, "pass");
});

test("quality gate rejects a generic capability that bakes in the demonstrated product", () => {
  const bad = inspectCapabilityQuality(
    {
      intent: "将指定商品加入购物车",
      inputSchema: {
        type: "object",
        properties: { productName: { type: "string" } },
        required: ["productName"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", additionalProperties: true },
      preconditions: [],
      successConditions: [
        { type: "textIncludes", value: "Arc 弧光台灯 已加入购物车" },
      ],
    },
    {
      ...program,
    },
    {
      demonstrationParameters: { productName: "Arc 弧光台灯" },
      validationCases: [{ productName: "Arc 弧光台灯" }],
      requireIndependentCases: true,
    },
  );
  assert.equal(bad.valid, false);
  assert.ok(
    bad.notes.some((issue) => issue.code === "required_input_not_consumed"),
  );
  // One validation case is not what is wrong here: a page that offers a single
  // value yields a single case, and refusing the capability for that meant it
  // was never generated. What is wrong is the program ignoring its own input
  // and the demonstrated product baked into a success condition.
  assert.equal(
    bad.notes.some((issue) => issue.code === "independent_validation_cases_required"),
    false,
  );
  assert.ok(
    bad.issues.some((issue) => issue.code === "demonstration_value_leaked"),
  );
});

test("quality gate does not treat parameterized site-language aliases as summary leakage", () => {
  const contract = {
    intent: "打开指定商品分类",
    inputSchema: {
      type: "object",
      properties: { categoryName: { type: "string" } },
      required: ["categoryName"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", additionalProperties: true },
    inputAliases: { categoryName: { 衣服: "Clothes", 配饰: "Accessories" } },
    preconditions: [{ type: "inputExists", path: "categoryName" }],
    successConditions: [{ type: "textTemplate", template: "{{categoryName}}" }],
  };
  const report = inspectCapabilityQuality(
    contract,
    {
      ...program,
      parameterRoles: [{ inputPath: "categoryName", role: "target" }],
      targetBindings: [
        {
          inputPath: "categoryName",
          targetKind: "category",
          identityStatePath: "targets.categoryName",
          required: true,
        },
      ],
    },
    {
      demonstrationParameters: { categoryName: "Clothes" },
      validationCases: [
        { categoryName: "Clothes" },
        { categoryName: "Accessories" },
      ],
      requireIndependentCases: true,
      summary: {
        name: "打开商品分类",
        description: "打开指定商品分类",
        aliases: ["进入分类"],
        contract,
      },
      source: `export const capability={version:2,stages:[{id:"complete",run({input}){return input.categoryName}}]};`,
    },
  );
  assert.equal(report.valid, true, JSON.stringify(report.issues));
});

test("contract success alignment removes a literal category URL template when the site uses an id slug", () => {
  const plan = cleanParameterPlan(
    {
      parameters: [
        {
          name: "categoryName",
          type: "string",
          required: true,
          exampleValue: "Clothes",
        },
      ],
      validationCases: [
        { categoryName: "Clothes" },
        { categoryName: "Accessories" },
      ],
    },
    "打开{{categoryName}}分类",
    {},
    { text: "Clothes Accessories", elements: [] },
  );
  const aligned = alignSuccessConditionsToEvidence(
    [
      { type: "urlTemplate", template: "/{{categoryName}}" },
      { type: "textTemplate", template: "{{categoryName}}" },
      { type: "outputExists", path: "pageUrl" },
    ],
    plan,
    "https://shop.example/3-clothes",
    { categoryName: "Clothes" },
  );
  assert.deepEqual(aligned, [
    { type: "textTemplate", template: "{{categoryName}}" },
    { type: "outputExists", path: "pageUrl" },
  ]);
});

test("contract success alignment removes an unparameterized demonstration product title", () => {
  const plan = cleanParameterPlan(
    {
      parameters: [
        {
          name: "productKeyword",
          type: "string",
          required: true,
          exampleValue: "mug",
        },
        {
          name: "color",
          type: "string",
          required: false,
          exampleValue: "white",
        },
      ],
      validationCases: [
        { productKeyword: "mug", color: "white" },
        { productKeyword: "cushion", color: "black" },
      ],
    },
    "查找{{productKeyword}}并加入购物车",
    { productKeyword: "mug", color: "white" },
    { text: "Added to your cart", elements: [] },
  );
  const aligned = alignSuccessConditionsToEvidence(
    [
      { type: "textIncludes", value: "Added to your cart" },
      {
        type: "textIncludes",
        value: "Mug The best is yet to come has been added to your cart.",
      },
      {
        type: "textTemplate",
        template: "There is {{quantity}} item in your cart.",
      },
    ],
    plan,
    "https://shop.example/6-mug-the-best-is-yet-to-come.html",
    { productKeyword: "mug", color: "white", quantity: 1 },
    "Mug The best is yet to come Added to your cart There is 1 item in your cart.",
  );
  assert.deepEqual(aligned, [
    {
      type: "textTemplate",
      template: "There is {{quantity}} item in your cart.",
    },
  ]);
});

test("transient completion copy is not persisted as a cross-context contract gate", () => {
  const plan = {
    parameters: [
      { name: "query", type: "string", required: true, exampleValue: "mug" },
    ],
  };
  assert.deepEqual(
    stabilizeSuccessConditions(
      [
        { type: "textIncludes", value: "Added to your cart" },
        {
          type: "textIncludes",
          value: "Your order was successfully submitted",
        },
        { type: "textTemplate", template: "{{query}}" },
      ],
      plan,
    ),
    [{ type: "textTemplate", template: "{{query}}" }],
  );
});

test("javascript module input-consumption gate rejects omitted public parameters", () => {
  const result = validateCapabilityJavaScriptSource(
    "export const capability={version:2,stages:[{id:'complete',async run({input}){return {outcome:'Success',output:{productKeyword:input.productKeyword}}}}]};",
    ["productKeyword", "color"],
  );
  assert.equal(result.ok, true, "a note does not refuse the module");
  assert.equal(result.notes[0].code, "capability_module_input_unused:color");
});

test("javascript module target gate requires target selection to reread the input", () => {
  const result = validateCapabilityJavaScriptSource(
    "export const capability={version:2,stages:[{id:'resolve',async run({input}){return {outcome:'Continue',state:{q:input.query}}}},{id:'select',async run(){return {outcome:'Continue'}}}]};",
    ["query"],
    ["query"],
  );
  assert.equal(result.ok, true, "a note does not refuse the module");
  assert.equal(result.notes[0].code, "capability_module_target_input_not_reused:query");
});

test("javascript module verifier accepts optional-chaining input reads", () => {
  const result = validateCapabilityJavaScriptSource(
    "export const capability={version:2,stages:[{id:'resolve',async run({input}){const color=input?.color;return {outcome:'Continue',state:{color}}}},{id:'select',async run({input}){const color=input?.color;return {outcome:'Continue',state:{color}}}},{id:'stage_verify',async run({input}){const color=input?.color;return {outcome:'Success',output:{color}}}}]};",
    ["color"],
    ["color"],
  );
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("javascript module target gate rejects first-candidate fallback", () => {
  const result = validateCapabilityJavaScriptSource(
    "export const capability={version:2,stages:[{id:'select',async run({input}){const query=input.query;const candidates=[...document.querySelectorAll('a[href]')];const selected=candidates[0];selected?.click();return {outcome:'Continue',state:{query}}}}]};",
    ["query"],
    ["query"],
  );
  assert.equal(result.ok, true, "a note does not refuse the module");
  assert.equal(result.notes[0].code, "capability_module_target_first_candidate_forbidden");
});

test("javascript module target gate rejects incomplete candidate find", () => {
  const result = validateCapabilityJavaScriptSource(
    "export const capability={version:2,stages:[{id:'select',async run({input}){const query=input.query;const candidates=[...document.querySelectorAll('a[href]')];const selected=candidates.find(candidate=>candidate.href);selected?.click();return {outcome:'Continue',state:{query}}}},{id:'stage_verify',async run({input}){return {outcome:'Success',output:{query:input.query}}}}]};",
    ["query"],
    ["query"],
  );
  assert.equal(result.ok, true, "a note does not refuse the module");
  assert.equal(result.notes[0].code, "capability_module_target_first_candidate_forbidden");
});

test("javascript module target gate rejects candidate find without executable proof", () => {
  const result = validateCapabilityJavaScriptSource(
    "export const capability={version:2,stages:[{id:'select',async run({input}){const query=input.query;const candidates=[...document.querySelectorAll('a[href]')];const selected=candidates.find(candidate=>candidate.matchesAllInputs);selected?.click();return {outcome:'Continue',state:{query}}}},{id:'stage_verify',async run({input}){return {outcome:'Success',output:{query:input.query}}}}]};",
    ["query"],
    ["query"],
  );
  assert.equal(result.ok, true, "a note does not refuse the module");
  assert.equal(result.notes[0].code, "capability_module_target_first_candidate_forbidden");
});

test("javascript module target gate accepts complete match and executable action proof", () => {
  const result = validateCapabilityJavaScriptSource(
    "export const capability={version:2,stages:[{id:'select',async run({input}){const query=input.query;const candidates=[...document.querySelectorAll('a[href]')].map(link=>({link,href:link.href,matchesAllInputs:link.textContent.toLowerCase().includes(query.toLowerCase()),enabledAction:!link.hasAttribute('aria-disabled')}));const selected=candidates.find(candidate=>candidate.matchesAllInputs&&candidate.enabledAction);selected?.link.click();return {outcome:'Continue',state:{query}}}},{id:'stage_verify',async run({input}){return {outcome:'Success',output:{query:input.query}}}}]};",
    ["query"],
    ["query"],
  );
  assert.deepEqual(result, { ok: true });
});

test("javascript module rejects document-wide add-to-cart fallback", () => {
  const result = validateCapabilityJavaScriptSource(
    "export const capability={version:2,stages:[{id:'write',async run({input}){const query=input.query.toLowerCase();const buttons=document.querySelectorAll(\"button:not([disabled])\");const button=[...buttons].find((item)=>item.textContent.toLowerCase().includes('add to cart')||item.textContent.toLowerCase().includes(query));button?.click();return {outcome:'Continue'}}},{id:'stage_verify',async run({input}){return {outcome:'Success',output:{query:input.query}}}}]};",
    ["query"],
    ["query"],
  );
  assert.equal(result.ok, true, "a note does not refuse the module");
  assert.equal(result.notes[0].code, "capability_module_related_add_to_cart_fallback");
});

test("javascript module rejects document-wide related variant navigation", () => {
  const result = validateCapabilityJavaScriptSource(
    "export const capability={version:2,stages:[{id:'select',async run({input}){const color=input.color;const links=document.querySelectorAll('a[href*=color-]');let href='';for(const link of links){href=link.href;break}if(href){location.assign(href)}return {outcome:'Continue',state:{color}}}}]};",
    ["color"],
    ["color"],
  );
  assert.equal(result.ok, true, "a note does not refuse the module");
  assert.equal(result.notes[0].code, "capability_module_related_variant_navigation");
});

test("javascript module rejects quoted document-wide variant href selectors", () => {
  const result = validateCapabilityJavaScriptSource(
    "export const capability={version:2,stages:[{id:'select',async run({input}){const color=input.color;const options=document.querySelectorAll('input[type=\"radio\"], a[href*=\"color\"]');for(const option of options){if(option.href){location.assign(option.href);break}}return {outcome:'Continue',state:{color}}}}]};",
    ["color"],
    ["color"],
  );
  assert.equal(result.ok, true, "a note does not refuse the module");
  assert.equal(result.notes[0].code, "capability_module_related_variant_navigation");
});

test("runner rejects detail-to-detail target changes outside target selection", () => {
  assert.equal(
    isSuspiciousDetailTransition(
      "http://localhost:18081/6-mug-the-best-is-yet-to-come.html",
      "http://localhost:18081/11-26-hummingbird-cushion.html#/8-color-white",
      "stage_apply_facet",
    ),
    true,
  );
  assert.equal(
    isSuspiciousDetailTransition(
      "http://localhost:18081/search?controller=search&s=mug",
      "http://localhost:18081/6-mug-the-best-is-yet-to-come.html",
      "stage_select_target",
    ),
    false,
  );
  assert.equal(
    isSuspiciousDetailTransition(
      "http://localhost:18081/6-mug-the-best-is-yet-to-come.html",
      "http://localhost:18081/6-mug-the-best-is-yet-to-come.html#/8-color-white",
      "stage_apply_facet",
    ),
    false,
  );
});

test("javascript module rejects fixed cart confirmation sentences", () => {
  const result = validateCapabilityJavaScriptSource(
    "export const capability={version:2,stages:[{id:'stage_verify',async run({input}){const text=document.body.innerText;return {outcome:text.includes('Your cart contains 1 of these products')?'Success':'BusinessRejection',output:{product:input.query}}}}]};",
    [],
  );
  assert.equal(result.ok, true, "a note does not refuse the module");
  assert.equal(result.notes[0].code, "capability_module_fixed_cart_success_text");
});

test("grounding examples of a positionally selected capability can be independent", () => {
  // {rank: 4} and {rank: 1} differ, so the repair judge must accept them. It
  // compared identity parameters only, and a capability selected by rank has
  // none — 打开指定排名的热搜 could not be regenerated at all.
  assert.equal(groundingExamplesDiffer(["rank"], [{ rank: 4 }, { rank: 1 }]), true);
  assert.equal(groundingExamplesDiffer(["rank"], [{ rank: 4 }, { rank: 4 }]), false);
  assert.equal(groundingExamplesDiffer([], [{ rank: 4 }, { rank: 1 }]), false, "comparing nothing proves nothing");
  assert.equal(groundingExamplesDiffer(["query"], [{ query: "mug", color: "white" }, { query: "cushion", color: "white" }]), true);
  assert.equal(groundingExamplesDiffer(["query"], [{ query: "mug", color: "white" }, { query: "mug", color: "brown" }]), false, "a facet alone is not an independent target");
  assert.equal(groundingExamplesDiffer(["rank"], [{ rank: 4 }]), false);
});

test("javascript module rejects an identity sliced out from between page phrases", () => {
  // Verbatim from a production module of 打开指定排名的热搜 on a trending-topics
  // site (2026-09-24): the title was defined as the text between "Close" and one of
  // three badge phrases. Both validation cases passed; every topic whose dialog
  // carried none of those badges then failed with an unrecognized runtime fault.
  const result = validateCapabilityJavaScriptSource(
    `export const capability={version:2,stages:[{id:"stage_verify",async run({input}){const dialog=document.querySelector('[role="dialog"]');const dialogText=dialog.innerText;const titleMatch=dialogText.match(/Close\\s*([\\s\\S]+?)\\s*(?:短时热点|冲进前三|最近第)/);if(!titleMatch){throw new Error("Cannot extract topic title from dialog")}return {outcome:"Success",output:{targetTitle:titleMatch[1].trim(),targetUrl:location.href}}}}]};`,
    [],
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "capability_module_verification_text_slicing");
  // The same shape in English prose is the same defect.
  assert.equal(validateCapabilityJavaScriptSource(
    `export const capability={version:2,stages:[{id:"stage_verify",async run(){const t=document.body.innerText;const m=t.match(/Order summary\\s*([\\s\\S]+?)\\s*Estimated delivery/);return {outcome:"Success",output:{title:m[1]}}}}]};`,
    [],
  ).code, "capability_module_verification_text_slicing");
});

test("javascript module keeps structural reads and presence checks", () => {
  // A structural pattern around a number is not prose: 第 (\d+) 名 stays legal.
  assert.deepEqual(validateCapabilityJavaScriptSource(
    `export const capability={version:2,stages:[{id:"stage_verify",async run(){const t=document.querySelector('[role="dialog"]').innerText;const m=t.match(/第\\s*(\\d+)\\s*名/);const title=document.querySelector("h1").textContent;return {outcome:"Success",output:{title,rank:Number(m[1])}}}}]};`,
    [],
  ), { ok: true });
  // Asserting that a phrase is present is a check, not an extraction anchor.
  assert.deepEqual(validateCapabilityJavaScriptSource(
    `export const capability={version:2,stages:[{id:"stage_verify",async run(){const t=document.body.innerText;if(!/已经加入购物车/u.test(t))return{outcome:"NoResult"};return {outcome:"Success",output:{title:document.querySelector("h1").textContent}}}}]};`,
    [],
  ), { ok: true });
  // The shape the seed and the prompt ask for: identity from state, output from structure.
  assert.deepEqual(validateCapabilityJavaScriptSource(
    `export const capability={version:2,stages:[{id:"stage_verify",async run({state}){const actedOn=state.targets.__actedOn;const heading=document.querySelector('[role="dialog"] h2')?.textContent?.trim();if(!heading||!actedOn.includes(heading))return{outcome:"NoResult"};return {outcome:"Success",output:{targetTitle:heading,targetUrl:location.href}}}}]};`,
    [],
  ), { ok: true });
});

test("quality gate rejects a required input no acting stage reads", () => {
  // The manifest of 打开热搜榜指定排名详情 as it was published (2026-09-25):
  // `rank` carries a parameter role, so the older "is it consumed" check
  // passed, but the only stage that declares it is the terminal read stage.
  // The program acted identically for every rank.
  const contract = {
    intent: "打开热搜榜指定排名的话题详情",
    inputSchema: { type: "object", properties: { rank: { type: "number" } }, required: ["rank"], additionalProperties: false },
    outputSchema: { type: "object", additionalProperties: true },
    preconditions: [],
    successConditions: [{ type: "outputExists", path: "currentRank" }],
  };
  const stages = [
    { id: "stage_1", title: "click", purpose: "replay", effect: "write", resumePolicy: "reconcile-before-retry", navigation: "optional", io: { reads: { input: [], state: [] }, writes: { state: ["targets.__actedOn"], output: [] } } },
    { id: "stage_verify", title: "verify", purpose: "report", effect: "read", resumePolicy: "skip-completed", navigation: "none", io: { reads: { input: ["rank"], state: ["targets.__actedOn"] }, writes: { state: [], output: ["currentRank"] } } },
  ];
  const program = {
    schemaVersion: "2.0", runtime: "BrowserJavaScriptStage",
    module: { contentHash: "a".repeat(64), moduleUrl: "/m", exportName: "capability" },
    entry: { mode: "CurrentPage" },
    stages,
    parameterRoles: [{ inputPath: "rank", role: "context" }],
    targetBindings: [],
  };
  const report = inspectCapabilityQuality(contract, program, {});
  assert.equal(report.valid, true, "a note does not block");
  assert.ok(report.notes.some((issue) => issue.code === "required_input_does_not_parameterize"), JSON.stringify(report.notes));

  // Reading it in the stage that acts is the whole difference.
  const acting = { ...program, stages: [{ ...stages[0], io: { ...stages[0].io, reads: { input: ["rank"], state: [] } } }, stages[1]] };
  assert.deepEqual(inspectCapabilityQuality(contract, acting, {}).notes, []);

  // A required input no stage declares at all is the same defect.
  const unread = { ...program, stages: [stages[0], { ...stages[1], io: { ...stages[1].io, reads: { input: [], state: ["targets.__actedOn"] } } }] };
  assert.ok(inspectCapabilityQuality(contract, unread, {}).notes.some((issue) => issue.code === "required_input_does_not_parameterize"));

  // A capability that only reads has no acting stage to hold to this, and the
  // module source gate is what requires its one stage to use the input.
  const readOnly = { ...program, stages: [{ ...stages[1], io: { reads: { input: ["rank"], state: [] }, writes: { state: [], output: ["currentRank"] } } }] };
  assert.deepEqual(inspectCapabilityQuality(contract, readOnly, {}).issues, []);
});

test("javascript module rejects a guard that is written and then thrown away", () => {
  // Verbatim from the regenerated "open the topic at rank N" capability
  // (2026-09-26). The model
  // wrote the check that the title belongs to the item the action acted on,
  // gave it an empty body, and fell through to a title read from elsewhere on
  // the page. The capability passed both validation cases returning the site's
  // own document title for every rank.
  const withGuard = (body) => `export const capability={version:2,stages:[{id:"stage_verify",async run({state,identityMatches}){const actedOn=state.targets.__actedOn;const targetTitle=document.querySelector("h1").textContent;if(targetTitle&&!identityMatches(actedOn,targetTitle)){${body}}return{outcome:"Success",output:{targetTitle}}}}]};`;
  const refused = validateCapabilityJavaScriptSource(withGuard(""), []);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "capability_module_empty_branch");
  // Acting on it is the repair.
  assert.deepEqual(validateCapabilityJavaScriptSource(withGuard('return{outcome:"NoResult",reason:"not the acted-on item"}'), []), { ok: true });
  // A branch with a body is not a finding, however close it sits to an empty one.
  assert.deepEqual(validateCapabilityJavaScriptSource(
    `export const capability={version:2,stages:[{id:"stage_verify",async run(){const t=document.body.innerText;const m=t.match(/(\\d+)/);let rank=0;if(m){rank=Number(m[1])}const title=document.querySelector("h1").textContent;return{outcome:"Success",output:{title,rank}}}}]};`,
    [],
  ), { ok: true });
});

test("validation refuses one answer given to cases that were meant to differ", () => {
  const cases = [
    { expected: { currentRank: 1, targetTitle: "Leaders tour the National Archives" } },
    { expected: { currentRank: 5, targetTitle: "Table tennis sweep celebrated" } },
  ];
  // What the regenerated capability actually returned: the site's own document
  // title, for both ranks. Each case passed on its own, because a title is not
  // one of the input's values and so counted only as drift.
  const siteTitle = "Trending history and daily charts - Example Site";
  assert.deepEqual(
    outputsConstantAcrossCases(cases, [
      { currentRank: 1, targetTitle: siteTitle },
      { currentRank: 5, targetTitle: siteTitle },
    ]),
    ["targetTitle"],
  );
  // Reading it from the item is what the cases were for.
  assert.deepEqual(
    outputsConstantAcrossCases(cases, [
      { currentRank: 1, targetTitle: "Leaders tour the National Archives" },
      { currentRank: 5, targetTitle: "Table tennis sweep celebrated" },
    ]),
    [],
  );
  // A field the expectations agree about is not examined: it is allowed to be
  // the same for every case.
  assert.deepEqual(
    outputsConstantAcrossCases(
      [{ expected: { currency: "CNY", total: 10 } }, { expected: { currency: "CNY", total: 20 } }],
      [{ currency: "CNY", total: 10 }, { currency: "CNY", total: 20 }],
    ),
    [],
  );
  // One case cannot show anything, and neither can a missing output.
  assert.deepEqual(outputsConstantAcrossCases([cases[0]], [{ targetTitle: siteTitle }]), []);
  assert.deepEqual(outputsConstantAcrossCases(cases, [{ targetTitle: siteTitle }, {}]), []);
});

test("a title sliced out of the dialog's text on one line is still a slice", () => {
  // Published as version 75c7ff4f (2026-09-26): the title was the text before
  // 冲进前三 in dialog.innerText. The rule's receiver check demanded a trailing
  // dot the slice never contained, so it never saw where the text came from
  // and only the cross-line path ever fired.
  const oneLine = `export const capability={version:2,stages:[{id:"stage_verify",async run(){const dialog=document.querySelector('[role="dialog"]');const text=dialog.innerText;const m=text.match(/([\\u4e00-\\u9fa5][^\\n]*?)\\s*冲进前三/);return{outcome:"Success",output:{title:m?m[1]:null}}}}]};`;
  assert.equal(validateCapabilityJavaScriptSource(oneLine, []).code, "capability_module_verification_text_slicing");
  // Directly on the blob, and through document.body, the same.
  assert.equal(validateCapabilityJavaScriptSource(oneLine.replace("const text=dialog.innerText;const m=text.match", "const m=dialog.innerText.match"), []).code, "capability_module_verification_text_slicing");
  assert.equal(validateCapabilityJavaScriptSource(oneLine.replace("dialog.innerText", "document.body.innerText"), []).code, "capability_module_verification_text_slicing");
  // The same capture off the element that carries the title is a reading.
  const fromNode = oneLine.replace("const text=dialog.innerText;", 'const text=dialog.querySelector("h2").innerText;');
  assert.deepEqual(validateCapabilityJavaScriptSource(fromNode, []), { ok: true });
});

test("javascript module keeps a labelled value read off the element that carries it", () => {
  // Verbatim from 搜索微博历史热搜 (2026-09-25), the version the authoring model
  // reached after three rounds of repair: titles come from `h3 > mark` — the
  // structure the rule asks for — and the counts beside them are read off their
  // own spans, which is the only place the page publishes them. The rule
  // refused it twice in a row on those counts and the run was abandoned, while
  // the module in the test above, which does slice an identity out of a dialog,
  // passed. Both were decided by counting the characters of the literal.
  assert.deepEqual(validateCapabilityJavaScriptSource(
    `export const capability={version:2,stages:[{id:"stage_verify",async run(){const c=document.querySelector("main");const links=[...c.querySelectorAll('a[href^="/topic/"]')];const bodyText=document.body.innerText;const totalMatch=bodyText.match(/找到\\s+(\\d+)\\s*条包含/);const results=[];for(const link of links){const title=link.querySelector("h3 mark").innerText.trim();for(const span of link.querySelectorAll("span")){const text=span.innerText.trim();const recordMatch=text.match(/上榜记录\\s+(\\d+)\\s*条/);const heatMatch=text.match(/最高热度\\s+(.+)/);const dateMatch=text.match(/最近上榜\\s+(.+)/);if(recordMatch||heatMatch||dateMatch)results.push({title})}}return {outcome:"Success",output:{results,totalRecords:Number(totalMatch[1])}}}}]};`,
    [],
  ), { ok: true });
});

test("javascript module rejects a required input that only the final stage reads", () => {
  // Verbatim shape of 打开热搜榜指定排名详情 (2026-09-25). `rank` is read — in the
  // terminal stage, into the evidence — while the action stage says `void input`
  // and clicks a recorded nth-of-type path. Every rank opened the same topic.
  // It satisfied "the source consumes input.rank", passed its own replay, and
  // was caught by independent validation only because the predicted output
  // happened to repeat the input value.
  const fixed = `export const capability={version:2,stages:[`
    + `{id:"stage_1",io:{reads:{input:[],state:[]},writes:{state:["targets.__actedOn"],output:[]}},async run({input,waitForTarget}){void input;const el=await waitForTarget({strategies:[{type:"css",value:"#current-hotlist > div:nth-of-type(3)"}]});el.click();return{outcome:"Continue",state:{targets:{__actedOn:el.textContent}}}}},`
    + `{id:"stage_verify",io:{reads:{input:["rank"],state:[]},writes:{state:[],output:["currentRank"]}},async run({input}){const requestedRank=input["rank"];const h=document.querySelector('[role="dialog"] h2').textContent;return{outcome:"Success",output:{targetTitle:h},evidence:[{kind:"status",value:{requestedRank}}]}}}]};`;
  const result = validateCapabilityJavaScriptSource(fixed, ["rank"]);
  assert.equal(result.ok, false);
  assert.equal(result.code, "capability_module_input_not_acted_on:rank");

  // Using it to choose what to act on is the repair, and it is accepted.
  const parameterized = fixed.replace(
    `void input;const el=await waitForTarget({strategies:[{type:"css",value:"#current-hotlist > div:nth-of-type(3)"}]})`,
    `const el=[...document.querySelectorAll("#current-hotlist [data-rank]")].find((item)=>Number(item.dataset.rank)===input["rank"])`,
  );
  assert.deepEqual(validateCapabilityJavaScriptSource(parameterized, ["rank"]), { ok: true });

  // A capability that only reads has no stage before the terminal one, and the
  // terminal stage is where its input belongs.
  assert.deepEqual(validateCapabilityJavaScriptSource(
    `export const capability={version:2,stages:[{id:"stage_verify",async run({input}){const row=document.querySelector(\`[data-rank="\${input["rank"]}"]\`);return{outcome:"Success",output:{title:row.textContent}}}}]};`,
    ["rank"],
  ), { ok: true });
});

test("javascript module ignores fixed cart examples in comments", () => {
  const result = validateCapabilityJavaScriptSource(
    "export const capability={version:2,stages:[{id:'stage_verify',async run({input}){/* Do not use `Your cart contains 1 item` as a real check. */ const text=document.body.innerText; const dialog=document.querySelector('[role=dialog]'); const count=document.querySelector('[data-cart-count]')?.textContent||''; return {outcome:dialog||count?'Success':'BusinessRejection',output:{query:input.query},evidence:[{kind:'observed',value:{text,count}}]}}}]};",
    ["query"],
  );
  assert.deepEqual(result, { ok: true });
});

test("javascript module rejects invented customization text", () => {
  const result = validateCapabilityJavaScriptSource(
    "export const capability={version:2,stages:[{id:'write',async run({input}){const query=input.query;const area=document.querySelector('textarea');area.value='Hello';return {outcome:'Continue',state:{query}}}},{id:'stage_verify',async run({input}){return {outcome:'Success',output:{query:input.query}}}}]};",
    ["query"],
    ["query"],
  );
  assert.equal(result.ok, true, "a note does not refuse the module");
  assert.equal(result.notes[0].code, "capability_module_invented_customization");
});

test("javascript module rejects native search form submit", () => {
  const result = validateCapabilityJavaScriptSource(
    "export const capability={version:2,stages:[{id:'resolve',async run({input}){const searchForm=document.querySelector('form');const query=input.query;searchForm.submit();return {outcome:'Continue',state:{query}}}},{id:'stage_verify',async run({input}){return {outcome:'Success',output:{query:input.query}}}}]};",
    ["query"],
    ["query"],
  );
  assert.equal(result.ok, true, "a note does not refuse the module");
  assert.equal(result.notes[0].code, "capability_module_search_form_submit_unsafe");
});

test("quality gate ignores demonstration examples in comments but rejects executable literals", () => {
  const dynamicContract = {
    intent: "将 {{productName}} 加入购物车",
    inputSchema: {
      type: "object",
      properties: { productName: { type: "string" } },
      required: ["productName"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", additionalProperties: true },
    preconditions: [],
    successConditions: [
      { type: "textTemplate", template: "{{productName}} 已加入购物车" },
    ],
  };
  const dynamicProgram = {
    ...program,
    parameterRoles: [{ inputPath: "productName", role: "target" }],
    targetBindings: [
      {
        inputPath: "productName",
        targetKind: "product",
        identityStatePath: "targets.productName",
        required: true,
      },
    ],
  };
  const baseOptions = {
    demonstrationParameters: { productName: "Arc 弧光台灯" },
    validationCases: [
      { productName: "Arc 弧光台灯" },
      { productName: "Echo 桌面音箱" },
    ],
    requireIndependentCases: true,
  };
  const commentOnly = inspectCapabilityQuality(
    dynamicContract,
    dynamicProgram,
    {
      ...baseOptions,
      source: `// Example: Arc 弧光台灯\nexport const capability={version:2,stages:[{id:"complete",run({input}){return input.productName}}]};`,
    },
  );
  assert.equal(commentOnly.valid, true, JSON.stringify(commentOnly.issues));
  const executable = inspectCapabilityQuality(dynamicContract, dynamicProgram, {
    ...baseOptions,
    source: `export const example="Arc 弧光台灯"; export const capability={version:2,stages:[{id:"complete",run({input}){return input.productName}}]};`,
  });
  assert.ok(
    executable.issues.some(
      (issue) =>
        issue.code === "demonstration_value_leaked" &&
        issue.path === "source.productName",
    ),
  );
  const stripped = stripJavaScriptComments(
    `const url="https://example.test/a"; /* Arc 弧光台灯 */ const value='keep'; // Arc 弧光台灯`,
  );
  assert.match(stripped, /https:\/\/example\.test\/a/);
  assert.doesNotMatch(stripped, /Arc 弧光台灯/);
});

test("quality gate accepts scoped dynamic targeting with two independent cases", () => {
  const good = inspectCapabilityQuality(
    {
      intent: "将指定商品加入购物车",
      inputSchema: {
        type: "object",
        properties: { productName: { type: "string" } },
        required: ["productName"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", additionalProperties: true },
      preconditions: [],
      successConditions: [
        { type: "textTemplate", template: "{{productName}} 已加入购物车" },
      ],
    },
    {
      ...program,
      parameterRoles: [{ inputPath: "productName", role: "target" }],
      targetBindings: [
        {
          inputPath: "productName",
          targetKind: "product",
          identityStatePath: "selectedProduct",
          required: true,
        },
      ],
    },
    {
      demonstrationParameters: { productName: "Arc 弧光台灯" },
      validationCases: [
        { productName: "Arc 弧光台灯" },
        { productName: "Echo 桌面音箱" },
      ],
      requireIndependentCases: true,
    },
  );
  assert.equal(good.valid, true, JSON.stringify(good.issues));
});

test("quality gate requires source consumption, write reconciliation and distinct target evidence", () => {
  const dynamicContract = {
    intent: "将 {{productName}} 加入购物车",
    inputSchema: {
      type: "object",
      properties: { productName: { type: "string" } },
      required: ["productName"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", additionalProperties: true },
    preconditions: [],
    successConditions: [
      { type: "textTemplate", template: "{{productName}} 已加入购物车" },
    ],
  };
  const dynamicProgram = {
    ...program,
    stages: [
      {
        id: "add",
        title: "Add",
        purpose: "Add selected product",
        effect: "write",
        resumePolicy: "skip-completed",
        io: {
          reads: { input: ["productName"], state: [] },
          writes: { state: ["targets.productName"], output: [] },
        },
        navigation: "optional",
      },
    ],
    parameterRoles: [{ inputPath: "productName", role: "target" }],
    targetBindings: [
      {
        inputPath: "productName",
        targetKind: "product",
        identityStatePath: "targets.productName",
        required: true,
      },
    ],
  };
  const rejected = inspectCapabilityQuality(dynamicContract, dynamicProgram, {
    demonstrationParameters: { productName: "Arc 弧光台灯" },
    validationCases: [
      { productName: "Arc 弧光台灯" },
      { productName: "Echo 桌面音箱" },
    ],
    requireIndependentCases: true,
    requireTargetEvidence: true,
    targetEvidence: [
      { kind: "target", key: "productName", value: "arc-lamp", unique: true },
    ],
    source: "export const capability={version:2,stages:[]};",
  });
  assert.ok(
    rejected.notes.some(
      (issue) => issue.code === "write_stage_reconciliation_required",
    ),
  );
  assert.ok(
    rejected.notes.some(
      (issue) => issue.code === "declared_input_not_consumed_by_source",
    ),
  );
  assert.ok(
    rejected.notes.some(
      (issue) => issue.code === "independent_target_evidence_required",
    ),
  );
  const accepted = inspectCapabilityQuality(
    dynamicContract,
    {
      ...dynamicProgram,
      stages: dynamicProgram.stages.map((stage) => ({
        ...stage,
        resumePolicy: "reconcile-before-retry",
      })),
    },
    {
      demonstrationParameters: { productName: "Arc 弧光台灯" },
      validationCases: [
        { productName: "Arc 弧光台灯" },
        { productName: "Echo 桌面音箱" },
      ],
      requireIndependentCases: true,
      requireTargetEvidence: true,
      targetEvidence: [
        { kind: "target", key: "productName", value: "arc-lamp", unique: true },
        {
          kind: "target",
          key: "productName",
          value: "echo-speaker",
          unique: true,
        },
      ],
      source:
        "export const capability={version:2,stages:[{id:'add',run({input}){return input.productName}}]};",
    },
  );
  assert.equal(accepted.valid, true, JSON.stringify(accepted.issues));
});

test("V2 closes Discovery -> Validation -> verdict -> Publish without legacy data", async () => {
  const discovery = await createCapabilityTask(siteId, {
    type: "Discovery",
    goal: "加入购物车",
    input: {
      candidateSummary: {
        name: "加入购物车",
        description: "将商品加入购物车",
        aliases: ["加购"],
        contract,
      },
      program,
      context: { startUrl: "https://example.test/product/1" },
      parameters: {},
      interactions: [],
      trigger: {},
    },
  });
  assert.equal(discovery.task.status, "Pending");
  await claimTask(siteId, discovery.task.id, "runner-discovery");
  const completed = await submitTaskResult(
    siteId,
    discovery.task.id,
    "runner-discovery",
    { outcome: "Success", candidateProgram: program, output: {} },
  );
  assert.equal(
    completed.task.status,
    "Succeeded",
    JSON.stringify(completed.task.error),
  );
  assert.equal(completed.task.result?.versionId, discovery.task.versionId);

  const capabilityId = completed.task.result?.capabilityId;
  assert.ok(capabilityId);
  const versions = await listVersions(siteId, capabilityId);
  assert.equal(versions.versions.length, 1);
  assert.equal(versions.versions[0].status, "Draft");

  const validation = await createCapabilityTask(siteId, {
    type: "Validation",
    versionId: versions.versions[0].id,
    goal: "独立验证加入购物车",
    input: {
      parameters: {},
      context: { startUrl: "https://example.test/product/1" },
      interactions: [],
      trigger: {},
    },
  });
  await claimTask(siteId, validation.task.id, "runner-validation");
  const validated = await submitTaskResult(
    siteId,
    validation.task.id,
    "runner-validation",
    { outcome: "Success", output: {} },
  );
  assert.equal(validated.task.status, "Succeeded");

  const reviewed = await reviewVersion(siteId, versions.versions[0].id, {
    decision: "Approved",
    model: "test-model",
  });
  assert.equal(reviewed.version.status, "Published");
  const active = await getCapability(siteId, capabilityId);
  assert.equal(active?.status, "Active");
  assert.equal(active?.currentVersionId, versions.versions[0].id);
});

test("administrator rebuild creates a new draft on the same capability and repair reuses successful task context", async () => {
  const dynamicContract = {
    intent: "搜索 {{query}}",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", title: "搜索词" } },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", additionalProperties: true },
    preconditions: [],
    successConditions: [{ type: "textTemplate", template: "{{query}}" }],
  };
  const dynamicSource = `export const capability={version:2,stages:[{id:"search",async run({input}){const query=String(input.query??"");return {outcome:"Success",output:{query}}}}]};`;
  const dynamicProgram = await makeProgram(dynamicSource, {
    stages: [
      {
        id: "search",
        title: "Search",
        purpose: "Search by keyword",
        effect: "read",
        resumePolicy: "skip-completed",
      },
    ],
    parameterRoles: [{ inputPath: "query", role: "value" }],
  });
  const discovery = await createCapabilityTask(siteId, {
    type: "Discovery",
    goal: "搜索 Arc",
    input: {
      candidateSummary: {
        name: "搜索商品",
        description: "按关键词搜索商品",
        aliases: ["商品搜索"],
        contract: dynamicContract,
      },
      parameters: { query: "Arc" },
      context: {
        startUrl: "https://example.test",
        initialLocalStorage: { cart: '["arc"]' },
      },
      interactions: [],
      trigger: {},
    },
  });
  await claimTask(siteId, discovery.task.id, "runner-source");
  const completed = await submitTaskResult(
    siteId,
    discovery.task.id,
    "runner-source",
    {
      outcome: "Success",
      candidateProgram: dynamicProgram,
      candidateSource: dynamicSource,
      candidateSummary: {
        name: "搜索商品",
        description: "按关键词搜索商品",
        aliases: ["商品搜索"],
        contract: dynamicContract,
      },
      demonstrationParameters: { query: "Arc" },
      validationCases: [{ query: "Arc" }, { query: "Echo" }],
    },
  );
  const capabilityId = completed.task.result.capabilityId;
  const publishedVersionId = completed.task.result.versionId;
  const validation = await createCapabilityTask(siteId, {
    type: "Validation",
    versionId: publishedVersionId,
    goal: "验证搜索商品",
    input: completed.task.input,
  });
  await claimTask(siteId, validation.task.id, "runner-validation");
  await submitTaskResult(siteId, validation.task.id, "runner-validation", {
    outcome: "Success",
    validationCaseCount: 2,
  });
  await reviewVersion(siteId, publishedVersionId, { decision: "Approved" });

  const defaults = await getCapabilityMaintenanceDefaults(siteId, capabilityId);
  assert.equal(defaults.sourceTaskId, discovery.task.id);
  assert.deepEqual(defaults.parameters, { query: "Arc" });

  const rebuild = await createCapabilityMaintenanceTask(siteId, capabilityId, {
    mode: "Rebuild",
    parameters: { query: "Echo" },
    guidance: "重新探索搜索入口",
  });
  assert.equal(rebuild.task.type, "Discovery");
  assert.notEqual(rebuild.task.versionId, publishedVersionId);
  assert.deepEqual(getTaskMaintenance(rebuild.task), {
    mode: "Rebuild",
    capabilityId,
  });
  assert.equal(rebuild.task.input.parameters.query, "Echo");
  assert.deepEqual(rebuild.task.input.context.initialLocalStorage, {
    cart: '["arc"]',
  });
  // A rebuild runs the pipeline the capability was built with, carried from
  // the source task's context even when the caller passes none: a rebuild
  // started with a bare context was run by the v2 runner and then advanced by
  // the legacy branch, which asked for a second validation.
  assert.equal(rebuild.task.input.context.__pipelineVersion, discovery.task.input.context.__pipelineVersion);
  await assert.rejects(
    () =>
      createCapabilityMaintenanceTask(siteId, capabilityId, { mode: "Repair" }),
    (error) =>
      error.code === "capability_maintenance_in_progress" &&
      error.message === rebuild.task.id,
  );

  await claimTask(siteId, rebuild.task.id, "runner-rebuild");
  const rebuilt = await submitTaskResult(
    siteId,
    rebuild.task.id,
    "runner-rebuild",
    {
      outcome: "Success",
      candidateProgram: dynamicProgram,
      candidateSource: dynamicSource,
      demonstrationParameters: { query: "Echo" },
      validationCases: [{ query: "Arc" }, { query: "Echo" }],
    },
  );
  assert.equal(rebuilt.task.result.capabilityId, capabilityId);
  assert.equal((await listCapabilities(siteId)).capabilities.length, 1);
  assert.equal((await listVersions(siteId, capabilityId)).versions.length, 2);
  assert.equal(
    (await getCapability(siteId, capabilityId)).currentVersionId,
    publishedVersionId,
    "old version stays current until validation/review publishes the rebuild",
  );

  const repair = await createCapabilityMaintenanceTask(siteId, capabilityId, {
    mode: "Repair",
    guidance: "已确认页面结构变化",
  });
  assert.equal(repair.task.type, "Repair");
  assert.deepEqual(getTaskMaintenance(repair.task), {
    mode: "Repair",
    capabilityId,
  });
  assert.equal(repair.task.input.parameters.query, "Arc");
  assert.deepEqual(repair.task.input.context.initialLocalStorage, {
    cart: '["arc"]',
  });
});

test("Disabled capability blocks automatic discovery replacement", async () => {
  const discovery = await createCapabilityTask(siteId, {
    type: "Discovery",
    goal: "打开订单",
    input: {
      candidateSummary: { name: "打开订单", description: "订单入口", contract },
      program,
      parameters: {},
      context: {},
      interactions: [],
      trigger: {},
    },
  });
  await claimTask(siteId, discovery.task.id, "runner");
  const result = await submitTaskResult(siteId, discovery.task.id, "runner", {
    outcome: "Success",
    candidateProgram: program,
  });
  const capabilityId = result.task.result?.capabilityId;
  const versionId = result.task.result?.versionId;
  const validation = await createCapabilityTask(siteId, {
    type: "Validation",
    versionId,
    goal: "验证订单",
    input: { parameters: {}, context: {}, interactions: [], trigger: {} },
  });
  await claimTask(siteId, validation.task.id, "runner-v");
  await submitTaskResult(siteId, validation.task.id, "runner-v", {
    outcome: "Success",
  });
  await reviewVersion(siteId, versionId, { decision: "Approved" });
  await actOnCapability(siteId, capabilityId, "disable");
  // Disabling a capability says "do not use this one", not "never make one of
  // these again". It used to block the goal outright, and the only way to
  // generate it again was to delete the capability.
  const regenerated = await createCapabilityTask(siteId, {
    type: "Discovery",
    goal: "打开订单",
    input: {
      candidateSummary: { name: "打开订单", description: "订单入口" },
      parameters: {},
      context: {},
      interactions: [],
      trigger: {},
    },
  });
  assert.equal(regenerated.task.type, "Discovery");
});

test("WaitingInput response resumes without persisting plaintext", async () => {
  const task = await createCapabilityTask(siteId, {
    type: "Discovery",
    goal: "登录后打开订单",
    input: {
      parameters: {},
      context: {},
      trigger: {},
      candidateSummary: { name: "登录订单", description: "需要账号" },
      interactions: [
        {
          id: "login",
          status: "Requested",
          audience: "Administrator",
          message: "请输入测试账号",
          resumeMode: "Restart",
          fields: [
            {
              key: "username",
              label: "用户名",
              type: "text",
              required: true,
              sensitive: false,
            },
            {
              key: "password",
              label: "密码",
              type: "password",
              required: true,
              sensitive: true,
            },
          ],
        },
      ],
    },
  });
  assert.equal(task.task.status, "WaitingInput");
  const resumed = await respondTaskInteraction(siteId, task.task.id, "login", {
    username: "tester",
    password: "secret",
  });
  assert.equal(resumed.task.status, "Pending");
  const interaction = resumed.task.input.interactions[0];
  assert.equal(interaction.status, "Provided");
  assert.equal(interaction.response?.values.username, undefined);
  assert.equal(interaction.response?.values.password, undefined);
  assert.match(interaction.response?.encryptedPayload || "", /^aes256gcm:v1:/);
  const stored = await getTask(siteId, task.task.id);
  assert.equal(JSON.stringify(stored).includes("secret"), false);
});

test("WaitingInput Continue preserves the claimed runner and resumes Running", async () => {
  const created = await createCapabilityTask(siteId, {
    type: "Discovery",
    goal: "登录后继续",
    input: {
      parameters: {},
      context: { startUrl: "https://example.test" },
      trigger: {},
      candidateSummary: {
        name: "登录后继续",
        description: "测试同一 Runner 恢复",
      },
      interactions: [],
    },
  });
  await claimTask(siteId, created.task.id, "runner-continue");
  await registerRunner(siteId, {
    id: "runner-continue",
    taskId: created.task.id,
  });
  const waiting = await requestTaskInteraction(
    siteId,
    created.task.id,
    "runner-continue",
    {
      id: "runtime-otp",
      status: "Requested",
      audience: "Administrator",
      message: "请输入 OTP",
      resumeMode: "Continue",
      fields: [
        {
          key: "otp",
          label: "验证码",
          type: "otp",
          required: true,
          sensitive: true,
        },
      ],
    },
  );
  assert.equal(waiting.task.status, "WaitingInput");
  assert.equal(waiting.task.runnerId, "runner-continue");
  const resumed = await respondTaskInteraction(
    siteId,
    created.task.id,
    "runtime-otp",
    { otp: "932741" },
  );
  assert.equal(resumed.task.status, "Running");
  assert.equal(resumed.task.runnerId, "runner-continue");
  const runSpec = await getRunnerRunSpec(
    siteId,
    created.task.id,
    "runner-continue",
  );
  assert.equal(runSpec.resolvedSecrets.otp, "932741");
  assert.equal(
    JSON.stringify(await getTask(siteId, created.task.id)).includes("932741"),
    false,
  );
});

test("lost V2 Runner returns its task to Pending with visible diagnostics and retry discovery", async () => {
  resetCapabilityCenterV2ForTests();
  const siteId = "runner-recovery-site";
  const created = await createCapabilityTask(siteId, {
    type: "Discovery",
    goal: "搜索商品",
    input: { parameters: {}, context: {}, interactions: [], trigger: {} },
  });
  await claimTask(siteId, created.task.id, "runner-lost-visible");
  await registerRunner(siteId, {
    id: "runner-lost-visible",
    taskId: created.task.id,
  });
  await markRunnerLost(
    siteId,
    "runner-lost-visible",
    "runner_launch_failed:browser_missing",
  );

  const task = await getTask(siteId, created.task.id, true);
  assert.equal(task.status, "Pending");
  assert.equal(task.runnerId, undefined);
  assert.equal(task.error.code, "runner_launch_failed");
  assert.match(task.error.message, /browser_missing/);
  assert.deepEqual(await listPendingTaskSites(), [siteId]);
  const runners = await listRunners(siteId, { taskId: created.task.id });
  assert.equal(runners.runners.length, 1);
  assert.equal(runners.runners[0].status, "Lost");
  assert.equal(
    runners.runners[0].lastError,
    "runner_launch_failed:browser_missing",
  );
  const events = await listTaskEvents(siteId, created.task.id);
  assert.equal(events.at(-1).eventType, "RunnerLost");
  const reclaimed = await claimTask(
    siteId,
    created.task.id,
    "runner-recovered",
  );
  assert.equal(reclaimed.task.status, "Running");
  assert.equal(reclaimed.task.error, undefined);
});

test("Coordinator automatically creates Validation and records the verdict without any review model; the administrator can still override", async () => {
  const discovery = await createCapabilityTask(siteId, {
    type: "Discovery",
    goal: "搜索商品",
    input: {
      candidateSummary: { name: "搜索商品", description: "搜索商品", contract },
      program,
      parameters: {},
      context: { startUrl: "https://example.test" },
      interactions: [],
      trigger: {},
    },
  });
  await claimTask(siteId, discovery.task.id, "runner-discovery");
  const completed = await submitTaskResult(
    siteId,
    discovery.task.id,
    "runner-discovery",
    { outcome: "Success", candidateProgram: program },
  );
  const advanced = await advanceCompletedTask(completed.task);
  assert.equal(advanced.nextTask?.type, "Validation");
  assert.equal(advanced.nextTask?.status, "Pending");
  await claimTask(siteId, advanced.nextTask.id, "runner-validation");
  const validation = await submitTaskResult(
    siteId,
    advanced.nextTask.id,
    "runner-validation",
    { outcome: "Success", output: {} },
  );
  await advanceCompletedTask(validation.task);
  const version = (
    await listVersions(siteId, completed.task.result.capabilityId)
  ).versions[0];
  // A validation that recorded no case holds nothing up: the verdict is read
  // off the record, and an empty record is not a passed one.
  assert.equal(version.review.ai.status, "Rejected");
  assert.equal(version.review.ai.reason, REVIEW_NO_CASE_PASSED);
  assert.equal(version.review.ai.deterministic, true);
  assert.equal(version.review.ai.promptKey, undefined, "no prompt produced the verdict");
  await assert.rejects(
    () => publishVersion(siteId, version.id, { adminId: "admin" }),
    (error) => error.code === "admin_override_reason_required",
  );
  const published = await publishVersion(siteId, version.id, {
    adminId: "admin",
    reason: "人工核验通过",
  });
  assert.equal(published.version.status, "Published");
});

async function validatedVersion(goal, validationResults) {
  const discovery = await createCapabilityTask(siteId, {
    type: "Discovery",
    goal,
    input: {
      candidateSummary: { name: goal, description: goal, contract },
      program,
      parameters: {},
      context: { startUrl: "https://example.test" },
      interactions: [],
      trigger: {},
    },
  });
  await claimTask(siteId, discovery.task.id, "runner-discovery");
  const completed = await submitTaskResult(siteId, discovery.task.id, "runner-discovery", { outcome: "Success", candidateProgram: program });
  const advanced = await advanceCompletedTask(completed.task);
  await claimTask(siteId, advanced.nextTask.id, "runner-validation");
  const validation = await submitTaskResult(siteId, advanced.nextTask.id, "runner-validation", { outcome: "Success", output: {}, validationResults });
  const { review } = await advanceCompletedTask(validation.task);
  const version = (await listVersions(siteId, completed.task.result.capabilityId)).versions[0];
  return { review, version, validationTaskId: advanced.nextTask.id };
}

test("a validation whose cases passed is published on the verdict alone, with the verdict on the version", async () => {
  const { review, version } = await validatedVersion("搜索商品", [
    { caseId: "case_1", resolvedInput: { query: "notebook" }, output: { query: "notebook" } },
  ]);
  assert.equal(review.version.status, "Published");
  assert.equal(version.status, "Published");
  assert.equal(version.review.ai.status, "Approved");
  assert.equal(version.review.ai.reason, REVIEW_APPROVED_ON_VALIDATION);
  assert.equal(version.review.ai.deterministic, true);
});

test("a case that found nothing for a value the site offers rejects the version, and the event names the case", async () => {
  const failure = "no_result_for_offered_input:query=\"Mug\":the search page shows no results for Mug";
  const { version, validationTaskId } = await validatedVersion("搜索商品", [
    { caseId: "case_1", resolvedInput: { query: "notebook" }, output: { query: "notebook" } },
    { caseId: "case_2", resolvedInput: { query: "Mug" }, failureReason: failure },
  ]);
  assert.equal(version.status, "Draft");
  assert.equal(version.review.ai.status, "Rejected");
  assert.equal(version.review.ai.reason, REVIEW_OFFERED_INPUT_NO_RESULT);
  const events = await listTaskEvents(siteId, validationTaskId);
  const completed = events.find((event) => event.eventType === "ReviewCompleted");
  assert.equal(completed.payload.decision, "Rejected");
  assert.equal(completed.payload.caseId, "case_2");
  assert.equal(completed.payload.failure, failure);
  assert.equal(completed.payload.deterministic, true);
});

test("Runner receives decrypted interaction values only through its assigned RunSpec", async () => {
  const created = await createCapabilityTask(siteId, {
    type: "Discovery",
    goal: "登录",
    input: {
      candidateSummary: { name: "登录", description: "登录" },
      program,
      parameters: {},
      context: { startUrl: "https://example.test" },
      trigger: {},
      interactions: [
        {
          id: "login",
          status: "Requested",
          audience: "Administrator",
          message: "账号",
          resumeMode: "Restart",
          fields: [
            {
              key: "username",
              label: "用户名",
              type: "text",
              required: true,
              sensitive: false,
            },
            {
              key: "password",
              label: "密码",
              type: "password",
              required: true,
              sensitive: true,
            },
          ],
        },
      ],
    },
  });
  const resumed = await respondTaskInteraction(
    siteId,
    created.task.id,
    "login",
    { username: "tester", password: "secret" },
  );
  await claimTask(siteId, resumed.task.id, "runner-login");
  await registerRunner(siteId, { id: "runner-login", taskId: resumed.task.id });
  const spec = await getRunnerRunSpec(siteId, resumed.task.id, "runner-login");
  assert.equal(spec.input.parameters.username, "tester");
  assert.equal(spec.input.parameters.password, undefined);
  assert.equal(spec.resolvedSecrets.password, "secret");
  await assert.rejects(
    () => getRunnerRunSpec(siteId, resumed.task.id, "another-runner"),
    (error) => error.code === "runner_mismatch",
  );
  assert.equal(
    JSON.stringify(await getTask(siteId, resumed.task.id)).includes("secret"),
    false,
  );
});

test("Administrator can publish with an auditable override while AI review is still pending", async () => {
  const discovery = await createCapabilityTask(siteId, {
    type: "Discovery",
    goal: "查看库存",
    input: {
      candidateSummary: { name: "查看库存", description: "查看库存", contract },
      program,
      parameters: {},
      context: {},
      interactions: [],
      trigger: {},
    },
  });
  await claimTask(siteId, discovery.task.id, "runner");
  const completed = await submitTaskResult(
    siteId,
    discovery.task.id,
    "runner",
    { outcome: "Success", candidateProgram: program },
  );
  const validation = await createCapabilityTask(siteId, {
    type: "Validation",
    versionId: completed.task.versionId,
    goal: "查看库存",
    input: { parameters: {}, context: {}, interactions: [], trigger: {} },
  });
  await claimTask(siteId, validation.task.id, "runner-v");
  await submitTaskResult(siteId, validation.task.id, "runner-v", {
    outcome: "Success",
  });
  await beginVersionReview(siteId, completed.task.versionId, {
    promptKey: "review.prompt",
    promptVersion: "1.0.0",
    promptHash: "hash",
    model: "model",
  });
  const published = await publishVersion(siteId, completed.task.versionId, {
    adminId: "admin",
    reason: "管理员已独立核验并直接发布",
  });
  assert.equal(published.version.status, "Published");
  assert.equal(published.version.review.adminOverride.adminId, "admin");
  assert.equal(
    published.version.review.adminOverride.moduleHash,
    program.module.contentHash,
  );
});

test("Task archive is reversible and hidden from default listings", async () => {
  const pending = await createCapabilityTask(siteId, {
    type: "Discovery",
    goal: "归档测试",
    input: {
      candidateSummary: { name: "归档测试", description: "归档测试", contract },
      program,
      parameters: {},
      context: {},
      interactions: [],
      trigger: {},
    },
  });
  await assert.rejects(
    () => setTaskArchived(siteId, pending.task.id, true),
    (error) => error.code === "task_not_terminal",
  );

  await claimTask(siteId, pending.task.id, "runner-archive");
  const completed = await submitTaskResult(
    siteId,
    pending.task.id,
    "runner-archive",
    { outcome: "Success", candidateProgram: program },
  );
  const archived = await setTaskArchived(siteId, completed.task.id, true);
  assert.ok(archived.task.archivedAt);
  assert.equal(
    (await listTasks(siteId)).tasks.some(
      (task) => task.id === completed.task.id,
    ),
    false,
  );
  assert.equal(
    (await listTasks(siteId, { includeArchived: true })).tasks.some(
      (task) => task.id === completed.task.id,
    ),
    true,
  );

  const restored = await setTaskArchived(siteId, completed.task.id, false);
  assert.equal(restored.task.archivedAt, undefined);
  assert.equal(
    (await listTasks(siteId)).tasks.some(
      (task) => task.id === completed.task.id,
    ),
    true,
  );
});

test("module boundary B -> C -> D commits a candidate, validates it and publishes without Draft", async () => {
  const input = {
    request: {
      goal: "搜索商品",
      parameters: { query: "马克杯" },
      entryUrl: "https://example.test/search",
      locale: "zh-CN",
    },
    source: "Admin",
    instruction: { operation: "create" },
  };
  const classified = await classifyCapabilityGeneration(siteId, input);
  assert.equal(classified.disposition, "Created");
  if (classified.disposition !== "Created") return;
  assert.equal(classified.task.type, "Discovery");
  assert.equal(classified.task.status, "Pending");
  assert.equal("mode" in classified.task.runSpec.browser, false);
  assert.equal(classified.task.runSpec.input.parameters.query, "马克杯");

  await claimTask(siteId, classified.task.id, "boundary-discovery");
  const boundarySource = `export const capability={version:2,stages:[{id:"complete",async run({input}){const query=String(input.query??"").trim();return {outcome:"Success",state:{targets:{query}},output:{query}}}}]};`;
  const boundaryProgram = await makeProgram(boundarySource, {
    stages: [
      {
        id: "complete",
        title: "Complete search",
        purpose: "Resolve the requested search query",
        effect: "read",
        resumePolicy: "skip-completed",
        io: {
          reads: { input: ["query"], state: [] },
          writes: { state: ["targets.query"], output: ["query"] },
        },
        navigation: "none",
      },
    ],
    parameterRoles: [{ inputPath: "query", role: "target" }],
    targetBindings: [
      {
        inputPath: "query",
        targetKind: "search-query",
        identityStatePath: "targets.query",
        required: true,
      },
    ],
  });
  const candidateContract = {
    intent: "按用户关键词搜索商品",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    preconditions: [],
    successConditions: [
      { type: "outputExists", path: "query" },
      { type: "textTemplate", template: "{{query}}" },
    ],
  };
  const candidate = {
    name: "搜索商品",
    description: "按用户提供的关键词搜索商品",
    aliases: ["查找商品"],
    contract: candidateContract,
    program: boundaryProgram,
  };
  const formalOutputs = await formalGenerationOutputs(
    classified.task.id,
    candidate,
    [{ query: "马克杯" }, { query: "棕色垫子" }],
    (input) => ({ query: input.query }),
  );
  const completed = await submitTaskResult(
    siteId,
    classified.task.id,
    "boundary-discovery",
    {
      outcome: "Success",
      candidateProgram: boundaryProgram,
      candidateSource: boundarySource,
      candidateSummary: {
        name: "搜索商品",
        description: "按用户提供的关键词搜索商品",
        aliases: ["查找商品"],
        contract: candidateContract,
      },
      demonstrationParameters: { query: "马克杯" },
      ...formalOutputs,
      output: { query: "马克杯" },
    },
  );
  assert.equal(
    completed.task.status,
    "Succeeded",
    JSON.stringify(completed.task.error),
  );
  assert.ok(completed.task.result?.candidateArtifact);
  assert.ok(completed.task.result?.validationTaskId);
  assert.equal(
    (await listCapabilities(siteId)).capabilities.length,
    0,
    "C must not materialize a Capability",
  );
  assert.equal((await listVersions(siteId, "not-created")).versions.length, 0);

  const validationTaskId = completed.task.result.validationTaskId;
  assert.ok(validationTaskId);
  const validationTask = await getTask(siteId, validationTaskId, true);
  assert.equal(validationTask?.type, "Validation");
  assert.equal(
    validationTask?.runSpec?.candidateValidation?.browser.isolation,
    "FreshContextPerCase",
  );
  assert.throws(
    () =>
      createValidatedCapabilityPackage(
        completed.task.result.candidateArtifact,
        validationTaskId,
        { outcome: "Success" },
      ),
    /validation_results_required/,
  );
  // A prediction the replay did not reproduce is drift, not a refusal: it is
  // recorded on the case and the review turn reads it.
  {
    const drifted = createValidatedCapabilityPackage(
      completed.task.result.candidateArtifact,
      validationTaskId,
      {
        outcome: "Success",
        validationResults: [
          {
            caseId: "case_1",
            resolvedInput: { query: "马克杯" },
            output: { query: "错误值" },
            stageReceipts: [
              { stageId: "complete", outcome: "Success", evidenceRefs: ["evidence://case_1"] },
            ],
            evidenceRefs: ["evidence://case_1"],
          },
          {
            caseId: "case_2",
            resolvedInput: { query: "棕色垫子" },
            output: { query: "棕色垫子" },
            stageReceipts: [
              { stageId: "complete", outcome: "Success", evidenceRefs: ["evidence://case_2"] },
            ],
            evidenceRefs: ["evidence://case_2"],
          },
        ],
      },
    );
    assert.deepEqual(drifted.validation.cases.map((item) => item.outcome), ["Passed", "Passed"]);
    assert.deepEqual(drifted.validation.cases[0].outputDrift.map((item) => item.key), ["query"]);
  }
  // One case is one input, not the capability. A case the replay could not
  // complete is recorded beside the one that worked — it carries no success
  // receipt and no evidence, because there was nothing to evidence — and the
  // package is accepted so the review turn can read them together.
  {
    const mixed = createValidatedCapabilityPackage(
      completed.task.result.candidateArtifact,
      validationTaskId,
      {
        outcome: "Success",
        validationResults: [
          {
            caseId: "case_1",
            resolvedInput: { query: "马克杯" },
            output: { query: "马克杯" },
            stageReceipts: [
              { stageId: "complete", outcome: "Success", evidenceRefs: ["evidence://case_1"] },
            ],
            evidenceRefs: ["evidence://case_1"],
          },
          {
            caseId: "case_2",
            resolvedInput: { query: "棕色垫子" },
            output: {},
            stageReceipts: [],
            evidenceRefs: [],
            failureReason: "success_text_missing:棕色垫子",
          },
        ],
      },
    );
    assert.deepEqual(mixed.validation.cases.map((item) => item.outcome), ["Passed", "Failed"]);
    assert.equal(mixed.validation.cases[1].failureReason, "success_text_missing:棕色垫子");
  }
  assert.throws(
    () =>
      createValidatedCapabilityPackage(
        completed.task.result.candidateArtifact,
        validationTaskId,
        {
          outcome: "Success",
          validationResults: [
            {
              caseId: "case_1",
              resolvedInput: { query: "马克杯" },
              output: { query: "马克杯" },
              stageReceipts: [],
              evidenceRefs: [],
            },
            {
              caseId: "case_2",
              resolvedInput: { query: "棕色垫子" },
              output: { query: "棕色垫子" },
              stageReceipts: [],
              evidenceRefs: [],
            },
          ],
        },
      ),
    /validation_stage_receipts_invalid/,
  );
  assert.throws(
    () =>
      createValidatedCapabilityPackage(
        completed.task.result.candidateArtifact,
        validationTaskId,
        {
          outcome: "Success",
          validationResults: [
            {
              caseId: "case_1",
              resolvedInput: { query: "马克杯" },
              output: { query: "马克杯" },
              stageReceipts: [
                {
                  stageId: "complete",
                  outcome: "Success",
                  evidenceRefs: ["evidence://unbound"],
                },
              ],
              evidenceRefs: ["evidence://case_1"],
            },
            {
              caseId: "case_2",
              resolvedInput: { query: "棕色垫子" },
              output: { query: "棕色垫子" },
              stageReceipts: [
                {
                  stageId: "complete",
                  outcome: "Success",
                  evidenceRefs: ["evidence://case_2"],
                },
              ],
              evidenceRefs: ["evidence://case_2"],
            },
          ],
        },
      ),
    /validation_receipt_evidence_mismatch/,
  );
  await claimTask(siteId, validationTaskId, "boundary-validation");
  const validated = await submitTaskResult(
    siteId,
    validationTaskId,
    "boundary-validation",
    {
      outcome: "Success",
      validationResults: [
        {
          caseId: "case_1",
          resolvedInput: { query: "马克杯" },
          output: { query: "马克杯" },
          stageReceipts: [
            {
              stageId: "complete",
              outcome: "Success",
              evidenceRefs: ["evidence://case_1"],
            },
          ],
          evidenceRefs: ["evidence://case_1"],
        },
        {
          caseId: "case_2",
          resolvedInput: { query: "棕色垫子" },
          output: { query: "棕色垫子" },
          stageReceipts: [
            {
              stageId: "complete",
              outcome: "Success",
              evidenceRefs: ["evidence://case_2"],
            },
          ],
          evidenceRefs: ["evidence://case_2"],
        },
      ],
    },
  );
  assert.equal(validated.task.status, "Succeeded");
  assert.equal(validated.task.result?.buildResult?.outcome, "Validated");
  if (validated.task.result?.buildResult?.outcome !== "Validated") return;

  const tamperedPackage = structuredClone(
    validated.task.result.buildResult.package,
  );
  tamperedPackage.artifact.candidate.name = "篡改后的候选";
  const rejectedPublish = await publishValidatedCapability(siteId, {
    generationTaskId: classified.task.id,
    validated: tamperedPackage,
    authorization: {
      mode: "AdminOverride",
      adminId: "boundary-test",
      reason: "篡改包必须被拒绝",
    },
  });
  assert.equal(rejectedPublish.outcome, "WriteConflict");

  const publishInput = {
    generationTaskId: classified.task.id,
    validated: validated.task.result.buildResult.package,
    authorization: {
      mode: "AdminOverride",
      adminId: "boundary-test",
      reason: "确定性验证样例全部通过",
    },
  };
  const [published, concurrentPublish] = await Promise.all([
    publishValidatedCapability(siteId, publishInput),
    publishValidatedCapability(siteId, publishInput),
  ]);
  assert.equal(published.outcome, "Published");
  assert.equal(concurrentPublish.outcome, "Published");
  if (published.outcome !== "Published") return;
  if (concurrentPublish.outcome !== "Published") return;
  assert.equal(concurrentPublish.capability.id, published.capability.id);
  assert.equal(concurrentPublish.version.id, published.version.id);
  assert.equal(published.version.status, "Published");
  assert.equal((await listCapabilities(siteId)).capabilities.length, 1);
  assert.equal(
    (await listVersions(siteId, published.capability.id)).versions
      .map((item) => item.status)
      .join(","),
    "Published",
  );
  const replay = await publishValidatedCapability(siteId, {
    generationTaskId: classified.task.id,
    validated: validated.task.result.buildResult.package,
    authorization: {
      mode: "AdminOverride",
      adminId: "boundary-test",
      reason: "幂等重放",
    },
  });
  assert.equal(replay.outcome, "Published");
  assert.equal(
    (await listVersions(siteId, published.capability.id)).versions.length,
    1,
    "D publish is idempotent",
  );
});

/** Runs one generation through C1/C2 and C3 as the boundary test does, returning what D needs. */
async function generationReadyForPublish(task, runnerId, candidateName, validationResults = passingValidationResults) {
  await claimTask(siteId, task.id, runnerId);
  const source = `export const capability={version:2,stages:[{id:"complete",async run({input}){const query=String(input.query??"").trim();return {outcome:"Success",state:{targets:{query}},output:{query}}}}]};`;
  const program = await makeProgram(source, {
    stages: [{ id: "complete", title: "Complete search", purpose: "Resolve the requested search query", effect: "read", resumePolicy: "skip-completed", io: { reads: { input: ["query"], state: [] }, writes: { state: ["targets.query"], output: ["query"] } }, navigation: "none" }],
    parameterRoles: [{ inputPath: "query", role: "target" }],
    targetBindings: [{ inputPath: "query", targetKind: "search-query", identityStatePath: "targets.query", required: true }],
  });
  const contract = {
    intent: "按用户关键词搜索商品",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    outputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    preconditions: [],
    successConditions: [{ type: "outputExists", path: "query" }, { type: "textTemplate", template: "{{query}}" }],
  };
  const candidate = { name: candidateName, description: "按关键词搜索", aliases: [], contract, program };
  const formalOutputs = await formalGenerationOutputs(task.id, candidate, [{ query: "马克杯" }, { query: "棕色垫子" }], (input) => ({ query: input.query }));
  const completed = await submitTaskResult(siteId, task.id, runnerId, {
    outcome: "Success",
    candidateProgram: program,
    candidateSource: source,
    candidateSummary: { name: candidateName, description: "按关键词搜索", aliases: [], contract },
    demonstrationParameters: { query: "马克杯" },
    ...formalOutputs,
    output: { query: "马克杯" },
  });
  assert.equal(completed.task.status, "Succeeded", JSON.stringify(completed.task.error));
  const validationTaskId = completed.task.result.validationTaskId;
  await claimTask(siteId, validationTaskId, `${runnerId}-validation`);
  const validated = await submitTaskResult(siteId, validationTaskId, `${runnerId}-validation`, {
    outcome: "Success",
    validationResults,
  });
  assert.equal(validated.task.result?.buildResult?.outcome, "Validated");
  return { validated: validated.task.result.buildResult.package, validationTaskId };
}

const passingValidationResults = [
  { caseId: "case_1", resolvedInput: { query: "马克杯" }, output: { query: "马克杯" }, stageReceipts: [{ stageId: "complete", outcome: "Success", evidenceRefs: ["evidence://case_1"] }], evidenceRefs: ["evidence://case_1"] },
  { caseId: "case_2", resolvedInput: { query: "棕色垫子" }, output: { query: "棕色垫子" }, stageReceipts: [{ stageId: "complete", outcome: "Success", evidenceRefs: ["evidence://case_2"] }], evidenceRefs: ["evidence://case_2"] },
];
// The second case is a value the page lists beside the demonstrated one, and the program found nothing for it.
const OFFERED_VALUE_FAILURE = "no_result_for_offered_input:query=\"棕色垫子\":the search page lists nothing for it";
const offeredValueRejectedResults = [
  passingValidationResults[0],
  { caseId: "case_2", resolvedInput: { query: "棕色垫子" }, output: {}, failureReason: OFFERED_VALUE_FAILURE, stageReceipts: [], evidenceRefs: [] },
];

async function generationFor(name) {
  const classified = await classifyCapabilityGeneration(siteId, {
    request: { goal: name, parameters: { query: "马克杯" }, entryUrl: "https://example.test/search", locale: "zh-CN" },
    source: "Admin",
    instruction: { operation: "create" },
  });
  assert.equal(classified.disposition, "Created");
  // The classification returns a projection; the stored task carries the goal and guidance a rerun copies.
  return getTask(siteId, classified.task.id, true);
}

test("a rejection the verdict names a case for is followed by one repair that starts from that case", async () => {
  const name = "分类计数能力";
  const generation = await generationFor(name);
  const first = await generationReadyForPublish(generation, "repair-first", name, offeredValueRejectedResults);
  const validation = await getTask(siteId, first.validationTaskId, true);
  const advanced = await advanceCompletedTask(validation);
  assert.equal(advanced.review.outcome, "Rejected");
  assert.equal(advanced.review.reason, REVIEW_OFFERED_INPUT_NO_RESULT);
  assert.equal(advanced.review.caseId, "case_2");
  const repair = advanced.nextTask;
  assert.ok(repair, "the rejection schedules a repair");
  assert.equal(repair.type, "Discovery");
  assert.equal(repair.status, "Pending");
  assert.equal(repair.rerunOfTaskId, generation.id);
  assert.equal(repair.goal, generation.goal);
  assert.equal(repair.guidance, generation.guidance, "the same guidance, so the prior source is restored as the first draft");
  assert.deepEqual(repair.input.parameters, generation.input.parameters);
  assert.equal(repair.input.context.__autoRepairOfTaskId, generation.id);
  assert.deepEqual(repair.input.context.repair, { reason: REVIEW_OFFERED_INPUT_NO_RESULT, caseId: "case_2", failure: OFFERED_VALUE_FAILURE, input: { query: "棕色垫子" } });
  const events = await listTaskEvents(siteId, first.validationTaskId);
  const scheduled = events.find((event) => event.eventType === "RepairScheduled");
  assert.equal(scheduled.payload.repairTaskId, repair.id);
  const status = projectProductionStatus(await getTask(siteId, first.validationTaskId, true), events);
  assert.equal(status.state, "Running");
  assert.equal(status.messageKey, "repairScheduled");
  assert.equal(status.nextTaskId, repair.id, "the record runs on, into the repair");
  // The repair's candidate passes on both values and is published; the chain holds one repair.
  const second = await generationReadyForPublish(repair, "repair-second", name);
  const published = await advanceCompletedTask(await getTask(siteId, second.validationTaskId, true));
  assert.equal(published.review.outcome, "Published");
  assert.equal(published.nextTask, undefined);
  // The marker travels into the repair's own validation task with the rest of its context; the authoring tasks are what is counted.
  const repairs = (await listTasks(siteId, { includeDeleted: true, includeArchived: true })).tasks.filter((task) => task.type !== "Validation" && task.input.context.__autoRepairOfTaskId === generation.id);
  assert.equal(repairs.length, 1);
});

test("a repair rejected again is not repaired a second time; the second rejection stands", async () => {
  const name = "分类计数能力二";
  const generation = await generationFor(name);
  const first = await generationReadyForPublish(generation, "again-first", name, offeredValueRejectedResults);
  const repair = (await advanceCompletedTask(await getTask(siteId, first.validationTaskId, true))).nextTask;
  assert.ok(repair);
  const before = (await listTasks(siteId, { includeDeleted: true, includeArchived: true })).tasks.length;
  const second = await generationReadyForPublish(repair, "again-second", name, offeredValueRejectedResults);
  const validation = await getTask(siteId, second.validationTaskId, true);
  const advanced = await advanceCompletedTask(validation);
  assert.equal(advanced.review.outcome, "Rejected");
  assert.equal(advanced.nextTask, undefined);
  const after = (await listTasks(siteId, { includeDeleted: true, includeArchived: true })).tasks.length;
  assert.equal(after - before, 1, "only the repair's own validation task was added; no third authoring");
  const status = projectProductionStatus(validation, await listTaskEvents(siteId, second.validationTaskId));
  assert.equal(status.state, "Rejected");
  assert.equal(status.detail, REVIEW_OFFERED_INPUT_NO_RESULT, "the second rejection is the reason shown");
});

test("a second generation of an already published capability ends as AlreadyPublished, never as a failed publish", async () => {
  const name = "同名竞速能力";
  const classified = await classifyCapabilityGeneration(siteId, {
    request: { goal: name, parameters: { query: "马克杯" }, entryUrl: "https://example.test/search", locale: "zh-CN" },
    source: "Admin",
    instruction: { operation: "create" },
  });
  assert.equal(classified.disposition, "Created");
  if (classified.disposition !== "Created") return;
  const first = await generationReadyForPublish(classified.task, "race-first", name);
  // The user retried the build while the first one was still in flight: a
  // rerun skips B, and with nothing published yet nothing stops a second
  // generation of the same name. (Once a capability of that name is live, the
  // task creation itself refuses — capability_duplicate — so the race window
  // is exactly the time between the two publications.)
  const original = await getTask(siteId, classified.task.id, true);
  const rerun = await createCapabilityTask(siteId, { type: "Discovery", goal: original.goal, guidance: original.guidance, input: original.input, rerunOfTaskId: original.id });
  const authorization = { mode: "AdminOverride", adminId: "race-test", reason: "确定性验证样例全部通过" };
  const published = await publishValidatedCapability(siteId, { generationTaskId: classified.task.id, validated: first.validated, authorization });
  assert.equal(published.outcome, "Published");
  if (published.outcome !== "Published") return;
  const second = await generationReadyForPublish(rerun.task, "race-second", name);
  // The coordinator yields before the review: no model call (none is
  // configured here — reaching it would return "AI review model is not
  // configured"), no ReviewStarted, one PublicationSuperseded on the task.
  const secondValidation = await getTask(siteId, second.validationTaskId, true);
  const yielded = await reviewValidatedCandidate(siteId, secondValidation, second.validated);
  assert.equal(yielded.outcome, "AlreadyPublished", JSON.stringify(yielded));
  if (yielded.outcome !== "AlreadyPublished") return;
  const events = (await listTaskEvents(siteId, second.validationTaskId)).map((event) => event.eventType);
  assert.ok(!events.includes("ReviewStarted"), events.join(","));
  assert.ok(events.includes("PublicationSuperseded"), events.join(","));
  const superseded = (await listTaskEvents(siteId, second.validationTaskId)).find((event) => event.eventType === "PublicationSuperseded");
  assert.equal(superseded.payload.capabilityId, published.capability.id);
  // The event names the outcome and carries the capability that got there
  // first; the console words it in the reader's language.
  assert.equal(String(superseded.payload.message), "publication superseded");
  assert.equal(superseded.payload.capabilityName, published.capability.name);
  // D itself answers the same way if called directly.
  const direct = await publishValidatedCapability(siteId, { generationTaskId: rerun.task.id, validated: second.validated, authorization });
  assert.equal(direct.outcome, "AlreadyPublished");
  assert.equal(yielded.capability.id, published.capability.id, "it points at the capability that got there first");
  assert.equal(yielded.version.id, published.version.id);
  assert.match(yielded.reason, /already published by another generation/);
  assert.equal((await listCapabilities(siteId)).capabilities.filter((item) => item.name === name).length, 1, "no second capability, no second version");
  assert.equal((await listVersions(siteId, published.capability.id)).versions.length, 1);

  // Every later look at the second generation resolves the same way without another review.
  assert.equal((await getCapabilityClassificationReservation(siteId, rerun.task.id))?.status, "Superseded");
  const again = await getGenerationPublication(siteId, rerun.task.id);
  assert.equal(again?.outcome, "AlreadyPublished");
  assert.equal(again?.capability.id, published.capability.id);
  const replay = await publishValidatedCapability(siteId, { generationTaskId: rerun.task.id, validated: second.validated, authorization });
  assert.equal(replay.outcome, "AlreadyPublished");
  // The first generation is untouched.
  assert.equal((await getGenerationPublication(siteId, classified.task.id))?.outcome, "Published");
});

test("C2 commit creates the Artifact/C3 handoff and is idempotent without a Freeze task", async () => {
  const classified = await classifyCapabilityGeneration(siteId, {
    request: {
      goal: "C2 提交搜索候选",
      parameters: { query: "马克杯" },
      entryUrl: "https://example.test/search",
    },
    source: "Admin",
    instruction: { operation: "create" },
  });
  assert.equal(classified.disposition, "Created");
  if (classified.disposition !== "Created") return;
  await claimTask(siteId, classified.task.id, "c2-commit-runner");
  const candidateContract = {
    intent: "按关键词搜索商品",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      additionalProperties: false,
    },
    preconditions: [],
    successConditions: [
      { type: "outputExists", path: "query" },
      { type: "textTemplate", template: "{{query}}" },
    ],
  };
  const candidateProgram = await makeProgram(
    `export const capability={version:2,stages:[{id:"complete",async run({input}){return {outcome:"Success",output:{query:String(input.query??"")}}}}]};`,
    {
      stages: [{
        id: "complete",
        title: "Complete search",
        purpose: "Read the requested query",
        effect: "read",
        resumePolicy: "skip-completed",
        io: {
          reads: { input: ["query"], state: [] },
          writes: { state: [], output: ["query"] },
        },
        navigation: "none",
      }],
      parameterRoles: [{ inputPath: "query", role: "target" }],
      targetBindings: [{
        inputPath: "query",
        targetKind: "search-query",
        identityStatePath: "targets.query",
        required: true,
      }],
    },
  );
  const candidate = {
    name: "C2 搜索候选",
    description: "按关键词搜索商品",
    aliases: [],
    contract: candidateContract,
    program: candidateProgram,
  };
  const formalOutputs = await formalGenerationOutputs(
    classified.task.id,
    candidate,
    [{ query: "马克杯" }, { query: "棕色垫子" }],
    (input) => ({ query: input.query }),
  );
  const runningTask = await getTask(siteId, classified.task.id, true);
  assert.equal(runningTask?.status, "Running");
  const first = await completeC2CaseGeneration(
    siteId,
    runningTask,
    formalOutputs.c2CaseGenerationOutput,
  );
  assert.ok(first.artifact.candidateId);
  assert.equal(first.validationTask.type, "Validation");
  assert.equal(first.validationTask.input.context.__candidateValidation, true);
  const second = await completeC2CaseGeneration(
    siteId,
    runningTask,
    formalOutputs.c2CaseGenerationOutput,
  );
  assert.equal(second.artifact.candidateId, first.artifact.candidateId);
  assert.equal(second.validationTask.id, first.validationTask.id);
  assert.equal(
    (await listTasks(siteId, { type: "Validation", includeDeleted: true, includeArchived: true })).tasks.length,
    1,
  );

  const conflicting = structuredClone(formalOutputs.c2CaseGenerationOutput);
  conflicting.validationSuite.cases[0].expected = { query: "篡改" };
  conflicting.validationSuiteHash = capabilityValidationSuiteHash(conflicting.validationSuite);
  await assert.rejects(
    () => completeC2CaseGeneration(siteId, runningTask, conflicting),
    /candidate_freeze_conflict/,
  );
  assert.equal(await getTask(siteId, first.validationTask.id, true) !== undefined, true);
});

test("C2 commit judges leakage by the demonstration values, not by the first generated case", async () => {
  const classified = await classifyCapabilityGeneration(siteId, {
    request: {
      goal: "C2 泄漏门禁按演示值判断",
      parameters: { query: "马克杯" },
      entryUrl: "https://example.test/search",
    },
    source: "Admin",
    instruction: { operation: "create" },
  });
  assert.equal(classified.disposition, "Created");
  if (classified.disposition !== "Created") return;
  await claimTask(siteId, classified.task.id, "c2-leak-runner");
  const candidateContract = {
    intent: "按关键词搜索商品",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      additionalProperties: false,
    },
    preconditions: [],
    successConditions: [
      { type: "outputExists", path: "query" },
      { type: "textTemplate", template: "{{query}}" },
    ],
  };
  const programShape = {
    stages: [{
      id: "complete",
      title: "Complete search",
      purpose: "Read the requested query",
      effect: "read",
      resumePolicy: "skip-completed",
      io: {
        reads: { input: ["query"], state: [] },
        writes: { state: [], output: ["query"] },
      },
      navigation: "none",
    }],
    parameterRoles: [{ inputPath: "query", role: "target" }],
    targetBindings: [{
      inputPath: "query",
      targetKind: "search-query",
      identityStatePath: "targets.query",
      required: true,
    }],
  };
  const candidate = {
    name: "搜索商品",
    description: "按关键词搜索商品",
    aliases: [],
    contract: candidateContract,
    program: await makeProgram(
      `export const capability={version:2,stages:[{id:"complete",async run({input}){return {outcome:"Success",output:{query:String(input.query??"")}}}}]};`,
      programShape,
    ),
  };
  // The case model picked the site word "商品" as its first test keyword; it
  // appears in the candidate name, which is not a leaked demonstration value.
  const outputs = await formalGenerationOutputs(
    classified.task.id,
    candidate,
    [{ query: "商品" }, { query: "棕色垫子" }],
    (input) => ({ query: input.query }),
  );
  const runningTask = await getTask(siteId, classified.task.id, true);
  const committed = await completeC2CaseGeneration(siteId, runningTask, outputs.c2CaseGenerationOutput);
  assert.ok(committed.artifact.candidateId, "site vocabulary in a generated case must not fail the leak gate");

  // The demonstration value itself baked into the source is still rejected.
  const leaking = await classifyCapabilityGeneration(siteId, {
    request: {
      goal: "C2 泄漏门禁仍拦截演示值",
      parameters: { query: "马克杯" },
      entryUrl: "https://example.test/search",
    },
    source: "Admin",
    instruction: { operation: "create" },
  });
  assert.equal(leaking.disposition, "Created");
  if (leaking.disposition !== "Created") return;
  await claimTask(siteId, leaking.task.id, "c2-leak-runner");
  const leakingCandidate = {
    ...candidate,
    program: await makeProgram(
      `export const capability={version:2,stages:[{id:"complete",async run({input}){void input;return {outcome:"Success",output:{query:"马克杯"}}}}]};`,
      programShape,
    ),
  };
  const leakingOutputs = await formalGenerationOutputs(
    leaking.task.id,
    leakingCandidate,
    [{ query: "商品" }, { query: "棕色垫子" }],
    (input) => ({ query: input.query }),
  );
  const leakingTask = await getTask(siteId, leaking.task.id, true);
  await assert.rejects(
    completeC2CaseGeneration(siteId, leakingTask, leakingOutputs.c2CaseGenerationOutput),
    /demonstration_value_leaked/,
  );
});

test("CaseGeneration failure creates neither CandidateArtifact nor C3 task", async () => {
  const classified = await classifyCapabilityGeneration(siteId, {
    request: {
      goal: "搜索失败样例",
      parameters: { query: "马克杯" },
      entryUrl: "https://example.test/search",
    },
    source: "Admin",
    instruction: { operation: "create" },
  });
  assert.equal(classified.disposition, "Created");
  if (classified.disposition !== "Created") return;
  await claimTask(siteId, classified.task.id, "case-generation-failure");
  const failed = await submitTaskResult(
    siteId,
    classified.task.id,
    "case-generation-failure",
    {
      outcome: "BusinessRejection",
      buildResult: {
        outcome: "Failed",
        stage: "CaseGeneration",
        code: "case_generation_independent_cases_required",
        reason: "C2 did not produce independent cases",
        evidenceRefs: [],
      },
    },
  );
  assert.equal(failed.task.status, "Failed");
  assert.equal(failed.task.result?.buildResult?.stage, "CaseGeneration");
  // The terminal write attributes the failure: class from its code, stage from its result.
  assert.equal(failed.task.error?.failureClass, "bad-test-data");
  assert.equal(failed.task.error?.failureStage, "CaseGeneration");
  assert.equal(failed.task.result?.candidateArtifact, undefined);
  assert.equal(failed.task.result?.validationTaskId, undefined);
  assert.equal(
    (
      await listTasks(siteId, {
        type: "Validation",
        includeDeleted: true,
        includeArchived: true,
      })
    ).tasks.some((task) => task.rerunOfTaskId === classified.task.id),
    false,
  );
});

test("formal V2 success cannot downgrade to legacy validationCases when C2 output is missing", async () => {
  const classified = await classifyCapabilityGeneration(siteId, {
    request: {
      goal: "缺少 C2 的正式任务",
      parameters: {},
      entryUrl: "https://example.test",
    },
    source: "Admin",
    instruction: { operation: "create" },
  });
  assert.equal(classified.disposition, "Created");
  if (classified.disposition !== "Created") return;
  await claimTask(siteId, classified.task.id, "missing-c2-discovery");
  const candidate = {
    name: "缺少 C2",
    description: "不允许降级",
    aliases: [],
    contract,
    program,
  };
  const { c1AuthoringOutput } = await formalGenerationOutputs(
    classified.task.id,
    candidate,
    [{}, {}],
  );
  const completed = await submitTaskResult(
    siteId,
    classified.task.id,
    "missing-c2-discovery",
    {
      outcome: "Success",
      candidateProgram: program,
      candidateSummary: {
        name: candidate.name,
        description: candidate.description,
        aliases: candidate.aliases,
        contract,
      },
      c1AuthoringOutput,
      validationCases: [{}, {}],
      output: {},
    },
  );
  assert.equal(completed.task.status, "Failed");
  assert.equal(completed.task.result?.buildResult?.outcome, "Failed");
  assert.equal(completed.task.result?.buildResult?.stage, "CaseGeneration");
  assert.equal(completed.task.result?.candidateArtifact, undefined);
  assert.equal(completed.task.result?.validationTaskId, undefined);
});

test("formal V2 rejects and does not persist private fields attached to C1 output", async () => {
  const classified = await classifyCapabilityGeneration(siteId, {
    request: {
      goal: "拒绝 C1 私有字段",
      parameters: {},
      entryUrl: "https://example.test",
    },
    source: "Admin",
    instruction: { operation: "create" },
  });
  assert.equal(classified.disposition, "Created");
  if (classified.disposition !== "Created") return;
  await claimTask(siteId, classified.task.id, "c1-private-field-discovery");
  const candidate = {
    name: "拒绝私有字段",
    description: "严格 C1 边界",
    aliases: [],
    contract,
    program,
  };
  const outputs = await formalGenerationOutputs(classified.task.id, candidate, [
    {},
    {},
  ]);
  outputs.c1AuthoringOutput.caseContextRef = {
    artifactRef: "artifact://forbidden",
    contentHash: `sha256:${"0".repeat(64)}`,
  };
  outputs.c1AuthoringOutput.groundingExamples = [
    { input: { query: "forbidden" } },
  ];
  const completed = await submitTaskResult(
    siteId,
    classified.task.id,
    "c1-private-field-discovery",
    {
      outcome: "Success",
      candidateProgram: program,
      candidateSource: programSource,
      candidateSummary: candidate,
      ...outputs,
      output: {},
    },
  );
  assert.equal(completed.task.status, "Failed");
  assert.equal(completed.task.result?.buildResult?.stage, "Authoring");
  assert.equal(completed.task.result?.c1AuthoringOutput, undefined);
  assert.equal(completed.task.result?.c2CaseGenerationOutput, undefined);
});

test("replacement plan is carried by B and disables only after D publishes", async () => {
  // Classification asks the semantic model whether this request duplicates an
  // existing capability, and "搜索商品" overlaps "搜索手机" enough to reach it.
  // A loopback provider answers that one question — a replacement is not a
  // duplicate — so the test exercises the real prompt contract without needing
  // a configured provider. Env is restored before the test returns.
  const modelNames = ["MODEL_API_KEY", "MODEL_BASE_URL", "MODEL", "MODEL_SEMANTIC", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"];
  const savedModelEnv = Object.fromEntries(modelNames.map((name) => [name, process.env[name]]));
  const duplicateChecks = [];
  const modelServer = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    duplicateChecks.push(parsed.response_format?.json_schema?.name);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify({ capabilityId: null, reason: "替换计划不是重复能力" }) },
      }],
    }));
  });
  await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  for (const name of modelNames) delete process.env[name];
  Object.assign(process.env, {
    MODEL_API_KEY: "fixture-only",
    MODEL_BASE_URL: `http://127.0.0.1:${modelServer.address().port}/v1`,
    MODEL: "fixture-only",
  });
  try {
  const old = (
    await createCapability(siteId, {
      name: "搜索手机",
      description: "只支持手机搜索",
      aliases: ["找手机"],
      contract,
    })
  ).capability;
  const semantic = {
    schemaVersion: "1.0",
    goal: "搜索商品",
    effect: "read",
    parameters: [
      { path: "query", role: "target", userSupplied: true, example: "手机" },
    ],
    dependencies: [],
    scopeDecision: {
      status: "Generalized",
      scope: {
        kind: "site-global",
        binding: "user-input",
        generalizable: true,
      },
      rationale: "统一商品搜索覆盖原窄能力",
      assumptions: [],
      unresolvedDependencies: [],
    },
    entryPolicy: {
      kind: "site-global",
      requiredInputPaths: ["query"],
      scopeTokens: [],
      mismatch: "no-match",
      rationale: "由用户关键词决定目标",
    },
    evidenceRefs: ["episode:replacement"],
  };
  const replacementPlan = {
    replacesCapabilityIds: [old.id],
    reason: "商品搜索能力覆盖原仅手机搜索能力",
    disableAfterPublish: true,
  };
  const classified = await classifyCapabilityGeneration(
    siteId,
    {
      request: {
        goal: "搜索商品",
        parameters: { query: "手机" },
        entryUrl: "https://example.test/search",
      },
      source: "Admin",
      instruction: { operation: "create" },
    },
    {
      candidate: {
        schemaVersion: "1.0",
        name: "搜索商品",
        description: "搜索任意商品",
        aliases: ["查找商品"],
        intent: "搜索任意商品",
        semantic,
        replacementPlan,
      },
    },
  );
  assert.equal(classified.disposition, "Created");
  if (classified.disposition !== "Created") return;
  assert.deepEqual(classified.task.runSpec.replacementPlan, replacementPlan);
  await claimTask(siteId, classified.task.id, "replacement-discovery");
  const replacementCandidate = {
    name: "搜索商品",
    description: "搜索任意商品",
    aliases: ["查找商品"],
    contract,
    program,
    replacementPlan,
  };
  const replacementOutputs = await formalGenerationOutputs(
    classified.task.id,
    replacementCandidate,
    [{ query: "手机" }, { query: "衣服" }],
  );
  const completed = await submitTaskResult(
    siteId,
    classified.task.id,
    "replacement-discovery",
    {
      outcome: "Success",
      candidateProgram: program,
      candidateSummary: {
        name: "搜索商品",
        description: "搜索任意商品",
        aliases: ["查找商品"],
        contract,
        replacementPlan,
      },
      ...replacementOutputs,
      output: { ok: true },
    },
  );
  const validationId = completed.task.result?.validationTaskId;
  assert.ok(validationId);
  await claimTask(siteId, validationId, "replacement-validation");
  const validated = await submitTaskResult(
    siteId,
    validationId,
    "replacement-validation",
    {
      outcome: "Success",
      validationResults: [
        {
          caseId: "case_1",
          resolvedInput: { query: "手机" },
          output: { ok: true },
          stageReceipts: [
            {
              stageId: "complete",
              outcome: "Success",
              evidenceRefs: ["evidence://case_1"],
            },
          ],
          evidenceRefs: ["evidence://case_1"],
        },
        {
          caseId: "case_2",
          resolvedInput: { query: "衣服" },
          output: { ok: true },
          stageReceipts: [
            {
              stageId: "complete",
              outcome: "Success",
              evidenceRefs: ["evidence://case_2"],
            },
          ],
          evidenceRefs: ["evidence://case_2"],
        },
      ],
    },
  );
  assert.equal(validated.task.result?.buildResult?.outcome, "Validated");
  if (validated.task.result?.buildResult?.outcome !== "Validated") return;
  const published = await publishValidatedCapability(siteId, {
    generationTaskId: classified.task.id,
    validated: validated.task.result.buildResult.package,
    authorization: {
      mode: "AdminOverride",
      adminId: "replacement-test",
      reason: "覆盖验证通过",
    },
  });
  assert.equal(published.outcome, "Published");
  assert.equal((await getCapability(siteId, old.id, true))?.status, "Disabled");
  assert.ok(duplicateChecks.length >= 1, "the duplicate check really ran against the provider");
  } finally {
    for (const [name, value] of Object.entries(savedModelEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    modelServer.closeAllConnections();
    await new Promise((resolve) => modelServer.close(resolve));
  }
});

test("C3 deterministic evaluator has no model fallback", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<main><h1>搜索完成</h1></main>");
    const deterministicContract = {
      intent: "搜索商品",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", additionalProperties: true },
      preconditions: [],
      successConditions: [
        { type: "inputExists", path: "query" },
        { type: "textIncludes", value: "搜索完成" },
        { type: "outputExists", path: "result" },
      ],
    };
    await evaluateResultDeterministic(
      page,
      deterministicContract,
      { result: "ok" },
      {
        parameters: { query: "马克杯" },
        context: {},
        interactions: [],
        trigger: {},
      },
    );
    await assert.rejects(
      () =>
        evaluateResultDeterministic(
          page,
          {
            ...deterministicContract,
            successConditions: [{ type: "modelGoal", goal: "搜索商品" }],
          },
          { result: "ok" },
          {
            parameters: { query: "马克杯" },
            context: {},
            interactions: [],
            trigger: {},
          },
        ),
      /deterministic_condition_unsupported:modelGoal/,
    );
  } finally {
    await browser.close();
  }
});

test("outputEquals compares the way the rest of the system compares text", async () => {
  // This was the one comparison in the evaluator that used `!==`. Everything a
  // page hands back carries display normalization — a full-width digit, a
  // trailing space — and two arrays or objects are never identical at all, so
  // an outputEquals on a list could not pass however right the capability was.
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<main><h1>Done</h1></main>");
    const contract = (value) => ({
      intent: "read the result",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: true },
      preconditions: [],
      successConditions: [{ type: "outputEquals", path: "label", value }],
    });
    const input = { parameters: {}, context: {}, interactions: [], trigger: {} };
    // Display differences that mean nothing to a reader mean nothing here.
    await evaluateResultDeterministic(page, contract("Done"), { label: " Done " }, input);
    await evaluateResultDeterministic(page, contract("ABC"), { label: "ＡＢＣ" }, input);
    // A list or an object is compared by value, not by identity.
    await evaluateResultDeterministic(page, contract(["a", "b"]), { label: ["a", "b"] }, input);
    await evaluateResultDeterministic(page, contract({ a: 1 }), { label: { a: 1 } }, input);
    // A different value is still a different value.
    await assert.rejects(
      () => evaluateResultDeterministic(page, contract("Done"), { label: "Cancelled" }, input),
      /success_output_mismatch/,
    );
    await assert.rejects(
      () => evaluateResultDeterministic(page, contract(["a", "b"]), { label: ["a"] }, input),
      /success_output_mismatch/,
    );
  } finally {
    await browser.close();
  }
});

test("contract condition evaluation renders site-language input aliases", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      "<main><p>Clothes has been added to your cart.</p></main>",
    );
    const contract = {
      intent: "把{{categoryName}}加入购物车",
      inputSchema: {
        type: "object",
        properties: { categoryName: { type: "string" } },
        required: ["categoryName"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", additionalProperties: true },
      preconditions: [],
      successConditions: [
        {
          type: "textTemplate",
          template: "{{categoryName}} has been added to your cart.",
        },
      ],
      inputAliases: { categoryName: { 衣服: "Clothes" } },
    };
    await evaluateResultDeterministic(
      page,
      contract,
      { ok: true },
      {
        parameters: { categoryName: "衣服" },
        context: {},
        interactions: [],
        trigger: {},
      },
    );
  } finally {
    await browser.close();
  }
});

test("SDK navigates to a declared entry before checking page preconditions", async () => {
  const source = await readFile(fileURLToPath(new URL("../client/user-agent-port.ts", import.meta.url)), "utf8");
  const runtime = source.slice(source.indexOf("private async executeCapabilityV2JavaScriptRuntime"), source.indexOf("private async executeCapabilityV2ById"));
  const entryNavigation = runtime.indexOf('runtime.program.entry.mode === "Navigate"');
  // The check is the shared one (lib/capability-center-v2/run-resolution); what this test guards is its place after the navigation.
  const preconditionCheck = runtime.indexOf("checkPreconditions(runtime.contract");
  assert.ok(entryNavigation >= 0, "V2 runtime entry navigation is missing");
  assert.ok(
    preconditionCheck > entryNavigation,
    "entry-page preconditions must be checked after navigation",
  );
});

test("the published SDK contains the V2 JavaScript Stage host", async () => {
  const bundles = await Promise.all(
    ["sitewake.js"].map((name) =>
      readFile(
        fileURLToPath(new URL(`../public/${name}`, import.meta.url)),
        "utf8",
      ),
    ),
  );
  for (const source of bundles) {
    assert.match(source, /capability_checkpoint_module_mismatch/);
    assert.match(source, /capability_stage_manifest_mismatch/);
    assert.doesNotMatch(source, /program\.steps\.length/);
  }
});

/**
 * Raw material from production task afba478c: parameter planning mapped the user's
 * keyword to the search box placeholder, the exploration really searched for the
 * placeholder, found nothing, froze that sentence into the contract, and every later example failed.
 */
const ACME_HOME = {"url":"https://www.example.org/","title":"微博热搜历史查询_每日热搜榜与趋势回看 - 热搜时光机","heading":"微博热搜历史查询与每日热搜榜回看 - 热搜时光机","text":"热搜时光机 AI 热搜 日榜 词云 明星 地区 关注 搜索 登录 注册 微博热搜历史查询与每日热搜榜回看 - 热搜时光机 实时 · 2026/09/17 13:10:03 实时 历史日期 查看历史 精确 13:10 中午 峰值观察 拖动时间 13:10 00 06 12 18 24 全天热点一览 不只看某一刻榜单，按天","signals":[],"elements":[{"index":5,"tag":"a","role":"link","name":"地区","css":"body > div:nth-of-type(1) > header > div > nav > a:nth-of-type(5)","href":"https://www.example.org/city"},{"index":6,"tag":"button","role":"button","name":"关注","css":"body > div:nth-of-type(1) > header > div > nav > button","disabled":false},{"index":7,"tag":"input","role":"combobox","name":"搜索历史热搜","placeholder":"搜索历史热搜","css":"#base-ui-\\:R9b9cja\\:","inputType":"search","disabled":false},{"index":8,"tag":"button","role":"button","name":"搜索","css":"body > div:nth-of-type(1) > header > div > div:nth-of-type(1) > form > button","disabled":false},{"index":9,"tag":"button","role":"button","name":"订阅热搜","css":"body > div:nth-of-type(1) > header > div > div:nth-of-type(2) > div > button:nth-of-type(1)","disabled":false}]};
const ACME_EXPERIENCE = { schemaVersion: "1.0", episodeId: "episode_x", agentRunId: "run_x", browserSessionId: "browser_x", originalGoal: "给我搜索周杰伦热搜", outcome: "Success", outcomeSummary: "已成功搜索", startedAt: "2026-09-17T03:57:00.000Z", endedAt: "2026-09-17T03:58:00.000Z", startPage: { url: "https://www.example.org/" }, endPage: { url: "https://www.example.org/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6" }, actions: [{ action: "fill", rawAction: "input_text", input: { index: 8, text: "周杰伦" }, element: { tag: "input", role: "combobox", accessibleName: "搜索历史热搜", placeholder: "搜索历史热搜", contextText: "搜索", landmark: "header" }, page: { url: "https://www.example.org/" }, observedAt: "2026-09-17T03:57:53.730Z" }], output: {} };

test("a site-term alias can never be the search box's own placeholder or a button label", () => {
  const raw = { intent: "查询特定关键词在微博热搜的历史上榜情况", name: "搜索微博历史热搜", description: "搜索指定关键词的热搜记录", aliases: [], parameters: [{ name: "keyword", type: "string", description: "要查询的微博热搜关键词", required: true, exampleValue: "周杰伦" }], groundingExamples: [{ keyword: "周杰伦" }, { keyword: "赵丽颖" }], siteTerms: [{ name: "keyword", from: "热搜", value: "搜索历史热搜" }, { name: "keyword", from: "关键词", value: "搜索历史热搜" }, { name: "keyword", from: "周杰伦", value: "搜索" }], scope: { kind: "site-global", onMismatch: "no-match" } };
  const plan = cleanParameterPlan(raw, "查询特定关键词在微博热搜的历史上榜情况", { parameters: { keyword: "周杰伦" }, context: {}, interactions: [], trigger: {}, experience: ACME_EXPERIENCE }, ACME_HOME);
  assert.equal(plan.inputAliases, undefined, "placeholder / 按钮名不是站内用语");
  assert.equal(plan.parameters[0].exampleValue, "周杰伦");
});

test("a value the user typed into a text control is not expected on the entry page", () => {
  assert.equal(typedInDemonstration("周杰伦", ACME_EXPERIENCE), true);
  assert.equal(typedInDemonstration("赵丽颖", ACME_EXPERIENCE), false);
  assert.equal(typedInDemonstration("周杰伦", undefined), false);
});

test("a completion signal with a result count is evidence, not a frozen contract condition", () => {
  const plan = { parameters: [{ name: "keyword", type: "string", required: true, exampleValue: "周杰伦" }] };
  assert.equal(hasVolatileNumber("找到 1138 条包含“周杰伦”的历史热搜", plan), true);
  assert.equal(hasVolatileNumber("包含“周杰伦”的历史热搜", plan), false);
  // A number that is part of the input value itself (a model number) is not volatile.
  assert.equal(hasVolatileNumber("已找到 iPhone 15", { parameters: [{ name: "model", type: "string", required: true, exampleValue: "iPhone 15" }] }), false);
  assert.equal(hasVolatileNumber("找到 {{count}} 条", plan), false);
});

test("assigning .value to a DOM handle is recorded as a note; fill() and plain-data .value are clean", () => {
  const stage = (body) => `export const capability={version:2,stages:[{id:"stage_1",io:{reads:{input:["keyword"],state:[]},writes:{state:[],output:[]}},navigation:"optional",async run({input,waitFor,fill}){${body}return {outcome:"Continue"}}}]};`;
  assert.equal(validateCapabilityJavaScriptSource(stage(`const box=await waitFor("#q");box.value=input.keyword;box.dispatchEvent(new Event("input",{bubbles:true}));`)).notes[0].code, "capability_module_direct_value_assignment");
  assert.equal(validateCapabilityJavaScriptSource(stage(`const box=document.querySelector("#q");box.value=input.keyword;`)).notes[0].code, "capability_module_direct_value_assignment");
  assert.equal(validateCapabilityJavaScriptSource(stage(`document.querySelector("#q").value=input.keyword;`)).notes[0].code, "capability_module_direct_value_assignment");
  assert.equal(validateCapabilityJavaScriptSource(stage(`const box=await waitFor("#q");fill(box,input.keyword);`)).ok, true);
  assert.equal(validateCapabilityJavaScriptSource(stage(`const box=await waitFor("#q");const evidence={value:box.value};evidence.value=box.value.trim();`)).ok, true, "普通对象的 .value 不受影响");
  // The branch needs a body of its own: an empty one is refused by the guard
  // rule, and what this line is about is that reading .value is not writing it.
  assert.equal(validateCapabilityJavaScriptSource(stage(`const box=await waitFor("#q");if(box.value===input.keyword){return {outcome:"Continue"}}`)).ok, true, "比较不是赋值");
});

test("selectors built from get_dom's computed role/name are recorded as notes", () => {
  const stage = (selector) => `export const capability={version:2,stages:[{id:"stage_1",io:{reads:{input:[],state:[]},writes:{state:[],output:[]}},navigation:"optional",async run({waitFor}){await waitFor(${JSON.stringify(selector)});return {outcome:"Continue"}}}]};`;
  // The old role rule missed a tag name directly preceded by a quote.
  assert.equal(validateCapabilityJavaScriptSource(stage('input[role="combobox"][name="搜索历史热搜"]')).notes[0].code, "capability_module_computed_aria_selector_forbidden");
  assert.equal(validateCapabilityJavaScriptSource(stage('button[name="搜索"]')).notes[0].code, "capability_module_computed_aria_selector_forbidden");
  assert.equal(validateCapabilityJavaScriptSource(stage('a[name="Add to cart"]')).notes[0].code, "capability_module_computed_aria_selector_forbidden");
  // A real name attribute (an ASCII identifier) remains allowed.
  assert.equal(validateCapabilityJavaScriptSource(stage('input[name="q"]')).ok, true);
  assert.equal(validateCapabilityJavaScriptSource(stage('input[placeholder="搜索历史热搜"]')).ok, true);
});

test("a site term whose `from` is not the demonstrated value never becomes a demonstration token", () => {
  // Production: siteTerms [{ from: "地区", value: "国家与地区" }] turned the intent into
  // "我想看看{{countryName}}{{countryName}}有什么新闻" and replaced the planned name with it.
  const snapshot = { url: "https://www.example.org/", title: "热搜时光机", heading: "微博热搜历史查询", text: "热搜 日榜 词云 明星 地区 国家与地区 伊朗 美国", signals: [], elements: [
    { index: 1, tag: "a", role: "link", name: "地区", css: "nav > a:nth-of-type(5)", href: "https://www.example.org/city" },
    { index: 2, tag: "button", role: "button", name: "国家与地区", css: "main button", disabled: false },
  ] };
  const raw = { intent: "我想看看{{countryName}}地区有什么新闻", name: "查询国家或地区微博热搜", description: "查询指定国家或地区的微博热搜话题。", aliases: ["查看国家热搜"], parameters: [{ name: "countryName", type: "string", description: "要查询的国家或地区名称", required: true, exampleValue: "伊朗" }], groundingExamples: [{ countryName: "伊朗" }, { countryName: "美国" }], siteTerms: [{ name: "countryName", from: "地区", value: "国家与地区" }, { name: "countryName", from: "伊朗", value: "Iran" }], scope: { kind: "site-global", onMismatch: "no-match" } };
  const plan = cleanParameterPlan(raw, "我想看看伊朗地区有什么新闻", { parameters: { countryName: "伊朗" }, context: {}, interactions: [], trigger: {} }, snapshot, { name: "查询国家或地区微博热搜", description: "查询指定国家或地区的微博热搜话题。", aliases: ["查看国家热搜"] });
  assert.equal(plan.intent, "我想看看{{countryName}}地区有什么新闻");
  assert.equal(plan.name, "查询国家或地区微博热搜");
  assert.equal(plan.description, "查询指定国家或地区的微博热搜话题。");
});

test("serving a published module checks that it is safe to run, not that it is well written", () => {
  // 打开热搜榜指定排名详情 was published, then answered 409 to every visitor the
  // moment `capability_module_empty_branch` shipped: the module endpoint ran
  // the whole rule list against stored modules, so a rule about how a
  // capability is written took a working one off the air retroactively.
  const withEmptyBranch = `export const capability={version:2,stages:[{id:"stage_verify",async run({state,identityMatches}){const t=document.querySelector("h1").textContent;if(t&&!identityMatches(state.targets.__actedOn,t)){}return{outcome:"Success",output:{t}}}}]};`;
  assert.equal(validateCapabilityJavaScriptSource(withEmptyBranch, []).code, "capability_module_empty_branch");
  assert.deepEqual(
    validateCapabilityJavaScriptSource(withEmptyBranch, [], [], { scope: "execution" }),
    { ok: true },
    "已发布的能力不该因为新增的写法规则而下线",
  );

  // What protects the visitor's page is still enforced when it is served.
  const unsafe = [
    [`export const capability={version:2,stages:[{id:"s",async run(){await fetch("https://example.test");return{outcome:"Success"}}}]};`, "capability_module_network_forbidden"],
    [`export const capability={version:2,stages:[{id:"s",async run(){eval("1");return{outcome:"Success"}}}]};`, "capability_module_dynamic_code_forbidden"],
    [`export const capability={version:2,stages:[{id:"s",async run(){while(true){}return{outcome:"Success"}}}]};`, "capability_module_unbounded_loop_forbidden"],
    [`export const capability={version:2,stages:[{id:"s",async run(){return{outcome:"Success"}}}]};\n//# sourceMappingURL=x.map`, "capability_module_source_map_forbidden"],
    [`const capability={version:2,stages:[]};`, "capability_module_export_missing"],
  ];
  for (const [source, code] of unsafe) {
    assert.equal(
      validateCapabilityJavaScriptSource(source, [], [], { scope: "execution" }).code,
      code,
      `${code} 必须在提供模块时仍然拦截`,
    );
  }
});

test("the failing side of an identity check must leave the stage, not rewrite the value", () => {
  // The version published to the deployed installation after the empty-branch
  // rule shipped (2026-09-26). The branch got a body — one that re-cut the
  // title out of the acted-on text until identityMatches would pass.
  const overruled = `export const capability={version:2,stages:[{id:"stage_verify",async run({state,identityMatches}){const actedOn=state.targets.__actedOn;let targetTitle=document.querySelector("h2").textContent;if(actedOn&&targetTitle){if(!identityMatches(actedOn,targetTitle)){const parts=actedOn.split(/\\s+/);if(parts.length>=2){targetTitle=parts.slice(1).find(p=>p&&!/^\\d/.test(p))||parts[1]}}}return{outcome:"Success",output:{targetTitle}}}}]};`;
  assert.equal(validateCapabilityJavaScriptSource(overruled, []).code, "capability_module_identity_check_overruled");

  // Leaving the stage is the repair, either way round.
  const rejects = `export const capability={version:2,stages:[{id:"stage_verify",async run({state,identityMatches}){const t=document.querySelector("h2").textContent;if(!identityMatches(state.targets.__actedOn,t)){return{outcome:"NoResult",reason:"not the acted-on item"}}return{outcome:"Success",output:{t}}}}]};`;
  assert.deepEqual(validateCapabilityJavaScriptSource(rejects, []), { ok: true });
  const throwsInstead = rejects.replace('return{outcome:"NoResult",reason:"not the acted-on item"}', 'throw new Error("identity mismatch")');
  assert.deepEqual(validateCapabilityJavaScriptSource(throwsInstead, []), { ok: true });
  const positiveForm = `export const capability={version:2,stages:[{id:"stage_verify",async run({state,identityMatches}){const t=document.querySelector("h2").textContent;if(identityMatches(state.targets.__actedOn,t)){return{outcome:"Success",output:{t}}}else{return{outcome:"NoResult",reason:"mismatch"}}}}]};`;
  assert.deepEqual(validateCapabilityJavaScriptSource(positiveForm, []), { ok: true });
  // The positive form with no else falls through as if the check had passed.
  const fallsThrough = `export const capability={version:2,stages:[{id:"stage_verify",async run({state,identityMatches}){const t=document.querySelector("h2").textContent;if(identityMatches(state.targets.__actedOn,t)){console.log("ok")}return{outcome:"Success",output:{t}}}}]};`;
  assert.equal(validateCapabilityJavaScriptSource(fallsThrough, []).code, "capability_module_identity_check_overruled");
});

test("an output assembled from a hard-coded address is a guess, not a reading", () => {
  // Same published version: when neither location.href nor a link carried the
  // topic, it built the URL from the title and returned it as targetUrl.
  const fabricated = `export const capability={version:2,stages:[{id:"stage_verify",async run(){const targetTitle=document.querySelector("h2").textContent;let targetUrl="";if(location.search.includes("?topic=")){targetUrl=location.href}else{const link=document.querySelector('a[href*="?topic="]');if(link){targetUrl=link.href}else{targetUrl=\`https://www.example.test/?topic=\${encodeURIComponent(targetTitle)}\`}}return{outcome:"Success",output:{targetTitle,targetUrl}}}}]};`;
  assert.equal(validateCapabilityJavaScriptSource(fabricated, []).notes[0].code, "capability_module_output_fabricated");
  // String concatenation is the same guess.
  const concatenated = fabricated.replace("`https://www.example.test/?topic=${encodeURIComponent(targetTitle)}`", '"https://www.example.test/?topic="+encodeURIComponent(targetTitle)');
  assert.equal(validateCapabilityJavaScriptSource(concatenated, []).notes[0].code, "capability_module_output_fabricated");
  // What the page did not provide is NoResult, and that is accepted.
  const honest = fabricated.replace("targetUrl=`https://www.example.test/?topic=${encodeURIComponent(targetTitle)}`", 'return{outcome:"NoResult",reason:"no topic link on the page"}');
  assert.deepEqual(validateCapabilityJavaScriptSource(honest, []), { ok: true });
  // A literal address that is compared against, not assembled, is fine.
  const compared = `export const capability={version:2,stages:[{id:"stage_verify",async run(){if(!location.href.startsWith("https://www.example.test/")){return{outcome:"NoResult"}}return{outcome:"Success",output:{url:location.href}}}}]};`;
  assert.deepEqual(validateCapabilityJavaScriptSource(compared, []), { ok: true });
});

test("a rebuild keeps the published contract's public shape", () => {
  // The rebuild of 打开热搜榜指定排名详情 published currentRank as a string where
  // the previous version had a number. The design turn writes a whole contract
  // each time; on a rebuild the public shape is not its to redesign.
  const base = {
    intent: "打开第{{rank}}名",
    inputSchema: { type: "object", properties: { rank: { type: "number" } }, required: ["rank"], additionalProperties: false },
    outputSchema: { type: "object", properties: { targetTitle: { type: "string" }, targetUrl: { type: "string" }, currentRank: { type: "number" } }, required: ["targetTitle", "targetUrl", "currentRank"], additionalProperties: false },
    preconditions: [],
    successConditions: [{ type: "outputExists", path: "targetTitle" }],
  };
  const designed = {
    ...base,
    inputSchema: { type: "object", properties: { rank: { type: "string" } }, required: ["rank"], additionalProperties: false },
    outputSchema: { type: "object", properties: { targetTitle: { type: "string" }, targetUrl: { type: "string" }, currentRank: { type: "string" }, heat: { type: "string" } }, required: ["targetTitle", "targetUrl", "currentRank"], additionalProperties: false },
    successConditions: [{ type: "urlIncludes", value: "?topic=" }],
  };
  const pinned = pinContractToBase(designed, base);
  assert.deepEqual(pinned.inputSchema, base.inputSchema, "公开输入不变");
  assert.deepEqual(pinned.outputSchema, base.outputSchema, "公开输出不变，多设计出来的字段不进 schema");
  // What the design turn is for still comes from the design turn.
  assert.deepEqual(pinned.successConditions, designed.successConditions);
  // A fresh generation has no base and is left alone.
  assert.deepEqual(pinContractToBase(designed, undefined), designed);
});

test("a rebuild drops what its design names that the published shape does not declare", () => {
  // Three rebuilds of live capabilities failed as inconsistent before writing
  // a line: the design required outputs and inputs under names of its own.
  const base = {
    intent: "Find wall lamps in {{finish}}",
    inputSchema: { type: "object", properties: { finish: { type: "string" } }, required: ["finish"] },
    outputSchema: { type: "object", properties: { lamps: { type: "array" }, totalCount: { type: "integer" } }, required: ["lamps"] },
    preconditions: [],
    successConditions: [{ type: "outputExists", path: "lamps" }],
  };
  const designed = {
    intent: "Find wall lamps in {{colour}}",
    inputSchema: { type: "object", properties: { colour: { type: "string" } }, required: ["colour"] },
    outputSchema: { type: "object", properties: { results: { type: "array" } }, required: ["results"] },
    preconditions: [{ type: "inputExists", path: "colour" }],
    successConditions: [{ type: "outputExists", path: "results" }, { type: "urlIncludes", value: "type=wall" }],
    scope: { kind: "category-scoped", match: { requiredInputPaths: ["/shop", "finish"], urlPatterns: ["/shop\\?type=wall"] }, onMismatch: "no-match" },
  };
  const pinned = pinContractToBase(designed, base);
  assert.deepEqual(inspectContractConsistency(pinned), []);
  assert.equal(pinned.intent, base.intent);
  assert.deepEqual(pinned.preconditions, []);
  assert.deepEqual(pinned.successConditions, [{ type: "urlIncludes", value: "type=wall" }], "what still holds of the design is kept");
  assert.deepEqual(pinned.scope.match.requiredInputPaths, ["finish"]);
  // Nothing executable left of the design: the published conditions stand.
  const bare = pinContractToBase({ ...designed, successConditions: [{ type: "outputExists", path: "results" }] }, base);
  assert.deepEqual(bare.successConditions, base.successConditions);
});

test("a completed generation that froze its validation is advanced to it, not to a second one", async () => {
  // Reached through the legacy flow only to obtain a real Validation task to
  // point at; what is under test is the advance of a Discovery whose result
  // already names its validation while its context carries no pipeline flag.
  const discovery = await createCapabilityTask(siteId, {
    type: "Discovery",
    goal: "搜索商品",
    input: {
      candidateSummary: { name: "搜索商品", description: "搜索商品", contract },
      program,
      parameters: {},
      context: { startUrl: "https://example.test" },
      interactions: [],
      trigger: {},
    },
  });
  await claimTask(siteId, discovery.task.id, "runner-frozen");
  const completed = await submitTaskResult(siteId, discovery.task.id, "runner-frozen", { outcome: "Success", candidateProgram: program });
  const first = await advanceCompletedTask(completed.task);
  assert.equal(first.nextTask?.type, "Validation");
  const validationsBefore = (await listTasks(siteId, { type: "Validation", includeDeleted: true, includeArchived: true })).tasks.length;

  // The shape a v2 completion has on the wire: the result names the frozen
  // validation; the context, as an admin-started rebuild's did, does not say
  // "2.0". The version it points at is no longer a Draft.
  const frozen = {
    ...completed.task,
    input: { ...completed.task.input, context: { startUrl: "https://example.test" } },
    result: { ...completed.task.result, validationTaskId: first.nextTask.id },
  };
  const advanced = await advanceCompletedTask(frozen);
  assert.equal(advanced.nextTask?.id, first.nextTask.id, "advance to the validation the generation froze");
  const validationsAfter = (await listTasks(siteId, { type: "Validation", includeDeleted: true, includeArchived: true })).tasks.length;
  assert.equal(validationsAfter, validationsBefore, "no second validation is created");
});

test("an input whose value is part of the entry address selects the page, and a program that never navigates cannot serve it", () => {
  // A by-date archive was demonstrated on `/daily/2026-03-11` with one verify
  // stage and no navigation. It read that page for every date, passed
  // authoring on the demonstration, and was caught only by the third
  // independent case three stages later.
  const contract = {
    intent: "查看指定日期的榜单",
    inputSchema: { type: "object", properties: { date: { type: "string" } }, required: ["date"], additionalProperties: false },
    outputSchema: { type: "object", properties: { date: { type: "string" } }, required: ["date"], additionalProperties: false },
    preconditions: [],
    successConditions: [{ type: "textTemplate", template: "{{date}}" }],
  };
  const verify = { id: "stage_verify", title: "verify", purpose: "report", effect: "read", resumePolicy: "skip-completed", navigation: "none", io: { reads: { input: ["date"], state: [] }, writes: { state: [], output: ["date"] } } };
  const open = { id: "stage_open", title: "open", purpose: "open the page for the date", effect: "read", resumePolicy: "skip-completed", navigation: "required", io: { reads: { input: ["date"], state: [] }, writes: { state: [], output: [] } } };
  const program = {
    schemaVersion: "2.0", runtime: "BrowserJavaScriptStage",
    module: { contentHash: "a".repeat(64), moduleUrl: "/m", exportName: "capability" },
    entry: { mode: "CurrentPage" },
    stages: [verify],
    parameterRoles: [{ inputPath: "date", role: "context" }],
    targetBindings: [],
  };
  const demonstrationParameters = { date: "2026-03-11" };
  const codes = (report) => report.notes.map((issue) => issue.code);

  // The value is a path segment of the entry address, and nothing navigates.
  assert.deepEqual(codes(inspectCapabilityQuality(contract, program, { demonstrationParameters, entryUrl: "https://archive.example/daily/2026-03-11" })), ["page_selecting_input_not_navigated"]);
  // A query value selects the page just the same.
  assert.deepEqual(codes(inspectCapabilityQuality(contract, program, { demonstrationParameters, entryUrl: "https://archive.example/daily?date=2026-03-11&tab=all" })), ["page_selecting_input_not_navigated"]);
  // A fixed Navigate entry that carries the value is the same defect.
  assert.deepEqual(codes(inspectCapabilityQuality(contract, { ...program, entry: { mode: "Navigate", url: "https://archive.example/daily/2026-03-11" } }, { demonstrationParameters })), ["page_selecting_input_not_navigated"]);
  // A stage that navigates is the whole difference.
  assert.deepEqual(codes(inspectCapabilityQuality(contract, { ...program, stages: [open, verify] }, { demonstrationParameters, entryUrl: "https://archive.example/daily/2026-03-11" })), []);
  // An input that is not part of the address is not held to this: the page
  // does not depend on it.
  assert.deepEqual(codes(inspectCapabilityQuality(contract, program, { demonstrationParameters, entryUrl: "https://archive.example/daily/today" })), []);
  // Nor is a value that merely occurs inside a segment.
  assert.deepEqual(codes(inspectCapabilityQuality(contract, program, { demonstrationParameters, entryUrl: "https://archive.example/daily/2026-03-11-summary" })), []);
  // Without an entry address there is nothing to compare against.
  assert.deepEqual(codes(inspectCapabilityQuality(contract, program, { demonstrationParameters })), []);
});

test("a capability is never named after the template that fills it", () => {
  // Production: the site-term turn paired the category word 明星 with the
  // demonstrated 周杰伦, so every candidate label counted as demonstration
  // bound and the name fell back to the intent. The capability centre then
  // listed 「给我查看{{celebrityName}}热搜」 — a placeholder shown to a reader.
  const raw = {
    parameters: [{ name: "celebrityName", type: "string", description: "要查询的明星或公众人物的名称", required: true, exampleValue: "周杰伦" }],
    groundingExamples: [{ celebrityName: "周杰伦" }, { celebrityName: "那英" }],
    siteTerms: [{ name: "celebrityName", from: "明星", value: "周杰伦" }],
  };
  const snapshot = {
    url: "https://example.test/",
    title: "历史热搜查询",
    heading: "历史热搜查询",
    text: "周杰伦 那英 搜索历史热搜",
    elements: [],
  };
  const plan = cleanParameterPlan(
    raw,
    "给我查看周杰伦热搜",
    {},
    snapshot,
    { name: "查看明星微博热搜记录", description: "查询指定明星的历史热搜记录。", aliases: ["查询明星热搜", "查看名人热搜"] },
    "查询特定人物在微博上的历史热搜数据及趋势",
  );
  assert.equal(plan.intent, "给我查看{{celebrityName}}热搜", "意图仍然是模板，由运行时填充");
  assert.equal(plan.name, "查询特定人物在微博上的历史热搜数据及趋势");
  assert.equal(plan.description, "查询特定人物在微博上的历史热搜数据及趋势");
  for (const label of [plan.name, plan.description, ...plan.aliases]) {
    assert.doesNotMatch(label, /\{\{/, `给人读的文字里不应出现占位符：${label}`);
  }
});

test("a label that is neither demonstration bound nor templated is still preferred", () => {
  const raw = {
    parameters: [{ name: "keyword", type: "string", description: "搜索词", required: true, exampleValue: "周杰伦" }],
    groundingExamples: [{ keyword: "周杰伦" }, { keyword: "那英" }],
  };
  const snapshot = { url: "https://example.test/", title: "搜索", heading: "搜索", text: "周杰伦 那英", elements: [] };
  const plan = cleanParameterPlan(raw, "搜索周杰伦", {}, snapshot, { name: "搜索历史热搜", description: "按关键词搜索。", aliases: [] }, "按关键词搜索历史热搜");
  assert.equal(plan.name, "搜索历史热搜", "候选标签可用时不被规范化目标取代");
});

test("a request that is the published intent with its holes filled routes on its own", () => {
  // Production: 「给我查看张靓颖热搜」 reached a catalogue that held
  // 「给我查看{{celebrityName}}热搜」 and still went back to clicking the page,
  // because only an exact name or alias could route without a model.
  assert.deepEqual(matchCapabilityIntentTemplate("给我查看{{celebrityName}}热搜", "给我查看张靓颖热搜"), { celebrityName: "张靓颖" });
  assert.deepEqual(matchCapabilityIntentTemplate("给我查看{{celebrityName}}热搜", " 给我查看　张靓颖 热搜 "), { celebrityName: "张靓颖" });
  assert.deepEqual(matchCapabilityIntentTemplate("Add {{product}} to the cart", "Add Arc lamp to the cart"), { product: "Arc lamp" });
  assert.deepEqual(matchCapabilityIntentTemplate("把 {{商品}} 加入 {{清单}}", "把 马克杯 加入 心愿单"), { 商品: "马克杯", 清单: "心愿单" });
});

test("an intent only claims a request it actually describes", () => {
  const intent = "给我查看{{celebrityName}}热搜";
  for (const goal of ["给我查看热搜", "查看张靓颖的热搜", "给我查看张靓颖热搜榜单", "", "给我查看 热搜"]) {
    assert.equal(matchCapabilityIntentTemplate(intent, goal), undefined, `不应匹配：${goal}`);
  }
  // All hole, or holes with nothing between them: a sentence that would answer
  // every request, and one that cannot say where a value ends.
  assert.equal(matchCapabilityIntentTemplate("{{keyword}}", "随便什么请求"), undefined);
  assert.equal(matchCapabilityIntentTemplate("{{a}}{{b}}", "两个值挤在一起"), undefined);
  assert.equal(matchCapabilityIntentTemplate("{{a}}{{b}}{{c}}", "全是洞"), undefined);
  // Two characters is a word in Chinese, so 「搜索{{a}}」 is a real intent and
  // keeps its route; one stray character around a hole is not.
  assert.deepEqual(matchCapabilityIntentTemplate("搜索{{a}}", "搜索马克杯"), { a: "马克杯" });
  assert.equal(matchCapabilityIntentTemplate("查{{a}}", "查马克杯"), undefined);
  // No holes at all is a title, not a template; an exact name match already covers it.
  assert.equal(matchCapabilityIntentTemplate("给我查看第三条热搜", "给我查看第三条热搜"), undefined);
  // The same hole twice has to be filled the same way.
  assert.equal(matchCapabilityIntentTemplate("从{{city}}到{{city}}", "从北京到上海"), undefined);
  assert.deepEqual(matchCapabilityIntentTemplate("从{{city}}到{{city}}", "从北京到北京"), { city: "北京" });
});

test("the intent route is taken before the Agent is asked to decide", async () => {
  const source = await readFile(fileURLToPath(new URL("../client/user-agent-port.ts", import.meta.url)), "utf8");
  const templateRoute = source.indexOf("const templateV2Matches");
  const modelDecision = source.indexOf("const deterministicV2Candidate = exactV2");
  assert.ok(templateRoute >= 0, "缺少意图模板路由");
  assert.ok(templateRoute < modelDecision, "意图模板路由必须在模型决策之前");
  const block = source.slice(templateRoute, modelDecision);
  assert.match(block, /templateV2Matches\.length === 1/, "只有唯一匹配才能直接执行");
  assert.match(block, />= bestV2Score/, "目录里排名更高的候选优先，模板不能越过它");
  assert.match(block, /capabilityV2InputFromTemplate/, "参数要经过契约校验后才传入");
  assert.match(source.slice(source.indexOf("private capabilityV2InputFromTemplate")), /assertCapabilityInput/, "模板取到的值必须过 inputSchema");
});

test("a sentence that fits does not outrank a capability the catalogue prefers", () => {
  // 「给我查看第五条热搜」 fits 给我查看{{celebrityName}}热搜 with 第五条 as the name,
  // while the catalogue puts the rank capability first; the fit must not win.
  assert.deepEqual(matchCapabilityIntentTemplate("给我查看{{celebrityName}}热搜", "给我查看第五条热搜"), { celebrityName: "第五条" });
  assert.equal(matchCapabilityIntentTemplate("给我查看第三条热搜", "给我查看第五条热搜"), undefined, "字面意图不认别的排名");
});

test("a read stage that comes back empty is looked at once more; a write stage is not", async () => {
  const source = await readFile(fileURLToPath(new URL("../client/user-agent-port.ts", import.meta.url)), "utf8");
  const loop = source.slice(source.indexOf("const looks = stage.effect ==="), source.indexOf("const result = normalizeCapabilityV2StageResult"));
  assert.match(loop, /stage\.effect === "read" \? 2 : 1/, "只有读取型 stage 可以重看");
  assert.match(loop, /settleCapabilityPage/, "重看之前要等页面安静下来");
  assert.match(loop, /capabilityStageFoundNothing\(rawResult\)/, "只有空结果才触发重看");
  const predicate = source.slice(source.indexOf("function capabilityStageFoundNothing"));
  assert.match(predicate.slice(0, 260), /"NoResult"/, "空结果就是 NoResult");
});

test("a task waiting for a free runtime slot is queued, not failed", async () => {
  // The console showed 「排队中 · 等待执行资源」 and, underneath it,
  // 「本次制作未完成：Runner 启动失败」 for the same task. Every slot being
  // busy is a wait: the task returns to the queue and starts when one frees.
  resetCapabilityCenterV2ForTests();
  const siteId = "runner-queue-site";
  const created = await createCapabilityTask(siteId, {
    type: "Discovery",
    goal: "搜索微博历史热搜",
    input: { parameters: {}, context: {}, interactions: [], trigger: {} },
  });
  await claimTask(siteId, created.task.id, "runner-waiting");
  await registerRunner(siteId, { id: "runner-waiting", taskId: created.task.id });
  await markRunnerLost(siteId, "runner-waiting", "runner_launch_failed:runtime_launcher_capacity_exhausted");

  const task = await getTask(siteId, created.task.id, true);
  assert.equal(task.status, "Pending", "任务回到队列");
  assert.equal(task.runnerId, undefined);
  assert.equal(task.error, undefined, "排队不是失败，不应留下错误");
  const events = await listTaskEvents(siteId, created.task.id);
  assert.equal(events.at(-1).eventType, "RunnerLost", "工程记录仍然保留这次调度");
  assert.equal(events.at(-1).payload.message, "waiting for runner capacity", "工程记录说的是排队");
});

test("a capability is never named after the value the run demonstrated with", () => {
  // Production: the goal was 「查看某个明星的热搜话题列表」 and the run used 周深.
  // The site-term turn paired 明星 with 周深, so the goal-shaped label counted
  // as demonstration bound, the choice fell through to the model's
  // 「查看周深的热搜话题列表」, and the publish gate refused the capability for
  // demonstration_value_leaked. Avoiding the paired word must never cost more
  // than the leak it was avoiding.
  const raw = {
    parameters: [{ name: "celebrity", type: "string", description: "明星名称", required: true, exampleValue: "周深" }],
    groundingExamples: [{ celebrity: "周深" }, { celebrity: "那英" }],
    siteTerms: [{ name: "celebrity", from: "明星", value: "周深" }],
    name: "查看周深的热搜话题列表",
    description: "在热搜时光机中查看周深的热搜话题列表",
  };
  const snapshot = { url: "https://example.test/", title: "热搜", heading: "热搜", text: "周深 那英 明星", elements: [] };
  const plan = cleanParameterPlan(raw, "查看周深的热搜话题列表", {}, snapshot, undefined, "查看某个明星的热搜话题列表");
  for (const label of [plan.name, plan.description, ...plan.aliases]) {
    assert.doesNotMatch(label, /周深/, `给人读的文字里不能出现演示值：${label}`);
    assert.doesNotMatch(label, /\{\{/, `也不能出现占位符：${label}`);
  }
  assert.equal(plan.name, "查看某个明星的热搜话题列表", "应当选用规范化目标这个可复用的说法");
});
