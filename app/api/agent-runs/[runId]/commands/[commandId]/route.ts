import { NextRequest } from "next/server";
import { completeAgentRunCommand } from "../../../../../../db/agent-run-store";
import type { JsonValue } from "../../../../../../lib/site-knowledge/protocol";
import { siteAgentJson, siteAgentOptions } from "../../../../site-agents/http";
import { agentRunError, runToken } from "../../../http";

type Context = { params: Promise<{ runId: string; commandId: string }> | { runId: string; commandId: string } };
export async function OPTIONS() { return siteAgentOptions(); }
export async function POST(request: NextRequest, context: Context) {
  try {
    const params = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const output = body.output && typeof body.output === "object" && !Array.isArray(body.output) ? body.output as Record<string, JsonValue> : undefined;
    return siteAgentJson(await completeAgentRunCommand(decodeURIComponent(params.runId || ""), {
      token: runToken(request), commandId: decodeURIComponent(params.commandId || ""), portId: String(body.portId || ""), pageEpoch: Number(body.pageEpoch),
      output, error: body.error ? String(body.error).slice(0, 2_000) : undefined,
    }));
  } catch (error) { return agentRunError(error); }
}
