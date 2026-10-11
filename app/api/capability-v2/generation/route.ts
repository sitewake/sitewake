import { capabilityJson, capabilityOptions, capabilityWriteAuthorized, siteIdFromRequest, errorResponse } from "../http";
import { appendTaskEvent } from "@/db/capability-center-v2-store";
import { createDiscoveryFromGenerationInput } from "@/lib/capability-center-v2/experience-service";
import type { CapabilityGenerationInput, JsonObject, JsonValue } from "@/lib/capability-center-v2/model";
import type { CapabilityDebugEvent } from "@/lib/capability-center-v2/debug-trace";

export async function OPTIONS() { return capabilityOptions(); }

/** B boundary: both Episode and Admin callers converge on one input/output. */
export async function POST(request: Request) {
  let body: CapabilityGenerationInput;
  try { body = await request.json() as CapabilityGenerationInput; }
  catch { return capabilityJson({ error: "invalid_json" }, 400); }
  const siteId = siteIdFromRequest(request, body as unknown as Record<string, unknown>);
  if (!siteId) return capabilityJson({ error: "site_id_required" }, 400);
  if (!(await capabilityWriteAuthorized(request))) return capabilityJson({ error: "unauthorized" }, 401);
  try {
    const debugEvents: CapabilityDebugEvent[] = [];
    const result = await createDiscoveryFromGenerationInput(siteId, body, {
      onDebugEvent: (event) => debugEvents.push(event),
    });
    if (result.disposition === "Created") {
      for (const event of debugEvents) {
        const debugEvent: CapabilityDebugEvent = {
          ...event,
          correlation: { ...event.correlation, taskId: result.task.id },
        };
        await appendTaskEvent(siteId, result.task.id, {
          id: event.eventId,
          eventType: `Boundary:${event.module.id}:${event.lifecycle}`,
          payload: { debugEvent: debugEvent as unknown as JsonValue } as JsonObject,
        });
      }
    }
    return capabilityJson(result, result.disposition === "Created" ? 202 : 200);
  } catch (error) { return errorResponse(error, "capability_generation_failed"); }
}
