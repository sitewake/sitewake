type JsonRecord = Record<string, unknown>;

export type ResponsesConversation = {
  items: unknown[];
  instructions?: string;
  tools?: unknown[];
};

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function textContent(value: unknown) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    const item = record(part);
    return typeof item?.text === "string" ? item.text : typeof item?.content === "string" ? item.content : "";
  }).filter(Boolean).join("\n");
}

function inputItems(value: unknown): unknown[] {
  if (typeof value === "string") return [{ role: "user", content: value }];
  return Array.isArray(value) ? value : [];
}

const AUTHORING_NAMESPACE = "mcp__sitewake_authoring";
const AUTHORING_TOOL_NAMES = new Set(["get_dom", "execute_js", "write_file", "run_draft"]);

/**
 * The authoring model proxy is a narrow capability boundary, not a general
 * Codex gateway. Codex also advertises shell, planning, goal and plugin tools;
 * forwarding those distracts the coding model and grants authority the
 * task-scoped harness never intended to expose.
 */
export function authoringResponsesTools(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const tool = record(raw);
    if (tool?.type !== "namespace"
      || tool.name !== AUTHORING_NAMESPACE
      || !Array.isArray(tool.tools)) return [];
    const tools = tool.tools.filter((rawNested) => {
      const nested = record(rawNested);
      return nested?.type === "function"
        && typeof nested.name === "string"
        && AUTHORING_TOOL_NAMES.has(nested.name);
    });
    return tools.length ? [{ ...tool, tools }] : [];
  });
}

/**
 * Responses clients such as Codex normally send only the new tool output plus
 * `previous_response_id`. Chat Completions is stateless, so the compatibility
 * route must restore the preceding function call before forwarding the turn.
 */
export function continueResponsesConversation(body: JsonRecord, previous?: ResponsesConversation) {
  const current = inputItems(body.input);
  const conversation: ResponsesConversation = {
    items: [...(previous?.items || []), ...current],
    instructions: typeof body.instructions === "string" ? body.instructions : previous?.instructions,
    tools: Array.isArray(body.tools) ? body.tools : previous?.tools,
  };
  return {
    body: {
      ...body,
      input: conversation.items,
      ...(conversation.instructions ? { instructions: conversation.instructions } : {}),
      ...(conversation.tools ? { tools: conversation.tools } : {}),
    },
    conversation,
  };
}

export function appendResponsesOutput(conversation: ResponsesConversation, output: unknown) {
  return {
    ...conversation,
    items: [...conversation.items, ...(Array.isArray(output) ? output : [])],
  };
}

export function responsesToChatRequest(body: JsonRecord, model: string) {
  const messages: JsonRecord[] = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) messages.push({ role: "system", content: body.instructions });
  const input = typeof body.input === "string" ? [{ role: "user", content: body.input }] : Array.isArray(body.input) ? body.input : [];
  const pendingCalls = new Map<string, JsonRecord>();
  const deferredAssistantMessages: JsonRecord[] = [];
  for (const raw of input) {
    const item = record(raw);
    if (!item) continue;
    if (item.type === "function_call") {
      const callId = String(item.call_id || item.id || `call_${messages.length + 1}`);
      pendingCalls.set(callId, item);
      continue;
    }
    if (item.type === "function_call_output") {
      const callId = String(item.call_id || "");
      const call = pendingCalls.get(callId);
      if (call) {
        const callName = typeof call.namespace === "string" && call.namespace
          ? `${call.namespace}__${String(call.name || "")}`
          : String(call.name || "");
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [{ id: callId, type: "function", function: { name: callName, arguments: String(call.arguments || "{}") } }],
        });
        pendingCalls.delete(callId);
      }
      messages.push({ role: "tool", tool_call_id: callId, content: textContent(item.output) || JSON.stringify(item.output ?? "") });
      if (!pendingCalls.size && deferredAssistantMessages.length) messages.push(...deferredAssistantMessages.splice(0));
      continue;
    }
    // Some Chat-compatible gateways do not accept the Responses-only
    // `developer` role. It has the same precedence as our system instruction
    // for this internal authoring adapter.
    const role = item.role === "developer" ? "system" : item.role === "assistant" || item.role === "system" ? item.role : "user";
    const content = textContent(item.content);
    if (content) {
      const message = { role, content };
      if (role === "assistant" && pendingCalls.size) deferredAssistantMessages.push(message);
      else messages.push(message);
    }
  }
  if (deferredAssistantMessages.length) messages.push(...deferredAssistantMessages);
  const tools = (Array.isArray(body.tools) ? body.tools : []).flatMap((raw) => {
    const tool = record(raw);
    if (!tool || typeof tool.name !== "string") return [];
    if (tool.type === "function") return [{ type: "function", function: { name: tool.name, description: String(tool.description || ""), parameters: record(tool.parameters) || { type: "object", properties: {} } } }];
    if (tool.type !== "namespace" || !tool.name.startsWith("mcp__") || !Array.isArray(tool.tools)) return [];
    return tool.tools.flatMap((rawNested) => {
      const nested = record(rawNested);
      if (!nested || nested.type !== "function" || typeof nested.name !== "string") return [];
      return [{
        type: "function",
        function: {
          name: `${tool.name}__${nested.name}`,
          description: String(nested.description || tool.description || ""),
          parameters: record(nested.parameters) || { type: "object", properties: {} },
        },
      }];
    });
  });
  const rawToolChoice = body.tool_choice;
  const toolChoice = (() => {
    const choice = record(rawToolChoice);
    if (!choice || choice.type !== "function") return rawToolChoice || "auto";
    const chatFunction = record(choice.function);
    if (typeof chatFunction?.name === "string") return choice;
    if (typeof choice.name !== "string") return choice;
    const name = typeof choice.namespace === "string" && choice.namespace
      ? `${choice.namespace}__${choice.name}`
      : choice.name;
    return { type: "function", function: { name } };
  })();
  return {
    model,
    messages,
    ...(tools.length ? { tools, tool_choice: toolChoice, parallel_tool_calls: false } : {}),
    stream: false,
  };
}

