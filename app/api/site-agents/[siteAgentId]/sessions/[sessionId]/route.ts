import { NextRequest } from "next/server";
import { getTaskSession, updateTaskSession } from "../../../../../../db/site-agent-store";
import type { TaskSession } from "../../../../../../lib/site-knowledge/protocol";
import { siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string; sessionId: string }> | { siteAgentId: string; sessionId: string } };
export async function OPTIONS() { return siteAgentOptions(); }
async function ids(context: RouteContext) { const params = await context.params; return { siteAgentId: decodeURIComponent(params.siteAgentId || ""), sessionId: decodeURIComponent(params.sessionId || "") }; }
export async function GET(_: Request, context: RouteContext) {
  const { siteAgentId, sessionId } = await ids(context);
  try {
    const result = await getTaskSession(siteAgentId, sessionId);
    return result.session ? siteAgentJson(result) : siteAgentJson({ error: "session_not_found" }, 404);
  } catch (error) {
    return siteAgentFailure(error, "session_read_failed");
  }
}
export async function PATCH(request: NextRequest, context: RouteContext) {
  const { siteAgentId, sessionId } = await ids(context);
  let patch: Partial<TaskSession>;
  try { patch = await request.json() as Partial<TaskSession>; } catch { return siteAgentJson({ error: "invalid_json" }, 400); }
  try {
    const result = await updateTaskSession(siteAgentId, sessionId, patch);
    return result.session ? siteAgentJson(result) : siteAgentJson({ error: "session_not_found" }, 404);
  } catch (error) {
    return siteAgentFailure(error, "session_update_failed");
  }
}
