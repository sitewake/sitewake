import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { inspectCapabilityQuality } from "../lib/capability-center-v2/quality.ts";

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

test("the click stage records what it acted on, and the verification stage may read it", () => {
  const trace = {
    steps: [
      { id: "fill_search", action: "fill", target: { strategies: [{ kind: "css", value: "#q" }] }, value: { source: "input", path: "rank" } },
      { id: "open_row", action: "click", target: { strategies: [{ kind: "css", value: "#row" }] } },
    ],
  };
  const contract = {
    inputSchema: { type: "object", properties: { rank: { type: "number" } }, required: ["rank"] },
    outputSchema: { type: "object", properties: { targetTitle: { type: "string" } }, required: ["targetTitle"] },
    successConditions: [{ type: "outputExists", path: "targetTitle" }],
  };
  const manifest = author.authoringManifest(trace, contract);
  const click = manifest.stages.find((stage) => stage.id === "stage_2");
  const fill = manifest.stages.find((stage) => stage.id === "stage_1");
  const verify = manifest.stages.find((stage) => stage.id === "stage_verify");
  assert.ok(click.io.writes.state.includes("targets.__actedOn"), "a click declares the identity it acted on");
  assert.equal(fill.io.writes.state.includes("targets.__actedOn"), false, "writing a text box is not acting on a business object");
  assert.ok(verify.io.reads.state.includes("targets.__actedOn"), "the verification stage may read it");

  const seed = author.seedCapabilitySource(manifest, trace, contract);
  assert.match(seed, /const actedOn = \(nameOf\(element\) \|\| element\.innerText \|\| element\.textContent \|\| ""\)/, "the identity is read before the click, by the name the element was found by");
  assert.match(seed, /state: \{ targets: \{ __actedOn: actedOn \} \}/);
  assert.match(seed, /keep\(\{ targets: \{ __actedOn: actedOn \} \}\);\n\s*const hrefBefore/, "the identity is kept before the click, for a document the click may unload");
  assert.match(seed, /identityMatches\(state\.targets\.__actedOn, title\)/, "the stub names the one comparison to use");
  assert.match(seed, /do not re-read from the result region what\n\s*\/\/ was already known/, "the stub says the identity is already known");
  assert.match(seed, /waitUntil must wait for the value about to be read, not for its/, "the stub says what to wait for");
  assert.match(seed, /await settle\(\);/, "the click stage lets an in-place update finish rendering");

  // Without a click there is no producer, so the verification stage must not declare the read.
  const noClick = author.authoringManifest({ steps: [trace.steps[0]] }, contract);
  assert.equal(noClick.stages.find((stage) => stage.id === "stage_verify").io.reads.state.includes("targets.__actedOn"), false);
});

