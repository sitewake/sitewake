"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../lib/i18n";
import type { DomMutationOp, DomReplayChunk, DomReplayFrame, SerializedNode } from "../lib/site-knowledge/protocol";

/**
 * Original-DOM replay player. It rebuilds the captured page inside a
 * script-disabled, same-origin sandboxed iframe and replays the recorded
 * mutation + interaction stream with a scrubber and cursor overlay. This is the
 * true "what the page looked like" evidence view for the Capability Center;
 * it renders both user Episodes and AI coding Runs (they share DomReplayChunk).
 *
 * Security: the iframe uses `sandbox="allow-same-origin"` with NO `allow-scripts`,
 * so captured markup can never execute. Event-handler attributes were already
 * stripped at capture time, and sensitive control values were masked. Nested
 * document embeds are neutralised while rebuilding.
 */

const NEUTRALISED_TAGS = new Set(["script", "iframe", "object", "embed", "frame", "noscript"]);
const MAX_PLAY_GAP_MS = 1200;

function flattenFrames(chunks: DomReplayChunk[]): DomReplayFrame[] {
  return chunks
    .flatMap((chunk) => chunk.frames)
    .filter((frame, index, all) => all.findIndex((item) => item.seq === frame.seq) === index)
    .sort((left, right) => left.seq - right.seq);
}

function buildNode(doc: Document, node: SerializedNode, map: Map<number, Node>): Node | null {
  if (node.type === "text") {
    const text = doc.createTextNode(node.text || "");
    map.set(node.id, text);
    return text;
  }
  if (node.type === "comment") {
    const comment = doc.createComment(node.text || "");
    map.set(node.id, comment);
    return comment;
  }
  if (node.type !== "element" || !node.tag) return null;
  const tag = node.tag.toLowerCase();
  // Never let nested executable or navigable embeds come alive during replay.
  const safeTag = NEUTRALISED_TAGS.has(tag) ? "template" : tag;
  let element: Element;
  try { element = doc.createElement(safeTag); } catch { element = doc.createElement("div"); }
  for (const [key, value] of Object.entries(node.attrs || {})) {
    if (key.startsWith("on")) continue;
    try { element.setAttribute(key, value); } catch { /* ignore invalid attribute names */ }
  }
  if (node.masked) element.setAttribute("data-sitewake-masked", "1");
  if (safeTag !== "template") {
    for (const child of node.children || []) {
      const built = buildNode(doc, child, map);
      if (built) element.appendChild(built);
    }
  }
  map.set(node.id, element);
  return element;
}

function applyMutations(doc: Document, mutations: DomMutationOp[], map: Map<number, Node>) {
  for (const mutation of mutations) {
    if (mutation.t === "add") {
      const parent = map.get(mutation.parent);
      if (!parent) continue;
      const built = buildNode(doc, mutation.node, map);
      if (!built) continue;
      const next = mutation.next !== null ? map.get(mutation.next) ?? null : null;
      try { parent.insertBefore(built, next && next.parentNode === parent ? next : null); } catch { /* detached */ }
    } else if (mutation.t === "remove") {
      const node = map.get(mutation.id);
      node?.parentNode?.removeChild(node);
    } else if (mutation.t === "attr") {
      const node = map.get(mutation.id);
      if (!(node instanceof Element)) continue;
      for (const [key, value] of Object.entries(mutation.attrs)) {
        if (key.startsWith("on")) continue;
        try { if (value === null) node.removeAttribute(key); else node.setAttribute(key, value); } catch { /* ignore */ }
      }
    } else if (mutation.t === "text") {
      const node = map.get(mutation.id);
      if (node) node.textContent = mutation.value;
    }
  }
}

type PlayerState = { url?: string; cursor?: { x: number; y: number; visible: boolean } };

