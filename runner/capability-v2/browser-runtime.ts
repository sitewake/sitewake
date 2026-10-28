import { capabilityUrlHas } from "../../lib/capability-center-v2/entry-page";
// The shared address test, under the name this module's callers know.
export { capabilityUrlHas as capabilityUrlIncludes } from "../../lib/capability-center-v2/entry-page";
import { checkPreconditions, evaluateSuccessConditions, resolveCapabilityInput } from "../../lib/capability-center-v2/run-resolution";
import { assertCapabilityOutput } from "../../lib/site-knowledge/capability-output";
import type { Locator, Page } from "playwright";
import { getModelConfig } from "../../lib/model-config";
import { capabilityTextIncludes, capabilityTextMentions, capabilityTextToken } from "../../lib/capability-center-v2/text-match";
import { expectedValuesEqual } from "../../lib/capability-center-v2/expected-output";
import { capabilityUrlTemplateMatches, renderCapabilityInputTemplate } from "../../lib/capability-center-v2/input-template";
import { requestStructuredModelJson } from "../../lib/capability-center-v2/model-json";
import { promptProvenance, type VersionedPrompt } from "../../lib/capability-center-v2/prompt";
import type { CapabilityContract, CapabilityDslProgram, CapabilityInputAliases, CapabilityPromptProvenance, CapabilityScope, CapabilityTaskInput, JsonObject, JsonValue, LocatorStrategy, LocatorValue, ProgramStep, ProgramValue } from "../../lib/capability-center-v2/model";
import { BROWSER_EXPLORER_PROMPT } from "./prompts/browser-explorer";
import { CAPABILITY_CONTRACT_PROMPT, CAPABILITY_SPEC_PROMPT } from "./prompts/capability-spec";
import { RESULT_JUDGE_PROMPT } from "./prompts/result-judge";
import { diagnoseBlockedPage } from "./failure-diagnostics";
import { ContractInconsistentError, inspectContractConsistency } from "../../lib/capability-center-v2/contract-consistency";
import { analyzeCapabilitySemanticsDetailed, projectCapabilityScope, withoutSemanticDependencies } from "../../lib/capability-center-v2/semantic-analyzer";

type PageElement = {
  index: number;
  tag: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  css?: string;
  inputType?: string;
  /** The current DOM control value, used only as evidence for a grounded default. */
  value?: string;
  /** Selection state for checkbox/radio controls; value alone is not state. */
  checked?: boolean;
  disabled?: boolean;
  ariaDisabled?: boolean;
  href?: string;
  opensNewPage?: boolean;
  interactionSource?: "native" | "handler" | "pointer";
  options?: string[];
  container?: { css: string; text: string; heading?: string };
};

type PlannedParameter = {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  required: boolean;
  exampleValue: JsonValue;
  defaultValue?: JsonValue;
  defaultEvidence?: { source: "page-control" | "action-receipt" | "business-output" | "admin" | "policy"; ref: string };
};

type ParameterPlan = {
  intent: string;
  name: string;
  description: string;
  aliases: string[];
  parameters: PlannedParameter[];
  groundingExamples: Array<Record<string, JsonValue>>;
  scope?: CapabilityScope;
  inputAliases?: CapabilityInputAliases;
};

type ExplorerAction = {
  action: "click" | "fill" | "select" | "check" | "press" | "hover" | "waitFor" | "extract" | "navigate" | "done" | "fail";
  index?: number;
  inputPath?: string;
  value?: JsonValue;
  key?: string;
  url?: string;
  reason?: string;
  saveAs?: string;
  extractType?: "text" | "value" | "attribute";
  attribute?: string;
};

export type CapabilityExplorationTraceEvent = {
  at: string;
  stage: string;
  message?: string;
  model?: string;
  promptKey?: string;
  promptVersion?: string;
  promptHash?: string;
  request?: unknown;
  response?: unknown;
  error?: string;
  durationMs?: number;
};

type ExplorationObserver = (event: CapabilityExplorationTraceEvent) => void;

export class MissingInputError extends Error {
  constructor(readonly key: string, readonly sensitive = false) { super(`input_required:${key}`); }
}

/**
 * The Explorer model referenced an input path that is not part of the
 * canonical parameter projection. This is a model/action-contract error, not
 * a request for administrator input. Keeping it separate from
 * MissingInputError prevents the Runner from creating a bogus `runtime-0`
 * interaction and waiting for a human to provide an internal array index.
 */
export class InvalidModelInputPathError extends Error {
  constructor(readonly path: string, readonly allowedPaths: string[]) {
    super(`model_input_path_invalid:${path}`);
  }
}

export class EvaluationError extends Error {
  constructor(readonly code: "NoResult" | "BusinessRejection", message: string) { super(message); }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sensitiveFieldName(value: string) {
  return /password|secret|token|otp|authorization|credential|cookie|密码|口令|验证码|密钥|令牌|凭据|用户名|账号/i.test(value);
}

async function settlePage(page: Page) {
  // The demo and many real SPAs hydrate after domcontentloaded and can replace
  // the same link/button node while client data is loading. Network-idle is not
  // a safe readiness signal for sites with analytics or long-polling SDK calls,
  // so use a bounded body-text stability check instead.  Do not accept the
  // first repeated server-rendered frame: React/Vue effects commonly restore
  // localStorage-backed business state a little later, and treating that
  // transient frame as evidence can turn a real product input into a generic
  // page heading.
  const startedAt = Date.now();
  let previous = "";
  let stableSamples = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await page.locator("body").innerText().catch(() => "");
    stableSamples = current && current === previous ? stableSamples + 1 : 0;
    if (stableSamples >= 2 && Date.now() - startedAt >= 300) return;
    previous = current;
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(100);
}

/** The page as it stands once it has stopped changing, or nothing if it cannot be read. */
async function settleAndInspect(page: Page) {
  try {
    await settlePage(page);
    return await inspectPage(page);
  } catch {
    return undefined;
  }
}

/**
 * What an observation still says once the page has stopped working.
 *
 * A live region carries progress and result through the same node, and the
 * explorer may call `done` on the frame that still shows the progress. Frozen
 * into the Contract, that sentence is a success condition no program can ever
 * meet: correct code waits for exactly that text to go away before it reads
 * the result. One capability was lost this way — the site answered a search
 * with 「正在查找包含“周杰伦”的词条」, the author wrote a stage that waits for
 * that line to disappear, and every draft was rejected with
 * `success_text_missing` until the repair budget ran out.
 *
 * So the evidence is re-read after the page settles and only what survived is
 * kept. This asks nothing about wording: text the page itself withdrew was
 * progress, and text the page still shows is a result. A signal is also kept
 * only while the settled page text carries it, because a text condition is
 * checked against page text and one that cannot be found there could only
 * fail. Nothing is dropped when the page moved on to another address — that
 * observation is the only account of what happened there.
 */
export function evidenceThatSurvivedSettling<
  Evidence extends { url: string; text: string; signals: string[] },
>(observed: Evidence, settled: Evidence | undefined): Evidence {
  if (!settled || settled.url !== observed.url) return observed;
  const signals = [...new Set([...observed.signals, ...settled.signals])]
    .filter((signal) => capabilityTextIncludes(settled.text, signal));
  return { ...settled, signals };
}

function textConditionValue(condition: JsonValue, input: CapabilityTaskInput): string | undefined {
  if (typeof condition === "string") return condition.trim() || undefined;
  const value = object(condition);
  const type = String(value.type || "");
  if (type === "textIncludes") return typeof value.value === "string" ? value.value.trim() || undefined : undefined;
  if (type === "textTemplate") {
    const template = typeof value.template === "string" ? value.template : "";
    return template ? renderInputTemplate(template, input).trim() || undefined : undefined;
  }
  return undefined;
}

/**
 * Dynamic sites often render a toast/cart summary shortly after the click
 * returns.  Give contractual text evidence a bounded polling window instead
 * of taking one race-prone snapshot.  This remains deterministic: no model
 * call or relaxed condition is introduced, and the last snapshot is returned
 * unchanged when the evidence never appears.
 */
async function inspectForContractText(page: Page, conditions: JsonValue[], input: CapabilityTaskInput, timeoutMs = 2_000, observedText?: string) {
  const startedAt = Date.now();
  let snapshot = await inspectPage(page);
  const expected = conditions.map((condition) => textConditionValue(condition, input)).filter((value): value is string => Boolean(value));
  if (!expected.length) return snapshot;
  while (Date.now() - startedAt < timeoutMs) {
    if (expected.every((value) => capabilityTextIncludes(snapshot.text, value))) return snapshot;
    // The terminal stage may have observed a transient toast that disappears
    // before the host performs its contractual snapshot. Treat that host
    // observation as evidence only when it contains every textual condition;
    // URL/output/schema checks still use the current page below.
    if (observedText && expected.every((value) => capabilityTextIncludes(observedText, value))) return { ...snapshot, text: observedText };
    await page.waitForTimeout(150);
    snapshot = await inspectPage(page);
  }
  return snapshot;
}

function selectionConditionText(condition: JsonValue) {
  const value = object(condition);
  const type = String(value.type || "");
  if (type !== "urlIncludes" && type !== "urlTemplate") return "";
  return String(value.value || value.template || "");
}

/**
 * A select action is allowed to be idempotent.  PrestaShop, for example,
 * does not submit the currency form when the requested currency is already
 * selected, so the URL has no fresh SubmitCurrency/id_currency query even
 * though the requested state is already true.  Keep URL assertions strict by
 * default and use this narrow, DOM-backed fallback only for selection-like
 * conditions.  It never treats a generic page text match as URL evidence.
 */
async function selectedInputMatchesUrlCondition(page: Page, condition: JsonValue, input: CapabilityTaskInput) {
  const conditionText = selectionConditionText(condition);
  if (!/(currency|color|size|attribute|option|filter|sort)/iu.test(conditionText)) return false;
  const values = Object.values(input.parameters)
    .filter((value): value is string | number => (typeof value === "string" && value.trim().length > 0) || typeof value === "number")
    .map((value) => String(value).normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase())
    .filter(Boolean);
  if (!values.length) return false;
  return await page.evaluate(`((expected) => {
    const normalize = (value) => String(value || "").normalize("NFKC").replace(/\\s+/gu, " ").trim().toLocaleLowerCase();
    const matches = (value) => {
      const token = normalize(value);
      return Boolean(token) && expected.some((candidate) => token === candidate || token.includes(candidate) || candidate.includes(token));
    };
    for (const select of [...document.querySelectorAll("select")]) {
      const selected = [...select.selectedOptions].map((option) => [option.value, option.textContent || ""]).flat();
      if (selected.some(matches)) return true;
    }
    for (const control of [...document.querySelectorAll("input[type=radio]:checked,input[type=checkbox]:checked")]) {
      const label = control.labels?.[0];
      const values = [control.value, control.getAttribute("aria-label"), label?.textContent || ""];
      if (values.some(matches)) return true;
    }
    return false;
  })(${JSON.stringify(values)})`) as boolean;
}

async function urlConditionSatisfied(page: Page, snapshot: { url: string }, condition: JsonValue, input: CapabilityTaskInput) {
  const value = object(condition);
  const type = String(value.type || "");
  if (type === "urlIncludes") {
    return capabilityUrlHas(snapshot.url, String(value.value || "")) || await selectedInputMatchesUrlCondition(page, condition, input);
  }
  if (type === "urlTemplate") {
    return capabilityUrlTemplateMatches(snapshot.url, value.template, input.parameters) || await selectedInputMatchesUrlCondition(page, condition, input);
  }
  return true;
}

function pathValue(root: unknown, path: string): unknown {
  return path.split(".").filter(Boolean).reduce((value, key) => object(value)[key], root);
}

/**
 * Models sometimes qualify a business input with the envelope name used in
 * their prompt (for example `inputValues.keyword` or `parameters.keyword`).
 * The persisted CapabilityTask keeps business parameters at the parameters
 * root, so accepting those harmless wrappers prevents a false
 * WaitingInput/`input_required` pause while preserving strict path lookup for
 * every other value.
 */
function comparableInputPathToken(value: string) {
  return value.replace(/[^a-z0-9]/gi, "").toLocaleLowerCase();
}

function inputPathCandidates(path: string, parameters?: Record<string, JsonValue>) {
  const normalized = path.trim().replace(/^\.+|\.+$/g, "");
  const candidates = [normalized];
  for (const prefix of ["inputValues.", "parameters.", "input.", "providedInputs."]) {
    if (normalized.startsWith(prefix)) candidates.push(normalized.slice(prefix.length));
  }
  // The model may preserve a human-friendly spelling from the prompt
  // (for example `customization_text`) while the canonical projection uses
  // camelCase (`customizationText`). Resolve only when the normalized leaf
  // maps to exactly one canonical parameter; an ambiguous mapping still
  // fails closed below instead of silently choosing a field.
  if (parameters) {
    const parameterEntries = Object.keys(parameters);
    for (const candidate of [...candidates]) {
      const parts = candidate.split(".");
      const leaf = parts.at(-1) || "";
      const leafToken = comparableInputPathToken(leaf);
      const exactMatches = parameterEntries.filter((key) => comparableInputPathToken(key) === leafToken);
      // A model may shorten a descriptive field to `text`, `name`, `value`,
      // or `product`. Accept a suffix/prefix match only when it is unique;
      // otherwise preserve the strict invalid-path error rather than guessing.
      const matches = exactMatches.length
        ? exactMatches
        : leafToken.length >= 4
          ? parameterEntries.filter((key) => {
            const token = comparableInputPathToken(key);
            return token.endsWith(leafToken) || token.startsWith(leafToken);
          })
          : [];
      if (matches.length === 1) candidates.push([...parts.slice(0, -1), matches[0]].join("."));
    }
  }
  return [...new Set(candidates.filter(Boolean))];
}

function resolveInputParameter(parameters: Record<string, JsonValue>, path: string) {
  for (const candidate of inputPathCandidates(path, parameters)) {
    const value = pathValue(parameters, candidate);
    if (value !== undefined) return { path: candidate, value };
  }
  return { path: inputPathCandidates(path, parameters)[0] || path, value: undefined };
}

function resolveValue(value: ProgramValue | undefined, input: CapabilityTaskInput, variables: Record<string, unknown>) {
  if (!value) return undefined;
  if (value.source === "literal") return value.value;
  if (value.source === "input") {
    const resolvedInput = resolveInputParameter(input.parameters, value.path);
    const resolved = resolvedInput.value;
    if (resolved === undefined) throw new MissingInputError(value.path, sensitiveFieldName(value.path));
    const aliases = object(input.context.__capabilityInputAliases);
    const map = object(aliases[resolvedInput.path.split(".")[0]]);
    return typeof resolved === "string" && typeof map[resolved] === "string" ? map[resolved] : resolved;
  }
  if (value.source === "context") return pathValue(input.context, value.path);
  if (value.source === "variable") return variables[value.name];
  const resolved = pathValue(input.parameters, value.interactionId);
  if (resolved === undefined) throw new MissingInputError(value.interactionId, true);
  return resolved;
}

export async function inspectPage(page: Page) {
  // Pass a browser-native expression instead of a transpiled callback. The
  // Worker/tsx bundle may inject esbuild's `__name` helper into callbacks;
  // that helper does not exist in the page's isolated JavaScript realm.
  return page.evaluate(`(() => {
    const visible = (element) => {
      const node = element;
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && box.width > 0 && box.height > 0;
    };
    const role = (element) => element.getAttribute("role") || (element instanceof HTMLButtonElement ? "button" : element instanceof HTMLAnchorElement ? "link" : element instanceof HTMLSelectElement ? "combobox" : element instanceof HTMLInputElement && element.type === "checkbox" ? "checkbox" : element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? "textbox" : undefined);
    const name = (element) => element.getAttribute("aria-label") || element.getAttribute("title") || (element instanceof HTMLInputElement && element.labels?.length ? [...element.labels].map((label) => label.textContent || "").join(" ") : element.textContent || element.getAttribute("placeholder") || "").replace(/\\s+/g, " ").trim().slice(0, 180);
    const nativeSelector = "button,a[href],input,textarea,select,[role=button],[role=link],[role=checkbox],[tabindex]";
    const interactionSource = (element) => {
      if (element.matches(nativeSelector)) return "native";
      // React delegates DOM events. Inspect only the presence of a handler,
      // never component state or handler source. Native onclick also covers
      // non-framework and Vue-style DOM handlers.
      const reactKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
      const props = reactKey ? element[reactKey] : undefined;
      const reactManaged = Boolean(reactKey) || Object.keys(element).some((key) => key.startsWith("__reactContainer$"));
      if (typeof props?.onClick === "function" || (!reactManaged && typeof element.onclick === "function")) return "handler";
      // An inherited pointer cursor does not make every child a new target.
      if (getComputedStyle(element).cursor === "pointer"
        && (!element.parentElement || getComputedStyle(element.parentElement).cursor !== "pointer")) return "pointer";
      return undefined;
    };
    const css = (element) => {
      const testId = element.getAttribute("data-testid") || element.getAttribute("data-test");
      if (testId) return "[" + (element.hasAttribute("data-testid") ? "data-testid" : "data-test") + "=" + JSON.stringify(testId) + "]";
      if (element.id) return "#" + CSS.escape(element.id);
      const fieldName = element.getAttribute("name");
      if (fieldName) return element.tagName.toLowerCase() + "[name=" + JSON.stringify(fieldName) + "]";
      // A concrete exploration target needs an exact address, including
      // unlabeled clickable cards and repeated links with the same text.
      // This is demonstration evidence; C1 must still author a parameterized
      // program and pass replay on independent inputs.
      const path = [];
      for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
        const siblings = node.parentElement ? [...node.parentElement.children].filter((sibling) => sibling.tagName === node.tagName) : [node];
        path.unshift(node.tagName.toLowerCase() + (siblings.length > 1 ? ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")" : ""));
        if (node.id) { path[0] = "#" + CSS.escape(node.id); break; }
      }
      return path.join(" > ");
    };
    const container = (element) => {
      const node = element.closest("[data-testid],[data-test],article,li,[role=listitem],[role=row],tr");
      if (!node || node === element) return undefined;
      const testId = node.getAttribute("data-testid") || node.getAttribute("data-test");
      const selector = testId
        ? "[data-testid=" + JSON.stringify(testId) + "]"
        : node.id ? "#" + CSS.escape(node.id)
          : node.getAttribute("role") ? "[role=" + JSON.stringify(node.getAttribute("role")) + "]"
            : ["article", "li", "tr"].includes(node.tagName.toLowerCase()) ? node.tagName.toLowerCase() : undefined;
      const text = (node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 1000);
      const heading = (node.querySelector("h1,h2,h3,h4,h5,h6,[role=heading]")?.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 180);
      return selector && text ? { css: selector, text, heading: heading || undefined } : undefined;
    };
    const hasPassword = Boolean(document.querySelector('input[type="password"],input[autocomplete="current-password"],input[autocomplete="one-time-code"]'));
    const ariaSignals = [...document.querySelectorAll('[role="alert"],[role="status"],[aria-live]')]
      .filter(visible)
      .map((element) => (element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 500))
      .filter(Boolean);
    // Many commerce sites report a completed write in a modal rather than an
    // ARIA alert. Keep only business-success/cart dialogs so a transient
    // consent or navigation dialog cannot prematurely terminate exploration.
    const businessModalSignals = [...document.querySelectorAll('[role="dialog"],.modal.show,[data-ps-target="modal-container"]')]
      // A modal can be in a short opacity transition while it already blocks
      // the page. Layout visibility is enough for a business-success signal;
      // requiring opacity > 0 would allow a duplicate click in that window.
      .filter((element) => {
        const node = element;
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      })
      .map((element) => (element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 500))
      .filter((text) => /cart|shopping bag|added|success|购物车|加入|成功/i.test(text));
    const signals = [...new Set([...ariaSignals, ...businessModalSignals])].slice(0, 20);
    const candidates = [...document.querySelectorAll("body *")]
      .filter((element) => !element.closest("[inert],[aria-hidden=true],script,style,noscript"))
      .filter(visible)
      .map((element) => ({ element, interactionSource: interactionSource(element) }))
      .filter((candidate) => candidate.interactionSource);
    const elements = candidates.slice(0, 120).map(({ element, interactionSource }, index) => ({
      index,
      tag: element.tagName.toLowerCase(),
      role: role(element),
      name: name(element),
      label: element instanceof HTMLInputElement && element.labels?.length ? [...element.labels].map((label) => label.textContent || "").join(" ").trim().slice(0, 180) : undefined,
      placeholder: element.getAttribute("placeholder") || undefined,
      testId: element.getAttribute("data-testid") || element.getAttribute("data-test") || undefined,
      css: css(element),
      inputType: element instanceof HTMLInputElement ? element.type : undefined,
      value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
        ? element.value
        : undefined,
      checked: element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")
        ? element.checked
        : undefined,
      disabled: (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) ? Boolean(element.disabled) : undefined,
      ariaDisabled: element.getAttribute("aria-disabled") === "true" ? true : undefined,
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
      opensNewPage: element instanceof HTMLAnchorElement && element.target === "_blank" ? true : undefined,
      interactionSource,
      options: element instanceof HTMLSelectElement ? [...element.options].slice(0, 40).map((option) => option.value || option.textContent || "") : undefined,
      container: container(element),
    }));
    return {
      url: location.href,
      title: document.title.slice(0, 300),
      heading: (document.querySelector("h1,[role=heading]")?.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 500),
      text: hasPassword ? "[authentication page; sensitive values redacted]" : (document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 8000),
      signals,
      // What the site says went wrong, apart from what it reports as progress.
      alerts: [...document.querySelectorAll('[role="alert"]')].filter(visible)
        .map((element) => (element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 300)).filter(Boolean).slice(0, 10),
      elements,
    };
  })()`) as Promise<{ url: string; title: string; heading: string; text: string; signals: string[]; alerts?: string[]; elements: PageElement[] }>;
}

function redactedTraceValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > 8) return "[depth-limited]";
  if (sensitiveFieldName(key)) return "[redacted]";
  if (Array.isArray(value)) return value.slice(0, 120).map((item) => redactedTraceValue(item, key, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 240).map(([childKey, child]) => [childKey, redactedTraceValue(child, childKey, depth + 1)]));
  if (typeof value === "string") return value.slice(0, 20_000);
  return value;
}

function observe(observer: ExplorationObserver | undefined, event: Omit<CapabilityExplorationTraceEvent, "at">) {
  try { observer?.({ at: new Date().toISOString(), ...event }); } catch { /* diagnostics must never affect execution */ }
}

async function modelJson(
  prompt: VersionedPrompt,
  payload: unknown,
  observer?: ExplorationObserver,
  stage = "model",
  validate?: (value: Record<string, unknown>) => void,
) {
  const config = getModelConfig("execution");
  if (!config.configured) throw new Error("capability_explorer_model_not_configured");
  const provenance = await promptProvenance(prompt, config.model);
  const startedAt = Date.now();
  // The parameter plan and bounded grounding-example repair are relatively
  // heavy specification turns. Give each at most one repair attempt; a slow
  // remote Qwen response must not be multiplied across every browser step,
  // while malformed responses remain auditable and retryable.
  const parameterPlan = stage.startsWith("parameter-plan");
  try {
    const parsed = await requestStructuredModelJson(config, {
      system: prompt.text,
      payload,
      // The execution gateway is remote and may transiently time out or
      // return a malformed structured response under concurrent Discovery
      // load. Each turn has one auditable long-budget attempt; task rerun is
      // the retry boundary so a slow call is never multiplied invisibly.
      // A malformed JSON object is a protocol hiccup, not a browser failure,
      // and neither is a call that ran out of time. Every stage gets one more
      // try: a single slow response used to end a discovery that had already
      // driven the site successfully, and two bounded calls cannot become the
      // request burst the single-call budget was guarding against.
      attempts: 2,
      timeoutMs: 180_000,
      maxTokens: 4096,
      disableThinking: true,
      jsonSchema: prompt.outputSchema,
      validate,
      onAttempt: (attempt) => {
        if (!attempt.error) return;
        observe(observer, {
          stage: `${stage}:attempt-${attempt.attempt}`,
          model: config.model,
          promptKey: provenance.promptKey,
          promptVersion: provenance.promptVersion,
          promptHash: provenance.promptHash,
          request: redactedTraceValue(payload),
          response: redactedTraceValue({ finishReason: attempt.finishReason, contentLength: attempt.contentLength }),
          error: attempt.error,
          durationMs: attempt.durationMs,
        });
      },
    });
    observe(observer, {
      stage,
      model: config.model,
      promptKey: provenance.promptKey,
      promptVersion: provenance.promptVersion,
      promptHash: provenance.promptHash,
      request: redactedTraceValue(payload),
      response: redactedTraceValue(parsed),
      durationMs: Date.now() - startedAt,
    });
    return parsed;
  } catch (error) {
    observe(observer, {
      stage,
      model: config.model,
      promptKey: provenance.promptKey,
      promptVersion: provenance.promptVersion,
      promptHash: provenance.promptHash,
      request: redactedTraceValue(payload),
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    });
    const message = error instanceof Error ? error.message : String(error);
    if ((error instanceof Error && error.name === "TimeoutError") || /aborted due to timeout|timed?\s*out/i.test(message)) {
      throw new Error(`capability_model_timeout:${stage}`);
    }
    throw error;
  }
}

function matchingInput(value: string | undefined, input: CapabilityTaskInput) {
  if (!value) return undefined;
  return Object.entries(input.parameters).find(([, candidate]) => typeof candidate === "string" && candidate.length > 1 && value.trim() === candidate.trim())?.[0];
}

function stableAccessiblePrefix(value: string | undefined) {
  if (!value) return undefined;
  return value.match(/^(?:View product|Add to cart|Quick view|Decrease quantity|Increase quantity|Change quantity|Open |Subcategories for )/i)?.[0]?.trim();
}

