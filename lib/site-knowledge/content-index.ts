/**
 * Content-search — pure, portable core.
 *
 * The knowledge JSON stays structure-only; a page's visible text is chunked and
 * stored in a separate table (`site_agent_v2_content`). The agent-facing entry is
 * `grepSiteContent` (simplify-knowledge-search): deterministic LITERAL matching over
 * a keyword LIST, aggregated to pages, with sentence-bounded context windows — a
 * grep-style search whose synonym handling lives on the caller side (the agent model
 * expands the user's phrasing into the keyword list). Everything is in-JS so it stays
 * portable across D1 / Postgres. Native FTS (FTS5 / tsvector) and vector retrieval are
 * deferred (evidence-gated); this module is where they would slot in later.
 *
 * There is NO fuzzy/bigram fallback anywhere: a literal miss returns empty and recall is
 * the caller's job (keyword expansion + retry). The old bigram-coverage scorer is gone —
 * grep is the only content search in the codebase.
 *
 * Design notes:
 * - Chunk by paragraph groups up to a char cap with small overlap. Richer
 *   heading/section chunking needs the crawler to capture section structure
 *   (crawl-render currently yields flat innerText + one h1); until then `headingPath`
 *   carries the page heading as a coarse anchor.
 */

/**
 * `source` is the content store's credential: `verbatim` means the text can be found
 * on the page as is, `model` means a model-written page description. The store's rule
 * is therefore "**every unmarked sentence is findable verbatim**", not the blanket
 * "every sentence is" — without the mark that contract would silently break.
 */
export type ContentSource = "verbatim" | "model";

export type ContentChunk = { chunkIndex: number; headingPath?: string; text: string; source?: ContentSource };

export type ContentChunkRow = {
  url: string;
  sceneId?: string;
  chunkIndex: number;
  headingPath?: string;
  text: string;
  source?: ContentSource;
};

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_OVERLAP_PARAGRAPHS = 1;
const DEFAULT_TOP_PAGES = 5;

/** Split a page's visible text into size-capped, paragraph-aligned chunks with a
 * small paragraph overlap. An oversized single paragraph is hard-split. */
export function chunkPageContent(
  input: { visibleText: string; heading?: string },
  options?: { maxChars?: number; overlapParagraphs?: number },
): ContentChunk[] {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
  const overlap = options?.overlapParagraphs ?? DEFAULT_OVERLAP_PARAGRAPHS;
  const headingPath = input.heading?.trim() || undefined;
  const paragraphs = input.visibleText
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  const chunks: ContentChunk[] = [];
  const push = (text: string) => chunks.push({ chunkIndex: chunks.length, headingPath, text });

  let buffer: string[] = [];
  let size = 0;
  const flush = () => {
    if (buffer.length) push(buffer.join("\n"));
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flush();
      buffer = [];
      size = 0;
      for (let index = 0; index < paragraph.length; index += maxChars) push(paragraph.slice(index, index + maxChars));
      continue;
    }
    if (size + paragraph.length > maxChars && buffer.length) {
      flush();
      buffer = overlap > 0 ? buffer.slice(-overlap) : [];
      size = buffer.reduce((total, item) => total + item.length, 0);
    }
    buffer.push(paragraph);
    size += paragraph.length;
  }
  flush();
  return chunks;
}

/** Stable non-cryptographic content hash (FNV-1a) for change-gating a page's index
 * — same text → same hash, so an unchanged page is skipped on re-crawl. */
export function contentHashOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export type ContentPage = {
  url: string;
  sceneId?: string;
  /** Full page text. After switching to block-level filtering, only for comparison and rollback. */
  visibleText: string;
  heading?: string;
  /** Block-filtered body. Preferred for indexing (rollback with SITEWAKE_CONTENT_FILTER=off). */
  filteredText?: string;
  /** Per-page filter stats, returned with the ingest response for the console and site-wide health metrics. */
  filterReport?: Record<string, unknown>;
  /**
   * A model-written line on what the page is for, generated only when **no prose block
   * survives** filtering. Not generated when the page has its own description — the
   * original is more trustworthy. Indexed as its own block marked `model`.
   */
  description?: string;
};

/** Crawl → store glue: turn one rendered page into the chunked, hashed shape the
 * content store persists (`writeSiteContentPage`). Pure; the crawl pipeline / runner
 * calls it per page, the store gates re-index on `contentHash`. */
