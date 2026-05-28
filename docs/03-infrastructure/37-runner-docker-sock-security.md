# Docker socket security for the supervisor

When `RUNNER_SANDBOX=docker`, the supervisor (`apps/runner`) needs to talk to a Docker daemon. The default wiring shipped in [`docker-compose.prod.yml`](../../docker-compose.prod.yml) bind-mounts the host's `/var/run/docker.sock` into the runner container (EPIC [#828](https://github.com/mergecrew/mergecrew/issues/828)). This page is the threat model — and the opt-in mitigations available for operators who need to harden it.

Read this **before** opening up signups on a deployment that holds anything you care about.

## What mounting `/var/run/docker.sock` actually grants

The Docker daemon's HTTP API has **no granular authentication**. Any process that can talk to the socket can:

- Create and run containers with arbitrary flags — including `--privileged`, `--pid=host`, `--ipc=host`, `--cap-add=SYS_ADMIN`.
- Bind-mount any host path into a new container (`-v /:/host`).
- Pull arbitrary images from any registry the daemon can reach.
- `exec` into any running container.

So an attacker with socket access has a one-line escalation to host root:

```sh
docker -H unix:///var/run/docker.sock run -d --rm \
  --privileged --pid=host -v /:/host \
  alpine chroot /host sh -c '… arbitrary host-root commands …'
```

**Mounting `/var/run/docker.sock` into a container is functionally equivalent to giving that container root access on the host.** No CVE required; the daemon works as designed.

## Threat model — why we mount it anyway

The supervisor is **first-party code**. No agent-generated commands, user-supplied workflows, or third-party plugins execute in-process — those all run inside per-step sandbox containers, which themselves drop all capabilities, run read-only, and `--network none` by default (see `packages/sandbox-driver/src/docker-driver.ts` `buildRunArgs`). The supervisor's job is to *spawn* those sandboxes, not to run untrusted code itself.

So the attacker model is: "did we ship a remote-code-execution bug in the supervisor?" That's the same risk surface as any non-trivial backend service. We treat it accordingly — audit changes, keep dependencies up to date, run the supervisor process under the minimum capabilities it needs.

The alternative — **Docker-in-Docker (DinD)**, nested daemon inside the supervisor container — has both worse security properties (requires `--privileged`, kernel-escape paths are easier) and worse performance (one extra layer of storage drivers, no shared image cache). DooD against the host daemon is the well-trodden path.

That said — for multi-operator deployments, regulated environments, or anywhere "first-party code is trusted" doesn't match reality, the mitigations below are real and cheap to layer in.

## Mitigation 1 — docker-socket-proxy (cheap, recommended)

