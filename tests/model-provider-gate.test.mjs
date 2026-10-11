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

test("a background job never makes a person wait: the lanes queue apart", async () => {
  // Authoring a capability makes twenty-to-forty-second calls back to back
  // through the same control plane. In one queue, every one of them stood in
  // front of the next thing the user typed: the widget waited, the runtime
  // first-byte deadline fired, and the task was reported as interrupted.
  const previous = process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS;
  process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS = "0";
  gate.resetModelProviderGatesForTests();
  const config = { baseUrl: "https://qwen.test/v1", model: "qwen" };
  const order = [];
  try {
    const background = gate.withModelProviderGate(config, async () => {
      order.push("background:start");
      await new Promise((resolve) => setTimeout(resolve, 120));
      order.push("background:end");
    }, "background");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await gate.withModelProviderGate(config, async () => { order.push("interactive"); }, "interactive");
    // The person was served while the long job was still running.
    assert.deepEqual(order, ["background:start", "interactive"]);
    await background;
    assert.deepEqual(order, ["background:start", "interactive", "background:end"]);

    // Two people asking at the same moment is the product working, not a
    // burst to smooth out: they run together.
    gate.resetModelProviderGatesForTests();
    const marks = [];
    await Promise.all([
      gate.withModelProviderGate(config, async () => { marks.push("a:start"); await new Promise((resolve) => setTimeout(resolve, 30)); marks.push("a:end"); }, "interactive"),
      gate.withModelProviderGate(config, async () => { marks.push("b:start"); marks.push("b:end"); }, "interactive"),
    ]);
    assert.deepEqual(marks, ["a:start", "b:start", "b:end", "a:end"]);
  } finally {
    if (previous === undefined) delete process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS;
    else process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS = previous;
  }
});

test("the widget's model routes queue in the interactive lane, the runners' proxy does not", async () => {
  const { readFile } = await import("node:fs/promises");
  const widgetChat = await readFile(new URL("../app/api/site-agents/[siteAgentId]/model/v2/chat/completions/route.ts", import.meta.url), "utf8");
  const widgetResponses = await readFile(new URL("../app/api/site-agents/[siteAgentId]/model/v2/responses/route.ts", import.meta.url), "utf8");
  const runnerProxy = await readFile(new URL("../app/api/internal/model/[role]/v1/chat/completions/route.ts", import.meta.url), "utf8");
  assert.match(widgetChat, /forwardToProvider\(config, payload, controller\.signal, "interactive"\)/);
  assert.match(widgetResponses, /\}\), "interactive"\)/);
  assert.ok(!/"interactive"/.test(runnerProxy), "runner traffic must stay in the background lane");
});

test("a person's question is not held back at all: no queue, no spacing, however many ask at once", async () => {
  // Limiting a user's request is not ours to do: the account's rate belongs to
  // the provider, which answers 429 with Retry-After, and the callers honour
  // it. Ten people asking together must reach the provider together.
  const previous = process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS;
  process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS = "1500";
  gate.resetModelProviderGatesForTests();
  const config = { baseUrl: "https://qwen.test/v1", model: "qwen" };
  let inFlight = 0;
  let peak = 0;
  const started = [];
  try {
    await Promise.all(Array.from({ length: 10 }, () => gate.withModelProviderGate(config, async () => {
      inFlight += 1; peak = Math.max(peak, inFlight); started.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
    }, "interactive")));
  } finally {
    if (previous === undefined) delete process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS;
    else process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS = previous;
  }
  assert.equal(peak, 10, `all ten in flight together, not ${peak}`);
  assert.ok(Math.max(...started) - Math.min(...started) < 200, "no rate-limiter tick between people");
});

test("background work stays one at a time, spaced, however many runners ask", async () => {
  const previous = process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS;
  process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS = "20";
  gate.resetModelProviderGatesForTests();
  const config = { baseUrl: "https://qwen.test/v1", model: "qwen" };
  let inFlight = 0;
  let peak = 0;
  const starts = [];
  try {
    await Promise.all([1, 2, 3].map(() => gate.withModelProviderGate(config, async () => {
      inFlight += 1; peak = Math.max(peak, inFlight); starts.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    }, "background")));
  } finally {
    if (previous === undefined) delete process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS;
    else process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS = previous;
  }
  assert.equal(peak, 1, "a runner must not fill the provider by itself");
  assert.ok(starts[1] - starts[0] >= 15 && starts[2] - starts[1] >= 15, `spaced starts: ${JSON.stringify(starts.map((at, index) => index ? at - starts[index - 1] : 0))}`);
});

test("provider gate parses Retry-After in seconds and caps the delay", () => {
  assert.equal(gate.modelRetryAfterMs(new Response("", { status: 429, headers: { "retry-after": "2" } })), 2_000);
  assert.equal(gate.modelRetryAfterMs(new Response("", { status: 429, headers: { "retry-after": "bad" } }), 700), 700);
});
