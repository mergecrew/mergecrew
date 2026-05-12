/**
 * Validator tests for the project graph profile (#336). The validator
 * is what stops a malformed custom YAML from landing on a project
 * setting and silently bricking the runner, so the surface area
 * covered here is the operator-facing contract.
 */
import { describe, expect, it } from 'vitest';
import {
  CAREFUL_GRAPH,
  GRAPH_END,
  findGraphEntryNode,
  findNextGraphNode,
  parseAndValidateGraphYaml,
  validateGraphDefinition,
  type GraphDefinition,
} from '../src/graph-profile.js';

const careful = (): GraphDefinition => JSON.parse(JSON.stringify(CAREFUL_GRAPH));

describe('CAREFUL_GRAPH (the built-in careful profile)', () => {
  it('is structurally valid on its own terms', () => {
    expect(validateGraphDefinition(CAREFUL_GRAPH)).toEqual([]);
  });

  it('is valid when checked against a lifecycle that defines the three agents', () => {
    expect(
      validateGraphDefinition(CAREFUL_GRAPH, {
        availableAgentRefs: ['planner', 'coder', 'reviewer'],
      }),
    ).toEqual([]);
  });

  it('rejects when an agentRef is missing from the project lifecycle', () => {
    const issues = validateGraphDefinition(CAREFUL_GRAPH, {
      availableAgentRefs: ['planner', 'coder'], // no reviewer
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe('graph.nodes.reviewer.agentRef');
  });
});

describe('validateGraphDefinition — structural issues', () => {
  it('flags an edge with an unknown `from` node', () => {
    const g = careful();
    g.graph.edges.push({ from: 'mystery', to: GRAPH_END });
    const issues = validateGraphDefinition(g);
    expect(issues.some((i) => /mystery/.test(i.message))).toBe(true);
  });

  it('flags an edge with an unknown `to` node', () => {
    const g = careful();
    g.graph.edges[0]!.to = 'nowhere';
    const issues = validateGraphDefinition(g);
    expect(issues.some((i) => /nowhere/.test(i.message))).toBe(true);
  });

  it('flags a graph with no terminator', () => {
    const g: GraphDefinition = {
      version: 1,
      graph: {
        nodes: { a: { agentRef: 'planner' } },
        edges: [], // no edges → no terminator
      },
    };
    const issues = validateGraphDefinition(g);
    expect(issues.some((i) => /never finish/.test(i.message))).toBe(true);
  });

  it('flags a graph with multiple candidate entry nodes', () => {
    const g: GraphDefinition = {
      version: 1,
      graph: {
        nodes: { a: { agentRef: 'planner' }, b: { agentRef: 'coder' } },
        edges: [
          { from: 'a', to: GRAPH_END },
          { from: 'b', to: GRAPH_END },
        ],
      },
    };
    const issues = validateGraphDefinition(g);
    expect(issues.some((i) => /multiple candidate entry/.test(i.message))).toBe(true);
  });

  it('flags a graph with no entry node (pure cycle)', () => {
    const g: GraphDefinition = {
      version: 1,
      graph: {
        nodes: { a: { agentRef: 'planner' }, b: { agentRef: 'coder' } },
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
          { from: 'a', to: GRAPH_END }, // adds a terminator so we isolate the "no entry" error
        ],
      },
    };
    const issues = validateGraphDefinition(g);
    expect(issues.some((i) => /no entry node/.test(i.message))).toBe(true);
  });
});

describe('parseAndValidateGraphYaml', () => {
  it('parses + validates the careful graph yaml shape', () => {
    const yaml = `
version: 1
graph:
  nodes:
    planner: { agentRef: planner }
    coder: { agentRef: coder }
    reviewer: { agentRef: reviewer }
  edges:
    - from: planner
      to: coder
    - from: coder
      to: reviewer
    - from: reviewer
      to: coder
      when: requestChanges
    - from: reviewer
      to: __end__
      when: approve
`;
    const def = parseAndValidateGraphYaml(yaml, {
      availableAgentRefs: ['planner', 'coder', 'reviewer'],
    });
    expect(def.graph.nodes.planner!.agentRef).toBe('planner');
  });

  it('throws a parse error on malformed YAML', () => {
    expect(() => parseAndValidateGraphYaml('{ unclosed: [oops')).toThrow(/parse error/);
  });

  it('throws a shape error when the schema does not match', () => {
    const yaml = `
version: 1
graph:
  nodes: 'not-an-object'
  edges: []
`;
    expect(() => parseAndValidateGraphYaml(yaml)).toThrow(/shape error/);
  });

  it('throws a structural error when the graph is wrong', () => {
    const yaml = `
version: 1
graph:
  nodes:
    a: { agentRef: planner }
  edges: []
`;
    expect(() => parseAndValidateGraphYaml(yaml)).toThrow(/structural error/);
  });

  it('rejects an agentRef missing from the lifecycle when availableAgentRefs is set', () => {
    const yaml = `
version: 1
graph:
  nodes:
    a: { agentRef: nonexistent }
  edges:
    - from: a
      to: __end__
`;
    expect(() => parseAndValidateGraphYaml(yaml, { availableAgentRefs: ['planner'] })).toThrow(
      /agentRef.*nonexistent/,
    );
  });
});

describe('findGraphEntryNode (#348)', () => {
  it('returns the planner node for CAREFUL_GRAPH', () => {
    expect(findGraphEntryNode(CAREFUL_GRAPH)).toBe('planner');
  });

  it('returns undefined when no candidate exists (every node has an inbound edge)', () => {
    const g: GraphDefinition = {
      version: 1,
      graph: {
        nodes: { a: { agentRef: 'x' }, b: { agentRef: 'y' } },
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
          { from: 'a', to: GRAPH_END },
        ],
      },
    };
    expect(findGraphEntryNode(g)).toBeUndefined();
  });

  it('returns undefined when multiple candidates exist', () => {
    const g: GraphDefinition = {
      version: 1,
      graph: {
        nodes: { a: { agentRef: 'x' }, b: { agentRef: 'y' } },
        edges: [
          { from: 'a', to: GRAPH_END },
          { from: 'b', to: GRAPH_END },
        ],
      },
    };
    expect(findGraphEntryNode(g)).toBeUndefined();
  });
});

