import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { D1DatabaseLike } from "./index";
import { ensureRuntimeSettingsSchema } from "./runtime-settings-schema";

export type RuntimeSetting<T> = { key: string; value: T; updatedAt: string; updatedBy: string | null };

type Row = { key: string; value_json: string; updated_at: string; updated_by: string | null };

// Memory mode (no database binding) keeps settings for the life of the
// process; local development mirrors the model keys to `.env.local` so they
// come back through the environment after a restart. Callers pass the binding
// explicitly: `db/index.ts` loads settings while it is itself initialising.
const memory = new Map<string, RuntimeSetting<unknown>>();

function fromRow<T>(row: Row): RuntimeSetting<T> {
  return { key: row.key, value: JSON.parse(row.value_json) as T, updatedAt: row.updated_at, updatedBy: row.updated_by ?? null };
}

export async function getRuntimeSetting<T>(key: string, database: D1DatabaseLike | null): Promise<RuntimeSetting<T> | null> {
  if (!database) return (memory.get(key) as RuntimeSetting<T> | undefined) ?? null;
  await ensureRuntimeSettingsSchema(database);
  const result = await database.prepare(`SELECT key,value_json,updated_at,updated_by FROM runtime_settings WHERE key=? LIMIT 1`).bind(key).all<Row>();
  if (!result.success) throw new Error(result.error || "runtime_settings_read_failed");
  const row = result.results?.[0];
  return row ? fromRow<T>(row) : null;
}

export async function putRuntimeSetting<T>(
  key: string,
  value: T,
  database: D1DatabaseLike | null,
  updatedBy: string | null = null,
): Promise<RuntimeSetting<T>> {
  const setting: RuntimeSetting<T> = { key, value, updatedAt: new Date().toISOString(), updatedBy };
  if (!database) {
    memory.set(key, setting);
    return setting;
  }
  await ensureRuntimeSettingsSchema(database);
  const result = await database
    .prepare(`INSERT OR REPLACE INTO runtime_settings (key,value_json,updated_at,updated_by) VALUES (?,?,?,?)`)
    .bind(key, JSON.stringify(value), setting.updatedAt, updatedBy)
    .run();
  if (!result.success) throw new Error(result.error || "runtime_settings_write_failed");
  return setting;
}

/** Test hook: memory mode starts empty. */
export function resetRuntimeSettingsMemory() {
  memory.clear();
}

// --- .env.local write-back for `npm run dev` ------------------------------

/** `npm run dev` starts the control plane in the repository root. */
export function localEnvFile() {
  return resolve(process.cwd(), ".env.local");
}

/** A Node control plane in local development with no database at all: the only place a saved setting can outlive the process is `.env.local`. */
export function localEnvWritebackEnabled(database: D1DatabaseLike | null) {
  return process.env.SITEWAKE_LOCAL_DEV === "1" && !database;
}

function envValue(value: string) {
  if (/[\r\n\0]/.test(value)) throw new Error("env_value_newline");
  if (!/[\s#'"`]/.test(value)) return value;
  const quote = ["'", '"', "`"].find((candidate) => !value.includes(candidate));
  if (!quote) throw new Error("env_value_quotes");
  return `${quote}${value}${quote}`;
}

/**
 * Rewrite only the given keys in an env file's text: an existing assignment
 * is replaced in place (duplicates dropped), every other line stays as it
 * was, missing keys are appended. Same rules as the setup wizard's writer.
 */
export function applyEnvValues(text: string, values: Record<string, string>) {
  const keys = Object.keys(values);
  const lines = text ? text.split(/\r?\n/) : [];
  const written = new Set<string>();
  const next: string[] = [];
  for (const line of lines) {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (key && keys.includes(key)) {
      if (written.has(key)) continue;
      written.add(key);
      next.push(`${key}=${envValue(values[key])}`);
      continue;
    }
    next.push(line);
  }
  const missing = keys.filter((key) => !written.has(key));
  if (missing.length) {
    if (next.length && next[next.length - 1].trim() !== "") next.push("");
    next.push("# Written by the console (model settings).");
    for (const key of missing) next.push(`${key}=${envValue(values[key])}`);
  }
  const body = next.join("\n");
  return body.endsWith("\n") ? body : `${body}\n`;
}

/** Write the keys into the env file privately and atomically; a failed write leaves the old file intact. */
export async function writeEnvValues(values: Record<string, string>, path = localEnvFile()) {
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, applyEnvValues(current, values), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
