import { registeredOriginMatches } from "./site-addresses";
/**
 * Everything that decides whether the snippet the console hands out can work
 * on the reader's website, judged once — before they paste it — instead of
 * after detection has failed with "the code is not on the page".
 *
 * The SDK makes four cross-origin requests from a visitor's page: it loads
 * `/sitewake.js` (and `/sitewake-adaptive.js`), imports capability modules
 * (also scripts), calls `/api/...`, and loads the brand mark. So a site's own
 * Content-Security-Policy must allow this origin for `script-src`,
 * `connect-src` and (cosmetically) `img-src`, and a browser must be willing to
 * load the SDK at all: an https page refuses a plain-http subresource.
 *
 * CORS is not part of this: the control plane answers `*` and the SDK sends no
 * credentials, so no combination of addresses fails on CORS alone.
 */

export type CspDirectives = Map<string, string[]>;

export type CspFinding = {
  /** Where the policy came from; a page can carry both. */
  source: "header" | "meta" | "header-and-meta";
  /** Directives that do not admit the control plane, in the order they matter. */
  missing: CspDirective[];
};

export type CspDirective = "script-src" | "connect-src" | "img-src" | "style-src";

export type InstallReadiness = {
  /** The address the console holds for the site. */
  siteUrl: string;
  /** Where that address actually lands (a site may redirect to www or https). */
  finalUrl?: string;
  /** The site could not be loaded from the control plane at all. */
  unreachable?: { reason: "network" | "certificate" | "status"; detail: string };
  /** The page lives at another origin than the one registered for this site. */
  originMismatch?: { registered: string; actual: string };
  /** The site's own policy does not admit this control plane. */
  csp?: CspFinding;

};

export function parseCsp(policy: string): CspDirectives {
  const directives: CspDirectives = new Map();
  for (const part of policy.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const name = tokens.shift()?.toLowerCase();
    if (!name || directives.has(name)) continue;
    directives.set(name, tokens);
  }
  return directives;
}

/**
 * Whether a policy admits one origin for one directive, with the fallback
 * chain a browser uses (`script-src-elem` → `script-src` → `default-src`).
 * Unknown-but-permissive sources (`*`, the matching scheme, a host pattern)
 * count; `'self'` never does, because the control plane is another origin.
 */
export function cspAllowsOrigin(directives: CspDirectives, directive: CspDirective, origin: string): boolean {
  // The element-level directives come first where they exist: a browser checks
  // `script-src-elem` / `style-src-elem` before falling back (measured in
  // tests/csp-request-inventory.test.mjs).
  const chain = directive === "script-src"
    ? ["script-src-elem", "script-src", "default-src"]
    : directive === "style-src"
      ? ["style-src-elem", "style-src", "default-src"]
      : [directive, "default-src"];
  const applicable = chain.map((name) => directives.get(name)).find((sources) => sources !== undefined);
  // No policy for this directive and no default: the browser allows it.
  if (!applicable) return true;
  let url: URL;
  try { url = new URL(origin); } catch { return true; }
  return applicable.some((raw) => {
    const source = raw.replace(/^'(.*)'$/, "$1").toLowerCase();
    if (source === "*") return true;
    if (source === "self" || source === "none" || source.startsWith("nonce-") || source.startsWith("sha")) return false;
    if (source === "https:" || source === "http:") return `${source.slice(0, -1)}:` === url.protocol;
    if (source === "data:" || source === "blob:") return false;
    let candidate: URL;
    try { candidate = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(source) ? source : `${url.protocol}//${source}`); }
    catch { return false; }
    if (candidate.protocol !== url.protocol && /^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return false;
    if (candidate.port && candidate.port !== url.port) return false;
    // A leading `*.` matches subdomains only, as in the CSP grammar.
    if (candidate.hostname.startsWith("*.")) return url.hostname.endsWith(candidate.hostname.slice(1));
    return candidate.hostname === url.hostname;
  });
}

/** The `<meta http-equiv="content-security-policy">` a page may carry instead of a header. */
export function cspFromHtml(html: string): string | undefined {
  const meta = html.match(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/i)?.[0];
  return meta?.match(/content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i)?.slice(1).find(Boolean);
}

/** Loopback, as a browser classifies it. */
function loopback(host: string) {
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/**
 * Addresses a browser treats as the local network: loopback, the private IPv4
 * ranges, and the names given to machines on a LAN. A page on the public
 * internet may not reach them, so a console living there can only serve sites
 * that are themselves local.
 */
export function localAddress(host: string) {
  if (loopback(host)) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts;
  return first === 10
    || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254);
}

/** The order a reader fixes them in: nothing loads without script-src. */
const DIRECTIVE_ORDER: CspDirective[] = ["script-src", "connect-src", "img-src"];

export function assessInstallReadiness(input: {
  siteUrl: string;
  sdkOrigin: string;
  finalUrl?: string;
  cspHeader?: string | null;
  html?: string;
  headers?: Array<[string, string]>;
  unreachable?: InstallReadiness["unreachable"];
}): InstallReadiness {
  const readiness: InstallReadiness = { siteUrl: input.siteUrl };
  if (input.unreachable) readiness.unreachable = input.unreachable;
  let site: URL | undefined;
  let sdk: URL | undefined;
  try { site = new URL(input.finalUrl || input.siteUrl); } catch { /* an unusable address is reported by the caller */ }
  try { sdk = new URL(input.sdkOrigin); } catch { /* same */ }
  if (input.finalUrl) readiness.finalUrl = input.finalUrl;

  if (site && input.finalUrl) {
    let registered: URL | undefined;
    try { registered = new URL(input.siteUrl); } catch { /* reported elsewhere */ }
    if (registered && !registeredOriginMatches(registered.origin, site.origin)) {
      readiness.originMismatch = { registered: registered.origin, actual: site.origin };
    }
  }
  const metaPolicy = input.html ? cspFromHtml(input.html) : undefined;
  const policies = [
    input.cspHeader ? { source: "header" as const, policy: input.cspHeader } : undefined,
    metaPolicy ? { source: "meta" as const, policy: metaPolicy } : undefined,
  ].filter(Boolean) as Array<{ source: "header" | "meta"; policy: string }>;
  if (policies.length && sdk) {
    // Several policies all apply: a resource must pass every one of them.
    const missing = DIRECTIVE_ORDER.filter((directive) =>
      policies.some(({ policy }) => !cspAllowsOrigin(parseCsp(policy), directive, sdk!.origin)));
    if (missing.length) {
      readiness.csp = {
        source: policies.length === 2 ? "header-and-meta" : policies[0].source,
        missing,
      };
    }
  }
  return readiness;
}

/** Is there anything the reader has to know before pasting the snippet? */
export function installReadinessBlocked(readiness: InstallReadiness) {
  return Boolean(readiness.csp || readiness.originMismatch || readiness.unreachable);
}