export function strategiesFor(element: PageElement, input: CapabilityTaskInput): LocatorStrategy[] {
  const strategies: LocatorStrategy[] = [];
  const semanticStrategies: LocatorStrategy[] = [];
  const dynamicName = matchingInput(element.name, input);
  const dynamicLabel = matchingInput(element.label, input);
  const name: LocatorValue | undefined = dynamicName ? { source: "input", path: dynamicName } : element.name;
  const label: LocatorValue | undefined = dynamicLabel ? { source: "input", path: dynamicLabel } : element.label;

  // A demonstrated product/variant label is concrete (for example
  // "Black - Brown bear cushion"), but the capability input is intentionally
  // abstract (for example productType=cushion, color=black).  Preserve the
  // business facets as input-backed filters instead of freezing the observed
  // product name into the replay selector.  This lets a generic request pick
  // the first valid item in a matching collection while still rejecting
  // unrelated cards.
  if ((element.role === "link" || element.role === "button") && element.name) {
    const text = element.name.toLocaleLowerCase();
    const matchedPaths = Object.entries(input.parameters)
      .filter(([, value]) => typeof value === "string" && value.trim().length > 1)
      .filter(([path, value]) => {
        const candidates = [String(value)];
        const aliases = input.context.__capabilityInputAliases;
        const aliasMap = aliases && typeof aliases === "object" && !Array.isArray(aliases)
          ? (aliases as Record<string, unknown>)[path]
          : undefined;
        if (aliasMap && typeof aliasMap === "object" && !Array.isArray(aliasMap)) {
          const mapped = (aliasMap as Record<string, unknown>)[String(value)];
          if (typeof mapped === "string" && mapped.trim().length > 1) candidates.push(mapped);
        }
        return candidates.some((candidate) => text.includes(candidate.toLocaleLowerCase()));
      })
      .map(([path]) => path);
    if (matchedPaths.length) {
      const facetName = { source: "input" as const, path: matchedPaths[0] } satisfies ProgramValue;
      semanticStrategies.push({
        type: "role",
        role: element.role,
        name: facetName,
        match: "contains",
        containsTextAll: matchedPaths.map((path) => ({ source: "input" as const, path } satisfies ProgramValue)),
      });
    }
  }

  // PrestaShop and many accessible storefronts render radio/checkbox/color
  // inputs as visually-hidden controls with a positioned label/span on top.
  // A role locator resolves the input itself, so a generated click can time
  // out even though the semantic label is the real hit target. Prefer the
  // associated label for these controls while retaining the input strategies
  // as fallbacks for fill/check-style interactions.
  const inputType = (element.inputType || "").toLowerCase();
  const cssId = element.css?.match(/^#([A-Za-z_][\w:.-]*)$/)?.[1];
  if (element.tag === "input" && cssId && ["checkbox", "radio", "color"].includes(inputType)) {
    strategies.push({ type: "css", value: `label[for=${JSON.stringify(cssId)}]` });
  }
  // Some faceted storefronts expose the clickable color swatch as an
  // unnamed span[role=checkbox]. Its business label lives in the surrounding
  // list item (for example `Black (1 result)`), so the role alone is
  // ambiguous and the span itself has no accessible name. Resolve the label
  // from the input-backed color value and click the matching visible text.
  if (element.role === "checkbox" && element.container?.text) {
    const containerText = element.container.text;
    const matchedPath = Object.entries(input.parameters).find(([path, value]) => {
      if (typeof value !== "string" || value.trim().length < 1) return false;
      const aliases = input.context.__capabilityInputAliases;
      const aliasMap = aliases && typeof aliases === "object" && !Array.isArray(aliases)
        ? (aliases as Record<string, unknown>)[path]
        : undefined;
      const candidates = [value];
      if (aliasMap && typeof aliasMap === "object" && !Array.isArray(aliasMap)) {
        const mapped = (aliasMap as Record<string, unknown>)[value];
        if (typeof mapped === "string" && mapped.trim()) candidates.push(mapped);
      }
      return candidates.some((candidate) => containerText.toLocaleLowerCase().includes(candidate.toLocaleLowerCase()));
    })?.[0];
    const labelValue: LocatorValue | undefined = matchedPath
      ? { source: "input", path: matchedPath }
      : containerText.split("(", 1)[0]?.trim() || undefined;
    if (labelValue) strategies.push({ type: "text", value: labelValue, match: "contains" });
  }
  const stablePrefix = stableAccessiblePrefix(element.name);
  if (element.role && stablePrefix) strategies.push({ type: "role", role: element.role, name: stablePrefix, match: "contains" });
  if (element.role && name) strategies.push({ type: "role", role: element.role, name, match: "exact" });
  if (label) strategies.push({ type: "label", value: label, match: "exact" });
  if (element.testId) strategies.push({ type: "testId", value: element.testId });
  if (name && (element.role === "button" || element.role === "link")) strategies.push({ type: "text", value: name, match: "exact" });
  // A choice made by clicking its label or swatch has no role to carry its
  // name: a finish swatch reading exactly "Brass" was located by its position
  // alone, so the capability clicked the first swatch whatever finish it was
  // asked for, and every draft failed "input not acted on". When the visible
  // name is exactly an input's value, find it by that input.
  if (dynamicName && !element.role) strategies.push({ type: "text", value: name!, match: "exact" });
  if (element.css) strategies.push({ type: "css", value: element.css });
  // Product cards often expose an image/link hit target with no accessible
  // name of its own; the meaningful name lives on a sibling title/details
  // link inside the same card.  When `scopeFor` has already narrowed the
  // card, `a[href]` is a stable, semantic entry point that does not bake the
  // demonstrated product URL into the generated program.  Without a scope
  // this remains intentionally ambiguous and fails closed in oneVisible().
  if (!strategies.length && element.tag === "a" && element.href) strategies.push({ type: "css", value: "a[href]" });
  strategies.push(...semanticStrategies);
  return strategies;
}

function resolveLocatorValue(value: LocatorValue | undefined, input: CapabilityTaskInput, variables: Record<string, unknown>) {
  if (typeof value === "string") return value;
  const resolved = resolveValue(value, input, variables);
  return resolved === undefined || resolved === null ? "" : String(resolved);
}

type LocatorRoot = Page | Locator;

function locatorFrom(root: LocatorRoot, strategy: LocatorStrategy, input: CapabilityTaskInput, variables: Record<string, unknown>) {
  const expected = resolveLocatorValue(strategy.value || strategy.name, input, variables);
  const exact = strategy.match !== "contains";
  let locator = strategy.type === "role"
    ? root.getByRole(strategy.role as never, expected ? { name: expected, exact } : undefined)
    : strategy.type === "label" ? root.getByLabel(expected, { exact })
      : strategy.type === "text" ? root.getByText(expected, { exact })
        : strategy.type === "testId" ? root.getByTestId(expected)
          : root.locator(expected);
  const containsText = resolveLocatorValue(strategy.containsText, input, variables);
  if (containsText) locator = locator.filter({ hasText: containsText });
  for (const value of strategy.containsTextAll || []) {
    const text = resolveLocatorValue(value, input, variables);
    if (text) locator = locator.filter({ hasText: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") });
  }
  return locator;
}

async function oneVisible(strategies: LocatorStrategy[], root: LocatorRoot, input: CapabilityTaskInput, variables: Record<string, unknown>, id: string) {
  let ambiguous = false;
  for (const strategy of strategies) {
    const locator = locatorFrom(root, strategy, input, variables);
    const count = await locator.count().catch(() => 0);
    const visible: Locator[] = [];
    for (let index = 0; index < Math.min(count, 100); index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
    }
    if (visible.length === 1) return visible[0];
    // Storefronts commonly render more than one accessible link for one
    // entity (for example a product title and a "See details" link). If all
    // matched links resolve to the same absolute href, they are alternate
    // entry points to the same semantic entity even when their visible text
    // differs; choose one deterministic representative. Distinct hrefs or
    // non-link targets still fail closed as target_ambiguous.
    if (visible.length > 1) {
      const signatures = await Promise.all(visible.map(async (candidate) => {
        const href = await candidate.getAttribute("href").catch(() => null);
        const text = await candidate.innerText().catch(() => "");
        return `${href || ""}|${text.replace(/\s+/g, " ").trim()}`;
      }));
      const hrefs = signatures
        .map((signature) => signature.split("|", 1)[0])
        .filter((href) => href.length > 0);
      if (hrefs.length === visible.length && new Set(hrefs).size === 1) return visible[0];
      if (signatures.length && new Set(signatures).size === 1) return visible[0];
    }
    if (visible.length > 1) ambiguous = true;
  }
  throw new Error(`${ambiguous ? "target_ambiguous" : "locator_not_found"}:${id}`);
}

function hasInputBackedValue(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as { source?: unknown }).source === "input";
}

function hasInputBackedStrategy(strategies: LocatorStrategy[]): boolean {
  return strategies.some((strategy) => hasInputBackedValue(strategy.name)
    || hasInputBackedValue(strategy.value)
    || hasInputBackedValue(strategy.containsText)
    || (strategy.containsTextAll || []).some((value) => hasInputBackedValue(value)));
}

async function locatorFor(page: Page, step: ProgramStep, input: CapabilityTaskInput, variables: Record<string, unknown>): Promise<Locator> {
  const target = step.target;
  if (!target?.strategies.length) throw new Error(`locator_not_found:${step.id}`);
  if (!target.scope?.strategies.length) return oneVisible(target.strategies, page, input, variables, step.id);

  // A generic request may legitimately match several product cards ("a black
  // cushion").  Resolve the target inside each matching card first; if the
  // target itself is input-backed, choosing the first deterministic candidate
  // is safe and repeatable.  Concrete/non-input targets remain fail-closed so
  // an accidental broad selector can never silently click an unrelated card.
  let scopeLocator: Locator | undefined;
  for (const scopeStrategy of target.scope.strategies) {
    const candidateScope = locatorFrom(page, scopeStrategy, input, variables);
    const count = await candidateScope.count().catch(() => 0);
    const visibleScopes: Locator[] = [];
    for (let index = 0; index < Math.min(count, 100); index += 1) {
      const candidate = candidateScope.nth(index);
      if (await candidate.isVisible().catch(() => false)) visibleScopes.push(candidate);
    }
    if (visibleScopes.length === 1) { scopeLocator = visibleScopes[0]; break; }
    if (visibleScopes.length > 1) {
      // Several cards satisfy the scope; the question is in how many the
      // target itself is found. An input-backed target may take the first,
      // as before. A concrete one found in exactly one card is that card's:
      // "Lune Table Lamp" under a scope of "cards that offer Brass" is one
      // link even though three cards offer Brass, and failing it ended a
      // replay of a path the visitor had already walked. Found in several,
      // a concrete target still fails closed.
      const matches: Locator[] = [];
      for (const scope of visibleScopes) {
        try { matches.push(await oneVisible(target.strategies, scope, input, variables, `${step.id}:candidate`)); } catch { /* not in this card */ }
      }
      if (matches.length && hasInputBackedStrategy(target.strategies)) return matches[0];
      if (matches.length === 1) return matches[0];
      throw new Error(`target_ambiguous:${step.id}:scope`);
    }
  }
  if (!scopeLocator) throw new Error(`locator_not_found:${step.id}:scope`);
  return oneVisible(target.strategies, scopeLocator, input, variables, step.id);
}

type SelectOptionCandidate = { value: string; label: string; index: number };

function normalizeSelectToken(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase().replace(/[\s_\-–—:：/\\$€£¥]+/gu, "");
}

/**
 * Select values emitted by a page are not always the text users ask for.
 * PrestaShop's currency selector, for example, uses a currency-switch URL as
 * the option value while displaying `USD $` as its label.  Prefer an exact
 * Playwright value/label match, then resolve the requested business token
 * against the live option values and labels before failing closed.
 */
async function selectOptionBySemanticValue(target: Locator, requested: unknown, timeout: number) {
  const raw = String(requested ?? "").trim();
  if (!raw) throw new Error("select_option_missing");
  const options = await target.locator("option").evaluateAll((nodes) => nodes.map((node, index) => ({
    value: (node as HTMLOptionElement).value || "",
    label: (node.textContent || "").trim(),
    index,
  }))).catch(() => [] as SelectOptionCandidate[]);
  const requestedToken = normalizeSelectToken(raw);
  const candidate = options
    .map((option) => {
      const valueToken = normalizeSelectToken(option.value);
      const labelToken = normalizeSelectToken(option.label);
      const score = valueToken === requestedToken || labelToken === requestedToken
        ? 100
        : valueToken.includes(requestedToken) || labelToken.includes(requestedToken)
          ? 80
          : requestedToken && (requestedToken.includes(valueToken) || requestedToken.includes(labelToken))
            ? 60
            : 0;
      return { option, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.option.index - right.option.index)[0]?.option;

  if (candidate) {
    try {
      await target.selectOption({ value: candidate.value }, { timeout });
      return;
    } catch {
      if (candidate.label) {
        try {
          await target.selectOption({ label: candidate.label }, { timeout });
          return;
        } catch { /* retain the original semantic error below */ }
      }
    }
  }

  // Preserve Playwright's useful native error when the requested value is
  // genuinely absent or the option list changed after the snapshot.
  await target.selectOption(raw, { timeout });
}

async function withRetries<T>(count: number, operation: () => Promise<T>) {
  let last: unknown;
  for (let attempt = 0; attempt <= count; attempt += 1) {
    try { return await operation(); } catch (error) { last = error; if (attempt < count) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1))); }
  }
  throw last;
}

export async function executeProgram(page: Page, program: CapabilityDslProgram, input: CapabilityTaskInput) {
  const variables: Record<string, unknown> = {};
  if (program.entry.mode === "Navigate" && program.entry.url) {
    await page.goto(program.entry.url, { waitUntil: "domcontentloaded", timeout: program.defaults.timeoutMs });
    await settlePage(page);
  }
  for (const step of program.steps) {
    const timeout = step.timeoutMs || program.defaults.timeoutMs;
    await withRetries(program.defaults.retryCount, async () => {
      if (step.action === "navigate") {
        const url = String(resolveValue(step.value, input, variables) || "");
        if (!url) throw new Error(`navigate_url_missing:${step.id}`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout }); return;
      }
      if (step.action === "upload") throw new Error(`upload_requires_artifact_input:${step.id}`);
      if (step.action === "press" && !step.target?.strategies.length) {
        await page.keyboard.press(step.key || String(resolveValue(step.value, input, variables) || "Enter"));
        return;
      }
      const target = await locatorFor(page, step, input, variables); const value = resolveValue(step.value, input, variables);
      if (step.action === "click") {
        try {
          await target.click({ timeout });
        } catch (error) {
          // Some commerce UIs insert a success modal synchronously from the
          // click handler. Playwright can then retry the already-dispatched
          // click because the modal intercepts the pointer, turning a
          // successful write into a timeout. Accept only an explicit business
          // success signal; unrelated overlays and missing targets still fail
          // closed.
          const signals = await inspectPage(page).then((snapshot) => snapshot.signals).catch(() => [] as string[]);
          if (!signals.some((signal) => /added|success|加入|成功/i.test(signal))) throw error;
        }
      }
      else if (step.action === "fill") await target.fill(String(value ?? ""), { timeout });
      else if (step.action === "select") await selectOptionBySemanticValue(target, value, timeout);
      else if (step.action === "check") {
        // A styled checkbox/radio is represented by a visible label strategy.
        // Playwright's check() requires the hidden input itself and can be
        // intercepted by the same overlay that caused the original failure;
        // clicking the associated label preserves the user's real hit target.
        const visibleLabel = step.target?.strategies[0]?.type === "css" && /^label\[for=/.test(String(step.target.strategies[0].value));
        if (visibleLabel) await target.click({ timeout });
        else await target.check({ timeout });
      }
      else if (step.action === "press") await target.press(step.key || String(value || "Enter"), { timeout });
      else if (step.action === "hover") await target.hover({ timeout });
      else if (step.action === "waitFor") await target.waitFor({ state: "visible", timeout });
      else if (step.action === "extract") variables[step.saveAs || step.id] = step.extract?.type === "value" ? await target.inputValue() : step.extract?.type === "attribute" ? await target.getAttribute(step.extract.name || "") : await target.innerText();
      else throw new Error(`program_action_unsupported:${step.action}`);
    });
    await settlePage(page);
  }
  variables.__pageUrl = page.url(); variables.__pageTitle = await page.title(); variables.__pageText = (await page.locator("body").innerText().catch(() => "")).slice(0, 8_000);
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(program.result)) {
    const resolved = resolveValue(value, input, variables);
    if (resolved !== undefined) output[key] = resolved as JsonValue;
  }
  return { output, variables };
}

function programValue(action: ExplorerAction): ProgramValue | undefined {
  if (action.inputPath) return { source: "input", path: action.inputPath };
  return action.value !== undefined ? { source: "literal", value: action.value } : undefined;
}

function jsonType(value: JsonValue): PlannedParameter["type"] {
  return typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string";
}

function technicalParameterName(name: string) {
  return /^(?:index|elementIndex|targetIndex|selector|locator|xpath|cssPath|testId)$/i.test(name)
    || /(?:element|locator|selector|xpath|css|test.?id)(?:Index|Id|Path)$/i.test(name)
    || /(?:元素|目标).*(?:索引|下标|编号)|选择器|定位器|路径|测试.?ID/i.test(name);
}

function isUserInputPath(path: string) {
  return /(?:query|keyword|search|term|product|item|target|category|department|color|colour|size|brand|quantity|count|date|locale|language|sort|filter)/iu.test(path);
}

function validParameterName(name: string) {
  return /^[\p{L}_][\p{L}\p{N}_-]{0,63}$/u.test(name);
}

function inferRepeatedEntityParameter(goal: string, snapshot: Awaited<ReturnType<typeof inspectPage>>): PlannedParameter | undefined {
  const normalizedGoal = comparableText(goal);
  const anchors = snapshot.elements
    .filter((element) => Boolean(element.container?.heading) && normalizedGoal.includes(comparableText(element.container?.heading)))
    .sort((left, right) => (right.container?.heading?.length || 0) - (left.container?.heading?.length || 0));
  for (const anchor of anchors) {
    const values = [...new Set(snapshot.elements
      .filter((candidate) => sameRepeatedAction(anchor, candidate))
      .map((candidate) => candidate.container?.heading?.trim())
      .filter((value): value is string => Boolean(value)))];
    if (values.length < 2 || !anchor.container?.heading) continue;
    return {
      name: "target",
      type: "string",
      description: `本次操作的目标对象，例如“${anchor.container.heading}”`,
      required: true,
      exampleValue: anchor.container.heading,
    };
  }
  return undefined;
}

function siblingEvidenceValue(parameter: PlannedParameter, snapshot: Awaited<ReturnType<typeof inspectPage>>) {
  const exampleValue = parameter.exampleValue;
  if (typeof exampleValue !== "string" || exampleValue.length < 2) return undefined;
  const anchors = snapshot.elements.filter((element) => element.container?.text.includes(exampleValue));
  for (const anchor of anchors) {
    const alternatives = snapshot.elements
      .filter((element) => element.role === anchor.role && element.name === anchor.name && element.container?.css === anchor.container?.css)
      .map((element) => element.container?.heading?.trim())
      .filter((value): value is string => Boolean(value) && value !== exampleValue);
    if (alternatives.length) return alternatives[0];
  }
  return undefined;
}

type EvidenceRegion = { text: string; heading?: string; css?: string; score: number };

/**
 * Return bounded, independently observable page regions.  Validation examples
 * must come from one card/row/detail region; using the complete page text would
 * allow a noun from one product and a facet from another to be combined into a
 * false target.  The region projection is deliberately site-neutral.
 */
function evidenceRegions(snapshot: Awaited<ReturnType<typeof inspectPage>>): EvidenceRegion[] {
  const regions: EvidenceRegion[] = [];
  const seen = new Set<string>();
  for (const element of snapshot.elements) {
    const container = element.container;
    const text = [container?.heading, container?.text, element.name, element.label]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join(" ")
      .trim();
    if (text.length < 3 || text.length > 1400) continue;
    const key = [container?.css || "", container?.heading || "", container?.text || "", element.name || ""].join("\u0001");
    if (seen.has(key)) continue;
    seen.add(key);
    const score = (container?.heading ? 1 : 0)
      + (/(?:[$€£]\s*\d|\d+(?:[.,]\d+)?\s*[$€£])/u.test(text) ? 3 : 0)
      + (/(?:add|buy|select|choose|加入|购买|添加|购物车)/iu.test(text) ? 1 : 0);
    regions.push({ text, heading: container?.heading, css: container?.css, score });
  }
  return regions.sort((left, right) => right.score - left.score);
}

const GENERIC_EVIDENCE_STOP_WORDS = new Set([
  "add", "added", "cart", "to", "the", "and", "for", "from", "view", "quick", "details", "detail", "price", "shop", "search", "results", "result", "item", "items", "in", "on", "your", "new", "sale", "eur", "usd",
]);

const GENERIC_COLOR_WORDS = new Set([
  "black", "white", "brown", "red", "blue", "green", "yellow", "gray", "grey", "purple", "pink", "orange", "gold", "silver",
  "黑", "黑色", "白", "白色", "棕", "棕色", "红", "红色", "蓝", "蓝色", "绿", "绿色", "黄", "黄色", "灰", "灰色", "紫", "紫色", "粉", "粉色", "橙", "橙色", "金", "金色", "银", "银色",
]);

function evidenceTokens(text: string) {
  return [...new Set(text.normalize("NFKC").split(/[^\p{L}\p{N}]+/u)
    .map((value) => value.trim())
    .filter((value) => value.length >= 3 && !/^\d+$/u.test(value) && !GENERIC_EVIDENCE_STOP_WORDS.has(value.toLocaleLowerCase())))]
    .sort((left, right) => right.length - left.length);
}

function rawSiteTermValues(raw: Record<string, unknown>, parameterName: string) {
  const values: string[] = [];
  for (const entry of Array.isArray(raw.siteTerms) ? raw.siteTerms : []) {
    const item = object(entry);
    if (String(item.name || "") !== parameterName) continue;
    for (const key of ["value", "from"]) {
      if (typeof item[key] === "string" && item[key].trim().length > 1) values.push(item[key].trim());
    }
  }
  return values;
}

/** Build one evidence-backed example with a different target and co-located facets. */
function independentGroundingExample(
  parameters: PlannedParameter[],
  raw: Record<string, unknown>,
  snapshot: Awaited<ReturnType<typeof inspectPage>>,
  demonstration: Record<string, JsonValue>,
) {
  const selection = parameters.filter((parameter) => selectionPath(parameter.name));
  const targets = parameters.filter((parameter) => targetIdentityPath(parameter.name));
  if (!selection.length || !targets.length) return undefined;
  const regions = evidenceRegions(snapshot);
  for (const region of regions) {
    const regionText = comparableText(region.text);
    const candidate: Record<string, JsonValue> = { ...demonstration };
    let changedTarget = false;
    let complete = true;
    for (const parameter of selection) {
      const demonstrationValue = demonstration[parameter.name];
      const targetParameter = targets.some((target) => target.name === parameter.name);
      // For an identity/target field, prefer the region's complete business
      // heading before token-level evidence. Otherwise a repeated entity such
      // as `Arc 弧光台灯` can be split into the partial token `弧光台灯`,
      // producing a false "independent" case from the demonstration card
      // itself. Token fallback remains available for sites that do not expose
      // a heading.
      const alternatives = [
        ...(targetParameter && region.heading ? [region.heading] : []),
        ...rawSiteTermValues(raw, parameter.name),
        ...evidenceTokens(region.text),
      ].filter((value, index, values) => values.findIndex((item) => comparableText(item) === comparableText(value)) === index);
      const parameterSemantics = `${parameter.name} ${parameter.description || ""}`;
      const facet = /(?:color|colour|颜色|色|hint|modifier|facet|attribute|material|size|brand)/iu.test(parameterSemantics)
        && !/^(?:query|keyword|productKeyword|searchTerm|productType|item|target)$/iu.test(parameter.name);
      const colorFacet = /(?:color|colour|颜色|色)/iu.test(parameterSemantics);
      const candidateValue = alternatives.find((value) => {
        const normalized = comparableText(value);
        if (!normalized || normalized === comparableText(String(demonstrationValue ?? "")) || !regionText.includes(normalized)) return false;
        if (targetParameter) {
          const demonstrationText = comparableText(String(demonstrationValue ?? ""));
          // Do not accept a token that is merely a substring of the
          // demonstration identity; it cannot prove a different target.
          if (demonstrationText.includes(normalized) || normalized.includes(demonstrationText)) return false;
          if (region.heading && normalized !== comparableText(region.heading)) return false;
        }
        if (facet) return !colorFacet || GENERIC_COLOR_WORDS.has(normalized);
        return !GENERIC_COLOR_WORDS.has(normalized);
      });
      const value = candidateValue || (demonstrationValue !== undefined && regionText.includes(comparableText(String(demonstrationValue))) ? String(demonstrationValue) : undefined);
      if (value === undefined) {
        complete = false;
        break;
      }
      candidate[parameter.name] = value;
      if (targets.some((target) => target.name === parameter.name) && comparableText(String(value)) !== comparableText(String(demonstrationValue ?? ""))) changedTarget = true;
    }
    if (complete && changedTarget && groundingExampleHasCoLocatedEvidence(candidate, parameters, snapshot)) return candidate;
  }
  return undefined;
}

type ParameterTextTokens = Map<string, string[]>;

function isNumericParameterToken(value: string) {
  return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value.trim());
}

function isParameterToken(value: string) {
  const token = value.trim();
  return token.length > 1 || isNumericParameterToken(token);
}

function replaceParameterToken(text: string, token: string, replacement: string) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Numeric values need digit boundaries rather than letter boundaries: a
  // natural-language phrase such as “数量为2件” must still parameterize the
  // 2, while a value of 2 must not rewrite the middle of 12 or 2026.
  if (isNumericParameterToken(token)) return text.replace(new RegExp(`(?<!\\d)${escaped}(?!\\d)`, "gu"), replacement);
  return text.replaceAll(token, replacement);
}

