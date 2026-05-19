# Runner network policy

How egress allowlisting works when `RUNNER_SANDBOX=docker` (#573).

## The shape of the control

The DockerDriver picks one of two network modes per run based on whether the project sets an egress allowlist in `mergecrew.yaml`:

| Project config | Driver action |
| --- | --- |
| `runner.egress.allow` is unset or empty | `--network none` — sandbox has no outbound at all (safe baseline) |
| `runner.egress.allow: [...]` AND `RUNNER_EGRESS_NETWORK` is configured | `--network ${RUNNER_EGRESS_NETWORK}` — sandbox joins the operator-provisioned egress network |
| `runner.egress.allow: [...]` but `RUNNER_EGRESS_NETWORK` is empty | `--network none` (no outbound) + a startup-log warning naming the misconfiguration |

The driver does **not** install nftables rules itself. The operator provisions the egress network and the rules that enforce the allowlist; the driver just opts the sandbox into that network when the project asks for outbound. This split keeps the host's network configuration where operators expect it (and where their existing infra tooling can manage it) without the supervisor needing root or CAP_NET_ADMIN.

## Operator setup recipe (Linux + Docker)

The pattern below sets up a Docker network whose nftables ruleset default-drops all outbound traffic, then explicitly accepts traffic to the project's allowlist. Adapt to your distro / firewalld variant.

### 1. Create the docker network

```sh
docker network create \
  --driver bridge \
  --subnet 172.30.0.0/24 \
  --opt com.docker.network.bridge.name=mergecrew-egress \
  mergecrew-egress
```

The named bridge interface (`mergecrew-egress`) is what the nftables rules below hook into.

### 2. Install the nftables ruleset

`/etc/nftables.d/mergecrew-egress.conf`:

```nft
# Mergecrew sandbox egress allowlist (#573).
# Default-drop on the mergecrew-egress bridge; allowlist filled in
# below. Per-host counters give the supervisor data to surface in the
# run digest (#576).
table inet mergecrew {
  set allowlist_v4 {
    type ipv4_addr
    flags interval
    counter
    elements = {
      140.82.112.0/24 ,  # github.com API endpoints
      151.101.0.0/16  ,  # PyPI / npm / Fastly-fronted package mirrors
      # add per-project allowlists here, or generate from
      # `runner.egress.allow` via the operator's config-management
    }
  }

  chain forward {
    type filter hook forward priority 0; policy drop;
    iifname "mergecrew-egress" ip daddr @allowlist_v4 counter accept
    iifname "mergecrew-egress" counter drop comment "blocked-outbound"
    oifname "mergecrew-egress" ct state established,related counter accept
    oifname "mergecrew-egress" counter drop
  }
}
```

Load + persist:

```sh
sudo nft -f /etc/nftables.d/mergecrew-egress.conf
sudo systemctl enable --now nftables
```

### 3. Point the supervisor at the network

```sh
RUNNER_SANDBOX=docker
RUNNER_EGRESS_NETWORK=mergecrew-egress
```

Restart the supervisor. Subsequent runs whose `mergecrew.yaml` lists `runner.egress.allow` will join the egress network; runs without an allowlist stay on `--network none`.

### 4. Verify

```sh
# Inside a running sandbox, confirm allow + deny semantics.
docker exec <container> curl -sS https://api.github.com    # success
docker exec <container> curl -sS https://1.1.1.1           # drops, exits non-zero

# On the host, look at the counters — every blocked attempt bumps a number.
sudo nft -j list counters table inet mergecrew
```

## Threat model deltas

- This network policy turns the egress allowlist from a **soft** Node-level control (HTTP-bound skills check the allowlist before making the request) into a **hard** netns-level control (any traffic from the sandbox is dropped at the kernel). Closes the #188 gap.
- A misbehaving build script that calls `curl evil.com` directly was the original problem. With this in place, `curl` returns "could not resolve host" (Phase 4 DNS resolver, #574) or "connection refused" (this PR's nftables) — both non-zero exits the build skill surfaces.
- The host's nftables ruleset is operator-controlled. The supervisor doesn't have CAP_NET_ADMIN; it can't change the rules. A compromised supervisor cannot lift the allowlist.

## Per-run DNS resolver (#574)

nftables drops by IP. A DNS-level allowlist closes the "build script resolves a non-allowlisted host then connects by the returned IP" path by returning NXDOMAIN at name resolution time.

`apps/runner-dns/` is a small Node service that:

- Listens on UDP `RUNNER_DNS_PORT` (default 53).
- Reads the host-global allowlist from `RUNNER_DNS_ALLOWLIST` (comma-separated, supports `*.suffix.tld` wildcards — same semantics as the Node skill layer).
- Forwards allowed queries to `RUNNER_DNS_UPSTREAM` (default `1.1.1.1:53`).
- Returns NXDOMAIN for everything else.
- JSON-logs every blocked query as `{event: "dns.blocked", host, src}` so operators can correlate with the run.

### Operator setup

Run `runner-dns` as a sidecar in the same network as `mergecrew-egress` — e.g., via docker-compose:

```yaml
services:
  runner-dns:
    image: ghcr.io/mergecrew/runner-dns:latest
    networks: [mergecrew-egress]
    environment:
      RUNNER_DNS_PORT: "53"
      RUNNER_DNS_ALLOWLIST: "api.github.com,*.fastly.net,*.pypi.org,files.pythonhosted.org"
      RUNNER_DNS_UPSTREAM: "1.1.1.1:53"
```

Then point the supervisor at it:

```sh
RUNNER_DNS_RESOLVER=<resolver_container_ip>
```

The DockerDriver adds `--dns <ip>` to every sandbox that joins the egress network, so the container's `/etc/resolv.conf` resolves through `runner-dns` only.

### Verification

```sh
docker exec <sandbox> nslookup api.github.com   # resolves → upstream returns the A record
docker exec <sandbox> nslookup pypi.evil.com    # NXDOMAIN
docker logs <runner-dns> | grep dns.blocked     # blocked attempts surface here
```

### Limitations of V1

- The allowlist is **host-global**, not per-run. Operators with multiple tenants generate the union from project configs via config-management.
- Per-run resolver instances (one process per sandbox with project-scoped allowlist) is a follow-up. The driver's `--dns` flag already supports a per-sandbox IP — what's needed is the lifecycle code to spin a resolver per run and feed the project's allowlist into it.
- IPv6 support: the V1 resolver listens on UDP4 only. AAAA queries from the sandbox hit the empty path and return NXDOMAIN by default. Containers configured for IPv4-only egress don't notice.

## What this PR does (and doesn't) ship

- ✅ Driver-side network mode selection based on the project's egress posture (#573).
- ✅ `runner.egress.allow` schema in `mergecrew.yaml` (#573).
- ✅ Operator recipe for nftables + docker network (#573).
- ✅ Per-run DNS resolver service (`apps/runner-dns/`) — host-global allowlist (#574).
- ✅ DockerDriver `--dns` flag wiring (#574).
- ⏳ Per-run resolver lifecycle (project-scoped allowlist) — follow-up.
- ⏳ Optional egress proxy sidecar (SNI inspection + per-request audit) — #575.
- ⏳ UI surfacing blocked-outbound counts in the run digest — #576.

## Limitations

- The `allowlist_v4` set in the ruleset is **host-global**, not per-run. Operators who need per-project allowlists today script the set updates from the project's `runner.egress.allow` via their config-management. A first-class per-run nftables setup that reads the project's allowlist at sandbox start is tracked under #574.
- IPv6 is not in the recipe above. Mirror the chain with `ip6 daddr @allowlist_v6` if your egress targets have IPv6 endpoints you care about.
- The `counter drop comment "blocked-outbound"` provides aggregate counts but no per-host attribution. The egress-proxy sidecar (#575) adds that.

## Refs

- Parent EPIC: #555
- RFC: `docs/02-architecture/13-runner-isolation.md` § 5.4 (Networking)
- Driver: `packages/sandbox-driver/src/docker-driver.ts`
- Closes the soft-control gap from #188.
