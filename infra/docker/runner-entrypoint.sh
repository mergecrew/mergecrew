#!/bin/sh
# Runner supervisor entrypoint (EPIC #828).
#
# When RUNNER_SANDBOX=docker the supervisor needs to talk to the host
# Docker daemon via a bind-mounted /var/run/docker.sock. The socket
# is owned root:docker (mode 0660), and the host's docker group GID
# is non-deterministic — Amazon Linux 2023's `dnf install -y docker`
# picks the next available system GID at install time. This script
# stats the mounted socket at boot, ensures a group with that GID
# exists inside the container, adds `node` to it, then drops privs.
#
# Skipped entirely if no socket is mounted (process / k8s / fargate
# driver paths don't need it — the container can just run as `node`).
#
# Override: set RUNNER_DOCKER_GID to use a known GID without stat'ing
# the socket. Useful for podman / rootless setups and for hosts that
# pre-create the docker group with a known GID.
set -e

if [ -S /var/run/docker.sock ]; then
  SOCK_GID="${RUNNER_DOCKER_GID:-$(stat -c '%g' /var/run/docker.sock)}"
  if ! getent group "$SOCK_GID" >/dev/null 2>&1; then
    addgroup --gid "$SOCK_GID" --system docker-host >/dev/null
  fi
  GROUP_NAME=$(getent group "$SOCK_GID" | cut -d: -f1)
  adduser node "$GROUP_NAME" >/dev/null 2>&1 || true
fi

exec gosu node "$@"