function containsParameterToken(text: string, token: string) {
  if (isNumericParameterToken(token)) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<!\\d)${escaped}(?!\\d)`, "u").test(text);
  }
  return text.includes(token);
}

function parameterTextTokens(parameters: PlannedParameter[], supplied: Record<string, JsonValue>, raw: Record<string, unknown>): ParameterTextTokens {
  const tokens: ParameterTextTokens = new Map();
  for (const parameter of parameters) {
    const values = new Set<string>();
    const example = parameter.exampleValue;
    if ((typeof example === "string" && example.trim().length > 1) || typeof example === "number" || typeof example === "boolean") values.add(String(example).trim());
    const suppliedValue = supplied[parameter.name];
    if ((typeof suppliedValue === "string" && suppliedValue.trim().length > 1) || typeof suppliedValue === "number" || typeof suppliedValue === "boolean") values.add(String(suppliedValue).trim());
    // A site term pairs the demonstrated value with the site's wording for it
    // (from: the user's word, value: the site's, or the other way round). A pair
    // where neither side is the demonstrated value ("地区" → "国家与地区") is a model
    // guess about a generic word; treating it as a demonstration token rewrote the
    // intent to "{{countryName}}{{countryName}}" and made the planned name look
    // demonstration-bound.
    const demonstrated = new Set([...values].map((value) => comparableText(value)));
    const siteTerms = Array.isArray(raw.siteTerms) ? raw.siteTerms : [];
    for (const term of siteTerms) {
      const item = object(term);
      if (item.name !== parameter.name) continue;
      const sides = ["from", "value"].map((key) => typeof item[key] === "string" ? String(item[key]).trim() : "").filter((side) => side.length > 1);
      if (!sides.some((side) => demonstrated.has(comparableText(side)))) continue;
      for (const side of sides) values.add(side);
    }
    tokens.set(parameter.name, [...values].sort((a, b) => b.length - a.length));
  }
  return tokens;
}

function parameterizedGoal(goal: string, parameters: PlannedParameter[], tokens?: ParameterTextTokens) {
  return parameters.reduce((value, parameter) => {
    const replacements = tokens?.get(parameter.name) || [String(parameter.exampleValue)];
    return replacements.filter(isParameterToken).reduce((result, token) => replaceParameterToken(result, token, `{{${parameter.name}}}`), value);
  }, goal);
}

function containsDemonstrationValue(value: string | undefined, parameters: PlannedParameter[], tokens?: ParameterTextTokens) {
  const normalized = comparableText(value);
  return Boolean(normalized) && parameters.some((parameter) => {
    const candidates = tokens?.get(parameter.name) || (typeof parameter.exampleValue === "string" ? [parameter.exampleValue] : []);
    return candidates.some((candidate) => {
      const example = comparableText(candidate);
      return isParameterToken(example) && containsParameterToken(normalized, example);
    });
  });
}

/** `{{something}}`: a hole an input fills, which only the intent is allowed to carry. */
function carriesInputPlaceholder(value: string) {
  return /\{\{\s*[\p{L}_][\p{L}\p{N}_.-]*\s*\}\}/u.test(value);
}

/**
 * The name and the description are read by a person; the intent is a template
 * the runtime fills. When every candidate label looked demonstration-bound the
 * name fell back to the intent, and the capability centre listed a capability
 * called 「给我查看{{celebrityName}}热搜」 — a placeholder shown to the reader.
 *
 * So a label is chosen in this order: one that is neither demonstration-bound
 * nor templated, then any untemplated one, and only then the template with its
 * holes taken out, which at least reads as words.
 */
/** The value this run actually demonstrated with, as opposed to a word a site-term turn paired with it. */
function containsDemonstratedValue(value: string, parameters: PlannedParameter[]) {
  const normalized = comparableText(value);
  if (!normalized) return false;
  return parameters.some((parameter) => {
    const example = comparableText(typeof parameter.exampleValue === "string" ? parameter.exampleValue : "");
    return isParameterToken(example) && containsParameterToken(normalized, example);
  });
}

function reusableSummaryText(candidates: Array<string | unknown>, fallback: string, parameters: PlannedParameter[], tokens?: ParameterTextTokens) {
  // A PageAgent candidate can be the best business label (for example,
  // “加入购物车”), but it is commonly copied from the concrete user request
  // (for example “打开衣服分类”). Expanded localized tokens let us reject the
  // latter while preserving a genuinely better candidate label.
  //
  // Two things disqualify a label, and they are not equally serious. Carrying
  // the value this run demonstrated with — 「查看周深的热搜话题列表」 — is a leak
  // the publish gate refuses outright, so it is never acceptable. Carrying a
  // word a site-term turn merely paired with that value — 「明星」 for 周深 — is
  // a weaker signal, and preferring to avoid it must not push the choice onto
  // a label that leaks: that is what happened, and the capability was refused
  // for demonstration_value_leaked after the good label had been passed over.
  const values = [...candidates, fallback]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => Boolean(value));
  const safe = values.filter((value) => !containsDemonstratedValue(value, parameters));
  const reusable = safe.filter((value) => !containsDemonstrationValue(value, parameters, tokens));
  return reusable.find((value) => !carriesInputPlaceholder(value))
    || safe.find((value) => !carriesInputPlaceholder(value))
    || (reusable[0] || safe[0] || fallback).replace(/\{\{\s*[\p{L}_][\p{L}\p{N}_.-]*\s*\}\}/gu, "").replace(/\s+/gu, " ").trim();
}

function splitCompositeSearchValue(value: string) {
  const normalized = value.trim();
  // Keep the decomposition deliberately conservative: Chinese color
  // modifiers followed by an optional 的 are unambiguous natural-language
  // facets.  The 的-less form is common in ordinary customer messages
  // (例如“黑色T恤”), and must retain the facet instead of collapsing it into
  // one opaque search term.  Keep the vocabulary finite so product names such
  // as “Brown bear cushion” are never guessed apart.
  const match = normalized.match(/^((?:黑|白|棕|红|蓝|绿|黄|灰|紫|粉|橙|金|银)(?:色)?)(?:的)?(.{2,})$/u);
  if (!match) return undefined;
  return { modifier: match[1], noun: match[2].trim() };
}

function inferGoalFacet(goal: string) {
  const chinese = goal.match(/((?:黑|白|棕|红|蓝|绿|黄|灰|紫|粉|橙|金|银)(?:色)?)(?:的)?([\p{L}\p{N}][\p{L}\p{N}\s-]{1,})/u);
  const english = goal.match(/\b(black|white|brown|red|blue|green|yellow|gray|grey|purple|pink|orange)\s+([a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)?)/iu);
  const match = chinese || english;
  if (!match) return undefined;
  const modifier = match[1].trim();
  const noun = match[2]
    .replace(/(?:加入|添加|放入|购物车|购物袋|购买|搜索|查找|寻找|add|cart|buy|search|find|to\s+cart).*$/iu, "")
    .trim();
  return noun.length >= 2 ? { modifier, noun } : undefined;
}

function looksLikeConcreteProductLabel(value: string, snapshot: Awaited<ReturnType<typeof inspectPage>>) {
  const normalized = comparableText(value);
  // Short nouns such as "mug" or "cushion" are reusable search terms even
  // though they occur inside product cards. A multi-token value that matches
  // an observed product-card label is a demonstrated identity and must not
  // become an input alias.
  if (normalized.length < 8 || normalized.split(" ").length < 2) return false;
  return snapshot.elements.some((element) => {
    const href = String(element.href || "");
    if (!/\.html(?:[?#]|$)/iu.test(href) && element.container?.css !== "article") return false;
    const corpus = comparableText([element.name, element.label, element.container?.text, element.container?.heading].filter(Boolean).join(" "));
    return corpus === normalized || corpus.includes(normalized);
  });
}

function ensureGoalFacetParameter(parameters: PlannedParameter[], goal: string) {
  if (parameters.some((parameter) => /(?:color|colour|颜色|色|material|size|brand|facet|filter)/iu.test(parameter.name))) return parameters;
  const searchParameter = parameters.find((parameter) => /^(?:query|keyword|productKeyword|searchTerm|productType|item|target)$/iu.test(parameter.name));
  const inferred = inferGoalFacet(goal);
  if (!searchParameter || !inferred) return parameters;
  return [
    ...parameters,
    { name: "color", type: "string" as const, description: "商品的颜色或其他可筛选修饰条件。", required: true, exampleValue: inferred.modifier },
  ];
}

function goalTargetValueFromEvidence(goal: string, rawSiteTerms: unknown, parameter: PlannedParameter, colorParameter: PlannedParameter | undefined, snapshot: Awaited<ReturnType<typeof inspectPage>>, extraEvidence = "") {
  const inferred = inferGoalFacet(goal);
  if (!inferred) return undefined;
  const visibleRegions = [
    snapshot.heading,
    snapshot.title,
    extraEvidence,
    ...snapshot.elements.flatMap((element) => [element.container?.heading, element.container?.text, element.name]),
  ]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map(comparableText);
  const colorNames: Record<string, string> = {
    "黑": "black", "黑色": "black", "白": "white", "白色": "white",
    "棕": "brown", "棕色": "brown", "红": "red", "红色": "red",
    "蓝": "blue", "蓝色": "blue", "绿": "green", "绿色": "green",
    "黄": "yellow", "黄色": "yellow", "灰": "gray", "灰色": "gray",
  };
  const facetSiteValue = colorNames[inferred.modifier] || String(colorParameter?.exampleValue || "");
  const rawCandidates = (Array.isArray(rawSiteTerms) ? rawSiteTerms : [])
    .map((item) => object(item))
    .filter((item) => String(item.name || "") === parameter.name)
    .flatMap((item) => [item.value, item.from])
    .filter((item): item is string => typeof item === "string" && item.trim().length > 1)
    .map((item) => item.trim());
  const commonAliases: Record<string, string[]> = {
    "马克杯": ["mug"], "杯子": ["mug"], mug: ["mug"],
    "垫子": ["cushion"], cushion: ["cushion"],
    "衣服": ["clothes"], clothes: ["clothes"],
    "衬衫": ["shirt"], shirt: ["shirt"],
    "鞋": ["shoe", "shoes"], shoe: ["shoe", "shoes"], shoes: ["shoe", "shoes"],
    "手机": ["phone", "mobile"], phone: ["phone", "mobile"], mobile: ["phone", "mobile"],
  };
  const knownGoalAliases = commonAliases[inferred.noun] || [];
  // When a localized noun has a known site-language grounding, never fall
  // back to the model's demonstration value.  A page showing a black
  // t-shirt is not evidence that “垫子” means “t-shirt”; accepting that
  // fallback creates a valid-looking but semantically wrong capability.
  const groundedCandidates = knownGoalAliases.length
    ? rawCandidates.filter((candidate) => knownGoalAliases.some((alias) => comparableText(alias) === comparableText(candidate))).concat(knownGoalAliases)
    : [...rawCandidates, String(parameter.exampleValue || "")];
  const candidates = [...new Set(groundedCandidates)]
    .filter((item) => item.length > 1)
    .filter((item) => !looksLikeConcreteProductLabel(item, snapshot))
    .map(comparableText);
  const coLocated = candidates.find((candidate) => visibleRegions.some((region) => region.includes(candidate) && (!facetSiteValue || region.includes(comparableText(facetSiteValue)))));
  if (coLocated) {
    const original = candidates.find((candidate) => comparableText(candidate) === coLocated);
    return original || coLocated;
  }
  return undefined;
}

export function decomposeCompositeSearchParameter(parameters: PlannedParameter[]) {
  // A search request commonly carries other independent inputs (for example
  // quantity).  Decompose the one composite search parameter without
  // discarding those inputs; requiring the whole parameter list to have one
  // item would silently lose color/material facets in otherwise valid tasks.
  const candidates = parameters.filter((parameter) =>
    /^(?:query|keyword|productKeyword|searchTerm|target|item)$/iu.test(parameter.name)
    && typeof parameter.exampleValue === "string",
  );
  if (candidates.length !== 1) return parameters;
  const parameter = candidates[0];
  if (!/^(?:query|keyword|productKeyword|searchTerm|target|item)$/iu.test(parameter.name) || typeof parameter.exampleValue !== "string") return parameters;
  const split = splitCompositeSearchValue(parameter.exampleValue);
  if (!split) return parameters;
  const nounName = parameter.name === "query" ? "query" : "productType";
  return parameters.flatMap((item) => item === parameter ? [
    { ...parameter, name: nounName, description: "要查找的商品主体，例如垫子、马克杯或衣服。", exampleValue: split.noun },
    { name: "color", type: "string" as const, description: "商品的颜色或其他可筛选修饰条件。", required: true, exampleValue: split.modifier },
  ] : [item]);
}

/**
 * Models occasionally repeat a successful fill because the current DOM
 * snapshot does not expose the input's live value.  A repeated search fill is
 * not progress: submit the form with the real keyboard action so discovery
 * can observe the next page.  For other repeated fills we fail explicitly
 * instead of consuming the whole exploration budget on the same node.
 */
export function overrideRepeatedAction(action: ExplorerAction, snapshot: Awaited<ReturnType<typeof inspectPage>>, history: Array<Record<string, unknown>>): ExplorerAction {
  const previous = history.at(-1);
  if (!previous || previous.action !== action.action || Number(previous.index) !== Number(action.index)) return action;
  if (action.action === "fill") {
    const element = snapshot.elements.find((candidate) => candidate.index === action.index);
    if (element && (element.role === "searchbox" || element.inputType === "search" || /搜索|search|关键词|关键字/i.test(`${element.name || ""} ${element.placeholder || ""}`))) {
      return { action: "press", key: "Enter", reason: "repeated_search_fill_submit" };
    }
    // A compact snapshot may not expose the live value or the submit control
    // for an ordinary text-like field (numeric controls are commonly exposed
    // as `input[type=text]` too). The first fill has already committed the
    // value in the page. Blur it with a real Tab key so change/validation
    // handlers run and the next model turn can target the control that follows
    // the field. This is based on DOM input semantics, not a site or business
    // object name, and therefore works for quantity, address, date and other
    // user-supplied fields alike.
    if (element && (element.tag === "input" || element.tag === "textarea")) {
      return { action: "press", key: "Tab", reason: "repeated_textlike_fill_blur" };
    }
    return { action: "fail", reason: "repeated_fill_without_page_progress" };
  }
  return action;
}

function isSearchOnlyGoal(goal: string) {
  const text = goal.normalize("NFKC");
  return /搜索|查找|寻找|search|find/i.test(text)
    && !/加入|添加|放入|购物车|购物袋|购买|结算|详情|打开|删除|移除|add|cart|buy|checkout|detail|remove/i.test(text);
}

function urlContainsAppliedInput(url: string, input: CapabilityTaskInput) {
  const normalizedUrl = decodeURIComponent(url).toLocaleLowerCase();
  return Object.values(input.parameters).some((value) => {
    if (typeof value !== "string" || value.trim().length < 2) return false;
    const token = value.trim().toLocaleLowerCase();
    return normalizedUrl.includes(token);
  });
}

/**
 * A search capability ends at the result set.  Clicking a product card after
 * the query has been submitted changes the business intent to "open detail"
 * and bakes one concrete result/page into the candidate program.  Treat that
 * model proposal as a terminal result instead of allowing a quality failure
 * (or, worse, publishing a scoped detail-page capability).
 */
function guardSearchResultDetailClick(action: ExplorerAction, snapshot: Awaited<ReturnType<typeof inspectPage>>, goal: string, input: CapabilityTaskInput, history: Array<Record<string, unknown>>) {
  if (action.action !== "click" || action.index === undefined) return action;
  const element = snapshot.elements.find((candidate) => candidate.index === action.index);
  const hasSubmitted = history.some((item) => item.action === "press" || item.action === "click")
    && history.some((item) => item.action === "fill");
  const aliases = object(input.context.__capabilityInputAliases);
  const queryValues = Object.entries(input.parameters)
    .filter(([key, value]) => typeof value === "string" && value.trim().length > 1 && /product|item|keyword|query|search|category|商品|产品|物品|关键词|类别/iu.test(key))
    .flatMap(([key, value]) => {
      const values = [String(value)];
      const map = object(aliases[key]);
      if (typeof map[String(value)] === "string") values.push(String(map[String(value)]));
      return values;
    })
    .map(comparableText);
  const pageText = comparableText(`${snapshot.url} ${snapshot.heading} ${snapshot.text}`);
  const resultPage = /\/search(?:[/?#]|$)|[?&](?:q|query|keyword)=/i.test(snapshot.url);
  const queryGrounded = queryValues.length > 0 && queryValues.some((value) => pageText.includes(value));
  if (!hasSubmitted || !resultPage || !queryGrounded) return action;
  // For a write goal, do not open the first matching card when its card has
  // no enabled Add-to-cart control (customizable/out-of-stock products are a
  // common example). Choose a named dynamic link from another co-located card
  // that can actually complete the requested write. This is DOM evidence, not
  // a site/product-specific fallback.
  const writeGoal = /加入|添加|购物车|add\s*to\s*cart|buy|purchase/iu.test(goal);
  if (writeGoal && element?.container) {
    const sameCard = (candidate: PageElement) => candidate.container?.css === element.container?.css && candidate.container?.text === element.container?.text;
    const cardHasEnabledAdd = snapshot.elements.some((candidate) => sameCard(candidate)
      && candidate.role === "button"
      && /add\s*to\s*cart|加入购物车|添加到购物车/iu.test(String(candidate.name || ""))
      && !candidate.disabled && !candidate.ariaDisabled);
    if (!cardHasEnabledAdd) {
      const replacement = snapshot.elements.find((candidate) => candidate.tag === "a"
        && candidate.href
        && candidate.container
        && queryValues.some((value) => comparableText(candidate.container?.text || "").includes(value))
        && snapshot.elements.some((add) => add.role === "button"
          && add.container?.css === candidate.container?.css
          && add.container?.text === candidate.container?.text
          && /add\s*to\s*cart|加入购物车|添加到购物车/iu.test(String(add.name || ""))
          && !add.disabled && !add.ariaDisabled));
      if (replacement) return { action: "click" as const, index: replacement.index, reason: "search_card_without_enabled_write_replaced" };
    }
  }
  if (isSearchOnlyGoal(goal)) return { action: "done" as const, reason: "search_results_ready" };
  return action;
}

function normalizedScope(value: unknown): CapabilityScope | undefined {
  const raw = object(value);
  const kind = raw.kind === "site-global" || raw.kind === "category-scoped" || raw.kind === "page-scoped" ? raw.kind : undefined;
  const onMismatch = raw.onMismatch === "no-match" || raw.onMismatch === "clarify" || raw.onMismatch === "page-agent" ? raw.onMismatch : undefined;
  if (!kind || !onMismatch) return undefined;
  const rawMatch = object(raw.match);
  const match = {
    ...(Array.isArray(rawMatch.requiredInputPaths) ? { requiredInputPaths: rawMatch.requiredInputPaths.filter((path): path is string => typeof path === "string" && Boolean(path.trim())).slice(0, 20) } : {}),
    ...(Array.isArray(rawMatch.tokens) ? { tokens: rawMatch.tokens.filter((token): token is string => typeof token === "string" && Boolean(token.trim())).slice(0, 20) } : {}),
    ...(Array.isArray(rawMatch.urlPatterns) ? { urlPatterns: rawMatch.urlPatterns.filter((pattern): pattern is string => typeof pattern === "string" && Boolean(pattern.trim())).slice(0, 12) } : {}),
  };
  return { kind, ...(Object.keys(match).length ? { match } : {}), onMismatch };
}

/**
 * Labels that belong to controls themselves: a search box placeholder, the
 * "Search" / "Log in" button text. They appear in the page text, but they are
 * interface chrome, not business values. In production the model once mapped
 * the user's keyword to the search box placeholder; the exploration then really
 * searched for the placeholder, found nothing, and froze that sentence into the
 * contract.
 */
function controlChromeLabels(snapshot: Awaited<ReturnType<typeof inspectPage>>, experience?: CapabilityTaskInput["experience"]) {
  const labels = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && value.trim()) labels.add(comparableText(value)); };
  for (const element of snapshot.elements) {
    const tag = String(element.tag || "").toLowerCase();
    const role = String(element.role || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea" || tag === "select" || ["textbox", "combobox", "searchbox", "spinbutton"].includes(role);
    const button = tag === "button" || role === "button";
    if (!typing && !button) continue;
    add(element.name); add(element.label); add(element.placeholder);
  }
  for (const action of experience?.actions || []) {
    if (action.action !== "fill" && action.action !== "select") continue;
    add(action.element?.accessibleName); add(action.element?.label); add(action.element?.placeholder); add(action.element?.name);
  }
  return labels;
}

function normalizedInputAliases(
  value: unknown,
  parameters: PlannedParameter[],
  snapshot: Awaited<ReturnType<typeof inspectPage>>,
  rawParameters: PlannedParameter[] = parameters,
  experience?: CapabilityTaskInput["experience"],
): CapabilityInputAliases | undefined {
  const declared = new Set(parameters.map((parameter) => parameter.name));
  const visibleText = snapshotEvidenceText(snapshot).toLocaleLowerCase();
  const chrome = controlChromeLabels(snapshot, experience);
  const aliases: CapabilityInputAliases = {};
  for (const item of Array.isArray(value) ? value : []) {
    const raw = object(item);
    let name = typeof raw.name === "string" ? raw.name.trim() : "";
    const alias = typeof raw.value === "string" ? raw.value.trim() : "";
    if (!name || alias.length < 2 || !visibleText.includes(alias.toLocaleLowerCase())) continue;
    if (chrome.has(comparableText(alias))) continue;
    let example = typeof raw.from === "string" && raw.from.trim()
      ? raw.from.trim()
      : rawParameters.find((parameter) => parameter.name === name)?.exampleValue;
    // The parameter planner may first emit one composite search parameter
    // (searchTerm=“黑色T恤”) and cleanParameterPlan then split it into
    // productType + color. Preserve the model's visible site-language alias
    // on the renamed noun parameter instead of dropping it because the old
    // transport name is no longer declared.
    if (!declared.has(name)) {
      const composite = typeof example === "string" ? splitCompositeSearchValue(example) : undefined;
      const source = rawParameters.find((parameter) => parameter.name === name);
      if (!composite || !source) continue;
      name = name === "query" ? "query" : "productType";
      example = composite.noun;
    }
    if (!declared.has(name) || typeof example !== "string" || example.trim().length < 2) continue;
    if (typeof example !== "string" || example.trim().length < 2 || example === alias) continue;
    if (targetIdentityPath(name) && looksLikeConcreteProductLabel(alias, snapshot)) continue;
    aliases[name] ||= {};
    aliases[name][example] = alias;
  }
  // Colors are a bounded facet vocabulary. If the model omitted a siteTerms
  // row, still preserve the user's color constraint when the page visibly
  // exposes its English equivalent; this is deterministic evidence grounding,
  // not a semantic guess for arbitrary product names.
  const colorParameter = parameters.find((parameter) => /(?:color|colour|颜色|色)/iu.test(parameter.name) && typeof parameter.exampleValue === "string");
  if (colorParameter) {
    const colorNames: Record<string, string> = {
      "黑": "black", "黑色": "black", "白": "white", "白色": "white",
      "棕": "brown", "棕色": "brown", "红": "red", "红色": "red",
      "蓝": "blue", "蓝色": "blue", "绿": "green", "绿色": "green",
      "黄": "yellow", "黄色": "yellow", "灰": "gray", "灰色": "gray",
    };
    const userValue = typeof colorParameter.exampleValue === "string" ? colorParameter.exampleValue.trim() : "";
    const siteValue = colorNames[userValue];
    if (siteValue && visibleText.includes(siteValue)) {
      aliases[colorParameter.name] ||= {};
      aliases[colorParameter.name][userValue] = siteValue;
    }
    // Preserve the bounded locale vocabulary that is visibly evidenced by
    // this page, not just the demonstration colour. This lets a published
    // capability accept later requests such as 棕色 even when the demo used
    // 白色, while still refusing colours the site never exposed.
    for (const [localized, english] of Object.entries(colorNames)) {
      if (visibleText.includes(english)) {
        aliases[colorParameter.name] ||= {};
        aliases[colorParameter.name][localized] = english;
      }
    }
  }
  // A terminal PageAgent receipt can contain a user-language fill followed by
  // the actual site-language search URL (for example “垫子” followed by
  // `search?s=cushion`).  Preserve that observed relation as a reusable
  // runtime alias.  It is evidence-derived, site-neutral, and does not bake
  // the URL into the Program: later callers still provide the public input
  // value and the host only translates it before the Stage runs.
  const targetParameters = parameters.filter((parameter) => targetIdentityPath(parameter.name));
  for (const [index, action] of (experience?.actions || []).entries()) {
    if (action.action !== "fill") continue;
    const rawValue = action.input.value ?? action.input.text;
    if (typeof rawValue !== "string" || rawValue.trim().length < 2) continue;
    const userValue = rawValue.trim();
    const sourceParameter = targetParameters.find((parameter) => comparableText(String(parameter.exampleValue)) === comparableText(userValue))
      || targetParameters[0];
    if (!sourceParameter) continue;
    for (const later of (experience?.actions || []).slice(index)) {
      const pageUrl = later.page?.url;
      if (typeof pageUrl !== "string" || !pageUrl.trim()) continue;
      let parsed: URL;
      try { parsed = new URL(pageUrl); } catch { continue; }
      const siteValue = ["s", "q", "query", "keyword", "search", "term"]
        .map((key) => parsed.searchParams.get(key)?.trim() || "")
        .find((candidate) => candidate.length > 1 && comparableText(candidate) !== comparableText(userValue));
      if (!siteValue) continue;
      aliases[sourceParameter.name] ||= {};
      aliases[sourceParameter.name][userValue] = siteValue;
      break;
    }
  }
  return Object.keys(aliases).length ? aliases : undefined;
}

function scopePath(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`.slice(0, 500);
  } catch {
    return url.slice(0, 500);
  }
}

/**
 * Classify the route evidence before Draft/Validation. The returned object is
 * the small runtime Scope contract; explanatory dependency decisions remain
 * in Trace only.
 */
export function inferCapabilityScope(startUrl: string, steps: ProgramStep[], planned?: Pick<ParameterPlan, "scope" | "parameters">): CapabilityScope {
  const start = new URL(startUrl);
  const observed = [startUrl, ...steps.flatMap((step) => {
    if (step.action !== "navigate" || step.value?.source !== "literal" || typeof step.value.value !== "string") return [];
    return [step.value.value];
  })];
  const paths = [...new Set(observed.map(scopePath))];
  const fixedPaths = observed.filter((url) => {
    try {
      const parsed = new URL(url, startUrl);
      if (parsed.origin !== start.origin) return false;
      const source = steps.find((step) => step.action === "navigate" && step.value?.source === "literal" && step.value.value === url)?.value;
      if (source?.source !== "literal" || typeof source.value !== "string") return false;
      const decoded = decodeURIComponent(source.value);
      const parameterized = planned?.parameters?.some((parameter) => {
        const example = typeof parameter.exampleValue === "string" ? parameter.exampleValue.trim() : "";
        return Boolean(example.length > 1 && decoded.includes(example));
      });
      if (parameterized) return false;
      return parsed.pathname !== start.pathname || parsed.search !== start.search || parsed.hash !== start.hash;
    } catch {
      return false;
    }
  });
  const supplied = planned?.scope;
  if (!fixedPaths.length) {
    return supplied || { kind: "site-global", onMismatch: "page-agent" };
  }
  const categoryPath = fixedPaths.some((url) => /(?:\/category(?:\/|$)|\/categories?(?:\/|$)|\/(?:\d+-)?[a-z0-9][a-z0-9-]*(?:\.html)?$)/i.test(scopePath(url)));
  const kind = categoryPath ? "category-scoped" : "page-scoped";
  const requiredInputPaths = supplied?.match?.requiredInputPaths || [];
  return {
    kind,
    match: {
      ...(requiredInputPaths.length ? { requiredInputPaths } : {}),
      urlPatterns: [...new Set(fixedPaths.map((url) => scopePath(url).split("?")[0]))],
    },
    onMismatch: requiredInputPaths.length ? "clarify" : "no-match",
  };
}

function snapshotEvidenceText(snapshot: Awaited<ReturnType<typeof inspectPage>>) {
  return comparableText([
    snapshot.url,
    snapshot.title,
    snapshot.heading,
    snapshot.text,
    ...snapshot.elements.flatMap((element) => [element.name, element.label, element.placeholder, element.value, element.container?.heading, element.container?.text]),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" "));
}

function scalarControlValue(value: string, type: PlannedParameter["type"]): JsonValue | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (type === "number") {
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (type === "boolean") {
    if (/^(?:true|1|yes|on)$/iu.test(normalized)) return true;
    if (/^(?:false|0|no|off)$/iu.test(normalized)) return false;
    return undefined;
  }
  return normalized;
}

