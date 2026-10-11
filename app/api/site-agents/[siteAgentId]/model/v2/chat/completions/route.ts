import { NextRequest, NextResponse } from "next/server";
import { getModelConfig } from "@/lib/model-config";
import { forwardToProvider, isEventStream, providerPayload } from "@/lib/model-proxy/forward";
import { normalizeAgentToolEnvelope } from "@/lib/site-knowledge/model-protocol";
import { acquireRuntimeModelBudget } from "@/lib/site-knowledge/runtime-model-budget";
import { recordModelInvocation } from "@/db/site-agent-store";
import { AGENT_RUN_RUNTIME_MODEL_REQUEST_LIMIT, consumeAgentRunRuntimeModelRequest, getSiteAgentRunByToken } from "@/db/agent-run-store";
import { boundedJsonErrorStatus, readBoundedJson } from "@/lib/http/bounded-json";
import { withStreamLifecycle } from "@/lib/http/stream-lifecycle";
import { ForcedToolChoiceProviderError } from "@/lib/site-knowledge/provider-payload-policy";
import { uid, type ModelInvocation, type ModelInvocationStage } from "@/lib/site-knowledge/protocol";
import { agentRunError, runToken } from "../../../../../../agent-runs/http";
import { SITE_AGENT_CORS_HEADERS, brandedHeader, siteAgentJson, siteAgentOptions } from "../../../../../http";
import { redactSensitiveText } from "@/lib/site-knowledge/sensitive-data";

const MAX_MODEL_REQUEST_BYTES = 1024 * 1024;
// Runtime routing uses the same real-provider budget as capability authoring.
// Keep a generous deadline so a slow Qwen response is not mistaken for a
// browser handoff failure; the client applies the same limit.
const RUNTIME_MODEL_TIMEOUT_MS = 180_000;

function modelInvocationPersistenceFailure() {
  return siteAgentJson({ error: { code: "model_invocation_persist_failed" } }, 503);
}

function reportStreamInvocationPersistenceFailure(error: unknown) {
  // A stream may already be on the wire when its terminal telemetry is saved.
  // The failure cannot change that response, but it must remain observable.
  console.error("model_invocation_persist_failed", error instanceof Error ? error.name : "unknown");
}

export async function OPTIONS() { return siteAgentOptions(); }
/**
 * Reduce a provider error body to something an operator can act on. Bounded so
 * a verbose provider cannot bloat the invocation record, and stripped of the
 * usual credential-shaped values before it is stored.
 */
export function modelProviderErrorDetail(body: string | undefined, limit = 400) {
  if (!body) return undefined;
  let text = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; code?: string; type?: string } };
    const error = parsed?.error;
    if (error) text = [error.code, error.type, error.message].filter(Boolean).join(" | ") || body;
  } catch { /* Not JSON; fall back to the raw text. */ }
  return redactSensitiveText(text).replace(/\s+/g, " ").trim().slice(0, limit) || undefined;
}

