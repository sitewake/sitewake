import type { CrawlJobLimits } from "./protocol";

const CRAWL_LIMIT_BOUNDS = {
  maxRenders: { minimum: 1, maximum: 300 },
  maxPerTemplate: { minimum: 1, maximum: 10 },
  adaptiveStopAfter: { minimum: 1, maximum: 100 },
  maxDepth: { minimum: 0, maximum: 12 },
} as const;

export function validateCrawlJobLimits(value: unknown): CrawlJobLimits | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("crawl_limits_invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) =>
    !(key in CRAWL_LIMIT_BOUNDS))) {
    throw new Error("crawl_limits_invalid");
  }
  const limits: CrawlJobLimits = {};
  for (const [key, bounds] of Object.entries(CRAWL_LIMIT_BOUNDS) as Array<
    [keyof CrawlJobLimits, { minimum: number; maximum: number }]
  >) {
    const candidate = record[key];
    if (candidate === undefined) continue;
    if (!Number.isSafeInteger(candidate)
      || (candidate as number) < bounds.minimum
      || (candidate as number) > bounds.maximum) {
      throw new Error(`crawl_limit_invalid:${key}`);
    }
    limits[key] = candidate as number;
  }
  return limits;
}
