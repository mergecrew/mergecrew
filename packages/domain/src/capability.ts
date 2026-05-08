import { z } from 'zod';

export const ModelCapability = z.object({
  reasoning: z.boolean().optional(),
  tools: z.boolean().optional(),
  parallelTools: z.boolean().optional(),
  vision: z.boolean().optional(),
  longContext: z.union([z.literal(200_000), z.literal(1_000_000)]).optional(),
  embedding: z.boolean().optional(),
  thinking: z.boolean().optional(),
  promptCache: z.boolean().optional(),
  responseJsonSchema: z.boolean().optional(),
  lowLatency: z.boolean().optional(),
});
export type ModelCapability = z.infer<typeof ModelCapability>;

export const ProviderKind = z.enum(['anthropic', 'openai', 'bedrock', 'ollama']);
export type ProviderKind = z.infer<typeof ProviderKind>;

export const ProviderRef = z
  .string()
  .regex(/^[a-z]+\/[A-Za-z0-9_.\-:]+$/, 'expected "providerKind/modelId"');
export type ProviderRef = z.infer<typeof ProviderRef>;

export function parseProviderRef(ref: ProviderRef): { kind: ProviderKind; model: string } {
  const [kind, ...rest] = ref.split('/');
  return { kind: ProviderKind.parse(kind), model: rest.join('/') };
}
