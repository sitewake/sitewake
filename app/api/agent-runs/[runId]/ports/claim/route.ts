import { NextRequest } from "next/server";
import { claimAgentRun } from "../../../../../../db/agent-run-store";
import { boundedJsonErrorStatus, readBoundedJson } from "../../../../../../lib/http/bounded-json";
import { siteAgentJson, siteAgentOptions } from "../../../../site-agents/http";
import { agentRunError } from "../../../http";
import type { AgentRunCheckpoint } from "../../../../../../lib/site-knowledge/protocol";

type Context = { params: Promise<{ runId: string }> | { runId: string } };
export async function OPTIONS() { return siteAgentOptions(); }
export async function POST(request: NextRequest, context: Context) {
  try {
    const runId = decodeURIComponent((await context.params).runId || "");
    const body = await readBoundedJson<Record<string, unknown>>(request, 512_000);
    let requestOrigin = "";
    let reportedOrigin = "";
    try {
      requestOrigin = new URL(request.headers.get("origin") || "").origin;
      reportedOrigin = new URL(String(body.origin || "")).origin;
    } catch { throw new Error("agent_run_origin_rejected"); }
    if (requestOrigin !== reportedOrigin) throw new Error("agent_run_origin_rejected");
    return siteAgentJson(await claimAgentRun(runId, {
      token: String(body.token || ""), origin: String(body.origin || ""), url: String(body.url || ""),
      documentId: String(body.documentId || ""), browserSessionId: String(body.browserSessionId || ""),
      checkpoint: body.checkpoint && typeof body.checkpoint === "object" ? body.checkpoint as AgentRunCheckpoint : undefined,
    }));
  } catch (error) {
    const status = boundedJsonErrorStatus(error);
    if (status) return siteAgentJson({ error: error instanceof Error ? error.message : "invalid_json" }, status);
    return agentRunError(error);
  }
}
