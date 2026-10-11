import { NextRequest } from "next/server";
import { getSiteAgentRunByToken } from "../../../../../db/agent-run-store";
import { appendDomReplayChunk } from "../../../../../db/site-agent-store";
import { boundedJsonErrorStatus, readBoundedJson } from "../../../../../lib/http/bounded-json";
import { isDomReplayChunk, type DomReplayChunk } from "../../../../../lib/site-knowledge/protocol";
import { agentRunError, runToken } from "../../../agent-runs/http";
import { persistenceHeaders, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };
const MAX_DOM_REPLAY_REQUEST_BYTES = 2 * 1024 * 1024;
export async function OPTIONS() { return siteAgentOptions(); }

/**
 * Ingest original-DOM replay chunks captured while a user Episode runs. The
 * client streams small chunks (first `full` frame + incremental mutations),
 * so this endpoint accepts either one chunk or a small batch. Replay data is
 * evidence for the Capability Center only; it never enters a Release.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  const token = runToken(request);
  if (!token) return siteAgentJson({ error: "agent_run_token_required" }, 401);
  let authenticatedRunId: string;
  try {
    const authenticated = await getSiteAgentRunByToken(siteAgentId, token, request.headers.get("origin"));
    authenticatedRunId = authenticated.run.id;
  } catch (error) { return agentRunError(error); }
  let chunks: DomReplayChunk[];
  try {
    const body = await readBoundedJson<{ chunks?: DomReplayChunk[]; chunk?: DomReplayChunk }>(request, MAX_DOM_REPLAY_REQUEST_BYTES);
    chunks = Array.isArray(body.chunks) ? body.chunks : body.chunk ? [body.chunk] : [];
  } catch (error) {
    const status = boundedJsonErrorStatus(error) || 400;
    return siteAgentJson({ error: status === 413 ? "request_body_too_large" : "invalid_json" }, status);
  }
  if (!siteAgentId || !chunks.length || chunks.length > 20) return siteAgentJson({ error: "invalid_dom_replay" }, 400);
  if (chunks.some((chunk) => !isDomReplayChunk(chunk) || chunk.siteAgentId !== siteAgentId || chunk.runId !== authenticatedRunId)) return siteAgentJson({ error: "invalid_dom_replay_chunk" }, 400);
  try {
    let persistence: "memory" | "d1" = "memory";
    for (const chunk of chunks) { persistence = (await appendDomReplayChunk(siteAgentId, chunk)).persistence; }
    return siteAgentJson({ accepted: true, count: chunks.length }, 202, persistenceHeaders(persistence));
  } catch (error) {
    return siteAgentFailure(error, "dom_replay_ingest_failed");
  }
}
