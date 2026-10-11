import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// PageAgent's browser bundles register passive listeners at module load. The
// pure protocol helpers under test do not need a DOM, but they do need the
// minimal browser-shaped global expected by those dependencies.
globalThis.window = globalThis;
globalThis.window.addEventListener ||= () => {};
globalThis.window.removeEventListener ||= () => {};
globalThis.document ||= {
  visibilityState: "visible",
  addEventListener() {},
  removeEventListener() {},
  getElementsByTagName() { return new Array(7); },
};

async function bundledModule(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "page-agent-browser-stubs",
      setup(builder) {
        builder.onResolve({ filter: /^@page-agent\/page-controller$/ }, () => ({ path: "page-controller", namespace: "test-stub" }));
        builder.onLoad({ filter: /.*/, namespace: "test-stub" }, () => ({
          loader: "js",
          contents: `export class PageController {
            constructor() { this.selectorMap = new Map(); this.elementTextMap = new Map(); this.rawCalls = 0; }
            async getBrowserState() {
              this.rawCalls += 1;
              return { ...(globalThis.__PAGE_AGENT_TEST_STATE__ || { url: "https://shop.test/", title: "Shop", header: "", content: "", footer: "" }) };
            }
          }`,
        }));
        builder.onResolve({ filter: /^@page-agent\/core$/ }, () => ({ path: "page-agent-core", namespace: "test-core-stub" }));
        builder.onLoad({ filter: /.*/, namespace: "test-core-stub" }, () => ({
          loader: "js",
          contents: "export class PageAgentCore {} export const tool = value => value;",
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

function observation(overrides = {}) {
  return {
    schemaVersion: "page-agent-observation.v1",
    id: "observation-1",
    siteAgentId: "site",
    runId: "run",
    episodeId: "episode",
    browserSessionId: "browser",
    documentId: "document",
    pageEpoch: 1,
    turnIndex: 0,
    kind: "full",
    state: { url: "https://shop.test/search", title: "Search", header: "", content: "cushion", footer: "" },
    targets: [{ observationId: "observation-1", index: 1, semanticId: "search", accessibleName: "Search" }],
    sha256: "a".repeat(64),
    producer: { controller: "@page-agent/page-controller", controllerVersion: "1.12.1", projection: "user-agent-adaptive", projectionVersion: 2 },
    capturedAt: "2026-08-13T00:00:00.000Z",
    expiresAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

// The login/captcha boundary subsystem this suite used to cover was removed
// with `client/site-agent-human.ts`: the runtime no longer pauses on a detected
// boundary, it runs to its budget and says what it could not finish. The
// sensitive-control defence it sat next to did not go with it — that lives in
// `client/user-agent-shared.ts` and is covered by
// `tests/sensitive-control-blocking.test.mjs` against a real browser.

test("the shared sanitizer redacts credentials and sensitive URL fields without erasing business text", async () => {
  const controller = await bundledModule("../client/user-agent-page-controller.ts");
  const state = controller.sanitizePageAgentBrowserState({
    url: "https://shop.test/search?q=cushion&token=secret&sessionId=s123#otp=919191",
    title: "Cushion results",
    header: "password=hunter2 credit_card=4111111111111111",
    content: "[1]<input name=cvc value=321> cushion password=keepout otp=123456",
    footer: "Cushion catalog",
  });
  assert.match(state.url, /q=cushion/);
  assert.match(state.url, /token=%5BREDACTED%5D/);
  assert.match(state.url, /sessionId=%5BREDACTED%5D/);
  assert.doesNotMatch(JSON.stringify(state), /secret|s123|919191|hunter2|4111111111111111|321|keepout|123456/);
  assert.match(JSON.stringify(state), /cushion/i);
});

test("controller captures one exact sanitized state per action boundary and emits a strict full/delta chain", async () => {
  const controllerModule = await bundledModule("../client/user-agent-page-controller.ts");
  globalThis.__PAGE_AGENT_TEST_STATE__ = {
    url: "https://shop.test/search?q=cushion&token=secret",
    title: "Cushion",
    header: "",
    content: "password=hunter2 cushion",
    footer: "",
  };
  const seen = [];
  const metrics = [];
  const controller = new controllerModule.SiteAgentPageController({
    context: { siteAgentId: "site", runId: "run", episodeId: "episode", browserSessionId: "browser", documentId: "document", pageEpoch: 4 },
    onObservation: (item) => { seen.push(item); },
    onMetric: (stage, startedAt, detail) => { metrics.push({ stage, startedAt, detail }); },
  });
  controller.beginTurn(0);
  const first = await controller.getBrowserState();
  assert.strictEqual(await controller.getBrowserState(), first);
  assert.strictEqual(seen[0].state, first);
  assert.equal(controller.rawCalls, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "full");
  assert.equal(seen[0].pageEpoch, 4);
  assert.match(seen[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(Date.parse(seen[0].expiresAt) - Date.parse(seen[0].capturedAt), 14 * 24 * 60 * 60_000);
  assert.deepEqual(metrics.map((item) => item.stage), ["observe_raw", "observe_project"]);
  assert.deepEqual(metrics[0].detail, {
    domNodeCount: 7,
    interactiveCount: 0,
    formControlCount: 0,
    formControlIndexes: [],
    stateFormControlIndexes: [],
    stateBytes: new TextEncoder().encode(JSON.stringify(globalThis.__PAGE_AGENT_TEST_STATE__)).byteLength,
  });
  assert.equal(metrics[1].detail.domNodeCount, 7);
  assert.equal(metrics[1].detail.interactiveCount, 0);
  assert.equal(metrics[1].detail.stateBytes, new TextEncoder().encode(JSON.stringify(first)).byteLength);
  assert.ok(metrics[1].detail.observationBytes > metrics[1].detail.stateBytes);

  controller.beginTurn(1);
  assert.strictEqual(await controller.getBrowserState(), first);
  assert.equal(controller.rawCalls, 1);
  assert.equal(seen.length, 1);

  controller.markActionBoundary();
  controller.beginTurn(2);
  const after = await controller.getBrowserState();
  assert.equal(controller.rawCalls, 2);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].kind, "delta");
  assert.equal(seen[1].baseObservationId, seen[0].id);
  assert.equal(seen[1].turnIndex, 2);
  assert.strictEqual(seen[1].state, after);
  assert.deepEqual(controllerModule.pageAgentObservationChain(seen[1], "next-document", 5), { kind: "full" });
  await controller.drainObservations();

  const correctionSeen = [];
  const correction = new controllerModule.SiteAgentPageController({
    context: { siteAgentId: "site", runId: "run", episodeId: "episode", browserSessionId: "browser", documentId: "document", pageEpoch: 4 },
    initialSeed: controller.exportSeed(),
    onObservation: (item) => { correctionSeen.push(item); },
  });
  // A new PageAgent core restarts its local step counter at zero. The seeded
  // evidence chain must still keep monotonically increasing turn indexes.
  correction.beginTurn(0);
  assert.strictEqual(await correction.getBrowserState(), after);
  assert.equal(correction.rawCalls, 0);
  assert.equal(correctionSeen.length, 0);
  correction.markActionBoundary();
  correction.beginTurn(1);
  await correction.getBrowserState();
  assert.equal(correction.rawCalls, 1);
  assert.equal(correctionSeen[0].kind, "delta");
  assert.equal(correctionSeen[0].baseObservationId, seen[1].id);
  assert.equal(correctionSeen[0].turnIndex, seen[1].turnIndex + 1);
  await correction.drainObservations();
  delete globalThis.__PAGE_AGENT_TEST_STATE__;
});

test("observation sink failures surface at the evidence drain boundary", async () => {
  const controllerModule = await bundledModule("../client/user-agent-page-controller.ts");
  const controller = new controllerModule.SiteAgentPageController({
    context: { siteAgentId: "site", runId: "run", episodeId: "episode", browserSessionId: "browser", documentId: "document", pageEpoch: 1 },
    onObservation: async () => { throw new Error("sink_failed"); },
  });
  controller.beginTurn(0);
  await controller.getBrowserState();
  await assert.rejects(controller.drainObservations(), /sink_failed/);
});

test("observation projection stays within 96 KiB without dropping any model-operable target", async () => {
  const controller = await bundledModule("../client/user-agent-page-controller.ts");
  const targets = Array.from({ length: 32 }, (_, offset) => ({
    observationId: "observation-1",
    index: offset + 1,
    semanticId: `target-${offset + 1}`,
    role: "button",
    accessibleName: `Business action ${offset + 1} ${"label".repeat(80)}`,
    nearbyText: "nearby".repeat(200),
  }));
  const large = observation({
    state: {
      url: "https://shop.test/catalog?q=cushion",
      title: "Cushion catalog",
      header: "header".repeat(2_000),
      content: `${"business context cushion\n".repeat(12_000)}\n${targets.map((target) => `[${target.index}]<button>${target.accessibleName}`).join("\n")}\n[999]<button>Controller-only target`,
      footer: "footer".repeat(2_000),
    },
    targets,
  });
  const bounded = controller.boundPageAgentObservation(large);
  assert.ok(controller.pageAgentObservationBytes(bounded) <= controller.PAGE_AGENT_OBSERVATION_MAX_BYTES);
  assert.deepEqual(bounded.targets.map((target) => target.index), targets.map((target) => target.index));
  for (const target of targets) assert.match(bounded.state.content, new RegExp(`\\[${target.index}\\]`));
  assert.match(bounded.state.content, /\[999\]/);
});

test("Runtime V2 exposes only the exact semantic tools and read-only narrows to focus and scroll", async () => {
  const adaptive = await bundledModule("../client/user-agent-adaptive.ts");
  assert.deepEqual(adaptive.PAGE_AGENT_RUNTIME_V2_TOOL_NAMES, [
    "set_text_by_index", "insert_text_by_index", "submit_form_by_index", "move_focus", "press_key_by_index",
  ]);
  assert.equal(adaptive.runtimeV2ToolAvailability(false).includes("input_text"), false);
  assert.deepEqual(adaptive.runtimeV2ToolAvailability(true), ["move_focus", "scroll", "scroll_horizontally"]);
});

test("literal text preserves whitespace and never aliases Enter, Tab, or Space to keys", async () => {
  const adaptive = await bundledModule("../client/user-agent-adaptive.ts");
  for (const literal of ["", " ", "\n", "\t", "Enter", "Tab", "Space", " \n\t "]) {
    assert.equal(adaptive.literalTextReplacement("old", literal), literal);
    assert.equal(adaptive.literalTextInsertion("ab", 1, 1, literal), `a${literal}b`);
  }
});

test("key protocol is an exact nine-key allowlist with no modifiers and maps model Space to DOM space", async () => {
  const adaptive = await bundledModule("../client/user-agent-adaptive.ts");
  const allowed = ["Enter", "Escape", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"];
  for (const key of allowed) assert.equal(adaptive.isAllowedPageAgentKey(key), true, key);
  for (const key of [" ", "Tab", "Backspace", "Delete", "Insert", "PageUp", "PageDown", "F1", "a", "Control+Enter"]) {
    assert.equal(adaptive.isAllowedPageAgentKey(key), false, key);
  }
  assert.deepEqual({ ...adaptive.pageAgentKeyboardEventOptions("Space") }, { key: " ", code: "Space", bubbles: true, cancelable: true, composed: true, repeat: false });
  assert.equal("modifiers" in adaptive.pageAgentKeyboardEventOptions("Enter"), false);
});

test("a receipt closes on the next observation and duplicate unchanged actions are pre-refused", async () => {
  const adaptive = await bundledModule("../client/user-agent-adaptive.ts");
  const before = observation();
  const after = observation({ id: "observation-2", turnIndex: 1, kind: "delta", baseObservationId: before.id, targets: before.targets.map((target) => ({ ...target, observationId: "observation-2" })) });
  const receipt = {
    id: "receipt", turnIndex: 0, action: "click", target: before.targets[0], input: { index: 1 },
    beforeObservationId: before.id, dispatched: true, effect: "unknown", effectSignals: {},
    startedAt: before.capturedAt, endedAt: before.capturedAt,
  };
  assert.equal(adaptive.closeActionReceiptWithObservation(receipt, before, after), true);
  assert.equal(receipt.afterObservationId, after.id);
  assert.equal(receipt.effect, "unchanged");
  assert.equal(adaptive.isDuplicateUnchangedAction([receipt], "click", before.targets[0], { index: 1 }), true);
  assert.equal(adaptive.isDuplicateUnchangedAction([receipt], "click", before.targets[0], { index: 2 }), false);

  const press = {
    ...receipt,
    id: "press-receipt",
    action: "press",
    input: { index: 1, key: "Enter" },
    afterObservationId: undefined,
    effect: "unknown",
    effectSignals: { synthetic: true, isTrusted: false, handling: "unknown" },
  };
  const changed = observation({ id: "observation-3", turnIndex: 2, kind: "delta", baseObservationId: before.id, state: { ...before.state, content: "changed" } });
  assert.equal(adaptive.closeActionReceiptWithObservation(press, before, changed), true);
  assert.equal(press.effect, "unknown");
  assert.equal(press.effectSignals.observedStateChanged, true);
  assert.equal("contentChanged" in press.effectSignals, false);
});

test("three unchanged receipts exhaust no-progress and active clock pauses for nested human/visibility waits", async () => {
  const adaptive = await bundledModule("../client/user-agent-adaptive.ts");
  const budget = { activeLimitMs: 180_000, modelRequestLimit: 100, activeElapsedMs: 0, modelRequests: 0, noProgressCount: 0 };
  assert.equal(adaptive.recordNoProgressEffect(budget, "unchanged"), undefined);
  assert.equal(adaptive.recordNoProgressEffect(budget, "unchanged"), undefined);
  assert.equal(adaptive.recordNoProgressEffect(budget, "unchanged"), "no-progress");

  const runtime = { budget: { ...budget, noProgressCount: 0, exhaustedReason: undefined }, startedAt: 1_000, pauseDepth: 0, actionReceipts: [], observationRefs: [], runtimeMetrics: [] };
  adaptive.pauseBudget(runtime, 2_000);
  adaptive.pauseBudget(runtime, 3_000);
  adaptive.resumeBudget(runtime, 8_000);
  assert.equal(adaptive.elapsedBudget(runtime, 9_000).activeElapsedMs, 1_000);
  adaptive.resumeBudget(runtime, 10_000);
  assert.equal(adaptive.elapsedBudget(runtime, 12_000).activeElapsedMs, 3_000);

  const requestRuntime = {
    budget: { activeLimitMs: 180_000, modelRequestLimit: 100, activeElapsedMs: 0, modelRequests: 0, noProgressCount: 0 },
    startedAt: Date.now(), pauseDepth: 0, actionReceipts: [], observationRefs: [], runtimeMetrics: [],
  };
  for (let count = 1; count <= 100; count += 1) assert.equal(adaptive.consumePageAgentModelRequest(requestRuntime), count);
  // The response returned by request 100 still owns one executable action.
  assert.equal(adaptive.elapsedBudget(requestRuntime).exhaustedReason, undefined);
  assert.throws(() => adaptive.consumePageAgentModelRequest(requestRuntime), /page_agent_budget_exhausted:model-requests/);
  assert.equal(requestRuntime.budget.modelRequests, 100);
  assert.equal(requestRuntime.budget.exhaustedReason, "model-requests");
  assert.equal(adaptive.MAX_EVIDENCE_CORRECTIONS, 1);
});

test("effectful execution keeps the complete user goal instead of a narrowed model objective", async () => {
  const adaptive = await bundledModule("../client/user-agent-adaptive.ts");
  const fullGoal = "帮我搜索一个notebook并加入购物车";
  const brief = {
    objective: "在页面顶部的搜索框中输入 notebook 并执行搜索",
    normalizedGoal: fullGoal,
    entities: { goalTarget: { anyOf: ["notebook", "笔记本"] } },
    effect: "reversible-write",
    completionCriteria: ["搜索结果已加载", "商品已加入购物车"],
    relevantSceneIds: [],
    relevantCapabilityIds: [],
    rejectedCapabilityReasons: [],
    knowledgeReceiptRefs: [],
  };
  assert.equal(adaptive.pageExecutionTask(brief, fullGoal), fullGoal);
  assert.match(adaptive.pageExecutionBriefInstructions(brief), /每个动作都必须完成/);
  assert.match(adaptive.pageExecutionBriefInstructions(brief), /最终副作用动作/);
  assert.equal(adaptive.pageExecutionTask({ ...brief, effect: "read" }, fullGoal), fullGoal);
});

test("human confirmation keeps success as a bounded hand-off and rejects failed or unknown choices", async () => {
  const adaptive = await bundledModule("../client/user-agent-adaptive.ts");
  assert.equal(adaptive.parseHumanConfirmationAnswer("成功了"), "success");
  assert.equal(adaptive.parseHumanConfirmationAnswer("没有成功"), "failed");
  assert.equal(adaptive.parseHumanConfirmationAnswer("我不确定"), "unknown");
  assert.equal(adaptive.aiHasTerminalDecision({ reportedSuccess: true, outcome: "success" }), true);
  assert.equal(adaptive.aiHasTerminalDecision({ reportedSuccess: false, outcome: undefined }), false);
  assert.equal(adaptive.aiHasTerminalDecision({ reportedSuccess: false, outcome: "incomplete" }), false);
  assert.equal(adaptive.aiHasTerminalDecision({ reportedSuccess: false, outcome: "business-rejection" }), true);
  assert.equal(adaptive.aiHasTerminalDecision({ reportedSuccess: true, outcome: "success", technicalError: "model_timeout" }), false);
  assert.equal(adaptive.aiReportedSuccess({ reportedSuccess: true, outcome: "success" }), true);
  assert.equal(adaptive.aiReportedSuccess({ reportedSuccess: true, outcome: "incomplete" }), false);
  assert.equal(adaptive.shouldRecordAdaptiveExperience("success", true), true, "AI success records raw browser experience without requiring human confirmation");
  assert.equal(adaptive.shouldRecordAdaptiveExperience("no-result", true), true);
  assert.equal(adaptive.shouldRecordAdaptiveExperience("success", false), false);
  assert.equal(adaptive.shouldRecordAdaptiveExperience("unknown", true), false);
  assert.equal(adaptive.shouldRecordAdaptiveExperience("success", true, "success"), true);
  assert.equal(adaptive.shouldRecordAdaptiveExperience("success", true, "failed"), false);
  assert.equal(adaptive.shouldRecordAdaptiveExperience("success", true, "unknown"), false);
});

test("hidden-page gate pauses active time and releases work only after foreground", async () => {
  const adaptive = await bundledModule("../client/user-agent-adaptive.ts");
  class VisibilitySource extends EventTarget {
    visibilityState = "hidden";
    show() {
      this.visibilityState = "visible";
      this.dispatchEvent(new Event("visibilitychange"));
    }
  }
  const source = new VisibilitySource();
  const runtime = {
    budget: { activeLimitMs: 180_000, modelRequestLimit: 10, activeElapsedMs: 0, modelRequests: 0, noProgressCount: 0 },
    startedAt: 1_000, pauseDepth: 0, actionReceipts: [], observationRefs: [], observations: [], runtimeMetrics: [],
  };
  const abort = new AbortController();
  let clock = 2_000;
  let workStarted = false;
  const gated = adaptive.waitForPageAgentForeground(runtime, source, abort.signal, () => clock)
    .then((result) => { workStarted = true; return result; });
  await Promise.resolve();
  assert.equal(workStarted, false);
  assert.equal(runtime.pauseDepth, 1);
  clock = 12_000;
  source.show();
  assert.deepEqual(await gated, { waitedMs: 10_000, startedAt: 2_000 });
  assert.equal(workStarted, true);
  assert.equal(runtime.pauseDepth, 0);
  assert.equal(adaptive.elapsedBudget(runtime, 13_000).activeElapsedMs, 2_000);
});

test("forced stop settles before budget terminal wins, drain aborts on deadline, and cleanup always runs", async () => {
  const adaptive = await bundledModule("../client/user-agent-adaptive.ts");
  let resolveExecution;
  let resolveStop;
  const execution = new Promise((resolve) => { resolveExecution = resolve; });
  const stop = new Promise((resolve) => { resolveStop = resolve; });
  const timeout = new Promise(() => {});
  const terminal = new Error("page_agent_budget_exhausted:active-time");
  let forced;
  let settled = false;
  const result = adaptive.resolvePageAgentExecution(execution, timeout, () => forced, () => stop)
    .finally(() => { settled = true; });
  forced = terminal;
  resolveExecution({ success: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "execute resolving from stop must not outrun awaited stop");
  resolveStop();
  await assert.rejects(result, /page_agent_budget_exhausted:active-time/);

  const deadlineRuntime = {
    budget: { activeLimitMs: 1_000, modelRequestLimit: 10, activeElapsedMs: 0, modelRequests: 0, noProgressCount: 0 },
    startedAt: Date.now(), pauseDepth: 0, actionReceipts: [], observationRefs: [], observations: [], runtimeMetrics: [],
  };
  let operationAborted = false;
  await assert.rejects(adaptive.withPageAgentRuntimeDeadline(deadlineRuntime, (signal) => new Promise((resolve) => {
    signal.addEventListener("abort", () => { operationAborted = true; resolve(); }, { once: true });
  }), 10), /page_agent_evidence_drain_timeout/);
  assert.equal(operationAborted, true);

  let cleaned = false;
  await assert.rejects(adaptive.finalizePageAgentRuntime(
    async () => { throw new Error("drain_failed"); },
    async () => { cleaned = true; },
  ), /drain_failed/);
  assert.equal(cleaned, true);
});

test("long-task telemetry is attributed to the active PageAgent turn", async () => {
  const adaptive = await bundledModule("../client/user-agent-adaptive.ts");
  const item = adaptive.pageAgentLongTaskMetric(4, {
    name: "self",
    entryType: "longtask",
    startTime: 25,
    duration: 73,
  }, 1_000);
  assert.equal(item.turnIndex, 4);
  assert.equal(item.stage, "turn_before_hook");
  assert.equal(item.startedAt, new Date(1_025).toISOString());
  assert.equal(item.durationMs, 73);
  assert.deepEqual(item.detail, { telemetry: "long-task", name: "self", entryType: "longtask" });
});

test("legacy input_text envelopes normalize to the V2 literal set-text tool", async () => {
  const protocol = await bundledModule("../lib/site-knowledge/model-protocol.ts");
  const request = {
    tools: [{ function: { name: "AgentOutput", parameters: { properties: { action: { anyOf: [
      { properties: { set_text_by_index: { required: ["index", "text"] } } },
      { properties: { click_element_by_index: { required: ["index"] } } },
    ] } } } } }],
  };
  const response = {
    choices: [{ message: { tool_calls: [{ function: { name: "AgentOutput", arguments: JSON.stringify({ action: { input_text: { index: 7, text: " \n\t " } } }) } }] } }],
  };
  const normalized = protocol.normalizeAgentToolEnvelope(request, response);
  const args = JSON.parse(normalized.choices[0].message.tool_calls[0].function.arguments);
  assert.deepEqual(args.action, { set_text_by_index: { index: 7, text: " \n\t " } });
});

test("strict authority accepts a full/delta chain with exactly one more observation than dispatched receipts", async () => {
  const authority = await bundledModule("../lib/capability-center-v2/experience-authority.ts");
  const before = observation({ state: { url: "https://shop.test/search", title: "Search", header: "", content: "Search form", footer: "" } });
  const after = observation({
    id: "observation-2", turnIndex: 1, kind: "delta", baseObservationId: before.id,
    state: { url: "https://shop.test/search", title: "Search", header: "", content: "Search results: 1 result for cushion", footer: "" },
    targets: [{ observationId: "observation-2", index: 2, semanticId: "product-cushion", role: "link", accessibleName: "Cushion product" }],
  });
  const refs = [before, after].map((item) => ({ id: item.id, pageEpoch: item.pageEpoch, documentId: item.documentId, turnIndex: item.turnIndex, kind: item.kind, sha256: item.sha256 }));
  const receipt = { id: "receipt", turnIndex: 0, action: "click", target: before.targets[0], input: { index: 1, query: "cushion" }, beforeObservationId: before.id, afterObservationId: after.id, dispatched: true, effect: "changed", effectSignals: { contentChanged: true }, startedAt: before.capturedAt, endedAt: before.capturedAt };
  const snapshot = { url: before.state.url, title: before.state.title, documentId: before.documentId };
  const episode = {
    id: "episode", siteAgentId: "site", taskSessionId: "run", browserSessionId: "browser", documentId: "document",
    mode: "adaptive", goal: "search for cushion", input: { query: "cushion" }, startSnapshot: snapshot, endSnapshot: snapshot,
    pageExecutionBrief: {
      objective: "search for cushion",
      normalizedGoal: "search for cushion",
      entities: { query: "cushion" },
      effect: "read",
      completionCriteria: [
        "Complete the user's original objective: search for cushion",
        "Observe the page state after the requested page action.",
      ],
    },
    outcome: { status: "success" },
    experience: {
      observationRefs: refs,
      actionReceiptsV2: [receipt],
      budgetEvidence: { activeLimitMs: 180_000, modelRequestLimit: 10, activeElapsedMs: 1_000, modelRequests: 1, noProgressCount: 0 },
    },
  };
  const run = {
    id: "run", goal: "search for cushion", input: { query: "cushion" }, controller: "page-agent", pageEpoch: 1,
    agentState: { runtimeModelBudget: { requestCount: 1, stageCounts: { "runtime-page-agent": 1, "runtime-boundary": 0 } } },
    scope: { kind: "site", siteAgentId: "site" },
    activePort: { browserSessionId: "browser", documentId: "document" },
  };
  assert.equal(authority.capabilityExperienceAuthority(run, episode, [before, after])?.kind, "create");
  assert.equal(refs.length, [receipt].filter((item) => item.dispatched).length + 1);
});
