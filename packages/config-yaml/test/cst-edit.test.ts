import { describe, it, expect } from 'vitest';
import {
  renameWorkflow,
  addWorkflowEdge,
  removeWorkflowEdge,
  addWorkflowAgent,
  removeWorkflowAgent,
  applyGraphEdits,
} from '../src/cst-edit.js';

const SAMPLE = `version: 1
lifecycle:
  # The default daily pipeline.
  workflows:
    - id: discovery
      description: Reads issues.
      agents: [discovery] # primary agent
      out: [pm]
    - id: pm
      description: Plans the work.
      agents:
        - pm
      out:
        - implementation
      transitions:
        - to: implementation
          when: "true"
          gate: auto
    - id: implementation
      agents: [backend_engineer, frontend_engineer]
      out: []
agents: {}
skills: {}
`;

describe('renameWorkflow', () => {
  it('renames the workflow id field and preserves comments', () => {
    const r = renameWorkflow(SAMPLE, 'discovery', 'discover');
    expect(r.yaml).toContain('id: discover\n');
    expect(r.yaml).not.toContain('id: discovery\n');
    expect(r.yaml).toContain('# The default daily pipeline.');
    expect(r.yaml).toContain('# primary agent');
    expect(r.summary).toBe('rename workflow discovery → discover');
  });

  it('updates incoming references in out: lists', () => {
    const r = renameWorkflow(SAMPLE, 'pm', 'plan');
    expect(r.yaml).toContain('id: plan');
    // discovery.out previously was [pm]; should now be [plan].
    const m = r.yaml.match(/id: discovery[\s\S]*?out: \[(\w+)\]/);
    expect(m?.[1]).toBe('plan');
  });

  it('updates transitions[].to references', () => {
    const r = renameWorkflow(SAMPLE, 'implementation', 'impl');
    expect(r.yaml).toContain('id: impl');
    expect(r.yaml).toMatch(/transitions:[\s\S]*?- to: impl/);
  });

  it('rejects when from workflow does not exist', () => {
    expect(() => renameWorkflow(SAMPLE, 'nope', 'x')).toThrow(/not found/);
  });

  it('rejects when to workflow already exists', () => {
    expect(() => renameWorkflow(SAMPLE, 'pm', 'discovery')).toThrow(/already exists/);
  });

  it('rejects when from === to', () => {
    expect(() => renameWorkflow(SAMPLE, 'pm', 'pm')).toThrow(/identical/);
  });

  it('rejects invalid target id', () => {
    expect(() => renameWorkflow(SAMPLE, 'pm', '123-bad')).toThrow(/invalid id/);
    expect(() => renameWorkflow(SAMPLE, 'pm', 'has space')).toThrow(/invalid id/);
  });
});

describe('addWorkflowEdge', () => {
  it('adds a target to the source workflow out list', () => {
    const r = addWorkflowEdge(SAMPLE, 'implementation', 'pm');
    expect(r.yaml).toMatch(/id: implementation[\s\S]*?out:[\s\S]*pm/);
    expect(r.summary).toBe('add edge implementation → pm');
  });

  it('is idempotent: re-adding existing edge is a no-op', () => {
    const r = addWorkflowEdge(SAMPLE, 'discovery', 'pm');
    expect(r.yaml).toBe(SAMPLE);
    expect(r.summary).toMatch(/no-op/);
  });

  it('rejects unknown workflows', () => {
    expect(() => addWorkflowEdge(SAMPLE, 'nope', 'pm')).toThrow(/not found/);
    expect(() => addWorkflowEdge(SAMPLE, 'pm', 'nope')).toThrow(/not found/);
  });

  it('rejects self-edges', () => {
    expect(() => addWorkflowEdge(SAMPLE, 'pm', 'pm')).toThrow(/self-edges/);
  });
});

