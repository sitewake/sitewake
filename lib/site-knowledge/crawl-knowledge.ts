/**
 * The onboarding crawler's single JSON deliverable and the pure logic that
 * assembles it. Three sections with non-overlapping roles:
 *   - `profile` : the site knowledge base (semantic layer / SiteProfile)
 *   - `scenes`  : nodes (URL-clustered page identities)
 *   - `links`   : edges (LinkReference; label + landmark live on the edge)
 *
 * The site-map topology is a pure derivation of scenes + links, computed on demand
 * by consumers (`buildBusinessTopologyFromParts`); it is never carried in the
 * document or the knowledge base.
 *
 * Crawled scenes are stamped `evidenceStatus: "crawled"` and `origin: "crawl"`
 * — a base layer the Agent adopts as its initial Release; usage learning layers
 * verified operations/capabilities on top. Assembly reuses the existing
 * discovery/clustering logic; nothing here re-implements them.
 */
import { CrawlFrontier } from "./crawl-frontier";
import { discoverInitialKnowledge, mergeSceneEvidence } from "./discovery";
import { analyzeSiteProfile, clusterUrlFamilies, describePage, describePageType, judgeContentBlocks } from "./model-analyzer";
import { createArbiterSession } from "./content-arbiter";
import type { RawBlock } from "./content-filter";
import { analyzeTemplateGroup, applyTimeVerdict, hasProseBlock, observePage, recrawlHint, stripConstantBlocks, structureSignature, timeLayerVerdict, type PageObservation, type PageTimeStatus } from "./content-comparison";
import { emptyRelease, stableHash, type LinkReference, type PageSnapshot, type SceneDefinition, type SiteAgentReleaseV2, type SiteProfile } from "./protocol";
import type { ContentPage } from "./content-index";
import { isErrorPage, matchUrlTemplate, relabelScenesByFamilies, urlTemplateFromUrl } from "./url-scene";

export type SiteKnowledgeDocument = {
  schemaVersion: "site-knowledge/v1";
  origin: "crawl";
  meta: {
    siteAgentId: string;
    /** The crawled site's origin URL. */
    origin: string;
    crawledAt: string;
    seeds: string[];
    stats: { urlsSeen: number; pagesRendered: number; scenes: number; links: number };
  };
  profile: SiteProfile;
  scenes: SceneDefinition[];
  links: LinkReference[];
  /**
   * URL classes judged "data pages" across instances: instance bodies are not indexed,
   * only this one description is kept. Ten thousand near-duplicate instance texts burden
   * retrieval; one line saying what the class is, is the useful knowledge.
   */
  dataPageTypes?: Array<{ urlPattern: string; name: string; description: string; instanceCount: number }>;
  /**
   * Per-URL observation records (per-line checksums by structural position, at most two).
   * Must be stored apart from indexed content: lines dropped as dynamic keep their
   * checksums here, otherwise they look new next time and are dropped again — dropped
   * once, dropped forever.
   */
  observations?: Record<string, PageObservation[]>;
  /**
   * URLs actually visited this crawl and confirmed as error pages. **Positive evidence,
   * not "unseen"** — so adoption may retire even verified old scenes on it without
   * fear of over-deleting: an incomplete crawl only leaves URLs off this list, it
   * never adds them.
   */
  deadUrls?: string[];
  /**
   * URLs actually attempted this crawl that could not be rendered (timeout, blocked,
   * unreachable).
   *
   * **Positive evidence** like deadUrls: only URLs really fetched get listed, and an
   * incomplete crawl only leaves URLs off the list. Recorded separately because targets
   * that exist only as links and never resolve had no exit before — they reappear as
   * links every time, so the "did not reappear" test in retireUnseenReferencedScenes
   * never catches them and the console keeps saying "pending verification". A production
   * site's /security and /visitor were exactly this: links on an anti-bot page that
   * never resolve however often they are crawled.
   */
  unreachableUrls?: string[];
};

// Sitemap discovery may feed thousands of URLs into the bounded crawl
// frontier.  The Release document only needs a representative provenance set;
// keeping this limit beside the validator guarantees that a document assembled
// by our own runner can always cross the same untrusted-input boundary.
export const MAX_CRAWL_DOCUMENT_SEEDS = 300;

type CrawlDocumentExpectation = {
  siteAgentId: string;
  origin: string;
  limits?: { maxRenders?: number };
};

function crawlDocumentError(reason: string): never {
  throw new Error(`crawl_document_invalid:${reason}`);
}

function normalizedHttpOrigin(value: unknown, reason: string) {
  if (typeof value !== "string" || value.length > 4_096) {
    crawlDocumentError(reason);
  }
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || url.username
      || url.password) {
      crawlDocumentError(reason);
    }
    return url.origin;
  } catch {
    return crawlDocumentError(reason);
  }
}

