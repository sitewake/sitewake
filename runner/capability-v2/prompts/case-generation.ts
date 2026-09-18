import type { VersionedPrompt } from "../../../lib/capability-center-v2/prompt";

export const CAPABILITY_CASE_GENERATION_PROMPT: VersionedPrompt = {
  key: "capability-v2.case-generation",
  version: "2.3.0",
  text: [
    "你是 Capability Center V2 的独立 C2 用例生成器。",
    "输入中的 candidate 是不可变边界；不得改写、补充或返回 candidate、contract、program、名称或别名。",
    "网页 document.title 与话题/商品标题不是同一个字段。expected 必须符合 outputSchema 字段的实际语义，不能因为观察到一个标题就把它填入 pageTitle；无法独立确认该输出时使用空 expected，交由确定性成功契约与程序业务身份验证。",
    "优先验证输出对应的业务对象身份。实际观察到目标名称/稳定链接时应放入 expected；实时热度、排名会变化，不能把另一时刻或另一输入的值当成当前断言，也不能把请求序号当成当前排名。",
    "只返回 cases。每项只能包含 input 和 expected，caseId 由生产代码生成。",
    "input 必须满足 Contract inputSchema；有默认值的可选参数至少有一个用例必须省略它。",
    "参数化能力至少生成两个输入不同的独立用例；每个非敏感 input 值都必须是 caseDiscoveryEvidence.regions 中实际观察到的值。",
    "同一用例的多个目标/筛选参数必须来自同一 region；不得拼接不同区域的对象属性，也不得臆造、改写或归一化成未观察到的新业务值。",
    "caseDiscoveryEvidence.explorationMode 为 evidence-only 时，只能根据已采集证据生成用例，不得建议或假设已经提交、执行、创建、修改、删除或支付。",
    "expected 是 outputSchema 的部分输出断言，可以为空对象；每个叶子值必须精确等于本用例 input 值、caseDiscoveryEvidence 中实际观察到的值，或由 Contract 中可确定执行的 textTemplate/urlTemplate 按本用例 input 渲染得到的值。不能凭常识或不可确定的模板推测新值；不确定时使用空对象。",
    "严格使用 generationConstraints.inputFields 和 expectedFields 中列出的字段名；不得翻译、缩写或发明 url 等近义字段。",
    "不要输出解释、Markdown、路径、DOM、凭据、证据、regionId、映射或任何额外字段。",
  ].join("\n"),
  outputSchema: {
    name: "capability_v2_case_generation",
    description:
      "C2 模型只生成证据约束的用例输入和部分期望输出；候选、证据与 caseId 均不属于模型输出。",
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
              input: { type: "object", additionalProperties: true },
              expected: { type: "object", additionalProperties: true },
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
