import type { VersionedPrompt } from "../../../lib/capability-center-v2/prompt";

/**
 * C2 enrichment. The cases already exist: code derived every input from the
 * page evidence. The model may re-select an input among the alternatives
 * listed for that case — every value the page offered for that field, whichever
 * region it came from — and may fill `expected` from what it can see. Code
 * checks both again; nothing it says can fail the run.
 */
export const CAPABILITY_CASE_GENERATION_PROMPT: VersionedPrompt = {
  key: "capability-v2.case-generation",
  version: "3.1.0",
  text: [
    "你是 Capability Center V2 的 C2 用例补充器。",
    "cases 里的每个用例已经由代码从页面证据推导出来，input 的每个值都是页面上实际观察到的值。你不生成新用例，也不改变用例数量和顺序。",
    "对每个用例，你可以做两件事：",
    "1. 如果某个 input 值明显不符合该字段的业务含义，从该用例 alternatives 里对应字段列出的值中换一个更合适的，放进 input；alternatives 之外的值一律不允许，字段也不能增减。input 合适时省略它。",
    "判断是否合适，看这个值是不是该字段在这个网站上真实会取的值：color 被填成商品名、搜索词被填成页面上的说明文字或常见问题标题、人物名被填成整句话，都不合适；alternatives 里通常有同一页面上更像该字段取值的短值，例如榜单条目里的人名或话题名。",
    "2. 填写 expected：outputSchema 的部分输出断言。每个叶子值必须精确等于本用例 input 的值、caseDiscoveryEvidence 中实际观察到的值，或由 Contract 中 textTemplate/urlTemplate 按本用例 input 渲染得到的值。不确定就留空对象。",
    "网页 document.title 与话题/商品标题不是同一个字段；实时热度、排名会变化，不能把另一时刻或另一输入的值当成当前断言，也不能把请求序号当成当前排名。",
    "candidate 是不可变边界；不得改写、补充或返回 candidate、contract、program、名称或别名。",
    "只返回 cases，数量必须与输入的 cases 完全一致，顺序一一对应。不要输出解释、Markdown、路径、DOM、凭据、regionId 或任何额外字段。",
  ].join("\n"),
  outputSchema: {
    name: "capability_v2_case_enrichment",
    description:
      "C2 模型只在代码推导出的用例上补充 expected，并可在给定备选值内替换 input；候选、证据与 caseId 均不属于模型输出。",
    strict: true,
    schema: {
      type: "object",
      properties: {
        cases: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              input: { type: "object", additionalProperties: false },
              expected: { type: "object", additionalProperties: false },
            },
            required: ["input", "expected"],
            additionalProperties: false,
          },
        },
      },
      required: ["cases"],
      additionalProperties: false,
    },
  },
};
