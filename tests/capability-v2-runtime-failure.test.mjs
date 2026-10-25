import assert from "node:assert/strict";
import test from "node:test";
import { capabilityOptionNotOffered, capabilityVerificationOnlyFailure, explainCapabilityRuntimeFailure } from "../lib/capability-center-v2/runtime-failure.ts";
import { WIDGET_LOCALES, widgetCopy } from "../client/user-agent-copy.ts";

const base = { capabilityName: "Submit order", targetLabel: "Confirm", sideEffectStarted: false };
const RULES = [
  ["locator_not_found:step_1", "locatorNotFound"],
  ["target_ambiguous:step_1", "targetAmbiguous"],
  ["wait_timeout:step_1", "waitTimeout"],
  ["precondition_url_mismatch", "preconditionUrlMismatch"],
  ["precondition_text_missing", "preconditionTextMissing"],
  ["capability_input_required:orderId", "inputRequired"],
  ["success_text_missing", "resultUnverified"],
  ["capability_navigation_origin_invalid", "navigationOriginInvalid"],
  ["fill_verification_failed:value", "fillVerificationFailed"],
  ["target_not_checkbox:step_1", "targetNotCheckbox"],
  ["upload_requires_user_interaction:step_1", "uploadRequiresUser"],
  ["task_cancelled", "cancelled"],
  ["unexpected_runtime_problem", "unrecognized"],
];

test("every V2 runtime failure is explained in the visitor's language, without the executor code", () => {
  for (const locale of WIDGET_LOCALES) {
    const say = widgetCopy(locale).run.runtimeFailure;
    const summaries = new Set();
    for (const [technicalError] of RULES) {
      const result = explainCapabilityRuntimeFailure({ ...base, technicalError }, say);
      assert.ok(result.summary.includes(say.quote(base.capabilityName)), `${locale} ${technicalError}`);
      assert.equal(result.summary.includes(String(technicalError).split(":")[0]), false, `${locale} ${technicalError}`);
      summaries.add(result.summary);
    }
    assert.equal(summaries.size, RULES.length, `${locale}: each rule has its own explanation`);
  }
  // The two catalogs explain the same failure differently: neither borrows the other's words.
  const [zh, en] = ["zh", "en"].map((locale) => explainCapabilityRuntimeFailure({ ...base, technicalError: "unexpected_runtime_problem" }, widgetCopy(locale).run.runtimeFailure).summary);
  assert.match(zh, /\p{Script=Han}/u);
  assert.doesNotMatch(en, /\p{Script=Han}/u);
});

test("V2 failure explanation warns when an operation may be partially applied", () => {
  for (const locale of WIDGET_LOCALES) {
    const say = widgetCopy(locale).run.runtimeFailure;
    const result = explainCapabilityRuntimeFailure({ ...base, technicalError: "locator_not_found:step_2", sideEffectStarted: true }, say);
    assert.ok(result.summary.includes(say.partialWarning), locale);
    assert.equal(result.repairSuggested, true);
  }
});

test("only the generic fallback is reported as unrecognized", () => {
  const say = widgetCopy("en").run.runtimeFailure;
  assert.equal(explainCapabilityRuntimeFailure({ ...base, technicalError: "locator_not_found:step_1" }, say).recognized, true);
  assert.equal(explainCapabilityRuntimeFailure({ ...base, technicalError: "capability_result_unverified" }, say).recognized, true);
  assert.equal(explainCapabilityRuntimeFailure({ ...base, technicalError: "Cannot extract topic title from dialog" }, say).recognized, false);
});

test("a value the page does not offer is read back with what it does offer", () => {
  assert.deepEqual(
    capabilityOptionNotOffered("capability_stage_select_option_missing:stage_5:1000; options: Any | Up to $100 | Up to $500"),
    { wanted: "1000", offered: ["Any", "Up to $100", "Up to $500"] },
  );
  assert.equal(capabilityOptionNotOffered("locator_not_found:step_1"), undefined);
});

test("a throw from the terminal verification stage is a capability defect, not an unknown page fault", () => {
  // The production shape: stage_1 clicked and completed, stage_verify started and threw.
  const stages = [{ id: "stage_1" }, { id: "stage_verify" }];
  const receipts = [
    { stageId: "stage_1", status: "Started" },
    { stageId: "stage_1", status: "Completed" },
    { stageId: "stage_verify", status: "Started" },
  ];
  assert.equal(capabilityVerificationOnlyFailure({ stages, receipts, activeStageId: "stage_verify" }), true);
  // Reported as such, the user hears what actually happened and a repair is offered.
  const explanation = explainCapabilityRuntimeFailure({ ...base, technicalError: "capability_result_unverified:Cannot extract topic title from dialog" }, widgetCopy("en").run.runtimeFailure);
  assert.equal(explanation.summary, widgetCopy("en").run.runtimeFailure.resultUnverified(widgetCopy("en").run.runtimeFailure.quote(base.capabilityName)));
  assert.equal(explanation.repairSuggested, true);
  assert.equal(explanation.summary.includes("Cannot extract topic title"), false, "the raw message stays in evidence");
});

test("a failure that is not the terminal verification stage keeps its own reporting", () => {
  const stages = [{ id: "stage_1" }, { id: "stage_2" }, { id: "stage_verify" }];
  // An action stage failed: the page work itself did not finish.
  assert.equal(capabilityVerificationOnlyFailure({
    stages,
    receipts: [{ stageId: "stage_1", status: "Started" }],
    activeStageId: "stage_1",
  }), false);
  // The verification stage was reached but an earlier stage never completed.
  assert.equal(capabilityVerificationOnlyFailure({
    stages,
    receipts: [{ stageId: "stage_1", status: "Completed" }, { stageId: "stage_verify", status: "Started" }],
    activeStageId: "stage_verify",
  }), false);
  // A single-stage program has no completed action work to stand on.
  assert.equal(capabilityVerificationOnlyFailure({
    stages: [{ id: "stage_verify" }],
    receipts: [{ stageId: "stage_verify", status: "Started" }],
    activeStageId: "stage_verify",
  }), false);
  // The verification stage completed; the failure came from somewhere else.
  assert.equal(capabilityVerificationOnlyFailure({
    stages,
    receipts: [{ stageId: "stage_1", status: "Completed" }, { stageId: "stage_2", status: "Completed" }, { stageId: "stage_verify", status: "Completed" }],
    activeStageId: "stage_verify",
  }), false);
});
