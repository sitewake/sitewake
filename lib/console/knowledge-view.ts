import type { CrawlJob } from "../site-knowledge/protocol";
import type { ContentCoverage } from "../site-knowledge/content-index";
import type { SiteBusinessTopology, TopologyNode } from "../site-knowledge/business-topology";

/**
 * All derived logic of the site knowledge page, as pure functions: API data in,
 * copy-free states and numbers out.
 *
 * Copy is rendered from the dictionary in the current locale; components only lay out.
 * The state machine is thus unit-testable in node without a browser; every scenario in
 * the spec (console/site-knowledge-view) has a case under tests/unit/console.
 */

/** Three page states: indexed / link only / unreachable. */
export type ReadState = "read" | "seen" | "blocked";
/** The reason behind the state, expanded only in the drawer. */
export type ReadReason = "read" | "referenced" | "no-content" | "failed" | "needs-reverify";

type ReadStateInput = Pick<TopologyNode, "id" | "directEntry" | "evidenceStatus">;
type CoverageInput = Pick<ContentCoverage, "emptyPages">;

/**
 * Fixed precedence: unreachable > indexed > link only.
 * "Indexed" is inferred from content coverage (not in the empty-body list); without
 * coverage data it falls back to evidence status, and the only error is calling "read
 * but no body" indexed, which one re-read clears.
 */
export function readState(node: ReadStateInput, coverage?: CoverageInput): { state: ReadState; reason: ReadReason } {
  if (node.directEntry === "failed") return { state: "blocked", reason: "failed" };
  if (node.directEntry === "needs-reverify") return { state: "blocked", reason: "needs-reverify" };
  if (node.evidenceStatus === "referenced") return { state: "seen", reason: "referenced" };
  if (coverage && coverage.emptyPages.some((page) => page.sceneId === node.id)) return { state: "seen", reason: "no-content" };
  return { state: "read", reason: "read" };
}

export type AreaSummary = { id: string; name: string; read: number; total: number; warn: boolean; isNew: boolean; nodeIds: string[] };

/** The numbers on a section node: indexed x / y, any unreachable, any new pages. */
export function areaSummaries(
  topology: Pick<SiteBusinessTopology, "areas" | "nodes">,
  coverage: CoverageInput | undefined,
  newIds: ReadonlySet<string> = new Set(),
): AreaSummary[] {
  const byId = new Map(topology.nodes.map((node) => [node.id, node]));
  return topology.areas.map((area) => {
    const nodes = area.nodeIds.map((id) => byId.get(id)).filter((node): node is TopologyNode => Boolean(node));
    const states = nodes.map((node) => readState(node, coverage).state);
    return {
      id: area.id,
      name: area.name,
      read: states.filter((state) => state === "read").length,
      total: nodes.length,
      warn: states.some((state) => state === "blocked"),
      isNew: nodes.some((node) => newIds.has(node.id)),
      nodeIds: area.nodeIds,
    };
  });
}

const byNewest = (left: CrawlJob, right: CrawlJob) => right.createdAt.localeCompare(left.createdAt);
const isActive = (job: CrawlJob) => job.status === "queued" || job.status === "leased" || job.status === "running";

/**
 * "New" = first seen after the start of the latest successful read.
 * After a single read every page would match, so nothing is marked then — the status
 * line already says "N new page kinds" at that moment.
 */
export function newPageIds(nodes: Array<Pick<TopologyNode, "id" | "createdAt">>, jobs: CrawlJob[]): Set<string> {
  const latest = jobs.filter((job) => job.status === "succeeded").sort(byNewest)[0];
  if (!latest) return new Set();
  const since = latest.createdAt;
  const fresh = nodes.filter((node) => node.createdAt && node.createdAt > since).map((node) => node.id);
  if (nodes.length && fresh.length === nodes.length) return new Set();
  return new Set(fresh);
}

export type KnowledgeStatus =
  | { kind: "never" }
  | { kind: "reading"; startedAt: string; elapsedSeconds: number }
  | { kind: "empty"; finishedAt: string }
  | { kind: "failed"; finishedAt: string; reason?: string }
  | { kind: "first-read"; finishedAt: string; pages: number; newScenes?: number }
  | { kind: "needs-one-more"; finishedAt: string; pages: number; pagesNeedingMore: number; newScenes?: number }
  | { kind: "interval-too-short"; finishedAt: string; pages: number; intervalMinutes: number; newScenes?: number }
  | { kind: "steady"; finishedAt?: string; pages: number; newScenes?: number };

/**
 * The top status line. Eight mutually exclusive states, precedence: reading > failed >
 * read but empty > never read > re-read hint > normal. Old jobs without a structured
 * summary fall to "normal" with no re-read hint or new count.
 */
