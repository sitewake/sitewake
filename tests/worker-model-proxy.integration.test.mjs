/**
 * A worker reaching the model through the control plane, end to end: the
 * internal proxy route served by a separate Node process that holds the
 * provider key, a stub provider that records what it receives, and the real
 * worker-side clients (structured JSON and tool calling) configured only with
 * SITEWAKE_MODEL_PROXY_URL and the internal token.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/** The provider: records each request and answers with a canned chat completion. */
async function stubProvider(answer) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer(requests.length)));
    });
  });
  const port = await listen(server);
  return { requests, port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** The control plane: the proxy route bundled into a tiny HTTP server, run in its own process with the provider key. */
async function controlPlane(env) {
  const dir = await mkdtemp(join(tmpdir(), "sitewake-model-proxy-cp-"));
  const bundle = join(dir, "route.mjs");
  await build({
    entryPoints: [join(ROOT, "app/api/internal/model/[role]/v1/chat/completions/route.ts")],
    bundle: true, platform: "node", format: "esm", outfile: bundle,
  });
  const server = join(dir, "server.mjs");
  await writeFile(server, `
    import { createServer } from "node:http";
    import { POST } from ${JSON.stringify(bundle)};
    const server = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const role = request.url.match(/\\/api\\/internal\\/model\\/([^/]+)\\//)?.[1] || "";
      const result = await POST(new Request("http://control-plane" + request.url, { method: "POST", headers: request.headers, body: Buffer.concat(chunks) }), { params: { role } });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    });
    server.listen(0, "127.0.0.1", () => { process.stdout.write("PORT " + server.address().port + "\\n"); });
  `);
  const child = spawn(process.execPath, [server], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; const match = /PORT (\d+)/.exec(output); if (match) resolve(Number(match[1])); });
    child.once("exit", (code) => reject(new Error(`control plane exited: ${code}`)));
  });
  return { port, close: async () => { child.kill(); await rm(dir, { recursive: true, force: true }); } };
}

async function workerClients() {
  const result = await build({
    stdin: {
      contents: `export * from "./lib/model-config"; export { requestStructuredModelJson } from "./lib/capability-center-v2/model-json"; export { requestToolCallingTurn } from "./runner/capability-v2/tool-calling";`,
      resolveDir: ROOT, loader: "ts",
    },
    bundle: true, platform: "node", format: "esm", write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const WORKER_ENV_KEYS = ["SITEWAKE_MODEL_PROXY_URL", "CAPABILITY_V2_DISPATCH_TOKEN", "MODEL_API_KEY", "MODEL_BASE_URL", "MODEL", "MODEL_EXECUTION", "MODEL_SEMANTIC", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "SITEWAKE_MODEL_MIN_INTERVAL_MS"];

test("a worker with only the proxy address and the internal token gets structured JSON and tool calls from the real provider configuration", async () => {
  const provider = await stubProvider((count) => count === 1
    ? { choices: [{ message: { role: "assistant", content: JSON.stringify({ verdict: "ok", count: 3 }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
    : { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "click", arguments: JSON.stringify({ selector: "#go" }) } }] } }] });
  const plane = await controlPlane({
    MODEL_API_KEY: "sk-real-provider-key",
    MODEL_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
    MODEL: "real-shared-model",
    MODEL_EXECUTION: "real-execution-model",
    CAPABILITY_V2_DISPATCH_TOKEN: "dispatch-token",
    SITEWAKE_MODEL_MIN_INTERVAL_MS: "0",
  });
  const saved = Object.fromEntries(WORKER_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of WORKER_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    SITEWAKE_MODEL_PROXY_URL: `http://127.0.0.1:${plane.port}/api/internal/model`,
    CAPABILITY_V2_DISPATCH_TOKEN: "dispatch-token",
    SITEWAKE_MODEL_MIN_INTERVAL_MS: "0",
  });
  try {
    const worker = await workerClients();
    const semantic = worker.getModelConfig("semantic");
    assert.equal(semantic.source, "proxy");
    assert.equal(semantic.apiKey, "dispatch-token", "the worker never sees the provider key");

    const structured = await worker.requestStructuredModelJson(semantic, {
      system: "Judge the page.",
      payload: { page: "example" },
      jsonSchema: { name: "verdict", schema: { type: "object", properties: { verdict: { type: "string" }, count: { type: "number" } }, required: ["verdict", "count"] } },
      attempts: 1,
      timeoutMs: 10_000,
    });
    assert.deepEqual(structured, { verdict: "ok", count: 3 });
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0].url, "/v1/chat/completions");
    assert.equal(provider.requests[0].authorization, "Bearer sk-real-provider-key", "the control plane signs the provider request");
    assert.equal(provider.requests[0].body.model, "real-shared-model", "the semantic role uses the shared model");
    assert.equal(provider.requests[0].body.response_format.type, "json_schema", "an OpenAI-style provider keeps native json_schema");
    assert.equal(provider.requests[0].body.messages[1].content, JSON.stringify({ page: "example" }));

    const turn = await worker.requestToolCallingTurn({
      config: worker.getModelConfig("execution"),
      messages: [{ role: "user", content: "click go" }],
      tools: [{ type: "function", function: { name: "click", parameters: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] } } }],
      timeoutMs: 10_000,
      disableThinking: true,
    });
    assert.equal(turn.calls.length, 1);
    assert.equal(turn.calls[0].function.name, "click");
    assert.equal(provider.requests.length, 2);
    assert.equal(provider.requests[1].body.model, "real-execution-model", "the execution role uses its override");
    assert.equal(provider.requests[1].body.thinking, undefined, "an unknown local provider gets no provider-specific thinking field");
    assert.equal(provider.requests[1].authorization, "Bearer sk-real-provider-key");
  } finally {
    for (const key of WORKER_ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    await plane.close();
    await provider.close();
  }
});

test("with a wrong internal token the worker is refused and the provider is never contacted", async () => {
  const provider = await stubProvider(() => ({ choices: [] }));
  const plane = await controlPlane({
    MODEL_API_KEY: "sk-real-provider-key",
    MODEL_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
    MODEL: "real-shared-model",
    CAPABILITY_V2_DISPATCH_TOKEN: "dispatch-token",
    SITEWAKE_MODEL_MIN_INTERVAL_MS: "0",
  });
  const saved = Object.fromEntries(WORKER_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of WORKER_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    SITEWAKE_MODEL_PROXY_URL: `http://127.0.0.1:${plane.port}/api/internal/model`,
    CAPABILITY_V2_DISPATCH_TOKEN: "not-the-token",
    SITEWAKE_MODEL_MIN_INTERVAL_MS: "0",
  });
  try {
    const worker = await workerClients();
    await assert.rejects(
      worker.requestToolCallingTurn({ config: worker.getModelConfig("execution"), messages: [{ role: "user", content: "x" }], tools: [{ type: "function", function: { name: "click", parameters: { type: "object", properties: {} } } }], timeoutMs: 10_000, protocolRepairAttempts: 0 }),
      /tool_calling_model_http_401/,
    );
    assert.equal(provider.requests.length, 0);
  } finally {
    for (const key of WORKER_ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    await plane.close();
    await provider.close();
  }
});