function sameJsonScalar(left: JsonValue | undefined, right: JsonValue | undefined) {
  return left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Promote a model-proposed example to a default only when a visible DOM
 * control exposes the same initial value and its accessible metadata matches
 * the business parameter. This is deliberately site-neutral: it works for a
 * quantity, date, locale, sort order, or any other scalar control without a
 * field-name special case. The DOM control is evidence, not an instruction.
 */
function applyPageControlDefaults(
  parameters: PlannedParameter[],
  snapshot: Awaited<ReturnType<typeof inspectPage>>,
  authoredInputPaths: ReadonlySet<string> = new Set(),
) {
  return parameters.map((parameter) => {
    // A value written by the Explorer is no longer evidence of a site
    // default. Existing defaults were grounded before the write and remain
    // valid; this guard only prevents a new default from contaminated state.
    if (authoredInputPaths.has(parameter.name)) return parameter;
    const parameterTokens = `${parameter.name} ${parameter.description || ""}`
      .normalize("NFKC")
      .split(/[^\p{L}\p{N}]+/u)
      .map((value) => comparableText(value))
      .filter((value) => value.length >= 2);
    if (!parameterTokens.length) return parameter;
    const example = scalarControlValue(String(parameter.exampleValue), parameter.type);
    const candidate = snapshot.elements
      .filter((element) => ["input", "textarea", "select"].includes(element.tag))
      .filter((element) => element.inputType !== "hidden" && element.inputType !== "password")
      .map((element) => {
        const value = element.inputType === "checkbox"
          ? parameter.type === "boolean"
            ? element.checked
            : element.checked === true && typeof element.value === "string"
              ? scalarControlValue(element.value, parameter.type)
              : undefined
          : element.inputType === "radio"
            ? element.checked === true && typeof element.value === "string"
              ? scalarControlValue(element.value, parameter.type)
              : undefined
            : typeof element.value === "string"
              ? scalarControlValue(element.value, parameter.type)
              : undefined;
        const corpus = comparableText([element.name, element.label, element.placeholder, element.css, element.container?.heading, element.container?.text]
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0).join(" "));
        const overlap = parameterTokens.filter((token) => corpus.includes(token)).length;
        const exactExample = sameJsonScalar(value, example);
        return { element, value, overlap, exactExample, score: overlap * 3 + (exactExample ? 2 : 0) };
      })
      .filter((item) => item.value !== undefined && item.overlap > 0 && item.exactExample)
      .sort((left, right) => right.score - left.score)[0];
    if (!candidate || candidate.value === undefined) return parameter;
    const ref = `page-control:${candidate.element.css || candidate.element.index}`;
    if (parameter.defaultValue !== undefined && parameter.defaultEvidence?.source === "page-control" && parameter.defaultEvidence.ref === ref && sameJsonScalar(parameter.defaultValue, candidate.value)) return parameter;
    return {
      ...parameter,
      defaultValue: candidate.value,
      defaultEvidence: { source: "page-control" as const, ref },
      required: false,
    };
  });
}

function ensureDefaultOmissionExamples(parameters: PlannedParameter[], examples: Array<Record<string, JsonValue>>) {
  const defaultNames = parameters.filter((parameter) => parameter.defaultValue !== undefined).map((parameter) => parameter.name);
  if (!defaultNames.length) return examples;
  const next = [...examples];
  const demonstration = Object.fromEntries(parameters.map((parameter) => [parameter.name, parameter.exampleValue])) as Record<string, JsonValue>;
  for (const name of defaultNames) {
    const omitted = Object.fromEntries(Object.entries(demonstration).filter(([key]) => key !== name)) as Record<string, JsonValue>;
    if (!next.some((candidate) => candidate[name] === undefined)) next.push(omitted);
  }
  return next;
}

function finalizeGroundingExamples(parameters: PlannedParameter[], examples: Array<Record<string, JsonValue>>) {
  const withOmissions = ensureDefaultOmissionExamples(parameters, examples);
  const defaultNames = parameters.filter((parameter) => parameter.defaultValue !== undefined).map((parameter) => parameter.name);
  if (!defaultNames.length) return withOmissions.slice(0, 2);
  const omissions = withOmissions.filter((candidate) => defaultNames.some((name) => candidate[name] === undefined));
  const ordinary = withOmissions.filter((candidate) => !defaultNames.some((name) => candidate[name] === undefined));
  const limit = Math.max(2, defaultNames.length + 2);
  return [...ordinary.slice(0, Math.max(1, limit - omissions.length)), ...omissions].slice(0, limit);
}

function groundingValueHasEvidence(parameter: PlannedParameter, value: JsonValue, demonstration: JsonValue, evidenceText: string) {
  if (value === demonstration) return true;
  // Route, product, category and search inputs are business entities. A
  // model-generated alternative is safe to replay only when the current
  // snapshot actually contains evidence for it. This prevents a plausible
  // but foreign value (for example an earbud product not present in the
  // shop fixture) from turning a valid capability into a false NoResult.
  if (!isUserInputPath(parameter.name) || typeof value !== "string") return true;
  const candidate = comparableText(value);
  return candidate.length > 1 && evidenceText.includes(candidate);
}

function selectionPath(path: string) {
  return /(?:query|keyword|search|term|product|item|target|sku|variant|object|attribute|property|option|color|colour|size|brand|material|filter|facet|category|department|分类|属性|选项|颜色|尺码|品牌|材质|筛选)/iu.test(path)
    && !/(?:quantity|count|amount|qty|number)/iu.test(path);
}

function targetIdentityPath(path: string) {
  if (/(?:attribute|property|facet|filter|color|colour|material|size|brand|option|属性|颜色|材质|尺码|品牌|筛选)/iu.test(path)) return false;
  return /(?:query|keyword|search|term|product|item|target|sku|variant|object|商品|产品)/iu.test(path)
    && !/(?:quantity|count|amount|qty|number)/iu.test(path);
}

/**
 * A grounding example must describe one observable business object, not values
 * that merely occur somewhere on the same page.  For example, the start
 * snapshot contains both a white mug and a brown cushion; combining
 * `cushion + white` would create a false example that no product card supports.
 * Keep this deterministic and evidence-backed before asking the model to
 * repair the second example.
 */
function groundingExampleHasCoLocatedEvidence(value: Record<string, JsonValue>, parameters: PlannedParameter[], snapshot: Awaited<ReturnType<typeof inspectPage>>) {
  const constrained = parameters
    .filter((parameter) => selectionPath(parameter.name) && typeof value[parameter.name] === "string")
    .map((parameter) => comparableText(String(value[parameter.name])))
    .filter((item) => item.length > 1);
  if (constrained.length < 2) return true;
  const regions = [
    snapshot.heading,
    snapshot.title,
    ...snapshot.elements.flatMap((element) => [element.container?.heading, element.container?.text, element.name]),
  ]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map(comparableText);
  return regions.some((region) => constrained.every((item) => region.includes(item)));
}

function semanticParameterFamily(name: string) {
  const normalized = String(name || "").trim();
  // These names are different spellings of one reusable search target.  Keep
  // identifier-style inputs (SKU/product id) separate: a caller may need to
  // provide both a human search term and an exact identifier.
  if (/(?:sku|product\s*id|item\s*id|article\s*(?:number|no)|商品编号|产品编号|货号)/iu.test(normalized)) return undefined;
  if (/(?:color|colour|颜色|色)/iu.test(normalized)) return "facet:color";
  if (/(?:material|材质)/iu.test(normalized)) return "facet:material";
  if (/(?:size|尺码|尺寸)/iu.test(normalized)) return "facet:size";
  if (/(?:brand|品牌)/iu.test(normalized)) return "facet:brand";
  if (/(?:attribute|property|facet|filter|option|属性|筛选)/iu.test(normalized)) return "facet:generic";
  if (/(?:query|keyword|search|term|product(?:keyword|type|name)?|item|target|object|商品|产品)/iu.test(normalized)) return "target";
  return undefined;
}

function dedupeSemanticParameters(parameters: PlannedParameter[], supplied: Record<string, JsonValue>) {
  const aliases: Record<string, string> = {};
  const result: PlannedParameter[] = [];
  const groups = new Map<string, PlannedParameter[]>();
  for (const parameter of parameters) {
    const family = semanticParameterFamily(parameter.name);
    if (!family) {
      result.push(parameter);
      continue;
    }
    groups.set(family, [...(groups.get(family) || []), parameter]);
  }
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    const suppliedMembers = group.filter((parameter) => supplied[parameter.name] !== undefined);
    // If the caller explicitly supplied two distinct values in the same
    // family, preserve both: they may be an intentional conjunction.  The
    // duplicate generated by the model is only collapsed when one canonical
    // value is supplied (the common B -> C case) or when no caller value
    // exists at all.
    const suppliedValues = new Set(suppliedMembers.map((parameter) => JSON.stringify(supplied[parameter.name])));
    if (suppliedMembers.length > 1 && suppliedValues.size > 1) {
      result.push(...group);
      continue;
    }
    const keep = suppliedMembers[0] || group[0];
    const merged: PlannedParameter = {
      ...keep,
      required: group.some((parameter) => parameter.required),
      ...(keep.defaultValue === undefined
        ? (group.find((parameter) => parameter.defaultValue !== undefined)
          ? { defaultValue: group.find((parameter) => parameter.defaultValue !== undefined)?.defaultValue, defaultEvidence: group.find((parameter) => parameter.defaultEvidence)?.defaultEvidence }
          : {})
        : {}),
    };
    result.push(merged);
    for (const dropped of group) {
      if (dropped.name !== keep.name) aliases[dropped.name] = keep.name;
    }
  }
  return { parameters: result, aliases };
}

function remapParameterReferences(raw: Record<string, unknown>, aliases: Record<string, string>) {
  if (!Object.keys(aliases).length) return raw;
  const remapObject = (value: unknown) => {
    const source = object(value);
    const output: Record<string, unknown> = { ...source };
    for (const [from, to] of Object.entries(aliases)) {
      if (output[to] === undefined && output[from] !== undefined) output[to] = output[from];
      delete output[from];
    }
    return output;
  };
  const siteTerms = Array.isArray(raw.siteTerms)
    ? raw.siteTerms.map((value) => {
      const item = object(value);
      const name = typeof item.name === "string" ? aliases[item.name] || item.name : item.name;
      return { ...item, ...(name ? { name } : {}) };
    })
    : raw.siteTerms;
  const groundingExamples = Array.isArray(raw.groundingExamples) ? raw.groundingExamples.map(remapObject) : raw.groundingExamples;
  return { ...raw, siteTerms, groundingExamples };
}

/**
 * The value an alias table resolves `value` to for input `name`, compared
 * without case: "Living room" and "living" are one room when the table maps
 * one to the other.
 */
function aliasMeaning(name: string, value: JsonValue | undefined, aliases: CapabilityInputAliases | undefined) {
  if (typeof value !== "string") return JSON.stringify(value ?? null);
  const table = aliases?.[name] || {};
  const key = Object.keys(table).find((candidate) => comparableText(candidate) === comparableText(value));
  return comparableText(key ? table[key] : value);
}

function sameExampleMeaning(left: Record<string, JsonValue>, right: Record<string, JsonValue>, aliases: CapabilityInputAliases | undefined) {
  const names = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...names].every((name) => (left[name] === undefined) === (right[name] === undefined) && aliasMeaning(name, left[name], aliases) === aliasMeaning(name, right[name], aliases));
}

/**
 * Write an example's values the way the demonstration wrote that input.
 *
 * The planner may write examples the page address's way ("bedroom") while the
 * demonstration used the visible label ("Living room"), most often on a
 * rebuild whose old contract asked for the address writing. In the other
 * writing an example has no evidence on the page and is dropped, and one that
 * survives may be the demonstrated value spelled differently — so the program
 * was checked against one room twice. The plan's own alias table says which
 * label each address value belongs to.
 */
function inDemonstrationWriting(example: Record<string, JsonValue>, demonstration: Record<string, JsonValue>, aliases: CapabilityInputAliases | undefined) {
  return Object.fromEntries(Object.entries(example).map(([name, value]) => {
    const table = aliases?.[name];
    const shown = demonstration[name];
    if (!table || typeof value !== "string" || typeof shown !== "string") return [name, value];
    const labels = Object.keys(table);
    const demonstrationIsLabel = labels.some((label) => comparableText(label) === comparableText(shown));
    if (!demonstrationIsLabel || labels.includes(value)) return [name, value];
    const label = labels.find((candidate) => comparableText(table[candidate]) === comparableText(value));
    return [name, label ?? value];
  })) as Record<string, JsonValue>;
}

export function cleanParameterPlan(raw: Record<string, unknown>, goal: string, input: CapabilityTaskInput, snapshot: Awaited<ReturnType<typeof inspectPage>>, candidateSummary?: CapabilityTaskInput["candidateSummary"], normalizedGoal?: string): ParameterPlan {
  // The planner is also used by deterministic unit/diagnostic callers that
  // only provide page evidence and no pre-supplied parameters. Treat the
  // boundary object as optional here; the real task path still supplies the
  // full CapabilityTaskInput. This keeps parameter cleanup pure and avoids a
  // transport-shape error before semantic normalization can run.
  const supplied = object(input?.parameters) as Record<string, JsonValue>;
  const evidenceText = snapshotEvidenceText(snapshot);
  const evidenceRecord = JSON.stringify({ experience: input.experience, output: input.experience?.output, parameters: supplied });
  const rawParameters = Array.isArray(raw.parameters) ? raw.parameters : [];
  const parsedParameters = rawParameters.flatMap((value): PlannedParameter[] => {
    const item = object(value);
    const name = typeof item.name === "string" && validParameterName(item.name) ? item.name : "";
    const example = supplied[name] ?? item.exampleValue as JsonValue | undefined;
    if (!name || technicalParameterName(name) || example === undefined || example === null || typeof example === "object") return [];
    const type = item.type === "number" || item.type === "boolean" ? item.type : jsonType(example);
    const defaultValue = item.defaultValue;
    const defaultEvidence = object(item.defaultEvidence);
    const defaultSource = defaultEvidence.source;
    const defaultRef = typeof defaultEvidence.ref === "string" ? defaultEvidence.ref.trim() : "";
    const validDefaultSource = defaultSource === "page-control" || defaultSource === "action-receipt" || defaultSource === "business-output" || defaultSource === "admin" || defaultSource === "policy";
    const defaultTypeMatches = defaultValue === null || typeof defaultValue === "string" || typeof defaultValue === "number" || typeof defaultValue === "boolean";
    const defaultValueGrounded = defaultValue !== undefined && defaultTypeMatches && (
      (defaultSource === "page-control" && evidenceText.toLocaleLowerCase().includes(String(defaultValue).toLocaleLowerCase()))
      || ((defaultSource === "action-receipt" || defaultSource === "business-output") && evidenceRecord.includes(JSON.stringify(defaultValue)))
      || ((defaultSource === "admin" || defaultSource === "policy") && defaultRef.length > 0)
    );
    const usableDefault = validDefaultSource && defaultRef && defaultValueGrounded ? defaultValue as JsonValue : undefined;
    const required = usableDefault === undefined ? item.required !== false : false;
    return [{ name, type, description: typeof item.description === "string" ? item.description : name, required, exampleValue: example, ...(usableDefault !== undefined ? { defaultValue: usableDefault, defaultEvidence: { source: defaultSource, ref: defaultRef } as PlannedParameter["defaultEvidence"] } : {}) }];
  });
  for (const [name, exampleValue] of Object.entries(supplied)) {
    if (!validParameterName(name) || technicalParameterName(name) || exampleValue === null || typeof exampleValue === "object" || parsedParameters.some((item) => item.name === name)) continue;
    parsedParameters.push({ name, type: jsonType(exampleValue), description: name, required: true, exampleValue });
  }
  // A session's intake already decided which values are the visitor's: what
  // it supplied, and anything the visitor's own words name. A further value
  // the run happened to pick (a default plug type, a filter on the way) stays
  // fixed in the capability. Made a required input, every caller would have
  // to name it and the explored path, which never chose it from an input,
  // could not act on it. A task with no session has only the planner to
  // define its inputs and is left as it is.
  const visitorWords = [input.experience?.originalGoal, goal].filter((text): text is string => typeof text === "string");
  const visitorParameters = input.experience && Object.keys(supplied).length
    ? parsedParameters.filter((parameter) => parameter.name in supplied
      || visitorWords.some((text) => capabilityTextMentions(text, parameter.exampleValue)))
    : parsedParameters;
  const deduped = dedupeSemanticParameters(visitorParameters, supplied);
  const parameters = deduped.parameters;
  const canonicalRaw = remapParameterReferences(raw, deduped.aliases);
  const parametersBeforeDecomposition = [...parameters];
  const decomposed = decomposeCompositeSearchParameter(parameters);
  parameters.splice(0, parameters.length, ...decomposed);
  // The model may infer only the noun (`query=mug`) even though the original
  // customer request contains a facet (`白色的`). Recover that public facet
  // from the natural-language goal before the contract is built, so it cannot
  // disappear merely because the PageAgent seed omitted it.
  parameters.splice(0, parameters.length, ...ensureGoalFacetParameter(parameters, goal));
  parameters.splice(0, parameters.length, ...applyPageControlDefaults(parameters, snapshot));
  const goalTargetParameter = parameters.find((parameter) => targetIdentityPath(parameter.name));
  const goalColorParameter = parameters.find((parameter) => /(?:color|colour|颜色|色|attribute|属性|facet|filter|modifier|material|size|brand)/iu.test(`${parameter.name} ${parameter.description || ""}`));
  const demonstrationEvidence = JSON.stringify(input.experience || {});
  let groundedGoalValue: string | undefined;
  if (goalTargetParameter) {
    const suppliedTarget = supplied[goalTargetParameter.name];
    if (typeof suppliedTarget === "string" && suppliedTarget.trim()) {
      groundedGoalValue = suppliedTarget.trim();
      goalTargetParameter.exampleValue = suppliedTarget;
    } else {
      groundedGoalValue = goalTargetValueFromEvidence(goal, canonicalRaw.siteTerms, goalTargetParameter, goalColorParameter, snapshot, demonstrationEvidence);
      if (groundedGoalValue) goalTargetParameter.exampleValue = groundedGoalValue;
    }
  }
  if (!parameters.length) {
    const inferred = inferRepeatedEntityParameter(goal, snapshot);
    if (inferred) parameters.push(inferred);
  }
  const parameterNames = new Set(parameters.map((item) => item.name));
  const demonstration = Object.fromEntries(parameters.map((item) => [item.name, supplied[item.name] ?? item.exampleValue])) as Record<string, JsonValue>;
  const inputAliases = normalizedInputAliases(canonicalRaw.siteTerms, parameters, snapshot, parametersBeforeDecomposition, input.experience);
  const rawExamples = Array.isArray(canonicalRaw.groundingExamples) ? canonicalRaw.groundingExamples : [];
  const groundingExamples = [demonstration, ...rawExamples.map((value) => inDemonstrationWriting(object(value) as Record<string, JsonValue>, demonstration, inputAliases))]
    .map((value) => Object.fromEntries([...parameterNames].flatMap((name) => value[name] === undefined ? [] : [[name, value[name]]])) as Record<string, JsonValue>)
    .filter((value) => parameters.every((parameter) => !parameter.required || value[parameter.name] !== undefined))
    .filter((value) => parameters.every((parameter) => groundingValueHasEvidence(parameter, value[parameter.name], demonstration[parameter.name], evidenceText)))
    .filter((value) => JSON.stringify(value) === JSON.stringify(demonstration) || groundingExampleHasCoLocatedEvidence(value, parameters, snapshot))
    .filter((value, index, values) => values.findIndex((candidate) => sameExampleMeaning(candidate, value, inputAliases)) === index);
  for (const parameter of parameters.filter((item) => item.defaultValue !== undefined)) {
    if (!groundingExamples.some((value) => value[parameter.name] === undefined)) {
      groundingExamples.push(Object.fromEntries(Object.entries(demonstration).filter(([name]) => name !== parameter.name)) as Record<string, JsonValue>);
    }
  }
  const generatedIndependentExample = independentGroundingExample(parameters, canonicalRaw, snapshot, demonstration);
  if (generatedIndependentExample && !groundingExamples.some((value) => JSON.stringify(value) === JSON.stringify(generatedIndependentExample))) {
    groundingExamples.push(generatedIndependentExample);
  }
  for (const parameter of parameters.filter((item) => item.required)) {
    if (groundingExamples.length >= 2) break;
    const alternative = siblingEvidenceValue(parameter, snapshot);
    if (alternative !== undefined) {
      const candidate = { ...demonstration, [parameter.name]: alternative };
      if (groundingExampleHasCoLocatedEvidence(candidate, parameters, snapshot)) groundingExamples.push(candidate);
    }
  }
  const tokens = parameterTextTokens(parameters, supplied, canonicalRaw);
  const stableIntent = parameterizedGoal(goal, parameters, tokens);
  const inferredGoal = inferGoalFacet(goal);
  if (inputAliases && goalTargetParameter && groundedGoalValue && inferredGoal) {
    inputAliases[goalTargetParameter.name] ||= {};
    inputAliases[goalTargetParameter.name][inferredGoal.noun] = groundedGoalValue;
  }
  return {
    intent: stableIntent,
    // The normalized goal is the pipeline's own reusable sentence for this
    // capability, so it stands between the labels and the intent template.
    name: reusableSummaryText([candidateSummary?.name, raw.name, normalizedGoal], stableIntent, parameters, tokens),
    description: reusableSummaryText([candidateSummary?.description, raw.description, normalizedGoal], stableIntent, parameters, tokens),
    aliases: [...new Set([...(candidateSummary?.aliases || []), ...(Array.isArray(raw.aliases) ? raw.aliases.filter((value): value is string => typeof value === "string" && Boolean(value.trim())) : [])])]
      .filter((value) => !containsDemonstrationValue(value, parameters, tokens))
      .slice(0, 20),
    parameters,
    groundingExamples: finalizeGroundingExamples(parameters, groundingExamples),
    scope: normalizedScope(raw.scope),
    ...(inputAliases ? { inputAliases } : {}),
  };
}

function assertGoalTargetGrounded(plan: ParameterPlan, goal: string, demonstrationEvidence = "") {
  const inferred = inferGoalFacet(goal);
  if (!inferred) return;
  const target = plan.parameters.find((parameter) => targetIdentityPath(parameter.name));
  if (!target) return;
  const mapped = plan.inputAliases?.[target.name]?.[inferred.noun];
  // The canonical term must be learned from this demonstration's observed
  // target region. Do not maintain a site/product-specific noun dictionary:
  // the model may translate any language, while this guard only prevents a
  // token borrowed from a different validation card from replacing the
  // demonstrated business object.
  if (typeof mapped !== "string" || !mapped.trim() || (demonstrationEvidence && !comparableText(demonstrationEvidence).includes(comparableText(mapped)))) {
    throw new Error("capability_goal_target_not_grounded");
  }
  if (inferred.modifier) {
    const facet = plan.parameters.find((parameter) => /(?:color|colour|颜色|色|attribute|属性|facet|filter|modifier|material|size|brand)/iu.test(`${parameter.name} ${parameter.description || ""}`));
    const facetMapped = facet ? plan.inputAliases?.[facet.name]?.[inferred.modifier] : undefined;
    // A canonical facet that is literally the user's word is already
    // grounded to the request. Its site-language alias may not be visible on
    // the initial page (many sites expose colour values only after search or
    // on the detail page), so defer alias discovery to the browser explorer
    // instead of rejecting an otherwise valid generalized capability.
    const facetUsesOriginalTerm = facet && typeof facet.exampleValue === "string"
      && comparableText(facet.exampleValue) === comparableText(inferred.modifier);
    if (facet && !facetUsesOriginalTerm && (typeof facetMapped !== "string" || !facetMapped.trim() || (demonstrationEvidence && !comparableText(demonstrationEvidence).includes(comparableText(facetMapped))))) {
      throw new Error("capability_goal_facet_not_grounded");
    }
  }
}

/**
 * Two grounding examples are independent when one of the compared public
 * values differs. Exported so the planner and its repair judge independence
 * the same way.
 */
export function groundingExamplesDiffer(comparedNames: string[], examples: Array<Record<string, JsonValue>>) {
  if (!comparedNames.length) return false;
  const first = examples[0];
  return Boolean(first && examples.slice(1).some((candidate) => comparedNames.some((name) => JSON.stringify(object(candidate)[name]) !== JSON.stringify(object(first)[name]))));
}

function hasIndependentTargetExample(plan: ParameterPlan) {
  const targetNames = plan.parameters
    .map((parameter) => parameter.name)
    .filter((name) => /(?:product|item|target|query|keyword|category|sku|variant|object)/iu.test(name));
  if (!targetNames.length) return true;
  const first = plan.groundingExamples[0];
  return Boolean(first && plan.groundingExamples.slice(1).some((candidate) => targetNames.some((name) => JSON.stringify(candidate[name]) !== JSON.stringify(first[name]))));
}

