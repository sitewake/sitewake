import { actOnCapabilityProject } from "../../../../../../../db/site-agent-store";
import { managementMutationAuthorized, siteAgentJson, siteAgentOptions } from "../../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string; projectId: string }> | { siteAgentId: string; projectId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

export async function POST(request: Request, context: RouteContext) {
  if (!(await managementMutationAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  const projectId = decodeURIComponent(params.projectId || "").trim();
  let body: {
    action?: string;
    text?: string;
    exposure?: "public" | "internal";
    patch?: Record<string, unknown>;
    spec?: Record<string, unknown>;
    revisionId?: string;
    validationRunId?: string;
    validatedContentHash?: string;
  };
  try { body = await request.json() as typeof body; } catch { return siteAgentJson({ error: "invalid_json" }, 400); }
  if (!siteAgentId || !projectId || !body.action) return siteAgentJson({ error: "capability_action_required" }, 400);
  try {
    const result = await actOnCapabilityProject(siteAgentId, projectId, {
      action: body.action,
      text: body.text,
      exposure: body.exposure,
      patch: body.patch as never,
      spec: body.spec as never,
      revisionId: body.revisionId,
      validationRunId: body.validationRunId,
      validatedContentHash: body.validatedContentHash,
    });
    return siteAgentJson(result, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    const conflictErrors = new Set([
      "revision_review_state_drifted",
      "revision_review_validation_base_mismatch",
      "revision_review_implementation_release_missing",
      "revision_review_already_decided",
      "revision_rejection_conflict",
      "revision_review_not_ready",
      "revision_approval_conflict",
      "capability_revision_retry_conflict",
      "capability_release_conflict",
      "capability_project_conflict",
      "capability_project_delete_requires_draft",
      "capability_unpublish_last_good_required",
      "capability_relist_unpublished_required",
      "capability_last_good_missing",
      "capability_last_good_release_mismatch",
      "capability_last_good_contract_mismatch",
    ]);
    const status = conflictErrors.has(message)
      ? 409
      : message === "composite_publication_not_implemented"
        ? 422
      : message.includes("required") || message.includes("invalid")
        ? 400
        : message.includes("not_found")
          ? 404
          : 500;
    return siteAgentJson({ error: "capability_action_failed", message }, status);
  }
}
