import {
  stableHash,
  uid,
  type ElementEvidence,
  type JsonValue,
  type LocatorVariant,
  type PageSnapshot,
  type TargetSpec,
  type ValueExpression,
  clipUtf16,
} from "../lib/site-knowledge/protocol";
import { resolveWidgetLocale, widgetCopy } from "./user-agent-copy";

export { uid };

export function browserSessionId() {
  const key = "sitewake:v5:browser-session";
  try {
    const found = localStorage.getItem(key);
    if (found) return found;
    const created = uid("browser");
    localStorage.setItem(key, created);
    return created;
  } catch { return uid("browser"); }
}

export function documentId() {
  const root = window as typeof window & { __SITEWAKE_DOCUMENT_ID__?: string };
  return root.__SITEWAKE_DOCUMENT_ID__ ||= uid("document");
}

export function normalizedText(value: string | null | undefined) {
  return (value || "").normalize("NFKC").replace(/(?:^|\s)\/?>(?:\s|$)/g, " ").replace(/\s+\/?\s*$/, "").replace(/\s+/g, " ").trim();
}


function heading() {
  const element = document.querySelector("h1,[role=heading][aria-level='1'],main h2");
  return clipUtf16(normalizedText(element?.textContent), 300);
}

function visible(element: Element) {
  const node = element as HTMLElement;
  const style = getComputedStyle(node);
  const rect = node.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
}

function visibleText() {
  return clipUtf16(normalizedText(document.body?.innerText), 20_000);
}

export type SensitiveControlKind = "password" | "otp" | "webauthn" | "payment-card" | "payment-code" | "payment-expiry";

export function sensitiveControlKind(element: Element): SensitiveControlKind | undefined {
  const input = element instanceof HTMLInputElement ? element : element.closest<HTMLInputElement>("input");
  if (!input) return undefined;
  const autocomplete = normalizedText(input.autocomplete || input.getAttribute("autocomplete")).toLowerCase();
  if (input.type === "password" || autocomplete === "current-password" || autocomplete === "new-password") return "password";
  if (autocomplete === "one-time-code" || /(^|[-_])(otp|totp|verification[-_]?code|sms[-_]?code)($|[-_])/i.test(`${input.name} ${input.id}`)) return "otp";
  if (autocomplete.includes("webauthn")) return "webauthn";
  const descriptor = normalizedText([
    input.name,
    input.id,
    input.getAttribute("aria-label"),
    input.placeholder,
  ].filter(Boolean).join(" "));
  if (autocomplete === "cc-number" || /(?:credit|debit|payment)?[-_\s]*card[-_\s]*(?:number|no)|(?:^|[-_\s])cc[-_\s]*(?:number|num)(?:$|[-_\s])/i.test(descriptor)) return "payment-card";
  if (autocomplete === "cc-csc" || /(?:^|[-_\s])(?:cvc|cvv|cvn|card[-_\s]*security[-_\s]*code)(?:$|[-_\s])/i.test(descriptor)) return "payment-code";
  if (["cc-exp", "cc-exp-month", "cc-exp-year"].includes(autocomplete)
    || /(?:card|cc)[-_\s]*(?:expiry|expiration|exp[-_\s]*(?:month|year|date)?)/i.test(descriptor)) return "payment-expiry";
  return undefined;
}

export function isSensitiveElement(element: Element) {
  if (sensitiveControlKind(element)) return true;
  const authForm = element.closest("form");
  return Boolean(authForm?.querySelector('input[type="password"],input[autocomplete="one-time-code"],input[autocomplete*="webauthn"],input[autocomplete^="cc-"]'));
}

export const CHALLENGE_SELECTOR = [
  "iframe[src*='captcha' i]",
  "iframe[title*='captcha' i]",
  "[data-sitekey]",
  "[id*='captcha' i]",
  "[class*='captcha' i]",
  "[aria-label*='captcha' i]",
].join(",");

/**
 * Elements the Agent must never be able to operate: credential, one-time-code
 * and payment inputs, everything sharing an authentication form with them, and
 * challenge widgets.
 *
 * This lives beside the DOM primitives on purpose. It is an unconditional
 * safety boundary, not part of any pause/resume flow, so it must not depend on
 * a subsystem that can be switched off or removed.
 */
export function humanInteractionBlacklist() {
  const sensitive = Array.from(document.querySelectorAll<HTMLElement>("input,textarea,button,select,[contenteditable=true]")).filter(isSensitiveElement);
  const challenges = Array.from(document.querySelectorAll<HTMLElement>(CHALLENGE_SELECTOR));
  return [...new Set([...sensitive, ...challenges])];
}

