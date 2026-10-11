import { BUSINESS_RESULT_GUIDANCE } from "./business-result";
import type { VersionedPrompt } from "../../../lib/capability-center-v2/prompt";

export const CAPABILITY_SPEC_PROMPT: VersionedPrompt = {
  key: "capability-v2.capability-spec",
  version: "2.7.0",
  text: [
    "你是浏览器能力的参数设计器。在执行探索前，把一次具体请求设计成可复用能力。",
    "若输入带有 experience，它只是终端 PageAgent 的成功证据：originalGoal 是原始具体请求，actions/output 用于识别实例值；不得把动作下标或页面定位信息当作 Program 直接照搬。",
    "能力意图、名称和描述必须保留用户的完整最终动作；进入详情页等中间导航不是最终能力，不得把‘加入购物车’改写成‘查看详情’。",
    "区分动作本身与本次实例值：商品、搜索词、收件人、日期、数量等可变化对象必须成为 required 参数；按钮文案和固定业务规则不是参数。",
    "遇到‘棕色的垫子’、‘白色马克杯’这类带修饰词的自然请求，不要把整句作为唯一 productKeyword：优先拆成 productType/query 与 color/material/size 等独立业务输入，并在探索中先用稳定主体词检索、再按修饰条件匹配目标。只有站点明确支持整句检索时才保留组合词。",
    "如果用户语言与页面语言不同，siteTerms 必须为参数提供页面证据中真实出现的等价词（例如 from=‘垫子’对应页面中的 value=‘cushion’）；每个 groundingExample 的不同业务值都应给出对应 from/value。对于页面正文/元素中能看到的可复用商品类别、材质和颜色，应尽量补充常见用户语言到页面词的多条别名，而不只覆盖本次 demonstrationInput。只输出页面正文/元素中出现过的词，不得臆造。它是运行时别名，不改变用户输入契约。",
    "用户目标中的商品主体必须与页面证据中的同一业务对象对齐；不能因为页面里出现了另一个商品，就把‘垫子’映射成 t-shirt、把‘马克杯’映射成 poster 等无关值。若目标主体或其页面语言等价词没有在当前探索证据中出现，应让本次 Discovery 失败并重新探索，不得生成看似成功但语义错误的能力。",
    "如果 payload 带有 aliasRepairMissing，必须逐项补齐这些参数的 siteTerms；每一项都要从当前页面正文或元素证据中找到真实出现的页面词。不能省略、不能把用户语言原值直接当成页面词。",
    "先做作用域抽象：当前分类、筛选器、详情页、固定 href 和本次探索路径都是上下文证据，不是能力语义。优先使用站点级全局搜索，让搜索词/商品等业务输入驱动路径；只有用户明确要求分类且分类本身成为输入参数时才允许 category-scoped。",
    "scope.kind=site-global 表示能力应可跨分类复用；scope.kind=category-scoped 或 page-scoped 时必须如实标记，并把可确定的 requiredInputPaths、tokens 或 urlPatterns 放入 scope.match，不能把‘在餐具目录里搜索’概括成任意商品搜索。scope 只允许 kind、match 和 onMismatch。",
    "elementIndex、selector、locator、xpath、testId 等页面实现细节绝不是业务参数，禁止放入 parameters。",
    "如果从页面证据中找不到至少两个可独立回放的有效实例，不要虚假泛化：保留具体能力名称且 parameters 返回空数组。",
    "参数只有在 suppliedParameters、experience/output、页面控件初始状态、动作回执或管理员/系统策略中有可追溯证据时才允许给 defaultValue；必须同时给出 defaultEvidence.source（page-control/action-receipt/business-output/admin/policy）和可定位的 defaultEvidence.ref。不能凭常识推断默认值。",
    "有 defaultValue 的参数必须 required=false；没有可靠证据时不要输出 defaultValue，并保持参数 required。",
    "一旦从名称或描述去掉具体实例值，必须在 parameters 中声明该值，并给出本次 exampleValue。",
    "参数化能力必须从页面证据给出至少两个不同的 groundingExamples；每个 example 必须以参数名为 key、实际示例值为 value。对于 product/productType/item/category/query 等目标参数，至少两个 example 必须使用不同的真实业务对象或查询词；仅改变 quantity 不算独立目标样例。",
    "如果初始 groundingExamples 少于两个，或目标参数在所有 example 中相同，必须从 page.text 或 elements 中挑选第二个真实可见商品/业务对象（优先使用完整可见名称），数量等数值可以采用不同有效值；不得凭常识臆造页面不存在的商品、颜色或路由。",
    "groundingExamples 只供 C1 根据页面证据编写和私有回放候选能力；它们不是正式测试用例，不是 ValidationSuite，也不代表 C1 承担 C2 的用例生成职责。",
  ].join("\n"),
  outputSchema: {
    name: "capability_v2_specification",
    description: "可复用浏览器能力的参数与页面证据样例设计",
    strict: true,
    schema: {
      type: "object",
      properties: {
        intent: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        aliases: { type: "array", items: { type: "string" } },
        parameters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", enum: ["string", "number", "boolean"] },
              description: { type: "string" },
              required: { type: "boolean" },
              exampleValue: {},
              defaultValue: {},
              defaultEvidence: {
                type: "object",
                properties: {
                  source: { type: "string", enum: ["page-control", "action-receipt", "business-output", "admin", "policy"] },
                  ref: { type: "string" },
                },
                required: ["source", "ref"],
                additionalProperties: false,
              },
            },
            required: ["name", "type", "description", "required", "exampleValue"],
            additionalProperties: false,
          },
        },
        groundingExamples: { type: "array", items: { type: "object" } },
        siteTerms: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, from: { type: "string" }, value: { type: "string" } },
            required: ["name", "value"],
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
              additionalProperties: false,
            },
            onMismatch: { type: "string", enum: ["no-match", "clarify", "page-agent"] },
          },
          required: ["kind", "onMismatch"],
          additionalProperties: false,
        },
      },
      required: ["intent", "name", "description", "aliases", "parameters", "groundingExamples", "siteTerms"],
      additionalProperties: false,
    },
  },
};

