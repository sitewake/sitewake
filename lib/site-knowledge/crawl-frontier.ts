/**
 * The crawl frontier: URL filter chain, best-first ordering, and — the key
 * fusion with this project's model — Scene-template dedup as the crawl budget
 * controller. Each Scene URL template is rendered at most `maxPerTemplate`
 * times; the rest are counted as samples. When the frontier stops producing new
 * templates it saturates and stops (crawl4ai's adaptive/information-foraging
 * idea, expressed on the signal this project already has).
 *
 * Pure and offline-testable: it never touches the network or a browser. The
 * caller renders `render` decisions and feeds discovered links back via `add`.
 */
import { urlTemplateFromUrl } from "./url-scene";

export type FrontierItem = { url: string; depth: number; landmark?: string };

/** Return `false` to reject a URL. */
export type CrawlFilter = (url: URL) => boolean;

export type FrontierOptions = {
  origin: string;
  /** Hard cap on rendered pages for this job (protects the 1.9GB host). */
  maxRenders?: number;
  /** Representatives rendered per Scene template before the rest become samples. */
  maxPerTemplate?: number;
  /** Stop after this many consecutive picks produce no new template. */
  adaptiveStopAfter?: number;
  maxDepth?: number;
  filters?: CrawlFilter[];
  score?: (item: FrontierItem, url: URL) => number;
  /** robots.txt gate. */
  isAllowed?: (url: string) => boolean;
};

export type NextDecision =
  | { action: "render"; item: FrontierItem; templateId: string }
  | { action: "sample"; item: FrontierItem; templateId: string }
  | { action: "stop"; reason: "empty" | "max-renders" | "saturated" };

const TRAP_PATTERNS: RegExp[] = [
  /\/(logout|signout|sign-out|log-out)(\/|$|\?)/i,
  /\/(wp-login|wp-admin|xmlrpc)\b/i,
  /[?&](replytocom|share|print|add-to-cart)=/i,
  /\/(calendar|events?)\/\d{4}\/\d{1,2}(\/|$)/i, // date-walk calendars
  /([?&][^=&]+=[^&]*){4,}/,                        // 4+ query params → likely facet explosion
];

