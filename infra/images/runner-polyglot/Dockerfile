# Catch-all polyglot image (#567). The fallback when a project doesn't
# fit a single-stack image cleanly. Carries Node + Python preinstalled;
# Go and Java are available on-demand via mise + `.tool-versions`.
# Size budget is intentionally generous (≤ 1.5 GB compressed) — single-
# stack images are the right choice when cold-start matters.

ARG DEBIAN_TAG=bookworm-slim
FROM debian:${DEBIAN_TAG}

ARG MISE_VERSION=v2025.5.0
ARG NODE_MAJOR=20

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        gnupg \
        tini \
        unzip \
        build-essential \
        python3.11 \
        python3.11-venv \
        python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Node via NodeSource.
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm yarn \
    && node --version && pnpm --version

# Python tooling (uv + poetry + linters) for the same out-of-the-box
# experience as runner-python.
RUN pip install --no-cache-dir --break-system-packages \
        uv \
        poetry \
        mypy \
        ruff \
        pytest

# mise (multi-arch); Go / Java are installed by the workspace bootstrap
# when `.tool-versions` calls for them (#568).
ENV MISE_VERSION=${MISE_VERSION}
RUN curl -fsSL https://mise.run | MISE_VERSION="${MISE_VERSION}" sh \
    && mv /root/.local/bin/mise /usr/local/bin/mise \
    && chmod +x /usr/local/bin/mise \
    && mise --version

RUN groupadd --system --gid 1001 mergecrew \
    && useradd --system --uid 1001 --gid 1001 \
        --no-create-home --home-dir /home/mergecrew \
        --shell /bin/bash mergecrew

RUN mkdir -p /workspace \
    && chown 1001:1001 /workspace \
    && chmod 0775 /workspace

USER mergecrew
WORKDIR /workspace

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash"]
