import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// How a frozen case's `expected` is read against what a replay produced. It is
// a prediction the C2 turn made without running anything, so it never decides
// whether a case passed: every difference is drift, and the review turn reads
// it. What decides a case is the run — a terminal outcome, an output the
// contract's outputSchema accepts, success conditions that hold on the page,
// and cases meant to differ that did not all come back the same.
process.env.CAPABILITY_V2_AUTO_DISPATCH = "0";
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./helpers/capability-v2-test-entry.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { compareCapabilityExpectedOutput, describeExpectedOutputDrift, createValidatedCapabilityPackage } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

test("every predicted value the replay did not reproduce is drift, including one the input fixed", () => {
  const input = { keyword: "张展硕" };
  const expected = { query: "张展硕", searchStatus: "正在查找包含“张展硕”的词条" };
  const drifted = compareCapabilityExpectedOutput({ expected, actual: { query: "张展硕", searchStatus: "张展硕" }, input });
  assert.deepEqual(drifted.drift, [{ key: "searchStatus", expected: "正在查找包含“张展硕”的词条", actual: "张展硕" }]);
  assert.match(describeExpectedOutputDrift(drifted.drift), /searchStatus: 预期 "正在查找包含“张展硕”的词条"，实际 "张展硕"/);

  // A program that answered for another keyword is caught by the contract, not
  // by the prediction: successConditions require the requested keyword on the
  // page. Here it is reported for the review turn to read.
  const wrong = compareCapabilityExpectedOutput({ expected, actual: { query: "周杰伦", searchStatus: "周杰伦" }, input });
  assert.deepEqual(wrong.drift.map((item) => item.key), ["query", "searchStatus"]);

  // A field the page had nothing to put in is drift too; whether the output is
  // acceptable without it is what the outputSchema says.
  const absent = compareCapabilityExpectedOutput({ expected, actual: { query: "张展硕" }, input });
  assert.deepEqual(absent.drift, [{ key: "searchStatus", expected: "正在查找包含“张展硕”的词条", actual: null }]);

  // Equality tolerates the same normalization C2 grounds evidence with (width, spacing, case).
  const same = compareCapabilityExpectedOutput({ expected: { query: "Ｍug  Cup" }, actual: { query: "mug cup" }, input: { query: "Mug Cup" } });
  assert.deepEqual(same, { drift: [] });
});

test("a rank read off the page is not a failed prediction", () => {
  // 打开热搜榜指定排名详情, on the deployed installation: asked for rank 9, read
  // 「第 14 名」 off the page it opened, and was failed against a prediction of
  // 9 that a model had made without running anything. Both facts are called a
  // rank and they are not the same fact.
  const ranked = compareCapabilityExpectedOutput({
    expected: { currentRank: 9, targetTitle: "王楚钦孙颖莎 混双半决赛" },
    actual: { currentRank: 14, targetTitle: "王楚钦孙颖莎 混双半决赛" },
    input: { rank: 9 },
  });
  assert.deepEqual(ranked.drift.map((item) => item.key), ["currentRank"]);
});

function artifactWith(cases) {
  const contract = {
    intent: "我想看{{keyword}}热搜",
    inputSchema: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"], additionalProperties: false },
    outputSchema: { type: "object", properties: { query: { type: "string" }, searchStatus: { type: "string" } }, required: ["query", "searchStatus"], additionalProperties: false },
    preconditions: [],
    successConditions: [{ type: "textTemplate", template: "{{keyword}}" }],
  };
  return {
    candidateId: "candidate-1",
    contractHash: "sha256:contract",
    programHash: "sha256:program",
    candidate: {
      name: "查询微博热搜记录",
      description: "",
      aliases: [],
      contract,
      program: { schemaVersion: "2.0", runtime: "BrowserJavaScriptStage", module: { contentHash: "0".repeat(64), moduleUrl: "/m", exportName: "capability" }, entry: { mode: "CurrentPage" }, stages: [{ id: "stage_verify" }] },
    },
    validationSuite: { cases },
  };
}

function reported(caseId, keyword, output, extra = {}) {
  return {
    caseId,
    resolvedInput: { keyword },
    output,
    stageReceipts: [{ stageId: "stage_verify", outcome: "Success", evidenceRefs: [`evidence://${caseId}`] }],
    evidenceRefs: [`evidence://${caseId}`],
    ...extra,
  };
}

