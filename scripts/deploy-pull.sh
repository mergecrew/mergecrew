#!/usr/bin/env bash
# Pull pre-built images from GHCR and bring the stack up.
# Invoked by .github/workflows/deploy-vm.yml after a successful build/push.
# Replaces the build-on-VM flow in scripts/deploy.sh for production.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "ERROR: .env not found." >&2
  exit 1
fi

TAG="${1:-latest}"
export MERGECREW_TAG="$TAG"

COMPOSE="docker compose -f docker-compose.prod.yml"

# Prune BEFORE pulling. Each deploy lands 5 images of ~500MB-1GB
# each (api/orchestrator/runner/worker-cron/web). Without pruning
# first, accumulated dangling images + BuildKit cache from prior
# deploys can fill the VM's disk and the pull step explodes with
# "no space left on device" mid-extract — exactly what happened on
# 2026-05-26 (run 26433898037). Pruning at the END only helps the
# NEXT deploy, which is too late.
echo "==> Pruning dangling images + BuildKit cache (pre-pull)"
docker image prune -af >/dev/null || true
# BuildKit's local cache holds layer copies from past builds; on a
# pull-only deploy host it serves no purpose. Without this it can
# silently grow to multiple GB.
docker builder prune -af >/dev/null || true

echo "==> Pulling tag: $TAG"
$COMPOSE pull api orchestrator runner worker-cron web

echo "==> Running prisma migrations"
$COMPOSE --profile migrate run --rm migrate

echo "==> Starting services"
$COMPOSE up -d

# Second prune sweep AFTER the up — the pull leaves the old tagged
# images dangling once compose retags `latest`. Cleaning here keeps
# the disk floor low for the next deploy's pre-prune.
echo "==> Pruning unused images (post-up)"
docker image prune -af >/dev/null || true

$COMPOSE ps
