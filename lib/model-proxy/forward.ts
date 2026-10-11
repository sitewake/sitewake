import { modelChatCompletionsUrl, modelCompatibility, type ModelConfig } from "../model-config";
import { withModelProviderGate, type ModelProviderLane } from "../site-knowledge/model-provider-gate";
import { applyProviderPayloadPolicy, applyProviderThinkingPolicy } from "../site-knowledge/provider-payload-policy";

type JsonRecord = Record<string, unknown>;

/**
 * The request as the provider must see it: the configured model name and the
 * provider's verified thinking / forced-tool contract. Throws
 * `ForcedToolChoiceProviderError` for an unverified provider, before any
 * request leaves the server.
 */
export function providerPayload(config: ModelConfig, body: JsonRecord): JsonRecord {
  const compatibility = modelCompatibility(config);
  return applyProviderPayloadPolicy({
    baseUrl: config.baseUrl,
    model: config.model,
    payload: { ...body, model: config.model, ...compatibility.requestBody },
  });
}

/**
 * A worker behind the internal proxy does not know the real provider, so it
 * sends a generic request. Re-express here what the provider actually
 * accepts: the "thinking off" switch in the provider's own field, and the
 * structured-output shape the provider supports (the callers already put the
 * schema in the prompt for the `json_object` fallback).
 */
export function proxiedPayload(config: ModelConfig, body: JsonRecord): JsonRecord {
  const compatibility = modelCompatibility(config);
  let payload: JsonRecord = { ...body };
  if (wantsThinkingOff(payload)) payload = applyProviderThinkingPolicy({ baseUrl: config.baseUrl, model: config.model, payload });
  const responseFormat = payload.response_format as JsonRecord | undefined;
  if (!compatibility.nativeJsonSchema && responseFormat?.type === "json_schema") payload.response_format = { type: "json_object" };
  if (compatibility.omitStructuredMaxTokens && payload.response_format) delete payload.max_tokens;
  return providerPayload(config, payload);
}

function wantsThinkingOff(payload: JsonRecord) {
  const thinking = payload.thinking as JsonRecord | undefined;
  return payload.enable_thinking === false || thinking?.type === "disabled" || payload.reasoning_effort === "none";
}

/**
 * One provider HTTP request, spaced by the per-provider gate. The caller
 * consumes the body. `lane` says whether someone is waiting for it: a request
 * from a widget is interactive, a runner's authoring turn is background, and
 * the two queue independently.
 */
export function forwardToProvider(config: ModelConfig, payload: JsonRecord, signal?: AbortSignal, lane: ModelProviderLane = "background") {
  return withModelProviderGate(config, () => fetch(modelChatCompletionsUrl(config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(payload),
    signal,
  }), lane);
}

export function isEventStream(contentType: string | null | undefined) {
  return /text\/event-stream/i.test(contentType || "");
}
