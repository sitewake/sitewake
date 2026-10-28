// Runs the benchmark: every task of every configured site, first ask →
// verdict → generation followed → reuse ask, sites one after another and
// never two asks on one site at once. Writes the report under
// .artifacts/benchmark/runs/<id>/.
//
//   npm run benchmark -- [--site <slug>] [--task <id>] [--quick] [--limit <s>] [--generation-timeout <min>] [--no-reuse] [--no-generation] [--keep-capabilities]
//
// From the host this re-runs itself inside the stack's driver container, where
// the sites and the console have their network names; BENCH_DRIVER=host runs
// it on the host against the published ports instead.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { judge } from "./check.mjs";
import { driveGoal, launchBrowser, visitorContext } from "./drive.mjs";
import { adminClient, followGeneration } from "./follow.mjs";
import { ARTIFACTS, ConsoleClient, CONSOLE_URL, ENV_FILE, IN_NETWORK, ROOT, composeArgs, log, parseFlags, readEnvFile, readState, run, siteBaseUrl, sleep } from "./lib.mjs";
import { buildReport, renderMarkdown } from "./report.mjs";
import { TASK_SET_VERSION, loadAllTaskSets } from "./tasks.mjs";

const flags = parseFlags();

if (!IN_NETWORK && process.env.BENCH_DRIVER !== "host") {
  if (!existsSync(ENV_FILE)) { console.error(`no benchmark env at ${ENV_FILE}; run npm run benchmark:up first`); process.exit(1); }
  const args = process.argv.slice(2);
  log("running inside the stack's driver container …");
  // -T: no pseudo-terminal, so the run also works from a script or CI.
  await run("docker", composeArgs("--profile", "driver", "run", "--rm", "--no-deps", "-T", "bench-driver", "scripts/benchmark/run.mjs", ...args))
    .then(() => process.exit(0), (error) => { console.error(error.message); process.exit(1); });
}

const limitMs = Number(flags.limit || 300) * 1000;
// Generations queue behind one another on the stack, so the wait covers the queue as well as the work.
const generationTimeoutMs = Number(flags["generation-timeout"] || 30) * 60_000;
const quick = flags.quick ? new Set(JSON.parse(readFileSync(join(ROOT, "benchmark", "quick.json"), "utf8"))) : undefined;
const { sets, skipped } = loadAllTaskSets({ slug: flags.site });
const invalid = sets.filter((set) => set.errors.length);
if (invalid.length) { for (const set of invalid) console.error(set.errors.join("\n")); process.exit(1); }
const plan = sets.map((set) => ({ ...set, tasks: set.tasks.filter((task) => (!flags.task || task.id === flags.task) && (!quick || quick.has(task.id))) })).filter((set) => set.tasks.length);
if (!plan.length) { console.error("no tasks selected"); process.exit(1); }

const runId = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
const outDir = join(ARTIFACTS, "runs", runId);
mkdirSync(outDir, { recursive: true });
const state = readState();
const console_ = new ConsoleClient(CONSOLE_URL, state.consoleCookie || "");
const status = await console_.json("/api/system/status").catch(() => ({}));
const modelSettings = await console_.json("/api/system/model").catch(() => ({}));
const env = readEnvFile();
const build = status.build && status.build !== "development" ? status.build : state.buildSha || "unknown";
const model = modelSettings.model || modelSettings.settings?.model || env.MODEL || process.env.MODEL || "unknown";
const startedAt = new Date().toISOString();
const records = [];
const notes = [...skipped];
const save = () => writeFileSync(join(outDir, "results.json"), JSON.stringify({ runId, startedAt, build, model, taskSetVersion: TASK_SET_VERSION, records }, null, 2));
log(`benchmark ${runId}: ${plan.reduce((sum, set) => sum + set.tasks.length, 0)} task(s) on ${plan.length} site(s); build ${build.slice(0, 12)}; model ${model}`);

async function runFact(siteId, visitorRunId) {
  if (!visitorRunId) return undefined;
  // The record is written when the widget hands in its episode, which can
  // trail the end it shows the visitor by a while.
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const payload = await console_.json(`/api/site-agents/${encodeURIComponent(siteId)}/session-history/${encodeURIComponent(visitorRunId)}`).catch(() => ({}));
    const fact = payload.detail?.fact;
    if (fact && ["completed", "failed", "cancelled"].includes(fact.status)) {
      return (({ status, outcomeStatus, outcomeCode, outcomeSummary, mode, capabilityUsed, capabilityIds, pageCount, durationMs, failureCategory, failureClass, completionMethod }) =>
        ({ status, outcomeStatus, outcomeCode, outcomeSummary: String(outcomeSummary || "").slice(0, 300), mode, capabilityUsed, capabilityIds, pageCount, durationMs, failureCategory, failureClass, completionMethod }))(fact);
    }
    await sleep(5_000);
  }
  return undefined;
}

// A run that ended with "nothing to show" or a plain answer produced no
// demonstration to learn from; only a completed run with page actions is
// expected to generate.
// Only a successful run that moved through the site leaves an Experience to
// generate from; a one-page answer, a no-result or a failure does not, and
// neither does a run a published capability already served.
const hadPageActions = (fact) => Boolean(fact && fact.status === "completed" && fact.outcomeStatus === "success" && (fact.pageCount ?? 0) > 1 && !fact.capabilityUsed);

