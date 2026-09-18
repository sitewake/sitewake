/**
 * Comparison rules for layer 2 (cross-instance) and layer 4 (cross-time).
 *
 * The shape layer (content-filter) compares against other blocks on the same page, so
 * it can only answer spatial questions — list or paragraph. It cannot answer temporal
 * ones: a celebrity page's running totals or the home page's daily digest are
 * paragraph-shaped, punctuated, link-sparse and in the main area — identical in all
 * four shape features to a terms-of-service body. Those need a different baseline:
 *
 *   Layer 2 · baseline = sibling pages of the same template — split constant nodes
 *            (template) from variable nodes (data); short variable fields mean the
 *            whole class is data pages, long prose means every page is knowledge.
 *   Layer 4 · baseline = earlier versions of the same page — compare line by line per
 *            structural position; only lines that changed twice in a row are dynamic.
 *
 * Neither layer depends on a model, on how the site is written, or on constants carried
 * across sites: every comparison happens within one set of baselines.
 */
import { contentHashOf } from "./content-index";
import type { RawBlock } from "./content-filter";

/* ── Layer 2: cross-instance template induction ─────────────────────── */

export type TemplateInstance = { url: string; blocks: RawBlock[] };

export type TemplateVerdict = {
  /** data: instances differ only in short fields, whole class excluded; content: every page is knowledge; undetermined: cannot decide. */
  kind: "data" | "content" | "undetermined";
  /** Reason for the verdict, written to stats for humans. */
  reason: string;
  /** Structural positions identical across all instances — the template shell. */
  constantPaths: string[];
  /** Structural positions that differ between instances — where the data lives. */
  variantPaths: string[];
  /** Measured shape of the variable part versus the constant part, for stats and debugging. */
  metrics: {
    instances: number;
    variantAvgLineLen: number;
    constantAvgLineLen: number;
    variantPunctDensity: number;
    variantChars: number;
  };
};

/** Minimum sibling instances for a verdict. Two suffice — the "must have a variable position" rule guards against near-identical pages. */
const MIN_INSTANCES = 2;

/**
 * Grouping key for sibling instances: pages rendered by the same template share the
 * same set of structural positions.
 *
 * URL templates cannot be the key. Parameterizing a URL means guessing which segment
 * is the instance value (numeric id, CJK text, long slug), and `/celebrity/Ella`,
 * `/u/jay`, `/p?id=Ella` cannot be guessed — no guess, no group, and layer 2 simply
 * fails on such sites. Page structure needs no guessing: template-generated pages
 * necessarily share structure, which is the premise of wrapper induction.
 *
 * Indices are stripped (`li.3` → `li`): item counts differ between instances anyway,
 * and keeping them would split "5 entries" and "8 entries" into two groups. Without
 * them the comparison is about which positions exist, not how many items.
 */
export function structurePaths(blocks: RawBlock[]): Set<string> {
  return new Set(blocks.map((block) => block.path.replace(/\.\d+/g, "")));
}

export function signatureOfPaths(paths: Set<string>): string {
  return contentHashOf([...paths].sort().join("|"));
}

export function structureSignature(blocks: RawBlock[]): string {
  return signatureOfPaths(structurePaths(blocks));
}

/**
 * Minimum punctuation density (marks per character) for a variable part to count as
 * prose. A weak "is there any punctuation" test, not a tunable precision knob: list
 * entries ("Ella", "27427 views") score 0, paragraphs score far above this.
 */
const PROSE_PUNCT_MIN = 0.015;
/** Lower bound of variable-part line length relative to the constant part; below it the variable is just a short field slotted into the template. */
const PROSE_LINE_RATIO = 0.6;

const linesOf = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);
const avgLineLen = (texts: string[]) => {
  const lines = texts.flatMap(linesOf);
  return lines.length ? lines.reduce((sum, line) => sum + line.length, 0) / lines.length : 0;
};
/** Common punctuation across Chinese, English, Japanese, Russian and Arabic. Used for "is this a sentence", not for tokenizing. */
const PUNCT = /[，。；？！：、,;?!:،؟।]/g;
const punctDensity = (texts: string[]) => {
  const chars = texts.reduce((sum, text) => sum + text.length, 0);
  if (!chars) return 0;
  const hits = texts.reduce((sum, text) => sum + (text.match(PUNCT) || []).length, 0);
  return hits / chars;
};

