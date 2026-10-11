/**
 * Sitemap-first URL seeding for the onboarding crawler (borrows crawl4ai's
 * AsyncUrlSeeder idea). Reads sitemap.xml — including sitemap-index and nested
 * sitemaps — to obtain a site's URL inventory *before* rendering anything, so
 * the site-map tree can appear almost immediately. The frontier falls back to
 * entry-link traversal when no sitemap is available.
 */
import { DEFAULT_UA } from "./crawl-politeness";

export type SitemapSeedResult = {
  urls: string[];
  /** Which sitemap documents were actually read. */
  sitemapUrls: string[];
  source: "sitemap" | "empty";
};

export type FetchText = (url: string) => Promise<{ ok: boolean; status: number; text: string } | null>;

const LOC_RE = /<loc>\s*([^<\s][\s\S]*?)\s*<\/loc>/gi;

function decodeXmlEntities(value: string): string | null {
  let invalidNumericEntity = false;
  const decoded = value
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (entity, hex: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hex || decimal || "", hex ? 16 : 10);
      const valid = Number.isInteger(codePoint)
        && codePoint >= 0
        && codePoint <= 0x10ffff
        && (codePoint < 0xd800 || codePoint > 0xdfff);
      if (!valid) {
        invalidNumericEntity = true;
        return entity;
      }
      return String.fromCodePoint(codePoint);
    });
  return invalidNumericEntity ? null : decoded;
}

function extractLocs(xml: string, limit: number): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(LOC_RE)) {
    if (out.length >= limit) break;
    const raw = match[1].trim();
    if (!raw) continue;
    const decoded = decodeXmlEntities(raw);
    if (decoded) out.push(decoded);
  }
  return out;
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

export function candidateSitemapUrls(origin: string): string[] {
  const base = new URL(origin);
  if (base.username || base.password || !/^https?:$/.test(base.protocol)) return [];
  return ["/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml"].map((path) => new URL(path, base).toString());
}

function sameOriginUrl(raw: string, origin: string, base?: string): string | null {
  try {
    const parsed = new URL(raw, base);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.origin !== origin) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Fetch text while validating every redirect hop before the next request. */
export async function fetchSameOriginText(
  url: string,
  origin: string,
  options: {
    fetchImpl?: typeof fetch;
    maxRedirects?: number;
    timeoutMs?: number;
    maxBytes?: number;
    signal?: AbortSignal;
  } = {},
): ReturnType<FetchText> {
  options.signal?.throwIfAborted();
  let expectedOrigin: string;
  try {
    const parsed = new URL(origin);
    if (parsed.username || parsed.password || !/^https?:$/.test(parsed.protocol)) return null;
    expectedOrigin = parsed.origin;
  } catch {
    return null;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBytes = Math.max(1, options.maxBytes ?? 2_000_000);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("crawl_fetch_timeout")),
    Math.max(1, options.timeoutMs ?? 10_000),
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let current = sameOriginUrl(url, expectedOrigin);
  if (!current) {
    clearTimeout(timeout);
    return null;
  }
  try {
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const response = await fetchImpl(current, {
        redirect: "manual",
        headers: { "user-agent": DEFAULT_UA },
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location || redirectCount === maxRedirects) return null;
        current = sameOriginUrl(location, expectedOrigin, current);
        if (!current) return null;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, status: response.status, text: "" };
      }
      const contentLength = Number(response.headers.get("content-length") || "0");
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!response.body) return { ok: true, status: response.status, text: "" };
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel("crawl_fetch_too_large").catch(() => undefined);
          return null;
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      return { ok: true, status: response.status, text };
    }
  } catch {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("crawl_fetch_aborted");
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
  return null;
}

export async function seedFromSitemap(
  origin: string,
  options: {
    fetchText?: FetchText;
    maxUrls?: number;
    maxSitemaps?: number;
    robotsSitemaps?: string[];
    signal?: AbortSignal;
  } = {},
): Promise<SitemapSeedResult> {
  options.signal?.throwIfAborted();
  const maxUrls = options.maxUrls ?? 5000;
  const maxSitemaps = options.maxSitemaps ?? 50;
  let allowedOrigin: string;
  try {
    const parsed = new URL(origin);
    if (parsed.username || parsed.password || !/^https?:$/.test(parsed.protocol)) throw new Error("invalid");
    allowedOrigin = parsed.origin;
  } catch {
    return { urls: [], sitemapUrls: [], source: "empty" };
  }
  const fetchText = options.fetchText ?? ((url) => fetchSameOriginText(
    url,
    allowedOrigin,
    { signal: options.signal },
  ));
  const seen = new Set<string>();
  const urls = new Set<string>();
  const readSitemaps: string[] = [];
  const queue = [...(options.robotsSitemaps ?? []), ...candidateSitemapUrls(allowedOrigin)]
    .map((value) => sameOriginUrl(value, allowedOrigin))
    .filter((value): value is string => Boolean(value))
    .slice(0, maxSitemaps);

  while (queue.length && readSitemaps.length < maxSitemaps && urls.size < maxUrls) {
    options.signal?.throwIfAborted();
    const sitemapUrl = queue.shift()!;
    if (seen.has(sitemapUrl)) continue;
    seen.add(sitemapUrl);
    const result = await fetchText(sitemapUrl);
    options.signal?.throwIfAborted();
    if (!result || !result.ok || !result.text) continue;
    readSitemaps.push(sitemapUrl);
    let locs: string[];
    const index = isSitemapIndex(result.text);
    const remaining = index
      ? Math.max(0, maxSitemaps - seen.size - queue.length)
      : Math.max(0, maxUrls - urls.size);
    try {
      locs = extractLocs(result.text, remaining);
    } catch {
      // A damaged sitemap is an optional seed source, not a reason to fail the
      // whole crawl. Frontier traversal can continue from the entry URL.
      continue;
    }
    if (index) {
      for (const loc of locs) {
        if (seen.size + queue.length >= maxSitemaps) break;
        const nested = sameOriginUrl(loc, allowedOrigin, sitemapUrl);
        if (nested && !seen.has(nested)) queue.push(nested);
      }
    } else {
      for (const loc of locs) {
        if (urls.size >= maxUrls) break;
        const pageUrl = sameOriginUrl(loc, allowedOrigin, sitemapUrl);
        if (pageUrl) urls.add(pageUrl);
      }
    }
  }
  return { urls: [...urls], sitemapUrls: readSitemaps, source: urls.size ? "sitemap" : "empty" };
}