export function buildContentPage(
  page: ContentPage,
  options?: { maxChars?: number; overlapParagraphs?: number },
): { url: string; sceneId?: string; contentHash: string; chunks: ContentChunk[] } {
  const chunks = chunkPageContent({ visibleText: page.visibleText, heading: page.heading }, options);
  // The model-written description is its own block after the verbatim body. It goes
  // into the content store because search only reads that store — a description kept
  // only in the structure store is invisible to the agent, as good as unwritten; and
  // it must carry the source mark, or second-hand text becomes indistinguishable
  // from the original.
  if (page.description?.trim()) {
    chunks.push({ chunkIndex: chunks.length, headingPath: page.heading?.trim() || undefined, text: page.description.trim(), source: "model" });
  }
  return {
    url: page.url,
    sceneId: page.sceneId,
    // The fingerprint covers the description: a changed description rewrites the page too.
    contentHash: contentHashOf(page.description ? `${page.visibleText}\n\u0000${page.description}` : page.visibleText),
    chunks,
  };
}

/**
 * Layer 3 · cross-page: the baseline is the other pages of the same site.
 *
 * Lines repeated verbatim on enough pages are site chrome (nav, breadcrumbs, footer,
 * copyright) and belong to no page's content. Line-by-line comparison, no model, no
 * word list.
 *
 * It fills the hole the other layers cannot reach: the shape layer keeps every block
 * with exactly one vote, and a page that is structurally unique with static content
 * has no siblings (layer 2) and never changes (layer 4), so those blocks stay forever.
 * On the production index page `/daily`, 13 of 22 blocks were nav and footer let in
 * this way.
 *
 * **The threshold's denominator counts only pages that actually contributed text.**
 * Once layer 2 empties a whole data-page class, those pages contribute no lines; with
 * the denominator still counting every page, site-wide lines fall short of the
 * threshold — enabling layer 2 disabled this layer. Not hypothetical: production broke
 * exactly this way.
 *
 * Returns the cleaned text per page, index-aligned with the input.
 */
export function stripSharedChrome(
  pages: Array<{ visibleText: string }>,
  options?: { minPages?: number; fraction?: number },
): string[] {
  const minPages = options?.minPages ?? 3;
  const fraction = options?.fraction ?? 0.5;
  const lineCounts = new Map<string, number>();
  const perPageLines = pages.map((page) => {
    const lines = page.visibleText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    for (const line of new Set(lines)) lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1);
    return lines;
  });
  const contributing = perPageLines.filter((lines) => lines.length > 0).length;
  if (contributing < minPages) return pages.map((page) => page.visibleText);
  const threshold = Math.max(minPages, Math.ceil(contributing * fraction));
  return perPageLines.map((lines) => lines.filter((line) => (lineCounts.get(line) ?? 0) < threshold).join("\n"));
}

// --- grep-style content search (simplify-knowledge-search) -------------------
// The agent-facing search: literal, keyword-list-driven, page-aggregated. Synonym
// expansion happens on the CALLER side (the agent model turns the user's phrasing
// into a keyword list); this module does deterministic literal matching over that
// list, so synonyms ("kids"/"minors") are a caller concern and retrieval stays explainable.

/** One literal occurrence of a keyword inside a chunk. `index` is the char offset
 * of the match start within `chunk.text` (used to center the context window). */
export type KeywordHit = { url: string; sceneId?: string; chunkIndex: number; keyword: string; index: number };

/** One matched "line": the sentence containing a keyword hit, with a `§segment`
 * locator (the chunk index it lives in) so a hit is traceable like ripgrep's file:line. */
export type ContentContextWindow = { headingPath?: string; text: string; segment?: number };

/** A page ranked by literal keyword hits, carrying the matched lines the agent answers
 * from. `matchedKeywords` lets the model self-check its expansion; `keywordFrequencies`
 * exposes each matched keyword's site-wide page count (the distinctiveness signal — a term
 * on 1 page is a strong hit, a term on 20 pages is noise); `distinctiveness` is the
 * rarity-weighted rank score, while `score` stays the readable [0,1] coverage ratio. */
export type GrepPageMatch = {
  url: string;
  sceneId?: string;
  headingPath?: string;
  matchedKeywords: string[];
  keywordFrequencies?: Record<string, number>;
  hitCount: number;
  score: number;
  distinctiveness?: number;
  context: ContentContextWindow[];
};

export type GrepResult = { pages: GrepPageMatch[]; totalPagesWithHits: number };

