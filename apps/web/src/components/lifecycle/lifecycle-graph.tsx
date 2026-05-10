'use client';

/**
 * DAG visualization of the lifecycle.
 *
 * V2.1 phase 1 (#25) shipped a read-only view. Phase 2 (#195) adds:
 *   - Drag-to-position with snap-to-grid (10px).
 *   - Persisted positions per (project, workflow) so the layout doesn't
 *     drift across YAML version bumps.
 *   - Saved-position fallback to the BFS-by-depth auto-layout for any
 *     workflow without a saved position.
 *
 * Layout is hand-rolled — for the 5–15 workflow DAGs we expect, no
 * library is needed. Bundle stays free of `dagre` / `react-flow`.
 *
 * Phase 3 (edit-and-commit a PR against mergecrew.yaml) is tracked
 * separately on #196 — the affordances here intentionally stop at
 * positions, not topology.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LifecycleScope } from './scope';
import { saveGraphLayoutAction } from './lifecycle-actions';

interface WorkflowDef {
  id: string;
  description?: string;
  agents: string[];
  out: string[];
}

interface ParsedConfigShape {
  lifecycle: { workflows: WorkflowDef[] };
}

const NODE_W = 200;
const HEADER_H = 28;
const AGENT_H = 18;
const NODE_PAD = 12;
const COL_GAP = 80;
const ROW_GAP = 28;
const SNAP_GRID = 10;
const SAVE_DEBOUNCE_MS = 600;

interface PlacedNode {
  workflow: WorkflowDef;
  x: number;
  y: number;
  height: number;
}

function nodeHeight(w: WorkflowDef): number {
  return HEADER_H + Math.max(1, w.agents.length) * AGENT_H + NODE_PAD * 2;
}

/**
 * BFS-by-depth fallback layout. Each workflow's depth is the longest
 * predecessor path from a root. Within a depth column nodes stack
 * top-to-bottom in declaration order.
 */
function bfsLayout(workflows: WorkflowDef[]): Record<string, { x: number; y: number }> {
  const incoming = new Map<string, string[]>();
  for (const w of workflows) incoming.set(w.id, []);
  for (const w of workflows) {
    for (const next of w.out) {
      if (!incoming.has(next)) incoming.set(next, []);
      incoming.get(next)!.push(w.id);
    }
  }
  const depth = new Map<string, number>();
  let changed = true;
  let safety = workflows.length + 1;
  while (changed && safety-- > 0) {
    changed = false;
    for (const w of workflows) {
      const preds = incoming.get(w.id) ?? [];
      const d = preds.length === 0 ? 0 : Math.max(...preds.map((p) => (depth.get(p) ?? 0) + 1));
      if (depth.get(w.id) !== d) {
        depth.set(w.id, d);
        changed = true;
      }
    }
  }
  const columns = new Map<number, WorkflowDef[]>();
  for (const w of workflows) {
    const d = depth.get(w.id) ?? 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)!.push(w);
  }
  const positions: Record<string, { x: number; y: number }> = {};
  const sortedDepths = [...columns.keys()].sort((a, b) => a - b);
  const colHeights = new Map<number, number>();
  for (const d of sortedDepths) {
    let y = 0;
    for (const w of columns.get(d)!) {
      positions[w.id] = { x: d * (NODE_W + COL_GAP), y };
      y += nodeHeight(w) + ROW_GAP;
    }
    colHeights.set(d, y);
  }
  // Center each column vertically against the tallest one.
  const maxHeight = Math.max(0, ...colHeights.values());
  for (const w of workflows) {
    const d = depth.get(w.id) ?? 0;
    const colH = colHeights.get(d) ?? 0;
    const pos = positions[w.id]!;
    pos.y += (maxHeight - colH) / 2;
  }
  return positions;
}

function snap(n: number): number {
  return Math.round(n / SNAP_GRID) * SNAP_GRID;
}

