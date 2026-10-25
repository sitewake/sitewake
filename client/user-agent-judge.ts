import { parseTaskOutcomeDecision, type TaskJudgeEvidence, type TaskOutcomeDecision } from "../lib/site-knowledge/task-outcome";
import { replyLanguageInstruction, resolveWidgetLocale, widgetCopy, type WidgetLocale } from "./user-agent-copy";

function endpointUrl(endpoint: string, path: string) {
  return endpoint ? `${endpoint.replace(/\/$/, "")}${path}` : path;
}

const judgeSystemPrompt = [
  "你是独立的网页任务结果 Judge。Actor 负责操作网页，你只根据用户目标与执行证据判断业务结果。", // i18n-exempt: model prompt body; the Judge reads it, the visitor never does
  "", // i18n-exempt: model prompt body; the Judge reads it, the visitor never does
  "规则：", // i18n-exempt: model prompt body; the Judge reads it, the visitor never does
  "1. 不信任 Actor 的 success/failure 自报，它只是一项证据。", // i18n-exempt: model prompt body; the Judge reads it, the visitor never does
  "2. 不扫描关键词下结论。正文、新闻、商品描述中偶然出现“无法”“没有”“失败”等词，不代表任务失败。", // i18n-exempt: model prompt body; the Judge reads it, the visitor never does
  "3. success：证据足以证明用户目标已完成；no-result：查询没有结果，或操作开始前明确没有可操作的业务对象（如空集合、没有匹配记录）；business-rejection：业务对象存在，但操作被权限、库存、对象状态或业务规则明确拒绝。", // i18n-exempt: model prompt body; the Judge reads it, the visitor never does
  "4. needs-more-work：页面仍可继续操作，并能明确指出下一步；unknown：证据不足且没有可靠的继续方向。", // i18n-exempt: model prompt body; the Judge reads it, the visitor never does
  "5. URL、标题、核心内容、控件变化和执行轨迹应结合目标解释，不能把“页面发生变化”直接等同成功。", // i18n-exempt: model prompt body; the Judge reads it, the visitor never does
  "6. 对“打开/查看/进入/到达某页面或榜单”这类导航目标：如果 after.url、after.title、after.heading、highlights.afterMatchedSnippets 或 changedSnippets 已经明确对应目标页面/内容，应判 success；不要要求额外搜索或额外点击。", // i18n-exempt: model prompt body; the Judge reads it, the visitor never does
  "7. 对“搜索/查询/找到某关键词”这类目标：如果用户没有给出必要关键词，判 needs-more-work，并在 nextInstruction 中要求补充关键词；如果已经执行查询且页面明确无结果，判 no-result。", // i18n-exempt: model prompt body; the Judge reads it, the visitor never does
  "8. summary 是直接给最终用户看的自然语言结果；不要谈训练、Selector、候选知识或内部实现。", // i18n-exempt: model prompt body; the Judge reads it, the visitor never does
  "9. evidence 只列与目标直接相关的可核验证据；missingEvidence 说明尚缺什么。", // i18n-exempt: model prompt body; the Judge reads it, the visitor never does
].join("\n");

function parseJsonObject(text: string | undefined) {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { /* try extracting below */ }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    try { return JSON.parse(fenced); } catch { /* ignore */ }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* ignore */ }
  }
  return undefined;
}

export async function judgeTaskOutcome(options: {
  endpoint: string;
  siteAgentId: string;
  agentRunToken: string;
  evidence: TaskJudgeEvidence;
  /** The language the summary is written in; the caller knows the site's. */
  replyLocale?: WidgetLocale;
  signal?: AbortSignal;
  telemetry?: { learningJobId?: string; stage?: "outcome-judge" | "runtime-agent" };
}): Promise<TaskOutcomeDecision | undefined> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(endpointUrl(options.endpoint, `/api/site-agents/${encodeURIComponent(options.siteAgentId)}/model/v2/chat/completions`), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.agentRunToken}`, ...(options.telemetry?.learningJobId ? { "x-sitewake-learning-job-id": options.telemetry.learningJobId } : {}), "x-sitewake-ai-stage": options.telemetry?.stage || "outcome-judge" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: `${judgeSystemPrompt}\n${replyLanguageInstruction(options.replyLocale || resolveWidgetLocale())}` },
          { role: "user", content: JSON.stringify(options.evidence) },
        ],
        tools: [{
          type: "function",
          function: {
            name: "report_outcome",
            description: "提交独立核验后的网页任务业务结果", // i18n-exempt: model prompt body; the Judge reads it, the visitor never does
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: {
                status: { type: "string", enum: ["success", "no-result", "business-rejection", "needs-more-work", "unknown"] },
                code: { type: "string" },
                summary: { type: "string" },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                evidence: { type: "array", items: { type: "string" } },
                missingEvidence: { type: "array", items: { type: "string" } },
                nextInstruction: { type: "string" },
              },
              required: ["status", "code", "summary", "confidence", "evidence", "missingEvidence"],
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "report_outcome" } },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> };
    const call = payload.choices?.[0]?.message?.tool_calls?.find((item) => item.function?.name === "report_outcome");
    const unconfirmed = widgetCopy(options.replyLocale || resolveWidgetLocale()).run.outcomeUnconfirmed;
    if (call?.function?.arguments) return parseTaskOutcomeDecision(JSON.parse(call.function.arguments), unconfirmed);
    return parseTaskOutcomeDecision(parseJsonObject(payload.choices?.[0]?.message?.content), unconfirmed);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}
