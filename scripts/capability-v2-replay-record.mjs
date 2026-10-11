#!/usr/bin/env node
/**
 * Record a capability-generation task as an offline replay fixture.
 *
 * The engineering record of every task already holds the model's inputs and
 * outputs (the Discovery trace, the authoring workspace, the task result). This
 * script keeps just the parts the deterministic pipeline needs — contract
 * hardening, the authoring manifest, the quality gates — so a production
 * failure becomes a permanent test in seconds, with no model and no browser:
 *
 *   node scripts/capability-v2-replay-record.mjs \
 *     --task task.json --trace trace.json --workspace c1-workspace.json[.gz] \
 *     [--workspace c2-workspace.json[.gz]] --name shop-search-undeclared-pageurl \
 *     --out tests/fixtures/capability-v2-replays
 *
 * `task.json` is GET /api/capability-v2/tasks/<id>; `trace.json` and the
 * workspace bundles are the task's Trace and Log artifacts. Every model prompt,
 * page snapshot and screenshot stays out of the fixture.
 */
import { gunzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function argument(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === `--${name}`) values.push(process.argv[index + 1]);
  }
  return values;
}
function readJson(path) {
  const bytes = readFileSync(path);
  const text = path.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
  return JSON.parse(text);
}
function workspaceFiles(bundle) {
  return Object.fromEntries((bundle.files || []).map((file) => [file.path, file.content]));
}
function required(value, what) {
  if (value === undefined || value === null) throw new Error(`${what} is missing`);
  return value;
}

const taskPath = required(argument("task")[0], "--task");
const tracePath = argument("trace")[0];
const workspacePaths = argument("workspace");
const name = required(argument("name")[0], "--name");
const outDir = argument("out")[0] || "tests/fixtures/capability-v2-replays";

const taskRecord = readJson(taskPath);
const task = taskRecord.task || taskRecord;
const result = task.result || {};
const fixture = {
  schemaVersion: "capability-v2-replay.v1",
  name,
  taskId: task.id,
  siteId: task.siteId,
  recordedAt: new Date().toISOString(),
  goal: task.goal,
  outcome: { status: task.status, error: task.error?.message || null, cause: task.error?.cause?.message || null },
  expect: {},
};

// Contract freeze: everything assembleCapabilityContract() consumed, from the Discovery trace.
if (tracePath) {
  const trace = readJson(tracePath);
  const design = (trace.events || []).find((event) => event.stage === "contract-design");
  if (design?.request && design?.response) {
    const request = design.request;
    const evidence = request.successEvidence || {};
    fixture.contract = {
      designed: design.response,
      parameterPlan: request.parameterPlan,
      scope: request.scope,
      // The envelope values are not in the trace; only its keys matter to hardening.
      output: Object.fromEntries((request.explorationOutputKeys || []).map((key) => [key, ""])),
      evidence: { url: evidence.url || "", text: evidence.text || "" },
      completionSignals: request.completionSignals || [],
      explorationProgram: request.program,
    };
    fixture.expect.contract = "consistent";
  }
}

// Authoring input and the frozen contract/program/source from the workspaces.
let frozenContract;
let candidateProgram;
let candidateSource;
for (const path of workspacePaths) {
  const files = workspaceFiles(readJson(path));
  if (files["task/authoring-input.json"] && fixture.contract) {
    const authoringInput = JSON.parse(files["task/authoring-input.json"]);
    fixture.contract.startUrl = authoringInput.startUrl;
    fixture.contract.input = authoringInput.input?.parameters || {};
    fixture.contract.frozen = authoringInput.contract;
  }
  if (files["dist/contract.json"]) frozenContract = JSON.parse(files["dist/contract.json"]);
  if (files["dist/program.json"]) candidateProgram = JSON.parse(files["dist/program.json"]);
  if (files["src/capability.ts"]) candidateSource = files["src/capability.ts"];
}

// Candidate gate: what the C2 commit and later gates judged.
const c2 = result.c2CaseGenerationOutput;
const summary = result.candidateSummary;
if (c2 && summary) {
  fixture.candidate = {
    contract: c2.candidate?.contract || frozenContract,
    program: result.candidateProgram || c2.candidate?.program || candidateProgram,
    source: result.candidateSource || candidateSource,
    summary: { name: summary.name, description: summary.description, aliases: summary.aliases },
    demonstrationParameters: result.demonstrationParameters || task.input?.parameters || {},
    validationCases: (c2.validationSuite?.cases || []).map((item) => item.input),
  };
  fixture.expect.candidate = "valid";
}

if (!fixture.contract && !fixture.candidate) throw new Error("nothing to record: no contract-design trace event and no C2 output");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${name}.json`);
writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`recorded ${outPath} (${Object.keys(fixture.expect).join(", ")})`);
