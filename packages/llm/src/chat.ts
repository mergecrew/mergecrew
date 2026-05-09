import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage, AIMessage } from '@langchain/core/messages';
import type { ProviderRegistry } from './registry.js';
import type { Usage } from './types.js';

/**
 * One chat invocation against a provider/model. Produced after `chat()` runs.
 * Used by `onTurn` to persist `LlmInvocation` rows (or anything else).
 */
export interface ChatTurnRecord {
  providerId: string;
  modelId: string;
  usage: Usage;
  latencyMs: number;
}

export interface ChatResult {
  content: string;
  usage: Usage;
  providerId: string;
  modelId: string;
  latencyMs: number;
  /** Original AIMessage in case the caller needs raw fields (tool calls, etc). */
  message: AIMessage;
}

interface ChatBaseOptions {
  providerId: string;
  modelId: string;
  messages: BaseMessage[];
  signal?: AbortSignal;
  /** Persist the turn (LlmInvocation row, telemetry, …). Awaited if Promise. */
  onTurn?: (record: ChatTurnRecord) => Promise<void> | void;
}

interface ChatViaRegistry extends ChatBaseOptions {
  registry: ProviderRegistry;
  maxTokens?: number;
  temperature?: number;
}

interface ChatViaModel extends ChatBaseOptions {
  /** Pre-built model — used by tests to inject a fake model. */
  model: BaseChatModel;
}

export type ChatOptions = ChatViaRegistry | ChatViaModel;

/**
 * Provider-agnostic chat call. Wraps LangChain's `BaseChatModel.invoke()`,
 * extracts a normalized `Usage`, and lets the caller persist the invocation
 * via `onTurn` — which is how the runner writes `LlmInvocation` rows.
 *
 * Two ways to call:
 *   - `chat({ registry, providerId, modelId, ... })` — production path
 *   - `chat({ model, providerId, modelId, ... })`    — pre-built model
 *     (used by tests with a `FakeListChatModel` so we don't need API keys)
 */
export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const model =
    'model' in opts
      ? opts.model
      : opts.registry.buildModel(opts.providerId, opts.modelId, {
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
        });

  const startedAt = Date.now();
  const res = (await model.invoke(opts.messages, { signal: opts.signal })) as AIMessage;
  const latencyMs = Date.now() - startedAt;

  const usage = extractUsage(res);
  const content = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);

  if (opts.onTurn) {
    await opts.onTurn({
      providerId: opts.providerId,
      modelId: opts.modelId,
      usage,
      latencyMs,
    });
  }

  return {
    content,
    usage,
    providerId: opts.providerId,
    modelId: opts.modelId,
    latencyMs,
    message: res,
  };
}

/**
 * Extract a normalized `Usage` from a LangChain AIMessage's `usage_metadata`.
 * LangChain has settled on this field across providers; older releases used
 * provider-specific keys, hence the defensive `?.`.
 */
export function extractUsage(msg: AIMessage): Usage {
  const meta = (msg as unknown as { usage_metadata?: Record<string, any> }).usage_metadata ?? {};
  const inputTokens = Number(meta.input_tokens ?? 0);
  const outputTokens = Number(meta.output_tokens ?? 0);
  const totalTokens = Number(meta.total_tokens ?? inputTokens + outputTokens);
  const inputDetails = meta.input_token_details ?? {};
  const outputDetails = meta.output_token_details ?? {};
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: inputDetails.cache_read,
    cacheWriteTokens: inputDetails.cache_creation,
    thinkingTokens: outputDetails.reasoning,
    totalTokens,
  };
}
