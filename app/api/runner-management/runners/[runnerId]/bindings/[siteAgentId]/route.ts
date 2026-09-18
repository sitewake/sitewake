import {
  configuredRunnerProjectionMode,
  deleteRunnerPlacementBinding,
  upsertRunnerPlacementBinding,
} from "@/db/runner-control-store";
import { listSiteAgents } from "@/db/site-agent-store";
import type { RunnerWorkKind } from "@/lib/runner-control";
import { runnerManagementAuthorized, runnerManagementJson } from "../../../../http";

type RouteContext = {
  params:
    | Promise<{ runnerId: string; siteAgentId: string }>
    | { runnerId: string; siteAgentId: string };
};

const WORK_KINDS = new Set<RunnerWorkKind>(["execute", "author", "validate"]);

function parseWorkKinds(value: unknown): RunnerWorkKind[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  if (value.some((item) => typeof item !== "string" || !WORK_KINDS.has(item as RunnerWorkKind))) {
    return null;
  }
  return [...new Set(value as RunnerWorkKind[])];
}

async function requestInput(request: Request) {
  try {
    const input = await request.json();
    return input && typeof input === "object" && !Array.isArray(input)
      ? input as { workKinds?: unknown }
      : null;
  } catch {
    return null;
  }
}

async function resolvedParams(context: RouteContext) {
  const { runnerId, siteAgentId } = await context.params;
  return {
    runnerId: decodeURIComponent(runnerId),
    siteAgentId: decodeURIComponent(siteAgentId),
  };
}

async function siteExists(siteAgentId: string) {
  const { agents } = await listSiteAgents();
  return agents.some((agent) => agent.id === siteAgentId);
}

export async function PUT(request: Request, context: RouteContext) {
  if (!(await runnerManagementAuthorized(request))) {
    return runnerManagementJson({ error: "runner_management_unauthorized" }, 401);
  }
  const params = await resolvedParams(context);
  if (configuredRunnerProjectionMode({ siteAgentId: params.siteAgentId }) !== "full") {
    return runnerManagementJson({ error: "runner_management_action_unavailable" }, 404);
  }

  const input = await requestInput(request);
  if (!input) {
    return runnerManagementJson({ error: "runner_binding_request_invalid" }, 400);
  }
  const workKinds = parseWorkKinds(input.workKinds);
  if (input.workKinds === undefined || (Array.isArray(input.workKinds) && !input.workKinds.length)) {
    return runnerManagementJson({ error: "runner_binding_work_kind_required" }, 400);
  }
  if (!workKinds) return runnerManagementJson({ error: "runner_binding_work_kind_invalid" }, 400);

  try {
    if (!(await siteExists(params.siteAgentId))) {
      return runnerManagementJson({ error: "site_agent_not_found" }, 404);
    }
    return runnerManagementJson(await upsertRunnerPlacementBinding({
      ...params,
      workKinds,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    return runnerManagementJson({
      error: "runner_binding_update_failed",
      message: message === "runner_instance_not_found"
        ? "Runner instance not found."
        : "Runner binding could not be updated.",
    }, message === "runner_instance_not_found" ? 404 : 409);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  if (!(await runnerManagementAuthorized(request))) {
    return runnerManagementJson({ error: "runner_management_unauthorized" }, 401);
  }
  const params = await resolvedParams(context);
  if (configuredRunnerProjectionMode({ siteAgentId: params.siteAgentId }) !== "full") {
    return runnerManagementJson({ error: "runner_management_action_unavailable" }, 404);
  }

  const input = await requestInput(request);
  if (!input) {
    return runnerManagementJson({ error: "runner_binding_request_invalid" }, 400);
  }
  const workKinds = parseWorkKinds(input.workKinds);
  if (input.workKinds !== undefined && !workKinds) {
    return runnerManagementJson({ error: "runner_binding_work_kind_invalid" }, 400);
  }
  try {
    return runnerManagementJson(await deleteRunnerPlacementBinding({
      ...params,
      workKinds: workKinds ?? undefined,
    }));
  } catch {
    return runnerManagementJson({
      error: "runner_binding_delete_failed",
      message: "Runner binding could not be deleted.",
    }, 409);
  }
}
