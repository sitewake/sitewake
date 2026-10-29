import type { Browser, BrowserContextOptions, Page } from "playwright";
import type {
  JsonValue,
  C2CaseGenerationInput,
  CapabilityCaseDiscoveryEvidence,
  CapabilityCaseDiscoveryRegion,
  JsonPrimitive,
} from "../../lib/capability-center-v2/model";

const MAX_REGIONS = 24;
/**
 * Content regions one page may contribute, so that a rich first page leaves
 * room for a sibling page's values; each page adds one navigation region on
 * top of these.
 */
const MAX_REGIONS_PER_PAGE = 12;
const MAX_REGION_TEXT = 1_200;
const MAX_OBSERVED_VALUES = 48;
/** Values read off the page's own address and its same-origin links. */
const MAX_NAVIGATION_VALUES = 48;
/** Of a region's values, the share kept for the values in its links. */
const REGION_NAVIGATION_SHARE = 12;
/** Room left under the sidecar budget for the case mappings added later. */
const EVIDENCE_TARGET_BYTES = 56 * 1024;
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
  /** The start page as authoring harvested it; given, no browser is opened here. */
  snapshot?: CapabilityCaseDiscoverySnapshot;
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

/**
 * Values a region is seen to hold, in tiers so that the cap never drops a
 * whole value for a fragment: scalars and whole leaf texts first, then the
 * values in the region's own links and the page address (a same-origin link
 * to `/daily/2026-03-10` is the site saying it serves that date), then word
 * tokens, and last the Han n-grams that let a query be a part of a title.
 */
