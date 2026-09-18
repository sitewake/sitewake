/**
 * Block-level content filter: keeps dynamic regions (trending widgets,
 * recommendations, comment sections, page chrome) out of the content knowledge
 * base and admits only body text. See docs/design/site-knowledge-dynamic-content-filter.html.
 *
 * Two layers, forced by the bundling constraint described in crawl-render.ts
 * (esbuild `keepNames` rewrites named functions into a `__name` helper the
 * browser does not have):
 *
 *   1. Measurement (in page) — `BLOCK_MEASURE_SOURCE`, a *string* expression.
 *      Strings are not compiled, so keepNames cannot touch them; the same source
 *      serves production rendering and the regression corpus.
 *   2. Judgement (functions here) — pure, DOM-free, unit-testable; the fallback
 *      judgement also needs the dropped blocks outside the page.
 *
 * Judgement is a vote, not a weighted sum: weights encode "which signal was
 * more accurate on the sites I have seen", which is where overfitting starts.
 */

/** One content block from in-page measurement. Every field is a shape; no site convention (class-name vocabularies) is involved. */
export type RawBlock = {
  /** Stable in-page id; the fallback judgement restores text by it. */
  id: number;
  /**
   * DOM position such as `body>main>div.2>p.1`. Both the cross-instance and the
   * cross-time layers align on it: text is the thing that changes, so it cannot be the identity.
   */
  path: string;
  tag: string;
  /** Page region, normalised from the semantic tag or ARIA role. */
  region: "header" | "nav" | "aside" | "footer" | "main" | "unknown";
  /** Structured content (table / code / quote): exempt from the two shape checks. */
  structural: boolean;
  text: string;
  textLen: number;
  /** Length of the text inside links. */
  linkTextLen: number;
  /** Number of non-empty lines. */
  lineCount: number;
  /** Average characters per line. */
  avgLineLen: number;
  /** Number of direct children (in an atomic container: the number of repeated units). */
  childCount: number;
  /** Distinct child structure fingerprints, to tell "the same mould repeated N times". */
  distinctChildShapes: number;
  /** Occurrences of relative timestamps ("3 分钟前" / "2 hours ago"). */
  timestampHits: number;
  /** Punctuation count. Sentences have it; list entries (headline stubs) do not. */
  punctHits: number;
};

export type SignalName = "linkList" | "shellRepeat" | "region" | "timestamp";

export type BlockVerdict = {
  id: number;
  decision: "keep" | "drop" | "undecided";
  /** Signals that flagged it, for statistics and the fallback judgement. */
  votes: SignalName[];
};

export type FilterStats = {
  blockCount: number;
  keptChars: number;
  droppedChars: number;
  keptRatio: number;
  undecidedCount: number;
  /** Blocks hit per signal, for the label-free health metrics. */
  signalHits: Record<SignalName, number>;
  /** Median link density of dropped blocks: clearly low means body text may have been killed. */
  droppedLinkDensityMedian: number;
  /** Average line length of kept text: clearly low means lists were taken for prose. */
  keptAvgLineLen: number;
  /** Punctuation density of kept text (per character): clearly low means what was kept is not prose. */
  keptPunctDensity: number;
  /** This page's prose baseline for "is this line short". */
  proseBaseline: number;
};

export type FilterResult = {
  mainText: string;
  verdicts: BlockVerdict[];
  /** Ids of blocks with exactly one vote, handed to the LLM to arbitrate. */
  undecided: number[];
  /** Dropped blocks, handed to the LLM by id during the fallback judgement. */
  dropped: Array<{ id: number; text: string }>;
  stats: FilterStats;
};

export type FilterOptions = {
  /** What to do with one-vote blocks without an LLM. Production hands them to the LLM; the corpus and the degraded path keep them. */
  undecidedPolicy?: "keep" | "drop" | "undecided";
  /** Character cap on body text; truncation happens after filtering. */
  maxChars?: number;
};

