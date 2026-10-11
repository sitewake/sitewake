import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAll, runStep, steps } from "../scripts/capability-center-v2-notebook-mock.mjs";

test("notebook mock flow runs C1 -> C2 -> C3 without a standalone Freeze module", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "capability-notebook-"));
  const results = await runAll({ outputDir });

  assert.equal(results.length, 6);
  assert.deepEqual(steps.map((step) => step.name), ["classify", "author", "generate-cases", "validate", "review", "publish"]);
  assert.equal(results[0].output.task.runSpec.input.parameters.query, "notebook");
  assert.equal(results[1].output.contract.inputSchema.properties.query.type, "string");
  assert.equal("semantic" in results[1].output.contract, false);
  // Three cases now, and which is which matters: the first is the user's own
  // query, the rest are values the fixture page presents. The suite used to hold
  // only the page's values, so this grew a case rather than losing one — a
  // capability is validated against what was asked for as well as against what
  // the page offers. The casing is what shows the difference: the query is
  // lowercase `notebook`, the page says `Notebook`.
  const validationCases = results[2].output.artifact.validationSuite.cases;
  assert.deepEqual(validationCases.map((item) => item.input.query), ["notebook", "Notebook", "Mug"]);
  assert.equal(validationCases[0].input.query, results[0].output.task.runSpec.input.parameters.query,
    "\u7b2c\u4e00\u6761\u7528\u4f8b\u5c31\u662f\u7528\u6237\u539f\u67e5\u8be2");
  assert.notEqual(validationCases[1].input.query, validationCases[0].input.query,
    "\u5176\u4f59\u7528\u4f8b\u53d6\u81ea\u9875\u9762\u5c55\u793a\u503c\uff0c\u4e0d\u662f\u539f\u67e5\u8be2\u7684\u9010\u5b57\u590d\u5236");
  assert.equal(results[2].output.validationTask.status, "Pending");
  assert.equal(results[3].output.outcome, "Validated");
  assert.match(results[4].output.authorization.reviewId, /^capability-v2\.publish-review:[a-f0-9]{64}$/u);
  assert.equal(results[5].output.outcome, "Published");
  for (const index of [2, 3, 4]) {
    const candidate = index === 2
      ? results[index].output.artifact.candidate
      : index === 3
        ? results[index].output.package.artifact.candidate
        : results[index].output.validated.artifact.candidate;
    assert.equal("semantic" in candidate.contract, false);
  }
});

test("a module refuses the wrong upstream JSON", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "capability-notebook-wrong-"));
  const wrongInput = join(outputDir, "wrong.json");
  // `normalizedGoal` is no longer a field of `request`, so leaving it in made the
  // boundary refuse the unknown field before it ever looked at the goal — and the
  // deliberate error here is the empty goal. One wrong thing at a time.
  await writeFile(wrongInput, JSON.stringify({
    request: { goal: "", parameters: { query: "mug" }, entryUrl: "http://localhost:18081/" },
    source: "Admin",
    instruction: { operation: "create" },
  }));
  await assert.rejects(() => runStep("classify", { input: wrongInput, outputDir }), /generation_goal_required/);
});

test("every generated file is readable JSON", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "capability-notebook-json-"));
  const results = await runAll({ outputDir });
  for (const result of results) assert.doesNotThrow(() => JSON.parse(result.output ? JSON.stringify(result.output) : ""));
  for (const result of results) assert.ok((await readFile(result.outputPath, "utf8")).endsWith("\n"));
});
