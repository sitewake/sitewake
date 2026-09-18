import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

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

const { terminationFromBudget, technicalFaultSummary } = await adaptiveModule();

const PROTOCOL_STATUSES = ["success", "no-result", "business-rejection", "execution-fault", "unknown"];
const GENERIC_FALLBACK = "页面操作遇到了技术问题，本次任务没有完成。";

test("budget terminations are not reported as technical faults", () => {
  for (const reason of ["background-wait", "wall-clock", "user-unanswered", "active-time", "model-requests", "no-progress"]) {
    const termination = terminationFromBudget(`page_agent_budget_exhausted:${reason}`, undefined);
    assert.ok(termination, `${reason} must map to a termination`);
    assert.notEqual(termination.status, "execution-fault", `${reason} is a normal ending, not a malfunction`);
    assert.ok(PROTOCOL_STATUSES.includes(termination.status), `${reason} produced an out-of-protocol status`);
  }
});

test("the three new termination reasons are distinguishable", () => {
  const reasons = ["background-wait", "wall-clock", "user-unanswered"];
  const codes = reasons.map((reason) => terminationFromBudget(`page_agent_budget_exhausted:${reason}`, undefined).code);
  const summaries = reasons.map((reason) => terminationFromBudget(`page_agent_budget_exhausted:${reason}`, undefined).summary);

  assert.equal(new Set(codes).size, reasons.length, "each reason needs its own stable code");
  assert.equal(new Set(summaries).size, reasons.length, "each reason needs its own user-facing sentence");
  for (const summary of summaries) {
    assert.notEqual(summary, GENERIC_FALLBACK, "a budget ending must never fall back to the generic fault text");
  }
});

test("the background termination tells the user what to do next", () => {
  const { summary } = terminationFromBudget("page_agent_budget_exhausted:background-wait", undefined);

  assert.match(summary, /切走/, "the cause must be stated");
  assert.match(summary, /重新发起/, "an actionable next step must be offered");
});

test("budget state alone is enough to classify the ending", () => {
  // When the loop exits without an error string, the exhausted reason recorded
  // on the budget still has to drive the outcome.
  const termination = terminationFromBudget(undefined, "wall-clock");

  assert.equal(termination.code, "agent_wall_clock_exhausted");
  assert.equal(termination.status, "unknown");
});

test("a genuine technical error is not misread as a budget ending", () => {
  assert.equal(terminationFromBudget("page_agent_evidence_drain_timeout", "wall-clock"), undefined,
    "a real fault must keep its own reporting path even if a budget was also spent");
  assert.equal(terminationFromBudget(undefined, undefined), undefined);
});

test("internal faults report their category instead of the generic fallback", () => {
  const drain = technicalFaultSummary("page_agent_evidence_drain_timeout");

  assert.notEqual(drain, GENERIC_FALLBACK, "this is the exact code that produced an uninformative message in production");
  assert.match(drain, /记录|保存/, "the user should learn which part failed");

  for (const code of [
    "page_agent_observation_missing",
    "page_agent_sensitive_target_blocked",
    "page_agent_duplicate_unchanged_action",
    "page_agent_round_unsettled",
  ]) {
    assert.notEqual(technicalFaultSummary(code), GENERIC_FALLBACK, `${code} must not collapse into the generic text`);
  }
});

test("an unrecognised fault still surfaces its code", () => {
  const summary = technicalFaultSummary("page_agent_something_new:detail");

  assert.match(summary, /page_agent_something_new/, "an unknown category must still be identifiable");
  assert.notEqual(summary, GENERIC_FALLBACK);
});

test("the generic fallback survives only for a truly empty error", () => {
  assert.equal(technicalFaultSummary(undefined), GENERIC_FALLBACK);
});

test("every produced status is a protocol status", async () => {
  const protocol = await readFile(new URL("../lib/site-knowledge/protocol.ts", import.meta.url), "utf8");
  const union = /export type OutcomeStatus =([\s\S]*?);/.exec(protocol)?.[1] || "";
  const declared = [...union.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);

  assert.deepEqual(declared.sort(), [...PROTOCOL_STATUSES].sort(),
    "this suite's expectations must track the protocol union");
});
