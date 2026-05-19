# Per-run workspace image for Go stacks (#567).
# See docs/03-infrastructure/22-runner-images.md for the contract.

ARG GO_TAG=1.22-bookworm
FROM golang:${GO_TAG}

ARG MISE_VERSION=v2025.5.0
ARG GOLANGCI_LINT_VERSION=v1.61.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        tini \
    && rm -rf /var/lib/apt/lists/*

# golangci-lint — multi-arch via the official installer script.
RUN curl -fsSL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh \
    | sh -s -- -b /usr/local/bin "${GOLANGCI_LINT_VERSION}"

# mise
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

# Pre-create GOPATH so the unprivileged user can write to it on first
# `go mod download` without falling back to a tmpfs $HOME.
RUN mkdir -p /go/{pkg,bin,src} \
    && chown -R 1001:1001 /go

USER mergecrew
WORKDIR /workspace

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash"]
