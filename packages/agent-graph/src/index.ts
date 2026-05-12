/**
 * Multi-agent graph foundation (#331).
 *
 * Higher-level orchestration layer for the runner — sits ABOVE the
 * existing `runAgentStep` (`@mergecrew/agent-runtime`). Each graph node
 * is one agent step; the graph wires them together (planner → coder →
 * reviewer for the V2.ad `careful` profile, single-node for `legacy`).
 *
 * The package wraps LangGraph's `StateGraph` rather than re-implementing
 * it. Three things we add on top:
 *
 *   1. A `NodeCtx` that carries mergecrew identity (orgId, projectId,
 *      runId, etc.) into every node so node bodies don't need to thread
 *      these through state.
 *   2. `onNodeStart` / `onNodeFinish` hooks for telemetry — the
 *      orchestrator uses these to materialize an `agent_steps` row per
 *      node and to tag it with `graph_node_key`.
 *   3. A `LEGACY_GRAPH_KEY` convention so the runner can short-circuit
 *      a single-agent graph back into the existing `runAgentStep` path
 *      with zero behavior change for projects on the `fast` profile.
 *
 * The package is intentionally minimal — LangGraph already provides
 * checkpointing, conditional edges, and recursion limits. Don't
 * re-implement what's there.
 */

import { StateGraph, START, END, Annotation } from '@langchain/langgraph';

export { START, END, Annotation };

/**
 * Constant graph node key for the single-agent legacy path. The runner
 * tags `agent_steps.graph_node_key` with this when it invokes the
 * existing `runAgentStep` directly (i.e. project's `graphProfile` is
 * `fast` or undefined). Multi-agent graphs use named keys like
 * 'planner', 'coder', 'reviewer'.
 */
export const LEGACY_GRAPH_KEY = 'legacy';

/**
 * Identity + cancellation context passed into every node body. Distinct
 * from the *state* threaded through the graph — state changes per-node,
 * ctx is constant for the duration of a graph run.
 */
export interface NodeCtx {
  organizationId: string;
  projectId: string;
  runId: string;
  workflowRunId: string;
  /**
   * Cooperative cancellation. The orchestrator publishes on
   * RUN_CANCEL_CHANNEL and the runner aborts the graph; node bodies
   * are expected to honor this signal in their LLM / tool calls.
   */
  abortSignal: AbortSignal;
}

/**
 * A graph node body. Receives the current state plus ctx with the
 * node's key bound in, returns a partial-state patch. LangGraph
 * applies the patch via the annotation's reducer, so multiple fields
 * can be returned at once and partial updates merge cleanly.
 */
export type NodeHandler<S extends Record<string, unknown>> = (
  state: S,
  ctx: NodeCtx & { graphNodeKey: string },
) => Promise<Partial<S>>;

/**
 * Hooks fired around each node invocation. Both are best-effort — a
 * thrown hook does not abort the node; it's logged and swallowed at the
 * runGraph boundary so a telemetry failure can't fail the graph.
 */
export interface RunGraphHooks {
  onNodeStart?: (nodeKey: string) => void | Promise<void>;
  onNodeFinish?: (nodeKey: string, patch: Record<string, unknown>) => void | Promise<void>;
}

/**
 * Declarative graph definition. Mirrors LangGraph's API surface but
 * stays explicit about edges + conditional edges so the calling code is
 * declarative — easier to validate (`#336`) and easier to render in the
 * future per-agent timeline view (`#335`).
 */
export interface GraphDefinition<S extends Record<string, unknown>> {
  /**
   * LangGraph state annotation. Defines the reducer + default for every
   * field on `S`. Callers build this with `Annotation.Root({ ... })`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  annotation: any;
  initialState: S;
  /**
   * Node keys → handler functions. The key is what surfaces in
   * `graph_node_key`, the hooks, and the timeline UI.
   */
  nodes: Record<string, NodeHandler<S>>;
  /** Node that the START edge points to. */
  entry: string;
  /** Static edges between named nodes. Use `END` as the target to terminate. */
  edges: Array<{ from: string; to: string | typeof END }>;
  /**
   * Conditional edges. `decide` runs against post-node state and
   * returns one of the keys in `options`; the corresponding target is
   * the next node. Use this for reviewer loops (#334).
   */
  conditionalEdges?: Array<{
    from: string;
    decide: (state: S) => string;
    options: Record<string, string | typeof END>;
  }>;
}

/**
 * Drive a graph definition end-to-end. Returns the final state.
 *
 * Errors thrown by node bodies propagate out — graph runs are
 * non-recoverable from the package's perspective. The runner wraps
 * `runGraph` and translates thrown errors into `StepOutcome.failed`.
 */
export async function runGraph<S extends Record<string, unknown>>(
  def: GraphDefinition<S>,
  ctx: NodeCtx,
  hooks: RunGraphHooks = {},
): Promise<S> {
  // LangGraph's typings are intentionally loose here — the annotation
  // shape is dynamic, so any tighter typing would just push the casts
  // into the caller. Constrain them in node bodies, not at the builder
  // boundary.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder = new StateGraph(def.annotation as any);

  for (const [key, handler] of Object.entries(def.nodes)) {
    builder.addNode(key, async (state) => {
      await safeHook(hooks.onNodeStart, key);
      const patch = await handler(state as S, { ...ctx, graphNodeKey: key });
      await safeHook(
        hooks.onNodeFinish ? (k: string) => hooks.onNodeFinish!(k, patch as Record<string, unknown>) : undefined,
        key,
      );
      return patch;
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (builder as any).addEdge(START, def.entry);
  for (const e of def.edges) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (builder as any).addEdge(e.from, e.to);
  }
  if (def.conditionalEdges) {
    for (const c of def.conditionalEdges) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (builder as any).addConditionalEdges(c.from, c.decide as any, c.options as any);
    }
  }

  const compiled = builder.compile();
  const final = (await compiled.invoke(def.initialState, {
    signal: ctx.abortSignal,
  })) as S;
  return final;
}

async function safeHook(
  fn: ((k: string) => void | Promise<void>) | undefined,
  key: string,
): Promise<void> {
  if (!fn) return;
  try {
    await fn(key);
  } catch {
    // hooks are best-effort; swallow so telemetry failures don't fail the graph
  }
}
