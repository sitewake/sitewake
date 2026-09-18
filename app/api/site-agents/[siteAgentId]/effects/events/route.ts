import { appendEngagementEvent } from "@/db/effect-store";
import { siteAgentExists } from "@/db/site-agent-store";
import { persistenceHeaders, siteAgentJson, siteAgentOptions } from "../../../http";
import type { JsonValue } from "@/lib/site-knowledge/protocol";

type RouteContext = {
  params:
    | Promise<{ siteAgentId: string }>
    | { siteAgentId: string };
};

const eventTypes = new Set([
  "agent-seen",
  "agent-opened",
  "suggestion-selected",
  "goal-submitted",
  "result-seen",
  "feedback-submitted",
  "runtime-startup-failed",
]);

export async function OPTIONS() {
  return siteAgentOptions();
}

export async function POST(request: Request, context: RouteContext) {
  const { siteAgentId: rawId } = await context.params;
  const siteAgentId = decodeURIComponent(rawId || "").trim();
  if (!siteAgentId || !(await siteAgentExists(siteAgentId)))
    return siteAgentJson({ error: "site_agent_not_found" }, 404);
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return siteAgentJson({ error: "invalid_json" }, 400);
  }
  const browserSessionId = String(body.browserSessionId || "").trim();
  const type = String(body.type || "").trim();
  if (
    !browserSessionId ||
    browserSessionId.length > 200 ||
    !eventTypes.has(type)
  )
    return siteAgentJson({ error: "invalid_engagement_event" }, 400);
  try {
    const result = await appendEngagementEvent({
      siteAgentId,
      browserSessionId,
      runId: body.runId ? String(body.runId).slice(0, 200) : undefined,
      type: type as Parameters<typeof appendEngagementEvent>[0]["type"],
      metadata:
        body.metadata &&
        typeof body.metadata === "object" &&
        !Array.isArray(body.metadata)
          ? (body.metadata as Record<string, JsonValue>)
          : undefined,
    });
    return siteAgentJson(
      { accepted: true },
      202,
      persistenceHeaders(result.persistence),
    );
  } catch (error) {
    return siteAgentJson(
      {
        error: "engagement_event_failed",
        message: error instanceof Error ? error.message : "unknown",
      },
      500,
    );
  }
}
