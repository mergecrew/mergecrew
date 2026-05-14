# Single-VM deploy via GHCR

How Mergecrew is shipped to a single production VM when you don't want a Kubernetes cluster or a managed PaaS. Build images in GitHub Actions, push them to GitHub Container Registry, then SSH into the VM and roll the compose stack forward.

For the application-level deploy patterns (Vercel, ECS, Fly, etc. — i.e. how Mergecrew deploys *user* code), see the [deploy-target cookbook](06-deploy-targets-cookbook.md). This page is about deploying Mergecrew itself.

## When to use this

Pick this shape if your production setup is:

- One VM (EC2, Hetzner, DO droplet, bare metal) running Docker.
- Host-installed Postgres (or a managed Postgres reachable from the VM).
- A host-installed reverse proxy (Caddy / nginx / Traefik) fronting `web:3000` and `api:4000` on `127.0.0.1`.
- Single replica per service is acceptable.

If you want HA, autoscaling, or multi-region, use the Helm chart at `infra/helm/mergecrew/` instead.

## Architecture

```
┌─────────────────────┐    push to main     ┌──────────────────────┐
│ GitHub repo (main)  │ ──────────────────► │ Actions: deploy-vm   │
└─────────────────────┘                     │  job 1: build & push │
                                            │  job 2: SSH & pull   │
                                            └──────┬───────────────┘
                                                   │
                              ┌────────────────────┼─────────────────────┐
                              │ build-and-push                            │
                              │   matrix: api, orchestrator, runner,      │
                              │           worker-cron, web                │
                              │   → ghcr.io/<org>/<svc>:<sha>             │
                              │   → ghcr.io/<org>/<svc>:latest            │
                              ▼                                            │
                       ┌───────────────┐                                   │
                       │ ghcr.io       │                                   │
                       └──────┬────────┘                                   │
                              │ docker pull                                │
                              ▼                                            │
                       ┌───────────────────────────────────────┐           │
                       │ Production VM                         │ ◄─────────┘
                       │  scripts/deploy-pull.sh <sha>:        │   SSH (job 2)
                       │   1. docker compose pull              │
                       │   2. prisma migrate deploy            │
                       │   3. docker compose up -d             │
                       │   4. docker image prune -f            │
                       └───────────────────────────────────────┘
```

Two GitHub Actions jobs:

1. **`build-and-push`** — matrix over the five services, builds each from its Dockerfile in `infra/docker/`, pushes to `ghcr.io/<org>/<svc>` with the commit SHA (12-char) and `latest` tags. Layer cache stored in GitHub Actions cache, scoped per service.
2. **`deploy`** — runs after `build-and-push`, SSHes into the VM, fast-forwards the on-disk repo to the commit being shipped, then runs `scripts/deploy-pull.sh <sha>`.

The pull script reads `docker-compose.prod.yml`, which references `ghcr.io/mergecrew/<svc>:${MERGECREW_TAG:-latest}`. The script sets `MERGECREW_TAG=<sha>` so the deploy is pinned to the exact images that were just built.

## First-time setup

### 1. Generate a deploy key for GitHub Actions → VM

On your workstation:

```sh
ssh-keygen -t ed25519 -f deploy-key -C github-actions-deploy -N ""
```

You now have `deploy-key` (private) and `deploy-key.pub` (public).

### 2. Authorize the key on the VM

Append the public line to the deploy user's authorized_keys:

```sh
# On the VM, as the user that owns the repo checkout (e.g. ec2-user):
cat >> ~/.ssh/authorized_keys < deploy-key.pub
```

### 3. Configure GitHub repo secrets

Repo → Settings → Secrets and variables → Actions → **Secrets** tab:

| Name | Value |
|---|---|
| `DEPLOY_HOST` | VM hostname or IP |
| `DEPLOY_USER` | User on the VM (e.g. `ec2-user`) |
| `DEPLOY_SSH_KEY` | Full contents of the **private** key file, including the `-----BEGIN/END OPENSSH PRIVATE KEY-----` lines |
| `DEPLOY_PORT` | Optional; only set if SSH isn't on 22 |

Shred your local copy of the private key after pasting it into the secret:

```sh
shred -u deploy-key deploy-key.pub
```

### 4. Configure GitHub repo variables

Same page, **Variables** tab:

| Name | Default | Set to |
|---|---|---|
| `VM_DEPLOY_ENABLED` | unset → workflow only runs on manual dispatch | `true` to enable push-to-main auto-deploy |
| `VM_REPO_PATH` | `/home/ec2-user/data/mergecrew` | Override only if the repo lives elsewhere on the VM |
| `VM_BUILD_RUNNER` | `ubuntu-24.04-arm` (ARM-native) | `ubuntu-latest` if your VM is amd64 |
| `VM_BUILD_PLATFORM` | `linux/arm64` | `linux/amd64` (single) or `linux/amd64,linux/arm64` (multi-arch via QEMU) |

