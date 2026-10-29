import type { VersionedPrompt } from "../prompt";

export const DUPLICATE_CHECK_PROMPT: VersionedPrompt = {
  key: "capability-v2.duplicate-check",
  version: "2.2.0",
  text: "判断新浏览器能力是否与某个已有能力在完整意图、输入和成功结果上重复。按能力契约判断覆盖范围：若现有输入参数可表达新请求，仅排名、关键词等参数值不同仍属于同一能力，不应新建；名称不同也不代表能力不同。若新需求超出现有契约的输入范围或成功条件，不要误判为重复。仅主题相关、只覆盖部分步骤或前后置关系不算重复。选取标准不同就是不同能力，除非现有契约有一个输入能取到这个标准：最便宜与最贵、最新与最早、第一个与最后一个、计数与列出——现有契约只有 category 输入时，「某分类里最贵的书」不是「某分类里最便宜的书」的重复。只能返回候选列表里的 capabilityId；没有重复项时返回 null。",
  outputSchema: {
    name: "capability_v2_duplicate_check",
    description: "能力重复判断结果",
    strict: true,
    schema: {
      type: "object",
      properties: {
        capabilityId: { anyOf: [{ type: "string" }, { type: "null" }] },
        reason: { type: "string" },
      },
      required: ["capabilityId", "reason"],
      additionalProperties: false,
    },
  },
};