function applySignal(doc: Document, frame: DomReplayFrame, map: Map<number, Node>, state: PlayerState) {
  if (frame.kind === "scroll" && frame.scroll) {
    const node = map.get(frame.scroll.id);
    if (node instanceof HTMLElement && node !== doc.documentElement && node !== doc.body) {
      node.scrollLeft = frame.scroll.x; node.scrollTop = frame.scroll.y;
    } else {
      doc.defaultView?.scrollTo(frame.scroll.x, frame.scroll.y);
    }
  } else if (frame.kind === "input" && frame.input) {
    const node = map.get(frame.input.id);
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) node.value = frame.input.value;
    else if (node instanceof HTMLSelectElement) node.value = frame.input.value;
    else if (node instanceof HTMLElement) node.textContent = frame.input.value;
  } else if (frame.kind === "pointer" && frame.pointer) {
    state.cursor = { x: frame.pointer.x, y: frame.pointer.y, visible: frame.pointer.type !== "up" };
  } else if (frame.kind === "url" && frame.url) {
    state.url = frame.url;
  }
}

function frameLabel(frame: DomReplayFrame): string {
  const copy = t().capability.replayFrame;
  switch (frame.kind) {
    case "full": return copy.full;
    case "incremental": return copy.incremental(frame.mutations?.length || 0);
    case "scroll": return copy.scroll;
    case "input": return frame.input?.masked ? copy.inputMasked : copy.input;
    case "pointer": return frame.pointer?.type === "down" ? copy.pointerDown : frame.pointer?.type === "up" ? copy.pointerUp : copy.pointerMove;
    case "viewport": return copy.viewport;
    case "url": return copy.url;
    default: return frame.kind;
  }
}

