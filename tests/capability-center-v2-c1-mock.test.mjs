import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runC1Mock } from "../scripts/capability-center-v2-c1-mock.mjs";

async function writeC1Input(outputDir, query = "notebook") {
  const inputPath = join(outputDir, "01-c1-input.json");
  await writeFile(inputPath, JSON.stringify({
    id: "generation_task_notebook_fixture_001",
    siteId: "prestashop_notebook_fixture",
    source: "Episode",
    type: "Discovery",
    status: "Pending",
    runSpec: {
      protocolVersion: "2.0",
      id: "discovery_run_notebook_fixture_001",
      goal: "根据用户提供的关键词在站点内搜索商品并展示结果",
      browser: { startUrl: "http://localhost:18081/", recording: true },
      input: { parameters: { query }, locale: "zh-CN" },
    },
  }));
  return inputPath;
}

test("C1 mock consumes a standalone GenerationTask input", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "capability-c1-mock-"));
  const inputPath = await writeC1Input(outputDir);
  const result = await runC1Mock({ input: inputPath, outputDir });

  assert.deepEqual(Object.keys(result.output).sort(), ["aliases", "contract", "description", "generationTaskId", "name", "program"]);
  assert.equal(result.output.generationTaskId, "generation_task_notebook_fixture_001");
  assert.equal(result.output.contract.inputSchema.properties.query.type, "string");
  assert.deepEqual(result.output.contract.inputSchema.required, ["query"]);
  assert.equal(Object.hasOwn(result.output.contract.inputSchema.properties.query, "default"), false);
  assert.equal(result.output.program.runtime, "BrowserJavaScriptStage");
  assert.equal(result.output.program.module.exportName, "capability");
  assert.match(result.output.program.module.contentHash, /^[a-f0-9]{64}$/u);
  assert.notEqual(result.output.program.module.contentHash, "3".repeat(64));
  assert.equal("dependencyLedger" in result.output.contract, false);
  assert.equal("semantic" in result.output.contract, false);
  assert.equal("semantic" in result.output.program, false);
  assert.equal("entryPolicy" in result.output.program, false);
  assert.equal("demonstrationParameters" in result.output, false);
  assert.equal("groundingExamples" in result.output, false);
  assert.equal("validationCases" in result.output, false);
  assert.equal("caseContextRef" in result.output, false);
  assert.equal("candidateSource" in result.output, false);
  assert.equal("candidateBundle" in result.output, false);
  assert.equal("moduleFiles" in result.output, false);
  await access(result.moduleSourcePath);
  await access(result.moduleBundlePath);
  await assert.rejects(() => access(join(outputDir, "02-author.case-context.json")));
  assert.equal(result.modelCalls?.some((call) => call.schema === "capability_v2_case_generation"), false);
  assert.equal(JSON.stringify(result.output).includes("boundaryEvidence"), false);
});

test("C1 mock rejects a B result envelope instead of reading it implicitly", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "capability-c1-mock-envelope-"));
  const inputPath = join(outputDir, "01-classify.json");
  await writeFile(inputPath, JSON.stringify({
    disposition: "Created",
    task: { id: "generation_task_notebook_fixture_001" },
  }));

  await assert.rejects(() => runC1Mock({ input: inputPath, outputDir }), /c1_mock_input_must_be_generation_task/);
});

test("C1 mock rejects a terminal task instead of bypassing the production task lifecycle", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "capability-c1-mock-wrong-"));
  const inputPath = await writeC1Input(outputDir, "mug");
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  input.status = "Succeeded";
  await writeFile(inputPath, JSON.stringify(input));
  await assert.rejects(() => runC1Mock({ input: inputPath, outputDir }), /c1_mock_generation_task_shape_invalid/);
});

test("C1 mock requires an explicit standalone input path", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "capability-c1-mock-default-"));
  await assert.rejects(() => runC1Mock({ outputDir }), /c1_mock_input_required/);
});
