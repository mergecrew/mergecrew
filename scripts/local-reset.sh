#!/usr/bin/env bash
# Local dev reset: tear down the compose stack, drop all data volumes
# (postgres, redis, localstack), bring it back up, re-apply migrations,
# and re-seed. Use this when you want a guaranteed clean slate.
#
# Usage:
#   pnpm local:reset              # full reset + seed
#   pnpm local:reset --no-seed    # full reset, leave DB empty
#   pnpm local:reset --full       # use docker-compose.full.yml instead

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="docker-compose.yml"
RUN_SEED=1
WAIT_TIMEOUT="${LOCAL_RESET_WAIT_SEC:-60}"

for arg in "$@"; do
  case "$arg" in
    --no-seed) RUN_SEED=0 ;;
    --full)    COMPOSE_FILE="docker-compose.full.yml" ;;
    -h|--help)
      sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

echo "==> Tearing down stack ($COMPOSE_FILE) and dropping volumes"
docker compose -f "$COMPOSE_FILE" down -v --remove-orphans

echo "==> Starting stack"
docker compose -f "$COMPOSE_FILE" up -d

echo "==> Waiting for postgres to be healthy (timeout ${WAIT_TIMEOUT}s)"
deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
until docker exec mergecrew-postgres pg_isready -U mergecrew -d mergecrew >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "postgres did not become healthy within ${WAIT_TIMEOUT}s" >&2
    docker compose -f "$COMPOSE_FILE" logs postgres | tail -50 >&2
    exit 1
  fi
  sleep 1
done

echo "==> Applying migrations"
pnpm db:migrate

if [ "$RUN_SEED" -eq 1 ]; then
  echo "==> Seeding"
  pnpm db:seed
else
  echo "==> Skipping seed (--no-seed)"
fi

echo "==> Done. Stack is fresh."
