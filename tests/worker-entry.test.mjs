/**
 * The worker entry serves two runtimes: a Cloudflare / local-dev isolate with
 * bindings in `env`, and vinext's Node server in the container, which calls
 * `fetch` with no `env` at all. The per-request model-settings load must only
 * happen when there is a D1 binding to load from — the Node control plane
 * already loaded it at startup — and must never throw on a missing `env`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

async function loadWorker() {
  const calls = { loads: [], handled: [] };
  globalThis.__SITEWAKE_WORKER_ENTRY_TEST__ = calls;
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../worker/index.ts", import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{
      name: "worker-entry-stubs",
      setup(builder) {
        builder.onResolve({ filter: /^vinext\/server\// }, (args) => ({ path: args.path, namespace: "stub" }));
        builder.onLoad({ filter: /app-router-entry$/, namespace: "stub" }, () => ({
          loader: "js",
          contents: `export default { async fetch(request, env) { globalThis.__SITEWAKE_WORKER_ENTRY_TEST__.handled.push({ url: request.url, env }); return new Response("handled"); } };`,
        }));
        builder.onLoad({ filter: /image-optimization$/, namespace: "stub" }, () => ({
          loader: "js",
          contents: `export const DEFAULT_DEVICE_SIZES = []; export const DEFAULT_IMAGE_SIZES = []; export async function handleImageOptimization() { return new Response("image"); }`,
        }));
        builder.onLoad({ filter: /[\\/]lib[\\/]model-settings\.ts$/ }, () => ({
          loader: "ts",
          contents: `export async function ensureModelSettingsLoaded(database) { globalThis.__SITEWAKE_WORKER_ENTRY_TEST__.loads.push(database); return null; }`,
        }));
      },
    }],
  });
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  return { worker: module.default, calls };
}

const ctx = { waitUntil() {}, passThroughOnException() {} };

test("the Node control plane calls the entry with no env: nothing is loaded and the request is served", async () => {
  const { worker, calls } = await loadWorker();
  const response = await worker.fetch(new Request("http://control-plane:3000/api/health"), undefined, ctx);
  assert.equal(await response.text(), "handled");
  assert.deepEqual(calls.loads, [], "no binding, no load");
  assert.equal(calls.handled.length, 1);
});

test("a Worker with a D1 binding loads the saved model settings before handing the request on", async () => {
  const { worker, calls } = await loadWorker();
  const DB = { prepare() {}, batch() {} };
  await worker.fetch(new Request("http://control-plane:3000/api/system/model"), { DB }, ctx);
  await worker.fetch(new Request("http://control-plane:3000/api/site-agents"), { DB }, ctx);
  assert.equal(calls.loads.length, 2, "asked on every request; the loader itself memoizes");
  assert.ok(calls.loads.every((database) => database === DB));
  assert.equal(calls.handled.length, 2);
  // Bindings without a database (memory mode) are treated like no env.
  await worker.fetch(new Request("http://control-plane:3000/"), { ASSETS: {} }, ctx);
  assert.equal(calls.loads.length, 2);
});
