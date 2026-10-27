export const DEFAULT_MODEL_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "gpt-5.6-luna";
export type ModelRole = "general" | "semantic" | "execution";

export type ModelConfig = {
  configured: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  source: "console" | "model" | "openai" | "proxy" | "missing";
};

/** What the console saves: one provider, one key, a shared model name and optional per-role overrides. */
export type ModelSettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
  executionModel?: string;
  semanticModel?: string;
};

function value(name: string) {
  return String(process.env[name] || "").trim();
}

/** First configured value in a precedence chain, or the built-in default. */
function firstValue(...names: string[]) {
  for (const name of names) {
    const configured = value(name);
    if (configured) return configured;
  }
  return DEFAULT_MODEL;
}

// The console's saved configuration, held in this process. The control plane
// fills it at startup (from runtime_settings) and on every save, so the
// synchronous readers below never wait on the database. Null means "nothing
// saved": the environment decides.
let override: ModelSettings | null = null;

export function setModelSettings(settings: ModelSettings | null) {
  override = settings ? normalizeModelSettings(settings) : null;
}

export function getModelSettings(): ModelSettings | null {
  return override;
}

export function normalizeModelSettings(settings: ModelSettings): ModelSettings {
  const trimmed = (text: unknown) => String(text ?? "").trim();
  const normalized: ModelSettings = {
    baseUrl: trimmed(settings.baseUrl) || DEFAULT_MODEL_BASE_URL,
    apiKey: trimmed(settings.apiKey),
    model: trimmed(settings.model) || DEFAULT_MODEL,
  };
  if (trimmed(settings.executionModel)) normalized.executionModel = trimmed(settings.executionModel);
  if (trimmed(settings.semanticModel)) normalized.semanticModel = trimmed(settings.semanticModel);
  return normalized;
}

/** The environment's configuration in the same shape, or null when no key is set. */
export function modelSettingsFromEnv(): ModelSettings | null {
  const apiKey = value("MODEL_API_KEY") || value("OPENAI_API_KEY");
  if (!apiKey) return null;
  return normalizeModelSettings({
    baseUrl: value("MODEL_BASE_URL") || value("OPENAI_BASE_URL"),
    apiKey,
    model: value("MODEL") || value("OPENAI_MODEL"),
    executionModel: value("MODEL_EXECUTION"),
    semanticModel: value("MODEL_SEMANTIC"),
  });
}

function roleModel(settings: ModelSettings, role: ModelRole) {
  if (role === "execution") return settings.executionModel || settings.model;
  if (role === "semantic") return settings.semanticModel || settings.model;
  return settings.model;
}

/**
 * Resolve the application-wide model configuration in the server process.
 * Only publicModelStatus() may cross the HTTP boundary; apiKey stays server-only.
 */
export function getModelConfig(role: ModelRole = "general"): ModelConfig {
  // Deterministic integration tests inject a local protocol fixture explicitly.
  // The guard prevents this test-only driver from ever becoming an E2E or
  // production fallback when a real provider is unavailable.
  if (value("SITEWAKE_TEST_SUITE") === "capability-v2-integration") {
    const apiKey = value("CAPABILITY_V2_INTEGRATION_MODEL_API_KEY");
    const baseUrl = value("CAPABILITY_V2_INTEGRATION_MODEL_BASE_URL");
    const model = value("CAPABILITY_V2_INTEGRATION_MODEL_NAME");
    if (apiKey && baseUrl && model) return { configured: true, apiKey, baseUrl, model, source: "openai" };
  }
  // Workers and the runtime launcher never hold the provider key. They are
  // pointed at the control plane's internal proxy, which is an OpenAI-compatible
  // chat-completions endpoint per role, authenticated with the internal token
  // these processes already carry. The proxy substitutes the real model name.
  const proxy = value("SITEWAKE_MODEL_PROXY_URL");
  if (proxy) {
    const token = value("CAPABILITY_V2_DISPATCH_TOKEN");
    return { configured: Boolean(token), baseUrl: `${proxy.replace(/\/+$/, "")}/${role}`, apiKey: token, model: "proxy", source: "proxy" };
  }
  if (override) {
    return { configured: true, baseUrl: override.baseUrl, apiKey: override.apiKey, model: roleModel(override, role), source: "console" };
  }
  // MODEL_* is the canonical configuration: it carries no product name, so it
  // survives renames. OPENAI_* stays readable because many machines already
  // export it. Aliases are read-only — nothing writes them.
  const modelKey = value("MODEL_API_KEY");
  const openAIKey = value("OPENAI_API_KEY");
  const apiKey = modelKey || openAIKey;
  const modelName =
    role === "execution"
      ? firstValue("MODEL_EXECUTION", "MODEL", "OPENAI_MODEL")
      : role === "semantic"
        ? firstValue("MODEL_SEMANTIC", "MODEL", "OPENAI_MODEL")
        : firstValue("MODEL", "OPENAI_MODEL");
  return {
    configured: Boolean(apiKey),
    baseUrl: value("MODEL_BASE_URL") || value("OPENAI_BASE_URL") || DEFAULT_MODEL_BASE_URL,
    apiKey,
    // Every role falls back to the shared default name, so configuring `MODEL`
    // alone covers all three. The role overrides exist for installations that
    // want a different tier for real-time execution than for background work.
    model: modelName,
    source: modelKey ? "model" : openAIKey ? "openai" : "missing",
  };
}

export function modelChatCompletionsUrl(baseUrl: string) {
  const base = baseUrl.replace(/\/$/, "");
  return /\/v\d+$/i.test(base)
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`;
}

export function modelCompatibility(config: ModelConfig) {
  // Behind the proxy the control plane applies the real provider's rules.
  if (config.source === "proxy") return { nativeJsonSchema: true, omitStructuredMaxTokens: false, requestBody: {} };
  let hostname = "";
  try { hostname = new URL(config.baseUrl).hostname; } catch { /* invalid URLs fail at the actual request boundary */ }
  const alibaba = /(?:^|\.)aliyuncs\.com$/i.test(hostname);
  // DeepSeek answers a json_schema response_format with a 400; json_object works.
  const deepseek = /^deepseek(?:[-.]|$)/i.test(config.model.trim());
  return {
    nativeJsonSchema: !alibaba && !deepseek,
    omitStructuredMaxTokens: alibaba,
    requestBody: {},
  };
}

/** Where the effective configuration comes from, as the console shows it. */
export function modelConfigSource(): "console" | "env" | "missing" {
  if (override) return "console";
  return modelSettingsFromEnv() ? "env" : "missing";
}

export function publicModelStatus(role: ModelRole = "general") {
  const config = getModelConfig(role);
  return {
    configured: config.configured,
    model: config.model,
    provider: "openai-compatible" as const,
    source: modelConfigSource(),
  };
}
