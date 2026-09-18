export type StreamSettlement = {
  status: "completed" | "cancelled" | "errored";
  bytes: number;
  reason?: unknown;
};

/**
 * Proxy a byte stream while exposing its actual terminal lifecycle. Merely
 * creating or returning the proxy is deliberately not a terminal event.
 */
export function withStreamLifecycle(
  source: ReadableStream<Uint8Array>,
  onSettled: (settlement: StreamSettlement) => void,
  options: { timeoutMs?: number; onTimeout?: () => void } = {},
) {
  const reader = source.getReader();
  let bytes = 0;
  let settled = false;
  let cancelRequested = false;
  let cancelReason: unknown;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cleanup = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
  };
  const settle = (settlement: StreamSettlement) => {
    if (settled) return;
    settled = true;
    cleanup();
    try { onSettled(settlement); } catch { /* Stream delivery must not depend on telemetry cleanup. */ }
  };

  if (options.timeoutMs !== undefined) {
    const timeoutMs = Math.max(0, options.timeoutMs);
    timeout = setTimeout(() => {
      if (settled) return;
      const error = new DOMException(`stream_timeout_after_${timeoutMs}ms`, "TimeoutError");
      try { options.onTimeout?.(); } catch { /* Abort is best-effort; stream settlement is authoritative. */ }
      void reader.cancel(error).catch(() => undefined);
      settle({ status: "errored", bytes, reason: error });
      try { streamController?.error(error); } catch { /* Consumer may already have left. */ }
    }, timeoutMs);
  }

  return new ReadableStream<Uint8Array>({
    start(controller) { streamController = controller; },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          settle({ status: cancelRequested ? "cancelled" : "completed", bytes, reason: cancelReason });
          if (!cancelRequested) controller.close();
          return;
        }
        bytes += result.value.byteLength;
        if (!cancelRequested) controller.enqueue(result.value);
      } catch (error) {
        settle(cancelRequested
          ? { status: "cancelled", bytes, reason: cancelReason ?? error }
          : { status: "errored", bytes, reason: error });
        if (!cancelRequested) controller.error(error);
      }
    },
    async cancel(reason) {
      cancelRequested = true;
      cancelReason = reason;
      try {
        await reader.cancel(reason);
        settle({ status: "cancelled", bytes, reason });
      } catch (error) {
        settle({ status: "errored", bytes, reason: error });
        throw error;
      }
    },
  });
}
