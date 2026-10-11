import { NextRequest } from "next/server";
import { finishAgentRun, getAgentRun } from "../../../../db/agent-run-store";
import type { AgentRunActivity, JsonValue, OutcomeReceipt } from "../../../../lib/site-knowledge/protocol";
import { siteAgentJson, siteAgentOptions } from "../../site-agents/http";
import { agentRunError, runToken } from "../http";
import { boundedJsonErrorStatus, readBoundedJson } from "../../../../lib/http/bounded-json";

type Context = { params: Promise<{ runId: string }> | { runId: string } };
async function id(context: Context) { return decodeURIComponent((await context.params).runId || ""); }
export async function OPTIONS() { return siteAgentOptions(); }
export async function GET(request: NextRequest, context: Context) {
  try {
    const result = await getAgentRun(await id(context), runToken(request));
    return result.run ? siteAgentJson(result) : siteAgentJson({ error: "agent_run_not_found" }, 404);
  } catch (error) { return agentRunError(error); }
}
export async function PATCH(request: NextRequest, context: Context) {
  try {
    const body = await readBoundedJson<Record<string, unknown>>(request, 512_000);
    const status = String(body.status || "");
    if (!(["completed", "failed", "cancelled"] as string[]).includes(status)) throw new Error("agent_run_status_invalid");
    return siteAgentJson(await finishAgentRun(await id(context), {
      token: runToken(request), expectedRevision: Number(body.expectedRevision), pageEpoch: Number(body.pageEpoch),
      status: status as "completed" | "failed" | "cancelled",
      output: body.output as Record<string, JsonValue> | undefined,
      outcome: body.outcome as OutcomeReceipt | undefined,
      assistantText: body.assistantText ? String(body.assistantText) : undefined,
      activityTimeline: Array.isArray(body.activityTimeline) ? body.activityTimeline as AgentRunActivity[] : undefined,
    }));
  } catch (error) {
    const status = boundedJsonErrorStatus(error);
    return status ? siteAgentJson({ error: status === 413 ? "request_body_too_large" : "invalid_json" }, status) : agentRunError(error);
  }
}