function metaContent(...selectors: string[]) {
  for (const selector of selectors) {
    const value = document.querySelector<HTMLMetaElement>(selector)?.content;
    if (value?.trim()) return clipUtf16(normalizedText(value), 500);
  }
  return undefined;
}

function structuredMetadata() {
  const names = new Set<string>();
  const types = new Set<string>();
  for (const script of Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')).slice(0, 12)) {
    try {
      const root = JSON.parse(script.textContent || "null") as unknown;
      const queue = Array.isArray(root) ? [...root] : [root];
      for (const value of queue.slice(0, 30)) {
        if (!value || typeof value !== "object") continue;
        const item = value as Record<string, unknown>;
        if (typeof item.name === "string" && item.name.trim()) names.add(clipUtf16(normalizedText(item.name), 120));
        const type = item["@type"];
        if (typeof type === "string") types.add(type.slice(0, 80));
        else if (Array.isArray(type)) type.filter((entry): entry is string => typeof entry === "string").forEach((entry) => types.add(entry.slice(0, 80)));
        if (Array.isArray(item["@graph"])) queue.push(...item["@graph"].slice(0, 20));
      }
    } catch { /* Invalid third-party JSON-LD must not block the SDK. */ }
  }
  return { names: [...names].slice(0, 12), types: [...types].slice(0, 12) };
}

function pageMetadata(): NonNullable<PageSnapshot["metadata"]> {
  const structured = structuredMetadata();
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
  const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href;
  const logoAlts = Array.from(document.querySelectorAll<HTMLImageElement>('header img[alt],nav img[alt],img[class*="logo" i][alt]'))
    .map((image) => normalizedText(image.alt)).filter(Boolean);
  return {
    lang: document.documentElement.lang || undefined,
    canonicalUrl: canonical || undefined,
    applicationName: metaContent('meta[name="application-name"]', 'meta[name="apple-mobile-web-app-title"]'),
    manifestUrl: manifest || undefined,
    description: metaContent('meta[name="description"]'),
    ogSiteName: metaContent('meta[property="og:site_name"]'),
    ogTitle: metaContent('meta[property="og:title"]'),
    ogDescription: metaContent('meta[property="og:description"]'),
    logoAlts: [...new Set(logoAlts)].slice(0, 8),
    structuredNames: structured.names,
    structuredTypes: structured.types,
  };
}

export function capturePageSnapshot(sequence = 0): PageSnapshot {
  const sensitiveAuthenticationPage = Boolean(document.querySelector('input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"],input[autocomplete="one-time-code"],input[autocomplete*="webauthn"]'));
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
    .filter(visible)
    .map((link) => ({ text: clipUtf16(normalizedText(link.textContent), 120), url: link.href }))
    .filter((link) => link.text && (() => { try { return new URL(link.url).origin === location.origin; } catch { return false; } })())
    .slice(0, sensitiveAuthenticationPage ? 0 : 120);
  const elements = Array.from(document.querySelectorAll<HTMLElement>("button,a[href],input,textarea,select,[role],[contenteditable=true],[tabindex]"))
    .filter((element) => visible(element) && !isSensitiveElement(element))
    .map(evidenceFromElement)
    .slice(0, sensitiveAuthenticationPage ? 0 : 160);
  return {
    id: uid("snapshot"), sessionId: browserSessionId(), documentId: documentId(), sequence,
    url: location.href, title: clipUtf16(normalizedText(document.title), 300), heading: sensitiveAuthenticationPage ? "" : heading(), visibleText: sensitiveAuthenticationPage ? "[authentication page content redacted]" : visibleText(), links, elements, metadata: pageMetadata(),
    capturedAt: new Date().toISOString(),
  };
}

function implicitRole(element: Element) {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  if (element instanceof HTMLButtonElement) return "button";
  if (element instanceof HTMLAnchorElement && element.href) return "link";
  if (element instanceof HTMLInputElement) return element.type === "checkbox" ? "checkbox" : element.type === "radio" ? "radio" : "textbox";
  if (element instanceof HTMLSelectElement) return "combobox";
  if (element instanceof HTMLTextAreaElement) return "textbox";
  return undefined;
}