async function ask(browser, site, task, phase) {
  const spec = phase === "reuse" ? task.reuse : task;
  const siteBase = siteBaseUrl(site);
  const record = { taskId: task.id, site: site.slug, phase, pass: false, repro: { site: site.slug, startUrl: task.startUrl, goal: spec.goal, locale: task.locale } };
  const context = await visitorContext(browser, { locale: task.locale, siteId: site.id });
  try {
    log(`▶ ${task.id} [${phase}] ${spec.goal}`);
    const drive = await driveGoal({ context, siteBase, startUrl: task.startUrl, goal: spec.goal, limitMs, onLine: (line) => log(`   ${line}`) });
    record.runId = drive.runId;
    record.drive = { seconds: drive.seconds, timedOut: drive.timedOut, outcome: drive.outcome, finalStatus: drive.finalStatus, navigations: drive.navigations.slice(-6), consoleErrors: drive.consoleErrors.slice(0, 6), httpErrors: drive.httpErrors.slice(0, 8), answer: drive.answer.slice(0, 1200) };
    if (drive.outcome === "widget_missing") { record.detail = "the widget did not appear"; return record; }
    const verdict = await judge(spec.expect, { answer: drive.answer, context, siteBase });
    record.detail = verdict.detail;
    record.observed = verdict.observed;
    record.fact = await runFact(site.id, drive.runId);
    record.pass = verdict.pass && (phase !== "reuse" || record.fact?.capabilityUsed === true);
    if (phase === "reuse" && verdict.pass && record.fact?.capabilityUsed !== true) record.detail = `${verdict.detail}; the capability was not used (${record.fact?.outcomeCode || "no run record"})`;
    log(`${record.pass ? "✓" : "✗"} ${task.id} [${phase}] ${record.detail} (${drive.seconds}s, ${record.fact?.outcomeCode || drive.outcome})`);
    return record;
  } catch (error) {
    record.harness = true;
    record.detail = `driver error: ${error.message.slice(0, 300)}`;
    log(`! ${task.id} [${phase}] ${record.detail}`);
    return record;
  } finally {
    await context.close().catch(() => undefined);
  }
}

// The stack keeps its capabilities between runs, so a run would otherwise be
// answered by what the run before it published and generate nothing. Each run
// starts from no live capability on its sites unless told to keep them.
async function disableLiveCapabilities(admin, site) {
  const payload = await admin.json("/api/admin/capability-v2/capabilities").catch(() => ({}));
  const live = (payload.capabilities || []).filter((capability) => capability.status === "Active");
  for (const capability of live) await admin.request(`/api/admin/capability-v2/capabilities/${encodeURIComponent(capability.id)}/disable`, { method: "POST", body: {} }).catch(() => undefined);
  if (live.length) log(`   ${site.slug}: ${live.length} live capabilit${live.length === 1 ? "y" : "ies"} from earlier runs disabled`);
  return live.length;
}

const browser = await launchBrowser();
try {
  for (const set of plan) {
    const site = set.site;
    const admin = adminClient(site.id, state.consoleCookie || "");
    if (!flags["keep-capabilities"]) notes.push(`${site.slug}: ${await disableLiveCapabilities(admin, site)} earlier capability(ies) disabled before the run`);
    log(`── ${site.slug} (${siteBaseUrl(site)}) — ${set.tasks.length} task(s)`);
    const follows = [];
    for (const task of set.tasks) {
      const first = await ask(browser, site, task, "first");
      records.push(first); save();
      if (flags["no-generation"] || !first.pass || !first.runId || !hadPageActions(first.fact)) continue;
      const generationRecord = { taskId: task.id, site: site.slug, phase: "generation", pass: false, runId: first.runId, repro: first.repro };
      records.push(generationRecord); save();
      follows.push({ task, record: generationRecord, promise: followGeneration(admin, { runId: first.runId, siteId: site.id, finishTimeoutMs: generationTimeoutMs, onEvent: (line) => log(`   ⟳ ${task.id}: ${line}`) }) });
    }
    for (const follow of follows) {
      const generation = await follow.promise.catch((error) => ({ state: "error", message: error.message }));
      follow.record.generation = generation;
      follow.record.pass = /^(Published|AlreadyPublished)$/i.test(generation.state || "");
      const intake = generation.intake ? ` (intake ${generation.intake.status}${generation.intake.attempts ? ` ×${generation.intake.attempts}` : ""}${generation.intake.lastError ? `: ${generation.intake.lastError}` : generation.intake.reason ? `: ${generation.intake.reason}` : ""})` : "";
      follow.record.detail = follow.record.pass ? `published capability ${generation.capabilityId || ""}` : `${generation.state}${generation.code ? ` ${generation.code}` : ""}${generation.message ? `: ${String(generation.message).slice(0, 200)}` : ""}${intake}`;
      log(`${follow.record.pass ? "✓" : "✗"} ${follow.task.id} [generation] ${follow.record.detail} (${Math.round((generation.elapsedMs || 0) / 1000)}s)`);
      save();
    }
    if (!flags["no-reuse"]) {
      for (const follow of follows) {
        if (!follow.record.pass || !follow.task.reuse) continue;
        records.push(await ask(browser, site, follow.task, "reuse")); save();
      }
    }
  }
} finally {
  await browser.close().catch(() => undefined);
}

const report = buildReport({ runId, startedAt, finishedAt: new Date().toISOString(), build, model, taskSetVersion: TASK_SET_VERSION, records, notes });
writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
writeFileSync(join(outDir, "report.md"), renderMarkdown(report));
save();
log(`report: ${join(outDir, "report.md")}`);
log(`first ask ${report.rates.firstAsk.numerator}/${report.rates.firstAsk.denominator}, generation ${report.rates.generation.numerator}/${report.rates.generation.denominator}, reuse ${report.rates.reuse.numerator}/${report.rates.reuse.denominator}; failures by class: ${report.classes.map((item) => `${item.failureClass} ${item.count}`).join(", ") || "none"}`);
