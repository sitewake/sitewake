import { createCapabilityTask, listCapabilityTasks, type CreateCapabilityTaskInput } from "@/db/capability-center-store";
import type { CapabilityTaskStatus, CapabilityTaskType } from "@/lib/capability-center/model";
import { managementAuthorized, managementMutationAuthorized, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const { siteAgentId: encoded } = await context.params;
  const siteAgentId = decodeURIComponent(encoded || "").trim();
  if (!siteAgentId) return siteAgentJson({ error: "site_agent_id_required" }, 400);
  const search = new URL(request.url).searchParams;
  const rawStatus = search.get("status");
  const rawType = search.get("type");
  const statuses = new Set<CapabilityTaskStatus>(["queued", "running", "awaiting-review", "completed", "failed", "rejected", "cancelled", "archived"]);
  const types = new Set<CapabilityTaskType>(["generate", "repair", "validate"]);
  try {
    const result = await listCapabilityTasks(siteAgentId, {
      status: rawStatus && statuses.has(rawStatus as CapabilityTaskStatus) ? rawStatus as CapabilityTaskStatus : undefined,
      type: rawType && types.has(rawType as CapabilityTaskType) ? rawType as CapabilityTaskType : undefined,
      capabilityId: search.get("capabilityId") || undefined,
      includeArchived: search.get("includeArchived") === "1",
    });
    return siteAgentJson(result, 200, { "x-sitewake-persistence": result.persistence });
  } catch (error) { return siteAgentFailure(error, "capability_tasks_failed"); }
}

export async function POST(request: Request, context: RouteContext) {
  if (!(await managementMutationAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const { siteAgentId: encoded } = await context.params;
  const siteAgentId = decodeURIComponent(encoded || "").trim();
  let body: CreateCapabilityTaskInput;
  try { body = await request.json() as CreateCapabilityTaskInput; } catch { return siteAgentJson({ error: "invalid_json" }, 400); }
  if (!siteAgentId || body.type !== "validate") return siteAgentJson({ error: "capability_task_proposal_required" }, 400);
  try {
    const result = await createCapabilityTask(siteAgentId, {
      type: "validate",
      capabilityId: body.capabilityId,
      capabilityVersionId: body.capabilityVersionId,
      validationInput: body.validationInput,
    });
    return siteAgentJson(result, 202, { "x-sitewake-persistence": result.persistence });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    const status = message.includes("duplicate") ? 409 : message.includes("not_found") ? 404 : message.includes("required") || message.includes("invalid") ? 400 : 500;
    return siteAgentJson({ error: "capability_task_create_failed", message }, status);
  }
}