function accessibleName(element: Element) {
  const aria = element.getAttribute("aria-label") || element.getAttribute("title");
  if (aria) return normalizedText(aria);
  if (element instanceof HTMLInputElement && element.labels?.length) return normalizedText(Array.from(element.labels).map((label) => label.textContent).join(" "));
  return clipUtf16(normalizedText(element.textContent || element.getAttribute("placeholder")), 200);
}

function stableAttributes(element: Element) {
  const result: Record<string, string> = {};
  for (const key of ["id", "name", "type", "autocomplete", "inputmode", "data-testid", "data-test", "aria-label", "href"]) {
    const value = element.getAttribute(key);
    if (value && value.length < 300 && !/^\d+$/.test(value)) result[key] = value;
  }
  return result;
}

function cssPath(element: Element) {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body && parts.length < 5) {
    let part = current.tagName.toLowerCase();
    if (current.id) { part += `#${CSS.escape(current.id)}`; parts.unshift(part); break; }
    const stableClass = Array.from(current.classList).find((item) => !/\d/.test(item) && item.length < 50);
    if (stableClass) part += `.${CSS.escape(stableClass)}`;
    const siblings = current.parentElement ? Array.from(current.parentElement.children).filter((item) => item.tagName === current!.tagName) : [];
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(" > ");
}

export function actionableFromEvent(event: Event) {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target as EventTarget];
  return path.find((item): item is HTMLElement => item instanceof HTMLElement && !isSensitiveElement(item) && item.matches("button,a[href],input,textarea,select,[role],[contenteditable=true],[tabindex]"));
}

function elementBelongsToSiteAgent(item: Element) {
  if (item instanceof HTMLElement && (item.hasAttribute("data-sitewake-agent") || item.closest("[data-sitewake-agent]"))) return true;
  const root = item.getRootNode();
  return root instanceof ShadowRoot && root.host instanceof HTMLElement && root.host.hasAttribute("data-sitewake-agent");
}

export function eventBelongsToSiteAgent(event: Event) {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target as EventTarget];
  return path.some((item) => item instanceof Element && elementBelongsToSiteAgent(item));
}

export function evidenceFromElement(element: Element): ElementEvidence {
  if (isSensitiveElement(element)) throw new Error("sensitive_element_evidence_blocked");
  const context = element.closest("form,nav,header,main,section,article,tr,li,[role=dialog],[role=row]");
  const landmark = element.closest("header,nav,main,aside,footer")?.tagName.toLowerCase();
  return {
    tag: element.tagName.toLowerCase(), role: implicitRole(element), accessibleName: accessibleName(element),
    label: element instanceof HTMLInputElement && element.labels?.length ? normalizedText(element.labels[0].textContent) : undefined,
    placeholder: element.getAttribute("placeholder") || undefined, name: element.getAttribute("name") || undefined,
    href: element instanceof HTMLAnchorElement ? element.href : undefined, attributes: stableAttributes(element),
    contextText: context && context !== element ? clipUtf16(normalizedText(context.textContent), 400) : undefined,
    landmark: landmark === "header" || landmark === "nav" || landmark === "main" || landmark === "aside" || landmark === "footer" ? landmark : "unknown",
    cssPath: cssPath(element),
  };
}

export function targetFromEvidence(evidence: ElementEvidence, sceneId?: string, now = new Date().toISOString()): TargetSpec {
  const semantic = `${evidence.role || evidence.tag}:${evidence.accessibleName || evidence.label || evidence.name || evidence.href || evidence.cssPath}`;
  const variants: LocatorVariant[] = [];
  function add(strategy: LocatorVariant["strategy"], value?: string, score = 0.7) {
    if (!value) return;
    variants.push({ id: `locator_${stableHash(`${strategy}:${value}`)}`, strategy, value, role: evidence.role, score, successes: 1, failures: 0, lastSeenAt: now });
  }
  if (evidence.role && evidence.accessibleName) add("role", evidence.accessibleName, 0.98);
  add("label", evidence.label, 0.96);
  add("placeholder", evidence.placeholder, 0.92);
  add("name", evidence.name, 0.9);
  add("text", evidence.accessibleName, 0.86);
  if (evidence.href) add("href-template", evidence.href, 0.88);
  add("css", evidence.cssPath, 0.45);
  return {
    id: `target_${stableHash(semantic)}`, name: evidence.accessibleName || evidence.label || evidence.name || evidence.role || evidence.tag,
    sceneIds: sceneId ? [sceneId] : [], role: evidence.role, accessibleNames: [evidence.accessibleName].filter(Boolean) as string[],
    attributes: evidence.attributes, locatorVariants: variants, updatedAt: now,
  };
}

