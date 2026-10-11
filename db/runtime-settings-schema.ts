import type { D1DatabaseLike } from "./index";

// Global key/value settings the console edits at runtime (the model
// configuration is the first). One JSON document per key; `updated_by`
// records the entry point that wrote it. Created lazily on first use, like
// the other stores.
export const RUNTIME_SETTINGS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS runtime_settings (
    key text PRIMARY KEY NOT NULL,
    value_json text NOT NULL,
    updated_at text NOT NULL,
    updated_by text
  )`,
] as const;

const initializationByDatabase = new WeakMap<object, Promise<void>>();

export async function ensureRuntimeSettingsSchema(database: D1DatabaseLike) {
  const cached = initializationByDatabase.get(database as object);
  if (cached) return cached;
  const promise = (async () => {
    const results = await database.batch(RUNTIME_SETTINGS_SCHEMA_STATEMENTS.map((statement) => database.prepare(statement)));
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "runtime_settings_schema_failed");
  })();
  initializationByDatabase.set(database as object, promise);
  try {
    await promise;
  } catch (error) {
    initializationByDatabase.delete(database as object);
    throw error;
  }
}
