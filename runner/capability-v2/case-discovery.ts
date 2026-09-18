import type { Browser, BrowserContextOptions, Page } from "playwright";
import type {
  C2CaseGenerationInput,
  CapabilityCaseDiscoveryEvidence,
  CapabilityCaseDiscoveryRegion,
  JsonPrimitive,
} from "../../lib/capability-center-v2/model";

const MAX_REGIONS = 24;
const MAX_REGION_TEXT = 1_200;
const MAX_OBSERVED_VALUES = 32;
const MAX_READ_ONLY_PAGES = 4;
const NAVIGATION_TIMEOUT_MS = 15_000;
const PAGE_SETTLE_TIMEOUT_MS = 3_000;

const SENSITIVE_NAME =
  /(?:password|passwd|passcode|secret|token|authorization|cookie|credential|api.?key|private.?key|otp|session.?id)/iu;
const SENSITIVE_TEXT =
  /\b(?:password|passwd|passcode|secret|token|authorization|cookie|credential|api[-_ ]?key|private[-_ ]?key|otp)\s*[:=]\s*\S+/giu;
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const PROVIDER_TOKEN =
  /\b(?:gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/gu;
const ABSOLUTE_PATH =
  /(?:^|\s)(?:file:\/\/|[a-z]:[\\/]|\\\\|\/(?:home|users|tmp|var|etc|opt|workspace)(?:\/|\s|$))/iu;
const MUTATING_INTENT =
  /(?:\b(?:create|update|edit|delete|remove|pay|purchase|buy|checkout|send|publish|upload|reserve|cancel|approve|reject|refund|transfer|invite|register|sign\s*up|log\s*out|sign\s*out|place\s+(?:an?\s+)?order|order\s+(?:an?\s+)?(?:item|product|service)|add\s+to\s+(?:cart|basket|wishlist|favorites?))\b|创建|新增|修改|更新|删除|移除|支付|购买|下单|结账|发送|发布|上传|预订|预约|取消|批准|拒绝|退款|转账|邀请|注册|加入(?:购物车|收藏)|退出)/iu;
const READ_ONLY_INTENT =
  /(?:\b(?:search|query|filter|sort|view|read|list|browse|inspect|look\s*up|lookup|find|retrieve|compare|preview|check\s+status|get\s+(?:details?|information|status|results?))\b|搜索|查询|检索|筛选|过滤|排序|查看|读取|列表|浏览|查找|获取(?:详情|信息|状态|结果)|比较|预览)/iu;
const UNSAFE_NAVIGATION_TEXT =
  /(?:\b(?:add|activate|delete|remove|purchase|buy|checkout|submit|send|publish|logout|log\s*out|sign\s*out|unsubscribe|cancel|approve|reject|refund|transfer|follow|favorite|wishlist|cart|basket)\b|添加|激活|删除|移除|购买|下单|结账|提交|发送|发布|退出|退订|取消|批准|拒绝|退款|转账|关注|收藏|购物车)/iu;

export type CapabilityCaseDiscoveryAction =
  CapabilityCaseDiscoveryEvidence["actions"][number];

export type CapabilityCaseDiscoverySnapshot = Omit<
  CapabilityCaseDiscoveryEvidence,
  "candidateHash" | "cases"
>;

export type CapabilityCaseDiscoveryDependencies = {
  browser: Browser;
  storageState?: BrowserContextOptions["storageState"];
};

type RawRegion = {
  kind: CapabilityCaseDiscoveryRegion["kind"];
  text: string;
  observedValues: JsonPrimitive[];
  controlOptions: JsonPrimitive[];
};

function compactText(value: string, maxLength = MAX_REGION_TEXT) {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "[REDACTED]")
    .replace(SENSITIVE_TEXT, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED]")
    .replace(JWT_TOKEN, "[REDACTED_TOKEN]")
    .replace(PROVIDER_TOKEN, "[REDACTED_TOKEN]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED_EMAIL]")
    .replace(
      /(?:file:\/\/\S+|[a-z]:[\\/]\S+|\\\\\S+|\/(?:home|users|tmp|var|etc|opt|workspace)(?:\/\S*)?)/giu,
      "[REDACTED_PATH]",
    )
    .replace(
      /<!doctype\s+html|<html(?:\s|>)|<(?:body|script|form|button|input|select|textarea)(?:\s[^>]*)?>/giu,
      "[REDACTED_DOM]",
    )
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function safeHttpUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("case_discovery_url_invalid");
  }
  if (!/^https?:$/u.test(url.protocol))
    throw new Error("case_discovery_url_invalid");
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_NAME.test(key)) url.searchParams.delete(key);
  }
  url.hash = "";
  return url;
}

