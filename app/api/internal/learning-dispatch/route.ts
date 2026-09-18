import { processQueuedCapabilitySignals, processQueuedLearningDesigns } from "@/db/site-agent-store";
import { processQueuedEffectAnalyses } from "@/db/effect-store";
import { processCapabilityExperienceOutbox } from "@/db/capability-experience-outbox-store";
import { runnerAuthorized } from "@/app/api/capability-v2/http";

/**
 * Invoked exclusively by the Worker's scheduled handler.  Browser authoring
 * stays out of this path: it is safe to run with no browser or user page.
 */
export async function POST(request: Request) {
  if (!runnerAuthorized(request)) {
    return Response.json({ error: "unauthorized" }, {
      status: 401,
      headers: { "cache-control": "no-store" },
    });
  }
  // Site knowledge is not dispatched here: review is a step of the crawl with no background queue. Only the capability center paths remain.
  const [capabilitySignals, capabilities, effects, capabilityExperiences] = await Promise.all([
    processQueuedCapabilitySignals(undefined, 1),
    processQueuedLearningDesigns(undefined, 1),
    processQueuedEffectAnalyses(2),
    processCapabilityExperienceOutbox(2),
  ]);
  const result = {
    capabilitySignals,
    capabilities,
    effects,
    capabilityExperiences,
    processed: capabilitySignals.processed + capabilities.processed + effects.processed + capabilityExperiences.processed,
  };
  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