export function DomReplayPlayer({ chunks, height = 300 }: { chunks: DomReplayChunk[]; height?: number }) {
  const frames = useMemo(() => flattenFrames(chunks), [chunks]);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map<number, Node>>(new Map());
  const lastIndexRef = useRef(-1);
  const stateRef = useRef<PlayerState>({});

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [scale, setScale] = useState(1);
  const [url, setUrl] = useState<string | undefined>();
  const [cursor, setCursor] = useState<PlayerState["cursor"]>();

  const logical = useMemo(() => {
    const viewport = frames.find((frame) => frame.kind === "viewport" && frame.viewport)?.viewport;
    return { w: viewport?.w || 1280, h: viewport?.h || 800 };
  }, [frames]);

  const lastFullBefore = useCallback((target: number) => {
    for (let cursorIndex = target; cursorIndex >= 0; cursorIndex -= 1) if (frames[cursorIndex]?.kind === "full") return cursorIndex;
    return frames.findIndex((frame) => frame.kind === "full");
  }, [frames]);

  const renderUpTo = useCallback((target: number) => {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    if (!doc || !frames.length) return;
    const clamped = Math.max(0, Math.min(target, frames.length - 1));
    const incremental = clamped === lastIndexRef.current + 1 && frames[clamped]?.kind !== "full" && lastIndexRef.current >= 0;
    if (!incremental) {
      const fullIndex = lastFullBefore(clamped);
      if (fullIndex < 0) return;
      doc.open(); doc.write("<!doctype html><html><head></head><body></body></html>"); doc.close();
      const map = new Map<number, Node>();
      mapRef.current = map;
      const built = buildNode(doc, frames[fullIndex].full as SerializedNode, map);
      if (built instanceof Element) {
        try { doc.replaceChild(built, doc.documentElement); } catch { doc.documentElement.replaceWith(built); }
        const head = doc.querySelector("head") || doc.documentElement.insertBefore(doc.createElement("head"), doc.documentElement.firstChild);
        const base = doc.createElement("base");
        base.setAttribute("href", frames[fullIndex].url || stateRef.current.url || location.href);
        head.insertBefore(base, head.firstChild);
      }
      stateRef.current = { url: frames[fullIndex].url };
      for (let cursorIndex = fullIndex + 1; cursorIndex <= clamped; cursorIndex += 1) {
        const frame = frames[cursorIndex];
        if (frame.kind === "incremental" && frame.mutations) applyMutations(doc, frame.mutations, mapRef.current);
        else applySignal(doc, frame, mapRef.current, stateRef.current);
      }
    } else {
      const frame = frames[clamped];
      if (frame.kind === "incremental" && frame.mutations) applyMutations(doc, frame.mutations, mapRef.current);
      else applySignal(doc, frame, mapRef.current, stateRef.current);
    }
    lastIndexRef.current = clamped;
    setUrl(stateRef.current.url);
    setCursor(stateRef.current.cursor);
  }, [frames, lastFullBefore]);

  // Rebuild on index change.
  useEffect(() => { renderUpTo(index); }, [index, renderUpTo]);

  // Reset when the source chunks change.
  useEffect(() => {
    lastIndexRef.current = -1;
    const reset = window.setTimeout(() => { setIndex(0); setPlaying(false); renderUpTo(0); }, 0);
    return () => window.clearTimeout(reset);
  }, [frames, renderUpTo]);

  // Fit the logical viewport into the available width.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setScale(Math.min(1, stage.clientWidth / logical.w)));
    observer.observe(stage);
    setScale(Math.min(1, stage.clientWidth / logical.w));
    return () => observer.disconnect();
  }, [logical.w]);

  // Playback ticker driven by captured timestamps.
  useEffect(() => {
    if (!playing || !frames.length) return;
    if (index >= frames.length - 1) return;
    const current = Date.parse(frames[index].at);
    const next = Date.parse(frames[index + 1].at);
    const gap = Math.max(120, Math.min(MAX_PLAY_GAP_MS, (Number.isFinite(next - current) ? next - current : 400)));
    const timer = window.setTimeout(() => setIndex((value) => {
      const nextIndex = Math.min(frames.length - 1, value + 1);
      if (nextIndex >= frames.length - 1) setPlaying(false);
      return nextIndex;
    }), gap / speed);
    return () => window.clearTimeout(timer);
  }, [playing, index, frames, speed]);

  const copy = t().capability.replayFrame;
  if (!frames.length) {
    return (
      <div className="sw-domplayer sw-domplayer-empty">
        <i>◎</i>
        <b>{copy.emptyTitle}</b>
        <p>{copy.emptyBody}</p>
      </div>
    );
  }

  const active = frames[index];
  const stageHeight = Math.min(height, Math.round(logical.h * scale));

  return (
    <div className="sw-domplayer">
      <div className="sw-domplayer-bar">
        <span className="sw-domplayer-dots"><i /><i /><i /></span>
        <code>{url || "—"}</code>
        <em>{copy.frameCount(frames.length)}</em>
      </div>
      <div className="sw-domplayer-stage" ref={stageRef} style={{ height: stageHeight || height }}>
        <div className="sw-domplayer-scaler" style={{ width: logical.w, height: logical.h, transform: `scale(${scale})` }}>
          <iframe ref={iframeRef} sandbox="allow-same-origin" title="original-dom-replay" style={{ width: logical.w, height: logical.h, border: 0, background: "#fff" }} />
          {cursor?.visible && <span className="sw-domplayer-cursor" style={{ left: cursor.x, top: cursor.y }} />}
        </div>
      </div>
      <div className="sw-domplayer-controls">
        <button type="button" className="sw-domplayer-play" onClick={() => setPlaying((value) => !value)}>{playing ? "⏸" : "▶"}</button>
        <input type="range" min={0} max={frames.length - 1} value={index} onChange={(event) => { setPlaying(false); setIndex(Number(event.target.value)); }} />
        <span className="sw-domplayer-meta"><b>{index + 1}/{frames.length}</b><small>{frameLabel(active)}</small></span>
        <button type="button" className="sw-domplayer-speed" onClick={() => setSpeed((value) => (value >= 4 ? 1 : value * 2))}>{speed}×</button>
      </div>
    </div>
  );
}
