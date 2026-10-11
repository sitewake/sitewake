import {
  configuredRunnerProjectionMode,
  setRunnerDesiredState,
} from "@/db/runner-control-store";
import type { RunnerDesiredState } from "@/lib/runner-control";
import { runnerManagementAuthorized, runnerManagementJson } from "../../http";

type RouteContext = {
  params: Promise<{ runnerId: string }> | { runnerId: string };
};

const DESIRED_STATES = new Set<RunnerDesiredState>(["active", "draining"]);

export async function PATCH(request: Request, context: RouteContext) {
  if (!(await runnerManagementAuthorized(request))) {
    return runnerManagementJson({ error: "runner_management_unauthorized" }, 401);
  }
  if (configuredRunnerProjectionMode() !== "full") {
    return runnerManagementJson({ error: "runner_management_action_unavailable" }, 404);
  }

  const input = await request.json().catch(() => ({})) as { desiredState?: string };
  if (!input.desiredState || !DESIRED_STATES.has(input.desiredState as RunnerDesiredState)) {
    return runnerManagementJson({ error: "runner_desired_state_invalid" }, 400);
  }

  try {
    const { runnerId } = await context.params;
    return runnerManagementJson(await setRunnerDesiredState(
      decodeURIComponent(runnerId),
      input.desiredState as RunnerDesiredState,
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    return runnerManagementJson({
      error: message === "runner_instance_not_found"
        ? "runner_instance_not_found"
        : "runner_desired_state_update_failed",
      message: message === "runner_instance_not_found"
        ? "Runner instance not found."
        : "Runner desired state could not be updated.",
    }, message === "runner_instance_not_found" ? 404 : 409);
  }
}
