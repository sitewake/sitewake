import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

globalThis.window = globalThis;
globalThis.window.addEventListener ||= () => {};
globalThis.window.removeEventListener ||= () => {};
globalThis.document ||= {
  visibilityState: "visible",
  addEventListener() {},
  removeEventListener() {},
  getElementsByTagName() { return []; },
  querySelectorAll() { return []; },
};

async function portModule() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../client/user-agent-port.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "browser-stubs",
      setup(builder) {
        builder.onResolve({ filter: /^@page-agent\// }, () => ({ path: "stub", namespace: "pa" }));
        builder.onLoad({ filter: /.*/, namespace: "pa" }, () => ({
          loader: "js",
          contents: "export class PageController {} export class PageAgentCore {} export const tool = value => value;",
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { fetchWithTimeout, FetchTimeoutError, runtimeModelFirstByteTimeoutMs, agentStartupFailure } = await portModule();

/** A response whose body emits controlled chunks on demand. */
function streamingResponse({ firstChunkDelayMs = 0, chunks = 1, gapMs = 0 }) {
  let emitted = 0;
  return new Response(new ReadableStream({
    async pull(controller) {
      const delay = emitted === 0 ? firstChunkDelayMs : gapMs;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (emitted >= chunks) {
        controller.close();
        return;
      }
      emitted += 1;
      controller.enqueue(new TextEncoder().encode(`chunk-${emitted}`));
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

async function drain(response) {
  const reader = response.body.getReader();
  let text = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    text += new TextDecoder().decode(next.value);
  }
  return text;
}

test("a model that never emits a first token is cut off by the first-byte deadline", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => streamingResponse({ firstChunkDelayMs: 5_000 });
  try {
    const response = await fetchWithTimeout("https://model.test/v1", {}, 5_000, 40);
    await assert.rejects(() => drain(response), (error) => {
      assert.ok(error instanceof FetchTimeoutError, `expected a timeout, got ${error}`);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a stream that starts promptly is not cut off by the first-byte deadline", async () => {
  const originalFetch = globalThis.fetch;
  // First token arrives quickly, then the generation continues past the
  // first-byte deadline. Only the overall deadline may apply from here.
  globalThis.fetch = async () => streamingResponse({ firstChunkDelayMs: 5, chunks: 3, gapMs: 40 });
  try {
    const response = await fetchWithTimeout("https://model.test/v1", {}, 5_000, 30);
    assert.equal(await drain(response), "chunk-1chunk-2chunk-3");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a stream that stalls after starting is cut off by the overall deadline", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => streamingResponse({ firstChunkDelayMs: 5, chunks: 5, gapMs: 200 });
  try {
    const response = await fetchWithTimeout("https://model.test/v1", {}, 120, 30);
    await assert.rejects(() => drain(response), (error) => {
      assert.ok(error instanceof FetchTimeoutError, `expected a timeout, got ${error}`);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the first-byte deadline never exceeds the overall deadline", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => streamingResponse({ firstChunkDelayMs: 5_000 });
  try {
    // A caller asking for a first-byte deadline longer than the overall one
    // must not end up with a longer effective wait.
    const started = Date.now();
    const response = await fetchWithTimeout("https://model.test/v1", {}, 50, 5_000);
    await assert.rejects(() => drain(response));
    assert.ok(Date.now() - started < 2_000, "the overall deadline must still bound the wait");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime model deadlines are sized against measured latency, not an order of magnitude above it", async () => {
  const source = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  const overall = Number(/RUNTIME_MODEL_TIMEOUT_MS = ([0-9_]+)/.exec(source)?.[1].replace(/_/g, ""));
  const firstByte = Number(/RUNTIME_MODEL_FIRST_BYTE_TIMEOUT_MS = ([0-9_]+)/.exec(source)?.[1].replace(/_/g, ""));
  const attempts = Number(/RUNTIME_MODEL_MAX_ATTEMPTS = ([0-9_]+)/.exec(source)?.[1].replace(/_/g, ""));

  assert.ok(Number.isFinite(overall) && Number.isFinite(firstByte) && Number.isFinite(attempts));
  assert.ok(firstByte < overall, "the first-byte deadline must be the tighter of the two");
  // Production p-max was ~12s. A first-byte deadline beyond a minute would
  // never fire before the user has given up.
  assert.ok(firstByte <= 30_000, `first-byte deadline ${firstByte}ms is too far above measured latency`);
  assert.ok(overall <= 90_000, `overall deadline ${overall}ms is too far above measured latency`);
  assert.ok(overall * attempts <= 180_000, "worst-case wait across retries must stay under three minutes");
});

test("non-retryable client errors are not retried by the routing layer", async () => {
  const source = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  const predicate = /function runtimeModelRetryable\(error: unknown\) \{([\s\S]*?)\n\}/.exec(source)?.[1] || "";

  assert.ok(predicate.includes("429"), "rate limiting must stay retryable");
  assert.ok(predicate.includes("408"), "request timeout must stay retryable");
  assert.ok(predicate.includes(">= 500"), "server errors must stay retryable");
  // A malformed/unsupported request will fail identically every time; retrying
  // only multiplies the user's wait. This is the shape that produced a burst of
  // identical 400s in production.
  assert.ok(!/status === 400|status < 500/.test(predicate), "4xx other than 408/429 must not be retried");
});

test("the page execution loop retries at most once", async () => {
  const source = await readFile(new URL("../client/user-agent-adaptive.ts", import.meta.url), "utf8");
  const maxRetries = Number(/maxRetries: ([0-9]+)/.exec(source)?.[1]);

  assert.equal(maxRetries, 1, "one bounded retry; every extra attempt is real user waiting time");
});

const { resolveWidgetLocale, widgetCopy } = await import(
  `data:text/javascript;base64,${Buffer.from((await build({
    entryPoints: [fileURLToPath(new URL("../client/user-agent-copy.ts", import.meta.url))],
    bundle: true, platform: "neutral", format: "esm", write: false,
  })).outputFiles[0].text).toString("base64")}`);

test("a provider that is merely slow gets the retry's full deadline, and the task is told which it was", async () => {
  // A production task died here. Two router turns came back in 37s and 20s
  // while a capability was being authored on the same gateway; the third was
  // cut at the 20s first-byte deadline, retried, cut again — and the reader
  // was told the task "was interrupted during startup".
  const source = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  const overall = Number(/RUNTIME_MODEL_TIMEOUT_MS = ([0-9_]+)/.exec(source)?.[1].replace(/_/g, ""));
  const firstByte = Number(/RUNTIME_MODEL_FIRST_BYTE_TIMEOUT_MS = ([0-9_]+)/.exec(source)?.[1].replace(/_/g, ""));
  const attempts = Number(/RUNTIME_MODEL_MAX_ATTEMPTS = ([0-9_]+)/.exec(source)?.[1].replace(/_/g, ""));

  // The first attempt still catches a provider that accepted and went silent.
  assert.equal(runtimeModelFirstByteTimeoutMs(0), firstByte);
  // The retry has no separate first-byte cap: "stuck" was ruled out already.
  assert.equal(runtimeModelFirstByteTimeoutMs(1), undefined);
  // The worst case is still bounded, and still well inside the three minutes
  // the deadline test holds the runtime to.
  assert.ok(firstByte + overall * (attempts - 1) <= 180_000);

  // And the reason reaches the reader as itself.
  const timedOut = agentStartupFailure("fetch_timeout_after_20000ms");
  assert.equal(timedOut.code, "runtime_model_unavailable");
  // The wording lives in the catalog; check the entry the runtime resolved, and
  // that both languages name the model and offer a retry.
  const run = widgetCopy(resolveWidgetLocale()).run;
  assert.equal(timedOut.summary, run.modelNoResponse);
  assert.match(widgetCopy("zh").run.modelNoResponse, /模型/);
  assert.match(widgetCopy("zh").run.modelNoResponse, /重试/);
  assert.match(widgetCopy("en").run.modelNoResponse, /model/i);
  assert.match(widgetCopy("en").run.modelNoResponse, /try again/i);
  assert.notEqual(timedOut.summary, run.runtimeStartFailed, `不要再用兜底文案：${timedOut.summary}`);
  assert.equal(agentStartupFailure("main_agent_http_429").code, "runtime_model_unavailable");
  assert.equal(agentStartupFailure("main_agent_http_503").code, "runtime_model_unavailable");
  // A 4xx that is the request's own fault is not the provider being busy.
  assert.equal(agentStartupFailure("main_agent_http_400").code, "agent_runtime_start_failed");
  // The named faults keep their own wording.
  assert.equal(agentStartupFailure("main_agent_turn_limit").code, "main_agent_routing_exhausted");
  assert.equal(agentStartupFailure("main_agent_scene_route_failed:home").code, "main_agent_scene_route_failed");
  assert.equal(agentStartupFailure("cannot read properties of undefined").code, "runtime_capability_metadata_invalid");
});
