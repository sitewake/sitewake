import type { D1DatabaseLike } from "../db/index";
import { getRuntimeSetting, localEnvWritebackEnabled, putRuntimeSetting, writeEnvValues } from "../db/runtime-settings-store";
import {
  DEFAULT_MODEL_BASE_URL,
  getModelSettings,
  modelConfigSource,
  modelSettingsFromEnv,
  normalizeModelSettings,
  setModelSettings,
  type ModelSettings,
} from "./model-config";

export const MODEL_SETTINGS_KEY = "model";

/**
 * Fill the process cache from `runtime_settings`. The control plane calls this
 * once its database binding is known, before it serves requests; a missing
 * row leaves the environment in charge. Read failures fall back the same way
 * rather than blocking startup — the console shows the source either way.
 */
export async function loadModelSettings(database: D1DatabaseLike | null) {
  try {
    const row = await getRuntimeSetting<ModelSettings>(MODEL_SETTINGS_KEY, database);
    setModelSettings(row?.value ?? null);
  } catch {
    setModelSettings(null);
  }
  return getModelSettings();
}

// One load per database binding for the life of the isolate. The Node
// control plane loads at module init; a Worker (Cloudflare, and the local
// `npm run dev` runtime, which is workerd with a D1 binding) may not do I/O
// there and calls this at the top of every request instead — only the first
// one waits.
const loadedByDatabase = new WeakMap<object, Promise<ModelSettings | null>>();
let loadedWithoutDatabase: Promise<ModelSettings | null> | undefined;

export function ensureModelSettingsLoaded(database: D1DatabaseLike | null) {
  if (!database) return (loadedWithoutDatabase ??= loadModelSettings(null));
  let pending = loadedByDatabase.get(database as object);
  if (!pending) {
    pending = loadModelSettings(database);
    loadedByDatabase.set(database as object, pending);
  }
  return pending;
}

/**
 * Persist and apply a configuration in one step: the row (or process memory),
 * then the cache every reader sees. A Node control plane running with no
 * database at all also mirrors the keys to `.env.local`, which is how its next
 * start reads them back (`npm run dev` has a local D1, so it never needs this).
 */
export async function saveModelSettings(input: ModelSettings, database: D1DatabaseLike | null, updatedBy = "console") {
  const settings = normalizeModelSettings(input);
  await putRuntimeSetting(MODEL_SETTINGS_KEY, settings, database, updatedBy);
  if (localEnvWritebackEnabled(database)) {
    await writeEnvValues({
      MODEL_API_KEY: settings.apiKey,
      MODEL_BASE_URL: settings.baseUrl,
      MODEL: settings.model,
      MODEL_EXECUTION: settings.executionModel ?? "",
      MODEL_SEMANTIC: settings.semanticModel ?? "",
    });
  }
  setModelSettings(settings);
  // What was just written is what a later load would find.
  const settled = Promise.resolve(settings);
  if (database) loadedByDatabase.set(database as object, settled); else loadedWithoutDatabase = settled;
  return settings;
}

/** `sk-…ab12`; anything shorter than eight characters is fully masked. */
export function maskApiKey(apiKey: string) {
  const key = String(apiKey || "");
  if (!key) return "";
  if (key.length < 8) return "•".repeat(key.length);
  const prefix = /^[A-Za-z]{1,4}-/.exec(key)?.[0] ?? "";
  return `${prefix}…${key.slice(-4)}`;
}

/** The configuration as the console may see it: everything but the key itself. */
export function publicModelSettings() {
  const source = modelConfigSource();
  const settings = getModelSettings() ?? modelSettingsFromEnv();
  return {
    source,
    configured: Boolean(settings?.apiKey),
    baseUrl: settings?.baseUrl ?? "",
    model: settings?.model ?? "",
    executionModel: settings?.executionModel ?? "",
    semanticModel: settings?.semanticModel ?? "",
    apiKeyMasked: maskApiKey(settings?.apiKey ?? ""),
  };
}

/** The key to use for a request that left the key field empty: the one already in effect. */
export function effectiveApiKey() {
  return (getModelSettings() ?? modelSettingsFromEnv())?.apiKey ?? "";
}

/** A console form submission as settings, or the field that is wrong. */
export function modelSettingsFromBody(body: Record<string, unknown>): { settings: ModelSettings } | { error: string } {
  const text = (value: unknown) => String(value ?? "").trim();
  const baseUrl = text(body.baseUrl) || DEFAULT_MODEL_BASE_URL;
  try {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return { error: "base_url_invalid" };
  } catch { return { error: "base_url_invalid" }; }
  const model = text(body.model);
  if (!model) return { error: "model_required" };
  // An empty key means "keep the one in effect": the browser only ever sees a mask.
  const apiKey = text(body.apiKey) || effectiveApiKey();
  if (!apiKey) return { error: "api_key_required" };
  return { settings: { baseUrl, apiKey, model, executionModel: text(body.executionModel), semanticModel: text(body.semanticModel) } };
}
