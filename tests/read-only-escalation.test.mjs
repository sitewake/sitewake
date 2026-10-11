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

const { runtimeV2ToolAvailability, technicalFaultSummary } = await adaptiveModule();
const SOURCE = await readFile(new URL("../client/user-agent-adaptive.ts", import.meta.url), "utf8");

test("a site-configured read-only policy keeps hiding the write tools", () => {
  // The site owner set this. An end user must not be able to click past it, so
  // the model is not even offered the tools.
  assert.deepEqual(runtimeV2ToolAvailability(true), ["move_focus", "scroll", "scroll_horizontally"]);
  assert.deepEqual(runtimeV2ToolAvailability(true, false), ["move_focus", "scroll", "scroll_horizontally"]);
});

test("a runtime-derived read-only judgement still lists the write tools", () => {
  const derived = runtimeV2ToolAvailability(true, true);

  // This one is a guess from a regular expression over the user's wording and
  // can be wrong. Hiding the tools left the model unable to signal "this needs
  // an action" at all, so a misjudged goal failed with no explanation.
  for (const name of ["click_element_by_index", "set_text_by_index", "select_dropdown_option", "navigate_scene"]) {
    assert.ok(derived.includes(name), `${name} must remain listed so it can be gated at execution time`);
  }
});

test("a runtime-derived read-only judgement keeps the question channel open", () => {
  assert.ok(runtimeV2ToolAvailability(true, true).includes("ask_user"),
    "without this the runtime cannot ask for the authorization it now requires");
});

test("published capabilities stay unavailable in either kind of read-only", () => {
  assert.ok(!runtimeV2ToolAvailability(true, true).includes("call_capability"));
  assert.ok(!runtimeV2ToolAvailability(true, false).includes("call_capability"),
    "a published capability runs a whole compiled program; that is not a single gated write");
});

test("full mode is unchanged", () => {
  const full = runtimeV2ToolAvailability(false);

  assert.ok(full.includes("call_capability"));
  assert.ok(full.includes("click_element_by_index"));
});

test("every page write goes through the authorization gate", () => {
  const gate = /const ensureWriteAuthorized = async \([\s\S]*?\n  \};/.exec(SOURCE)?.[0] || "";

  assert.ok(gate, "the gate has to exist");
  assert.match(gate, /options\.runtimeMode !== "read-only"/, "full mode must not be slowed down by it");
  assert.match(gate, /readOnlySource !== "runtime-derived"/,
    "a site-configured policy must refuse outright; only a runtime guess may be lifted by the user");
  assert.match(gate, /answer === "granted"/, "a granted authorization must not be asked for twice");
  assert.match(gate, /answer === "refused"/, "a refusal must not be re-asked either");
  assert.match(gate, /withUserAnswerBudget/, "the wait must be bounded like every other user question");

  // The site-policy path keeps its original refusal codes, so callers and logs
  // that already recognise them keep working.
  for (const code of ["runtime_read_only_click_forbidden", "runtime_read_only_navigation_forbidden"]) {
    assert.ok(SOURCE.includes(code), `${code} must survive for the site-configured policy path`);
  }
});

test("the authorization is scoped to the run and recorded as user-sourced", () => {
  const state = /readOnlyAuthorization\?: \{[^}]*\}/.exec(SOURCE)?.[0] || "";
  assert.match(state, /granted/);
  assert.match(state, /refused/);

  assert.match(SOURCE, /readOnlyAuthorizationSource: "user-answer"/,
    "downstream abstraction has to be able to tell this came from the person, not the model");
  assert.ok(!/localStorage[^\n]*readOnlyAuthorization|sessionStorage[^\n]*readOnlyAuthorization/.test(SOURCE),
    "the authorization must not outlive the run");
  assert.ok(!/release[^\n]*readOnlyAuthorization/.test(SOURCE),
    "the authorization must never reach the published release");
});

const { resolveWidgetLocale, widgetCopy } = await import(
  `data:text/javascript;base64,${Buffer.from((await build({
    entryPoints: [fileURLToPath(new URL("../client/user-agent-copy.ts", import.meta.url))],
    bundle: true, platform: "neutral", format: "esm", write: false,
  })).outputFiles[0].text).toString("base64")}`);

test("a refusal is reported as a user decision, not a fault", () => {
  const summary = technicalFaultSummary("runtime_read_only_not_authorized");

  // The sentence is in the catalog; both languages must name the missing
  // authorization and say that looking was all that happened.
  assert.equal(summary, widgetCopy(resolveWidgetLocale()).page.faultReadOnlyNotAuthorized);
  assert.match(widgetCopy("zh").page.faultReadOnlyNotAuthorized, /授权/, "the user must learn why nothing happened");
  assert.match(widgetCopy("zh").page.faultReadOnlyNotAuthorized, /查看/, "and what was actually done instead");
  assert.match(widgetCopy("en").page.faultReadOnlyNotAuthorized, /authorize/i, "the user must learn why nothing happened");
  assert.match(widgetCopy("en").page.faultReadOnlyNotAuthorized, /only looked/i, "and what was actually done instead");

  assert.match(SOURCE, /code = "agent_read_only_not_authorized"/);
  const branch = /unauthorizedWrite\) \{[\s\S]*?\n  \} else if/.exec(SOURCE)?.[0] || "";
  assert.match(branch, /status = "unknown"/, "declining to authorize is not an execution fault");
});

test("the read-only prompt tells the model authorization is available", () => {
  assert.match(SOURCE, /运行时会先向用户申请一次授权/,
    "otherwise the model still believes writing is simply forbidden and will not try");
});
