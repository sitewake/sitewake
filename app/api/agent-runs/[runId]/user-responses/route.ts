import { NextRequest } from "next/server";
import { updateAgentRunConversation } from "../../../../../db/agent-run-store";
import { siteAgentJson, siteAgentOptions } from "../../../site-agents/http";
import { agentRunError, runToken } from "../../http";

type Context = { params: Promise<{ runId: string }> | { runId: string } };
export async function OPTIONS() { return siteAgentOptions(); }
export async function POST(request: NextRequest, context: Context) {
  try {
    const body = await request.json() as Record<string, unknown>;
    return siteAgentJson(await updateAgentRunConversation(decodeURIComponent((await context.params).runId || ""), {
      token: runToken(request), expectedRevision: Number(body.expectedRevision), pageEpoch: Number(body.pageEpoch), content: String(body.content || ""),
    }));
  } catch (error) { return agentRunError(error); }
}
