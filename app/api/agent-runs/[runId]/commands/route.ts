import { NextRequest } from "next/server";
import { claimAgentRunCommand, enqueueAgentRunCommand } from "../../../../../db/agent-run-store";
import type { JsonValue } from "../../../../../lib/site-knowledge/protocol";
import { siteAgentJson, siteAgentOptions } from "../../../site-agents/http";
import { agentRunError, runToken } from "../../http";

type Context = { params: Promise<{ runId: string }> | { runId: string } };
async function id(context: Context) { return decodeURIComponent((await context.params).runId || ""); }
export async function OPTIONS() { return siteAgentOptions(); }

export async function POST(request: NextRequest, context: Context) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const commandInput = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input as Record<string, JsonValue> : {};
    return siteAgentJson(await enqueueAgentRunCommand(await id(context), { token: runToken(request), name: String(body.name || ""), commandInput }), 201);
  } catch (error) { return agentRunError(error); }
}

export async function GET(request: NextRequest, context: Context) {
  try {
    const url = new URL(request.url);
    return siteAgentJson(await claimAgentRunCommand(await id(context), {
      token: runToken(request), portId: url.searchParams.get("portId") || "", pageEpoch: Number(url.searchParams.get("pageEpoch")),
    }));
  } catch (error) { return agentRunError(error); }
}
