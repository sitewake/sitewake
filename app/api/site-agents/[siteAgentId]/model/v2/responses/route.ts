import { NextRequest, NextResponse } from "next/server";
import { readModelResponseConversation, saveModelResponseConversation } from "@/db/model-response-store";
import { getModelConfig, modelChatCompletionsUrl } from "@/lib/model-config";
import { withModelProviderGate } from "@/lib/site-knowledge/model-provider-gate";
import { secretEquals } from "@/lib/access-control/session";
import { boundedJsonErrorStatus, readBoundedJson } from "@/lib/http/bounded-json";
import { applyProviderPayloadPolicy, ForcedToolChoiceProviderError } from "@/lib/site-knowledge/provider-payload-policy";
import {
  appendResponsesOutput,
  authoringResponsesTools,
  chatToResponse,
  continueResponsesConversation,
  responseEventStream,
  responsesToChatRequest,
} from "@/lib/site-knowledge/responses-protocol";
import { SITE_AGENT_CORS_HEADERS, siteAgentJson, siteAgentOptions } from "../../../../http";

export async function OPTIONS() { return siteAgentOptions(); }

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };
const MAX_MODEL_REQUEST_BYTES = 1024 * 1024;

export async function POST(request: NextRequest, context: RouteContext) {
  const { siteAgentId: encoded } = await context.params;
  const siteAgentId = decodeURIComponent(encoded || "").trim();
  if (!siteAgentId) return siteAgentJson({ error: { code: "site_agent_id_required" } }, 400);
  const config = getModelConfig("execution");
  if (!config.configured) return siteAgentJson({ error: { code: "model_not_configured" } }, 503);
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
  if (!bearer || !(await secretEquals(bearer, config.apiKey))) {
    return siteAgentJson({ error: { code: "model_proxy_unauthorized" } }, 401);
  }
  let body: Record<string, unknown>;
  try { body = await readBoundedJson(request, MAX_MODEL_REQUEST_BYTES); }
  catch (error) {
    const status = boundedJsonErrorStatus(error) || 400;
    return siteAgentJson({ error: { code: status === 413 ? "request_body_too_large" : "invalid_json" } }, status);
  }
  const continued = continueResponsesConversation(body, await readModelResponseConversation(siteAgentId, body.previous_response_id));
  const restrictedTools = authoringResponsesTools(continued.body.tools);
  const restrictedConversation = { ...continued.conversation, tools: restrictedTools };
  let payload: Record<string, unknown>;
  try {
    payload = applyProviderPayloadPolicy({
      baseUrl: config.baseUrl,
      model: config.model,
      payload: responsesToChatRequest({ ...continued.body, tools: restrictedTools }, config.model),
    });
  } catch (error) {
    if (error instanceof ForcedToolChoiceProviderError) {
      return siteAgentJson({ error: { code: error.code, message: error.message } }, 422);
    }
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await withModelProviderGate(config, () => fetch(modelChatCompletionsUrl(config.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }));
    const text = await response.text();
    if (!response.ok) return new NextResponse(text, { status: response.status, headers: {
      ...SITE_AGENT_CORS_HEADERS,
      "content-type": response.headers.get("content-type") || "application/json",
      ...((response.status === 429 && (response.headers.get("retry-after") || response.headers.get("x-ratelimit-reset-requests")))
        ? { "retry-after": response.headers.get("retry-after") || response.headers.get("x-ratelimit-reset-requests")! }
        : {}),
    } });
    const adapted = chatToResponse(JSON.parse(text), config.model);
    await saveModelResponseConversation(siteAgentId, adapted.id, appendResponsesOutput(restrictedConversation, adapted.output));
    if (body.stream === true) return new NextResponse(responseEventStream(adapted), { status: 200, headers: { ...SITE_AGENT_CORS_HEADERS, "content-type": "text/event-stream", "cache-control": "no-store" } });
    return NextResponse.json(adapted, { headers: SITE_AGENT_CORS_HEADERS });
  } catch (error) {
    return siteAgentJson({ error: { code: "model_proxy_failed", message: error instanceof Error ? error.message : "unknown" } }, 502);
  } finally {
    clearTimeout(timeout);
  }
}
