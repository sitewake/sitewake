/**
 * A publish-review rejection stands only when the facts it cites check out.
 * The lamp fixture is a real server record: the AI reviewer rejected a healthy
 * program by claiming stages 3, 4, 5 and 8 "declare empty io.reads" — stage_8
 * in that program declares and consumes plugType, and stages 3-5 select the
 * goal's fixed facets. Each claim kind the extractor can return is verified
 * deterministically here, in both directions.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// The module under test parses stage sources with the TypeScript compiler,
// which stays a runtime dependency: bundle everything else, resolve
// "typescript" from the repo like any import, and load through a real file
// (a data: URL cannot resolve bare specifiers).
const BUNDLE_PATH = join(ROOT, "tests", ".review-adjudication.bundle.mjs");
{
  const result = await build({
    entryPoints: [join(ROOT, "lib/capability-center-v2/review-adjudication.ts")],
    bundle: true, platform: "node", format: "esm", write: false,
    external: ["typescript"],
  });
  writeFileSync(BUNDLE_PATH, result.outputFiles[0].text);
}
const {
  parseReviewClaims,
  stageInputReads,
  verifyReviewClaims,
  rejectionIsUnsubstantiated,
  REVIEW_REJECTION_UNSUBSTANTIATED,
} = await import(BUNDLE_PATH);
rmSync(BUNDLE_PATH);

const FIXTURE = join(ROOT, "tests/fixtures/review-rejection-lamp");
const lampProgram = JSON.parse(readFileSync(join(FIXTURE, "program.json"), "utf8"));
const lampSource = readFileSync(join(FIXTURE, "source.txt"), "utf8");
const lampContext = JSON.parse(readFileSync(join(FIXTURE, "context.json"), "utf8"));

const lampCtx = {
  program: lampProgram,
  source: lampSource,
  requiredInputs: lampContext.requiredInputs,
  demonstrationParameters: lampContext.demonstrationParameters,
};

test("stageInputReads finds the inputs each stage source actually reads", () => {
  const reads = stageInputReads(lampSource);
  assert.deepEqual([...reads.get("stage_3") || []].sort(), []);
  assert.deepEqual([...reads.get("stage_7") || []].sort(), ["finish"]);
  assert.deepEqual([...reads.get("stage_8") || []].sort(), ["plugType"]);
  // stage_6 declares finish in io but its body never reads it.
  assert.deepEqual([...reads.get("stage_6") || []].sort(), []);
  assert.deepEqual([...reads.get("stage_verify") || []].sort(), ["finish", "plugType"]);
});

test("parseReviewClaims keeps valid claims and normalizes a mistyped kind", () => {
  const claims = parseReviewClaims({
    claims: [
      { kind: "empty_reads_consumes_input", stage: "stage_8", input: "plugType" },
      { kind: "undedeclared_input_read", stage: "stage_3" },
      { kind: "unknown_kind", detail: "vague worry" },
      "not-an-object",
    ],
  });
  assert.deepEqual(claims, [
    { kind: "empty_reads_consumes_input", stage: "stage_8", input: "plugType" },
    { kind: "undeclared_input_read", stage: "stage_3" },
    { kind: "other", detail: "vague worry" },
  ]);
});

test("the lamp rejection's claims do not verify against its program", () => {
  // The claims a faithful extraction of the recorded reason produces.
  const extracted = [
    { kind: "empty_reads_consumes_input", stage: "stage_3", input: "finish" },
    { kind: "empty_reads_consumes_input", stage: "stage_4", input: "finish" },
    { kind: "empty_reads_consumes_input", stage: "stage_5", input: "finish" },
    { kind: "empty_reads_consumes_input", stage: "stage_8", input: "plugType" },
    { kind: "required_input_not_consumed", input: "finish" },
    { kind: "required_input_not_consumed", input: "plugType" },
  ];
  assert.deepEqual(verifyReviewClaims(extracted, lampCtx), []);
});

test("a stage that truly reads an input with empty declared reads verifies", () => {
  const source = [
    "export const capability = {",
    "  version: 2,",
    "  stages: [",
    '    { id: "stage_1", io: {"reads":{"input":[],"state":[]},"writes":{"state":[],"output":[]}},',
    "      async run({ input, fill }) {",
    '        const element = await waitForTarget();',
    '        fill(element, input["finish"]);',
    "      } },",
    "  ],",
    "};",
  ].join("\n");
  const verified = verifyReviewClaims(
    [{ kind: "empty_reads_consumes_input", stage: "stage_1", input: "finish" }],
    { program: { stages: [{ id: "stage_1", io: { reads: { input: [], state: [] }, writes: { state: [], output: [] } } }], parameterRoles: [{ inputPath: "finish", role: "context" }] }, source, requiredInputs: ["finish"] },
  );
  assert.equal(verified.length, 1);
});

test("a stage with declared reads does not verify an empty-reads claim even when it consumes the input", () => {
  const source = [
    "export const capability = {",
    "  version: 2,",
    "  stages: [",
    '    { id: "stage_1", io: {"reads":{"input":["finish"],"state":[]},"writes":{"state":[],"output":[]}},',
    "      async run({ input, fill }) {",
    "        fill(element, input.finish);",
    "      } },",
    "  ],",
    "};",
  ].join("\n");
  const verified = verifyReviewClaims(
    [{ kind: "empty_reads_consumes_input", stage: "stage_1", input: "finish" }],
    { program: { stages: [{ id: "stage_1", io: { reads: { input: ["finish"], state: [] }, writes: { state: [], output: [] } } }], parameterRoles: [{ inputPath: "finish", role: "context" }] }, source, requiredInputs: ["finish"] },
  );
  assert.deepEqual(verified, []);
});

test("a required input the source never consumes verifies, and a consumed one does not", () => {
  const unusedSource = 'export const capability = { stages: [ { id: "stage_1", io: {"reads":{"input":[],"state":[]},"writes":{"state":[],"output":[]}}, async run() {} } ] };';
  const program = { stages: [{ id: "stage_1", io: { reads: { input: [], state: [] }, writes: { state: [], output: [] } } }], parameterRoles: [] };
  assert.equal(verifyReviewClaims([{ kind: "required_input_not_consumed", input: "finish" }], { program, source: unusedSource, requiredInputs: ["finish"] }).length, 1);
  assert.deepEqual(verifyReviewClaims([{ kind: "required_input_not_consumed", input: "finish" }], lampCtx), []);
});

test("an undeclared input read verifies only when the stage reads an input its io does not declare", () => {
  const source = [
    "export const capability = {",
    "  stages: [",
    '    { id: "stage_1", io: {"reads":{"input":[],"state":[]},"writes":{"state":[],"output":[]}},',
    "      async run({ input }) {",
    '        fill(element, input["plugType"]);',
    "      } },",
    "  ],",
    "};",
  ].join("\n");
  const stage = { id: "stage_1", io: { reads: { input: [], state: [] }, writes: { state: [], output: [] } } };
  const declared = { id: "stage_1", io: { reads: { input: ["plugType"], state: [] }, writes: { state: [], output: [] } } };
  const base = { requiredInputs: ["plugType"] };
  assert.equal(verifyReviewClaims([{ kind: "undeclared_input_read", stage: "stage_1", input: "plugType" }], { program: { stages: [stage], parameterRoles: [] }, source, ...base }).length, 1);
  assert.deepEqual(verifyReviewClaims([{ kind: "undeclared_input_read", stage: "stage_1", input: "plugType" }], { program: { stages: [declared], parameterRoles: [] }, source, ...base }), []);
});

test("a demonstrated value baked into executable source verifies; a comment mentioning it does not", () => {
  const hardcoded = [
    "export const capability = {",
    "  stages: [",
    '    { id: "stage_1", io: {"reads":{"input":[],"state":[]},"writes":{"state":[],"output":[]}},',
    "      async run({ fill }) {",
    '        fill(element, "Brass");',
    "      } },",
    "  ],",
    "};",
  ].join("\n");
  const commented = hardcoded.replace('fill(element, "Brass");', '// the demo used Brass\n        fill(element, note);');
  const program = { stages: [{ id: "stage_1", io: { reads: { input: [], state: [] }, writes: { state: [], output: [] } } }], parameterRoles: [{ inputPath: "finish", role: "context" }] };
  const claim = [{ kind: "demonstration_value_hardcoded", input: "finish" }];
  const ctxFor = (source) => ({ program, source, requiredInputs: ["finish"], demonstrationParameters: { finish: "Brass" } });
  assert.equal(verifyReviewClaims(claim, ctxFor(hardcoded)).length, 1);
  assert.deepEqual(verifyReviewClaims(claim, ctxFor(commented)), []);
});

test("a claim about a stage the program does not have does not verify", () => {
  const verified = verifyReviewClaims(
    [{ kind: "empty_reads_consumes_input", stage: "stage_99", input: "finish" }],
    lampCtx,
  );
  assert.deepEqual(verified, []);
});

test("an unverifiable kind never overturns a rejection", () => {
  const verified = verifyReviewClaims(
    [{ kind: "other", detail: "the success condition feels loose" }],
    lampCtx,
  );
  assert.deepEqual(verified, []);
});

test("one validation case does not verify a case-count claim when nothing is target bound", () => {
  const claim = [{ kind: "insufficient_validation_cases" }];
  // The lamp binds no target: finish is context, plugType is a value.
  assert.deepEqual(verifyReviewClaims(claim, { ...lampCtx, validationCaseCount: 1 }), []);
  const targetBound = { ...lampProgram, parameterRoles: [{ inputPath: "productName", role: "target" }] };
  assert.equal(verifyReviewClaims(claim, { ...lampCtx, program: targetBound, validationCaseCount: 1 }).length, 1);
  assert.deepEqual(verifyReviewClaims(claim, { ...lampCtx, program: targetBound, validationCaseCount: 2 }), []);
});

test("a rejection is overturned only when every claim is checkable and disproven", () => {
  const io = { kind: "empty_reads_consumes_input", stage: "stage_8", input: "plugType" };
  const other = { kind: "other", detail: "the output names the wrong product" };
  assert.equal(rejectionIsUnsubstantiated([io], []), true);
  // Something the checker cannot test keeps the rejection, even beside disproven claims.
  assert.equal(rejectionIsUnsubstantiated([io, other], []), false);
  assert.equal(rejectionIsUnsubstantiated([other], []), false);
  // Nothing extracted is nothing disproven.
  assert.equal(rejectionIsUnsubstantiated([], []), false);
  assert.equal(rejectionIsUnsubstantiated([io], [io]), false);
});

test("the canonical unsubstantiated receipt names the overturn, not the program", () => {
  assert.match(REVIEW_REJECTION_UNSUBSTANTIATED, /^ai review approved/);
  assert.match(REVIEW_REJECTION_UNSUBSTANTIATED, /claims do not match the program$/);
});
