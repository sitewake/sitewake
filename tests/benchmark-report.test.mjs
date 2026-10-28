import assert from "node:assert/strict";
import test from "node:test";
import { buildReport, renderMarkdown } from "../scripts/benchmark/report.mjs";
import { compareReports } from "../scripts/benchmark/compare.mjs";

const run = (overrides) => ({ runId: "r1", startedAt: "2026-10-28T00:00:00.000Z", finishedAt: "2026-10-28T01:00:00.000Z", build: "abc123", model: "m", taskSetVersion: "1", ...overrides });

const records = [
  { taskId: "a", site: "s", phase: "first", pass: true, fact: { status: "completed", outcomeCode: "agent_completed", pageCount: 3 } },
  { taskId: "a", site: "s", phase: "generation", pass: true, generation: { state: "Published", capabilityId: "cap_a" } },
  { taskId: "a", site: "s", phase: "reuse", pass: true, fact: { status: "completed", capabilityUsed: true } },
  { taskId: "b", site: "s", phase: "first", pass: false, detail: "missing: 19", fact: { status: "completed", outcomeCode: "agent_completed" }, drive: {} },
  { taskId: "c", site: "s", phase: "first", pass: true, fact: { status: "completed", pageCount: 2 } },
  { taskId: "c", site: "s", phase: "generation", pass: false, generation: { state: "Failed", phase: "Validation", code: "noresult", message: "validation_no_case_produced_a_result" } },
  { taskId: "d", site: "s", phase: "first", pass: false, harness: true, detail: "driver error: site down" },
  { taskId: "e", site: "s", phase: "first", pass: false, fact: { status: "failed", outcomeCode: "agent_runtime_start_failed" }, drive: { consoleErrors: ["Failed to load resource: 409 ()"] } },
];

test("the report counts each rate over the asks that count, and leaves harness faults out of the denominators", () => {
  const report = buildReport(run({ records }));
  assert.deepEqual(report.rates.firstAsk, { numerator: 2, denominator: 4 }, "d is a harness fault and is not counted");
  assert.deepEqual(report.rates.generation, { numerator: 1, denominator: 2 });
  assert.deepEqual(report.rates.reuse, { numerator: 1, denominator: 1 });
  assert.deepEqual(report.rates.visitor, { numerator: 3, denominator: 5 });
  assert.equal(report.harness.length, 1);
  assert.equal(report.passesThresholds, false);
});

test("failures are grouped by class, most frequent first, each with the ids needed to look again", () => {
  const report = buildReport(run({ records }));
  const classes = Object.fromEntries(report.classes.map((item) => [item.failureClass, item.count]));
  assert.equal(classes["wrong-answer"], 1, "a completed run with a wrong reply");
  assert.equal(classes["gate-false-reject"], 1, "a demonstrated candidate that validation refused without a result");
  assert.equal(classes["pipeline-contradiction"], 1, "a 409 while starting a capability the search offered");
  assert.ok(report.classes.every((item, index) => index === 0 || report.classes[index - 1].count >= item.count));
  const generationFailure = report.failures.find((failure) => failure.taskId === "c");
  assert.equal(generationFailure.phase, "generation");
  assert.match(generationFailure.stage, /validation/i);
  const markdown = renderMarkdown(report);
  assert.match(markdown, /\| First ask \| 2 \/ 4 \| 50% \|/);
  assert.match(markdown, /wrong-answer/);
  assert.match(markdown, /not counted/);
});

test("comparing two builds names regressions and fixes; the same build twice names instability", () => {
  const before = buildReport(run({ runId: "r1", build: "abc", records }));
  const afterRecords = records.map((record) => (record.taskId === "b" && record.phase === "first" ? { ...record, pass: true } : record.taskId === "a" && record.phase === "reuse" ? { ...record, pass: false, fact: { status: "failed", outcomeCode: "capability_stage_failed", capabilityUsed: true } } : record));
  const after = buildReport(run({ runId: "r2", build: "def", records: afterRecords }));
  const across = compareReports(before, after);
  assert.deepEqual(across.fixed.map((change) => change.id), ["b#first"]);
  assert.deepEqual(across.regressions.map((change) => change.id), ["a#reuse"]);
  assert.equal(across.regressed, true, "the reuse rate fell");
  assert.equal(across.rates.firstAsk.fell, false);
  const rerun = compareReports(before, buildReport(run({ runId: "r3", build: "abc", records: afterRecords })));
  assert.equal(rerun.sameBuild, true);
  assert.deepEqual(rerun.unstable.map((change) => change.id).sort(), ["a#reuse", "b#first"]);
  assert.equal(rerun.regressed, false, "instability on one build is not a regression");
});