describe('findNextGraphNode (#348)', () => {
  it('returns the single successor when there is exactly one outgoing edge', () => {
    expect(findNextGraphNode(CAREFUL_GRAPH, 'planner')).toBe('coder');
    expect(findNextGraphNode(CAREFUL_GRAPH, 'coder')).toBe('reviewer');
  });

  it('routes by `when` signal when multiple edges share a `from`', () => {
    expect(findNextGraphNode(CAREFUL_GRAPH, 'reviewer', 'approve')).toBe(GRAPH_END);
    expect(findNextGraphNode(CAREFUL_GRAPH, 'reviewer', 'requestChanges')).toBe('coder');
  });

  it('falls back to the approve edge when no signal is supplied (#348 minimal behavior)', () => {
    expect(findNextGraphNode(CAREFUL_GRAPH, 'reviewer')).toBe(GRAPH_END);
  });

  it('returns null when no edge leaves the given node', () => {
    const g: GraphDefinition = {
      version: 1,
      graph: {
        nodes: { a: { agentRef: 'x' } },
        edges: [{ from: 'a', to: GRAPH_END }],
      },
    };
    expect(findNextGraphNode(g, 'no-such-node')).toBeNull();
  });

  it('returns null when multiple `when` edges exist but no signal matches and none is `approve`', () => {
    const g: GraphDefinition = {
      version: 1,
      graph: {
        nodes: { a: { agentRef: 'x' }, b: { agentRef: 'y' } },
        edges: [
          { from: 'a', to: 'b', when: 'foo' },
          { from: 'a', to: GRAPH_END, when: 'bar' },
        ],
      },
    };
    expect(findNextGraphNode(g, 'a', 'baz')).toBeNull();
  });
});
