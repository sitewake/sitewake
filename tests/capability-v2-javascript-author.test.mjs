import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../runner/capability-v2/javascript-author.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [{
    name: "javascript-author-test-seams",
    setup(builder) {
      builder.onResolve({ filter: /^esbuild$/ }, () => ({ path: "esbuild", namespace: "author-test" }));
      builder.onLoad({ filter: /.*/, namespace: "author-test" }, () => ({
        contents: "export async function transform(source){return {code:String(source)}}",
        loader: "js",
      }));
      builder.onLoad({ filter: /[\\/]runner[\\/]capability-v2[\\/]javascript-stage-runner\.ts$/ }, () => ({
        contents: `
          export async function runCapabilityJavaScriptStages(options) {
            return globalThis.__CAPABILITY_V2_AUTHOR_STAGE_RUN__(options);
          }
        `,
        loader: "ts",
      }));
    },
  }],
});
const author = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("trace-grounded target parameters create state producers before verification", () => {
  const manifest = author.authoringManifest({
    steps: [{
      id: "click_product",
      action: "click",
      target: { strategies: [{ kind: "role", name: { source: "input", path: "productName" } }] },
    }],
  }, {
    inputSchema: { type: "object", properties: { productName: { type: "string" } }, required: ["productName"] },
    outputSchema: { type: "object", properties: { targetTitle: { type: "string", minLength: 1 } }, required: ["targetTitle"] },
    successConditions: [{ type: "textTemplate", template: "{{productName}} added" }],
  });
  assert.deepEqual(manifest.parameterRoles, [{ inputPath: "productName", role: "target" }]);
  assert.deepEqual(manifest.targetBindings, [{ inputPath: "productName", targetKind: "page-business-object", identityStatePath: "targets.productName", required: true }]);
  assert.ok(manifest.stages.find((stage) => stage.id === "stage_resolve_target")?.io.writes.state.includes("targets.productName"));
  assert.ok(manifest.stages.find((stage) => stage.id === "stage_verify")?.io.reads.state.includes("targets.productName"));
  assert.deepEqual(manifest.stages.find((stage) => stage.id === "stage_verify")?.io.writes.output, ["targetTitle"]);
});

const originalModelEnvironment = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
};
process.env.OPENAI_API_KEY = "author-test-key";
process.env.OPENAI_BASE_URL = "https://model.test/v1";
process.env.OPENAI_MODEL = "gpt-4o-mini";

