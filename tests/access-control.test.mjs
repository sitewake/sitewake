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

/**
 * The policy store needs a D1 binding, so these run against an isolated one:
 * the esbuild plugin replaces db/index.ts with a binding this test owns, the
 * way the rest of the suite isolates a database.
 */
async function policyWithDatabase() {
  const { Miniflare } = await import("miniflare");
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `access-policy-test-${Math.random().toString(36).slice(2)}` },
  });
  const database = await miniflare.getD1Database("DB");
  const key = `__ACCESS_POLICY_TEST_DB_${Math.random().toString(36).slice(2)}`;
  globalThis[key] = database;
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../lib/access-control/policy.ts", import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{
      name: "isolated-d1-binding",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
          loader: "ts",
          contents: `const db = globalThis[${JSON.stringify(key)}] || null;
            export function getD1Binding() { return db; }
            export function getArtifactBinding() { return null; }
            export class D1UnavailableError extends Error {}`,
        }));
      },
    }],
  });
  try {
    const policy = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
    return { policy, dispose: () => miniflare.dispose() };
  } finally {
    delete globalThis[key];
  }
}

test("a first password hands the caller a session; changing one does not", async () => {
  // Setting a password rotates the session secret, so every existing cookie has
  // to stop working. On a first setup the only cookie that exists belongs to the
  // person setting it, and there is nothing to protect them from — so the policy
  // reports `firstTime` and hands back the secret for a fresh cookie. A later
  // change is the opposite case: every device, including this one, signs out.
  const { policy, dispose } = await policyWithDatabase();
  try {
    const first = await policy.applyManagement("setPassword", { password: "first-password" });
    assert.equal(first.ok, true);
    assert.equal(first.status.configured, true);
    assert.equal(first.status.enabled, true);
    assert.equal(first.session?.firstTime, true, "a first setup grants the caller a session");
    assert.match(first.session?.sessionSecret ?? "", /^[a-f0-9]{64}$/);

    const changed = await policy.applyManagement("setPassword", {
      password: "second-password",
      currentPassword: "first-password",
    });
    assert.equal(changed.ok, true);
    assert.equal(changed.session?.firstTime, false, "a change is not a first setup");
    assert.notEqual(changed.session?.sessionSecret, first.session?.sessionSecret,
      "the secret rotates, so the old cookie stops working");
  } finally {
    await dispose();
  }
});

test("only setPassword grants a session, and a refused call grants nothing", async () => {
  const { policy, dispose } = await policyWithDatabase();
  try {
    const tooShort = await policy.applyManagement("setPassword", { password: "abc" });
    assert.equal(tooShort.ok, false);
    assert.equal(tooShort.error, "password_too_short");
    assert.equal("session" in tooShort, false, "a refused call hands back nothing");

    await policy.applyManagement("setPassword", { password: "a-real-password" });
    for (const action of ["enable", "disable", "revokeSessions"]) {
      const result = await policy.applyManagement(action, { currentPassword: "a-real-password" });
      assert.equal(result.ok, true, `${action} must succeed`);
      assert.equal(result.session, undefined, `${action} must not grant a session`);
    }

    const wrong = await policy.applyManagement("setPassword", { password: "another-one", currentPassword: "nope" });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error, "unauthorized");
    assert.equal("session" in wrong, false);
  } finally {
    await dispose();
  }
});

test("a cookie minted before a password change stops working after it", async () => {
  // The reason setPassword rotates the secret: the point of changing a password
  // is that whoever had the old one — and whatever was already signed in — is
  // out. This checks the rotation end to end rather than trusting the comment.
  const { policy, dispose } = await policyWithDatabase();
  try {
    const first = await policy.applyManagement("setPassword", { password: "first-password" });
    const beforeChange = await session.createSessionCookieValue(first.session.sessionSecret, Date.now());
    assert.equal(await policy.authorizeManagementSession(beforeChange.value), true,
      "the session minted at first setup works");

    await policy.applyManagement("setPassword", { password: "second-password", currentPassword: "first-password" });
    assert.equal(await policy.authorizeManagementSession(beforeChange.value), false,
      "after the change that same cookie is refused");

    const after = await policy.verifyAccessPassword("second-password");
    assert.equal(after.ok, true);
    const afterChange = await session.createSessionCookieValue(after.sessionSecret, Date.now());
    assert.equal(await policy.authorizeManagementSession(afterChange.value), true,
      "logging in with the new password works");
    assert.equal((await policy.verifyAccessPassword("first-password")).ok, false,
      "the old password is gone");
  } finally {
    await dispose();
  }
});

