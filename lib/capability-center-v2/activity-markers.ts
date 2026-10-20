/**
 * Progress events carry a stable English marker, never prose: a runner has no
 * reader and no locale, so it names what happened and the console words it in
 * the reader's language (`capability.v2.screen.activityMessage`). Values that
 * vary — a case number, a field — travel in the event's payload.
 *
 * These markers are the authoring loop's notes to itself. They are worded like
 * every other marker but kept out of the progress feed.
 */
export const FEED_HIDDEN_ACTIVITY = new Set(["model turn", "capability.ts written", "building the module"]);

/** The data a runner attached to an event, wherever the store nested it. */
export function activityData(payload: Record<string, unknown>): Record<string, unknown> {
  const nested = payload.payload;
  return nested && typeof nested === "object" && !Array.isArray(nested) ? { ...payload, ...(nested as Record<string, unknown>) } : payload;
}
