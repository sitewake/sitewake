import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

async function load(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    external: ["playwright"],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const control = await load("../lib/capability-center-v2/control-flow.ts");
const runtime = await load("../lib/capability-center-v2/javascript-runtime.ts");
const stageRunner = await load("../runner/capability-v2/javascript-stage-runner.ts");

const emptyIO = () => ({ reads: { input: [], state: [] }, writes: { state: [], output: [] } });
const baseProgram = (overrides = {}) => {
  const program = {
    schemaVersion: "2.0",
    runtime: "BrowserJavaScriptStage",
    module: { contentHash: "a".repeat(64), moduleUrl: "/api/module.js", exportName: "capability" },
    entry: { mode: "CurrentPage" },
    stages: [
      { id: "first", title: "First", purpose: "First", effect: "read", resumePolicy: "skip-completed" },
      { id: "last", title: "Last", purpose: "Last", effect: "read", resumePolicy: "skip-completed" },
    ],
    parameterRoles: [],
    targetBindings: [],
    promptProvenance: [],
    ...overrides,
  };
  program.stages = program.stages.map((stage) => ({ ...stage, io: stage.io || emptyIO(), navigation: stage.navigation || "none" }));
  return program;
};

test("control flow keeps linear programs compatible", () => {
  const program = baseProgram();
  let cursor = control.createCapabilityExecutionCursor(program, undefined, undefined, 100);
  cursor = control.beginCapabilityStage(program, cursor, "first", { value: 1 }, 100);
  cursor = control.resolveCapabilityStageTransition(program, cursor, "first", undefined, { value: 1 }, 101);
  assert.equal(cursor.currentStageId, "last");
  cursor = control.beginCapabilityStage(program, cursor, "last", { value: 1 }, 102);
  assert.equal(control.capabilityStageIteration(program, cursor, "last"), 2);
});

function loopProgram(loopOverrides = {}) {
  return baseProgram({
    stages: [
      {
        id: "poll",
        title: "Poll",
        purpose: "Poll until ready",
        effect: "read",
        resumePolicy: "reconcile-before-retry",
        io: { reads: { input: [], state: ["count"] }, writes: { state: ["count"], output: [] } },
        navigation: "none",
        transitions: { again: "poll", done: "last" },
      },
      { id: "last", title: "Last", purpose: "Last", effect: "read", resumePolicy: "skip-completed", io: { reads: { input: [], state: ["count"] }, writes: { state: [], output: ["count"] } }, navigation: "none" },
    ],
    controlFlow: {
      loops: [{ id: "poll-loop", entry: "poll", stageIds: ["poll"], maxIterations: 3, maxNoProgress: 3, timeoutMs: 10_000, ...loopOverrides }],
    },
  });
}

test("bounded stage branch loops reach the selected branch and record iteration counts", () => {
  const program = loopProgram();
  let cursor = control.createCapabilityExecutionCursor(program, undefined, undefined, 100);
  for (const count of [1, 2, 3]) {
    cursor = control.beginCapabilityStage(program, cursor, "poll", { count }, 100 + count);
    const signal = count < 3 ? "again" : "done";
    cursor = control.resolveCapabilityStageTransition(program, cursor, "poll", signal, { count }, 100 + count);
  }
  assert.equal(cursor.currentStageId, "last");
  assert.equal(cursor.loopIterations["poll-loop"], 3);
  assert.equal(cursor.loopNoProgress["poll-loop"], 0);
});

test("a loop fails closed when it exceeds maxIterations or stops making progress", () => {
  const limited = loopProgram({ maxIterations: 2 });
  let cursor = control.createCapabilityExecutionCursor(limited, undefined, undefined, 100);
  cursor = control.beginCapabilityStage(limited, cursor, "poll", { count: 1 }, 101);
  cursor = control.resolveCapabilityStageTransition(limited, cursor, "poll", "again", { count: 1 }, 102);
  cursor = control.beginCapabilityStage(limited, cursor, "poll", { count: 2 }, 103);
  assert.throws(
    () => control.resolveCapabilityStageTransition(limited, cursor, "poll", "again", { count: 2 }, 104),
    (error) => error.code === "capability_control_flow_loop_limit_exceeded",
  );

  const stagnant = loopProgram({ maxNoProgress: 2 });
  let stagnantCursor = control.createCapabilityExecutionCursor(stagnant, undefined, undefined, 100);
  stagnantCursor = control.beginCapabilityStage(stagnant, stagnantCursor, "poll", { count: 1 }, 101);
  stagnantCursor = control.resolveCapabilityStageTransition(stagnant, stagnantCursor, "poll", "again", { count: 1 }, 102);
  stagnantCursor = control.beginCapabilityStage(stagnant, stagnantCursor, "poll", { count: 1 }, 103);
  assert.throws(
    () => control.resolveCapabilityStageTransition(stagnant, stagnantCursor, "poll", "again", { count: 1 }, 104),
    (error) => error.code === "capability_control_flow_no_progress",
  );
});

test("program inspection rejects unknown branch targets and unbounded back edges", () => {
  const missingTarget = baseProgram({
    stages: [{ id: "first", title: "First", purpose: "First", effect: "read", resumePolicy: "skip-completed", transitions: { retry: "missing" } }, baseProgram().stages[1]],
    controlFlow: { loops: [] },
  });
  const missingIssues = runtime.inspectCapabilityJavaScriptProgram(missingTarget).issues;
  assert.ok(missingIssues.includes("control_flow_transition_target_missing:first:retry"));

  const unboundedBackEdge = baseProgram({
    stages: [{ id: "first", title: "First", purpose: "First", effect: "read", resumePolicy: "skip-completed", transitions: { retry: "first" } }, baseProgram().stages[1]],
    controlFlow: { loops: [] },
  });
  assert.ok(runtime.inspectCapabilityJavaScriptProgram(unboundedBackEdge).issues.includes("control_flow_back_edge_unbounded:first:retry"));

  assert.equal(runtime.inspectCapabilityJavaScriptProgram(loopProgram()).valid, true);
  const normalized = runtime.normalizeCapabilityJavaScriptProgram(loopProgram());
  assert.deepEqual(normalized.controlFlow, loopProgram().controlFlow);
  assert.deepEqual(normalized.stages[0].transitions, { again: "poll", done: "last" });
  assert.equal(
    runtime.validateCapabilityJavaScriptSource("export const capability={version:2,stages:[{id:'x',run(){while(true){return {outcome:'Continue'}}}}]}").code,
    "capability_module_unbounded_loop_forbidden",
  );
});

test("maxTransitions counts graph edges and normalization preserves invalid declarations", () => {
  const program = baseProgram({
    stages: [
      { id: "first", title: "First", purpose: "First", effect: "read", resumePolicy: "skip-completed", transitions: { next: "middle" } },
      { id: "middle", title: "Middle", purpose: "Middle", effect: "read", resumePolicy: "skip-completed", transitions: { next: "last" } },
      { id: "last", title: "Last", purpose: "Last", effect: "read", resumePolicy: "skip-completed" },
    ],
    controlFlow: { loops: [], maxTransitions: 1 },
  });
  let cursor = control.createCapabilityExecutionCursor(program, undefined, undefined, 100);
  cursor = control.beginCapabilityStage(program, cursor, "first", {}, 101);
  cursor = control.resolveCapabilityStageTransition(program, cursor, "first", "next", {}, 102);
  assert.equal(cursor.currentStageId, "middle");
  assert.equal(cursor.transitionCount, 1);
  cursor = control.beginCapabilityStage(program, cursor, "middle", {}, 103);
  assert.throws(
    () => control.resolveCapabilityStageTransition(program, cursor, "middle", "next", {}, 104),
    (error) => error.code === "capability_control_flow_transition_limit_exceeded",
  );

  const unbounded = baseProgram({
    stages: [{ ...baseProgram().stages[0], transitions: { retry: "first" } }, baseProgram().stages[1]],
    controlFlow: { loops: [] },
  });
  const normalizedUnbounded = runtime.normalizeCapabilityJavaScriptProgram(unbounded);
  assert.deepEqual(normalizedUnbounded.controlFlow, { loops: [] });
  assert.ok(runtime.inspectCapabilityJavaScriptProgram(normalizedUnbounded).issues.includes("control_flow_back_edge_unbounded:first:retry"));

  const malformed = runtime.normalizeCapabilityJavaScriptProgram(baseProgram({ controlFlow: { loops: [{ id: "incomplete" }] } }));
  assert.equal(runtime.inspectCapabilityJavaScriptProgram(malformed).valid, false);
  assert.ok(runtime.inspectCapabilityJavaScriptProgram(malformed).issues.some((issue) => issue.startsWith("control_flow_loop_max_iterations_invalid:")));
});

function launchTestBrowser() {
  const channel = process.env.SITEWAKE_BROWSER_CHANNEL?.trim() || (process.platform === "win32" ? "chrome" : undefined);
  return chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
}

test("C3 executes a bounded conditional loop without rerunning an upstream module", async () => {
  const browser = await launchTestBrowser();
  const context = await browser.newContext();
  const moduleControlFlow = { loops: [{ id: "poll-loop", entry: "poll", stageIds: ["poll"], maxIterations: 3, maxNoProgress: 3, timeoutMs: 5_000 }] };
  const program = loopProgram();
  program.controlFlow = moduleControlFlow;
  const moduleSource = `export const capability={version:2,controlFlow:${JSON.stringify(moduleControlFlow)},stages:[{id:"poll",io:{reads:{input:[],state:["count"]},writes:{state:["count"],output:[]}},navigation:"none",transitions:{again:"poll",done:"last"},run({state}){const count=Number(state.count||0)+1;return {outcome:"Continue",signal:count<3?"again":"done",state:{count},evidence:[]}}},{id:"last",io:{reads:{input:[],state:["count"]},writes:{state:[],output:["count"]}},navigation:"none",run({state}){return {outcome:"Success",output:{count:state.count},evidence:[]}}}]}`;
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === "https://target.test/start") return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><h1>Target</h1>" });
    if (url === "https://public.test/module.js") return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", headers: { "access-control-allow-origin": "*" }, body: moduleSource });
    return route.abort("failed");
  });
  const page = await context.newPage();
  await page.goto("https://target.test/start");
  try {
    const result = await stageRunner.runCapabilityJavaScriptStages({ page, moduleUrl: "https://public.test/module.js", program, input: {} });
    assert.equal(result.outcome, "Success");
    assert.deepEqual(result.output, { count: 3 });
    assert.deepEqual(result.stageTransitions?.[0], { again: "poll", done: "last" });
    assert.deepEqual(result.receipts.filter((receipt) => receipt.status === "Completed" && receipt.stageId === "poll").map((receipt) => receipt.iteration), [1, 2, 3]);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("C3 commits state and a non-next signal before applying deferred navigation", async () => {
  const browser = await launchTestBrowser();
  const context = await browser.newContext();
  const controlFlow = { loops: [], totalTimeoutMs: 5_000 };
  const program = baseProgram({
    stages: [
      { id: "navigate", title: "Navigate", purpose: "Navigate", effect: "write", resumePolicy: "reconcile-before-retry", io: { reads: { input: [], state: [] }, writes: { state: ["selected"], output: [] } }, navigation: "optional", transitions: { next: "fallback", special: "special" } },
      { id: "fallback", title: "Fallback", purpose: "Fallback", effect: "read", resumePolicy: "skip-completed", io: { reads: { input: [], state: [] }, writes: { state: [], output: ["branch"] } }, navigation: "none" },
      { id: "special", title: "Special", purpose: "Special", effect: "read", resumePolicy: "skip-completed", io: { reads: { input: [], state: ["selected"] }, writes: { state: [], output: ["branch", "selected", "pathname"] } }, navigation: "none" },
    ],
    controlFlow,
  });
  const moduleSource = `export const capability={version:2,controlFlow:${JSON.stringify(controlFlow)},stages:[{id:"navigate",io:{reads:{input:[],state:[]},writes:{state:["selected"],output:[]}},navigation:"optional",transitions:{next:"fallback",special:"special"},run(){return {outcome:"Continue",signal:"special",state:{selected:"yes"},navigation:{url:"https://target.test/destination",target:"_self"}}}},{id:"fallback",io:{reads:{input:[],state:[]},writes:{state:[],output:["branch"]}},navigation:"none",run(){return {outcome:"Success",output:{branch:"fallback"}}}},{id:"special",io:{reads:{input:[],state:["selected"]},writes:{state:[],output:["branch","selected","pathname"]}},navigation:"none",run({state}){return {outcome:"Success",output:{branch:"special",selected:state.selected,pathname:location.pathname}}}}]}`;
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === "https://target.test/start" || url === "https://target.test/destination") return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><h1>Destination</h1>" });
    if (url.startsWith("https://public.test/module.js")) return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", headers: { "access-control-allow-origin": "*" }, body: moduleSource });
    return route.abort("failed");
  });
  const page = await context.newPage();
  await page.goto("https://target.test/start");
  try {
    const result = await stageRunner.runCapabilityJavaScriptStages({ page, moduleUrl: "https://public.test/module.js", program, input: {} });
    assert.deepEqual(result.output, { branch: "special", selected: "yes", pathname: "/destination" });
    assert.equal(result.receipts.find((receipt) => receipt.stageId === "navigate" && receipt.status === "Completed")?.signal, "special");
  } finally {
    await context.close();
    await browser.close();
  }
});

