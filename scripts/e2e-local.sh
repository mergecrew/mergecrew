#!/usr/bin/env bash
# Full-loop e2e against the local compose stack (#228).
#
# Spins up `docker-compose.full.yml` with the agent stub flipped on, waits
# for the API to report healthy, mints an operator API key via the seed,
# runs apps/e2e-loop against the local stack, then tears the stack down.
#
# Run on a fresh clone: `pnpm e2e:local`. Requires Docker.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="docker-compose.full.yml"
ORG_SLUG="demo"
PROJECT_SLUG="acme"
API_URL="http://localhost:4000"
WAIT_TIMEOUT="${E2E_WAIT_TIMEOUT_SEC:-120}"

if [ -z "${MERGECREW_E2E_LOCAL_API_KEY:-}" ]; then
  # Random per-run token so reruns don't leave a stale shared secret in
  # the host's shell history. The seed inserts a row keyed on sha256.
  rand=$(head -c 32 /dev/urandom | base64 | tr -d '+/=\n' | head -c 32)
  export MERGECREW_E2E_LOCAL_API_KEY="mc_live_${rand}"
fi
export MERGECREW_AGENT_STUB=1

# Pre-flight: docker-compose.full.yml binds host :3000 (web) and :4000 (API).
# A stale `pnpm dev` or a leftover compose run blocking either port leads to
# either an opaque `docker compose up` failure or — worse — the healthz curl
# below hitting the stale process and spinning forever (#247).
check_port_free() {
  local port=$1
  local pids
  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi
  pids=$(lsof -t -i ":$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "[e2e-local] FAIL: port $port is already in use by:"
    for pid in $pids; do
      local cmd
      cmd=$(ps -o command= -p "$pid" 2>/dev/null || echo "<unknown>")
      echo "  pid $pid  $cmd"
    done
    echo "[e2e-local] Free the port and re-run. Common fixes:"
    echo "  - kill the stale process:  kill $pids"
    echo "  - stop a prior compose run: pnpm compose:full:down"
    return 1
  fi
}
check_port_free 3000 || exit 1
check_port_free 4000 || exit 1

teardown_done=0
teardown() {
  if [ "$teardown_done" -eq 1 ]; then
    return
  fi
  teardown_done=1
  echo "[e2e-local] tearing down compose stack…"
  docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
}
trap teardown EXIT INT TERM

echo "[e2e-local] starting compose stack (this builds images on first run)…"
docker compose -f "$COMPOSE_FILE" up -d

echo "[e2e-local] waiting up to ${WAIT_TIMEOUT}s for API /readyz to report ok…"
# /healthz is now liveness-only ({ ok: true }); /readyz is the
# downstream-deps check that actually reflects whether the API can
# serve requests (#317).
deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
while :; do
  if curl -sf "$API_URL/readyz" 2>/dev/null | grep -q '"status":"ok"'; then
    break
  fi
  if [ "$(date +%s)" -gt "$deadline" ]; then
    echo "[e2e-local] FAIL: API never became ready. Recent api logs:"
    docker compose -f "$COMPOSE_FILE" logs --tail=80 api || true
    exit 1
  fi
  sleep 2
done
echo "[e2e-local] API is ready."

echo "[e2e-local] invoking apps/e2e-loop…"
export MERGECREW_API_URL="$API_URL"
export MERGECREW_API_KEY="$MERGECREW_E2E_LOCAL_API_KEY"
export MERGECREW_ORG_SLUG="$ORG_SLUG"
export MERGECREW_PROJECT_SLUG="$PROJECT_SLUG"
# Keep the run-completion timeout tight; the stub agent should finish
# within seconds. A 90s envelope makes "did this hang?" obvious vs the
# default 5 min for a deployed environment.
export MERGECREW_RUN_TIMEOUT_MS="${MERGECREW_RUN_TIMEOUT_MS:-90000}"

if pnpm --silent --filter @mergecrew/e2e-loop e2e; then
  echo "[e2e-local] OK"
  exit 0
else
  rc=$?
  echo "[e2e-local] FAIL (e2e-loop exit code $rc). Recent service logs:"
  for svc in api orchestrator runner; do
    echo "--- $svc ---"
    docker compose -f "$COMPOSE_FILE" logs --tail=40 "$svc" || true
  done
  exit "$rc"
fi
