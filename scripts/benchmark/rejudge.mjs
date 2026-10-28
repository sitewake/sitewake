// Rebuilds a run's report from its recorded results with the checker, the
// attribution and the task set as they are now. A reply-judged ask is judged
// again from the reply it recorded; a site-state ask keeps its verdict (the
// site is gone); a task no longer in the set is left out. The original report
// is kept; the rebuilt one is written beside it.
//
//   node scripts/benchmark/rejudge.mjs <run-id> [<run-id> ...]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answerContains, answerMatches } from "./check.mjs";
import { ARTIFACTS, log, parseFlags } from "./lib.mjs";
import { buildReport, renderMarkdown } from "./report.mjs";
import { TASK_SET_VERSION, loadAllTaskSets } from "./tasks.mjs";

const flags = parseFlags();
if (!flags._.length) { console.error("usage: rejudge.mjs <run-id> [<run-id> ...]"); process.exit(1); }
const { sets } = loadAllTaskSets();
const tasks = new Map(sets.flatMap((set) => set.tasks.map((task) => [task.id, task])));

for (const runId of flags._) {
  const dir = join(ARTIFACTS, "runs", runId);
  const resultsPath = join(dir, "results.json");
  if (!existsSync(resultsPath)) { log(`${runId}: no results.json`); continue; }
  const results = JSON.parse(readFileSync(resultsPath, "utf8"));
  let rejudged = 0;
  let dropped = 0;
  const records = results.records.flatMap((record) => {
    const task = tasks.get(record.taskId);
    if (!task) { dropped += 1; return []; }
    if (record.harness || record.phase === "generation") return [record];
    const expect = record.phase === "reuse" ? task.reuse?.expect : task.expect;
    if (!expect || expect.type === "site-state" || typeof record.drive?.answer !== "string") return [record];
    const verdict = expect.type === "answer-contains" ? answerContains(record.drive.answer, expect.facts) : answerMatches(record.drive.answer, expect.patterns);
    const pass = verdict.pass && (record.phase !== "reuse" || record.fact?.capabilityUsed === true);
    if (pass !== record.pass) rejudged += 1;
    const detail = verdict.pass ? (expect.type === "answer-contains" ? "every fact present" : `matched /${verdict.matched}/`) : (expect.type === "answer-contains" ? `missing: ${verdict.missing.join(" | ")}` : "no pattern matched");
    return [{ ...record, pass, detail: record.phase === "reuse" && verdict.pass && !pass ? `${detail}; the capability was not used` : detail, failureClass: undefined, stage: undefined }];
  });
  const report = buildReport({
    runId: `${runId}+rejudged`, startedAt: results.startedAt, finishedAt: results.finishedAt || results.startedAt, build: results.build, model: results.model,
    taskSetVersion: TASK_SET_VERSION, records,
    notes: [`Rebuilt from ${runId} (task set v${results.taskSetVersion}) with the current checker and task set v${TASK_SET_VERSION}: ${rejudged} verdict(s) changed, ${dropped} record(s) of retired tasks left out.`],
  });
  writeFileSync(join(dir, `report.v${TASK_SET_VERSION}.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(dir, `report.v${TASK_SET_VERSION}.md`), renderMarkdown(report));
  log(`${runId}: first ${report.rates.firstAsk.numerator}/${report.rates.firstAsk.denominator}, generation ${report.rates.generation.numerator}/${report.rates.generation.denominator}, reuse ${report.rates.reuse.numerator}/${report.rates.reuse.denominator}; ${rejudged} rejudged, ${dropped} dropped → report.v${TASK_SET_VERSION}.md`);
}
