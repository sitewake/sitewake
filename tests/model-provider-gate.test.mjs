import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../lib/site-knowledge/model-provider-gate.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const gate = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("provider gate serializes calls and spaces their start time", async () => {
  const previous = process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS;
  process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS = "20";
  gate.resetModelProviderGatesForTests();
  const starts = [];
  try {
    await Promise.all([
      gate.withModelProviderGate({ baseUrl: "https://qwen.test/v1", model: "qwen" }, async () => { starts.push(Date.now()); await new Promise((resolve) => setTimeout(resolve, 2)); }),
      gate.withModelProviderGate({ baseUrl: "https://qwen.test/v1", model: "qwen" }, async () => { starts.push(Date.now()); await new Promise((resolve) => setTimeout(resolve, 2)); }),
    ]);
  } finally {
    if (previous === undefined) delete process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS;
    else process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS = previous;
  }
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 15, `calls started ${starts[1] - starts[0]}ms apart`);
});

test("provider gate parses Retry-After in seconds and caps the delay", () => {
  assert.equal(gate.modelRetryAfterMs(new Response("", { status: 429, headers: { "retry-after": "2" } })), 2_000);
  assert.equal(gate.modelRetryAfterMs(new Response("", { status: 429, headers: { "retry-after": "bad" } }), 700), 700);
});