function safeEvidenceUrl(value: string) {
  return safeHttpUrl(value).toString();
}

function sameOrigin(value: string, origin: string) {
  try {
    return safeHttpUrl(value).origin === origin;
  } catch {
    return false;
  }
}

function dedupeValues(values: JsonPrimitive[]) {
  const seen = new Set<string>();
  const result: JsonPrimitive[] = [];
  for (const value of values) {
    const sanitized =
      typeof value === "string" ? compactText(value, 240) : value;
    if (
      sanitized === "" ||
      (typeof sanitized === "string" && ABSOLUTE_PATH.test(sanitized))
    )
      continue;
    const key = `${typeof sanitized}:${String(sanitized).normalize("NFKC").toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(sanitized);
    if (result.length >= MAX_OBSERVED_VALUES) break;
  }
  return result;
}

function isMutatingCandidate(input: C2CaseGenerationInput) {
  const primarySemanticText = [
    input.candidate.contract.intent,
    input.candidate.name,
    input.candidate.description,
    ...input.candidate.aliases,
  ].join("\n");
  if (MUTATING_INTENT.test(primarySemanticText)) return true;
  if (READ_ONLY_INTENT.test(primarySemanticText)) return false;
  const stagePurposes = input.candidate.program.stages
    .map((stage) => stage.purpose)
    .join("\n");
  if (MUTATING_INTENT.test(stagePurposes)) return true;
  if (READ_ONLY_INTENT.test(stagePurposes)) return false;
  return true;
}

function safeAuditUrl(value: string, fallback: string) {
  try {
    return safeEvidenceUrl(value);
  } catch {
    return safeEvidenceUrl(fallback);
  }
}

function candidateTerms(input: C2CaseGenerationInput) {
  return [input.candidate.name, ...input.candidate.aliases]
    .flatMap((value) =>
      value
        .normalize("NFKC")
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}]+/u),
    )
    .filter((value) => value.length >= 2)
    .slice(0, 16);
}

async function assertNoAuthenticationControls(page: Page) {
  const selector = [
    'input[type="password"]',
    'input[autocomplete="current-password" i]',
    'input[autocomplete="new-password" i]',
    'input[autocomplete="one-time-code" i]',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[name*="passcode" i]',
    'input[id*="passcode" i]',
  ].join(",");
  for (const frame of page.frames()) {
    if (await frame.locator(selector).count())
      throw new Error("case_discovery_authentication_required");
  }
}

async function waitForPageToSettle(page: Page) {
  // domcontentloaded can fire before a hydrated application has consumed its
  // session/local-storage state. Network idle plus two animation frames lets
  // the initial bundle, effect, and resulting render complete without relying
  // on site-specific selectors or business values.
  await page
    .waitForLoadState("networkidle", { timeout: PAGE_SETTLE_TIMEOUT_MS })
    .catch(() => undefined);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function collectRawRegions(page: Page): Promise<RawRegion[]> {
  await assertNoAuthenticationControls(page);
  return page.evaluate<RawRegion[]>(String.raw`(() => {
    const maxRegions = ${MAX_REGIONS};
    const maxText = ${MAX_REGION_TEXT};
    const maxValues = ${MAX_OBSERVED_VALUES};
    const normalize = (value, limit) => value
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED_EMAIL]")
      .replace(/\s+/gu, " ").trim().slice(0, limit);
    const sensitive = /(?:password|passwd|passcode|secret|token|authorization|cookie|credential|api.?key|private.?key|otp|session.?id)/iu;
    const primitiveValues = (element) => {
      const values = [];
      const controlOptions = [];
      const add = (value) => {
        if (typeof value === "string") {
          const compact = normalize(value, 240);
          if (compact) values.push(compact);
        } else if (value === null) {
          values.push(null);
        } else if (typeof value === "number" || typeof value === "boolean") {
          values.push(value);
        }
      };
      const addTokens = (value) => {
        if (typeof value !== "string") return;
        for (const token of normalize(value, 1_200).match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) || []) {
          const characters = [...token];
          if (characters.length >= 2) add(token);
          if (/\p{Script=Han}/u.test(token)) {
            for (let size = 2; size <= Math.min(4, characters.length); size += 1) {
              for (let start = 0; start + size <= characters.length; start += 1) add(characters.slice(start, start + size).join(""));
            }
          }
        }
      };
      const addText = (value) => {
        add(value);
        addTokens(value);
      };
      const addControlOption = (value) => {
        const before = values.length;
        add(value);
        if (values.length > before) controlOptions.push(values.at(-1));
        addTokens(value);
      };
      // Numeric badge text may wrap another span. Preserve observed scalars
      // before token expansion; do not infer ranks from array positions.
      for (const badge of element.querySelectorAll('span,td,th,[role=cell]')) {
        const text = (badge.textContent || '').trim();
        if (/^\d{1,9}$/.test(text)) { add(Number(text)); add(text); }
      }
      for (const leaf of element.querySelectorAll('span,h1,h2,h3,h4,td,th,[role=cell]')) {
        if (!leaf.children.length && !sensitive.test(leaf.getAttribute('name') || '')) {
          add(leaf.textContent || '');
          const numeric = (leaf.textContent || '').trim();
          if (/^\d+$/.test(numeric)) add(Number(numeric));
        }
      }
      for (const line of (element.innerText || element.textContent || "").split(/\r?\n/u)) addText(line);
      for (const heading of element.querySelectorAll("h1,h2,h3,h4,[role=heading],a")) addText(heading.textContent || "");
      for (const control of element.querySelectorAll("input,select,textarea,[role=combobox],[role=listbox],[role=option]")) {
        const input = control;
        const name = (input.name || "") + " " + (input.id || "") + " " + (input.getAttribute("aria-label") || "");
        if (sensitive.test(name) || input.type === "password" || input.type === "hidden") continue;
        addText(input.getAttribute("aria-label"));
        addText(input.getAttribute("placeholder"));
        if (input instanceof HTMLSelectElement) {
          for (const option of input.options) {
            addControlOption(option.label);
            addControlOption(option.value);
          }
        } else if (input.matches("[role=option]")) {
          addControlOption(input.textContent || "");
          addControlOption(input.getAttribute("data-value"));
        } else if (["checkbox", "radio"].includes(input.type)) {
          addControlOption(input.value);
          addControlOption(input.checked);
        } else if (input.value && input.hasAttribute("readonly")) {
          add(input.value);
        }
      }
      return { values: [...new Set(values)].slice(0, maxValues), controlOptions: [...new Set(controlOptions)].slice(0, maxValues) };
    };

    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const selectors = "main,[role=main],article,section,form,fieldset,[role=group],[role=listitem],li,tr,div.cursor-pointer,[role=button],[data-slot=card]";
    const candidateScore = (element) => {
      const text = normalize(element.innerText || element.textContent || "", 1_200);
      return (element.matches("article,[role=listitem],tr,div.cursor-pointer,[data-slot=card]") ? 8 : 0)
        + (element.querySelector("h1,h2,h3,h4,[role=heading]") ? 5 : 0)
        + (element.querySelector("button,[role=button],input,select") ? 2 : 0)
        + (/(?:[$€£¥]\s*\d|\d+(?:[.,]\d+)?\s*[$€£¥])/u.test(text) ? 4 : 0)
        - (element.closest("nav,[role=navigation],header,footer") ? 12 : 0)
        - (element.matches("main,[role=main]") ? 2 : 0);
    };
    const candidates = [...document.querySelectorAll(selectors)]
      .filter(visible)
      .map((element, order) => ({ element, order, score: candidateScore(element) }))
      .sort((left, right) => right.score - left.score || left.order - right.order)
      .map((item) => item.element);
    const regions = [];
    const seen = new Set();
    for (const element of candidates) {
      const text = normalize(element.innerText || element.textContent || "", maxText);
      const { values, controlOptions } = primitiveValues(element);
      if (!text && !values.length) continue;
      const signature = text + "\u0000" + JSON.stringify(values) + "\u0000" + JSON.stringify(controlOptions);
      if (seen.has(signature)) continue;
      seen.add(signature);
      const nestedBusinessObjects = [...element.querySelectorAll("article,[role=listitem],li,tr,div.cursor-pointer")]
        .filter((child) => child !== element && visible(child)).length;
      const kind = element.matches("form,fieldset,[role=group]")
        ? "control-group"
        : element.matches("main,[role=main]") || nestedBusinessObjects > 1
          ? "page-summary"
          : "business-region";
      regions.push({ kind, text, observedValues: values, controlOptions });
      if (regions.length >= maxRegions) break;
    }
    if (!regions.length && document.body) {
      const text = normalize(document.body.innerText || document.body.textContent || "", maxText);
      if (text) {
        const { values, controlOptions } = primitiveValues(document.body);
        regions.push({ kind: "page-summary", text, observedValues: values, controlOptions });
      }
    }
    return regions;
  })()`);
}

async function collectSafeLinks(
  page: Page,
  origin: string,
  terms: string[],
  readOnlyPathPrefixes: string[],
) {
  const links = await page
    .evaluate<Array<{ url: string; text: string; score: number }>>(
      String.raw`(() => {
    const expectedOrigin = ${JSON.stringify(origin)};
    const semanticTerms = ${JSON.stringify(terms)};
    return [...document.querySelectorAll("a[href]")].flatMap((element) => {
      const anchor = element;
      let url;
      try { url = new URL(anchor.href, document.baseURI); }
      catch { return []; }
      if (url.origin !== expectedOrigin || !/^https?:$/u.test(url.protocol)) return [];
      const text = (anchor.innerText || anchor.textContent || "").replace(/\s+/gu, " ").trim().slice(0, 240);
      const haystack = (text + " " + url.pathname).normalize("NFKC").toLocaleLowerCase();
      const score = semanticTerms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return [{ url: url.toString(), text, score }];
    }).sort((left, right) => right.score - left.score).slice(0, 12);
  })()`,
    )
    .catch(() => [] as Array<{ url: string; text: string; score: number }>);
  const seen = new Set<string>();
  return links
    .filter((link) => {
      // Never browse unrelated links merely because they happened to be on the
      // page.  A positive capability-term match is required in addition to the
      // side-effect denylist.
      if (
        link.score <= 0 ||
        !sameOrigin(link.url, origin) ||
        UNSAFE_NAVIGATION_TEXT.test(`${link.text} ${link.url}`)
      )
        return false;
      const url = safeHttpUrl(link.url);
      if (
        !readOnlyPathPrefixes.some(
          (prefix) =>
            url.pathname === prefix ||
            url.pathname.startsWith(
              prefix.endsWith("/") ? prefix : `${prefix}/`,
            ),
        )
      )
        return false;
      if ([...url.searchParams.keys()].some((key) => SENSITIVE_NAME.test(key)))
        return false;
      url.hash = "";
      const key = url.toString();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((link) => link.url);
}

async function appendPageRegions(
  page: Page,
  regions: CapabilityCaseDiscoveryRegion[],
  actions: CapabilityCaseDiscoveryAction[],
) {
  const url = safeEvidenceUrl(page.url());
  const rawRegions = await collectRawRegions(page);
  actions.push({
    action: "inspect",
    outcome: "performed",
    url,
    reason: "compact_semantic_regions_collected",
    requestMethod: "GET",
  });
  for (const raw of rawRegions) {
    if (regions.length >= MAX_REGIONS) break;
    const text = compactText(raw.text);
    const observedValues = dedupeValues(raw.observedValues);
    const controlOptions = dedupeValues(raw.controlOptions);
    if (!text && !observedValues.length) continue;
    regions.push({
      regionId: `region_${regions.length + 1}`,
      url,
      kind: raw.kind,
      text,
      observedValues,
      ...(controlOptions.length ? { controlOptions } : {}),
    });
  }
}

/**
 * Production C2 explorer. It owns the context and never accepts a C1 Page or
 * BrowserContext. The request guard is installed before the first Page exists.
 */
export async function discoverCapabilityCaseEvidence(
  input: C2CaseGenerationInput,
  dependencies: CapabilityCaseDiscoveryDependencies,
): Promise<CapabilityCaseDiscoverySnapshot> {
  const baseUrl = safeHttpUrl(input.browser.baseUrl);
  const startUrl = safeHttpUrl(input.browser.startUrl);
  if (startUrl.origin !== baseUrl.origin)
    throw new Error("case_discovery_start_origin_mismatch");

  if (
    input.browser.session.mode === "AuthenticatedSnapshot" &&
    dependencies.storageState === undefined
  ) {
    throw new Error("case_discovery_storage_state_required");
  }
  const storageState =
    input.browser.session.mode === "AuthenticatedSnapshot"
      ? dependencies.storageState
      : undefined;

  const mutating = isMutatingCandidate(input);
  // This grant comes from the control-plane contract, not browser text.
  const readPaths = input.browser.readOnlyPathPrefixes || [];
  const context = await dependencies.browser.newContext({ storageState });
  const actions: CapabilityCaseDiscoveryAction[] = [];
  const regions: CapabilityCaseDiscoveryRegion[] = [];
  const blockedRequests = new Set<string>();
  try {
    await context.routeWebSocket("**/*", (socket) => {
      if (sameOrigin(socket.url(), baseUrl.origin)) socket.connectToServer();
      else socket.close();
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const method = request.method().toUpperCase();
      const requestOriginAllowed = sameOrigin(request.url(), baseUrl.origin);
      const requestUrl = requestOriginAllowed
        ? safeHttpUrl(request.url())
        : undefined;
      const interactive = new Set([
        "document",
        "fetch",
        "xhr",
        "eventsource",
      ]).has(request.resourceType());
      const isEntryRequest = requestUrl?.toString() === startUrl.toString();
      const isApprovedReadOnlyPath =
        !mutating &&
        Boolean(
          readPaths.some(
            (prefix) =>
              requestUrl &&
              (requestUrl.pathname === prefix ||
                requestUrl.pathname.startsWith(
                  prefix.endsWith("/") ? prefix : `${prefix}/`,
                )),
          ),
        );
      if (
        method !== "GET" ||
        !requestOriginAllowed ||
        (interactive && UNSAFE_NAVIGATION_TEXT.test(request.url())) ||
        (interactive && !isEntryRequest && !isApprovedReadOnlyPath)
      ) {
        const reason =
          method !== "GET"
            ? `non_get_request_blocked:${method}`
            : !requestOriginAllowed
              ? "cross_origin_request_blocked"
              : "unapproved_get_request_blocked";
        if (!blockedRequests.has(reason) && actions.length < 32) {
          blockedRequests.add(reason);
          actions.push({
            action: method === "GET" ? "navigate" : "submit",
            outcome: "blocked",
            url: safeAuditUrl(request.url(), startUrl.toString()),
            reason,
            requestMethod: method,
          });
        }
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });

    const page = await context.newPage();
    await page.goto(startUrl.toString(), {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    if (!sameOrigin(page.url(), baseUrl.origin))
      throw new Error("case_discovery_redirect_origin_mismatch");
    await waitForPageToSettle(page);
    actions.push({
      action: "navigate",
      outcome: "performed",
      url: safeEvidenceUrl(page.url()),
      reason: "entry_get_navigation",
      requestMethod: "GET",
    });
    await appendPageRegions(page, regions, actions);

    if (mutating) {
      actions.push({
        action: "submit",
        outcome: "blocked",
        url: safeEvidenceUrl(page.url()),
        reason: "mutating_intent_evidence_only",
        requestMethod: "POST",
      });
    } else if (
      !mutating &&
      readPaths.length
    ) {
      const links = await collectSafeLinks(
        page,
        baseUrl.origin,
        candidateTerms(input),
        readPaths,
      );
      // Public Contract routes are discovery hints, never expected evidence.
      // Visit them independently before asserting any URL/text value.
      const routeHints = input.candidate.contract.successConditions.flatMap(raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const condition = raw as Record<string, unknown>;
        if (condition.type !== 'urlIncludes' || typeof condition.value !== 'string' || !condition.value.startsWith('/')) return [];
        try {
          const url = new URL(condition.value,baseUrl.origin);
          if (url.origin !== baseUrl.origin || UNSAFE_NAVIGATION_TEXT.test(url.href) || /[{}*]/.test(url.href)) return [];
          if (!readPaths.some(prefix => url.pathname===prefix || url.pathname.startsWith(prefix.endsWith('/')?prefix:prefix+'/'))) return [];
          return [url.href];
        } catch {return [];}
      });
      links.unshift(...routeHints);
      const visited = new Set([safeHttpUrl(page.url()).toString()]);
      for (const link of links) {
        if (
          visited.size >= MAX_READ_ONLY_PAGES ||
          regions.length >= MAX_REGIONS
        )
          break;
        const url = safeHttpUrl(link);
        if (url.origin !== baseUrl.origin || visited.has(url.toString()))
          continue;
        visited.add(url.toString());
        try {
          await page.goto(url.toString(), {
            waitUntil: "domcontentloaded",
            timeout: NAVIGATION_TIMEOUT_MS,
          });
          if (!sameOrigin(page.url(), baseUrl.origin))
            throw new Error("case_discovery_redirect_origin_mismatch");
          await waitForPageToSettle(page);
          actions.push({
            action: "navigate",
            outcome: "performed",
            url: safeEvidenceUrl(page.url()),
            reason: "bounded_same_origin_get_exploration",
            requestMethod: "GET",
          });
          await appendPageRegions(page, regions, actions);
        } catch {
          actions.push({
            action: "navigate",
            outcome: "blocked",
            url: safeEvidenceUrl(url.toString()),
            reason: "bounded_get_navigation_failed",
            requestMethod: "GET",
          });
        }
      }
    }
    if (!regions.length) throw new Error("case_discovery_regions_required");
    return {
      schemaVersion: "1.0",
      generationTaskId: input.generationTaskId,
      siteId: input.siteId,
      explorationMode: mutating ? "evidence-only" : "read-only-interactive",
      regions,
      actions: actions.slice(0, 32),
    };
  } finally {
    await context.close();
  }
}
