import {
  normalizeGoal,
  stableHash,
  type CapabilityBuildTask,
  type TaskLaunch,
  type TaskLaunchStatus,
} from "./protocol";

function latestFirst(left: TaskLaunch, right: TaskLaunch) {
  const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
  if (byCreatedAt) return byCreatedAt;
  const byAttemptSequence = (right.attemptSequence || 0) - (left.attemptSequence || 0);
  if (byAttemptSequence) return byAttemptSequence;
  const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
  if (byUpdatedAt) return byUpdatedAt;
  // ISO timestamps have millisecond precision, so a replacement launch and
  // the pending attempt it cancels can legitimately tie. A random UUID is not
  // a clock: in that exact supersede tie, the surviving attempt is newer.
  const leftSuperseded = left.status === "cancelled" ? 1 : 0;
  const rightSuperseded = right.status === "cancelled" ? 1 : 0;
  return leftSuperseded - rightSuperseded || right.id.localeCompare(left.id);
}

function effectiveStatus(launch: TaskLaunch, nowMs: number): TaskLaunchStatus {
  // expiresAt is the unclaimed launch deadline. Once claimed, execution owns
  // its lifecycle and may validly continue beyond that initial deadline.
  if (launch.status === "pending" && Date.parse(launch.expiresAt) <= nowMs) return "expired";
  return launch.status;
}

function isActive(status: TaskLaunchStatus) {
  return status === "pending" || status === "claimed" || status === "running";
}

function publicResultUrl(value?: string) {
  return value?.replace(/#.*$/, "");
}

/**
 * Projects standalone navigation demonstrations into a public control-plane
 * view. The allowlisted result deliberately cannot expose launch credentials
 * or storage-only token/claim hashes.
 */
export function projectNavigationBuildTasks(
  launches: readonly TaskLaunch[],
  clock: Date | string | number = new Date(),
  currentLaunchIds: ReadonlyMap<string, string> = new Map(),
): CapabilityBuildTask[] {
  const nowMs = clock instanceof Date ? clock.getTime() : typeof clock === "number" ? clock : Date.parse(clock);
  const grouped = new Map<string, TaskLaunch[]>();

  for (const launch of launches) {
    if (launch.mode !== "demonstrate" || launch.projectId || launch.capabilityId) continue;
    const intentKey = normalizeGoal(launch.goal);
    if (!intentKey) continue;
    const attempts = grouped.get(intentKey) || [];
    attempts.push(launch);
    grouped.set(intentKey, attempts);
  }

  return [...grouped.entries()].map(([intentKey, attempts]) => {
    attempts.sort(latestFirst);
    // A retry transaction makes exactly one attempt active and marks every
    // superseded attempt cancelled. That database state is authoritative even
    // when concurrent requests commit in a different order than they started.
    const currentLaunchId = currentLaunchIds.get(intentKey);
    const latest = attempts.find((attempt) => attempt.id === currentLaunchId)
      || attempts.find((attempt) => isActive(effectiveStatus(attempt, nowMs)))
      || attempts[0];
    const status = effectiveStatus(latest, nowMs);
    const resultUrl = publicResultUrl(latest.resultUrl);
    const result = latest.outcome || latest.output || resultUrl
      ? { outcome: latest.outcome, output: latest.output, url: resultUrl }
      : undefined;
    return {
      id: `navigation-build:${stableHash(`${latest.siteAgentId}:${intentKey}`)}`,
      siteAgentId: latest.siteAgentId,
      intentKey,
      classification: "navigation",
      assetKind: "navigation-tool",
      goal: latest.goal,
      status,
      latestLaunchId: latest.id,
      attemptCount: attempts.length,
      createdAt: attempts.reduce(
        (earliest, attempt) => attempt.createdAt < earliest ? attempt.createdAt : earliest,
        latest.createdAt,
      ),
      updatedAt: status === "expired" && latest.status !== "expired" ? latest.expiresAt : latest.updatedAt,
      expiresAt: latest.expiresAt,
      completedAt: latest.completedAt,
      result,
      error: latest.error,
    } satisfies CapabilityBuildTask;
  }).toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
}
