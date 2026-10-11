export class RunnerLeaseLostError extends Error {
  readonly code: string;

  constructor(code: string, message = code, options?: ErrorOptions) {
    super(message, options);
    this.name = "RunnerLeaseLostError";
    this.code = code;
  }
}

export function isRunnerLeaseLostError(error: unknown): error is RunnerLeaseLostError {
  return error instanceof RunnerLeaseLostError;
}

type InvalidationCleanup = () => void | Promise<void>;

/**
 * Local fail-closed guard for a server-owned Runner lease.
 *
 * The server fence remains authoritative. This guard prevents the local worker
 * from continuing browser/Codex side effects once the lease is known to be
 * unusable, or once its last known expiry passes without a successful renewal.
 */
export class RunnerLeaseGuard {
  private readonly controller = new AbortController();
  private readonly cleanups = new Set<InvalidationCleanup>();
  private readonly cleanupTasks = new Set<Promise<void>>();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private expiresAtMs = 0;

  constructor(expiresAt: string) {
    this.updateExpiry(expiresAt);
  }

  get signal() {
    return this.controller.signal;
  }

  get expiresAt() {
    return new Date(this.expiresAtMs).toISOString();
  }

  assertActive() {
    if (!this.signal.aborted) return;
    const reason = this.signal.reason;
    throw reason instanceof Error ? reason : new RunnerLeaseLostError("runner_lease_lost");
  }

  updateExpiry(expiresAt: string) {
    if (this.disposed || this.signal.aborted) return false;
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      this.invalidate(new RunnerLeaseLostError("runner_lease_expiry_invalid", "Runner lease has no usable future expiry."));
      return false;
    }
    this.expiresAtMs = expiresAtMs;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => {
      this.invalidate(new RunnerLeaseLostError("runner_lease_expired_locally", "Runner lease expired before it could be renewed."));
    }, Math.max(0, expiresAtMs - Date.now()));
    return true;
  }

  onInvalidate(cleanup: InvalidationCleanup) {
    if (this.disposed) return () => {};
    this.cleanups.add(cleanup);
    if (this.signal.aborted) this.runCleanup(cleanup);
    return () => {
      this.cleanups.delete(cleanup);
    };
  }

  invalidate(reason: RunnerLeaseLostError) {
    if (this.disposed || this.signal.aborted) return;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.controller.abort(reason);
    for (const cleanup of this.cleanups) this.runCleanup(cleanup);
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    await Promise.all([...this.cleanupTasks]);
    this.cleanups.clear();
  }

  private runCleanup(cleanup: InvalidationCleanup) {
    const task = Promise.resolve()
      .then(cleanup)
      .catch(() => undefined)
      .finally(() => {
        this.cleanupTasks.delete(task);
      });
    this.cleanupTasks.add(task);
  }
}

export function sanitizeRunnerMessage(value: string) {
  return value
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\[(?:[a-f0-9]{0,4}:){2,7}[a-f0-9]{0,4}\](?::\d+)?/gi, "[host]")
    .replace(/(?<![a-z0-9:])(?:[a-f0-9]{0,4}:){2,7}[a-f0-9]{0,4}(?![a-z0-9:])/gi, "[host]")
    .replace(/\b(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|(?=[a-z0-9-]*[a-z])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?):\d{2,5}\b/gi, "[host]")
    .replace(/\b(?:localhost|(?:\d{1,3}\.){3}\d{1,3})\b/gi, "[host]")
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, "[host]")
    .replace(/[A-Za-z]:\\[^\s]+/g, "[path]")
    .replace(/\b[A-Z][A-Z0-9_]{2,}\s*=\s*\S+/g, "[env]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export type CoalescingAsyncQueue<T> = {
  push(value: T): boolean;
  close(): Promise<void>;
  readonly buffered: number;
};

/**
 * Runs one event at a time while retaining only the newest pending event.
 * Memory is therefore bounded to one in-flight item plus one buffered item.
 */
export function createCoalescingAsyncQueue<T>(
  consume: (value: T) => Promise<void>,
  onError: (error: unknown) => void = () => {},
): CoalescingAsyncQueue<T> {
  let closed = false;
  let hasPending = false;
  let pending!: T;
  let running: Promise<void> | undefined;

  const launch = () => {
    if (running || !hasPending) return;
    running = (async () => {
      while (hasPending) {
        const current = pending;
        hasPending = false;
        try {
          await consume(current);
        } catch (error) {
          onError(error);
        }
      }
    })().finally(() => {
      running = undefined;
      if (hasPending) launch();
    });
  };

  return {
    push(value) {
      if (closed) return false;
      pending = value;
      hasPending = true;
      launch();
      return true;
    },
    async close() {
      closed = true;
      while (running || hasPending) {
        launch();
        await running;
      }
    },
    get buffered() {
      return (running ? 1 : 0) + (hasPending ? 1 : 0);
    },
  };
}

export type RunnerCompletionRetryOptions = {
  signal?: AbortSignal;
  retryDelaysMs?: readonly number[];
  shouldRetry?: (error: unknown) => boolean;
};

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new RunnerLeaseLostError("runner_lease_lost");
}

async function waitForRetry(delayMs: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(
      signal?.reason instanceof Error
        ? signal.reason
        : new RunnerLeaseLostError("runner_lease_lost"),
    ));
    const timer = setTimeout(() => finish(resolve), Math.max(0, delayMs));
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Retries an idempotent terminal submission within the current lease window.
 *
 * The payload and lease identity are owned by the caller's closure, so every
 * attempt is byte-for-byte equivalent from the control plane's perspective.
 */
export async function retryRunnerCompletion<T>(
  operation: () => Promise<T>,
  options: RunnerCompletionRetryOptions = {},
) {
  const delays = options.retryDelaysMs || [500, 1_000, 2_000, 5_000, 8_000];
  const shouldRetry = options.shouldRetry || (() => true);
  let retries = 0;
  while (true) {
    throwIfAborted(options.signal);
    try {
      return await operation();
    } catch (error) {
      throwIfAborted(options.signal);
      const delay = delays[retries];
      if (delay === undefined || !shouldRetry(error)) throw error;
      retries += 1;
      await waitForRetry(delay, options.signal);
    }
  }
}
