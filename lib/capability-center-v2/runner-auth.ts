const encoder = new TextEncoder();

function masterSecret() {
  const value = process.env.CAPABILITY_V2_RUNNER_SECRET?.trim()
    || process.env.CAPABILITY_V2_RUNNER_TOKEN?.trim();
  if (value) return value;
  if (process.env.SITEWAKE_LOCAL_DEV === "1" && process.env.NODE_ENV !== "production") return "capability-v2-local-runner-secret";
  throw new Error("capability_v2_runner_token_missing");
}

async function signature(message: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(masterSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function issueRunnerToken(siteId: string, taskId: string, runnerId: string, lifetimeMs = 30 * 60_000) {
  const expiresAt = Date.now() + lifetimeMs;
  const message = `${siteId}\n${taskId}\n${runnerId}\n${expiresAt}`;
  return `v1.${expiresAt}.${await signature(message)}`;
}

export async function verifyRunnerToken(token: string | undefined, siteId: string, taskId: string, runnerId: string) {
  const [version, rawExpiry, provided] = String(token || "").split(".");
  const expiresAt = Number(rawExpiry);
  if (version !== "v1" || !provided || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
  const expected = await signature(`${siteId}\n${taskId}\n${runnerId}\n${expiresAt}`);
  if (expected.length !== provided.length) return false;
  let mismatch = 0; for (let index = 0; index < expected.length; index += 1) mismatch |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  return mismatch === 0;
}