The arch defaults assume AWS Graviton. **If your VM is amd64, set both `VM_BUILD_RUNNER=ubuntu-latest` and `VM_BUILD_PLATFORM=linux/amd64`** before the first deploy — otherwise the pull on the VM will fail with `no matching manifest for linux/amd64`.

The `ubuntu-24.04-arm` runner requires a GitHub Team or Enterprise plan for private repos (free for public). If you're on a Free/Pro plan and your VM is ARM, set `VM_BUILD_RUNNER=ubuntu-latest` and `VM_BUILD_PLATFORM=linux/arm64`. QEMU will emulate arm64 on the amd64 runner — slower (~2-3× build time) but works on any plan.

### 5. GHCR package visibility

First push creates five packages under `github.com/orgs/<your-org>/packages`. Two options:

- **Public** — anyone can pull. No auth needed on the VM. Org admin must enable "Allow public packages" at the org level (`github.com/organizations/<org>/settings/packages`), then for each package: Package settings → Danger zone → Change visibility → Public.
- **Private** — only authorized identities can pull. On the VM, log in once: `echo <PAT_with_read:packages> | docker login ghcr.io -u <your-gh-username> --password-stdin`. Credentials persist in `~/.docker/config.json`.

### 6. Bootstrap the VM repo checkout

The deploy step expects the repo to already be cloned on the VM at `VM_REPO_PATH`, with a working `.env` next to `docker-compose.prod.yml`. One-time on the VM:

```sh
git clone https://github.com/<your-org>/mergecrew /home/ec2-user/data/mergecrew
cd /home/ec2-user/data/mergecrew
cp .env.example .env
$EDITOR .env  # fill in DATABASE_URL, KMS_MASTER_KEY, GitHub App secrets, etc.
```

The first deploy will run prisma migrations automatically. You don't need to run them by hand.

### 7. First deploy

Trigger manually before flipping the auto-deploy gate:

Actions → "Deploy to VM (GHCR)" → Run workflow → run on `main`.

This works even with `VM_DEPLOY_ENABLED` unset, thanks to the `workflow_dispatch` clause. Watch both jobs to green. Verify on the VM:

```sh
docker compose -f docker-compose.prod.yml ps
# All five services should show ghcr.io/<org>/<svc>:<sha> as the image, Up.
```

Once you've confirmed a clean deploy, set `VM_DEPLOY_ENABLED=true` so future merges to `main` ship automatically.

## How `scripts/deploy-pull.sh` works

Invoked as `./scripts/deploy-pull.sh <tag>` (the workflow passes the 12-char SHA; the default is `latest`):

```sh
TAG="${1:-latest}"
export MERGECREW_TAG="$TAG"
COMPOSE="docker compose -f docker-compose.prod.yml"

$COMPOSE pull api orchestrator runner worker-cron web
$COMPOSE --profile migrate run --rm migrate
$COMPOSE up -d
docker image prune -f >/dev/null
```

The compose file's image references are `ghcr.io/mergecrew/<svc>:${MERGECREW_TAG:-latest}`, so exporting `MERGECREW_TAG` pins the pull + restart to that exact tag.

`migrate` is a one-shot service under the `migrate` compose profile — same image as `api`, runs `prisma migrate deploy`, exits. Profiles mean it doesn't run when the regular `up -d` brings the stack up; it only runs when explicitly invoked with `--profile migrate`. Running it before `up -d` guarantees the schema is current before the app processes touch it.

`docker image prune -f` reclaims layers from the previous deploy. The pinned `:latest` and `:<sha>` tags keep the current and just-prior images.

## Operations

### Manual deploy / re-deploy

Trigger via Actions UI → "Deploy to VM (GHCR)" → Run workflow → pick a branch. Useful for:

- Re-deploying after fixing an infra issue (.env update, certificate renewal, etc.) without a new commit.
- Deploying a non-main branch for emergency testing on prod-like infra.

### Rolling back

There's no one-button rollback. The image for any prior commit is still in GHCR under its 12-char tag, so the recovery is to bump back manually:

```sh
# On the VM:
cd /home/ec2-user/data/mergecrew
git checkout <previous-good-sha>
./scripts/deploy-pull.sh "$(git rev-parse --short=12 HEAD)"
```

