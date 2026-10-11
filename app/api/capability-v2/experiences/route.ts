import { enqueueCapabilityExperience } from "@/db/capability-experience-outbox-store";
import { getTaskEpisodeById } from "@/db/site-agent-store";
import { legacyCapabilityExperienceAuthority } from "@/lib/capability-center-v2/experience-authority";
import { appendAgentRunDebugEvents, authorizeAgentRunCapabilityExperience } from "@/db/agent-run-store";
import {
  CAPABILITY_EXPERIENCE_MAX_BYTES,
  capabilityExperienceHasPageEvidence,
  capabilityExperienceJsonSize,
  normalizeCapabilityExperience,
} from "@/lib/capability-center-v2/experience";
import { boundedJsonErrorStatus, readBoundedJson } from "@/lib/http/bounded-json";
import { makeDebugEvent, type CapabilityDebugEvent } from "@/lib/capability-center-v2/debug-trace";
import {
  assertCapabilityStartUrl,
  capabilityAgentAuthorized,
  capabilityJson,
  capabilityOptions,
  errorResponse,
  siteIdFromRequest,
} from "../http";

export async function OPTIONS() { return capabilityOptions(); }

function bearer(request: Request) {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/iu, "").trim() || "";
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await readBoundedJson<Record<string, unknown>>(request, CAPABILITY_EXPERIENCE_MAX_BYTES + 8_000); }
  catch (error) {
    const status = boundedJsonErrorStatus(error);
    return capabilityJson({ error: status === 413 ? "capability_experience_too_large" : "invalid_json" }, status || 400);
  }
  const siteId = siteIdFromRequest(request, body);
  if (!siteId) return capabilityJson({ error: "site_id_required" }, 400);
  if (!(await capabilityAgentAuthorized(request, siteId))) return capabilityJson({ error: "unauthorized" }, 401);
  const token = bearer(request);
  if (!token) return capabilityJson({ error: "agent_run_token_required" }, 401);

  let experience;
  try { experience = normalizeCapabilityExperience(body.experience); }
  catch (error) { return capabilityJson({ error: error instanceof Error ? error.message : "capability_experience_invalid" }, 400); }
  if (body.sourceAgentRunId !== experience.agentRunId
    || !capabilityExperienceHasPageEvidence(experience)
    || capabilityExperienceJsonSize(experience) > CAPABILITY_EXPERIENCE_MAX_BYTES) {
    return capabilityJson({ error: "capability_experience_invalid" }, 400);
  }

  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || experience.episodeId;
  const traceId = `generation:${experience.episodeId}`;
  const debugEvents: CapabilityDebugEvent[] = [];
  let activeModule = "agent-run.authorize";
  const emit = (input: Omit<Parameters<typeof makeDebugEvent>[0], "traceId" | "traceKind" | "siteId" | "correlation"> & { correlation?: Parameters<typeof makeDebugEvent>[0]["correlation"] }) => {
    debugEvents.push(makeDebugEvent({
      ...input,
      traceId,
      traceKind: "generation",
      siteId,
      correlation: { agentRunId: experience.agentRunId, episodeId: experience.episodeId, ...input.correlation },
    }));
  };
  const flush = () => appendAgentRunDebugEvents(experience.agentRunId, token, debugEvents).catch((error) => {
    console.warn("[capability-debug] experience events were not persisted", { traceId, error });
  });
  emit({ moduleId: "request.receive", lifecycle: "completed", input: { goal: experience.originalGoal, input: { experienceEpisodeId: experience.episodeId }, conversation: [] }, output: { agentRunId: experience.agentRunId, accepted: true } });
  emit({ moduleId: "experience.compact", lifecycle: "completed", input: { episode: { id: experience.episodeId, outcome: experience.outcome }, output: {} }, output: { experience, bytes: capabilityExperienceJsonSize(experience) } });
  emit({ moduleId: "agent-run.authorize", lifecycle: "started", input: { siteId, agentRunId: experience.agentRunId, episodeId: experience.episodeId, browserSessionId: "[redacted]" } });
  try {
    const authorized = await authorizeAgentRunCapabilityExperience(experience.agentRunId, token, experience, siteId);
    emit({ moduleId: "agent-run.authorize", lifecycle: "completed", output: { authorized: true, triggerAuthority: "AgentRun resume token" } });
    activeModule = "experience.validate";
    await Promise.all([
      assertCapabilityStartUrl(siteId, experience.startPage.url),
      assertCapabilityStartUrl(siteId, experience.endPage.url),
    ]);
    emit({ moduleId: "experience.validate", lifecycle: "completed", input: { sourceAgentRunId: experience.agentRunId, experience }, output: { accepted: true } });
    // Compatibility for already-deployed SDKs. The authenticated, stored Episode
    // owns the input. A browser retry must not run a second factory inline.
    activeModule = "experience.enqueue";
    const { episode } = await getTaskEpisodeById(siteId, experience.episodeId);
    const authority = episode && legacyCapabilityExperienceAuthority(authorized.run, episode);
    if (!authority) throw new Error("agent_run_capability_experience_rejected");
    const delivery = await enqueueCapabilityExperience(authority);
    emit({ moduleId: "request.idempotency", lifecycle: delivery.duplicate ? "handled" : "completed", output: { replay: delivery.duplicate, idempotencyKey } });
    await flush();
    return capabilityJson({ accepted: true }, 202, delivery.duplicate ? { "x-capability-v2-idempotent-replay": "1" } : {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!debugEvents.some((event) => event.lifecycle === "failed")) emit({ moduleId: activeModule, lifecycle: "failed", message, error: { code: message.split(":")[0] || "capability_experience_failed", message, retryable: /(?:timeout|temporar|unavailable|configured)/iu.test(message) } });
    await flush();
    if (message.includes("agent_run_")) return capabilityJson({ error: message.split(":")[0] }, 403);
    return errorResponse(error, "capability_experience_failed");
  }
}