/**
 * Is any prose left on this page — the trigger for the third model call.
 *
 * The test is binary: does at least one remaining block qualify as prose? Yes → the
 * page explains itself, use the original text; none → what remains is enumerations,
 * labels and numbers, the page's value is "what it is for", and only then does the
 * model write a one-line description.
 *
 * Prose is defined the same way as in the cross-instance layer, reusing the same two
 * constants (has punctuation, lines not clearly shorter than the page's prose
 * baseline); no new threshold, and no guesswork like "is this an index page".
 */
export function hasProseBlock(blocks: RawBlock[], proseBaseline: number): boolean {
  return blocks.some((block) => {
    const text = block.text || "";
    if (!text) return false;
    const punct = punctDensity([text]);
    const lineLen = avgLineLen([text]);
    return punct >= PROSE_PUNCT_MIN && lineLen >= Math.max(1, proseBaseline) * PROSE_LINE_RATIO;
  });
}

/**
 * Aligns sibling instances of one template by structural position, separates constant
 * from variable, and decides whether the whole class holds data or knowledge.
 *
 * The point is that not every templated page is a data page: `/blog/{slug}` is a
 * template too, but what varies between instances is the whole article. The
 * discriminator is the shape of the variable part, compared against the constant part
 * of the same group — hence no constants carried across sites.
 */
export function analyzeTemplateGroup(instances: TemplateInstance[]): TemplateVerdict {
  const empty = { instances: instances.length, variantAvgLineLen: 0, constantAvgLineLen: 0, variantPunctDensity: 0, variantChars: 0 };
  if (instances.length < MIN_INSTANCES) {
    return { kind: "undetermined", reason: `只有 ${instances.length} 个实例，无对照物`, constantPaths: [], variantPaths: [], metrics: empty };
  }

  // Only compare positions present in every instance: differing counts are normal (optional sections, pagination).
  const byPath = instances.map((instance) => new Map(instance.blocks.map((block) => [block.path, block.text])));
  const sharedPaths = [...byPath[0].keys()].filter((path) => byPath.every((map) => map.has(path)));

  const constantPaths: string[] = [];
  const variantPaths: string[] = [];
  for (const path of sharedPaths) {
    const texts = byPath.map((map) => map.get(path) as string);
    (texts.every((text) => text === texts[0]) ? constantPaths : variantPaths).push(path);
  }

  if (!variantPaths.length) {
    return {
      kind: "undetermined",
      reason: "实例之间逐字相同，不构成模板判据",
      constantPaths, variantPaths,
      metrics: { ...empty, constantAvgLineLen: avgLineLen(constantPaths.map((path) => byPath[0].get(path) as string)) },
    };
  }

  const variantTexts = byPath.flatMap((map) => variantPaths.map((path) => map.get(path) as string));
  const constantTexts = constantPaths.map((path) => byPath[0].get(path) as string);
  const metrics = {
    instances: instances.length,
    variantAvgLineLen: avgLineLen(variantTexts),
    constantAvgLineLen: avgLineLen(constantTexts),
    variantPunctDensity: punctDensity(variantTexts),
    variantChars: variantTexts.reduce((sum, text) => sum + text.length, 0),
  };

  // Prose: must have punctuation, and lines must not be clearly shorter than the group's
  // constant part. Both conditions are relative to the group, not absolute — a nav-like
  // constant part is short, an intro-like one is long, and the ratio still holds.
  const hasSentences = metrics.variantPunctDensity >= PROSE_PUNCT_MIN;
  const longEnough = metrics.constantAvgLineLen === 0
    ? metrics.variantAvgLineLen > 0
    : metrics.variantAvgLineLen >= metrics.constantAvgLineLen * PROSE_LINE_RATIO;

  return hasSentences && longEnough
    ? { kind: "content", reason: "实例间变化的是成段散文，每篇都是知识", constantPaths, variantPaths, metrics }
    : { kind: "data", reason: "实例间只差短字段，整类判为数据页", constantPaths, variantPaths, metrics };
}

