/**
 * The "is this site actually connected" verdict.
 *
 * There is one success criterion: the server received a handshake from the site
 * **within this detection window**. Client-side probes, timeout guesses and the SDK's
 * self-report do not count. Evidence comes two ways — the server dispatches a preview
 * job to load the page, or it waits for a handshake from a real visit — and both share
 * this rule set; the fallback path merely lacks the first half.
 *
 * Pure functions: inputs are facts already in the overview, no side effects, easy to
 * cover line by line.
 */

import { siteAgentShellIsEmpty } from "../site-knowledge/site-shell";
import { classifySiteAgentInstallation } from "../site-knowledge/site-preview-detection";

/** If no runner leases the job within this long, evidence collection is deemed impossible and we fall back to waiting for a handshake. */
export const DETECTION_PICKUP_TIMEOUT_MS = 30_000;
/**
 * Total time from start to giving up. One preview on the runner costs navigation 15 s +
 * fonts 5 s + selector wait 5 s, plus screenshot and artifact upload; 90 s leaves enough
 * headroom without making people wait idly.
 */
export const DETECTION_TOTAL_TIMEOUT_MS = 90_000;

/** Three causes of "no connection detected"; decides where the troubleshooting copy points. */
export type NotDetectedReason =
  /** No install tag on the page — the script was never added, or not in an entry loaded by every page. */
  | "script-missing"
  /** Tag present but no handshake — CSP blocked the SDK, wrong endpoint, or the registered domain does not match. */
  | "script-not-connecting"
  /** Tag present but belongs to another site. */
  | "foreign-install";

/** Two causes of evidence collection failing. */
export type UnavailableReason =
  /** The job itself failed: unreachable address, private network rejected by the guard, navigation failure. */
  | "job-failed"
  /** No runner leased the job. */
  | "never-leased";

export type DetectionState =
  /** No verdict yet: the job is running or a handshake is awaited. Not one of the three outcomes. */
  | { kind: "in-progress"; awaitingHandshakeOnly: boolean }
  /** Connected. */
  | { kind: "connected" }
  /** No connection detected. `foreignSiteAgentIds` appears only when bound to another site. */
  | { kind: "not-detected"; reason: NotDetectedReason; foreignSiteAgentIds?: string[] }
  /** Detection could not run; falling back to waiting for a handshake. */
  | { kind: "unavailable"; reason: UnavailableReason; error?: string };

export type DetectionJobFacts = {
  status: "queued" | "leased" | "running" | "succeeded" | "failed";
  createdAt: string;
  error?: string;
  /**
   * `try-install` is a rehearsal: the snippet is put into the page before it
   * is opened, to see what the browser would do with it. It answers a
   * different question and must never decide whether the site is installed.
   */
  mode?: "live" | "try-install";
};

export type DetectionPreviewFacts = {
  detectedSiteAgentIds?: string[];
  /** See DetectionJobFacts.mode: a rehearsal observed the snippet it injected itself. */
  mode?: "live" | "try-install";
};

export type DetectionInput = {
  /** The site being onboarded. Used to tell whether the id on the page is this site's. */
  siteAgentId: string;
  /**
   * Start of this detection window. Taken from the triggered job's `createdAt` — the
   * server clock, never the client's click time, which is untrusted. In pure handshake
   * waiting it is the moment waiting began (also server-provided).
   */
  windowStartedAt: string;
  /** The existing handshake timestamp, from `connection.lastSeenAt`. */
  lastSeenAt?: string;
  /** This round's evidence job. Absent means this round only waits for a handshake. */
  job?: DetectionJobFacts;
  /**
   * Page observation returned by a successful job. Trusted only when
   * `job.status === "succeeded"` — the overview carries the latest **successful** job's
   * result, which may be from an earlier round.
   */
  preview?: DetectionPreviewFacts;
  now: string;
  pickupTimeoutMs?: number;
  totalTimeoutMs?: number;
};

/** Whether the handshake falls inside this window. Equal does not count — nothing at or before the window start counts. */
export function handshakeIsFresh(lastSeenAt: string | undefined, windowStartedAt: string): boolean {
  if (!lastSeenAt) return false;
  const seen = Date.parse(lastSeenAt);
  const start = Date.parse(windowStartedAt);
  if (!Number.isFinite(seen) || !Number.isFinite(start)) return false;
  return seen > start;
}

function elapsedMs(now: string, since: string): number {
  const end = Date.parse(now);
  const start = Date.parse(since);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return 0;
  return end - start;
}

/**
 * The single entry point of the verdict. Order is priority: handshake is most
 * authoritative, then the job outcome, and page observation last.
 */
