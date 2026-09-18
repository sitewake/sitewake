// Access-control primitives that never touch storage so they run identically in
// the Cloudflare Worker, the Node container, and the test runner. Password
// hashing and session signing both use Web Crypto, which is a global in all
// three runtimes.

export const ACCESS_COOKIE_NAME = "sr_access";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
export const PBKDF2_ITERATIONS = 120_000;

const encoder = new TextEncoder();

function toHex(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let hex = "";
  for (let index = 0; index < bytes.length; index += 1) hex += bytes[index].toString(16).padStart(2, "0");
  return hex;
}

// Annotated as `Uint8Array<ArrayBuffer>` (not the default `ArrayBufferLike`) so
// the result satisfies Web Crypto's `BufferSource` parameters under TS 5.7+.
function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

export function randomHex(byteLength: number): string {
  const array = new Uint8Array(byteLength);
  crypto.getRandomValues(array);
  return toHex(array);
}

// Constant-time comparison for equal-length hex digests. Callers only ever
// compare derived hashes, so both operands are the same length by construction.
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return mismatch === 0;
}

export async function hashPassword(password: string, saltHex: string, iterations: number): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromHex(saltHex), iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return toHex(bits);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return toHex(digest);
}

// A secret comparison that neither leaks length nor short-circuits: both inputs
// collapse to a fixed-width digest before the constant-time compare.
export async function secretEquals(candidate: string, expected: string): Promise<boolean> {
  return timingSafeEqualHex(await sha256Hex(candidate), await sha256Hex(expected));
}

async function signSession(secretHex: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", fromHex(secretHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return toHex(signature);
}

// The cookie is `<expiresAtMs>.<hmac>`. Rotating the policy's session secret
// invalidates every outstanding cookie, which is how "force sign-out" works.
export async function createSessionCookieValue(secretHex: string, nowMs: number): Promise<{ value: string; expiresAt: number }> {
  const expiresAt = nowMs + SESSION_TTL_MS;
  const signature = await signSession(secretHex, String(expiresAt));
  return { value: `${expiresAt}.${signature}`, expiresAt };
}

export async function verifySessionCookieValue(secretHex: string, value: string | undefined, nowMs: number): Promise<boolean> {
  if (!secretHex || !value) return false;
  const separator = value.indexOf(".");
  if (separator <= 0) return false;
  const expiresAtRaw = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return false;
  const expected = await signSession(secretHex, expiresAtRaw);
  return timingSafeEqualHex(signature, expected);
}
