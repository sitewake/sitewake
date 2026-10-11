/**
 * Where the model configuration comes from: the console's saved settings
 * (process cache), then the environment; workers see only the control plane's
 * proxy. `lib/model-settings.ts` ties the cache to `runtime_settings`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const ENV_KEYS = ["MODEL_API_KEY", "MODEL_BASE_URL", "MODEL", "MODEL_EXECUTION", "MODEL_SEMANTIC", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "SITEWAKE_MODEL_PROXY_URL", "CAPABILITY_V2_DISPATCH_TOKEN", "SITEWAKE_LOCAL_DEV", "SITEWAKE_TEST_SUITE"];

/** Runs `fn` with exactly these variables set (the rest of the model keys cleared), restoring afterwards. */
async function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try { return await fn(); } finally {
    for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
}

let sequence = 0;

/** A fresh copy of the modules per test, so the process cache starts empty. */
async function loadFresh() {
  const result = await build({
    stdin: {
      contents: `export * from "./lib/model-config"; export * from "./lib/model-settings"; export * from "./db/runtime-settings-store";`,
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#${sequence += 1}`);
}

async function isolatedD1Database() {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `model-config-${sequence += 1}` },
  });
  return { database: await miniflare.getD1Database("DB"), dispose: () => miniflare.dispose() };
}

test("nothing configured: missing, with the built-in defaults", async () => {
  const { getModelConfig, publicModelStatus } = await loadFresh();
  await withEnv({}, () => {
    const config = getModelConfig();
    assert.equal(config.configured, false);
    assert.equal(config.source, "missing");
    assert.equal(config.apiKey, "");
    assert.equal(config.baseUrl, "https://api.openai.com/v1");
    assert.deepEqual(publicModelStatus("execution"), { configured: false, model: config.model, provider: "openai-compatible", source: "missing" });
  });
});

test("environment: MODEL_* wins over OPENAI_*, role overrides apply, source is env", async () => {
  const { getModelConfig, publicModelStatus, modelSettingsFromEnv } = await loadFresh();
  await withEnv({ MODEL_API_KEY: "sk-env", MODEL: "shared", MODEL_EXECUTION: "fast", OPENAI_API_KEY: "sk-legacy", OPENAI_MODEL: "legacy" }, () => {
    assert.equal(getModelConfig("general").model, "shared");
    assert.equal(getModelConfig("execution").model, "fast");
    assert.equal(getModelConfig("semantic").model, "shared");
    assert.equal(getModelConfig().apiKey, "sk-env");
    assert.equal(getModelConfig().source, "model");
    assert.equal(publicModelStatus().source, "env");
    assert.deepEqual(modelSettingsFromEnv(), { baseUrl: "https://api.openai.com/v1", apiKey: "sk-env", model: "shared", executionModel: "fast" });
  });
  await withEnv({ OPENAI_API_KEY: "sk-legacy", OPENAI_BASE_URL: "https://legacy.example/v1" }, () => {
    const config = getModelConfig();
    assert.equal(config.source, "openai");
    assert.equal(config.baseUrl, "https://legacy.example/v1");
    assert.equal(publicModelStatus().source, "env");
  });
});

test("console: saved settings take precedence over the environment, per role", async () => {
  const { getModelConfig, setModelSettings, publicModelStatus, modelConfigSource } = await loadFresh();
  await withEnv({ MODEL_API_KEY: "sk-env", MODEL: "env-model" }, () => {
    setModelSettings({ baseUrl: "https://console.example/v1/", apiKey: " sk-console ", model: "console-model", semanticModel: "console-semantic", executionModel: "" });
    const general = getModelConfig("general");
    assert.deepEqual(general, { configured: true, baseUrl: "https://console.example/v1/", apiKey: "sk-console", model: "console-model", source: "console" });
    assert.equal(getModelConfig("semantic").model, "console-semantic");
    assert.equal(getModelConfig("execution").model, "console-model", "an empty role override means the shared model");
    assert.equal(modelConfigSource(), "console");
    assert.equal(publicModelStatus("semantic").source, "console");
    setModelSettings(null);
    assert.equal(getModelConfig().model, "env-model", "clearing the cache returns to the environment");
    assert.equal(modelConfigSource(), "env");
  });
});

