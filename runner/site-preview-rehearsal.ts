import type { Page } from "playwright";
import type { PolicyViolation } from "../lib/site-knowledge/protocol";

/**
 * Opening a reader's website with the install snippet already in it, and
 * writing down what the browser refused.
 *
 * This is what makes the console's policy guidance a measurement instead of an
 * analysis: the page is served the exact markup a reader would paste, the
 * browser applies its own rules, and its violation events are the verdict.
 * Nothing here touches the reader's site — the rewriting happens on the
 * response inside our own browser.
 */

/**
 * Puts the snippet where a reader would put it: in the HTML, before the parser
 * leaves the head. A parser-inserted tag is judged differently from one a
 * script appends (measured under `'strict-dynamic'`), so a rehearsal that
 * injected it any other way would answer a different question.
 *
 * Returns "" when the document offers no dependable place, which the caller
 * reports as "could not rehearse" rather than guessing.
 */
export const REHEARSAL_ATTRIBUTE = "data-sitewake-rehearsal";

/**
 * The snippet as the rehearsal serves it: the reader's markup plus a mark that
 * tells the control plane this page is a rehearsal. Without it the SDK hands
 * shakes for real and the website is recorded as connected when nobody has
 * installed anything.
 */
export function markAsRehearsal(snippet: string) {
  // Only the attribute is added: the rest of the reader's markup is served
  // exactly as they would paste it, which is the whole point of rehearsing.
  return snippet.replace(/<script\b/i, (tag) => `${tag} ${REHEARSAL_ATTRIBUTE}="1"`);
}

export function injectInstallSnippet(html: string, snippet: string) {
  const head = /<\/head\s*>/i.exec(html);
  if (head) return `${html.slice(0, head.index)}${snippet}${html.slice(head.index)}`;
  const body = /<body[^>]*>/i.exec(html);
  if (body) return `${html.slice(0, body.index + body[0].length)}${snippet}${html.slice(body.index + body[0].length)}`;
  return "";
}

/**
 * Collects the page's own policy violations. Registered before the first
 * navigation, because a violation is reported as the resource is requested: a
 * listener added afterwards misses the install tag entirely.
 */
export async function collectPolicyViolations(page: Page, limit = 50) {
  const violations: PolicyViolation[] = [];
  await page.exposeFunction("__sitewakeViolation", (violation: PolicyViolation) => {
    if (violations.length < limit) violations.push(violation);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const detail = event as SecurityPolicyViolationEvent;
      void (window as unknown as { __sitewakeViolation(value: unknown): Promise<void> }).__sitewakeViolation({
        blockedUrl: detail.blockedURI,
        effectiveDirective: detail.effectiveDirective,
        violatedDirective: detail.violatedDirective,
        disposition: detail.disposition,
        policy: detail.originalPolicy,
      });
    });
  });
  return violations;
}

/**
 * Serves the main document with the snippet in it. Only the top-level HTML
 * document is rewritten: sub-frames belong to the site, and a non-HTML
 * response is passed through untouched.
 */
export async function serveWithInstallSnippet(page: Page, snippet: string) {
  const state = { injected: false, attempted: false };
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.resourceType() !== "document" || request.frame() !== page.mainFrame()) return route.fallback();
    const response = await route.fetch();
    const type = response.headers()["content-type"] || "";
    if (!/text\/html/i.test(type)) return route.fulfill({ response });
    state.attempted = true;
    const html = await response.text();
    const next = injectInstallSnippet(html, markAsRehearsal(snippet));
    if (!next) return route.fulfill({ response, body: html });
    state.injected = true;
    return route.fulfill({ response, body: next });
  });
  return state;
}
