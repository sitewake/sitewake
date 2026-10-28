/**
 * The verdict on a validated candidate is read off its validation record.
 * Each rule is a defect a published capability once carried: the demonstrated
 * case that did not pass, the cushion the cart "had no row matching", the
 * category count that answered every category with the Poetry page, the
 * demonstrated value written into the source. No model is asked.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// The module under test reaches the quality rules, which parse stage sources
// with the TypeScript compiler; that stays a runtime dependency: bundle
// everything else, resolve "typescript" from the repo like any import, and
// load through a real file (a data: URL cannot resolve bare specifiers).
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
  classifyValidationCase,
  validationCaseFloor,
  validationVerdict,
  hardcodedDemonstrationInputs,
  REVIEW_APPROVED_ON_VALIDATION,
  REVIEW_DEMONSTRATION_CASE_FAILED,
  REVIEW_DEMONSTRATION_CASE_NO_RESULT,
  REVIEW_DEMONSTRATION_VALUE_LEAKED,
  REVIEW_OFFERED_INPUT_NO_RESULT,
  REVIEW_NO_CASE_PASSED,
} = await import(BUNDLE_PATH);
rmSync(BUNDLE_PATH);

// A real server record: a lamp shop's filter program and the values it was taught with.
const FIXTURE = join(ROOT, "tests/fixtures/review-rejection-lamp");
const lampSource = readFileSync(join(FIXTURE, "source.txt"), "utf8");

// Recorded on the demo store: the cases asked the room filter for product names.
const OPTION_MISSING_FAILURE = "page.evaluate: Error: capability_stage_select_option_missing:stage_3:Lune Table Lamp; options: Any | Living room | Bedroom | Home office | Dining\n    at eval (eval at evaluate (:303:30), <anonymous>:1:5092)";
const roomResults = [
  { caseId: "case_1", resolvedInput: { roomContext: "Home office" } },
  { caseId: "case_2", resolvedInput: { roomContext: "Lune Table Lamp" }, failureReason: OPTION_MISSING_FAILURE },
];

test("a case whose input the page does not offer is bad test data, not a failed program", () => {
  const demonstration = { roomContext: "Home office" };
  assert.deepEqual(classifyValidationCase(roomResults[1], demonstration), {
    outcome: "InputNotOffered",
    offered: ["Any", "Living room", "Bedroom", "Home office", "Dining"],
  });
  assert.equal(classifyValidationCase(roomResults[0], demonstration).outcome, "Passed");
  // The demonstrated value missing is a real failure: the site offered it when it was taught.
  assert.equal(classifyValidationCase(roomResults[1], { roomContext: "Lune Table Lamp" }).outcome, "Failed");
  assert.equal(classifyValidationCase({ caseId: "x", resolvedInput: { roomContext: "Bedroom" }, failureReason: "TypeError: cannot read properties of null" }, demonstration).outcome, "Failed");
});

test("the demonstration's own case must pass; nothing lowers that floor", () => {
  const demonstration = { roomContext: "Home office" };
  assert.equal(validationCaseFloor(roomResults, demonstration), undefined);
  const broken = [{ ...roomResults[0], failureReason: "capability_stage_fill_target_missing:stage_2" }, roomResults[1]];
  assert.deepEqual(validationCaseFloor(broken, demonstration), {
    reason: REVIEW_DEMONSTRATION_CASE_FAILED, caseId: "case_1", failure: "capability_stage_fill_target_missing:stage_2",
  });
  assert.deepEqual(validationCaseFloor([roomResults[1]], undefined), { reason: REVIEW_NO_CASE_PASSED });
});

test("the demonstrated case finding nothing is a failure when the visitor's run found a result", () => {
  // "Add product to cart" was proven with one cushion, said "cart has no row
  // matching" for that very cushion on replay, and was published on that.
  const demonstration = { roomContext: "Home office" };
  const nothing = [{ caseId: "case_1", resolvedInput: { roomContext: "Home office" }, noResultReason: "cart has no row matching \"Home office\"" }, roomResults[1]];
  assert.deepEqual(validationCaseFloor(nothing, demonstration, "Success"), {
    reason: REVIEW_DEMONSTRATION_CASE_NO_RESULT, caseId: "case_1", failure: "cart has no row matching \"Home office\"",
  });
  // A run the visitor saw end with nothing is reproduced by nothing; a record that does not say is not held to it.
  assert.equal(validationCaseFloor(nothing, demonstration, "NoResult"), undefined);
  assert.equal(validationCaseFloor(nothing, demonstration), undefined);
});

test("a case that found nothing for a value the site lists beside the demonstrated one fails the floor", () => {
  // "Count books in category" was published on Poetry alone; asked for
  // Mystery, a category in the same list, it opened the Poetry page and said
  // the page was not Mystery.
  const demonstration = { roomContext: "Home office" };
  const listed = [roomResults[0], { caseId: "case_2", resolvedInput: { roomContext: "Bedroom" }, failureReason: "no_result_for_offered_input:roomContext=\"Bedroom\":Category page shows \"Home office\", not \"Bedroom\"" }];
  assert.deepEqual(validationCaseFloor(listed, demonstration), {
    reason: REVIEW_OFFERED_INPUT_NO_RESULT, caseId: "case_2", failure: "no_result_for_offered_input:roomContext=\"Bedroom\":Category page shows \"Home office\", not \"Bedroom\"",
  });
  assert.equal(classifyValidationCase(listed[1], demonstration).outcome, "Failed");
  // Nothing found for a value the page never listed is still the capability answering.
  assert.equal(validationCaseFloor([roomResults[0], { caseId: "case_2", resolvedInput: { roomContext: "Attic" }, noResultReason: "no such room" }], demonstration), undefined);
});

test("a demonstrated value written into executable source is found without a model; one in a comment is not", () => {
  const leaked = lampSource.replace('fill(element, input["plugType"]);', 'fill(element, "US plug (Type A/B)");');
  assert.notEqual(leaked, lampSource);
  const demonstration = { finish: "Brass", plugType: "US plug (Type A/B)" };
  assert.deepEqual(hardcodedDemonstrationInputs(lampSource, demonstration, ["finish", "plugType"]), []);
  assert.deepEqual(hardcodedDemonstrationInputs(leaked, demonstration, ["finish", "plugType"]), ["plugType"]);
  const commented = lampSource.replace('fill(element, input["plugType"]);', '// demo used "US plug (Type A/B)"\n        fill(element, input["plugType"]);');
  assert.deepEqual(hardcodedDemonstrationInputs(commented, demonstration, ["finish", "plugType"]), []);
});

// Recorded on the demo store: the dropdown's accessible name runs its options
// together, and the locator copied from the recording carries it. Read as a
// leaked "Floor lamp", it cost a working shop filter its whole authoring budget.
test("a value fused into a longer label is not hardcoded; a value used as data is", () => {
  const locator = 'const element = await waitForTarget({strategies:[{type:"role",role:"combobox",name:"AnyTable lampFloor lampPendantWall light",match:"exact"}]});\nfill(element, input["productType"]);';
  assert.deepEqual(hardcodedDemonstrationInputs(locator, { productType: "Floor lamp" }, ["productType"]), []);
  assert.deepEqual(hardcodedDemonstrationInputs('fill(element, "Floor lamp");', { productType: "Floor lamp" }, ["productType"]), ["productType"]);
  assert.deepEqual(hardcodedDemonstrationInputs('go(`/shop?type=Floor lamp`);', { productType: "Floor lamp" }, ["productType"]), ["productType"]);
  assert.deepEqual(hardcodedDemonstrationInputs('const note = "Brassware";', { finish: "Brass" }, ["finish"]), []);
});

// capability-center/generation: the verdict is the floor over the cases and
// the source checked for a demonstrated value; approval is its own receipt.
test("the verdict approves on the record alone and names what it rejects for", () => {
  const demonstration = { category: "Travel" };
  const passed = [
    { caseId: "case_1", resolvedInput: { category: "Travel" } },
    { caseId: "case_2", resolvedInput: { category: "Poetry" } },
  ];
  assert.deepEqual(validationVerdict({ results: passed, demonstrationParameters: demonstration, demonstrationOutcome: "Success", source: 'click(find({ name: input["category"] }));', requiredInputs: ["category"] }), {
    decision: "Approved", reason: REVIEW_APPROVED_ON_VALIDATION,
  });
  // The floor speaks first, with the case it is about.
  const offered = [passed[0], { caseId: "case_2", resolvedInput: { category: "Mystery" }, failureReason: "no_result_for_offered_input:category=\"Mystery\":Category page shows \"Travel\"" }];
  const rejected = validationVerdict({ results: offered, demonstrationParameters: demonstration, source: 'click(find({ name: "Travel" }));', requiredInputs: ["category"] });
  assert.equal(rejected.decision, "Rejected");
  assert.equal(rejected.reason, REVIEW_OFFERED_INPUT_NO_RESULT);
  assert.equal(rejected.caseId, "case_2");
  // With the floor holding, the source is read for the demonstrated value.
  assert.deepEqual(validationVerdict({ results: passed, demonstrationParameters: demonstration, source: 'click(find({ name: "Travel" }));', requiredInputs: ["category"] }), {
    decision: "Rejected", reason: REVIEW_DEMONSTRATION_VALUE_LEAKED, inputs: ["category"],
  });
  // Without the source (a version whose generation left none) the leak check has nothing to read and does not reject.
  assert.equal(validationVerdict({ results: passed, demonstrationParameters: demonstration, requiredInputs: ["category"] }).decision, "Approved");
});
