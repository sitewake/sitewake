import { NextRequest } from "next/server";
import { createTaskSession } from "../../../../../db/site-agent-store";
import { normalizeGoal, uid, type JsonValue, type TaskSession } from "../../../../../lib/site-knowledge/protocol";
import { siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };
export async function OPTIONS() { return siteAgentOptions(); }
export async function POST(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return siteAgentJson({ error: "invalid_json" }, 400); }
  const goal = String(body.goal || "").trim();
  const browserSessionId = String(body.browserSessionId || "").trim();
  if (!siteAgentId || !goal || !browserSessionId) return siteAgentJson({ error: "session_goal_browser_required" }, 400);
  const now = new Date();
  const suppliedConversation = Array.isArray(body.conversation) ? body.conversation.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const turn = item as Record<string, unknown>;
    const role = turn.role === "assistant" || turn.role === "system" ? turn.role : "user";
    const content = String(turn.content || "").trim().slice(0, 2_000);
    return content ? [{ role, content, at: String(turn.at || now.toISOString()) }] : [];
  }).slice(-12) : [];
  const conversation: TaskSession["conversation"] = suppliedConversation as TaskSession["conversation"];
  if (conversation.at(-1)?.role !== "user" || conversation.at(-1)?.content !== goal) conversation.push({ role: "user", content: goal, at: now.toISOString() });
  const session: TaskSession = {
    id: uid("task"), siteAgentId, browserSessionId, goal,
    input: (body.input && typeof body.input === "object" ? body.input : {}) as Record<string, JsonValue>,
    conversation, nextStepIndex: 0, bindings: {}, status: "running",
    createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
  void normalizeGoal(goal);
  try { return siteAgentJson(await createTaskSession(session), 201); } catch (error) { return siteAgentFailure(error, "session_create_failed"); }
}
