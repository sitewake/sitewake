/**
 * The console's model endpoints: management-authorized, masked reads, a
 * verification that never writes, a save that takes effect at once and keeps
 * the stored key when the form leaves the key blank.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ENV_KEYS = ["MODEL_API_KEY", "MODEL_BASE_URL", "MODEL", "MODEL_EXECUTION", "MODEL_SEMANTIC", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "SITEWAKE_MODEL_PROXY_URL", "SITEWAKE_LOCAL_DEV", "DATABASE_URL"];

async function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try { return await fn(); } finally {
    for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
}

let sequence = 0;

/** Both routes and the settings module from one bundle, so they share the process cache; the management gate is a header. */
async function loadRoutes() {
  const result = await build({
    stdin: {
      contents: `
        export * as model from "./app/api/system/model/route";
        export * as verify from "./app/api/system/model/verify/route";
        export * as status from "./app/api/system/status/route";
        export * from "./lib/model-config";
      `,
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      loader: "ts",
    },
    bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{
      name: "management-gate-stub",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]app[\\/]api[\\/]site-agents[\\/]http\.ts$/ }, () => ({
          loader: "ts",
          contents: `
            export async function managementAuthorized(request) { return request.headers.get("x-test-management") === "authorized"; }
            export function siteAgentJson(payload, status = 200, headers = {}) {
              return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
            }
          `,
        }));
        // Memory mode: no database binding, no Cloudflare runtime.
        builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({ loader: "ts", contents: `export function getD1Binding() { return null; } export function getArtifactBinding() { return null; }` }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#${sequence += 1}`);
}

const authorized = { "x-test-management": "authorized", "content-type": "application/json" };
const request = (method, body, headers = authorized) => new Request("https://control.test/api/system/model", { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

/** A provider stub that accepts a given key: answers the routing probe with text and the page probe with the forced tool call. */
function stubProvider(acceptedKey) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body);
    calls.push({ url: String(url), authorization: init.headers.authorization, model: payload.model });
    if (init.headers.authorization !== `Bearer ${acceptedKey}`) return new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401, headers: { "content-type": "application/json" } });
    const forced = payload.tool_choice?.type === "function";
    const message = forced
      ? { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: payload.tool_choice.function.name, arguments: "{}" } }] }
      : { role: "assistant", content: "pong" };
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("every endpoint requires the console's management session", async () => {
  const routes = await loadRoutes();
  await withEnv({}, async () => {
    for (const [name, response] of [
      ["GET", await routes.model.GET(request("GET", undefined, {}))],
      ["PUT", await routes.model.PUT(request("PUT", { apiKey: "sk-x", model: "m" }, { "content-type": "application/json" }))],
      ["verify", await routes.verify.POST(request("POST", { apiKey: "sk-x", model: "m" }, { "content-type": "application/json" }))],
      ["status", await routes.status.GET(new Request("https://control.test/api/system/status"))],
    ]) {
      assert.equal(response.status, 401, name);
    }
    assert.equal(routes.getModelConfig().configured, false, "a rejected PUT changes nothing");
  });
});

test("reads return the masked key, the source, and the verified providers; never the key itself", async () => {
  const routes = await loadRoutes();
  await withEnv({ MODEL_API_KEY: "sk-live-abcdefgh1234", MODEL: "env-model", MODEL_BASE_URL: "https://api.openai.com/v1" }, async () => {
    const body = await (await routes.model.GET(request("GET"))).json();
    assert.equal(body.source, "env");
    assert.equal(body.configured, true);
    assert.equal(body.apiKeyMasked, "sk-…1234");
    assert.equal(body.model, "env-model");
    assert.ok(Array.isArray(body.providers) && body.providers.some((provider) => provider.id === "openai" && provider.baseUrl === "https://api.openai.com/v1"));
    assert.doesNotMatch(JSON.stringify(body), /sk-live-abcdefgh1234/);
    const status = await (await routes.status.GET(new Request("https://control.test/api/system/status", { headers: authorized }))).json();
    assert.equal(status.models.general.source, "env");
    assert.doesNotMatch(JSON.stringify(status), /sk-live/);
  });
  await withEnv({}, async () => {
    const body = await (await routes.model.GET(request("GET"))).json();
    assert.equal(body.source, "missing");
    assert.equal(body.configured, false);
    assert.equal(body.apiKeyMasked, "");
  });
});

