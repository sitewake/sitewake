type RunBucket = {
  minute: number;
  requests: number;
  concurrent: number;
  lastSeenAt: number;
  lastRequestAt?: number;
  /**
   * The call currently holding this run's concurrency slot, and the means to
   * abort its upstream request. A run only ever has one real model call in
   * flight (that is what maxConcurrentPerRun=1 means): a second request for the
   * same run can only mean the browser gave up on the previous one (retry after
   * a first-byte timeout). The old call still holds the slot because the server
   * only notices once upstream returns or the 60s timeout fires. Let the
   * newcomer supersede it instead of bouncing the user's retry with a 429.
   */
  holder?: { abort: () => void; release: () => void };
};

type SiteBucket = {
  day: number;
  requests: number;
  concurrent: number;
  lastSeenAt: number;
  lastRequestAt?: number;
};

type BudgetRoot = typeof globalThis & {
  __SITEWAKE_RUNTIME_MODEL_BUDGET__?: {
    runs: Map<string, RunBucket>;
    sites: Map<string, SiteBucket>;
  };
};

export type RuntimeModelBudgetLimits = {
  maxRequestsPerRunMinute: number;
  maxRequestsPerSiteDay: number;
  maxConcurrentPerRun: number;
  /** Maximum simultaneous provider calls for one site across all runs. */
  maxConcurrentPerSite?: number;
  /** Minimum spacing between real provider calls for the same run/site. */
  minRequestIntervalMs?: number;
};

function state() {
  const root = globalThis as BudgetRoot;
  root.__SITEWAKE_RUNTIME_MODEL_BUDGET__ ||= {
    runs: new Map(),
    sites: new Map(),
  };
  return root.__SITEWAKE_RUNTIME_MODEL_BUDGET__;
}

function positiveInteger(value: number, fallback: number) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: number, fallback: number) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/** Read one budget variable. `SITEWAKE_*` is the only name that is read. */
function branded(environment: NodeJS.ProcessEnv, suffix: string) {
  return environment[`SITEWAKE_${suffix}`];
}

export function runtimeModelBudgetLimits(environment: NodeJS.ProcessEnv = process.env): RuntimeModelBudgetLimits {
  return {
    // Qwen/OpenAI-compatible providers commonly enforce a short burst limit.
    // The total AgentRun cap is 100; this per-minute guard is kept at the same
    // ceiling by default so it does not become a hidden lower task limit.
    // Concurrency and min-interval guards still prevent request bursts.
    maxRequestsPerRunMinute: positiveInteger(Number(branded(environment, "MODEL_MAX_REQUESTS_PER_RUN_MINUTE")), 100),
    maxRequestsPerSiteDay: positiveInteger(Number(branded(environment, "MODEL_MAX_REQUESTS_PER_SITE_DAY")), 10_000),
    maxConcurrentPerRun: positiveInteger(Number(branded(environment, "MODEL_MAX_CONCURRENT_PER_RUN")), 1),
    maxConcurrentPerSite: positiveInteger(Number(branded(environment, "MODEL_MAX_CONCURRENT_PER_SITE")), 1),
    minRequestIntervalMs: nonNegativeInteger(Number(branded(environment, "MODEL_MIN_INTERVAL_MS")), 1_500),
  };
}

