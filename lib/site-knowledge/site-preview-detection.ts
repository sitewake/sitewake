/**
 * Normalization of the "whose install is on the page" fact in a site preview.
 *
 * Ids are copied from the previewed site's HTML (`script[data-site-agent]`), the only
 * part of the preview payload decided by a third-party page, so they are clamped once
 * before the runner sends and once before the control plane stores, sharing this code.
 */

/** At most this many site ids recorded per page; extras are dropped. */
export const MAX_DETECTED_SITE_AGENT_IDS = 8;
/** Maximum characters per id; longer ones are truncated. */
export const MAX_SITE_AGENT_ID_LENGTH = 200;

/** Trim, drop empties, dedupe, truncate, cap. Input may be arbitrary junk. */
export function normalizeDetectedSiteAgentIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const cleaned = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => value.slice(0, MAX_SITE_AGENT_ID_LENGTH));
  return [...new Set(cleaned)].slice(0, MAX_DETECTED_SITE_AGENT_IDS);
}

/** How the installs observed on the page relate to the site being onboarded. */
export type SiteAgentInstallation =
  /** No script tag with a site id at all. */
  | { kind: "absent" }
  /** At least one tag uses this site's id. */
  | { kind: "self" }
  /** Install tags exist, but none belongs to this site. */
  | { kind: "foreign"; siteAgentIds: string[] };

/**
 * Classifies observed ids into one of three relations. Note "this site and another"
 * counts as `self`: this site's install is really there, the other is the page's own
 * business and must not block the user in the flow.
 */
export function classifySiteAgentInstallation(
  observedSiteAgentIds: unknown,
  siteAgentId: string,
): SiteAgentInstallation {
  const ids = normalizeDetectedSiteAgentIds(observedSiteAgentIds);
  if (!ids.length) return { kind: "absent" };
  if (ids.includes(siteAgentId)) return { kind: "self" };
  return { kind: "foreign", siteAgentIds: ids };
}
