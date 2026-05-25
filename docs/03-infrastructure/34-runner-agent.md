# BYO runner agent

The `mergecrew/runner-agent` container is the **bring-your-own** execution layer for orgs whose `runner_profile.kind = 'agent'`. The deployment never runs that org's containers on its own VM; the agent runs on the org's machine (laptop, EC2 box, EKS pod, anywhere with outbound HTTPS) and pulls jobs over a long-poll protocol.

Architectural rationale lives in [ADR-0002](../adrs/0002-per-org-runner-profile.md) (per-org runner profile), [ADR-0003](../adrs/0003-runner-agent-long-poll.md) (transport), [ADR-0004](../adrs/0004-runner-agent-token-storage.md) (token storage), and [ADR-0005](../adrs/0005-per-profile-queues.md) (queue topology).

## Status (V2.af)

The **protocol scaffolding** ships in #766 — long-poll, heartbeat, events, outcome — end-to-end and visible in the run timeline. The **agent-side executor is a stub**: it acknowledges the job and immediately reports `byo_executor_not_implemented`. Real execution (sandbox + skill orchestration) lands in follow-up [#782](https://github.com/mergecrew/mergecrew/issues/782).

What this means for now:

- Operators can enrol, run, and observe an agent end-to-end (online badge, heartbeat, audit log).
- A step that lands on the agent fails closed with a clear reason in the timeline.
- The orchestrator's `onStepReply` consumes the agent's outcome the same way it consumes the supervisor's, so workflows advance / pause cleanly.

When #782 ships, no protocol changes are required — only the executor body changes.

## Quickstart

After your org admin issues an enrolment token at **Settings → Runner agents → Enrol agent**:

```sh
docker run --rm \
  --name mergecrew-runner-agent \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/mergecrew/runner-agent:latest \
    --token mca_<orgSlug>_XXXXXXXXXXXXXXXXXXXXXXXXXX \
    --api-url https://mergecrew.dev \
    --name homelab-1 \
    --driver docker
```

The agent will log `agent online` on first contact, then settle into the poll loop. The org settings page shows the agent's `lastSeenAt` updating.

## Configuration