async function collectRawRegions(page: Page, demonstrationValues: string[] = []): Promise<RawRegion[]> {
  await assertNoAuthenticationControls(page);
  return page.evaluate<RawRegion[]>(String.raw`(() => {
    const demonstrationValues = ${JSON.stringify(demonstrationValues.filter((value) => typeof value === "string" && value.trim()).slice(0, 8))};
    const maxRegions = ${MAX_REGIONS_PER_PAGE};
    const maxText = ${MAX_REGION_TEXT};
    const maxValues = ${MAX_OBSERVED_VALUES};
    const maxNavigationValues = ${MAX_NAVIGATION_VALUES};
    const navigationShare = ${REGION_NAVIGATION_SHARE};
    // Icon-font glyphs are private-use characters in the text, not part of a name.
    const normalize = (value, limit) => value
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED_EMAIL]")
      .replace(/\p{Co}/gu, "")
      .replace(/\s+/gu, " ").trim().slice(0, limit);
    const sensitive = /(?:password|passwd|passcode|secret|token|authorization|cookie|credential|api.?key|private.?key|otp|session.?id)/iu;
    const trackingParameter = /^(?:utm_|_ga|_gl|gclid|fbclid|ref$|referrer$|from$|spm$|_t$|ts$|timestamp$|nonce$|_$|cb$)/iu;
    const valueKey = (value) => typeof value + ":" + String(value).normalize("NFKC").toLocaleLowerCase();
    // Values the address bar and same-origin links carry: path segments and
    // query values, decoded, short enough to be a business value.
    const urlValues = (url) => {
      const out = [];
      const push = (raw) => {
        let text;
        try { text = decodeURIComponent(raw); } catch { text = raw; }
        text = normalize(text, 64);
        if (!text || text.length > 64) return;
        out.push(text);
        if (/^\d{1,9}$/u.test(text)) out.push(Number(text));
      };
      for (const segment of url.pathname.split("/").filter(Boolean).slice(-2)) push(segment);
      for (const [key, value] of url.searchParams) {
        if (sensitive.test(key) || trackingParameter.test(key)) continue;
        push(value);
      }
      return out;
    };
    // A sibling of this page — same path shape, one segment different — is the
    // page for another value of the same input, so its links are read first;
    // a list of twenty item links must not use up the budget before them.
    const here = location.pathname.split("/").filter(Boolean);
    const isSibling = (url) => {
      const there = url.pathname.split("/").filter(Boolean);
      return here.length > 0 && here.length === there.length
        && there.filter((segment, index) => segment !== here[index]).length === 1;
    };
    const linkValues = (root) => {
      const links = [];
      for (const anchor of root.querySelectorAll("a[href]")) {
        let url;
        try { url = new URL(anchor.getAttribute("href") || "", document.baseURI); } catch { continue; }
        if (url.origin !== location.origin || !/^https?:$/u.test(url.protocol)) continue;
        links.push(url);
      }
      links.sort((left, right) => Number(isSibling(right)) - Number(isSibling(left)));
      const seen = new Set();
      const out = [];
      for (const url of links) {
        for (const value of urlValues(url)) {
          const key = valueKey(value);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(value);
        }
        if (out.length >= maxNavigationValues) break;
      }
      return out.slice(0, maxNavigationValues);
    };
    const primitiveValues = (element) => {
      const whole = [];
      const navigation = [];
      const tokens = [];
      const grams = [];
      const controlOptions = [];
      const addTo = (list, value) => {
        if (typeof value === "string") {
          const compact = normalize(value, 240);
          if (compact) list.push(compact);
        } else if (value === null) {
          list.push(null);
        } else if (typeof value === "number" || typeof value === "boolean") {
          list.push(value);
        }
      };
      const add = (value) => addTo(whole, value);
      const addTokens = (value) => {
        if (typeof value !== "string") return;
        for (const token of normalize(value, 1_200).match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) || []) {
          const characters = [...token];
          if (characters.length >= 2) addTo(tokens, token);
          if (/\p{Script=Han}/u.test(token)) {
            for (let size = 2; size <= Math.min(4, characters.length); size += 1) {
              for (let start = 0; start + size <= characters.length; start += 1) addTo(grams, characters.slice(start, start + size).join(""));
            }
          }
        }
      };
      const addText = (value) => {
        add(value);
        addTokens(value);
      };
      const addControlOption = (value) => {
        const before = whole.length;
        add(value);
        if (whole.length > before) controlOptions.push(whole.at(-1));
        addTokens(value);
      };
      // Numeric badge text may wrap another span. Preserve observed scalars
      // before token expansion; do not infer ranks from array positions.
      for (const badge of element.querySelectorAll('span,td,th,[role=cell]')) {
        const text = (badge.textContent || '').trim();
        if (/^\d{1,9}$/.test(text)) { add(Number(text)); add(text); }
      }
      for (const leaf of element.querySelectorAll('span,h1,h2,h3,h4,h5,td,th,[role=cell],a,button,label,time,option,li,p,dt,dd,strong,em,b,small,code')) {
        if (!leaf.children.length && !sensitive.test(leaf.getAttribute('name') || '')) {
          add(leaf.textContent || '');
          const numeric = (leaf.textContent || '').trim();
          if (/^\d+$/.test(numeric)) add(Number(numeric));
        }
      }
      for (const time of element.querySelectorAll('time[datetime]')) add(time.getAttribute('datetime'));
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
      for (const value of linkValues(element)) addTo(navigation, value);
      const seen = new Set();
      const values = [];
      // Whole values first, but a share is held for the region's link values,
      // which a long list of whole texts would otherwise crowd out entirely.
      const reserved = Math.max(0, maxValues - navigationShare);
      for (const value of [...whole.slice(0, reserved), ...navigation.slice(0, navigationShare), ...whole.slice(reserved), ...navigation.slice(navigationShare), ...tokens, ...grams]) {
        const key = valueKey(value);
        if (seen.has(key)) continue;
        seen.add(key);
        values.push(value);
        if (values.length >= maxValues) break;
      }
      return { values, controlOptions: [...new Set(controlOptions)].slice(0, maxValues) };
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
    // The page as the site addresses it: its own address and where it links
    // to, wherever those links sit in the DOM. Held apart from the content
    // regions so a value here is grounded by the page, not by a business object.
    const navigation = [];
    const navigationSeen = new Set();
    for (const value of [...urlValues(new URL(location.href)), ...linkValues(document)]) {
      const key = valueKey(value);
      if (navigationSeen.has(key)) continue;
      navigationSeen.add(key);
      navigation.push(value);
      if (navigation.length >= maxNavigationValues) break;
    }
    if (navigation.length) {
      const title = normalize(document.title || "", 240) || normalize(location.pathname, 240) || "/";
      regions.push({ kind: "page-summary", text: title, observedValues: navigation, controlOptions: [] });
    }
    // The list each demonstrated value was chosen from, as the page lays it
    // out: the items of the tightest list that shows the value by name. The
    // regions above score cards and penalise navigation, so the category
    // list "Poetry" sits in never became one, and the cases for the category
    // input were drawn from the first product card instead — "In stock", a
    // book's title. These lists go first, ahead of the budget.
    // By the name the kernel finds it by: the text in the document, not as
    // drawn. PrestaShop's menu is upper-cased by CSS, innerText read the
    // categories as "CLOTHES", and no program could find a link by that name.
    const nameOfItem = (item) => normalize(
      item.getAttribute("aria-label") || item.textContent
        || (item.querySelector && item.querySelector("img[alt]") ? item.querySelector("img[alt]").getAttribute("alt") : "")
        || item.getAttribute("title") || "",
      160,
    );
    const itemOf = (item) => (item.matches("li,tr,[role=listitem]") && item.querySelector("a,button,label,[role=link],[role=button]")) || item;
    // A card is named by its heading: "Mira Pendant", not the whole card
    // ("Mira PendantPendant · 2700K · Dimmable$219").
    const HEADING = "h1,h2,h3,h4,h5,h6,[role=heading]";
    const cardName = (item) => {
      const heading = item.matches && item.matches(HEADING) ? item : item.querySelector && item.querySelector(HEADING);
      return heading ? normalize(heading.textContent || "", 160) : nameOfItem(itemOf(item));
    };
    // A grid of cards is a list too: a container whose children repeat (the
    // same tag, three or more of them) and each hold a heading or a link.
    // The product grid of a shop is a div of <article>s, not a <ul>.
    const repeatedItem = (element) => {
      for (let node = element; node && node.parentElement && node !== document.body; node = node.parentElement) {
        const siblings = [...node.parentElement.children].filter((child) => child.tagName === node.tagName);
        if (siblings.length >= 3 && siblings.every((child) => child.querySelector(HEADING + ",a,button") || child.matches("a,button"))) return { item: node, container: node.parentElement };
      }
      return undefined;
    };
    const choiceLists = [];
    // A breadcrumb also lists the value, between "Home" and the section it
    // is in; those are where the visitor is, not what they could choose.
    const breadcrumb = (container) => /breadcrumb/iu.test(container.className + " " + (container.getAttribute("aria-label") || "") + " " + (container.parentElement ? container.parentElement.className + " " + (container.parentElement.getAttribute("aria-label") || "") : ""));
    const listNames = (container) => {
      const items = container.matches("select,datalist") ? [...container.querySelectorAll("option")]
        : container.matches("table,tbody") ? [...container.querySelectorAll("tr")]
          : [...container.children];
      const names = [];
      const seenNames = new Set();
      for (const item of items) {
        if (!(item instanceof HTMLOptionElement) && !visible(item)) continue;
        const name = cardName(item);
        const key = valueKey(name);
        if (!name || seenNames.has(key)) continue;
        seenNames.add(key);
        names.push(name);
        if (names.length >= maxValues) break;
      }
      return names;
    };
    for (const wanted of demonstrationValues) {
      const shown = wanted.normalize("NFKC").trim().toLocaleLowerCase();
      if (!shown) continue;
      const matches = [...document.querySelectorAll("a,button,option,li,label,td,th,dt,dd,span,h1,h2,h3,h4,h5,h6,[role=heading],[role=option],[role=tab],[role=menuitem],[role=radio],[role=link],[role=button]")]
        .filter((element) => visible(element) && nameOfItem(element).normalize("NFKC").toLocaleLowerCase() === shown);
      // Of every list that shows the value, the one with the most choices: the
      // category list over the breadcrumb that also names the category.
      let chosen;
      const seenLists = new Set();
      for (const element of matches) {
        const container = element.closest("ul,ol,select,datalist,table,tbody,[role=list],[role=listbox],[role=menu],[role=tablist],[role=radiogroup],[role=group],nav")
          || (repeatedItem(element) || {}).container;
        if (!container || seenLists.has(container) || breadcrumb(container)) continue;
        seenLists.add(container);
        const names = listNames(container);
        if (names.length < 2 || !names.some((name) => name.normalize("NFKC").toLocaleLowerCase() === shown)) continue;
        if (!chosen || names.length > chosen.names.length) chosen = { container, names };
      }
      if (!chosen) continue;
      const before = chosen.container.previousElementSibling;
      const heading = before && /^H[1-6]$/u.test(before.tagName) ? normalize(before.textContent || "", 120) : "";
      choiceLists.push({ kind: "choice-list", text: normalize((heading ? heading + ": " : "") + chosen.names.join(", "), maxText), observedValues: chosen.names, controlOptions: [] });
    }
    return [...choiceLists, ...regions];
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
      // A sibling of the page the capability was demonstrated on — same path
      // shape, one segment different — is the page for another input value,
      // and is worth a visit before anything a name token happens to match.
      const here = location.pathname.split("/").filter(Boolean);
      const there = url.pathname.split("/").filter(Boolean);
      const sibling = here.length > 0 && here.length === there.length
        && there.filter((segment, index) => segment !== here[index]).length === 1;
      const score = semanticTerms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0) + (sibling ? 2 : 0);
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

/**
 * Keep the evidence under the sidecar budget by trimming value lists from the
 * tail — fragments go before whole values, by construction of the tiers —
 * rather than failing the run for having seen too much.
 */
function fitEvidenceBudget(regions: CapabilityCaseDiscoveryRegion[]) {
  const size = () =>
    new TextEncoder().encode(JSON.stringify(regions)).byteLength;
  for (let guard = 0; guard < 16 && size() > EVIDENCE_TARGET_BYTES; guard += 1) {
    let trimmed = false;
    for (const region of regions) {
      if (region.observedValues.length > 4) {
        region.observedValues = region.observedValues.slice(
          0,
          Math.max(4, Math.floor(region.observedValues.length * 0.75)),
        );
        trimmed = true;
      }
    }
    if (!trimmed) break;
  }
}

async function appendPageRegions(
  page: Page,
  regions: CapabilityCaseDiscoveryRegion[],
  actions: CapabilityCaseDiscoveryAction[],
  demonstrationValues: string[] = [],
) {
  const url = safeEvidenceUrl(page.url());
  const rawRegions = await collectRawRegions(page, demonstrationValues);
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
  // The page was read once, before authoring, and the authoring loop
  // replayed on what it offered; case generation reads the same page.
  if (dependencies.snapshot) {
    return { ...dependencies.snapshot, generationTaskId: input.generationTaskId, siteId: input.siteId };
  }
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
  // What the demonstration chose, so the harvest can find the lists those
  // values were chosen from.
  const demonstrationValues = Object.values(input.demonstrationParameters || {})
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
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
    await appendPageRegions(page, regions, actions, demonstrationValues);

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
          await appendPageRegions(page, regions, actions, demonstrationValues);
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
    fitEvidenceBudget(regions);
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


const sameText = (left: unknown, right: unknown) => typeof left === "string" && typeof right === "string"
  && left.normalize("NFKC").trim().toLocaleLowerCase() === right.normalize("NFKC").trim().toLocaleLowerCase();

/** At most this many pages linked from the start page are read for a longer list. */
const MAX_LINKED_PAGES = 8;

/**
 * The start page often shows a few of the values an input takes: the home
 * page of a shop shows four of its sixteen lamps. Cases drawn from those four
 * proved a price capability that clicked a card on the home page, and it hung
 * for every lamp the home page does not show. Pages linked from the start
 * page's navigation and main content are read (a bounded few), and where one
 * of them lists the demonstrated value among more choices, that list is the
 * one the cases come from — the values the start page does not show first,
 * so the program is held to reaching them.
 */
async function widenListsFromLinkedPages(
  page: Page,
  regions: CapabilityCaseDiscoveryRegion[],
  actions: CapabilityCaseDiscoveryAction[],
  demonstrationValues: string[],
) {
  const startUrl = page.url();
  const links = await page.evaluate<string[]>(`(() => {
    const here = location.origin + location.pathname + location.search;
    const seen = new Set([here]);
    const ordered = [...document.querySelectorAll("nav a[href], header a[href]"), ...document.querySelectorAll("main a[href], [role=main] a[href]"), ...document.querySelectorAll("a[href]")];
    const out = [];
    for (const anchor of ordered) {
      let url;
      try { url = new URL(anchor.getAttribute("href"), location.href); } catch { continue; }
      if (url.origin !== location.origin) continue;
      const key = url.origin + url.pathname + url.search;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    return out;
  })()`).catch(() => [] as string[]);
  const found: CapabilityCaseDiscoveryRegion[] = [];
  for (const href of links.slice(0, MAX_LINKED_PAGES)) {
    try {
      await page.goto(href, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForTimeout(800);
      const pageRegions: CapabilityCaseDiscoveryRegion[] = [];
      await appendPageRegions(page, pageRegions, actions, demonstrationValues);
      found.push(...pageRegions.filter((region) => region.kind === "choice-list"));
    } catch { /* a page that does not open is not a list */ }
  }
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
  for (const value of demonstrationValues) {
    const holds = (region: CapabilityCaseDiscoveryRegion) => region.kind === "choice-list" && region.observedValues.some((item) => sameText(item, value));
    const local = regions.find(holds);
    const wider = found.filter(holds).sort((left, right) => right.observedValues.length - left.observedValues.length)[0];
    if (!wider || (local && wider.observedValues.length <= local.observedValues.length)) continue;
    const shown = local?.observedValues || [];
    const unseen = wider.observedValues.filter((item) => !shown.some((other) => sameText(other, item)));
    const merged = { ...wider, observedValues: [...unseen, ...wider.observedValues.filter((item) => !unseen.includes(item))] };
    const at = local ? regions.indexOf(local) : -1;
    if (at >= 0) regions.splice(at, 1);
    regions.unshift({ ...merged, regionId: `region_${regions.length + 1}` });
  }
}

/**
 * The start page read once, before authoring: the lists the demonstrated
 * values were chosen from ahead of the cards and the page summary, as the
 * snapshot case generation reads instead of browsing again. `siblings` are
 * the other items of each input's list — what the authoring loop replays
 * the draft on, so a program that only works for the demonstrated value is
 * found while the model can still fix it.
 */
export async function harvestStartPage(
  page: Page,
  input: { generationTaskId: string; siteId: string; parameters: Record<string, JsonValue> },
): Promise<{ snapshot: CapabilityCaseDiscoverySnapshot; siblings: Record<string, JsonValue[]> }> {
  const demonstrationValues = Object.values(input.parameters)
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
  const regions: CapabilityCaseDiscoveryRegion[] = [];
  const actions: CapabilityCaseDiscoveryAction[] = [];
  await appendPageRegions(page, regions, actions, demonstrationValues);
  if (!regions.length) throw new Error("case_discovery_regions_required");
  if (demonstrationValues.length) await widenListsFromLinkedPages(page, regions, actions, demonstrationValues);
  fitEvidenceBudget(regions);
  const siblings: Record<string, JsonValue[]> = {};
  for (const [path, value] of Object.entries(input.parameters)) {
    const list = regions.find((region) => region.kind === "choice-list" && region.observedValues.some((item) => sameText(item, value)));
    if (list) siblings[path] = list.observedValues.filter((item) => !sameText(item, value));
  }
  return {
    snapshot: {
      schemaVersion: "1.0",
      generationTaskId: input.generationTaskId,
      siteId: input.siteId,
      explorationMode: "evidence-only",
      regions,
      actions: actions.slice(0, 32),
    },
    siblings,
  };
}