function assertDocumentUrlsSameOrigin(
  value: unknown,
  expectedOrigin: string,
  path = "document",
) {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      assertDocumentUrlsSameOrigin(child, expectedOrigin, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assertDocumentUrlsSameOrigin(child, expectedOrigin, `${path}.${key}`);
    }
    return;
  }
  if (typeof value !== "string" || !/^https?:\/\//i.test(value.trim())) return;
  if (normalizedHttpOrigin(value, `${path}_url`) !== expectedOrigin) {
    crawlDocumentError(`${path}_origin`);
  }
}

/**
 * The runner's crawl JSON is untrusted input. Validate both its bounded shape
 * and exact-origin provenance before it can mint a Release.
 */
export function assertValidSiteKnowledgeDocument(
  value: unknown,
  expected: CrawlDocumentExpectation,
): asserts value is SiteKnowledgeDocument {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    crawlDocumentError("not_serializable");
  }
  if (new TextEncoder().encode(encoded!).byteLength > 5 * 1024 * 1024) {
    throw new Error("crawl_document_too_large");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    crawlDocumentError("shape");
  }
  const document = value as Partial<SiteKnowledgeDocument>;
  if (document.schemaVersion !== "site-knowledge/v1"
    || document.origin !== "crawl"
    || !document.meta
    || typeof document.meta !== "object"
    || Array.isArray(document.meta)
    || !document.profile
    || typeof document.profile !== "object"
    || Array.isArray(document.profile)
    || !Array.isArray(document.scenes)
    || !Array.isArray(document.links)) {
    // Note: a legacy in-flight worker may still send a derived `tree` field; it is
    // neither required nor validated here — the topology is derived by consumers.
    crawlDocumentError("shape");
  }
  if (document.meta.siteAgentId !== expected.siteAgentId) {
    crawlDocumentError("site_agent");
  }
  const expectedOrigin = normalizedHttpOrigin(expected.origin, "expected_origin");
  if (normalizedHttpOrigin(document.meta.origin, "meta_origin") !== expectedOrigin) {
    crawlDocumentError("meta_origin");
  }
  if (!Array.isArray(document.meta.seeds)
    || document.meta.seeds.length > MAX_CRAWL_DOCUMENT_SEEDS
    || !document.meta.stats
    || typeof document.meta.stats !== "object"
    || Array.isArray(document.meta.stats)) {
    crawlDocumentError("meta");
  }
  const maxRenders = expected.limits?.maxRenders ?? 200;
  const sceneLimit = Math.min(5_000, Math.max(200, maxRenders * 200));
  const linkLimit = Math.min(20_000, Math.max(1_000, maxRenders * 500));
  if (document.scenes.length > sceneLimit || document.links.length > linkLimit) {
    crawlDocumentError("collection_limit");
  }
  const stats = document.meta.stats;
  for (const count of [
    stats.urlsSeen,
    stats.pagesRendered,
    stats.scenes,
    stats.links,
  ]) {
    if (!Number.isSafeInteger(count) || count < 0) crawlDocumentError("stats");
  }
  if (stats.pagesRendered > maxRenders
    || stats.urlsSeen > 300_000
    || stats.urlsSeen < stats.pagesRendered
    || stats.scenes !== document.scenes.length
    || stats.links !== document.links.length) {
    crawlDocumentError("stats");
  }
  if (typeof document.meta.crawledAt !== "string"
    || !Number.isFinite(Date.parse(document.meta.crawledAt))) {
    crawlDocumentError("crawled_at");
  }

  const sceneIds = new Set<string>();
  for (const [index, scene] of document.scenes.entries()) {
    // Report WHICH condition failed (`scene_<i>:<field>`) — a bare `scene_<i>` makes a crawl
    // rejection undiagnosable. Same checks as before, one per line.
    const bad = (field: string): never => crawlDocumentError(`scene_${index}:${field}`);
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) bad("shape");
    if (typeof scene.id !== "string" || !scene.id || scene.id.length > 500) bad("id");
    if (sceneIds.has(scene.id)) bad("duplicate_id");
    if (!Array.isArray(scene.urlTemplates)) bad("urlTemplates");
    if (!Array.isArray(scene.parameters)) bad("parameters");
    if (!Array.isArray(scene.sourceObservationIds)) bad("sourceObservationIds");
    if (!scene.verifier || typeof scene.verifier !== "object") bad("verifier");
    if (scene.origin !== "crawl") bad("origin");
    if (scene.origins && scene.origins.some((origin) => origin !== "crawl")) bad("origins");
    // Phase 1 entry-verification (runCrawl) promotes reached scenes to `verified`/
    // `entry-verified` IN the crawl document, and the base release carries these scenes
    // verbatim (siteKnowledgeToReleaseFields) — so the verified state MUST survive this gate;
    // it is exactly what lifts `verifiedScenes` off 0. Accept every legitimate evidence rung
    // and directEntry state (the type enums); still reject unknown/garbage values.
    const rungs = ["referenced", "crawled", "observed", "semantic-reviewed", "entry-verified"];
    if (!rungs.includes(scene.evidenceStatus || scene.lifecycle || "")) bad("evidenceStatus");
    if (!rungs.includes(scene.lifecycle || scene.evidenceStatus || "")) bad("lifecycle");
    if (!["candidate", "verified", "needs-reverify", "failed"].includes(scene.directEntry)) bad("directEntry");
    if (scene.lastVerifiedAt !== undefined && typeof scene.lastVerifiedAt !== "string") bad("lastVerifiedAt");
    sceneIds.add(scene.id);
  }
  const linkIds = new Set<string>();
  for (const [index, link] of document.links.entries()) {
    if (!link || typeof link !== "object" || Array.isArray(link)
      || typeof link.id !== "string" || !link.id || link.id.length > 500
      || linkIds.has(link.id)
      || !sceneIds.has(link.fromSceneId)
      || !sceneIds.has(link.toSceneId)
      || typeof link.href !== "string"
      || link.origin !== "crawl"
      || (link.origins && link.origins.some((origin) => origin !== "crawl"))) {
      crawlDocumentError(`link_${index}`);
    }
    linkIds.add(link.id);
  }
  assertDocumentUrlsSameOrigin(document, expectedOrigin);
}

