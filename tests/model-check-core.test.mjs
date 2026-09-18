/**
 * The verification core against a local stub provider: the verdicts, the key
 * redaction, and the fact that the language changes the wording but never the
 * stage identifiers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { chatCompletionsUrl, routingRequest, verifyStages } from "../scripts/model-check-core.mjs";

const API_KEY = "sk-test-secret-key-0000";

// A minimal stand-in for the captured page-execution request: forced tool choice.
const PAGE_REQUEST = {
  model: "capture",
  messages: [{ role: "system", content: "probe" }, { role: "user", content: "probe" }],
  tools: [{ type: "function", function: { name: "done", description: "Finish.", parameters: { type: "object", properties: { text: { type: "string" } } } } }],
  tool_choice: "required",
};

const passthroughPolicy = ({ payload }) => ({ ...payload });

/** Start a provider stub whose behaviour is chosen per request by the model name. */
async function stub(handler) {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => handler(JSON.parse(body), response, request));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function toolCallReply(payload) {
  const name = payload.tool_choice?.function?.name || payload.tools[0].function.name;
  return { choices: [{ message: { tool_calls: [{ type: "function", function: { name, arguments: "{}" } }] } }] };
}

test("chatCompletionsUrl adds /v1 only when the base has no version segment", () => {
  assert.equal(chatCompletionsUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://api.openai.com/v1/"), "https://api.openai.com/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://gateway.example.com"), "https://gateway.example.com/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://gateway.example.com/v4"), "https://gateway.example.com/v4/chat/completions");
});

test("routingRequest offers a tool but does not force it", () => {
  const request = routingRequest("m");
  assert.equal(request.tool_choice, "auto");
  assert.equal(request.tools[0].function.name, "search_site_knowledge");
});

test("valid tool calls on both stages pass, and the page stage carries the execution model", async () => {
  const seen = [];
  const provider = await stub((payload, response) => {
    seen.push(payload);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(toolCallReply(payload)));
  });
  try {
    const result = await verifyStages({ baseUrl: provider.baseUrl, apiKey: API_KEY, model: "router-model", executionModel: "page-model", pageRequest: PAGE_REQUEST, applyPolicy: passthroughPolicy });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.deepEqual(result.results.map((stage) => stage.stage), ["runtime-router", "runtime-page-agent"]);
    assert.equal(seen[0].model, "router-model");
    assert.equal(seen[1].model, "page-model");
    assert.equal(seen[1].stream, false, "probes never stream");
  } finally { await provider.close(); }
});

test("plain text on the page stage fails with the forced-tool-call reason", async () => {
  const provider = await stub((payload, response) => {
    response.setHeader("content-type", "application/json");
    const reply = payload.tool_choice === "required"
      ? { choices: [{ message: { content: "I would click the button." } }] }
      : toolCallReply(payload);
    response.end(JSON.stringify(reply));
  });
  try {
    const en = await verifyStages({ baseUrl: provider.baseUrl, apiKey: API_KEY, model: "m", pageRequest: PAGE_REQUEST, applyPolicy: passthroughPolicy, locale: "en" });
    assert.equal(en.passed, false);
    assert.equal(en.results[0].ok, true);
    assert.equal(en.results[1].ok, false);
    assert.equal(en.results[1].stage, "runtime-page-agent");
    assert.match(en.results[1].detail, /valid tool call/);

    const zh = await verifyStages({ baseUrl: provider.baseUrl, apiKey: API_KEY, model: "m", pageRequest: PAGE_REQUEST, applyPolicy: passthroughPolicy, locale: "zh" });
    assert.equal(zh.results[1].stage, "runtime-page-agent", "stage identifiers are never translated");
    assert.match(zh.results[1].detail, /工具调用/);
    assert.notEqual(zh.results[1].detail, en.results[1].detail);
  } finally { await provider.close(); }
});

test("a 400 whose body echoes the key is reported with status and a redacted message", async () => {
  const provider = await stub((_payload, response) => {
    response.statusCode = 400;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: { code: "bad_request", message: `key ${API_KEY} cannot use tool_choice` } }));
  });
  try {
    const result = await verifyStages({ baseUrl: provider.baseUrl, apiKey: API_KEY, model: "m", pageRequest: PAGE_REQUEST, applyPolicy: passthroughPolicy });
    assert.equal(result.passed, false);
    for (const stage of result.results) {
      assert.equal(stage.status, 400);
      assert.ok(!stage.detail.includes(API_KEY), stage.detail);
      assert.match(stage.detail, /bad_request \| key \[redacted\] cannot use tool_choice/);
    }
  } finally { await provider.close(); }
});

test("a provider that never answers fails with status 0 within the timeout", async () => {
  const provider = await stub(() => { /* hold the connection open */ });
  try {
    const started = Date.now();
    const result = await verifyStages({ baseUrl: provider.baseUrl, apiKey: API_KEY, model: "m", pageRequest: PAGE_REQUEST, applyPolicy: passthroughPolicy, timeoutMs: 200 });
    assert.equal(result.passed, false);
    assert.equal(result.results[0].status, 0);
    assert.ok(Date.now() - started < 2_000, "both stages must respect the timeout");
  } finally { await provider.close(); }
});

test("a policy that refuses the provider fails the page stage without sending anything", async () => {
  let hits = 0;
  const provider = await stub((payload, response) => {
    hits += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(toolCallReply(payload)));
  });
  try {
    const refusing = ({ payload }) => {
      if (payload.tool_choice === "required") throw new Error("no verified policy");
      return { ...payload };
    };
    const result = await verifyStages({ baseUrl: provider.baseUrl, apiKey: API_KEY, model: "m", pageRequest: PAGE_REQUEST, applyPolicy: refusing, locale: "en" });
    assert.equal(hits, 1, "only the routing stage reached the provider");
    assert.equal(result.results[1].ok, false);
    assert.match(result.results[1].detail, /^provider payload policy: no verified policy$/);
  } finally { await provider.close(); }
});

test("incomplete or credentialed configuration is rejected before any request", async () => {
  await assert.rejects(() => verifyStages({ baseUrl: "", apiKey: API_KEY, model: "m", pageRequest: PAGE_REQUEST, applyPolicy: passthroughPolicy }), /incomplete/);
  await assert.rejects(() => verifyStages({ baseUrl: "https://user:pw@host/v1", apiKey: API_KEY, model: "m", pageRequest: PAGE_REQUEST, applyPolicy: passthroughPolicy }), /embedded credentials/);
  await assert.rejects(() => verifyStages({ baseUrl: "", apiKey: API_KEY, model: "m", pageRequest: PAGE_REQUEST, applyPolicy: passthroughPolicy, locale: "zh" }), /不完整/);
});