async function planParameters(goal: string, snapshot: Awaited<ReturnType<typeof inspectPage>>, input: CapabilityTaskInput, observer?: ExplorationObserver) {
  // The task goal is intentionally broad after B's semantic abstraction. Keep
  // the original user wording as a grounding hint for alias/target checks so
  // an evidence token from a later grounding example (for example “t-shirt”)
  // cannot replace the requested object (“马克杯”).  This remains internal
  // planning context; the public CapabilityTask schema is unchanged.
  const groundingGoal = typeof input.experience?.originalGoal === "string" && input.experience.originalGoal.trim()
    ? input.experience.originalGoal
    : goal;
  const demonstrationEvidence = JSON.stringify(input.experience || {});
  const planned = await modelJson(CAPABILITY_SPEC_PROMPT, {
    goal: groundingGoal,
    normalizedGoal: goal,
    suppliedParameters: input.parameters,
    candidateSummary: input.candidateSummary,
    // Administrator-only seed evidence from the terminal PageAgent. It helps
    // the isolated Runner preserve the full final action and distinguish this
    // run's example values from reusable intent; it is never replayed as code.
    experience: input.experience,
    page: { url: snapshot.url, title: snapshot.title, heading: snapshot.heading, text: snapshot.text, elements: snapshot.elements },
  }, observer, "parameter-plan", (value) => {
    if (!Array.isArray(value.parameters) || !Array.isArray(value.groundingExamples)) throw new Error("capability_spec_shape_invalid");
  });
  let normalized = cleanParameterPlan(planned, groundingGoal, input, snapshot, input.candidateSummary, goal);
  assertGoalTargetGrounded(normalized, groundingGoal, demonstrationEvidence);
  // A second independent example strengthens generalisation and is not a
  // condition of existing. The page has to be holding two comparable business
  // objects for one to be written at all, and where it is not — a site whose
  // entry page lists one thing, a capability keyed by position — the repair
  // turn cannot invent one and the generation used to die there:
  // `capability_spec_grounding_example_repair_not_independent`, with a working
  // demonstration already in hand. The demonstration is the proven example,
  // C3 replays real cases against real pages regardless, and this file says so
  // itself a few lines further down. So the repair is attempted and its
  // failure leaves the plan as it was.
  if (normalized.parameters.length && (normalized.groundingExamples.length < 2 || !hasIndependentTargetExample(normalized))) {
   try {
    const repairedExamples = await modelJson(CAPABILITY_SPEC_PROMPT, {
      goal: groundingGoal,
      normalizedGoal: goal,
      canonicalParameters: normalized.parameters,
      currentGroundingExamples: normalized.groundingExamples,
      page: { url: snapshot.url, title: snapshot.title, heading: snapshot.heading, text: snapshot.text, elements: snapshot.elements },
      instruction: "补齐至少两个可独立回放的 groundingExamples。第二个 example 必须逐字使用 page.text/elements 中真实出现的另一个商品或业务对象，并且 productKeyword/productType 与 color/material/size 等筛选值必须在同一个商品卡片或详情区域共同出现；例如页面同时出现 White Ceramic Mug 与 Brown bear cushion 时，应使用 {mug, white} 与 {cushion, brown}，不能拼出 {cushion, white}。不得使用页面未出现的泛化词，也不得复制第一个 example。保留 canonicalParameters 不变。这些只是 C1 私有编写/回放样例，不是 C2 ValidationSuite。",
    }, observer, "grounding-example-repair", (value) => {
      if (!Array.isArray(value.groundingExamples)) throw new Error("capability_spec_grounding_example_repair_shape_invalid");
      const parameterNames = normalized.parameters.map((parameter) => parameter.name);
      const targetNames = parameterNames.filter(targetIdentityPath);
      // A capability selected by position or number (rank, index, page) has no
      // identity-named parameter at all. Comparing only identity parameters
      // then compares nothing, no repair can ever satisfy it, and generation
      // dead-ends — which is how 打开指定排名的热搜 ({rank}) failed to regenerate.
      // With no identity parameter, any differing public value is independence.
      const comparedNames = targetNames.length ? targetNames : parameterNames;
      if (value.groundingExamples.length < 2 || !groundingExamplesDiffer(comparedNames, value.groundingExamples as Array<Record<string, JsonValue>>)) {
        throw new Error("capability_spec_grounding_example_repair_not_independent");
      }
    });
    normalized = cleanParameterPlan({ ...planned, groundingExamples: repairedExamples.groundingExamples, siteTerms: repairedExamples.siteTerms }, groundingGoal, input, snapshot, input.candidateSummary, goal);
    assertGoalTargetGrounded(normalized, groundingGoal, demonstrationEvidence);
   } catch (error) {
    observe(observer, { stage: "grounding-example-repair-declined", response: redactedTraceValue({ reason: error instanceof Error ? error.message : String(error), groundingExamples: normalized.groundingExamples.length }) });
   }
  }
  const missingAliases = normalized.parameters
    .filter((parameter) => typeof parameter.exampleValue === "string" && parameter.exampleValue.trim().length > 1)
    // A keyword the user typed into a search box is not expected on the entry
    // page. Demanding a site term for it only forces the model to invent one —
    // in production it invented the search box placeholder.
    .filter((parameter) => !typedInDemonstration(String(parameter.exampleValue), input.experience))
    .filter((parameter) => {
      const value = String(parameter.exampleValue).trim();
      const mapped = normalized.inputAliases?.[parameter.name]?.[value];
      return typeof mapped !== "string" && !snapshotEvidenceText(snapshot).toLocaleLowerCase().includes(value.toLocaleLowerCase());
    })
    .map((parameter) => ({ name: parameter.name, from: String(parameter.exampleValue).trim() }));
  const inferredGoalFacet = inferGoalFacet(groundingGoal);
  const identityParameter = normalized.parameters.find((parameter) => targetIdentityPath(parameter.name));
  const facetParameter = normalized.parameters.find((parameter) => /(?:color|colour|颜色|色|attribute|属性|facet|filter|modifier|material|size|brand)/iu.test(`${parameter.name} ${parameter.description || ""}`));
  const missingGoalAliases = [
    inferredGoalFacet && identityParameter && /[^\x00-\x7F]/u.test(inferredGoalFacet.noun) && inferredGoalFacet.noun !== String(identityParameter.exampleValue)
      ? { name: identityParameter.name, from: inferredGoalFacet.noun }
      : undefined,
    inferredGoalFacet && facetParameter && /[^\x00-\x7F]/u.test(inferredGoalFacet.modifier) && inferredGoalFacet.modifier !== String(facetParameter.exampleValue)
      ? { name: facetParameter.name, from: inferredGoalFacet.modifier }
      : undefined,
  ].filter((value): value is { name: string; from: string } => Boolean(value));
  if (inferredGoalFacet?.modifier && facetParameter) {
    const mappedFacet = normalized.inputAliases?.[facetParameter.name]?.[inferredGoalFacet.modifier];
    const usesOriginalFacetTerm = typeof facetParameter.exampleValue === "string"
      && comparableText(facetParameter.exampleValue) === comparableText(inferredGoalFacet.modifier);
    if (!usesOriginalFacetTerm && (typeof mappedFacet !== "string" || !mappedFacet.trim() || !demonstrationEvidence.toLocaleLowerCase().includes(mappedFacet.toLocaleLowerCase()))) {
      missingGoalAliases.push({ name: facetParameter.name, from: inferredGoalFacet.modifier });
    }
  }
  const aliasRepairMissing = [...missingAliases, ...missingGoalAliases]
    .filter((item, index, values) => values.findIndex((candidate) => candidate.name === item.name && candidate.from === item.from) === index);
  if (aliasRepairMissing.length) {
    const repaired = await modelJson(CAPABILITY_SPEC_PROMPT, {
      goal: groundingGoal,
      normalizedGoal: goal,
      canonicalParameters: normalized.parameters,
      aliasRepairMissing,
      page: { url: snapshot.url, title: snapshot.title, heading: snapshot.heading, text: snapshot.text, elements: snapshot.elements },
      instruction: "补齐 aliasRepairMissing 对应的 siteTerms。目标商品和筛选条件必须以本次 demonstration 的 experience.actions/endPage 中同一业务对象为准，不能从第二个 groundingExample 借用 t-shirt、Black 等词替换马克杯、白色；同时从 page.text/elements 中为可复用商品类别、材质和颜色补充常见用户语言别名（例如页面出现 cushion 时补充‘垫子’→‘cushion’，页面出现 mug 时补充‘马克杯’→‘mug’）。保持 canonicalParameters、intent、groundingExamples 不变，只使用页面中真实出现的 value。",
    }, observer, "parameter-plan-alias-repair", (value) => {
      if (!Array.isArray(value.siteTerms)) throw new Error("capability_spec_alias_repair_shape_invalid");
    });
    // Keep the first plan's canonical parameter contract immutable; the
    // repair turn is allowed to contribute only evidence-backed aliases.
    normalized = cleanParameterPlan({ ...planned, siteTerms: repaired.siteTerms }, groundingGoal, input, snapshot, input.candidateSummary, goal);
    assertGoalTargetGrounded(normalized, groundingGoal, demonstrationEvidence);
  }
  return normalized;
}

/** The demonstration typed this value into a control (fill/input_text) rather than picking it from the page. */
export function typedInDemonstration(value: string, experience?: CapabilityTaskInput["experience"]) {
  const needle = comparableText(value);
  if (!needle) return false;
  return (experience?.actions || []).some((action) => {
    if (action.action !== "fill") return false;
    return Object.values(action.input || {}).some((item) => typeof item === "string" && comparableText(item).includes(needle));
  });
}

export function projectExplorationInput(input: CapabilityTaskInput, plan: ParameterPlan): CapabilityTaskInput {
  const parameters = Object.fromEntries(plan.parameters.map((parameter) => [
    parameter.name,
    input.parameters[parameter.name] ?? parameter.exampleValue,
  ])) as Record<string, JsonValue>;
  const sourceParameterPaths = Object.keys(input.parameters);
  return {
    ...input,
    // The raw request remains available through `experience`/trace as
    // evidence. It must not remain in the executable parameter namespace once
    // the abstraction step has produced canonical parameters.
    context: {
      ...input.context,
      __canonicalParameterPaths: plan.parameters.map((parameter) => parameter.name),
      __sourceParameterPaths: sourceParameterPaths,
      ...(plan.inputAliases ? { __capabilityInputAliases: plan.inputAliases as unknown as JsonValue } : {}),
    },
    parameters,
  };
}

function inputForPlan(input: CapabilityTaskInput, plan: ParameterPlan): CapabilityTaskInput {
  return projectExplorationInput(input, plan);
}

function scopeFor(element: PageElement, input: CapabilityTaskInput) {
  if (!element.container) return undefined;
  // A named product link already carries the concrete business identity of
  // the card (for example "View product Customizable mug").  Scoping it by
  // the generic input term ("mug") would match every mug card and turn an
  // otherwise unique semantic link into a false target_ambiguous result.  The
  // link name is still generated from the observed DOM; no href or product
  // URL is persisted as a fixed route.
  const prefix = stableAccessiblePrefix(element.name);
  if ((element.role === "link" || element.role === "button") && element.name && prefix && element.name.trim().length > prefix.length) return undefined;
  const aliases = object(input.context.__capabilityInputAliases);
  const matches = Object.entries(input.parameters)
    .filter(([, value]) => typeof value === "string" && value.length > 1)
    .filter(([name, value]) => {
      const candidates = [String(value)];
      const aliasMap = object(aliases[name]);
      const mapped = aliasMap[String(value)];
      if (typeof mapped === "string" && mapped.length > 1) candidates.push(mapped);
      return candidates.some((candidate) => element.container?.text.toLocaleLowerCase().includes(candidate.toLocaleLowerCase()));
    })
    .map(([name]) => ({ source: "input" as const, path: name }));
  if (!matches.length) return undefined;
  return {
    strategies: [{ type: "css", value: element.container.css, containsTextAll: matches, match: "contains" }] satisfies LocatorStrategy[],
  };
}

/**
 * The inputs a capability takes, and — where the page's own address carries one
 * — how that address writes it.
 *
 * A by-date archive lives at `/daily/2026-09-20` while the person asking says
 * 「2026年9月21号」. Nothing can reconcile those two writings in general: the next
 * site writes 「2026年9月20日」 as `20260920`, `20-09-2026` or `Sep-20-2026`, and a
 * table of separators and month names is a guess that runs out the moment the
 * site is in another language. So the capability says which writing it needs,
 * taken from the address it was built on, and whoever calls it writes the value
 * that way. The schema carries it as an example, which every caller already
 * reads and no validator can be broken by.
 */
const SENSITIVE_PARAMETER = /pass|secret|token|credential|auth/i;

/**
 * The input schema, with the writing each input takes stated on it.
 *
 * A description saying 「如 \'2026年9月20日\'」 is for a person to read; nothing
 * downstream can act on it. So the writing is published as `examples`, where
 * the case-generation turn, the caller and the schema check all see the same
 * statement. The address writing is preferred when the page's own URL proves
 * one, and otherwise the example is the value the demonstration ran with —
 * the one value this capability is known to work for.
 *
 * It states a form; it does not restrict one. A caller writing the same day
 * another way is answered by the site, not refused here.
 */
const addressWritingNote = (sentence: string, written: string) => `${sentence}. Write it the way the page address does, for example "${written}".`;
const exampleWritingNote = (sentence: string, ran: string) => `${sentence}. Write it the way the example is written, for example "${ran}".`;

/**
 * The contract with each input written the way the program consumes it.
 *
 * The address writing is a statement about a program that opens the page by
 * its address. When the program reaches that page by clicking through — the
 * product card, then the product — it matches the visible name, and only the
 * demonstrated writing works. A cart capability declared "mira-pendant" from
 * `/product/mira-pendant`, was authored and self-tested with "Mira Pendant",
 * and every validation case, written as the contract said, failed.
 */
export function contractInProgramWritings(
  contract: CapabilityContract,
  addressOpened: readonly string[],
  demonstrated: Record<string, JsonValue>,
): CapabilityContract {
  const schema = object(contract.inputSchema);
  const properties = object(schema.properties);
  let changed = false;
  const next = Object.fromEntries(Object.entries(properties).map(([name, value]) => {
    const property = object(value);
    const examples = Array.isArray(property.examples) ? property.examples : [];
    const written = typeof examples[0] === "string" ? examples[0] : "";
    const shown = demonstrated[name];
    const ran = !SENSITIVE_PARAMETER.test(name) && typeof shown === "string" && shown.trim() ? shown.trim() : "";
    const description = String(property.description || "");
    const sentence = description.slice(0, Math.max(0, description.lastIndexOf(". Write it the way the page address does")));
    const declaresAddress = Boolean(written) && description === addressWritingNote(sentence, written);
    if (!declaresAddress || !ran || ran === written || addressOpened.includes(name)) return [name, value];
    changed = true;
    return [name, { ...property, description: exampleWritingNote(sentence, ran), examples: [ran] }];
  }));
  return changed ? { ...contract, inputSchema: { ...schema, properties: next } as JsonObject } : contract;
}

function inputSchemaFor(plan: ParameterPlan, addressInputs: Record<string, string> = {}, demonstrated: Record<string, JsonValue> = {}): JsonObject {
  return {
    type: "object",
    properties: Object.fromEntries(plan.parameters.map((parameter) => {
      const shown = demonstrated[parameter.name];
      const ran = !SENSITIVE_PARAMETER.test(parameter.name) && typeof shown === "string" && shown.trim() ? shown.trim() : "";
      const written = addressInputs[parameter.name];
      // The model's own description may already end in a full stop. The
      // note is shown in the console and read by callers, in the same
      // recorded language as the description it follows (prompt-locale.ts).
      const sentence = String(parameter.description || "").replace(/[。.\s]+$/u, "");
      const description = written
        ? addressWritingNote(sentence, written)
        : ran
          ? exampleWritingNote(sentence, ran)
          : parameter.description;
      const example = written || ran;
      return [parameter.name, {
        type: parameter.type,
        description,
        ...(example ? { examples: [example] } : {}),
        ...(parameter.defaultValue !== undefined ? { default: parameter.defaultValue } : {}),
      }];
    })),
    required: plan.parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name),
    additionalProperties: false,
  } as JsonObject;
}

/**
 * The declared address writings the result page actually bears, keyed by input.
 *
 * A declaration is a claim about the site, so it is kept only where the page
 * proves it: the value has to be a path segment or a query value of the address
 * the exploration ended on.
 */
export function addressWrittenInputs(designed: unknown, evidenceUrl: string, declaredInputs: string[]) {
  const raw = Array.isArray(object(designed).addressInputs) ? object(designed).addressInputs as unknown[] : [];
  let carried: string[];
  try {
    const url = new URL(evidenceUrl);
    const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
    carried = [...url.pathname.split("/").filter(Boolean).map(decode), ...[...url.searchParams.values()]];
  } catch { return {} as Record<string, string>; }
  const written: Record<string, string> = {};
  for (const entry of raw) {
    const item = object(entry);
    const path = typeof item.path === "string" ? item.path : "";
    const value = typeof item.addressValue === "string" ? item.addressValue.trim() : "";
    if (!path || !value || !declaredInputs.includes(path) || written[path]) continue;
    if (!carried.some((segment) => segment === value)) continue;
    written[path] = value;
  }
  return written;
}

function outputPropertySchema(value: JsonValue): JsonObject {
  if (Array.isArray(value)) return { type: "array" };
  if (value === null) return {};
  if (typeof value === "object") return { type: "object" };
  return { type: typeof value };
}

export function normalizeContractOutputSchema(value: unknown, output: JsonObject): JsonObject {
  const raw = object(value);
  if (raw.type === "object") return raw as JsonObject;
  const keys = Object.keys(output);
  const looksLikePropertyMap = Object.keys(raw).length > 0 && Object.values(raw).every((item) => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  const properties = looksLikePropertyMap
    ? raw
    : Object.fromEntries(Object.entries(output).map(([key, item]) => [key, outputPropertySchema(item)]));
  return {
    type: "object",
    properties: properties as JsonObject,
    required: keys.filter((key) => Object.hasOwn(properties, key)),
    additionalProperties: false,
  };
}

export function normalizeContractCondition(value: JsonValue, plan: ParameterPlan): JsonValue {
  const condition = object(value);
  let type = String(condition.type || "");
  if (!type) {
    const shorthand = ["urlIncludes", "urlTemplate", "textIncludes", "textTemplate", "inputExists", "outputExists", "outputEquals", "modelGoal"]
      .find((key) => condition[key] !== undefined);
    if (!shorthand) return value;
    const shorthandValue = condition[shorthand];
    if (shorthand === "urlTemplate" || shorthand === "textTemplate") {
      const template = typeof shorthandValue === "string" ? shorthandValue : object(shorthandValue).template;
      return typeof template === "string" ? { type: shorthand, template: parameterizeContractLiteral(template, plan).value } : value;
    }
    if (shorthand === "modelGoal") return { type: "modelGoal", goal: typeof shorthandValue === "string" ? shorthandValue : String(object(shorthandValue).goal || object(shorthandValue).description || "") };
    if (shorthand === "outputExists" || shorthand === "inputExists") return { type: shorthand, path: typeof shorthandValue === "string" ? shorthandValue : String(object(shorthandValue).path || object(shorthandValue).key || "") };
    if (shorthand === "outputEquals") {
      const expected = object(shorthandValue);
      return { type: shorthand, path: String(expected.path || expected.key || ""), value: expected.value as JsonValue };
    }
    type = shorthand;
    value = { type, value: shorthandValue } as JsonValue;
  }
  const normalized = object(value);
  const directTemplate = type === "textIncludes"
    ? normalized.textTemplate
    : type === "urlIncludes"
      ? normalized.urlTemplate
      : undefined;
  if ((type === "textIncludes" || type === "urlIncludes") && typeof directTemplate === "string") {
    return {
      type: type === "textIncludes" ? "textTemplate" : "urlTemplate",
      template: parameterizeContractLiteral(directTemplate, plan).value,
    };
  }
  if ((type === "textIncludes" || type === "urlIncludes") && typeof normalized.value !== "string") {
    const alias = type === "textIncludes" ? normalized.text : normalized.url;
    if (typeof alias === "string") {
      normalized.value = alias;
      if (type === "textIncludes") delete normalized.text;
      else delete normalized.url;
    }
  }
  if (type === "modelGoal" && typeof normalized.goal !== "string" && typeof normalized.description === "string") normalized.goal = normalized.description;
  if (type === "textTemplate" || type === "urlTemplate") {
    const template = typeof normalized.template === "string"
      ? normalized.template
      : typeof normalized.value === "string"
        ? normalized.value
        : undefined;
    if (template) return { type, template: parameterizeContractLiteral(template, plan).value };
  }
  const nested = object(normalized.value);
  if ((type === "textIncludes" || type === "urlIncludes") && typeof nested.template === "string") {
    const nestedType = nested.type === "urlTemplate" || nested.type === "textTemplate"
      ? nested.type
      : type === "textIncludes" ? "textTemplate" : "urlTemplate";
    return { type: nestedType, template: parameterizeContractLiteral(nested.template, plan).value };
  }
  if (type === "outputExists" && typeof normalized.path !== "string") {
    const path = typeof normalized.key === "string" ? normalized.key : typeof normalized.value === "string" ? normalized.value : undefined;
    if (path) return { type, path };
  }
  const literal = typeof normalized.value === "string" ? normalized.value : "";
  if ((type === "textIncludes" || type === "urlIncludes") && literal) {
    const parameterized = parameterizeContractLiteral(literal, plan);
    if (parameterized.changed) return {
      type: type === "textIncludes" ? "textTemplate" : "urlTemplate",
      template: parameterized.value,
    };
  }
  return normalized as JsonValue;
}

function parameterizeContractLiteral(value: string, plan: ParameterPlan) {
  const parameterNames = new Set(plan.parameters.map((parameter) => parameter.name));
  let parameterized = value.replace(
    /\{\s*([\p{L}_][\p{L}\p{N}_.-]*)\s*\}/gu,
    (match, path: string, offset: number, source: string) => {
      // Keep the canonical {{path}} syntax intact. Models commonly emit the
      // JSON-template-style {path}; accept it only when it names a declared
      // capability input, then store the canonical form.
      if (source[offset - 1] === "{" || source[offset + match.length] === "}") return match;
      return parameterNames.has(path.split(".")[0]) ? `{{${path}}}` : match;
    },
  );
  let changed = parameterized !== value;
  const parameters = [...plan.parameters].sort((left, right) => String(right.exampleValue).length - String(left.exampleValue).length);
  for (const parameter of parameters) {
    if (typeof parameter.exampleValue !== "string" || parameter.exampleValue.length < 2 || !parameterized.includes(parameter.exampleValue)) continue;
    parameterized = parameterized.replaceAll(parameter.exampleValue, `{{${parameter.name}}}`);
    changed = true;
  }
  return { value: parameterized, changed };
}

function conditionTemplateInputs(value: JsonValue) {
  const condition = object(value);
  if (condition.type !== "textTemplate" && condition.type !== "urlTemplate") return [];
  return typeof condition.template === "string"
    ? [...condition.template.matchAll(/\{\{\s*([\p{L}_][\p{L}\p{N}_.-]*)\s*\}\}/gu)].map((match) => match[1].split(".")[0])
    : [];
}

export function normalizeContractConditions(value: unknown, plan: ParameterPlan) {
  const items = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? (typeof object(value).type === "string" ? [value] : Object.entries(object(value)).map(([key, nested]) => ({ [key]: nested })))
      : [];
  // A condition the model wrote without its value carries no information, and
  // there is nothing in it to repair. It used to fail the whole discovery run
  // — capability_contract_condition_value_missing:successConditions.0 threw
  // away a working program and a full exploration over one malformed entry.
  // Dropping it leaves the contract weaker and the run alive, which is the
  // trade this whole area is built on.
  return items
    .map((item) => normalizeContractCondition(item as JsonValue, plan))
    .filter((condition) => !normalizedContractConditionIssue(condition));
}

/**
 * Quantity is a business input, but cart UIs commonly render it with
 * singular/plural (or locale-specific) copy: "There is 1 item" vs
 * "There are 2 items", "购物车中有 1 件商品" vs "购物车中有 2 件商品".
 * Keeping that sentence as a required Contract textTemplate makes an
 * otherwise valid private grounding replay fail on wording alone. The
 * generated module's stage_verify and the deterministic C3 runner validate
 * the numeric quantity; this helper only identifies UI-count prose that is
 * unsafe as a cross-example text condition.
 */
function isQuantityDependentUiTemplate(value: JsonValue, plan: ParameterPlan) {
  const condition = object(value);
  if (condition.type !== "textTemplate" || typeof condition.template !== "string") return false;
  const template = condition.template;
  const quantityNames = new Set(
    plan.parameters
      .filter((parameter) => /quantity|count|amount|qty|number/iu.test(parameter.name))
      .map((parameter) => parameter.name),
  );
  const referencesQuantity = [...template.matchAll(/\{\{\s*([\p{L}_][\p{L}\p{N}_.-]*)\s*\}\}/gu)]
    .some((match) => quantityNames.has(match[1].split(".")[0]));
  if (!referencesQuantity) return false;
  return /there\s+(?:is|are)\b|\b(?:item|items|product|products|unit|units|piece|pieces|cart)\b|购物车|(?:件|个|只|台|份)\s*(?:商品|产品|物品)?/iu.test(template);
}

/**
 * Discovery can observe a transient success toast, dialog or live-region
 * sentence.  It is useful evidence for the current run, but it is not a
 * reusable Contract predicate: another browser context may commit the same
 * business state through a different locale, wording, or DOM surface.  The
 * authored stage's terminal outcome/evidence and the deterministic output
 * predicate remain the source of truth for replay.
 *
 * This is deliberately phrased in terms of generic UI completion language,
 * not a site or commerce-specific selector.  Parameterized templates are
 * retained; only unparameterized copy is treated as transient.
 */
function isTransientCompletionTextCondition(value: JsonValue) {
  const condition = object(value);
  const type = String(condition.type || "");
  if (type !== "textIncludes" && type !== "textTemplate") return false;
  const text = type === "textIncludes"
    ? condition.value
    : condition.template;
  if (typeof text !== "string" || !text.trim()) return false;
  if (/\{\{\s*[\p{L}_][\p{L}\p{N}_.-]*\s*\}\}/u.test(text)) return false;
  return /(?:\b(?:added|removed|saved|updated|completed|submitted|successful(?:ly)?|success|done|contains)\b|\b(?:cart|order|wishlist|favorite|favourite|booking|reservation|request|message)\b|已(?:加入|移除|保存|更新|提交|完成|成功)|(?:加入|移除|保存|更新|提交)成功)/iu.test(text);
}

function normalizedContractConditionIssue(value: JsonValue) {
  if (typeof value === "string") return value.trim() ? undefined : "condition_string_empty";
  const condition = object(value);
  const type = String(condition.type || "");
  if (type === "textIncludes" || type === "urlIncludes") return typeof condition.value === "string" && condition.value.trim() ? undefined : "condition_value_missing";
  if (type === "textTemplate" || type === "urlTemplate") return typeof condition.template === "string" && condition.template.trim() ? undefined : "condition_template_missing";
  if (type === "inputExists" || type === "outputExists") return typeof condition.path === "string" && condition.path.trim() ? undefined : "condition_path_missing";
  if (type === "outputEquals") return typeof condition.path === "string" && condition.path.trim() && Object.hasOwn(condition, "value") ? undefined : "condition_output_equals_invalid";
  if (type === "modelGoal") return typeof condition.goal === "string" && condition.goal.trim() ? undefined : "condition_goal_missing";
  return "condition_type_unsupported";
}

export function validateContractDesignResponse(value: Record<string, unknown>, plan: ParameterPlan) {
  if (!Array.isArray(value.preconditions) || !Array.isArray(value.successConditions)) throw new Error("capability_contract_shape_invalid");
  for (const [group, conditions] of [["preconditions", value.preconditions], ["successConditions", value.successConditions]] as const) {
    for (const [index, condition] of normalizeContractConditions(conditions, plan).entries()) {
      const issue = normalizedContractConditionIssue(condition);
      if (issue) throw new Error(`capability_contract_${issue}:${group}.${index}`);
    }
  }
}

export function stabilizeSuccessConditions(value: unknown, plan: ParameterPlan) {
  const normalized = normalizeContractConditions(value, plan);
  const parameterNames = new Set(plan.parameters.map((parameter) => parameter.name));
  const parameterizedTemplates = normalized.flatMap((condition) => conditionTemplateInputs(condition).some((name) => parameterNames.has(name)) && typeof object(condition).template === "string" ? [String(object(condition).template)] : []);
  const hasParameterizedResult = parameterizedTemplates.length > 0;
  const stable = hasParameterizedResult
    ? normalized.filter((condition) => {
      const item = object(condition);
      const type = String(item.type || "");
      if (type === "urlIncludes") return false;
      if (type !== "textIncludes" || typeof item.value !== "string") return true;
      const literal = comparableText(item.value);
      return !parameterizedTemplates.some((template) => comparableText(template.replace(/\{\{[^}]+\}\}/gu, " ")).includes(literal));
    })
    : normalized;
  return stable
    .filter((condition) => !isQuantityDependentUiTemplate(condition, plan))
    .filter((condition) => !isTransientCompletionTextCondition(condition))
    .filter((condition, index, values) => values.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(condition)) === index);
}

/**
 * A URL observed during Discovery is evidence about the site router, not a
 * promise that the router spells a business input literally.  Category pages
 * commonly use an id/slug (`/3-clothes`) while the input is `Clothes`; keeping
 * the model's `/{{categoryName}}` condition would make every independent
 * grounding example fail even though the target and page title are correct.
 * Parameterized URL conditions that do not match the successful Discovery
 * evidence are therefore removed before the Contract is persisted.  Other
 * deterministic conditions (text/output/evidence) remain mandatory.
 */
