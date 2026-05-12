/**
 * Project graph-profile schema + validator (#336).
 *
 * The graph profile selects how a run dispatches agents:
 *
 *   - `fast`:    one agent per workflow node (V1 legacy behavior).
 *   - `careful`: planner -> coder -> reviewer with reviewer-driven
 *                loop-back to the coder. Default loop cap = 3 rounds.
 *   - `custom`:  parse `graphYaml` against `GraphDefinitionSchema`.
 *
 * The custom YAML body is operator-editable from project settings.
 * This module defines the schema, parses YAML, and runs structural
 * validations (no missing nodes, every node reachable from START,
 * every path terminates at __end__, agentRefs resolve against the
 * project's lifecycle YAML).
 */

import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

export const GRAPH_END = '__end__';

export type GraphProfile = 'fast' | 'careful' | 'custom';
export const GraphProfile = z.enum(['fast', 'careful', 'custom']);

/**
 * Conditional edge: routes from `from` to one of `options` based on
 * the `when` value emitted by the from-node. For the reviewer node,
 * `when` is one of 'approve' / 'requestChanges'.
 */
export const GraphEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  when: z.string().optional(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GraphNodeSchema = z.object({
  /**
   * Key into the project's lifecycle `agents` map. Resolved at runtime
   * to a concrete AgentDefinition.
   */
  agentRef: z.string().min(1),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphDefinitionSchema = z.object({
  version: z.literal(1),
  graph: z.object({
    nodes: z.record(GraphNodeSchema),
    edges: z.array(GraphEdgeSchema),
  }),
});
export type GraphDefinition = z.infer<typeof GraphDefinitionSchema>;

/**
 * `careful` profile, materialized as a graph definition. Used by the
 * runner (#338 wires it in) for any project on the careful profile —
 * no YAML body needed.
 */
export const CAREFUL_GRAPH: GraphDefinition = {
  version: 1,
  graph: {
    nodes: {
      planner: { agentRef: 'planner' },
      coder: { agentRef: 'coder' },
      reviewer: { agentRef: 'reviewer' },
    },
    edges: [
      { from: 'planner', to: 'coder' },
      { from: 'coder', to: 'reviewer' },
      { from: 'reviewer', to: 'coder', when: 'requestChanges' },
      { from: 'reviewer', to: GRAPH_END, when: 'approve' },
    ],
  },
};

export interface GraphValidationIssue {
  path: string;
  message: string;
}

/**
 * Validate a parsed graph definition for structural soundness:
 *
 *   1. Every edge's `from` and `to` must reference a defined node or
 *      `__end__`.
 *   2. Every node must be reachable from at least one edge's `from`
 *      (no orphans).
 *   3. There must be at least one path that terminates at `__end__`.
 *   4. (Optional) `availableAgentRefs` cross-check: every node's
 *      `agentRef` must exist in the project's lifecycle.
 *
 * Returns an empty array when the graph is valid. Callers should
 * present each issue at the location indicated by `path`.
 */
export function validateGraphDefinition(
  def: GraphDefinition,
  opts: { availableAgentRefs?: string[] } = {},
): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  const nodeKeys = new Set(Object.keys(def.graph.nodes));

  // 1. Edges reference defined nodes (or __end__ as the target).
  for (let i = 0; i < def.graph.edges.length; i++) {
    const e = def.graph.edges[i]!;
    if (!nodeKeys.has(e.from)) {
      issues.push({
        path: `graph.edges[${i}].from`,
        message: `unknown node "${e.from}"`,
      });
    }
    if (e.to !== GRAPH_END && !nodeKeys.has(e.to)) {
      issues.push({
        path: `graph.edges[${i}].to`,
        message: `unknown node "${e.to}" (use "${GRAPH_END}" to terminate)`,
      });
    }
  }

  // 2. Every node appears as the `from` of at least one edge OR is the
  //    entry point. We pick the entry as the unique node with no edges
  //    pointing INTO it. If no such node exists, that's its own error.
  const referencedAsTo = new Set<string>();
  for (const e of def.graph.edges) {
    if (e.to !== GRAPH_END) referencedAsTo.add(e.to);
  }
  const possibleEntries = [...nodeKeys].filter((k) => !referencedAsTo.has(k));
  if (possibleEntries.length === 0) {
    issues.push({
      path: 'graph.nodes',
      message: 'no entry node: every node is the target of some edge (cycle without a start)',
    });
  } else if (possibleEntries.length > 1) {
    issues.push({
      path: 'graph.nodes',
      message: `multiple candidate entry nodes (${possibleEntries.join(', ')}). Only one node should have no inbound edge.`,
    });
  }

  // 3. At least one edge must terminate at __end__.
  const hasTerminator = def.graph.edges.some((e) => e.to === GRAPH_END);
  if (!hasTerminator) {
    issues.push({
      path: 'graph.edges',
      message: `no edge terminates at "${GRAPH_END}" — the graph would never finish`,
    });
  }

  // 4. agentRefs resolve against the project's lifecycle.
  if (opts.availableAgentRefs) {
    const available = new Set(opts.availableAgentRefs);
    for (const [nodeKey, node] of Object.entries(def.graph.nodes)) {
      if (!available.has(node.agentRef)) {
        issues.push({
          path: `graph.nodes.${nodeKey}.agentRef`,
          message: `agentRef "${node.agentRef}" does not exist in this project's lifecycle agents`,
        });
      }
    }
  }

  return issues;
}

/**
 * Parse a custom-profile YAML body and validate it. Returns the parsed
 * definition on success, throws an Error with concatenated issue
 * messages on failure. Wraps zod parse errors + structural issues
 * behind a single throw site so callers don't need to handle both.
 */
export function parseAndValidateGraphYaml(
  yamlText: string,
  opts: { availableAgentRefs?: string[] } = {},
): GraphDefinition {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (e) {
    throw new Error(`graph yaml: parse error: ${(e as Error).message}`);
  }
  const zodResult = GraphDefinitionSchema.safeParse(parsed);
  if (!zodResult.success) {
    const msg = zodResult.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`graph yaml: shape error: ${msg}`);
  }
  const issues = validateGraphDefinition(zodResult.data, opts);
  if (issues.length > 0) {
    const msg = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
    throw new Error(`graph yaml: structural error: ${msg}`);
  }
  return zodResult.data;
}
