/**
 * Server-side page rendering for the onboarding crawler. Isolated from the pure
 * crawl core so the Playwright dependency never leaks into the offline-testable
 * modules. `snapshotFromExtract` (pure shaping) and the in-page `EXTRACT`
 * function are the reviewable/unit-testable parts; `playwrightRenderPage` is the
 * browser glue the Group 5 runner injects.
 */
import type { BrowserContext, CDPSession, Page } from "playwright";
import type { RenderPage } from "./crawl-knowledge";
import { clipUtf16, stableHash, type ElementEvidence, type PageSnapshot } from "./protocol";
import { BLOCK_MEASURE_SOURCE, filterBlocks, type RawBlock } from "./content-filter";

export type PageExtract = {
  title: string;
  heading: string;
  visibleText: string;
  links: Array<{ text: string; url: string }>;
  elements: Array<Pick<ElementEvidence, "tag" | "role" | "accessibleName" | "href" | "landmark"> & { attributes: Record<string, string> }>;
  metadata?: PageSnapshot["metadata"];
  /** Block-level measurement. Absent means this render could not obtain it (the original extraction is unaffected). */
  blocks?: RawBlock[];
};

export const CRAWL_DISABLED_BROWSER_NETWORK_APIS = [
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "mozRTCPeerConnection",
  "WebTransport",
  "Worker",
  "SharedWorker",
] as const;

const crawlNetworkGuardedContexts = new WeakSet<BrowserContext>();

/**
 * Playwright routes do not cover WebRTC STUN/TURN or WebTransport QUIC. Install
 * this before the first crawl navigation so page and child-frame realms cannot
 * open those transports. Worker constructors are disabled because
 * BrowserContext.addInitScript applies to pages and frames, not worker globals.
 */
export async function installCrawlBrowserNetworkGuards(context: BrowserContext) {
  if (crawlNetworkGuardedContexts.has(context)) return;
  await context.addInitScript(({ blockedApis }) => {
    for (const name of blockedApis) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
      if (descriptor && !descriptor.configurable) {
        throw new Error(`crawl_network_guard_failed:${name}`);
      }
      Object.defineProperty(globalThis, name, {
        configurable: false,
        enumerable: descriptor?.enumerable ?? true,
        writable: false,
        // Keep this constructor completely inline. The runner is loaded by
        // tsx/esbuild with keepNames, which rewrites named inner functions to
        // call its private `__name` helper. That helper does not exist inside
        // the browser realm and previously made every real crawl return zero
        // pages even though the standalone test bundle passed.
        value: new Proxy(Object, {
          apply() {
            throw new DOMException("Network API disabled in crawl context", "SecurityError");
          },
          construct() {
            throw new DOMException("Network API disabled in crawl context", "SecurityError");
          },
        }),
      });
    }
  }, { blockedApis: CRAWL_DISABLED_BROWSER_NETWORK_APIS });
  crawlNetworkGuardedContexts.add(context);
}

async function crawlBrowserNetworkGuardsActive(page: Page) {
  return page.evaluate((blockedApis) => blockedApis.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    if (!descriptor || descriptor.configurable || descriptor.writable || typeof descriptor.value !== "function") return false;
    try {
      Reflect.construct(descriptor.value, []);
      return false;
    } catch (error) {
      return error instanceof DOMException && error.name === "SecurityError";
    }
  }), CRAWL_DISABLED_BROWSER_NETWORK_APIS);
}

function exactOriginUrl(value: string, expectedOrigin: string) {
  try {
    const parsed = new URL(value);
    if (
      !/^https?:$/.test(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.origin !== expectedOrigin
    ) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Extra allowed sub-resource origins. Crawls pass none and behave exactly as before;
 * connection detection passes the control plane's own origin so the page's SDK can
 * load and handshake — the very request detection wants to observe.
 *
 * Sub-resources only: navigation stays pinned to the site by `allowedOrigin`, and the
 * WebSocket guard is not relaxed. Unparseable, credentialed or non-http(s) entries are
 * dropped so callers cannot stuff junk into the allow-list.
 */
export function normalizeAdditionalRequestOrigins(values: readonly string[] | undefined): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const value of values || []) {
    try {
      const parsed = new URL(value);
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) continue;
      origins.add(parsed.origin);
    } catch { /* 丢弃解析不了的条目 */ }
  }
  return origins;
}