/** Site-wide content-index coverage for the console (knowledge-center-manageability):
 * how much of the site's structure actually has indexed body text. `emptyPages` = scenes
 * with a structural identity but no indexed body (the "content missing" list). Cheap to compute — page
 * counts + a url-set membership check, never pulls full text. */
export type ContentCoverage = {
  indexedPages: number;
  totalChunks: number;
  /** Total characters currently in the content store. Distinct from "characters written by one crawl"; the UI must keep them apart. */
  totalChars: number;
  scenesTotal: number;
  emptyPages: Array<{ sceneId: string; name: string; path: string }>;
};

// ripgrep-style output: report only the LINES that contain a match, snapped to the
// enclosing sentence, each with a §segment locator — never the ±neighbor paragraphs
// (that's the agent's read_page "open the full file" step, not the grep result).
const MATCH_RADIUS = 100;          // tight window; the sentence snap usually bounds it first
const SENTENCE_TERMINATORS = ["。", "！", "？", "\n", ".", "!", "?"];
const MAX_MATCH_LINES = 8;         // matched lines shown per page
const PER_PAGE_CHAR_BUDGET = 1500; // token guard per page

// A hit inside a short line — a trending/ranking list item like a headline ("央视曝网红儿童乱象")
// — is weak evidence; the same term inside substantial prose (a policy clause) is strong.
// Down-weight a keyword's rank contribution by the length of the line it landed on, so a
// rare synonym in an unrelated headline can't outrank a real topical match. Structural, not
// semantic — grep still can't read meaning, but line shape separates a list from a paragraph.
const LIST_ITEM_LEN = 16;          // ≤ this ⇒ treated as a list item / headline
const FULL_PROSE_LEN = 40;         // ≥ this ⇒ full-weight prose
const LIST_ITEM_WEIGHT = 0.35;     // floor weight for a bare list-item hit
// Composite Map key: one U+0000 separator (never in a URL/keyword), written as an escape
// so build and lookup keys are byte-identical. A hand-typed space had silently become a
// full-width space in one spot, so every lookup missed and the line-length penalty never fired.
const keyOf = (a: string | number, b: string | number) => `${a}\u0000${b}`;

/** Normalize a keyword / haystack for literal matching: lower-case, fold full-width
 * ASCII + full-width space to half-width, collapse whitespace. Keeps CJK intact so
 * Chinese substring matching ("未成年" ⊂ "未成年人") works with high precision. */
export function normalizeForMatch(value: string): string {
  const folded = value.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0)).replace(/　/g, " ");
  return folded.toLowerCase().replace(/\s+/g, " ").trim();
}

/** True when a keyword is pure ASCII letters/digits — matched on word boundaries
 * (case-insensitive) rather than as a bare substring, so "id" does not hit "video". */
function isWordBoundaryKeyword(normalized: string): boolean {
  return /^[a-z0-9]+$/.test(normalized);
}

/** Escapes a string for safe inclusion in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Stage 1 — literal grep. For every keyword, every occurrence in every chunk.
 * Chinese keywords match as substrings; ASCII-only keywords match on word
 * boundaries. Returns one hit per occurrence (positions drive context windows). */
export function findKeywordHits(chunks: ContentChunkRow[], keywords: string[]): KeywordHit[] {
  const prepared = keywords
    .map((raw) => ({ raw, norm: normalizeForMatch(raw) }))
    .filter((keyword) => keyword.norm.length > 0)
    .map((keyword) => ({
      ...keyword,
      regex: isWordBoundaryKeyword(keyword.norm) ? new RegExp(`\\b${escapeRegExp(keyword.norm)}\\b`, "g") : null,
    }));
  const hits: KeywordHit[] = [];
  for (const chunk of chunks) {
    const hay = normalizeForMatch(chunk.text);
    for (const keyword of prepared) {
      if (keyword.regex) {
        keyword.regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = keyword.regex.exec(hay)) !== null) {
          hits.push({ url: chunk.url, sceneId: chunk.sceneId, chunkIndex: chunk.chunkIndex, keyword: keyword.raw, index: match.index });
          if (match.index === keyword.regex.lastIndex) keyword.regex.lastIndex += 1; // guard against zero-width loops
        }
      } else {
        let from = hay.indexOf(keyword.norm);
        while (from !== -1) {
          hits.push({ url: chunk.url, sceneId: chunk.sceneId, chunkIndex: chunk.chunkIndex, keyword: keyword.raw, index: from });
          from = hay.indexOf(keyword.norm, from + keyword.norm.length);
        }
      }
    }
  }
  return hits;
}

