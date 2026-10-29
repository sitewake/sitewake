import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// Replay recorded production tasks through the deterministic part of the
// generation pipeline — contract hardening, the authoring manifest, the
// quality gates — with no model and no browser. Every fixture is a task that
// once failed (or succeeded) on a real site; `scripts/capability-v2-replay-record.mjs`
// records new ones from a task's engineering record. A rule change must keep
// every fixture passing before it ships.
//
// The corpus is the maintainers' own sites' task records and stays out of the
// public repository (export-ignore); a checkout without it skips this suite.

process.env.CAPABILITY_V2_AUTO_DISPATCH = "0";
delete process.env.OPENAI_API_KEY;
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./helpers/capability-v2-test-entry.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const pipeline = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const { assembleCapabilityContract, inspectContractConsistency, inspectCapabilityQuality } = pipeline;
// The authoring module pulls in esbuild for transpiling drafts; the manifest builder needs none of it.
const authorBundle = await build({
  entryPoints: [fileURLToPath(new URL("../runner/capability-v2/javascript-author.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [{
    name: "replay-test-seams",
    setup(builder) {
      builder.onResolve({ filter: /^esbuild$/ }, () => ({ path: "esbuild", namespace: "replay-test" }));
      builder.onLoad({ filter: /.*/, namespace: "replay-test" }, () => ({ contents: "export async function transform(source){return {code:String(source)}}", loader: "js" }));
    },
  }],
});
const { authoringManifest } = await import(`data:text/javascript;base64,${Buffer.from(authorBundle.outputFiles[0].text).toString("base64")}`);

const fixturesDir = new URL("./fixtures/capability-v2-replays/", import.meta.url);
const fixtures = existsSync(fixturesDir)
  ? readdirSync(fixturesDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(new URL(name, fixturesDir), "utf8")))
  : [];
const corpus = fixtures.length > 0;
if (!corpus) test("replay corpus not present in this checkout (private); nothing to replay", { skip: true }, () => {});

for (const fixture of fixtures) {
  assert.equal(fixture.schemaVersion, "capability-v2-replay.v1", fixture.name);

  if (fixture.contract) {
    test(`${fixture.name}: the frozen Contract is satisfiable (${fixture.taskId})`, () => {
      const record = fixture.contract;
      const contract = assembleCapabilityContract({
        designed: record.designed,
        parameterPlan: record.parameterPlan,
        scope: record.scope,
        output: record.output,
        evidence: record.evidence,
        completionSignals: record.completionSignals,
        startUrl: record.startUrl,
        input: record.input,
      });
      assert.deepEqual(inspectContractConsistency(contract), [], "contract invariants");
      const manifest = authoringManifest(record.explorationProgram, contract);
      assert.deepEqual(inspectContractConsistency(contract, manifest.stages), [], "contract vs Stage I/O");
      // What the model is asked to satisfy must be at least one executable predicate.
      assert.ok(contract.successConditions.length >= 1);
    });
  }

  if (fixture.candidate) {
    test(`${fixture.name}: the candidate passes the quality gate as C2/C3 judge it (${fixture.taskId})`, () => {
      const candidate = fixture.candidate;
      const report = inspectCapabilityQuality(candidate.contract, candidate.program, {
        demonstrationParameters: candidate.demonstrationParameters,
        validationCases: candidate.validationCases,
        requireIndependentCases: true,
        source: candidate.source,
        summary: candidate.summary,
      });
      assert.equal(report.valid, true, JSON.stringify(report.issues));
    });
  }
}

test("a Contract that names an output no Stage may write is rejected before authoring", { skip: !corpus }, () => {
  const fixture = fixtures.find((item) => item.name.endsWith("-undeclared-pageurl"));
  assert.ok(fixture, "the pageUrl fixture is part of the corpus");
  // The Contract this task actually froze on 2026-09-20, before the fix.
  const frozen = fixture.contract.frozen;
  assert.ok(frozen.successConditions.some((condition) => condition.type === "outputExists" && condition.path === "pageUrl"));
  const issues = inspectContractConsistency(frozen);
  assert.ok(issues.some((issue) => issue.code === "condition_output_undeclared"), JSON.stringify(issues));
  const manifest = authoringManifest(fixture.contract.explorationProgram, frozen);
  const report = inspectCapabilityQuality(frozen, { schemaVersion: "2.0", runtime: "BrowserJavaScriptStage", module: { contentHash: "x", moduleUrl: "/x", exportName: "capability" }, entry: { mode: "CurrentPage" }, ...manifest });
  assert.ok(report.notes.some((issue) => issue.code === "condition_output_undeclared"), "the quality gate records the same contradiction, as a note");
});

test("a case keyword that is site vocabulary is not a leaked demonstration value", { skip: !corpus }, () => {
  const fixture = fixtures.find((item) => item.name.endsWith("-case-vocabulary-leak"));
  assert.ok(fixture);
  const candidate = fixture.candidate;
  assert.ok(candidate.validationCases.some((input) => candidate.summary.name.includes(String(input.keyword))), "the recorded case keyword occurs in the capability name");
  // Judged against the first C2 case, as the gate once did, the candidate is rejected.
  const misjudged = inspectCapabilityQuality(candidate.contract, candidate.program, {
    demonstrationParameters: candidate.validationCases[0],
    validationCases: candidate.validationCases,
    requireIndependentCases: true,
    source: candidate.source,
    summary: candidate.summary,
  });
  assert.ok(misjudged.issues.some((issue) => issue.code === "demonstration_value_leaked"));
});