test("a failed verification reports the stage, status and hint, and does not touch the saved configuration", async () => {
  const routes = await loadRoutes();
  await withEnv({ MODEL_API_KEY: "sk-good", MODEL: "env-model", MODEL_BASE_URL: "https://provider.test/v1" }, async () => {
    const provider = stubProvider("sk-good");
    try {
      const response = await routes.verify.POST(request("POST", { baseUrl: "https://provider.test/v1", apiKey: "sk-wrong", model: "new-model" }));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.hint, "401");
      assert.equal(body.results[0].stage, "runtime-router");
      assert.equal(body.results[0].status, 401);
      assert.doesNotMatch(JSON.stringify(body), /sk-wrong/, "the key is redacted from provider details");
      assert.equal(routes.getModelConfig().apiKey, "sk-good", "verification never writes");
      assert.equal(routes.getModelConfig().model, "env-model");
      // An OpenAI-compatible service the policy has not verified fails closed before any page request.
      const unverified = await (await routes.verify.POST(request("POST", { baseUrl: "https://unknown.example/v1", apiKey: "sk-good", model: "mystery" }))).json();
      assert.equal(unverified.ok, false);
      assert.equal(unverified.hint, "policy");
      const invalid = await routes.verify.POST(request("POST", { baseUrl: "ftp://x", apiKey: "sk", model: "m" }));
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error, "base_url_invalid");
      assert.equal((await (await routes.verify.POST(request("POST", { apiKey: "sk", model: "" }))).json()).error, "model_required");
    } finally { provider.restore(); }
  });
});

test("after a passing verification, PUT saves and every reader sees the new configuration at once", async () => {
  const routes = await loadRoutes();
  await withEnv({ MODEL_API_KEY: "sk-old", MODEL: "old-model" }, async () => {
    const provider = stubProvider("sk-new-1234");
    try {
      const verified = await (await routes.verify.POST(request("POST", { baseUrl: "https://api.openai.com/v1", apiKey: "sk-new-1234", model: "gpt-new", executionModel: "gpt-fast" }))).json();
      assert.equal(verified.ok, true, JSON.stringify(verified));
      assert.deepEqual(verified.results.map((stage) => [stage.stage, stage.ok]), [["runtime-router", true], ["runtime-page-agent", true]]);
      assert.deepEqual(provider.calls.map((call) => call.model), ["gpt-new", "gpt-fast"], "the routing probe uses the shared model, the page probe the execution override");
      assert.equal(routes.getModelConfig().apiKey, "sk-old", "still unsaved");

      const saved = await routes.model.PUT(request("PUT", { baseUrl: "https://api.openai.com/v1", apiKey: "sk-new-1234", model: "gpt-new", executionModel: "gpt-fast" }));
      assert.equal(saved.status, 200);
      const body = await saved.json();
      assert.equal(body.source, "console");
      assert.equal(body.apiKeyMasked, "sk-…1234");
      assert.equal(body.executionModel, "gpt-fast");
      assert.equal(routes.getModelConfig("execution").model, "gpt-fast");
      assert.equal(routes.getModelConfig("semantic").model, "gpt-new");
      assert.equal(routes.getModelConfig().apiKey, "sk-new-1234");
      assert.equal(routes.publicModelStatus().source, "console");
    } finally { provider.restore(); }
  });
});

test("changing only the model keeps the stored key, for verification and for saving", async () => {
  const routes = await loadRoutes();
  await withEnv({ MODEL_API_KEY: "sk-keep-me-9999", MODEL: "gpt-old", MODEL_BASE_URL: "https://api.openai.com/v1" }, async () => {
    const provider = stubProvider("sk-keep-me-9999");
    try {
      const verified = await (await routes.verify.POST(request("POST", { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-better" }))).json();
      assert.equal(verified.ok, true, JSON.stringify(verified));
      assert.ok(provider.calls.every((call) => call.authorization === "Bearer sk-keep-me-9999"));
      const body = await (await routes.model.PUT(request("PUT", { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-better" }))).json();
      assert.equal(body.model, "gpt-better");
      assert.equal(body.apiKeyMasked, "sk-…9999");
      assert.equal(routes.getModelConfig().apiKey, "sk-keep-me-9999");
    } finally { provider.restore(); }
  });
  await withEnv({}, async () => {
    const fresh = await loadRoutes();
    const response = await fresh.model.PUT(request("PUT", { model: "m", apiKey: "" }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "api_key_required", "with nothing stored, a blank key cannot be kept");
  });
});

test("a local npm run dev (memory mode) writes the saved keys back to .env.local", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sitewake-system-model-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const routes = await loadRoutes();
    await withEnv({ SITEWAKE_LOCAL_DEV: "1" }, async () => {
      const response = await routes.model.PUT(request("PUT", { baseUrl: "https://provider.test/v1", apiKey: "sk-local-5678", model: "local-model" }));
      assert.equal(response.status, 200);
      const { readFile } = await import("node:fs/promises");
      const written = await readFile(join(dir, ".env.local"), "utf8");
      assert.match(written, /^MODEL_API_KEY=sk-local-5678$/m);
      assert.match(written, /^MODEL=local-model$/m);
      assert.match(written, /^MODEL_BASE_URL=https:\/\/provider\.test\/v1$/m);
    });
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
});
