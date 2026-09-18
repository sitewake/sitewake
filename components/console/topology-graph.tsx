"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AreaSummary } from "../../lib/console/knowledge-view";
import { t } from "../../lib/i18n";

/**
 * Site structure graph: two levels only, entry → sections.
 *
 * No more ELK. A star graph in a layered layout always ends up in one row, grows past
 * the container once sections multiply, and needs drag-panning. Here the column count
 * follows the container width, sections form a grid, the entry sits centered above,
 * edges run through the gutters between columns, and the graph always fits. A node
 * carries two things: its name and "indexed x / y".
 */
export const NODE_W = 204;
export const NODE_H = 72;
export const ROOT_W = 184;
export const ROOT_H = 58;
export const GAP_X = 22;
export const GAP_Y = 34;
export const PAD = 22;
/** Distance from the entry's bottom edge to the first row's top edge; the horizontal bus runs in between. */
export const BUS = 54;
/** Corner radius of edge bends. */
const CORNER = 10;

export type GraphLayout = {
  width: number;
  height: number;
  columns: number;
  root: { x: number; y: number };
  nodes: Array<{ id: string; x: number; y: number; row: number; column: number }>;
};

/** Pure: given section count and container width, computes every node's position. */
export function layoutAreas(ids: string[], containerWidth: number): GraphLayout {
  const fit = Math.floor((containerWidth - PAD * 2 + GAP_X) / (NODE_W + GAP_X));
  const columns = Math.max(1, Math.min(ids.length || 1, fit || 1));
  const rows = Math.ceil(ids.length / columns);
  const width = PAD * 2 + columns * NODE_W + (columns - 1) * GAP_X;
  const root = { x: (width - ROOT_W) / 2, y: PAD };
  const firstRowY = root.y + ROOT_H + BUS;
  const nodes = ids.map((id, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    return { id, row, column, x: PAD + column * (NODE_W + GAP_X), y: firstRowY + row * (NODE_H + GAP_Y) };
  });
  const height = rows ? firstRowY + rows * (NODE_H + GAP_Y) - GAP_Y + PAD : root.y + ROOT_H + PAD;
  return { width, height, columns, root, nodes };
}

type Point = [number, number];

/** Orthogonal polyline with rounded corners: each bend is a quadratic Bézier, and segments shorter than twice the radius shrink it. */
export function roundedPath(points: Point[], radius = CORNER): string {
  const pts = points.filter((point, index) => index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1]);
  if (pts.length < 2) return "";
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const [px, py] = pts[i - 1]; const [cx, cy] = pts[i]; const [nx, ny] = pts[i + 1];
    const before = Math.hypot(cx - px, cy - py); const after = Math.hypot(nx - cx, ny - cy);
    const r = Math.min(radius, before / 2, after / 2);
    const inX = cx - Math.sign(cx - px) * r; const inY = cy - Math.sign(cy - py) * r;
    const outX = cx + Math.sign(nx - cx) * r; const outY = cy + Math.sign(ny - cy) * r;
    d += ` L${inX} ${inY} Q${cx} ${cy} ${outX} ${outY}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  return `${d} L${lx} ${ly}`;
}

/** Edge from the entry to a section: the first row drops straight from the bus; later rows run down the gutter left of their column and enter from the side. */
export function edgePath(layout: GraphLayout, node: GraphLayout["nodes"][number]): string {
  const rootCx = layout.root.x + ROOT_W / 2;
  const rootBottom = layout.root.y + ROOT_H;
  const busY = rootBottom + BUS / 2;
  if (node.row === 0) return roundedPath([[rootCx, rootBottom], [rootCx, busY], [node.x + NODE_W / 2, busY], [node.x + NODE_W / 2, node.y]]);
  const gutterX = node.column === 0 ? PAD / 2 : node.x - GAP_X / 2;
  return roundedPath([[rootCx, rootBottom], [rootCx, busY], [gutterX, busY], [gutterX, node.y + NODE_H / 2], [node.x, node.y + NODE_H / 2]]);
}

function useContainerWidth(fallback = 880) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next && Math.abs(next - width) > 1) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [width]);
  return { ref, width };
}

const truncate = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

export function TopologyGraph({
  rootName,
  areas,
  selectedId,
  onSelectArea,
  onSelectRoot,
}: {
  rootName: string;
  areas: AreaSummary[];
  selectedId?: string;
  onSelectArea?: (id: string) => void;
  onSelectRoot?: () => void;
}) {
  const copy = t().knowledge.graph;
  const { ref, width } = useContainerWidth();
  const layout = layoutAreas(areas.map((area) => area.id), width);
  const byId = new Map(areas.map((area) => [area.id, area]));
  const activate = (handler: (() => void) | undefined) => (event: KeyboardEvent<SVGGElement>) => {
    if (!handler) return;
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); handler(); }
  };
  return (
    <div ref={ref} className="kc-map-body">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width="100%"
        style={{ maxWidth: layout.width, height: "auto", display: "block" }}
        preserveAspectRatio="xMidYMin meet"
        role="img"
        aria-label={copy.ariaLabel}
      >
        <defs>
          <filter id="kc-node-shadow" x="-10%" y="-10%" width="120%" height="140%">
            <feDropShadow dx="0" dy="1.5" stdDeviation="2" floodColor="#141521" floodOpacity="0.08" />
          </filter>
        </defs>
        <g className="sw-topology-edges">
          {layout.nodes.map((node) => <path key={node.id} d={edgePath(layout, node)} />)}
        </g>
        <g className="sw-topology-nodes">
          <g
            className="root"
            transform={`translate(${layout.root.x} ${layout.root.y})`}
            role={onSelectRoot ? "button" : undefined}
            tabIndex={onSelectRoot ? 0 : undefined}
            onClick={onSelectRoot}
            onKeyDown={activate(onSelectRoot)}
          >
            <rect className="box" width={ROOT_W} height={ROOT_H} rx="14" filter="url(#kc-node-shadow)" />
            {/* 房子图标：入口 */}
            <path className="home" d="M20 29.5 L29 21.5 L38 29.5 V37 H32 V31.5 H26 V37 H20 Z" />
            <text className="title" x="48" y="27">{truncate(rootName, 12)}</text>
            <text className="detail" x="48" y="42">{copy.entry}</text>
          </g>
          {layout.nodes.map((node) => {
            const area = byId.get(node.id);
            if (!area) return null;
            const active = area.id === selectedId;
            return (
              <g
                key={node.id}
                className={`area${active ? " active" : ""}${area.isNew ? " new" : ""}`}
                transform={`translate(${node.x} ${node.y})`}
                role="button"
                tabIndex={0}
                onClick={() => onSelectArea?.(area.id)}
                onKeyDown={activate(() => onSelectArea?.(area.id))}
              >
                <rect className="box" width={NODE_W} height={NODE_H} rx="14" filter="url(#kc-node-shadow)" />
                <circle className={`dot${area.total && area.read === area.total ? " full" : ""}`} cx="20" cy="29" r="4" />
                <text className="title" x="32" y="33">{truncate(area.name, area.isNew ? 10 : 12)}</text>
                {area.isNew && (
                  <g className="new-badge" transform={`translate(${NODE_W - 42} 16)`}>
                    <rect width="26" height="17" rx="5" />
                    <text x="13" y="12" textAnchor="middle">{t().knowledge.state.isNew}</text>
                  </g>
                )}
                <text className="detail" x="32" y={NODE_H - 22}>{copy.readOf(area.read, area.total)}</text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
