# `@mergecrew/runner-agent`

Bring-your-own runner agent for [Mergecrew](https://github.com/mergecrew/mergecrew). One process runs on **your** machine (laptop, EC2 box, k8s pod, anywhere with outbound HTTPS) and executes your org's steps locally, so a hosted Mergecrew deployment never has to run your containers on its own VM.

See [ADR-0002](../../docs/adrs/0002-per-org-runner-profile.md) and [ADR-0003](../../docs/adrs/0003-runner-agent-long-poll.md) for the model and transport choice.

## Status

**Skeleton release (#764).** The agent currently supports only `--dry-run`, which validates config and exits. Job pull + execution arrive in [#766](https://github.com/mergecrew/mergecrew/issues/766). Don't deploy this image yet for live runs.

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

| Flag                  | Env                          | Default     | Notes                                            |
| --------------------- | ---------------------------- | ----------- | ------------------------------------------------ |
| `--token`             | `MERGECREW_AGENT_TOKEN`      | _required_  | Bearer issued from the org settings UI.          |
| `--api-url`           | `MERGECREW_API_URL`          | _required_  | Mergecrew API base URL.                          |
| `--name`              | `MERGECREW_AGENT_NAME`       | `hostname` | Display name in the org settings.                |
| `--driver`            | `MERGECREW_AGENT_DRIVER`     | `docker`    | `process` (no isolation) or `docker`.            |
| `--concurrency`       | `MERGECREW_AGENT_CONCURRENCY`| `1`         | Parallel jobs (#766+).                           |
| `--dry-run`           | `MERGECREW_AGENT_DRY_RUN`    | `0`         | Print config and exit.                           |
| `--help`              | —                            |             | Show usage.                                      |

### Recommended setup

- **Outbound HTTPS only.** The agent makes no inbound connections; no port exposure needed.
- **`/var/run/docker.sock` mount** for the `docker` driver. Without it the agent can't launch sandboxes for jobs.
- **One token per host.** Multi-org agent support is a v1.1 follow-up ([#774](https://github.com/mergecrew/mergecrew/issues/774)).

### Self-host: skip the agent

If you're running Mergecrew locally (`docker compose -f docker-compose.full.yml up`), you don't need this image — your org is the deployment owner, the trusted-org gate places you in the `instance_builtin` profile, and the bundled supervisor runs work for you. See [`docs/03-infrastructure/16-self-host-runbook.md`](../../docs/03-infrastructure/16-self-host-runbook.md).

## Development

```sh
pnpm --filter @mergecrew/runner-agent build
pnpm --filter @mergecrew/runner-agent test
node apps/runner-agent/dist/main.js --token x --api-url http://localhost:4000 --dry-run
```