export function knowledgeStatus(input: { pages: number; jobs: CrawlJob[]; now: number }): KnowledgeStatus {
  // now = 0 means no clock yet (first render, effect not run): no duration, no interval check.
  const now = input.now > 0 ? input.now : undefined;
  const jobs = [...input.jobs].sort(byNewest);
  const active = jobs.find(isActive);
  if (active) {
    return { kind: "reading", startedAt: active.createdAt, elapsedSeconds: now ? Math.max(0, Math.floor((now - Date.parse(active.createdAt)) / 1000)) : 0 };
  }
  const latest = jobs[0];
  if (latest?.status === "failed") return { kind: "failed", finishedAt: latest.updatedAt, reason: latest.error };
  if (latest?.status === "succeeded" && (latest.result?.scenes ?? 0) === 0 && (latest.result?.pagesRendered ?? 0) === 0) {
    return { kind: "empty", finishedAt: latest.updatedAt };
  }
  if (input.pages === 0) return { kind: "never" };
  const last = jobs.find((job) => job.status === "succeeded");
  const newScenes = last?.result?.newScenes && last.result.newScenes > 0 ? last.result.newScenes : undefined;
  const summary = last?.result?.contentFilter;
  const base = { finishedAt: last?.updatedAt, pages: input.pages, newScenes };
  if (last && summary?.recrawlStage === "first-crawl") return { kind: "first-read", ...base, finishedAt: last.updatedAt };
  if (last && summary?.recrawlStage === "needs-one-more") {
    return { kind: "needs-one-more", ...base, finishedAt: last.updatedAt, pagesNeedingMore: summary.recrawlPagesNeedingMore ?? 0 };
  }
  if (now && last && summary?.recrawlStage === "ready" && typeof summary.recrawlShortestIntervalMinutes === "number") {
    const sinceMinutes = (now - Date.parse(last.updatedAt)) / 60_000;
    if (sinceMinutes < summary.recrawlShortestIntervalMinutes) {
      return { kind: "interval-too-short", ...base, finishedAt: last.updatedAt, intervalMinutes: summary.recrawlShortestIntervalMinutes };
    }
  }
  return { kind: "steady", ...base };
}

export type UpdateRecord = { at: string; pages: number; purged: number };

/** Update log: one entry per successful read, newest first. Only time, page-kind count and removed time-sensitive spots. */
export function updateHistory(jobs: CrawlJob[]): UpdateRecord[] {
  return jobs
    .filter((job) => job.status === "succeeded" && job.result)
    .sort(byNewest)
    .map((job) => ({ at: job.updatedAt, pages: job.result!.scenes, purged: job.result!.contentFilter?.removed?.changingLines ?? 0 }));
}

export type ProbeRouteLike = {
  sceneId: string;
  name: string;
  urlTemplate?: string;
  directEntry?: "verified" | "needs-reverify" | "failed";
  evidenceStatus?: "referenced" | "crawled" | "observed" | "entry-verified";
};
export type ProbeResultLike = {
  pages: Array<{ url: string; headingPath?: string; context?: Array<{ headingPath?: string; text: string }> }>;
  routes: ProbeRouteLike[];
  coverageOfQuery?: { appears: boolean; sampleUrls: string[] };
};
/** One quote from the site and the pages it appears on. */
export type ProbeQuote = { text: string; pages: string[] };
export type ProbeVerdict = {
  /** Matched quotes from the site, deduplicated by text, at most three. The quote is the verdict: seeing it means the question can be answered. */
  quotes: ProbeQuote[];
  /** Pages related to the question, deduplicated by name; carries sceneId (clickable) when it maps to a known page. */
  pages: Array<{ sceneId?: string; name: string }>;
  /** The question's words appear in the body but were not retrieved. */
  termsAppearElsewhere: boolean;
};

const pathOf = (url: string) => { try { return decodeURIComponent(new URL(url).pathname); } catch { return url; } };

/**
 * Search results → something users understand: the site's own words, and related pages.
 *
 * No verdict words like "covered / not covered" — the quote is the verdict. Internal
 * metrics (search terms, hit counts, distinctiveness, site breadth) never reach the output.
 *
 * **Never say "will take the user to page X"**: matched scenes come from scene-name and
 * keyword matching, unrelated to which page the body matched on; an informational
 * question usually takes its answer from a page without navigating there. Presenting an
 * arbitrary verified scene as a navigation target was this screen's most misleading part.
 *
 * One page may match via several URLs (`/products.html` with and without query), so
 * pages are normalized by `resolve` and deduplicated by name; a quote found on several
 * pages is kept once with the page names merged.
 */
export function probeVerdict(
  result: ProbeResultLike,
  resolve: (url: string) => { id: string; name: string } | undefined = () => undefined,
): ProbeVerdict {
  const pages: Array<{ sceneId?: string; name: string }> = [];
  const push = (name: string, sceneId?: string) => {
    if (!name) return;
    const existing = pages.find((page) => page.name === name);
    if (existing) { if (!existing.sceneId && sceneId) existing.sceneId = sceneId; return; }
    pages.push({ name, sceneId });
  };
  const quotes = new Map<string, ProbeQuote>();
  for (const page of result.pages) {
    const node = resolve(page.url);
    const name = node?.name || page.headingPath || pathOf(page.url);
    push(name, node?.id);
    for (const window of page.context || []) {
      const text = (window.text || "").trim();
      if (!text) continue;
      const quote = quotes.get(text) || { text, pages: [] };
      if (!quote.pages.includes(name)) quote.pages.push(name);
      quotes.set(text, quote);
    }
  }
  // Scene matches are "related pages" too, merged into the same list as body matches; no separate navigation block.
  for (const route of result.routes) push(route.name, route.sceneId);
  return {
    quotes: [...quotes.values()].slice(0, 3),
    pages,
    termsAppearElsewhere: !quotes.size && Boolean(result.coverageOfQuery?.appears),
  };
}

/** Turns a URL pattern (/products/{id}) into a regex matching real paths. */
export function pathMatcher(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{[^}]+\}/g, "[^/]+");
  return new RegExp(`^${escaped}/?$`);
}

/** Finds the page in the topology for a real URL (to name the "source page"). */
export function nodeForUrl(nodes: Array<Pick<TopologyNode, "id" | "name" | "path">>, url: string) {
  const path = pathOf(url);
  return nodes.find((node) => node.path === path) || nodes.find((node) => node.path.includes("{") && pathMatcher(node.path).test(path));
}
