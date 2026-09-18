import { PageController, type BrowserState } from "@page-agent/page-controller";
import {
  stableHash,
  type PageAgentObservation,
  type PageObservationRef,
  type PageRuntimeMetric,
  type StableTargetRef,
} from "../lib/site-knowledge/protocol";
import { pageObservationSha256 } from "../lib/capability-center-v2/page-observation";
import { uid } from "./user-agent-shared";
import { redactSensitivePageText, redactSensitiveUrl } from "../lib/site-knowledge/sensitive-data";

type SelectorNode = {
  ref?: HTMLElement;
  tagName?: string;
  attributes?: Record<string, string>;
};

type ObservationContext = {
  siteAgentId: string;
  runId: string;
  episodeId: string;
  browserSessionId: string;
  documentId: string;
  pageEpoch?: number;
};

type TurnCapture = {
  state: BrowserState;
  observation: PageAgentObservation;
  elements: Map<number, HTMLElement>;
  targets: Map<number, StableTargetRef>;
  selectorMap: Map<number, SelectorNode>;
  elementTextMap: Map<number, string>;
};

export type SiteAgentPageControllerSeed = TurnCapture;

type Options = ConstructorParameters<typeof PageController>[0] & {
  context: ObservationContext;
  projectState?: (state: BrowserState) => BrowserState;
  initialSeed?: SiteAgentPageControllerSeed;
  onObservation?: (observation: PageAgentObservation) => void | Promise<void>;
  onMetric?: (
    stage: Extract<PageRuntimeMetric["stage"], "observe_raw" | "observe_project">,
    startedAt: number,
    detail?: NonNullable<PageRuntimeMetric["detail"]>,
  ) => void;
};

const CONTROLLER_VERSION = "1.12.1";
const PROJECTION_VERSION = 2;
export const PAGE_AGENT_OBSERVATION_TTL_MS = 14 * 24 * 60 * 60_000;
export const PAGE_AGENT_OBSERVATION_MAX_BYTES = 96 * 1024;
const SENSITIVE_KEY = /(?:password|passwd|pwd|one[-_\s]?time(?:[-_\s]?code)?|otp|totp|verification[-_\s]?code|credit[-_\s]?card|card[-_\s]?(?:number|no)|cc[-_\s]?(?:number|num)|cvc|cvv|security[-_\s]?code|access[-_\s]?token|refresh[-_\s]?token|auth[-_\s]?token|bearer|token|session(?:id)?|api[-_\s]?key|secret)/i;
const SENSITIVE_AUTOCOMPLETE = /(?:current-password|new-password|one-time-code|cc-number|cc-csc)/i;
const REDACTED = "[REDACTED]";

function compactText(value: string | null | undefined, limit: number) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function redactSensitiveAssignments(value: string) {
  return value.replace(
    /\b(password|passwd|pwd|one[-_\s]?time(?:[-_\s]?code)?|otp|totp|verification[-_\s]?code|credit[-_\s]?card|card[-_\s]?(?:number|no)|cc[-_\s]?(?:number|num)|cvc|cvv|security[-_\s]?code|access[-_\s]?token|refresh[-_\s]?token|auth[-_\s]?token|bearer|token|session(?:id)?|api[-_\s]?key|secret)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s<>&,;]+)/gi,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
  );
}

export function sanitizePageAgentUrl(value: string) {
  return redactSensitiveUrl(value);
}

