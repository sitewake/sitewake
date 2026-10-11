import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Import TypeScript modules by bundling them (resolves extensionless imports and
// strips types) exactly like the existing suite does.
async function load(entry) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const workspaceMod = await load("../lib/site-knowledge/authoring-workspace.ts");
const bundlerMod = await load("../lib/site-knowledge/authoring-bundler.ts");
const gateMod = await load("../lib/site-knowledge/authoring-gate.ts");
const harnessMod = await load("../lib/site-knowledge/authoring-harness.ts");

const verifier = { success: [], noResult: [], businessRejection: [] };
const fixedClock = () => "2026-07-19T00:00:00.000Z";

// --- workspace ---------------------------------------------------------------

test("workspace rejects path traversal, absolute paths and disallowed extensions", () => {
  const { normalizeVfsPath, WorkspacePathError } = workspaceMod;
  assert.equal(normalizeVfsPath("./capability.ts"), "capability.ts");
  assert.equal(normalizeVfsPath("fixtures.json"), "fixtures.json");
  for (const bad of ["lib/extract.ts", "../secrets.ts", "/etc/passwd", "lib\\win.ts", "a/../../b.ts", "run.sh", "noext"]) {
    assert.throws(() => normalizeVfsPath(bad), WorkspacePathError, `expected ${bad} to throw`);
  }
});

test("workspace write/read/delete enforce the entry guard and size limits", () => {
  const { AuthoringWorkspace, WORKSPACE_LIMITS } = workspaceMod;
  const ws = new AuthoringWorkspace([], fixedClock);
  ws.write("capability.ts", "export const capability={version:1,stages:[]};");
  assert.equal(ws.read("capability.ts").includes("capability"), true);
  ws.write("fixtures.json", `{ "cases": [] }`);
  assert.equal(ws.list().length, 2);
  assert.throws(() => ws.delete("capability.ts"), /entry/);
  assert.equal(ws.delete("fixtures.json"), true);
  assert.throws(() => ws.write("fixtures.json", "x".repeat(WORKSPACE_LIMITS.maxFileBytes + 1)), /exceeds/);
});

test("workspace hash is deterministic and independent of insertion order", async () => {
  const { AuthoringWorkspace, workspaceHash } = workspaceMod;
  const a = new AuthoringWorkspace([], fixedClock);
  a.write("capability.ts", "A");
  a.write("fixtures.json", "B");
  const b = new AuthoringWorkspace([], fixedClock);
  b.write("fixtures.json", "B");
  b.write("capability.ts", "A");
  assert.equal((await a.snapshot()).hash, (await b.snapshot()).hash);
  const different = await workspaceHash([{ path: "capability.ts", content: "A2", updatedAt: "x" }]);
  assert.notEqual(different, (await a.snapshot()).hash);
});

// --- bundler -----------------------------------------------------------------

test("bundler produces one browser module that exports capability stages", async () => {
  const { bundleWorkspace, validateProgramModuleSource } = bundlerMod;
  const files = [
    { path: "capability.ts", content: `export const capability={version:1,stages:[{id:"extract",run({input}){return {output:{title:input.q+"!"}}}}]};`, updatedAt: "t" },
    { path: "fixtures.json", content: `{ "cases": [] }`, updatedAt: "t" },
  ];
  const bundled = await bundleWorkspace(files, { build });
  assert.equal(bundled.ok, true, JSON.stringify(bundled));
  assert.equal(validateProgramModuleSource(bundled.source).ok, true);
  const mod = await import(`data:text/javascript;base64,${Buffer.from(bundled.source).toString("base64")}`);
  const result = await mod.capability.stages[0].run({ input: { q: "hi" }, state: {} });
  assert.deepEqual(result, { output: { title: "hi!" } });
});

test("bundler rejects bare imports and missing entry (RCE surface stays closed)", async () => {
  const { bundleWorkspace } = bundlerMod;
  const bare = await bundleWorkspace([{ path: "capability.ts", content: `import fs from "node:fs";\nexport const capability={version:1,stages:[{id:"x",run(){return {output:{x:fs.readFileSync("x")}}}}]};`, updatedAt: "t" }], { build });
  assert.equal(bare.ok, false);
  assert.equal(bare.code, "bundle_failed");
  const missing = await bundleWorkspace([{ path: "fixtures.json", content: `{ "cases": [] }`, updatedAt: "t" }], { build });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "entry_missing");
});

test("module validator mirrors the store envelope", () => {
  const { validateProgramModuleSource, MAX_MODULE_BYTES } = bundlerMod;
  assert.equal(validateProgramModuleSource("export const capability={version:1,stages:[]}").ok, true);
  assert.equal(validateProgramModuleSource("const capability={}; export { capability };").ok, true);
  assert.equal(validateProgramModuleSource("export const x = 1;").code, "program_module_export_missing");
  assert.equal(validateProgramModuleSource("export const capability=eval('x')").code, "program_module_unsafe_dynamic_code");
  assert.equal(validateProgramModuleSource("export const capability={}\n" + "//" + "x".repeat(MAX_MODULE_BYTES)).code, "program_module_too_large");
});

// --- gate --------------------------------------------------------------------

