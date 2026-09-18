import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

// The background-wait limit is the guardrail that replaced the ten-minute hang.
// It arms a `setTimeout` at the moment the page goes away and races it against
// a `visibilitychange` listener, so it depends on real DOM event dispatch and
// on the timer actually firing. The unit suite drives a hand-written visibility
// source and a hand-written clock; both would keep passing if the real document
// never delivered the event.
//
// What this suite adds: a real `document`, real listener registration, real
// event dispatch, and a real timer.
//
// What it deliberately does NOT claim: that Chromium's hidden-tab timer
// throttling was measured. Playwright keeps every page reported as visible —
// `bringToFront`, `Page.setWebLifecycleState`, and minimising the window were
// all tried and none produces `visibilityState === "hidden"` — so a genuinely
// backgrounded tab is not reachable under automation. Instead the last test
// models the coarsest wake-up behaviour Chromium documents and asserts the wait
// still ends, bounded. Confirming the real thing needs a person switching tabs.
const ROOT = new URL("../", import.meta.url);

async function probeBundle() {
  const result = await build({
    stdin: {
      contents: `
        import * as adaptive from "./client/user-agent-adaptive";
        globalThis.__budgetProbe__ = adaptive;
      `,
      resolveDir: fileURLToPath(ROOT),
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome110"],
    write: false,
    plugins: [{
      name: "page-agent-stubs",
      setup(builder) {
        builder.onResolve({ filter: /^@page-agent\// }, (args) => ({ path: args.path, namespace: "stub" }));
        builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
          loader: "js",
          contents: args.path.endsWith("core")
            ? "export class PageAgentCore {} export const tool = value => value;"
            : "export class PageController { constructor(){ this.selectorMap=new Map(); this.elementTextMap=new Map(); } async getBrowserState(){ return {}; } }",
        }));
      },
    }],
  });
  return result.outputFiles[0].text;
}

/**
 * Make the real document report itself hidden. The runtime reads
 * `visibilityState` and subscribes to `visibilitychange` on whatever source it
 * is handed, so overriding the property leaves both the listener registration
 * and the event delivery genuinely the browser's.
 */
const HARNESS = `() => {
  let state = "hidden";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => state === "hidden" });
  window.__reveal__ = () => {
    state = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  };
  /** Model a browser that only wakes timers on coarse boundaries. */
  window.__throttleTimers__ = (bucketMs) => {
    const real = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms, ...rest) => real(fn, Math.ceil((Number(ms) || 0) / bucketMs) * bucketMs, ...rest);
  };
  window.__startWait__ = (limitMs) => {
    const runtime = {
      actionReceipts: [], observationRefs: [], observations: [], runtimeMetrics: [],
      startedAt: Date.now(), pauseDepth: 0, wallStartedAt: Date.now(), wallExcludedMs: 0,
      budget: {
        activeLimitMs: 180000, modelRequestLimit: 100, activeElapsedMs: 0, modelRequests: 0,
        noProgressCount: 0, wallLimitMs: 360000, wallElapsedMs: 0,
        backgroundWaitLimitMs: limitMs, backgroundWaitMs: 0,
        askUserLimitMs: 180000, askUserWaitMs: 0,
      },
    };
    const startedAt = Date.now();
    window.__runtime__ = runtime;
    window.__outcome__ = undefined;
    window.__budgetProbe__.waitForPageAgentForeground(runtime, document, new AbortController().signal)
      .then((value) => { window.__outcome__ = { settled: "resolved", value, elapsedMs: Date.now() - startedAt }; })
      .catch((error) => { window.__outcome__ = { settled: "rejected", message: String((error && error.message) || error), elapsedMs: Date.now() - startedAt }; });
  };
}`;

const bundle = await probeBundle();
const browser = await chromium.launch();
test.after(() => browser.close());

async function hiddenPage() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("about:blank");
  await page.addScriptTag({ content: bundle });
  await page.evaluate(`(${HARNESS})()`);
  return { context, page };
}

async function outcomeOf(page, timeoutMs) {
  await page.waitForFunction("window.__outcome__ !== undefined", null, { timeout: timeoutMs, polling: 100 });
  return page.evaluate("window.__outcome__");
}

test("a page that never comes back still ends, on its own timer", async () => {
  const LIMIT_MS = 4_000;
  const { context, page } = await hiddenPage();
  try {
    await page.evaluate(`window.__startWait__(${LIMIT_MS})`);
    const outcome = await outcomeOf(page, LIMIT_MS + 20_000);

    assert.equal(outcome.settled, "rejected", "this is the ten-minute hang; it must not be possible");
    assert.equal(outcome.message, "page_agent_budget_exhausted:background-wait");
    assert.ok(outcome.elapsedMs >= LIMIT_MS - 250, `ended at ${outcome.elapsedMs}ms, before its own limit`);
    assert.equal(await page.evaluate("document.visibilityState"), "hidden",
      "still hidden, so the timer is what ended it — not a stray visibility event");
  } finally {
    await context.close();
  }
});

test("the real visibilitychange event resumes the task", async () => {
  const { context, page } = await hiddenPage();
  try {
    await page.evaluate("window.__startWait__(30000)");
    await page.evaluate("window.__reveal__()");
    const outcome = await outcomeOf(page, 15_000);

    assert.equal(outcome.settled, "resolved", "a user who comes back must not lose the task");
    assert.ok(outcome.value.waitedMs >= 0);
    assert.ok(outcome.elapsedMs < 5_000, "it must resume on the event, not sit out the limit");
  } finally {
    await context.close();
  }
});

test("the wait stays bounded even when timers only fire on coarse boundaries", async () => {
  // Chromium aligns timers in a hidden tab to 1s, and to 1min once a page has
  // been hidden for over five minutes with a chained timer. Ours is a single
  // timer under 5min, so 1s alignment is what it should meet — but the property
  // that matters is that alignment delays the ending, never removes it.
  const LIMIT_MS = 3_000;
  const BUCKET_MS = 2_000;
  const { context, page } = await hiddenPage();
  try {
    await page.evaluate(`window.__throttleTimers__(${BUCKET_MS})`);
    await page.evaluate(`window.__startWait__(${LIMIT_MS})`);
    const outcome = await outcomeOf(page, LIMIT_MS + BUCKET_MS + 20_000);

    assert.equal(outcome.settled, "rejected");
    assert.equal(outcome.message, "page_agent_budget_exhausted:background-wait");
    assert.ok(outcome.elapsedMs <= LIMIT_MS + BUCKET_MS + 1_500,
      `throttling must cost at most one boundary, but the wait ran ${outcome.elapsedMs}ms`);
  } finally {
    await context.close();
  }
});

test("the ending reads as a switched-away page, not as a fault", async () => {
  const { context, page } = await hiddenPage();
  try {
    const termination = await page.evaluate(
      "window.__budgetProbe__.terminationFromBudget('page_agent_budget_exhausted:background-wait', undefined)");

    assert.equal(termination.status, "unknown", "the page was switched away; nothing actually broke");
    assert.equal(termination.code, "agent_background_wait_exhausted");
    assert.match(termination.summary, /页面切走/, "the user has to learn why it stopped");
    assert.match(termination.summary, /重新发起/, "and what to do about it");
    assert.doesNotMatch(termination.summary, /技术问题/, "the generic fault line is what this replaced");
  } finally {
    await context.close();
  }
});
