const decoder = new TextDecoder("utf-8", { fatal: true });

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("request_body_too_large");
  }
}

export class InvalidJsonBodyError extends Error {
  constructor() {
    super("invalid_json");
  }
}

/**
 * Reads JSON without allowing `Request.json()` to buffer an attacker-controlled
 * body first. Content-Length is only a fast rejection; the streaming byte count
 * remains authoritative for chunked and dishonest requests.
 */
export async function readBoundedJson<T>(
  request: Request,
  maximumBytes: number,
): Promise<T> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new InvalidJsonBodyError();
    }
    if (bytes > maximumBytes) throw new RequestBodyTooLargeError();
  }
  if (!request.body) throw new InvalidJsonBodyError();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel("request_body_too_large").catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (!length) throw new InvalidJsonBodyError();
  const payload = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(decoder.decode(payload)) as T;
  } catch {
    throw new InvalidJsonBodyError();
  }
}

export function boundedJsonErrorStatus(error: unknown): 400 | 413 | undefined {
  if (error instanceof RequestBodyTooLargeError
    || (error instanceof Error && error.message === "request_body_too_large")) {
    return 413;
  }
  if (error instanceof InvalidJsonBodyError
    || (error instanceof Error && error.message === "invalid_json")) {
    return 400;
  }
  return undefined;
}
