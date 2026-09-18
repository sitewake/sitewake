import { renewCrawlJobLease } from "@/db/site-agent-store";
import { authorizeRunnerInstanceSession } from "@/db/runner-control-store";
import {
  legacyRunnerProtocolEnabled,
  runnerControlAuthorized,
  runnerJson,
  runnerOptions,
  runnerSessionToken,
} from "../../../http";

type RouteContext = {
  params: Promise<{ runnerId: string }> | { runnerId: string };
};

export async function OPTIONS() {
  return runnerOptions();
}

export async function POST(request: Request, context: RouteContext) {
  if (!runnerControlAuthorized(request)) {
    return runnerJson({ error: "runner_unauthorized" }, 401);
  }
  const { runnerId } = await context.params;
  const decodedRunnerId = decodeURIComponent(runnerId);
  const leaseToken = request.headers.get("x-sitewake-lease-token") || "";
  const body = await request.json().catch(() => ({})) as { jobId?: string };
  if (!body.jobId || !leaseToken) {
    return runnerJson({ error: "crawl_lease_payload_missing" }, 400);
  }
  const sessionToken = runnerSessionToken(request);
  try {
    await authorizeRunnerInstanceSession(decodedRunnerId, {
      sessionId: request.headers.get("x-sitewake-runner-session-id") || undefined,
      sessionToken,
      legacy: !sessionToken && legacyRunnerProtocolEnabled(),
    });
  } catch {
    return runnerJson({ error: "runner_unauthorized" }, 401);
  }
  try {
    const result = await renewCrawlJobLease(
      decodedRunnerId,
      leaseToken,
      body.jobId,
    );
    return runnerJson(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "crawl_lease_renew_failed";
    return runnerJson(
      { error: message.split(":", 1)[0], message },
      message === "crawl_job_missing" || message === "site_agent_not_found" ? 404 : message.startsWith("crawl_lease_") ? 409 : 500,
    );
  }
}
