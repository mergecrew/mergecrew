# Runner workspace images

The runner has two distinct sets of Docker images:

1. **Supervisor images** (`infra/docker/Dockerfile.*`) — the long-running services (api / orchestrator / runner / worker-cron / web). Built and pushed by `.github/workflows/deploy-services.yml`. Not relevant to this doc.
2. **Workspace images** (`infra/images/runner-*/`) — the *per-run* containers the docker `SandboxDriver` (#557) launches for each agent step. This doc is about those.

When `RUNNER_SANDBOX=docker`, every `runner.step` BullMQ job ends up running its agent's shell commands (`build.*`, `repo.git.*`) inside one of these images. The supervisor process never executes user-derived shell.

## Available images

| Image | Status | Source |
| --- | --- | --- |
| `ghcr.io/mergecrew/runner-node:20` | ✅ shipped (#558) | `infra/images/runner-node/Dockerfile` |
| `ghcr.io/mergecrew/runner-python:3.12` | ⏳ planned (#567 / Phase 2) | — |
| `ghcr.io/mergecrew/runner-java:21` | ⏳ planned (#567 / Phase 2) | — |
| `ghcr.io/mergecrew/runner-go:1.22` | ⏳ planned (#567 / Phase 2) | — |
| `ghcr.io/mergecrew/runner-polyglot:lts` | ⏳ planned (#567 / Phase 2) | — |

## The contract every workspace image must meet

These are checked in CI; an image build that violates any of them fails to publish.

- **Non-root user.** A user `mergecrew` with uid/gid `1001`. The driver launches the container with `--user 1001:1001`, so root inside the image is irrelevant — but uid 1001 must own its writable mount points.
- **`/workspace` exists.** Owned by `1001:1001`, mode `0775`. The driver bind-mounts the host workspace here.
- **Required tools.** `bash`, `git`, `curl`, `ca-certificates`, `tini`, and `mise` are present on `$PATH`. Build skills assume `git`; `tini` reaps zombies under the driver's sleep-loop entrypoint; `mise` (#568) honors `.tool-versions`.
- **No secrets.** The image cannot ship a `.npmrc` with a token, an SSH key, a service-account JSON, etc. The CI build runs in a clean env; runtime secrets come from the per-project `ProjectSecret` rows the supervisor injects via `--env` at exec time.
- **Read-only-root tolerant.** The driver mounts `/` read-only and provides tmpfs at `/tmp` and `/home/mergecrew`. The image must run without writing outside those mounts and `/workspace`.
- **Size.** ≤ 250 MB compressed for stack-specific images, ≤ 1.5 GB for `runner-polyglot`.
- **Entrypoint is `tini --`.** The driver overrides `CMD` with `sh -c 'while true; do sleep 3600; done'` so multiple `docker exec`s share one container.

## Publishing

`.github/workflows/publish-runner-images.yml` publishes images to `ghcr.io/mergecrew/runner-*`. Triggers:

- **Push to `main`** that touches `infra/images/runner-node/**` → publishes the rolling major-version tag (`:20`) and an immutable sha-pinned tag (`:20-<short-sha>`).
- **Tag `runner-node-v*`** → publishes the specific version (`runner-node-v20.1.0` → `:20.1.0`) plus the rolling major (`:20`). Use this for intentional releases.
- **Manual `workflow_dispatch`** → republish with a chosen tag (e.g. `edge`, `next`).

The job runs five contract checks before declaring success:

1. Required tools are present.
2. The default user is uid 1001.
3. `/workspace` is writable as uid 1001.
4. Compressed size is within budget.
5. The build succeeded on both `linux/amd64` and `linux/arm64` (the driver runs on whatever the host architecture is; Apple Silicon dev machines and most AWS Graviton hosts need arm64).

## Default image used by the driver

`DockerDriver` resolves the image to use in this order:

1. `SandboxStartOpts.image` from `mergecrew.yaml` `runner.image` (#559).
2. `RUNNER_DEFAULT_IMAGE` env on the supervisor.
3. The hard-coded fallback `node:20-bookworm-slim` (kept narrow because Phase 2 stack detection (#566) will eventually pick the right image automatically — until then, operators should set `RUNNER_DEFAULT_IMAGE=ghcr.io/mergecrew/runner-node:20` to use the published workspace image).

Once #566 lands (lockfile-based stack detection), the supervisor picks the right `runner-<stack>` image without operator input.

## Building locally

```sh
docker build -t mergecrew/runner-node:dev infra/images/runner-node
docker run --rm -it --user 1001:1001 mergecrew/runner-node:dev sh -c 'id && command -v git mise'
```

The CI contract checks above are reasonable smoke tests to run locally.

## BYO images (Phase 3)

A project can replace the stock image entirely with `mergecrew.yaml`:

```yaml
runner:
  image: ghcr.io/acme/internal-ci:v3
```

Custom images must meet the same contract (uid 1001 user, `/workspace` writable, required tools present). The supervisor validates them lazily on the first run; failures surface as `config_invalid` before any LLM tokens are spent. See #571.

## Extending an image (Phase 2 follow-up)

When `.tool-versions` lives in the repo, `mise install` runs once per workspace bootstrap (#568) — that's the right way to pin a *specific* Node / Python / Go version without rebuilding the base image. Use a custom image only when you need a tool `mise` doesn't manage, or a binary preinstalled for cold-start reasons.

## Refs

- Parent EPIC: #555
- RFC: `docs/02-architecture/13-runner-isolation.md` § 5.2 (Image strategy), § 5.3 (Tooling install)
- Driver: `packages/sandbox-driver/src/docker-driver.ts` (#557)
- Tracking: #558 (this image), #567 (other stacks), #568 (mise + .tool-versions), #571 (BYO)