| Flag                  | Env                            | Default     | Notes                                            |
| --------------------- | ------------------------------ | ----------- | ------------------------------------------------ |
| `--token`             | `MERGECREW_AGENT_TOKEN`        | _required_  | Bearer issued from the org settings UI.          |
| `--api-url`           | `MERGECREW_API_URL`            | _required_  | Mergecrew API base URL.                          |
| `--name`              | `MERGECREW_AGENT_NAME`         | `hostname`  | Display name in the org settings.                |
| `--driver`            | `MERGECREW_AGENT_DRIVER`       | `docker`    | `process` (no isolation) or `docker`.            |
| `--concurrency`       | `MERGECREW_AGENT_CONCURRENCY`  | `1`         | Parallel jobs (#782+).                           |
| `--dry-run`           | `MERGECREW_AGENT_DRY_RUN`      | `0`         | Print config and exit.                           |

## Network posture

- **Outbound HTTPS only.** The agent makes no inbound connections. Allow `${MERGECREW_API_URL}` egress; no port forwarding needed.
- **Idle long-poll budget: 30 s.** Set the load balancer / proxy `idle_timeout` to ≥ 35 s on the API side.
- **Docker socket bind** is recommended for the `docker` driver. Otherwise set `DOCKER_HOST` to a remote daemon.

## Protocol (for #782 implementors + debugging)

### Job-lifecycle endpoints (#766)

Authenticated with `Authorization: Bearer <agent-token>`.

| Endpoint                                       | Purpose                                                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/runner-agent/poll`                   | Long-poll the org's job queue (`runner-agent:queue:<orgId>`). Returns `{kind:'idle'}` after `timeout=<sec>` (max 30) or `{kind:'job', ...payload}` on hit. |
| `POST /v1/runner-agent/heartbeat`              | `{stepId}` body. Bumps `agent_steps.heartbeat_at`. The orchestrator's heartbeat sweeper considers a step live so long as this advances within its staleness threshold. |
| `POST /v1/runner-agent/steps/:stepId/events`   | `{type, payload}`. v1 stores into the audit log; v1.1 (#782) will route into the Eventlog with `dailyRunId`/`workflowRunId` scope so the timeline picks events up live. |
| `POST /v1/runner-agent/steps/:stepId/outcome`  | `{kind: 'completed' | 'failed' | 'cancelled', reason?, output?}`. Closes the step and enqueues an `orchestrator.step-reply` job so the workflow advances. |

### Sandbox-op mediator (V2.ag / ADR-0009 step 2)

Three endpoints, **two auth modes**: the supervisor uses the shared `MERGECREW_INTERNAL_TOKEN` for dispatch; the agent uses its bearer token for poll + result.

| Endpoint                                                       | Auth                    | Purpose                                                                                                                                 |
| -------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/runner-agent/sandbox-ops/:stepId/:op`                | `Bearer $INTERNAL_TOKEN`| Supervisor's `HttpSandboxDriver` calls this per op. Server generates `opId`, LPUSHes `{opId, op, args}` to `runner-agent:sandbox-ops:<stepId>`, BRPOPs `runner-agent:sandbox-results:<stepId>:<opId>` (max 15min), returns the agent's result envelope verbatim. |
| `POST /v1/runner-agent/sandbox-ops-poll`                       | `Bearer <agent-token>`  | Body `{stepId, timeoutSec?}` (default 30s, capped at 30s). BRPOPs the per-step ops list. Returns `{kind:'idle'}` or `{kind:'op', opId, op, args}`. Validates the step belongs to the agent's org. |
| `POST /v1/runner-agent/sandbox-ops/:stepId/:opId/result`       | `Bearer <agent-token>`  | Body `{ok: bool, result?, error?}`. LPUSHes the envelope onto the result list, unblocking the supervisor's BRPOP. Sets a 1h TTL on the key. |

Why two queues per step (ops + per-op result) instead of one shared channel: results are correlated by `opId`, and the supervisor needs to wait on **its specific** dispatch, not whichever ops finish first. A per-`opId` result list gives BRPOP exactly one thing to wake on.

Why the supervisor calls the API at all (rather than going directly to Redis): keeps a single auth + audit surface for everything that crosses the boundary, lets the same code path serve self-host deployments where the supervisor and API are on different hosts.

The supervisor-side wiring (replacing the in-process `SandboxDriver` with `HttpSandboxDriver` for `kind=agent` steps) lands in a subsequent PR (V2.ag step 4).

## Operations

### Online/offline badge

The org settings UI computes the badge from `last_seen_at`:

- **Green** when `now - last_seen_at < 60s`.
- **Amber** when `< 5 min`.
- **Grey** when older or unset.

The dedicated profile-editor + badge UI ships in [#767](https://github.com/mergecrew/mergecrew/issues/767).

### Revoking

**Settings → Runner agents → Revoke** sets `revoked_at`. The next agent call (any of `/poll`, `/hello`, `/heartbeat`, etc.) returns 401 and the container exits 4. Issue a new token to re-enrol.

### Switching the org to the agent profile

**Settings → Runner → Change profile → BYO agent → Save**. Server validates the trusted-org gate on every PATCH; non-trusted orgs only see the BYO options.

### Troubleshooting

- **Agent shows offline in UI.** Check the container logs — the only outbound dependency is the API URL. Look for connection refused / DNS failure.
- **Agent shows online but jobs don't reach it.** Verify the org's `runner_profiles.kind` is `agent` and that the orchestrator logged `runner.profile_dispatch` with `kind=agent` for the run.
- **`401 from /poll`.** Token revoked or unknown. Re-enrol.
- **`runner_not_configured` in the timeline.** Org has `kind=none` (or a kind without a working dispatcher). Configure the profile from the UI or via the SQL above.

### Long-running deployments

#### `docker-compose` (example)

```yaml
services:
  mergecrew-runner-agent:
    image: ghcr.io/mergecrew/runner-agent:latest
    restart: unless-stopped
    environment:
      MERGECREW_AGENT_TOKEN: ${MERGECREW_AGENT_TOKEN}
      MERGECREW_API_URL: https://mergecrew.dev
      MERGECREW_AGENT_NAME: ${HOSTNAME}
      MERGECREW_AGENT_DRIVER: docker
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

#### `systemd` unit (example)

```ini
[Unit]
Description=Mergecrew runner-agent
After=docker.service
Requires=docker.service

[Service]
ExecStart=/usr/bin/docker run --rm \
  --name mergecrew-runner-agent \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e MERGECREW_AGENT_TOKEN=mca_... \
  -e MERGECREW_API_URL=https://mergecrew.dev \
  ghcr.io/mergecrew/runner-agent:latest
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```
