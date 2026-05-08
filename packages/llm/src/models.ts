import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ModelCapability, ProviderKind } from '@mergecrew/domain';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { ChatBedrockConverse } from '@langchain/aws';
import { ChatOllama } from '@langchain/ollama';

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  apiKey?: string;
  endpoint?: string;
  awsRegion?: string;
  models: string[];
  capabilityOverrides?: Record<string, ModelCapability>;
}

export interface BuildModelOptions {
  temperature?: number;
  maxTokens?: number;
  thinkingBudgetTokens?: number;
  abortSignal?: AbortSignal;
}

/**
 * Build a LangChain BaseChatModel for a given provider config + modelId.
 * The runner instantiates this per agent step (BYOK keys live only as long as
 * the step) — do not cache instances across requests.
 */
export function buildChatModel(
  cfg: ProviderConfig,
  modelId: string,
  opts: BuildModelOptions = {},
): BaseChatModel {
  switch (cfg.kind) {
    case 'anthropic':
      return new ChatAnthropic({
        apiKey: cfg.apiKey,
        model: modelId,
        temperature: opts.temperature ?? 0.2,
        maxTokens: opts.maxTokens ?? 4096,
        ...(opts.thinkingBudgetTokens
          ? { thinking: { type: 'enabled', budget_tokens: opts.thinkingBudgetTokens } as any }
          : {}),
      });
    case 'openai':
      return new ChatOpenAI({
        apiKey: cfg.apiKey,
        model: modelId,
        temperature: opts.temperature ?? 0.2,
        maxTokens: opts.maxTokens ?? 4096,
      });
    case 'bedrock':
      return new ChatBedrockConverse({
        region: cfg.awsRegion ?? 'us-east-1',
        model: modelId,
        temperature: opts.temperature ?? 0.2,
        maxTokens: opts.maxTokens ?? 4096,
      });
    case 'ollama':
      return new ChatOllama({
        baseUrl: cfg.endpoint ?? 'http://localhost:11434',
        model: modelId,
        temperature: opts.temperature ?? 0.2,
        numPredict: opts.maxTokens ?? 4096,
      });
  }
}

/**
 * Capabilities are declared by the provider config (stored in the DB) or
 * inferred from a small built-in catalog. Used by the CapabilityRouter to
 * pick a model whose features match what the agent needs.
 */
export function capabilitiesFor(
  cfg: ProviderConfig,
  modelId: string,
): ModelCapability {
  const override = cfg.capabilityOverrides?.[modelId];
  if (override) return override;

  switch (cfg.kind) {
    case 'anthropic':
      if (modelId.startsWith('claude-opus') || modelId.startsWith('claude-sonnet') || modelId.startsWith('claude-haiku')) {
        return {
          tools: true,
          parallelTools: true,
          vision: true,
          thinking: modelId.includes('opus') || modelId.includes('sonnet'),
          promptCache: true,
          longContext: 200_000,
        };
      }
      return { tools: true, longContext: 200_000 };
    case 'openai':
      if (modelId.startsWith('gpt-4') || modelId.startsWith('gpt-5') || modelId.startsWith('o')) {
        return {
          tools: true,
          parallelTools: true,
          vision: modelId.startsWith('gpt-4o') || modelId.startsWith('gpt-5'),
          responseJsonSchema: true,
          longContext: 200_000,
        };
      }
      return { tools: true, longContext: 200_000 };
    case 'bedrock':
      if (modelId.includes('claude')) {
        return { tools: true, parallelTools: true, vision: true, longContext: 200_000 };
      }
      return { tools: true, longContext: 200_000 };
    case 'ollama':
      if (modelId.startsWith('qwen3')) return { tools: true, longContext: 200_000 };
      if (modelId.startsWith('llama3')) return { tools: false, longContext: 200_000 };
      if (modelId.startsWith('nomic-embed')) return { embedding: true };
      return {};
  }
}
