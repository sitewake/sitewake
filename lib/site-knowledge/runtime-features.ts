import type { SiteAgentRuntimeFeatures } from "./protocol.ts";

type RuntimeFeatureEnvironment = Record<string, string | undefined>;

function rolloutHash(input: string) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Supported rollout values:
 * - `1`, `true`, `on`, `all`: every site
 * - `0`, `false`, `off`, empty: no sites
 * - `sites:site-a,site-b`: an explicit canary allow-list
 * - `percent:10`: a deterministic site-level percentage
 */
export function siteRolloutEnabled(raw: string | undefined, siteAgentId: string) {
  const value = raw?.trim().toLowerCase() || "off";
  if (["1", "true", "on", "all"].includes(value)) return true;
  if (["0", "false", "off", "none"].includes(value)) return false;
  if (value.startsWith("sites:")) {
    return value.slice("sites:".length).split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .includes(siteAgentId.toLowerCase());
  }
  if (value.startsWith("percent:")) {
    const percentage = Number(value.slice("percent:".length));
    if (!Number.isFinite(percentage) || percentage <= 0) return false;
    if (percentage >= 100) return true;
    const bucket = rolloutHash(`page-agent-runtime-v2:${siteAgentId}`) % 10_000;
    return bucket < Math.round(percentage * 100);
  }
  return false;
}

/** Read one rollout variable. `SITEWAKE_*` is the only name that is read. */
function brandedRollout(environment: RuntimeFeatureEnvironment, suffix: string) {
  return environment[`SITEWAKE_${suffix}`];
}

export function siteAgentRuntimeFeatures(
  siteAgentId: string,
  environment: RuntimeFeatureEnvironment = process.env,
): SiteAgentRuntimeFeatures {
  const pageAgentRuntimeV2 = siteRolloutEnabled(brandedRollout(environment, "PAGE_AGENT_RUNTIME_V2"), siteAgentId);
  return {
    pageAgentRuntimeV2,
    // Evidence V2 cannot be enabled without the runtime that produces aligned
    // observations and action receipts.
    pageAgentEvidenceV2: pageAgentRuntimeV2
      && siteRolloutEnabled(brandedRollout(environment, "PAGE_AGENT_EVIDENCE_V2"), siteAgentId),
    capabilityExperienceOutbox: siteRolloutEnabled(
      brandedRollout(environment, "CAPABILITY_EXPERIENCE_OUTBOX"),
      siteAgentId,
    ),
  };
}

export function runtimeFeatureEtag(features: SiteAgentRuntimeFeatures) {
  return [
    features.pageAgentRuntimeV2 ? "r2" : "r1",
    features.pageAgentEvidenceV2 ? "e2" : "e1",
    features.capabilityExperienceOutbox ? "o2" : "o1",
  ].join("-");
}
