import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// The adaptive bundle registers passive browser listeners at module load, so it
// needs a browser-shaped global before import. The budget helpers under test are
// pure, but their module's dependencies are not.
globalThis.window = globalThis;
globalThis.window.addEventListener ||= () => {};
globalThis.window.removeEventListener ||= () => {};
globalThis.document ||= {
  visibilityState: "visible",
  addEventListener() {},
  removeEventListener() {},
  getElementsByTagName() { return []; },
};

async function adaptiveModule() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../client/user-agent-adaptive.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "browser-stubs",
      setup(builder) {
        builder.onResolve({ filter: /^@page-agent\/page-controller$/ }, () => ({ path: "pc", namespace: "stub" }));
        builder.onResolve({ filter: /^@page-agent\/core$/ }, () => ({ path: "core", namespace: "stub" }));
        builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
          loader: "js",
          contents: args.path === "core"
            ? "export class PageAgentCore {} export const tool = value => value;"
            : "export class PageController { constructor(){ this.selectorMap=new Map(); this.elementTextMap=new Map(); } async getBrowserState(){ return {}; } }",
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const adaptive = await adaptiveModule();
const {
  elapsedBudget,
  pauseBudget,
  resumeBudget,
  waitForPageAgentForeground,
  withUserAnswerBudget,
  withPageAgentRuntimeDeadline,
  WALL_LIMIT_MS,
  BACKGROUND_WAIT_LIMIT_MS,
  ASK_USER_LIMIT_MS,
  RUNTIME_DEADLINE_FLOOR_MS,
} = adaptive;

function runtimeAt(startedAt, overrides = {}) {
  return {
    actionReceipts: [],
    observationRefs: [],
    observations: [],
    runtimeMetrics: [],
    startedAt,
    pauseDepth: 0,
    wallStartedAt: startedAt,
    wallExcludedMs: 0,
    budget: {
      activeLimitMs: 180_000,
      modelRequestLimit: 100,
      activeElapsedMs: 0,
      modelRequests: 0,
      noProgressCount: 0,
      wallLimitMs: WALL_LIMIT_MS,
      wallElapsedMs: 0,
      backgroundWaitLimitMs: BACKGROUND_WAIT_LIMIT_MS,
      backgroundWaitMs: 0,
      askUserLimitMs: ASK_USER_LIMIT_MS,
      askUserWaitMs: 0,
      ...overrides,
    },
  };
}

/** A visibility source whose state the test controls directly. */
function visibility(initial = "hidden") {
  const listeners = new Set();
  return {
    visibilityState: initial,
    addEventListener(_type, handler) { listeners.add(handler); },
    removeEventListener(_type, handler) { listeners.delete(handler); },
    reveal() {
      this.visibilityState = "visible";
      for (const handler of [...listeners]) handler();
    },
  };
}

test("wall clock keeps running while active time is paused", () => {
  const start = 1_000_000;
  const runtime = runtimeAt(start);

  // Simulate the page going to the background for two minutes: active time is
  // suspended, but the user is still waiting.
  pauseBudget(runtime, start + 1_000);
  const budget = elapsedBudget(runtime, start + 121_000);

  assert.equal(budget.activeElapsedMs, 1_000, "active time must stop while paused");
  assert.equal(budget.wallElapsedMs, 121_000, "wall clock must keep counting while paused");
  resumeBudget(runtime, start + 121_000);
});

test("wall clock exhausts the budget even when active time is untouched", () => {
  const start = 1_000_000;
  const runtime = runtimeAt(start);
  pauseBudget(runtime, start + 500);

  const budget = elapsedBudget(runtime, start + WALL_LIMIT_MS + 1);

  assert.equal(budget.exhaustedReason, "wall-clock");
  assert.ok(budget.activeElapsedMs < budget.activeLimitMs, "active time alone would not have stopped this task");
});

test("repeated short background stretches accumulate against the wall clock", () => {
  const start = 1_000_000;
  const runtime = runtimeAt(start);
  let clock = start;

  // Each stretch is well under the continuous-background limit, so only the
  // wall clock can stop this pattern.
  for (let index = 0; index < 8; index += 1) {
    pauseBudget(runtime, clock + 1_000);
    clock += 50_000;
    resumeBudget(runtime, clock);
  }
  const budget = elapsedBudget(runtime, clock);

  assert.ok(budget.backgroundWaitMs === 0, "no single stretch is still open");
  assert.equal(budget.exhaustedReason, "wall-clock");
});

test("user-answer waits are excluded from the wall clock", async () => {
  const start = Date.now();
  const runtime = runtimeAt(start);
  let released;
  const answered = new Promise((resolve) => { released = resolve; });

  // The helper's own clock is injected: with the real one, a millisecond
  // ticking between `start` and the pause start reads as 1 ms of wall time.
  const pending = withUserAnswerBudget(runtime, () => answered, new AbortController().signal, () => start);
  // While the question is open the wall clock must not advance.
  const during = elapsedBudget(runtime, start + 60_000);
  assert.equal(during.wallElapsedMs, 0, "an open user question must not consume the wall clock");

  released("ok");
  assert.equal(await pending, "ok");
});

test("an unanswered question terminates on its own limit", async () => {
  const start = Date.now();
  const runtime = runtimeAt(start, { askUserLimitMs: 40 });

  await assert.rejects(
    () => withUserAnswerBudget(runtime, () => new Promise(() => {}), new AbortController().signal),
    /page_agent_budget_exhausted:user-unanswered/,
  );
  assert.equal(runtime.budget.exhaustedReason, "user-unanswered");
});

test("a continuous background stretch terminates on the background limit", async () => {
  const runtime = runtimeAt(Date.now(), { backgroundWaitLimitMs: 40 });
  const source = visibility("hidden");

  await assert.rejects(
    () => waitForPageAgentForeground(runtime, source, new AbortController().signal),
    /page_agent_budget_exhausted:background-wait/,
  );
  assert.equal(runtime.budget.exhaustedReason, "background-wait");
});

test("returning to the foreground before the limit resumes normally", async () => {
  const runtime = runtimeAt(Date.now(), { backgroundWaitLimitMs: 5_000 });
  const source = visibility("hidden");
  const waiting = waitForPageAgentForeground(runtime, source, new AbortController().signal);

  setTimeout(() => source.reveal(), 10);
  const result = await waiting;

  assert.ok(result.waitedMs >= 0);
  assert.equal(runtime.budget.exhaustedReason, undefined, "a normal tab switch must not exhaust the budget");
  assert.equal(runtime.hiddenSince, undefined, "the background stretch must be cleared once visible");
});

test("an instant operation is not timed out when the budget is nearly exhausted", async () => {
  const runtime = runtimeAt(Date.now(), { activeLimitMs: 180_000, activeElapsedMs: 179_999 });

  const value = await withPageAgentRuntimeDeadline(runtime, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return "drained";
  });

  assert.equal(value, "drained");
  assert.ok(RUNTIME_DEADLINE_FLOOR_MS >= 1_000, "the floor must be large enough for a real persist round-trip");
});

test("an operation slower than the deadline still times out", async () => {
  const runtime = runtimeAt(Date.now());

  await assert.rejects(
    () => withPageAgentRuntimeDeadline(runtime, () => new Promise(() => {}), 30),
    /page_agent_evidence_drain_timeout/,
  );
});

test("a timed operation waits for the foreground before starting its deadline", async () => {
  const runtime = runtimeAt(Date.now(), { backgroundWaitLimitMs: 5_000 });
  const source = visibility("hidden");
  let startedWhileHidden = false;

  const pending = withPageAgentRuntimeDeadline(runtime, async () => {
    startedWhileHidden = source.visibilityState === "hidden";
    return "done";
  }, 30, source);

  setTimeout(() => source.reveal(), 60);
  assert.equal(await pending, "done");
  assert.equal(startedWhileHidden, false, "the operation must not start while the tab is throttled");
});