export function alignSuccessConditionsToEvidence(value: unknown, plan: ParameterPlan, evidenceUrl?: string, input: Record<string, JsonValue> = {}, evidenceText?: string, entryText?: string) {
  const normalized = stabilizeSuccessConditions(value, plan);
  if (!evidenceUrl && evidenceText === undefined) return normalized;
  const demonstrationLiterals = Object.values(input)
    .filter((item): item is string => typeof item === "string" && item.trim().length >= 3 && !/^\d+$/u.test(item.trim()))
    .map((item) => comparableText(item))
    .filter(Boolean);
  const aligned = normalized.filter((condition) => {
    const item = object(condition);
    const type = String(item.type || "");
    if (evidenceText !== undefined && (type === "textIncludes" || type === "textTemplate")) {
      const template = typeof item.template === "string" ? item.template : typeof item.value === "string" ? item.value : "";
      if (!template.trim()) return false;
      let expected = template;
      if (type === "textTemplate") {
        try {
          const renderedInput = { ...input };
          for (const parameter of plan.parameters) {
            const raw = renderedInput[parameter.name];
            if (typeof raw !== "string") continue;
            const mapped = plan.inputAliases?.[parameter.name]?.[raw];
            if (typeof mapped === "string" && mapped.trim()) renderedInput[parameter.name] = mapped;
          }
          expected = renderCapabilityInputTemplate(template, renderedInput);
        } catch { return false; }
      }
      // A bare textIncludes observed during Discovery is not a reusable
      // contract when it embeds the demonstration target (for example the
      // concrete product title). Keep parameterized templates because they
      // deliberately describe the public input; discard only unparameterized
      // literals that would make another valid target fail validation.
      const hasTemplateParameter = type === "textTemplate" && /\{\{\s*[\p{L}_][\p{L}\p{N}_.-]*\s*\}\}/u.test(template);
      if (!hasTemplateParameter && demonstrationLiterals.some((literal) => comparableText(expected).includes(literal))) return false;
      // Keep text conditions only when the successful Discovery observation
      // actually contains them. This removes model-invented wording such as
      // “has been added to your cart” when the site emits “Added to your
      // cart … There is 1 item in your cart”, while the explorer's concrete
      // terminal signal remains authoritative.
      if (!capabilityTextIncludes(evidenceText, expected)) return false;
      // Text that was already on the page before the capability did anything
      // is not evidence that it did it. A by-date capability was published on
      // the strength of 「热搜时光机」, the site's own name, which every page
      // carries: it clicked a date picker, reported the document title, echoed
      // the date back and passed. A parameterized template is exempt, since
      // what it renders changes with the input.
      if (!hasTemplateParameter && entryText && capabilityTextIncludes(entryText, expected)) return false;
      return true;
    }
    // A demonstrated URL must not become an outputEquals literal for a
    // parameterized target.  The first case may legitimately navigate to a
    // query/hash URL while another case keeps the same page and only changes
    // an in-page selection.  Keep outputExists and parameterized templates;
    // drop only the concrete URL observed in Discovery.
    if (type === "outputEquals" && typeof item.path === "string" && /(?:^|[.])(pageUrl|url|href|location)$/iu.test(item.path) && typeof item.value === "string" && item.value === evidenceUrl) return false;
    if (type !== "urlTemplate" && type !== "urlIncludes") return true;
    // A site-global capability must remain runnable from arbitrary caller
    // pages.  Product/detail URLs discovered during the demonstration are
    // dynamic navigation evidence, not a reusable business success contract;
    // retaining them would make every alternate target fail with
    // success_url_mismatch even when the real DOM/business receipt is valid.
    if (plan.scope?.kind === "site-global") return false;
    if (!evidenceUrl) return false;
    const template = typeof item.template === "string" ? item.template : typeof item.value === "string" ? item.value : "";
    // A model may describe a semantic route (for example `/product-detail`)
    // even though the site uses an id/slug URL. A URL condition is executable
    // evidence only when the observed successful URL actually matches it;
    // otherwise DraftReplay/Validation would fail after the browser already
    // proved the business result through text or signal evidence.
    if (!template.trim()) return false;
    const parameterized = /\{\{\s*[\p{L}_][\p{L}\p{N}_.-]*\s*\}\}/u.test(template);
    if (type === "urlIncludes") return capabilityUrlHas(evidenceUrl, template);
    if (!parameterized) return capabilityUrlTemplateMatches(evidenceUrl, template, input);
    return capabilityUrlTemplateMatches(evidenceUrl, template, input);
  });
  return aligned.filter((condition, index, values) => values.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(condition)) === index);
}

/**
 * Terminal browser signals often include the demonstrated entity title.  Keep
 * the business fact, but remove the concrete entity so a reusable Contract
 * does not become tied to the first product seen during Discovery.
 */
/** The text contains a digit run that does not come from any input value. */
export function hasVolatileNumber(text: string, plan: ParameterPlan) {
  let stripped = text;
  for (const parameter of plan.parameters) {
    if (typeof parameter.exampleValue === "string" && parameter.exampleValue.length >= 2) stripped = stripped.replaceAll(parameter.exampleValue, " ");
  }
  return /\d/u.test(stripped.replace(/\{\{[^}]*\}\}/gu, " "));
}

function reusableCompletionSignal(signal: string) {
  const normalized = signal.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (/\bhas\s+been\s+added\s+to\s+your\s+cart\b/iu.test(normalized)) return "has been added to your cart";
  if (/\badded\s+to\s+your\s+cart\b/iu.test(normalized)) return "added to your cart";
  if (/\bremoved\s+from\s+your\s+cart\b/iu.test(normalized)) return "removed from your cart";
  return undefined;
}

/** Keep target parameters verifiable after evidence alignment removes a
 * concrete or model-invented success phrase. */
function ensureTargetSuccessConditions(value: JsonValue[], plan: ParameterPlan, input: Record<string, JsonValue>, evidenceText: string) {
  const result = [...value];
  for (const parameter of plan.parameters) {
    if (!targetIdentityPath(parameter.name)) continue;
    const referenced = result.some((condition) => {
      const item = object(condition);
      if (item.type === "inputExists" && item.path === parameter.name) return true;
      if ((item.type === "textTemplate" || item.type === "urlTemplate") && typeof item.template === "string") {
        return conditionTemplateInputs(condition).some((name) => name === parameter.name);
      }
      return false;
    });
    if (referenced) continue;
    const rawValue = input[parameter.name] ?? parameter.exampleValue;
    const mapped = typeof rawValue === "string" ? plan.inputAliases?.[parameter.name]?.[rawValue] : undefined;
    const evidenceValue = typeof mapped === "string" && mapped.trim() ? mapped : typeof rawValue === "string" ? rawValue : undefined;
    result.push(evidenceValue && evidenceText.toLocaleLowerCase().includes(evidenceValue.toLocaleLowerCase())
      ? { type: "textTemplate", template: `{{${parameter.name}}}` }
      : { type: "inputExists", path: parameter.name });
  }
  return result.filter((condition, index, values) => values.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(condition)) === index);
}

/** Top-level output fields the Contract declares; empty when the schema declares none. */
function declaredOutputKeys(outputSchema: JsonObject) {
  return Object.keys(object(outputSchema.properties)).filter((key) => key.trim());
}

/**
 * If all discovery-time UI copy was transient, retain one deterministic
 * output predicate so the Contract still states an observable result.  The
 * JavaScript terminal stage must already have returned `Success`; this
 * predicate only checks that the typed output carries the result envelope.
 *
 * The predicate must name a field the Contract's outputSchema declares: the
 * verification stage may only write declared fields, so a predicate on an
 * exploration-only key such as `pageUrl` could never be satisfied and the
 * authoring loop would burn its whole repair budget on the contradiction.
 */
export function ensureResultOutputCondition(value: JsonValue[], output: JsonObject, outputSchema: JsonObject) {
  const hasBusinessPredicate = value.some((condition) => {
    if (typeof condition === "string") return Boolean(condition.trim());
    const type = String(object(condition).type || "");
    return ["urlIncludes", "urlTemplate", "textIncludes", "textTemplate", "outputEquals", "outputExists"].includes(type);
  });
  if (hasBusinessPredicate) return value;
  const declared = declaredOutputKeys(outputSchema);
  // A closed schema without fields admits no output at all, so no predicate can hold.
  const candidates = declared.length
    ? declared
    : outputSchema.additionalProperties === false ? [] : Object.keys(output).filter((key) => key.trim());
  const path = candidates.includes("pageUrl") ? "pageUrl" : candidates[0];
  return path ? [...value, { type: "outputExists", path }] : value;
}

/**
 * Drop output predicates whose field the outputSchema does not declare; they
 * are unsatisfiable under the Stage I/O declarations, not evidence.  When the
 * schema declares nothing the output is free-form and every path stays.
 */
export function reconcileOutputConditionsWithSchema(value: JsonValue[], outputSchema: JsonObject) {
  const declared = declaredOutputKeys(outputSchema);
  if (!declared.length) return value;
  return value.filter((condition) => {
    if (typeof condition === "string") return true;
    const item = object(condition);
    if (item.type !== "outputExists" && item.type !== "outputEquals") return true;
    const root = String(item.path || "").split(".").find(Boolean) || "";
    return declared.includes(root);
  });
}

/**
 * Freeze the Contract from the model's design and the successful episode.
 * Pure: everything it needs is recorded in the Discovery trace, so a failed
 * task's contract can be re-assembled offline (tests/capability-v2-replay).
 */
/**
 * A rebuild or repair keeps the capability's public contract.
 *
 * The contract-design turn is asked for a whole contract every time, and on a
 * rebuild it answered with `currentRank: {type: "string"}` where the published
 * version had `number`. Both were internally consistent; anything calling the
 * capability by its published contract would have broken. The design turn is
 * still what decides preconditions and success conditions — the page may have
 * changed — but the public shape, inputSchema and outputSchema, is not its to
 * redesign: it comes from the version being rebuilt. A designed output the
 * base does not declare is dropped from the schema; the author prompt already
 * says not to add public fields, and the stage I/O gates hold the program to
 * what the schema declares.
 */
export function pinContractToBase(contract: CapabilityContract, base: CapabilityContract | undefined): CapabilityContract {
  if (!base) return contract;
  const pinned: CapabilityContract = {
    ...contract,
    inputSchema: base.inputSchema,
    outputSchema: base.outputSchema,
  };
  // The rest of the design was written against the designed schemas. What it
  // names that the published ones do not declare cannot hold: every rebuild of
  // three live capabilities failed as inconsistent before writing a line, on a
  // condition that required an output the published schema calls by another
  // name. Such parts are dropped; when no executable success condition is
  // left, the published ones, written for these schemas, stand.
  const issues = inspectContractConsistency(pinned);
  const broken = new Set(issues.map((issue) => issue.path));
  const keep = (group: "preconditions" | "successConditions") => (pinned[group] || []).filter((_, index) => !broken.has(`contract.${group}.${index}`));
  const preconditions = keep("preconditions");
  const designedSuccess = keep("successConditions");
  const successConditions = inspectContractConsistency({ ...pinned, successConditions: designedSuccess }).some((issue) => issue.code === "deterministic_success_condition_required")
    ? base.successConditions
    : designedSuccess;
  const inputs = Object.keys(object(object(base.inputSchema).properties));
  const match = pinned.scope?.match;
  const requiredInputPaths = match?.requiredInputPaths?.filter((path) => inputs.includes(path.split(".")[0]));
  const scope = pinned.scope && match?.requiredInputPaths
    ? { ...pinned.scope, match: { ...match, ...(requiredInputPaths?.length ? { requiredInputPaths } : { requiredInputPaths: undefined }) } }
    : pinned.scope;
  if (scope?.match && !scope.match.requiredInputPaths) delete scope.match.requiredInputPaths;
  return {
    ...pinned,
    intent: broken.has("contract.intent") ? base.intent : pinned.intent,
    preconditions,
    successConditions,
    ...(scope ? { scope } : {}),
  };
}

/**
 * Where a page-scoped capability may be called, which is not where it ends up.
 *
 * A capability whose input is part of an address opens that address itself, so
 * it can be called from anywhere on the site. Pinning it to the route it ended
 * on made it unreachable: 查看某一天的微博热搜榜单 was scoped to /daily/*, and a
 * person asking from the home page was answered by the page agent in 172
 * seconds instead of by the capability in four.
 *
 * Where no address carries the input, the capability really does have to be on
 * that page, and it has to say which pages those are. A model that described
 * the page in prose supplies no pattern, and the capability was refused
 * outright for a fact the run had established: the route it ran on, with the
 * declared writing replaced by a wildcard.
 */
export function scopeWithRouteMatch(
  scope: CapabilityContract["scope"],
  evidenceUrl: string,
  addressInputs: Record<string, string>,
  demonstrated: Record<string, JsonValue> = {},
) {
  if (!scope || scope.kind !== "page-scoped") return scope;
  // The address the demonstration ended on carries one of its inputs, so
  // another input reaches another page and this capability is not about a
  // page at all. The declared address writings say so when the model wrote
  // them; the values the run actually used say so either way — 查看人物微博
  // 热搜记录 came back scoped to the single URL its demonstration ended on,
  // 周杰伦's own page, and answered nobody asking about anyone else from
  // anywhere else.
  const carried = [
    ...Object.values(addressInputs).filter((value) => value.trim()),
    ...Object.values(demonstrated).flatMap((value) => (typeof value === "string" || typeof value === "number") && String(value).trim() ? [String(value)] : []),
  ];
  const inAddress = (value: string) => {
    if (evidenceUrl.includes(value)) return true;
    try { return evidenceUrl.includes(encodeURIComponent(value)) || decodeURIComponent(evidenceUrl).includes(value); } catch { return false; }
  };
  if (carried.some(inAddress)) {
    const { match: _pinned, ...rest } = scope;
    return { ...rest, kind: "site-global" as const };
  }
  if (scope.match?.urlPatterns?.length || scope.match?.tokens?.length) return scope;
  let pattern: string;
  try {
    const url = new URL(evidenceUrl);
    const written = carried;
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
      const decoded = (() => { try { return decodeURIComponent(segment); } catch { return segment; } })();
      return written.some((value) => decoded === value) ? "*" : segment;
    });
    if (!segments.length) return scope;
    pattern = `/${segments.join("/")}`;
  } catch { return scope; }
  return { ...scope, match: { ...scope.match, urlPatterns: [pattern] } };
}

export function assembleCapabilityContract(record: {
  designed: { outputSchema?: unknown; preconditions?: unknown; successConditions?: unknown; addressInputs?: unknown };
  parameterPlan: ParameterPlan;
  scope: CapabilityContract["scope"];
  /** The exploration output envelope (extracted values plus pageUrl/pageTitle). */
  output: JsonObject;
  evidence: { url: string; text: string };
  /** The page as it stood before the capability did anything. */
  entryText?: string;
  completionSignals: string[];
  startUrl: string;
  /** The demonstration's effective input parameters. */
  input: Record<string, JsonValue>;
}): CapabilityContract {
  const { designed, parameterPlan, output, evidence, startUrl } = record;
  const addressInputs = addressWrittenInputs(designed, evidence.url, parameterPlan.parameters.map((parameter) => parameter.name));
  const successConditions = normalizeContractConditions(designed.successConditions, parameterPlan);
  for (const signal of record.completionSignals) {
    const reusableSignal = reusableCompletionSignal(signal) || signal;
    // "Found 1138 records containing X": the keyword can be parameterized, the
    // 1138 cannot — another keyword or another day gives another number. Such a
    // signal stays in the evidence and never enters the contract.
    if (hasVolatileNumber(reusableSignal, parameterPlan)) continue;
    const condition = normalizeContractCondition({ type: "textIncludes", value: reusableSignal }, parameterPlan);
    if (!successConditions.some((candidate) => JSON.stringify(candidate) === JSON.stringify(condition))) successConditions.push(condition);
  }
  for (const parameter of parameterPlan.parameters) {
    if (typeof parameter.exampleValue !== "string" || parameter.exampleValue.length < 2 || !evidence.text.includes(parameter.exampleValue)) continue;
    const condition = { type: "textTemplate", template: `{{${parameter.name}}}` } satisfies JsonObject;
    if (!successConditions.some((candidate) => JSON.stringify(candidate) === JSON.stringify(condition))) successConditions.push(condition);
  }
  const alignedSuccessConditions = alignSuccessConditionsToEvidence(successConditions, parameterPlan, evidence.url, record.input, evidence.text, record.entryText);
  const outputSchema = normalizeContractOutputSchema(designed.outputSchema, output);
  const stableSuccessConditions = deterministicContractConditions(ensureResultOutputCondition(
    reconcileOutputConditionsWithSchema(
      ensureTargetSuccessConditions(alignedSuccessConditions, parameterPlan, record.input, evidence.text),
      outputSchema,
    ),
    output,
    outputSchema,
  ));
  // Keep route transitions observed in the successful episode in the frozen
  // contract. A logo present on the entry page cannot prove navigation.
  const entryRoute = new URL(startUrl);
  const resultRoute = new URL(evidence.url, startUrl);
  if (entryRoute.origin === resultRoute.origin) {
    for (const key of resultRoute.searchParams.keys()) {
      if (entryRoute.searchParams.has(key) || /^(utm_|ref$|source$)/i.test(key)) continue;
      const separator = resultRoute.search.indexOf(`${encodeURIComponent(key)}=`) === 1 ? '?' : '&';
      const condition = {type:'urlIncludes',value:`${separator}${encodeURIComponent(key)}=`} satisfies JsonObject;
      if (!stableSuccessConditions.some(value => JSON.stringify(value) === JSON.stringify(condition))) stableSuccessConditions.push(condition);
    }
  }
  // The semantic scope/dependency projection belongs to the target
  // generation boundary.  Keep it out of the legacy Site SDK task shape
  // so older callers do not accidentally make the new scope gate reject
  // an otherwise compatible historical task.  The logical public schema
  // remains unchanged; this is only an internal compatibility projection.
  return {
    intent: parameterPlan.intent,
    inputSchema: inputSchemaFor(parameterPlan, addressInputs, record.input),
    outputSchema,
    preconditions: deterministicContractConditions(normalizeContractConditions(designed.preconditions, parameterPlan)),
    successConditions: stableSuccessConditions,
    // Prefer deterministic route evidence over a model's optimistic scope
    // claim. This is the pre-validation abstraction guard for category or
    // detail-page paths captured during discovery.
    scope: scopeWithRouteMatch(record.scope, evidence.url, addressInputs, record.input),
    ...(parameterPlan.inputAliases ? { inputAliases: parameterPlan.inputAliases } : {}),
  };
}

/** CandidateArtifact and C3 are deterministic boundaries. ModelGoal is useful
 * while a discovery runner is reasoning, but it must not cross that boundary
 * as a persisted Contract predicate. The surrounding target/output guards
 * guarantee that removing it still leaves at least one executable condition.
 */
function deterministicContractConditions(value: JsonValue[]) {
  return value.filter((condition) => typeof condition === "string" || String(object(condition).type || "") !== "modelGoal");
}