This skips Actions entirely — you're pulling an already-built image. Postgres migrations are forward-only, so a rollback only works if the previous version is schema-compatible with the current DB. For breaking migrations, restore the DB from backup first (see [`16-self-host-runbook.md`](16-self-host-runbook.md#backup-postgres)).

### Watching a deploy

The workflow's `Summarize` step writes branch + SHA + tag + result to the run summary, visible in Actions. On the VM, tail the compose logs during/after a deploy:

```sh
docker compose -f docker-compose.prod.yml logs -f --tail=50
```

### Disabling auto-deploy temporarily

Set `VM_DEPLOY_ENABLED=false` (or delete the variable). Merges to main will stop deploying. `workflow_dispatch` still works for manual runs.

## Troubleshooting

### `no matching manifest for linux/<arch>` on pull

The image was built for a platform that doesn't match the VM. Check the VM's arch (`uname -m` — `aarch64` is arm64, `x86_64` is amd64) and update `VM_BUILD_PLATFORM` accordingly. Re-trigger the workflow; the build step will produce the right manifest.

### `no runner matching labels` on the build job

Your GitHub plan doesn't include arm64 runners. Either upgrade, or set `VM_BUILD_RUNNER=ubuntu-latest` and keep `VM_BUILD_PLATFORM=linux/arm64` to emulate arm64 via QEMU on the amd64 runner.

### `denied: permission_denied` from GHCR

The VM can't pull from a private package. Either flip the package to public, or `docker login ghcr.io` on the VM with a PAT carrying `read:packages`.

### Migrations fail mid-deploy

The `migrate` service has its own logs:

```sh
docker compose -f docker-compose.prod.yml --profile migrate logs migrate
```

Most commonly: `DATABASE_URL` doesn't reach Postgres from inside the container. The compose file maps `host.docker.internal` to the host gateway via `extra_hosts`, so a host-installed Postgres at `127.0.0.1:5432` is reachable as `host.docker.internal:5432` from inside containers. Make sure `.env`'s `DATABASE_URL` uses `host.docker.internal`, not `localhost`.

### SSH step hangs or times out

Verify the deploy key works from a fresh shell on your workstation against the same VM/user. If `appleboy/ssh-action` can't authenticate, check:

- Private key in `DEPLOY_SSH_KEY` includes the BEGIN/END lines (a common mistake is pasting just the base64 body).
- Public key is in the right user's `~/.ssh/authorized_keys` on the VM.
- The VM's sshd accepts ed25519 keys (default since OpenSSH 6.5; only a concern on very old hosts).

### The build job re-builds everything every time

Layer cache is stored in GitHub Actions cache, scoped per-service. First run after a Dockerfile change is always a full rebuild. Subsequent runs hit the cache and finish in 1-3 minutes per service. If you see consistent cold builds:

- The Dockerfile structure invalidates the cache too often (e.g. `COPY . .` before `pnpm install`).
- The `cache-to: mode=max` tag isn't being written because the job ran out of disk space — check the build log for `space left` warnings.

## Relationship to other deploy paths

| File | Purpose | Status |
|---|---|---|
| `.github/workflows/deploy-vm.yml` | This automated VM flow | Active when `VM_DEPLOY_ENABLED=true` |
| `scripts/deploy-pull.sh` | What the workflow runs on the VM | Active |
| `scripts/deploy.sh` | Manual deploy (build on the VM) | Legacy. Kept for emergency / offline use; not invoked by the automated path |
| `docker-compose.prod.yml` | Service definitions for both manual and automated flows | Active |
| `.github/workflows/deploy-services.yml` | ECS/ECR path | Dormant; gated by `vars.ECS_DEPLOY_ENABLED`. For operators using AWS ECS instead of a single VM |
| `.github/workflows/deploy-web.yml` | Vercel deploy of `apps/web` | Dormant; gated by `vars.VERCEL_DEPLOY_ENABLED`. Optional split — web on Vercel, backend services on the VM |
| `infra/helm/mergecrew/` | Helm chart for Kubernetes | Independent path; not exercised by these workflows |

`deploy-vm.yml` and `deploy-web.yml` are mutually compatible: if you'd rather host `web` on Vercel and keep the backend services on the VM, enable both gates. The Vercel build builds only `apps/web`; the VM workflow still ships the `web` image but you'd point your domain at Vercel and ignore the VM's `web` container (or remove it from the compose file).

## Related

- [Operator runbook](05-operator-runbook.md) — application failure modes (stuck step, budget exhaustion).
- [Self-host runbook](16-self-host-runbook.md) — infrastructure failure modes (DB unreachable, KMS rotation, OOM).
- [Deploy-target cookbook](06-deploy-targets-cookbook.md) — how Mergecrew deploys *user* applications (different concern).