/** Expand a match at [start,end) to a sentence-bounded window of ~radius chars each
 * side: snap the start to just after the previous sentence terminator, extend the end
 * to the next terminator. Returns char offsets into `text`. */
function sentenceWindow(text: string, matchStart: number, matchEnd: number, radius: number): { start: number; end: number } {
  let start = Math.max(0, matchStart - radius);
  let end = Math.min(text.length, matchEnd + radius);
  const before = text.slice(start, matchStart);
  const lastTerm = Math.max(...SENTENCE_TERMINATORS.map((term) => before.lastIndexOf(term)));
  if (lastTerm >= 0) start += lastTerm + 1;
  const after = text.slice(matchEnd, end);
  let nextTerm = -1;
  for (const term of SENTENCE_TERMINATORS) {
    const at = after.indexOf(term);
    if (at >= 0 && (nextTerm === -1 || at < nextTerm)) nextTerm = at;
  }
  if (nextTerm >= 0) end = matchEnd + nextTerm + 1;
  return { start, end };
}

/** Trimmed length of the \n-delimited line containing `index` — the structural width of a
 * hit's line, used to tell a short list item / headline from a prose paragraph. */
function enclosingLineLength(text: string, index: number): number {
  const prev = text.lastIndexOf("\n", index);
  const start = prev === -1 ? 0 : prev + 1;
  let end = text.indexOf("\n", index);
  if (end === -1) end = text.length;
  return text.slice(start, end).trim().length;
}

/** Map a hit line's length to an evidence weight in [LIST_ITEM_WEIGHT, 1]: a bare list item
 * is discounted, full prose keeps full weight, linear in between. */
function proseQuality(lineLength: number): number {
  if (lineLength >= FULL_PROSE_LEN) return 1;
  if (lineLength <= LIST_ITEM_LEN) return LIST_ITEM_WEIGHT;
  const ratio = (lineLength - LIST_ITEM_LEN) / (FULL_PROSE_LEN - LIST_ITEM_LEN);
  return LIST_ITEM_WEIGHT + ratio * (1 - LIST_ITEM_WEIGHT);
}

/** Merge overlapping/adjacent [start,end) ranges (sorted output). */
function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Stage 3 — matched-line extraction for one page (ripgrep default: matching lines only).
 * For each hit, snap to the enclosing sentence; merge overlapping sentences within a chunk;
 * emit each as ONE line carrying its `§segment` (chunk index) locator. No ±neighbor
 * paragraphs — that surrounding context is the agent's read_page step, not the grep result.
 * Capped at MAX_MATCH_LINES lines / PER_PAGE_CHAR_BUDGET chars per page. */
function extractPageMatches(pageChunks: ContentChunkRow[], pageHits: KeywordHit[]): ContentContextWindow[] {
  const byIndex = new Map(pageChunks.map((chunk) => [chunk.chunkIndex, chunk]));
  const hitsByChunk = new Map<number, KeywordHit[]>();
  for (const hit of pageHits) {
    const list = hitsByChunk.get(hit.chunkIndex) ?? [];
    list.push(hit);
    hitsByChunk.set(hit.chunkIndex, list);
  }
  const hitChunkIndexes = [...hitsByChunk.keys()].sort((left, right) => left - right);
  const windows: ContentContextWindow[] = [];
  let used = 0;
  for (const index of hitChunkIndexes) {
    const chunk = byIndex.get(index);
    if (!chunk) continue;
    const ranges = mergeRanges((hitsByChunk.get(index) ?? []).map((hit) => sentenceWindow(chunk.text, hit.index, hit.index + hit.keyword.length, MATCH_RADIUS)));
    for (const range of ranges) {
      if (windows.length >= MAX_MATCH_LINES || used >= PER_PAGE_CHAR_BUDGET) return windows;
      const text = chunk.text.slice(range.start, range.end).trim();
      if (!text) continue;
      const clipped = text.length > PER_PAGE_CHAR_BUDGET - used ? text.slice(0, PER_PAGE_CHAR_BUDGET - used) : text;
      windows.push({ headingPath: chunk.headingPath, text: clipped, segment: index });
      used += clipped.length;
    }
  }
  return windows;
}

