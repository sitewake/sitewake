import { sameSiteLanding } from "../console/site-addresses";

/**
 * The address a website actually serves.
 *
 * A bare domain that answers with a 301 to its www host. Everything that opens
 * the site in a browser — the preview that decides whether the code is
 * installed, the knowledge crawl — pins one origin and refuses a document that
 * lands on another, because following a redirect off the site is how a crawler
 * becomes an open proxy. Registered at the bare domain, such a site could
 * never be checked: the check reported "we cannot open this address" while a
 * visitor's browser had no trouble at all.
 *
 * A redirect within the same website (www, or a subdomain of the registered
 * domain — `sameSiteLanding`) is not a different site, so the address to keep is
 * where it lands. A redirect to another site is the operator's business and is
 * left alone; the readiness check reports it separately.
 */
export const SITE_ADDRESS_PROBE_TIMEOUT_MS = 8_000;

export async function resolveSiteAddress(
  url: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  let requested: URL;
  try {
    requested = new URL(url);
  } catch {
    return url;
  }
  if (!/^https?:$/u.test(requested.protocol)) return url;
  const call = options.fetchImpl || fetch;
  let landed: URL;
  try {
    const response = await call(requested.toString(), {
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs ?? SITE_ADDRESS_PROBE_TIMEOUT_MS),
      headers: { "user-agent": "SiteWake-Console-AddressCheck/1.0", accept: "text/html,*/*" },
    });
    // The body is never read: only where the request came to rest matters.
    await response.body?.cancel().catch(() => undefined);
    landed = new URL(response.url || requested.toString());
  } catch {
    // Unreachable right now, or too slow: keep what the operator gave us. The
    // address is checked again, with its own reporting, by the readiness probe.
    return url;
  }
  if (landed.origin === requested.origin) return url;
  if (!/^https?:$/u.test(landed.protocol)) return url;
  if (!sameSiteLanding(requested.origin, landed.origin)) return url;
  // Keep the path the operator chose when the redirect only moved the host.
  const kept = new URL(requested.pathname + requested.search, landed.origin);
  return landed.pathname === "/" && !landed.search ? kept.toString() : landed.toString();
}
