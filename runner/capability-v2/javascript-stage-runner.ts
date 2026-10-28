import { applyCapabilityInputAliases as applyAliases } from "../../lib/capability-center-v2/run-resolution";
import { capabilityNavigationKind } from "../../lib/capability-center-v2/navigation";
import { executeBrowserCapabilityStage } from "../../lib/capability-center-v2/browser-stage-sdk";
import type { BrowserContext, Frame, Page } from "playwright";
import type {
  CapabilityProgram,
  CapabilityStageEvidence,
  CapabilityStageOutcome,
  CapabilityStageResult,
  CapabilityStageManifest,
  CapabilityControlFlow,
  JsonObject,
  JsonValue,
} from "../../lib/capability-center-v2/model";
import * as control from "../../lib/capability-center-v2/control-flow";
import {
  assertCapabilityNavigationUrl,
  assertCapabilityStageResultIO,
  normalizeCapabilityStageIO,
  normalizeCapabilityStageNavigation,
  capabilityPathAllowed,
} from "../../lib/capability-center-v2/stage-io";
import { assertBrowserModuleUrlForPage } from "./module-delivery";

export type JavaScriptStageReceipt = {
  stageId: string;
  stageIndex: number;
  status: "Started" | "Completed";
  urlBefore: string;
  urlAfter?: string;
  outcome?: CapabilityStageOutcome;
  signal?: string;
  iteration?: number;
  evidence?: CapabilityStageEvidence[];
  durationMs?: number;
};

export type JavaScriptStageRunResult = {
  page: Page;
  outcome: Exclude<CapabilityStageOutcome, "Continue">;
  reason?: string;
  output: JsonObject;
  state: JsonObject;
  evidence: CapabilityStageEvidence[];
  receipts: JavaScriptStageReceipt[];
  /** Control-flow metadata exported by the executable module. */
  controlFlow?: CapabilityControlFlow;
  /** Signal-to-stage maps exported by the executable module. */
  stageTransitions?: Array<Record<string, string> | undefined>;
  /** Exact executable metadata accepted by C1 and frozen for C2/C3. */
  stageManifest?: CapabilityStageManifest[];
  /** Host-observed body text captured immediately after terminal Success. */
  observedText?: string;
};

/**
 * Project physical runner receipts into the logical C3 StageReceipt shape.
 * Started receipts are lifecycle bookkeeping, not failures.  A completed
 * Continue means the stage executed successfully and handed control to the
 * next stage, so it must be represented as Success at the module boundary.
 */
export function projectStageReceipts(
  receipts: JavaScriptStageReceipt[],
  evidenceRefs: string[] = [],
) {
  return receipts
    .filter((receipt) => receipt.status === "Completed")
    .map((receipt) => ({
      stageId: receipt.stageId,
      outcome: receipt.outcome === "Success" || receipt.outcome === "Continue"
        ? "Success" as const
        : receipt.outcome === "NoResult"
          ? "NoResult" as const
          : receipt.outcome === "BusinessRejection" || receipt.outcome === "Ambiguous"
            ? "BusinessRejection" as const
            : "Failed" as const,
      evidenceRefs: [...evidenceRefs],
      ...(receipt.signal ? { signal: receipt.signal } : {}),
      ...(receipt.iteration !== undefined ? { iteration: receipt.iteration } : {}),
    }));
}

export class JavaScriptStageRunError extends Error {
  constructor(message: string, readonly receipts: JavaScriptStageReceipt[], readonly causeValue?: unknown) {
    super(message); this.name = "JavaScriptStageRunError";
  }
}

export class JavaScriptModuleLoadError extends Error {
  readonly code = "module_load_failed";
  readonly authorRepairable = false;
  readonly taskRetryable = true;

  constructor(message: string, readonly receipts: JavaScriptStageReceipt[], options?: { cause?: unknown }) {
    super(`module_load_failed:${message}`, options);
    this.name = "JavaScriptModuleLoadError";
  }
}

export function isJavaScriptModuleLoadFailure(error: unknown) {
  return error instanceof JavaScriptModuleLoadError;
}

function moduleLoadError(error: unknown, receipts: JavaScriptStageReceipt[]) {
  const message = error instanceof Error ? error.message : String(error);
  return new JavaScriptModuleLoadError(message, receipts, { cause: error });
}

