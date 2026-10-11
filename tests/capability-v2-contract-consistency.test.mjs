import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

async function load(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { inspectContractConsistency, assertContractConsistent, ContractInconsistentError } = await load("../lib/capability-center-v2/contract-consistency.ts");

const contract = (overrides = {}) => ({
  intent: "我想看{{keyword}}热搜",
  inputSchema: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"], additionalProperties: false },
  outputSchema: { type: "object", properties: { targetTitle: { type: "string" }, targetUrl: { type: "string" } }, required: ["targetTitle", "targetUrl"], additionalProperties: false },
  preconditions: [],
  successConditions: [{ type: "inputExists", path: "keyword" }, { type: "outputExists", path: "targetUrl" }],
  ...overrides,
});
const stage = (id, writesOutput) => ({ id, title: id, purpose: id, effect: "read", resumePolicy: "skip-completed", io: { reads: { input: [], state: [] }, writes: { state: [], output: writesOutput } }, navigation: "none" });
const codes = (issues) => issues.map((issue) => issue.code);

test("a consistent Contract has no issues, with or without Stages", () => {
  assert.deepEqual(inspectContractConsistency(contract()), []);
  assert.deepEqual(inspectContractConsistency(contract(), [stage("stage_1", []), stage("stage_verify", ["targetTitle", "targetUrl"])]), []);
  assert.doesNotThrow(() => assertContractConsistent(contract()));
});

test("a success condition on an output the schema does not declare is the pageUrl contradiction", () => {
  const frozen = contract({ successConditions: [{ type: "inputExists", path: "keyword" }, { type: "outputExists", path: "pageUrl" }, { type: "urlIncludes", value: "?q=" }] });
  const issues = inspectContractConsistency(frozen);
  assert.deepEqual(codes(issues), ["condition_output_undeclared"]);
  assert.equal(issues[0].path, "contract.successConditions.1");
  assert.match(issues[0].message, /pageUrl/);
  assert.throws(() => assertContractConsistent(frozen), (error) => {
    assert.ok(error instanceof ContractInconsistentError);
    assert.equal(error.code, "capability_contract_inconsistent");
    assert.equal(error.authorRepairable, false, "no source change can satisfy it");
    assert.equal(error.taskRetryable, true);
    assert.match(error.message, /condition_output_undeclared@contract\.successConditions\.1/);
    return true;
  });
  // outputEquals and nested paths are judged by their root field.
  assert.deepEqual(codes(inspectContractConsistency(contract({ successConditions: [{ type: "outputEquals", path: "pageUrl.href", value: "x" }] }))), ["condition_output_undeclared"]);
});

test("a declared output that no Stage writes is reported only when Stages are known", () => {
  const stages = [stage("stage_1", []), stage("stage_verify", ["targetTitle"])];
  assert.deepEqual(inspectContractConsistency(contract()), []);
  assert.deepEqual(codes(inspectContractConsistency(contract(), stages)), ["condition_output_unwritable"]);
});

test("an open output schema admits any output predicate", () => {
  const open = contract({ outputSchema: { type: "object", properties: {}, additionalProperties: true }, successConditions: [{ type: "outputExists", path: "pageUrl" }] });
  assert.deepEqual(inspectContractConsistency(open), []);
  const bare = contract({ outputSchema: { type: "object" }, successConditions: [{ type: "outputExists", path: "anything" }] });
  assert.deepEqual(inspectContractConsistency(bare), []);
  const closedEmpty = contract({ outputSchema: { type: "object", properties: {}, additionalProperties: false }, successConditions: [{ type: "outputExists", path: "anything" }] });
  assert.deepEqual(codes(inspectContractConsistency(closedEmpty)), ["condition_output_undeclared"]);
});

test("input-side references must exist in the inputSchema", () => {
  const issues = inspectContractConsistency(contract({
    intent: "找{{product}}",
    successConditions: [{ type: "inputExists", path: "query" }, { type: "textTemplate", template: "{{keyword}} {{color}}" }, { type: "urlTemplate", template: "/s?q={{keyword}}" }],
  }));
  assert.deepEqual(codes(issues), ["condition_input_undeclared", "condition_input_undeclared", "condition_input_undeclared"]);
  assert.deepEqual(issues.map((issue) => issue.path), ["contract.intent", "contract.successConditions.0", "contract.successConditions.1"]);
});

test("required fields must be declared and at least one success condition must be executable", () => {
  assert.deepEqual(codes(inspectContractConsistency(contract({ inputSchema: { type: "object", properties: {}, required: ["keyword"] } }))), ["required_input_undeclared", "condition_input_undeclared", "condition_input_undeclared"]);
  assert.deepEqual(codes(inspectContractConsistency(contract({ outputSchema: { type: "object", properties: { a: { type: "string" } }, required: ["b"] }, successConditions: [{ type: "outputExists", path: "a" }] }))), ["required_output_undeclared"]);
  assert.deepEqual(codes(inspectContractConsistency(contract({ successConditions: [{ type: "modelGoal", goal: "looks done" }] }))), ["deterministic_success_condition_required"]);
  assert.deepEqual(inspectContractConsistency(contract({ successConditions: ["search completed"] })), []);
});