/**
 * Origin check shared by the two request guards (CDP `Fetch.requestPaused` and
 * Playwright `context.route`). They treat schemes differently — CDP only sees http(s),
 * while route must let data:/blob: through — so scheme rules stay at each call site and
 * this only answers "may this origin pass".
 */
function subresourceOriginAllowed(requestUrl: URL, protectedOrigin: string, additional: ReadonlySet<string>) {
  if (requestUrl.username || requestUrl.password) return false;
  return requestUrl.origin === protectedOrigin || additional.has(requestUrl.origin);
}

/**
 * Pure-function form of the check above, for unit tests without a browser. Same
 * semantics as the guards: http(s) is judged by origin, non-http(s) (data:/blob: etc.)
 * is not origin-bound, unparseable is blocked.
 */
export function crawlRequestAllowed(
  requestUrl: string,
  protectedOrigin: string,
  additionalRequestOrigins: readonly string[] = [],
): boolean {
  let parsed: URL;
  try { parsed = new URL(requestUrl); } catch { return false; }
  if (!/^https?:$/.test(parsed.protocol)) return true;
  return subresourceOriginAllowed(parsed, protectedOrigin, normalizeAdditionalRequestOrigins(additionalRequestOrigins));
}

function isFatalBrowserInfrastructureError(page: Page, error: unknown) {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (
    /targetclosederror/i.test(name)
    || /target page, context or browser has been closed/i.test(message)
    || /\btarget closed\b/i.test(message)
    || /browser (?:has been )?(?:closed|disconnected)/i.test(message)
    || /\b(?:page|context) (?:has been |is )?closed\b/i.test(message)
    || /page (?:has )?crashed/i.test(message)
  ) return true;

  const pageWithOptionalState = page as Page & { isClosed?: () => boolean };
  try {
    if (pageWithOptionalState.isClosed?.()) return true;
    const contextWithOptionalBrowser = page.context() as ReturnType<Page["context"]> & {
      browser?: () => { isConnected?: () => boolean } | null;
    };
    const browser = contextWithOptionalBrowser.browser?.();
    return browser?.isConnected?.() === false;
  } catch {
    return true;
  }
}

/** Pure: shapes a Playwright extraction into the canonical PageSnapshot (browser-free, unit-testable). */
export function snapshotFromExtract(url: string, extract: PageExtract, capturedAt: string, sequence = 1, httpStatus?: number): PageSnapshot {
  // Truncate after filtering: otherwise the precious 20k budget goes to noise like
  // trending lists first. Gray blocks are kept by default: no arbitration here yet (the
  // model call happens in the crawl layer). Better to keep noise than to kill content.
  const filtered = extract.blocks?.length
    ? filterBlocks(extract.blocks, { maxChars: 20_000, undecidedPolicy: "keep" })
    : undefined;
  return {
    id: `crawl_${stableHash(`${url}:${sequence}`)}`,
    sessionId: "crawl",
    documentId: stableHash(url),
    sequence,
    url,
    title: extract.title || "",
    heading: extract.heading || "",
    visibleText: clipUtf16(extract.visibleText, 20_000),
    links: (extract.links || []).filter((link) => link && link.url).slice(0, 120),
    elements: (extract.elements || []).slice(0, 160).map((element) => ({
      tag: element.tag,
      role: element.role,
      accessibleName: element.accessibleName,
      href: element.href,
      landmark: element.landmark,
      attributes: element.attributes || {},
    })),
    metadata: extract.metadata,
    httpStatus,
    contentFilter: filtered
      ? {
        mainText: filtered.mainText,
        dropped: filtered.dropped,
        undecided: filtered.undecided,
        stats: { ...filtered.stats },
        blocks: extract.blocks ?? [],
      }
      : undefined,
    capturedAt,
  };
}

