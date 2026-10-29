// The benchmark task set: loads a site's tasks with their expectations
// resolved from truth.json, and validates every site's task file.
//
//   node scripts/benchmark/tasks.mjs --validate [--site <slug>]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadSites, parseFlags } from "./lib.mjs";

export const TASK_SET_VERSION = readFileSync(join(ROOT, "benchmark", "VERSION"), "utf8").trim();
const KINDS = new Set(["answer", "action"]);
const EXPECT_TYPES = new Set(["answer-contains", "answer-matches", "site-state"]);
const LOCALE = /^[a-z]{2}(?:-[A-Z]{2})?$/;

function lookup(truth, path) {
  return path.split(".").reduce((value, key) => (value && typeof value === "object" ? value[key] : undefined), truth);
}

/** Replaces every {{path}} with the truth value; nested templates resolve inside out. */
export function render(template, truth, missing = []) {
  let text = String(template);
  for (let pass = 0; pass < 4 && /\{\{[^{}]+\}\}/.test(text); pass += 1) {
    text = text.replace(/\{\{([^{}]+)\}\}/g, (_, path) => {
      const value = lookup(truth, path.trim());
      if (value === undefined || value === null || (typeof value === "object")) { missing.push(path.trim()); return `{{${path}}}`; }
      return String(value);
    });
  }
  return text;
}

function renderDeep(value, truth, missing) {
  if (typeof value === "string") return render(value, truth, missing);
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, truth, missing));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderDeep(item, truth, missing)]));
  return value;
}

function expectErrors(expect, where) {
  const errors = [];
  if (!expect || typeof expect !== "object") return [`${where}: expect is required`];
  if (!EXPECT_TYPES.has(expect.type)) errors.push(`${where}: expect.type must be one of ${[...EXPECT_TYPES].join(", ")}`);
  if (expect.type === "answer-contains" && !(Array.isArray(expect.facts) && expect.facts.length && expect.facts.every((fact) => typeof fact === "string" && fact.trim()))) errors.push(`${where}: expect.facts must be a non-empty list of strings`);
  if (expect.type === "answer-matches") {
    if (!(Array.isArray(expect.patterns) && expect.patterns.length)) errors.push(`${where}: expect.patterns must be a non-empty list`);
    else for (const pattern of expect.patterns) { try { new RegExp(pattern, "i"); } catch { errors.push(`${where}: expect.patterns has an invalid pattern ${JSON.stringify(pattern)}`); } }
  }
  if (expect.type === "site-state") {
    const probe = expect.probe;
    if (!probe || typeof probe !== "object") errors.push(`${where}: expect.probe is required`);
    else {
      if (typeof probe.url !== "string" || !probe.url.startsWith("/")) errors.push(`${where}: expect.probe.url must be a path`);
      if (!(probe.contains?.length || probe.count || probe.value)) errors.push(`${where}: expect.probe needs contains, count or value`);
      if (probe.count && !(typeof probe.count.selector === "string" && Number.isInteger(probe.count.equals))) errors.push(`${where}: expect.probe.count needs selector and an integer equals`);
      if (probe.value && !(typeof probe.value.selector === "string" && probe.value.equals !== undefined)) errors.push(`${where}: expect.probe.value needs selector and equals`);
    }
  }
  return errors;
}

/** The site's tasks with expectations rendered; `errors` lists what the file gets wrong. */
export function loadTaskSet(site) {
  const errors = [];
  const tasksPath = join(site.dir, "tasks.json");
  const truthPath = join(site.dir, "truth.json");
  if (!existsSync(tasksPath)) return { site, tasks: [], errors: [`${site.slug}: tasks.json missing`] };
  let raw;
  try { raw = JSON.parse(readFileSync(tasksPath, "utf8")); } catch (error) { return { site, tasks: [], errors: [`${site.slug}: tasks.json is not valid JSON (${error.message})`] }; }
  if (!Array.isArray(raw)) return { site, tasks: [], errors: [`${site.slug}: tasks.json must be an array`] };
  const truth = existsSync(truthPath) ? JSON.parse(readFileSync(truthPath, "utf8")) : undefined;
  const tasks = raw.map((task, index) => {
    const where = `${site.slug}#${task?.id || index}`;
    if (!task || typeof task !== "object") { errors.push(`${where}: task must be an object`); return undefined; }
    if (typeof task.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(task.id)) errors.push(`${where}: id must be kebab-case`);
    if (typeof task.startUrl !== "string" || !task.startUrl.startsWith("/")) errors.push(`${where}: startUrl must be a path on the site`);
    if (typeof task.goal !== "string" || !task.goal.trim()) errors.push(`${where}: goal is required`);
    if (typeof task.locale !== "string" || !LOCALE.test(task.locale)) errors.push(`${where}: locale must look like en-US`);
    if (!KINDS.has(task.kind)) errors.push(`${where}: kind must be answer or action`);
    if (typeof task.generates !== "boolean") errors.push(`${where}: generates must be true or false`);
    errors.push(...expectErrors(task.expect, where));
    if (task.kind === "action" && task.expect?.type !== "site-state") errors.push(`${where}: an action task is judged by site-state`);
    if (task.generates) {
      if (!task.reuse || typeof task.reuse.goal !== "string" || !task.reuse.goal.trim()) errors.push(`${where}: a generating task needs reuse.goal`);
      else errors.push(...expectErrors(task.reuse.expect, `${where}.reuse`));
    }
    if (!truth) { errors.push(`${where}: truth.json missing; run ${site.slug}/truth.mjs`); return { ...task, siteId: site.id, siteSlug: site.slug }; }
    const missing = [];
    const rendered = renderDeep({ goal: task.goal, expect: task.expect, reuse: task.reuse }, truth, missing);
    for (const path of [...new Set(missing)]) errors.push(`${where}: unresolved template {{${path}}} (not in truth.json)`);
    return { ...task, ...rendered, siteId: site.id, siteSlug: site.slug };
  }).filter(Boolean);
  const ids = tasks.map((task) => task.id);
  for (const id of ids.filter((value, index) => ids.indexOf(value) !== index)) errors.push(`${site.slug}: duplicate task id ${id}`);
  return { site, tasks, errors };
}

/** Every configured site's tasks; unconfigured sites are reported, not failed. */
export function loadAllTaskSets({ slug } = {}) {
  const sets = [];
  const skipped = [];
  for (const site of loadSites()) {
    if (slug && site.slug !== slug) continue;
    if (!site.configured) { skipped.push(`${site.slug}: site not configured — ${site.note || "no address"}`); continue; }
    sets.push(loadTaskSet(site));
  }
  const seen = new Map();
  for (const set of sets) for (const task of set.tasks) {
    if (seen.has(task.id)) set.errors.push(`${task.id}: id also used by ${seen.get(task.id)}`);
    seen.set(task.id, set.site.slug);
  }
  return { sets, skipped };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const flags = parseFlags();
  const { sets, skipped } = loadAllTaskSets({ slug: flags.site });
  console.log(`task set version ${TASK_SET_VERSION}`);
  let failed = 0;
  for (const set of sets) {
    if (set.errors.length) { failed += 1; console.log(`✗ ${set.site.slug}: ${set.tasks.length} task(s)`); for (const error of set.errors) console.log(`    ${error}`); }
    else console.log(`✓ ${set.site.slug}: ${set.tasks.length} task(s), ${set.tasks.filter((task) => task.generates).length} with reuse`);
  }
  for (const line of skipped) console.log(`- ${line}`);
  if (!flags.validate) console.log("(pass --validate to exit non-zero on errors)");
  process.exit(flags.validate && failed ? 1 : 0);
}
