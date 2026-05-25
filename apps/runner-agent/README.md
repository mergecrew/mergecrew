# `@mergecrew/runner-agent`

Bring-your-own runner agent for [Mergecrew](https://github.com/mergecrew/mergecrew). One process runs on **your** machine (laptop, EC2 box, k8s pod, anywhere with outbound HTTPS) and executes your org's steps locally, so a hosted Mergecrew deployment never has to run your containers on its own VM.

See [ADR-0002](../../docs/adrs/0002-per-org-runner-profile.md) and [ADR-0003](../../docs/adrs/0003-runner-agent-long-poll.md) for the model and transport choice.

## Status

Per [ADR-0009](../../docs/adrs/0009-byo-agent-as-remote-sandbox-driver.md), the agent is the **remote `SandboxDriver`** for steps owned by orgs whose `runner_profile.kind = 'agent'`. The deployment-side supervisor (`apps/runner`) runs the agent loop (`runStep`) and marshals each shell command / file op into a POST that the agent picks up via long-poll, executes locally (using a process or docker driver), and replies to.

**Status:** protocol + agent loop wired end-to-end (V2.ag steps 1–3). The supervisor-side wiring that routes agent-profile steps through `HttpSandboxDriver` instead of an in-process driver lands in V2.ag step 4 (in progress). Until step 4 lands, agent-profile steps land at the stub fail-closed boundary on the orchestrator side.

## Quickstart

After your org admin creates an enrollment token in **Settings → Runner agents** (UI lands in #765):

```sh
docker run --rm \
  --name mergecrew-runner-agent \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/mergecrew/runner-agent:latest \
    --token mca_acme_XXXXXXXXXXXXXXXXXXXXXXXXXX \
    --api-url https://mergecrew.dev \
    --name homelab-1 \
    --driver docker \
    --dry-run
```

### Flags

| Flag                  | Env                                              | Default    | Notes                                                                       |
| --------------------- | ------------------------------------------------ | ---------- | --------------------------------------------------------------------------- |
| `--token`             | `MERGECREW_AGENT_TOKEN` / `MERGECREW_AGENT_TOKENS` | _required_ | Bearer issued from the org settings UI. Repeat `--token` for multi-org.     |
| `--api-url`           | `MERGECREW_API_URL`                              | _required_ | Mergecrew API base URL.                                                     |
| `--name`              | `MERGECREW_AGENT_NAME`                           | `hostname` | Display name in the org settings.                                           |
| `--driver`            | `MERGECREW_AGENT_DRIVER`                         | `docker`   | `process` (no isolation) or `docker`.                                       |
| `--concurrency`       | `MERGECREW_AGENT_CONCURRENCY`                    | `1`        | Parallel jobs per token; total in-flight = `concurrency × tokens.length`.   |
| `--dry-run`           | `MERGECREW_AGENT_DRY_RUN`                        | `0`        | Print config and exit.                                                      |
| `--help`              | —                                                |            | Show usage.                                                                 |

### Multi-org mode (#774)

One agent process can host pollers for **N orgs at once** — handy for a homelab box that serves both your personal and work tenants, or a contractor who runs a single VM for several clients. Each token still belongs to exactly one org; the agent spawns one independent poller per token, so a busy step for org A doesn't stall org B.

Specify tokens in either of these forms:

```sh
# Repeated CLI flag — wins over any env var
docker run --rm ghcr.io/mergecrew/runner-agent:latest \
  --token mca_acme_AAA... \
  --token mca_beta_BBB... \
  --api-url https://mergecrew.dev

# Comma-separated env (single value also accepted via legacy MERGECREW_AGENT_TOKEN)
docker run --rm \
  -e MERGECREW_AGENT_TOKENS=mca_acme_AAA...,mca_beta_BBB... \
  -e MERGECREW_API_URL=https://mergecrew.dev \
  ghcr.io/mergecrew/runner-agent:latest
```

Resolution order is **repeated `--token`** > `MERGECREW_AGENT_TOKENS` (csv) > legacy `MERGECREW_AGENT_TOKEN` (single). Each poller logs with a `token` field carrying the `mca_<org>_<6>` prefix so `jq -r 'select(.token=="mca_acme_ABC123")'` filters per-org. A revoked token (`401`) only tears down its own poller — the rest keep running.

### Recommended setup

- **Outbound HTTPS only.** The agent makes no inbound connections; no port exposure needed.
- **`/var/run/docker.sock` mount** for the `docker` driver. Without it the agent can't launch sandboxes for jobs.

### Self-host: skip the agent

If you're running Mergecrew locally (`docker compose -f docker-compose.full.yml up`), you don't need this image — your org is the deployment owner, the trusted-org gate places you in the `instance_builtin` profile, and the bundled supervisor runs work for you. See [`docs/03-infrastructure/16-self-host-runbook.md`](../../docs/03-infrastructure/16-self-host-runbook.md).

## Development

```sh
pnpm --filter @mergecrew/runner-agent build
pnpm --filter @mergecrew/runner-agent test
node apps/runner-agent/dist/main.js --token x --api-url http://localhost:4000 --dry-run
```
