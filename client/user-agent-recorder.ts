import type { DomMutationOp, DomReplayChunk, DomReplayFrame, SerializedNode } from "../lib/site-knowledge/protocol";
import { browserSessionId, documentId, isSensitiveElement, normalizedText, sensitiveControlKind, uid } from "./user-agent-shared";

/**
 * rrweb/Clarity-style original-DOM recorder. It captures one `full` frame then
 * streams incremental mutations plus low-frequency interaction signals so the
 * Capability Center can replay exactly what the page looked like during an
 * Episode (or an AI coding Run). This is *evidence* — it is never observed by
 * the Agent per step and never enters a Release.
 *
 * Safety: sensitive controls (password/otp/webauthn) are masked at capture time
 * and their live values are never emitted. Payloads are chunked and capped so a
 * runaway page cannot flood storage.
 */

const MAX_NODES_PER_FULL = 8000;
const FLUSH_FRAME_COUNT = 48;
const FLUSH_INTERVAL_MS = 4000;
const MAX_ATTR_LEN = 2000;
const MAX_TEXT_LEN = 4000;
const POINTER_SAMPLE_MS = 200;
const SCROLL_SAMPLE_MS = 150;

export type DomReplayRecorderHandle = {
  /** Flush any buffered frames without stopping capture. */
  flush(): Promise<void>;
  /** Stop capture and flush the final chunk (best-effort on unload). */
  stop(): Promise<void>;
};

type RecorderOptions = {
  siteAgentId: string;
  endpoint: string;
  runId: string;
  runToken: string;
  episodeId?: string;
  sessionId?: string;
  documentId?: string;
  /** Optional label describing what produced this track (episode/run/manual). */
  origin?: string;
};

function endpointUrl(endpoint: string, path: string) {
  return endpoint ? `${endpoint.replace(/\/$/, "")}${path}` : path;
}

function truncate(value: string | null | undefined, max: number) {
  const text = value ?? "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * A no-op recorder used whenever the environment cannot support capture (no
 * DOM, missing MutationObserver). Callers always get a valid handle.
 */
function inertHandle(): DomReplayRecorderHandle {
  return { async flush() {}, async stop() {} };
}

function authenticationSurfaceDetected() {
  if (typeof document === "undefined") return false;
  if (document.querySelector('input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"],input[autocomplete="one-time-code"],[data-auth-sensitive="true"]')) return true;
  const authPath = /(?:^|\/)(?:login|log-in|signin|sign-in|auth|oauth|sso|verify|mfa|2fa)(?:\/|$)/iu.test(location.pathname);
  return authPath && Boolean(document.querySelector("form,input,button"));
}

