/**
 * Background structured model turns declare thinking off: the capability
 * pipeline's review, duplicate check, experience abstraction, case enrichment
 * and explorer guidance calls have no live reader, so provider reasoning
 * only adds latency. The helper must translate the ask into the provider's
 * own verified switch (or strip every thinking field for an unverified
 * provider) while leaving the rest of the request byte-identical.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const savedInterval = process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS;
process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS = "0";

const { requestStructuredModelJson } = await (async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../lib/capability-center-v2/model-json.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
})();

function stubProvider() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const INPUT = {
  system: "audit",
  payload: { candidate: "test" },
  jsonSchema: { name: "audit", schema: { type: "object" } },
  disableThinking: true,
};

function thinkingFields(body) {
  return {
    enable_thinking: body.enable_thinking,
    thinking: body.thinking,
    reasoning_effort: body.reasoning_effort,
    thinking_budget: body.thinking_budget,
  };
}

test("a background turn names the provider's own thinking-off switch", async (t) => {
  t.after(() => { if (savedInterval === undefined) delete process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS; else process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS = savedInterval; });

  const bailian = stubProvider();
  try {
    await requestStructuredModelJson({ configured: true, apiKey: "k", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.7-plus" }, INPUT);
    const [call] = bailian.calls;
    assert.equal(call.body.enable_thinking, false, "Bailian Qwen reads enable_thinking");
    assert.equal(call.body.thinking, undefined, "the generic switch is not sent to Bailian");
    assert.equal(call.body.max_tokens, undefined, "structured Bailian requests still omit max_tokens");
    assert.deepEqual(call.body.response_format, { type: "json_object" }, "Bailian still gets the json_object downgrade, unchanged by the policy");
    assert.equal(call.body.messages[0].role, "system");
  } finally { bailian.restore(); }

  const zhipu = stubProvider();
  try {
    await requestStructuredModelJson({ configured: true, apiKey: "k", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6" }, INPUT);
    const [call] = zhipu.calls;
    assert.deepEqual(call.body.thinking, { type: "disabled" }, "Zhipu GLM reads the thinking field");
    assert.equal(call.body.enable_thinking, undefined);
  } finally { zhipu.restore(); }

  const ark = stubProvider();
  try {
    await requestStructuredModelJson({ configured: true, apiKey: "k", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seed-2.0" }, INPUT);
    assert.deepEqual(ark.calls[0].body.thinking, { type: "disabled" }, "Ark families read the thinking field");
  } finally { ark.restore(); }

  const proxy = stubProvider();
  try {
    await requestStructuredModelJson({ configured: true, apiKey: "k", baseUrl: "http://control-plane:3000/api/internal/model/execution", model: "proxy" }, INPUT);
    assert.deepEqual(proxy.calls[0].body.thinking, { type: "disabled" }, "a worker behind the internal proxy sends the generic switch for the control plane to re-express");
  } finally { proxy.restore(); }

  const unknown = stubProvider();
  try {
    await requestStructuredModelJson({ configured: true, apiKey: "k", baseUrl: "https://gateway.example/v1", model: "mystery" }, INPUT);
    assert.deepEqual(thinkingFields(unknown.calls[0].body), { enable_thinking: undefined, thinking: undefined, reasoning_effort: undefined, thinking_budget: undefined }, "an unverified provider receives a clean payload rather than an unverified field");
  } finally { unknown.restore(); }
});

test("a turn that does not ask keeps the provider's default thinking behavior", async () => {
  const provider = stubProvider();
  try {
    await requestStructuredModelJson(
      { configured: true, apiKey: "k", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.7-plus" },
      { system: "audit", payload: {}, disableThinking: undefined },
    );
    assert.deepEqual(thinkingFields(provider.calls[0].body), { enable_thinking: undefined, thinking: undefined, reasoning_effort: undefined, thinking_budget: undefined });
  } finally { provider.restore(); }
});
