import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyModelConfig, parseEnvFile, verifyModel, writeModelConfig } from "../scripts/setup.mjs";

const config = { baseUrl: "https://api.openai.com/v1", apiKey: "test-key", model: "gpt-test", executionModel: "gpt-execution-test" };

test("setup verifies both runtime stages and preserves the execution model override", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const payload = JSON.parse(init.body);
    requests.push(payload);
    const name = payload.tool_choice?.function?.name || payload.tools[0].function.name;
    return Response.json({ choices: [{ message: { tool_calls: [{ type: "function", function: { name, arguments: "{}" } }] } }] });
  });
  const result = await verifyModel(config);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, config.model);
  assert.equal(requests[1].model, config.executionModel);
  assert.ok(requests[1].tools.length);
  assert.ok(requests[1].tool_choice);
});

test("HTTP 200 chat-only responses cannot pass the page execution probe", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ message: { content: "hello" } }] }));
  const result = await verifyModel(config);
  assert.equal(result.ok, false);
  assert.match(result.reason, /runtime-page-agent/);
});

test("HTML or empty success responses do not pass setup", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("<html>Login required</html>"));
  assert.equal((await verifyModel(config)).ok, false);
});

test("malformed tool arguments do not pass setup", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const payload = JSON.parse(init.body);
    return Response.json({ choices: [{ message: { tool_calls: [{ type: "function", function: { name: payload.tools[0].function.name, arguments: "broken" } }] } }] });
  });
  assert.equal((await verifyModel(config)).ok, false);
});

test("env parsing and rewriting preserve quoted keys, comments and unrelated settings", () => {
  const original = 'MODEL_API_KEY="old#key"\nOTHER="leave # intact"\nOPENAI_MODEL=old\n';
  assert.equal(parseEnvFile(original).get("MODEL_API_KEY"), "old#key");
  const next = applyModelConfig(original, { MODEL_API_KEY: 'new#key', MODEL: 'model with spaces' });
  const parsed = parseEnvFile(next.text);
  assert.equal(parsed.get("MODEL_API_KEY"), "new#key");
  assert.equal(parsed.get("MODEL"), "model with spaces");
  assert.equal(parsed.get("OTHER"), "leave # intact");
  assert.equal(parsed.has("OPENAI_MODEL"), false);
  assert.throws(() => applyModelConfig('', { MODEL_API_KEY: 'secret\nINJECT=1' }));
});

test("configuration writes are private and replace the complete file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sitewake-setup-"));
  try {
    const path = join(directory, ".env.local");
    await writeModelConfig("MODEL=first\n", path);
    await writeModelConfig("MODEL=second\n", path);
    assert.equal(await readFile(path, "utf8"), "MODEL=second\n");
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("provider diagnostics never echo the configured key", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { message: `invalid key: ${config.apiKey}` } }, { status: 401 }));
  const result = await verifyModel(config);
  assert.equal(result.ok, false);
  assert.ok(!result.reason.includes(config.apiKey));
  assert.match(result.reason, /redacted/);
});