test.after(() => {
  for (const [key, value] of Object.entries(originalModelEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete globalThis.__CAPABILITY_V2_AUTHOR_STAGE_RUN__;
});

const source = `export const capability={version:2,stages:[{id:"stage_verify",run({input}){const targetResolution=input.query;const selectedTarget=input.query;return {outcome:"Success",output:{ok:true,query:selectedTarget,targetResolution}}}}]};`;

function toolTurn(index, name, args = {}) {
  return {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: `call_${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  };
}

async function runAuthor({ turns, stageRun, maxToolCalls = turns.length, maxDraftRuns }) {
  const requests = [];
  const events = [];
  const persisted = [];
  const originalFetch = globalThis.fetch;
  let stageCalls = 0;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body || "{}")));
    const response = turns.shift();
    if (!response) throw new Error("unexpected_model_retry");
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  };
  globalThis.__CAPABILITY_V2_AUTHOR_STAGE_RUN__ = async (options) => {
    // The seeded first draft leaves stage_verify as a throwing stub; the real
    // kernel would surface exactly this. Seed checks do not count as model drafts.
    if (persisted.at(-1)?.includes("stage_verify_not_authored")) throw new Error("capability_stage_failed:stage_verify:stage_verify_not_authored");
    stageCalls += 1;
    return stageRun(options, stageCalls);
  };
  try {
    const result = await author.authorJavaScriptCapability({
      explorationPage: {},
      startUrl: "https://target.test/start",
      goal: "search for cushion",
      input: { parameters: { query: "cushion" }, context: {} },
      contract: {
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
        successConditions: ["search completed"],
      },
      explorationProgram: {
        schemaVersion: "2.0",
        runtime: "BrowserDSL",
        entry: { mode: "Navigate", url: "https://target.test/start" },
        steps: [],
        promptProvenance: [],
      },
      validationCases: [],
      createDraftContext: async () => ({
        context: { close: async () => undefined },
        page: { goto: async () => undefined, waitForTimeout: async () => undefined },
      }),
      persistModule: async (bundleSource) => {
        persisted.push(bundleSource);
        return {
          contentHash: "a".repeat(64),
          moduleUrl: "/api/capability-v2/modules/test?siteId=author-test",
          exportName: "capability",
        };
      },
      absoluteModuleUrl: (moduleUrl) => new URL(moduleUrl, "https://public.test").href,
      onEvent: async (event) => events.push(event),
      maxToolCalls,
      maxDraftRuns,
    });
    return { result, requests, events, persisted, stageCalls };
  } catch (error) {
    error.authorTestState = { requests, events, persisted, stageCalls };
    throw error;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function successfulDraft() {
  const page = {
    locator: () => ({ innerText: async () => "search completed" }),
    waitForTimeout: async () => undefined,
    evaluate: async () => ({
      url: "https://target.test/results",
      title: "Results",
      heading: "Search results",
      text: "search completed",
      signals: [],
      elements: [],
    }),
  };
  return {
    page,
    outcome: "Success",
    output: { ok: true },
    state: {},
    evidence: [],
    receipts: [],
  };
}

test("module-load failure stops after exactly one DraftReplay and does not ask the model to repair infrastructure", async () => {
  const turns = [
    toolTurn(1, "write_file", { path: "capability.ts", content: source }),
    toolTurn(2, "run_draft"),
  ];
  const moduleFailure = Object.assign(
    new Error("module_load_failed:page.evaluate: TypeError: Failed to fetch dynamically imported module: https://public.test/module.js"),
    { code: "module_load_failed", authorRepairable: false, taskRetryable: true, receipts: [] },
  );
  await assert.rejects(
    () => runAuthor({ turns, stageRun: async () => { throw moduleFailure; } }),
    (error) => {
      assert.equal(error, moduleFailure);
      assert.equal(error.authorTestState.requests.length, 2);
      assert.equal(error.authorTestState.stageCalls, 1);
      assert.equal(error.authorTestState.events.filter((event) => event.phase === "DraftReplay" && event.message === "run_draft failed").length, 1);
      assert.equal(error.authorTestState.events.at(-1).payload.repairable, false);
      return true;
    },
  );
});

test("ordinary code or Contract failure remains model-repairable and a corrected draft can succeed", async () => {
  const turns = [
    toolTurn(1, "write_file", { path: "capability.ts", content: source }),
    toolTurn(2, "run_draft"),
    toolTurn(3, "write_file", { path: "capability.ts", content: `${source}\n// corrected` }),
    toolTurn(4, "run_draft"),
  ];
  const completed = await runAuthor({
    turns,
    stageRun: async (_options, attempt) => {
      if (attempt === 1) throw new Error("capability_stage_result_invalid:stage_verify");
      return successfulDraft();
    },
  });
  assert.equal(completed.result.draft.outcome, "Success");
  assert.equal(completed.requests.length, 4);
  assert.equal(completed.stageCalls, 2);
  const repairFeedback = completed.requests[2].messages.findLast((message) => message.role === "tool");
  assert.deepEqual(JSON.parse(repairFeedback.content), {
    ok: false,
    code: "capability_stage_result_invalid",
    error: "capability_stage_result_invalid:stage_verify",
    repairable: true,
    case: { caseId: "demonstration", input: { query: "cushion" }, moduleHash: "a".repeat(64) },
    observation: {unavailable:true},
    budget: { toolCalls: 2, draftRuns: 5 },
  });
});

test("repair budget exhaustion retains the last root cause", async () => {
  const turns = [
    toolTurn(1, "write_file", { path: "capability.ts", content: source }),
    toolTurn(2, "run_draft"),
    toolTurn(3, "write_file", { path: "capability.ts", content: `${source}\n// second attempt` }),
    toolTurn(4, "run_draft"),
  ];
  await assert.rejects(
    () => runAuthor({ turns, stageRun: async () => { throw new Error("capability_stage_result_invalid:stage_verify"); } }),
    (error) => {
      assert.equal(error.code, "javascript_author_tool_budget_exhausted");
      assert.match(error.message, /capability_stage_result_invalid:stage_verify/);
      assert.equal(error.cause?.message, "capability_stage_result_invalid:stage_verify");
      assert.equal(error.authorTestState.stageCalls, 2);
      return true;
    },
  );
});

test("runtime guard failures come back to the model with a repair hint, not just a code", async () => {
  // One production run spent 12 of 24 turns on two runtime rules in stage_3 — the
  // model only saw a code and tried a different wrong thing. Every rule must say why and how to fix it.
  const { runtimeRepairHint } = await import("../runner/capability-v2/javascript-author.ts");
  const state = runtimeRepairHint("page.evaluate: Error: capability_stage_state_read_undeclared:stage_3:keyword\n    at Object.get");
  assert.match(state, /stage_3 reads state\.keyword/);
  assert.match(state, /io\.reads\.state/);
  assert.match(state, /input\.keyword/);
  const input = runtimeRepairHint("capability_stage_input_read_undeclared:stage_verify:city");
  assert.match(input, /stage_verify reads input\.city/);
  assert.match(runtimeRepairHint("capability_stage_context_lost:stage_2"), /LAST statement/);
  assert.match(runtimeRepairHint("capability_stage_direct_navigation_forbidden:stage_2:new_window:https://x.test/share"), /new window/);
  assert.match(runtimeRepairHint("capability_control_flow_timeout"), /waitUntil/);
  const pending = runtimeRepairHint('capability_control_flow_timeout:stage_1:pending=waitFor("input[name=\\"搜索历史热搜\\"]")');
  assert.match(pending, /waitFor\("input\[name=/);
  assert.match(pending, /never matched/);
  assert.equal(runtimeRepairHint("draft_business_outcome:NoResult:"), undefined, "业务结论自有其反馈，不套模板");
});

/**
 * One production run (task 21a7c902) spent 23 of 24 calls inspecting the page, wrote
 * capability.ts on the 24th, and the loop ended with "budget exhausted" — the code
 * never ran, and the reported cause was an ENOENT from the 10th read_file.
 */
test("budget exhausted right after write_file: the unreplayed draft still gets one replay, and can succeed", async () => {
  const turns = [
    toolTurn(1, "read_file", { path: "task/authoring-input.json" }),
    toolTurn(2, "read_file", { path: "src/capability.ts" }),
    toolTurn(3, "get_dom", { target: "exploration" }),
    toolTurn(4, "write_file", { path: "capability.ts", content: source }),
  ];
  const completed = await runAuthor({ turns, stageRun: async () => successfulDraft(), maxToolCalls: 4 });
  assert.equal(completed.result.draft.outcome, "Success");
  assert.equal(completed.stageCalls, 1, "预算收尾替模型跑了那一次自测");
  assert.ok(completed.events.some((event) => /budget exhausted; replaying/.test(event.message)));
  // src/capability.ts is seeded from the exploration before the first model turn.
  const readBack = completed.requests[2].messages.findLast((message) => message.role === "tool");
  const parsed = JSON.parse(readBack.content);
  assert.equal(parsed.ok, true);
  assert.match(parsed.content, /stage_verify_not_authored/);
  // The opening user message carries the seed check result.
  const opening = completed.requests[0].messages.filter((message) => message.role === "user").at(-1);
  assert.match(opening.content, /seedCheck/);
  assert.match(opening.content, /stage_verify_not_authored/);
});

test("budget exhausted with an unreplayed draft that fails: the reported cause is that replay, not an earlier read_file error", async () => {
  const turns = [
    toolTurn(1, "read_file", { path: "src/capability.ts" }),
    toolTurn(2, "get_dom", { target: "exploration" }),
    toolTurn(3, "get_dom", { target: "exploration" }),
    toolTurn(4, "write_file", { path: "capability.ts", content: source }),
  ];
  await assert.rejects(
    () => runAuthor({ turns, stageRun: async () => { throw new Error("capability_stage_result_invalid:stage_verify"); }, maxToolCalls: 4 }),
    (error) => {
      assert.equal(error.code, "javascript_author_tool_budget_exhausted");
      assert.equal(error.cause?.message, "capability_stage_result_invalid:stage_verify");
      assert.equal(error.authorTestState.stageCalls, 1);
      return true;
    },
  );
});

test("a budget spent entirely on inspection says so instead of blaming a stale tool error", async () => {
  const turns = [1, 2, 3, 4].map((index) => toolTurn(index, index === 1 ? "read_file" : "get_dom", index === 1 ? { path: "src/capability.ts" } : { target: "exploration" }));
  await assert.rejects(
    () => runAuthor({ turns, stageRun: async () => successfulDraft(), maxToolCalls: 4 }),
    (error) => {
      assert.equal(error.code, "javascript_author_tool_budget_exhausted");
      assert.match(error.cause?.message, /^authoring_draft_never_run:4 tool calls/);
      assert.equal(error.authorTestState.stageCalls, 0);
      return true;
    },
  );
});

test("every tool result carries the remaining budget, and the model is told to write when it is about to run out", async () => {
  const turns = [
    toolTurn(1, "read_file", { path: "task/authoring-input.json" }),
    toolTurn(2, "read_file", { path: "task/authoring-input.json" }),
    toolTurn(3, "write_file", { path: "capability.ts", content: source }),
    toolTurn(4, "run_draft"),
  ];
  const completed = await runAuthor({ turns, stageRun: async () => successfulDraft(), maxToolCalls: 8, maxDraftRuns: 3 });
  const toolResults = completed.requests.at(-1).messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content));
  assert.deepEqual(toolResults.map((result) => result.budget), [
    { toolCalls: 7, draftRuns: 3 },
    { toolCalls: 6, draftRuns: 3 },
    { toolCalls: 5, draftRuns: 3 },
  ]);
  assert.match(toolResults[1].hint, /Only 6 tool call\(s\) remain.*write_file now/);
  assert.equal(toolResults[2].hint, undefined, "源码写了就不再催");
});

test("the repair budget counts run_draft attempts, not inspection calls", async () => {
  // Both run_draft calls fail with maxDraftRuns=2: the model is not asked a third time.
  const turns = [
    toolTurn(1, "write_file", { path: "capability.ts", content: source }),
    toolTurn(2, "run_draft"),
    toolTurn(3, "get_dom", {}),
    toolTurn(4, "write_file", { path: "capability.ts", content: `${source}\n// second` }),
    toolTurn(5, "run_draft"),
    toolTurn(6, "write_file", { path: "capability.ts", content: `${source}\n// never reached` }),
  ];
  await assert.rejects(
    () => runAuthor({ turns, stageRun: async () => { throw new Error("capability_stage_result_invalid:stage_verify"); }, maxToolCalls: 20, maxDraftRuns: 2 }),
    (error) => {
      assert.equal(error.code, "javascript_author_tool_budget_exhausted");
      assert.equal(error.authorTestState.stageCalls, 2);
      assert.equal(error.authorTestState.requests.length, 5, "第六轮没有发生");
      return true;
    },
  );
});

function textTurn(content) {
  return { choices: [{ finish_reason: "stop", message: { role: "assistant", content, tool_calls: [] } }] };
}

test("a model that stops calling tools is treated as out of budget, and the last draft failure is what gets reported", async () => {
  // Production: the contract had frozen a sentence that only held for the demonstration;
  // the model saw through it, said "I must not change the contract", and answered with
  // text twice. That used to surface as model_protocol_error ("incompatible model"), hiding the real cause.
  const turns = [
    toolTurn(1, "write_file", { path: "capability.ts", content: source }),
    toolTurn(2, "run_draft"),
    textTurn("这个 successConditions 用了固定字符串，我不应该修改契约。"),
    textTurn("同上。"),
  ];
  await assert.rejects(
    () => runAuthor({ turns, stageRun: async () => { throw new Error("draft_grounding_example_failed:example_1:success_text_missing:找到 0 条"); }, maxToolCalls: 10 }),
    (error) => {
      assert.equal(error.code, "javascript_author_tool_budget_exhausted");
      assert.match(error.cause?.message, /^draft_grounding_example_failed:example_1/);
      assert.equal(error.authorTestState.requests.length, 4, "协议修复问了一次就停");
      assert.ok(error.authorTestState.events.some((event) => event.message === "model stopped calling tools"));
      return true;
    },
  );
});

test("a model that stops calling tools right after write_file still gets that draft replayed", async () => {
  const turns = [
    toolTurn(1, "write_file", { path: "capability.ts", content: source }),
    textTurn("写好了。"),
    textTurn("写好了。"),
  ];
  const completed = await runAuthor({ turns, stageRun: async () => successfulDraft(), maxToolCalls: 10 });
  assert.equal(completed.result.draft.outcome, "Success");
  assert.equal(completed.stageCalls, 1);
});
