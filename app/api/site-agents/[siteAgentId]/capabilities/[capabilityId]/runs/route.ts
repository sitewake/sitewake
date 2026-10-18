import { createCapabilityRun } from "@/db/site-agent-store";
import type { ExecutionEnvironment, ExecutionMode, JsonValue } from "@/lib/site-knowledge/protocol";
import { boundedJsonErrorStatus, readBoundedJson } from "@/lib/http/bounded-json";
import { managementMutationAuthorized, siteAgentJson, siteAgentNotFoundError, siteAgentOptions } from "../../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string; capabilityId: string }> | { siteAgentId: string; capabilityId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

function capabilityRunErrorStatus(code: string) {
  if (code.startsWith("capability_run_input_")
    || code === "capability_run_idempotency_key_invalid"
    || code === "task_launch_input_required"
    || code === "task_launch_execution_pin_incomplete") {
    return 400;
  }
  if (code === "capability_run_not_found"
    || code === "capability_run_project_not_found"
    || code === "capability_run_published_release_missing"
    || code === "task_launch_capability_not_found"
    || code === "task_launch_release_not_found") {
    return 404;
  }
  if (code.startsWith("capability_run_")
    || code.startsWith("task_launch_")
    || code === "managed_profile_not_configured") {
    return 409;
  }
  return 500;
}

export async function POST(request: Request, context: RouteContext) {
  if (!(await managementMutationAuthorized(request))) {
    return siteAgentJson({ error: "unauthorized" }, 401);
  }
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  const capabilityId = decodeURIComponent(params.capabilityId || "").trim();
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) {
    return siteAgentJson({ error: "idempotency_key_required" }, 400);
  }
  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson(request, 256 * 1024);
  } catch (error) {
    const status = boundedJsonErrorStatus(error) || 400;
    return siteAgentJson(
      { error: status === 413 ? "capability_run_request_too_large" : "invalid_json" },
      status,
    );
  }
  const mode: ExecutionMode = body.mode === "debug" ? "debug" : "run";
  const rawEnvironment = body.environment && typeof body.environment === "object" ? body.environment as Record<string, unknown> : {};
  if (rawEnvironment.kind === "connected-browser"
    && rawEnvironment.connectionId !== undefined) {
    return siteAgentJson(
      {
        error: "connection_selection_unsupported",
      },
      400,
    );
  }
  const environment: ExecutionEnvironment = rawEnvironment.kind === "connected-browser"
    ? { kind: "connected-browser" }
    : rawEnvironment.kind === "managed-profile"
      ? { kind: "managed-profile", profileId: String(rawEnvironment.profileId || "") }
      : { kind: "cloud-browser" };
  try {
    const result = await createCapabilityRun({
      siteAgentId,
      projectId: typeof body.projectId === "string" ? body.projectId : undefined,
      capabilityId,
      mode,
      environment,
      input: body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input as Record<string, JsonValue> : {},
      idempotencyKey,
    });
    return siteAgentJson(
      result,
      "duplicate" in result && result.duplicate ? 200 : 201,
    );
  } catch (error) {
    if (siteAgentNotFoundError(error)) return siteAgentJson({ error: "site_agent_not_found" }, 404);
    const message = error instanceof Error ? error.message : "unknown";
    const code = message.split(":", 1)[0] || "capability_run_create_failed";
    return siteAgentJson(
      {
        error: code,
        // Only a message the caller supplied is forwarded; the code alone carries the
        // rest, and the console renders copy from it in the reader's language.
        message: code === "capability_run_create_failed" ? undefined : message,
      },
      capabilityRunErrorStatus(code),
    );
  }
}
