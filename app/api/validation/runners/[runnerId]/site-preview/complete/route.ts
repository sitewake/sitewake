import { completeSitePreviewJob, failSitePreviewJob } from "@/db/site-agent-store";
import { authorizeRunnerInstanceSession } from "@/db/runner-control-store";
import type { SitePreviewResult } from "@/lib/site-knowledge/protocol";
import { normalizeDetectedSiteAgentIds } from "@/lib/site-knowledge/site-preview-detection";
import { legacyRunnerProtocolEnabled, runnerControlHeadersPlausible, runnerJson, runnerOptions, runnerSessionToken } from "../../../http";

type RouteContext = { params: Promise<{ runnerId: string }> | { runnerId: string } };
export async function OPTIONS() { return runnerOptions(); }
export async function POST(request: Request, context: RouteContext) {
  if (!runnerControlHeadersPlausible(request, { requireLease: true })) return runnerJson({ error: "runner_unauthorized" }, 401);
  const { runnerId } = await context.params;
  const decodedRunnerId = decodeURIComponent(runnerId);
  const token = request.headers.get("x-sitewake-lease-token") || "";
  const sessionToken = runnerSessionToken(request);
  try { await authorizeRunnerInstanceSession(decodedRunnerId, { sessionId: request.headers.get("x-sitewake-runner-session-id") || undefined, sessionToken, legacy: !sessionToken && legacyRunnerProtocolEnabled() }); }
  catch { return runnerJson({ error: "runner_unauthorized" }, 401); }
  const body = await request.json().catch(() => ({})) as { jobId?: string; preview?: SitePreviewResult; error?: string };
  if (!body.jobId) return runnerJson({ error: "site_preview_complete_payload_missing" }, 400);
  // Site ids are copied from the previewed site's HTML, the only part of this payload
  // decided by a third-party page. The runner clamped once; this is the boundary before
  // storage, clamp again.
  const preview = body.preview && {
    ...body.preview,
    ...(body.preview.detectedSiteAgentIds === undefined
      ? {}
      : { detectedSiteAgentIds: normalizeDetectedSiteAgentIds(body.preview.detectedSiteAgentIds) }),
  };
  try {
    const result = preview ? await completeSitePreviewJob(decodedRunnerId, token, body.jobId, preview) : await failSitePreviewJob(decodedRunnerId, token, body.jobId, body.error || "site_preview_failed");
    return runnerJson(result);
  } catch (error) { const message = error instanceof Error ? error.message : "site_preview_complete_failed"; return runnerJson({ error: message, message }, message === "site_preview_job_missing" || message === "site_agent_not_found" ? 404 : message.startsWith("site_preview_lease_") ? 409 : 500); }
}
