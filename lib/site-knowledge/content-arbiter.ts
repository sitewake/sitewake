/**
 * Orchestration of gray-zone arbitration and the page-level fallback.
 *
 * The verdict kernel (content-filter) decides by shape alone; two spots go to the LLM:
 *   1. gray blocks with exactly one vote — merged into one call per page;
 *   2. the fallback when a page keeps under 5% — dropped blocks are handed over with
 *      indices for the model to pick from.
 *
 * The model **picks indices only, produces no content**: the return value is number[],
 * and the text is always taken by index from the original blocks. This is guaranteed
 * by types and implementation, not by prompt — the model has no way to put generated
 * text into the knowledge base. Letting it output text would mean the store no longer
 * holds what is actually on the page.
 *
 * Call and orchestration are separate: judge is injected, so the orchestration is
 * fully testable with a fake model and degrades deterministically when the model is
 * unavailable.
 */
import { conservativeFilter, filterBlocks, type FilterResult, type PageFilterReport, type RawBlock } from "./content-filter";
import { urlTemplateFromUrl } from "./url-scene";

/** A batch of blocks for the model: index and text, nothing else. */
export type JudgeRequest = {
  url: string;
  /** gray: uncertain blocks, pick the keepers; fallback: the page is nearly filtered empty, pick what to rescue. */
  kind: "gray" | "fallback";
  blocks: Array<{ id: number; text: string }>;
};

/** The model returns only the indices to keep. null means unavailable this time (failure, timeout). */
export type Judge = (request: JudgeRequest) => Promise<number[] | null>;

export type ArbiterOptions = {
  judge?: Judge;
  /** Call cap per crawl. Beyond it the conservative rule applies and stats record it. */
  maxCalls?: number;
  /** Trigger line of the page-level fallback. */
  fallbackRatio?: number;
  maxChars?: number;
};

export type PageResolution = {
  /** Final body, verbatim from the page. */
  mainText: string;
  report: PageFilterReport;
  /**
   * The blocks finally kept. The caller decides "is any prose left" and needs the
   * blocks, not the joined text — joining loses block boundaries, and substring checks
   * on the body are slow and imprecise.
   */
  keptBlocks: RawBlock[];
};

const DEFAULT_MAX_CALLS = 24;
const DEFAULT_FALLBACK_RATIO = 0.05;

/**
 * One session per crawl: the call budget and per-URL-class verdicts hang on it, so a
 * site full of ranking pages pays one call on the first page and the rest reuse the verdict.
 */
