import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../runner/capability-v2/tool-calling.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const toolCalling = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const tool = {
  type: "function",
  function: {
    name: "report",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

for (const scenario of [
  {
    name: "OS1 Qwen",
    baseUrl: "https://openapi.os1.cn",
    model: "qwen3.7-plus",
    expected: { enable_thinking: false },
  },
  {
    name: "GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.2",
    expected: { thinking: { type: "disabled" } },
  },
  {
    name: "unknown provider",
    baseUrl: "https://compatible.example/v1",
    model: "unknown-model",
    expected: {},
  },
]) {
  test(`tool calling keeps auto choice and applies ${scenario.name} thinking policy`, async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (_url, init) => {
      request = JSON.parse(String(init?.body || "{}"));
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call-1", type: "function", function: { name: "report", arguments: "{}" } }],
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      await toolCalling.requestToolCallingTurn({
        config: { configured: true, apiKey: "test-key", baseUrl: scenario.baseUrl, model: scenario.model, source: "test" },
        messages: [{ role: "user", content: "report" }],
        tools: [tool],
        maxTokens: 256,
        timeoutMs: 1_000,
        protocolRepairAttempts: 0,
        disableThinking: true,
      });
      assert.equal(request.tool_choice, "auto");
      assert.deepEqual({
        ...(request.enable_thinking === undefined ? {} : { enable_thinking: request.enable_thinking }),
        ...(request.thinking === undefined ? {} : { thinking: request.thinking }),
      }, scenario.expected);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