const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|map|pdf|zip|gz|rar|7z|mp4|webm|mp3|wav|woff2?|ttf|eot|rss|atom)(\?|#|$)/i;

export function defaultFilters(origin: string): CrawlFilter[] {
  let exactOrigin = "";
  try {
    const parsed = new URL(origin);
    if (/^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password) exactOrigin = parsed.origin;
  } catch {
    exactOrigin = "";
  }
  return [
    (url) => /^https?:$/.test(url.protocol),
    (url) => !url.username && !url.password,
    (url) => Boolean(exactOrigin) && url.origin === exactOrigin,
    (url) => !ASSET_RE.test(url.pathname),
    (url) => !TRAP_PATTERNS.some((pattern) => pattern.test(url.pathname + url.search)),
  ];
}

function defaultScore(item: FrontierItem, url: URL): number {
  const depthPenalty = item.depth * 10 + url.pathname.split("/").filter(Boolean).length * 2;
  const landmarkBonus = item.landmark === "nav" || item.landmark === "header" ? 20 : item.landmark === "footer" ? -15 : 0;
  const queryPenalty = [...url.searchParams.keys()].length * 3;
  return 100 - depthPenalty + landmarkBonus - queryPenalty;
}

export class CrawlFrontier {
  private readonly queue: Array<{ item: FrontierItem; score: number }> = [];
  private readonly enqueued = new Set<string>();
  private readonly templateCounts = new Map<string, number>();
  /**
   * Templates already rendered. Dequeue uses it for template breadth-first: unrendered
   * templates always go before rendered ones, so a wrong URL guess only queues a page
   * class a few more times, never starves it.
   */
  private readonly renderedTemplates = new Set<string>();
  /**
   * URL template → page structure signature, plus pages rendered per structure family.
   *
   * Budget is counted by **structure**, not URL: `/celebrity/Ella` and `/celebrity/周杰伦`
   * do not group by URL (a short Latin name is not recognized as an instance value), but
   * one structure comparison shows they are the same family. Structure is only known
   * after rendering, so URL templates order only the not-yet-rendered; once seen,
   * structure wins.
   */
  private readonly structureOfUrl = new Map<string, string>();
  private readonly structureRenders = new Map<string, number>();
  /**
   * Family patterns induced from **measurement**: `/celebrity/*` → structure signature.
   *
   * Within one crawl an unrendered URL has no structure, so the URL → structure map
   * alone cannot stop this round's near-duplicate waste. But after two pages render
   * there is nothing to guess: **if two URLs differ in exactly one path segment and
   * their measured structures are identical, that segment is the instance value**. Not
   * an a-priori guess at which segment is a parameter (`/celebrity/Ella` defeats that)
   * but an induction from two measured pages — the same reasoning as the cross-instance
   * layer's "constant is template, variable is data", applied to URLs.
   */
  private readonly derivedFamilies = new Map<string, string>();
  /** templateId → number of concrete URLs folded into it (rendered + sampled). */
  readonly sampleCounts = new Map<string, number>();
  private rendered = 0;
  private urlsSeen = 0;
  private consecutiveNoNew = 0;
  private readonly filters: CrawlFilter[];
  private readonly score: (item: FrontierItem, url: URL) => number;
  private readonly exactOrigin: string;

  constructor(private readonly options: FrontierOptions) {
    try {
      const parsed = new URL(options.origin);
      this.exactOrigin = /^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password ? parsed.origin : "";
    } catch {
      this.exactOrigin = "";
    }
    this.filters = options.filters ?? defaultFilters(options.origin);
    this.score = options.score ?? defaultScore;
  }

  private normalize(raw: string): string | null {
    try {
      const url = new URL(raw, this.options.origin);
      if (!this.exactOrigin || !/^https?:$/.test(url.protocol) || url.username || url.password || url.origin !== this.exactOrigin) return null;
      url.hash = "";
      return url.toString();
    } catch {
      return null;
    }
  }

  /** Whether a URL passes the filter chain + robots gate (no enqueue side effect). */
  accepts(raw: string): boolean {
    const normalized = this.normalize(raw);
    if (!normalized) return false;
    let url: URL;
    try { url = new URL(normalized); } catch { return false; }
    if (!this.filters.every((filter) => filter(url))) return false;
    if (this.options.isAllowed && !this.options.isAllowed(normalized)) return false;
    return true;
  }

  /** Enqueue a URL. Returns true if it was newly accepted. */
  add(raw: string, opts: { depth?: number; landmark?: string } = {}): boolean {
    const normalized = this.normalize(raw);
    if (!normalized || this.enqueued.has(normalized)) return false;
    if (!this.accepts(normalized)) return false;
    const url = new URL(normalized);
    const depth = opts.depth ?? 0;
    if (this.options.maxDepth !== undefined && depth > this.options.maxDepth) return false;
    this.enqueued.add(normalized);
    this.urlsSeen += 1;
    const item: FrontierItem = { url: normalized, depth, landmark: opts.landmark };
    this.queue.push({ item, score: this.score(item, url) });
    return true;
  }

  /**
   * Reports a rendered page's structure signature so the budget can merge by structure.
   * Works without it (falls back to URL-template budgets); calling it is what handles
   * families the URL cannot reveal.
   */
  observeStructure(url: string, signature: string): void {
    const normalized = this.normalize(url);
    if (!normalized || !signature) return;
    for (const [seen, seenSignature] of this.structureOfUrl) {
      if (seenSignature !== signature || seen === normalized) continue;
      const pattern = this.instanceSegmentPattern(seen, normalized);
      if (pattern) this.derivedFamilies.set(pattern, signature);
    }
    this.structureOfUrl.set(normalized, signature);
    this.structureRenders.set(signature, (this.structureRenders.get(signature) ?? 0) + 1);
  }

  /** When two URLs differ in exactly one path segment, returns the pattern with that segment blanked; otherwise undefined. */
  private instanceSegmentPattern(left: string, right: string): string | undefined {
    let a: URL, b: URL;
    try { a = new URL(left); b = new URL(right); } catch { return undefined; }
    if (a.origin !== b.origin || a.search !== b.search) return undefined;
    const one = a.pathname.split("/");
    const other = b.pathname.split("/");
    if (one.length !== other.length) return undefined;
    const differing = one.map((segment, index) => (segment === other[index] ? -1 : index)).filter((index) => index >= 0);
    if (differing.length !== 1) return undefined;
    // Siblings need a common parent path. `/about` and `/methodology` differ only in the
    // first segment, and if they happen to share structure (static pages sharing a layout
    // is normal) the induction yields `/{*}` — making **every top-level page** one family,
    // after which `/history` and `/topic` were never opened again. That really happened
    // in production: the very "merged what should not be merged" this section guards
    // against, only self-inflicted.
    // Requiring the differing segment not to be the first means flat URLs (`/ella`,
    // `/andy`) cannot form a family and a few extra pages render — erring on the side
    // of coverage, consistent with the whole design.
    if (differing[0] < 2) return undefined;
    if (!one[differing[0]] || !other[differing[0]]) return undefined;
    const shape = [...one];
    shape[differing[0]] = "*";
    return `${a.origin}${shape.join("/")}`;
  }

  /** Whether the URL matches a measured family pattern. */
  private derivedSignature(url: string): string | undefined {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return undefined; }
    const segments = parsed.pathname.split("/");
    for (let index = 0; index < segments.length; index += 1) {
      const shape = [...segments];
      shape[index] = "*";
      const found = this.derivedFamilies.get(`${parsed.origin}${shape.join("/")}`);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Warms up with last crawl's URL → structure signature map.
   *
   * Within one crawl a page's shape is unknown before rendering, so near-duplicates
   * whose URLs do not group (`/celebrity/Ella`) must render this round. But last time
   * measured them — **measurement, not a guess** — so use it: on re-crawl a family
   * renders only as many pages as the baseline needs, and no budget goes to
   * near-duplicates.
   */
  primeStructures(entries: Iterable<[string, string]>): void {
    for (const [url, signature] of entries) {
      const normalized = this.normalize(url);
      if (normalized && signature) this.structureOfUrl.set(normalized, signature);
    }
  }

  /** Whether this URL's family has rendered enough (degrades to URL template when structure is unknown). */
  private familyRenders(url: string, templateId: string): number | undefined {
    const signature = this.structureOfUrl.get(url) ?? this.derivedSignature(url);
    if (signature) return this.structureRenders.get(signature) ?? 0;
    return this.renderedTemplates.has(templateId) ? this.templateCounts.get(templateId) ?? 1 : undefined;
  }

  /** The unit of coverage is the **structure family**, not the URL template: a rendered sibling means covered. */
  private covered(url: string, templateId: string): boolean {
    const signature = this.structureOfUrl.get(url) ?? this.derivedSignature(url);
    if (signature) return (this.structureRenders.get(signature) ?? 0) > 0;
    return this.renderedTemplates.has(templateId);
  }

  /** Enqueue many seed URLs at depth 0. Returns how many were accepted. */
  seed(urls: string[]): number {
    return urls.reduce((count, url) => count + (this.add(url, { depth: 0 }) ? 1 : 0), 0);
  }

  next(): NextDecision {
    const maxRenders = this.options.maxRenders ?? 200;
    // Default 2: the cross-instance layer needs a sibling as baseline; one instance cannot decide data page vs content page.
    const maxPerFamily = this.options.maxPerTemplate ?? 2;
    const adaptiveStopAfter = this.options.adaptiveStopAfter ?? 25;
    if (this.rendered >= maxRenders) return { action: "stop", reason: "max-renders" };

    while (this.queue.length) {
      // Template breadth-first: tier by "is this family covered", then compare existing
      // scores within a tier. Uncovered always wins — this is where "a wrong URL guess
      // costs efficiency, never coverage" is enforced.
      let bestIndex = -1;
      let bestFresh = false;
      let bestScore = -Infinity;
      for (let index = 0; index < this.queue.length; index += 1) {
        const entry = this.queue[index];
        const fresh = !this.covered(entry.item.url, urlTemplateFromUrl(entry.item.url).id);
        if (bestIndex < 0 || (fresh && !bestFresh) || (fresh === bestFresh && entry.score > bestScore)) {
          bestIndex = index;
          bestFresh = fresh;
          bestScore = entry.score;
        }
      }
      const { item } = this.queue.splice(bestIndex, 1)[0];
      const templateId = urlTemplateFromUrl(item.url).id;
      const priorCount = this.templateCounts.get(templateId) ?? 0;
      this.templateCounts.set(templateId, priorCount + 1);
      this.sampleCounts.set(templateId, (this.sampleCounts.get(templateId) ?? 0) + 1);

      const renders = this.familyRenders(item.url, templateId);
      // This family has never rendered → must render. Coverage precedes every budget check.
      if (renders === undefined || renders === 0) {
        this.consecutiveNoNew = 0;
        this.rendered += 1;
        this.renderedTemplates.add(templateId);
        return { action: "render", item, templateId };
      }

      this.consecutiveNoNew += 1;
      // Saturation stop yields to coverage: while uncovered families remain in the queue,
      // "nothing new for a while" must not end the crawl — otherwise one huge date family
      // would squeeze out every new page behind it.
      if (this.consecutiveNoNew >= adaptiveStopAfter && !this.hasUncoveredFamily()) {
        return { action: "stop", reason: "saturated" };
      }
      if (renders >= maxPerFamily) return { action: "sample", item, templateId };
      this.rendered += 1;
      this.renderedTemplates.add(templateId);
      return { action: "render", item, templateId };
    }
    return { action: "stop", reason: "empty" };
  }

  private hasUncoveredFamily(): boolean {
    return this.queue.some((entry) => !this.covered(entry.item.url, urlTemplateFromUrl(entry.item.url).id));
  }

  get stats(): { rendered: number; urlsSeen: number; templates: number } {
    return { rendered: this.rendered, urlsSeen: this.urlsSeen, templates: this.templateCounts.size };
  }
}