[`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy) is a tiny HAProxy-based front-end that exposes a TCP endpoint and forwards a configurable subset of the Docker API to the underlying socket. Anything not in the allowlist returns 403.

The supervisor only needs a narrow slice: `containers.*`, `images.pull / inspect`, `networks.list`. Everything else (volumes, secrets, swarm, plugins, system.prune) can be denied.

**Compose snippet.** Add a sidecar service and point the runner at it.

```yaml
services:
  docker-proxy:
    image: tecnativa/docker-socket-proxy:latest
    container_name: mergecrew-docker-proxy
    restart: unless-stopped
    environment:
      # Enable only the endpoints the DockerDriver actually calls.
      CONTAINERS: 1          # create / start / kill / rm / exec / wait / inspect
      IMAGES: 1              # pull / inspect
      NETWORKS: 1            # list (for --network resolution)
      # Everything else stays default-deny.
      POST: 1                # allow POST verbs (needed for container create)
      INFO: 1                # `docker info` for startup probe
      PING: 1
      VERSION: 1
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro    # read-only socket
    networks: [internal]
    deploy:
      resources:
        limits:
          cpus: '0.1'
          memory: 64m

  runner:
    # ... existing service block ...
    environment:
      RUNNER_SANDBOX: docker
      RUNNER_WORKSPACE_ROOT: /var/mergecrew/work
      DOCKER_HOST: tcp://docker-proxy:2375    # talk to proxy, not the socket
    volumes:
      # Drop the direct socket mount once you're on the proxy.
      # - /var/run/docker.sock:/var/run/docker.sock
      - /var/mergecrew/work:/var/mergecrew/work
      - ./secrets:/app/secrets:ro
      - transcripts:/var/mergecrew/transcripts
    depends_on:
      docker-proxy: { condition: service_started }
      redis: { condition: service_healthy }
```

The runner image's `docker` CLI honors `DOCKER_HOST`, so no driver changes are needed — `RUNNER_DOCKER_BIN=docker` (the default) Just Works.

> **What this buys you.** A supervisor RCE no longer translates to host root in one line. The attacker can still create containers via the proxied API, so they can `docker run --privileged …` to escape — but only because we let `CONTAINERS=1`. For paranoid environments, replace this with a custom proxy that disallows `--privileged`, `--pid=host`, etc. on the container-create endpoint. The Tecnativa proxy doesn't filter request *bodies*, only request methods + paths.

## Mitigation 2 — rootless docker (strongest)

[Docker rootless mode](https://docs.docker.com/engine/security/rootless/) runs the daemon as the unprivileged user (e.g. `ec2-user`), not root. Socket-RCE then only grants attacker-equivalent privileges to that user — not host root.

```sh
# On AL2023:
sudo dnf install -y docker-rootless-extras
# Drop the system daemon if you want only the rootless path.
sudo systemctl disable --now docker
# Bootstrap rootless under ec2-user.
dockerd-rootless-setuptool.sh install
# The socket now lives at $XDG_RUNTIME_DIR/docker.sock (per-user).
```

**Caveats.**

- Requires **cgroups v2**. AL2023 ships cgroups v2 by default — verify with `stat -fc %T /sys/fs/cgroup` → `cgroup2fs`.
- Networking goes through **slirp4netns**, which has measurable throughput overhead (~10-20% on small packets). Usually irrelevant for build-step traffic; relevant if you're shipping large artifacts through skills.
- Cannot use `--network=host` (no shared host netns); not relevant for mergecrew sandboxes since we use `--network none` by default and a project-specific egress network when allowlisted.
- The runner container's bind mount in `docker-compose.prod.yml` needs to point at the per-user socket path: `${XDG_RUNTIME_DIR}/docker.sock:/var/run/docker.sock`.

## Mitigation 3 — harden the sandbox runtime (layered defense)

Even with the socket exposed, the per-step sandboxes themselves can be double-isolated by switching their OCI runtime from `runc` to a hardened alternative:

```sh
# In .env:
RUNNER_OCI_RUNTIME=runsc        # gVisor — userspace kernel, syscall sandbox
# or
RUNNER_OCI_RUNTIME=sysbox-runc  # nested-container-friendly, stronger uid mapping
```

The driver passes this through unchanged (`packages/sandbox-driver/src/docker-driver.ts` `--runtime`).

- **gVisor** (`runsc`): syscalls inside the sandbox are intercepted by a Go-implemented userspace kernel. A kernel exploit inside the sandbox sees gVisor's surface, not Linux's. Tradeoff: ~5-20% syscall overhead, some syscalls unsupported (rarely matters for build steps). [Install on AL2023](https://gvisor.dev/docs/user_guide/install/).
- **sysbox-runc**: lets the sandbox itself spawn nested containers safely (useful if a build step needs `docker build` inside). Slightly heavier than `runc` but with proper uid namespacing.

This doesn't address the supervisor compromise directly — it makes lateral movement from a *compromised sandbox* into host kernel space much harder. Combine with Mitigation 1 or 2 for defense in depth.

## Recommendations by deployment shape

| Deployment | Recommended hardening |
|---|---|
| Personal / homelab, one operator, trusted code | Bare socket mount. The default shipped in `docker-compose.prod.yml` is fine. |
| Small team, multi-tenant signups, trusted internally | + Mitigation 1 (docker-socket-proxy). Cheap insurance against a supervisor-RCE foot-shot. |
| Multi-operator or external untrusted users beyond the org gate | + Mitigation 1 **and** Mitigation 3 (gVisor on sandboxes). |
| Regulated (PCI / HIPAA / FedRAMP-adjacent) | Mitigation 2 (rootless docker) **as the default**, plus 1 and 3. Document in your compliance posture. |

## Verification

After applying any mitigation:

```sh
# Mitigation 1 — proxy in place
docker exec mergecrew-runner sh -c 'echo $DOCKER_HOST'
# → tcp://docker-proxy:2375
docker exec mergecrew-runner docker ps    # works via proxy
docker exec mergecrew-runner docker volume ls 2>&1
# → "API access denied" if VOLUMES=0 (default) — proves the allowlist is enforced

# Mitigation 2 — rootless
ps -ef | grep dockerd | grep -v root      # daemon runs as ec2-user
docker info | grep -i rootless            # → "rootless: true"

# Mitigation 3 — gVisor on sandboxes
# Trigger a run, then on the host:
docker inspect <mergecrew-runId-*> | jq '.[].HostConfig.Runtime'
# → "runsc"
```

## See also

- EPIC [#828](https://github.com/mergecrew/mergecrew/issues/828) — wiring the supervisor for DooD.
- [`16-self-host-runbook.md` § Deploy to AWS EC2](16-self-host-runbook.md#deploy-ec2) — the green-field recipe that links back here.
- [`13-runner-isolation.md`](../02-architecture/13-runner-isolation.md) — overall isolation analysis.
- [`23-runner-network-policy.md`](23-runner-network-policy.md) — per-project egress allowlist (orthogonal to socket exposure; combines well with the proxy mitigation).
