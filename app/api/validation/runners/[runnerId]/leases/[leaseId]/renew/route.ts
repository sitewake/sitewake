import { renewRunnerLease } from "@/db/runner-control-store";
import { runnerControlAuthorized, runnerJson, runnerOptions, runnerSessionToken } from "../../../../http";

type RouteContext = {
  params: Promise<{ runnerId: string; leaseId: string }> | { runnerId: string; leaseId: string };
};

export async function OPTIONS() { return runnerOptions(); }

export async function POST(request: Request, context: RouteContext) {
  const body = await request.json().catch(() => ({})) as {
    sessionId?: string;
    sessionToken?: string;
    token?: string;
    fence?: number;
  };
  if (!runnerControlAuthorized(request, body)) return runnerJson({ error: "runner_unauthorized" }, 401);
  const { runnerId, leaseId } = await context.params;
  try {
    return runnerJson(await renewRunnerLease({
      runnerId: decodeURIComponent(runnerId),
      runnerSessionId: body.sessionId || request.headers.get("x-sitewake-runner-session-id") || undefined,
      sessionToken: runnerSessionToken(request, body),
      leaseId: decodeURIComponent(leaseId),
      token: body.token || request.headers.get("x-sitewake-lease-token") || "",
      fence: Number(body.fence ?? request.headers.get("x-sitewake-control-lease-fence")),
    }));
  } catch {
    return runnerJson({ error: "runner_lease_renew_failed", message: "Runner lease could not be renewed." }, 409);
  }
}