/**
 * Normalizes the ASSEMBLY baseline: a scene coming out of assembly is, by definition, either
 * link-`referenced` or `crawled`. A purely link-`referenced` scene stays `referenced`;
 * EVERYTHING else becomes `crawled`. This must catch more than `observed` — a merge
 * (`strongerEvidenceStatus`) can leave a scene at a higher rung (`entry-verified`) or a
 * `semantic-reviewed`/empty status that is a stale merge artifact, not a real crawl proof, so
 * scrubbing it back here is correct, not lossy. NOTE: this runs at assembly time, BEFORE
 * Phase 1 entry-verification (runCrawl) legitimately re-promotes the scenes it actually
 * probes to `entry-verified` — which the crawl-document validator now accepts.
 */
function stampCrawl(scene: SceneDefinition): SceneDefinition {
  const evidenceStatus: "referenced" | "crawled" =
    scene.evidenceStatus === "observed" || scene.lifecycle === "observed"
      ? "crawled"
      : scene.evidenceStatus === "referenced" || scene.lifecycle === "referenced"
        ? "referenced"
        : "crawled";
  return {
    ...scene,
    evidenceStatus,
    lifecycle: evidenceStatus,
    origin: "crawl",
    origins: ["crawl"],
  };
}

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function defaultProfile(origin: string): SiteProfile {
  const host = safeHost(origin);
  return {
    name: host,
    description: `${host} 的爬取知识库(接入时生成,待 usage 精修)`,
    semanticSource: "program",
    origin: "crawl",
    entryUrl: origin,
    vocabulary: {},
    suggestedGoals: [],
  };
}

/**
 * Folds crawled page snapshots into a single knowledge document. Reuses
 * `discoverInitialKnowledge` for clustering. Pure — no network/browser.
 */