export type MatchLevel = "exact" | "stable" | "reidentified";
export class TargetResolutionError extends Error {
  constructor(readonly code: "target_not_found" | "target_ambiguous" | "target_hidden" | "target_obscured", message: string, readonly candidates: string[] = []) {
    super(message); this.name = "TargetResolutionError";
  }
}

function byVariant(variant: LocatorVariant) {
  const all = Array.from(document.querySelectorAll<HTMLElement>("button,a[href],input,textarea,select,[role],[contenteditable=true],[tabindex]")).filter((element) => !isSensitiveElement(element));
  const value = normalizedText(variant.value);
  if (variant.strategy === "css") { try { return Array.from(document.querySelectorAll<HTMLElement>(variant.value)); } catch { return []; } }
  if (variant.strategy === "href-template") return all.filter((element) => element instanceof HTMLAnchorElement && (element.href === variant.value || element.href.includes(variant.value)));
  if (variant.strategy === "placeholder") return all.filter((element) => normalizedText(element.getAttribute("placeholder")) === value);
  if (variant.strategy === "name") return all.filter((element) => normalizedText(element.getAttribute("name")) === value);
  if (variant.strategy === "label") return all.filter((element) => element instanceof HTMLInputElement && normalizedText(Array.from(element.labels || []).map((label) => label.textContent).join(" ")) === value);
  if (variant.strategy === "role") return all.filter((element) => implicitRole(element) === variant.role && accessibleName(element) === value);
  return all.filter((element) => accessibleName(element) === value);
}

function scoreCandidate(element: HTMLElement, target: TargetSpec) {
  let score = 0;
  if (target.role && implicitRole(element) === target.role) score += 4;
  const name = accessibleName(element);
  if (target.accessibleNames.includes(name)) score += 5;
  else if (target.accessibleNames.some((item) => name.includes(item) || item.includes(name))) score += 2;
  for (const [key, value] of Object.entries(target.attributes)) if (element.getAttribute(key) === value) score += key === "id" || key.startsWith("data-") ? 3 : 1;
  return score;
}

/** The visitor-facing wording for a target that could not be used. */
const say = () => widgetCopy(resolveWidgetLocale()).page;

export function resolveTarget(target: TargetSpec): { element: HTMLElement; matchLevel: MatchLevel; matches: number } {
  if (target.sensitive) throw new TargetResolutionError("target_not_found", say().sensitiveTargetNeedsYou(target.name));
  for (const variant of [...target.locatorVariants].sort((a, b) => b.score - a.score)) {
    const matches = byVariant(variant).filter(visible);
    if (matches.length === 1) return { element: matches[0], matchLevel: variant.score >= 0.8 ? "exact" : "stable", matches: 1 };
  }
  const candidates = Array.from(document.querySelectorAll<HTMLElement>("button,a[href],input,textarea,select,[role],[contenteditable=true],[tabindex]"))
    .filter((element) => visible(element) && !isSensitiveElement(element)).map((element) => ({ element, score: scoreCandidate(element, target) })).filter((item) => item.score >= 5).sort((a, b) => b.score - a.score);
  if (!candidates.length) throw new TargetResolutionError("target_not_found", say().targetMissing(target.name));
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) throw new TargetResolutionError("target_ambiguous", say().targetAmbiguous(target.name), candidates.slice(0, 5).map((item) => accessibleName(item.element)));
  return { element: candidates[0].element, matchLevel: "reidentified", matches: candidates.length };
}

export function clickableAncestor(element: HTMLElement) {
  return element.closest<HTMLElement>("button,a[href],[role=button],[role=link],input,select,textarea") || element;
}