function browserImportError(name: string, message: string, receipts: JavaScriptStageReceipt[]) {
  const error = new Error(`${name || "Error"}: ${message}`);
  error.name = name || "Error";
  if (name === "TypeError" && /failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module/i.test(message)) {
    throw moduleLoadError(error, receipts);
  }
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Convert user-facing values to site-language terms learned during discovery. */
export function applyCapabilityInputAliases(program: CapabilityProgram, input: JsonObject): JsonObject {
  return applyAliases(program.inputAliases, input) as JsonObject;
}

/**
 * A product-detail page may contain related cards whose variant links look
 * exactly like the primary product's controls.  A write-stage transition
 * from one detail pathname to another is therefore not an acceptable way to
 * apply a facet: it silently changes the business target.  Legitimate
 * target selection starts from a listing/search page, and same-product
 * variant changes keep the pathname and only update the hash/query.
 */
export function isSuspiciousDetailTransition(urlBefore: string, urlAfter: string, stageId: string) {
  if (!urlBefore || !urlAfter || urlBefore === urlAfter) return false;
  let before: URL;
  let after: URL;
  try {
    before = new URL(urlBefore);
    after = new URL(urlAfter);
  } catch {
    return false;
  }
  if (before.origin !== after.origin) return false;
  const beforeDetail = /\.html$/iu.test(before.pathname);
  const afterDetail = /\.html$/iu.test(after.pathname);
  if (!beforeDetail || !afterDetail || before.pathname === after.pathname) return false;
  // Selecting a target from a result/detail link is allowed; a subsequent
  // stage must not leave the already selected detail page for another one.
  return !/(?:resolve|select[_-]?target|open[_-]?target|navigate[_-]?target)/iu.test(stageId);
}

/**
 * A matching detail page can still be non-executable (for example it may
 * require an unprovided customization).  When a read/selection stage reports
 * NoResult before any write has happened, return to the previous result page
 * so the next generated Stage can choose another matching executable object.
 * This uses browser history rather than a site-specific search route.
 */
export async function recoverUnavailableDetailTarget(page: Page, stageId: string, outcome: CapabilityStageOutcome) {
  if (outcome !== "NoResult" && outcome !== "BusinessRejection") return false;
  if (/stage_verify|verify|receipt|success/iu.test(stageId)) return false;
  let current: URL;
  try { current = new URL(page.url()); } catch { return false; }
  if (!/\.html$/iu.test(current.pathname)) return false;
  const before = page.url();
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => undefined);
  return page.url() !== before;
}

/** Reconcile punctuation-free user values with visible option/menu labels. */
export async function reconcileVisibleCapabilityOptions(input: JsonObject, page: Page): Promise<JsonObject> {
  const comparable = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[到至]/gu, "to").replace(/[\s\p{P}\p{S}]+/gu, "");
  const options = page.locator("option,[role='option'],[role='menuitem']");
  const resolved: JsonObject = { ...input };
  for (const [name, value] of Object.entries(input)) {
    if (!/(?:sort|order|filter|option|choice|select|color|colour|material|size|variant|currency|排序|筛选|颜色|材质|尺码|货币)/iu.test(name)) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    const needle = comparable(value);
    if (!needle) continue;
    const count = await options.count();
    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);
      if (!(await option.isVisible().catch(() => false))) continue;
      const label = ((await option.textContent().catch(() => "")) || (await option.getAttribute("aria-label").catch(() => "")) || "").trim();
      const comparableLabel = comparable(label);
      if (label && (comparableLabel === needle || (needle.length >= 2 && (comparableLabel.includes(needle) || needle.includes(comparableLabel)))) && label !== value) {
        resolved[name] = label;
        break;
      }
    }
  }
  return resolved;
}

/**
 * Recover from a detail page whose primary write control is disabled.
 *
 * A generated module can legitimately discover a product detail URL before it
 * learns that the product needs an unprovided prerequisite (custom text,
 * configuration, etc.).  Replaying the same disabled click is not useful and
 * can make authoring loop forever.  When the capability has an explicit
 * target-selection stage, use the browser's real history to return to the
 * result list and choose another enabled product card whose visible identity
 * matches the resolved target input.  This is a generic runner safety guard:
 * it uses only DOM semantics and input values, never a site URL, product id or
 * hard-coded label.
 */
