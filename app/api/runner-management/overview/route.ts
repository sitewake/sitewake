import {
  configuredRunnerProjectionMode,
  getRunnerControlProjection,
} from "@/db/runner-control-store";
import { runnerManagementAuthorized, runnerManagementJson } from "../http";

export async function GET(request: Request) {
  if (!(await runnerManagementAuthorized(request))) {
    return runnerManagementJson({ error: "runner_management_unauthorized" }, 401);
  }

  try {
    const siteAgentId = new URL(request.url).searchParams.get("siteAgentId")?.trim() || undefined;
    const mode = configuredRunnerProjectionMode({ siteAgentId });
    const projection = await getRunnerControlProjection({ mode, siteAgentId });
    return runnerManagementJson(projection);
  } catch {
    return runnerManagementJson({
      error: "runner_management_overview_failed",
      message: "Runner status could not be loaded.",
    }, 500);
  }
}
