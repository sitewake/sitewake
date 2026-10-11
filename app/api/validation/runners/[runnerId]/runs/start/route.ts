import { startBrowserRun } from "@/db/site-agent-store";
import { renewRunnerLease } from "@/db/runner-control-store";
import { startCapabilityTaskBrowserRun } from "@/db/capability-task-runner-store";
import type { BrowserRun } from "@/lib/site-knowledge/protocol";
import { runnerControlAuthorized, runnerJson, runnerLeaseControlInput, runnerOptions } from "../../../http";

type RouteContext = { params: Promise<{ runnerId: string }> | { runnerId: string } };
export async function OPTIONS() { return runnerOptions(); }
export async function POST(request: Request, context: RouteContext) {
  if (!runnerControlAuthorized(request)) return runnerJson({ error: "runner_session_required" }, 401);
  const { runnerId } = await context.params;
  const decodedRunnerId = decodeURIComponent(runnerId);
  try {
    const control = runnerLeaseControlInput(request, decodedRunnerId);
    const renewed = control ? await renewRunnerLease(control) : undefined;
    const run = await request.json() as BrowserRun;
    if (control && renewed?.lease.workload.kind === "capability-task") {
      return runnerJson(await startCapabilityTaskBrowserRun(control, run), 202);
    }
    return runnerJson(await startBrowserRun(decodedRunnerId, request.headers.get("x-sitewake-lease-token") || "", run), 202);
  }
  catch { return runnerJson({ error: "browser_run_start_failed", message: "Browser run could not be started." }, 500); }
}