/** Votes needed to call a block noise. Four equal signals; two votes decide. */
const VOTES_TO_DROP = 2;
/** Link-text share is a ratio, language-independent, so an absolute threshold settles it. */
const LINK_DENSITY_HARD = 0.75;
/** Lower bound on link share when comparing against the page's prose baseline. */
const LINK_DENSITY_SOFT = 0.45;
/** How short, relative to the page's prose baseline, counts as "chopped-up entries". */
const SHORT_LINE_RATIO = 0.5;
/** Upper bound on per-item content relative to the prose baseline; above it an item has real content. */
const THIN_ITEM_RATIO = 0.6;
/** Minimum number of children to count as "repetition". */
const MIN_REPEAT_ITEMS = 4;
/** Fallback baseline when the page has no prose at all, so homogeneous pages still have a reference. */
const PROSE_BASELINE_FALLBACK = 40;
/** Timestamp density: one relative time per this many characters marks a dynamic region. */
const TIMESTAMP_PER_CHARS = 120;

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const linkDensityOf = (block: RawBlock): number =>
  block.textLen > 0 ? Math.min(1, block.linkTextLen / block.textLen) : 0;

/**
 * Step 3: read the whole page first, then define "outlier".
 *
 * Character counts are language-dependent (20 Chinese characters carry an order
 * of magnitude more than 20 English ones), so every character-based comparison
 * is relative to this page's prose; link share is a ratio and uses an absolute threshold.
 *
 * The prose baseline is the median line length of the page's link-sparse
 * blocks. A page with no prose at all (a pure ranking or index page) has no
 * in-page reference and falls back to the default baseline — otherwise nothing
 * on a homogeneous page is an outlier and the whole page passes.
 */
export function calibratePage(blocks: RawBlock[]): { proseBaseline: number; linkDensityMedian: number } {
  const proseBlocks = blocks.filter((block) => block.textLen >= 24 && linkDensityOf(block) < 0.3);
  const baseline = median(proseBlocks.map((block) => block.avgLineLen));
  return {
    proseBaseline: baseline > 0 ? baseline : PROSE_BASELINE_FALLBACK,
    linkDensityMedian: median(blocks.map(linkDensityOf)),
  };
}

/**
 * Step 5: four independent signals; no single one decides.
 *
 * Structured content (table / code / quote) naturally has a few characters per
 * line and highly repetitive structure, so it would trip signals 1 and 2 at
 * once; those two shape checks are waived for it — nothing else is: a ranking
 * laid out as a table still dies on link density, or the daily trending list
 * would walk straight into the knowledge base.
 */
export function voteBlock(
  block: RawBlock,
  page: { proseBaseline: number; linkDensityMedian: number },
): SignalName[] {
  const votes: SignalName[] = [];
  const linkDensity = linkDensityOf(block);
  const shortLine = block.avgLineLen <= page.proseBaseline * SHORT_LINE_RATIO;

  // Signal 1: link density × line length. Both together — link density alone kills wiki-style prose full of internal links.
  if (!block.structural || linkDensity >= LINK_DENSITY_HARD) {
    const overwhelminglyLinks = linkDensity >= LINK_DENSITY_HARD;
    // Absolute ratio plus in-page relative line length only. Comparing against
    // the page's median link density was counter-productive: on a ranking page
    // the other blocks are pure link navigation, the median rises to 1.00 and
    // the list that should go survives. The ratio is language-independent, so an
    // absolute threshold suffices; in-page relativity belongs to character counts.
    const linkyAndChopped = linkDensity >= LINK_DENSITY_SOFT && shortLine;
    if (overwhelminglyLinks || linkyAndChopped) votes.push("linkList");
  }

  // Signal 2: repeated structure × content per item. From the design: "repeated +
  // a few characters per item that are basically a link → hollow list; repeated +
  // a paragraph per item → content, leave it". All three conditions are needed:
  // repetition alone kills FAQs, API method lists and spec entries; short text
  // alone kills the rights clauses of a terms page (twenty characters each, but
  // sentences without links — real knowledge).
  if (!block.structural && block.childCount >= MIN_REPEAT_ITEMS) {
    const repeated = block.distinctChildShapes <= Math.max(1, Math.ceil(block.childCount * 0.25));
    // "No paragraph per item" is measured by characters per line, not per item.
    // Per-item counts miss real cases: a daily trending list has 42 characters
    // per item (rank, peak, record count piled together), above the threshold,
    // yet 10 characters per line and zero punctuation — a pile of labels, not
    // prose. Line length shares its source with signal 1: in-page relative, safe across languages.
    const thin = block.avgLineLen <= page.proseBaseline * THIN_ITEM_RATIO;
    // "Basically a link": either links hold most of the text, or the block barely forms sentences (no punctuation).
    const hollow = linkDensity >= LINK_DENSITY_SOFT || block.punctHits <= block.childCount * 0.5;
    if (repeated && thin && hollow) votes.push("shellRepeat");
  }

  // Signal 3: page region. Content in chrome regions is not body text.
  if (block.region === "header" || block.region === "nav" || block.region === "aside" || block.region === "footer") {
    votes.push("region");
  }

  // Signal 4: relative-timestamp density. Comment sections are ordinary prose that the first three signals never catch.
  if (block.timestampHits >= 2 && block.textLen / block.timestampHits <= TIMESTAMP_PER_CHARS) {
    votes.push("timestamp");
  }

  return votes;
}

