import { modelChatCompletionsUrl, modelCompatibility, type ModelConfig } from "../../lib/model-config";
import { applyProviderThinkingPolicy } from "../../lib/site-knowledge/provider-payload-policy";
import { modelRetryAfterMs, withModelProviderGate } from "../../lib/site-knowledge/model-provider-gate";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ToolCallingMessage = Record<string, unknown>;
export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseCalls(message: Record<string, unknown>): ToolCall[] {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return calls.map((raw, index) => {
    const call = record(raw);
    const fn = record(call.function);
    if (call.type !== undefined && call.type !== "function") throw new Error(`tool_call_type_invalid:${index}`);
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) throw new Error("tool_call_name_required");
    if (typeof call.id !== "string" || !call.id.trim()) throw new Error(`tool_call_id_required:${index}`);
    return {
      id: call.id,
      type: "function" as const,
      function: {
        name,
        arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}),
      },
    };
  });
}

function validateSchema(value: unknown, schemaValue: unknown, path = "arguments") {
  const schema = record(schemaValue);
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`tool_arguments_object_required:${path}`);
    const item = value as Record<string, unknown>;
    const properties = record(schema.properties);
    const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
    for (const key of required) if (!(key in item)) throw new Error(`tool_argument_required:${path}.${key}`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(item)) if (!(key in properties)) throw new Error(`tool_argument_unknown:${path}.${key}`);
    }
    for (const [key, child] of Object.entries(item)) if (key in properties) validateSchema(child, properties[key], `${path}.${key}`);
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`tool_argument_string_required:${path}`);
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`tool_argument_enum_invalid:${path}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) throw new Error(`tool_argument_too_long:${path}`);
    if (typeof schema.minLength === "number" && value.length < schema.minLength) throw new Error(`tool_argument_too_short:${path}`);
    return;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) throw new Error(`tool_argument_number_required:${path}`);
    if (typeof schema.minimum === "number" && value < schema.minimum) throw new Error(`tool_argument_below_minimum:${path}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) throw new Error(`tool_argument_above_maximum:${path}`);
    return;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`tool_argument_boolean_required:${path}`);
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`tool_argument_array_required:${path}`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) throw new Error(`tool_argument_too_many_items:${path}`);
    for (let index = 0; index < value.length; index += 1) validateSchema(value[index], schema.items, `${path}.${index}`);
  }
}

export function parseAndValidateToolArguments(call: ToolCall, tool: ToolDefinition) {
  let parsed: unknown;
  try { parsed = JSON.parse(call.function.arguments); }
  catch { throw new Error(`tool_arguments_json_invalid:${call.function.name}`); }
  validateSchema(parsed, tool.function.parameters);
  return parsed as Record<string, unknown>;
}

function assistantMessage(message: Record<string, unknown>, calls: ToolCall[]): ToolCallingMessage {
  return {
    role: "assistant",
    content: typeof message.content === "string" ? message.content : null,
    tool_calls: calls,
    ...(typeof message.reasoning_content === "string" ? { reasoning_content: message.reasoning_content } : {}),
  };
}

function requestPayload(input: {
  config: ModelConfig;
  compatibility: ReturnType<typeof modelCompatibility>;
  tools: readonly ToolDefinition[];
  messages: ToolCallingMessage[];
  maxTokens?: number;
  disableThinking?: boolean;
}) {
  const payload: Record<string, unknown> = {
    model: input.config.model,
    temperature: 0,
    ...input.compatibility.requestBody,
    max_tokens: input.maxTokens ?? 16_000,
    parallel_tool_calls: false,
    tool_choice: "auto",
    tools: input.tools,
    messages: input.messages,
  };
  if (!input.disableThinking) return payload;

  return applyProviderThinkingPolicy({
    baseUrl: input.config.baseUrl,
    model: input.config.model,
    payload,
  });
}

async function withModelRequestTimeout<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  }, timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("tool_calling_model_timeout");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function requestToolCallingTurn(input: {
  config: ModelConfig;
  messages: ToolCallingMessage[];
  tools: readonly ToolDefinition[];
  maxTokens?: number;
  timeoutMs?: number;
  protocolRepairAttempts?: number;
  /** Disable provider reasoning for short, schema-constrained author turns. */
  disableThinking?: boolean;
}) {
  if (!input.config.configured) throw new Error("tool_calling_model_not_configured");
  const repairAttempts = Math.max(0, Math.min(input.protocolRepairAttempts ?? 1, 1));
  const compatibility = modelCompatibility(input.config);
  let lastError: unknown;
  const repairMessages: ToolCallingMessage[] = [];
  for (let attempt = 0; attempt <= repairAttempts; attempt += 1) {
    const timeoutMs = input.timeoutMs ?? 120_000;
    let payload: { choices?: Array<{ finish_reason?: string; message?: Record<string, unknown> }> };
    try {
      payload = await withModelRequestTimeout(timeoutMs, async (signal) => {
        let providerAttempt = 0;
        while (true) {
          const response = await withModelProviderGate(input.config, () => fetch(modelChatCompletionsUrl(input.config.baseUrl), {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${input.config.apiKey}` },
            body: JSON.stringify(requestPayload({
              config: input.config,
              compatibility,
              maxTokens: input.maxTokens,
              disableThinking: input.disableThinking,
              tools: input.tools,
              messages: [...input.messages, ...repairMessages],
            })),
            signal,
          }));
          if (response.status === 429 && providerAttempt < 1) {
            await response.text().catch(() => "");
            providerAttempt += 1;
            await new Promise((resolve) => setTimeout(resolve, modelRetryAfterMs(response)));
            continue;
          }
          if (!response.ok) {
            const detail = (await response.text()).slice(0, 800);
            throw new Error(`tool_calling_model_http_${response.status}:${detail}`);
          }
          return await response.json() as { choices?: Array<{ finish_reason?: string; message?: Record<string, unknown> }> };
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "tool_calling_model_timeout" || (error instanceof Error && error.name === "TimeoutError") || /aborted due to timeout|timed?\s*out/i.test(message)) throw new Error("tool_calling_model_timeout");
      throw error;
    }
    const message = payload.choices?.[0]?.message || {};
    try {
      const calls = parseCalls(message);
      if (!calls.length) throw new Error("tool_call_required");
      const byName = new Map(input.tools.map((tool) => [tool.function.name, tool]));
      for (const call of calls) {
        const tool = byName.get(call.function.name);
        if (!tool) throw new Error(`tool_call_unknown:${call.function.name}`);
        parseAndValidateToolArguments(call, tool);
      }
      return { message: assistantMessage(message, calls), calls, finishReason: payload.choices?.[0]?.finish_reason };
    } catch (error) {
      lastError = error;
      if (attempt >= repairAttempts) break;
      repairMessages.push({
        role: "assistant",
        content: typeof message.content === "string" ? message.content.slice(0, 4_000) : null,
        ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
        ...(typeof message.reasoning_content === "string" ? { reasoning_content: message.reasoning_content.slice(0, 8_000) } : {}),
      });
      repairMessages.push({ role: "user", content: `上一条回复违反 Function Calling 协议（${error instanceof Error ? error.message : String(error)}）。必须使用已声明工具，并提交符合工具 JSON Schema 的参数；不要用普通文本代替工具调用。` });
    }
  }
  throw lastError instanceof Error ? lastError : new Error("tool_calling_protocol_invalid");
}
