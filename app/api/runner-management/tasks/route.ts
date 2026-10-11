import {
  configuredRunnerProjectionMode,
  listRunnerControlTasks,
} from "@/db/runner-control-store";
import type {
  RunnerTaskStatus,
  RunnerWorkKind,
} from "@/lib/runner-control";
import { runnerManagementAuthorized, runnerManagementJson } from "../http";

const WORK_KINDS = new Set<RunnerWorkKind>(["execute", "author", "validate"]);
const STATUSES = new Set<RunnerTaskStatus>([
  "queued",
  "active",
  "completing",
  "terminal",
]);

function positiveInteger(value: string | null, fallback: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

export async function GET(request: Request) {
  if (!(await runnerManagementAuthorized(request))) {
    return runnerManagementJson({ error: "runner_management_unauthorized" }, 401);
  }

  try {
    const params = new URL(request.url).searchParams;
    const siteAgentId = params.get("siteAgentId")?.trim() || undefined;
    if (configuredRunnerProjectionMode({ siteAgentId }) !== "full") {
      return runnerManagementJson({ error: "runner_management_details_unavailable" }, 404);
    }
    const page = positiveInteger(params.get("page"), 1, 10_000);
    const pageSize = positiveInteger(params.get("pageSize"), 50, 100);
    const requestedWorkKind = params.get("workKind");
    const workKind = requestedWorkKind && WORK_KINDS.has(requestedWorkKind as RunnerWorkKind)
      ? requestedWorkKind as RunnerWorkKind
      : undefined;
    const requestedStatus = params.get("status");
    const status = requestedStatus && STATUSES.has(requestedStatus as RunnerTaskStatus)
      ? requestedStatus as RunnerTaskStatus
      : undefined;
    const result = await listRunnerControlTasks({
      runnerId: params.get("runnerId")?.trim() || undefined,
      siteAgentId,
      workKind,
      status,
      page,
      pageSize,
    });
    return runnerManagementJson({
      tasks: result.tasks,
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      persistence: result.persistence,
    });
  } catch {
    return runnerManagementJson({
      error: "runner_management_tasks_failed",
      message: "Runner tasks could not be loaded.",
    }, 500);
  }
}
