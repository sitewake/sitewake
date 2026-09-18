import { configuredRunnerProjectionMode } from "@/db/runner-control-store";
import { runnerManagementAuthorized, runnerManagementJson } from "../http";

export async function GET(request: Request) {
  if (!(await runnerManagementAuthorized(request))) {
    return runnerManagementJson({ error: "runner_management_unauthorized" }, 401);
  }

  const mode = configuredRunnerProjectionMode();
  return runnerManagementJson({
    mode,
    poolManagement: false,
    instanceDetails: mode === "full",
    taskDetails: mode === "full",
    drainResume: mode === "full",
    placementBindings: mode === "full",
  });
}
