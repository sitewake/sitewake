import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProviderThinkingPolicy,
  applyProviderPayloadPolicy,
  ForcedToolChoiceProviderError,
  hasForcedToolChoice,
} from "../lib/site-knowledge/provider-payload-policy.ts";

for (const provider of [
  {
    name: "OS1 Qwen gateway",
    baseUrl: "https://openapi.os1.cn",
    model: "qwen3.7-plus",
    expected: { enable_thinking: false },
  },
  {
    name: "Zhipu GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.2",
    expected: { thinking: { type: "disabled" } },
  },
  {
    name: "unknown OpenAI-compatible provider",
    baseUrl: "https://compatible.example/v1",
    model: "unknown-model",
    expected: {},
  },
]) {
  test(`${provider.name} applies non-thinking policy without forcing tool choice`, () => {
    const result = applyProviderThinkingPolicy({
      ...provider,
      payload: {
        tool_choice: "auto",
        reasoning_effort: "high",
        enable_thinking: true,
        thinking: { type: "enabled" },
        thinking_budget: 4096,
      },
    });
    assert.equal(result.tool_choice, "auto");
    assert.deepEqual(Object.fromEntries(Object.entries(result).filter(([key]) => key === "enable_thinking" || key === "thinking")), provider.expected);
    assert.equal("reasoning_effort" in result, false);
    assert.equal("thinking_budget" in result, false);
  });
}

const requiredChoices = [
  ["required", "required"],
  ["object", { type: "function", function: { name: "report_outcome" } }],
];

test("forced tool choice recognizes required and named tool objects only", () => {
  assert.equal(hasForcedToolChoice("auto"), false);
  assert.equal(hasForcedToolChoice("none"), false);
  assert.equal(hasForcedToolChoice(undefined), false);
  assert.equal(hasForcedToolChoice("required"), true);
  assert.equal(hasForcedToolChoice({ type: "function", function: { name: "tool" } }), true);
  assert.equal(hasForcedToolChoice({}), false);
  assert.equal(hasForcedToolChoice({ type: "function", function: {} }), false);
});

for (const provider of [
  {
    name: "Alibaba Bailian Qwen",
    baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.8-max",
    expected: { enable_thinking: false },
  },
  {
    name: "OS1 Qwen gateway",
    baseUrl: "https://openapi.os1.cn",
    model: "qwen3.7-plus",
    expected: { enable_thinking: false },
  },
  {
    name: "Zhipu GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.2",
    expected: { thinking: { type: "disabled" } },
  },
  {
    name: "Volcano Ark",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    model: "doubao-seed-2.0-code",
    expected: { thinking: { type: "disabled" } },
  },
  {
    name: "OS1 DeepSeek gateway",
    baseUrl: "https://openapi.os1.cn/v1",
    model: "deepseek-v4-flash",
    expected: { thinking: { type: "disabled" } },
  },
]) {
  test(`${provider.name} preserves default thinking for auto`, () => {
    const payload = { tool_choice: "auto", reasoning_effort: "high", thinking: { type: "enabled" } };
    assert.deepEqual(applyProviderPayloadPolicy({ ...provider, payload }), payload);
  });

  for (const [choiceName, toolChoice] of requiredChoices) {
    test(`${provider.name} disables thinking for ${choiceName} tool choice`, () => {
      const result = applyProviderPayloadPolicy({
        ...provider,
        payload: {
          model: "browser-alias-must-not-decide-policy",
          tool_choice: toolChoice,
          reasoning_effort: "low",
          enable_thinking: true,
          thinking: { type: "enabled" },
          thinking_budget: 4096,
        },
      });
      assert.deepEqual(Object.fromEntries(Object.entries(result).filter(([key]) => key === "enable_thinking" || key === "thinking")), provider.expected);
      assert.equal("reasoning_effort" in result, false);
      assert.equal("thinking_budget" in result, false);
      assert.equal(result.tool_choice, toolChoice);
    });
  }
}

test("official OpenAI has an explicit native forced-tool contract", () => {
  const payload = { tool_choice: "required", reasoning_effort: "medium" };
  assert.deepEqual(applyProviderPayloadPolicy({ baseUrl: "https://api.openai.com/v1", model: "gpt-5.6", payload }), payload);
});

