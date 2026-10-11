import { resolveWidgetLocale, widgetCopy } from "./user-agent-copy";

/**
 * A handshake refused because the page's address is not registered is the only
 * server refusal worth a line in the host page's console: the developer
 * installing SiteWake is looking right at it, and the fix is one click in the
 * console. Anything else is left silent.
 */
export async function reportUnregisteredOrigin(response: Response) {
  try {
    const body = await response.clone().json() as { reason?: string; origin?: string; registered?: string[] };
    if (body?.reason !== "origin_not_registered") return;
    const copy = widgetCopy(resolveWidgetLocale());
    console.error(copy.diagnostics.originNotRegistered(body.origin || location.origin, Array.isArray(body.registered) ? body.registered : []));
  } catch {
    // A refusal we cannot read is not worth guessing about.
  }
}
