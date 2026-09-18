import type { ModelConfig } from "../model-config";

type Gate = {
  tail: Promise<void>;
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

function minRequestIntervalMs() {
  // SITEWAKE_* is the current name; SITEWAKE_* is a deprecated fallback.
  const raw = Number(process.env.SITEWAKE_MODEL_MIN_INTERVAL_MS);
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : 1_500;
}

function providerKey(config: Pick<ModelConfig, "baseUrl" | "model">) {
  return `${config.baseUrl.replace(/\/$/, "")}::${config.model}`;
}

function sleep(ms: number) {
  return ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * Serialize real provider calls and space their start times. The capability
 * runner and the page-agent route can otherwise each be individually
 * well-behaved while still producing a provider-level burst.
 *
 * The callback must consume the response body before returning. This keeps a
 * streaming response out of the gate only when the caller explicitly chooses
 * not to use this helper for streaming transport.
 */
export async function withModelProviderGate<T>(config: Pick<ModelConfig, "baseUrl" | "model">, callback: () => Promise<T>) {
  const key = providerKey(config);
  const current = gates().get(key) || { tail: Promise.resolve(), nextStartAt: 0 };
  let release!: () => void;
  const previous = current.tail;
  current.tail = new Promise<void>((resolve) => { release = resolve; });
  const ticket = current.tail;
  gates().set(key, current);
  await previous;
  try {
    await sleep(Math.max(0, current.nextStartAt - Date.now()));
    current.nextStartAt = Date.now() + minRequestIntervalMs();
    return await callback();
  } finally {
    release();
    if (current.tail === ticket) gates().delete(key);
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
