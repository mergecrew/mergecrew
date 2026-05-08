import { z } from 'zod';
import { ProviderRef } from './capability.js';

export const GateKind = z.enum(['auto', 'notify', 'require-approval']);
export type GateKind = z.infer<typeof GateKind>;

export const TransitionDef = z.object({
  to: z.string(),
  when: z.string().default('true'),
  gate: GateKind.default('auto'),
});
export type TransitionDef = z.infer<typeof TransitionDef>;

export const WorkflowDef = z.object({
  id: z.string(),
  agents: z.array(z.string()),
  out: z.array(z.string()).default([]),
  transitions: z.array(TransitionDef).default([]),
});
export type WorkflowDef = z.infer<typeof WorkflowDef>;

export const HumanGatesDef = z.object({
  production_promote: GateKind.default('require-approval'),
  sensitive_path_patterns: z.array(z.string()).default([]),
});
export type HumanGatesDef = z.infer<typeof HumanGatesDef>;

export const SkillBindingDef = z.union([
  z.string(),
  z.object({
    name: z.string(),
    config: z.record(z.unknown()).optional(),
  }),
]);

export const AgentDefinition = z.object({
  kind: z.string(),
  systemPrompt: z.string().optional(),
  model: z.string().optional(),
  fallback: z.array(ProviderRef).default([]),
  skills: z.array(SkillBindingDef).default([]),
  do_not_touch: z.array(z.string()).default([]),
  maxStepsPerRun: z.number().int().positive().default(12),
  maxToolCallsPerStep: z.number().int().positive().default(8),
  budget: z
    .object({
      tokens: z.number().int().positive().optional(),
      usd: z.number().positive().optional(),
    })
    .optional(),
});
export type AgentDefinition = z.infer<typeof AgentDefinition>;

export const CustomSkillDef = z.object({
  description: z.string(),
  inputSchema: z.record(z.unknown()),
  outputSchema: z.record(z.unknown()).optional(),
  endpoint: z.string().url().optional(),
  authRef: z.string().optional(),
  sideEffectClass: z.enum(['read', 'write_workspace', 'write_external', 'irreversible']).default('read'),
});
export type CustomSkillDef = z.infer<typeof CustomSkillDef>;

export const MergecrewConfig = z.object({
  version: z.literal(1),
  lifecycle: z.object({
    workflows: z.array(WorkflowDef),
    human_gates: HumanGatesDef.optional(),
  }),
  agents: z.record(AgentDefinition).default({}),
  skills: z.record(CustomSkillDef).default({}),
});
export type MergecrewConfig = z.infer<typeof MergecrewConfig>;
