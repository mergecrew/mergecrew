#!/usr/bin/env bash
# Preflight for docker-compose.prod.yml: checks the database role
# split before a deploy touches anything. Called by deploy.sh and
# deploy-pull.sh; safe to run by hand.
#
#   DATABASE_URL          mergecrew_app       (runtime, RLS enforced)
#   DATABASE_SYSTEM_URL   mergecrew_system    (runtime, cross-tenant, DML only)
#   DATABASE_MIGRATE_URL  mergecrew_migrator  (migrate service only)
#
# Also requires SKILL_SIGNING_KEY (runner skill policy HMAC key).
#
# See infra/sql/README.md and docs/03-infrastructure/19-vm-deploy.md.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "ERROR: .env not found." >&2
  exit 1
fi

# Read KEY from the shell (compose gives it precedence) or else .env,
# without sourcing .env (values may hold `$`, spaces, multi-line PEMs).
env_value() {
  local key="$1"
  if [ -n "${!key:-}" ]; then
    printf '%s' "${!key}"
    return
  fi
  sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" .env | tail -n 1 |
    sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# postgresql://user:pass@host/db -> user
url_user() {
  printf '%s' "$1" | sed -n 's#^[a-z]*://\([^:@/]*\).*#\1#p'
}

fail=0
err() {
  echo "ERROR: $*" >&2
  fail=1
}

app_url="$(env_value DATABASE_URL)"
system_url="$(env_value DATABASE_SYSTEM_URL)"
migrate_url="$(env_value DATABASE_MIGRATE_URL)"

[ -n "$app_url" ] || err "DATABASE_URL is not set (mergecrew_app role)."
[ -n "$system_url" ] || err "DATABASE_SYSTEM_URL is not set (mergecrew_system role). Services fail closed without it in production; create the role with infra/sql/native-bootstrap.sql."
[ -n "$migrate_url" ] || err "DATABASE_MIGRATE_URL is not set (mergecrew_migrator role); the migrate service needs it."

# The runner's skill policy engine refuses high-impact skills (commit,
# PR, deploy) in production without its HMAC key.
skill_key="$(env_value SKILL_SIGNING_KEY)"
if [ -z "$skill_key" ]; then
  err "SKILL_SIGNING_KEY is not set (runner skill policy HMAC key, 32+ bytes). Generate one with: openssl rand -hex 32"
elif [ "${#skill_key}" -lt 32 ]; then
  err "SKILL_SIGNING_KEY is shorter than 32 characters. Generate one with: openssl rand -hex 32"
fi

if [ -n "$system_url" ] && [ -n "$migrate_url" ]; then
  if [ "$system_url" = "$migrate_url" ] || [ "$(url_user "$system_url")" = "$(url_user "$migrate_url")" ]; then
    err "DATABASE_SYSTEM_URL uses the migrator role. Point it at mergecrew_system."
  fi
fi
if [ -n "$app_url" ] && [ -n "$migrate_url" ] && [ "$(url_user "$app_url")" = "$(url_user "$migrate_url")" ]; then
  err "DATABASE_URL uses the migrator role. Point it at mergecrew_app."
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

docker compose -f docker-compose.prod.yml config --quiet
echo "==> Preflight OK (app=$(url_user "$app_url"), system=$(url_user "$system_url"), migrate=$(url_user "$migrate_url"))"
