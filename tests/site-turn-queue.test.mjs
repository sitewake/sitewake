import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Several visitors asking one site something at the same time share one model
// slot. The fifth used to see its task end with "InvokeError: Rate limit
// exceeded:" — the browser treated "wait for your turn" as a failed call and
// showed the framework's error text as the answer.
globalThis.window ||= globalThis;
globalThis.window.addEventListener ||= () => {};
globalThis.window.removeEventListener ||= () => {};
globalThis.document ||= {
  visibilityState: "visible",
  addEventListener() {},
  removeEventListener() {},
  getElementsByTagName() { return []; },
};

async function moduleFrom(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
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
          contents: "export class PageController { constructor(){ this.selectorMap=new Map(); this.elementTextMap=new Map(); } } export class PageAgentCore {} export const tool = value => value;",
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { fetchInSiteTurn, waitsForSiteTurn, SITE_TURN_WAIT_LIMIT_MS } = await moduleFrom("../client/user-agent-shared.ts");
const { pageAgentFrameworkFault, technicalFaultSummary } = await moduleFrom("../client/user-agent-adaptive.ts");
const { isSiteTurnRefusal } = await moduleFrom("../lib/site-knowledge/runtime-model-budget.ts");

const busy = () => new Response(JSON.stringify({ error: { code: "model_rate_limited", reason: "site_concurrency", waitTurn: true } }), { status: 429 });
const overBudget = () => new Response(JSON.stringify({ error: { code: "model_rate_limited", reason: "run_minute", waitTurn: false } }), { status: 429 });
const served = () => new Response("{}", { status: 200 });

function fakeClock() {
  let now = 0;
  return { clock: () => now, sleep: async (ms) => { now += ms; } };
}

test("only another visitor being mid-call is a reason to wait; a spent budget is not", () => {
  assert.equal(isSiteTurnRefusal("site_concurrency"), true);
  assert.equal(isSiteTurnRefusal("request_spacing"), true);
  assert.equal(isSiteTurnRefusal("run_minute"), false);
  assert.equal(isSiteTurnRefusal("site_day"), false);
});

test("a visitor behind others keeps its place until its turn comes", async () => {
  const replies = [busy(), busy(), busy(), served()];
  let sent = 0;
  let queued = 0;
  let dequeued = 0;
  const response = await fetchInSiteTurn(async () => replies[sent++], {
    ...fakeClock(),
    onQueued: () => { queued += 1; },
    onDequeued: () => { dequeued += 1; },
  });
  assert.equal(response.status, 200);
  assert.equal(sent, 4);
  assert.equal(queued, 1, "the visitor is told once that it is waiting");
  assert.equal(dequeued, 1, "and the wait is closed once");
  assert.equal(await waitsForSiteTurn(served()), false);
});

test("other refusals are returned at once, for the caller's own handling", async () => {
  let sent = 0;
  const response = await fetchInSiteTurn(async () => { sent += 1; return overBudget(); }, fakeClock());
  assert.equal(response.status, 429);
  assert.equal(sent, 1);
  const unparseable = await fetchInSiteTurn(async () => new Response("Too Many Requests", { status: 429 }), fakeClock());
  assert.equal(unparseable.status, 429, "a provider's own 429 is not mistaken for the site queue");
});

test("the wait is bounded and stops when the task is cancelled", async () => {
  assert.ok(SITE_TURN_WAIT_LIMIT_MS >= 60_000, "a queue of several visitors must fit");
  let sent = 0;
  const bounded = await fetchInSiteTurn(async () => { sent += 1; return busy(); }, { ...fakeClock(), limitMs: 1_000 });
  assert.equal(bounded.status, 429);
  assert.ok(sent > 1 && sent < 10);

  const controller = new AbortController();
  let afterAbort = 0;
  await fetchInSiteTurn(async () => { afterAbort += 1; if (afterAbort === 2) controller.abort(); return busy(); }, { ...fakeClock(), signal: controller.signal });
  assert.equal(afterAbort, 2);
});

test("a model failure that ended the page agent is a fault, never the answer", () => {
  const rateLimited = Object.assign(new Error("Rate limit exceeded: "), { name: "InvokeError", type: "rate_limit" });
  assert.equal(pageAgentFrameworkFault([{ type: "step" }, { type: "error", message: "InvokeError: Rate limit exceeded: ", rawResponse: rateLimited }]), "page_agent_model_busy");
  const serverError = Object.assign(new Error("Server error"), { name: "InvokeError", type: "server_error" });
  assert.equal(pageAgentFrameworkFault([{ type: "error", rawResponse: serverError }]), "page_agent_model_failed:server_error");
  assert.equal(pageAgentFrameworkFault([{ type: "step" }]), undefined, "an ordinary unfinished round keeps the agent's own text");
  assert.equal(pageAgentFrameworkFault([{ type: "error", message: "Step count exceeded maximum limit" }]), undefined);

  const busyText = technicalFaultSummary("page_agent_model_busy");
  const failedText = technicalFaultSummary("page_agent_model_failed:server_error");
  for (const text of [busyText, failedText]) {
    assert.ok(text && !/InvokeError|rate_limit|page_agent/.test(text), "the visitor reads a sentence, not an error code");
  }
  assert.notEqual(busyText, failedText, "a busy site and a broken model are told apart");
});