/**
 * Steps 6–7: count votes. ≥2 drops, 0 keeps, exactly 1 goes to the LLM.
 * Body text is joined in page order; truncation happens after filtering.
 */
export function filterBlocks(blocks: RawBlock[], options: FilterOptions = {}): FilterResult {
  const undecidedPolicy = options.undecidedPolicy ?? "undecided";
  const maxChars = options.maxChars ?? 20_000;
  const page = calibratePage(blocks);

  const signalHits: Record<SignalName, number> = { linkList: 0, shellRepeat: 0, region: 0, timestamp: 0 };
  const verdicts: BlockVerdict[] = [];
  const keptBlocks: RawBlock[] = [];
  const dropped: Array<{ id: number; text: string }> = [];
  const undecided: number[] = [];

  for (const block of blocks) {
    const votes = voteBlock(block, page);
    for (const vote of votes) signalHits[vote] += 1;
    const tally = votes.length;

    let decision: BlockVerdict["decision"];
    if (tally >= VOTES_TO_DROP) decision = "drop";
    else if (tally === 0) decision = "keep";
    else decision = undecidedPolicy === "undecided" ? "undecided" : undecidedPolicy;

    verdicts.push({ id: block.id, decision, votes });
    if (decision === "keep") keptBlocks.push(block);
    else if (decision === "drop") dropped.push({ id: block.id, text: block.text.slice(0, 600) });
    else {
      undecided.push(block.id);
      dropped.push({ id: block.id, text: block.text.slice(0, 600) });
    }
  }

  const mainText = keptBlocks.map((block) => block.text).join("\n").slice(0, maxChars);
  const keptChars = keptBlocks.reduce((total, block) => total + block.textLen, 0);
  const droppedChars = blocks.reduce((total, block) => total + block.textLen, 0) - keptChars;
  const totalChars = keptChars + droppedChars;

  return {
    mainText,
    verdicts,
    undecided,
    dropped,
    stats: {
      blockCount: blocks.length,
      keptChars,
      droppedChars,
      keptRatio: totalChars > 0 ? keptChars / totalChars : 0,
      undecidedCount: undecided.length,
      signalHits,
      droppedLinkDensityMedian: median(
        blocks.filter((block) => !keptBlocks.includes(block)).map(linkDensityOf),
      ),
      keptAvgLineLen: median(keptBlocks.map((block) => block.avgLineLen)),
      keptPunctDensity: (() => { const chars = keptBlocks.reduce((sum, block) => sum + block.textLen, 0); return chars > 0 ? keptBlocks.reduce((sum, block) => sum + block.punctHits, 0) / chars : 0; })(),
      proseBaseline: page.proseBaseline,
    },
  };
}