test("worker mode: the proxy address and the internal token, whatever else is in the environment", async () => {
  const { getModelConfig, modelChatCompletionsUrl, modelCompatibility, setModelSettings } = await loadFresh();
  await withEnv({ SITEWAKE_MODEL_PROXY_URL: "http://control-plane:3000/api/internal/model/", CAPABILITY_V2_DISPATCH_TOKEN: "dispatch-token", MODEL_API_KEY: "sk-must-not-be-used" }, () => {
    setModelSettings({ baseUrl: "x", apiKey: "sk-console", model: "m" });
    const config = getModelConfig("execution");
    assert.equal(config.configured, true);
    assert.equal(config.source, "proxy");
    assert.equal(config.apiKey, "dispatch-token");
    assert.equal(config.baseUrl, "http://control-plane:3000/api/internal/model/execution");
    assert.equal(modelChatCompletionsUrl(config.baseUrl), "http://control-plane:3000/api/internal/model/execution/v1/chat/completions");
    assert.equal(getModelConfig("semantic").baseUrl, "http://control-plane:3000/api/internal/model/semantic");
    assert.deepEqual(modelCompatibility(config), { nativeJsonSchema: true, omitStructuredMaxTokens: false, requestBody: {} }, "the proxy applies the real provider's rules");
    setModelSettings(null);
  });
  await withEnv({ SITEWAKE_MODEL_PROXY_URL: "http://control-plane:3000/api/internal/model" }, () => {
    assert.equal(getModelConfig().configured, false, "without the internal token the proxy cannot be called");
  });
});

test("saving applies immediately and a fresh process loads it from the database", async () => {
  const { database, dispose } = await isolatedD1Database();
  try {
    const first = await loadFresh();
    await withEnv({ MODEL_API_KEY: "sk-env", MODEL: "env-model" }, async () => {
      assert.equal(await first.loadModelSettings(database), null, "an empty table leaves the environment in charge");
      assert.equal(first.getModelConfig().source, "model");
      const saved = await first.saveModelSettings({ baseUrl: "https://saved.example/v1", apiKey: "sk-saved-1234", model: "saved-model" }, database);
      assert.equal(saved.apiKey, "sk-saved-1234");
      assert.equal(first.getModelConfig("execution").model, "saved-model", "readers see the new configuration without a reload");
      assert.deepEqual(first.publicModelSettings(), {
        source: "console", configured: true, baseUrl: "https://saved.example/v1", model: "saved-model", executionModel: "", semanticModel: "", apiKeyMasked: "sk-…1234",
      });
      assert.equal(first.effectiveApiKey(), "sk-saved-1234");
    });
    // A restart: new module instances, same database.
    const second = await loadFresh();
    await withEnv({ MODEL_API_KEY: "sk-env" }, async () => {
      assert.equal(second.getModelConfig().source, "model", "before loading, the environment");
      const loaded = await second.loadModelSettings(database);
      assert.equal(loaded.model, "saved-model");
      assert.equal(second.getModelConfig().source, "console");
      assert.equal(second.getModelConfig().apiKey, "sk-saved-1234");
    });
  } finally { await dispose(); }
});

test("memory mode in local development also writes MODEL_* back to .env.local", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sitewake-model-settings-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const { saveModelSettings, getModelConfig, loadModelSettings } = await loadFresh();
    await withEnv({ SITEWAKE_LOCAL_DEV: "1" }, async () => {
      await saveModelSettings({ baseUrl: "https://local.example/v1", apiKey: "sk-local", model: "local-model", executionModel: "local-fast" }, null);
      assert.equal(getModelConfig("execution").model, "local-fast");
      assert.equal(await readFile(join(dir, ".env.local"), "utf8"), [
        "# Written by the console (model settings).",
        "MODEL_API_KEY=sk-local",
        "MODEL_BASE_URL=https://local.example/v1",
        "MODEL=local-model",
        "MODEL_EXECUTION=local-fast",
        "MODEL_SEMANTIC=",
        "",
      ].join("\n"));
      assert.equal((await loadModelSettings(null)).model, "local-model", "the process keeps it for the rest of the run");
    });
    await withEnv({}, async () => {
      const fresh = await loadFresh();
      await fresh.saveModelSettings({ baseUrl: "", apiKey: "sk-server", model: "m" }, null);
      assert.match(await readFile(join(dir, ".env.local"), "utf8"), /sk-local/, "outside local development nothing is written");
    });
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test("maskApiKey keeps only the prefix and the last four characters", async () => {
  const { maskApiKey } = await loadFresh();
  assert.equal(maskApiKey("sk-proj-abcdefghijkl1234"), "sk-…1234");
  assert.equal(maskApiKey("abcdefgh1234"), "…1234");
  assert.equal(maskApiKey("short"), "•••••");
  assert.equal(maskApiKey(""), "");
});
