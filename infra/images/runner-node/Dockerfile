# Per-run workspace image for the docker SandboxDriver (#557).
# Distinct from infra/docker/Dockerfile.runner, which builds the
# supervisor process. This image is what the supervisor LAUNCHES
# per run; agent shell commands execute inside it.
#
# Contract — see docs/03-infrastructure/22-runner-images.md:
#   - non-root user `mergecrew` uid/gid 1001
#   - `/workspace` exists, owned by 1001, mode 0775
#   - bash + git + ca-certificates + tini present
#   - mise installed; honors `.tool-versions` (#568)
#   - no secrets baked in, no SSH keys
#
# Size budget: ≤ 250 MB compressed (#558).

ARG NODE_TAG=20-bookworm-slim
FROM node:${NODE_TAG}

ARG MISE_VERSION=v2025.5.0

# Tooling. `curl` is needed for the mise install and is generally useful
# for build skills; `git` is required by repo.git.* skills; `tini` reaps
# zombies so the sleep-loop entrypoint behaves correctly under
# `docker exec`.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        tini \
    && rm -rf /var/lib/apt/lists/*

# mise (polyglot tool-version manager). Uses the official multi-arch
# installer so amd64 + arm64 image builds both succeed. Phase 2 (#568)
# wires `mise install` into the workspace bootstrap so .tool-versions /
# .mise.toml is honored.
ENV MISE_VERSION=${MISE_VERSION}
RUN curl -fsSL https://mise.run | MISE_VERSION="${MISE_VERSION}" sh \
    && mv /root/.local/bin/mise /usr/local/bin/mise \
    && chmod +x /usr/local/bin/mise \
    && mise --version

# Dedicated unprivileged user. uid 1001 matches DockerDriver's
# `--user 1001:1001` flag. Home is on the writable tmpfs the driver
# mounts at /home/mergecrew, so we don't need to ship a populated home.
RUN groupadd --system --gid 1001 mergecrew \
    && useradd --system --uid 1001 --gid 1001 \
        --no-create-home --home-dir /home/mergecrew \
        --shell /bin/bash mergecrew

# Workspace mount target. The DockerDriver bind-mounts the host workspace
# here. mode 0775 lets the agent's process write while keeping the dir
# group-readable for future debugging hooks.
RUN mkdir -p /workspace \
    && chown 1001:1001 /workspace \
    && chmod 0775 /workspace

USER mergecrew
WORKDIR /workspace

# tini reaps zombies; the actual command is supplied by the
# DockerDriver (it overrides with `sh -c 'while true; do sleep 3600; done'`).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash"]
