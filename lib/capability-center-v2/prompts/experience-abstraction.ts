import type { VersionedPrompt } from "../prompt";
import { DEFAULT_KNOWLEDGE_LOCALE, languageName, type KnowledgeLocale } from "../../site-knowledge/prompt-locale";

/**
 * The abstracted name / description become the capability name, seen by operators in
 * the console and visitors in the widget, so the output language must be controllable.
 * A function rather than a sentence appended at the call site: promptHash hashes the
 * text for audit, and call-site concatenation would make the recorded hash differ from
 * the prompt actually sent.
 *
 * The Chinese version is kept byte for byte, so existing sites' hashes are unchanged and
 * no spurious prompt change is recorded.
 */
export function experienceAbstractionPrompt(
  locale: KnowledgeLocale = DEFAULT_KNOWLEDGE_LOCALE,
): VersionedPrompt {
  return { ...EXPERIENCE_ABSTRACTION_PROMPT, text: promptText(locale) };
}

const promptText = (locale: KnowledgeLocale) => [
    "你是浏览器能力中心的任务抽象器。输入是一名终端用户的 PageAgent 已经真实完成的一次页面操作经验。",
    "你的输出只用于网站管理员后台创建 Discovery Task，绝不能包含制作能力、审核或发布等面向终端用户的文案。",
    "抽象必须保留用户的完整最终动作；搜索、加入购物车、删除、提交等最终动作不能退化为打开页面、查看详情或点击按钮等中间步骤。",
    "把本次实例值与可复用动作分开：商品类别/搜索词、联系人、日期、数量、文件名等会随请求变化的业务值必须成为 required 参数，并以本次真实值作为 exampleValue。页面上被点击的某个具体商品标题、详情页标题、固定 URL、DOM 文本只是证据，不得把它们直接当成 productIdentifier/targetName 这类能力参数；只有 originalGoal 明确逐字指定了该具体对象时才允许保留。比如用户说‘找一个白色马克杯’，应参数化为商品类别与颜色，而不是固定为‘White Ceramic Mug’。",
    "先标注作用域：当前分类、筛选器、详情页和固定路径只是本次经验上下文。优先将能力抽象为站点级搜索/操作；若经验明确依赖分类或页面，输出 category-scoped/page-scoped，并用 match.requiredInputPaths、match.tokens 或稳定的 match.urlPatterns 描述可运行的匹配规则，不能把固定目录误写成任意商品能力。",
    "name、description、aliases、intent 必须是可复用表述，禁止写入参数的 exampleValue。没有可变业务值的当前页面、当前购物车或当前会话操作可以不声明参数。",
    "selector、xpath、locator、elementIndex、testId、按钮下标等页面实现细节永远不是业务参数。",
    "只能使用 originalGoal、actions、routes、页面标题/标题栏和 output 中出现过的值作为 exampleValue，不得臆造。",
    "routes 是本次运行进入过的地址以及绑定到地址里的值。进入地址不是页面动作。routes[].bindings 和下拉选项里的值，凡是出自 originalGoal（用户自己说的话），都是随请求变化的业务值，必须成为 required 参数并以本次真实值作为 exampleValue；用户没有提到、由执行过程自行选择的值（例如浏览途中进入的某个具体商品详情页、默认插头规格、为缩小范围点的筛选项）只是本次证据，可以保持固定，不要为它们声明参数。一次只靠进入地址就完成的经验是完整经验，不要因为 actions 为空就当作没有操作。",
    "NoResult 表示页面操作已真实完成但结果为空，仍应抽象操作本身，不要把‘没有结果’误写成技术失败。",
    `用简洁${languageName(locale)}输出；name 建议 4 到 24 个字符，description 说明动作、必要输入和最终业务结果。`,
  ].join("\n");

export const EXPERIENCE_ABSTRACTION_PROMPT: VersionedPrompt = {
  key: "capability-v2.experience-abstraction",
  version: "1.2.0",
  text: promptText(DEFAULT_KNOWLEDGE_LOCALE),
  outputSchema: {
    name: "capability_v2_experience_abstraction",
    description: "终端 PageAgent 成功经验的可复用任务抽象",
    strict: true,
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        aliases: { type: "array", items: { type: "string" } },
        intent: { type: "string" },
        parameters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", enum: ["string", "number", "boolean"] },
              description: { type: "string" },
              required: { type: "boolean" },
              exampleValue: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
            },
            required: ["name", "type", "description", "required", "exampleValue"],
            additionalProperties: false,
          },
        },
        scope: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["site-global", "category-scoped", "page-scoped", "unknown"] },
            match: {
              type: "object",
              properties: {
                requiredInputPaths: { type: "array", items: { type: "string" } },
                tokens: { type: "array", items: { type: "string" } },
                urlPatterns: { type: "array", items: { type: "string" } },
              },
              required: [],
              additionalProperties: false,
            },
            onMismatch: { type: "string", enum: ["no-match", "clarify", "page-agent"] },
          },
          required: ["kind", "onMismatch"],
          additionalProperties: false,
        },
      },
      required: ["name", "description", "aliases", "intent", "parameters"],
      additionalProperties: false,
    },
  },
};