test("the store re-derives drift from the frozen suite: the case passes and the drift travels with the package", () => {
  const artifact = artifactWith([
    { caseId: "case_1", input: { keyword: "张展硕" }, expected: { query: "张展硕", searchStatus: "正在查找包含“张展硕”的词条" } },
    { caseId: "case_2", input: { keyword: "亚运会" }, expected: { query: "亚运会", searchStatus: "正在查找包含“亚运会”的词条" } },
  ]);
  const validated = createValidatedCapabilityPackage(artifact, "validation-1", {
    outcome: "Success",
    validationResults: [
      // What the runner reports as drift is not trusted: the store recomputes it.
      reported("case_1", "张展硕", { query: "张展硕", searchStatus: "张展硕" }, { outputDrift: [{ key: "searchStatus", expected: "x", actual: "y" }] }),
      reported("case_2", "亚运会", { query: "亚运会", searchStatus: "正在查找包含“亚运会”的词条" }),
    ],
  });
  assert.deepEqual(validated.validation.cases.map((item) => item.outcome), ["Passed", "Passed"]);
  // A prediction the replay did not reproduce is reported, never charged: the
  // case that drifted is the one that passed.
  assert.equal(validated.validation.cases[0].outcome, "Passed");
  assert.deepEqual(validated.validation.cases[0].outputDrift, [{ key: "searchStatus", expected: "正在查找包含“张展硕”的词条", actual: "张展硕" }]);
  assert.equal("outputDrift" in validated.validation.cases[1], false, "an exact case carries no drift");
});

test("a case the replay recorded as failed travels with the package, and a record without one still reads as passed", () => {
  // A case is one input, not the capability. A rank whose detail page shows the
  // topic's own best position rather than the one that was asked for fails its
  // success condition, and it used to end the replay and throw away the cases
  // that had already passed. It is recorded with what went wrong, beside them.
  const artifact = artifactWith([
    { caseId: "case_1", input: { keyword: "张展硕" }, expected: { query: "张展硕", searchStatus: "正在查找包含“张展硕”的词条" } },
    { caseId: "case_2", input: { keyword: "亚运会" }, expected: { query: "亚运会", searchStatus: "正在查找包含“亚运会”的词条" } },
  ]);
  const mixed = createValidatedCapabilityPackage(artifact, "validation-1", {
    outcome: "Success",
    validationResults: [
      reported("case_1", "张展硕", { query: "张展硕", searchStatus: "正在查找包含“张展硕”的词条" }),
      // A failed case carries no success receipt and no evidence, because there
      // was nothing to evidence.
      { caseId: "case_2", resolvedInput: { keyword: "亚运会" }, output: {}, stageReceipts: [], evidenceRefs: [], failureReason: "success_text_missing:亚运会" },
    ],
  });
  assert.deepEqual(mixed.validation.cases.map((item) => item.outcome), ["Passed", "Failed"]);
  assert.equal(mixed.validation.cases[1].failureReason, "success_text_missing:亚运会");

  // A record written before a case could say it failed carries no such field,
  // and reads as what it meant when it was written.
  const historical = createValidatedCapabilityPackage(artifact, "validation-1", {
    outcome: "Success",
    validationResults: [
      reported("case_1", "张展硕", { query: "张展硕", searchStatus: "正在查找包含“张展硕”的词条" }),
      reported("case_2", "亚运会", { query: "亚运会", searchStatus: "正在查找包含“亚运会”的词条" }),
    ],
  });
  assert.deepEqual(historical.validation.cases.map((item) => item.outcome), ["Passed", "Passed"]);
  assert.equal(historical.validation.cases.every((item) => !("failureReason" in item)), true);
});

test("the store reports what a replay did not reproduce, and refuses nothing for it", () => {
  const artifact = artifactWith([
    { caseId: "case_1", input: { keyword: "张展硕" }, expected: { query: "张展硕", searchStatus: "正在查找包含“张展硕”的词条" } },
  ]);
  const echoed = createValidatedCapabilityPackage(artifact, "validation-1", {
    outcome: "Success",
    validationResults: [reported("case_1", "张展硕", { query: "周杰伦", searchStatus: "周杰伦" })],
  });
  assert.equal(echoed.validation.cases[0].outcome, "Passed");
  assert.deepEqual(echoed.validation.cases[0].outputDrift.map((item) => item.key), ["query", "searchStatus"]);

  const absent = createValidatedCapabilityPackage(artifact, "validation-1", {
    outcome: "Success",
    validationResults: [reported("case_1", "张展硕", { query: "张展硕" })],
  });
  assert.deepEqual(absent.validation.cases[0].outputDrift.map((item) => item.key), ["searchStatus"]);
});