describe('removeWorkflowEdge', () => {
  it('removes a target from the source workflow out list', () => {
    const r = removeWorkflowEdge(SAMPLE, 'discovery', 'pm');
    expect(r.yaml).toMatch(/id: discovery[\s\S]*?out: \[\]/);
    expect(r.summary).toBe('remove edge discovery → pm');
  });

  it('is idempotent: removing a missing edge is a no-op', () => {
    const r = removeWorkflowEdge(SAMPLE, 'discovery', 'implementation');
    expect(r.yaml).toBe(SAMPLE);
    expect(r.summary).toMatch(/no-op/);
  });

  it('rejects unknown source workflow', () => {
    expect(() => removeWorkflowEdge(SAMPLE, 'nope', 'pm')).toThrow(/not found/);
  });
});

describe('addWorkflowAgent', () => {
  it('adds an agent to the workflow agents list', () => {
    const r = addWorkflowAgent(SAMPLE, 'pm', 'spec_writer');
    expect(r.yaml).toMatch(/id: pm[\s\S]*?agents:[\s\S]*?spec_writer/);
    expect(r.summary).toBe('add agent spec_writer to pm');
  });

  it('preserves block style when adding to a block-style list', () => {
    const r = addWorkflowAgent(SAMPLE, 'pm', 'spec_writer');
    // The pm workflow uses block list style for agents — the new entry
    // should also be a block list entry, not flow.
    expect(r.yaml).toMatch(/id: pm[\s\S]*?agents:\n\s+- pm\n\s+- spec_writer/);
  });

  it('is idempotent: re-adding existing agent is a no-op', () => {
    const r = addWorkflowAgent(SAMPLE, 'pm', 'pm');
    expect(r.yaml).toBe(SAMPLE);
    expect(r.summary).toMatch(/no-op/);
  });

  it('rejects unknown workflow', () => {
    expect(() => addWorkflowAgent(SAMPLE, 'nope', 'x')).toThrow(/not found/);
  });
});

describe('removeWorkflowAgent', () => {
  it('removes an agent from the workflow agents list', () => {
    const r = removeWorkflowAgent(SAMPLE, 'implementation', 'frontend_engineer');
    expect(r.yaml).toMatch(/id: implementation[\s\S]*?agents: \[backend_engineer\]/);
    expect(r.summary).toBe('remove agent frontend_engineer from implementation');
  });

  it('is idempotent: removing a missing agent is a no-op', () => {
    const r = removeWorkflowAgent(SAMPLE, 'pm', 'discovery');
    expect(r.yaml).toBe(SAMPLE);
    expect(r.summary).toMatch(/no-op/);
  });
});

describe('applyGraphEdits', () => {
  it('applies multiple edits in order and returns combined summary', () => {
    const r = applyGraphEdits(SAMPLE, [
      { kind: 'rename_workflow', from: 'pm', to: 'plan' },
      { kind: 'add_agent', workflow: 'plan', agent: 'spec_writer' },
    ]);
    expect(r.yaml).toContain('id: plan');
    expect(r.yaml).toMatch(/id: plan[\s\S]*?spec_writer/);
    expect(r.summary).toBe('2 lifecycle edits');
  });

  it('rejects empty edit list', () => {
    expect(() => applyGraphEdits(SAMPLE, [])).toThrow(/at least one edit/);
  });
});

describe('CST round-trip safety', () => {
  it('does not reformat untouched sections of the file', () => {
    // No edit that touches the agents block.
    const r = addWorkflowEdge(SAMPLE, 'implementation', 'pm');
    expect(r.yaml).toContain('agents: {}');
    expect(r.yaml).toContain('skills: {}');
    expect(r.yaml).toContain('# The default daily pipeline.');
    expect(r.yaml).toContain('# primary agent');
  });

  it('rejects malformed YAML clearly', () => {
    expect(() => renameWorkflow('not: valid: yaml: ::: :', 'a', 'b')).toThrow();
  });

  it('rejects when lifecycle.workflows is missing', () => {
    const noWorkflows = `version: 1\nlifecycle: {}\nagents: {}\nskills: {}\n`;
    expect(() => renameWorkflow(noWorkflows, 'a', 'b')).toThrow(/lifecycle\.workflows/);
  });
});
