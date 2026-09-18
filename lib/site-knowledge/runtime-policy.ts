export type SiteAgentRuntimeMode = "full" | "read-only";

const READ_ONLY_MUTATING_ACTIONS = new Set([
  "check",
  "click",
  "delete",
  "drag",
  "drop",
  "fill",
  "press",
  "select",
  "submit",
  "toggle",
  "type",
  "upload",
]);

function normalizedAction(action: string) {
  return action.trim().replace(/[\s_-]+/g, "").toLowerCase();
}

export function runtimeActionAllowed(mode: SiteAgentRuntimeMode, action: string) {
  return mode === "full" || !READ_ONLY_MUTATING_ACTIONS.has(normalizedAction(action));
}

export function assertRuntimeActionAllowed(mode: SiteAgentRuntimeMode, action: string) {
  if (runtimeActionAllowed(mode, action)) return;
  throw new Error(`runtime_read_only_${normalizedAction(action)}_forbidden`);
}

/**
 * Whether a click does nothing but follow a link to another page of this site.
 *
 * Read-only already permits same-origin navigation — entering a verified Scene
 * from the knowledge base is exactly that — so refusing a click that arrives at
 * the same kind of destination grants no authority the mode did not already
 * give. Treating every click as a write left the assistant unable to open
 * anything the knowledge base had not already recorded a URL for: "open that
 * hot-search entry" was refused even though the classifier reads it as a read.
 *
 * Takes the raw `href` attribute rather than the resolved property, because the
 * two cases this must reject — `href="#"` and `href=""` — resolve to a URL that
 * looks like an ordinary destination. Those are how a button gets styled as a
 * link, so whatever they do happens in a script handler, not in a navigation.
 */
export function isReadOnlyNavigationClick(rawHref: string | null | undefined, currentUrl: string) {
  const href = String(rawHref ?? "").trim();
  if (!href || href === "#") return false;
  try {
    const destination = new URL(href, currentUrl);
    const current = new URL(currentUrl);
    if (!["http:", "https:"].includes(destination.protocol)) return false;
    if (destination.origin !== current.origin) return false;
    // A destination equal to where we already are navigates nowhere, which
    // means the click's real effect is in a handler rather than the href.
    const withoutEmptyHash = (value: string) => value.replace(/#$/, "");
    return withoutEmptyHash(destination.href) !== withoutEmptyHash(current.href);
  } catch {
    return false;
  }
}

export function assertRuntimeTeachingAllowed(mode: SiteAgentRuntimeMode) {
  if (mode === "read-only") throw new Error("runtime_read_only_teach_forbidden");
}

export function assertRuntimeNavigationAllowed(mode: SiteAgentRuntimeMode, rawUrl: string, baseUrl: string) {
  if (mode !== "read-only") return;
  const destination = new URL(rawUrl, baseUrl);
  if (destination.origin !== new URL(baseUrl).origin) {
    throw new Error("runtime_read_only_cross_origin_navigation_forbidden");
  }
}

/**
 * A public read-only embedding must fail open to the host's legacy assistant
 * when its authoritative runtime Release is unavailable. Full mode keeps the
 * historical cached/offline fallback; execution-pinned launches are strict in
 * every mode because running another Release would violate their contract.
 */
export async function enforceRuntimeReleaseReadiness(
  mode: SiteAgentRuntimeMode,
  executionPinned: boolean,
  authoritativeRelease: Promise<unknown>,
) {
  if (mode === "read-only" || executionPinned) {
    await authoritativeRelease;
    return;
  }
  await authoritativeRelease.catch(() => undefined);
}
