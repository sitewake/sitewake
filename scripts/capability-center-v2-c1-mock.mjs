import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = resolve(root, "tests/fixtures/capability-center-v2/notebook-search");
const defaultOutputDir = resolve(root, ".artifacts/capability-center-v2/notebook-search");
const sitePort = 0;

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function jsonResponse(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function listen(server, port) {
  return new Promise((resolvePromise, reject) => {
    const onError = (error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolvePromise(server.address()); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
}

export async function startFixtureSite(modules, port = sitePort) {
  const home = await readFile(join(fixtureDir, "c1-site/home.html"), "utf8");
  const search = await readFile(join(fixtureDir, "c1-site/search.html"), "utf8");
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    const moduleMatch = requestUrl.pathname.match(/^\/api\/capability-v2\/modules\/([a-f0-9]{64})$/u);
    if (moduleMatch) {
      const source = modules.get(moduleMatch[1]);
      if (!source) return response.writeHead(404).end();
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return response.end(source);
    }
    if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end(home);
    }
    if (requestUrl.pathname === "/search") {
      const query = requestUrl.searchParams.get("s") || requestUrl.searchParams.get("query") || "";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end(search.replaceAll("{{query}}", escapeHtml(query)));
    }
    response.writeHead(404).end();
  });
  const address = await listen(server, port);
  const actualPort = typeof address === "object" && address ? address.port : port;
  return { server, origin: `http://localhost:${actualPort}` };
}

async function startModelFixtureServer(modelFixture) {
  const state = { explorerActionIndex: 0, authorToolIndex: 0, calls: [] };
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) return response.writeHead(404).end();
    try {
      const body = await requestBody(request);
      state.calls.push({ hasTools: Array.isArray(body.tools) && body.tools.length > 0, schema: body.response_format?.json_schema?.name });
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        const tool = state.authorToolIndex === 0 ? modelFixture.author.writeFile : modelFixture.author.runDraft;
        state.authorToolIndex += 1;
        if (!tool) throw new Error("c1_model_fixture_author_tool_missing");
        const argumentsValue = { ...(tool.arguments || {}) };
        if (tool.path) argumentsValue.path = tool.path;
        if (tool.contentFile) argumentsValue.content = await readFile(resolve(fixtureDir, tool.contentFile), "utf8");
        const name = state.authorToolIndex === 1 ? "write_file" : "run_draft";
        return jsonResponse(response, 200, {
          choices: [{
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: `c1_fixture_tool_${state.authorToolIndex}`, type: "function", function: { name, arguments: JSON.stringify(argumentsValue) } }],
            },
          }],
        });
      }

      const schemaName = body.response_format?.json_schema?.name;
      let result;
      if (schemaName === "capability_v2_specification") result = modelFixture.parameterPlan;
      else if (schemaName === "capability_v2_explorer_action") {
        result = modelFixture.explorerActions[state.explorerActionIndex];
        state.explorerActionIndex += 1;
      } else if (schemaName === "capability_v2_contract") result = modelFixture.contractDesign;
      else throw new Error(`c1_model_fixture_schema_unknown:${schemaName || "missing"}`);
      if (!result) throw new Error(`c1_model_fixture_response_missing:${schemaName}`);
      return jsonResponse(response, 200, { choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(result) } }] });
    } catch (error) {
      jsonResponse(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  const address = await listen(server, 0);
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}/v1`, state };
}

function snapshotEnvironment(names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(snapshot) {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/**
 * The recording a visitor of the fixture site would have left: the query
 * typed into the search box and submitted, ending on the results page. A
 * generation task carries its own recording; the standalone fixture input
 * carries only the parameters, so this stands in for it.
 */
function recordedSearch(task, startUrl) {
  const origin = startUrl.replace(/\/$/u, "");
  const query = String(task.runSpec.input.parameters.query ?? "");
  const at = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    episodeId: "episode_notebook_fixture",
    agentRunId: "run_notebook_fixture",
    browserSessionId: "browser_notebook_fixture",
    originalGoal: task.runSpec.goal,
    outcome: "Success",
    outcomeSummary: `Search results for "${query}"`,
    answer: `Search results for "${query}"`,
    startedAt: at,
    endedAt: at,
    startPage: { url: `${origin}/`, title: "Product search" },
    // The fixture module reaches the results the way the PrestaShop-shaped
    // original did (`controller=search&s=`); the mock site answers both.
    endPage: { url: `${origin}/search?controller=search&s=${encodeURIComponent(query)}`, title: "Search results" },
    actions: [{
      action: "fill", rawAction: "input_text", input: { index: 1, text: `${query}\n` },
      element: { tag: "input", role: "searchbox", accessibleName: "Search products", name: "query", landmark: "main" },
      page: { url: `${origin}/`, title: "Product search" }, observedAt: at,
    }],
    output: {},
  };
}

function taskInputFromGenerationTask(task, startUrl) {
  const seed = task.runSpec.input.capabilitySeed;
  return {
    parameters: task.runSpec.input.parameters,
    context: {
      startUrl,
      ...(task.runSpec.input.locale ? { locale: task.runSpec.input.locale } : {}),
      __pipelineVersion: "2.0",
    },
    interactions: [],
    trigger: {},
    experience: task.runSpec.input.experience || recordedSearch(task, startUrl),
    ...(seed ? {
      candidateSummary: { name: seed.name, description: seed.description, aliases: seed.aliases },
    } : {}),
  };
}

function assertC1Input(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.task || input.disposition) {
    throw new Error("c1_mock_input_must_be_generation_task");
  }
  if (typeof input.id !== "string" || !input.id.trim()) throw new Error("c1_mock_generation_task_id_missing");
  if ((input.source !== "Episode" && input.source !== "Admin")
    || (input.type !== "Discovery" && input.type !== "Repair")
    || input.status !== "Pending") {
    throw new Error("c1_mock_generation_task_shape_invalid");
  }
  if (input.runSpec?.protocolVersion !== "2.0"
    || !input.runSpec.input?.parameters
    || typeof input.runSpec.input.parameters !== "object"
    || Array.isArray(input.runSpec.input.parameters)) throw new Error("c1_mock_generation_task_run_spec_invalid");
  if (!input.runSpec.goal || typeof input.runSpec.goal !== "string") throw new Error("generation_task_goal_required");
  const browser = input.runSpec.browser;
  if (!browser || typeof browser !== "object" || Object.keys(browser).some((key) => !["startUrl", "recording"].includes(key))) throw new Error("generation_task_browser_unknown_field");
  if (typeof browser.startUrl !== "string" || typeof browser.recording !== "boolean") throw new Error("c1_mock_generation_task_browser_invalid");
  const serialized = JSON.stringify(input.runSpec?.input || {});
  if (serialized.includes("boundaryEvidence")) throw new Error("c1_mock_boundary_evidence_forbidden");
}

async function runC1(options = {}, modelMode = "mock") {
  if (!options.input) throw new Error("c1_mock_input_required");
  const inputPath = resolve(options.input);
  const outputDir = resolve(options.outputDir || defaultOutputDir);
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  assertC1Input(input);

  const environmentNames = ["MODEL_API_KEY", "MODEL_BASE_URL", "MODEL", "MODEL_EXECUTION", "MODEL_SEMANTIC", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"];
  const environment = modelMode === "mock" ? snapshotEnvironment(environmentNames) : undefined;
  const modules = new Map();
  const site = await startFixtureSite(modules);
  const model = modelMode === "mock"
    ? await startModelFixtureServer(JSON.parse(await readFile(join(fixtureDir, "01-c1-model-fixture.json"), "utf8")))
    : undefined;
  if (model) {
    process.env.OPENAI_API_KEY = "capability-v2-c1-fixture";
    process.env.OPENAI_BASE_URL = model.baseUrl;
    process.env.OPENAI_MODEL = "capability-v2-c1-fixture";
    // MODEL_* outranks OPENAI_*; clear it so the fixture is what the run sees.
    for (const name of ["MODEL_API_KEY", "MODEL_BASE_URL", "MODEL", "MODEL_EXECUTION", "MODEL_SEMANTIC"]) delete process.env[name];
  }

  let browser;
  let context;
  try {
    const [{ chromium }, { performC1Authoring }, { capabilityModuleHash }, { getModelConfig }] = await Promise.all([
      import("playwright"),
      import("../runner/capability-v2/process-runner.ts"),
      import("../lib/capability-center-v2/javascript-runtime.ts"),
      import("../lib/model-config.ts"),
    ]);
    const modelConfig = getModelConfig("execution");
    if (!modelConfig.configured) throw new Error("c1_real_model_not_configured:请在 .env.local 配置模型 API Key、Base URL 和模型名");
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    const page = await context.newPage();
    const physicalInput = taskInputFromGenerationTask(input, site.origin);
    const events = [];
    const spec = {
      protocolVersion: "2.0",
      id: input.runSpec.id,
      taskId: input.id,
      siteId: input.siteId,
      goal: input.runSpec.goal,
      browser: { startUrl: site.origin, recording: false },
      input: physicalInput,
      plan: [{ type: "Explore" }, { type: "Evaluate", conditions: [] }],
    };
    const result = await performC1Authoring(page, spec, (event) => events.push(event), {
      persistModule: async (source) => {
        const normalized = source.replace(/\r\n/g, "\n").trim();
        const contentHash = await capabilityModuleHash(normalized);
        modules.set(contentHash, normalized);
        return { contentHash, moduleUrl: `/api/capability-v2/modules/${contentHash}?siteId=${encodeURIComponent(input.siteId)}`, exportName: "capability" };
      },
      absoluteModuleUrl: (moduleUrl) => new URL(moduleUrl, site.origin).href,
      onEvent: async (phase, message, payload) => { events.push({ stage: phase, response: { message, ...(payload || {}) } }); },
      saveArtifact: async (kind) => { throw new Error(`c1_artifact_forbidden:${kind}`); },
    });
    const output = result.c1AuthoringOutput;
    if (!output?.contract || !output.program || !result.candidateSource || !result.candidateBundle) throw new Error("c1_real_authoring_output_incomplete");
    if ("caseContextRef" in output || "validationCases" in output || "groundingExamples" in output) throw new Error("c1_output_contains_c2_data");
    const outputPath = resolve(outputDir, "02-author.json");
    const moduleSourcePath = resolve(outputDir, "02-author.module.ts");
    const moduleBundlePath = resolve(outputDir, "02-author.bundle.js");
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(moduleSourcePath, `${result.candidateSource.trim()}\n`);
    await writeFile(moduleBundlePath, `${result.candidateBundle.trim()}\n`);
    if (output.program.module.contentHash === "3".repeat(64)) throw new Error("c1_real_module_hash_placeholder");
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
    return {
      inputPath,
      outputPath,
      moduleSourcePath,
      moduleBundlePath,
      output,
      outputDir,
      events,
      modelCalls: model?.state.calls,
      model: { source: modelConfig.source, model: modelConfig.model },
    };
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await new Promise((resolvePromise) => site.server.close(() => resolvePromise()));
    if (model) await new Promise((resolvePromise) => model.server.close(() => resolvePromise()));
    if (environment) restoreEnvironment(environment);
  }
}

export function runC1Mock(options = {}) {
  return runC1(options, "mock");
}

export function runC1Real(options = {}) {
  return runC1(options, "real");
}

async function main() {
  const args = process.argv.slice(2);
  const result = await runC1Mock({ input: option(args, "--input"), outputDir: option(args, "--output-dir") });
  console.log("C1 Mock: PASS");
  console.log(`输入: ${result.inputPath}`);
  console.log(`输出: ${result.outputPath}`);
  console.log(`源码: ${result.moduleSourcePath}`);
  console.log(`Bundle: ${result.moduleBundlePath}`);
  console.log(`generationTaskId: ${result.output.generationTaskId}`);
  console.log(`contentHash: ${result.output.program.module.contentHash}`);
  console.log(`Contract: ${result.output.name}`);
  console.log(`Program stages: ${result.output.program.stages.length}`);
  console.log(`模型: ${result.model.source}/${result.model.model}`);
  console.log(`模型调用次数: ${result.modelCalls?.length || 0}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
