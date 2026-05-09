import type { MergecrewConfig, WorkflowDef } from '@mergecrew/domain';
import { defaultConfig } from './default.js';

/**
 * Merge a project's mergecrew.yaml on top of the built-in default.
 *
 * Why: shipping a default lifecycle in code lets users opt into a working
 * pipeline with zero configuration. Projects that override only one workflow
 * or one agent shouldn't have to redeclare everything else.
 *
 * Merge rules (project always wins on collision):
 *   - workflows: union by `id`, project entry replaces base entry
 *   - agents: union by ref-key, project entry replaces base entry
 *   - skills: union by skill-name, project entry replaces base entry
 *   - human_gates: project value replaces base value when present
 *
 * The merge is shallow within each entry (whole agent/workflow/skill swaps),
 * not deep-merge of fields. Users that want a partial agent override should
 * copy the base agent and tweak — explicit beats clever.
 */
export function mergeWithDefault(project: MergecrewConfig): MergecrewConfig {
  const base = defaultConfig();

  const wfById = new Map<string, WorkflowDef>();
  for (const w of base.lifecycle.workflows) wfById.set(w.id, w);
  for (const w of project.lifecycle.workflows) wfById.set(w.id, w);

  return {
    version: 1,
    lifecycle: {
      workflows: Array.from(wfById.values()),
      human_gates: project.lifecycle.human_gates ?? base.lifecycle.human_gates,
    },
    agents: { ...base.agents, ...project.agents },
    skills: { ...base.skills, ...project.skills },
  };
}
