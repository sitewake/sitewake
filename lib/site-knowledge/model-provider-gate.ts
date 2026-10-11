import type { ModelConfig } from "../model-config";

type Gate = {
  /** Calls in flight right now. */
  active: number;
  /** Resolvers of the calls waiting for a slot, in arrival order. */
  waiting: Array<() => void>;
  nextStartAt: number;
};

type GateRoot = typeof globalThis & {
  __SITEWAKE_MODEL_PROVIDER_GATES__?: Map<string, Gate>;
};

function gates() {
  const root = globalThis as GateRoot;
  root.__SITEWAKE_MODEL_PROVIDER_GATES__ ||= new Map();
  return root.__SITEWAKE_MODEL_PROVIDER_GATES__;
}

function envInteger(name: string, fallback: number, max: number) {
  const raw = Number(process.env[name]);
  return Number.isSafeInteger(raw) && raw >= 0 ? Math.min(raw, max) : fallback;
}

function minRequestIntervalMs() {
  return envInteger("SITEWAKE_MODEL_MIN_INTERVAL_MS", 1_500, 60_000);
}

/**
 * Which queue a call waits in.
 *
 * `interactive` is a person watching a widget; `background` is a job that can
 * take as long as it needs. They must not share a queue: authoring a
 * capability makes twenty-to-forty-second calls back to back, and every one
 * of them used to stand in front of the next thing the user typed — the
 * runtime waited, then timed out, and the reader was told the task "was
 * interrupted during startup".
 *
 * Nor are they held to the same rule. Background work is one call at a time,
 * spaced, because a runner will otherwise fill the provider by itself. A
 * person's question is not held back at all: several people asking at the same
 * moment is the product working, not a burst to smooth out, and the limit that
 * belongs to the provider account is the provider's to enforce — it answers
 * 429 with Retry-After, which the callers already honour.
 */
export type ModelProviderLane = "interactive" | "background";

function providerKey(config: Pick<ModelConfig, "baseUrl" | "model">, lane: ModelProviderLane) {
  return `${config.baseUrl.replace(/\/$/, "")}::${config.model}::${lane}`;
}

function sleep(ms: number) {
  return ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * Hold background provider calls to one at a time with spaced starts, and let
 * interactive calls through untouched. The capability runner and the page-agent
 * route can otherwise each be individually well-behaved while still producing
 * a provider-level burst.
 *
 * The callback must consume the response body before returning, so that a
 * streaming response is not counted as finished while it is still arriving.
 */
export async function withModelProviderGate<T>(
  config: Pick<ModelConfig, "baseUrl" | "model">,
  callback: () => Promise<T>,
  lane: ModelProviderLane = "background",
) {
  // Nothing stands between a person and the provider.
  if (lane === "interactive") return callback();
  const key = providerKey(config, lane);
  const gate = gates().get(key) || { active: 0, waiting: [], nextStartAt: 0 };
  gates().set(key, gate);
  if (gate.active >= 1) {
    await new Promise<void>((resolve) => gate.waiting.push(resolve));
  }
  gate.active += 1;
  try {
    await sleep(Math.max(0, gate.nextStartAt - Date.now()));
    gate.nextStartAt = Date.now() + minRequestIntervalMs();
    return await callback();
  } finally {
    gate.active -= 1;
    const next = gate.waiting.shift();
    if (next) next();
    else if (gate.active === 0 && gates().get(key) === gate) gates().delete(key);
  }
}

/** Honor an OpenAI-compatible Retry-After/reset header, with a safe cap. */
export function modelRetryAfterMs(response: Response, fallbackMs = 1_500) {
  const raw = response.headers.get("retry-after") || response.headers.get("x-ratelimit-reset-requests");
  if (!raw) return fallbackMs;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const delay = seconds > 10_000 ? seconds * 1_000 - Date.now() : seconds * 1_000;
    return Math.min(60_000, Math.max(500, delay));
  }
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.min(60_000, Math.max(500, date - Date.now())) : fallbackMs;
}

export function resetModelProviderGatesForTests() {
  const root = globalThis as GateRoot;
  delete root.__SITEWAKE_MODEL_PROVIDER_GATES__;
}
