# Agentic runtime

The runtime is the loop that turns an `Agent` definition into work performed against the connected systems. It is provider-agnostic at the top and provider-specific at the bottom.

## Goals

- One agent loop, many providers (Anthropic, OpenAI, Bedrock, Ollama).
- Streamed events end-to-end (timeline updates as the agent works).
- Bounded blast radius: every tool call goes through a vetted Skill, never raw shell.
- Durable: every step result is checkpointed so a process restart can resume.
- Inspectable: every prompt, every tool call, every model response is replayable.

## Anatomy of an Agent

```ts
type AgentDefinition = {
  kind: AgentKind;                // e.g., "BackendEngineer"
  systemPrompt: string;           // role-shaped, role-specific
  modelRequirement: ModelCapability;  // e.g., "reasoning+tools+200k"
  modelOverride?: string;         // e.g., "claude-opus-4-7"
  fallbacks?: ProviderRef[];      // e.g., ["bedrock/anthropic.claude-opus-4-7"]
  skills: SkillRef[];             // names; the runtime resolves to instances
  doNotTouch: GlobPattern[];      // path patterns the agent must not write
  maxStepsPerRun?: number;        // default 12
  maxToolCallsPerStep?: number;   // default 8
  budget?: { tokens?: number; usd?: number };
};
```

## Anatomy of a Skill

```ts
type SkillDefinition = {
  name: string;                   // e.g., "repo.write_file"
  description: string;            // shown to the model as the tool spec
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  sideEffectClass: 'read' | 'write_workspace' | 'write_external' | 'irreversible';
  capabilities: SkillCapability[]; // e.g., ["fs.write", "git.commit"]
  execute(input: unknown, ctx: SkillExecutionContext): Promise<unknown>;
};
```

A `Skill` instance binds a `SkillDefinition` to the project's adapter configs (e.g., the `deploy.dev` skill carries the GitHub Actions workflow filename + repo).

## The agent loop

Pseudocode for one `AgentStep`:

```ts
async function runAgentStep(step: AgentStep, ctx: RunCtx): Promise<StepOutcome> {
  const agent = ctx.agentDefs[step.agentRef];
  const tools = ctx.skills.toolSpecs(agent.skills);

  let messages = buildInitialMessages(agent, step.input);
  let totalTokens = 0;
  let toolCallsMade = 0;

  for (let i = 0; i < (agent.maxStepsPerRun ?? 12); i++) {
    const provider = ctx.llm.resolve(agent.modelRequirement, agent.modelOverride);

    let response: ChatResponse;
    try {
      response = await provider.chat({
        model: provider.modelId,
        messages,
        tools,
        stream: true,
        onChunk: chunk => ctx.eventlog.emit({ type: 'AGENT_STEP_CHUNK', payload: chunk }),
      });
    } catch (e) {
      if (isRateLimited(e)) {
        return { kind: 'rate_limited', retryAfterMs: e.retryAfterMs ?? 60_000 };
      }
      if (await ctx.llm.canFallover(provider, e)) {
        continue; // fallover swap, retry same iteration
      }
      throw e;
    }

    totalTokens += response.usage.totalTokens;
    persistModelTurn(ctx, step.id, response);

    if (response.toolCalls.length === 0) {
      // Final assistant message
      return {
        kind: 'completed',
        output: response.text,
        toolCallsMade,
        totalTokens,
      };
    }

    for (const call of response.toolCalls) {
      if (++toolCallsMade > (agent.maxToolCallsPerStep ?? 8)) {
        return { kind: 'failed', reason: 'tool_call_budget_exhausted' };
      }
      const allowed = ctx.policy.check(agent, call);
      if (!allowed.ok) {
        // E.g., write to a do-not-touch path → escalate to human gate
        const escalation = await ctx.gates.escalate(allowed.reason, call, step);
        if (escalation === 'reject') {
          return { kind: 'gated_reject', reason: allowed.reason };
        }
        // 'approve' fall-through resumes execution
      }
      const result = await ctx.skills.execute(call, { agent, step, run: ctx.run });
      messages = appendToolResult(messages, call, result);
      ctx.eventlog.emit({ type: 'AGENT_TOOL_CALL', payload: { name: call.name, brief: result.brief } });
    }
  }

  return { kind: 'failed', reason: 'step_iteration_budget_exhausted' };
}
```

Key properties:
- **Single-process step.** A step runs to completion within one runner process call. If the runner crashes, the orchestrator re-dispatches the step (idempotent inputs; tool calls are idempotent or write-once).
- **Rate limits return up.** The runtime never sleeps inside the loop on a 429. It returns `rate_limited` to the orchestrator, which schedules a wake-up. This keeps runners free to serve other tenants.
- **Fallover is provider-aware.** If the primary provider supports tool use natively but the fallback is a small Ollama model that doesn't, fallover only happens for retryable transport errors, not for capability mismatch.
- **Skills are sandboxed.** Each skill execution is timed, output-bounded, and validated against its output schema before being fed back to the model.
- **Policy intercepts tool calls.** Don't-touch patterns, side-effect classes, and sensitive-area heuristics are checked here.

