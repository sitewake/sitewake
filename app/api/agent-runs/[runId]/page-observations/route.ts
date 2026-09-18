import { NextRequest } from "next/server";
import { getAgentRun } from "../../../../../db/agent-run-store";
import {
  appendPageAgentObservations,
  getPageAgentObservations,
  PAGE_OBSERVATION_MAX_REQUEST_BYTES,
} from "../../../../../db/page-observation-store";
import { boundedJsonErrorStatus, readBoundedJson } from "../../../../../lib/http/bounded-json";
import type { PageAgentObservation } from "../../../../../lib/site-knowledge/protocol";
import { persistenceHeaders, siteAgentJson, siteAgentOptions } from "../../../site-agents/http";
import { agentRunError, runToken } from "../../http";

type Context = { params: Promise<{ runId: string }> | { runId: string } };
export async function OPTIONS() { return siteAgentOptions(); }

export async function POST(request: NextRequest, context: Context) {
  const runId = decodeURIComponent((await context.params).runId || "");
  try {
    const body = await readBoundedJson<{ siteAgentId?: unknown; observations?: unknown }>(request, PAGE_OBSERVATION_MAX_REQUEST_BYTES);
    const current = await getAgentRun(runId, runToken(request));
    const siteAgentId = typeof body.siteAgentId === "string" ? body.siteAgentId : "";
    if (!current.run || current.run.scope.kind !== "site" || current.run.scope.siteAgentId !== siteAgentId) throw new Error("agent_run_token_rejected");
    if (!Array.isArray(body.observations)) return siteAgentJson({ error: "page_observation_batch_invalid" }, 400);
    const result = await appendPageAgentObservations(current.run, body.observations as PageAgentObservation[]);
    return siteAgentJson(result, 202, persistenceHeaders(result.persistence));
  } catch (error) {
    const status = boundedJsonErrorStatus(error);
    if (status) return siteAgentJson({ error: status === 413 ? "request_body_too_large" : "invalid_json" }, status);
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("page_observation_")) return siteAgentJson({ error: message }, message.includes("too_large") || message.includes("run_limit") ? 413 : message.includes("conflict") ? 409 : 400);
    return agentRunError(error);
  }
}

export async function GET(request: NextRequest, context: Context) {
  const runId = decodeURIComponent((await context.params).runId || "");
  try {
    const current = await getAgentRun(runId, runToken(request));
    if (!current.run || current.run.scope.kind !== "site") throw new Error("agent_run_token_rejected");
    const episodeId = new URL(request.url).searchParams.get("episodeId") || undefined;
    const observations = await getPageAgentObservations(runId, { siteAgentId: current.run.scope.siteAgentId, episodeId });
    return siteAgentJson({ observations, persistence: current.persistence });
  } catch (error) { return agentRunError(error); }
}
