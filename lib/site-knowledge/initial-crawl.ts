/**
 * Seed derivation for the first-connection auto crawl. Consistent with the console's
 * "read now": start from the entry URL if it shares the handshake origin, otherwise from
 * the page that handshook — the page the widget connected from at least really exists.
 * The return value is `CrawlJob.seeds` directly; the caller takes the host from the
 * handshake origin.
 */
export function initialCrawlSeeds(handshakeUrl: string, entryUrl?: string): string[] {
  let handshake: URL;
  try {
    handshake = new URL(handshakeUrl);
  } catch {
    return [];
  }
  if (entryUrl) {
    try {
      const entry = new URL(entryUrl);
      if (entry.origin === handshake.origin) return [entry.toString()];
    } catch {
      /* an invalid registered entry URL counts as none */
    }
  }
  return [handshake.toString()];
}
