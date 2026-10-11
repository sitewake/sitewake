import { NextRequest } from "next/server";
import { authorizeAgentRunEpisode, recordAgentRunReconciliationEpisode } from "../../../../../db/agent-run-store";
import { appendTaskEpisode } from "../../../../../db/site-agent-store";
import { boundedJsonErrorStatus, readBoundedJson } from "../../../../../lib/http/bounded-json";
import { isEpisode, SITE_AGENT_SCHEMA_VERSION, type TaskEpisode } from "../../../../../lib/site-knowledge/protocol";
import { agentRunError, runToken } from "../../../agent-runs/http";
import { persistenceHeaders, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../http";
import { sanitizeTaskEpisode } from "../../../../../lib/site-knowledge/sensitive-data";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };
const MAX_EPISODE_REQUEST_BYTES = 1024 * 1024;
export async function OPTIONS() { return siteAgentOptions(); }

export async function POST(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  const token = runToken(request);
  if (!token) return siteAgentJson({ error: "agent_run_token_required" }, 401);
  let episode: TaskEpisode;
  try {
    const raw = await readBoundedJson(request, MAX_EPISODE_REQUEST_BYTES) as unknown as TaskEpisode;
    if (!siteAgentId || raw.schemaVersion !== SITE_AGENT_SCHEMA_VERSION || raw.siteAgentId !== siteAgentId || !isEpisode(raw)) {
      return siteAgentJson({ error: "invalid_episode" }, 400);
    }
    episode = sanitizeTaskEpisode(raw);
  }
  catch (error) {
    const status = boundedJsonErrorStatus(error) || 400;
    return siteAgentJson({ error: status === 413 ? "request_body_too_large" : "invalid_json" }, status);
  }
  if (episode.mode === "author-request") return siteAgentJson({ error: "episode_author_request_forbidden" }, 403);
  try {
    const authorized = await authorizeAgentRunEpisode(episode.taskSessionId, token, episode);
    // The user-facing completion path only persists evidence and closes the
    // TaskSession. Semantic design/exploration belongs to the queued learning
    // job; waiting for a model here made a completed task feel unfinished.
    const result = await appendTaskEpisode(siteAgentId, episode, {
      triggerAuthority: authorized.triggerAuthority,
      experienceAuthority: authorized.experienceAuthority,
      compiledRepairSourceCapabilityId: authorized.compiledRepairSourceCapabilityId,
    });
    const reconciliation = authorized.run.agentState.executionIntent === "reconciliation"
      && episode.outcome.evidence.executionIntent === "reconciliation"
      && episode.outcome.evidence.reconciliationStatus === "not-completed";
    const agentRun = reconciliation
      ? (await recordAgentRunReconciliationEpisode(episode.taskSessionId, token, episode.id)).run
      : authorized.run;
    return siteAgentJson({ ...result, agentRun }, 202, persistenceHeaders(result.persistence));
  } catch (error) {
    console.error("[site-agent] episode ingest failed", {
      siteAgentId,
      taskSessionId: episode.taskSessionId,
      episodeId: episode.id,
      mode: episode.mode,
      outcome: episode.outcome.status,
      error: error instanceof Error ? error.message : String(error),
    });
    if (String(error).includes("agent_run_")) return agentRunError(error);
    return siteAgentFailure(error, "episode_ingest_failed");
  }
}
