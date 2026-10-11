import assert from "node:assert/strict";
import test from "node:test";
import { build as esbuildBuild } from "esbuild";
import { fileURLToPath } from "node:url";
import {
  appendResponsesOutput,
  authoringResponsesTools,
  chatToResponse,
  continueResponsesConversation,
  responseEventStream,
  responsesToChatRequest,
} from "../lib/site-knowledge/responses-protocol.ts";

async function loadMemoryModelResponseStore() {
  const result = await esbuildBuild({
    entryPoints: [fileURLToPath(new URL("../db/model-response-store.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "memory-only-d1",
      setup(build) {
        build.onResolve({ filter: /^\.\/index$/ }, (args) =>
          args.importer.endsWith("model-response-store.ts")
            ? { path: "memory-only-d1", namespace: "test" }
            : undefined);
        build.onLoad({ filter: /.*/, namespace: "test" }, () => ({
          contents: "export function getD1Binding() { return null; }",
          loader: "js",
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

async function loadResponsesRoute() {
  const result = await esbuildBuild({
    entryPoints: [fileURLToPath(new URL("../app/api/site-agents/[siteAgentId]/model/v2/responses/route.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "next-server-responses-stub",
      setup(build) {
        build.onResolve({ filter: /^next\/server$/ }, () => ({ path: "next-server", namespace: "responses-route-test" }));
        build.onLoad({ filter: /.*/, namespace: "responses-route-test" }, () => ({
          contents: "export class NextRequest extends Request {} export class NextResponse extends Response {}",
          loader: "js",
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const {
  readModelResponseConversation,
  saveModelResponseConversation,
} = await loadMemoryModelResponseStore();

test("authoring proxy exposes only its four task-scoped MCP tools", () => {
  const tools = authoringResponsesTools([
    { type: "function", name: "shell_command" },
    { type: "function", name: "get_goal" },
    {
      type: "namespace",
      name: "mcp__other",
      tools: [{ type: "function", name: "write_file" }],
    },
    {
      type: "namespace",
      name: "mcp__sitewake_authoring",
      tools: [
        ...["get_dom", "execute_js", "write_file", "run_draft"].map((name) => ({ type: "function", name })),
        { type: "function", name: "host_shell" },
      ],
    },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "mcp__sitewake_authoring");
  assert.deepEqual(tools[0].tools.map((tool) => tool.name), ["get_dom", "execute_js", "write_file", "run_draft"]);
});

test("Codex Responses tool continuations round-trip through the Chat model gateway", () => {
  const chat = responsesToChatRequest({
    instructions: "Build the capability.",
    input: [
      { role: "user", content: [{ type: "input_text", text: "Inspect the page" }] },
      { type: "function_call", call_id: "call_dom", name: "get_dom", arguments: "{}" },
      { type: "function_call_output", call_id: "call_dom", output: "{\"heading\":\"Search\"}" },
    ],
    tools: [{ type: "function", name: "get_dom", description: "Read DOM", parameters: { type: "object", properties: {} } }],
  }, "qwen");
  assert.equal(chat.messages[0].role, "system");
  assert.equal(chat.messages[2].tool_calls[0].function.name, "get_dom");
  assert.equal(chat.messages[3].tool_call_id, "call_dom");
  assert.equal(chat.tools[0].function.name, "get_dom");

  const response = chatToResponse({ id: "chat_1", choices: [{ message: { tool_calls: [{ id: "call_write", type: "function", function: { name: "run_draft", arguments: "{\"input\":{\"keyword\":\"许嵩\"}}" } }] } }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }, "qwen");
  assert.equal(response.output[0].type, "function_call");
  assert.equal(response.output[0].name, "run_draft");
  const stream = responseEventStream(response);
  assert.match(stream, /response\.function_call_arguments\.done/);
  assert.match(stream, /response\.completed/);
  assert.match(stream, /data: \[DONE\]/);
});

test("Responses named tool choice becomes the final Chat tool choice object", () => {
  const chat = responsesToChatRequest({
    input: "Inspect the page",
    tools: [{ type: "function", name: "get_dom", parameters: { type: "object", properties: {} } }],
    tool_choice: { type: "function", name: "get_dom" },
  }, "qwen3.8-max");
  assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "get_dom" } });

  const namespaced = responsesToChatRequest({
    input: "Inspect the page",
    tools: [{
      type: "namespace",
      name: "mcp__sitewake_authoring",
      tools: [{ type: "function", name: "get_dom", parameters: { type: "object", properties: {} } }],
    }],
    tool_choice: { type: "function", namespace: "mcp__sitewake_authoring", name: "get_dom" },
  }, "qwen3.8-max");
  assert.deepEqual(namespaced.tool_choice, {
    type: "function",
    function: { name: "mcp__sitewake_authoring__get_dom" },
  });
});

test("Responses proxy applies Qwen thinking policy to its final Chat payload", async () => {
  const route = await loadResponsesRoute();
  const previousFetch = globalThis.fetch;
  const previousEnvironment = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
  };
  const payloads = [];
  globalThis.fetch = async (_input, init) => {
    payloads.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({
      id: `chat-${payloads.length}`,
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const body = (toolChoice) => ({
    input: "Inspect the page",
    tools: [{
      type: "namespace",
      name: "mcp__sitewake_authoring",
      tools: [{ type: "function", name: "get_dom", parameters: { type: "object", properties: {} } }],
    }],
    tool_choice: toolChoice,
  });
  const invoke = (toolChoice) => route.POST(new Request("https://control.test/api/responses", {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify(body(toolChoice)),
  }), { params: { siteAgentId: "responses-policy-test" } });
  try {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    process.env.OPENAI_MODEL = "qwen3.8-max";
    assert.equal((await invoke("auto")).status, 200);
    assert.equal(payloads[0].enable_thinking, undefined);
    assert.equal(payloads[0].thinking, undefined);

    assert.equal((await invoke({ type: "function", namespace: "mcp__sitewake_authoring", name: "get_dom" })).status, 200);
    assert.deepEqual(payloads[1].tool_choice, {
      type: "function",
      function: { name: "mcp__sitewake_authoring__get_dom" },
    });
    assert.equal(payloads[1].enable_thinking, false);
    assert.equal(payloads[1].thinking, undefined);
    assert.equal(payloads.length, 2);

    process.env.OPENAI_BASE_URL = "https://unknown-compatible.example/v1";
    const rejected = await invoke({ type: "function", namespace: "mcp__sitewake_authoring", name: "get_dom" });
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).error.code, "forced_tool_choice_provider_unsupported");
    assert.equal(payloads.length, 2);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Responses previous_response_id turns restore the preceding function call for Chat", () => {
  const first = continueResponsesConversation({
    instructions: "Build the capability.",
    input: [{ role: "user", content: "Inspect the page" }],
    tools: [{ type: "function", name: "get_dom", parameters: { type: "object", properties: {} } }],
  });
  const previous = appendResponsesOutput(first.conversation, [
    { type: "function_call", call_id: "call_dom", name: "get_dom", arguments: "{}" },
  ]);
  const second = continueResponsesConversation({
    previous_response_id: "resp_1",
    input: [{ type: "function_call_output", call_id: "call_dom", output: "{\"heading\":\"Search\"}" }],
  }, previous);
  const chat = responsesToChatRequest(second.body, "qwen");

  assert.equal(chat.messages[0].role, "system");
  assert.equal(chat.messages[2].role, "assistant");
  assert.equal(chat.messages[2].tool_calls[0].id, "call_dom");
  assert.equal(chat.messages[3].role, "tool");
  assert.equal(chat.messages[3].tool_call_id, "call_dom");
  assert.equal(chat.tools[0].function.name, "get_dom");
});

test("Responses developer messages become gateway-compatible system messages", () => {
  const chat = responsesToChatRequest({
    input: [
      { role: "developer", content: [{ type: "input_text", text: "Follow the capability contract." }] },
      { role: "user", content: "Build it." },
    ],
  }, "qwen");
  assert.equal(chat.messages[0].role, "system");
  assert.equal(chat.messages[0].content, "Follow the capability contract.");
});

test("Responses namespaces flatten for Chat and tool outputs stay adjacent to their calls", () => {
  const chat = responsesToChatRequest({
    input: [
      { role: "user", content: "Inspect" },
      { type: "function_call", call_id: "call_dom", name: "mcp__sitewake_authoring__get_dom", arguments: "{}" },
      { role: "assistant", content: "I will inspect the page." },
      { type: "function_call_output", call_id: "call_dom", output: "{\"heading\":\"Search\"}" },
    ],
    tools: [{
      type: "namespace",
      name: "mcp__sitewake_authoring",
      tools: [{ type: "function", name: "get_dom", description: "Read DOM", parameters: { type: "object", properties: {} } }],
    }],
  }, "qwen");
  assert.equal(chat.tools[0].function.name, "mcp__sitewake_authoring__get_dom");
  assert.equal(chat.messages[1].tool_calls[0].id, "call_dom");
  assert.equal(chat.messages[2].role, "tool");
  assert.equal(chat.messages[3].role, "assistant");
  const response = chatToResponse({
    choices: [{
      message: {
        tool_calls: [{
          id: "call_dom",
          function: { name: "mcp__sitewake_authoring__get_dom", arguments: "{}" },
        }],
      },
    }],
  }, "qwen");
  assert.equal(response.output[0].namespace, "mcp__sitewake_authoring");
  assert.equal(response.output[0].name, "get_dom");

  const continued = continueResponsesConversation({
    previous_response_id: response.id,
    input: [{ type: "function_call_output", call_id: "call_dom", output: "{\"heading\":\"Search\"}" }],
    tools: [{
      type: "namespace",
      name: "mcp__sitewake_authoring",
      tools: [{ type: "function", name: "get_dom", description: "Read DOM", parameters: { type: "object", properties: {} } }],
    }],
  }, appendResponsesOutput({ items: [{ role: "user", content: "Inspect" }] }, response.output));
  const continuedChat = responsesToChatRequest(continued.body, "qwen");
  assert.equal(
    continuedChat.messages.find((message) => message.role === "assistant")?.tool_calls[0].function.name,
    "mcp__sitewake_authoring__get_dom",
  );
});

test("model response memory is isolated by site and expires stale conversations", async () => {
  const id = `resp_${crypto.randomUUID()}`;
  const conversation = { items: [{ role: "user", content: "site A" }] };
  await saveModelResponseConversation("site-a", id, conversation);
  assert.deepEqual(await readModelResponseConversation("site-a", id), conversation);
  assert.equal(await readModelResponseConversation("site-b", id), undefined);

  const expiredId = `resp_${crypto.randomUUID()}`;
  await saveModelResponseConversation("site-a", expiredId, conversation, -1);
  assert.equal(await readModelResponseConversation("site-a", expiredId), undefined);
});

test("Responses proxy accepts the internal token from a runner behind the model proxy, and still the provider key", async () => {
  const route = await loadResponsesRoute();
  const previousFetch = globalThis.fetch;
  const keys = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "CAPABILITY_V2_DISPATCH_TOKEN", "CAPABILITY_V2_RUNNER_TOKEN"];
  const previousEnvironment = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response(JSON.stringify({ id: `chat-${providerCalls}`, choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const invoke = (bearer) => route.POST(new Request("https://control.test/api/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ input: "Inspect the page", tools: [] }),
  }), { params: { siteAgentId: "responses-auth-test" } });
  try {
    process.env.OPENAI_API_KEY = "provider-key";
    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
    process.env.OPENAI_MODEL = "gpt-test";
    process.env.CAPABILITY_V2_DISPATCH_TOKEN = "dispatch-token";
    delete process.env.CAPABILITY_V2_RUNNER_TOKEN;
    assert.equal((await invoke("dispatch-token")).status, 200);
    assert.equal((await invoke("provider-key")).status, 200);
    const rejected = await invoke("neither");
    assert.equal(rejected.status, 401);
    assert.equal((await rejected.json()).error.code, "model_proxy_unauthorized");
    assert.equal(providerCalls, 2, "a rejected bearer never reaches the provider");
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
