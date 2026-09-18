import assert from "node:assert/strict";
import test from "node:test";
import { explainCapabilityRuntimeFailure } from "../lib/capability-center-v2/runtime-failure.ts";

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
