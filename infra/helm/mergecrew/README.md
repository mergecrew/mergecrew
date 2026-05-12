# mergecrew Helm chart

Deploys the five mergecrew workloads (api, orchestrator, runner, worker-cron, web) onto a Kubernetes cluster. Postgres + Redis are NOT subcharts — bring your own (RDS / ElastiCache / a separate chart) and point the env block at them.

## Quick install

```sh
# 1. Create a Secret with the required keys. The chart will not render
#    raw secrets — they must come from an existing Secret reference.
kubectl create secret generic mergecrew-secrets \
  --from-literal=DATABASE_URL='postgresql://...' \
  --from-literal=DATABASE_MIGRATE_URL='postgresql://...' \
  --from-literal=REDIS_URL='redis://...' \
  --from-literal=KMS_MASTER_KEY="base64:$(openssl rand -base64 32)" \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=NEXTAUTH_SECRET="$(openssl rand -hex 32)" \
  --from-literal=BFF_TRUST_TOKEN="$(openssl rand -hex 24)"

# 2. Install the chart.
helm install mergecrew infra/helm/mergecrew \
  --set image.api.tag=v0.1.0 \
  --set image.orchestrator.tag=v0.1.0 \
  --set image.runner.tag=v0.1.0 \
  --set image.workerCron.tag=v0.1.0 \
  --set image.web.tag=v0.1.0 \
  --set env.WEB_BASE_URL=https://mergecrew.example.com
```

You'll need to wire an Ingress (not included in this chart yet) to expose the `mergecrew-web` Service on a public hostname.

## Required Secret keys

| Key | Required | Why |
|---|---|---|
| `DATABASE_URL` | yes | App connection (RLS-enabled) |
| `DATABASE_MIGRATE_URL` | yes | Migration connection (BYPASSRLS) |
| `REDIS_URL` | yes | BullMQ queues + pubsub |
| `KMS_MASTER_KEY` | yes | AES-GCM key for org-stored provider credentials |
| `JWT_SECRET` | yes | JWT signing |
| `NEXTAUTH_SECRET` | yes | NextAuth session signing |
| `BFF_TRUST_TOKEN` | yes | Web → API trusted-caller token |
| `ANTHROPIC_API_KEY` | no | Only if not using BYOK per-org |
| `OPENAI_API_KEY` | no | Same |
| `GITHUB_APP_PRIVATE_KEY` | no | Only if connecting GitHub repos |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | no | Bedrock / S3 transcript store |
| `TRANSCRIPT_S3_BUCKET`, `S3_ENDPOINT_URL` | no | S3 transcript store |

Missing optional secrets cause the chart to render `optional: true` on those `secretKeyRef`s — they're silently absent in the container env, which is what the runtime code already expects (BYOK is opt-in).

## What you get

- **Five Deployments**: api, orchestrator, runner, worker-cron, web. Each pinned to its own image repo + tag.
- **Liveness + readiness probes** on each pod, pointing at `/healthz` (cheap) and `/readyz` (checks db/redis where applicable). See [`docs/03-infrastructure/01-overview.md`](../../../docs/03-infrastructure/01-overview.md) for endpoint contracts.
- **Resource requests + limits** per service. Defaults are conservative; runner gets the most CPU/mem because it's the workhorse.
- **Pod + container SecurityContext** — runAsNonRoot, drop ALL capabilities, no privilege escalation. `readOnlyRootFilesystem` is intentionally not set because Prisma occasionally writes engine binaries into node_modules at start.
- **Two Services** (api ClusterIP :4000, web ClusterIP :3000). Bring your own Ingress.
- **HPA stub**, off by default. Enable with `--set autoscaling.enabled=true`. Targets CPU 70% by default.

## What you don't get (yet)

- Ingress manifest — operators have too many shapes (nginx-ingress, traefik, AWS ALB, cloud-specific gateways) for one-size-fits-all. Wire one yourself, pointing `/` at `mergecrew-web` and `/v1/` at `mergecrew-api`.
- Postgres / Redis subcharts — see "bring your own" above.
- TLS / cert-manager wiring — your ingress's job.
- Network policies — opinionated and cluster-specific.

## Lint

```sh
helm lint infra/helm/mergecrew
```

Should be clean against a default `values.yaml`.

## Render a manifest snapshot

```sh
helm template mergecrew infra/helm/mergecrew \
  --set image.api.tag=v0.1.0 \
  --set image.orchestrator.tag=v0.1.0 \
  --set image.runner.tag=v0.1.0 \
  --set image.workerCron.tag=v0.1.0 \
  --set image.web.tag=v0.1.0
```

CI keeps a snapshot of this output (see `.github/workflows/`); if it drifts, the workflow fails and you re-snapshot.