/**
 * The agent-facing content search. Literal grep over the site's chunks for a keyword
 * LIST (OR semantics), aggregated to pages ranked by DISTINCT-keyword coverage first,
 * then weighted hit density (heading hits ×2), with the caller's optional page bonus
 * (scene-name hit / readiness) folded into the sort. Returns the top pages with
 * sentence-bounded context windows (budget by rank, ≤5000 chars total) plus the honest
 * `totalPagesWithHits` so the model can tell a distinctive term from a site-wide one.
 *
 * Pure literal grep — no bigram/fuzzy fallback. A total literal miss returns empty; recall
 * for synonyms/phrasing is the caller's responsibility (agent keyword expansion + retry).
 */
/**
 * Query surface of body search. Synonym expansion is the caller's job — the agent turns
 * the user's phrasing into a keyword list; this only does literal matching, so "kids"
 * must be expanded to ["小孩","未成年"] to avoid misses.
 */
export type ContentSearchQuery = {
  /** Keywords for literal matching, OR semantics taking each term's best score. */
  keywords: string[];
  /** Maximum pages returned, DEFAULT_TOP_PAGES by default. */
  topPages?: number;
};

export function grepSiteContent(
  chunks: ContentChunkRow[],
  keywords: ContentSearchQuery["keywords"],
  options?: { topPages?: ContentSearchQuery["topPages"]; pageBonus?: (page: { url: string; sceneId?: string }) => number },
): GrepResult {
  const topPages = options?.topPages ?? DEFAULT_TOP_PAGES;
  const cleanKeywords = keywords.map((keyword) => keyword.trim()).filter(Boolean);
  const totalKeywords = new Set(cleanKeywords.map(normalizeForMatch)).size || 1;
  const hits = findKeywordHits(chunks, cleanKeywords);
  const totalPages = new Set(chunks.map((chunk) => chunk.url)).size || 1;
  // No fuzzy/bigram fallback: literal misses return empty. Synonym recall is the caller's
  // job (agent keyword expansion + retry); a bigram net cannot bridge a semantic gap it
  // has no character overlap for ("小孩" vs "未成年"), and only fires on glyph coincidence —
  // exactly the noise pure grep removes. Empty here → the agent retries or says "not available on this site".

  // Per-keyword document frequency: how many DISTINCT pages each keyword hits site-wide.
  // A term on few pages is distinctive (high signal); one on many pages is near-noise.
  const pagesByKeyword = new Map<string, Set<string>>();
  for (const hit of hits) {
    const norm = normalizeForMatch(hit.keyword);
    const set = pagesByKeyword.get(norm) ?? new Set<string>();
    set.add(hit.url);
    pagesByKeyword.set(norm, set);
  }
  // Rarity weight (IDF-style, always positive): rare keyword ⇒ large, site-wide ⇒ ~0.
  const idf = (norm: string) => {
    const df = pagesByKeyword.get(norm)?.size ?? totalPages;
    return Math.log((totalPages + 1) / (df + 0.5));
  };
  // Best (longest) line a keyword landed on per page — a term appearing in prose somewhere
  // on the page earns full weight even if it also appears in a list; a term ONLY ever in
  // short list items stays discounted. Keyed `url   normalizedKeyword`.
  const chunkTextByKey = new Map<string, string>();
  for (const chunk of chunks) chunkTextByKey.set(keyOf(chunk.url, chunk.chunkIndex), chunk.text);
  const bestLineLen = new Map<string, number>();
  for (const hit of hits) {
    const text = chunkTextByKey.get(keyOf(hit.url, hit.chunkIndex));
    if (text === undefined) continue;
    const key = keyOf(hit.url, normalizeForMatch(hit.keyword));
    const length = enclosingLineLength(text, hit.index);
    if (length > (bestLineLen.get(key) ?? 0)) bestLineLen.set(key, length);
  }

  // Stage 2 — aggregate by url. (Empty `hits` ⇒ empty `byUrl` ⇒ { pages: [], totalPagesWithHits: 0 }.)
  type PageAgg = { url: string; sceneId?: string; headingPath?: string; keywords: Set<string>; hitCount: number; weightedDensity: number };
  const byUrl = new Map<string, PageAgg>();
  const headingByUrl = new Map<string, string | undefined>();
  for (const chunk of chunks) if (!headingByUrl.has(chunk.url)) headingByUrl.set(chunk.url, chunk.headingPath);
  for (const hit of hits) {
    const agg = byUrl.get(hit.url) ?? { url: hit.url, sceneId: hit.sceneId, headingPath: headingByUrl.get(hit.url), keywords: new Set<string>(), hitCount: 0, weightedDensity: 0 };
    agg.keywords.add(normalizeForMatch(hit.keyword));
    agg.hitCount += 1;
    // A hit inside the page's heading is worth double — it names the page's topic.
    const inHeading = agg.headingPath ? normalizeForMatch(agg.headingPath).includes(normalizeForMatch(hit.keyword)) : false;
    agg.weightedDensity += inHeading ? 2 : 1;
    byUrl.set(hit.url, agg);
  }

  const scored = [...byUrl.values()].map((agg) => {
    const coverage = agg.keywords.size / totalKeywords;
    const bonus = options?.pageBonus?.({ url: agg.url, sceneId: agg.sceneId }) ?? 0;
    // Distinctiveness DOMINATES the rank: sum of matched keywords' rarity weights, each
    // scaled by the line quality where that keyword hit — so a site-rare synonym landing
    // only in a short trending headline (儿童 in "央视曝网红儿童乱象") is discounted and cannot
    // outrank a real topical match in prose (未成年 in a policy clause). Density is a bounded
    // tie-breaker among equally-distinctive pages. `score` stays readable coverage.
    const distinctiveness = [...agg.keywords].reduce((sum, norm) => {
      const lineLength = bestLineLen.get(keyOf(agg.url, norm)) ?? FULL_PROSE_LEN;
      return sum + idf(norm) * proseQuality(lineLength);
    }, 0);
    const sortKey = distinctiveness + Math.min(agg.weightedDensity, 20) / 20 * 0.3 + bonus;
    return { agg, coverage, distinctiveness, sortKey };
  }).sort((left, right) => right.sortKey - left.sortKey);

  const hitsByUrl = new Map<string, KeywordHit[]>();
  for (const hit of hits) {
    const list = hitsByUrl.get(hit.url) ?? [];
    list.push(hit);
    hitsByUrl.set(hit.url, list);
  }

  const pages: GrepPageMatch[] = scored.slice(0, topPages).map(({ agg, coverage, distinctiveness }) => {
    const pageChunks = chunks.filter((chunk) => chunk.url === agg.url).sort((left, right) => left.chunkIndex - right.chunkIndex);
    const keywordFrequencies: Record<string, number> = {};
    for (const norm of agg.keywords) keywordFrequencies[norm] = pagesByKeyword.get(norm)?.size ?? 0;
    return {
      url: agg.url,
      sceneId: agg.sceneId,
      headingPath: agg.headingPath,
      matchedKeywords: [...agg.keywords],
      keywordFrequencies,
      hitCount: agg.hitCount,
      score: Number(coverage.toFixed(4)),
      distinctiveness: Number(distinctiveness.toFixed(3)),
      context: extractPageMatches(pageChunks, hitsByUrl.get(agg.url) ?? []),
    };
  });

  return { pages, totalPagesWithHits: byUrl.size };
}