export function chatToResponse(body: unknown, model: string) {
  const source = record(body) || {};
  const choice = record(Array.isArray(source.choices) ? source.choices[0] : undefined) || {};
  const message = record(choice.message) || {};
  const responseId = String(source.id || `resp_${crypto.randomUUID()}`);
  const output: JsonRecord[] = [];
  for (const raw of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const call = record(raw);
    const fn = record(call?.function);
    if (!call || !fn || typeof fn.name !== "string") continue;
    const callId = String(call.id || `call_${crypto.randomUUID()}`);
    const namespaceBoundary = fn.name.startsWith("mcp__") ? fn.name.lastIndexOf("__") : -1;
    const namespace = namespaceBoundary > 4 ? fn.name.slice(0, namespaceBoundary) : undefined;
    const name = namespace ? fn.name.slice(namespaceBoundary + 2) : fn.name;
    output.push({
      id: `fc_${crypto.randomUUID()}`,
      type: "function_call",
      call_id: callId,
      ...(namespace ? { namespace } : {}),
      name,
      arguments: String(fn.arguments || "{}"),
      status: "completed",
    });
  }
  const content = typeof message.content === "string" ? message.content : "";
  if (content) output.push({
    id: `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: content, annotations: [] }],
  });
  const usage = record(source.usage) || {};
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    model,
    output,
    parallel_tool_calls: false,
    tool_choice: "auto",
    tools: [],
    usage: {
      input_tokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
      output_tokens: Number(usage.completion_tokens || usage.output_tokens || 0),
      total_tokens: Number(usage.total_tokens || 0),
    },
  };
}

export function responseEventStream(response: ReturnType<typeof chatToResponse>) {
  const events: JsonRecord[] = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.in_progress", response: { ...response, status: "in_progress", output: [] } },
  ];
  response.output.forEach((item, outputIndex) => {
    const emptyItem = item.type === "function_call"
      ? { ...item, status: "in_progress", arguments: "" }
      : { ...item, status: "in_progress", content: [] };
    events.push({ type: "response.output_item.added", output_index: outputIndex, item: emptyItem });
    if (item.type === "function_call") {
      events.push({ type: "response.function_call_arguments.delta", output_index: outputIndex, item_id: item.id, delta: item.arguments });
      events.push({ type: "response.function_call_arguments.done", output_index: outputIndex, item_id: item.id, ...(item.namespace ? { namespace: item.namespace } : {}), name: item.name, arguments: item.arguments });
    } else {
      const content = Array.isArray(item.content) ? record(item.content[0]) : undefined;
      if (content) {
        events.push({ type: "response.content_part.added", output_index: outputIndex, content_index: 0, item_id: item.id, part: { ...content, text: "" } });
        events.push({ type: "response.output_text.delta", output_index: outputIndex, content_index: 0, item_id: item.id, delta: content.text });
        events.push({ type: "response.output_text.done", output_index: outputIndex, content_index: 0, item_id: item.id, text: content.text });
        events.push({ type: "response.content_part.done", output_index: outputIndex, content_index: 0, item_id: item.id, part: content });
      }
    }
    events.push({ type: "response.output_item.done", output_index: outputIndex, item });
  });
  events.push({ type: "response.completed", response });
  return `${events.map((event, sequenceNumber) => {
    const sequenced = { ...event, sequence_number: sequenceNumber };
    return `event: ${event.type}\ndata: ${JSON.stringify(sequenced)}\n\n`;
  }).join("")}data: [DONE]\n\n`;
}
