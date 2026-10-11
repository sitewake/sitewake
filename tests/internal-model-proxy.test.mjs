/**
 * The internal model proxy: workers call the control plane's per-role
 * OpenAI-compatible endpoint with the internal token; only this process
 * talks to the provider. Provider calls are stubbed through `fetch`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ENV_KEYS = ["MODEL_API_KEY", "MODEL_BASE_URL", "MODEL", "MODEL_EXECUTION", "MODEL_SEMANTIC", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "SITEWAKE_MODEL_PROXY_URL", "CAPABILITY_V2_DISPATCH_TOKEN", "CAPABILITY_V2_RUNNER_TOKEN", "SITEWAKE_MODEL_MIN_INTERVAL_MS"];

async function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, { SITEWAKE_MODEL_MIN_INTERVAL_MS: "0" }, values);
  try { return await fn(); } finally {
    for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
}

const route = await (async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../app/api/internal/model/[role]/v1/chat/completions/route.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
})();

/** Replaces global fetch for one call; returns the requests the provider saw. */
function stubProvider(respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const request = { url: String(url), headers: init?.headers || {}, body: init?.body ? JSON.parse(init.body) : undefined, signal: init?.signal };
    calls.push(request);
    return respond(request);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function post(role, body, { token = "dispatch-token", raw } = {}) {
  const request = new Request(`http://control-plane:3000/api/internal/model/${role}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: raw ?? JSON.stringify(body),
  });
  return route.POST(request, { params: { role } });
}

test("a wrong or missing internal token is rejected before any provider request", async () => {
  await withEnv({ CAPABILITY_V2_DISPATCH_TOKEN: "dispatch-token", MODEL_API_KEY: "sk-real" }, async () => {
    const provider = stubProvider(() => { throw new Error("must not be called"); });
    try {
      assert.equal((await post("execution", { messages: [] }, { token: "wrong" })).status, 401);
      assert.equal((await post("execution", { messages: [] }, { token: "" })).status, 401);
      assert.equal(provider.calls.length, 0);
    } finally { provider.restore(); }
  });
  await withEnv({ MODEL_API_KEY: "sk-real" }, async () => {
    assert.equal((await post("execution", { messages: [] })).status, 401, "no configured token means nobody is authorized");
  });
});

test("without a configured model the proxy answers 503 model_not_configured", async () => {
  await withEnv({ CAPABILITY_V2_DISPATCH_TOKEN: "dispatch-token" }, async () => {
    const response = await post("execution", { messages: [] });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { code: "model_not_configured" } });
  });
  await withEnv({ CAPABILITY_V2_DISPATCH_TOKEN: "dispatch-token", SITEWAKE_MODEL_PROXY_URL: "http://elsewhere/api/internal/model", MODEL_API_KEY: "sk-real" }, async () => {
    assert.equal((await post("execution", { messages: [] })).status, 503, "a control plane pointed at a proxy never forwards in a loop");
  });
  await withEnv({ CAPABILITY_V2_DISPATCH_TOKEN: "dispatch-token", MODEL_API_KEY: "sk-real" }, async () => {
    assert.equal((await post("other", { messages: [] })).status, 404);
  });
});

test("a request is forwarded with the real key and the role's model, and the reply comes back as is", async () => {
  await withEnv({ CAPABILITY_V2_DISPATCH_TOKEN: "dispatch-token", MODEL_API_KEY: "sk-real", MODEL_BASE_URL: "https://api.openai.com/v1", MODEL: "gpt-shared", MODEL_EXECUTION: "gpt-fast" }, async () => {
    const provider = stubProvider(() => new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const response = await post("execution", { model: "proxy", messages: [{ role: "user", content: "hello" }], max_tokens: 100, tool_choice: "auto" });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { choices: [{ message: { content: "hi" } }] });
      assert.equal(provider.calls.length, 1);
      const [call] = provider.calls;
      assert.equal(call.url, "https://api.openai.com/v1/chat/completions");
      assert.equal(call.headers.authorization, "Bearer sk-real");
      assert.equal(call.body.model, "gpt-fast", "the worker's placeholder model name is replaced by the role's real one");
      assert.deepEqual(call.body.messages, [{ role: "user", content: "hello" }]);
      assert.equal(call.body.max_tokens, 100);
      assert.ok(call.signal instanceof AbortSignal, "the proxy holds an abort handle for its timeout");
    } finally { provider.restore(); }
  });
});

test("provider errors and rate-limit headers pass through; a transport failure is 502", async () => {
  await withEnv({ CAPABILITY_V2_DISPATCH_TOKEN: "dispatch-token", MODEL_API_KEY: "sk-real" }, async () => {
    const limited = stubProvider(() => new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "7" } }));
    try {
      const response = await post("general", { messages: [] });
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "7");
      assert.deepEqual(await response.json(), { error: { message: "slow down" } });
    } finally { limited.restore(); }
    const down = stubProvider(() => { throw new TypeError("fetch failed"); });
    try {
      const response = await post("general", { messages: [] });
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error.code, "model_proxy_failed");
    } finally { down.restore(); }
    assert.equal((await post("general", {}, { raw: "{not json" })).status, 400);
  });
});

test("the provider's thinking contract is re-expressed and forced tool choice fails closed for unverified providers", async () => {
  await withEnv({ CAPABILITY_V2_DISPATCH_TOKEN: "dispatch-token", MODEL_API_KEY: "sk-real", MODEL_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", MODEL: "qwen3-max" }, async () => {
    const provider = stubProvider(() => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    try {
      // A worker asked for thinking off in a generic way; Bailian's own field is what goes out.
      await post("semantic", { messages: [], thinking: { type: "disabled" }, response_format: { type: "json_schema", json_schema: { name: "x", schema: {} } }, max_tokens: 4096 });
      const [call] = provider.calls;
      assert.equal(call.body.enable_thinking, false);
      assert.equal(call.body.thinking, undefined);
      assert.deepEqual(call.body.response_format, { type: "json_object" }, "Bailian has no native json_schema; the prompt already carries the schema");
      assert.equal(call.body.max_tokens, undefined, "structured Bailian requests omit max_tokens");
      assert.equal(call.body.model, "qwen3-max");
    } finally { provider.restore(); }
  });
  await withEnv({ CAPABILITY_V2_DISPATCH_TOKEN: "dispatch-token", MODEL_API_KEY: "sk-real", MODEL_BASE_URL: "https://unknown.example/v1", MODEL: "mystery" }, async () => {
    const provider = stubProvider(() => { throw new Error("must not be called"); });
    try {
      const response = await post("execution", { messages: [], tool_choice: "required", tools: [] });
      assert.equal(response.status, 422);
      assert.equal((await response.json()).error.code, "forced_tool_choice_provider_unsupported");
      assert.equal(provider.calls.length, 0);
    } finally { provider.restore(); }
  });
});

test("a streaming reply is relayed chunk by chunk", async () => {
  await withEnv({ CAPABILITY_V2_DISPATCH_TOKEN: "dispatch-token", MODEL_API_KEY: "sk-real" }, async () => {
    const chunks = ["data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}]}\n\n", "data: {\"choices\":[{\"delta\":{\"content\":\"llo\"}}]}\n\n", "data: [DONE]\n\n"];
    const provider = stubProvider(() => new Response(new ReadableStream({
      async start(controller) {
        for (const chunk of chunks) { controller.enqueue(new TextEncoder().encode(chunk)); await new Promise((resolve) => setTimeout(resolve, 5)); }
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    try {
      const response = await post("execution", { messages: [], stream: true });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      assert.equal(await response.text(), chunks.join(""));
    } finally { provider.restore(); }
  });
});