export function clickTarget(element: HTMLElement) {
  if (isSensitiveElement(element)) throw new Error("sensitive_program_step");
  const target = clickableAncestor(element);
  if (target instanceof HTMLAnchorElement) {
    if (window.__SiteWakeNavigate?.(target.href, target.target || "_self")) return true;
    target.target = "_self";
    target.rel = target.rel.replace(/\bnoopener\b|\bnoreferrer\b/g, "").trim();
  }
  target.scrollIntoView({ block: "center", inline: "center" });
  const rect = target.getBoundingClientRect();
  const insetX = Math.min(Math.max(rect.width * 0.15, 2), 12);
  const insetY = Math.min(Math.max(rect.height * 0.15, 2), 12);
  const clickPoints = [
    [rect.left + rect.width / 2, rect.top + rect.height / 2],
    [rect.left + insetX, rect.top + insetY],
    [rect.right - insetX, rect.top + insetY],
    [rect.left + insetX, rect.bottom - insetY],
    [rect.right - insetX, rect.bottom - insetY],
  ] as const;
  const hits = clickPoints
    .filter(([x, y]) => x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight)
    .map(([x, y]) => document.elementFromPoint(x, y))
    .filter((hit): hit is Element => Boolean(hit));
  const hasClearPoint = hits.some((hit) => hit === target || target.contains(hit) || hit.contains(target));
  // The agent panel is part of this SDK, not part of the site. A direct DOM
  // action may safely pass through our own overlay while the panel stays open
  // to show progress. Real site overlays still block execution.
  const externalBlockers = hits.filter((hit) => !elementBelongsToSiteAgent(hit));
  if (!hasClearPoint && externalBlockers.length) {
    const blockers = [...new Set(externalBlockers.map((hit) => accessibleName(hit as HTMLElement)).filter(Boolean))];
    throw new TargetResolutionError("target_obscured", say().targetObscured, blockers);
  }
  // Some sites open destinations through an onclick/window.open rather than a
  // real anchor. The Run handoff hook creates the destination tab synchronously
  // (so popup blockers allow it) and transfers BrowserPort ownership there.
  const originalOpen = window.open;
  window.open = ((url?: string | URL, openTarget?: string, features?: string) => {
    const handled = url && window.__SiteWakeNavigate?.(new URL(String(url), location.href).toString(), openTarget || "_blank");
    if (handled) return handled === true ? window : handled;
    return originalOpen(url, openTarget, features);
  }) as typeof window.open;
  try { target.click(); }
  finally { queueMicrotask(() => { window.open = originalOpen; }); }
  return false;
}

declare global {
  interface Window {
    __SiteWakeNavigate?: (url: string, target?: string) => boolean | Window;
  }
}

export function fillTarget(element: HTMLElement, value: string) {
  if (isSensitiveElement(element)) throw new Error("sensitive_program_step");
  if (element instanceof HTMLSelectElement) {
    const option = Array.from(element.options).find((item) => normalizedText(item.value) === normalizedText(value) || normalizedText(item.textContent) === normalizedText(value));
    if (!option) throw new Error(`option_not_found:${value}`);
    element.value = option.value;
  } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  } else if (element.isContentEditable) element.textContent = value;
  else throw new Error("target_not_editable");
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  const actual = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element.value : element.textContent || "";
  if (normalizedText(actual) !== normalizedText(value) && !(element instanceof HTMLSelectElement)) throw new Error(`fill_verification_failed:${actual}`);
}

export function resolveValue(expression: ValueExpression, sources: { input: Record<string, JsonValue>; state: Record<string, JsonValue>; step: Record<string, JsonValue> }): JsonValue | undefined {
  if (expression.source === "literal") return expression.value;
  const source = expression.source === "input" ? sources.input : expression.source === "state" ? sources.state : sources.step;
  const path = expression.path.replace(/^(input|state|step)\./, "").split(".").filter(Boolean);
  let current: JsonValue | undefined = source;
  for (const part of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * How long this document waits to be unloaded after handing its run to a
 * destination document.
 *
 * Successful handovers in production complete in 10–15s end to end, and the
 * BrowserPort lease itself expects a claim within 10s. Thirty seconds is well
 * clear of both while still ending the wait long before a person gives up.
 */
export const PAGE_HANDOFF_LIMIT_MS = 30_000;

/**
 * Park this document while a navigation transfers the run — but never without
 * a way out.
 *
 * These parks used to be `new Promise<never>(() => {})`, on the reasoning that
 * the document is about to be unloaded and nothing after this matters. When the
 * destination never claims the run, that reasoning fails and the runtime stops
 * forever: every other budget — wall clock, active time, model requests — is
 * evaluated inside the execution loop, so a park that happens *outside* the
 * loop is invisible to all of them. One production run sat in `running` for
 * over thirteen minutes this way, with the wall-clock limit never consulted.
 *
 * Rejecting with a budget-shaped error puts the runtime back into the loop,
 * where the existing terminal handling can end the task and tell the user.
 */
export function awaitPageHandoff(limitMs = PAGE_HANDOFF_LIMIT_MS): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error("page_agent_budget_exhausted:page-handoff")), limitMs);
  });
}

export async function waitFor(check: () => boolean, timeoutMs: number, label: string) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`wait_timeout:${label}`);
}
