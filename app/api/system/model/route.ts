import { getD1Binding } from "@/db";
import { modelSettingsFromBody, publicModelSettings, saveModelSettings } from "@/lib/model-settings";
import { VERIFIED_PROVIDERS } from "@/lib/site-knowledge/provider-payload-policy";
import { managementAuthorized, siteAgentJson } from "../../site-agents/http";

/**
 * The console's model configuration. Reads return the masked key and where
 * the configuration comes from; a write becomes effective at once for every
 * reader in this process and outlives a restart (the database — Postgres in
 * the container stack, the local D1 under `npm run dev`). The form verifies
 * before it saves; this endpoint stores what it is given.
 */

export async function GET(request: Request) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  return siteAgentJson({ ...publicModelSettings(), providers: VERIFIED_PROVIDERS }, 200, { "cache-control": "no-store" });
}

export async function PUT(request: Request) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return siteAgentJson({ error: "invalid_json" }, 400); }
  const parsed = modelSettingsFromBody(body || {});
  if ("error" in parsed) return siteAgentJson({ error: parsed.error }, 400);
  try {
    await saveModelSettings(parsed.settings, getD1Binding());
  } catch (error) {
    return siteAgentJson({ error: "model_settings_save_failed", message: error instanceof Error ? error.message : "unknown" }, 503);
  }
  return siteAgentJson(publicModelSettings(), 200, { "cache-control": "no-store" });
}