export function createArbiterSession(options: ArbiterOptions = {}) {
  const judge = options.judge;
  const maxCalls = options.maxCalls ?? DEFAULT_MAX_CALLS;
  const fallbackRatio = options.fallbackRatio ?? DEFAULT_FALLBACK_RATIO;
  const maxChars = options.maxChars ?? 20_000;
  // Cached is "how to treat this URL class", not block indices — indices do not correspond across pages.
  const templateVerdicts = new Map<string, "empty" | "recover">();
  let calls = 0;

  const canCall = () => Boolean(judge) && calls < maxCalls;

  const assemble = (blocks: RawBlock[], keepIds: Set<number>) =>
    blocks.filter((block) => keepIds.has(block.id)).map((block) => block.text).join("\n").slice(0, maxChars);

  const reportOf = (
    url: string,
    result: FilterResult,
    extra: Pick<PageFilterReport, "fallbackTriggered" | "fallbackPath" | "llmUsed" | "emptyContentPage">,
  ): PageFilterReport => ({ ...result.stats, url, ...extra });

  return {
    /** Calls made so far, for stats and cap observation. */
    get callCount() { return calls; },

    async resolve(url: string, blocks: RawBlock[]): Promise<PageResolution> {
      if (!blocks.length) {
        const empty = filterBlocks([], { maxChars });
        return {
          mainText: "",
          report: reportOf(url, empty, { fallbackTriggered: false, fallbackPath: "none", llmUsed: false, emptyContentPage: true }),
          keptBlocks: [],
        };
      }

      // ── Step ⑥: count votes. Under 2 votes always keep — blocks the shape layer cannot
      // decide are not sent to the model but left to the cross-instance and cross-time
      // layers with their measured baselines (see add-crawl-comparison-layers). ──
      const base = filterBlocks(blocks, { undecidedPolicy: "keep", maxChars });
      const keepIds = new Set(base.verdicts.filter((verdict) => verdict.decision === "keep").map((verdict) => verdict.id));
      let llmUsed = false;

      const totalChars = blocks.reduce((sum, block) => sum + block.textLen, 0);
      const keptChars = blocks.filter((block) => keepIds.has(block.id)).reduce((sum, block) => sum + block.textLen, 0);
      const ratio = totalChars > 0 ? keptChars / totalChars : 0;

      // ── Step ⑨: page-level fallback. Under 5% kept has two opposite causes; tell them apart first. ──
      if (ratio >= fallbackRatio) {
        const resolved = filterBlocks(blocks.filter((block) => keepIds.has(block.id)), { maxChars });
        return {
          mainText: assemble(blocks, keepIds),
          report: reportOf(url, { ...base, stats: { ...base.stats, keptChars, keptRatio: ratio, droppedChars: totalChars - keptChars, keptAvgLineLen: resolved.stats.keptAvgLineLen, keptPunctDensity: resolved.stats.keptPunctDensity } },
            { fallbackTriggered: false, fallbackPath: "none", llmUsed, emptyContentPage: keptChars === 0 }),
          keptBlocks: blocks.filter((block) => keepIds.has(block.id)),
        };
      }

      // urlTemplateFromUrl returns a template object; its id is the stable key of the URL class.
      const template = urlTemplateFromUrl(url)?.id ?? url;
      const cached = templateVerdicts.get(template);

      // ── Step ⑩: hand dropped blocks with indices to the model; ask once per URL class. ──
      if (!cached && canCall()) {
        calls += 1;
        llmUsed = true;
        const rescued = await judge!({ url, kind: "fallback", blocks: base.dropped }).catch(() => null);
        if (rescued) {
          const valid = rescued.filter((id) => blocks.some((block) => block.id === id));
          templateVerdicts.set(template, valid.length ? "recover" : "empty");
          if (valid.length) {
            for (const id of valid) keepIds.add(id);
            const restored = assemble(blocks, keepIds);
            return {
              mainText: restored,
              report: reportOf(url, base, { fallbackTriggered: true, fallbackPath: "llm", llmUsed: true, emptyContentPage: restored.length === 0 }),
              keptBlocks: blocks.filter((block) => keepIds.has(block.id)),
            };
          }
          // Nothing picked: the page has no body. Structure still goes into the structure store.
          return {
            mainText: "",
            report: reportOf(url, base, { fallbackTriggered: true, fallbackPath: "llm", llmUsed: true, emptyContentPage: true }),
            keptBlocks: [],
          };
        }
      }

      if (cached === "empty") {
        return {
          mainText: "",
          report: reportOf(url, base, { fallbackTriggered: true, fallbackPath: "llm", llmUsed, emptyContentPage: true }),
          keptBlocks: [],
        };
      }

      // ── Fallback path: model unavailable, cap exceeded, or the URL class was judged
      // "needs rescue" before. ── Drop only blocks clearly in header / nav / sidebar /
      // footer, keep everything else. One pass, no iteration.
      const conservative = conservativeFilter(blocks, { maxChars });
      return {
        mainText: conservative.mainText,
        report: reportOf(url, conservative, {
          fallbackTriggered: true,
          fallbackPath: "conservative",
          llmUsed,
          emptyContentPage: conservative.mainText.length === 0,
        }),
        keptBlocks: blocks.filter((block) => !["header", "nav", "aside", "footer"].includes(block.region)),
      };
    },
  };
}