export function LifecycleGraph({
  parsed,
  scope,
  initialLayout = {},
  editable = false,
}: {
  parsed: ParsedConfigShape;
  scope: LifecycleScope;
  initialLayout?: Record<string, { x: number; y: number }>;
  editable?: boolean;
}) {
  const workflows = parsed.lifecycle?.workflows ?? [];
  const projectScope = scope.kind === 'project' ? scope : null;
  const editableHere = editable && projectScope !== null;

  // BFS positions are recomputed when the workflow set changes; saved
  // positions override per-workflow.
  const fallback = useMemo(() => bfsLayout(workflows), [workflows]);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(() => {
    const merged: Record<string, { x: number; y: number }> = {};
    for (const w of workflows) {
      merged[w.id] = initialLayout[w.id] ?? fallback[w.id] ?? { x: 0, y: 0 };
    }
    return merged;
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-seed positions when the workflow set changes (e.g., a YAML save
  // added or removed one) — keep saved positions for unchanged ids,
  // pick fallback for new ones, drop ids no longer present.
  useEffect(() => {
    setPositions((prev) => {
      const next: Record<string, { x: number; y: number }> = {};
      for (const w of workflows) {
        next[w.id] = prev[w.id] ?? initialLayout[w.id] ?? fallback[w.id] ?? { x: 0, y: 0 };
      }
      return next;
    });
    // We intentionally exclude `positions` from the dep array — this
    // effect re-seeds on workflow set changes, not on every drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflows.map((w) => w.id).join('|')]);

  function persistDebounced(p: Record<string, { x: number; y: number }>) {
    if (!editableHere || !projectScope) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      setSaveError(null);
      try {
        await saveGraphLayoutAction(projectScope, p);
      } catch (e: any) {
        setSaveError(String(e?.message ?? e));
      } finally {
        setSaving(false);
      }
    }, SAVE_DEBOUNCE_MS);
  }

  // Pointer drag — captured on the SVG so the move handler still fires
  // when the cursor leaves the node rect.
  const dragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    nodeX: number;
    nodeY: number;
  } | null>(null);

  function onPointerDown(e: React.PointerEvent<SVGGElement>, id: string) {
    if (!editableHere) return;
    const pos = positions[id];
    if (!pos) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      nodeX: pos.x,
      nodeY: pos.y,
    };
  }
  function onPointerMove(e: React.PointerEvent<SVGGElement>) {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    setPositions((prev) => ({
      ...prev,
      [d.id]: { x: Math.max(0, d.nodeX + dx), y: Math.max(0, d.nodeY + dy) },
    }));
  }
  function onPointerUp(e: React.PointerEvent<SVGGElement>) {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      // releasePointerCapture throws if capture was already released —
      // benign at end-of-drag.
    }
    setPositions((prev) => {
      const cur = prev[d.id];
      if (!cur) return prev;
      const snapped = { x: snap(cur.x), y: snap(cur.y) };
      const next = { ...prev, [d.id]: snapped };
      persistDebounced(next);
      return next;
    });
    dragRef.current = null;
  }

  if (workflows.length === 0) {
    return (
      <div className="rounded border border-dashed p-6 text-sm text-zinc-500 dark:border-zinc-800">
        No workflows yet. Add one on the <strong>Workflows</strong> tab.
      </div>
    );
  }

  // Build placed-node list (for edge math) + extents from current positions.
  const placed: PlacedNode[] = workflows.map((w) => {
    const p = positions[w.id] ?? { x: 0, y: 0 };
    return { workflow: w, x: p.x, y: p.y, height: nodeHeight(w) };
  });
  const placedById = new Map(placed.map((n) => [n.workflow.id, n]));
  const maxX = Math.max(0, ...placed.map((n) => n.x + NODE_W));
  const maxY = Math.max(0, ...placed.map((n) => n.y + n.height));
  const padding = 24;
  const viewW = maxX + padding * 2;
  const viewH = maxY + padding * 2;

  const edges: Array<{ from: PlacedNode; to: PlacedNode }> = [];
  for (const w of workflows) {
    const fromNode = placedById.get(w.id);
    if (!fromNode) continue;
    for (const nextId of w.out) {
      const toNode = placedById.get(nextId);
      if (toNode) edges.push({ from: fromNode, to: toNode });
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <div className="text-zinc-500">
          {editableHere ? (
            <>
              Drag a node to reposition it. Positions snap to a 10px grid and persist per project.
              Edit topology (workflows, agents, transitions) on the <strong>Workflows</strong> tab.
            </>
          ) : (
            <>
              Read-only view of the lifecycle DAG. Edit on the <strong>Workflows</strong> tab.
            </>
          )}
        </div>
        <div className="flex items-center gap-2 text-zinc-500">
          {saving && <span>saving…</span>}
          {saveError && (
            <span className="text-rose-600 dark:text-rose-400">save failed: {saveError}</span>
          )}
        </div>
      </div>
      <div className="overflow-auto rounded border bg-zinc-50 p-2 dark:bg-zinc-900 dark:border-zinc-800">
        <svg
          width={viewW}
          height={viewH}
          viewBox={`0 0 ${viewW} ${viewH}`}
          className="text-zinc-700 dark:text-zinc-200"
          role="img"
          aria-label="Lifecycle DAG"
        >
          <defs>
            <marker
              id="lc-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          <g transform={`translate(${padding}, ${padding})`}>
            {edges.map(({ from, to }, i) => {
              const x1 = from.x + NODE_W;
              const y1 = from.y + from.height / 2;
              const x2 = to.x;
              const y2 = to.y + to.height / 2;
              const midX = (x1 + x2) / 2;
              const d = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2 - 6} ${y2}`;
              return (
                <path
                  key={`edge-${i}`}
                  d={d}
                  fill="none"
                  stroke="currentColor"
                  strokeOpacity={0.35}
                  strokeWidth={1.5}
                  markerEnd="url(#lc-arrow)"
                />
              );
            })}
            {placed.map((n) => (
              <g
                key={n.workflow.id}
                transform={`translate(${n.x}, ${n.y})`}
                onPointerDown={(e) => onPointerDown(e, n.workflow.id)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                style={{
                  cursor: editableHere ? 'grab' : 'default',
                  touchAction: editableHere ? 'none' : undefined,
                }}
              >
                <rect
                  width={NODE_W}
                  height={n.height}
                  rx={6}
                  ry={6}
                  className="fill-white stroke-zinc-300 dark:fill-zinc-950 dark:stroke-zinc-700"
                  strokeWidth={1}
                />
                <text
                  x={NODE_PAD}
                  y={NODE_PAD + 14}
                  className="fill-zinc-900 dark:fill-zinc-100"
                  fontSize={13}
                  fontWeight={600}
                >
                  {n.workflow.id}
                </text>
                {n.workflow.agents.length === 0 ? (
                  <text
                    x={NODE_PAD}
                    y={HEADER_H + NODE_PAD + 12}
                    className="fill-zinc-400"
                    fontSize={11}
                    fontStyle="italic"
                  >
                    (no agents)
                  </text>
                ) : (
                  n.workflow.agents.map((a, i) => (
                    <text
                      key={a}
                      x={NODE_PAD}
                      y={HEADER_H + NODE_PAD + 12 + i * AGENT_H}
                      className="fill-zinc-600 dark:fill-zinc-400"
                      fontSize={11}
                      fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                    >
                      {a}
                    </text>
                  ))
                )}
              </g>
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}
