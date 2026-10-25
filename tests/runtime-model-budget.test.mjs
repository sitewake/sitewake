import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

async function load(entry, options = {}) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: options.plugins || [],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const budget = await load("../lib/site-knowledge/runtime-model-budget.ts");
const runStore = await load("../db/agent-run-store.ts");
const siteStore = await load("../db/site-agent-store.ts");
const runtimeRequestLimit = runStore.AGENT_RUN_RUNTIME_MODEL_REQUEST_LIMIT;
assert.equal(runtimeRequestLimit, 100);
const limits = {
  maxRequestsPerRunMinute: 2,
  maxRequestsPerSiteDay: 3,
  maxConcurrentPerRun: 1,
};

let runSequence = 0;
async function createBudgetRun() {
  const sequence = runSequence += 1;
  const siteAgentId = `runtime-model-ledger-${sequence}`;
  const origin = `https://runtime-model-${sequence}.test`;
  await siteStore.createSiteAgent({ id: siteAgentId, url: `${origin}/` });
  await siteStore.getSiteAgentOverview(siteAgentId);
  return runStore.createAgentRun({
    siteAgentId,
    origin,
    url: `${origin}/`,
    goal: "inspect the current page",
    taskInput: {},
    documentId: `document-${sequence}`,
    browserSessionId: `browser-${sequence}`,
    controller: "page-agent",
    requestOrigin: origin,
    controlPlaneOrigin: origin,
  });
}

test("runtime model budget rejects concurrent and per-run bursts before provider use", () => {
  budget.resetRuntimeModelBudgetForTests();
  const first = budget.acquireRuntimeModelBudget({ siteAgentId: "site-a", runId: "run-a", now: 1_000, limits });
  assert.equal(first.allowed, true);
  const concurrent = budget.acquireRuntimeModelBudget({ siteAgentId: "site-a", runId: "run-a", now: 1_001, limits });
  assert.deepEqual(concurrent, { allowed: false, retryAfterSeconds: 1, reason: "run_concurrency" });
  first.release();
  const second = budget.acquireRuntimeModelBudget({ siteAgentId: "site-a", runId: "run-a", now: 1_002, limits });
  assert.equal(second.allowed, true);
  second.release();
  const burst = budget.acquireRuntimeModelBudget({ siteAgentId: "site-a", runId: "run-a", now: 1_003, limits });
  assert.equal(burst.allowed, false);
  assert.equal(burst.reason, "run_minute");
});

test("同一个 run 的新请求取代还挂着的旧调用，而不是吃 429", () => {
  // Production incident: upstream produced no first byte for 20s during routing, the
  // browser gave up and retried; the server's zombie call still held the run's
  // concurrency slot (noticed only when upstream returns or the 60s timeout fires),
  // so the retry was bounced with run_concurrency — and that was the SDK's last
  // attempt. A plain "okay, thanks" ended as "aborted during startup".
  budget.resetRuntimeModelBudgetForTests();
  let aborted = 0;
  const stale = budget.acquireRuntimeModelBudget({ siteAgentId: "site-a", runId: "run-a", now: 1_000, limits, abort: () => { aborted += 1; } });
  assert.equal(stale.allowed, true);
  assert.equal(stale.superseded, false);
  const retry = budget.acquireRuntimeModelBudget({ siteAgentId: "site-a", runId: "run-a", now: 21_000, limits, abort: () => {} });
  assert.equal(retry.allowed, true, "重试被放行");
  assert.equal(retry.superseded, true);
  assert.equal(aborted, 1, "旧调用的上游请求被掐掉");
  // The old call's late release must not also release the retry's slot.
  stale.release();
  // Next minute (the per-run quota is 2 per minute): a third request without an abort handle still supersedes the retry — the retry registered one.
  const third = budget.acquireRuntimeModelBudget({ siteAgentId: "site-a", runId: "run-a", now: 61_000, limits });
  assert.equal(third.allowed, true, "第三个请求取代了重试");
  assert.equal(third.superseded, true);
  third.release();
  // A holder without an abort handle cannot be superseded: the old behaviour stands.
  const plain = budget.acquireRuntimeModelBudget({ siteAgentId: "site-b", runId: "run-b", now: 30_000, limits });
  assert.equal(plain.allowed, true);
  const blocked = budget.acquireRuntimeModelBudget({ siteAgentId: "site-b", runId: "run-b", now: 30_001, limits });
  assert.deepEqual(blocked, { allowed: false, retryAfterSeconds: 1, reason: "run_concurrency" });
  plain.release();
});

