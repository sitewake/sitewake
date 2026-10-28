// Compares two benchmark reports task by task: what got fixed, what regressed,
// what differs between two runs of the same build (unstable), and whether any
// rate fell.
//
//   node scripts/benchmark/compare.mjs <before.report.json> <after.report.json> [--fail-on-regression]
import { readFileSync } from "node:fs";
import { parseFlags } from "./lib.mjs";

const key = (item) => `${item.taskId}#${item.phase}`;
const ratio = (value) => (value.denominator ? value.numerator / value.denominator : undefined);

export function compareReports(before, after) {
  const sameBuild = before.build === after.build && before.taskSetVersion === after.taskSetVersion;
  const beforeItems = new Map(before.items.filter((item) => !item.harness).map((item) => [key(item), item]));
  const afterItems = new Map(after.items.filter((item) => !item.harness).map((item) => [key(item), item]));
  const changes = [];
  for (const [id, item] of afterItems) {
    const previous = beforeItems.get(id);
    if (!previous) { changes.push({ id, kind: "new", after: item.pass }); continue; }
    if (previous.pass === item.pass) continue;
    changes.push({
      id,
      kind: sameBuild ? "unstable" : item.pass ? "fixed" : "regressed",
      before: previous.pass, after: item.pass,
      beforeClass: previous.failureClass, afterClass: item.failureClass,
    });
  }
  for (const id of beforeItems.keys()) if (!afterItems.has(id)) changes.push({ id, kind: "gone" });
  const rates = {};
  let regressed = false;
  // A rate that had nothing to count before (no reuse ask when nothing had
  // published) is not compared: reuse beginning lowers the combined visitor
  // rate while being the improvement itself, so that rate is read on first
  // asks alone until both runs have reuse asks.
  const reuseBegan = !before.rates.reuse.denominator && after.rates.reuse.denominator > 0;
  for (const name of ["firstAsk", "generation", "reuse", "visitor"]) {
    const left = name === "visitor" && reuseBegan ? before.rates.firstAsk : before.rates[name];
    const right = name === "visitor" && reuseBegan ? after.rates.firstAsk : after.rates[name];
    const previous = ratio(left);
    const current = ratio(right);
    const fell = previous !== undefined && current !== undefined && current < previous;
    if (fell && !sameBuild) regressed = true;
    rates[name] = { before: before.rates[name], after: after.rates[name], fell, ...(name === "visitor" && reuseBegan ? { note: "reuse began in the later run; compared on first asks" } : {}) };
  }
  return {
    sameBuild,
    before: { runId: before.runId, build: before.build }, after: { runId: after.runId, build: after.build },
    rates, regressed,
    unstable: changes.filter((change) => change.kind === "unstable"),
    fixed: changes.filter((change) => change.kind === "fixed"),
    regressions: changes.filter((change) => change.kind === "regressed"),
    other: changes.filter((change) => !["unstable", "fixed", "regressed"].includes(change.kind)),
  };
}

export function renderComparison(result) {
  const percent = (value) => (value.denominator ? `${Math.round((value.numerator / value.denominator) * 1000) / 10}%` : "n/a");
  const lines = [
    `# Benchmark comparison: ${result.before.runId} → ${result.after.runId}`,
    "",
    result.sameBuild ? `Same build (\`${result.before.build}\`): differences are instability, not change.` : `Build \`${result.before.build}\` → \`${result.after.build}\`.`,
    "",
    "| Rate | Before | After | |",
    "| --- | --- | --- | --- |",
    ...Object.entries(result.rates).map(([name, value]) => `| ${name} | ${percent(value.before)} (${value.before.numerator}/${value.before.denominator}) | ${percent(value.after)} (${value.after.numerator}/${value.after.denominator}) | ${value.fell ? (result.sameBuild ? "lower this run" : "**REGRESSED**") : value.note || ""} |`),
    "",
  ];
  const list = (title, items, describe) => { if (items.length) lines.push(`## ${title}`, "", ...items.map(describe), ""); };
  list("Regressions", result.regressions, (change) => `- ${change.id}: pass → fail (${change.afterClass})`);
  list("Fixed", result.fixed, (change) => `- ${change.id}: fail (${change.beforeClass}) → pass`);
  list("Unstable", result.unstable, (change) => `- ${change.id}: ${change.before ? "pass" : `fail (${change.beforeClass})`} then ${change.after ? "pass" : `fail (${change.afterClass})`}`);
  list("Other", result.other, (change) => `- ${change.id}: ${change.kind}`);
  lines.push(result.regressed ? "**Verdict: a rate fell — this change cannot merge as it stands.**" : result.sameBuild ? "Verdict: comparable runs; unstable items above need an explanation each." : "Verdict: no rate fell.");
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const flags = parseFlags();
  const [beforePath, afterPath] = flags._;
  if (!beforePath || !afterPath) { console.error("usage: compare.mjs <before.report.json> <after.report.json> [--fail-on-regression]"); process.exit(1); }
  const result = compareReports(JSON.parse(readFileSync(beforePath, "utf8")), JSON.parse(readFileSync(afterPath, "utf8")));
  process.stdout.write(renderComparison(result));
  process.exit(flags["fail-on-regression"] && result.regressed ? 1 : 0);
}
