import type { TaskEpisodeSummary } from "../site-knowledge/protocol";

/** A bounded recent sample, never an all-time success rate. */
export function recentOutcomeCounts(episodes: TaskEpisodeSummary[]) {
  const unique = [...new Map(episodes.map((episode) => [episode.id, episode])).values()];
  return {
    total: unique.length,
    success: unique.filter((episode) => episode.outcome.status === "success").length,
    faults: unique.filter((episode) => episode.outcome.status === "execution-fault").length,
    unknown: unique.filter((episode) => !["success", "execution-fault", "business-rejection", "no-result"].includes(episode.outcome.status)).length,
  };
}

// The install snippet moved to `install-guide.ts`: onboarding needs four stack-specific
// forms and the connection settings page needs the HTML one, and both must be one source.
// No re-export here — a relative import would break tests that load this file directly
// with `--experimental-strip-types`. Consumers import from there.
