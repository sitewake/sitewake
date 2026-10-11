const HEADER_NAME = "x-sitewake-crawl-token";

type CrawlAuthorizationEnvironment = {
  [key: string]: string | undefined;
  SITEWAKE_CRAWL_SHARED_TOKEN?: string;
  SITEWAKE_CRAWL_AUTH_ORIGINS?: string;
};

function normalizedOrigin(value: string) {
  try {
    const url = new URL(value.trim());
    if (!/^https:$/.test(url.protocol) || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Returns a server-only crawl credential for an explicitly approved HTTPS
 * origin. The caller must never attach this header to cross-origin resources.
 */
export function crawlAuthorizationHeaders(
  origin: string,
  environment: CrawlAuthorizationEnvironment = process.env,
): Record<string, string> {
  const requestedOrigin = normalizedOrigin(origin);
  const token = environment.SITEWAKE_CRAWL_SHARED_TOKEN?.trim() || "";
  const approvedOrigins = new Set(
    (environment.SITEWAKE_CRAWL_AUTH_ORIGINS || "")
      .split(",")
      .map(normalizedOrigin)
      .filter((value): value is string => Boolean(value)),
  );
  if (!requestedOrigin || token.length < 32 || !approvedOrigins.has(requestedOrigin)) return {};
  return { [HEADER_NAME]: token };
}

export const crawlAuthorizationHeaderName = HEADER_NAME;