for (const input of [
  { baseUrl: "https://oss.aliyuncs.com/v1", model: "qwen3.8-max" },
  { baseUrl: "https://ecs.volces.com/v1", model: "doubao-seed-2.0-code" },
  { baseUrl: "https://api.openai.com/v1", model: "whisper-1" },
]) {
  test(`lookalike or unverified provider fails closed: ${new URL(input.baseUrl).hostname}/${input.model}`, () => {
    assert.throws(
      () => applyProviderPayloadPolicy({ ...input, payload: { tool_choice: "required" } }),
      ForcedToolChoiceProviderError,
    );
  });
}

test("Volcano Ark rejects an unverified model even on a recognized hostname", () => {
  assert.throws(
    () => applyProviderPayloadPolicy({
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      model: "unverified-model",
      payload: { tool_choice: "required" },
    }),
    ForcedToolChoiceProviderError,
  );
});

for (const toolChoice of requiredChoices.map(([, value]) => value)) {
  test("unknown OpenAI-compatible providers fail closed for forced tool choice", () => {
    assert.throws(
      () => applyProviderPayloadPolicy({ baseUrl: "https://compatible.example/v1", model: "qwen3.8-max", payload: { tool_choice: toolChoice } }),
      (error) => error instanceof ForcedToolChoiceProviderError
        && error.code === "forced_tool_choice_provider_unsupported",
    );
  });
}

test("unknown providers preserve default thinking for auto and none", () => {
  for (const toolChoice of ["auto", "none"]) {
    const payload = { tool_choice: toolChoice, reasoning_effort: "high", thinking: { type: "enabled" } };
    assert.deepEqual(
      applyProviderPayloadPolicy({ baseUrl: "https://compatible.example/v1", model: "unknown", payload }),
      payload,
    );
  }
});

test("behind the internal model proxy the worker sends the generic thinking-off switch for the proxy to translate", () => {
  for (const baseUrl of ["http://control-plane:3000/api/internal/model/execution", "http://127.0.0.1:3000/api/internal/model/semantic/"]) {
    const payload = applyProviderThinkingPolicy({ baseUrl, model: "proxy", payload: { messages: [], enable_thinking: false, reasoning_effort: "low" } });
    assert.deepEqual(payload, { messages: [], thinking: { type: "disabled" } }, baseUrl);
    // Forced tool choice is likewise left for the proxy to judge against the real provider.
    const forced = applyProviderPayloadPolicy({ baseUrl, model: "proxy", payload: { messages: [], tool_choice: "required" } });
    assert.deepEqual(forced, { messages: [], tool_choice: "required", thinking: { type: "disabled" } });
  }
  assert.deepEqual(
    applyProviderThinkingPolicy({ baseUrl: "https://example.com/api/internal/models/v1", model: "x", payload: { enable_thinking: false } }),
    {},
    "only the proxy path itself counts",
  );
});

test("OS1 DeepSeek continues a tool-call history without thinking, since no caller sends reasoning back", () => {
  const afterToolCall = [
    { role: "user", content: "How many lamps are on sale?" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "0" },
  ];
  const base = { baseUrl: "https://openapi.os1.cn/v1", model: "deepseek-v4-flash" };
  const continued = applyProviderPayloadPolicy({ ...base, payload: { tool_choice: "auto", messages: afterToolCall } });
  assert.deepEqual(continued.thinking, { type: "disabled" });
  assert.equal(continued.tool_choice, "auto");

  const fresh = { tool_choice: "auto", messages: [{ role: "user", content: "hi" }] };
  assert.deepEqual(applyProviderPayloadPolicy({ ...base, payload: fresh }), fresh, "a turn with nothing to send back keeps its thinking");
  const echoed = { tool_choice: "auto", messages: [afterToolCall[0], { ...afterToolCall[1], reasoning_content: "kept" }, afterToolCall[2]] };
  assert.deepEqual(applyProviderPayloadPolicy({ ...base, payload: echoed }), echoed);
  const qwen = { tool_choice: "auto", messages: afterToolCall };
  assert.deepEqual(applyProviderPayloadPolicy({ baseUrl: base.baseUrl, model: "qwen3.7-plus", payload: qwen }), qwen, "other models are untouched");
});
