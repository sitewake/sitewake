import { failureHint, verifyStages } from "@/lib/model-check/core.mjs";
import { applyProviderPayloadPolicy } from "@/lib/site-knowledge/provider-payload-policy";
import pageRequest from "@/scripts/fixtures/page-execution-request.json";
import { modelSettingsFromBody } from "@/lib/model-settings";
import { managementAuthorized, siteAgentJson } from "../../../site-agents/http";

// The same two real requests the setup wizard and `check:model-compat` send:
// a chat-routing turn and the committed page-execution request with a forced
// tool call. Nothing is saved here; the form saves after this passes.
const VERIFY_TIMEOUT_MS = 30_000;

export async function POST(request: Request) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return siteAgentJson({ error: "invalid_json" }, 400); }
  const parsed = modelSettingsFromBody(body || {});
  if ("error" in parsed) return siteAgentJson({ error: parsed.error }, 400);
  const { settings } = parsed;
  const started = Date.now();
  try {
    const result = await verifyStages({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      executionModel: settings.executionModel || settings.model,
      pageRequest,
      applyPolicy: applyProviderPayloadPolicy,
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
    const results = result.results.map((stage) => ({ stage: stage.stage, ok: stage.ok, status: stage.status, durationMs: stage.durationMs, ...(stage.detail ? { detail: stage.detail } : {}) }));
    return siteAgentJson({ ok: result.passed, results, hint: result.passed ? undefined : failureHint(results), durationMs: Date.now() - started }, 200, { "cache-control": "no-store" });
  } catch (error) {
    return siteAgentJson({ ok: false, error: "model_verify_failed", message: error instanceof Error ? error.message : String(error), hint: "retry" }, 200, { "cache-control": "no-store" });
  }
}
