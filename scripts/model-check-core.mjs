/**
 * The part of the model compatibility check that sends requests and judges
 * responses. Shared by two entry points that obtain the page-execution
 * request differently:
 *
 *   - `check-model-compatibility.mjs` captures it live from `@page-agent/core`
 *     (needs node_modules and esbuild).
 *   - `setup.mjs` replays the committed fixture (needs nothing installed).
 *
 * Keeping the probe and the verdict here means both entry points send the
 * same bytes and reach the same conclusion. This file must import only
 * `node:` modules and relative files.
 */
import { cli } from "./cli-copy.mjs";

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

export async function probe(stage, url, apiKey, payload, timeoutMs, locale = "en") {
  const copy = cli(locale).check;
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
export async function verifyStages({ baseUrl, apiKey, model, executionModel = model, pageRequest, applyPolicy, timeoutMs = 30_000, locale = "en" }) {
  const copy = cli(locale).check;
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
      : await probe(stage, url, apiKey, payload, timeoutMs, locale));
  }
  const passed = results.every((result) => result.ok);
  return { model, executionModel, baseUrl, passed, results };
}
