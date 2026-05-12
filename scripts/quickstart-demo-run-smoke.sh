#!/usr/bin/env bash
#
# Demo-run smoke (#375, V2.ag). Runs AFTER the existing e2e-loop step
# in compose-smoke — that step already triggers a run on demo/acme and
# polls it to completion under MERGECREW_AGENT_STUB=1 /
# MERGECREW_DEMO_MODE=1. This script asserts the V2.ag-specific
# artifact: the stub Coder synthesized a new Changeset row (#373), and
# it has the expected stub-prefix title.
#
# Env (same shape as e2e-loop reads):
#   MERGECREW_API_URL        (default http://localhost:4000)
#   MERGECREW_API_KEY        required (operator-role bearer)
#   MERGECREW_ORG_SLUG       (default demo)
#   MERGECREW_PROJECT_SLUG   (default acme)
#
set -euo pipefail

API_URL="${MERGECREW_API_URL:-http://localhost:4000}"
ORG_SLUG="${MERGECREW_ORG_SLUG:-demo}"
PROJECT_SLUG="${MERGECREW_PROJECT_SLUG:-acme}"
API_KEY="${MERGECREW_API_KEY:?MERGECREW_API_KEY required}"

base="${API_URL}/v1/orgs/${ORG_SLUG}/projects/${PROJECT_SLUG}"

echo "[demo-run-smoke] GET ${base}/changesets"
cs_json=$(curl -sf -H "authorization: Bearer ${API_KEY}" "${base}/changesets")
if [ -z "$cs_json" ]; then
  echo "::error::changesets endpoint returned no body"
  exit 1
fi

# We expect at least two:
#  - 1 seeded sample changeset (#362, title "Fix /healthz regression…")
#  - 1+ synthesized by the stub Coder after the e2e-loop run (#373,
#    title "Stub: sample multi-agent change (demo mode)").
count=$(echo "$cs_json" | python3 -c 'import json, sys; print(len(json.load(sys.stdin).get("items", [])))')
echo "[demo-run-smoke] found ${count} changeset(s)"
if [ "$count" -lt 2 ]; then
  echo "::error::expected at least 2 changesets (1 seeded + 1+ live-run), got ${count}"
  echo "--- response body ---"
  echo "$cs_json"
  exit 1
fi

# At least one of them must be the stub-synthesized changeset — the
# explicit marker for #373's behavior firing during the e2e-loop's
# triggered run.
has_stub=$(echo "$cs_json" | python3 -c 'import json, sys; print(any(c.get("title","").startswith("Stub:") for c in json.load(sys.stdin).get("items", [])))')
if [ "$has_stub" != "True" ]; then
  echo "::error::no stub-synthesized changeset visible (expected at least one with title starting \"Stub:\")"
  echo "--- titles ---"
  echo "$cs_json" | python3 -c 'import json, sys; [print(c.get("title")) for c in json.load(sys.stdin).get("items", [])]'
  exit 1
fi
echo "[demo-run-smoke] ✓ stub-synthesized changeset visible"
echo "[demo-run-smoke] All checks passed."
