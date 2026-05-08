import type { ModelCapability } from '@mergecrew/domain';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  thinkingTokens?: number;
  totalTokens: number;
}

export interface LlmProfile {
  id: string;
  name: string;
  preferenceOrder: string[];
  capabilityRouting: Record<string, ModelCapability>;
}
