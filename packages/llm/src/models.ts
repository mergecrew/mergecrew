import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Embeddings } from '@langchain/core/embeddings';
import type { ModelCapability, ProviderKind } from '@mergecrew/domain';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { ChatBedrockConverse, BedrockEmbeddings } from '@langchain/aws';
import { ChatOllama, OllamaEmbeddings } from '@langchain/ollama';

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
 * Build a LangChain Embeddings model for an embedding-capable provider config.
 * Anthropic does not ship an embeddings model — use OpenAI, Bedrock, or Ollama.
 * The runner instantiates per skill execution; do not cache instances.
 */
export function buildEmbeddingsModel(
  cfg: ProviderConfig,
  modelId: string,
): Embeddings {
  switch (cfg.kind) {
    case 'openai':
      return new OpenAIEmbeddings({
        apiKey: cfg.apiKey,
        model: modelId,
      });
    case 'bedrock':
      return new BedrockEmbeddings({
        region: cfg.awsRegion ?? 'us-east-1',
        model: modelId,
      });
    case 'ollama':
      return new OllamaEmbeddings({
        baseUrl: cfg.endpoint ?? 'http://localhost:11434',
        model: modelId,
      });
    case 'anthropic':
      throw new Error(
        'Anthropic does not provide an embeddings model; use openai, bedrock, or ollama',
      );
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
      if (modelId.startsWith('text-embedding-')) {
        return { embedding: true };
      }
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
      if (modelId.includes('embed') || modelId.startsWith('amazon.titan-embed') || modelId.startsWith('cohere.embed')) {
        return { embedding: true };
      }
      if (modelId.includes('claude')) {
        return { tools: true, parallelTools: true, vision: true, longContext: 200_000 };
      }
      return { tools: true, longContext: 200_000 };
    case 'ollama':
      if (modelId.startsWith('qwen3')) return { tools: true, longContext: 200_000 };
      if (modelId.startsWith('llama3')) return { tools: false, longContext: 200_000 };
      if (modelId.startsWith('nomic-embed') || modelId.startsWith('mxbai-embed')) {
        return { embedding: true };
      }
      return {};
  }
}
