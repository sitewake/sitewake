import assert from "node:assert/strict";

const endpoint = (process.env.SITEWAKE_SMOKE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const timeoutMs = Math.max(10_000, Number(process.env.SITEWAKE_SMOKE_TIMEOUT_MS || 120_000));
const deadline = Date.now() + timeoutMs;

async function json(path) {
  const response = await fetch(`${endpoint}${path}`, { signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${text}`);
  return JSON.parse(text);
}

let state;
let healthFailure;
while (Date.now() < deadline) {
  try {
    state = await json("/api/health?deep=1");
    break;
  } catch (error) {
    healthFailure = error;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
if (!state) throw healthFailure || new Error("deep health timed out");
assert.equal(state.status, "ready");
assert.equal(state.runtime, "container");
assert.equal(state.services.database, "ready");
assert.equal(state.services.objectStorage, "ready");
assert.equal(state.services.capabilityV2RunnerLauncher, "ready");
assert.ok(state.runners.registered > 0);
assert.deepEqual([...state.runners.workKinds].sort(), ["author", "execute", "validate"]);

const resources = await json("/api/site-agents?fresh=1");
assert.equal(resources.persistence, "d1");
assert.ok(Array.isArray(resources.agents));

// The model is connected in the console after the stack is up, so a fresh
// install legitimately reports it as not configured; the shape is what counts.
const models = await json("/api/site-agents/__container_smoke__/model");
for (const role of ["execution", "semantic", "adaptive"]) {
  assert.equal(typeof models[role].configured, "boolean", `${role} model status missing`);
  assert.equal(models[role].provider, "openai-compatible");
}

const sdk = await fetch(`${endpoint}/sitewake.js`, { signal: AbortSignal.timeout(10_000) });
const sdkText = await sdk.text();
if (!sdk.ok) throw new Error(`SDK failed: ${sdk.status} ${sdkText}`);
assert.match(sdkText, /SiteWake/);
console.log(JSON.stringify({
  endpoint,
  health: state,
  resources: { persistence: resources.persistence, count: resources.agents.length },
  models,
  sdk: "ready",
}, null, 2));
