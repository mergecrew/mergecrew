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
PROJECT_SLUG="${PROJECT_SLUG:-demo-saas}"

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

# Merged OrgSetupCard (#441) replaces the old WelcomeCard +
# OnboardingBanner pair. "Welcome to mergecrew" + the wizard CTA are
# the stable copy — present whenever onboarding has pending steps,
# which is always true for a fresh compose stack.
if ! echo "$home" | grep -q "Welcome to mergecrew"; then
  echo "::error::org setup card not present in /orgs/${ORG_SLUG}"
  echo "--- first 4 KB of body ---"
  echo "$home" | head -c 4096
  exit 1
fi
echo "[quickstart-smoke] ✓ org setup card present"

if ! echo "$home" | grep -q "Continue setup"; then
  echo "::error::org setup card missing the 'Continue setup' CTA"
  echo "--- first 8 KB of body ---"
  echo "$home" | head -c 8192
  exit 1
fi
echo "[quickstart-smoke] ✓ org setup card exposes the wizard CTA"

# End-to-end check (#407, #408, V2.aj): the runNow endpoint pre-creates
# a DailyRun and returns its id; that id must resolve to a real
# run-detail page (where the CTA's redirect lands).
API_URL="${API_URL:-http://localhost:4000}"
if [ -n "${MERGECREW_E2E_LOCAL_API_KEY:-}" ]; then
  echo "[quickstart-smoke] POST ${API_URL}/v1/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/runs"
  run_resp=$(curl -sf -X POST \
    -H "Authorization: Bearer ${MERGECREW_E2E_LOCAL_API_KEY}" \
    -H "Content-Type: application/json" \
    -d '{}' \
    "${API_URL}/v1/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/runs" || true)
  if [ -z "$run_resp" ]; then
    echo "::error::runNow returned no body"
    exit 1
  fi
  run_id=$(echo "$run_resp" | grep -o '"runId":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -z "$run_id" ]; then
    echo "::error::runNow response missing runId — got: $run_resp"
    exit 1
  fi
  echo "[quickstart-smoke] ✓ runNow returned runId ${run_id}"
  echo "[quickstart-smoke] GET ${WEB_URL}/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/runs/${run_id}"
  if ! curl -sf "${WEB_URL}/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/runs/${run_id}" >/dev/null; then
    echo "::error::run-detail page not reachable for the freshly-created run"
    exit 1
  fi
  echo "[quickstart-smoke] ✓ pre-created run is visible on the run-detail page"
else
  echo "[quickstart-smoke] ! MERGECREW_E2E_LOCAL_API_KEY unset; skipping runNow assertion"
fi

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

# Progress chip on the merged OrgSetupCard (#441). Fresh stack has
# every step pending, so "0 of N done" appears verbatim. Grep just on
# the "of … done" tail so the count can grow with new wizard steps
# (#470 added promotion_strategy) without breaking the smoke.
if ! echo "$home" | grep -qE "of [0-9]+ done"; then
  echo "::error::org setup card progress chip not present on /orgs/${ORG_SLUG}"
  echo "--- first 8 KB of body ---"
  echo "$home" | head -c 8192
  exit 1
fi
echo "[quickstart-smoke] ✓ org setup card shows progress"

echo "[quickstart-smoke] GET ${WEB_URL}/orgs/${ORG_SLUG}/onboarding"
wiz=$(curl -sf "${WEB_URL}/orgs/${ORG_SLUG}/onboarding" || true)
if [ -z "$wiz" ]; then
  echo "::error::/orgs/${ORG_SLUG}/onboarding returned no body"
  exit 1
fi
# Page header copy is a stable, page-only marker.
if ! echo "$wiz" | grep -q "Set up your project"; then
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

# Lifecycle template step (#395, V2.ai) — added as Step 5 alongside
# the existing four. Fresh stack has no non-demo project, so the
# action URL falls back to /projects/new, but the row + label must
# render so operators see the eventual lifecycle step from day one.
if ! echo "$wiz" | grep -q "Pick a lifecycle template"; then
  echo "::error::wizard didn't render the lifecycle_template step"
  exit 1
fi
echo "[quickstart-smoke] ✓ onboarding wizard exposes the lifecycle template step"

# Stock lifecycle templates catalog (#393, V2.ai). Public endpoint, no
# auth needed — the picker UI fetches it via SSR and via the wizard.
# Asserts all four expected ids are present so a rename / accidental
# removal trips CI rather than silently shipping a smaller catalog.
echo "[quickstart-smoke] GET ${API_URL:-http://localhost:4000}/v1/lifecycle-templates/stock"
API_URL="${API_URL:-http://localhost:4000}"
stock=$(curl -sf "${API_URL}/v1/lifecycle-templates/stock" || true)
if [ -z "$stock" ]; then
  echo "::error::/v1/lifecycle-templates/stock returned no body"
  exit 1
fi
for tid in generic-careful nextjs-vercel python-render go-fly; do
  if ! echo "$stock" | grep -q "\"id\":\"${tid}\""; then
    echo "::error::stock catalog missing template id: ${tid}"
    echo "--- response ---"
    echo "$stock"
    exit 1
  fi
done
echo "[quickstart-smoke] ✓ stock lifecycle template catalog complete"

# Project Lifecycle page (#394) — the picker section renders for the
# admin/owner session running the smoke. Demo project `acme` exists
# under DEMO_MODE, so the page is reachable.
echo "[quickstart-smoke] GET ${WEB_URL}/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/lifecycle"
lc=$(curl -sf "${WEB_URL}/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}/lifecycle" || true)
if [ -z "$lc" ]; then
  echo "::error::lifecycle page returned no body"
  exit 1
fi
if ! echo "$lc" | grep -q "Pre-built Planner"; then
  echo "::error::lifecycle page didn't render the stock template picker"
  echo "--- first 4 KB of body ---"
  echo "$lc" | head -c 4096
  exit 1
fi
echo "[quickstart-smoke] ✓ project Lifecycle page renders the stock template picker"

# Missing-project handling (#435). Project- and lifecycle-pages historically
# 500'd when the slug didn't resolve because the API's NotFoundError bubbled
# up unhandled. Assert that hitting a non-existent slug now returns 404 from
# Next so a stale link surfaces as a real 404 rather than a server error.
nonexistent="does-not-exist-$(date +%s)"
for path in \
  "/orgs/${ORG_SLUG}/projects/${nonexistent}" \
  "/orgs/${ORG_SLUG}/projects/${nonexistent}/lifecycle"; do
  status=$(curl -s -o /dev/null -w '%{http_code}' "${WEB_URL}${path}")
  if [ "$status" != "404" ]; then
    echo "::error::expected 404 for ${path}, got ${status}"
    exit 1
  fi
done
echo "[quickstart-smoke] ✓ missing-project pages return 404, not 500"

echo "[quickstart-smoke] All checks passed."
