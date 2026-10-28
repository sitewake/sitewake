// Follows the capability generation a visitor run set off: finds the
// generation task that names the run, then waits for the pipeline to reach a
// terminal state, and reports what it produced.
//
//   node scripts/benchmark/follow.mjs --site <slug> --run <runId> [--appear <min>] [--timeout <min>]
import { ConsoleClient, CONSOLE_URL, loadSites, log, parseFlags, readState, sleep } from "./lib.mjs";

const TERMINAL = /^(Published|AlreadyPublished|Failed|Cancelled|Superseded|Rejected|Done)$/i;

/** Admin requests carry the site id in a header; the management cookie authorises them. */
export function adminClient(siteId, cookie = readState().consoleCookie || "") {
  const client = new ConsoleClient(CONSOLE_URL, cookie);
  const base = client.request.bind(client);
  client.request = (path, init = {}) => base(path, { ...init, headers: { "x-sitewake-site-id": siteId, ...(init.headers || {}) } });
  return client;
}

export async function listTasks(client) {
  const payload = await client.json("/api/admin/capability-v2/tasks?includeArchived=1&includeDeleted=1");
  return { tasks: payload.tasks || [], progress: payload.progress || {} };
}

/**
 * Resolves to `{ state, code, phase, generationTaskId, validationTaskId,
 * capabilityId, versionId, elapsedMs }`. `state` is the pipeline's terminal
 * state, or `not-generated` when no task named the run in time, or
 * `timed-out` when the pipeline did not finish in time.
 */
export async function followGeneration(client, { runId, appearTimeoutMs = 3 * 60_000, finishTimeoutMs = 20 * 60_000, onEvent } = {}) {
  const started = Date.now();
  let generation;
  while (!generation && Date.now() - started < appearTimeoutMs) {
    const { tasks } = await listTasks(client).catch(() => ({ tasks: [] }));
    generation = tasks.find((task) => task.type === "Discovery" && task.sourceAgentRunId === runId);
    if (!generation) await sleep(10_000);
  }
  if (!generation) return { state: "not-generated", elapsedMs: Date.now() - started };
  onEvent?.(`generation task ${generation.id.slice(0, 8)} for run ${runId.slice(0, 12)}`);
  let last = "";
  let progress = {};
  while (Date.now() - started < finishTimeoutMs) {
    progress = (await client.json(`/api/admin/capability-v2/tasks/${generation.id}/progress`).catch(() => ({}))).progress || {};
    const line = `${progress.phase || "?"} ${progress.state || "?"}${progress.code ? ` ${progress.code}` : ""}`;
    if (line !== last) { onEvent?.(line); last = line; }
    if (TERMINAL.test(String(progress.state || ""))) break;
    await sleep(15_000);
  }
  const task = (await client.json(`/api/admin/capability-v2/tasks/${generation.id}`).catch(() => ({}))).task || generation;
  const validationTaskId = task.result?.validationTaskId || progress.nextTaskId;
  let capabilityId = task.result?.capabilityId;
  let versionId = task.result?.versionId;
  if (validationTaskId) {
    const validation = (await client.json(`/api/admin/capability-v2/tasks/${validationTaskId}`).catch(() => ({}))).task;
    capabilityId = validation?.result?.capabilityId || capabilityId;
    versionId = validation?.result?.versionId || versionId;
  }
  return {
    state: TERMINAL.test(String(progress.state || "")) ? progress.state : "timed-out",
    phase: progress.phase,
    code: progress.code || task.error?.code,
    message: task.error?.message,
    // What the wrapper code ended on: the runner keeps the raw cause with the error.
    cause: task.error?.cause ? { code: task.error.cause.code, message: String(task.error.cause.message || "").slice(0, 300) } : undefined,
    failureClass: progress.failureClass || task.error?.failureClass,
    failureStage: progress.failureStage || task.error?.failureStage,
    generationTaskId: generation.id,
    validationTaskId,
    capabilityId,
    versionId,
    elapsedMs: Date.now() - started,
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const flags = parseFlags();
  const site = loadSites({ configuredOnly: true }).find((item) => item.slug === flags.site);
  if (!site || typeof flags.run !== "string") { console.error("--site <slug> and --run <runId> are required"); process.exit(1); }
  const result = await followGeneration(adminClient(site.id), {
    runId: flags.run,
    appearTimeoutMs: Number(flags.appear || 3) * 60_000,
    finishTimeoutMs: Number(flags.timeout || 20) * 60_000,
    onEvent: (line) => log(line),
  });
  console.log(JSON.stringify(result, null, 2));
}