export async function POST(request: NextRequest, context: { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } }) {
  const { siteAgentId: rawSiteAgentId } = await context.params;
  const siteAgentId = decodeURIComponent(rawSiteAgentId || "");
  const token = runToken(request);
  if (!token) return siteAgentJson({ error: { code: "agent_run_token_required" } }, 401);
  let authenticatedRunId: string;
  try { authenticatedRunId = (await getSiteAgentRunByToken(siteAgentId, token, request.headers.get("origin"))).run.id; }
  catch (error) { return agentRunError(error); }
  const config = getModelConfig("execution");
  if (!config.configured) return siteAgentJson({ error: { code: "model_not_configured", message: "SiteWake 服务端尚未配置模型凭证。" } }, 503);
  let body: Record<string, unknown>;
  try { body = await readBoundedJson(request, MAX_MODEL_REQUEST_BYTES); }
  catch (error) {
    const status = boundedJsonErrorStatus(error) || 400;
    return siteAgentJson({ error: { code: status === 413 ? "request_body_too_large" : "invalid_json" } }, status);
  }
  let upstreamPayload: Record<string, unknown>;
  try {
    upstreamPayload = providerPayload(config, { ...body, parallel_tool_calls: false });
  } catch (error) {
    if (error instanceof ForcedToolChoiceProviderError) {
      return siteAgentJson({ error: { code: error.code, message: error.message } }, 422);
    }
    throw error;
  }
  // Create the abort handle for the upstream call first: when the same run sends
  // another request (a browser retry after a first-byte timeout), the budget
  // supersedes the still-pending call instead of letting the retry collide with
  // its own zombie request and get a 429.
  const controller = new AbortController();
  let superseded = false;
  const budget = acquireRuntimeModelBudget({
    siteAgentId,
    runId: authenticatedRunId,
    abort: () => { superseded = true; controller.abort(); },
  });
  if (!budget.allowed) {
    return siteAgentJson(
      { error: { code: "model_rate_limited", reason: budget.reason } },
      429,
      { "retry-after": String(budget.retryAfterSeconds) },
    );
  }
  const invocationId = uid("model_call");
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const requestedStage = brandedHeader(request, "ai-stage") || "runtime-agent";
  const stage: ModelInvocationStage = ["profile", "scene-review", "capability-design", "author-plan", "author-program", "outcome-judge", "runtime-agent", "runtime-router", "runtime-page-agent", "runtime-boundary", "input-binding", "human-boundary"].includes(requestedStage) ? requestedStage as ModelInvocationStage : "runtime-agent";
  const learningJobId = brandedHeader(request, "learning-job-id") || undefined;
  const estimatedPromptTokens = Math.max(1, Math.ceil(JSON.stringify(body.messages || body).length / 4));
  const persist = (patch: Partial<ModelInvocation>) => recordModelInvocation({ id: invocationId, siteAgentId, learningJobId, stage, model: config.model, status: "running", usageExact: false, promptTokens: estimatedPromptTokens, startedAt, ...patch });
  try { await persist({ status: "running" }); }
  catch {
    budget.release();
    return modelInvocationPersistenceFailure();
  }
  const timeout = setTimeout(() => controller.abort(), RUNTIME_MODEL_TIMEOUT_MS);
  let budgetOwnedByStream = false;
  try {
    const attempts: Array<Record<string, unknown>> = [
      upstreamPayload,
    ];
    let failure: { status: number; text: string; contentType: string; retryAfter?: string } | undefined;
    for (const payload of attempts) {
      try {
        await consumeAgentRunRuntimeModelRequest(authenticatedRunId, { token, stage });
      } catch (error) {
        const code = error instanceof Error ? error.message.split(":")[0] : "agent_run_model_budget_persist_failed";
        try {
          await persist({ status: "failed", durationMs: Date.now() - started, endedAt: new Date().toISOString(), errorCode: code });
        } catch {
          return modelInvocationPersistenceFailure();
        }
        if (code === "agent_run_model_budget_exhausted") {
          return siteAgentJson({ error: { code, limit: AGENT_RUN_RUNTIME_MODEL_REQUEST_LIMIT } }, 429);
        }
        if (code === "agent_run_model_budget_terminal") {
          return siteAgentJson({ error: { code } }, 409);
        }
        return agentRunError(error);
      }
      // Runtime requests are side-effecting budget units. One authenticated proxy
      // request maps to exactly one provider HTTP request; callers may start a new
      // explicitly budgeted model round after a transport failure.
      // A person is waiting on this one: it queues apart from the runners.
      const response = await forwardToProvider(config, payload, controller.signal, "interactive");
      const contentType = response.headers.get("content-type") || "application/json";
      if (response.ok) {
        // The page Agent uses the standard OpenAI SSE envelope when it wants
        // to render an answer incrementally.  Do not buffer it here: buffering
        // made a provider that was already streaming look frozen to users.
        // Tool calls are accumulated by the SDK; the proxy deliberately stays
        // transparent for this standard protocol.
        if (body.stream === true && isEventStream(contentType) && response.body) {
          const stream = withStreamLifecycle(response.body, (settlement) => {
            clearTimeout(timeout);
            budget.release();
            if (settlement.status === "completed") {
              const completionTokens = Math.max(1, Math.ceil(settlement.bytes / 4));
              void persist({ status: "succeeded", promptTokens: estimatedPromptTokens, completionTokens, totalTokens: estimatedPromptTokens + completionTokens, usageExact: false, durationMs: Date.now() - started, endedAt: new Date().toISOString() })
                .catch(reportStreamInvocationPersistenceFailure);
            } else {
              void persist({ status: "failed", durationMs: Date.now() - started, endedAt: new Date().toISOString(), errorCode: superseded ? "superseded" : settlement.status === "cancelled" ? "stream_cancelled" : "stream_read_failed" })
                .catch(reportStreamInvocationPersistenceFailure);
            }
          }, { timeoutMs: RUNTIME_MODEL_TIMEOUT_MS, onTimeout: () => controller.abort() });
          // The concurrency slot follows delivery of the SSE body, not merely
          // receipt of upstream headers or construction of this Response.
          const streamedResponse = new NextResponse(stream, { status: response.status, headers: { ...SITE_AGENT_CORS_HEADERS, "content-type": contentType, "cache-control": "no-store" } });
          budgetOwnedByStream = true;
          return streamedResponse;
        }
        const responseText = await response.text();
        let parsedBody: Record<string, unknown> | undefined;
        try { parsedBody = JSON.parse(responseText) as Record<string, unknown>; } catch { /* non-JSON provider response */ }
        const usage = parsedBody?.usage && typeof parsedBody.usage === "object" ? parsedBody.usage as Record<string, unknown> : undefined;
        const promptTokens = Number(usage?.prompt_tokens || usage?.input_tokens || estimatedPromptTokens);
        const completionTokens = Number(usage?.completion_tokens || usage?.output_tokens || Math.ceil(responseText.length / 4));
        const cachedPromptTokens = Number(usage?.prompt_cache_hit_tokens || (usage?.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens || 0);
        try {
          await persist({ status: "succeeded", promptTokens, completionTokens, cachedPromptTokens, totalTokens: Number(usage?.total_tokens || promptTokens + completionTokens), usageExact: Boolean(usage), durationMs: Date.now() - started, endedAt: new Date().toISOString() });
        } catch {
          return modelInvocationPersistenceFailure();
        }
        try {
          const normalized = normalizeAgentToolEnvelope(payload, parsedBody || JSON.parse(responseText));
          return new NextResponse(JSON.stringify(normalized), { status: response.status, headers: { ...SITE_AGENT_CORS_HEADERS, "content-type": "application/json" } });
        } catch {
          return new NextResponse(responseText, { status: response.status, headers: { ...SITE_AGENT_CORS_HEADERS, "content-type": contentType } });
        }
      }
      const text = await response.text();
      failure = { status: response.status, text, contentType, retryAfter: response.headers.get("retry-after") || response.headers.get("x-ratelimit-reset-requests") || undefined };
      break;
    }
    try {
      await persist({
        status: "failed",
        durationMs: Date.now() - started,
        endedAt: new Date().toISOString(),
        errorCode: `http_${failure?.status || 502}`,
        httpStatus: failure?.status,
        // Keep enough of the provider's own words to tell a rejected request
        // shape from an exhausted quota. Redacted and bounded: this record is
        // read by operators, not replayed.
        errorDetail: modelProviderErrorDetail(failure?.text),
      });
    } catch {
      return modelInvocationPersistenceFailure();
    }
    const retryAfter = failure?.status === 429 ? failure.retryAfter || "5" : undefined;
    return new NextResponse(failure?.text || JSON.stringify({ error: { code: "model_proxy_failed" } }), { status: failure?.status || 502, headers: {
      ...SITE_AGENT_CORS_HEADERS,
      "content-type": failure?.contentType || "application/json",
      ...(retryAfter ? { "retry-after": retryAfter } : {}),
    } });
  } catch (error) {
    try {
      await persist({ status: "failed", durationMs: Date.now() - started, endedAt: new Date().toISOString(), errorCode: superseded ? "superseded" : error instanceof Error ? error.name : "model_proxy_failed" });
    } catch {
      return modelInvocationPersistenceFailure();
    }
    return siteAgentJson({ error: { code: "model_proxy_failed", message: error instanceof Error ? error.message : "unknown" } }, 502);
  } finally {
    if (!budgetOwnedByStream) budget.release();
    if (!budgetOwnedByStream) clearTimeout(timeout);
  }
}
