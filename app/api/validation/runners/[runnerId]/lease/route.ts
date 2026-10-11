import { leaseRunnerWork, type RunnerWorkQueue } from "@/db/site-agent-store";
import { leaseCapabilityTaskWork } from "@/db/capability-task-runner-store";
import { runnerControlAuthorized, runnerJson, runnerOptions, runnerSessionToken } from "../../http";

type RouteContext = { params: Promise<{ runnerId: string }> | { runnerId: string } };
export async function OPTIONS() { return runnerOptions(); }
export async function POST(request: Request, context: RouteContext) {
  const { runnerId } = await context.params;
  try {
    const body = await request.json().catch(() => ({})) as { queue?: RunnerWorkQueue; sessionId?: string; sessionToken?: string };
    if (!runnerControlAuthorized(request, body)) return runnerJson({ error: "runner_unauthorized" }, 401);
    const queue: RunnerWorkQueue = ["interactive", "background", "author", "validate", "crawl"].includes(body.queue || "") ? body.queue! : "any";
    const decodedRunnerId = decodeURIComponent(runnerId);
    const control = {
      sessionId: body.sessionId || request.headers.get("x-sitewake-runner-session-id") || undefined,
      sessionToken: runnerSessionToken(request, body),
    };
    const capabilityTask = await leaseCapabilityTaskWork(decodedRunnerId, queue, control);
    if (capabilityTask.lease) return runnerJson(capabilityTask);
    return runnerJson(await leaseRunnerWork(decodedRunnerId, queue, control));
  }
  catch (error) {
    console.error("runner_lease_failed", error);
    return runnerJson({ error: "runner_lease_failed", message: "Runner work could not be leased." }, 500);
  }
}
