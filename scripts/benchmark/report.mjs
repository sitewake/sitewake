// Turns a benchmark run's records into the report: three rates with their
// numerators and denominators, failures grouped by class, harness faults set
// apart, and one line per ask so two runs can be compared task by task.
import { classify } from "./classify.mjs";

const percent = (numerator, denominator) => (denominator ? `${Math.round((numerator / denominator) * 1000) / 10}%` : "n/a");

/** A record is one ask (`first`, `reuse`) or one followed generation (`generation`). */
export function buildReport({ runId, startedAt, finishedAt, build, model, taskSetVersion, records, notes = [] }) {
  const attributed = records.map((record) => (record.pass ? record : { ...record, ...classify(record) }));
  const harness = attributed.filter((record) => record.harness);
  const counted = attributed.filter((record) => !record.harness);
  const first = counted.filter((record) => record.phase === "first");
  const generation = counted.filter((record) => record.phase === "generation");
  const reuse = counted.filter((record) => record.phase === "reuse");
  const rates = {
    firstAsk: { numerator: first.filter((record) => record.pass).length, denominator: first.length },
    generation: { numerator: generation.filter((record) => record.pass).length, denominator: generation.length },
    reuse: { numerator: reuse.filter((record) => record.pass).length, denominator: reuse.length },
  };
  const visitor = { numerator: rates.firstAsk.numerator + rates.reuse.numerator, denominator: rates.firstAsk.denominator + rates.reuse.denominator };
  const failures = counted.filter((record) => !record.pass).map((record) => ({
    taskId: record.taskId, site: record.site, phase: record.phase, failureClass: record.failureClass, stage: record.stage, note: record.note,
    detail: record.detail, runId: record.runId, generationTaskId: record.generation?.generationTaskId, validationTaskId: record.generation?.validationTaskId,
    repro: record.repro,
  }));
  const byClass = {};
  for (const failure of failures) byClass[failure.failureClass] = (byClass[failure.failureClass] || 0) + 1;
  const classes = Object.entries(byClass).sort((a, b) => b[1] - a[1]).map(([failureClass, count]) => ({ failureClass, count }));
  const unclassified = byClass.unclassified || 0;
  return {
    schemaVersion: "benchmark-report.v1",
    runId, startedAt, finishedAt, build, model, taskSetVersion,
    rates: { ...rates, visitor },
    thresholds: { visitor: 0.9, generation: 0.9 },
    passesThresholds: visitor.denominator > 0 && rates.generation.denominator > 0 && visitor.numerator / visitor.denominator >= 0.9 && rates.generation.numerator / rates.generation.denominator >= 0.9,
    classes,
    unclassifiedShare: failures.length ? unclassified / failures.length : 0,
    failures,
    harness: harness.map((record) => ({ taskId: record.taskId, site: record.site, phase: record.phase, detail: record.detail, runId: record.runId })),
    items: attributed.map((record) => ({
      taskId: record.taskId, site: record.site, phase: record.phase, pass: record.pass, harness: Boolean(record.harness),
      failureClass: record.failureClass, stage: record.stage, detail: record.detail, runId: record.runId, seconds: record.drive?.seconds,
      outcomeCode: record.fact?.outcomeCode, capabilityUsed: record.fact?.capabilityUsed, generationState: record.generation?.state, capabilityId: record.generation?.capabilityId,
    })),
    notes,
  };
}

export function renderMarkdown(report) {
  const rate = (name, value) => `| ${name} | ${value.numerator} / ${value.denominator} | ${percent(value.numerator, value.denominator)} |`;
  const lines = [
    `# Capability benchmark — ${report.runId}`,
    "",
    `- Build: \`${report.build}\``,
    `- Model: ${report.model || "unknown"}`,
    `- Task set: v${report.taskSetVersion}`,
    `- Started ${report.startedAt}, finished ${report.finishedAt}`,
    `- Thresholds met: **${report.passesThresholds ? "yes" : "no"}** (visitor ≥ 90%, generation ≥ 90%)`,
    "",
    "| Rate | Passed / counted | |",
    "| --- | --- | --- |",
    rate("First ask", report.rates.firstAsk),
    rate("Generation published", report.rates.generation),
    rate("Reuse", report.rates.reuse),
    rate("Visitor (first + reuse)", report.rates.visitor),
    "",
  ];
  if (report.harness.length) {
    lines.push(`> ${report.harness.length} ask(s) failed in the benchmark itself and are not counted: ${report.harness.map((item) => `${item.taskId} (${item.phase}: ${item.detail})`).join("; ")}`, "");
  }
  lines.push("## Failures by class", "");
  if (!report.classes.length) lines.push("None.", "");
  else {
    lines.push("| Class | Count |", "| --- | --- |", ...report.classes.map((item) => `| ${item.failureClass} | ${item.count} |`), "");
    if (report.unclassifiedShare > 0.05) lines.push(`> \`unclassified\` is ${Math.round(report.unclassifiedShare * 100)}% of failures: the attribution table needs the missing codes.`, "");
    lines.push("| Task | Phase | Class | Stage | Detail | Ids |", "| --- | --- | --- | --- | --- | --- |");
    for (const failure of report.failures) {
      const ids = [failure.runId && `run ${failure.runId}`, failure.generationTaskId && `gen ${failure.generationTaskId}`, failure.validationTaskId && `val ${failure.validationTaskId}`].filter(Boolean).join(", ");
      lines.push(`| ${failure.taskId} | ${failure.phase} | ${failure.failureClass} | ${failure.stage || ""} | ${String(failure.detail || failure.note || "").replace(/\|/g, "/").slice(0, 160)} | ${ids} |`);
    }
    lines.push("");
  }
  lines.push("## Every ask", "", "| Task | Phase | Result | Outcome | Seconds | Capability |", "| --- | --- | --- | --- | --- | --- |");
  for (const item of report.items) {
    lines.push(`| ${item.taskId} | ${item.phase} | ${item.harness ? "harness" : item.pass ? "pass" : `fail (${item.failureClass})`} | ${item.outcomeCode || item.generationState || ""} | ${item.seconds ?? ""} | ${item.capabilityUsed ? "used" : item.capabilityId ? item.capabilityId.slice(0, 8) : ""} |`);
  }
  if (report.notes.length) lines.push("", "## Notes", "", ...report.notes.map((note) => `- ${note}`));
  return `${lines.join("\n")}\n`;
}
