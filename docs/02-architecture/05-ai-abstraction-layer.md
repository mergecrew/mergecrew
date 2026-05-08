# AI abstraction layer

This is the layer that makes "swap any model behind any agent" a configuration change, not a code change. Lives in `@mergecrew/llm` (`packages/llm`).

## What `@mergecrew/llm` actually exports

```ts
// packages/llm/src/index.ts
export * from './types.js';            // Usage, LlmProfile
export * from './models.js';           // buildChatModel, capabilitiesFor, ProviderConfig, BuildModelOptions
export * from './registry.js';         // ProviderRegistry
export * from './router.js';           // CapabilityRouter, ResolveRequest, Resolved
export * from './circuit-breaker.js';  // CircuitBreaker
export * from './pricing.js';          // priceFor, estimateUsd
```

There is no Mergecrew-specific `LLMProvider`, `ChatRequest`, `ChatResponse`, `ChatChunk`, or `Message` type. The seam is LangChain's `BaseChatModel`. Every chat call goes through `model.invoke(messages)` (or `.stream()` if needed); LangChain handles tool-call translation, streaming, and provider drift.

## Provider configuration

Per-org provider rows are deserialized into `ProviderConfig`:

```ts
// packages/llm/src/models.ts
type ProviderKind = 'anthropic' | 'openai' | 'bedrock' | 'ollama';   // packages/domain/src/capability.ts:17

interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  apiKey?: string;             // BYOK; envelope-decrypted at config-load
  endpoint?: string;           // Ollama base URL
  awsRegion?: string;          // Bedrock region
  models: string[];            // allowed model ids for this provider
  capabilityOverrides?: Record<string, ModelCapability>;
}
```

## Building a chat model

`buildChatModel(cfg, modelId, opts)` returns a fresh LangChain `BaseChatModel` per call:

```ts
// packages/llm/src/models.ts:30-68
switch (cfg.kind) {
  case 'anthropic':
    return new ChatAnthropic({
      apiKey: cfg.apiKey, model: modelId,
      temperature: opts.temperature ?? 0.2,
      maxTokens: opts.maxTokens ?? 4096,
      ...(opts.thinkingBudgetTokens
          ? { thinking: { type: 'enabled', budget_tokens: opts.thinkingBudgetTokens } }
          : {}),
    });
  case 'openai':
    return new ChatOpenAI({ apiKey: cfg.apiKey, model: modelId, temperature, maxTokens });
  case 'bedrock':
    return new ChatBedrockConverse({ region: cfg.awsRegion ?? 'us-east-1', model: modelId, temperature, maxTokens });
  case 'ollama':
    return new ChatOllama({ baseUrl: cfg.endpoint ?? 'http://localhost:11434', model: modelId, temperature, numPredict: maxTokens });
}
```

The runner constructs a `ProviderRegistry` per agent step, so BYOK API keys do not live in memory across requests (`packages/llm/src/registry.ts:9-13`).

## Capability declaration

```ts
// packages/domain/src/capability.ts
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
```

`capabilitiesFor(cfg, modelId)` (`packages/llm/src/models.ts:75-117`) returns a `ModelCapability` either from `cfg.capabilityOverrides` (per-org override stored in the DB) or from a small built-in catalog keyed by provider kind + model prefix:

- `anthropic` `claude-{opus,sonnet,haiku}` → `tools, parallelTools, vision, promptCache, longContext: 200_000`; `thinking` for opus/sonnet.
- `openai` `gpt-4` / `gpt-5` / `o*` → `tools, parallelTools, responseJsonSchema, longContext: 200_000`; `vision` for `gpt-4o*` and `gpt-5*`.
- `bedrock` claude models → `tools, parallelTools, vision, longContext: 200_000`.
- `ollama` `qwen3*` → `tools, longContext: 200_000`. `nomic-embed*` → `embedding`. `llama3*` → `tools: false`.

## Capability routing

`CapabilityRouter.resolve()` (`packages/llm/src/router.ts:28-56`) walks `[override?, ...profile.preferenceOrder]` and returns the first candidate that:

1. is a registered provider id,
2. exposes the requested model id,
3. has capabilities that `satisfies()` the request,
4. has a closed circuit breaker on `${providerId}/${modelId}`.

```ts
satisfies(have: ModelCapability, need: ModelCapability): boolean {
  if (need.reasoning && !have.reasoning) return false;
  if (need.tools && !have.tools) return false;
  // … parallelTools, vision, embedding, thinking, promptCache,
  //   responseJsonSchema, lowLatency
  if (need.longContext) {
    const haveCtx = have.longContext ?? 0;
    if (haveCtx < need.longContext) return false;
  }
  return true;
}
```

