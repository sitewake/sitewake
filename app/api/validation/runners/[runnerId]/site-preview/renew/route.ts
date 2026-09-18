import { renewSitePreviewJobLease } from "@/db/site-agent-store";
import { authorizeRunnerInstanceSession } from "@/db/runner-control-store";
import { legacyRunnerProtocolEnabled, runnerControlAuthorized, runnerJson, runnerOptions, runnerSessionToken } from "../../../http";

type RouteContext = { params: Promise<{ runnerId: string }> | { runnerId: string } };
export async function OPTIONS() { return runnerOptions(); }
export async function POST(request: Request, context: RouteContext) {
  if (!runnerControlAuthorized(request)) return runnerJson({ error: "runner_unauthorized" }, 401);
  const { runnerId } = await context.params;
  const decodedRunnerId = decodeURIComponent(runnerId);
  const leaseToken = request.headers.get("x-sitewake-lease-token") || "";
  const body = await request.json().catch(() => ({})) as { jobId?: string };
  if (!body.jobId || !leaseToken) return runnerJson({ error: "site_preview_lease_payload_missing" }, 400);
  const sessionToken = runnerSessionToken(request);
  try { await authorizeRunnerInstanceSession(decodedRunnerId, { sessionId: request.headers.get("x-sitewake-runner-session-id") || undefined, sessionToken, legacy: !sessionToken && legacyRunnerProtocolEnabled() }); }
  catch { return runnerJson({ error: "runner_unauthorized" }, 401); }
  try { return runnerJson(await renewSitePreviewJobLease(decodedRunnerId, leaseToken, body.jobId)); }
  catch (error) { const message = error instanceof Error ? error.message : "site_preview_lease_renew_failed"; return runnerJson({ error: message, message }, message.startsWith("site_preview_lease_") ? 409 : 500); }
}