function actionIndex(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().match(/^(?:element[_-]?)?(\d+)$/i)?.[1] : value;
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function normalizeExplorerAction(raw: Record<string, unknown>): ExplorerAction {
  const nestedAction = object(raw.action);
  const rawFirstElement = Array.isArray(raw.elements) ? raw.elements[0] : undefined;
  const firstElement = object(rawFirstElement);
  const directElement = object(raw.element);
  const firstTarget = Array.isArray(raw.targets) ? object(raw.targets[0]) : object(raw.target);
  const nestedElement = object(nestedAction.element);
  const nestedTarget = object(nestedAction.target);
  const actionName = typeof raw.action === "string"
    ? raw.action
    : typeof nestedAction.type === "string"
      ? nestedAction.type
      : typeof raw.type === "string"
        ? raw.type
        : "fail";
  const actions = new Set<ExplorerAction["action"]>(["click", "fill", "select", "check", "press", "hover", "waitFor", "extract", "navigate", "done", "fail"]);
  const action = actions.has(actionName as ExplorerAction["action"]) ? actionName as ExplorerAction["action"] : "fail";
  const text = (key: string) => {
    const value = raw[key] ?? nestedAction[key] ?? directElement[key] ?? firstElement[key] ?? firstTarget[key] ?? nestedElement[key] ?? nestedTarget[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const value = raw.value ?? nestedAction.value ?? firstElement.value ?? firstTarget.value ?? nestedElement.value;
  return {
    action,
    index: actionIndex(raw.index)
      ?? actionIndex(raw.elementIndex)
      ?? actionIndex(raw.targetIndex)
      ?? actionIndex(raw.element)
      ?? actionIndex(rawFirstElement)
      ?? actionIndex(nestedAction.index)
      ?? actionIndex(nestedAction.elementIndex)
      ?? actionIndex(directElement.index)
      ?? actionIndex(directElement.elementIndex)
      ?? actionIndex(firstElement.index)
      ?? actionIndex(firstElement.elementIndex)
      ?? actionIndex(firstTarget.index)
      ?? actionIndex(firstTarget.elementIndex)
      ?? actionIndex(nestedElement.index)
      ?? actionIndex(nestedTarget.index),
    inputPath: text("inputPath"),
    value: value === undefined ? undefined : value as JsonValue,
    key: text("key"),
    url: text("url"),
    reason: action === "fail" && actionName !== "fail" ? `model_action_invalid:${actionName}` : text("reason"),
    saveAs: text("saveAs"),
    extractType: ["text", "value", "attribute"].includes(text("extractType") || "") ? text("extractType") as ExplorerAction["extractType"] : undefined,
    attribute: text("attribute"),
  };
}

function comparableText(value: string | undefined) {
  return (value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function elementContainsValue(element: PageElement, value: string) {
  const expected = comparableText(value);
  if (expected.length < 2) return false;
  return [element.container?.text, element.container?.heading, element.name, element.label]
    .some((candidate) => comparableText(candidate).includes(expected));
}

function sameRepeatedAction(left: PageElement, right: PageElement) {
  return left.role === right.role
    && left.tag === right.tag
    && comparableText(left.name) === comparableText(right.name)
    && Boolean(left.container) === Boolean(right.container);
}

function keyboardPressKey(value: string | undefined) {
  if (!value) return false;
  const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return false;
  const modifiers = new Set(["alt", "control", "meta", "shift"]);
  if (parts.slice(0, -1).some((part) => !modifiers.has(part.toLocaleLowerCase()))) return false;
  const key = parts.at(-1)!;
  if (Array.from(key).length === 1) return true;
  return /^(?:Enter|Tab|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Space|F(?:[1-9]|1[0-2]))$/i.test(key);
}

function repairPressAction(action: ExplorerAction, input: CapabilityTaskInput): ExplorerAction {
  if (action.action !== "press") return action;
  const resolvedPath = action.inputPath ? resolveInputParameter(input.parameters, action.inputPath) : undefined;
  const rawText = action.key || (resolvedPath?.value !== undefined ? String(resolvedPath.value) : typeof action.value === "string" ? action.value : "");
  const parameter = Object.entries(input.parameters).find(([, value]) => typeof value !== "object" && String(value) === rawText)?.[0];
  // Providers occasionally express text entry as `press("some words")`.
  // Treat a business value as text input before accepting one-character keys,
  // otherwise a one-letter search term would still be compiled as a key press.
  if (parameter || (rawText && !keyboardPressKey(rawText))) {
    return {
      ...action,
      action: "fill",
      inputPath: parameter || resolvedPath?.path,
      value: parameter || resolvedPath?.path ? undefined : rawText,
      key: undefined,
    };
  }
  if (keyboardPressKey(action.key)) return { ...action, inputPath: undefined, value: undefined };
  if (action.inputPath) return { ...action, action: "fill", key: undefined };
  return { ...action, action: "fail", reason: "model_press_key_invalid" };
}

export function groundExplorerAction(action: ExplorerAction, snapshot: Awaited<ReturnType<typeof inspectPage>>, input: CapabilityTaskInput): ExplorerAction {
  action = repairPressAction(action, input);
  if (action.index === undefined || !["click", "fill", "select", "check", "press", "hover", "waitFor", "extract"].includes(action.action)) return action;
  const selected = snapshot.elements.find((element) => element.index === action.index);
  if (!selected) return action;
  // Models occasionally bind a product/search parameter to a visible
  // textarea on a product detail page because the textarea's surrounding
  // product copy contains the same noun.  That is not a valid search action:
  // a target-like fill must use the page's actual search control.  Repair only
  // when the page exposes one unambiguous search input; otherwise keep the
  // model action and let the strict explorer fail closed.
  const targetInput = typeof action.inputPath === "string" && /(?:product|item|query|keyword|search|target|category)/iu.test(action.inputPath);
  const selectedIsSearch = selected.role === "searchbox"
    || selected.inputType === "search"
    || /搜索|search|关键词|关键字/i.test(`${selected.name || ""} ${selected.placeholder || ""}`);
  if (action.action === "fill" && targetInput && !selectedIsSearch) {
    const searchCandidates = snapshot.elements.filter((candidate) =>
      (candidate.tag === "input" || candidate.tag === "textarea")
      && (candidate.role === "searchbox"
        || candidate.inputType === "search"
        || /搜索|search|关键词|关键字/i.test(`${candidate.name || ""} ${candidate.placeholder || ""}`)),
    );
    if (searchCandidates.length === 1) return { ...action, index: searchCandidates[0].index, value: undefined };
  }
  const businessValues = Object.entries(input.parameters)
    .flatMap(([key, value]): string[] => typeof value === "string" && value.trim().length > 1 && !sensitiveFieldName(key) ? [value] : []);
  if (!businessValues.length || businessValues.some((value) => elementContainsValue(selected, value))) return action;
  const grounded = snapshot.elements.filter((candidate) => sameRepeatedAction(selected, candidate) && businessValues.some((value) => elementContainsValue(candidate, value)));
  return grounded.length === 1 ? { ...action, index: grounded[0].index } : action;
}

export function normalizeExplorerInputPath(action: ExplorerAction, input: CapabilityTaskInput): ExplorerAction {
  if (!action.inputPath) return action;
  const resolved = resolveInputParameter(input.parameters, action.inputPath);
  if (resolved.value === undefined) {
    // A choice the task does not take as an input ("US plug" when only the
    // finish is one) is a fixed part of the path. When the model gave the
    // value too, use it: the repair turn that followed pressed the model to
    // pick one of the real input keys instead, and the plug dropdown was set
    // from the finish.
    if (action.value !== undefined && action.value !== null && String(action.value).trim()) {
      const { inputPath: _ignored, ...literal } = action;
      return literal;
    }
    throw new InvalidModelInputPathError(action.inputPath, Object.keys(input.parameters));
  }
  return resolved.path === action.inputPath ? action : { ...action, inputPath: resolved.path };
}

function normalizedFacetToken(value: string) {
  const token = comparableText(value)
    .replace(/^(?:color|colour|颜色)\s*[-:：]?\s*/i, "")
    .replace(/[()\[\]{}]/g, "")
    .trim();
  // Keep the equality check strict while allowing the common locale spelling
  // used by PrestaShop's English catalog for a Chinese user request. This is
  // a finite vocabulary, not fuzzy similarity: unknown values still fail.
  const commonColorNames: Record<string, string> = {
    "黑": "black", "黑色": "black", "black": "black",
    "白": "white", "白色": "white", "white": "white",
    "棕": "brown", "棕色": "brown", "brown": "brown",
    "红": "red", "红色": "red", "red": "red",
    "蓝": "blue", "蓝色": "blue", "blue": "blue",
    "绿": "green", "绿色": "green", "green": "green",
    "黄": "yellow", "黄色": "yellow", "yellow": "yellow",
    "灰": "gray", "灰色": "gray", "grey": "gray", "gray": "gray",
  };
  return commonColorNames[token] || token;
}

/**
 * Reject a semantically unsafe facet click before it reaches Playwright.
 * Discovery may encounter a product card with a requested noun but without
 * the requested color/size. Clicking the nearest available facet would make
 * the generated capability silently do the wrong thing, so the correct
 * outcome is an explicit exploration failure that remains auditable.
 */
export function rejectMismatchedFacetAction(action: ExplorerAction, snapshot: Awaited<ReturnType<typeof inspectPage>>, input: CapabilityTaskInput): ExplorerAction {
  if (!['click', 'check'].includes(action.action) || action.index === undefined) return action;
  const element = snapshot.elements.find((candidate) => candidate.index === action.index);
  if (!element) return action;
  const descriptor = [element.name, element.label, element.container?.heading].filter(Boolean).join(' ');
  const isFacet = element.inputType === 'color' || /(?:^|\s)(?:color|colour)\s*[-:：]|颜色\s*[-:：]?/i.test(descriptor);
  if (!isFacet) return action;
  const facetParameter = Object.entries(input.parameters).find(([key, value]) =>
    typeof value === 'string' && value.trim().length > 0 && /(?:color|colour|颜色|色|size|尺寸|尺码)/i.test(key));
  if (!facetParameter) return action;
  const [key, rawValue] = facetParameter;
  const aliases = object(object(input.context.__capabilityInputAliases)[key]);
  const accepted = new Set<string>([normalizedFacetToken(String(rawValue))]);
  const mapped = aliases[String(rawValue)];
  if (typeof mapped === 'string') accepted.add(normalizedFacetToken(mapped));
  const target = normalizedFacetToken(descriptor);
  if (target && ![...accepted].some((value) => value === target || target.includes(value) || value.includes(target))) {
    return { action: 'fail', reason: `requested_facet_unavailable:${key}:${String(rawValue)}` };
  }
  return action;
}

/**
 * A product detail page can expose a disabled primary Add-to-cart control
 * (for example, a customizable product that requires user text) while also
 * rendering enabled related-product cards.  The model is told to choose an
 * alternative, but a contradictory click occasionally survives its repair
 * turns.  Keep the exploration safe and productive by selecting an enabled
 * card only when its accessible name is an Add-to-cart control and its card
 * text contains the requested product noun.  This is an internal explorer
 * guard; it does not change the CapabilityTask/RunSpec contract.
 */
function selectEnabledAddToCartAlternative(
  snapshot: Awaited<ReturnType<typeof inspectPage>>,
  input: CapabilityTaskInput,
  disabledTarget?: { name?: string; container?: { text?: string } },
): ExplorerAction | undefined {
  const productValue = Object.entries(input.parameters).find(([key, value]) =>
    typeof value === "string" && value.trim().length > 0 && /product|item|keyword|query|商品|产品|物品|关键词/i.test(key));
  if (!productValue) return undefined;
  const [productKey, productRawValue] = productValue;
  const aliases = object(object(input.context.__capabilityInputAliases)[productKey]);
  const requestedValues = [String(productRawValue).trim(), aliases[String(productRawValue)]]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.toLocaleLowerCase());
  const disabledName = String(disabledTarget?.name || "").toLocaleLowerCase();
  const candidates = snapshot.elements
    .filter((element) => element.role === "button"
      && /add\s*to\s*cart|加入购物车|添加到购物车/i.test(String(element.name || ""))
      && !element.disabled
      && !element.ariaDisabled
      // The DOM observer may expose a semantic container as `article`, a
      // product-card class, or a generated CSS token.  Requiring one exact
      // tag made this generic recovery path silently miss valid enabled
      // candidates on otherwise ordinary catalog markup.  Keep the scope
      // bounded to a product-like container, but do not couple it to a site
      // template.
      && /article|product|card|item|tile|list/iu.test(String(element.container?.css || "")))
    .filter((element) => requestedValues.some((value) => String(element.container?.text || element.name || "").toLocaleLowerCase().includes(value)))
    .filter((element) => String(element.name || "").toLocaleLowerCase() !== disabledName);
  const target = candidates[0];
  return target ? { action: "click", index: target.index, reason: "disabled_target_replaced_with_matching_enabled_product" } : undefined;
}

/**
 * A list card is often not rich enough to expose a requested facet (colour,
 * size, material, ...).  In that situation several cards are not a final
 * ambiguity: they are candidates that must be inspected one at a time.  This
 * helper creates a side-effect-free detail-page probe for the first
 * unvisited, input-matching product link.  The caller records the href so a
 * failed facet check can return to the list and advance to the next product.
 * It deliberately does not select an Add-to-cart control and never embeds a
 * concrete route in a generated capability.
 */
function selectUnprobedDynamicProduct(
  snapshot: Awaited<ReturnType<typeof inspectPage>>,
  goal: string,
  input: CapabilityTaskInput,
  allowedOrigin: string,
  probedHrefs: Set<string>,
): ExplorerAction | undefined {
  const writeIntent = /加入|添加|购物车|购买|买|下单|add\s*to\s*cart|cart|buy|purchase|order/iu.test(goal);
  if (!writeIntent) return undefined;
  const aliases = object(input.context.__capabilityInputAliases);
  const targetTerms = Object.entries(input.parameters)
    .filter(([key, value]) => typeof value === "string" && value.trim().length > 1 && /product|item|keyword|query|search|target|商品|产品|物品|关键词/iu.test(key))
    .flatMap(([key, value]) => {
      const values = [String(value).trim()];
      const mapped = object(aliases[key])[String(value)];
      if (typeof mapped === "string" && mapped.trim()) values.push(mapped.trim());
      return values;
    })
    .map(comparableText)
    .filter((value) => value.length > 1);
  const facetParameters = Object.entries(input.parameters).filter(([key, value]) =>
    typeof value === "string" && value.trim().length > 0 && /color|colour|颜色|色|size|尺寸|尺码|material|材质|brand|品牌/iu.test(key));
  if (!targetTerms.length || !facetParameters.length) return undefined;
  const candidates = snapshot.elements
    .filter((element) => element.tag === "a" && element.role === "link" && typeof element.href === "string" && Boolean(element.container))
    .map((element) => {
      const href = String(element.href || "");
      const cardText = comparableText(`${element.container?.text || ""} ${element.container?.heading || ""} ${element.name || ""}`);
      return { element, href, cardText };
    })
    .filter(({ href, cardText, element }) => {
      try {
        if (new URL(href).origin !== allowedOrigin) return false;
      } catch { return false; }
      if (!/\.html(?:$|[?#])/iu.test(href)) return false;
      if (!/article|product|card|item|tile|list/iu.test(String(element.container?.css || ""))) return false;
      return targetTerms.some((term) => cardText.includes(term));
    })
    .filter(({ href }) => !probedHrefs.has(href));
  const candidate = candidates.find(({ href }, index, all) => all.findIndex((item) => item.href === href) === index);
  if (!candidate) return undefined;
  probedHrefs.add(candidate.href);
  return {
    action: "click",
    index: candidate.element.index,
    reason: "dynamic_target_probe_before_final_selection",
  };
}

/**
 * A product detail can expose a customization field even when the user did
 * not supply one. Treat that as an unexecutable candidate, not as permission
 * to invent text. Return through the real browser history and select a
 * matching enabled card before asking the model for another action.
 */
async function recoverUnprovidedProductConfiguration(page: Page, input: CapabilityTaskInput, snapshot: Awaited<ReturnType<typeof inspectPage>>) {
  if (!/\.html(?:$|[?#])/iu.test(snapshot.url)) return false;
  const hasProvidedConfiguration = Object.keys(input.parameters).some((key) => /custom|message|text|note|engrave|personal|定制|留言|文本|备注/iu.test(key));
  if (hasProvidedConfiguration) return false;
  const hasConfigurationControl = snapshot.elements.some((element) => element.tag === "textarea"
    || /custom|message|text|note|engrave|personal|定制|留言|文本|备注/iu.test(`${element.name || ""} ${element.placeholder || ""}`));
  if (!hasConfigurationControl) return false;
  const hasEnabledPrimary = snapshot.elements.some((element) => element.role === "button"
    && /add\s*to\s*cart|加入购物车|添加到购物车/i.test(String(element.name || ""))
    && !element.disabled && !element.ariaDisabled && !element.container);
  if (hasEnabledPrimary) return false;
  const previousUrl = page.url();
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
  if (page.url() === previousUrl) return false;
  await page.waitForTimeout(200);
  const values: string[] = [];
  const aliases = object(input.context.__capabilityInputAliases);
  for (const [key, value] of Object.entries(input.parameters)) {
    if (typeof value !== "string" || !value.trim() || !/product|item|keyword|query|search|category|商品|产品|物品|关键词|类别/iu.test(key)) continue;
    values.push(value.trim());
    const map = object(aliases[key]);
    if (typeof map[value] === "string" && map[value].trim()) values.push(map[value].trim());
  }
  const wanted = [...new Set(values)];
  if (!wanted.length) return false;
  const href = await page.evaluate(`((values) => {
    const normalize = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[\\s\\p{P}\\p{S}]+/gu, "");
    const needles = values.map(normalize).filter((value) => value.length >= 2);
    for (const container of [...document.querySelectorAll("article,li,[role='listitem'],[data-testid]")]) {
      const text = normalize(container.textContent || "");
      if (!needles.some((needle) => text.includes(needle))) continue;
      const add = [...container.querySelectorAll("button,a,[role='button']")].find((element) => {
        const label = ((element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || "")).replace(/\\s+/g, " ").trim();
        return /add\\s*to\\s*cart|加入购物车|添加到购物车/i.test(label)
          && !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true";
      });
      if (!add) continue;
      const link = [...container.querySelectorAll("a[href]")].find((element) => {
        const href = element.getAttribute("href") || "";
        return href && !/quickview|javascript:/iu.test(href) && !element.hasAttribute("data-ps-action");
      });
      if (link) return link.href || link.getAttribute("href");
    }
    return null;
  })(${JSON.stringify(wanted)})`) as string | null;
  if (!href) return false;
  await page.goto(new URL(href, page.url()).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await settlePage(page);
  return true;
}

/**
 * The address the recording says a step happened at, when we are not there.
 *
 * Every recorded step carries the page it was taken on, and that address is
 * often the whole of what the run teaches. The one recorded episode on
 * 热搜时光机 is a single scroll at /daily/2026-09-20: the agent never touched a
 * date control, because the site addresses a day directly. The exploration
 * started at the site root and spent its budget hunting for a path the agent
 * had never walked.
 */
export function recordedPageMove(
  recorded: NonNullable<CapabilityTaskInput["experience"]>["actions"][number],
  currentUrl: string,
  allowedOrigin: string,
): ExplorerAction | undefined {
  const raw = recorded.page?.url;
  if (typeof raw !== "string" || !raw) return undefined;
  let target: URL;
  let here: URL;
  try { target = new URL(raw); here = new URL(currentUrl); } catch { return undefined; }
  if (target.origin !== allowedOrigin) return undefined;
  if (target.href === here.href) return undefined;
  if (target.pathname === here.pathname && target.search === here.search) return undefined;
  return { action: "navigate", url: target.href };
}

/**
 * The step a successful agent run already took, expressed against the page in
 * front of us.
 *
 * A capability is generated because an agent completed the task once. That run
 * is recorded — every click, what was typed, the element's role and accessible
 * name, the page it happened on — and the exploration used to ask a model to
 * find the same path again, one model turn per step, sixteen steps' worth of
 * budget, on a site whose route was already known. It cost minutes per run and
 * it failed on paths the recording had walked successfully.
 *
 * So the recording drives the exploration and the model is the fallback. A
 * recorded step that cannot be found on the current page is skipped rather
 * than insisted upon: the page may legitimately differ from the recording, and
 * a model turn for that one step is what the old path did for every step.
 */
export function recordedExplorerAction(
  recorded: NonNullable<CapabilityTaskInput["experience"]>["actions"][number],
  snapshot: Awaited<ReturnType<typeof inspectPage>>,
  input: CapabilityTaskInput,
): ExplorerAction | undefined {
  const verb = recorded.action;
  if (verb !== "click" && verb !== "fill" && verb !== "select") return undefined;
  const element = recorded.element || {};
  const named = comparableText(element.accessibleName || element.label || element.placeholder || undefined);
  const href = typeof element.href === "string" ? element.href : "";
  const sameAddress = (value: string | undefined) => {
    if (!value || !href) return false;
    try { return new URL(value, snapshot.url).href === new URL(href, snapshot.url).href; } catch { return false; }
  };
  const target = snapshot.elements.find((item) => {
    if (item.disabled || item.ariaDisabled) return false;
    if (element.role && item.role && item.role !== element.role) return false;
    if (sameAddress(item.href)) return true;
    if (!named) return false;
    return [item.name, item.label, item.placeholder].some((value) => comparableText(value) === named);
  });
  if (!target) return undefined;
  if (verb === "click") return { action: "click", index: target.index };
  // What was typed belongs to an input when the demonstration ran with that
  // same value; otherwise it is the literal the recording used.
  const typed = Object.values(recorded.input || {}).find((value) => typeof value === "string" && value.trim());
  if (typeof typed !== "string") return undefined;
  const inputPath = Object.entries(input.parameters).find(
    ([, value]) => typeof value === "string" && comparableText(value) === comparableText(typed),
  )?.[0];
  return inputPath
    ? { action: verb, index: target.index, inputPath }
    : { action: verb, index: target.index, value: typed };
}

async function chooseAction(goal: string, snapshot: Awaited<ReturnType<typeof inspectPage>>, input: CapabilityTaskInput, history: Array<Record<string, unknown>>, observer?: ExplorationObserver, guidance?: string) {
  const inputKeys = Object.keys(input.parameters);
  let normalized: ExplorerAction | undefined;
  let response: Record<string, unknown> | undefined;
  for (let repairAttempt = 0; repairAttempt < 2; repairAttempt += 1) {
    response = await modelJson(BROWSER_EXPLORER_PROMPT, {
      goal,
      demonstrationGoal: input.experience?.originalGoal,
      guidance: repairAttempt === 0
        ? guidance || undefined
        : [guidance, `上一动作的 inputPath 无效。inputPath 只能逐字使用 canonical inputKeys：${inputKeys.join(", ")}；禁止使用数组下标、DOM index、数字字符串或 envelope 路径。如果要填写或选择的值不是任何一个输入，就不要写 inputPath，直接在 value 里给出页面上的选项文字。请针对同一页面重新给出一个单步动作。`].filter(Boolean).join("\n"),
      inputKeys,
      inputValues: Object.fromEntries(Object.entries(input.parameters).map(([key, value]) => [key, sensitiveFieldName(key) ? "[provided]" : value])),
      page: snapshot,
      history: history.slice(-12),
    }, observer, "explorer-action", (value) => {
      if (typeof value.action !== "string") throw new Error("explorer_action_shape_invalid");
    });
    const grounded = groundExplorerAction(normalizeExplorerAction(response), snapshot, input);
    try {
      normalized = normalizeExplorerInputPath(rejectMismatchedFacetAction(grounded, snapshot, input), input);
      break;
    } catch (error) {
      if (!(error instanceof InvalidModelInputPathError)) throw error;
      observe(observer, {
        stage: "explorer-action-contract-repair",
        response: redactedTraceValue({
          reason: "model_input_path_invalid",
          inputPath: error.path,
          allowedPaths: error.allowedPaths,
          action: grounded,
          repairAttempt: repairAttempt + 1,
        }),
      });
      history.push({ action: "invalid", reason: "model_input_path_invalid", inputPath: error.path, allowedPaths: error.allowedPaths, url: snapshot.url });
      if (repairAttempt === 1) {
        return { action: "fail" as const, reason: `model_input_path_invalid:${error.path}` };
      }
    }
  }
  if (!normalized || !response) return { action: "fail" as const, reason: "explorer_action_missing" };
  // Apply the no-progress guard at the model boundary as well as immediately
  // before execution.  A fresh model response must never be allowed to repeat
  // the same fill forever when the page did not change (this is especially
  // common when a form's live value is omitted from a compact snapshot).
  const previous = history.at(-1);
  if (previous?.action === "fill"
    && normalized.action === "fill"
    && previous.index === normalized.index) {
    const guarded = overrideRepeatedAction(normalized, snapshot, history);
    observe(observer, { stage: "explorer-action-guard", response: redactedTraceValue({ reason: guarded.reason, previous, proposed: normalized, action: guarded }) });
    return guarded;
  }
  observe(observer, { stage: "explorer-action-normalized", response: redactedTraceValue(normalized) });
  return normalized;
}

/**
 * A page control whose name or label carries the visitor's whole request is a
 * shortcut to the assistant — an example-question chip, a "send this to the
 * assistant" button — not the site doing the work. A real control is named
 * for what it does ("Add to cart", "Brass"), never with a sentence. Clicking
 * one "completed" an exploration that never touched the shop, and the
 * contract then took the chip's own acknowledgement as success.
 */
export function withoutGoalEchoes<T extends { elements: Array<{ name?: string; label?: string }> }>(snapshot: T, goals: Array<string | undefined>): T {
  // Long enough that no control is named that way: five words, or eight
  // characters of a script written without spaces. "Add to cart" is a goal a
  // button may legitimately share.
  const sentence = (goal: string) => goal.trim().split(/\s+/u).length >= 5
    || (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(goal) && capabilityTextToken(goal).length >= 8);
  const sentences = goals.filter((goal): goal is string => typeof goal === "string" && sentence(goal));
  if (!sentences.length) return snapshot;
  const echoes = (text: string | undefined) => Boolean(text) && sentences.some((goal) => capabilityTextMentions(text, goal));
  return { ...snapshot, elements: snapshot.elements.filter((element) => !echoes(element.name) && !echoes(element.label)) };
}

export async function exploreCapability(page: Page, goal: string, startUrl: string, input: CapabilityTaskInput, maxSteps = 16, observer?: ExplorationObserver, guidance?: string) {
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await settlePage(page);
  const initialSnapshot = await inspectPage(page);
  const initialBlock = diagnoseBlockedPage(initialSnapshot);
  if (initialBlock) throw new Error(initialBlock.code);
  let parameterPlan = await planParameters(goal, initialSnapshot, input, observer);
  observe(observer, { stage: "parameter-plan-normalized", response: redactedTraceValue(parameterPlan) });
  let effectiveInput = inputForPlan(input, parameterPlan);
  const allowedOrigin = new URL(startUrl).origin; const steps: ProgramStep[] = []; const history: Array<Record<string, unknown>> = []; const probedHrefs = new Set<string>(); const extractedOutput: JsonObject = {}; const seenSignals = new Set(initialSnapshot.signals); const authoredInputPaths = new Set<string>(); let autoCompletionReason: string | undefined;
  // The agent already walked this path once. Its steps lead, and the model is
  // asked only where a step cannot be placed on the page in front of us.
  const recordedActions = input.experience?.actions || [];
  let replayCursor = 0;
  let replayRetried = false;
  let replayMovedAt = -1;
  // A recorded step the site answered with an alert ("Please choose a plug
  // type.") is retried after the model has done what the alert asks. A
  // recording cannot show state the visitor's browser already had — a plug
  // chosen in an earlier visit — and a fresh browser meets that requirement
  // the first time. Twice per step at most.
  const seenAlerts = new Set(initialSnapshot.alerts || []);
  let lastReplayedStep = -1;
  // Index in `steps` of the program step the last replayed action produced.
  let lastReplayedProgramStep = -1;
  const alertRetries = new Map<number, number>();
  for (let index = 0; index < maxSteps; index += 1) {
    await settlePage(page);
    const inspected = await inspectPage(page);
    const snapshot = withoutGoalEchoes(inspected, [goal, input.experience?.originalGoal]);
    if (snapshot.elements.length !== inspected.elements.length) {
      observe(observer, { stage: "explorer-goal-echo-excluded", message: "controls named with the request itself were left out", response: redactedTraceValue(inspected.elements.filter((element) => !snapshot.elements.includes(element)).map((element) => ({ index: element.index, name: element.name }))) });
    }
    const pageBlock = diagnoseBlockedPage(snapshot);
    if (pageBlock) throw new Error(pageBlock.code);
    // A default control may only become visible after dynamic navigation. In
    // that case, extend the already planned contract with the grounded value
    // before the final Contract/Program is built. The exact example must still
    // match the control's current value, so a later user edit cannot be
    // mistaken for an initial default.
    const groundedParameters = applyPageControlDefaults(parameterPlan.parameters, snapshot, authoredInputPaths);
    if (groundedParameters.some((parameter, index) => JSON.stringify(parameter) !== JSON.stringify(parameterPlan.parameters[index]))) {
      parameterPlan = {
        ...parameterPlan,
        parameters: groundedParameters,
        groundingExamples: finalizeGroundingExamples(groundedParameters, parameterPlan.groundingExamples),
      };
      effectiveInput = inputForPlan(input, parameterPlan);
      observe(observer, { stage: "parameter-default-grounded", response: redactedTraceValue({ parameters: groundedParameters.filter((parameter) => parameter.defaultValue !== undefined) }) });
    }
    if (await recoverUnprovidedProductConfiguration(page, effectiveInput, snapshot)) {
      observe(observer, { stage: "explorer-action-guard", response: redactedTraceValue({ reason: "unprovided_product_configuration_recovered", from: snapshot.url, to: page.url() }) });
      history.push({ action: "recover", reason: "unprovided_product_configuration_recovered", url: snapshot.url });
      continue;
    }
    // A same-page dialog or form submission can expose a fresh status/alert
    // without changing the URL. Treat a newly visible, settled ARIA business
    // signal as a terminal exploration boundary. Executing another write after
    // that boundary can duplicate a side effect. Contract design, DraftReplay,
    // independent Validation and review still decide whether it is publishable.
    // The visitor's recorded path is the proof of what completing the task
    // takes. While steps of it remain, a status line that just appeared
    // ("Showing 5 of 16 lamps", "12 results") is the page reporting progress,
    // not the task being done: treating it as done ended exploration at the
    // first filtered list on any site that announces its result count, and
    // authoring was left to invent the rest of the path. Once the recording
    // is exhausted, or there is none, a fresh signal ends exploration as
    // before, so a confirmed write is still never repeated.
    const freshAlerts = (snapshot.alerts || []).filter((alert) => !seenAlerts.has(alert));
    for (const alert of snapshot.alerts || []) seenAlerts.add(alert);
    let alertGuidance: string | undefined;
    if (freshAlerts.length && lastReplayedStep >= 0 && (alertRetries.get(lastReplayedStep) || 0) < 2) {
      alertRetries.set(lastReplayedStep, (alertRetries.get(lastReplayedStep) || 0) + 1);
      replayCursor = lastReplayedStep;
      replayMovedAt = lastReplayedStep;
      replayRetried = false;
      // The attempt the page refused is not part of the path: kept, every
      // draft replayed a click that changes nothing and waited out its budget.
      if (lastReplayedProgramStep >= 0 && lastReplayedProgramStep === steps.length - 1) steps.pop();
      lastReplayedProgramStep = -1;
      alertGuidance = `The page answered the last recorded step with: ${freshAlerts.map((alert) => `"${alert}"`).join(", ")}. Do what it asks on this page (for example choose a required option); do not repeat that step yourself, it is retried next.`;
      observe(observer, { stage: "explorer-alert-retry", message: "the page asked for something before the recorded step can complete", response: redactedTraceValue({ alerts: freshAlerts, step: lastReplayedStep + 1 }) });
    }
    const recordingPending = replayCursor < recordedActions.length;
    const freshSignals = recordingPending ? [] : snapshot.signals.filter((signal) => !seenSignals.has(signal));
    let replayed: ExplorerAction | undefined;
    // Scrolling and waiting leave nothing to replay, and the loop settles the
    // page itself. Pass over them here, on the page they happened on, so the
    // turn goes to the next recorded step: handing it to the model instead let
    // it wander off the proven path — a lamp generation picked another product
    // right after the visitor's scroll and failed on an ambiguous card.
    while (!alertGuidance && !autoCompletionReason && !freshSignals.length && replayCursor < recordedActions.length
      && !["click", "fill", "select"].includes(recordedActions[replayCursor].action)
      && (replayMovedAt === replayCursor || !recordedPageMove(recordedActions[replayCursor], snapshot.url, allowedOrigin))) {
      replayCursor += 1;
    }
    const pendingRecorded = alertGuidance || autoCompletionReason || freshSignals.length ? undefined : recordedActions[replayCursor];
    if (pendingRecorded) {
      // Once per recorded step: a redirect that lands somewhere else must not
      // make the loop ask for the same address again.
      const move = replayMovedAt === replayCursor ? undefined : recordedPageMove(pendingRecorded, snapshot.url, allowedOrigin);
      if (move) {
        replayMovedAt = replayCursor;
        replayed = move;
        observe(observer, { stage: "explorer-action-replayed", response: redactedTraceValue({ step: replayCursor + 1, action: move, reason: "recorded_page" }) });
      } else if (["click", "fill", "select"].includes(pendingRecorded.action)) {
        replayed = recordedExplorerAction(pendingRecorded, snapshot, effectiveInput);
        if (replayed) {
          lastReplayedStep = replayCursor;
          replayCursor += 1;
          replayRetried = false;
          observe(observer, { stage: "explorer-action-replayed", response: redactedTraceValue({ step: replayCursor, action: replayed, recorded: pendingRecorded.rawAction }) });
        } else {
          // One more page to try it against — a route the recording reached by
          // a step we skipped may bring the element back — then move on.
          observe(observer, { stage: "explorer-action-replay-missed", response: redactedTraceValue({ step: replayCursor + 1, recorded: pendingRecorded.rawAction, role: pendingRecorded.element?.role, name: pendingRecorded.element?.accessibleName, retried: replayRetried }) });
          if (replayRetried) { replayCursor += 1; replayRetried = false; } else replayRetried = true;
        }
      } else {
        // Scrolling and waiting leave nothing to replay, and the loop settles
        // the page itself; the address it happened at was the useful part.
        replayCursor += 1;
      }
    }
    const proposedAction: ExplorerAction = autoCompletionReason
      ? { action: "done", reason: autoCompletionReason }
      : freshSignals.length
      ? { action: "done", reason: "fresh_page_business_signal" }
      : replayed || await chooseAction(goal, snapshot, effectiveInput, history, observer, alertGuidance ? [guidance, alertGuidance].filter(Boolean).join("\n") : guidance);
    autoCompletionReason = undefined;
    // A long DOM snapshot can be refreshed by a SPA while the model is
    // deciding.  Treat an out-of-range element index as a recoverable planning
    // error: ask for a fresh action against the same settled snapshot a small
    // number of times before surfacing page_changed.  This preserves strict
    // grounding (we never guess an index or select the first candidate) while
    // avoiding false failures caused by a stale model response.
    let groundedAction = proposedAction;
    if (!freshSignals.length && ["click", "fill", "select", "check", "hover", "waitFor", "extract"].includes(groundedAction.action)) {
      for (let repair = 0; repair < 2 && groundedAction.index !== undefined && !snapshot.elements.some((element) => element.index === groundedAction.index); repair += 1) {
        observe(observer, { stage: "explorer-action-repair", response: redactedTraceValue({ reason: "element_index_not_in_snapshot", action: groundedAction }) });
        history.push({ action: "invalid", reason: "element_index_not_in_snapshot", index: groundedAction.index, url: snapshot.url });
        groundedAction = await chooseAction(goal, snapshot, effectiveInput, history, observer, guidance);
      }
    }
    let action = freshSignals.length ? proposedAction : overrideRepeatedAction(groundedAction, snapshot, history);
    const searchGuarded = guardSearchResultDetailClick(action, snapshot, goal, effectiveInput, history);
    if (searchGuarded !== action) {
      action = searchGuarded;
      observe(observer, { stage: "explorer-action-guard", response: redactedTraceValue({ reason: action.reason || "search_results_ready", action }) });
    }
    if (action !== proposedAction) observe(observer, { stage: "explorer-action-guard", response: redactedTraceValue(action) });
    if (freshSignals.length) observe(observer, { stage: "explorer-terminal-signal", response: redactedTraceValue({ signals: freshSignals }) });
    // A disabled submit control is a recoverable planning result, not a
    // Playwright timeout.  Ask the real model for the next step against the
    // same settled page so it can satisfy an explicit prerequisite or choose
    // another matching product.  This keeps required customisation fields
    // from becoming accidental admin interactions or opaque page_changed
    // failures.
    for (let disabledRepair = 0; !freshSignals.length && disabledRepair < 2 && ["click", "check"].includes(action.action) && action.index !== undefined; disabledRepair += 1) {
      const target = snapshot.elements.find((element) => element.index === action.index);
      if (!target?.disabled && !target?.ariaDisabled) break;
      const repairReason = "target_disabled";
      observe(observer, { stage: "explorer-action-repair", response: redactedTraceValue({ reason: repairReason, action, target: { index: target.index, name: target.name, container: target.container } }) });
      history.push({ action: "invalid", reason: repairReason, index: action.index, url: snapshot.url });
      const repairGuidance = [guidance, "上一动作目标 disabled=true/ariaDisabled=true，不能点击；请完成用户已提供的前置字段，或选择另一个可直接完成目标的匹配商品，不要编造定制文案。"].filter(Boolean).join("\n");
      action = await chooseAction(goal, snapshot, effectiveInput, history, observer, repairGuidance);
      if (action.action === "fail") break;
    }
    // Do not let an unresolved disabled target reach Playwright.  When the
    // disabled control is a product-detail Add-to-cart button, prefer a
    // matching enabled related-product card; otherwise return an explicit
    // exploration failure so the task remains retryable and auditable.
    if (!freshSignals.length && ["click", "check"].includes(action.action) && action.index !== undefined) {
      const target = snapshot.elements.find((element) => element.index === action.index);
      if (target?.disabled || target?.ariaDisabled) {
        const alternative = selectEnabledAddToCartAlternative(snapshot, effectiveInput, target);
        if (alternative) {
          observe(observer, { stage: "explorer-action-guard", response: redactedTraceValue({ reason: alternative.reason, from: action, action: alternative }) });
          action = alternative;
        } else {
          action = { action: "fail", reason: "target_disabled_after_repair" };
        }
      }
    }
    // A model-level ambiguity on a dynamic product facet is recoverable while
    // exploring: inspect the next unvisited matching detail page before
    // deciding whether the final target is actually ambiguous.  This keeps
    // the fail-closed rule for the business write itself while avoiding a
    // dead-end when list cards omit colour/size/material metadata.
    if (action.action === "fail" && /ambiguous|多个|目标/iu.test(String(action.reason || ""))) {
      const probe = selectUnprobedDynamicProduct(snapshot, goal, effectiveInput, allowedOrigin, probedHrefs);
      if (probe) {
        observe(observer, { stage: "explorer-action-guard", response: redactedTraceValue({ reason: probe.reason, action: probe, probedCount: probedHrefs.size }) });
        action = probe;
      }
    }
    const selectedTarget = snapshot.elements.find((element) => element.index === action.index);
    // A link inside a card may be an external share/source link, not the card's
    // business action. Enforce the same origin boundary used by navigate before
    // clicking; give the model the rejection and the actual target to re-plan.
    if (action.action === "click" && selectedTarget?.href
      && new URL(selectedTarget.href, snapshot.url).origin !== allowedOrigin) {
      const reason = "external_link_outside_exploration_scope";
      const previousRejection = history.at(-1);
      history.push({ action: "rejected", proposedAction: action.action, target: selectedTarget, url: snapshot.url, reason,
        feedback: "该链接离开当前网站，不是站内卡片详情入口；请重新选择可点击卡片或站内链接。" });
      observe(observer, { stage: "explorer-action-result", message: "off-site link blocked; choosing an in-site target", response: redactedTraceValue(history.at(-1)) });
      if (previousRejection?.action === "rejected" && object(previousRejection.target).href === selectedTarget.href) {
        throw new Error(`capability_exploration_failed:${reason}`);
      }
      continue;
    }
    const previousAction = history.at(-1);
    if (action.action === "click" && previousAction?.action === "click" && previousAction.changed === false
      && previousAction.url === snapshot.url && object(previousAction.target).css === selectedTarget?.css
      && previousAction.repeatedWithoutChange === true) {
      throw new Error("capability_exploration_failed:repeated_click_without_page_progress");
    }
    history.push({ action: action.action, url: snapshot.url, index: action.index,
      ...(selectedTarget ? { target: { name: selectedTarget.name, css: selectedTarget.css, href: selectedTarget.href } } : {}),
      ...(action.reason ? { reason: action.reason } : {}) });
    if (action.action === "fail") throw new Error(`capability_exploration_failed:${action.reason || "model_failed"}`);
    if (action.action === 'done' && input.experience?.endPage?.url) {
      const expected = new URL(input.experience.endPage.url, startUrl);
      const initial = new URL(startUrl);
      const current = new URL(snapshot.url);
      const newKeys = [...expected.searchParams.keys()].filter(key => !initial.searchParams.has(key) && !/^(utm_|ref|source)/i.test(key));
      const missingTransition = current.origin !== initial.origin || newKeys.some(key => !current.searchParams.has(key));
      if (missingTransition) {
        // A rejected done must mark the current page's signals as seen; otherwise the
        // same signals look fresh next turn, done is proposed again automatically and
        // rejected again — the model is never consulted until the step budget is gone
        // (in production: the search box was filled, a role=status lit up, then 40+ turns spun in place).
        for (const signal of snapshot.signals) seenSignals.add(signal);
        const priorRejections = history.filter((entry) => entry.action === 'rejected' && entry.reason === 'completion_evidence_missing' && entry.url === snapshot.url).length;
        history.push({action:'rejected',reason:'completion_evidence_missing',url:snapshot.url,feedback:`尚未观察到原始成功任务的站内详情页面变化（期望地址带上 ${newKeys.join('、') || '新的查询参数'}）。请继续操作页面直到进入结果页——例如提交搜索或点击结果，不要把点击链接或页面提示当作完成。`});
        observe(observer,{stage:'explorer-action-result',response:redactedTraceValue(history.at(-1))});
        // A third rejection on the same page means the path really does not lead anywhere: fail explicitly and keep the remaining steps for a human to read.
        if (priorRejections >= 2) throw new Error('capability_exploration_failed:completion_evidence_missing');
        continue;
      }
    }
    if (action.action === "done") {
      // `done` is the explorer's explicit semantic completion decision. Do
      // not make candidate creation depend on a second, duplicative model
      // round trip. The evidence below must still produce an executable
      // Contract, pass DraftReplay, and pass a separate Validation Runner.
      // The explorer decides it is done from one snapshot, and a live region
      // announces work in progress through the same node it will announce the
      // result through. Read the page once more after it settles, and freeze
      // the Contract on what survived.
      const settled = evidenceThatSurvivedSettling(snapshot, await settleAndInspect(page));
      const verified = { success: true, outcome: "NoResult" as const, reason: action.reason || "explorer_reported_done", evidence: { url: settled.url, title: settled.title, heading: settled.heading, text: settled.text, signals: settled.signals } };
      const completionSignals = verified.evidence.signals.filter((signal) => !seenSignals.has(signal));
      const extractedResults = Object.fromEntries(steps.filter((step) => step.action === "extract").map((step) => [step.saveAs || step.id, { source: "variable", name: step.saveAs || step.id } as ProgramValue]));
      const program = { schemaVersion: "1.0", entry: { mode: "Navigate", url: startUrl }, defaults: { timeoutMs: 15_000, retryCount: 1 }, steps, result: { ...extractedResults, pageUrl: { source: "variable", name: "__pageUrl" }, pageTitle: { source: "variable", name: "__pageTitle" } } } satisfies CapabilityDslProgram;
      const inferredScope = inferCapabilityScope(startUrl, steps, parameterPlan);
      const { semantic: analyzedSemantic, observedDependencies } = analyzeCapabilitySemanticsDetailed({
        goal,
        effect: /加入|添加|购物车|add|cart|删除|remove|delete|保存|submit|提交|修改|update/iu.test(goal) ? "reversible-write" : "read",
        startUrl,
        endUrl: settled.url,
        input: effectiveInput.parameters,
        parameterPaths: parameterPlan.parameters.map((parameter) => parameter.name),
        steps,
        pageTexts: [settled.title, settled.heading, settled.text],
      });
      const semantic = withoutSemanticDependencies(analyzedSemantic);
      observe(observer, { stage: "semantic-analyze", response: redactedTraceValue({ goal, semantic, dependencies: observedDependencies }) });
      observe(observer, { stage: "dependency-ledger", response: redactedTraceValue({ entries: observedDependencies, decisions: semantic.scopeDecision }) });
      observe(observer, { stage: "scope-resolve", response: redactedTraceValue({ scope: semantic.scopeDecision.scope, decision: semantic.scopeDecision.status, entryPolicy: semantic.entryPolicy }) });
      observe(observer, { stage: "seed-build", response: redactedTraceValue({ seed: { name: parameterPlan.name, description: parameterPlan.description, aliases: parameterPlan.aliases, intent: parameterPlan.intent }, semantic }) });
      // The semantic resolver is the authority for the declared scope. Keep
      // legacy route evidence only when the resolver did not find a stronger
      // dependency decision, so a model cannot upgrade a fixed category path
      // to site-global by returning an optimistic scope object.
      const semanticScope = projectCapabilityScope(semantic.scopeDecision.scope);
      const scope = semanticScope?.kind === "site-global" && inferredScope.kind !== "site-global"
        ? inferredScope
        : semanticScope || inferredScope;
      const output = { ...extractedOutput, pageUrl: page.url(), pageTitle: await page.title() } satisfies JsonObject;
      const designed = await modelJson(CAPABILITY_CONTRACT_PROMPT, { goal, parameterPlan, scope, program, explorationOutputKeys: Object.keys(output), successEvidence: verified.evidence, completionSignals }, observer, "contract-design", (value) => {
        validateContractDesignResponse(value, parameterPlan);
      });
      const baseContract = input.trigger?.baseVersionId ? input.candidateSummary?.contract : undefined;
      const contract = pinContractToBase(assembleCapabilityContract({
        designed,
        parameterPlan,
        scope,
        output,
        evidence: verified.evidence,
        entryText: initialSnapshot.text,
        completionSignals,
        startUrl,
        input: effectiveInput.parameters,
      }), baseContract);
      if (baseContract) observe(observer, { stage: "contract-pinned", response: redactedTraceValue({ baseVersionId: input.trigger?.baseVersionId, outputs: Object.keys(object(baseContract.outputSchema).properties || {}) }) });
      const required = Array.isArray(object(contract.inputSchema).required) ? object(contract.inputSchema).required as JsonValue[] : [];
      // A second independent example strengthens generalization, but its
      // absence must not prevent a usable candidate from reaching C3. The
      // discovery demonstration is still mandatory and is validated there;
      // rejecting here would turn a quality improvement into a generation
      // dead-end for sites that expose only one suitable entity.
      if (required.length && parameterPlan.groundingExamples.length < 1) throw new EvaluationError("BusinessRejection", "capability_quality_rejected:grounding_example_required");
      // Every rule above is sound on its own; the frozen Contract must still
      // be satisfiable as a whole before authoring spends a single model call.
      const inconsistencies = inspectContractConsistency(contract);
      if (inconsistencies.length) {
        observe(observer, { stage: "contract-consistency", response: redactedTraceValue({ issues: inconsistencies }) });
        throw new ContractInconsistentError(inconsistencies);
      }
      const model = getModelConfig("execution").model;
      const usesModelGoal = contract.successConditions.some((condition) => typeof condition === "object" && String(object(condition).type || "") === "modelGoal");
      const usedPrompts = [CAPABILITY_SPEC_PROMPT, BROWSER_EXPLORER_PROMPT, CAPABILITY_CONTRACT_PROMPT, ...(usesModelGoal ? [RESULT_JUDGE_PROMPT] : [])];
      const promptProvenanceEntries: CapabilityPromptProvenance[] = await Promise.all(usedPrompts.map((prompt) => promptProvenance(prompt, model)));
      return {
        program,
        output,
        demonstrationParameters: effectiveInput.parameters,
        groundingExamples: parameterPlan.groundingExamples,
        promptProvenance: promptProvenanceEntries,
        candidateSummary: {
          name: parameterPlan.name,
          description: parameterPlan.description,
          aliases: parameterPlan.aliases,
          contract,
        },
      };
    }
    for (const signal of snapshot.signals) seenSignals.add(signal);
    if (action.action === 'waitFor' && action.index === undefined) {
      const duration = Number(action.value);
      if (!Number.isFinite(duration) || duration < 0 || duration > 5000) throw new Error('exploration_wait_duration_invalid');
      await page.waitForTimeout(duration);
      observe(observer, {stage:'explorer-action-result',response:{action:'waitFor',durationMs:duration,urlAfter:page.url()}});
      continue;
    }
    let step: ProgramStep;
    if (action.action === "navigate") {
      const url = new URL(String(action.url || ""), snapshot.url);
      if (url.origin !== allowedOrigin) throw new Error("navigation_target_origin_invalid");
      step = { id: `step_${index + 1}`, action: "navigate", value: { source: "literal", value: url.href } };
    } else if (action.action === "press" && action.index === undefined) {
      step = { id: `step_${index + 1}`, action: "press", key: action.key };
    } else {
      const foundElement = snapshot.elements.find((candidate) => candidate.index === action.index);
      if (!foundElement) throw new Error("exploration_element_invalid");
      let element: PageElement = foundElement;
      // Product cards frequently expose an unnamed image anchor plus one or
      // more named title/details links for the same href.  Preserve the
      // model's chosen business entity while replacing the fragile image hit
      // target with its named sibling.  The semantic link can be resolved
      // across validation inputs by the later JavaScript authoring stage.
      if (element.tag === "a" && !element.name && element.href && element.container) {
        const namedSibling = snapshot.elements.find((candidate) => candidate.tag === "a"
          && candidate.role === "link"
          && candidate.href === element.href
          && Boolean(candidate.name)
          && candidate.container?.css === element.container?.css
          && candidate.container?.text === element.container?.text);
        if (namedSibling) element = namedSibling;
      }
      const strategies = strategiesFor(element, effectiveInput); if (!strategies.length) throw new Error("exploration_element_unaddressable");
      step = { id: `step_${index + 1}`, action: action.action, target: { scope: scopeFor(element, effectiveInput), strategies }, value: programValue(action), key: action.key, saveAs: action.saveAs, extract: action.action === "extract" ? { type: action.extractType || "text", name: action.attribute } : undefined };
    }
    const saveAs = step.saveAs || step.id;
    if (["fill", "select", "check"].includes(action.action) && action.inputPath) authoredInputPaths.add(action.inputPath);
    const actionStartedAt = Date.now();
    const pagesBefore = new Set(page.context().pages());
    const stepResult = await executeProgram(page, { schemaVersion: "1.0", entry: { mode: "CurrentPage" }, defaults: { timeoutMs: 15_000, retryCount: 0 }, steps: [step], result: step.action === "extract" ? { [saveAs]: { source: "variable", name: saveAs } } : {} }, effectiveInput);
    // AJAX commerce effects (notably PrestaShop's blockcart modal) can be
    // inserted a few frames after the click promise resolves. Give the next
    // snapshot one bounded settle window so the terminal-success signal is
    // observed before the model is offered another side-effect action.
    if (["click", "check", "press"].includes(step.action)) await page.waitForTimeout(350);
    const after = await inspectPage(page);
    const openedPages = page.context().pages().filter((candidate) => !pagesBefore.has(candidate));
    const changed = after.url !== snapshot.url || after.text !== snapshot.text
      || JSON.stringify(after.elements.map((element) => [element.name, element.value, element.checked])) !== JSON.stringify(snapshot.elements.map((element) => [element.name, element.value, element.checked]));
    const receipt = history.at(-1)!;
    Object.assign(receipt, { urlAfter: after.url, changed, openedUrls: openedPages.map((candidate) => candidate.url()),
      repeatedWithoutChange: !changed && previousAction?.action === action.action && previousAction.changed === false && object(previousAction.target).css === selectedTarget?.css,
      feedback: openedPages.length ? "动作打开了新窗口，当前页面未必达成目标；不要重复点击。" : changed ? "页面已变化，请检查目标是否完成。" : "当前页面没有可观察变化，请检查目标和动作结果，不要原样重复。" });
    observe(observer, { stage: "explorer-action-result", message: `${action.action} · ${selectedTarget?.name || action.key || "page"} · ${changed ? "page changed" : "page unchanged"}`, durationMs: Date.now() - actionStartedAt, response: redactedTraceValue(receipt) });
    // The DSL authoring path cannot replay a popup transition. Surface that
    // limitation instead of generating a program for an unchanged parent page.
    if (openedPages.length) {
      await Promise.all(openedPages.map((candidate) => candidate.close().catch(() => undefined)));
      throw new Error("capability_exploration_failed:popup_transition_requires_page_handoff");
    }
    if (step.action === "extract" && stepResult.output[saveAs] !== undefined) extractedOutput[saveAs] = stepResult.output[saveAs];
    steps.push(step);
    lastReplayedProgramStep = replayed && action === replayed ? steps.length - 1 : -1;
    const resultUrl = String(stepResult.variables.__pageUrl || "");
    // Same rule: a pick that changed the address finishes exploration only
    // when nothing of the recorded path is left to replay.
    if (replayCursor >= recordedActions.length && resultUrl && resultUrl !== snapshot.url && (step.action === "select" || urlContainsAppliedInput(resultUrl, effectiveInput))) {
      autoCompletionReason = step.action === "select" ? "selection_navigation_applied" : "input_navigation_applied";
      observe(observer, { stage: "explorer-auto-complete", response: redactedTraceValue({ reason: autoCompletionReason, urlBefore: snapshot.url, urlAfter: resultUrl }) });
    }
  }
  throw new Error("capability_exploration_step_limit");
}

function schemaErrors(schema: Record<string, unknown>, value: unknown, path = "output"): string[] {
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path}:object_required`];
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    const properties = object(schema.properties);
    const recordValue = object(value);
    const unknown = schema.additionalProperties === false
      ? Object.keys(recordValue).filter((key) => !Object.hasOwn(properties, key)).map((key) => `${path}.${key}:additional_property_forbidden`)
      : [];
    return [...required.filter((key) => recordValue[key] === undefined).map((key) => `${path}.${key}:required`), ...unknown, ...Object.entries(properties).flatMap(([key, child]) => recordValue[key] === undefined ? [] : schemaErrors(object(child), recordValue[key], `${path}.${key}`))];
  }
  if (type === "array") {
    if (!Array.isArray(value)) return [`${path}:array_required`];
    const items = object(schema.items);
    return Object.entries(value).flatMap(([key, item]) => schemaErrors(items, item, `${path}.${key}`));
  }
  if (type === "string" && typeof value !== "string") return [`${path}:string_required`];
  if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return [`${path}:number_required`];
  if (type === "boolean" && typeof value !== "boolean") return [`${path}:boolean_required`];
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) return [`${path}:enum_invalid`];
  return [];
}

export function validateContractInput(contract: CapabilityContract | undefined, input: CapabilityTaskInput) {
  if (!contract) return;
  const errors = schemaErrors(contract.inputSchema, input.parameters, "input");
  if (errors.length) throw new EvaluationError("BusinessRejection", `input_schema_invalid:${errors.join(",")}`);
}

function renderInputTemplate(template: unknown, input: CapabilityTaskInput) {
  return renderCapabilityInputTemplate(template, input.parameters, (path) => { throw new MissingInputError(path, sensitiveFieldName(path)); });
}

/**
 * Conditions are authored from the observed site language, while callers use
 * the stable public vocabulary of the capability.  Keep validation against the
 * raw caller input, but render URL/text assertions with the contract aliases
 * that the authoring stage discovered (for example `衣服` -> `Clothes`).
 */

export function renderCapabilityGoal(goal: string, contract: CapabilityContract | undefined, input: CapabilityTaskInput) {
  return contract?.intent ? renderInputTemplate(contract.intent, input) : goal;
}

export async function evaluatePreconditions(page: Page, contract: CapabilityContract | undefined, input: CapabilityTaskInput) {
  if (!contract?.preconditions.length) return;
  // The same judgement the widget makes on the same page facts.
  const snapshot = await inspectPage(page);
  const failures = checkPreconditions(contract, { url: snapshot.url, text: snapshot.text }, resolveCapabilityInput(contract, input.parameters));
  if (failures.length) throw new EvaluationError("BusinessRejection", failures[0].code);
}

async function judgeGoal(page: Page, goal: string, conditions: JsonValue[], observer?: ExplorationObserver) {
  const snapshot = await inspectPage(page);
  const response = await modelJson(RESULT_JUDGE_PROMPT, { goal, conditions, page: { url: snapshot.url, title: snapshot.title, heading: snapshot.heading, text: snapshot.text } }, observer, "goal-judge", (value) => {
    if (typeof value.success !== "boolean" || !["NoResult", "BusinessRejection"].includes(String(value.outcome)) || typeof value.reason !== "string") throw new Error("result_judge_shape_invalid");
  });
  return { success: response.success === true, outcome: response.outcome === "NoResult" ? "NoResult" as const : "BusinessRejection" as const, reason: String(response.reason || "success_conditions_not_met"), evidence: { url: snapshot.url, title: snapshot.title, heading: snapshot.heading, text: snapshot.text, signals: snapshot.signals } };
}

export function validateCapabilityResultOutput(contract: CapabilityContract | undefined, output: JsonObject) {
  if (!contract) return;
  const errors = schemaErrors(contract.outputSchema, output);
  if (errors.length) throw new EvaluationError("BusinessRejection", `output_schema_invalid:${errors.join(",")}`);
  // Match the user SDK's constraints, including minLength/pattern/format.
  // A nonempty required business title must not pass C1/C3 as an empty string.
  try { assertCapabilityOutput(contract.outputSchema as never, output); }
  catch (error) { throw new EvaluationError("BusinessRejection", `output_schema_invalid:${error instanceof Error ? error.message : String(error)}`); }
}

export async function evaluateResult(page: Page, goal: string, contract: CapabilityContract | undefined, output: JsonObject, input: CapabilityTaskInput = { parameters: {}, context: {}, interactions: [], trigger: {} }, observer?: ExplorationObserver, observedText?: string) {
  validateCapabilityResultOutput(contract, output);
  const conditions = contract?.successConditions || [];
  const resolved = resolveCapabilityInput(contract, input.parameters);
  const conditionInput = { ...input, parameters: resolved.site };
  const snapshot = await inspectForContractText(page, conditions, conditionInput, 2_000, observedText);
  // One judgement for every host (lib/capability-center-v2/run-resolution):
  // an output and an address are facts about the run, page text is a fact
  // about a world that moves. Unmet text is reported, not charged. An address
  // the page writes differently from its selected option is this host's one
  // extra leniency, applied only after the shared judgement said no.
  const verdict = evaluateSuccessConditions(contract, { url: snapshot.url, text: snapshot.text, output }, resolved);
  for (const failure of verdict.failures) {
    if (failure.code === "success_url_mismatch" && await selectedInputMatchesUrlCondition(page, failure.condition, conditionInput)) continue;
    throw new EvaluationError("BusinessRejection", failure.code);
  }
  if (verdict.needsModelJudge) {
    const verified = await judgeGoal(page, renderCapabilityGoal(goal, contract, input), conditions, observer);
    if (!verified.success) throw new EvaluationError(verified.outcome, verified.reason);
  }
  return { success: true as const, ...(verdict.unmetText.length ? { unmetTextConditions: verdict.unmetText } : {}) };
}

/**
 * C3 validation primitive.  Unlike evaluateResult it has no model fallback:
 * every condition must be executable by the deterministic assertion DSL.
 */
export async function evaluateResultDeterministic(
  page: Page,
  contract: CapabilityContract | undefined,
  output: JsonObject,
  input: CapabilityTaskInput = { parameters: {}, context: {}, interactions: [], trigger: {} },
  observedText?: string,
) {
  validateCapabilityResultOutput(contract, output);
  const conditions = contract?.successConditions || [];
  const resolved = resolveCapabilityInput(contract, input.parameters);
  const conditionInput = { ...input, parameters: resolved.site };
  for (const raw of conditions) {
    const type = typeof raw === "string" ? "textIncludes" : String(object(raw).type || "");
    if (!["urlIncludes", "urlTemplate", "textIncludes", "textTemplate", "inputExists", "outputEquals", "outputExists"].includes(type)) {
      throw new EvaluationError("BusinessRejection", `deterministic_condition_unsupported:${type || "unknown"}`);
    }
  }
  const snapshot = await inspectForContractText(page, conditions, conditionInput, 2_000, observedText);
  // The shared judgement (lib/capability-center-v2/run-resolution). Validation
  // has no model to fall back on, so here an unmet text condition fails the
  // case — recorded with the text that was missing, as the generation spec
  // asks — where the widget only reports it.
  const verdict = evaluateSuccessConditions(contract, { url: snapshot.url, text: snapshot.text, output }, resolved);
  for (const failure of verdict.failures) {
    if (failure.code === "success_url_mismatch" && await selectedInputMatchesUrlCondition(page, failure.condition, conditionInput)) continue;
    throw new EvaluationError("BusinessRejection", failure.code);
  }
  if (verdict.unmetText.length) throw new EvaluationError("BusinessRejection", `success_text_missing:${verdict.unmetText[0]}`);
  return { success: true as const };
}