// --- diagnostic-only coverage (knowledge-center-manageability) ----------------
// Chinese question-filler bigrams that carry no site meaning — excluded so they don't
// count as "the site mentions this" when diagnosing a miss.
const DIAGNOSTIC_STOPGRAMS = new Set(["怎么", "如何", "没有", "有没", "是否", "可以", "多少", "是多", "什么", "哪里", "这个", "那个", "一下", "请问", "想问", "咨询", "能不", "不能", "一个", "要怎", "的话"]);

/**
 * DIAGNOSTIC READOUT ONLY (never drives behavior). Do the content-bearing terms of a
 * question appear literally on ANY indexed page? Used by the console probe to tell a
 * search/expansion problem (words ARE on the site, grep on the expanded keywords still
 * missed) from a genuine knowledge gap (the words are nowhere). Literal Han-bigram
 * presence, filler bigrams dropped. Returns whether it appears + a few sample urls.
 */
export function queryTermsAppear(chunks: ContentChunkRow[], text: string): { appears: boolean; sampleUrls: string[] } {
  const han = (text || "").replace(/[^\p{Script=Han}]/gu, "");
  const grams = new Set<string>();
  for (let index = 0; index < han.length - 1; index += 1) {
    const gram = han.slice(index, index + 2);
    if (!DIAGNOSTIC_STOPGRAMS.has(gram)) grams.add(gram);
  }
  if (!grams.size) return { appears: false, sampleUrls: [] };
  const urls = new Set<string>();
  for (const chunk of chunks) {
    for (const gram of grams) {
      if (chunk.text.includes(gram)) { urls.add(chunk.url); break; }
    }
  }
  return { appears: urls.size > 0, sampleUrls: [...urls].slice(0, 3) };
}
