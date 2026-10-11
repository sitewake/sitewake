import type { AgentConfig } from "../site-knowledge/protocol";

/**
 * The three texts the editor shows with an automatic value already in the box.
 *
 * They are `value`, not `placeholder`, so the editor and the preview beside it
 * agree about what an untouched site says to its visitors. The cost is that a
 * typed value and an automatic one are indistinguishable once submitted, which
 * is why the automatic one has to be named here rather than recomputed.
 */
export type ShownAutomaticCopy = {
  displayName: string;
  welcomeTitle: string;
  welcomeDescription: string;
  /** What the question boxes are filled with when nothing has been written. */
  suggestions: string[];
};

const SHOWN_FIELDS = ["displayName", "welcomeTitle", "welcomeDescription"] as const;

/**
 * Drop the customisations that are not customisations.
 *
 * A field counts as customised only when it differs from the automatic value
 * the editor had in the box at that moment. Deciding this anywhere else means
 * comparing against a second, independently computed automatic value, and the
 * two drift the moment site knowledge improves between them: a site that
 * nobody ever edited ends up with its name pinned to an early guess, and the
 * promise that untouched copy follows the site's knowledge quietly stops
 * holding. The editor is the only place that knows both what it displayed and
 * what the person did with it.
 *
 * The questions are a list rather than three independent fields, so they are
 * kept or dropped together: editing one and leaving the others as offered
 * should not reorder what a visitor sees, or silently drop the one the editor
 * never touched.
 */
export function withoutUnchangedOverrides(config: AgentConfig, shown: ShownAutomaticCopy): AgentConfig {
  const overrides = { ...(config.overrides || {}) };
  for (const field of SHOWN_FIELDS) {
    const value = overrides[field];
    if (typeof value === "string" && sameText(value, shown[field])) delete overrides[field];
  }
  const pinned = (overrides.pinnedSuggestions || []).map((item) => item.trim()).filter(Boolean);
  const offered = (shown.suggestions || []).map((item) => item.trim()).filter(Boolean);
  if (pinned.length === offered.length && pinned.every((item, index) => sameText(item, offered[index]))) {
    overrides.pinnedSuggestions = [];
  }
  return { ...config, overrides };
}

/**
 * Same to the system, not merely byte-identical.
 *
 * Saved copy is normalised on its way through (NFKC, collapsed whitespace),
 * while the automatic sentence is a template that never takes that trip. The
 * generated welcome title ends in a full-width question mark and anything that
 * has been saved once ends in a half-width one, so a byte comparison between
 * them can never match and the field would stay a customisation forever.
 */
function sameText(left: string, right: string) {
  const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
  return normalize(left) === normalize(right);
}
