import { createServer } from "node:http";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runC1Mock, startFixtureSite } from "./capability-center-v2-c1-mock.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = resolve(root, "tests/fixtures/capability-center-v2/notebook-search");
const fixtureModuleSourcePath = resolve(fixtureDir, "01-c1-module.ts");
const defaultOutputDir = resolve(root, ".artifacts/capability-center-v2/notebook-search");
const defaultSiteId = "prestashop_notebook_classify_real";
const fixtureSitePort = 18081;

export const steps = [
  { name: "classify", input: "00-original-input.json", output: "01-classify.json" },
  { name: "author", input: "01-classify.json", output: "02-author.json" },
  { name: "generate-cases", input: "02-c2-input.json", output: "03-c2-output.json" },
  { name: "validate", input: "03-c2-output.json", output: "04-c3-output.json" },
  { name: "review", input: "04-c3-output.json", output: "05-review.json" },
  { name: "publish", input: "05-review.json", output: "06-publish.json" },
];

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Buffer.from(digest).toString("hex")}`;
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function fixtureJson(name) {
  return json(join(fixtureDir, name));
}

function listen(server, port = 0) {
  return new Promise((resolvePromise, reject) => {
    const onError = (error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolvePromise(server.address()); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function closeServer(server) {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function jsonResponse(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

async function startStructuredModelFixtureServer(fixture) {
  const state = { calls: [] };
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) return response.writeHead(404).end();
    try {
      const body = await requestBody(request);
      state.calls.push({ schema: body.response_format?.json_schema?.name, model: body.model });
      return jsonResponse(response, 200, {
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(fixture) } }],
      });
    } catch (error) {
      return jsonResponse(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  const address = await listen(server);
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, state, baseUrl: `http://127.0.0.1:${port}/v1` };
}

const modelEnvironmentNames = [
  "MODEL_API_KEY",
  "MODEL_BASE_URL",
  "MODEL",
  "MODEL_EXECUTION",
  "MODEL_SEMANTIC",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "CAPABILITY_V2_AUTO_DISPATCH",
  "DATABASE_URL",
  "S3_BUCKET",
];