export function acquireRuntimeModelBudget(input: {
  siteAgentId: string;
  runId: string;
  now?: number;
  limits?: RuntimeModelBudgetLimits;
  /**
   * The means to abort this call's upstream request. Registering it lets the
   * run's next call supersede this one (see RunBucket.holder); without it the old
   * behaviour stands — concurrent calls get a 429.
   */
  abort?: () => void;
}): { allowed: true; release: () => void; superseded: boolean } | { allowed: false; retryAfterSeconds: number; reason: string } {
  const now = input.now ?? Date.now();
  const limits = input.limits ?? runtimeModelBudgetLimits();
  const currentMinute = Math.floor(now / 60_000);
  const currentDay = Math.floor(now / 86_400_000);
  const buckets = state();
  const runKey = `${input.siteAgentId}:${input.runId}`;
  const run = buckets.runs.get(runKey) || { minute: currentMinute, requests: 0, concurrent: 0, lastSeenAt: now, lastRequestAt: 0 };
  const site = buckets.sites.get(input.siteAgentId) || { day: currentDay, requests: 0, concurrent: 0, lastSeenAt: now, lastRequestAt: 0 };
  if (run.minute !== currentMinute) { run.minute = currentMinute; run.requests = 0; }
  if (site.day !== currentDay) { site.day = currentDay; site.requests = 0; }
  run.lastSeenAt = now;
  site.lastSeenAt = now;
  buckets.runs.set(runKey, run);
  buckets.sites.set(input.siteAgentId, site);

  let superseded = false;
  if (run.concurrent >= limits.maxConcurrentPerRun) {
    const holder = run.holder;
    if (!holder) return { allowed: false, retryAfterSeconds: 1, reason: "run_concurrency" };
    // The browser has abandoned the previous call (it would not send another otherwise): abort it, release the slot, admit this one.
    holder.release();
    try { holder.abort(); } catch { /* 上游可能已经结束 */ }
    superseded = true;
  }
  if (site.concurrent >= (limits.maxConcurrentPerSite ?? 1)) {
    return { allowed: false, retryAfterSeconds: 1, reason: "site_concurrency" };
  }
  if (run.requests >= limits.maxRequestsPerRunMinute) {
    return { allowed: false, retryAfterSeconds: Math.max(1, 60 - Math.floor((now % 60_000) / 1000)), reason: "run_minute" };
  }
  if (site.requests >= limits.maxRequestsPerSiteDay) {
    return { allowed: false, retryAfterSeconds: Math.max(1, 86_400 - Math.floor((now % 86_400_000) / 1000)), reason: "site_day" };
  }
  const minRequestIntervalMs = Number.isFinite(limits.minRequestIntervalMs) && Number(limits.minRequestIntervalMs) > 0
    ? Number(limits.minRequestIntervalMs)
    : 0;
  const lastRequestAt = Math.max(Number(run.lastRequestAt || 0), Number(site.lastRequestAt || 0));
  const spacingRemainingMs = minRequestIntervalMs - (now - lastRequestAt);
  if (minRequestIntervalMs > 0 && lastRequestAt > 0 && spacingRemainingMs > 0) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(spacingRemainingMs / 1_000)), reason: "request_spacing" };
  }

  run.requests += 1;
  run.concurrent += 1;
  site.concurrent += 1;
  run.lastRequestAt = now;
  site.requests += 1;
  site.lastRequestAt = now;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    run.concurrent = Math.max(0, run.concurrent - 1);
    site.concurrent = Math.max(0, site.concurrent - 1);
    if (run.holder?.release === release) run.holder = undefined;
  };
  run.holder = input.abort ? { abort: input.abort, release } : undefined;
  return { allowed: true, release, superseded };
}

/**
 * Limits shared by every visitor of one site. Hitting one says another visitor
 * is mid-call, not that this request is over budget, so it waits its turn.
 */
const SHARED_SITE_LIMITS = new Set(["site_concurrency", "request_spacing"]);
/** The refusal only means "another visitor of this site is mid-call": the caller should wait its turn, not fail. */
export function isSiteTurnRefusal(reason: string) {
  return SHARED_SITE_LIMITS.has(reason);
}
/** Kept under the browser's 20s first-byte deadline for a model turn. */
export const RUNTIME_MODEL_SLOT_WAIT_MS = 15_000;

/**
 * acquireRuntimeModelBudget, queueing behind other visitors of the same site.
 *
 * The site-wide limits allow one model call at a time. Rejecting the second
 * visitor outright meant two people asking the same site something at once
 * was enough for one of them to see "the task was interrupted while
 * starting": the browser retried once after a second, while the other
 * visitor's call takes five to ten. The limit stays; the request waits for a
 * slot instead, up to a bound, and only then is refused as before.
 */
export async function waitForRuntimeModelBudget(input: Parameters<typeof acquireRuntimeModelBudget>[0] & {
  maxWaitMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}): Promise<ReturnType<typeof acquireRuntimeModelBudget>> {
  const clock = input.clock || Date.now;
  const sleep = input.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = clock() + Math.max(0, input.maxWaitMs ?? RUNTIME_MODEL_SLOT_WAIT_MS);
  for (;;) {
    const attempt = acquireRuntimeModelBudget({ ...input, now: input.now === undefined ? undefined : clock() });
    if (attempt.allowed) return attempt;
    const remaining = deadline - clock();
    if (!isSiteTurnRefusal(attempt.reason) || remaining <= 0 || input.signal?.aborted) return attempt;
    await sleep(Math.min(remaining, Math.max(100, Math.min(500, attempt.retryAfterSeconds * 1_000))));
  }
}

export function resetRuntimeModelBudgetForTests() {
  const root = globalThis as BudgetRoot;
  delete root.__SITEWAKE_RUNTIME_MODEL_BUDGET__;
}
