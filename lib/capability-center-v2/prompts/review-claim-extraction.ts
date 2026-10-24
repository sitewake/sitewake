import type { VersionedPrompt } from "../prompt";

/**
 * A rejection from the publish review is only as good as the facts it cites.
 * The reviewer once rejected a healthy program by claiming stages "declare
 * empty io.reads" that in fact declared the very inputs they consumed — a
 * claim checkable against the program in one lookup. This prompt extracts the
 * rejection's checkable claims so the adjudicator can verify each one
 * deterministically before letting the rejection stand.
 */
export const REVIEW_CLAIM_EXTRACTION_PROMPT: VersionedPrompt = {
  key: "capability-v2.review-claim-extraction",
  version: "1.1.0",
  text: [
    "你是能力发布审核的复核员。给定一条审核拒绝理由、该能力程序的 Stage io 声明表和必填输入列表，把拒绝理由中每个可以用这两张表核查的事实主张提取成结构化条目。",
    "规则：只提取拒绝理由中实际写出的主张，不推断、不补充、不评判对错；泛泛的抽象担忧（例如“可能”“风险”“不确定”）不算主张。",
    "stage 字段只能填 Stage 声明表中存在的 Stage id；无法对应就留空，并把理由中的原句写进 detail。",
    "input 字段只能填必填输入列表中的名字；无法对应就留空，并把理由中的原句写进 detail。",
    "kind 取值：empty_reads_consumes_input（某个 Stage 声明了空的 io.reads.input，却在消费某个输入）、required_input_not_consumed（某个必填输入从未被程序消费）、undeclared_input_read（某个 Stage 读取了 io.reads.input 未声明的输入）、demonstration_value_hardcoded（某个输入的演示值被原样写进了可执行代码）、insufficient_validation_cases（验证样例太少，不足以证明不同输入解析到不同目标）、other（以上都不是的具体主张）。",
    "一个主张一个条目；理由复述同一件事的，只提取一次。",
  ].join("\n"),
  outputSchema: {
    name: "capability_v2_review_claim_extraction",
    description: "审核拒绝理由中可核查事实主张的提取结果",
    strict: true,
    schema: {
      type: "object",
      properties: {
        claims: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: [
                  "empty_reads_consumes_input",
                  "required_input_not_consumed",
                  "undeclared_input_read",
                  "demonstration_value_hardcoded",
                  "insufficient_validation_cases",
                  "other",
                ],
              },
              stage: { type: "string" },
              input: { type: "string" },
              detail: { type: "string" },
            },
            required: ["kind"],
            additionalProperties: false,
          },
        },
      },
      required: ["claims"],
      additionalProperties: false,
    },
  },
};
