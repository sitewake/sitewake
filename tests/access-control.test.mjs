import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Bundle the TypeScript module the same way the rest of the suite does, so the
// extensionless imports resolve and types are stripped.
async function load(entry) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const session = await load("../lib/access-control/session.ts");

test("access-control: password hash is deterministic per salt and separates passwords", async () => {
  const salt = session.randomHex(16);
  const a = await session.hashPassword("correct horse", salt, 1000);
  const b = await session.hashPassword("correct horse", salt, 1000);
  const c = await session.hashPassword("Correct horse", salt, 1000);
  assert.equal(a, b, "same password + salt + iterations must hash identically");
  assert.notEqual(a, c, "a different password must produce a different hash");
  assert.ok(session.timingSafeEqualHex(a, b));
  assert.equal(session.timingSafeEqualHex(a, c), false);
});

test("access-control: iteration count changes the derived hash", async () => {
  const salt = session.randomHex(16);
  const low = await session.hashPassword("pw", salt, 1000);
  const high = await session.hashPassword("pw", salt, 2000);
  assert.notEqual(low, high);
});

test("access-control: secretEquals is value-correct", async () => {
  assert.equal(await session.secretEquals("master-key", "master-key"), true);
  assert.equal(await session.secretEquals("master-key", "master-keyx"), false);
  assert.equal(await session.secretEquals("", "master-key"), false);
});

test("access-control: a signed session cookie verifies within its lifetime", async () => {
  const secret = session.randomHex(32);
  const now = 1_000_000;
  const { value, expiresAt } = await session.createSessionCookieValue(secret, now);
  assert.ok(expiresAt > now);
  assert.equal(await session.verifySessionCookieValue(secret, value, now), true);
  assert.equal(await session.verifySessionCookieValue(secret, value, expiresAt - 1), true);
});

test("access-control: rotating the secret invalidates outstanding cookies", async () => {
  const secret = session.randomHex(32);
  const rotated = session.randomHex(32);
  const { value } = await session.createSessionCookieValue(secret, 0);
  assert.equal(await session.verifySessionCookieValue(rotated, value, 1), false);
});

test("access-control: an expired cookie no longer verifies", async () => {
  const secret = session.randomHex(32);
  const { value, expiresAt } = await session.createSessionCookieValue(secret, 0);
  assert.equal(await session.verifySessionCookieValue(secret, value, expiresAt), false);
  assert.equal(await session.verifySessionCookieValue(secret, value, expiresAt + 1), false);
});

test("access-control: tampered or malformed cookies are rejected", async () => {
  const secret = session.randomHex(32);
  const { value } = await session.createSessionCookieValue(secret, 0);
  const [expiry, signature] = value.split(".");
  const tampered = `${expiry}.${signature.slice(0, -1)}${signature.endsWith("a") ? "b" : "a"}`;
  assert.equal(await session.verifySessionCookieValue(secret, tampered, 1), false);
  assert.equal(await session.verifySessionCookieValue(secret, "not-a-cookie", 1), false);
  assert.equal(await session.verifySessionCookieValue(secret, "", 1), false);
  assert.equal(await session.verifySessionCookieValue(secret, undefined, 1), false);
  // A forged future expiry cannot be signed without the secret.
  assert.equal(await session.verifySessionCookieValue(secret, `${Number.MAX_SAFE_INTEGER}.deadbeef`, 1), false);
});