export function assembleSiteKnowledgeDocument(input: {
  siteAgentId: string;
  origin: string;
  crawledAt: string;
  seeds: string[];
  snapshots: PageSnapshot[];
  sampleCounts?: Map<string, number>;
  profile?: SiteProfile;
  urlsSeen?: number;
}): SiteKnowledgeDocument {
  const scenesById = new Map<string, SceneDefinition>();
  const linksById = new Map<string, LinkReference>();

  for (const snapshot of input.snapshots) {
    const result = discoverInitialKnowledge(snapshot, [...scenesById.values()], [...linksById.values()]);
    for (const scene of result.scenes) {
      const stamped = stampCrawl(scene);
      const previous = scenesById.get(stamped.id);
      scenesById.set(stamped.id, previous ? mergeSceneEvidence(previous, stamped) : stamped);
    }
    for (const link of result.linkReferences) {
      const stamped: LinkReference = { ...link, origin: "crawl", origins: ["crawl"] };
      const previous = linksById.get(stamped.id);
      linksById.set(stamped.id, previous
        ? { ...previous, observations: previous.observations + stamped.observations, lastSeenAt: stamped.lastSeenAt }
        : stamped);
    }
  }

  // Crawled is crawled: once a rendered URL matches a scene's template, that scene must
  // not stay `referenced`. Scenes arise two ways — from a rendered page, or from a link
  // on another page — and the same page often takes both paths, creating one of each.
  // The link-born one never gets verified, hence "crawled, yet entry unverified", while
  // the hint promised "confirmed after re-crawl" — a promise it could not keep.
  const renderedUrls = input.snapshots.map((snapshot) => snapshot.url);
  const scenes = [...scenesById.values()].map((scene) => {
    if (scene.evidenceStatus !== "referenced" && scene.lifecycle !== "referenced") return scene;
    const template = scene.urlTemplates[0];
    if (!template) return scene;
    const hit = renderedUrls.find((url) => matchUrlTemplate(template, url) !== null);
    if (!hit) return scene;
    const observedUrls = [...new Set([...(scene.evidence?.observedUrls || []), hit])].slice(0, 20);
    return {
      ...scene,
      evidenceStatus: "crawled" as const,
      lifecycle: "crawled" as const,
      evidence: { ...(scene.evidence || { titles: [], headings: [], linkLabels: [], observedUrls: [] }), observedUrls },
    };
  });
  // Fold an instance's literal scene into the parameterized scene it belongs to.
  //
  // `/celebrity/Jay` and `/celebrity/{path1}` describe the same page class, but URL
  // clustering is helpless with short Latin names (it cannot guess that segment is a
  // person), so one family ends up with a parameterized scene plus a scatter of literal
  // ones stuck at "referenced only". The test needs no guessing: **a literal path that
  // matches the parameterized template is an instance of that family**.
  //
  // Both preconditions are required, or real pages get folded away:
  //   ① the literal scene has no render evidence of its own — a rendered page has its own
  //      identity (`/daily/month` is an index page, not a day) and is kept. This also
  //      makes the decision self-correcting: once crawled, it is no longer folded.
  //   ② the parameterized scene has render evidence — fold only into families actually
  //      seen, never into something itself guessed from links.
  const parameterized = scenes.filter((scene) =>
    (scene.urlTemplates[0]?.pathnamePattern || "").includes("{") && (scene.evidence?.observedUrls?.length || 0) > 0);
  const foldedInto = new Map<string, string>();
  const folded = scenes.filter((scene) => {
    const template = scene.urlTemplates[0];
    const status = scene.evidenceStatus || scene.lifecycle;
    if (!template || template.pathnamePattern.includes("{")) return true;
    if (status !== "referenced" || (scene.evidence?.observedUrls?.length || 0) > 0) return true;
    const literalUrl = `${template.originPattern}${template.pathnamePattern}`;
    const family = parameterized.find((candidate) => matchUrlTemplate(candidate.urlTemplates[0], literalUrl) !== null);
    if (!family) return true;
    foldedInto.set(scene.id, family.id);
    family.evidence = {
      ...(family.evidence || { titles: [], headings: [], linkLabels: [], observedUrls: [] }),
      linkLabels: [...new Set([...(family.evidence?.linkLabels || []), ...(scene.evidence?.linkLabels || [])])].slice(0, 20),
    };
    return false;
  });
  const scenesFinal = folded;
  if (input.sampleCounts) {
    for (const scene of scenesFinal) {
      // Frontier keys sample counts by `urlTemplateFromUrl(url).id`. A scene's
      // own `urlTemplates[0].id` can diverge (a rendered page merged into a
      // link-clustered Scene keeps the clusterer's id), so recover the frontier
      // key from a representative observed URL, falling back to the template id.
      const observedUrl = scene.evidence?.observedUrls?.[0];
      const key = observedUrl ? urlTemplateFromUrl(observedUrl).id : scene.urlTemplates[0]?.id;
      const count = key ? input.sampleCounts.get(key) : undefined;
      if (count && count > 1) scene.sampleCount = count;
    }
  }
  const links = [...linksById.values()]
    .map((link) => (foldedInto.has(link.toSceneId) ? { ...link, toSceneId: foldedInto.get(link.toSceneId) as string } : link))
    .map((link) => (foldedInto.has(link.fromSceneId) ? { ...link, fromSceneId: foldedInto.get(link.fromSceneId) as string } : link))
    .filter((link, index, all) => all.findIndex((other) => other.fromSceneId === link.fromSceneId && other.toSceneId === link.toSceneId && other.href === link.href) === index);
  const profile = input.profile ?? defaultProfile(input.origin);

  return {
    schemaVersion: "site-knowledge/v1",
    origin: "crawl",
    meta: {
      siteAgentId: input.siteAgentId,
      origin: input.origin,
      crawledAt: input.crawledAt,
      // Preserve the full seed list in CrawlFrontier for coverage, but bound
      // the serialized provenance metadata that crosses the runner boundary.
      seeds: [...new Set(input.seeds)].slice(0, MAX_CRAWL_DOCUMENT_SEEDS),
      stats: {
        urlsSeen: input.urlsSeen ?? input.snapshots.length,
        pagesRendered: input.snapshots.length,
        scenes: scenesFinal.length,
        links: links.length,
      },
    },
    profile,
    scenes: scenesFinal,
    links,
  };
}