function snapshotEnvironment(names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(snapshot) {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function withModelFixture(fixture, callback) {
  const environment = snapshotEnvironment(modelEnvironmentNames);
  const model = await startStructuredModelFixtureServer(fixture);
  process.env.OPENAI_API_KEY = "capability-v2-progressive-fixture";
  process.env.OPENAI_BASE_URL = model.baseUrl;
  process.env.OPENAI_MODEL = "capability-v2-progressive-fixture";
  process.env.CAPABILITY_V2_AUTO_DISPATCH = "0";
  delete process.env.DATABASE_URL;
  delete process.env.S3_BUCKET;
  // MODEL_* outranks OPENAI_*, so a developer's real provider config would
  // silently override the fixture unless it is cleared for the run.
  for (const name of modelEnvironmentNames) {
    if (name.startsWith("MODEL")) delete process.env[name];
  }
  try {
    return await callback(model.state);
  } finally {
    await closeServer(model.server);
    restoreEnvironment(environment);
  }
}

function taskInputForCandidate(candidate, parameters, startUrl) {
  return {
    parameters: parameters || {},
    context: { startUrl, __pipelineVersion: "2.0", versionSource: "Admin" },
    interactions: [],
    trigger: {},
    candidateSummary: {
      name: candidate.name,
      description: candidate.description,
      aliases: candidate.aliases || [],
      contract: candidate.contract,
    },
    program: candidate.program,
  };
}

async function prepareFixtureModule(candidate, options = {}) {
  const [{ transform }, { capabilityModuleHash }] = await Promise.all([
    import("esbuild"),
    import("../lib/capability-center-v2/javascript-runtime.ts"),
  ]);
  const authoredSource = (await readFile(fixtureModuleSourcePath, "utf8")).replace(/\r\n/g, "\n").trim();
  const bundle = (await transform(authoredSource, {
    loader: "ts",
    format: "esm",
    target: "es2022",
    sourcemap: false,
    minifyWhitespace: true,
    minifyIdentifiers: false,
    legalComments: "none",
  })).code.trim();
  const contentHash = await capabilityModuleHash(bundle);
  const moduleRef = candidate?.program?.module;
  if (!moduleRef?.contentHash || moduleRef.contentHash !== contentHash) throw new Error("fixture_module_content_hash_mismatch");
  if (moduleRef.exportName !== "capability") throw new Error("fixture_module_export_name_mismatch");
  if (typeof moduleRef.moduleUrl !== "string" || !moduleRef.moduleUrl.includes(contentHash)) throw new Error("fixture_module_url_mismatch");
  if (!Array.isArray(candidate.program.stages) || candidate.program.stages.length === 0) throw new Error("fixture_program_stages_required");
  options.modules?.set(contentHash, bundle);
  if (options.persist) {
    const { putCapabilityV2Module } = await import("../db/capability-center-v2-module-store.ts");
    const stored = await putCapabilityV2Module(options.siteId, bundle);
    if (stored.module.contentHash !== moduleRef.contentHash || stored.module.moduleUrl !== moduleRef.moduleUrl || stored.module.exportName !== moduleRef.exportName) {
      throw new Error("fixture_module_ref_not_production_exact");
    }
  }
  return { authoredSource, bundle, contentHash, sourcePath: fixtureModuleSourcePath };
}

function projectValidationTask(task) {
  return {
    id: task.id,
    siteId: task.siteId,
    source: "System",
    type: "Validation",
    status: task.status,
    runSpec: task.runSpec.candidateValidation,
  };
}

async function classify(input) {
  const modelFixture = await fixtureJson("00-b-model-fixture.json");
  return withModelFixture(modelFixture, async () => {
    const [{ createDiscoveryFromGenerationInput }, { resetCapabilityCenterV2ForTests }] = await Promise.all([
      import("../lib/capability-center-v2/experience-service.ts"),
      import("../db/capability-center-v2-store.ts"),
    ]);
    resetCapabilityCenterV2ForTests();
    return createDiscoveryFromGenerationInput(input.request.siteId || defaultSiteId, input, { autoDispatch: async () => undefined });
  });
}

async function author(input, outputDir) {
  const task = structuredClone(input.task);
  const standaloneInputPath = join(outputDir, ".c1-generation-task.json");
  await mkdir(outputDir, { recursive: true });
  await writeFile(standaloneInputPath, `${JSON.stringify(task, null, 2)}\n`);
  const result = await runC1Mock({ input: standaloneInputPath, outputDir });
  return result.output;
}

async function generateCases(input, options = {}) {
  const [{ chromium }, { runCapabilityCaseGeneration }] = await Promise.all([
    import("playwright"),
    import("../runner/capability-v2/case-generation.ts"),
  ]);
  const [{ completeC2CaseGeneration, resetCapabilityCenterV2ForTests }, { resetCapabilityV2ModulesForTests }] = await Promise.all([
    import("../db/capability-center-v2-store.ts"),
    import("../db/capability-center-v2-module-store.ts"),
  ]);
  const siteId = input.siteId || defaultSiteId;
  resetCapabilityCenterV2ForTests();
  resetCapabilityV2ModulesForTests();
  await prepareFixtureModule(input.candidate, { persist: true, siteId });
  const configuredStart = new URL(input.browser?.startUrl || "");
  if (!/^https?:$/u.test(configuredStart.protocol)) throw new Error("c2_browser_start_url_required");
  const configuredPort = Number(configuredStart.port || (configuredStart.protocol === "https:" ? 443 : 80));
  const modules = new Map();
  const site = await startFixtureSite(modules, configuredPort);
  const casesInput = input.candidate.validationCases || [];
  const timestamp = new Date().toISOString();
  const task = {
    id: input.generationTaskId,
    siteId,
    versionId: `candidate-source-${input.generationTaskId}`,
    type: "Discovery",
    status: "Pending",
    goal: input.candidate.contract.intent || input.candidate.name,
    input: taskInputForCandidate(input.candidate, casesInput[0], input.browser.startUrl),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  let browser;
  let evidenceBytes;
  const execute = async () => {
    browser = await chromium.launch({ headless: true });
    return runCapabilityCaseGeneration(input, {
      browser,
      persistEvidence: async (bytes) => {
        evidenceBytes = Buffer.from(bytes);
        return { artifactRef: `artifact://case-discovery-evidence-${input.generationTaskId}` };
      },
    });
  };
  try {
    // Case generation asks no model: the cases are what the page offered, derived by code.
    const output = await execute();
    if (!evidenceBytes) throw new Error("c2_case_discovery_evidence_missing");
    const evidencePath = resolve(options.outputDir || defaultOutputDir, "03-generate-cases.case-discovery-evidence.json");
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, evidenceBytes);
    const evidenceArtifactId = output.caseDiscoveryEvidenceRef.artifactRef.replace(/^artifact:\/\//u, "");
    const committed = await completeC2CaseGeneration(siteId, task, output, {
      loadCaseDiscoveryArtifact: async (artifactId) => artifactId === evidenceArtifactId ? {
        artifact: { id: artifactId, siteId, taskId: task.id, kind: "CaseDiscoveryEvidence", size: evidenceBytes.byteLength },
        bytes: evidenceBytes,
      } : undefined,
    });
    return { artifact: committed.artifact, validationTask: projectValidationTask(committed.validationTask) };
  } finally {
    await browser?.close().catch(() => undefined);
    await closeServer(site.server);
  }
}

async function validateCandidate(input, outputDir) {
  const siteId = input.siteId || input.validationTask.siteId || defaultSiteId;
  const frozenArtifactInput = input.frozenArtifactFile
    ? await json(resolve(fixtureDir, input.frozenArtifactFile))
    : input;
  const frozenArtifact = frozenArtifactInput.artifact;
  if (!frozenArtifact) throw new Error("c3_frozen_artifact_missing");
  const evidence = input.frozenArtifactFile
    ? await fixtureJson("02-c2-case-discovery-evidence.json")
    : await json(resolve(outputDir, "03-generate-cases.case-discovery-evidence.json"));
  const modules = new Map();
  await prepareFixtureModule(input.artifact.candidate, { modules });
  const site = await startFixtureSite(modules);
  let browser;
  let context;
  try {
    const [{ chromium }, { perform }, { createValidatedCapabilityPackage }] = await Promise.all([
      import("playwright"),
      import("../runner/capability-v2/process-runner.ts"),
      import("../db/capability-center-v2-store.ts"),
    ]);
    const candidateValidation = input.validationTask.runSpec;
    const spec = {
      protocolVersion: "2.0",
      id: crypto.randomUUID(),
      taskId: input.validationTask.id,
      siteId,
      goal: input.artifact.candidate.contract.intent || input.artifact.candidate.name,
      browser: candidateValidation.browser,
      input: taskInputForCandidate(input.artifact.candidate, candidateValidation.cases[0]?.input, site.origin),
      contract: candidateValidation.contract,
      plan: [{ type: "Replay", program: candidateValidation.program }],
      candidateValidation,
    };
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    const page = await context.newPage();
    const result = await perform(page, spec, undefined, {
      persistModule: async () => { throw new Error("c3_must_not_persist_module"); },
      absoluteModuleUrl: (moduleUrl) => new URL(moduleUrl, site.origin).href,
      onEvent: async () => undefined,
      saveArtifact: async () => undefined,
      loadCandidateValidationBundle: async () => ({
        artifact: frozenArtifact,
        evidence,
      }),
    });
    return {
      outcome: "Validated",
      package: createValidatedCapabilityPackage(input.artifact, input.validationTask.id, { outcome: "Success", ...result }),
    };
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await closeServer(site.server);
  }
}

// The verdict is read off the validated package; no model fixture is served.
async function review(input) {
  const [{ authorizeValidatedCandidate }, { createCapabilityTask, resetCapabilityCenterV2ForTests }] = await Promise.all([
    import("../lib/capability-center-v2/coordinator.ts"),
    import("../db/capability-center-v2-store.ts"),
  ]);
  resetCapabilityCenterV2ForTests();
  const artifact = input.package.artifact;
  const created = await createCapabilityTask(input.siteId || defaultSiteId, {
    type: "Validation",
    goal: artifact.candidate.contract.intent || artifact.candidate.name,
    candidateArtifact: artifact,
    input: taskInputForCandidate(artifact.candidate, artifact.validationSuite.cases[0]?.input, artifact.candidate.program.entry.url || `http://localhost:${fixtureSitePort}/`),
  });
  const reviewed = await authorizeValidatedCandidate(created.task.siteId, created.task, input.package);
  if (reviewed.outcome !== "Approved") return reviewed;
  return { validated: input.package, authorization: reviewed.authorization, review: reviewed.review };
}

async function publish(input) {
  const siteId = input.siteId || defaultSiteId;
  const candidate = input.setup?.candidate || input.validated?.artifact?.candidate;
  const validationSuite = input.setup?.validationSuite || input.validated?.artifact?.validationSuite;
  const fixtureValidation = input.setup?.validation || input.validated?.validation;
  const [{ createDiscoveryFromGenerationInput }, store, moduleStore, { capabilityValidationSuiteHash }] = await Promise.all([
    import("../lib/capability-center-v2/experience-service.ts"),
    import("../db/capability-center-v2-store.ts"),
    import("../db/capability-center-v2-module-store.ts"),
    import("../lib/capability-center-v2/case-generation.ts"),
  ]);
  store.resetCapabilityCenterV2ForTests();
  moduleStore.resetCapabilityV2ModulesForTests();
  const storedModule = await prepareFixtureModule(candidate, { persist: true, siteId });
  const classified = await createDiscoveryFromGenerationInput(siteId, {
    request: {
      goal: candidate.contract.intent || candidate.name,
      parameters: validationSuite.cases[0]?.input || {},
      entryUrl: candidate.program.entry.url || `http://localhost:${fixtureSitePort}/`,
      locale: "zh-CN",
    },
    source: "Admin",
    instruction: { operation: "create" },
  }, { autoDispatch: async () => undefined });
  if (classified.disposition !== "Created" || classified.task.status !== "Pending") throw new Error("publish_setup_generation_task_not_created");
  const generationTask = await store.getTask(siteId, classified.task.id, true);
  if (!generationTask) throw new Error("publish_setup_generation_task_missing");
  const runnerId = `publish-setup-generation-${crypto.randomUUID()}`;
  await store.claimTask(siteId, generationTask.id, runnerId);
  const { canonicalCapabilityCaseJson, capabilityCandidateHash } = await import("../lib/capability-center-v2/case-generation.ts");
  const evidenceTemplate = await fixtureJson("02-c2-case-discovery-evidence.json");
  const evidence = {
    ...evidenceTemplate,
    generationTaskId: generationTask.id,
    siteId,
    candidateHash: capabilityCandidateHash(candidate),
    cases: validationSuite.cases.map((testCase) => ({
      caseId: testCase.caseId,
      parameters: Object.entries(testCase.input).map(([inputPath, value]) => {
        const region = evidenceTemplate.regions.find((item) => item.kind === "business-region" && item.observedValues.some((observed) => (
          typeof observed === "string" && typeof value === "string"
            ? observed.normalize("NFKC").toLocaleLowerCase() === value.normalize("NFKC").toLocaleLowerCase()
            : JSON.stringify(observed) === JSON.stringify(value)
        )));
        if (!region) throw new Error(`publish_setup_case_evidence_missing:${inputPath}`);
        const observedValue = region.observedValues.find((observed) => (
          typeof observed === "string" && typeof value === "string"
            ? observed.normalize("NFKC").toLocaleLowerCase() === value.normalize("NFKC").toLocaleLowerCase()
            : JSON.stringify(observed) === JSON.stringify(value)
        ));
        return { inputPath, regionId: region.regionId, observedValue };
      }),
    })),
  };
  const evidenceBytes = new TextEncoder().encode(canonicalCapabilityCaseJson(evidence));
  const storedEvidence = await store.saveTaskArtifact(siteId, generationTask.id, { kind: "CaseDiscoveryEvidence", contentType: "application/json", bytes: evidenceBytes });
  const generated = await store.submitTaskResult(siteId, generationTask.id, runnerId, {
    outcome: "Success",
    candidateProgram: candidate.program,
    candidateSummary: candidate,
    candidateSource: storedModule.authoredSource,
    c1AuthoringOutput: {
      generationTaskId: generationTask.id,
      name: candidate.name,
      description: candidate.description,
      aliases: candidate.aliases,
      contract: candidate.contract,
      program: candidate.program,
      ...(candidate.replacementPlan ? { replacementPlan: candidate.replacementPlan } : {}),
    },
    c2CaseGenerationOutput: {
      generationTaskId: generationTask.id,
      candidate,
      validationSuite,
      caseDiscoveryEvidenceRef: {
        artifactRef: `artifact://${storedEvidence.artifact.id}`,
        contentHash: await sha256Bytes(evidenceBytes),
        byteLength: evidenceBytes.byteLength,
      },
      validationSuiteHash: capabilityValidationSuiteHash(validationSuite),
    },
    output: {},
  });
  if (generated.task.status !== "Succeeded" || !generated.task.result?.validationTaskId) {
    throw new Error(`publish_setup_c2_commit_failed:${generated.task.error?.message || "unknown"}`);
  }
  const validationTask = await store.getTask(siteId, generated.task.result.validationTaskId, true);
  if (!validationTask) throw new Error("publish_setup_validation_task_missing");
  const validationRunnerId = `publish-setup-validation-${crypto.randomUUID()}`;
  await store.claimTask(siteId, validationTask.id, validationRunnerId);
  const validationResults = (fixtureValidation?.cases || []).map((item) => {
    const result = { ...item };
    delete result.outcome;
    return result;
  });
  const validated = await store.submitTaskResult(siteId, validationTask.id, validationRunnerId, {
    outcome: "Success",
    validationCaseCount: validationResults.length,
    validationResults,
    output: validationResults.at(-1)?.output || {},
  });
  const buildResult = validated.task.result?.buildResult;
  if (buildResult?.outcome !== "Validated") throw new Error(`publish_setup_validation_failed:${validated.task.error?.message || "unknown"}`);
  return store.publishValidatedCapability(siteId, {
    generationTaskId: generated.task.id,
    validated: buildResult.package,
    authorization: input.authorization,
  });
}

async function buildOutput(step, input, outputDir, options = {}) {
  if (step.name === "classify") return classify(input);
  if (step.name === "author") return author(input, outputDir);
  if (step.name === "generate-cases") return generateCases(input, { ...options, outputDir });
  if (step.name === "validate") return validateCandidate(input, outputDir);
  if (step.name === "review") return review(input);
  if (step.name === "publish") return publish(input);
  throw new Error(`unknown_module:${step.name}`);
}

export async function runStep(name, options = {}) {
  const step = steps.find((item) => item.name === name);
  if (!step) throw new Error(`unknown_module:${name}`);
  const outputDir = resolve(options.outputDir || defaultOutputDir);
  const fixtureBackedInput = name === "classify" || name === "generate-cases";
  const inputPath = resolve(options.input || (fixtureBackedInput ? resolve(fixtureDir, step.input) : resolve(outputDir, step.input)));
  await access(inputPath).catch(() => { throw new Error(`input_missing:${inputPath}`); });
  const input = await json(inputPath);
  const output = await buildOutput(step, input, outputDir, {
    modelMode: options.modelMode,
  });
  const outputPath = resolve(outputDir, step.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  return {
    inputPath,
    outputPath,
    output,
    moduleSourcePath: fixtureModuleSourcePath,
    ...(name === "generate-cases" ? { caseDiscoveryEvidencePath: resolve(outputDir, "03-generate-cases.case-discovery-evidence.json") } : {}),
  };
}

export async function runAll(options = {}) {
  const results = [];
  for (const step of steps) results.push(await runStep(step.name, options));
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const inputOption = option(args, "--input");
  const outputDirOption = option(args, "--output-dir");
  const name = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--input" && args[index - 1] !== "--output-dir") || "all";
  if (name !== "all" && !inputOption) throw new Error("module_input_required:--input");
  const results = name === "all" ? await runAll({ outputDir: outputDirOption }) : [await runStep(name, { input: inputOption, outputDir: outputDirOption })];
  for (const result of results) {
    console.log(`输入: ${result.inputPath}`);
    console.log(`输出: ${result.outputPath}`);
    if (result.caseDiscoveryEvidencePath) console.log(`页面证据: ${result.caseDiscoveryEvidencePath}`);
    if (result.output?.program?.module?.contentHash) console.log(`contentHash: ${result.output.program.module.contentHash}`);
    if (result.output?.artifact?.candidate?.program?.module?.contentHash) console.log(`contentHash: ${result.output.artifact.candidate.program.module.contentHash}`);
    if (result.output?.candidate?.program?.module?.contentHash || result.output?.artifact?.candidate?.program?.module?.contentHash || result.output?.validated?.artifact?.candidate?.program?.module?.contentHash) {
      console.log(`模块源码: ${result.moduleSourcePath}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
