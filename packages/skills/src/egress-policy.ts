/**
 * Egress allowlist (#10). Per-project list of host patterns that agent
 * skills are allowed to reach over the network.
 *
 * Semantics:
 *  - `undefined` / `null` allowlist = no restriction (back-compat default
 *    for projects that haven't opted in).
 *  - `[]` empty list = block all outbound HTTP.
 *  - `['*']` = explicit allow-all.
 *  - Otherwise: `host` matches if it equals a pattern, OR the pattern
 *    starts with `*.` and `host` is a strict subdomain of the suffix
 *    (e.g. `*.example.com` matches `api.example.com` but NOT `example.com`).
 *  - Special-case loopback: `localhost`, `127.0.0.1`, `::1`, and the
 *    private RFC1918 ranges are NEVER reachable when an allowlist is
 *    set, even if a pattern would technically match them. This mitigates
 *    SSRF against the runner's own host (the orchestrator/api/postgres/
 *    redis sidecars run on the same network in dev, where loopback
 *    might otherwise resolve to in-cluster services).
 */

const PRIVATE_HOSTS = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|::1|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe80:)/i;

export class EgressBlocked extends Error {
  readonly code = 'EGRESS_BLOCKED';
  constructor(host: string, message?: string) {
    super(message ?? `egress to ${host} is not in the project allowlist`);
    this.name = 'EgressBlocked';
  }
}

export function isHostAllowed(host: string, allowlist: string[] | null | undefined): boolean {
  if (allowlist === undefined || allowlist === null) return true;
  if (PRIVATE_HOSTS.test(host)) return false;
  if (allowlist.length === 0) return false;
  for (const pattern of allowlist) {
    if (pattern === '*') return true;
    if (pattern === host) return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      // Match strict subdomains only — `*.example.com` does NOT match
      // `example.com`. Operators add the bare host as a separate entry
      // when they want both.
      if (host.endsWith('.' + suffix)) return true;
    }
  }
  return false;
}

/** Convenience wrapper that throws `EgressBlocked` on disallowed URLs. */
export function assertEgressAllowed(url: string, allowlist: string[] | null | undefined): void {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new EgressBlocked(url, `cannot parse URL: ${url}`);
  }
  if (!isHostAllowed(host, allowlist)) {
    throw new EgressBlocked(host);
  }
}
