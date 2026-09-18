import { completeAuthoring, completeValidation, resolveBrowserRunLeaseControl } from "@/db/site-agent-store";
import { completeCapabilityTaskBrowserRun } from "@/db/capability-task-runner-store";
import { abortRunnerLeaseCompletion, acquireRunnerLeaseCompletion, authorizeRunnerInstanceSession, completeRunnerLease } from "@/db/runner-control-store";
import type { BrowserRun, KnowledgeCandidate } from "@/lib/site-knowledge/protocol";
import { maybeAutoApproveCapabilityTask } from "@/lib/capability-center/auto-approval";
import { boundedJsonErrorStatus, readBoundedJson } from "@/lib/http/bounded-json";
import { legacyRunnerProtocolEnabled, runnerControlErrorStatus, runnerControlHeadersPlausible, runnerJson, runnerLeaseControlInput, runnerOptions, runnerSessionToken } from "../../../http";

type RouteContext = { params: Promise<{ runnerId: string }> | { runnerId: string } };
export async function OPTIONS() { return runnerOptions(); }
export async function POST(request: Request, context: RouteContext) {
  if (!runnerControlHeadersPlausible(request, { requireLease: true })) {
    return runnerJson({ error: "runner_session_required" }, 401);
  }
  const { runnerId } = await context.params;
  const decodedRunnerId = decodeURIComponent(runnerId);
  const sessionToken = runnerSessionToken(request);
  try {
    await authorizeRunnerInstanceSession(decodedRunnerId, {
      sessionId: request.headers.get("x-sitewake-runner-session-id") || undefined,
      sessionToken,
      legacy: !sessionToken && legacyRunnerProtocolEnabled(),
    });
  } catch {
    return runnerJson({ error: "runner_session_required" }, 401);
  }
  let body: { run?: BrowserRun; candidate?: KnowledgeCandidate };
  try {
    body = await readBoundedJson(request, 5 * 1024 * 1024);
  } catch (error) {
    const status = boundedJsonErrorStatus(error) || 400;
    return runnerJson({ error: status === 413 ? "browser_run_complete_too_large" : "invalid_json" }, status);
  }
  if (!body.run || typeof body.run !== "object") {
    return runnerJson({ error: "browser_run_required" }, 400);
  }
  if (body.run.status !== "passed" && body.run.status !== "failed") {
    return runnerJson({ error: "browser_run_not_terminal" }, 409);
  }
  const token = request.headers.get("x-sitewake-lease-token") || "";
  let completionControl: Parameters<typeof acquireRunnerLeaseCompletion>[0] | undefined;
  let completionOwned = false;
  let capabilityTaskCompletion = false;
  try {
    const control = runnerLeaseControlInput(request, decodedRunnerId)
      || await resolveBrowserRunLeaseControl(decodedRunnerId, token, body.run);
    completionControl = control;
    const beginning = control ? await acquireRunnerLeaseCompletion(control) : undefined;
    capabilityTaskCompletion = beginning?.lease.workload.kind === "capability-task";
    if (beginning?.duplicate) {
      if (beginning.inProgress) {
        return runnerJson({ error: "runner_lease_completion_busy", message: "Runner completion is still in progress." }, 409);
      }
      return runnerJson(beginning.lease.completion?.result ?? { duplicate: true });
    }
    completionOwned = Boolean(beginning);
    let result: unknown;
    if (capabilityTaskCompletion && control) {
      result = await completeCapabilityTaskBrowserRun(control, body as { run: BrowserRun; candidate?: KnowledgeCandidate });
    } else if (body.run.mode === "author") {
      if (!body.candidate) return runnerJson({ error: "authored_candidate_missing" }, 400);
      result = await completeAuthoring(decodedRunnerId, token, body.run, body.candidate!, {
        allowCompletedRetry: beginning?.resumed === true,
      });
    } else {
      result = await completeValidation(decodedRunnerId, token, body.run, {
        allowCompletedRetry: beginning?.resumed === true,
      });
    }
    if (control) {
      const leaseStatus = capabilityTaskCompletion
        ? (result as { leaseStatus: "completed" | "failed" }).leaseStatus
        : body.run.status === "failed" ? "failed" : "completed";
      await completeRunnerLease({
        ...control,
        status: leaseStatus,
        result,
      });
    }
    if (capabilityTaskCompletion
      && (result as { status?: string }).status === "awaiting-review"
      && (result as { taskId?: string }).taskId) {
      const autoApproval = await maybeAutoApproveCapabilityTask(
        body.run.siteAgentId,
        (result as { taskId: string }).taskId,
      ).catch(() => ({ attempted: true as const, approved: false as const }));
      return runnerJson({ ...(result as Record<string, unknown>), autoApproval });
    }
    return runnerJson(result);
  } catch (error) {
    if (completionControl && completionOwned) {
      if (capabilityTaskCompletion) {
        await abortRunnerLeaseCompletion(completionControl).catch(() => undefined);
      } else {
        await completeRunnerLease({
          ...completionControl,
          status: "failed",
          result: { error: "browser_run_complete_failed" },
        }).catch(() => undefined);
      }
    }
    return runnerJson(
      { error: "browser_run_complete_failed", message: "Browser run could not be completed." },
      runnerControlErrorStatus(error),
    );
  }
}
