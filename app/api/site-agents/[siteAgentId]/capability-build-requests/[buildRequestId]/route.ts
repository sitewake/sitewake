import { dismissDuplicateCapabilityBuildRequest } from "../../../../../../db/site-agent-store";
import { managementMutationAuthorized, siteAgentJson, siteAgentOptions } from "../../../http";

type RouteContext = {
  params: Promise<{ siteAgentId: string; buildRequestId: string }>
    | { siteAgentId: string; buildRequestId: string };
};

export async function OPTIONS() { return siteAgentOptions(); }

export async function DELETE(request: Request, context: RouteContext) {
  if (!(await managementMutationAuthorized(request))) {
    return siteAgentJson({ error: "unauthorized" }, 401);
  }
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  const buildRequestId = decodeURIComponent(params.buildRequestId || "").trim();
  if (!siteAgentId || !buildRequestId) {
    return siteAgentJson({ error: "capability_build_request_id_required" }, 400);
  }
  try {
    return siteAgentJson(
      await dismissDuplicateCapabilityBuildRequest(siteAgentId, buildRequestId),
      200,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    const status = message === "capability_build_request_not_found"
      ? 404
      : message === "capability_build_request_dismiss_not_allowed"
        || message === "capability_build_request_dismiss_conflict"
        ? 409
        : message.includes("invalid") || message.includes("required")
          ? 400
          : 500;
    return siteAgentJson({ error: "capability_build_request_dismiss_failed", message }, status);
  }
}
