import { secretEquals } from "@/lib/access-control/session";
import { boundedJsonErrorStatus, readBoundedJson } from "@/lib/http/bounded-json";
import { withStreamLifecycle } from "@/lib/http/stream-lifecycle";
import { getModelConfig, type ModelRole } from "@/lib/model-config";
import { forwardToProvider, isEventStream, proxiedPayload } from "@/lib/model-proxy/forward";
import { ForcedToolChoiceProviderError } from "@/lib/site-knowledge/provider-payload-policy";

/**
 * The model endpoint for workers and the runtime launcher: an OpenAI-compatible
 * chat-completions URL per role, so their existing client code does not change.
 * Only this process holds the provider key; callers present the internal token
 * they already carry for the other internal endpoints. There is no per-caller
 * budget here — these are the installation's own processes.
 */

const ROLES: readonly ModelRole[] = ["general", "semantic", "execution"];
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
// Above the longest worker-side deadline (180 s), so the worker times out first
// and the proxy never cuts a request the worker is still waiting on.
const PROXY_TIMEOUT_MS = 300_000;

function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

async function internalTokenAuthorized(request: Request) {
  const configured = process.env.CAPABILITY_V2_DISPATCH_TOKEN?.trim() || process.env.CAPABILITY_V2_RUNNER_TOKEN?.trim();
  if (!configured) return false;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
  return bearer ? secretEquals(bearer, configured) : false;
}

export async function POST(request: Request, context: { params: Promise<{ role: string }> | { role: string } }) {
  if (!(await internalTokenAuthorized(request))) return json({ error: { code: "unauthorized" } }, 401);
  const { role } = await context.params;
  if (!ROLES.includes(role as ModelRole)) return json({ error: { code: "invalid_model_role" } }, 404);
  const config = getModelConfig(role as ModelRole);
  // `proxy` here would mean this process is itself pointed at a proxy: never forward in a loop.
  if (!config.configured || config.source === "proxy") return json({ error: { code: "model_not_configured" } }, 503);

  let body: Record<string, unknown>;
  try { body = await readBoundedJson(request, MAX_REQUEST_BYTES); }
  catch (error) {
    const status = boundedJsonErrorStatus(error) || 400;
    return json({ error: { code: status === 413 ? "request_body_too_large" : "invalid_json" } }, status);
  }
  let payload: Record<string, unknown>;
  try { payload = proxiedPayload(config, body); }
  catch (error) {
    if (error instanceof ForcedToolChoiceProviderError) return json({ error: { code: error.code, message: error.message } }, 422);
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  try {
    const response = await forwardToProvider(config, payload, controller.signal);
    const contentType = response.headers.get("content-type") || "application/json";
    const passthrough: Record<string, string> = {};
    for (const name of ["retry-after", "x-ratelimit-reset-requests"]) {
      const value = response.headers.get(name);
      if (value) passthrough[name] = value;
    }
    if (response.ok && body.stream === true && isEventStream(contentType) && response.body) {
      const stream = withStreamLifecycle(response.body, () => clearTimeout(timeout), { timeoutMs: PROXY_TIMEOUT_MS, onTimeout: () => controller.abort() });
      return new Response(stream, { status: response.status, headers: { "content-type": contentType, "cache-control": "no-store" } });
    }
    const text = await response.text();
    clearTimeout(timeout);
    return new Response(text, { status: response.status, headers: { "content-type": contentType, "cache-control": "no-store", ...passthrough } });
  } catch (error) {
    clearTimeout(timeout);
    return json({ error: { code: "model_proxy_failed", message: error instanceof Error ? error.message : "unknown" } }, 502);
  }
}
