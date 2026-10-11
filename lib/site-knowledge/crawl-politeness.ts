/**
 * Crawl politeness: robots.txt parsing/enforcement, a rate limiter, and the
 * identifiable User-Agent. Borrows crawl4ai's "respect robots + throttle"
 * defaults. Kept deliberately conservative — the deploy host has ~1.9GB RAM and
 * a single Chromium stack, and we are crawling *customer* sites.
 */

export const DEFAULT_UA = "SiteWakeBot/1.0 (+https://sitewake.ai; onboarding site knowledge crawler)";

export type RobotsRules = {
  /** Path prefixes (with optional `*`/`$`) disallowed for our agent group. */
  disallow: string[];
  allow: string[];
  sitemaps: string[];
  crawlDelayMs?: number;
};

const EMPTY_RULES: RobotsRules = { disallow: [], allow: [], sitemaps: [] };

/**
 * Minimal robots.txt parser. Picks the most specific matching group for
 * `userAgentToken` (case-insensitive substring), else the `*` group. Records
 * Allow/Disallow/Crawl-delay/Sitemap directives.
 */
export function parseRobots(text: string, userAgentToken = "sitewakebot"): RobotsRules {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/#.*$/, "").trim()).filter(Boolean);
  const groups: Array<{ agents: string[]; disallow: string[]; allow: string[]; crawlDelayMs?: number }> = [];
  const sitemaps: string[] = [];
  let current: (typeof groups)[number] | null = null;
  let expectingAgent = false;
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "sitemap") { if (value) sitemaps.push(value); continue; }
    if (field === "user-agent") {
      if (!current || !expectingAgent) { current = { agents: [], disallow: [], allow: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      expectingAgent = true;
      continue;
    }
    expectingAgent = false;
    if (!current) { current = { agents: ["*"], disallow: [], allow: [] }; groups.push(current); }
    if (field === "disallow") { if (value) current.disallow.push(value); else current.disallow = []; }
    else if (field === "allow") current.allow.push(value);
    else if (field === "crawl-delay") { const seconds = Number(value); if (Number.isFinite(seconds) && seconds > 0) current.crawlDelayMs = seconds * 1000; }
  }
  const token = userAgentToken.toLowerCase();
  const specific = groups.find((group) => group.agents.some((agent) => agent !== "*" && token.includes(agent)));
  const wildcard = groups.find((group) => group.agents.includes("*"));
  const chosen = specific || wildcard;
  if (!chosen) return { ...EMPTY_RULES, sitemaps };
  return { disallow: chosen.disallow, allow: chosen.allow, sitemaps, crawlDelayMs: chosen.crawlDelayMs };
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const anchored = escaped.endsWith("\\$") ? `${escaped.slice(0, -2)}$` : escaped;
  return new RegExp(`^${anchored}`);
}

/** robots.txt precedence: the longest matching rule wins; Allow beats Disallow on ties. */
export function robotsAllows(rules: RobotsRules, url: string): boolean {
  let path: string;
  try { const parsed = new URL(url); path = parsed.pathname + parsed.search; } catch { return true; }
  const match = (patterns: string[]) => patterns
    .map((pattern) => ({ pattern, length: pattern.replace(/[*$]/g, "").length, hit: patternToRegExp(pattern).test(path) }))
    .filter((entry) => entry.hit)
    .sort((left, right) => right.length - left.length)[0]?.length ?? -1;
  const allow = match(rules.allow);
  const disallow = match(rules.disallow);
  if (disallow === -1) return true;
  return allow >= disallow;
}

/** Serializes work to a minimum interval + a concurrency cap. */
export class RateLimiter {
  private nextAt = 0;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly minIntervalMs: number, private readonly maxConcurrent = 2) {}

  async acquire(now: () => number = () => Date.now(), sleep: (ms: number) => Promise<void> = defaultSleep): Promise<void> {
    while (this.active >= this.maxConcurrent) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    const wait = Math.max(0, this.nextAt - now());
    this.nextAt = Math.max(this.nextAt, now()) + this.minIntervalMs;
    if (wait > 0) await sleep(wait);
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.();
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