/**
 * Treatment of a content page: remove the template's constant positions, as found
 * across instances, from its body.
 *
 * More precise than the existing cross-page duplicate-line removal, which only drops
 * verbatim-identical lines seen on several pages; here the verdict is per structural
 * position — identical across siblings means template shell — independent of line
 * granularity and occurrence count.
 */
export function stripConstantBlocks(blocks: RawBlock[], constantPaths: string[]): RawBlock[] {
  const shell = new Set(constantPaths);
  return blocks.filter((block) => !shell.has(block.path));
}

/* ── Layer 4: cross-time stability ──────────────────────────────────── */

/**
 * One crawl's observation record: per-line checksums organized by structural position.
 *
 * It records what was actually seen, whether or not it was indexed. If the indexed text
 * were the baseline, a line dropped as dynamic would look new next time and be dropped
 * again — dropped once, dropped forever, with no way to self-correct. That is why this
 * record is stored separately from the indexed content.
 */
export type PageObservation = {
  /** Crawl time, used to compute the baseline interval. */
  at: string;
  /** Structural position → per-line checksums at that position. */
  lines: Record<string, string[]>;
  /**
   * The page's structural signature. Used by the crawl budget: on the next re-crawl,
   * near-duplicate pages whose URLs do not group (short Latin-name instance pages) can
   * be recognized as a family from last time's structure without rendering each again.
   */
  signature?: string;
};

export function observePage(blocks: RawBlock[], at: string): PageObservation {
  const lines: Record<string, string[]> = {};
  for (const block of blocks) lines[block.path] = linesOf(block.text).map(contentHashOf);
  return { at, lines, signature: structureSignature(blocks) };
}

export type TimeVerdict = {
  /** Structural position → line indices judged dynamic. */
  volatile: Record<string, number[]>;
  /** Milliseconds between this and the previous observation; null without a baseline. Stats must report it. */
  baselineIntervalMs: number | null;
  /** Number of earlier observations compared: 0 = first crawl, 1 = only "suspect", 2 = conclusive. */
  observationsCompared: number;
};

/**
 * Compares per position, per line; only lines that changed twice in a row are dynamic.
 *
 * A single change is a one-off edit (the site really changed a clause) and stable
 * afterwards; daily-updated content changes every time. This is the only reliable way
 * to tell them apart, at the cost of needing three observations for a verdict.
 *
 * No precondition — it does not look at how much of the page changed; each position is
 * judged independently. The earlier design's "most of the page unchanged" was a hidden
 * threshold and has been removed.
 */
export function timeLayerVerdict(
  current: PageObservation,
  previous?: PageObservation,
  beforePrevious?: PageObservation,
): TimeVerdict {
  const baselineIntervalMs = previous ? Date.parse(current.at) - Date.parse(previous.at) : null;
  const observationsCompared = (previous ? 1 : 0) + (beforePrevious ? 1 : 0);
  const volatile: Record<string, number[]> = {};
  if (!previous || !beforePrevious) return { volatile, baselineIntervalMs, observationsCompared };

  for (const [path, hashes] of Object.entries(current.lines)) {
    const prev = previous.lines[path];
    const older = beforePrevious.lines[path];
    if (!prev || !older) continue; // new position, no two observations to compare yet
    const changed: number[] = [];
    for (let index = 0; index < hashes.length; index += 1) {
      const changedNow = prev[index] !== undefined && hashes[index] !== prev[index];
      const changedThen = older[index] !== undefined && prev[index] !== older[index];
      if (changedNow && changedThen) changed.push(index);
    }
    if (changed.length) volatile[path] = changed;
  }
  return { volatile, baselineIntervalMs, observationsCompared };
}

