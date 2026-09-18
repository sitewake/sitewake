import type { OutcomeStatus, TaskEpisodeSummary } from "../site-knowledge/protocol";
import { t, type Locale } from "../i18n";

/**
 * Copy shared by console views.
 *
 * These read from the lib/i18n catalog rather than holding strings inline, so
 * wording is reviewable in one place and the vocabulary stays consistent — the
 * same outcome previously read as "incomplete" in one view and "interrupted" in another.
 *
 * `locale` is optional and defaults to Chinese. It is threaded as a parameter
 * rather than read from a React context because these helpers are also called
 * from non-component modules.
 */

export function outcomeStatusLabel(status: OutcomeStatus, locale?: Locale) {
  const { outcome } = t(locale);
  return outcome.label[status] || outcome.label.unknown;
}

export function outcomeStatusHint(status: OutcomeStatus, locale?: Locale) {
  const { outcome } = t(locale);
  return outcome.hint[status] || outcome.hint.unknown;
}

export function outcomeLabel(episode: TaskEpisodeSummary, locale?: Locale) {
  return outcomeStatusLabel(episode.outcome.status, locale);
}

/**
 * Rewrites raw runtime errors into something a site owner can act on.
 *
 * Per docs/product-experience.md, failure copy should describe the business
 * consequence rather than leaking internal identifiers; anything unmatched falls
 * through with request ids stripped so at least no noise is shown.
 */
export function friendlySummary(value: string, locale?: Locale) {
  const { failure } = t(locale);
  if (
    value.includes("tool_choice") ||
    value.includes("Thinking mode does not support")
  )
    return failure.modelToolUnsupported;
  if (
    value.includes("Unknown action") ||
    value.includes("agent_protocol_invalid")
  )
    return failure.protocolInvalid;
  if (value.includes("adaptive_timeout")) return failure.adaptiveTimeout;
  if (value.includes("target_not_found") || value.includes("binding_not_found"))
    return failure.targetDrift;
  if (value.includes("extraction_proof_missing")) {
    return failure.extractionProofMissing(
      value.split("extraction_proof_missing:")[1]?.trim(),
    );
  }
  if (value.includes("function json_set")) return failure.legacyStorageAdapter;
  return value.replace(/\s*\(request id:[^)]+\)/gi, "").trim();
}

/** Coarse "how long ago", reading "not connected yet" for a site that never connected. */
export function relativeTime(value?: string, locale?: Locale) {
  const { time } = t(locale);
  if (!value) return time.neverConnected;
  const delta = Date.now() - Date.parse(value);
  if (delta < 60_000) return time.justNow;
  if (delta < 3_600_000) return time.minutesAgo(Math.floor(delta / 60_000));
  if (delta < 86_400_000) return time.hoursAgo(Math.floor(delta / 3_600_000));
  return time.daysAgo(Math.floor(delta / 86_400_000));
}
