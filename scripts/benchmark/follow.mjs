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
/**
 * What the console's intake made of the run's experience: the outbox item
 * that should have become the generation task, with the error it last
 * stopped on. A run that produced no task in time is explained here — the
 * intake was retrying `capability_experience_authority_rejected` for hours
 * on a run whose id the redaction had mangled — or not at all.
 */
export async function intakeOf(client, siteId, runId) {
  if (!siteId) return {};
  const payload = await client.json(`/api/admin/capability-v2/experiences?siteId=${encodeURIComponent(siteId)}&runId=${encodeURIComponent(runId)}`).catch(() => ({}));
  const item = (payload.intakes || []).find((intake) => intake.runId === runId) || (payload.intakes || [])[0];
  if (!item) return { intake: { status: "none" } };
  return { intake: { status: item.status, attempts: item.attempts, lastError: item.lastError, disposition: item.disposition, reason: item.reason, taskId: item.taskId } };
}

/** Every event of a task, page by page. */
async function taskEvents(client, taskId) {
  const events = [];
  let after = 0;
  for (let page = 0; page < 50; page += 1) {
    const payload = await client.json(`/api/admin/capability-v2/tasks/${taskId}/events?afterSequence=${after}&limit=1000`).catch(() => ({}));
    const batch = payload.events || [];
    events.push(...batch);
    if (!payload.hasMore || !batch.length) break;
    after = batch.at(-1).sequence;
  }
  return events;
}

/**
 * The tasks a generation's work went through, in order: the generation, its
 * validation, the one repair a rejection may have started, and that repair's
 * validation. Each with the model calls its events record ("model turn" is
 * one authoring request).
 */
export async function generationChain(client, generation) {
  const chain = [];
  let task = generation;
  for (let hop = 0; task && hop < 6; hop += 1) {
    const events = await taskEvents(client, task.id);
    chain.push({ task, modelCalls: events.filter((event) => event.payload?.message === "model turn").length });
    const next = task.type === "Validation"
      ? events.findLast((event) => event.eventType === "RepairScheduled")?.payload?.repairTaskId
      : task.result?.validationTaskId || events.findLast((event) => event.eventType === "CandidateFrozen")?.payload?.validationTaskId;
    task = next ? (await client.json(`/api/admin/capability-v2/tasks/${next}`).catch(() => ({}))).task : undefined;
  }
  return chain;
}

export async function followGeneration(client, { runId, siteId, appearTimeoutMs = 3 * 60_000, finishTimeoutMs = 20 * 60_000, onEvent } = {}) {
  const started = Date.now();
  let generation;
  while (!generation && Date.now() - started < appearTimeoutMs) {
    const { tasks } = await listTasks(client).catch(() => ({ tasks: [] }));
    generation = tasks.find((task) => task.type === "Discovery" && task.sourceAgentRunId === runId);
    if (!generation) await sleep(10_000);
  }
  if (!generation) return { state: "not-generated", elapsedMs: Date.now() - started, ...(await intakeOf(client, siteId, runId)) };
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
  const chain = await generationChain(client, task);
  const end = chain.at(-1);
  if (end) {
    capabilityId = end.task.result?.capabilityId || capabilityId;
    versionId = end.task.result?.versionId || versionId;
  }
  return {
    // From the generation task's creation to the end of the last task of its
    // chain (validation, one repair, its validation); the model calls are the
    // authoring turns of every generation in the chain.
    durationMs: end ? Math.max(0, Date.parse(end.task.finishedAt || end.task.updatedAt) - Date.parse(task.createdAt)) : undefined,
    modelCalls: chain.reduce((sum, item) => sum + item.modelCalls, 0),
    repaired: chain.some((item) => item.task.input?.context?.__autoRepairOfTaskId),
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
