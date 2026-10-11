import { withRequestTiming } from "@/lib/http/request-timing";
import { NextRequest } from "next/server";
import { issueAgentRunHandoff } from "../../../../../db/agent-run-store";
import { boundedJsonErrorStatus, readBoundedJson } from "../../../../../lib/http/bounded-json";
import type { AgentRunCheckpoint } from "../../../../../lib/site-knowledge/protocol";
import { siteAgentJson, siteAgentOptions } from "../../../site-agents/http";
import { agentRunError, runToken } from "../../http";

type Context = { params: Promise<{ runId: string }> | { runId: string } };
export async function OPTIONS() { return siteAgentOptions(); }
async function handlePOST(request: NextRequest, context: Context) {
  try {
    const body = await readBoundedJson<Record<string, unknown>>(request, 512_000);
    return siteAgentJson(await issueAgentRunHandoff(decodeURIComponent((await context.params).runId || ""), {
      token: runToken(request), expectedRevision: Number(body.expectedRevision), pageEpoch: Number(body.pageEpoch),
      portId: typeof body.portId === "string" ? body.portId : undefined,
      documentId: typeof body.documentId === "string" ? body.documentId : undefined,
      browserSessionId: typeof body.browserSessionId === "string" ? body.browserSessionId : undefined,
      destinationUrl: String(body.destinationUrl || ""), checkpoint: body.checkpoint as AgentRunCheckpoint | undefined,
    }));
  } catch (error) {
    const status = boundedJsonErrorStatus(error);
    if (status) return siteAgentJson({ error: error instanceof Error ? error.message : "invalid_json" }, status);
    return agentRunError(error);
  }
}

export const POST = withRequestTiming("run.handoff", handlePOST);
