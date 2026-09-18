import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

async function bundledPortModule() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../client/user-agent-port.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    return await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

const { FetchTimeoutError, fetchWithTimeout, readMainAgentTurnResponse } = await bundledPortModule();
const encoder = new TextEncoder();

test("fetch timeout covers JSON response body consumption and cancels the source", async () => {
  const originalFetch = globalThis.fetch;
  let canceledWith;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"ok":'));
    },
    cancel(reason) {
      canceledWith = reason;
    },
  }), { headers: { "content-type": "application/json" } });

  try {
    const response = await fetchWithTimeout("https://example.test/slow-json", {}, 25);
    await assert.rejects(response.json(), (error) => {
      assert.ok(error instanceof FetchTimeoutError);
      assert.equal(error.name, "FetchTimeoutError");
      assert.equal(error.timeoutMs, 25);
      assert.match(error.message, /fetch_timeout_after_25ms/);
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(canceledWith instanceof FetchTimeoutError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetch timeout preserves ordinary JSON responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
    status: 201,
    headers: { "content-type": "application/json", "x-test": "preserved" },
  });

  try {
    const response = await fetchWithTimeout("https://example.test/json", {}, 250);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-test"), "preserved");
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an external AbortSignal aborts response body consumption and cancels the source", async () => {
  const originalFetch = globalThis.fetch;
  let canceledWith;
  globalThis.fetch = async () => new Response(new ReadableStream({
    cancel(reason) {
      canceledWith = reason;
    },
  }));

  try {
    const controller = new AbortController();
    const response = await fetchWithTimeout("https://example.test/external-abort", { signal: controller.signal }, 1_000);
    const body = response.text();
    const reason = new Error("caller_aborted_stream");
    controller.abort(reason);
    await assert.rejects(body, (error) => error === reason);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(canceledWith, reason);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("main-agent SSE consumption stops at DONE without waiting for socket close", async () => {
  const originalFetch = globalThis.fetch;
  let canceledWith;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "ready" } }] })}\n\ndata: [DONE]\n\n`));
    },
    cancel(reason) {
      canceledWith = reason;
    },
  }), { headers: { "content-type": "text/event-stream" } });

  try {
    const response = await fetchWithTimeout("https://example.test/sse-done", {}, 1_000);
    const streamed = [];
    const result = await readMainAgentTurnResponse(response, (content) => streamed.push(content));
    assert.equal(result.choices?.[0]?.message?.content, "ready");
    assert.deepEqual(streamed, ["ready"]);
    assert.equal(canceledWith, "sse_done");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("main-agent SSE consumption rejects when the body stalls", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`));
    },
  }), { headers: { "content-type": "text/event-stream" } });

  try {
    const response = await fetchWithTimeout("https://example.test/sse-stall", {}, 25);
    await assert.rejects(readMainAgentTurnResponse(response), (error) => {
      assert.ok(error instanceof FetchTimeoutError);
      assert.equal(error.timeoutMs, 25);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
