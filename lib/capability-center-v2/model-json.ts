import { modelChatCompletionsUrl, modelCompatibility, type ModelConfig } from "../model-config";
import { applyProviderThinkingPolicy } from "../site-knowledge/provider-payload-policy";
import { modelRetryAfterMs, withModelProviderGate } from "../site-knowledge/model-provider-gate";

export type StructuredModelAttempt = {
  attempt: number;
  durationMs: number;
  responseFormat: "json_schema" | "json_object";
  finishReason?: string;
  contentLength?: number;
  contentPreview?: string;
  error?: string;
};

export type StructuredModelJsonSchema = {
  name: string;
  description?: string;
  strict?: boolean;
  schema: Record<string, unknown>;
};

export function parseStructuredModelJson(content: string) {
  if (!content.trim()) throw new Error("structured_model_empty_response");
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
  if (!candidate.trim()) throw new Error("structured_model_json_missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`structured_model_json_invalid:${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("structured_model_object_required");
  return parsed as Record<string, unknown>;
}

export async function requestStructuredModelJson(
  config: ModelConfig,
  input: {
    system: string;
    payload: unknown;
    timeoutMs?: number;
    maxTokens?: number;
    attempts?: number;
    jsonSchema?: StructuredModelJsonSchema;
    validate?: (value: Record<string, unknown>) => void;
    onAttempt?: (attempt: StructuredModelAttempt) => void;
    /** Disable provider reasoning for background turns whose output no one watches live. */
    disableThinking?: boolean;
  },
) {
  if (!config.configured) throw new Error("structured_model_not_configured");
  const attempts = Math.max(1, Math.min(input.attempts ?? 2, 3));
  let lastError: unknown;
  let invalidContent = "";
  let invalidReason = "";
  let rateLimitRetries = 0;
  const compatibility = modelCompatibility(config);
  let useJsonSchema = Boolean(input.jsonSchema) && compatibility.nativeJsonSchema;
  const schemaInstruction = input.jsonSchema
    ? `\n\n必须遵循以下 JSON Schema；即使当前服务降级为 json_object，也必须保持相同字段、必填项和枚举：\n${JSON.stringify(input.jsonSchema.schema)}`
    : "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = Date.now();
    const requestTimeoutMs = input.timeoutMs ?? Number(process.env.CAPABILITY_V2_MODEL_TIMEOUT_MS || 180_000);
    const abortController = new AbortController();
    const abortTimer = setTimeout(() => {
      abortController.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    }, requestTimeoutMs);
    let finishReason: string | undefined;
    let content = "";
    let httpStatus: number | undefined;
    let retryAfterMs = 0;
    const responseFormat = useJsonSchema ? "json_schema" as const : "json_object" as const;
    const request: Record<string, unknown> = {
      model: config.model,
      temperature: 0,
      ...compatibility.requestBody,
      ...(!compatibility.omitStructuredMaxTokens ? { max_tokens: input.maxTokens ?? 4096 } : {}),
      response_format: input.jsonSchema && useJsonSchema
        ? {
          type: "json_schema",
          json_schema: {
            name: input.jsonSchema.name,
            ...(input.jsonSchema.description ? { description: input.jsonSchema.description } : {}),
            strict: input.jsonSchema.strict !== false,
            schema: input.jsonSchema.schema,
          },
        }
        : { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `${input.system}${schemaInstruction}\n\n输出协议：只输出一个可被 JSON.parse 直接解析的 JSON 对象；所有键和字符串必须使用双引号，不要输出 Markdown、注释或对象之外的文字。`,
        },
        { role: "user", content: JSON.stringify(input.payload) },
        ...(invalidContent
          ? [
            { role: "assistant", content: invalidContent.slice(0, 4_000) },
            {
              role: "user",
              content: `上一条回复不符合结构化输出协议（${invalidReason || "validation_failed"}）。请按括号中的原因修正（可能是语法、字段结构，也可能是字段内容），并重新输出完整 JSON 对象；不要解释，也不要省略任何必需字段。`,
            },
          ]
          : []),
      ],
    };
    // Background turns have no live reader: reasoning adds latency without
    // adding perceived quality. The policy maps the ask to the provider's own
    // verified switch, or strips every thinking field for an unverified one.
    const requestBody = input.disableThinking
      ? applyProviderThinkingPolicy({ baseUrl: config.baseUrl, model: config.model, payload: request })
      : request;
    try {
      const response = await withModelProviderGate(config, () => fetch(modelChatCompletionsUrl(config.baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify(requestBody),
          signal: abortController.signal,
        }));
      httpStatus = response.status;
      if (!response.ok) {
        if (response.status === 429) retryAfterMs = modelRetryAfterMs(response);
        throw new Error(`structured_model_http_${response.status}`);
      }
      const body = await response.json() as { choices?: Array<{ finish_reason?: string; message?: { content?: string | null } }> };
      const choice = body.choices?.[0];
      finishReason = choice?.finish_reason;
      content = choice?.message?.content || "";
      const parsed = parseStructuredModelJson(content);
      input.validate?.(parsed);
      input.onAttempt?.({ attempt, durationMs: Date.now() - startedAt, responseFormat, finishReason, contentLength: content.length });
      return parsed;
    } catch (error) {
      lastError = error;
      if (content.trim()) {
        invalidContent = content;
        invalidReason = error instanceof Error ? error.message : String(error);
      }
      input.onAttempt?.({
        attempt,
        durationMs: Date.now() - startedAt,
        responseFormat,
        finishReason,
        contentLength: content.length,
        contentPreview: content.slice(0, 2_000),
        error: error instanceof Error ? error.message : String(error),
      });
      const timeoutLike = abortController.signal.aborted
        || (error instanceof Error && (error.name === "TimeoutError" || /aborted due to timeout|timed?\s*out/i.test(error.message)));
      if (httpStatus === 429) {
        // A provider rate limit gets one bounded, header-aware retry even when
        // the caller allowed three attempts for malformed JSON. Additional
        // protocol repair attempts would only create another burst.
        if (rateLimitRetries >= 1 || attempt >= attempts) break;
        rateLimitRetries += 1;
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs || 1_500));
        continue;
      }
      if (useJsonSchema && ((httpStatus && [400, 404, 422].includes(httpStatus)) || timeoutLike)) {
        // Some OpenAI-compatible providers or model versions do not implement
        // json_schema, and a few gateways leave unsupported schema requests
        // open until the client timeout instead of returning a protocol 4xx.
        // Preserve the exact schema in the system instruction and business
        // validator while retrying once with json_object. Malformed schema-mode
        // content still retries under the same strict schema.
        useJsonSchema = false;
        invalidContent = "";
        invalidReason = "";
      }
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      clearTimeout(abortTimer);
    }
  }
  throw lastError;
}
