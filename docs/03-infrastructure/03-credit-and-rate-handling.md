# Credit & rate-limit handling

Mergecrew runs unsupervised. The single biggest reason a daily run "stops working" is that an LLM provider returned a rate-limit, quota, or transient error. This doc defines the contract.

## Goals

1. **A 429 must never fail a run.** It must pause the affected branch and resume cleanly.
2. **Resume must be transparent to the user.** They see a marker on the timeline; they don't act.
3. **Provider failover must be a real path, not theoretical.** The fallback must already be configured and exercised.
4. **No runaway spend.** Per-org budgets (V1.x) and per-org concurrency caps (V1) are hard ceilings.
5. **Honest telemetry.** Time spent paused vs working is visible to the user.

## Provider error taxonomy

The runtime classifies provider responses into:

| Class | Examples | Action |
|---|---|---|
| `success` | 2xx with usable response | continue |
| `success_partial` | 2xx with truncated stream | retry the same call once |
| `rate_limited` | 429 with `Retry-After` | pause the step, schedule wake |
| `quota_exhausted` | 429 / 403 indicating monthly quota hit | pause, alert org admins |
| `auth_invalid` | 401 / 403 | pause, alert; require key rotation |
| `bad_request` | 400 with provider-confirmed schema error | fail the step with diagnostic |
| `transient_5xx` | 500/502/503/504, network errors | retry with backoff up to N |
| `model_unavailable` | model doesn't exist or is decommissioned | failover to next candidate |
| `safety_block` | provider safety system refused | fail the step; surface to user |
| `cancelled` | abort signal fired | cancelled |

Each class has a deterministic handler in the runner.

## Backoff & jitter

For `transient_5xx` (in-call retry):

- Up to 3 retries.
- Backoff: `base * 2^attempt + jitter(0..base)`. `base = 1s` for short ops, `base = 5s` for long ops.

For `rate_limited` (orchestrator-level pause):

- `wake_at = now + max(retryAfter, baseBackoff(attempts)) + jitter(0..30s)`.
- `baseBackoff(attempts) = min(60s * 2^attempts, 30 min)`.
- The same step's prior `attempts` count is preserved across pauses (does not reset).

## Provider fallover (in addition to pause)

For each agent's `modelRequirement`, the LlmProfile defines a preference order. Failover happens at:

- **Resolve time.** A provider whose circuit breaker is open is skipped.
- **Call time.** `transient_5xx`, `model_unavailable` cause the runner to swap providers and retry the same call.
- **Quota time.** `quota_exhausted` swaps providers if the next candidate uses different credentials (an OpenAI quota does not preclude an Anthropic call). If the next candidate uses the same credentials (e.g., two Anthropic models on the same key), pause is preferred.

`rate_limited` does *not* trigger fallover by default — fallover would mask the rate limit and bill the secondary unnecessarily. Tenants can opt in: "fallover on rate_limited if `Retry-After > 5m`."

## Circuit breaker

Per `(provider_id, model_id)`:
- Sliding window of last 50 calls.
- Open if error rate > 25% in the window.
- Half-open after 60s; one probe call decides.

Circuit-breaker state is stored in Redis with a TTL fallback so it doesn't permanently lock a provider out.

## Per-org budgets (V1.x)

- Daily $ ceiling (configurable; default off, then on with a warn-only soft cap).
- Hard stop when reached: the orchestrator declines new step dispatches; running steps complete.
- Surfaced on the timeline as `RUN_PAUSED_BUDGET`.
- Owner can raise the budget; the run resumes automatically.

## Per-org concurrency caps

- Max in-flight runs: 5 (default).
- Max concurrent agent steps across all runs: 20 (default).
- Max concurrent calls to a single provider: 8 (default).
- All raisable; capped by global platform limits to protect runner pool.

## Observability of pauses

Every pause writes a `run_pause` row and a TimelineEvent. The user sees:

- Why we paused (provider name + reason).
- When we'll resume (`wake_at`).
- A live countdown.
- A "force resume" button that replays the same step (for debugging — emits an audit event).

End-of-day metrics include:

- Total wall-clock time.
- Active time (steps actually running).
- Paused time (rate-limited / gate / budget).

## Provider-specific notes

### Anthropic

- Tier 1 keys hit RPM ceilings fast on tool-using workloads. Encourage Tier 3+ for serious use.
- `Retry-After` is honored.
- Prompt cache reduces effective rate-limit pressure: cached input tokens count against a separate, looser bucket.
- Use the Agent SDK's native handling where available.

### OpenAI

- `Retry-After-Ms` and `Retry-After` headers checked.
- Quota errors return `429` with `error.code = 'insufficient_quota'`; treated as `quota_exhausted`.

### AWS Bedrock

- Throttling is per-region, per-model.
- Errors are surfaced as `ThrottlingException` with retry guidance.
- Bedrock often has higher tail latencies; configure longer timeouts.
- Quota raises are AWS-side ticket, not in-product.

### Ollama

- Local servers don't rate-limit but can hit GPU memory or run out of CPU.
- 503 from Ollama is treated as `transient_5xx` with shorter backoff.
- The `model_unavailable` class is more common (user pulled wrong model).

## Run-level pause-and-resume narrative

A typical mid-afternoon flow when Anthropic Tier 1 hits the per-minute limit:

```
14:32  Backend Eng step 7   tool_use → repo.write_file (ok)
14:32  Backend Eng step 7   chat call -> 429 retry-after=180
14:32  ORCHESTRATOR         schedule resume at 14:35:13 (180s + 13s jitter)
14:32  TIMELINE             RUN_PAUSED_RATE_LIMIT (provider=anthropic)
14:32  Frontend Eng step 4  proceeds (different agent, idle on calls)
14:35  WORKER-CRON          wake_at reached
14:35  ORCHESTRATOR         re-dispatch Backend Eng step 7
14:35  Backend Eng step 7   chat call -> 200
14:35  TIMELINE             RUN_RESUMED
```

If the same step rate-limits 5 times in a row, the orchestrator escalates: pauses the changeset, surfaces "this changeset is repeatedly rate-limited" to the user with options (raise budget, switch provider, abandon).

## Failure modes we explicitly handle

- **Provider returns success with a tool call to a tool we don't know.** Return `bad_request`-class to the model, fail the step on third occurrence.
- **Provider streaming connection drops mid-response.** Retry once with fresh request. If it drops again, pause as `rate_limited`-equivalent (assume server overload).
- **Provider returns a tool call referencing a `tool_use_id` we don't have.** Treat as protocol error, fail the step.
- **`Retry-After` is absurd (>1h).** Cap at 30m for the orchestrator's pause; on resume, the same step will rate-limit again and re-pause if the server still wants the longer wait. This avoids runs being effectively stalled all day on a provider hiccup.