export function detectionState(input: DetectionInput): DetectionState {
  const {
    siteAgentId, windowStartedAt, lastSeenAt, now,
    pickupTimeoutMs = DETECTION_PICKUP_TIMEOUT_MS,
    totalTimeoutMs = DETECTION_TOTAL_TIMEOUT_MS,
  } = input;
  // A rehearsal put the snippet into the page itself, so what it saw says
  // nothing about what the page carries. Neither the job nor its observation
  // belongs to this round; without them the round waits, as it should.
  const job = input.job?.mode === "try-install" ? undefined : input.job;
  const preview = input.preview?.mode === "try-install" ? undefined : input.preview;

  // Handshake trumps everything: even if the job failed and the page showed nothing, a handshake inside the window means connected.
  if (handshakeIsFresh(lastSeenAt, windowStartedAt)) return { kind: "connected" };

  const waited = elapsedMs(now, windowStartedAt);

  // No evidence job: this round only waits for a handshake; on timeout it keeps waiting and never produces a failure verdict.
  if (!job) return { kind: "in-progress", awaitingHandshakeOnly: true };

  if (job.status === "failed") {
    return { kind: "unavailable", reason: "job-failed", ...(job.error ? { error: job.error } : {}) };
  }

  if (job.status === "queued") {
    if (waited >= pickupTimeoutMs) return { kind: "unavailable", reason: "never-leased" };
    return { kind: "in-progress", awaitingHandshakeOnly: false };
  }

  if (job.status === "leased" || job.status === "running") {
    if (waited >= totalTimeoutMs) return { kind: "unavailable", reason: "job-failed" };
    return { kind: "in-progress", awaitingHandshakeOnly: false };
  }

  // Job succeeded but no handshake: the page observation decides where troubleshooting points.
  const installation = classifySiteAgentInstallation(preview?.detectedSiteAgentIds, siteAgentId);
  if (installation.kind === "foreign") {
    return { kind: "not-detected", reason: "foreign-install", foreignSiteAgentIds: installation.siteAgentIds };
  }
  if (installation.kind === "self") return { kind: "not-detected", reason: "script-not-connecting" };
  return { kind: "not-detected", reason: "script-missing" };
}

/** When detection cannot run the UI switches to handshake waiting — this decides whether to switch. */
export function shouldAwaitHandshake(state: DetectionState): boolean {
  return state.kind === "unavailable";
}

/**
 * Which foreign ids on the page no longer have a site. After delete-and-re-add, or
 * for sites registered with a custom id, the snippet's id points nowhere — such an id
 * may be adopted by the current (empty) site. `sites` is the console's site list, used
 * only to save a request; the server still checks its own records.
 */
export function unownedInstallIds(verdict: DetectionState | undefined, sites: ReadonlyArray<{ id: string }>): string[] {
  if (verdict?.kind !== "not-detected" || verdict.reason !== "foreign-install") return [];
  const owned = new Set(sites.map((site) => site.id));
  return (verdict.foreignSiteAgentIds || []).filter((id) => !owned.has(id));
}

/**
 * What to do about an id on the page that belongs to no site.
 *
 * Deleting a site removes everything on this side, but not the line in the
 * customer's own codebase: the page keeps saying the old id. Re-adding the
 * address therefore has to converge on what the page says, by itself —
 * otherwise "delete and add again" is not the same as adding it the first
 * time. This is that decision, in one place, so the flow cannot offer a repair
 * that the server would refuse.
 */
export type InstallIdOffer =
  /** Nothing to reconcile, or the page's id belongs to another live site. */
  | { kind: "none" }
  /** Exactly one unowned id and this site holds nothing: take it, without asking. */
  | { kind: "adopt"; installId: string }
  /** Several unowned ids: only the operator knows which one this site is. */
  | { kind: "choose"; installIds: string[] }
  /** This site already holds data, so it cannot be replaced: the page must change. */
  | { kind: "change-page-id"; installIds: string[] };

export function installIdOffer(
  verdict: DetectionState | undefined,
  sites: ReadonlyArray<{ id: string }>,
  site: Parameters<typeof siteAgentShellIsEmpty>[0] | undefined,
): InstallIdOffer {
  const installIds = unownedInstallIds(verdict, sites);
  if (!installIds.length || !site) return { kind: "none" };
  if (!siteAgentShellIsEmpty(site)) return { kind: "change-page-id", installIds };
  if (installIds.length === 1) return { kind: "adopt", installId: installIds[0] };
  return { kind: "choose", installIds };
}
