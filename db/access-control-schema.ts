import type { D1DatabaseLike } from "./index";

const ACCESS_CONTROL_STORAGE_VERSION = "1-access-password";

// A single-row policy (`id = 'default'`) plus a version marker, mirroring the
// idempotent, version-gated schema bootstrap used by the site-agent stores.
export const ACCESS_CONTROL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS site_access_v1_meta (
    key text PRIMARY KEY NOT NULL,
    value text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS site_access_v1_policy (
    id text PRIMARY KEY NOT NULL,
    enabled integer NOT NULL DEFAULT 0,
    password_hash text,
    password_salt text,
    hash_iterations integer NOT NULL DEFAULT 0,
    session_secret text,
    updated_at text NOT NULL
  )`,
  `INSERT OR REPLACE INTO site_access_v1_meta (key,value,updated_at)
    VALUES ('storage_version','${ACCESS_CONTROL_STORAGE_VERSION}',datetime('now'))`,
] as const;

const initializationByDatabase = new WeakMap<object, Promise<void>>();

export async function ensureAccessControlSchema(database: D1DatabaseLike) {
  const cached = initializationByDatabase.get(database as object);
  if (cached) return cached;
  const promise = (async () => {
    let storageVersion: string | undefined;
    try {
      const probe = await database.prepare(`SELECT value FROM site_access_v1_meta WHERE key='storage_version' LIMIT 1`).all<{ value: string }>();
      storageVersion = probe.success ? probe.results?.[0]?.value : undefined;
    } catch (error) {
      // D1 throws for a missing table rather than returning `success: false`.
      // Treat only that as the signal to (re)create the schema.
      if (!/no such table|does not exist/.test(String(error).toLowerCase())) throw error;
    }
    if (storageVersion === ACCESS_CONTROL_STORAGE_VERSION) return;
    const results = await database.batch(ACCESS_CONTROL_SCHEMA_STATEMENTS.map((statement) => database.prepare(statement)));
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "site_access_v1_schema_failed");
  })();
  initializationByDatabase.set(database as object, promise);
  try {
    await promise;
  } catch (error) {
    initializationByDatabase.delete(database as object);
    throw error;
  }
}
