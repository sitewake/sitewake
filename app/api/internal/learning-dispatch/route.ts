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
    // One experience per dispatch. Turning a run into a capability goal takes
    // two model calls in series — abstract the episode, then ask whether the
    // site already has this capability — which is 15 to 75 seconds of waiting.
    // Two of those in one request could not finish inside the caller's window,
    // and the intake was cut off with "The operation was aborted due to
    // timeout" while the exploration behind it had succeeded. The launcher
    // polls every two seconds, so nothing is slower for doing one at a time.
    processCapabilityExperienceOutbox(1),
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