test("runtime model budget serializes concurrent runs for one site", () => {
  budget.resetRuntimeModelBudgetForTests();
  const first = budget.acquireRuntimeModelBudget({ siteAgentId: "site-shared", runId: "run-a", now: 1_000, limits });
  assert.equal(first.allowed, true);
  const concurrentRun = budget.acquireRuntimeModelBudget({ siteAgentId: "site-shared", runId: "run-b", now: 1_001, limits });
  assert.deepEqual(concurrentRun, { allowed: false, retryAfterSeconds: 1, reason: "site_concurrency" });
  first.release();
  const afterRelease = budget.acquireRuntimeModelBudget({ siteAgentId: "site-shared", runId: "run-b", now: 1_002, limits });
  assert.equal(afterRelease.allowed, true);
  afterRelease.release();
});

test("runtime model budget applies a site-wide daily ceiling across runs", () => {
  budget.resetRuntimeModelBudgetForTests();
  for (const runId of ["run-a", "run-b", "run-c"]) {
    const acquired = budget.acquireRuntimeModelBudget({ siteAgentId: "site-a", runId, now: 2_000, limits });
    assert.equal(acquired.allowed, true);
    acquired.release();
  }
  const denied = budget.acquireRuntimeModelBudget({ siteAgentId: "site-a", runId: "run-d", now: 2_000, limits });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "site_day");
  const otherSite = budget.acquireRuntimeModelBudget({ siteAgentId: "site-b", runId: "run-a", now: 2_000, limits });
  assert.equal(otherSite.allowed, true);
  otherSite.release();
});

test("runtime model budget spaces real provider calls when configured", () => {
  budget.resetRuntimeModelBudgetForTests();
  const spacedLimits = { ...limits, minRequestIntervalMs: 1_500 };
  const first = budget.acquireRuntimeModelBudget({ siteAgentId: "site-spacing", runId: "run-a", now: 10_000, limits: spacedLimits });
  assert.equal(first.allowed, true);
  first.release();
  const burst = budget.acquireRuntimeModelBudget({ siteAgentId: "site-spacing", runId: "run-a", now: 10_500, limits: spacedLimits });
  assert.deepEqual(burst, { allowed: false, retryAfterSeconds: 1, reason: "request_spacing" });
  const next = budget.acquireRuntimeModelBudget({ siteAgentId: "site-spacing", runId: "run-a", now: 11_500, limits: spacedLimits });
  assert.equal(next.allowed, true);
  next.release();
});

