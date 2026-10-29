import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

async function load(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const stageIO = await load("../lib/capability-center-v2/stage-io.ts");

const manifest = (overrides = {}) => ({
  id: "stage_test",
  title: "Test",
  purpose: "Test",
  effect: "write",
  resumePolicy: "reconcile-before-retry",
  io: { reads: { input: ["query"], state: ["targets.query"] }, writes: { state: ["targets.query"], output: ["result"] } },
  navigation: "optional",
  ...overrides,
});

test("Stage I/O normalization is deterministic and deduplicated", () => {
  assert.deepEqual(stageIO.normalizeCapabilityStageIO({
    reads: { input: [" query", "query", "targets"], state: ["targets.query"] },
    writes: { state: ["targets.query", "targets.query"], output: ["z", "a"] },
  }), {
    reads: { input: ["query", "targets"], state: ["targets.query"] },
    writes: { state: ["targets.query"], output: ["a", "z"] },
  });
});

test("undeclared state/output writes are rejected at the Stage boundary", () => {
  assert.throws(
    () => stageIO.assertCapabilityStageResultIO(manifest(), { outcome: "Continue", state: { secret: true } }, "stage_test"),
    /capability_stage_state_write_undeclared:stage_test:secret/,
  );
  assert.throws(
    () => stageIO.assertCapabilityStageResultIO(manifest(), { outcome: "Success", output: { result: { ok: true }, extra: true } }, "stage_test"),
    /capability_stage_output_write_undeclared:stage_test:extra/,
  );
});

test("empty output is a zero-write payload for Contracts without output fields", () => {
  assert.doesNotThrow(() => stageIO.assertCapabilityStageResultIO(
    manifest({ io: { reads: { input: [], state: [] }, writes: { state: [], output: [] } } }),
    { outcome: "Success", output: {} },
    "stage_test",
  ));
});

test("undeclared input/state reads fail instead of becoming silent undefined values", () => {
  const input = stageIO.capabilityScopedJson({ query: "notebook", hidden: "must-not-read" }, ["query"], "input", "stage_test");
  assert.equal(input.query, "notebook");
  assert.throws(() => input.hidden, /capability_stage_input_read_undeclared:stage_test:hidden/);

  const state = stageIO.capabilityScopedJson({ targets: { query: "notebook", secret: "must-not-read" } }, ["targets.query"], "state", "stage_test");
  assert.equal(state.targets.query, "notebook");
  assert.throws(() => state.targets.secret, /capability_stage_state_read_undeclared:stage_test:targets.secret/);
});

test("navigation is optional/required by manifest and only same-origin _self intents are valid", () => {
  assert.throws(
    () => stageIO.assertCapabilityStageResultIO(manifest({ navigation: "none" }), { outcome: "Continue", navigation: { url: "/next", target: "_self" } }, "stage_test"),
    /capability_stage_navigation_forbidden:stage_test/,
  );
  assert.throws(
    () => stageIO.assertCapabilityStageResultIO(manifest({ navigation: "required" }), { outcome: "Continue" }, "stage_test"),
    /capability_stage_navigation_required:stage_test/,
  );
  assert.throws(
    () => stageIO.assertCapabilityStageResultIO(manifest(), { outcome: "Success", output: { result: true }, navigation: { url: "/done", target: "_self" } }, "stage_test"),
    /capability_navigation_terminal_outcome:stage_test/,
  );
  assert.equal(stageIO.assertCapabilityNavigationUrl("https://target.test/start", { url: "/next", target: "_self" }, "stage_test"), "https://target.test/next");
  assert.throws(
    () => stageIO.assertCapabilityNavigationUrl("https://target.test/start", { url: "https://other.test/next", target: "_self" }, "stage_test"),
    /capability_navigation_origin_invalid:stage_test/,
  );
});

test("settle waits for an in-place update and gives up on a page that never goes quiet", async () => {
  const sdk = await load("../lib/capability-center-v2/browser-stage-sdk.ts");
  const makeDocument = (readText, readNodeCount = () => 10) => ({
    body: { get innerText() { return readText(); } },
    querySelectorAll: () => ({ length: readNodeCount() }),
  });
  const originals = { document: globalThis.document, location: globalThis.location };
  try {
    // A drawer that finishes painting: settle returns once the document stops changing.
    let growing = "a";
    const timer = setInterval(() => { growing += "a"; }, 20);
    setTimeout(() => clearInterval(timer), 200);
    globalThis.document = makeDocument(() => growing);
    globalThis.location = { href: "https://example.test/" };
    let settled;
    const stage = {
      id: "stage_1",
      io: { reads: { input: [], state: [] }, writes: { state: [], output: [] } },
      navigation: "none",
      async run({ settle }) {
        const startedAt = Date.now();
        await settle(120, 3_000);
        settled = Date.now() - startedAt;
        return { outcome: "Success", output: {} };
      },
    };
    const result = await sdk.executeBrowserCapabilityStage({ run: stage.run, input: {}, state: {}, inputPaths: [], statePaths: [], stageId: "stage_1", deadlineAt: new Date(Date.now() + 30_000).toISOString() });
    assert.equal(result.outcome, "Success");
    assert.ok(settled >= 120, `settle waited for quiet, took ${settled}ms`);
    assert.ok(settled < 2_000, `settle returned once quiet, took ${settled}ms`);

    // A ticking clock does not disturb settle: the shape is the text length,
    // the node count and the URL, and a clock changes none of them.
    globalThis.document = makeDocument(() => new Date().toISOString());
    let ticked;
    const clock = { ...stage, async run({ settle }) { const startedAt = Date.now(); await settle(120, 3_000); ticked = Date.now() - startedAt; return { outcome: "Success", output: {} }; } };
    await sdk.executeBrowserCapabilityStage({ run: clock.run, input: {}, state: {}, inputPaths: [], statePaths: [], stageId: "stage_1", deadlineAt: new Date(Date.now() + 30_000).toISOString() });
    assert.ok(ticked < 1_000, `a clock alone must not keep settle waiting, took ${ticked}ms`);

    // A page that really never stops changing: settle must still return, at its cap.
    let nodes = 0;
    globalThis.document = makeDocument(() => "steady", () => (nodes += 1));
    let capped;
    const ticking = { ...stage, async run({ settle }) { const startedAt = Date.now(); await settle(200, 400); capped = Date.now() - startedAt; return { outcome: "Success", output: {} }; } };
    const second = await sdk.executeBrowserCapabilityStage({ run: ticking.run, input: {}, state: {}, inputPaths: [], statePaths: [], stageId: "stage_1", deadlineAt: new Date(Date.now() + 30_000).toISOString() });
    assert.equal(second.outcome, "Success", "a page that never settles must not fail the capability");
    assert.ok(capped >= 350 && capped < 1_500, `settle gave up at its cap, took ${capped}ms`);
  } finally {
    globalThis.document = originals.document;
    globalThis.location = originals.location;
  }
});

test("identityMatches compares an acted-on card with a result title the way modules kept getting wrong", async () => {
  const sdk = await load("../lib/capability-center-v2/browser-stage-sdk.ts");
  const checks = [];
  const stage = {
    async run({ identityMatches }) {
      // The two production rejections: a card blob against the dialog's title.
      checks.push(["card blob vs title", identityMatches("3 卫星互联网低轨26组卫星成功发射 95.7万 微博 2小时", "卫星互联网低轨26组卫星成功发射")]);
      checks.push(["emoji in the card", identityMatches("腾讯龙虾宣布停运\n😔", "腾讯龙虾宣布停运")]);
      checks.push(["title carries the emoji", identityMatches("腾讯龙虾宣布停运", "腾讯龙虾宣布停运 😔")]);
      checks.push(["multi-line card", identityMatches("3\n卫星互联网低轨26组卫星成功发射\n95.7万", "卫星互联网低轨26组卫星成功发射")]);
      checks.push(["whitespace and width differences", identityMatches("Ａdd  to\tcart", "Add to cart")]);
      // A card cuts a long title short; the product page shows the whole of it.
      checks.push(["card title cut with an ellipsis", identityMatches("A Light in the ...", "A Light in the Attic")]);
      checks.push(["card title cut with the ellipsis character", identityMatches("Sapiens: A Brief History…\n£54.23", "Sapiens: A Brief History of Humankind")]);
      checks.push(["a cut title of another book", identityMatches("A Light in the ...", "Tipping the Velvet")]);
      // A different record must not match.
      checks.push(["different topic", identityMatches("3 卫星互联网低轨26组卫星成功发射 95.7万", "特朗普抵达机场")]);
      // Nothing of substance proves nothing.
      checks.push(["one character", identityMatches("3 卫星互联网低轨26组卫星成功发射", "3")]);
      checks.push(["empty candidate", identityMatches("卫星互联网", "")]);
      checks.push(["nothing acted on", identityMatches(undefined, "卫星互联网低轨26组卫星成功发射")]);
      return { outcome: "Success", output: {} };
    },
  };
  const result = await sdk.executeBrowserCapabilityStage({ run: stage.run, input: {}, state: {}, inputPaths: [], statePaths: [], stageId: "stage_verify", deadlineAt: new Date(Date.now() + 30_000).toISOString() });
  assert.equal(result.outcome, "Success");
  assert.deepEqual(checks, [
    ["card blob vs title", true],
    ["emoji in the card", true],
    ["title carries the emoji", true],
    ["multi-line card", true],
    ["whitespace and width differences", true],
    ["card title cut with an ellipsis", true],
    ["card title cut with the ellipsis character", true],
    ["a cut title of another book", false],
    ["different topic", false],
    ["one character", false],
    ["empty candidate", false],
    ["nothing acted on", false],
  ]);
});
