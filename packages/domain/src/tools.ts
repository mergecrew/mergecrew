import { z } from 'zod';

export const ToolSpec = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
});
export type ToolSpec = z.infer<typeof ToolSpec>;

export const ToolCall = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const ToolResult = z.object({
  toolUseId: z.string(),
  content: z.unknown(),
  isError: z.boolean().optional(),
  brief: z.string().optional(),
});
export type ToolResult = z.infer<typeof ToolResult>;

export const SideEffectClass = z.enum([
  'read',
  'write_workspace',
  'write_external',
  'irreversible',
]);
export type SideEffectClass = z.infer<typeof SideEffectClass>;
