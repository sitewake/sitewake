import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityContract, CapabilityExperience, CapabilityGenerationInput, CapabilityProgram, JsonValue } from "../lib/capability-center-v2/model";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const casesDir = resolve(root, "tests/fixtures/capability-classify");
const outputDir = resolve(root, ".artifacts/capability-classify");

type CaseState = { capability?: { name: string; description: string; aliases: string[]; status: "Active" | "Disabled" } };
type CaseInput = CapabilityGenerationInput | { kind: "AuthorizedRepair"; experience: CapabilityExperience };
type Expected = { assertions: Record<string, JsonValue> };

function atPath(value: unknown, path: string): unknown {
  return path.split(".").reduce((current, key) => current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, value);
}

function assertExpected(actual: unknown, expected: Expected) {
  for (const [path, value] of Object.entries(expected.assertions)) {
    const received = atPath(actual, path);
    if (JSON.stringify(received) !== JSON.stringify(value)) {
      throw new Error(`${path}: expected ${JSON.stringify(value)}, received ${JSON.stringify(received)}`);
    }
  }
}

async function seedCapability(siteId: string, state: CaseState, store: typeof import("../db/capability-center-v2-store"), modules: typeof import("../db/capability-center-v2-module-store")) {
  if (!state.capability) return {};
  const source = `export const capability={version:2,stages:[{id:"search",io:{reads:{input:["query"],state:[]},writes:{state:[],output:["query"]}},navigation:"none",async run({input}){return {outcome:"Success",output:{query:String(input.query??"")}}}}]};`;
  const module = (await modules.putCapabilityV2Module(siteId, source)).module;
  const contract: CapabilityContract = {
    intent: "根据用户提供的关键词在站内搜索商品并展示结果列表",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    outputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    preconditions: [{ type: "inputExists", path: "query" }],
    successConditions: [{ type: "outputExists", path: "query" }],
  };
  const created = await store.createCapability(siteId, { ...state.capability, contract });
  const program: CapabilityProgram = {
    schemaVersion: "2.0",
    runtime: "BrowserJavaScriptStage",
    module,
    entry: { mode: "CurrentPage" },
    stages: [{ id: "search", title: "搜索商品", purpose: "按关键词搜索", effect: "read", resumePolicy: "skip-completed", io: { reads: { input: ["query"], state: [] }, writes: { state: [], output: ["query"] } }, navigation: "none" }],
    parameterRoles: [{ inputPath: "query", role: "value" }],
    targetBindings: [],
    promptProvenance: [],
  };
  const draft = await store.createDraftVersion(siteId, created.capability.id, { program, source: "Admin" });
  const validation = await store.createCapabilityTask(siteId, {
    type: "Validation",
    versionId: draft.version.id,
    goal: "测试状态装载",
    input: {
      parameters: { query: "notebook" },
      context: { validationCases: [{ query: "notebook" }, { query: "phone" }] },
      interactions: [],
      trigger: {},
    },
  });
  await store.claimTask(siteId, validation.task.id, "classification-case-loader");
  const validated = await store.submitTaskResult(siteId, validation.task.id, "classification-case-loader", { outcome: "Success", validationCaseCount: 2 });
  if (validated.task.status !== "Succeeded") throw new Error(`state_seed_validation_failed:${validated.task.error?.message || validated.task.status}`);
  await store.publishVersion(siteId, draft.version.id, { adminId: "classification-case-loader", reason: "测试状态装载" });
  if (state.capability.status === "Disabled") await store.actOnCapability(siteId, created.capability.id, "disable");
  return { capabilityId: created.capability.id, versionId: draft.version.id };
}

export async function runClassificationCases() {
  delete process.env.DATABASE_URL;
  delete process.env.S3_BUCKET;
  process.env.CAPABILITY_V2_AUTO_DISPATCH = "0";
  const [{ createDiscoveryFromGenerationInput, createCapabilityFromAuthorizedExperience }, store, modules, { getModelConfig }] = await Promise.all([
    import("../lib/capability-center-v2/experience-service"),
    import("../db/capability-center-v2-store"),
    import("../db/capability-center-v2-module-store"),
    import("../lib/model-config"),
  ]);
  const model = getModelConfig("semantic");
  if (!model.configured) throw new Error("缺少模型 API Key");
  const names = (await readdir(casesDir, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name).sort();
  const results: Array<{ name: string; passed: boolean; statePath: string; inputPath: string; expectedPath: string; outputPath: string; summary: string; error?: string }> = [];
  for (const name of names) {
    const caseDir = resolve(casesDir, name);
    const statePath = resolve(caseDir, "state.json");
    const inputPath = resolve(caseDir, "input.json");
    const expectedPath = resolve(caseDir, "expected.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as CaseState;
    const input = JSON.parse(await readFile(inputPath, "utf8")) as CaseInput;
    const expected = JSON.parse(await readFile(expectedPath, "utf8")) as Expected;
    store.resetCapabilityCenterV2ForTests();
    modules.resetCapabilityV2ModulesForTests();
    const siteId = `classify_case_${name}`;
    const seeded = await seedCapability(siteId, state, store, modules);
    const actual = "kind" in input && input.kind === "AuthorizedRepair"
      ? await createCapabilityFromAuthorizedExperience(siteId, input.experience, {
          version: 1,
          kind: "strengthen",
          evidence: "page-observation-v1",
          siteAgentId: siteId,
          runId: input.experience.agentRunId,
          episodeId: input.experience.episodeId,
          observationRefs: [],
          sourceCapabilityId: seeded.capabilityId,
          sourceVersionId: seeded.versionId,
        })
      : await createDiscoveryFromGenerationInput(siteId, input as CapabilityGenerationInput, { autoDispatch: async () => {} });
    const caseOutputDir = resolve(outputDir, name);
    const outputPath = resolve(caseOutputDir, "output.json");
    await mkdir(caseOutputDir, { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(actual, null, 2)}\n`);
    const summary = actual.disposition === "Created"
      ? `${actual.disposition}/${actual.task.type}`
      : `${actual.disposition}/${actual.match.status || "Matched"}`;
    try {
      assertExpected(actual, expected);
      results.push({ name, passed: true, statePath, inputPath, expectedPath, outputPath, summary });
    } catch (error) {
      results.push({ name, passed: false, statePath, inputPath, expectedPath, outputPath, summary, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

async function main() {
  const results = await runClassificationCases();
  for (const result of results) {
    console.log(`\n${result.passed ? "PASS" : "FAIL"} ${result.name} → ${result.summary}${result.error ? ` - ${result.error}` : ""}`);
    console.log(`  状态: ${result.statePath}`);
    console.log(`  输入: ${result.inputPath}`);
    console.log(`  预期: ${result.expectedPath}`);
    console.log(`  输出: ${result.outputPath}`);
  }
  console.log(`\n汇总: ${results.filter((result) => result.passed).length}/${results.length} 通过`);
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
