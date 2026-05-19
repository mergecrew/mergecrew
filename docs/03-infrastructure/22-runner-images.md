# Runner workspace images

The runner has two distinct sets of Docker images:

1. **Supervisor images** (`infra/docker/Dockerfile.*`) — the long-running services (api / orchestrator / runner / worker-cron / web). Built and pushed by `.github/workflows/deploy-services.yml`. Not relevant to this doc.
2. **Workspace images** (`infra/images/runner-*/`) — the *per-run* containers the docker `SandboxDriver` (#557) launches for each agent step. This doc is about those.

When `RUNNER_SANDBOX=docker`, every `runner.step` BullMQ job ends up running its agent's shell commands (`build.*`, `repo.git.*`) inside one of these images. The supervisor process never executes user-derived shell.

## Available images

| Image | Stack | Source |
| --- | --- | --- |
| `ghcr.io/mergecrew/runner-node:20` | Node 20 | `infra/images/runner-node/Dockerfile` |
| `ghcr.io/mergecrew/runner-python:3.12` | Python 3.12 + uv + poetry + ruff + mypy + pytest + black | `infra/images/runner-python/Dockerfile` |
| `ghcr.io/mergecrew/runner-go:1.22` | Go 1.22 + golangci-lint | `infra/images/runner-go/Dockerfile` |
| `ghcr.io/mergecrew/runner-java:21` | Temurin 21 + Maven 3.9 + Gradle 8 | `infra/images/runner-java/Dockerfile` |
| `ghcr.io/mergecrew/runner-polyglot:lts` | Node 20 + Python (uv / poetry / ruff / mypy / pytest) preinstalled; Go / Java available via mise + `.tool-versions` | `infra/images/runner-polyglot/Dockerfile` |

## The contract every workspace image must meet

These are checked in CI; an image build that violates any of them fails to publish.

- **Non-root user.** A user `mergecrew` with uid/gid `1001`. The driver launches the container with `--user 1001:1001`, so root inside the image is irrelevant — but uid 1001 must own its writable mount points.
- **`/workspace` exists.** Owned by `1001:1001`, mode `0775`. The driver bind-mounts the host workspace here.
- **Required tools.** `bash`, `git`, `curl`, `ca-certificates`, `tini`, and `mise` are present on `$PATH`. Build skills assume `git`; `tini` reaps zombies under the driver's sleep-loop entrypoint; `mise` (#568) honors `.tool-versions`.
- **No secrets.** The image cannot ship a `.npmrc` with a token, an SSH key, a service-account JSON, etc. The CI build runs in a clean env; runtime secrets come from the per-project `ProjectSecret` rows the supervisor injects via `--env` at exec time.
- **Read-only-root tolerant.** The driver mounts `/` read-only and provides tmpfs at `/tmp` and `/home/mergecrew`. The image must run without writing outside those mounts and `/workspace`.
- **Size.** Per-image budgets are enforced in CI:
  - `runner-node` ≤ 250 MB compressed
  - `runner-python` / `runner-go` / `runner-java` ≤ 800 MB compressed
  - `runner-polyglot` ≤ 1.5 GB compressed
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

1. **`.devcontainer/devcontainer.json` in the project repo (#570).** When the cloned workspace ships a devcontainer config, the supervisor builds it into an OCI image via `@devcontainers/cli` and uses that. Cached on the host keyed by the SHA-256 of the config file. Requires the supervisor host to have a docker socket and `npx`/`node` on PATH. Failures fall back transparently to the next step.
2. `SandboxStartOpts.image` from `mergecrew.yaml` `runner.image` (#559).
3. `RUNNER_DEFAULT_IMAGE` env on the supervisor.
4. The hard-coded fallback `node:20-bookworm-slim` (kept narrow because Phase 2 stack detection (#566) picks the right image automatically — operators should set `RUNNER_DEFAULT_IMAGE=ghcr.io/mergecrew/runner-node:20` until stack-based image resolution lands).

Once #566 lands (lockfile-based stack detection), the supervisor picks the right `runner-<stack>` image without operator input.

## Workspace ownership (host side)

The DockerDriver bind-mounts the supervisor's host workspace at `/workspace` inside the container, and the container runs as uid 1001 — so the host workspace **must be owned by uid 1001** for the build to read/write it. The driver attempts a best-effort recursive `chown 1001:1001` before `docker run` (`packages/sandbox-driver/src/workspace-prep.ts`). For that chown to succeed, the supervisor needs **CAP_CHOWN** (or equivalent).

Three setups satisfy this:

1. **Supervisor runs as root inside its own container.** Standard pattern for self-hosters using the default `docker-compose.full.yml`. CAP_CHOWN is present.
2. **Rootless Docker with user-namespace remapping.** uid 1001 inside the container maps to a non-1001 uid on the host that the supervisor already owns. The chown is then a no-op.
3. **External workspace preparation.** Operator owns the workspace dir at uid 1001 from the start (e.g., systemd `User=mergecrew-runner`) and the supervisor never needs to chown.

If the chown fails (EPERM/EACCES), the driver logs a warning and the build inside the sandbox may surface EACCES on writes. The fix is one of the three setups above, not a code change.

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

## Honoring `.tool-versions` / `.mise.toml`

Every stock image ships `mise` (the [polyglot tool-version manager](https://mise.jdx.dev)). When the cloned repo contains `.tool-versions` (asdf/mise format) or `.mise.toml` in the workspace root, the supervisor runs `mise install` once per workspace before the first agent step. Pin a specific Node / Python / Go / Java / Ruby / Rust version without rebuilding the image:

```
# .tool-versions
nodejs 20.10.0
python 3.11.7
go 1.22.1
```

The supervisor writes a sentinel file `.mergecrew-mise-installed` keyed by the SHA-256 of whichever version-file drove the install. Subsequent steps in the same run skip the re-install; editing `.tool-versions` mid-run invalidates the sentinel and forces a re-install on the next step.

Use a custom `runner.image` only when you need a tool `mise` doesn't manage, or a binary preinstalled for cold-start reasons.

## Extending an image (Phase 2 follow-up)

Custom images that don't ship `mise` are tolerated — the supervisor logs `mise not available in sandbox image; skipping .tool-versions install` and continues. Operators using `runner.image` to a non-mergecrew base must install their own toolchain.

## Refs

- Parent EPIC: #555
- RFC: `docs/02-architecture/13-runner-isolation.md` § 5.2 (Image strategy), § 5.3 (Tooling install)
- Driver: `packages/sandbox-driver/src/docker-driver.ts` (#557)
- Tracking: #558 (this image), #567 (other stacks), #568 (mise + .tool-versions), #571 (BYO)
