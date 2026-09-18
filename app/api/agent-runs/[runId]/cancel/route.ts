import { NextRequest } from "next/server";
import { cancelAgentRun } from "../../../../../db/agent-run-store";
import { siteAgentJson, siteAgentOptions } from "../../../site-agents/http";
import { agentRunError, runToken } from "../../http";

type Context = { params: Promise<{ runId: string }> | { runId: string } };
export async function OPTIONS() { return siteAgentOptions(); }
export async function POST(request: NextRequest, context: Context) {
  try {
    return siteAgentJson(await cancelAgentRun(decodeURIComponent((await context.params).runId || ""), runToken(request)));
  } catch (error) { return agentRunError(error); }
}