/**
 * A server-side RenderPage backed by a Playwright Page. Only runnable with a real
 * browser (the Group 5 runner injects the Page). Returns null on navigation
 * failure so the frontier simply skips the URL.
 *
 * The in-page extraction is an inline anonymous arrow with NO inner *named*
 * functions on purpose: the runner bundles this file with esbuild/tsx
 * (`keepNames`), which rewrites named functions to `__name(...)` — a helper that
 * does not exist in the browser, so `page.evaluate` of any function containing a
 * named inner helper throws `__name is not defined`. Anonymous arrows passed as
 * arguments are not rewritten, so everything here is inlined.
 */
export function playwrightRenderPage(
  page: Page,
  options: { timeoutMs?: number; allowedOrigin?: string; additionalRequestOrigins?: readonly string[] } = {},
): RenderPage {
  let sequence = 0;
  let protectedOrigin = "";
  let routeInstalled = false;
  let requestStageSession: CDPSession | undefined;
  const additionalRequestOrigins = normalizeAdditionalRequestOrigins(options.additionalRequestOrigins);
  return async (url) => {
    let requestedUrl: URL;
    let configuredOrigin: URL | undefined;
    try {
      requestedUrl = new URL(url);
      configuredOrigin = options.allowedOrigin ? new URL(options.allowedOrigin) : undefined;
    } catch {
      return null;
    }
    const requestedOrigin = requestedUrl.origin;
    if (
      !/^https?:$/.test(requestedUrl.protocol)
      || requestedUrl.username
      || requestedUrl.password
      || configuredOrigin?.username
      || configuredOrigin?.password
      || (configuredOrigin && configuredOrigin.origin !== requestedOrigin)
    ) return null;
    if (!routeInstalled) {
      protectedOrigin = requestedOrigin;
      const context = page.context();
      await installCrawlBrowserNetworkGuards(context);
      if (typeof context.newCDPSession !== "function") {
        throw new Error("crawl_request_interception_unavailable");
      }
      requestStageSession = await context.newCDPSession(page);
      requestStageSession.on("Fetch.requestPaused", (event) => {
        void (async () => {
          try {
            const requestUrl = new URL(event.request.url);
            if (
              !/^https?:$/.test(requestUrl.protocol)
              || !subresourceOriginAllowed(requestUrl, protectedOrigin, additionalRequestOrigins)
            ) {
              await requestStageSession!.send("Fetch.failRequest", {
                requestId: event.requestId,
                errorReason: "BlockedByClient",
              });
              return;
            }
            await requestStageSession!.send("Fetch.continueRequest", {
              requestId: event.requestId,
            });
          } catch {
            await requestStageSession!.send("Fetch.failRequest", {
              requestId: event.requestId,
              errorReason: "BlockedByClient",
            }).catch(() => undefined);
          }
        })();
      });
      await requestStageSession.send("Fetch.enable", {
        patterns: [
          { urlPattern: "http://*", requestStage: "Request" },
          { urlPattern: "https://*", requestStage: "Request" },
        ],
      });
      await context.route("**/*", async (route) => {
        try {
          const requestUrl = new URL(route.request().url());
          if (
            /^https?:$/.test(requestUrl.protocol)
            && !subresourceOriginAllowed(requestUrl, protectedOrigin, additionalRequestOrigins)
          ) {
            await route.abort("blockedbyclient");
            return;
          }
          await route.continue();
        } catch {
          await route.abort("blockedbyclient");
        }
      });
      await context.routeWebSocket(() => true, async (socket) => {
        try {
          const socketUrl = new URL(socket.url());
          const originUrl = new URL(protectedOrigin);
          const expectedProtocol = originUrl.protocol === "https:" ? "wss:" : "ws:";
          if (
            socketUrl.protocol !== expectedProtocol
            || socketUrl.username
            || socketUrl.password
            || socketUrl.host !== originUrl.host
          ) {
            await socket.close({ code: 1008, reason: "crawl_origin_rejected" });
            return;
          }
          socket.connectToServer();
        } catch {
          await socket.close({ code: 1008, reason: "crawl_origin_rejected" });
        }
      });
      context.on("page", (candidate) => {
        if (candidate !== page) void candidate.close().catch(() => undefined);
      });
      await page.goto("about:blank", { waitUntil: "commit", timeout: options.timeoutMs ?? 15_000 });
      if (!await crawlBrowserNetworkGuardsActive(page)) {
        throw new Error("crawl_network_guard_inactive");
      }
      routeInstalled = true;
    } else if (requestedOrigin !== protectedOrigin) {
      return null;
    }
    try {
      // The HTTP status is the most general "not a real page" signal — independent of
      // language and site wording. The title word list ("页面未找到") is only a fallback:
      // production tripped on "页面没找到", one character off, and that link target became
      // a scene named "页面没找到".
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs ?? 15_000 });
      const httpStatus = response?.status();
      if (!exactOriginUrl(page.url(), protectedOrigin)) return null;
      // Best-effort: let client-rendered pages hydrate, but never hang on chatty ones.
      await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
      const beforeExtractUrl = exactOriginUrl(page.url(), protectedOrigin);
      if (!beforeExtractUrl) return null;
      const evaluated = await page.evaluate((): { pageUrl: string; extract: PageExtract } => {
        const anchors = Array.from(document.querySelectorAll("a[href]")).slice(0, 400);
        const links = anchors
          .map((anchor) => ({ text: (anchor.textContent || "").trim().slice(0, 120), url: (anchor as HTMLAnchorElement).href }))
          .filter((link) => link.url && !link.url.startsWith("javascript:"));
        const elements = anchors.map((anchor) => {
          const owner = anchor.closest("header,nav,main,aside,footer");
          const tag = owner ? owner.tagName.toLowerCase() : "";
          const landmark = (tag === "header" || tag === "nav" || tag === "main" || tag === "aside" || tag === "footer" ? tag : "unknown") as PageExtract["elements"][number]["landmark"];
          return {
            tag: "a",
            role: anchor.getAttribute("role") || "link",
            accessibleName: (anchor.getAttribute("aria-label") || anchor.textContent || "").trim().slice(0, 120) || undefined,
            href: (anchor as HTMLAnchorElement).href,
            landmark,
            attributes: { href: (anchor as HTMLAnchorElement).href },
          };
        });
        return {
          pageUrl: window.location.href,
          extract: {
            title: document.title || "",
            heading: (document.querySelector("h1")?.textContent || "").trim().slice(0, 200),
            visibleText: (document.body?.innerText || "").slice(0, 20_000),
            links,
            elements,
            metadata: {
              lang: document.documentElement.lang || undefined,
              canonicalUrl: document.querySelector('link[rel="canonical"]')?.getAttribute("href") || undefined,
              description: document.querySelector('meta[name="description"]')?.getAttribute("content") || document.querySelector('meta[property="og:description"]')?.getAttribute("content") || undefined,
              ogSiteName: document.querySelector('meta[property="og:site_name"]')?.getAttribute("content") || undefined,
              ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute("content") || undefined,
              ogDescription: document.querySelector('meta[property="og:description"]')?.getAttribute("content") || undefined,
              applicationName: document.querySelector('meta[name="application-name"]')?.getAttribute("content") || undefined,
            },
          },
        };
      });
      // Block-level measurement runs separately: BLOCK_MEASURE_SOURCE is a string, which
      // sidesteps the esbuild keepNames / __name issue described at the top of this file.
      // Degrades silently on failure, never affecting the existing extraction path.
      const blocks = await page
        .evaluate(BLOCK_MEASURE_SOURCE)
        .then((value) => (Array.isArray(value) ? (value as RawBlock[]) : undefined))
        .catch(() => undefined);
      if (blocks) evaluated.extract.blocks = blocks;
      const evaluatedUrl = exactOriginUrl(evaluated.pageUrl, protectedOrigin);
      const afterExtractUrl = exactOriginUrl(page.url(), protectedOrigin);
      if (
        !evaluatedUrl
        || !afterExtractUrl
        || evaluatedUrl.href !== beforeExtractUrl.href
        || afterExtractUrl.href !== evaluatedUrl.href
      ) return null;
      sequence += 1;
      return snapshotFromExtract(evaluatedUrl.href, evaluated.extract, new Date().toISOString(), sequence, httpStatus);
    } catch (error) {
      if (isFatalBrowserInfrastructureError(page, error)) throw error;
      return null;
    }
  };
}
