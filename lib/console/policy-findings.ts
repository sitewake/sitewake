import type { PolicyViolation } from "../site-knowledge/protocol";
import { CSP_REQUEST_INVENTORY, governingDirective, type CspRequestKind } from "./csp-request-inventory";
import { cspAllowsOrigin, parseCsp, type CspDirective } from "./install-readiness";

/**
 * Turning what the browser refused into what the reader has to change.
 *
 * Two measured facts shape everything here
 * (tests/csp-request-inventory.test.mjs):
 *
 *  - A browser names the directive that GOVERNS a request in both fields of
 *    the violation, even when `default-src` is what actually matched. So the
 *    directive to extend is worked out from the policy text the event carries,
 *    never from those names.
 *  - A policy marked report-only reports and blocks nothing. It must not be
 *    presented as something to fix.
 *
 * The patch never touches `default-src`: widening it would admit every kind of
 * resource site-wide. It adds the specific directive instead, carrying over
 * what `default-src` allowed so the site's own resources keep working.
 *
 * One more thing the measurement cannot see on its own: a refused script never
 * runs, so the requests it would have made are never attempted and never
 * refused. Reporting only what was observed would walk a reader around the
 * loop once per directive. So the browser decides WHETHER this policy blocks
 * SiteWake, and the policy text — which the violation carries — decides the
 * COMPLETE set of directives that have to change.
 */

export type PolicyFinding = {
  kind: CspRequestKind;
  blocked: boolean;
  /** The directive the browser named, when it refused this kind. */
  directive?: string;
  disposition?: "enforce" | "report";
};

/** One directive the patch touches, as a person would describe the edit. */
export type PolicyEdit = {
  directive: string;
  /** What has to be admitted there: the console's origin. */
  add: string;
  /** False when the directive is not in the policy and has to be written out in full. */
  present: boolean;
  /** The directive's complete source list after the edit, for a directive being added. */
  sources: string[];
};

export type PolicyPatch = {
  /** The policy exactly as the site sends it today. */
  before: string;
  /** The same policy with the console's origin admitted. */
  after: string;
  /** Directives the patch adds or extends, in the order they appear. */
  directives: string[];
  /**
   * The same change stated one directive at a time. A real policy runs to
   * several kilobytes, and printing it whole tells a reader nothing about what
   * actually has to change.
   */
  edits: PolicyEdit[];
  /** Where this policy came from, when the page made it knowable. */
  source?: "header" | "meta";
  /**
   * The policy hands trust to nonces only: an allowlisted origin is ignored
   * for scripts, so the way in is the page's nonce (or dropping the keyword).
   */
  strictDynamic: boolean;
};

export type PolicyVerdict = {
  /** `measured` came from a browser; `inferred` from reading the policy text. */
  source: "measured" | "inferred";
  findings: PolicyFinding[];
  /** Is anything actually blocked (report-only does not count)? */
  blocked: boolean;
  patches: PolicyPatch[];
};

/** The request kind a violation belongs to, by the directive the browser named. */
export function violationKind(violation: PolicyViolation): CspRequestKind | undefined {
  const directive = violation.effectiveDirective || violation.violatedDirective;
  const entry = CSP_REQUEST_INVENTORY.find((item) => item.effectiveDirective === directive)
    || CSP_REQUEST_INVENTORY.find((item) => item.fallback.includes(directive));
  return entry?.kind;
}

/** The directive that governs each kind, for checking a policy text directly. */
const DIRECTIVE_OF: Record<CspRequestKind, CspDirective> = {
  script: "script-src",
  "capability-module": "script-src",
  api: "connect-src",
  style: "style-src",
  image: "img-src",
};

/** Every kind this policy would refuse, whether or not it was reached today. */
function kindsNotAdmitted(policy: string, origin: string) {
  const parsed = parseCsp(policy);
  const kinds = [...new Set(CSP_REQUEST_INVENTORY.map((entry) => entry.kind))];
  return kinds.filter((kind) => !cspAllowsOrigin(parsed, DIRECTIVE_OF[kind], origin));
}

/** Only what the console itself serves; a site's own violations are not ours to report. */
export function ourViolations(violations: readonly PolicyViolation[], consoleOrigin: string) {
  let origin = "";
  try { origin = new URL(consoleOrigin).origin; } catch { return []; }
  return violations.filter((violation) => {
    if (violation.blockedUrl.startsWith(origin)) return true;
    // A refused inline style names no address; it is ours only when SiteWake
    // still injects one, which it must not (see csp-request-inventory).
    return false;
  });
}

/**
 * What the browser did, per request kind, plus the exact policy changes that
 * would admit the console. `violations` is what it reported while the page was
 * open; `consoleOrigin` is the address that has to be allowed.
 */