test("AgentRun ledger atomically caps page and boundary provider attempts at 100", async () => {
  const created = await createBudgetRun();
  assert.deepEqual(runStore.readAgentRunRuntimeModelBudget(created.run), {
    requestCount: 0,
    stageCounts: {},
    stageFirstRequestedAt: {},
    stageLastRequestedAt: {},
  });

  for (let index = 0; index < runtimeRequestLimit - 1; index += 1) {
    await runStore.consumeAgentRunRuntimeModelRequest(created.run.id, {
      token: created.resumeToken,
      stage: index % 2 ? "runtime-boundary" : "runtime-page-agent",
    });
  }
  const boundary = await Promise.allSettled([
    runStore.consumeAgentRunRuntimeModelRequest(created.run.id, { token: created.resumeToken, stage: "runtime-page-agent" }),
    runStore.consumeAgentRunRuntimeModelRequest(created.run.id, { token: created.resumeToken, stage: "runtime-boundary" }),
  ]);
  assert.equal(boundary.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(boundary.filter((item) => item.status === "rejected").length, 1);
  assert.match(String(boundary.find((item) => item.status === "rejected")?.reason), /agent_run_model_budget_exhausted/);

  const stored = (await runStore.getAgentRun(created.run.id, created.resumeToken)).run;
  const ledger = runStore.readAgentRunRuntimeModelBudget(stored);
  assert.equal(ledger.requestCount, runtimeRequestLimit);
  assert.equal((ledger.stageCounts["runtime-page-agent"] || 0) + (ledger.stageCounts["runtime-boundary"] || 0), runtimeRequestLimit);
  assert.ok(Number.isFinite(Date.parse(ledger.firstRequestedAt)));
  assert.ok(Number.isFinite(Date.parse(ledger.lastRequestedAt)));
  assert.ok(Number.isFinite(Date.parse(ledger.stageFirstRequestedAt["runtime-page-agent"] || ledger.stageFirstRequestedAt["runtime-boundary"])));
  assert.ok(Number.isFinite(Date.parse(ledger.stageLastRequestedAt["runtime-page-agent"] || ledger.stageLastRequestedAt["runtime-boundary"])));
  await assert.rejects(
    runStore.consumeAgentRunRuntimeModelRequest(created.run.id, { token: created.resumeToken, stage: "runtime-page-agent" }),
    /agent_run_model_budget_exhausted/,
  );
});

test("AgentRun ledger rejects terminal Runs without changing the durable count", async () => {
  const created = await createBudgetRun();
  const charged = await runStore.consumeAgentRunRuntimeModelRequest(created.run.id, {
    token: created.resumeToken,
    stage: "runtime-boundary",
  });
  const finished = await runStore.finishAgentRun(created.run.id, {
    token: created.resumeToken,
    expectedRevision: charged.run.revision,
    pageEpoch: charged.run.pageEpoch,
    status: "failed",
  });
  await assert.rejects(
    runStore.consumeAgentRunRuntimeModelRequest(created.run.id, { token: created.resumeToken, stage: "runtime-page-agent" }),
    /agent_run_model_budget_terminal:failed/,
  );
  assert.equal(runStore.readAgentRunRuntimeModelBudget(finished.run).requestCount, 1);
  const stored = (await runStore.getAgentRun(created.run.id, created.resumeToken)).run;
  assert.equal(runStore.readAgentRunRuntimeModelBudget(stored).requestCount, 1);
});

test("runtime proxy charges every runtime stage and has no hidden compatibility or transport retry", async () => {
  const source = await readFile(new URL("../app/api/site-agents/[siteAgentId]/model/v2/chat/completions/route.ts", import.meta.url), "utf8");
  // The provider contract and the single provider request live in lib/model-proxy/forward.ts,
  // shared with the internal proxy; this route adds nothing between them.
  assert.match(source, /upstreamPayload = providerPayload\(config, \{ \.\.\.body, parallel_tool_calls: false \}\)/);
  assert.match(source, /const attempts:[\s\S]*?= \[\s*upstreamPayload,\s*\]/);
  assert.doesNotMatch(source, /guardedRuntimeStage|maximumAttempts|unsupportedParameter/);
  const attemptLoop = source.slice(source.indexOf("for (const payload of attempts)"), source.indexOf("const contentType =", source.indexOf("for (const payload of attempts)")));
  assert.ok(attemptLoop.indexOf("consumeAgentRunRuntimeModelRequest") < attemptLoop.indexOf("forwardToProvider("));
  assert.match(source, /const persist = \(patch:[\s\S]*recordModelInvocation/);
  assert.doesNotMatch(source, /recordModelInvocation\([\s\S]{0,300}\.catch\(\(\) => undefined\)/);
  assert.match(source, /catch\(reportStreamInvocationPersistenceFailure\)/);
});

test("runtime proxy shares one durable 100-attempt ceiling across router, page, boundary, and judge stages", async () => {
  const route = await load("../app/api/site-agents/[siteAgentId]/model/v2/chat/completions/route.ts", {
    plugins: [{
      name: "next-server-runtime-stub",
      setup(builder) {
        builder.onResolve({ filter: /^next\/server$/ }, () => ({ path: "next-server", namespace: "runtime-model-test" }));
        builder.onLoad({ filter: /.*/, namespace: "runtime-model-test" }, () => ({
          loader: "js",
          contents: "export class NextRequest extends Request {} export class NextResponse extends Response {}",
        }));
      },
    }],
  });
  const created = await createBudgetRun();
  const siteAgentId = created.run.scope.siteAgentId;
  const origin = created.run.scope.allowedOrigins[0];
  const previousFetch = globalThis.fetch;
  const previousEnvironment = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    SITEWAKE_MODEL_MAX_REQUESTS_PER_RUN_MINUTE: process.env.SITEWAKE_MODEL_MAX_REQUESTS_PER_RUN_MINUTE,
    SITEWAKE_MODEL_MIN_INTERVAL_MS: process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS,
  };
  let providerAttempts = 0;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = "https://provider.test/v1";
  process.env.OPENAI_MODEL = "test-model";
  process.env.SITEWAKE_MODEL_MAX_REQUESTS_PER_RUN_MINUTE = "1000";
  process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS = "0";
  globalThis.fetch = async (input) => {
    assert.match(String(input), /provider\.test\/v1\/chat\/completions$/);
    providerAttempts += 1;
    return new Response(JSON.stringify({
      id: `completion-${providerAttempts}`,
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const invoke = (stage) => route.POST(new Request(`${origin}/api/model`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${created.resumeToken}`,
      "content-type": "application/json",
      origin,
      "x-sitewake-ai-stage": stage,
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  }), { params: { siteAgentId } });
  try {
    const stages = ["runtime-router", "runtime-page-agent", "runtime-boundary", "outcome-judge"];
    for (let index = 0; index < runtimeRequestLimit; index += 1) {
      const response = await invoke(stages[index % stages.length]);
      assert.equal(response.status, 200);
    }
    const denied = await invoke("runtime-page-agent");
    assert.equal(denied.status, 429);
    assert.equal((await denied.json()).error.code, "agent_run_model_budget_exhausted");
    assert.equal(providerAttempts, runtimeRequestLimit);
    const stored = (await runStore.getAgentRun(created.run.id, created.resumeToken)).run;
    const ledger = runStore.readAgentRunRuntimeModelBudget(stored);
    assert.equal(ledger.requestCount, runtimeRequestLimit);
    assert.equal(ledger.stageCounts["runtime-router"], 25);
    assert.equal(ledger.stageCounts["outcome-judge"], 25);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("runtime proxy: a retry after a stalled upstream call is admitted and the stalled call is aborted", async () => {
  const route = await load("../app/api/site-agents/[siteAgentId]/model/v2/chat/completions/route.ts", {
    plugins: [{
      name: "next-server-runtime-stub",
      setup(builder) {
        builder.onResolve({ filter: /^next\/server$/ }, () => ({ path: "next-server", namespace: "runtime-model-test" }));
        builder.onLoad({ filter: /.*/, namespace: "runtime-model-test" }, () => ({
          loader: "js",
          contents: "export class NextRequest extends Request {} export class NextResponse extends Response {}",
        }));
      },
    }],
  });
  const created = await createBudgetRun();
  const siteAgentId = created.run.scope.siteAgentId;
  const origin = created.run.scope.allowedOrigins[0];
  const previousFetch = globalThis.fetch;
  const previousEnvironment = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    SITEWAKE_MODEL_MIN_INTERVAL_MS: process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS,
  };
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = "https://provider.test/v1";
  process.env.OPENAI_MODEL = "test-model";
  process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS = "0";
  let providerAttempts = 0;
  const abortedUpstream = [];
  // The first upstream call never returns (no first byte for 20s); it only ends when aborted.
  globalThis.fetch = async (input, init) => {
    providerAttempts += 1;
    const attempt = providerAttempts;
    if (attempt === 1) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => { abortedUpstream.push(attempt); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
      });
    }
    return new Response(JSON.stringify({ id: `completion-${attempt}`, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const invoke = () => route.POST(new Request(`${origin}/api/model`, {
    method: "POST",
    headers: { authorization: `Bearer ${created.resumeToken}`, "content-type": "application/json", origin, "x-sitewake-ai-stage": "runtime-router" },
    body: JSON.stringify({ messages: [{ role: "user", content: "好的，谢谢" }] }),
  }), { params: { siteAgentId } });
  try {
    const stalled = invoke();
    // Wait until the first call has really reached upstream (and holds the slot).
    while (providerAttempts < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const retried = await invoke();
    assert.equal(retried.status, 200, "浏览器的重试被放行，而不是 run_concurrency 429");
    assert.deepEqual(abortedUpstream, [1], "僵尸调用的上游请求被掐掉");
    const stalledResponse = await stalled;
    assert.ok(stalledResponse.status >= 500, `被取代的调用以错误收尾: ${stalledResponse.status}`);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("runtime proxy sends complete Qwen payloads for router, PageAgent, judge, and runtime-boundary stages", async () => {
  const route = await load("../app/api/site-agents/[siteAgentId]/model/v2/chat/completions/route.ts", {
    plugins: [{
      name: "next-server-runtime-stub",
      setup(builder) {
        builder.onResolve({ filter: /^next\/server$/ }, () => ({ path: "next-server", namespace: "runtime-model-policy-test" }));
        builder.onLoad({ filter: /.*/, namespace: "runtime-model-policy-test" }, () => ({
          loader: "js",
          contents: "export class NextRequest extends Request {} export class NextResponse extends Response {}",
        }));
      },
    }],
  });
  const created = await createBudgetRun();
  const siteAgentId = created.run.scope.siteAgentId;
  const origin = created.run.scope.allowedOrigins[0];
  const previousFetch = globalThis.fetch;
  const previousEnvironment = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    SITEWAKE_MODEL_MIN_INTERVAL_MS: process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS,
  };
  const providerPayloads = [];
  globalThis.fetch = async (_input, init) => {
    providerPayloads.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({
      id: "completion-policy",
      choices: [{ message: { role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "report_outcome", arguments: "{}" } }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const request = (stage, toolChoice) => new Request(`${origin}/api/model`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${created.resumeToken}`,
      "content-type": "application/json",
      origin,
      "x-sitewake-ai-stage": stage,
    },
    body: JSON.stringify({
      model: "sitewake-site-agent-browser-alias",
      messages: [{ role: "user", content: "Judge the result" }],
      tools: [{ type: "function", function: { name: "report_outcome", parameters: { type: "object", properties: {} } } }],
      tool_choice: toolChoice,
      reasoning_effort: "low",
      thinking: { type: "enabled" },
    }),
  });
  try {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
    process.env.OPENAI_MODEL = "qwen3.8-max";
    process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS = "0";
    const stageChoices = [
      ["runtime-router", "auto"],
      ["runtime-page-agent", { type: "function", function: { name: "AgentOutput" } }],
      ["outcome-judge", { type: "function", function: { name: "report_outcome" } }],
      ["runtime-boundary", { type: "function", function: { name: "report_outcome" } }],
      ["runtime-agent", "required"],
    ];
    for (const [stage, toolChoice] of stageChoices) {
      const succeeded = await route.POST(request(stage, toolChoice), { params: { siteAgentId } });
      assert.equal(succeeded.status, 200, stage);
    }
    const common = {
      model: "qwen3.8-max",
      messages: [{ role: "user", content: "Judge the result" }],
      tools: [{ type: "function", function: { name: "report_outcome", parameters: { type: "object", properties: {} } } }],
      parallel_tool_calls: false,
    };
    assert.deepEqual(providerPayloads.slice(0, 1), stageChoices.slice(0, 1).map(([, toolChoice]) => ({
      ...common,
      tool_choice: toolChoice,
      reasoning_effort: "low",
      thinking: { type: "enabled" },
    })));
    assert.deepEqual(providerPayloads.slice(1), stageChoices.slice(1).map(([, toolChoice]) => ({
      ...common,
      tool_choice: toolChoice,
      enable_thinking: false,
    })));

    process.env.OPENAI_BASE_URL = "https://unknown-compatible.example/v1";
    const rejected = await route.POST(request("outcome-judge", { type: "function", function: { name: "report_outcome" } }), { params: { siteAgentId } });
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).error.code, "forced_tool_choice_provider_unsupported");
    assert.equal(providerPayloads.length, 5);
    const stored = (await runStore.getAgentRun(created.run.id, created.resumeToken)).run;
    assert.equal(runStore.readAgentRunRuntimeModelBudget(stored).requestCount, 5);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a second visitor of the same site waits for the model slot instead of failing", async () => {
  budget.resetRuntimeModelBudgetForTests();
  const shared = { maxRequestsPerRunMinute: 100, maxRequestsPerSiteDay: 10_000, maxConcurrentPerRun: 1, maxConcurrentPerSite: 1, minRequestIntervalMs: 1_500 };
  let now = 10_000;
  const clock = () => now;
  const first = budget.acquireRuntimeModelBudget({ siteAgentId: "busy-site", runId: "visitor-a", now, limits: shared });
  assert.equal(first.allowed, true);
  // The first visitor's call takes six seconds; the browser's own retry after
  // one second used to meet the same refusal and end the task.
  const waited = [];
  const second = await budget.waitForRuntimeModelBudget({
    siteAgentId: "busy-site", runId: "visitor-b", now, limits: shared, clock,
    sleep: async (ms) => { waited.push(ms); now += ms; if (now >= 16_000 && first.allowed) first.release(); },
  });
  assert.equal(second.allowed, true, "the second visitor is served once the slot frees");
  assert.ok(waited.length > 1 && waited.every((ms) => ms > 0 && ms <= 500), "it polls in short steps rather than one long sleep");
  second.release();
});

test("waiting is bounded, limited to limits shared with other visitors, and stops when the request goes away", async () => {
  budget.resetRuntimeModelBudgetForTests();
  const shared = { maxRequestsPerRunMinute: 1, maxRequestsPerSiteDay: 10_000, maxConcurrentPerRun: 1, maxConcurrentPerSite: 1, minRequestIntervalMs: 0 };
  let now = 50_000;
  const clock = () => now;
  const sleep = async (ms) => { now += ms; };
  const holder = budget.acquireRuntimeModelBudget({ siteAgentId: "s", runId: "a", now, limits: shared });
  const refused = await budget.waitForRuntimeModelBudget({ siteAgentId: "s", runId: "b", now, limits: shared, clock, sleep, maxWaitMs: 15_000 });
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, "site_concurrency");
  assert.ok(now - 50_000 >= 15_000 && now - 50_000 < 16_000, "a stuck slot is given up on at the bound");
  holder.release();

  const own = budget.acquireRuntimeModelBudget({ siteAgentId: "t", runId: "c", now, limits: shared });
  own.release();
  const before = now;
  const overRun = await budget.waitForRuntimeModelBudget({ siteAgentId: "t", runId: "c", now, limits: shared, clock, sleep });
  assert.equal(overRun.allowed, false);
  assert.equal(overRun.reason, "run_minute", "a run's own budget is not another visitor's turn; it is refused at once");
  assert.equal(now, before);

  const blocker = budget.acquireRuntimeModelBudget({ siteAgentId: "u", runId: "d", now, limits: shared });
  const aborted = new AbortController();
  aborted.abort();
  const gone = await budget.waitForRuntimeModelBudget({ siteAgentId: "u", runId: "e", now, limits: shared, clock, sleep, signal: aborted.signal });
  assert.equal(gone.allowed, false, "a visitor who left is not kept in the queue");
  blocker.release();
});
