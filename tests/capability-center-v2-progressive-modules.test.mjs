import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CAPABILITY_CASE_DERIVATION_MAX_CASES, capabilityValidationSuiteHash } from "../lib/capability-center-v2/case-generation.ts";
import { runStep } from "../scripts/capability-center-v2-notebook-mock.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = resolve(root, "tests/fixtures/capability-center-v2/notebook-search");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

function hashJson(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function assertCompactSemantic(candidate) {
  assert.equal("semantic" in candidate.contract, false);
  assert.equal(candidate.contract.scope.kind, "site-global");
  assert.equal(candidate.contract.scope.onMismatch, "no-match");
  assert.equal("generalizable" in candidate.contract.scope, false);
  assert.equal("entryPolicy" in candidate.contract, false);
}

const cases = [
  {
    module: "generate-cases",
    input: "02-c2-input.json",
    output: "03-c2-output.json",
    assertOutput: (output) => {
      assert.deepEqual(Object.keys(output).sort(), ["artifact", "validationTask"]);
      assert.match(output.artifact.candidateId, /^[0-9a-f-]{36}$/u);
      assert.equal(output.artifact.candidate.program.module.contentHash, "ff10dddf810fc22ca21be9161f987611c399000d363c7966c3f5af6e501a260a");
      // A literal hash here pins the suite's contents, so it went stale the moment
      // the suite gained a case — the user's own query is now validated alongside
      // the page's values. What has to hold is that the recorded hash is the
      // canonical hash of the suite actually carried, which is what makes it
      // usable as an identity downstream.
      assert.equal(
        output.artifact.validationSuiteHash,
        capabilityValidationSuiteHash({ cases: output.artifact.validationSuite.cases }),
        "\u8bb0\u5f55\u7684\u54c8\u5e0c\u5fc5\u987b\u662f\u5f53\u524d\u5957\u4ef6\u7684\u89c4\u8303\u54c8\u5e0c",
      );
      assert.match(output.artifact.validationSuiteHash, /^sha256:[0-9a-f]{64}$/u);
      // The suite is capped at CAPABILITY_CASE_DERIVATION_MAX_CASES (3), and it
      // now leads with the user's own query. That is a trade: validating what was
      // actually asked for costs one page-derived case, and the one displaced here
      // was `Hardcover ruled notebook` — the most specific of them. Worth knowing
      // when judging how varied the validated inputs are.
      assert.deepEqual(output.artifact.validationSuite.cases.map((item) => item.input.query), ["notebook", "Notebook", "Mug"]);
      assert.equal(output.artifact.validationSuite.cases.length, CAPABILITY_CASE_DERIVATION_MAX_CASES);
      assert.deepEqual(output.artifact.validationSuite.cases[2].expected, { query: "Mug" });
      assert.deepEqual(output.validationTask.runSpec.caseDiscoveryEvidenceRef, output.artifact.caseDiscoveryEvidenceRef);
      assert.equal(output.validationTask.runSpec.validationSuiteHash, output.artifact.validationSuiteHash);
      assert.equal(output.validationTask.runSpec.browser.isolation, "FreshContextPerCase");
      assertCompactSemantic(output.artifact.candidate);
    },
  },
  {
    module: "validate",
    input: "04-c3-input.json",
    output: "04-c3-output.json",
    assertOutput: (output) => {
      assert.deepEqual(Object.keys(output).sort(), ["outcome", "package"]);
      assert.equal(output.outcome, "Validated");
      assert.equal(output.package.validation.cases[0].outcome, "Passed");
      assert.equal(output.package.validation.cases.length, 2);
      assert.equal(output.package.artifact.validationSuiteHash, "sha256:141e367570fa3b29f2f2fb56549762b47adeaf9b7770b40b61c25eae2b0750af");
      assertCompactSemantic(output.package.artifact.candidate);
    },
  },
  {
    module: "review",
    input: "05-review-input.json",
    output: "05-review.json",
    assertOutput: (output) => {
      assert.deepEqual(Object.keys(output).sort(), ["authorization", "review", "validated"]);
      assert.equal(output.authorization.mode, "Validated");
      assert.equal(output.review.decision, "Approved");
      assert.equal(output.authorization.reason, output.review.reason, "the authorization carries the verdict's own words");
      assert.equal(output.validated.validation.cases[0].outcome, "Passed");
      assertCompactSemantic(output.validated.artifact.candidate);
    },
  },
  {
    module: "publish",
    input: "06-publish-input.json",
    output: "06-publish.json",
    assertOutput: (output) => {
      assert.deepEqual(Object.keys(output).sort(), ["capability", "outcome", "version"]);
      assert.equal(output.outcome, "Published");
      assert.equal(output.capability.status, "Active");
      assert.equal(output.version.status, "Published");
      assertCompactSemantic(output.capability);
    },
  },
];

for (const item of cases) {
  test(`${item.module} mock runs from its standalone fixture`, async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "capability-progressive-"));
    const result = await runStep(item.module, {
      input: resolve(fixtureDir, item.input),
      outputDir,
    });

    assert.equal(basename(result.outputPath), item.output);
    item.assertOutput(result.output);
  });
}

test("C3 rejects a mutated program instead of repairing C2-committed hashes", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "capability-progressive-hash-"));
  const input = JSON.parse(await readFile(resolve(fixtureDir, "04-c3-input.json"), "utf8"));
  input.validationTask.runSpec.program.stages[0].title = "mutated after C2 commit";
  const inputPath = join(outputDir, "04-c3-mutated.json");
  await writeFile(inputPath, JSON.stringify(input));

  await assert.rejects(
    () => runStep("validate", { input: inputPath, outputDir }),
    /candidate_frozen_artifact_mismatch/,
  );
});

