/**
 * The canonical, self-contained Site Knowledge base: a single JSON that answers
 * "what is this site, what pages does it have, how do they connect". It is the
 * agent's guidance for capability invocation. Both production lines — the crawler
 * (`origin: "crawl"`) and usage/exploration (`origin: "usage"`) — merge into one
 * of these. It carries source knowledge only (profile / scenes / links); no
 * execution or config (operations/capabilities/targets/agentConfig live in the
 * Release, which references this by version). The site-map topology is a pure
 * derivation of scenes + links (`buildBusinessTopologyFromParts`), computed on
 * demand by consumers — never stored here.
 */
import { stableHash, type LinkReference, type SceneDefinition, type SiteAgentReleaseV2, type SiteProfile } from "./protocol";

export type SiteKnowledge = {
  schemaVersion: "site-knowledge/v1";
  siteAgentId: string;
  version: number;
  contentHash: string;
  updatedAt: string;
  profile: SiteProfile;
  scenes: SceneDefinition[];
  links: LinkReference[];
  /** URL classes judged "data pages" across instances — instance bodies are not indexed, only this description. Substantive knowledge, part of the fingerprint. */
  dataPageTypes?: Array<{ urlPattern: string; name: string; description: string; instanceCount: number }>;
};

/**
 * Keys that change every time a page is merely re-observed (visit timestamps,
 * growing evidence logs, per-visit counters) but carry no new *business* meaning.
 * Excluding them from the knowledge fingerprint is what stops a re-visit from
 * minting a new version / re-triggering review (the self-consumption trap).
 */
const VOLATILE_HASH_KEYS = new Set([
  "updatedAt", "createdAt", "attemptedAt", "reviewedAt", "completedAt", "capturedAt",
  "sourceObservationIds", "observedUrls", "observations", "sampleCount", "examples",
  "identityConfidence", "evidenceCount", "lastSeenAt", "connectedAt",
  // Entry-health churn: counters/timestamps update on every run and must never
  // re-version the release; the directEntry/evidenceStatus TRANSITION is what is
  // material (and stays in the hash).
  "entryHealth", "lastVerifiedAt", "lastOkAt", "lastFailAt", "demotedAt", "verificationFailure",
]);

/** Recursively drops the volatile keys above, at any depth, for a stable material hash. */
export function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (!VOLATILE_HASH_KEYS.has(key)) out[key] = stripVolatile(inner);
    }
    return out;
  }
  return value;
}

/**
 * A stable hash of the *business-meaningful* knowledge only — page identity, URL
 * templates, parameter names, business semantics, link edges, evidence status —
 * with per-visit churn (timestamps, observed-url logs, examples) stripped. Two
 * states that differ only by re-observation hash identically.
 */
export function materialKnowledgeHash(input: { profile: SiteProfile; scenes: SceneDefinition[]; links: LinkReference[] }): string {
  return stableHash(JSON.stringify(stripVolatile({ profile: input.profile, scenes: input.scenes, links: input.links })));
}

/** Builds a self-contained SiteKnowledge from its source parts (content hash stamped).
 * Topology is not stored — consumers derive it from scenes + links on demand. */
export function buildSiteKnowledge(input: {
  siteAgentId: string;
  version: number;
  updatedAt: string;
  profile: SiteProfile;
  scenes: SceneDefinition[];
  links: LinkReference[];
  dataPageTypes?: SiteKnowledge["dataPageTypes"];
}): SiteKnowledge {
  const contentHash = materialKnowledgeHash(input);
  return {
    schemaVersion: "site-knowledge/v1",
    siteAgentId: input.siteAgentId,
    version: input.version,
    contentHash,
    updatedAt: input.updatedAt,
    profile: input.profile,
    scenes: input.scenes,
    links: input.links,
    ...(input.dataPageTypes?.length ? { dataPageTypes: input.dataPageTypes } : {}),
  };
}

/**
 * Derives a SiteKnowledge from a Release's embedded knowledge. Used for the
 * Phase-A dual write and for backfilling/migrating existing releases; once the
 * Release stops embedding knowledge (Phase C) this reads from the store instead.
 */
export function siteKnowledgeFromRelease(release: SiteAgentReleaseV2): SiteKnowledge {
  return buildSiteKnowledge({
    siteAgentId: release.siteAgentId,
    version: release.version,
    updatedAt: release.createdAt,
    profile: release.profile,
    scenes: release.scenes,
    links: release.linkReferences || [],
    dataPageTypes: release.dataPageTypes,
  });
}

/**
 * Storage shape (Phase C): a release with the heavy knowledge (scenes + links)
 * sliced out — deduped into `site_agent_v2_knowledge` — leaving a KnowledgeRevision
 * reference and a denormalized `sceneCount` for list summaries. Profile and all
 * execution (operations/capabilities/targets/...) stay inline on the release.
 * `knowledgeVersion` is the legacy pointer column, kept for back-compat reads; the
 * authoritative reference is `release.knowledgeRevision` (both carry the revision).
 */
export type StoredRelease = Omit<SiteAgentReleaseV2, "scenes" | "linkReferences"> & {
  scenes: never[];
  linkReferences: never[];
  knowledgeVersion: number;
  sceneCount: number;
};

/** Slims a release for storage: scenes/links move to the knowledge table. */
export function stripReleaseKnowledge(release: SiteAgentReleaseV2, knowledge: SiteKnowledge): StoredRelease {
  return { ...release, scenes: [], linkReferences: [], knowledgeRevision: release.knowledgeRevision ?? knowledge.version, knowledgeVersion: knowledge.version, sceneCount: knowledge.scenes.length };
}

/**
 * Resolves the KnowledgeRevision a release points at, newest pointer first:
 * the first-class `knowledgeRevision`, then the legacy slim `knowledgeVersion`
 * column, then `version` (an un-migrated embedded release whose revision equals
 * its release version by construction). Always returns a usable revision.
 */
export function knowledgeRevisionOf(release: SiteAgentReleaseV2): number {
  const stored = release as SiteAgentReleaseV2 & { knowledgeVersion?: number };
  return release.knowledgeRevision ?? stored.knowledgeVersion ?? release.version;
}

/**
 * Restores a stored (slim) release to its full shape by rehydrating scenes/links
 * from the knowledge base. Drops the storage-only fields so the release re-hashes
 * byte-identically to the pre-Phase-C embedded release (etags/dedup depend on it).
 */
export function rehydrateReleaseKnowledge(release: SiteAgentReleaseV2, knowledge: SiteKnowledge): SiteAgentReleaseV2 {
  const stored = release as SiteAgentReleaseV2 & { knowledgeVersion?: number; sceneCount?: number };
  const rest = { ...stored };
  delete rest.knowledgeVersion;
  delete rest.sceneCount;
  return { ...(rest as SiteAgentReleaseV2), scenes: knowledge.scenes, linkReferences: knowledge.links };
}

/** True when a release still carries its knowledge inline (un-migrated / freshly written). */
export function releaseEmbedsKnowledge(release: SiteAgentReleaseV2): boolean {
  return Array.isArray(release.scenes) && release.scenes.length > 0;
}
