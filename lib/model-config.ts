export const DEFAULT_MODEL_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "gpt-5.6-luna";
export type ModelRole = "general" | "semantic" | "execution";

export type ModelConfig = {
  configured: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  source: "model" | "openai" | "missing";
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
  let hostname = "";
  try { hostname = new URL(config.baseUrl).hostname; } catch { /* invalid URLs fail at the actual request boundary */ }
  const alibaba = /(?:^|\.)aliyuncs\.com$/i.test(hostname);
  return {
    nativeJsonSchema: !alibaba,
    omitStructuredMaxTokens: alibaba,
    requestBody: {},
  };
}

export function publicModelStatus(role: ModelRole = "general") {
  const config = getModelConfig(role);
  return {
    configured: config.configured,
    model: config.model,
    provider: "openai-compatible" as const,
  };
}
