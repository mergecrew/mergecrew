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
import {
  saveGraphLayoutAction,
  getGraphEditBaseAction,
  openGraphEditPrAction,
  type GraphEdit,
} from './lifecycle-actions';

interface TransitionDef {
  to: string;
  /**
   * Routing predicate — defaults to `"true"` in the YAML schema, but
   * roster-graph workflows use named signals (`tests_pass`,
   * `tests_fail`, `approve`, `request_changes`) so the lifecycle
   * viewer can label the edge (#527).
   */
  when?: string;
  gate?: string;
}

interface WorkflowDef {
  id: string;
  description?: string;
  agents: string[];
  // Zod gives `out` a `.default([])` at YAML-parse time
  // (`packages/domain/src/lifecycle.ts`), but the parsed JSON lands in
  // the lifecycle.parsed column and is read back via Prisma without
  // re-validation — so workflows that didn't declare `out` reach this
  // component with `out: undefined`. Marking it optional forces every
  // call site below to spell out the `?? []` fallback.
  out?: string[];
  /**
   * Conditional transitions — same data as `out` but with a routing
   * `when` predicate per successor. When both are present we treat
   * `transitions` as authoritative for edge labels and `out` as a
   * fallback for any transition that didn't get a `when` (legacy
   * single-edge workflows).
   */
  transitions?: TransitionDef[];
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
    for (const next of w.out ?? []) {
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

  // Phase 3 (#196): inline rename → opens a PR against mergecrew.yaml.
  // We track which node is being renamed, the draft value, and the most
  // recent PR result / stale banner. baseHash is fetched on demand the first
  // time the user opens an edit — cheaper than a page-load roundtrip for
  // viewers who never edit.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [prSubmitting, setPrSubmitting] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const [prResult, setPrResult] = useState<{ url: string; number: number; summary: string } | null>(null);
  const [staleBanner, setStaleBanner] = useState(false);
  const baseHashRef = useRef<string | null>(null);

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

  async function ensureBaseHash(): Promise<string | null> {
    if (!projectScope) return null;
    if (baseHashRef.current) return baseHashRef.current;
    try {
      const r = await getGraphEditBaseAction(projectScope);
      baseHashRef.current = r.baseHash;
      return r.baseHash;
    } catch {
      return null;
    }
  }

  function startRename(id: string) {
    if (!editableHere) return;
    setPrError(null);
    setPrResult(null);
    setStaleBanner(false);
    setRenamingId(id);
    setRenameDraft(id);
  }
  function cancelRename() {
    setRenamingId(null);
    setRenameDraft('');
  }
  async function submitRename() {
    if (!projectScope || !renamingId) return;
    const from = renamingId;
    const to = renameDraft.trim();
    if (!to || to === from) {
      cancelRename();
      return;
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(to)) {
      setPrError('Workflow id must start with a letter and contain only letters, numbers, _ or -.');
      return;
    }
    if (workflows.some((w) => w.id === to)) {
      setPrError(`Workflow "${to}" already exists.`);
      return;
    }
    setPrSubmitting(true);
    setPrError(null);
    setStaleBanner(false);
    try {
      const baseHash = await ensureBaseHash();
      const edits: GraphEdit[] = [{ kind: 'rename_workflow', from, to }];
      const r = await openGraphEditPrAction(projectScope, edits, baseHash);
      if ('stale' in r) {
        baseHashRef.current = r.currentHash;
        setStaleBanner(true);
        return;
      }
      baseHashRef.current = r.baseHash;
      setPrResult({ url: r.prUrl, number: r.prNumber, summary: `rename workflow ${from} → ${to}` });
      cancelRename();
    } catch (e: any) {
      setPrError(String(e?.message ?? e));
    } finally {
      setPrSubmitting(false);
    }
  }

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

  const edges: Array<{ from: PlacedNode; to: PlacedNode; label?: string }> = [];
  for (const w of workflows) {
    const fromNode = placedById.get(w.id);
    if (!fromNode) continue;
    // Conditional transitions take precedence: each (to, when) pair is a
    // distinct edge with a visible label so loop-backs and verdict
    // routing are obvious. Workflows without transitions fall back to
    // the plain `out` list (legacy single-edge case).
    const transitions = w.transitions ?? [];
    if (transitions.length > 0) {
      for (const t of transitions) {
        const toNode = placedById.get(t.to);
        if (!toNode) continue;
        const label = t.when && t.when !== 'true' ? t.when : undefined;
        edges.push({ from: fromNode, to: toNode, label });
      }
    } else {
      for (const nextId of w.out ?? []) {
        const toNode = placedById.get(nextId);
        if (toNode) edges.push({ from: fromNode, to: toNode });
      }
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <div className="text-zinc-500">
          {editableHere ? (
            <>
              Drag a node to reposition it. Double-click a node to rename it via PR. Edge / agent
              edits stay on the <strong>Workflows</strong> tab.
            </>
          ) : (
            <>
              Read-only view of the lifecycle DAG. Edit on the <strong>Workflows</strong> tab.
            </>
          )}
        </div>
        <div className="flex items-center gap-2 text-zinc-500">
          {saving && <span>saving…</span>}
          {prSubmitting && <span>opening PR…</span>}
          {saveError && (
            <span className="text-rose-600 dark:text-rose-400">save failed: {saveError}</span>
          )}
        </div>
      </div>
      {prResult && (
        <div className="rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-900/20 dark:text-emerald-200">
          Opened <a className="underline" href={prResult.url} target="_blank" rel="noreferrer">PR #{prResult.number}</a> — {prResult.summary}.
        </div>
      )}
      {prError && (
        <div className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800 dark:border-rose-900/40 dark:bg-rose-900/20 dark:text-rose-300">
          {prError}
        </div>
      )}
      {staleBanner && (
        <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
          mergecrew.yaml changed on the default branch since you opened this view. Refresh and try again.
        </div>
      )}
      <div className="overflow-auto border border-hair bg-bg-2 p-2">
        <svg
          width={viewW}
          height={viewH}
          viewBox={`0 0 ${viewW} ${viewH}`}
          className="text-ink-2"
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
            {edges.map(({ from, to, label }, i) => {
              const x1 = from.x + NODE_W;
              const y1 = from.y + from.height / 2;
              const x2 = to.x;
              const y2 = to.y + to.height / 2;
              const midX = (x1 + x2) / 2;
              const midY = (y1 + y2) / 2;
              const d = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2 - 6} ${y2}`;
              return (
                <g key={`edge-${i}`}>
                  <path
                    d={d}
                    fill="none"
                    stroke="currentColor"
                    strokeOpacity={0.35}
                    strokeWidth={1.5}
                    markerEnd="url(#lc-arrow)"
                  />
                  {label && (
                    <g>
                      {/* Pill background so the label reads on top of the curve.
                          Width approximated from character count — accurate enough
                          for the labels we emit (tests_pass, tests_fail, etc.). */}
                      <rect
                        x={midX - Math.max(28, label.length * 4 + 6)}
                        y={midY - 9}
                        width={Math.max(56, label.length * 8 + 12)}
                        height={18}
                        rx={4}
                        ry={4}
                        className="fill-white stroke-zinc-300 dark:fill-zinc-950 dark:stroke-zinc-700"
                        strokeWidth={1}
                      />
                      <text
                        x={midX}
                        y={midY + 4}
                        textAnchor="middle"
                        className="fill-zinc-700 font-mono text-[10px] dark:fill-zinc-300"
                      >
                        {label}
                      </text>
                    </g>
                  )}
                </g>
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
                onDoubleClick={(e) => {
                  if (!editableHere) return;
                  e.stopPropagation();
                  startRename(n.workflow.id);
                }}
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
                {renamingId === n.workflow.id ? (
                  <foreignObject x={NODE_PAD - 4} y={NODE_PAD - 2} width={NODE_W - NODE_PAD * 2 + 8} height={24}>
                    <input
                      type="text"
                      value={renameDraft}
                      autoFocus
                      onChange={(ev) => setRenameDraft(ev.target.value)}
                      onPointerDown={(ev) => ev.stopPropagation()}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter') {
                          ev.preventDefault();
                          submitRename();
                        } else if (ev.key === 'Escape') {
                          ev.preventDefault();
                          cancelRename();
                        }
                      }}
                      onBlur={() => {
                        // Delay so click handlers (Save) on neighbouring elements still fire.
                        setTimeout(() => {
                          if (renamingId === n.workflow.id && !prSubmitting) cancelRename();
                        }, 100);
                      }}
                      disabled={prSubmitting}
                      className="w-full rounded border border-zinc-300 bg-white px-1 py-0.5 font-semibold text-zinc-900 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
                      style={{ fontSize: 13 }}
                    />
                  </foreignObject>
                ) : (
                  <text
                    x={NODE_PAD}
                    y={NODE_PAD + 14}
                    className="fill-zinc-900 dark:fill-zinc-100"
                    fontSize={13}
                    fontWeight={600}
                  >
                    {n.workflow.id}
                  </text>
                )}
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