test("C3 rejects a mutated program even when its self-hash is recomputed", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "capability-progressive-rehashed-program-"));
  const input = JSON.parse(await readFile(resolve(fixtureDir, "04-c3-input.json"), "utf8"));
  input.validationTask.runSpec.program.stages[0].title = "mutated and rehashed after C2 commit";
  input.validationTask.runSpec.programHash = hashJson(input.validationTask.runSpec.program);
  const inputPath = join(outputDir, "04-c3-rehashed-program.json");
  await writeFile(inputPath, JSON.stringify(input));
  await assert.rejects(() => runStep("validate", { input: inputPath, outputDir }), /candidate_frozen_artifact_mismatch/);
});

test("C3 rejects a substituted case-discovery evidence reference", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "capability-progressive-evidence-ref-"));
  const input = JSON.parse(await readFile(resolve(fixtureDir, "04-c3-input.json"), "utf8"));
  input.validationTask.runSpec.caseDiscoveryEvidenceRef = {
    artifactRef: "artifact://substituted-evidence",
    contentHash: `sha256:${"a".repeat(64)}`,
    byteLength: 12,
  };
  const inputPath = join(outputDir, "04-c3-evidence-ref-mutated.json");
  await writeFile(inputPath, JSON.stringify(input));
  await assert.rejects(() => runStep("validate", { input: inputPath, outputDir }), /candidate_frozen_artifact_mismatch/);
});

test("C3 rejects a validation suite whose content no longer matches its frozen hash", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "capability-progressive-suite-hash-"));
  const input = JSON.parse(await readFile(resolve(fixtureDir, "04-c3-input.json"), "utf8"));
  input.validationTask.runSpec.cases[0].expected = { query: "tampered" };
  const inputPath = join(outputDir, "04-c3-suite-hash-mutated.json");
  await writeFile(inputPath, JSON.stringify(input));

  await assert.rejects(
    () => runStep("validate", { input: inputPath, outputDir }),
    /candidate_frozen_artifact_mismatch/,
  );
});

test("C3 rejects reordered cases even when the RunSpec suite hash is recomputed", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "capability-progressive-case-order-"));
  const input = JSON.parse(await readFile(resolve(fixtureDir, "04-c3-input.json"), "utf8"));
  input.validationTask.runSpec.cases.reverse();
  input.validationTask.runSpec.validationSuiteHash = capabilityValidationSuiteHash({
    cases: input.validationTask.runSpec.cases,
  });
  const inputPath = join(outputDir, "04-c3-case-order-mutated.json");
  await writeFile(inputPath, JSON.stringify(input));

  await assert.rejects(
    () => runStep("validate", { input: inputPath, outputDir }),
    /candidate_frozen_artifact_mismatch/,
  );
});

test("C3 rejects changed case input even when the RunSpec suite hash is recomputed", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "capability-progressive-case-input-"));
  const input = JSON.parse(await readFile(resolve(fixtureDir, "04-c3-input.json"), "utf8"));
  input.validationTask.runSpec.cases[0].input.query = "mug";
  input.validationTask.runSpec.validationSuiteHash = capabilityValidationSuiteHash({
    cases: input.validationTask.runSpec.cases,
  });
  const inputPath = join(outputDir, "04-c3-case-input-mutated.json");
  await writeFile(inputPath, JSON.stringify(input));

  await assert.rejects(
    () => runStep("validate", { input: inputPath, outputDir }),
    /candidate_frozen_artifact_mismatch/,
  );
});

test("C3 reports an expected partial output drift, and still validates, after the suite is validly rehashed", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "capability-progressive-expected-"));
  const input = JSON.parse(await readFile(resolve(fixtureDir, "04-c3-input.json"), "utf8"));
  input.artifact.validationSuite.cases[0].expected = { query: "mug" };
  input.validationTask.runSpec.cases = structuredClone(input.artifact.validationSuite.cases);
  const validationSuiteHash = capabilityValidationSuiteHash(input.artifact.validationSuite);
  input.artifact.validationSuiteHash = validationSuiteHash;
  input.validationTask.runSpec.validationSuiteHash = validationSuiteHash;
  const frozenArtifactPath = join(outputDir, "04-c3-expected-frozen-artifact.json");
  await writeFile(frozenArtifactPath, JSON.stringify({ artifact: input.artifact }));
  input.frozenArtifactFile = frozenArtifactPath;
  const inputPath = join(outputDir, "04-c3-expected-mismatch.json");
  await writeFile(inputPath, JSON.stringify(input));

  // An expectation is a prediction, not a gate: the program's own contract
  // decides success, and a value that differs from the prediction is reported
  // with the case so that the review can weigh it.
  const result = await runStep("validate", { input: inputPath, outputDir });
  assert.equal(result.output.outcome, "Validated");
  const first = result.output.package.validation.cases[0];
  assert.equal(first.outcome, "Passed");
  assert.deepEqual(first.outputDrift.map((item) => item.key), ["query"]);
  assert.equal(first.outputDrift[0].expected, "mug");
});

test("D fixture establishes lineage through production APIs instead of carrying fabricated IDs", async () => {
  const input = JSON.parse(await readFile(resolve(fixtureDir, "06-publish-input.json"), "utf8"));
  const setup = JSON.stringify(input.setup);
  assert.equal(setup.includes("generationTaskId"), false);
  assert.equal(setup.includes("candidateId"), false);
  assert.equal(setup.includes("contractHash"), false);
  assert.equal(setup.includes("programHash"), false);
});
