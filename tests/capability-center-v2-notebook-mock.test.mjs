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
  assert.equal(results[2].output.artifact.validationSuite.cases[0].input.query, "notebook");
  assert.equal(results[2].output.artifact.validationSuite.cases[1].input.query, "mug");
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
  await writeFile(wrongInput, JSON.stringify({
    request: { goal: "", normalizedGoal: "搜索商品", parameters: { query: "mug" }, entryUrl: "http://localhost:18081/" },
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
