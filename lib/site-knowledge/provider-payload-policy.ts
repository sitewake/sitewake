type JsonRecord = Record<string, unknown>;

export class ForcedToolChoiceProviderError extends Error {
  readonly code = "forced_tool_choice_provider_unsupported";
  readonly hostname: string;
  readonly model: string;

  constructor(hostname: string, model: string) {
    super("The configured model provider has no verified forced-tool thinking policy.");
    this.name = "ForcedToolChoiceProviderError";
    this.hostname = hostname;
    this.model = model;
  }
}

/**
 * The providers whose forced-tool-call request policy has been verified, as
 * the setup wizard offers them: the OpenAI-compatible base URL to use and the
 * model families the policy below recognises. Keep in step with
 * `thinkingPolicyFor`; the wizard reads this table, it does not keep its own.
 */
export const VERIFIED_PROVIDERS = [
  { id: "openai", baseUrl: "https://api.openai.com/v1", families: ["gpt-*", "o-series"] },
  { id: "bailian", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", families: ["qwen*"] },
  { id: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4", families: ["glm*"] },
  { id: "ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", families: ["doubao*", "deepseek*", "kimi*", "qwen*", "glm*"] },
] as const;

export type VerifiedProviderId = (typeof VERIFIED_PROVIDERS)[number]["id"];

/** The verified provider a base URL belongs to, if any. */
export function verifiedProviderFor(baseUrl: string): VerifiedProviderId | undefined {
  const hostname = hostnameFor(baseUrl);
  if (hostname === "api.openai.com") return "openai";
  if (isBailianHostname(hostname)) return "bailian";
  if (hostname === "open.bigmodel.cn") return "zhipu";
  if (isArkHostname(hostname)) return "ark";
  return undefined;
}

function hostnameFor(baseUrl: string) {
  try { return new URL(baseUrl).hostname.toLowerCase(); }
  catch { return ""; }
}

function isBailianHostname(hostname: string) {
  return hostname === "dashscope.aliyuncs.com" || hostname.endsWith(".maas.aliyuncs.com");
}

// The development/validation gateway used by this workspace exposes Qwen
// through the OpenAI-compatible API. Its forced-tool contract is the same
// non-thinking payload as Bailian; keep this as an explicit host match so
// unknown OpenAI-compatible gateways still fail closed below.
function isOs1GatewayHostname(hostname: string) {
  return hostname === "openapi.os1.cn";
}

function isArkHostname(hostname: string) {
  return /^ark\.[a-z0-9-]+\.volces\.com$/i.test(hostname);
}

// A worker behind the control plane's internal model proxy does not know the
// provider. It sends the generic "thinking off" switch below; the proxy
// re-expresses it for the real provider (lib/model-proxy/forward.ts).
function isInternalModelProxy(baseUrl: string) {
  try { return /\/api\/internal\/model(?:\/|$)/.test(new URL(baseUrl).pathname); }
  catch { return false; }
}

function thinkingPolicyFor(baseUrl: string, modelName: string) {
  if (isInternalModelProxy(baseUrl)) return "thinking" as const;
  const hostname = hostnameFor(baseUrl);
  const model = modelName.trim();
  if ((isBailianHostname(hostname) || isOs1GatewayHostname(hostname)) && /^qwen(?:\d|[-.]|$)/i.test(model)) return "enable_thinking" as const;
  if ((hostname === "open.bigmodel.cn" && /^glm(?:[-.]|$)/i.test(model))
    || (isArkHostname(hostname) && /^(?:(?:doubao|deepseek|glm|kimi)(?:[-.]|$)|qwen(?:\d|[-.]|$))/i.test(model))) return "thinking" as const;
  return undefined;
}

function clearThinkingFields(payload: JsonRecord): JsonRecord {
  const {
    reasoning_effort: _reasoningEffort,
    thinking: _thinking,
    enable_thinking: _enableThinking,
    thinking_budget: _thinkingBudget,
    ...rest
  } = payload;
  return rest;
}

export function hasForcedToolChoice(toolChoice: unknown) {
  if (toolChoice === "required") return true;
  if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) return false;
  const choice = toolChoice as JsonRecord;
  const fn = choice.function && typeof choice.function === "object" && !Array.isArray(choice.function)
    ? choice.function as JsonRecord
    : undefined;
  return choice.type === "function" && typeof fn?.name === "string" && Boolean(fn.name.trim());
}

/**
 * Apply a verified non-thinking payload contract without changing tool
 * choice. Unknown providers deliberately receive a clean payload rather
 * than an unverified provider-specific field.
 */
export function applyProviderThinkingPolicy(input: {
  baseUrl: string;
  model: string;
  payload: JsonRecord;
}): JsonRecord {
  const payload = clearThinkingFields(input.payload);
  const policy = thinkingPolicyFor(input.baseUrl, input.model);
  if (policy === "enable_thinking") return { ...payload, enable_thinking: false };
  if (policy === "thinking") return { ...payload, thinking: { type: "disabled" } };
  return payload;
}

/**
 * Apply the provider's verified thinking contract after the request's final
 * model and tool_choice have been resolved on the server. Unknown providers
 * fail closed before any provider request is issued.
 */
export function applyProviderPayloadPolicy(input: {
  baseUrl: string;
  model: string;
  payload: JsonRecord;
}): JsonRecord {
  if (!hasForcedToolChoice(input.payload.tool_choice)) return { ...input.payload };

  const hostname = hostnameFor(input.baseUrl);
  const model = input.model.trim();
  if (hostname === "api.openai.com" && /^(?:gpt-|o\d)/i.test(model)) {
    // OpenAI's native API contract supports forced tool choice without a
    // provider-specific switch.
    return { ...input.payload };
  }
  if (!thinkingPolicyFor(input.baseUrl, input.model)) throw new ForcedToolChoiceProviderError(hostname, model);
  return applyProviderThinkingPolicy(input);
}