export function startDomReplayRecorder(options: RecorderOptions): DomReplayRecorderHandle {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined" || !document.documentElement) {
    return inertHandle();
  }
  // Authentication DOM is never a debug artifact. Sensitive controls remain
  // masked elsewhere, but an auth page can expose account identifiers and
  // recovery context even without a populated password field.
  if (authenticationSurfaceDetected()) return inertHandle();

  const sessionId = options.sessionId || browserSessionId();
  const docId = options.documentId || documentId();
  const origin = options.origin || (options.runId ? "run" : options.episodeId ? "episode" : "manual");

  const nodeIds = new WeakMap<Node, number>();
  let nodeCounter = 0;
  const idOf = (node: Node): number => {
    let id = nodeIds.get(node);
    if (id === undefined) { id = ++nodeCounter; nodeIds.set(node, id); }
    return id;
  };
  const knownId = (node: Node | null | undefined): number | null => (node ? nodeIds.get(node) ?? null : null);

  let seq = 0;
  let frames: DomReplayFrame[] = [];
  let stopped = false;
  let captureBlocked = false;
  const nextSeq = () => ++seq;

  function elementAttrs(element: Element, masked: boolean): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name;
      // Drop event handlers; the replay iframe is sandboxed but we keep the
      // captured DOM inert regardless of how it is later rendered.
      if (name.startsWith("on")) continue;
      if (masked && (name === "value" || name === "placeholder")) continue;
      attrs[name] = truncate(attribute.value, MAX_ATTR_LEN);
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (masked) attrs.value = "";
      else if (element.value) attrs.value = truncate(element.value, MAX_ATTR_LEN);
    }
    return attrs;
  }

  function serialize(node: Node, budget: { count: number }): SerializedNode | null {
    if (budget.count >= MAX_NODES_PER_FULL) return null;
    budget.count += 1;
    if (node.nodeType === Node.TEXT_NODE) {
      return { id: idOf(node), type: "text", text: truncate(node.textContent, MAX_TEXT_LEN) };
    }
    if (node.nodeType === Node.COMMENT_NODE) {
      return { id: idOf(node), type: "comment", text: truncate(node.textContent, 400) };
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    // Never execute captured scripts; keep the tag as an inert placeholder.
    if (tag === "script") return { id: idOf(node), type: "element", tag, attrs: {}, children: [] };
    const masked = isSensitiveElement(element) || Boolean(sensitiveControlKind(element));
    const serialized: SerializedNode = { id: idOf(node), type: "element", tag, attrs: elementAttrs(element, masked) };
    if (masked) serialized.masked = true;
    const children: SerializedNode[] = [];
    for (const child of Array.from(element.childNodes)) {
      if (budget.count >= MAX_NODES_PER_FULL) break;
      const childNode = serialize(child, budget);
      if (childNode) children.push(childNode);
    }
    serialized.children = children;
    return serialized;
  }

  function pushFrame(frame: Omit<DomReplayFrame, "seq" | "at">) {
    if (captureBlocked) return;
    frames.push({ seq: nextSeq(), at: new Date().toISOString(), ...frame });
    if (frames.length >= FLUSH_FRAME_COUNT) void flush();
  }

  // ---- initial full frame ----
  const full = serialize(document.documentElement, { count: 0 });
  if (full) pushFrame({ kind: "full", full, url: location.href });

  // ---- mutation stream ----
  const pending: DomMutationOp[] = [];
  let mutationScheduled = false;
  const flushMutations = () => {
    mutationScheduled = false;
    if (!pending.length) return;
    const mutations = pending.splice(0, pending.length);
    pushFrame({ kind: "incremental", mutations });
  };
  const scheduleMutationFlush = () => {
    if (mutationScheduled) return;
    mutationScheduled = true;
    (typeof requestAnimationFrame === "function" ? requestAnimationFrame : ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 16)))(() => flushMutations());
  };

  const observer = new MutationObserver((records) => {
    if (authenticationSurfaceDetected()) {
      captureBlocked = true;
      frames = [];
      observer.disconnect();
      return;
    }
    for (const record of records) {
      if (record.type === "attributes") {
        const target = record.target as Element;
        const id = knownId(target);
        if (id === null) continue;
        const name = record.attributeName || "";
        if (!name || name.startsWith("on")) continue;
        const masked = isSensitiveElement(target) || Boolean(sensitiveControlKind(target));
        if (masked && (name === "value" || name === "placeholder")) continue;
        pending.push({ t: "attr", id, attrs: { [name]: target.getAttribute(name) === null ? null : truncate(target.getAttribute(name), MAX_ATTR_LEN) } });
      } else if (record.type === "characterData") {
        const id = knownId(record.target);
        if (id === null) continue;
        pending.push({ t: "text", id, value: truncate(record.target.textContent, MAX_TEXT_LEN) });
      } else if (record.type === "childList") {
        for (const removed of Array.from(record.removedNodes)) {
          const id = knownId(removed);
          if (id !== null) pending.push({ t: "remove", id });
        }
        if (record.addedNodes.length) {
          const parent = knownId(record.target);
          if (parent === null) continue;
          for (const added of Array.from(record.addedNodes)) {
            const serialized = serialize(added, { count: 0 });
            if (!serialized) continue;
            pending.push({ t: "add", parent, next: knownId(record.nextSibling), node: serialized });
          }
        }
      }
    }
    if (pending.length) scheduleMutationFlush();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });

  // ---- low-frequency interaction signals ----
  let lastPointer = 0;
  let lastScroll = 0;
  const onPointer = (event: PointerEvent | MouseEvent) => {
    const type = event.type === "pointerdown" || event.type === "mousedown" ? "down" : event.type === "pointerup" || event.type === "mouseup" ? "up" : "move";
    const now = Date.now();
    if (type === "move" && now - lastPointer < POINTER_SAMPLE_MS) return;
    if (type === "move") lastPointer = now;
    pushFrame({ kind: "pointer", pointer: { x: Math.round(event.clientX), y: Math.round(event.clientY), type } });
  };
  const onScroll = (event: Event) => {
    const now = Date.now();
    if (now - lastScroll < SCROLL_SAMPLE_MS) return;
    lastScroll = now;
    const target = event.target === document ? document.scrollingElement || document.documentElement : (event.target as Element);
    const id = knownId(target) ?? 1;
    const el = target as HTMLElement;
    pushFrame({ kind: "scroll", scroll: { id, x: Math.round(el.scrollLeft || window.scrollX), y: Math.round(el.scrollTop || window.scrollY) } });
  };
  const onInput = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const id = knownId(target);
    if (id === null) return;
    const masked = isSensitiveElement(target) || Boolean(sensitiveControlKind(target));
    const value = masked ? "" : target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ? target.value : normalizedText(target.textContent);
    pushFrame({ kind: "input", input: { id, value: truncate(value, MAX_ATTR_LEN), masked: masked || undefined } });
  };
  let lastViewport = "";
  const onViewport = () => {
    const key = `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`;
    if (key === lastViewport) return;
    lastViewport = key;
    pushFrame({ kind: "viewport", viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 } });
  };
  let lastUrl = location.href;
  const onUrl = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    pushFrame({ kind: "url", url: location.href });
  };

  onViewport();
  window.addEventListener("pointermove", onPointer, { passive: true, capture: true });
  window.addEventListener("pointerdown", onPointer, { passive: true, capture: true });
  window.addEventListener("pointerup", onPointer, { passive: true, capture: true });
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });
  window.addEventListener("input", onInput, { passive: true, capture: true });
  window.addEventListener("resize", onViewport, { passive: true });
  window.addEventListener("popstate", onUrl, { passive: true });
  window.addEventListener("hashchange", onUrl, { passive: true });
  const urlPoll = window.setInterval(onUrl, 1000);

  // ---- chunk upload ----
  async function send(chunk: DomReplayChunk, beacon: boolean) {
    const url = endpointUrl(options.endpoint, `/api/site-agents/${encodeURIComponent(options.siteAgentId)}/dom-replay`);
    const payload = JSON.stringify({ chunk });
    try {
      // sendBeacon cannot attach the AgentRun bearer token. An authenticated
      // keepalive fetch is the only best-effort unload transport we accept.
      await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${options.runToken}` }, body: payload, keepalive: beacon, credentials: "omit" });
    } catch { /* replay is best-effort evidence; never block the page */ }
  }

  async function flushInternal(beacon: boolean) {
    if (!frames.length) return;
    const batch = frames;
    frames = [];
    const chunk: DomReplayChunk = {
      id: uid("domchunk"),
      siteAgentId: options.siteAgentId,
      sessionId,
      documentId: docId,
      episodeId: options.episodeId,
      runId: options.runId,
      origin,
      seqStart: batch[0].seq,
      seqEnd: batch[batch.length - 1].seq,
      frames: batch,
      createdAt: new Date().toISOString(),
    };
    await send(chunk, beacon);
  }

  async function flush() {
    if (stopped) return;
    flushMutations();
    await flushInternal(false);
  }

  const interval = window.setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
  const onUnload = () => { flushMutations(); void flushInternal(true); };
  window.addEventListener("pagehide", onUnload);
  window.addEventListener("beforeunload", onUnload);

  async function stop() {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    window.clearInterval(interval);
    window.clearInterval(urlPoll);
    window.removeEventListener("pointermove", onPointer, { capture: true } as EventListenerOptions);
    window.removeEventListener("pointerdown", onPointer, { capture: true } as EventListenerOptions);
    window.removeEventListener("pointerup", onPointer, { capture: true } as EventListenerOptions);
    window.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
    window.removeEventListener("input", onInput, { capture: true } as EventListenerOptions);
    window.removeEventListener("resize", onViewport);
    window.removeEventListener("popstate", onUrl);
    window.removeEventListener("hashchange", onUrl);
    window.removeEventListener("pagehide", onUnload);
    window.removeEventListener("beforeunload", onUnload);
    flushMutations();
    await flushInternal(false);
  }

  return { flush, stop };
}
