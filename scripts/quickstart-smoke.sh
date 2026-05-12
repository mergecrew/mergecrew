#!/usr/bin/env bash
#
# Quickstart smoke (#365, V2.af). Asserts that a fresh compose stack
# delivers the first-visit experience promised by the quickstart:
#
#   1. The web service responds at /orgs/demo.
#   2. The welcome card markup (#363) is in the SSR'd HTML.
#   3. The seeded sample changeset (#362) is visible in the page —
#      either on the Today feed via its event payload or via the
#      project link.
#
# Runs from the compose-smoke workflow but is also usable locally:
#
#   docker compose -f docker-compose.full.yml up -d
#   bash scripts/quickstart-smoke.sh
#
set -euo pipefail

WEB_URL="${WEB_URL:-http://localhost:3000}"
ORG_SLUG="${ORG_SLUG:-demo}"
PROJECT_SLUG="${PROJECT_SLUG:-acme}"

echo "[quickstart-smoke] Waiting for web on ${WEB_URL}/healthz…"
deadline=$(( $(date +%s) + 120 ))
while :; do
  if curl -sf "${WEB_URL}/healthz" >/dev/null 2>&1; then
    echo "[quickstart-smoke] Web is up."
    break
  fi
  if [ "$(date +%s)" -gt "$deadline" ]; then
    echo "::error::Web never became ready"
    exit 1
  fi
  sleep 2
done

echo "[quickstart-smoke] GET ${WEB_URL}/orgs/${ORG_SLUG}"
home=$(curl -sf "${WEB_URL}/orgs/${ORG_SLUG}" || true)
if [ -z "$home" ]; then
  echo "::error::/orgs/${ORG_SLUG} returned no body"
  exit 1
fi

# Welcome card was wired in #363. The static text "Welcome to
# mergecrew" is the only thing the smoke needs to grep for — if the
# component renders, that string is in the HTML.
if ! echo "$home" | grep -q "Welcome to mergecrew"; then
  echo "::error::welcome card not present in /orgs/${ORG_SLUG}"
  echo "--- first 4 KB of body ---"
  echo "$home" | head -c 4096
  exit 1
fi
echo "[quickstart-smoke] ✓ welcome card present"

# Demo project link should be in the page (Today lists projects).
if ! echo "$home" | grep -q "/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}"; then
  echo "::error::demo project link (/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}) not present in Today page"
  exit 1
fi
echo "[quickstart-smoke] ✓ demo project link present"

# The seeded sample changeset's title is the most stable marker for
# "the sample run made it into the UI". The Changesets list under the
# demo project carries it on the project page.
echo "[quickstart-smoke] GET ${WEB_URL}/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/changesets"
cs=$(curl -sf "${WEB_URL}/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/changesets" || true)
if [ -z "$cs" ]; then
  echo "::error::changesets page returned no body"
  exit 1
fi
if ! echo "$cs" | grep -q "/healthz"; then
  echo "::error::seeded sample changeset (Fix /healthz regression) not present on changesets page"
  echo "--- first 4 KB of body ---"
  echo "$cs" | head -c 4096
  exit 1
fi
echo "[quickstart-smoke] ✓ seeded sample changeset visible"

# Onboarding banner (#384) on Today + wizard page renders (#383, #385).
# Fresh stack has no operator-defined LLM provider, project, repo, or
# deploy target, so at least one onboarding step must be pending and
# the banner copy must be in the SSR'd /orgs/{slug} body.
if ! echo "$home" | grep -q "Finish setting up your org"; then
  echo "::error::onboarding banner not present on /orgs/${ORG_SLUG}"
  echo "--- first 8 KB of body ---"
  echo "$home" | head -c 8192
  exit 1
fi
echo "[quickstart-smoke] ✓ onboarding banner present on Today"

echo "[quickstart-smoke] GET ${WEB_URL}/orgs/${ORG_SLUG}/onboarding"
wiz=$(curl -sf "${WEB_URL}/orgs/${ORG_SLUG}/onboarding" || true)
if [ -z "$wiz" ]; then
  echo "::error::/orgs/${ORG_SLUG}/onboarding returned no body"
  exit 1
fi
# Page header copy is a stable, page-only marker.
if ! echo "$wiz" | grep -q "Set up your org"; then
  echo "::error::wizard page didn't render its header"
  exit 1
fi
# A step row's label is rendered as a contiguous text node, so it's
# safe to grep verbatim from the SSR'd HTML. The "Step N · " prefix
# is split across React text + expression nodes (React inserts HTML
# comments between them for hydration), so grep on the prefix would
# false-negative — match on the label instead.
if ! echo "$wiz" | grep -q "Add an LLM provider"; then
  echo "::error::wizard didn't render the llm_provider step row"
  echo "--- first 4 KB of body ---"
  echo "$wiz" | head -c 4096
  exit 1
fi
echo "[quickstart-smoke] ✓ onboarding wizard renders the stepper"

echo "[quickstart-smoke] All checks passed."
