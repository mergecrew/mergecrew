# ADR-0003: Pull-based long-poll transport for runner-agent

**Status:** Accepted — 2026-05-23.

## Context

The `runner-agent` (a user-run container that executes their org's steps on their own machine or cloud account) needs a transport to receive jobs from the deployment's API. Three credible options:

1. **HTTPS long-poll.** Agent calls `POST /api/v1/runner-agent/poll`; server holds the request up to 30s on a `BRPOP` and returns either `{ kind: 'idle' }` or `{ kind: 'job', … }`. Status/log updates flow back as separate HTTPS calls. This is the model used by GitHub Actions self-hosted runners, GitLab agents, Buildkite agents.
2. **WebSocket (or SSE) push.** Server pushes jobs the moment they're enqueued. Sub-second pickup latency. Stateful — requires sticky sessions on the load balancer or a state-store-backed dispatcher.
3. **Webhook from API to agent.** Agent exposes an inbound endpoint, API posts when a job is ready. Requires the agent to be publicly addressable — defeats the BYO use case where users run an agent behind NAT.

Latency budget: a step is tens of seconds of LLM work. A 30s worst-case pickup delay is invisible against that. Operationally, the API runs behind AWS ALB; sticky-session WebSocket gateways add config we don't otherwise need.

## Decision

We will use HTTPS long-poll (option 1). The agent calls four endpoints:

- `POST /runner-agent/poll` — blocks up to 30s; returns idle or a job.
- `POST /runner-agent/heartbeat` — 15s interval, mirrors the supervisor's existing `RUNNER_HEARTBEAT_INTERVAL_MS`.
- `POST /runner-agent/steps/:id/events` — log lines, intermediate status events.
- `POST /runner-agent/steps/:id/outcome` — terminal result.

A separate queue per org (`runner.step.agent.<orgId>`) backs the poll endpoint, so each org's `BRPOP` only sees its own jobs (see ADR-0005).

## Consequences

- Works from behind any NAT or firewall — the agent makes only outbound HTTPS calls.
- No persistent connection state on the API side; trivially load-balanced.
- API now has a long-running request shape that ALB and request timeouts must accommodate (`idle_timeout` ≥ 35s on the listener).
- The API does redis `BRPOP` synchronously in the request handler; expect long-poll connections to count against API concurrency. Mitigation: queue cardinality is small (one queue per org with `agent` profile), and BRPOP releases immediately on enqueue.
- Worst-case 30s job pickup latency. For interactive `runNow` flows where the user is watching the timeline live, this could feel slow; if real users complain, revisit with the follow-up issue #771.

## Alternatives considered

- **WebSocket / SSE.** Rejected for v1: sticky sessions on AWS ALB add a config layer we'd otherwise avoid, and the 30s worst-case is invisible against step durations. SSE specifically would reuse the existing `timeline-sse.controller.ts` plumbing and is the natural escalation path if we revisit.
- **gRPC bidi-stream.** Same connection-state problem as WebSocket, plus a new client/server stack the project doesn't already use.
- **Inbound webhook to the agent.** Rejected: the primary BYO case is a developer running `docker run mergecrew/runner-agent` on a laptop. Making them expose a port to the internet kills the "5-minute onboarding" goal.