export const CAPABILITY_CONTRACT_PROMPT: VersionedPrompt = {
  key: "capability-v2.capability-contract",
  version: "2.8.0",
  text: [
    "把已成功的浏览器探索整理成能力 Contract。能力名称、意图和输入参数必须严格服从 parameterPlan，不能擅自扩大适用范围。",
    "成功条件必须验证正确对象与最终业务结果，优先使用 urlIncludes、textIncludes、outputExists、outputEquals。",
    BUSINESS_RESULT_GUIDANCE,
    "explorationOutputKeys 仅表示探索器已提取的字段，不是公开输出白名单。根据 successEvidence 中实际可观察的业务结果设计输出；后续 JavaScript stage_verify 可以补充读取这些字段，不受旧探索 DSL result 只有 pageUrl/pageTitle 的限制。",
    "Contract 的 outputSchema 必须与最终 stage_verify 的业务输出一致；每个 required output 都必须能由最终验证 Stage 的 Stage I/O writes.output 声明并返回。中间事实放入 Stage state，不要把调试字段或内部收据伪装成公开 output。",
    "页面跳转不是 Contract 的隐式副作用。Contract 只描述业务前置条件、成功条件和公开结果；同源页面迁移由 Program Stage 返回 navigation intent，由宿主在提交 state/cursor/Completed receipt 与 handoff 后执行。禁止把 location、form.submit 或旧导航 helper 写进 Contract 语义。",
    "条件包含输入值时使用 textTemplate 或 urlTemplate，不能写死演示值。",
    "条件必须使用唯一的规范结构：textIncludes/urlIncludes 使用 value；textTemplate/urlTemplate 使用 template；inputExists/outputExists 使用 path；禁止混用这些字段。",
    "condition.type 只允许 urlIncludes、urlTemplate、textIncludes、textTemplate、inputExists、outputExists、outputEquals、modelGoal；不要创造 urlEquals 等新类型。",
    "参数化结果若已有 textTemplate/urlTemplate，不要再添加只对本次演示对象成立的固定详情 URL；固定 URL 条件必须对所有 groundingExamples 都成立。",
    "不要把包含 quantity/count/amount 的单复数购物车文案（例如 There is {{quantity}} item、购物车中有 {{quantity}} 件商品）作为跨 groundingExamples 的必选 textTemplate；数量必须由能力脚本的 stage_verify 和 C3 纯代码校验。",
    "探索阶段看到的成功 toast、dialog、live-region 或其他一次性完成文案不是稳定 Contract 条件；优先使用输出字段、目标证据和可重复的页面状态，瞬时文案由 Runner 的终态证据记录而不是跨上下文硬匹配。",
    "contract.scope 必须反映探索路径的真实业务范围。固定分类/页面路径不能被描述成 site-global；scope 只允许 kind、match 和 onMismatch，不携带 semantic、binding、generalizable 或 entryPolicy。scope 只用于解释和约束抽象，不替代可执行成功条件。",
    "outputSchema 必须是完整 JSON Schema 对象，顶层使用 type=object、properties、required 和 additionalProperties；不能把属性表直接当作 outputSchema。",
    "modelGoal 只能作为补充，不能是唯一成功条件。",
    "addressInputs：如果结果页面的地址里带着某个输入的值（例如按日期归档页 /daily/2026-09-20 带着日期，商品页 /p/AB-1024 带着编号），为该输入写一条 { path, addressValue }，addressValue 必须是 successEvidence.url 里逐字出现的那一段，保持地址里的原样写法，不要改成用户说话的写法。地址里没有带该输入的值就不要写它；地址里带的是探索时的固定栏目名或语言代码也不要写。",
    "addressValue 决定了这个能力被调用时该输入必须采用的书写格式：调用方会按它给出的样子填值。所以它要能代表同类值的通用写法，而不是只对这一次演示成立的特例。",
  ].join("\n"),
  outputSchema: {
    name: "capability_v2_contract",
    description: "能力输出、前置条件与成功条件",
    strict: true,
    schema: {
      type: "object",
      properties: {
        outputSchema: { type: "object" },
        preconditions: { type: "array", items: {} },
        successConditions: { type: "array", items: {} },
        addressInputs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              addressValue: { type: "string" },
            },
            required: ["path", "addressValue"],
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
              additionalProperties: false,
            },
            onMismatch: { type: "string", enum: ["no-match", "clarify", "page-agent"] },
          },
          required: ["kind", "onMismatch"],
          additionalProperties: false,
        },
      },
      required: ["outputSchema", "preconditions", "successConditions"],
      additionalProperties: false,
    },
  },
};
