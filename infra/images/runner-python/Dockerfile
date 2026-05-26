# Per-run workspace image for Python stacks (#567).
# See docs/03-infrastructure/22-runner-images.md for the contract every
# workspace image must meet (non-root mergecrew user uid 1001,
# /workspace writable, required tools).

# Docker Hub's python tag pattern puts `slim` BEFORE the distro
# codename (`python:3.12-slim-bookworm`), unlike Node which uses
# `node:20-bookworm-slim`. Getting these reversed yields a "not
# found" from the registry — caught when the publish-runner-images
# workflow tried to ship the python image on 2026-05-26 (run
# 26431592221).
ARG PYTHON_TAG=3.12-slim-bookworm
FROM python:${PYTHON_TAG}

ARG MISE_VERSION=v2025.5.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        tini \
    && rm -rf /var/lib/apt/lists/*

# Python toolchain: uv (Astral's fast resolver), poetry, plus the
# linters / typecheckers the cookbook references.
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir \
        uv \
        poetry \
        mypy \
        ruff \
        pytest \
        black

# mise (multi-arch). Uses the official installer which auto-detects arch.
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