export function sanitizePageAgentText(value: string) {
  return redactSensitivePageText(redactSensitiveAssignments(value))
    .replace(/([?&#](?:password|passwd|pwd|otp|totp|token|session(?:id)?|cvc|cvv|cc[-_]?number)=)[^&#\s]*/gi, `$1${REDACTED}`)
    .split("\n").map((line) => {
    const tag = line.match(/<(?:input|textarea)\b[^>]*>/i)?.[0];
    if (!tag) return line;
    const sensitiveControl = /\btype\s*=\s*["']?password\b/i.test(tag)
      || new RegExp(`\\bautocomplete\\s*=\\s*["']?[^\\s>]*${SENSITIVE_AUTOCOMPLETE.source}`, "i").test(tag)
      || Array.from(tag.matchAll(/\b(?:name|id|aria-label|placeholder)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi))
        .some((match) => SENSITIVE_KEY.test(match[1] || match[2] || match[3] || ""));
    if (!sensitiveControl) return line;
    return line.replace(
      /(\bvalue\s*=\s*)(?:"[^"]*"|'[^']*'|.*?)(?=\s+\b[\w:-]+\s*=|\s*\/?\s*>|$)/i,
      `$1${REDACTED}`,
    );
  }).join("\n");
}

/** Sanitize once, then return this same object to the model and evidence sink. */
export function sanitizePageAgentBrowserState(state: BrowserState): BrowserState {
  return {
    url: sanitizePageAgentUrl(state.url),
    title: sanitizePageAgentText(state.title),
    header: sanitizePageAgentText(state.header),
    content: sanitizePageAgentText(state.content),
    footer: sanitizePageAgentText(state.footer),
  };
}

export function pageAgentObservationChain(
  previous: Pick<PageAgentObservation, "id" | "documentId" | "pageEpoch"> | undefined,
  documentId: string,
  pageEpoch: number,
): Pick<PageAgentObservation, "kind" | "baseObservationId"> {
  return previous?.documentId === documentId && previous.pageEpoch === pageEpoch
    ? { kind: "delta", baseObservationId: previous.id }
    : { kind: "full" };
}

function jsonBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function pageAgentObservationBytes(observation: PageAgentObservation) {
  return jsonBytes(observation);
}

function clipped(value: string | undefined, limit: number) {
  return value ? value.slice(0, limit) : undefined;
}

function compactTarget(target: StableTargetRef, level: number): StableTargetRef {
  if (!level) return target;
  if (level === 1) return {
    ...target,
    accessibleName: clipped(target.accessibleName, 160),
    hrefPath: clipped(target.hrefPath, 200),
    nearbyText: undefined,
  };
  if (level === 2) return {
    observationId: target.observationId,
    index: target.index,
    semanticId: target.semanticId,
    role: clipped(target.role, 48),
    accessibleName: clipped(target.accessibleName, 96),
    controlType: clipped(target.controlType, 48),
    formSignature: target.formSignature,
    hrefPath: clipped(target.hrefPath, 120),
  };
  return {
    observationId: target.observationId,
    index: target.index,
    semanticId: target.semanticId,
    controlType: clipped(target.controlType, 32),
  };
}

function interactiveCatalog(content: string, targets: StableTargetRef[], lineLimit: number) {
  const targetByIndex = new Map(targets.map((target) => [target.index, target]));
  const sourceByIndex = new Map<number, string>();
  for (const sourceLine of content.split("\n")) {
    const line = sourceLine.replace(/\s+/g, " ").trim();
    for (const match of line.matchAll(/\*?\[(\d+)\]/g)) {
      const index = Number(match[1]);
      if (!sourceByIndex.has(index)) sourceByIndex.set(index, line);
    }
  }
  const lines: string[] = [];
  const indexes = [...new Set([...targetByIndex.keys(), ...sourceByIndex.keys()])].sort((left, right) => left - right);
  for (const index of indexes) {
    const target = targetByIndex.get(index);
    const fallback = `[${index}]<${target?.controlType || target?.role || "element"}>${target?.accessibleName || target?.nearbyText || ""}`;
    const source = sourceByIndex.get(index);
    // Put the actionable token first even when its original line contained
    // several deeply nested indexes and must be clipped.
    lines.push((source ? `[${index}] ${source}` : fallback).slice(0, lineLimit));
  }
  return lines.join("\n");
}

/**
 * Bound the exact evidence object before either the model or persistence sees
 * it. Every selector index remains represented in both the target list and a
 * compact interactive catalog; an impossible page fails closed rather than
 * silently dropping an operable target.
 */
export function boundPageAgentObservation(
  input: PageAgentObservation,
  maxBytes = PAGE_AGENT_OBSERVATION_MAX_BYTES,
): PageAgentObservation {
  if (pageAgentObservationBytes(input) <= maxBytes) return input;
  const originalState = input.state;
  const stateBase = {
    url: originalState.url.slice(0, 4_096),
    title: originalState.title.slice(0, 2_048),
    header: originalState.header.slice(0, 8_192),
    content: "",
    footer: originalState.footer.slice(0, 4_096),
  };
  const context = originalState.content.split("\n")
    .filter((line) => !/\*?\[\d+\]/.test(line))
    .join("\n");
  const levels = [
    { target: 0, line: 512 },
    { target: 1, line: 256 },
    { target: 2, line: 128 },
    { target: 3, line: 64 },
  ];
  for (const level of levels) {
    const targets = input.targets.map((target) => compactTarget(target, level.target));
    const catalog = interactiveCatalog(originalState.content, targets, level.line);
    const notice = "[Page content compacted; every operable index is retained below.]";
    const contentFor = (contextLength: number) => [notice, context.slice(0, contextLength), catalog].filter(Boolean).join("\n");
    let candidate: PageAgentObservation = { ...input, state: { ...stateBase, content: contentFor(0) }, targets };
    if (pageAgentObservationBytes(candidate) > maxBytes) continue;
    let low = 0;
    let high = context.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const next = { ...candidate, state: { ...stateBase, content: contentFor(middle) } };
      if (pageAgentObservationBytes(next) <= maxBytes) {
        candidate = next;
        low = middle;
      } else high = middle - 1;
    }
    if (pageAgentObservationBytes(candidate) <= maxBytes) return candidate;
  }
  throw new Error(`page_agent_observation_too_large:${input.targets.length}`);
}

function safePath(element: HTMLElement) {
  if (!(element instanceof HTMLAnchorElement) || !element.href) return undefined;
  try {
    const url = new URL(element.href, location.href);
    return url.origin === location.origin ? `${url.pathname}${url.search}`.slice(0, 500) : url.pathname.slice(0, 500);
  } catch { return undefined; }
}

function formSignature(element: HTMLElement) {
  const form = element instanceof HTMLFormElement ? element : element.closest("form");
  if (!form) return undefined;
  return stableHash([
    form.id,
    form.getAttribute("name"),
    form.getAttribute("action"),
    form.getAttribute("method"),
    ...Array.from(form.elements).slice(0, 20).map((item) => item.getAttribute("name") || item.getAttribute("type") || item.tagName),
  ].map(String).join("|"));
}

function accessibleName(element: HTMLElement) {
  const labelledBy = element.getAttribute("aria-labelledby");
  const labelledText = labelledBy
    ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ")
    : "";
  const explicitLabel = element.id
    ? Array.from(document.querySelectorAll<HTMLLabelElement>("label[for]")).find((label) => label.htmlFor === element.id)?.textContent
    : undefined;
  return compactText(
    element.getAttribute("aria-label")
      || labelledText
      || explicitLabel
      || (element.closest("label")?.textContent)
      || (element instanceof HTMLInputElement ? element.placeholder : "")
      || element.textContent,
    240,
  ) || undefined;
}

/**
 * @page-agent/page-controller intentionally prefers a compact top-layer
 * projection.  Sticky headers and other out-of-flow forms can therefore be
 * present in selectorMap but absent from BrowserState.content.  That is a
 * dangerous lossy projection for parameter-binding goals: the model cannot
 * select the real input and may click a pre-existing matching product.
 * Re-introduce every omitted form control with its original selector index so
 * the model and action executor share one address space.
 */
function appendMissingInteractiveControls(state: BrowserState, selectorMap: Map<number, SelectorNode>) {
  const knownIndexes = new Set<number>();
  for (const match of state.content.matchAll(/\*?\[(\d+)\]/g)) knownIndexes.add(Number(match[1]));
  const lines: string[] = [];
  for (const [index, node] of selectorMap) {
    const element = node.ref;
    if (!(element instanceof HTMLElement)) continue;
    const tag = element.tagName.toLowerCase();
    if (!/(?:input|textarea|select|button)/.test(tag) || knownIndexes.has(index)) continue;
    const label = accessibleName(element);
    const placeholder = element.getAttribute("placeholder") || undefined;
    const name = element.getAttribute("name") || undefined;
    const type = element.getAttribute("type") || (tag === "input" ? "text" : undefined);
    const descriptor = [label, placeholder && `placeholder=${placeholder}`, name && `name=${name}`]
      .filter(Boolean)
      .join(" · ") || tag;
    lines.push(`*[${index}]<${tag}${type ? ` type=${type}` : ""}>${descriptor}`);
  }
  const menuItems: string[] = [];
  for (const [index, node] of selectorMap) {
    const element = node.ref;
    if (!(element instanceof HTMLElement) || !isVisibleMenuItem(element)) continue;
    if (knownIndexes.has(index)) continue;
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role") || undefined;
    const label = accessibleName(element);
    const href = safePath(element);
    const descriptor = [label, href && `href=${href}`].filter(Boolean).join(" · ") || tag;
    menuItems.push(`*[${index}]<${tag}${role ? ` role=${role}` : ""}>${descriptor}`);
  }
  if (!lines.length && !menuItems.length) return state;
  const sections = [
    lines.length ? `可用表单控件（保留原始操作索引）：\n${lines.join("\n")}` : "",
    menuItems.length ? `当前可见菜单项（必须点击具体项，不要点击菜单容器）：\n${menuItems.join("\n")}` : "",
  ].filter(Boolean);
  return {
    ...state,
    content: `${state.content}\n\n${sections.join("\n\n")}`,
  };
}

function isVisibleMenuItem(element: HTMLElement) {
  if (element.getAttribute("aria-hidden") === "true") return false;
  if (!element.matches("a[href],[role=menuitem],[role=option]")) return false;
  if (!element.closest("[role=menu],.dropdown-menu,[role=listbox]")) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function augmentSelectorMapWithVisibleControls(selectorMap: Map<number, SelectorNode>) {
  // Keep this guard limited to the DOM API we actually use.  Some embedded
  // browser contexts expose querySelectorAll on `document` but do not expose
  // getComputedStyle as a global (for example an isolated iframe realm).
  // Requiring the latter would silently disable the repair and drop search
  // inputs from BrowserState again.
  if (typeof document.querySelectorAll !== "function") return;
  const known = new Set<HTMLElement>([...selectorMap.values()].flatMap((node) => node.ref instanceof HTMLElement ? [node.ref] : []));
  let nextIndex = Math.max(-1, ...selectorMap.keys()) + 1;
  for (const element of document.querySelectorAll<HTMLElement>("input,textarea,select,button")) {
    // Keep the selector addressable even when a sticky/fixed control is
    // temporarily outside the viewport. The action layer still performs its
    // own stale/sensitive checks; dropping it here is the lossy projection we
    // are explicitly repairing.
    if (known.has(element) || element.hasAttribute("disabled") || element.getAttribute("aria-hidden") === "true") continue;
    while (selectorMap.has(nextIndex)) nextIndex += 1;
    selectorMap.set(nextIndex, { ref: element, tagName: element.tagName.toLowerCase(), attributes: {} });
    known.add(element);
    nextIndex += 1;
  }
  // The upstream controller can compress a Bootstrap/custom dropdown to its
  // wrapper (`role=menu`) and omit the concrete anchors inside it. Those
  // anchors are the only actionable targets for sorting/filtering. Add only
  // visible items from a menu/listbox so product-card links do not flood the
  // model projection.
  for (const element of document.querySelectorAll<HTMLElement>("a[href],[role=menuitem],[role=option]")) {
    if (known.has(element) || !isVisibleMenuItem(element)) continue;
    while (selectorMap.has(nextIndex)) nextIndex += 1;
    selectorMap.set(nextIndex, { ref: element, tagName: element.tagName.toLowerCase(), attributes: {} });
    known.add(element);
    nextIndex += 1;
  }
}

function targetFor(observationId: string, index: number, node: SelectorNode, element: HTMLElement): StableTargetRef {
  const role = compactText(element.getAttribute("role") || node.attributes?.role || "", 80) || undefined;
  const name = accessibleName(element);
  const controlType = compactText(
    element instanceof HTMLInputElement ? element.type : element.getAttribute("type") || (node.tagName || element.tagName).toLowerCase(),
    80,
  ) || undefined;
  const hrefPath = safePath(element);
  const signature = formSignature(element);
  const nearbyText = compactText(element.closest("label,fieldset,li,tr,[role=group]")?.textContent, 320) || undefined;
  return {
    observationId,
    index,
    semanticId: stableHash([role, name, controlType, signature, hrefPath, nearbyText].map(String).join("|")),
    role,
    accessibleName: name ? sanitizePageAgentText(name) : undefined,
    controlType,
    formSignature: signature,
    hrefPath: hrefPath ? sanitizePageAgentUrl(hrefPath) : undefined,
    nearbyText: nearbyText ? sanitizePageAgentText(nearbyText) : undefined,
  };
}

/**
 * PageAgent calls getBrowserState exactly once for each model turn. This adapter
 * captures that exact projected object together with an immutable index map so
 * the later action receipt cannot drift to a second DOM extraction.
 */
export class SiteAgentPageController extends PageController {
  private readonly context: ObservationContext;
  private readonly projectState: (state: BrowserState) => BrowserState;
  private readonly onObservation?: Options["onObservation"];
  private readonly onMetric?: Options["onMetric"];
  private activeTurn = -1;
  private captures = new Map<number, TurnCapture>();
  private latestCapture?: TurnCapture;
  private turnOffset = 0;
  private actionBoundary = true;
  private pendingObservations = new Set<Promise<void>>();
  private observationError?: unknown;

  constructor(options: Options) {
    const { context, projectState, initialSeed, onObservation, onMetric, ...controllerOptions } = options;
    super(controllerOptions);
    this.context = context;
    this.projectState = projectState || ((state) => state);
    this.onObservation = onObservation;
    this.onMetric = onMetric;
    if (initialSeed?.observation.documentId === context.documentId
      && initialSeed.observation.pageEpoch === (context.pageEpoch || 1)) {
      this.latestCapture = initialSeed;
      this.turnOffset = initialSeed.observation.turnIndex;
      this.actionBoundary = false;
      this.restoreSelectorState(initialSeed);
    }
  }

  private restoreSelectorState(seed: SiteAgentPageControllerSeed) {
    const controller = this as unknown as {
      selectorMap: Map<number, SelectorNode>;
      elementTextMap: Map<number, string>;
      simplifiedHTML: string;
      lastTimeUpdate: number;
      isIndexed: boolean;
    };
    controller.selectorMap = new Map(seed.selectorMap);
    controller.elementTextMap = new Map(seed.elementTextMap);
    controller.simplifiedHTML = seed.state.content;
    controller.lastTimeUpdate = Date.parse(seed.observation.capturedAt) || Date.now();
    controller.isIndexed = true;
  }

  beginTurn(turnIndex: number) {
    this.activeTurn = turnIndex;
  }

  markActionBoundary() {
    this.actionBoundary = true;
  }

  cancelActionBoundary() {
    this.actionBoundary = false;
  }

  async getBrowserState(): Promise<BrowserState> {
    if (this.activeTurn < 0) throw new Error("page_agent_turn_not_started");
    const existing = this.captures.get(this.activeTurn);
    if (existing) return existing.state;
    if (!this.actionBoundary && this.latestCapture) {
      this.captures.set(this.activeTurn, this.latestCapture);
      return this.latestCapture.state;
    }

    const rawStartedAt = Date.now();
    const raw = await super.getBrowserState();
    const rawSelectorMap = (this as unknown as { selectorMap?: Map<number, SelectorNode> }).selectorMap;
    if (!(rawSelectorMap instanceof Map)) throw new Error("page_agent_selector_map_unavailable");
    augmentSelectorMapWithVisibleControls(rawSelectorMap);
    const projectStartedAt = Date.now();
    const projectedState = sanitizePageAgentBrowserState(this.projectState(appendMissingInteractiveControls(raw, rawSelectorMap)));
    const observationId = uid("page_observation");
    const rawElementTextMap = (this as unknown as { elementTextMap?: Map<number, string> }).elementTextMap;
    const domNodeCount = document.getElementsByTagName("*").length;
    const formControlIndexes = [...rawSelectorMap.entries()]
      .filter(([, node]) => /^(?:input|textarea|select|button)$/.test((node.tagName || "").toLowerCase()))
      .map(([index]) => index);
    const stateFormControlIndexes = [...raw.content.matchAll(/\*?\[(\d+)\]<(?:input|textarea|select|button)\b/gi)]
      .map((match) => Number(match[1]));
    this.onMetric?.("observe_raw", rawStartedAt, {
      domNodeCount,
      interactiveCount: rawSelectorMap.size,
      formControlCount: formControlIndexes.length,
      formControlIndexes,
      stateFormControlIndexes,
      stateBytes: jsonBytes(raw),
    });
    const elements = new Map<number, HTMLElement>();
    const rawTargets = new Map<number, StableTargetRef>();
    for (const [index, node] of rawSelectorMap) {
      if (!(node.ref instanceof HTMLElement)) continue;
      elements.set(index, node.ref);
      rawTargets.set(index, targetFor(observationId, index, node, node.ref));
    }
    const capturedAt = new Date();
    const previousObservation = this.latestCapture?.observation;
    const pageEpoch = this.context.pageEpoch || 1;
    const chain = pageAgentObservationChain(previousObservation, this.context.documentId, pageEpoch);
    let observation: PageAgentObservation = {
      schemaVersion: "page-agent-observation.v1",
      id: observationId,
      siteAgentId: this.context.siteAgentId,
      runId: this.context.runId,
      episodeId: this.context.episodeId,
      browserSessionId: this.context.browserSessionId,
      documentId: this.context.documentId,
      pageEpoch,
      // PageAgent step indexes restart when a correction round creates a new
      // core instance. Preserve the local model-turn meaning while offsetting
      // the new core past the seeded observation.
      turnIndex: this.activeTurn + this.turnOffset,
      ...chain,
      state: projectedState,
      targets: [...rawTargets.values()],
      // Reserve the final digest width so the byte bound remains exact after
      // hashing (the canonical hash payload excludes this derived field).
      sha256: "0".repeat(64),
      producer: {
        controller: "@page-agent/page-controller",
        controllerVersion: CONTROLLER_VERSION,
        projection: "user-agent-adaptive",
        projectionVersion: PROJECTION_VERSION,
      },
      capturedAt: capturedAt.toISOString(),
      expiresAt: new Date(capturedAt.getTime() + PAGE_AGENT_OBSERVATION_TTL_MS).toISOString(),
    };
    observation = boundPageAgentObservation(observation);
    const state = observation.state;
    const targets = new Map(observation.targets.map((target) => [target.index, target]));
    this.onMetric?.("observe_project", projectStartedAt, {
      domNodeCount,
      interactiveCount: targets.size,
      stateBytes: jsonBytes(state),
      observationBytes: pageAgentObservationBytes(observation),
    });
    // Use the same canonicalizer as ingestion. The hash covers every immutable
    // evidence field and deliberately excludes only sha256/expiresAt.
    observation.sha256 = await pageObservationSha256(observation);
    if (pageAgentObservationBytes(observation) > PAGE_AGENT_OBSERVATION_MAX_BYTES) {
      throw new Error("page_agent_observation_size_invariant");
    }
    const capture = {
      state,
      observation,
      elements,
      targets,
      selectorMap: new Map(rawSelectorMap),
      elementTextMap: rawElementTextMap instanceof Map ? new Map(rawElementTextMap) : new Map<number, string>(),
    };
    this.captures.set(this.activeTurn, capture);
    this.latestCapture = capture;
    this.actionBoundary = false;
    if (this.onObservation) {
      const pending = Promise.resolve(this.onObservation(observation))
        .catch((error) => { this.observationError ||= error; });
      this.pendingObservations.add(pending);
      void pending.finally(() => this.pendingObservations.delete(pending));
    }
    return state;
  }

  stateForTurn(turnIndex: number) {
    return this.captures.get(turnIndex)?.state;
  }

  observationForTurn(turnIndex: number) {
    return this.captures.get(turnIndex)?.observation;
  }

  observationRefForTurn(turnIndex: number): PageObservationRef | undefined {
    const observation = this.observationForTurn(turnIndex);
    return observation && {
      id: observation.id,
      pageEpoch: observation.pageEpoch,
      documentId: observation.documentId,
      turnIndex: observation.turnIndex,
      kind: observation.kind,
      sha256: observation.sha256,
    };
  }

  targetForTurn(turnIndex: number, index: number) {
    return this.captures.get(turnIndex)?.targets.get(index);
  }

  orderedTargetsForTurn(turnIndex: number) {
    return [...(this.captures.get(turnIndex)?.targets.values() || [])].sort((left, right) => left.index - right.index);
  }

  elementForTurn(turnIndex: number, index: number) {
    const element = this.captures.get(turnIndex)?.elements.get(index);
    if (!element || !element.isConnected) throw new Error(`page_agent_target_stale:${index}`);
    return element;
  }

  releaseTurn(turnIndex: number) {
    this.captures.delete(turnIndex);
    if (this.activeTurn === turnIndex) this.activeTurn = -1;
  }

  exportSeed(): SiteAgentPageControllerSeed | undefined {
    if (!this.latestCapture) return undefined;
    return {
      ...this.latestCapture,
      elements: new Map(this.latestCapture.elements),
      targets: new Map(this.latestCapture.targets),
      selectorMap: new Map(this.latestCapture.selectorMap),
      elementTextMap: new Map(this.latestCapture.elementTextMap),
    };
  }

  /** Capture an evidence-only terminal state when no subsequent model turn exists. */
  async captureTerminalObservation(turnIndex: number) {
    this.beginTurn(turnIndex);
    await this.getBrowserState();
    return this.observationForTurn(turnIndex);
  }

  async drainObservations() {
    await Promise.allSettled([...this.pendingObservations]);
    if (this.observationError) throw this.observationError;
  }
}