## Provider interface

```ts
interface LLMProvider {
  id: string;                                   // e.g., "anthropic-org-1"
  modelIds: string[];                           // declared models
  capabilities(model: string): ModelCapability;
  chat(req: ChatRequest): Promise<ChatResponse>;        // streams via callback
  embed(req: EmbedRequest): Promise<EmbedResponse>;
}

type ChatRequest = {
  model: string;
  messages: Message[];                          // OpenAI-shape, normalized
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'required' | { name: string };
  thinking?: { enabled: boolean; budgetTokens?: number };  // Anthropic
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  responseFormat?: 'text' | 'json' | { schema: JsonSchema };
  onChunk?: (chunk: ChatChunk) => void;
};

type ChatResponse = {
  text: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; totalTokens: number };
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'safety';
  raw: unknown;                                 // full provider response for replay
};
```

Implementations:

- `AnthropicProvider` — uses `@anthropic-ai/sdk`. Native tool use; native streaming; native prompt cache. **For Anthropic agents, Mergecrew uses the Claude Agent SDK as the per-step runtime** when present (it handles a richer agent loop natively, including thinking and prompt caching). The custom loop above is the fallback / non-Anthropic path.
- `OpenAIProvider` — uses `openai` SDK. Tool calls translated through OpenAI's `function`/`tool_calls` shape. Includes Codex-class coding models.
- `BedrockProvider` — uses AWS SDK; supports Anthropic, Mistral, Meta models hosted on Bedrock. The Anthropic-on-Bedrock path uses the same prompt as the direct Anthropic path.
- `OllamaProvider` — HTTP client to a user-supplied Ollama endpoint. Tool use via OpenAI-compatible `/api/chat`. Capability declarations are conservative (most local models don't do reliable tool use).

## Capability requirements & routing

Agents declare *capability*, not *model*:

```yaml
backend_engineer:
  model: capability:reasoning+tools+200k
```

The runtime resolves to a concrete provider+model at step start, in this order:

1. If a `modelOverride` is set, use it (subject to the provider being available and capable).
2. Otherwise, evaluate the org's `LlmProfile` to pick a primary provider/model that satisfies `ModelCapability`.
3. If primary is unavailable (down, key invalid), pick the next fallback from `agent.fallbacks` or the profile's default fallbacks.

`ModelCapability` is a union flag set: `reasoning`, `tools`, `vision`, `200k`, `1m`, `embedding`, `low-latency`.

## Skill execution context

```ts
type SkillExecutionContext = {
  agent: AgentDefinition;
  step: AgentStep;
  run: DailyRunContext;
  workspace: Workspace;          // a per-changeset git worktree
  adapters: {
    vcs: VcsProvider;
    deploy: DeployProvider;
    tracker: TrackerProvider | null;
    comms: CommsProvider | null;
  };
  policy: PolicyEngine;          // do-not-touch, side-effect class, gates
  eventlog: EventlogClient;      // emit timeline events
  budget: BudgetTracker;
  abortSignal: AbortSignal;      // run-level cancellation
};
```

Skills must:
- Validate inputs against `inputSchema` *before* doing work.
- Validate outputs against `outputSchema` *before* returning.
- Emit at least one timeline event for any side effect.
- Respect `abortSignal`.
- Time out within a per-skill default (most: 60s; deploys: 20m; tests: 10m).

## Budgets

Three layered budgets:

- **Per-step.** `maxToolCallsPerStep`, `maxIterationsPerStep`. Enforced in the loop.
- **Per-changeset.** Optional token/USD cap defined on the agent. Tracked across all of the changeset's steps.
- **Per-run / per-org.** Hard daily ceilings tracked in BudgetTracker; exceeding pauses further dispatch and notifies.

When a budget would be exceeded, the runtime returns `budget_exhausted` and the orchestrator decides whether to surface as a gated wait (user can raise) or a hard fail.

## Observability per step

Each `AgentStep` produces:

- `ModelTurn` rows: one per LLM call (input/output tokens, cached tokens, model id, latency, USD).
- `ToolCall` rows: one per skill invocation (skill, input hash, output hash, duration, side-effect class).
- `TimelineEvent`s: streamed and persisted.
- `transcript.json` blob in object storage: full prompt+response capture for replay.

## Replay

Given a `AgentStep` id, Mergecrew can re-run it offline:

- Reload the prompt and tool specs from the persisted definitions.
- Substitute the LLM provider with a "replay" provider that returns the recorded responses.
- Substitute skills with read-only versions that return recorded outputs.

This makes "did the model do something different?" / "what would have happened with model X instead?" a tractable engineering question.