/** Filter report for one page: the kernel's statistics plus execution details added by the runner. */
export type PageFilterReport = FilterStats & {
  url: string;
  /** Whether the whole-page fallback fired (less than 5% kept). */
  fallbackTriggered: boolean;
  /** Which path the fallback took: LLM picked ids / conservative rule / not triggered. */
  fallbackPath: "none" | "llm" | "conservative";
  /** Whether an LLM call happened for this page (grey-zone arbitration or fallback). */
  llmUsed: boolean;
  /** Judged a "no body content" page: nothing enters the content store; structure still enters the structural knowledge base. */
  emptyContentPage: boolean;
  /** Historical observations the cross-time layer compared: 0 first crawl / 1 inconclusive / 2+ conclusive. */
  observationsCompared?: number;
  /**
   * Milliseconds between this and the previous observation; null without a
   * baseline. Must be reported: the cross-time guarantee is asymmetric — changed
   * means changed, unchanged only means unchanged within this interval. Without
   * the interval, "no dynamic content detected" reads as "there is none".
   */
  baselineIntervalMs?: number | null;
  /** One site-wide human-readable hint: what another crawl would clean up. */
  recrawlHint?: string;
  recrawlStage?: "first-crawl" | "needs-one-more" | "ready";
  /**
   * Pages one observation short, and the shortest baseline interval (minutes).
   *
   * With these two numbers the console renders the hint in the current
   * language instead of the Chinese sentence baked in at generation time. The
   * recrawlHint string stays: old crawl records only have that, and old and new data share a screen.
   */
  recrawlPagesNeedingMore?: number;
  recrawlShortestIntervalMinutes?: number;
  /** Lines the fourth layer removed on this page, and the cross-instance verdict, for the site-wide attribution summary. */
  timeDroppedLines?: number;
  templateVerdict?: "data" | "content" | "undetermined";
};

/**
 * Label-free health metrics: computable without knowing the right answer, so
 * they run on any site never seen before. Under "zero user involvement" they are
 * the only way to keep noticing degradation — the system sees anomalies itself
 * instead of silently poisoning the knowledge base. They only signal; nothing is acted on automatically.
 */
export type SiteHealth = {
  pages: number;
  /** Quartiles of the keep ratio. Generally low → over-filtering; generally 1 → the filter is inert. */
  keptRatioQuartiles: [number, number, number];
  /** Prose features of kept text: average line length and punctuation density. Low means lists were taken for prose. */
  keptAvgLineLen: number;
  keptPunctDensity: number;
  /** Median link density of dropped blocks. Low means much of what was dropped did not look like a list — body text was probably killed. */
  droppedLinkDensityMedian: number;
  /** Fallback rate. Frequent fallbacks mean the site's shape is outside the design assumptions. */
  fallbackRate: number;
  /** Share of pages without body content. Near 1 site-wide means the site may not suit a content knowledge base at all. */
  emptyPageRate: number;
  /**
   * Median baseline interval of the cross-time layer (ms); null without a
   * baseline. Must be shown: this layer's guarantee is asymmetric — changed
   * means changed, unchanged only means unchanged within the interval. Without
   * it, "no dynamic content detected" reads as "there is none", when the real
   * reason is usually two crawls too close together.
   */
  baselineIntervalMs: number | null;
  /**
   * A human-readable hint that the knowledge base is not yet at its cleanest,
   * and how to get it there. Re-crawls are triggered by hand (this repository
   * has no scheduler); without the hint nobody knows another crawl is due.
   */
  recrawlHint?: string;
  recrawlStage?: "first-crawl" | "needs-one-more" | "ready";
  recrawlPagesNeedingMore?: number;
  recrawlShortestIntervalMinutes?: number;
  /**
   * What this crawl actually cleaned up — for the console's "what each crawl
   * improved". Attributed per layer: the four layers remove very different
   * things, and one merged number explains nothing.
   */
  removed: {
    /** Layer 1: characters judged chrome or list by in-page shape. */
    shapeChars: number;
    /** Layer 2: pages judged template-generated and skipped as a batch. */
    dataPages: number;
    /** Layer 4: lines that changed on two consecutive crawls and were removed as time-sensitive. */
    changingLines: number;
    /** Total characters of body text stored. */
    keptChars: number;
  };
  /** Anomalies that crossed a threshold, shown directly in the console. */
  warnings: string[];
};

const quartiles = (values: number[]): [number, number, number] => {
  if (!values.length) return [0, 0, 0];
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return [at(0.25), at(0.5), at(0.75)];
};