`profile.preferenceOrder` is what the org configured — e.g., `["anthro-1/claude-sonnet-4-6", "bedrock-1/anthropic.claude-sonnet-4-6", "openai-1/gpt-5"]`. The format is `${providerId}/${modelId}`, not `${providerKind}/${modelId}`.

## Circuit breaker

```ts
// packages/llm/src/circuit-breaker.ts
const WINDOW_MS       = 60_000;
const FAIL_THRESHOLD  = 0.25;     // 25% failure ratio over the window
const MIN_SAMPLES     = 10;
const OPEN_DURATION_MS = 60_000;
```

After every `model.invoke()`, the runtime calls `router.recordOutcome(providerId, modelId, ok)`. Once a key crosses the threshold, `isOpen()` returns true for one minute and the router skips that pair. Capability gating still applies on the next attempt — we never silently fall back to a model that can't satisfy the request.

## Fallover

Two triggers:

1. **At resolve time.** Primary provider's breaker is open or the model is no longer registered → next candidate.
2. **At call time.** A non-rate-limit error after `model.invoke()` opens the breaker for that key (eventually); the next agent-loop iteration re-resolves and may pick a different candidate.

**429 / rate-limit is not a fallover trigger.** The runtime returns `{ kind: 'rate_limited' }` to the orchestrator, which schedules a wake-up. See `docs/02-architecture/04-agentic-runtime.md`.

## Streaming

LangChain's `BaseChatModel` supports `.stream()`. The current loop uses `.invoke()` and reads `usage_metadata` off the returned `AIMessage`; we will switch to `.stream()` when the timeline UI consumes intermediate text deltas. There is no Mergecrew-defined chunk taxonomy — LangChain's `AIMessageChunk` is the streaming type.

## Usage and cost

`Usage` is the only Mergecrew-defined type at this layer:

```ts
// packages/llm/src/types.ts
interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  thinkingTokens?: number;
  totalTokens: number;
}
```

The runtime extracts it from LangChain's `usage_metadata` (`packages/agent-runtime/src/loop.ts:294-307`):

```ts
const meta = (msg as any).usage_metadata ?? {};
const details = meta.input_token_details ?? {};
return {
  inputTokens:      meta.input_tokens ?? 0,
  outputTokens:     meta.output_tokens ?? 0,
  totalTokens:      meta.total_tokens ?? inputTokens + outputTokens,
  cacheReadTokens:  details.cache_read ?? 0,
  cacheWriteTokens: details.cache_creation ?? 0,
};
```

`priceFor(orgId, providerKind, modelId, occurredAt)` (`packages/llm/src/pricing.ts`) reads the latest matching row from `model_price_table` (versioned by `effectiveAt`). `estimateUsd(price, usage)` multiplies tokens by the per-million price for input, output, and (optionally) cache reads/writes. Historical cost is computed against the price effective at the time of invocation.

## Embeddings

Embeddings are not yet wired through this layer. The Memory store integration uses `pgvector` directly; provider-side embedding via LangChain's `Embeddings` class is on the contributor checklist — the catalog already declares `embedding: true` for `nomic-embed*` and OpenAI embedding models.

## Provider list

| Provider kind | Chat | Tools | Vision | Streaming | LangChain integration |
|---|---|---|---|---|---|
| `anthropic` | yes | yes | yes | yes | `@langchain/anthropic` `ChatAnthropic` |
| `openai`    | yes | yes | model-dep. | yes | `@langchain/openai` `ChatOpenAI` |
| `bedrock`   | yes | model-dep. | model-dep. | yes | `@langchain/aws` `ChatBedrockConverse` |
| `ollama`    | yes | model-dep. | no | yes | `@langchain/ollama` `ChatOllama` |

## Local-models lane (Ollama)

- Mergecrew supports Ollama as a real provider. The default endpoint is `http://localhost:11434` (override per provider via `cfg.endpoint`).
- Each Ollama provider entry binds to one base URL and an allowlist of model ids. Capabilities default conservatively (`qwen3*` → tools; `llama3*` → no tools); orgs can override via `capabilityOverrides`.
- Local models are most useful for cheap classification, code review, embeddings, and "draft" passes. They are not recommended as the primary model for tool-using agents unless the operator has validated the local model handles tool use reliably.

## What we deliberately do not abstract

- **Per-provider safety/system features** (Anthropic prompt caching markers, OpenAI strict function-call mode) when they materially help. We expose them via LangChain's provider options, not via a lowest-common-denominator wrapper.
- **Token counting**. Each provider's tokenizer is its own; we trust the `usage_metadata` returned with the response and don't pre-count.
- **Fine-tuning / batch APIs**. Out of scope.
