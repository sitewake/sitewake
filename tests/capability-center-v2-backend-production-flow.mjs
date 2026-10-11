import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runStep } from "../scripts/capability-center-v2-notebook-mock.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(root, "tests/fixtures/capability-center-v2/notebook-search");
const defaultInput = resolve(fixtureRoot, "00-original-input.json");
const defaultOutputRoot = resolve(root, ".artifacts/capability-center-v2/backend-production-flow");

function relativePath(path) {
  return relative(root, path).replaceAll("\\", "/");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function outputSummary(step, value) {
  if (step === "classify") return { disposition: value.disposition, taskId: value.task?.id, taskType: value.task?.type, taskStatus: value.task?.status };
  if (step === "author") return {
    generationTaskId: value.generationTaskId,
    name: value.name,
    stages: value.program?.stages?.length,
    hasCaseContextRef: Object.hasOwn(value, "caseContextRef"),
    hasGroundingExamples: Object.hasOwn(value, "groundingExamples"),
    hasValidationCases: Object.hasOwn(value, "validationCases"),
    moduleHash: value.program?.module?.contentHash,
  };
  if (step === "generate-cases") return {
    candidateId: value.artifact?.candidateId,
    validationSuiteHash: value.artifact?.validationSuiteHash,
    caseCount: value.artifact?.validationSuite?.cases?.length,
    evidenceHash: value.artifact?.caseDiscoveryEvidenceRef?.contentHash,
    validationTaskId: value.validationTask?.id,
  };
  if (step === "validate") return {
    outcome: value.outcome,
    validationTaskId: value.package?.validationTaskId,
    caseCount: value.package?.validation?.cases?.length,
    candidateId: value.package?.artifact?.candidateId,
  };
  if (step === "review") return {
    authorization: value.authorization?.mode,
    reviewDecision: value.review?.decision || value.review?.status,
    candidateId: value.validated?.artifact?.candidateId,
  };
  if (step === "publish") return {
    outcome: value.outcome,
    capabilityId: value.capability?.id,
    versionId: value.version?.id,
  };
  return {};
}

function htmlReport(report) {
  const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const rows = report.steps.map((step) => `<tr><td>${escape(step.order)}</td><td>${escape(step.module)}</td><td><code>${escape(step.inputPath)}</code></td><td><code>${escape(step.outputPath)}</code></td><td class="pass">PASS</td><td><details><summary>摘要</summary><pre>${escape(JSON.stringify(step.output, null, 2))}</pre></details></td></tr>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>Capability Center V2 Backend Production Flow</title><style>body{font:14px system-ui;margin:32px;color:#1d2c25;background:#f5f8f6}table{border-collapse:collapse;width:100%;background:#fff}th,td{padding:9px;border-bottom:1px solid #dce7e0;text-align:left;vertical-align:top}.pass{color:#087763;font-weight:700}code,pre{font-family:ui-monospace,monospace}pre{max-width:620px;max-height:360px;overflow:auto;white-space:pre-wrap;color:#d9ece4;background:#12231c;padding:10px;border-radius:7px}details summary{cursor:pointer;color:#176b59;font-weight:700}</style><h1>Capability Center V2 后端正式链路</h1><p><b>${report.status}</b> · ${escape(report.chain.join(" → "))} · model=${escape(report.modelMode)}</p><p>${escape(report.notes)}</p><table><thead><tr><th>顺序</th><th>模块</th><th>显式输入</th><th>输出</th><th>状态</th><th>输出摘要</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export async function runBackendProductionFlow(options = {}) {
  const inputPath = resolve(options.input || defaultInput);
  const outputDir = resolve(options.outputDir || resolve(defaultOutputRoot, new Date().toISOString().replace(/[:.]/gu, "-")));
  await mkdir(outputDir, { recursive: true });

  const steps = [];
  const record = async (order, module, name, input, run) => {
    const result = await runStep(name, { input, outputDir });
    steps.push({
      order,
      module,
      inputPath: relativePath(result.inputPath),
      outputPath: relativePath(result.outputPath),
      productionEntrypoint: {
        B: "lib/capability-center-v2/experience-service.ts#createDiscoveryFromGenerationInput",
        C1: "runner/capability-v2/process-runner.ts#performC1Authoring",
        C2: "runner/capability-v2/case-generation.ts#runCapabilityCaseGeneration + db/capability-center-v2-store.ts#completeC2CaseGeneration",
        C3: "runner/capability-v2/process-runner.ts#perform",
        Review: "lib/capability-center-v2/coordinator.ts#authorizeValidatedCandidate",
        D: "db/capability-center-v2-store.ts#publishValidatedCapability",
      }[module],
      model: ["B", "C1", "C2", "Review"].includes(module) ? "HTTP fixture response only" : "not called",
      output: outputSummary(name, result.output),
      result,
    });
    return result;
  };

  // B is the only module that receives the original Episode input.
  const classified = await record(1, "B", "classify", inputPath, async () => undefined);
  assert.equal(classified.output.disposition, "Created");

  // C1 consumes B's formal task. Its output is intentionally only Candidate data.
  const authored = await record(2, "C1", "author", classified.outputPath, async () => undefined);
  const authorOutput = await readJson(authored.outputPath);
  assert.equal(Object.hasOwn(authorOutput, "caseContextRef"), false);
  assert.equal(Object.hasOwn(authorOutput, "groundingExamples"), false);
  assert.equal(Object.hasOwn(authorOutput, "validationCases"), false);

  // C2 is independently executable: persist a standalone input JSON, but use
  // the Candidate that C1 just produced for this full-flow run.
  const c2Base = await readJson(resolve(fixtureRoot, "02-c2-input.json"));
  const c2Input = {
    ...c2Base,
    generationTaskId: authorOutput.generationTaskId,
    siteId: authorOutput.siteId || c2Base.siteId,
    candidate: {
      name: authorOutput.name,
      description: authorOutput.description,
      aliases: authorOutput.aliases,
      contract: authorOutput.contract,
      program: authorOutput.program,
      ...(authorOutput.replacementPlan ? { replacementPlan: authorOutput.replacementPlan } : {}),
    },
  };
  const c2InputPath = resolve(outputDir, "02-c2-input.flow.json");
  await writeFile(c2InputPath, `${JSON.stringify(c2Input, null, 2)}\n`, "utf8");
  const generated = await record(3, "C2", "generate-cases", c2InputPath, async () => undefined);
  assert.ok(generated.output.artifact?.candidateId);
  assert.ok(generated.output.validationTask?.id);

  const validated = await record(4, "C3", "validate", generated.outputPath, async () => undefined);
  assert.equal(validated.output.outcome, "Validated");

  const reviewed = await record(5, "Review", "review", validated.outputPath, async () => undefined);
  assert.equal(reviewed.output.authorization?.mode, "AIApproved");

  const published = await record(6, "D", "publish", reviewed.outputPath, async () => undefined);
  assert.equal(published.output.outcome, "Published");

  const report = {
    schemaVersion: "capability-v2-backend-production-flow-report.v1",
    status: "PASS",
    modelMode: "mock-http-production-code",
    inputPath: relativePath(inputPath),
    generatedAt: new Date().toISOString(),
    chain: steps.map((step) => step.module),
    notes: "B/C1/C2/C3/Review/D 均通过正式生产入口；模型只替换 HTTP 返回，C2 页面探索、证据侧车、门禁、内部 Artifact 提交、C3 确定性执行和 D 发布持久化逻辑没有替换。该测试不是前端 Agent E2E。",
    steps: steps.map(({ result, ...step }) => step),
  };
  await writeFile(resolve(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(resolve(outputDir, "report.html"), htmlReport(report), "utf8");
  return { report, outputDir };
}

async function main() {
  const args = process.argv.slice(2);
  const result = await runBackendProductionFlow({ input: option(args, "--input"), outputDir: option(args, "--output-dir") });
  console.log(`Backend production flow: ${result.report.status}`);
  console.log(`链路: ${result.report.chain.join(" -> ")}`);
  console.log(`JSON: ${relativePath(resolve(result.outputDir, "report.json"))}`);
  console.log(`HTML: ${relativePath(resolve(result.outputDir, "report.html"))}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