/**
 * The lossless mapping onto the Release knowledge fields. The remaining Release
 * fields (ids, version, agentConfig, eval) are filled at adoption time (Group 6);
 * this function proves scenes/links/profile map onto `SiteAgentReleaseV2`
 * with no shape change.
 */
/** Pages present in this release but not the previous one — the source of the console's "N new page kinds" status line. */
export function countNewScenes(previous: SceneDefinition[], next: SceneDefinition[]): number {
  const known = new Set(previous.map((scene) => scene.id));
  return next.filter((scene) => !known.has(scene.id)).length;
}

export function siteKnowledgeToReleaseFields(
  document: SiteKnowledgeDocument,
): Pick<SiteAgentReleaseV2, "profile" | "scenes" | "linkReferences"> {
  return {
    profile: { ...document.profile, origin: document.profile.origin ?? "crawl" },
    scenes: document.scenes,
    linkReferences: document.links,
  };
}

/**
 * Adopts a crawl document as a base-layer Release the Agent can consume. Mirrors
 * `emptyRelease` for all the fields a crawl does not produce (agentConfig, eval,
 * capabilities…), overlaying the crawled profile/scenes/links. Usage learning
 * later publishes higher versions on top — it does not overwrite this base.
 */
export function siteKnowledgeDocumentToRelease(
  document: SiteKnowledgeDocument,
  options: { version?: number; createdAt?: string } = {},
): SiteAgentReleaseV2 {
  const version = options.version ?? 1;
  const base = emptyRelease(document.meta.siteAgentId, options.createdAt ?? document.meta.crawledAt);
  const fields = siteKnowledgeToReleaseFields(document);
  const release: SiteAgentReleaseV2 = {
    ...base,
    id: `${document.meta.siteAgentId}:release:${version}`,
    version,
    profile: { ...base.profile, ...fields.profile },
    scenes: fields.scenes,
    linkReferences: fields.linkReferences,
    ...(document.dataPageTypes?.length ? { dataPageTypes: document.dataPageTypes } : {}),
  };
  // The fingerprint covers substantive knowledge only: observations change on every crawl, and including them would mint a version per re-crawl.
  return { ...release, contentHash: stableHash(JSON.stringify({ profile: release.profile, scenes: release.scenes, linkReferences: release.linkReferences })) };
}

function pathDepth(url: string): number {
  try { return new URL(url).pathname.split("/").filter(Boolean).length; } catch { return Number.MAX_SAFE_INTEGER; }
}

/**
 * The crawl-side one-shot AI profile generator (D6): reuses `analyzeSiteProfile`
 * on the shallowest (entry-most) rendered page, stamped `origin: "crawl"`. It is
 * a direct call, so it never enqueues into the usage review queue, and returns
 * undefined when no model is configured.
 */
/**
 * A lightweight anchor snapshot for post-crawl scene review. The crawl document
 * carries no page bodies, but `reviewSceneSemantics` reads each scene's own
 * `evidence` — this only supplies page/site context (entry URL/title + a digest
 * of headings), enough to let the crawled scenes be semantically reviewed.
 */
export function crawlReviewSnapshot(document: SiteKnowledgeDocument): PageSnapshot {
  const entry = [...document.scenes].sort((left, right) => (left.urlTemplates[0]?.pathnamePattern.length || 0) - (right.urlTemplates[0]?.pathnamePattern.length || 0))[0];
  const headings = document.scenes.flatMap((scene) => scene.evidence?.headings || []).slice(0, 40);
  const links = document.scenes.flatMap((scene) => (scene.evidence?.observedUrls || []).map((url) => ({ text: scene.name, url }))).slice(0, 80);
  return {
    id: `crawl-anchor-${document.meta.siteAgentId}`, sessionId: "crawl", documentId: "crawl", sequence: 1,
    url: entry?.evidence?.observedUrls[0] || document.meta.origin,
    title: entry?.evidence?.titles[0] || document.profile.name,
    heading: entry?.evidence?.headings[0] || document.profile.name,
    visibleText: [document.profile.description, ...headings].filter(Boolean).join("\n").slice(0, 6_000),
    links, elements: [],
    metadata: { applicationName: document.profile.name, description: document.profile.description },
    capturedAt: document.meta.crawledAt,
  };
}

export function crawlProfileGenerator(): (
  snapshots: PageSnapshot[],
  signal?: AbortSignal,
) => Promise<SiteProfile | undefined> {
  return async (snapshots, signal) => {
    signal?.throwIfAborted();
    if (!snapshots.length) return undefined;
    const representative = [...snapshots].sort((left, right) => pathDepth(left.url) - pathDepth(right.url))[0];
    const profile = await analyzeSiteProfile(representative, undefined, [], signal);
    signal?.throwIfAborted();
    return profile ? { ...profile, origin: "crawl" } : undefined;
  };
}

