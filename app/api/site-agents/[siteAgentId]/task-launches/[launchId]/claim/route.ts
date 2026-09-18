import { claimTaskLaunch } from "../../../../../../../db/site-agent-store";
import { boundedJsonErrorStatus, readBoundedJson } from "../../../../../../../lib/http/bounded-json";
import { siteAgentJson, siteAgentOptions } from "../../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string; launchId: string }> | { siteAgentId: string; launchId: string } };

export async function OPTIONS() { return siteAgentOptions(); }

export async function POST(request: Request, context: RouteContext) {
  const params = await context.params;
  const originHeader = request.headers.get("origin")?.trim();
  if (!originHeader || originHeader.length > 2_048) {
    return siteAgentJson({ error: "task_launch_origin_required" }, 403);
  }
  try {
    new URL(originHeader);
  } catch {
    return siteAgentJson({ error: "task_launch_origin_rejected" }, 403);
  }
  let body: { token?: string; origin?: string; claimKey?: string };
  try {
    body = await readBoundedJson(request, 16 * 1024);
  } catch (error) {
    const status = boundedJsonErrorStatus(error) || 400;
    return siteAgentJson(
      { error: status === 413 ? "task_launch_claim_too_large" : "invalid_json" },
      status,
    );
  }
  try {
    const trustedOrigin = new URL(originHeader).origin;
    if (body.origin && new URL(String(body.origin)).origin !== trustedOrigin) {
      return siteAgentJson({ error: "task_launch_origin_rejected" }, 403);
    }
    return siteAgentJson(await claimTaskLaunch(
      decodeURIComponent(params.siteAgentId || ""),
      decodeURIComponent(params.launchId || ""),
      {
        token: String(body.token || ""),
        origin: trustedOrigin,
        claimKey: String(body.claimKey || ""),
      },
    ));
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":", 1)[0] : "";
    if (code === "task_launch_claim_key_invalid") {
      return siteAgentJson({ error: code }, 400);
    }
    if (code === "task_launch_not_found") {
      return siteAgentJson({ error: code }, 404);
    }
    if (code === "task_launch_claim_conflict") {
      return siteAgentJson({ error: code }, 409);
    }
    return siteAgentJson({ error: "task_launch_claim_rejected" }, 403);
  }
}
