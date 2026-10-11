import assert from "node:assert/strict";
import test from "node:test";
import { capabilityVerificationOnlyFailure, explainCapabilityRuntimeFailure } from "../lib/capability-center-v2/runtime-failure.ts";

const base = { capabilityName: "提交订单", targetLabel: "确认提交", sideEffectStarted: false };

test("V2 runtime failures always produce user-facing explanations", () => {
  const cases = [
    ["locator_not_found:step_1", /没有找到.*确认提交.*尚未执行/],
    ["target_ambiguous:step_1", /多个.*确认提交.*避免误操作/],
    ["wait_timeout:step_1", /等待.*确认提交.*超时/],
    ["precondition_url_mismatch", /不符合.*入口条件/],
    ["precondition_text_missing", /缺少.*业务前置状态/],
    ["capability_input_required:orderId", /缺少必要输入/],
    ["success_text_missing", /没有观察到.*成功结果.*部分生效/],
    ["capability_navigation_origin_invalid", /允许范围之外.*阻止/],
    ["fill_verification_failed:value", /没有接受写入/],
    ["target_not_checkbox:step_1", /不再是预期的勾选控件/],
    ["upload_requires_user_interaction:step_1", /手动选择并上传文件/],
    ["task_cancelled", /已停止.*尚未执行/],
    ["unexpected_runtime_problem", /未能识别的运行问题/],
  ];
  for (const [technicalError, expected] of cases) {
    const result = explainCapabilityRuntimeFailure({ ...base, technicalError });
    assert.match(result.summary, expected, technicalError);
    assert.equal(result.summary.includes(String(technicalError)), false, technicalError);
  }
});

test("V2 failure explanation warns when an operation may be partially applied", () => {
  const result = explainCapabilityRuntimeFailure({ ...base, technicalError: "locator_not_found:step_2", sideEffectStarted: true });
  assert.match(result.summary, /可能已经部分生效.*不要直接重复执行/);
  assert.equal(result.repairSuggested, true);
});

test("only the generic fallback is reported as unrecognized", () => {
  assert.equal(explainCapabilityRuntimeFailure({ ...base, technicalError: "locator_not_found:step_1" }).recognized, true);
  assert.equal(explainCapabilityRuntimeFailure({ ...base, technicalError: "capability_result_unverified" }).recognized, true);
  assert.equal(explainCapabilityRuntimeFailure({ ...base, technicalError: "Cannot extract topic title from dialog" }).recognized, false);
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
  const explanation = explainCapabilityRuntimeFailure({ ...base, technicalError: "capability_result_unverified:Cannot extract topic title from dialog" });
  assert.match(explanation.summary, /已经执行页面操作，但没有观察到约定的成功结果/);
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
