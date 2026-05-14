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

echo "==> Pulling tag: $TAG"
$COMPOSE pull api orchestrator runner worker-cron web

echo "==> Running prisma migrations"
$COMPOSE --profile migrate run --rm migrate

echo "==> Starting services"
$COMPOSE up -d

echo "==> Pruning dangling images"
docker image prune -f >/dev/null

$COMPOSE ps