test("nothing that could impersonate a session is readable back out", async () => {
  // `AccessStatus` is the shape the browser is served. A password, its hash,
  // its salt or the session secret appearing in it would hand an anonymous
  // reader everything needed to mint a cookie, so the check is on the whole
  // serialized value rather than on a field list that can grow.
  const { policy, dispose } = await policyWithDatabase();
  try {
    const set = await policy.applyManagement("setPassword", { password: "a-secret-password" });
    const secret = set.session.sessionSecret;
    const status = await policy.getAccessStatus();
    assert.deepEqual(Object.keys(status).sort(), ["configured", "enabled", "updatedAt"]);
    const serialized = JSON.stringify(status);
    for (const forbidden of [secret, "a-secret-password", "passwordHash", "passwordSalt", "sessionSecret"]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} must not be readable from the status`);
    }
    const gate = await policy.resolveAccessGate(undefined);
    assert.equal(JSON.stringify(gate).includes(secret), false, "nor from the gate state");
    // The one place the secret is handed out is the result of setting a
    // password, which the route consumes to sign a cookie and never echoes.
    assert.equal(JSON.stringify(set.status).includes(secret), false);
  } finally {
    await dispose();
  }
});

/** The skip flag reads its own binding, so it gets its own isolated module. */
async function skipWithDatabase(database) {
  const key = `__ACCESS_SKIP_TEST_DB_${Math.random().toString(36).slice(2)}`;
  globalThis[key] = database;
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../lib/access-control/onboarding-skip.ts", import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{
      name: "isolated-skip-binding",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
          loader: "ts",
          contents: `const db = globalThis[${JSON.stringify(key)}] ?? null;
            export function getD1Binding() { return db; }
            export function getArtifactBinding() { return null; }
            export class D1UnavailableError extends Error {}`,
        }));
      },
    }],
  });
  try {
    return await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  } finally {
    delete globalThis[key];
  }
}

test("skipping the password step is remembered, and an unreadable store is not a decision", async () => {
  // Memory mode (no binding) is the local-development path and keeps the value
  // for the life of the process, which is enough to show write-then-read.
  const stored = await skipWithDatabase(null);
  assert.equal(await stored.accessOnboardingSkipped(), false, "nothing has been skipped yet");
  await stored.skipAccessOnboarding();
  assert.equal(await stored.accessOnboardingSkipped(), true, "and the choice is remembered");

  // A store that throws must not be read as "skipped": being asked once more
  // is the harmless direction, and silently dropping the step is not.
  const broken = await skipWithDatabase({
    prepare() { throw new Error("storage on fire"); },
    async batch() { throw new Error("storage on fire"); },
  });
  assert.equal(await broken.accessOnboardingSkipped(), false,
    "an unreadable store means the step is offered again");
});

test("skipping changes nothing about the policy itself", async () => {
  // The notice in the console follows `configured`, and the step follows the
  // skip flag. If skipping could move `configured` or `enabled`, the two could
  // disagree — the console would stop warning about a console that is open.
  const { policy, dispose } = await policyWithDatabase();
  const skip = await skipWithDatabase(null);
  try {
    const before = await policy.getAccessStatus();
    await skip.skipAccessOnboarding();
    const after = await policy.getAccessStatus();
    assert.deepEqual(after, before, "the access status is untouched by skipping");
    assert.equal(after.configured, false);
    assert.equal(after.enabled, false);
    const gate = await policy.resolveAccessGate(undefined);
    assert.equal(gate.locked, false, "an open installation stays open after skipping");
  } finally {
    await dispose();
  }
});

test("an installation with no password really is open, and one with a password really is not", async () => {
  // The notice in the console claims the first half of this. If the claim and
  // the behaviour ever diverged, the console would be lying in one direction or
  // the other, so both halves are pinned here.
  const { policy, dispose } = await policyWithDatabase();
  try {
    assert.equal(await policy.authorizeManagementSession(undefined), true,
      "no password means management is open — which is what the notice says");
    const gate = await policy.resolveAccessGate(undefined);
    assert.equal(gate.locked, false);

    await policy.applyManagement("setPassword", { password: "a-real-password" });
    assert.equal(await policy.authorizeManagementSession(undefined), false,
      "once a password exists, a request with no session is refused");
    assert.equal(await policy.authorizeManagementSession("not-a-real-cookie"), false);
    assert.equal((await policy.resolveAccessGate(undefined)).locked, true);
  } finally {
    await dispose();
  }
});

test("the environment master key still authorizes a first setup on its own terms", async () => {
  // `ACCESS_ADMIN_KEY` is the operator's way in when no password is set
  // or the password is lost. The first-setup change must not have widened or
  // narrowed it: with the key set, the key is what authorizes — and the bootstrap
  // "no password yet means anyone may set one" path must not apply.
  const saved = process.env.ACCESS_ADMIN_KEY;
  process.env.ACCESS_ADMIN_KEY = "master-key-for-this-test";
  const { policy, dispose } = await policyWithDatabase();
  try {
    const withoutKey = await policy.applyManagement("setPassword", { password: "a-real-password" });
    assert.equal(withoutKey.ok, false, "with a master key set, the bootstrap path is closed");
    assert.equal(withoutKey.error, "unauthorized");

    const withKey = await policy.applyManagement("setPassword", {
      password: "a-real-password",
      adminKey: "master-key-for-this-test",
    });
    assert.equal(withKey.ok, true);
    assert.equal(withKey.session?.firstTime, true, "it is still a first setup, and still grants the session");
  } finally {
    await dispose();
    if (saved === undefined) delete process.env.ACCESS_ADMIN_KEY;
    else process.env.ACCESS_ADMIN_KEY = saved;
  }
});
