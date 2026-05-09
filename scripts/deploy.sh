#!/usr/bin/env bash
# Deploy Mergecrew on a single VM. Idempotent — re-run after every `git pull`.
# Containers bind to 127.0.0.1 only; the host's reverse proxy (Caddy / nginx)
# fronts them. Postgres is on the host, reached via host.docker.internal.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "ERROR: .env not found. Copy .env.example and fill it in." >&2
  exit 1
fi

COMPOSE="docker compose -f docker-compose.prod.yml"

echo "==> Building images"
$COMPOSE build

echo "==> Running prisma migrations"
$COMPOSE --profile migrate run --rm migrate

echo "==> Starting services"
$COMPOSE up -d

sleep 4
$COMPOSE ps
echo
$COMPOSE logs --tail=20 api web orchestrator runner worker-cron

cat <<'EOF'

✓ Up.
  - web → 127.0.0.1:3000
  - api → 127.0.0.1:4000
Configure the host reverse proxy to forward your domain to those ports.

Commands:
  docker compose -f docker-compose.prod.yml logs -f
  docker compose -f docker-compose.prod.yml down
  docker compose -f docker-compose.prod.yml --profile migrate run --rm migrate   # one-off migrations
EOF