export function siteHealth(reports: PageFilterReport[]): SiteHealth {
  const pages = reports.length;
  const ratios = reports.map((report) => report.keptRatio);
  const [q1, q2, q3] = quartiles(ratios);
  const fallbackRate = pages ? reports.filter((report) => report.fallbackTriggered).length / pages : 0;
  const emptyPageRate = pages ? reports.filter((report) => report.emptyContentPage).length / pages : 0;
  const keptAvgLineLen = median(reports.map((report) => report.keptAvgLineLen).filter((value) => value > 0));
  const keptPunctDensity = median(reports.map((report) => report.keptPunctDensity ?? 0));
  const droppedLinkDensityMedian = median(reports.map((report) => report.droppedLinkDensityMedian));

  const warnings: string[] = [];
  if (pages >= 5 && q2 < 0.2) warnings.push("整站保留率中位数低于 20%：过滤可能过激");
  if (pages >= 5 && q1 >= 0.99) warnings.push("整站几乎不丢弃任何内容：过滤可能失效");
  if (pages >= 5 && droppedLinkDensityMedian < 0.2) warnings.push("被丢块的链接密度普遍偏低：丢掉的东西不像名单，可能在误杀正文");
  if (pages >= 5 && fallbackRate > 0.3) warnings.push("超过三成页面触发保底：该站点形态超出设计假设");

  const sum = (pick: (report: PageFilterReport) => number) => reports.reduce((total, report) => total + (pick(report) || 0), 0);
  const removed = {
    shapeChars: sum((report) => report.droppedChars),
    dataPages: reports.filter((report) => report.templateVerdict === "data").length,
    changingLines: sum((report) => report.timeDroppedLines ?? 0),
    keptChars: sum((report) => report.keptChars),
  };
  const intervals = reports.map((report) => report.baselineIntervalMs).filter((value): value is number => typeof value === "number");
  const baselineIntervalMs = intervals.length ? median(intervals) : null;
  const recrawlHint = reports.find((report) => report.recrawlHint)?.recrawlHint;
  // Carry the structure too: the hint is interface copy that the console renders in the visitor's language, not fixed Chinese here.
  const hinted = reports.find((report) => report.recrawlStage);
  const recrawlStage = hinted?.recrawlStage;
  const recrawlPagesNeedingMore = hinted?.recrawlPagesNeedingMore;
  const recrawlShortestIntervalMinutes = hinted?.recrawlShortestIntervalMinutes;
  // recrawlHint already says the interval was too short (and what to do);
  // repeating it here would be two near-identical hints side by side.
  return { pages, keptRatioQuartiles: [q1, q2, q3], keptAvgLineLen, keptPunctDensity, droppedLinkDensityMedian, fallbackRate, emptyPageRate, baselineIntervalMs, recrawlHint, recrawlStage, recrawlPagesNeedingMore, recrawlShortestIntervalMinutes, removed, warnings };
}

/**
 * Conservative rule: the degraded path when the LLM is unavailable or over its
 * call limit — drop only blocks clearly in the header / nav / sidebar / footer
 * and keep everything else. One pass, no iteration. Better to keep noise than to empty the page silently.
 */
export function conservativeFilter(blocks: RawBlock[], options: FilterOptions = {}): FilterResult {
  const maxChars = options.maxChars ?? 20_000;
  const shell = new Set(["header", "nav", "aside", "footer"]);
  const kept = blocks.filter((block) => !shell.has(block.region));
  const keptChars = kept.reduce((total, block) => total + block.textLen, 0);
  const totalChars = blocks.reduce((total, block) => total + block.textLen, 0);
  return {
    mainText: kept.map((block) => block.text).join("\n").slice(0, maxChars),
    verdicts: blocks.map((block) => ({
      id: block.id,
      decision: shell.has(block.region) ? "drop" : "keep",
      votes: shell.has(block.region) ? (["region"] as SignalName[]) : [],
    })),
    undecided: [],
    dropped: blocks.filter((block) => shell.has(block.region)).map((block) => ({ id: block.id, text: block.text.slice(0, 600) })),
    stats: {
      blockCount: blocks.length,
      keptChars,
      droppedChars: totalChars - keptChars,
      keptRatio: totalChars > 0 ? keptChars / totalChars : 0,
      undecidedCount: 0,
      signalHits: { linkList: 0, shellRepeat: 0, region: blocks.length - kept.length, timestamp: 0 },
      droppedLinkDensityMedian: 0,
      keptAvgLineLen: median(kept.map((block) => block.avgLineLen)),
      keptPunctDensity: (() => { const chars = kept.reduce((sum, block) => sum + block.textLen, 0); return chars > 0 ? kept.reduce((sum, block) => sum + block.punctHits, 0) / chars : 0; })(),
      proseBaseline: 0,
    },
  };
}