test("the acted-on identity is the record a link or card opened, not the control clicked after it", async () => {
  // Recorded on a shop: open the listing, open a product card, choose a
  // variant, add to cart. The last click used to overwrite the identity with
  // "Add to cart — $219", and the program rejected its own correct result.
  const elements = {
    "#nav-shop": { innerText: "Shop", closest: () => null, click() {} },
    "#card": { innerText: "Mira Pendant\nSmoke  glass · Dimmable $219", closest: () => null, click() {} },
    "#variant": { innerText: "Opal glass", closest: (selector) => (selector.includes("label") ? {} : null), click() {} },
    "#add": { innerText: "Add to cart — $219", closest: (selector) => (selector.includes("button") ? {} : null), click() {} },
    // A page turn is a control whatever the site calls it, not the object.
    "#next": { innerText: "Next →", closest: () => null, click() {} },
  };
  const trace = { steps: Object.keys(elements).map((css, index) => ({ id: `click_${index}`, action: "click", target: { strategies: [{ kind: "css", value: css }] } })) };
  const contract = {
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { targetTitle: { type: "string" } }, required: ["targetTitle"] },
    successConditions: [{ type: "outputExists", path: "targetTitle" }],
  };
  const seed = author.seedCapabilitySource(author.authoringManifest(trace, contract), trace, contract);
  const { capability } = await import(`data:text/javascript;base64,${Buffer.from(seed).toString("base64")}`);
  const previous = { location: globalThis.location, document: globalThis.document };
  globalThis.location = { href: "https://shop.example/" };
  globalThis.document = { body: { innerText: "" } };
  try {
    const state = {};
    const kept = {};
    for (const stage of capability.stages.filter((item) => item.id !== "stage_verify")) {
      const result = await stage.run({
        input: {},
        waitForTarget: async (locator) => elements[locator.strategies[0].value],
        waitUntil: async () => true,
        settle: async () => undefined,
        keep: (partial) => Object.assign(kept, partial),
        nameOf: (element) => element.innerText || "",
      });
      if (result.state) Object.assign(state, result.state);
    }
    assert.equal(state.targets.__actedOn, "Mira Pendant Smoke glass · Dimmable $219", "the card names the object; whitespace collapses and every letter s survives");
    assert.equal(kept.targets.__actedOn, state.targets.__actedOn, "the same identity was kept before the click, for a document the click may unload");
  } finally {
    globalThis.location = previous.location;
    globalThis.document = previous.document;
  }
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

async function runAuthor({ turns, stageRun, maxToolCalls = turns.length, maxDraftRuns, startUrl = "https://target.test/start", groundingExamples = [], discoveryRegions, draftPage, startingSource, persisted = [], contract = {}, experience }) {
  const requests = [];
  const events = [];
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
      startUrl,
      goal: "search for cushion",
      input: { parameters: { query: "cushion" }, context: {}, ...(experience ? { experience } : {}) },
      contract: {
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
        preconditions: [],
        // A target input is verified by a parameterized condition, as in every
        // production Contract; the quality gate now checks this before the loop.
        successConditions: ["search completed", { type: "textTemplate", template: "{{query}}" }],
        ...contract,
      },
      explorationProgram: {
        schemaVersion: "2.0",
        runtime: "BrowserDSL",
        entry: { mode: "Navigate", url: "https://target.test/start" },
        steps: [],
        promptProvenance: [],
      },
      validationCases: [],
      groundingExamples,
      ...(discoveryRegions ? { discoveryRegions } : {}),
      startingSource,
      createDraftContext: async () => ({
        context: { close: async () => undefined },
        page: draftPage || { goto: async () => undefined, waitForTimeout: async () => undefined },
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
    locator: () => ({ innerText: async () => "search completed cushion" }),
    waitForTimeout: async () => undefined,
    evaluate: async () => ({
      url: "https://target.test/results",
      title: "Results",
      heading: "Search results",
      text: "search completed cushion",
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

test("a capability bound to a page is drafted and published starting on that page, not where it was explored", async () => {
  // "Find wall lamps by finish" was explored from the home page and bound to
  // /shop?type=wall. Its drafts ran from the home page and it was published
  // to start there, so every validation case failed the Contract's own
  // precondition before it ran.
  const opened = [];
  const completed = await runAuthor({
    turns: [toolTurn(1, "write_file", { path: "capability.ts", content: source }), toolTurn(2, "run_draft")],
    stageRun: async () => successfulDraft(),
    startUrl: "https://target.test/",
    contract: {
      preconditions: [{ type: "urlIncludes", value: "target.test/shop?type=wall" }],
      scope: { kind: "category-scoped", onMismatch: "no-match", match: { urlPatterns: ["https://target.test/shop?type=wall"] } },
    },
    draftPage: { ...successfulDraft().page, goto: async (url) => { opened.push(url); } },
  });
  assert.deepEqual(completed.result.program.entry, { mode: "Navigate", url: "https://target.test/shop?type=wall" });
  assert.ok(opened.length, "the draft opened a page");
  assert.ok(opened.every((url) => url === "https://target.test/shop?type=wall"), `drafts opened ${opened.join(", ")}`);
  assert.equal(JSON.parse(completed.requests[0].messages[1].content).startUrl, "https://target.test/shop?type=wall", "the model was told where the program starts");
});

test("an authoring example the site has no data for is recorded, not a reason to stop authoring", async () => {
  // The demo's order-status capability was abandoned after the program, asked
  // about a sample order number found on the page, correctly answered
  // "Order not found" twice.
  const turns = [toolTurn(1, "write_file", { path: "capability.ts", content: source }), toolTurn(2, "run_draft")];
  const completed = await runAuthor({
    turns,
    groundingExamples: [{ query: "ORV-00000" }],
    stageRun: async (options) => (options.input.query === "ORV-00000"
      ? { page: successfulDraft().page, outcome: "NoResult", reason: "Order not found", output: {}, state: {}, evidence: [], receipts: [] }
      : successfulDraft()),
  });
  assert.equal(completed.result.draft.outcome, "Success");
  assert.ok(completed.events.some((event) => event.message === "draft grounding example returned no result" && event.payload?.reason === "Order not found"));
});

test("a sibling value the site lists beside the demonstrated one is a failure to find nothing for, and such a draft is not handed on", async () => {
  // "Count books in category" was proven with Poetry; its draft opened the
  // Poetry page for Mystery too and said the page was not Mystery. Mystery is
  // in the same list as Poetry, so that is the program failing, said to the
  // model while it can still fix it — and never accepted on Poetry alone.
  const turns = [
    toolTurn(1, "write_file", { path: "capability.ts", content: source }),
    toolTurn(2, "run_draft"),
    toolTurn(3, "write_file", { path: "capability.ts", content: `${source}\n// still Poetry` }),
    toolTurn(4, "run_draft"),
  ];
  await assert.rejects(
    () => runAuthor({
      turns, maxToolCalls: 8, maxDraftRuns: 4,
      groundingExamples: [{ query: "pillow" }],
      discoveryRegions: [{ regionId: "region_1", url: "https://target.test/start", kind: "choice-list", text: "cushion, pillow, lamp", observedValues: ["cushion", "pillow", "lamp"] }],
      stageRun: async (options) => (options.input.query === "pillow"
        ? { page: successfulDraft().page, outcome: "NoResult", reason: "page shows cushion, not pillow", output: {}, state: {}, evidence: [], receipts: [] }
        : successfulDraft()),
    }),
    (error) => {
      assert.equal(error.code, "javascript_author_repeated_failure");
      assert.match(error.cause?.message, /draft_grounding_example_failed:example_1:offered_input_no_result:query="pillow":page shows cushion, not pillow/);
      const feedback = error.authorTestState.requests[2].messages.findLast((message) => message.role === "tool");
      assert.match(feedback.content, /lists this value beside the demonstrated one/);
      assert.ok(!error.authorTestState.events.some((event) => /draft that passed the demonstration/.test(event.message || "")), "a draft that fails an offered value is not accepted on the demonstration");
      return true;
    },
  );
});

test("an authoring example that fails outright still goes back for repair", async () => {
  const turns = [toolTurn(1, "write_file", { path: "capability.ts", content: source }), toolTurn(2, "run_draft")];
  await assert.rejects(
    () => runAuthor({
      turns,
      groundingExamples: [{ query: "pillow" }],
      stageRun: async (options) => (options.input.query === "pillow"
        ? { page: successfulDraft().page, outcome: "Ambiguous", reason: "two matches", output: {}, state: {}, evidence: [], receipts: [] }
        : successfulDraft()),
    }),
    (error) => {
      const failed = error.authorTestState.events.find((event) => event.message === "run_draft failed");
      assert.match(failed?.payload?.error || "", /^draft_grounding_example_failed:example_1:Ambiguous:two matches/);
      return true;
    },
  );
});

test("a count proven wrong on the last replay still gets one replay to be fixed", async () => {
  // The floor-lamp rebuild spent its replays on unrelated errors and learned
  // on the last one that its count read the catalog total ("of 16") for
  // every room; the draft with that count was accepted and published.
  const turns = [
    toolTurn(1, "write_file", { path: "capability.ts", content: source }),
    toolTurn(2, "run_draft"),
    toolTurn(3, "write_file", { path: "capability.ts", content: source }),
    toolTurn(4, "run_draft"),
  ];
  const listed = (count, length) => ({ ...successfulDraft(), output: { ok: true, total: count, items: Array.from({ length }, (_, index) => ({ name: `item ${index}` })) } });
  const { result, events } = await runAuthor({
    turns,
    maxToolCalls: 4,
    maxDraftRuns: 1,
    groundingExamples: [{ query: "pillow" }],
    draftPage: { ...successfulDraft().page, goto: async () => undefined },
    stageRun: async (options, attempt) => {
      const length = options.input.query === "pillow" ? 1 : 3;
      return attempt <= 2 ? listed(16, length) : listed(length, length);
    },
  });
  assert.ok(events.some((event) => /answers_together:total was 16/.test(event.payload?.error || "")), "the finding reached the model");
  assert.ok(!events.some((event) => /goes on to validation/.test(event.message || "")), "the proven-wrong draft was not accepted");
  assert.equal(result.draft.output.total, 3, "the repaired count follows the list");
});

test("when repairs end on a grounding example, the draft that passed the demonstration goes on to validation", async () => {
  // A cart capability's grounding example asked for a lamp that cannot be
  // added without a plug type the capability has no input for. The model
  // "repaired" a correct program twice and authoring threw it away.
  const turns = [
    toolTurn(1, "write_file", { path: "capability.ts", content: source }),
    toolTurn(2, "run_draft"),
    toolTurn(3, "run_draft"),
  ];
  const { result, events } = await runAuthor({
    turns,
    groundingExamples: [{ query: "pillow" }],
    stageRun: async (options) => (options.input.query === "pillow"
      ? { page: successfulDraft().page, outcome: "Failed", reason: "plug type required", output: {}, state: {}, evidence: [], receipts: [] }
      : successfulDraft()),
  });
  assert.equal(result.source, source);
  const accepted = events.find((event) => /draft that passed the demonstration/.test(event.message));
  assert.match(accepted?.payload?.reason || "", /draft_grounding_example_failed:example_1:Failed:plug type required/);
});

test("a count that never moved while its list did goes back to the model with what each run returned", async () => {
  // "Find floor lamps" read the 16 in "Showing 4 of 16 lamps" for every room.
  const turns = [
    toolTurn(1, "write_file", { path: "capability.ts", content: source }),
    toolTurn(2, "run_draft"),
    toolTurn(3, "run_draft"),
  ];
  const lamps = (count) => Array.from({ length: count }, (_, index) => ({ name: `Lamp ${index + 1}` }));
  const { result, events, requests } = await runAuthor({
    turns,
    groundingExamples: [{ query: "pillow" }],
    draftPage: { ...successfulDraft().page, goto: async () => undefined },
    stageRun: async (options) => ({ ...successfulDraft(), output: { ok: true, items: lamps(options.input.query === "pillow" ? 2 : 4), totalCount: 16 } }),
  });
  const feedback = requests[2].messages.findLast((message) => message.role === "tool");
  assert.match(feedback.content, /totalCount was 16 in every run while items changed/);
  assert.match(feedback.content, /pillow\\"\} → items has 2/);
  // Repairs ran out on it; the draft that passed the demonstration still goes on.
  assert.equal(result.source, source);
  assert.ok(events.some((event) => /draft that passed the demonstration/.test(event.message)));
});

test("a draft whose output states none of the numbers the visitor was told goes back to the model, and is not accepted when repairs run out", async () => {
  // "Count quotes by tag" was proven with twelve quotes; the draft counted the
  // two on the tag's last page, passed every structural check and was
  // published to tell every visitor the count of one page.
  const turns = [
    toolTurn(1, "write_file", { path: "capability.ts", content: source }),
    toolTurn(2, "run_draft"),
    toolTurn(3, "write_file", { path: "capability.ts", content: `${source}\n// still counts one page` }),
    toolTurn(4, "run_draft"),
  ];
  const answer = "There are 12 quotes tagged 'humor' in total. Page 1 lists 10 and page 2 lists the remaining 2.";
  await assert.rejects(
    () => runAuthor({
      turns, maxToolCalls: 8, maxDraftRuns: 4,
      experience: { originalGoal: "How many quotes are tagged 'humor'?", outcomeSummary: answer, answer },
      stageRun: async () => ({ ...successfulDraft(), output: { ok: true, quoteCount: 2, pageCount: 2 } }),
    }),
    (error) => {
      assert.equal(error.code, "javascript_author_repeated_failure");
      assert.match(error.cause?.message, /draft_disagrees_with_demonstration:the demonstration answered "There are 12 quotes tagged 'humor' in total" for \{"query":"cushion"\}, which states 12; the draft's output for the same input states 2 \(quoteCount\), 2 \(pageCount\)/);
      const feedback = error.authorTestState.requests[2].messages.findLast((message) => message.role === "tool");
      assert.match(feedback.content, /none of them agree/, "the model was told what the visitor was told and what the draft returned");
      assert.ok(!error.authorTestState.events.some((event) => /draft that passed the demonstration/.test(event.message || "")), "a draft that contradicts the demonstration never passed it");
      return true;
    },
  );
});

test("a draft that states what the visitor was told, among other numbers, is in agreement", async () => {
  const turns = [toolTurn(1, "write_file", { path: "capability.ts", content: source }), toolTurn(2, "run_draft")];
  const answer = "The Brown bear cushion has been added to your cart. Your cart now shows 1 item at $18.90, with a total of $25.90.";
  const { result } = await runAuthor({
    turns,
    experience: { originalGoal: "Add the cushion to my cart", outcomeSummary: answer, answer },
    stageRun: async () => ({ ...successfulDraft(), output: { ok: true, cartItemName: "Brown bear cushion", cartItemQuantity: 1 } }),
  });
  assert.equal(result.draft.output.cartItemQuantity, 1);
});

test("a rerun's source that passes every current check is handed on without a model call", async () => {
  const lamps = (count) => Array.from({ length: count }, (_, index) => ({ name: `Lamp ${index + 1}` }));
  const { result, requests } = await runAuthor({
    turns: [],
    maxToolCalls: 4,
    startingSource: source,
    groundingExamples: [{ query: "pillow" }],
    draftPage: { ...successfulDraft().page, goto: async () => undefined },
    stageRun: async (options) => {
      const items = lamps(options.input.query === "pillow" ? 2 : 4);
      return { ...successfulDraft(), output: { ok: true, items, totalCount: items.length } };
    },
  });
  assert.equal(requests.length, 0);
  assert.equal(result.source, source);
});

test("a rerun's source meets checks added after it was written, and the model repairs what they find", async () => {
  // "Find floor lamps" was rerun after the count check shipped; its saved
  // source skipped authoring and published the catalog-wide count again.
  const stale = source.replace("const targetResolution", "const readsCatalogTotal=true;const targetResolution");
  const lamps = (count) => Array.from({ length: count }, (_, index) => ({ name: `Lamp ${index + 1}` }));
  const persisted = [];
  const { result, requests } = await runAuthor({
    persisted,
    turns: [toolTurn(1, "write_file", { path: "capability.ts", content: source }), toolTurn(2, "run_draft")],
    startingSource: stale,
    groundingExamples: [{ query: "pillow" }],
    draftPage: { ...successfulDraft().page, goto: async () => undefined },
    stageRun: async (options) => {
      const items = lamps(options.input.query === "pillow" ? 2 : 4);
      const totalCount = persisted.at(-1).includes("readsCatalogTotal") ? 16 : items.length;
      return { ...successfulDraft(), output: { ok: true, items, totalCount } };
    },
  });
  const firstRequest = JSON.stringify(requests[0].messages);
  assert.match(firstRequest, /totalCount was 16 in every run while items changed/, "the model starts from what the check found");
  assert.ok(!persisted.some((bundle) => bundle.includes("stage_verify_not_authored")), "the exploration seed never replaced the saved source");
  assert.equal(result.source, source);
});

test("a draft that never passed its demonstration is not handed on", async () => {
  const turns = [toolTurn(1, "write_file", { path: "capability.ts", content: source }), toolTurn(2, "run_draft"), toolTurn(3, "run_draft")];
  await assert.rejects(() => runAuthor({
    turns,
    stageRun: async () => ({ page: successfulDraft().page, outcome: "Failed", reason: "button missing", output: {}, state: {}, evidence: [], receipts: [] }),
  }), /javascript_author_repeated_failure/);
});

test("edit_file changes one passage of the seeded source and leaves the rest as it was", async () => {
  // A repair used to be a whole-file rewrite; the seeded action stages are
  // proven by exploration and an edit leaves them untouched.
  const turns = [
    toolTurn(1, "edit_file", { path: "capability.ts", old_str: 'throw new Error("stage_verify_not_authored");', new_str: 'return {outcome:"Success",output:{ok:true}};' }),
    toolTurn(2, "run_draft"),
  ];
  const completed = await runAuthor({ turns, stageRun: async () => successfulDraft() });
  assert.equal(completed.result.draft.outcome, "Success");
  const [seed, edited] = completed.persisted.slice(-2);
  assert.ok(!edited.includes("stage_verify_not_authored"), "the stub was replaced");
  assert.equal(edited.length - seed.length, 'return {outcome:"Success",output:{ok:true}};'.length - 'throw new Error("stage_verify_not_authored");'.length, "nothing else changed");
});

test("edit_file refuses a passage that is missing or not unique, and says which", async () => {
  const turns = [
    toolTurn(1, "edit_file", { path: "capability.ts", old_str: "this text is not in the source", new_str: "x" }),
    toolTurn(2, "edit_file", { path: "capability.ts", old_str: 'throw new Error("stage_verify_not_authored");', new_str: 'return {outcome:"Success",output:{ok:true}};' }),
    toolTurn(3, "run_draft"),
  ];
  const completed = await runAuthor({ turns, stageRun: async () => successfulDraft() });
  const feedback = completed.requests[1].messages.findLast((message) => message.role === "tool");
  assert.match(feedback.content, /edit_file_old_str_not_found/);
  assert.equal(completed.result.draft.outcome, "Success");
});

test("a malformed tool call is the model's to correct, not the end of authoring", async () => {
  // A path the schema refused ended a run whose draft already replayed every
  // action stage; "src/capability.ts" is now accepted as the same file.
  const bad = { path: "lib/other.ts", old_str: "x", new_str: "y" };
  const turns = [
    toolTurn(1, "edit_file", bad),
    toolTurn(2, "edit_file", bad),
    toolTurn(3, "edit_file", { path: "src/capability.ts", old_str: 'throw new Error("stage_verify_not_authored");', new_str: 'return {outcome:"Success",output:{ok:true}};' }),
    toolTurn(4, "run_draft"),
  ];
  const completed = await runAuthor({ turns, stageRun: async () => successfulDraft(), maxToolCalls: 10 });
  assert.equal(completed.result.draft.outcome, "Success");
  assert.ok(completed.events.some((event) => event.message === "tool call failed" && /tool_argument_enum_invalid/.test(event.payload?.error || "")));
});

test("repair budget exhaustion retains the last root cause", async () => {
  const turns = [
    toolTurn(1, "write_file", { path: "capability.ts", content: source }),
    toolTurn(2, "run_draft"),
    toolTurn(3, "write_file", { path: "capability.ts", content: `${source}\n// second attempt` }),
    toolTurn(4, "run_draft"),
  ];
  // Two different failures: the repair moved the failing point, so the budget is what ends the loop.
  await assert.rejects(
    () => runAuthor({ turns, stageRun: async (_options, attempt) => { throw new Error(`capability_stage_result_invalid:stage_verify:attempt_${attempt}`); } }),
    (error) => {
      assert.equal(error.code, "javascript_author_tool_budget_exhausted");
      assert.match(error.message, /capability_stage_result_invalid:stage_verify:attempt_2/);
      assert.equal(error.cause?.message, "capability_stage_result_invalid:stage_verify:attempt_2");
      assert.equal(error.authorTestState.stageCalls, 2);
      return true;
    },
  );
});

test("a Contract whose predicate no Stage may write is recorded as a note; authoring proceeds", async () => {
  // The pageUrl contradiction (2026-09-20) used to be refused before the first
  // model call. The Contract is the demonstration's now and its outputs are
  // frozen from the draft, so the finding is kept with the version instead.
  const turns = [toolTurn(1, "write_file", { path: "capability.ts", content: source }), toolTurn(2, "run_draft")];
  const completed = await runAuthor({
    turns,
    stageRun: async () => successfulDraft(),
    contract: {
      outputSchema: { type: "object", properties: { targetTitle: { type: "string" } }, required: ["targetTitle"], additionalProperties: false },
      // The exploration envelope key that hardening once copied into the
      // Contract, beside a condition the replay can evaluate on its own.
      successConditions: [{ type: "textTemplate", template: "{{query}}" }, { type: "outputExists", path: "pageUrl" }],
    },
  });
  assert.equal(completed.result.draft.outcome, "Success");
  assert.ok(completed.result.program.qualityNotes.some((note) => note.code === "condition_output_undeclared"), JSON.stringify(completed.result.program.qualityNotes));
});

test("the same draft failure twice in a row stops the loop instead of spending the rest of the budget", async () => {
  const turns = [
    toolTurn(1, "write_file", { path: "capability.ts", content: source }),
    toolTurn(2, "run_draft"),
    toolTurn(3, "write_file", { path: "capability.ts", content: `${source}\n// second attempt` }),
    toolTurn(4, "run_draft"),
    toolTurn(5, "write_file", { path: "capability.ts", content: `${source}\n// never reached` }),
    toolTurn(6, "run_draft"),
  ];
  await assert.rejects(
    // Hints and receipts differ per turn; the failure itself is what is compared.
    () => runAuthor({ turns, stageRun: async (_options, attempt) => { throw new Error(`capability_stage_output_write_undeclared:stage_verify:pageUrl;receipts=[${attempt}];hint=turn ${attempt}`); }, maxToolCalls: 20, maxDraftRuns: 6 }),
    (error) => {
      assert.equal(error.code, "javascript_author_repeated_failure");
      assert.equal(error.authorRepairable, false);
      assert.equal(error.taskRetryable, true);
      assert.match(error.cause?.message, /capability_stage_output_write_undeclared:stage_verify:pageUrl/);
      assert.equal(error.authorTestState.stageCalls, 2, "the third draft never ran");
      assert.equal(error.authorTestState.requests.length, 4, "the model was not asked to repair a third time");
      assert.ok(error.authorTestState.events.some((event) => /same failure twice in a row/.test(event.message)));
      return true;
    },
  );
  assert.equal(author.draftFailureSignature("code:detail;receipts=[a];hint=b"), "code:detail");
  assert.equal(author.draftFailureSignature("code:detail;hint=b;receipts=[a]"), "code:detail");
});

test("a failure that does not say where it was is given one more repair", async () => {
  // capability_control_flow_timeout on its own says a wait never settled, not
  // which wait, and two of them can be two different stalls. A run stopped
  // after two of its six drafts on a capability that passed on the next
  // attempt, so an unlocated signature is allowed one more try; a located one
  // still ends the repairs at once.
  const turns = [
    toolTurn(1, "write_file", { path: "capability.ts", content: source }),
    toolTurn(2, "run_draft"),
    toolTurn(3, "write_file", { path: "capability.ts", content: `${source}\n// second` }),
    toolTurn(4, "run_draft"),
    toolTurn(5, "write_file", { path: "capability.ts", content: `${source}\n// third` }),
    toolTurn(6, "run_draft"),
    toolTurn(7, "write_file", { path: "capability.ts", content: `${source}\n// never reached` }),
    toolTurn(8, "run_draft"),
  ];
  await assert.rejects(
    () => runAuthor({ turns, stageRun: async () => { throw new Error("capability_control_flow_timeout"); }, maxToolCalls: 20, maxDraftRuns: 6 }),
    (error) => {
      assert.equal(error.code, "javascript_author_repeated_failure");
      assert.equal(error.authorTestState.stageCalls, 3, "the unlocated failure got a third draft");
      return true;
    },
  );

  // Naming the stage a spent budget gave up in made that signature look
  // located, so the repairs were cut to one and a capability whose page is
  // simply slower than the self-test budget could never be authored. A clock
  // is not a place in the source, however much of it the message names.
  const timedOut = [
    toolTurn(1, "write_file", { path: "capability.ts", content: source }),
    toolTurn(2, "run_draft"),
    toolTurn(3, "write_file", { path: "capability.ts", content: `${source}\n// second` }),
    toolTurn(4, "run_draft"),
    toolTurn(5, "write_file", { path: "capability.ts", content: `${source}\n// third` }),
    toolTurn(6, "run_draft"),
    toolTurn(7, "write_file", { path: "capability.ts", content: `${source}\n// never reached` }),
    toolTurn(8, "run_draft"),
  ];
  await assert.rejects(
    () => runAuthor({
      turns: timedOut,
      stageRun: async () => { throw new Error("capability_control_flow_timeout:stage_verify:pending=budget-exhausted-before-stage"); },
      maxToolCalls: 20,
      maxDraftRuns: 6,
    }),
    (error) => {
      assert.equal(error.authorTestState.stageCalls, 3, "a spent budget that names its stage still gets a third draft");
      return true;
    },
  );

  // A navigation the host could not complete is located and still gets the
  // extra draft: the right response to a slow page is the same source again,
  // which is exactly what the hint tells the author to do.
  const again = [
    toolTurn(1, "write_file", { path: "capability.ts", content: source }),
    toolTurn(2, "run_draft"),
    toolTurn(3, "write_file", { path: "capability.ts", content: `${source}\n// second` }),
    toolTurn(4, "run_draft"),
    toolTurn(5, "write_file", { path: "capability.ts", content: `${source}\n// third` }),
    toolTurn(6, "run_draft"),
    toolTurn(7, "write_file", { path: "capability.ts", content: `${source}\n// never reached` }),
    toolTurn(8, "run_draft"),
  ];
  await assert.rejects(
    () => runAuthor({ turns: again, stageRun: async () => { throw new Error("capability_navigation_timeout:stage_1:https://archive.example/daily/2026-03-11:Timeout 30000ms exceeded."); }, maxToolCalls: 20, maxDraftRuns: 6 }),
    (error) => {
      assert.equal(error.authorTestState.stageCalls, 3, "a host navigation timeout got a third draft");
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
  // The host's navigation is not the module's wait. Reported under the same
  // code, it sent the author to rewrite waits it had no way to be wrong
  // about — twice, identically — and the run stopped for a change that had
  // not touched the failure, because the failure was not in its code.
  const navigated = runtimeRepairHint("capability_navigation_timeout:stage_1:https://archive.example/daily/2026-03-11:Timeout 30000ms exceeded.");
  assert.match(navigated, /^NOT YOUR WAIT/);
  assert.match(navigated, /stage_1/);
  assert.match(navigated, /archive\.example\/daily\/2026-03-11/);
  assert.match(navigated, /Timeout 30000ms exceeded/);
  assert.doesNotMatch(navigated, /waitUntil/);
  const pending = runtimeRepairHint('capability_control_flow_timeout:stage_1:pending=waitFor("input[name=\\"搜索历史热搜\\"]")');
  assert.match(pending, /waitFor\("input\[name=/);
  assert.match(pending, /never matched/);
  // A find that never matched names the page it looked on as the suspect, and
  // the way to another page, rather than the controlled-input advice for waits.
  const notOnThisPage = runtimeRepairHint('capability_control_flow_timeout:stage_verify:pending=find({"strategies":[{"type":"css","value":"#type"}]})');
  assert.match(notOnThisPage, /#type/);
  assert.match(notOnThisPage, /observation\.url/);
  assert.match(notOnThisPage, /navigation: \{ url/);
  assert.doesNotMatch(notOnThisPage, /controlled input/);
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
    () => runAuthor({ turns, stageRun: async (_options, attempt) => { throw new Error(`capability_stage_result_invalid:stage_verify:attempt_${attempt}`); }, maxToolCalls: 20, maxDraftRuns: 2 }),
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

test("a manifest finding of a demoted check is a note on the program; the draft is accepted on its first replay", async () => {
  // 查看指定日期微博热搜榜: refused after the loop for stage_io_state_read_unavailable
  // — its verify stage declared it reads state.targets and nothing produced
  // it — and later refused inside the loop. The check has no recorded defect
  // behind it (benchmark/GATES.md); the replays decide, and the finding is kept.
  const verify = { id: "stage_verify", title: "verify", purpose: "verify", effect: "read", resumePolicy: "skip-completed", navigation: "none" };
  const unproduced = [{ ...verify, io: { reads: { input: ["query"], state: ["targets"] }, writes: { state: [], output: ["ok"] } } }];
  const turns = [toolTurn(1, "write_file", { path: "capability.ts", content: source }), toolTurn(2, "run_draft")];
  const completed = await runAuthor({ turns, stageRun: async () => ({ ...successfulDraft(), stageManifest: unproduced }) });
  assert.equal(completed.result.draft.outcome, "Success");
  assert.equal(completed.stageCalls, 1);
  assert.ok(completed.result.program.qualityNotes.some((note) => note.code === "stage_io_state_read_unavailable"), JSON.stringify(completed.result.program.qualityNotes));
});

/**
 * Whatever demoted rule a program-path finding trips, it is a note on the
 * program and the draft is accepted on its first replay; a rule that blocks
 * does so only with a recorded defect behind it (benchmark/GATES.md).
 */
const verifyStage = { id: "stage_verify", title: "verify", purpose: "verify", effect: "read", resumePolicy: "skip-completed", navigation: "none" };
const cleanVerify = { ...verifyStage, io: { reads: { input: ["query"], state: [] }, writes: { state: [], output: ["ok"] } } };

test("every program-path finding of a demoted check is a note, whichever rule it is", async () => {
  const drafts = {
    stage_io_state_read_unavailable: [{ ...verifyStage, io: { reads: { input: ["query"], state: ["targets"] }, writes: { state: [], output: ["ok"] } } }],
    stage_io_output_undeclared: [{ ...verifyStage, io: { reads: { input: ["query"], state: [] }, writes: { state: [], output: ["ok", "invented"] } } }],
    stage_io_input_undeclared: [{ ...verifyStage, io: { reads: { input: ["query", "notAnInput"], state: [] }, writes: { state: [], output: ["ok"] } } }],
    write_stage_reconciliation_required: [
      { id: "stage_1", title: "act", purpose: "act", effect: "write", resumePolicy: "skip-completed", navigation: "optional", io: { reads: { input: ["query"], state: [] }, writes: { state: [], output: [] } } },
      cleanVerify,
    ],
  };
  for (const [code, manifest] of Object.entries(drafts)) {
    const turns = [toolTurn(1, "write_file", { path: "capability.ts", content: source }), toolTurn(2, "run_draft")];
    const completed = await runAuthor({ turns, stageRun: async () => ({ ...successfulDraft(), stageManifest: manifest }) });
    assert.equal(completed.result.draft.outcome, "Success", `${code}: accepted`);
    assert.equal(completed.stageCalls, 1, `${code}: on the first replay`);
    assert.ok(completed.result.program.qualityNotes.some((note) => note.code === code), `${code}: recorded as a note`);
  }
});

// Recorded on the demo store: a room filter given a default was optional, got
// no opening stage, and the program read whatever page it started on — it
// passed authoring on /shop?room=dining and timed out on every validation case.
test("an optional input that is part of the demonstrated address also gets an opening stage", () => {
  const contract = {
    inputSchema: { type: "object", properties: { room: { type: "string", examples: ["dining"], default: "dining" } }, required: [], additionalProperties: false },
    outputSchema: { type: "object", properties: { totalCount: { type: "number" } }, required: ["totalCount"], additionalProperties: false },
    preconditions: [],
    successConditions: [{ type: "outputExists", path: "totalCount" }],
  };
  const trace = { schemaVersion: "1.0", entry: { mode: "CurrentPage" }, defaults: { timeoutMs: 1000, retryCount: 0 }, steps: [], result: {} };
  const manifest = author.authoringManifest(trace, contract, { startUrl: "https://shop.example/shop?room=dining", demonstrationParameters: { room: "dining" } });
  assert.deepEqual(manifest.stages.map((stage) => [stage.id, stage.navigation, stage.io.reads.input]), [
    ["stage_open", "required", ["room"]],
    ["stage_verify", "none", ["room"]],
  ]);
});

test("an input that is part of the demonstrated address gets an opening stage in the manifest, seeded with that address as a template", () => {
  // The stage list is fixed by the exploration trace, so a model told to add
  // a navigating stage cannot. When the demonstration value is part of the
  // address and the trace never navigated, the manifest opens with a stage
  // that does, and its seed already opens the right page for any value.
  const contract = {
    inputSchema: { type: "object", properties: { date: { type: "string" } }, required: ["date"], additionalProperties: false },
    outputSchema: { type: "object", properties: { heading: { type: "string" } }, required: ["heading"], additionalProperties: false },
    preconditions: [],
    successConditions: [{ type: "textTemplate", template: "{{date}}" }],
  };
  const trace = { schemaVersion: "1.0", entry: { mode: "Navigate", url: "https://archive.example/daily/2026-03-11" }, defaults: { timeoutMs: 1000, retryCount: 0 }, steps: [], result: {} };
  const address = { startUrl: "https://archive.example/daily/2026-03-11?tab=all", demonstrationParameters: { date: "2026-03-11" } };
  const manifest = author.authoringManifest(trace, contract, address);
  assert.deepEqual(manifest.stages.map((stage) => [stage.id, stage.navigation, stage.io.reads.input]), [
    ["stage_open", "required", ["date"]],
    ["stage_verify", "none", ["date"]],
  ]);
  const seed = author.seedCapabilitySource(manifest, trace, contract, address);
  assert.match(seed, /id: "stage_open"/);
  assert.match(seed, /navigation: \{ url: `https:\/\/archive\.example\/daily\/\$\{encodeURIComponent\(String\(input\["date"\]\)\)\}\?tab=all`, target: "_self" \}/);
  // A query value is substituted the same way.
  assert.equal(
    author.pageAddressTemplate("https://archive.example/daily?date=2026-03-11&tab=all", ["date"], { date: "2026-03-11" }),
    "`https://archive.example/daily?date=${encodeURIComponent(String(input[\"date\"]))}&tab=all`",
  );
  // An input that is not part of the address gets no opening stage; neither
  // does a trace that already navigates.
  assert.equal(author.authoringManifest(trace, contract, { startUrl: "https://archive.example/daily/today", demonstrationParameters: { date: "2026-03-11" } }).stages[0].id, "stage_verify");
  const navigating = { ...trace, steps: [{ id: "go", action: "navigate", value: { kind: "literal", value: "https://archive.example/daily/2026-03-11" } }] };
  assert.ok(!author.authoringManifest(navigating, contract, address).stages.some((stage) => stage.id === "stage_open"));

  // A trace that navigates gets no opening stage because its own step opens
  // the page — but only if that step opens the page for the input. Replaying
  // a recorded run puts the demonstrated address in the trace, and written out
  // literally the capability went to 2026-03-11 whatever date it was asked
  // for: input.date was read by nothing but the final stage.
  const replayed = { ...trace, steps: [{ id: "go", action: "navigate", value: { source: "literal", value: "https://archive.example/daily/2026-03-11" } }] };
  const replayedManifest = author.authoringManifest(replayed, contract, address);
  assert.deepEqual(replayedManifest.stages.map((stage) => [stage.id, stage.navigation, stage.io.reads.input]), [
    ["stage_1", "required", ["date"]],
    ["stage_verify", "none", ["date"]],
  ]);
  const replayedSeed = author.seedCapabilitySource(replayedManifest, replayed, contract, address);
  assert.match(replayedSeed, /navigation: \{ url: `https:\/\/archive\.example\/daily\/\$\{encodeURIComponent\(String\(input\["date"\]\)\)\}`, target: "_self" \}/);
  assert.doesNotMatch(replayedSeed, /void input;/);

  // An address that carries nothing of the input is still written out as it
  // was, and says so.
  const fixed = { ...trace, steps: [{ id: "go", action: "navigate", value: { source: "literal", value: "https://archive.example/daily/today" } }] };
  const fixedSeed = author.seedCapabilitySource(author.authoringManifest(fixed, contract, address), fixed, contract, address);
  assert.match(fixedSeed, /void input;/);
  // And the seed passes the gate that refuses a program which never navigates.
  const program = { schemaVersion: "2.0", runtime: "BrowserJavaScriptStage", module: { contentHash: "a".repeat(64), moduleUrl: "/m", exportName: "capability" }, entry: { mode: "CurrentPage" }, stages: manifest.stages, parameterRoles: manifest.parameterRoles, targetBindings: manifest.targetBindings, promptProvenance: [] };
  assert.deepEqual(inspectCapabilityQuality(contract, program, { demonstrationParameters: address.demonstrationParameters, entryUrl: address.startUrl }).issues.map((issue) => issue.code), []);
});

test("a module whose stages differ from the manifest is told what the manifest fixes, not just a code", () => {
  const hint = author.runtimeRepairHint("capability_stage_manifest_mismatch", ["stage_open", "stage_verify"]);
  assert.match(hint, /REPAIR REQUIRED/);
  assert.match(hint, /stage_open, stage_verify/);
  assert.match(hint, /cannot be added, removed, renamed or reordered/);
});

test("an input that selects the page and is never navigated to is a note on the program", async () => {
  // A by-date archive was demonstrated on `/daily/2026-03-11` with a single
  // verify stage and no navigation; it read that page for every date. The
  // replays on the values the site offers beside the demonstrated one are
  // what catch that now; the static finding is kept with the version.
  const turns = [toolTurn(1, "write_file", { path: "capability.ts", content: source }), toolTurn(2, "run_draft")];
  const completed = await runAuthor({
    turns,
    startUrl: "https://target.test/search/cushion",
    stageRun: async () => ({ ...successfulDraft(), stageManifest: [cleanVerify] }),
  });
  assert.equal(completed.result.draft.outcome, "Success");
  assert.ok(completed.result.program.qualityNotes.some((note) => note.code === "page_selecting_input_not_navigated"), JSON.stringify(completed.result.program.qualityNotes));
});

test("a Contract-path finding of a demoted check is a note; authoring proceeds", async () => {
  // A default on a required input: a Contract defect only the quality gate names.
  const turns = [toolTurn(1, "write_file", { path: "capability.ts", content: source }), toolTurn(2, "run_draft")];
  const completed = await runAuthor({
    turns,
    stageRun: async () => successfulDraft(),
    contract: { inputSchema: { type: "object", properties: { query: { type: "string", default: "cushion" } }, required: ["query"] } },
  });
  assert.equal(completed.result.draft.outcome, "Success");
  assert.ok(completed.result.program.qualityNotes.some((note) => note.code === "default_input_must_be_optional"), JSON.stringify(completed.result.program.qualityNotes));
});

test("the capability states how the address writes an input, and the caller writes it that way", () => {
  // Production: the archive lives at /daily/2026-09-20 and the person asked for
  // 「2026年9月21号」. Nothing reconciles those in general — another site writes
  // the same day 20260921 or Sep-21-2026, in a language no table covers — so the
  // capability says which writing it needs and whoever calls it uses that.
  // Without it the input did not look like the one that chose the page, the
  // manifest had no stage that could open another day, and the published
  // capability could only read the page it was already on.
  const contract = {
    inputSchema: {
      type: "object",
      properties: { date: { type: "string", description: "日期", examples: ["2026-09-20"] } },
      required: ["date"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { heading: { type: "string" } }, required: ["heading"], additionalProperties: false },
    preconditions: [],
    successConditions: [{ type: "textTemplate", template: "{{date}}" }],
  };
  const trace = { schemaVersion: "1.0", entry: { mode: "Navigate", url: "https://archive.example/daily/2026-09-20" }, defaults: { timeoutMs: 1000, retryCount: 0 }, steps: [], result: {} };
  const options = { startUrl: "https://archive.example/daily/2026-09-20", demonstrationParameters: { date: "2026年9月20日" } };
  const manifest = author.authoringManifest(trace, contract, options);
  assert.deepEqual(manifest.stages.map((stage) => stage.id), ["stage_open", "stage_verify"], "说明了写法就该有打开地址的阶段");
  const seed = author.seedCapabilitySource(manifest, trace, contract, options);
  assert.match(seed, /daily\/\$\{encodeURIComponent\(String\(input\["date"\]\)\)\}/, "地址里替换的是地址自己的写法");
});

test("a declared writing is kept only where the page's address bears it", async () => {
  const runtime = await import("../runner/capability-v2/browser-runtime.ts");
  const url = "https://archive.example/daily/2026-09-20";
  assert.deepEqual(
    runtime.addressWrittenInputs({ addressInputs: [{ path: "date", addressValue: "2026-09-20" }] }, url, ["date"]),
    { date: "2026-09-20" },
  );
  // A writing the address does not carry is a claim about the site the site
  // does not support, so it is dropped.
  assert.deepEqual(runtime.addressWrittenInputs({ addressInputs: [{ path: "date", addressValue: "2026年9月20日" }] }, url, ["date"]), {});
  assert.deepEqual(runtime.addressWrittenInputs({ addressInputs: [{ path: "ghost", addressValue: "2026-09-20" }] }, url, ["date"]), {});
  assert.deepEqual(runtime.addressWrittenInputs({}, url, ["date"]), {});
});

test("the address writing is declared only for an input the program opens the page with", async () => {
  // A cart capability recorded from the home page: Shop, the product card,
  // the variant, Add to cart. The product page is /product/mira-pendant, so
  // the contract declared "mira-pendant"; the program reaches it by clicking
  // the card named "Mira Pendant", was self-tested with that, and every
  // validation case written as the contract said failed.
  const runtime = await import("../runner/capability-v2/browser-runtime.ts");
  const contract = {
    inputSchema: {
      type: "object",
      properties: {
        productName: { type: "string", description: "The product to add. Write it the way the page address does, for example \"mira-pendant\".", examples: ["mira-pendant"] },
        variantOption: { type: "string", description: "The finish. Write it the way the example is written, for example \"Smoke glass\".", examples: ["Smoke glass"] },
      },
      required: ["productName", "variantOption"],
    },
    outputSchema: { type: "object", properties: { targetTitle: { type: "string" } }, required: ["targetTitle"] },
    successConditions: [{ type: "outputExists", path: "targetTitle" }],
  };
  const demonstrated = { productName: "Mira Pendant", variantOption: "Smoke glass" };
  const trace = { entry: { url: "https://shop.example/" }, steps: [
    { id: "shop", action: "click", target: { strategies: [{ kind: "role", role: "link", name: "Shop" }] } },
    { id: "card", action: "click", target: { strategies: [{ kind: "role", role: "link", name: "Mira Pendant" }] } },
  ] };
  const opened = author.addressOpenedInputs(trace, contract, { startUrl: "https://shop.example/", demonstrationParameters: demonstrated });
  assert.deepEqual(opened, []);
  const aligned = runtime.contractInProgramWritings(contract, opened, demonstrated);
  assert.deepEqual(aligned.inputSchema.properties.productName.examples, ["Mira Pendant"]);
  assert.equal(aligned.inputSchema.properties.productName.description, "The product to add. Write it the way the example is written, for example \"Mira Pendant\".");
  assert.deepEqual(aligned.inputSchema.properties.variantOption, contract.inputSchema.properties.variantOption);

  // A program that opens /product/<productName> by address keeps the address writing.
  const navigating = { entry: { url: "https://shop.example/" }, steps: [
    { id: "open", action: "navigate", value: { source: "literal", value: "https://shop.example/product/mira-pendant" } },
  ] };
  const openedByAddress = author.addressOpenedInputs(navigating, contract, { startUrl: "https://shop.example/", demonstrationParameters: demonstrated });
  assert.deepEqual(openedByAddress, ["productName"]);
  assert.equal(runtime.contractInProgramWritings(contract, openedByAddress, demonstrated), contract);
});

test("a site-global capability is replayed from the site's own entry", async () => {
  // The by-date archive was replayed on the very day page it had been built
  // from. It read that page without moving, passed, and then could do nothing
  // when a person asked for another day from the home page: the requirement to
  // navigate had never been tested. A capability that says it can be called
  // from anywhere on the site is replayed from where a caller would be.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../runner/capability-v2/process-runner.ts", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("const explored ="), source.indexOf("if (startUrl) {"));
  assert.match(block, /scope\?\.kind === "site-global"/, "按契约声明的适用范围决定起点");
  assert.match(block, /new URL\(explored!\)\.origin/, "站内任意页面可用的能力,从站点根地址回放");
  assert.doesNotMatch(block.slice(block.indexOf("const startUrl")), /spec\.browser\.startUrl \|\| spec\.input/, "不再直接用探索结束的地址");
  // A capability bound to a page is validated from that page, ahead of the
  // entry its program was published with: the Contract's resolution is read first.
  assert.ok(block.indexOf("resolveCapabilityRun(candidate.contract") >= 0 && block.indexOf("resolveCapabilityRun(candidate.contract") < block.indexOf("program.entry.mode"), "the Contract's page comes first");
});
