import { t, type Locale } from "../i18n";

/** Management projection: no browser tokens or raw page evidence leave storage. */
export type CapabilityExperienceIntake = {
  id: string;
  episodeId: string;
  runId: string;
  goal: string;
  status: "pending" | "evidence-pending" | "processing" | "completed" | "failed";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  lastError?: string;
  disposition?: string;
  taskId?: string;
  capabilityId?: string;
  reason?: string;
};

export function experienceIntakeLabel(item: CapabilityExperienceIntake, locale?: Locale) {
  const copy = t(locale).capability.v2.intake;
  if (item.status === "failed") return copy.failed;
  if (item.status === "processing") return copy.processing;
  if (item.status === "evidence-pending") return copy.evidencePending;
  if (item.status === "pending") return item.lastError ? copy.waitingRetry : copy.waitingGeneration;
  if (item.disposition === "Created") return copy.created;
  if (item.disposition === "Disabled") return copy.disabled;
  return copy.linked;
}