test("C3 fails closed when a terminal Stage also requests navigation", async () => {
  const browser = await launchTestBrowser();
  const context = await browser.newContext();
  const controlFlow = { loops: [], totalTimeoutMs: 5_000 };
  const program = baseProgram({
    stages: [{ id: "first", title: "First", purpose: "First", effect: "write", resumePolicy: "reconcile-before-retry", io: { reads: { input: [], state: [] }, writes: { state: [], output: ["ok"] } }, navigation: "optional" }, { ...baseProgram().stages[1], io: { reads: { input: [], state: [] }, writes: { state: [], output: ["ok"] } } }],
    controlFlow,
  });
  const moduleSource = `export const capability={version:2,controlFlow:${JSON.stringify(controlFlow)},stages:[{id:"first",io:{reads:{input:[],state:[]},writes:{state:[],output:["ok"]}},navigation:"optional",run(){return {outcome:"Success",output:{ok:true},navigation:{url:"https://target.test/destination",target:"_self"}}}},{id:"last",io:{reads:{input:[],state:[]},writes:{state:[],output:["ok"]}},navigation:"none",run(){return {outcome:"Success",output:{ok:true}}}}]}`;
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === "https://target.test/start" || url === "https://target.test/destination") return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><h1>Destination</h1>" });
    if (url.startsWith("https://public.test/module.js")) return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", headers: { "access-control-allow-origin": "*" }, body: moduleSource });
    return route.abort("failed");
  });
  const page = await context.newPage();
  await page.goto("https://target.test/start");
  try {
    await assert.rejects(
      () => stageRunner.runCapabilityJavaScriptStages({ page, moduleUrl: "https://public.test/module.js", program, input: {} }),
      (error) => error.message === "capability_navigation_terminal_outcome:first",
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("C3 rejects module control flow that is not frozen into the Program", async () => {
  const browser = await launchTestBrowser();
  const context = await browser.newContext();
  const moduleControlFlow = { loops: [{ id: "poll-loop", entry: "poll", stageIds: ["poll"], maxIterations: 2, maxNoProgress: 2, timeoutMs: 5_000 }] };
  const program = loopProgram();
  const moduleSource = `export const capability={version:2,controlFlow:${JSON.stringify(moduleControlFlow)},stages:[{id:"poll",transitions:{again:"poll",done:"last"},run(){return {outcome:"Continue",signal:"done"}}},{id:"last",run(){return {outcome:"Success",output:{ok:true}}}}]}`;
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === "https://target.test/start") return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><h1>Target</h1>" });
    if (url.startsWith("https://public.test/module.js")) return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", headers: { "access-control-allow-origin": "*" }, body: moduleSource });
    return route.abort("failed");
  });
  const page = await context.newPage();
  await page.goto("https://target.test/start");
  try {
    await assert.rejects(
      () => stageRunner.runCapabilityJavaScriptStages({ page, moduleUrl: "https://public.test/module.js", program, input: {} }),
      (error) => error.message === "capability_stage_transition_manifest_mismatch",
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("C3 aborts a Stage that exceeds the declared control-flow deadline", async () => {
  const browser = await launchTestBrowser();
  const context = await browser.newContext();
  const controlFlow = { loops: [], totalTimeoutMs: 120 };
  const program = baseProgram({
    controlFlow,
    stages: [
      { ...baseProgram().stages[0], io: { reads: { input: [], state: [] }, writes: { state: [], output: ["ok"] } }, navigation: "none" },
      { ...baseProgram().stages[1], io: { reads: { input: [], state: [] }, writes: { state: [], output: ["ok"] } }, navigation: "none" },
    ],
  });
  const moduleSource = `export const capability={version:2,controlFlow:${JSON.stringify(controlFlow)},stages:[{id:"first",io:{reads:{input:[],state:[]},writes:{state:[],output:["ok"]}},navigation:"none",run:async()=>{await new Promise(resolve=>setTimeout(resolve,350));return {outcome:"Success",output:{ok:true}}}},{id:"last",io:{reads:{input:[],state:[]},writes:{state:[],output:["ok"]}},navigation:"none",run(){return {outcome:"Success",output:{ok:true}}}}]}`;
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === "https://target.test/start") return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><h1>Target</h1>" });
    if (url.startsWith("https://public.test/module.js")) return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", headers: { "access-control-allow-origin": "*" }, body: moduleSource });
    return route.abort("failed");
  });
  const page = await context.newPage();
  await page.goto("https://target.test/start");
  try {
    await assert.rejects(
      () => stageRunner.runCapabilityJavaScriptStages({ page, moduleUrl: "https://public.test/module.js", program, input: {} }),
      // The message now names the stage (and any pending wait) after the code.
      (error) => /^capability_control_flow_timeout(?::first)?(?::pending=|$)/.test(error.message),
    );
  } finally {
    await context.close();
    await browser.close();
  }
});
