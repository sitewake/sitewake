import type { SiteAgentReleaseV2 } from "../lib/site-knowledge/protocol";

/**
 * `/release?runtime=1` is the authoritative source of runtime feature flags.
 * A same-version `/connection` response contains the knowledge Release but no
 * runtime-only flags and may resolve later during page bootstrap. Preserve the
 * last authoritative projection so a navigation handoff cannot silently turn
 * Evidence V2 off in the destination document.
 */
export function preserveRuntimeReleaseFeatures(
  current: SiteAgentReleaseV2,
  incoming: SiteAgentReleaseV2,
): SiteAgentReleaseV2 {
  if (incoming.runtimeFeatures || !current.runtimeFeatures) return incoming;
  return { ...incoming, runtimeFeatures: current.runtimeFeatures };
}
