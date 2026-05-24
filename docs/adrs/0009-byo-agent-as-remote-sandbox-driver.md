# ADR-0009: BYO runner agent as a remote `SandboxDriver`

**Status:** Accepted — 2026-05-24.

## Context

V2.af shipped the BYO runner-agent enrollment + long-poll protocol (#765/#766) with a **stub executor**: the agent acknowledges jobs but reports `byo_executor_not_implemented`. Two follow-ups depend on this gap closing — #782 (the executor itself) and #786 (Fargate-BYO dispatcher, which is structurally the same problem). Until #782 lands, no agent-profile org can actually execute a step.

We have three credible shapes for the executor (also enumerated in [#782's issue body](https://github.com/mergecrew/mergecrew/issues/782)):

- **A. Agent as a remote `SandboxDriver`.** Deployment-side keeps running `runStep` (LLM router, skill orchestration, eventlog, DB writes). Per-step, the only thing that lands on the agent is sandbox compute — every `driver.start/exec/readFile/writeFile/kill/stop` call goes over HTTPS to the agent, which executes it against a local `process` or `docker` driver and posts the result back.
- **B. Agent runs full `runStep` with shared credentials.** Agent has `DATABASE_URL`, `KMS_MASTER_KEY`, `GITHUB_APP_*`, LLM provider keys. Just a remote `apps/runner` instance.
- **C. Agent runs full `runStep` with deployment-mediated calls.** Agent has no DB / LLM keys; every DB read/write and every LLM call is an HTTPS call to the deployment.

## Decision

We will use **Architecture A — the agent is a remote `SandboxDriver` implementation**.

Mechanically:

1. New `HttpSandboxDriver` in `packages/sandbox-driver` implements the existing `SandboxDriver` interface (`packages/sandbox-driver/src/types.ts`). Each method (`start`, `exec`, `readFile`, `writeFile`, `kill`, `stop`) marshals its arguments, posts to a deployment-side per-step queue, and awaits the agent's reply.
2. The supervisor (`apps/runner`) consumes a single `runner.step.instance` queue as today. The orchestrator continues to route per-org per ADR-0005, but for `kind=agent` the supervisor still picks up the job — it just instantiates `HttpSandboxDriver` instead of the local driver when the job's payload carries `executor: 'agent'`.
3. The agent's existing `/v1/runner-agent/poll` loop (#766) is repurposed: instead of receiving the full job for local execution, the agent claims responsibility for serving sandbox ops for that step. A second long-poll endpoint `POST /v1/runner-agent/sandbox-ops/poll` returns the next op (`{ kind: 'exec', args }`); the agent executes it locally and posts to `POST /v1/runner-agent/sandbox-ops/:opId/result`.
4. The per-org agent queue (`runner-agent:queue:<orgId>`, raw Redis list per ADR-0005) keeps its current role for **claiming** — the first agent to BRPOP a job becomes the sandbox host for the duration of that step.

## Consequences

**Good.**
- Server-side credentials stay server-side. The agent has no `DATABASE_URL`, no `KMS_MASTER_KEY`, no LLM keys, no `GITHUB_APP_*`. The blast radius of an agent compromise is one step's worth of sandbox compute.
- `runStep` doesn't need to change. The 3,200-line file in `apps/runner/src/step.ts` already talks to its `SandboxDriver` through the interface; we plug a different implementation in for agent-profile orgs.
- The same `HttpSandboxDriver` works for #786 (Fargate-BYO). The Fargate dispatcher becomes "start an ECS task that runs `mergecrew/runner-agent`, then the supervisor's `HttpSandboxDriver` connects to it." No separate Fargate executor.
- #772 (`github-actions` profile) collapses to the same shape: the user's GHA workflow runs `mergecrew/runner-agent --one-shot`, which serves sandbox ops for one step then exits.

**Bad.**
- Latency. Every shell command in a build (each `npm run lint`, each test) is a round-trip to the agent. For a build with 200 sub-commands this is 200 × RTT extra. Mitigation: batch contiguous exec calls in the driver where the agent supports it; LLM-driven step durations dwarf shell-RTT in practice.
- A new long-running connection state for sandbox-ops (per-step). Mitigated by reusing the existing `runner-agent` long-poll pattern — no new infrastructure shape.
- More moving parts than option B. Option B is genuinely simpler but trades the security/cost story we built V2.af on.

## Alternatives considered

- **Architecture B (agent runs full `runStep` with shared credentials).** Rejected. Defeats the entire V2.af tenancy story — at that point the agent IS the deployment's runner with a copy of its secrets.
- **Architecture C (deployment-mediated DB/LLM calls).** Strongest isolation. Rejected for v1 because it requires a much larger protocol (every Prisma query becomes an HTTPS round-trip) for a marginal security gain over A.
- **Run `runStep` inside `apps/api` instead of `apps/runner`.** Rejected. The API serves request-scoped traffic; long-running step execution would interleave poorly with the existing throughput. The supervisor's BullMQ Worker model is exactly the right shape.

## Rollout plan

1. **ADR + skeleton driver class** (this PR). Define the interface implementation; no API wiring, no agent changes. Lets the contract land cleanly.
2. **Sandbox-op queue infra + API endpoints.** Per-step Redis lists + the two new endpoints on the agent-public controller.
3. **Agent-side `/sandbox-ops` poll loop.** Replace the stub executor with the real one.
4. **Supervisor wiring.** Job payload carries `executor: 'agent' | 'local'`; supervisor picks the driver. Existing instance-builtin path unchanged.
5. **E2E.** An agent-profile org runs a full step.
6. **#786 Fargate-BYO dispatcher.** Launches `runner-agent` as an ECS task; reuses everything above.
7. **#772 GitHub Actions profile.** Same shape.

Each step is independently shippable and leaves the platform in a known state.

## Realized in

- This PR — ADR + (separately) the skeleton `HttpSandboxDriver` class with unit tests.
- Subsequent PRs in the V2.ag milestone cover steps 2–7.
