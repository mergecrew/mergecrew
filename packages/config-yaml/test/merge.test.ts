import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../src/default.js';
import { mergeWithDefault } from '../src/merge.js';
import { parseMergecrewYaml } from '../src/parse.js';

const EMPTY_PROJECT = parseMergecrewYaml(`version: 1
lifecycle:
  workflows: []
agents: {}
skills: {}`).parsed;

describe('mergeWithDefault', () => {
  it('returns the default verbatim when project config is empty', () => {
    const merged = mergeWithDefault(EMPTY_PROJECT);
    const base = defaultConfig();
    expect(merged.lifecycle.workflows.map((w) => w.id)).toEqual(
      base.lifecycle.workflows.map((w) => w.id),
    );
    expect(Object.keys(merged.agents).sort()).toEqual(Object.keys(base.agents).sort());
  });

  it('project workflow overrides default workflow with same id', () => {
    const project = parseMergecrewYaml(`version: 1
lifecycle:
  workflows:
    - id: pm
      agents: [my_pm]
      out: []
agents: {}
skills: {}`).parsed;

    const merged = mergeWithDefault(project);
    const pm = merged.lifecycle.workflows.find((w) => w.id === 'pm');
    expect(pm).toBeDefined();
    expect(pm!.agents).toEqual(['my_pm']);
    // Other default workflows are preserved.
    const ids = merged.lifecycle.workflows.map((w) => w.id);
    expect(ids).toContain('discovery');
    expect(ids).toContain('implementation');
  });

  it('project workflow with new id is appended to the default set', () => {
    const project = parseMergecrewYaml(`version: 1
lifecycle:
  workflows:
    - id: extra_review
      agents: [reviewer]
      out: []
agents: {}
skills: {}`).parsed;

    const merged = mergeWithDefault(project);
    const ids = merged.lifecycle.workflows.map((w) => w.id);
    expect(ids).toContain('extra_review');
    // Defaults still present.
    expect(ids).toContain('pm');
    expect(ids).toContain('implementation');
  });

  it('project agent with same key replaces the default agent', () => {
    const project = parseMergecrewYaml(`version: 1
lifecycle:
  workflows: []
agents:
  pm:
    kind: my_pm
    description: custom pm
    skills: []
skills: {}`).parsed;

    const merged = mergeWithDefault(project);
    expect(merged.agents.pm?.kind).toBe('my_pm');
    expect(merged.agents.pm?.description).toBe('custom pm');
    // Other default agents still present.
    expect(merged.agents.backend_engineer).toBeDefined();
  });

  it('project agent with new key is added alongside defaults', () => {
    const project = parseMergecrewYaml(`version: 1
lifecycle:
  workflows: []
agents:
  reviewer:
    kind: reviewer
    skills: []
skills: {}`).parsed;

    const merged = mergeWithDefault(project);
    expect(merged.agents.reviewer).toBeDefined();
    expect(merged.agents.pm).toBeDefined();
  });

  it('project skills replace defaults with same name', () => {
    const project = parseMergecrewYaml(`version: 1
lifecycle:
  workflows: []
agents: {}
skills:
  custom.deploy:
    description: custom deploy hook
    inputSchema:
      type: object
    sideEffectClass: write_external
    endpoint: https://example.com/skill
`).parsed;

    const merged = mergeWithDefault(project);
    expect(merged.skills['custom.deploy']).toBeDefined();
    expect(merged.skills['custom.deploy']?.description).toBe('custom deploy hook');
  });

  it('project human_gates replaces default human_gates entirely', () => {
    const project = parseMergecrewYaml(`version: 1
lifecycle:
  workflows: []
  human_gates:
    production_promote: auto
    sensitive_path_patterns:
      - "k8s/**"
agents: {}
skills: {}`).parsed;

    const merged = mergeWithDefault(project);
    expect(merged.lifecycle.human_gates?.production_promote).toBe('auto');
    expect(merged.lifecycle.human_gates?.sensitive_path_patterns).toEqual(['k8s/**']);
  });

  it('omitted human_gates falls back to default', () => {
    const merged = mergeWithDefault(EMPTY_PROJECT);
    expect(merged.lifecycle.human_gates).toBeDefined();
  });

  it('output is always version: 1', () => {
    expect(mergeWithDefault(EMPTY_PROJECT).version).toBe(1);
  });
});
