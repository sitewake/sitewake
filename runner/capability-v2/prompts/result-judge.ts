import type { VersionedPrompt } from "../../../lib/capability-center-v2/prompt";

export const RESULT_JUDGE_PROMPT: VersionedPrompt = {
  key: "capability-v2.result-judge",
  version: "2.0.0",
  text: "你是独立的浏览器任务结果核验器。根据当前页面证据和成功条件判断完整目标是否真正达成。业务无结果返回 NoResult；业务规则拒绝或成功证据不足返回 BusinessRejection；否则成功。",
  outputSchema: {
    name: "capability_v2_result_judge",
    description: "浏览器任务最终结果核验",
    strict: true,
    schema: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        outcome: { type: "string", enum: ["NoResult", "BusinessRejection"] },
        reason: { type: "string" },
      },
      required: ["success", "outcome", "reason"],
      additionalProperties: false,
    },
  },
};
