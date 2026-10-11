"use client";

import type { OutcomeStatus } from "@/lib/site-knowledge/protocol";
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";

type Tone = "neutral" | "ok" | "danger" | "warn" | "accent";

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`sa-pill${tone === "neutral" ? "" : ` sa-pill--${tone}`}`}>{children}</span>;
}

/**
 * The five-outcome taxonomy from docs/site-agent-system-design.md.
 *
 * Rendering these through one component is what keeps the vocabulary stable:
 * the same status previously read as "incomplete" in one view and "interrupted" in
 * another. Each pill carries a glyph as well as a hue, so the distinction
 * survives for color-blind users (WCAG 1.4.1).
 */
const { label: OUTCOME_LABEL, hint: OUTCOME_HINT } = t().outcome;

export function outcomeLabel(status: OutcomeStatus) {
  return OUTCOME_LABEL[status] || OUTCOME_LABEL.unknown;
}

export function outcomeHint(status: OutcomeStatus) {
  return OUTCOME_HINT[status] || OUTCOME_HINT.unknown;
}

export function OutcomeBadge({ status, hint = true }: { status: OutcomeStatus; hint?: boolean }) {
  return (
    <span
      className={`sa-pill sa-pill--outcome sa-pill--${status}`}
      title={hint ? outcomeHint(status) : undefined}
    >
      {outcomeLabel(status)}
    </span>
  );
}