export function policyVerdictFromViolations(input: {
  violations: readonly PolicyViolation[];
  consoleOrigin: string;
}): PolicyVerdict {
  const ours = ourViolations(input.violations, input.consoleOrigin);
  const findings: PolicyFinding[] = [];
  const enforcing = new Map<string, { policy: string; source?: "header" | "meta"; kinds: Set<CspRequestKind> }>();

  for (const kind of new Set(CSP_REQUEST_INVENTORY.map((entry) => entry.kind))) {
    const hits = ours.filter((violation) => violationKind(violation) === kind);
    const blocking = hits.find((violation) => violation.disposition === "enforce");
    const reported = hits[0];
    findings.push({
      kind,
      blocked: Boolean(blocking),
      ...(reported ? { directive: reported.effectiveDirective, disposition: blocking ? "enforce" as const : "report" as const } : {}),
    });
    if (!blocking) continue;
    // One patch per enforcing policy: a browser applies each of them, so
    // changing one is not enough when a site sends two.
    for (const violation of hits.filter((item) => item.disposition === "enforce")) {
      const entry = enforcing.get(violation.policy) || { policy: violation.policy, source: violation.source, kinds: new Set<CspRequestKind>() };
      entry.kinds.add(kind);
      enforcing.set(violation.policy, entry);
    }
  }

  const origin = new URL(input.consoleOrigin).origin;
  const patches = [...enforcing.values()].map((entry) => policyPatch({
    policy: entry.policy,
    // Everything this policy would refuse, not only what was reached before
    // the first refusal stopped the rest from being attempted.
    kinds: kindsNotAdmitted(entry.policy, origin),
    origin,
    source: entry.source,
  }));

  return {
    source: "measured",
    findings,
    blocked: findings.some((finding) => finding.blocked),
    patches,
  };
}

/**
 * One policy, rewritten so the console's origin is admitted for the kinds of
 * request that were refused.
 */
export function policyPatch(input: {
  policy: string;
  kinds: readonly CspRequestKind[];
  origin: string;
  source?: "header" | "meta";
}): PolicyPatch {
  const parsed = parseCsp(input.policy);
  const present = [...parsed.keys()];
  const strictDynamic = (parsed.get("script-src-elem") || parsed.get("script-src") || parsed.get("default-src") || [])
    .some((source) => source.toLowerCase() === "'strict-dynamic'");

  const additions = new Map<string, string[]>();
  for (const kind of input.kinds) {
    const governing = governingDirective(kind, present);
    if (!governing) continue;
    // Widening `default-src` would admit every kind of resource site-wide, so
    // the specific directive is written instead — carrying over what
    // `default-src` allowed, or the site's own resources start failing.
    const target = governing.directive === "default-src" ? governing.effectiveDirective : governing.directive;
    const inherited = governing.directive === "default-src" ? parsed.get("default-src") || [] : parsed.get(target) || [];
    const sources = additions.get(target) || [...inherited];
    if (!sources.includes(input.origin)) sources.push(input.origin);
    additions.set(target, sources);
  }

  const directives = [...additions.keys()];
  const edits: PolicyEdit[] = directives.map((directive) => ({
    directive,
    add: input.origin,
    present: parsed.has(directive),
    sources: additions.get(directive) || [],
  }));
  const rendered = [...parsed.entries()]
    .map(([name, sources]) => (additions.has(name) ? [name, additions.get(name)!] as const : [name, sources] as const))
    .concat(directives.filter((name) => !parsed.has(name)).map((name) => [name, additions.get(name)!] as const))
    .map(([name, sources]) => [name, ...sources].join(" "))
    .join("; ");

  return {
    before: input.policy.trim(),
    after: rendered,
    directives,
    edits,
    ...(input.source ? { source: input.source } : {}),
    strictDynamic,
  };
}

/**
 * Where a policy is configured, named only when the response says so. A guess
 * sends a reader into the wrong file, so an unrecognised host gets no name.
 */
export function policyOrigin(headers: ReadonlyArray<readonly [string, string]>) {
  const lookup = (name: string) => headers.find(([key]) => key.toLowerCase() === name)?.[1] || "";
  if (lookup("x-vercel-id")) return "vercel";
  if (lookup("x-nf-request-id")) return "netlify";
  if (/cloudflare/i.test(lookup("server")) || lookup("cf-ray")) return "cloudflare";
  if (/^nginx/i.test(lookup("server"))) return "nginx";
  if (/^apache/i.test(lookup("server"))) return "apache";
  if (/^caddy/i.test(lookup("server"))) return "caddy";
  return undefined;
}
