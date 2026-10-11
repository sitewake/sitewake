/**
 * The addresses one website answers at.
 *
 * One website is one domain. The apex and the www name, and any other host
 * under the same domain, are the same website; a different domain is another
 * website, registered as such. The handshake and the install check both
 * compare this way, so nobody has to know that "www" counts — the earlier
 * design made every host its own address and asked the operator to list them,
 * and the list was the first thing readers did not understand.
 *
 * Scheme and port still matter, as a browser makes them matter: an http page
 * is not the https site, and a port is a different server.
 */
export type SiteAddressRejection = { value: string; reason: "malformed" | "unsupported-scheme" };

/** Normalizes a list a person typed into the origins the handshake will compare. */
export function normalizeSiteAddresses(values: readonly string[]) {
  const origins: string[] = [];
  const rejected: SiteAddressRejection[] = [];
  for (const raw of values) {
    const value = String(raw || "").trim();
    if (!value) continue;
    let url: URL;
    try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`); }
    catch { rejected.push({ value, reason: "malformed" }); continue; }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      rejected.push({ value, reason: "unsupported-scheme" });
      continue;
    }
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  return { origins, rejected };
}

/** The host with a leading `www.` removed: the name the domain is known by. */
function domainOf(host: string) {
  return host.toLowerCase().replace(/^www\./u, "");
}

/**
 * May a page at `pageOrigin` act for the website registered at `registeredOrigin`?
 *
 * Exactly, because this is an authority question. A registered origin is an
 * administrator naming one address; a subdomain, a `www` alias and a different
 * port are different addresses and have to be named separately. Nothing observed
 * at runtime widens this — see the comment above the same decision in
 * `db/agent-run-store.ts`, which is the one this has to agree with.
 */
export function registeredOriginMatches(registeredOrigin: string, pageOrigin: string) {
  let registered: URL;
  let page: URL;
  try { registered = new URL(registeredOrigin); page = new URL(pageOrigin); } catch { return false; }
  return registered.origin === page.origin;
}

/** Does any registered origin admit this page? The path is not part of the answer. */
export function originIsRegistered(origins: readonly string[], pageUrl: string) {
  let origin: string;
  try { origin = new URL(pageUrl).origin; } catch { return false; }
  return origins.some((registered) => registeredOriginMatches(registered, origin));
}

/**
 * Did a running task land on a page still inside the same website?
 *
 * Same-site, because this is not an authority question. It decides whether a
 * navigation destination counts as "still here" for the purpose of rewriting the
 * landing URL, and a task that walks from a site to its own subdomain has not
 * left the site. It grants nothing.
 *
 * This used to be one function with `registeredOriginMatches` under the name
 * `sameSite`, and the two authority callers therefore got the lenient answer:
 * an unregistered subdomain passed the connection check and then had its task
 * rejected by `agent-run-store`. The names are separate so that a reader can see
 * which question a call site is asking, and so nobody gets the lenient one by
 * default.
 */
export function sameSiteLanding(fromOrigin: string, landedOrigin: string) {
  let from: URL;
  let landed: URL;
  try { from = new URL(fromOrigin); landed = new URL(landedOrigin); } catch { return false; }
  if (from.protocol !== landed.protocol || from.port !== landed.port) return false;
  const domain = domainOf(from.hostname);
  const host = domainOf(landed.hostname);
  return host === domain || host.endsWith(`.${domain}`);
}
