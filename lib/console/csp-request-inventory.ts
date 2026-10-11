/**
 * Every request SiteWake makes from inside a visitor's page, and the
 * Content-Security-Policy directive that governs it.
 *
 * This table is measured, not derived from the specification:
 * `tests/csp-request-inventory.test.mjs` drives a real Chromium against a page
 * with a policy and asserts each row, so a row that stops being true fails the
 * suite instead of turning into wrong advice in the console.
 *
 * The checker, the patch generator and the install prompt all read this table.
 * Adding a request to the SDK means adding a row here and measuring it.
 */

export type CspRequestKind = "script" | "capability-module" | "api" | "style" | "image";

export type CspRequestEntry = {
  kind: CspRequestKind;
  /** The directive a browser names for this request, whether or not the site wrote it. */
  effectiveDirective: string;
  /** Directives the browser falls back to, in order, when the effective one is absent. */
  fallback: string[];
  /** Nothing SiteWake does may require a site to weaken its policy; both stay false. */
  needsUnsafeInline: boolean;
  needsUnsafeEval: boolean;
};

export const CSP_REQUEST_INVENTORY: CspRequestEntry[] = [
  // The install tag, parser-inserted from the site's own HTML.
  { kind: "script", effectiveDirective: "script-src-elem", fallback: ["script-src", "default-src"], needsUnsafeInline: false, needsUnsafeEval: false },
  // Capability programs, loaded by dynamic import() from the control plane.
  { kind: "capability-module", effectiveDirective: "script-src-elem", fallback: ["script-src", "default-src"], needsUnsafeInline: false, needsUnsafeEval: false },
  // Everything under /api: launches, handshakes, runs.
  { kind: "api", effectiveDirective: "connect-src", fallback: ["default-src"], needsUnsafeInline: false, needsUnsafeEval: false },
  // The widget's stylesheet, loaded from the control plane rather than injected
  // inline, so a site never has to allow 'unsafe-inline' for SiteWake.
  { kind: "style", effectiveDirective: "style-src-elem", fallback: ["style-src", "default-src"], needsUnsafeInline: false, needsUnsafeEval: false },
  // The brand mark.
  { kind: "image", effectiveDirective: "img-src", fallback: ["default-src"], needsUnsafeInline: false, needsUnsafeEval: false },
];

/** Request kinds that are satisfied by naming the control plane's origin. */
export function requestKindsNeedingOrigin() {
  return CSP_REQUEST_INVENTORY
    .filter((entry) => !entry.needsUnsafeInline && !entry.needsUnsafeEval)
    .map((entry) => entry.kind);
}

/**
 * The directive a patch must extend for one request kind, given the directives
 * a policy actually names. The browser checks the effective directive first and
 * falls back in order, so the directive to touch is the first one present —
 * and when none is, the effective one is the directive to add.
 */
export function governingDirective(kind: CspRequestKind, presentDirectives: Iterable<string>) {
  const present = new Set([...presentDirectives].map((directive) => directive.toLowerCase()));
  const entry = CSP_REQUEST_INVENTORY.find((item) => item.kind === kind);
  if (!entry) return undefined;
  for (const directive of [entry.effectiveDirective, ...entry.fallback]) {
    if (present.has(directive)) return { directive, present: true as const, effectiveDirective: entry.effectiveDirective };
  }
  return { directive: entry.effectiveDirective, present: false as const, effectiveDirective: entry.effectiveDirective };
}