/** Rebuilds the body per the layer-4 verdict: only dynamic lines are dropped, the rest of the block stays. */
export function applyTimeVerdict(blocks: RawBlock[], verdict: TimeVerdict): { blocks: RawBlock[]; droppedLines: number } {
  let droppedLines = 0;
  const kept = blocks.map((block) => {
    const volatileIndexes = verdict.volatile[block.path];
    if (!volatileIndexes?.length) return block;
    const lines = linesOf(block.text);
    const survivors = lines.filter((_, index) => !volatileIndexes.includes(index));
    droppedLines += lines.length - survivors.length;
    const text = survivors.join("\n");
    return { ...block, text, textLen: text.length, lineCount: survivors.length };
  });
  return { blocks: kept.filter((block) => block.text.length > 0), droppedLines };
}

/* ── Re-observation status and hint ─────────────────────────────────── */

/** A page's progress in the cross-time layer: how many observations remain before a verdict. */
export type PageTimeStatus = {
  url: string;
  /** Number of earlier observations compared: 0 = first crawl, 1 = not conclusive yet, 2+ = conclusive. */
  observationsCompared: number;
  baselineIntervalMs: number | null;
};

export type RecrawlHint = {
  /** Which stage the whole site is in. */
  stage: "first-crawl" | "needs-one-more" | "ready";
  /** Pages that need one more crawl before a verdict. */
  pagesNeedingMore: number;
  /**
   * Shortest baseline interval in minutes; only present when ready and the interval is short.
   *
   * Like stage and pagesNeedingMore it is **data**: the console renders the hint from it
   * in the current locale. `message` is kept for old data — stored crawl records only
   * have that Chinese sentence.
   */
  shortestIntervalMinutes?: number;
  /** Human-readable sentence. Chinese, as a fallback for old data and non-console readers. */
  message: string;
};

/**
 * The cross-time layer needs three observations for a verdict, and this repo has no
 * scheduler — re-crawls are triggered manually.
 *
 * So the state must be spelled out: without this hint, "no dynamic content detected"
 * reads as "there really is none", when the real reason is usually too few
 * observations. The hint only states status and next step; it never acts on its own.
 */
export function recrawlHint(statuses: PageTimeStatus[]): RecrawlHint {
  const pagesNeedingMore = statuses.filter((status) => status.observationsCompared < 2).length;
  if (!statuses.length || statuses.every((status) => status.observationsCompared === 0)) {
    return {
      stage: "first-crawl",
      pagesNeedingMore,
      message: "第一次采集，还没有可对比的记录。再采集一次，就能开始清除时效内容。",
    };
  }
  if (pagesNeedingMore > 0) {
    return {
      stage: "needs-one-more",
      pagesNeedingMore,
      message: `${pagesNeedingMore} 个页面只采集过一次，还看不出哪些是时效内容。再采集一次可清除更多。`,
    };
  }
  // Enough observations does not mean an accurate measurement. This layer only sees
  // change over periods as long as the baseline interval: two crawls ten minutes apart
  // never see daily content change, so "no dynamic content detected" — calling that
  // "working normally" would suggest the knowledge base is clean. Sufficiency is about
  // the interval, not the count.
  const intervals = statuses.map((status) => status.baselineIntervalMs).filter((value): value is number => typeof value === "number");
  const shortest = intervals.length ? Math.min(...intervals) : null;
  if (shortest !== null && shortest < 24 * 3600 * 1000) {
    const minutes = Math.max(1, Math.round(shortest / 60_000));
    const span = minutes >= 60 ? `${Math.round(minutes / 60)} 小时` : `${minutes} 分钟`;
    return {
      stage: "ready",
      pagesNeedingMore: 0,
      shortestIntervalMinutes: minutes,
      message: `两次采集只隔了 ${span}，只认得出这段时间里变过的内容。每天更新的内容，要隔一天以上再采集一次才清得掉。`,
    };
  }
  return {
    stage: "ready",
    pagesNeedingMore: 0,
    message: "每个页面都采集过多次、相邻两次相隔一天以上，时效内容能正常识别并清除。",
  };
}
