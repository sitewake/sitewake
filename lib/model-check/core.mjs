/**
 * The part of the model compatibility check that sends requests and judges
 * responses. Shared by three entry points that obtain the page-execution
 * request differently:
 *
 *   - `scripts/check-model-compatibility.mjs` captures it live from
 *     `@page-agent/core` (needs node_modules and esbuild).
 *   - `scripts/setup.mjs` replays the committed fixture (needs nothing installed).
 *   - the console's `POST /api/system/model/verify` replays the same fixture
 *     on the server, so a model saved in the console passed the same probe.
 *
 * Keeping the probe and the verdict here means every entry point sends the
 * same bytes and reaches the same conclusion. This file must import only
 * `node:` modules; person-facing messages are injected (`messages`), so it
 * depends on no catalog.
 */

/** English defaults; callers pass a localized set with the same keys. */
export const DEFAULT_MESSAGES = Object.freeze({
  noValidToolCall: "The model did not return the required valid tool call.",
  emptyOrInvalidChat: "The model returned an empty or invalid chat response.",
  incompleteConfig: "Model configuration is incomplete.",
  baseUrlInvalid: "The model service URL must be an HTTP(S) URL without embedded credentials.",
  policyPrefix: "provider payload policy",
});

export function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl).replace(/\/$/, "");
  return /\/v\d+$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

/** Mirrors the routing turn: streamed, tool-using, low temperature. */
export function routingRequest(model) {
  return {
    model,
    stream: true,
    temperature: 0.2,
    tool_choice: "auto",
    messages: [
      { role: "system", content: "compatibility probe" },
      { role: "user", content: "ping" },
    ],
    tools: [{
      type: "function",
      function: {
        name: "search_site_knowledge",
        description: "Search the site knowledge base.",
        parameters: {
          type: "object",
          properties: { keywords: { type: "array", items: { type: "string" } } },
          required: ["keywords"],
          additionalProperties: false,
        },
      },
    }],
  };
}

export async function probe(stage, url, apiKey, payload, timeoutMs, messages = DEFAULT_MESSAGES) {
  const copy = { ...DEFAULT_MESSAGES, ...messages };
  const started = Date.now();
  const redact = (text) => String(text).split(apiKey).join("[redacted]");
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const durationMs = Date.now() - started;
    if (response.ok) {
      const body = await response.json().catch(() => null);
      const message = body?.choices?.[0]?.message;
      const calls = message?.tool_calls;
      const names = new Set((payload.tools || []).map((tool) => tool.function?.name));
      const validCall = (call) => {
        if (call?.type !== "function" || !names.has(call.function?.name)) return false;
        try {
          const args = JSON.parse(call.function.arguments);
          return args !== null && typeof args === "object" && !Array.isArray(args);
        } catch { return false; }
      };
      const forced = payload.tool_choice === "required" || payload.tool_choice?.type === "function";
      const toolResponse = Array.isArray(calls) && calls.length > 0 && calls.every(validCall)
        && (payload.tool_choice?.type !== "function" || calls.every((call) => call.function.name === payload.tool_choice.function.name));
      const valid = forced ? toolResponse : toolResponse || (typeof message?.content === "string" && Boolean(message.content.trim()));
      return { stage, ok: valid, status: response.status, durationMs: Date.now() - started,
        ...(!valid ? { detail: forced ? copy.noValidToolCall : copy.emptyOrInvalidChat } : {}) };
    }
    const text = await response.text().catch(() => "");
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = [parsed?.error?.code, parsed?.error?.type, parsed?.error?.message].filter(Boolean).join(" | ") || text;
    } catch { /* Not JSON. */ }
    return { stage, ok: false, status: response.status, durationMs, detail: redact(detail).replace(/\s+/g, " ").slice(0, 400) };
  } catch (error) {
    return { stage, ok: false, status: 0, durationMs: Date.now() - started, detail: redact(error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * Run both stages against a provider.
 *
 * `pageRequest` is the request body the page-execution library builds (the
 * live capture or the committed fixture); `applyPolicy` is the provider
 * payload policy the server proxy applies before anything reaches a provider.
 * Probing the raw library request would fail on models that actually work,
 * because several providers require thinking mode to be switched off whenever
 * tool_choice is forced.
 */
export async function verifyStages({ baseUrl, apiKey, model, executionModel = model, pageRequest, applyPolicy, timeoutMs = 30_000, messages = DEFAULT_MESSAGES }) {
  const copy = { ...DEFAULT_MESSAGES, ...messages };
  if (!apiKey || !baseUrl || !model) throw new Error(copy.incompleteConfig);
  const parsed = new URL(baseUrl);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(copy.baseUrlInvalid);
  const url = chatCompletionsUrl(baseUrl);

  const withPolicy = (payload, targetModel) => {
    try { return applyPolicy({ baseUrl, model: targetModel, payload }); }
    catch (error) {
      // The policy refuses unknown providers rather than guessing. That is a
      // genuine incompatibility, not a probe artefact.
      return { __policyError: error instanceof Error ? error.message : String(error) };
    }
  };
  const pagePayload = withPolicy({ ...pageRequest, model: executionModel, stream: false }, executionModel);
  const routingPayload = withPolicy({ ...routingRequest(model), stream: false }, model);
  const results = [];
  for (const [stage, payload] of [["runtime-router", routingPayload], ["runtime-page-agent", pagePayload]]) {
    results.push(payload.__policyError
      ? { stage, ok: false, status: 0, durationMs: 0, detail: `${copy.policyPrefix}: ${payload.__policyError}` }
      : await probe(stage, url, apiKey, payload, timeoutMs, copy));
  }
  const passed = results.every((result) => result.ok);
  return { model, executionModel, baseUrl, passed, results };
}

/**
 * The one-line diagnosis for a failed verification, as a code the caller
 * turns into words: the key was refused, the URL is off by a `/v1`, nothing
 * answered, or the model chats but cannot drive a page.
 */
export function failureHint(results, messages = DEFAULT_MESSAGES) {
  const stages = results || [];
  const statuses = new Set(stages.map((stage) => stage.status));
  if (statuses.has(401) || statuses.has(403)) return "401";
  if (statuses.has(404)) return "404";
  if (stages.some((stage) => stage.status === 0 && String(stage.detail || "").startsWith(`${messages.policyPrefix || DEFAULT_MESSAGES.policyPrefix}:`))) return "policy";
  if (statuses.has(0)) return "network";
  return stages.some((stage) => !stage.ok) ? "page" : undefined;
}
