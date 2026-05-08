# AI abstraction layer

This is the layer that makes "swap any model behind any agent" a build-time configuration, not a code change. Lives in `packages/llm`.

## Surface

A single TypeScript package, consumed by the runner, the orchestrator, and the API.

```ts
// packages/llm/src/index.ts
export { LlmModule } from './nest/llm.module';
export type {
  LLMProvider, ChatRequest, ChatResponse, ChatChunk, EmbedRequest, EmbedResponse,
  Message, ToolSpec, ToolCall, ToolResult,
  ModelCapability, ProviderRef, LlmProfile,
} from './types';
export { CapabilityRouter } from './routing/capability-router';
export { ProviderRegistry } from './registry/provider-registry';
```

## Normalized message shape

Mergecrew's internal message shape is OpenAI-flavored, with explicit handling for things OpenAI doesn't model natively (Anthropic-style thinking blocks, system/system-cacheable separation, tool-result attachments).

```ts
type Role = 'system' | 'user' | 'assistant' | 'tool';

type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

type SystemMessage = {
  role: 'system';
  content: ContentBlock[];
  cache?: 'ephemeral';                   // for Anthropic prompt cache
};

type UserMessage = {
  role: 'user';
  content: ContentBlock[];
};

type AssistantMessage = {
  role: 'assistant';
  content: ContentBlock[];               // can include text + tool_use
  thinking?: ContentBlock[];             // Anthropic thinking, dropped for non-supporting providers
};

type ToolMessage = {
  role: 'tool';
  toolUseId: string;
  content: ContentBlock[];
  isError?: boolean;
};

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageRef }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: ContentBlock[]; isError?: boolean };
```

Each provider implementation is responsible for translating to/from its native shape.

## Capability declaration

```ts
type ModelCapability = {
  reasoning?: boolean;        // CoT-shaped tasks
  tools?: boolean;            // function/tool calling
  parallelTools?: boolean;    // multiple tool calls per turn
  vision?: boolean;
  longContext?: 200_000 | 1_000_000;
  embedding?: boolean;
  thinking?: boolean;         // Anthropic-style extended thinking
  promptCache?: boolean;      // server-side prompt caching
  responseJsonSchema?: boolean;
  lowLatency?: boolean;       // small/fast model class
};
```

A provider declares per-model capability:

```ts
class AnthropicProvider implements LLMProvider {
  capabilities(model: string): ModelCapability {
    if (model === 'claude-opus-4-7') {
      return { reasoning: true, tools: true, parallelTools: true, vision: true,
               longContext: 1_000_000, thinking: true, promptCache: true,
               responseJsonSchema: false };
    }
    // …
  }
}
```

## Capability routing

`CapabilityRouter` resolves a request like "I need reasoning + tools + 200k context" to a concrete `(providerId, modelId)`:

```ts
class CapabilityRouter {
  resolve(req: { capability: ModelCapability; profile: LlmProfile;
                 override?: ProviderRef }): ProviderRef {
    if (req.override && this.satisfies(req.override, req.capability)) return req.override;
    for (const candidate of req.profile.preferenceOrder) {
      if (this.satisfies(candidate, req.capability) && this.healthy(candidate)) {
        return candidate;
      }
    }
    throw new NoSuitableProviderError(req.capability);
  }
}
```

`profile.preferenceOrder` is what the org configured (e.g., `["anthropic/claude-opus-4-7", "bedrock/anthropic.claude-opus-4-7", "openai/gpt-5"]`).

`healthy()` consults a circuit breaker: providers with recent error rates above threshold are temporarily skipped.

## Fallover

Two fallover triggers:

1. **At resolve time** — primary provider's circuit breaker is open → next candidate.
2. **At call time** — provider returned a retryable error (5xx, transient timeout). The router picks the next candidate; the same `messages` are submitted. **429 is *not* in this set** — 429 returns up to the orchestrator (see runtime doc).

Capability gating still applies on fallover. We never silently fall back to a model that can't do tool use when the request requires it.

## Streaming

`ChatRequest.onChunk` receives normalized chunks:

```ts
type ChatChunk =
  | { kind: 'text_delta'; text: string }
  | { kind: 'tool_use_start'; id: string; name: string }
  | { kind: 'tool_use_delta'; id: string; argsDelta: string }   // JSON fragment
  | { kind: 'tool_use_complete'; id: string }
  | { kind: 'thinking_delta'; text: string }                    // Anthropic-only
  | { kind: 'usage_partial'; outputTokens: number };
```

The runner forwards a redacted version (no raw tokens, just "writing file X") to the timeline; the full chunk stream is written to the transcript blob.

## Embeddings

```ts
interface LLMProvider {
  embed(req: EmbedRequest): Promise<EmbedResponse>;
}

type EmbedRequest = { model: string; input: string[]; dimensions?: number };
type EmbedResponse = { vectors: number[][]; usage: { totalTokens: number } };
```

Used by the project Memory store. Per-org embedding model is configurable; default is OpenAI `text-embedding-3-small` (cheap, broadly available). Bedrock and Ollama embedding implementations are V1.

## Provider registry & secrets

- Providers are instantiated per org at runner start, lazily.
- Secret retrieval: the runner asks the API for a short-lived decrypted credential per request, scoped to the call. The runner never holds the org's key in memory longer than one chat call.
- Provider clients are not shared across orgs in any in-memory pool.

## Cost & accounting

Each `chat()` returns `usage`. The runtime writes one `LlmInvocation` row per call:

```ts
type LlmInvocation = {
  id: string;
  organizationId: string;
  projectId: string;
  runId: string;
  agentStepId: string;
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number | null;
  latencyMs: number;
  usdEstimate: number;     // computed from price table
  occurredAt: Date;
};
```

The price table is per-provider, per-model, versioned. Price changes are dated; historical cost numbers are computed against the price at the time of invocation.

## Provider list (V1 implementation status)

| Provider | Chat | Tools | Vision | Embed | Stream | Notes |
|---|---|---|---|---|---|---|
| Anthropic | ✓ | ✓ | ✓ | – | ✓ | Primary; via Agent SDK when run as the agent runtime |
| OpenAI | ✓ | ✓ | ✓ | ✓ | ✓ | Includes GPT-5 Codex models |
| AWS Bedrock | ✓ | ✓ (model-dep.) | ✓ (model-dep.) | ✓ | ✓ | Anthropic / Mistral / Meta hosted |
| Ollama | ✓ | partial | – | ✓ | ✓ | Capability strictly declared per local model; user is responsible for installing capable models (e.g., Qwen3 32B) |

## Local-models lane (Ollama)

- Mergecrew supports Ollama as a real provider, not a toy.
- The org config declares the Ollama base URL (default `http://localhost:11434` for self-hosted Mergecrew; for SaaS, must be a routable URL with TLS).
- Each Ollama "provider entry" is bound to one base URL + one model id (e.g., `ollama/qwen3:32b`). Capability flags are user-declared at registration time and validated at first call by a probe.
- Local models are most often used for: cheap classification, local code review, embedding, "draft" passes. Not recommended as the primary model for tool-using agents unless the user has validated their local model handles tool use reliably.

## What we deliberately do not abstract

- **Per-provider safety/system features** (Anthropic tool-orchestrator, OpenAI function strict mode) when they materially help. We expose them as optional, not as "bring everyone to the lowest common denominator."
- **Token counting**. Each provider's tokenizer is its own; we trust their reported usage and don't pre-count.
- **Fine-tuning / batch APIs**. Out of scope for V1.
