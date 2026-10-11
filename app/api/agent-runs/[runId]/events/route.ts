import { NextRequest } from "next/server";
import { listAgentRunEvents } from "../../../../../db/agent-run-store";
import { siteAgentJson, siteAgentOptions } from "../../../site-agents/http";
import { agentRunError, runToken } from "../../http";

type Context = { params: Promise<{ runId: string }> | { runId: string } };
export async function OPTIONS() { return siteAgentOptions(); }
export async function GET(request: NextRequest, context: Context) {
  try {
    const query = new URL(request.url).searchParams;
    const after = Number(query.get("after") || 0);
    const limit = Number(query.get("limit") || 200);
    return siteAgentJson(await listAgentRunEvents(decodeURIComponent((await context.params).runId || ""), runToken(request), Number.isFinite(after) ? after : 0, Number.isFinite(limit) ? limit : 200));
  } catch (error) { return agentRunError(error); }
}
