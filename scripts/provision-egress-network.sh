#!/usr/bin/env bash
# Provision the optional mergecrew-egress docker network + nftables
# ruleset that enforces per-project hostname allowlists at the
# container's network namespace (#834, layered on top of the skill-
# layer allowlist and the per-run DNS resolver in apps/runner-dns/).
#
# Run once on the host before opting into the egress feature. Re-run
# is idempotent. Tested on Amazon Linux 2023; should work on any
# distro with nftables + docker.
#
# After this script + the runner-dns service in docker-compose.prod.yml
# are both up, set in .env:
#
#   RUNNER_EGRESS_NETWORK=mergecrew-egress
#   RUNNER_DNS_RESOLVER=<runner-dns container IP — see ALLOWLIST_NOTE>
#
# … and restart the runner. Subsequent runs whose mergecrew.yaml
# declares `runner.egress.allow` will join the egress network +
# resolve through the per-run resolver. Runs without an allowlist
# stay on --network none.

set -euo pipefail

NETWORK_NAME="${MERGECREW_EGRESS_NETWORK:-mergecrew-egress}"
NETWORK_SUBNET="${MERGECREW_EGRESS_SUBNET:-172.30.0.0/24}"
BRIDGE_IFACE="${MERGECREW_EGRESS_BRIDGE:-mergecrew-egress}"
NFT_CONFIG="${MERGECREW_EGRESS_NFT_PATH:-/etc/nftables.d/mergecrew-egress.conf}"

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "this script needs to install an nftables ruleset; re-run with sudo" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker CLI not found; install it first (AL2023: dnf install -y docker)" >&2
  exit 1
fi

if ! command -v nft >/dev/null 2>&1; then
  echo "nftables not found; install it (AL2023: dnf install -y nftables)" >&2
  exit 1
fi

# 1. Docker network. Idempotent — `docker network create` errors if
#    the name already exists; check first.
if ! docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  echo "creating docker network $NETWORK_NAME ($NETWORK_SUBNET)..."
  docker network create \
    --driver bridge \
    --subnet "$NETWORK_SUBNET" \
    --opt "com.docker.network.bridge.name=$BRIDGE_IFACE" \
    "$NETWORK_NAME" >/dev/null
else
  echo "docker network $NETWORK_NAME already exists; skipping create"
fi

# 2. nftables ruleset. Drops all egress from the bridge interface
#    except connections to the allowlist set. Operators populate the
#    set elements from their projects' runner.egress.allow lists.
mkdir -p "$(dirname "$NFT_CONFIG")"
cat > "$NFT_CONFIG" <<NFT
# Mergecrew sandbox egress allowlist (#573, provisioned by
# scripts/provision-egress-network.sh #834).
#
# Default-drop on the $BRIDGE_IFACE bridge; allowlist elements are
# the union of every project's runner.egress.allow list. Operators
# typically generate these from their project configs via config
# management; for a single-tenant install, just append below.
table inet mergecrew {
  set allowlist_v4 {
    type ipv4_addr
    flags interval
    counter
    elements = {
      140.82.112.0/24 ,  # github.com API endpoints
      151.101.0.0/16  ,  # PyPI / npm / Fastly-fronted package mirrors
      # add per-project allowlists here
    }
  }

  chain forward {
    type filter hook forward priority 0; policy drop;
    iifname "$BRIDGE_IFACE" ip daddr @allowlist_v4 counter accept
    iifname "$BRIDGE_IFACE" counter drop comment "blocked-outbound"
    oifname "$BRIDGE_IFACE" ct state established,related counter accept
    oifname "$BRIDGE_IFACE" counter drop
  }
}
NFT

echo "wrote nftables ruleset to $NFT_CONFIG"

# 3. Load + persist.
nft -f "$NFT_CONFIG"
echo "nftables ruleset loaded"

# Persist across reboot. The exact mechanism varies by distro; on
# AL2023 the simplest pattern is the nftables.service that loads
# /etc/sysconfig/nftables.conf at boot. Include the snippet so we
# survive a host reboot.
if [ -f /etc/sysconfig/nftables.conf ]; then
  if ! grep -q "$NFT_CONFIG" /etc/sysconfig/nftables.conf; then
    echo "include \"$NFT_CONFIG\"" >> /etc/sysconfig/nftables.conf
    echo "added include for $NFT_CONFIG to /etc/sysconfig/nftables.conf"
  fi
elif systemctl list-unit-files nftables.service >/dev/null 2>&1; then
  echo "(warn) /etc/sysconfig/nftables.conf missing; ruleset is loaded for this boot but won't persist. Configure your distro's nftables persistence."
fi

systemctl enable --now nftables 2>/dev/null || true

echo
echo "egress network ready. Next steps:"
echo "  1. Uncomment the runner-dns service block in docker-compose.prod.yml"
echo "     (or wherever you maintain compose) and \`docker compose up -d runner-dns\`."
echo "  2. Find the runner-dns container's IP on $NETWORK_NAME:"
echo "       docker inspect mergecrew-runner-dns | jq -r '.[].NetworkSettings.Networks[\"$NETWORK_NAME\"].IPAddress'"
echo "  3. Set in .env:"
echo "       RUNNER_EGRESS_NETWORK=$NETWORK_NAME"
echo "       RUNNER_DNS_RESOLVER=<resolver IP from step 2>"
echo "  4. Restart the runner: docker compose -f docker-compose.prod.yml up -d runner"
echo
echo "Verify:"
echo "  docker exec <sandbox> nslookup api.github.com  # resolves"
echo "  docker exec <sandbox> nslookup evil.com         # NXDOMAIN"
echo "  sudo nft -j list counters table inet mergecrew  # blocked-outbound counter"