async function recoverDisabledProductDetail(
  page: Page,
  input: JsonObject,
  program: CapabilityProgram,
  stageId: string,
): Promise<boolean> {
  if (/(?:resolve|select)[_-]?target/iu.test(stageId)) return false;
  const detailState = await page.evaluate(`(() => {
    const label = (element) => ((element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || "")).replace(/\\s+/g, " ").trim();
    const controls = [...document.querySelectorAll("button,a,[role='button']")].filter((element) => /add\\s*to\\s*cart|加入购物车|添加到购物车/i.test(label(element)));
    const hasDetail = Boolean(document.querySelector("h1,[name='id_product'],[data-product-id],.product__actions"));
    // Related product cards are often rendered in the same document.  Only
    // controls owned by the primary product form/detail region can determine
    // whether the current detail is executable; an enabled related-card
    // button must not mask a disabled primary control.
    const primary = controls.filter((element) => {
      // Commerce templates frequently expose a stable action data attribute
      // while the surrounding form has a semantic URL unrelated to cart
      // submission. Prefer that DOM business marker, but still exclude
      // article/list containers so related cards cannot mask the primary
      // detail control.
      if (element.matches("[data-button-action='add-to-cart']")
        && !element.closest("article,li,[role='listitem'],[data-testid]")) return true;
      const form = element.closest("form");
      if (form && /cart|basket|bag|checkout/i.test(form.getAttribute("action") || "")) return true;
      const region = element.closest("main,[role='main'],[data-product-id],[itemprop='mainEntity'],.product__container,.product-container,[id*='product']");
      if (!region) return false;
      return !element.closest("article,li,[role='listitem'],[data-testid]");
    });
    const primaryAction = primary.find((element) => element.matches("[data-button-action='add-to-cart']"));
    const disabled = primaryAction
      ? (primaryAction.hasAttribute("disabled") || primaryAction.getAttribute("aria-disabled") === "true")
      : primary.length > 0 && primary.every((element) => element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true");
    return { hasDetail, disabled };
  })()`) as { hasDetail: boolean; disabled: boolean };
  if (!detailState.hasDetail || !detailState.disabled) return false;
  const previousUrl = page.url();
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
  if (page.url() === previousUrl) return false;
  await page.waitForTimeout(200);
  const targetValues = Object.entries(input)
    .filter(([key, value]) => typeof value === "string" && String(value).trim() && /product|item|keyword|query|search|category|商品|产品|物品|关键词|类别/iu.test(key))
    .map(([, value]) => String(value).trim());
  if (!targetValues.length) return false;
  const findEnabledHref = async (): Promise<string | null> => await page.evaluate(`((values) => {
    const normalize = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[\\s\\p{P}\\p{S}]+/gu, "");
    const wanted = values.map(normalize).filter((value) => value.length >= 2);
    const containers = [...document.querySelectorAll("article,li,[role='listitem'],[data-testid]")];
    for (const container of containers) {
      const containerText = normalize(container.textContent || "");
      if (!wanted.some((value) => containerText.includes(value))) continue;
      const enabled = [...container.querySelectorAll("button,a,[role='button']")].find((element) => {
        const label = ((element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || "")).replace(/\\s+/g, " ").trim();
        return /add\\s*to\\s*cart|加入购物车|添加到购物车/i.test(label)
          && !element.hasAttribute("disabled")
          && element.getAttribute("aria-disabled") !== "true";
      });
      if (!enabled) continue;
      const link = [...container.querySelectorAll("a[href]")].find((element) => {
        const href = element.getAttribute("href") || "";
        return href && !/quickview|javascript:/iu.test(href) && !element.hasAttribute("data-ps-action");
      });
      if (link) return link.href || link.getAttribute("href");
    }
    return null;
  })(${JSON.stringify(targetValues)})`) as string | null;
  let href = await findEnabledHref();
  // The authored target stage may have opened a concrete detail directly
  // from a landing page, leaving no searchable sibling in browser history.
  // If the previous document exposes a real search form, derive its action
  // and query key from the DOM and perform one generic search recovery. This
  // deliberately avoids a site-specific `/search` route or parameter name.
  if (!href) {
    const searchForm = await page.evaluate(`(() => {
      const text = (element) => ((element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.getAttribute("name") || "")).toLocaleLowerCase();
      for (const form of [...document.querySelectorAll("form")]) {
        const input = [...form.querySelectorAll("input")].find((candidate) => {
          const type = (candidate.getAttribute("type") || "text").toLocaleLowerCase();
          return !["hidden", "submit", "button"].includes(type) && /search|query|keyword|商品|搜索|查找/iu.test(text(candidate));
        });
        if (input) return { action: form.getAttribute("action") || location.href, method: (form.getAttribute("method") || "get").toLocaleLowerCase(), name: input.getAttribute("name") || "q" };
      }
      return null;
    })()`) as { action: string; method: string; name: string } | null;
    if (searchForm && searchForm.method === "get") {
      const searchUrl = new URL(searchForm.action, page.url());
      searchUrl.searchParams.set(searchForm.name, targetValues[0]);
      await page.goto(searchUrl.href, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(200);
      href = await findEnabledHref();
    }
  }
  if (!href) return false;
  const absolute = new URL(href, page.url()).href;
  await page.goto(absolute, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(200);
  return true;
}

/**
 * If a generated target-selection stage is overly conservative and returns
 * NoResult on a settled result page, use the live page evidence as a bounded
 * host-side recovery.  This is not a site fixture: candidate identity comes
 * from the public input, the dynamic href comes from the current DOM, and an
 * enabled business-action control is preferred.  The authored module still
 * performs the subsequent detail/facet verification and final success check.
 */
async function recoverSearchResultTarget(page: Page, input: JsonObject, stageId: string): Promise<boolean> {
  if (!/(?:resolve|select)[_-]?target|search/iu.test(stageId)) return false;
  const values = Object.entries(input)
    .filter(([key, value]) => typeof value === "string" && String(value).trim() && /product|item|keyword|query|search|category|type|商品|产品|物品|关键词|类别|分类/iu.test(key))
    .map(([, value]) => String(value).trim())
    .filter((value) => value.length >= 2);
  if (!values.length) return false;
  const recovered = await page.evaluate(`((values) => {
    const normalize = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[\\s\\p{P}\\p{S}]+/gu, "");
    const wanted = values.map(normalize).filter((value) => value.length >= 2);
    const label = (element) => ((element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || "")).replace(/\\s+/g, " ").trim();
    const containers = [...document.querySelectorAll("article,li,[role='listitem'],[data-testid],[data-product-id]")];
    const candidates = containers.flatMap((container) => {
      const text = normalize(label(container) + " " + (container.textContent || ""));
      if (!wanted.some((value) => text.includes(value))) return [];
      const add = [...container.querySelectorAll("button,a,[role='button']")].find((element) => /add\\s*to\\s*cart|加入购物车|添加到购物车/i.test(label(element)) && !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true");
      const links = [...container.querySelectorAll("a[href]")].filter((element) => {
        const href = element.getAttribute("href") || "";
        return href && !/quickview|javascript:|#|cart|login/iu.test(href) && /\\.html(?:$|[?#])/iu.test(href);
      });
      const link = links.find((element) => /view|detail|product|商品|详情/iu.test(label(element))) || links[0];
      if (!link) return [];
      return [{ href: link.href || link.getAttribute("href"), enabledAction: Boolean(add), text: (container.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 240) }];
    });
    candidates.sort((left, right) => Number(right.enabledAction) - Number(left.enabledAction));
    return candidates[0]?.href || null;
  })(${JSON.stringify(values)})`) as string | null;
  if (!recovered) return false;
  const absolute = new URL(recovered, page.url()).href;
  await page.goto(absolute, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(200);
  return true;
}

function assertJson(value: unknown, path: string): asserts value is JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
  if (Array.isArray(value)) { value.forEach((item, index) => assertJson(item, `${path}.${index}`)); return; }
  if (isRecord(value)) { for (const [key, item] of Object.entries(value)) assertJson(item, `${path}.${key}`); return; }
  throw new Error(`capability_stage_non_json:${path}`);
}

function normalizeStageResult(value: unknown, manifest: CapabilityProgram["stages"][number]): CapabilityStageResult {
  const stageId = manifest.id;
  if (!isRecord(value)) throw new Error(`capability_stage_result_invalid:${stageId}`);
  const outcomes = new Set<CapabilityStageOutcome>(["Continue", "Success", "NoResult", "Ambiguous", "BusinessRejection"]);
  if (!outcomes.has(value.outcome as CapabilityStageOutcome)) throw new Error(`capability_stage_outcome_invalid:${stageId}`);
  const state = value.state === undefined ? undefined : value.state;
  const output = value.output === undefined ? undefined : value.output;
  const evidence = value.evidence === undefined ? undefined : value.evidence;
  const signal = value.signal === undefined ? undefined : value.signal;
  const navigation = value.navigation === undefined ? undefined : value.navigation;
  if (signal !== undefined && (typeof signal !== "string" || !signal.trim())) throw new Error(`capability_stage_signal_invalid:${stageId}`);
  if (state !== undefined && !isRecord(state)) throw new Error(`capability_stage_state_invalid:${stageId}`);
  if (output !== undefined && !isRecord(output)) throw new Error(`capability_stage_output_invalid:${stageId}`);
  if (evidence !== undefined && !Array.isArray(evidence)) throw new Error(`capability_stage_evidence_invalid:${stageId}`);
  assertJson(value as unknown, `stage.${stageId}`);
  const result = value as unknown as CapabilityStageResult;
  if (result.outcome === "Success" && !result.output) throw new Error(`capability_stage_success_output_required:${stageId}`);
  if (["NoResult", "Ambiguous", "BusinessRejection"].includes(result.outcome) && !result.reason?.trim()) throw new Error(`capability_stage_reason_required:${stageId}`);
  assertCapabilityStageResultIO(manifest, result, stageId);
  return result;
}

function destroyedContext(error: unknown) {
  return /execution context was destroyed|target page, context or browser has been closed|frame was detached/i.test(error instanceof Error ? error.message : String(error));
}

async function moduleShape(page: Page, moduleUrl: string) {
  const result = await page.evaluate(async (url) => {
    // Some site bundles and esbuild-transformed snippets reference the small
    // __name helper.  Runner pages are browser contexts, not the bundler
    // runtime, so provide the standard identity-compatible implementation
    // before importing a candidate module.
    const pageWindow = window as Window & { __name?: (fn: unknown, name?: string) => unknown };
    if (typeof pageWindow.__name !== "function") pageWindow.__name = (fn) => fn;
    let loaded: { capability?: { version?: number; stages?: Array<{ id?: string; run?: unknown; transitions?: unknown; io?: unknown; navigation?: unknown }>; controlFlow?: unknown } } | undefined;
    try {
      let lastError: unknown;
      let firstError: unknown;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const candidate = attempt === 0 ? url : `${url}${url.includes("?") ? "&" : "?"}capability_retry=${attempt}`;
        try { loaded = await import(/* @vite-ignore */ candidate) as typeof loaded; break; }
        catch (error) {
          firstError ??= error;
          lastError = error;
          if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
        }
      }
      if (!loaded) {
        let transport = "";
        try {
          const probe = await fetch(url, { cache: "no-store" });
          transport = `; fetch=${probe.status}; contentType=${probe.headers.get("content-type") || ""}`;
        } catch (probeError) {
          transport = `; fetchError=${probeError instanceof Error ? probeError.message : String(probeError)}`;
        }
        const sourceError = firstError || lastError;
        const source = sourceError instanceof Error ? sourceError.message : String(sourceError || "capability_module_load_failed");
        const wrapped = new Error(`${source}${transport}; pageOrigin=${location.origin}`);
        wrapped.name = sourceError instanceof Error ? sourceError.name : "Error";
        throw wrapped;
      }
    } catch (error) {
      return {
        kind: "module-import-error" as const,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const capability = loaded.capability;
    if (capability?.version !== 2 || !Array.isArray(capability.stages) || !capability.stages.length) throw new Error("capability_module_invalid");
    return {
      kind: "ok" as const,
      stageTransitions: capability.stages.map((stage, index) => {
        if (!stage?.id || typeof stage.run !== "function") throw new Error(`capability_stage_invalid:${index}`);
        if (stage.transitions === undefined) return { id: stage.id, io: stage.io, navigation: stage.navigation };
        if (!stage.transitions || typeof stage.transitions !== "object" || Array.isArray(stage.transitions)) throw new Error(`capability_stage_transitions_invalid:${index}`);
        const transitions = Object.fromEntries(Object.entries(stage.transitions).map(([signal, target]) => {
          if (!signal.trim() || typeof target !== "string" || !target.trim()) throw new Error(`capability_stage_transition_invalid:${index}`);
          return [signal.trim(), target.trim()];
        }));
        return Object.keys(transitions).length ? { id: stage.id, transitions, io: stage.io, navigation: stage.navigation } : { id: stage.id, io: stage.io, navigation: stage.navigation };
      }),
      controlFlow: capability.controlFlow,
    };
  }, moduleUrl);
  if (result.kind === "module-import-error") browserImportError(result.name, result.message, []);
  const exportedStages = result.stageTransitions || [];
  return {
    ...result,
    stageIds: exportedStages.map((stage) => stage?.id || ""),
    stageTransitions: exportedStages.map((stage) => stage?.transitions),
    stageIO: exportedStages.map((stage) => stage?.io),
    stageNavigation: exportedStages.map((stage) => stage?.navigation),
  };
}

/**
 * In a self-test, how long any one wait inside a stage may go unmet. The
 * explored path replays each step in about a second; a wait still unmet
 * after this is waiting for something that will not happen.
 */
const SELF_TEST_WAIT_CAP_MS = 15_000;

async function executeStage(
  page: Page,
  moduleUrl: string,
  stageIndex: number,
  input: JsonObject,
  state: JsonObject,
  receipts: JavaScriptStageReceipt[],
  deadlineAt: number,
  manifest: CapabilityProgram["stages"][number],
  waitCapMs?: number,
): Promise<{ value: unknown; observedText?: string }> {
  try {
    const execution = page.evaluate(executeBrowserCapabilityStage, JSON.stringify({
      ...(waitCapMs ? { waitCapMs } : {}),
      moduleUrl, index:stageIndex, input, state,
      inputPaths:manifest.io.reads.input, statePaths:manifest.io.reads.state,
      stageId:manifest.id, deadlineAt:new Date(deadlineAt).toISOString(),
    }));
    // The browser timer cannot interrupt synchronous generated JavaScript.
    // Keep an independent host deadline; the caller closes the isolated context.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The in-page kernel rejects at the deadline naming the wait that never
      // settled; this host gate only covers synchronous code that never yields,
      // so it fires 1.5s later and lets the detailed rejection win.
      const timeout = new Promise<never>((_,reject) => {timer=setTimeout(()=>reject(new Error('capability_control_flow_timeout')),Math.max(1,deadlineAt-Date.now()+1_500));});
      const value = await Promise.race([execution,timeout]);
      return {value,observedText:await page.locator('body').innerText()};
    } finally {if(timer)clearTimeout(timer);}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timeoutAt = message.indexOf("capability_control_flow_timeout");
    if (timeoutAt >= 0) throw new Error(message.slice(timeoutAt).split("\n")[0]);
    if (/Failed to fetch dynamically imported module|Importing a module script failed/.test(message)) browserImportError('TypeError',message,receipts);
    throw error;
  }
}

export async function runCapabilityJavaScriptStages(options: {
  page: Page;
  moduleUrl: string;
  program: CapabilityProgram;
  input: JsonObject;
  initialState?: JsonObject;
  /** Only C1 DraftReplay may discover graph metadata from the authored module. */
  allowModuleGraphAdoption?: boolean;
  /** C1 public Contract inputs; never runner context or credentials. */
  draftInputPaths?: string[];
  transitionGraceMs?: number;
  transitionNetworkIdleMs?: number;
  /** Upper bound on waiting for the page to go quiet before the first stage; 0 disables it. */
  settleBeforeFirstStageMs?: number;
  /**
   * Cap on the whole run's wall clock, tighter than the program's own
   * totalTimeoutMs. Authoring self-tests use it: a wait that never settles
   * should cost a minute of feedback, not the full production budget.
   */
  deadlineCapMs?: number;
  onReceipt?: (page: Page, receipt: JavaScriptStageReceipt) => void | Promise<void>;
}): Promise<JavaScriptStageRunResult> {
  let page = options.page;
  assertBrowserModuleUrlForPage(page.url(), options.moduleUrl);
  const context: BrowserContext = page.context();
  const moduleShapeResult = await moduleShape(page, options.moduleUrl);
  const manifestIds = options.program.stages.map((stage) => stage.id);
  if (JSON.stringify(moduleShapeResult.stageIds) !== JSON.stringify(manifestIds)) throw new JavaScriptStageRunError("capability_stage_manifest_mismatch", []);
  const manifestTransitions = options.program.stages.map((stage) => stage.transitions);
  const manifestIO = options.program.stages.map((stage) => normalizeCapabilityStageIO(stage.io));
  const manifestNavigation = options.program.stages.map((stage) => normalizeCapabilityStageNavigation(stage.navigation));
  const moduleTransitions = moduleShapeResult.stageTransitions;
  const moduleIO = moduleShapeResult.stageIO.map((value) => normalizeCapabilityStageIO(value));
  const moduleNavigation = moduleShapeResult.stageNavigation.map((value) => normalizeCapabilityStageNavigation(value));
  const moduleControlFlow = moduleShapeResult.controlFlow || null;
  const programControlFlow = options.program.controlFlow || null;
  const graphMatches = control.capabilityJsonEqual(moduleTransitions, manifestTransitions)
    && control.capabilityJsonEqual(moduleIO, manifestIO)
    && control.capabilityJsonEqual(moduleNavigation, manifestNavigation)
    && control.capabilityJsonEqual(moduleControlFlow, programControlFlow);
  if (!graphMatches && !options.allowModuleGraphAdoption) {
    throw new JavaScriptStageRunError("capability_stage_transition_manifest_mismatch", []);
  }
  if (options.allowModuleGraphAdoption
    && (options.program.stages.some((stage) => stage.transitions) || options.program.controlFlow)
    && !graphMatches) {
    throw new JavaScriptStageRunError("capability_control_flow_manifest_mismatch", []);
  }
  const programStages = options.program.stages.map((stage, index): CapabilityStageManifest => {
    if (!options.allowModuleGraphAdoption) return stage;
    const io = moduleIO[index];
    const navigation = moduleNavigation[index];
    if (!io || (navigation !== "none" && navigation !== "optional" && navigation !== "required")) {
      throw new JavaScriptStageRunError(`capability_stage_metadata_invalid:${stage.id}`, []);
    }
    const allowedInputs = options.draftInputPaths || Object.keys(options.input);
    for (const path of io.reads.input) {
      if (!capabilityPathAllowed(path, allowedInputs)) {
        throw new JavaScriptStageRunError(`capability_stage_input_outside_contract:${stage.id}:${path}`, []);
      }
    }
    return { ...stage, io, navigation,
      ...(moduleTransitions[index] ? { transitions: moduleTransitions[index] } : {}) };
  });
  const program = {
    ...options.program,
    stages: programStages,
    ...(options.allowModuleGraphAdoption && !options.program.controlFlow && moduleShapeResult.controlFlow
      ? { controlFlow: moduleShapeResult.controlFlow as CapabilityControlFlow }
      : {}),
  };
  const effectiveInput = applyCapabilityInputAliases(program, options.input);
  // Running the first stage right after goto means running before an SPA has
  // hydrated: the form is plain HTML, submit is a native GET, and an input without
  // a name carries nothing (one production self-test landed on `/?` this way). A
  // real visitor triggers a capability on a page that is long alive; waiting for
  // the network to go quiet puts self-tests and production at the same starting
  // point. Past the cap, run anyway.
  const settleMs = options.settleBeforeFirstStageMs ?? 5_000;
  if (settleMs > 0) await page.waitForLoadState("networkidle", { timeout: settleMs }).catch(() => undefined);
  const state: JsonObject = { ...(options.initialState || {}) };
  const receipts: JavaScriptStageReceipt[] = [];
  const evidence: CapabilityStageEvidence[] = [];
  let cursor = control.createCapabilityExecutionCursor(program);
  const capped = (deadline: number) => options.deadlineCapMs ? Math.min(deadline, cursor.startedAt + options.deadlineCapMs) : deadline;
  const totalTimeoutMs = () => options.deadlineCapMs ? Math.min(control.capabilityControlFlowLimits(program).totalTimeoutMs, options.deadlineCapMs) : control.capabilityControlFlowLimits(program).totalTimeoutMs;
  const totalStartedAt = Date.now();

  while (cursor.currentStageId) {
    if (Date.now() - totalStartedAt > totalTimeoutMs()) {
      throw new JavaScriptStageRunError("capability_program_timeout", receipts);
    }
    const stageIndex = program.stages.findIndex((stage) => stage.id === cursor.currentStageId);
    if (stageIndex < 0) throw new JavaScriptStageRunError(`capability_stage_not_found:${cursor.currentStageId}`, receipts);
    const manifest = program.stages[stageIndex];
    cursor = control.beginCapabilityStage(program, cursor, manifest.id, state);
    // Resolve punctuation-free user values while the current stage's menu is
    // visible, before a navigation checkpoint can carry the input forward.
    const stageInput = await reconcileVisibleCapabilityOptions(effectiveInput, page);
    Object.assign(effectiveInput, stageInput);
    await recoverDisabledProductDetail(page, effectiveInput, options.program, manifest.id);
    const urlBefore = page.url(); const startedAt = Date.now();
    const started: JavaScriptStageReceipt = { stageId: manifest.id, stageIndex, status: "Started", urlBefore, iteration: control.capabilityStageIteration(program, cursor, manifest.id) };
    receipts.push(started); await options.onReceipt?.(page, started);
    let openedPage: Page | undefined; let navigated = false;
    const onPage = (candidate: Page) => { if (candidate !== page) openedPage = candidate; };
    const onFrame = (frame: Frame) => { if (frame.page() === page && frame.parentFrame() === null) navigated = true; };
    context.on("page", onPage); page.on("framenavigated", onFrame);
    let rawResult: unknown; let stageObservedText: string | undefined; let lostContext = false;
    try {
      try {
        const deadlineAt = capped(control.capabilityStageDeadline(program, cursor, manifest.id));
        control.assertCapabilityControlFlowBudget(program, cursor, Date.now());
        const executed = await executeStage(page, options.moduleUrl, stageIndex, stageInput, { ...state }, receipts, deadlineAt, manifest, options.deadlineCapMs ? SELF_TEST_WAIT_CAP_MS : undefined);
        rawResult = executed.value;
        stageObservedText = executed.observedText;
      }
      catch (error) {
        if (isJavaScriptModuleLoadFailure(error)) throw error;
        // A read Stage that waited for something the page never showed has
        // found no result, not suffered a fault. The keyword search whose
        // empty-results page is laid out differently from a page of results
        // waited for a paragraph that was never going to appear, and a
        // capability that answers 「那天没有数据」 correctly was refused for it.
        // Only a Stage that changes nothing may end this way, and only when it
        // was waiting: a crash, a schema violation or a write Stage that
        // stalled is still a fault.
        const waited = error instanceof Error && new RegExp(`^capability_control_flow_timeout:${manifest.id}:pending=`, "u").test(error.message);
        if (waited && manifest.effect === "read") {
          rawResult = { outcome: "NoResult", reason: `waited_without_result:${error.message.split("pending=")[1]?.slice(0, 80) || manifest.id}` };
        } else {
          if (!destroyedContext(error)) throw error;
          lostContext = true;
        }
      }
      // Host-managed navigation is asynchronous: the authored Stage returns
      // a navigation intent, while the host commits the result before it
      // changes the destination URL. A short grace period lets the browser
      // finish a direct DOM transition before the next Stage reads the page.
      // Wait for navigation-capable stages to actually cross documents before
      // allowing the following stage to inspect the page.  This is runner
      // orchestration only; the public Stage I/O envelope remains unchanged.
      // A generated module may put a dynamic product navigation in an
      // ordinary numbered stage (for example `stage_3`), so the stage id is
      // not a reliable indication that the next stage must wait.  The host
      // navigation wrapper records the actual request and gives the browser a
      // chance to cross documents before the following stage reads the DOM.
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (openedPage) {
        const target = openedPage.url();
        await openedPage.close().catch(() => undefined);
        throw new Error(`capability_stage_direct_navigation_forbidden:${manifest.id}:new_window:${target}; use the intended in-page business target, not its nested source/share link`);
      }
      else if (navigated || page.url() !== urlBefore) await page.waitForLoadState("domcontentloaded", { timeout: 20_000 });
      if (openedPage || navigated || page.url() !== urlBefore) {
        await page.waitForLoadState("networkidle", { timeout: options.transitionNetworkIdleMs ?? 1_500 }).catch(() => undefined);
        await page.waitForTimeout(options.transitionGraceMs ?? 350);
      }
      control.assertCapabilityControlFlowBudget(program, cursor, Date.now());
    } catch (error) {
      if (error instanceof JavaScriptModuleLoadError) throw error;
      throw new JavaScriptStageRunError(error instanceof Error ? error.message : String(error), receipts, error);
    } finally {
      context.off("page", onPage); page.off("framenavigated", onFrame);
    }

    const transitioned = Boolean(openedPage || navigated || page.url() !== urlBefore);
    // The document was unloaded before the stage returned. When that follows a
    // real cross-document transition (a search button, a form submit, the site's
    // own navigation) it is an ordinary transition: the stage's return value is
    // lost and execution continues. Losing the context without any transition is
    // the anomaly. This used to report direct_navigation_forbidden for both —
    // branding the correct "click, then wait for the results page" as a violation
    // and steering the model toward constructing URLs. Scripts that assign
    // location directly are caught by the build-time check
    // (capability_module_direct_navigation_forbidden).
    if (lostContext && !transitioned) throw new JavaScriptStageRunError(`capability_stage_context_lost:${manifest.id}`, receipts);
    if (lostContext && (program.controlFlow || manifest.transitions)) {
      throw new JavaScriptStageRunError(`capability_stage_context_lost_before_result:${manifest.id}`, receipts);
    }
    if (transitioned && isSuspiciousDetailTransition(urlBefore, page.url(), manifest.id)) {
      throw new JavaScriptStageRunError(`capability_stage_related_target_navigation:${manifest.id}`, receipts);
    }
    let result = lostContext ? ({ outcome: "Continue" } satisfies CapabilityStageResult) : normalizeStageResult(rawResult, manifest);
    // Continue means "go on to the next stage", so it is not an answer the
    // last stage may give. The recoveries below exist to carry an unfinished
    // search forward; applied to the final stage they turned the program's own
    // terminal answer into Continue, the loop ran out of stages, and the run
    // failed with capability_output_missing — twice in a row, for a program
    // that had answered correctly, so authoring gave up on it.
    const hasNextStage = stageIndex < program.stages.length - 1;
    if (hasNextStage && !lostContext && await recoverUnavailableDetailTarget(page, manifest.id, result.outcome)) {
      result = { outcome: "Continue" } satisfies CapabilityStageResult;
    }
    // A conservative model may return NoResult before trying the live
    // evidence recovery above.  Only a matching dynamic result-card href can
    // turn that into Continue; no arbitrary first link is accepted.
    if (hasNextStage && !lostContext && (result.outcome === "NoResult" || result.outcome === "BusinessRejection")) {
      const recovered = await recoverSearchResultTarget(page, stageInput, manifest.id).catch(() => false);
      if (recovered) result = { outcome: "Continue" } satisfies CapabilityStageResult;
    }
    // A final verification stage is read-only, but commerce toasts and cart
    // summaries are commonly committed a little after the click. Retry only
    // this terminal read when it reports a transient absence; action stages
    // are never replayed, so side effects remain at-most-once.
    if (!lostContext && manifest.id === "stage_verify" && (result.outcome === "NoResult" || result.outcome === "BusinessRejection")) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await page.waitForTimeout(500);
        const deadlineAt = capped(control.capabilityStageDeadline(program, cursor, manifest.id));
        control.assertCapabilityControlFlowBudget(program, cursor, Date.now());
        const retryExecuted = await executeStage(page, options.moduleUrl, stageIndex, stageInput, { ...state }, receipts, deadlineAt, manifest, options.deadlineCapMs ? SELF_TEST_WAIT_CAP_MS : undefined);
        stageObservedText = retryExecuted.observedText || stageObservedText;
        const retryResult = normalizeStageResult(retryExecuted.value, manifest);
        result = retryResult;
        if (retryResult.outcome !== "NoResult" && retryResult.outcome !== "BusinessRejection") break;
      }
    }
    if (result.state) Object.assign(state, result.state);
    if (result.evidence) evidence.push(...result.evidence);
    control.assertCapabilityControlFlowBudget(program, cursor, Date.now());
    const completedIteration = control.capabilityStageIteration(program, cursor, manifest.id);
    if (result.outcome !== "Continue" && result.navigation) {
      throw new JavaScriptStageRunError(`capability_navigation_terminal_outcome:${manifest.id}`, receipts);
    }
    if (result.outcome === "Continue") {
      cursor = control.resolveCapabilityStageTransition(program, cursor, manifest.id, result.signal, state);
    }
    if (result.navigation) {
      const destination = assertCapabilityNavigationUrl(page.url(), result.navigation, manifest.id);
      const targetPage = page;
      const navigationDeadline = cursor.currentStageId
        ? capped(control.capabilityStageDeadline(program, cursor, cursor.currentStageId))
        : cursor.startedAt + totalTimeoutMs();
      const navigationTimeout = Math.max(1, Math.min(30_000, navigationDeadline - Date.now()));
      try {
        if (capabilityNavigationKind(targetPage.url(), destination) === "new-document") {
          await targetPage.goto(destination, { waitUntil: "domcontentloaded", timeout: navigationTimeout });
        } else {
          // Match the user SDK: an SPA may already have reached this URL.
          // Reloading here hides state-loss bugs and is not equivalent validation.
          await targetPage.evaluate((url) => {
            const target = new URL(url, location.href);
            if (target.hash !== location.hash) location.hash = target.hash;
          }, destination);
        }
        await targetPage.waitForLoadState("networkidle", { timeout: Math.min(options.transitionNetworkIdleMs ?? 1_500, navigationTimeout) }).catch(() => undefined);
        await targetPage.waitForTimeout(Math.min(options.transitionGraceMs ?? 350, Math.max(1, navigationDeadline - Date.now())));
      } catch (error) {
        // The host's own wait, not the module's. Reported under the code a
        // module-authored wait uses, it sent the author to rewrite waits it
        // had no way to be wrong about: the page simply took too long to
        // open. The cause was captured here and dropped from the message, so
        // nothing downstream could tell the two apart.
        if (Date.now() >= navigationDeadline) {
          const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 160);
          throw new JavaScriptStageRunError(`capability_navigation_timeout:${manifest.id}:${destination}:${detail}`, receipts, error);
        }
        throw new JavaScriptStageRunError(error instanceof Error ? error.message : String(error), receipts, error);
      }
      control.assertCapabilityControlFlowBudget(program, cursor, Date.now());
    }
    const completed: JavaScriptStageReceipt = {
      stageId: manifest.id,
      stageIndex,
      status: "Completed",
      urlBefore,
      urlAfter: page.url(),
      outcome: result.outcome,
      signal: result.signal,
      iteration: completedIteration,
      evidence: result.evidence,
      durationMs: Date.now() - startedAt,
    };
    receipts.push(completed); await options.onReceipt?.(page, completed);
    if (result.outcome !== "Continue") {
      const observedText = result.outcome === "Success" ? (stageObservedText || await page.locator("body").innerText().catch(() => undefined)) : undefined;
      const stageTransitions = program.stages.map((stage) => stage.transitions);
      return { page, outcome: result.outcome, reason: result.reason, output: result.output || {}, state, evidence, receipts, ...(options.allowModuleGraphAdoption ? { stageManifest: program.stages } : {}), ...(observedText ? { observedText } : {}), ...(program.controlFlow ? { controlFlow: program.controlFlow } : {}), ...(stageTransitions.some(Boolean) ? { stageTransitions } : {}) };
    }
  }
  throw new JavaScriptStageRunError("capability_output_missing", receipts);
}
