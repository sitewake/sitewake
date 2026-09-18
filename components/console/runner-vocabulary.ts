import type { RunnerWorkKind } from "../../lib/runner-control/protocol";
import { t } from "../../lib/i18n";

/**
 * Runner-console vocabulary and pure formatting helpers.
 *
 * Kept separate from the runner views so the labels are reviewable in one place
 * rather than scattered through 2500 lines of JSX. Note `relativeTime` here is
 * deliberately not the console-wide one in lib/console/copy.ts: a runner that
 * never reported reads "not reported yet" rather than "not connected", and
 * second-level granularity matters when watching a lease.
 *
 * Every label is a lookup *function*, never a module-level map. `t()` resolves
 * against `<html lang>`, which does not exist when this module is first
 * evaluated — a map built up here would freeze at the default language.
 */

export function workKindLabel(kind: RunnerWorkKind) {
  return t().runner.workKind[kind];
}

export function roleLabel(role?: string) {
  const labels = t().runner.role;
  return labels[role || ""] || role || labels.mixed;
}

export function browserModeLabel(mode?: string) {
  return t().runner.browserMode[mode || ""] || mode || "";
}

export function stateTone(value?: string) {
  if (
    ["ready", "idle", "online", "healthy", "active", "available"].includes(
      value || "",
    )
  )
    return "healthy";
  if (
    ["busy", "partial", "starting", "completing", "running"].includes(
      value || "",
    )
  )
    return "active";
  if (["completed", "released", "passed"].includes(value || ""))
    return "healthy";
  if (
    ["degraded", "stale", "draining", "congested", "queued"].includes(
      value || "",
    )
  )
    return "warning";
  if (
    ["offline", "unavailable", "error", "failed", "expired"].includes(
      value || "",
    )
  )
    return "danger";
  return "muted";
}

export function stateLabel(value?: string) {
  const copy = t().runner;
  return copy.state[value || ""] || value || copy.stateUnknown;
}

export function relativeTime(value?: string) {
  const copy = t().runner.time;
  if (!value) return copy.notReported;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return copy.unknown;
  const delta = Math.max(0, Date.now() - parsed);
  if (delta < 15_000) return copy.justNow;
  if (delta < 60_000) return copy.secondsAgo(Math.floor(delta / 1000));
  if (delta < 3_600_000) return copy.minutesAgo(Math.floor(delta / 60_000));
  if (delta < 86_400_000) return copy.hoursAgo(Math.floor(delta / 3_600_000));
  return copy.daysAgo(Math.floor(delta / 86_400_000));
}

export function durationSince(value?: string) {
  const copy = t().runner.time;
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  if (seconds < 60) return copy.seconds(seconds);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return copy.minutes(minutes);
  return copy.hoursMinutes(Math.floor(minutes / 60), minutes % 60);
}