test("fixtures parser validates shape and reports stable error codes", () => {
  const { parseFixtures } = gateMod;
  assert.equal(parseFixtures("{ not json").code, "fixtures_invalid_json");
  assert.equal(parseFixtures(`{ "cases": {} }`).code, "fixtures_shape");
  assert.equal(parseFixtures(`{ "cases": [{ "id": "a" }, { "id": "a" }] }`).code, "fixtures_duplicate_id");
  const good = parseFixtures(`{ "cases": [{ "id": "c1", "input": { "q": "x" }, "expect": { "fields": ["title"] } }] }`);
  assert.equal(good.ok, true);
  assert.equal(good.cases[0].expect.fields[0], "title");
});

test("submit gate requires green smoke tests and a successful proving run", () => {
  const { summarizeTestReport, evaluateSubmitGate } = gateMod;
  const fixtures = [{ id: "c1", input: {}, expect: { outcome: "success", fields: ["title"] } }];
  const failing = summarizeTestReport(fixtures, [{ fixtureId: "c1", outcome: "no-result", producedFieldIds: [] }]);
  const rejected = evaluateSubmitGate({ report: failing, provingRuns: [] });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.reasons.some((r) => /failing/.test(r)));
  assert.ok(rejected.reasons.some((r) => /successful proving run/.test(r)));

  const passing = summarizeTestReport(fixtures, [{ fixtureId: "c1", outcome: "success", producedFieldIds: ["title"] }]);
  const accepted = evaluateSubmitGate({ report: passing, provingRuns: [{ outcome: "success", producedFieldIds: ["title"] }] });
  assert.equal(accepted.ok, true);
});

// --- full harness loop (deterministic, model-free) ---------------------------

function fakeBridge(overrides = {}) {
  return {
    async getDom() { return { snapshotId: "s1", url: "https://shop.test/", kind: "semantic", content: "search box + results" }; },
    async executeJs() { return { url: "https://shop.test/", transition: "none" }; },
    async runDraft({ runId }) { return { fixtureId: "", runId, outcome: "success", producedFieldIds: ["title", "price"], producedValues: { title: "Headphones", price: "99" } }; },
    ...overrides,
  };
}

const CAPABILITY_SRC = `export const capability={version:1,stages:[{id:"extract",run(){return {output:{title:"x",price:"1"}}}}]};`;
const FIXTURES_SRC = `{ "cases": [{ "id": "c1", "input": { "q": "headphones" }, "expect": { "outcome": "success", "fields": ["title", "price"] } }] }`;

test("a correct FakeDriver session proves the flow: write -> test -> submit succeeds", async () => {
  const { FakeDriver, runAuthoringSession } = harnessMod;
  const events = [];
  const driver = new FakeDriver([
    { tool: "get_dom" },
    { tool: "write_file", path: "capability.ts", content: CAPABILITY_SRC },
    { tool: "write_file", path: "fixtures.json", content: FIXTURES_SRC },
    { tool: "run_tests" },
    { tool: "submit" },
  ]);
  const result = await runAuthoringSession(driver, { goal: "search products", coreFieldIds: ["title", "price"] }, {
    build,
    bridge: fakeBridge(),
    persistModule: async (source) => ({ contentHash: "a".repeat(64), moduleUrl: "/programs/a.js", exportName: "capability", _len: source.length }),
    verifier,
    coreFieldIds: ["title", "price"],
    now: fixedClock,
    onEvent: (event) => events.push(event.phase),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.kind, "fake");
  assert.equal(result.implementation.kind, "module");
  assert.equal(result.implementation.proof.codingAgent, "fake");
  assert.ok(result.implementation.proof.workspaceHash);
  assert.equal(result.implementation.proof.provingRuns.length >= 1, true);
  assert.equal(result.report.failed, 0);
  assert.ok(events.includes("completed"));
});

test("submit is blocked when the capability never produced a successful run", async () => {
  const { FakeDriver, runAuthoringSession } = harnessMod;
  const driver = new FakeDriver([
    { tool: "write_file", path: "capability.ts", content: CAPABILITY_SRC },
    { tool: "write_file", path: "fixtures.json", content: FIXTURES_SRC },
    { tool: "submit" },
  ]);
  const result = await runAuthoringSession(driver, { goal: "search", coreFieldIds: ["title", "price"] }, {
    build,
    bridge: fakeBridge({ async runDraft({ runId }) { return { fixtureId: "", runId, outcome: "no-result", producedFieldIds: [], error: "no results row" }; } }),
    persistModule: async () => ({ contentHash: "b".repeat(64), moduleUrl: "/programs/b.js", exportName: "capability" }),
    verifier,
    coreFieldIds: ["title", "price"],
    now: fixedClock,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "no_submit");
});

test("bundle failures surface as structured tool errors, not thrown flow bugs", async () => {
  const { AuthoringHarness } = harnessMod;
  const harness = new AuthoringHarness({ goal: "x", coreFieldIds: [] }, { build, bridge: fakeBridge(), persistModule: async () => ({ contentHash: "c".repeat(64), moduleUrl: "/programs/c.js", exportName: "capability" }), verifier, now: fixedClock });
  harness.writeFile("capability.ts", `import x from "node:crypto";\nexport const capability={version:1,stages:[{id:"x",run(){return {output:{x:x.randomUUID()}}}}]};`);
  const run = await harness.runDraft({ q: "x" });
  assert.equal(run.ok, false);
  assert.equal(run.code, "bundle_failed");
  assert.ok(Array.isArray(run.diagnostics));
});