export type RenderPage = (url: string) => Promise<PageSnapshot | null>;

/**
 * Drives a frontier to completion, rendering `render` decisions and feeding
 * discovered links back in. The actual Playwright renderer (Group 4) and the
 * crawl-side AI profile generator (Group 4.3) are injected, keeping this
 * orchestrator offline-testable with fakes.
 */
export async function crawlSiteKnowledge(input: {
  siteAgentId: string;
  origin: string;
  crawledAt: string;
  seeds: string[];
  frontier: CrawlFrontier;
  renderPage: RenderPage;
  profile?: SiteProfile;
  generateProfile?: (
    snapshots: PageSnapshot[],
    signal?: AbortSignal,
  ) => Promise<SiteProfile | undefined>;
  signal?: AbortSignal;
  /** Optional: receive the crawled pages' text for content indexing
   * (build-knowledge-center-v1). Non-breaking; the runner POSTs these to the content
   * ingest endpoint so onboarding auto-populates the content index. */
  onContent?: (pages: ContentPage[]) => Promise<void>;
  /**
   * Observation records from the previous (and the one before) crawl, keyed by URL. This
   * is the cross-time layer's baseline. Absent means first crawl — the layer is inactive
   * and drops nothing.
   */
  priorObservations?: Record<string, PageObservation[]>;
}): Promise<SiteKnowledgeDocument> {
  const { frontier } = input;
  input.signal?.throwIfAborted();
  frontier.seed(input.seeds);
  // Warm the crawl budget with last crawl's URL → structural signature map: this round
  // cannot know what a page looks like in advance, but last time measured it — a
  // measurement, not a guess. A first crawl has none and falls back to URL-template budgets.
  frontier.primeStructures(
    Object.entries(input.priorObservations || {})
      .map(([url, history]) => [url, history[0]?.signature || ""] as [string, string])
      .filter(([, signature]) => signature),
  );
  const snapshots: PageSnapshot[] = [];
  /**
   * Redirect aliases: requested URL → URL actually landed on.
   *
   * `/history` 302s to `/` and will never have a page of its own, yet other pages link
   * to it, so the structure gets a ghost scene forever "unverified / unclassified / no
   * body", and coverage looks bad. Not one site's quirk — `/home`, `/index.html` and
   * marketing short links all behave this way. The landing page is already crawled;
   * point the links at it instead of giving the alias its own scene.
   */
  const redirects = new Map<string, string>();
  /**
   * URLs that rendered as error / soft-404 pages. The page itself is already discarded
   * (no scene, not indexed), but **other pages still link to it** and the link path
   * would create a scene anyway — production once had a scene literally named "page
   * not found", stuck at "unverified". Once visited and confirmed an error page, links
   * must not invite it back.
   */
  const deadUrls = new Set<string>();
  // URLs fetched but never returned. A silent continue would leave "attempted" unrecorded.
  const unreachableUrls = new Set<string>();

  for (let decision = frontier.next(); decision.action !== "stop"; decision = frontier.next()) {
    input.signal?.throwIfAborted();
    if (decision.action !== "render") continue; // "sample" only accrues sampleCount
    const rendered = await input.renderPage(decision.item.url);
    input.signal?.throwIfAborted();
    if (!rendered) { unreachableUrls.add(decision.item.url); continue; }
    let finalUrlAccepted = false;
    try {
      const finalUrl = new URL(rendered.url);
      finalUrlAccepted = !finalUrl.username && !finalUrl.password && frontier.accepts(rendered.url);
    } catch {
      finalUrlAccepted = false;
    }
    if (!finalUrlAccepted) continue;
    // An error / soft-404 page is not knowledge: drop it whole — no scene, no content,
    // and don't follow its nav (that is what seeded junk /topic routes named "page not found").
    if (isErrorPage(rendered)) {
      deadUrls.add(decision.item.url);
      deadUrls.add(rendered.url);
      continue;
    }
    if (rendered.url !== decision.item.url) redirects.set(decision.item.url, rendered.url);
    // The filter chain governs what becomes knowledge, not just what is rendered:
    // drop trap/asset/off-host links before discovery clusters them into scenes.
    const acceptedLinks = rendered.links.filter((link) => frontier.accepts(link.url));
    const snapshot = acceptedLinks.length === rendered.links.length ? rendered : { ...rendered, links: acceptedLinks };
    snapshots.push(snapshot);
    // Structure is known only after rendering; report it to the crawl budget so pages of the same structure count as one family regardless of URL spelling.
    const renderedBlocks = snapshot.contentFilter?.blocks;
    if (renderedBlocks?.length) frontier.observeStructure(snapshot.url, structureSignature(renderedBlocks));
    for (const link of acceptedLinks) {
      const landmark = (snapshot.elements ?? []).find((element) => element.href === link.url)?.landmark;
      frontier.add(link.url, { depth: decision.item.depth + 1, landmark });
    }
  }

  input.signal?.throwIfAborted();
  // Rewrite links pointing at aliases to their landing page, so aliases never cluster into scenes.
  const rewritten = redirects.size || deadUrls.size
    ? snapshots.map((snapshot) => ({
      ...snapshot,
      links: snapshot.links
        .map((link) => (redirects.has(link.url) ? { ...link, url: redirects.get(link.url) as string } : link))
        .filter((link) => !deadUrls.has(link.url)),
    }))
    : snapshots;
  // Redirects also make the same landing page get crawled twice (directly and via the
  // alias); keep the first copy, otherwise the content pipeline processes it twice.
  const seenUrls = new Set<string>();
  const resolvedSnapshots = rewritten.filter((snapshot) => !seenUrls.has(snapshot.url) && seenUrls.add(snapshot.url));
  input.signal?.throwIfAborted();
  const profile = input.profile
    ?? (input.generateProfile
      ? await input.generateProfile(resolvedSnapshots, input.signal)
      : undefined);
  input.signal?.throwIfAborted();
  const document = assembleSiteKnowledgeDocument({
    siteAgentId: input.siteAgentId,
    origin: input.origin,
    crawledAt: input.crawledAt,
    seeds: input.seeds,
    snapshots: resolvedSnapshots,
    sampleCounts: frontier.sampleCounts,
    profile,
    urlsSeen: frontier.stats.urlsSeen,
  });
  if (deadUrls.size) document.deadUrls = [...deadUrls].slice(0, 200);
  if (unreachableUrls.size) document.unreachableUrls = [...unreachableUrls].slice(0, 200);
  // AI URL clustering + generic naming — the general layer beyond the name/date/id
  // heuristic: it catches families the patterns can't (lowercase slugs) and gives each a
  // GENERIC name ("country/region trends", not "Indonesia trending events"). Every proposal is validated in
  // relabelScenesByFamilies (must match >=2 real scenes, literal first segment), so a bad
  // or absent model answer is simply ignored — the heuristic result stands.
  try {
    const families = await clusterUrlFamilies(document.scenes.map((scene) => ({ path: scene.urlTemplates[0]?.pathnamePattern || "", name: scene.name })));
    if (families.length) {
      document.scenes = relabelScenesByFamilies(document.scenes, input.origin, families);
    }
  } catch { /* best-effort — the heuristic result stands */ }
  // Content indexing (build-knowledge-center-v1): hand the crawled page text to the
  // caller so it can populate the separate content index. Additive and non-fatal.
  if (input.onContent) {
    // The three layers have different baselines and run at different stages: the shape
    // layer finishes per page during rendering (snapshot.contentFilter); cross-instance
    // and cross-time must wait until here — siblings and history are only available now.
    const crawledAt = input.crawledAt;
    const prior = input.priorObservations || {};
    const observations: Record<string, PageObservation[]> = {};
    const layerTemplateOn = (process.env.SITEWAKE_LAYER_TEMPLATE || "off").toLowerCase() === "on";
    const layerTimeOn = (process.env.SITEWAKE_LAYER_TIME || "off").toLowerCase() === "on";

    const blocksOf = (snapshot: PageSnapshot) => snapshot.contentFilter?.blocks || [];
    const urlPatternOf = (url: string) => urlTemplateFromUrl(url)?.pathnamePattern || url;

    // ── Layer 2: group by page structure, siblings as each other's baseline ──
    // Grouped by structure, not URL template: URLs need guessing which segment is the
    // instance value, and a failed guess means no group. URL templates only label stats.
    const groups = new Map<string, PageSnapshot[]>();
    const groupKeyOf = new Map<string, string>();
    for (const snapshot of resolvedSnapshots) {
      const blocks = blocksOf(snapshot);
      if (!blocks.length) continue;
      const key = structureSignature(blocks);
      groups.set(key, [...(groups.get(key) || []), snapshot]);
      groupKeyOf.set(snapshot.url, key);
    }
    const dataPatterns = new Set<string>();
    const shellPaths = new Map<string, string[]>();
    const dataPageTypes: NonNullable<SiteKnowledgeDocument["dataPageTypes"]> = [];
    for (const [pattern, members] of groups) {
      if (members.length < 2) continue;
      const verdict = analyzeTemplateGroup(members.map((snapshot) => ({ url: snapshot.url, blocks: blocksOf(snapshot) })));
      if (verdict.kind === "data") {
        dataPatterns.add(pattern);
        // The model writes one description only, no indexed body; the description goes into the structure store.
        const sample = members[0];
        const described = await describePageType({
          urlPattern: sample.url,
          sampleUrls: members.map((member) => member.url),
          constantText: verdict.constantPaths.map((path) => blocksOf(sample).find((block) => block.path === path)?.text || "").join("\n"),
          variantSamples: verdict.variantPaths.map((path) => blocksOf(sample).find((block) => block.path === path)?.text || ""),
        }).catch(() => null);
        // Structurally identical pages need not share a URL template (`/celebrity/Ella`
        // hides its instance segment); the most common one in the group is label enough —
        // it is for humans, the verdict does not depend on it.
        const patternCounts = new Map<string, number>();
        for (const member of members) {
          const key = urlPatternOf(member.url);
          patternCounts.set(key, (patternCounts.get(key) || 0) + 1);
        }
        dataPageTypes.push({
          urlPattern: [...patternCounts.entries()].sort((left, right) => right[1] - left[1])[0][0],
          name: described?.name || "模板实例页",
          description: described?.description || verdict.reason,
          instanceCount: members.length,
        });
      } else if (verdict.kind === "content") {
        shellPaths.set(pattern, verdict.constantPaths);
      }
    }
    if (dataPageTypes.length) document.dataPageTypes = dataPageTypes;

    const arbiter = createArbiterSession({ judge: judgeContentBlocks });
    const timeStatuses: PageTimeStatus[] = [];
    const pages = [] as Array<{ url: string; visibleText: string; heading?: string; filteredText?: string; filterReport?: Record<string, unknown>; description?: string }>;

    for (const snapshot of resolvedSnapshots) {
      const blocks = blocksOf(snapshot);
      let filteredText = snapshot.contentFilter?.mainText;
      let filterReport: Record<string, unknown> = { ...(snapshot.contentFilter?.stats || {}) };
      const pattern = groupKeyOf.get(snapshot.url) || "";

      let description: string | undefined;
      let survivingBlocks: RawBlock[] = [];

      if (blocks.length) {
        // Always write the observation record, indexed or not — otherwise dropped lines look new next time and get dropped again.
        const observation = observePage(blocks, crawledAt);
        const history = prior[snapshot.url] || [];
        observations[snapshot.url] = [observation, ...history].slice(0, 2);

        const isDataPage = dataPatterns.has(pattern);
        const verdict = timeLayerVerdict(observation, history[0], history[1]);
        timeStatuses.push({ url: snapshot.url, observationsCompared: verdict.observationsCompared, baselineIntervalMs: verdict.baselineIntervalMs });

        let working = blocks;
        const shell = shellPaths.get(pattern);
        if (layerTemplateOn && shell?.length) working = stripConstantBlocks(working, shell);
        const timeApplied = layerTimeOn ? applyTimeVerdict(working, verdict) : { blocks: working, droppedLines: 0 };
        working = timeApplied.blocks;

        try {
          const resolved = await arbiter.resolve(snapshot.url, working);
          survivingBlocks = resolved.keptBlocks;
          filteredText = layerTemplateOn && isDataPage ? "" : resolved.mainText;
          filterReport = {
            ...resolved.report,
            urlPattern: urlPatternOf(snapshot.url),
            structureGroup: pattern,
            templateVerdict: isDataPage ? "data" : shell ? "content" : "undetermined",
            templateLayerApplied: layerTemplateOn,
            timeLayerApplied: layerTimeOn,
            timeDroppedLines: timeApplied.droppedLines,
            observationsCompared: verdict.observationsCompared,
            baselineIntervalMs: verdict.baselineIntervalMs,
          };
        } catch { /* 仲裁失败：沿用渲染期的确定性结果 */ }

        // No prose block survived filtering → the page cannot explain itself; let the
        // model write one line. Not triggered when the page has its own description
        // (the original is more trustworthy), nor for excluded data-page classes.
        const proseBaseline = Number(snapshot.contentFilter?.stats?.proseBaseline) || 0;
        const hasProse = hasProseBlock(survivingBlocks, proseBaseline);
        if (filteredText && !hasProse && !(layerTemplateOn && isDataPage)) {
          description = (await describePage({
            url: snapshot.url,
            heading: snapshot.heading,
            keptText: filteredText,
          }).catch(() => null)) || undefined;
        }
        filterReport = { ...filterReport, hasProse, descriptionWritten: Boolean(description) };
      }
      pages.push({ url: snapshot.url, visibleText: snapshot.visibleText, heading: snapshot.heading, filteredText, filterReport, description });
    }

    if (Object.keys(observations).length) document.observations = observations;
    // Layer 4 needs several observations and re-crawls are manual — spell the state out,
    // otherwise "no dynamic content detected" reads as "there is none".
    const hint = recrawlHint(timeStatuses);
    for (const page of pages) page.filterReport = {
      ...page.filterReport,
      recrawlHint: hint.message,
      recrawlStage: hint.stage,
      recrawlPagesNeedingMore: hint.pagesNeedingMore,
      recrawlShortestIntervalMinutes: hint.shortestIntervalMinutes,
    };
    await input.onContent(pages);
  }
  return document;
}
