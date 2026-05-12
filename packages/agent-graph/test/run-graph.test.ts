/**
 * Foundational tests for the agent-graph wrapper (#331). The wrapper
 * is intentionally thin; these tests cover the contract surface — node
 * ordering, hook firing, conditional edges — without re-testing
 * LangGraph itself.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  Annotation,
  END,
  LEGACY_GRAPH_KEY,
  type NodeCtx,
  runGraph,
} from '../src/index.js';

interface CounterState extends Record<string, unknown> {
  counter: number;
  trace: string[];
}

const CounterAnnotation = Annotation.Root({
  counter: Annotation<number>({
    reducer: (_l, r) => r,
    default: () => 0,
  }),
  trace: Annotation<string[]>({
    reducer: (l, r) => l.concat(r),
    default: () => [],
  }),
});

function mkCtx(overrides: Partial<NodeCtx> = {}): NodeCtx {
  return {
    organizationId: 'org-1',
    projectId: 'project-1',
    runId: 'run-1',
    workflowRunId: 'wf-1',
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

describe('runGraph — three-node linear graph', () => {
  it('drives nodes in order, accumulating state via the annotation reducer', async () => {
    const onNodeStart = vi.fn();
    const onNodeFinish = vi.fn();

    const final = await runGraph<CounterState>(
      {
        annotation: CounterAnnotation,
        initialState: { counter: 0, trace: [] },
        entry: 'a',
        nodes: {
          a: async (s, ctx) => ({ counter: s.counter + 1, trace: [`a:${ctx.graphNodeKey}`] }),
          b: async (s, ctx) => ({ counter: s.counter + 1, trace: [`b:${ctx.graphNodeKey}`] }),
          c: async (s, ctx) => ({ counter: s.counter + 1, trace: [`c:${ctx.graphNodeKey}`] }),
        },
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
          { from: 'c', to: END },
        ],
      },
      mkCtx(),
      { onNodeStart, onNodeFinish },
    );

    expect(final.counter).toBe(3);
    expect(final.trace).toEqual(['a:a', 'b:b', 'c:c']);
    expect(onNodeStart.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
    expect(onNodeFinish.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
  });

  it('passes mergecrew identity into every node body via ctx', async () => {
    const seen: Array<{ key: string; orgId: string; runId: string }> = [];
    await runGraph<CounterState>(
      {
        annotation: CounterAnnotation,
        initialState: { counter: 0, trace: [] },
        entry: 'a',
        nodes: {
          a: async (_s, ctx) => {
            seen.push({ key: ctx.graphNodeKey, orgId: ctx.organizationId, runId: ctx.runId });
            return {};
          },
          b: async (_s, ctx) => {
            seen.push({ key: ctx.graphNodeKey, orgId: ctx.organizationId, runId: ctx.runId });
            return {};
          },
        },
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: END },
        ],
      },
      mkCtx({ organizationId: 'org-X', runId: 'run-X' }),
    );

    expect(seen).toEqual([
      { key: 'a', orgId: 'org-X', runId: 'run-X' },
      { key: 'b', orgId: 'org-X', runId: 'run-X' },
    ]);
  });
});

describe('runGraph — conditional edges', () => {
  it('routes via the decide function', async () => {
    const visited: string[] = [];
    const final = await runGraph<CounterState>(
      {
        annotation: CounterAnnotation,
        initialState: { counter: 5, trace: [] },
        entry: 'gate',
        nodes: {
          gate: async (s) => {
            visited.push('gate');
            return { counter: s.counter };
          },
          big: async () => {
            visited.push('big');
            return { trace: ['big'] };
          },
          small: async () => {
            visited.push('small');
            return { trace: ['small'] };
          },
        },
        edges: [
          { from: 'big', to: END },
          { from: 'small', to: END },
        ],
        conditionalEdges: [
          {
            from: 'gate',
            decide: (s) => (s.counter >= 5 ? 'big' : 'small'),
            options: { big: 'big', small: 'small' },
          },
        ],
      },
      mkCtx(),
    );

    expect(visited).toEqual(['gate', 'big']);
    expect(final.trace).toEqual(['big']);
  });

  it('routes the other branch when state warrants', async () => {
    const final = await runGraph<CounterState>(
      {
        annotation: CounterAnnotation,
        initialState: { counter: 2, trace: [] },
        entry: 'gate',
        nodes: {
          gate: async (s) => ({ counter: s.counter }),
          big: async () => ({ trace: ['big'] }),
          small: async () => ({ trace: ['small'] }),
        },
        edges: [
          { from: 'big', to: END },
          { from: 'small', to: END },
        ],
        conditionalEdges: [
          {
            from: 'gate',
            decide: (s) => (s.counter >= 5 ? 'big' : 'small'),
            options: { big: 'big', small: 'small' },
          },
        ],
      },
      mkCtx(),
    );
    expect(final.trace).toEqual(['small']);
  });
});

describe('runGraph — hooks', () => {
  it('swallows hook errors without failing the graph', async () => {
    const onNodeStart = vi.fn(() => {
      throw new Error('boom');
    });
    const final = await runGraph<CounterState>(
      {
        annotation: CounterAnnotation,
        initialState: { counter: 0, trace: [] },
        entry: 'a',
        nodes: { a: async () => ({ counter: 42 }) },
        edges: [{ from: 'a', to: END }],
      },
      mkCtx(),
      { onNodeStart },
    );

    expect(onNodeStart).toHaveBeenCalled();
    expect(final.counter).toBe(42);
  });
});

describe('LEGACY_GRAPH_KEY', () => {
  it('is a stable string constant — used by the runner to tag legacy steps', () => {
    expect(LEGACY_GRAPH_KEY).toBe('legacy');
  });
});
