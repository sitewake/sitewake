import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// A run handed to a destination document used to park on
// `new Promise<never>(() => {})`, on the reasoning that this document is about
// to be unloaded. When the destination never claimed the run, that park lasted
// forever — and no budget noticed, because wall clock, active time and model
// requests are all evaluated inside the execution loop. Production run
// run_c57e4c43 sat in `running` for over thirteen minutes with a 360s wall
// clock configured and never consulted.
//
// So the property under test is not "the timeout is 30 seconds". It is that no
// park exists which no budget can observe.
globalThis.window = globalThis;
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

const { awaitPageHandoff, PAGE_HANDOFF_LIMIT_MS } = await moduleFrom("../client/user-agent-shared.ts");
const { terminationFromBudget } = await moduleFrom("../client/user-agent-adaptive.ts");

const ADAPTIVE = await readFile(new URL("../client/user-agent-adaptive.ts", import.meta.url), "utf8");
const PORT = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
const SHARED = await readFile(new URL("../client/user-agent-shared.ts", import.meta.url), "utf8");

test("a handover that is never claimed ends on its own", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    awaitPageHandoff(150),
    /page_agent_budget_exhausted:page-handoff/,
    "the park has to end even though this document was never unloaded",
  );
  assert.ok(Date.now() - startedAt >= 100, "it must not resolve before its limit");
});

test("the limit is generous against real handovers but not open-ended", () => {
  // Production handovers complete in 10–15s; the BrowserPort lease expects a
  // claim within 10s.
  assert.ok(PAGE_HANDOFF_LIMIT_MS >= 20_000, "shorter than a real handover would kill working runs");
  assert.ok(PAGE_HANDOFF_LIMIT_MS <= 60_000, "a person will not wait a minute for a page that never arrives");
});

test("no unbounded park is left anywhere in the client", () => {
  // Comments quote the old shape when explaining why it was wrong, so scan the
  // code only.
  const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  for (const [name, source] of [["adaptive", ADAPTIVE], ["port", PORT], ["shared", SHARED]]) {
    const body = code(source);
    assert.equal((body.match(/new Promise<never>\(\(\) =>/g) || []).length, 0,
      `${name} still parks the runtime with no way out; every budget is blind to it`);
    for (const match of body.matchAll(/new Promise<never>\(/g)) {
      assert.match(body.slice(match.index, match.index + 400), /reject/,
        `${name} has a Promise<never> that can never reject`);
    }
  }
});

test("both runtimes hand the document over through the bounded helper", () => {
  // This started as an exact count and went red the moment a fourth legitimate
  // handover site was added \u2014 reporting a safe addition as a safety failure, which
  // is the opposite of what it is for. A count also cannot tell a real site from a
  // decoy, so it was never the thing worth asserting.
  //
  // The dangerous shape is covered above: no park exists that no budget can
  // observe. What is left for this test is the other half \u2014 that the bounded
  // helper is reached from both runtimes and that nobody opts out of its limit by
  // passing their own. A floor, never a ceiling: new handover sites are expected.
  const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  for (const [name, source, least] of [["adaptive", ADAPTIVE, 2], ["port", PORT, 2]]) {
    const body = code(source);
    const calls = body.match(/awaitPageHandoff\(/g) || [];
    assert.ok(calls.length >= least,
      `${name} has ${calls.length} handover sites on the bounded helper, expected at least ${least}`);
    // An argument here would be a per-site limit, which is how a site quietly
    // buys itself an hour. The one limit lives in the helper.
    assert.equal((body.match(/awaitPageHandoff\([^)]+\)/g) || []).length, 0,
      `${name} passes its own handover limit instead of using the shared one`);
  }
});

const { resolveWidgetLocale, widgetCopy } = await import(
  `data:text/javascript;base64,${Buffer.from((await build({
    entryPoints: [fileURLToPath(new URL("../client/user-agent-copy.ts", import.meta.url))],
    bundle: true, platform: "neutral", format: "esm", write: false,
  })).outputFiles[0].text).toString("base64")}`);

test("the timeout reads as an unfinished navigation, not a fault", () => {
  const termination = terminationFromBudget("page_agent_budget_exhausted:page-handoff", undefined);

  assert.equal(termination.status, "unknown", "the page did not arrive; nothing actually broke");
  assert.equal(termination.code, "agent_page_handoff_timeout");
  // The sentence lives in the catalog, so assert against the entry rather than one
  // language's wording, and check both languages say what the reader has to know.
  const said = widgetCopy(resolveWidgetLocale()).page;
  assert.equal(termination.summary, said.pageHandoffTimeout);
  assert.match(widgetCopy("zh").page.pageHandoffTimeout, /页面跳转没有完成/);
  assert.match(widgetCopy("zh").page.pageHandoffTimeout, /重新发起/, "the user needs to know what to do next");
  assert.match(widgetCopy("en").page.pageHandoffTimeout, /never finished loading/i);
  assert.match(widgetCopy("en").page.pageHandoffTimeout, /start again/i, "the user needs to know what to do next");
  assert.notEqual(termination.summary, said.faultGeneric);
});

test("the rejection reaches the terminal path instead of being swallowed", () => {
  // Reusing the budget-exhausted prefix is what makes this terminal: the port
  // rethrows that family rather than turning it into a retryable tool error.
  assert.match(SHARED, /page_agent_budget_exhausted:page-handoff/);
  assert.match(PORT, /message\.startsWith\("page_agent_budget_exhausted:"\)/,
    "the terminal rethrow is what carries this out of the tool layer");
});

test("checkpoint persistence cannot stall the navigation path", () => {
  // This is where production actually stopped: `syncCheckpoint` used a bare
  // fetch, `runSync` chains it, and `requestRunHandoff` awaited that chain with
  // no bound. The run then halts before any handoff is requested — status stays
  // `running`, no navigation, no further model turns, and no budget looks here.
  const sync = /private async syncCheckpoint\(checkpoint: Checkpoint\) \{[\s\S]*?\n  \}\n/.exec(PORT)?.[0] || "";
  assert.ok(sync, "syncCheckpoint has to exist");
  assert.match(PORT, /CHECKPOINT_SYNC_TIMEOUT_MS = 20_000/);
  assert.match(sync, /fetchWithTimeout\(/, "the checkpoint write must be bounded");
  assert.doesNotMatch(sync, /await fetch\(/, "a bare fetch here stalls the whole run");

  assert.doesNotMatch(PORT, /await this\.runSync\.catch\(\(\) => undefined\);/,
    "waiting on the chain must be bounded too; per-write timeouts still add up");
  assert.match(PORT, /private async settleRunSync\(/);
  assert.match(PORT, /Promise\.race\(\[[\s\S]{0,200}setTimeout/,
    "the chain wait needs its own deadline");
});
