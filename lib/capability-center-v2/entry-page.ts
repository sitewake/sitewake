import type { CapabilityContract, JsonValue } from "./model";

function decoded(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

/**
 * Whether an address contains a written part of one, the way the Contract's
 * conditions mean it. A path is looked for in the path: "/shop" is inside
 * "https://shop.example/" as text, on a page that is not the shop. Both sides
 * are also compared decoded: the browser shows `category=出行` percent-encoded
 * while the condition was written with the visible text.
 */
export function capabilityUrlHas(url: string, expected: string) {
  let haystack = url;
  if (expected.startsWith("/")) {
    try { const parsed = new URL(url); haystack = `${parsed.pathname}${parsed.search}${parsed.hash}`; } catch { /* compare the text as written */ }
  }
  return [haystack, decoded(haystack)].some((candidate) => [expected, decoded(expected)].some((needle) => candidate.includes(needle)));
}

function requiredUrlParts(contract: Pick<CapabilityContract, "preconditions">) {
  return (contract.preconditions || []).flatMap((raw: JsonValue) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const condition = raw as Record<string, JsonValue>;
    return condition.type === "urlIncludes" && typeof condition.value === "string" && condition.value.trim() ? [condition.value.trim()] : [];
  });
}

function scopePatterns(contract: Pick<CapabilityContract, "scope">) {
  const scope = contract.scope;
  if (!scope || scope.kind === "site-global") return [];
  return (scope.match?.urlPatterns || []).filter((pattern): pattern is string => typeof pattern === "string" && Boolean(pattern.trim()));
}

/**
 * An address written as a whole URL, a path, or a URL without its scheme; a
 * query fragment is not one, and neither is a pattern. A category scope
 * written with a wildcard segment (the category's slug as a star) was opened
 * as that very address: the site answered with its index, and every draft of
 * "cheapest book in a category" started on a page with no category on it.
 */
function addressFor(written: string, site: URL) {
  if (/[{}*]/.test(written)) return undefined;
  try {
    if (/^https?:\/\//i.test(written)) return new URL(written);
    if (written.startsWith("/")) return new URL(written, site.origin);
    if (written.toLowerCase().startsWith(`${site.host.toLowerCase()}/`)) return new URL(`${site.protocol}//${written}`);
  } catch { /* not an address */ }
  return undefined;
}

/** Whether a page meets the address conditions the Contract puts on where it starts. */
export function capabilityPageSatisfied(contract: Pick<CapabilityContract, "preconditions" | "scope">, url: string) {
  const patterns = scopePatterns(contract);
  return requiredUrlParts(contract).every((part) => capabilityUrlHas(url, part))
    && (!patterns.length || patterns.some((pattern) => capabilityUrlHas(url, pattern)));
}

/**
 * The fixed page a capability must start on, as an address on the visitor's
 * site, or undefined when its Contract names none.
 *
 * "Find dimmable lamps" was bound to /shop and its program was published to
 * start on the home page it was explored from. A visitor asking on the home
 * page was refused, and validation, starting where the program said, failed
 * every case on the Contract's own precondition. The Contract is what says
 * where a capability runs, so every caller starts it here: authoring, draft
 * and validation replays, and the visitor's browser.
 */
export function capabilityEntryPage(contract: Pick<CapabilityContract, "preconditions" | "scope"> | undefined, siteUrl: string | undefined) {
  if (!contract || !siteUrl) return undefined;
  let site: URL;
  try { site = new URL(siteUrl); } catch { return undefined; }
  for (const written of [...requiredUrlParts(contract), ...scopePatterns(contract)]) {
    const address = addressFor(written, site);
    if (address && address.origin === site.origin && capabilityPageSatisfied(contract, address.href)) return address.href;
  }
  return undefined;
}

/**
 * Where a capability runs for a visitor on `currentUrl`, and the program entry
 * that gets it there: the current page when it already qualifies, otherwise
 * the entry page. `entry` is undefined when the Contract binds no page and the
 * program's own entry stands.
 */
export function capabilityRunPage(contract: Pick<CapabilityContract, "preconditions" | "scope"> | undefined, currentUrl: string | undefined) {
  const entryPage = capabilityEntryPage(contract, currentUrl);
  if (!contract || !entryPage || !currentUrl) return { url: currentUrl, entry: undefined };
  if (capabilityPageSatisfied(contract, currentUrl)) return { url: currentUrl, entry: { mode: "CurrentPage" as const } };
  return { url: entryPage, entry: { mode: "Navigate" as const, url: entryPage } };
}
