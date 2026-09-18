import { NextRequest } from "next/server";
import { appendExecutionReceipt } from "../../../../../db/agent-run-store";
import type { ExecutionReceipt } from "../../../../../lib/site-knowledge/protocol";
import { siteAgentJson, siteAgentOptions } from "../../../site-agents/http";
import { agentRunError, runToken } from "../../http";
import { boundedJsonErrorStatus, readBoundedJson } from "../../../../../lib/http/bounded-json";

type Context = { params: Promise<{ runId: string }> | { runId: string } };
export async function OPTIONS() { return siteAgentOptions(); }
export async function POST(request: NextRequest, context: Context) {
  try {
    const body = await readBoundedJson<Record<string, unknown>>(request, 256_000);
    return siteAgentJson(await appendExecutionReceipt(decodeURIComponent((await context.params).runId || ""), {
      token: runToken(request), expectedRevision: Number(body.expectedRevision), receipt: body.receipt as ExecutionReceipt,
    }));
  } catch (error) {
    const status = boundedJsonErrorStatus(error);
    return status ? siteAgentJson({ error: status === 413 ? "request_body_too_large" : "invalid_json" }, status) : agentRunError(error);
  }
}
