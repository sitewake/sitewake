import { resolveCapabilityRunLeaseControl, updateCapabilityRunFromRunner } from "@/db/site-agent-store";
import {
  abortRunnerLeaseCompletion,
  acquireRunnerLeaseCompletion,
  authorizeRunnerInstanceSession,
  completeRunnerLease,
  renewRunnerLease,
} from "@/db/runner-control-store";
import type { BrowserRun, CapabilityRun } from "@/lib/site-knowledge/protocol";
import { boundedJsonErrorStatus, readBoundedJson } from "@/lib/http/bounded-json";
import {
  legacyRunnerProtocolEnabled,
  runnerControlErrorStatus,
  runnerControlHeadersPlausible,
  runnerJson,
  runnerLeaseControlInput,
  runnerOptions,
  runnerSessionToken,
} from "../../../http";

type RouteContext = { params: Promise<{ runnerId: string; runId: string }> | { runnerId: string; runId: string } };

export async function OPTIONS() { return runnerOptions(); }

export async function PATCH(request: Request, context: RouteContext) {
  if (!runnerControlHeadersPlausible(request, { requireLease: true })) {
    return runnerJson({ error: "runner_session_required" }, 401);
  }
  const { runnerId, runId } = await context.params;
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
  let body: Pick<CapabilityRun, "status" | "steps" | "timings" | "artifactIds">
    & Partial<Pick<CapabilityRun, "progress" | "output" | "outcome" | "resultUrl" | "error" | "startedAt" | "completedAt">>
    & { browserRun?: BrowserRun };
  try {
    body = await readBoundedJson(request, 2 * 1024 * 1024);
  } catch (error) {
    const status = boundedJsonErrorStatus(error) || 400;
    return runnerJson({
      error: status === 413
        ? "capability_run_patch_too_large"
        : "capability_run_patch_invalid",
    }, status);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return runnerJson({ error: "capability_run_patch_invalid" }, 400);
  }
  let completionControl: Parameters<typeof acquireRunnerLeaseCompletion>[0] | undefined;
  let completionOwned = false;
  let completionResumed = false;
  let businessCommitted = false;
  try {
    const decodedRunId = decodeURIComponent(runId);
    const token = request.headers.get("x-sitewake-lease-token") || "";
    const control = runnerLeaseControlInput(request, decodedRunnerId)
      || await resolveCapabilityRunLeaseControl(decodedRunnerId, token, decodedRunId);
    const terminal = body.status === "completed" || body.status === "failed" || body.status === "cancelled";
    const shouldComplete = terminal;
    const beginning = control && shouldComplete ? await acquireRunnerLeaseCompletion(control) : undefined;
    completionControl = shouldComplete ? control : undefined;
    if (beginning?.duplicate) {
      if (beginning.inProgress) {
        return runnerJson({ error: "runner_lease_completion_busy", message: "Runner completion is still in progress." }, 409);
      }
      const replay = await updateCapabilityRunFromRunner(
        decodedRunnerId,
        token,
        decodedRunId,
        body,
        { allowCompletedRetry: true },
      );
      return runnerJson(replay);
    }
    completionOwned = Boolean(beginning);
    completionResumed = beginning?.resumed === true;
    if (control && !shouldComplete) await renewRunnerLease(control);
    const result = await updateCapabilityRunFromRunner(decodedRunnerId, token, decodedRunId, body, {
      allowCompletedRetry: beginning?.resumed === true,
    });
    businessCommitted = true;
    if (control && shouldComplete) {
      await completeRunnerLease({
        ...control,
        status: result.run.status === "completed" ? "completed" : "failed",
        result,
      });
    }
    return runnerJson(result);
  } catch (error) {
    const status = runnerControlErrorStatus(error);
    // Once a central completion is resumed, the business Run may already have
    // committed and only the central receipt was lost. Never roll that lease
    // back to active on a mismatched replay. For a newly acquired completion,
    // only deterministic pre-commit payload errors are safe to abort.
    if (completionControl
      && completionOwned
      && !completionResumed
      && !businessCommitted
      && (status === 400 || status === 413)) {
      await abortRunnerLeaseCompletion(completionControl).catch(() => undefined);
    }
    const publicError = status === 409
      ? "capability_run_update_conflict"
      : status === 400
        ? "capability_run_patch_invalid"
        : status === 413
          ? "capability_run_patch_too_large"
          : "capability_run_update_failed";
    return runnerJson(
      { error: publicError, message: "Capability run could not be updated." },
      status,
    );
  }
}