/**
 * Step 2: in-page block measurement.
 *
 * Exported as a *string*: the runner bundles this file with esbuild/tsx
 * (keepNames), which rewrites every named function into a `__name` helper the
 * browser lacks and makes page.evaluate throw (crawl-render.ts explains the
 * same problem). A string is not compiled, so the bundler cannot touch it, and
 * production and the regression corpus share one source.
 *
 * Measurement only, no judgement: judgement needs the whole-page distribution
 * (step 3), and the fallback needs the dropped blocks outside the page.
 */
export const BLOCK_MEASURE_SOURCE = String.raw`(() => {
  var ATOMIC = { TABLE: 1, UL: 1, OL: 1, DL: 1, PRE: 1, BLOCKQUOTE: 1, FIGURE: 1 };
  var LEAF = { P: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, DT: 1, DD: 1, LI: 1, FIGCAPTION: 1 };
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, IFRAME: 1 };
  var ROLE_REGION = { banner: "header", navigation: "nav", complementary: "aside", contentinfo: "footer", main: "main" };
  var TS = /(\d+\s*(分钟|小时|天|周|个?月|年)前|刚刚|昨天|前天|今天|\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago|just now|yesterday)/gi;

  var textOf = function (el) { return (el.innerText || el.textContent || "").replace(/ /g, " ").trim(); };

  var regionOf = function (el) {
    var owner = el.closest("header,nav,aside,footer,main,article");
    var byTag = owner ? owner.tagName.toLowerCase() : "";
    if (byTag === "header" || byTag === "nav" || byTag === "aside" || byTag === "footer") return byTag;
    var roled = el.closest("[role]");
    if (roled) {
      var mapped = ROLE_REGION[(roled.getAttribute("role") || "").toLowerCase()];
      if (mapped && mapped !== "main") return mapped;
      if (mapped === "main") return "main";
    }
    if (byTag === "main" || byTag === "article") return "main";
    return "unknown";
  };

  // Data table vs layout table: old sites lay out whole pages with one big
  // table. Layout tables have no header, irregular rows and columns and huge
  // cells; once recognised they are broken up and re-judged block by block.
  var isDataTable = function (table) {
    if (table.querySelector("th")) return true;
    var rows = Array.from(table.rows || []);
    if (rows.length < 3) return false;
    var counts = rows.map(function (row) { return row.cells.length; });
    var uniform = counts.every(function (count) { return count === counts[0]; });
    var cellLens = [];
    for (var i = 0; i < rows.length; i++) {
      for (var j = 0; j < rows[i].cells.length; j++) cellLens.push(textOf(rows[i].cells[j]).length);
    }
    cellLens.sort(function (a, b) { return a - b; });
    var mid = cellLens.length ? cellLens[Math.floor(cellLens.length / 2)] : 0;
    return uniform && mid > 0 && mid <= 80;
  };

  var INLINE = { A: 1, SPAN: 1, STRONG: 1, EM: 1, B: 1, I: 1, CODE: 1, SMALL: 1, SUP: 1, SUB: 1, BR: 1, IMG: 1, TIME: 1, LABEL: 1 };
  var PUNCT = /[，。；？！：、,;?!:]/g;

  var pathOf = function (el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node.tagName !== "BODY" && parts.length < 24) {
      var idx = 1;
      var sib = node;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === node.tagName) idx += 1;
      parts.unshift(node.tagName.toLowerCase() + "." + idx);
      node = node.parentElement;
    }
    return "body>" + parts.join(">");
  };

  var shapeOf = function (el) {
    var kids = [];
    for (var i = 0; i < el.children.length; i++) kids.push(el.children[i].tagName);
    return el.tagName + "[" + kids.join(">") + "]";
  };

  var blocks = [];
  var directTextOf = function (el) {
    var parts = [];
    for (var i = 0; i < el.childNodes.length; i++) {
      var node = el.childNodes[i];
      if (node.nodeType === 3) {
        var piece = (node.textContent || "").replace(/ /g, " ").trim();
        if (piece) parts.push(piece);
      }
    }
    return parts.join("\n");
  };
  var emit = function (el, overrideText) {
    var text = typeof overrideText === "string" ? overrideText : textOf(el);
    if (!text) return;
    var anchors = el.querySelectorAll ? el.querySelectorAll("a") : [];
    var linkLen = 0;
    for (var i = 0; i < anchors.length; i++) linkLen += textOf(anchors[i]).length;
    var lines = text.split("\n").map(function (line) { return line.trim(); }).filter(Boolean);
    // Only block-level children count as repeated units: inline <a> in a paragraph is a link, not a list entry.
    var kids = [];
    for (var k = 0; k < el.children.length; k++) {
      var kid = el.children[k];
      if (!SKIP[kid.tagName] && !INLINE[kid.tagName]) kids.push(kid);
    }
    var shapes = {};
    var distinct = 0;
    for (var s = 0; s < kids.length; s++) {
      var shape = shapeOf(kids[s]);
      if (!shapes[shape]) { shapes[shape] = 1; distinct += 1; }
    }
    var tsMatches = text.match(TS);
    var tag = el.tagName.toLowerCase();
    blocks.push({
      id: blocks.length,
      path: pathOf(el),
      tag: tag,
      region: regionOf(el),
      structural: tag === "table" || tag === "pre" || tag === "code" || tag === "blockquote",
      text: text,
      textLen: text.length,
      linkTextLen: Math.min(linkLen, text.length),
      lineCount: lines.length,
      avgLineLen: lines.length ? Math.round(lines.reduce(function (sum, line) { return sum + line.length; }, 0) / lines.length) : 0,
      childCount: kids.length,
      distinctChildShapes: distinct,
      timestampHits: tsMatches ? tsMatches.length : 0,
      punctHits: (text.match(PUNCT) || []).length,
    });
  };

  var walk = function (el, depth) {
    if (!el || SKIP[el.tagName] || depth > 24) return;
    if (!textOf(el)) return;
    if (el.tagName === "TABLE") {
      if (isDataTable(el)) { emit(el); return; }
    } else if (ATOMIC[el.tagName]) {
      emit(el);
      return;
    } else if (LEAF[el.tagName]) {
      emit(el);
      return;
    }
    var kids = [];
    for (var i = 0; i < el.children.length; i++) {
      var child = el.children[i];
      if (!SKIP[child.tagName] && !INLINE[child.tagName] && textOf(child)) kids.push(child);
    }
    if (!kids.length) { emit(el); return; }
    // A container of repeated units is an atomic block. Splitting further would
    // separate an entry's timestamp from its text into different blocks, which
    // kills signal 4, and the "same mould repeated N times" shape vanishes.
    // Card walls, list feeds and comment sections all have this shape, usually
    // built from semantic-free divs that only the shape can identify.
    if (kids.length >= 3) {
      var kidShapes = {};
      var kidDistinct = 0;
      for (var d = 0; d < kids.length; d++) {
        var kidShape = shapeOf(kids[d]);
        if (!kidShapes[kidShape]) { kidShapes[kidShape] = 1; kidDistinct += 1; }
      }
      if (kidDistinct <= Math.max(1, Math.ceil(kids.length * 0.25))) { emit(el); return; }
    }
    // Direct text of the container that belongs to no child is kept as its own block.
    var ownLen = textOf(el).length;
    var kidLen = 0;
    for (var j = 0; j < kids.length; j++) kidLen += textOf(kids[j]).length;
    // Only the container's own direct text nodes. Emitting the subtree's
    // innerText too makes the container overlap its children, and the joined
    // body text comes out longer than the original — seen on a real homepage.
    if (ownLen - kidLen > 24) emit(el, directTextOf(el));
    for (var w = 0; w < kids.length; w++) walk(kids[w], depth + 1);
  };

  walk(document.body, 0);
  return blocks;
})()`;
