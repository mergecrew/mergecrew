'use client';

/**
 * Read-only DAG visualization of the lifecycle (V2.1 phase 1, #25).
 *
 * Renders workflows as boxes with their assigned agents listed inside,
 * and edges from each `workflow.out` transition. Layout is hand-rolled
 * BFS-by-depth — for the 5–15 workflow DAGs we expect, this is plenty
 * and keeps the bundle free of `dagre`/`react-flow` (~150 KB combined).
 *
 * Phase 2 (drag-to-position) and phase 3 (edit-and-commit a PR against
 * mergecrew.yaml) are tracked separately on the V2.1 issue.
 */

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

interface PlacedNode {
  workflow: WorkflowDef;
  x: number;
  y: number;
  height: number;
}

/**
 * BFS-by-depth layout. Each workflow's depth is the longest predecessor
 * path from a root (a workflow no other workflow points at). Within a
 * depth column nodes stack top-to-bottom in declaration order.
 */
function layout(workflows: WorkflowDef[]): {
  nodes: Map<string, PlacedNode>;
  width: number;
  height: number;
} {
  const byId = new Map(workflows.map((w) => [w.id, w]));
  const incoming = new Map<string, string[]>();
  for (const w of workflows) incoming.set(w.id, []);
  for (const w of workflows) {
    for (const next of w.out) {
      if (!incoming.has(next)) incoming.set(next, []);
      incoming.get(next)!.push(w.id);
    }
  }
  const depth = new Map<string, number>();
  // Repeatedly relax until stable. With at most ~50 workflows this is
  // negligible; a real toposort is fine but not necessary here.
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

  const nodes = new Map<string, PlacedNode>();
  const colHeights = new Map<number, number>();
  const sortedDepths = [...columns.keys()].sort((a, b) => a - b);
  let maxDepth = 0;
  for (const d of sortedDepths) {
    if (d > maxDepth) maxDepth = d;
    let y = 0;
    for (const w of columns.get(d)!) {
      const h = HEADER_H + Math.max(1, w.agents.length) * AGENT_H + NODE_PAD * 2;
      nodes.set(w.id, { workflow: w, x: d * (NODE_W + COL_GAP), y, height: h });
      y += h + ROW_GAP;
    }
    colHeights.set(d, y);
  }
  const maxHeight = Math.max(0, ...colHeights.values());
  const width = (maxDepth + 1) * NODE_W + maxDepth * COL_GAP;
  const height = Math.max(maxHeight, 60);
  // Center each column vertically against the tallest one.
  for (const node of nodes.values()) {
    const colH = colHeights.get(depth.get(node.workflow.id) ?? 0) ?? 0;
    node.y += (maxHeight - colH) / 2;
  }
  return { nodes, width, height };
}

export function LifecycleGraph({ parsed }: { parsed: ParsedConfigShape }) {
  const workflows = parsed.lifecycle?.workflows ?? [];
  if (workflows.length === 0) {
    return (
      <div className="rounded border border-dashed p-6 text-sm text-zinc-500 dark:border-zinc-800">
        No workflows yet. Add one on the <strong>Workflows</strong> tab.
      </div>
    );
  }

  const { nodes, width, height } = layout(workflows);
  const padding = 24;

  const edges: Array<{ from: PlacedNode; to: PlacedNode }> = [];
  for (const w of workflows) {
    const fromNode = nodes.get(w.id);
    if (!fromNode) continue;
    for (const nextId of w.out) {
      const toNode = nodes.get(nextId);
      if (toNode) edges.push({ from: fromNode, to: toNode });
    }
  }

  const viewW = width + padding * 2;
  const viewH = height + padding * 2;

  return (
    <div className="space-y-2">
      <div className="text-xs text-zinc-500">
        Read-only view of the lifecycle DAG. Edit on the <strong>Workflows</strong> tab; drag-and-drop
        editing is phase 2 of the V2.1 visual editor.
      </div>
      <div className="overflow-x-auto rounded border bg-zinc-50 p-2 dark:bg-zinc-900 dark:border-zinc-800">
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
            {[...nodes.values()].map((n) => (
              <g key={n.workflow.id} transform={`translate(${n.x}, ${n.y})`}>
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
